"use strict";

const { MAX_LIQUIDITY_LEVELS, MAX_AGGRESSIVE_EVENTS } = require("../../../server/frames");
const { laneZeroGeometry } = require("../../passive_liquidity/liquidity-geometry");
const { createLiquidityHistory, createDeepFolder, encodeAfter, decodeColumn, coarsenColumn } = require("../../passive_liquidity/liquidity-history");
const { createColumnFlow } = require("../../passive_liquidity/column-flow");
const { createAggressiveOrdersTracker } = require("../../passive_liquidity/aggressive-orders-tracker");
const { createWallService } = require("../wall-service");
const { createWallHistory } = require("../history/wall-history");
const { createEventHistory } = require("../history/event-history");
const { sampleLiquidityColumn, laneFoldFor } = require("../../passive_liquidity/liquidity-sampler");
const { lanesFor, laneWindowPctFor } = require("./lane-geometry");

const DEFAULT_LEVEL_MIN_SIZE = 1;
const STORE_TRIM_TARGET = 0.9;

function createLaneOps(ctx) {
  const {
    memory, rowBp, windowBp, referenceBp, columnMs, deepColumnMs, coarseColumnMs, coarseRows, historyS, deepS,
    levelMinUsd, wallMultiplier, wallGapRows, wallSettleMs, sizeDigits, storeEnabled, storeMaxAgeS, storeMaxAgeMs,
    storeMaxBytes, aggressive, aggressiveEnabled, maxColumns, deepEnabled, maxDeepColumns, coarseEnabled, maxCoarseColumns, log,
    laneWindowPct, wallHistoryMaxBytes, tradeHistoryMaxBytes, wallTradeHistoryMaxBytes, fillMs, histories,
  } = ctx;

  function createLane(geometry, keyFor) {
    return {
      ...geometry,
      flow: createColumnFlow({ keyFor, rowClusters: geometry.rowClusters, columnMs, sizeDigits }),
      timeFolder: createDeepFolder({ deepColumnMs: geometry.columnMs }),
      history: createLiquidityHistory({ maxColumns: Math.max(1, Math.ceil(maxColumns / geometry.factor)) }),
      deepFolder: deepEnabled ? createDeepFolder({ deepColumnMs: geometry.deepColumnMs }) : null,
      deep: deepEnabled ? createLiquidityHistory({ maxColumns: Math.max(1, Math.ceil(maxDeepColumns / geometry.factor)) }) : null,
      rebuilt: null,
    };
  }

  function lanesOf(marketKind, symbol, price, rowClusters, rowWidth, windowRows, keyFor) {
    const override = typeof memory.laneWindowPct === "function" ? Number(memory.laneWindowPct(marketKind, symbol)) : null;
    const windowPct = laneWindowPctFor(marketKind, laneWindowPct, override);
    const geometries = lanesFor({ price, rowClusters, rowWidth, windowRows, windowPct, columnMs, deepColumnMs });
    return { windowPct, lanes: geometries.map((geometry) => createLane(geometry, keyFor)) };
  }

  function createLaneState(key, marketKind, symbol, engine) {
    const snap = engine.snapshot();
    const refKey = snap.bestBidKey ?? snap.bestAskKey ?? null;
    const price = refKey === null ? null : snap.priceFor(refKey);
    const configuredRows = typeof memory.rowClusters === "function" ? memory.rowClusters(marketKind, symbol) : null;
    const pin = Number.isSafeInteger(configuredRows) && configuredRows > 0 ? null : ctx.pyramid?.pinned(marketKind, symbol) ?? null;
    const pinnedRows = pin !== null && pin.tickSize === engine.tickSize && pin.clusterTicks === engine.clusterTicks && Number.isSafeInteger(pin.rowClusters) ? pin.rowClusters : null;
    const fixedRows = pinnedRows ?? configuredRows;
    const { rowClusters, rowWidth, windowRows, referenceRows } = laneZeroGeometry({ price, clusterWidth: snap.clusterWidth, fixedRows, rowBp, windowBp, referenceBp });
    const notional = typeof memory.notionalMultiplier === "function" ? Number(memory.notionalMultiplier(marketKind, symbol)) : 1;
    const multiplier = Number.isFinite(notional) && notional > 0 ? notional : 1;
    const state = {
      key,
      marketKind,
      symbol,
      rowClusters,
      windowRows,
      referenceRows,
      rowWidth,
      tickSize: engine.tickSize,
      clusterTicks: engine.clusterTicks,
      pinnedRows: pinnedRows !== null,
      pyramidDeep: null,
      pyramidFill: null,
      forceReset: false,
      deepForceReset: false,
      savedAt: 0,
      deepPending: null,
      deepBusy: false,
      repairTried: new Set(),
      deepFolder: deepEnabled ? createDeepFolder({ deepColumnMs }) : null,
      backfilling: false,
      backfillStatus: null,
      recentReadiness: { state: "IDLE", reason: "NOT_STARTED" },
      deepReadiness: deepEnabled ? { state: "IDLE", reason: "NOT_STARTED" } : { state: "DISABLED", reason: "DISABLED_BY_CONFIG" },
      rebuilt: null,
      liveDuringPass: null,
      priorColumns: null,
      lastAnnounceAt: 0,
      announcedAt: 0,
      announceNow: false,
      savedFingerprint: null,
      restoredFrom: null,
      announce: false,
      snapshotTick: false,
      holdingSince: null,
      history: createLiquidityHistory({ maxColumns }),
      deep: null,
      coarse: null,
      coarseFolder: coarseEnabled ? createDeepFolder({ deepColumnMs: coarseColumnMs }) : null,
      coarseFoldedThrough: -Infinity,
      coarseForceReset: false,
      coarseBusy: false,
      coarseReadiness: coarseEnabled ? { state: "IDLE", reason: "NOT_STARTED" } : { state: "DISABLED", reason: "DISABLED_BY_CONFIG" },
      fillReadiness: deepEnabled && storeEnabled && fillMs > 0 ? { state: "IDLE", reason: "NOT_STARTED" } : { state: "DISABLED", reason: "DISABLED_BY_CONFIG" },
      fillBusy: false,
      shelf: [],
      shelfLast: null,
      shelfTrimmedBefore: null,
      standing: [],
      birthsFromPass: false,
      emptyPasses: [],
      liveFrom: null,
      saving: false,
      saveGeneration: 0,
      trackerOptions: {
        minSize: price !== null ? levelMinUsd / (price * multiplier) : DEFAULT_LEVEL_MIN_SIZE,
        multiplier: wallMultiplier,
        gapRows: wallGapRows,
        settleMs: wallSettleMs,
        keepEndedMs: Math.max(1, Math.round(historyS * 1_000)),
        deepKeepEndedMs: Math.max(1, Math.round((deepEnabled ? Math.max(deepS, storeEnabled ? storeMaxAgeS : 0) : historyS) * 1_000)),
        maxLevels: MAX_LIQUIDITY_LEVELS,
      },
    };
    state.deep = deepEnabled ? createLiquidityHistory({ maxColumns: maxDeepColumns, onEvict: (column) => shelve(state, column) }) : null;
    state.coarse = coarseEnabled ? createLiquidityHistory({ maxColumns: maxCoarseColumns }) : null;
    state.wallHistory = createWallHistory({ maxAgeMs: Math.max(1, storeMaxAgeMs), maxBytes: wallHistoryMaxBytes });
    state.eventHistory = createEventHistory({ columnMs, deepColumnMs: deepEnabled ? deepColumnMs : columnMs, recentMs: Math.round(historyS * 1_000), maxAgeMs: Math.max(1, storeMaxAgeMs), maxTradeBytes: tradeHistoryMaxBytes, maxWallTradeBytes: wallTradeHistoryMaxBytes });
    state.tracker = createWallService({
      engine,
      ...(histories ? {
        onEnded: (wall) => state.wallHistory.record([wall]),
        onTrades: (trades) => state.eventHistory.recordTrades(trades),
        onWallTrade: (trade) => state.eventHistory.recordWallTrades([trade]),
      } : {}),
      ...state.trackerOptions,
    });
    const keyFor = typeof engine.keyFor === "function" ? engine.keyFor : (value) => Math.floor(value / snap.clusterWidth);
    state.flow = createColumnFlow({ keyFor, rowClusters, columnMs, sizeDigits });
    state.aggressiveOptions = { ...aggressive, rowClusters, keepEndedMs: state.trackerOptions.deepKeepEndedMs, maxEvents: MAX_AGGRESSIVE_EVENTS };
    state.aggressive = aggressiveEnabled ? createAggressiveOrdersTracker(state.aggressiveOptions) : null;
    const { windowPct, lanes } = lanesOf(marketKind, symbol, price, rowClusters, rowWidth, windowRows, keyFor);
    state.laneWindowPct = windowPct;
    state.lanes = lanes;
    return state;
  }

  function pushPrint(state, print) {
    state.flow.push(print);
    for (const lane of state.lanes) lane.flow.push(print);
  }

  function pruneFlows(state, ts) {
    state.flow.prune(ts);
    for (const lane of state.lanes) lane.flow.prune(ts);
  }

  function pushIfNewer(history, column) {
    const latest = history.latest();
    if (latest && column.ts <= latest.ts) return null;
    const seq = history.push(column);
    return { prev: latest, seq };
  }

  function sampleLanes(state, snapshot, ts) {
    const landed = [];
    for (const lane of state.lanes) {
      const sampled = sampleLiquidityColumn(snapshot, { ts, rowClusters: lane.rowClusters, windowRows: lane.windowRows, sizeDigits, fold: laneFoldFor(state.marketKind) });
      if (!sampled) continue;
      const column = lane.flow.take(sampled);
      const finished = lane.timeFolder.feed(column);
      if (finished) {
        const pushed = pushIfNewer(lane.history, finished);
        if (pushed) landed.push({ entry: lane, tier: "recent", prev: pushed.prev, column: finished, seq: pushed.seq });
      }
      if (!lane.deep) continue;
      const deepColumn = lane.deepFolder.feed(column);
      if (deepColumn) {
        const pushed = pushIfNewer(lane.deep, deepColumn);
        if (pushed) landed.push({ entry: lane, tier: "deep", prev: pushed.prev, column: deepColumn, seq: pushed.seq });
      }
    }
    return landed;
  }

  function mergeLaneColumns(history, columns) {
    if (!history || columns.length === 0) return 0;
    return history.merge(columns);
  }

  function foldColumns(columns, foldMs, openTs = null) {
    const folder = createDeepFolder({ deepColumnMs: foldMs });
    const out = [];
    for (const column of columns) {
      const done = folder.feed(column);
      if (done) out.push(done);
    }
    const last = folder.flush();
    if (last) out.push(last);
    return openTs === null ? out : out.filter((column) => column.ts < openTs);
  }

  function breakChain(state, entry, added) {
    if (added > 0 && state.l2) state.l2.chainBroken.add(entry.k);
  }

  function finishLanePass(state) {
    for (const entry of state.lanes) {
      if (!entry.rebuilt) continue;
      breakChain(state, entry, mergeLaneColumns(entry.history, entry.rebuilt));
      if (entry.deep) breakChain(state, entry, mergeLaneColumns(entry.deep, foldColumns(entry.rebuilt, entry.deepColumnMs, entry.deepFolder.open)));
      entry.rebuilt = null;
    }
  }

  function mergeLaneDeep(state, rebuiltByLane) {
    rebuiltByLane.forEach((columns, index) => {
      const entry = state.lanes[index];
      if (entry && entry.deep) breakChain(state, entry, mergeLaneColumns(entry.deep, columns));
    });
  }

  function laneGeometry(lane) {
    return {
      k: lane.k,
      rowWidth: lane.rowWidth,
      rowClusters: lane.rowClusters,
      windowRows: lane.windowRows,
      columnMs: lane.columnMs,
      deepColumnMs: lane.deep ? lane.deepColumnMs : 0,
    };
  }

  function laneSpecs(state) {
    return state.lanes.map((lane) => ({ rowClusters: lane.rowClusters, windowRows: lane.windowRows, factor: lane.factor }));
  }

  function holdDeep(state, column) {
    if (!state.deepPending) return false;
    state.deepPending.push(column);
    if (state.deepPending.length > maxDeepColumns) state.deepPending.shift();
    return true;
  }

  function feedDeep(state, column) {
    if (!state.deep) return null;
    const finished = state.deepFolder.feed(column);
    if (!finished) return null;
    const latest = state.deep.latest();
    if (latest && finished.ts <= latest.ts) return null;
    return finished;
  }

  function mergeRebuilt(state) {
    const live = state.liveDuringPass;
    const firstLive = live.length > 0 ? live[0].ts : Infinity;
    const firstRebuilt = state.rebuilt.length > 0 ? state.rebuilt[0].ts : firstLive;
    state.history.clear();
    for (const column of state.priorColumns) if (column.ts < firstRebuilt) state.history.push(column);
    for (const column of state.rebuilt) if (column.ts < firstLive) state.history.push(column);
    for (const column of live) state.history.push(column);
  }

  function syncCoarse(state) {
    if (!state.coarse || !state.deep) return [];
    const landed = [];
    for (const column of state.deep.toArray()) {
      if (column.ts <= state.coarseFoldedThrough) continue;
      const finished = state.coarseFolder.feed(coarsenColumn(column, coarseRows));
      state.coarseFoldedThrough = column.ts;
      if (!finished) continue;
      const prev = state.coarse.latest();
      if (prev && finished.ts <= prev.ts) continue;
      const seq = state.coarse.push(finished);
      landed.push({ column: finished, prev, seq });
    }
    return landed;
  }

  function rebuildCoarse(state) {
    if (!state.coarse || !state.deep) return;
    const first = state.deep.toArray()[0];
    const kept = state.coarse.toArray().filter((column) => first === undefined || column.ts + coarseColumnMs <= first.ts);
    state.coarse.clear();
    for (const column of kept) state.coarse.push(column);
    state.coarseFolder = createDeepFolder({ deepColumnMs: coarseColumnMs });
    state.coarseFoldedThrough = kept.length > 0 ? kept[kept.length - 1].ts + coarseColumnMs - 1 : -Infinity;
    syncCoarse(state);
  }

  function foldRebuiltDeep(state) {
    if (!state.deep) return;
    const folder = createDeepFolder({ deepColumnMs });
    const open = state.deepFolder.open;
    const finished = [];
    for (const column of state.rebuilt) {
      if (open !== null && Math.floor(column.ts / deepColumnMs) * deepColumnMs === open) {
        state.deepFolder.feed(column);
        continue;
      }
      const done = folder.feed(column);
      if (done) finished.push(done);
    }
    const last = folder.flush();
    if (last && (open === null || last.ts < open)) finished.push(last);
    for (const column of finished) {
      const latest = state.deep.latest();
      if (!holdDeep(state, column) && (!latest || column.ts > latest.ts)) state.deep.push(column);
    }
    syncCoarse(state);
  }

  function finishRecentPass(state) {
    mergeRebuilt(state);
    foldRebuiltDeep(state);
    state.rebuilt = null;
    state.liveDuringPass = null;
    state.priorColumns = null;
    state.backfilling = false;
    state.announce = retained(state) > 0;
    state.announceNow = state.announce;
  }

  function retained(state) {
    return state.history.length + (state.deep ? state.deep.length : 0) + (state.coarse ? state.coarse.length : 0);
  }

  function geometryOf(state) {
    return {
      rowWidth: state.rowWidth,
      rowClusters: state.rowClusters,
      windowRows: state.windowRows,
      columnMs,
      deepColumnMs: state.deep ? deepColumnMs : 0,
    };
  }

  function encodedColumns(history) {
    if (!history || history.length === 0) return [];
    const chunks = history.snapshotChunks(Number.MAX_SAFE_INTEGER);
    return chunks.length > 0 ? [...chunks[0].columns] : [];
  }

  function shelve(state, column) {
    if (state.shelfLast !== null && column.ts <= state.shelfLast.ts) return false;
    state.shelf.push(encodeAfter(state.shelfLast, column));
    state.shelfLast = column;
    return true;
  }

  function dropShelfFront(state, first) {
    if (first <= 0) return;
    if (first >= state.shelf.length) {
      state.shelf = [];
      state.shelfLast = null;
      return;
    }
    let prev = null;
    for (let index = 0; index < first; index += 1) prev = decodeColumn(prev, state.shelf[index]);
    const head = decodeColumn(prev, state.shelf[first]);
    state.shelf = [encodeAfter(null, head), ...state.shelf.slice(first + 1)];
  }

  function pruneShelf(state, at) {
    const cutoff = at - storeMaxAgeMs;
    if (state.shelf.length === 0 || state.shelf[0].ts >= cutoff) return;
    let first = 0;
    while (first < state.shelf.length && state.shelf[first].ts < cutoff) first += 1;
    dropShelfFront(state, first);
  }

  function trimShelfToBudget(state, bytes) {
    if (state.shelf.length === 0 || !Number.isFinite(bytes) || bytes <= 0) return false;
    const share = Math.min(1, Math.max(0, 1 - (STORE_TRIM_TARGET * storeMaxBytes) / bytes));
    const count = Math.max(1, Math.ceil(state.shelf.length * share));
    dropShelfFront(state, count);
    state.shelfTrimmedBefore = state.shelf.length > 0 ? state.shelf[0].ts : (state.deep?.toArray()[0]?.ts ?? null);
    log(`liquidity-publisher: trimmed the ${count} oldest stored deep columns for ${state.key} to keep the store under ${storeMaxBytes} bytes (was ${bytes})`);
    return true;
  }

  function deepColumnsForStore(state) {
    if (!state.deep) return [];
    if (state.shelfLast === null) return encodedColumns(state.deep);
    const wire = state.shelf.slice();
    let prev = state.shelfLast;
    for (const column of state.deep.toArray()) {
      if (column.ts <= prev.ts) continue;
      wire.push(encodeAfter(prev, column));
      prev = column;
    }
    return wire;
  }

  return Object.freeze({
    createLaneState, holdDeep, feedDeep, mergeRebuilt, syncCoarse, rebuildCoarse, foldRebuiltDeep, finishRecentPass,
    retained, geometryOf, encodedColumns, shelve, dropShelfFront, pruneShelf, trimShelfToBudget, deepColumnsForStore,
    pushPrint, pruneFlows, sampleLanes, mergeLaneColumns, foldColumns, laneGeometry, laneSpecs,
    finishLanePass, mergeLaneDeep,
  });
}

module.exports = { createLaneOps, DEFAULT_LEVEL_MIN_SIZE };
