import type { BarFrame } from "../../../types/frames";
import { equitySessionAt, futureSessionOpenAt } from "../../chart/marketCalendar";
import { ta } from "../../chart/ta";
import { withStreamCreationWindow } from "../../chart/ta/creationGuard";
import { barDelta } from "../barSides";
import type { Divergence } from "../delta-divergence/deltaDivergence";

export const DEFAULT_CVD_PERIOD = 21;
export const MIN_CVD_PERIOD = 1;
export const MAX_CVD_PERIOD = 200;

export const DEFAULT_CVD_PIVOT_PERIODS = 5;
export const MIN_CVD_PIVOT_PERIODS = 1;
export const MAX_CVD_PIVOT_PERIODS = 20;

export const MIN_CVD_PIVOT_DISTANCE = 1;
/**
 * The ceiling both distance settings share, and the bound the clamps guard the
 * detector with.
 */
export const MAX_CVD_PIVOT_DISTANCE = 100;
export const DEFAULT_CVD_MIN_PIVOT_DISTANCE = 5;
export const DEFAULT_CVD_MAX_PIVOT_DISTANCE = 50;
export const DEFAULT_CVD_CUMULATIVE_MAX_PIVOT_DISTANCE = 60;

export const MIN_CVD_SMA_LENGTH = 2;
export const MAX_CVD_SMA_LENGTH = 100;
export const DEFAULT_CVD_SMA_LENGTH = 50;

export interface PivotDistanceRange {
  min: number;
  max: number;
}

export type CvdPivotSource = "cvd" | "price";

export interface DivergenceDetectionOptions {
  requireZeroSide: boolean;
  pivotSource?: CvdPivotSource;
  trendAverage?: readonly (number | null)[];
  trendInverted?: boolean;
  restartsAtEveryGap?: boolean;
}

export type CvdTone = "intenseUp" | "paleUp" | "intenseDown" | "paleDown";

export const CVD_TONE_COLORS: Readonly<Record<CvdTone, string>> = Object.freeze(
  {
    intenseUp: "#22c55e",
    paleUp: "#a7d8b4",
    intenseDown: "#e43535",
    paleDown: "#e5b3b3",
  },
);

export const CVD_TONE_LOOKBACK = 3;

export interface SeriesPivot {
  index: number;
  ts_open: number;
  value: number;
}

export function cvdToneAt(
  values: readonly (number | null)[],
  index: number,
  lookback: number = CVD_TONE_LOOKBACK,
): CvdTone | null {
  const value = values[index];
  if (value === null || index - lookback < 0) return null;
  let sum = 0;
  for (let offset = index - lookback; offset < index; offset += 1) {
    const previous = values[offset];
    if (previous === null) return null;
    sum += previous;
  }
  const rising = value > sum / lookback;
  if (value >= 0) return rising ? "intenseUp" : "paleUp";
  return rising ? "paleDown" : "intenseDown";
}

export function cvdToneColorsFor(
  values: readonly (number | null)[],
  lookback: number = CVD_TONE_LOOKBACK,
): string[] {
  return values.map((_, index) => {
    const tone = cvdToneAt(values, index, lookback);
    if (tone !== null) return CVD_TONE_COLORS[tone];
    return (values[index] ?? 0) >= 0
      ? CVD_TONE_COLORS.intenseUp
      : CVD_TONE_COLORS.intenseDown;
  });
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`cvdDivergence: ${field} must be a positive safe integer`);
  }
}

function assertAlignedInputs(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
): void {
  if (bars.length !== series.length) {
    throw new Error(
      "cvdDivergence: bars and series must have identical lengths",
    );
  }
  for (const value of series) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error("cvdDivergence: series values must be finite or null");
    }
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const INTRADAY_CLOSURE_TOLERANCE_MS = 20 * HOUR_MS;
const DAILY_CLOSURE_TOLERANCE_MS = 3 * DAY_MS;
const SESSION_PROBE_MS = 60_000;

function closureToleranceMs(bar: BarFrame): number {
  if (bar.assetClass === undefined) return 0;
  return bar.interval_ms >= DAY_MS
    ? DAILY_CLOSURE_TOLERANCE_MS
    : INTRADAY_CLOSURE_TOLERANCE_MS;
}

function gapCoversOpenSession(previous: BarFrame, current: BarFrame): boolean {
  for (
    let ts = previous.ts_open + previous.interval_ms;
    ts < current.ts_open;
    ts += SESSION_PROBE_MS
  ) {
    if (current.assetClass === "EQUITY" ? equitySessionAt(ts) === "REGULAR" : futureSessionOpenAt(ts)) return true;
  }
  return false;
}

export function isDataHole(bars: readonly BarFrame[], index: number): boolean {
  const previous = bars[index - 1];
  const current = bars[index];
  if (previous.interval_ms !== current.interval_ms) return true;
  const uncoveredMs =
    current.ts_open - (previous.ts_open + previous.interval_ms);
  if (uncoveredMs < 0) return true;
  if (uncoveredMs > closureToleranceMs(current)) return true;
  if (current.interval_ms < DAY_MS && (current.assetClass === "EQUITY" || current.assetClass === "FUTURE")) {
    return gapCoversOpenSession(previous, current);
  }
  return false;
}

