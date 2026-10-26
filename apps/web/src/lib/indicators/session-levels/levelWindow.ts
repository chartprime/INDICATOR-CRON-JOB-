import type { BarFrame } from "../../../types/frames";
import { columnMid, eachColumn, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { EATEN_SHARE, wallRows, type LevelRules } from "./levelReader";
import type { LevelSide } from "./sessionLevelsRules";

export const WINDOW_MS = 5 * 60_000;

export const DELTA_SHARE = 0.25;

export const COVERAGE_SHARE = 0.8;

export type Verdict = "held" | "absorbed" | "swept" | "weakBreak" | "strongBreak";

export interface WindowFacts {
  before: number;
  now: number;
  into: number;
  through: number;
  against: number;
  delta: number;
  wentPast: boolean;
  outAtEnd: boolean;
  columns: number;
  captured: number;
  expected: number;
}

export interface WindowReading {
  from: number;
  to: number;
  open: boolean;
  noBook: boolean;
  partial: boolean;
  bookGap?: boolean;
  verdict: Verdict | null;
  best?: Verdict | null;
  facts: WindowFacts;
}

export function shownVerdict(window: WindowReading | null | undefined): Verdict | null {
  return window?.verdict ?? window?.best ?? null;
}

function verdictOf(facts: WindowFacts, rules: LevelRules): Verdict {
  const eaten = facts.before > 0 && facts.now < EATEN_SHARE * facts.before;
  if (facts.outAtEnd) return facts.through >= rules.floor && facts.delta >= DELTA_SHARE * facts.through ? "strongBreak" : "weakBreak";
  if (facts.before > 0 && facts.into >= rules.floor && facts.into >= rules.share * facts.before && !eaten) return "absorbed";
  return facts.wentPast ? "swept" : "held";
}

function bandEdge(price: number, side: LevelSide, rowWidth: number, bandRows: number): number {
  const [rowLo, rowHi] = wallRows(price, side, rowWidth, bandRows);
  return side === "high" ? (rowHi + 1) * rowWidth : rowLo * rowWidth;
}

function past(value: number, edge: number, side: LevelSide): boolean {
  return side === "high" ? value > edge : value < edge;
}

function inBandOrBeyond(mid: number, price: number, side: LevelSide, rowWidth: number): boolean {
  const row = Math.floor(price / rowWidth) * rowWidth;
  return side === "high" ? mid >= row : mid < row + rowWidth;
}

function sumRows(book: Float64Array, column: LiquidityColumn, rowLo: number, rowHi: number): number {
  let size = 0;
  for (let row = Math.max(rowLo, column.lo); row <= Math.min(rowHi, column.hi); row += 1) size += book[row - column.lo] ?? 0;
  return size;
}

export function restingIn(column: LiquidityColumn, side: LevelSide, rowLo: number, rowHi: number): number {
  return sumRows(side === "high" ? column.ask : column.bid, column, rowLo, rowHi);
}

export function attackRows(price: number, side: LevelSide, rowWidth: number, bandRows: number): [number, number] {
  const row = Math.floor(price / rowWidth);
  return side === "high" ? [row - bandRows, row + bandRows - 1] : [row - bandRows + 1, row + bandRows];
}

function flowInto(column: LiquidityColumn, side: LevelSide, rowLo: number, rowHi: number): number {
  let size = 0;
  for (const [row, volume] of (side === "high" ? column.buy : column.sell) ?? []) if (row >= rowLo && row <= rowHi) size += volume;
  return size;
}

function flowThrough(column: LiquidityColumn, side: LevelSide, levelRow: number): number {
  return side === "high" ? flowInto(column, side, levelRow, Infinity) : flowInto(column, side, -Infinity, levelRow);
}

function flowAgainst(column: LiquidityColumn, side: LevelSide, levelRow: number): number {
  let size = 0;
  for (const [row, volume] of (side === "high" ? column.sell : column.buy) ?? []) if (side === "high" ? row >= levelRow : row <= levelRow) size += volume;
  return size;
}

function columnVolume(column: LiquidityColumn): number {
  let size = 0;
  for (const [, volume] of column.buy ?? []) size += volume;
  for (const [, volume] of column.sell ?? []) size += volume;
  return size;
}

function flowPast(column: LiquidityColumn, side: LevelSide, levelRow: number): number {
  let delta = 0;
  for (const [row, volume] of column.buy ?? []) if (side === "high" ? row >= levelRow : row <= levelRow) delta += volume;
  for (const [row, volume] of column.sell ?? []) if (side === "high" ? row >= levelRow : row <= levelRow) delta -= volume;
  return side === "high" ? delta : -delta;
}

export function touchTime(feed: ColumnFeed, rowWidth: number, bar: Pick<BarFrame, "ts_open" | "interval_ms">, price: number, side: LevelSide): number {
  let found = bar.ts_open;
  eachColumn(feed, bar.ts_open, bar.ts_open + bar.interval_ms - 1, (column) => {
    const mid = columnMid(column, rowWidth);
    if (mid === null || !inBandOrBeyond(mid, price, side, rowWidth)) return;
    found = column.ts;
    return true;
  });
  return found;
}

export function readWindow(feed: ColumnFeed, rowWidth: number, bars: readonly BarFrame[], price: number, side: LevelSide, rules: LevelRules, touchTs: number, nowTs: number): WindowReading {
  const from = touchTs;
  const to = touchTs + WINDOW_MS;
  const [rowLo, rowHi] = wallRows(price, side, rowWidth, rules.bandRows);
  const [attackLo, attackHi] = attackRows(price, side, rowWidth, rules.bandRows);
  const levelRow = Math.floor(price / rowWidth);
  const edge = bandEdge(price, side, rowWidth, rules.bandRows);
  const facts: WindowFacts = { before: 0, now: 0, into: 0, through: 0, against: 0, delta: 0, wentPast: false, outAtEnd: false, columns: 0, captured: 0, expected: 0 };
  let first: number | null = null;
  let previous: number | null = null;
  let beforeFirstTrade: number | null = null;
  let last: LiquidityColumn | null = null;
  let covered = false;
  let coveredThrough = -Infinity;
  let bookGap = false;
  eachColumn(feed, from, Math.min(to, nowTs + 1) - 1, (column, columnMs) => {
    if (coveredThrough !== -Infinity && column.ts > coveredThrough) bookGap = true;
    coveredThrough = Math.max(coveredThrough, column.ts + columnMs);
    const wall = side === "high" ? column.ask : column.bid;
    const resting = sumRows(wall, column, rowLo, rowHi);
    const into = flowInto(column, side, attackLo, attackHi);
    if (first === null) {
      first = resting;
      covered = column.ts <= from + columnMs;
    }
    if (into > 0 && facts.into === 0) beforeFirstTrade = previous ?? resting;
    facts.into += into;
    facts.through += flowThrough(column, side, levelRow);
    facts.against += flowAgainst(column, side, levelRow);
    facts.delta += flowPast(column, side, levelRow);
    facts.columns += 1;
    facts.captured += columnVolume(column);
    previous = resting;
    last = column;
    const mid = columnMid(column, rowWidth);
    if (mid !== null) {
      facts.outAtEnd = past(mid, edge, side);
      if (facts.outAtEnd) facts.wentPast = true;
    }
  });
  let lastClose: number | null = null;
  for (const bar of bars) {
    if (bar.ts_open + bar.interval_ms <= from || bar.ts_open >= to) continue;
    if (past(side === "high" ? bar.high : bar.low, edge, side)) facts.wentPast = true;
    facts.expected += (bar.volume * (Math.min(to, bar.ts_open + bar.interval_ms) - Math.max(from, bar.ts_open))) / bar.interval_ms;
    lastClose = bar.close;
  }
  if (last === null && lastClose !== null) facts.outAtEnd = past(lastClose, edge, side);
  const open = nowTs < to;
  facts.before = beforeFirstTrade ?? first ?? 0;
  facts.now = previous ?? first ?? 0;
  const best = open ? null : verdictOf(facts, rules);
  if (last === null || first === null || !covered) return { from, to, open, noBook: true, partial: false, verdict: null, best, facts };
  if (open) return { from, to, open: true, noBook: false, partial: false, verdict: null, best, facts };
  if (bookGap || coveredThrough < to) return { from, to, open: false, noBook: false, partial: true, bookGap: true, verdict: null, best, facts };
  if (facts.expected > 0 && facts.captured < COVERAGE_SHARE * facts.expected) return { from, to, open: false, noBook: false, partial: true, verdict: null, best, facts };
  return { from, to, open: false, noBook: false, partial: false, verdict: best, best, facts };
}
