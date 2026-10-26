import { instrumentKey } from "../../chart/drawingStore";
import { STREAM_CHUNK_MS, STREAM_LEVEL_MS, type ColumnHistoryStream, type StreamPage } from "../passive-liquidity/columnHistoryStream";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { stepLearned, type LearnedState } from "./learnedThresholds";
import type { Identity } from "./liquidityVoidsRules";
import { createSweepState, noteSweepClose, stepSweeps, type SweepRules, type SweepState } from "./sweepModel";

export const PAST_STALE_MS = 600_000;

export interface PastHour {
  columns: LiquidityColumn[];
  coveredTo: number;
}

export interface PastSlot {
  rowWidth: number;
  hours: Map<number, PastHour>;
  pending: Map<number, LiquidityColumn[]>;
  refreshing: Set<number>;
  failed: Set<number>;
  version: number;
  unsubscribe: (() => void) | null;
  merged: { version: number; columns: LiquidityColumn[] } | null;
}

export interface PastBar {
  open: number;
  close: number | null;
}

export interface ReplayColumn {
  column: LiquidityColumn;
  columnMs: number;
}

const slots = new Map<string, PastSlot>();
let attached: { stream: ColumnHistoryStream; slot: PastSlot } | null = null;

export function pastSlotFor(identity: Identity, rowWidth: number): PastSlot {
  const key = `${instrumentKey(identity)}:${rowWidth}`;
  let slot = slots.get(key);
  if (slot === undefined) {
    slot = { rowWidth, hours: new Map(), pending: new Map(), refreshing: new Set(), failed: new Set(), version: 0, unsubscribe: null, merged: null };
    slots.set(key, slot);
  }
  return slot;
}

function chunkStartOf(ts: number): number {
  return Math.floor(ts / STREAM_CHUNK_MS) * STREAM_CHUNK_MS;
}

export function pastLoaded(slot: PastSlot, fromTs: number, beforeTs: number): boolean {
  if (!(beforeTs > fromTs)) return true;
  for (let start = chunkStartOf(fromTs); start < beforeTs; start += STREAM_CHUNK_MS) if (!slot.hours.has(start) && !slot.failed.has(start)) return false;
  return true;
}

export function heldFrom(slot: PastSlot, fromTs: number, beforeTs: number): number {
  let from = beforeTs;
  for (let start = chunkStartOf(beforeTs - 1); start >= chunkStartOf(fromTs); start -= STREAM_CHUNK_MS) {
    const hour = slot.hours.get(start);
    if (hour === undefined) break;
    if (hour.columns.length > 0 && hour.columns[0].ts < beforeTs) from = start;
  }
  return from;
}

export function resetPastSlotsForTests(): void {
  attached?.slot.unsubscribe?.();
  attached = null;
  slots.clear();
}

export function slimColumn(column: LiquidityColumn): LiquidityColumn | null {
  let bidAt = -1;
  for (let i = column.bid.length - 1; i >= 0; i -= 1) {
    if (column.bid[i] > 0) {
      bidAt = i;
      break;
    }
  }
  let askAt = -1;
  for (let i = 0; i < column.ask.length; i += 1) {
    if (column.ask[i] > 0) {
      askAt = i;
      break;
    }
  }
  if (bidAt < 0 && askAt < 0) return null;
  const from = bidAt < 0 ? askAt : askAt < 0 ? bidAt : Math.min(bidAt, askAt);
  const to = Math.max(bidAt, askAt);
  const bid = new Float64Array(to - from + 1);
  const ask = new Float64Array(to - from + 1);
  if (bidAt >= 0) bid[bidAt - from] = column.bid[bidAt];
  if (askAt >= 0) ask[askAt - from] = column.ask[askAt];
  const slim: LiquidityColumn = { ts: column.ts, lo: column.lo + from, hi: column.lo + to, bid, ask };
  if (column.buy !== undefined) slim.buy = column.buy;
  if (column.sell !== undefined) slim.sell = column.sell;
  return slim;
}

function onPage(slot: PastSlot, page: StreamPage): void {
  if (page.rowWidth !== slot.rowWidth) return;
  let list = slot.pending.get(page.chunkStart);
  if (list === undefined) {
    list = [];
    slot.pending.set(page.chunkStart, list);
  }
  let last = list.length > 0 ? list[list.length - 1].ts : -Infinity;
  for (const window of page.windows) {
    for (const column of window.columns) {
      if (column.ts <= last) continue;
      last = column.ts;
      const slim = slimColumn(column);
      if (slim !== null) list.push(slim);
    }
  }
}

