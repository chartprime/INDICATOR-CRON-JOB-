import type { TradeFrame } from "../../../types/frames";

/**
 * Reference implementations for the Size-Split Delta build
 * (`pm/cycle2/brief-size-split-delta.md`), written before the indicator and
 * kept independent of it: plain arrays, whole-series passes, no rings, no
 * incremental state. The indicator's tests derive their expected numbers from
 * here (the tier, the per-bar contributions, every arrow, every conflict
 * onset, the confirmation state), so a disagreement is a finding about the
 * indicator, never about a number someone pinned after seeing it.
 */

export const SIZE_SPLIT_REFERENCE_QUANTILE = 0.98;

/** Nearest-rank quantile: the value at index `ceil(q · n) - 1` of the ascending sort; null for no values. */
export function referenceNearestRank(values: readonly number[], quantile = SIZE_SPLIT_REFERENCE_QUANTILE): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

export function referenceValidPrint(print: Pick<TradeFrame, "price" | "size">): boolean {
  return Number.isFinite(print.price) && print.price > 0 && Number.isFinite(print.size) && print.size > 0;
}

export interface ReferenceContribution {
  /** Null when no threshold exists (nothing is classified), otherwise the signed large-tier size sum. */
  largeBar: number | null;
  smallBar: number | null;
  tapeVolume: number;
  /** Every valid size in the window, in time order: what trains the threshold. */
  sizes: number[];
  count: number;
}

/**
 * The window's contribution: prints with `ts_exchange` in `[fromTs, toTs)`,
 * invalid sizes and prices skipped, `size >= threshold` classified large with
 * the boundary print included, buys positive.
 */
export function referenceClassify(prints: readonly TradeFrame[], fromTs: number, toTs: number, threshold: number | null): ReferenceContribution {
  let largeBar = 0;
  let smallBar = 0;
  let tapeVolume = 0;
  const sizes: number[] = [];
  for (const print of prints) {
    if (print.ts_exchange < fromTs || print.ts_exchange >= toTs) continue;
    if (!referenceValidPrint(print)) continue;
    sizes.push(print.size);
    tapeVolume += print.size;
    if (threshold === null) continue;
    const signed = print.side === "buy" ? print.size : -print.size;
    if (print.size >= threshold) largeBar += signed;
    else smallBar += signed;
  }
  return { largeBar: threshold === null ? null : largeBar, smallBar: threshold === null ? null : smallBar, tapeVolume, sizes, count: sizes.length };
}

/** One committed bar as the marker rules see it; `largeBar === null` marks a bar without a value (a gap). */
export interface ReferenceBar {
  close: number;
  largeBar: number | null;
  smallBar: number | null;
}

export type ReferenceState = "confirms" | "lags" | "noExtreme";

export interface ReferenceMarkerResult {
  /** Cumulative large-tier delta over valid bars with no anchor reset (`anchor: tape`); null on an invalid bar. */
  large: (number | null)[];
  small: (number | null)[];
  /** Bars where the bearish arrow (`arrowDown`) fires. */
  bearish: number[];
  /** Bars where the bullish arrow (`arrowUp`) fires. */
  bullish: number[];
  /** Bars where the tier-conflict condition turns on. */
  conflictOnsets: number[];
  /** Bars where the conflict condition holds (onset or continuing). */
  conflictHolds: number[];
  /** The confirmation state of every bar that has a full ring; null elsewhere. */
  state: (ReferenceState | null)[];
  /** `large_t - large_h` for a bearish arrow, `large_t - large_l` for a bullish one; null elsewhere. */
  depth: (number | null)[];
  /** Bars with exactly `K` valid bars immediately before them and a value of their own. */
  evaluated: number[];
}

export interface ReferenceMarkerOptions {
  K: number;
  m: number;
  q: number;
}

/**
 * The divergence, confirmation and conflict rules of the brief (rule 11 and
 * amendment 2) applied to a finished series: the ring is the `K` consecutive
 * valid bars immediately before `t`, means exclude `t`, an invalid bar breaks
 * the run, `h` is the ring bar with the highest close (latest if tied) and
 * `l` the one with the lowest; extremes are strict; the conflict onset needs
 * the previous bar in the same run to have held no conflict.
 */
