const {
  closedBoundary, parseArgs, resumeFromTime, ingestCandleItems,
} = require("../../../scripts/collect/historical/backfill-dxfeed-native-candles");

const instrument = Object.freeze({ symbol: "AAPL", assetClass: "EQUITY" });

describe("dxFeed native candle backfill", () => {
  test("bounds lookback and aligns the closed boundary", () => {
    expect(parseArgs([]).days).toBe(7);
    expect(parseArgs(["--days", "31", "--db", "x.sqlite"])).toEqual({ days: 31, dbPath: "x.sqlite" });
    expect(() => parseArgs(["--days", "32"])).toThrow(/between 1 and 31/);
    expect(closedBoundary(1_800_000_061_234)).toBe(1_800_000_060_000);
  });

  function storageWith(row) {
    return { getStorageDb: () => ({ raw: { prepare: () => ({ get: () => row }) } }) };
  }

  test("resumes after the latest native minute but never before the requested window", () => {
    const storageService = storageWith({ earliest: 1_798_000_000_000, latest: 1_800_000_000_000 });
    expect(resumeFromTime(storageService, instrument, 1_799_000_000_000)).toBe(1_800_000_060_000);
    expect(resumeFromTime(storageService, instrument, 1_801_000_000_000)).toBe(1_801_000_000_000);
  });

  test("refetches the whole window when native coverage does not reach its start", () => {
    const partialNewestFirst = storageWith({ earliest: 1_799_500_000_000, latest: 1_800_000_000_000 });
    expect(resumeFromTime(partialNewestFirst, instrument, 1_799_000_000_000)).toBe(1_799_000_000_000);
    expect(resumeFromTime(storageWith({ earliest: null, latest: null }), instrument, 1_799_000_000_000)).toBe(1_799_000_000_000);
  });

  test("a minute in which nothing traded is skipped and counted, never stored as a bar", () => {
    const recordCandle = jest.fn();
    const empty = {
      eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_800_000_000_000,
      open: "NaN", high: "NaN", low: "NaN", close: "NaN", volume: 0, askVolume: "NaN", bidVolume: "NaN", count: 0,
    };
    const result = ingestCandleItems([empty, { ...empty, time: empty.time + 60_000, volume: "NaN", count: "NaN" }], { instrument, boundary: empty.time + 120_000, storageService: { recordCandle } });
    expect(result).toEqual({ written: 0, skipped: 2, latest: null });
    expect(recordCandle).not.toHaveBeenCalled();
  });

  test("a partly empty candle still fails closed and the error shows the whole candle", () => {
    const candle = {
      eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_800_000_000_000,
      open: "NaN", high: 102, low: 99, close: 101, volume: 0, askVolume: "NaN", bidVolume: "NaN", count: 0,
    };
    expect(() => ingestCandleItems([candle], { instrument, boundary: candle.time + 60_000, storageService: { recordCandle: jest.fn() } }))
      .toThrow('open must be positive and finite (got "NaN"); candle {"eventSymbol":"AAPL{=m}","time":1800000000000,"open":"NaN","high":102');
  });

  test("a candle without an ask/bid split is stored with unknown sides instead of aborting the run", () => {
    const recordCandle = jest.fn();
    const candle = {
      eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_800_000_000_000,
      open: 100, high: 102, low: 99, close: 101, volume: 12, askVolume: "NaN", bidVolume: "NaN", count: 8,
    };
    const result = ingestCandleItems([candle], { instrument, boundary: candle.time + 60_000, storageService: { recordCandle } });
    expect(result).toEqual({ written: 1, skipped: 0, latest: candle.time });
    expect(recordCandle.mock.calls[0][2]).toMatchObject({ buy_volume: null, sell_volume: null, volume: 12 });
  });

  test("stores only matching, fully closed native candles with explicit lineage", () => {
    const recordCandle = jest.fn();
    const candle = {
      eventType: "Candle", eventSymbol: "AAPL{=m}", time: 1_800_000_000_000,
      open: 100, high: 102, low: 99, close: 101, volume: 12, askVolume: 5, bidVolume: 6, count: 8,
    };
    const result = ingestCandleItems([
      candle,
      { ...candle, eventSymbol: "TSLA{=m}" },
      { ...candle, time: candle.time + 60_000 },
    ], { instrument, boundary: candle.time + 60_000, storageService: { recordCandle } });
    expect(result).toEqual({ written: 1, skipped: 0, latest: candle.time });
    expect(recordCandle).toHaveBeenCalledWith("AAPL", "EQUITY", expect.any(Object), { derivation: "NATIVE" });
  });
});
