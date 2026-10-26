import { describe, expect, it } from "vitest";
import { PRINT_WINDOW_COLUMNS, type LiquidityPrint } from "../../../../types/frames";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { MAX_PRINT_COLUMNS, autoPrintFloorOf, candlesOf, niceFloor, printFloorFor, readAggressiveProfile, readColumnCandles, startingPrintFloorFor, type PrintTier } from "../aggressiveProfileReader";
import type { CandleSlot, RangePrintTally } from "../rangePrintStore";

const T = 1_700_000_000_000;

function column(ts: number, prints: LiquidityPrint[] | undefined, printsFloor: number | null = 1): LiquidityColumn {
  return { ts, lo: 100, hi: 100, bid: Float64Array.from([0]), ask: Float64Array.from([0]), ...(prints === undefined ? {} : { prints }), ...(printsFloor === null ? {} : { printsFloor }) };
}

function tier(columns: LiquidityColumn[], columnMs: number, fromTs = -Infinity, toTs = Infinity): PrintTier {
  return { columns, columnMs, fromTs, toTs };
}

function print(ts: number, side: "buy" | "sell", size: number, price = 100, id: string | null = null): LiquidityPrint {
  return { ts, price, size, side, id };
}

function tally(buyCount: number, buyVolume: number, sellCount: number, sellVolume: number): RangePrintTally {
  return { buyCount, buyVolume, sellCount, sellVolume };
}

function slots(from: number, intervalMs: number, count: number): CandleSlot[] {
  return Array.from({ length: count }, (_, i) => ({ ts_open: from + i * intervalMs, interval_ms: intervalMs }));
}

function candlesIn(tiers: PrintTier[], fromTs: number, toTs: number, floor: number, candles: CandleSlot[]): [number, RangePrintTally][] {
  const into = new Map<number, RangePrintTally>();
  readColumnCandles(tiers, fromTs, toTs, floor, candles, into);
  return [...into.entries()].sort((a, b) => a[0] - b[0]);
}

