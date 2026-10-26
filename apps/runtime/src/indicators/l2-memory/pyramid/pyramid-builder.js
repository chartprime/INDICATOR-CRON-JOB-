"use strict";

const { runBackfillInProcess, defaultSource } = require("../liquidity-backfill");
const { createMemoryEngine } = require("../memory-engine");
const { laneZeroGeometry, rowClustersFor, windowRowsFor } = require("../../passive_liquidity/liquidity-geometry");
const { WINDOW_MS, BASE_COLUMN_MS, BASE_LEVEL_MS, LEVELS_MS, WINDOW_STATES, windowStart, foldLevels, windowCoverage } = require("./pyramid-levels");

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_LAG_MS = 60_000;
const DEFAULT_SETTLE_MS = 30 * 60_000;
const DEFAULT_PROBE_MS = 10 * 60_000;
const DEFAULT_WARMUP_MS = 30 * 60_000;
const DEFAULT_MAX_RUN_WINDOWS = 12;
const DEFAULT_MIN_TAIL_WINDOWS = 6;
const DEFAULT_TAIL_WAIT_MS = 30 * 60_000;
const DEFAULT_FAILED_RETRY_MS = 60 * 60_000;
const REPIN_FACTOR = 2;
const STANDING_TOLERANCE_MS = BASE_LEVEL_MS;

function resolveGeometry({ price, tickSize, clusterTicks, fixedRows = null, rowBp, windowBp, referenceBp, sizeDigits, snapshotDepth, replayWarmupMs = DEFAULT_WARMUP_MS }) {
  if (!(tickSize > 0) || !Number.isSafeInteger(clusterTicks) || clusterTicks <= 0) throw new Error("pyramid-builder: tickSize and clusterTicks must be positive");
  if (!(price > 0)) throw new Error("pyramid-builder: a positive price is needed to pin the geometry");
  const clusterWidth = tickSize * clusterTicks;
  const lane = laneZeroGeometry({ price, clusterWidth, fixedRows, rowBp, windowBp, referenceBp });
  return Object.freeze({
    tickSize,
    clusterTicks,
    clusterWidth,
    rowClusters: lane.rowClusters,
    rowWidth: lane.rowWidth,
    windowRows: lane.windowRows,
    sizeDigits,
    snapshotDepth: Number.isFinite(snapshotDepth) ? snapshotDepth : -1,
    columnMs: BASE_COLUMN_MS,
    windowMs: WINDOW_MS,
    levelsMs: LEVELS_MS,
    rowBp,
    windowBp,
    referenceBp,
    fixedRows: Number.isSafeInteger(fixedRows) && fixedRows > 0 ? fixedRows : null,
    pinnedPrice: price,
    replayWarmupMs,
  });
}

function needsRepin(pinned, fresh, rowBp) {
  if (!pinned) return true;
  for (const key of ["tickSize", "clusterTicks", "sizeDigits", "snapshotDepth", "columnMs", "fixedRows", "replayWarmupMs", "rowBp", "windowBp", "referenceBp"]) {
    if (pinned[key] !== fresh[key]) return true;
  }
  if (fresh.fixedRows !== null) return pinned.rowClusters !== fresh.rowClusters;
  const wanted = rowClustersFor(fresh.pinnedPrice, fresh.clusterWidth, rowBp);
  return wanted > pinned.rowClusters * REPIN_FACTOR || wanted * REPIN_FACTOR < pinned.rowClusters;
}

function engineDepth(geometry) {
  return geometry.snapshotDepth >= 0 ? geometry.snapshotDepth : Infinity;
}

function inWindow(ts, windowTs) {
  return ts >= windowTs && ts < windowTs + WINDOW_MS;
}

function windowEvents(events, windowTs) {
  return {
    version: events.version,
    columnMs: events.columnMs,
    deepColumnMs: events.deepColumnMs,
    fill: { from: windowTs, until: windowTs + WINDOW_MS },
    trades: events.trades.filter((entry) => inWindow(entry[0], windowTs)),
    wallTrades: events.wallTrades.filter((entry) => inWindow(entry[0], windowTs)),
  };
}

