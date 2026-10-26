import { describe, expect, it } from "vitest";
import { DEFAULT_LEG_SETTINGS, SESSION_GAP_INTERVALS, atrSeries, barIntervalOf, catchLegs, type LegBar } from "../legCatcher";

const T = 1_790_000_000;

function bar(i: number, open: number, high: number, low: number, close: number, time = T + i * 60): LegBar {
  return { time, open, high, low, close };
}

function flat(count: number, price = 100, range = 1, from = 0): LegBar[] {
  return Array.from({ length: count }, (_, k) => bar(from + k, price, price + range / 2, price - range / 2, price));
}

function ramp(count: number, from: number, step: number, fromIndex: number, startTime = T): LegBar[] {
  return Array.from({ length: count }, (_, k) => {
    const open = from + k * step;
    const close = open + step;
    const [low, high] = step >= 0 ? [open, close] : [close, open];
    return { time: startTime + (fromIndex + k) * 60, open, high, low, close };
  });
}

describe("atrSeries", () => {
  it("is Wilder's average true range: a flat start, then the running average of the true range with the previous close", () => {
    const bars = [...flat(14), bar(14, 100, 105, 100, 105), bar(15, 105, 105, 103, 103)];
    const atr = atrSeries(bars, 14);
    expect(atr.slice(0, 13).every((x) => Number.isNaN(x))).toBe(true);
    expect(atr[13]).toBe(1);
    expect(atr[14]).toBeCloseTo((13 + 5) / 14);
    expect(atr[15]).toBeCloseTo((atr[14] * 13 + 2) / 14);
    expect(atrSeries([], 14)).toEqual([]);
    expect(atrSeries(bars, 0).every((x) => Number.isNaN(x))).toBe(true);
  });

  it("the bar interval is the smallest step between the first bars", () => {
    expect(barIntervalOf(flat(5))).toBe(60);
    expect(barIntervalOf([bar(0, 1, 1, 1, 1, T), bar(1, 1, 1, 1, 1, T + 900), bar(2, 1, 1, 1, 1, T + 1800)])).toBe(900);
    expect(barIntervalOf([])).toBe(60);
  });
});

describe("catchLegs", () => {
  const settings = { ...DEFAULT_LEG_SETTINGS, atrMultiple: 8, reverseAtr: 3, minEfficiency: 0.5 };

  it("a straight rise of many ATR is one leg from the last low of the base to its extreme, open until price pulls back the reversal size", () => {
    const warm = flat(20);
    const rise = ramp(12, 100, 1, 20);
    const legs = catchLegs([...warm, ...rise], settings);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ side: "up", startIndex: 19, startPrice: 99.5, extremeIndex: 31, extremePrice: 112, size: 12.5, atr: 1, sizeAtr: 12.5, efficiency: 1, candles: 12, open: true });
    expect(legs[0].startTime).toBe(T + 19 * 60);
    expect(legs[0].extremeTime).toBe(T + 31 * 60);
  });

  it("the leg closes on a pullback of the reversal size and the next leg starts at its extreme; a pullback short of it keeps the leg running", () => {
    const warm = flat(20);
    const rise = ramp(12, 100, 1, 20);
    const dip = [bar(32, 112, 112, 110, 110)];
    expect(catchLegs([...warm, ...rise, ...dip], settings)[0].open).toBe(true);
    const fall = ramp(10, 112, -1, 32);
    const legs = catchLegs([...warm, ...rise, ...fall], settings);
    expect(legs.map((leg) => [leg.side, leg.open, leg.startPrice, leg.extremePrice])).toEqual([["up", false, 99.5, 112], ["down", true, 112, 102]]);
    expect(legs[1]).toMatchObject({ startIndex: 31, sizeAtr: 10 });
  });

  it("a leg under the ATR multiple, or a wandering one under the straightness floor, is not a leg", () => {
    const warm = flat(20);
    const small = ramp(5, 100, 1, 20);
    expect(catchLegs([...warm, ...small, ...ramp(4, 105, -1, 25)], settings)).toEqual([]);
    const zig = Array.from({ length: 24 }, (_, k) => {
      const base = 100 + Math.floor(k / 2);
      return k % 2 === 0 ? bar(20 + k, base, base + 2, base, base + 2) : bar(20 + k, base + 2, base + 2, base + 1, base + 1);
    });
    expect(catchLegs([...warm, ...zig], { ...settings, minEfficiency: 0.5 })).toEqual([]);
    const [wander] = catchLegs([...warm, ...zig], { ...settings, minEfficiency: 0.2 });
    expect(wander).toMatchObject({ side: "up", open: true, extremePrice: 113 });
    expect(wander.efficiency).toBeGreaterThan(0.3);
    expect(wander.efficiency).toBeLessThan(0.4);
  });

  it("the ATR that sizes a leg is the one at the leg's pivot, so a leg does not inflate its own yardstick", () => {
    const warm = flat(20, 100, 1);
    const wild = ramp(12, 100, 4, 20);
    const [leg] = catchLegs([...warm, ...wild], settings);
    expect(leg.atr).toBe(1);
    expect(leg.sizeAtr).toBe(48.5);
  });

  it("a session gap ends the running leg and resets the structure: no leg bridges it, and the bars after it start afresh", () => {
    const warm = flat(20);
    const rise = ramp(12, 100, 1, 20);
    const after = ramp(12, 112, -1, 33, T + SESSION_GAP_INTERVALS * 60 + 60);
    const legs = catchLegs([...warm, ...rise, ...after], settings);
    expect(legs.map((leg) => [leg.side, leg.open, leg.startPrice])).toEqual([["up", false, 99.5], ["down", true, 112]]);
    const later = [...flat(20, 112, 1, 40).map((b, k) => ({ ...b, time: T + 40 * 60 + 3600 + k * 60 })), ...ramp(12, 112, -1, 60, T + 3600)];
    const second = catchLegs([...warm, ...rise, ...later], settings);
    expect(second.map((leg) => [leg.side, leg.open, leg.startPrice, leg.extremePrice])).toEqual([["up", false, 99.5, 112], ["down", true, 112.5, 100]]);
  });

  it("nothing is read before the ATR exists", () => {
    expect(catchLegs(ramp(10, 100, 2, 0), settings)).toEqual([]);
    expect(catchLegs([], settings)).toEqual([]);
  });
});
