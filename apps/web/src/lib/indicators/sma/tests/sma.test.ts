import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { SettingsFieldSchema } from "../../../chart/indicatorTypes";
import { replayBars } from "../../../chart/replayBars";
import { smaIndicator, type SmaSettings } from "../sma";

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
  state: ReturnType<typeof smaIndicator.createState>,
  settings: { length: number; color: "purple" | "blue" | "green" },
  replace: boolean,
) {
  return { bar, state, settings, replace, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 } };
}

describe("smaIndicator -- hand-computed exact values", () => {
  it("is null before the window is full, then a plain moving average of the last `length` closes", () => {
    const closes = [1, 2, 3, 4, 5];
    const { perBar } = replayBars(smaIndicator, barsFromCloses(closes), { length: 3, color: "purple" as const });
    expect(perBar.value[0]).toBeNull();
    expect(perBar.value[1]).toBeNull();
    expect(perBar.value[2]).toBeCloseTo(2, 10); // mean(1,2,3)
    expect(perBar.value[3]).toBeCloseTo(3, 10); // mean(2,3,4)
    expect(perBar.value[4]).toBeCloseTo(4, 10); // mean(3,4,5)
  });

  it("tracks a non-trivial series correctly", () => {
    const closes = [10, 20, 30, 40];
    const { perBar } = replayBars(smaIndicator, barsFromCloses(closes), { length: 2, color: "purple" as const });
    expect(perBar.value).toEqual([null, 15, 25, 35]);
  });

  it("returns all-null when there isn't enough data", () => {
    const { perBar } = replayBars(smaIndicator, barsFromCloses([1, 2]), { length: 5, color: "purple" as const });
    expect(perBar.value).toEqual([null, null]);
  });

  it("handles an empty bar array without throwing (never crashes on a symbol/provider switch with no history yet)", () => {
    const { perBar } = replayBars(smaIndicator, [], { length: 20, color: "purple" as const });
    expect(perBar.value).toEqual([]);
  });
});

describe("smaIndicator -- live replace semantics", () => {
  it("a replace:true revision recomputes without touching the committed window", () => {
    const settings = { length: 3, color: "purple" as const };
    const state = smaIndicator.createState(settings);
    const bars = barsFromCloses([10, 12, 11, 13]);

    smaIndicator.onBar(ctxOf(bars[0], state, settings, false));
    smaIndicator.onBar(ctxOf(bars[1], state, settings, false));
    smaIndicator.onBar(ctxOf(bars[2], state, settings, false));
    const committedWindow = [...state.committedWindow];
    const firstValue = state.value;

    smaIndicator.onBar(ctxOf({ ...bars[2], close: 999 }, state, settings, true));

    expect(state.value).not.toBe(firstValue);
    expect(state.committedWindow).toEqual(committedWindow);
  });

  it("the next distinct bar finalizes using the latest replaced close, not the original one", () => {
    const settings = { length: 2, color: "purple" as const };
    const bars = barsFromCloses([10, 12, 11, 13]);

    const withReplaceState = smaIndicator.createState(settings);
    smaIndicator.onBar(ctxOf(bars[0], withReplaceState, settings, false));
    smaIndicator.onBar(ctxOf(bars[1], withReplaceState, settings, false));
    smaIndicator.onBar(ctxOf({ ...bars[2], close: 11 }, withReplaceState, settings, false));
    smaIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, withReplaceState, settings, true));
    smaIndicator.onBar(ctxOf(bars[3], withReplaceState, settings, false));
    const withReplace = smaIndicator.readOutput(withReplaceState);

    const straightState = smaIndicator.createState(settings);
    smaIndicator.onBar(ctxOf(bars[0], straightState, settings, false));
    smaIndicator.onBar(ctxOf(bars[1], straightState, settings, false));
    smaIndicator.onBar(ctxOf({ ...bars[2], close: 50 }, straightState, settings, false));
    smaIndicator.onBar(ctxOf(bars[3], straightState, settings, false));
    const withoutReplace = smaIndicator.readOutput(straightState);

    expect(withReplace).toEqual(withoutReplace);
  });

  it("the committed window stays capped at `length` entries as bars keep arriving, not growing unbounded", () => {
    const settings = { length: 3, color: "purple" as const };
    const state = smaIndicator.createState(settings);
    const bars = barsFromCloses([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bar of bars) smaIndicator.onBar(ctxOf(bar, state, settings, false));
    expect(state.committedWindow.length).toBeLessThanOrEqual(settings.length);
  });
});

describe("smaIndicator -- settings-driven color (the cosmetic/recompute split's real production exercise)", () => {
  it("resolves each preset color choice to its hex value, ignoring state entirely", () => {
    const state = smaIndicator.createState({ length: 3, color: "purple" as const });
    const [line] = smaIndicator.lines;
    expect(line.color!(state, { length: 3, color: "purple" as const })).toBe("#8672b3");
    expect(line.color!(state, { length: 3, color: "blue" })).toBe("#2563eb");
    expect(line.color!(state, { length: 3, color: "green" })).toBe("#16a34a");
  });

  it("length is tagged recompute and color is tagged cosmetic in the settings schema", () => {
    const lengthField = smaIndicator.settingsSchema!.find(
      (field): field is Extract<SettingsFieldSchema<SmaSettings>, { kind: "numeric" }> => field.kind === "numeric",
    );
    const colorField = smaIndicator.settingsSchema!.find(
      (field): field is Extract<SettingsFieldSchema<SmaSettings>, { kind: "radioGroup" }> => field.kind === "radioGroup",
    );
    expect(lengthField?.affects).toBe("recompute");
    expect(colorField?.affects).toBe("cosmetic");
  });
});
