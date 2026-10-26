"use strict";

const { liquidityFrame, MAX_WIRE_MAGNITUDE } = require("../../server/frames");
const { DEFAULT_DB_PATH } = require("../../storage/storage-db");
const { rowClustersFor, windowRowsFor, MAX_WINDOW_ROWS } = require("./liquidity-geometry");
const { DEFAULT_SIZE_DIGITS } = require("./liquidity-sampler");
const { saveLiquidityHistory, saveLiquidityHistoryAsync, loadLiquidityHistory, loadLiquidityHistoryAsync, dropLiquidityHistory, sweepStoreTemporaries, DEFAULT_STORE_DIR } = require("../l2-memory/liquidity-store");
const { saveWallHistory: saveWallHistoryFile, saveWallHistoryAsync, loadWallHistory: loadWallHistoryFile } = require("../l2-memory/history/wall-history-store");
const { DEFAULT_MAX_BYTES: DEFAULT_WALL_HISTORY_MAX_BYTES } = require("../l2-memory/history/wall-history");
const { DEFAULT_TRADE_BYTES, DEFAULT_WALL_TRADE_BYTES } = require("../l2-memory/history/event-history");
const { DEFAULT_MULTIPLIER, DEFAULT_GAP_ROWS, DEFAULT_SETTLE_MS } = require("./large-level-tracker");
const { backfillLiquidity } = require("../l2-memory/liquidity-backfill");
const { createBackfillScheduler, DEFAULT_MAX_WORKERS, DEFAULT_TIMEOUT_MS } = require("../l2-memory/liquidity-backfill-scheduler");
const { createLaneOps } = require("../l2-memory/compact/lane");
const { createLaneStore } = require("../l2-memory/compact/lane-store");
const { createLaneRebuild } = require("../l2-memory/compact/lane-rebuild");
const { createLaneFrames } = require("../l2-memory/compact/lane-frames");
const { createLaneL2 } = require("../l2-memory/compact/lane-l2");
const { createLaneWallsClient } = require("../l2-memory/compact/lane-walls-client");
const { DEFAULT_WINDOW_PCT } = require("../l2-memory/compact/lane-geometry");
const { createPyramidWarmup, withDetail, noteOf } = require("../l2-memory/pyramid/pyramid-warmup");
const { createPyramidReader } = require("../l2-memory/pyramid/pyramid-reader");
const { defaultHeatmapDir } = require("../l2-memory/pyramid/pyramid-paths");
const { createRemoteStorageReader } = require("../../storage/remote-storage-reader");

function defaultPyramidWarmup(remoteReplay, now, log) {
  if (remoteReplay !== null) {
    const note = { last: null };
    const reader = createRemoteStorageReader({ baseUrl: remoteReplay.baseUrl, token: remoteReplay.token, log: noteOf(note), warn: noteOf(note) });
    return createPyramidWarmup({
      now, log,
      read: withDetail((provider, symbol, kind, options) => reader.readHeatmapColumns(symbol, kind, options, { provider }), note),
      readWalls: withDetail((provider, symbol, kind, options) => reader.readWallHistory(symbol, kind, options, { provider }), note),
      readEvents: withDetail((provider, symbol, kind, options) => reader.readEventHistory(symbol, kind, options, { provider }), note),
      close: () => reader.close(),
    });
  }
  const reader = createPyramidReader({ dir: process.env.TT_HEATMAP_DIR || defaultHeatmapDir() });
  return createPyramidWarmup({
    now, log,
    read: async (provider, symbol, kind, options) => reader.readHeatmapColumns(provider, symbol, kind, options),
    readWalls: async (provider, symbol, kind, options) => reader.readWallHistory(provider, symbol, kind, options),
    readEvents: async (provider, symbol, kind, options) => reader.readEventHistory(provider, symbol, kind, options),
    close: () => reader.close(),
  });
}

const DEFAULT_ROW_BP = 0.5;
const DEFAULT_WINDOW_BP = 600;
const DEFAULT_COLUMN_MS = 1_000;
const DEFAULT_HISTORY_S = 1_200;
const DEFAULT_DEEP_S = 4 * 3_600;
const DEFAULT_DEEP_COLUMN_MS = 10_000;
const DEFAULT_COARSE_S = 0;
const DEFAULT_COARSE_COLUMN_MS = 300_000;
const DEFAULT_COARSE_ROWS = 40;
const DEFAULT_COARSE_CHUNK_S = 7_200;
const DEFAULT_BACKFILL_MAX_S = 600;
const DEFAULT_DEEP_CHUNK_S = 1_200;
const DEFAULT_STORE_MAX_AGE_S = 7 * 24 * 3_600;
const DEFAULT_STORE_S = 300;
const DEFAULT_STORE_MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_LEVEL_MIN_USD = 500_000;
const DEFAULT_REFERENCE_BP = 50;
const DEFAULT_BACKFILL_ANNOUNCE_S = 60;
const DEFAULT_FILL_S = 24 * 3_600;

function positiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function liquidityOptionsFromEnv(env = process.env) {
  const options = {};
  const rowBp = positiveNumber(env.L2_HEATMAP_ROW_BP);
  if (rowBp !== undefined) options.rowBp = rowBp;
  const windowBp = positiveNumber(env.L2_HEATMAP_WINDOW_BP);
  if (windowBp !== undefined) options.windowBp = windowBp;
  const columnMs = positiveNumber(env.L2_HEATMAP_COLUMN_MS);
  if (columnMs !== undefined) options.columnMs = Math.round(columnMs);
  const historyS = positiveNumber(env.L2_HEATMAP_HISTORY_S);
  if (historyS !== undefined) options.historyS = historyS;
  const deepS = Number(env.L2_HEATMAP_DEEP_S);
  if (Number.isFinite(deepS) && deepS >= 0 && env.L2_HEATMAP_DEEP_S !== undefined && env.L2_HEATMAP_DEEP_S !== "") options.deepS = deepS;
  const deepColumnMs = positiveNumber(env.L2_HEATMAP_DEEP_COLUMN_MS);
  if (deepColumnMs !== undefined) options.deepColumnMs = Math.round(deepColumnMs);
  const coarseS = Number(env.L2_HEATMAP_COARSE_S);
  if (Number.isFinite(coarseS) && coarseS >= 0 && env.L2_HEATMAP_COARSE_S !== undefined && env.L2_HEATMAP_COARSE_S !== "") options.coarseS = coarseS;
  const coarseColumnMs = positiveNumber(env.L2_HEATMAP_COARSE_COLUMN_MS);
  if (coarseColumnMs !== undefined) options.coarseColumnMs = Math.round(coarseColumnMs);
  const coarseRows = Number(env.L2_HEATMAP_COARSE_ROWS);
  if (Number.isSafeInteger(coarseRows) && coarseRows > 0) options.coarseRows = coarseRows;
  if (env.L2_HEATMAP_STORE === "1") options.storeEnabled = true;
  if (env.L2_HEATMAP_STORE === "0") options.storeEnabled = false;
  if (typeof env.L2_HEATMAP_STORE_DIR === "string" && env.L2_HEATMAP_STORE_DIR.length > 0) options.storeDir = env.L2_HEATMAP_STORE_DIR;
  const storeS = positiveNumber(env.L2_HEATMAP_STORE_S);
  if (storeS !== undefined) options.storeS = storeS;
  const levelMinUsd = positiveNumber(env.L2_HEATMAP_LEVEL_MIN_USD);
  if (levelMinUsd !== undefined) options.levelMinUsd = levelMinUsd;
  const wallMultiplier = Number(env.L2_HEATMAP_WALL_MULT);
  if (Number.isFinite(wallMultiplier) && wallMultiplier >= 0) options.wallMultiplier = wallMultiplier;
  const referenceBp = positiveNumber(env.L2_HEATMAP_REF_BP);
  if (referenceBp !== undefined) options.referenceBp = referenceBp;
  const wallSettleMs = Number(env.L2_HEATMAP_WALL_SETTLE_MS);
  if (Number.isSafeInteger(wallSettleMs) && wallSettleMs >= 0) options.wallSettleMs = wallSettleMs;
  const wallGapRows = Number(env.L2_HEATMAP_WALL_GAP);
  if (Number.isSafeInteger(wallGapRows) && wallGapRows >= 0) options.wallGapRows = wallGapRows;
  if (env.L2_HEATMAP_BACKFILL === "1") options.backfillEnabled = true;
  if (env.L2_HEATMAP_BACKFILL === "0") options.backfillEnabled = false;
  const backfillMaxS = positiveNumber(env.L2_HEATMAP_BACKFILL_MAX_S);
  if (backfillMaxS !== undefined) options.backfillMaxS = backfillMaxS;
  const deepChunkS = positiveNumber(env.L2_HEATMAP_DEEP_CHUNK_S);
  if (deepChunkS !== undefined) options.deepChunkS = deepChunkS;
  const backfillWorkers = Number(env.L2_HEATMAP_BACKFILL_WORKERS);
  if (Number.isSafeInteger(backfillWorkers) && backfillWorkers > 0) options.backfillWorkers = backfillWorkers;
  const backfillTimeoutS = positiveNumber(env.L2_HEATMAP_BACKFILL_TIMEOUT_S);
  if (backfillTimeoutS !== undefined) options.backfillTimeoutS = backfillTimeoutS;
  const backfillAnnounceS = positiveNumber(env.L2_HEATMAP_BACKFILL_ANNOUNCE_S);
  if (backfillAnnounceS !== undefined) options.backfillAnnounceS = backfillAnnounceS;
  const fillS = Number(env.L2_HEATMAP_FILL_S);
  if (Number.isFinite(fillS) && fillS >= 0 && env.L2_HEATMAP_FILL_S !== undefined && env.L2_HEATMAP_FILL_S !== "") options.fillHistoryS = fillS;
  const storeMaxAgeS = positiveNumber(env.L2_HEATMAP_STORE_MAX_AGE_S);
  if (storeMaxAgeS !== undefined) options.storeMaxAgeS = storeMaxAgeS;
  const storeMaxBytes = positiveNumber(env.L2_HEATMAP_STORE_MAX_BYTES);
  if (storeMaxBytes !== undefined) options.storeMaxBytes = Math.floor(storeMaxBytes);
  if (typeof env.L2_HEATMAP_HISTORY_FLOOR === "string" && env.L2_HEATMAP_HISTORY_FLOOR.length > 0) {
    const floor = Date.parse(env.L2_HEATMAP_HISTORY_FLOOR);
    if (Number.isFinite(floor)) options.historyFloorMs = floor;
  }
  if (typeof env.L2_HEATMAP_DB_PATH === "string" && env.L2_HEATMAP_DB_PATH.length > 0) options.dbPath = env.L2_HEATMAP_DB_PATH;
  if (typeof env.TT_LIVE_STORAGE_SERVICE_URL === "string" && env.TT_LIVE_STORAGE_SERVICE_URL.length > 0 &&
      typeof env.TT_LIVE_STORAGE_CLIENT_TOKEN === "string" && env.TT_LIVE_STORAGE_CLIENT_TOKEN.length > 0) {
    options.remoteReplay = {
      baseUrl: env.TT_LIVE_STORAGE_SERVICE_URL,
      token: env.TT_LIVE_STORAGE_CLIENT_TOKEN,
    };
  }
  if (env.L2_HEATMAP_PYRAMID === "0") options.pyramid = null;
  if (env.L2_HEATMAP_PYRAMID === "1") options.pyramid = "auto";
  if (env.L2_HEATMAP_LANES === "0") options.laneWindowPct = null;
  if (env.L2_WIRE === "0") options.l2 = false;
  if (env.L2_LANE_WALLS === "0") options.laneWalls = false;
  if (env.L2_LANE_WALLS === "1") options.laneWalls = true;
  if (env.L2_HEATMAP_HISTORY === "0") options.histories = false;
  if (env.L2_HEATMAP_HISTORY === "1") options.histories = true;
  if (env.L2_AGGRESSIVE === "0") options.aggressiveEnabled = false;
  if (env.L2_AGGRESSIVE === "1") options.aggressiveEnabled = true;
  const aggressive = {};
  const percentile = Number(env.L2_AGGRESSIVE_PERCENTILE);
  if (Number.isFinite(percentile) && percentile > 0 && percentile <= 1) aggressive.floorPercentile = percentile;
  const floor = positiveNumber(env.L2_AGGRESSIVE_FLOOR);
  if (floor !== undefined && floor > MAX_WIRE_MAGNITUDE) throw new Error(`L2_AGGRESSIVE_FLOOR must not exceed the wire magnitude ${MAX_WIRE_MAGNITUDE}`);
  if (floor !== undefined) aggressive.floor = floor;
  const minFloor = Number(env.L2_AGGRESSIVE_MIN);
  if (Number.isFinite(minFloor) && minFloor > MAX_WIRE_MAGNITUDE) throw new Error(`L2_AGGRESSIVE_MIN must not exceed the wire magnitude ${MAX_WIRE_MAGNITUDE}`);
  if (Number.isFinite(minFloor) && minFloor >= 0 && env.L2_AGGRESSIVE_MIN !== undefined && env.L2_AGGRESSIVE_MIN !== "") aggressive.minFloor = minFloor;
  if (Object.keys(aggressive).length > 0) options.aggressive = aggressive;
  return options;
}

