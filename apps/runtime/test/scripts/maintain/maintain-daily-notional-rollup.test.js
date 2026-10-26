const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { safeRm } = require("../../helpers/temp-files");
const { main, maintainPair, runBatch, SYMBOL_MARKET_PAIRS, DAY_MS } = require("../../../scripts/maintain/maintain-daily-notional-rollup");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-rollup-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedTrade(storageDb, { ts, symbol = "BTCUSDT", marketKind = "SPOT", price, size, tradeId }) {
  storageDb.insert("trades", { ts, symbol, marketKind, price, size, side: "buy", tradeId });
}

describe("maintain-daily-notional-rollup", () => {
  let dbPath;
  afterEach(() => {
    if (dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
      dbPath = null;
    }
  });

  test("runBatch sums notional per UTC day bucket and advances the watermark to the last row scanned", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "2", tradeId: "t1" });
    seedTrade(storageDb, { ts: 2_000, price: "50.00", size: "1", tradeId: "t2" });
    seedTrade(storageDb, { ts: DAY_MS + 1_000, price: "10.00", size: "10", tradeId: "t3" });

    const result = runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 10, nowMs: 500_000 });
    expect(result).toEqual({ tradesProcessed: 3, lastTradeId: expect.any(Number), daysTouched: 2 });

    const rows = storageDb.raw.prepare(
      "SELECT day_bucket, notional FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT' ORDER BY day_bucket",
    ).all();
    expect(rows).toEqual([
      { day_bucket: 0, notional: 250 },
      { day_bucket: DAY_MS, notional: 100 },
    ]);
    const watermark = storageDb.raw.prepare(
      "SELECT last_trade_id, updated_at FROM daily_notional_rollup_watermark WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT'",
    ).get();
    expect(watermark).toEqual({ last_trade_id: result.lastTradeId, updated_at: 500_000 });
    storageDb.close();
  });

  test("a second run only accumulates trades newer than the watermark, never double-counting", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, price: "100.00", size: "1", tradeId: "t1" });
    runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 10, nowMs: 1 });

    seedTrade(storageDb, { ts: 2_000, price: "20.00", size: "1", tradeId: "t2" });
    const second = runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 10, nowMs: 2 });
    expect(second.tradesProcessed).toBe(1);

    const row = storageDb.raw.prepare(
      "SELECT notional FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT' AND day_bucket = 0",
    ).get();
    expect(row.notional).toBe(120);

    const rerun = runBatch(storageDb.raw, { symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 10, nowMs: 3 });
    expect(rerun).toEqual({ tradesProcessed: 0, lastTradeId: second.lastTradeId, daysTouched: 0 });
    storageDb.close();
  });

  test("maintainPair loops across batches until caught up, and stops within its time budget on a real backlog", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    for (let index = 0; index < 25; index += 1) {
      seedTrade(storageDb, { ts: 1_000 + index, price: "1.00", size: "1", tradeId: `bulk-${index}` });
    }
    let calls = 0;
    const now = () => { calls += 1; return calls; };
    const result = maintainPair(storageDb.raw, {
      symbol: "BTCUSDT", marketKind: "SPOT", batchRows: 10, runBudgetMs: 1_000, now, startedAt: 0,
    });
    expect(result).toEqual({ symbol: "BTCUSDT", marketKind: "SPOT", tradesProcessed: 25, batchesRun: 3 });
    const total = storageDb.raw.prepare(
      "SELECT SUM(notional) AS total FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT'",
    ).get();
    expect(total.total).toBe(25);
    storageDb.close();
  });

  test("keeps each provider/market pair's rollup fully isolated", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, { ts: 1_000, symbol: "BTCUSDT", marketKind: "SPOT", price: "100.00", size: "1", tradeId: "b1" });
    seedTrade(storageDb, { ts: 1_000, symbol: "ETHUSDT", marketKind: "PERPETUAL", price: "10.00", size: "1", tradeId: "e1" });
    for (const [symbol, marketKind] of SYMBOL_MARKET_PAIRS) {
      runBatch(storageDb.raw, { symbol, marketKind, batchRows: 10, nowMs: 1 });
    }
    expect(storageDb.raw.prepare(
      "SELECT notional FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT'",
    ).get().notional).toBe(100);
    expect(storageDb.raw.prepare(
      "SELECT notional FROM daily_notional_rollup WHERE symbol = 'ETHUSDT' AND market_kind = 'PERPETUAL'",
    ).get().notional).toBe(10);
    expect(storageDb.raw.prepare(
      "SELECT COUNT(*) AS n FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'PERPETUAL'",
    ).get().n).toBe(0);
    storageDb.close();
  });
});

