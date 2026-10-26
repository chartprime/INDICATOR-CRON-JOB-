import { describe, expect, it, test } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { computeCVD, computeCVDForBars, computeDeltaPerBar, CVD_HISTOGRAM_COMPRESSION_NOTE, cvdAfter, orderFlowProvenance } from "../orderFlow";

const INTERVAL_MS = 60_000;

function bar(ts_open: number, volume: number, buy_volume?: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: INTERVAL_MS,
    ts_open,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume,
    ...(buy_volume !== undefined ? { buy_volume } : {}),
    trade_count: 0,
    closed: true,
  };
}

function dxFuturesBar(ts_open: number, volume: number, buy_volume?: number): BarFrame {
  return {
    type: "bar",
    symbol: "ES",
    provider: "DXFEED",
    assetClass: "FUTURE",
    interval_ms: INTERVAL_MS,
    ts_open,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume,
    ...(buy_volume !== undefined ? { buy_volume } : {}),
    trade_count: 0,
    closed: true,
  } as BarFrame;
}

describe("computeDeltaPerBar", () => {
  test("computes 2 * buyVolume - volume for a bar with buy_volume present", () => {
    const bars = [bar(0, 10, 7)];
    expect(computeDeltaPerBar(bars)).toEqual([4]);
  });

  test("a bar entirely sold (buy_volume 0) is fully negative delta", () => {
    const bars = [bar(0, 10, 0)];
    expect(computeDeltaPerBar(bars)).toEqual([-10]);
  });

  test("a bar entirely bought (buy_volume === volume) is fully positive delta", () => {
    const bars = [bar(0, 10, 10)];
    expect(computeDeltaPerBar(bars)).toEqual([10]);
  });

  test("a bar with no buy_volume data is an explicit gap, not fabricated neutral flow", () => {
    const bars = [bar(0, 10), bar(INTERVAL_MS, 5, 3)];
    expect(computeDeltaPerBar(bars)).toEqual([null, 1]);
  });

  test("an empty bar list returns an empty array", () => {
    expect(computeDeltaPerBar([])).toEqual([]);
  });

  test("computes the same delta formula for a dxFeed futures bar as for a Binance bar -- the formula is provider-blind", () => {
    const bars = [dxFuturesBar(0, 10, 7)];
    expect(computeDeltaPerBar(bars)).toEqual([4]);
  });
});

describe("computeCVD", () => {
  test("is the running cumulative sum of delta, not a per-bar value", () => {
    expect(computeCVD([1, -2, 3, 3])).toEqual([1, -1, 2, 5]);
  });

  test("breaks and restarts the cumulative epoch after missing flow data", () => {
    expect(computeCVD([2, 3, null, 4, -1])).toEqual([2, 5, null, 4, 3]);
  });

  test("an empty input returns an empty output", () => {
    expect(computeCVD([])).toEqual([]);
  });

  test("starts a new epoch after a missing displayed time bucket, not only after an explicit null delta", () => {
    const bars = [bar(0, 10, 6), bar(2 * INTERVAL_MS, 10, 7)];
    expect(computeCVDForBars(bars, computeDeltaPerBar(bars))).toEqual([2, 4]);
  });

  test("rejects a time-aware calculation whose bars and deltas are not aligned", () => {
    expect(() => computeCVDForBars([bar(0, 10, 6)], [])).toThrow(/identical lengths/);
  });

  test("advances one bar at a time exactly as the whole-history calculation, across gaps and unknown sides (report 57 W4)", () => {
    const bars = [
      bar(0, 10, 6), bar(INTERVAL_MS, 8, 1), bar(2 * INTERVAL_MS, 5), bar(3 * INTERVAL_MS, 9, 9),
      bar(5 * INTERVAL_MS, 4, 3), bar(6 * INTERVAL_MS, 7, 2), bar(7 * INTERVAL_MS, 3, 0),
    ];
    const deltas = computeDeltaPerBar(bars);
    const stepped: (number | null)[] = [];
    bars.forEach((current, index) => stepped.push(cvdAfter(bars[index - 1], stepped[index - 1] ?? null, current, deltas[index])));
    expect(stepped).toEqual(computeCVDForBars(bars, deltas));
    expect(stepped).toEqual([2, -4, null, 9, 2, -1, -4]);
  });
});

describe("orderFlowProvenance", () => {
  // Asserted by containment rather than equality since A2.20 added the
  // compression disclosure to the same line. The point of this test is that
  // the two providers do not present cross-provider CVD as identical, which is
  // what the differing source clauses -- and their inequality -- pin.
  test("makes the source-class difference explicit rather than presenting cross-provider CVD as identical", () => {
    const binance = orderFlowProvenance({ provider: "BINANCE", marketKind: "SPOT" });
    const dxfeed = orderFlowProvenance({ provider: "DXFEED", assetClass: "EQUITY" });

    expect(binance).toContain("Binance exchange taker-buy volume");
    expect(dxfeed).toContain("dxFeed terminal-classified TimeAndSale");
    expect(binance).not.toBe(dxfeed);
  });
});

// A2.20 / L1L2-V2-064. The CVD histogram redraws any bar above a robust
// threshold as sign(raw) x (threshold + sqrt(magnitude - threshold)), so bar
// heights are not proportional to their values -- and the threshold is
// recomputed per batch, so the same delta can render at different heights as
// the surrounding distribution shifts. It fires on 24-30% of equity bars.
// P4.02 documented it; the chart itself said nothing, which is where a reader
// forms their impression of the series. The transform is applied on every
// render, so the disclosure is unconditional rather than threshold-dependent.
describe("CVD histogram compression disclosure", () => {
  it("discloses the compression in the legend detail, on both providers", () => {
    for (const identity of [
      { provider: "BINANCE", marketKind: "SPOT" },
      { provider: "DXFEED", assetClass: "EQUITY" },
    ] as const) {
      expect(orderFlowProvenance(identity)).toContain(CVD_HISTOGRAM_COMPRESSION_NOTE);
    }
  });

  it("still names the data source, so the disclosure adds to provenance rather than replacing it", () => {
    expect(orderFlowProvenance({ provider: "BINANCE", marketKind: "SPOT" }))
      .toContain("Binance exchange taker-buy volume");
    expect(orderFlowProvenance({ provider: "DXFEED", assetClass: "FUTURE" }))
      .toContain("dxFeed terminal-classified TimeAndSale");
  });
});
