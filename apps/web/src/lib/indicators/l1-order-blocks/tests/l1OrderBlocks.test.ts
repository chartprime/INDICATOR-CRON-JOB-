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
import {
  activityEndTime,
  l1OrderBlocksIndicator,
  type L1OrderBlocksState,
} from "../l1OrderBlocks";
import {
  DEFAULT_L1_ORDER_BLOCK_SETTINGS,
  ZONE_WIDTH_LENGTH,
  type L1OrderBlockSettings,
} from "../l1OrderBlockRules";

const T0 = 1_000_000;
const STEP = 60_000;
const SETTINGS: L1OrderBlockSettings = {
  ...DEFAULT_L1_ORDER_BLOCK_SETTINGS,
  pivotLength: 2,
};

function makeBar(
  ts_open: number,
  high: number,
  low: number,
  close: number,
  closed = true,
  buy_volume = 70, // Default to higher buy volume so delta is positive for tests
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
    buy_volume,
    trade_count: 10,
    closed,
  };
}

function context(
  state: L1OrderBlocksState,
  bar: BarFrame,
  settings: L1OrderBlockSettings,
  replace = false,
): IndicatorBarCtx<L1OrderBlocksState, L1OrderBlockSettings> {
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
  settings: L1OrderBlockSettings,
  ownerId: string,
): L1OrderBlocksState {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(ownerId, () =>
    withStreamCreationWindow(() =>
      l1OrderBlocksIndicator.createState(settings),
    ),
  );
}

