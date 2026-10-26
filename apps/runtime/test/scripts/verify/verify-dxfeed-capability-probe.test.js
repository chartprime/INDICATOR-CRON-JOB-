const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const {
  main,
  buildSubscriptionAttempts,
  classifyAttemptOutcome,
  classifyCellOutcome,
  eventMatchesSubscription,
  runAttempt,
  SYMBOLS,
  EVENT_TYPES,
  FRONT_MONTH_REFERENCE,
} = require("../../../scripts/verify/dxfeed/verify-dxfeed-capability-probe");

function noopLogger() {
  return {
    banner: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ok: jest.fn(),
  };
}

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
    close: jest.fn(),
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    getState: jest.fn(() => state),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection({ channel = fakeChannel() } = {}) {
  const listeners = { error: [], connection: [], auth: [] };
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
    channel,
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => channel),
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    getStatus: jest.fn(() => ({ connectionState, authState })),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
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

const config = Object.freeze({
  endpoint: "wss://tools.dxfeed.com/dxlink-chartprime",
  marketDataMode: "realtime",
  tempToken: "temporary-secret.token",
});

function immediateWait() {
  return Promise.resolve();
}

async function driveToChannelOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

describe("buildSubscriptionAttempts", () => {
  const now = () => 1_700_000_000_000;

  test("Quote/Trade for an equity: single attempt, no frontMonthSource", () => {
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    for (const eventType of ["Quote", "Trade"]) {
      const attempts = buildSubscriptionAttempts({ symbolEntry, eventType, now });
      expect(attempts).toEqual([
        { label: `AAPL ${eventType}`, entry: { symbol: "AAPL", type: eventType }, frontMonthSource: undefined },
      ]);
    }
  });

  test("Quote for a future: resolves to the front-month reference symbol and discloses its source", () => {
    const symbolEntry = { symbol: "/ES", kind: "future", root: "ES" };
    const attempts = buildSubscriptionAttempts({ symbolEntry, eventType: "Quote", now });
    expect(attempts).toEqual([
      {
        label: "/ES Quote",
        entry: { symbol: FRONT_MONTH_REFERENCE.ES.symbol, type: "Quote" },
        frontMonthSource: FRONT_MONTH_REFERENCE.ES.source,
      },
    ]);
  });

  test("Candle: symbol carries the {=m} suffix and fromTime looks back from now()", () => {
    const symbolEntry = { symbol: "TSLA", kind: "equity" };
    const attempts = buildSubscriptionAttempts({ symbolEntry, eventType: "Candle", now });
    expect(attempts).toEqual([
      {
        label: "TSLA Candle",
        entry: { symbol: "TSLA{=m}", type: "Candle", fromTime: now() - 5 * 60 * 1000 },
        frontMonthSource: undefined,
      },
    ]);
  });

  test("Order for a future: single attempt with source GLBX", () => {
    const symbolEntry = { symbol: "/NQ", kind: "future", root: "NQ" };
    const attempts = buildSubscriptionAttempts({ symbolEntry, eventType: "Order", now });
    expect(attempts).toEqual([
      {
        label: "/NQ Order (source GLBX)",
        entry: { symbol: FRONT_MONTH_REFERENCE.NQ.symbol, type: "Order", source: "GLBX" },
        frontMonthSource: FRONT_MONTH_REFERENCE.NQ.source,
      },
    ]);
  });

  test("Order for an equity: three ordered attempts, no source first, then NTV, then COMPOSITE", () => {
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    const attempts = buildSubscriptionAttempts({ symbolEntry, eventType: "Order", now });
    expect(attempts.map((attempt) => attempt.entry)).toEqual([
      { symbol: "AAPL", type: "Order" },
      { symbol: "AAPL", type: "Order", source: "NTV" },
      { symbol: "AAPL", type: "Order", source: "COMPOSITE" },
    ]);
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
    const first = { eventType: "Trade", price: 100 };
    expect(classifyAttemptOutcome({ receivedEvents: [first, { eventType: "Trade", price: 101 }], receivedError: null })).toEqual({
      outcome: "DATA_OBSERVED",
      evidence: first,
    });
  });

  test("neither events nor an error classifies as NO_DATA_OBSERVED", () => {
    expect(classifyAttemptOutcome({ receivedEvents: [], receivedError: null })).toEqual({
      outcome: "NO_DATA_OBSERVED",
      evidence: null,
    });
  });
});

