import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../types/frames";
import { resampleBars, TIMEFRAMES, defaultVisibleWindowMs } from "../resampleBars";

function bar(
  tsOpen: number, o: number, h: number, l: number, c: number, v: number, n: number, closed: boolean,
  buyVolume?: number,
): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: tsOpen,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
    trade_count: n,
    closed,
  };
}

describe("resampleBars", () => {
  it("returns an empty array for empty input", () => {
    expect(resampleBars([], 300_000)).toEqual([]);
  });

  it("is a no-op passthrough when the target interval matches the source", () => {
    const bars = [bar(0, 1, 2, 0.5, 1.5, 10, 3, true)];
    expect(resampleBars(bars, 60_000)).toEqual(bars);
  });

  it("aggregates exactly 5 one-minute bars into one 5m bucket with correct OHLCV", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true), // (0, 60000]
      bar(60_000, 102, 108, 101, 106, 8, 3, true),
      bar(120_000, 106, 107, 95, 96, 12, 5, true), // low of the whole window
      bar(180_000, 96, 110, 96, 109, 6, 2, true), // high of the whole window
      bar(240_000, 109, 111, 108, 108, 4, 1, true), // last bar -> completes the 5m window at 300000
    ];

    const result = resampleBars(bars, 300_000);

    expect(result).toHaveLength(1);
    const bucket = result[0];
    expect(bucket.ts_open).toBe(0);
    expect(bucket.interval_ms).toBe(300_000);
    expect(bucket.open).toBe(100); // first bar's open
    expect(bucket.close).toBe(108); // last bar's close
    expect(bucket.high).toBe(111);
    expect(bucket.low).toBe(95);
    expect(bucket.volume).toBe(40); // 10+8+12+6+4
    expect(bucket.trade_count).toBe(15); // 4+3+5+2+1
    expect(bucket.closed).toBe(true); // last constituent closed AND lands exactly on the 5m boundary
  });

  it("a bucket with fewer than a full set of constituents is NOT closed if it's the trailing (still-forming) one", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true),
      bar(60_000, 102, 108, 101, 106, 8, 3, true),
      bar(120_000, 106, 107, 95, 100, 12, 5, false), // still-forming 1m bar, only 3 of 5 minutes in
    ];

    const result = resampleBars(bars, 300_000);

    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(false);
    expect(result[0].close).toBe(100); // reflects the live still-forming 1m bar's current close
  });

  it("a boundary-crossing 1m bar correctly starts a NEW bucket, closing the previous one", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true),
      bar(60_000, 102, 108, 101, 106, 8, 3, true),
      bar(120_000, 106, 107, 95, 96, 12, 5, true),
      bar(180_000, 96, 110, 96, 109, 6, 2, true),
      bar(240_000, 109, 111, 108, 108, 4, 1, true), // completes bucket 0
      bar(300_000, 108, 112, 107, 111, 3, 2, false), // first bar of the NEXT 5m bucket, still forming
    ];

    const result = resampleBars(bars, 300_000);

    expect(result).toHaveLength(2);
    expect(result[0].ts_open).toBe(0);
    expect(result[0].closed).toBe(true); // no longer the trailing bucket -> must be complete
    expect(result[1].ts_open).toBe(300_000);
    expect(result[1].closed).toBe(false);
    expect(result[1].open).toBe(108);
    expect(result[1].close).toBe(111);
  });

  it("resamples correctly into a much coarser interval (1h from 1m)", () => {
    const bars = Array.from({ length: 60 }, (_, i) =>
      bar(i * 60_000, 100 + i, 100 + i + 1, 100 + i - 1, 100 + i + 0.5, 1, 1, true),
    );

    const result = resampleBars(bars, 3_600_000);

    expect(result).toHaveLength(1);
    expect(result[0].ts_open).toBe(0);
    expect(result[0].open).toBe(100); // first bar's open
    expect(result[0].close).toBe(159.5); // last (i=59) bar's close
    expect(result[0].volume).toBe(60);
    expect(result[0].trade_count).toBe(60);
    expect(result[0].closed).toBe(true);
  });

  it("preserves the symbol from the input bars", () => {
    const bars = [bar(0, 1, 1, 1, 1, 1, 1, true)];
    bars[0].symbol = "ETH-USDT";
    const result = resampleBars(bars, 300_000);
    expect(result[0].symbol).toBe("ETH-USDT");
  });

  it("sorts unordered input before calculating open and close, so transport reordering cannot invert a candle", () => {
    const result = resampleBars([
      bar(60_000, 110, 115, 105, 112, 2, 2, true),
      bar(0, 100, 111, 99, 110, 1, 1, true),
    ], 300_000);

    expect(result[0]).toMatchObject({ open: 100, close: 112, high: 115, low: 99 });
    expect(result[0]?.closed).toBe(false);
  });

  it("uses only the latest update for a repeated source open time instead of double-counting volume and trades", () => {
    const result = resampleBars([
      bar(0, 100, 102, 99, 101, 5, 2, false),
      bar(0, 100, 104, 98, 103, 8, 4, true),
      bar(60_000, 103, 105, 102, 104, 3, 1, false),
    ], 300_000);

    expect(result[0]).toMatchObject({
      open: 100,
      high: 105,
      low: 98,
      close: 104,
      volume: 11,
      trade_count: 5,
      closed: false,
    });
  });

  it("omits a sparse historical bucket instead of drawing partial OHLC as a candle", () => {
    const result = resampleBars([
      bar(0, 100, 101, 99, 100, 1, 1, true),
      bar(240_000, 100, 101, 99, 100, 1, 1, true),
    ], 300_000);

    expect(result).toEqual([]);
  });

  it("omits a leading partial bucket when retained history starts mid-window", () => {
    expect(resampleBars([
      bar(120_000, 100, 101, 99, 100, 1, 1, true),
      bar(180_000, 100, 101, 99, 100, 1, 1, true),
    ], 300_000)).toEqual([]);
  });

  it("sums buy_volume across the group, same as volume, when every constituent bar has it", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true, 6),
      bar(60_000, 102, 108, 101, 106, 8, 3, true, 5),
      bar(120_000, 106, 107, 95, 96, 12, 5, true, 3),
      bar(180_000, 96, 110, 96, 109, 6, 2, true, 4),
      bar(240_000, 109, 111, 108, 108, 4, 1, true, 2),
    ];
    const result = resampleBars(bars, 300_000);
    expect(result[0].buy_volume).toBe(20); // 6+5+3+4+2
  });

  it("a resampled bucket has no buy_volume at all when it straddles the taker-buy-volume migration -- an honest gap, not a fabricated partial sum", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true, 6), // has buy_volume
      bar(60_000, 102, 108, 101, 106, 8, 3, true), // pre-migration bar, no buy_volume
    ];
    const result = resampleBars(bars, 300_000);
    expect(result[0].buy_volume).toBeUndefined();
  });

  it("the no-op 1m passthrough preserves buy_volume unchanged, since it returns the original bar objects", () => {
    const bars = [bar(0, 1, 2, 0.5, 1.5, 10, 3, true, 4)];
    expect(resampleBars(bars, 60_000)[0].buy_volume).toBe(4);
  });

  it("rejects a non-integral target and mixed source streams rather than fabricating a cross-market candle", () => {
    const btc = bar(0, 1, 1, 1, 1, 1, 1, true);
    const eth = { ...bar(60_000, 1, 1, 1, 1, 1, 1, true), symbol: "ETH-USDT" };
    expect(() => resampleBars([btc], 90_000)).toThrow();
    expect(() => resampleBars([btc, eth], 300_000)).toThrow();
  });

  it("marks a resampled bucket reconstructed when any constituent bar was REST-backfilled", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true),
      { ...bar(60_000, 102, 108, 101, 106, 8, 3, true), reconstructed: true },
      bar(120_000, 106, 107, 95, 96, 12, 5, true),
    ];
    const result = resampleBars(bars, 300_000);
    expect(result[0].reconstructed).toBe(true);
  });

  it("leaves reconstructed unset on a bucket whose constituents are all genuine live/stored bars", () => {
    const bars = [
      bar(0, 100, 105, 99, 102, 10, 4, true),
      bar(60_000, 102, 108, 101, 106, 8, 3, true),
    ];
    const result = resampleBars(bars, 300_000);
    expect(result[0].reconstructed).toBeUndefined();
  });

  it("rejects an aggregate trade count that exceeds safe integer precision", () => {
    expect(() => resampleBars([
      bar(0, 1, 1, 1, 1, 1, Number.MAX_SAFE_INTEGER, true),
      bar(60_000, 1, 1, 1, 1, 1, 1, true),
    ], 300_000)).toThrow(/numeric range/);
  });

  it("preserves an unavailable trade count and the archive provider through resampling", () => {
    const { marketKind: _marketKind, ...base } = bar(0, 1, 2, 0.5, 1.5, 10, 1, true);
    const source: BarFrame[] = [
      { ...base, provider: "DATABENTO", assetClass: "EQUITY", trade_count: null },
      { ...base, provider: "DATABENTO", assetClass: "EQUITY", ts_open: 60_000, trade_count: 1 },
    ];

    expect(resampleBars(source, 300_000)[0]).toMatchObject({
      provider: "DATABENTO",
      assetClass: "EQUITY",
      trade_count: null,
    });
  });

  it("matches an independent UTC golden calculation for every supported timeframe from 1m through 1D", () => {
    const utcMidnight = Date.UTC(2026, 0, 2, 0, 0, 0, 0);
    for (const { label, intervalMs } of TIMEFRAMES) {
      const constituents = intervalMs / 60_000;
      const source = Array.from({ length: constituents * 2 }, (_, index) => bar(
        utcMidnight + index * 60_000,
        100 + index,
        102 + index,
        98 + index,
        100.5 + index,
        index + 1,
        1,
        true,
        (index + 1) / 2,
      ));
      const result = resampleBars(source, intervalMs);
      const expectedVolume = constituents * (constituents + 1) / 2;
      expect(result, label).toHaveLength(2);
      expect(result[0], label).toMatchObject({
        ts_open: utcMidnight,
        interval_ms: intervalMs,
        open: 100,
        high: 102 + constituents - 1,
        low: 98,
        close: 100.5 + constituents - 1,
        volume: expectedVolume,
        buy_volume: expectedVolume / 2,
        trade_count: constituents,
        closed: true,
      });
      expect(result[1].ts_open, label).toBe(utcMidnight + intervalMs);
      expect(result[1].closed, label).toBe(true);
    }
  });

  it("never promotes a trailing partial bucket to closed at any supported higher timeframe", () => {
    const utcMidnight = Date.UTC(2026, 0, 2, 0, 0, 0, 0);
    for (const { label, intervalMs } of TIMEFRAMES.filter((timeframe) => timeframe.intervalMs > 60_000)) {
      const constituents = intervalMs / 60_000;
      const source = Array.from({ length: constituents - 1 }, (_, index) =>
        bar(utcMidnight + index * 60_000, 100, 101, 99, 100, 1, 1, true));
      expect(resampleBars(source, intervalMs)[0].closed, label).toBe(false);
    }
  });

  it("rejects a source candle that is not aligned to its declared UTC interval", () => {
    expect(() => resampleBars([bar(30_000, 1, 1, 1, 1, 1, 1, true)], 300_000)).toThrow(/source interval/);
  });
});