function onChunk(slot: PastSlot, start: number, done: boolean, toTs: number): void {
  const columns = slot.pending.get(start) ?? [];
  slot.pending.delete(start);
  if (!done) {
    slot.failed.add(start);
    return;
  }
  slot.failed.delete(start);
  slot.refreshing.delete(start);
  slot.hours.set(start, { columns, coveredTo: Math.min(start + STREAM_CHUNK_MS, toTs) });
  slot.version += 1;
}

function staleHours(slot: PastSlot, seam: number): number[] {
  const stale: number[] = [];
  for (const [start, hour] of slot.hours) {
    if (!slot.refreshing.has(start) && hour.coveredTo < Math.min(start + STREAM_CHUNK_MS, seam) - PAST_STALE_MS) stale.push(start);
  }
  return stale;
}

export function askPast(slot: PastSlot, stream: ColumnHistoryStream, fromTs: number, seam: number): void {
  const rebind = attached === null || attached.stream !== stream || attached.slot !== slot;
  if (rebind) {
    if (attached !== null) {
      attached.slot.unsubscribe?.();
      attached.slot.unsubscribe = null;
      attached.slot.pending.clear();
    }
    slot.refreshing.clear();
    slot.failed.clear();
    slot.unsubscribe = stream.subscribe({ onPage: (page) => onPage(slot, page), onChunk: (start, done, toTs) => onChunk(slot, start, done, toTs) });
    attached = { stream, slot };
  }
  const stale = staleHours(slot, seam);
  if (rebind || stale.length > 0) {
    for (const start of stale) slot.refreshing.add(start);
    slot.pending.clear();
    stream.reset([...slot.hours.keys()].filter((start) => !slot.refreshing.has(start)));
  }
  if (seam > fromTs) stream.want(fromTs, seam, 0, 0);
}

export function pastColumns(slot: PastSlot, fromTs: number, beforeTs: number): { columns: LiquidityColumn[]; end: number } {
  if (slot.merged === null || slot.merged.version !== slot.version) {
    const columns: LiquidityColumn[] = [];
    for (const start of [...slot.hours.keys()].sort((a, b) => a - b)) {
      for (const column of slot.hours.get(start)?.columns ?? []) {
        if (columns.length === 0 || column.ts > columns[columns.length - 1].ts) columns.push(column);
      }
    }
    slot.merged = { version: slot.version, columns };
  }
  let end = -Infinity;
  for (const hour of slot.hours.values()) end = Math.max(end, hour.coveredTo);
  return { columns: slot.merged.columns.filter((column) => column.ts >= fromTs && column.ts < beforeTs), end: Math.min(end, beforeTs) };
}

export function replayPast(columns: readonly LiquidityColumn[], bars: readonly PastBar[], intervalMs: number, rules: SweepRules, rowWidth: number): SweepState {
  const state = createSweepState(rowWidth);
  let next = 0;
  for (const bar of bars) {
    const end = bar.open + intervalMs;
    while (next < columns.length && columns[next].ts < end) {
      stepSweeps(state, columns[next], rules, STREAM_LEVEL_MS);
      next += 1;
    }
    if (bar.close !== null) noteSweepClose(state, bar.open, end, Math.floor(bar.close / rowWidth));
  }
  while (next < columns.length) {
    stepSweeps(state, columns[next], rules, STREAM_LEVEL_MS);
    next += 1;
  }
  return state;
}

export function replayLearned(sweep: SweepState, learned: LearnedState, k: number, columns: readonly ReplayColumn[], bars: readonly PastBar[], intervalMs: number): void {
  let next = 0;
  for (const bar of bars) {
    const end = bar.open + intervalMs;
    while (next < columns.length && columns[next].column.ts < end) {
      stepLearned(learned, sweep, columns[next].column, columns[next].columnMs, k);
      next += 1;
    }
    if (bar.close !== null) noteSweepClose(sweep, bar.open, end, Math.floor(bar.close / sweep.rowWidth));
  }
  while (next < columns.length) {
    stepLearned(learned, sweep, columns[next].column, columns[next].columnMs, k);
    next += 1;
  }
}
