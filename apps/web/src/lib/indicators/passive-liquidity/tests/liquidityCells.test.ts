import { describe, expect, it } from "vitest";
import { CELLS_PER_BAR, FoldedCells, cellMsFor, foldColumns, runClocksFor } from "../liquidityCells";
import type { LiquidityColumn } from "../liquidityGrid";
import { HOLE_BRIDGE_MS, LEDGER_MATCH_MS, MAX_DIP_MS } from "../liquidityRuns";

const T = 1_700_000_000_000;
const MIN = 60_000;

function column(ts: number, lo: number, bid: number[], ask: number[] = bid.map(() => 0), extra: Partial<LiquidityColumn> = {}): LiquidityColumn {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask), ...extra };
}

const plain = (cell: LiquidityColumn) => ({ ts: cell.ts, lo: cell.lo, hi: cell.hi, bid: [...cell.bid], ask: [...cell.ask], reference: cell.reference, median: cell.median, ceiling: cell.ceiling });

describe("cellMsFor", () => {
  it("folds nothing under 15m and an eighth of the bar from there, so a bar is eight cells on every slow chart", () => {
    expect([1, 5, 14].map((m) => cellMsFor(m * MIN))).toEqual([0, 0, 0]);
    expect(cellMsFor(15 * MIN)).toBe((15 * MIN) / CELLS_PER_BAR);
    expect(cellMsFor(60 * MIN)).toBe((60 * MIN) / CELLS_PER_BAR);
    expect(cellMsFor(240 * MIN)).toBe(30 * MIN);
    expect(CELLS_PER_BAR).toBe(8);
  });
});

describe("runClocksFor", () => {
  it("keeps the second-based clocks on a chart that is not folded; on one that is, a dip lasts the cell it began in, a hole one cell, a run one bar", () => {
    expect(runClocksFor(MIN)).toEqual({ dipMs: MAX_DIP_MS, holeMs: HOLE_BRIDGE_MS, matchMs: LEDGER_MATCH_MS, minRunMs: 0 });
    const cell = cellMsFor(15 * MIN);
    expect(runClocksFor(15 * MIN)).toEqual({ dipMs: 0, holeMs: cell, matchMs: Math.max(LEDGER_MATCH_MS, cell), minRunMs: 15 * MIN });
    expect(runClocksFor(4 * 60 * MIN).matchMs).toBe(30 * MIN);
  });
});

describe("foldColumns", () => {
  it("takes the biggest size each row held in the cell, each side apart, over the union of the rows, and the biggest yardstick, on cell boundaries", () => {
    const cells = foldColumns(
      [
        column(T + 1_000, 10, [1, 5, 0], [0, 0, 2], { reference: 4, median: 2, ceiling: 50 }),
        column(T + 4_000, 11, [2, 3], [7, 0], { reference: 6, median: 1, ceiling: 30 }),
        column(T + 10_000, 10, [9, 0, 0]),
        column(T + 19_999, 12, [4]),
      ],
      10_000,
    );
    expect(cells.map(plain)).toEqual([
      { ts: T, lo: 10, hi: 12, bid: [1, 5, 3], ask: [0, 7, 2], reference: 6, median: 2, ceiling: 50 },
      { ts: T + 10_000, lo: 10, hi: 12, bid: [9, 0, 4], ask: [0, 0, 0], reference: undefined, median: undefined, ceiling: undefined },
    ]);
  });

  it("leaves a cell out where there were no columns, so a hole stays a hole", () => {
    expect(foldColumns([column(T, 0, [1]), column(T + 30_000, 0, [2])], 10_000).map((cell) => cell.ts)).toEqual([T, T + 30_000]);
  });
});

