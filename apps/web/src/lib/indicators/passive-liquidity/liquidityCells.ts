import { liquidityIndexAtOrAfter, type LiquidityColumn, type LiquidityGrid } from "./liquidityGrid";
import { HOLE_BRIDGE_MS, LEDGER_MATCH_MS, MAX_DIP_MS, type RunClocks } from "./liquidityRuns";
import { bandFactorFor } from "./liquiditySettings";

export const CELLS_PER_BAR = 8;

export function cellMsFor(intervalMs: number): number {
  return bandFactorFor(intervalMs) > 1 ? Math.round(intervalMs / CELLS_PER_BAR) : 0;
}

export function runClocksFor(intervalMs: number): RunClocks {
  const cellMs = cellMsFor(intervalMs);
  if (cellMs === 0) return { dipMs: MAX_DIP_MS, holeMs: HOLE_BRIDGE_MS, matchMs: LEDGER_MATCH_MS, minRunMs: 0 };
  return { dipMs: 0, holeMs: cellMs, matchMs: Math.max(LEDGER_MATCH_MS, cellMs), minRunMs: intervalMs };
}

function foldInto(cell: LiquidityColumn, column: LiquidityColumn): LiquidityColumn {
  const lo = Math.min(cell.lo, column.lo);
  const hi = Math.max(cell.hi, column.hi);
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (let row = cell.lo; row <= cell.hi; row += 1) {
    bid[row - lo] = cell.bid[row - cell.lo];
    ask[row - lo] = cell.ask[row - cell.lo];
  }
  for (let row = column.lo; row <= column.hi; row += 1) {
    bid[row - lo] = Math.max(bid[row - lo], column.bid[row - column.lo]);
    ask[row - lo] = Math.max(ask[row - lo], column.ask[row - column.lo]);
  }
  const folded: LiquidityColumn = { ts: cell.ts, lo, hi, bid, ask };
  const reference = Math.max(cell.reference ?? 0, column.reference ?? 0);
  if (reference > 0) folded.reference = reference;
  const median = Math.max(cell.median ?? 0, column.median ?? 0);
  if (median > 0) folded.median = median;
  const ceiling = Math.max(cell.ceiling ?? 0, column.ceiling ?? 0);
  if (ceiling > 0) folded.ceiling = ceiling;
  return folded;
}

function foldGroup(columns: readonly LiquidityColumn[], from: number, to: number, ts: number): LiquidityColumn {
  let lo = columns[from].lo;
  let hi = columns[from].hi;
  for (let i = from + 1; i < to; i += 1) {
    if (columns[i].lo < lo) lo = columns[i].lo;
    if (columns[i].hi > hi) hi = columns[i].hi;
  }
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  let reference = 0;
  let median = 0;
  let ceiling = 0;
  for (let i = from; i < to; i += 1) {
    const column = columns[i];
    const offset = column.lo - lo;
    const rows = column.hi - column.lo + 1;
    for (let row = 0; row < rows; row += 1) {
      if (column.bid[row] > bid[offset + row]) bid[offset + row] = column.bid[row];
      if (column.ask[row] > ask[offset + row]) ask[offset + row] = column.ask[row];
    }
    if (column.reference !== undefined && column.reference > reference) reference = column.reference;
    if (column.median !== undefined && column.median > median) median = column.median;
    if (column.ceiling !== undefined && column.ceiling > ceiling) ceiling = column.ceiling;
  }
  const cell: LiquidityColumn = { ts, lo, hi, bid, ask };
  if (reference > 0) cell.reference = reference;
  if (median > 0) cell.median = median;
  if (ceiling > 0) cell.ceiling = ceiling;
  return cell;
}

export function foldColumns(columns: readonly LiquidityColumn[], cellMs: number): LiquidityColumn[] {
  const cells: LiquidityColumn[] = [];
  let from = 0;
  while (from < columns.length) {
    const ts = Math.floor(columns[from].ts / cellMs) * cellMs;
    let to = from + 1;
    while (to < columns.length && columns[to].ts < ts + cellMs) to += 1;
    cells.push(foldGroup(columns, from, to, ts));
    from = to;
  }
  return cells;
}

function edgesOf(columns: readonly LiquidityColumn[]): string {
  return `${columns.length}:${columns.length > 0 ? columns[0].ts : ""}:${columns.length > 0 ? columns[columns.length - 1].ts : ""}`;
}

export class FoldedCells {
  private _cellMs = 0;
  private _epoch = -1;
  private _source = "";
  private _edges = "";
  private _cells: LiquidityColumn[] = [];

  get columns(): readonly LiquidityColumn[] {
    return this._cells;
  }

  update(grid: Pick<LiquidityGrid, "columns" | "deepColumns" | "epoch">, cellMs: number, source = ""): readonly LiquidityColumn[] {
    const edges = `${edgesOf(grid.deepColumns)}|${edgesOf(grid.columns)}`;
    if (cellMs === this._cellMs && grid.epoch === this._epoch && source === this._source && edges === this._edges) return this._cells;
    this._edges = edges;
    if (cellMs !== this._cellMs || grid.epoch !== this._epoch || source !== this._source) {
      this._cellMs = cellMs;
      this._epoch = grid.epoch;
      this._source = source;
      this._cells = [];
    }
    const fine = grid.columns;
    const fineStart = fine.length > 0 ? fine[0].ts : Infinity;
    const deep = grid.deepColumns;
    const oldest = Math.min(deep.length > 0 ? deep[0].ts : Infinity, fineStart);
    if (this._cells.length > 0 && this._cells[0].ts + cellMs <= oldest) {
      const keepFrom = liquidityIndexAtOrAfter(this._cells, oldest - cellMs + 1);
      if (keepFrom > 0) this._cells.splice(0, keepFrom);
    }
    const last = this._cells[this._cells.length - 1];
    const from = last === undefined ? -Infinity : last.ts;
    if (last !== undefined) this._cells.pop();
    const fresh: LiquidityColumn[] = [];
    for (let i = liquidityIndexAtOrAfter(deep, from); i < deep.length && deep[i].ts < fineStart; i += 1) fresh.push(deep[i]);
    for (let i = liquidityIndexAtOrAfter(fine, from); i < fine.length; i += 1) fresh.push(fine[i]);
    for (const cell of foldColumns(fresh, cellMs)) {
      const tail = this._cells[this._cells.length - 1];
      if (tail !== undefined && tail.ts === cell.ts) this._cells[this._cells.length - 1] = foldInto(tail, cell);
      else this._cells.push(cell);
    }
    return this._cells;
  }
}
