import { describe, it, expect, vi } from "vitest";
import {
  marketStructureIndicator,
  MAX_STRUCTURE_OBJECTS,
  type MarketStructureSettings,
  type MarketStructureState,
} from "../marketStructure";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import type { BarFrame } from "../../../../types/frames";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import type { LabelData } from "../../../chart/draw/label";

function makeBar(
  ts_open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  buyVolume: number | null = 50,
  closed = true,
): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTCUSDT",
    interval_ms: 60_000,
    ts_open,
    open: (high + low) / 2,
    high,
    low,
    close,
    volume,
    ...(buyVolume === null ? {} : { buy_volume: buyVolume }),
    trade_count: 10,
    closed,
  };
}

function context(
  state: MarketStructureState,
  bar: BarFrame,
  settings: MarketStructureSettings,
  replace = false,
): IndicatorBarCtx<MarketStructureState, MarketStructureSettings> {
  return {
    bar,
    trades: [],
    tradeAvailability: "LIVE_COMPLETE",
    state,
    settings,
    replace,
    replaying: false,
    ta: {},
    draw: { fill: vi.fn() },
    markers: { plotshape: vi.fn(), plotchar: vi.fn() },
    pane: { paneIndex: 0 },
  };
}

function createState(
  settings: MarketStructureSettings,
  ownerId = "market-structure-test",
): MarketStructureState {
  return withDrawOwnerScope(ownerId, () =>
    withStreamCreationWindow(() => marketStructureIndicator.createState(settings)),
  );
}

// Pivot high 20 at bar 5 (confirmed at bar 10), broken by close 21 at bar 11.
const BULLISH_BREAK = [
  { h: 10, l: 8, c: 9 },
  { h: 11, l: 7, c: 10 },
  { h: 12, l: 6, c: 11 },
  { h: 13, l: 5, c: 12 },
  { h: 14, l: 4, c: 13 },
  { h: 20, l: 10, c: 19 },
  { h: 12, l: 6, c: 11 },
  { h: 11, l: 7, c: 10 },
  { h: 10, l: 8, c: 9 },
  { h: 12, l: 7, c: 11 },
  { h: 13, l: 6, c: 12 },
  { h: 22, l: 12, c: 21 },
];

const T0 = 1_000_000;
const STEP = 60_000;

function feed(
  state: MarketStructureState,
  settings: MarketStructureSettings,
  bars: readonly { h: number; l: number; c: number; buy?: number | null }[],
  startIndex = 0,
): void {
  bars.forEach((c, i) => {
    const bar = makeBar(T0 + (startIndex + i) * STEP, c.h, c.l, c.c, 100, c.buy);
    marketStructureIndicator.onBar(context(state, bar, settings));
  });
}

function positionedLabels(ownerId: string): LabelData[] {
  return handlesForOwners([ownerId])
    .filter((record) => record.kind === "label")
    .map((record) => record.data as LabelData)
    .filter((label) => label.time !== 0);
}

