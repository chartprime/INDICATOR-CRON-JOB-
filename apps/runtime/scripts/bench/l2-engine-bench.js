"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const ledgerModule = require("../../src/indicators/l2-memory/level-ledger");

const ledgerTimings = { observeQuote: [], applyDelta: [], applyTrade: [], seed: [], resync: [] };
const realCreateLedger = ledgerModule.createLevelLedger;
ledgerModule.createLevelLedger = (options) => {
  const ledger = realCreateLedger(options);
  const timed = {};
  for (const name of Object.keys(ledgerTimings)) {
    timed[name] = (...args) => {
      const started = performance.now();
      try {
        return ledger[name](...args);
      } finally {
        ledgerTimings[name].push(performance.now() - started);
      }
    };
  }
  return Object.freeze({ ...ledger, ...timed });
};

const { createMemoryEngine } = require("../../src/indicators/l2-memory/memory-engine");
const { clusterTicksFor, DEFAULT_BAND_BP, DEFAULT_MIN_SLICE_USD } = require("../../src/indicators/l2-memory/live-binding");
const { createReplaySource } = require("../../src/indicators/l2-memory/replay-source");
const { createDxFeedReplaySource } = require("../../src/indicators/l2-memory/dxfeed-replay-source");
const { rowClustersFor, windowRowsFor } = require("../../src/indicators/passive_liquidity/liquidity-geometry");
const { sampleLiquidityColumn, DEFAULT_SIZE_DIGITS } = require("../../src/indicators/passive_liquidity/liquidity-sampler");
const { createColumnFlow } = require("../../src/indicators/passive_liquidity/column-flow");
const { createLargeLevelTracker, DEFAULT_MULTIPLIER, DEFAULT_GAP_ROWS, DEFAULT_SETTLE_MS } = require("../../src/indicators/passive_liquidity/large-level-tracker");
const { createWallService } = require("../../src/indicators/l2-memory/wall-service");
const { createAggressiveOrdersTracker } = require("../../src/indicators/passive_liquidity/aggressive-orders-tracker");
const { encodeAfter } = require("../../src/indicators/passive_liquidity/liquidity-history");
const { tickSizeFor } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { MAX_LIQUIDITY_LEVELS, MAX_AGGRESSIVE_EVENTS } = require("../../src/server/frames");

const RUNTIME_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_DBS = {
  binance: path.join(RUNTIME_ROOT, "data", "live", "market-data.sqlite"),
  dxfeed: path.join(RUNTIME_ROOT, "data", "live", "dxfeed-market-data.sqlite"),
};
const SNAPSHOT_DEPTH = { SPOT: 5000, PERPETUAL: 1000 };
const COLUMN_MS = 1_000;
const PRUNE_EVERY_MS = 30_000;
const ROW_BP = 0.5;
const WINDOW_BP = 600;
const REFERENCE_BP = 50;
const LEVEL_MIN_USD = 500_000;
const HISTORY_KEEP_MS = 1_200_000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    options[name] = inline ?? argv[++index];
  }
  for (const required of ["provider", "symbol", "kind", "from", "to"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (!DEFAULT_DBS[options.provider]) throw new Error("--provider must be binance or dxfeed");
  const fromTs = Date.parse(options.from);
  const toTs = Date.parse(options.to);
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || toTs <= fromTs) throw new Error("--from/--to must be ISO times with from before to");
  const multiplier = options.multiplier === undefined ? 1 : Number(options.multiplier);
  if (!(multiplier > 0)) throw new Error("--multiplier must be positive");
  return { ...options, fromTs, toTs, multiplier, db: options.db ?? DEFAULT_DBS[options.provider] };
}

