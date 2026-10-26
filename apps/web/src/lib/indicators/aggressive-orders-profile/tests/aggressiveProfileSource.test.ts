import { describe, expect, it } from "vitest";
import type { LiquidityFrame, LiquidityPrint } from "../../../../types/frames";
import { LiquidityGrid, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { AggressiveProfileSource, READ_SETTLE_MS, printTiersOf, type VisibleRange } from "../aggressiveProfileSource";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, readerSettingsOf } from "../aggressiveProfileSettings";
import { RANGE_ASK_DELAY_MS, RangePrintStore, type CandleSlot } from "../rangePrintStore";

const T = 1_700_000_000_000;

function column(ts: number): LiquidityColumn {
  return { ts, lo: 100, hi: 100, bid: Float64Array.from([1]), ask: Float64Array.from([1]) };
}

function print(ts: number, side: "buy" | "sell", size: number, price = 200): LiquidityPrint {
  return { ts, price, size, side, id: null };
}

function frame(ts: number, seq: number, reset: boolean, prints: LiquidityPrint[] = [], printsFloor = 1): LiquidityFrame {
  return {
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts, seq, reset, row_width: 2, column_ms: 1_000,
    columns: [{ ts, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]], prints, prints_floor: printsFloor }],
  };
}

function slots(from: number, intervalMs: number, count: number): CandleSlot[] {
  return Array.from({ length: count }, (_, i) => ({ ts_open: from + i * intervalMs, interval_ms: intervalMs }));
}

const range: VisibleRange = { fromTs: T, toTs: T + 10_000, open: true };
const settings = readerSettingsOf(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
const second = slots(T, 1_000, 10);
const candlesOf = (candles: readonly { tsOpen: number; buyVolume: number; sellVolume: number }[]) => candles.map((candle) => [candle.tsOpen, candle.buyVolume, candle.sellVolume]);

describe("printTiersOf", () => {
  it("lets the fine columns answer from their first window on and the deep columns for everything before it", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 5_000, 1, true));
    const deep = [column(T - 10_000), column(T), column(T + 10_000)];
    const tiers = printTiersOf({ columns: grid.columns, columnMs: 1_000, deepColumns: deep, deepColumnMs: 10_000 });
    expect(tiers.map((tier) => [tier.columnMs, tier.columns.map((entry) => entry.ts), tier.fromTs, tier.toTs])).toEqual([
      [10_000, [T - 10_000, T, T + 10_000], -Infinity, T + 4_000],
      [1_000, [T + 5_000], T + 4_000, Infinity],
    ]);
    expect(printTiersOf({ columns: [], columnMs: 1_000, deepColumns: deep, deepColumnMs: 10_000 }).map((tier) => [tier.columns.length, tier.fromTs, tier.toTs])).toEqual([
      [3, -Infinity, Infinity],
      [0, Infinity, Infinity],
    ]);
  });
});