export function referenceMarkers(bars: readonly ReferenceBar[], options: ReferenceMarkerOptions): ReferenceMarkerResult {
  const { K, m, q } = options;
  const large: (number | null)[] = [];
  const small: (number | null)[] = [];
  const bearish: number[] = [];
  const bullish: number[] = [];
  const conflictOnsets: number[] = [];
  const conflictHolds: number[] = [];
  const state: (ReferenceState | null)[] = [];
  const depth: (number | null)[] = [];
  const evaluated: number[] = [];
  let cumulativeLarge = 0;
  let cumulativeSmall = 0;
  let run = 0;
  let previousConflict = false;
  for (let t = 0; t < bars.length; t += 1) {
    const bar = bars[t];
    if (bar.largeBar === null || bar.smallBar === null) {
      large.push(null);
      small.push(null);
      state.push(null);
      depth.push(null);
      run = 0;
      previousConflict = false;
      continue;
    }
    cumulativeLarge += bar.largeBar;
    cumulativeSmall += bar.smallBar;
    large.push(cumulativeLarge);
    small.push(cumulativeSmall);
    if (run < K) {
      state.push(null);
      depth.push(null);
      run += 1;
      previousConflict = false;
      continue;
    }
    evaluated.push(t);
    let h = t - K;
    let l = t - K;
    let sumAbsLarge = 0;
    let sumAbsSmall = 0;
    let sumLarge = bar.largeBar;
    let sumSmall = bar.smallBar;
    for (let i = t - K; i < t; i += 1) {
      const ring = bars[i];
      if (ring.close >= bars[h].close) h = i;
      if (ring.close <= bars[l].close) l = i;
      sumAbsLarge += Math.abs(ring.largeBar as number);
      sumAbsSmall += Math.abs(ring.smallBar as number);
      sumLarge += ring.largeBar as number;
      sumSmall += ring.smallBar as number;
    }
    const mabsL = sumAbsLarge / K;
    const mabsS = sumAbsSmall / K;
    const largeT = cumulativeLarge;
    const largeH = large[h] as number;
    const largeL = large[l] as number;
    let barState: ReferenceState = "noExtreme";
    let barDepth: number | null = null;
    if (bar.close > bars[h].close) {
      barState = largeT > largeH ? "confirms" : "lags";
      if (largeT <= largeH - m * mabsL) {
        bearish.push(t);
        barDepth = largeT - largeH;
      }
    } else if (bar.close < bars[l].close) {
      barState = largeT < largeL ? "confirms" : "lags";
      if (largeT >= largeL + m * mabsL) {
        bullish.push(t);
        barDepth = largeT - largeL;
      }
    }
    state.push(barState);
    depth.push(barDepth);
    const strength = q * Math.sqrt(K + 1);
    const conflict = Math.sign(sumLarge) * Math.sign(sumSmall) < 0 && Math.abs(sumLarge) >= strength * mabsL && Math.abs(sumSmall) >= strength * mabsS;
    if (conflict) {
      conflictHolds.push(t);
      if (!previousConflict) conflictOnsets.push(t);
    }
    previousConflict = conflict;
    run += 1;
  }
  return { large, small, bearish, bullish, conflictOnsets, conflictHolds, state, depth, evaluated };
}

/** Planted-event recall and off-label arrows: hits are arrows on a planted bar exactly, in the planted direction. */
export interface ReferenceScore {
  planted: number;
  hits: number;
  /** Arrows on bars that are not planted (both directions). */
  offLabel: number;
  /** Planted bars inside the evaluation mask (the only ones that can be hit). */
  plantedEvaluable: number;
}

export function referenceScore(
  arrows: { bearish: readonly number[]; bullish: readonly number[] },
  planted: readonly number[],
  direction: readonly (1 | -1)[],
  mask: ReadonlySet<number>,
): ReferenceScore {
  const bearish = new Set(arrows.bearish.filter((index) => mask.has(index)));
  const bullish = new Set(arrows.bullish.filter((index) => mask.has(index)));
  let hits = 0;
  let plantedEvaluable = 0;
  const plantedSet = new Set(planted);
  planted.forEach((index, position) => {
    if (!mask.has(index)) return;
    plantedEvaluable += 1;
    // A planted bar in an up regime (direction +1) is a bearish divergence: price up, large prints opposing.
    if (direction[position] > 0 ? bearish.has(index) : bullish.has(index)) hits += 1;
  });
  let offLabel = 0;
  for (const index of bearish) if (!plantedSet.has(index) || direction[planted.indexOf(index)] < 0) offLabel += 1;
  for (const index of bullish) if (!plantedSet.has(index) || direction[planted.indexOf(index)] > 0) offLabel += 1;
  return { planted: planted.length, hits, offLabel, plantedEvaluable };
}
