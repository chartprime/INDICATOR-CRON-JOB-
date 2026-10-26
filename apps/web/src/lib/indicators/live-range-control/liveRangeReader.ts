import type { LiquidityPrint } from "../../../types/frames";
import { liquidityIndexAtOrAfter, type LiquidityColumn } from "../passive-liquidity/liquidityGrid";

export interface RangeGrid {
  columns: readonly LiquidityColumn[];
  columnMs: number;
  deepColumns: readonly LiquidityColumn[];
  deepColumnMs: number;
  rowWidth: number;
}

export interface FlowSums {
  buys: number;
  sells: number;
}

export interface HostColumn {
  ts: number;
  rowWidth: number;
  buy: ReadonlyArray<readonly [row: number, volume: number]>;
  sell: ReadonlyArray<readonly [row: number, volume: number]>;
  prints: readonly LiquidityPrint[];
  printsFloor: number | null;
}

export interface LiveRangeRead extends FlowSums {
  fromTs: number;
  toTs: number;
  coveredMs: number;
  tradedMs: number;
  missing: readonly Gap[];
  noise: number;
  minutesWon: MinutesWon;
  impact: PriceImpact;
}

export interface MinutesWon {
  buyers: number;
  sellers: number;
}

export interface SideImpact {
  moved: number;
  volume: number;
}

export interface PriceImpact {
  buyers: SideImpact;
  sellers: SideImpact;
}

export interface ColumnSums extends FlowSums {
  rowVolume: number;
}

interface Minute {
  net: number;
  buys: number;
  sells: number;
  priceVolume: number;
}

interface Tally {
  minutes: Map<number, Minute>;
}

export const FINE_COLUMN_MS = 1_000;
export const NOISE_BUCKET_MS = 60_000;
export const HOST_COLUMN_MS = 10_000;
export const GAP_MIN_MS = 60_000;
export const IMPACT_MIN_SHARE = 0.1;

const sumsByColumn = new WeakMap<object, ColumnSums>();

export function spanOf(ts: number, columnMs: number): readonly [number, number] {
  return [ts - FINE_COLUMN_MS, ts - FINE_COLUMN_MS + columnMs];
}

export function seamOf(grid: Pick<RangeGrid, "columns" | "deepColumns" | "deepColumnMs">): number {
  const fine = grid.columns;
  if (fine.length === 0) return Number.POSITIVE_INFINITY;
  const start = fine[0].ts;
  const ms = grid.deepColumnMs;
  if (!(ms > 0) || grid.deepColumns.length === 0) return start;
  const seam = Math.ceil(start / ms) * ms;
  if (seam === start) return start;
  const i = liquidityIndexAtOrAfter(grid.deepColumns, seam - ms);
  return i < grid.deepColumns.length && grid.deepColumns[i].ts === seam - ms ? seam : start;
}

