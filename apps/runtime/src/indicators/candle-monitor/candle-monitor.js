"use strict";

const { CANDLE_MS, RAW_CAP, GAP_MS, touchRows, flowTotal } = require("../exhaustion/exhaustion-engine");

const PROVIDERS = new Set(["BINANCE", "DXFEED"]);
const DEFAULT_COLUMNS_PER_TICK = 1_000;
const OPEN_SLACK_MS = 15_000;
const EQUITY_MAX_MS = 1_800_000;
const ENTRY_KEYS = Object.freeze(["candleMs", "candleTs", "buy", "sell", "biggestBuy", "biggestSell"]);

function sum(value) {
  return Math.round(Math.min(RAW_CAP, value) * 1000) / 1000;
}

function pairKeyOf(pair) {
  return `${pair.marketKind}:${pair.symbol}`;
}

function lengthsFor(pair, candleLengths) {
  return pair.marketKind === "EQUITY" ? candleLengths.filter((candleMs) => candleMs <= EQUITY_MAX_MS) : candleLengths;
}

function biggestPrint(column, side, best) {
  let top = best;
  for (const print of column.prints ?? []) {
    if (print.side !== side || !(print.size > 0) || !(print.price > 0)) continue;
    if (top === null || print.size > top.size) top = { size: print.size, price: print.price };
  }
  return top;
}

function tradeOf(best) {
  if (best === null) return null;
  const size = sum(best.size);
  return size > 0 ? Object.freeze({ size, price: best.price }) : null;
}

function createCandleCounter({ candleLengths = CANDLE_MS } = {}) {
  if (!Array.isArray(candleLengths) || candleLengths.length === 0 || candleLengths.some((ms) => !CANDLE_MS.includes(ms))) throw new Error("candle-counter: candleLengths must be chart candle lengths");
  const lengths = [...candleLengths].sort((a, b) => a - b);
  const current = new Map();
  let lastColumnTs = null;

  function push(column) {
    if (!column || !Number.isSafeInteger(column.ts) || !(column.bid instanceof Float64Array) || !(column.ask instanceof Float64Array)) {
      throw new Error("candle-counter: column must carry an integer ts and Float64Array sides");
    }
    const closed = [];
    if (lastColumnTs !== null && column.ts <= lastColumnTs) return closed;
    const { bidRow, askRow } = touchRows(column);
    if (bidRow < 0 || askRow < 0) return closed;
    const joined = lastColumnTs !== null && column.ts - lastColumnTs <= GAP_MS;
    if (lastColumnTs !== null && !joined) for (const candle of current.values()) candle.whole = false;
    const buy = flowTotal(column.buy);
    const sell = flowTotal(column.sell);
    for (const candleMs of lengths) {
      const bucket = Math.floor(column.ts / candleMs) * candleMs;
      let candle = current.get(candleMs);
      if (candle !== undefined && candle.ts !== bucket) {
        if (candle.whole) closed.push(Object.freeze({ candleMs, candleTs: candle.ts, buy: sum(candle.buy), sell: sum(candle.sell), biggestBuy: tradeOf(candle.biggestBuy), biggestSell: tradeOf(candle.biggestSell) }));
        candle = undefined;
      }
      if (candle === undefined) {
        candle = { ts: bucket, whole: joined || column.ts - bucket <= OPEN_SLACK_MS, buy: 0, sell: 0, biggestBuy: null, biggestSell: null };
        current.set(candleMs, candle);
      }
      candle.buy += buy;
      candle.sell += sell;
      candle.biggestBuy = biggestPrint(column, "buy", candle.biggestBuy);
      candle.biggestSell = biggestPrint(column, "sell", candle.biggestSell);
    }
    lastColumnTs = column.ts;
    return closed;
  }

  return Object.freeze({ push, get lastColumnTs() { return lastColumnTs; } });
}

function createCandleMonitor({
  provider,
  columnsAfter,
  geometryOf,
  activePair = () => null,
  publish = () => {},
  now = () => Date.now(),
  log = console,
  columnsPerTick = DEFAULT_COLUMNS_PER_TICK,
  candleLengths = CANDLE_MS,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new Error("candle-monitor: provider must be BINANCE or DXFEED");
  for (const [name, value] of [["columnsAfter", columnsAfter], ["geometryOf", geometryOf], ["activePair", activePair], ["publish", publish]]) {
    if (typeof value !== "function") throw new Error(`candle-monitor: ${name} must be a function`);
  }
  if (!Number.isSafeInteger(columnsPerTick) || columnsPerTick <= 0) throw new Error("candle-monitor: columnsPerTick must be a positive safe integer");
  const states = new Map();

  function stateFor(pair, rowWidth) {
    const key = pairKeyOf(pair);
    const existing = states.get(key);
    if (existing !== undefined && existing.rowWidth === rowWidth) return existing;
    const lengths = lengthsFor(pair, candleLengths);
    if (lengths.length === 0) return null;
    const state = { pair, rowWidth, counter: createCandleCounter({ candleLengths: lengths }), entries: new Map(), lastTs: null };
    states.set(key, state);
    return state;
  }

  function feed(state) {
    const columns = columnsAfter(state.pair, state.lastTs, columnsPerTick);
    if (!Array.isArray(columns) || columns.length === 0) return;
    for (const column of columns) {
      for (const closed of state.counter.push(column)) state.entries.set(closed.candleMs, closed);
      state.lastTs = column.ts;
    }
  }

  function entriesOf(state) {
    return [...state.entries.values()].sort((a, b) => a.candleMs - b.candleMs);
  }

  function tick(pairs, at = now()) {
    for (const pair of pairs) {
      const geometry = geometryOf(pair);
      if (!geometry || !(geometry.rowWidth > 0)) continue;
      const state = stateFor(pair, geometry.rowWidth);
      if (state === null) continue;
      try {
        feed(state);
      } catch (error) {
        if (typeof log.warn === "function") log.warn(`candle monitor: ${pairKeyOf(pair)} rejected a column`, { reason: error?.message ?? error });
      }
    }
    const active = activePair();
    const watched = active ? states.get(pairKeyOf(active)) : undefined;
    if (watched === undefined || watched.entries.size === 0) return;
    publish(entriesOf(watched), watched.pair, at);
  }

  function snapshot(pair) {
    const state = states.get(pairKeyOf(pair));
    return state === undefined ? [] : entriesOf(state);
  }

  function stop() {
    states.clear();
  }

  function stats() {
    return Object.fromEntries([...states.entries()].map(([key, state]) => [key, { candles: state.entries.size, lastTs: state.lastTs, rowWidth: state.rowWidth }]));
  }

  return Object.freeze({ tick, snapshot, stop, stats });
}

module.exports = { createCandleCounter, createCandleMonitor, lengthsFor, ENTRY_KEYS, OPEN_SLACK_MS, EQUITY_MAX_MS, DEFAULT_COLUMNS_PER_TICK };
