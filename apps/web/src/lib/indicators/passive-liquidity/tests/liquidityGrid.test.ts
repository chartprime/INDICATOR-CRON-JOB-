import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../../types/frames";
import { LIQUIDITY_CEILING_ALPHA, LIQUIDITY_CEILING_SEED_CAP, LiquidityGrid, bandMaxSizes, bandSizes, decodeLiquidityColumn, liquidityPercentile, liquiditySizeAt } from "../liquidityGrid";

const T = 1_700_000_000_000;

type FrameFields = Pick<LiquidityFrame, "ts" | "seq" | "reset" | "row_width" | "column_ms" | "columns">;

function frame(overrides: Partial<FrameFields>): LiquidityFrame {
  const base: LiquidityFrame = {
    type: "liquidity",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    ts: T,
    seq: 1,
    reset: true,
    row_width: 2,
    column_ms: 1000,
    columns: [],
  };
  return { ...base, ...overrides };
}

const full = { ts: T, lo: 100, hi: 104, bid: [[0, 1], [2, 3]] as [number, number][], ask: [[3, 4]] as [number, number][] };

describe("decodeLiquidityColumn", () => {
  it("builds the first column from its entries", () => {
    const column = decodeLiquidityColumn(null, full);
    expect(Array.from(column.bid)).toEqual([1, 0, 3, 0, 0]);
    expect(Array.from(column.ask)).toEqual([0, 0, 0, 4, 0]);
    expect(liquiditySizeAt(column, "bid", 102)).toBe(3);
    expect(liquiditySizeAt(column, "bid", 99)).toBe(0);
  });

  it("carries the previous column forward and applies changes, including zeroes", () => {
    const prev = decodeLiquidityColumn(null, full);
    const next = decodeLiquidityColumn(prev, { ts: T + 1000, lo: 100, hi: 104, bid: [[2, 0], [4, 7]], ask: [] });
    expect(Array.from(next.bid)).toEqual([1, 0, 0, 0, 7]);
    expect(Array.from(next.ask)).toEqual([0, 0, 0, 4, 0]);
  });

  it("treats rows outside the previous window as zero when the window shifts", () => {
    const prev = decodeLiquidityColumn(null, full); // rows 100..104
    const next = decodeLiquidityColumn(prev, { ts: T + 1000, lo: 102, hi: 106, bid: [[4, 9]], ask: [] }); // rows 102..106
    expect(Array.from(next.bid)).toEqual([3, 0, 0, 0, 9]);
    expect(Array.from(next.ask)).toEqual([0, 4, 0, 0, 0]);
  });
});

describe("bandSizes", () => {
  it("carries the column's flow across with absolute rows, and leaves it off a column that has none", () => {
    const print = { ts: T - 10, price: 101.5, size: 2, side: "sell" as const, id: "p1" };
    const column = decodeLiquidityColumn(null, { ...full, buy: [[0, 1.5]], sell: [[4, 0.25]], prints: [print], prints_floor: 1 });
    expect(column.buy).toEqual([[100, 1.5]]);
    expect(column.sell).toEqual([[104, 0.25]]);
    expect(column.prints).toEqual([print]);
    expect(column.printsFloor).toBe(1);
    const plain = decodeLiquidityColumn(column, { ts: T + 1_000, lo: 100, hi: 104, bid: [], ask: [] });
    expect("buy" in plain).toBe(false);
    expect("prints" in plain).toBe(false);
  });

  it("sums the rows of one band on each side", () => {
    const column = decodeLiquidityColumn(null, { ts: T, lo: 100, hi: 105, bid: [[0, 1], [1, 2], [2, 4]], ask: [[3, 5], [4, 6]] });
    expect(bandSizes(column, 50, 2)).toEqual({ bid: 3, ask: 0 }); // rows 100-101
    expect(bandSizes(column, 51, 2)).toEqual({ bid: 4, ask: 5 }); // rows 102-103
    expect(bandSizes(column, 25, 4)).toEqual({ bid: 7, ask: 5 }); // rows 100-103
    expect(bandSizes(column, 26, 4)).toEqual({ bid: 0, ask: 6 }); // rows 104-107, clipped to the window at 105
    expect(bandSizes(column, 100, 1)).toEqual({ bid: 1, ask: 0 }); // one row to a band
    expect(bandSizes(column, 9, 2)).toEqual({ bid: 0, ask: 0 }); // outside the window
  });
});