function sized(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function sumColumn(column: Pick<LiquidityColumn, "buy" | "sell">): ColumnSums {
  const kept = sumsByColumn.get(column);
  if (kept !== undefined) return kept;
  const sums: ColumnSums = { buys: 0, sells: 0, rowVolume: 0 };
  for (const [row, volume] of column.buy ?? []) {
    sums.buys += sized(volume);
    sums.rowVolume += row * sized(volume);
  }
  for (const [row, volume] of column.sell ?? []) {
    sums.sells += sized(volume);
    sums.rowVolume += row * sized(volume);
  }
  sumsByColumn.set(column, sums);
  return sums;
}

function readPart(
  read: LiveRangeRead,
  tally: Tally,
  columns: readonly LiquidityColumn[],
  columnMs: number,
  beforeTs: number,
  fromTs: number,
  rowWidth: number,
): void {
  if (!(columnMs > 0)) return;
  for (let i = liquidityIndexAtOrAfter(columns, Math.max(fromTs, read.fromTs - columnMs + FINE_COLUMN_MS)); i < columns.length; i += 1) {
    const column = columns[i];
    if (column.ts >= beforeTs) break;
    const [start, end] = spanOf(column.ts, columnMs);
    if (start >= read.toTs) break;
    const overlap = Math.min(end, read.toTs) - Math.max(start, read.fromTs);
    if (!(overlap > 0)) continue;
    const sums = sumColumn(column);
    const share = overlap / columnMs;
    read.buys += sums.buys * share;
    read.sells += sums.sells * share;
    addColumn(tally, start + columnMs / 2, sums, share, rowWidth);
    read.coveredMs += overlap;
  }
}

function addColumn(tally: Tally, atMs: number, sums: ColumnSums, share: number, rowWidth: number): void {
  const at = Math.floor(atMs / NOISE_BUCKET_MS);
  let minute = tally.minutes.get(at);
  if (minute === undefined) {
    minute = { net: 0, buys: 0, sells: 0, priceVolume: 0 };
    tally.minutes.set(at, minute);
  }
  minute.net += (sums.buys - sums.sells) * share;
  minute.buys += sums.buys * share;
  minute.sells += sums.sells * share;
  minute.priceVolume += sums.rowVolume * rowWidth * share;
}

function noiseOf(tally: Tally): number {
  let squares = 0;
  for (const minute of tally.minutes.values()) squares += minute.net * minute.net;
  return Math.sqrt(squares);
}

function minutesWonOf(tally: Tally): MinutesWon {
  const won: MinutesWon = { buyers: 0, sellers: 0 };
  for (const minute of tally.minutes.values()) {
    if (minute.net > 0) won.buyers += 1;
    else if (minute.net < 0) won.sellers += 1;
  }
  return won;
}

function impactOf(tally: Tally): PriceImpact {
  const impact: PriceImpact = { buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } };
  const minutes = [...tally.minutes.entries()].filter(([, minute]) => minute.buys + minute.sells > 0).sort((a, b) => a[0] - b[0]);
  if (minutes.length === 0) return impact;
  let total = 0;
  for (const [, minute] of minutes) total += minute.buys + minute.sells;
  const floor = (IMPACT_MIN_SHARE * total) / minutes.length;
  let previous: number | null = null;
  for (const [, minute] of minutes) {
    const volume = minute.buys + minute.sells;
    if (volume < floor) continue;
    const price = minute.priceVolume / volume;
    if (previous !== null) {
      if (minute.net > 0) {
        impact.buyers.moved += price - previous;
        impact.buyers.volume += minute.buys;
      } else if (minute.net < 0) {
        impact.sellers.moved += previous - price;
        impact.sellers.volume += minute.sells;
      }
    }
    previous = price;
  }
  return impact;
}

export type Gap = readonly [number, number];

export function gridGaps(grid: RangeGrid | null, fromTs: number, toTs: number): Gap[] {
  const gaps: Gap[] = [];
  const add = (start: number, end: number): void => {
    if (end - start >= GAP_MIN_MS) gaps.push([start, end]);
  };
  if (!(toTs > fromTs)) return gaps;
  if (grid === null || grid.columnMs !== FINE_COLUMN_MS || (grid.columns.length === 0 && grid.deepColumns.length === 0)) {
    add(fromTs, toTs);
    return gaps;
  }
  const fine = grid.columns;
  const newestEnd = fine.length > 0 ? spanOf(fine[fine.length - 1].ts, FINE_COLUMN_MS)[1] : spanOf(grid.deepColumns[grid.deepColumns.length - 1].ts, grid.deepColumnMs)[1];
  const limit = Math.min(toTs, newestEnd);
  let cursor = fromTs;
  const walk = (columns: readonly LiquidityColumn[], columnMs: number, beforeTs: number, afterTs: number): void => {
    if (!(columnMs > 0)) return;
    for (let i = liquidityIndexAtOrAfter(columns, Math.max(afterTs, fromTs - columnMs + FINE_COLUMN_MS)); i < columns.length; i += 1) {
      const column = columns[i];
      if (column.ts >= beforeTs) break;
      const [start, end] = spanOf(column.ts, columnMs);
      if (start >= limit) break;
      if (end <= cursor) continue;
      if (start > cursor) add(cursor, start);
      cursor = end;
    }
  };
  const seam = seamOf(grid);
  walk(grid.deepColumns, grid.deepColumnMs, seam, Number.NEGATIVE_INFINITY);
  walk(fine, FINE_COLUMN_MS, Number.POSITIVE_INFINITY, seam);
  if (cursor < limit) add(cursor, limit);
  return gaps;
}

