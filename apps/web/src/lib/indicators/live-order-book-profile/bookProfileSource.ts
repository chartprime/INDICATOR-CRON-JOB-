import type { BookFrame } from "../../../types/frames";
import type { LiquidityColumn, LiquidityGrid } from "../passive-liquidity/liquidityGrid";
import { clusterIndex } from "../passive-liquidity/liquiditySettings";
import { MAX_LANE, type HeatLanes } from "../passive-liquidity/liquidityLanes";
import { widerLanes, type WiderLane } from "../passive-liquidity/liquidityHeatmapLayout";
import { liquidityStyleFor, type LiquidityStyle } from "../passive-liquidity/liquidityStyle";
import { formatDelta } from "../live-delta-profile/liveDeltaProfileNumbers";
import { RestingOrderTracker, type RestingOrder } from "./restingOrders";

export const BOOK_STALE_MS = 5_000;

export interface BookRow {
  index: number;
  price: number;
  priceTo: number;
  bid: number;
  ask: number;
}

export interface BookSpread {
  bidRow: number | null;
  askRow: number | null;
}

export interface BookExtent {
  lowRow: number;
  highRow: number;
}

interface BookMid extends BookSpread {
  bidRow: number;
  askRow: number;
  at: number;
}

const NO_SPREAD: BookSpread = Object.freeze({ bidRow: null, askRow: null });
const NO_ROWS: readonly BookRow[] = Object.freeze([]);

function shown(size: number): number {
  return Math.round(size) > 0 ? size : 0;
}

function priceAt(index: number, step: number): number {
  return Number((index * step).toPrecision(12));
}

export function rowOfPrice(price: number, rowWidth: number): number {
  return Math.floor(Number((price / rowWidth).toPrecision(12)));
}

function midOf(book: BookFrame | null, grid: Pick<LiquidityGrid, "symbol" | "provider" | "marketKind" | "rowWidth">, now: number): BookMid | null {
  if (book === null || book.status !== "READY" || book.stale === true) return null;
  if (book.symbol !== grid.symbol || book.provider !== grid.provider || (book.marketKind ?? "") !== grid.marketKind) return null;
  const bid = book.bids?.[0]?.price;
  const ask = book.asks?.[0]?.price;
  if (bid === undefined || ask === undefined || !(grid.rowWidth > 0)) return null;
  return { bidRow: rowOfPrice(bid, grid.rowWidth), askRow: rowOfPrice(ask, grid.rowWidth), at: now };
}

export function bookBands(column: LiquidityColumn, rowWidth: number, clusterRows: number, style: Pick<LiquidityStyle, "bandSizes">, wider: readonly WiderLane[] = []): BookRow[] {
  const rows = Math.max(1, Math.floor(clusterRows));
  const step = rowWidth * rows;
  const bands: BookRow[] = [];
  const push = (index: number, price: number, priceTo: number, sizes: { bid: number; ask: number }) => {
    const bid = shown(sizes.bid);
    const ask = shown(sizes.ask);
    if (bid <= 0 && ask <= 0) return;
    bands.push({ index, price, priceTo, bid, ask });
  };
  for (let index = clusterIndex(column.lo, rows); index <= clusterIndex(column.hi, rows); index += 1) {
    push(index, priceAt(index, step), priceAt(index + 1, step), style.bandSizes(column, index, rows));
  }
  let coveredLo = column.lo;
  let coveredHi = column.hi;
  for (const lane of wider) {
    const laneLo = lane.latest.lo * lane.factor;
    const laneHi = (lane.latest.hi + 1) * lane.factor - 1;
    const outside = (from: number, to: number) => to < coveredLo || from > coveredHi;
    if (rows % lane.factor === 0) {
      const laneRows = rows / lane.factor;
      for (let index = clusterIndex(lane.latest.lo, laneRows); index <= clusterIndex(lane.latest.hi, laneRows); index += 1) {
        if (!outside(index * rows, (index + 1) * rows - 1)) continue;
        push(index, priceAt(index, step), priceAt(index + 1, step), style.bandSizes(lane.latest, index, laneRows));
      }
    } else {
      const laneStep = lane.rowWidth;
      for (let row = lane.latest.lo; row <= lane.latest.hi; row += 1) {
        if (!outside(row * lane.factor, (row + 1) * lane.factor - 1)) continue;
        push(clusterIndex(row * lane.factor, rows), priceAt(row, laneStep), priceAt(row + 1, laneStep), style.bandSizes(lane.latest, row, 1));
      }
    }
    coveredLo = Math.min(coveredLo, laneLo);
    coveredHi = Math.max(coveredHi, laneHi);
  }
  return bands.sort((a, b) => a.price - b.price);
}

