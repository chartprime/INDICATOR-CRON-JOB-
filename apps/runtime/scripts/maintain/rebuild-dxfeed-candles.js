#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDxFeedBarAggregator } = require("../../src/providers/dxfeed/dxfeed-bar-aggregator");
const {
  BAR_ELIGIBILITY_REASONS,
  classifyStoredDxFeedTimeAndSaleRowForBar,
  adaptStoredDxFeedTimeAndSaleRowForBar,
} = require("../../src/providers/dxfeed/dxfeed-trade-adapter");
const { listCollectorInstruments } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { createDxFeedStorageService } = require("../../src/storage/dxfeed/dxfeed-storage-service");
const { DEFAULT_DB_PATH, SCHEMA_VERSION } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");

const MINUTE_MS = 60_000;
const EPSILON = 1e-9;
const COMPARED_FIELDS = Object.freeze(["open", "high", "low", "close", "volume", "buy_volume", "sell_volume", "trade_count"]);

class RebuildError extends Error {}

function parseInstant(raw, flag) {
  if (typeof raw !== "string" || raw.trim() === "") throw new RebuildError(`${flag} requires a value`);
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RebuildError(`${flag} must be an ISO time or epoch milliseconds`);
  if (ms % MINUTE_MS !== 0) throw new RebuildError(`${flag} must fall on a whole minute`);
  return ms;
}

function parseArgs(argv) {
  const options = { dbPath: DEFAULT_DB_PATH, write: false, symbols: [], from: null, to: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--write") options.write = true;
    else if (arg === "--db") { options.dbPath = value; index += 1; }
    else if (arg === "--from") { options.from = parseInstant(value, "--from"); index += 1; }
    else if (arg === "--to") { options.to = parseInstant(value, "--to"); index += 1; }
    else if (arg === "--symbol") { options.symbols.push(value); index += 1; }
    else if (arg === "--report") { options.report = value; index += 1; }
    else throw new RebuildError(`unsupported argument ${String(arg)}`);
  }
  if (typeof options.dbPath !== "string" || options.dbPath.trim() === "") throw new RebuildError("--db requires a path");
  if (options.from === null || options.to === null) throw new RebuildError("--from and --to are required");
  if (options.to <= options.from) throw new RebuildError("--to must be after --from");
  if (options.symbols.some((symbol) => typeof symbol !== "string" || symbol.trim() === "")) throw new RebuildError("--symbol requires a value");
  return options;
}

function selectInstruments(requested, catalog = listCollectorInstruments()) {
  if (requested.length === 0) return catalog;
  const unknown = requested.filter((symbol) => !catalog.some((instrument) => instrument.symbol === symbol));
  if (unknown.length > 0) {
    throw new RebuildError(`not in the governed dxFeed catalog, so the live rules cannot rebuild it: ${unknown.join(", ")}`);
  }
  return catalog.filter((instrument) => requested.includes(instrument.symbol));
}

function rebuildMinute(instrument, tsOpen, rows) {
  const aggregator = createDxFeedBarAggregator({ finalityDelayMs: 0 });
  const rejected = {};
  const dropped = {};
  let accepted = 0;
  for (const row of rows) {
    const reason = classifyStoredDxFeedTimeAndSaleRowForBar(row, { requireValidTick: true });
    if (reason !== BAR_ELIGIBILITY_REASONS.ACCEPTED) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    const result = aggregator.ingest(adaptStoredDxFeedTimeAndSaleRowForBar(row));
    if (result.dropped) {
      dropped[result.dropReason] = (dropped[result.dropReason] ?? 0) + 1;
      continue;
    }
    accepted += 1;
  }
  const finalized = aggregator.finalizeThrough(tsOpen + MINUTE_MS);
  const bar = finalized.find((entry) => entry.symbol === instrument.symbol && entry.bar.ts_open === tsOpen)?.bar ?? null;
  return { bar, accepted, rejected, dropped };
}

function differs(before, after) {
  return COMPARED_FIELDS.some((field) => {
    const a = before[field] ?? null;
    const b = after[field] ?? null;
    if (a === null || b === null) return a !== b;
    return Math.abs(a - b) > EPSILON;
  });
}

function rangeShare(bar) {
  return bar && bar.close > 0 ? (bar.high - bar.low) / bar.close : null;
}

function pick(bar) {
  return bar === null ? null : Object.fromEntries(["ts_open", ...COMPARED_FIELDS].map((field) => [field, bar[field] ?? null]));
}

