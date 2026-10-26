import { describe, expect, it } from "vitest";
import { computeOrderBlockL1Stats, type BarStats } from "../l1OrderBlockEvidence";

const bar = (buy_volume: number | null, sell_volume: number | null): BarStats => ({
  time: 1,
  high: 2,
  low: 1,
  close: 1.5,
  volume: 100,
  buy_volume,
  sell_volume,
});

describe("computeOrderBlockL1Stats", () => {
  it("retains an explicit zero buy side as an all-sell bar", () => {
    expect(computeOrderBlockL1Stats([bar(0, 100)], "bullish", 1, 2)).toEqual({
      buyVolume: 0, sellVolume: 100, delta: -100, totalVolume: 100, unknownVolume: 0,
    });
  });

  it("does not classify unsided volume as selling", () => {
    expect(computeOrderBlockL1Stats([bar(30, 20)], "bullish", 1, 2)).toEqual({
      buyVolume: 30, sellVolume: 20, delta: 10, totalVolume: 100, unknownVolume: 50,
    });
  });

  it("does not invent delta when the source has no sided flow", () => {
    expect(computeOrderBlockL1Stats([bar(null, null)], "bullish", 1, 2)).toEqual({
      buyVolume: 0, sellVolume: 0, delta: null, totalVolume: 100, unknownVolume: 100,
    });
  });
});
