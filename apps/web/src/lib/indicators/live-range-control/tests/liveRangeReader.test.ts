import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { GAP_MIN_MS, HOST_COLUMN_MS, IMPACT_MIN_SHARE, NOISE_BUCKET_MS, gridGaps, readLiveRange, seamOf, spanOf, sumColumn, type HostColumn, type RangeGrid } from "../liveRangeReader";

const T = Date.UTC(2026, 9, 16, 2, 0);
const MINUTE = 60_000;
const NO_PRINTS = { prints: [], printsFloor: null };

function column(ts: number, lo: number, extra: Partial<LiquidityColumn> = {}): LiquidityColumn {
  return { ts, lo, hi: lo + 8, bid: new Float64Array(9), ask: new Float64Array(9), ...extra };
}

function grid(columns: LiquidityColumn[], deepColumns: LiquidityColumn[] = [], rowWidth = 1): RangeGrid {
  return { columns, columnMs: 1_000, deepColumns, deepColumnMs: deepColumns.length > 0 ? 10_000 : 0, rowWidth };
}

function hostColumn(ts: number, buys: number, sells: number, rowWidth = 1): HostColumn {
  return { ...NO_PRINTS, ts, rowWidth, buy: buys > 0 ? [[100, buys]] : [], sell: sells > 0 ? [[100, sells]] : [] };
}

describe("missing data", () => {
  it("is the time inside the chart's candles that neither the runtime nor the host recorded, up to the runtime's newest column: a closed market is never missing, nor anything while the runtime has no column, and a host column of another row width covers nothing", () => {
    const deep = Array.from({ length: 60 }, (_, k) => column(T + 1_000 + 10_000 * k, 96));
    const g = grid([column(T + 61 * MINUTE, 96)], deep);
    const hour = readLiveRange(g, T, T + 60 * MINUTE);
    expect([hour.tradedMs, hour.missing]).toEqual([60 * MINUTE, [[T + 10 * MINUTE, T + 60 * MINUTE]]]);
    const open = readLiveRange(g, T, T + 60 * MINUTE, [], [[T - MINUTE, T + 30 * MINUTE], [T + 50 * MINUTE, T + 55 * MINUTE]]);
    expect([open.tradedMs, open.missing]).toEqual([35 * MINUTE, [[T + 10 * MINUTE, T + 30 * MINUTE], [T + 50 * MINUTE, T + 55 * MINUTE]]]);
    const hosted = Array.from({ length: 60 }, (_, k) => hostColumn(T + 20 * MINUTE + 1_000 + 10_000 * k, 1, 0));
    expect(readLiveRange(g, T, T + 60 * MINUTE, hosted, [[T, T + 30 * MINUTE]]).missing).toEqual([[T + 10 * MINUTE, T + 20 * MINUTE]]);
    expect(readLiveRange(g, T, T + 60 * MINUTE, [hosted[0], hosted[59]], [[T, T + 30 * MINUTE]]).missing).toEqual([[T + 10 * MINUTE, T + 20 * MINUTE], [T + 20 * MINUTE + 10_000, T + 29 * MINUTE + 50_000]]);
    expect(readLiveRange(g, T, T + 60 * MINUTE, hosted.map((c) => ({ ...c, rowWidth: 2 })), [[T, T + 30 * MINUTE]]).missing).toEqual([[T + 10 * MINUTE, T + 30 * MINUTE]]);
    expect(readLiveRange(grid([], deep), T, T + 60 * MINUTE).missing).toEqual([]);
    expect(readLiveRange(null, T, T + 60 * MINUTE, [], [[T, T + 60 * MINUTE]])).toMatchObject({ tradedMs: 60 * MINUTE, missing: [] });
    expect(readLiveRange(grid([]), T, T + 60 * MINUTE)).toMatchObject({ tradedMs: 60 * MINUTE, missing: [] });
    expect(readLiveRange(g, T, T)).toMatchObject({ tradedMs: 0, missing: [] });
  });
});

