import { columnMid, type ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { closeThrough, createBandTracker, readBands, standingWalls } from "../bandTracker";
import { gradeOf, type Side } from "../institutionalV2Rules";

export interface CalibrationRules {
  bandRows: number;
  wallSize: number;
}

export interface CalibrationOptions {
  horizonMs: number;
  warmUpMs: number;
  sampleMs: number;
}

export interface Calibration {
  walls: number;
  strong: number;
  reversed: number;
  broke: number;
  flat: number;
  baseline: number;
  typicalMove: number;
  typicalBand: number;
  bigBand: number;
  typicalWall: number;
}

function percentile(values: number[], share: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * (sorted.length - 1)))];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function sampled(columns: readonly LiquidityColumn[], sampleMs: number): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  let next = -Infinity;
  for (const column of columns) {
    if (column.ts < next) continue;
    out.push(column);
    next = column.ts + sampleMs;
  }
  return out;
}

function columnAtOrAfter(columns: readonly LiquidityColumn[], ts: number): LiquidityColumn | null {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < columns.length ? columns[lo] : null;
}

function bandSizes(columns: readonly LiquidityColumn[], bandRows: number, sampleMs: number): { all: number[]; biggest: number[] } {
  const rows = Math.max(1, Math.floor(bandRows));
  const all: number[] = [];
  const biggest: number[] = [];
  for (const column of sampled(columns, sampleMs)) {
    for (const side of ["bid", "ask"] as const) {
      const cells = column[side];
      let top = 0;
      for (let band = Math.floor(column.lo / rows); band <= Math.floor(column.hi / rows); band += 1) {
        let size = 0;
        for (let row = Math.max(band * rows, column.lo); row <= Math.min(band * rows + rows - 1, column.hi); row += 1) size += cells[row - column.lo];
        if (size > 0) all.push(size);
        if (size > top) top = size;
      }
      if (top > 0) biggest.push(top);
    }
  }
  return { all, biggest };
}

export function typicalBandSize(columns: readonly LiquidityColumn[], bandRows: number, sampleMs: number): number {
  return median(bandSizes(columns, bandRows, sampleMs).all);
}

export function bigBandSize(columns: readonly LiquidityColumn[], bandRows: number, sampleMs: number): number {
  return percentile(bandSizes(columns, bandRows, sampleMs).all, 0.95);
}

export function typicalWallSize(columns: readonly LiquidityColumn[], bandRows: number, sampleMs: number): number {
  return median(bandSizes(columns, bandRows, sampleMs).biggest);
}

function movesOver(columns: readonly LiquidityColumn[], rowWidth: number, horizonMs: number, sampleMs: number): number[] {
  const moves: number[] = [];
  for (const column of sampled(columns, sampleMs)) {
    const later = columnAtOrAfter(columns, column.ts + horizonMs);
    if (later === null) break;
    const from = columnMid(column, rowWidth);
    const to = columnMid(later, rowWidth);
    if (from === null || to === null || from <= 0) continue;
    moves.push((to - from) / from);
  }
  return moves;
}

export function typicalMove(columns: readonly LiquidityColumn[], rowWidth: number, horizonMs: number, sampleMs: number): number {
  return median(movesOver(columns, rowWidth, horizonMs, sampleMs).map((move) => Math.abs(move)));
}

function inFavour(side: Side, move: number): number {
  return side === "bid" ? move : -move;
}

export function calibrate(columns: readonly LiquidityColumn[], rowWidth: number, columnMs: number, rules: CalibrationRules, options: CalibrationOptions): Calibration {
  const feed: ColumnFeed = { epoch: 1, deep: { columns, columnMs }, fine: { columns: [], columnMs } };
  const state = createBandTracker();
  const yardstick = typicalMove(columns, rowWidth, options.horizonMs, options.sampleMs);
  const startTs = columns.length > 0 ? columns[0].ts + options.warmUpMs : 0;
  const rows = Math.max(1, Math.floor(rules.bandRows));
  const walls = new Set<string>();
  const strong = new Set<string>();
  let reversed = 0;
  let broke = 0;
  let flat = 0;
  let nextClose = -Infinity;
  const trackerRules = { ...rules, strongSize: Infinity };
  for (const column of columns) {
    readBands(state, feed, column.ts + 1, trackerRules);
    if (column.ts >= nextClose) {
      const mid = columnMid(column, rowWidth);
      if (mid !== null) closeThrough(state, Math.floor(mid / rowWidth), column.ts);
      nextClose = column.ts + options.sampleMs;
    }
    for (const wall of standingWalls(state, column.ts)) {
      if (wall.startTs < startTs) continue;
      const key = `${wall.side}:${wall.band}:${wall.startTs}`;
      walls.add(key);
      if (strong.has(key) || gradeOf(wall, column.ts) !== "strong") continue;
      const later = columnAtOrAfter(columns, column.ts + options.horizonMs);
      if (later === null) continue;
      strong.add(key);
      const price = (wall.band * rows + rows / 2) * rowWidth;
      const to = columnMid(later, rowWidth);
      if (to === null) continue;
      const move = inFavour(wall.side, (to - price) / price);
      if (move >= yardstick) reversed += 1;
      else if (move <= -yardstick) broke += 1;
      else flat += 1;
    }
  }
  const moves = movesOver(columns, rowWidth, options.horizonMs, options.sampleMs);
  const favourable = moves.filter((move) => inFavour("bid", move) >= yardstick).length + moves.filter((move) => inFavour("ask", move) >= yardstick).length;
  return {
    walls: walls.size,
    strong: strong.size,
    reversed,
    broke,
    flat,
    baseline: moves.length > 0 ? favourable / (2 * moves.length) : NaN,
    typicalMove: yardstick,
    typicalBand: typicalBandSize(columns, rules.bandRows, options.sampleMs),
    bigBand: bigBandSize(columns, rules.bandRows, options.sampleMs),
    typicalWall: typicalWallSize(columns, rules.bandRows, options.sampleMs),
  };
}
