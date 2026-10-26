const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageService } = require("../../src/storage/storage-service");
const { createBinanceConnection } = require("../../src/providers/binance/binance-connection");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function createFakeConnection() {
  const listeners = new Set();
  let depthSnapshot = null;
  return {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOrderBook() {
      // storage-service's DEPTH handling must never call this -- archival is
      // unconditional and doesn't depend on book-assembler readiness. Present
      // only so a regression test can assert it's never invoked.
      throw new Error("storage-service must not call getOrderBook() -- archival is unconditional");
    },
    getDepthSnapshot() {
      return depthSnapshot;
    },
    setDepthSnapshot(snapshot) {
      depthSnapshot = snapshot;
    },
    emit(envelope) {
      for (const listener of [...listeners]) listener(envelope);
    },
  };
}

function tradeEnvelope(overrides = {}) {
  return Object.freeze({
    provider: "BINANCE", venue: "BINANCE", marketKind: "SPOT", providerSymbol: "BTCUSDT", eventType: "TRADE",
    eventTime: "2024-01-01T00:00:00.000Z", receivedAt: "2024-01-01T00:00:00.000Z", timingClass: "REALTIME",
    stale: false, recoveryState: "READY",
    payload: Object.freeze({ tradeId: 1, price: "100", quantity: "1", isBuyerMaker: false }),
    ...overrides,
  });
}

function klineEnvelope(overrides = {}) {
  return Object.freeze({
    provider: "BINANCE", venue: "BINANCE", marketKind: "SPOT", providerSymbol: "BTCUSDT", eventType: "KLINE",
    eventTime: "2024-01-01T00:01:00.000Z", receivedAt: "2024-01-01T00:01:00.000Z", timingClass: "REALTIME",
    stale: false, recoveryState: "READY",
    payload: Object.freeze({
      interval: "1m", openTime: 60_000, closeTime: 119_999, open: "100", high: "105", low: "95", close: "102",
      baseVolume: "10", quoteVolume: "1000", takerBuyBaseVolume: "5", takerBuyQuoteVolume: "500",
      numberOfTrades: 4, isClosed: true,
    }),
    ...overrides,
  });
}

function depthEnvelope(overrides = {}) {
  return Object.freeze({
    provider: "BINANCE", venue: "BINANCE", marketKind: "SPOT", providerSymbol: "BTCUSDT", eventType: "DEPTH",
    eventTime: "2024-01-01T00:00:00.000Z", receivedAt: "2024-01-01T00:00:00.100Z", timingClass: "REALTIME",
    stale: false, recoveryState: "READY",
    payload: Object.freeze({
      firstUpdateId: 100, lastUpdateId: 105, previousUpdateId: null,
      bids: Object.freeze([["99.00", "5"]]), asks: Object.freeze([["101.00", "3"]]),
    }),
    ...overrides,
  });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function readTable(dbPath, table) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  db.close();
  return rows;
}

