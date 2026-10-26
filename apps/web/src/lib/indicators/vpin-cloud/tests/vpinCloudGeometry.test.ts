import { describe, expect, it } from "vitest";
import {
  buildCloudPoints,
  buildCloudPolygon,
  estimateBarDx,
  mapReadingsToBars,
  splitCloudRuns,
  type VpinCloudPoint,
} from "../vpinCloudGeometry";
import type { BarFrame, VpinReading } from "../../../../types/frames";

function bar(tsOpen: number, overrides: Partial<Pick<BarFrame, "high" | "low" | "interval_ms">> = {}): BarFrame {
  return {
    type: "bar", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT",
    interval_ms: 60_000, ts_open: tsOpen, open: 100, high: 105, low: 95, close: 100,
    volume: 10, trade_count: 5, closed: true,
    ...overrides,
  };
}

function reading(sealTs: number, overrides: Partial<VpinReading> = {}): VpinReading {
  return {
    seal_ts: sealTs, active: true, direction: "buy", strength: 0.5,
    z_vpin: 1, z_velocity: 0.1, z_acceleration: 0.01, activated_at_ts: sealTs - 100,
    ...overrides,
  };
}

describe("mapReadingsToBars", () => {
  it("forward-fills each bar to the latest reading sealed as of that bar's close", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    const readings = [reading(30_000, { direction: "buy", strength: 0.3 })];
    const rows = mapReadingsToBars(readings, bars);

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.buyStr === 0.3 && r.sellStr === 0)).toBe(true);
  });

  it("leaves earlier bars out entirely when no reading has sealed yet as of their close", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    const readings = [reading(150_000, { direction: "sell", strength: 0.4 })];
    const rows = mapReadingsToBars(readings, bars);

    expect(rows).toHaveLength(1);
    expect(rows[0].time).toBe(120_000 / 1000);
    expect(rows[0].sellStr).toBe(0.4);
  });

  it("advances to a later reading only once that bar's close reaches it -- a step function, not interpolation", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    const readings = [
      reading(30_000, { direction: "buy", strength: 0.2 }),
      reading(150_000, { direction: "buy", strength: 0.8 }),
    ];
    const rows = mapReadingsToBars(readings, bars);

    expect(rows.map((r) => r.buyStr)).toEqual([0.2, 0.2, 0.8]);
  });

  it("maps an inactive reading to zero strength on both sides", () => {
    const bars = [bar(0)];
    const readings = [reading(30_000, { active: false, direction: null, strength: 0, activated_at_ts: null })];
    const rows = mapReadingsToBars(readings, bars);

    expect(rows).toEqual([]);
  });

  it("omits a bar entirely once strength drops to zero, rather than emitting a zero-strength row", () => {
    const bars = [bar(0), bar(60_000)];
    const readings = [
      reading(30_000, { direction: "buy", strength: 0.5 }),
      reading(90_000, { active: false, direction: null, strength: 0, activated_at_ts: null }),
    ];
    const rows = mapReadingsToBars(readings, bars);

    expect(rows).toHaveLength(1);
    expect(rows[0].time).toBe(0);
  });

  it("returns an empty array when there are no readings or no bars", () => {
    expect(mapReadingsToBars([], [bar(0)])).toEqual([]);
    expect(mapReadingsToBars([reading(0)], [])).toEqual([]);
  });

  // L1L2-V2-067. Forward-fill is intended -- readings are volume-sealed and
  // bars are time-ruled, so a reading has to carry across bars. What was not
  // intended is that it carried across them *without limit*: readingIndex only
  // ever advances, so if readings stop arriving at all (feed drop, failed
  // warm-up, an instrument that simply goes quiet) the last active reading
  // paints a toxicity cloud over every subsequent bar indefinitely. An
  // inactive reading ends the cloud; silence did not.
  it("stops forward-filling an active reading once it is far older than the readings around it", () => {
    const readings = [
      reading(30_000, { direction: "buy", strength: 0.4 }),
      reading(90_000, { direction: "buy", strength: 0.5 }),
      reading(150_000, { direction: "buy", strength: 0.6 }),
    ];
    // Readings stop at 150_000; bars keep coming for another hour.
    const bars = Array.from({ length: 64 }, (_, i) => bar(i * 60_000));
    const rows = mapReadingsToBars(readings, bars);

    const lastPainted = Math.max(...rows.map((r) => Number(r.time) * 1000));
    expect(lastPainted).toBeLessThan(60 * 60_000);
  });

  it("keeps forward-filling across a gap that is normal for the reading cadence", () => {
    // Readings every ~10 minutes; a single 10-minute carry is business as usual
    // and must not be cut off.
    const readings = [
      reading(0, { direction: "buy", strength: 0.4 }),
      reading(600_000, { direction: "buy", strength: 0.5 }),
    ];
    const bars = Array.from({ length: 15 }, (_, i) => bar(600_000 + i * 60_000));
    const rows = mapReadingsToBars(readings, bars);

    expect(rows).toHaveLength(bars.length);
    expect(rows.every((r) => r.buyStr === 0.5)).toBe(true);
  });

  it("still paints a single reading against its own bars when there is no cadence to infer", () => {
    const bars = [bar(0), bar(60_000)];
    const rows = mapReadingsToBars([reading(30_000, { strength: 0.3 })], bars);

    expect(rows.length).toBeGreaterThan(0);
  });
});