describe("marketStructureIndicator with Delta Volume Grading", () => {
  it("detects swings, accumulates breakout candle deltas, and assigns correct conviction grades", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings);
    const buys = [50, 50, 50, 50, 50, 50, 50, 50, 55, 70, 75, 80];
    feed(
      state,
      settings,
      BULLISH_BREAK.map((c, i) => ({ ...c, buy: buys[i] })),
    );

    expect(state.events).toHaveLength(1);
    const [event] = state.events;
    expect(event.type).toBe("BOS");
    expect(event.kind).toBe("bullish");
    expect(event.price).toBe(20);
    expect(event.pivotTime).toBe(T0 + 5 * STEP);
    expect(event.breakTime).toBe(T0 + 11 * STEP);
    expect(event.midTime).toBe(T0 + 8 * STEP);
    // Bars 5..11: deltas 0,0,0,+10,+40,+50,+60 over volume 700.
    expect(event.delta).toBe(160);
    expect(event.ratio).toBeCloseTo(160 / 700, 10);
    expect(event.grade).toBe("+++");
  });

  it("assigns the divergent grade ~ when a bullish breakout occurs on negative net delta", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings);
    feed(
      state,
      settings,
      BULLISH_BREAK.map((c, i) => ({ ...c, buy: i >= 8 ? 20 : 50 })),
    );

    expect(state.events).toHaveLength(1);
    expect(state.events[0].delta).toBeLessThan(0);
    expect(state.events[0].grade).toBe("~");
  });

  it("grades every band on both sides, including ++ between 5% and 15%", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const gradeAt = (buy: number): string => {
      const state = createState(settings);
      feed(state, settings, BULLISH_BREAK.map((c) => ({ ...c, buy })));
      return state.events[0].grade;
    };
    expect(gradeAt(51)).toBe("+");
    expect(gradeAt(55)).toBe("++");
    expect(gradeAt(60)).toBe("+++");
    expect(gradeAt(80)).toBe("++++");
    expect(gradeAt(40)).toBe("~");

    const bearish = createState(settings);
    feed(
      bearish,
      settings,
      BULLISH_BREAK.map((c) => ({ h: 30 - c.l, l: 30 - c.h, c: 30 - c.c, buy: 45 })),
    );
    expect(bearish.events[0].kind).toBe("bearish");
    expect(bearish.events[0].grade).toBe("++");
  });

  it("does not grade a break whose span holds a bar without aggressor classification", () => {
    resetDrawRegistryForTests();
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings, "unknown-delta");
    feed(
      state,
      settings,
      BULLISH_BREAK.map((c, i) => ({ ...c, buy: i === 9 ? null : 80 })),
    );

    expect(state.events).toHaveLength(1);
    expect(state.events[0].delta).toBeNull();
    expect(state.events[0].ratio).toBeNull();
    expect(state.events[0].grade).toBe("");
    const labels = positionedLabels("unknown-delta");
    expect(labels.find((label) => label.time === T0 + 8 * STEP)?.text).toBe("BOS");
    expect(
      labels.filter((label) => label.text === "" && label.color !== "transparent"),
    ).toHaveLength(0);
  });

  it("commits swings and breaks only on closed bars, so a wick through the swing high is not a break", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings);
    feed(state, settings, BULLISH_BREAK.slice(0, 11));
    expect(state.lastSwingHighPrice).toBe(20);

    const ts = T0 + 11 * STEP;
    marketStructureIndicator.onBar(
      context(state, makeBar(ts, 21, 12, 21, 100, 50, false), settings),
    );
    expect(state.events).toHaveLength(0);
    expect(state.lastSwingHighPrice).toBe(20);
    expect(state.lastTrend).toBeNull();

    marketStructureIndicator.onBar(
      context(state, makeBar(ts, 21, 12, 15, 100, 50, true), settings, true),
    );
    expect(state.events).toHaveLength(0);
    expect(state.lastSwingHighPrice).toBe(20);

    marketStructureIndicator.onBar(
      context(state, makeBar(ts + STEP, 22, 12, 21, 100, 50, true), settings),
    );
    expect(state.events).toHaveLength(1);
    expect(state.events[0].breakTime).toBe(ts + STEP);
  });

  it("needs a close beyond the swing: a close exactly at the swing high is not a break", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings);
    feed(state, settings, [...BULLISH_BREAK.slice(0, 11), { h: 22, l: 12, c: 20 }]);
    expect(state.events).toHaveLength(0);
    feed(state, settings, [{ h: 22, l: 12, c: 21 }], 12);
    expect(state.events).toHaveLength(1);
  });

  it("breaks a swing low only on a close below it, and labels the break below the line", () => {
    // The bullish fixture mirrored about 30: swing low 10, broken by a close at 9.
    const mirrored = BULLISH_BREAK.map((c) => ({ h: 30 - c.l, l: 30 - c.h, c: 30 - c.c }));
    const settings = marketStructureIndicator.defaultSettings;
    const state = createState(settings);
    feed(state, settings, mirrored.slice(0, 11));
    expect(state.lastSwingLowPrice).toBe(10);
    feed(state, settings, [{ h: 18, l: 8, c: 11 }], 11);
    expect(state.events).toHaveLength(0);
    feed(state, settings, [{ h: 18, l: 8, c: 9 }], 12);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ kind: "bearish", price: 10 });
    expect(state.events[0].labelPrice).toBeLessThan(10);
  });

  it("a candle re-delivered while it forms is one bar, not several, in the delta behind the grade", () => {
    const settings = marketStructureIndicator.defaultSettings;
    const plain = createState(settings);
    feed(plain, settings, BULLISH_BREAK.map((c) => ({ ...c, buy: 80 })));

    const state = createState(settings);
    feed(state, settings, BULLISH_BREAK.slice(0, 11).map((c) => ({ ...c, buy: 80 })));
    const ts = T0 + 11 * STEP;
    marketStructureIndicator.onBar(context(state, makeBar(ts, 15, 12, 14, 100, 80, false), settings));
    marketStructureIndicator.onBar(context(state, makeBar(ts, 18, 12, 17, 100, 80, false), settings, true));
    marketStructureIndicator.onBar(context(state, makeBar(ts, 22, 12, 21, 100, 80, true), settings, true));

    expect(state.barTimes).toEqual(plain.barTimes);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].delta).toBe(plain.events[0].delta);
  });

  it("keeps recording BOS events while the BOS toggle is off, so turning it back on shows them", () => {
    const settings = { ...marketStructureIndicator.defaultSettings, showBOS: false };
    const state = createState(settings);
    feed(state, settings, BULLISH_BREAK.map((c) => ({ ...c, buy: 80 })));
    expect(state.events).toHaveLength(1);
    expect(state.events[0].type).toBe("BOS");
  });

  it("hides the pivot dot together with its line and label", () => {
    resetDrawRegistryForTests();
    const shown = marketStructureIndicator.defaultSettings;
    const state = createState(shown, "toggle");
    feed(state, shown, BULLISH_BREAK.map((c) => ({ ...c, buy: 80 })));

    const visibleDots = () =>
      positionedLabels("toggle").filter(
        (label) => label.text === "" && label.color !== "transparent",
      );
    expect(visibleDots()).toHaveLength(1);
    expect(visibleDots()[0].price).toBe(20);

    const hidden = { ...shown, showBOS: false };
    marketStructureIndicator.onBar(
      context(state, makeBar(T0 + 12 * STEP, 21, 19, 20, 100, 80), hidden),
    );
    expect(visibleDots()).toHaveLength(0);
    expect(positionedLabels("toggle").every((label) => label.text === "")).toBe(true);
  });

  it("labels an unbroken swing projection the way the break would be classified, including before any trend exists", () => {
    resetDrawRegistryForTests();
    const settings = { ...marketStructureIndicator.defaultSettings, swingLength: 2 };
    const state = createState(settings, "projection");
    feed(state, settings, BULLISH_BREAK.slice(0, 11));

    const projections = positionedLabels("projection").filter(
      (label) => label.text !== "",
    );
    expect(projections.map((label) => `${label.text}@${label.price}`).sort()).toEqual(["BOS@20", "BOS@4"]);

    feed(state, settings, [BULLISH_BREAK[11]], 11);
    expect(state.lastTrend).toBe("bullish");
    expect(state.lastSwingHighPrice).toBeNull();
    // The projection of the swing just broken is gone on the break bar itself, not one bar later.
    expect(
      positionedLabels("projection").filter(
        (label) => label.text !== "" && label.price === 20,
      ),
    ).toHaveLength(0);

    feed(state, settings, [{ h: 22, l: 15, c: 16 }], 12);
    const lowProjection = positionedLabels("projection").filter(
      (label) => label.text === "CHoCH",
    );
    expect(lowProjection).toHaveLength(1);
  });

  it("bounds the event history to MAX_STRUCTURE_OBJECTS", () => {
    const settings = { ...marketStructureIndicator.defaultSettings, swingLength: 1 };
    const state = createState(settings);
    // A rising staircase: every even bar is a pivot high that the next even bar closes above.
    const bars: { h: number; l: number; c: number }[] = [];
    for (let i = 0; i < 400; i += 1) {
      const h = (i % 2 === 0 ? 12 : 10) + i * 0.25;
      bars.push(i % 2 === 0 ? { h, l: h - 4, c: h - 0.25 } : { h, l: h - 4, c: h - 3 });
    }
    feed(state, settings, bars);
    expect(state.events.length).toBe(MAX_STRUCTURE_OBJECTS);
    expect(state.events[MAX_STRUCTURE_OBJECTS - 1].breakTime).toBe(T0 + 398 * STEP);
  });
});