describe("createStorageService", () => {
  let dbPath;

  afterEach(() => {
    if (dbPath && fs.existsSync(dbPath)) {
      safeRm(dbPath, { force: true });
    }
    if (dbPath && fs.existsSync(`${dbPath}.lock`)) {
      safeRm(`${dbPath}.lock`, { force: true });
    }
  });

  test("getStorageDb() exposes the live raw handle while started, and null before start()/after stop()", () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });

    expect(service.getStorageDb()).toBeNull();
    service.start();
    expect(service.getStorageDb()?.raw).toBeDefined();
    service.stop();
    expect(service.getStorageDb()).toBeNull();
  });

  test("a TRADE envelope is written to the trades table", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(tradeEnvelope());
    await flush();
    expect(service.getStats()).toMatchObject({ trades: 1, candles: 0, depthEvents: 0, depthSnapshots: 0, rejected: 0 });
    service.stop();

    const rows = readTable(dbPath, "trades");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "BTCUSDT", market_kind: "SPOT", price: "100", size: "1", side: "buy", trade_id: "1" });
  });



  test("moves listener work into a bounded ingress queue and flushes accepted envelopes before stopping", () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath, ingressDrainBatchSize: 1 });
    service.start();

    connection.emit(tradeEnvelope());
    connection.emit(tradeEnvelope({ payload: { tradeId: 2, price: "101", quantity: "1", isBuyerMaker: false } }));

    expect(service.getStats()).toMatchObject({ trades: 0, pendingIngressEnvelopes: 2 });
    service.stop();

    expect(readTable(dbPath, "trades").map((row) => row.trade_id)).toEqual(["1", "2"]);
  });

  test("detects trade-id discontinuity and emits a counted integrity incident", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    let service;
    const telemetry = jest.fn((entry) => service?.recordIncident(entry));
    service = createStorageService({ connection, dbPath, telemetry });
    service.start();

    connection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId: 10, price: "100", quantity: "1", isBuyerMaker: false }) }));
    connection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId: 13, price: "100", quantity: "1", isBuyerMaker: false }) }));
    await flush();

    expect(service.getStats()).toMatchObject({ tradeIdGaps: 1, missingTradeIds: 2 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      event: "storage.trade_id_gap",
      previousTradeId: 10,
      currentTradeId: 13,
      missingCount: 2,
    }));
    service.setCaptureOutcome({ quality: "INVALID", cleanShutdown: true, terminationReason: "test gap" });
    service.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT severity, event, affected_count FROM capture_incidents").get()).toEqual({
      severity: "DEGRADED",
      event: "storage.trade_id_gap",
      affected_count: 2,
    });
    expect(db.prepare("SELECT quality, clean_shutdown, termination_reason FROM capture_sessions").get()).toEqual({
      quality: "INVALID",
      clean_shutdown: 1,
      termination_reason: "test gap",
    });
    db.close();
  });

  test.each([
    "market_data.binance_backpressure.queue_overflow",
    "market_data.binance_raw_ingress.queue_overflow",
  ])("records a queue overflow as an invalidating incident with its exact dropped count (%s)", (event) => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    expect(service.recordIncident({
      event,
      ts: "2026-08-23T13:18:30.000Z",
      marketKind: "PERPETUAL",
      route: "public",
      symbol: "ETHUSDT",
      eventType: "TRADE",
      droppedCount: 1,
      queueDepth: 50_000,
      queueBytes: 48 * 1024 * 1024,
      incomingBytes: 512,
      limitKind: "DEPTH",
    })).toBe(true);
    service.setCaptureOutcome({ quality: "INVALID", cleanShutdown: true, terminationReason: "test overflow" });
    service.stop();

    const db = new Database(dbPath, { readonly: true });
    const incident = db.prepare("SELECT severity, affected_count, details FROM capture_incidents").get();
    expect(incident.severity).toBe("INVALID");
    expect(incident.affected_count).toBe(1);
    expect(JSON.parse(incident.details)).toMatchObject({
      droppedCount: 1,
      queueDepth: 50_000,
      queueBytes: 48 * 1024 * 1024,
      incomingBytes: 512,
      limitKind: "DEPTH",
    });
    db.close();
  });

  test("records compact collector-pressure context without turning a recoverable pressure window into an invalid capture", () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    expect(service.recordIncident({
      event: "collector.capacity_pressure_opened",
      severity: "DEGRADED",
      ts: "2026-08-24T10:00:00.000Z",
      details: {
        reason: "market-data backlog exceeded 40000 events",
        pendingIngressEnvelopes: 2_000,
        backpressurePending: 40_001,
      },
    })).toBe(true);
    service.setCaptureOutcome({ quality: "DEGRADED", cleanShutdown: true, terminationReason: "test pressure" });
    service.stop();

    const db = new Database(dbPath, { readonly: true });
    const incident = db.prepare("SELECT severity, details FROM capture_incidents").get();
    expect(incident.severity).toBe("DEGRADED");
    expect(JSON.parse(incident.details)).toMatchObject({
      reason: "market-data backlog exceeded 40000 events",
      pendingIngressEnvelopes: 2_000,
      backpressurePending: 40_001,
    });
    db.close();
  });

  test("a service restart reports a session-boundary coverage gap without blaming the new session", async () => {
    dbPath = tempDbPath();
    const firstConnection = createFakeConnection();
    const first = createStorageService({ connection: firstConnection, dbPath });
    first.start();
    firstConnection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId: 20, price: "100", quantity: "1", isBuyerMaker: false }) }));
    await flush();
    first.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true });
    first.stop();

    const secondConnection = createFakeConnection();
    const telemetry = jest.fn();
    const second = createStorageService({ connection: secondConnection, dbPath, telemetry });
    second.start();
    expect(second.getResumeState()).toMatchObject({
      hasExistingData: true,
      previousSessionCleanShutdown: true,
      previousSessionQuality: "HEALTHY",
      lastTradeAt: Date.parse("2024-01-01T00:00:00.000Z"),
    });
    secondConnection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId: 22, price: "100", quantity: "1", isBuyerMaker: false }) }));
    await flush();

    expect(second.getStats()).toMatchObject({
      tradeIdGaps: 0,
      missingTradeIds: 0,
      sessionBoundaryTradeIdGaps: 1,
      sessionBoundaryMissingTradeIds: 1,
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      event: "storage.trade_id_session_boundary_gap",
      missingCount: 1,
    }));
    second.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true });
    second.stop();
  });

  test("tracks perpetual provider trade-ID discontinuity separately from proven local loss", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const telemetry = jest.fn();
    const service = createStorageService({ connection, dbPath, telemetry });
    service.start();

    connection.emit(tradeEnvelope({
      marketKind: "PERPETUAL",
      payload: Object.freeze({ tradeId: 40, price: "100", quantity: "1", isBuyerMaker: false }),
    }));
    connection.emit(tradeEnvelope({
      marketKind: "PERPETUAL",
      payload: Object.freeze({ tradeId: 42, price: "100", quantity: "1", isBuyerMaker: false }),
    }));
    await flush();

    expect(service.getStats()).toMatchObject({
      tradeIdGaps: 0,
      missingTradeIds: 0,
      providerTradeIdDiscontinuities: 1,
      providerTradeIdSkippedIds: 1,
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      event: "storage.trade_id_provider_discontinuity",
      missingCount: 1,
    }));
    service.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true });
    service.stop();
  });

  test("worker mode durably flushes accepted envelopes before a clean shutdown resolves", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath, useWorker: true });
    service.start();
    await expect(service.whenReady()).resolves.toBeUndefined();
    connection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId: 900, price: "100", quantity: "1", isBuyerMaker: false }) }));
    service.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true, terminationReason: "test complete" });

    await service.stop();

    expect(readTable(dbPath, "trades")).toHaveLength(1);
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT quality, clean_shutdown FROM capture_sessions").get()).toEqual({
      quality: "HEALTHY",
      clean_shutdown: 1,
    });
    db.close();
  });

  test("worker mode preserves a sustained burst through ingress, batching, and durable shutdown", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath, useWorker: true });
    const tradeCount = 10_000;
    service.start();
    await expect(service.whenReady()).resolves.toBeUndefined();

    for (let tradeId = 1; tradeId <= tradeCount; tradeId += 1) {
      connection.emit(tradeEnvelope({
        payload: Object.freeze({
          tradeId,
          price: "100",
          quantity: "1",
          isBuyerMaker: tradeId % 2 === 0,
        }),
      }));
    }

    expect(service.getStats().pendingIngressEnvelopes).toBeGreaterThan(0);
    const beforeStop = service.getStats();
    expect(beforeStop.storageIngressHighWaterMark).toBe(tradeCount);
    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });
    service.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true, terminationReason: "burst complete" });
    const firstStop = service.stop();
    expect(service.stop()).toBe(firstStop);
    await firstStop;
    expect(eventLoopYielded).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trades").get().count).toBe(tradeCount);
    expect(db.prepare("SELECT MIN(CAST(trade_id AS INTEGER)) AS minimum, MAX(CAST(trade_id AS INTEGER)) AS maximum FROM trades").get()).toEqual({
      minimum: 1,
      maximum: tradeCount,
    });
    expect(db.prepare("SELECT quality, clean_shutdown FROM capture_sessions").get()).toEqual({
      quality: "HEALTHY",
      clean_shutdown: 1,
    });
    db.close();
  });

  test("preserves source-decimal text in storage instead of converting it through JavaScript Number", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(tradeEnvelope({
      payload: {
        tradeId: 1,
        price: "12345678901234567890.12345678901234567890",
        quantity: "0.000000000000000001",
        isBuyerMaker: false,
      },
    }));
    await flush();
    service.stop();

    const rows = readTable(dbPath, "trades");
    expect(rows[0]).toMatchObject({
      price: "12345678901234567890.12345678901234567890",
      size: "0.000000000000000001",
    });
  });

  test("a zero-price/zero-quantity perpetual trade (Binance's recurring X:\"NA\" marker, not a real trade) is rejected cleanly -- no row, no crash", async () => {
    // Confirmed live and via research during the collector-split work: ~1%
    // of PERPETUAL trade messages arrive with price:"0", quantity:"0",
    // X:"NA" -- a liquidation/ADL-adjacent marker, not a real trade. A real
    // trade can never have price 0, so decimalToFiniteNumber's positivity
    // check (inside tradeEnvelopeToFrame) rejects it; recordTrade's own
    // try/catch logs and drops it rather than writing a nonsense row or
    // letting the throw escape into the connection's listener loop.
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      connection.emit(
        tradeEnvelope({
          marketKind: "PERPETUAL",
          payload: { tradeId: 2, price: "0", quantity: "0", isBuyerMaker: false },
        }),
      ),
    ).not.toThrow();
    await flush();
    service.stop();
    errorSpy.mockRestore();

    expect(readTable(dbPath, "trades")).toHaveLength(0);
  });

  test("a still-open KLINE (isClosed: false) is not persisted -- only closed candles are", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, isClosed: false } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a closed KLINE outside the collector's 1-minute contract is rejected", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, interval: "5m", closeTime: 359_999 } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a closed KLINE is written to the candles table", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope());
    await flush();
    service.stop();

    const rows = readTable(dbPath, "candles");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "BTCUSDT", market_kind: "SPOT", open: "100", high: "105", low: "95", close: "102", volume: "10", quote_volume: "1000", taker_buy_base_volume: "5", taker_buy_quote_volume: "500", trade_count: 4 });
  });

  test("an internally inconsistent OHLC candle is rejected at the persistence boundary", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, high: "101", close: "102" } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("an off-grid one-minute candle is rejected before it can turn a database constraint into a fatal collector failure", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, openTime: 1, closeTime: 60_000 } }));
    await flush();
    expect(service.isHealthy()).toBe(true);
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test.each([
    ["a high below its low", { high: "94" }],
    ["an interval other than one minute", { interval: "5m" }],
  ])("a KLINE with %s is rejected at the persistence boundary", async (_label, change) => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, ...change } }));
    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, openTime: 120_000, closeTime: 179_999 } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles").map((row) => row.ts_open)).toEqual([120_000]);
  });

  test.each([
    ["a last update id before its first", { firstUpdateId: 105, lastUpdateId: 100 }],
    ["a spot event naming a previous update id, which spot depth never carries", { previousUpdateId: 99 }],
  ])("a DEPTH event with %s is rejected at the persistence boundary", async (_label, change) => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, ...change } }));
    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, firstUpdateId: 106, lastUpdateId: 110 } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "l2_depth_events").map((row) => row.first_update_id)).toEqual([106]);
  });

  test("a late trade id behind the newest one keeps the newest as the continuity mark, so no false gap follows", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const telemetry = jest.fn();
    const service = createStorageService({ connection, dbPath, telemetry });
    service.start();

    for (const tradeId of [10, 5, 11]) {
      connection.emit(tradeEnvelope({ payload: Object.freeze({ tradeId, price: "100", quantity: "1", isBuyerMaker: false }) }));
    }
    await flush();
    service.stop();

    expect(service.getStats()).toMatchObject({ tradeIdGaps: 0, missingTradeIds: 0 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ event: "storage.trade_id_non_monotonic", previousTradeId: 10, currentTradeId: 5 }));
  });

  test("a KLINE with taker-buy volume greater than the bar's own volume is rejected at the persistence boundary", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, takerBuyBaseVolume: "10.0001", baseVolume: "10" } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a KLINE with taker-buy quote volume greater than quote volume is rejected at the persistence boundary", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, takerBuyQuoteVolume: "1000.0001", quoteVolume: "1000" } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a KLINE with taker-buy volume exactly equal to the bar's own volume is accepted -- the all-buy boundary", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, takerBuyBaseVolume: "10", baseVolume: "10" } }));
    await flush();
    service.stop();

    const rows = readTable(dbPath, "candles");
    expect(rows).toHaveLength(1);
    expect(rows[0].taker_buy_base_volume).toBe("10");
  });

  test("a KLINE with a negative taker-buy volume is rejected", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, takerBuyBaseVolume: "-1" } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a KLINE with a non-numeric taker-buy volume is rejected, not silently coerced", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(klineEnvelope({ payload: { ...klineEnvelope().payload, takerBuyBaseVolume: "abc" } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "candles")).toHaveLength(0);
  });

  test("a degraded envelope (state: UNAVAILABLE, no payload) is ignored, not a crash", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    expect(() => connection.emit(Object.freeze({ marketKind: "SPOT", providerSymbol: "BTCUSDT", eventType: "TRADE", state: "UNAVAILABLE", reason: "MALFORMED_RAW_MESSAGE" }))).not.toThrow();
    await flush();
    service.stop();

    expect(readTable(dbPath, "trades")).toHaveLength(0);
  });

  test("a DEPTH envelope is archived to l2_depth_events exactly as received, raw and unconverted", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope());
    await flush();
    service.stop();

    const rows = readTable(dbPath, "l2_depth_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "BTCUSDT", market_kind: "SPOT",
      first_update_id: 100, last_update_id: 105, previous_update_id: null,
      ts: Date.parse("2024-01-01T00:00:00.000Z"), received_at: Date.parse("2024-01-01T00:00:00.100Z"),
    });
    // Raw wire strings, not numerically parsed -- this is the archive layer,
    // not a derived frame.
    expect(JSON.parse(rows[0].bids)).toEqual([["99.00", "5"]]);
    expect(JSON.parse(rows[0].asks)).toEqual([["101.00", "3"]]);
  });

  test("the matching raw Binance snapshot is retained once as the replay baseline", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    connection.setDepthSnapshot({
      ok: true,
      value: { body: { lastUpdateId: 99, bids: [["99.00", "5"]], asks: [["101.00", "3"]] } },
    });
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope());
    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, firstUpdateId: 106, lastUpdateId: 110 } }));
    await flush();
    service.stop();

    const rows = readTable(dbPath, "l2_depth_snapshots");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "BTCUSDT", market_kind: "SPOT", last_update_id: 99 });
    expect(JSON.parse(rows[0].bids)).toEqual([["99.00", "5"]]);
  });

  test("deduplicates an unchanged snapshot before repeating its expensive level validation", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    connection.setDepthSnapshot({
      ok: true,
      value: { body: { lastUpdateId: 99, bids: [["99.00", "5"]], asks: [["101.00", "3"]] } },
    });
    const service = createStorageService({ connection, dbPath });
    service.start();
    connection.emit(depthEnvelope());

    const repeatedBody = { lastUpdateId: 99, asks: [] };
    Object.defineProperty(repeatedBody, "bids", {
      get() {
        throw new Error("unchanged snapshot levels must not be walked again");
      },
    });
    connection.setDepthSnapshot({ ok: true, value: { body: repeatedBody } });
    expect(() => connection.emit(depthEnvelope({
      payload: { ...depthEnvelope().payload, firstUpdateId: 106, lastUpdateId: 110 },
    }))).not.toThrow();

    await flush();
    service.stop();
    expect(readTable(dbPath, "l2_depth_snapshots")).toHaveLength(1);
    expect(readTable(dbPath, "l2_depth_events")).toHaveLength(2);
  });

  test("a later bootstrap or recovery snapshot with a new update ID is retained as a new baseline", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    connection.setDepthSnapshot({
      ok: true,
      value: { body: { lastUpdateId: 99, bids: [["99.00", "5"]], asks: [["101.00", "3"]] } },
    });
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope());
    connection.setDepthSnapshot({
      ok: true,
      value: { body: { lastUpdateId: 199, bids: [["98.00", "6"]], asks: [["102.00", "4"]] } },
    });
    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, firstUpdateId: 200, lastUpdateId: 205 } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "l2_depth_snapshots").map((row) => row.last_update_id)).toEqual([99, 199]);
  });

  test("previousUpdateId (Binance's pu) is archived as null for SPOT and as a real integer for PERPETUAL", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope({ marketKind: "SPOT" }));
    connection.emit(
      depthEnvelope({
        marketKind: "PERPETUAL",
        payload: { firstUpdateId: 200, lastUpdateId: 205, previousUpdateId: 199, bids: [], asks: [] },
      }),
    );
    await flush();
    service.stop();

    const rows = readTable(dbPath, "l2_depth_events").sort((a, b) => a.market_kind.localeCompare(b.market_kind));
    expect(rows.map((r) => ({ market_kind: r.market_kind, previous_update_id: r.previous_update_id }))).toEqual([
      { market_kind: "PERPETUAL", previous_update_id: 199 },
      { market_kind: "SPOT", previous_update_id: null },
    ]);
  });

  test("a DEPTH envelope is archived unconditionally -- never calls getOrderBook(), never depends on book-assembler readiness", async () => {
    // This is the entire point of the raw-only rewrite: a DEPTH delta
    // arriving mid-gap-recovery (no coherent book to apply it against yet)
    // is exactly the data a future raw-replay rebuild needs most, so
    // archival must not gate on readiness the way the old zone-scanning
    // mechanism did. createFakeConnection()'s getOrderBook() throws by
    // design -- if storage-service ever called it, this test would fail
    // with that thrown error instead of passing.
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    expect(() => connection.emit(depthEnvelope())).not.toThrow();
    await flush();
    service.stop();

    expect(readTable(dbPath, "l2_depth_events")).toHaveLength(1);
  });

  test("malformed depth levels are rejected before they can poison the raw archive", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, bids: [["not-a-price", "5"]] } }));
    await flush();
    service.stop();

    expect(readTable(dbPath, "l2_depth_events")).toHaveLength(0);
  });

  test("oversized depth arrays are rejected at both event and snapshot persistence boundaries", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const oversized = Array.from({ length: 5_001 }, () => ["100", "1"]);
    connection.setDepthSnapshot({
      ok: true,
      value: { body: { lastUpdateId: 99, bids: oversized, asks: [] } },
    });
    const service = createStorageService({ connection, dbPath });
    service.start();

    connection.emit(depthEnvelope({ payload: { ...depthEnvelope().payload, bids: oversized } }));
    connection.emit(depthEnvelope());
    await flush();
    service.stop();

    expect(readTable(dbPath, "l2_depth_events")).toHaveLength(1);
    expect(readTable(dbPath, "l2_depth_snapshots")).toHaveLength(0);
  });

  test("after stop(), the connection listener is unsubscribed -- further envelopes write nothing", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();
    service.stop();

    connection.emit(tradeEnvelope());
    await flush();

    // The db file itself was already closed by stop(); prove no listener fired at all
    // by reopening it and confirming it's still schema-only, not by racing a closed handle.
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM trades").get().n;
    db.close();
    expect(count).toBe(0);
  });

  test("rejects lifecycle misuse and drops unsupported input without taking the collector down", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const onFatalError = jest.fn();
    const service = createStorageService({ connection, dbPath, onFatalError });
    service.start();
    expect(() => service.start()).toThrow(/twice/);

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    connection.emit(tradeEnvelope({ marketKind: "INVALID" }));
    await flush();

    expect(onFatalError).not.toHaveBeenCalled();
    expect(service.isHealthy()).toBe(true);
    expect(service.getStats().rejected).toBe(1);
    expect(() => service.stop()).not.toThrow();
    expect(() => service.stop()).not.toThrow();
    consoleErrorSpy.mockRestore();
    expect(readTable(dbPath, "trades")).toHaveLength(0);
  });

  test("null and non-canonical envelopes are rejected without escaping the connection listener", async () => {
    dbPath = tempDbPath();
    const connection = createFakeConnection();
    const service = createStorageService({ connection, dbPath });
    service.start();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => connection.emit(null)).not.toThrow();
    expect(() => connection.emit(tradeEnvelope({ provider: "OTHER" }))).not.toThrow();
    expect(() => connection.emit(tradeEnvelope({ eventType: "UNKNOWN" }))).not.toThrow();
    await flush();

    expect(service.getStats().rejected).toBe(3);
    service.stop();
    consoleErrorSpy.mockRestore();
    expect(readTable(dbPath, "trades")).toHaveLength(0);
  });

  test("rejects malformed construction controls before opening the database", () => {
    expect(() => createStorageService({ connection: null, dbPath: tempDbPath() })).toThrow(/connection/);
    expect(() => createStorageService({ connection: createFakeConnection(), dbPath: tempDbPath(), onFatalError: true })).toThrow(/onFatalError/);
  });

});

