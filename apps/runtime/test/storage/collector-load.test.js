const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createBinanceConnection } = require("../../src/providers/binance/binance-connection");
const { createStorageService } = require("../../src/storage/storage-service");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-collector-load-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function createWebSocketHarness() {
  const instances = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sentMessages = [];
      instances.push(this);
    }
    send(message) {
      this.sentMessages.push(message);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    message(data) {
      this.onmessage?.({ data });
    }
  }
  return { FakeSocket, instances };
}

function tradeMessage(tradeId, symbol = "BTCUSDT") {
  return JSON.stringify({
    stream: `${symbol.toLowerCase()}@trade`,
    data: {
      e: "trade",
      E: 1_700_000_000_000,
      s: symbol,
      t: tradeId,
      p: "65000.00",
      q: "0.001",
      T: 1_700_000_000_000,
      m: false,
      M: true,
    },
  });
}

async function waitForDurableDrain(storage, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const stats = storage.getStats();
    if (stats.pendingIngressEnvelopes === 0 && stats.pendingWriteItems === 0) return stats;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("collector-load: durable storage did not drain before the qualification deadline");
}

describe("institutional collector burst path", () => {
  test("a 20,000-trade burst drains to worker-owned durable storage with no loss", async () => {
    const dbPath = tempDbPath();
    const telemetryEntries = [];
    const { FakeSocket, instances } = createWebSocketHarness();
    const connection = createBinanceConnection({
      webSocketImpl: FakeSocket,
      telemetry: (entry) => telemetryEntries.push(entry),
      backpressureOverflowPolicy: "FAIL",
      backpressureMaxQueueDepth: 50_000,
      backpressureDrainBatchSize: 2_000,
      rawIngressEnabled: true,
      rawIngressMaxQueueDepth: 50_000,
      rawIngressDrainBatchSize: 1_000,
      rawIngressDrainMaxMs: 8,
    });
    const storage = createStorageService({
      connection,
      dbPath,
      useWorker: true,
      ingressDrainBatchSize: 2_000,
    });
    storage.start();
    await storage.whenReady();
    connection.connect();
    for (const socket of instances) socket.open();
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "load-test");
    const spot = instances.find((socket) => socket.url.includes("stream.binance.com"));

    for (let tradeId = 1; tradeId <= 20_000; tradeId += 1) {
      spot.message(tradeMessage(tradeId));
    }

    let timerRanDuringDrain = false;
    setTimeout(() => {
      timerRanDuringDrain = true;
    }, 0);
    await connection.quiesce({ timeoutMs: 30_000 });
    expect(timerRanDuringDrain).toBe(true);
    expect(connection.getOperationalStats()).toMatchObject({
      rawIngressPending: 0,
      rawIngressAccepted: 20_000,
      rawIngressProcessed: 20_000,
      rawIngressOverflows: 0,
      rawIngressHighWaterMark: 20_000,
      backpressurePending: 0,
      backpressureDropped: 0,
      backpressureOverflows: 0,
      backpressureCleared: 0,
    });
    const durableStats = await waitForDurableDrain(storage);
    expect(durableStats).toMatchObject({
      trades: 20_000,
      rejected: 0,
      pendingIngressEnvelopes: 0,
      pendingWriteItems: 0,
      storageWrittenItems: 20_000,
      storageWorkerHealthy: true,
      storageIngressHighWaterMark: expect.any(Number),
      pendingWriteItemsHighWaterMark: expect.any(Number),
      storageCommitP99Ms: expect.any(Number),
      storageAckP99Ms: expect.any(Number),
    });
    expect(durableStats.storageIngressHighWaterMark).toBeGreaterThan(0);
    expect(durableStats.pendingWriteItemsHighWaterMark).toBeGreaterThan(0);

    connection.removeConsumer("load-test");
    connection.disconnect();
    storage.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true, terminationReason: "load test" });
    await storage.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trades").get().count).toBe(20_000);
    expect(db.prepare("SELECT MIN(CAST(trade_id AS INTEGER)) AS first, MAX(CAST(trade_id AS INTEGER)) AS last FROM trades").get())
      .toEqual({ first: 1, last: 20_000 });
    expect(db.prepare("SELECT quality, clean_shutdown FROM capture_sessions").get())
      .toEqual({ quality: "HEALTHY", clean_shutdown: 1 });
    db.close();

    expect(telemetryEntries.filter((entry) => /dropped|overflow|queue_cleared/.test(entry.event))).toEqual([]);
    for (const suffix of ["", "-wal", "-shm", ".lock"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  }, 60_000);

  test("a sustained four-tuple volume regime stays responsive and stores every accepted trade", async () => {
    const dbPath = tempDbPath();
    const telemetryEntries = [];
    const { FakeSocket, instances } = createWebSocketHarness();
    const connection = createBinanceConnection({
      webSocketImpl: FakeSocket,
      telemetry: (entry) => telemetryEntries.push(entry),
      backpressureOverflowPolicy: "FAIL",
      backpressureMaxQueueDepth: 50_000,
      backpressureDrainBatchSize: 1_000,
      backpressureDrainMaxMs: 8,
      rawIngressEnabled: true,
      rawIngressMaxQueueDepth: 50_000,
      rawIngressDrainBatchSize: 1_000,
      rawIngressDrainMaxMs: 8,
    });
    const storage = createStorageService({
      connection,
      dbPath,
      useWorker: true,
      ingressDrainBatchSize: 1_000,
      ingressDrainMaxMs: 8,
    });
    storage.start();
    await storage.whenReady();
    connection.connect();
    for (const socket of instances) socket.open();
    for (const marketKind of ["SPOT", "PERPETUAL"]) {
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        connection.subscribe({ symbol, marketKind, eventType: "TRADE" }, "load-test");
      }
    }
    const spot = instances.find((socket) => socket.url.includes("stream.binance.com"));
    const perpetual = instances.find((socket) => socket.url.includes("fstream.binance.com/public"));
    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks += 1;
    }, 1);

    for (let tradeId = 1; tradeId <= 20_000; tradeId += 1) {
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        spot.message(tradeMessage(tradeId, symbol));
        perpetual.message(tradeMessage(tradeId, symbol));
      }
      if (tradeId % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    clearInterval(timer);

    await connection.quiesce({ timeoutMs: 30_000 });
    expect(timerTicks).toBeGreaterThan(0);
    expect(connection.getOperationalStats()).toMatchObject({
      rawIngressPending: 0,
      rawIngressAccepted: 80_000,
      rawIngressProcessed: 80_000,
      rawIngressOverflows: 0,
      backpressurePending: 0,
      backpressureDropped: 0,
      backpressureOverflows: 0,
      backpressureCleared: 0,
    });
    const durableStats = await waitForDurableDrain(storage);
    expect(durableStats).toMatchObject({
      trades: 80_000,
      rejected: 0,
      pendingIngressEnvelopes: 0,
      pendingWriteItems: 0,
      storageWrittenItems: 80_000,
      storageWorkerHealthy: true,
      storageCommitSampleCount: expect.any(Number),
      storageAckSampleCount: expect.any(Number),
    });
    expect(durableStats.storageCommitSampleCount).toBeGreaterThan(0);
    expect(durableStats.storageAckSampleCount).toBeGreaterThan(0);

    connection.removeConsumer("load-test");
    connection.disconnect();
    storage.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true, terminationReason: "sustained load test" });
    await storage.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trades").get().count).toBe(80_000);
    expect(db.prepare(
      "SELECT symbol, market_kind, COUNT(*) AS count, MIN(CAST(trade_id AS INTEGER)) AS first, MAX(CAST(trade_id AS INTEGER)) AS last FROM trades GROUP BY symbol, market_kind ORDER BY market_kind, symbol",
    ).all()).toEqual([
      { symbol: "BTCUSDT", market_kind: "PERPETUAL", count: 20_000, first: 1, last: 20_000 },
      { symbol: "ETHUSDT", market_kind: "PERPETUAL", count: 20_000, first: 1, last: 20_000 },
      { symbol: "BTCUSDT", market_kind: "SPOT", count: 20_000, first: 1, last: 20_000 },
      { symbol: "ETHUSDT", market_kind: "SPOT", count: 20_000, first: 1, last: 20_000 },
    ]);
    db.close();

    expect(telemetryEntries.filter((entry) => /dropped|overflow|queue_cleared/.test(entry.event))).toEqual([]);
    for (const suffix of ["", "-wal", "-shm", ".lock"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  }, 60_000);
});
