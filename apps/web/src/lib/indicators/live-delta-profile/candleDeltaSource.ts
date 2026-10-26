import type { BarFrame, DeltaProfileReason } from "../../../types/frames";
import { barSides } from "../barSides";
import { rowIndexOf, type DeltaProfilePiece, type DeltaProfileRow, type RecentTrade } from "./deltaProfileStore";

/** What the primitive reads: the live store on a live chart, the candles on a historical one. */
export interface DeltaSource {
  readonly rowWidth: number;
  readonly version: number;
  readonly lastIndex: number | null;
  readonly recent: readonly RecentTrade[];
  readonly issue: DeltaProfileReason | null;
  readonly complete: boolean;
  readonly pieces: readonly DeltaProfilePiece[];
  /** True when the rows are estimated from candles rather than executed trades. */
  readonly estimated?: boolean;
  rows(): DeltaProfileRow[];
}

export interface TimeRange {
  from: number;
  to: number;
}

function inRange(bar: BarFrame, range: TimeRange): boolean {
  return bar.ts_open < range.to && bar.ts_open + bar.interval_ms > range.from;
}

/**
 * The delta of the candles running inside [from, to), by price row: each
 * candle's buys and sells go evenly over the rows between its low and high.
 * An estimate, for archives that keep candles but not trades.
 */
export function rowsFromCandles(bars: readonly BarFrame[], rowWidth: number, from: number, to: number): DeltaProfileRow[] {
  const tallies = new Map<number, DeltaProfileRow>();
  const range = { from, to };
  for (const bar of bars) {
    if (!inRange(bar, range)) continue;
    const sides = barSides(bar);
    if (!sides.known) continue;
    const first = rowIndexOf(bar.low, rowWidth);
    const last = rowIndexOf(bar.high, rowWidth);
    const share = 1 / (last - first + 1);
    for (let index = first; index <= last; index += 1) {
      const row = tallies.get(index);
      if (row) {
        row.buy += sides.buy * share;
        row.sell += sides.sell * share;
      } else {
        tallies.set(index, { price: Number((index * rowWidth).toPrecision(12)), buy: sides.buy * share, sell: sides.sell * share });
      }
    }
  }
  return [...tallies.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/** The profile's source on a historical chart: the candles on screen, re-read whenever the view moves. */
export class CandleDeltaSource implements DeltaSource {
  readonly rowWidth: number;
  readonly recent: readonly RecentTrade[] = [];
  readonly issue: DeltaProfileReason | null = null;
  readonly complete = true;
  readonly estimated = true;
  readonly pieces: readonly DeltaProfilePiece[] = [];
  private readonly _range: () => TimeRange | null;
  private _bars: readonly BarFrame[] = [];
  private _version = 0;
  private _key = "";
  private _rows: DeltaProfileRow[] = [];
  private _lastIndex: number | null = null;

  constructor(rowWidth: number, range: () => TimeRange | null) {
    this.rowWidth = rowWidth;
    this._range = range;
  }

  get version(): number {
    return this._version;
  }

  get lastIndex(): number | null {
    this.rows();
    return this._lastIndex;
  }

  setBars(bars: readonly BarFrame[]): void {
    this._bars = bars;
    this._version += 1;
  }

  rows(): DeltaProfileRow[] {
    const range = this._range();
    const key = range === null ? `${this._version}` : `${this._version}|${range.from}|${range.to}`;
    if (key === this._key) return this._rows;
    this._key = key;
    if (range === null) {
      this._rows = [];
      this._lastIndex = null;
      return this._rows;
    }
    this._rows = rowsFromCandles(this._bars, this.rowWidth, range.from, range.to);
    const last = this._bars.filter((bar) => inRange(bar, range)).at(-1);
    this._lastIndex = last === undefined ? null : rowIndexOf(last.close, this.rowWidth);
    return this._rows;
  }
}
