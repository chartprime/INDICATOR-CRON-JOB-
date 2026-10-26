import type { LiquidityColumnFrame, LiquidityPrint } from "../../../types/frames";
import { inChartSession, type SessionScoped } from "../../chart/marketCalendar";
import {
  LIQUIDITY_CEILING_ALPHA,
  LIQUIDITY_REFERENCE_ALPHA,
  LIQUIDITY_REFERENCE_BP,
  LIQUIDITY_REFERENCE_PERCENTILE,
  decodeLiquidityColumn,
  liquidityPercentile,
  seededCeiling,
  type LiquidityColumn,
} from "./liquidityGrid";

export const HISTORY_WINDOW_MS = 300_000;
export const HISTORY_LEVELS_MS: readonly number[] = Object.freeze([10_000, 30_000, 60_000, 300_000]);
export const HISTORY_ROW_FACTORS: readonly number[] = Object.freeze([1, 2, 4, 8, 16, 32, 64]);
const WINDOW_STATES: readonly string[] = Object.freeze(["COVERED", "PARTIAL", "NO_DATA", "FAILED"]);
const MAX_PRINTS = 64;

export type HistoryWindowState = "COVERED" | "PARTIAL" | "NO_DATA" | "FAILED";

export interface HistoryWindow {
  ts: number;
  state: HistoryWindowState;
  columns: LiquidityColumn[];
}

export interface HistorySpan {
  oldest: number | null;
  newest: number | null;
}

export type DecodedHistoryPage =
  | {
      available: true;
      generation: string | null;
      levelMs: number;
      rowFactor: number;
      rowWidth: number;
      span: HistorySpan;
      next: number | null;
      windows: HistoryWindow[];
    }
  | { available: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isEntryList(value: unknown, span: number | null): value is [number, number][] {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2
    && isSafeInteger(entry[0]) && entry[0] >= 0 && (span === null || entry[0] < span)
    && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0);
}

function isPrint(value: unknown): value is LiquidityPrint {
  return isRecord(value) && typeof value.ts === "number" && typeof value.price === "number" && typeof value.size === "number"
    && (value.side === "buy" || value.side === "sell") && (value.id === null || value.id === undefined || typeof value.id === "string" || typeof value.id === "number");
}

function wireColumn(value: unknown, windowTs: number, levelMs: number): LiquidityColumnFrame | null {
  if (!isRecord(value) || !isSafeInteger(value.ts) || !isSafeInteger(value.lo) || !isSafeInteger(value.hi) || value.lo > value.hi) return null;
  if (value.ts < windowTs || value.ts >= windowTs + HISTORY_WINDOW_MS || value.ts % levelMs !== 0) return null;
  const span = value.hi - value.lo + 1;
  if (!isEntryList(value.bid, span) || !isEntryList(value.ask, span)) return null;
  if (value.buy !== undefined && !isEntryList(value.buy, span)) return null;
  if (value.sell !== undefined && !isEntryList(value.sell, span)) return null;
  if (value.prints !== undefined && (!Array.isArray(value.prints) || value.prints.length > MAX_PRINTS || !value.prints.every(isPrint))) return null;
  if (value.printsFloor !== undefined && (typeof value.printsFloor !== "number" || !Number.isFinite(value.printsFloor))) return null;
  const column: LiquidityColumnFrame = { ts: value.ts, lo: value.lo, hi: value.hi, bid: value.bid, ask: value.ask };
  if (value.buy !== undefined) column.buy = value.buy as [number, number][];
  if (value.sell !== undefined) column.sell = value.sell as [number, number][];
  if (value.prints !== undefined) column.prints = (value.prints as LiquidityPrint[]).map((print) => ({ ...print, id: print.id === undefined || print.id === null ? null : String(print.id) }));
  if (value.printsFloor !== undefined) column.prints_floor = value.printsFloor as number;
  return column;
}

interface Smoothing {
  reference: number;
  median: number;
  ceiling: number;
}

