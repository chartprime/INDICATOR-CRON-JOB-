"use strict";

const { createMemoryEngine } = require("./memory-engine");
const { createL2InputBinding, pairKey } = require("./l2-input-binding");
const { bookFrame, tradeFrame, gapFrame } = require("./input-frames");
const { l2GeometryFor } = require("../../providers/binance/binance-config");

const DEFAULT_CLUSTER_TICKS = 50;
const DEFAULT_PRUNE_INTERVAL_MS = 30_000;
const DEFAULT_DEBUG_INTERVAL_MS = 5_000;
const SNAPSHOT_DEPTH_BY_MARKET_KIND = Object.freeze({ SPOT: 5000, PERPETUAL: 1000 });
const DEFAULT_BAND_BP = 0.0625;
const DEFAULT_MIN_SLICE_USD = 800;
const DEFAULT_MIN_SLICE_SIZE = 0.01;
const TICK_RETRY_AFTER_MS = 10_000;

function positiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function ledgerOptionsFromEnv(env = process.env) {
  const minSliceSize = Number(env.L2_MIN_SLICE_SIZE);
  return Number.isFinite(minSliceSize) && minSliceSize >= 0 ? { minSliceSize } : {};
}

function scalesFromEnv(env = process.env) {
  return {
    bandBp: positiveNumber(env.L2_BAND_BP) ?? DEFAULT_BAND_BP,
    minSliceUsd: positiveNumber(env.L2_MIN_SLICE_USD) ?? DEFAULT_MIN_SLICE_USD,
  };
}

function clusterTicksFor(price, tickSize, bandBp) {
  if (!(price > 0) || !(tickSize > 0)) return DEFAULT_CLUSTER_TICKS;
  return Math.max(1, Math.round((price * bandBp) / 10_000 / tickSize));
}

