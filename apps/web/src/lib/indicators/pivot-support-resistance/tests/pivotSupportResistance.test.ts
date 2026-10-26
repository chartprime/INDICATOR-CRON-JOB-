import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import {
  pivotSupportResistanceIndicator,
  type PivotSupportResistanceSettings,
  type PivotSupportResistanceState,
} from "../pivotSupportResistance";

const SETTINGS: PivotSupportResistanceSettings = {
  leftBars: 1,
  rightBars: 1,
  maxLevels: 10,
  supportColor: "#16a34a",
  resistanceColor: "#dc2626",
  lineStyle: "dashed",
};

function bar(index: number, high: number, low: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: index * 60_000,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
    trade_count: 1,
    closed: true,
  } as BarFrame;
}

function context(
  state: PivotSupportResistanceState,
  nextBar: BarFrame,
  settings: PivotSupportResistanceSettings = SETTINGS,
): IndicatorBarCtx<
  PivotSupportResistanceState,
  PivotSupportResistanceSettings
> {
  return {
    bar: nextBar,
    trades: [],
    tradeAvailability: "HISTORICAL_UNAVAILABLE",
    state,
    settings,
    replace: false,
    replaying: false,
    ta: {},
    draw: { fill: () => {} },
    markers: { plotshape: () => {}, plotchar: () => {} },
    pane: { paneIndex: 0 },
  };
}

function makeState(
  settings: PivotSupportResistanceSettings = SETTINGS,
): PivotSupportResistanceState {
  return withDrawOwnerScope("pivot-support-resistance-test", () =>
    pivotSupportResistanceIndicator.createState(settings),
  );
}

beforeEach(() => {
  resetDrawRegistryForTests();
});

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("pivotSupportResistanceIndicator", () => {
  it("keeps confirmed support and resistance levels and labels them at the latest bar", () => {
    const state = makeState();
    pivotSupportResistanceIndicator.onBar(context(state, bar(0, 2, 5)));
    pivotSupportResistanceIndicator.onBar(
      context(state, bar(1, 5, 1), SETTINGS),
    );
    pivotSupportResistanceIndicator.onBar(context(state, bar(2, 3, 4)));

    expect(state.levels).toHaveLength(2);
    expect(state.levels.map((level) => [level.kind, level.price])).toEqual([
      ["resistance", 5],
      ["support", 1],
    ]);

    const records = handlesForOwners(["pivot-support-resistance-test"]);
    const labels = records.filter((record) => record.kind === "label");
    const lines = records.filter((record) => record.kind === "line");
    expect(lines.map((record) => record.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          time1: 60_000,
          time2: 120_000,
          price1: 5,
          price2: 5,
        }),
        expect.objectContaining({
          time1: 60_000,
          time2: 120_000,
          price1: 1,
          price2: 1,
        }),
      ]),
    );
    expect(labels.map((record) => record.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ time: 120_000, price: 5, text: "R 5" }),
        expect.objectContaining({
          time: 120_000,
          price: 1,
          text: "S 1",
          textColor: "#16a34a",
        }),
      ]),
    );
    expect(labels.map((record) => record.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "R 5", textColor: "#dc2626" }),
      ]),
    );
  });

  it("removes resistance on a high cross and support on a low cross", () => {
    const state = makeState();
    pivotSupportResistanceIndicator.onBar(context(state, bar(0, 2, 5)));
    pivotSupportResistanceIndicator.onBar(
      context(state, bar(1, 5, 1), SETTINGS),
    );
    pivotSupportResistanceIndicator.onBar(context(state, bar(2, 3, 4)));
    pivotSupportResistanceIndicator.onBar(context(state, bar(3, 6, 0)));

    expect(state.levels).toHaveLength(0);
    expect(state.renderSlots.every((level) => !level.active)).toBe(true);
  });

  it("applies custom level colors and line style", () => {
    const settings: PivotSupportResistanceSettings = {
      leftBars: 1,
      rightBars: 1,
      maxLevels: 10,
      supportColor: "#2563eb",
      resistanceColor: "#ea580c",
      lineStyle: "solid",
    };
    const state = makeState(settings);
    pivotSupportResistanceIndicator.onBar(
      context(state, bar(0, 2, 5), settings),
    );
    pivotSupportResistanceIndicator.onBar(
      context(state, bar(1, 5, 1), settings),
    );
    pivotSupportResistanceIndicator.onBar(
      context(state, bar(2, 3, 4), settings),
    );

    const records = handlesForOwners(["pivot-support-resistance-test"]);
    expect(
      records
        .filter((record) => record.kind === "line")
        .map((record) => record.data),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ color: "#ea580c", style: "solid" }),
        expect.objectContaining({ color: "#2563eb", style: "solid" }),
      ]),
    );
  });

  it("caps active levels at the configured maximum", () => {
    const settings: PivotSupportResistanceSettings = {
      ...SETTINGS,
      maxLevels: 3,
    };
    const state = makeState(settings);
    for (let index = 0; index < 13; index += 1) {
      const base = 100 + index * 10;
      pivotSupportResistanceIndicator.onBar(
        context(state, bar(index * 3, base + 1, base - 1), settings),
      );
      pivotSupportResistanceIndicator.onBar(
        context(state, bar(index * 3 + 1, base + 5, base - 5), settings),
      );
      pivotSupportResistanceIndicator.onBar(
        context(state, bar(index * 3 + 2, base + 2, base - 2), settings),
      );
    }

    expect(state.levels.length).toBeGreaterThan(3);
    expect(state.renderSlots.filter((level) => level.active)).toHaveLength(3);
  });
});
