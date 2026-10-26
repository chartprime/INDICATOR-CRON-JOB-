#!/usr/bin/env node

const fs = require("node:fs");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { createStorageDb, DEFAULT_DB_PATH: BINANCE_DB_PATH } = require("../../src/storage/storage-db");
const { createDxFeedStorageDb, DEFAULT_DB_PATH: DXFEED_DB_PATH } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { SYMBOL_MARKET_PAIRS } = require("./maintain-daily-notional-rollup");

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_DAYS = 21;
const DEFAULT_MAX_SECONDS = 3_600;
const MIN_BATCH_ROWS = 1_000;
const MAX_BATCH_ROWS = 200_000;
const INITIAL_BATCH_ROWS = 20_000;
const TARGET_BATCH_MS = 250;
const PAUSE_BETWEEN_BATCHES_MS = 50;
const BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_WAL_BYTES = 2 * 1024 * 1024 * 1024;
const WAL_WAIT_MS = 5_000;
const CONFIG_EXIT_CODE = 2;
const DEFAULT_EXPORT_WATERMARK_PATH = "/var/lib/terminal-l1-l2/capture-export/watermark.json";
const EXPORT_WATERMARK_VERSION = 2;

const TARGETS = Object.freeze({
  binance: Object.freeze({
    defaultDbPath: BINANCE_DB_PATH,
    createDb: createStorageDb,
    tables: Object.freeze([
      Object.freeze({ table: "trades", timeColumn: "ts", timeIndex: "idx_trades_ts", rollupWatermark: true }),
      Object.freeze({ table: "l2_depth_events", timeColumn: "ts", timeIndex: "idx_l2_depth_events_ts" }),
      Object.freeze({ table: "l2_depth_snapshots", timeColumn: "captured_at", timeIndex: "idx_l2_depth_snapshots_captured_at" }),
    ]),
  }),
  dxfeed: Object.freeze({
    defaultDbPath: DXFEED_DB_PATH,
    createDb: createDxFeedStorageDb,
    tables: Object.freeze([
      Object.freeze({ table: "dxfeed_order_book_capture", timeColumn: "received_at", arrivalPrefix: true }),
      Object.freeze({ table: "dxfeed_time_and_sales", timeColumn: "event_time", timeIndex: "idx_dxfeed_time_and_sales_event_time" }),
      Object.freeze({ table: "dxfeed_quotes", timeColumn: "event_time", timeIndex: "idx_dxfeed_quotes_event_time" }),
      Object.freeze({ table: "dxfeed_trades", timeColumn: "event_time", timeIndex: "idx_dxfeed_trades_event_time" }),
    ]),
  }),
});

function retentionCutoffMs(nowMs, days) {
  return Math.floor(nowMs / DAY_MS) * DAY_MS - days * DAY_MS;
}

function idBounds(db, table) {
  const lo = db.prepare(`SELECT min(id) AS id FROM ${table}`).get().id;
  const hi = db.prepare(`SELECT max(id) AS id FROM ${table}`).get().id;
  return { lo, hi };
}

function rollupTradeIdLimit(db) {
  const read = db.prepare("SELECT last_trade_id FROM daily_notional_rollup_watermark WHERE symbol = ? AND market_kind = ?");
  let limit = null;
  for (const [symbol, marketKind] of SYMBOL_MARKET_PAIRS) {
    const row = read.get(symbol, marketKind);
    if (!row) return null;
    limit = limit === null ? row.last_trade_id : Math.min(limit, row.last_trade_id);
  }
  return limit;
}

function readExportWatermark(watermarkPath, readFileSync = fs.readFileSync) {
  const parsed = JSON.parse(readFileSync(watermarkPath, "utf8"));
  if (parsed?.version !== EXPORT_WATERMARK_VERSION || typeof parsed.targets !== "object" || parsed.targets === null ||
      typeof parsed.sources !== "object" || parsed.sources === null ||
      parsed.destination?.bucket !== "chartprime-historical-data" || parsed.destination?.prefix !== "raw/live-capture/") {
    throw new Error(`capture export watermark at ${watermarkPath} is not a version ${EXPORT_WATERMARK_VERSION} watermark`);
  }
  return parsed;
}

function exportLimitOf(watermark, target, table) {
  const through = watermark?.targets?.[target]?.[table]?.exportedThroughId;
  return Number.isSafeInteger(through) && through >= 0 ? through + 1 : null;
}

