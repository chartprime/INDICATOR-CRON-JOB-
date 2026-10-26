import { HISTORY_LEVELS_MS, HISTORY_WINDOW_MS, type DecodedHistoryPage, type HistorySpan, type HistoryWindowState } from "./heatmapHistoryDecode";
import type { LiquidityColumn } from "./liquidityGrid";
import { InFlightPool, retryDelayMs } from "./requestBudget";

export const HISTORY_MAX_BYTES = 96 * 1024 * 1024;
export const HISTORY_MAX_IN_FLIGHT = 2;
export const HISTORY_MAX_REQUESTS_PER_MINUTE = 90;
export const HISTORY_RETRY_MS = 30_000;
export const HISTORY_FAILED_RETRY_MS = 10 * 60_000;
export const HISTORY_GENERATION_RECHECK_MS = 6 * 3_600_000;
export const HISTORY_SPAN_RECHECK_MS = 60_000;
/** One request covers at most this much time, so a reach lands newest chunk first rather than as one oldest-first page run. */
export const HISTORY_REQUEST_SPAN_MS = 3 * 3_600_000;
const WINDOW_OVERHEAD_BYTES = 256;
const POOL_WAIT_MS = 1_000;

export interface HistoryIdentity {
  provider: "BINANCE" | "DXFEED";
  marketKind: string;
  symbol: string;
}

export interface HistoryRequest {
  requestId: number;
  identity: HistoryIdentity;
  levelMs: number;
  rowFactor: number;
  fromTs: number;
  toTs: number;
}

export interface HistoryWant {
  levelMs: number;
  rowFactor: number;
  fromTs: number;
  toTs: number;
  beforeTs: number;
}

export interface HistoryStatus {
  rowWidth: number | null;
  span: HistorySpan | null;
  reachTs: number | null;
  unavailable: string | null;
}

/** What the chart draws for a reach: the last reach that landed whole, and whether the asked one is still on its way. */
export interface HistoryReach {
  columns: readonly LiquidityColumn[];
  shown: HistoryWant | null;
  loading: boolean;
}

interface StoredWindow {
  state: HistoryWindowState;
  columns: LiquidityColumn[];
  bytes: number;
  usedAt: number;
}

interface Slot {
  windows: Map<number, StoredWindow>;
  recheckAt: Map<number, number>;
  pending: Set<number>;
  rowWidth: number | null;
  span: HistorySpan | null;
  spanRecheckAt: number;
  spanWake: ReturnType<typeof setTimeout> | null;
  unavailable: string | null;
  retryAt: number;
  cacheKey: string;
  cache: readonly LiquidityColumn[];
}

interface InFlight {
  request: HistoryRequest;
}

const EMPTY: readonly LiquidityColumn[] = Object.freeze([]);

