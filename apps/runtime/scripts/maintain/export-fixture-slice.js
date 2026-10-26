#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { createStorageDb, verifyStorageIntegrity, SCHEMA_VERSION } = require("../../src/storage/storage-db");
const { createDxFeedStorageDb, verifyDxFeedStorageIntegrity, SCHEMA_VERSION: DXFEED_SCHEMA_VERSION } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { ANCHOR_SLACK_MS } = require("../../src/indicators/l2-memory/replay-source");
const { listCollectorInstruments } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const {
  sha256File, tableColumns, describeTables, summarizeNumbers, perSecond, upsertInventoryEntry, validateInventoryEntry,
  buildBinanceAcceptance, buildDxFeedAcceptance, evaluateAcceptance,
} = require("./fixture-lib");
const { computeReplayPin, DEFAULT_GEOMETRY } = require("./fixture-replay-pin");

const EXPORTER_VERSION = 1;
const BINANCE_SOURCE_SCHEMA_VERSIONS = Object.freeze([15, 16]);
const DXFEED_SOURCE_SCHEMA_VERSIONS = Object.freeze([21, 22]);
const SOURCE_BUSY_TIMEOUT_MS = 15_000;
const CANDLE_INTERVAL_MS = 60_000;
const SNAPSHOT_BEGIN_BIT = 4;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
const MAX_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;
const DEFAULT_FIXTURE_DIR = path.resolve(__dirname, "../../data/fixtures");
const DEFAULT_INVENTORY = path.resolve(__dirname, "../../../../benchmarks/fixtures/inventory.json");
const DEFAULT_REFERENCE_FILE = path.resolve(__dirname, "../../../../benchmarks/fixtures/production-reference.json");

const BINANCE_TABLES = Object.freeze([
  Object.freeze({ table: "capture_sessions", orderBy: "session_id" }),
  Object.freeze({ table: "capture_incidents", orderBy: "id" }),
  Object.freeze({ table: "trades", orderBy: "id" }),
  Object.freeze({ table: "candles", orderBy: "id" }),
  Object.freeze({ table: "l2_depth_snapshots", orderBy: "id" }),
  Object.freeze({ table: "l2_depth_events", orderBy: "id" }),
]);

const DXFEED_TABLES = Object.freeze([
  Object.freeze({ table: "dxfeed_capture_sessions", orderBy: "session_id" }),
  Object.freeze({ table: "dxfeed_order_book_capture", orderBy: "id" }),
  Object.freeze({ table: "dxfeed_time_and_sales", orderBy: "id" }),
  Object.freeze({ table: "dxfeed_quotes", orderBy: "id" }),
  Object.freeze({ table: "dxfeed_trades", orderBy: "id" }),
  Object.freeze({ table: "dxfeed_candles", orderBy: "id" }),
]);

const BINANCE_GOVERNANCE = Object.freeze({
  dataClass: "public-exchange-market-data",
  retention: "local-only-git-ignored",
  basis: "Public Binance market-data feed captured by the project's own collector. The rows stay in the git-ignored data directory; the inventory records only hashes, counts and statistics.",
});

const DXFEED_GOVERNANCE = Object.freeze({
  dataClass: "licensed-vendor-market-data",
  retention: "local-only-git-ignored",
  basis: "dxFeed/CME data already captured by the project's licensed collector for development use. Sliced from an existing database without opening any dxFeed connection; the rows stay in the git-ignored data directory and are never committed; the inventory records only hashes, counts and statistics.",
});

class FixtureExportError extends Error {
  constructor(code, message) {
    super(`fixture-export: ${code}: ${message}`);
    this.code = code;
  }
}

function fileIdentity(file) {
  const stat = fs.statSync(file);
  return { dev: stat.dev, ino: stat.ino, sizeBytes: stat.size };
}

function validateCommon({ id, sourcePath, symbol, fromTs, toTs }) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new FixtureExportError("INVALID_ID", "id must be a lowercase slug of 3-80 characters");
  if (typeof sourcePath !== "string" || !fs.existsSync(sourcePath)) throw new FixtureExportError("SOURCE_MISSING", "source database does not exist");
  if (typeof symbol !== "string" || symbol.length === 0) throw new FixtureExportError("INVALID_SYMBOL", "symbol is required");
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs < 0 || toTs <= fromTs || toTs - fromTs > MAX_WINDOW_MS) {
    throw new FixtureExportError("INVALID_WINDOW", `fromTs/toTs must be safe integers with 0 < window <= ${MAX_WINDOW_MS} ms`);
  }
}

