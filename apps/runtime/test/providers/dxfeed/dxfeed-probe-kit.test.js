const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const {
  redactEvidence,
  eventMatchesSubscription,
  classifyAttemptOutcome,
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
} = require("../../../src/providers/dxfeed/dxfeed-probe-kit");

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    sent,
    send: jest.fn((payload) => sent.push(payload)),
    addMessageListener: jest.fn((listener) => listeners.message.push(listener)),
    removeMessageListener: jest.fn((listener) => {
      listeners.message = listeners.message.filter((entry) => entry !== listener);
    }),
    addErrorListener: jest.fn((listener) => listeners.error.push(listener)),
    removeErrorListener: jest.fn((listener) => {
      listeners.error = listeners.error.filter((entry) => entry !== listener);
    }),
    addStateChangeListener: jest.fn((listener) => listeners.state.push(listener)),
    removeStateChangeListener: jest.fn((listener) => {
      listeners.state = listeners.state.filter((entry) => entry !== listener);
    }),
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    getState: jest.fn(() => state),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection() {
  const listeners = { connection: [], auth: [] };
  let connectionState = DXLinkConnectionState.CONNECTING;
  let authState = DXLinkAuthState.UNAUTHORIZED;
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    getStatus: jest.fn(() => ({ connectionState, authState })),
    emitConnection: (state, prev) => {
      connectionState = state;
      [...listeners.connection].forEach((listener) => listener({ state, prev }));
    },
    emitAuth: (state, prev) => {
      authState = state;
      [...listeners.auth].forEach((listener) => listener({ state, prev }));
    },
  };
}

function immediateWait() {
  return Promise.resolve();
}

describe("redactEvidence", () => {
  test("redacts a secret substring nested inside an object", () => {
    expect(redactEvidence({ message: "token abc123 leaked" }, ["abc123"])).toEqual({
      message: "token [REDACTED] leaked",
    });
  });

  test("falls back to a safe placeholder if the value cannot be serialized", () => {
    const circular = {};
    circular.self = circular;
    expect(redactEvidence(circular, [])).toEqual({ message: "evidence could not be serialized safely" });
  });
});

describe("eventMatchesSubscription", () => {
  test("requires both the requested event type and exact wire symbol", () => {
    const entry = { symbol: "AAPL", type: "Quote" };
    expect(eventMatchesSubscription({ eventType: "Quote", eventSymbol: "AAPL" }, entry)).toBe(true);
    expect(eventMatchesSubscription({ eventType: "Quote", eventSymbol: "TSLA" }, entry)).toBe(false);
    expect(eventMatchesSubscription({ eventType: "Trade", eventSymbol: "AAPL" }, entry)).toBe(false);
  });

  test("requires the requested source when a subscription specifies one", () => {
    const entry = { symbol: "AAPL", type: "Order", source: "NTV" };
    expect(eventMatchesSubscription({ eventType: "Order", eventSymbol: "AAPL", source: "NTV" }, entry)).toBe(true);
    expect(eventMatchesSubscription({ eventType: "Order", eventSymbol: "AAPL", source: "COMPOSITE" }, entry)).toBe(false);
  });
});

describe("classifyAttemptOutcome", () => {
  test("an error present classifies as EXPLICIT_ERROR regardless of events", () => {
    expect(classifyAttemptOutcome({ receivedEvents: [{ eventType: "Quote" }], receivedError: { message: "no" } })).toEqual({
      outcome: "EXPLICIT_ERROR",
      evidence: { message: "no" },
    });
  });

  test("events present with no error classifies as DATA_OBSERVED, evidence is the first event", () => {
    const first = { eventType: "TimeAndSale", price: 100 };
    expect(
      classifyAttemptOutcome({ receivedEvents: [first, { eventType: "TimeAndSale", price: 101 }], receivedError: null }),
    ).toEqual({ outcome: "DATA_OBSERVED", evidence: first });
  });

  test("neither events nor an error classifies as NO_DATA_OBSERVED", () => {
    expect(classifyAttemptOutcome({ receivedEvents: [], receivedError: null })).toEqual({
      outcome: "NO_DATA_OBSERVED",
      evidence: null,
    });
  });
});