function ceilingAlpha(levelMs: number): number {
  return 1 - (1 - LIQUIDITY_CEILING_ALPHA) ** Math.max(1, levelMs / 1_000);
}

function smooth(column: LiquidityColumn, rowWidth: number, percentile: number, current: number, alpha: number): number {
  const midPrice = ((column.lo + column.hi) / 2) * rowWidth;
  const referenceRows = rowWidth > 0 ? Math.max(1, Math.round((midPrice * LIQUIDITY_REFERENCE_BP) / 10_000 / rowWidth)) : Infinity;
  const sample = liquidityPercentile(column, percentile, referenceRows);
  if (sample <= 0) return current;
  return current <= 0 ? sample : current + alpha * (sample - current);
}

export function decodeHistoryPage(raw: unknown, identity: SessionScoped): DecodedHistoryPage | null {
  if (!isRecord(raw)) return null;
  if (raw.available === false) return typeof raw.reason === "string" ? { available: false, reason: raw.reason } : null;
  if (raw.available !== true) return null;
  const { generation = null, levelMs, rowFactor, geometry, span, next, windows } = raw;
  if (generation !== null && (typeof generation !== "string" || generation.length === 0 || generation.length > 64)) return null;
  if (!isSafeInteger(levelMs) || !HISTORY_LEVELS_MS.includes(levelMs)) return null;
  if (!isSafeInteger(rowFactor) || !HISTORY_ROW_FACTORS.includes(rowFactor)) return null;
  if (!isRecord(geometry) || typeof geometry.rowWidth !== "number" || !(geometry.rowWidth > 0) || !Number.isFinite(geometry.rowWidth)) return null;
  if (!isRecord(span) || !(span.oldest === null || isSafeInteger(span.oldest)) || !(span.newest === null || isSafeInteger(span.newest))) return null;
  if (!(next === null || isSafeInteger(next)) || !Array.isArray(windows)) return null;
  const rowWidth = geometry.rowWidth;
  const alpha = 1 - (1 - LIQUIDITY_REFERENCE_ALPHA) ** Math.max(1, levelMs / 1_000);
  const decoded: HistoryWindow[] = [];
  let smoothing: Smoothing = { reference: 0, median: 0, ceiling: 0 };
  let lastWindowTs: number | null = null;
  for (const window of windows) {
    if (!isRecord(window) || !isSafeInteger(window.ts) || window.ts % HISTORY_WINDOW_MS !== 0) return null;
    if (typeof window.state !== "string" || !WINDOW_STATES.includes(window.state) || !Array.isArray(window.columns)) return null;
    if (lastWindowTs !== null && window.ts <= lastWindowTs) return null;
    if (lastWindowTs === null || window.ts !== lastWindowTs + HISTORY_WINDOW_MS) smoothing = { reference: 0, median: 0, ceiling: 0 };
    lastWindowTs = window.ts;
    const columns: LiquidityColumn[] = [];
    let prev: LiquidityColumn | null = null;
    let lastTs = -Infinity;
    for (const value of window.columns) {
      const wire = wireColumn(value, window.ts, levelMs);
      if (wire === null || wire.ts <= lastTs) return null;
      lastTs = wire.ts;
      const column = decodeLiquidityColumn(prev, wire);
      prev = column;
      if (!inChartSession(identity, column.ts)) continue;
      const reference = smooth(column, rowWidth, LIQUIDITY_REFERENCE_PERCENTILE, smoothing.reference, alpha);
      smoothing = {
        reference,
        median: smooth(column, rowWidth, 0.5, smoothing.median, alpha),
        ceiling: seededCeiling(smoothing.ceiling, smooth(column, rowWidth, 1, smoothing.ceiling, ceilingAlpha(levelMs)), reference),
      };
      column.reference = smoothing.reference;
      column.median = smoothing.median;
      column.ceiling = smoothing.ceiling;
      columns.push(column);
    }
    decoded.push({ ts: window.ts, state: window.state as HistoryWindowState, columns });
  }
  return { available: true, generation, levelMs, rowFactor, rowWidth, span: { oldest: span.oldest as number | null, newest: span.newest as number | null }, next: next as number | null, windows: decoded };
}

