import { describe, expect, it } from "vitest";
import {
  computeLocalMedianBaselines,
  hitTestWhaleMarkers,
  whaleMarkerFillOpacity,
  whaleMarkerRadiusPx,
  WHALE_MIN_RADIUS_PX,
  WHALE_MAX_RADIUS_PX,
  WHALE_BASE_RADIUS_PX,
  WHALE_MIN_FILL_OPACITY,
  WHALE_MAX_FILL_OPACITY,
} from "../whaleMarkerGeometry";

describe("computeLocalMedianBaselines", () => {
  it("points sharing one bucket share one median baseline", () => {
    const points = [{ ts: 0, magnitude: 10 }, { ts: 100, magnitude: 20 }, { ts: 200, magnitude: 30 }];
    expect(computeLocalMedianBaselines(points, 1_000, 1)).toEqual([20, 20, 20]);
  });

  it("different buckets get independent medians", () => {
    const points = [
      { ts: 0, magnitude: 10 },
      { ts: 1_000, magnitude: 100 },
      { ts: 1_001, magnitude: 200 },
    ];
    expect(computeLocalMedianBaselines(points, 1_000, 1)).toEqual([10, 150, 150]);
  });

  it("a sparse bucket blends in neighboring buckets until minBucketSamples is met", () => {
    const points = [
      { ts: 0, magnitude: 999 },
      { ts: 1_000, magnitude: 50 },
      { ts: 2_000, magnitude: 10 },
      { ts: 2_001, magnitude: 30 },
    ];
    expect(computeLocalMedianBaselines(points, 1_000, 3)).toEqual([40, 40, 30, 30]);
  });

  it("degrades gracefully to whatever's available when no neighboring buckets exist to blend in", () => {
    expect(computeLocalMedianBaselines([{ ts: 0, magnitude: 42 }], 1_000, 5)).toEqual([42]);
  });

  it("keeps searching outward past an empty gap bucket instead of giving up at the first empty ring", () => {
    const points = [
      { ts: 0, magnitude: 60_000 },
      { ts: 2_000, magnitude: 5_000_000 },
      { ts: 2_001, magnitude: 5_000_000 },
    ];
    expect(computeLocalMedianBaselines(points, 1_000, 3)).toEqual([5_000_000, 5_000_000, 5_000_000]);
  });

  it("uses the next populated bucket directly across a very large empty time gap", () => {
    const points = [
      { ts: 0, magnitude: 10 },
      { ts: 50_000_000_000, magnitude: 20 },
      { ts: 50_000_000_001, magnitude: 30 },
    ];
    expect(computeLocalMedianBaselines(points, 1_000, 3)).toEqual([20, 20, 20]);
  });

  it("results are indexed to the original input order, not sorted by time", () => {
    const points = [{ ts: 2_000, magnitude: 999 }, { ts: 0, magnitude: 10 }];
    expect(computeLocalMedianBaselines(points, 1_000, 1)).toEqual([999, 10]);
  });

  it("rejects invalid bucketing inputs", () => {
    expect(() => computeLocalMedianBaselines([], 0, 1)).toThrow(/bucketMs/);
    expect(() => computeLocalMedianBaselines([], 1_000, 0)).toThrow(/minBucketSamples/);
  });
});