describe("price impact", () => {
  it("credits each counted minute's price move, from the volume-weighted price of the minute before, to the side that won the minute, with that side's volume; the first counted minute and even minutes move nothing", () => {
    const columns = [
      column(T + 1_000, 96, { buy: [[100, 5]] }),
      column(T + MINUTE + 1_000, 96, { buy: [[98, 1]], sell: [[98, 4]] }),
      column(T + 2 * MINUTE + 1_000, 96, { buy: [[103, 6]], sell: [[103, 2]] }),
      column(T + 3 * MINUTE + 1_000, 96, { buy: [[90, 0.2]] }),
      column(T + 4 * MINUTE + 1_000, 96, { buy: [[105, 3]] }),
      column(T + 5 * MINUTE + 1_000, 96, { buy: [[110, 2]], sell: [[110, 2]] }),
      column(T + 6 * MINUTE + 1_000, 96, { sell: [[104, 7]] }),
    ];
    expect(readLiveRange(grid(columns), T, T + 3 * MINUTE).impact).toEqual({ buyers: { moved: 5, volume: 6 }, sellers: { moved: 2, volume: 4 } });
    expect(readLiveRange(grid(columns), T, T + 7 * MINUTE).impact).toEqual({ buyers: { moved: 7, volume: 9 }, sellers: { moved: 2 + 6, volume: 4 + 7 } });
    expect(readLiveRange(grid(columns, [], 10), T, T + 3 * MINUTE).impact).toEqual({ buyers: { moved: 50, volume: 6 }, sellers: { moved: 20, volume: 4 } });
    expect(readLiveRange(grid(columns), T + 2 * MINUTE, T + 3 * MINUTE).impact).toEqual({ buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } });
    const half = grid([], [column(T + 10_000, 100, { buy: [[100, 4]] }), column(T + MINUTE + 10_000, 100, { buy: [[102, 10]] })]);
    expect(readLiveRange(half, T, T + MINUTE + 14_000).impact).toEqual({ buyers: { moved: 2, volume: 5 }, sellers: { moved: 0, volume: 0 } });
    expect(IMPACT_MIN_SHARE).toBe(0.1);
  });

  it("weighs a minute's price by its volume across its columns and its sides, and takes the host's columns in their own row width", () => {
    const columns = [column(T + 1_000, 96, { buy: [[100, 1]], sell: [[102, 3]] }), column(T + 2_000, 96, { buy: [[104, 4]] }), column(T + MINUTE + 1_000, 96, { buy: [[106, 2]] })];
    expect(readLiveRange(grid(columns), T, T + 2 * MINUTE).impact).toEqual({ buyers: { moved: 106 - 102.75, volume: 2 }, sellers: { moved: 0, volume: 0 } });
    const hosted: HostColumn[] = [{ ...NO_PRINTS, ts: T - 50_000, rowWidth: 0.5, buy: [[200, 2]], sell: [] }, { ...NO_PRINTS, ts: T - 40_000, rowWidth: 0.5, buy: [], sell: [[196, 6]] }];
    const read = readLiveRange(grid([column(T + 1_000, 96, { buy: [[100, 3]] })], [], 0.5), T - MINUTE, T + MINUTE, hosted);
    expect(read.impact).toEqual({ buyers: { moved: 50 - 98.5, volume: 3 }, sellers: { moved: 0, volume: 0 } });
    expect(readLiveRange(null, T - MINUTE, T, hosted).impact).toEqual({ buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } });
  });
});

describe("spans and seams", () => {
  it("a one-second column covers the second ending at its time, a ten-second column the ten seconds from one second before it", () => {
    expect(spanOf(T, 1_000)).toEqual([T - 1_000, T]);
    expect(spanOf(T, 10_000)).toEqual([T - 1_000, T + 9_000]);
    expect(HOST_COLUMN_MS).toBe(10_000);
  });

  it("the seam is where the ten-second tier ends and the one-second tier begins: the first ten-second boundary at or after the one-second start when the deep tier reaches it, else the one-second start, and past everything without one-second columns", () => {
    expect(seamOf({ columns: [], deepColumns: [column(T, 96)], deepColumnMs: 10_000 })).toBe(Number.POSITIVE_INFINITY);
    expect(seamOf({ columns: [column(T + 1_000, 96)], deepColumns: [], deepColumnMs: 0 })).toBe(T + 1_000);
    expect(seamOf({ columns: [column(T + 2_500, 96)], deepColumns: [column(T, 96)], deepColumnMs: 10_000 })).toBe(T + 10_000);
    expect(seamOf({ columns: [column(T + 2_500, 96)], deepColumns: [column(T - 10_000, 96)], deepColumnMs: 10_000 })).toBe(T + 2_500);
    expect(seamOf({ columns: [column(T + 10_000, 96)], deepColumns: [column(T, 96)], deepColumnMs: 10_000 })).toBe(T + 10_000);
    expect(seamOf({ columns: [column(T + 2_500, 96)], deepColumns: [column(T - 10_000, 96), column(T + 20_000, 96)], deepColumnMs: 10_000 })).toBe(T + 2_500);
  });

});

