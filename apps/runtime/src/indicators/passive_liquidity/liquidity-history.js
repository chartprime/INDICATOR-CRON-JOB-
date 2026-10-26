"use strict";

// Passive liquidity history: the last N columns of one pair, and the delta
// encoding that puts them on the wire.
//
// A column is stored in full (two Float64Arrays over its row window), which
// keeps memory flat and makes "what changed since the previous column" a
// plain comparison. On the wire a column lists only the rows whose size
// differs from the previous column, as [offset, size] pairs where offset is
// relative to the column's own `lo`. A row that was inside the previous
// window and is outside this one is implicitly zero: both ends apply the
// same rule, so nothing needs to be sent for it.
//
// `seq` counts columns ever appended for this pair. A frame carrying N
// columns ending at `seq` therefore covers columns seq-N .. seq-1, and a
// client can check it missed nothing between two frames. A merge of older
// columns leaves `seq` alone, so the live chain a client follows survives
// it; the merged columns reach the client with the next snapshot, which
// rebases `seq` to the retained count first.

const { quantizeSize } = require("./liquidity-sampler");
const { selectPrintsWithFloor } = require("./bounded-prints");

const DEFAULT_MAX_COLUMNS = 1_200;
const DEFAULT_MAX_PRINTS = 64;

function assertColumn(column) {
  if (!column || !Number.isSafeInteger(column.ts) || !Number.isSafeInteger(column.lo) || !Number.isSafeInteger(column.hi) || column.lo > column.hi) {
    throw new Error("liquidity-history: column must carry integer ts, lo <= hi");
  }
  const span = column.hi - column.lo + 1;
  if (!(column.bid instanceof Float64Array) || !(column.ask instanceof Float64Array) || column.bid.length !== span || column.ask.length !== span) {
    throw new Error("liquidity-history: column sides must be Float64Arrays spanning lo..hi");
  }
}

/** Size at an absolute row in a column, 0 outside its window. */
function sizeAt(column, side, row) {
  if (!column || row < column.lo || row > column.hi) return 0;
  return column[side][row - column.lo];
}

function encodeSide(prev, next, side) {
  const entries = [];
  const values = next[side];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value !== sizeAt(prev, side, next.lo + i)) entries.push([i, value]);
  }
  return entries;
}

function flowOf(column) {
  return {
    ...(column.buy === undefined ? {} : { buy: column.buy }),
    ...(column.sell === undefined ? {} : { sell: column.sell }),
    ...(column.prints === undefined ? {} : { prints: column.prints }),
    ...(column.printsFloor === undefined ? {} : { printsFloor: column.printsFloor }),
  };
}

/** The rows a wire column carries, applied over the column before it. */
function decodeColumn(prev, wire) {
  const span = wire.hi - wire.lo + 1;
  const bid = new Float64Array(span);
  const ask = new Float64Array(span);
  if (prev) {
    const from = Math.max(wire.lo, prev.lo);
    const to = Math.min(wire.hi, prev.hi);
    for (let row = from; row <= to; row += 1) {
      bid[row - wire.lo] = prev.bid[row - prev.lo];
      ask[row - wire.lo] = prev.ask[row - prev.lo];
    }
  }
  for (const [offset, size] of wire.bid) bid[offset] = size;
  for (const [offset, size] of wire.ask) ask[offset] = size;
  return { ts: wire.ts, lo: wire.lo, hi: wire.hi, bid, ask, ...flowOf(wire) };
}

/**
 * Wire form of `next` given the column before it (null = first column, sent
 * in full).
 */
function encodeColumn(prev, next) {
  return Object.freeze({
    ts: next.ts,
    lo: next.lo,
    hi: next.hi,
    bid: encodeSide(prev, next, "bid"),
    ask: encodeSide(prev, next, "ask"),
    ...flowOf(next),
  });
}

const fullWires = new WeakMap();
const deltaWires = new WeakMap();

function encodeAfter(prev, next) {
  if (prev === null) {
    let wire = fullWires.get(next);
    if (wire === undefined) {
      wire = encodeColumn(null, next);
      fullWires.set(next, wire);
    }
    return wire;
  }
  let cached = deltaWires.get(next);
  if (cached === undefined) {
    cached = new WeakMap();
    deltaWires.set(next, cached);
  }
  const existing = cached.get(prev);
  if (existing !== undefined) return existing;
  const wire = encodeColumn(prev, next);
  cached.set(prev, wire);
  return wire;
}

