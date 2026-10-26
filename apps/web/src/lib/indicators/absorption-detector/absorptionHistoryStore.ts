import { ABSORPTION_ENGINE_VERSION, isAbsorptionRecord, type AbsorptionRecord } from "./absorptionEngine";

export const ABSORPTION_HISTORY_STORAGE_KEY = `terminal.absorption-history.v${ABSORPTION_ENGINE_VERSION}`;
export const RETIRED_HISTORY_STORAGE_KEYS: readonly string[] = Array.from({ length: ABSORPTION_ENGINE_VERSION - 1 }, (_, i) => `terminal.absorption-history.v${i + 1}`);
export const HISTORY_STORE_MAX_BYTES = 512 * 1024;
export const HISTORY_STORE_KEEP_MS = 8 * 86_400_000;

type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

/** One judged hour of the host's columns: its records, and how far into the hour they were judged. */
export interface StoredHour {
  start: number;
  end: number;
  records: AbsorptionRecord[];
}

export interface StoredShown {
  first: number;
  to: number;
}

export interface StoredHistory {
  hours: StoredHour[];
  shown: StoredShown | null;
}

interface Entry extends StoredHistory {
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hourOf(value: unknown): StoredHour | null {
  if (!isRecord(value) || !Number.isFinite(value.start) || !Number.isFinite(value.end) || !Array.isArray(value.records)) return null;
  return { start: value.start as number, end: value.end as number, records: value.records.filter(isAbsorptionRecord) };
}

function shownOf(value: unknown): StoredShown | null {
  return isRecord(value) && Number.isFinite(value.first) && Number.isFinite(value.to) ? { first: value.first as number, to: value.to as number } : null;
}

function entryOf(value: unknown): Entry | null {
  if (!isRecord(value) || !Number.isFinite(value.at) || !Array.isArray(value.hours)) return null;
  return { at: value.at as number, shown: shownOf(value.shown), hours: value.hours.map(hourOf).filter((hour): hour is StoredHour => hour !== null) };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The absorption history's judged hours, kept in the browser per instrument,
 * timeframe and rules, so a reload shows the reach it had at once and asks
 * the host only for the hours since. Bounded: hours older than eight days go,
 * over the budget the keys used longest ago go first, and a key over it on
 * its own keeps its newest hours and shows only from the oldest it kept.
 */
export class AbsorptionHistoryStore {
  private readonly _storage: StorageLike | null;
  private _entries: Map<string, Entry> | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this._storage = storage;
    try {
      for (const key of RETIRED_HISTORY_STORAGE_KEYS) storage?.removeItem?.(key);
    } catch {}
  }

  load(key: string): StoredHistory | null {
    const entry = this._all().get(key);
    return entry === undefined ? null : { hours: entry.hours, shown: entry.shown };
  }

  save(key: string, hours: readonly StoredHour[], shown: StoredShown | null, nowMs: number): void {
    const all = this._all();
    const oldest = nowMs - HISTORY_STORE_KEEP_MS;
    all.delete(key);
    all.set(key, { at: nowMs, shown, hours: hours.filter((hour) => hour.start >= oldest).map((hour) => ({ ...hour, records: [...hour.records] })) });
    let text = this._text(all);
    while (text.length > HISTORY_STORE_MAX_BYTES && all.size > 1) {
      let drop: string | null = null;
      for (const [other, entry] of all) if (other !== key && (drop === null || entry.at < (all.get(drop) as Entry).at)) drop = other;
      if (drop === null) break;
      all.delete(drop);
      text = this._text(all);
    }
    if (text.length > HISTORY_STORE_MAX_BYTES) {
      const own = all.get(key) as Entry;
      let over = text.length - HISTORY_STORE_MAX_BYTES;
      let cut = 0;
      for (; cut < own.hours.length && over > 0; cut += 1) over -= JSON.stringify(own.hours[cut]).length + 1;
      own.hours = own.hours.slice(cut);
      const kept = own.hours[0]?.start ?? Infinity;
      if (own.shown !== null && own.shown.first < kept) own.shown = kept < own.shown.to ? { first: kept, to: own.shown.to } : null;
      text = this._text(all);
    }
    try {
      this._storage?.setItem(ABSORPTION_HISTORY_STORAGE_KEY, text);
    } catch {}
  }

  private _text(all: Map<string, Entry>): string {
    return JSON.stringify(Object.fromEntries(all));
  }

  private _all(): Map<string, Entry> {
    if (this._entries !== null) return this._entries;
    const all = new Map<string, Entry>();
    try {
      const raw = this._storage?.getItem(ABSORPTION_HISTORY_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const entry = entryOf(value);
          if (entry !== null) all.set(key, entry);
        }
      }
    } catch {}
    this._entries = all;
    return all;
  }
}
