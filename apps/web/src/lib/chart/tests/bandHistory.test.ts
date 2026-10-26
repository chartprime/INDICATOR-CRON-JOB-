import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BandHistoryFrame } from "../../../types/frames";
import { BAND_COLUMN_MS, BAND_GIVE_UP_MS, BAND_MAX_CELLS, BAND_MAX_ROWS, BAND_PENDING_MS, BAND_PIECE_MAX_MS, BAND_RETRY_MS, BandHistoryStore, MAX_BAND_ENTRIES, bandColumnMsFor, bandKeyOf } from "../bandHistory";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

function want(over: Partial<{ fromTs: number; toTs: number; priceLo: number; priceHi: number; columnMs: number }> = {}) {
  const fromTs = over.fromTs ?? T;
  const toTs = over.toTs ?? T + HOUR;
  const priceLo = over.priceLo ?? 80_000;
  const priceHi = over.priceHi ?? 80_008;
  return { key: bandKeyOf(fromTs, toTs, priceLo, priceHi), fromTs, toTs, priceLo, priceHi, columnMs: over.columnMs ?? BAND_COLUMN_MS };
}

function reply(request: { request_id: number; from_ts: number; to_ts: number; price_lo: number; price_hi: number; column_ms: number }, columns: BandHistoryFrame["columns"], over: Partial<Omit<BandHistoryFrame, "provider" | "marketKind" | "assetClass">> = {}): BandHistoryFrame {
  return {
    type: "band_history", symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const,
    request_id: request.request_id, from_ts: request.from_ts, to_ts: request.to_ts, price_lo: request.price_lo, price_hi: request.price_hi, column_ms: request.column_ms,
    row_width: 4, row_lo: 20_000, row_hi: 20_002, complete: true, reason: null, retry_after_ms: null, columns, ...over,
  };
}

const column = (ts: number, bid = [1, 2, 3], sell = [0, 0.5, 0]) => ({ ts, bid, ask: [0, 0, 0], buy: [0, 0, 0], sell });

