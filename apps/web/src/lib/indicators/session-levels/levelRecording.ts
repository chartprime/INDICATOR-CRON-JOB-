import type { BarFrame } from "../../../types/frames";
import { BAND_COLUMN_MS, type BandHistoryGap, type BandHistoryWant } from "../../chart/bandHistory";
import type { ColumnFeed } from "../absorption-detector/absorptionColumns";
import type { LevelRules } from "./levelReader";
import { WINDOW_MS, readWindow, touchTime, type WindowReading } from "./levelWindow";
import type { RangeStats } from "./rangeStats";
import type { Level } from "./sessionLevelsRules";
import type { Range } from "./sessionRanges";

export interface Recording {
  feed: ColumnFeed;
  rowWidth: number;
  gaps: readonly BandHistoryGap[];
}

function recordedColumns(recording: Recording): ColumnFeed {
  if (recording.gaps.length === 0) return recording.feed;
  const columns = recording.feed.fine.columns.filter((column) => !recording.gaps.some((gap) => column.ts > gap.from && column.ts <= gap.to));
  return { epoch: recording.feed.epoch, deep: null, fine: { columns, columnMs: recording.feed.fine.columnMs } };
}

export function levelWant(level: Level, barMs: number, rowWidth: number, bandRows: number): BandHistoryWant | null {
  if (level.touchMs === null || !(rowWidth > 0)) return null;
  const row = Math.floor(level.price / rowWidth);
  const fromTs = level.touchMs;
  const toTs = level.touchMs + barMs + WINDOW_MS;
  const priceLo = (row - bandRows) * rowWidth;
  const priceHi = (row + bandRows + 1) * rowWidth;
  return { key: `level:${fromTs}:${toTs}:${priceLo}:${priceHi}`, fromTs, toTs, priceLo, priceHi, columnMs: BAND_COLUMN_MS, reach: "mid" };
}

export function readLevelRecording(recording: Recording, level: Level, barMs: number, bars: readonly BarFrame[], rules: LevelRules): WindowReading | null {
  if (level.touchMs === null) return null;
  const feed = recordedColumns(recording);
  const from = touchTime(feed, recording.rowWidth, { ts_open: level.touchMs, interval_ms: barMs }, level.price, level.side);
  return readWindow(feed, recording.rowWidth, bars, level.price, level.side, rules, from, Infinity);
}

export function rangeWant(range: Range, barMs: number): BandHistoryWant {
  const fromTs = range.startMs;
  const toTs = range.endMs + barMs - 1;
  return { key: `range:${fromTs}:${toTs}`, fromTs, toTs, priceLo: range.low, priceHi: range.high > range.low ? range.high : range.low + 1, columnMs: BAND_COLUMN_MS, reach: "flow" };
}

export function readRangeRecording(recording: Recording, range: Range, barMs: number): RangeStats | null {
  const fromMs = range.startMs;
  const toMs = range.endMs + barMs;
  const { columns, columnMs } = recordedColumns(recording).fine;
  const stats: RangeStats = { biggestBuy: 0, biggestSell: 0, bought: 0, sold: 0, noPrints: true };
  let read = 0;
  for (const column of columns) {
    if (column.ts < fromMs || column.ts >= toMs) continue;
    read += 1;
    for (const [, volume] of column.buy ?? []) stats.bought += volume;
    for (const [, volume] of column.sell ?? []) stats.sold += volume;
  }
  if (read === 0) return null;
  const missingMs = toMs - fromMs - read * columnMs;
  return missingMs > 0 ? { ...stats, missingMs } : stats;
}