function windowStart(ts: number): number {
  return Math.floor(ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
}

function identityKeyOf(identity: HistoryIdentity | null): string {
  return identity === null ? "" : `${identity.provider}:${identity.marketKind}:${identity.symbol}`;
}

function slotKeyOf(levelMs: number, rowFactor: number): string {
  return `${levelMs}:${rowFactor}`;
}

export class HeatmapHistory {
  private readonly _request: (request: HistoryRequest) => void;
  private readonly _now: () => number;
  private readonly _maxBytes: number;
  private readonly _maxInFlight: number;
  private readonly _maxPerMinute: number;
  private readonly _retryMs: number;
  private readonly _requestSpanMs: number;
  private readonly _pool: InFlightPool;
  private _identity: HistoryIdentity | null = null;
  private _identityKey = "";
  private _generation: string | null = null;
  private _slots = new Map<string, Slot>();
  private _inFlight = new Map<number, InFlight>();
  private _requestTimes: number[] = [];
  private _budgetWake: ReturnType<typeof setTimeout> | null = null;
  private _retryWake: ReturnType<typeof setTimeout> | null = null;
  private _retryWakeAt = Infinity;
  private _nextId = 1;
  private _bytes = 0;
  private _pinned: { slot: string; from: number; to: number } | null = null;
  private _shown: HistoryWant | null = null;
  private _listeners = new Set<() => void>();
  version = 0;

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _changed(): void {
    this.version += 1;
    for (const listener of [...this._listeners]) listener();
  }

  constructor({
    request,
    now = () => Date.now(),
    maxBytes = HISTORY_MAX_BYTES,
    maxInFlight = HISTORY_MAX_IN_FLIGHT,
    maxPerMinute = HISTORY_MAX_REQUESTS_PER_MINUTE,
    retryMs = HISTORY_RETRY_MS,
    requestSpanMs = HISTORY_REQUEST_SPAN_MS,
    pool = new InFlightPool(maxInFlight),
  }: {
    request: (request: HistoryRequest) => void;
    now?: () => number;
    maxBytes?: number;
    maxInFlight?: number;
    maxPerMinute?: number;
    retryMs?: number;
    requestSpanMs?: number;
    pool?: InFlightPool;
  }) {
    this._request = request;
    this._now = now;
    this._maxBytes = maxBytes;
    this._maxInFlight = maxInFlight;
    this._maxPerMinute = maxPerMinute;
    this._retryMs = retryMs;
    this._requestSpanMs = requestSpanMs;
    this._pool = pool;
  }

  get bytes(): number {
    return this._bytes;
  }

  get inFlight(): number {
    return this._inFlight.size;
  }

  setIdentity(identity: HistoryIdentity | null): void {
    const key = identityKeyOf(identity);
    if (key === this._identityKey) return;
    this._identity = identity === null ? null : { ...identity };
    this._identityKey = key;
    if (this._budgetWake !== null) clearTimeout(this._budgetWake);
    this._budgetWake = null;
    this._generation = null;
    this._clearSlots();
    this._dropInFlight();
    this._bytes = 0;
    this._pinned = null;
    this._shown = null;
    this._changed();
  }

  private _slot(levelMs: number, rowFactor: number): Slot {
    const key = slotKeyOf(levelMs, rowFactor);
    let slot = this._slots.get(key);
    if (slot === undefined) {
      slot = { windows: new Map(), recheckAt: new Map(), pending: new Set(), rowWidth: null, span: null, spanRecheckAt: 0, spanWake: null, unavailable: null, retryAt: 0, cacheKey: "", cache: EMPTY };
      this._slots.set(key, slot);
    }
    return slot;
  }

  private _clearSlots(): void {
    for (const slot of this._slots.values()) if (slot.spanWake !== null) clearTimeout(slot.spanWake);
    this._slots.clear();
    if (this._retryWake !== null) clearTimeout(this._retryWake);
    this._retryWake = null;
    this._retryWakeAt = Infinity;
  }

  private _scheduleRetryWake(at: number, dueAt: number): void {
    if (this._retryWake !== null && this._retryWakeAt <= dueAt) return;
    if (this._retryWake !== null) clearTimeout(this._retryWake);
    this._retryWakeAt = dueAt;
    this._retryWake = setTimeout(() => {
      this._retryWake = null;
      this._retryWakeAt = Infinity;
      this._changed();
    }, Math.max(1, dueAt - at));
    (this._retryWake as unknown as { unref?: () => void }).unref?.();
  }

  private _scheduleSpanWake(slot: Slot, at: number): void {
    if (slot.spanWake !== null) return;
    slot.spanWake = setTimeout(() => {
      slot.spanWake = null;
      this._changed();
    }, Math.max(1, slot.spanRecheckAt - at));
    (slot.spanWake as unknown as { unref?: () => void }).unref?.();
  }

  private _budgetLeft(at: number): boolean {
    this._requestTimes = this._requestTimes.filter((t) => at - t < 60_000);
    return this._inFlight.size < this._maxInFlight && this._pool.left() && this._requestTimes.length < this._maxPerMinute;
  }

  private _dropInFlight(): void {
    this._pool.free(this._inFlight.size);
    this._inFlight.clear();
  }

  private _scheduleBudgetWake(at: number): void {
    const rateSpent = this._requestTimes.length >= this._maxPerMinute;
    const poolHeld = !this._pool.left() && this._inFlight.size < this._maxInFlight;
    if (this._budgetWake !== null || (!rateSpent && !poolHeld)) return;
    const delay = rateSpent ? Math.max(1, this._requestTimes[0] + 60_000 - at) : POOL_WAIT_MS;
    this._budgetWake = setTimeout(() => {
      this._budgetWake = null;
      this._changed();
    }, delay);
    (this._budgetWake as unknown as { unref?: () => void }).unref?.();
  }

  private _send(levelMs: number, rowFactor: number, fromTs: number, toTs: number, at: number): void {
    if (this._identity === null) return;
    const request: HistoryRequest = { requestId: this._nextId, identity: this._identity, levelMs, rowFactor, fromTs, toTs };
    this._nextId += 1;
    this._requestTimes.push(at);
    this._pool.take();
    this._inFlight.set(request.requestId, { request });
    const slot = this._slot(levelMs, rowFactor);
    for (let ts = fromTs; ts < toTs; ts += HISTORY_WINDOW_MS) slot.pending.add(ts);
    this._request(request);
  }

  want({ levelMs, rowFactor, fromTs, toTs, beforeTs }: HistoryWant): void {
    if (this._identity === null || !HISTORY_LEVELS_MS.includes(levelMs)) return;
    const at = this._now();
    const slot = this._slot(levelMs, rowFactor);
    let from = windowStart(fromTs);
    const oldest = slot.span?.oldest;
    if (oldest !== null && oldest !== undefined && from < oldest) {
      const probe = windowStart(oldest) - HISTORY_WINDOW_MS;
      if (at >= slot.spanRecheckAt && !slot.pending.has(probe) && this._budgetLeft(at)) {
        slot.spanRecheckAt = at + HISTORY_SPAN_RECHECK_MS;
        this._send(levelMs, rowFactor, probe, probe + HISTORY_WINDOW_MS, at);
      } else if (at < slot.spanRecheckAt) this._scheduleSpanWake(slot, at);
      else this._scheduleBudgetWake(at);
    }
    let to = Math.min(toTs, beforeTs);
    if (slot.span !== null && slot.span.oldest !== null) from = Math.max(from, slot.span.oldest);
    if (slot.span !== null && slot.span.newest !== null) to = Math.min(to, slot.span.newest + HISTORY_WINDOW_MS);
    this._pinned = { slot: slotKeyOf(levelMs, rowFactor), from, to };
    if (to <= from) return;
    if (slot.unavailable !== null && at < slot.retryAt) {
      this._scheduleRetryWake(at, slot.retryAt);
      return;
    }
    const missing: number[] = [];
    for (let ts = windowStart(to - 1); ts >= from; ts -= HISTORY_WINDOW_MS) {
      if (slot.pending.has(ts)) continue;
      const held = slot.windows.get(ts);
      const recheck = slot.recheckAt.get(ts);
      if (held !== undefined && recheck === undefined) continue;
      if (recheck !== undefined && at < recheck) {
        this._scheduleRetryWake(at, recheck);
        continue;
      }
      missing.push(ts);
    }
    let index = 0;
    while (index < missing.length && this._budgetLeft(at)) {
      const hi = missing[index];
      let lo = hi;
      index += 1;
      while (index < missing.length && missing[index] === lo - HISTORY_WINDOW_MS && hi + HISTORY_WINDOW_MS - (lo - HISTORY_WINDOW_MS) <= this._requestSpanMs) {
        lo = missing[index];
        index += 1;
      }
      this._send(levelMs, rowFactor, lo, hi + HISTORY_WINDOW_MS, at);
    }
    if (index < missing.length) this._scheduleBudgetWake(at);
  }

  /** The windows of a want the slot still owes: none when every one is held, answered empty, failed or already on its way back. */
  private _owed(want: HistoryWant): number {
    const slot = this._slots.get(slotKeyOf(want.levelMs, want.rowFactor));
    if (slot === undefined) return Infinity;
    let from = windowStart(want.fromTs);
    if (slot.span !== null && slot.span.oldest !== null) from = Math.max(from, slot.span.oldest);
    let to = Math.min(want.toTs, want.beforeTs);
    if (slot.span !== null && slot.span.newest !== null) to = Math.min(to, slot.span.newest + HISTORY_WINDOW_MS);
    if (to <= from) return slot.span === null ? Infinity : 0;
    let owed = 0;
    for (let ts = windowStart(to - 1); ts >= from; ts -= HISTORY_WINDOW_MS) {
      if (slot.pending.has(ts) || (!slot.windows.has(ts) && !slot.recheckAt.has(ts))) owed += 1;
    }
    return owed;
  }

  private _sameReach(a: HistoryWant, b: HistoryWant): boolean {
    return a.levelMs === b.levelMs && a.rowFactor === b.rowFactor && Math.abs((a.toTs - a.fromTs) - (b.toTs - b.fromTs)) < HISTORY_WINDOW_MS;
  }

  /**
   * Ask for a whole reach and draw it only once it has all landed. Until then
   * the last reach that landed whole stays on screen, so a longer choice keeps
   * the picture it had and swaps once, newest chunk having been asked first.
   * A reach of the same length and level that merely slides with the live
   * edge is not a new choice: it fills in quietly.
   */
  reach(want: HistoryWant): HistoryReach {
    this.want(want);
    const whole = this._owed(want) === 0;
    if (whole) this._shown = { ...want };
    const shown = this._shown;
    const loading = !whole && (shown === null || !this._sameReach(shown, want));
    return { columns: shown === null ? EMPTY : this.columns(shown), shown, loading };
  }

  accept(requestId: number, page: DecodedHistoryPage | null): void {
    const entry = this._inFlight.get(requestId);
    if (entry === undefined) return;
    this._inFlight.delete(requestId);
    this._pool.free();
    const { request } = entry;
    const at = this._now();
    if (page !== null && page.available && page.generation !== null) {
      if (this._generation !== null && this._generation !== page.generation) {
        this._clearSlots();
        this._dropInFlight();
        this._bytes = 0;
      }
      this._generation = page.generation;
    }
    const slot = this._slot(request.levelMs, request.rowFactor);
    for (let ts = request.fromTs; ts < request.toTs; ts += HISTORY_WINDOW_MS) slot.pending.delete(ts);
    if (page === null || !page.available || page.levelMs !== request.levelMs || page.rowFactor !== request.rowFactor) {
      slot.unavailable = page !== null && !page.available ? page.reason : "MALFORMED_PAGE";
      slot.retryAt = at + this._retryMs;
      this._changed();
      return;
    }
    slot.unavailable = null;
    slot.rowWidth = page.rowWidth;
    slot.span = page.span;
    slot.spanRecheckAt = at + HISTORY_SPAN_RECHECK_MS;
    const answered = new Set<number>();
    for (const window of page.windows) {
      if (window.ts < request.fromTs || window.ts >= request.toTs) continue;
      answered.add(window.ts);
      const previous = slot.windows.get(window.ts);
      if (window.state === "FAILED") {
        slot.recheckAt.set(window.ts, at + HISTORY_FAILED_RETRY_MS);
        continue;
      }
      const bytes = WINDOW_OVERHEAD_BYTES + window.columns.reduce((total, column) => total + column.bid.byteLength + column.ask.byteLength, 0);
      if (previous !== undefined) this._bytes -= previous.bytes;
      slot.windows.set(window.ts, { state: window.state, columns: window.columns, bytes, usedAt: at });
      if (window.state === "COVERED") slot.recheckAt.set(window.ts, at + HISTORY_GENERATION_RECHECK_MS);
      else slot.recheckAt.set(window.ts, at + HISTORY_FAILED_RETRY_MS);
      this._bytes += bytes;
    }
    const pagedTo = page.next === null ? request.toTs : Math.min(request.toTs, page.next);
    for (let ts = request.fromTs; ts < pagedTo; ts += HISTORY_WINDOW_MS) if (!answered.has(ts)) slot.recheckAt.set(ts, at + this._retryMs);
    if (page.next !== null && page.next < request.toTs && page.next > request.fromTs) {
      if (this._budgetLeft(at)) this._send(request.levelMs, request.rowFactor, page.next, request.toTs, at);
      else this._scheduleBudgetWake(at);
    }
    this._trim();
    this._changed();
  }

  fail(requestId: number, retryAfterMs?: number): void {
    const entry = this._inFlight.get(requestId);
    if (entry === undefined) return;
    this._inFlight.delete(requestId);
    this._pool.free();
    const slot = this._slot(entry.request.levelMs, entry.request.rowFactor);
    const at = this._now();
    const delay = retryDelayMs(retryAfterMs, this._retryMs);
    for (let ts = entry.request.fromTs; ts < entry.request.toTs; ts += HISTORY_WINDOW_MS) {
      slot.pending.delete(ts);
      slot.recheckAt.set(ts, at + delay);
    }
    this._changed();
  }

  private _trim(): void {
    if (this._bytes <= this._maxBytes) return;
    const candidates: { slotKey: string; ts: number; usedAt: number; bytes: number }[] = [];
    for (const [slotKey, slot] of this._slots) {
      for (const [ts, window] of slot.windows) {
        const shown = this._shown;
        const pinned = (this._pinned !== null && this._pinned.slot === slotKey && ts >= windowStart(this._pinned.from) && ts < this._pinned.to)
          || (shown !== null && slotKeyOf(shown.levelMs, shown.rowFactor) === slotKey && ts >= windowStart(shown.fromTs) && ts < Math.min(shown.toTs, shown.beforeTs));
        if (!pinned) candidates.push({ slotKey, ts, usedAt: window.usedAt, bytes: window.bytes });
      }
    }
    candidates.sort((a, b) => a.usedAt - b.usedAt);
    for (const candidate of candidates) {
      if (this._bytes <= this._maxBytes) break;
      const slot = this._slots.get(candidate.slotKey);
      if (slot === undefined || !slot.windows.delete(candidate.ts)) continue;
      slot.recheckAt.delete(candidate.ts);
      slot.cacheKey = "";
      this._bytes -= candidate.bytes;
    }
  }

  columns({ levelMs, rowFactor, fromTs, toTs, beforeTs }: HistoryWant): readonly LiquidityColumn[] {
    const slot = this._slots.get(slotKeyOf(levelMs, rowFactor));
    if (slot === undefined || slot.windows.size === 0) return EMPTY;
    const from = windowStart(fromTs);
    const to = Math.min(toTs, beforeTs);
    const key = `${this.version}:${from}:${to}`;
    if (slot.cacheKey === key) return slot.cache;
    const at = this._now();
    const out: LiquidityColumn[] = [];
    for (let ts = from; ts < to; ts += HISTORY_WINDOW_MS) {
      const window = slot.windows.get(ts);
      if (window === undefined) continue;
      window.usedAt = at;
      for (const column of window.columns) if (column.ts >= fromTs - levelMs && column.ts < to) out.push(column);
    }
    slot.cacheKey = key;
    slot.cache = out.length === 0 ? EMPTY : out;
    return slot.cache;
  }

  status(levelMs: number, rowFactor: number): HistoryStatus {
    const slot = this._slots.get(slotKeyOf(levelMs, rowFactor));
    if (slot === undefined) return { rowWidth: null, span: null, reachTs: null, unavailable: null };
    let reachTs: number | null = null;
    for (const [ts, window] of slot.windows) if (window.columns.length > 0 && (reachTs === null || ts < reachTs)) reachTs = ts;
    return { rowWidth: slot.rowWidth, span: slot.span, reachTs, unavailable: slot.unavailable };
  }
}
