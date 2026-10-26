import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../types/frames";
import { HistoricalResampleError, resampleHistoricalBars } from "./historicalResampleBars";
import { historicalTimeframeById } from "./historicalTimeframes";

type BinanceBar = Extract<BarFrame, { provider: "BINANCE" }>;
type DatabentoBar = Extract<BarFrame, { provider: "DATABENTO" }>;
type BinanceBarOverrides = Partial<Omit<BinanceBar, "provider" | "marketKind" | "assetClass" | "type">>;
type DatabentoBarOverrides = Partial<Omit<DatabentoBar, "provider" | "marketKind" | "assetClass" | "type">>;

function minuteBar(tsOpen: number, overrides: BinanceBarOverrides = {}): BinanceBar {
  return {
    provider: "BINANCE",
    marketKind: "SPOT",
    type: "bar",
    symbol: "BTCUSDT",
    interval_ms: 60_000,
    ts_open: tsOpen,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 2,
    buy_volume: 1,
    trade_count: 3,
    closed: true,
    ...overrides,
  };
}

function hourBar(tsOpen: number, overrides: DatabentoBarOverrides = {}): DatabentoBar {
  return {
    provider: "DATABENTO",
    assetClass: "EQUITY",
    type: "bar",
    symbol: "AAPL",
    interval_ms: 60 * 60_000,
    ts_open: tsOpen,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 2,
    trade_count: null,
    closed: true,
    ...overrides,
  };
}

function dayBar(tsOpen: number, overrides: BinanceBarOverrides = {}): BinanceBar {
  return {
    provider: "BINANCE",
    marketKind: "SPOT",
    type: "bar",
    symbol: "BTCUSDT",
    interval_ms: 24 * 60 * 60_000,
    ts_open: tsOpen,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 2,
    buy_volume: 1,
    trade_count: 3,
    closed: true,
    ...overrides,
  };
}

describe("resampleHistoricalBars", () => {
  it("creates an honest sparse 5m candle without inventing missing minute candles", () => {
    const result = resampleHistoricalBars([
      minuteBar(0, { open: 100, high: 102, low: 99, close: 101, volume: 2, buy_volume: 1, trade_count: 2 }),
      minuteBar(120_000, { open: 101, high: 104, low: 100, close: 103, volume: 3, buy_volume: 2, trade_count: 4 }),
      minuteBar(240_000, { open: 103, high: 105, low: 98, close: 99, volume: 5, buy_volume: 3, trade_count: 6 }),
    ], historicalTimeframeById("5m"));

    expect(result).toEqual([expect.objectContaining({
      interval_ms: 300_000,
      ts_open: 0,
      open: 100,
      high: 105,
      low: 98,
      close: 99,
      volume: 10,
      buy_volume: 6,
      trade_count: 12,
      closed: true,
    })]);
  });

  it("does not manufacture a candle for an entirely absent display bucket", () => {
    const result = resampleHistoricalBars([
      minuteBar(0),
      minuteBar(600_000),
    ], historicalTimeframeById("5m"));

    expect(result.map((bar) => bar.ts_open)).toEqual([0, 600_000]);
  });

  it("carries unavailable flow fields forward as unavailable", () => {
    const result = resampleHistoricalBars([
      hourBar(0, { volume: 5 }),
      hourBar(2 * 60 * 60_000, { volume: 7 }),
    ], historicalTimeframeById("4h"));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ volume: 12, trade_count: null });
    expect(Object.hasOwn(result[0], "buy_volume")).toBe(false);
  });

  it("opens weekly candles on Monday UTC", () => {
    const sunday = Date.UTC(2026, 0, 4);
    const monday = Date.UTC(2026, 0, 5);
    const result = resampleHistoricalBars([dayBar(sunday), dayBar(monday)], historicalTimeframeById("1W"));

    expect(result.map((bar) => bar.ts_open)).toEqual([Date.UTC(2025, 11, 29), monday]);
  });

  it("uses real UTC calendar months without treating February as thirty days", () => {
    const januaryThirtyFirst = Date.UTC(2026, 0, 31);
    const februaryFirst = Date.UTC(2026, 1, 1);
    const result = resampleHistoricalBars([
      dayBar(januaryThirtyFirst, { open: 90, high: 92, low: 89, close: 91 }),
      dayBar(februaryFirst, { open: 92, high: 94, low: 91, close: 93 }),
    ], historicalTimeframeById("1M"));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ ts_open: Date.UTC(2026, 0, 1), open: 90, close: 91, calendar_interval: "month" });
    expect(result[1]).toMatchObject({ ts_open: februaryFirst, open: 92, close: 93, calendar_interval: "month" });
  });

  it("refuses duplicate, incomplete, or mismatched source bars instead of choosing a plausible aggregate", () => {
    expect(() => resampleHistoricalBars([minuteBar(0), minuteBar(0)], historicalTimeframeById("5m")))
      .toThrow(HistoricalResampleError);
    expect(() => resampleHistoricalBars([minuteBar(0, { closed: false })], historicalTimeframeById("5m")))
      .toThrow(HistoricalResampleError);
    expect(() => resampleHistoricalBars([minuteBar(0), { ...minuteBar(60_000), symbol: "ETHUSDT" }], historicalTimeframeById("5m")))
      .toThrow(HistoricalResampleError);
    expect(() => resampleHistoricalBars([hourBar(0)], historicalTimeframeById("5m")))
      .toThrow(HistoricalResampleError);
  });
});
