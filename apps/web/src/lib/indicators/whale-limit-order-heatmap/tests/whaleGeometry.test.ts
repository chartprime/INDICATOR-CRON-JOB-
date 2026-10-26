// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ChartTimeGeometry } from "../../l2-book-map/l2BookMapPrimitive";
import { OUTCOME_ALPHA, bandAlpha, bandColor, bandThickness, nearestWalls, pickLabelRows, timeToX, xToTime } from "../whaleGeometry";

const T = 1_790_000_000_000;
const MINUTE = 60_000;

function geometry(opens: number[], lastCenterX = 200, barSpacing = 10): ChartTimeGeometry {
  return { originX: lastCenterX - barSpacing / 2, barSpacing, intervalMs: MINUTE, barOpensMs: opens };
}

const FIVE = geometry([0, 1, 2, 3, 4].map((index) => T + index * MINUTE));

describe("whale geometry: where a time falls on the chart, and which time a position is", () => {
  it("puts a bar's open at its left edge and moves ten pixels per bar", () => {
    expect(timeToX(T, FIVE)).toBe(155);
    expect(timeToX(T + 4 * MINUTE, FIVE)).toBe(195);
    expect(timeToX(T + 4 * MINUTE + 30_000, FIVE)).toBe(200);
    expect(timeToX(T + 2 * MINUTE + 15_000, FIVE)).toBe(177.5);
  });

  it("carries on at the same pace past the last bar and before the first, so a wall can run forward or begin off the left edge", () => {
    expect(timeToX(T + 6 * MINUTE, FIVE)).toBe(215);
    expect(timeToX(T + 4 * MINUTE + 10 * 60_000, FIVE)).toBe(295);
    expect(timeToX(T - MINUTE, FIVE)).toBe(145);
    expect(timeToX(T - 10 * MINUTE, FIVE)).toBe(55);
  });

  it("stops at the edge of a bar for a time inside a gap of missing bars, like the chart's own slots", () => {
    const gapped = geometry([T, T + MINUTE, T + 2 * MINUTE, T + 5 * MINUTE, T + 6 * MINUTE]);
    expect(timeToX(T + 2 * MINUTE, gapped)).toBe(175);
    expect(timeToX(T + 3 * MINUTE, gapped)).toBe(185);
    expect(timeToX(T + 4 * MINUTE + 59_000, gapped)).toBe(185);
    expect(timeToX(T + 5 * MINUTE, gapped)).toBe(185);
  });

  it("gives back the time of a position inside the bars, past the last one and before the first, and agrees with timeToX", () => {
    expect(xToTime(155, FIVE)).toBe(T);
    expect(xToTime(177.5, FIVE)).toBe(T + 2 * MINUTE + 15_000);
    expect(xToTime(195, FIVE)).toBe(T + 4 * MINUTE);
    expect(xToTime(215, FIVE)).toBe(T + 6 * MINUTE);
    expect(xToTime(145, FIVE)).toBe(T - MINUTE);
    expect(xToTime(55, FIVE)).toBe(T - 10 * MINUTE);
    for (const t of [T - 7 * MINUTE, T, T + 90_000, T + 4 * MINUTE, T + 4 * MINUTE + 20_000, T + 9 * MINUTE]) expect(xToTime(timeToX(t, FIVE), FIVE)).toBeCloseTo(t, 3);
    expect(timeToX(xToTime(42, FIVE), FIVE)).toBeCloseTo(42, 9);
  });

  it("makes a band thicker with its heat from the thinnest setting, never thinner than the price span it covers", () => {
    expect(bandThickness(0, 1, 3, 8)).toBe(3);
    expect(bandThickness(1, 1, 3, 8)).toBe(8);
    expect(bandThickness(0.5, 1, 3, 8)).toBe(5.5);
    expect(bandThickness(0, 20, 3, 8)).toBe(20);
    expect(bandThickness(1, 9, 3, 8)).toBe(9);
  });

  it("colours bids green and asks red with an alpha that never leaves 0 to 0.98", () => {
    expect(bandColor(0, 0.5)).toBe("rgba(38,195,110,0.500)");
    expect(bandColor(1, 0.5)).toBe("rgba(220,65,65,0.500)");
    expect(bandColor(0, 5)).toBe("rgba(38,195,110,0.980)");
    expect(bandColor(1, -1)).toBe("rgba(220,65,65,0.000)");
  });

  it("dims the outcomes from filled down to moved and brightens with heat", () => {
    expect(bandAlpha(0, 0)).toBeCloseTo(0.2, 12);
    expect(bandAlpha(1, 0)).toBeCloseTo(0.9, 12);
    expect([...OUTCOME_ALPHA]).toEqual([1, 0.88, 0.5, 0.34, 0.24]);
    expect(bandAlpha(0.5, 0)).toBeGreaterThan(bandAlpha(0.25, 0));
    for (let outcome = 1; outcome < 5; outcome += 1) expect(bandAlpha(0.7, outcome)).toBeLessThan(bandAlpha(0.7, outcome - 1));
    expect(bandAlpha(0.7, 9)).toBeCloseTo((0.2 + 0.7 * Math.pow(0.7, 0.75)) * 0.24, 12);
  });

  it("picks label rows biggest first, skipping any too close to one already picked or outside the chart", () => {
    expect(pickLabelRows([100, 105, 200, 300, Number.NaN, -5, 9_999], 14, 0, 500)).toEqual([0, 2, 3]);
    expect(pickLabelRows([100, 114, 128], 14, 0, 500)).toEqual([0, 1, 2]);
    expect(pickLabelRows([100, 113.9], 14, 0, 500)).toEqual([0]);
    expect(pickLabelRows([5, 495], 14, 8, 492)).toEqual([]);
    expect(pickLabelRows([8, 492], 14, 8, 492)).toEqual([0, 1]);
    expect(pickLabelRows([], 14, 0, 500)).toEqual([]);
  });

  it("finds the nearest ask above and the nearest bid below the price, with their distance in percent, or none", () => {
    const standing = [
      { side: 1 as const, lo: 110, hi: 112, usd: 5 },
      { side: 1 as const, lo: 104, hi: 106, usd: 7 },
      { side: 1 as const, lo: 90, hi: 92, usd: 9 },
      { side: 0 as const, lo: 94, hi: 96, usd: 3 },
      { side: 0 as const, lo: 80, hi: 82, usd: 4 },
      { side: 0 as const, lo: 101, hi: 103, usd: 6 },
    ];
    const near = nearestWalls(standing, 100);
    expect(near.ask).toEqual({ usd: 7, pct: 5 });
    expect(near.bid).toEqual({ usd: 3, pct: 5 });
    expect(nearestWalls([], 100)).toEqual({ ask: null, bid: null });
    expect(nearestWalls([{ side: 1, lo: 90, hi: 92, usd: 1 }], 100).ask).toBeNull();
    expect(nearestWalls([{ side: 0, lo: 110, hi: 112, usd: 1 }], 100).bid).toBeNull();
  });
});
