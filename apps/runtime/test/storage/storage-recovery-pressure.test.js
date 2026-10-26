const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { createStorageWorkerClient } = require("../../src/storage/storage-worker-client");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-storage-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function initialize(dbPath) {
  const db = createStorageDb({ dbPath });
  db.close();
}

function tradeRecord(tradeId) {
  return {
    ts: 1_000,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    price: "65000.00",
    size: "0.001",
    side: "buy",
    tradeId: String(tradeId),
  };
}

describe("storage WAL recovery and reader pressure", () => {
  const paths = [];

  afterEach(() => {
    for (const dbPath of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm", ".lock"]) {
        if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
      }
    }
  });

  test("a committed uncheckpointed WAL row is readable, while an uncommitted transaction never leaks and rolls back on close", () => {
    const dbPath = tempDbPath();
    paths.push(dbPath);
    initialize(dbPath);
    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    const insert = writer.prepare(
      "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(1_000, "BTCUSDT", "SPOT", "65000", "0.001", "buy", "committed");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    writer.exec("BEGIN IMMEDIATE");
    insert.run(1_001, "BTCUSDT", "SPOT", "65001", "0.001", "buy", "uncommitted");
    const concurrentReader = new Database(dbPath, { readonly: true });
    expect(concurrentReader.prepare("SELECT trade_id FROM trades ORDER BY id").all())
      .toEqual([{ trade_id: "committed" }]);
    concurrentReader.close();

    writer.close();
    const recovered = new Database(dbPath, { readonly: true });
    expect(recovered.prepare("SELECT trade_id FROM trades ORDER BY id").all())
      .toEqual([{ trade_id: "committed" }]);
    expect(recovered.pragma("quick_check", { simple: true })).toBe("ok");
    recovered.close();
  });

  test("a long-lived reader under sustained worker writes never blocks durability or loses accepted rows", async () => {
    const dbPath = tempDbPath();
    paths.push(dbPath);
    initialize(dbPath);
    const reader = createStorageReader({ dbPath, timeoutMs: 100 });
    const client = createStorageWorkerClient({
      dbPath,
      maxPendingItems: 10_000,
      maxBatchItems: 100,
      maxInFlightBatches: 2,
      batchFlushIntervalMs: 1,
    });
    await client.waitUntilReady();

    const total = 5_000;
    let successfulPressureReads = 0;
    for (let tradeId = 1; tradeId <= total; tradeId += 1) {
      client.push("trades", tradeRecord(tradeId));
      if (tradeId % 250 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        const result = reader.readRecentTrades("BTCUSDT", "SPOT", {
          windowMs: 2_000,
          nowMs: 2_000,
          limit: 100,
        });
        expect(Array.isArray(result.rows)).toBe(true);
        successfulPressureReads += 1;
      }
    }
    await client.stop();

    const finalRead = reader.readRecentTrades("BTCUSDT", "SPOT", {
      windowMs: 2_000,
      nowMs: 2_000,
      limit: total,
    });
    expect(successfulPressureReads).toBe(20);
    expect(finalRead.rows).toHaveLength(total);
    expect(client.getStats()).toMatchObject({
      pendingWriteItems: 0,
      storageWrittenItems: total,
      storageWorkerHealthy: true,
      pendingWriteItemsHighWaterMark: expect.any(Number),
    });
    reader.close();
  }, 30_000);
});
