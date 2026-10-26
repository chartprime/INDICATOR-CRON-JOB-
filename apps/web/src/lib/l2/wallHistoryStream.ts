import type { HistoryIdentity } from "../indicators/passive-liquidity/heatmapHistory";
import { retryDelayMs } from "../indicators/passive-liquidity/requestBudget";
import type { HostWallPage, WallFilter, WallSizeBands } from "./hostWalls";
import type { L2Wall } from "./types";

export const WALL_STREAM_CHUNK_MS = 6 * 3_600_000;
export const WALL_STREAM_MAX_IN_FLIGHT = 2;
export const WALL_STREAM_MAX_REQUESTS_PER_MINUTE = 60;
export const WALL_STREAM_RETRY_MS = 30_000;
export const WALL_STREAM_PAGE_LIMIT = 400;
export const WALL_STREAM_ID_BASE = 2 ** 31 + 2 ** 30;
export const WALL_STREAM_ID_SPAN = 2 ** 30;
export const WALL_FILTER_REFUSALS_BEFORE_DROP = 2;
export const WHALE_WALL_STREAM_ID_BASE = 2 ** 32 + 2 ** 30;
export const WHALE_WALL_CHUNK_MS = 12 * 3_600_000;

export interface WallHistoryRequest {
  requestId: number;
  identity: HistoryIdentity;
  fromTs: number;
  toTs: number;
  limit: number;
  after: { endTs: number; id: number } | null;
  filter: WallFilter | null;
}

export interface WallStreamListener {
  onWalls(walls: readonly L2Wall[], rowWidth: number): void;
  onChunk(chunkStart: number, done: boolean): void;
  onBands?(bands: WallSizeBands, rowWidth: number): void;
}

export interface WallStreamStatus {
  oldestDone: number | null;
  inFlight: number;
  unavailable: string | null;
}

interface Chunk {
  start: number;
  fromTs: number;
  toTs: number;
  after: { endTs: number; id: number } | null;
  requestId: number | null;
}

function identityKeyOf(identity: HistoryIdentity | null): string {
  return identity === null ? "" : `${identity.provider}:${identity.marketKind}:${identity.symbol}`;
}

function filterKeyOf(filter: WallFilter | null): string {
  return filter === null ? "" : `${filter.minUsd}:${[...filter.alwaysOutcomes].sort().join(",")}`;
}

export class WallHistoryStream {
  private readonly _request: (request: WallHistoryRequest) => void;
  private readonly _now: () => number;
  private readonly _maxInFlight: number;
  private readonly _maxPerMinute: number;
  private readonly _retryMs: number;
  private readonly _chunkMs: number;
  private readonly _idBase: number;
  private _filter: WallFilter | null;
  private _filterKey: string;
  private _filterConfirmed = false;
  private _filterRefusals = 0;
  private _filterDropped = false;
  private _identity: HistoryIdentity | null = null;
  private _identityKey = "";
  private _done = new Set<number>();
  private _retryAt = new Map<number, number>();
  private _active = new Map<number, Chunk>();
  private _byRequest = new Map<number, Chunk>();
  private _wanted: { fromTs: number; toTs: number } | null = null;
  private _requestTimes: number[] = [];
  private _nextId: number;
  private _unavailable: string | null = null;
  private _wake: ReturnType<typeof setTimeout> | null = null;
  private _listeners = new Set<WallStreamListener>();

  constructor({
    request,
    now = () => Date.now(),
    maxInFlight = WALL_STREAM_MAX_IN_FLIGHT,
    maxPerMinute = WALL_STREAM_MAX_REQUESTS_PER_MINUTE,
    retryMs = WALL_STREAM_RETRY_MS,
    chunkMs = WALL_STREAM_CHUNK_MS,
    idBase = WALL_STREAM_ID_BASE,
    filter = null,
  }: {
    request: (request: WallHistoryRequest) => void;
    now?: () => number;
    maxInFlight?: number;
    maxPerMinute?: number;
    retryMs?: number;
    chunkMs?: number;
    idBase?: number;
    filter?: WallFilter | null;
  }) {
    this._request = request;
    this._now = now;
    this._maxInFlight = maxInFlight;
    this._maxPerMinute = maxPerMinute;
    this._retryMs = retryMs;
    this._chunkMs = chunkMs;
    this._idBase = idBase;
    this._nextId = idBase;
    this._filter = filter;
    this._filterKey = filterKeyOf(filter);
  }

  private _chunkStartOf(ts: number): number {
    return Math.floor(ts / this._chunkMs) * this._chunkMs;
  }

