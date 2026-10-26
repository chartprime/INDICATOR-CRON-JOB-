import { describe, expect, it } from "vitest";
import { FIBONACCI_LEVELS, fibonacciHitCandidates, fibonacciLevelPrice, fibonacciPixelLevels } from "../fibonacciGeometry";
import type { FibonacciDrawing } from "../../../chart/drawingStore";

function fib(pointA = { time: 100, price: 50_000 }, pointB = { time: 200, price: 51_000 }): FibonacciDrawing {
  return {
    id: "f1",
    type: "fibonacci",
    points: [pointA, pointB],
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
  };
}

describe("fibonacciLevelPrice", () => {
  // Standard convention (TradingView, and every charting package): level 0%
  // sits at the SECOND-clicked point -- where the move ended -- and 100% at
  // the first. "Retraced 61.8%" means price pulled back 61.8% of the way from
  // the end of the move back toward its start.
  it("level 0 sits at the second point's price -- the end of the measured move", () => {
    expect(fibonacciLevelPrice({ time: 0, price: 100 }, { time: 0, price: 200 }, 0)).toBe(200);
  });

  it("level 1 (100%) sits at the first point's price -- the start of the move", () => {
    expect(fibonacciLevelPrice({ time: 0, price: 100 }, { time: 0, price: 200 }, 1)).toBe(100);
  });

  it("level 0.5 is the exact midpoint either way", () => {
    expect(fibonacciLevelPrice({ time: 0, price: 100 }, { time: 0, price: 200 }, 0.5)).toBe(150);
  });

  it("a bottom-up draw retraces DOWN from the high, not up from the low", () => {
    // Low 100 -> high 200. A 61.8% retracement of a 100-point rally is 138.2,
    // not 161.8: it measures the pullback from the high.
    expect(fibonacciLevelPrice({ time: 0, price: 100 }, { time: 0, price: 200 }, 0.618)).toBeCloseTo(138.2, 10);
    expect(fibonacciLevelPrice({ time: 0, price: 100 }, { time: 0, price: 200 }, 0.236)).toBeCloseTo(176.4, 10);
  });

  it("a top-down draw retraces UP from the low, mirroring the bottom-up case", () => {
    expect(fibonacciLevelPrice({ time: 0, price: 200 }, { time: 0, price: 100 }, 0)).toBe(100);
    expect(fibonacciLevelPrice({ time: 0, price: 200 }, { time: 0, price: 100 }, 1)).toBe(200);
    expect(fibonacciLevelPrice({ time: 0, price: 200 }, { time: 0, price: 100 }, 0.618)).toBeCloseTo(161.8, 10);
  });
});

describe("fibonacciPixelLevels", () => {
  it("projects all 7 standard levels with matching fraction/price/coordinates", () => {
    const levels = fibonacciPixelLevels(
      fib({ time: 100, price: 100 }, { time: 200, price: 200 }),
      (t) => t * 2,
      (p) => p / 10,
    );
    expect(levels).not.toBeNull();
    expect(levels!.map((l) => l.fraction)).toEqual(FIBONACCI_LEVELS);
    // 0% at the second point (200), 100% at the first (100) -- the levels run
    // from the end of the move back toward its start.
    expect(levels![0]).toEqual({ fraction: 0, price: 200, x1: 200, x2: 400, y: 20 });
    expect(levels![6]).toEqual({ fraction: 1, price: 100, x1: 200, x2: 400, y: 10 });
  });

  it("returns null when the first endpoint's time is off-scale", () => {
    const levels = fibonacciPixelLevels(fib(), (t) => (t === 100 ? null : t), (p) => p);
    expect(levels).toBeNull();
  });

  it("returns null when the second endpoint's time is off-scale", () => {
    const levels = fibonacciPixelLevels(fib(), (t) => (t === 200 ? null : t), (p) => p);
    expect(levels).toBeNull();
  });

  it("returns null when any level's price is off-scale", () => {
    const levels = fibonacciPixelLevels(
      fib({ time: 0, price: 0 }, { time: 1, price: 100 }),
      (t) => t,
      (p) => (p === 50 ? null : p),
    );
    expect(levels).toBeNull();
  });
});

describe("fibonacciHitCandidates", () => {
  it("produces one hit candidate per level, all sharing the drawing's id", () => {
    const levels = fibonacciPixelLevels(fib(), (t) => t, (p) => p)!;
    const candidates = fibonacciHitCandidates("f1", levels);
    expect(candidates).toHaveLength(FIBONACCI_LEVELS.length);
    expect(candidates.every((c) => c.id === "f1")).toBe(true);
    expect(candidates[3].segment).toEqual({ x1: 100, y1: levels[3].y, x2: 200, y2: levels[3].y });
  });
});
