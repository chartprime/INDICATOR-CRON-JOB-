import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { bollingerBands as batchBollingerBands } from "../../../chart/indicators";
import { replayBars } from "../../../chart/replayBars";
import { bollingerIndicator } from "../bollinger";

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

function ctxOf(
  bar: BarFrame,
  state: ReturnType<typeof bollingerIndicator.createState>,
  settings: { length: number; mult: number },
  replace: boolean,
) {
  return { bar, state, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } };
}

describe("bollingerIndicator -- value parity with the retired batch bollingerBands()", () => {
  it("matches the batch implementation bar-for-bar across basis, upper and lower", () => {
    const closes = [10, 12, 11, 13, 9, 15, 14, 14, 16, 8, 20, 18, 17, 19, 21];
    const expected = batchBollingerBands(closes, 4, 2);
    const { perBar } = replayBars(bollingerIndicator, barsFromCloses(closes), { length: 4, mult: 2 });
    expect(perBar.basis).toEqual(expected.map((band) => band?.basis ?? null));
    expect(perBar.upper).toEqual(expected.map((band) => band?.upper ?? null));
    expect(perBar.lower).toEqual(expected.map((band) => band?.lower ?? null));
  });

  it("reproduces the exact hand-computed values from the retired batch test", () => {
    const closes = [1, 2, 3, 4, 5];
    const { perBar } = replayBars(bollingerIndicator, barsFromCloses(closes), { length: 3, mult: 2 });
    expect(perBar.basis[0]).toBeNull();
    expect(perBar.basis[1]).toBeNull();
    expect(perBar.basis[2]).toBeCloseTo(2, 10);
    expect(perBar.upper[2]).toBeCloseTo(3.633, 3);
    expect(perBar.lower[2]).toBeCloseTo(0.367, 3);
    expect(perBar.basis[3]).toBeCloseTo(3, 10);
    expect(perBar.basis[4]).toBeCloseTo(4, 10);
  });

  it("returns all-null across all three lines when there isn't enough data", () => {
    const { perBar } = replayBars(bollingerIndicator, barsFromCloses([1, 2]), { length: 5, mult: 2 });
    expect(perBar.basis).toEqual([null, null]);
    expect(perBar.upper).toEqual([null, null]);
    expect(perBar.lower).toEqual([null, null]);
  });

  it("fails closed on a negative multiplier instead of producing a negative-width band", () => {
    const { perBar } = replayBars(bollingerIndicator, barsFromCloses([1, 2, 3]), { length: 2, mult: -1 });
    expect(perBar.basis).toEqual([null, null, null]);
  });

  it("handles an empty bar array without throwing (never crashes on a symbol/provider switch with no history yet)", () => {
    const { perBar } = replayBars(bollingerIndicator, [], { length: 20, mult: 2 });
    expect(perBar.basis).toEqual([]);
  });
});

describe("bollingerIndicator -- live replace semantics", () => {
  it("a replace:true revision recomputes the window without touching the committed window", () => {
    const settings = { length: 3, mult: 2 };
    const state = bollingerIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11, 13]);

    bollingerIndicator.onBar(ctxOf(bars[0], state, settings, false));
    bollingerIndicator.onBar(ctxOf(bars[1], state, settings, false));
    bollingerIndicator.onBar(ctxOf(bars[2], state, settings, false));
    const committedWindow = [...state.committedWindow];
    const firstBasis = state.basis;

    bollingerIndicator.onBar(ctxOf({ ...bars[2], close: 999 }, state, settings, true));

    expect(state.basis).not.toBe(firstBasis);
    expect(state.committedWindow).toEqual(committedWindow);
  });

  it("the next distinct bar finalizes using the latest replaced close, not the original one", () => {
    const settings = { length: 2, mult: 2 };
    const bars = barsFromCloses([10, 12, 11, 13]);

    const withReplaceState = bollingerIndicator.createState(settings);
    bollingerIndicator.onBar(ctxOf(bars[0], withReplaceState, settings, false));
    bollingerIndicator.onBar(ctxOf(bars[1], withReplaceState, settings, false));
    bollingerIndicator.onBar(ctxOf({ ...bars[2], close: 11 }, withReplaceState, settings, false));
    bollingerIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, withReplaceState, settings, true));
    bollingerIndicator.onBar(ctxOf(bars[3], withReplaceState, settings, false));
    const withReplace = bollingerIndicator.readOutput(withReplaceState);

    const straightState = bollingerIndicator.createState(settings);
    bollingerIndicator.onBar(ctxOf(bars[0], straightState, settings, false));
    bollingerIndicator.onBar(ctxOf(bars[1], straightState, settings, false));
    bollingerIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, straightState, settings, false));
    bollingerIndicator.onBar(ctxOf(bars[3], straightState, settings, false));
    const withoutReplace = bollingerIndicator.readOutput(straightState);

    expect(withReplace).toEqual(withoutReplace);
  });

  it("the committed window stays capped at `length` entries as bars keep arriving, not growing unbounded", () => {
    const settings = { length: 3, mult: 2 };
    const state = bollingerIndicator.createState(settings);
    const bars = barsFromCloses([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bar of bars) bollingerIndicator.onBar(ctxOf(bar, state, settings, false));
    expect(state.committedWindow.length).toBeLessThanOrEqual(settings.length);
  });
});
