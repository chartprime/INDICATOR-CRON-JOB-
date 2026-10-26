"use strict";

// Passive liquidity sampler: one heatmap column from the memory engine.
//
// The level ledger knows the resting size of every price band it has ever
// seen (thousands per side on Binance). A heatmap column is that book,
// collapsed to coarser price rows and clipped to a window around the mid,
// at one instant. Rows are indexed absolutely (price = row * rowWidth) so a
// column can be compared with the previous one without any anchor.
//
// Sizes are rounded to a few significant digits before they are stored:
// the wire only carries rows that changed, and a row that went from 12.31
// to 12.34 BTC has not changed as far as a colour is concerned.

const DEFAULT_SIZE_DIGITS = 2;

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`liquidity-sampler: ${field} must be a positive safe integer`);
  }
}

/** Row index of a ledger key: `rowClusters` consecutive bands share a row. */
function rowOf(key, rowClusters) {
  return Math.floor(key / rowClusters);
}

/** Round to `digits` significant digits; zero stays zero. */
function quantizeSize(size, digits = DEFAULT_SIZE_DIGITS) {
  if (!(size > 0)) return 0;
  return Number(size.toPrecision(digits));
}

const FOLDS = Object.freeze(["sum", "max"]);
const BIGGEST_ROW_MARKETS = new Set(["FUTURE", "EQUITY"]);

/**
 * How a zoom lane's wider row reads this market's book. A futures or equity
 * band is judged by its biggest tick, so a wider row keeps the biggest tick
 * inside it and a wall reads the same at every zoom; a crypto band sums its
 * rows, so a wider row sums the ticks.
 */
function laneFoldFor(marketKind) {
  return BIGGEST_ROW_MARKETS.has(marketKind) ? "max" : "sum";
}

function accumulate(levels, target, lo, hi, rowClusters, fold) {
  for (const level of levels) {
    if (!(level.size > 0)) continue;
    const row = rowOf(level.key, rowClusters);
    if (row < lo || row > hi) continue;
    if (fold === "max") target[row - lo] = Math.max(target[row - lo], level.size);
    else target[row - lo] += level.size;
  }
}

/**
 * Build one column from a ledger snapshot (`engine.snapshot()`).
 *
 * @param {{ bestBidKey: number|null, bestAskKey: number|null, bids: readonly {key:number,size:number}[], asks: readonly {key:number,size:number}[] }} snapshot
 * @param {object} options
 * @param {number} options.ts           Column time, epoch ms.
 * @param {number} options.rowClusters  Ledger bands per row.
 * @param {number} options.windowRows   Rows kept on each side of the mid row.
 * @param {number} [options.sizeDigits] Significant digits kept per cell.
 * @returns {{ ts: number, lo: number, hi: number, bid: Float64Array, ask: Float64Array } | null}
 *   null when the book has no best price yet (nothing to centre on).
 */
function sampleLiquidityColumn(snapshot, { ts, rowClusters, windowRows, sizeDigits = DEFAULT_SIZE_DIGITS, fold = "sum" }) {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error("liquidity-sampler: ts must be a non-negative safe integer");
  if (!FOLDS.includes(fold)) throw new Error("liquidity-sampler: fold must be sum or max");
  assertPositiveInteger(rowClusters, "rowClusters");
  if (!Number.isSafeInteger(windowRows) || windowRows < 0) throw new Error("liquidity-sampler: windowRows must be a non-negative safe integer");
  assertPositiveInteger(sizeDigits, "sizeDigits");
  const bestBid = snapshot.bestBidKey;
  const bestAsk = snapshot.bestAskKey;
  let midKey;
  if (bestBid !== null && bestBid !== undefined && bestAsk !== null && bestAsk !== undefined) midKey = (bestBid + bestAsk) / 2;
  else midKey = bestBid ?? bestAsk ?? null;
  if (midKey === null || !Number.isFinite(midKey)) return null;
  const midRow = Math.floor(midKey / rowClusters);
  const lo = Math.max(0, midRow - windowRows);
  const hi = midRow + windowRows;
  const span = hi - lo + 1;
  const bid = new Float64Array(span);
  const ask = new Float64Array(span);
  accumulate(snapshot.bids, bid, lo, hi, rowClusters, fold);
  accumulate(snapshot.asks, ask, lo, hi, rowClusters, fold);
  for (let i = 0; i < span; i += 1) {
    bid[i] = quantizeSize(bid[i], sizeDigits);
    ask[i] = quantizeSize(ask[i], sizeDigits);
  }
  return Object.freeze({ ts, lo, hi, bid, ask });
}

module.exports = { sampleLiquidityColumn, quantizeSize, rowOf, laneFoldFor, DEFAULT_SIZE_DIGITS };
