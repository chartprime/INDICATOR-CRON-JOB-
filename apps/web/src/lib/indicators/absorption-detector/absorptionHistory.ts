import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { ColumnHistoryStream, STREAM_CHUNK_MS, STREAM_LEVEL_MS, type StreamPage } from "../passive-liquidity/columnHistoryStream";
import type { BarClose } from "../institutional-order-blocks-v2/bandTracker";
import { AbsorptionTracker, type AbsorptionRecord } from "./absorptionEngine";
import type { AbsorptionRules } from "./absorptionSettings";
import type { AbsorptionHistoryStore } from "./absorptionHistoryStore";

export const HISTORY_WARMUP_MS = 8 * STREAM_CHUNK_MS;
export const HISTORY_BLOCK_MS = 24 * STREAM_CHUNK_MS;
export const HISTORY_KEEP_COLUMNS = 360;
export const DEFAULT_HISTORY_REACH_MS = 48 * 3_600_000;
export const MAX_HISTORY_REACH_MS = 7 * 86_400_000;

export interface HistoryBars {
  closes: readonly BarClose[];
  intervalMs: number;
  fromTs: number;
}

export interface HistoryLive {
  columns: readonly LiquidityColumn[];
  columnMs: number;
}

interface Run {
  tracker: AbsorptionTracker;
  window: LiquidityColumn[];
  records: AbsorptionRecord[];
  storeFrom: number;
  endTs: number;
  hostEnd: number;
  cursor: number;
  lastTs: number;
  buffered: Map<number, LiquidityColumn[]>;
  fetched: Set<number>;
  unsettled: Set<number>;
}

/** The stretch of time whose spheres are on screen: a reach that was whole, kept while a longer one loads. */
interface Shown {
  first: number;
  to: number;
}

interface Cache {
  chunks: Map<number, AbsorptionRecord[]>;
  ends: Map<number, number>;
  settled: Set<number>;
  shown: Shown | null;
}

export interface AbsorptionHistoryStatus {
  reachTs: number | null;
  inFlight: number;
  unavailable: string | null;
  /** The asked reach is not whole yet and is at least an hour longer or shorter than the one on screen. */
  loading: boolean;
}

function rulesKeyOf(rules: AbsorptionRules, rowWidth: number, intervalMs: number): string {
  return JSON.stringify([rules.instrument, rules.bandRows, rules.wallKey, rules.quietMs, rowWidth, intervalMs]);
}

function chunkOf(ts: number): number {
  return Math.floor(ts / STREAM_CHUNK_MS) * STREAM_CHUNK_MS;
}

function emptyCache(): Cache {
  return { chunks: new Map(), ends: new Map(), settled: new Set(), shown: null };
}

export class AbsorptionHistory {
  private readonly _stream: ColumnHistoryStream;
  private readonly _store: AbsorptionHistoryStore | null;
  private readonly _unsubscribe: () => void;
  private _rules: AbsorptionRules | null = null;
  private _rowWidth = 0;
  private _intervalMs = 60_000;
  private _rulesKey = "";
  private _refused = false;
  private _run: Run | null = null;
  /** The last finished run: carried on when the live book moves into a new hour of the same day, so the day is not read again. */
  private _tail: Run | null = null;
  private _cache: Cache = emptyCache();
  private _byKey = new Map<string, Cache>();
  private _wanted: { first: number; to: number; seam: number } | null = null;
  private _live: HistoryLive | null = null;
  private _bars: HistoryBars | null = null;
  private _records: readonly AbsorptionRecord[] = [];
  private _listeners = new Set<() => void>();

  constructor(stream: ColumnHistoryStream, store: AbsorptionHistoryStore | null = null) {
    this._stream = stream;
    this._store = store;
    this._unsubscribe = stream.subscribe({ onPage: (page) => this._onPage(page), onChunk: (start, done) => this._onChunk(start, done) });
  }