describe("sumColumn", () => {
  it("adds up a column's buys and sells over every row, and its traded rows weighted by volume, once per column, and counts a size that is not a positive number as nothing", () => {
    const col = column(T + 1_000, 96, { buy: [[100, 5], [103, 50]], sell: [[97, 60], [101, 2]] });
    expect(sumColumn(col)).toEqual({ buys: 55, sells: 62, rowVolume: 100 * 5 + 103 * 50 + 97 * 60 + 101 * 2 });
    expect(sumColumn(col)).toBe(sumColumn(col));
    expect(sumColumn(column(T + 2_000, 96))).toEqual({ buys: 0, sells: 0, rowVolume: 0 });
    expect(sumColumn(column(T + 3_000, 96, { buy: [[100, -4], [101, Number.NaN], [102, 2]] }))).toEqual({ buys: 2, sells: 0, rowVolume: 204 });
    expect(sumColumn(column(T + 4_000, 96, { buy: [[100, Number.POSITIVE_INFINITY], [102, 2]], sell: [[99, Number.NEGATIVE_INFINITY]] }))).toEqual({ buys: 2, sells: 0, rowVolume: 204 });
  });
});

describe("readLiveRange", () => {
  it("sums the trades of the one-second columns inside the window, a column counted by the part of it inside, with the time it covers", () => {
    const columns = [column(T + 1_000, 96, { buy: [[100, 5]], sell: [[100, 1]] }), column(T + 2_000, 96, { buy: [[100, 2]] })];
    expect(readLiveRange(grid(columns), T, T + 2_000)).toEqual({ buys: 7, sells: 1, fromTs: T, toTs: T + 2_000, coveredMs: 2_000, tradedMs: 2_000, missing: [], noise: 6, minutesWon: { buyers: 1, sellers: 0 }, impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } } });
    const half = readLiveRange(grid(columns), T + 500, T + 2_000);
    expect([half.buys, half.coveredMs]).toEqual([4.5, 1_500]);
    const first = readLiveRange(grid(columns), T, T + 1_500);
    expect([first.buys, first.coveredMs]).toEqual([6, 1_500]);
  });

  it("reads the ten-second tier up to the seam and the one-second tier from it, so no second is counted twice where the two tiers both run", () => {
    const deep = [column(T, 96, { buy: [[100, 6]] }), column(T + 10_000, 96, { buy: [[100, 50]] }), column(T + 20_000, 96, { buy: [[100, 50]] })];
    const fine = [column(T + 8_000, 96, { buy: [[100, 40]] }), column(T + 9_000, 96, { buy: [[100, 40]] }), column(T + 10_000, 96, { buy: [[100, 1]] }), column(T + 11_000, 96, { buy: [[100, 1]] }), column(T + 12_000, 96, { buy: [[100, 1]] })];
    const read = readLiveRange(grid(fine, deep), T - 1_000, T + 12_000);
    expect([read.buys, read.coveredMs]).toEqual([9, 13_000]);
    const beyond = readLiveRange(grid(fine, deep), T + 14_000, T + 19_000);
    expect([beyond.buys, beyond.coveredMs]).toEqual([0, 0]);
  });

  it("counts a ten-second column's trades in proportion to the part of it inside the window", () => {
    const deep = [column(T + 10_000, 100, { buy: [[100, 10]], sell: [[100, 20]] })];
    const read = readLiveRange(grid([], deep), T + 14_000, T + 19_000);
    expect([read.buys, read.sells, read.coveredMs]).toEqual([5, 10, 5_000]);
  });

  it("reads the host's ten-second columns for the window before the runtime's oldest column and never over a time the runtime holds, leaving out a column whose rows are not the grid's", () => {
    const deep = [column(T + 80_000, 100, { buy: [[100, 7]] })];
    const quiet = [2, 3, 4, 5, 6, 7].map((i) => hostColumn(T + i * 10_000, 0, 0));
    const hosted = [hostColumn(T - 10_000, 9, 1), hostColumn(T, 1, 0), hostColumn(T + 10_000, 3, 2), ...quiet, hostColumn(T + 80_000, 999, 999)];
    const read = readLiveRange(grid([], deep), T, T + 90_000, hosted);
    expect(read.coveredMs).toBe(89_000);
    expect(read.buys).toBeCloseTo(0.9 + 3 + 7, 12);
    expect(read.sells).toBe(2);
    const cut = readLiveRange(grid([], deep), T + 5_000, T + 90_000, hosted);
    expect(cut.buys).toBeCloseTo(0.4 + 3 + 7, 12);
    const alone = readLiveRange(grid([]), T, T + 79_000, hosted);
    expect([alone.coveredMs, alone.buys]).toEqual([79_000, 3.9]);
    const replaying: RangeGrid = { columns: [column(T + 10_000, 96)], columnMs: 10_000, deepColumns: [], deepColumnMs: 0, rowWidth: 1 };
    expect(readLiveRange(replaying, T, T + 79_000, hosted).buys).toBe(3.9);
    expect(readLiveRange(grid([]), T, T + 79_000, [hostColumn(T + 10_000, 3, 0, 2)]).coveredMs).toBe(0);
    expect(readLiveRange(null, T, T + 79_000, [hostColumn(T + 10_000, 3, 0, 2)]).buys).toBe(3);
    expect(readLiveRange(null, T, T + 79_000, [{ ...hostColumn(T + 10_000, 3, 0), rowWidth: 0 }]).buys).toBe(0);
  });

  it("names the stretches of a minute or more the runtime holds no column for, up to the runtime's newest column, and fills them from the host's columns by the part of each inside a stretch", () => {
    const deep = [column(T, 100, { buy: [[100, 7]] }), column(T + 120_000, 100, { buy: [[100, 7]] })];
    const fine = [column(T + 130_000, 96, { buy: [[100, 1]] }), column(T + 131_000, 96, { buy: [[100, 1]] })];
    const g = grid(fine, deep);
    expect(GAP_MIN_MS).toBe(60_000);
    expect(gridGaps(g, T - 1_000, T + 131_000)).toEqual([[T + 9_000, T + 119_000]]);
    expect(gridGaps(g, T - 90_000, T + 20_000)).toEqual([[T - 90_000, T - 1_000]]);
    expect(gridGaps(g, T - 90_000, T + 69_000)).toEqual([[T - 90_000, T - 1_000], [T + 9_000, T + 69_000]]);
    expect(gridGaps(g, T + 30_000, T + 119_000)).toEqual([[T + 30_000, T + 119_000]]);
    expect(gridGaps(g, T + 125_000, T + 140_000)).toEqual([]);
    expect(gridGaps(g, T + 140_000, T + 150_000)).toEqual([]);
    expect(gridGaps(g, T + 140_000, T + 300_000)).toEqual([]);
    expect(gridGaps(g, T + 125_000, T + 300_000)).toEqual([]);
    expect(gridGaps(g, T - 90_000, T - 10_000)).toEqual([[T - 90_000, T - 10_000]]);
    expect(gridGaps(g, T, T)).toEqual([]);
    expect(gridGaps(grid([], [column(T, 100), column(T + 120_000, 100)]), T - 1_000, T + 129_000)).toEqual([[T + 9_000, T + 119_000]]);
    expect(gridGaps(grid([], [column(T + 10_000, 100), column(T + 100_000, 100)]), T + 12_000, T + 109_000)).toEqual([[T + 19_000, T + 99_000]]);
    const overlapping = grid(Array.from({ length: 121 }, (_, i) => column(T + 10_000 + i * 1_000, 96)), [column(T, 100), column(T + 120_000, 100)]);
    expect(gridGaps(overlapping, T - 1_000, T + 130_000)).toEqual([]);
    expect(gridGaps(grid([]), T, T + 5 * MINUTE)).toEqual([[T, T + 5 * MINUTE]]);
    expect(gridGaps(grid([]), T, T + MINUTE - 1)).toEqual([]);
    expect(gridGaps(null, T, T + 5 * MINUTE)).toEqual([[T, T + 5 * MINUTE]]);
    expect(gridGaps({ columns: [column(T + 10_000, 96)], columnMs: 10_000, deepColumns: [], deepColumnMs: 0, rowWidth: 1 }, T, T + 5 * MINUTE)).toEqual([[T, T + 5 * MINUTE]]);
    const hosted = [hostColumn(T, 999, 999), hostColumn(T + 10_000, 3, 0), hostColumn(T + 20_000, 2, 0), hostColumn(T + 115_000, 10, 0), hostColumn(T + 120_000, 999, 999), hostColumn(T + 141_000, 999, 999)];
    const read = readLiveRange(g, T - 1_000, T + 131_000, hosted);
    expect([read.buys, read.sells, read.coveredMs]).toEqual([26, 0, 47_000]);
    const edge = readLiveRange(g, T + 140_000, T + 150_000, hosted);
    expect([edge.buys, edge.coveredMs]).toEqual([0, 0]);
    const short = readLiveRange(grid([column(T + 40_000, 96, { buy: [[100, 1]] })]), T, T + 40_000, [hostColumn(T + 10_000, 3, 0)]);
    expect([short.buys, short.coveredMs]).toEqual([1, 1_000]);
    const before = readLiveRange(g, T - 90_000, T - 10_000, [hostColumn(T - 20_000, 4, 0)]);
    expect([before.buys, before.coveredMs]).toEqual([4, 10_000]);
  });

  it("reads nothing from the runtime while the finest tier the grid holds is not the one-second tier, as while a reload replays the five-minute or ten-second tier first", () => {
    const replaying: RangeGrid = { columns: [column(T + 10_000, 96, { buy: [[100, 5]] })], columnMs: 10_000, deepColumns: [], deepColumnMs: 0, rowWidth: 1 };
    const read = readLiveRange(replaying, T, T + 20_000);
    expect([read.buys, read.coveredMs]).toEqual([0, 0]);
  });

  it("covers nothing without a grid or without columns, and reads nothing at all for an empty window", () => {
    expect(readLiveRange(null, T, T + 1_000).coveredMs).toBe(0);
    const none = readLiveRange(grid([]), T, T + 1_000);
    expect([none.buys, none.sells, none.coveredMs]).toEqual([0, 0, 0]);
    const shut = readLiveRange(grid([column(T + 1_000, 96, { buy: [[100, 2]] })]), T + 1_000, T + 1_000);
    expect([shut.coveredMs, shut.buys]).toEqual([0, 0]);
  });

  it("puts a column in the clock minute of its middle: a one-second column ending on the minute in the minute before, a host column in the minute its middle falls in", () => {
    const fine = [column(T + MINUTE, 96, { buy: [[100, 5]] }), column(T + MINUTE + 1_000, 96, { sell: [[100, 5]] })];
    const read = readLiveRange(grid(fine), T, T + MINUTE + 1_000);
    expect([read.minutesWon, read.noise]).toEqual([{ buyers: 1, sellers: 1 }, Math.sqrt(50)]);
    const hosted = [hostColumn(T + 55_000, 5, 0), hostColumn(T + 65_000, 0, 5)];
    const host = readLiveRange(null, T + 10_000, T + 80_000, hosted);
    expect([host.minutesWon, host.noise]).toEqual([{ buyers: 1, sellers: 1 }, Math.sqrt(50)]);
  });

  it("the noise is the root of the summed squares of each minute's net, a column's net weighted by its part inside the window, the host's columns counted in their minutes too; a minute is won by the side with the larger net, by nobody when even", () => {
    const columns = [
      column(T + 1_000, 96, { buy: [[100, 5]], sell: [[100, 1]] }),
      column(T + 2_000, 96, { buy: [[100, 2]], sell: [[100, 2]] }),
      column(T + MINUTE + 1_000, 96, { buy: [[100, 1]], sell: [[100, 4]] }),
    ];
    const read = readLiveRange(grid(columns), T, T + 2 * MINUTE);
    expect([read.buys, read.sells, read.noise]).toEqual([8, 7, 5]);
    expect(read.minutesWon).toEqual({ buyers: 1, sellers: 1 });
    const whole = readLiveRange(grid(columns), T - MINUTE, T + 2 * MINUTE, [hostColumn(T - 10_000, 3, 0)]);
    expect([whole.buys, whole.sells]).toEqual([11, 7]);
    expect(whole.noise).toBeCloseTo(Math.sqrt(9 + 16 + 9), 12);
    const half = readLiveRange(grid(columns), T + 500, T + 2 * MINUTE);
    expect(half.noise).toBeCloseTo(Math.sqrt(2 * 2 + 3 * 3), 12);
    const quiet = readLiveRange(grid([column(T + 1_000, 96, { buy: [[100, 2]], sell: [[100, 2]] })]), T, T + MINUTE);
    expect([quiet.buys, quiet.sells, quiet.noise]).toEqual([2, 2, 0]);
    expect(quiet.minutesWon).toEqual({ buyers: 0, sellers: 0 });
    expect(readLiveRange(grid([]), T, T + MINUTE).noise).toBe(0);
    expect(readLiveRange(grid([]), T, T + MINUTE).minutesWon).toEqual({ buyers: 0, sellers: 0 });
    expect(readLiveRange(grid([]), T, T + MINUTE).impact).toEqual({ buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } });
    expect(whole.minutesWon).toEqual({ buyers: 2, sellers: 1 });
    expect(NOISE_BUCKET_MS).toBe(60_000);
  });
});
