import type {
  CandlestickData,
  HistogramData,
  LineData,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import { defaultVisibleWindowMs } from "./resampleBars";
import type { CvdCandle } from "../indicators/order-flow/cvdCandles";
import type { BarFrame } from "../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "./candleLifecycle";

export const MAX_CANDLE_SERIES_POINTS = MAX_RETAINED_SOURCE_BARS * 2 - 1;

type LinePoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;
type HistogramPoint =
  | HistogramData<UTCTimestamp>
  | WhitespaceData<UTCTimestamp>;

function assertChartBarSequence(
  bars: readonly BarFrame[],
  operation: string,
): void {
  if (bars.length > MAX_RETAINED_SOURCE_BARS) {
    throw new RangeError(`${operation}: retained bar budget exceeded`);
  }
  for (let index = 1; index < bars.length; index += 1) {
    if (
      bars[index].interval_ms !== bars[0].interval_ms ||
      bars[index].calendar_interval !== bars[0].calendar_interval ||
      bars[index].ts_open <= bars[index - 1].ts_open
    ) {
      throw new Error(
        `${operation}: bars must be strictly chronological and use one interval`,
      );
    }
  }
}

export function barCloseMs(bar: BarFrame): number {
  if (bar.calendar_interval !== "month") return bar.ts_open + bar.interval_ms;
  const date = new Date(bar.ts_open);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function gapBreakTime(
  previous: BarFrame | undefined,
  bar: BarFrame,
): UTCTimestamp | null {
  if (previous === undefined || bar.ts_open === barCloseMs(previous))
    return null;
  return (barCloseMs(previous) / 1000) as UTCTimestamp;
}

function renderableBar(index: number, bars: readonly BarFrame[]): boolean {
  return index === bars.length - 1 || bars[index].closed === true;
}

export type ChartRowsProvider = () => readonly CandlestickData<UTCTimestamp>[];

export function candleBars(bars: readonly BarFrame[]): BarFrame[] {
  return bars.filter((_, index) => renderableBar(index, bars));
}

export function toCandlestick(bar: BarFrame): CandlestickData<UTCTimestamp> {
  return {
    time: (bar.ts_open / 1000) as UTCTimestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

export function appendedBarIsContiguous(
  lastBar: BarFrame | undefined,
  bar: BarFrame,
): boolean {
  return (
    lastBar === undefined ||
    (bar.ts_open === barCloseMs(lastBar) && lastBar.closed === true)
  );
}

export type ChartBarMutation =
  | "APPENDED"
  | "REPLACED_EDGE"
  | "REBUILT"
  | "REJECTED_REOPEN";

export function mergeChartBar(
  bars: BarFrame[],
  bar: BarFrame,
): ChartBarMutation {
  const last = bars[bars.length - 1];
  if (last === undefined || bar.ts_open > last.ts_open) {
    bars.push(bar);
    return "APPENDED";
  }
  if (last.ts_open === bar.ts_open) {
    if (last.closed && !bar.closed) return "REJECTED_REOPEN";
    bars[bars.length - 1] = bar;
    return "REPLACED_EDGE";
  }
  const index = bars.findIndex((candidate) => candidate.ts_open >= bar.ts_open);
  if (bars[index]?.ts_open === bar.ts_open) {
    if (bars[index].closed && !bar.closed) return "REJECTED_REOPEN";
    bars[index] = bar;
  } else {
    bars.splice(index < 0 ? bars.length : index, 0, bar);
  }
  return "REBUILT";
}

export function toCvdCandlestickData(
  bars: readonly BarFrame[],
  candles: readonly (CvdCandle | null)[],
): (CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  if (bars.length !== candles.length) {
    throw new Error(
      "toCvdCandlestickData: bars and candles must have equal length",
    );
  }
  assertChartBarSequence(bars, "toCvdCandlestickData");
  const points: (
    | CandlestickData<UTCTimestamp>
    | WhitespaceData<UTCTimestamp>
  )[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const gapTime = gapBreakTime(bars[index - 1], bar);
    if (gapTime !== null) points.push({ time: gapTime });
    const candle = candles[index];
    const time = (bar.ts_open / 1000) as UTCTimestamp;
    points.push(
      candle === null || !renderableBar(index, bars)
        ? { time }
        : {
            time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          },
    );
  }
  return points;
}

export function toCandlestickSeries(
  bars: readonly BarFrame[],
): (CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  assertChartBarSequence(bars, "toCandlestickSeries");
  const points: (
    | CandlestickData<UTCTimestamp>
    | WhitespaceData<UTCTimestamp>
  )[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const gapTime = gapBreakTime(bars[index - 1], bar);
    if (gapTime !== null) points.push({ time: gapTime });
    points.push(
      renderableBar(index, bars)
        ? toCandlestick(bar)
        : { time: (bar.ts_open / 1000) as UTCTimestamp },
    );
  }
  if (points.length > MAX_CANDLE_SERIES_POINTS)
    throw new RangeError("toCandlestickSeries: chart point budget exceeded");
  return points;
}

export function toLineData(
  bars: readonly BarFrame[],
  computed: readonly (number | null)[],
): LinePoint[] {
  if (bars.length !== computed.length) {
    throw new Error(
      "toLineData: bars and computed values must have equal length",
    );
  }
  assertChartBarSequence(bars, "toLineData");
  const points: LinePoint[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const value = computed[index];
    const time = (bars[index].ts_open / 1000) as UTCTimestamp;
    const gapTime = gapBreakTime(bars[index - 1], bars[index]);
    if (gapTime !== null) points.push({ time: gapTime });
    points.push(
      value === null || !renderableBar(index, bars)
        ? { time }
        : { time, value },
    );
  }
  return points;
}

export function toColoredLineData(
  bars: readonly BarFrame[],
  computed: readonly (number | null)[],
  colors: readonly (string | undefined)[],
): LinePoint[] {
  if (bars.length !== computed.length || bars.length !== colors.length) {
    throw new Error(
      "toColoredLineData: bars, computed values and colors must have equal length",
    );
  }
  assertChartBarSequence(bars, "toColoredLineData");
  const points: LinePoint[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const value = computed[index];
    const time = (bars[index].ts_open / 1000) as UTCTimestamp;
    const gapTime = gapBreakTime(bars[index - 1], bars[index]);
    if (gapTime !== null) points.push({ time: gapTime });
    if (value === null || !renderableBar(index, bars)) {
      points.push({ time });
      continue;
    }
    const color = colors[index];
    points.push(color === undefined ? { time, value } : { time, value, color });
  }
  return points;
}

function median(sortedValues: ArrayLike<number>): number {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? (sortedValues[mid - 1] + sortedValues[mid]) / 2
    : sortedValues[mid];
}

const HISTOGRAM_FALLBACK_THRESHOLD_MULTIPLIER = 4;
const MODIFIED_Z_SCORE_THRESHOLD = 3.5;
const MAD_TO_STD_SCALE = 1.4826;
const MIN_SAMPLES_FOR_ROBUST_THRESHOLD = 20;

export function computeOutlierThreshold(magnitudes: ArrayLike<number>): number {
  if (magnitudes.length === 0) return Infinity;
  const magMedian = median(magnitudes);
  if (magnitudes.length < MIN_SAMPLES_FOR_ROBUST_THRESHOLD) {
    return magMedian * HISTOGRAM_FALLBACK_THRESHOLD_MULTIPLIER;
  }
  const deviations = new Float64Array(magnitudes.length);
  for (let index = 0; index < magnitudes.length; index += 1) {
    deviations[index] = Math.abs(magnitudes[index] - magMedian);
  }
  deviations.sort();
  const mad = median(deviations);
  if (mad === 0) return magMedian * HISTOGRAM_FALLBACK_THRESHOLD_MULTIPLIER;
  return magMedian + MODIFIED_Z_SCORE_THRESHOLD * MAD_TO_STD_SCALE * mad;
}

function compressMagnitude(raw: number, threshold: number): number {
  const magnitude = Math.abs(raw);
  if (!Number.isFinite(threshold) || magnitude <= threshold) return raw;
  return Math.sign(raw) * (threshold + Math.sqrt(magnitude - threshold));
}

export function toHistogramData(
  bars: readonly BarFrame[],
  values: readonly (number | null)[],
  upColor: string,
  downColor: string,
): HistogramPoint[] {
  if (bars.length !== values.length) {
    throw new Error("toHistogramData: bars and values must have equal length");
  }
  const threshold = histogramThreshold(values);
  assertChartBarSequence(bars, "toHistogramData");
  const points: HistogramPoint[] = [];
  bars.forEach((bar, index) => {
    const gapTime = gapBreakTime(bars[index - 1], bar);
    if (gapTime !== null) points.push({ time: gapTime });
    points.push(
      histogramPoint(
        bar,
        renderableBar(index, bars) ? values[index] : null,
        threshold,
        upColor,
        downColor,
      ),
    );
  });
  return points;
}

/**
 * Whether a histogram's outliers are squashed toward the threshold.
 *
 * `compressOutliers` keeps one spike from flattening every other column, which
 * suits a pane whose job is reading relative shape. `none` draws the values as
 * computed -- what a study ported from elsewhere will have been drawn with, and
 * the honest choice when the NUMBER on the pane is meant to be read off the
 * column's own height.
 */
export type HistogramCompression = "compressOutliers" | "none";

/**
 * The same bars `toHistogramData` produces -- identical gap and whitespace
 * handling -- with each bar's colour chosen by index instead of by sign. Used
 * where a bar's shade carries meaning the sign alone cannot express (CVD
 * Divergence's rising/falling tones against the zero line).
 *
 * `colorAt` is consulted only for bars that actually draw, and must return a
 * real colour: a bar whose tone is not yet defined still belongs on the
 * chart, so the caller decides its shade rather than having it vanish.
 */
export function toTonedHistogramData(
  bars: readonly BarFrame[],
  values: readonly (number | null)[],
  colorAt: (index: number) => string,
  compression: HistogramCompression = "compressOutliers",
): HistogramPoint[] {
  if (bars.length !== values.length) {
    throw new Error(
      "toTonedHistogramData: bars and values must have equal length",
    );
  }
  const threshold =
    compression === "none" ? Infinity : histogramThreshold(values);
  assertChartBarSequence(bars, "toTonedHistogramData");
  const points: HistogramPoint[] = [];
  bars.forEach((bar, index) => {
    const gapTime = gapBreakTime(bars[index - 1], bar);
    if (gapTime !== null) points.push({ time: gapTime });
    const raw = renderableBar(index, bars) ? values[index] : null;
    if (raw === null) {
      points.push({ time: (bar.ts_open / 1000) as UTCTimestamp });
      return;
    }
    points.push({
      time: (bar.ts_open / 1000) as UTCTimestamp,
      value: compressMagnitude(raw, threshold),
      color: colorAt(index),
    });
  });
  return points;
}

export function histogramThreshold(values: readonly (number | null)[]): number {
  const scratch = new Float64Array(values.length);
  let magnitudeCount = 0;
  for (const value of values) {
    if (value === null) continue;
    const magnitude = Math.abs(value);
    if (magnitude > 0) scratch[magnitudeCount++] = magnitude;
  }
  return computeOutlierThreshold(scratch.subarray(0, magnitudeCount).sort());
}

export function histogramPoint(
  bar: BarFrame,
  raw: number | null,
  threshold: number,
  upColor: string,
  downColor: string,
): HistogramPoint {
  if (raw === null) return { time: (bar.ts_open / 1000) as UTCTimestamp };
  const compressed = compressMagnitude(raw, threshold);
  return {
    time: (bar.ts_open / 1000) as UTCTimestamp,
    value: compressed,
    color: compressed >= 0 ? upColor : downColor,
  };
}

export function enclosingBarTimeSec(
  tsExchange: number,
  intervalMs: number,
): UTCTimestamp {
  const enclosingOpenMs = Math.floor(tsExchange / intervalMs) * intervalMs;
  return (enclosingOpenMs / 1000) as UTCTimestamp;
}

export function defaultVisibleRange(lastBar: BarFrame): {
  from: UTCTimestamp;
  to: UTCTimestamp;
} {
  const lastCloseMs = barCloseMs(lastBar);
  const windowMs = defaultVisibleWindowMs(lastBar.interval_ms);
  return {
    from: (Math.max(0, lastCloseMs - windowMs) / 1000) as UTCTimestamp,
    to: (lastCloseMs / 1000) as UTCTimestamp,
  };
}

export function preserveVisibleRange(
  range: { from: number; to: number } | null,
  bars: readonly BarFrame[],
): { from: UTCTimestamp; to: UTCTimestamp } | null {
  if (
    range === null ||
    bars.length === 0 ||
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to) ||
    range.to <= range.from
  ) {
    return null;
  }
  const first = bars[0].ts_open / 1000;
  const last = barCloseMs(bars[bars.length - 1]) / 1000;
  const availableWidth = last - first;
  const requestedWidth = range.to - range.from;
  if (requestedWidth >= availableWidth)
    return { from: first as UTCTimestamp, to: last as UTCTimestamp };
  if (range.from < first)
    return {
      from: first as UTCTimestamp,
      to: (first + requestedWidth) as UTCTimestamp,
    };
  if (range.to > last)
    return {
      from: (last - requestedWidth) as UTCTimestamp,
      to: last as UTCTimestamp,
    };
  return { from: range.from as UTCTimestamp, to: range.to as UTCTimestamp };
}
