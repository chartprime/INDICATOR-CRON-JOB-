const Database = require("better-sqlite3");
const { createIcebergIndicator } = require("./iceberg-indicator");
const { createLearnedCuts } = require("./learned-cuts");
const { createDxFeedIcebergSource, createBinanceIcebergSource } = require("./iceberg-capture-sources");
const { spanOf } = require("./spans");
const { orderSourceFor } = require("../../providers/dxfeed/dxfeed-instrument-catalog");
const { DEFAULT_ARRIVAL_MARGIN_MS, arrivalScanHint } = require("../l2-memory/dxfeed-replay-source");

const DAY_MS = 86_400_000;
const DEFAULT_CHUNK_MS = 300_000;
const DEFAULT_LAG_MS = 60_000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_REWARM_MS = 600_000;
const DEFAULT_GAP_MS = 30_000;
const TICK_MS = 1_000;
const PROVIDERS = new Set(["binance", "dxfeed"]);
const DEFAULT_WARMUP_MS = Object.freeze({ binance: 24 * 3_600_000, dxfeed: 0 });
const DEFAULT_CAPTURE_MARGIN_MS = Object.freeze({ binance: 5_000, dxfeed: DEFAULT_ARRIVAL_MARGIN_MS });
const SETTLED = new Set(["filled", "pulled", "replaced", "interrupted", "ended"]);

function boundLookups(provider, db) {
  if (provider === "dxfeed") {
    const scan = arrivalScanHint(db);
    const arrival = (order) => db.prepare(`SELECT received_at AS ts FROM dxfeed_order_book_capture ${scan} WHERE symbol = ? AND asset_class = ? AND source = ? ORDER BY id ${order} LIMIT 1`);
    return { db, earliest: [arrival("ASC")], latest: [arrival("DESC")] };
  }
  const depth = (order) => db.prepare(`SELECT ts FROM l2_depth_events INDEXED BY idx_l2_depth_events_symbol_market_ts WHERE symbol = ? AND market_kind = ? ORDER BY ts ${order} LIMIT 1`);
  const snapshot = (order) => db.prepare(`SELECT captured_at AS ts FROM l2_depth_snapshots INDEXED BY idx_l2_depth_snapshots_symbol_market_captured_at WHERE symbol = ? AND market_kind = ? ORDER BY captured_at ${order} LIMIT 1`);
  return { db, earliest: [depth("ASC"), snapshot("ASC")], latest: [depth("DESC"), snapshot("DESC")] };
}

function createCaptureBounds({ dbPaths, Database: Db = Database, log = () => {} }) {
  const connections = {};
  const failures = { binance: 0, dxfeed: 0 };
  function open(provider) {
    if (connections[provider] !== undefined) return connections[provider];
    let db = null;
    try {
      db = new Db(dbPaths[provider], { readonly: true, fileMustExist: true, timeout: 2_000 });
      connections[provider] = boundLookups(provider, db);
    } catch (error) {
      db?.close();
      failures[provider] += 1;
      if (failures[provider] === 1) log(`iceberg-host-builder: cannot read the ${provider} capture ${dbPaths[provider]}: ${error?.message ?? error}; retrying on every call and counting the failures`);
      return null;
    }
    if (failures[provider] > 0) log(`iceberg-host-builder: the ${provider} capture opened after ${failures[provider]} failed attempts`);
    failures[provider] = 0;
    return connections[provider];
  }
  function of(pair, { earliest = true } = {}) {
    const entry = open(pair.provider);
    if (entry === null) return { earliest: null, latest: null, reason: "CAPTURE_UNREADABLE" };
    const args = pair.provider === "dxfeed" ? [pair.symbol, pair.marketKind, orderSourceFor(pair.marketKind, pair.symbol)] : [pair.symbol, pair.marketKind];
    const found = (lookups) => lookups.map((lookup) => lookup.get(...args)?.ts ?? null).filter((ts) => ts !== null);
    const firsts = earliest ? found(entry.earliest) : [];
    const lasts = found(entry.latest);
    return { earliest: firsts.length === 0 ? null : Math.min(...firsts), latest: lasts.length === 0 ? null : Math.max(...lasts) };
  }
  function close() {
    for (const entry of Object.values(connections)) {
      try { entry?.db.close(); } catch { continue; }
    }
  }
  return Object.freeze({ of, close });
}

function defaultSourceFactory({ pair, dbPath, fromTs, onEvents, onStatus, onBookDropped, onDepth, onTrade }) {
  if (pair.provider === "dxfeed") return createDxFeedIcebergSource({ dbPath, symbol: pair.symbol, assetClass: pair.marketKind, fromTs, onEvents, onStatus, onBookDropped });
  return createBinanceIcebergSource({ dbPath, symbol: pair.symbol, marketKind: pair.marketKind, fromTs, onDepth, onTrade });
}

