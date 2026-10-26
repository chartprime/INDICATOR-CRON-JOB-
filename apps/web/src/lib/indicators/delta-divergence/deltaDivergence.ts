import type { BarFrame } from "../../../types/frames";

export interface SwingPoint {
  index: number;
  ts_open: number;
  price: number;
}

export interface CvdPoint {
  index: number;
  ts_open: number;
  value: number;
}

export type DivergenceType = "bullish" | "bearish";

export type DivergenceQualificationReason =
  | "CONFIRMED_CLOSE_SWINGS"
  | "SAME_CVD_EPOCH"
  | "CVD_ALIGNED_WITHIN_TOLERANCE"
  | "PRICE_HIGHER_HIGH"
  | "PRICE_LOWER_LOW"
  | "CVD_LOWER_OR_EQUAL_HIGH"
  | "CVD_HIGHER_OR_EQUAL_LOW";

export interface Divergence {
  type: DivergenceType;
  priceFrom: SwingPoint;
  priceTo: SwingPoint;
  cvdFrom: CvdPoint;
  cvdTo: CvdPoint;
  reasons: readonly DivergenceQualificationReason[];
}

export const DEFAULT_SWING_LENGTH = 3;
export const MIN_SWING_LENGTH = 2;
export const MAX_SWING_LENGTH = 8;
const MAX_CVD_ALIGNMENT_TOLERANCE_BARS = 3;

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`deltaDivergence: ${field} must be a positive safe integer`);
  }
}

function assertAlignedInputs(
  bars: readonly BarFrame[],
  deltaPerBar: readonly (number | null)[],
  cvd: readonly (number | null)[],
): void {
  if (bars.length !== deltaPerBar.length || bars.length !== cvd.length) {
    throw new Error("deltaDivergence: bars, deltaPerBar, and cvd must have identical lengths");
  }
  for (let i = 0; i < bars.length; i += 1) {
    if (deltaPerBar[i] !== null && !Number.isFinite(deltaPerBar[i])) {
      throw new Error("deltaDivergence: deltaPerBar values must be finite or null");
    }
    if (cvd[i] !== null && !Number.isFinite(cvd[i])) {
      throw new Error("deltaDivergence: cvd values must be finite or null");
    }
  }
}

export function cvdAlignmentToleranceBars(swingLength: number): number {
  assertPositiveInteger(swingLength, "swingLength");
  return Math.min(MAX_CVD_ALIGNMENT_TOLERANCE_BARS, Math.max(1, Math.floor(swingLength / 2)));
}

function findSwingPoints(bars: readonly BarFrame[], swingLength: number, kind: "high" | "low"): SwingPoint[] {
  assertPositiveInteger(swingLength, "swingLength");
  const points: SwingPoint[] = [];
  for (let i = swingLength; i < bars.length - swingLength; i += 1) {
    const candidate = bars[i];
    if (!candidate.closed) continue;
    const candidatePrice = candidate.close;
    let isExtreme = true;
    for (let j = i - swingLength; j <= i + swingLength; j += 1) {
      if (j === i) continue;
      const other = bars[j];
      if (!other.closed || (kind === "high" ? other.close >= candidatePrice : other.close <= candidatePrice)) {
        isExtreme = false;
        break;
      }
    }
    if (isExtreme) points.push({ index: i, ts_open: candidate.ts_open, price: candidatePrice });
  }
  return points;
}

export function findSwingHighs(bars: readonly BarFrame[], swingLength: number): SwingPoint[] {
  return findSwingPoints(bars, swingLength, "high");
}

export function findSwingLows(bars: readonly BarFrame[], swingLength: number): SwingPoint[] {
  return findSwingPoints(bars, swingLength, "low");
}

function isContiguousWithPrevious(bars: readonly BarFrame[], index: number): boolean {
  return index === 0 || bars[index].ts_open === bars[index - 1].ts_open + bars[index - 1].interval_ms;
}

function hasEpochRestartBetween(
  bars: readonly BarFrame[],
  deltaPerBar: readonly (number | null)[],
  fromIndex: number,
  toIndex: number,
): boolean {
  for (let i = fromIndex; i <= toIndex; i += 1) {
    if (deltaPerBar[i] === null || !isContiguousWithPrevious(bars, i)) return true;
  }
  return false;
}

