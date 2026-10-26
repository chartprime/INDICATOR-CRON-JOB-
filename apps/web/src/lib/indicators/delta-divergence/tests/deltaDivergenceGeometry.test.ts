import { describe, expect, it } from "vitest";
import type { Divergence } from "../deltaDivergence";
import {
  buildDivergenceRenderBands,
  buildDivergenceRenderLines,
  divergenceFillColor,
  divergenceLineColor,
  isDivergenceVisible,
} from "../deltaDivergenceGeometry";

function divergence(
  type: Divergence["type"],
  fromTs: number,
  toTs: number,
  cvdFrom = 0,
  cvdTo = 0,
  cvdFromTs = fromTs,
  cvdToTs = toTs,
): Divergence {
  return {
    type,
    priceFrom: { index: 0, ts_open: fromTs, price: 10 },
    priceTo: { index: 1, ts_open: toTs, price: 20 },
    cvdFrom: { index: 0, ts_open: cvdFromTs, value: cvdFrom },
    cvdTo: { index: 1, ts_open: cvdToTs, value: cvdTo },
    reasons: [],
  };
}

describe("divergenceLineColor / divergenceFillColor", () => {
  it("bullish is green, bearish is red -- and the fill is the line color at reduced opacity, not an unrelated palette", () => {
    expect(divergenceLineColor("bullish")).toBe("#16a34a");
    expect(divergenceLineColor("bearish")).toBe("#dc2626");
    expect(divergenceFillColor("bullish")).toContain("22, 163, 74");
    expect(divergenceFillColor("bearish")).toContain("220, 38, 38");
  });
});

describe("isDivergenceVisible", () => {
  it("is visible when it overlaps the visible range at all, not just when fully contained", () => {
    const d = divergence("bearish", 10_000, 20_000);
    expect(isDivergenceVisible(d, 5, 8)).toBe(false); // entirely before
    expect(isDivergenceVisible(d, 22, 30)).toBe(false); // entirely after
    expect(isDivergenceVisible(d, 15, 18)).toBe(true); // fully contained
    expect(isDivergenceVisible(d, 5, 12)).toBe(true); // overlaps left edge
    expect(isDivergenceVisible(d, 18, 30)).toBe(true); // overlaps right edge
  });
});

describe("buildDivergenceRenderLines", () => {
  it("maps price-kind lines from price anchors, and CVD-kind lines from their independently aligned CVD extrema", () => {
    const d = divergence("bullish", 1_000, 2_000, 5, 25, 900, 2_100);
    const timeToCoordinate = (ts: number) => ts / 10;
    const priceLines = buildDivergenceRenderLines([d], "price", timeToCoordinate, (v) => v * 2);
    expect(priceLines).toEqual([{ x1: 100, y1: 20, x2: 200, y2: 40, color: "#16a34a" }]);

    const cvdLines = buildDivergenceRenderLines([d], "cvd", timeToCoordinate, (v) => v * 2);
    expect(cvdLines).toEqual([{ x1: 90, y1: 10, x2: 210, y2: 50, color: "#16a34a" }]);
  });

  it("drops a divergence whose time or value coordinate can't be resolved, rather than drawing a broken line", () => {
    const d = divergence("bearish", 1_000, 2_000);
    const allNull = buildDivergenceRenderLines([d], "price", () => null, () => 5);
    expect(allNull).toEqual([]);
    const valueNull = buildDivergenceRenderLines([d], "price", (ts) => ts, () => null);
    expect(valueNull).toEqual([]);
  });
});

describe("buildDivergenceRenderBands", () => {
  it("spans from the first swing's x to the second's, colored by divergence type", () => {
    const d = divergence("bearish", 1_000, 2_000);
    const bands = buildDivergenceRenderBands([d], (ts) => ts / 10);
    expect(bands).toEqual([{ x1: 100, x2: 200, color: expect.stringContaining("220, 38, 38") }]);
  });

  it("drops a divergence whose time coordinate can't be resolved", () => {
    const d = divergence("bearish", 1_000, 2_000);
    expect(buildDivergenceRenderBands([d], () => null)).toEqual([]);
  });
});
