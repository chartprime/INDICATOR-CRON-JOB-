"use strict";

const { createMemoryEngine } = require("../l2-memory/memory-engine");
const { createL2InputBinding, pairKey } = require("../l2-memory/l2-input-binding");
const { bookFrame, tradeFrame } = require("../l2-memory/input-frames");
const { DXFEED_COALESCE_MS, DXFEED_BATCHING, changeBook, hasChanges } = require("../l2-memory/dxfeed-book-frames");
const { futuresRootOf, tickSizeFor } = require("../../providers/dxfeed/dxfeed-instrument-catalog");

const DEFAULT_COALESCE_MS = DXFEED_COALESCE_MS;
const BATCHING = DXFEED_BATCHING.LIVE;
const DEFAULT_FUTURE_ROW_TICKS = 1;
const DEFAULT_EQUITY_ROW_TICKS = 1;
const PRUNE_EVERY_MS = 60_000;
const FUTURES_NOTIONAL_MULTIPLIERS = Object.freeze({
  "/NQ": 20, "/MNQ": 2, "/ES": 50, "/MES": 5, "/RTY": 50, "/M2K": 5, "/YM": 5, "/MYM": 0.5,
});

function notionalMultiplierFor(assetClass, symbol) {
  if (assetClass !== "FUTURE") return 1;
  const root = futuresRootOf(symbol);
  return root !== null && FUTURES_NOTIONAL_MULTIPLIERS[root] !== undefined ? FUTURES_NOTIONAL_MULTIPLIERS[root] : 1;
}

function levelDelta(before, after, descending) {
  const out = [];
  const first = descending ? (a, b) => a > b : (a, b) => a < b;
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (j >= after.length) {
      out.push([before[i][0], 0]);
      i += 1;
      continue;
    }
    if (i >= before.length) {
      out.push([after[j][0], after[j][1]]);
      j += 1;
      continue;
    }
    const [priceBefore, sizeBefore] = before[i];
    const [priceAfter, sizeAfter] = after[j];
    if (priceBefore === priceAfter) {
      if (sizeBefore !== sizeAfter) out.push([priceAfter, sizeAfter]);
      i += 1;
      j += 1;
    } else if (first(priceBefore, priceAfter)) {
      out.push([priceBefore, 0]);
      i += 1;
    } else {
      out.push([priceAfter, sizeAfter]);
      j += 1;
    }
  }
  return out;
}

