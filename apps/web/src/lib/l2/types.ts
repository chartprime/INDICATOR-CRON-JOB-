import type { L2Channel, L2EventWire, L2SegmentState, L2WallDetailWire, L2WallVerdict, L2WallWire } from "../../types/frames";

export type { L2Channel, L2SegmentState, L2WallVerdict };

export interface L2Segment {
  readonly id: string;
  readonly state: L2SegmentState;
}

export interface L2WallDetail {
  readonly lifeMs: number | null;
  readonly firstShrinkTs: number | null;
  readonly firstShrinkExact: boolean;
  readonly reachedAtFirstShrink: boolean | null;
  readonly traded: number;
  readonly absorbed: number;
  readonly swept: number;
  readonly hidden: number;
  readonly cleared: number;
  readonly fillRatio: number;
  readonly crossSide: number;
  readonly crossSideShare: number;
  readonly endDistanceRows: number | null;
  readonly endDistancePct: number | null;
  readonly clearedByTrades: boolean;
  readonly continuityGapMs: number | null;
  readonly repeats: number;
  readonly repeatsComplete: boolean;
  readonly evidenceGap: boolean;
}

export interface L2Wall {
  readonly id: number;
  readonly lane: number;
  readonly side: "bid" | "ask";
  readonly row: number;
  readonly span: number;
  readonly startTs: number;
  readonly endTs: number | null;
  readonly size: number;
  readonly peak: number;
  readonly endedBy: L2WallVerdict | null;
  readonly ratio: number;
  readonly chain: number;
  readonly fill: number;
  readonly eaten: number;
  readonly absorbing: boolean;
  readonly detail: L2WallDetail | null;
}

export type L2Event =
  | { readonly kind: "wall_born"; readonly ts: number; readonly wall: number; readonly side: "bid" | "ask"; readonly row: number; readonly span: number; readonly size: number }
  | { readonly kind: "wall_shrink"; readonly ts: number; readonly wall: number; readonly exact: boolean; readonly reached: boolean | null }
  | { readonly kind: "wall_trade"; readonly ts: number; readonly wall: number; readonly mode: "absorbed" | "swept"; readonly price: number; readonly size: number }
  | { readonly kind: "wall_hidden"; readonly ts: number; readonly wall: number; readonly volume: number }
  | { readonly kind: "wall_end"; readonly ts: number; readonly wall: number; readonly endedBy: L2WallVerdict; readonly distanceRows: number | null }
  | { readonly kind: "trade"; readonly ts: number; readonly side: "bid" | "ask"; readonly aggressor: "buy" | "sell"; readonly mode: "absorbed" | "swept"; readonly price: number; readonly size: number; readonly late: boolean }
  | { readonly kind: "hidden"; readonly ts: number; readonly side: "bid" | "ask"; readonly price: number; readonly volume: number }
  | { readonly kind: "segment"; readonly ts: number; readonly segment: string; readonly state: L2SegmentState; readonly cause: string | null };

export interface L2Ladder {
  readonly ts: number;
  readonly depth: number;
  readonly bids: ReadonlyArray<readonly [price: number, size: number]>;
  readonly asks: ReadonlyArray<readonly [price: number, size: number]>;
}

export interface L2LaneInfo {
  readonly lane: number;
  readonly rowWidth: number;
  readonly columnMs: number;
  readonly deepColumnMs: number;
  readonly priceLo: number;
  readonly priceHi: number;
}

export interface L2ChannelStatus {
  readonly synced: boolean;
  readonly seq: number | null;
  readonly lastTs: number | null;
  readonly lastFrameAt: number | null;
}

export type ApplyOutcome = "applied" | "duplicate" | "gap";

function detailOf(wire: L2WallDetailWire | null): L2WallDetail | null {
  if (wire === null) return null;
  return Object.freeze({
    lifeMs: wire.life_ms,
    firstShrinkTs: wire.first_shrink_ts,
    firstShrinkExact: wire.first_shrink_exact,
    reachedAtFirstShrink: wire.reached_at_first_shrink,
    traded: wire.traded,
    absorbed: wire.absorbed,
    swept: wire.swept,
    hidden: wire.hidden,
    cleared: wire.cleared,
    fillRatio: wire.fill_ratio,
    crossSide: wire.cross_side,
    crossSideShare: wire.cross_side_share,
    endDistanceRows: wire.end_distance_rows,
    endDistancePct: wire.end_distance_pct,
    clearedByTrades: wire.cleared_by_trades,
    continuityGapMs: wire.continuity === null ? null : wire.continuity.gap_ms,
    repeats: wire.repeats,
    repeatsComplete: wire.repeats_complete,
    evidenceGap: wire.evidence_gap,
  });
}

export function wallOf(wire: L2WallWire): L2Wall {
  return Object.freeze({
    id: wire.id,
    lane: wire.lane ?? 0,
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
    absorbing: wire.absorbing,
    detail: detailOf(wire.detail),
  });
}

export function eventOf(wire: L2EventWire): L2Event {
  switch (wire.event) {
    case "wall_born":
      return Object.freeze({ kind: "wall_born", ts: wire.ts, wall: wire.wall, side: wire.side, row: wire.row, span: wire.span, size: wire.size });
    case "wall_shrink":
      return Object.freeze({ kind: "wall_shrink", ts: wire.ts, wall: wire.wall, exact: wire.exact, reached: wire.reached });
    case "wall_trade":
      return Object.freeze({ kind: "wall_trade", ts: wire.ts, wall: wire.wall, mode: wire.mode, price: wire.price, size: wire.size });
    case "wall_hidden":
      return Object.freeze({ kind: "wall_hidden", ts: wire.ts, wall: wire.wall, volume: wire.volume });
    case "wall_end":
      return Object.freeze({ kind: "wall_end", ts: wire.ts, wall: wire.wall, endedBy: wire.ended_by, distanceRows: wire.distance_rows });
    case "trade":
      return Object.freeze({ kind: "trade", ts: wire.ts, side: wire.side, aggressor: wire.aggressor, mode: wire.mode, price: wire.price, size: wire.size, late: wire.late });
    case "hidden":
      return Object.freeze({ kind: "hidden", ts: wire.ts, side: wire.side, price: wire.price, volume: wire.volume });
    default:
      return Object.freeze({ kind: "segment", ts: wire.ts, segment: wire.segment, state: wire.state, cause: wire.cause });
  }
}
