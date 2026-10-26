import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { CandleDeltaSource, rowsFromCandles } from "../candleDeltaSource";

const MINUTE = 60_000;

function candle(tsOpen: number, low: number, high: number, close: number, volume: number, buy?: number): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: MINUTE, ts_open: tsOpen,
    open: low, high, low, close, volume, trade_count: null, closed: true, ...(buy === undefined ? {} : { buy_volume: buy }),
  };
}

describe("rowsFromCandles", () => {
  it("spreads each candle's buys and sells evenly over the rows between its low and high, ascending", () => {
    const rows = rowsFromCandles([candle(0, 100, 102.5, 101, 30, 18)], 1, 0, MINUTE);
    expect(rows).toEqual([
      { price: 100, buy: 6, sell: 4 },
      { price: 101, buy: 6, sell: 4 },
      { price: 102, buy: 6, sell: 4 },
    ]);
  });

  it("sums candles that share rows, skips candles without a side split and candles outside the range", () => {
    const bars = [
      candle(0, 100, 101.9, 100, 10, 10),
      candle(MINUTE, 101, 102.9, 102, 10, 0),
      candle(2 * MINUTE, 100, 100.9, 100, 50),
      candle(3 * MINUTE, 100, 100.9, 100, 50, 50),
    ];
    expect(rowsFromCandles(bars, 1, 0, 3 * MINUTE)).toEqual([
      { price: 100, buy: 5, sell: 0 },
      { price: 101, buy: 5, sell: 5 },
      { price: 102, buy: 0, sell: 5 },
    ]);
    expect(rowsFromCandles(bars, 1, 3 * MINUTE, 4 * MINUTE)).toEqual([{ price: 100, buy: 50, sell: 0 }]);
    expect(rowsFromCandles(bars, 1, 2 * MINUTE, 3 * MINUTE)).toEqual([]);
    expect(rowsFromCandles([], 1, 0, MINUTE)).toEqual([]);
  });

  it("returns the rows ascending whatever order the candles traded in", () => {
    const bars = [candle(0, 102, 102.9, 102, 2, 2), candle(MINUTE, 100, 100.9, 100, 2, 0)];
    expect(rowsFromCandles(bars, 1, 0, 2 * MINUTE).map((row) => row.price)).toEqual([100, 102]);
  });

  it("keeps a candle whose open is before the range but which is still running inside it", () => {
    expect(rowsFromCandles([candle(0, 100, 100.5, 100, 4, 4)], 1, MINUTE / 2, MINUTE)).toEqual([{ price: 100, buy: 4, sell: 0 }]);
    expect(rowsFromCandles([candle(0, 100, 100.5, 100, 4, 4)], 1, MINUTE, 2 * MINUTE)).toEqual([]);
  });
});

describe("CandleDeltaSource", () => {
  const bars = [candle(0, 100, 101.9, 101, 10, 10), candle(MINUTE, 102, 103.9, 102.5, 4, 0)];

  it("reads the rows of the candles on screen, points at the last one's close and bumps its version only on new bars", () => {
    let range: { from: number; to: number } | null = { from: 0, to: 2 * MINUTE };
    const source = new CandleDeltaSource(1, () => range);
    expect(source.rowWidth).toBe(1);
    expect(source.rows()).toEqual([]);
    const before = source.version;
    source.setBars(bars);
    expect(source.version).toBeGreaterThan(before);
    const rows = source.rows();
    expect(rows).toEqual([
      { price: 100, buy: 5, sell: 0 },
      { price: 101, buy: 5, sell: 0 },
      { price: 102, buy: 0, sell: 2 },
      { price: 103, buy: 0, sell: 2 },
    ]);
    expect(source.rows()).toBe(rows);
    expect(source.lastIndex).toBe(102);
    range = { from: 0, to: MINUTE };
    expect(source.rows()).toEqual([{ price: 100, buy: 5, sell: 0 }, { price: 101, buy: 5, sell: 0 }]);
    expect(source.lastIndex).toBe(101);
    range = null;
    expect(source.rows()).toEqual([]);
    expect(source.lastIndex).toBeNull();
  });

  it("never claims live prints, gaps or holes, so the log only says the history is complete", () => {
    const source = new CandleDeltaSource(0.25, () => ({ from: 0, to: MINUTE }));
    expect(source.recent).toEqual([]);
    expect(source.issue).toBeNull();
    expect(source.complete).toBe(true);
    expect(source.pieces).toEqual([]);
  });
});
