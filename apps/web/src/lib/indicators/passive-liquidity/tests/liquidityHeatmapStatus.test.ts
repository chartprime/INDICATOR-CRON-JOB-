// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { heatmapStatusText } from "../liquidityHeatmapPrimitive";
import type { HeatmapHistoryInfo } from "../liquidityHeatmapLayout";

const base: HeatmapHistoryInfo = { levelMs: 60_000, rowFactor: 1, days: 1, loading: false, reachTs: null, drawn: false, refused: null, unavailable: null };

describe("the heatmap's status badge", () => {
  it("names the reach while it loads, says so when the host refuses, and shows nothing once the history is drawn", () => {
    expect(heatmapStatusText(null)).toBeNull();
    expect(heatmapStatusText({ ...base, loading: true })).toBe("HEATMAP · LOADING 1 DAY");
    expect(heatmapStatusText({ ...base, loading: true, days: 7 })).toBe("HEATMAP · LOADING 1 WEEK");
    expect(heatmapStatusText({ ...base, loading: true, days: 5, drawn: true })).toBe("HEATMAP · LOADING 5 DAYS");
    expect(heatmapStatusText({ ...base, unavailable: "NO_PYRAMID" })).toBe("HEATMAP · HISTORY UNAVAILABLE");
    expect(heatmapStatusText({ ...base, drawn: true, reachTs: 1 })).toBeNull();
    expect(heatmapStatusText({ ...base, drawn: true, unavailable: "NO_PYRAMID" })).toBeNull();
  });
});
