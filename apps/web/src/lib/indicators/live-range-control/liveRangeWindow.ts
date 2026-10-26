import type { LiveRangeMode } from "./liveRangeSettings";

export interface LiveRangeWindow {
  fromMs: number | null;
  toMs: number | null;
}

export interface WindowBounds {
  fromMs: number;
  toMs: number | null;
}

export interface WindowMinutes {
  from: number;
  to: number;
  max: number;
}

export const MIN_WINDOW_MS = 60_000;
export const WINDOW_TICK_MS = 1_000;
export const WINDOW_SPAN_MS = 7 * 24 * 3_600_000;
export const WINDOW_STORAGE_KEY = "terminal.live-range-control.window.v1";
export const WHOLE_WINDOW: LiveRangeWindow = Object.freeze({ fromMs: null, toMs: null });
export const WINDOW_THUMB_PX = 8;

export function originOf(nowMs: number): number {
  return Math.floor((nowMs - WINDOW_SPAN_MS) / MIN_WINDOW_MS) * MIN_WINDOW_MS;
}

export function windowFor(mode: LiveRangeMode, window: LiveRangeWindow): LiveRangeWindow {
  return mode === "live" && window.toMs !== null ? { fromMs: window.fromMs, toMs: null } : window;
}

export function windowBounds(startMs: number, window: LiveRangeWindow, nowMs: number): WindowBounds {
  const end = window.toMs === null ? nowMs : Math.min(nowMs, window.toMs);
  const latestFrom = Math.max(startMs, end - MIN_WINDOW_MS);
  const fromMs = Math.min(latestFrom, Math.max(startMs, window.fromMs ?? startMs));
  if (window.toMs === null) return { fromMs, toMs: null };
  return { fromMs, toMs: Math.max(end, fromMs + MIN_WINDOW_MS) };
}

export function windowToMinutes(startMs: number, window: LiveRangeWindow, nowMs: number): WindowMinutes {
  const max = Math.max(1, Math.ceil((nowMs - startMs) / MIN_WINDOW_MS));
  const to = window.toMs === null ? max : Math.min(max, Math.max(1, Math.round((window.toMs - startMs) / MIN_WINDOW_MS)));
  const from = Math.min(to - 1, Math.max(0, window.fromMs === null ? 0 : Math.round((window.fromMs - startMs) / MIN_WINDOW_MS)));
  return { from, to, max };
}

export function windowFromMinutes(startMs: number, from: number, to: number, max: number): LiveRangeWindow {
  const end = Math.min(max, Math.max(1, Math.round(to)));
  const begin = Math.min(end - 1, Math.max(0, Math.round(from)));
  return {
    fromMs: begin <= 0 ? null : startMs + begin * MIN_WINDOW_MS,
    toMs: end >= max ? null : startMs + end * MIN_WINDOW_MS,
  };
}

export function windowCut(box: { left: number; width: number }, fromShare: number, toShare: number, pixelRatio: number): number | null {
  if (!(box.width > 2 * WINDOW_THUMB_PX)) return null;
  const middle = WINDOW_THUMB_PX + ((fromShare + toShare) / 2) * (box.width - 2 * WINDOW_THUMB_PX);
  const ratio = pixelRatio > 0 ? pixelRatio : 1;
  return Math.round((box.left + middle) * ratio) / ratio - box.left;
}

function stamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function isWindow(value: unknown): value is LiveRangeWindow {
  if (value === null || typeof value !== "object") return false;
  const { fromMs, toMs } = value as { fromMs?: unknown; toMs?: unknown };
  return stamp(fromMs) && stamp(toMs) && (fromMs === null || toMs === null || fromMs < toMs);
}

function storageOf(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadWindow(storage?: Storage | null): LiveRangeWindow {
  const store = storageOf(storage);
  if (store === null) return WHOLE_WINDOW;
  try {
    const raw = store.getItem(WINDOW_STORAGE_KEY);
    if (raw === null) return WHOLE_WINDOW;
    const parsed: unknown = JSON.parse(raw);
    return isWindow(parsed) ? { fromMs: parsed.fromMs, toMs: parsed.toMs } : WHOLE_WINDOW;
  } catch {
    return WHOLE_WINDOW;
  }
}

export function saveWindow(window: LiveRangeWindow, storage?: Storage | null): void {
  const store = storageOf(storage);
  if (store === null) return;
  try {
    if (window.fromMs === null && window.toMs === null) store.removeItem(WINDOW_STORAGE_KEY);
    else store.setItem(WINDOW_STORAGE_KEY, JSON.stringify({ fromMs: window.fromMs, toMs: window.toMs }));
  } catch {
    void 0;
  }
}
