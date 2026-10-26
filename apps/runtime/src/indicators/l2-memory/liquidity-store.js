"use strict";

// Persisted heatmap history: the columns and walls the publisher has
// already worked out, kept on disk so a restart does not have to work them
// out again.
//
// Rebuilding from the collector's recording means replaying the raw depth
// diffs through the ledger: about 65,000 events for twenty minutes and
// three quarters of a million for four hours, which is tens of seconds and
// then minutes of a core. The finished product is tiny by comparison. A
// column costs about 300 bytes once delta encoded, so both tiers together
// come to well under a megabyte. This writes that to one file per pair and
// reads it back in milliseconds; the publisher then replays only the gap
// between the last saved column and now.
//
// Nothing here is authoritative. A file that is missing, truncated,
// malformed, written for another row geometry or simply too old is ignored
// and the caller rebuilds from the recording exactly as before. The store
// is a cache, never a source of truth.

const fs = require("fs");
const path = require("path");
const { dataRoot } = require("../../platform/runtime-paths");
const { PRINT_WINDOW_COLUMNS } = require("../passive_liquidity/column-flow");
const {
  MAX_LIQUIDITY_ROWS,
  MAX_LIQUIDITY_LEVELS,
  MAX_AGGRESSIVE_EVENTS,
  MAX_LIQUIDITY_PRINTS,
} = require("../../server/frames");

const VERSION = 2;
const READABLE_VERSIONS = new Set([1, VERSION]);
const DEFAULT_STORE_DIR = path.join(dataRoot(), "liquidity");
// A pair's file should be under a megabyte; anything wildly bigger is not ours.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LEVEL_END_REASONS = new Set(["filled", "partial", "hit", "pulled", "moved"]);

