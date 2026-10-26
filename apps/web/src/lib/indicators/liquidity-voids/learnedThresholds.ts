import { columnMid } from "../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { DEFAULT_SWEEP_RULES, stepSweeps, type PushVerdict, type SweepBox, type SweepState } from "./sweepModel";

export const SLOT_MS = 10_000;
export const BASE_WINDOW_MS = 30_000;
export const WINDOW_POWER = 0.68;
export const WINDOW_LADDER_MS: ReadonlyMap<number, number> = new Map([
  [60_000, 30_000],
  [300_000, 90_000],
  [900_000, 180_000],
  [3_600_000, 480_000],
  [14_400_000, 1_200_000],
  [86_400_000, 4_200_000],
]);
export const MOVE_WINDOWS = 60;
export const MIN_MOVE_WINDOWS = 30;
export const MOVE_QUANTILE = 0.9;
export const VOLUME_MEMORY_MS = 1_800_000;
export const MIN_VOLUME_SAMPLES = 60;
export const RANK_PUSHES = 60;
export const MIN_RANK_PUSHES = 8;
export const LIGHT_SHARE = 0.25;
export const WAIT_WINDOWS = 3;
export const GAP_WINDOWS = 2;
export const MIN_GAP_MS = 600_000;
export const MIN_RECOMPUTE_MS = 60_000;
export const NOT_READY_ROWS = Number.MAX_SAFE_INTEGER;

interface Ring {
  values: Float64Array;
  head: number;
  count: number;
}

export interface LearnedState {
  windowMs: number;
  steps: number;
  slot: number | null;
  slotMid: number | null;
  slotTraded: number;
  slotFlow: boolean;
  mids: Float64Array;
  midSlots: Float64Array;
  moves: Ring;
  traded: Ring;
  scores: Ring;
  usual: number;
  perSecond: number;
  nextRecomputeAt: number;
  lastTs: number | null;
  sinceGap: number;
  steady: boolean;
  syncId: number;
  syncedScores: number;
  settledId: number;
}

export function windowMsFor(intervalMs: number): number {
  const listed = WINDOW_LADDER_MS.get(intervalMs);
  if (listed !== undefined) return listed;
  const minutes = intervalMs / 60_000;
  if (!(minutes > 0)) return BASE_WINDOW_MS;
  return Math.max(SLOT_MS, Math.round((BASE_WINDOW_MS * minutes ** WINDOW_POWER) / SLOT_MS) * SLOT_MS);
}

function stepsOf(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / SLOT_MS));
}

export function settleSpanMs(windowMs: number): number {
  return Math.max((MOVE_WINDOWS + 1) * stepsOf(windowMs) * SLOT_MS, VOLUME_MEMORY_MS);
}

function ring(size: number): Ring {
  return { values: new Float64Array(size), head: 0, count: 0 };
}

function remember(ring: Ring, value: number): void {
  ring.values[ring.head] = value;
  ring.head = (ring.head + 1) % ring.values.length;
  if (ring.count < ring.values.length) ring.count += 1;
}

function isFull(ring: Ring): boolean {
  return ring.count === ring.values.length;
}