describe("runAttempt", () => {
  const entry = { symbol: "AAPL", type: "TimeAndSale" };

  test("resolves DATA_OBSERVED as soon as a matching FEED_DATA event arrives, without waiting the full window", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait, now: () => 0 });
    await Promise.resolve();
    channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "TimeAndSale", eventSymbol: "AAPL", price: 1 }] });
    const result = await resultPromise;
    expect(result.outcome).toBe("DATA_OBSERVED");
    expect(result.evidence).toEqual({ eventType: "TimeAndSale", eventSymbol: "AAPL", price: 1 });
  });

  test("resolves EXPLICIT_ERROR as soon as a channel error arrives", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait, now: () => 0 });
    await Promise.resolve();
    channel.emitError({ type: "SUBSCRIPTION_ERROR", message: "not entitled" });
    const result = await resultPromise;
    expect(result.outcome).toBe("EXPLICIT_ERROR");
  });

  test("resolves NO_DATA_OBSERVED when the window elapses with nothing received", async () => {
    const channel = fakeChannel();
    const result = await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
  });

  test("can observe an entire bounded window and reports the event-time range", async () => {
    const channel = fakeChannel();
    let endWindow;
    const wait = jest.fn(() => new Promise((resolve) => {
      endWindow = resolve;
    }));
    const resultPromise = runAttempt({
      channel,
      entry,
      windowMs: 8_000,
      wait,
      now: () => 0,
      settleOnFirstEvent: false,
    });
    await Promise.resolve();
    channel.emitMessage({
      type: "FEED_DATA",
      data: [
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 200, price: 2 },
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 100, price: 1 },
      ],
    });
    await Promise.resolve();
    expect(endWindow).toBeDefined();
    endWindow();
    await expect(resultPromise).resolves.toMatchObject({
      outcome: "DATA_OBSERVED",
      eventCount: 2,
      earliestEventTime: 100,
      latestEventTime: 200,
    });
  });

  test("omits the full events array by default -- collectAllEvents opts in explicitly", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait, now: () => 0 });
    await Promise.resolve();
    channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "TimeAndSale", eventSymbol: "AAPL", price: 1 }] });
    const result = await resultPromise;
    expect(result.events).toBeUndefined();
  });

  test("collectAllEvents: true returns every matching event received during the window, in arrival order", async () => {
    const channel = fakeChannel();
    let endWindow;
    const wait = jest.fn(() => new Promise((resolve) => {
      endWindow = resolve;
    }));
    const resultPromise = runAttempt({
      channel,
      entry,
      windowMs: 8_000,
      wait,
      now: () => 0,
      settleOnFirstEvent: false,
      collectAllEvents: true,
    });
    await Promise.resolve();
    channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "TimeAndSale", eventSymbol: "AAPL", price: 1 }],
    });
    channel.emitMessage({
      type: "FEED_DATA",
      data: [
        { eventType: "TimeAndSale", eventSymbol: "AAPL", price: 2 },
        { eventType: "TimeAndSale", eventSymbol: "TSLA", price: 999 },
      ],
    });
    await Promise.resolve();
    endWindow();
    const result = await resultPromise;
    expect(result.events).toEqual([
      { eventType: "TimeAndSale", eventSymbol: "AAPL", price: 1 },
      { eventType: "TimeAndSale", eventSymbol: "AAPL", price: 2 },
    ]);
    expect(Object.isFrozen(result.events)).toBe(true);
  });

  test("collectAllEvents is explicitly capped while aggregate evidence remains complete", async () => {
    const channel = fakeChannel();
    let endWindow;
    const resultPromise = runAttempt({
      channel,
      entry,
      windowMs: 8_000,
      wait: () => new Promise((resolve) => { endWindow = resolve; }),
      now: () => 0,
      settleOnFirstEvent: false,
      collectAllEvents: true,
      maxCollectedEvents: 2,
    });
    await Promise.resolve();
    channel.emitMessage({
      type: "FEED_DATA",
      data: [
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 1, price: 1 },
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 2, price: 2 },
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 3, price: 3 },
      ],
    });
    endWindow();
    await expect(resultPromise).resolves.toMatchObject({
      eventCount: 3,
      earliestEventTime: 1,
      latestEventTime: 3,
      events: [
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 1, price: 1 },
        { eventType: "TimeAndSale", eventSymbol: "AAPL", time: 2, price: 2 },
      ],
      eventsTruncated: true,
    });
  });

  test("rejects a non-positive collection cap before mutating the channel", async () => {
    const channel = fakeChannel();
    await expect(runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0, maxCollectedEvents: 0 }))
      .rejects.toThrow(/maxCollectedEvents/);
    expect(channel.send).not.toHaveBeenCalled();
  });

  test("an abort rejects promptly, unsubscribes, and removes both listeners", async () => {
    const channel = fakeChannel();
    const controller = new AbortController();
    const resultPromise = runAttempt({
      channel,
      entry,
      windowMs: 8_000,
      wait: () => new Promise(() => {}),
      now: () => 0,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("stop"));
    await expect(resultPromise).rejects.toThrow("stop");
    expect(channel.sent).toEqual([
      { type: "FEED_SUBSCRIPTION", add: [entry] },
      { type: "FEED_SUBSCRIPTION", remove: [entry] },
    ]);
    expect(channel.removeMessageListener).toHaveBeenCalledTimes(1);
    expect(channel.removeErrorListener).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted attempt performs no subscription or listener mutation", async () => {
    const channel = fakeChannel();
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(
      runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0, signal: controller.signal }),
    ).rejects.toThrow("already stopped");
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.addMessageListener).not.toHaveBeenCalled();
  });

  test("a synchronous send() throw on the initial subscribe resolves EXPLICIT_ERROR instead of rejecting the promise", async () => {
    const channel = fakeChannel();
    channel.send.mockImplementation(() => {
      throw new Error("Channel is not ready");
    });
    const result = await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    expect(result.outcome).toBe("EXPLICIT_ERROR");
    expect(result.evidence).toEqual({ message: "Channel is not ready" });
  });

  test("sends the exact subscribe entry then the exact unsubscribe entry, and cleans up its own listeners", async () => {
    const channel = fakeChannel();
    await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    expect(channel.sent).toEqual([
      { type: "FEED_SUBSCRIPTION", add: [entry] },
      { type: "FEED_SUBSCRIPTION", remove: [entry] },
    ]);
    expect(channel.removeMessageListener).toHaveBeenCalledTimes(1);
    expect(channel.removeErrorListener).toHaveBeenCalledTimes(1);
  });
});