  dispose(): void {
    this._unsubscribe();
    this._listeners.clear();
    this._run = null;
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  get records(): readonly AbsorptionRecord[] {
    return this._records;
  }

  get running(): boolean {
    return this._run !== null;
  }

  /** Where the spheres on screen begin, or null while nothing of the reach is shown. */
  get shownFrom(): number | null {
    return this._cache.shown?.first ?? null;
  }

  covers(ts: number): boolean {
    const shown = this._cache.shown;
    if (shown === null || ts < shown.first || ts >= shown.to) return false;
    const chunk = chunkOf(ts);
    const end = this._cache.ends.get(chunk);
    return this._cache.settled.has(chunk) && end !== undefined && ts < end;
  }

  status(): AbsorptionHistoryStatus {
    const status = this._stream.status();
    let reachTs: number | null = null;
    for (const start of this._cache.settled) if (reachTs === null || start < reachTs) reachTs = start;
    const wanted = this._wanted;
    const shown = this._cache.shown;
    const loading = wanted !== null && !this._whole(wanted) && (shown === null || Math.abs(wanted.to - wanted.first - (shown.to - shown.first)) >= STREAM_CHUNK_MS);
    return { reachTs, inFlight: status.inFlight, unavailable: status.unavailable, loading };
  }

  /** Whether every hour of the stretch is judged. */
  private _whole({ first, to }: { first: number; to: number }): boolean {
    for (let chunk = first; chunk < to; chunk += STREAM_CHUNK_MS) if (!this._cache.settled.has(chunk)) return false;
    return true;
  }

  private _show(): void {
    const wanted = this._wanted;
    const shown = this._cache.shown;
    if (wanted === null || !this._whole(wanted) || (shown !== null && shown.first === wanted.first && shown.to === wanted.to)) return;
    this._cache.shown = { first: wanted.first, to: wanted.to };
  }

  setRules(rules: AbsorptionRules | null, rowWidth: number, intervalMs = this._intervalMs): void {
    const key = rules === null || !(rowWidth > 0) ? "" : rulesKeyOf(rules, rowWidth, intervalMs);
    if (key === this._rulesKey) return;
    this._rulesKey = key;
    this._rules = rules;
    this._rowWidth = rowWidth;
    this._intervalMs = intervalMs;
    this._refused = false;
    this._stop();
    this._tail = null;
    let cache = this._byKey.get(key);
    if (cache === undefined) {
      cache = this._restore(key);
      if (key !== "") this._byKey.set(key, cache);
    }
    this._cache = cache;
    this._wanted = null;
    this._merge();
    this._changed();
  }

  /** The judged hours of this key as the store kept them from an earlier session, or nothing. */
  private _restore(key: string): Cache {
    const cache = emptyCache();
    const stored = key === "" ? null : this._store?.load(key) ?? null;
    if (stored === null) return cache;
    for (const hour of stored.hours) {
      cache.chunks.set(hour.start, hour.records);
      cache.ends.set(hour.start, hour.end);
      cache.settled.add(hour.start);
    }
    cache.shown = stored.shown;
    return cache;
  }

  private _keep(): void {
    if (this._store === null || this._rulesKey === "") return;
    const { chunks, ends, settled, shown } = this._cache;
    const hours = [...settled].sort((a, b) => a - b).map((start) => ({ start, end: ends.get(start) ?? start + STREAM_CHUNK_MS, records: chunks.get(start) ?? [] }));
    this._store.save(this._rulesKey, hours, shown, Date.now());
  }

  private _stop(): void {
    const run = this._run;
    if (run === null) return;
    for (const chunk of run.unsettled) {
      this._cache.chunks.delete(chunk);
      this._cache.ends.delete(chunk);
    }
    this._run = null;
    this._stream.reset();
  }

  private _merge(): void {
    this._show();
    const shown = this._cache.shown;
    const merged: AbsorptionRecord[] = [];
    if (shown !== null) for (const list of this._cache.chunks.values()) for (const record of list) if (record.ts >= shown.first && record.ts < shown.to) merged.push(record);
    this._records = merged.sort((a, b) => a.ts - b.ts || a.band - b.band);
  }

  want(fromTs: number, toTs: number, seamTs: number, reachMs: number, live: HistoryLive | null, bars: HistoryBars | null): void {
    if (this._rules === null || !(this._rowWidth > 0)) return;
    this._live = live;
    this._bars = bars;
    const from = Math.max(fromTs, seamTs - reachMs);
    const to = Math.min(toTs, seamTs);
    if (to <= from) return;
    // A day is judged from eight hours before its midnight, by the chart's candles: the reach is the days they can warm up.
    const warmable = bars === null ? Infinity : Math.ceil((bars.fromTs + HISTORY_WARMUP_MS) / HISTORY_BLOCK_MS) * HISTORY_BLOCK_MS;
    this._wanted = { first: Math.min(to, Math.max(chunkOf(from), warmable)), to, seam: seamTs };
    const run = this._run;
    const stopped = run !== null && (run.endTs <= from || run.storeFrom >= to);
    if (stopped) this._stop();
    const shown = this._cache.shown;
    this._merge();
    if (stopped || this._cache.shown !== shown) this._changed();
    this._plan();
  }

  private _changed(): void {
    for (const listener of [...this._listeners]) listener();
  }

  private _plan(): void {
    const wanted = this._wanted;
    const rules = this._rules;
    const bars = this._bars;
    if (this._run !== null || this._refused || wanted === null || rules === null || bars === null || bars.closes.length === 0) return;
    const { settled } = this._cache;
    let next = wanted.first;
    while (next < wanted.to && settled.has(next)) next += STREAM_CHUNK_MS;
    if (next >= wanted.to) return;
    const first = Math.floor(next / HISTORY_BLOCK_MS) * HISTORY_BLOCK_MS;
    if (bars.fromTs > first - HISTORY_WARMUP_MS) return;
    const chunkEnd = Math.min(first + HISTORY_BLOCK_MS, Math.ceil(wanted.seam / STREAM_CHUNK_MS) * STREAM_CHUNK_MS);
    const endTs = Math.min(chunkEnd, wanted.seam);
    const hostEnd = chunkEnd + Math.max(rules.quietMs, rules.breakWindowMs);
    const tail = this._tail;
    this._tail = null;
    this._run = tail !== null && tail.storeFrom === first && tail.lastTs >= first && chunkOf(tail.lastTs) <= next
      ? { ...tail, endTs, hostEnd, cursor: chunkOf(tail.lastTs), buffered: new Map(), fetched: new Set(), unsettled: new Set() }
      : {
        tracker: new AbsorptionTracker(),
        window: [],
        records: [],
        storeFrom: first,
        endTs,
        hostEnd,
        cursor: first - HISTORY_WARMUP_MS,
        lastTs: -Infinity,
        buffered: new Map(),
        fetched: new Set(),
        unsettled: new Set(),
      };
    this._stream.reset();
    this._ask();
  }

  private _ask(): void {
    const run = this._run;
    if (run === null) return;
    this._stream.want(run.cursor, Math.min(run.cursor + 4 * STREAM_CHUNK_MS, run.hostEnd), 0, 0);
  }

  private _feed(run: Run, columns: readonly LiquidityColumn[], untilTs: number): void {
    const rules = this._rules;
    if (rules === null) return;
    let fed = false;
    for (const column of columns) {
      if (column.ts <= run.lastTs || column.ts >= untilTs) continue;
      run.window.push(column);
      run.lastTs = column.ts;
      fed = true;
    }
    if (!fed) return;
    run.records = run.tracker.update({ epoch: 1, deep: { columns: run.window, columnMs: STREAM_LEVEL_MS }, fine: { columns: [], columnMs: 1_000 } }, this._rowWidth, rules, run.lastTs + STREAM_LEVEL_MS, this._bars?.closes ?? []);
    const keep = Math.max(HISTORY_KEEP_COLUMNS, Math.ceil(rules.quietMs / STREAM_LEVEL_MS) + 60);
    if (run.window.length > 2 * keep) run.window.splice(0, run.window.length - keep);
  }

  private _onPage(page: StreamPage): void {
    const run = this._run;
    if (run === null) return;
    if (page.rowWidth !== this._rowWidth) {
      this._refused = true;
      this._stop();
      this._merge();
      this._changed();
      return;
    }
    let list = run.buffered.get(page.chunkStart);
    if (list === undefined) {
      list = [];
      run.buffered.set(page.chunkStart, list);
    }
    for (const window of page.windows) for (const column of window.columns) list.push(column);
    if (page.chunkStart === run.cursor) this._drain(run);
  }

  private _drain(run: Run): void {
    const list = run.buffered.get(run.cursor);
    if (list === undefined || list.length === 0) return;
    run.buffered.set(run.cursor, []);
    this._feed(run, list, run.hostEnd);
  }

  private _onChunk(start: number, done: boolean): void {
    const run = this._run;
    if (run === null) return;
    if (!done) {
      if (start !== run.cursor) run.buffered.delete(start);
      return;
    }
    run.fetched.add(start);
    while (run.fetched.has(run.cursor)) {
      this._drain(run);
      run.fetched.delete(run.cursor);
      run.buffered.delete(run.cursor);
      if (run.cursor >= run.storeFrom && run.cursor < run.endTs) run.unsettled.add(run.cursor);
      run.cursor += STREAM_CHUNK_MS;
      if (run.cursor >= run.hostEnd) {
        this._finish(run);
        return;
      }
      this._settle(run, false);
    }
    this._ask();
  }

  private _settle(run: Run, final: boolean): void {
    const rules = this._rules;
    if (rules === null || (run.unsettled.size === 0 && !final)) return;
    const margin = rules.quietMs;
    let judged = false;
    for (const chunk of [...run.unsettled]) {
      const end = Math.min(chunk + STREAM_CHUNK_MS, run.endTs);
      this._cache.chunks.set(chunk, run.records.filter((record) => record.ts >= chunk && record.ts < end));
      this._cache.ends.set(chunk, end);
      if (final || run.lastTs + STREAM_LEVEL_MS >= end + margin) {
        this._cache.settled.add(chunk);
        run.unsettled.delete(chunk);
        judged = true;
      }
    }
    this._merge();
    if (judged || final) this._keep();
    this._changed();
  }

  private _finish(run: Run): void {
    const live = this._live;
    if (live !== null && run.lastTs + STREAM_LEVEL_MS < run.hostEnd) this._feed(run, live.columns, run.hostEnd);
    this._settle(run, true);
    this._run = null;
    this._tail = run;
    this._stream.reset();
    this._plan();
  }
}