function windowWalls(levels, windowTs) {
  return levels.filter((level) => level.endTs !== null && inWindow(level.endTs, windowTs));
}

function standingAt(levels, boundary) {
  return levels.filter((level) => level.startTs < boundary && (level.endTs === null || level.endTs >= boundary));
}

async function probePrice({ pair, at, probeMs = DEFAULT_PROBE_MS, tickSize, clusterTicks, sourceOptions, createSource = defaultSource }) {
  const dxfeed = pair.marketKind === "FUTURE" || pair.marketKind === "EQUITY";
  const engine = createMemoryEngine({ tickSize, clusterTicks, fullDepth: dxfeed });
  const source = createSource({ ...sourceOptions, symbol: pair.symbol, marketKind: pair.marketKind, fromTs: Math.max(0, at - probeMs), toTs: at });
  let price = null;
  try {
    for await (const frame of source.frames()) {
      engine.apply(frame);
      if (!engine.seeded || engine.live === false) continue;
      const snap = engine.liteSnapshot();
      const refKey = snap.bestBidKey ?? snap.bestAskKey ?? null;
      if (refKey !== null) price = snap.priceFor(refKey);
    }
  } finally {
    await source.close();
  }
  return price;
}

const COVERAGE_RANK = Object.freeze({ [WINDOW_STATES.COVERED]: 3, [WINDOW_STATES.PARTIAL]: 2, [WINDOW_STATES.NO_DATA]: 1, [WINDOW_STATES.FAILED]: 0 });

