import { describe, expect, it } from "vitest";
import { computeCvdCandles } from "../cvdCandles";
import { computeCVD, computeDeltaPerBar } from "../orderFlow";
import { resampleBars } from "../../../chart/resampleBars";
import type { BarFrame } from "../../../../types/frames";

const ONE_MINUTE = 60_000;

function bar(tsOpen: number, volume: number, buyVolume: number | undefined, close = 100): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    interval_ms: ONE_MINUTE, ts_open: tsOpen, open: 100, high: 101, low: 99, close,
    volume, trade_count: 10, closed: true,
    ...(buyVolume === undefined ? {} : { buy_volume: buyVolume }),
  } as BarFrame;
}

describe("computeCvdCandles", () => {
  it("builds a real intrabar path from the lower-timeframe bars, not just open and close", () => {
    // Deltas within one 5m bucket: +10, -30, +40 -> path 0, 10, -20, 20.
    const source = [
      bar(0, 100, 55), // delta +10
      bar(ONE_MINUTE, 100, 35), // delta -30
      bar(2 * ONE_MINUTE, 100, 70), // delta +40
    ];
    const display = [bar(0, 300, 160)];
    const [candle] = computeCvdCandles(display, source, 5 * ONE_MINUTE);

    expect(candle).toEqual({ ts_open: 0, open: 0, high: 20, low: -20, close: 20 });
  });

  it("the close of every candle equals the line CVD for the same bar -- the two renderings cannot disagree", () => {
    const source = [
      bar(0, 100, 55), bar(ONE_MINUTE, 100, 35), bar(2 * ONE_MINUTE, 100, 70),
      bar(3 * ONE_MINUTE, 100, 60), bar(4 * ONE_MINUTE, 100, 20),
      bar(5 * ONE_MINUTE, 100, 80), bar(6 * ONE_MINUTE, 100, 45),
    ];
    const display = resampleBars(source, 5 * ONE_MINUTE);
    const lineCvd = computeCVD(computeDeltaPerBar(display));
    const candles = computeCvdCandles(display, source, 5 * ONE_MINUTE);

    expect(candles).toHaveLength(display.length);
    candles.forEach((candle, index) => {
      expect(candle?.close).toBeCloseTo(lineCvd[index] as number, 9);
    });
  });

  it("each candle opens exactly where the previous one closed, within an epoch", () => {
    const source = [
      bar(0, 100, 55), bar(ONE_MINUTE, 100, 35),
      bar(2 * ONE_MINUTE, 100, 70), bar(3 * ONE_MINUTE, 100, 60),
    ];
    const display = resampleBars(source, 2 * ONE_MINUTE);
    const candles = computeCvdCandles(display, source, 2 * ONE_MINUTE);

    for (let i = 1; i < candles.length; i += 1) {
      expect(candles[i]?.open).toBeCloseTo(candles[i - 1]?.close as number, 9);
    }
  });

  it("high and low always contain the open and close, so the body never escapes the wick", () => {
    const source = [bar(0, 100, 90), bar(ONE_MINUTE, 100, 10)];
    const display = [bar(0, 200, 100)];
    const [candle] = computeCvdCandles(display, source, 2 * ONE_MINUTE);

    expect(candle!.high).toBeGreaterThanOrEqual(Math.max(candle!.open, candle!.close));
    expect(candle!.low).toBeLessThanOrEqual(Math.min(candle!.open, candle!.close));
  });

  it("a bucket with any incomplete constituent is a gap, not a partial sum presented as real", () => {
    const source = [bar(0, 100, 55), bar(ONE_MINUTE, 100, undefined)];
    const display = [bar(0, 200, undefined)];

    expect(computeCvdCandles(display, source, 2 * ONE_MINUTE)).toEqual([null]);
  });

  it("a gap restarts the cumulative epoch, exactly as the line does", () => {
    const source = [
      bar(0, 100, 55), // +10
      bar(ONE_MINUTE, 100, undefined), // gap
      bar(2 * ONE_MINUTE, 100, 70), // +40
    ];
    const display = [bar(0, 100, 55), bar(ONE_MINUTE, 100, undefined), bar(2 * ONE_MINUTE, 100, 70)];
    const candles = computeCvdCandles(display, source, ONE_MINUTE);

    expect(candles[0]).toEqual({ ts_open: 0, open: 0, high: 10, low: 0, close: 10 });
    expect(candles[1]).toBeNull();
    expect(candles[2]).toEqual({ ts_open: 2 * ONE_MINUTE, open: 0, high: 40, low: 0, close: 40 });
  });

  it("a display bar with no source coverage is a gap rather than a fabricated flat candle", () => {
    const display = [bar(0, 100, 55)];
    expect(computeCvdCandles(display, [], ONE_MINUTE)).toEqual([null]);
  });

  it("resets after an omitted displayed bucket, so a higher-timeframe price gap cannot bridge CVD epochs", () => {
    const source = [bar(0, 100, 55), bar(2 * ONE_MINUTE, 100, 70)];
    const display = [bar(0, 100, 55), bar(2 * ONE_MINUTE, 100, 70)];

    expect(computeCvdCandles(display, source, ONE_MINUTE)).toEqual([
      { ts_open: 0, open: 0, high: 10, low: 0, close: 10 },
      { ts_open: 2 * ONE_MINUTE, open: 0, high: 40, low: 0, close: 40 },
    ]);
  });

  it("at the source timeframe itself a candle has a body but no wick -- there is no finer data to draw one from", () => {
    const source = [bar(0, 100, 55)];
    const [candle] = computeCvdCandles([bar(0, 100, 55)], source, ONE_MINUTE);

    expect(candle).toEqual({ ts_open: 0, open: 0, high: 10, low: 0, close: 10 });
    expect(candle!.high).toBe(Math.max(candle!.open, candle!.close));
    expect(candle!.low).toBe(Math.min(candle!.open, candle!.close));
  });

  it("rejects an invalid interval rather than bucketing everything into one candle", () => {
    expect(() => computeCvdCandles([], [], 0)).toThrow(/intervalMs/);
    expect(() => computeCvdCandles([], [], -1)).toThrow(/intervalMs/);
    expect(() => computeCvdCandles([], [], 1.5)).toThrow(/intervalMs/);
  });
});