function mergeMax(accum, column) {
  const from = Math.max(accum.lo, column.lo);
  const to = Math.min(accum.hi, column.hi);
  for (let row = from; row <= to; row += 1) {
    const i = row - accum.lo;
    const j = row - column.lo;
    if (column.bid[j] > accum.bid[i]) accum.bid[i] = column.bid[j];
    if (column.ask[j] > accum.ask[i]) accum.ask[i] = column.ask[j];
  }
  mergeFlow(accum, column);
}

function mergeFlow(accum, column) {
  if (column.buy === undefined && column.sell === undefined && column.prints === undefined) return;
  accum.flow ??= { buy: new Map(), sell: new Map(), prints: [], printsFloor: 0 };
  for (const side of ["buy", "sell"]) {
    for (const [offset, volume] of column[side] ?? []) {
      const row = column.lo + offset;
      if (row < accum.lo || row > accum.hi) continue;
      accum.flow[side].set(row, (accum.flow[side].get(row) ?? 0) + volume);
    }
  }
  if (column.prints !== undefined) accum.flow.prints.push(...column.prints);
  if (column.printsFloor !== undefined && column.printsFloor > accum.flow.printsFloor) accum.flow.printsFloor = column.printsFloor;
}

function finishFlow(accum, maxPrints) {
  const flow = accum.flow;
  delete accum.flow;
  if (!flow) return accum;
  const entries = (side) => [...flow[side].entries()].sort((a, b) => a[0] - b[0]).map(([row, volume]) => [row - accum.lo, quantizeSize(volume)]);
  const selected = selectPrintsWithFloor(flow.prints, flow.printsFloor, maxPrints);
  return { ...accum, buy: entries("buy"), sell: entries("sell"), prints: selected.prints, printsFloor: selected.floor };
}

function coarsenColumn(column, rows) {
  assertColumn(column);
  if (!Number.isSafeInteger(rows) || rows <= 0) throw new Error("liquidity-history: rows must be a positive safe integer");
  const lo = Math.floor(column.lo / rows);
  const hi = Math.floor(column.hi / rows);
  const span = hi - lo + 1;
  const bid = new Float64Array(span);
  const ask = new Float64Array(span);
  for (let row = column.lo; row <= column.hi; row += 1) {
    const i = Math.floor(row / rows) - lo;
    bid[i] += column.bid[row - column.lo];
    ask[i] += column.ask[row - column.lo];
  }
  for (let i = 0; i < span; i += 1) {
    bid[i] = quantizeSize(bid[i]);
    ask[i] = quantizeSize(ask[i]);
  }
  const out = { ts: column.ts, lo, hi, bid, ask };
  for (const side of ["buy", "sell"]) {
    if (column[side] === undefined) continue;
    const sums = new Map();
    for (const [offset, volume] of column[side]) {
      const i = Math.floor((column.lo + offset) / rows) - lo;
      sums.set(i, (sums.get(i) ?? 0) + volume);
    }
    out[side] = [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([offset, volume]) => [offset, quantizeSize(volume)]);
  }
  return Object.freeze(out);
}

