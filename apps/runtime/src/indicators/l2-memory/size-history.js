"use strict";

// Size history: a short rolling memory of how big each level was over the
// last few seconds.
//
// The ledger knows a level's size *now*. Vacuum needs "how much smaller than
// five seconds ago". This module keeps, per level, a sparse list of
// (timestamp, size) samples — one per change, not one per tick — and answers
// "what was the size at time T" by looking up the latest sample at or before
// T. Samples older than the window are dropped, except the last one before
// the window start, so a level that has not changed for a minute still
// answers correctly.

const DEFAULT_WINDOW_MS = 30_000;

function assertTs(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) {
    throw new Error("size-history: ts must be a non-negative safe integer");
  }
}

function assertSide(side) {
  if (side !== "bid" && side !== "ask") {
    throw new Error(`size-history: side must be "bid" or "ask", got ${String(side)}`);
  }
}

// Index of the last sample with ts <= target, or -1.
function lastIndexAtOrBefore(samples, target) {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function createSizeHistory({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("size-history: windowMs must be a positive safe integer");
  }
  const series = { bid: new Map(), ask: new Map() }; // key -> [{ ts, size }]
  let lastTs = 0;

  /** Record that `key` on `side` has size `size` as of `ts`. Call on every change. */
  function record({ ts, side, key, size }) {
    assertTs(ts);
    assertSide(side);
    if (!Number.isFinite(key)) throw new Error("size-history: key must be a finite number");
    if (!Number.isFinite(size) || size < 0) throw new Error("size-history: size must be a non-negative number");
    if (ts < lastTs) throw new Error(`size-history: samples must arrive in time order (got ${ts} after ${lastTs})`);
    lastTs = ts;
    let samples = series[side].get(key);
    if (!samples) {
      samples = [];
      series[side].set(key, samples);
    }
    const last = samples[samples.length - 1];
    if (last && last.ts === ts) {
      last.size = size; // same instant: overwrite, keep one sample per timestamp
    } else {
      samples.push({ ts, size });
    }
  }

  function forget({ ts, side, key }) {
    assertTs(ts);
    assertSide(side);
    if (!Number.isFinite(key)) throw new Error("size-history: key must be a finite number");
    if (ts < lastTs) throw new Error(`size-history: samples must arrive in time order (got ${ts} after ${lastTs})`);
    lastTs = ts;
    series[side].delete(key);
  }

  /** Size of `key` at time `ts`, or null if the level was unknown then. */
  function sizeAt({ side, key, ts }) {
    assertSide(side);
    assertTs(ts);
    const samples = series[side].get(key);
    if (!samples) return null;
    const index = lastIndexAtOrBefore(samples, ts);
    return index === -1 ? null : samples[index].size;
  }

  /**
   * How the size changed over the last `lookbackMs` ending at `ts`.
   * `then` is null when the level did not exist yet at the start of the window.
   */
  function change({ side, key, ts, lookbackMs }) {
    const now = sizeAt({ side, key, ts });
    const then = sizeAt({ side, key, ts: Math.max(0, ts - lookbackMs) });
    return Object.freeze({
      then,
      now: now ?? 0,
      delta: then === null ? null : (now ?? 0) - then,
    });
  }

  /** Sum of sizes over a set of keys at time `ts`, counting unknown levels as 0. */
  function totalAt({ side, keys, ts }) {
    let total = 0;
    for (const key of keys) total += sizeAt({ side, key, ts }) ?? 0;
    return total;
  }

  /** Drop samples older than the window, keeping the last pre-window sample; forget empty, stale levels. */
  function prune(ts) {
    assertTs(ts);
    const cutoff = ts - windowMs;
    for (const side of ["bid", "ask"]) {
      for (const [key, samples] of series[side]) {
        const keepFrom = Math.max(0, lastIndexAtOrBefore(samples, cutoff));
        if (keepFrom > 0) samples.splice(0, keepFrom);
        const last = samples[samples.length - 1];
        if (samples.length === 1 && last.size === 0 && last.ts <= cutoff) {
          series[side].delete(key);
        }
      }
    }
  }

  function stats() {
    let samples = 0;
    for (const side of ["bid", "ask"]) for (const s of series[side].values()) samples += s.length;
    return Object.freeze({ bidKeys: series.bid.size, askKeys: series.ask.size, samples, lastTs });
  }

  return Object.freeze({ record, forget, sizeAt, change, totalAt, prune, stats, windowMs });
}

module.exports = { createSizeHistory, DEFAULT_WINDOW_MS };
