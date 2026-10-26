"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { openPyramidStore } = require("./pyramid-store");
const { createPyramidBuilder, resolveGeometry, needsRepin, probePrice, DEFAULT_RETENTION_MS, DEFAULT_LAG_MS, DEFAULT_SETTLE_MS, DEFAULT_WARMUP_MS, DEFAULT_MAX_RUN_WINDOWS } = require("./pyramid-builder");
const { WINDOW_MS } = require("./pyramid-levels");
const { runBackfillInProcess } = require("../liquidity-backfill");
const { pairKeyOf } = require("./pyramid-reader");
const { SNAPSHOT_DEPTH_BY_MARKET_KIND } = require("../live-binding");
const { DEFAULT_ROW_BP, DEFAULT_WINDOW_BP, DEFAULT_REFERENCE_BP, DEFAULT_LEVEL_MIN_USD, liquidityOptionsFromEnv } = require("../../passive_liquidity/liquidity-publisher");
const { DEFAULT_MULTIPLIER, DEFAULT_GAP_ROWS, DEFAULT_SETTLE_MS: DEFAULT_WALL_SETTLE_MS } = require("../../passive_liquidity/large-level-tracker");
const { DEFAULT_SIZE_DIGITS } = require("../../passive_liquidity/liquidity-sampler");
const { dxfeedLiquidityOptionsFromEnv, notionalMultiplierFor, DEFAULT_FUTURE_ROW_TICKS, DEFAULT_EQUITY_ROW_TICKS } = require("../../passive_liquidity/dxfeed-liquidity-binding");
const { orderSourceFor } = require("../../../providers/dxfeed/dxfeed-instrument-catalog");
const { DEFAULT_ARRIVAL_MARGIN_MS } = require("../dxfeed-replay-source");

const DEFAULT_CYCLE_MS = 60_000;
const DEFAULT_WINDOWS_PER_CYCLE = 12;
const DEFAULT_REPIN_CHECK_MS = 6 * 3_600_000;
const TRACKER_MAX_LEVELS = 4_000;
const BINANCE_CAPTURE_MARGIN_MS = 5_000;
const STATUS_FILE = "status.json";

function positiveNumber(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function pyramidOptionsFromEnv(env = process.env) {
  const days = positiveNumber(env.TT_PYRAMID_RETENTION_DAYS);
  const cycleMs = positiveNumber(env.TT_PYRAMID_CYCLE_MS);
  const perCycle = positiveNumber(env.TT_PYRAMID_WINDOWS_PER_CYCLE);
  const warmupMs = positiveNumber(env.TT_PYRAMID_WARMUP_MS);
  const walls = liquidityOptionsFromEnv(env);
  return {
    warmupMs: warmupMs === undefined ? DEFAULT_WARMUP_MS : Math.round(warmupMs),
    histories: env.TT_PYRAMID_HISTORIES !== "0",
    levelMinUsd: walls.levelMinUsd ?? DEFAULT_LEVEL_MIN_USD,
    wallMultiplier: walls.wallMultiplier ?? DEFAULT_MULTIPLIER,
    wallGapRows: walls.wallGapRows ?? DEFAULT_GAP_ROWS,
    wallSettleMs: walls.wallSettleMs ?? DEFAULT_WALL_SETTLE_MS,
    rowBp: positiveNumber(env.L2_HEATMAP_ROW_BP) ?? DEFAULT_ROW_BP,
    windowBp: positiveNumber(env.L2_HEATMAP_WINDOW_BP) ?? DEFAULT_WINDOW_BP,
    referenceBp: DEFAULT_REFERENCE_BP,
    retentionMs: days === undefined ? DEFAULT_RETENTION_MS : Math.round(days * 86_400_000),
    cycleMs: cycleMs === undefined ? DEFAULT_CYCLE_MS : Math.round(cycleMs),
    windowsPerCycle: perCycle === undefined ? DEFAULT_WINDOWS_PER_CYCLE : Math.round(perCycle),
    pairFilter: typeof env.TT_PYRAMID_PAIRS === "string" && env.TT_PYRAMID_PAIRS.trim() !== "" ? new Set(env.TT_PYRAMID_PAIRS.split(",").map((key) => key.trim()).filter(Boolean)) : null,
  };
}

function trackerOptionsFor({ pair, price, options, warmupMs, maxRunWindows = DEFAULT_MAX_RUN_WINDOWS }) {
  if (options.histories === false) return null;
  const notional = pair.provider === "dxfeed" ? notionalMultiplierFor(pair.marketKind, pair.symbol) : 1;
  const spanMs = maxRunWindows * WINDOW_MS + warmupMs;
  return {
    minSize: options.levelMinUsd / (price * notional),
    multiplier: options.wallMultiplier,
    gapRows: options.wallGapRows,
    settleMs: options.wallSettleMs,
    keepEndedMs: spanMs,
    deepKeepEndedMs: spanMs,
    maxLevels: TRACKER_MAX_LEVELS,
  };
}

function pyramidPairs({ catalog, env = process.env, pairFilter = null }) {
  const dxfeed = dxfeedLiquidityOptionsFromEnv(env);
  const pairs = [];
  for (const entry of catalog.binance ?? []) {
    pairs.push(Object.freeze({
      provider: "binance",
      marketKind: entry.marketKind,
      symbol: entry.symbol.replace("-", ""),
      tickSize: null,
      clusterTicks: entry.l2?.clusterTicks ?? null,
      fixedRows: null,
      snapshotDepth: SNAPSHOT_DEPTH_BY_MARKET_KIND[entry.marketKind] ?? Infinity,
    }));
  }
  for (const entry of catalog.dxfeed ?? []) {
    pairs.push(Object.freeze({
      provider: "dxfeed",
      marketKind: entry.assetClass,
      symbol: entry.symbol,
      tickSize: entry.tickSize,
      clusterTicks: 1,
      fixedRows: entry.assetClass === "FUTURE" ? dxfeed.futureRowTicks ?? DEFAULT_FUTURE_ROW_TICKS : dxfeed.equityRowTicks ?? DEFAULT_EQUITY_ROW_TICKS,
      snapshotDepth: Infinity,
    }));
  }
  return pairFilter === null ? pairs : pairs.filter((pair) => pairFilter.has(pairKeyOf(pair.provider, pair.marketKind, pair.symbol)));
}

function createCaptureClock({ dbPath, provider, Database = require("better-sqlite3") }) {
  let statement = null;
  let db = null;
  function latest(pair) {
    try {
      if (statement === null) {
        db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2_000 });
        statement = provider === "dxfeed"
          ? db.prepare("SELECT received_at AS ts FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? ORDER BY event_time DESC LIMIT 1")
          : db.prepare("SELECT ts FROM l2_depth_events WHERE symbol = ? AND market_kind = ? ORDER BY ts DESC LIMIT 1");
      }
      return (provider === "dxfeed"
        ? statement.get(pair.symbol, pair.marketKind, orderSourceFor(pair.marketKind, pair.symbol))
        : statement.get(pair.symbol, pair.marketKind))?.ts ?? null;
    } catch {
      try { db?.close(); } catch { db = null; }
      db = null;
      statement = null;
      return null;
    }
  }
  function close() {
    try { db?.close(); } catch { return; }
  }
  return Object.freeze({ latest, close });
}

