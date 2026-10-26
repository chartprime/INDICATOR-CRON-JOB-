import type { LiquidityGrid } from "../passive-liquidity/liquidityGrid";
import { printFloorFor, readAggressiveProfile, type CandleDelta, type PrintTier } from "./aggressiveProfileReader";
import type { AggressiveProfileReaderSettings } from "./aggressiveProfileSettings";
import type { CandleSlot, RangePrintStore } from "./rangePrintStore";

export const READ_SETTLE_MS = 300;

export interface VisibleRange {
  fromTs: number;
  toTs: number;
  open: boolean;
}

export type PrintGrid = Pick<LiquidityGrid, "columns" | "columnMs" | "deepColumns" | "deepColumnMs">;

const NO_CANDLES: readonly CandleDelta[] = Object.freeze([]);

export function printTiersOf(grid: PrintGrid): PrintTier[] {
  const fine = grid.columns;
  const fineFrom = fine.length > 0 ? fine[0].ts - grid.columnMs : Infinity;
  return [
    { columns: grid.deepColumns, columnMs: grid.deepColumnMs, fromTs: -Infinity, toTs: fineFrom },
    { columns: fine, columnMs: grid.columnMs, fromTs: fineFrom, toTs: Infinity },
  ];
}

export class AggressiveProfileSource {
  private readonly _grid: LiquidityGrid;
  private readonly _printsOf: () => RangePrintStore | null;
  private _version = 0;
  private _candles: readonly CandleDelta[] | null = null;
  private _readKey = "";
  private _key = "";
  private _keyAt = 0;
  private _settleAt: number | null = null;
  private _floor: { version: number; epoch: number; floor: number } | null = null;

  constructor(grid: LiquidityGrid, printsOf: () => RangePrintStore | null = () => null) {
    this._grid = grid;
    this._printsOf = printsOf;
  }

  get version(): number {
    return this._version;
  }

  get candles(): readonly CandleDelta[] {
    return this._candles ?? NO_CANDLES;
  }

  get prints(): RangePrintStore | null {
    return this._printsOf();
  }

  get settleAt(): number | null {
    return this._settleAt;
  }

  private _printFloor(floor: number, store: RangePrintStore | null): number {
    const fetched = store?.floor ?? null;
    if (fetched !== null) return Math.max(floor, fetched);
    if (floor > 0) return floor;
    const grid = this._grid;
    const cached = this._floor;
    if (cached !== null && cached.version === grid.version && cached.epoch === grid.epoch) return cached.floor;
    const resolved = printFloorFor(0, grid.columns);
    this._floor = { version: grid.version, epoch: grid.epoch, floor: resolved };
    return resolved;
  }

  read(range: VisibleRange, settings: AggressiveProfileReaderSettings, candles: readonly CandleSlot[], now: number): readonly CandleDelta[] {
    const grid = this._grid;
    const store = this._printsOf();
    const floor = this._printFloor(settings.floor, store);
    const coverage = store === null ? null : store.coverage(range.fromTs, range.toTs, floor, now);
    const columnsRead = coverage === null || coverage.gaps.length > 0;
    const first = candles[0];
    const last = candles[candles.length - 1];
    const key = [columnsRead ? grid.version : "", grid.epoch, range.fromTs, range.toTs, floor, store?.version ?? "", candles.length, first?.ts_open ?? "", last?.ts_open ?? "", last?.interval_ms ?? ""].join("/");
    if (key !== this._key) {
      this._key = key;
      this._keyAt = now;
    }
    if (key === this._readKey && this._candles !== null) {
      this._settleAt = null;
      return this._candles;
    }
    if (this._candles !== null && now - this._keyAt < READ_SETTLE_MS) {
      this._settleAt = this._keyAt + READ_SETTLE_MS;
      return this._candles;
    }
    this._candles = readAggressiveProfile({
      printTiers: printTiersOf(grid),
      fromTs: range.fromTs,
      toTs: range.toTs,
      floor,
      candles,
      recorded: store === null ? null : store.readCandles(range.fromTs, range.toTs, floor, candles, now),
    });
    this._readKey = key;
    this._settleAt = null;
    this._version += 1;
    return this._candles;
  }
}
