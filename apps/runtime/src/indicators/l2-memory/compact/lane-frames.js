"use strict";

const { MAX_L2_LANE_WALLS } = require("../../../server/l2-frames");
const { MAX_LIQUIDITY_COLUMNS, MAX_WIRE_MAGNITUDE } = require("../../../server/frames");
const { sampleLiquidityColumn } = require("../../passive_liquidity/liquidity-sampler");
const { encodeColumn, encodeAfter } = require("../../passive_liquidity/liquidity-history");

function unsendable(column) {
  for (const side of [column.bid, column.ask]) for (let i = 0; i < side.length; i += 1) if (side[i] > MAX_WIRE_MAGNITUDE) return true;
  for (const flow of [column.buy, column.sell]) if (flow) for (const [, size] of flow) if (size > MAX_WIRE_MAGNITUDE) return true;
  if (column.prints) for (const print of column.prints) if (print.size > MAX_WIRE_MAGNITUDE) return true;
  return column.printsFloor > MAX_WIRE_MAGNITUDE;
}

function dropUnsendable(state) {
  let dropped = 0;
  for (const history of [state.history, state.deep, state.coarse]) {
    if (!history) continue;
    const kept = history.toArray().filter((column) => {
      const bad = unsendable(column);
      if (bad) dropped += 1;
      return !bad;
    });
    if (kept.length === history.length) continue;
    history.clear();
    for (const column of kept) history.push(column);
  }
  return dropped;
}

