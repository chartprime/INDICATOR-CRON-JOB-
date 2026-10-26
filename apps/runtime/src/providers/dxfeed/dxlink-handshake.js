const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");

const AUTH_TIMEOUT_MS = 30_000;
const CHANNEL_OPEN_TIMEOUT_MS = 15_000;

function assertTimeoutMs(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("dxlink-handshake: timeoutMs must be a positive safe integer");
  }
}

function assertAbortPromise(abortPromise) {
  if (abortPromise === undefined) return;
  if (typeof abortPromise.then !== "function") {
    throw new Error(
      "dxlink-handshake: abortPromise must be a promise that settles when the wait should be abandoned, not an AbortSignal",
    );
  }
}

function waitForAuthorized({ connection, timeoutMs, abortPromise } = {}) {
  assertTimeoutMs(timeoutMs);
  assertAbortPromise(abortPromise);
  if (
    !connection ||
    typeof connection.getStatus !== "function" ||
    typeof connection.onConnectionStateChange !== "function" ||
    typeof connection.onAuthStateChange !== "function"
  ) {
    throw new Error("dxlink-handshake: connection does not implement the required lifecycle interface");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle;
    let unsubscribeConnection = () => {};
    let unsubscribeAuth = () => {};

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        unsubscribeConnection();
      } catch {
        void 0;
      }
      try {
        unsubscribeAuth();
      } catch {
        void 0;
      }
      action();
    }

    try {
      unsubscribeConnection = connection.onConnectionStateChange(({ state, prev }) => {
        if (state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
          finish(() => reject(new Error("connection dropped before reaching AUTHORIZED")));
        }
      });
      if (typeof unsubscribeConnection !== "function") {
        throw new Error("dxlink-handshake: connection listener registration must return unsubscribe functions");
      }
      if (settled) {
        unsubscribeConnection();
        return;
      }
      unsubscribeAuth = connection.onAuthStateChange(({ state }) => {
        if (state === DXLinkAuthState.AUTHORIZED) {
          finish(() => resolve(true));
        }
      });
      if (typeof unsubscribeAuth !== "function") {
        throw new Error("dxlink-handshake: connection listener registration must return unsubscribe functions");
      }
      if (settled) {
        unsubscribeConnection();
        unsubscribeAuth();
        return;
      }
      timeoutHandle = setTimeout(
        () => finish(() => reject(new Error(`did not reach AUTHORIZED within ${timeoutMs}ms`))),
        timeoutMs,
      );
      timeoutHandle.unref?.();
      if (abortPromise !== undefined) {
        Promise.resolve(abortPromise).then(
          () => finish(() => resolve(false)),
          () => {},
        );
      }
      const { authState, connectionState } = connection.getStatus();
      if (connectionState === DXLinkConnectionState.NOT_CONNECTED) {
        finish(() => reject(new Error("connection is not connected while waiting for AUTHORIZED")));
      } else if (authState === DXLinkAuthState.AUTHORIZED) {
        finish(() => resolve(true));
      }
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function waitForChannelOpened({ channel, timeoutMs, abortPromise } = {}) {
  assertTimeoutMs(timeoutMs);
  assertAbortPromise(abortPromise);
  if (
    !channel ||
    typeof channel.getState !== "function" ||
    typeof channel.addStateChangeListener !== "function" ||
    typeof channel.removeStateChangeListener !== "function"
  ) {
    throw new Error("dxlink-handshake: channel does not implement the required lifecycle interface");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle;

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        channel.removeStateChangeListener(onStateChange);
      } catch {
        void 0;
      }
      action();
    }

    function onStateChange(state) {
      if (state === DXLinkChannelState.OPENED) {
        finish(() => resolve(true));
      } else if (state === DXLinkChannelState.CLOSED) {
        finish(() => reject(new Error("channel closed before reaching OPENED")));
      }
    }

    try {
      channel.addStateChangeListener(onStateChange);
      if (settled) return;
      timeoutHandle = setTimeout(
        () => finish(() => reject(new Error(`channel did not reach OPENED within ${timeoutMs}ms`))),
        timeoutMs,
      );
      timeoutHandle.unref?.();
      if (abortPromise !== undefined) {
        Promise.resolve(abortPromise).then(
          () => finish(() => resolve(false)),
          () => {},
        );
      }
      const state = channel.getState();
      if (state === DXLinkChannelState.OPENED) {
        finish(() => resolve(true));
      } else if (state === DXLinkChannelState.CLOSED) {
        finish(() => reject(new Error("channel is already CLOSED")));
      }
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

module.exports = { waitForAuthorized, waitForChannelOpened, AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS };
