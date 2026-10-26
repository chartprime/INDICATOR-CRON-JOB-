import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import { replayBars } from "../../../chart/replayBars";
import {
  classicOrderBlocksIndicator,
  type OrderBlocksState,
} from "../classicOrderBlocks";
import {
  ZONE_WIDTH_LENGTH,
  type OrderBlockSettings,
} from "../orderBlockRules";
import {
  CARD_FILL,
  CARD_TEXT,
  MITIGATED_FILL_ALPHA,
  PRIMARY_FILL_ALPHA,
  isShown,
  withAlpha,
} from "../orderBlockRender";

const T0 = 1_000_000;
const STEP = 60_000;
// Both tiers shown here so the geometry of each is asserted; the shipped default hides the secondary tier.
const SETTINGS: OrderBlockSettings = {
  ...classicOrderBlocksIndicator.defaultSettings,
  pivotLength: 2,
  showSecondary: true,
};

function makeBar(
  ts_open: number,
  high: number,
  low: number,
  close: number,
  closed = true,
): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTCUSDT",
    interval_ms: STEP,
    ts_open,
    open: (high + low) / 2,
    high,
    low,
    close,
    volume: 100,
    trade_count: 10,
    closed,
  };
}

function context(
  state: OrderBlocksState,
  bar: BarFrame,
  settings: OrderBlockSettings,
  replace = false,
): IndicatorBarCtx<OrderBlocksState, OrderBlockSettings> {
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
  settings: OrderBlockSettings,
  ownerId: string,
): OrderBlocksState {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(ownerId, () =>
    withStreamCreationWindow(() =>
      classicOrderBlocksIndicator.createState(settings),
    ),
  );
}

// One hundred flat bars, each one point tall, so the zone width warms up and no pivot can form.
const WARMUP: { h: number; l: number; c: number }[] = Array.from(
  { length: ZONE_WIDTH_LENGTH },
  () => ({ h: 11, l: 10, c: 10.5 }),
);

// Then a swing high of 20 (bar 2 of this stretch), confirmed on bar 4, closed above on bar 6: the lowest low between is 9.
const BULL_BREAK = [
  { h: 12, l: 10, c: 11 },
  { h: 13, l: 10, c: 12 },
  { h: 20, l: 12, c: 19 },
  { h: 15, l: 11, c: 13 },
  { h: 14, l: 9, c: 12 },
  { h: 16, l: 10, c: 15 },
  { h: 22, l: 12, c: 21 },
];
const PIVOT_TIME = T0 + (WARMUP.length + 2) * STEP;
const BREAK_TIME = T0 + (WARMUP.length + 6) * STEP;
// The width at the break: the 100 ranges before it are 93 flat ones of 1 and this stretch's 2, 3, 8, 4, 5, 6, 10.
const WIDTH_AT_BREAK =
  ((93 + 2 + 3 + 8 + 4 + 5 + 6 + 10) / 100) * SETTINGS.widthMultiplier;

function feed(
  state: OrderBlocksState,
  settings: OrderBlockSettings,
  bars: readonly { h: number; l: number; c: number }[],
  startIndex = 0,
): void {
  bars.forEach((c, i) => {
    classicOrderBlocksIndicator.onBar(
      context(
        state,
        makeBar(T0 + (startIndex + i) * STEP, c.h, c.l, c.c),
        settings,
      ),
    );
  });
}

function drawnBoxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId])
    .filter((record) => record.kind === "box")
    .map((record) => record.data as BoxData)
    .filter((box) => box.time1 !== 0);
}

