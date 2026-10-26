import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import {
  withDrawOwnerScope,
  resetDrawOwnerScopeForTests,
} from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
  type DrawObjectRecord,
} from "../../../chart/draw/registry";
import type { LabelData } from "../../../chart/draw/label";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { ta } from "../../../chart/ta";
import {
  FVG_DELTA_MAX_ATR_LENGTH,
  FVG_DELTA_MAX_DISPLAYED_LEVELS,
  FVG_DELTA_MAX_REPLAY_BARS,
  FVG_DELTA_SETTINGS_SCHEMA,
  fvgDeltaIndicator,
  type FVGDeltaSettings,
  type FVGDeltaState,
} from "../fvgDelta";

const OWNER_ID = "fvg-delta-test";
const T0 = 1_000_000;
const STEP = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

// `null` (not `undefined`) signals "no buy volume": a default parameter
// substitutes even for an explicitly passed `undefined`, so `undefined`
// could never reach the returned bar as an absent field.
function makeBar(
  index: number,
  high: number,
  low: number,
  close: number,
  buyVolume: number | null = 100,
): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
    interval_ms: STEP,
    ts_open: T0 + index * STEP,
    open: (high + low) / 2,
    high,
    low,
    close,
    volume: 100,
    ...(buyVolume === null ? {} : { buy_volume: buyVolume }),
    trade_count: 10,
    closed: true,
  };
}

