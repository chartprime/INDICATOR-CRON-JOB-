import { describe, expect, it } from "vitest";
import {
  DRAWING_PLACEMENT_IDLE,
  advanceDrawingPlacement,
  hitTestTrendlines,
  pickNearestHit,
  trendlinePixelPoints,
  type DrawingPlacementMode,
} from "../trendlineGeometry";
import type { TrendlineDrawing } from "../../../chart/drawingStore";

function trendline(): TrendlineDrawing {
  return {
    id: "t1",
    type: "trendline",
    points: [
      { time: 100, price: 50_000 },
      { time: 200, price: 51_000 },
    ],
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
  };
}

describe("trendlinePixelPoints", () => {
  it("projects both endpoints through the supplied coordinate functions", () => {
    const result = trendlinePixelPoints(
      trendline(),
      (t) => t * 2,
      (p) => p / 1000,
    );
    expect(result).toEqual({ x1: 200, y1: 50, x2: 400, y2: 51 });
  });

  it("returns null when the first endpoint's time is off-scale", () => {
    const result = trendlinePixelPoints(
      trendline(),
      (t) => (t === 100 ? null : t),
      (p) => p,
    );
    expect(result).toBeNull();
  });

  it("returns null when either endpoint's price is off-scale", () => {
    const result = trendlinePixelPoints(
      trendline(),
      (t) => t,
      (p) => (p === 51_000 ? null : p),
    );
    expect(result).toBeNull();
  });
});

describe("hitTestTrendlines", () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };

  it("finds a line within tolerance of a point on the segment", () => {
    expect(hitTestTrendlines([{ id: "a", segment: seg }], 50, 2, 4)).toEqual({ id: "a", distance: 2 });
  });

  it("returns null outside tolerance", () => {
    expect(hitTestTrendlines([{ id: "a", segment: seg }], 50, 10, 4)).toBeNull();
  });

  it("returns null when a point projects past a segment's endpoint", () => {
    expect(hitTestTrendlines([{ id: "a", segment: seg }], 150, 0, 4)).toBeNull();
  });

  it("picks the closest of several overlapping-tolerance candidates", () => {
    const candidates = [
      { id: "far", segment: { x1: 0, y1: 3, x2: 100, y2: 3 } },
      { id: "near", segment: { x1: 0, y1: 1, x2: 100, y2: 1 } },
    ];
    expect(hitTestTrendlines(candidates, 50, 0, 4)).toEqual({ id: "near", distance: 1 });
  });

  it("handles a zero-length segment as a point", () => {
    const point = { x1: 10, y1: 10, x2: 10, y2: 10 };
    expect(hitTestTrendlines([{ id: "p", segment: point }], 11, 11, 4)).toEqual({ id: "p", distance: Math.SQRT2 });
  });
});

describe("pickNearestHit", () => {
  it("picks the hit with the smaller distance when both are present", () => {
    expect(pickNearestHit([{ id: "far", distance: 5 }, { id: "near", distance: 1 }])).toBe("near");
  });

  it("returns the only non-null hit", () => {
    expect(pickNearestHit([null, { id: "a", distance: 3 }])).toBe("a");
  });

  it("returns null when every hit is null", () => {
    expect(pickNearestHit([null, null])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickNearestHit([])).toBeNull();
  });
});