describe("classicOrderBlocksIndicator", () => {
  it("registers as a technical overlay with the trader's settings and no output lines", () => {
    expect(classicOrderBlocksIndicator).toMatchObject({
      kind: "runtime",
      id: "classicOrderBlocks",
      label: "Classic Order Blocks",
      category: "technical",
      placement: { kind: "overlay" },
      lines: [],
    });
    expect(classicOrderBlocksIndicator.settingsSchema?.length).toBeGreaterThan(
      0,
    );
    expect(
      classicOrderBlocksIndicator.readOutput(createState(SETTINGS, "shape")),
    ).toEqual({});
  });

  it("draws a bullish block from the swing bar to the current bar, on the lowest low, one average range tall, in the bullish colour", () => {
    const state = createState(SETTINGS, "bull");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    const boxes = drawnBoxes("bull");
    expect(boxes.map((box) => [box.time1, box.time2, box.price2])).toEqual([
      [PIVOT_TIME, BREAK_TIME, 9],
    ]);
    expect(boxes[0].price1).toBeCloseTo(9 + WIDTH_AT_BREAK, 10);
    expect(boxes[0].borderColor).toBe("transparent");
    expect(boxes[0].backgroundColor).toBe(
      withAlpha(SETTINGS.bullishColor, PRIMARY_FILL_ALPHA),
    );
    feed(state, SETTINGS, [{ h: 22, l: 15, c: 20 }], WARMUP.length + 7);
    expect(drawnBoxes("bull").map((box) => box.time2)).toEqual([
      BREAK_TIME + STEP,
    ]);
  });

  it("labels a block on a card that reads on the dark and the light chart alike", () => {
    // The label sits past the box on the chart's own background, which is #0c0c0c in the dark theme and #f4f6f9 in
    // the light one: bare near-black text vanished on the first, bare white on the second.
    const state = createState(SETTINGS, "card");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    const [box] = drawnBoxes("card");
    expect(box.text).toContain("Bull OB");
    expect(box.textAfterBox).toBe(true);
    expect([box.textBackground, box.textColor]).toEqual([CARD_FILL, CARD_TEXT]);
  });

  it("forms nothing until the zone width has a hundred bars behind it", () => {
    const state = createState(SETTINGS, "cold");
    feed(state, SETTINGS, BULL_BREAK);
    expect(state.tracker.activeBlocks).toEqual([]);
    expect(drawnBoxes("cold")).toEqual([]);
  });

  it("acts only on closed bars: a live candle through the swing is not a break until it closes above it", () => {
    const state = createState(SETTINGS, "closed");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK.slice(0, 6)]);
    const ts = T0 + (WARMUP.length + 6) * STEP;
    classicOrderBlocksIndicator.onBar(
      context(state, makeBar(ts, 22, 12, 21, false), SETTINGS),
    );
    expect(state.tracker.activeBlocks).toEqual([]);
    classicOrderBlocksIndicator.onBar(
      context(state, makeBar(ts, 22, 12, 15, true), SETTINGS, true),
    );
    expect(state.tracker.activeBlocks).toEqual([]);
    classicOrderBlocksIndicator.onBar(
      context(state, makeBar(ts + STEP, 23, 12, 21, true), SETTINGS),
    );
    expect(state.tracker.activeBlocks.map((block) => block.breakTime)).toEqual([
      ts + STEP,
    ]);
  });

  it("spends a block the first time a later candle trades into it, stops it there, and hides it unless mitigated blocks are shown", () => {
    const state = createState(SETTINGS, "mitigated");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    // The close below the bullish zone spends it, while the bearish block formed on this bar stays active.
    const mitigationTime = BREAK_TIME + STEP;
    feed(state, SETTINGS, [{ h: 21, l: 8, c: 8.5 }], WARMUP.length + 7);
    expect(
      [...state.tracker.mitigatedBlocks, ...state.tracker.activeBlocks].map((block) => [
        block.side,
        block.top,
        block.mitigatedTime,
      ]),
    ).toEqual([
      ["bullish", 9 + WIDTH_AT_BREAK, mitigationTime],
      ["bearish", 22, null],
    ]);
    expect(drawnBoxes("mitigated").map((box) => box.backgroundColor)).toEqual([
      withAlpha(SETTINGS.bearishColor, PRIMARY_FILL_ALPHA),
    ]);

    // The next candle closes at 22.5, through the bearish zones that hang from 22: spent too.
    const shown = { ...SETTINGS, showMitigated: true };
    feed(state, shown, [{ h: 23, l: 8, c: 22.5 }], WARMUP.length + 8);
    expect(
      state.tracker.mitigatedBlocks.map((block) => block.mitigatedTime),
    ).toEqual([
      mitigationTime,
      mitigationTime + STEP,
    ]);
    const boxes = drawnBoxes("mitigated");
    expect(boxes.map((box) => box.time2)).toEqual([
      mitigationTime,
      mitigationTime + STEP,
    ]);
    // A mitigated block reads as spent by its muted fill.
    expect(boxes[0].borderColor).toBe("transparent");
    expect(boxes[0].backgroundColor).toBe(
      withAlpha(SETTINGS.bullishColor, MITIGATED_FILL_ALPHA),
    );
    expect(boxes[1].borderColor).toBe("transparent");
    expect(MITIGATED_FILL_ALPHA).toBeLessThan(PRIMARY_FILL_ALPHA);
  });

  it("hides secondary blocks by default without duplicating an overlapping primary zone", () => {
    const hidden = { ...SETTINGS, showSecondary: false };
    expect(classicOrderBlocksIndicator.defaultSettings.showSecondary).toBe(
      false,
    );
    const state = createState(hidden, "secondary");
    feed(state, hidden, [...WARMUP, ...BULL_BREAK]);
    expect(state.tracker.activeBlocks.map((block) => block.tier)).toEqual([
      "primary",
    ]);
    expect(drawnBoxes("secondary")).toHaveLength(1);
    expect(isShown({ ...state.tracker.activeBlocks[0], tier: "secondary" }, hidden)).toBe(false);
  });

  it("never draws more than MAX_ORDER_BLOCKS boxes", () => {
    const state = createState(SETTINGS, "cap");
    expect(state.slots).toHaveLength(200);
  });

  it("leaves one generation of boxes behind when its state is rebuilt, which is what makes a settings replay safe here", () => {
    // Every setting on this indicator asks for a replay, and a replay builds a fresh state under the same draw
    // owner. withDrawOwnerScope clears that owner first, so the previous 200 boxes go rather than lingering in
    // the registry at their old positions, still drawn by the kernel primitive. This pins that guarantee,
    // because holding 200 reusable handles in createState depends on it.
    const first = createState(SETTINGS, "rebuild");
    feed(first, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    expect(drawnBoxes("rebuild")).toHaveLength(1);
    const second = withDrawOwnerScope("rebuild", () =>
      withStreamCreationWindow(() =>
        classicOrderBlocksIndicator.createState({
          ...SETTINGS,
          showMitigated: true,
        }),
      ),
    );
    expect(second.slots).toHaveLength(200);
  });

  it("replays a long, noisy history through the shared harness without faulting", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let price = 100;
    const bars = Array.from({ length: 600 }, (_, i) => {
      price += (next() - 0.5) * 4;
      const high = price + next() * 3;
      const low = price - next() * 3;
      return makeBar(T0 + i * STEP, high, low, low + next() * (high - low));
    });
    expect(() =>
      replayBars(
        classicOrderBlocksIndicator,
        bars,
        classicOrderBlocksIndicator.defaultSettings,
      ),
    ).not.toThrow();
  });
});

describe("withAlpha", () => {
  it("turns a hex colour into rgba at the given alpha and leaves anything else alone", () => {
    expect(withAlpha("#3b82f6", 0.15)).toBe("rgba(59, 130, 246, 0.15)");
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBe("rgb(1, 2, 3)");
  });
});