function makeContext(
  state: FVGDeltaState,
  bar: BarFrame,
  settings: FVGDeltaSettings,
): IndicatorBarCtx<FVGDeltaState, FVGDeltaSettings> {
  return {
    bar,
    trades: [],
    tradeAvailability: "LIVE_COMPLETE",
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

function createState(settings: FVGDeltaSettings): FVGDeltaState {
  return withDrawOwnerScope(OWNER_ID, () =>
    withStreamCreationWindow(() => fvgDeltaIndicator.createState(settings)),
  );
}

function records(kind: DrawObjectRecord["kind"]): DrawObjectRecord[] {
  return handlesForOwners([OWNER_ID]).filter((record) => record.kind === kind);
}

function labelData(): LabelData[] {
  return records("label").map((record) => record.data as LabelData);
}

function feed(
  state: FVGDeltaState,
  settings: FVGDeltaSettings,
  bars: readonly BarFrame[],
): void {
  for (const bar of bars) {
    fvgDeltaIndicator.onBar(makeContext(state, bar, settings));
  }
}

describe("fvgDeltaIndicator", () => {
  it("bounds a malformed ATR period before it reaches the technical-analysis stream", () => {
    const atr = vi.spyOn(ta, "atr");

    createState({
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: Number.MAX_SAFE_INTEGER,
      atrMultiplier: Number.POSITIVE_INFINITY,
    });

    expect(atr).toHaveBeenLastCalledWith(FVG_DELTA_MAX_ATR_LENGTH);
  });

  it("bounds a non-finite ATR multiplier before candidate detection", () => {
    const settings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: Number.POSITIVE_INFINITY,
      maxDisplayedLevels: 1,
    };
    const state = createState(settings);
    state.atr = { push: () => 1 };

    feed(state, settings, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 35, 30, 32.5),
    ]);

    expect(state.events).toHaveLength(1);
  });

  it("bounds malformed displayed-level settings before allocating draw pools", () => {
    const settings = {
      ...fvgDeltaIndicator.defaultSettings,
      maxDisplayedLevels: Number.MAX_SAFE_INTEGER,
    };

    const state = createState(settings);

    expect(state.linePool).toHaveLength(FVG_DELTA_MAX_DISPLAYED_LEVELS);
    expect(state.labelPool).toHaveLength(FVG_DELTA_MAX_DISPLAYED_LEVELS);
    expect(state.endLabelPool).toHaveLength(FVG_DELTA_MAX_DISPLAYED_LEVELS);
  });

  it("updates ATR once for each closed candle", () => {
    const settings = fvgDeltaIndicator.defaultSettings;
    const state = createState(settings);
    let updates = 0;
    state.atr = {
      push: () => {
        updates += 1;
        return 1;
      },
    };

    fvgDeltaIndicator.onBar(
      makeContext(state, makeBar(0, 10, 9, 9.5), settings),
    );

    expect(updates).toBe(1);
  });

  it("detects a bullish FVG one bar back and colors its line and labels by score", () => {
    const settings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
    };
    const state = createState(settings);

    feed(state, settings, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
    ]);

    expect(state.events).toHaveLength(1);
    const event = state.events[0];
    expect(event.kind).toBe("bullish");
    expect(event.time).toBe(T0 + STEP);
    expect(event.levelPrice).toBe(11);
    expect(event.delta).toBe(300);

    expect(fvgDeltaIndicator.getHoverData?.(state, settings)).toEqual([
      {
        kind: "bullish",
        time: T0 + STEP,
        levelPrice: 11,
        topPrice: 12,
        bottomPrice: 10,
        displayMode: "lines",
        bubblePrice: 11,
        buyVolume: 300,
        sellVolume: 0,
        delta: 300,
        score: 10,
      },
    ]);

    const lines = records("line");
    const labels = records("label");
    expect(lines).toHaveLength(1);
    expect(labels).toHaveLength(2);
    expect(lines[0].data).toMatchObject({
      time1: T0 + STEP,
      time2: T0 + 2 * STEP,
      price1: 11,
      price2: 11,
      color: "rgba(34,197,94,1)",
    });
    expect(labels.map((record) => record.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          time: T0 + STEP,
          price: 11,
          text: "10",
          color: "rgba(34,197,94,1)",
          textColor: "#ffffff",
        }),
        expect.objectContaining({
          time: T0 + 2 * STEP,
          price: 11,
          text: "",
          color: "rgba(34,197,94,1)",
          size: 6,
        }),
      ]),
    );
  });

  it("releases the line and both labels when a closed bar crosses the level", () => {
    const settings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
    };
    const state = createState(settings);
    feed(state, settings, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
      makeBar(3, 12, 10, 10.5),
    ]);

    expect(state.events[0].active).toBe(false);
    expect(records("line")[0].data).toMatchObject({ color: "transparent" });
    expect(labelData()).toHaveLength(2);
    expect(labelData().every((label) => label.color === "transparent")).toBe(
      true,
    );
  });

  it("keeps only the configured newest active level visible", () => {
    const settings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
    };
    const state = createState(settings);
    feed(state, settings, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
      makeBar(3, 14, 13, 13.5),
    ]);

    expect(state.events).toHaveLength(2);
    expect(state.events.filter((event) => event.slot !== null)).toHaveLength(1);
    expect(records("line")).toHaveLength(1);
    expect(labelData()).toHaveLength(2);
    expect(labelData().some((label) => label.text === "10")).toBe(true);
  });

  it("supports displayMode: boxes and plots boxes instead of lines", () => {
    const settings: FVGDeltaSettings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
      displayMode: "boxes",
    };
    const state = createState(settings);

    feed(state, settings, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
    ]);

    expect(state.events).toHaveLength(1);
    const event = state.events[0];
    expect(event.kind).toBe("bullish");
    expect(fvgDeltaIndicator.getHoverData?.(state, settings)).toEqual([
      expect.objectContaining({
        topPrice: 12,
        bottomPrice: 10,
        displayMode: "boxes",
      }),
    ]);

    const boxes = records("box");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].data).toMatchObject({
      time1: T0 + STEP,
      time2: T0 + 2 * STEP,
      price1: 12,
      price2: 10,
      borderColor: "rgba(34,197,94,1)",
      backgroundColor: "rgba(34,197,94,0.2)",
    });

    const lines = records("line");
    expect(lines[0].data).toMatchObject({
      color: "transparent",
    });
    expect(labelData()[1]).toMatchObject({ color: "transparent" });
  });

  it("mitigates with close when in lines mode and with wick when in boxes mode", () => {
    const settingsBoxes: FVGDeltaSettings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
      displayMode: "boxes",
    };
    const stateBoxes = createState(settingsBoxes);
    feed(stateBoxes, settingsBoxes, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
    ]);

    expect(stateBoxes.events[0].active).toBe(true);

    const wickMitigationBar: BarFrame = {
      ...makeBar(3, 12.5, 11.5, 12.2),
    };
    fvgDeltaIndicator.onBar(
      makeContext(stateBoxes, wickMitigationBar, settingsBoxes),
    );
    expect(stateBoxes.events[0].active).toBe(false);

    const settingsLines: FVGDeltaSettings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      maxDisplayedLevels: 1,
      displayMode: "lines",
    };
    const stateLines = createState(settingsLines);
    feed(stateLines, settingsLines, [
      makeBar(0, 10, 9, 9.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 13, 12, 12.5),
    ]);

    expect(stateLines.events[0].active).toBe(true);

    fvgDeltaIndicator.onBar(
      makeContext(stateLines, wickMitigationBar, settingsLines),
    );
    expect(stateLines.events[0].active).toBe(true);

    const closeMitigationBar: BarFrame = {
      ...makeBar(4, 12, 10.5, 10.8),
    };
    fvgDeltaIndicator.onBar(
      makeContext(stateLines, closeMitigationBar, settingsLines),
    );
    expect(stateLines.events[0].active).toBe(false);
  });

  it("ends a bearish zone when a later high touches its lower edge", () => {
    const settings: FVGDeltaSettings = {
      ...fvgDeltaIndicator.defaultSettings,
      atrLength: 1,
      atrMultiplier: 0.1,
      displayMode: "boxes",
    };
    const state = createState(settings);
    feed(state, settings, [
      makeBar(0, 13, 12, 12.5),
      makeBar(1, 11, 10, 10.5),
      makeBar(2, 10, 9, 9.5),
    ]);
    expect(state.events[0]).toMatchObject({ kind: "bearish", active: true, topPrice: 12, bottomPrice: 10 });

    feed(state, settings, [makeBar(3, 10, 9, 9.8)]);
    expect(state.events[0].active).toBe(false);
  });

  describe("buy/sell flow honesty", () => {
    it("does not create a candidate when any of its three bars lacks buy_volume", () => {
      const settings = {
        ...fvgDeltaIndicator.defaultSettings,
        atrLength: 1,
        atrMultiplier: 0.1,
        maxDisplayedLevels: 1,
      };
      const state = createState(settings);

      feed(state, settings, [
        makeBar(0, 10, 9, 9.5, null),
        makeBar(1, 11, 10, 10.5),
        makeBar(2, 13, 12, 12.5),
      ]);

      expect(state.events).toHaveLength(0);
      expect(records("line")[0].data).toMatchObject({ color: "transparent" });
    });

    it("never derives a sell figure or a directional score from total volume without a known buy volume", () => {
      const settings = {
        ...fvgDeltaIndicator.defaultSettings,
        atrLength: 1,
        atrMultiplier: 0.1,
        maxDisplayedLevels: 1,
      };
      const state = createState(settings);

      feed(state, settings, [
        makeBar(0, 10, 9, 9.5),
        makeBar(1, 11, 10, 10.5, null),
        makeBar(2, 13, 12, 12.5),
      ]);

      expect(state.events).toHaveLength(0);
    });

    it("still forms a candidate once a later window's three bars all carry known buy volume", () => {
      // The per-bar sliding window also evaluates windows that straddle the
      // unknown-flow bar and later, fully-known bars (real behavior, not a
      // bug -- the same lesson learned auditing PR #9's FVG Boxes). What
      // matters here is that flow recovers for windows past it, and no
      // survivor ever fabricates a split from the null bar.
      const settings = {
        ...fvgDeltaIndicator.defaultSettings,
        atrLength: 1,
        atrMultiplier: 0.1,
        maxDisplayedLevels: 10,
      };
      const state = createState(settings);

      feed(state, settings, [
        makeBar(0, 10, 9, 9.5, null),
        makeBar(1, 11, 10, 10.5),
        makeBar(2, 13, 12, 12.5),
        makeBar(3, 15, 14, 14.5),
        makeBar(4, 17, 16, 16.5),
      ]);

      expect(state.events.length).toBeGreaterThan(0);
      expect(
        state.events.every(
          (event) => event.buyVolume === 300 && event.sellVolume === 0,
        ),
      ).toBe(true);
    });

    it("keeps unsided volume out of the displayed sell side", () => {
      const settings = {
        ...fvgDeltaIndicator.defaultSettings,
        atrLength: 1,
        atrMultiplier: 0.1,
        maxDisplayedLevels: 10,
      };
      const state = createState(settings);
      const bars = [
        makeBar(0, 10, 9, 9.5, 30),
        makeBar(1, 11, 10, 10.5, 30),
        makeBar(2, 13, 12, 12.5, 30),
      ].map((entry) => ({ ...entry, sell_volume: 50 }));

      feed(state, settings, bars);

      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({ buyVolume: 90, sellVolume: 150, delta: -60 });
    });
  });

  describe("settings lifecycle (H-02)", () => {
    it("declares visibility flags, colors, and display mode as recompute settings, not cosmetic", () => {
      for (const key of [
        "displayMode",
        "showBullishFVG",
        "showBearishFVG",
        "bullishColor",
        "bearishColor",
      ] as const) {
        const field = FVG_DELTA_SETTINGS_SCHEMA.find(
          (candidate) => "key" in candidate && candidate.key === key,
        );
        expect(field && "affects" in field ? field.affects : undefined).toBe(
          "recompute",
        );
      }
    });
  });

  describe("historical replay is bounded (M-01)", () => {
    it("declares a replay cap, matching the bound every other stateful overlay declares", () => {
      expect(fvgDeltaIndicator.maxReplayBars).toBe(FVG_DELTA_MAX_REPLAY_BARS);
    });

    it("processing a full cap's worth of bars stays fast enough for interactive settings changes", () => {
      const settings = fvgDeltaIndicator.defaultSettings;
      const state = createState(settings);
      const bars: BarFrame[] = [];
      for (let index = 0; index < FVG_DELTA_MAX_REPLAY_BARS; index += 1) {
        const base = 100 + (index % 50);
        bars.push(makeBar(index, base + 2, base - 2, base));
      }
      const startedAt = performance.now();
      feed(state, settings, bars);
      const elapsedMs = performance.now() - startedAt;

      // A generous ceiling for the repository's pinned test environment --
      // this is a regression guard against reintroducing an unbounded
      // replay cost, not a production throughput claim.
      expect(elapsedMs).toBeLessThan(2_000);
    });
  });
});