describe("main", () => {
  function fakeLogger() {
    const calls = { info: [], ok: [], error: [] };
    return {
      calls,
      info: (...args) => calls.info.push(args),
      ok: (...args) => calls.ok.push(args),
      error: (...args) => calls.error.push(args),
      flush: () => Promise.resolve(),
    };
  }

  test("runs to completion, exit code 0, for a real database with no backlog", async () => {
    const dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();
    const logger = fakeLogger();
    const exit = jest.fn();
    const code = await main({
      logger, dbPath, createDb: (options) => createStorageDb(options), now: () => 1, exit,
    });
    expect(code).toBe(0);
    expect(logger.calls.error).toEqual([]);
    expect(logger.calls.ok.some((call) => call[0] === "daily-notional rollup maintenance complete")).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  // The run budget used to only be checked inside each pair's own batch
  // loop, so a large backlog on the first pair could exhaust the budget and
  // every remaining pair would still run at least one full batch beyond it.
  // The outer loop must also check the shared budget before starting each
  // pair, so a backlog on one pair can genuinely starve the rest of the run.
  test("a large backlog on the first pair exhausts the shared run budget before any other pair gets even one batch", async () => {
    const dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    for (let index = 0; index < 30; index += 1) {
      seedTrade(storageDb, {
        ts: 1_000 + index, symbol: "BTCUSDT", marketKind: "SPOT", price: "1.00", size: "1", tradeId: `bulk-${index}`,
      });
    }
    for (const [symbol, marketKind] of SYMBOL_MARKET_PAIRS.slice(1)) {
      seedTrade(storageDb, { ts: 1_000, symbol, marketKind, price: "1.00", size: "1", tradeId: `${symbol}-${marketKind}-only` });
    }
    storageDb.close();

    let calls = 0;
    const now = () => { calls += 1; return calls; };
    const logger = fakeLogger();
    const exit = jest.fn();
    const code = await main({
      logger, dbPath, createDb: (options) => createStorageDb(options), now, exit, batchRows: 5, runBudgetMs: 5,
    });
    expect(code).toBe(0);

    const verify = createStorageDb({ dbPath, bootstrap: false });
    const rolledUp = verify.raw.prepare("SELECT symbol, market_kind FROM daily_notional_rollup_watermark").all();
    expect(rolledUp).toEqual([{ symbol: "BTCUSDT", market_kind: "SPOT" }]);
    const total = verify.raw.prepare(
      "SELECT SUM(notional) AS total FROM daily_notional_rollup WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT'",
    ).get();
    expect(total.total).toBeGreaterThan(0);
    expect(total.total).toBeLessThan(30);
    verify.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("exits 1 and logs the reason when the database rejects the connection (e.g. schema not migrated yet)", async () => {
    const logger = fakeLogger();
    const exit = jest.fn();
    const code = await main({
      logger, dbPath: "/nonexistent/does-not-exist.sqlite",
      createDb: () => { throw new Error("storage-db: writer requires schema version 16, found 15"); },
      now: () => 1, exit,
    });
    expect(code).toBe(1);
    expect(logger.calls.error).toHaveLength(1);
  });
});
