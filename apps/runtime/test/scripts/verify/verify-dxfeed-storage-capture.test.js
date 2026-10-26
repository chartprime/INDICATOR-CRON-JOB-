const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { safeRm } = require("../../helpers/temp-files");
const { EVENT_TYPES } = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");
const {
  main,
  buildSubscriptionEntries,
  buildContextIndex,
  cellKey,
  SYMBOLS,
  listMissingCells,
} = require("../../../scripts/verify/dxfeed/verify-dxfeed-storage-capture");

function noopLogger() {
  return { banner: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), ok: jest.fn() };
}

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    sent,
    getState: jest.fn(() => state),
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
    getStatus: jest.fn(() => ({ connectionState, authState })),
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => channel),
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
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

function fakeStorageService() {
  const handled = [];
  const counters = { quotes: 0, trades: 0, orders: 0, timeAndSales: 0, rejected: 0, skipped: 0 };
  return {
    handled,
    handleEnvelope: jest.fn((envelope) => {
      handled.push(envelope);
      if (envelope.eventType === "QUOTE") counters.quotes += 1;
      if (envelope.eventType === "TRADE") counters.trades += 1;
      if (envelope.eventType === "ORDER") counters.orders += 1;
      if (envelope.eventType === "TIMEANDSALE") counters.timeAndSales += 1;
      return true;
    }),
    getCounters: jest.fn(() => ({ ...counters })),
    close: jest.fn(),
  };
}

function fakeStorageReader(counts = { quotes: 0, trades: 0, orders: 0, timeAndSales: 0 }) {
  const sequence = Array.isArray(counts) ? counts : [counts];
  let index = 0;
  return {
    countAll: jest.fn(() => sequence[Math.min(index++, sequence.length - 1)]),
    close: jest.fn(),
  };
}

