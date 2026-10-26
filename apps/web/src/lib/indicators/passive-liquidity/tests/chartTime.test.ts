import { describe, expect, it } from "vitest";
import { barGaps, chartMsOf, wallMsOf } from "../chartTime";

const T = 1_700_000_000_000;
const M = 60_000;
const bar = (ms: number) => ({ time: ms / 1000 });

describe("chart time on a market with session breaks", () => {
  it("finds the stretches the chart has no bar for: a hole gets one bar of room, the break point the candle series carries, so it starts a bar after the bar before it and a single missing bar is no hole", () => {
    const bars = [bar(T), bar(T + M), bar(T + 2 * M), bar(T + 63 * M), bar(T + 64 * M), bar(T + 3 * 24 * 60 * M)];
    expect(barGaps(bars, M)).toEqual([{ start: T + 4 * M, end: T + 63 * M }, { start: T + 66 * M, end: T + 3 * 24 * 60 * M }]);
    expect(barGaps([bar(T), bar(T + M), bar(T + 2 * M)], M)).toEqual([]);
    expect(barGaps([bar(T), bar(T + 2 * M)], M)).toEqual([]);
    expect(barGaps([bar(T), bar(T + 3 * M)], M)).toEqual([{ start: T + 2 * M, end: T + 3 * M }]);
    expect(barGaps([], M)).toEqual([]);
    expect(barGaps([bar(T), { time: "x" }, bar(T + 5 * M)], M)).toEqual([]);
  });

  it("maps wall time to the chart's time by skipping the holes after it, collapses a time inside a hole to the hole's end, and maps back exactly", () => {
    const gaps = [{ start: T + 4 * M, end: T + 63 * M }, { start: T + 66 * M, end: T + 100 * M }];
    // After every hole: unchanged.
    expect(chartMsOf(T + 100 * M, gaps)).toBe(T + 100 * M);
    expect(chartMsOf(T + 200 * M, gaps)).toBe(T + 200 * M);
    // Between the holes: the later hole is skipped.
    expect(chartMsOf(T + 64 * M, gaps)).toBe(T + 64 * M + 34 * M);
    // Before both: both are skipped, so the bar at T + 2 min sits two bars before the bar at T + 63 min, the break's own slot between.
    expect(chartMsOf(T + 2 * M, gaps)).toBe(T + 2 * M + 59 * M + 34 * M);
    expect(chartMsOf(T + 2 * M, gaps) + 2 * M).toBe(chartMsOf(T + 63 * M, gaps));
    // Inside the break's slot: drawn; inside the hole: the hole's end.
    expect(chartMsOf(T + 3 * M, gaps)).toBe(chartMsOf(T + 2 * M, gaps) + M);
    expect(chartMsOf(T + 30 * M, gaps)).toBe(chartMsOf(T + 63 * M, gaps));
    expect(chartMsOf(T + 70 * M, gaps)).toBe(T + 100 * M);
    for (const ms of [T, T + 2 * M, T + 4 * M - 1, T + 63 * M, T + 64 * M, T + 66 * M - 1, T + 100 * M, T + 500 * M]) expect(wallMsOf(chartMsOf(ms, gaps), gaps)).toBe(ms);
    expect(wallMsOf(chartMsOf(T + 30 * M, gaps), gaps)).toBe(T + 63 * M);
    expect(chartMsOf(T + 5 * M, [])).toBe(T + 5 * M);
    expect(wallMsOf(T + 5 * M, [])).toBe(T + 5 * M);
  });
});
