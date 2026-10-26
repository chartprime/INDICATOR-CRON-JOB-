import type { HistoricalResolution } from "./historicalCatalog";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type HistoricalTimeframeBucket = "fixed" | "week" | "month";

export type HistoricalTimeframe = Readonly<{
  id: string;
  label: string;
  sourceResolution: HistoricalResolution;
  intervalMs: number;
  bucket: HistoricalTimeframeBucket;
}>;

export const HISTORICAL_TIMEFRAMES: readonly HistoricalTimeframe[] = Object.freeze([
  Object.freeze({ id: "1m", label: "1m", sourceResolution: "1m", intervalMs: MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "2m", label: "2m", sourceResolution: "1m", intervalMs: 2 * MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "3m", label: "3m", sourceResolution: "1m", intervalMs: 3 * MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "5m", label: "5m", sourceResolution: "1m", intervalMs: 5 * MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "15m", label: "15m", sourceResolution: "1m", intervalMs: 15 * MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "30m", label: "30m", sourceResolution: "1m", intervalMs: 30 * MINUTE_MS, bucket: "fixed" }),
  Object.freeze({ id: "1h", label: "1h", sourceResolution: "1h", intervalMs: HOUR_MS, bucket: "fixed" }),
  Object.freeze({ id: "4h", label: "4h", sourceResolution: "1h", intervalMs: 4 * HOUR_MS, bucket: "fixed" }),
  Object.freeze({ id: "6h", label: "6h", sourceResolution: "1h", intervalMs: 6 * HOUR_MS, bucket: "fixed" }),
  Object.freeze({ id: "12h", label: "12h", sourceResolution: "1h", intervalMs: 12 * HOUR_MS, bucket: "fixed" }),
  Object.freeze({ id: "1D", label: "1D", sourceResolution: "1d", intervalMs: DAY_MS, bucket: "fixed" }),
  Object.freeze({ id: "1W", label: "1W", sourceResolution: "1d", intervalMs: 7 * DAY_MS, bucket: "week" }),
  Object.freeze({ id: "1M", label: "1M", sourceResolution: "1d", intervalMs: 30 * DAY_MS, bucket: "month" }),
]);

export const DEFAULT_HISTORICAL_TIMEFRAME_ID = "1D";

export function historicalTimeframeById(id: string): HistoricalTimeframe {
  const timeframe = HISTORICAL_TIMEFRAMES.find((candidate) => candidate.id === id);
  if (timeframe === undefined) throw new RangeError(`unknown historical timeframe: ${id}`);
  return timeframe;
}
