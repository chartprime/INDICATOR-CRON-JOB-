import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import {
  RESTING_END_HOLD_MS,
  RESTING_END_SHARE,
  RESTING_MULTIPLE,
  RESTING_REPLAY_MS,
  RESTING_STAND_MS,
  RestingOrderTracker,
  createRestingState,
  restingFloor,
  restingShown,
  stepRestingOrders,
} from "../restingOrders";
import { MAX_RESTING_STAND_S } from "../liveOrderBookProfileSettings";

const T = 1_700_000_000_000;

function column(ts: number, lo: number, bid: number[], ask: number[]): LiquidityColumn {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

describe("stepRestingOrders", () => {
  it("tracks every row at or above the floor from the column it first holds it, on either side, and shows it once it has stood three seconds", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [2, 20, 0, 0], [0, 0, 1, 30]), 15, 0);
    expect([...state.orders.keys()]).toEqual(["bid:101", "ask:103"]);
    expect(restingShown(state, 3_000)).toEqual([]);
    stepRestingOrders(state, column(T + 1_000, 100, [16, 20, 0, 0], [0, 0, 1, 30]), 15, 0);
    stepRestingOrders(state, column(T + 2_000, 100, [16, 20, 0, 0], [0, 0, 1, 30]), 15, 0);
    expect(restingShown(state, 3_000)).toEqual([]);
    stepRestingOrders(state, column(T + 3_000, 100, [16, 22, 0, 0], [0, 0, 1, 30]), 15, 0);
    expect(restingShown(state, 3_000)).toEqual([
      { key: "bid:101", side: "bid", row: 101, size: 22, peak: 22, since: T, ending: false },
      { key: "ask:103", side: "ask", row: 103, size: 30, peak: 30, since: T, ending: false },
    ]);
    stepRestingOrders(state, column(T + 4_000, 100, [16, 22, 0, 0], [0, 0, 1, 30]), 15, 0);
    expect(restingShown(state, 3_000).map((order) => order.key)).toEqual(["bid:101", "ask:103", "bid:100"]);
    expect([RESTING_MULTIPLE, RESTING_STAND_MS]).toEqual([3, 30_000]);
  });

  it("counts a row exactly at the floor, not one just under it", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [15, 14.99], [0, 0]), 15, 0);
    expect([...state.orders.keys()]).toEqual(["bid:100"]);
  });

  it("keeps an order that dips under the floor but not under half its peak, and lets one go only after two seconds under half, pulled or eaten alike", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [20, 20], [0, 0]), 15, 0);
    stepRestingOrders(state, column(T + 1_000, 100, [12, 12], [0, 0]), 15, 0);
    expect(state.orders.size).toBe(2);
    stepRestingOrders(state, column(T + 2_000, 100, [9, 0], [0, 0]), 15, 0);
    stepRestingOrders(state, column(T + 3_000, 100, [12, 0], [0, 0]), 15, 0);
    expect(restingShown(state, 3_000).map((order) => [order.key, order.size, order.peak, order.ending])).toEqual([["bid:100", 12, 20, false], ["bid:101", 0, 20, true]]);
    stepRestingOrders(state, column(T + 3_999, 100, [9, 0], [0, 0]), 15, 0);
    expect(state.orders.size).toBe(2);
    stepRestingOrders(state, column(T + 4_000, 100, [9, 0], [0, 0]), 15, 0);
    expect([...state.orders.keys()]).toEqual(["bid:100"]);
    stepRestingOrders(state, column(T + 5_998, 100, [9, 0], [0, 0]), 15, 0);
    expect([...state.orders.keys()]).toEqual(["bid:100"]);
    stepRestingOrders(state, column(T + 5_999, 100, [9, 0], [0, 0]), 15, 0);
    expect(state.orders.size).toBe(0);
    expect([RESTING_END_SHARE, RESTING_END_HOLD_MS]).toEqual([0.5, 2_000]);
  });

  it("a row that comes back over half its peak in time is kept, with its wait forgotten", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [20], [0]), 15, 0);
    stepRestingOrders(state, column(T + 1_000, 100, [4], [0]), 15, 0);
    stepRestingOrders(state, column(T + 2_500, 100, [18], [0]), 15, 0);
    stepRestingOrders(state, column(T + 3_500, 100, [4], [0]), 15, 0);
    stepRestingOrders(state, column(T + 5_000, 100, [4], [0]), 15, 0);
    expect(state.orders.size).toBe(1);
    stepRestingOrders(state, column(T + 5_500, 100, [4], [0]), 15, 0);
    expect(state.orders.size).toBe(0);
  });

  it("lets an order go whose row left the book's window, tracks nothing without a yardstick, and starts over on a new epoch", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [20, 0, 0], [0, 0, 0]), 15, 0);
    stepRestingOrders(state, column(T + 1_000, 101, [0, 0, 0], [0, 0, 0]), 15, 0);
    stepRestingOrders(state, column(T + 3_000, 101, [0, 0, 0], [0, 0, 0]), 15, 0);
    expect(state.orders.size).toBe(0);
    stepRestingOrders(state, column(T + 4_000, 101, [50, 0, 0], [0, 0, 0]), 0, 0);
    expect(state.orders.size).toBe(0);
    stepRestingOrders(state, column(T + 5_000, 101, [50, 0, 0], [0, 0, 0]), 15, 0);
    expect(state.orders.size).toBe(1);
    stepRestingOrders(state, column(T + 6_000, 101, [50, 0, 0], [0, 30, 0]), 15, 1);
    expect([...state.orders.values()].map((order) => [order.key, order.since])).toEqual([["bid:101", T + 6_000], ["ask:102", T + 6_000]]);
  });

  it("keeps an order through a moment its row is past a live column's edge, and lets it go at once past a historical one's", () => {
    const live = createRestingState();
    stepRestingOrders(live, column(T, 100, [20, 0, 0], [0, 0, 0]), 15, 0);
    stepRestingOrders(live, column(T + 1_000, 101, [0, 0, 0], [0, 0, 0]), 15, 0);
    stepRestingOrders(live, column(T + 1_500, 100, [20, 0, 0], [0, 0, 0]), 15, 0);
    expect([...live.orders.values()].map((order) => [order.key, order.since, order.under])).toEqual([["bid:100", T, null]]);

    const historical = createRestingState();
    stepRestingOrders(historical, column(T, 100, [20, 0, 0], [0, 0, 0]), 15, 0, true);
    stepRestingOrders(historical, column(T + 1_000, 101, [0, 0, 0], [0, 0, 0]), 15, 0, true);
    expect(historical.orders.size).toBe(0);
  });
});

