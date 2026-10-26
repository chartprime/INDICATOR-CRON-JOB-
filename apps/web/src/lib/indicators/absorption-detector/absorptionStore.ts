import { isAbsorptionRecord, type AbsorptionRecord } from "./absorptionEngine";

export const ABSORPTION_STORAGE_KEY = "terminal.absorption.v8";
export const RETIRED_STORAGE_KEYS: readonly string[] = ["terminal.absorption.v1", "terminal.absorption.v2", "terminal.absorption.v3", "terminal.absorption.v4", "terminal.absorption.v5", "terminal.absorption.v6", "terminal.absorption.v7"];
export const MAX_RECORDS_PER_WALLS = 500;
export const PRINT_KEEP_MS = 7 * 86_400_000;
export const STORE_MAX_BYTES = 1024 * 1024;
export const STORE_SAVE_INTERVAL_MS = 5_000;
export const STORE_WRITE_ATTEMPTS = 4;

type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

interface Entry {
  at: number;
  from: number;
  records: readonly AbsorptionRecord[];
}

interface Fitted {
  entries: Map<string, Entry>;
  text: string;
  dropped: number;
}

/** The same attack read further on: more flow, a newer reading (each new trail entry is one), another refill, or its wall ended since. */
function fuller(incoming: AbsorptionRecord, kept: AbsorptionRecord): boolean {
  return incoming.absorbed > kept.absorbed || incoming.latest.ts > kept.latest.ts || incoming.refills > kept.refills || (incoming.endReason !== null && kept.endReason === null);
}

function snapshot(record: AbsorptionRecord): AbsorptionRecord {
  return { ...record, trail: [...record.trail] };
}

export function mergeRecords(existing: readonly AbsorptionRecord[], incoming: readonly AbsorptionRecord[], nowMs: number, from = 0): readonly AbsorptionRecord[] {
  const oldest = Math.max(nowMs - PRINT_KEEP_MS, from);
  const byKey = new Map<string, AbsorptionRecord>();
  for (const record of existing) if (record.ts >= oldest) byKey.set(record.key, record);
  let added = false;
  for (const record of incoming) {
    if (record.ts < oldest) continue;
    const kept = byKey.get(record.key);
    if (kept !== undefined && !fuller(record, kept)) continue;
    byKey.set(record.key, record);
    added = true;
  }
  if (!added && byKey.size === existing.length) return existing;
  const merged = [...byKey.values()].sort((a, b) => a.ts - b.ts || a.band - b.band);
  const kept = merged.length > MAX_RECORDS_PER_WALLS ? merged.slice(merged.length - MAX_RECORDS_PER_WALLS) : merged;
  return kept.length === existing.length && kept.every((record, i) => record === existing[i]) ? existing : kept;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryOf(value: unknown): Entry | null {
  if (!isObject(value) || !Number.isFinite(value.at) || !Array.isArray(value.records)) return null;
  return { at: value.at as number, from: Number.isFinite(value.from) ? (value.from as number) : 0, records: value.records.filter(isAbsorptionRecord) };
}

function textOf(entries: ReadonlyMap<string, Entry>): string {
  return JSON.stringify(Object.fromEntries(entries));
}

function fit(all: ReadonlyMap<string, Entry>, own: string, limit: number): Fitted {
  const entries = new Map(all);
  let dropped = 0;
  let text = textOf(entries);
  while (text.length > limit) {
    let drop: string | null = null;
    for (const [key, entry] of entries) if (key !== own && (drop === null || entry.at < (entries.get(drop) as Entry).at)) drop = key;
    if (drop === null) break;
    dropped += (entries.get(drop) as Entry).records.length;
    entries.delete(drop);
    text = textOf(entries);
  }
  let entry = entries.get(own);
  while (text.length > limit && entry !== undefined && entry.records.length > 0) {
    const { records } = entry;
    let over = text.length - limit;
    let cut = 0;
    for (; cut < records.length && (over > 0 || records[cut].ts === records[cut - 1].ts); cut += 1) over -= JSON.stringify(records[cut]).length + 1;
    entry = { at: entry.at, from: records[cut - 1].ts + 1, records: records.slice(cut) };
    entries.set(own, entry);
    dropped += cut;
    text = textOf(entries);
  }
  return { entries, text, dropped };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class AbsorptionStore {
  private readonly _storage: StorageLike | null;
  private _entries: Map<string, Entry> | null = null;
  private _unsaved: string | null = null;
  private _savedAt = -Infinity;
  private _maxChars = STORE_MAX_BYTES;
  private _stopped = false;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this._storage = storage;
    try {
      for (const key of RETIRED_STORAGE_KEYS) storage?.removeItem?.(key);
    } catch {}
  }

  load(walls: string): readonly AbsorptionRecord[] {
    return this._all().get(walls)?.records ?? [];
  }

  add(walls: string, records: readonly AbsorptionRecord[], nowMs: number): readonly AbsorptionRecord[] {
    const all = this._all();
    const entry = all.get(walls);
    const before = entry?.records ?? [];
    const merged = mergeRecords(before, records, nowMs, entry?.from);
    let kept = before;
    if (merged !== before) {
      const own = new Set(before);
      kept = merged.map((record) => (own.has(record) ? record : snapshot(record)));
      all.set(walls, { at: nowMs, from: entry?.from ?? 0, records: kept });
      this._unsaved = walls;
    }
    if (this._unsaved !== null && nowMs - this._savedAt >= STORE_SAVE_INTERVAL_MS) {
      this._savedAt = nowMs;
      this.flush();
    }
    return kept;
  }

  flush(): void {
    const own = this._unsaved;
    if (own === null) return;
    this._unsaved = null;
    this._write(own);
  }

  private _write(own: string): void {
    if (this._storage === null || this._stopped) return;
    const fitted = fit(this._all(), own, this._maxChars);
    this._entries = fitted.entries;
    try {
      this._storage.setItem(ABSORPTION_STORAGE_KEY, fitted.text);
    } catch (error) {
      this._shrink(own, fitted, error);
    }
  }

  private _shrink(own: string, wanted: Fitted, error: unknown): void {
    let tried = wanted;
    let failure = error;
    let dropped = 0;
    let attempts = 1;
    while (attempts < STORE_WRITE_ATTEMPTS) {
      const smaller = fit(tried.entries, own, Math.floor(tried.text.length / 2));
      if (smaller.text.length >= tried.text.length) break;
      tried = smaller;
      dropped += smaller.dropped;
      attempts += 1;
      try {
        this._storage?.setItem(ABSORPTION_STORAGE_KEY, tried.text);
        this._entries = tried.entries;
        this._maxChars = tried.text.length;
        return;
      } catch (again) {
        failure = again;
      }
    }
    this._stopped = true;
    const name = failure instanceof Error ? failure.name : String(failure);
    console.warn(`Absorption records are no longer saved this session: ${name} on ${attempts} tries, ${wanted.text.length} characters at first and ${tried.text.length} after leaving out ${dropped} records. The records stay in memory until the page closes.`);
  }

  private _all(): Map<string, Entry> {
    if (this._entries !== null) return this._entries;
    const all = new Map<string, Entry>();
    try {
      const raw = this._storage?.getItem(ABSORPTION_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isObject(parsed)) {
        for (const [instrument, value] of Object.entries(parsed)) {
          const entry = entryOf(value);
          if (entry !== null) all.set(instrument, entry);
        }
      }
    } catch {}
    this._entries = all;
    return all;
  }
}
