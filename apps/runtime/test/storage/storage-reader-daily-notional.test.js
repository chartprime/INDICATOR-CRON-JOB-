const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { runBatch } = require("../../scripts/maintain/maintain-daily-notional-rollup");
const { safeRm } = require("../helpers/temp-files");

const DAY_MS = 86_400_000;

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-daily-notional-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedTrade(storageDb, { ts, price, size, tradeId }) {
  storageDb.insert("trades", { ts, symbol: "BTCUSDT", marketKind: "SPOT", price, size, side: "buy", tradeId });
}

describe("storage-reader readDailyNotional (rollup-backed, correctness-preserving)", () => {
  let dbPath;
  afterEach(() => {
    if (dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
      dbPath = null;
    }
  });

  test("with no rollup maintenance ever run, behaves exactly like a pure raw scan across a mid-day, multi-day window", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 12 * 3_600_000, price: "100.00", size: "1", tradeId: "t1" });
    seedTrade(storageDb, { ts: DAY_MS + 1_000, price: "50.00", size: "2", tradeId: "t2" });
    seedTrade(storageDb, { ts: 2 * DAY_MS + 6 * 3_600_000, price: "10.00", size: "5", tradeId: "t3" });
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    const result = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 6 * 3_600_000, toTs: 2 * DAY_MS + 12 * 3_600_000 });
    expect(result.available).toBe(true);
    expect(result.rows).toEqual([
      { dayTs: 0, notional: 100 },
      { dayTs: DAY_MS, notional: 100 },
      { dayTs: 2 * DAY_MS, notional: 50 },
    ]);
  });

  test("once the rollup has fully caught up, reads the materialized total even after the underlying trade rows are gone", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "2", tradeId: "t1" });
    seedTrade(storageDb, { ts: DAY_MS + 1_000, price: "20.00", size: "1", tradeId: "t2" });
    // A trade on a third, later day is what lets day 1 count as safely past --
    // the watermark's own day is never trusted, since more of its trades could
    // still be pending.
    seedTrade(storageDb, { ts: 2 * DAY_MS + 1_000, price: "1.00", size: "1", tradeId: "t3" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 100, nowMs: 1 });
    storageDb.raw.prepare("UPDATE trades SET price = '999999.00' WHERE trade_id IN ('t1', 't2')").run();
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    const result = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 0, toTs: 2 * DAY_MS });
    expect(result.rows).toEqual([
      { dayTs: 0, notional: 200 },
      { dayTs: DAY_MS, notional: 20 },
    ]);
  });

  test("a materialized day whose total is not a finite number is left out rather than reported (the schema's CHECK lets infinity through)", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "2", tradeId: "t1" });
    seedTrade(storageDb, { ts: DAY_MS + 1_000, price: "20.00", size: "1", tradeId: "t2" });
    seedTrade(storageDb, { ts: 2 * DAY_MS + 1_000, price: "1.00", size: "1", tradeId: "t3" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 100, nowMs: 1 });
    storageDb.raw.prepare("UPDATE daily_notional_rollup SET notional = 9e999 WHERE day_bucket = ?").run(DAY_MS);
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    expect(reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 0, toTs: 2 * DAY_MS }).rows).toEqual([{ dayTs: 0, notional: 200 }]);
  });

  test("a window ending before the rollup's own coverage begins never touches the rollup at all", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "1", tradeId: "t1" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 100, nowMs: 1 });
    seedTrade(storageDb, { ts: 2 * DAY_MS + 1_000, price: "40.00", size: "1", tradeId: "t2" });
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    const result = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 2 * DAY_MS, toTs: 3 * DAY_MS });
    expect(result.rows).toEqual([{ dayTs: 2 * DAY_MS, notional: 40 }]);
  });

  test("partial materialization: rollup covers the safely-past head of the window (proven via corruption survival), the watermark's own day plus anything newer falls back to a raw scan spanning multiple days", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "1", tradeId: "t1" });
    seedTrade(storageDb, { ts: DAY_MS + 1_000, price: "30.00", size: "1", tradeId: "t2" });
    seedTrade(storageDb, { ts: 2 * DAY_MS + 1_000, price: "5.00", size: "1", tradeId: "t3" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 100, nowMs: 1 });
    seedTrade(storageDb, { ts: 3 * DAY_MS + 1_000, price: "7.00", size: "1", tradeId: "t4" });
    storageDb.raw.prepare("UPDATE trades SET price = '999999.00' WHERE trade_id IN ('t1', 't2')").run();
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    const result = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 0, toTs: 4 * DAY_MS });
    expect(result.rows).toEqual([
      { dayTs: 0, notional: 100 },
      { dayTs: DAY_MS, notional: 30 },
      { dayTs: 2 * DAY_MS, notional: 5 },
      { dayTs: 3 * DAY_MS, notional: 7 },
    ]);
  });

  test("a window fully inside one calendar day never queries the rollup, materialized or not", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "1", tradeId: "t1" });
    seedTrade(storageDb, { ts: 5_000, price: "10.00", size: "1", tradeId: "t2" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 100, nowMs: 1 });
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    const result = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 2_000, toTs: 8_000 });
    expect(result.rows).toEqual([{ dayTs: 0, notional: 10 }]);
  });

  test("an empty window (fromTs === toTs) returns no rows without error", () => {
    dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();
    const reader = createStorageReader({ dbPath });
    expect(reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: 5_000, toTs: 5_000 })).toEqual({ rows: [], available: true });
  });
});
