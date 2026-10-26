#!/usr/bin/env node

const path = require("node:path");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { createStorageDb, DEFAULT_DB_PATH } = require("../../src/storage/storage-db");

const SYMBOL_MARKET_PAIRS = Object.freeze([
  ["BTCUSDT", "SPOT"], ["BTCUSDT", "PERPETUAL"],
  ["ETHUSDT", "SPOT"], ["ETHUSDT", "PERPETUAL"],
]);
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_ROWS = 50_000;
const DEFAULT_RUN_BUDGET_MS = 90_000;

function runBatch(db, { symbol, marketKind, batchRows, nowMs }) {
  const watermarkRow = db.prepare(
    "SELECT last_trade_id FROM daily_notional_rollup_watermark WHERE symbol = ? AND market_kind = ?",
  ).get(symbol, marketKind);
  const sinceId = watermarkRow?.last_trade_id ?? 0;

  const rows = db.prepare(
    "SELECT id, ts, CAST(price AS REAL) AS price, CAST(size AS REAL) AS size FROM trades " +
      "WHERE symbol = ? AND market_kind = ? AND id > ? ORDER BY id LIMIT ?",
  ).all(symbol, marketKind, sinceId, batchRows);
  if (rows.length === 0) return { tradesProcessed: 0, lastTradeId: sinceId, daysTouched: 0 };

  const byDayBucket = new Map();
  for (const row of rows) {
    const dayBucket = Math.floor(row.ts / DAY_MS) * DAY_MS;
    byDayBucket.set(dayBucket, (byDayBucket.get(dayBucket) ?? 0) + row.price * row.size);
  }
  const lastTradeId = rows[rows.length - 1].id;

  const upsertDay = db.prepare(
    "INSERT INTO daily_notional_rollup (symbol, market_kind, day_bucket, notional) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(symbol, market_kind, day_bucket) DO UPDATE SET notional = notional + excluded.notional",
  );
  const upsertWatermark = db.prepare(
    "INSERT INTO daily_notional_rollup_watermark (symbol, market_kind, last_trade_id, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(symbol, market_kind) DO UPDATE SET last_trade_id = excluded.last_trade_id, updated_at = excluded.updated_at",
  );
  db.transaction(() => {
    for (const [dayBucket, notional] of byDayBucket) upsertDay.run(symbol, marketKind, dayBucket, notional);
    upsertWatermark.run(symbol, marketKind, lastTradeId, nowMs);
  })();

  return { tradesProcessed: rows.length, lastTradeId, daysTouched: byDayBucket.size };
}

function maintainPair(db, { symbol, marketKind, batchRows, runBudgetMs, now, startedAt }) {
  let totalTrades = 0;
  let totalBatches = 0;
  for (;;) {
    const batch = runBatch(db, { symbol, marketKind, batchRows, nowMs: now() });
    totalTrades += batch.tradesProcessed;
    if (batch.tradesProcessed > 0) totalBatches += 1;
    if (batch.tradesProcessed < batchRows) break;
    if (now() - startedAt > runBudgetMs) break;
  }
  return { symbol, marketKind, tradesProcessed: totalTrades, batchesRun: totalBatches };
}

async function main({
  logger = createCliLogger({ name: "maintain-daily-notional-rollup" }),
  dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH,
  createDb = createStorageDb,
  batchRows = DEFAULT_BATCH_ROWS,
  runBudgetMs = DEFAULT_RUN_BUDGET_MS,
  now = () => Date.now(),
  exit = process.exit,
} = {}) {
  let storageDb = null;
  let exitCode = 0;
  try {
    storageDb = createDb({ dbPath, bootstrap: false, verifyIntegrity: false });
    const startedAt = now();
    logger.info("starting daily-notional rollup maintenance", { dbPath });
    for (const [symbol, marketKind] of SYMBOL_MARKET_PAIRS) {
      if (now() - startedAt > runBudgetMs) break;
      const result = maintainPair(storageDb.raw, { symbol, marketKind, batchRows, runBudgetMs, now, startedAt });
      if (result.tradesProcessed > 0) logger.ok("rollup updated", result);
    }
    logger.ok("daily-notional rollup maintenance complete", { dbPath, durationMs: now() - startedAt });
  } catch (error) {
    exitCode = 1;
    logger.error("daily-notional rollup maintenance failed", {
      dbPath,
      reason: error?.message ?? error,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
    });
  } finally {
    storageDb?.close();
  }
  await flushAndExit(logger, exit, exitCode);
  return exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("maintain-daily-notional-rollup: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main, maintainPair, runBatch, SYMBOL_MARKET_PAIRS, DAY_MS };