describe("classifyCellOutcome", () => {
  test("streaming takes precedence over rejected and silent attempts", () => {
    expect(
      classifyCellOutcome([
        { outcome: "NO_DATA_OBSERVED" },
        { outcome: "EXPLICIT_ERROR" },
        { outcome: "DATA_OBSERVED" },
      ]),
    ).toBe("DATA_OBSERVED");
  });

  test("a rejection is retained when later source candidates are merely silent", () => {
    expect(classifyCellOutcome([{ outcome: "EXPLICIT_ERROR" }, { outcome: "NO_DATA_OBSERVED" }])).toBe("EXPLICIT_ERROR");
  });

  test("an empty or all-silent attempt set is silent", () => {
    expect(classifyCellOutcome([])).toBe("NO_DATA_OBSERVED");
    expect(classifyCellOutcome([{ outcome: "NO_DATA_OBSERVED" }])).toBe("NO_DATA_OBSERVED");
  });
});

describe("eventMatchesSubscription", () => {
  test("requires both the requested event type and exact wire symbol", () => {
    const entry = { symbol: "AAPL", type: "Quote" };
    expect(eventMatchesSubscription({ eventType: "Quote", eventSymbol: "AAPL" }, entry)).toBe(true);
    expect(eventMatchesSubscription({ eventType: "Quote", eventSymbol: "TSLA" }, entry)).toBe(false);
    expect(eventMatchesSubscription({ eventType: "Trade", eventSymbol: "AAPL" }, entry)).toBe(false);
  });

  test("requires the requested source when an Order subscription specifies one", () => {
    const entry = { symbol: "AAPL", type: "Order", source: "NTV" };
    expect(eventMatchesSubscription({ eventType: "Order", eventSymbol: "AAPL", source: "NTV" }, entry)).toBe(true);
    expect(eventMatchesSubscription({ eventType: "Order", eventSymbol: "AAPL", source: "COMPOSITE" }, entry)).toBe(
      false,
    );
  });
});

describe("runAttempt", () => {
  const entry = { symbol: "AAPL", type: "Quote" };

  test("resolves DATA_OBSERVED as soon as a matching FEED_DATA event arrives, without waiting the full window", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait, now: () => 0 });
    await Promise.resolve();
    channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "Quote", eventSymbol: "AAPL", bidPrice: 1 }] });
    const result = await resultPromise;
    expect(result.outcome).toBe("DATA_OBSERVED");
    expect(result.evidence).toEqual({ eventType: "Quote", eventSymbol: "AAPL", bidPrice: 1 });
  });

  test("ignores a FEED_DATA event whose eventType doesn't match the subscribed entry", async () => {
    const channel = fakeChannel();
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "Trade", eventSymbol: "AAPL" }] });
    const result = await resultPromise;
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
  });

  test("ignores the right event type for a different symbol", async () => {
    const channel = fakeChannel();
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "Quote", eventSymbol: "TSLA" }] });
    const result = await resultPromise;
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
  });

  test("ignores an Order event from a different source", async () => {
    const channel = fakeChannel();
    const orderEntry = { symbol: "AAPL", type: "Order", source: "NTV" };
    const resultPromise = runAttempt({ channel, entry: orderEntry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", source: "COMPOSITE" }],
    });
    const result = await resultPromise;
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
  });

  test("resolves EXPLICIT_ERROR as soon as a channel error arrives", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({ channel, entry, windowMs: 8_000, wait, now: () => 0 });
    await Promise.resolve();
    channel.emitError({ type: "SUBSCRIPTION_ERROR", message: "not entitled" });
    const result = await resultPromise;
    expect(result.outcome).toBe("EXPLICIT_ERROR");
    expect(result.evidence).toEqual({ type: "SUBSCRIPTION_ERROR", message: "not entitled" });
  });

  test("redacts secrets from channel-error evidence", async () => {
    const channel = fakeChannel();
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runAttempt({
      channel,
      entry,
      windowMs: 8_000,
      wait,
      now: () => 0,
      secrets: ["abc123.def456"],
    });
    await Promise.resolve();
    channel.emitError({ type: "SUBSCRIPTION_ERROR", message: "rejected abc123.def456" });
    const result = await resultPromise;
    expect(result.evidence.message).toBe("rejected [REDACTED]");
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

  test("a synchronous send() throw on the initial subscribe resolves EXPLICIT_ERROR instead of rejecting the promise", async () => {
    const channel = fakeChannel();
    channel.send.mockImplementation(() => {
      throw new Error("Channel is not ready");
    });
    const result = await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    expect(result.outcome).toBe("EXPLICIT_ERROR");
    expect(result.evidence).toEqual({ message: "Channel is not ready" });
    expect(channel.removeMessageListener).toHaveBeenCalledTimes(1);
    expect(channel.removeErrorListener).toHaveBeenCalledTimes(1);
  });

  test("resolves NO_DATA_OBSERVED when the window elapses with nothing received", async () => {
    const channel = fakeChannel();
    const result = await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now: () => 0 });
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
    expect(result.evidence).toBeNull();
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

  test("reports elapsed time using the injected clock", async () => {
    const channel = fakeChannel();
    let calls = 0;
    const now = () => (calls++ === 0 ? 1_000 : 1_250);
    const result = await runAttempt({ channel, entry, windowMs: 8_000, wait: immediateWait, now });
    expect(result.elapsedMs).toBe(250);
  });
});

