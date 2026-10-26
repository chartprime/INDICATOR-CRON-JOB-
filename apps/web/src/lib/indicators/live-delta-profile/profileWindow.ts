import type { FrameIdentity } from "../../../types/frames";
import { KILLZONE_SESSIONS, nyLocalDateKey, nyLocalMinuteOfDay } from "../killzones/killzones";
import { AUTO_ROLLING_HOURS, autoWindowMode, rollingHoursOf, type LiveDeltaProfileSettings } from "./liveDeltaProfileSettings";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FUTURES_OPEN_MINUTE = 18 * 60;
const SUNDAY = 0;
const MONDAY = 1;
export const ROLLING_SLICE_MS = 30 * MINUTE_MS;
export const DAY_PIECE_MS = 2 * HOUR_MS;
export const VISIBLE_PIECE_MS = 30 * MINUTE_MS;
export const HISTORY_LIMIT_MS = 7 * DAY_MS;
const PROFILE_SESSION_IDS: readonly string[] = ["asia", "london", "nyam", "nypm"];

export interface ProfileWindow {
  from: number;
  to: number | null;
  pieceMs: number;
  label: string;
}

/** The candles on screen: their first open, their last close, and whether the newest candle is among them. */
export interface ChartView {
  fromMs: number;
  toMs: number;
  liveEdge: boolean;
}

function lastNyMinute(nowMs: number, minuteOfDay: number): number {
  let at = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  at -= ((nyLocalMinuteOfDay(at) - minuteOfDay + 1440) % 1440) * MINUTE_MS;
  for (let i = 0; i < 2 && nyLocalMinuteOfDay(at) !== minuteOfDay; i += 1) {
    at += (minuteOfDay - nyLocalMinuteOfDay(at)) * MINUTE_MS;
  }
  return at;
}

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

function lastNyWeekday(nowMs: number, minuteOfDay: number, weekday: number): number {
  let at = lastNyMinute(nowMs, minuteOfDay);
  for (let i = 0; i < 7 && weekdayOf(nyLocalDateKey(at)) !== weekday; i += 1) {
    at = lastNyMinute(at - MINUTE_MS, minuteOfDay);
  }
  return at;
}

/** When the trading day opened: 00:00 UTC for crypto, 18:00 New York for futures, New York midnight for stocks. */
export function dayOpenFor(identity: FrameIdentity, nowMs: number): number {
  if (identity.provider === "BINANCE") return Math.floor(nowMs / DAY_MS) * DAY_MS;
  return lastNyMinute(nowMs, identity.assetClass === "FUTURE" ? FUTURES_OPEN_MINUTE : 0);
}

/** When the trading week opened: Monday 00:00 UTC for crypto, Sunday 18:00 New York for futures, Monday midnight New York for stocks. */
export function weekOpenFor(identity: FrameIdentity, nowMs: number): number {
  if (identity.provider === "BINANCE") {
    const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
    return day - ((new Date(day).getUTCDay() - MONDAY + 7) % 7) * DAY_MS;
  }
  return identity.assetClass === "FUTURE" ? lastNyWeekday(nowMs, FUTURES_OPEN_MINUTE, SUNDAY) : lastNyWeekday(nowMs, 0, MONDAY);
}

/** The Killzones session the clock is in, or the last one that finished, on every market. */
export function sessionWindowFor(nowMs: number): ProfileWindow {
  let best: { from: number; to: number; label: string } | null = null;
  for (const session of KILLZONE_SESSIONS) {
    if (!PROFILE_SESSION_IDS.includes(session.id)) continue;
    const from = lastNyMinute(nowMs, session.startMin);
    const length = ((session.endMin - session.startMin + 1440) % 1440) * MINUTE_MS;
    const to = from + length;
    if (best === null || from > best.from) best = { from, to, label: session.label };
  }
  if (best === null) throw new Error("sessionWindowFor: no profile session in the Killzones table");
  const frozen = nowMs >= best.to;
  return { from: best.from, to: best.to, pieceMs: DAY_PIECE_MS, label: frozen ? `${best.label} · frozen` : best.label };
}

/** The candles on screen, to the minute, no further back than the host keeps trades; open ended while the newest candle is on screen. */
export function visibleWindowFor(view: ChartView, nowMs: number): ProfileWindow {
  const limit = Math.floor((nowMs - HISTORY_LIMIT_MS) / MINUTE_MS) * MINUTE_MS;
  const wanted = Math.floor(view.fromMs / MINUTE_MS) * MINUTE_MS;
  const from = Math.max(wanted, limit);
  const to = view.liveEdge ? null : Math.max(from + MINUTE_MS, Math.ceil(view.toMs / MINUTE_MS) * MINUTE_MS);
  const clipped = wanted < limit ? ` · nothing before ${new Date(limit).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}` : "";
  return { from, to, pieceMs: VISIBLE_PIECE_MS, label: `on screen${clipped}` };
}

function rollingWindowFor(hours: number, nowMs: number): ProfileWindow {
  const from = Math.floor((nowMs - hours * HOUR_MS) / ROLLING_SLICE_MS) * ROLLING_SLICE_MS;
  return { from, to: null, pieceMs: ROLLING_SLICE_MS, label: `last ${hours % 1 === 0 ? hours : hours.toFixed(1)} h` };
}

/** The window the profile covers under these settings on a chart of this timeframe, and what to call it. */
export function windowFor(identity: FrameIdentity, settings: LiveDeltaProfileSettings, nowMs: number, intervalMs: number, view: ChartView | null = null): ProfileWindow {
  const mode = settings.windowMode === "auto" ? autoWindowMode(intervalMs) : settings.windowMode;
  if (mode === "visible" && view !== null) return visibleWindowFor(view, nowMs);
  if (mode === "week") return { from: weekOpenFor(identity, nowMs), to: null, pieceMs: DAY_PIECE_MS, label: "this week" };
  if (mode === "session") return sessionWindowFor(nowMs);
  if (mode === "rolling") return rollingWindowFor(settings.windowMode === "auto" ? AUTO_ROLLING_HOURS : rollingHoursOf(settings), nowMs);
  return { from: dayOpenFor(identity, nowMs), to: null, pieceMs: DAY_PIECE_MS, label: "today" };
}
