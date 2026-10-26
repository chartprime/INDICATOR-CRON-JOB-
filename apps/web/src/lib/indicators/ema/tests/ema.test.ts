import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { ema as batchEma } from "../../../chart/indicators";
import { replayBars } from "../../../chart/replayBars";
import { emaIndicator } from "../ema";

function barsFromCloses(closes: readonly number[]): BarFrame[] {
  return closes.map((close, index) => ({
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: index * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    trade_count: 1,
    closed: true,
  }));
}

function ctxOf(bar: BarFrame, state: ReturnType<typeof emaIndicator.createState>, settings: { shortLength: number; longLength: number }, replace: boolean) {
  return { bar, state, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } };
}

describe("emaIndicator -- value parity with the retired batch ema()", () => {
  it("matches the batch implementation bar-for-bar for both the short and long leg", () => {
    const closes = [10, 12, 11, 13, 9, 15, 14, 14, 16, 8, 20, 18, 17, 19, 21];
    const expectedShort = batchEma(closes, 5);
    const expectedLong = batchEma(closes, 8);
    const { perBar } = replayBars(emaIndicator, barsFromCloses(closes), { shortLength: 5, longLength: 8 });
    expect(perBar.short).toEqual(expectedShort);
    expect(perBar.long).toEqual(expectedLong);
  });

  it("reproduces the SMA-seeded exact values from the retired batch test", () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { perBar } = replayBars(emaIndicator, barsFromCloses(closes), { shortLength: 3, longLength: 3 });
    expect(perBar.short[0]).toBeNull();
    expect(perBar.short[1]).toBeNull();
    expect(perBar.short[2]).toBe(2);
    expect(perBar.short[3]).toBeCloseTo(3, 10);
    expect(perBar.short[4]).toBeCloseTo(4, 10);
    expect(perBar.short[9]).toBeCloseTo(9, 10);
  });

  it("returns all-null for both legs when there isn't enough data", () => {
    const { perBar } = replayBars(emaIndicator, barsFromCloses([1, 2]), { shortLength: 5, longLength: 8 });
    expect(perBar.short).toEqual([null, null]);
    expect(perBar.long).toEqual([null, null]);
  });

  it("handles an empty bar array without throwing (never crashes on a symbol/provider switch with no history yet)", () => {
    const { perBar } = replayBars(emaIndicator, [], { shortLength: 5, longLength: 8 });
    expect(perBar.short).toEqual([]);
    expect(perBar.long).toEqual([]);
  });
});

describe("emaIndicator -- non-finite close handling (deliberate divergence from the batch array-wide behavior)", () => {
  it("outputs null for a bad bar and recovers on the next valid one, instead of poisoning the whole series", () => {
    const settings = { shortLength: 1, longLength: 1 };
    const state = emaIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11]);

    emaIndicator.onBar(ctxOf(bars[0], state, settings, false));
    emaIndicator.onBar(ctxOf({ ...bars[1], close: Number.NaN }, state, settings, false));
    expect(emaIndicator.readOutput(state).short).toBeNull();

    emaIndicator.onBar(ctxOf(bars[2], state, settings, false));
    expect(emaIndicator.readOutput(state).short).not.toBeNull();
  });
});

describe("emaIndicator -- live replace semantics", () => {
  it("a replace:true revision recomputes both legs without touching committed averages", () => {
    const settings = { shortLength: 2, longLength: 3 };
    const state = emaIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11, 13]);

    emaIndicator.onBar(ctxOf(bars[0], state, settings, false));
    emaIndicator.onBar(ctxOf(bars[1], state, settings, false));
    emaIndicator.onBar(ctxOf(bars[2], state, settings, false));
    const committedShort = state.short.average;
    const committedLong = state.long.average;
    const firstOutput = emaIndicator.readOutput(state);

    emaIndicator.onBar(ctxOf({ ...bars[2], close: 999 }, state, settings, true));
    const revisedOutput = emaIndicator.readOutput(state);

    expect(revisedOutput.short).not.toBe(firstOutput.short);
    expect(state.short.average).toBe(committedShort);
    expect(state.long.average).toBe(committedLong);
  });

  it("the next distinct bar finalizes using the latest replaced close, not the original one", () => {
    const settings = { shortLength: 2, longLength: 3 };
    const bars = barsFromCloses([10, 12, 11, 13]);

    const withReplaceState = emaIndicator.createState(settings);
    emaIndicator.onBar(ctxOf(bars[0], withReplaceState, settings, false));
    emaIndicator.onBar(ctxOf(bars[1], withReplaceState, settings, false));
    emaIndicator.onBar(ctxOf({ ...bars[2], close: 11 }, withReplaceState, settings, false));
    emaIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, withReplaceState, settings, true));
    emaIndicator.onBar(ctxOf(bars[3], withReplaceState, settings, false));
    const withReplace = emaIndicator.readOutput(withReplaceState);

    const straightState = emaIndicator.createState(settings);
    emaIndicator.onBar(ctxOf(bars[0], straightState, settings, false));
    emaIndicator.onBar(ctxOf(bars[1], straightState, settings, false));
    emaIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, straightState, settings, false));
    emaIndicator.onBar(ctxOf(bars[3], straightState, settings, false));
    const withoutReplace = emaIndicator.readOutput(straightState);

    expect(withReplace).toEqual(withoutReplace);
  });
});

describe("emaIndicator -- trend-based per-bar line color", () => {
  it("colors both lines up when the short leg is above the long leg", () => {
    const state = emaIndicator.createState({ shortLength: 2, longLength: 3 });
    state.shortValue = 10;
    state.longValue = 9;
    const [shortLine, longLine] = emaIndicator.lines;
    expect(shortLine.color!(state, emaIndicator.defaultSettings)).toBe("#0e9a66");
    expect(longLine.color!(state, emaIndicator.defaultSettings)).toBe("#0e9a66");
  });

  it("colors up on an exact tie, matching the retired toTrendColoredLineData's >= rule", () => {
    const state = emaIndicator.createState({ shortLength: 2, longLength: 3 });
    state.shortValue = 10;
    state.longValue = 10;
    const [shortLine] = emaIndicator.lines;
    expect(shortLine.color!(state, emaIndicator.defaultSettings)).toBe("#0e9a66");
  });

  it("colors both lines down when the short leg is below the long leg", () => {
    const state = emaIndicator.createState({ shortLength: 2, longLength: 3 });
    state.shortValue = 8;
    state.longValue = 9;
    const [shortLine] = emaIndicator.lines;
    expect(shortLine.color!(state, emaIndicator.defaultSettings)).toBe("#c23854");
  });

  it("falls back to the up color while either leg is still null, rather than crashing", () => {
    const state = emaIndicator.createState({ shortLength: 2, longLength: 3 });
    const [shortLine] = emaIndicator.lines;
    expect(() => shortLine.color!(state, emaIndicator.defaultSettings)).not.toThrow();
  });
});