export function spreadOf(column: LiquidityColumn): BookSpread {
  let bidRow: number | null = null;
  let askRow: number | null = null;
  for (let i = column.bid.length - 1; i >= 0; i -= 1) {
    if (column.bid[i] > 0) {
      bidRow = column.lo + i;
      break;
    }
  }
  for (let i = 0; i < column.ask.length; i += 1) {
    if (column.ask[i] > 0) {
      askRow = column.lo + i;
      break;
    }
  }
  return { bidRow, askRow };
}

function columnExtent(column: LiquidityColumn): BookExtent | null {
  const holds = (i: number) => column.bid[i] > 0 || column.ask[i] > 0;
  let low = 0;
  while (low < column.bid.length && !holds(low)) low += 1;
  if (low === column.bid.length) return null;
  let high = column.bid.length - 1;
  while (!holds(high)) high -= 1;
  return { lowRow: column.lo + low, highRow: column.lo + high };
}

export function bookExtent(column: LiquidityColumn, wider: readonly WiderLane[] = []): BookExtent | null {
  let extent = columnExtent(column);
  for (const lane of wider) {
    const own = columnExtent(lane.latest);
    if (own === null) continue;
    const lowRow = own.lowRow * lane.factor;
    const highRow = (own.highRow + 1) * lane.factor - 1;
    extent = extent === null ? { lowRow, highRow } : { lowRow: Math.min(extent.lowRow, lowRow), highRow: Math.max(extent.highRow, highRow) };
  }
  return extent;
}

export function bookAgeMs(column: LiquidityColumn, now: number): number {
  return now - column.ts;
}

export function isBookLive(column: LiquidityColumn | null, now: number, staleMs: number = BOOK_STALE_MS): boolean {
  return column !== null && bookAgeMs(column, now) <= staleMs;
}

export class BookProfileSource {
  clockMs(): number { return this._grid.clockMs(); }
  private readonly _grid: LiquidityGrid;
  private readonly _resting = new RestingOrderTracker();
  private _cachedVersion = -1;
  private _cachedCluster = 0;
  private _cachedBands: readonly BookRow[] = NO_ROWS;
  private _bookMid: BookMid | null = null;
  private _bookMarks = 0;
  private _lanes: HeatLanes | null;

  constructor(grid: LiquidityGrid, lanes: HeatLanes | null = null) {
    this._grid = grid;
    this._lanes = lanes;
  }

  get rowWidth(): number {
    return this._grid.rowWidth;
  }

  get version(): number {
    return this._grid.version + this._bookMarks + this._lanesVersion();
  }

  setLanes(lanes: HeatLanes | null): void {
    this._lanes = lanes;
  }

  private _lanesVersion(): number {
    const lanes = this._lanes;
    if (lanes === null) return 0;
    let version = 0;
    for (let lane = 1; lane <= MAX_LANE; lane += 1) version += lanes.grid(lane)?.version ?? 0;
    return version;
  }

  private _wider(): WiderLane[] {
    return widerLanes(this._grid, this._lanes);
  }

  bands(clusterRows: number): readonly BookRow[] {
    const grid = this._grid;
    const version = grid.version + this._lanesVersion();
    if (this._cachedVersion === version && this._cachedCluster === clusterRows) return this._cachedBands;
    const latest = grid.latest;
    const style = liquidityStyleFor(grid.provider, grid.symbol, grid.marketKind);
    this._cachedBands = latest === null ? NO_ROWS : bookBands(latest, grid.rowWidth, clusterRows, style, this._wider());
    this._cachedVersion = version;
    this._cachedCluster = clusterRows;
    return this._cachedBands;
  }

  label(size: number): string {
    return formatDelta(size);
  }

  markBook(book: BookFrame | null, now: number): void {
    const next = midOf(book, this._grid, now);
    const current = this._bookMid;
    this._bookMid = next;
    if (next === null ? current !== null : current === null || current.bidRow !== next.bidRow || current.askRow !== next.askRow) this._bookMarks += 1;
  }

  spread(now: number): BookSpread {
    const mid = this._bookMid;
    if (mid !== null && now - mid.at <= BOOK_STALE_MS) return { bidRow: mid.bidRow, askRow: mid.askRow };
    const latest = this._grid.latest;
    return latest === null ? NO_SPREAD : spreadOf(latest);
  }

  extent(): BookExtent | null {
    const latest = this._grid.latest;
    return latest === null ? null : bookExtent(latest, this._wider());
  }

  live(now: number): boolean {
    return isBookLive(this._grid.latest, now);
  }

  resting(minSize: number, standMs?: number): readonly RestingOrder[] {
    return this._resting.update(this._grid, minSize, standMs);
  }

  typicalSize(): number {
    return this._grid.latest?.reference ?? 0;
  }
}