/** One file per pair, named after it: "SPOT:BTCUSDT" -> "SPOT_BTCUSDT.json". */
function liquidityStorePath(dir, pairKey) {
  if (typeof pairKey !== "string" || pairKey.length === 0) throw new Error("liquidity-store: pairKey must be a non-empty string");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9_.-]+/g, "_")}.json`);
}

function validEntries(entries, span) {
  if (!Array.isArray(entries)) return false;
  let previousOffset = -1;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [offset, size] = entry;
    if (!Number.isSafeInteger(offset) || offset <= previousOffset || offset >= span) return false;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return false;
    previousOffset = offset;
  }
  return true;
}

function validPrints(prints, column, columnMs) {
  if (!Array.isArray(prints) || prints.length > MAX_LIQUIDITY_PRINTS) return false;
  let previousTs = -1;
  for (const print of prints) {
    if (!print || typeof print !== "object") return false;
    if (!Number.isSafeInteger(print.ts) || print.ts < previousTs || print.ts < column.ts - PRINT_WINDOW_COLUMNS * columnMs || print.ts > column.ts + columnMs) return false;
    previousTs = print.ts;
    if (print.side !== "buy" && print.side !== "sell") return false;
    if (!Number.isFinite(print.price) || print.price <= 0 || !Number.isFinite(print.size) || print.size <= 0) return false;
    if (print.id !== null && typeof print.id !== "string") return false;
  }
  return true;
}

function validFlow(column, span, columnMs) {
  if (column.buy !== undefined && !validEntries(column.buy, span)) return false;
  if (column.sell !== undefined && !validEntries(column.sell, span)) return false;
  if (column.prints !== undefined && !validPrints(column.prints, column, columnMs)) return false;
  if (column.printsFloor !== undefined && (!Number.isFinite(column.printsFloor) || column.printsFloor < 0)) return false;
  return true;
}

/** Wire-encoded columns, oldest first, the first one complete. */
function validColumns(columns, columnMs) {
  if (!Array.isArray(columns)) return false;
  let previousTs = -Infinity;
  for (const column of columns) {
    if (!column || typeof column !== "object") return false;
    if (!Number.isSafeInteger(column.ts) || column.ts < 0 || column.ts <= previousTs) return false;
    if (!Number.isSafeInteger(column.lo) || column.lo < 0 || !Number.isSafeInteger(column.hi) || column.hi < column.lo) return false;
    const span = column.hi - column.lo + 1;
    if (!Number.isSafeInteger(span) || span > MAX_LIQUIDITY_ROWS) return false;
    if (!validEntries(column.bid, span) || !validEntries(column.ask, span) || !validFlow(column, span, columnMs)) return false;
    previousTs = column.ts;
  }
  return true;
}

/** The wall list as the tracker hands it over, ready for `adopt`. */
function validLevels(levels) {
  if (!Array.isArray(levels) || levels.length > MAX_LIQUIDITY_LEVELS) return false;
  for (const level of levels) {
    if (!level || typeof level !== "object") return false;
    if (level.side !== "bid" && level.side !== "ask") return false;
    if (!Number.isSafeInteger(level.row) || level.row < 0 || !Number.isSafeInteger(level.span) || level.span < 1) return false;
    if (!Number.isSafeInteger(level.startTs) || level.startTs < 0) return false;
    if (level.endTs !== null && (!Number.isSafeInteger(level.endTs) || level.endTs < level.startTs)) return false;
    if (level.endedBy !== null && !LEVEL_END_REASONS.has(level.endedBy)) return false;
    if ((level.endTs !== null) !== Boolean(level.endedBy)) return false;
    if (!Number.isFinite(level.size) || level.size < 0 || !Number.isFinite(level.peak) || level.peak < level.size) return false;
    if (level.ratio !== undefined && (!Number.isFinite(level.ratio) || level.ratio < 0)) return false;
    if (level.chain !== undefined && (!Number.isSafeInteger(level.chain) || level.chain < 0)) return false;
    if (level.fill !== undefined && (!Number.isFinite(level.fill) || level.fill < 0 || level.fill > 1)) return false;
    if (level.eaten !== undefined && (!Number.isFinite(level.eaten) || level.eaten < 0 || level.eaten > 1)) return false;
    if (level.absorbing !== undefined && typeof level.absorbing !== "boolean") return false;
    if (level.absorbing === true && level.endTs !== null) return false;
  }
  return true;
}

function validAggressive(events) {
  if (events === undefined) return true;
  if (!Array.isArray(events) || events.length > MAX_AGGRESSIVE_EVENTS) return false;
  for (const event of events) {
    if (!event || typeof event !== "object") return false;
    if (event.side !== "buy" && event.side !== "sell") return false;
    if (!Number.isSafeInteger(event.row) || event.row < 0 || !Number.isSafeInteger(event.span) || event.span < 1) return false;
    if (!Number.isSafeInteger(event.startTs) || event.startTs < 0) return false;
    if (event.endTs !== null && (!Number.isSafeInteger(event.endTs) || event.endTs < event.startTs)) return false;
    if (!Number.isFinite(event.volume) || event.volume < 0 || !Number.isFinite(event.peak) || event.peak < 0 || event.peak > event.volume) return false;
    if (!Number.isFinite(event.floor) || event.floor < 0) return false;
  }
  return true;
}

function validCoarse(coarse) {
  if (coarse === undefined || coarse === null) return true;
  if (!coarse || typeof coarse !== "object" || Array.isArray(coarse)) return false;
  if (!Number.isSafeInteger(coarse.columnMs) || coarse.columnMs <= 0 || !Number.isSafeInteger(coarse.rows) || coarse.rows <= 0) return false;
  return validColumns(coarse.columns, coarse.columnMs);
}

const MAX_STORED_LANES = 8;
const LANE_GEOMETRY_KEYS = ["k", "rowWidth", "rowClusters", "windowRows", "columnMs", "deepColumnMs"];
const LANE_FOLDS = new Set(["sum", "max"]);

function validLanes(lanes) {
  if (lanes === undefined) return true;
  if (!Array.isArray(lanes) || lanes.length > MAX_STORED_LANES) return false;
  for (const lane of lanes) {
    if (!lane || typeof lane !== "object") return false;
    if (!Number.isSafeInteger(lane.k) || lane.k < 1) return false;
    if (!Number.isFinite(lane.rowWidth) || lane.rowWidth <= 0) return false;
    if (!Number.isSafeInteger(lane.rowClusters) || lane.rowClusters <= 0 || !Number.isSafeInteger(lane.windowRows) || lane.windowRows < 0) return false;
    if (!Number.isSafeInteger(lane.columnMs) || lane.columnMs <= 0 || !Number.isSafeInteger(lane.deepColumnMs) || lane.deepColumnMs < 0) return false;
    if (lane.fold !== undefined && !LANE_FOLDS.has(lane.fold)) return false;
    if (!validColumns(lane.recent, lane.columnMs) || !validColumns(lane.deep, lane.deepColumnMs > 0 ? lane.deepColumnMs : Infinity)) return false;
  }
  return true;
}

function sameLaneGeometry(a, b) {
  if (!a || !b) return false;
  for (const key of LANE_GEOMETRY_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return (a.fold ?? "sum") === (b.fold ?? "sum");
}

function sameGeometry(a, b) {
  if (!a || !b) return false;
  for (const key of ["rowWidth", "rowClusters", "windowRows", "columnMs", "deepColumnMs"]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Write a pair's history. Atomic: a temporary file then a rename, so a
 * crash mid-write leaves the previous copy intact rather than a half file.
 * Never throws; a store that cannot be written is only a slower restart.
 *
 * @param {object} options
 * @param {string} [options.dir]        Directory to write into (created as needed).
 * @param {string} options.pairKey      e.g. "SPOT:BTCUSDT".
 * @param {object} options.geometry     rowWidth, rowClusters, windowRows, columnMs, deepColumnMs.
 * @param {object[]} options.recent     Wire-encoded columns of the recent tier, oldest first.
 * @param {object[]} [options.deep]     The same for the deep tier.
 * @param {object[]} [options.levels]   The tracker's wall list.
 * @param {number} [options.savedAt]
 */
function laneColumnCount(lanes) {
  let count = 0;
  for (const lane of lanes ?? []) count += lane.recent.length + lane.deep.length;
  return count;
}

function saveLiquidityHistory({ dir = DEFAULT_STORE_DIR, pairKey, geometry, recent, deep = [], levels = [], aggressive = [], coarse = null, lanes, savedAt = Date.now(), trimmedBefore, maxBytes = MAX_FILE_BYTES }) {
  try {
    const file = liquidityStorePath(dir, pairKey);
    const withLanes = Array.isArray(lanes) && lanes.length > 0;
    const payload = JSON.stringify({ version: VERSION, pairKey, savedAt, geometry, recent, deep, levels, aggressive, coarse, ...(withLanes ? { lanes } : {}), ...(Number.isSafeInteger(trimmedBefore) ? { trimmedBefore } : {}) });
    if (payload.length > maxBytes) return { ok: false, reason: "OVER_BUDGET", bytes: payload.length };
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, payload);
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev`);
    fs.renameSync(temporary, file);
    return { ok: true, bytes: payload.length, columns: recent.length + deep.length + (coarse ? coarse.columns.length : 0) + (withLanes ? laneColumnCount(lanes) : 0), file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

const DEFAULT_ASYNC_BATCH_COLUMNS = 1_000;
let asyncWriteSequence = 0;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function saveLiquidityHistoryAsync(
  { dir = DEFAULT_STORE_DIR, pairKey, geometry, recent, deep = [], levels = [], aggressive = [], coarse = null, lanes, savedAt = Date.now(), trimmedBefore, maxBytes = MAX_FILE_BYTES },
  { batchColumns = DEFAULT_ASYNC_BATCH_COLUMNS, yieldToLoop = yieldToEventLoop, shouldCommit = () => true } = {},
) {
  let file;
  let temporary = null;
  let handle = null;
  let bytes = 0;
  let overBudget = false;
  const emit = async (text) => {
    const buffer = Buffer.from(text);
    bytes += buffer.length;
    if (bytes > maxBytes) overBudget = true;
    if (!overBudget) {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error("liquidity-store: background write made no progress");
        offset += bytesWritten;
      }
    }
  };
  const emitColumns = async (columns) => {
    for (let start = 0; start < columns.length; start += batchColumns) {
      const batch = columns.slice(start, start + batchColumns).map((column) => JSON.stringify(column)).join(",");
      await emit(start === 0 ? batch : `,${batch}`);
      await yieldToLoop();
    }
  };
  try {
    file = liquidityStorePath(dir, pairKey);
    await fs.promises.mkdir(dir, { recursive: true });
    asyncWriteSequence += 1;
    temporary = `${file}.${process.pid}.${asyncWriteSequence}.tmp`;
    handle = await fs.promises.open(temporary, "w");
    await emit(`{"version":${VERSION},"pairKey":${JSON.stringify(pairKey)},"savedAt":${JSON.stringify(savedAt)},"geometry":${JSON.stringify(geometry)},"recent":[`);
    await emitColumns(recent);
    await emit("],\"deep\":[");
    await emitColumns(deep);
    await emit(`],"levels":${JSON.stringify(levels)},"aggressive":${JSON.stringify(aggressive)},"coarse":`);
    if (coarse === null) {
      await emit("null");
    } else {
      await emit(`{"columnMs":${JSON.stringify(coarse.columnMs)},"rows":${JSON.stringify(coarse.rows)},"columns":[`);
      await emitColumns(coarse.columns);
      await emit("]}");
    }
    const withLanes = Array.isArray(lanes) && lanes.length > 0;
    if (withLanes) {
      await emit(",\"lanes\":[");
      for (let index = 0; index < lanes.length; index += 1) {
        const lane = lanes[index];
        const head = LANE_GEOMETRY_KEYS.map((key) => `${JSON.stringify(key)}:${JSON.stringify(lane[key])}`).join(",");
        const fold = lane.fold === undefined ? "" : `,"fold":${JSON.stringify(lane.fold)}`;
        await emit(`${index === 0 ? "" : ","}{${head}${fold},"recent":[`);
        await emitColumns(lane.recent);
        await emit("],\"deep\":[");
        await emitColumns(lane.deep);
        await emit("]}");
      }
      await emit("]");
    }
    await emit(`${Number.isSafeInteger(trimmedBefore) ? `,"trimmedBefore":${trimmedBefore}` : ""}}`);
    await handle.close();
    handle = null;
    if (overBudget) return { ok: false, reason: "OVER_BUDGET", bytes };
    if (!shouldCommit()) return { ok: false, reason: "SUPERSEDED", bytes };
    if (fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.prev`);
    if (!shouldCommit()) return { ok: false, reason: "SUPERSEDED", bytes };
    fs.renameSync(temporary, file);
    temporary = null;
    return { ok: true, bytes, columns: recent.length + deep.length + (coarse?.columns.length ?? 0) + (withLanes ? laneColumnCount(lanes) : 0), file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    if (temporary !== null) await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Read a pair's history back, or null when there is nothing usable. The
 * caller passes what it expects: a mismatch in row geometry (price has
 * moved far enough to change the row height) or a file older than
 * `maxAgeMs` is discarded rather than patched up.
 */
function loadLiquidityHistory({ dir = DEFAULT_STORE_DIR, pairKey, geometry, maxAgeMs = Infinity, now = Date.now(), maxFileBytes = MAX_FILE_BYTES, onReject = () => {} }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = liquidityStorePath(dir, pairKey);
    const stats = fs.statSync(file, { throwIfNoEntry: false });
    if (!stats) return null;
    if (!stats.isFile()) return reject("NOT_A_FILE");
    if (stats.size > maxFileBytes) return reject("TOO_LARGE");
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return reject("UNREADABLE");
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return reject("MALFORMED");
  }
  return interpretSaved(saved, { pairKey, geometry, maxAgeMs, now, reject });
}

async function loadLiquidityHistoryAsync({ dir = DEFAULT_STORE_DIR, pairKey, geometry, maxAgeMs = Infinity, now = Date.now(), maxFileBytes = MAX_FILE_BYTES, onReject = () => {}, yieldTurn = () => new Promise((resolve) => setImmediate(resolve)) }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = liquidityStorePath(dir, pairKey);
    const stats = await fs.promises.stat(file).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
    if (!stats) return null;
    if (!stats.isFile()) return reject("NOT_A_FILE");
    if (stats.size > maxFileBytes) return reject("TOO_LARGE");
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    return reject("UNREADABLE");
  }
  await yieldTurn();
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return reject("MALFORMED");
  }
  await yieldTurn();
  return interpretSaved(saved, { pairKey, geometry, maxAgeMs, now, reject });
}

function interpretSaved(saved, { pairKey, geometry, maxAgeMs, now, reject }) {
  if (!saved || !READABLE_VERSIONS.has(saved.version) || saved.pairKey !== pairKey) return reject("FOREIGN");
  if (!Number.isSafeInteger(saved.savedAt) || saved.savedAt > now + 60_000) return reject("MALFORMED");
  if (now - saved.savedAt > maxAgeMs) return reject("TOO_OLD");
  if (geometry !== undefined && !sameGeometry(saved.geometry, geometry)) return reject("GEOMETRY_MISMATCH");
  const savedGeometry = saved.geometry ?? {};
  const recentMs = Number.isSafeInteger(savedGeometry.columnMs) && savedGeometry.columnMs > 0 ? savedGeometry.columnMs : Infinity;
  const deepMs = Number.isSafeInteger(savedGeometry.deepColumnMs) && savedGeometry.deepColumnMs > 0 ? savedGeometry.deepColumnMs : Infinity;
  if (!validColumns(saved.recent, recentMs) || !validColumns(saved.deep, deepMs) || !validLevels(saved.levels) || !validAggressive(saved.aggressive) || !validCoarse(saved.coarse) || !validLanes(saved.lanes)) return reject("MALFORMED");
  if (saved.recent.length === 0) return reject("EMPTY");
  return {
    savedAt: saved.savedAt, geometry: saved.geometry, recent: saved.recent, deep: saved.deep, levels: saved.levels, aggressive: saved.aggressive ?? [], coarse: saved.coarse ?? null,
    ...(Array.isArray(saved.lanes) && saved.lanes.length > 0 ? { lanes: saved.lanes } : {}),
    ...(Number.isSafeInteger(saved.trimmedBefore) ? { trimmedBefore: saved.trimmedBefore } : {}),
  };
}

/** Forget a pair's file (a geometry change, or a store known to be wrong). */
function dropLiquidityHistory({ dir = DEFAULT_STORE_DIR, pairKey }) {
  try {
    const file = liquidityStorePath(dir, pairKey);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.prev`, { force: true });
    return true;
  } catch {
    return false;
  }
}

