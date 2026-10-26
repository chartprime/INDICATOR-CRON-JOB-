import type { BarFrame } from "../../../types/frames";

export type KillzoneId = "asia" | "london" | "nyam" | "nylunch" | "nypm" | "rth";

export interface KillzoneSessionDef {
  id: KillzoneId;
  label: string;
  startMin: number;
  endMin: number;
  defaultShown: boolean;
  boxColor: string;
  lineColor: string;
}

export const KILLZONE_SESSIONS: readonly KillzoneSessionDef[] = [
  { id: "asia", label: "Asia", startMin: 20 * 60, endMin: 0, defaultShown: true, boxColor: "rgba(37, 99, 235, 0.12)", lineColor: "#2563eb" },
  { id: "london", label: "London", startMin: 2 * 60, endMin: 5 * 60, defaultShown: true, boxColor: "rgba(220, 38, 38, 0.12)", lineColor: "#dc2626" },
  { id: "nyam", label: "NY AM", startMin: 9 * 60 + 30, endMin: 11 * 60, defaultShown: true, boxColor: "rgba(13, 148, 136, 0.12)", lineColor: "#0d9488" },
  { id: "nylunch", label: "NY Lunch", startMin: 12 * 60, endMin: 13 * 60, defaultShown: false, boxColor: "rgba(234, 88, 12, 0.12)", lineColor: "#ea580c" },
  { id: "nypm", label: "NY PM", startMin: 13 * 60 + 30, endMin: 16 * 60, defaultShown: true, boxColor: "rgba(192, 38, 211, 0.12)", lineColor: "#c026d3" },
  { id: "rth", label: "RTH", startMin: 9 * 60 + 30, endMin: 16 * 60, defaultShown: false, boxColor: "rgba(17, 17, 17, 0.08)", lineColor: "#111111" },
];

const NY_TIMEZONE = "America/New_York";
const NY_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export interface NyParts {
  dateKey: string;
  minuteOfDay: number;
}

export type NyPartsCache = Map<number, NyParts>;

function previousDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function occurrenceDateKey(parts: NyParts, session: KillzoneSessionDef): string {
  if (session.startMin > session.endMin && parts.minuteOfDay < session.endMin) {
    return previousDateKey(parts.dateKey);
  }
  return parts.dateKey;
}

function nyParts(epochMs: number): NyParts {
  const parts = NY_PARTS_FORMATTER.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return { dateKey: `${year}-${month}-${day}`, minuteOfDay: hour * 60 + minute };
}

function cachedNyParts(epochMs: number, cache: NyPartsCache | undefined): NyParts {
  if (!cache) return nyParts(epochMs);
  const existing = cache.get(epochMs);
  if (existing) return existing;
  const computed = nyParts(epochMs);
  cache.set(epochMs, computed);
  return computed;
}

export function nyLocalMinuteOfDay(epochMs: number): number {
  return nyParts(epochMs).minuteOfDay;
}

export function nyLocalDateKey(epochMs: number): string {
  return nyParts(epochMs).dateKey;
}

export function isInSession(minuteOfDay: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return minuteOfDay >= startMin && minuteOfDay < endMin;
  }
  return minuteOfDay >= startMin || minuteOfDay < endMin;
}

export interface KillzoneOccurrence {
  sessionId: KillzoneId;
  startMs: number;
  boxEndMs: number;
  high: number;
  low: number;
  highLineEndMs: number;
  lowLineEndMs: number;
  highBroken: boolean;
  lowBroken: boolean;
}

interface BuildingOccurrence {
  sessionId: KillzoneId;
  startDateKey: string;
  startMs: number;
  boxEndMs: number;
  lastBarIntervalMs: number;
  high: number;
  low: number;
}

export function buildKillzoneOccurrences(
  bars: readonly BarFrame[],
  session: KillzoneSessionDef,
  maxOccurrences: number,
  nyPartsCache?: NyPartsCache,
): KillzoneOccurrence[] {
  if (!Number.isInteger(maxOccurrences) || maxOccurrences <= 0) {
    throw new Error("buildKillzoneOccurrences: maxOccurrences must be a positive integer");
  }
  if (
    !Number.isInteger(session.startMin) ||
    !Number.isInteger(session.endMin) ||
    session.startMin < 0 ||
    session.startMin >= 24 * 60 ||
    session.endMin < 0 ||
    session.endMin >= 24 * 60
  ) {
    throw new Error("buildKillzoneOccurrences: session boundaries must be valid minute-of-day values");
  }
  const built: BuildingOccurrence[] = [];
  let current: BuildingOccurrence | null = null;
  let previousBarOpen = -1;

  for (const bar of bars) {
    if (bar.ts_open <= previousBarOpen) {
      throw new Error("buildKillzoneOccurrences: bars must be strictly chronological");
    }
    previousBarOpen = bar.ts_open;
    const parts = cachedNyParts(bar.ts_open, nyPartsCache);
    const { minuteOfDay } = parts;
    const dateKey = occurrenceDateKey(parts, session);
    const inSession = isInSession(minuteOfDay, session.startMin, session.endMin);
    if (!inSession) {
      current = null;
      continue;
    }
    const continuesCurrent =
      current !== null &&
      dateKey === current.startDateKey &&
      bar.interval_ms === current.lastBarIntervalMs;
    if (!continuesCurrent) {
      current = {
        sessionId: session.id,
        startDateKey: dateKey,
        startMs: bar.ts_open,
        boxEndMs: bar.ts_open,
        lastBarIntervalMs: bar.interval_ms,
        high: bar.high,
        low: bar.low,
      };
      built.push(current);
      if (built.length > maxOccurrences) built.shift();
    } else {
      current!.boxEndMs = bar.ts_open;
      current!.lastBarIntervalMs = bar.interval_ms;
      current!.high = Math.max(current!.high, bar.high);
      current!.low = Math.min(current!.low, bar.low);
    }
  }

  const occurrences: KillzoneOccurrence[] = built.map((occurrence) => ({
    sessionId: occurrence.sessionId,
    startMs: occurrence.startMs,
    boxEndMs: occurrence.boxEndMs,
    high: occurrence.high,
    low: occurrence.low,
    highLineEndMs: occurrence.boxEndMs,
    lowLineEndMs: occurrence.boxEndMs,
    highBroken: false,
    lowBroken: false,
  }));

  for (let i = 0; i < occurrences.length; i += 1) {
    const occurrence = occurrences[i];
    const supersededAtMs = i + 1 < occurrences.length ? occurrences[i + 1].startMs : undefined;
    for (const bar of bars) {
      if (bar.ts_open <= occurrence.boxEndMs) continue;
      if (supersededAtMs !== undefined && bar.ts_open >= supersededAtMs) break;
      if (!occurrence.highBroken) {
        occurrence.highLineEndMs = bar.ts_open;
        if (bar.high > occurrence.high) occurrence.highBroken = true;
      }
      if (!occurrence.lowBroken) {
        occurrence.lowLineEndMs = bar.ts_open;
        if (bar.low < occurrence.low) occurrence.lowBroken = true;
      }
      if (occurrence.highBroken && occurrence.lowBroken) break;
    }
  }

  return occurrences;
}