function quantileOf(ring: Ring, q: number): number {
  const sorted = ring.values.slice(0, ring.count).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function meanOf(ring: Ring): number {
  let total = 0;
  for (const value of ring.values.slice(0, ring.count).sort()) total += value;
  return total / ring.count;
}

function normalPace(traded: Ring): number {
  const median = quantileOf(traded, 0.5);
  return median > 0 ? median : meanOf(traded);
}

export function createLearned(windowMs: number): LearnedState {
  const steps = stepsOf(windowMs);
  return {
    windowMs, steps, slot: null, slotMid: null, slotTraded: 0, slotFlow: false,
    mids: new Float64Array(steps + 1), midSlots: new Float64Array(steps + 1).fill(-1),
    moves: ring(MOVE_WINDOWS * steps), traded: ring(VOLUME_MEMORY_MS / SLOT_MS), scores: ring(RANK_PUSHES),
    usual: NaN, perSecond: NaN, nextRecomputeAt: -Infinity, lastTs: null, sinceGap: 0,
    steady: false, syncId: Infinity, syncedScores: 0, settledId: Infinity,
  };
}

function flowOf(column: LiquidityColumn): number | null {
  if (column.buy === undefined && column.sell === undefined) return null;
  let total = 0;
  for (const [, size] of column.buy ?? []) total += size;
  for (const [, size] of column.sell ?? []) total += size;
  return total;
}

function closeSlot(learned: LearnedState): void {
  const slot = learned.slot as number;
  const cap = learned.mids.length;
  const mid = learned.slotMid;
  if (mid !== null && mid > 0) {
    const back = slot - learned.steps;
    const at = ((back % cap) + cap) % cap;
    if (learned.midSlots[at] === back) remember(learned.moves, (Math.abs(mid - learned.mids[at]) / mid) * 10_000);
    learned.mids[slot % cap] = mid;
    learned.midSlots[slot % cap] = slot;
  }
  if (learned.slotFlow) remember(learned.traded, learned.slotTraded / (SLOT_MS / 1_000));
  learned.sinceGap += 1;
}

function recompute(learned: LearnedState): void {
  learned.usual = learned.moves.count >= MIN_MOVE_WINDOWS * learned.steps ? quantileOf(learned.moves, MOVE_QUANTILE) : NaN;
  learned.perSecond = learned.traded.count >= MIN_VOLUME_SAMPLES ? normalPace(learned.traded) : NaN;
  if (isFull(learned.moves) && isFull(learned.traded)) learned.steady = true;
}

export function noteColumn(learned: LearnedState, column: LiquidityColumn, mid: number | null): void {
  const ts = column.ts;
  const slot = Math.floor(ts / SLOT_MS);
  if (learned.slot !== null && slot !== learned.slot) closeSlot(learned);
  if (learned.slot !== slot) {
    learned.slot = slot;
    learned.slotMid = null;
    learned.slotTraded = 0;
    learned.slotFlow = false;
  }
  if (learned.lastTs !== null && ts - learned.lastTs > Math.max(GAP_WINDOWS * learned.windowMs, MIN_GAP_MS)) learned.sinceGap = 0;
  if (mid !== null) learned.slotMid = mid;
  const flow = flowOf(column);
  if (flow !== null) {
    learned.slotFlow = true;
    learned.slotTraded += flow;
  }
  if (ts >= learned.nextRecomputeAt) {
    recompute(learned);
    const every = Math.max(MIN_RECOMPUTE_MS, learned.windowMs / 2);
    learned.nextRecomputeAt = (Math.floor(ts / every) + 1) * every;
  }
  learned.lastTs = ts;
}

export function learnedReady(learned: LearnedState): boolean {
  return learned.usual > 0 && learned.sinceGap >= WAIT_WINDOWS * learned.steps;
}

export function learnedHasEnough(learned: LearnedState): boolean {
  return learned.usual > 0 && learned.perSecond > 0 && learned.scores.count >= MIN_RANK_PUSHES;
}

export function minMoveRowsOf(learned: LearnedState, k: number, mid: number | null, rowWidth: number): number {
  if (mid === null || !learnedReady(learned)) return NOT_READY_ROWS;
  return Math.max(DEFAULT_SWEEP_RULES.minMoveRows, Math.round((k * learned.usual * mid) / 10_000 / rowWidth));
}

export function judge(learned: LearnedState, box: SweepBox): PushVerdict {
  if (box.volume === null) return "unknown";
  if (!(learned.perSecond > 0)) return "early";
  const score = box.volume / (learned.perSecond * (Math.max(SLOT_MS, box.endTs - box.startTs) / 1_000));
  const verdict: PushVerdict = learned.scores.count < MIN_RANK_PUSHES ? "early" : score <= quantileOf(learned.scores, LIGHT_SHARE) ? "light" : "heavy";
  remember(learned.scores, score);
  return verdict;
}

function judgeClosed(learned: LearnedState, sweep: SweepState): PushVerdict | null {
  let last: PushVerdict | null = null;
  for (let i = 0; i < sweep.boxes.length; i += 1) {
    const box = sweep.boxes[i];
    if (box.open || box.verdict !== null) continue;
    const head = learned.scores.head;
    box.verdict = judge(learned, box);
    if (learned.scores.head !== head && box.id >= learned.syncId) {
      learned.syncedScores += 1;
      if (learned.syncedScores === RANK_PUSHES) learned.settledId = box.id + 1;
    }
    last = box.verdict;
    if (box.verdict !== "light") {
      sweep.boxes.splice(i, 1);
      i -= 1;
    }
  }
  return last;
}

export function stepLearned(learned: LearnedState, sweep: SweepState, column: LiquidityColumn, columnMs: number, k: number): PushVerdict | null {
  if (sweep.lastTs !== null && column.ts <= sweep.lastTs) return null;
  const mid = columnMid(column, sweep.rowWidth);
  noteColumn(learned, column, mid);
  stepSweeps(sweep, column, { windowMs: learned.windowMs, minMoveRows: minMoveRowsOf(learned, k, mid, sweep.rowWidth) }, columnMs);
  if (learned.steady && learned.syncId === Infinity && mid !== null && sweep.open === null) learned.syncId = sweep.nextId;
  return judgeClosed(learned, sweep);
}