function createDeepFolder({ deepColumnMs, maxPrints = DEFAULT_MAX_PRINTS }) {
  if (!Number.isSafeInteger(deepColumnMs) || deepColumnMs <= 0) {
    throw new Error("liquidity-history: deepColumnMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPrints) || maxPrints <= 0) {
    throw new Error("liquidity-history: maxPrints must be a positive safe integer");
  }
  let accum = null;

  function feed(column) {
    assertColumn(column);
    const windowTs = Math.floor(column.ts / deepColumnMs) * deepColumnMs;
    if (accum && accum.ts === windowTs) {
      mergeMax(accum, column);
      return null;
    }
    const finished = accum;
    accum = { ts: windowTs, lo: column.lo, hi: column.hi, bid: Float64Array.from(column.bid), ask: Float64Array.from(column.ask) };
    mergeFlow(accum, column);
    return finished ? Object.freeze(finishFlow(finished, maxPrints)) : null;
  }

  function flush() {
    const finished = accum;
    accum = null;
    return finished ? Object.freeze(finishFlow(finished, maxPrints)) : null;
  }

  return Object.freeze({
    feed,
    flush,
    get open() {
      return accum ? accum.ts : null;
    },
  });
}

function createLiquidityHistory({ maxColumns = DEFAULT_MAX_COLUMNS, onEvict = null } = {}) {
  if (!Number.isSafeInteger(maxColumns) || maxColumns <= 0) {
    throw new Error("liquidity-history: maxColumns must be a positive safe integer");
  }
  if (onEvict !== null && typeof onEvict !== "function") {
    throw new Error("liquidity-history: onEvict must be a function");
  }
  const columns = []; // oldest first
  let seq = 0; // columns ever appended
  let merges = 0;
  let sideBufferBytes = 0;

  /** Append a column; returns the new `seq`. Columns must be in time order. */
  function push(column) {
    assertColumn(column);
    const last = columns[columns.length - 1];
    if (last && column.ts <= last.ts) {
      throw new Error(`liquidity-history: columns must arrive in time order (got ${column.ts} after ${last.ts})`);
    }
    columns.push(column);
    sideBufferBytes += column.bid.byteLength + column.ask.byteLength;
    if (columns.length > maxColumns) {
      const evicted = columns.shift();
      sideBufferBytes -= evicted.bid.byteLength + evicted.ask.byteLength;
      if (onEvict !== null) onEvict(evicted);
    }
    seq += 1;
    return seq;
  }

  function evictBeyondCap() {
    while (columns.length > maxColumns) {
      const evicted = columns.shift();
      sideBufferBytes -= evicted.bid.byteLength + evicted.ask.byteLength;
      if (onEvict !== null) onEvict(evicted);
    }
  }

  /** Insert columns by time, keeping the ones already held; returns how many were added. `seq` does not move; `merges` counts each merge that added columns. */
  function merge(incoming) {
    if (!Array.isArray(incoming)) throw new Error("liquidity-history: merge needs an array of columns");
    for (const column of incoming) assertColumn(column);
    if (incoming.length === 0) return 0;
    const byTs = new Map();
    for (const column of columns) byTs.set(column.ts, column);
    let added = 0;
    for (const column of incoming) {
      if (byTs.has(column.ts)) continue;
      byTs.set(column.ts, column);
      added += 1;
    }
    if (added === 0) return 0;
    merges += 1;
    const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    columns.length = 0;
    sideBufferBytes = 0;
    for (const column of merged) {
      columns.push(column);
      sideBufferBytes += column.bid.byteLength + column.ask.byteLength;
    }
    evictBeyondCap();
    return added;
  }

  /** Lift `seq` to the retained count, so the next snapshot's first chunk starts at zero; returns `seq`. */
  function rebase() {
    if (seq < columns.length) seq = columns.length;
    return seq;
  }

  function latest() {
    return columns.length === 0 ? null : columns[columns.length - 1];
  }

  function toArray() {
    return columns.slice();
  }

  /**
   * The whole history as wire chunks for a new client: the first column in
   * full, every later one as a delta. Each chunk is `{ columns, seq }` with
   * `seq` the count after its last column, so chunks chain like live frames.
   * An empty history yields one empty chunk (the client still needs the reset).
   */
  function snapshotChunks(chunkSize) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("liquidity-history: chunkSize must be a positive safe integer");
    if (columns.length === 0) return [Object.freeze({ columns: Object.freeze([]), seq })];
    const firstSeq = seq - columns.length; // seq before the oldest retained column
    const chunks = [];
    let prev = null;
    let current = [];
    for (let i = 0; i < columns.length; i += 1) {
      current.push(encodeAfter(prev, columns[i]));
      prev = columns[i];
      if (current.length === chunkSize || i === columns.length - 1) {
        chunks.push(Object.freeze({ columns: Object.freeze(current), seq: firstSeq + i + 1 }));
        current = [];
      }
    }
    return chunks;
  }

  function clear() {
    columns.length = 0;
    seq = 0;
    merges = 0;
    sideBufferBytes = 0;
  }

  return Object.freeze({
    push,
    merge,
    rebase,
    latest,
    toArray,
    snapshotChunks,
    clear,
    get seq() {
      return seq;
    },
    get merges() {
      return merges;
    },
    get length() {
      return columns.length;
    },
    get maxColumns() {
      return maxColumns;
    },
    get sideBufferBytes() {
      return sideBufferBytes;
    },
  });
}

module.exports = { createLiquidityHistory, createDeepFolder, coarsenColumn, encodeColumn, encodeAfter, decodeColumn, sizeAt, DEFAULT_MAX_COLUMNS, DEFAULT_MAX_PRINTS };
