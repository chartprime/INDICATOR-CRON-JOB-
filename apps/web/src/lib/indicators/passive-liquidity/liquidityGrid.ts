import type { AggressiveEvent, LiquidityColumnFrame, LiquidityFrame, LiquidityLevel, LiquidityPrint } from "../../../types/frames";
import { inChartSession } from "../../chart/marketCalendar";
import type { ColumnFeed } from "../absorption-detector/absorptionColumns";

// Passive Liquidity grid: the browser-side copy of the server's column
// history, rebuilt from delta frames.
//
// Each column holds the full resting size per row over its window (price =
// row * rowWidth). A delta column starts as a copy of the previous column
// restricted to the new window (rows that left the window are zero, exactly
// as the server encodes them), then applies its [offset, size] entries.

export interface LiquidityColumn {
  ts: number;
  lo: number;
  hi: number;
  bid: Float64Array;
  ask: Float64Array;
  /**
   * The colour reference that was live when this column printed: what a level
   * was judged against at that moment. It travels with the column so history
   * is never re-judged by a later book. Absent or 0 when unknown.
   */
  reference?: number;
  /**
   * The typical row of the book when this column printed: the median non-zero
   * size near price, smoothed like the reference. The index styles anchor
   * their colour on it. Absent or 0 when unknown.
   */
  median?: number;
  /** The biggest row near price when this column printed, smoothed over half an hour: where the index colour tops out. Absent or 0 when unknown. */
  ceiling?: number;
  /** Aggressive buy volume that printed per absolute row in the second (window) ending at ts, or in the one before it and reached the runtime after that column was taken. Absent on a column that predates the flow. */
  buy?: ReadonlyArray<readonly [row: number, volume: number]>;
  /** Same for aggressive sells. */
  sell?: ReadonlyArray<readonly [row: number, volume: number]>;
  /** The biggest prints of that second, every print at or above `printsFloor`. */
  prints?: readonly LiquidityPrint[];
  printsFloor?: number;
}

export type LiquiditySide = "bid" | "ask";

/** Two hours of one-second columns. */
export const DEFAULT_LIQUIDITY_CAPACITY = 7_200;
/** Eleven hours of ten-second columns. */
export const DEFAULT_LIQUIDITY_DEEP_CAPACITY = 4_000;
export const DEFAULT_LIQUIDITY_COARSE_CAPACITY = 3_000;
/** The auto colour scale follows this percentile of the non-zero cells in each new column ... */
export const LIQUIDITY_REFERENCE_PERCENTILE = 0.95;
/** ... smoothed so a single column cannot flip the whole picture ... */
export const LIQUIDITY_REFERENCE_ALPHA = 0.1;
/** ... and measured only this close to the mid, where the book is thin and a wall is judged against its neighbours (the server uses the same span). */
export const LIQUIDITY_REFERENCE_BP = 50;
/** The ceiling follows the biggest row near price over about thirty minutes of one-second columns. */
export const LIQUIDITY_CEILING_ALPHA = 1 / 1800;
export const LIQUIDITY_CEILING_SEED_CAP = 10;

export function seededCeiling(previous: number, next: number, reference: number): number {
  return previous <= 0 ? Math.min(next, LIQUIDITY_CEILING_SEED_CAP * reference) : next;
}

/** What a size counts: the base asset of a Binance pair, contracts of a future, shares of an equity. */
export function liquidityUnitOf(frame: LiquidityFrame): string {
  if (frame.provider === "DXFEED") return frame.assetClass === "FUTURE" ? "contracts" : "shares";
  return frame.symbol.split("-")[0] ?? "";
}

export function decodeLiquidityColumn(prev: LiquidityColumn | null, wire: LiquidityColumnFrame): LiquidityColumn {
  const span = wire.hi - wire.lo + 1;
  const bid = new Float64Array(span);
  const ask = new Float64Array(span);
  if (prev) {
    const from = Math.max(wire.lo, prev.lo);
    const to = Math.min(wire.hi, prev.hi);
    for (let row = from; row <= to; row += 1) {
      bid[row - wire.lo] = prev.bid[row - prev.lo];
      ask[row - wire.lo] = prev.ask[row - prev.lo];
    }
  }
  for (const [offset, size] of wire.bid) bid[offset] = size;
  for (const [offset, size] of wire.ask) ask[offset] = size;
  const column: LiquidityColumn = { ts: wire.ts, lo: wire.lo, hi: wire.hi, bid, ask };
  if (wire.buy !== undefined) column.buy = wire.buy.map(([offset, volume]) => [wire.lo + offset, volume] as const);
  if (wire.sell !== undefined) column.sell = wire.sell.map(([offset, volume]) => [wire.lo + offset, volume] as const);
  if (wire.prints !== undefined) column.prints = wire.prints;
  if (wire.prints_floor !== undefined) column.printsFloor = wire.prints_floor;
  return column;
}