describe("AggressiveProfileSource", () => {
  function setup() {
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 1_000, 1, true, [print(T + 900, "buy", 5), print(T + 1_950, "sell", 3)]));
    const source = new AggressiveProfileSource(grid);
    return { grid, source };
  }

  it("reads the range's big prints by candle from the grid's own columns, for the candles it is given, and keeps the read until the inputs change", () => {
    const { source } = setup();
    expect(source.version).toBe(0);
    expect(source.candles).toEqual([]);
    const first = source.read(range, settings, second, T + 5_000);
    expect(candlesOf(first)).toEqual([[T, 5, 0], [T + 1_000, 0, 3]]);
    expect(first[0]).toMatchObject({ tsOpen: T, delta: 5, buyCount: 1, sellCount: 0 });
    expect(source.version).toBe(1);
    expect(source.candles).toBe(first);
    expect(source.prints).toBeNull();
    expect(source.read(range, settings, second, T + 6_000)).toBe(first);
    expect(source.version).toBe(1);
  });

  it("waits for the inputs to stand still for READ_SETTLE_MS before reading again, says when to come back, and a colour never counts as a change", () => {
    const { source, grid } = setup();
    const first = source.read(range, settings, second, T + 5_000);
    expect(source.settleAt).toBeNull();
    grid.apply(frame(T + 2_000, 2, false, [print(T + 1_900, "sell", 7)]));
    expect(source.read(range, settings, second, T + 5_100)).toBe(first);
    expect(source.settleAt).toBe(T + 5_100 + READ_SETTLE_MS);
    expect(source.read(range, settings, second, T + 5_200)).toBe(first);
    expect(source.settleAt).toBe(T + 5_100 + READ_SETTLE_MS);
    const next = source.read(range, readerSettingsOf({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, buyColor: "#ff0000" }), second, T + 5_100 + READ_SETTLE_MS);
    expect(next).not.toBe(first);
    expect(candlesOf(next)).toEqual([[T, 5, 0], [T + 1_000, 0, 10]]);
    expect(source.version).toBe(2);
    expect(source.settleAt).toBeNull();
    expect(source.read({ ...range, toTs: T + 11_000 }, settings, second, T + 7_000)).toBe(next);
    expect(source.settleAt).toBe(T + 7_000 + READ_SETTLE_MS);
    expect(source.read(range, settings, second, T + 7_100)).toBe(next);
    expect(source.settleAt).toBeNull();
  });

  it("the very first read happens at once, so a fresh chart never waits; a change right after it keeps the first read until it settles", () => {
    const { source } = setup();
    const first = source.read(range, settings, second, T + 5_000);
    expect(source.read({ ...range, fromTs: T + 1 }, settings, second, T + 5_050)).toBe(first);
    expect(source.version).toBe(1);
    expect(source.read({ ...range, fromTs: T + 1 }, settings, second, T + 5_050 + READ_SETTLE_MS)).not.toBe(first);
    expect(source.version).toBe(2);
  });

  it("reads again when the candles change, by their count, their first or last open or their length, and at a floor set by hand", () => {
    const { source } = setup();
    const first = source.read(range, settings, second, T + 5_000);
    const wide = slots(T, 2_000, 5);
    expect(source.read(range, settings, wide, T + 5_001)).toBe(first);
    expect(candlesOf(source.read(range, settings, wide, T + 5_001 + READ_SETTLE_MS))).toEqual([[T, 5, 3]]);
    expect(source.version).toBe(2);
    const holed = [wide[0], wide[2], wide[3], wide[4]];
    source.read(range, settings, holed, T + 6_000);
    expect(source.version).toBe(2);
    expect(candlesOf(source.read(range, settings, holed, T + 6_000 + READ_SETTLE_MS))).toEqual([[T, 5, 3]]);
    expect(source.version).toBe(3);
    const later = [{ ts_open: T + 1_000, interval_ms: 2_000 }, wide[2], wide[3], wide[4]];
    source.read(range, settings, later, T + 7_000);
    expect(candlesOf(source.read(range, settings, later, T + 7_000 + READ_SETTLE_MS))).toEqual([[T + 1_000, 0, 3]]);
    expect(source.version).toBe(4);
    const longer = [{ ts_open: T + 1_000, interval_ms: 2_000 }, wide[2], wide[3], { ts_open: T + 9_000, interval_ms: 2_000 }];
    source.read(range, settings, longer, T + 8_000);
    expect(candlesOf(source.read(range, settings, longer, T + 8_000 + READ_SETTLE_MS))).toEqual([[T + 1_000, 0, 3]]);
    expect(source.version).toBe(5);
    const shorter = [{ ts_open: T + 1_000, interval_ms: 500 }, wide[2], wide[3], { ts_open: T + 9_000, interval_ms: 500 }];
    source.read(range, settings, shorter, T + 9_000);
    expect(candlesOf(source.read(range, settings, shorter, T + 9_000 + READ_SETTLE_MS))).toEqual([]);
    expect(source.version).toBe(6);
    source.read(range, settings, wide, T + 9_500);
    expect(candlesOf(source.read(range, settings, wide, T + 9_500 + READ_SETTLE_MS))).toEqual([[T, 5, 3]]);
    expect(source.version).toBe(7);
    source.read(range, { floor: 4 }, wide, T + 10_000);
    expect(candlesOf(source.read(range, { floor: 4 }, wide, T + 10_000 + READ_SETTLE_MS))).toEqual([[T, 5, 0]]);
    expect(source.version).toBe(8);
  });

  it("with a print store, counts the big prints from it by candle at the floor it resolves, the heatmap's nice median while the store has none and the store's own once it has one, never under it, fills the store's gaps from the columns, and reads again when the store records more", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 1_000, 1, true, [print(T + 900, "buy", 5)]));
    const store = new RangePrintStore();
    const source = new AggressiveProfileSource(grid, () => store);
    expect(source.prints).toBe(store);
    expect(candlesOf(source.read(range, settings, second, T + 5_000))).toEqual([[T, 5, 0]]);
    store.markSeen(T - 1);
    store.setWant({ from: range.fromTs, to: range.toTs, floor: 2 }, T);
    store.addTrade({ ts_exchange: T + 2_000, price: 199, size: 3, side: "sell" });
    source.read(range, settings, second, T + 5_001);
    expect(candlesOf(source.read(range, settings, second, T + 5_001 + READ_SETTLE_MS))).toEqual([[T + 2_000, 0, 3]]);
    const fixed = { floor: 4 };
    source.read(range, fixed, second, T + 6_000);
    expect(candlesOf(source.read(range, fixed, second, T + 6_000 + READ_SETTLE_MS))).toEqual([]);
    const lower = { floor: 0.5 };
    source.read(range, lower, second, T + 6_500);
    expect(candlesOf(source.read(range, lower, second, T + 6_500 + READ_SETTLE_MS))).toEqual([[T + 2_000, 0, 3]]);
    grid.apply({ ...frame(T + 2_000, 2, false), columns: [{ ts: T + 2_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 20 }] });
    source.read(range, settings, second, T + 7_000);
    expect(candlesOf(source.read(range, settings, second, T + 7_000 + READ_SETTLE_MS))).toEqual([[T + 2_000, 0, 3]]);
    const bare = new LiquidityGrid();
    bare.apply({ ...frame(T + 1_000, 1, true), columns: [{ ts: T + 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [print(T + 900, "buy", 2, 300)] }] });
    const unfloored = new AggressiveProfileSource(bare, () => new RangePrintStore());
    expect(candlesOf(unfloored.read(range, settings, second, T + 5_000))).toEqual([[T, 2, 0]]);
    bare.apply({ ...frame(T + 2_000, 2, false), columns: [{ ts: T + 2_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 20 }] });
    unfloored.read(range, settings, second, T + 6_000);
    expect(candlesOf(unfloored.read(range, settings, second, T + 6_000 + READ_SETTLE_MS))).toEqual([]);
  });

  it("reads nothing again for a new heatmap column while the store holds the whole range, and does while the store leaves a gap the columns fill", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 1_000, 1, true, [print(T + 900, "buy", 5)]));
    const store = new RangePrintStore();
    const source = new AggressiveProfileSource(grid, () => store);
    store.markSeen(T + 20_000);
    store.setWant({ from: range.fromTs, to: range.toTs, floor: 2 }, T);
    const before = source.read(range, settings, second, T + RANGE_ASK_DELAY_MS);
    expect(candlesOf(before)).toEqual([[T, 5, 0]]);
    grid.apply(frame(T + 2_000, 2, false, [print(T + 1_900, "sell", 7)]));
    expect(source.read(range, settings, second, T + 5_100)).toBe(before);
    const filled = source.read(range, settings, second, T + 5_100 + READ_SETTLE_MS);
    expect(filled).not.toBe(before);
    expect(candlesOf(filled)).toEqual([[T, 5, 0], [T + 1_000, 0, 7]]);
    const ask = store.nextRequest(T + RANGE_ASK_DELAY_MS)!;
    const reply = { request_id: ask.request_id, from_ts: T, to_ts: T + 10_000, min_size: 2, reason: null, next_cursor: null, retry_after_ms: null };
    store.put(reply, [{ ts_exchange: T + 900, price: 200, size: 5, side: "buy" }, { ts_exchange: T + 1_900, price: 200, size: 7, side: "sell" }], T + 5_500);
    source.read(range, settings, second, T + 5_600);
    const held = source.read(range, settings, second, T + 5_600 + READ_SETTLE_MS);
    expect(held).not.toBe(filled);
    expect(candlesOf(held)).toEqual([[T, 5, 0], [T + 1_000, 0, 7]]);
    const reads = source.version;
    grid.apply(frame(T + 3_000, 3, false, [print(T + 2_900, "buy", 9)]));
    expect(source.read(range, settings, second, T + 9_000)).toBe(held);
    expect(source.settleAt).toBeNull();
    source.read(range, settings, second, T + 9_000 + READ_SETTLE_MS);
    expect(source.version).toBe(reads);
  });

  it("reads again when the store lays in a recorded page while the grid, the range, the floor, the candles and the gap the columns fill stand still", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 1_000, 1, true, [print(T + 900, "buy", 5)]));
    const store = new RangePrintStore();
    const source = new AggressiveProfileSource(grid, () => store);
    store.markSeen(T + 20_000);
    store.setWant({ from: range.fromTs, to: range.fromTs + 5_000, floor: 2 }, T);
    const before = source.read(range, settings, second, T + RANGE_ASK_DELAY_MS);
    expect(candlesOf(before)).toEqual([[T, 5, 0]]);
    const ask = store.nextRequest(T + RANGE_ASK_DELAY_MS);
    expect(ask).toMatchObject({ from_ts: T, to_ts: T + 5_000, min_size: 2 });
    const reply = { request_id: ask!.request_id, from_ts: T, to_ts: T + 5_000, min_size: 2, reason: null, next_cursor: null, retry_after_ms: null };
    expect(store.put(reply, [{ ts_exchange: T + 900, price: 200, size: 5, side: "buy" }, { ts_exchange: T + 3_000, price: 199, size: 4, side: "sell" }], T + 5_100)).toBe(true);
    expect(store.coverage(range.fromTs, range.toTs, 2, T + 5_200)?.gaps).toEqual([{ from: T + 5_000, to: T + 10_000 }]);
    expect(source.read(range, settings, second, T + 5_200)).toBe(before);
    expect(candlesOf(source.read(range, settings, second, T + 5_200 + READ_SETTLE_MS))).toEqual([[T, 5, 0], [T + 3_000, 0, 4]]);
  });
});
