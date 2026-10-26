import { HISTORY_WINDOW_MS, type DecodedHistoryPage, type HistoryWindow } from "./heatmapHistoryDecode";
import type { HistoryIdentity, HistoryRequest } from "./heatmapHistory";
import { InFlightPool, RequestBudget, retryDelayMs, type RequestShare } from "./requestBudget";

export const STREAM_LEVEL_MS = 10_000;
export const STREAM_ROW_FACTOR = 1;
export const STREAM_CHUNK_MS = 3_600_000;
/** The runtime relays four host reads at once and refuses a fifth with a short wait; the host's page is about an hour, so a day is some sixty pages. */
export const STREAM_MAX_IN_FLIGHT = 4;
export const STREAM_MAX_REQUESTS_PER_MINUTE = 140;
export const STREAM_RETRY_MS = 30_000;
/** A page the runtime gave up on because the host was busy is asked for again this soon: the host's own wait is a second or two. */
export const STREAM_RATE_LIMIT_RETRY_MS = 3_000;
export const STREAM_ID_BASE = 2 ** 31;
export const STREAM_ID_SPAN = 2 ** 30;
const POOL_WAIT_MS = 1_000;

export interface StreamPage {
  chunkStart: number;
  rowWidth: number;
  windows: readonly HistoryWindow[];
}

export interface StreamListener {
  onPage(page: StreamPage): void;
  onChunk(chunkStart: number, done: boolean, toTs: number): void;
}

export interface StreamStatus {
  oldestDone: number | null;
  inFlight: number;
  unavailable: string | null;
}

interface Shared {
  nextId: number;
  owners: Map<number, ColumnHistoryStream>;
}

interface Chunk {
  start: number;
  fromTs: number;
  toTs: number;
  cursor: number;
  requestId: number | null;
}

function chunkStartOf(ts: number): number {
  return Math.floor(ts / STREAM_CHUNK_MS) * STREAM_CHUNK_MS;
}

function identityKeyOf(identity: HistoryIdentity | null): string {
  return identity === null ? "" : `${identity.provider}:${identity.marketKind}:${identity.symbol}`;
}

export class ColumnHistoryStream {
  private readonly _request: (request: HistoryRequest) => void;
  private readonly _now: () => number;
  private readonly _maxInFlight: number;
  private readonly _pool: InFlightPool;
  private readonly _budget: RequestShare;
  private readonly _retryMs: number;
  private _identity: HistoryIdentity | null = null;
  private _identityKey = "";
  private _done = new Set<number>();
  private _retryAt = new Map<number, number>();
  private _active = new Map<number, Chunk>();
  private _byRequest = new Map<number, Chunk>();
  private _wanted: { fromTs: number; toTs: number; warmupMs: number; marginMs: number; oldestFirst: boolean } | null = null;
  private readonly _shared: Shared;
  private readonly _forks: ColumnHistoryStream[] = [];
  private _unavailable: string | null = null;
  private _wake: ReturnType<typeof setTimeout> | null = null;
  private _listeners = new Set<StreamListener>();

  constructor({
    request,
    now = () => Date.now(),
    maxInFlight = STREAM_MAX_IN_FLIGHT,
    maxPerMinute = STREAM_MAX_REQUESTS_PER_MINUTE,
    budget = new RequestBudget(maxPerMinute).share(),
    retryMs = STREAM_RETRY_MS,
    shared = { nextId: STREAM_ID_BASE, owners: new Map() },
    pool = new InFlightPool(maxInFlight),
  }: {
    request: (request: HistoryRequest) => void;
    now?: () => number;
    maxInFlight?: number;
    maxPerMinute?: number;
    budget?: RequestShare;
    retryMs?: number;
    shared?: Shared;
    pool?: InFlightPool;
  }) {
    this._request = request;
    this._now = now;
    this._maxInFlight = maxInFlight;
    this._pool = pool;
    this._budget = budget;
    this._retryMs = retryMs;
    this._shared = shared;
  }

