import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import {
  cvdAlignmentToleranceBars,
  detectDivergences,
  findSwingHighs,
  findSwingLows,
  MAX_SWING_LENGTH,
  MIN_SWING_LENGTH,
} from "../deltaDivergence";

function bar(
  index: number,
  close: number,
  { high = close, low = close, closed = true, provider = "BINANCE" }: {
    high?: number;
    low?: number;
    closed?: boolean;
    provider?: "BINANCE" | "DXFEED";
  } = {},
): BarFrame {
  return {
    type: "bar",
    provider,
    ...(provider === "BINANCE" ? { marketKind: "SPOT", symbol: "BTC-USDT" } : { assetClass: "FUTURE", symbol: "/NQU26:XCME" }),
    interval_ms: 60_000,
    ts_open: index * 60_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    buy_volume: 50,
    trade_count: 10,
    closed,
  } as BarFrame;
}

function series(
  closes: readonly number[],
  cvd: readonly number[],
  provider: "BINANCE" | "DXFEED" = "BINANCE",
) {
  const bars = closes.map((close, index) => bar(index, close, { provider }));
  const delta = cvd.map((value, index) => index === 0 ? value : value - cvd[index - 1]);
  return { bars, delta, cvd };
}

describe("close-based price pivots", () => {
  it("uses candle closes rather than a wick that briefly traded through the pivot", () => {
    const bars = [
      bar(0, 8), bar(1, 9), bar(2, 10), bar(3, 9, { high: 50 }), bar(4, 8),
    ];
    expect(findSwingHighs(bars, 2)).toEqual([{ index: 2, ts_open: 120_000, price: 10 }]);
  });

  it("requires completed candles on both sides, so a live bar cannot confirm then retract a pivot", () => {
    const bars = [
      bar(0, 8), bar(1, 9), bar(2, 10), bar(3, 9, { closed: false }), bar(4, 8),
    ];
    expect(findSwingHighs(bars, 2)).toEqual([]);
  });

  it("retains strict ties for deterministic price structure", () => {
    const bars = [
      bar(0, 8), bar(1, 9), bar(2, 10), bar(3, 10), bar(4, 8),
    ];
    expect(findSwingHighs(bars, 1)).toEqual([]);
  });

  it("finds mirror-image close-based swing lows", () => {
    const bars = [
      bar(0, 12), bar(1, 11), bar(2, 10), bar(3, 11), bar(4, 12),
    ];
    expect(findSwingLows(bars, 2)).toEqual([{ index: 2, ts_open: 120_000, price: 10 }]);
  });
});

describe("CVD alignment tolerance", () => {
  it("is derived from Swing length rather than exposing another sensitivity control", () => {
    expect(cvdAlignmentToleranceBars(1)).toBe(1);
    expect(cvdAlignmentToleranceBars(3)).toBe(1);
    expect(cvdAlignmentToleranceBars(5)).toBe(2);
    expect(cvdAlignmentToleranceBars(8)).toBe(3);
  });
});