function createPyramidBuilder({
  store,
  pair,
  geometry,
  sourceOptions,
  createSource,
  runBackfill = runBackfillInProcess,
  captureLatestTs = () => null,
  captureMarginMs = 0,
  retentionMs = DEFAULT_RETENTION_MS,
  lagMs = DEFAULT_LAG_MS,
  settleMs = DEFAULT_SETTLE_MS,
  warmupMs = DEFAULT_WARMUP_MS,
  maxRunWindows = DEFAULT_MAX_RUN_WINDOWS,
  minTailWindows = DEFAULT_MIN_TAIL_WINDOWS,
  tailWaitMs = DEFAULT_TAIL_WAIT_MS,
  failedRetryMs = DEFAULT_FAILED_RETRY_MS,
  trackerOptions = null,
  now = () => Date.now(),
}) {
  if (!Number.isSafeInteger(maxRunWindows) || maxRunWindows <= 0 || !Number.isSafeInteger(minTailWindows) || minTailWindows <= 0) {
    throw new Error("pyramid-builder: maxRunWindows and minTailWindows must be positive integers");
  }
  if (!store || typeof store.putWindow !== "function") throw new Error("pyramid-builder: store is required");
  if (!pair || typeof pair.symbol !== "string" || typeof pair.marketKind !== "string") throw new Error("pyramid-builder: pair needs symbol and marketKind");
  if (!geometry || !(geometry.rowWidth > 0)) throw new Error("pyramid-builder: geometry is required");
  if (geometry.replayWarmupMs !== undefined && geometry.replayWarmupMs !== warmupMs) throw new Error("pyramid-builder: replay warm-up differs from pinned derivation");
  if (trackerOptions !== null && (typeof trackerOptions !== "object" || Array.isArray(trackerOptions))) throw new Error("pyramid-builder: trackerOptions must be an object or null");
  if (trackerOptions !== null && (typeof store.putStanding !== "function" || typeof store.putHistories !== "function")) throw new Error("pyramid-builder: a store that keeps histories needs putStanding and putHistories");
  if (trackerOptions !== null && !(geometry.pinnedPrice > 0)) throw new Error("pyramid-builder: histories need the geometry's pinnedPrice");
  const referenceRows = trackerOptions === null ? undefined : windowRowsFor(geometry.pinnedPrice, geometry.rowWidth, geometry.referenceBp);
  for (const [name, value] of [["retentionMs", retentionMs], ["lagMs", lagMs], ["settleMs", settleMs], ["captureMarginMs", captureMarginMs], ["warmupMs", warmupMs], ["tailWaitMs", tailWaitMs], ["failedRetryMs", failedRetryMs]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`pyramid-builder: ${name} must be a non-negative integer`);
  }
  const historyRetryAt = new Map();

  function coversAtLeast(record, state, columns) {
    return record === undefined || COVERAGE_RANK[state] > COVERAGE_RANK[record.state] || (COVERAGE_RANK[state] === COVERAGE_RANK[record.state] && columns >= record.columns);
  }

  function keptOutcome(record, reason, extra = {}) {
    return { windowTs: record.ts, state: record.state, columns: record.columns, frames: record.frames, bytes: 0, reason, kept: true, ...extra };
  }

  function plan(at = now()) {
    const newest = windowStart(at - lagMs - WINDOW_MS);
    const oldest = windowStart(at - retentionMs);
    if (newest < oldest) return [];
    const captured = captureLatestTs();
    const withHistories = trackerOptions === null ? null : new Set(store.historyWindows(oldest, newest + WINDOW_MS));
    const built = new Set(store.windowRecords(oldest, newest + WINDOW_MS)
      .filter((record) => {
        if (record.state === WINDOW_STATES.FAILED) return at - record.builtAt < failedRetryMs;
        if (withHistories !== null && !withHistories.has(record.ts)) return (historyRetryAt.get(record.ts) ?? 0) > at;
        if (record.reason === "AWAITING_CAPTURE") return !(Number.isFinite(captured) && captured >= record.ts + WINDOW_MS + captureMarginMs);
        return true;
      })
      .map((record) => record.ts));
    const due = [];
    for (let ts = newest; ts >= oldest; ts -= WINDOW_MS) {
      if (built.has(ts)) continue;
      const end = ts + WINDOW_MS;
      const recorded = Number.isFinite(captured) && captured >= end + captureMarginMs;
      if (recorded || at >= end + settleMs) due.push(ts);
    }
    return due;
  }

  async function buildRun(firstTs, count) {
    if (!Number.isSafeInteger(firstTs) || firstTs % WINDOW_MS !== 0) throw new Error("pyramid-builder: firstTs must be window-aligned");
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("pyramid-builder: count must be a positive integer");
    const end = firstTs + count * WINDOW_MS;
    const perWindow = new Map();
    for (let ts = firstTs; ts < end; ts += WINDOW_MS) perWindow.set(ts, []);
    const capturedAt = captureLatestTs();
    const stored = new Map(trackerOptions === null ? [] : store.windowRecords(firstTs, end).filter((record) => record.state !== WINDOW_STATES.FAILED).map((record) => [record.ts, record]));
    const failed = (reason) => [...perWindow.keys()].map((windowTs) => {
      const record = stored.get(windowTs);
      if (record !== undefined) {
        historyRetryAt.set(windowTs, now() + failedRetryMs);
        return keptOutcome(record, reason);
      }
      store.putWindow({ windowTs, state: WINDOW_STATES.FAILED, columns: 0, frames: 0, reason, builtAt: now(), levels: new Map(), ...(trackerOptions === null ? {} : { walls: [], events: null }) });
      return { windowTs, state: WINDOW_STATES.FAILED, columns: 0, frames: 0, bytes: 0, reason };
    });
    let result;
    try {
      result = await runBackfill({
        ...sourceOptions,
        ...(createSource === undefined ? {} : { createSource }),
        symbol: pair.symbol,
        marketKind: pair.marketKind,
        fromTs: Math.max(0, firstTs - warmupMs),
        toTs: end,
        columnMs: BASE_COLUMN_MS,
        foldMs: BASE_LEVEL_MS,
        rowClusters: geometry.rowClusters,
        windowRows: geometry.windowRows,
        sizeDigits: geometry.sizeDigits,
        tickSize: geometry.tickSize,
        clusterTicks: geometry.clusterTicks,
        snapshotDepth: engineDepth(geometry),
        ...(trackerOptions === null ? {} : { trackerOptions, referenceRows }),
        onColumn: (column) => {
          if (column.ts >= firstTs && column.ts < end) perWindow.get(windowStart(column.ts)).push(column);
        },
      });
    } catch (error) {
      return failed(`REPLAY_FAILED: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    if (result.reason === "NO_DATABASE") throw new Error("pyramid-builder: the capture database is missing");
    if (trackerOptions !== null && !result.events) return failed("REPLAY_FAILED: the replay returned no events");
    const builtAt = now();
    const levels = trackerOptions === null ? [] : result.levels ?? [];
    const outcomes = [...perWindow.entries()].map(([windowTs, base]) => {
      const state = windowCoverage(base, windowTs);
      const reason = state !== WINDOW_STATES.COVERED && !(Number.isFinite(capturedAt) && capturedAt >= windowTs + WINDOW_MS + captureMarginMs)
        ? "AWAITING_CAPTURE" : result.reason;
      if (trackerOptions === null) {
        const bytes = store.putWindow({ windowTs, state, columns: base.length, frames: result.frames, reason, builtAt, levels: foldLevels(base) });
        return { windowTs, state, columns: base.length, frames: result.frames, bytes, reason };
      }
      const walls = windowWalls(levels, windowTs);
      const events = windowEvents(result.events, windowTs);
      historyRetryAt.delete(windowTs);
      if (!coversAtLeast(stored.get(windowTs), state, base.length)) {
        store.putHistories({ windowTs, walls, events });
        return keptOutcome(stored.get(windowTs), reason, { walls: walls.length, events: events.trades.length + events.wallTrades.length });
      }
      const bytes = store.putWindow({ windowTs, state, columns: base.length, frames: result.frames, reason, builtAt, levels: foldLevels(base), walls, events });
      return { windowTs, state, columns: base.length, frames: result.frames, bytes, reason, walls: walls.length, events: events.trades.length + events.wallTrades.length };
    });
    if (trackerOptions !== null) {
      const boundary = end - warmupMs;
      store.putStanding({ until: boundary, toleranceMs: STANDING_TOLERANCE_MS, walls: standingAt(levels, boundary) });
    }
    return outcomes;
  }

  function buildWindow(windowTs) {
    return buildRun(windowTs, 1).then((outcomes) => outcomes[0]);
  }

  function runsOf(due, at) {
    const ascending = [...due].sort((a, b) => a - b);
    const groups = [];
    for (const ts of ascending) {
      const last = groups[groups.length - 1];
      if (last && last[last.length - 1] + WINDOW_MS === ts) last.push(ts);
      else groups.push([ts]);
    }
    const tail = windowStart(at - lagMs - WINDOW_MS);
    const runs = [];
    for (const group of groups.reverse()) {
      for (let hi = group.length; hi > 0; hi -= maxRunWindows) {
        const run = group.slice(Math.max(0, hi - maxRunWindows), hi);
        const waiting = run[run.length - 1] === tail && run.length < minTailWindows && at - (run[0] + WINDOW_MS) < tailWaitMs;
        if (!waiting) runs.push(run);
      }
    }
    return runs;
  }

  async function runCycle({ maxWindows = Infinity, shouldContinue = () => true, onWindow = () => {} } = {}) {
    if (maxWindows !== Infinity && (!Number.isSafeInteger(maxWindows) || maxWindows <= 0)) throw new Error("pyramid-builder: maxWindows must be a positive integer or Infinity");
    const at = now();
    const pruned = store.prune(at - retentionMs);
    const due = plan(at);
    const built = [];
    for (const run of runsOf(due, at)) {
      if (built.length >= maxWindows || !shouldContinue()) break;
      const remaining = maxWindows - built.length;
      const selected = Number.isFinite(remaining) && remaining < run.length ? run.slice(-remaining) : run;
      for (const outcome of await buildRun(selected[0], selected.length)) {
        built.push(outcome);
        onWindow(outcome);
      }
    }
    return { at, pruned, due: due.length, built };
  }

  return Object.freeze({ plan, runsOf, buildRun, buildWindow, runCycle });
}

module.exports = {
  STANDING_TOLERANCE_MS,
  createPyramidBuilder,
  resolveGeometry,
  needsRepin,
  probePrice,
  DEFAULT_RETENTION_MS,
  DEFAULT_LAG_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_WARMUP_MS,
  DEFAULT_MAX_RUN_WINDOWS,
  DEFAULT_MIN_TAIL_WINDOWS,
  DEFAULT_TAIL_WAIT_MS,
  DEFAULT_FAILED_RETRY_MS,
  REPIN_FACTOR,
};
