import { describe, expect, it } from "vitest";
import { computeParticipationRate, computeParticipationRateForSize } from "../participationRate";
import { resampleBars } from "../../../chart/resampleBars";
import type { BarFrame, MarkerFrame } from "../../../../types/frames";

const NOW_MS = 1_000_000_000;

function marker(size: number, tsExchange = NOW_MS): MarkerFrame {
  return {
    type: "marker", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    ts_exchange: tsExchange, price: 100, size, side: "buy", trade_id: `m-${size}-${tsExchange}`,
  };
}

function bar(tsOpen: number, volume: number, closed = true): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000,
    ts_open: tsOpen, open: 1, high: 1, low: 1, close: 1, volume, trade_count: 1, closed,
  };
}

describe("computeParticipationRate", () => {
  it("expresses trade volume as a ratio of total completed volume over the trailing window", () => {
    const bars = [bar(NOW_MS - 180_000, 10), bar(NOW_MS - 120_000, 20), bar(NOW_MS - 60_000, 30)];
    const rate = computeParticipationRate(marker(10), bars, NOW_MS);
    expect(rate).toBeCloseTo(10 / 60, 10);
  });

  it("only counts bars inside the trailing window, not the full history", () => {
    const bars = [
      bar(NOW_MS - 10 * 60_000, 1_000), // far outside the default 5-minute window
      bar(NOW_MS - 120_000, 10),
      bar(NOW_MS - 60_000, 30),
    ];
    const rate = computeParticipationRate(marker(20), bars, NOW_MS);
    expect(rate).toBeCloseTo(20 / 40, 10);
  });

  it("ignores a still-forming (closed:false) bar -- an incomplete bar isn't a trustworthy volume sample", () => {
    const bars = [bar(NOW_MS - 120_000, 20), bar(NOW_MS - 60_000, 999_999, false)];
    const rate = computeParticipationRate(marker(20), bars, NOW_MS);
    expect(rate).toBeCloseTo(1, 10);
  });

  it("returns null rather than dividing by zero when there are no bars in the window", () => {
    expect(computeParticipationRate(marker(10), [], NOW_MS)).toBeNull();
  });

  it("returns null when every bar in the window has zero volume", () => {
    const bars = [bar(NOW_MS - 60_000, 0)];
    expect(computeParticipationRate(marker(10), bars, NOW_MS)).toBeNull();
  });

  it("compares like units -- futures use contracts while spot/equity use base volume", () => {
    const futuresMarker: MarkerFrame = {
      type: "marker", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE",
      ts_exchange: NOW_MS, price: 20_000, size: 5, side: "buy", trade_id: "nq-1",
    };
    const bars = [bar(NOW_MS - 60_000, 10)];
    // If this used price*size (100,000) instead of size (5), the ratio would be huge instead of 0.5.
    expect(computeParticipationRate(futuresMarker, bars, NOW_MS)).toBeCloseTo(0.5, 10);
  });

  it("uses native base quantity, not USD notional, for a Binance denominator", () => {
    const bars = [bar(NOW_MS - 60_000, 10)];
    // price * size is $1,000, but bar volume is 10 base units.
    expect(computeParticipationRate(marker(10), bars, NOW_MS)).toBeCloseTo(1, 10);
  });

  it("respects a custom window instead of the 5-minute default", () => {
    const bars = [bar(NOW_MS - 55 * 60_000, 100), bar(NOW_MS - 60_000, 20)];
    const oneHour = 60 * 60_000;
    const rate = computeParticipationRate(marker(30), bars, NOW_MS, oneHour);
    expect(rate).toBeCloseTo(30 / 120, 10); // both bars are in the completed one-hour window
  });
});

describe("computeParticipationRateForSize", () => {
  it("expresses a raw size (e.g. a cluster's combined sizeTokens) as a ratio of completed volume", () => {
    const bars = [bar(NOW_MS - 180_000, 10), bar(NOW_MS - 120_000, 20), bar(NOW_MS - 60_000, 30)];
    expect(computeParticipationRateForSize(15, bars, NOW_MS)).toBeCloseTo(15 / 60, 10);
  });

  it("is exactly what computeParticipationRate delegates to for a single marker", () => {
    const bars = [bar(NOW_MS - 60_000, 40)];
    expect(computeParticipationRateForSize(10, bars, NOW_MS)).toBe(computeParticipationRate(marker(10), bars, NOW_MS));
  });

  it("returns null for a non-positive size", () => {
    const bars = [bar(NOW_MS - 60_000, 40)];
    expect(computeParticipationRateForSize(0, bars, NOW_MS)).toBeNull();
    expect(computeParticipationRateForSize(-5, bars, NOW_MS)).toBeNull();
  });

  it("returns null rather than dividing by zero when there are no bars in the window", () => {
    expect(computeParticipationRateForSize(15, [], NOW_MS)).toBeNull();
  });

  it("REGRESSION: a 15-minute display-resampled bar can never satisfy the trailing 5-minute window, even though the same raw 1-minute bars can", () => {
    // A timestamp cleanly aligned to a 15-minute boundary, so 15
    // consecutive 1-minute bars resample into exactly one 15m bucket.
    const alignedNowMs = 15 * 60_000 * 1000;
    // 15 consecutive closed 1-minute bars, the last one closing exactly at
    // alignedNowMs -- resembles what ChartPanel's display-resampled buffer
    // would hold on a 15m timeframe (the whale-marker tooltip's old,
    // buggy input).
    const raw1mBars: BarFrame[] = Array.from({ length: 15 }, (_, i) => bar(alignedNowMs - (15 - i) * 60_000, 10));
    const resampled15mBars = resampleBars(raw1mBars, 15 * 60_000);
    expect(resampled15mBars).toHaveLength(1);
    expect(resampled15mBars[0].closed).toBe(true);

    // The resampled 15m bar's own ts_open (alignedNowMs - 15min) sits well
    // before the trailing 5-real-minute window's start (alignedNowMs -
    // 5min), so it can never qualify -- this is the bug, not an edge case.
    expect(computeParticipationRateForSize(15, resampled15mBars, alignedNowMs)).toBeNull();

    // The same underlying volume, seen through the raw 1-minute bars
    // instead, correctly finds the last 5 bars inside the window.
    const rate = computeParticipationRateForSize(15, raw1mBars, alignedNowMs);
    expect(rate).toBeCloseTo(15 / 50, 10); // 5 bars * 10 volume each = 50
  });
});
