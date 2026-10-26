import type { BarFrame } from "../../../types/frames";
import { futureSessionOpenAt } from "../../chart/marketCalendar";
import { KILLZONE_SESSIONS, isInSession, nyLocalMinuteOfDay, type KillzoneId, type KillzoneSessionDef } from "../killzones/killzones";

export const ORB_WINDOWS_MIN = [5, 15, 30] as const;

export type OrbWindowMin = (typeof ORB_WINDOWS_MIN)[number];

export const ORB_SESSION: KillzoneId = "nyam";

export const MAX_RANGES = KILLZONE_SESSIONS.length + ORB_WINDOWS_MIN.length;

const MINUTE_MS = 60_000;

const DAY_MIN = 24 * 60;

interface RangeBase {
  sessionId: KillzoneId;
  startMs: number;
  endMs: number;
  high: number;
  low: number;
  highTouchMs: number | null;
  lowTouchMs: number | null;
}

export interface SessionRange extends RangeBase {
  kind: "session";
}

export interface OpeningRange extends RangeBase {
  kind: "orb";
  windowMin: OrbWindowMin;
}

export type Range = SessionRange | OpeningRange;

export interface RangeSettings {
  sessions: ReadonlySet<KillzoneId>;
  windows: ReadonlySet<OrbWindowMin>;
  sessionLevels: boolean;
}

interface Running {
  session: SessionRange;
  orbs: OpeningRange[];
  lastOpen: number;
  intervalMs: number;
}

export interface RangeBuilder {
  ranges: Range[];
  running: Map<KillzoneId, Running>;
  lastOpen: number;
}

export function createRangeBuilder(): RangeBuilder {
  return { ranges: [], running: new Map(), lastOpen: -Infinity };
}

function sessionLengthMs(session: KillzoneSessionDef): number {
  return ((session.endMin - session.startMin + DAY_MIN) % DAY_MIN) * MINUTE_MS;
}

function push(builder: RangeBuilder, range: Range): void {
  builder.ranges.push(range);
}

function settleOrbs(builder: RangeBuilder, running: Running, bar: BarFrame): void {
  for (const orb of [...running.orbs]) {
    const windowEnd = orb.startMs + orb.windowMin * MINUTE_MS;
    if (bar.ts_open < windowEnd) {
      orb.endMs = bar.ts_open;
      orb.high = Math.max(orb.high, bar.high);
      orb.low = Math.min(orb.low, bar.low);
      if (!bar.closed || bar.ts_open + bar.interval_ms < windowEnd) continue;
    }
    running.orbs.splice(running.orbs.indexOf(orb), 1);
    push(builder, orb);
  }
}

function extend(builder: RangeBuilder, running: Running, bar: BarFrame): void {
  running.lastOpen = bar.ts_open;
  running.session.endMs = bar.ts_open;
  running.session.high = Math.max(running.session.high, bar.high);
  running.session.low = Math.min(running.session.low, bar.low);
  settleOrbs(builder, running, bar);
}

function finish(builder: RangeBuilder, sessionId: KillzoneId, settings: RangeSettings): void {
  const running = builder.running.get(sessionId);
  if (running === undefined) return;
  builder.running.delete(sessionId);
  if (settings.sessionLevels && settings.sessions.has(sessionId)) push(builder, running.session);
}

function fresh(bar: BarFrame): Omit<RangeBase, "sessionId"> {
  return { startMs: bar.ts_open, endMs: bar.ts_open, high: bar.high, low: bar.low, highTouchMs: null, lowTouchMs: null };
}

function start(builder: RangeBuilder, session: KillzoneSessionDef, bar: BarFrame, minuteOfDay: number, settings: RangeSettings): void {
  builder.ranges = builder.ranges.filter((range) => range.sessionId !== session.id);
  const running: Running = { session: { kind: "session", sessionId: session.id, ...fresh(bar) }, orbs: [], lastOpen: bar.ts_open, intervalMs: bar.interval_ms };
  if (session.id === ORB_SESSION && minuteOfDay === session.startMin) {
    for (const windowMin of ORB_WINDOWS_MIN) {
      if (!settings.windows.has(windowMin) || (windowMin * MINUTE_MS) % bar.interval_ms !== 0) continue;
      running.orbs.push({ kind: "orb", sessionId: session.id, windowMin, ...fresh(bar), high: -Infinity, low: Infinity });
    }
  }
  builder.running.set(session.id, running);
  settleOrbs(builder, running, bar);
}

function touch(builder: RangeBuilder, bar: BarFrame): void {
  for (const range of builder.ranges) {
    if (bar.ts_open <= range.endMs) continue;
    if (range.highTouchMs === null && bar.high >= range.high) range.highTouchMs = bar.ts_open;
    if (range.lowTouchMs === null && bar.low <= range.low) range.lowTouchMs = bar.ts_open;
  }
}

export function applyBar(builder: RangeBuilder, bar: BarFrame, settings: RangeSettings): void {
  if (bar.ts_open < builder.lastOpen) return;
  builder.lastOpen = bar.ts_open;
  const minuteOfDay = nyLocalMinuteOfDay(bar.ts_open);
  const weekOpen = futureSessionOpenAt(bar.ts_open);
  for (const session of KILLZONE_SESSIONS) {
    const running = builder.running.get(session.id);
    if (!weekOpen || !isInSession(minuteOfDay, session.startMin, session.endMin)) {
      finish(builder, session.id, settings);
      continue;
    }
    if (running !== undefined && bar.ts_open - running.lastOpen <= sessionLengthMs(session) && bar.interval_ms === running.intervalMs) {
      extend(builder, running, bar);
      continue;
    }
    finish(builder, session.id, settings);
    start(builder, session, bar, minuteOfDay, settings);
  }
  touch(builder, bar);
}