describe("liquidityPercentile", () => {
  it("picks from the non-zero cells on both sides", () => {
    const column = decodeLiquidityColumn(null, { ts: T, lo: 0, hi: 3, bid: [[0, 1], [1, 2]], ask: [[2, 3], [3, 4]] });
    expect(liquidityPercentile(column, 0)).toBe(1);
    expect(liquidityPercentile(column, 1)).toBe(4);
    expect(liquidityPercentile(column, 0.5)).toBe(3);
    expect(liquidityPercentile(column, 0.3)).toBe(2);
    expect(liquidityPercentile(decodeLiquidityColumn(null, { ts: T, lo: 0, hi: 1, bid: [], ask: [] }), 0.95)).toBe(0);
  });

  it("can be limited to rows near the mid", () => {
    // Rows 0..6, mid 3: within one row of the mid only rows 2..4 count.
    const column = decodeLiquidityColumn(null, { ts: T, lo: 0, hi: 6, bid: [[0, 50], [1, 50], [2, 1], [3, 2], [4, 3], [5, 50], [6, 50]], ask: [] });
    expect(liquidityPercentile(column, 1, 1)).toBe(3);
    expect(liquidityPercentile(column, 1)).toBe(50);
  });
});

describe("LiquidityGrid", () => {
  it("starts on a reset frame and chains delta frames by seq", () => {
    const grid = new LiquidityGrid();
    expect(grid.baseAsset).toBe("");
    expect(grid.apply(frame({ seq: 1, reset: true, columns: [full] }))).toBe(true);
    expect(grid.baseAsset).toBe("BTC");
    expect(grid.columns).toHaveLength(1);
    expect(grid.rowWidth).toBe(2);
    expect(grid.columnMs).toBe(1000);
    expect(grid.version).toBe(1);
    expect(grid.referenceSize).toBe(4); // p95 of [1, 3, 4]
    expect(grid.columns[0].reference).toBe(4); // and the column carries it
    expect(grid.columns[0].median).toBe(4); // and the typical row: within one row of the mid the cells are [3, 4], whose median index rounds up
    expect(grid.columns[0].ceiling).toBe(4); // and the biggest row near the mid

    const delta = frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [[0, 2]], ask: [] }] });
    expect(grid.apply(delta)).toBe(true);
    expect(grid.columns).toHaveLength(2);
    expect(Array.from(grid.latest!.bid)).toEqual([2, 0, 3, 0, 0]);
    expect(grid.version).toBe(2);
  });

  it("counts an epoch per reset, so a reader of the columns knows when to start over", () => {
    const grid = new LiquidityGrid();
    expect(grid.epoch).toBe(0);
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    expect(grid.epoch).toBe(1);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ...full, ts: T + 1000 }] }));
    expect(grid.epoch).toBe(1);
    grid.apply(frame({ ts: T + 2000, seq: 3, reset: true, columns: [{ ...full, ts: T + 2000 }] }));
    expect(grid.epoch).toBe(2);
    // A rejected frame changes nothing.
    grid.apply(frame({ ts: T + 3000, seq: 9, reset: false, columns: [{ ...full, ts: T + 3000 }] }));
    expect(grid.epoch).toBe(2);
    // The deep tier's own reset counts too: the sequence a reader walks changed.
    grid.apply(frame({ ts: T + 3000, seq: 1, reset: true, column_ms: 10_000, columns: [{ ...full, ts: T - 10_000 }] }));
    expect(grid.epoch).toBe(3);
  });

  it("rejects a delta that does not follow the last seq and waits for the next reset", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    const skipped = frame({ ts: T + 2000, seq: 3, reset: false, columns: [{ ts: T + 2000, lo: 100, hi: 104, bid: [], ask: [] }] });
    expect(grid.apply(skipped)).toBe(false);
    expect(grid.synced).toBe(false);
    expect(grid.rejected).toBe(1);
    expect(grid.columns).toHaveLength(1);
    // Even the right seq is refused now.
    expect(grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(false);
    // A reset recovers.
    expect(grid.apply(frame({ ts: T + 5000, seq: 6, reset: true, columns: [{ ...full, ts: T + 5000 }] }))).toBe(true);
    expect(grid.synced).toBe(true);
    expect(grid.columns).toHaveLength(1);
    expect(grid.latest!.ts).toBe(T + 5000);
  });

  it("keeps the columns of a delta that decoded before a column went back in time, then refuses the rest and waits for a reset", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    const back = frame({
      ts: T + 1000, seq: 3, reset: false,
      columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [], ask: [] }, { ts: T + 1000, lo: 100, hi: 104, bid: [], ask: [] }],
    });
    expect(grid.apply(back)).toBe(false);
    expect(grid.synced).toBe(false);
    expect(grid.rejected).toBe(1);
    expect(grid.columns.map((column) => column.ts - T)).toEqual([0, 1000]);
  });

  it("rejects a delta before any reset, or one with a different geometry", () => {
    const grid = new LiquidityGrid();
    expect(grid.apply(frame({ seq: 1, reset: false, columns: [full] }))).toBe(false);
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    expect(grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, row_width: 4, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(false);
  });

  it("an empty reset clears the picture", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    expect(grid.apply(frame({ seq: 0, reset: true, columns: [] }))).toBe(true);
    expect(grid.columns).toHaveLength(0);
    expect(grid.latest).toBeNull();
    expect(grid.apply(frame({ ts: T + 1000, seq: 1, reset: false, columns: [{ ...full, ts: T + 1000 }] }))).toBe(true);
  });

  it("applies multi-column snapshot chunks in order and keeps at most `capacity` columns", () => {
    const grid = new LiquidityGrid(3);
    const columns = [0, 1, 2, 3].map((i) => ({ ts: T + i * 1000, lo: 100, hi: 104, bid: [[0, i + 1]] as [number, number][], ask: [] as [number, number][] }));
    expect(grid.apply(frame({ ts: T + 3000, seq: 4, reset: true, columns }))).toBe(true);
    expect(grid.columns.map((c) => c.ts)).toEqual([T + 1000, T + 2000, T + 3000]);
    expect(Array.from(grid.latest!.bid)).toEqual([4, 0, 0, 0, 0]);
    expect(grid.indexAtOrAfter(T)).toBe(0);
    expect(grid.indexAtOrAfter(T + 1500)).toBe(1);
    expect(grid.indexAtOrAfter(T + 3000)).toBe(2);
    expect(grid.indexAtOrAfter(T + 3001)).toBe(3);
  });

  it("keeps the last aggressive-order list it was given and clears it on reset", () => {
    const grid = new LiquidityGrid();
    const cluster = { side: "buy" as const, row: 100, span: 1, start_ts: T, end_ts: null, volume: 12, peak: 12, floor: 10 };
    grid.apply({ ...frame({ seq: 1, reset: true, columns: [full] }), aggressive: [cluster] });
    expect(grid.aggressive).toEqual([cluster]);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ...full, ts: T + 1000 }] }));
    expect(grid.aggressive).toEqual([cluster]);
    const ended = { ...cluster, end_ts: T + 2000 };
    grid.apply({ ...frame({ ts: T + 2000, seq: 3, reset: false, columns: [{ ...full, ts: T + 2000 }] }), aggressive: [ended] });
    expect(grid.aggressive).toEqual([ended]);
    grid.apply(frame({ ts: T + 9000, seq: 9, reset: true, columns: [{ ...full, ts: T + 9000 }] }));
    expect(grid.aggressive).toEqual([]);
  });

  it("keeps the last level list it was given and clears it on reset", () => {
    const grid = new LiquidityGrid();
    const wall = { side: "bid" as const, row: 100, span: 1, start_ts: T, end_ts: null, size: 7, peak: 7, ended_by: null, ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false };
    grid.apply({ ...frame({ seq: 1, reset: true, columns: [full] }), levels: [wall] });
    expect(grid.levels).toEqual([wall]);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ...full, ts: T + 1000 }] }));
    expect(grid.levels).toEqual([wall]);
    grid.apply({ ...frame({ ts: T + 2000, seq: 3, reset: false, columns: [{ ...full, ts: T + 2000 }] }), levels: [] });
    expect(grid.levels).toEqual([]);
    grid.apply({ ...frame({ ts: T + 3000, seq: 4, reset: false, columns: [{ ...full, ts: T + 3000 }] }), levels: [wall] });
    grid.apply(frame({ ts: T + 9000, seq: 9, reset: true, columns: [{ ...full, ts: T + 9000 }] }));
    expect(grid.levels).toEqual([]);
  });

  it("hands a zoom lane its yardstick at a time: the column at that time or the one before it, on the tier asked, and nothing where none has one", () => {
    const grid = new LiquidityGrid();
    expect(grid.yardstickAt(T, false)).toBeNull();
    expect(grid.apply(frame({ ts: T - 10_000, seq: 2, column_ms: 10_000, columns: [{ ...full, ts: T - 20_000 }, { ts: T - 10_000, lo: 100, hi: 104, bid: [[0, 2]], ask: [] }] }))).toBe(true);
    expect(grid.apply(frame({ ts: T + 2_000, seq: 3, column_ms: 1000, columns: [{ ts: T - 1000, lo: 100, hi: 104, bid: [], ask: [] }, { ...full, ts: T }, { ts: T + 2_000, lo: 100, hi: 104, bid: [[0, 9]], ask: [] }] }))).toBe(true);
    const [silent, first, later] = grid.columns;
    expect(silent.reference ?? 0).toBe(0);
    expect(grid.yardstickAt(T - 1000, false)).toBeNull();
    expect(grid.yardstickAt(T - 5_000, false)).toBeNull();
    expect(grid.yardstickAt(T, false)).toEqual({ reference: first.reference, median: first.median, ceiling: first.ceiling });
    expect(grid.yardstickAt(T + 1_000, false)).toEqual({ reference: first.reference, median: first.median, ceiling: first.ceiling });
    expect(grid.yardstickAt(T + 2_000, false)).toEqual({ reference: later.reference, median: later.median, ceiling: later.ceiling });
    expect(grid.yardstickAt(T + 60_000, false)).toEqual({ reference: later.reference, median: later.median, ceiling: later.ceiling });
    const [deepFirst, deepLater] = grid.deepColumns;
    expect(grid.yardstickAt(T - 15_000, true)).toEqual({ reference: deepFirst.reference, median: deepFirst.median, ceiling: deepFirst.ceiling });
    expect(grid.yardstickAt(T - 10_000, true)).toEqual({ reference: deepLater.reference, median: deepLater.median, ceiling: deepLater.ceiling });
    expect(grid.yardstickAt(T - 30_000, true)).toBeNull();
  });

  it("keeps a deep tier behind the fine one, each chained by its own seq and reset, told apart by column_ms", () => {
    const grid = new LiquidityGrid();
    // The deep tier arrives first (10 s columns), then the fine one (1 s) overlapping its end.
    expect(grid.apply(frame({ ts: T - 10_000, seq: 2, column_ms: 10_000, columns: [{ ...full, ts: T - 20_000 }, { ts: T - 10_000, lo: 100, hi: 104, bid: [[0, 2]], ask: [] }] }))).toBe(true);
    expect(grid.columns).toHaveLength(2); // the only tier so far is "the" columns
    expect(grid.columnMs).toBe(10_000);
    expect(grid.deepColumns).toHaveLength(0);
    expect(grid.apply(frame({ ts: T, seq: 2, column_ms: 1000, columns: [{ ...full, ts: T - 1000 }, { ts: T, lo: 100, hi: 104, bid: [[0, 5]], ask: [] }] }))).toBe(true);
    expect(grid.columns.map((c) => c.ts)).toEqual([T - 1000, T]);
    expect(grid.columnMs).toBe(1000);
    expect(grid.deepColumns.map((c) => c.ts)).toEqual([T - 20_000, T - 10_000]);
    expect(grid.deepColumnMs).toBe(10_000);
    expect(grid.spanMs).toBe(21_000);
    expect(grid.deepIndexAtOrAfter(T - 15_000)).toBe(1);
    // Live: a fine delta and a deep delta, each on its own chain.
    expect(grid.apply(frame({ ts: T + 1000, seq: 3, reset: false, column_ms: 1000, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(true);
    expect(grid.apply(frame({ ts: T, seq: 3, reset: false, column_ms: 10_000, columns: [{ ts: T, lo: 100, hi: 104, bid: [[0, 5]], ask: [] }] }))).toBe(true);
    expect(grid.deepColumns).toHaveLength(3);
    expect(Array.from(grid.deepColumns[2].bid)).toEqual([5, 0, 3, 0, 0]); // carried forward from the previous deep column
    // A deep gap unsyncs the deep tier only; a fine reset keeps the deep tier.
    expect(grid.apply(frame({ ts: T + 20_000, seq: 9, reset: false, column_ms: 10_000, columns: [{ ts: T + 20_000, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(false);
    expect(grid.synced).toBe(true);
    expect(grid.rejected).toBe(1);
    expect(grid.apply(frame({ ts: T + 2000, seq: 1, column_ms: 1000, columns: [{ ...full, ts: T + 2000 }] }))).toBe(true);
    expect(grid.columns).toHaveLength(1);
    expect(grid.deepColumns).toHaveLength(3);
    // A reset with another row width drops every tier's columns.
    expect(grid.apply(frame({ ts: T + 3000, seq: 1, row_width: 4, column_ms: 1000, columns: [{ ...full, ts: T + 3000 }] }))).toBe(true);
    expect(grid.deepColumns).toHaveLength(0);
    expect(grid.apply(frame({ ts: T + 10_000, seq: 4, reset: false, row_width: 4, column_ms: 10_000, columns: [{ ts: T + 10_000, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(false);
  });

  it("keeps a coarse tier on rows of its own behind the deep one: its own chain, row width and yardstick, untouched by a fine reset that clears the deep tier", () => {
    const grid = new LiquidityGrid();
    // The coarse tier arrives first (5 min columns, rows twice as tall), then the deep one, then the fine one.
    expect(grid.apply(frame({ ts: T - 300_000, seq: 2, column_ms: 300_000, row_width: 4, columns: [{ ts: T - 600_000, lo: 50, hi: 52, bid: [[0, 6]], ask: [[2, 8]] }, { ts: T - 300_000, lo: 50, hi: 52, bid: [[0, 7]], ask: [] }] }))).toBe(true);
    expect(grid.coarseColumns).toHaveLength(0); // the only tier so far is "the" columns
    expect(grid.apply(frame({ seq: 1, columns: [full] }))).toBe(true);
    // Fine and coarse, no deep: the coarse tier is not mistaken for the deep one.
    expect([grid.deepColumns.length, grid.coarseColumns.length, grid.deepColumnMs]).toEqual([0, 2, 0]);
    expect(grid.apply(frame({ ts: T - 10_000, seq: 1, column_ms: 10_000, columns: [{ ...full, ts: T - 10_000 }] }))).toBe(true);
    expect([grid.columnMs, grid.deepColumnMs, grid.coarseColumnMs]).toEqual([1000, 10_000, 300_000]);
    expect([grid.rowWidth, grid.coarseRowWidth]).toEqual([2, 4]);
    expect(grid.coarseColumns.map((c) => c.ts)).toEqual([T - 600_000, T - 300_000]);
    expect(Array.from(grid.coarseColumns[1].bid)).toEqual([7, 0, 0]);
    expect(grid.coarseIndexAtOrAfter(T - 400_000)).toBe(1);
    expect(grid.spanMs).toBe(601_000);
    // Each tier's yardstick is its own: the coarse tier's p95 over its rows, the fine tier's over its.
    expect(grid.coarseColumns[0].reference).toBe(8);
    expect(grid.columns[0].reference).toBe(4);
    // A coarse delta chains on the coarse seq and must keep the coarse row width.
    expect(grid.apply(frame({ ts: T, seq: 3, reset: false, column_ms: 300_000, row_width: 4, columns: [{ ts: T, lo: 50, hi: 52, bid: [[1, 9]], ask: [] }] }))).toBe(true);
    expect(grid.apply(frame({ ts: T + 300_000, seq: 4, reset: false, column_ms: 300_000, row_width: 2, columns: [{ ts: T + 300_000, lo: 50, hi: 52, bid: [], ask: [] }] }))).toBe(false);
    expect(grid.coarseColumns).toHaveLength(3);
    // The fine tier resets on new rows: the deep tier shared them and goes; the coarse tier keeps its own.
    expect(grid.apply(frame({ ts: T + 1000, seq: 1, row_width: 8, columns: [{ ...full, ts: T + 1000 }] }))).toBe(true);
    expect(grid.rowWidth).toBe(8);
    expect(grid.deepColumns).toHaveLength(0);
    expect(grid.coarseColumns).toHaveLength(3);
    expect(grid.coarseRowWidth).toBe(4);
    // The old deep chain is gone, not merely hidden: a delta on it is refused until its own reset.
    expect(grid.apply(frame({ ts: T, seq: 2, reset: false, column_ms: 10_000, row_width: 2, columns: [{ ts: T, lo: 100, hi: 104, bid: [], ask: [] }] }))).toBe(false);
    // Fine and deep, no coarse: the deep tier is not mistaken for a coarse one.
    const two = new LiquidityGrid();
    two.apply(frame({ ts: T - 10_000, seq: 1, column_ms: 10_000, columns: [{ ...full, ts: T - 10_000 }] }));
    two.apply(frame({ seq: 1, columns: [full] }));
    expect([two.deepColumns.length, two.coarseColumns.length, two.coarseRowWidth]).toEqual([1, 0, 0]);
  });

  it("rows that change and change back do not bring back the deep columns the first change threw away", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ ts: T - 10_000, seq: 1, column_ms: 10_000, columns: [{ ...full, ts: T - 10_000 }] }));
    grid.apply(frame({ seq: 1, columns: [full] }));
    expect(grid.deepColumns).toHaveLength(1);
    expect(grid.apply(frame({ ts: T + 1_000, seq: 1, row_width: 8, columns: [{ ...full, ts: T + 1_000 }] }))).toBe(true);
    expect(grid.apply(frame({ ts: T + 2_000, seq: 1, row_width: 2, columns: [{ ...full, ts: T + 2_000 }] }))).toBe(true);
    expect(grid.rowWidth).toBe(2);
    expect(grid.deepColumns).toHaveLength(0);
  });

  it("keeps at most `coarseCapacity` coarse columns", () => {
    const grid = new LiquidityGrid(10, 10, 2);
    grid.apply(frame({ seq: 1, columns: [full] }));
    grid.apply(frame({ ts: T, seq: 3, column_ms: 300_000, row_width: 4, columns: [{ ts: T - 600_000, lo: 50, hi: 52, bid: [], ask: [] }, { ts: T - 300_000, lo: 50, hi: 52, bid: [], ask: [] }, { ts: T, lo: 50, hi: 52, bid: [], ask: [] }] }));
    expect(grid.coarseColumns.map((c) => c.ts)).toEqual([T - 300_000, T]);
    expect(() => new LiquidityGrid(10, 10, 0)).toThrow(/coarseCapacity/);
  });

  it("refuses columns that go back in time", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    expect(grid.apply(frame({ ts: T, seq: 2, reset: false, columns: [{ ...full, ts: T }] }))).toBe(false);
  });
});

describe("the reference travels with the column", () => {
  it("is fixed at print time and never re-judged by later columns", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [full] })); // p95 4
    const before = grid.columns[0].reference;
    // A much thicker book arrives: the live reference climbs, the old column keeps its own.
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [[0, 40], [2, 40]], ask: [[3, 40]] }] }));
    expect(grid.referenceSize).toBeGreaterThan(before as number);
    expect(grid.columns[0].reference).toBe(before);
    expect(grid.columns[1].reference).toBe(grid.referenceSize);
  });

  it("the deep tier keeps its own running reference", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, column_ms: 10_000, columns: [{ ...full, ts: T - 20_000 }] }));
    grid.apply(frame({ seq: 1, reset: true, columns: [full] }));
    expect(grid.deepColumns[0].reference).toBe(4);
    expect(grid.columns[0].reference).toBe(4);
  });

  it("the ceiling follows the biggest row near the mid over half an hour, one column at a time, and a deep column counts for its ten seconds", () => {
    expect(LIQUIDITY_CEILING_ALPHA).toBeCloseTo(1 / 1800, 6);
    // Within one row of the mid (102) the cells are 3, 4 and 9: the biggest row is 9, the median 4, the 95th percentile 9.
    const wide = { ts: T, lo: 100, hi: 104, bid: [[1, 3], [2, 4]] as [number, number][], ask: [[3, 9]] as [number, number][] };
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [wide] }));
    expect(grid.columns[0].ceiling).toBe(9);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 100, hi: 104, bid: [[2, 400]], ask: [] }] }));
    // A 400 arrives: the ceiling moves a thirty-minute step towards it, the old column keeps its own.
    expect(grid.columns[1].ceiling).toBeCloseTo(9 + LIQUIDITY_CEILING_ALPHA * (400 - 9), 6);
    expect(grid.columns[0].ceiling).toBe(9);
    // Rows away from the mid never count: 9000 two rows below the mid is not seen, and the 400 keeps pulling.
    grid.apply(frame({ ts: T + 2000, seq: 3, reset: false, columns: [{ ts: T + 2000, lo: 100, hi: 104, bid: [[0, 9000]], ask: [] }] }));
    expect(grid.columns[2].ceiling).toBeCloseTo((grid.columns[1].ceiling as number) + LIQUIDITY_CEILING_ALPHA * (400 - (grid.columns[1].ceiling as number)), 6);
    const deep = new LiquidityGrid();
    deep.apply(frame({ seq: 1, reset: true, columns: [wide] }));
    deep.apply(frame({ seq: 1, reset: true, column_ms: 10_000, columns: [{ ...wide, ts: T - 20_000 }, { ts: T - 10_000, lo: 100, hi: 104, bid: [[2, 400]], ask: [] }] }));
    expect(deep.deepColumns[1].ceiling).toBeCloseTo(9 + (1 - (1 - LIQUIDITY_CEILING_ALPHA) ** 10) * (400 - 9), 6);
    // A column empty near the mid leaves the ceiling where it was; a reset starts it over.
    expect(deep.apply(frame({ ts: T, seq: 2, reset: false, column_ms: 10_000, columns: [{ ts: T, lo: 100, hi: 104, bid: [[1, 0], [2, 0]], ask: [[3, 0]] }] }))).toBe(true);
    expect(deep.deepColumns[2].ceiling).toBe(deep.deepColumns[1].ceiling);
    deep.apply(frame({ ts: T + 10_000, seq: 9, reset: true, column_ms: 10_000, columns: [{ ...wide, ts: T + 10_000 }] }));
    expect(deep.deepColumns[0].ceiling).toBe(9);
  });

  it("a ceiling starts from its column's biggest row near the mid but never above ten times that column's 95th percentile, so one spike after a reset cannot fade every wall for an hour; later columns move it as before, on both tiers", () => {
    expect(LIQUIDITY_CEILING_SEED_CAP).toBe(10);
    // Rows 10000..10040 at a width of 2 put every row within the measured span: 37 rows of 10, three of 20 and one spike at the mid, so the 95th percentile (20) is not the median (10).
    const sizes = (spike: number) => ({ bid: [...Array.from({ length: 20 }, (_, i) => [i, 10] as [number, number]), [20, spike] as [number, number]], ask: Array.from({ length: 20 }, (_, i) => [21 + i, i < 3 ? 20 : 10] as [number, number]) });
    const spiked = { ts: T, lo: 10_000, hi: 10_040, ...sizes(500) };
    const grid = new LiquidityGrid();
    grid.apply(frame({ seq: 1, reset: true, columns: [spiked] }));
    expect(grid.columns[0].reference).toBe(20);
    expect(grid.columns[0].median).toBe(10);
    expect(grid.columns[0].ceiling).toBe(LIQUIDITY_CEILING_SEED_CAP * 20);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 10_000, hi: 10_040, bid: [], ask: [] }] }));
    expect(grid.columns[1].ceiling).toBeCloseTo(200 + LIQUIDITY_CEILING_ALPHA * (500 - 200), 6);
    grid.apply(frame({ ts: T + 2000, seq: 9, reset: true, columns: [{ ...spiked, ts: T + 2000 }] }));
    expect(grid.columns[0].ceiling).toBe(200);
    const quiet = new LiquidityGrid();
    quiet.apply(frame({ seq: 1, reset: true, columns: [{ ...spiked, ...sizes(60) }] }));
    expect(quiet.columns[0].ceiling).toBe(60);
    const deep = new LiquidityGrid();
    deep.apply(frame({ seq: 1, reset: true, columns: [{ ...spiked, ...sizes(60) }] }));
    deep.apply(frame({ seq: 1, reset: true, column_ms: 10_000, columns: [{ ...spiked, ts: T - 10_000 }] }));
    expect(deep.deepColumns[0].ceiling).toBe(200);
    expect(deep.columns[0].ceiling).toBe(60);
  });
});

describe("bandMaxSizes", () => {
  it("reads a band by its biggest bid and ask row, where bandSizes sums them", () => {
    const column = { ts: T, lo: 100, hi: 105, bid: Float64Array.from([1, 4, 2, 0, 0, 0]), ask: Float64Array.from([0, 0, 0, 3, 3, 9]) };
    expect(bandMaxSizes(column, 50, 2)).toEqual({ bid: 4, ask: 0 }); // rows 100..101
    expect(bandMaxSizes(column, 51, 2)).toEqual({ bid: 2, ask: 3 }); // rows 102..103
    expect(bandMaxSizes(column, 52, 2)).toEqual({ bid: 0, ask: 9 }); // rows 104..105
    expect(bandMaxSizes(column, 25, 4)).toEqual({ bid: 4, ask: 3 }); // rows 100..103
    expect(bandMaxSizes(column, 60, 2)).toEqual({ bid: 0, ask: 0 }); // outside the window
  });
});