describe("defaultVisibleWindowMs", () => {
  it("returns a progressively wider window as the interval gets coarser -- every step strictly increases", () => {
    const windows = TIMEFRAMES.map((tf) => defaultVisibleWindowMs(tf.intervalMs));
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]).toBeGreaterThanOrEqual(windows[i - 1]);
    }
  });

  it("looks up each TIMEFRAMES entry's own declared window exactly, not a recomputed value", () => {
    for (const tf of TIMEFRAMES) {
      expect(defaultVisibleWindowMs(tf.intervalMs)).toBe(tf.defaultWindowMs);
    }
  });

  it("1m defaults to 2 hours and 5m to 6 hours, matching the terminal's own stated design", () => {
    expect(defaultVisibleWindowMs(60_000)).toBe(2 * 60 * 60_000);
    expect(defaultVisibleWindowMs(5 * 60_000)).toBe(6 * 60 * 60_000);
  });

  it("the coarsest tiers (4h/6h/12h/1D) all cap at the full 7-day backfill window, not something larger", () => {
    const sevenDaysMs = 7 * 24 * 60 * 60_000;
    for (const label of ["4h", "6h", "12h", "1D"] as const) {
      const tf = TIMEFRAMES.find((t) => t.label === label)!;
      expect(defaultVisibleWindowMs(tf.intervalMs)).toBe(sevenDaysMs);
    }
  });

  it("falls back to the full 7-day window for an interval that isn't one of TIMEFRAMES' own", () => {
    expect(defaultVisibleWindowMs(123_456)).toBe(7 * 24 * 60 * 60_000);
  });
});

