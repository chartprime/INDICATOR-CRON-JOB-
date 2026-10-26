const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const {
  main,
  buildFeedAttempt,
  buildCandleAttempts,
  runDomAttempt,
  summarizeAggressorEvidence,
  summarizeIcebergEvidence,
  domSourcesFor,
  FEED_EVENT_CONTRACTS,
  CANDLE_CONTRACT,
  DOM_SETUP,
} = require("../../../scripts/verify/dxfeed/verify-dxfeed-extended-probe");
const { SYMBOLS, FRONT_MONTH_REFERENCE } = require("../../../scripts/verify/dxfeed/verify-dxfeed-capability-probe");

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

function fakeConnection({
  feedChannel = fakeChannel(),
  candleChannel = fakeChannel(),
  domChannelFactory = () => fakeChannel(),
} = {}) {
  const listeners = { error: [], connection: [], auth: [] };
  const domChannels = [];
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
    channel: feedChannel,
    candleChannel,
    domChannels,
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn((service, parameters) => {
      if (service === "DOM") {
        const domChannel = domChannelFactory(parameters);
        domChannels.push(domChannel);
        return domChannel;
      }
      if (parameters?.contract === "HISTORY") return candleChannel;
      return feedChannel;
    }),
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

async function driveCandleChannelOpened(connection) {
  const wasRequested = () =>
    connection.openChannel.mock.calls.some(([, parameters]) => parameters?.contract === "HISTORY");
  for (let tick = 0; tick < 200 && !wasRequested(); tick += 1) {
    await Promise.resolve();
  }
  connection.candleChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

async function driveAllDomChannelsOpened(connection, expectedCount) {
  const openedAlready = new Set();
  for (let tick = 0; tick < 200 && openedAlready.size < expectedCount; tick += 1) {
    await Promise.resolve();
    for (const domChannel of connection.domChannels) {
      if (!openedAlready.has(domChannel)) {
        openedAlready.add(domChannel);
        domChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
      }
    }
  }
}

describe("buildFeedAttempt", () => {
  test("TimeAndSale and TradeETH subscribe by symbol alone for an equity", () => {
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    for (const eventType of ["TimeAndSale", "TradeETH"]) {
      expect(buildFeedAttempt({ symbolEntry, eventType })).toEqual({
        label: `AAPL ${eventType}`,
        entry: { symbol: "AAPL", type: eventType },
      });
    }
  });

  test("TimeAndSale for a future resolves through the shared front-month reference", () => {
    const symbolEntry = { symbol: "/ES", kind: "future", root: "ES" };
    expect(buildFeedAttempt({ symbolEntry, eventType: "TimeAndSale" })).toEqual({
      label: "/ES TimeAndSale",
      entry: { symbol: FRONT_MONTH_REFERENCE.ES.symbol, type: "TimeAndSale" },
    });
  });

  test("TradeETH is skipped for futures because it is defined for extended-hours instruments", () => {
    const symbolEntry = { symbol: "/ES", kind: "future", root: "ES" };
    expect(buildFeedAttempt({ symbolEntry, eventType: "TradeETH" })).toBeNull();
  });

  test("AnalyticOrder for a future requests source GLBX", () => {
    const symbolEntry = { symbol: "/NQ", kind: "future", root: "NQ" };
    expect(buildFeedAttempt({ symbolEntry, eventType: "AnalyticOrder" })).toEqual({
      label: "/NQ AnalyticOrder (source GLBX)",
      entry: { symbol: FRONT_MONTH_REFERENCE.NQ.symbol, type: "AnalyticOrder", source: "GLBX" },
    });
  });

  test("AnalyticOrder is not applicable to an equity -- returns null, not a doomed subscription attempt", () => {
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    expect(buildFeedAttempt({ symbolEntry, eventType: "AnalyticOrder" })).toBeNull();
  });
});

describe("buildCandleAttempts", () => {
  test("an equity gets one bounded twenty-four-hour HISTORY request", () => {
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    const now = () => 1_700_000_000_000;
    expect(buildCandleAttempts({ symbolEntry, now })).toEqual([
      { label: "AAPL Candle (explicit HISTORY contract, fromTime=now-24h)", entry: { symbol: "AAPL{=m}", type: "Candle", fromTime: now() - 24 * 60 * 60 * 1000 } },
    ]);
  });

  test("a future resolves through the shared front-month reference", () => {
    const symbolEntry = { symbol: "/ES", kind: "future", root: "ES" };
    const now = () => 1_700_000_000_000;
    const attempts = buildCandleAttempts({ symbolEntry, now });
    expect(attempts[0].entry.symbol).toBe(`${FRONT_MONTH_REFERENCE.ES.symbol}{=m}`);
  });
});

describe("domSourcesFor", () => {
  test("futures use the glbx price-level source and equities use ntv", () => {
    expect(domSourcesFor({ symbol: "/ES", kind: "future", root: "ES" })).toEqual(["glbx"]);
    expect(domSourcesFor({ symbol: "AAPL", kind: "equity" })).toEqual(["ntv"]);
  });
});

describe("summarizeAggressorEvidence", () => {
  test("extracts the aggressor-relevant fields", () => {
    expect(
      summarizeAggressorEvidence({ aggressorSide: "BUY", tradeId: 42, exchangeSaleConditions: "@F", type: "NEW" }),
    ).toEqual({ aggressorSide: "BUY", tradeId: 42, exchangeSaleConditions: "@F", type: "NEW" });
  });

  test("returns null for missing evidence", () => {
    expect(summarizeAggressorEvidence(null)).toBeNull();
  });
});

describe("summarizeIcebergEvidence", () => {
  test("extracts the iceberg-relevant fields", () => {
    expect(
      summarizeIcebergEvidence({ icebergPeakSize: 10, icebergHiddenSize: 90, icebergExecutedSize: 5, icebergType: "NATIVE" }),
    ).toEqual({ icebergPeakSize: 10, icebergHiddenSize: 90, icebergExecutedSize: 5, icebergType: "NATIVE" });
  });

  test("returns null for missing evidence", () => {
    expect(summarizeIcebergEvidence(undefined)).toBeNull();
  });
});

describe("runDomAttempt", () => {
  const symbolEntry = { symbol: "AAPL", kind: "equity" };

  test("resolves DATA_OBSERVED as soon as a DOM_SNAPSHOT arrives", async () => {
    const domChannel = fakeChannel();
    const connection = fakeConnection({ domChannelFactory: () => domChannel });
    const wait = jest.fn(() => new Promise(() => {}));
    const resultPromise = runDomAttempt({ connection, symbolEntry, windowMs: 10_000, wait, now: () => 0 });
    await Promise.resolve();
    domChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    for (let tick = 0; tick < 20 && domChannel.sent.length === 0; tick += 1) {
      await Promise.resolve();
    }
    domChannel.emitMessage({ type: "DOM_CONFIG", aggregationPeriod: 10, depthLimit: 20, dataFormat: "FULL" });
    domChannel.emitMessage({ type: "DOM_SNAPSHOT", time: 0, bids: [{ price: 100, size: 1 }], asks: [{ price: 101, size: 1 }] });
    const result = await resultPromise;
    expect(result.outcome).toBe("DATA_OBSERVED");
    expect(result.evidence.bids).toEqual([{ price: 100, size: 1 }]);
    expect(result.configuration).toMatchObject({ type: "DOM_CONFIG", depthLimit: 20, dataFormat: "FULL" });
    expect(domChannel.sent).toEqual([DOM_SETUP]);
    expect(domChannel.close).toHaveBeenCalledTimes(1);
  });

  test("resolves EXPLICIT_ERROR if the channel never opens", async () => {
    const domChannel = fakeChannel();
    const connection = fakeConnection({ domChannelFactory: () => domChannel });
    jest.useFakeTimers();
    try {
      const resultPromise = runDomAttempt({ connection, symbolEntry, windowMs: 10_000, wait: immediateWait, now: () => 0 });
      await jest.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;
      expect(result.outcome).toBe("EXPLICIT_ERROR");
    } finally {
      jest.useRealTimers();
    }
  });

  test("preserves a provider error emitted while the DOM channel is opening", async () => {
    const domChannel = fakeChannel();
    const connection = fakeConnection({ domChannelFactory: () => domChannel });
    const resultPromise = runDomAttempt({ connection, symbolEntry, windowMs: 10_000, wait: immediateWait, now: () => 0, secrets: ["secret"] });
    await Promise.resolve();
    domChannel.emitError({ type: "AUTHORIZATION_ERROR", message: "denied secret" });
    domChannel.emitState(DXLinkChannelState.CLOSED, DXLinkChannelState.REQUESTED);
    const result = await resultPromise;
    expect(result).toMatchObject({
      outcome: "EXPLICIT_ERROR",
      evidence: { type: "AUTHORIZATION_ERROR", message: expect.not.stringContaining("secret") },
    });
    expect(domChannel.close).toHaveBeenCalledTimes(1);
    expect(domChannel.removeErrorListener).toHaveBeenCalledTimes(1);
  });

  test("resolves NO_DATA_OBSERVED when the window elapses with no snapshot", async () => {
    const domChannel = fakeChannel();
    const connection = fakeConnection({ domChannelFactory: () => domChannel });
    const resultPromise = runDomAttempt({ connection, symbolEntry, windowMs: 10_000, wait: immediateWait, now: () => 0 });
    await Promise.resolve();
    domChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    const result = await resultPromise;
    expect(result.outcome).toBe("NO_DATA_OBSERVED");
  });

  test("resolves EXPLICIT_ERROR if openChannel throws synchronously", async () => {
    const connection = fakeConnection();
    connection.openChannel.mockImplementation(() => {
      throw new Error("DOM service refused");
    });
    const result = await runDomAttempt({ connection, symbolEntry, windowMs: 10_000, wait: immediateWait, now: () => 0 });
    expect(result.outcome).toBe("EXPLICIT_ERROR");
  });
});

describe("main", () => {
  test("invalid config logs an error and exits 1 without ever constructing a connection", async () => {
    const createConnection = jest.fn();
    const exit = jest.fn();
    await main({
      logger: noopLogger(),
      loadConfig: () => {
        throw new Error("dxfeed-config: missing required config: DXFEED_TEMP_TOKEN");
      },
      createConnection,
      exit,
    });
    expect(createConnection).not.toHaveBeenCalled();
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

  test("opens one explicit FEED channel for every required delivery contract, never AUTO", async () => {
    const connection = fakeConnection({ domChannelFactory: () => fakeChannel() });
    const exit = jest.fn();
    const runPromise = main({ logger: noopLogger(), loadConfig: () => config, createConnection: () => connection, exit, wait: immediateWait });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await driveCandleChannelOpened(connection);
    await driveAllDomChannelsOpened(connection, SYMBOLS.length);
    await runPromise;
    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "STREAM" }, { reconnect: false });
    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "TICKER" }, { reconnect: false });
    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "HISTORY" }, { reconnect: false });
    expect(FEED_EVENT_CONTRACTS).toEqual({ TimeAndSale: "STREAM", TradeETH: "TICKER", AnalyticOrder: "STREAM" });
    expect(CANDLE_CONTRACT).toBe("HISTORY");
  });

  test("openChannel() throwing synchronously for FEED disconnects and exits 1", async () => {
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

  test("full happy path: probes every applicable FEED cell and every symbol's DOM channel, then prints a findings table", async () => {
    const connection = fakeConnection({ domChannelFactory: () => fakeChannel() });
    const exit = jest.fn();
    const logger = noopLogger();

    const runPromise = main({ logger, loadConfig: () => config, createConnection: () => connection, exit, wait: immediateWait });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await driveCandleChannelOpened(connection);
    await driveAllDomChannelsOpened(connection, SYMBOLS.length);
    await runPromise;

    expect(exit).toHaveBeenCalledWith(0);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connection.candleChannel.close).toHaveBeenCalledTimes(1);

    const resultCalls = logger.info.mock.calls.filter(([message]) => message.startsWith("result:"));
    const futuresCount = SYMBOLS.filter((s) => s.kind === "future").length;
    const equityCount = SYMBOLS.filter((s) => s.kind === "equity").length;
    const expectedFeedCells = SYMBOLS.length /* TimeAndSale */ + equityCount /* TradeETH */ + futuresCount /* AnalyticOrder */;
    const expectedDomCells = SYMBOLS.length;
    const expectedCandleCells = SYMBOLS.length;
    expect(resultCalls).toHaveLength(expectedFeedCells + expectedDomCells + expectedCandleCells);

    const skippedCalls = logger.info.mock.calls.filter(([message]) => message.startsWith("skipped:"));
    expect(skippedCalls).toHaveLength(equityCount + futuresCount);

    expect(logger.banner.mock.calls.some(([lines]) => lines.includes("FINDINGS TABLE"))).toBe(true);
  });

  test("the Candle diagnostic channel throwing synchronously disconnects and exits 1 without printing findings", async () => {
    const connection = fakeConnection();
    const originalOpenChannel = connection.openChannel.getMockImplementation();
    connection.openChannel.mockImplementation((service, parameters) => {
      if (parameters?.contract === "HISTORY") throw new Error("history channel refused");
      return originalOpenChannel(service, parameters);
    });
    const exit = jest.fn();
    const logger = noopLogger();
    const runPromise = main({ logger, loadConfig: () => config, createConnection: () => connection, exit, wait: immediateWait });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await driveCandleChannelOpened(connection);
    await driveAllDomChannelsOpened(connection, SYMBOLS.length);
    await runPromise;
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.banner.mock.calls.some(([lines]) => lines.includes("FINDINGS TABLE"))).toBe(false);
  });

  test("a connection drop during FEED probing aborts the pending attempt and returns before findings print", async () => {
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
});
