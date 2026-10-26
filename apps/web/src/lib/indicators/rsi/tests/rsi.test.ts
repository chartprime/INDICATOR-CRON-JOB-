import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { rsi as batchRsi } from "../../../chart/indicators";
import { replayBars } from "../../../chart/replayBars";
import { rsiIndicator } from "../rsi";

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

describe("rsiIndicator -- value parity with the retired batch rsi()", () => {
  it("matches the batch implementation bar-for-bar on a mixed up/down fixture", () => {
    const closes = [10, 12, 11, 13, 9, 15, 14, 14, 16, 8];
    const expected = batchRsi(closes, 3);
    const { perBar } = replayBars(rsiIndicator, barsFromCloses(closes), { length: 3 });
    expect(perBar.value).toEqual(expected);
  });

  it("reproduces the strictly-increasing exact values (100, never divides by zero)", () => {
    const closes = [1, 2, 3, 4, 5];
    const { perBar } = replayBars(rsiIndicator, barsFromCloses(closes), { length: 3 });
    expect(perBar.value).toEqual([null, null, null, 100, 100]);
  });

  it("reproduces the hand-computed mixed-series exact values", () => {
    const closes = [10, 12, 11, 13];
    const { perBar } = replayBars(rsiIndicator, barsFromCloses(closes), { length: 2 });
    expect(perBar.value[0]).toBeNull();
    expect(perBar.value[1]).toBeNull();
    expect(perBar.value[2]).toBeCloseTo(66.6667, 3);
    expect(perBar.value[3]).toBeCloseTo(85.7143, 3);
  });

  it("reproduces the neutral 50 on a flat series", () => {
    const closes = [100, 100, 100, 100];
    const { perBar } = replayBars(rsiIndicator, barsFromCloses(closes), { length: 3 });
    expect(perBar.value[3]).toBe(50);
  });

  it("stays null throughout when there isn't enough data yet", () => {
    const closes = [1, 2, 3];
    const { perBar } = replayBars(rsiIndicator, barsFromCloses(closes), { length: 5 });
    expect(perBar.value).toEqual([null, null, null]);
  });

  it("handles an empty bar array without throwing (never crashes on a symbol/provider switch with no history yet)", () => {
    const { perBar } = replayBars(rsiIndicator, [], { length: 14 });
    expect(perBar.value).toEqual([]);
  });
});

describe("rsiIndicator -- live replace semantics", () => {
  it("a replace:true revision recomputes the tentative value without touching committed averages", () => {
    const settings = { length: 2 };
    const state = rsiIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11]);

    rsiIndicator.onBar({ bar: bars[0], state, settings, replace: false, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } });
    rsiIndicator.onBar({ bar: bars[1], state, settings, replace: false, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } });
    rsiIndicator.onBar({ bar: bars[2], state, settings, replace: false, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } });
    const committedAverages = state.averages;
    const firstValue = rsiIndicator.readOutput(state).value;

    const revisedBar: BarFrame = { ...bars[2], close: 999 };
    rsiIndicator.onBar({ bar: revisedBar, state, settings, replace: true, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } });
    const revisedValue = rsiIndicator.readOutput(state).value;

    expect(revisedValue).not.toBe(firstValue);
    expect(state.averages).toEqual(committedAverages);
  });

  it("the next distinct bar finalizes using the latest replaced close, not the original one", () => {
    const settings = { length: 2 };
    const state = rsiIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11, 13]);
    const ctxOf = (bar: BarFrame, replace: boolean) => ({
      bar, state, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 },
    });

    rsiIndicator.onBar(ctxOf(bars[0], false));
    rsiIndicator.onBar(ctxOf(bars[1], false));
    rsiIndicator.onBar(ctxOf({ ...bars[2], close: 11 }, false));
    rsiIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, true));
    rsiIndicator.onBar(ctxOf(bars[3], false));
    const withReplace = rsiIndicator.readOutput(state).value;

    const straightState = rsiIndicator.createState(settings);
    const straightCtxOf = (bar: BarFrame, replace: boolean) => ({
      bar, state: straightState, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 },
    });
    rsiIndicator.onBar(straightCtxOf(bars[0], false));
    rsiIndicator.onBar(straightCtxOf(bars[1], false));
    rsiIndicator.onBar(straightCtxOf({ ...bars[2], close: 50 }, false));
    rsiIndicator.onBar(straightCtxOf(bars[3], false));
    const withoutReplace = rsiIndicator.readOutput(straightState).value;

    expect(withReplace).toBe(withoutReplace);
  });
});

describe("rsiIndicator -- non-finite close handling (deliberate divergence from the batch array-wide behavior)", () => {
  it("outputs null for a bad bar and recovers on the next valid one, instead of poisoning the whole series", () => {
    const settings = { length: 1 };
    const state = rsiIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11]);
    const ctxOf = (bar: BarFrame, replace: boolean) => ({
      bar, state, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 },
    });

    rsiIndicator.onBar(ctxOf(bars[0], false));
    rsiIndicator.onBar(ctxOf({ ...bars[1], close: Number.NaN }, false));
    expect(rsiIndicator.readOutput(state).value).toBeNull();

    rsiIndicator.onBar(ctxOf(bars[2], false));
    expect(rsiIndicator.readOutput(state).value).not.toBeNull();
  });
});
