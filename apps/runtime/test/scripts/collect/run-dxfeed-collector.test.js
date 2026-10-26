const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { EVENT_TYPES, listCollectorInstruments } = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { safeRm } = require("../../helpers/temp-files");
const {
  main,
  parseExpiresAtMs,
  computeShutdownDeadlineMs,
  SHUTDOWN_MARGIN_MS,
  MAX_TOKEN_LIFETIME_MS,
  PLANNED_ROTATION_EXIT_CODE,
  readDiskStats,
} = require("../../../scripts/collect/run-dxfeed-collector");

function tempDbPath() {
  return path.join(
    os.tmpdir(),
    `terminal-l1-l2-dxfeed-collector-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function removeDbFiles(dbPath) {
  safeRm(dbPath, { force: true });
  safeRm(`${dbPath}-wal`, { force: true });
  safeRm(`${dbPath}-shm`, { force: true });
}

describe("readDiskStats", () => {
  test("counts the live database and WAL/SHM footprint and fails closed when the database is absent", () => {
    const dbPath = tempDbPath();
    fs.writeFileSync(dbPath, Buffer.alloc(10));
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(7));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(3));
    expect(readDiskStats(dbPath)).toEqual(expect.objectContaining({
      dbSizeBytes: 20, diskProbeHealthy: true,
    }));
    removeDbFiles(dbPath);
    expect(readDiskStats(dbPath).diskProbeHealthy).toBe(false);
  });
});

function noopLogger() {
  return { banner: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), ok: jest.fn(), heartbeat: jest.fn() };
}

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    id: 1,
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

function noopOrderV2Capture() {
  return { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
}

function fakeStorageService() {
  const handled = [];
  const recordedCandles = [];
  const counters = { quotes: 0, trades: 0, orders: 0, timeAndSales: 0, candles: 0, orderBookCapture: 0, rejected: 0, skipped: 0 };
  const fakeRawStorageDb = {
    raw: { backup: jest.fn(), prepare: jest.fn(() => ({ iterate: jest.fn(() => []) })) },
    transaction: jest.fn((work) => work()),
    recordOrderBookContinuityAudit: jest.fn(),
  };
  const handleEnvelope = jest.fn((envelope) => {
    handled.push(envelope);
    if (envelope.state === "UNAVAILABLE") {
      counters.skipped += 1;
      return false;
    }
    if (envelope.eventType === "QUOTE") counters.quotes += 1;
    if (envelope.eventType === "TRADE") counters.trades += 1;
    if (envelope.eventType === "ORDER") counters.orders += 1;
    if (envelope.eventType === "TIMEANDSALE") counters.timeAndSales += 1;
    return true;
  });
  return {
    handled,
    recordedCandles,
    handleEnvelope,
    handleEnvelopes: jest.fn((envelopes) => envelopes.map(handleEnvelope)),
    handleOrderV2Envelope: jest.fn((envelope) => {
      if (envelope.state === "UNAVAILABLE") {
        counters.skipped += 1;
        return false;
      }
      counters.orderBookCapture += 1;
      return true;
    }),
    handleOrderV2Envelopes: jest.fn((envelopes) => envelopes.map((envelope) => {
      if (envelope.state === "UNAVAILABLE") {
        counters.skipped += 1;
        return false;
      }
      counters.orderBookCapture += 1;
      return true;
    })),
    recordCandle: jest.fn((symbol, assetClass, bar) => {
      recordedCandles.push({ symbol, assetClass, bar });
      counters.candles += 1;
    }),
    getCounters: jest.fn(() => ({ ...counters })),
    getStorageDb: jest.fn(() => fakeRawStorageDb),
    getCaptureResumeState: jest.fn(() => ({
      hasExistingData: false, previousSessionEndedAt: null, previousSessionCleanShutdown: null, previousSessionQuality: null,
    })),
    beginCaptureSession: jest.fn(),
    finishCaptureSession: jest.fn(),
    close: jest.fn(),
  };
}

function fakeCheckpoint() {
  return { start: jest.fn(), stop: jest.fn(), runOnce: jest.fn() };
}

const config = Object.freeze({
  endpoint: "wss://tools.dxfeed.com/dxlink-chartprime",
  marketDataMode: "realtime",
  tempToken: "temporary-secret.token",
});

const NOW_MS = 1_800_000_000_000;
const VALID_EXPIRES_AT = new Date(NOW_MS + 30 * 60_000).toISOString();

function baseOptions(overrides = {}) {
  return {
    logger: noopLogger(),
    loadConfig: () => config,
    createStorageService: fakeStorageService,
    createCheckpoint: fakeCheckpoint,
    createCapacityGuard: () => ({
      observe: jest.fn(() => ({ breached: false, shouldStop: false })),
      getStats: jest.fn(() => ({ capacityBreached: false })),
    }),
    readStorageCapacity: () => ({ diskProbeHealthy: true, dbSizeBytes: 1, freeDiskBytes: 100_000_000_000 }),
    env: { DXFEED_TOKEN_EXPIRES_AT: VALID_EXPIRES_AT },
    now: () => NOW_MS,
    signalProcess: { on: jest.fn(), off: jest.fn() },
    exit: jest.fn(),
    deadlineKeepsProcessAlive: false,
    ...overrides,
  };
}

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

// Real captured shape: fractional size, exchangeSaleConditions present, and
// validTick:false is the DEFAULT here deliberately -- most of the tests
// below reuse this fixture as-is, which means the equity policy's "no
// validTick requirement" is exercised implicitly by nearly every test in
// this file, not just the one that names it explicitly.
const REAL_EQUITY_TIME_AND_SALE = {
  eventType: "TimeAndSale", eventSymbol: "TSLA", eventTime: 0, eventFlags: 0,
  index: 7679136203203489000, time: 1787601599905, timeNanoPart: 0, sequence: 601002,
  exchangeCode: "L", price: 349.03, size: 120, bidPrice: 349, askPrice: 349.06,
  exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY", spreadLeg: false,
  extendedTradingHours: true, validTick: false, type: "NEW",
};

function fullCoverageEvents() {
  return listCollectorInstruments().flatMap(({ symbol, orderSource }) => [
    {
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
    { ...REAL_EQUITY_TRADE, eventSymbol: symbol },
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
    },
  ]);
}

describe("parseExpiresAtMs", () => {
  test("parses a valid ISO timestamp to epoch ms", () => {
    expect(parseExpiresAtMs("2026-01-01T00:30:00.000Z")).toBe(Date.parse("2026-01-01T00:30:00.000Z"));
  });

  test("returns null for missing, blank, or unparseable values", () => {
    expect(parseExpiresAtMs(undefined)).toBeNull();
    expect(parseExpiresAtMs("")).toBeNull();
    expect(parseExpiresAtMs("   ")).toBeNull();
    expect(parseExpiresAtMs("not-a-date")).toBeNull();
    expect(parseExpiresAtMs(42)).toBeNull();
    expect(parseExpiresAtMs("2026-01-01T00:30:00Z")).toBeNull();
  });
});

describe("computeShutdownDeadlineMs", () => {
  test("subtracts the safety margin from the real expiry -- not a hardcoded blind duration", () => {
    expect(computeShutdownDeadlineMs(NOW_MS + 30 * 60_000, SHUTDOWN_MARGIN_MS)).toBe(NOW_MS + 25 * 60_000);
  });
});

describe("main -- fail-closed on the self-termination deadline", () => {
  test("an invalid local clock exits 1 before reading token/config or creating resources", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({ now: () => Number.NaN, loadConfig, exit }));
    expect(exit).toHaveBeenCalledWith(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  test("an implausibly distant expiry exits 1 instead of overflowing the deadline timer", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({
      env: { DXFEED_TOKEN_EXPIRES_AT: new Date(NOW_MS + MAX_TOKEN_LIFETIME_MS + 1).toISOString() },
      loadConfig,
      exit,
    }));
    expect(exit).toHaveBeenCalledWith(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  test("missing DXFEED_TOKEN_EXPIRES_AT logs an error and exits 1 without ever loading config", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({ env: {}, loadConfig, exit }));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a malformed DXFEED_TOKEN_EXPIRES_AT exits 1 without ever loading config", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({ env: { DXFEED_TOKEN_EXPIRES_AT: "not-a-real-timestamp" }, loadConfig, exit }));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a token already past its safe margin exits 1 rather than starting with no real runway", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    const almostExpired = new Date(NOW_MS + 1 * 60_000).toISOString(); // 1 min left, margin is 5 min
    await main(baseOptions({ env: { DXFEED_TOKEN_EXPIRES_AT: almostExpired }, loadConfig, exit }));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a token exactly at its safe margin (zero runway) exits 1, not just past it", async () => {
    const loadConfig = jest.fn();
    const exit = jest.fn();
    const exactlyAtMargin = new Date(NOW_MS + SHUTDOWN_MARGIN_MS).toISOString();
    await main(baseOptions({ env: { DXFEED_TOKEN_EXPIRES_AT: exactlyAtMargin }, loadConfig, exit }));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("main -- startup", () => {
  test("invalid config logs an error and exits 1 without ever constructing a connection", async () => {
    const createConnection = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({
      loadConfig: () => {
        throw new Error("dxfeed-config: missing required config");
      },
      createConnection,
      exit,
    }));
    expect(createConnection).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("rejects delayed mode before constructing storage or a connection", async () => {
    const createConnection = jest.fn();
    const createStorageService = jest.fn();
    const exit = jest.fn();
    await main(baseOptions({
      loadConfig: () => ({ ...config, marketDataMode: "delayed" }),
      createConnection,
      createStorageService,
      exit,
    }));
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
    await main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, exit }));
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop before AUTHORIZED aborts and exits 76 without ever opening a channel", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, exit }));
    await Promise.resolve();
    connection.emitConnection(DXLinkConnectionState.CONNECTING, DXLinkConnectionState.NOT_CONNECTED);
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTING);
    await runPromise;
    expect(connection.openChannel).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(76);
  });

  test("a dxLink connection error is redacted and stops the collector, exit 1", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, exit, logger }));
    await Promise.resolve();
    connection.emitError({ type: "AUTH", message: `token ${config.tempToken} rejected` });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    const loggedMessages = logger.error.mock.calls.map((call) => JSON.stringify(call));
    expect(loggedMessages.some((entry) => entry.includes(config.tempToken))).toBe(false);
  });

  test("a FEED channel error closes the channel and stops the collector, exit 1", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, exit }));
    await driveToChannelOpened(connection);
    connection.channel.emitError(new Error("channel boom"));
    await runPromise;
    expect(connection.channel.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a connection drop mid-run aborts immediately, exit 76", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, exit }));
    await driveToChannelOpened(connection);
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
    expect(exit).toHaveBeenCalledWith(76);
  });

  test("a connection drop while the FEED channel is still opening aborts the pending wait, exit 76", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, exit }));
    await Promise.resolve();
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await Promise.resolve();
    await Promise.resolve();
    // Channel never reaches OPENED -- the connection drops while still waiting.
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
    expect(connection.channel.send).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(76);
  });
});

describe("main -- checkpoint (post-DX3.18 simplification)", () => {
  test("records an invalid capture-session outcome when checkpoint initialization fails", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const exit = jest.fn();
    await main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createCheckpoint: () => { throw new Error("disk unavailable"); },
      exit,
    }));

    expect(storageService.beginCaptureSession).toHaveBeenCalledWith(expect.objectContaining({ startedAt: NOW_MS }));
    expect(storageService.finishCaptureSession).toHaveBeenCalledWith(expect.objectContaining({
      quality: "INVALID", cleanShutdown: false, terminationReason: "checkpoint initialization failed",
    }));
  });

  test("logs prior dxFeed session quality when resuming an existing dataset", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    storageService.getCaptureResumeState.mockReturnValue({
      hasExistingData: true, previousSessionEndedAt: NOW_MS - 1_000,
      previousSessionCleanShutdown: false, previousSessionQuality: "INVALID",
    });
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger }));
    await driveToChannelOpened(connection);

    expect(logger.info).toHaveBeenCalledWith("dxFeed storage resumed existing dataset", expect.objectContaining({
      previousSession: "unclean_or_unknown", previousQuality: "INVALID",
    }));
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
  });

  test("checkpoint is started before the connection connects, wired to the same storage db", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const checkpoint = fakeCheckpoint();
    const createCheckpoint = jest.fn(() => checkpoint);
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createCheckpoint,
    }));
    await driveToChannelOpened(connection);

    const storageDb = storageService.getStorageDb();
    expect(createCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ storageDb }));
    expect(checkpoint.start).toHaveBeenCalledTimes(1);
    void runPromise;
  });

  test("a failure initializing checkpoint closes storage and exits 1 without ever connecting", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const createConnection = jest.fn(() => connection);
    const exit = jest.fn();
    await main(baseOptions({
      createConnection,
      createStorageService: () => storageService,
      createCheckpoint: () => {
        throw new Error("disk unavailable");
      },
      exit,
    }));
    expect(createConnection).not.toHaveBeenCalled();
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("shutdown stops the checkpoint before closing storage", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const checkpoint = fakeCheckpoint();
    const exit = jest.fn();
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createCheckpoint: () => checkpoint,
      exit,
    }));
    await driveToChannelOpened(connection);

    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;

    expect(checkpoint.stop).toHaveBeenCalledTimes(1);
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(76);
  });

  test("a checkpoint stop() failure is reported but still exits with the cleanup applied", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const checkpoint = fakeCheckpoint();
    checkpoint.stop.mockImplementation(() => {
      throw new Error("checkpoint stop boom");
    });
    const logger = noopLogger();
    const exit = jest.fn();
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createCheckpoint: () => checkpoint,
      logger,
      exit,
    }));
    await driveToChannelOpened(connection);

    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;

    expect(logger.error).toHaveBeenCalledWith("WAL checkpoint cleanup failed", expect.objectContaining({ reason: "checkpoint stop boom" }));
    expect(storageService.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("main -- running", () => {
  test("heartbeat health requires actual market-data progress, not merely a responsive event loop", async () => {
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    let heartbeatOptions;
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      signalProcess,
      exit,
      createHealthMonitor: () => ({ start: jest.fn(), stop: jest.fn(), getStats: () => ({ eventLoopHealthy: true }) }),
      createHeartbeat: (options) => {
        heartbeatOptions = options;
        return { start: jest.fn(), stop: jest.fn() };
      },
    }));
    await driveToChannelOpened(connection);
    expect(heartbeatOptions.isNominal(
      { eventLoopHealthy: true, diskProbeHealthy: true, capacityBreached: false, remainingMs: 1, quotes: 2, trades: 0, orders: 0 },
      { quotes: 1, trades: 0, orders: 0 },
    )).toBe(true);
    expect(heartbeatOptions.isNominal(
      { eventLoopHealthy: true, remainingMs: 1, quotes: 1, trades: 0, orders: 0 },
      { quotes: 1, trades: 0, orders: 0 },
    )).toBe(false);
    expect(heartbeatOptions.degradedReason({
      eventLoopHealthy: true, diskProbeHealthy: true, capacityBreached: false, remainingMs: 1,
    })).toBe("no new market data since last heartbeat");
    expect(heartbeatOptions.isNominal(
      { eventLoopHealthy: true, diskProbeHealthy: true, capacityBreached: false, remainingMs: 1, quotes: 2, skipped: 2 },
      { quotes: 1, skipped: 2 },
    )).toBe(true);
    expect(heartbeatOptions.isNominal(
      { eventLoopHealthy: true, diskProbeHealthy: true, capacityBreached: false, remainingMs: 1, quotes: 2, skipped: 3 },
      { quotes: 1, skipped: 2 },
    )).toBe(false);
    expect(heartbeatOptions.degradedReason(
      { eventLoopHealthy: true, diskProbeHealthy: true, capacityBreached: false, remainingMs: 1, skipped: 3 },
      { skipped: 2 },
    )).toBe("one or more canonical feed cells degraded this interval");
    signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1]();
    await runPromise;
  });

  test("heartbeat telemetry reports the bounded Order-v2 raw/parsed correlation backlog", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    let heartbeatOptions;
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      signalProcess,
      exit: jest.fn(),
      createOrderV2Capture: () => ({
        createConnector: jest.fn(),
        setChannelId: jest.fn(),
        handleChannelMessage: jest.fn(),
        getCorrelationStatus: () => ({ healthy: true, pendingFrames: 7, pendingIndexValues: 42 }),
      }),
      createHealthMonitor: () => ({ start: jest.fn(), stop: jest.fn(), getStats: () => ({ eventLoopHealthy: true }) }),
      createHeartbeat: (options) => {
        heartbeatOptions = options;
        return { start: jest.fn(), stop: jest.fn() };
      },
    }));
    await driveToChannelOpened(connection);
    const collected = heartbeatOptions.collect();
    expect(collected.orderV2PendingFrames).toBe(7);
    expect(collected.orderV2PendingIndexValues).toBe(42);
    expect(collected.orderV2CorrelationHealthy).toBe(true);
    expect(heartbeatOptions.displayCounters(collected).orderV2PendingFrames).toBe(7);
    signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1]();
    await runPromise;
  });

  test("heartbeat telemetry omits correlation fields when the capture cannot report them", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    let heartbeatOptions;
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      signalProcess,
      exit: jest.fn(),
      createOrderV2Capture: noopOrderV2Capture,
      createHealthMonitor: () => ({ start: jest.fn(), stop: jest.fn(), getStats: () => ({ eventLoopHealthy: true }) }),
      createHeartbeat: (options) => {
        heartbeatOptions = options;
        return { start: jest.fn(), stop: jest.fn() };
      },
    }));
    await driveToChannelOpened(connection);
    expect(heartbeatOptions.collect()).not.toHaveProperty("orderV2PendingFrames");
    signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1]();
    await runPromise;
  });

  test("a health-monitor startup failure tears down the subscribed connection instead of escaping main", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const exit = jest.fn();
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createHealthMonitor: () => {
        throw new Error("monitor unavailable");
      },
      exit,
    }));
    await driveToChannelOpened(connection);
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.close).toHaveBeenCalledTimes(1);
  });

  test("on success, subscribes Quote/Trade/Order/TimeAndSale/Candle for every instrument and logs a running banner", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, logger }));
    await driveToChannelOpened(connection);
    expect(connection.channel.sent).toEqual([
      { type: "FEED_SETUP", acceptDataFormat: "FULL" },
      expect.objectContaining({ type: "FEED_SUBSCRIPTION" }),
    ]);
    expect(connection.channel.sent[1].add).toHaveLength(25);
    expect(logger.banner).toHaveBeenCalled();
    expect(logger.ok).toHaveBeenCalledWith("running, capturing all known instruments", expect.any(Object));
    void runPromise;
  });

  test("routes raw, full-precision Order envelopes into the dedicated L2 table through the connector capture seam", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage: jest.fn(),
    };
    let captureOptions;
    const createOrderV2Capture = jest.fn((options) => {
      captureOptions = options;
      return capture;
    });
    const createConnection = jest.fn(() => connection);
    const runPromise = main(baseOptions({ createConnection, createStorageService: () => storageService, createOrderV2Capture }));
    await driveToChannelOpened(connection);

    expect(capture.setChannelId).toHaveBeenCalledWith(1);
    expect(createConnection).toHaveBeenCalledWith(config, { createConnector: capture.createConnector });
    captureOptions.onEnvelopes([{
      provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME", eventType: "ORDER",
      eventTime: new Date(1787601599000).toISOString(), receivedAt: new Date(NOW_MS).toISOString(), timingClass: "REALTIME",
      stale: false, recoveryState: "READY",
      payload: {
        index: "5137554220647461001", eventFlags: 12, time: 1787601599000, action: "NEW", actionTime: null,
        orderId: null, price: 29139.75, size: 1, side: "BUY", scope: "ORDER", source: "GLBX", marketMaker: null,
      },
    }]);
    expect(storageService.handleOrderV2Envelopes).toHaveBeenCalledWith([expect.objectContaining({
      payload: expect.objectContaining({ index: "5137554220647461001" }),
    })]);
    expect(capture.handleChannelMessage).not.toHaveBeenCalled();
    void runPromise;
  });

  test("a degraded (UNAVAILABLE-state) Order-v2 envelope throws with its actual reason and missing fields, not a bare symbol", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    let captureOptions;
    const createOrderV2Capture = jest.fn((options) => {
      captureOptions = options;
      return capture;
    });
    const runPromise = main(baseOptions({
      createConnection: () => connection, createStorageService: () => storageService, createOrderV2Capture,
    }));
    await driveToChannelOpened(connection);

    expect(() => captureOptions.onEnvelopes([{
      provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME", eventType: "ORDER",
      receivedAt: new Date(NOW_MS).toISOString(), timingClass: "REALTIME", stale: false, recoveryState: "READY",
      state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD", missingFields: ["time", "side"],
    }])).toThrow(/\/NQZ26:XCME.*MISSING_OR_INVALID_REQUIRED_FIELD.*missingFields=\["time","side"\]/);
    expect(storageService.handleOrderV2Envelopes).not.toHaveBeenCalled();
    void runPromise;
  });

  test("an Order-v2 envelope for a symbol with no collector context throws a distinct, specific message", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    let captureOptions;
    const createOrderV2Capture = jest.fn((options) => {
      captureOptions = options;
      return capture;
    });
    const runPromise = main(baseOptions({
      createConnection: () => connection, createStorageService: () => storageService, createOrderV2Capture,
    }));
    await driveToChannelOpened(connection);

    expect(() => captureOptions.onEnvelopes([{
      provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/UNKNOWN:XCME", eventType: "ORDER",
      receivedAt: new Date(NOW_MS).toISOString(), timingClass: "REALTIME", stale: false, recoveryState: "READY",
      payload: {
        index: "1", eventFlags: 0, time: NOW_MS, action: "NEW", actionTime: null,
        orderId: null, price: 1, size: 1, side: "BUY", scope: "ORDER", source: "GLBX", marketMaker: null,
      },
    }])).toThrow(/\/UNKNOWN:XCME: no collector context for this cell/);
    expect(storageService.handleOrderV2Envelopes).not.toHaveBeenCalled();
    void runPromise;
  });

  test("full orchestration persists through the real normalizer and real SQLite storage service, not just fakes", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath, bootstrap: true }).close();
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: createDxFeedStorageService,
      createOrderV2Capture: () => ({
        createConnector: jest.fn(),
        setChannelId: jest.fn(),
        handleChannelMessage: jest.fn(),
      }),
      dbPath,
      signalProcess,
      exit,
    }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: fullCoverageEvents() });

    const sigintHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1];
    sigintHandler();
    await runPromise;

    expect(exit).toHaveBeenCalledWith(130);
    const reader = createDxFeedStorageReader({ dbPath });
    expect(reader.countAll()).toEqual({ quotes: 5, trades: 5, orderBookCapture: 0, timeAndSales: 0, candles: 0 });
    for (const { symbol, assetClass } of listCollectorInstruments()) {
      for (const eventType of [EVENT_TYPES.QUOTE, EVENT_TYPES.TRADE]) {
        const result = reader.readRecent(symbol, assetClass, eventType, { limit: 1 });
        expect(result.available).toBe(true);
        expect(result.rows).toHaveLength(1);
      }
    }
    reader.close();
    removeDbFiles(dbPath);
  });

  test("a healthy Quote/Trade/Order event is normalized and stored", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "TSLA" }],
    });
    expect(storageService.handleEnvelope).toHaveBeenCalledTimes(1);
    expect(storageService.handled[0].providerSymbol).toBe("TSLA");
    void runPromise;
  });

  test("an event for an unsubscribed symbol/type is ignored, not passed to storage", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "MSFT" }] });
    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    void runPromise;
  });

  test("an Order event from the wrong source is ignored", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{
        eventType: "Order", eventSymbol: "TSLA", eventFlags: 0, index: null, time: 1787601599000,
        source: "WRONG_SOURCE", action: "NEW", orderId: 0, price: 100, size: 1, side: "BUY", scope: "ORDER",
      }],
    });
    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    void runPromise;
  });

  test("a structural Order removal is filtered from the legacy canonical path, not counted as a degraded skip", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger, createOrderV2Capture: noopOrderV2Capture }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{
        eventType: "Order", eventSymbol: "TSLA", eventFlags: 2, index: 1, time: 1787601599000,
        source: "NTV", action: "REMOVE", price: "NaN", size: "NaN", side: "UNDEFINED", scope: "ORDER",
      }],
    });
    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    expect(storageService.getCounters().skipped).toBe(0);
    expect(logger.warn).not.toHaveBeenCalledWith("degraded envelope, not stored", expect.any(Object));
    void runPromise;
  });

  test("a structural Order removal carrying a complete order state is still filtered, never stored as a live order row", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, createOrderV2Capture: noopOrderV2Capture }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{
        eventType: "Order", eventSymbol: "TSLA", eventFlags: 2, index: 1, time: 1787601599000,
        source: "NTV", action: "REMOVE", orderId: 0, price: 100, size: 1, side: "BUY", scope: "ORDER",
      }],
    });
    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    void runPromise;
  });

  // L1L2-V2-039. Order events now feed ONLY the exact-index capture path, which
  // runs off the raw frame in orderV2Capture.handleChannelMessage. The generic
  // path used to normalize and store them a second time into dxfeed_orders --
  // a strictly lossier duplicate of dxfeed_order_book_capture. With capture
  // stubbed out here, an Order event should reach storage not at all.
  test("an Order event is filtered out of the generic path entirely, capture being its only route", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, createOrderV2Capture: noopOrderV2Capture }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{
        eventType: "Order", eventSymbol: "TSLA", eventFlags: 0, index: 1, time: 1787601599000,
        source: "NTV", action: "NEW", orderId: 0, price: 100, size: 1, side: "BUY", scope: "ORDER",
      }],
    });
    expect(storageService.handleEnvelope).not.toHaveBeenCalled();
    expect(storageService.handled).toHaveLength(0);
    void runPromise;
  });

  test("a degraded normalization result is counted as skipped, logged once, and does not stop the collector", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Trade", eventSymbol: "TSLA", time: 1787601599905 }], // missing required Trade fields
    });
    expect(storageService.handleEnvelope).toHaveBeenCalledTimes(1);
    expect(storageService.getCounters().skipped).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("degraded envelope, not stored", expect.any(Object));
    expect(connection.disconnect).not.toHaveBeenCalled();
    void runPromise;
  });

  test("a healthy canonical envelope rejected by storage is an internal contract failure and stops the collector", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    storageService.handleEnvelope.mockReturnValue(false);
    const logger = noopLogger();
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger, exit }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "TSLA" }] });
    await runPromise;
    expect(logger.error).toHaveBeenCalledWith("failed to normalize or store a dxFeed event batch", expect.any(Object));
    expect(exit).toHaveBeenCalledWith(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a thrown normalization/storage error stops the collector, exit 1", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    storageService.handleEnvelope.mockImplementation(() => {
      throw new Error("storage boom");
    });
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, exit }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "TSLA" }] });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.close).toHaveBeenCalledTimes(1);
  });

  test("an oversized provider batch fails closed before raw correlation, normalization, or storage work", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({
      createConnection: () => connection,
      createStorageService: () => storageService,
      createOrderV2Capture: () => capture,
      exit,
    }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: Array.from({ length: 2_001 }, () => ({})) });
    await runPromise;
    expect(capture.handleChannelMessage).not.toHaveBeenCalled();
    expect(storageService.handleEnvelopes).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a persistent capacity breach fails closed and closes durable storage", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const exit = jest.fn();
      const guard = {
        observe: jest.fn(() => ({ breached: true, shouldStop: true, reason: "disk reserve exhausted", breachDurationMs: 30_000 })),
        getStats: jest.fn(() => ({ capacityBreached: true, capacityLastBreachReason: "disk reserve exhausted" })),
      };
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        createCapacityGuard: () => guard,
        exit,
      }));
      await driveToChannelOpened(connection);
      await jest.advanceTimersByTimeAsync(1_000);
      await runPromise;
      expect(exit).toHaveBeenCalledWith(78);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(storageService.close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("main -- candle aggregation (DX3.11)", () => {
  test("persists a completed non-empty TimeAndSale minute after the finality watermark even when the market goes quiet", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      let currentNowMs = NOW_MS;
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const signalProcess = { on: jest.fn(), off: jest.fn() };
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        signalProcess,
        now: () => currentNowMs,
      }));
      await driveToChannelOpened(connection);
      connection.channel.emitMessage({
        type: "FEED_DATA",
        data: [{ ...REAL_FUTURE_TIME_AND_SALE, time: NOW_MS, price: 100, size: 10, aggressorSide: "BUY", sequence: 1 }],
      });
      expect(storageService.recordCandle).not.toHaveBeenCalled();

      currentNowMs += 62_000;
      await jest.advanceTimersByTimeAsync(1_000);

      expect(storageService.recordCandle).toHaveBeenCalledTimes(1);
      expect(storageService.recordCandle).toHaveBeenCalledWith(
        "/NQZ26:XCME", "FUTURE", expect.objectContaining({ ts_open: NOW_MS, closed: true, volume: 10 }),
      );
      signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1]();
      await runPromise;
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  describe("native dxFeed candles", () => {
    const MINUTE = 1_787_601_540_000;
    const nativeCandle = (overrides = {}) => ({
      eventType: "Candle", eventSymbol: "TSLA{=m}", time: MINUTE,
      open: 349, high: 349.5, low: 348.8, close: 349.2, volume: 1_000, askVolume: 600, bidVolume: 300, count: 40,
      ...overrides,
    });

    test("an empty candle for a minute without trading is skipped and capture carries on", async () => {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const logger = noopLogger();
      const exit = jest.fn();
      const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger, exit }));
      await driveToChannelOpened(connection);
      connection.channel.emitMessage({ type: "FEED_DATA", data: [nativeCandle({ open: "NaN", high: "NaN", low: "NaN", close: "NaN", volume: 0, askVolume: "NaN", bidVolume: "NaN", count: 0 })] });
      connection.channel.emitMessage({ type: "FEED_DATA", data: [REAL_EQUITY_TIME_AND_SALE] });
      expect(logger.error).not.toHaveBeenCalledWith("failed to normalize or store a dxFeed event batch", expect.anything());
      expect(logger.warn).not.toHaveBeenCalledWith("native candle rejected, not stored", expect.anything());
      expect(exit).not.toHaveBeenCalled();
      expect(storageService.getCounters().timeAndSales).toBe(1);
      expect(storageService.recordCandle).not.toHaveBeenCalled();
      void runPromise;
    });

    test("a malformed candle is reported once and skipped, and never stops trade and book capture", async () => {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const logger = noopLogger();
      const exit = jest.fn();
      const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger, exit }));
      await driveToChannelOpened(connection);
      connection.channel.emitMessage({ type: "FEED_DATA", data: [nativeCandle({ open: "NaN" })] });
      connection.channel.emitMessage({ type: "FEED_DATA", data: [nativeCandle({ time: MINUTE + 60_000, open: "NaN" })] });
      connection.channel.emitMessage({ type: "FEED_DATA", data: [REAL_EQUITY_TIME_AND_SALE] });
      expect(logger.warn.mock.calls.filter(([message]) => message === "native candle rejected, not stored")).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith("native candle rejected, not stored", expect.objectContaining({ symbol: "TSLA", reason: expect.stringContaining("open must be positive and finite") }));
      expect(exit).not.toHaveBeenCalled();
      expect(storageService.getCounters().timeAndSales).toBe(1);
      expect(storageService.recordCandle).not.toHaveBeenCalled();
      void runPromise;
    });

    test("a native minute is persisted once the next minute arrives, marked NATIVE", async () => {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
      await driveToChannelOpened(connection);
      connection.channel.emitMessage({ type: "FEED_DATA", data: [nativeCandle()] });
      expect(storageService.recordCandle).not.toHaveBeenCalled();
      connection.channel.emitMessage({ type: "FEED_DATA", data: [nativeCandle({ time: MINUTE + 60_000 })] });
      expect(storageService.recordCandle).toHaveBeenCalledWith(
        "TSLA", "EQUITY", expect.objectContaining({ ts_open: MINUTE, buy_volume: 600, sell_volume: 300, volume: 1_000 }), { derivation: "NATIVE" },
      );
      void runPromise;
    });
  });

  test("futures TimeAndSale is stored and is the source of persisted futures candles", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_FUTURE_TIME_AND_SALE, time: 1787601599905, price: 100, size: 10, aggressorSide: "BUY", sequence: 1 }],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_FUTURE_TIME_AND_SALE, time: 1787601599905 + 60_000, price: 200, size: 1, sequence: 2 }],
    });
    expect(storageService.getCounters().timeAndSales).toBe(2);
    expect(storageService.recordCandle).toHaveBeenCalledTimes(1);
    expect(storageService.recordCandle.mock.calls[0]).toEqual([
      "/NQZ26:XCME",
      "FUTURE",
      expect.objectContaining({ open: 100, close: 100, volume: 10, buy_volume: 10, closed: true }),
    ]);
    void runPromise;
  });

  test("the conflated futures Trade ticker is stored but never used for futures candles", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TRADE, eventSymbol: "/NQZ26:XCME" }],
    });
    expect(storageService.getCounters().trades).toBe(1);
    expect(storageService.recordCandle).not.toHaveBeenCalled();
    void runPromise;
  });

  test("TimeAndSale corrections and invalid ticks are preserved raw but excluded from candles", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [
        { ...REAL_FUTURE_TIME_AND_SALE, type: "CORRECTION", tradeId: 42 },
        { ...REAL_FUTURE_TIME_AND_SALE, validTick: false, sequence: 66861 },
      ],
    });
    expect(storageService.getCounters().timeAndSales).toBe(2);
    expect(storageService.recordCandle).not.toHaveBeenCalled();
    void runPromise;
  });

  test("an equity TimeAndSale event within the same minute updates the live bar without persisting a candle yet", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905, validTick: true }],
    });
    expect(storageService.recordCandle).not.toHaveBeenCalled();
    void runPromise;
  });

  test("invalid equity ticks are preserved raw but never create a candle", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905, price: 100, size: 10, aggressorSide: "BUY", validTick: false }],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905 + 60_000, price: 200, size: 1, sequence: 601003, validTick: false }],
    });
    expect(storageService.handleEnvelope).toHaveBeenCalledTimes(2);
    expect(storageService.recordCandle).not.toHaveBeenCalled();
    void runPromise;
  });

  test("persists a native candle only after its successor proves the minute closed", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    const candle = {
      eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_787_601_540_000,
      open: 225, high: 226, low: 224, close: 225.5, volume: 100, askVolume: 40, bidVolume: 50, count: 8,
    };
    connection.channel.emitMessage({ type: "FEED_DATA", data: [candle] });
    expect(storageService.recordCandle).not.toHaveBeenCalled();
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{
      ...candle, time: candle.time + 60_000, open: 225.5, high: 227, low: 225, close: 226,
    }] });
    expect(storageService.recordCandle).toHaveBeenCalledWith(
      "AAPL",
      "EQUITY",
      expect.objectContaining({ ts_open: candle.time, buy_volume: 40, sell_volume: 50 }),
      { derivation: "NATIVE" },
    );
    void runPromise;
  });

  test("valid equity ticks crossing a minute persist the prior closed candle", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905, price: 100, size: 10, aggressorSide: "BUY", validTick: true }],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905 + 60_000, price: 200, size: 1, sequence: 601003, validTick: true }],
    });
    expect(storageService.recordCandle).toHaveBeenCalledTimes(1);
    expect(storageService.recordCandle.mock.calls[0]).toEqual([
      "TSLA", "EQUITY", expect.objectContaining({ open: 100, close: 100, volume: 10, buy_volume: 10, closed: true }),
    ]);
    void runPromise;
  });

  test("an UNDEFINED aggressorSide remains in OHLCV while directional volume becomes unavailable", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, aggressorSide: "UNDEFINED", validTick: true }],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: REAL_EQUITY_TIME_AND_SALE.time + 60_000, sequence: REAL_EQUITY_TIME_AND_SALE.sequence + 1, validTick: true }],
    });
    expect(storageService.handleEnvelope).toHaveBeenCalledTimes(2);
    expect(storageService.recordCandle).toHaveBeenCalledTimes(1);
    expect(storageService.recordCandle.mock.calls[0][2]).toMatchObject({ volume: REAL_EQUITY_TIME_AND_SALE.size, buy_volume: null });
    expect(logger.error).not.toHaveBeenCalled();
    expect(connection.disconnect).not.toHaveBeenCalled();
    void runPromise;
  });

  test("a recordCandle failure stops the collector instead of silently creating a durable bar gap", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    storageService.recordCandle.mockImplementation(() => {
      throw new Error("disk full");
    });
    const logger = noopLogger();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService, logger }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905, validTick: true }],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905 + 60_000, sequence: 601003, validTick: true }],
    });
    await runPromise;
    expect(logger.error).toHaveBeenCalledWith(
      "failed to normalize or store a dxFeed event batch",
      expect.objectContaining({ reason: "disk full" }),
    );
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  test("two symbols aggregate independently, each closing its own candle on its own schedule", async () => {
    const connection = fakeConnection();
    const storageService = fakeStorageService();
    const runPromise = main(baseOptions({ createConnection: () => connection, createStorageService: () => storageService }));
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [
        { ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905, validTick: true },
        { ...REAL_EQUITY_TIME_AND_SALE, eventSymbol: "AAPL", time: 1787601599905, sequence: 701002, validTick: true },
      ],
    });
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...REAL_EQUITY_TIME_AND_SALE, time: 1787601599905 + 60_000, sequence: 601003, validTick: true }],
    });
    expect(storageService.recordCandle).toHaveBeenCalledTimes(1);
    expect(storageService.recordCandle.mock.calls[0][0]).toBe("TSLA");
    void runPromise;
  });
});

describe("main -- shutdown paths", () => {
  test("SIGINT stops the collector cleanly with exit 130", async () => {
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, signalProcess, exit }));
    await driveToChannelOpened(connection);
    const sigintHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1];
    sigintHandler();
    await runPromise;
    expect(exit).toHaveBeenCalledWith(130);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  test("SIGTERM stops the collector cleanly with exit 143", async () => {
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, signalProcess, exit }));
    await driveToChannelOpened(connection);
    const sigtermHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGTERM")[1];
    sigtermHandler();
    await runPromise;
    expect(exit).toHaveBeenCalledWith(143);
  });

  test("unsubscribes the signal handlers on shutdown so a later external signal cannot double-fire cleanup", async () => {
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, signalProcess, exit }));
    await driveToChannelOpened(connection);
    const sigintHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1];
    sigintHandler();
    await runPromise;
    expect(signalProcess.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(signalProcess.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("the deadline timer performs a planned rotation exit, unsubscribing before disconnecting", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const exit = jest.fn();
      const logger = noopLogger();
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString(); // ~20ms of real runway
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
        exit,
        logger,
      }));
      await driveToChannelOpened(connection);
      await jest.advanceTimersByTimeAsync(20);
      await runPromise;
      expect(exit).toHaveBeenCalledWith(PLANNED_ROTATION_EXIT_CODE);
      expect(connection.channel.sent.some((payload) => Array.isArray(payload.remove))).toBe(true);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("planned token rotation window reached"),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("a planned rotation records DEGRADED, not HEALTHY, when canonical feed cells degraded during the session", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString();
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
      }));
      await driveToChannelOpened(connection);
      connection.channel.emitMessage({
        type: "FEED_DATA",
        data: [{ eventType: "Trade", eventSymbol: "TSLA", time: 1787601599905 }],
      });
      await jest.advanceTimersByTimeAsync(20);
      await runPromise;
      expect(storageService.finishCaptureSession).toHaveBeenCalledWith(expect.objectContaining({
        quality: "DEGRADED", cleanShutdown: true,
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a busy WAL checkpoint is retained as session evidence and degrades an otherwise clean planned rotation", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      let checkpointOptions;
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString();
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        createCheckpoint: (options) => {
          checkpointOptions = options;
          return fakeCheckpoint();
        },
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
      }));
      await driveToChannelOpened(connection);
      checkpointOptions.onResult({ mode: "PASSIVE", busy: 1, logFrames: 400, checkpointedFrames: 250 });
      await jest.advanceTimersByTimeAsync(20);
      await runPromise;
      expect(storageService.finishCaptureSession).toHaveBeenCalledWith(expect.objectContaining({
        quality: "DEGRADED", cleanShutdown: true,
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a clean deadline self-termination still exits 1 if disconnect() fails during cleanup -- a failed cleanup is not a clean stop", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      connection.disconnect.mockImplementation(() => {
        throw new Error("disconnect boom");
      });
      const exit = jest.fn();
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString();
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
        exit,
      }));
      await driveToChannelOpened(connection);
      await jest.advanceTimersByTimeAsync(20);
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await runPromise;
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a clean deadline self-termination still exits 1 if storage close() fails during cleanup", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const storageService = fakeStorageService();
      storageService.close.mockImplementation(() => {
        throw new Error("close boom");
      });
      const exit = jest.fn();
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString();
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
        exit,
      }));
      await driveToChannelOpened(connection);
      await jest.advanceTimersByTimeAsync(20);
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await runPromise;
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a clean deadline self-termination exits 1 if FEED unsubscribe fails while still closing every resource", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      connection.channel.send.mockImplementation((payload) => {
        if (Array.isArray(payload.remove)) throw new Error("unsubscribe boom");
        connection.channel.sent.push(payload);
      });
      const storageService = fakeStorageService();
      const exit = jest.fn();
      const almostDue = new Date(NOW_MS + SHUTDOWN_MARGIN_MS + 20).toISOString();
      const runPromise = main(baseOptions({
        createConnection: () => connection,
        createStorageService: () => storageService,
        env: { DXFEED_TOKEN_EXPIRES_AT: almostDue },
        exit,
      }));
      await driveToChannelOpened(connection);
      await jest.advanceTimersByTimeAsync(20);
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await runPromise;
      expect(exit).toHaveBeenCalledWith(1);
      expect(connection.channel.close).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(storageService.close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a fatal error after shutdown has already started does not attempt a second cleanup pass", async () => {
    const connection = fakeConnection();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const exit = jest.fn();
    const runPromise = main(baseOptions({ createConnection: () => connection, signalProcess, exit }));
    await driveToChannelOpened(connection);
    const sigintHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1];
    sigintHandler();
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
    await runPromise;
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("main -- planned token rotation", () => {
  test("ends the authenticated session at the safety deadline without requesting a second AUTH", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const exit = jest.fn();
      const runPromise = main(baseOptions({ createConnection: () => connection, exit }));
      await driveToChannelOpened(connection);

      await jest.advanceTimersByTimeAsync(25 * 60_000);
      await runPromise;

      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(PLANNED_ROTATION_EXIT_CODE);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the deadline has not fired one minute before the safety margin, and an unrelated error still shuts down cleanly", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const runPromise = main(baseOptions({ createConnection: () => connection }));
      await driveToChannelOpened(connection);

      await jest.advanceTimersByTimeAsync(24 * 60_000);
      expect(connection.disconnect).not.toHaveBeenCalled();
      connection.emitError(new Error("stop test collector"));
      await runPromise;
    } finally {
      jest.useRealTimers();
    }
  });
});

// A2.21 closure audit, Pattern G (untraced consumers after a fix). Retiring the
// generic Order write path (L1L2-V2-039) left the collector's liveness
// heartbeat watching `orders` -- a counter that can now never move again --
// while `orderBookCapture`, which became the ONLY Order path and feeds the L2
// book, was watched by nothing. hasNonZeroDelta uses .some(), so a dead key
// could not raise a false stall; the real defect was the opposite, a stalled
// capture path reporting nominal because quotes and trades were still flowing.
describe("collector liveness keys", () => {
  const { HEARTBEAT_ACTIVITY_KEYS } = require("../../../scripts/collect/run-dxfeed-collector");

  test("watches the capture path that actually carries Order data", () => {
    expect(HEARTBEAT_ACTIVITY_KEYS).toContain("orderBookCapture");
  });

  test("no longer watches the retired generic Order counter", () => {
    expect(HEARTBEAT_ACTIVITY_KEYS).not.toContain("orders");
  });

  test("still watches every other durable stream, so this narrowed nothing", () => {
    for (const key of ["quotes", "trades", "timeAndSales"]) {
      expect(HEARTBEAT_ACTIVITY_KEYS).toContain(key);
    }
  });
});