describe("l1OrderBlocksIndicator", () => {
  it("uses observed candle positions for activity width across a market closure", () => {
    const friday = T0;
    const monday = friday + 3 * 24 * 60 * STEP;
    expect(activityEndTime([friday, monday, monday + STEP], friday, monday + 2 * STEP, 0.5)).toBe(monday + STEP);
    expect(activityEndTime([friday, monday, monday + STEP], friday, monday + 2 * STEP, 1)).toBe(monday + 2 * STEP);
    expect(activityEndTime([monday], friday, monday + STEP, 0.5)).toBe(friday);
  });

  it("never offers more visible blocks than the allocated draw slots", () => {
    const settings = { ...SETTINGS, maxBlocks: 100, showMitigated: true };
    const state = createState(settings, "slot-cap");
    const block = (id: string, mitigatedTime: number | null) => ({
      id,
      side: "bullish" as const,
      pivotPrice: 10,
      pivotTime: T0,
      breakTime: T0,
      top: 12,
      bottom: 10,
      mitigatedTime,
    });
    state.activeBlocks = Array.from({ length: 101 }, (_, i) => block(`active-${i}`, null));
    state.mitigatedBlocks = Array.from({ length: 3 }, (_, i) => block(`old-${i}`, T0));
    l1OrderBlocksIndicator.onBar(context(state, makeBar(T0 + STEP, 20, 19, 20), settings));
    expect(state.activeBlocks).toHaveLength(100);
    expect(state.activeBlocks[0].id).toBe("active-1");
    expect(state.lastActiveCount).toBe(100);
  });

  it("drops a broken pivot whose origin aged out instead of inventing a new base", () => {
    const state = createState(SETTINGS, "aged-pivot");
    state.primaryHighs.push({ price: 10, time: T0 - STEP });
    state.primaryLows.push({ price: 30, time: T0 - STEP });
    l1OrderBlocksIndicator.onBar(context(state, makeBar(T0, 21, 19, 20), SETTINGS));
    expect(state.activeBlocks).toEqual([]);
    expect(state.primaryHighs).toEqual([]);
    expect(state.primaryLows).toEqual([]);
    l1OrderBlocksIndicator.onBar(context(state, makeBar(T0 + STEP, 11, 9, 10), SETTINGS));
    expect(state.activeBlocks).toEqual([]);
    expect(state.primaryHighs).toEqual([]);
    expect(state.primaryLows).toEqual([]);
  });

  it("passes the bar's actual sided flow into its retained evidence", () => {
    const state = createState(SETTINGS, "zero-buy");
    const bar = { ...makeBar(T0, 11, 10, 10.5, true, 0), sell_volume: 100 };
    l1OrderBlocksIndicator.onBar(context(state, bar, SETTINGS));
    expect(state.bars[0]).toMatchObject({ buy_volume: 0, sell_volume: 100 });
  });

  it("does not infer the unrecorded dxFeed or Databento sell side from total volume", () => {
    const state = createState(SETTINGS, "unknown-dxfeed-sell");
    const { marketKind: _marketKind, ...base } = makeBar(T0, 11, 10, 10.5);
    const bar: BarFrame = { ...base, provider: "DXFEED", assetClass: "EQUITY", symbol: "AAPL", buy_volume: 30 };
    l1OrderBlocksIndicator.onBar(context(state, bar, SETTINGS));
    expect(state.bars[0]).toMatchObject({ buy_volume: 30, sell_volume: null });
    const archive: BarFrame = { ...bar, provider: "DATABENTO", ts_open: T0 + STEP };
    l1OrderBlocksIndicator.onBar(context(state, archive, SETTINGS));
    expect(state.bars[1]).toMatchObject({ buy_volume: 30, sell_volume: null });
  });

  it("creates boxes and renders buy/sell volume split boxes correctly", () => {
    const ownerId = "test-l1-obs";
    const state = createState(SETTINGS, ownerId);

    const warmup = Array.from({ length: ZONE_WIDTH_LENGTH }, (_, i) =>
      makeBar(T0 + i * STEP, 11, 10, 10.5, true, 50),
    );
    for (const b of warmup) {
      l1OrderBlocksIndicator.onBar(context(state, b, SETTINGS));
    }

    const bullStretch = [
      makeBar(T0 + 100 * STEP, 12, 10, 11, true, 70),
      makeBar(T0 + 101 * STEP, 13, 10, 12, true, 65),
      makeBar(T0 + 102 * STEP, 20, 12, 19, true, 80),
      makeBar(T0 + 103 * STEP, 15, 11, 13, true, 75),
      makeBar(T0 + 104 * STEP, 14, 9, 12, true, 60),
      makeBar(T0 + 105 * STEP, 16, 10, 15, true, 85),
      makeBar(T0 + 106 * STEP, 22, 12, 21, true, 90),
    ];
    for (const b of bullStretch) {
      l1OrderBlocksIndicator.onBar(context(state, b, SETTINGS));
    }

    expect(state.activeBlocks.length).toBeGreaterThan(0);
    const boxes = handlesForOwners([ownerId])
      .filter((record) => record.kind === "box")
      .map((record) => record.data as BoxData);
    expect(boxes.length).toBeGreaterThan(0);

    // Verify that buyBoxes and sellBoxes have non-zero height/coordinates when active blocks exist
    const nonZeroBuyBoxes = boxes
      .slice(state.boxes.length, state.boxes.length + state.buyBoxes.length)
      .filter((box) => box.price1 !== box.price2 && box.backgroundColor !== "transparent");
    expect(nonZeroBuyBoxes.length).toBeGreaterThan(0);
  });

  it("draws every box at candles the chart has, so an active block shows after the last bar of a history or a session", () => {
    // The chart places a time only when a bar opened at it (lightweight-charts timeToCoordinate is an exact match, else
    // null, and the draw kernel skips a box with a null edge). Historical Mode and a closed market end on a closed bar
    // with nothing after it, so an edge at the next bar's open left every active block undrawn.
    const ownerId = "chart-times";
    const state = createState(SETTINGS, ownerId);
    const bars = [
      ...Array.from({ length: ZONE_WIDTH_LENGTH }, (_, i) => makeBar(T0 + i * STEP, 11, 10, 10.5, true, 50)),
      makeBar(T0 + 100 * STEP, 12, 10, 11, true, 70),
      makeBar(T0 + 101 * STEP, 13, 10, 12, true, 65),
      makeBar(T0 + 102 * STEP, 20, 12, 19, true, 80),
      makeBar(T0 + 103 * STEP, 15, 11, 13, true, 75),
      makeBar(T0 + 104 * STEP, 14, 9, 12, true, 60),
      makeBar(T0 + 105 * STEP, 16, 10, 15, true, 85),
      makeBar(T0 + 106 * STEP, 22, 12, 21, true, 90),
    ];
    for (const bar of bars) l1OrderBlocksIndicator.onBar(context(state, bar, SETTINGS));
    expect(state.activeBlocks.length).toBeGreaterThan(0);
    const chartTimes = new Set(bars.map((bar) => bar.ts_open));
    const drawn = handlesForOwners([ownerId])
      .filter((record) => record.kind === "box")
      .map((record) => record.data as BoxData)
      .filter((box) => box.time1 !== 0 && box.backgroundColor !== "transparent");
    expect(drawn.length).toBeGreaterThan(0);
    for (const box of drawn) {
      expect(chartTimes.has(box.time1)).toBe(true);
      expect(chartTimes.has(box.time2)).toBe(true);
    }
  });
});