/**
 * Lane-0 history columns on a lane's rows: every `factor` rows summed into
 * one, as the host sums them for a row factor, with the yardstick measured
 * again on the wider rows the way the page's own was. The chart keeps one
 * reach of history at the runtime's rows and draws it on whatever lane the
 * price zoom picks, so the zoom never asks the host for anything.
 */
export type LaneFold = "sum" | "max";

export function foldHistoryRows(columns: readonly LiquidityColumn[], factor: number, laneRowWidth: number, levelMs: number, fold: LaneFold = "sum"): LiquidityColumn[] {
  if (!Number.isSafeInteger(factor) || factor < 1) throw new Error("foldHistoryRows: factor must be a positive integer");
  if (factor === 1) return columns.slice();
  const alpha = 1 - (1 - LIQUIDITY_REFERENCE_ALPHA) ** Math.max(1, levelMs / 1_000);
  let smoothing: Smoothing = { reference: 0, median: 0, ceiling: 0 };
  let lastTs: number | null = null;
  const out: LiquidityColumn[] = [];
  for (const column of columns) {
    const lo = Math.floor(column.lo / factor);
    const hi = Math.floor(column.hi / factor);
    const bid = new Float64Array(hi - lo + 1);
    const ask = new Float64Array(hi - lo + 1);
    for (let row = column.lo; row <= column.hi; row += 1) {
      const at = Math.floor(row / factor) - lo;
      if (fold === "max") {
        bid[at] = Math.max(bid[at], column.bid[row - column.lo]);
        ask[at] = Math.max(ask[at], column.ask[row - column.lo]);
      } else {
        bid[at] += column.bid[row - column.lo];
        ask[at] += column.ask[row - column.lo];
      }
    }
    const folded: LiquidityColumn = { ts: column.ts, lo, hi, bid, ask };
    for (const side of ["buy", "sell"] as const) {
      const flow = column[side];
      if (flow === undefined) continue;
      const sums = new Map<number, number>();
      for (const [row, volume] of flow) sums.set(Math.floor(row / factor), (sums.get(Math.floor(row / factor)) ?? 0) + volume);
      folded[side] = [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([row, volume]) => [row, volume] as const);
    }
    if (column.prints !== undefined) folded.prints = column.prints;
    if (column.printsFloor !== undefined) folded.printsFloor = column.printsFloor;
    if (fold === "max") {
      // A band read by its biggest tick keeps lane 0's yardstick: the wider row is the same quantity.
      if (column.reference !== undefined) folded.reference = column.reference;
      if (column.median !== undefined) folded.median = column.median;
      if (column.ceiling !== undefined) folded.ceiling = column.ceiling;
      out.push(folded);
      continue;
    }
    if (lastTs !== null && column.ts - lastTs > HISTORY_WINDOW_MS) smoothing = { reference: 0, median: 0, ceiling: 0 };
    lastTs = column.ts;
    const reference = smooth(folded, laneRowWidth, LIQUIDITY_REFERENCE_PERCENTILE, smoothing.reference, alpha);
    smoothing = {
      reference,
      median: smooth(folded, laneRowWidth, 0.5, smoothing.median, alpha),
      ceiling: seededCeiling(smoothing.ceiling, smooth(folded, laneRowWidth, 1, smoothing.ceiling, ceilingAlpha(levelMs)), reference),
    };
    folded.reference = smoothing.reference;
    folded.median = smoothing.median;
    folded.ceiling = smoothing.ceiling;
    out.push(folded);
  }
  return out;
}

export function historyTransferables(page: DecodedHistoryPage): ArrayBuffer[] {
  if (!page.available) return [];
  const buffers: ArrayBuffer[] = [];
  for (const window of page.windows) for (const column of window.columns) buffers.push(column.bid.buffer as ArrayBuffer, column.ask.buffer as ArrayBuffer);
  return buffers;
}