describe("bandHistory store", () => {
  it("bisects only read deadlines, preserves coverage and boundary flow, and bounds the minimum piece", () => {
    const now = T + 10 * HOUR;
    const w = want({ fromTs: T, toTs: T + HOUR });
    const store = new BandHistoryStore();
    store.want(w);
    const initial = store.nextRequest(now)!;
    store.put(reply(initial, [], { complete: false, reason: "READ_TIMEOUT" }), now);
    expect(store.nextRequest(now + 999)).toBeNull();
    const newer = store.nextRequest(now + 1_000)!;
    expect(newer.to_ts).toBe(w.toTs);
    expect(newer.from_ts % BAND_COLUMN_MS).toBe(0);
    store.put(reply(newer, [column(newer.from_ts, [9, 9, 9]), column(newer.from_ts + BAND_COLUMN_MS)]), now + 1_000);
    const older = store.nextRequest(now + 1_000)!;
    expect(older.from_ts).toBe(w.fromTs);
    expect(older.to_ts).toBe(newer.from_ts + BAND_COLUMN_MS);
    store.put(reply(older, [column(newer.from_ts, [1, 2, 3], [0, 7, 0])]), now + 1_000);
    const seam = store.get(w.key)!.columns.find((entry) => entry.ts === newer.from_ts)!;
    expect(Array.from(seam.bid)).toEqual([1, 2, 3]);
    expect(seam.sell).toEqual([[20_001, 7]]);
    expect(store.get(w.key)!.complete).toBe(true);
    const small = new BandHistoryStore();
    small.want(want({ toTs: T + 60_000 }));
    const request = small.nextRequest(now)!;
    small.put(reply(request, [], { complete: false, reason: "READ_TIMEOUT" }), now);
    expect(small.size).toBe(1);
    expect(small.get(want({ toTs: T + 60_000 }).key)!.pieces).toHaveLength(1);
    expect(small.nextRequest(now + 1_000)).toBeNull();
  });
  it("pins its piece to the runtime's window cap and its cells and rows to the route's", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const bandHistory = require(path.join(here, "../../../../../runtime/src/server/band-history.js"));
    expect(BAND_PIECE_MAX_MS).toBe(bandHistory.MAX_BAND_WINDOW_MS);
    expect(BAND_MAX_CELLS).toBe(bandHistory.MAX_BAND_CELLS);
    expect(BAND_MAX_ROWS).toBe(bandHistory.MAX_BAND_ROWS);
  });

  it("widens the column so a piece never exceeds the cell cap", () => {
    expect(bandColumnMsFor(10)).toBe(BAND_COLUMN_MS);
    expect(bandColumnMsFor(200)).toBe(15_000);
    expect(bandColumnMsFor(256, HOUR)).toBe(10_000);
    expect(256 * Math.ceil(BAND_PIECE_MAX_MS / bandColumnMsFor(256))).toBeLessThanOrEqual(BAND_MAX_CELLS);
  });

  it("asks a long want one piece at a time, the newest first, one in flight, and assembles dense columns with holes as zeros once every piece is in", () => {
    const store = new BandHistoryStore();
    const w = want({ fromTs: T, toTs: T + 5 * HOUR });
    store.want(w);
    const first = store.nextRequest(T + 10 * HOUR)!;
    expect(first).toMatchObject({ from_ts: T + 3 * HOUR, to_ts: T + 5 * HOUR, price_lo: 80_000, price_hi: 80_008, column_ms: BAND_COLUMN_MS });
    expect(store.nextRequest(T + 10 * HOUR)).toBeNull();
    expect(store.put(reply(first, [column(T + 4 * HOUR)]), T + 10 * HOUR)).toBe(true);
    const second = store.nextRequest(T + 10 * HOUR)!;
    expect(second).toMatchObject({ from_ts: T + HOUR + BAND_COLUMN_MS, to_ts: T + 3 * HOUR + BAND_COLUMN_MS });
    store.put(reply(second, []), T + 10 * HOUR);
    const third = store.nextRequest(T + 10 * HOUR)!;
    expect(third).toMatchObject({ from_ts: T, to_ts: T + HOUR + 2 * BAND_COLUMN_MS });
    expect(store.get(w.key)!.complete).toBe(false);
    expect(store.feedFor(w.key)).toBeNull();
    store.put(reply(third, [column(T + 10_000), column(T + 20_000)]), T + 10 * HOUR);
    const entry = store.get(w.key)!;
    expect(entry.complete).toBe(true);
    expect(entry.columns).toHaveLength(5 * HOUR / BAND_COLUMN_MS + 1);
    expect(entry.columns[0]).toMatchObject({ ts: T, lo: 20_000, hi: 20_002 });
    expect(Array.from(entry.columns[1].bid)).toEqual([1, 2, 3]);
    expect(entry.columns[1].sell).toEqual([[20_001, 0.5]]);
    expect(Array.from(entry.columns[3].bid)).toEqual([0, 0, 0]);
    expect(entry.columns[3].buy).toEqual([]);
    expect(entry.gaps).toEqual([{ from: T - BAND_COLUMN_MS, to: T }, { from: T + 20_000, to: T + 4 * HOUR - BAND_COLUMN_MS }, { from: T + 4 * HOUR, to: T + 5 * HOUR }]);
    expect(entry.pieces.every((piece) => piece.columns === null)).toBe(true);
    const feed = store.feedFor(w.key)!;
    expect(feed.rowWidth).toBe(4);
    expect(feed.feed.deep).toBeNull();
    expect(feed.feed.fine.columnMs).toBe(BAND_COLUMN_MS);
    expect(feed.feed.fine.columns).toBe(entry.columns);
    expect(store.nextRequest(T + 10 * HOUR)).toBeNull();
  });

  it("a failed piece waits with backoff, a server retry hint is honoured, three failures give up for ten minutes, and a later success clears it", () => {
    const store = new BandHistoryStore();
    const w = want();
    store.want(w);
    const now = T + 10 * HOUR;
    const first = store.nextRequest(now)!;
    store.put(reply(first, [], { complete: false, reason: "STORAGE_UNAVAILABLE" }), now);
    expect(store.get(w.key)).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", attempts: 1, retryAt: now + BAND_RETRY_MS });
    expect(store.nextRequest(now + 1_000)).toBeNull();
    const second = store.nextRequest(now + BAND_RETRY_MS)!;
    store.put(reply(second, [], { complete: false, reason: "OVERLOADED", retry_after_ms: 5_000 }), now + BAND_RETRY_MS);
    expect(store.get(w.key)!.retryAt).toBe(now + BAND_RETRY_MS + 5_000);
    const third = store.nextRequest(now + BAND_RETRY_MS + 5_000)!;
    store.put(reply(third, [], { complete: false, reason: "READ_FAILED" }), now + BAND_RETRY_MS + 5_000);
    expect(store.get(w.key)!.retryAt).toBe(now + BAND_RETRY_MS + 5_000 + BAND_GIVE_UP_MS);
    const fourth = store.nextRequest(now + BAND_RETRY_MS + 5_000 + BAND_GIVE_UP_MS)!;
    store.put(reply(fourth, [column(T + 10_000)]), now + HOUR);
    expect(store.get(w.key)).toMatchObject({ complete: true, reason: null, attempts: 0 });
  });

  it("ignores a reply it did not ask for or that does not match the piece, keeps entries bounded, prunes what is no longer wanted, and bumps its version when a want is forgotten", () => {
    const store = new BandHistoryStore();
    const w = want();
    store.want(w);
    const v0 = store.version;
    const now = T + 10 * HOUR;
    const request = store.nextRequest(now)!;
    expect(store.put(reply({ ...request, request_id: 99 }, []), now)).toBe(false);
    expect(store.put(reply({ ...request, from_ts: request.from_ts + 1 }, []), now)).toBe(false);
    expect(store.put(reply(request, [], { price_lo: request.price_lo + 1 }), now)).toBe(false);
    expect(store.put(reply(request, [column(request.to_ts + BAND_COLUMN_MS)]), now)).toBe(false);
    expect(store.pending).toBe(1);
    expect(store.put(reply(request, [column(T + 10_000)]), now)).toBe(true);
    expect(store.pending).toBe(0);
    store.keepOnly(new Set());
    expect(store.get(w.key)).toBeNull();
    expect(store.pending).toBe(0);
    expect(store.version).toBeGreaterThan(v0);
    for (let i = 0; i < MAX_BAND_ENTRIES + 5; i += 1) store.want(want({ priceLo: 70_000 + i, priceHi: 70_001 + i }));
    expect(store.size).toBe(MAX_BAND_ENTRIES);
    expect(store.get(bandKeyOf(T, T + HOUR, 70_000, 70_001))).toBeNull();
    expect(store.get(bandKeyOf(T, T + HOUR, 70_000 + MAX_BAND_ENTRIES + 4, 70_001 + MAX_BAND_ENTRIES + 4))).not.toBeNull();
  });

  it("rejects a later piece with different row geometry instead of combining incomparable price rows", () => {
    const store = new BandHistoryStore();
    const w = want({ toTs: T + 3 * HOUR });
    store.want(w);
    const now = T + 10 * HOUR;
    const first = store.nextRequest(now)!;
    expect(store.put(reply(first, []), now)).toBe(true);
    const second = store.nextRequest(now)!;
    expect(store.put(reply(second, [], { row_lo: 20_001, row_hi: 20_003 }), now)).toBe(false);
    expect(store.pending).toBe(1);
    expect(store.put(reply(second, []), now)).toBe(true);
  });

  it("restarts a reused band key when its column geometry changes", () => {
    const store = new BandHistoryStore();
    const original = want();
    store.want(original);
    const request = store.nextRequest(T + 2 * HOUR)!;
    const changed = { ...original, columnMs: 20_000 };
    const replacement = store.want(changed);
    expect(replacement.want.columnMs).toBe(20_000);
    expect(store.put(reply(request, [column(T + 10_000)]), T + 2 * HOUR)).toBe(false);
    expect(store.nextRequest(T + 2 * HOUR)).toMatchObject({ column_ms: 20_000 });
  });

  it("a request left unanswered expires after BAND_PENDING_MS as a failed attempt, so the next ask goes out; the wait outlasts the runtime's own wait for the host", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const reader = require(path.join(here, "../../../../../runtime/src/storage/remote-storage-reader.js"));
    const handler = require(path.join(here, "../../../../../runtime/src/server/band-history-handler.js"));
    expect(BAND_PENDING_MS).toBeGreaterThanOrEqual(reader.TIMEOUT_MS_BY_ROUTE["band-history"] + handler.DEFAULT_MAX_QUEUE_WAIT_MS);
    const store = new BandHistoryStore();
    const a = want();
    const b = want({ priceLo: 70_000, priceHi: 70_004 });
    store.want(a);
    store.want(b);
    const now = T + 10 * HOUR;
    const first = store.nextRequest(now)!;
    expect(store.nextRequest(now + BAND_PENDING_MS - 1)).toBeNull();
    const second = store.nextRequest(now + BAND_PENDING_MS)!;
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.price_lo).toBe(70_000);
    expect(store.get(a.key)).toMatchObject({ attempts: 1, reason: "NO_REPLY", retryAt: now + BAND_PENDING_MS + BAND_RETRY_MS });
    expect(store.put(reply(first, [column(T + 10_000)]), now + BAND_PENDING_MS)).toBe(false);
    expect(store.pending).toBe(1);
  });

  it("asks a piece only up to now, lays the reply in up to there, and does not ask for a piece still wholly ahead", () => {
    const store = new BandHistoryStore();
    const w = want({ fromTs: T, toTs: T + 3 * HOUR });
    store.want(w);
    const now = T + 2 * HOUR + 30_000;
    const first = store.nextRequest(now)!;
    expect(first).toMatchObject({ from_ts: T + HOUR, to_ts: now });
    expect(store.put(reply(first, [column(T + HOUR + 10_000)]), now)).toBe(true);
    const second = store.nextRequest(now)!;
    expect(second).toMatchObject({ from_ts: T, to_ts: T + HOUR + BAND_COLUMN_MS });
    store.put(reply(second, []), now);
    const entry = store.get(w.key)!;
    expect(entry.complete).toBe(true);
    expect(entry.columns.at(-1)!.ts).toBe(now);
    expect(entry.gaps.at(-1)).toEqual({ from: T + HOUR + 10_000, to: now });
    const ahead = want({ fromTs: T + 5 * HOUR, toTs: T + 6 * HOUR });
    store.want(ahead);
    expect(store.nextRequest(now)).toBeNull();
    expect(store.nextRequest(T + 5 * HOUR + 60_000)).toMatchObject({ from_ts: T + 5 * HOUR, to_ts: T + 5 * HOUR + 60_000 });
  });

  it("the version moves when a want completes or is forgotten, not on every piece or refusal; dropping what is in flight lets a reconnect ask again", () => {
    const store = new BandHistoryStore();
    const w = want({ fromTs: T, toTs: T + 3 * HOUR });
    store.want(w);
    const v0 = store.version;
    const now = T + 10 * HOUR;
    const first = store.nextRequest(now)!;
    store.put(reply(first, [], { complete: false, reason: "OVERLOADED" }), now);
    expect(store.version).toBe(v0);
    const again = store.nextRequest(now + BAND_RETRY_MS)!;
    store.put(reply(again, []), now + BAND_RETRY_MS);
    expect(store.version).toBe(v0);
    const second = store.nextRequest(now + BAND_RETRY_MS)!;
    store.dropPending();
    expect(store.pending).toBe(0);
    expect(store.put(reply(second, []), now + BAND_RETRY_MS)).toBe(false);
    const third = store.nextRequest(now + BAND_RETRY_MS)!;
    expect(third).toMatchObject({ from_ts: T, to_ts: T + HOUR + BAND_COLUMN_MS });
    store.put(reply(third, []), now + BAND_RETRY_MS);
    expect(store.version).toBe(v0 + 1);
    store.forget(w.key);
    expect(store.version).toBe(v0 + 2);
  });

  it("a band the server will never serve waits the long wait before it is asked again", () => {
    const store = new BandHistoryStore();
    const w = want();
    store.want(w);
    const now = T + 10 * HOUR;
    const first = store.nextRequest(now)!;
    store.put(reply(first, [], { complete: false, reason: "BAND_TOO_WIDE", row_width: null, row_lo: null, row_hi: null }), now);
    expect(store.get(w.key)!.retryAt).toBe(now + BAND_GIVE_UP_MS);
  });
});
