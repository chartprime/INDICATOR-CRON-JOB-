import { STREAM_CHUNK_MS, type ColumnHistoryStream, type StreamPage } from "../passive-liquidity/columnHistoryStream";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import type { HostColumn } from "./liveRangeReader";

export type { HostColumn } from "./liveRangeReader";

export const HISTORY_RETRY_MS = 5_000;
export const STALE_CHUNK_MS = 60_000;
export const KEEP_PAD_MIN_MS = STREAM_CHUNK_MS;

const NO_TRADES: HostColumn["buy"] = Object.freeze([]);
const NO_PRINTS: HostColumn["prints"] = Object.freeze([]);

export function forkForLiveRange(stream: ColumnHistoryStream): ColumnHistoryStream {
  return stream.fork({ retryMs: HISTORY_RETRY_MS });
}

function chunkStartOf(ts: number): number {
  return Math.floor(ts / STREAM_CHUNK_MS) * STREAM_CHUNK_MS;
}

function identityKeyOf(stream: ColumnHistoryStream): string {
  const identity = stream.identity;
  return identity === null ? "" : `${identity.provider}:${identity.marketKind}:${identity.symbol}`;
}

export function hostColumnOf(column: LiquidityColumn, rowWidth: number): HostColumn {
  return {
    ts: column.ts,
    rowWidth,
    buy: column.buy ?? NO_TRADES,
    sell: column.sell ?? NO_TRADES,
    prints: column.prints ?? NO_PRINTS,
    printsFloor: typeof column.printsFloor === "number" && Number.isFinite(column.printsFloor) ? column.printsFloor : null,
  };
}

function firstAtOrAfter(columns: readonly HostColumn[], ts: number): number {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class LiveRangeHistory {
  private readonly _stream: ColumnHistoryStream;
  private readonly _onChange: () => void;
  private readonly _unsubscribe: () => void;
  private _identity: string | null = null;
  private _chunks = new Map<number, HostColumn[]>();
  private _doneTo = new Map<number, number>();
  private _merged: readonly HostColumn[] | null = null;
  private _inPage = false;
  private _disposed = false;

  constructor(stream: ColumnHistoryStream, onChange: () => void) {
    this._stream = stream;
    this._onChange = onChange;
    this._unsubscribe = stream.subscribe({ onPage: (page) => this._onPage(page), onChunk: (start, done, toTs) => this._onChunk(start, done, toTs) });
  }

  want(fromTs: number, beforeTs: number, oldestFirst = false): void {
    if (this._disposed || this._inPage) return;
    const identity = identityKeyOf(this._stream);
    if (identity !== this._identity) {
      this._identity = identity;
      this._clear();
      this._stream.reset();
    }
    if (!(beforeTs > fromTs)) return;
    let stale = false;
    for (const [start, heldTo] of this._doneTo) {
      if (start + STREAM_CHUNK_MS <= fromTs || start >= beforeTs) continue;
      if (Math.min(start + STREAM_CHUNK_MS, beforeTs) - heldTo > STALE_CHUNK_MS) {
        this._doneTo.delete(start);
        stale = true;
      }
    }
    if (stale) this._stream.reset(this._doneTo.keys());
    this._stream.want(fromTs, beforeTs, 0, 0, oldestFirst);
  }

  keep(fromTs: number, beforeTs: number): void {
    if (this._inPage) return;
    const pad = Math.max(KEEP_PAD_MIN_MS, beforeTs - fromTs);
    const lo = fromTs - pad;
    const hi = beforeTs + pad;
    let dropped = false;
    for (const start of new Set([...this._chunks.keys(), ...this._doneTo.keys()])) {
      if (start + STREAM_CHUNK_MS > lo && start < hi) continue;
      this._chunks.delete(start);
      this._doneTo.delete(start);
      dropped = true;
    }
    if (!dropped) return;
    this._merged = null;
    this._stream.reset(this._doneTo.keys());
  }

  columns(fromTs: number, beforeTs: number): readonly HostColumn[] {
    if (this._merged === null) {
      const merged: HostColumn[] = [];
      for (const start of [...this._chunks.keys()].sort((a, b) => a - b)) {
        for (const column of this._chunks.get(start) ?? []) {
          if (merged.length === 0 || column.ts > merged[merged.length - 1].ts) merged.push(column);
        }
      }
      this._merged = merged;
    }
    return this._merged.slice(firstAtOrAfter(this._merged, fromTs), firstAtOrAfter(this._merged, beforeTs));
  }

  covered(fromTs: number, beforeTs: number): boolean {
    if (!(beforeTs > fromTs)) return true;
    for (let start = chunkStartOf(fromTs); start < beforeTs; start += STREAM_CHUNK_MS) if (!this._doneTo.has(start)) return false;
    return true;
  }

  dispose(): void {
    this._disposed = true;
    this._unsubscribe();
    this._clear();
  }

  private _clear(): void {
    this._chunks.clear();
    this._doneTo.clear();
    this._merged = null;
  }

  private _onPage(page: StreamPage): void {
    let list = this._chunks.get(page.chunkStart);
    if (list === undefined) {
      list = [];
      this._chunks.set(page.chunkStart, list);
    }
    let last = list.length > 0 ? list[list.length - 1].ts : Number.NEGATIVE_INFINITY;
    let added = 0;
    for (const window of page.windows) {
      for (const column of window.columns) {
        if (column.ts <= last) continue;
        last = column.ts;
        list.push(hostColumnOf(column, page.rowWidth));
        added += 1;
      }
    }
    if (added === 0) return;
    this._merged = null;
    this._notify();
  }

  private _onChunk(start: number, done: boolean, toTs: number): void {
    if (!done) return;
    this._doneTo.set(start, toTs);
    this._notify();
  }

  private _notify(): void {
    this._inPage = true;
    try {
      this._onChange();
    } finally {
      this._inPage = false;
    }
  }
}