describe("createStorageService -- live-pipeline latency impact", () => {
  test("registering the real connection's storage-style listener adds no measurable delay to DEPTH delivery, the one event type notifyMessageListeners fires synchronously (not through the paced backpressure queue)", () => {
    const { WebSocketImpl, instances } = createBinanceConnectionHarness();
    // Subscribing to DEPTH kicks off a REST snapshot bootstrap -- forbid any
    // real network access rather than silently letting it hit live Binance.
    const fetchImpl = async () => {
      throw new Error("network calls are not allowed in this test");
    };
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
    connection.connect();
    const spotSocket = instances.find((instance) => instance.url.endsWith("stream.binance.com/stream"));
    spotSocket.simulateOpen();
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "test-consumer");

    const ITERATIONS = 2000;

    function timeDelivery() {
      const start = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i += 1) {
        spotSocket.simulateMessage(depthDeltaWireMessage(i));
      }
      return Number(process.hrtime.bigint() - start) / 1_000_000;
    }

    const baselineMs = timeDelivery();

    // A storage listener's only inline job is an O(1) queue push -- exactly
    // what storage-service.js's own handleEnvelope -> writeQueue.push does.
    const pushOnlyQueue = [];
    const unsubscribe = connection.onMessage((envelope) => pushOnlyQueue.push(envelope));
    const withStorageListenerMs = timeDelivery();
    unsubscribe();

    connection.disconnect(); // stop the forbidden-fetch retry/backoff loop the DEPTH subscribe started

    const perCallDeltaMs = (withStorageListenerMs - baselineMs) / ITERATIONS;

    expect(pushOnlyQueue.length).toBe(ITERATIONS);
    // Generous bound (a real storage listener body is one array push): proves
    // the delta is not a real, measurable latency cost, not just "small".
    expect(perCallDeltaMs).toBeLessThan(0.1);
  });
});