function copyTable(source, target, { table, orderBy, where = "1=1", params = [] }) {
  const sourceColumns = new Set(tableColumns(source, table));
  const columns = tableColumns(target, table).filter((column) => sourceColumns.has(column));
  const select = source.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${where} ORDER BY ${orderBy}`).raw(true);
  const insert = target.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  let rows = 0;
  for (const row of select.iterate(...params)) {
    insert.run(...row);
    rows += 1;
  }
  return rows;
}

function inList(values) {
  return values.map(() => "?").join(",");
}

function computeBinanceStats(db, { symbol, marketKind, fromTs, toTs, anchor }) {
  const windowMs = toTs - fromTs;
  const levels = db.prepare(
    "SELECT json_array_length(bids) + json_array_length(asks) AS levels FROM l2_depth_events WHERE symbol = ? AND market_kind = ? AND ts BETWEEN ? AND ? ORDER BY id",
  ).raw(true).all(symbol, marketKind, fromTs, toTs).map(([count]) => count);
  const snapshotTimes = db.prepare(
    "SELECT captured_at FROM l2_depth_snapshots WHERE symbol = ? AND market_kind = ? AND captured_at BETWEEN ? AND ? ORDER BY captured_at, id",
  ).raw(true).all(symbol, marketKind, anchor.captured_at, toTs).map(([capturedAt]) => capturedAt);
  const snapshotGaps = snapshotTimes.slice(1).map((time, index) => time - snapshotTimes[index]);
  const tradeCount = db.prepare(
    "SELECT COUNT(*) AS count FROM trades WHERE symbol = ? AND market_kind = ? AND ts BETWEEN ? AND ?",
  ).get(symbol, marketKind, fromTs, toTs).count;
  return {
    windowMs,
    events: { inWindow: levels.length, perSecond: perSecond(levels.length, windowMs), levelsPerEvent: summarizeNumbers(levels) },
    snapshots: { fromAnchorToEnd: snapshotTimes.length, gapMs: summarizeNumbers(snapshotGaps) },
    trades: { inWindow: tradeCount, perSecond: perSecond(tradeCount, windowMs) },
  };
}

function computeDxFeedStats(db, { symbol, assetClass, orderSource, fromTs, toTs, anchor }) {
  const windowMs = toTs - fromTs;
  const orderRowsInWindow = db.prepare(
    "SELECT COUNT(*) AS count FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time BETWEEN ? AND ?",
  ).get(symbol, assetClass, orderSource, fromTs, toTs).count;
  const orderRowsSinceAnchor = db.prepare(
    "SELECT COUNT(*) AS count FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time BETWEEN ? AND ?",
  ).get(symbol, assetClass, orderSource, anchor.eventTime, toTs).count;
  const snapshotTimes = db.prepare(
    "SELECT DISTINCT event_time FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time BETWEEN ? AND ? AND (event_flags & 4) != 0 ORDER BY event_time",
  ).raw(true).all(symbol, assetClass, orderSource, anchor.eventTime, toTs).map(([eventTime]) => eventTime);
  const snapshotGaps = snapshotTimes.slice(1).map((time, index) => time - snapshotTimes[index]);
  const tapeRows = db.prepare(
    "SELECT COUNT(*) AS count FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? AND event_time BETWEEN ? AND ?",
  ).get(symbol, assetClass, fromTs, toTs).count;
  const quoteRows = db.prepare(
    "SELECT COUNT(*) AS count FROM dxfeed_quotes WHERE symbol = ? AND asset_class = ? AND event_time BETWEEN ? AND ?",
  ).get(symbol, assetClass, fromTs, toTs).count;
  return {
    windowMs,
    orders: { inWindow: orderRowsInWindow, perSecond: perSecond(orderRowsInWindow, windowMs), sinceAnchor: orderRowsSinceAnchor },
    snapshotBegin: { fromAnchorToEnd: snapshotTimes.length, gapMs: summarizeNumbers(snapshotGaps) },
    tape: { inWindow: tapeRows, perSecond: perSecond(tapeRows, windowMs) },
    quotes: { inWindow: quoteRows },
  };
}

const BINANCE_ADAPTER = Object.freeze({
  provider: "binance",
  tables: BINANCE_TABLES,
  schemaTable: "storage_schema",
  acceptedSchemaVersions: BINANCE_SOURCE_SCHEMA_VERSIONS,
  appSchemaVersion: SCHEMA_VERSION,
  governance: BINANCE_GOVERNANCE,
  noAnchorMessage: "no depth snapshot at or before the window start, or inside the window, so it cannot be replayed",
  validate({ marketKind }) {
    if (marketKind !== "SPOT" && marketKind !== "PERPETUAL") throw new FixtureExportError("INVALID_MARKET_KIND", "marketKind must be SPOT or PERPETUAL");
  },
  identity: ({ symbol, marketKind }) => ({ symbol, marketKind }),
  createOutput: (dbPath) => createStorageDb({ dbPath }),
  verifyOutput: (dbPath) => verifyStorageIntegrity({ dbPath }),
  pickAnchor(source, { symbol, marketKind, fromTs, toTs }) {
    const row = source.prepare(
      "SELECT id, captured_at, last_update_id FROM l2_depth_snapshots WHERE symbol = ? AND market_kind = ? AND captured_at <= ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    ).get(symbol, marketKind, fromTs) ?? source.prepare(
      "SELECT id, captured_at, last_update_id FROM l2_depth_snapshots WHERE symbol = ? AND market_kind = ? AND captured_at > ? AND captured_at <= ? ORDER BY captured_at ASC, id ASC LIMIT 1",
    ).get(symbol, marketKind, fromTs, toTs);
    return row === undefined ? null : { ...row, eventTime: row.captured_at };
  },
  sourceFacts(source, { symbol, marketKind }) {
    const span = source.prepare("SELECT MIN(ts) AS fromTs, MAX(ts) AS toTs FROM l2_depth_events WHERE symbol = ? AND market_kind = ?").get(symbol, marketKind);
    const maxIds = Object.fromEntries(["l2_depth_events", "trades", "l2_depth_snapshots"].map((table) => [table, source.prepare(`SELECT MAX(id) AS id FROM ${table}`).get().id]));
    return { captureSpan: { fromTs: span.fromTs, toTs: span.toTs }, maxIds };
  },
  windowInfo({ fromTs, toTs }, anchor) {
    return {
      fromTs, toTs, anchorCapturedAt: anchor.captured_at, anchorLastUpdateId: anchor.last_update_id,
      eventFromTs: anchor.captured_at - ANCHOR_SLACK_MS, tradeFromTs: Math.min(fromTs, anchor.captured_at),
    };
  },
  exporterExtras: { anchorSlackMs: ANCHOR_SLACK_MS },
  plan(source, { symbol, marketKind, fromTs, toTs }, anchor) {
    const tradeFrom = Math.min(fromTs, anchor.captured_at);
    const eventFrom = anchor.captured_at - ANCHOR_SLACK_MS;
    const sessionIds = source.prepare(
      "SELECT session_id FROM capture_sessions WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY session_id",
    ).pluck().all(toTs, tradeFrom);
    const placeholders = inList(sessionIds);
    return [
      { table: "capture_sessions", orderBy: "session_id", where: `session_id IN (${placeholders})`, params: sessionIds, skip: sessionIds.length === 0 },
      { table: "capture_incidents", orderBy: "id", where: `session_id IN (${placeholders}) AND ts BETWEEN ? AND ?`, params: [...sessionIds, tradeFrom, toTs], skip: sessionIds.length === 0 },
      { table: "trades", orderBy: "id", where: "symbol = ? AND market_kind = ? AND ts BETWEEN ? AND ?", params: [symbol, marketKind, tradeFrom, toTs] },
      {
        table: "candles", orderBy: "id", where: "symbol = ? AND market_kind = ? AND ts_open BETWEEN ? AND ?",
        params: [symbol, marketKind, Math.floor(tradeFrom / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS, toTs],
      },
      { table: "l2_depth_snapshots", orderBy: "id", where: "symbol = ? AND market_kind = ? AND captured_at BETWEEN ? AND ?", params: [symbol, marketKind, anchor.captured_at, toTs] },
      { table: "l2_depth_events", orderBy: "id", where: "symbol = ? AND market_kind = ? AND ts BETWEEN ? AND ?", params: [symbol, marketKind, eventFrom, toTs] },
    ];
  },
  computeStats: (db, request, anchor) => computeBinanceStats(db, { ...request, anchor }),
  buildAcceptance: buildBinanceAcceptance,
});

const DXFEED_ADAPTER = Object.freeze({
  provider: "dxfeed",
  tables: DXFEED_TABLES,
  schemaTable: "dxfeed_storage_schema",
  acceptedSchemaVersions: DXFEED_SOURCE_SCHEMA_VERSIONS,
  appSchemaVersion: DXFEED_SCHEMA_VERSION,
  governance: DXFEED_GOVERNANCE,
  noAnchorMessage: "no snapshot-begin order-book row at or before the window start, or inside the window, so it cannot be replayed",
  validate({ assetClass, orderSource }) {
    if (assetClass !== "FUTURE" && assetClass !== "EQUITY") throw new FixtureExportError("INVALID_ASSET_CLASS", "assetClass must be FUTURE or EQUITY");
    if (typeof orderSource !== "string" || orderSource.length === 0) throw new FixtureExportError("INVALID_ORDER_SOURCE", "orderSource is required");
  },
  identity: ({ symbol, assetClass, orderSource }) => ({ symbol, assetClass, orderSource }),
  createOutput: (dbPath) => createDxFeedStorageDb({ dbPath }),
  verifyOutput: (dbPath) => verifyDxFeedStorageIntegrity({ dbPath }),
  pickAnchor(source, { symbol, assetClass, orderSource, fromTs, toTs }) {
    const row = source.prepare(
      "SELECT id, event_time FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time <= ? AND (event_flags & 4) != 0 ORDER BY event_time DESC, id DESC LIMIT 1",
    ).get(symbol, assetClass, orderSource, fromTs) ?? source.prepare(
      "SELECT id, event_time FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time > ? AND event_time <= ? AND (event_flags & 4) != 0 ORDER BY event_time ASC, id ASC LIMIT 1",
    ).get(symbol, assetClass, orderSource, fromTs, toTs);
    return row === undefined ? null : { id: row.id, eventTime: row.event_time };
  },
  sourceFacts(source, { symbol, assetClass, orderSource }) {
    const span = source.prepare(
      "SELECT MIN(event_time) AS fromTs, MAX(event_time) AS toTs FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ?",
    ).get(symbol, assetClass, orderSource);
    const maxIds = Object.fromEntries(["dxfeed_order_book_capture", "dxfeed_time_and_sales", "dxfeed_quotes"].map((table) => [table, source.prepare(`SELECT MAX(id) AS id FROM ${table}`).get().id]));
    return { captureSpan: { fromTs: span.fromTs, toTs: span.toTs }, maxIds };
  },
  windowInfo({ fromTs, toTs }, anchor) {
    return { fromTs, toTs, anchorEventTime: anchor.eventTime, orderFromTs: anchor.eventTime, tapeFromTs: fromTs };
  },
  exporterExtras: {},
  plan(source, { symbol, assetClass, orderSource, fromTs, toTs }, anchor) {
    const sessionIds = source.prepare(
      "SELECT session_id FROM dxfeed_capture_sessions WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY session_id",
    ).pluck().all(toTs, anchor.eventTime);
    const identity = "symbol = ? AND asset_class = ?";
    return [
      { table: "dxfeed_capture_sessions", orderBy: "session_id", where: `session_id IN (${inList(sessionIds)})`, params: sessionIds, skip: sessionIds.length === 0 },
      { table: "dxfeed_order_book_capture", orderBy: "id", where: `${identity} AND source = ? AND event_time BETWEEN ? AND ?`, params: [symbol, assetClass, orderSource, anchor.eventTime, toTs] },
      { table: "dxfeed_time_and_sales", orderBy: "id", where: `${identity} AND event_time BETWEEN ? AND ?`, params: [symbol, assetClass, fromTs, toTs] },
      { table: "dxfeed_quotes", orderBy: "id", where: `${identity} AND event_time BETWEEN ? AND ?`, params: [symbol, assetClass, fromTs, toTs] },
      { table: "dxfeed_trades", orderBy: "id", where: `${identity} AND event_time BETWEEN ? AND ?`, params: [symbol, assetClass, fromTs, toTs] },
      { table: "dxfeed_candles", orderBy: "id", where: `${identity} AND ts_open BETWEEN ? AND ?`, params: [symbol, assetClass, Math.floor(fromTs / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS, toTs] },
    ];
  },
  computeStats: (db, request, anchor) => computeDxFeedStats(db, { ...request, anchor }),
  buildAcceptance: buildDxFeedAcceptance,
});

function runExport(adapter, request) {
  const {
    id, sourcePath, outputDir = DEFAULT_FIXTURE_DIR, inventoryPath = null, overwrite = false, hooks = {},
    reference = null, allowFailingAcceptance = false,
  } = request;
  const identityOf = hooks.identityOf ?? fileIdentity;
  validateCommon(request);
  adapter.validate(request);
  const finalPath = path.join(outputDir, `${id}.sqlite`);
  if (fs.existsSync(finalPath) && !overwrite) throw new FixtureExportError("OUTPUT_EXISTS", `${finalPath} already exists; pass overwrite to replace it`);
  fs.mkdirSync(outputDir, { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  for (const leftover of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) fs.rmSync(leftover, { force: true });

  const identityBefore = identityOf(sourcePath);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: SOURCE_BUSY_TIMEOUT_MS });
  let target = null;
  let completed = false;
  try {
    source.pragma("query_only = ON");
    source.exec("BEGIN");
    const schemaVersion = source.prepare(`SELECT version FROM ${adapter.schemaTable}`).pluck().get();
    if (!adapter.acceptedSchemaVersions.includes(schemaVersion)) {
      throw new FixtureExportError("UNSUPPORTED_SOURCE_SCHEMA", `source schema version ${String(schemaVersion)} is not one of ${adapter.acceptedSchemaVersions.join(", ")}`);
    }
    const dataVersionBefore = source.pragma("data_version", { simple: true });
    const journalMode = source.pragma("journal_mode", { simple: true });
    const anchor = adapter.pickAnchor(source, request);
    if (anchor === null) throw new FixtureExportError("NO_ANCHOR", adapter.noAnchorMessage);

    const facts = adapter.sourceFacts(source, request);
    const sourceSqlite = source.prepare("SELECT sqlite_version() AS version").get().version;

    const storage = adapter.createOutput(temporaryPath);
    target = storage;
    const plan = adapter.plan(source, request, anchor);
    storage.raw.exec("BEGIN");
    const copied = {};
    for (const item of plan) {
      copied[item.table] = item.skip === true ? 0 : copyTable(source, storage.raw, item);
      hooks.afterTable?.(item.table);
    }
    storage.raw.exec("COMMIT");

    const dataVersionAfterCopy = source.pragma("data_version", { simple: true });
    source.exec("COMMIT");
    const dataVersionAfter = source.pragma("data_version", { simple: true });
    const identityAfter = identityOf(sourcePath);
    if (identityAfter.dev !== identityBefore.dev || identityAfter.ino !== identityBefore.ino || identityAfter.sizeBytes < identityBefore.sizeBytes) {
      throw new FixtureExportError("SOURCE_REPLACED_DURING_EXPORT", "the source file was replaced or truncated while it was being read; the slice was discarded");
    }

    storage.raw.pragma("wal_checkpoint(TRUNCATE)");
    const fixtureJournalMode = storage.raw.pragma("journal_mode = DELETE", { simple: true });
    if (fixtureJournalMode !== "delete") throw new FixtureExportError("JOURNAL_MODE", `could not switch the fixture to rollback-journal mode, got ${String(fixtureJournalMode)}`);
    const stats = adapter.computeStats(storage.raw, request, anchor);
    const tables = describeTables(storage.raw, adapter.tables);
    const foreignKeyViolations = storage.raw.pragma("foreign_key_check").length;
    const quickCheck = storage.raw.pragma("quick_check", { simple: true });
    const outputSqlite = storage.raw.prepare("SELECT sqlite_version() AS version").get().version;
    storage.close();
    target = null;
    adapter.verifyOutput(temporaryPath);
    for (const sidecar of [`${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      if (fs.existsSync(sidecar)) throw new FixtureExportError("SIDECAR_FILES_REMAIN", `${path.basename(sidecar)} remained after checkpoint and close`);
    }
    if (foreignKeyViolations !== 0 || quickCheck !== "ok") throw new FixtureExportError("INTEGRITY_FAILED", `quick_check=${String(quickCheck)} foreign_key_violations=${foreignKeyViolations}`);

    const fileSha256 = sha256File(temporaryPath);
    const sizeBytes = fs.statSync(temporaryPath).size;
    const entry = {
      id,
      provider: adapter.provider,
      ...adapter.identity(request),
      window: adapter.windowInfo(request, anchor),
      source: {
        basename: path.basename(sourcePath),
        sizeBytes: identityBefore.sizeBytes,
        schemaVersion,
        journalMode,
        captureSpan: facts.captureSpan,
        maxIds: facts.maxIds,
        sqliteVersion: sourceSqlite,
        advancedDuringExport: dataVersionAfterCopy !== dataVersionBefore || dataVersionAfter !== dataVersionBefore || identityAfter.sizeBytes !== identityBefore.sizeBytes,
      },
      exporter: { version: EXPORTER_VERSION, appSchemaVersion: adapter.appSchemaVersion, sqliteVersion: outputSqlite, ...adapter.exporterExtras },
      file: { name: `${id}.sqlite`, sizeBytes, sha256: fileSha256, journalMode: fixtureJournalMode },
      tables,
      integrity: { quickCheck, foreignKeyViolations },
      stats,
      governance: { ...adapter.governance },
    };
    if (reference !== null) {
      const acceptance = adapter.buildAcceptance(reference);
      const evaluated = evaluateAcceptance(stats, acceptance.criteria);
      entry.acceptance = { ...acceptance, results: evaluated.results, pass: evaluated.pass };
      if (!evaluated.pass && !allowFailingAcceptance) {
        const failed = evaluated.results.filter((result) => !result.pass).map((result) => `${result.metric}=${String(result.observed)} outside [${result.min ?? "-"}, ${result.max ?? "-"}]`);
        throw new FixtureExportError("ACCEPTANCE_FAILED", `the window does not match the production reference: ${failed.join("; ")}`);
      }
    }
    const problems = validateInventoryEntry(entry);
    if (problems.length > 0) throw new FixtureExportError("INVALID_INVENTORY_ENTRY", problems.join("; "));
    fs.renameSync(temporaryPath, finalPath);
    completed = true;
    if (inventoryPath !== null) upsertInventoryEntry(inventoryPath, entry);
    return Object.freeze({ path: finalPath, copied, entry });
  } finally {
    try { if (source.inTransaction) source.exec("ROLLBACK"); } catch { void 0; }
    source.close();
    if (target !== null) {
      try { target.close(); } catch { void 0; }
    }
    if (!completed) {
      for (const leftover of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) fs.rmSync(leftover, { force: true });
    }
  }
}