export function rollingDeltaSeries(
  bars: readonly BarFrame[],
  period: number,
): (number | null)[] {
  assertPositiveInteger(period, "period");
  const result: (number | null)[] = new Array(bars.length).fill(null);
  const window = new Float64Array(period);
  let head = 0;
  let filled = 0;
  let sum = 0;

  for (let index = 0; index < bars.length; index += 1) {
    if (index > 0 && isDataHole(bars, index)) {
      head = 0;
      filled = 0;
      sum = 0;
    }
    const delta = barDelta(bars[index]);
    if (delta === null) {
      head = 0;
      filled = 0;
      sum = 0;
      continue;
    }
    if (filled === period) sum -= window[head];
    window[head] = delta;
    sum += delta;
    head = (head + 1) % period;
    if (filled < period) filled += 1;
    result[index] = filled === period ? sum : null;
  }
  return result;
}

export function findSeriesPivots(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
  pivotPeriods: number,
  kind: "high" | "low",
): SeriesPivot[] {
  assertPositiveInteger(pivotPeriods, "pivotPeriods");
  assertAlignedInputs(bars, series);
  const pivots: SeriesPivot[] = [];
  for (
    let index = pivotPeriods;
    index < bars.length - pivotPeriods;
    index += 1
  ) {
    const candidate = bars[index];
    if (!candidate.closed) continue;
    const candidateValue = series[index];
    if (candidateValue === null) continue;
    let isExtreme = true;
    for (
      let offset = index - pivotPeriods;
      offset <= index + pivotPeriods;
      offset += 1
    ) {
      if (offset === index) continue;
      const other = bars[offset];
      const otherValue = series[offset];
      if (
        !other.closed ||
        otherValue === null ||
        (kind === "high"
          ? otherValue >= candidateValue
          : otherValue <= candidateValue)
      ) {
        isExtreme = false;
        break;
      }
    }
    if (isExtreme) {
      pivots.push({ index, ts_open: candidate.ts_open, value: candidateValue });
    }
  }
  return pivots;
}

function isAnyGap(bars: readonly BarFrame[], index: number): boolean {
  const previous = bars[index - 1];
  return bars[index].ts_open !== previous.ts_open + previous.interval_ms;
}

function hasEpochRestartBetween(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
  fromIndex: number,
  toIndex: number,
  restartsAtEveryGap: boolean,
): boolean {
  const restarts = restartsAtEveryGap ? isAnyGap : isDataHole;
  for (let index = fromIndex; index <= toIndex; index += 1) {
    if (series[index] === null || (index > 0 && restarts(bars, index)))
      return true;
  }
  return false;
}

/**
 * The closes price-mode pivots are found on, null wherever the CVD is null or
 * restarts. A close is never null, so without this a pivot's look-around could
 * reach across a data hole (or, for the cumulative CVD, any gap) and judge a
 * bar against prices from another stretch of data: the pair check only guards
 * the span between two pivots, not the bars either side of each. The CVD's own
 * series is null over those bars, so this keeps price mode to the same rule.
 */
function pricePivotSeries(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
  restartsAtEveryGap: boolean,
): (number | null)[] {
  const restarts = restartsAtEveryGap ? isAnyGap : isDataHole;
  return bars.map((bar, index) =>
    series[index] === null || (index > 0 && restarts(bars, index))
      ? null
      : bar.close,
  );
}

function scanPivotPairs(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
  pivots: readonly SeriesPivot[],
  type: "bullish" | "bearish",
  distance: PivotDistanceRange,
  requireZeroSide: boolean,
  trendAverage: readonly (number | null)[] | undefined,
  trendInverted: boolean,
  restartsAtEveryGap: boolean,
  pivotSource: CvdPivotSource,
): Divergence[] {
  const result: Divergence[] = [];
  for (let index = 1; index < pivots.length; index += 1) {
    const from = pivots[index - 1];
    const to = pivots[index];
    if (from.index === to.index) continue;
    const distanceBars = to.index - from.index;
    if (distanceBars < distance.min || distanceBars > distance.max) continue;
    if (
      hasEpochRestartBetween(
        bars,
        series,
        from.index,
        to.index,
        restartsAtEveryGap,
      )
    )
      continue;

    const priceFrom = bars[from.index].close;
    const priceTo = bars[to.index].close;
    // Price mode: pivots come from price and CVD is only read at those bars.
    const cvdFromValue =
      pivotSource === "price" ? series[from.index] : from.value;
    const cvdToValue = pivotSource === "price" ? series[to.index] : to.value;
    if (cvdFromValue === null || cvdToValue === null) continue;
    const priceExtended =
      type === "bearish" ? priceTo > priceFrom : priceTo < priceFrom;
    if (!priceExtended) continue;
    if (requireZeroSide && pivotSource === "cvd") {
      if (type === "bearish") {
        if (cvdFromValue <= 0 || cvdToValue <= 0) continue;
      } else if (cvdFromValue >= 0 || cvdToValue >= 0) {
        continue;
      }
    }
    const oscillatorFailedToConfirm =
      type === "bearish"
        ? cvdToValue <= cvdFromValue
        : cvdToValue >= cvdFromValue;
    if (!oscillatorFailedToConfirm) continue;

    if (
      trendAverage !== undefined &&
      !trendAdmits(
        cvdToValue,
        trendAverage[to.index] ?? null,
        type,
        trendInverted,
      )
    ) {
      continue;
    }

    result.push({
      type,
      priceFrom: { index: from.index, ts_open: from.ts_open, price: priceFrom },
      priceTo: { index: to.index, ts_open: to.ts_open, price: priceTo },
      cvdFrom: {
        index: from.index,
        ts_open: from.ts_open,
        value: cvdFromValue,
      },
      cvdTo: { index: to.index, ts_open: to.ts_open, value: cvdToValue },
      reasons: [],
    });
  }
  return result;
}