describe("advanceDrawingPlacement", () => {
  it("setTool with a tool enters placing mode with no first point", () => {
    const result = advanceDrawingPlacement(DRAWING_PLACEMENT_IDLE, { type: "setTool", tool: "trendline" });
    expect(result.next).toEqual({ kind: "placing", tool: "trendline", first: null });
    expect(result.commit).toBeNull();
  });

  it("re-applying setTool with the same tool while a first point is pending cancels it, staying placeable -- not idle", () => {
    const midPlacement: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: { time: 1, price: 2 } };
    const result = advanceDrawingPlacement(midPlacement, { type: "setTool", tool: "trendline" });
    expect(result.next).toEqual({ kind: "placing", tool: "trendline", first: null });
    const nextClick = advanceDrawingPlacement(result.next, { type: "click", point: { time: 10, price: 20 }, hitId: null });
    expect(nextClick.next).toEqual({ kind: "placing", tool: "trendline", first: { time: 10, price: 20 } });
  });

  it("setTool with null returns to idle from any state", () => {
    const selected: DrawingPlacementMode = { kind: "selected", id: "x" };
    expect(advanceDrawingPlacement(selected, { type: "setTool", tool: null }).next).toEqual({ kind: "idle" });
  });

  it("a click while placing with no first point records the first point and commits nothing", () => {
    const placing: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: null };
    const result = advanceDrawingPlacement(placing, { type: "click", point: { time: 1, price: 2 }, hitId: null });
    expect(result.next).toEqual({ kind: "placing", tool: "trendline", first: { time: 1, price: 2 } });
    expect(result.commit).toBeNull();
  });

  it("a click while placing with a first point commits the pair and resets first, staying in tool mode", () => {
    const placing: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: { time: 1, price: 2 } };
    const result = advanceDrawingPlacement(placing, { type: "click", point: { time: 3, price: 4 }, hitId: null });
    expect(result.commit).toEqual({ first: { time: 1, price: 2 }, second: { time: 3, price: 4 }, tool: "trendline" });
    expect(result.next).toEqual({ kind: "placing", tool: "trendline", first: null });
  });

  it("a click with a null point while placing is a no-op, not a commit", () => {
    const placing: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: { time: 1, price: 2 } };
    const result = advanceDrawingPlacement(placing, { type: "click", point: null, hitId: null });
    expect(result).toEqual({ next: placing, commit: null, removeId: null });
  });

  it("a click while idle with a hit selects that id", () => {
    const result = advanceDrawingPlacement(DRAWING_PLACEMENT_IDLE, { type: "click", point: null, hitId: "abc" });
    expect(result.next).toEqual({ kind: "selected", id: "abc" });
  });

  it("a click while idle with no hit stays idle", () => {
    const result = advanceDrawingPlacement(DRAWING_PLACEMENT_IDLE, { type: "click", point: null, hitId: null });
    expect(result.next).toEqual({ kind: "idle" });
  });

  it("a click while something is selected but missing the target deselects", () => {
    const selected: DrawingPlacementMode = { kind: "selected", id: "abc" };
    const result = advanceDrawingPlacement(selected, { type: "click", point: null, hitId: null });
    expect(result.next).toEqual({ kind: "idle" });
  });

  it("escape while a first point is pending clears just the first point, staying in tool mode", () => {
    const placing: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: { time: 1, price: 2 } };
    const result = advanceDrawingPlacement(placing, { type: "escape" });
    expect(result.next).toEqual({ kind: "placing", tool: "trendline", first: null });
  });

  it("escape while placing with no first point pending is a no-op (tool stays active)", () => {
    const placing: DrawingPlacementMode = { kind: "placing", tool: "trendline", first: null };
    const result = advanceDrawingPlacement(placing, { type: "escape" });
    expect(result.next).toBe(placing);
  });

  it("escape while something is selected deselects to idle", () => {
    const selected: DrawingPlacementMode = { kind: "selected", id: "abc" };
    expect(advanceDrawingPlacement(selected, { type: "escape" }).next).toEqual({ kind: "idle" });
  });

  it("escape while idle is a no-op", () => {
    const result = advanceDrawingPlacement(DRAWING_PLACEMENT_IDLE, { type: "escape" });
    expect(result.next).toBe(DRAWING_PLACEMENT_IDLE);
  });

  it("deleteSelected while something is selected emits its id and returns to idle", () => {
    const selected: DrawingPlacementMode = { kind: "selected", id: "abc" };
    const result = advanceDrawingPlacement(selected, { type: "deleteSelected" });
    expect(result.removeId).toBe("abc");
    expect(result.next).toEqual({ kind: "idle" });
  });

  it("deleteSelected while nothing is selected is a no-op", () => {
    const result = advanceDrawingPlacement(DRAWING_PLACEMENT_IDLE, { type: "deleteSelected" });
    expect(result.removeId).toBeNull();
    expect(result.next).toBe(DRAWING_PLACEMENT_IDLE);
  });
});
