const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageWorkerClient } = require("../../src/storage/storage-worker-client");
const { safeRm } = require("../helpers/temp-files");

// Wait for the condition the assertion is about, not for a fixed number of
// milliseconds. A fixed delay encodes an assumption about how promptly a
// stall-detection timer gets to run, which stops holding under parallel-suite
// load -- see L1L2-V2-016.
async function waitUntil(predicate, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-storage-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function initialize(pathname) {
  const db = createStorageDb({ dbPath: pathname });
  db.close();
}

function tradeRecord(tradeId) {
  return {
    ts: 1000,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    price: "1",
    size: "1",
    side: "buy",
    tradeId,
  };
}

function depthRecord(sequence) {
  const levels = Array.from({ length: 64 }, (_, index) => [
    String(100_000 - sequence - index),
    "0.12500000",
  ]);
  return {
    ts: sequence,
    receivedAt: sequence,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    firstUpdateId: sequence,
    lastUpdateId: sequence,
    previousUpdateId: null,
    bids: JSON.stringify(levels),
    asks: JSON.stringify(levels),
  };
}

describe("storage-worker-client", () => {
  test("a failure after the stopped message still rejects shutdown", async () => {
    const client = createStorageWorkerClient({ dbPath: "fail-after-stopped",
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-stopped-before-exit.js") });
    await client.waitUntilReady();
    await expect(client.stop()).rejects.toThrow(/exited unexpectedly/);
    expect(client.getStats().storageWorkerHealthy).toBe(false);
  });
  test("a worker that does not exit after shutdown is terminated within the configured deadline", async () => {
    const client = createStorageWorkerClient({ dbPath: "unused-offline-fixture.sqlite", writeStallTimeoutMs: 30,
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-stopped-before-exit.js") });
    await client.waitUntilReady();
    await expect(client.stop()).rejects.toMatchObject({ code: "STORAGE_WORKER_SHUTDOWN_STALL" });
    expect(client.getStats().storageWorkerHealthy).toBe(false);
  });
  test("shutdown completion awaits worker exit, not merely its stopped message", async () => {
    const client = createStorageWorkerClient({ dbPath: "unused-offline-fixture.sqlite",
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-stopped-before-exit.js") });
    await client.waitUntilReady();
    const before = Date.now();
    await client.stop();
    expect(Date.now() - before).toBeGreaterThanOrEqual(150);
    expect(client.getStats().storageWorkerState).toBe("STOPPED");
  });
  let dbPath;

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (dbPath && fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("commits accepted batches in the worker and drains cleanly on stop", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const client = createStorageWorkerClient({ dbPath, maxBatchItems: 2, batchFlushIntervalMs: 1_000 });
    await expect(client.waitUntilReady()).resolves.toBeUndefined();

    client.push("trades", tradeRecord("1"));
    client.push("trades", tradeRecord("2"));
    client.push("trades", tradeRecord("3"));
    await client.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT trade_id FROM trades ORDER BY id").all().map((row) => row.trade_id))
      .toEqual(["1", "2", "3"]);
    db.close();
    expect(client.getStats()).toMatchObject({
      pendingWriteItems: 0,
      storageWrittenItems: 3,
      storageCommitCount: 2,
      storageWorkerHealthy: true,
      storageLastAckLatencyMs: expect.any(Number),
      storageMaxAckLatencyMs: expect.any(Number),
      storageCommitSampleCount: 2,
      storageAckSampleCount: 2,
      storageCommitP99Ms: expect.any(Number),
      storageAckP99Ms: expect.any(Number),
    });
    // Depth continuity is deliberately deferred beyond the live writer boot
    // path, so a large historical audit cannot consume readiness budget.
    expect(client.getStats().storageLastMaintenanceByName.depth_continuity).toBeUndefined();
  });

  test("shutdown force-flushes a final partial batch that becomes eligible only after an earlier acknowledgement", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const client = createStorageWorkerClient({
      dbPath,
      maxBatchItems: 2,
      maxInFlightBatches: 1,
      batchFlushIntervalMs: 60_000,
    });
    await expect(client.waitUntilReady()).resolves.toBeUndefined();

    for (const tradeId of ["1", "2", "3", "4", "5"]) {
      client.push("trades", tradeRecord(tradeId));
    }
    await expect(client.stop()).resolves.toBeUndefined();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT trade_id FROM trades ORDER BY id").all().map((row) => row.trade_id))
      .toEqual(["1", "2", "3", "4", "5"]);
    db.close();
  });

  test("sustained multi-batch ingestion drains every accepted record without a stuck in-flight batch", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const client = createStorageWorkerClient({
      dbPath,
      maxPendingItems: 10_000,
      maxBatchItems: 127,
      maxInFlightBatches: 2,
      batchFlushIntervalMs: 1,
    });
    await client.waitUntilReady();

    const total = 5_000;
    for (let index = 0; index < total; index += 1) {
      client.push("trades", tradeRecord(String(index + 1)));
    }
    await client.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(total);
    db.close();
    expect(client.getStats()).toMatchObject({
      pendingWriteItems: 0,
      storageWrittenItems: total,
      storageInFlightBatches: 0,
      storageWorkerHealthy: true,
    });
  });

  test("sustained raw L2 batches preserve every accepted depth delta", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const client = createStorageWorkerClient({
      dbPath,
      maxPendingItems: 10_000,
      maxBatchItems: 100,
      batchFlushIntervalMs: 1,
    });
    await client.waitUntilReady();

    const total = 2_000;
    for (let index = 1; index <= total; index += 1) {
      client.push("l2_depth_events", depthRecord(index));
    }
    await client.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM l2_depth_events").get().n).toBe(total);
    db.close();
    expect(client.getStats()).toMatchObject({
      pendingWriteItems: 0,
      storageWrittenItems: total,
      storageInFlightBatches: 0,
      storageWorkerHealthy: true,
    });
  });

  test("fails visibly before a bounded client backlog can overflow", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const onFatalError = jest.fn();
    const client = createStorageWorkerClient({
      dbPath,
      maxPendingItems: 1,
      maxInFlightBatches: 1,
      onFatalError,
    });
    client.push("trades", tradeRecord("1"));
    expect(() => client.push("trades", tradeRecord("2"))).toThrow(/backlog limit/);
    expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({ code: "STORAGE_BACKLOG_OVERFLOW" }));
    await expect(client.stop()).rejects.toThrow(/backlog limit/);
  });

  test("fails closed when the worker never reaches its ready state", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const onFatalError = jest.fn();
    const client = createStorageWorkerClient({
      dbPath,
      readyTimeoutMs: 20,
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-never-ready.js"),
      onFatalError,
    });

    await expect(client.waitUntilReady()).rejects.toThrow(/did not become ready/);
    expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/did not become ready/) }));
    await expect(client.stop()).rejects.toThrow(/did not become ready/);
  });

  test("fails closed and terminates a worker that starts a write but never acknowledges it", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const onFatalError = jest.fn();
    const client = createStorageWorkerClient({
      dbPath,
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-never-acks.js"),
      writeStallTimeoutMs: 25,
      onFatalError,
    });
    await client.waitUntilReady();

    client.push("trades", tradeRecord("1"));
    await waitUntil(() => onFatalError.mock.calls.length > 0);

    expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
      code: "STORAGE_WORKER_WRITE_STALL",
      phase: "WRITING",
      itemCount: 1,
    }));
    expect(client.getStats()).toMatchObject({
      storageWorkerHealthy: false,
      storageWorkerState: "FAILED",
      storageActiveWriteItems: 1,
    });
    await expect(client.stop()).rejects.toThrow(/did not acknowledge batch/);
  });

  test("fails closed when a ready worker stops processing before it starts an accepted batch", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const onFatalError = jest.fn();
    const client = createStorageWorkerClient({
      dbPath,
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-ready-but-not-processing.js"),
      writeStallTimeoutMs: 25,
      onFatalError,
    });
    await client.waitUntilReady();

    client.push("trades", tradeRecord("1"));
    await waitUntil(() => onFatalError.mock.calls.length > 0);

    expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
      code: "STORAGE_WORKER_WRITE_STALL",
      phase: "QUEUED",
      itemCount: 1,
    }));
    await expect(client.stop()).rejects.toThrow(/did not acknowledge batch/);
  });

  test("fails closed with batch evidence when the worker process dies during a write", async () => {
    dbPath = tempDbPath();
    initialize(dbPath);
    const onFatalError = jest.fn();
    const client = createStorageWorkerClient({
      dbPath,
      workerFile: path.join(__dirname, "..", "fixtures", "storage-worker-exits-during-write.js"),
      onFatalError,
    });
    await client.waitUntilReady();

    client.push("trades", tradeRecord("1"));
    await waitUntil(() => onFatalError.mock.calls.length > 0);

    expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
      code: "STORAGE_WORKER_EXIT",
      workerExitCode: 17,
      phase: "WRITING",
      itemCount: 1,
    }));
    expect(client.getStats()).toMatchObject({
      storageWorkerHealthy: false,
      storageWorkerState: "FAILED",
      pendingWriteItems: 1,
    });
    await expect(client.stop()).rejects.toMatchObject({
      code: "STORAGE_WORKER_EXIT",
      workerExitCode: 17,
    });
  });

  test("rejects in-memory databases and malformed limits", () => {
    expect(() => createStorageWorkerClient({ dbPath: ":memory:" })).toThrow(/file-backed/);
    expect(() => createStorageWorkerClient({ dbPath: "x", maxPendingItems: 0 })).toThrow(/maxPendingItems/);
    expect(() => createStorageWorkerClient({ dbPath: "x", readyTimeoutMs: 0 })).toThrow(/readyTimeoutMs/);
    expect(() => createStorageWorkerClient({ dbPath: "x", writeStallTimeoutMs: 0 })).toThrow(/writeStallTimeoutMs/);
  });
});
