import type { BarFrame } from "../../types/frames";
import {
  historicalBucketOpenMs,
  resampleHistoricalBars,
} from "./historicalResampleBars";
import type { HistoricalTimeframe } from "./historicalTimeframes";

export const HISTORICAL_INDICATOR_CAPABILITIES = [
  "ohlcv",
  "buy_volume",
  "quote_volume",
  "taker_buy_quote_volume",
  "taker_sell_base_volume",
  "taker_sell_quote_volume",
  "trade_count",
  "trade_families",
  "l2_states",
  "l2_walls",
  "l2_prints",
] as const;

export type HistoricalIndicatorCapability =
  (typeof HISTORICAL_INDICATOR_CAPABILITIES)[number];

export type HistoricalCandleMetrics = Readonly<{
  tsOpen: number;
  quoteVolume?: number;
  takerBuyQuoteVolume?: number;
  takerSellBaseVolume?: number;
  takerSellQuoteVolume?: number;
}>;

export type HistoricalIndicatorSeries = Readonly<{
  bars: readonly BarFrame[];
  metrics: readonly HistoricalCandleMetrics[];
  capabilities: readonly HistoricalIndicatorCapability[];
  provider: BarFrame["provider"] | null;
}>;

export class HistoricalIndicatorSeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalIndicatorSeriesError";
  }
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function metricValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HistoricalIndicatorSeriesError("historical indicator metric is outside display range");
  }
  return value;
}

function normaliseMetric(metric: HistoricalCandleMetrics): HistoricalCandleMetrics {
  if (!Number.isSafeInteger(metric.tsOpen)) {
    throw new HistoricalIndicatorSeriesError("historical indicator metric timestamp is invalid");
  }
  const quoteVolume = metricValue(metric.quoteVolume);
  const takerBuyQuoteVolume = metricValue(metric.takerBuyQuoteVolume);
  const takerSellBaseVolume = metricValue(metric.takerSellBaseVolume);
  const takerSellQuoteVolume = metricValue(metric.takerSellQuoteVolume);
  return Object.freeze({
    tsOpen: metric.tsOpen,
    ...(quoteVolume === undefined ? {} : { quoteVolume }),
    ...(takerBuyQuoteVolume === undefined ? {} : { takerBuyQuoteVolume }),
    ...(takerSellBaseVolume === undefined ? {} : { takerSellBaseVolume }),
    ...(takerSellQuoteVolume === undefined ? {} : { takerSellQuoteVolume }),
  });
}

function optionalMetricTotal(
  metrics: readonly HistoricalCandleMetrics[],
  field: keyof Omit<HistoricalCandleMetrics, "tsOpen">,
): number | undefined {
  let total = 0;
  for (const metric of metrics) {
    const value = metric[field];
    if (value === undefined) return undefined;
    total += value;
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new HistoricalIndicatorSeriesError("historical indicator metric aggregate is outside display range");
  }
  return total;
}

function capabilitySet(
  bars: readonly BarFrame[],
  metrics: readonly HistoricalCandleMetrics[],
): readonly HistoricalIndicatorCapability[] {
  if (bars.length === 0) return Object.freeze([]);
  const capabilities: HistoricalIndicatorCapability[] = ["ohlcv"];
  if (bars.every((bar) => hasOwn(bar, "buy_volume"))) capabilities.push("buy_volume");
  if (bars.every((bar) => bar.trade_count !== null)) capabilities.push("trade_count");
  if (metrics.every((metric) => metric.quoteVolume !== undefined)) capabilities.push("quote_volume");
  if (metrics.every((metric) => metric.takerBuyQuoteVolume !== undefined)) capabilities.push("taker_buy_quote_volume");
  if (metrics.every((metric) => metric.takerSellBaseVolume !== undefined)) capabilities.push("taker_sell_base_volume");
  if (metrics.every((metric) => metric.takerSellQuoteVolume !== undefined)) capabilities.push("taker_sell_quote_volume");
  return Object.freeze(capabilities);
}

