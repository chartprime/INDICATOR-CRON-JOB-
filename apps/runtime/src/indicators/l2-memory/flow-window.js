"use strict";

// Flow window: a short rolling memory of aggressive trading and where price
// went while it happened.
//
// Absorption asks one question: "how much force hit the book, and how far did
// price move?" This module stores the last N seconds of trades (tagged by
// aggressor side) and mid-price samples, and summarises any trailing window
// into: buy volume, sell volume, delta, and the price move over the window.

const DEFAULT_WINDOW_MS = 60_000;

function assertTs(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) {
    throw new Error("flow-window: ts must be a non-negative safe integer");
  }
}

function firstIndexAtOrAfter(items, target) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].ts < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createFlowWindow({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("flow-window: windowMs must be a positive safe integer");
  }
  const trades = []; // { ts, side, size, price }
  const quotes = []; // { ts, mid }
  let lastTs = 0;

  function touch(ts) {
    assertTs(ts);
    if (ts < lastTs) throw new Error(`flow-window: events must arrive in time order (got ${ts} after ${lastTs})`);
    lastTs = ts;
  }

  /** An executed trade; `side` is the aggressor. */
  function addTrade({ ts, side, size, price }) {
    touch(ts);
    if (side !== "buy" && side !== "sell") throw new Error(`flow-window: side must be "buy" or "sell", got ${String(side)}`);
    const volume = Number(size);
    const px = Number(price);
    if (!Number.isFinite(volume) || volume <= 0) throw new Error("flow-window: size must be a positive number");
    if (!Number.isFinite(px) || px <= 0) throw new Error("flow-window: price must be a positive number");
    trades.push({ ts, side, size: volume, price: px });
  }

  /** Top of book; stored as the mid price. Either side may be null when the book is one-sided. */
  function addQuote({ ts, bestBid, bestAsk }) {
    touch(ts);
    const bid = bestBid === null || bestBid === undefined ? null : Number(bestBid);
    const ask = bestAsk === null || bestAsk === undefined ? null : Number(bestAsk);
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
    if (mid === null || !Number.isFinite(mid)) return;
    const last = quotes[quotes.length - 1];
    if (last && last.ts === ts) last.mid = mid;
    else quotes.push({ ts, mid });
  }

  /**
   * Everything that happened in (ts - lookbackMs, ts].
   * priceStart is the mid at the start of the window (last quote at or before it);
   * priceEnd is the mid at `ts`. Both null when no quote is known.
   */
  function summary({ ts, lookbackMs }) {
    assertTs(ts);
    if (!Number.isSafeInteger(lookbackMs) || lookbackMs <= 0) {
      throw new Error("flow-window: lookbackMs must be a positive safe integer");
    }
    const from = ts - lookbackMs;
    let buyVolume = 0;
    let sellVolume = 0;
    let tradeCount = 0;
    for (let i = firstIndexAtOrAfter(trades, from + 1); i < trades.length && trades[i].ts <= ts; i += 1) {
      const trade = trades[i];
      if (trade.side === "buy") buyVolume += trade.size;
      else sellVolume += trade.size;
      tradeCount += 1;
    }
    const startIndex = firstIndexAtOrAfter(quotes, from + 1) - 1;
    const endIndex = firstIndexAtOrAfter(quotes, ts + 1) - 1;
    const priceStart = startIndex >= 0 ? quotes[startIndex].mid : null;
    const priceEnd = endIndex >= 0 ? quotes[endIndex].mid : null;
    return Object.freeze({
      ts,
      lookbackMs,
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
      tradeCount,
      priceStart,
      priceEnd,
      priceMove: priceStart !== null && priceEnd !== null ? priceEnd - priceStart : null,
    });
  }

  /** Forget everything older than the window (keeping one pre-window quote so priceStart stays answerable). */
  function prune(ts) {
    assertTs(ts);
    const cutoff = ts - windowMs;
    const firstTrade = firstIndexAtOrAfter(trades, cutoff);
    if (firstTrade > 0) trades.splice(0, firstTrade);
    const firstQuote = Math.max(0, firstIndexAtOrAfter(quotes, cutoff) - 1);
    if (firstQuote > 0) quotes.splice(0, firstQuote);
  }

  function stats() {
    return Object.freeze({ trades: trades.length, quotes: quotes.length, lastTs });
  }

  return Object.freeze({ addTrade, addQuote, summary, prune, stats, windowMs });
}

module.exports = { createFlowWindow, DEFAULT_WINDOW_MS };
