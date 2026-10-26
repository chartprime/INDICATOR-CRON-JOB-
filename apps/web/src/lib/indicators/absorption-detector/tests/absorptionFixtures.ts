import type { IndicatorL2 } from "../../../chart/indicatorL2";
import { indicatorL2Of } from "../../../chart/indicatorL2";
import { L2Store, type L2Frame } from "../../../l2/l2Store";
import { parseServerFrame } from "../../../../types/frames";
import { bandSizes, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { ColumnFeed } from "../absorptionEngine";
import { ASKED_MULTIPLES, ASKED_PERCENTS, type AbsorptionRules } from "../absorptionSettings";

// A BTC-perp-like book: rows of $4, bands of four rows summed, a wall from 50 on every column, a typical level of 10
// on every column, a sphere once all of the resting size and five times the typical level (50) have traded into the
// wall -- the sliders' lowest numbers, where an attack is recorded -- the strong ring at twice, two quiet minutes
// ending an attack. Ten-second columns. The bid wall's band is 5: rows 20..23, prices 80..96, mid 88; sells into it
// print on row 21.
export const S = 1_000;
export const ROW = 4;
export const STEP = 10 * S;
// An hour ago, on a step: the store keeps a week, so a fixture in the past would lose its held spheres.
export const T = Math.floor((Date.now() - 3_600_000) / STEP) * STEP;
export const BAND = 5;
export const HIT_ROW = BAND * 4 + 1;
export const BAND_MID = (BAND * 4 + 2) * ROW;
export const REFERENCE = 10;
export const WALL_FLOOR = 50;
export const RULES: AbsorptionRules = {
  instrument: "BINANCE:PERPETUAL:BTC-USDT",
  bandRows: 4,
  wallKey: "fixture",
  wallFloor: () => WALL_FLOOR,
  bandSize: (column, side, band) => bandSizes(column, band, 4)[side],
  wallSize: () => WALL_FLOOR,
  absorbedPercent: 100,
  strongPercent: 200,
  absorbedMultiple: 5,
  recordPercent: 100,
  recordMultiple: 5,
  askedPercents: ASKED_PERCENTS,
  askedMultiples: ASKED_MULTIPLES,
  quietMs: 120_000,
  breakWindowMs: 3 * 60_000,
};
export const ID = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
export const LIVE = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };

export interface Col {
  wall?: number;
  mid?: number;
  sell?: number;
  reference?: number;
}

/** A column over rows 0..40: the band's bid size spread over its rows, the mid where `mid` says, `sell` printed on the hit row, the typical level it carries. */
export function col(ts: number, { wall = 0, mid = 100, sell = 0, reference = REFERENCE }: Col = {}): LiquidityColumn {
  const lo = 0;
  const hi = 40;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (let row = BAND * 4; row < BAND * 4 + 4; row += 1) bid[row - lo] = wall / 4;
  const askRow = Math.round(mid / ROW);
  bid[askRow - 1 - lo] = Math.max(bid[askRow - 1 - lo], 1);
  ask[askRow - lo] = 1;
  return { ts, lo, hi, bid, ask, reference, sell: sell > 0 ? [[HIT_ROW, sell]] : [], buy: [] };
}

export const feedOf = (columns: readonly LiquidityColumn[], epoch = 1): ColumnFeed => ({ epoch, deep: null, fine: { columns: [...columns], columnMs: STEP } });

/** Columns from T on, one a step, each from the spec at its index (the last spec repeats). */
export function tape(specs: readonly Col[], count = specs.length): LiquidityColumn[] {
  return Array.from({ length: count }, (_, i) => col(T + i * STEP, specs[Math.min(i, specs.length - 1)]));
}

function parse(raw: Record<string, unknown>): L2Frame {
  const frame = parseServerFrame(raw);
  if (frame === null) throw new Error(`fixture rejected: ${JSON.stringify(raw)}`);
  return frame as L2Frame;
}

/** A browser-side L2 store fed frame by frame, and the `ctx.l2` view over it. */
export class L2Feed {
  readonly store = new L2Store();
  readonly l2: IndicatorL2;
  private _wallSeq = 0;
  private _eventSeq = 0;

  constructor(segment: Record<string, unknown> = LIVE) {
    this.walls([], { ts: T, reset: true, segment });
    this.store.apply(parse({ type: "l2_events", ...ID, ts: T, seq: 0, reset: true, missed: 0, events: [] }));
    this.l2 = indicatorL2Of(this.store, () => null)!;
  }

  walls(list: Record<string, unknown>[], { ts = T, reset = false, segment = LIVE as Record<string, unknown> } = {}): void {
    this._wallSeq += 1;
    this.store.apply(parse({ type: "l2_walls", ...ID, ts, seq: this._wallSeq, reset, row_width: ROW, walls: list, removed: [], segment }));
  }

  /** An events increment; the frame's time is `ts`, or the latest event's, never earlier than T. */
  events(list: Record<string, unknown>[], { ts, missed = 0 }: { ts?: number; missed?: number } = {}): void {
    this._eventSeq += list.length;
    const frameTs = ts ?? list.reduce((latest, event) => Math.max(latest, Number(event.ts)), T);
    this.store.apply(parse({ type: "l2_events", ...ID, ts: frameTs, seq: this._eventSeq, reset: false, missed, events: list }));
  }

  /** A trade near the mid: `sell` hits the bid, printed on `row` (the band's hit row by default). */
  sell(ts: number, size: number, row = HIT_ROW): Record<string, unknown> {
    return { event: "trade", ts, side: "bid", aggressor: "sell", mode: "absorbed", price: row * ROW + ROW / 2, size, late: false };
  }

  /** Moves the events frame on to `ts` without a trade: a hidden fill far from the band. */
  tick(ts: number): void {
    this.events([{ event: "hidden", ts, side: "ask", price: 160, volume: 1 }], { ts });
  }

  /** A new segment of the same pair after a data gap: both channels reset. */
  newSegment(segment: Record<string, unknown>, ts: number): void {
    this._eventSeq = 0;
    this.walls([], { ts, reset: true, segment });
    this.store.apply(parse({ type: "l2_events", ...ID, ts, seq: 0, reset: true, missed: 0, events: [] }));
  }

  /** A pair switch: the store is cleared, then the new pair's snapshots arrive. */
  switchPair(segment: Record<string, unknown>, ts: number): void {
    this.store.clear();
    this._eventSeq = 0;
    this.walls([], { ts, reset: true, segment });
    this.store.apply(parse({ type: "l2_events", ...ID, ts, seq: 0, reset: true, missed: 0, events: [] }));
  }


}
