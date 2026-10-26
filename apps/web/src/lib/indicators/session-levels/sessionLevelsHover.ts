import { nyLocalMinuteOfDay } from "../killzones/killzones";
import { describeRangeStats, type RangeStats } from "./rangeStats";
import { lineEnd } from "./sessionLevelsRender";
import type { LevelStatus } from "./levelStatus";
import { describeSource, labelSpans, levelName, sessionOf, sharesPriceWithEarlier, type Level } from "./sessionLevelsRules";
import type { Range } from "./sessionRanges";

export interface SessionLevelHover {
  title: string;
  lines: string[];
  price: number;
  fromMs: number;
  toMs: number;
}

function clock(ms: number): string {
  const minute = nyLocalMinuteOfDay(ms);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function rangeKey(range: Range): string {
  return `${range.sessionId}:${range.kind === "orb" ? range.windowMin : "s"}:${range.startMs}`;
}

export function rangeTitle(range: Range, barMs: number): string {
  const name = range.kind === "orb" ? `ORB ${range.windowMin} min` : sessionOf(range.sessionId).label;
  return `${name} · ${clock(range.startMs)}–${clock(range.endMs + barMs)} ET`;
}

export function levelHovers(levels: readonly Level[], barMs: number, barTs: number, statsOf: (range: Range) => RangeStats | null, unit: string, statusOf: (level: Level) => LevelStatus | null = () => null): SessionLevelHover[] {
  const spans = labelSpans([...new Set(levels.map((level) => level.range))], barMs);
  return levels.map((level) => {
    const { range } = level;
    const [labelFrom] = spans.get(range) ?? [range.startMs];
    const source = describeSource(statusOf(level));
    return {
      title: `${levelName(level)} · ${rangeTitle(range, barMs)}`,
      lines: source === null ? describeRangeStats(statsOf(range), unit) : [...describeRangeStats(statsOf(range), unit), source],
      price: level.price,
      fromMs: sharesPriceWithEarlier(level, levels) ? labelFrom : range.startMs,
      toMs: lineEnd(level, barTs),
    };
  });
}