function createLaneFrames(ctx, lane, l2 = null) {
  const {
    buildFrame, columnMs, deepColumnMs, coarseColumnMs, coarseRows, sizeDigits, slowStepMs, storeEnabled, storeDir,
    dropHistory, scheduler, pairKey, states, log, announceMs, laneWalls = null,
  } = ctx;

  function postLaneColumns(state, snapshot, landed) {
    if (laneWalls === null || !laneWalls.enabled || ctx.activeKey !== state.key || state.lanes.length === 0) return;
    laneWalls.configure(state.key, state.lanes, { ...state.trackerOptions, maxLevels: MAX_L2_LANE_WALLS });
    for (const entry of landed) {
      if (entry.tier !== "recent") continue;
      laneWalls.post({ pair: state.key, lane: entry.entry.k, ts: entry.column.ts, column: entry.column, snapshot, referenceRows: Math.max(1, Math.ceil(state.referenceRows / entry.entry.factor)) });
    }
  }

  function failL2(state, error) {
    state.l2 = null;
    state.l2Output = null;
    log(`liquidity-publisher: L2 output for ${state.key} failed, clients resync on the next tick: ${error?.message ?? error}`);
  }

  function flushL2(state) {
    const pending = state.l2Pending;
    if (!pending) return;
    state.l2Pending = null;
    try {
      state.l2Output = l2.collect(state, pending.engine, pending.ts, pending.column, pending.landed.map((entry) => l2.landedColumn(entry.entry, entry.tier, entry.prev, entry.column, entry.seq)));
    } catch (error) {
      failL2(state, error);
    }
  }

  function collectL2(state, engine, ts, column, landed) {
    if (l2 === null || !ctx.l2Enabled) return;
    if (ctx.activeKey === null || ctx.activeKey === state.key) {
      flushL2(state);
      state.l2Pending = { engine, ts, column, landed };
      return;
    }
    try {
      state.l2Pending = null;
      if (typeof state.tracker.drainLifecycle === "function") state.tracker.drainLifecycle();
      if (state.l2) state.l2.reader.read();
    } catch (error) {
      failL2(state, error);
    }
  }

  function announceDue(state, at) {
    if (ctx.activeKey !== null && ctx.activeKey !== state.key) return false;
    if (ctx.hasClients !== null && !ctx.hasClients()) return false;
    return state.announceNow || state.announcedAt === 0 || at - state.announcedAt >= announceMs;
  }

  function tickColumn(state, engine, marketKind, symbol, at) {
    state.snapshotTick = false;
    const ts = Math.floor(at / columnMs) * columnMs;
    const prev = state.history.latest();
    if (prev && ts <= prev.ts) return null;
    const snapshot = typeof engine.liteSnapshot === "function" ? engine.liteSnapshot() : engine.snapshot();
    if (typeof engine.drainPrints === "function") for (const print of engine.drainPrints()) lane.pushPrint(state, print);
    const sampled = sampleLiquidityColumn(snapshot, { ts, rowClusters: state.rowClusters, windowRows: state.windowRows, sizeDigits });
    if (!sampled) return null;
    const column = state.flow.take(sampled);
    const seq = state.history.push(column);
    if (state.liveDuringPass) state.liveDuringPass.push(column);
    const reset = prev === null || state.forceReset;
    try {
      const landed = lane.sampleLanes(state, snapshot, ts);
      postLaneColumns(state, snapshot, landed);
      const levelsChanged = state.tracker.update({ ts, column, snapshot, rowClusters: state.rowClusters, referenceRows: state.referenceRows });
      const aggressiveChanged = state.aggressive ? state.aggressive.update({ ts, column, snapshot, rowClusters: state.rowClusters }) : false;
      const frame = buildFrame(symbol, marketKind, {
        ts,
        seq,
        reset,
        rowWidth: state.rowWidth,
        columnMs,
        columns: [encodeAfter(reset ? null : prev, column)],
        ...(reset || levelsChanged ? { levels: state.tracker.levels() } : {}),
        ...(state.aggressive && (reset || aggressiveChanged) ? { aggressive: state.aggressive.events() } : {}),
        ...(state.backfillStatus ? { backfill: state.backfillStatus } : {}),
      });
      state.forceReset = false;
      collectL2(state, engine, ts, column, landed);
      let deepFrame = null;
      const coarseFrames = [];
      const deepColumn = lane.feedDeep(state, column);
      if (deepColumn && !lane.holdDeep(state, deepColumn)) {
        const deepPrev = state.deep.latest();
        const deepSeq = state.deep.push(deepColumn);
        const deepReset = deepPrev === null || state.deepForceReset;
        deepFrame = buildFrame(symbol, marketKind, {
          ts: deepColumn.ts,
          seq: deepSeq,
          reset: deepReset,
          rowWidth: state.rowWidth,
          columnMs: deepColumnMs,
          columns: [encodeAfter(deepReset ? null : deepPrev, deepColumn)],
        });
        state.deepForceReset = false;
        for (const landed of lane.syncCoarse(state)) {
          const coarseReset = landed.prev === null || state.coarseForceReset;
          coarseFrames.push(buildFrame(symbol, marketKind, {
            ts: landed.column.ts,
            seq: landed.seq,
            reset: coarseReset,
            rowWidth: state.rowWidth * coarseRows,
            columnMs: coarseColumnMs,
            columns: [encodeColumn(coarseReset ? null : landed.prev, landed.column)],
          }));
          state.coarseForceReset = false;
        }
      }
      if (state.announce && announceDue(state, at)) {
        state.announce = false;
        state.announceNow = false;
        state.announcedAt = at;
        state.snapshotTick = true;
        return snapshotFrames(marketKind, symbol);
      }
      return deepFrame ? [...coarseFrames, deepFrame, frame] : frame;
    } catch (error) {
      state.forceReset = true;
      state.deepForceReset = true;
      state.coarseForceReset = true;
      throw error;
    }
  }

  function snapshotFrames(marketKind, symbol) {
    const startedAt = performance.now();
    const frames = buildSnapshotFrames(marketKind, symbol);
    const tookMs = performance.now() - startedAt;
    if (tookMs > slowStepMs) log(`liquidity-publisher: slow step: snapshot for ${pairKey(marketKind, symbol)} took ${Math.round(tookMs)} ms (${frames.length} frames)`);
    return frames;
  }

  function buildSnapshotFrames(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state || lane.retained(state) === 0) return [];
    ctx.lastKey = state.key;
    try {
      for (const history of [state.coarse, state.deep, state.history]) history?.rebase();
      const tiers = [];
      if (state.coarse && state.coarse.length > 0) tiers.push({ chunks: state.coarse.snapshotChunks(MAX_LIQUIDITY_COLUMNS), ms: coarseColumnMs, rowWidth: state.rowWidth * coarseRows });
      if (state.deep && state.deep.length > 0) tiers.push({ chunks: state.deep.snapshotChunks(MAX_LIQUIDITY_COLUMNS), ms: deepColumnMs, rowWidth: state.rowWidth });
      if (state.history.length > 0) tiers.push({ chunks: state.history.snapshotChunks(MAX_LIQUIDITY_COLUMNS), ms: columnMs, rowWidth: state.rowWidth });
      const frames = [];
      tiers.forEach((tier, t) => tier.chunks.forEach((chunk, index) => {
        const last = t === tiers.length - 1 && index === tier.chunks.length - 1;
        const levels = last ? state.tracker.levels() : [];
        const events = last && state.aggressive ? state.aggressive.events() : [];
        let ts = chunk.columns[chunk.columns.length - 1].ts;
        for (const level of levels) ts = Math.max(ts, level.endTs ?? level.startTs);
        for (const event of events) ts = Math.max(ts, event.endTs ?? event.startTs);
        frames.push(buildFrame(symbol, marketKind, {
          ts,
          seq: chunk.seq,
          reset: index === 0,
          rowWidth: tier.rowWidth,
          columnMs: tier.ms,
          columns: chunk.columns,
          ...(last ? { levels } : {}),
          ...(last && state.aggressive ? { aggressive: events } : {}),
          ...(last && state.backfillStatus ? { backfill: state.backfillStatus } : {}),
        }));
      }));
      return frames;
    } catch (error) {
      const dropped = dropUnsendable(state);
      if (dropped > 0) {
        log(`liquidity-publisher: dropped ${dropped} column${dropped === 1 ? "" : "s"} for ${state.key} that cannot be sent: ${error?.message ?? error}`);
        state.announce = true;
        state.announceNow = true;
        return [];
      }
      log(`liquidity-publisher: snapshot failed: ${error?.message ?? error}`);
      states.delete(state.key);
      scheduler?.cancel(state.key);
      if (storeEnabled && !state.backfilling && state.restoredFrom !== null) {
        dropHistory({ dir: storeDir, pairKey: state.key });
        log(`liquidity-publisher: dropped the stored history for ${state.key}: the picture it gave back cannot be sent`);
      }
      return [];
    }
  }

  return Object.freeze({ tickColumn, snapshotFrames, buildSnapshotFrames, flushL2 });
}

module.exports = { createLaneFrames };