const exportBinanceSlice = (request) => runExport(BINANCE_ADAPTER, request);
const exportDxFeedSlice = (request) => runExport(DXFEED_ADAPTER, request);

function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) throw new FixtureExportError("INVALID_DURATION", `duration must look like 90s, 30m or 4h, got ${text}`);
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]];
}

function parseInstant(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new FixtureExportError("INVALID_INSTANT", `could not read ${text} as an instant`);
  return parsed;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--overwrite") { options.overwrite = true; continue; }
    if (flag === "--no-pin") { options.noPin = true; continue; }
    if (flag === "--allow-failing-acceptance") { options.allowFailingAcceptance = true; continue; }
    if (!flag.startsWith("--") || argv[index + 1] === undefined) throw new FixtureExportError("USAGE", `unexpected argument ${flag}`);
    options[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function positiveNumber(text, name) {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new FixtureExportError("USAGE", `--${name} must be a positive number`);
  return value;
}

function readReference(options, provider) {
  if (options.reference === undefined) return null;
  const referenceFile = options["reference-file"] === undefined ? DEFAULT_REFERENCE_FILE : path.resolve(options["reference-file"]);
  const referenceEntry = JSON.parse(fs.readFileSync(referenceFile, "utf8"))?.[provider]?.hourlyReferences?.[options.reference];
  if (referenceEntry === undefined) throw new FixtureExportError("UNKNOWN_REFERENCE", `no ${provider} hourly reference named ${options.reference} in ${path.basename(referenceFile)}`);
  return { referenceKey: options.reference, reference: referenceEntry };
}

function defaultOrderSource(symbol, assetClass) {
  return listCollectorInstruments().find((instrument) => instrument.symbol === symbol && instrument.assetClass === assetClass)?.orderSource;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const provider = options.provider ?? "binance";
  if (provider !== "binance" && provider !== "dxfeed") throw new FixtureExportError("UNSUPPORTED_PROVIDER", `provider ${provider} is not supported`);
  const identityFlag = provider === "binance" ? "market-kind" : "asset-class";
  for (const required of ["source", "id", "symbol", identityFlag, "from", "duration"]) {
    if (options[required] === undefined) {
      throw new FixtureExportError("USAGE", `--${required} is required (also accepts --provider, --order-source, --output-dir, --inventory, --overwrite, --no-pin, --pin-duration, --pin-pages, --reference, --reference-file, --allow-failing-acceptance, --tick-size, --cluster-ticks, --row-clusters, --window-rows)`);
    }
  }
  const fromTs = parseInstant(options.from);
  const toTs = fromTs + parseDuration(options.duration);
  const pinToTs = options["pin-duration"] === undefined ? toTs : Math.min(toTs, fromTs + parseDuration(options["pin-duration"]));
  const pinWindow = pinToTs === toTs ? undefined : { fromTs, toTs: pinToTs };
  const pageLimit = options["pin-pages"] === undefined ? undefined : positiveNumber(options["pin-pages"], "pin-pages");
  if (pageLimit !== undefined && !Number.isSafeInteger(pageLimit)) throw new FixtureExportError("USAGE", "--pin-pages must be a positive integer");
  const geometry = {
    tickSize: options["tick-size"] === undefined ? DEFAULT_GEOMETRY.tickSize : positiveNumber(options["tick-size"], "tick-size"),
    clusterTicks: options["cluster-ticks"] === undefined ? DEFAULT_GEOMETRY.clusterTicks : positiveNumber(options["cluster-ticks"], "cluster-ticks"),
    rowClusters: options["row-clusters"] === undefined ? DEFAULT_GEOMETRY.rowClusters : positiveNumber(options["row-clusters"], "row-clusters"),
    windowRows: options["window-rows"] === undefined ? DEFAULT_GEOMETRY.windowRows : positiveNumber(options["window-rows"], "window-rows"),
  };
  const inventoryPath = options.inventory === undefined ? DEFAULT_INVENTORY : path.resolve(options.inventory);
  const request = {
    id: options.id,
    sourcePath: path.resolve(options.source),
    symbol: options.symbol,
    fromTs,
    toTs,
    outputDir: options["output-dir"] === undefined ? DEFAULT_FIXTURE_DIR : path.resolve(options["output-dir"]),
    overwrite: options.overwrite === true,
    reference: readReference(options, provider),
    allowFailingAcceptance: options.allowFailingAcceptance === true,
  };
  let result;
  let identity;
  if (provider === "binance") {
    identity = { marketKind: options["market-kind"] };
    result = exportBinanceSlice({ ...request, ...identity });
  } else {
    const orderSource = options["order-source"] ?? defaultOrderSource(options.symbol, options["asset-class"]);
    identity = { assetClass: options["asset-class"], orderSource };
    result = exportDxFeedSlice({ ...request, ...identity });
  }
  const { entry } = result;
  if (options.noPin !== true) {
    entry.replayPin = await computeReplayPin({
      provider,
      dbPath: result.path,
      symbol: options.symbol,
      marketKind: provider === "binance" ? identity.marketKind : identity.assetClass,
      fromTs,
      toTs: pinToTs,
      pinWindow,
      pageLimit,
      geometry,
      onProgress: ({ pages, frames, complete }) => process.stderr.write(`replay pin: page ${pages}, ${frames} frames${complete ? ", complete" : ""}\n`),
    });
  }
  upsertInventoryEntry(inventoryPath, entry);
  process.stdout.write(`${JSON.stringify({ path: result.path, copied: result.copied, fileSha256: entry.file.sha256, sizeBytes: entry.file.sizeBytes, stats: entry.stats, replayPin: entry.replayPin ?? null }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = error instanceof FixtureExportError ? 2 : 1;
  });
}

module.exports = {
  main, exportBinanceSlice, exportDxFeedSlice, computeBinanceStats, computeDxFeedStats, FixtureExportError, BINANCE_TABLES, DXFEED_TABLES,
  EXPORTER_VERSION, DEFAULT_FIXTURE_DIR, DEFAULT_INVENTORY, DEFAULT_REFERENCE_FILE, parseDuration, parseInstant, SNAPSHOT_BEGIN_BIT,
};