function fakeTimeScale({ hasPoints = true, widthPx = 800 } = {}) {
  return {
    timeToCoordinate: (time: number) => (hasPoints ? time * 10 : null),
    width: () => widthPx,
  };
}

function fakeChart(overrides: Parameters<typeof fakeTimeScale>[0] = {}) {
  return { timeScale: () => fakeTimeScale(overrides) } as never;
}

function fakeSeries(priceToY: (price: number) => number | null = (p) => p * 2) {
  return { priceToCoordinate: priceToY } as never;
}

describe("buildCloudPoints", () => {
  it("maps each row to screen coordinates via the chart/series primitives", () => {
    const rows = [{ time: 1 as never, low: 95, high: 105, buyStr: 0.5, sellStr: 0 }];
    const points = buildCloudPoints(fakeChart(), fakeSeries(), 800, rows);

    expect(points).toEqual([{ x: 10, lowY: 190, highY: 210, buyStr: 0.5, sellStr: 0 }]);
  });

  it("skips a row with no signal on either side", () => {
    const rows = [{ time: 1 as never, low: 95, high: 105, buyStr: 0, sellStr: 0 }];
    expect(buildCloudPoints(fakeChart(), fakeSeries(), 800, rows)).toEqual([]);
  });

  it("skips a row whose time has no on-screen coordinate", () => {
    const rows = [{ time: 1 as never, low: 95, high: 105, buyStr: 0.5, sellStr: 0 }];
    expect(buildCloudPoints(fakeChart({ hasPoints: false }), fakeSeries(), 800, rows)).toEqual([]);
  });

  it("skips a row far enough off-screen to fall outside the small look-ahead margin", () => {
    const rows = [{ time: 1_000 as never, low: 95, high: 105, buyStr: 0.5, sellStr: 0 }];
    expect(buildCloudPoints(fakeChart(), fakeSeries(), 800, rows)).toEqual([]);
  });

  it("skips a row whose price has no on-screen coordinate", () => {
    const rows = [{ time: 1 as never, low: 95, high: 105, buyStr: 0.5, sellStr: 0 }];
    expect(buildCloudPoints(fakeChart(), fakeSeries(() => null), 800, rows)).toEqual([]);
  });
});

function point(x: number, buyStr = 0.5): VpinCloudPoint {
  return { x, lowY: 100, highY: 90, buyStr, sellStr: 0 };
}

describe("splitCloudRuns", () => {
  it("keeps contiguous points in one run", () => {
    const runs = splitCloudRuns([point(0), point(6), point(12)], 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it("splits into separate runs across a gap wider than maxGap", () => {
    const runs = splitCloudRuns([point(0), point(6), point(50), point(56)], 10);
    expect(runs).toHaveLength(2);
    expect(runs[0].map((p) => p.x)).toEqual([0, 6]);
    expect(runs[1].map((p) => p.x)).toEqual([50, 56]);
  });

  it("returns an empty array for no points", () => {
    expect(splitCloudRuns([], 10)).toEqual([]);
  });
});

describe("estimateBarDx", () => {
  it("returns the tightest positive spacing seen", () => {
    expect(estimateBarDx([point(0), point(6), point(20)])).toBe(6);
  });

  it("falls back to the given default when there is no usable spacing", () => {
    expect(estimateBarDx([point(0)], 7)).toBe(7);
    expect(estimateBarDx([], 7)).toBe(7);
  });
});

describe("buildCloudPolygon", () => {
  it("walks forward along the anchor line, then backward along the strength-scaled edge", () => {
    const points: VpinCloudPoint[] = [
      { x: 0, lowY: 100, highY: 90, buyStr: 0.5, sellStr: 0 },
      { x: 10, lowY: 100, highY: 90, buyStr: 1, sellStr: 0 },
    ];
    const polygon = buildCloudPolygon(points, 40, 1, true);

    expect(polygon).toEqual([
      { x: 0, y: 104 },
      { x: 10, y: 104 },
      { x: 10, y: 104 + 1 * 40 * 1 },
      { x: 0, y: 104 + 0.5 * 40 * 1 },
    ]);
  });

  it("anchors above the bar's high, extending upward, for the sell side", () => {
    const points: VpinCloudPoint[] = [
      { x: 0, lowY: 100, highY: 90, buyStr: 0, sellStr: 0.5 },
      { x: 10, lowY: 100, highY: 90, buyStr: 0, sellStr: 0.5 },
    ];
    const polygon = buildCloudPolygon(points, 40, 1, false);

    for (const p of polygon.slice(0, 2)) expect(p.y).toBe(86);
    for (const p of polygon.slice(2)) expect(p.y).toBeLessThan(86);
  });

  it("scales the outer edge by heightFrac, the gradient-layer control", () => {
    const points: VpinCloudPoint[] = [
      { x: 0, lowY: 100, highY: 90, buyStr: 1, sellStr: 0 },
      { x: 10, lowY: 100, highY: 90, buyStr: 1, sellStr: 0 },
    ];
    const full = buildCloudPolygon(points, 40, 1, true);
    const half = buildCloudPolygon(points, 40, 0.5, true);

    expect(full[2].y - full[0].y).toBe(2 * (half[2].y - half[0].y));
  });

  it("returns an empty array for fewer than 2 points -- nothing to fill", () => {
    expect(buildCloudPolygon([], 40, 1, true)).toEqual([]);
    expect(buildCloudPolygon([point(0)], 40, 1, true)).toEqual([]);
  });
});