function pairKey(marketKind, symbol) {
  return `${marketKind}:${symbol}`;
}

const DEFAULT_RESTORE_SLICE_COLUMNS = 250;
const SLOW_STEP_MS = 250;

const LIQUIDITY_WARN_LINE = /no backfill|no deep backfill|hides|old:|holding columns|span more than|was not restored|holds no trades|slow step/i;
const LIQUIDITY_ERROR_LINE = /failed|could not|unavailable|dropped|would not load/i;

function liquidityLogLevel(line) {
  const text = String(line);
  if (LIQUIDITY_WARN_LINE.test(text)) return "warn";
  if (LIQUIDITY_ERROR_LINE.test(text)) return "error";
  return "info";
}

function defaultLiquidityLog(line) {
  const text = String(line);
  const level = liquidityLogLevel(text);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.info(text);
}

function createLiquidityPublisher({
  memory,
  buildFrame = liquidityFrame,
  rowBp = DEFAULT_ROW_BP,
  windowBp = DEFAULT_WINDOW_BP,
  columnMs = DEFAULT_COLUMN_MS,
  historyS = DEFAULT_HISTORY_S,
  deepS = DEFAULT_DEEP_S,
  deepChunkS = DEFAULT_DEEP_CHUNK_S,
  deepColumnMs = DEFAULT_DEEP_COLUMN_MS,
  coarseS = DEFAULT_COARSE_S,
  coarseColumnMs = DEFAULT_COARSE_COLUMN_MS,
  coarseRows = DEFAULT_COARSE_ROWS,
  coarseSampleMs = Math.min(deepColumnMs, coarseColumnMs),
  coarseChunkS = DEFAULT_COARSE_CHUNK_S,
  levelMinUsd = DEFAULT_LEVEL_MIN_USD,
  wallMultiplier = DEFAULT_MULTIPLIER,
  referenceBp = DEFAULT_REFERENCE_BP,
  wallGapRows = DEFAULT_GAP_ROWS,
  wallSettleMs = DEFAULT_SETTLE_MS,
  sizeDigits = DEFAULT_SIZE_DIGITS,
  backfillEnabled = true,
  backfillMaxS = DEFAULT_BACKFILL_MAX_S,
  backfillWorkers = DEFAULT_MAX_WORKERS,
  backfillTimeoutS = DEFAULT_TIMEOUT_MS / 1_000,
  backfillAnnounceS = DEFAULT_BACKFILL_ANNOUNCE_S,
  storeMaxAgeS = DEFAULT_STORE_MAX_AGE_S,
  storeMaxBytes = DEFAULT_STORE_MAX_BYTES,
  historyFloorMs = 0,
  dbPath = DEFAULT_DB_PATH,
  remoteReplay = null,
  backfill = backfillLiquidity,
  storeEnabled = true,
  storeDir = DEFAULT_STORE_DIR,
  storeS = DEFAULT_STORE_S,
  saveHistory = saveLiquidityHistory,
  saveHistoryInBackground = saveHistory === saveLiquidityHistory ? saveLiquidityHistoryAsync : saveHistory,
  loadHistory = loadLiquidityHistory,
  loadHistoryAsync = loadHistory === loadLiquidityHistory ? loadLiquidityHistoryAsync : null,
  restoreSliceColumns = DEFAULT_RESTORE_SLICE_COLUMNS,
  dropHistory = dropLiquidityHistory,
  saveWallHistory = saveHistory === saveLiquidityHistory ? saveWallHistoryFile : null,
  saveWallHistoryInBackground = saveWallHistory === saveWallHistoryFile ? saveWallHistoryAsync : saveWallHistory,
  loadWallHistory = loadHistory === loadLiquidityHistory ? loadWallHistoryFile : null,
  wallHistoryMaxBytes = DEFAULT_WALL_HISTORY_MAX_BYTES,
  tradeHistoryMaxBytes = DEFAULT_TRADE_BYTES,
  wallTradeHistoryMaxBytes = DEFAULT_WALL_TRADE_BYTES,
  fillHistoryS = 0,
  histories = true,
  aggressiveEnabled = true,
  aggressive = {},
  laneWindowPct = DEFAULT_WINDOW_PCT,
  l2 = true,
  laneWalls = true,
  laneWallsClient = null,
  pyramid = null,
  now = () => Date.now(),
  log = defaultLiquidityLog,
} = {}) {
  if (typeof l2 !== "boolean") {
    throw new Error("liquidity-publisher: l2 must be a boolean");
  }
  if (typeof laneWalls !== "boolean") {
    throw new Error("liquidity-publisher: laneWalls must be a boolean");
  }
  if (typeof histories !== "boolean") {
    throw new Error("liquidity-publisher: histories must be a boolean");
  }
  if (!memory || typeof memory.getEngine !== "function") {
    throw new Error("liquidity-publisher: memory.getEngine is required");
  }
  if (typeof buildFrame !== "function") {
    throw new Error("liquidity-publisher: buildFrame must be a function");
  }
  if (remoteReplay !== null && (!remoteReplay || typeof remoteReplay !== "object" ||
      typeof remoteReplay.baseUrl !== "string" || remoteReplay.baseUrl.length === 0 ||
      typeof remoteReplay.token !== "string" || remoteReplay.token.length === 0)) {
    throw new Error("liquidity-publisher: remoteReplay requires baseUrl and token");
  }
  if (!Number.isSafeInteger(columnMs) || columnMs <= 0) {
    throw new Error("liquidity-publisher: columnMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(storeMaxBytes) || storeMaxBytes <= 0) {
    throw new Error("liquidity-publisher: storeMaxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(restoreSliceColumns) || restoreSliceColumns <= 0) {
    throw new Error("liquidity-publisher: restoreSliceColumns must be a positive safe integer");
  }
  for (const [name, value] of [["wallHistoryMaxBytes", wallHistoryMaxBytes], ["tradeHistoryMaxBytes", tradeHistoryMaxBytes], ["wallTradeHistoryMaxBytes", wallTradeHistoryMaxBytes]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`liquidity-publisher: ${name} must be a positive safe integer`);
  }
  if (!Number.isFinite(fillHistoryS) || fillHistoryS < 0) {
    throw new Error("liquidity-publisher: fillHistoryS must be a non-negative number");
  }
  for (const [name, value] of [["saveWallHistory", saveWallHistory], ["saveWallHistoryInBackground", saveWallHistoryInBackground], ["loadWallHistory", loadWallHistory]]) {
    if (value !== null && typeof value !== "function") throw new Error(`liquidity-publisher: ${name} must be a function or null`);
  }
  if (loadHistoryAsync !== null && typeof loadHistoryAsync !== "function") {
    throw new Error("liquidity-publisher: loadHistoryAsync must be a function or null");
  }
  if (!Number.isSafeInteger(deepColumnMs) || deepColumnMs <= 0 || deepColumnMs % columnMs !== 0) {
    throw new Error("liquidity-publisher: deepColumnMs must be a positive multiple of columnMs");
  }
  const maxColumns = Math.max(1, Math.round((historyS * 1_000) / columnMs));
  if (!Number.isFinite(deepChunkS) || deepChunkS <= 0) {
    throw new Error("liquidity-publisher: deepChunkS must be a positive number");
  }
  const deepChunkMs = Math.round(deepChunkS * 1_000);
  const deepEnabled = Number.isFinite(deepS) && deepS > historyS;
  const maxDeepColumns = deepEnabled ? Math.max(1, Math.round((deepS * 1_000) / deepColumnMs)) : 0;
  if (!Number.isSafeInteger(coarseColumnMs) || coarseColumnMs <= deepColumnMs || coarseColumnMs % deepColumnMs !== 0) {
    throw new Error("liquidity-publisher: coarseColumnMs must be a multiple of deepColumnMs, above it");
  }
  if (!Number.isSafeInteger(coarseRows) || coarseRows <= 0) {
    throw new Error("liquidity-publisher: coarseRows must be a positive safe integer");
  }
  if (!Number.isSafeInteger(coarseSampleMs) || coarseSampleMs <= 0 || coarseColumnMs % coarseSampleMs !== 0) {
    throw new Error("liquidity-publisher: coarseSampleMs must be a positive divisor of coarseColumnMs");
  }
  if (!Number.isFinite(coarseChunkS) || coarseChunkS <= 0) {
    throw new Error("liquidity-publisher: coarseChunkS must be a positive number");
  }
  const coarseChunkMs = Math.round(coarseChunkS * 1_000);
  const coarseEnabled = deepEnabled && Number.isFinite(coarseS) && coarseS > deepS;
  const maxCoarseColumns = coarseEnabled ? Math.max(1, Math.round((coarseS * 1_000) / coarseColumnMs)) : 0;
  const coarseMaxAgeMs = Math.round(coarseS * 1_000);
  const storeMs = Math.max(1_000, Math.round(storeS * 1_000));
  const storeMaxAgeMs = Math.round(storeMaxAgeS * 1_000);
  const fillMs = histories ? Math.round(Math.min(fillHistoryS, storeMaxAgeS) * 1_000) : 0;
  const backfillMaxMs = Math.round(backfillMaxS * 1_000);
  const announceMs = Math.max(1_000, Math.round(backfillAnnounceS * 1_000));
  const floorMs = Number.isFinite(historyFloorMs) && historyFloorMs > 0 ? historyFloorMs : 0;
  if (pyramid !== null && pyramid !== "auto" && (typeof pyramid !== "object" || typeof pyramid.pinned !== "function" || typeof pyramid.deepColumns !== "function")) {
    throw new Error("liquidity-publisher: pyramid must be null, \"auto\", or have pinned() and deepColumns()");
  }
  const pyramidSource = pyramid === "auto" ? defaultPyramidWarmup(remoteReplay, now, log) : pyramid;
  const scheduler = backfillEnabled && typeof backfill === "function"
    ? createBackfillScheduler({ backfill, maxWorkers: backfillWorkers, timeoutMs: Math.max(1_000, Math.round(backfillTimeoutS * 1_000)) })
    : null;

  const ctx = {
    memory, buildFrame, rowBp, windowBp, referenceBp, columnMs, historyS, deepS, deepChunkMs, deepColumnMs, coarseColumnMs,
    coarseRows, coarseSampleMs, coarseChunkMs, coarseMaxAgeMs, levelMinUsd, wallMultiplier, wallGapRows, wallSettleMs, sizeDigits,
    backfillMaxMs, announceMs, storeEnabled, storeDir, storeMs, storeMaxAgeS, storeMaxAgeMs, storeMaxBytes, floorMs, dbPath, remoteReplay,
    saveHistory, saveHistoryInBackground, loadHistory, loadHistoryAsync, restoreSliceColumns, dropHistory, aggressive,
    saveWallHistory, saveWallHistoryInBackground, loadWallHistory, wallHistoryMaxBytes, tradeHistoryMaxBytes, wallTradeHistoryMaxBytes, fillMs, histories,
    aggressiveEnabled, maxColumns, deepEnabled, maxDeepColumns, coarseEnabled, maxCoarseColumns, scheduler, now, log,
    laneWindowPct,
    pyramid: pyramidSource,
    l2Enabled: l2,
    laneWalls: laneWallsClient ?? createLaneWallsClient({ enabled: l2 && laneWalls, log }),
    slowStepMs: SLOW_STEP_MS,
    pairKey,
    states: new Map(),
    stopped: false,
    activeKey: null,
    lastKey: null,
    deepAdmission: null,
    hasClients: null,
  };
  const { states } = ctx;
  if (storeEnabled) {
    const swept = sweepStoreTemporaries({ dir: storeDir, now: now() });
    if (swept.length > 0) log(`liquidity-publisher: removed ${swept.length} temporary store file${swept.length === 1 ? "" : "s"} left by an earlier run in ${storeDir}`);
  }
  const lane = createLaneOps(ctx);
  const store = createLaneStore(ctx, lane);
  const rebuild = createLaneRebuild(ctx, lane, store);
  const l2Ops = createLaneL2(ctx);
  const frames = createLaneFrames(ctx, lane, l2Ops);
  let timer = null;
  const tickStats = { count: 0, sumMs: 0, maxMs: 0, lateCount: 0, lateSumMs: 0, lateMaxMs: 0, announces: 0, announceFrames: 0 };

  function stateFor(marketKind, symbol, engine) {
    const key = pairKey(marketKind, symbol);
    ctx.lastKey = key;
    const existing = states.get(key);
    if (existing) return existing;
    const state = lane.createLaneState(key, marketKind, symbol, engine);
    states.set(key, state);
    store.restoreHistories(state, now());
    if (storeEnabled && loadHistoryAsync !== null) {
      state.restoring = true;
      const finish = (restored) => {
        if (states.get(key) !== state) return;
        state.restoring = false;
        state.savedAt = now();
        state.liveFrom = state.savedAt;
        if (scheduler && !ctx.stopped) rebuild.startBackfill(state, engine, restored ? restored.gapFrom : null);
      };
      store.restoreStateAsync(state, now()).then(finish, (error) => {
        log(`liquidity-publisher: stored history for ${state.key} would not load (${error?.message ?? error}), rebuilding from the recording`);
        finish(null);
      });
      return state;
    }
    const restored = store.restoreState(state, now());
    state.savedAt = now();
    state.liveFrom = state.savedAt;
    if (scheduler) rebuild.startBackfill(state, engine, restored ? restored.gapFrom : null);
    return state;
  }

  function tick(marketKind, symbol, at = now()) {
    const startedAt = performance.now();
    try {
      return tickImpl(marketKind, symbol, at);
    } finally {
      const ms = performance.now() - startedAt;
      tickStats.count += 1;
      tickStats.sumMs += ms;
      if (ms > tickStats.maxMs) tickStats.maxMs = ms;
    }
  }

  function tickImpl(marketKind, symbol, at) {
    if (ctx.stopped) return null;
    if (pyramidSource !== null && !states.has(pairKey(marketKind, symbol))) {
      pyramidSource.pinned(marketKind, symbol);
      if (typeof pyramidSource.pinReady === "function" && !pyramidSource.pinReady(marketKind, symbol)) return null;
    }
    const engine = memory.getEngine(marketKind, symbol);
    if (!engine || !engine.seeded) return null;
    const state = stateFor(marketKind, symbol, engine);
    if (state.restoring || engine.live === false) {
      if (typeof engine.drainPrints === "function") for (const print of engine.drainPrints()) lane.pushPrint(state, print);
      lane.pruneFlows(state, Math.floor(at / columnMs) * columnMs);
      if (state.restoring) return null;
    }
    if (state.savedAt > 0 && at - state.savedAt >= storeMs) {
      store.saveStateInBackground(state, at);
      rebuild.startDeepRepair(state, engine, at);
    }
    if (engine.live === false) {
      if (state.holdingSince === null) {
        state.holdingSince = at;
        log(`liquidity-publisher: book for ${state.key} is unavailable, holding columns`);
      }
      return null;
    }
    if (state.holdingSince !== null) {
      log(`liquidity-publisher: book for ${state.key} is back after ${Math.round((at - state.holdingSince) / 1_000)}s, columns resume`);
      state.holdingSince = null;
    }
    return frames.tickColumn(state, engine, marketKind, symbol, at);
  }

  function snapshotFrames(marketKind, symbol) {
    return frames.snapshotFrames(marketKind, symbol);
  }

  function reset() {
    for (const state of states.values()) store.saveStateInBackground(state, now());
  }

  function takeL2(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state) return null;
    frames.flushL2(state);
    if (!state.l2Output) return null;
    const out = state.l2Output;
    state.l2Output = null;
    return out;
  }

  function l2Snapshot(marketKind, symbol) {
    if (!l2) return null;
    const state = states.get(pairKey(marketKind, symbol));
    const engine = memory.getEngine(marketKind, symbol);
    if (!state || !engine || !engine.seeded) return null;
    frames.flushL2(state);
    return l2Ops.snapshot(state, engine, now());
  }

  function start({ activePair, publish, publishSnapshot = null, publishL2 = null, pairs = null, deepAdmission: admission = null, hasClients = null }) {
    if (timer || ctx.stopped) return;
    if (typeof activePair !== "function" || typeof publish !== "function") {
      throw new Error("liquidity-publisher: start needs activePair() and publish()");
    }
    if (publishSnapshot !== null && typeof publishSnapshot !== "function") {
      throw new Error("liquidity-publisher: start's publishSnapshot must be a function when given");
    }
    if (hasClients !== null && typeof hasClients !== "function") {
      throw new Error("liquidity-publisher: start's hasClients must be a function when given");
    }
    if (publishL2 !== null && typeof publishL2 !== "function") {
      throw new Error("liquidity-publisher: start's publishL2 must be a function when given");
    }
    if (admission !== null && typeof admission !== "function") {
      throw new Error("liquidity-publisher: start's deepAdmission must be a function when given");
    }
    ctx.deepAdmission = admission;
    ctx.hasClients = hasClients;
    const schedule = () => {
      const at = now();
      const delay = columnMs - (at % columnMs) + 5;
      const due = at + delay;
      timer = setTimeout(() => {
        timer = null;
        if (ctx.stopped) return;
        const late = Math.max(0, now() - due);
        tickStats.lateCount += 1;
        tickStats.lateSumMs += late;
        if (late > tickStats.lateMaxMs) tickStats.lateMaxMs = late;
        try {
          const pair = activePair();
          const previousKey = ctx.activeKey;
          ctx.activeKey = pair && pair.marketKind && pair.symbol ? pairKey(pair.marketKind, pair.symbol) : null;
          if (previousKey !== null && previousKey !== ctx.activeKey) ctx.laneWalls.forget(previousKey);
          if (previousKey !== ctx.activeKey && ctx.activeKey !== null) scheduler?.prioritise(ctx.activeKey);
          const todo = new Map();
          if (ctx.activeKey) todo.set(ctx.activeKey, pair);
          const tracked = typeof pairs === "function" ? pairs() : null;
          if (Array.isArray(tracked)) {
            for (const p of tracked) if (p && p.marketKind && p.symbol) todo.set(pairKey(p.marketKind, p.symbol), p);
          }
          for (const [key, p] of todo) {
            try {
              const out = tick(p.marketKind, p.symbol);
              if (out && key === ctx.activeKey) {
                const frames = Array.isArray(out) ? out : [out];
                const announced = states.get(key)?.snapshotTick === true;
                if (announced) {
                  tickStats.announces += 1;
                  tickStats.announceFrames += frames.length;
                }
                if (announced && publishSnapshot !== null) publishSnapshot(frames);
                else for (const frame of frames) publish(frame);
              }
            } catch (error) {
              log(`liquidity-publisher: tick failed for ${key}: ${error?.message ?? error}`);
            }
            if (key === ctx.activeKey && publishL2 !== null) {
              setImmediate(() => {
                if (ctx.stopped) return;
                try {
                  const l2Out = takeL2(p.marketKind, p.symbol);
                  if (l2Out) publishL2(l2Out, p);
                } catch (error) {
                  log(`liquidity-publisher: L2 publish failed for ${key}: ${error?.message ?? error}`);
                }
              });
            }
          }
        } catch (error) {
          log(`liquidity-publisher: tick failed: ${error?.message ?? error}`);
        }
        schedule();
      }, delay);
      timer.unref?.();
    };
    schedule();
  }

  function stop() {
    for (const state of states.values()) store.saveState(state, now());
    ctx.stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    states.clear();
    ctx.laneWalls.stop();
    scheduler?.dispose();
    if (pyramid === "auto") pyramidSource?.close?.();
  }

  function lanes(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state) return null;
    return Object.freeze({
      windowPct: state.laneWindowPct,
      lanes: Object.freeze(state.lanes.map((entry) => Object.freeze({
        ...lane.laneGeometry(entry),
        reachPct: entry.reachPct,
        sideBufferBytes: entry.history.sideBufferBytes + (entry.deep ? entry.deep.sideBufferBytes : 0),
        recent: entry.history.toArray(),
        deep: entry.deep ? entry.deep.toArray() : [],
      }))),
    });
  }

  function wallHistoryOf(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state || !histories) return null;
    store.sweepWallHistory(state, now());
    return state.wallHistory;
  }

  function eventHistoryOf(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state || !histories) return null;
    store.sweepEventHistory(state, now());
    return state.eventHistory;
  }

  function deepColumnsAfter(marketKind, symbol, afterTs, limit) {
    const state = states.get(pairKey(marketKind, symbol));
    if (!state || state.restoring || !state.deep) return null;
    const latest = state.deep.latest();
    if (latest === null || (afterTs !== null && latest.ts <= afterTs)) return [];
    const columns = state.deep.toArray();
    let lo = 0;
    let hi = columns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (afterTs !== null && columns[mid].ts <= afterTs) lo = mid + 1;
      else hi = mid;
    }
    return columns.slice(lo, Number.isSafeInteger(limit) && limit > 0 ? lo + limit : undefined);
  }

  async function hostColumns(marketKind, symbol, fromTs, toTs) {
    if (pyramidSource === null) return { columns: [], reason: "NO_HOST" };
    const geometry = geometryFor(marketKind, symbol);
    if (geometry === null) return { columns: [], reason: "NO_GEOMETRY" };
    return pyramidSource.deepColumns({ marketKind, symbol, fromTs, toTs, geometry: { rowWidth: geometry.rowWidth, tickSize: geometry.tickSize, clusterTicks: geometry.clusterTicks } });
  }

  function geometryFor(marketKind, symbol) {
    const state = states.get(pairKey(marketKind, symbol));
    const engine = typeof memory.getEngine === "function" ? memory.getEngine(marketKind, symbol) : null;
    if (!state || !engine || !(engine.tickSize > 0) || !Number.isSafeInteger(engine.clusterTicks) || engine.clusterTicks <= 0) return null;
    return Object.freeze({ rowWidth: state.rowWidth, rowClusters: state.rowClusters, tickSize: engine.tickSize, clusterTicks: engine.clusterTicks });
  }

  return Object.freeze({
    tick,
    snapshotFrames,
    takeL2,
    l2Snapshot,
    geometryFor,
    deepColumnsAfter,
    hostColumns,
    wallHistoryOf,
    eventHistoryOf,
    lanes,
    reset,
    start,
    stop,
    get columnMs() {
      return columnMs;
    },
    get maxColumns() {
      return maxColumns;
    },
    get deepColumnMs() {
      return deepEnabled ? deepColumnMs : 0;
    },
    get maxDeepColumns() {
      return maxDeepColumns;
    },
    get coarseColumnMs() {
      return coarseEnabled ? coarseColumnMs : 0;
    },
    get coarseRows() {
      return coarseEnabled ? coarseRows : 0;
    },
    get maxCoarseColumns() {
      return maxCoarseColumns;
    },
    get horizonMs() {
      return Math.round((deepEnabled ? deepS : historyS) * 1_000);
    },
    get coarseHorizonMs() {
      return coarseEnabled ? Math.round(coarseS * 1_000) : 0;
    },
    stats() {
      return Object.freeze({
        pairs: states.size,
        retentionByPair: Object.fromEntries([...states.values()].map((state) => [state.key, {
          recentColumns: state.history.length,
          deepColumns: state.deep?.length ?? 0,
          coarseColumns: state.coarse?.length ?? 0,
          sideBufferBytes: state.history.sideBufferBytes + (state.deep?.sideBufferBytes ?? 0) + (state.coarse?.sideBufferBytes ?? 0),
          pendingFlowPrints: state.flow?.pending ?? 0,
          pendingEnginePrints: memory.getEngine(state.marketKind, state.symbol)?.stats?.pendingPrints ?? null,
          holding: state.holdingSince !== null,
          restoring: state.restoring,
          historyWalls: state.wallHistory.size,
          historyTrades: state.eventHistory.tradeBuckets,
          historyWallTrades: state.eventHistory.wallTradeBuckets,
        }])),
        tickCount: tickStats.count,
        tickMsAvg: tickStats.count > 0 ? tickStats.sumMs / tickStats.count : 0,
        tickMsMax: tickStats.maxMs,
        tickLateMsAvg: tickStats.lateCount > 0 ? tickStats.lateSumMs / tickStats.lateCount : 0,
        tickLateMsMax: tickStats.lateMaxMs,
        announces: tickStats.announces,
        announceFrames: tickStats.announceFrames,
        flowLate: [...states.values()].reduce((sum, state) => sum + (state.flow ? state.flow.late : 0), 0),
        flowDropped: [...states.values()].reduce((sum, state) => sum + (state.flow ? state.flow.dropped : 0), 0),
        flowClipped: [...states.values()].reduce((sum, state) => sum + (state.flow ? state.flow.clipped : 0), 0),
        backfill: scheduler ? scheduler.stats() : null,
        laneWalls: ctx.laneWalls.stats(),
      });
    },
    readiness() {
      const result = {};
      for (const [key, state] of states) {
        result[key] = Object.freeze({
          recent: Object.freeze({ ...state.recentReadiness }),
          deep: Object.freeze({ ...state.deepReadiness }),
          coarse: Object.freeze({ ...state.coarseReadiness }),
          fill: Object.freeze({ ...state.fillReadiness }),
        });
      }
      return Object.freeze(result);
    },
    get activeState() {
      const state = ctx.lastKey === null ? null : states.get(ctx.lastKey) ?? null;
      return state
        ? Object.freeze({
          key: state.key, rowClusters: state.rowClusters, windowRows: state.windowRows, rowWidth: state.rowWidth,
          length: state.history.length, seq: state.history.seq, deepLength: state.deep ? state.deep.length : 0, deepSeq: state.deep ? state.deep.seq : 0,
          coarseLength: state.coarse ? state.coarse.length : 0, coarseSeq: state.coarse ? state.coarse.seq : 0,
        })
        : null;
    },
    activeStateForTests: () => (ctx.lastKey === null ? null : states.get(ctx.lastKey) ?? null),
  });
}

module.exports = {
  createLiquidityPublisher,
  liquidityOptionsFromEnv,
  liquidityLogLevel,
  rowClustersFor,
  windowRowsFor,
  DEFAULT_ROW_BP,
  DEFAULT_WINDOW_BP,
  DEFAULT_REFERENCE_BP,
  DEFAULT_COLUMN_MS,
  DEFAULT_HISTORY_S,
  DEFAULT_DEEP_S,
  DEFAULT_DEEP_COLUMN_MS,
  DEFAULT_COARSE_S,
  DEFAULT_COARSE_COLUMN_MS,
  DEFAULT_COARSE_ROWS,
  DEFAULT_FILL_S,
  DEFAULT_STORE_S,
  DEFAULT_STORE_MAX_BYTES,
  DEFAULT_LEVEL_MIN_USD,
  MAX_WINDOW_ROWS,
};
