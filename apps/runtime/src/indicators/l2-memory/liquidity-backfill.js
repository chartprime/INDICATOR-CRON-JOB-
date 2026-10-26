"use strict";

// Liquidity backfill: rebuild the heatmap's recent columns from the
// collector's SQLite instead of starting from an empty picture.
//
// The collector stores REST snapshots and every depth diff. The replay
// source turns them back into the exact book sequence the live server saw,
// a fresh memory engine consumes it the way the live one does, and on every
// column boundary the ledger is sampled with the same sampler the live
// publisher uses, with the same row geometry, so backfilled columns are
// indistinguishable from live ones. A wall tracker runs alongside, so the
// walls come back with their real ages instead of appearing to start now.
//
// **This runs in a worker thread.** better-sqlite3 is synchronous: replaying
// twenty minutes on the server's own thread starved the event loop badly
// enough that Binance REST calls timed out, which cost the server its depth
// snapshot and its klines. `backfillLiquidity` therefore spawns
// `liquidity-backfill-worker.js`, which calls `runBackfillInProcess` there
// and posts finished columns back in batches; only the ledger's own bulk
// stays off the wire between the threads. Callers that already hold an open
// database (tests) can call `runBackfillInProcess` directly.

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { createReplaySource } = require("./replay-source");
const { createDxFeedReplaySource } = require("./dxfeed-replay-source");
const { createMemoryEngine } = require("./memory-engine");
const { sampleLiquidityColumn, laneFoldFor } = require("../passive_liquidity/liquidity-sampler");
const { createDeepFolder } = require("../passive_liquidity/liquidity-history");
const { createColumnFlow } = require("../passive_liquidity/column-flow");
const { createWallService } = require("./wall-service");
const { createEventHistory } = require("./history/event-history");
const { createAggressiveOrdersTracker } = require("../passive_liquidity/aggressive-orders-tracker");

const DEFAULT_YIELD_EVERY = 400;
const DEFAULT_BATCH_COLUMNS = 60; // columns per message back to the main thread
const PRUNE_EVERY_MS = 30_000;
const WORKER_PATH = path.join(__dirname, "liquidity-backfill-worker.js");

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`liquidity-backfill: ${field} must be a positive safe integer`);
}

function assertWindow(fromTs, toTs) {
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs < 0 || toTs < fromTs) {
    throw new Error("liquidity-backfill: fromTs and toTs must be epoch-ms integers with fromTs <= toTs");
  }
}

function assertFold(foldMs, columnMs) {
  if (foldMs === undefined) return;
  if (!Number.isSafeInteger(foldMs) || foldMs <= 0 || foldMs % columnMs !== 0) {
    throw new Error("liquidity-backfill: foldMs must be a positive multiple of columnMs");
  }
}

/**
 * Replay and sample on the calling thread. Used by the worker, and directly
 * by tests that pass an open `db`.
 *
 * @param {object} options
 * @param {string} [options.dbPath]          Collector SQLite file (opened read-only).
 * @param {object} [options.db]              An already-open database. Pass exactly one of db / dbPath.
 * @param {string} options.symbol            Provider symbol, e.g. "BTCUSDT".
 * @param {number} options.fromTs            Window start, epoch ms.
 * @param {number} options.toTs              Window end, epoch ms.
 * @param {number} options.columnMs          Column width.
 * @param {number} options.rowClusters       Ledger bands per row (the live publisher's).
 * @param {number} options.windowRows        Rows each side of the mid (the live publisher's).
 * @param {number} [options.sizeDigits]
 * @param {number} options.tickSize          The live engine's geometry, so keys match.
 * @param {number} options.clusterTicks
 * @param {number} [options.snapshotDepth]
 * @param {number} [options.referenceRows]   Rows near the mid the wall threshold is judged over.
 * @param {object} [options.trackerOptions]  When given, a wall tracker runs alongside and its levels are returned.
 * @param {(column: object) => void} options.onColumn  Called per column, oldest first.
 * @param {number} [options.yieldEvery]
 */
function defaultSource({ db, dbPath, symbol, marketKind, fromTs, toTs }) {
  const dxfeed = marketKind === "FUTURE" || marketKind === "EQUITY";
  const where = db === undefined ? { dbPath } : { db };
  return dxfeed
    ? createDxFeedReplaySource({ ...where, symbol, assetClass: marketKind, fromTs, toTs, bookMode: "sparse" })
    : createReplaySource({ ...where, symbol, marketKind, fromTs, toTs });
}

