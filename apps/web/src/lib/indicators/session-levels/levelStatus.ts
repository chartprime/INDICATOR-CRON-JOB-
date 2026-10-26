import type { BarFrame } from "../../../types/frames";
import type { BandHistoryWant } from "../../chart/bandHistory";
import { lastColumnAtOrBefore, newestColumnTs, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import { touches, wallRows, type LevelRules } from "./levelReader";
import { readWindow, restingIn, touchTime, type WindowReading } from "./levelWindow";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import type { Level } from "./sessionLevelsRules";

export interface LevelStatus {
  resting: number;
  peak: number;
  window: WindowReading | null;
  want: BandHistoryWant | null;
  recorded: WindowReading | null;
  recordedFrom: readonly LiquidityColumn[] | null;
}

export function createLevelStatus(): LevelStatus {
  return { resting: 0, peak: 0, window: null, want: null, recorded: null, recordedFrom: null };
}

export function needsRecording(status: LevelStatus): boolean {
  return status.window !== null && !status.window.open && status.window.verdict === null;
}

export function applyRecording(status: LevelStatus): void {
  const reading = status.recorded;
  const live = status.window;
  if (reading === null || live === null || live.open || live.verdict !== null) return;
  if (reading.verdict !== null || (live.noBook && !reading.noBook) || (live.partial && reading.partial && reading.facts.captured > live.facts.captured)) status.window = reading;
}

function judge(status: LevelStatus, level: Level, feed: ColumnFeed, rowWidth: number, rules: LevelRules, bars: readonly BarFrame[], from: number): void {
  status.window = readWindow(feed, rowWidth, bars, level.price, level.side, rules, from, newestColumnTs(feed));
}

export function advanceLevel(status: LevelStatus, level: Level, bar: BarFrame, feed: ColumnFeed, rowWidth: number, rules: LevelRules, bars: readonly BarFrame[]): void {
  if (bar.ts_open <= level.range.endMs) return;
  if (status.window !== null) {
    if (status.window.open || status.window.verdict === null) judge(status, level, feed, rowWidth, rules, bars, status.window.from);
    return;
  }
  if (touches(bar, level.price, level.side)) {
    judge(status, level, feed, rowWidth, rules, bars, touchTime(feed, rowWidth, bar, level.price, level.side));
    return;
  }
  const column = lastColumnAtOrBefore(feed, bar.ts_open + bar.interval_ms - 1);
  if (column === null) return;
  const [rowLo, rowHi] = wallRows(level.price, level.side, rowWidth, rules.bandRows);
  status.resting = restingIn(column, level.side, rowLo, rowHi);
  status.peak = Math.max(status.peak, status.resting);
}