function pruneExpiredFutureStores({ dir = DEFAULT_STORE_DIR, keepPairKeys, fsImpl = fs }) {
  const keepStems = keepPairKeys.map((pairKey) => `${path.basename(liquidityStorePath(dir, pairKey), ".json")}.`);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.startsWith("FUTURE_")) continue;
    const base = name.endsWith(".prev") ? name.slice(0, -".prev".length) : name;
    if (!base.endsWith(".json") || keepStems.some((stem) => base.startsWith(stem))) continue;
    try {
      fsImpl.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      continue;
    }
  }
  return removed;
}

const DEFAULT_TEMPORARY_MAX_AGE_MS = 10 * 60_000;

/** Remove the `.tmp` files a killed writer left in the store directory, once they are older than a write could be. */
function sweepStoreTemporaries({ dir = DEFAULT_STORE_DIR, now = Date.now(), maxAgeMs = DEFAULT_TEMPORARY_MAX_AGE_MS, fsImpl = fs }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("liquidity-store: maxAgeMs must be a positive number");
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    try {
      const stats = fsImpl.statSync(file);
      if (!stats.isFile() || now - stats.mtimeMs < maxAgeMs) continue;
      fsImpl.rmSync(file, { force: true });
      removed.push(name);
    } catch {
      continue;
    }
  }
  return removed;
}

module.exports = {
  saveLiquidityHistory,
  saveLiquidityHistoryAsync,
  loadLiquidityHistory,
  loadLiquidityHistoryAsync,
  dropLiquidityHistory,
  pruneExpiredFutureStores,
  sweepStoreTemporaries,
  liquidityStorePath,
  sameLaneGeometry,
  DEFAULT_STORE_DIR,
  VERSION,
};