describe("restingFloor", () => {
  it("is the minimum size the trader set, or three times the book's typical row when none is set", () => {
    expect(RESTING_MULTIPLE).toBe(3);
    expect(restingFloor(0, 5)).toBe(15);
    expect(restingFloor(50, 5)).toBe(50);
    expect(restingFloor(0.5, 5)).toBe(0.5);
    expect(restingFloor(0, 0)).toBe(0);
    expect(restingFloor(-1, 5)).toBe(15);
  });
});

describe("restingShown", () => {
  it("waits half a minute by default, and the wait it is given otherwise, applied to what already rests without starting over", () => {
    const state = createRestingState();
    stepRestingOrders(state, column(T, 100, [20], [0]), 15, 0);
    stepRestingOrders(state, column(T + 29_000, 100, [20], [0]), 15, 0);
    expect(restingShown(state)).toEqual([]);
    expect(restingShown(state, 29_000)).toHaveLength(1);
    stepRestingOrders(state, column(T + 30_000, 100, [20], [0]), 15, 0);
    expect(restingShown(state)).toHaveLength(1);
    expect(restingShown(state, 30_001)).toEqual([]);
  });
});

describe("RestingOrderTracker", () => {
  const BTC_PERP = { provider: "BINANCE", marketKind: "PERPETUAL" } as const;

  function frame(ts: number, seq: number, reset: boolean, columns: LiquidityFrame["columns"]): LiquidityFrame {
    return { type: "liquidity", symbol: "BTC-USDT", ts, seq, reset, row_width: 4, column_ms: 1_000, columns, ...BTC_PERP };
  }
  const book = (ts: number, extra: [number, number][] = []) => ({ ts, lo: 100, hi: 109, bid: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], ...extra] as [number, number][], ask: [] as [number, number][] });

  it("the tracker reads the size the trader set in the book's own units, and starts over when it changes", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T, 1, true, [book(T, [[7, 9]])]));
    for (let i = 1; i <= 4; i += 1) grid.apply(frame(T + i * 1_000, i + 1, false, [book(T + i * 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 9, 3_000).map((order) => order.key)).toEqual(["bid:107"]);
    expect(tracker.update(grid, 9.5, 3_000)).toEqual([]);
    expect(tracker.update(grid, 9, 3_000).map((order) => [order.key, order.since])).toEqual([["bid:107", T]]);
  });

  it("replays the last two minutes of columns on its first look, so a wall already standing shows at once, then walks only the new columns at the grid's own yardstick", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T, 1, true, [book(T, [[7, 9]])]));
    for (let i = 1; i <= 4; i += 1) grid.apply(frame(T + i * 1_000, i + 1, false, [book(T + i * 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 0, 3_000).map((order) => [order.key, order.size, order.since])).toEqual([["bid:107", 9, T]]);
    expect(tracker.shown.map((order) => order.key)).toEqual(["bid:107"]);
    grid.apply(frame(T + 5_000, 6, false, [book(T + 5_000, [[7, 9], [8, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => order.key)).toEqual(["bid:107"]);
    grid.apply(frame(T + 8_000, 7, false, [book(T + 8_000, [[7, 9], [8, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => [order.key, order.since])).toEqual([["bid:107", T], ["bid:108", T + 5_000]]);
  });

  it("replays no further back than RESTING_REPLAY_MS, which covers the longest wait the settings allow", () => {
    expect(RESTING_REPLAY_MS).toBe(125_000);
    expect(RESTING_REPLAY_MS).toBeGreaterThanOrEqual(MAX_RESTING_STAND_S * 1_000);
    const grid = new LiquidityGrid();
    grid.apply(frame(T, 1, true, [book(T, [[7, 9]])]));
    grid.apply(frame(T + RESTING_REPLAY_MS, 2, false, [book(T + RESTING_REPLAY_MS, [[7, 9]])]));
    grid.apply(frame(T + RESTING_REPLAY_MS + 1_000, 3, false, [book(T + RESTING_REPLAY_MS + 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 0, 1_000).map((order) => order.since)).toEqual([T + RESTING_REPLAY_MS]);
  });

  it("takes the wait it is given on every look, the default half minute without one, and remembers it for the shown getter", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T, 1, true, [book(T, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    tracker.update(grid, 0);
    grid.apply(frame(T + 10_000, 2, false, [book(T + 10_000, [[7, 9]])]));
    expect(tracker.update(grid, 0)).toEqual([]);
    expect(tracker.update(grid, 0, 10_000)).toHaveLength(1);
    expect(tracker.shown).toHaveLength(1);
    expect(tracker.update(grid, 0, 10_001)).toEqual([]);
    expect(tracker.shown).toEqual([]);
    grid.apply(frame(T + 30_000, 3, false, [book(T + 30_000, [[7, 9]])]));
    expect(tracker.update(grid, 0)).toHaveLength(1);
  });

  it("replays under the new multiple when it changes, so what no longer qualifies goes at once and what does shows at once", () => {
    const grid = new LiquidityGrid();
    for (let i = 0; i < 4; i += 1) grid.apply(frame(T + i * 1_000, i + 1, i === 0, [book(T + i * 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 0, 3_000).map((order) => order.key)).toEqual(["bid:107"]);
    expect(tracker.update(grid, 12, 3_000)).toEqual([]);
    expect(tracker.update(grid, 2, 3_000).map((order) => [order.key, order.since])).toEqual([["bid:107", T]]);
  });

  it("replays over what the grid holds after a reset of the grid, and walks what it missed while it was not asked", () => {
    const grid = new LiquidityGrid();
    for (let i = 0; i < 5; i += 1) grid.apply(frame(T + i * 1_000, i + 1, i === 0, [book(T + i * 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 0, 3_000).map((order) => order.since)).toEqual([T]);
    for (let i = 5; i < 9; i += 1) grid.apply(frame(T + i * 1_000, i + 1, false, [book(T + i * 1_000, i === 6 ? [[7, 9], [8, 9]] : [[7, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => [order.key, order.since])).toEqual([["bid:107", T]]);
    grid.apply(frame(T + 9_000, 10, false, [book(T + 9_000, [[7, 9], [8, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => [order.key, order.since])).toEqual([["bid:107", T], ["bid:108", T + 6_000]]);
    grid.apply(frame(T + 500, 1, true, [book(T + 500, [[7, 9]])]));
    expect(tracker.update(grid, 0, 3_000)).toEqual([]);
    grid.apply(frame(T + 3_500, 2, false, [book(T + 3_500, [[7, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => order.since)).toEqual([T + 500]);
  });

  it("starts a new resting timeline when a reset arrives before its first column", () => {
    const grid = new LiquidityGrid();
    for (let i = 0; i < 5; i += 1) grid.apply(frame(T + i * 1_000, i + 1, i === 0, [book(T + i * 1_000, [[7, 9]])]));
    const tracker = new RestingOrderTracker();
    expect(tracker.update(grid, 0, 3_000)).toHaveLength(1);
    grid.apply(frame(T + 500, 0, true, []));
    expect(tracker.update(grid, 0, 3_000)).toEqual([]);
    grid.apply(frame(T + 1_500, 1, false, [book(T + 1_500, [[7, 9]])]));
    grid.apply(frame(T + 4_500, 2, false, [book(T + 4_500, [[7, 9]])]));
    expect(tracker.update(grid, 0, 3_000).map((order) => order.since)).toEqual([T + 1_500]);
  });
});