describe("detectDivergences", () => {
  it("flags a bearish divergence from higher confirmed close highs and lower nearby CVD highs", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 8, 7, 6],
    );

    const divergences = detectDivergences(bars, delta, cvd, 2);

    expect(divergences).toEqual([expect.objectContaining({
      type: "bearish",
      priceFrom: expect.objectContaining({ index: 2, price: 10 }),
      priceTo: expect.objectContaining({ index: 7, price: 11 }),
      cvdFrom: expect.objectContaining({ index: 2, value: 10 }),
      cvdTo: expect.objectContaining({ index: 7, value: 8 }),
      reasons: ["CONFIRMED_CLOSE_SWINGS", "SAME_CVD_EPOCH", "CVD_ALIGNED_WITHIN_TOLERANCE", "PRICE_HIGHER_HIGH", "CVD_LOWER_OR_EQUAL_HIGH"],
    })]);
  });

  it("flags a bullish divergence from lower confirmed close lows and higher nearby CVD lows", () => {
    const { bars, delta, cvd } = series(
      [12, 11, 10, 11, 12, 11, 10, 9, 10, 11],
      [5, 3, 1, 2, 4, 5, 5, 4, 5, 6],
    );

    const divergences = detectDivergences(bars, delta, cvd, 2);

    expect(divergences).toEqual([expect.objectContaining({
      type: "bullish",
      priceFrom: expect.objectContaining({ index: 2, price: 10 }),
      priceTo: expect.objectContaining({ index: 7, price: 9 }),
      cvdFrom: expect.objectContaining({ value: 1 }),
      cvdTo: expect.objectContaining({ value: 4 }),
    })]);
  });

  it("treats flat CVD as a real failure to confirm a higher price high", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 10, 7, 6],
    );

    const divergences = detectDivergences(bars, delta, cvd, 2);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({ type: "bearish", cvdFrom: { value: 10 }, cvdTo: { value: 10 } });
  });

  it("matches a nearby CVD peak rather than requiring it to land on the exact price-pivot bar", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 4, 7, 10, 8, 7, 9, 8, 6, 5],
    );

    const [divergence] = detectDivergences(bars, delta, cvd, 2);
    expect(divergence).toMatchObject({
      type: "bearish",
      cvdFrom: { index: 3, value: 10 }, // one bar after the first price high
      cvdTo: { index: 6, value: 9 }, // one bar before the second price high
    });
  });

  it("does not compare across a CVD epoch break", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 8, 7, 6],
    );
    const gappedDelta: (number | null)[] = [...delta];
    gappedDelta[4] = null;
    const gappedCvd: (number | null)[] = [...cvd];
    gappedCvd[4] = null;

    expect(detectDivergences(bars, gappedDelta, gappedCvd, 2)).toEqual([]);
  });

  it("does not compare across an omitted price bucket even if the later displayed bar has a finite delta", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 8, 7, 6],
    );
    const gappedBars = bars.map((entry, index) => index >= 4
      ? { ...entry, ts_open: entry.ts_open + 60_000 }
      : entry);

    expect(detectDivergences(gappedBars, delta, cvd, 2)).toEqual([]);
  });

  it("uses the same deterministic method for a dxFeed BarFrame", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 8, 7, 6],
      "DXFEED",
    );
    expect(detectDivergences(bars, delta, cvd, 2)).toHaveLength(1);
  });

  it("does not repaint a confirmed signal when later completed bars arrive", () => {
    const { bars, delta, cvd } = series(
      [8, 9, 10, 9, 8, 9, 10, 11, 10, 9],
      [1, 5, 10, 9, 7, 6, 7, 8, 7, 6],
    );
    const confirmed = detectDivergences(bars, delta, cvd, 2);
    const extension = series([8, 7, 8, 9], [5, 4, 5, 6]);
    const extendedBars = [...bars, ...extension.bars.map((entry, index) => ({ ...entry, ts_open: (bars.length + index) * 60_000 }))];
    const extendedDelta = [...delta, ...extension.delta];
    const extendedCvd = [...cvd, ...extension.cvd.map((value) => value + cvd.at(-1)!)];

    expect(detectDivergences(extendedBars, extendedDelta, extendedCvd, 2).filter((entry) => entry.priceTo.index <= 7))
      .toEqual(confirmed);
  });

  it("rejects malformed parallel inputs rather than silently losing candidates", () => {
    const { bars, delta, cvd } = series([8, 9, 10, 9, 8], [1, 2, 3, 2, 1]);
    expect(() => detectDivergences(bars, delta.slice(0, -1), cvd, 2)).toThrow(/identical lengths/);
    expect(() => detectDivergences(bars, delta, [1, 2, Number.NaN, 2, 1], 2)).toThrow(/finite or null/);
  });
});

// A2.20 / L1L2-V2-086. P4.03's product contract says "Swing length, from 2 to
// 8 completed bars". MIN_SWING_LENGTH and MAX_SWING_LENGTH are exported from
// this very module and the settings modal enforces both -- but the function
// they sit beside only checked for a positive integer, so it accepted 1 or
// 100. A contract enforced at the UI rather than at the boundary that
// publishes it holds only as long as the UI is the only caller.
describe("swingLength bounds", () => {
  it("rejects a swing length outside the range the module itself publishes", () => {
    for (const bad of [1, 0.5, 9, 100]) {
      expect(() => detectDivergences([], [], [], bad)).toThrow(/swingLength/);
    }
  });

  it("accepts every value inside the published range, including both endpoints", () => {
    for (let n = MIN_SWING_LENGTH; n <= MAX_SWING_LENGTH; n += 1) {
      expect(() => detectDivergences([], [], [], n)).not.toThrow();
    }
  });
});
