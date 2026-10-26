import { describe, expect, it } from "vitest";
import type { Time } from "lightweight-charts";
import { AggressiveOrdersPrimitive, candleX } from "../aggressiveOrdersPrimitive";
import type { AggressiveTape, OrderCluster } from "../aggressiveTape";

// An NQ-like minute chart over the daily break: candles at 10:00 and 10:01, the chart's one whitespace bar for the
// hole, then 11:02 and 11:03. The chart lays its slots ten pixels apart, centred at 5, 15, 25 (the break), 35, 45.
const T = 1_790_000_000_000 - (1_790_000_000_000 % 60_000);
const MIN = 60_000;
const TIMES = [T, T + MIN, T + 2 * MIN, T + 62 * MIN, T + 63 * MIN];
const bars = [{ time: T / 1000, close: 100 }, { time: (T + MIN) / 1000, close: 100 }, { time: (T + 2 * MIN) / 1000 }, { time: (T + 62 * MIN) / 1000, close: 100 }, { time: (T + 63 * MIN) / 1000, close: 100 }];
const centerOf = (time: Time) => {
  const index = TIMES.indexOf(Number(time) * 1000);
  return index < 0 ? null : index * 10 + 5;
};

function cluster(ts: number, side: "buy" | "sell" = "sell", volume = 300): OrderCluster {
  return { side, ts, lastTs: ts, fedAt: -Infinity, price: 100, lastPrice: 100, minPrice: 100, maxPrice: 100, vwap: 100, volume, count: 1 };
}

describe("candleX", () => {
  it("places a moment inside its candle's slot, as far along as it is through the candle; a moment in a session break at the right edge of the candle before it; one before the first candle nowhere", () => {
    expect(candleX(bars, T + 30_000, MIN, 10, centerOf)).toBe(5);
    expect(candleX(bars, T + MIN + 45_000, MIN, 10, centerOf)).toBe(17.5);
    expect(candleX(bars, T + 62 * MIN, MIN, 10, centerOf)).toBe(30);
    expect(candleX(bars, T + 63 * MIN + 59_999, MIN, 10, centerOf)).toBeCloseTo(50, 1);
    // 10:30, deep in the break: the whitespace bar is the candle before it, and the moment sits at its right edge, not an hour's worth of bars to the right.
    expect(candleX(bars, T + 30 * MIN, MIN, 10, centerOf)).toBe(30);
    expect(candleX(bars, T - 1, MIN, 10, centerOf)).toBeNull();
    expect(candleX(bars, T + 30_000, MIN, 10, () => null)).toBeNull();
  });
});

describe("AggressiveOrdersPrimitive on a chart with a session break", () => {
  it("draws each bubble on the candle its print belongs to, whatever holes the chart has before or after it", () => {
    // Four prints: in the first candle, three quarters through the second, at the open of the first candle after the
    // break, and in the last candle. A line from the last candle (the old placement) would put the first two more than
    // sixty bars left of their candles, off the pane: they were not drawn at all on NQ, and the ones that were sat a
    // hole's width from their candles.
    const prints = [cluster(T + 30_000), cluster(T + MIN + 45_000, "buy"), cluster(T + 62 * MIN), cluster(T + 63 * MIN + 30_000, "buy")];
    const tape = {
      subscribe: () => () => {},
      clockMs: () => Date.now(),
      historical: false,
      floor: () => 0,
      autoFloor: () => 100,
      bubbles: (_rules: unknown, _now: number, fromMs: number, toMs: number) => prints.filter((print) => print.ts >= fromMs && print.ts <= toMs),
    } as unknown as AggressiveTape;
    const timeScale = { options: () => ({ barSpacing: 10 }), width: () => 1000, timeToCoordinate: centerOf, getVisibleRange: () => ({ from: bars[0].time as Time, to: bars[bars.length - 1].time as Time }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => bars, priceToCoordinate: (price: number) => 500 - price };
    const primitive = new AggressiveOrdersPrimitive({ buy: "#fff", sell: "#000", stroke: "#111" });
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AggressiveOrdersPrimitive["attached"]>[0]);
    primitive.setTape(tape);
    primitive.updateAllViews();
    const drawn = [...primitive.bubbles].sort((a, b) => a.ts - b.ts).map((bubble) => [bubble.side, bubble.x]);
    expect(drawn).toEqual([["sell", 5], ["buy", 17.5], ["sell", 30], ["buy", 45]]);
    primitive.detached();
  });

  it("asks the tape for the chart's visible stretch, a candle each side, not for a stretch read off a straight line", () => {
    const asked: [number, number][] = [];
    const tape = {
      subscribe: () => () => {},
      clockMs: () => Date.now(),
      historical: false,
      floor: () => 0,
      autoFloor: () => 100,
      bubbles: (_rules: unknown, _now: number, fromMs: number, toMs: number) => { asked.push([fromMs, toMs]); return []; },
    } as unknown as AggressiveTape;
    const timeScale = { options: () => ({ barSpacing: 10 }), width: () => 1000, timeToCoordinate: centerOf, getVisibleRange: () => ({ from: bars[1].time as Time, to: bars[3].time as Time }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => bars, priceToCoordinate: (price: number) => 500 - price };
    const primitive = new AggressiveOrdersPrimitive({ buy: "#fff", sell: "#000", stroke: "#111" });
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AggressiveOrdersPrimitive["attached"]>[0]);
    primitive.setTape(tape);
    primitive.updateAllViews();
    expect(asked).toEqual([[T, T + 64 * MIN]]);
    // No visible range yet (an empty time scale): the whole chart.
    timeScale.getVisibleRange = () => null as never;
    primitive.updateAllViews();
    expect(asked[1]).toEqual([T - MIN, T + 65 * MIN]);
    primitive.detached();
  });
});
