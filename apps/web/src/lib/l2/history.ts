import type { L2EventHistoryFrame, WallHistoryFrame } from "../../types/frames";
import type { L2Wall, L2WallDetail } from "./types";

export type L2HistoryKind = "wall_history" | "l2_event_history";

export interface L2HistoryRequest {
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  cursor?: unknown;
}

export type L2HistoryRequester = (kind: L2HistoryKind, request: L2HistoryRequest) => Promise<WallHistoryFrame | L2EventHistoryFrame | null>;

export interface L2HistoryRange {
  readonly fromTs: number;
  readonly toTs: number;
  readonly priceLo: number;
  readonly priceHi: number;
}

export interface L2WallHistory {
  readonly rowWidth: number;
  readonly walls: readonly L2Wall[];
  readonly next: { readonly endTs: number; readonly hid: number } | null;
}

export interface L2TradeBucket {
  readonly ts: number;
  readonly columnMs: number;
  readonly row: number;
  readonly aggressor: "buy" | "sell";
  readonly mode: "absorbed" | "swept";
  readonly size: number;
  readonly count: number;
}

export interface L2WallTradeBucket {
  readonly ts: number;
  readonly wall: string;
  readonly mode: "absorbed" | "swept";
  readonly size: number;
  readonly count: number;
}

export interface L2EventHistory {
  readonly rowWidth: number;
  readonly trades: readonly L2TradeBucket[];
  readonly wallTrades: readonly L2WallTradeBucket[];
  readonly heldFrom: number;
  readonly next: { readonly trades: unknown; readonly wallTrades: unknown } | null;
}

function detailOf(wire: WallHistoryFrame["walls"][number]["detail"]): L2WallDetail | null {
  if (wire === null) return null;
  return Object.freeze({
    lifeMs: null,
    firstShrinkTs: wire.first_shrink_ts,
    firstShrinkExact: false,
    reachedAtFirstShrink: wire.reached_at_first_shrink,
    traded: wire.traded,
    absorbed: wire.absorbed,
    swept: wire.swept,
    hidden: wire.hidden,
    cleared: wire.cleared,
    fillRatio: wire.fill_ratio,
    crossSide: wire.cross_side,
    crossSideShare: 0,
    endDistanceRows: wire.end_distance_rows,
    endDistancePct: null,
    clearedByTrades: wire.cleared_by_trades,
    continuityGapMs: null,
    repeats: wire.repeats,
    repeatsComplete: false,
    evidenceGap: wire.evidence_gap,
  });
}

export function wallHistoryOf(frame: WallHistoryFrame): L2WallHistory | null {
  if (!frame.complete || frame.row_width === null) return null;
  const walls = frame.walls.map((wire) => Object.freeze({
    id: -wire.hid,
    lane: 0,
    side: wire.side,
    row: wire.row,
    span: wire.span,
    startTs: wire.start_ts,
    endTs: wire.end_ts,
    size: wire.size,
    peak: wire.peak,
    endedBy: wire.ended_by,
    ratio: wire.ratio,
    chain: wire.chain,
    fill: wire.fill,
    eaten: wire.eaten,
    absorbing: false,
    detail: detailOf(wire.detail),
  }));
  return Object.freeze({ rowWidth: frame.row_width, walls: Object.freeze(walls), next: frame.next === null ? null : Object.freeze({ endTs: frame.next.end_ts, hid: frame.next.hid }) });
}

export function eventHistoryOf(frame: L2EventHistoryFrame): L2EventHistory | null {
  if (!frame.complete || frame.row_width === null || frame.trades_held_from === null) return null;
  return Object.freeze({
    rowWidth: frame.row_width,
    trades: Object.freeze(frame.trades.map(([ts, columnMs, row, aggressor, mode, size, count]) => Object.freeze({ ts, columnMs, row, aggressor, mode, size, count }))),
    wallTrades: Object.freeze(frame.wall_trades.map(([ts, wall, mode, size, count]) => Object.freeze({ ts, wall, mode, size, count }))),
    heldFrom: frame.trades_held_from,
    next: frame.next === null ? null : Object.freeze({ trades: frame.next.trades, wallTrades: frame.next.wall_trades }),
  });
}

export function historyRequestOf(range: L2HistoryRange, cursor: unknown = undefined): L2HistoryRequest {
  return { from_ts: range.fromTs, to_ts: range.toTs, price_lo: range.priceLo, price_hi: range.priceHi, ...(cursor === undefined || cursor === null ? {} : { cursor }) };
}
