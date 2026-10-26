import { afterEach, describe, expect, it } from "vitest";
import { LARGE_TRADE_BUBBLES_LOOKBACK, largeTradeBubblesIndicator } from "../../../indicators/large-trade-bubbles/largeTradeBubbles";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import { sumPrintsIn } from "../../indicatorTicks";
import { MINUTE_MS, seeded, tradeFrame, trendBars } from "../fixtures";
import { driveLive } from "../liveDrive";
import { busyTapeFor, candleOf, historyTapeOf, tapeOf, ticksOf, whaleVersusCrowd } from "../syntheticTape";
import type { Arrival } from "../fixtures";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

describe("whale versus crowd", () => {
  it("one whale print and one hundred small prints make the same candle", () => {
    const { whale, crowd, candle, whaleCandle, crowdCandle } = whaleVersusCrowd({ pathPrints: 20 });
    expect(whale).toHaveLength(21);
    expect(crowd).toHaveLength(120);
    expect(crowd.reduce((sum, print) => sum + print.size, 0)).toBeCloseTo(whale.reduce((sum, print) => sum + print.size, 0), 8);
    const { trade_count: whaleCount, ...whaleRest } = whaleCandle;
    const { trade_count: crowdCount, ...crowdRest } = crowdCandle;
    expect(whaleRest).toEqual(crowdRest);
    expect(candle.trade_count).toBeNull();
    // The print count is the only honest difference between the two candles.
    expect(whaleCount).toBe(21);
    expect(crowdCount).toBe(120);
  });

  it("the tapes report complete live coverage of the bar, so a tick indicator may trust them", () => {
    const { whaleTape, crowdTape, candle } = whaleVersusCrowd();
    for (const tape of [whaleTape, crowdTape]) {
      expect(ticksOf(tape).coverageOf(candle.ts_open, candle.ts_open + MINUTE_MS)).toBe("all");
    }
    expect(sumPrintsIn(whaleTape.prints, candle.ts_open, candle.ts_open + MINUTE_MS).volume).toBeCloseTo(candle.volume, 4);
  });

  it("Large Trade Bubbles tells them apart: the whale draws a bubble, the crowd draws none", () => {
    const warmup = trendBars({ count: LARGE_TRADE_BUBBLES_LOOKBACK, driftPerBar: 0, noise: 1 }).bars;
    const random = seeded(2);
    const warmupArrivals: Arrival[] = warmup.map((bar) => ({
      bar,
      trades: [tradeFrame(bar.ts_open + 1_000, bar.close, Math.round((0.4 + random() * 0.2) * 1e4) / 1e4)],
      tradeAvailability: "LIVE_COMPLETE",
    }));
    const ts_open = warmup[warmup.length - 1].ts_open + MINUTE_MS;
    const pair = whaleVersusCrowd({ ts_open, price: warmup[warmup.length - 1].close, whaleSize: 50 });
    const settings = { multiplier: 3 };
    const whaleRun = driveLive(largeTradeBubblesIndicator, [...warmupArrivals, { bar: pair.candle, trades: pair.whale, tradeAvailability: "LIVE_COMPLETE" }], settings);
    const crowdRun = driveLive(largeTradeBubblesIndicator, [...warmupArrivals, { bar: pair.candle, trades: pair.crowd, tradeAvailability: "LIVE_COMPLETE" }], settings);
    expect(whaleRun.markers).toHaveLength(1);
    expect(whaleRun.markers[0]).toMatchObject({ time: ts_open, shape: "circle", position: "atPriceMiddle", price: pair.candle.close });
    expect(crowdRun.markers).toHaveLength(0);
  });
});

describe("tape builders", () => {
  it("a live tape sorts late prints into place, so arrival order does not change a window's sum", () => {
    const base = 1_780_000_000_000;
    const prints = [tradeFrame(base + 5_000, 100, 1), tradeFrame(base + 1_000, 101, 2), tradeFrame(base + 3_000, 99, 3)];
    const inOrder = tapeOf([...prints].sort((a, b) => a.ts_exchange - b.ts_exchange), base);
    const shuffled = tapeOf(prints, base);
    expect(shuffled.prints.map((print) => print.ts)).toEqual(inOrder.prints.map((print) => print.ts));
    expect(sumPrintsIn(shuffled.prints, base, base + MINUTE_MS)).toEqual(sumPrintsIn(inOrder.prints, base, base + MINUTE_MS));
  });

  it("a duplicate print id is dropped rather than counted twice", () => {
    const base = 1_780_000_000_000;
    const print = tradeFrame(base + 1_000, 100, 1, "buy", undefined, "same-id");
    const tape = tapeOf([print, print], base);
    expect(tape.prints).toHaveLength(1);
  });

  it("a history tape above a floor reads as thin, and served in full reads as all", () => {
    const base = 1_780_000_000_000;
    const prints = [tradeFrame(base + 1_000, 100, 7)];
    expect(ticksOf(historyTapeOf(prints, 5, base, base + MINUTE_MS)).coverageOf(base, base + MINUTE_MS)).toBe("thin");
    expect(ticksOf(historyTapeOf(prints, 0, base, base + MINUTE_MS)).coverageOf(base, base + MINUTE_MS)).toBe("all");
    expect(ticksOf(historyTapeOf(prints, 0, base, base + MINUTE_MS)).coverageOf(base + 2 * MINUTE_MS, base + 3 * MINUTE_MS)).toBe("none");
  });

  it("candleOf builds the candle its prints make", () => {
    const base = 1_780_000_000_000;
    const prints = [tradeFrame(base + 1_000, 100, 1, "buy"), tradeFrame(base + 2_000, 105, 2, "sell"), tradeFrame(base + 3_000, 98, 1, "buy")];
    const candle = candleOf(prints, base);
    expect(candle).toMatchObject({ open: 100, high: 105, low: 98, close: 98, volume: 4, buy_volume: 2, sell_volume: 2, trade_count: 3, closed: true });
  });

  it("a busy tape puts every print inside its bar's window and range", () => {
    const { bars } = trendBars({ count: 20 });
    const tape = busyTapeFor(bars, { printsPerBar: 40 });
    expect(tape.size).toBe(20);
    for (const bar of bars) {
      const prints = tape.get(bar.ts_open)!;
      expect(prints).toHaveLength(40);
      for (const print of prints) {
        expect(print.ts_exchange).toBeGreaterThanOrEqual(bar.ts_open);
        expect(print.ts_exchange).toBeLessThan(bar.ts_open + bar.interval_ms);
        expect(print.price).toBeGreaterThanOrEqual(bar.low);
        expect(print.price).toBeLessThanOrEqual(bar.high);
      }
    }
  });
});
