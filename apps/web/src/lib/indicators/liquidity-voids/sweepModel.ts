import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { columnFlow, columnMid } from "../absorption-detector/absorptionColumns";

export type VoidSide = "bid" | "ask";
export type SweepEnd = "mitigated";
export type PushVerdict = "light" | "heavy" | "early" | "unknown";

export interface SweepRules {
  windowMs: number;
  minMoveRows: number;
}

export interface SweepBox {
  id: number;
  side: VoidSide;
  rowLo: number;
  rowHi: number;
  startTs: number;
  endTs: number;
  volume: number | null;
  open: boolean;
  endedAt: number | null;
  endedBy: SweepEnd | null;
  verdict: PushVerdict | null;
}

interface Sample {
  ts: number;
  midRow: number;
  column: LiquidityColumn;
}

export interface SweepState {
  samples: Sample[];
  open: SweepBox | null;
  boxes: SweepBox[];
  nextId: number;
  lastTs: number | null;
  lastColumnMs: number;
  gapTs: number;
  rowWidth: number;
  carried: Map<number, number>;
  carriedKnown: boolean;
}

export const DEFAULT_SWEEP_RULES: SweepRules = Object.freeze({
  windowMs: 30_000,
  minMoveRows: 2,
});

export const MAX_SWEEP_BOXES = 64;
export const GAP_COLUMNS = 2;
export const MIN_HOLE_MS = 20_000;
export const MAX_SWEEP_MS = 600_000;

export function createSweepState(rowWidth: number): SweepState {
  return { samples: [], open: null, boxes: [], nextId: 1, lastTs: null, lastColumnMs: 0, gapTs: -Infinity, rowWidth, carried: new Map(), carriedKnown: true };
}

function sampleAtOrBefore(samples: readonly Sample[], ts: number): Sample | null {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? samples[lo - 1] : null;
}

function flowKnown(column: LiquidityColumn): boolean {
  return column.buy !== undefined || column.sell !== undefined;
}

function carry(state: SweepState, sample: Sample): void {
  const open = state.open;
  if (open === null || sample.ts < open.startTs || sample.ts >= open.endTs) return;
  if (!flowKnown(sample.column)) {
    state.carriedKnown = false;
    return;
  }
  for (const [row, size] of sample.column[open.side === "ask" ? "buy" : "sell"] ?? []) state.carried.set(row, (state.carried.get(row) ?? 0) + size);
}

function aggressiveVolume(state: SweepState, box: SweepBox): number | null {
  if (!state.carriedKnown) return null;
  const side = box.side === "ask" ? "buy" : "sell";
  let volume = 0;
  for (const [row, size] of state.carried) if (row >= box.rowLo && row <= box.rowHi) volume += size;
  for (const sample of state.samples) {
    if (sample.ts < box.startTs || sample.ts >= box.endTs) continue;
    if (!flowKnown(sample.column)) return null;
    volume += columnFlow(sample.column, side, box.rowLo, box.rowHi);
  }
  return volume;
}

function openSweep(state: SweepState, side: VoidSide, rowLo: number, rowHi: number, startTs: number, endTs: number): void {
  closeOpen(state);
  const box: SweepBox = { id: state.nextId++, side, rowLo, rowHi, startTs, endTs, volume: null, open: true, endedAt: null, endedBy: null, verdict: null };
  state.boxes.push(box);
  state.open = box;
  state.carried = new Map();
  state.carriedKnown = true;
  if (state.boxes.length > MAX_SWEEP_BOXES) {
    const dropped = state.boxes.shift();
    if (dropped === state.open) state.open = null;
  }
}

function endBox(state: SweepState, box: SweepBox, at: number, by: SweepEnd): void {
  box.endedAt = at;
  box.endedBy = by;
  if (state.open === box) {
    box.open = false;
    state.open = null;
  }
}

function closeOpen(state: SweepState): void {
  if (state.open === null) return;
  state.open.open = false;
  state.open = null;
}

function prune(state: SweepState, ts: number, rules: SweepRules): void {
  state.boxes = state.boxes.filter((box) => box.endedAt === null || ts - box.endedAt < rules.windowMs);
}

export function stepSweeps(state: SweepState, column: LiquidityColumn, rules: SweepRules, columnMs = 0): void {
  if (state.lastTs !== null && column.ts <= state.lastTs) return;
  const spacing = Math.max(state.lastColumnMs, columnMs);
  if (state.lastTs !== null && column.ts - state.lastTs > Math.max(GAP_COLUMNS * spacing, MIN_HOLE_MS)) state.gapTs = column.ts;
  state.lastTs = column.ts;
  state.lastColumnMs = columnMs;
  const mid = columnMid(column, state.rowWidth);
  if (mid === null) return;
  const midRow = mid / state.rowWidth;
  const ts = column.ts;
  state.samples.push({ ts, midRow, column });
  const keepFrom = Math.max(ts - MAX_SWEEP_MS, Math.min(ts - rules.windowMs, state.open?.startTs ?? Infinity));
  while (state.samples.length > 1 && state.samples[0].ts < keepFrom && state.samples[1].ts <= ts - rules.windowMs) carry(state, state.samples.shift() as Sample);

  const before = sampleAtOrBefore(state.samples, ts - rules.windowMs);
  let extended = false;
  if (before !== null && before.ts < ts && before.ts >= state.gapTs) {
    const moved = midRow - before.midRow;
    const rows = Math.abs(moved);
    if (rows >= rules.minMoveRows) {
      const rowLo = Math.floor(Math.min(midRow, before.midRow));
      const rowHi = Math.ceil(Math.max(midRow, before.midRow)) - 1;
      const side: VoidSide = moved > 0 ? "ask" : "bid";
      const open = state.open;
      if (open !== null && open.side === side && before.ts <= open.endTs) {
        extended = true;
        const newGround = side === "ask" ? rowHi > open.rowHi : rowLo < open.rowLo;
        open.rowLo = Math.min(open.rowLo, rowLo);
        open.rowHi = Math.max(open.rowHi, rowHi);
        if (newGround) open.endTs = ts;
      } else {
        openSweep(state, side, rowLo, rowHi, before.ts, ts);
        extended = true;
      }
    }
  }
  if (extended && state.open !== null) state.open.volume = aggressiveVolume(state, state.open);
  if (!extended && state.open !== null && ts > state.open.endTs) closeOpen(state);
  prune(state, ts, rules);
}

export function noteSweepClose(state: SweepState, barOpen: number, closeTs: number, closeRow: number): void {
  for (const box of state.boxes) {
    if (box.endedAt !== null || box.endTs > barOpen) continue;
    const mitigated = box.side === "ask" ? closeRow < box.rowLo : closeRow > box.rowHi;
    if (mitigated) endBox(state, box, closeTs, "mitigated");
  }
}

export function liveSweeps(state: SweepState): SweepBox[] {
  return state.boxes.filter((box) => box.endedAt === null);
}

export function resetSweeps(state: SweepState, rowWidth: number, keepStartedBefore = -Infinity): void {
  closeOpen(state);
  state.samples = [];
  state.boxes = state.boxes.filter((box) => box.startTs < keepStartedBefore);
  state.lastTs = null;
  state.lastColumnMs = 0;
  state.gapTs = -Infinity;
  state.rowWidth = rowWidth;
}
