import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../types/frames";
import { buildSessionDeltaProfile } from "./sessionDeltaProfile";

function bar(
  overrides: Partial<BarFrame> &
    Pick<
      BarFrame,
      | "ts_open"
      | "open"
      | "high"
      | "low"
      | "close"
      | "volume"
      | "trade_count"
      | "closed"
    >,
): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    interval_ms: 60_000,
    provider: "BINANCE",
    marketKind: "SPOT",
    ...overrides,
  } as BarFrame;
}

const sum = (rows: { totalVolume: number }[]) =>
  rows.reduce((n, r) => n + r.totalVolume, 0);
const sideSum = (rows: { buyVolume: number; sellVolume: number }[]) =>
  rows.reduce((n, r) => n + r.buyVolume + r.sellVolume, 0);

describe("buildSessionDeltaProfile", () => {
  it("accumulates buy and sell volume for each price row within the session window", () => {
    const bars = [
      bar({
        ts_open: 1_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        buy_volume: 6,
        trade_count: 1,
        closed: true,
      }),
      bar({
        ts_open: 1_500,
        open: 100,
        high: 102,
        low: 100,
        close: 101,
        volume: 20,
        buy_volume: 4,
        trade_count: 2,
        closed: true,
      }),
      bar({
        ts_open: 2_000,
        open: 100,
        high: 100,
        low: 99,
        close: 99,
        volume: 30,
        buy_volume: 0,
        trade_count: 1,
        closed: true,
      }),
      bar({
        ts_open: 10_000,
        open: 120,
        high: 120,
        low: 118,
        close: 119,
        volume: 15,
        buy_volume: 15,
        trade_count: 1,
        closed: true,
      }),
    ];

    const session = buildSessionDeltaProfile(bars, 0, 5_000, 2, 1_000);

    expect(session.sessionStartTs).toBe(0);
    expect(session.sessionEndTs).toBe(5_000);
    // only the three in-window bars contribute (10 + 20 + 30)
    expect(sum(session.rows)).toBeCloseTo(60, 6);
    // every in-window bar reported a side, so the whole profile is attributed
    expect(sideSum(session.rows)).toBeCloseTo(60, 6);
    // the buy_volume: 0 bar (close 99) is genuine all-sell, so sell dominates
    const totalBuy = session.rows.reduce((n, r) => n + r.buyVolume, 0);
    const totalSell = session.rows.reduce((n, r) => n + r.sellVolume, 0);
    expect(totalBuy).toBeCloseTo(10, 6); // 6 + 4 + 0
    expect(totalSell).toBeCloseTo(50, 6); // 4 + 16 + 30
    expect(session.buyPocPrice).not.toBeNaN();
    expect(session.sellPocPrice).not.toBeNaN();
  });

  it("does not emit rows outside the session's own traded price range (W6.03 F4)", () => {
    // close 99 rounds to row 98 and would spread 20% down to a phantom row 96,
    // but the session's lowest low is 99 -> nothing traded at 96.
    const session = buildSessionDeltaProfile(
      [
        bar({
          ts_open: 1_000,
          open: 100,
          high: 101,
          low: 99,
          close: 99,
          volume: 30,
          buy_volume: 10,
          trade_count: 1,
          closed: true,
        }),
      ],
      0,
      5_000,
      2,
      1_000,
    );

    const prices = session.rows.map((r) => r.price);
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(98); // floor(99 / 2) * 2
    expect(Math.max(...prices)).toBeLessThanOrEqual(100); // floor(101 / 2) * 2
    // volume is conserved: the clamped-in share is folded into the edge row
    expect(sum(session.rows)).toBeCloseTo(30, 6);
    expect(sideSum(session.rows)).toBeCloseTo(30, 6);
  });

  it("ignores bars outside the session boundary", () => {
    const inWindow = bar({
      ts_open: 9_000,
      open: 110,
      high: 111,
      low: 109,
      close: 110,
      volume: 8,
      buy_volume: 7,
      trade_count: 1,
      closed: true,
    });
    const afterWindow = bar({
      ts_open: 10_000,
      open: 111,
      high: 112,
      low: 110,
      close: 111,
      volume: 12,
      buy_volume: 2,
      trade_count: 2,
      closed: true,
    });

    const session = buildSessionDeltaProfile(
      [inWindow, afterWindow],
      9_000,
      10_000,
      2,
      1_000,
    );

    expect(sum(session.rows)).toBeCloseTo(8, 6); // only the 9_000 bar
    expect(session.lastBarTs).toBe(9_000);
  });

  it("distributes each bar across its close row and the adjacent rows (60 / 20 / 20)", () => {
    const session = buildSessionDeltaProfile(
      [
        bar({
          ts_open: 1_000,
          open: 100,
          high: 102,
          low: 98,
          close: 100,
          volume: 100,
          buy_volume: 60,
          trade_count: 1,
          closed: true,
        }),
      ],
      0,
      5_000,
      2,
      1_000,
    );

    const byPrice = new Map(session.rows.map((r) => [r.price, r]));
    expect(byPrice.get(100)?.totalVolume).toBeCloseTo(60, 6);
    expect(byPrice.get(98)?.totalVolume).toBeCloseTo(20, 6);
    expect(byPrice.get(102)?.totalVolume).toBeCloseTo(20, 6);
    // buy fraction (0.6) preserved in every row
    for (const row of session.rows) {
      expect(row.buyVolume / row.totalVolume).toBeCloseTo(0.6, 6);
    }
  });

  it("marks the delta unknown instead of implying all-sell when a bar has no buy_volume (W6.03 F1)", () => {
    const session = buildSessionDeltaProfile(
      [
        bar({
          ts_open: 1_000,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 40,
          buy_volume: 24,
          trade_count: 1,
          closed: true,
        }),
        bar({
          ts_open: 2_000,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 60,
          // no buy_volume: aggressor side is unknown for this bar
          trade_count: 1,
          closed: true,
        }),
      ],
      0,
      5_000,
      2,
      1_000,
    );

    // real volume is still real: both bars count (40 + 60)
    expect(sum(session.rows)).toBeCloseTo(100, 6);
    // but only the first bar's 40 is attributed to a side — the side-less bar
    // contributes 0 buy and 0 sell rather than a fabricated 60 sell
    expect(sideSum(session.rows)).toBeCloseTo(40, 6);
    const knownVolume = session.rows.reduce((n, r) => n + r.knownVolume, 0);
    expect(knownVolume).toBeCloseTo(40, 6);
    const totalSell = session.rows.reduce((n, r) => n + r.sellVolume, 0);
    expect(totalSell).toBeCloseTo(16, 6); // 40 - 24, not 16 + 60
  });

  it("returns an empty session when no bars fall in the requested window", () => {
    const session = buildSessionDeltaProfile([], 0, 60_000, 2, 1_000);

    expect(session.rows).toEqual([]);
    expect(session.pocPrice).toBeNaN();
    expect(session.vahPrice).toBeNaN();
    expect(session.valPrice).toBeNaN();
  });

  it("does not count explicitly unsided volume as known side volume", () => {
    const session = buildSessionDeltaProfile([
      bar({
        ts_open: 0,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
        buy_volume: 400,
        sell_volume: 300,
        trade_count: 10,
        closed: true,
      }),
    ], 0, 60_000, 2, 60_000);

    expect(session.rows.reduce((sum, row) => sum + row.knownVolume, 0)).toBeCloseTo(700, 6);
    expect(sideSum(session.rows)).toBeCloseTo(700, 6);
    expect(sum(session.rows)).toBeCloseTo(1_000, 6);
  });
});