// A minimal fake WebSocket, self-contained here rather than imported from
// binance-connection.test.js, so this file doesn't depend on another test
// file's internals -- same shape (readyState, onopen/onclose/onmessage
// hooks, simulateOpen/simulateMessage) as the harness that file uses.
function createBinanceConnectionHarness() {
  const instances = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sentMessages = [];
      instances.push(this);
    }
    send(data) {
      this.sentMessages.push(data);
    }
    close() {
      this.readyState = 3;
    }
    simulateOpen() {
      this.readyState = 1;
      this.onopen?.({});
    }
    simulateMessage(data) {
      this.onmessage?.({ data });
    }
  }
  return { WebSocketImpl: FakeSocket, instances };
}

// DEPTH deltas are notified synchronously per-message (binance-connection.js's
// handleRawMessage calls notifyMessageListeners directly for DEPTH, unlike
// TRADE/KLINE which go through the paced backpressure queue) -- an ever-growing
// updateId range keeps each delta internally well-formed even though the book
// assembler has no snapshot to apply them against (it just stays BUFFERING,
// which is fine: notification fires regardless of book-assembler status).
function depthDeltaWireMessage(sequence) {
  return JSON.stringify({
    stream: "btcusdt@depth@100ms",
    data: { e: "depthUpdate", E: 1, s: "BTCUSDT", U: sequence * 2, u: sequence * 2 + 1, b: [["100.00", "1.0"]], a: [["100.10", "1.0"]] },
  });
}