function bestBidOf(bookState) {
  const price = Number(bookState?.bestBid ?? bookState?.book?.bestBid ?? bookState?.book?.bids?.[0]?.[0]);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function binanceDepthFrame(envelope, bookState) {
  if (!envelope || envelope.state === "UNAVAILABLE" || !bookState) return gapFrame();
  return bookFrame(envelope.eventTime, bookState.status, bookState.book, { bids: envelope.payload.bids, asks: envelope.payload.asks });
}

function binanceTradeFrame(envelope) {
  if (!envelope || envelope.state === "UNAVAILABLE") return null;
  const { price, quantity, isBuyerMaker, tradeId } = envelope.payload;
  return tradeFrame(envelope.eventTime, price, quantity, isBuyerMaker ? "sell" : "buy", tradeId);
}

function formatLevel(level) {
  const flags = [
    level.seeded ? "seeded" : `age ${level.ageSec}s`,
    level.refills > 0 ? `refills ${level.refills}` : null,
    level.tests > 0 ? `tests ${level.tests}` : null,
    level.hidden > 0 ? `hidden ${level.hidden.toFixed(3)}` : null,
  ].filter(Boolean);
  return `${level.price.toFixed(1).padStart(10)}  size ${level.size.toFixed(3).padStart(8)}  traded ${level.traded.toFixed(3).padStart(8)}  cancelled ${level.cancelled.toFixed(3).padStart(8)}  ${flags.join(", ")}`;
}

function createLiveMemoryBinding({
  tickSizeResolver,
  clusterTicks = undefined,
  scales = scalesFromEnv(),
  debug = false,
  debugIntervalMs = DEFAULT_DEBUG_INTERVAL_MS,
  pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
  log = (line) => console.log(line),
  ledgerOptions = ledgerOptionsFromEnv(),
  geometryFor = l2GeometryFor,
} = {}) {
  if (!tickSizeResolver || typeof tickSizeResolver.getBinanceTickSize !== "function") {
    throw new Error("live-binding: tickSizeResolver.getBinanceTickSize is required");
  }

  const quotes = new Map();
  const tickSizes = new Map();
  const readySeen = new Set();
  const resolving = new Map();
  const failed = new Map();
  let debugTimer = null;
  let started = false;

  function buildEngine(key, marketKind, symbol, tickSize) {
    const configured = typeof geometryFor === "function" ? geometryFor(marketKind, symbol) : null;
    const knownTicks = clusterTicks ?? configured?.clusterTicks;
    const knownSlice = ledgerOptions.minSliceSize ?? configured?.minSliceSize;
    const explicit = knownTicks !== undefined && knownSlice !== undefined;
    if (!explicit && !readySeen.has(key)) return null;
    const price = quotes.get(key) ?? null;
    const ticks = knownTicks ?? clusterTicksFor(price, tickSize, scales.bandBp);
    const minSliceSize = knownSlice ?? (price !== null ? scales.minSliceUsd / price : DEFAULT_MIN_SLICE_SIZE);
    const engine = createMemoryEngine({
      tickSize,
      clusterTicks: ticks,
      snapshotDepth: SNAPSHOT_DEPTH_BY_MARKET_KIND[marketKind] ?? Infinity,
      ledgerOptions: { ...ledgerOptions, minSliceSize },
    });
    if (debug) {
      log(`l2-memory: engine ready for ${key} (tick ${tickSize}, band ${tickSize * ticks}, dust floor ${minSliceSize.toPrecision(3)} base units${price !== null ? ` at ${price}` : ", no quote"})`);
    }
    return engine;
  }

  function createEngine(marketKind, symbol) {
    const key = pairKey(marketKind, symbol);
    const knownTick = tickSizes.get(key);
    if (knownTick !== undefined) return buildEngine(key, marketKind, symbol, knownTick);
    if (resolving.has(key)) return null;
    const lastFailure = failed.get(key);
    if (lastFailure !== undefined && Date.now() - lastFailure < TICK_RETRY_AFTER_MS) return null;
    const request = {};
    resolving.set(key, request);
    let lookup;
    try {
      lookup = tickSizeResolver.getBinanceTickSize(marketKind, symbol);
      if (!lookup || typeof lookup.then !== "function") throw new Error("live-binding: tick size resolver must return a Promise");
    } catch (error) {
      resolving.delete(key);
      throw error;
    }
    lookup
      .then((tickSize) => {
        if (binding.stopped || resolving.get(key) !== request) return;
        if (!Number.isFinite(tickSize) || tickSize <= 0) {
          failed.set(key, Date.now());
          return;
        }
        tickSizes.set(key, tickSize);
        failed.delete(key);
        binding.engineFor(marketKind, symbol);
      })
      .catch((error) => {
        if (binding.stopped || resolving.get(key) !== request) return;
        failed.set(key, Date.now());
        console.error("l2-memory: tick size lookup failed", key, error?.message ?? error);
      })
      .finally(() => {
        if (resolving.get(key) === request) resolving.delete(key);
      });
    return null;
  }

  const binding = createL2InputBinding({ createEngine, prune: { mode: "timer", everyMs: pruneIntervalMs } });

  function onDepth(envelope, bookState, fullBook = null) {
    if (binding.stopped || !envelope) return;
    const key = pairKey(envelope.marketKind, envelope.providerSymbol);
    if (bookState?.status === "READY") {
      readySeen.add(key);
      const bestBid = bestBidOf(bookState);
      if (bestBid !== null) quotes.set(key, bestBid);
    }
    const engine = binding.engineFor(envelope.marketKind, envelope.providerSymbol);
    if (!engine) return;
    let state = bookState;
    if (bookState?.status === "READY" && !bookState.book) {
      if (!engine.seeded || !engine.live) {
        state = typeof fullBook === "function" ? fullBook() : null;
      } else {
        state = { status: "READY", book: { bestBid: bookState.bestBid ?? null, bestAsk: bookState.bestAsk ?? null } };
      }
    }
    binding.apply(envelope.marketKind, envelope.providerSymbol, binanceDepthFrame(envelope, state));
  }

  function onTrade(envelope) {
    if (binding.stopped || !envelope) return;
    const frame = binanceTradeFrame(envelope);
    if (frame) binding.apply(envelope.marketKind, envelope.providerSymbol, frame);
  }

  function laneWindowPct(marketKind, symbol) {
    const configured = typeof geometryFor === "function" ? geometryFor(marketKind, symbol) : null;
    return configured && Number.isFinite(configured.windowPct) ? configured.windowPct : null;
  }

  function release(marketKind, symbol) {
    const key = pairKey(marketKind, symbol);
    binding.release(marketKind, symbol);
    tickSizes.delete(key);
    readySeen.delete(key);
    quotes.delete(key);
    resolving.delete(key);
    failed.delete(key);
  }

  function printDebug() {
    for (const [key, engine] of binding.entries()) {
      const s = engine.stats;
      log(`l2-memory ${key}: seeded=${engine.seeded} live=${engine.live} levels=${s.bidRecords}/${s.askRecords} deltas=${s.deltas} trades=${s.trades} late=${s.lateEvents} gaps=${s.unavailable} resyncs=${s.resyncs}`);
      if (!engine.seeded) continue;
      const far = engine.topLevels({ limit: 3 });
      log("  walls (largest anywhere):");
      for (const level of [...far.asks].reverse()) log(`    ask ${formatLevel(level)}`);
      for (const level of far.bids) log(`    bid ${formatLevel(level)}`);
      const snap = engine.snapshot();
      const refPrice = snap.bestBidKey !== null ? engine.priceFor(snap.bestBidKey) : null;
      if (refPrice !== null) {
        const withinKeys = Math.max(1, Math.round((refPrice * 0.0025) / snap.clusterWidth));
        const near = engine.topLevels({ limit: 4, withinKeys });
        log(`  near book (within ${withinKeys} bands of best):`);
        for (const level of [...near.asks].reverse()) log(`    ask ${formatLevel(level)}`);
        for (const level of near.bids) log(`    bid ${formatLevel(level)}`);
      }
    }
  }

  function start() {
    if (started || binding.stopped) return;
    started = true;
    binding.start();
    if (debug) {
      debugTimer = setInterval(printDebug, debugIntervalMs);
      debugTimer.unref?.();
    }
  }

  function stop() {
    binding.stop();
    if (debugTimer) clearInterval(debugTimer);
    debugTimer = null;
    binding.clear();
  }

  return Object.freeze({ onDepth, onTrade, getEngine: binding.getEngine, laneWindowPct, release, start, stop, printDebug });
}

module.exports = {
  createLiveMemoryBinding,
  binanceDepthFrame,
  binanceTradeFrame,
  ledgerOptionsFromEnv,
  scalesFromEnv,
  clusterTicksFor,
  DEFAULT_CLUSTER_TICKS,
  SNAPSHOT_DEPTH_BY_MARKET_KIND,
  DEFAULT_MIN_SLICE_SIZE,
  DEFAULT_BAND_BP,
  DEFAULT_MIN_SLICE_USD,
};
