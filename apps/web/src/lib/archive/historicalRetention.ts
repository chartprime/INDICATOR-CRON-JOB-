import { ARCHIVE_QUERY_LIMIT, type HistoricalInstrument } from "./historicalCatalog";
import type { HistoricalTimeframe } from "./historicalTimeframes";

export const ARCHIVE_PAGE_ROW_LIMIT = ARCHIVE_QUERY_LIMIT;
export const HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW = 4;
export const HISTORICAL_INITIAL_DISPLAY_BARS = 500;
export const HISTORICAL_PREFETCH_DISPLAY_BARS = 100;
export const HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT = 5_000;

export type HistoricalWindow = Readonly<{
  fromMs: number;
  toMs: number;
  maximumPages: number;
}>;

function availability(instrument: HistoricalInstrument): Readonly<{ fromMs: number; toMs: number }> {
  const fromMs = Date.parse(instrument.availableFrom);
  const toMs = Date.parse(instrument.availableToExclusive);
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs) {
    throw new RangeError("historical instrument has invalid availability");
  }
  return { fromMs, toMs };
}

function fixedBucketOpen(timestampMs: number, intervalMs: number): number {
  return Math.floor(timestampMs / intervalMs) * intervalMs;
}

function boundedWindow(
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  fromMs: number,
  toMs: number,
): HistoricalWindow | null {
  const available = availability(instrument);
  const from = Math.max(available.fromMs, fromMs);
  const to = Math.min(available.toMs, toMs);
  if (from >= to) return null;
  return Object.freeze({
    fromMs: from,
    toMs: to,
    maximumPages: isUncappedHistoricalTimeframe(timeframe)
      ? 1
      : HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW,
  });
}

export function isUncappedHistoricalTimeframe(timeframe: HistoricalTimeframe): boolean {
  return timeframe.sourceResolution === "1d";
}

export function initialHistoricalWindow(
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
): HistoricalWindow {
  const available = availability(instrument);
  if (isUncappedHistoricalTimeframe(timeframe)) {
    return Object.freeze({ fromMs: available.fromMs, toMs: available.toMs, maximumPages: 1 });
  }
  const end = fixedBucketOpen(available.toMs - 1, timeframe.intervalMs) + timeframe.intervalMs;
  const start = end - HISTORICAL_INITIAL_DISPLAY_BARS * timeframe.intervalMs;
  const window = boundedWindow(instrument, timeframe, start, end);
  if (window === null) throw new RangeError("historical instrument has no initial archive window");
  return window;
}

export function historicalWindowBefore(
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  firstDisplayOpenMs: number,
): HistoricalWindow | null {
  if (isUncappedHistoricalTimeframe(timeframe)) return null;
  const end = fixedBucketOpen(firstDisplayOpenMs, timeframe.intervalMs);
  return boundedWindow(
    instrument,
    timeframe,
    end - HISTORICAL_INITIAL_DISPLAY_BARS * timeframe.intervalMs,
    end,
  );
}

export function historicalWindowAfter(
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  lastDisplayCloseMs: number,
): HistoricalWindow | null {
  if (isUncappedHistoricalTimeframe(timeframe)) return null;
  const start = fixedBucketOpen(lastDisplayCloseMs, timeframe.intervalMs);
  return boundedWindow(
    instrument,
    timeframe,
    start,
    start + HISTORICAL_INITIAL_DISPLAY_BARS * timeframe.intervalMs,
  );
}

export function needsHistoricalPrefetch(
  timeframe: HistoricalTimeframe,
  visibleFromMs: number,
  visibleToMs: number,
  firstDisplayOpenMs: number,
  lastDisplayCloseMs: number,
): "before" | "after" | null {
  if (isUncappedHistoricalTimeframe(timeframe)) return null;
  const marginMs = HISTORICAL_PREFETCH_DISPLAY_BARS * timeframe.intervalMs;
  if (visibleFromMs <= firstDisplayOpenMs + marginMs) return "before";
  if (visibleToMs >= lastDisplayCloseMs - marginMs) return "after";
  return null;
}

export function needsHistoricalLogicalPrefetch(
  timeframe: HistoricalTimeframe,
  barsBefore: number,
  barsAfter: number,
): "before" | "after" | null {
  if (isUncappedHistoricalTimeframe(timeframe)) return null;
  if (!Number.isFinite(barsBefore) || !Number.isFinite(barsAfter)) return null;
  if (barsBefore <= HISTORICAL_PREFETCH_DISPLAY_BARS) return "before";
  if (barsAfter <= HISTORICAL_PREFETCH_DISPLAY_BARS) return "after";
  return null;
}

export function retainHistoricalDisplayBars<T extends { ts_open: number }>(
  bars: readonly T[],
  direction: "before" | "after" | "initial",
): readonly T[] {
  if (bars.length <= HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT || direction === "initial") return bars;
  return direction === "before"
    ? bars.slice(0, HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT)
    : bars.slice(-HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT);
}