async function runBackfillInProcess({
  dbPath,
  db,
  createSource,
  symbol,
  marketKind,
  fromTs,
  toTs,
  columnMs,
  foldMs,
  rowClusters,
  windowRows,
  sizeDigits,
  tickSize,
  clusterTicks,
  snapshotDepth = Infinity,
  referenceRows = Infinity,
  trackerOptions,
  aggressiveOptions,
  remote,
  onColumn,
  lanes = [],
  onLaneColumn,
  yieldEvery = DEFAULT_YIELD_EVERY,
}) {
  if (typeof onColumn !== "function") throw new Error("liquidity-backfill: onColumn must be a function");
  if (!Array.isArray(lanes)) throw new Error("liquidity-backfill: lanes must be an array");
  if (lanes.length > 0 && typeof onLaneColumn !== "function") throw new Error("liquidity-backfill: onLaneColumn must be a function when lanes are given");
  for (const lane of lanes) {
    if (!lane || !Number.isSafeInteger(lane.rowClusters) || lane.rowClusters <= 0 || !Number.isSafeInteger(lane.windowRows) || lane.windowRows < 0 || !Number.isSafeInteger(lane.factor) || lane.factor <= 0) {
      throw new Error("liquidity-backfill: each lane needs positive integer rowClusters and factor and a non-negative windowRows");
    }
  }
  assertPositiveInteger(columnMs, "columnMs");
  assertFold(foldMs, columnMs);
  assertPositiveInteger(yieldEvery, "yieldEvery");
  assertWindow(fromTs, toTs);
  if (createSource !== undefined && typeof createSource !== "function") throw new Error("liquidity-backfill: createSource must be a function");
  if (createSource === undefined && db === undefined && (typeof dbPath !== "string" || !fs.existsSync(dbPath))) {
    return { columns: 0, frames: 0, reason: "NO_DATABASE", stats: null, levels: [], aggressive: [] };
  }

  const dxfeed = marketKind === "FUTURE" || marketKind === "EQUITY";
  const source = (createSource ?? defaultSource)({
    db, dbPath, symbol, marketKind, fromTs, toTs, tickSize, clusterTicks,
    rowClusters, windowRows, remote,
  });
  const engine = createMemoryEngine({ tickSize, clusterTicks, snapshotDepth, fullDepth: dxfeed });
  const events = trackerOptions ? createEventHistory({ columnMs, deepColumnMs: foldMs ?? columnMs, recentMs: 0, maxAgeMs: Math.max(1, toTs - fromTs + columnMs) }) : null;
  const tracker = trackerOptions
    ? createWallService({
      engine,
      onTrades: (trades) => events.recordTrades(trades),
      onWallTrade: (trade) => events.recordWallTrades([trade]),
      ...trackerOptions,
    })
    : null;
  const aggressive = aggressiveOptions ? createAggressiveOrdersTracker(aggressiveOptions) : null;
  const folder = foldMs === undefined ? null : createDeepFolder({ deepColumnMs: foldMs });
  const flow = createColumnFlow({ keyFor: engine.keyFor, rowClusters, columnMs, ...(sizeDigits === undefined ? {} : { sizeDigits }) });
  const laneStates = lanes.map((lane) => ({
    rowClusters: lane.rowClusters,
    windowRows: lane.windowRows,
    flow: createColumnFlow({ keyFor: engine.keyFor, rowClusters: lane.rowClusters, columnMs, ...(sizeDigits === undefined ? {} : { sizeDigits }) }),
    folder: createDeepFolder({ deepColumnMs: (foldMs ?? columnMs) * lane.factor }),
  }));
  let nextTs = Math.ceil(fromTs / columnMs) * columnMs;
  let lastFrameTs = null;
  let lastPruneTs = null;
  let columns = 0;
  let frames = 0;

  function sampleUpTo(limitTs) {
    while (nextTs <= limitTs) {
      for (const print of engine.drainPrints()) {
        flow.push(print);
        for (const lane of laneStates) lane.flow.push(print);
      }
      if (engine.seeded && engine.live !== false) {
        const snapshot = engine.liteSnapshot();
        const sampled = sampleLiquidityColumn(snapshot, { ts: nextTs, rowClusters, windowRows, ...(sizeDigits === undefined ? {} : { sizeDigits }) });
        const column = sampled ? flow.take(sampled) : null;
        if (column) {
          if (tracker) tracker.update({ ts: nextTs, column, snapshot, rowClusters, referenceRows });
          if (aggressive) aggressive.update({ ts: nextTs, column, snapshot, rowClusters });
          const out = folder ? folder.feed(column) : column;
          if (out) {
            onColumn(out);
            columns += 1;
          }
          laneStates.forEach((lane, index) => {
            const laneSampled = sampleLiquidityColumn(snapshot, { ts: nextTs, rowClusters: lane.rowClusters, windowRows: lane.windowRows, fold: laneFoldFor(marketKind), ...(sizeDigits === undefined ? {} : { sizeDigits }) });
            if (!laneSampled) return;
            const laneOut = lane.folder.feed(lane.flow.take(laneSampled));
            if (laneOut) onLaneColumn(index, laneOut);
          });
        }
      }
      nextTs += columnMs;
    }
  }

  try {
    for await (const frame of source.frames()) {
      // Columns that end before this frame reflect the book as it stood before it.
      if (frame.ts >= nextTs) sampleUpTo(Math.min(toTs, frame.ts - 1));
      engine.apply(frame);
      lastFrameTs = frame.ts;
      frames += 1;
      // The live engine is pruned on a timer; a replay has no timer, so
      // forget emptied levels on the replay clock or the ledger only grows.
      if (lastPruneTs === null || frame.ts - lastPruneTs >= PRUNE_EVERY_MS) {
        engine.prune(frame.ts);
        lastPruneTs = frame.ts;
      }
      if (frames % yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    // After the last stored frame the book is only known to hold until the
    // next column; never invent a flat history past where the recording ends.
    if (lastFrameTs !== null) sampleUpTo(Math.min(toTs, lastFrameTs + columnMs));
  } finally {
    await source.close();
  }
  if (events !== null) events.advance(toTs + columnMs);
  return {
    columns,
    frames,
    reason: frames === 0 ? "NO_DATA_IN_WINDOW" : null,
    stats: source.stats,
    levels: tracker ? tracker.levels() : [],
    aggressive: aggressive ? aggressive.events() : [],
    events: events !== null ? events.toJSON() : null,
  };
}

/**
 * Rebuild the history on a worker thread. Same options as
 * `runBackfillInProcess` minus `db` (a connection cannot cross threads),
 * plus:
 *   onColumn(column)      called for each rebuilt column, oldest first
 *   shouldContinue()      checked per batch; false terminates the worker
 *   batchColumns          columns per message (default 60)
 * Never throws for an absent database or a worker that cannot start: the
 * caller simply gets a `reason` and carries on live.
 */
function backfillLiquidity({ onColumn, onLaneColumn, lanes = [], shouldContinue, signal, batchColumns = DEFAULT_BATCH_COLUMNS, ...options }) {
  if (typeof onColumn !== "function") return Promise.reject(new Error("liquidity-backfill: onColumn must be a function"));
  const sentLanes = typeof onLaneColumn === "function" && Array.isArray(lanes) ? lanes : [];
  try {
    assertPositiveInteger(options.columnMs, "columnMs");
    assertFold(options.foldMs, options.columnMs);
    assertPositiveInteger(batchColumns, "batchColumns");
    assertWindow(options.fromTs, options.toTs);
  } catch (error) {
    return Promise.reject(error);
  }
  if (options.sourceModule !== undefined && typeof options.sourceModule !== "string") {
    return Promise.reject(new Error("liquidity-backfill: sourceModule must be a module path"));
  }
  if (options.sourceModule === undefined && (typeof options.dbPath !== "string" || !fs.existsSync(options.dbPath))) {
    return Promise.resolve({ columns: 0, frames: 0, reason: "NO_DATABASE", stats: null, levels: [], aggressive: [] });
  }
  if (signal?.aborted) return Promise.resolve({ columns: 0, frames: 0, reason: "CANCELLED", stats: null, levels: [], aggressive: [] });

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(WORKER_PATH, { workerData: { ...options, lanes: sentLanes, batchColumns } });
    } catch (error) {
      resolve({ columns: 0, frames: 0, reason: `WORKER_FAILED: ${error?.message ?? error}`, stats: null, levels: [], aggressive: [] });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {}).finally(() => resolve(result));
    };
    const onAbort = () => finish({ columns: 0, frames: 0, reason: "CANCELLED", stats: null, levels: [], aggressive: [] });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message) => {
      if (settled) return;
      try {
        if (message.type === "columns") {
          for (const column of message.batch) onColumn(column);
          if (shouldContinue && !shouldContinue()) finish({ columns: 0, frames: 0, reason: "CANCELLED", stats: null, levels: [], aggressive: [] });
          return;
        }
        if (message.type === "laneColumns") {
          for (const entry of message.batch) onLaneColumn(entry.lane, entry.column);
          return;
        }
        if (message.type === "done") finish(message.result);
        else if (message.type === "error") finish({ columns: 0, frames: 0, reason: `WORKER_FAILED: ${message.message}`, stats: null, levels: [], aggressive: [] });
      } catch (error) {
        finish({ columns: 0, frames: 0, reason: `DELIVERY_FAILED: ${error?.message ?? error}`, stats: null, levels: [], aggressive: [] });
      }
    });
    worker.on("error", (error) => finish({ columns: 0, frames: 0, reason: `WORKER_FAILED: ${error?.message ?? error}`, stats: null, levels: [], aggressive: [] }));
    worker.on("exit", (code) => finish({ columns: 0, frames: 0, reason: code === 0 ? "WORKER_EXITED" : `WORKER_FAILED: exit ${code}`, stats: null, levels: [], aggressive: [] }));
  });
}

module.exports = { backfillLiquidity, runBackfillInProcess, defaultSource, DEFAULT_YIELD_EVERY, DEFAULT_BATCH_COLUMNS, WORKER_PATH };