describe("waitForAuthorized", () => {
  test("resolves once AUTHORIZED fires", async () => {
    const connection = fakeConnection();
    const resultPromise = waitForAuthorized({ connection, timeoutMs: 30_000 });
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await expect(resultPromise).resolves.toBeUndefined();
  });

  test("rejects if the connection drops before AUTHORIZED", async () => {
    const connection = fakeConnection();
    const resultPromise = waitForAuthorized({ connection, timeoutMs: 30_000 });
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTING);
    await expect(resultPromise).rejects.toThrow("connection dropped before reaching AUTHORIZED");
  });

  test("rejects on abort", async () => {
    const connection = fakeConnection();
    const controller = new AbortController();
    const resultPromise = waitForAuthorized({ connection, timeoutMs: 30_000, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(resultPromise).rejects.toThrow("stop");
  });

  test("resolves immediately when authorization completed before the wait was installed", async () => {
    const connection = fakeConnection();
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await expect(waitForAuthorized({ connection, timeoutMs: 30_000 })).resolves.toBeUndefined();
  });
});

describe("waitForChannelOpened", () => {
  test("resolves once OPENED fires", async () => {
    const channel = fakeChannel();
    const resultPromise = waitForChannelOpened({ channel, timeoutMs: 15_000 });
    channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    await expect(resultPromise).resolves.toBeUndefined();
  });

  test("rejects on abort", async () => {
    const channel = fakeChannel();
    const controller = new AbortController();
    const resultPromise = waitForChannelOpened({ channel, timeoutMs: 15_000, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(resultPromise).rejects.toThrow("stop");
  });

  test("rejects immediately when the channel is already closed", async () => {
    const channel = fakeChannel();
    channel.emitState(DXLinkChannelState.CLOSED, DXLinkChannelState.REQUESTED);
    await expect(waitForChannelOpened({ channel, timeoutMs: 15_000 })).rejects.toThrow("already CLOSED");
  });
});