function tempDbPath() {
  return path.join(
    os.tmpdir(),
    `terminal-l1-l2-dxfeed-capture-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function removeDbFiles(dbPath) {
  safeRm(dbPath, { force: true });
  safeRm(`${dbPath}-wal`, { force: true });
  safeRm(`${dbPath}-shm`, { force: true });
}

const config = Object.freeze({
  endpoint: "wss://tools.dxfeed.com/dxlink-chartprime",
  marketDataMode: "realtime",
  tempToken: "temporary-secret.token",
});

async function driveToChannelOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

const REAL_EQUITY_TRADE = {
  eventType: "Trade", eventSymbol: "TSLA", eventTime: 0, time: 1787601599905, timeNanoPart: 0,
  sequence: 1122817, exchangeCode: "L", price: 349.03, change: -13.83, size: 120, dayId: 20689,
  dayVolume: 34651826.701307, dayTurnover: 12302399792.64278, tickDirection: "ZERO_UP", extendedTradingHours: true,
};

const REAL_FUTURE_TIME_AND_SALE = {
  eventType: "TimeAndSale", eventSymbol: "/NQZ26:XCME", eventTime: 0, eventFlags: 0,
  index: 7678176778774447000, time: 1787601599905, timeNanoPart: 0, sequence: 66860,
  exchangeCode: "G", price: 29219, size: 1, bidPrice: 29219, askPrice: 29220,
  tradeThroughExempt: "", aggressorSide: "SELL", spreadLeg: false,
  extendedTradingHours: false, validTick: true, type: "NEW",
};

const REAL_EQUITY_TIME_AND_SALE = {
  eventType: "TimeAndSale", eventSymbol: "TSLA", eventTime: 0, eventFlags: 0,
  index: 7679136203203489000, time: 1787601599905, timeNanoPart: 0, sequence: 601002,
  exchangeCode: "L", price: 349.03, size: 120, bidPrice: 349, askPrice: 349.06,
  exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY", spreadLeg: false,
  extendedTradingHours: true, validTick: false, type: "NEW",
};

function fullCoverageEvents() {
  return SYMBOLS.flatMap(({ symbol, assetClass, orderSource }) => {
    const events = [{
      eventType: "Quote",
      eventSymbol: symbol,
      bidTime: 1787601599000,
      bidExchangeCode: "Q",
      bidPrice: 100,
      bidSize: 2,
      askTime: 1787601599000,
      askExchangeCode: "Q",
      askPrice: 101,
      askSize: 3,
    },
    {
      ...REAL_EQUITY_TRADE,
      eventSymbol: symbol,
    },
    {
      eventType: "Order",
      eventSymbol: symbol,
      eventFlags: 0,
      index: null,
      time: 1787601599000,
      source: orderSource,
      action: "NEW",
      orderId: 0,
      price: 100,
      size: 1,
      side: "BUY",
      scope: "ORDER",
    }];
    events.push(
      assetClass === "FUTURE"
        ? { ...REAL_FUTURE_TIME_AND_SALE, eventSymbol: symbol }
        : { ...REAL_EQUITY_TIME_AND_SALE, eventSymbol: symbol },
    );
    return events;
  });
}

describe("buildSubscriptionEntries", () => {
  test("builds Quote+Trade+Order+TimeAndSale for every symbol, futures and equities alike", () => {
    const entries = buildSubscriptionEntries();
    expect(entries).toHaveLength(20);
    const futuresOrder = entries.find((e) => e.symbol === "/NQZ26:XCME" && e.type === "Order");
    expect(futuresOrder.source).toBe("GLBX");
    const equityOrder = entries.find((e) => e.symbol === "AAPL" && e.type === "Order");
    expect(equityOrder.source).toBe("NTV");
    const quote = entries.find((e) => e.symbol === "TSLA" && e.type === "Quote");
    expect(quote.source).toBeUndefined();
    expect(entries).toContainEqual({ symbol: "/NQZ26:XCME", type: "TimeAndSale" });
    expect(entries).toContainEqual({ symbol: "AAPL", type: "TimeAndSale" });
  });
});

describe("buildContextIndex", () => {
  test("maps every (symbol, wireEventType) cell to the right assetClass/canonical eventType", () => {
    const index = buildContextIndex();
    expect(index.size).toBe(buildSubscriptionEntries().length);
    expect(index.get(cellKey("/NQZ26:XCME", "Order"))).toEqual({
      assetClass: "FUTURE",
      symbol: "/NQZ26:XCME",
      eventType: "ORDER",
      source: "GLBX",
    });
    expect(index.get(cellKey("TSLA", "Trade"))).toEqual({
      assetClass: "EQUITY",
      symbol: "TSLA",
      eventType: "TRADE",
      source: undefined,
    });
    expect(index.get(cellKey("/NQZ26:XCME", "TimeAndSale"))).toEqual({
      assetClass: "FUTURE",
      symbol: "/NQZ26:XCME",
      eventType: "TIMEANDSALE",
      source: undefined,
    });
    expect(index.get(cellKey("AAPL", "TimeAndSale"))).toEqual({
      assetClass: "EQUITY",
      symbol: "AAPL",
      eventType: "TIMEANDSALE",
      source: undefined,
    });
    expect(index.get(cellKey("UNKNOWN", "Trade"))).toBeUndefined();
  });

  test("lists every required cell that has not been persisted", () => {
    const index = buildContextIndex();
    const seen = new Set([cellKey("TSLA", "Trade")]);
    const missing = listMissingCells(index, seen);
    expect(missing).toHaveLength(index.size - 1);
    expect(missing).not.toContain(cellKey("TSLA", "Trade"));
  });
});

describe("main", () => {
  test("invalid config logs an error and exits 1 without ever constructing a connection", async () => {
    const createConnection = jest.fn();
    const exit = jest.fn();
    await main({
      logger: noopLogger(),
      loadConfig: () => {
        throw new Error("dxfeed-config: missing required config");
      },
      createConnection,
      exit,
    });
    expect(createConnection).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("rejects delayed mode before constructing storage or a connection", async () => {
    const createConnection = jest.fn();
    const createStorageService = jest.fn();
    const exit = jest.fn();
    await main({
      logger: noopLogger(),
      loadConfig: () => ({ ...config, marketDataMode: "delayed" }),
      createConnection,
      createStorageService,
      exit,
    });
    expect(createConnection).not.toHaveBeenCalled();
    expect(createStorageService).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a synchronous connect() throw disconnects, closes storage, and exits 1", async () => {
    const connection = fakeConnection();
    connection.connect.mockImplementation(() => {
      throw new Error("boom");
    });
    const storageService = fakeStorageService();
    const exit = jest.fn();
    await main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      exit,
    });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop before AUTHORIZED aborts and exits 1 without ever opening a channel", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: fakeStorageService,
      createStorageReader: () => fakeStorageReader(),
      exit,
    });
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.CONNECTING, DXLinkConnectionState.NOT_CONNECTED);
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTING);
    await runPromise;
    expect(connection.openChannel).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop mid-capture aborts immediately", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const wait = jest.fn(() => new Promise(() => {}));
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: fakeStorageService,
      createStorageReader: () => fakeStorageReader(),
      wait,
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await Promise.resolve();
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop while the FEED channel is opening aborts the pending wait", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: fakeStorageService,
      createStorageReader: () => fakeStorageReader(),
      exit,
    });
    await Promise.resolve();
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
  });

  test("a dxLink error is redacted and fails the capture immediately", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const exit = jest.fn();
    const runPromise = main({
      logger,
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: fakeStorageService,
      createStorageReader: () => fakeStorageReader(),
      exit,
    });
    await Promise.resolve();
    connection.emitError({ type: "AUTH", message: `denied ${config.tempToken}` });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(config.tempToken);
  });

  test("a storage service close failure during cleanup is also redacted, not just the connection-error path", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const exit = jest.fn();
    const storageService = fakeStorageService();
    storageService.close.mockImplementation(() => {
      throw new Error(`close failed for token ${config.tempToken}`);
    });
    const runPromise = main({
      logger,
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      exit,
    });
    await Promise.resolve();
    connection.emitError({ type: "AUTH", message: "denied" });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(config.tempToken);
  });

  test("a FEED channel error closes the channel and fails the capture", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: fakeStorageService,
      createStorageReader: () => fakeStorageReader(),
      wait: jest.fn(() => new Promise(() => {})),
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    connection.channel.emitError(new Error("transport failed"));
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
  });

  test("full coverage is normalized, persisted, and independently matched by read-back counts", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const reader = fakeStorageReader([
      { quotes: 0, trades: 0, orders: 0, timeAndSales: 0 },
      { quotes: 5, trades: 5, orders: 5, timeAndSales: 5 },
    ]);
    const exit = jest.fn();
    let resolveWait;
    const wait = jest.fn(() => new Promise((resolve) => { resolveWait = resolve; }));
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => reader,
      wait,
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await Promise.resolve();
    connection.channel.emitMessage({ type: "FEED_DATA", data: fullCoverageEvents() });
    resolveWait?.();
    await runPromise;

    expect(storageService.handleEnvelope).toHaveBeenCalledTimes(15);
    const tradeEnvelope = storageService.handled.find(
      (envelope) => envelope.eventType === "TRADE" && envelope.providerSymbol === "TSLA",
    );
    expect(tradeEnvelope.provider).toBe("DXFEED");
    expect(reader.countAll).toHaveBeenCalledTimes(2);
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("full orchestration persists through the real normalizer, SQLite service, and reader", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath, bootstrap: true }).close();
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      dbPath,
      wait: () => new Promise(() => {}),
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: fullCoverageEvents() });
    await runPromise;

    expect(exit).toHaveBeenCalledWith(0);
    const reader = createDxFeedStorageReader({ dbPath });
    expect(reader.countAll()).toEqual({ quotes: 5, trades: 5, orderBookCapture: 0, timeAndSales: 5, candles: 0 });
    // Order cells are read back through the capture table, not readRecent.
    for (const context of [...buildContextIndex().values()].filter((c) => c.eventType !== EVENT_TYPES.ORDER)) {
      const result = reader.readRecent(context.symbol, context.assetClass, context.eventType, { limit: 1 });
      expect(result.available).toBe(true);
      expect(result.rows).toHaveLength(1);
    }
    reader.close();
    removeDbFiles(dbPath);
  });

  test("a storage rejection turns the proof run into a failure instead of claiming cell coverage", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    storageService.handleEnvelope.mockImplementation(() => false);
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      wait: jest.fn(() => new Promise(() => {})),
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [REAL_EQUITY_TRADE] });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(storageService.getCounters).not.toHaveBeenCalled();
  });

  test("a post-capture count mismatch fails the proof rather than reporting false storage evidence", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const reader = fakeStorageReader([{ quotes: 0, trades: 0, orders: 0 }, { quotes: 0, trades: 0, orders: 0 }]);
    const exit = jest.fn();
    let resolveWait;
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => reader,
      wait: jest.fn(() => new Promise((resolve) => { resolveWait = resolve; })),
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: fullCoverageEvents() });
    resolveWait();
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("an event for an unsubscribed symbol/type is ignored, not passed to storage", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const exit = jest.fn();
    let resolveWait;
    const wait = jest.fn(() => new Promise((resolve) => { resolveWait = resolve; }));
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      wait,
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await Promise.resolve();
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "MSFT" }] });
    resolveWait();
    await runPromise;

    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("an Order event from the wrong source is ignored and cannot prove its required cell", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const exit = jest.fn();
    let resolveWait;
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      wait: jest.fn(() => new Promise((resolve) => { resolveWait = resolve; })),
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [
        {
          ...fullCoverageEvents().find((event) => event.eventType === "Order" && event.eventSymbol === "AAPL"),
          source: "COMPOSITE",
        },
      ],
    });
    resolveWait();
    await runPromise;

    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a degraded normalization result is logged and skipped, not passed to storage", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const exit = jest.fn();
    let resolveWait;
    const wait = jest.fn(() => new Promise((resolve) => { resolveWait = resolve; }));
    const logger = noopLogger();
    const malformedTrade = { ...REAL_EQUITY_TRADE };
    delete malformedTrade.price;
    const runPromise = main({
      logger,
      loadConfig: () => config,
      createConnection: () => connection,
      createStorageService: () => storageService,
      createStorageReader: () => fakeStorageReader(),
      wait,
      exit,
    });
    await Promise.resolve();
    await driveToChannelOpened(connection);
    await Promise.resolve();
    connection.channel.emitMessage({ type: "FEED_DATA", data: [malformedTrade] });
    resolveWait();
    await runPromise;

    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
