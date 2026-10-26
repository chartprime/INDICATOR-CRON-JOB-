import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../types/frames";
import { barDelta, barSides, unsidedShare } from "./barSides";

function bar(overrides: Partial<BarFrame> = {}): BarFrame {
  return {
    type: "bar", symbol: "AAPL", provider: "DATABENTO", assetClass: "EQUITY",
    interval_ms: 60_000, ts_open: 1_756_684_800_000,
    open: 100, high: 101, low: 99, close: 100.5, volume: 1_000, trade_count: 10, closed: true,
    ...overrides,
  } as BarFrame;
}

describe("bar sides", () => {
  it("uses the reported sell side and keeps unsided volume out of both", () => {
    const sides = barSides(bar({ volume: 1_000, buy_volume: 400, sell_volume: 300 }));

    expect(sides).toMatchObject({ known: true, buy: 400, sell: 300, unknown: 300, delta: 100, sided: 700 });
    expect(barDelta(bar({ volume: 1_000, buy_volume: 400, sell_volume: 300 }))).toBe(100);
  });

  it("falls back to volume minus buy when no sell side is reported, which is what Binance bars mean", () => {
    const sides = barSides(bar({ provider: "BINANCE", marketKind: "SPOT", volume: 1_000, buy_volume: 400 }));

    expect(sides).toMatchObject({ known: true, buy: 400, sell: 600, unknown: 0, delta: -200 });
  });

  it("reports nothing rather than zero when the bar carries no split at all", () => {
    expect(barSides(bar())).toMatchObject({ known: false, delta: 0 });
    expect(barDelta(bar())).toBeNull();
  });

  it("never lets rounding push a side past the bar's own volume", () => {
    const sides = barSides(bar({ volume: 10, buy_volume: 6, sell_volume: 5 }));

    expect(sides.unknown).toBe(0);
    expect(sides.delta).toBe(1);
  });

  it("measures the unsided share across bars, and says nothing when no bar carries a split", () => {
    const bars = [
      bar({ volume: 1_000, buy_volume: 400, sell_volume: 300 }),
      bar({ volume: 1_000, buy_volume: 500, sell_volume: 500 }),
    ];

    expect(unsidedShare(bars)).toBeCloseTo(0.15, 9);
    expect(unsidedShare([bar()])).toBeNull();
    expect(unsidedShare([])).toBeNull();
  });
});