export function smaForSeries(
  values: readonly (number | null)[],
  length: number,
): (number | null)[] {
  assertPositiveInteger(length, "smaLength");
  const result: (number | null)[] = new Array(values.length).fill(null);
  return withStreamCreationWindow(() => {
    let stream = ta.sma(length);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === null) {
        stream = ta.sma(length);
        continue;
      }
      result[index] = stream.push(value, false);
    }
    return result;
  });
}

export function trendAdmits(
  value: number | null,
  average: number | null,
  type: "bullish" | "bearish",
  inverted = false,
): boolean {
  if (value === null || average === null) return true;
  const above = value > average;
  const below = value < average;
  const wantsAbove = inverted ? type === "bearish" : type === "bullish";
  return wantsAbove ? above : below;
}

export function detectCvdDivergences(
  bars: readonly BarFrame[],
  series: readonly (number | null)[],
  pivotPeriods: number = DEFAULT_CVD_PIVOT_PERIODS,
  distance: PivotDistanceRange = {
    min: DEFAULT_CVD_MIN_PIVOT_DISTANCE,
    max: DEFAULT_CVD_MAX_PIVOT_DISTANCE,
  },
  options: DivergenceDetectionOptions = { requireZeroSide: true },
): Divergence[] {
  if (
    pivotPeriods < MIN_CVD_PIVOT_PERIODS ||
    pivotPeriods > MAX_CVD_PIVOT_PERIODS
  ) {
    throw new Error(
      `cvdDivergence: pivotPeriods must be between ${MIN_CVD_PIVOT_PERIODS} and ${MAX_CVD_PIVOT_PERIODS}`,
    );
  }
  assertPositiveInteger(distance.min, "minPivotDistance");
  assertPositiveInteger(distance.max, "maxPivotDistance");
  if (distance.min > distance.max) {
    throw new Error(
      "cvdDivergence: minPivotDistance must not exceed maxPivotDistance",
    );
  }
  assertAlignedInputs(bars, series);
  const trendAverage = options.trendAverage;
  if (trendAverage !== undefined && trendAverage.length !== series.length) {
    throw new Error(
      "cvdDivergence: trendAverage must align with the series, index for index",
    );
  }
  const trendInverted = options.trendInverted === true;
  const restartsAtEveryGap = options.restartsAtEveryGap === true;
  const pivotSource = options.pivotSource ?? "cvd";
  const pivotSeries =
    pivotSource === "price"
      ? pricePivotSeries(bars, series, restartsAtEveryGap)
      : series;
  const bearish = scanPivotPairs(
    bars,
    series,
    findSeriesPivots(bars, pivotSeries, pivotPeriods, "high"),
    "bearish",
    distance,
    options.requireZeroSide,
    trendAverage,
    trendInverted,
    restartsAtEveryGap,
    pivotSource,
  );
  const bullish = scanPivotPairs(
    bars,
    series,
    findSeriesPivots(bars, pivotSeries, pivotPeriods, "low"),
    "bullish",
    distance,
    options.requireZeroSide,
    trendAverage,
    trendInverted,
    restartsAtEveryGap,
    pivotSource,
  );
  return [...bearish, ...bullish].sort(
    (a, b) => a.priceTo.index - b.priceTo.index,
  );
}

export function detectCumulativeCvdDivergences(
  bars: readonly BarFrame[],
  cumulative: readonly (number | null)[],
  pivotPeriods: number,
  distance: PivotDistanceRange,
  trendAverage?: readonly (number | null)[],
  trendInverted?: boolean,
  pivotSource: CvdPivotSource = "cvd",
): Divergence[] {
  return detectCvdDivergences(bars, cumulative, pivotPeriods, distance, {
    requireZeroSide: false,
    pivotSource,
    trendAverage,
    trendInverted,
    restartsAtEveryGap: true,
  });
}