/** Size at an absolute row, 0 outside the column's window. */
export function liquiditySizeAt(column: LiquidityColumn, side: LiquiditySide, row: number): number {
  if (row < column.lo || row > column.hi) return 0;
  return column[side][row - column.lo];
}

/** The p-th percentile (0..1) of the non-zero cells on both sides within `referenceRows` of the mid, 0 when empty. */
export function liquidityPercentile(column: LiquidityColumn, p: number, referenceRows = Infinity): number {
  const values: number[] = [];
  const mid = (column.lo + column.hi) / 2;
  const from = Math.max(0, Math.ceil(mid - referenceRows - column.lo));
  const to = Math.min(column.bid.length - 1, Math.floor(mid + referenceRows - column.lo));
  for (const side of [column.bid, column.ask]) {
    for (let i = from; i <= to; i += 1) if (side[i] > 0) values.push(side[i]);
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))));
  return values[index];
}

/** Resting bid and ask size in one band of `clusterRows` rows, summed. */
export function bandSizes(column: LiquidityColumn, bandIndex: number, clusterRows: number): { bid: number; ask: number } {
  const rows = Math.max(1, Math.floor(clusterRows));
  const from = Math.max(column.lo, bandIndex * rows);
  const to = Math.min(column.hi, (bandIndex + 1) * rows - 1);
  let bid = 0;
  let ask = 0;
  for (let row = from; row <= to; row += 1) {
    bid += column.bid[row - column.lo];
    ask += column.ask[row - column.lo];
  }
  return { bid, ask };
}

/** The biggest resting bid and ask row in one band of `clusterRows` rows: how the index styles read a band, so a level is not diluted by its neighbours. */
export function bandMaxSizes(column: LiquidityColumn, bandIndex: number, clusterRows: number): { bid: number; ask: number } {
  const rows = Math.max(1, Math.floor(clusterRows));
  const from = Math.max(column.lo, bandIndex * rows);
  const to = Math.min(column.hi, (bandIndex + 1) * rows - 1);
  let bid = 0;
  let ask = 0;
  for (let row = from; row <= to; row += 1) {
    if (!Number.isFinite(column.bid[row - column.lo])) bid = NaN;
    if (!Number.isFinite(column.ask[row - column.lo])) ask = NaN;
    if (column.bid[row - column.lo] > bid) bid = column.bid[row - column.lo];
    if (column.ask[row - column.lo] > ask) ask = column.ask[row - column.lo];
  }
  return { bid, ask };
}