function writeStatus(dir, status) {
  const file = path.join(dir, STATUS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
  fs.renameSync(temporary, file);
}

function createPyramidService({
  dir,
  dbPaths,
  catalog,
  env = process.env,
  options = pyramidOptionsFromEnv(env),
  tickSizeResolver,
  now = () => Date.now(),
  openStore = openPyramidStore,
  captureClockFor = createCaptureClock,
  runBackfill = runBackfillInProcess,
  log = () => {},
  lagMs = DEFAULT_LAG_MS,
  settleMs = DEFAULT_SETTLE_MS,
}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("pyramid-service: dir is required");
  if (!dbPaths || typeof dbPaths.binance !== "string" || typeof dbPaths.dxfeed !== "string") throw new Error("pyramid-service: dbPaths.binance and dbPaths.dxfeed are required");
  const pairs = pyramidPairs({ catalog, env, pairFilter: options.pairFilter });
  const clocks = { binance: captureClockFor({ dbPath: dbPaths.binance, provider: "binance" }), dxfeed: captureClockFor({ dbPath: dbPaths.dxfeed, provider: "dxfeed" }) };
  const prepared = new Map();
  const status = { startedAt: now(), updatedAt: null, pairs: {} };
  let stopping = false;
  let wake = null;

  function pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function tickSizeOf(pair) {
    if (pair.tickSize > 0) return pair.tickSize;
    const resolved = await tickSizeResolver?.getBinanceTickSize(pair.marketKind, pair.symbol);
    return Number.isFinite(resolved) && resolved > 0 ? resolved : null;
  }

  async function prepare(pair) {
    const key = pairKeyOf(pair.provider, pair.marketKind, pair.symbol);
    const existing = prepared.get(key);
    const at = now();
    if (existing && at - existing.preparedAt < DEFAULT_REPIN_CHECK_MS) return existing;
    if (!Number.isSafeInteger(pair.clusterTicks) || pair.clusterTicks <= 0) {
      status.pairs[key] = { state: "SKIPPED", reason: "NO_CLUSTER_TICKS" };
      return null;
    }
    const tickSize = await tickSizeOf(pair);
    if (tickSize === null) {
      status.pairs[key] = { state: "WAITING", reason: "NO_TICK_SIZE" };
      return null;
    }
    const dbPath = dbPaths[pair.provider];
    const recorded = clocks[pair.provider].latest(pair);
    const probeAt = Number.isFinite(recorded) ? Math.min(at, recorded) : at;
    const price = await probePrice({ pair, at: probeAt, tickSize, clusterTicks: pair.clusterTicks, sourceOptions: { dbPath } });
    if (price === null) {
      status.pairs[key] = { state: "WAITING", reason: "NO_RECENT_BOOK" };
      if (existing) existing.preparedAt = at;
      return existing ?? null;
    }
    const fresh = resolveGeometry({
      price, tickSize, clusterTicks: pair.clusterTicks, fixedRows: pair.fixedRows,
      rowBp: options.rowBp, windowBp: options.windowBp, referenceBp: options.referenceBp,
      sizeDigits: DEFAULT_SIZE_DIGITS, snapshotDepth: pair.snapshotDepth,
      replayWarmupMs: options.warmupMs ?? DEFAULT_WARMUP_MS,
    });
    const store = existing?.store ?? openStore({ dir, pairKey: key });
    if (needsRepin(store.geometry(), fresh, options.rowBp)) {
      store.pin(fresh);
      log(`heatmap-pyramid: pinned ${key} at ${price}: rows of ${fresh.rowWidth} (${fresh.rowClusters} clusters), ${fresh.windowRows} rows each side`);
    }
    const geometry = store.geometry();
    const warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS;
    const builder = createPyramidBuilder({
      store, pair, geometry, sourceOptions: { dbPath }, runBackfill,
      trackerOptions: trackerOptionsFor({ pair, price, options, warmupMs }),
      captureLatestTs: () => clocks[pair.provider].latest(pair),
      captureMarginMs: pair.provider === "dxfeed" ? DEFAULT_ARRIVAL_MARGIN_MS : BINANCE_CAPTURE_MARGIN_MS,
      retentionMs: options.retentionMs, warmupMs, lagMs, settleMs, now,
    });
    const entry = { key, store, builder, geometry, preparedAt: at };
    prepared.set(key, entry);
    return entry;
  }

  async function runPair(pair) {
    const key = pairKeyOf(pair.provider, pair.marketKind, pair.symbol);
    try {
      const entry = await prepare(pair);
      if (entry === null) return 0;
      const startedAt = Date.now();
      const cycle = await entry.builder.runCycle({ maxWindows: options.windowsPerCycle, shouldContinue: () => !stopping });
      const spent = Date.now() - startedAt;
      const counts = {};
      for (const outcome of cycle.built) counts[outcome.state] = (counts[outcome.state] ?? 0) + 1;
      const failedWindows = entry.store.stats().states.FAILED ?? 0;
      status.pairs[key] = {
        state: failedWindows > 0 ? "DEGRADED" : "RUNNING",
        rowWidth: entry.geometry.rowWidth,
        due: cycle.due,
        built: cycle.built.length,
        states: counts,
        failedWindows,
        pruned: cycle.pruned,
        msPerWindow: cycle.built.length > 0 ? Math.round(spent / cycle.built.length) : null,
        span: entry.store.span(),
        at: cycle.at,
      };
      if (cycle.built.length > 0) log(`heatmap-pyramid: ${key} built ${cycle.built.length} windows (${JSON.stringify(counts)}), ${cycle.due - cycle.built.length} still due, ${Math.round(spent / cycle.built.length)} ms each`);
      return cycle.built.length;
    } catch (error) {
      status.pairs[key] = { state: "ERROR", reason: String(error?.message ?? error).slice(0, 300) };
      log(`heatmap-pyramid: ${key} failed: ${error?.message ?? error}`);
      return 0;
    }
  }

  async function runOnce() {
    let built = 0;
    for (const pair of pairs) {
      if (stopping) break;
      built += await runPair(pair);
    }
    status.updatedAt = now();
    try {
      writeStatus(dir, status);
    } catch (error) {
      log(`heatmap-pyramid: could not write the status file: ${error?.message ?? error}`);
    }
    return built;
  }

  async function run() {
    fs.mkdirSync(dir, { recursive: true });
    while (!stopping) {
      const built = await runOnce();
      if (built === 0 && !stopping) await pause(options.cycleMs);
    }
  }

  function stop() {
    stopping = true;
    wake?.();
  }

  function close() {
    for (const entry of prepared.values()) entry.store.close();
    prepared.clear();
    clocks.binance.close();
    clocks.dxfeed.close();
  }

  return Object.freeze({ pairs, runOnce, run, stop, close, status: () => status });
}

module.exports = { createPyramidService, pyramidPairs, pyramidOptionsFromEnv, trackerOptionsFor, createCaptureClock, STATUS_FILE, DEFAULT_CYCLE_MS, DEFAULT_WINDOWS_PER_CYCLE, TRACKER_MAX_LEVELS };
