import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../types/frames";
import {
  HistoricalIndicatorSeriesError,
  createHistoricalIndicatorSeries,
  mergeHistoricalIndicatorSeries,
  resampleHistoricalIndicatorSeries,
} from "./historicalIndicatorSeries";
import { historicalTimeframeById } from "./historicalTimeframes";

function bar(tsOpen: number, buyVolume?: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTCUSDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: tsOpen,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    ...(buyVolume === undefined ? {} : { buy_volume: buyVolume }),
    trade_count: 4,
    closed: true,
  };
}

describe("historical indicator series", () => {
  it("does not invent a coarser crypto metric when any contributing candle is unknown", () => {
    const series = createHistoricalIndicatorSeries(
      [bar(0, 6), bar(60_000, 5), bar(120_000, 4), bar(180_000, 3), bar(240_000, 7)],
      [
        { tsOpen: 0, quoteVolume: 100, takerBuyQuoteVolume: 60, takerSellBaseVolume: 4, takerSellQuoteVolume: 40 },
        { tsOpen: 60_000, quoteVolume: 80, takerBuyQuoteVolume: 45, takerSellBaseVolume: 5, takerSellQuoteVolume: 35 },
        { tsOpen: 120_000, quoteVolume: 70, takerBuyQuoteVolume: 40, takerSellBaseVolume: 6, takerSellQuoteVolume: 30 },
        { tsOpen: 180_000, quoteVolume: 60, takerBuyQuoteVolume: 31, takerSellBaseVolume: 7, takerSellQuoteVolume: 29 },
        { tsOpen: 240_000, takerSellBaseVolume: 3 },
      ],
    );
    const resampled = resampleHistoricalIndicatorSeries(series, historicalTimeframeById("5m"));
    expect(resampled.metrics).toEqual([{ tsOpen: 0, takerSellBaseVolume: 25 }]);
    expect(resampled.capabilities).toEqual(expect.arrayContaining(["ohlcv", "buy_volume", "taker_sell_base_volume", "trade_count"]));
    expect(resampled.capabilities).not.toEqual(expect.arrayContaining(["quote_volume", "taker_buy_quote_volume"]));
  });

  it("rejects a page merge that would mix display intervals", () => {
    const first = createHistoricalIndicatorSeries([bar(0, 5)], [{ tsOpen: 0 }]);
    const incompatible = createHistoricalIndicatorSeries([
      { ...bar(60_000, 5), interval_ms: 300_000 },
    ], [{ tsOpen: 60_000 }]);
    expect(() => mergeHistoricalIndicatorSeries(first, incompatible, "after"))
      .toThrow(HistoricalIndicatorSeriesError);
  });

  it("refuses an invalid metric before it can become an available capability", () => {
    expect(() => createHistoricalIndicatorSeries(
      [bar(0, 5)],
      [{ tsOpen: 0, quoteVolume: Number.NaN }],
    )).toThrow(HistoricalIndicatorSeriesError);
  });
});
