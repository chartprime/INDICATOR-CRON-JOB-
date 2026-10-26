import { describe, expect, it } from "vitest";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import {
  ARCHIVE_PAGE_ROW_LIMIT,
  HISTORICAL_INITIAL_DISPLAY_BARS,
  HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT,
  HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW,
  historicalWindowAfter,
  historicalWindowBefore,
  initialHistoricalWindow,
  needsHistoricalLogicalPrefetch,
  needsHistoricalPrefetch,
  retainHistoricalDisplayBars,
} from "./historicalRetention";
import { historicalTimeframeById } from "./historicalTimeframes";

function instrument(id: string) {
  const value = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`missing ${id}`);
  return value;
}

describe("historical retention", () => {
  it("starts intraday history with a responsive recent display window and a bounded cursor budget", () => {
    const timeframe = historicalTimeframeById("30m");
    const window = initialHistoricalWindow(instrument("btc-spot"), timeframe);

    expect(window.toMs - window.fromMs).toBe(HISTORICAL_INITIAL_DISPLAY_BARS * timeframe.intervalMs);
    expect(window.maximumPages).toBe(HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW);
    expect(Math.ceil((window.toMs - window.fromMs) / 60_000)).toBeGreaterThan(ARCHIVE_PAGE_ROW_LIMIT);
  });

  it("uses the whole published daily span and never attempts pagination around it", () => {
    const daily = historicalTimeframeById("1D");
    const value = instrument("aapl");
    const window = initialHistoricalWindow(value, daily);

    expect(window).toEqual({
      fromMs: Date.parse(value.availableFrom),
      toMs: Date.parse(value.availableToExclusive),
      maximumPages: 1,
    });
    expect(historicalWindowBefore(value, daily, window.fromMs)).toBeNull();
  });

  it("requests disjoint older and newer display-aligned chunks", () => {
    const value = instrument("btc-spot");
    const timeframe = historicalTimeframeById("5m");
    const initial = initialHistoricalWindow(value, timeframe);
    const older = historicalWindowBefore(value, timeframe, initial.fromMs);
    const newer = historicalWindowAfter(value, timeframe, initial.toMs);

    expect(older?.toMs).toBe(initial.fromMs);
    expect(newer).toBeNull();
    expect(older?.fromMs).toBe(initial.fromMs - HISTORICAL_INITIAL_DISPLAY_BARS * timeframe.intervalMs);
  });

  it("prefetches before the user reaches a loaded edge and retains the active direction at the cap", () => {
    const timeframe = historicalTimeframeById("1h");
    expect(needsHistoricalPrefetch(timeframe, 90 * timeframe.intervalMs, 130 * timeframe.intervalMs, 0, 1_000 * timeframe.intervalMs))
      .toBe("before");
    expect(needsHistoricalPrefetch(timeframe, 800 * timeframe.intervalMs, 950 * timeframe.intervalMs, 0, 1_000 * timeframe.intervalMs))
      .toBe("after");
    expect(needsHistoricalLogicalPrefetch(timeframe, 100, 400)).toBe("before");
    expect(needsHistoricalLogicalPrefetch(timeframe, 400, 100)).toBe("after");
    const bars = Array.from({ length: HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT + 20 }, (_, index) => ({ ts_open: index }));
    expect(retainHistoricalDisplayBars(bars, "before").at(-1)?.ts_open).toBe(HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT - 1);
    expect(retainHistoricalDisplayBars(bars, "after")[0]?.ts_open).toBe(20);
  });
});
