const { adaptNativeDxFeedCandle } = require("../../../src/providers/dxfeed/dxfeed-candle-adapter");

const RAW = Object.freeze({
  eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_800_000_000_000,
  open: 100, high: 102, low: 99, close: 101, volume: 12, askVolume: 5, bidVolume: 6, count: 8,
});

describe("native dxFeed Candle adapter", () => {
  test("maps ask/bid volume to explicit buy/sell volume while preserving unknown volume", () => {
    expect(adaptNativeDxFeedCandle(RAW, { symbol: "AAPL" })).toEqual({
      ts_open: RAW.time, open: 100, high: 102, low: 99, close: 101, volume: 12,
      buy_volume: 5, sell_volume: 6, trade_count: 8, closed: true,
    });
  });

  test("keeps directional volume unknown when the feed omits it", () => {
    const bar = adaptNativeDxFeedCandle({ ...RAW, askVolume: Number.NaN, bidVolume: undefined }, { symbol: "AAPL" });
    expect(bar.buy_volume).toBeNull();
    expect(bar.sell_volume).toBeNull();
  });

  test("treats the wire's NaN token as an unknown side, as the event normalizer does", () => {
    const bar = adaptNativeDxFeedCandle({ ...RAW, askVolume: "NaN", bidVolume: "NaN" }, { symbol: "AAPL" });
    expect(bar.buy_volume).toBeNull();
    expect(bar.sell_volume).toBeNull();
    expect(bar.volume).toBe(12);
  });

  test("names the offending value when a field is refused", () => {
    expect(() => adaptNativeDxFeedCandle({ ...RAW, askVolume: -1 }, { symbol: "AAPL" })).toThrow("askVolume must be non-negative and finite (got -1)");
    expect(() => adaptNativeDxFeedCandle({ ...RAW, open: "NaN" }, { symbol: "AAPL" })).toThrow('open must be positive and finite (got "NaN")');
  });

  test.each([
    [{ ...RAW, eventSymbol: "TSLA{=m}" }, /identity/],
    [{ ...RAW, time: RAW.time + 1 }, /align/],
    [{ ...RAW, high: 100.5 }, /OHLC/],
    [{ ...RAW, bidVolume: 8 }, /directional/],
    [{ ...RAW, count: 0 }, /count/],
  ])("fails closed for malformed native candle %#", (raw, expected) => {
    expect(() => adaptNativeDxFeedCandle(raw, { symbol: "AAPL" })).toThrow(expected);
  });
});
