import type { LiquidityPrint } from "../../../types/frames";
import { liquidityIndexAtOrAfter } from "../passive-liquidity/liquidityGrid";
import { FINE_COLUMN_MS, HOST_COLUMN_MS, gridGaps, seamOf, spanOf, type HostColumn, type RangeGrid } from "./liveRangeReader";

export interface PrintRead {
  buys: number;
  sells: number;
  buyCount: number;
  sellCount: number;
  threshold: number;
  floor: number | null;
  unit: string;
}

interface PrintColumn {
  ts: number;
  prints?: readonly LiquidityPrint[];
  printsFloor?: number | null;
}

export function noPrints(threshold: number, unit: string): PrintRead {
  return { buys: 0, sells: 0, buyCount: 0, sellCount: 0, threshold, floor: null, unit };
}

export function readPrints(
  grid: RangeGrid | null,
  hostColumns: readonly HostColumn[],
  fromTs: number,
  toTs: number,
  threshold: number,
  unit: string,
): PrintRead {
  const out = noPrints(threshold, unit);
  if (!(toTs > fromTs)) return out;
  const seen = new Set<string>();
  const take = (column: PrintColumn, columnMs: number) => {
    const [start, end] = spanOf(column.ts, columnMs);
    if (!(end > fromTs && start < toTs)) return;
    const floor = column.printsFloor;
    if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) out.floor = Math.max(out.floor ?? 0, floor);
    for (const print of column.prints ?? []) {
      if (!(print.ts >= fromTs && print.ts < toTs)) continue;
      if (print.id !== null) {
        if (seen.has(print.id)) continue;
        seen.add(print.id);
      }
      if (!(print.size >= threshold)) continue;
      if (print.side === "buy") {
        out.buys += print.size;
        out.buyCount += 1;
      } else {
        out.sells += print.size;
        out.sellCount += 1;
      }
    }
  };
  const { columns, ms } = lineUp(grid, hostColumns);
  for (let i = 0; i < columns.length; i += 1) take(columns[i], ms[i]);
  return out;
}