function planTable(db, spec, exportLimit) {
  const { lo, hi } = idBounds(db, spec.table);
  if (lo === null) return { table: spec.table, startId: null, endId: null, heldBy: null };
  let endId = hi + 1;
  let heldBy = null;
  if (spec.rollupWatermark) {
    const limit = rollupTradeIdLimit(db);
    if (limit === null) return { table: spec.table, startId: lo, endId: lo, heldBy: "rollup watermark missing" };
    if (limit < endId) {
      endId = limit;
      heldBy = limit < hi ? "rollup watermark" : null;
    }
  }
  if (exportLimit === null) return { table: spec.table, startId: lo, endId: lo, heldBy: "export watermark missing" };
  if (exportLimit < endId) {
    endId = Math.max(lo, exportLimit);
    heldBy = "export watermark";
  }
  return { table: spec.table, startId: lo, endId, heldBy };
}

function nextBatchRows(batchRows, elapsedMs) {
  if (elapsedMs > 2 * TARGET_BATCH_MS) return Math.max(MIN_BATCH_ROWS, Math.floor(batchRows / 2));
  if (elapsedMs < TARGET_BATCH_MS / 2) return Math.min(MAX_BATCH_ROWS, batchRows * 2);
  return batchRows;
}

function walBytesOf(dbPath, statSync) {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function expiredRowsDeleteSql(spec) {
  return `DELETE FROM ${spec.table} WHERE id IN (
    SELECT id FROM ${spec.table} INDEXED BY ${spec.timeIndex} WHERE id >= ? AND id < ? AND ${spec.timeColumn} < ?
    ORDER BY ${spec.timeColumn}, id LIMIT ?
  )`;
}

async function pruneTable(db, plan, spec, context) {
  const { cutoffMs, deadlineMs, now, sleep, dbPath, statSync, maxWalBytes } = context;
  const result = { table: spec.table, startId: plan.startId, endId: plan.endId, heldBy: plan.heldBy, deleted: 0, done: true };
  if (plan.startId === null || plan.endId <= plan.startId) return result;
  const remove = spec.arrivalPrefix ? null : db.prepare(expiredRowsDeleteSql(spec));
  const readPrefix = spec.arrivalPrefix ? db.prepare(`SELECT id, received_at FROM ${spec.table} WHERE id >= ? AND id < ? ORDER BY id LIMIT ?`) : null;
  const removePrefix = spec.arrivalPrefix ? db.prepare(`DELETE FROM ${spec.table} WHERE id >= ? AND id < ?`) : null;
  let cursor = plan.startId;
  const removeBatch = db.transaction((limit) => {
    if (!spec.arrivalPrefix) {
      const deleted = remove.run(plan.startId, plan.endId, cutoffMs, limit).changes;
      return { deleted, done: deleted < limit };
    }
    const rows = readPrefix.all(cursor, plan.endId, limit);
    const retained = rows.find((row) => row.received_at >= cutoffMs);
    const upper = retained?.id ?? (rows.length === 0 ? cursor : rows[rows.length - 1].id + 1);
    const deleted = removePrefix.run(cursor, upper).changes;
    cursor = upper;
    return { deleted, done: retained !== undefined || rows.length < limit };
  });
  let batchRows = INITIAL_BATCH_ROWS;
  for (;;) {
    while (now() < deadlineMs && walBytesOf(dbPath, statSync) > maxWalBytes) {
      db.pragma("wal_checkpoint(PASSIVE)");
      await sleep(Math.min(WAL_WAIT_MS, Math.max(0, deadlineMs - now())));
    }
    if (now() >= deadlineMs) {
      result.done = false;
      break;
    }
    db.pragma(`busy_timeout = ${Math.min(BUSY_TIMEOUT_MS, Math.max(1, Math.floor(deadlineMs - now())))}`);
    const startedAt = now();
    const batch = removeBatch.immediate(batchRows);
    result.deleted += batch.deleted;
    db.pragma("wal_checkpoint(PASSIVE)");
    if (batch.done) break;
    batchRows = nextBatchRows(batchRows, now() - startedAt);
    await sleep(Math.min(PAUSE_BETWEEN_BATCHES_MS, Math.max(0, deadlineMs - now())));
  }
  if (spec.arrivalPrefix) result.nextId = cursor;
  return result;
}

async function pruneTarget(name, { dbPath, dryRun, cutoffMs, deadlineMs, now, sleep, statSync, maxWalBytes, targets, watermark }) {
  const target = targets[name];
  if (!fs.existsSync(dbPath)) throw new Error(`${name} capture database not found at ${dbPath}`);
  const expectedSource = watermark.sources?.[name];
  const actualSource = { path: fs.realpathSync(dbPath).replaceAll("\\", "/"), fileId: String(fs.statSync(dbPath, { bigint: true }).ino) };
  if (Object.keys(watermark.targets?.[name] ?? {}).length > 0 &&
      (expectedSource?.path !== actualSource.path || expectedSource?.fileId !== actualSource.fileId)) {
    throw new Error(`${name} capture export watermark belongs to another database`);
  }
  const storageDb = target.createDb({ dbPath, bootstrap: false, verifyIntegrity: false, readonly: dryRun });
  try {
    const db = storageDb.raw;
    const sessionTable = name === "binance" ? "capture_sessions" : "dxfeed_capture_sessions";
    const firstSessionId = db.prepare(`SELECT session_id FROM ${sessionTable} ORDER BY rowid LIMIT 1`).get()?.session_id ?? null;
    if (Object.keys(watermark.targets?.[name] ?? {}).length > 0 && expectedSource.firstSessionId !== firstSessionId) {
      throw new Error(`${name} capture database generation changed`);
    }
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const tables = [];
    for (const [index, spec] of target.tables.entries()) {
      const plan = planTable(db, spec, exportLimitOf(watermark, name, spec.table));
      if (dryRun) {
        tables.push({ ...plan, deleted: 0, done: false });
        continue;
      }
      const tableDeadlineMs = now() + Math.max(0, deadlineMs - now()) / (target.tables.length - index);
      tables.push(await pruneTable(db, plan, spec, { cutoffMs, deadlineMs: tableDeadlineMs, now, sleep, dbPath, statSync, maxWalBytes }));
      if (now() >= deadlineMs) break;
    }
    const done = !dryRun && tables.length === target.tables.length && tables.every((table) => table.done);
    return { target: name, dbPath, dryRun, done, tables };
  } finally {
    storageDb.close();
  }
}

function parseArgs(argv) {
  const options = {
    target: "all", days: DEFAULT_RETENTION_DAYS, maxSeconds: DEFAULT_MAX_SECONDS, dryRun: false, dbPaths: {},
    exportWatermarkPath: DEFAULT_EXPORT_WATERMARK_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--target" && value !== undefined) {
      if (value !== "all" && !Object.hasOwn(TARGETS, value)) throw new Error(`unknown target ${value}`);
      options.target = value;
      index += 1;
    } else if ((flag === "--days" || flag === "--max-seconds") && value !== undefined) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
      if (flag === "--days") options.days = number;
      else options.maxSeconds = number;
      index += 1;
    } else if ((flag === "--binance-db" || flag === "--dxfeed-db") && value !== undefined) {
      options.dbPaths[flag === "--binance-db" ? "binance" : "dxfeed"] = value;
      index += 1;
    } else if (flag === "--export-watermark" && value !== undefined) {
      options.exportWatermarkPath = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete option ${flag}`);
    }
  }
  return options;
}

async function main({
  argv = process.argv.slice(2),
  logger = createCliLogger({ name: "prune-capture-retention" }),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  statSync = fs.statSync,
  maxWalBytes = DEFAULT_MAX_WAL_BYTES,
  targets = TARGETS,
  readWatermark = readExportWatermark,
  exit = process.exit,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    logger.error("capture retention configuration rejected", { reason: error.message });
    await flushAndExit(logger, exit, CONFIG_EXIT_CODE);
    return CONFIG_EXIT_CODE;
  }
  let watermark;
  try {
    watermark = readWatermark(options.exportWatermarkPath);
  } catch (error) {
    logger.error("capture retention held: the export watermark is missing or unreadable", {
      watermarkPath: options.exportWatermarkPath,
      reason: error?.message ?? error,
    });
    await flushAndExit(logger, exit, 1);
    return 1;
  }
  const startedAt = now();
  const deadlineMs = startedAt + options.maxSeconds * 1_000;
  const cutoffMs = retentionCutoffMs(startedAt, options.days);
  const names = options.target === "all" ? Object.keys(targets) : [options.target];
  let exitCode = 0;
  for (const [index, name] of names.entries()) {
    const dbPath = options.dbPaths[name] ?? targets[name].defaultDbPath;
    try {
      const targetDeadlineMs = now() + Math.max(0, deadlineMs - now()) / (names.length - index);
      const summary = await pruneTarget(name, {
        dbPath, dryRun: options.dryRun, cutoffMs, deadlineMs: targetDeadlineMs, now, sleep, statSync, maxWalBytes, targets, watermark,
      });
      logger.ok("capture retention pass finished", {
        ...summary,
        cutoff: new Date(cutoffMs).toISOString(),
        retentionDays: options.days,
        seconds: Math.round((now() - startedAt) / 1_000),
        dbBytes: statSync(dbPath).size,
        walBytes: walBytesOf(dbPath, statSync),
      });
    } catch (error) {
      exitCode = 1;
      logger.error("capture retention pass failed", {
        target: name,
        dbPath,
        reason: error?.message ?? error,
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
      });
    }
    if (now() >= deadlineMs) break;
  }
  await flushAndExit(logger, exit, exitCode);
  return exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("prune-capture-retention: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  retentionCutoffMs,
  rollupTradeIdLimit,
  readExportWatermark,
  exportLimitOf,
  planTable,
  pruneTable,
  expiredRowsDeleteSql,
  nextBatchRows,
  TARGETS,
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_EXPORT_WATERMARK_PATH,
};