export function createHistoricalIndicatorSeries(
  bars: readonly BarFrame[],
  metrics: readonly HistoricalCandleMetrics[],
): HistoricalIndicatorSeries {
  if (bars.length !== metrics.length) {
    throw new HistoricalIndicatorSeriesError("historical indicator bars and metrics have different lengths");
  }
  for (let index = 0; index < bars.length; index += 1) {
    if (bars[index].ts_open !== metrics[index].tsOpen) {
      throw new HistoricalIndicatorSeriesError("historical indicator metric does not match its candle");
    }
    if (index > 0 && bars[index - 1].ts_open >= bars[index].ts_open) {
      throw new HistoricalIndicatorSeriesError("historical indicator series is not strictly ordered");
    }
    if (index > 0 && bars[index - 1].provider !== bars[index].provider) {
      throw new HistoricalIndicatorSeriesError("historical indicator series mixes providers");
    }
  }
  const frozenBars = Object.freeze([...bars]);
  const frozenMetrics = Object.freeze(metrics.map(normaliseMetric));
  return Object.freeze({
    bars: frozenBars,
    metrics: frozenMetrics,
    capabilities: capabilitySet(frozenBars, frozenMetrics),
    provider: frozenBars[0]?.provider ?? null,
  });
}

export function resampleHistoricalIndicatorSeries(
  series: HistoricalIndicatorSeries,
  timeframe: HistoricalTimeframe,
): HistoricalIndicatorSeries {
  const bars = resampleHistoricalBars(series.bars, timeframe);
  if (timeframe.intervalMs === (series.bars[0]?.interval_ms ?? timeframe.intervalMs)
      && timeframe.bucket === "fixed") {
    return createHistoricalIndicatorSeries(bars, series.metrics);
  }
  const sourceByBucket = new Map<number, HistoricalCandleMetrics[]>();
  for (const [index, sourceBar] of series.bars.entries()) {
    const bucket = historicalBucketOpenMs(sourceBar.ts_open, timeframe);
    const group = sourceByBucket.get(bucket);
    if (group === undefined) sourceByBucket.set(bucket, [series.metrics[index]]);
    else group.push(series.metrics[index]);
  }
  const metrics = bars.map((bar) => {
    const group = sourceByBucket.get(bar.ts_open);
    if (group === undefined || group.length === 0) {
      throw new HistoricalIndicatorSeriesError("historical indicator aggregate has no source metrics");
    }
    const quoteVolume = optionalMetricTotal(group, "quoteVolume");
    const takerBuyQuoteVolume = optionalMetricTotal(group, "takerBuyQuoteVolume");
    const takerSellBaseVolume = optionalMetricTotal(group, "takerSellBaseVolume");
    const takerSellQuoteVolume = optionalMetricTotal(group, "takerSellQuoteVolume");
    return {
      tsOpen: bar.ts_open,
      ...(quoteVolume === undefined ? {} : { quoteVolume }),
      ...(takerBuyQuoteVolume === undefined ? {} : { takerBuyQuoteVolume }),
      ...(takerSellBaseVolume === undefined ? {} : { takerSellBaseVolume }),
      ...(takerSellQuoteVolume === undefined ? {} : { takerSellQuoteVolume }),
    };
  });
  return createHistoricalIndicatorSeries(bars, metrics);
}

export function mergeHistoricalIndicatorSeries(
  existing: HistoricalIndicatorSeries,
  incoming: HistoricalIndicatorSeries,
  direction: "before" | "after" | "initial",
): HistoricalIndicatorSeries {
  const bars = direction === "initial"
    ? incoming.bars
    : direction === "before"
      ? [...incoming.bars, ...existing.bars]
      : [...existing.bars, ...incoming.bars];
  const metrics = direction === "initial"
    ? incoming.metrics
    : direction === "before"
      ? [...incoming.metrics, ...existing.metrics]
      : [...existing.metrics, ...incoming.metrics];
  for (let index = 1; index < bars.length; index += 1) {
    const prior = bars[index - 1];
    const current = bars[index];
    if (prior.interval_ms !== current.interval_ms || prior.calendar_interval !== current.calendar_interval) {
      throw new HistoricalIndicatorSeriesError("historical pages use incompatible display intervals");
    }
  }
  return createHistoricalIndicatorSeries(bars, metrics);
}

export function retainHistoricalIndicatorSeries(
  series: HistoricalIndicatorSeries,
  direction: "before" | "after" | "initial",
  maximumBars: number,
): HistoricalIndicatorSeries {
  if (!Number.isSafeInteger(maximumBars) || maximumBars < 1) {
    throw new HistoricalIndicatorSeriesError("historical indicator retention limit is invalid");
  }
  if (series.bars.length <= maximumBars || direction === "initial") return series;
  const start = direction === "before" ? 0 : series.bars.length - maximumBars;
  return createHistoricalIndicatorSeries(
    series.bars.slice(start, start + maximumBars),
    series.metrics.slice(start, start + maximumBars),
  );
}
