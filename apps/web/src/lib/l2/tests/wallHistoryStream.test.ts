import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_ID_BASE, STREAM_ID_SPAN, ColumnHistoryStream } from "../../indicators/passive-liquidity/columnHistoryStream";
import type { HostWallPage } from "../hostWalls";
import { BAND_COLUMN_ID_BASE, BAND_COLUMN_ID_SPAN } from "../../chart/bandHistory";
import { WALL_STREAM_CHUNK_MS, WALL_STREAM_ID_BASE, WALL_STREAM_ID_SPAN, WALL_STREAM_PAGE_LIMIT, WHALE_WALL_CHUNK_MS, WHALE_WALL_STREAM_ID_BASE, WallHistoryStream, type WallHistoryRequest } from "../wallHistoryStream";
import type { L2Wall } from "../types";

const H = WALL_STREAM_CHUNK_MS;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H);
const ID = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTCUSDT" };

const wall = (id: number, endTs: number): L2Wall => ({ id: -(2 ** 40 + id), lane: 0, side: "bid", row: 10, span: 1, startTs: endTs - 5_000, endTs, size: 0, peak: 50, endedBy: "hit", ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null });
const pageOf = (walls: L2Wall[], next: { endTs: number; id: number } | null = null): Extract<HostWallPage, { available: true }> => ({ available: true, generation: "g", rowWidth: 4, walls, next });

const FILTER = { minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] } as const;

