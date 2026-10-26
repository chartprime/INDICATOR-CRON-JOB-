import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ORDER_BLOCKS,
  MAX_STORED_PIVOTS,
} from "../orderBlockRules";
import {
  advanceOrderBlocks,
  createOrderBlockTrackerState,
  type OrderBlockTrackerState,
  type PivotInputs,
} from "../orderBlockTracker";

const T0 = 1_000_000;
const STEP = 60_000;
const L = 2;
const NONE: PivotInputs = {
  primaryHigh: null,
  primaryLow: null,
  secondaryHigh: null,
  secondaryLow: null,
};

interface Step {
  h: number;
  l: number;
  c: number;
  pivots?: Partial<PivotInputs>;
  width?: number | null;
}

function feed(
  state: OrderBlockTrackerState,
  steps: readonly Step[],
  startIndex = 0,
): void {
  steps.forEach((step, i) => {
    advanceOrderBlocks(
      state,
      {
        time: T0 + (startIndex + i) * STEP,
        high: step.h,
        low: step.l,
        close: step.c,
        volume: 100,
      },
      { ...NONE, ...step.pivots },
      step.width === undefined ? 1 : step.width,
      L,
    );
  });
}

// A swing high of 20 on bar 2, confirmed two bars later on bar 4, closed above on bar 6: the block is 9 to 10.
const BULL_BREAK: Step[] = [
  { h: 12, l: 10, c: 11 },
  { h: 13, l: 10, c: 12 },
  { h: 20, l: 12, c: 19 },
  { h: 15, l: 11, c: 13 },
  { h: 14, l: 9, c: 12, pivots: { primaryHigh: 20 } },
  { h: 16, l: 10, c: 15 },
  { h: 22, l: 12, c: 21 },
];

