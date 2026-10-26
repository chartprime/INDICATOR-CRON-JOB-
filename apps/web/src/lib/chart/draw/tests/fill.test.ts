import { describe, expect, it } from "vitest";
import {
  computeFillPolygon,
  DEFAULT_FILL_COLOR_ABOVE,
  DEFAULT_FILL_COLOR_BELOW,
  overwriteLastFillPoint,
  pushFillPoint,
  resetFillPoints,
  visibleFillPoints,
  type FillPoint,
  type FillSegment,
} from "../fill";

const identityTime = (value: number) => value * 10;
const identityPrice = (value: number) => value;

describe("computeFillPolygon -- null gaps", () => {
  it("splits into two disjoint segments around a null point, each keeping its own two points", () => {
    const points: (FillPoint | null)[] = [
      { time: 0, valueA: 10, valueB: 5 },
      { time: 1, valueA: 12, valueB: 6 },
      null,
      { time: 3, valueA: 4, valueB: 8 },
      { time: 4, valueA: 3, valueB: 9 },
    ];

    const segments = computeFillPolygon(points, identityTime, identityPrice);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      points: [{ x: 0, yA: 10, yB: 5 }, { x: 10, yA: 12, yB: 6 }],
      color: DEFAULT_FILL_COLOR_ABOVE,
    });
    expect(segments[1]).toEqual({
      points: [{ x: 30, yA: 4, yB: 8 }, { x: 40, yA: 3, yB: 9 }],
      color: DEFAULT_FILL_COLOR_BELOW,
    });
  });

  it("a lone point either side of a gap produces no segment -- at least two points are needed to fill an area", () => {
    const points: (FillPoint | null)[] = [{ time: 0, valueA: 1, valueB: 0 }, null, { time: 2, valueA: 1, valueB: 0 }];
    expect(computeFillPolygon(points, identityTime, identityPrice)).toEqual([]);
  });

  it("a coordinate function returning null for a point is treated the same as a data null (a gap)", () => {
    const points: (FillPoint | null)[] = [
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1, valueA: 1, valueB: 0 },
      { time: 2, valueA: 1, valueB: 0 },
    ];
    const offscreenAtTwo = (value: number) => (value === 2 ? null : value * 10);
    const segments = computeFillPolygon(points, offscreenAtTwo, identityPrice);
    expect(segments).toHaveLength(1);
    expect(segments[0].points).toHaveLength(2);
  });
});

describe("computeFillPolygon -- sign flips", () => {
  it("splits at the mathematical crossing into an above segment and a below segment, sharing the crossing point", () => {
    const points: (FillPoint | null)[] = [
      { time: 0, valueA: 10, valueB: 0 },
      { time: 1, valueA: 3, valueB: 7 },
      { time: 2, valueA: 1, valueB: 9 },
    ];

    const segments = computeFillPolygon(points, identityTime, identityPrice);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      points: [{ x: 0, yA: 10, yB: 0 }, { x: 7.142857142857143, yA: 5, yB: 5 }],
      color: DEFAULT_FILL_COLOR_ABOVE,
    });
    expect(segments[1]).toEqual({
      points: [{ x: 7.142857142857143, yA: 5, yB: 5 }, { x: 10, yA: 3, yB: 7 }, { x: 20, yA: 1, yB: 9 }],
      color: DEFAULT_FILL_COLOR_BELOW,
    });
  });

  it("valueA === valueB counts as the above side, matching the >= tie-break", () => {
    const points: (FillPoint | null)[] = [
      { time: 0, valueA: 5, valueB: 5 },
      { time: 1, valueA: 6, valueB: 5 },
    ];
    const segments = computeFillPolygon(points, identityTime, identityPrice);
    expect(segments).toEqual([{ points: [{ x: 0, yA: 5, yB: 5 }, { x: 10, yA: 6, yB: 5 }], color: DEFAULT_FILL_COLOR_ABOVE }]);
  });
});