describe("equity higher timeframes anchor to the 09:30 session open (report 57 GE-14b)", () => {
  const OPEN = Date.parse("2026-09-23T13:30:00Z");
  const CLOSE = Date.parse("2026-09-23T20:00:00Z");
  const equityMinute = (tsOpen: number): BarFrame => ({
    type: "bar", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY", interval_ms: 60_000, ts_open: tsOpen,
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, trade_count: 1, closed: true,
  } as BarFrame);
  const session = Array.from({ length: (CLOSE - OPEN) / 60_000 }, (_, index) => equityMinute(OPEN + index * 60_000));

  it("opens hourly bars at 09:30 and closes the last one at the bell", () => {
    const hours = resampleBars(session, 3_600_000);
    expect(hours.map((entry) => entry.ts_open)).toEqual(Array.from({ length: 7 }, (_, index) => OPEN + index * 3_600_000));
    expect(hours.every((entry) => entry.closed)).toBe(true);
    expect(hours.at(-1)!.volume).toBe(30);
  });

  it("builds a closed daily bar from the session instead of dropping it for missing pre-market minutes", () => {
    const days = resampleBars(session, 86_400_000);
    expect(days.map((entry) => [entry.ts_open, entry.closed, entry.volume])).toEqual([[OPEN, true, session.length]]);
  });

  it("keeps the first 4h bucket, which starts at the open", () => {
    expect(resampleBars(session, 4 * 3_600_000).map((entry) => entry.ts_open)).toEqual([OPEN, OPEN + 4 * 3_600_000]);
  });
});