describe("readColumnCandles", () => {
  it("puts every column print at or above the floor in the candle its own time falls in, by side, with the count and the size", () => {
    const columns = [
      column(T + 1_000, [print(T + 500, "buy", 12), print(T + 600, "sell", 5), print(T + 700, "buy", 3)]),
      column(T + 2_000, [print(T + 1_500, "sell", 20)]),
    ];
    expect(candlesIn([tier(columns, 1_000)], T, T + 3_000, 5, slots(T, 1_000, 3))).toEqual([[T, tally(1, 12, 1, 5)], [T + 1_000, tally(0, 0, 1, 20)]]);
    expect(candlesIn([tier(columns, 1_000)], T, T + 3_000, 5, slots(T, 2_000, 2))).toEqual([[T, tally(1, 12, 2, 25)]]);
  });

  it("at floor 0 counts each column at its own floor", () => {
    const columns = [column(T + 1_000, [print(T + 500, "buy", 4)], 3), column(T + 2_000, [print(T + 1_500, "buy", 5), print(T + 1_600, "buy", 7)], 6)];
    expect(candlesIn([tier(columns, 1_000)], T, T + 3_000, 0, slots(T, 1_000, 3))).toEqual([[T, tally(1, 4, 0, 0)], [T + 1_000, tally(1, 7, 0, 0)]]);
  });

  it("counts a print by its own time: a column up to two windows past the range still gives the prints inside it, one a window before it too, and a print outside the range counts nothing", () => {
    expect(PRINT_WINDOW_COLUMNS).toBe(2);
    const columns = [
      column(T - 1_001, [print(T, "buy", 1)]),
      column(T - 1_000, [print(T, "buy", 1)]),
      column(T + 500, [print(T - 1, "buy", 1), print(T + 400, "buy", 1)]),
      column(T + 10_500, [print(T + 10_000, "buy", 1), print(T + 9_000, "buy", 1)]),
      column(T + 11_999, [print(T + 9_999, "buy", 1)]),
      column(T + 12_000, [print(T + 9_999, "buy", 1)]),
    ];
    expect(candlesIn([tier(columns, 1_000)], T, T + 10_000, 1, slots(T - 2_000, 1_000, 14))).toEqual([[T, tally(2, 2, 0, 0)], [T + 9_000, tally(2, 2, 0, 0)]]);
  });

  it("counts each print once, by the tier that owns its time, wherever the tiers overlap or a column carries it late", () => {
    const seam = T + 9_000;
    const deep = tier([column(T + 10_000, [print(T + 8_500, "sell", 2), print(T + 9_500, "sell", 3)])], 10_000, -Infinity, seam);
    const fine = tier([column(T + 9_500, [print(T + 8_600, "buy", 4), print(T + 9_500, "sell", 3)]), column(T + 10_500, [print(T + 10_200, "buy", 5)])], 1_000, seam, Infinity);
    const one = slots(T, 20_000, 1);
    expect(candlesIn([deep, fine], T, T + 20_000, 1, one)).toEqual([[T, tally(1, 5, 2, 5)]]);
    expect(candlesIn([deep, fine], T + 9_200, T + 20_000, 1, one)).toEqual([[T, tally(1, 5, 1, 3)]]);
    expect(candlesIn([deep, fine], T, T + 8_600, 1, one)).toEqual([[T, tally(0, 0, 1, 2)]]);
  });

  it("a column without prints is quiet, a print of nothing is skipped, a print before the first candle or in a hole between candles counts nothing, and it walks at most MAX_PRINT_COLUMNS columns, the newest first", () => {
    expect(candlesIn([tier([column(T, undefined), column(T + 1_000, [print(T + 500, "buy", 0)], null)], 1_000)], T, T + 2_000, 0, slots(T, 1_000, 2))).toEqual([]);
    const late = [column(T + 1_000, [print(T + 500, "buy", 2)]), column(T + 3_000, [print(T + 2_500, "buy", 2)])];
    expect(candlesIn([tier(late, 1_000)], T, T + 4_000, 1, [{ ts_open: T + 1_000, interval_ms: 1_000 }, { ts_open: T + 3_000, interval_ms: 1_000 }])).toEqual([]);
    expect(candlesIn([tier(late, 1_000)], T, T + 4_000, 1, slots(T, 1_000, 4))).toEqual([[T, tally(1, 2, 0, 0)], [T + 2_000, tally(1, 2, 0, 0)]]);
    const columns: LiquidityColumn[] = [];
    for (let i = 0; i < MAX_PRINT_COLUMNS + 10; i += 1) columns.push(column(T + i * 1_000, [print(T + i * 1_000, "buy", 1)]));
    expect(candlesIn([tier(columns, 1_000)], T, T + (MAX_PRINT_COLUMNS + 10) * 1_000, 1, slots(T, (MAX_PRINT_COLUMNS + 10) * 1_000, 1))).toEqual([[T, tally(MAX_PRINT_COLUMNS, MAX_PRINT_COLUMNS, 0, 0)]]);
  });
});

describe("candlesOf", () => {
  it("lists the candles oldest first, each with its delta of big buys less big sells", () => {
    expect(candlesOf(new Map([[T + 60_000, tally(1, 2, 0, 0)], [T, tally(1, 3, 2, 7)]]))).toEqual([
      { tsOpen: T, delta: -4, ...tally(1, 3, 2, 7) },
      { tsOpen: T + 60_000, delta: 2, ...tally(1, 2, 0, 0) },
    ]);
    expect(candlesOf(new Map())).toEqual([]);
  });
});

