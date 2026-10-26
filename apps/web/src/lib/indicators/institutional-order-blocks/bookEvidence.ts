import { columnFlow, eachColumn, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import { WALL_HOLE_MS, WALL_KEEP_SHARE } from "../absorption-detector/absorptionWalls";
import type { OrderBlockSide } from "../classic-order-blocks/orderBlockRules";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { zoneRows, type BookEvidence } from "./institutionalRules";

export const HOLE_MS = WALL_HOLE_MS;

export interface EvidenceRules {
  wall: number;
  bandRows: number;
  flashMs: number;
  /**
   * A row outside the column is unobserved, not empty. True for historical
   * top-of-book columns, whose edge is the depth the source saw; a live or
   * band-history column's edge is only where its answer was cut, so a band
   * crossing it is read over the rows it holds.
   */
  edgeUnknown?: boolean;
  partial?: boolean;
}

export interface EvidenceZone {
  side: OrderBlockSide;
  top: number;
  bottom: number;
  pivotTime: number;
  baseTime: number;
  breakTime: number;
}

export interface BookColumns {
  feed: ColumnFeed;
  rowWidth: number;
}

export interface RecordingGap {
  from: number;
  to: number;
}

/**
 * `gap`: the book says Rejected, but part of the zone's window was never recorded (`missing`), so the rejection
 * cannot be told from a gap the wall stood through. A recording gap can confirm a zone, never reject it.
 */
export type UnverifiableReason = "feed" | "rows" | "before" | "after" | "hole" | "older" | "gap";

/** `missing` is the first stretch of the zone's window the book did not record, or null when it recorded all of it. */
export type EvidenceRead = { kind: "evidence"; evidence: BookEvidence; missing: RecordingGap | null } | { kind: "unverifiable"; reason: UnverifiableReason; gap?: RecordingGap };

export interface ZoneRead {
  lastTs: number | null;
  run: { since: number } | null;
  firstInWindow: number | null;
  held: boolean;
  peak: number;
  current: number;
  hit: number;
  buy: number;
  sell: number;
  hole: RecordingGap | null;
  gap: RecordingGap | null;
  tierMs: number | null;
}

export function createZoneRead(): ZoneRead {
  return { lastTs: null, run: null, firstInWindow: null, held: false, peak: 0, current: 0, hit: 0, buy: 0, sell: 0, hole: null, gap: null, tierMs: null };
}

export function wallTier(feed: ColumnFeed): ColumnFeed {
  return feed.deep === null ? feed : { epoch: feed.epoch, deep: null, fine: feed.deep };
}

export function oldestWallColumnTs(feed: ColumnFeed): number {
  return wallTier(feed).fine.columns[0]?.ts ?? Infinity;
}

export function holeFilled(feed: ColumnFeed, gap: RecordingGap): boolean {
  let filled = false;
  eachColumn(wallTier(feed), gap.from + 1, gap.to - 1, () => {
    filled = true;
    return true;
  });
  return filled;
}

function biggestBand(column: LiquidityColumn, side: "bid" | "ask", rowLo: number, rowHi: number, bandRows: number, edgeUnknown: boolean): number {
  const cells = column[side];
  const rows = Math.max(1, Math.floor(bandRows));
  let biggest = 0;
  for (let band = Math.floor(rowLo / rows); band <= Math.floor(rowHi / rows); band += 1) {
    const from = band * rows;
    const to = from + rows - 1;
    if (edgeUnknown && (from < column.lo || to > column.hi)) return NaN;
    let size = 0;
    for (let row = Math.max(from, column.lo); row <= Math.min(to, column.hi); row += 1) {
      if (!Number.isFinite(cells[row - column.lo])) return NaN;
      size += cells[row - column.lo];
    }
    if (size > biggest) biggest = size;
  }
  return biggest;
}

function flowTotal(column: LiquidityColumn, side: "buy" | "sell"): number {
  const entries = column[side];
  if (entries === undefined) return 0;
  let volume = 0;
  for (const [, size] of entries) volume += size;
  return volume;
}

export function readZone(state: ZoneRead, book: BookColumns, zone: EvidenceZone, barMs: number, upTo: number, rules: EvidenceRules): EvidenceRead {
  const rows = zoneRows(zone.top, zone.bottom, book.rowWidth);
  if (rows === null) return { kind: "unverifiable", reason: "rows" };
  if (state.hole !== null) return { kind: "unverifiable", reason: "hole", gap: state.hole };
  const { rowLo, rowHi } = rows;
  const restSide = zone.side === "bullish" ? "bid" : "ask";
  const attackSide = zone.side === "bullish" ? "sell" : "buy";
  const windowEnd = zone.breakTime + barMs;
  const tier = wallTier(book.feed);
  const tierMs = tier.fine.columnMs;
  let from = state.lastTs === null ? zone.pivotTime - rules.flashMs : state.lastTs + 1;

  const visit = (column: LiquidityColumn): boolean | void => {
    const inWindow = column.ts >= zone.pivotTime;
    if (state.lastTs !== null && column.ts - state.lastTs > HOLE_MS) {
      state.run = null;
      if (inWindow && state.firstInWindow !== null && state.lastTs < windowEnd - HOLE_MS && state.gap === null) state.gap = { from: state.lastTs, to: column.ts };
    }
    state.lastTs = column.ts;
    const size = biggestBand(column, restSide, rowLo, rowHi, rules.bandRows, rules.edgeUnknown === true);
    if (!Number.isFinite(size)) {
      state.hole = { from: column.ts, to: column.ts };
      state.run = null;
      return true;
    }
    state.current = size;
    if (state.run !== null && size < rules.wall * WALL_KEEP_SHARE) state.run = null;
    if (state.run === null && size >= rules.wall) state.run = { since: column.ts };
    if (!inWindow) return;
    if (state.firstInWindow === null) state.firstInWindow = column.ts;
    if (state.run !== null && column.ts - state.run.since >= rules.flashMs) {
      state.held = true;
      if (size > state.peak) state.peak = size;
    }
    state.hit += columnFlow(column, attackSide, rowLo, rowHi);
    if (column.ts >= zone.baseTime && column.ts < windowEnd) {
      state.buy += flowTotal(column, "buy");
      state.sell += flowTotal(column, "sell");
    }
  };

  let readTier = true;
  if (state.lastTs !== null && state.tierMs !== null && state.tierMs < tierMs) {
    const next = (Math.floor(state.lastTs / tierMs) + 1) * tierMs;
    eachColumn({ epoch: book.feed.epoch, deep: null, fine: book.feed.fine }, from, Math.min(next, upTo) - 1, visit);
    if (upTo < next) readTier = false;
    else from = next;
  }
  if (readTier && state.hole === null) {
    state.tierMs = tierMs;
    eachColumn(tier, from, upTo - 1, visit);
  }

  if (state.hole !== null) return { kind: "unverifiable", reason: "hole", gap: state.hole };
  if (state.firstInWindow === null || (rules.partial !== true && state.firstInWindow > zone.pivotTime + HOLE_MS)) return { kind: "unverifiable", reason: "before" };
  if (state.lastTs === null || (rules.partial !== true && state.lastTs < windowEnd - HOLE_MS)) return { kind: "unverifiable", reason: "after" };
  const total = state.buy + state.sell;
  const delta = total > 0 ? (state.buy - state.sell) / total : 0;
  const readTo = Math.min(windowEnd, upTo);
  const missing =
    state.gap ??
    (state.firstInWindow > zone.pivotTime + HOLE_MS
      ? { from: zone.pivotTime, to: state.firstInWindow }
      : state.lastTs < readTo - HOLE_MS
        ? { from: state.lastTs, to: readTo }
        : null);
  return {
    kind: "evidence",
    missing,
    evidence: {
      held: state.held,
      standing: state.run !== null,
      peak: state.peak,
      current: state.current,
      hit: state.hit,
      delta: zone.side === "bullish" ? delta : -delta,
    },
  };
}
