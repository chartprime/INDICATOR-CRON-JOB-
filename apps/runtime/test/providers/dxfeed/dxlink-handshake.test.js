const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const {
  waitForAuthorized,
  waitForChannelOpened,
  AUTH_TIMEOUT_MS,
  CHANNEL_OPEN_TIMEOUT_MS,
} = require("../../../src/providers/dxfeed/dxlink-handshake");

describe("shared handshake timeout constants", () => {
  test("exports the single approved AUTH/CHANNEL_OPEN timeouts every dxFeed entrypoint imports", () => {
    expect(AUTH_TIMEOUT_MS).toBe(30_000);
    expect(CHANNEL_OPEN_TIMEOUT_MS).toBe(15_000);
  });
});

function fakeConnection({ connectionState = DXLinkConnectionState.CONNECTING, authState = DXLinkAuthState.UNAUTHORIZED } = {}) {
  const connectionListeners = new Set();
  const authListeners = new Set();
  return {
    getStatus: () => ({ connectionState, authState }),
    onConnectionStateChange: (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    onAuthStateChange: (listener) => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
    emitConnectionState: (state, prev) => {
      connectionState = state;
      for (const listener of connectionListeners) listener({ state, prev });
    },
    emitAuthState: (state) => {
      authState = state;
      for (const listener of authListeners) listener({ state });
    },
    listenerCounts: () => ({ connection: connectionListeners.size, auth: authListeners.size }),
  };
}

function fakeChannel(initialState = DXLinkChannelState.REQUESTED) {
  const listeners = new Set();
  let currentState = initialState;
  return {
    getState: () => currentState,
    addStateChangeListener: (listener) => listeners.add(listener),
    removeStateChangeListener: (listener) => listeners.delete(listener),
    emitState: (state) => {
      currentState = state;
      for (const listener of listeners) listener(state);
    },
    listenerCount: () => listeners.size,
  };
}

describe("waitForAuthorized", () => {
  test("resolves true once AUTHORIZED fires, and unsubscribes both listeners", async () => {
    const connection = fakeConnection();
    const promise = waitForAuthorized({ connection, timeoutMs: 1_000 });
    connection.emitAuthState(DXLinkAuthState.AUTHORIZED);
    await expect(promise).resolves.toBe(true);
    expect(connection.listenerCounts()).toEqual({ connection: 0, auth: 0 });
  });

  test("ignores a non-AUTHORIZED auth state, only resolves on the real one", async () => {
    const connection = fakeConnection();
    const promise = waitForAuthorized({ connection, timeoutMs: 1_000 });
    connection.emitAuthState(DXLinkAuthState.AUTHORIZING);
    connection.emitAuthState(DXLinkAuthState.AUTHORIZED);
    await expect(promise).resolves.toBe(true);
  });

  test("resolves when authorization completed before listener registration", async () => {
    const connection = fakeConnection({
      connectionState: DXLinkConnectionState.CONNECTED,
      authState: DXLinkAuthState.AUTHORIZED,
    });
    await expect(waitForAuthorized({ connection, timeoutMs: 1_000 })).resolves.toBe(true);
    expect(connection.listenerCounts()).toEqual({ connection: 0, auth: 0 });
  });

  test("cleans up listeners when authorization fires synchronously during registration", async () => {
    let connectionListener = null;
    let authListener = null;
    const connection = {
      getStatus: () => ({ connectionState: DXLinkConnectionState.CONNECTED, authState: DXLinkAuthState.UNAUTHORIZED }),
      onConnectionStateChange: (listener) => {
        connectionListener = listener;
        return () => { connectionListener = null; };
      },
      onAuthStateChange: (listener) => {
        authListener = listener;
        listener({ state: DXLinkAuthState.AUTHORIZED });
        return () => { authListener = null; };
      },
    };

    await expect(waitForAuthorized({ connection, timeoutMs: 1_000 })).resolves.toBe(true);
    expect(connectionListener).toBeNull();
    expect(authListener).toBeNull();
  });

  test("rejects if the connection drops to NOT_CONNECTED before AUTHORIZED", async () => {
    const connection = fakeConnection();
    const promise = waitForAuthorized({ connection, timeoutMs: 1_000 });
    connection.emitConnectionState(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTING);
    await expect(promise).rejects.toThrow(/dropped before reaching AUTHORIZED/);
  });

  test("does not reject on a NOT_CONNECTED->NOT_CONNECTED no-op transition", async () => {
    const connection = fakeConnection();
    const promise = waitForAuthorized({ connection, timeoutMs: 50 });
    connection.emitConnectionState(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.NOT_CONNECTED);
    await expect(promise).rejects.toThrow(/did not reach AUTHORIZED within/);
  });

  test("rejects on timeout when AUTHORIZED never arrives", async () => {
    const connection = fakeConnection();
    await expect(waitForAuthorized({ connection, timeoutMs: 30 })).rejects.toThrow(/did not reach AUTHORIZED within 30ms/);
  });

  test("resolves false (not an error) when the abort signal fires first", async () => {
    const connection = fakeConnection();
    let resolveAbort;
    const abortPromise = new Promise((resolve) => {
      resolveAbort = resolve;
    });
    const promise = waitForAuthorized({ connection, timeoutMs: 1_000, abortPromise });
    resolveAbort();
    await expect(promise).resolves.toBe(false);
  });

  test("a late AUTHORIZED after timeout does not double-settle or throw", async () => {
    const connection = fakeConnection();
    await expect(waitForAuthorized({ connection, timeoutMs: 20 })).rejects.toThrow();
    expect(() => connection.emitAuthState(DXLinkAuthState.AUTHORIZED)).not.toThrow();
  });

  test("rejects invalid timeout and lifecycle interfaces before installing resources", () => {
    expect(() => waitForAuthorized({ connection: fakeConnection(), timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => waitForAuthorized({ connection: {}, timeoutMs: 1_000 })).toThrow(/lifecycle interface/);
  });

  // L1L2-V2-011. This parameter was called `abortSignal` while being consumed as
  // a PROMISE (`Promise.resolve(x).then(...)`). An AbortSignal is not a thenable,
  // so Promise.resolve() adopted it as a plain value and the .then fired on the
  // next microtask -- silently resolving false ("aborted") about 1ms in, while
  // the connection was still UNAUTHORIZED and nothing had been aborted. Callers
  // read false as "abort cleanly", so the misuse the old name invited failed
  // silently. It is now named `abortPromise`, and a non-thenable is rejected
  // outright so the mistake is loud rather than silent.
  test("rejects a real AbortSignal, which the promise-based implementation cannot use", () => {
    const abortPromise = new AbortController().signal;
    expect(() => waitForAuthorized({ connection: fakeConnection(), timeoutMs: 1_000, abortPromise }))
      .toThrow(/must be a promise/);
    expect(() => waitForChannelOpened({ channel: fakeChannel(), timeoutMs: 1_000, abortPromise }))
      .toThrow(/must be a promise/);
  });

  test("still accepts an omitted abortPromise and a real promise", async () => {
    const connection = fakeConnection();
    const never = waitForAuthorized({ connection, timeoutMs: 1_000, abortPromise: new Promise(() => {}) });
    const plain = waitForAuthorized({ connection, timeoutMs: 1_000 });
    connection.emitAuthState(DXLinkAuthState.AUTHORIZED);
    await expect(never).resolves.toBe(true);
    await expect(plain).resolves.toBe(true);
  });
});

describe("waitForChannelOpened", () => {
  test("resolves true once OPENED fires, and removes its own listener", async () => {
    const channel = fakeChannel();
    const promise = waitForChannelOpened({ channel, timeoutMs: 1_000 });
    channel.emitState(DXLinkChannelState.OPENED);
    await expect(promise).resolves.toBe(true);
    expect(channel.listenerCount()).toBe(0);
  });

  test("ignores REQUESTED and resolves on OPENED", async () => {
    const channel = fakeChannel();
    const promise = waitForChannelOpened({ channel, timeoutMs: 1_000 });
    channel.emitState(DXLinkChannelState.REQUESTED);
    channel.emitState(DXLinkChannelState.OPENED);
    await expect(promise).resolves.toBe(true);
  });

  test("resolves when the channel opened before listener registration", async () => {
    const channel = fakeChannel(DXLinkChannelState.OPENED);
    await expect(waitForChannelOpened({ channel, timeoutMs: 1_000 })).resolves.toBe(true);
    expect(channel.listenerCount()).toBe(0);
  });

  test("does not leave a timeout behind when OPENED fires synchronously during registration", async () => {
    let listener = null;
    const channel = {
      getState: () => DXLinkChannelState.REQUESTED,
      addStateChangeListener: (next) => {
        listener = next;
        next(DXLinkChannelState.OPENED);
      },
      removeStateChangeListener: (next) => {
        if (listener === next) listener = null;
      },
    };

    await expect(waitForChannelOpened({ channel, timeoutMs: 1_000 })).resolves.toBe(true);
    expect(listener).toBeNull();
  });

  test("rejects immediately when the channel closes while opening", async () => {
    const channel = fakeChannel();
    const promise = waitForChannelOpened({ channel, timeoutMs: 1_000 });
    channel.emitState(DXLinkChannelState.CLOSED);
    await expect(promise).rejects.toThrow(/closed before reaching OPENED/);
    expect(channel.listenerCount()).toBe(0);
  });

  test("rejects on timeout when OPENED never arrives", async () => {
    const channel = fakeChannel();
    await expect(waitForChannelOpened({ channel, timeoutMs: 30 })).rejects.toThrow(/did not reach OPENED within 30ms/);
  });

  test("resolves false when the abort signal fires first", async () => {
    const channel = fakeChannel();
    let resolveAbort;
    const abortPromise = new Promise((resolve) => {
      resolveAbort = resolve;
    });
    const promise = waitForChannelOpened({ channel, timeoutMs: 1_000, abortPromise });
    resolveAbort();
    await expect(promise).resolves.toBe(false);
  });

  test("a late OPENED after timeout does not double-settle or throw", async () => {
    const channel = fakeChannel();
    await expect(waitForChannelOpened({ channel, timeoutMs: 20 })).rejects.toThrow();
    expect(() => channel.emitState(DXLinkChannelState.OPENED)).not.toThrow();
  });

  test("rejects invalid timeout and lifecycle interfaces before installing resources", () => {
    expect(() => waitForChannelOpened({ channel: fakeChannel(), timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => waitForChannelOpened({ channel: {}, timeoutMs: 1_000 })).toThrow(/lifecycle interface/);
  });
});