  subscribe(listener: WallStreamListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  owns(requestId: number): boolean {
    return requestId >= this._idBase && requestId < this._idBase + WALL_STREAM_ID_SPAN;
  }

  get filter(): WallFilter | null {
    return this._filter;
  }

  get filterDropped(): boolean {
    return this._filterDropped;
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

  status(): WallStreamStatus {
    let oldestDone: number | null = null;
    for (const start of this._done) if (oldestDone === null || start < oldestDone) oldestDone = start;
    return { oldestDone, inFlight: this._active.size, unavailable: this._unavailable };
  }

  setIdentity(identity: HistoryIdentity | null): void {
    const key = identityKeyOf(identity);
    if (key === this._identityKey) return;
    this._identity = identity === null ? null : { ...identity };
    this._identityKey = key;
    this._filterRefusals = 0;
    this._reset();
    this._wanted = null;
  }

  setFilter(filter: WallFilter | null): void {
    const key = filterKeyOf(filter);
    if (key === this._filterKey && !this._filterDropped) return;
    const wanted = this._wanted;
    this._filter = filter;
    this._filterKey = key;
    this._filterConfirmed = false;
    this._filterRefusals = 0;
    this._filterDropped = false;
    this._reset();
    this._wanted = wanted;
    this._pump();
  }

  invalidateSince(ts: number): void {
    let changed = false;
    for (const start of [...this._done]) {
      if (start + this._chunkMs > ts) {
        this._done.delete(start);
        changed = true;
      }
    }
    if (changed) this._pump();
  }

  stop(): void {
    this._wanted = null;
    this._clearWake();
  }

  private _reset(): void {
    this._done.clear();
    this._retryAt.clear();
    this._active.clear();
    this._byRequest.clear();
    this._unavailable = null;
    this._clearWake();
  }

  private _dropFilter(): void {
    const wanted = this._wanted;
    this._filter = null;
    this._filterKey = "";
    this._filterDropped = true;
    this._reset();
    this._wanted = wanted;
    this._pump();
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

  private _budgetLeft(at: number): boolean {
    this._requestTimes = this._requestTimes.filter((t) => at - t < 60_000);
    return this._active.size < this._maxInFlight && this._requestTimes.length < this._maxPerMinute;
  }

  want(fromTs: number, toTs: number): void {
    if (this._identity === null || !(toTs > fromTs)) return;
    this._wanted = { fromTs, toTs };
    this._pump();
  }

  private _pump(): void {
    const wanted = this._wanted;
    if (wanted === null || this._identity === null) return;
    const at = this._now();
    const first = this._chunkStartOf(wanted.fromTs);
    const last = this._chunkStartOf(wanted.toTs - 1);
    let nextRetry = Infinity;
    for (let start = last; start >= first; start -= this._chunkMs) {
      if (this._done.has(start) || this._active.has(start)) continue;
      const retryAt = this._retryAt.get(start);
      if (retryAt !== undefined && at < retryAt) {
        nextRetry = Math.min(nextRetry, retryAt);
        continue;
      }
      if (!this._budgetLeft(at)) {
        this._scheduleWake(this._requestTimes.length >= this._maxPerMinute ? this._requestTimes[0] + 60_000 - at : 1_000);
        return;
      }
      const chunk: Chunk = { start, fromTs: Math.max(0, start, wanted.fromTs), toTs: Math.min(start + this._chunkMs, wanted.toTs), after: null, requestId: null };
      this._active.set(start, chunk);
      this._send(chunk, at);
    }
    if (Number.isFinite(nextRetry)) this._scheduleWake(nextRetry - at);
  }

  private _send(chunk: Chunk, at: number): void {
    if (this._identity === null) return;
    const request: WallHistoryRequest = { requestId: this._nextId, identity: this._identity, fromTs: chunk.fromTs, toTs: chunk.toTs, limit: WALL_STREAM_PAGE_LIMIT, after: chunk.after, filter: this._filter };
    this._nextId += 1;
    chunk.requestId = request.requestId;
    this._byRequest.set(request.requestId, chunk);
    this._requestTimes.push(at);
    this._request(request);
  }

  private _finish(chunk: Chunk, done: boolean, at: number, retryMs: number = this._retryMs): void {
    this._active.delete(chunk.start);
    if (done) {
      this._done.add(chunk.start);
      this._retryAt.delete(chunk.start);
    } else this._retryAt.set(chunk.start, at + retryMs);
    for (const listener of [...this._listeners]) listener.onChunk(chunk.start, done);
    this._pump();
  }

  accept(requestId: number, page: HostWallPage | null): void {
    const chunk = this._byRequest.get(requestId);
    if (chunk === undefined) return;
    this._byRequest.delete(requestId);
    chunk.requestId = null;
    const at = this._now();
    if (page === null || !page.available) {
      this._unavailable = page !== null && !page.available ? page.reason : "MALFORMED_PAGE";
      if (this._filter !== null && !this._filterConfirmed && page !== null && !page.available && page.reason === "STORAGE_UNAVAILABLE") {
        this._filterRefusals += 1;
        if (this._filterRefusals >= WALL_FILTER_REFUSALS_BEFORE_DROP) {
          this._dropFilter();
          return;
        }
      }
      this._finish(chunk, false, at);
      return;
    }
    if (this._filter !== null && page.filter !== undefined) this._filterConfirmed = true;
    this._unavailable = null;
    if (page.sizeBands !== undefined) for (const listener of [...this._listeners]) listener.onBands?.(page.sizeBands, page.rowWidth);
    if (page.walls.length > 0) for (const listener of [...this._listeners]) listener.onWalls(page.walls, page.rowWidth);
    const next = page.next;
    if (next !== null && (chunk.after === null || next.endTs > chunk.after.endTs || (next.endTs === chunk.after.endTs && next.id > chunk.after.id))) {
      chunk.after = next;
      if (this._budgetLeft(at)) this._send(chunk, at);
      else {
        this._active.delete(chunk.start);
        this._retryAt.set(chunk.start, at);
        this._scheduleWake(1_000);
      }
      return;
    }
    this._finish(chunk, next === null, at);
  }

  fail(requestId: number, retryAfterMs?: number): void {
    const chunk = this._byRequest.get(requestId);
    if (chunk === undefined) return;
    this._byRequest.delete(requestId);
    chunk.requestId = null;
    this._finish(chunk, false, this._now(), retryDelayMs(retryAfterMs, this._retryMs));
  }
}