/** Index of the first column at or after `ts` in a time-ordered list; `columns.length` when none. */
export function liquidityIndexAtOrAfter(columns: readonly LiquidityColumn[], ts: number): number {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface DecoderTier {
  columnMs: number;
  rowWidth: number;
  last: LiquidityColumn | null;
  seq: number;
  synced: boolean;
  reference: number;
  median: number;
  ceiling: number;
}

export interface DecodedLiquidity {
  readonly accepted: boolean;
  readonly reset: boolean;
  readonly columnMs: number;
  readonly rowWidth: number;
  readonly clearWidth: number | null;
  readonly columns: readonly LiquidityColumn[];
  readonly reference: number;
  readonly median: number;
  readonly ceiling: number;
}

function copyColumn(column: LiquidityColumn): LiquidityColumn {
  return { ...column, bid: Float64Array.from(column.bid), ask: Float64Array.from(column.ask) };
}

export class LiquidityDecoder {
  private _tiers: DecoderTier[] = [];

  private get _fine(): DecoderTier | null {
    return this._tiers.length === 0 ? null : this._tiers[0];
  }

  decode(frame: LiquidityFrame): DecodedLiquidity {
    const firstSeq = frame.seq - frame.columns.length;
    let tier = this._tiers.find((t) => t.columnMs === frame.column_ms);
    let clearWidth: number | null = null;
    const rejected = (reset: boolean, columns: readonly LiquidityColumn[]): DecodedLiquidity =>
      Object.freeze({ accepted: false, reset, columnMs: frame.column_ms, rowWidth: frame.row_width, clearWidth, columns, reference: tier?.reference ?? 0, median: tier?.median ?? 0, ceiling: tier?.ceiling ?? 0 });
    if (frame.reset) {
      const previousWidth = tier?.rowWidth;
      if (previousWidth !== undefined && previousWidth !== frame.row_width) {
        clearWidth = previousWidth;
        for (const other of this._tiers) {
          if (other === tier || other.rowWidth !== previousWidth) continue;
          other.last = null;
          other.synced = false;
        }
      }
      if (!tier) {
        tier = { columnMs: frame.column_ms, rowWidth: frame.row_width, last: null, seq: 0, synced: false, reference: 0, median: 0, ceiling: 0 };
        this._tiers.push(tier);
        this._tiers.sort((a, b) => a.columnMs - b.columnMs);
      }
      tier.rowWidth = frame.row_width;
      tier.last = null;
      tier.seq = firstSeq;
      tier.synced = true;
      tier.reference = 0;
      tier.median = 0;
      tier.ceiling = 0;
    } else if (!tier || !tier.synced || firstSeq !== tier.seq || frame.row_width !== tier.rowWidth) {
      if (tier) tier.synced = false;
      return rejected(false, []);
    }
    const columns: LiquidityColumn[] = [];
    for (const wire of frame.columns) {
      const prev = tier.last;
      if (prev && wire.ts <= prev.ts) {
        tier.synced = false;
        return rejected(frame.reset, columns);
      }
      const column = decodeLiquidityColumn(prev, wire);
      tier.last = column;
      if (!inChartSession(frame, column.ts)) continue;
      columns.push(column);
      column.reference = this._trackReference(column, tier);
      column.median = this._trackMedian(column, tier);
      column.ceiling = this._trackCeiling(column, tier);
    }
    if (tier.last !== null && columns[columns.length - 1] === tier.last) tier.last = copyColumn(tier.last);
    tier.seq = frame.seq;
    return Object.freeze({ accepted: true, reset: frame.reset, columnMs: frame.column_ms, rowWidth: tier.rowWidth, clearWidth, columns, reference: tier.reference, median: tier.median, ceiling: tier.ceiling });
  }

  markUntrusted(): void {
    for (const tier of this._tiers) tier.synced = false;
  }

  clear(): void {
    this._tiers = [];
  }

  private _trackReference(column: LiquidityColumn, tier: DecoderTier): number {
    tier.reference = this._smooth(column, tier, LIQUIDITY_REFERENCE_PERCENTILE, tier.reference);
    return tier.reference;
  }

  private _trackMedian(column: LiquidityColumn, tier: DecoderTier): number {
    tier.median = this._smooth(column, tier, 0.5, tier.median);
    return tier.median;
  }

  private _trackCeiling(column: LiquidityColumn, tier: DecoderTier): number {
    tier.ceiling = seededCeiling(tier.ceiling, this._smooth(column, tier, 1, tier.ceiling, LIQUIDITY_CEILING_ALPHA), tier.reference);
    return tier.ceiling;
  }

  private _smooth(column: LiquidityColumn, tier: DecoderTier, percentile: number, current: number, fineAlpha = LIQUIDITY_REFERENCE_ALPHA): number {
    const midPrice = ((column.lo + column.hi) / 2) * tier.rowWidth;
    const referenceRows = tier.rowWidth > 0 ? Math.max(1, Math.round((midPrice * LIQUIDITY_REFERENCE_BP) / 10_000 / tier.rowWidth)) : Infinity;
    const sample = liquidityPercentile(column, percentile, referenceRows);
    if (sample <= 0) return current;
    const fineMs = this._fine?.columnMs ?? 1000;
    const alpha = tier === this._fine ? fineAlpha : 1 - (1 - fineAlpha) ** Math.max(1, tier.columnMs / fineMs);
    return current <= 0 ? sample : current + alpha * (sample - current);
  }
}

interface Tier {
  columnMs: number;
  rowWidth: number;
  columns: LiquidityColumn[];
  seq: number;
  synced: boolean;
  reference: number;
  median: number;
  ceiling: number;
}

const EMPTY: readonly LiquidityColumn[] = Object.freeze([]);

export class LiquidityGrid {
  get historicalFeed(): ColumnFeed | null { return null; }
  clockMs(): number { return Date.now(); }
  private _tiers: Tier[] = []; // finest first
  private _version = 0;
  private _epoch = 0;
  private _rejected = 0;
  private _levels: readonly LiquidityLevel[] = [];
  private _aggressive: readonly AggressiveEvent[] = [];
  private _baseAsset = "";
  private _symbol = "";
  private _provider = "";
  private _marketKind = "";
  private readonly _capacity: number;
  private readonly _deepCapacity: number;
  private readonly _coarseCapacity: number;
  private readonly _decoder = new LiquidityDecoder();

  constructor(capacity: number = DEFAULT_LIQUIDITY_CAPACITY, deepCapacity: number = DEFAULT_LIQUIDITY_DEEP_CAPACITY, coarseCapacity: number = DEFAULT_LIQUIDITY_COARSE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("LiquidityGrid: capacity must be a positive integer");
    if (!Number.isSafeInteger(deepCapacity) || deepCapacity <= 0) throw new Error("LiquidityGrid: deepCapacity must be a positive integer");
    if (!Number.isSafeInteger(coarseCapacity) || coarseCapacity <= 0) throw new Error("LiquidityGrid: coarseCapacity must be a positive integer");
    this._capacity = capacity;
    this._deepCapacity = deepCapacity;
    this._coarseCapacity = coarseCapacity;
  }

  private get _fine(): Tier | null {
    return this._tiers.length === 0 ? null : this._tiers[0];
  }

  private get _deep(): Tier | null {
    const fine = this._fine;
    if (fine === null) return null;
    return this._tiers.find((tier) => tier !== fine && tier.rowWidth === fine.rowWidth) ?? null;
  }

  private get _coarse(): Tier | null {
    const fine = this._fine;
    if (fine === null) return null;
    const own = this._tiers.filter((tier) => tier !== fine && tier.rowWidth !== fine.rowWidth);
    return own.length === 0 ? null : own[own.length - 1];
  }

  /** The finest tier's columns. */
  get columns(): readonly LiquidityColumn[] {
    return this._fine?.columns ?? EMPTY;
  }

  get latest(): LiquidityColumn | null {
    const columns = this.columns;
    return columns.length === 0 ? null : columns[columns.length - 1];
  }

  get rowWidth(): number {
    return this._fine?.rowWidth ?? 0;
  }

  /** Time width of one column of the finest tier. */
  get columnMs(): number {
    return this._fine?.columnMs ?? 1_000;
  }

  get deepColumns(): readonly LiquidityColumn[] {
    return this._deep?.columns ?? EMPTY;
  }

  /** Time width of one deep column; 0 while there is no deep tier. */
  get deepColumnMs(): number {
    return this._deep?.columnMs ?? 0;
  }

  get coarseColumns(): readonly LiquidityColumn[] {
    return this._coarse?.columns ?? EMPTY;
  }

  get coarseColumnMs(): number {
    return this._coarse?.columnMs ?? 0;
  }

  get coarseRowWidth(): number {
    return this._coarse?.rowWidth ?? 0;
  }

  /** From the oldest column of any tier to the end of the latest fine column; 0 when empty. */
  get spanMs(): number {
    const fine = this._fine;
    if (!fine || fine.columns.length === 0) return 0;
    const end = fine.columns[fine.columns.length - 1].ts + fine.columnMs;
    let start = fine.columns[0].ts;
    for (const tier of this._tiers) if (tier.columns.length > 0 && tier.columns[0].ts < start) start = tier.columns[0].ts;
    return Math.max(0, end - start);
  }

  /** Bumps on every applied frame; cheap change detection for React and the chart. */
  get version(): number {
    return this._version;
  }

  /** Bumps on every reset of a tier: the columns no longer continue the ones before, so a reader walking them starts over. */
  get epoch(): number {
    return this._epoch;
  }

  /** Smoothed reference size for the automatic colour scale. */
  get referenceSize(): number {
    return this._fine?.reference ?? 0;
  }

  /** Whether the finest tier chains from its last reset. */
  get synced(): boolean {
    return this._fine?.synced ?? false;
  }

  /** Walls the server tracks: active ones and those recently eaten, hit, moved or pulled. */
  get levels(): readonly LiquidityLevel[] {
    return this._levels;
  }

  get aggressive(): readonly AggressiveEvent[] {
    return this._aggressive;
  }

  /** Unit of every size: the pair's base asset ("BTC" for BTC-USDT), "contracts" or "shares"; empty until the first frame. */
  get baseAsset(): string {
    return this._baseAsset;
  }

  /** The wire symbol the columns belong to ("BTC-USDT", "/NQU26:XCME"); empty until the first frame. */
  get symbol(): string {
    return this._symbol;
  }

  /** "BINANCE" or "DXFEED": which market's style the chart draws this grid in; empty until the first frame. */
  get provider(): string {
    return this._provider;
  }

  get marketKind(): string {
    return this._marketKind;
  }

  /** Frames dropped because they did not chain (diagnostics). */
  get rejected(): number {
    return this._rejected;
  }

  /**
   * Apply one frame to the tier of its `column_ms`. Returns false (and
   * applies nothing) when the frame does not continue that tier's history:
   * the tier then waits for its next reset.
   */
  apply(frame: LiquidityFrame): boolean {
    return this.applyDecoded(frame, this._decoder.decode(frame));
  }

  applyDecoded(frame: LiquidityFrame, decoded: DecodedLiquidity): boolean {
    const firstSeq = frame.seq - frame.columns.length;
    if (this._baseAsset === "" || frame.reset) {
      this._baseAsset = liquidityUnitOf(frame);
      this._symbol = frame.symbol;
      this._provider = frame.provider;
      this._marketKind = frame.marketKind ?? "";
    }
    let tier = this._tiers.find((t) => t.columnMs === frame.column_ms);
    if (decoded.reset) {
      if (decoded.clearWidth !== null) {
        for (const other of this._tiers) {
          if (other === tier || other.rowWidth !== decoded.clearWidth) continue;
          other.columns = [];
          other.synced = false;
        }
      }
      if (!tier) {
        tier = { columnMs: frame.column_ms, rowWidth: frame.row_width, columns: [], seq: 0, synced: false, reference: 0, median: 0, ceiling: 0 };
        this._tiers.push(tier);
        this._tiers.sort((a, b) => a.columnMs - b.columnMs);
      }
      tier.rowWidth = frame.row_width;
      tier.columns = [];
      tier.seq = firstSeq;
      tier.synced = true;
      tier.reference = 0;
      tier.median = 0;
      tier.ceiling = 0;
      this._epoch += 1;
      if (tier === this._fine) {
        this._levels = [];
        this._aggressive = [];
      }
    } else if (!tier) {
      this._rejected += 1;
      return false;
    }
    const fine = this._fine as Tier;
    for (const column of decoded.columns) tier.columns.push(column);
    tier.reference = decoded.reference;
    tier.median = decoded.median;
    tier.ceiling = decoded.ceiling;
    if (!decoded.accepted) {
      tier.synced = false;
      this._rejected += 1;
      return false;
    }
    const capacity = tier === fine ? this._capacity : tier.rowWidth !== fine.rowWidth ? this._coarseCapacity : this._deepCapacity;
    if (tier.columns.length > capacity) tier.columns.splice(0, tier.columns.length - capacity);
    if (frame.levels !== undefined) this._levels = frame.levels;
    if (frame.aggressive !== undefined) this._aggressive = frame.aggressive;
    tier.seq = frame.seq;
    this._version += 1;
    return true;
  }

  /** Index of the first fine column at or after `ts`; `columns.length` when none. */
  /** The yardstick carried by the column at or just before `ts` on the fine or the deep tier, for a zoom lane judged by lane 0's. */
  yardstickAt(ts: number, deep: boolean): { reference: number; median: number; ceiling: number } | null {
    const list = deep ? this.deepColumns : this.columns;
    const index = deep ? this.deepIndexAtOrAfter(ts) : this.indexAtOrAfter(ts);
    const column = index < list.length && list[index].ts === ts ? list[index] : list[index - 1];
    if (column === undefined || !(column.reference !== undefined && column.reference > 0)) return null;
    return { reference: column.reference, median: column.median ?? 0, ceiling: column.ceiling ?? 0 };
  }

  indexAtOrAfter(ts: number): number {
    return liquidityIndexAtOrAfter(this.columns, ts);
  }

  /** Same over the deep tier. */
  deepIndexAtOrAfter(ts: number): number {
    return liquidityIndexAtOrAfter(this.deepColumns, ts);
  }

  coarseIndexAtOrAfter(ts: number): number {
    return liquidityIndexAtOrAfter(this.coarseColumns, ts);
  }
}

export type HeatGrid = Pick<
  LiquidityGrid,
  | "columns" | "deepColumns" | "coarseColumns" | "rowWidth" | "coarseRowWidth" | "columnMs" | "deepColumnMs" | "coarseColumnMs"
  | "latest" | "epoch" | "version" | "levels" | "aggressive" | "provider" | "symbol" | "marketKind" | "baseAsset" | "referenceSize"
  | "synced" | "spanMs" | "indexAtOrAfter" | "deepIndexAtOrAfter" | "coarseIndexAtOrAfter"
>;