function planRebuild(db, instruments, { from, to }) {
  const candles = db.prepare(
    "SELECT ts_open, open, high, low, close, volume, buy_volume, sell_volume, trade_count FROM dxfeed_candles " +
    "WHERE symbol = ? AND asset_class = ? AND derivation = 'TIME_AND_SALE' AND ts_open >= ? AND ts_open < ? ORDER BY ts_open",
  );
  const prints = db.prepare(
    "SELECT symbol, asset_class, event_time, time, time_nano_part, sequence, price, size, aggressor_side, spread_leg, valid_tick, event_kind " +
    "FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? AND event_time >= ? AND event_time < ? " +
    "ORDER BY event_time, time_nano_part, sequence",
  );
  const minutes = [];
  const bySymbol = {};
  for (const instrument of instruments) {
    const summary = { reconstructed: 0, unchanged: 0, replace: 0, remove: 0, noSource: 0, rejected: {}, dropped: {} };
    bySymbol[instrument.symbol] = summary;
    for (const before of candles.all(instrument.symbol, instrument.assetClass, from, to)) {
      summary.reconstructed += 1;
      const rows = prints.all(instrument.symbol, instrument.assetClass, before.ts_open, before.ts_open + MINUTE_MS);
      if (rows.length === 0) {
        summary.noSource += 1;
        minutes.push({ symbol: instrument.symbol, assetClass: instrument.assetClass, tsOpen: before.ts_open, action: "no_source", before: pick(before), after: null });
        continue;
      }
      const { bar, rejected, dropped } = rebuildMinute(instrument, before.ts_open, rows);
      for (const [reason, count] of Object.entries(rejected)) summary.rejected[reason] = (summary.rejected[reason] ?? 0) + count;
      for (const [reason, count] of Object.entries(dropped)) summary.dropped[reason] = (summary.dropped[reason] ?? 0) + count;
      const action = bar === null ? "remove" : differs(before, bar) ? "replace" : "unchanged";
      summary[action] += 1;
      minutes.push({ symbol: instrument.symbol, assetClass: instrument.assetClass, tsOpen: before.ts_open, action, before: pick(before), after: pick(bar), bar });
    }
  }
  return { minutes, bySymbol };
}

function applyPlan(storageService, plan) {
  const raw = storageService.getStorageDb().raw;
  const remove = raw.prepare(
    "DELETE FROM dxfeed_candles WHERE symbol = ? AND asset_class = ? AND ts_open = ? AND derivation = 'TIME_AND_SALE'",
  );
  let replaced = 0;
  let removed = 0;
  raw.transaction(() => {
    for (const minute of plan.minutes) {
      if (minute.action === "replace") {
        storageService.recordCandle(minute.symbol, minute.assetClass, minute.bar, { derivation: "TIME_AND_SALE" });
        replaced += 1;
      } else if (minute.action === "remove") {
        removed += remove.run(minute.symbol, minute.assetClass, minute.tsOpen).changes;
      }
    }
  })();
  return { replaced, removed };
}

function widestChanges(plan, limit = 10) {
  return plan.minutes
    .filter((minute) => minute.action === "replace" || minute.action === "remove")
    .map((minute) => ({
      symbol: minute.symbol,
      minute: new Date(minute.tsOpen).toISOString(),
      action: minute.action,
      rangeBefore: rangeShare(minute.before),
      rangeAfter: rangeShare(minute.after),
    }))
    .sort((left, right) => (right.rangeBefore ?? 0) - (left.rangeBefore ?? 0))
    .slice(0, limit);
}

function openReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  const version = db.prepare("SELECT version FROM dxfeed_storage_schema").get()?.version;
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new RebuildError(`the store is on schema ${String(version)}; this tool requires ${SCHEMA_VERSION}`);
  }
  return db;
}

async function main({ argv = process.argv.slice(2), logger = createCliLogger({ name: "rebuild-dxfeed-candles" }), exit = process.exit } = {}) {
  let exitCode = 0;
  let db = null;
  let storageService = null;
  try {
    const options = parseArgs(argv);
    const instruments = selectInstruments(options.symbols);
    if (options.write) {
      storageService = createDxFeedStorageService({ dbPath: options.dbPath, bootstrap: false });
      db = storageService.getStorageDb().raw;
    } else {
      db = openReadOnly(options.dbPath);
    }
    const plan = planRebuild(db, instruments, options);
    const outcome = options.write ? applyPlan(storageService, plan) : null;
    const report = {
      mode: options.write ? "write" : "dry-run",
      from: new Date(options.from).toISOString(),
      to: new Date(options.to).toISOString(),
      rule: "NEW TimeAndSale, validTick required, spread legs excluded, same aggregator as the live collector",
      bySymbol: plan.bySymbol,
      widestChanges: widestChanges(plan),
      ...(outcome ? { written: outcome } : {}),
    };
    if (options.report) {
      fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
      fs.writeFileSync(options.report, `${JSON.stringify({ ...report, minutes: plan.minutes.map(({ symbol, assetClass, tsOpen, action, before, after }) => ({ symbol, assetClass, tsOpen, action, before, after })) }, null, 2)}\n`);
    }
    logger.ok(options.write ? "reconstructed dxFeed candles rebuilt" : "dry run: nothing written", report);
  } catch (error) {
    exitCode = 1;
    logger.error("reconstructed dxFeed candle rebuild failed", { reason: error?.message ?? error });
  } finally {
    try {
      if (storageService) storageService.close();
      else db?.close();
    } catch (error) {
      exitCode = 1;
      logger.error("closing the dxFeed store failed", { reason: error?.message ?? error });
    }
  }
  await flushAndExit(logger, exit, exitCode);
  return exitCode;
}

if (require.main === module) void main();

module.exports = { parseArgs, selectInstruments, rebuildMinute, planRebuild, applyPlan, widestChanges, RebuildError, main };