describe("FoldedCells", () => {
  function gridOf(deep: LiquidityColumn[], fine: LiquidityColumn[], epoch = 1) {
    return { deepColumns: deep, columns: fine, epoch };
  }
  const deepAt = (s: number, size: number) => column(T + s * 1_000, 0, [size]);
  const fineAt = (s: number, size: number) => column(T + s * 1_000, 0, [size]);

  it("folds the deep tier up to where the fine one begins and the fine tier from there, and grows a column at a time to the same result as one fold", () => {
    const deep = [deepAt(0, 1), deepAt(10, 2), deepAt(20, 3), deepAt(30, 4), deepAt(40, 5)];
    const fine = [fineAt(35, 9), fineAt(36, 1), fineAt(37, 1)];
    const folded = new FoldedCells();
    expect(folded.update(gridOf(deep, fine), 20_000).map(plain)).toEqual(foldColumns([deep[0], deep[1], deep[2], deep[3], ...fine], 20_000).map(plain));
    fine.push(fineAt(38, 7), fineAt(41, 2));
    const grown = folded.update(gridOf(deep, fine), 20_000);
    expect(grown.map(plain)).toEqual(foldColumns([deep[0], deep[1], deep[2], deep[3], ...fine], 20_000).map(plain));
    expect(grown.map((cell) => [cell.ts, cell.bid[0]])).toEqual([[T, 2], [T + 20_000, 9], [T + 40_000, 2]]);
  });

  it("carries the biggest ceiling of a cell's columns, the cell grown a column at a time ending as one fold of them", () => {
    const withCeiling = (s: number, size: number, ceiling: number) => column(T + s * 1_000, 0, [size], [0], { reference: 2, median: 1, ceiling });
    const deep = [withCeiling(0, 1, 30), withCeiling(10, 2, 80)];
    const fine = [withCeiling(15, 3, 50)];
    const folded = new FoldedCells();
    expect(folded.update(gridOf(deep, fine), 20_000).map((cell) => cell.ceiling)).toEqual([80]);
    fine.push(withCeiling(16, 1, 120));
    expect(folded.update(gridOf(deep, fine), 20_000).map((cell) => cell.ceiling)).toEqual([120]);
    fine.push(withCeiling(17, 1, 40));
    const grown = folded.update(gridOf(deep, fine), 20_000);
    expect(grown.map((cell) => cell.ceiling)).toEqual([120]);
    expect(grown.map(plain)).toEqual(foldColumns([...deep, ...fine], 20_000).map(plain));
  });

  it("starts over when a tier resets or the cell width changes, and drops the cells the grid no longer reaches", () => {
    const folded = new FoldedCells();
    const fine = [fineAt(0, 1), fineAt(10, 2), fineAt(20, 3)];
    folded.update(gridOf([], fine), 10_000);
    expect(folded.columns.map((cell) => cell.bid[0])).toEqual([1, 2, 3]);
    expect(folded.update(gridOf([], fine), 20_000).map((cell) => [cell.ts, cell.bid[0]])).toEqual([[T, 2], [T + 20_000, 3]]);
    const replaced = [fineAt(20, 8), fineAt(50, 8)];
    expect(folded.update(gridOf([], replaced), 20_000).map((cell) => cell.bid[0])).toEqual([8, 8]);
    replaced[0] = fineAt(20, 1);
    expect(folded.update(gridOf([], replaced), 20_000).map((cell) => cell.bid[0])).toEqual([8, 8]);
    expect(folded.update(gridOf([], replaced, 2), 20_000).map((cell) => cell.bid[0])).toEqual([1, 8]);
    const trimmed = [fineAt(45, 4)];
    expect(folded.update(gridOf([], trimmed, 2), 20_000).map((cell) => [cell.ts, cell.bid[0]])).toEqual([[T + 40_000, 4]]);
    // Another source of columns at the same width and epoch is folded afresh, not appended to: its older columns are read too.
    expect(folded.update(gridOf([], [fineAt(5, 9), fineAt(45, 6)], 2), 20_000, "coarse").map((cell) => cell.bid[0])).toEqual([9, 6]);
    expect(folded.update(gridOf([], [fineAt(5, 9), fineAt(45, 6)], 2), 20_000, "coarse").map((cell) => cell.bid[0])).toEqual([9, 6]);
  });

  it("does not hand one source's cells to another whose columns have the same edges but other sizes", () => {
    const folded = new FoldedCells();
    expect(folded.update(gridOf([], [fineAt(0, 1), fineAt(10, 2)], 3), 20_000).map((cell) => cell.bid[0])).toEqual([2]);
    expect(folded.update(gridOf([], [fineAt(0, 7), fineAt(10, 8)], 3), 20_000, "coarse").map((cell) => cell.bid[0])).toEqual([8]);
  });

  it("hands back the same cells while nothing it reads has changed, and folds again when a column is added, trimmed, swapped at the tail or arrives in the deep tier", () => {
    const folded = new FoldedCells();
    const fine = [fineAt(0, 1), fineAt(10, 2), fineAt(20, 3)];
    const first = folded.update(gridOf([], fine), 20_000);
    const tail = first[first.length - 1];
    const again = folded.update(gridOf([], fine), 20_000);
    expect(again[again.length - 1]).toBe(tail);
    fine.push(fineAt(30, 4));
    const added = folded.update(gridOf([], fine), 20_000);
    expect(added[added.length - 1]).not.toBe(tail);
    expect(added.map((cell) => cell.bid[0])).toEqual([2, 4]);
    const addedTail = added[added.length - 1];
    const unchanged = folded.update(gridOf([], fine), 20_000);
    expect(unchanged[unchanged.length - 1]).toBe(addedTail);
    fine.shift();
    expect(folded.update(gridOf([], fine), 20_000).map(plain)).toEqual(foldColumns(fine, 20_000).map(plain));
    fine.pop();
    fine.push(fineAt(35, 7));
    expect(folded.update(gridOf([], fine), 20_000).map(plain)).toEqual(foldColumns(fine, 20_000).map(plain));
    const deepOnly = new FoldedCells();
    const deep = [deepAt(0, 1)];
    expect(deepOnly.update(gridOf(deep, []), 20_000).map((cell) => cell.bid[0])).toEqual([1]);
    deep.push(deepAt(25, 6));
    expect(deepOnly.update(gridOf(deep, []), 20_000).map((cell) => cell.bid[0])).toEqual([1, 6]);
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function oldFoldInto(cell: LiquidityColumn, next: LiquidityColumn): LiquidityColumn {
  const lo = Math.min(cell.lo, next.lo);
  const hi = Math.max(cell.hi, next.hi);
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (let row = cell.lo; row <= cell.hi; row += 1) {
    bid[row - lo] = cell.bid[row - cell.lo];
    ask[row - lo] = cell.ask[row - cell.lo];
  }
  for (let row = next.lo; row <= next.hi; row += 1) {
    bid[row - lo] = Math.max(bid[row - lo], next.bid[row - next.lo]);
    ask[row - lo] = Math.max(ask[row - lo], next.ask[row - next.lo]);
  }
  const folded: LiquidityColumn = { ts: cell.ts, lo, hi, bid, ask };
  const reference = Math.max(cell.reference ?? 0, next.reference ?? 0);
  if (reference > 0) folded.reference = reference;
  const median = Math.max(cell.median ?? 0, next.median ?? 0);
  if (median > 0) folded.median = median;
  const ceiling = Math.max(cell.ceiling ?? 0, next.ceiling ?? 0);
  if (ceiling > 0) folded.ceiling = ceiling;
  return folded;
}

function oldStartOf(source: LiquidityColumn, cellMs: number): LiquidityColumn {
  const ts = Math.floor(source.ts / cellMs) * cellMs;
  const cell: LiquidityColumn = { ts, lo: source.lo, hi: source.hi, bid: Float64Array.from(source.bid), ask: Float64Array.from(source.ask) };
  if (source.reference !== undefined && source.reference > 0) cell.reference = source.reference;
  if (source.median !== undefined && source.median > 0) cell.median = source.median;
  if (source.ceiling !== undefined && source.ceiling > 0) cell.ceiling = source.ceiling;
  return cell;
}

function oldFoldColumns(columns: readonly LiquidityColumn[], cellMs: number): LiquidityColumn[] {
  const cells: LiquidityColumn[] = [];
  for (const source of columns) {
    const last = cells[cells.length - 1];
    if (last !== undefined && source.ts < last.ts + cellMs) cells[cells.length - 1] = oldFoldInto(last, source);
    else cells.push(oldStartOf(source, cellMs));
  }
  return cells;
}

describe("foldColumns against the one-column-at-a-time fold it replaced", () => {
  function randomColumns(random: () => number): LiquidityColumn[] {
    let ts = T;
    return Array.from({ length: 400 }, () => {
      ts += 400 + Math.floor(random() * 1_800);
      const lo = 100 + Math.floor(random() * 40);
      const rows = 20 + Math.floor(random() * 40);
      const sizes = () => Array.from({ length: rows }, () => (random() < 0.3 ? 0 : Math.round(random() * 500) / 10));
      const reference = random() < 0.5 ? Math.round(random() * 100) / 10 : undefined;
      const median = random() < 0.5 ? Math.round(random() * 100) / 10 : undefined;
      const ceiling = random() < 0.5 ? Math.round(random() * 1_000) / 10 : undefined;
      return column(ts, lo, sizes(), sizes(), { ...(reference === undefined ? {} : { reference }), ...(median === undefined ? {} : { median }), ...(ceiling === undefined ? {} : { ceiling }) });
    });
  }

  it("gives the same cells for random columns of different row ranges, with and without yardsticks, at several cell widths", () => {
    const random = seeded(17);
    for (const columns of [randomColumns(random), randomColumns(random)]) {
      for (const cellMs of [3_000, 10_000, 112_500, 450_000]) {
        expect(foldColumns(columns, cellMs).map(plain)).toEqual(oldFoldColumns(columns, cellMs).map(plain));
      }
    }
  });

  it("leaves the columns it folds as they were and gives each cell arrays of its own", () => {
    const columns = randomColumns(seeded(3)).slice(0, 60);
    const copy = columns.map((source) => ({ ...source, bid: Float64Array.from(source.bid), ask: Float64Array.from(source.ask) }));
    const cells = foldColumns(columns, 10_000);
    expect(columns.map(plain)).toEqual(copy.map(plain));
    for (const cell of cells) for (const source of columns) {
      expect(cell.bid).not.toBe(source.bid);
      expect(cell.ask).not.toBe(source.ask);
    }
  });

  it("returns nothing for no columns and one cell per column when each is alone in its cell", () => {
    expect(foldColumns([], 10_000)).toEqual([]);
    const columns = [column(T, 5, [3, 1]), column(T + 10_000, 5, [2, 9])];
    expect(foldColumns(columns, 10_000).map(plain)).toEqual(oldFoldColumns(columns, 10_000).map(plain));
  });
});