function createDxFeedLiquidityBinding({
  instruments,
  coalesceMs = DEFAULT_COALESCE_MS,
  futureRowTicks = DEFAULT_FUTURE_ROW_TICKS,
  equityRowTicks = DEFAULT_EQUITY_ROW_TICKS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (line) => console.error(line),
} = {}) {
  if (!Array.isArray(instruments)) throw new Error("dxfeed-liquidity-binding: instruments must be an array");
  if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 0) throw new Error("dxfeed-liquidity-binding: coalesceMs must be a non-negative safe integer");
  for (const [name, value] of [["futureRowTicks", futureRowTicks], ["equityRowTicks", equityRowTicks]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dxfeed-liquidity-binding: ${name} must be a positive safe integer`);
  }
  const entries = new Map();
  for (const instrument of instruments) {
    const { assetClass, symbol } = instrument ?? {};
    if (typeof symbol !== "string" || symbol.length === 0) continue;
    const tickSize = instrument.tickSize > 0 ? instrument.tickSize : tickSizeFor(assetClass, symbol);
    if (!(tickSize > 0)) {
      log(`dxfeed-liquidity-binding: no tick size for ${assetClass}:${symbol}, no heatmap for it`);
      continue;
    }
    entries.set(pairKey(assetClass, symbol), {
      assetClass,
      symbol,
      tickSize,
      multiplier: notionalMultiplierFor(assetClass, symbol),
      rowTicks: assetClass === "FUTURE" ? futureRowTicks : equityRowTicks,
      lastBook: null,
      getState: null,
      lastSnapshot: null,
      lastEventMs: 0,
      timer: null,
    });
  }
  const binding = createL2InputBinding({
    createEngine: (assetClass, symbol) => {
      const entry = entries.get(pairKey(assetClass, symbol));
      return entry ? createMemoryEngine({ tickSize: entry.tickSize, fullDepth: true }) : null;
    },
    prune: { mode: "book", everyMs: PRUNE_EVERY_MS },
  });
  for (const entry of entries.values()) binding.engineFor(entry.assetClass, entry.symbol);
  let stopped = false;

  function entryFor(assetClass, symbol) {
    return entries.get(pairKey(assetClass, symbol)) ?? null;
  }

  function engineOf(entry) {
    return binding.getEngine(entry.assetClass, entry.symbol);
  }

  function apply(entry, frame) {
    binding.apply(entry.assetClass, entry.symbol, frame);
  }

  function epoch(ts) {
    return Number.isSafeInteger(ts) && ts > 0 ? ts : now();
  }

  function applyState(entry, state, ts) {
    const at = epoch(ts);
    if (!state || state.status !== "READY" || !state.book) {
      entry.lastBook = null;
      apply(entry, bookFrame(at, "UNAVAILABLE", null, null));
      return;
    }
    const book = state.book;
    let delta = null;
    if (entry.lastBook !== null) {
      const bids = levelDelta(entry.lastBook.bids, book.bids, true);
      const asks = levelDelta(entry.lastBook.asks, book.asks, false);
      if (bids.length > 0 || asks.length > 0) delta = { bids, asks };
    }
    entry.lastBook = book;
    apply(entry, bookFrame(at, "READY", book, delta));
  }

  function applyAssembler(entry, assembler, ts) {
    const at = epoch(ts);
    const status = assembler.getStatus();
    if (!status || status.status !== "READY") {
      entry.lastBook = null;
      entry.lastSnapshot = null;
      apply(entry, bookFrame(at, "UNAVAILABLE", null, null));
      return;
    }
    const snapshot = assembler.getSnapshotCount();
    const engine = engineOf(entry);
    if (!engine.seeded || !engine.live || entry.lastSnapshot !== snapshot) {
      if (engine.seeded && engine.live) apply(entry, bookFrame(at, "UNAVAILABLE", null, null));
      entry.lastBook = null;
      entry.lastSnapshot = snapshot;
      assembler.drainLevelChanges();
      applyState(entry, assembler.getState(), at);
      return;
    }
    const changes = assembler.drainLevelChanges();
    const { bestBid, bestAsk } = changeBook(assembler, "sparse");
    apply(entry, bookFrame(at, "READY", { bestBid, bestAsk }, hasChanges(changes) ? changes : null));
  }

  function flush(entry) {
    entry.timer = null;
    const source = entry.getState;
    if (stopped || source === null) return;
    try {
      if (typeof source === "function") applyState(entry, source(), entry.lastEventMs);
      else applyAssembler(entry, source, entry.lastEventMs);
    } catch (error) {
      log(`dxfeed-liquidity-binding: book apply failed for ${entry.symbol}: ${error?.message ?? error}`);
    }
  }

  function noteBook(assetClass, symbol, source, eventTimeMs) {
    const entry = entryFor(assetClass, symbol);
    if (!entry || stopped) return false;
    if (typeof source !== "function" && (!source || typeof source.getStatus !== "function" || typeof source.drainLevelChanges !== "function")) return false;
    entry.getState = source;
    if (Number.isSafeInteger(eventTimeMs) && eventTimeMs > entry.lastEventMs) entry.lastEventMs = eventTimeMs;
    if (entry.timer !== null) return true;
    if (coalesceMs === 0) {
      flush(entry);
      return true;
    }
    entry.timer = setTimer(() => flush(entry), coalesceMs);
    entry.timer.unref?.();
    return true;
  }

  function onTrade(assetClass, symbol, { ts, price, size, side, tradeId } = {}) {
    const entry = entryFor(assetClass, symbol);
    if (!entry || stopped) return false;
    if ((side !== "buy" && side !== "sell") || !(price > 0) || !(size > 0)) return false;
    try {
      apply(entry, tradeFrame(epoch(ts), price, size, side, tradeId));
    } catch (error) {
      log(`dxfeed-liquidity-binding: trade apply failed for ${entry.symbol}: ${error?.message ?? error}`);
      return false;
    }
    return true;
  }

  function markUnavailable(assetClass, symbol) {
    const targets = assetClass === undefined ? [...entries.values()] : [entryFor(assetClass, symbol)].filter(Boolean);
    for (const entry of targets) {
      if (entry.timer !== null) {
        clearTimer(entry.timer);
        entry.timer = null;
      }
      entry.lastBook = null;
      entry.lastSnapshot = null;
      try {
        apply(entry, bookFrame(now(), "UNAVAILABLE", null, null));
      } catch (error) {
        log(`dxfeed-liquidity-binding: unavailable mark failed for ${entry.symbol}: ${error?.message ?? error}`);
      }
    }
  }

  function flushAll() {
    for (const entry of entries.values()) {
      if (entry.timer !== null) {
        clearTimer(entry.timer);
        entry.timer = null;
      }
      flush(entry);
    }
  }

  function stop() {
    stopped = true;
    binding.stop();
    for (const entry of entries.values()) {
      if (entry.timer !== null) {
        clearTimer(entry.timer);
        entry.timer = null;
      }
    }
  }

  return Object.freeze({
    getEngine: (assetClass, symbol) => binding.getEngine(assetClass, symbol),
    notionalMultiplier: (assetClass, symbol) => entryFor(assetClass, symbol)?.multiplier ?? 1,
    rowClusters: (assetClass, symbol) => entryFor(assetClass, symbol)?.rowTicks ?? null,
    noteBook,
    onTrade,
    markUnavailable,
    flushAll,
    stop,
    instruments: () => [...entries.values()].map((entry) => ({ assetClass: entry.assetClass, symbol: entry.symbol })),
  });
}

function dxfeedLiquidityOptionsFromEnv(env = process.env) {
  const options = {};
  const positiveInteger = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const futureRowTicks = positiveInteger(env.L2_HEATMAP_FUTURE_ROW_TICKS);
  if (futureRowTicks !== undefined) options.futureRowTicks = futureRowTicks;
  const equityRowTicks = positiveInteger(env.L2_HEATMAP_EQUITY_ROW_TICKS);
  if (equityRowTicks !== undefined) options.equityRowTicks = equityRowTicks;
  const coalesceMs = positiveInteger(env.L2_HEATMAP_DXFEED_DIFF_MS);
  if (coalesceMs !== undefined) options.coalesceMs = coalesceMs;
  return options;
}

module.exports = {
  createDxFeedLiquidityBinding,
  dxfeedLiquidityOptionsFromEnv,
  DEFAULT_FUTURE_ROW_TICKS,
  DEFAULT_EQUITY_ROW_TICKS,
  levelDelta,
  notionalMultiplierFor,
  DEFAULT_COALESCE_MS,
  BATCHING,
  FUTURES_NOTIONAL_MULTIPLIERS,
};
