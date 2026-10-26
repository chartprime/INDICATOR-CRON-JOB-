import { describe, it, expect } from "vitest";
import {
  calculateOhlcDeltaProfile,
  calculateVolumeDeltaProfileBins,
  calculateValueAreaLevels,
  type VolumeDeltaProfileBin,
} from "../volumeDeltaProfileOhlc";
import type { BarFrame } from "../../../../types/frames";

describe("calculateOhlcDeltaProfile", () => {
  it("should calculate delta correctly for a single bar", () => {
    const bars: BarFrame[] = [
      {
        type: "bar",
        symbol: "BTCUSDT",
        interval_ms: 60000,
        ts_open: 1000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        buy_volume: 600,
        trade_count: 50,
        closed: true,
        provider: "binance",
      } as unknown as BarFrame,
    ];

    const result = calculateOhlcDeltaProfile(bars);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      buyVolume: 600,
      sellVolume: 400, // 1000 - 600
      delta: 200, // 600 - 400
      totalVolume: 1000,
      deltaKnown: true,
    });
  });

  it("marks delta unknown when buy_volume is absent instead of implying all-sell (W6.01 B06)", () => {
    const bars: BarFrame[] = [
      {
        type: "bar",
        symbol: "BTCUSDT",
        interval_ms: 60000,
        ts_open: 1000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        trade_count: 50,
        closed: true,
        provider: "binance",
      } as unknown as BarFrame,
    ];

    const result = calculateOhlcDeltaProfile(bars);

    expect(result[0].deltaKnown).toBe(false);
    expect(result[0].buyVolume).toBe(0);
    expect(result[0].sellVolume).toBe(0); // not fabricated as all-sell
    expect(result[0].delta).toBe(0); // was -1000 before the B06 fix
    expect(result[0].totalVolume).toBe(1000); // real volume is still real
  });

  it("should process multiple bars", () => {
    const bars: BarFrame[] = [
      {
        type: "bar",
        symbol: "BTCUSDT",
        interval_ms: 60000,
        ts_open: 1000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        buy_volume: 700,
        trade_count: 50,
        closed: true,
        provider: "binance",
      } as unknown as BarFrame,
      {
        type: "bar",
        symbol: "BTCUSDT",
        interval_ms: 60000,
        ts_open: 2000,
        open: 105,
        high: 115,
        low: 95,
        close: 110,
        volume: 800,
        buy_volume: 300,
        trade_count: 40,
        closed: true,
        provider: "binance",
      } as unknown as BarFrame,
    ];

    const result = calculateOhlcDeltaProfile(bars);

    expect(result).toHaveLength(2);
    expect(result[0].delta).toBe(400); // 700 - 300
    expect(result[1].delta).toBe(-200); // 300 - 500
  });
});

describe("calculateVolumeDeltaProfileBins — missing buy_volume (W6.01 B06)", () => {
  function bar(overrides: Partial<BarFrame>): BarFrame {
    return {
      type: "bar",
      symbol: "BTCUSDT",
      interval_ms: 60000,
      ts_open: 1000,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1000,
      trade_count: 50,
      closed: true,
      provider: "binance",
      ...overrides,
    } as unknown as BarFrame;
  }

  it("keeps real total volume but does not fabricate a side split for side-less bars", () => {
    const { bins } = calculateVolumeDeltaProfileBins([
      bar({ close: 95, buy_volume: 600 }),
      bar({ close: 105 }), // no buy_volume: side unknown
    ]);

    const total = bins.reduce((n, b) => n + b.totalVolume, 0);
    const known = bins.reduce((n, b) => n + b.knownVolume, 0);
    const sideAttributed = bins.reduce((n, b) => n + b.buyVolume + b.sellVolume, 0);

    expect(total).toBeCloseTo(2000, 6); // both bars' volume is real
    expect(known).toBeCloseTo(1000, 6); // only the bar that reported a side
    expect(sideAttributed).toBeCloseTo(1000, 6); // the side-less bar contributes 0 buy and 0 sell
  });
});

describe("calculateValueAreaLevels", () => {
  function makeBin(price: number, totalVolume: number): VolumeDeltaProfileBin {
    return { price, buyVolume: totalVolume / 2, sellVolume: totalVolume / 2, delta: 0, totalVolume, knownVolume: totalVolume };
  }

  it("extends VAH above and VAL below the boundary bins' own prices, not inside them", () => {
    const bucketHeight = 10;
    const bins = [
      makeBin(10, 10),
      makeBin(20, 20),
      makeBin(30, 100),
      makeBin(40, 20),
      makeBin(50, 10),
    ];

    const levels = calculateValueAreaLevels(bins, bucketHeight, 70);

    expect(levels).not.toBeNull();
    expect(levels!.poc).toBe(30);
    expect(levels!.vah).toBeGreaterThan(40);
    expect(levels!.val).toBeLessThan(30);
    expect(levels!.vah).toBe(45);
    expect(levels!.val).toBe(25);
  });

  it("returns null for an empty bin array or zero total volume", () => {
    expect(calculateValueAreaLevels([], 10, 70)).toBeNull();
    expect(calculateValueAreaLevels([makeBin(10, 0)], 10, 70)).toBeNull();
  });
});