describe("computeFillPolygon -- color options", () => {
  it("uses the given colorAbove/colorBelow instead of the defaults", () => {
    const points: (FillPoint | null)[] = [{ time: 0, valueA: 2, valueB: 1 }, { time: 1, valueA: 2, valueB: 1 }];
    const segments = computeFillPolygon(points, identityTime, identityPrice, { colorAbove: "#00ff00" });
    expect(segments[0].color).toBe("#00ff00");
  });
});

describe("computeFillPolygon -- empty input", () => {
  it("returns no segments for an all-null series", () => {
    expect(computeFillPolygon([null, null], identityTime, identityPrice)).toEqual([]);
  });

  it("returns no segments for an empty array", () => {
    expect(computeFillPolygon([], identityTime, identityPrice)).toEqual([]);
  });
});

describe("pushFillPoint / overwriteLastFillPoint / resetFillPoints", () => {
  it("pushFillPoint appends without touching earlier entries", () => {
    const points: (FillPoint | null)[] = [];
    pushFillPoint(points, { time: 0, valueA: 1, valueB: 2 });
    pushFillPoint(points, null);
    expect(points).toEqual([{ time: 0, valueA: 1, valueB: 2 }, null]);
  });

  it("overwriteLastFillPoint replaces only the last entry", () => {
    const points: (FillPoint | null)[] = [{ time: 0, valueA: 1, valueB: 2 }, { time: 1, valueA: 3, valueB: 4 }];
    overwriteLastFillPoint(points, { time: 1, valueA: 99, valueB: 99 });
    expect(points).toEqual([{ time: 0, valueA: 1, valueB: 2 }, { time: 1, valueA: 99, valueB: 99 }]);
  });

  it("overwriteLastFillPoint on an empty array pushes instead of throwing", () => {
    const points: (FillPoint | null)[] = [];
    overwriteLastFillPoint(points, { time: 0, valueA: 1, valueB: 2 });
    expect(points).toEqual([{ time: 0, valueA: 1, valueB: 2 }]);
  });

  it("resetFillPoints empties the array in place", () => {
    const points: (FillPoint | null)[] = [{ time: 0, valueA: 1, valueB: 2 }];
    resetFillPoints(points);
    expect(points).toEqual([]);
  });
});

// Report 57 W4: the fill was rebuilt from every retained point (10,080) on every
// repaint, two chart lookups per point. Only the visible window is on screen, so
// only it (with a margin) is converted -- and inside the window the band is the
// same band, crossings and gaps included.
describe("visibleFillPoints", () => {
  const band: (FillPoint | null)[] = Array.from({ length: 2_000 }, (_, index) =>
    index % 97 === 50 ? null : { time: index * 60_000, valueA: Math.sin(index / 13) * 5, valueB: Math.cos(index / 29) * 3 });
  const x = (time: number) => time / 60_000;
  const y = (price: number) => price * 10;
  const inside = (segments: readonly FillSegment[], lo: number, hi: number) =>
    segments.map((segment) => ({ color: segment.color, points: segment.points.filter((point) => point.x >= lo && point.x <= hi) })).filter((segment) => segment.points.length > 0);

  it("draws exactly the same band inside the visible window", () => {
    for (const [from, to] of [[400, 700], [49, 51], [0, 30], [1_950, 2_100]] as const) {
      const full = computeFillPolygon(band, x, y);
      const clipped = computeFillPolygon(visibleFillPoints(band, from * 60_000, to * 60_000), x, y);
      expect(inside(clipped, from, to)).toEqual(inside(full, from, to));
    }
  });

  it("keeps the points that carry the band across a view with none inside, and nothing far off screen", () => {
    const sparse: (FillPoint | null)[] = [{ time: 0, valueA: 1, valueB: 0 }, { time: 600_000, valueA: 1, valueB: 0 }];
    expect(visibleFillPoints(sparse, 120_000, 240_000)).toEqual(sparse);
    expect(visibleFillPoints(band, -10 * 60_000, -5 * 60_000)).toHaveLength(3);
    expect(visibleFillPoints(band, 5_000 * 60_000, 6_000 * 60_000)).toHaveLength(3);
    expect(visibleFillPoints(band, 400 * 60_000, 700 * 60_000).length).toBeLessThan(320);
  });
});
