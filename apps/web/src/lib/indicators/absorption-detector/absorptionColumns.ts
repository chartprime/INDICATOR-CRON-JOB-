import { liquidityIndexAtOrAfter, type LiquidityColumn } from "../passive-liquidity/liquidityGrid";

export interface ColumnTier {
  columns: readonly LiquidityColumn[];
  columnMs: number;
}

export interface ColumnFeed {
  epoch: number;
  deep: ColumnTier | null;
  fine: ColumnTier;
  /** The book's live colour reference: the typical level a column without one of its own is read against. */
  reference?: number;
}

const midRows = new WeakMap<LiquidityColumn, number | null>();

export function columnMid(column: LiquidityColumn, rowWidth: number): number | null {
  let row = midRows.get(column);
  if (row === undefined) {
    let bidRow = -1;
    for (let i = column.bid.length - 1; i >= 0; i -= 1) {
      if (column.bid[i] > 0) {
        bidRow = column.lo + i;
        break;
      }
    }
    let askRow = -1;
    for (let i = 0; i < column.ask.length; i += 1) {
      if (column.ask[i] > 0) {
        askRow = column.lo + i;
        break;
      }
    }
    if (bidRow >= 0 && askRow >= 0) row = (bidRow + 1 + askRow) / 2;
    else if (bidRow >= 0) row = bidRow + 1;
    else if (askRow >= 0) row = askRow;
    else row = null;
    midRows.set(column, row);
  }
  return row === null ? null : row * rowWidth;
}

export function columnFlow(column: LiquidityColumn, side: "buy" | "sell", rowLo: number, rowHi: number): number {
  const entries = column[side];
  if (entries === undefined) return 0;
  let volume = 0;
  for (const [row, size] of entries) if (row >= rowLo && row <= rowHi) volume += size;
  return volume;
}

function deepLimit(feed: ColumnFeed): number {
  return feed.fine.columns.length > 0 ? feed.fine.columns[0].ts - feed.fine.columnMs : Infinity;
}

export function eachColumn(feed: ColumnFeed, fromTs: number, toTs: number, fn: (column: LiquidityColumn, columnMs: number) => boolean | void): boolean {
  if (feed.deep) {
    const limit = deepLimit(feed);
    const { columns, columnMs } = feed.deep;
    for (let i = liquidityIndexAtOrAfter(columns, fromTs); i < columns.length; i += 1) {
      const column = columns[i];
      if (column.ts > toTs || column.ts > limit) break;
      if (fn(column, columnMs)) return true;
    }
  }
  const { columns, columnMs } = feed.fine;
  for (let i = liquidityIndexAtOrAfter(columns, fromTs); i < columns.length; i += 1) {
    const column = columns[i];
    if (column.ts > toTs) break;
    if (fn(column, columnMs)) return true;
  }
  return false;
}

export function lastColumnAtOrBefore(feed: ColumnFeed, ts: number): LiquidityColumn | null {
  const fine = feed.fine.columns;
  const i = liquidityIndexAtOrAfter(fine, ts + 1) - 1;
  if (i >= 0) return fine[i];
  if (!feed.deep) return null;
  const deep = feed.deep.columns;
  const j = liquidityIndexAtOrAfter(deep, Math.min(ts, deepLimit(feed)) + 1) - 1;
  return j >= 0 ? deep[j] : null;
}

export function firstColumnAfter(feed: ColumnFeed, ts: number): LiquidityColumn | null {
  if (feed.deep) {
    const deep = feed.deep.columns;
    const j = liquidityIndexAtOrAfter(deep, ts + 1);
    if (j < deep.length && deep[j].ts <= deepLimit(feed)) return deep[j];
  }
  const fine = feed.fine.columns;
  const i = liquidityIndexAtOrAfter(fine, ts + 1);
  return i < fine.length ? fine[i] : null;
}

export function newestColumnTs(feed: ColumnFeed): number {
  const fine = feed.fine.columns;
  if (fine.length > 0) return fine[fine.length - 1].ts;
  const deep = feed.deep?.columns ?? [];
  return deep.length > 0 ? deep[deep.length - 1].ts : -Infinity;
}