function readHostColumns(read: LiveRangeRead, tally: Tally, columns: readonly HostColumn[], rowWidth: number | null, gaps: readonly Gap[]): void {
  let g = 0;
  for (const column of columns) {
    if (!(column.rowWidth > 0) || (rowWidth !== null && column.rowWidth !== rowWidth)) continue;
    const [start, end] = spanOf(column.ts, HOST_COLUMN_MS);
    while (g < gaps.length && gaps[g][1] <= start) g += 1;
    if (g === gaps.length) break;
    const overlap = Math.min(end, gaps[g][1]) - Math.max(start, gaps[g][0]);
    if (!(overlap > 0)) continue;
    const sums = sumColumn(column);
    const share = overlap / HOST_COLUMN_MS;
    read.buys += sums.buys * share;
    read.sells += sums.sells * share;
    addColumn(tally, start + HOST_COLUMN_MS / 2, sums, share, column.rowWidth);
    read.coveredMs += overlap;
  }
}

function hostSpans(columns: readonly HostColumn[], rowWidth: number): Gap[] {
  const spans: Gap[] = [];
  for (const column of columns) if (column.rowWidth === rowWidth) spans.push(spanOf(column.ts, HOST_COLUMN_MS));
  return spans;
}

function without(gaps: readonly Gap[], covered: readonly Gap[]): Gap[] {
  const out: Gap[] = [];
  let c = 0;
  for (const [start, end] of gaps) {
    let cursor = start;
    while (c < covered.length && covered[c][1] <= cursor) c += 1;
    for (let i = c; i < covered.length && covered[i][0] < end; i += 1) {
      if (covered[i][0] > cursor) out.push([cursor, covered[i][0]]);
      cursor = Math.max(cursor, covered[i][1]);
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}

function within(spans: readonly Gap[], bounds: readonly Gap[]): Gap[] {
  const out: Gap[] = [];
  let i = 0;
  let j = 0;
  while (i < spans.length && j < bounds.length) {
    const start = Math.max(spans[i][0], bounds[j][0]);
    const end = Math.min(spans[i][1], bounds[j][1]);
    if (end > start) out.push([start, end]);
    if (spans[i][1] < bounds[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

function holdsColumns(grid: RangeGrid | null): grid is RangeGrid {
  return grid !== null && grid.columnMs === FINE_COLUMN_MS && (grid.columns.length > 0 || grid.deepColumns.length > 0);
}

export function readLiveRange(grid: RangeGrid | null, fromTs: number, toTs: number, hostColumns: readonly HostColumn[] = [], traded: readonly Gap[] | null = null): LiveRangeRead {
  const from = fromTs;
  const read: LiveRangeRead = { buys: 0, sells: 0, fromTs: from, toTs, coveredMs: 0, tradedMs: 0, missing: [], noise: 0, minutesWon: { buyers: 0, sellers: 0 }, impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } } };
  if (!(toTs > from)) return read;
  const tally: Tally = { minutes: new Map() };
  const gaps = gridGaps(grid, from, toTs);
  readHostColumns(read, tally, hostColumns, grid?.rowWidth ?? null, gaps);
  if (grid !== null && grid.columnMs === FINE_COLUMN_MS) {
    const seam = seamOf(grid);
    readPart(read, tally, grid.deepColumns, grid.deepColumnMs, seam, Number.NEGATIVE_INFINITY, grid.rowWidth);
    readPart(read, tally, grid.columns, grid.columnMs, Number.POSITIVE_INFINITY, seam, grid.rowWidth);
  }
  read.noise = noiseOf(tally);
  read.minutesWon = minutesWonOf(tally);
  read.impact = impactOf(tally);
  const candles = within(traded ?? [[from, toTs]], [[from, toTs]]);
  for (const [start, end] of candles) read.tradedMs += end - start;
  if (holdsColumns(grid)) read.missing = within(without(gaps, hostSpans(hostColumns, grid.rowWidth)), candles);
  return read;
}