  fork({ retryMs = this._retryMs }: { retryMs?: number } = {}): ColumnHistoryStream {
    const fork = new ColumnHistoryStream({ request: this._request, now: this._now, maxInFlight: this._maxInFlight, budget: this._budget, retryMs, shared: this._shared, pool: this._pool });
    fork.setIdentity(this._identity);
    this._forks.push(fork);
    return fork;
  }

  private _dropRequests(): void {
    for (const requestId of this._byRequest.keys()) this._shared.owners.delete(requestId);
    this._pool.free(this._byRequest.size);
    this._byRequest.clear();
  }

  subscribe(listener: StreamListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  owns(requestId: number): boolean {
    return requestId >= STREAM_ID_BASE && requestId < STREAM_ID_BASE + STREAM_ID_SPAN;
  }

  get retryMs(): number {
    return this._retryMs;
  }

  get budget(): RequestShare {
    return this._budget;
  }

  get identity(): HistoryIdentity | null {
    return this._identity;
  }

  get inFlight(): number {
    return this._active.size;
  }

  isDone(chunkStart: number): boolean {
    return this._done.has(chunkStart);
  }

  status(): StreamStatus {
    let oldestDone: number | null = null;
    for (const start of this._done) if (oldestDone === null || start < oldestDone) oldestDone = start;
    return { oldestDone, inFlight: this._active.size, unavailable: this._unavailable };
  }

  setIdentity(identity: HistoryIdentity | null): void {
    for (const fork of this._forks) fork.setIdentity(identity);
    const key = identityKeyOf(identity);
    if (key === this._identityKey) return;
    this._identity = identity === null ? null : { ...identity };
    this._identityKey = key;
    this._done.clear();
    this._retryAt.clear();
    this._active.clear();
    this._dropRequests();
    this._wanted = null;
    this._unavailable = null;
    this._clearWake();
  }

  reset(done: Iterable<number> = []): void {
    this._done = new Set(done);
    this._wanted = null;
    this._retryAt.clear();
    this._active.clear();
    this._dropRequests();
    this._unavailable = null;
    this._clearWake();
  }

  private _clearWake(): void {
    if (this._wake !== null) clearTimeout(this._wake);
    this._wake = null;
  }

  private _scheduleWake(delayMs: number): void {
    if (this._wake !== null) return;
    this._wake = setTimeout(() => {
      this._wake = null;
      this._pump();
    }, Math.max(1, delayMs));
    (this._wake as unknown as { unref?: () => void }).unref?.();
  }

  private _rateLeft(at: number): boolean {
    return this._budget.left(at);
  }

  private _canSend(at: number): boolean {
    return this._rateLeft(at) && this._pool.left();
  }

  private _budgetLeft(at: number): boolean {
    return this._canSend(at) && this._active.size < this._maxInFlight;
  }

  private _waitMs(at: number): number {
    return this._rateLeft(at) ? POOL_WAIT_MS : this._budget.waitMs(at);
  }

  want(fromTs: number, toTs: number, warmupMs: number, marginMs: number, oldestFirst = false): void {
    if (this._identity === null || !(toTs > fromTs)) return;
    this._wanted = { fromTs, toTs, warmupMs, marginMs, oldestFirst };
    this._pump();
  }

  private _pump(): void {
    const wanted = this._wanted;
    if (wanted === null || this._identity === null) return;
    const at = this._now();
    for (const chunk of this._active.values()) {
      if (chunk.requestId !== null) continue;
      if (!this._canSend(at)) {
        this._scheduleWake(this._waitMs(at));
        return;
      }
      this._send(chunk, at);
    }
    const first = chunkStartOf(wanted.fromTs);
    const last = chunkStartOf(wanted.toTs - 1);
    let nextRetry = Infinity;
    const step = wanted.oldestFirst ? STREAM_CHUNK_MS : -STREAM_CHUNK_MS;
    for (let start = wanted.oldestFirst ? first : last; start >= first && start <= last; start += step) {
      if (this._done.has(start) || this._active.has(start)) continue;
      const retryAt = this._retryAt.get(start);
      if (retryAt !== undefined && at < retryAt) {
        nextRetry = Math.min(nextRetry, retryAt);
        continue;
      }
      if (!this._budgetLeft(at)) {
        this._scheduleWake(this._waitMs(at));
        return;
      }
      const chunk: Chunk = { start, fromTs: Math.max(0, start - wanted.warmupMs), toTs: Math.min(start + STREAM_CHUNK_MS + wanted.marginMs, wanted.toTs), cursor: 0, requestId: null };
      chunk.cursor = chunk.fromTs;
      this._active.set(start, chunk);
      this._send(chunk, at);
    }
    if (Number.isFinite(nextRetry)) this._scheduleWake(nextRetry - at);
  }

  private _send(chunk: Chunk, at: number): void {
    if (this._identity === null) return;
    const request: HistoryRequest = { requestId: this._shared.nextId, identity: this._identity, levelMs: STREAM_LEVEL_MS, rowFactor: STREAM_ROW_FACTOR, fromTs: chunk.cursor, toTs: chunk.toTs };
    this._shared.nextId += 1;
    chunk.requestId = request.requestId;
    this._byRequest.set(request.requestId, chunk);
    this._shared.owners.set(request.requestId, this);
    this._budget.take(at);
    this._pool.take();
    this._request(request);
  }

  private _finish(chunk: Chunk, done: boolean, at: number, retryMs: number = this._retryMs): void {
    this._active.delete(chunk.start);
    if (done) {
      this._done.add(chunk.start);
      this._retryAt.delete(chunk.start);
    } else this._retryAt.set(chunk.start, at + retryMs);
    for (const listener of [...this._listeners]) listener.onChunk(chunk.start, done, chunk.toTs);
    this._pump();
  }

  accept(requestId: number, page: DecodedHistoryPage | null): void {
    const owner = this._shared.owners.get(requestId);
    if (owner !== undefined && owner !== this) {
      owner.accept(requestId, page);
      return;
    }
    const chunk = this._byRequest.get(requestId);
    if (chunk === undefined) return;
    this._byRequest.delete(requestId);
    this._shared.owners.delete(requestId);
    this._pool.free();
    chunk.requestId = null;
    const at = this._now();
    if (page === null || !page.available || page.levelMs !== STREAM_LEVEL_MS || page.rowFactor !== STREAM_ROW_FACTOR) {
      this._unavailable = page !== null && !page.available ? page.reason : "MALFORMED_PAGE";
      this._finish(chunk, false, at, this._unavailable === "RATE_LIMITED" ? STREAM_RATE_LIMIT_RETRY_MS : this._retryMs);
      return;
    }
    this._unavailable = null;
    const windows = page.windows.filter((window) => window.ts >= chunk.cursor && window.ts < chunk.toTs);
    if (windows.length > 0) for (const listener of [...this._listeners]) listener.onPage({ chunkStart: chunk.start, rowWidth: page.rowWidth, windows });
    const next = page.next;
    if (next !== null && next < chunk.toTs && next > chunk.cursor) {
      chunk.cursor = next;
      if (this._canSend(at)) this._send(chunk, at);
      else this._scheduleWake(this._waitMs(at));
      return;
    }
    if (next !== null && next <= chunk.cursor) {
      this._finish(chunk, false, at);
      return;
    }
    const covered = page.windows.length > 0 ? page.windows[page.windows.length - 1].ts + HISTORY_WINDOW_MS : chunk.cursor;
    const beforeTheHost = page.span?.oldest != null && chunk.toTs <= page.span.oldest;
    this._finish(chunk, next === null && (beforeTheHost || covered >= chunk.toTs || page.span?.newest === null || (page.span?.newest ?? 0) + HISTORY_WINDOW_MS <= chunk.toTs), at);
  }

  fail(requestId: number, retryAfterMs?: number): void {
    const owner = this._shared.owners.get(requestId);
    if (owner !== undefined && owner !== this) {
      owner.fail(requestId, retryAfterMs);
      return;
    }
    const chunk = this._byRequest.get(requestId);
    if (chunk === undefined) return;
    this._byRequest.delete(requestId);
    this._shared.owners.delete(requestId);
    this._pool.free();
    chunk.requestId = null;
    this._finish(chunk, false, this._now(), retryDelayMs(retryAfterMs, this._retryMs));
  }
}
