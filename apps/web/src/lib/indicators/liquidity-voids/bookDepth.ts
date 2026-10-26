import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";

export const DEPTH_TYPICAL_MS = 3_600_000;
export const MIN_DEPTH_SAMPLES = 60;
export const THIN_BOOK_RATIO = 1.5;
export const THICK_BOOK_RATIO = 0.5;

export type BookLabel = "thin book" | "normal book" | "thick book";

export interface BookDepthState {
  samples: { ts: number; value: number }[];
}

export interface BookVerdict {
  value: number;
  typical: number;
  ratio: number;
  label: BookLabel;
}

export function createBookDepth(): BookDepthState {
  return { samples: [] };
}

function rowsToFill(sizes: Float64Array, from: number, step: 1 | -1, size: number): number {
  let filled = 0;
  let rows = 0;
  for (let i = from; i >= 0 && i < sizes.length; i += step) {
    rows += 1;
    filled += sizes[i];
    if (filled >= size) break;
  }
  return rows;
}

export function fillDistance(column: LiquidityColumn, size: number, rowWidth: number): number | null {
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
  if (bidAt < 0 || askAt < 0) return null;
  return ((rowsToFill(column.bid, bidAt, -1, size) + rowsToFill(column.ask, askAt, 1, size)) / 2) * rowWidth;
}

export function noteDepth(state: BookDepthState, ts: number, value: number): void {
  const last = state.samples[state.samples.length - 1];
  if (last !== undefined && ts <= last.ts) return;
  state.samples.push({ ts, value });
  const keepFrom = ts - DEPTH_TYPICAL_MS;
  let drop = 0;
  while (drop < state.samples.length - 1 && state.samples[drop].ts < keepFrom) drop += 1;
  if (drop > 0) state.samples.splice(0, drop);
}

export function judgeBook(state: BookDepthState): BookVerdict | null {
  if (state.samples.length < MIN_DEPTH_SAMPLES) return null;
  const sorted = state.samples.map((sample) => sample.value).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)];
  if (!(typical > 0)) return null;
  const value = state.samples[state.samples.length - 1].value;
  const ratio = value / typical;
  const label: BookLabel = ratio > THIN_BOOK_RATIO ? "thin book" : ratio < THICK_BOOK_RATIO ? "thick book" : "normal book";
  return { value, typical, ratio, label };
}

export function resetBookDepth(state: BookDepthState): void {
  state.samples = [];
}