function isBetterCvdCandidate(
  candidate: CvdPoint,
  best: CvdPoint | null,
  anchorIndex: number,
  kind: "high" | "low",
): boolean {
  if (best === null) return true;
  if (kind === "high" && candidate.value !== best.value) return candidate.value > best.value;
  if (kind === "low" && candidate.value !== best.value) return candidate.value < best.value;
  const candidateDistance = Math.abs(candidate.index - anchorIndex);
  const bestDistance = Math.abs(best.index - anchorIndex);
  return candidateDistance < bestDistance || (candidateDistance === bestDistance && candidate.index < best.index);
}

function nearbyCvdExtreme(
  bars: readonly BarFrame[],
  deltaPerBar: readonly (number | null)[],
  cvd: readonly (number | null)[],
  anchorIndex: number,
  kind: "high" | "low",
  toleranceBars: number,
): CvdPoint | null {
  const start = Math.max(0, anchorIndex - toleranceBars);
  const end = Math.min(bars.length - 1, anchorIndex + toleranceBars);
  let best: CvdPoint | null = null;
  for (let i = start; i <= end; i += 1) {
    const value = cvd[i];
    if (!isContiguousWithPrevious(bars, i) || !bars[i].closed || deltaPerBar[i] === null || value === null) return null;
    const candidate: CvdPoint = { index: i, ts_open: bars[i].ts_open, value };
    if (isBetterCvdCandidate(candidate, best, anchorIndex, kind)) best = candidate;
  }
  return best;
}

function scanPriceSwings(
  bars: readonly BarFrame[],
  swings: readonly SwingPoint[],
  type: DivergenceType,
  deltaPerBar: readonly (number | null)[],
  cvd: readonly (number | null)[],
  toleranceBars: number,
): Divergence[] {
  const cvdKind = type === "bearish" ? "high" : "low";
  const result: Divergence[] = [];
  for (let i = 1; i < swings.length; i += 1) {
    const priceFrom = swings[i - 1];
    const priceTo = swings[i];
    const priceExtended = type === "bearish"
      ? priceTo.price > priceFrom.price
      : priceTo.price < priceFrom.price;
    if (!priceExtended || hasEpochRestartBetween(bars, deltaPerBar, priceFrom.index, priceTo.index)) continue;

    const cvdFrom = nearbyCvdExtreme(bars, deltaPerBar, cvd, priceFrom.index, cvdKind, toleranceBars);
    const cvdTo = nearbyCvdExtreme(bars, deltaPerBar, cvd, priceTo.index, cvdKind, toleranceBars);
    if (cvdFrom === null || cvdTo === null || cvdFrom.index === cvdTo.index) continue;

    const cvdFailedToConfirm = type === "bearish"
      ? cvdTo.value <= cvdFrom.value
      : cvdTo.value >= cvdFrom.value;
    if (cvdFailedToConfirm) {
      result.push({
        type,
        priceFrom,
        priceTo,
        cvdFrom,
        cvdTo,
        reasons: type === "bearish"
          ? ["CONFIRMED_CLOSE_SWINGS", "SAME_CVD_EPOCH", "CVD_ALIGNED_WITHIN_TOLERANCE", "PRICE_HIGHER_HIGH", "CVD_LOWER_OR_EQUAL_HIGH"]
          : ["CONFIRMED_CLOSE_SWINGS", "SAME_CVD_EPOCH", "CVD_ALIGNED_WITHIN_TOLERANCE", "PRICE_LOWER_LOW", "CVD_HIGHER_OR_EQUAL_LOW"],
      });
    }
  }
  return result;
}

export function detectDivergences(
  bars: readonly BarFrame[],
  deltaPerBar: readonly (number | null)[],
  cvd: readonly (number | null)[],
  swingLength: number = DEFAULT_SWING_LENGTH,
): Divergence[] {
  assertPositiveInteger(swingLength, "swingLength");
  if (swingLength < MIN_SWING_LENGTH || swingLength > MAX_SWING_LENGTH) {
    throw new Error(
      `deltaDivergence: swingLength must be between ${MIN_SWING_LENGTH} and ${MAX_SWING_LENGTH}`,
    );
  }
  assertAlignedInputs(bars, deltaPerBar, cvd);
  const toleranceBars = cvdAlignmentToleranceBars(swingLength);
  const bearish = scanPriceSwings(bars, findSwingHighs(bars, swingLength), "bearish", deltaPerBar, cvd, toleranceBars);
  const bullish = scanPriceSwings(bars, findSwingLows(bars, swingLength), "bullish", deltaPerBar, cvd, toleranceBars);
  return [...bearish, ...bullish].sort((a, b) => a.priceTo.index - b.priceTo.index);
}
