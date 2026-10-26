import type { LiquidityFrame, TradeFrame } from "../../../types/frames";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import type { HistoryInterval } from "./aggressiveTape";

export function tradesFromColumns(frame: LiquidityFrame): TradeFrame[] {
  const identity = frame.provider === "BINANCE"
    ? { provider: frame.provider, marketKind: frame.marketKind }
    : { provider: frame.provider, assetClass: frame.assetClass };
  const trades: TradeFrame[] = [];
  for (const column of frame.columns) {
    if (!column.prints) continue;
    for (const print of column.prints) {
      trades.push({
        type: "trade",
        symbol: frame.symbol,
        ts_exchange: print.ts,
        price: print.price,
        size: print.size,
        side: print.side,
        trade_id: print.id ?? `column:${print.ts}:${print.side}:${print.price}:${print.size}`,
        ...identity,
      });
    }
  }
  return trades;
}

/**
 * The stretches of time the grid's columns cover at `floor`: every column
 * that kept its prints from a floor no higher than `floor` covers the
 * second (window) ending at its ts, and touching columns merge.
 */
export function columnCoverage(columns: readonly LiquidityColumn[], columnMs: number, floor: number): HistoryInterval[] {
  const intervals: HistoryInterval[] = [];
  for (const column of columns) {
    if (column.prints === undefined || column.printsFloor === undefined || column.printsFloor > floor) continue;
    const from = column.ts - columnMs;
    const last = intervals[intervals.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, column.ts);
    else intervals.push({ from, to: column.ts });
  }
  return intervals;
}

export interface CoverageGrid {
  readonly columns: readonly LiquidityColumn[];
  readonly columnMs: number;
  readonly deepColumns: readonly LiquidityColumn[];
  readonly deepColumnMs: number;
}

export interface HistoryAsk {
  readonly liveSince: number | null;
  coverHistory(fromMs: number, toMs: number, minSize: number): void;
  wantHistoryFrom(fromMs: number): void;
  nextHistoryGap(minSize: number): HistoryInterval | null;
  historyCoveredTo(minSize: number): number | null;
  lastHistoryAsk(minSize: number): { ask: HistoryInterval; at: number } | null;
  noteHistoryAsk(ask: HistoryInterval, minSize: number, atMs: number): void;
  askable(ask: HistoryInterval, nowMs: number): HistoryInterval | null;
}

export const HISTORY_ASK_MIN_MS = 1_000;
export const HISTORY_REASK_MS = 30_000;
export const HISTORY_MIN_MS = 4 * 60 * 60 * 1000;
export const HISTORY_MAX_MS = 31 * 24 * 60 * 60 * 1000;

export function historyWantedFrom(now: number, viewFromMs: number | null): number {
  const wanted = Math.min(now - HISTORY_MIN_MS, viewFromMs ?? Infinity);
  return Math.max(now - HISTORY_MAX_MS, wanted);
}

export function historyRequestFor(tape: HistoryAsk, grid: CoverageGrid | null, floor: number, fromMs: number, now: number): HistoryInterval | null {
  tape.wantHistoryFrom(fromMs);
  if (grid) {
    for (const interval of columnCoverage(grid.deepColumns, grid.deepColumnMs, floor)) tape.coverHistory(interval.from, interval.to, floor);
    for (const interval of columnCoverage(grid.columns, grid.columnMs, floor)) tape.coverHistory(interval.from, interval.to, floor);
  }
  const end = tape.liveSince === null ? now : Math.min(now, tape.liveSince);
  let ask: HistoryInterval | null = tape.nextHistoryGap(floor);
  if (ask === null) {
    const from = Math.max(fromMs, tape.historyCoveredTo(floor) ?? -Infinity);
    ask = from < end ? tape.askable({ from, to: end }, now) : null;
  }
  if (ask === null || ask.to - ask.from < HISTORY_ASK_MIN_MS) return null;
  const last = tape.lastHistoryAsk(floor);
  const repeatsLast = last !== null && now - last.at < HISTORY_REASK_MS &&
    (last.ask.to === ask.to || (ask.from >= last.ask.from && ask.from <= last.ask.to));
  if (repeatsLast) return null;
  tape.noteHistoryAsk(ask, floor, now);
  return ask;
}
