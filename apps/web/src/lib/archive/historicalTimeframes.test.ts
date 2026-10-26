import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORICAL_TIMEFRAME_ID,
  HISTORICAL_TIMEFRAMES,
  historicalTimeframeById,
} from "./historicalTimeframes";

describe("historical timeframes", () => {
  it("maps each display interval to exactly one published source rung", () => {
    expect(HISTORICAL_TIMEFRAMES.map((timeframe) => [timeframe.id, timeframe.sourceResolution])).toEqual([
      ["1m", "1m"], ["2m", "1m"], ["3m", "1m"], ["5m", "1m"], ["15m", "1m"], ["30m", "1m"],
      ["1h", "1h"], ["4h", "1h"], ["6h", "1h"], ["12h", "1h"],
      ["1D", "1d"], ["1W", "1d"], ["1M", "1d"],
    ]);
  });

  it("models a month as a calendar bucket and keeps the daily display default", () => {
    expect(historicalTimeframeById("1M")).toMatchObject({ sourceResolution: "1d", bucket: "month" });
    expect(historicalTimeframeById(DEFAULT_HISTORICAL_TIMEFRAME_ID)).toMatchObject({ id: "1D", sourceResolution: "1d" });
  });

  it("refuses an unknown display interval instead of silently choosing a source rung", () => {
    expect(() => historicalTimeframeById("13m")).toThrow("unknown historical timeframe");
  });
});