describe("main", () => {
  test("invalid config logs an error and exits 1 without ever constructing a connection", async () => {
    const createConnection = jest.fn();
    const exit = jest.fn();
    const logger = noopLogger();
    await main({
      logger,
      loadConfig: () => {
        throw new Error("dxfeed-config: missing required config: DXFEED_TEMP_TOKEN");
      },
      createConnection,
      exit,
    });
    expect(createConnection).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a synchronous connect() throw disconnects and exits 1", async () => {
    const connection = fakeConnection();
    connection.connect.mockImplementation(() => {
      throw new Error("boom");
    });
    const exit = jest.fn();
    await main({ logger: noopLogger(), loadConfig: () => config, createConnection: () => connection, exit });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop before AUTHORIZED aborts and exits 1 without ever opening a channel", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({ logger: noopLogger(), loadConfig: () => config, createConnection: () => connection, exit });
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.CONNECTING, DXLinkConnectionState.NOT_CONNECTED);
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTING);
    await runPromise;
    expect(connection.openChannel).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop during the probing loop aborts the pending attempt and returns before findings print", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const logger = noopLogger();
    const wait = jest.fn(() => new Promise(() => {}));
    const runPromise = main({ logger, loadConfig: () => config, createConnection: () => connection, exit, wait });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.banner.mock.calls.some(([lines]) => lines.includes("FINDINGS TABLE"))).toBe(false);
  });

  test("SIGINT after AUTHORIZED but before the channel opens aborts cleanly with exit 130", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const signalProcess = new (require("node:events").EventEmitter)();
    signalProcess.off = signalProcess.removeListener.bind(signalProcess);
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      exit,
      signalProcess,
    });
    await Promise.resolve();
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    signalProcess.emit("SIGINT");
    await Promise.resolve();
    await runPromise;
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("openChannel() throwing synchronously disconnects and exits 1", async () => {
    const connection = fakeConnection();
    connection.openChannel.mockImplementation(() => {
      throw new Error("channel refused");
    });
    const exit = jest.fn();
    const runPromise = main({ logger: noopLogger(), loadConfig: () => config, createConnection: () => connection, exit });
    await Promise.resolve();
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await runPromise;
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("does not reach AUTHORIZED within the timeout: disconnects and exits 1", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    try {
      const connection = fakeConnection();
      const exit = jest.fn();
      const runPromise = main({ logger: noopLogger(), loadConfig: () => config, createConnection: () => connection, exit });
      await Promise.resolve();
      jest.advanceTimersByTime(30_000);
      await runPromise;
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("full happy path: runs every one of the 16 symbol x event-type cells exactly once and prints a findings table", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const logger = noopLogger();
    const runPromise = main({ logger, loadConfig: () => config, createConnection: () => connection, exit, wait: immediateWait });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await runPromise;

    expect(exit).toHaveBeenCalledWith(0);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connection.channel.close).toHaveBeenCalledTimes(1);

    const cellResultCalls = logger.ok.mock.calls.filter(([message]) => message.startsWith("cell result:"));
    expect(cellResultCalls).toHaveLength(SYMBOLS.length * EVENT_TYPES.length);
  });

  test("stops at the first successful Order attempt for an equity, without trying the remaining source candidates", async () => {
    const channel = fakeChannel();
    const originalSend = channel.send;
    channel.send = jest.fn((payload) => {
      originalSend(payload);
      const item = payload.add?.[0];
      if (item?.symbol === "AAPL" && item?.type === "Order" && !("source" in item)) {
        channel.emitMessage({ type: "FEED_DATA", data: [{ eventType: "Order", eventSymbol: "AAPL" }] });
      }
    });
    const connection = fakeConnection({ channel });
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      exit,
      wait: immediateWait,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await runPromise;

    const aaplOrderSubscribes = channel.sent.filter(
      (payload) => payload.add?.[0]?.symbol === "AAPL" && payload.add[0].type === "Order",
    );
    expect(aaplOrderSubscribes).toHaveLength(1);
    expect(aaplOrderSubscribes[0].add[0]).toEqual({ symbol: "AAPL", type: "Order" });
  });
});