function harness(options: { maxPerMinute?: number; retryMs?: number; chunkMs?: number; idBase?: number; filter?: { minUsd: number; alwaysOutcomes: readonly ("filled" | "partial" | "hit" | "pulled" | "moved")[] } | null } = {}) {
  let now = T0 + 10 * H;
  const sent: WallHistoryRequest[] = [];
  const got: [number, number][] = [];
  const chunks: [number, boolean][] = [];
  const stream = new WallHistoryStream({ request: (request) => sent.push(request), now: () => now, ...options });
  stream.subscribe({ onWalls: (walls, rowWidth) => { for (const w of walls) got.push([w.id, rowWidth]); }, onChunk: (start, done) => chunks.push([start, done]) });
  stream.setIdentity(ID);
  return { stream, sent, got, chunks, tick: (ms: number) => { now += ms; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wall history stream: six-hour chunks of the host's walls, newest first, paged by cursor", () => {
  it("asks for the newest chunk first, two in flight, clipped to what was wanted, with the page limit, and carries on as chunks land", () => {
    const { stream, sent, chunks } = harness();
    stream.want(T0 + 1_000, T0 + 4 * H - 1_000);
    expect(sent.map((r) => [r.fromTs - T0, r.toTs - T0, r.limit, r.after])).toEqual([[3 * H, 4 * H - 1_000, WALL_STREAM_PAGE_LIMIT, null], [2 * H, 3 * H, WALL_STREAM_PAGE_LIMIT, null]]);
    expect(sent.every((r) => stream.owns(r.requestId) && r.requestId >= WALL_STREAM_ID_BASE)).toBe(true);
    expect(stream.owns(STREAM_ID_BASE)).toBe(false);
    expect(new ColumnHistoryStream({ request: () => undefined }).owns(sent[0].requestId)).toBe(false);
    stream.accept(sent[0].requestId, pageOf([]));
    stream.accept(sent[1].requestId, pageOf([]));
    expect(chunks.map(([start, done]) => [(start - T0) / H, done])).toEqual([[3, true], [2, true]]);
    expect(sent).toHaveLength(4);
    expect([sent[3].fromTs - T0, sent[3].toTs - T0]).toEqual([1_000, H]);
    stream.accept(sent[2].requestId, pageOf([]));
    stream.accept(sent[3].requestId, pageOf([]));
    expect(stream.status()).toEqual({ oldestDone: T0, inFlight: 0, unavailable: null });
    stream.want(T0 + 1_000, T0 + 4 * H - 1_000);
    expect(sent).toHaveLength(4);
  });

  it("follows a chunk's cursor page by page inside the chunk, hands each page's walls on, and refuses a cursor that does not move", () => {
    const { stream, sent, got, chunks } = harness();
    stream.want(T0 + 3 * H, T0 + 4 * H);
    const first = sent[0];
    stream.accept(first.requestId, pageOf([wall(1, T0 + 3 * H + 10_000), wall(2, T0 + 3 * H + 20_000)], { endTs: T0 + 3 * H + 20_000, id: 2 }));
    expect(got).toEqual([[-(2 ** 40 + 1), 4], [-(2 ** 40 + 2), 4]]);
    expect(chunks).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ fromTs: first.fromTs, toTs: first.toTs, after: { endTs: T0 + 3 * H + 20_000, id: 2 } });
    stream.accept(sent[1].requestId, pageOf([wall(3, T0 + 3 * H + 30_000)]));
    expect(got).toHaveLength(3);
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
    const { stream: stuck, sent: stuckSent, chunks: stuckChunks } = harness();
    stuck.want(T0 + 3 * H, T0 + 4 * H);
    stuck.accept(stuckSent[0].requestId, pageOf([wall(1, T0 + 3 * H + 10_000)], { endTs: T0 + 3 * H + 10_000, id: 1 }));
    stuck.accept(stuckSent[1].requestId, pageOf([wall(1, T0 + 3 * H + 10_000)], { endTs: T0 + 3 * H + 10_000, id: 1 }));
    expect(stuckChunks).toEqual([[T0 + 3 * H, false]]);
  });

  it("retries a refused or failed chunk after a pause, keeps its request budget, and forgets everything on a pair switch", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 5_000, maxPerMinute: 3 });
    stream.want(T0, T0 + 4 * H);
    expect(sent).toHaveLength(2);
    stream.accept(sent[0].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    expect(stream.status().unavailable).toBe("STORAGE_UNAVAILABLE");
    expect(sent).toHaveLength(3);
    stream.fail(sent[1].requestId);
    expect(sent).toHaveLength(3);
    stream.accept(sent[2].requestId, pageOf([]));
    tick(60_000);
    vi.advanceTimersByTime(60_000);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    stream.setIdentity({ ...ID, symbol: "ETHUSDT" });
    expect(stream.status()).toEqual({ oldestDone: null, inFlight: 0, unavailable: null });
  });

  it("waits the retry pause after an answer that says the host cannot serve walls, then asks again", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ retryMs: 30_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    stream.accept(sent[0].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    tick(10_000);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    tick(20_000);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(2);
  });

  it("asks again for the chunks that reach past a time once they are forgotten, and leaves the older finished chunks alone", () => {
    const { stream, sent } = harness();
    stream.invalidateSince(T0);
    stream.want(T0 + 2 * H, T0 + 4 * H);
    stream.accept(sent[0].requestId, pageOf([]));
    stream.accept(sent[1].requestId, pageOf([]));
    expect(sent).toHaveLength(2);
    expect(stream.isDone(T0 + 3 * H) && stream.isDone(T0 + 2 * H)).toBe(true);
    stream.invalidateSince(T0 + 4 * H);
    expect(sent).toHaveLength(2);
    stream.invalidateSince(T0 + 4 * H + 1);
    expect(sent).toHaveLength(2);
    stream.invalidateSince(T0 + 3 * H + 1);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([T0 + 3 * H, T0 + 4 * H]);
    expect(stream.isDone(T0 + 3 * H)).toBe(false);
    expect(stream.isDone(T0 + 2 * H)).toBe(true);
    stream.accept(sent[2].requestId, pageOf([]));
    expect(stream.isDone(T0 + 3 * H)).toBe(true);
    stream.invalidateSince(T0 + 2 * H + 1);
    expect(sent).toHaveLength(5);
    expect(sent.slice(3).map((request) => request.fromTs)).toEqual([T0 + 3 * H, T0 + 2 * H]);
  });

  it("sends nothing more once told to stop, however the requests in flight come back, and asks again from the next want", () => {
    vi.useFakeTimers();
    const { stream, sent } = harness();
    stream.want(T0 + 1_000, T0 + 4 * H - 1_000);
    expect(sent).toHaveLength(2);
    stream.fail(sent[1].requestId);
    expect(vi.getTimerCount()).toBe(1);
    const asked = sent.length;
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
    stream.accept(sent[0].requestId, pageOf([]));
    expect(sent).toHaveLength(asked);
    stream.want(T0 + 1_000, T0 + 4 * H - 1_000);
    expect(sent.length).toBeGreaterThan(asked);
  });

  it("hands a page's size percentiles to the listeners that ask for them, before its walls, and only when the page has them", () => {
    const { stream, sent } = harness();
    const seen: string[] = [];
    stream.subscribe({ onWalls: () => seen.push("walls"), onChunk: () => undefined, onBands: (bands, rowWidth) => seen.push(`bands:${bands.p90}:${rowWidth}`) });
    stream.subscribe({ onWalls: () => undefined, onChunk: () => undefined });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    const bands = { n: 9, p50: 1, p75: 2, p90: 3, p95: 4, p99: 5 };
    stream.accept(sent[0].requestId, { ...pageOf([wall(1, T0 + 3 * H + 10_000)]), sizeBands: bands });
    expect(seen).toEqual(["bands:3:4", "walls"]);
    stream.want(T0 + 2 * H, T0 + 3 * H);
    stream.accept(sent[1].requestId, pageOf([wall(2, T0 + 2 * H + 10_000)]));
    expect(seen).toEqual(["bands:3:4", "walls", "walls"]);
  });

  it("keeps the whale stream's request ids clear of every other history stream's, and its chunks at twelve hours", () => {
    const ranges: [string, number, number][] = [
      ["columns", STREAM_ID_BASE, STREAM_ID_BASE + STREAM_ID_SPAN],
      ["walls", WALL_STREAM_ID_BASE, WALL_STREAM_ID_BASE + WALL_STREAM_ID_SPAN],
      ["band columns", BAND_COLUMN_ID_BASE, BAND_COLUMN_ID_BASE + BAND_COLUMN_ID_SPAN],
      ["whale walls", WHALE_WALL_STREAM_ID_BASE, WHALE_WALL_STREAM_ID_BASE + WALL_STREAM_ID_SPAN],
    ];
    ranges.sort((a, b) => a[1] - b[1]);
    for (let index = 1; index < ranges.length; index += 1) expect([ranges[index][0], ranges[index][1] >= ranges[index - 1][2]]).toEqual([ranges[index][0], true]);
    expect(Number.isSafeInteger(WHALE_WALL_STREAM_ID_BASE + WALL_STREAM_ID_SPAN)).toBe(true);
    expect(WHALE_WALL_CHUNK_MS).toBe(12 * 3_600_000);
  });

  it("takes its own chunk length and request-id range, so two streams can share the worker without answering each other", () => {
    const own = WALL_STREAM_ID_BASE + WALL_STREAM_ID_SPAN;
    const { stream, sent } = harness({ chunkMs: 2 * H, idBase: own });
    const base = Math.floor(T0 / (2 * H)) * (2 * H);
    const from = base + 1_000;
    stream.want(from, from + 6 * H - 2_000);
    expect(sent).toHaveLength(2);
    expect(sent.map((r) => [r.fromTs, r.toTs])).toEqual([[base + 4 * H, from + 6 * H - 2_000], [base + 2 * H, base + 4 * H]]);
    expect(sent.every((r) => r.requestId >= own && stream.owns(r.requestId))).toBe(true);
    expect(stream.owns(WALL_STREAM_ID_BASE)).toBe(false);
    expect(new WallHistoryStream({ request: () => undefined }).owns(sent[0].requestId)).toBe(false);
  });

  it("sends its filter with every request, starts over when the filter changes, and ignores a filter that only lists its outcomes in another order", () => {
    const { stream, sent } = harness({ filter: FILTER });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    expect(sent).toHaveLength(1);
    expect(sent[0].filter).toEqual(FILTER);
    stream.setFilter({ minUsd: FILTER.minUsd, alwaysOutcomes: ["partial", "filled"] });
    expect(sent).toHaveLength(1);
    stream.setFilter({ minUsd: 9_000_000, alwaysOutcomes: ["filled"] });
    expect(sent).toHaveLength(2);
    expect(sent[1].filter).toEqual({ minUsd: 9_000_000, alwaysOutcomes: ["filled"] });
    stream.accept(sent[0].requestId, pageOf([]));
    expect(stream.status().oldestDone).toBeNull();
    stream.accept(sent[1].requestId, pageOf([]));
    expect(stream.status().oldestDone).toBe(T0 + 3 * H);
    stream.setFilter(null);
    expect(sent).toHaveLength(3);
    expect(sent[2].filter).toBeNull();
    expect(stream.status().oldestDone).toBeNull();
  });

  it("gives up on its filter after the host refuses it twice as unavailable, asks again without one, and keeps the filter once the host has echoed it", () => {
    const { stream, sent } = harness({ filter: FILTER });
    stream.want(T0, T0 + 4 * H);
    expect(sent).toHaveLength(2);
    stream.accept(sent[0].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(stream.filter).toEqual(FILTER);
    stream.accept(sent[1].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(stream.filter).toBeNull();
    expect(stream.filterDropped).toBe(true);
    expect(sent.map((r) => r.filter === null)).toEqual([false, false, false, true, true]);
    expect(sent.slice(3).map((r) => [r.fromTs, r.toTs])).toEqual([[T0 + 3 * H, T0 + 4 * H], [T0 + 2 * H, T0 + 3 * H]]);

    const confirmed = harness({ filter: FILTER });
    confirmed.stream.want(T0, T0 + 4 * H);
    confirmed.stream.accept(confirmed.sent[0].requestId, { ...pageOf([]), filter: FILTER });
    expect(confirmed.sent).toHaveLength(3);
    confirmed.stream.accept(confirmed.sent[1].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    confirmed.stream.accept(confirmed.sent[2].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(confirmed.stream.filter).toEqual(FILTER);
    expect(confirmed.stream.filterDropped).toBe(false);

    const other = harness({ filter: FILTER });
    other.stream.want(T0, T0 + 4 * H);
    other.stream.accept(other.sent[0].requestId, { available: false, reason: "NO_PYRAMID" });
    other.stream.accept(other.sent[1].requestId, { available: false, reason: "NO_PYRAMID" });
    expect(other.stream.filter).toEqual(FILTER);

    const failing = harness({ filter: FILTER });
    failing.stream.want(T0, T0 + 4 * H);
    failing.stream.fail(failing.sent[0].requestId);
    failing.stream.fail(failing.sent[1].requestId);
    expect(failing.stream.filter).toEqual(FILTER);
  });

  it("keeps a dropped filter for the life of the stream, whatever the pair, and brings it back only when a filter is set again", () => {
    const { stream, sent } = harness({ filter: FILTER });
    stream.want(T0, T0 + 4 * H);
    stream.accept(sent[0].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    stream.accept(sent[1].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(stream.filterDropped).toBe(true);
    stream.setIdentity({ ...ID, symbol: "ETHUSDT" });
    expect(stream.filterDropped).toBe(true);
    expect(stream.filter).toBeNull();
    expect(stream.status()).toEqual({ oldestDone: null, inFlight: 0, unavailable: null });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    expect(sent.at(-1)?.filter).toBeNull();
    stream.setFilter(FILTER);
    expect(stream.filterDropped).toBe(false);
    expect(stream.filter).toEqual(FILTER);
    expect(sent.at(-1)?.filter).toEqual(FILTER);
  });

  it("remembers that the host echoed its filter across pairs, so one later refusal does not drop it", () => {
    const { stream, sent } = harness({ filter: FILTER });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    stream.accept(sent[0].requestId, { ...pageOf([]), filter: FILTER });
    stream.setIdentity({ ...ID, symbol: "ETHUSDT" });
    stream.want(T0, T0 + 4 * H);
    stream.accept(sent.at(-2)!.requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    stream.accept(sent.at(-1)!.requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(stream.filter).toEqual(FILTER);
    expect(stream.filterDropped).toBe(false);
  });

  it("asks again after the delay the host named when it was busy, not after the long pause", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ retryMs: 30_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H);
    stream.fail(sent[0].requestId, 250);
    tick(1_900);
    vi.advanceTimersByTime(1_900);
    expect(sent).toHaveLength(1);
    tick(200);
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(2);
  });
});