describe("the auto print floor", () => {
  it("rounds to the nearest of 1, 2 and 5 times a power of ten on a log scale", () => {
    expect([niceFloor(8.2), niceFloor(3.1), niceFloor(3.2), niceFloor(1.4), niceFloor(1.5), niceFloor(0.37), niceFloor(7), niceFloor(1_800), niceFloor(1), niceFloor(0), niceFloor(-3), niceFloor(Infinity)]).toEqual([10, 2, 5, 1, 2, 0.5, 5, 2_000, 1, 0, 0, 0]);
  });

  it("is the nice median of the heatmap columns' floors, nothing without any, and a floor set by hand wins", () => {
    const floors = (...values: (number | undefined)[]) => values.map((printsFloor) => ({ printsFloor }));
    expect(autoPrintFloorOf(floors(1, 9, 8.2, undefined, 0, 7.9))).toBe(10);
    expect(autoPrintFloorOf(floors(undefined, 0))).toBe(0);
    expect(autoPrintFloorOf(floors(0, 0, 0, 8.2))).toBe(10);
    expect(autoPrintFloorOf([])).toBe(0);
    expect(printFloorFor(14, floors(8.2))).toBe(14);
    expect(printFloorFor(0, floors(8.2))).toBe(10);
  });

  it("starts from the fine columns' floor, then the deep columns' when the fine ones hold no prints, then the instrument's suggested floor, and nothing with none of them", () => {
    const floors = (...values: (number | undefined)[]) => values.map((printsFloor) => ({ printsFloor })) as LiquidityColumn[];
    const es = { symbol: "/ESZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" } as const;
    expect(startingPrintFloorFor({ columns: floors(8.2), deepColumns: floors(2.2) }, es)).toBe(10);
    expect(startingPrintFloorFor({ columns: floors(undefined, 0), deepColumns: floors(2.2, 1.9) }, es)).toBe(2);
    expect(startingPrintFloorFor({ columns: [], deepColumns: floors(undefined) }, es)).toBe(10);
    expect(startingPrintFloorFor(null, es)).toBe(10);
    expect(startingPrintFloorFor(null, { symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toBe(5);
    expect(startingPrintFloorFor(null, { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" })).toBe(5);
    expect(startingPrintFloorFor(null, { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toBe(1);
    expect(startingPrintFloorFor(null, { symbol: "SOL-USDT", provider: "BINANCE", marketKind: "SPOT" })).toBe(0);
    expect(startingPrintFloorFor(null, null)).toBe(0);
  });
});

describe("readAggressiveProfile", () => {
  const columns = [
    column(T + 10_000, [print(T + 9_000, "sell", 9)]),
    column(T + 70_000, [print(T + 69_000, "buy", 5), print(T + 69_500, "sell", 3)]),
  ];
  const input = { printTiers: [tier(columns, 1_000)], fromTs: T, toTs: T + 120_000, floor: 1, candles: slots(T, 60_000, 2) };

  it("with no recording reads every candle from the columns", () => {
    expect(readAggressiveProfile(input)).toEqual([
      { tsOpen: T, delta: -9, ...tally(0, 0, 1, 9) },
      { tsOpen: T + 60_000, delta: 2, ...tally(1, 5, 1, 3) },
    ]);
  });

  it("takes the recording's candles and reads the columns only over what the recording and the live prints left open, never changing the recording's candles", () => {
    const candles = new Map([[T, tally(2, 25, 0, 0)]]);
    const recorded = { ...tally(2, 25, 0, 0), candles, gaps: [{ from: T + 5_000, to: T + 120_000 }], loading: true };
    expect(readAggressiveProfile({ ...input, recorded })).toEqual([
      { tsOpen: T, delta: 16, ...tally(2, 25, 1, 9) },
      { tsOpen: T + 60_000, delta: 2, ...tally(1, 5, 1, 3) },
    ]);
    expect(candles.get(T)).toEqual(tally(2, 25, 0, 0));
    expect(readAggressiveProfile({ ...input, recorded: { ...recorded, gaps: [] } })).toEqual([{ tsOpen: T, delta: 25, ...tally(2, 25, 0, 0) }]);
  });

  it("refuses a range that does not run forward", () => {
    expect(() => readAggressiveProfile({ ...input, toTs: T })).toThrow("range must run forward");
  });
});