function percentiles(values) {
  if (values.length === 0) return { count: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  let sum = 0;
  for (const value of sorted) sum += value;
  const round = (value) => Math.round(value * 1_000) / 1_000;
  return { count: sorted.length, totalMs: round(sum), meanMs: round(sum / sorted.length), p50Ms: round(at(0.5)), p90Ms: round(at(0.9)), p99Ms: round(at(0.99)), maxMs: round(sorted[sorted.length - 1]) };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function wireOf(level) {
  const wire = { ...level };
  delete wire.detail;
  return wire;
}

function detailFacts(levels) {
  const details = levels.map((level) => level.detail).filter(Boolean);
  const ended = levels.filter((level) => level.endedBy !== null && level.detail);
  const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    walls: details.length,
    ended: ended.length,
    firstShrinkExact: details.filter((d) => d.firstShrinkExact).length,
    firstShrinkFromColumn: details.filter((d) => d.firstShrinkTs !== null && !d.firstShrinkExact).length,
    reachedAtFirstShrink: details.filter((d) => d.reachedAtFirstShrink === true).length,
    clearedByTrades: details.filter((d) => d.clearedByTrades).length,
    continuity: details.filter((d) => d.continuity !== null).length,
    repeated: details.filter((d) => d.repeats > 1).length,
    repeatsComplete: details.filter((d) => d.repeatsComplete).length,
    withTrades: details.filter((d) => d.traded > 0).length,
    withHidden: details.filter((d) => d.hidden > 0).length,
    withCrossSide: details.filter((d) => d.crossSide > 0).length,
    evidenceGap: details.filter((d) => d.evidenceGap).length,
    medianFillRatioEnded: median(ended.map((level) => level.detail.fillRatio)),
    medianLifeMsEnded: median(ended.map((level) => level.detail.lifeMs)),
    medianEndDistancePct: median(ended.map((level) => level.detail.endDistancePct).filter((v) => v !== null)),
    byVerdict: Object.fromEntries(["filled", "partial", "hit", "pulled", "moved"].map((verdict) => {
      const group = ended.filter((level) => level.endedBy === verdict);
      return [verdict, { count: group.length, medianFillRatio: median(group.map((level) => level.detail.fillRatio)), clearedByTrades: group.filter((level) => level.detail.clearedByTrades).length }];
    })),
  };
}

function withoutClosest(view) {
  const rest = { ...view };
  delete rest.closestDistance;
  return rest;
}

function heapMiB() {
  global.gc?.();
  return Math.round((process.memoryUsage().heapUsed / 1_048_576) * 10) / 10;
}

function buildSource(options) {
  if (options.provider === "binance") {
    return createReplaySource({ dbPath: options.db, symbol: options.symbol, marketKind: options.kind, fromTs: options.fromTs, toTs: options.toTs, bookMode: "sparse" });
  }
  return createDxFeedReplaySource({ dbPath: options.db, symbol: options.symbol, assetClass: options.kind, fromTs: options.fromTs, toTs: options.toTs, bookMode: "sparse" });
}

function buildEngine(options, price) {
  if (options.provider === "dxfeed") {
    const tickSize = tickSizeFor(options.kind, options.symbol);
    if (!(tickSize > 0)) throw new Error(`no tick size for ${options.symbol}`);
    return { engine: createMemoryEngine({ tickSize, fullDepth: true }), fixedRowClusters: 1 };
  }
  const tickSize = Number(options.tick);
  if (!(tickSize > 0)) throw new Error("--tick is required for binance");
  const override = options["cluster-ticks"] === undefined ? null : Number(options["cluster-ticks"]);
  if (override !== null && !(Number.isSafeInteger(override) && override > 0)) throw new Error("--cluster-ticks must be a positive integer");
  const clusterTicks = override ?? clusterTicksFor(price, tickSize, DEFAULT_BAND_BP);
  const engine = createMemoryEngine({
    tickSize,
    clusterTicks,
    snapshotDepth: SNAPSHOT_DEPTH[options.kind] ?? Infinity,
    ledgerOptions: { minSliceSize: DEFAULT_MIN_SLICE_USD / price },
  });
  return { engine, fixedRowClusters: null };
}

function priceOfFrame(frame) {
  const book = frame.book;
  const raw = book?.bestBid ?? book?.bids?.[0]?.[0] ?? book?.bestAsk ?? book?.asks?.[0]?.[0];
  const price = Number(raw);
  return price > 0 ? price : null;
}

function run(options) {
  const source = buildSource(options);
  const frameTimings = { book: [], trade: [], anchor: [] };
  const tickTimings = { snapshot: [], sample: [], flow: [], walls: [], wallsBare: [], aggressive: [], encode: [], total: [] };
  const lockstep = { columns: 0, mismatches: 0, firstMismatchTs: null };
  const digest = crypto.createHash("sha256");
  const columnsDigest = crypto.createHash("sha256");
  const heapStart = heapMiB();
  const wall0 = performance.now();
  let engine = null;
  let state = null;
  let prevColumn = null;
  let columnBytes = 0;
  let columns = 0;
  let nextColumnTs = null;
  let nextPruneTs = null;
  let frames = 0;
  let recordsPeak = 0;
  let eventCursor = 0;
  const eventStats = { total: 0, maxPerColumn: 0, missed: 0, reads: 0, byType: {} };

  function readEvents() {
    const read = engine.events(eventCursor);
    eventCursor = read.nextSeq;
    eventStats.reads += 1;
    eventStats.missed += read.missed;
    eventStats.total += read.events.length;
    if (read.events.length > eventStats.maxPerColumn) eventStats.maxPerColumn = read.events.length;
    for (const event of read.events) eventStats.byType[event.type] = (eventStats.byType[event.type] ?? 0) + 1;
  }

  function initState(price) {
    const built = buildEngine(options, price);
    engine = built.engine;
    return built.fixedRowClusters;
  }

  function stateFor(fixedRowClusters) {
    const snap = engine.snapshot();
    const refKey = snap.bestBidKey ?? snap.bestAskKey ?? null;
    const price = refKey === null ? null : snap.priceFor(refKey);
    const rowClusters = fixedRowClusters ?? rowClustersFor(price, snap.clusterWidth, ROW_BP);
    const rowWidth = snap.clusterWidth * rowClusters;
    const wallOptions = {
      minSize: price !== null ? LEVEL_MIN_USD / (price * options.multiplier) : 1,
      multiplier: DEFAULT_MULTIPLIER,
      gapRows: DEFAULT_GAP_ROWS,
      settleMs: DEFAULT_SETTLE_MS,
      keepEndedMs: HISTORY_KEEP_MS,
      deepKeepEndedMs: HISTORY_KEEP_MS,
      maxLevels: MAX_LIQUIDITY_LEVELS,
    };
    return {
      price,
      rowClusters,
      rowWidth,
      windowRows: windowRowsFor(price, rowWidth, WINDOW_BP),
      referenceRows: windowRowsFor(price, rowWidth, REFERENCE_BP),
      tracker: createWallService({ engine, ...wallOptions }),
      bare: createLargeLevelTracker(wallOptions),
      flow: createColumnFlow({ keyFor: engine.keyFor, rowClusters, columnMs: COLUMN_MS, sizeDigits: DEFAULT_SIZE_DIGITS }),
      aggressive: createAggressiveOrdersTracker({ rowClusters, keepEndedMs: HISTORY_KEEP_MS, maxEvents: MAX_AGGRESSIVE_EVENTS }),
    };
  }

  function tick(ts) {
    const t0 = performance.now();
    const snapshot = engine.liteSnapshot();
    const t1 = performance.now();
    for (const print of engine.drainPrints()) state.flow.push(print);
    const sampled = sampleLiquidityColumn(snapshot, { ts, rowClusters: state.rowClusters, windowRows: state.windowRows, sizeDigits: DEFAULT_SIZE_DIGITS });
    const t2 = performance.now();
    if (!sampled) return;
    const column = state.flow.take(sampled);
    const t3 = performance.now();
    state.tracker.update({ ts, column, snapshot, rowClusters: state.rowClusters, referenceRows: state.referenceRows });
    const t4 = performance.now();
    state.aggressive.update({ ts, column, snapshot, rowClusters: state.rowClusters });
    const t5 = performance.now();
    const wire = JSON.stringify(encodeAfter(prevColumn, column));
    const t6 = performance.now();
    prevColumn = column;
    columns += 1;
    columnBytes += wire.length;
    digest.update(wire);
    columnsDigest.update(wire);
    tickTimings.snapshot.push(t1 - t0);
    tickTimings.sample.push(t2 - t1);
    tickTimings.flow.push(t3 - t2);
    tickTimings.walls.push(t4 - t3);
    tickTimings.aggressive.push(t5 - t4);
    tickTimings.encode.push(t6 - t5);
    tickTimings.total.push(t6 - t0);
    const b0 = performance.now();
    state.bare.update({ ts, column, snapshot, rowClusters: state.rowClusters, referenceRows: state.referenceRows });
    tickTimings.wallsBare.push(performance.now() - b0);
    if (JSON.stringify(state.tracker.levels().map(wireOf)) !== JSON.stringify(state.bare.levels())) {
      lockstep.mismatches += 1;
      if (lockstep.firstMismatchTs === null) lockstep.firstMismatchTs = ts;
    }
    lockstep.columns += 1;
  }

  let fixedRowClusters = null;
  try {
    for (const frame of source.frames()) {
      frames += 1;
      if (engine === null) {
        if (frame.kind !== "book" || frame.status !== "READY") continue;
        const price = priceOfFrame(frame);
        if (price === null) continue;
        fixedRowClusters = initState(price);
      }
      const started = performance.now();
      engine.apply(frame);
      frameTimings[frame.kind]?.push(performance.now() - started);
      const ts = Number(frame.ts);
      if (!engine.seeded || !Number.isSafeInteger(ts)) continue;
      if (state === null) {
        state = stateFor(fixedRowClusters);
        nextColumnTs = (Math.floor(ts / COLUMN_MS) + 1) * COLUMN_MS;
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
      while (ts >= nextColumnTs) {
        readEvents();
        if (engine.live) tick(nextColumnTs);
        nextColumnTs += COLUMN_MS;
      }
      if (ts >= nextPruneTs) {
        engine.prune(ts);
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
      const stats = engine.stats;
      recordsPeak = Math.max(recordsPeak, stats.bidRecords + stats.askRecords);
    }
  } finally {
    source.close();
  }
  if (engine === null) throw new Error("the window held no READY book: nothing was measured");
  const wallMs = performance.now() - wall0;
  const final = engine.snapshot();
  const detailed = state ? state.tracker.levels() : [];
  const levels = detailed.map(wireOf);
  digest.update(JSON.stringify(levels));
  digest.update(JSON.stringify({ bids: final.bids, asks: final.asks }));
  const verdicts = {};
  for (const level of levels) verdicts[level.ended_by ?? level.endedBy ?? "active"] = (verdicts[level.ended_by ?? level.endedBy ?? "active"] ?? 0) + 1;
  const ledger = {};
  for (const [name, values] of Object.entries(ledgerTimings)) ledger[name] = percentiles(values);
  const tickStats = {};
  for (const [name, values] of Object.entries(tickTimings)) tickStats[name] = percentiles(values);
  return {
    kind: "l2-engine-bench",
    provider: options.provider,
    symbol: options.symbol,
    instrumentKind: options.kind,
    window: { from: new Date(options.fromTs).toISOString(), to: new Date(options.toTs).toISOString() },
    node: process.version,
    geometry: state ? { price: state.price, clusterWidth: final.clusterWidth, rowClusters: state.rowClusters, rowWidth: state.rowWidth, windowRows: state.windowRows } : null,
    frames,
    replayWallMs: Math.round(wallMs),
    engineStats: engine.stats,
    recordsPeak,
    heapMiB: { start: heapStart, end: heapMiB() },
    perFrame: { book: percentiles(frameTimings.book), trade: percentiles(frameTimings.trade), anchor: percentiles(frameTimings.anchor) },
    ledger,
    perColumn: tickStats,
    columns,
    columnWireBytes: columnBytes,
    walls: { count: levels.length, verdicts },
    lockstep,
    wallDetail: detailFacts(detailed),
    events: { ...eventStats, perSecondMean: eventStats.reads > 0 ? Math.round(eventStats.total / eventStats.reads) : 0 },
    goldenSha256: digest.digest("hex"),
    digests: {
      columns: columnsDigest.digest("hex"),
      walls: sha256(JSON.stringify(levels)),
      wallDetail: sha256(JSON.stringify(detailed.map((level) => level.detail))),
      ledger: sha256(JSON.stringify({ bids: final.bids, asks: final.asks })),
      ledgerWithoutClosest: sha256(JSON.stringify({ bids: final.bids.map(withoutClosest), asks: final.asks.map(withoutClosest) })),
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = run(options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text);
  process.stdout.write(text);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, percentiles, run, buildSource, buildEngine, priceOfFrame };