function createIcebergHostBuilder({
  store,
  pair,
  dbPath,
  chunkMs = DEFAULT_CHUNK_MS,
  lagMs = DEFAULT_LAG_MS,
  captureMarginMs = DEFAULT_CAPTURE_MARGIN_MS[pair?.provider],
  warmupMs = DEFAULT_WARMUP_MS[pair?.provider],
  retentionMs = DEFAULT_RETENTION_MS,
  rewarmMs = DEFAULT_REWARM_MS,
  gapMs = DEFAULT_GAP_MS,
  captureBounds = () => ({ earliest: null, latest: null }),
  now = () => Date.now(),
  cutsFactory = (options) => createLearnedCuts(options),
  cutsOptions = {},
  indicatorFactory = createIcebergIndicator,
  sourceFactory = defaultSourceFactory,
  log = () => {},
} = {}) {
  if (!store || typeof store.checkpoint !== "function") throw new Error("iceberg-host-builder: store is required");
  if (!pair || !PROVIDERS.has(pair.provider) || typeof pair.symbol !== "string" || typeof pair.marketKind !== "string") throw new Error("iceberg-host-builder: pair needs a provider of binance or dxfeed, a symbol and a marketKind");
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new Error("iceberg-host-builder: dbPath is required");
  for (const [name, value] of [["chunkMs", chunkMs], ["retentionMs", retentionMs], ["rewarmMs", rewarmMs], ["gapMs", gapMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`iceberg-host-builder: ${name} must be a positive safe integer`);
  }
  for (const [name, value] of [["lagMs", lagMs], ["captureMarginMs", captureMarginMs], ["warmupMs", warmupMs]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`iceberg-host-builder: ${name} must be a non-negative safe integer`);
  }
  const indicatorPair = { marketKind: pair.marketKind, symbol: pair.symbol };
  let state = null;
  let droppedGaps = 0;

  function silenceStart() {
    return state.silentSince ?? state.lastEventTs ?? state.replayFrom;
  }

  function noteEvent(ts) {
    if (ts >= state.liveFrom) {
      const silentFrom = silenceStart();
      if (ts - silentFrom > gapMs) state.gaps.push([silentFrom, ts, "NO_CAPTURE"]);
      state.silentSince = null;
    }
    if (state.lastEventTs === null || ts > state.lastEventTs) state.lastEventTs = ts;
    while (state.nextTickAt <= ts) {
      state.clock = state.nextTickAt;
      state.indicator.tick(state.nextTickAt);
      state.nextTickAt += TICK_MS;
    }
    state.clock = ts;
  }

  function onStatus(status, ts) {
    if (ts < state.liveFrom) return;
    if (status === "UNAVAILABLE") {
      if (state.unavailableSince === null) state.unavailableSince = ts;
      return;
    }
    if (state.unavailableSince !== null && ts > state.unavailableSince) state.gaps.push([state.unavailableSince, ts, "BOOK_UNAVAILABLE"]);
    state.unavailableSince = null;
  }

  function storable(gaps) {
    const kept = [];
    for (const [gapFrom, gapTo, reason] of gaps) {
      if (spanOf(gapFrom, gapTo) === null) {
        droppedGaps += 1;
        if (droppedGaps === 1) log(`iceberg-host-builder: ${pair.symbol} dropped a ${reason} gap the store cannot hold, [${gapFrom}, ${gapTo}]; that time reads as watched, and later drops are only counted in droppedGaps`);
        continue;
      }
      if (gapTo > state.start) kept.push([Math.max(gapFrom, state.start), gapTo, reason]);
    }
    return kept;
  }

  function open() {
    const saved = store.checkpoint();
    const fromCapture = saved.cursor === null || saved.cursor < saved.start;
    const bounds = captureBounds({ earliest: fromCapture });
    if (typeof bounds.reason === "string") return bounds.reason;
    if (saved.cursor === null && bounds.earliest === null) return "NO_CAPTURE";
    const at = now();
    const earliest = fromCapture ? Math.max(bounds.earliest, at - retentionMs) : saved.start;
    const start = saved.cursor === null ? earliest + warmupMs : saved.start;
    const cursor = saved.cursor;
    const replayFrom = cursor === null ? earliest : Math.max(earliest, cursor - rewarmMs);
    state = {
      indicator: null, cuts: null, cursor, start, replayFrom, liveFrom: cursor ?? Number.NEGATIVE_INFINITY, clock: replayFrom, nextTickAt: replayFrom + TICK_MS,
      settledLine: saved.settledThrough ?? start, settled: new Map(), gaps: saved.gaps.map((gap) => [...gap]), lastEventTs: null, silentSince: null, unavailableSince: null, source: null,
    };
    const indicator = indicatorFactory({
      provider: pair.provider === "dxfeed" ? "DXFEED" : "BINANCE",
      histories: false,
      now: () => state.clock,
      cuts: cutsOptions,
      cutsFactory: (options) => {
        state.cuts = cutsFactory(options);
        if (saved.cuts !== null && typeof state.cuts.load === "function" && !state.cuts.load(saved.cuts)) log(`iceberg-host-builder: ${pair.symbol} saved cuts rejected; learning afresh`);
        return state.cuts;
      },
      publish: (wire) => {
        for (const entry of wire) {
          if (SETTLED.has(entry.status) && entry.markedAt >= Math.max(state.settledLine, state.start)) state.settled.set(entry.id, entry);
        }
      },
      log: { warn: (message) => log(message), error: (message) => log(message) },
    });
    state.indicator = indicator;
    const stillOpen = saved.gaps.findIndex(([, gapTo, reason]) => reason === "BOOK_UNAVAILABLE" && gapTo === cursor);
    if (stillOpen !== -1) {
      state.unavailableSince = saved.gaps[stillOpen][0];
      state.gaps.splice(stillOpen, 1);
    }
    const stillSilent = state.gaps.findIndex(([, gapTo, reason]) => reason === "NO_CAPTURE" && gapTo === cursor);
    if (stillSilent !== -1) {
      state.silentSince = state.gaps[stillSilent][0];
      state.gaps.splice(stillSilent, 1);
    }
    try {
      state.source = sourceFactory({
        pair, dbPath, fromTs: replayFrom,
        onEvents: (events, meta) => {
          noteEvent(meta.receivedAt);
          indicator.onNativeEvents(indicatorPair, events, meta);
        },
        onStatus,
        onBookDropped: (ts) => indicator.onNativeUnavailable(indicatorPair, ts),
        onDepth: (entries, ts) => {
          noteEvent(ts);
          indicator.onDepth(indicatorPair, entries, ts);
        },
        onTrade: (trade) => {
          noteEvent(trade.ts);
          indicator.onTrade(indicatorPair, trade);
        },
      });
    } catch (error) {
      indicator.stop();
      state = null;
      throw error;
    }
    return null;
  }

  function earliestOpenMark() {
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of state.indicator.snapshot(indicatorPair, state.clock).icebergs) {
      if (entry.status === "active" && entry.markedAt < earliest) earliest = entry.markedAt;
    }
    return earliest;
  }

  function runChunk() {
    if (state === null) {
      const waiting = open();
      if (waiting !== null) return { built: false, reason: waiting, from: null };
    }
    const from = state.cursor ?? state.replayFrom;
    const to = from + chunkMs;
    const bounds = captureBounds({ earliest: false });
    const limit = Math.min(now() - lagMs, bounds.latest === null ? Number.NEGATIVE_INFINITY : bounds.latest - captureMarginMs);
    if (to > limit) return { built: false, reason: bounds.reason ?? "AWAITING_CAPTURE", from };
    state.source.advanceTo(to);
    state.clock = to;
    while (state.nextTickAt <= to) {
      state.indicator.tick(state.nextTickAt);
      state.nextTickAt += TICK_MS;
    }
    state.lastEventTs = state.lastEventTs === null ? null : Math.min(state.lastEventTs, to);
    const openMark = earliestOpenMark();
    const settledThrough = Math.min(to, openMark);
    state.start = Math.max(state.start, now() - retentionMs);
    state.gaps = storable(state.gaps);
    const gaps = state.unavailableSince === null ? state.gaps : [...state.gaps, ...storable([[state.unavailableSince, to, "BOOK_UNAVAILABLE"]])];
    const silentFrom = silenceStart();
    const settled = [...state.settled.values()];
    store.checkpoint({
      cursor: to,
      start: state.start,
      settledThrough,
      cuts: state.cuts !== null && typeof state.cuts.toJSON === "function" ? state.cuts.toJSON() : null,
      coverage: to > state.start ? [[state.start, to]] : [],
      gaps: to - silentFrom > gapMs ? [...gaps, ...storable([[silentFrom, to, "NO_CAPTURE"]])] : gaps,
    }, settled);
    state.cursor = to;
    state.settledLine = settledThrough;
    state.settled.clear();
    return { built: true, from, to, settled: settled.length, open: Number.isFinite(openMark) ? state.indicator.snapshot(indicatorPair, state.clock).icebergs.filter((entry) => entry.status === "active").length : 0 };
  }

  function close() {
    if (state === null) return;
    state.source.close();
    state.indicator.stop();
    state = null;
  }

  return Object.freeze({ runChunk, close, get pair() { return pair; }, get droppedGaps() { return droppedGaps; } });
}

module.exports = { createIcebergHostBuilder, createCaptureBounds, DEFAULT_CHUNK_MS, DEFAULT_LAG_MS, DEFAULT_RETENTION_MS, DEFAULT_REWARM_MS, DEFAULT_GAP_MS, DEFAULT_WARMUP_MS, DEFAULT_CAPTURE_MARGIN_MS };