describe("advanceOrderBlocks", () => {
  it("forms a bullish block on the first close above a confirmed swing high, sitting on the lowest low from the swing to the breakout, one width tall", () => {
    const state = createOrderBlockTrackerState();
    feed(state, BULL_BREAK);
    expect(state.activeBlocks).toEqual([
      {
        side: "bullish",
        tier: "primary",
        pivotTime: T0 + 2 * STEP,
        baseTime: T0 + 4 * STEP,
        breakTime: T0 + 6 * STEP,
        top: 10,
        bottom: 9,
        mitigatedTime: null,
        volume: 100,
      },
    ]);
    expect(state.trend).toBe("bullish");
  });

  it("reads the base from the swing bar itself when its own low is the lowest, and from the break bar when that is", () => {
    const fromSwing = createOrderBlockTrackerState();
    feed(
      fromSwing,
      BULL_BREAK.map((step, i) => (i === 2 ? { ...step, l: 8 } : step)),
    );
    expect(fromSwing.activeBlocks[0]).toMatchObject({ bottom: 8, top: 9, baseTime: T0 + 2 * STEP });
    const fromBreak = createOrderBlockTrackerState();
    feed(
      fromBreak,
      BULL_BREAK.map((step, i) => (i === 6 ? { ...step, l: 7 } : step)),
    );
    expect(fromBreak.activeBlocks[0]).toMatchObject({ bottom: 7, top: 8, baseTime: T0 + 6 * STEP });
  });

  it("consumes the swing: one pivot makes at most one block, and a later, higher close forms nothing", () => {
    const state = createOrderBlockTrackerState();
    feed(state, BULL_BREAK);
    expect(state.primaryHighs).toEqual([]);
    feed(state, [{ h: 30, l: 25, c: 29 }], BULL_BREAK.length);
    expect(state.activeBlocks).toHaveLength(1);
  });

  it("mirrors it for a bearish block: the first close below a confirmed swing low, hanging from the highest high since the swing", () => {
    const state = createOrderBlockTrackerState();
    feed(
      state,
      BULL_BREAK.map((step) => {
        const high = step.pivots?.primaryHigh;
        return {
          h: 30 - step.l,
          l: 30 - step.h,
          c: 30 - step.c,
          pivots:
            typeof high === "number" ? { primaryLow: 30 - high } : undefined,
        };
      }),
    );
    expect(state.activeBlocks).toEqual([
      {
        side: "bearish",
        tier: "primary",
        pivotTime: T0 + 2 * STEP,
        baseTime: T0 + 4 * STEP,
        breakTime: T0 + 6 * STEP,
        top: 21,
        bottom: 20,
        mitigatedTime: null,
        volume: 100,
      },
    ]);
    expect(state.trend).toBe("bearish");
  });

  it("only forms a secondary block in the direction the primary structure last broke", () => {
    const secondary: Step[] = BULL_BREAK.map((step) => ({
      ...step,
      pivots: step.pivots ? { secondaryHigh: 20 } : undefined,
    }));
    const noTrend = createOrderBlockTrackerState();
    feed(noTrend, secondary);
    expect(noTrend.activeBlocks).toEqual([]);
    expect(noTrend.secondaryHighs).toHaveLength(1);

    const bullish = createOrderBlockTrackerState();
    bullish.trend = "bullish";
    feed(bullish, secondary);
    expect(bullish.activeBlocks).toEqual([
      {
        side: "bullish",
        tier: "secondary",
        pivotTime: T0 + 2 * STEP,
        baseTime: T0 + 4 * STEP,
        breakTime: T0 + 6 * STEP,
        top: 10,
        bottom: 9,
        mitigatedTime: null,
        volume: 100,
      },
    ]);

    const bearish = createOrderBlockTrackerState();
    bearish.trend = "bearish";
    feed(bearish, secondary);
    expect(bearish.activeBlocks).toEqual([]);
  });

  it("does not keep overlapping blocks of different tiers: a primary and a secondary break on the same bar overlap so only the first one is kept", () => {
    const state = createOrderBlockTrackerState();
    feed(
      state,
      BULL_BREAK.map((step) => ({
        ...step,
        pivots: step.pivots
          ? { primaryHigh: 20, secondaryHigh: 20 }
          : undefined,
      })),
    );
    expect(
      state.activeBlocks.map((block) => [block.tier, block.top, block.bottom]),
    ).toEqual([["primary", 10, 9]]);
  });

  it("does not draw the same zone twice: two swing lows before one bounce, broken on different bars, are one block", () => {
    // The shape the trader circled on BTC 5m, 2026-09-16: a second, later swing whose window reads the same
    // bounce high as the first, so its zone would sit exactly on the block already standing.
    const state = createOrderBlockTrackerState();
    feed(state, [
      { h: 10, l: 8, c: 9 },
      { h: 10, l: 5, c: 7 },
      { h: 11, l: 8, c: 9 },
      { h: 11, l: 6, c: 7, pivots: { primaryLow: 5 } },
      { h: 20, l: 4, c: 4.5 },
      { h: 9, l: 5, c: 5.9, pivots: { primaryLow: 6 } },
    ]);
    expect(state.activeBlocks).toEqual([
      {
        side: "bearish",
        tier: "primary",
        pivotTime: T0 + STEP,
        baseTime: T0 + 4 * STEP,
        breakTime: T0 + 4 * STEP,
        top: 20,
        bottom: 19,
        mitigatedTime: null,
        volume: 100,
      },
    ]);
    expect(state.primaryLows).toEqual([]);
    // Once the standing block is spent, a block can form off that structure again: a candle closes through the
    // zone (20.1 is over its top of 20) while a new swing low of 4, anchored on the bounce bar itself, is
    // confirmed; the next close under 4 reads the new 20.2 high as its base, and nothing stands there.
    feed(
      state,
      [
        { h: 20.2, l: 4.5, c: 20.1, pivots: { primaryLow: 4 } },
        { h: 9, l: 3, c: 3.5 },
      ],
      6,
    );
    expect(state.activeBlocks).toEqual([
      {
        side: "bearish",
        tier: "primary",
        pivotTime: T0 + 4 * STEP,
        baseTime: T0 + 6 * STEP,
        breakTime: T0 + 7 * STEP,
        top: 20.2,
        bottom: 19.2,
        mitigatedTime: null,
        volume: 100,
      },
    ]);
    expect(state.mitigatedBlocks).toEqual([
      {
        side: "bearish",
        tier: "primary",
        pivotTime: T0 + STEP,
        baseTime: T0 + 4 * STEP,
        breakTime: T0 + 4 * STEP,
        top: 20,
        bottom: 19,
        mitigatedTime: T0 + 6 * STEP,
        volume: 100,
      },
    ]);
  });

  it("mitigates a block only when a later candle closes through it, past its far edge: not on a wick, not on a close inside, not on the edge, never on its own break bar", () => {
    // The block from BULL_BREAK is 9 to 10.
    const state = createOrderBlockTrackerState();
    feed(state, BULL_BREAK);
    feed(state, [{ h: 21, l: 10.5, c: 20 }], 7);
    expect(state.activeBlocks[0].mitigatedTime).toBeNull();
    // Wicks right through the zone and closes well above: the wall did not break.
    feed(state, [{ h: 21, l: 8.5, c: 20 }], 8);
    expect(state.activeBlocks[0].mitigatedTime).toBeNull();
    // Closes inside it: price is sitting on the orders, they are not gone.
    feed(state, [{ h: 21, l: 8.5, c: 9.5 }], 9);
    expect(state.activeBlocks[0].mitigatedTime).toBeNull();
    // A close on the far edge is not through it.
    feed(state, [{ h: 21, l: 8.5, c: 9 }], 10);
    expect(state.activeBlocks[0].mitigatedTime).toBeNull();
    feed(state, [{ h: 21, l: 8.5, c: 8.9 }], 11);
    expect(state.mitigatedBlocks[0].mitigatedTime).toBe(T0 + 11 * STEP);
    feed(state, [{ h: 21, l: 8, c: 8 }], 12);
    expect(state.mitigatedBlocks[0].mitigatedTime).toBe(T0 + 11 * STEP);
  });

  it("does not let the candle that made a block spend it: a base read from the break bar is inside the zone by definition", () => {
    const state = createOrderBlockTrackerState();
    feed(
      state,
      BULL_BREAK.map((step, i) => (i === 6 ? { ...step, l: 8 } : step)),
    );
    expect(state.activeBlocks[0]).toMatchObject({
      bottom: 8,
      top: 9,
      breakTime: T0 + 6 * STEP,
      mitigatedTime: null,
    });
    feed(state, [{ h: 22, l: 7.5, c: 7.9 }], 7);
    expect(state.mitigatedBlocks[0].mitigatedTime).toBe(T0 + 7 * STEP);
  });

  it("forms nothing while the zone width is unknown, and still consumes the swing", () => {
    const state = createOrderBlockTrackerState();
    feed(
      state,
      BULL_BREAK.map((step) => ({ ...step, width: null })),
    );
    expect(state.activeBlocks).toEqual([]);
    expect(state.primaryHighs).toEqual([]);
    expect(state.trend).toBe("bullish");
  });

  it("forms nothing from a swing older than the bars it still holds", () => {
    const state = createOrderBlockTrackerState({ maxBars: 4 });
    feed(state, BULL_BREAK);
    expect(state.bars).toHaveLength(4);
    expect(state.activeBlocks).toEqual([]);
    expect(state.primaryHighs).toEqual([]);
  });

  it("ignores a bar it has already seen, so a closed bar delivered twice forms one block, not two", () => {
    const state = createOrderBlockTrackerState();
    feed(state, BULL_BREAK);
    feed(state, [BULL_BREAK[6]], 6);
    expect(state.activeBlocks).toHaveLength(1);
    expect(state.bars).toHaveLength(7);
  });

  it("keeps the newest MAX_ORDER_BLOCKS blocks", () => {
    const state = createOrderBlockTrackerState();
    const steps: Step[] = [];
    for (let i = 0; i < 3 * DEFAULT_MAX_ORDER_BLOCKS; i += 1) {
      steps.push({
        h: 10 + i,
        l: 9 + i,
        c: 10.5 + i,
        pivots: { primaryHigh: 9 + i },
      });
    }
    feed(state, steps);
    expect(state.activeBlocks).toHaveLength(DEFAULT_MAX_ORDER_BLOCKS);
    expect(state.activeBlocks[DEFAULT_MAX_ORDER_BLOCKS - 1].breakTime).toBe(
      T0 + (3 * DEFAULT_MAX_ORDER_BLOCKS - 1) * STEP,
    );
  });
});