function lineUp(grid: RangeGrid | null, hostColumns: readonly HostColumn[]): { columns: PrintColumn[]; ms: number[] } {
  const own: PrintColumn[] = [];
  const ownMs: number[] = [];
  if (grid !== null && grid.columnMs === FINE_COLUMN_MS) {
    const seam = seamOf(grid);
    if (grid.deepColumnMs > 0) {
      for (const column of grid.deepColumns) {
        if (column.ts >= seam) break;
        own.push(column);
        ownMs.push(grid.deepColumnMs);
      }
    }
    for (let i = liquidityIndexAtOrAfter(grid.columns, seam); i < grid.columns.length; i += 1) {
      own.push(grid.columns[i]);
      ownMs.push(FINE_COLUMN_MS);
    }
  }
  const gaps = gridGaps(grid, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  const columns: PrintColumn[] = [];
  const ms: number[] = [];
  let g = 0;
  let o = 0;
  for (const column of hostColumns) {
    const [start, end] = spanOf(column.ts, HOST_COLUMN_MS);
    while (g < gaps.length && gaps[g][1] < end) g += 1;
    if (g === gaps.length) break;
    if (start < gaps[g][0]) continue;
    while (o < own.length && spanOf(own[o].ts, ownMs[o])[0] < start) {
      columns.push(own[o]);
      ms.push(ownMs[o]);
      o += 1;
    }
    columns.push(column);
    ms.push(HOST_COLUMN_MS);
  }
  for (; o < own.length; o += 1) {
    columns.push(own[o]);
    ms.push(ownMs[o]);
  }
  return { columns, ms };
}

const TALLY_WIDTH = 4;

export class PrintLedger {
  private _columns: PrintColumn[] = [];
  private _ms: number[] = [];
  private _tally = new Float64Array(0);
  private _lo = new Float64Array(0);
  private _hi = new Float64Array(0);
  private _start = new Float64Array(0);
  private _end = new Float64Array(0);
  private _dup = new Uint8Array(0);
  private readonly _owner = new Map<string, number>();
  private _threshold = Number.NaN;

  update(grid: RangeGrid | null, hostColumns: readonly HostColumn[], threshold: number): number {
    const { columns, ms } = lineUp(grid, hostColumns);
    const kept = this._columns;
    const shared = Math.min(kept.length, columns.length);
    let changed = 0;
    while (changed < shared && kept[changed] === columns[changed]) changed += 1;
    const sameThreshold = threshold === this._threshold;
    for (let j = changed; j < kept.length; j += 1) this._release(kept[j], j);
    this._columns = columns;
    this._ms = ms;
    this._threshold = threshold;
    this._grow(columns.length);
    for (let j = changed; j < columns.length; j += 1) this._own(j);
    const from = sameThreshold ? changed : 0;
    for (let j = from; j < columns.length; j += 1) this._count(j);
    return columns.length - from;
  }

  read(fromTs: number, toTs: number, unit: string): PrintRead {
    const threshold = Number.isFinite(this._threshold) ? this._threshold : 0;
    const out = noPrints(threshold, unit);
    if (!(toTs > fromTs)) return out;
    const columns = this._columns;
    const orphans = new Set<string>();
    for (let j = 0; j < columns.length; j += 1) {
      const column = columns[j];
      if (!(this._end[j] > fromTs && this._start[j] < toTs)) continue;
      const floor = column.printsFloor;
      if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) out.floor = Math.max(out.floor ?? 0, floor);
      if (this._dup[j] === 0 && this._lo[j] >= fromTs && this._hi[j] < toTs) {
        const at = j * TALLY_WIDTH;
        out.buys += this._tally[at];
        out.sells += this._tally[at + 1];
        out.buyCount += this._tally[at + 2];
        out.sellCount += this._tally[at + 3];
        continue;
      }
      for (const print of column.prints ?? []) {
        if (!(print.ts >= fromTs && print.ts < toTs)) continue;
        if (print.id !== null) {
          const owner = this._owner.get(print.id);
          if (owner !== undefined && owner !== j) {
            if (this._overlaps(owner, fromTs, toTs) || orphans.has(print.id)) continue;
            orphans.add(print.id);
          }
        }
        if (!(print.size >= threshold)) continue;
        if (print.side === "buy") {
          out.buys += print.size;
          out.buyCount += 1;
        } else {
          out.sells += print.size;
          out.sellCount += 1;
        }
      }
    }
    return out;
  }

  private _overlaps(index: number, fromTs: number, toTs: number): boolean {
    return this._end[index] > fromTs && this._start[index] < toTs;
  }

  private _grow(count: number): void {
    if (this._lo.length >= count) return;
    const size = Math.max(count, 2 * this._lo.length);
    const tally = new Float64Array(size * TALLY_WIDTH);
    tally.set(this._tally);
    this._tally = tally;
    const lo = new Float64Array(size);
    lo.set(this._lo);
    this._lo = lo;
    const hi = new Float64Array(size);
    hi.set(this._hi);
    this._hi = hi;
    const start = new Float64Array(size);
    start.set(this._start);
    this._start = start;
    const end = new Float64Array(size);
    end.set(this._end);
    this._end = end;
    const dup = new Uint8Array(size);
    dup.set(this._dup);
    this._dup = dup;
  }

  private _release(column: PrintColumn, index: number): void {
    for (const print of column.prints ?? []) if (print.id !== null && this._owner.get(print.id) === index) this._owner.delete(print.id);
  }

  private _own(index: number): void {
    const [start, end] = spanOf(this._columns[index].ts, this._ms[index]);
    this._start[index] = start;
    this._end[index] = end;
    let dup = 0;
    for (const print of this._columns[index].prints ?? []) {
      if (print.id === null) continue;
      const owner = this._owner.get(print.id);
      if (owner === undefined) this._owner.set(print.id, index);
      else if (owner !== index) dup = 1;
    }
    this._dup[index] = dup;
  }

  private _count(index: number): void {
    const at = index * TALLY_WIDTH;
    let buys = 0;
    let sells = 0;
    let buyCount = 0;
    let sellCount = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const print of this._columns[index].prints ?? []) {
      if (print.ts < lo) lo = print.ts;
      if (print.ts > hi) hi = print.ts;
      if (!(print.size >= this._threshold)) continue;
      if (print.side === "buy") {
        buys += print.size;
        buyCount += 1;
      } else {
        sells += print.size;
        sellCount += 1;
      }
    }
    this._tally[at] = buys;
    this._tally[at + 1] = sells;
    this._tally[at + 2] = buyCount;
    this._tally[at + 3] = sellCount;
    this._lo[index] = lo;
    this._hi[index] = hi;
  }
}