describe("whaleMarkerRadiusPx", () => {
  it("a trade exactly at its local median renders at the base radius", () => {
    expect(whaleMarkerRadiusPx(100_000, 100_000)).toBe(WHALE_BASE_RADIUS_PX);
  });

  it("a trade above its local median reads as a strictly larger radius", () => {
    const atMedian = whaleMarkerRadiusPx(100_000, 100_000);
    const aboveMedian = whaleMarkerRadiusPx(400_000, 100_000);
    expect(aboveMedian).toBeGreaterThan(atMedian);
  });

  it("a trade below its local median reads as a strictly smaller radius", () => {
    const atMedian = whaleMarkerRadiusPx(100_000, 100_000);
    const belowMedian = whaleMarkerRadiusPx(25_000, 100_000);
    expect(belowMedian).toBeLessThan(atMedian);
  });

  it("a larger notional always reads as a strictly larger radius than a smaller one, for the same local median", () => {
    const small = whaleMarkerRadiusPx(70_000, 50_000);
    const large = whaleMarkerRadiusPx(160_000, 50_000);
    expect(large).toBeGreaterThan(small);
  });

  it("clamps to the maximum radius for an extreme outlier relative to its local median", () => {
    expect(whaleMarkerRadiusPx(50_000_000, 50_000)).toBe(WHALE_MAX_RADIUS_PX);
  });

  it("clamps to the minimum radius for a trade far below its local median", () => {
    expect(whaleMarkerRadiusPx(1, 50_000)).toBe(WHALE_MIN_RADIUS_PX);
  });

  it("a non-positive local median falls back to the minimum radius instead of dividing by zero or producing NaN", () => {
    expect(whaleMarkerRadiusPx(100_000, 0)).toBe(WHALE_MIN_RADIUS_PX);
    expect(whaleMarkerRadiusPx(100_000, -1)).toBe(WHALE_MIN_RADIUS_PX);
  });

  it("a non-positive or non-finite magnitude also falls back to a finite minimum radius", () => {
    expect(whaleMarkerRadiusPx(0, 100_000)).toBe(WHALE_MIN_RADIUS_PX);
    expect(whaleMarkerRadiusPx(Number.NaN, 100_000)).toBe(WHALE_MIN_RADIUS_PX);
  });
});

describe("whaleMarkerFillOpacity", () => {
  it("a single trade (count 1) gets the minimum opacity", () => {
    expect(whaleMarkerFillOpacity(1)).toBe(WHALE_MIN_FILL_OPACITY);
  });

  it("count at or above the full-opacity cutoff gets the maximum opacity", () => {
    expect(whaleMarkerFillOpacity(5)).toBe(WHALE_MAX_FILL_OPACITY);
    expect(whaleMarkerFillOpacity(50)).toBe(WHALE_MAX_FILL_OPACITY);
  });

  it("more overlapping trades reads as strictly darker, monotonically", () => {
    const two = whaleMarkerFillOpacity(2);
    const three = whaleMarkerFillOpacity(3);
    const four = whaleMarkerFillOpacity(4);
    expect(three).toBeGreaterThan(two);
    expect(four).toBeGreaterThan(three);
  });

  it("a count below 1 is clamped, not driven negative", () => {
    expect(whaleMarkerFillOpacity(0)).toBe(WHALE_MIN_FILL_OPACITY);
  });
});

describe("hitTestWhaleMarkers", () => {
  it("returns the candidate whose circle contains the query point", () => {
    const candidates = [{ x: 100, y: 100, radiusPx: 20, value: "a" }];
    expect(hitTestWhaleMarkers(candidates, 105, 100)).toBe("a");
  });

  it("returns null once the query point is outside the radius plus tolerance", () => {
    const candidates = [{ x: 100, y: 100, radiusPx: 20, value: "a" }];
    expect(hitTestWhaleMarkers(candidates, 100, 130, 2)).toBeNull();
  });

  it("a generous circle is hit even far from its exact center -- this is what makes big halos easy to hover", () => {
    const candidates = [{ x: 100, y: 100, radiusPx: 50, value: "big" }];
    expect(hitTestWhaleMarkers(candidates, 140, 100)).toBe("big");
  });

  it("picks the nearer of two overlapping circles", () => {
    const candidates = [
      { x: 100, y: 100, radiusPx: 30, value: "far" },
      { x: 110, y: 100, radiusPx: 30, value: "near" },
    ];
    expect(hitTestWhaleMarkers(candidates, 108, 100)).toBe("near");
  });

  it("returns null for an empty candidate list", () => {
    expect(hitTestWhaleMarkers([], 0, 0)).toBeNull();
  });
});