// A falling market: each confirmed swing high is lower than the one before it and none is reclaimed
// until the rally at the end. This is the shape the trader asked about, where every bullish level is a
// full pivot-window of decline above price and the reference's single slot has already discarded the
// older, higher ones.
const DOWNTREND: Step[] = [
  { h: 40, l: 38, c: 39 },
  { h: 39, l: 37, c: 38 },
  { h: 38, l: 34, c: 35, pivots: { primaryHigh: 40 } },
  { h: 36, l: 32, c: 33 },
  { h: 34, l: 30, c: 31, pivots: { primaryHigh: 38 } },
  { h: 32, l: 28, c: 29 },
  { h: 30, l: 26, c: 27, pivots: { primaryHigh: 34 } },
];

describe("keeping older structure breakable", () => {
  it("is the default, and the reference's single-slot behaviour is one toggle away", () => {
    expect(createOrderBlockTrackerState().keepStack).toBe(true);
    expect(createOrderBlockTrackerState({ keepStack: false }).keepStack).toBe(
      false,
    );
  });

  it("holds every unbroken swing while the market falls, where the reference keeps only the newest", () => {
    const stacked = createOrderBlockTrackerState();
    feed(stacked, DOWNTREND);
    expect(stacked.primaryHighs.map((ref) => ref.price)).toEqual([40, 38, 34]);

    const reference = createOrderBlockTrackerState({ keepStack: false });
    feed(reference, DOWNTREND);
    expect(reference.primaryHighs.map((ref) => ref.price)).toEqual([34]);
  });

  it("lets a rally take out a high set some time ago, where the reference anchors on its one remaining level", () => {
    const stacked = createOrderBlockTrackerState();
    feed(stacked, DOWNTREND);
    feed(stacked, [{ h: 42, l: 27, c: 41 }], DOWNTREND.length);
    // One move, one block, anchored at the oldest structure it broke, so its base spans the whole decline.
    expect(stacked.activeBlocks).toEqual([
      {
        side: "bullish",
        tier: "primary",
        pivotTime: T0,
        baseTime: T0 + 6 * STEP,
        breakTime: T0 + 7 * STEP,
        top: 27,
        bottom: 26,
        mitigatedTime: null,
        volume: 100,
      },
    ]);
    expect(stacked.primaryHighs).toEqual([]);

    const reference = createOrderBlockTrackerState({ keepStack: false });
    feed(reference, DOWNTREND);
    feed(reference, [{ h: 42, l: 27, c: 41 }], DOWNTREND.length);
    expect(reference.activeBlocks.map((block) => block.pivotTime)).toEqual([
      T0 + 4 * STEP,
    ]);
  });

  it("breaks only the levels the close actually passed, and leaves the rest standing", () => {
    const state = createOrderBlockTrackerState();
    feed(state, DOWNTREND);
    // A close of 36 clears the 34 level only: the 40 and 38 highs above it stay breakable.
    feed(state, [{ h: 37, l: 27, c: 36 }], DOWNTREND.length);
    expect(state.primaryHighs.map((ref) => ref.price)).toEqual([40, 38]);
    expect(state.activeBlocks.map((block) => block.pivotTime)).toEqual([
      T0 + 4 * STEP,
    ]);
  });

  it("bounds the stack, dropping the oldest swing once MAX_STORED_PIVOTS are held", () => {
    const state = createOrderBlockTrackerState();
    const steps: Step[] = [];
    for (let i = 0; i < MAX_STORED_PIVOTS + 10; i += 1) {
      steps.push({
        h: 1_000 - i,
        l: 900 - i,
        c: 950 - i,
        pivots: { primaryHigh: 1_000 - i },
      });
    }
    feed(state, steps);
    expect(state.primaryHighs).toHaveLength(MAX_STORED_PIVOTS);
    expect(state.primaryHighs[0].price).toBe(1_000 - 10);
  });
});
