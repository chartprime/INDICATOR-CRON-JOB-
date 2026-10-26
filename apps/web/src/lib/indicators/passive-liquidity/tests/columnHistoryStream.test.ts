import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestBudget } from "../requestBudget";
import type { HistoryRequest } from "../heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage, type HistoryWindow } from "../heatmapHistoryDecode";
import { ColumnHistoryStream, STREAM_CHUNK_MS, STREAM_ID_BASE, STREAM_ID_SPAN, STREAM_LEVEL_MS, STREAM_MAX_IN_FLIGHT, STREAM_MAX_REQUESTS_PER_MINUTE, STREAM_RATE_LIMIT_RETRY_MS, STREAM_RETRY_MS, type StreamPage } from "../columnHistoryStream";
import { COLUMN_HISTORY_MAX_PER_MINUTE, InFlightPool } from "../requestBudget";
import { HeatmapHistory } from "../heatmapHistory";

const H = STREAM_CHUNK_MS;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H);
const WARMUP = 600_000;
const MARGIN = 240_000;
const ID = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTCUSDT" };

function window(ts: number): HistoryWindow {
  return { ts, state: "COVERED", columns: [] };
}

type AvailablePage = Extract<DecodedHistoryPage, { available: true }>;

function page(fromTs: number, toTs: number, next: number | null = null): AvailablePage {
  const windows: HistoryWindow[] = [];
  for (let ts = Math.floor(fromTs / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS; ts < (next ?? toTs); ts += HISTORY_WINDOW_MS) windows.push(window(ts));
  return { available: true, generation: "g", levelMs: STREAM_LEVEL_MS, rowFactor: 1, rowWidth: 4, span: { oldest: T0 - 7 * 86_400_000, newest: T0 + 48 * H }, next, windows };
}

function harness(options: { maxPerMinute?: number; retryMs?: number; maxInFlight?: number; pool?: InFlightPool } = {}) {
  let now = T0 + 10 * H;
  const sent: HistoryRequest[] = [];
  const pages: StreamPage[] = [];
  const chunks: [number, boolean][] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), now: () => now, maxInFlight: 2, ...options });
  stream.subscribe({ onPage: (p) => pages.push(p), onChunk: (start, done) => chunks.push([start, done]) });
  stream.setIdentity(ID);
  return { stream, sent, pages, chunks, tick: (ms: number) => { now += ms; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("column history stream: one-hour chunks of 10 s columns, newest first, handed on and dropped", () => {
  it("asks for the newest chunk first with its warm-up and margin, two in flight, and carries on as each one lands", () => {
    const { stream, sent, chunks } = harness();
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent.map((r) => [r.fromTs - T0, r.toTs - T0, r.levelMs, r.rowFactor])).toEqual([[3 * H - WARMUP, 4 * H, STREAM_LEVEL_MS, 1], [2 * H - WARMUP, 3 * H + MARGIN, STREAM_LEVEL_MS, 1]]);
    expect(sent.every((r) => r.requestId >= STREAM_ID_BASE && stream.owns(r.requestId))).toBe(true);
    expect(stream.owns(1)).toBe(false);
    expect(stream.owns(STREAM_ID_BASE + STREAM_ID_SPAN)).toBe(false);
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs - T0, sent[2].toTs - T0]).toEqual([H - WARMUP, 2 * H + MARGIN]);
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    stream.accept(sent[2].requestId, page(sent[2].fromTs, sent[2].toTs));
    expect(sent).toHaveLength(4);
    expect([sent[3].fromTs - T0, sent[3].toTs - T0]).toEqual([-WARMUP, H + MARGIN]);
    stream.accept(sent[3].requestId, page(sent[3].fromTs, sent[3].toTs));
    expect(chunks.map(([start]) => (start - T0) / H)).toEqual([3, 2, 1, 0]);
    expect(stream.status()).toEqual({ oldestDone: T0, inFlight: 0, unavailable: null });
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(4);
  });

  it("asks for the oldest chunk first when told so, as a zone reaching back days wants its hours in time order, and the newest first again on the next ask without it", () => {
    const { stream, sent } = harness();
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN, true);
    expect(sent.map((r) => [r.fromTs - T0, r.toTs - T0])).toEqual([[-WARMUP, H + MARGIN], [H - WARMUP, 2 * H + MARGIN]]);
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs - T0, sent[2].toTs - T0]).toEqual([2 * H - WARMUP, 3 * H + MARGIN]);
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    stream.accept(sent[2].requestId, page(sent[2].fromTs, sent[2].toTs));
    expect([sent[3].fromTs - T0, sent[3].toTs - T0]).toEqual([3 * H - WARMUP, 4 * H]);
    stream.accept(sent[3].requestId, page(sent[3].fromTs, sent[3].toTs));
    stream.want(T0 - 2 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent.slice(4).map((r) => (r.fromTs + WARMUP - T0) / H)).toEqual([-1, -2]);
  });

  it("follows a chunk's next page inside the same chunk and hands each page's windows on in order, dropping windows outside what it asked", () => {
    const { stream, sent, pages, chunks } = harness();
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(1);
    const first = sent[0];
    const cut = first.fromTs + 6 * HISTORY_WINDOW_MS;
    const early = page(first.fromTs, first.toTs, cut);
    early.windows.unshift(window(first.fromTs - HISTORY_WINDOW_MS));
    stream.accept(first.requestId, early);
    expect(pages).toHaveLength(1);
    expect(pages[0].chunkStart).toBe(T0 + 3 * H);
    expect(pages[0].windows.map((w) => w.ts)).toEqual(early.windows.slice(1).map((w) => w.ts));
    expect(chunks).toEqual([]);
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([cut, first.toTs]);
    stream.accept(sent[1].requestId, page(cut, first.toTs));
    expect(pages).toHaveLength(2);
    expect(pages[1].windows[0].ts).toBe(cut);
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
  });

  it("follows a chunk's next page while another chunk is in flight: asks from where the page ended, never the same range twice", () => {
    const { stream, sent, chunks } = harness();
    stream.want(T0 + 2 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(2);
    const first = sent[0];
    const cut = first.fromTs + 6 * HISTORY_WINDOW_MS;
    stream.accept(first.requestId, page(first.fromTs, first.toTs, cut));
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([cut, first.toTs]);
    stream.accept(sent[2].requestId, page(cut, first.toTs));
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
    expect(sent.filter((request) => request.fromTs === first.fromTs && request.toTs === first.toTs)).toHaveLength(1);
  });

  it("when the minute's requests run out in the middle of a chunk, carries on from where the page ended once the budget frees, not from the chunk's start", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ maxPerMinute: 2 });
    stream.want(T0 + 2 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(2);
    const first = sent[0];
    const cut = first.fromTs + 6 * HISTORY_WINDOW_MS;
    stream.accept(first.requestId, page(first.fromTs, first.toTs, cut));
    expect(sent).toHaveLength(2);
    expect(chunks).toEqual([]);
    tick(60_000);
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([cut, first.toTs]);
  });

  it("finishes an hour from before the host's oldest window as done, so an ask reaching past what the host keeps is not retried for ever", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 5_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    stream.accept(sent[0].requestId, { ...page(sent[0].fromTs, sent[0].toTs), windows: [], span: { oldest: T0 + 4 * H, newest: T0 + 48 * H } });
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
    tick(5_000);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    stream.want(T0 + 4 * H, T0 + 5 * H, WARMUP, MARGIN);
    stream.accept(sent[1].requestId, { ...page(sent[1].fromTs, sent[1].toTs), windows: [], span: { oldest: T0 + 4 * H + 30 * 60_000, newest: T0 + 48 * H } });
    expect(chunks[1]).toEqual([T0 + 4 * H, false]);
  });

  it("waits the same pause before asking again for a page whose cursor did not move, rather than asking at once and forever", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 5_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    stream.accept(sent[0].requestId, { ...page(sent[0].fromTs, sent[0].toTs), next: sent[0].fromTs });
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    tick(4_000);
    vi.advanceTimersByTime(4_000);
    expect(sent).toHaveLength(1);
    tick(1_000);
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(2);
  });

  it("retries a chunk the host refused or a request that failed after a pause, telling the listener, and starts the chunk over", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 5_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    stream.accept(sent[0].requestId, { available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    expect(stream.status().unavailable).toBe("STORAGE_UNAVAILABLE");
    expect(sent).toHaveLength(1);
    tick(5_000);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([sent[0].fromTs, sent[0].toTs]);
    stream.fail(sent[1].requestId);
    expect(chunks).toEqual([[T0 + 3 * H, false], [T0 + 3 * H, false]]);
    tick(5_000);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(3);
    stream.accept(sent[2].requestId, page(sent[2].fromTs, sent[2].toTs));
    expect(chunks[2]).toEqual([T0 + 3 * H, true]);
    expect(stream.status().unavailable).toBeNull();
  });

  it("keeps four requests in flight and 140 a minute by default: a day of hourly pages, each in two parts, lands in seconds and under the runtime's limit", () => {
    const { stream, sent } = harness({ maxInFlight: STREAM_MAX_IN_FLIGHT });
    stream.want(T0, T0 + 6 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(4);
    expect(STREAM_MAX_IN_FLIGHT).toBe(4);
    expect(STREAM_MAX_REQUESTS_PER_MINUTE).toBe(140);
    expect(COLUMN_HISTORY_MAX_PER_MINUTE).toBe(149);
  });

  it("shares one in-flight pool with the heatmap's reader: together they hold open no more than the route serves at once, and a freed slot goes to whoever asks next (PR #47 review)", () => {
    vi.useFakeTimers();
    const pool = new InFlightPool(4);
    const heatmapRequests: HistoryRequest[] = [];
    const heatmap = new HeatmapHistory({ request: (request) => heatmapRequests.push(request), now: () => T0 + 10 * H, maxInFlight: 2, pool });
    heatmap.setIdentity(ID);
    heatmap.want({ levelMs: 60_000, rowFactor: 1, fromTs: T0 - 8 * H, toTs: T0, beforeTs: T0 });
    expect(heatmapRequests).toHaveLength(2);
    expect(pool.held).toBe(2);
    const { stream, sent, tick } = harness({ maxInFlight: 4, pool });
    stream.want(T0, T0 + 6 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(2);
    expect(pool.held).toBe(4);
    heatmap.accept(heatmapRequests[0].requestId, { available: true, generation: "g", levelMs: 60_000, rowFactor: 1, rowWidth: 4, span: { oldest: T0 - 10 * H, newest: T0 }, next: null, windows: [] });
    expect(pool.held).toBe(3);
    tick(1_000);
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(3);
    expect(pool.held).toBe(4);
    stream.fail(sent[0].requestId);
    expect(sent).toHaveLength(4);
    expect(pool.held).toBe(4);
    stream.setIdentity(null);
    expect(pool.held).toBe(1);
    heatmap.setIdentity(null);
    expect(pool.held).toBe(0);
  });

  it("a fork holds its reads in its parent's pool, so the lanes together hold open no more than the route serves at once (PR #47 review)", () => {
    const pool = new InFlightPool(3);
    const { stream, sent } = harness({ maxInFlight: 2, pool });
    const fork = stream.fork();
    stream.want(T0 + 2 * H, T0 + 4 * H, 0, 0);
    fork.want(T0 + 2 * H, T0 + 4 * H, 0, 0);
    expect(sent).toHaveLength(3);
    expect(pool.held).toBe(3);
    stream.setIdentity(null);
    expect(pool.held).toBe(0);
  });

  it("asks for a chunk's next page only with a slot free in the shared pool: not when another reader took the slot the page freed, nor when the minute's budget renews while the pool is full (PR #47 review)", () => {
    vi.useFakeTimers();
    const pool = new InFlightPool(2);
    const first = harness({ maxInFlight: 2, pool });
    let grab = false;
    first.stream.subscribe({ onPage: () => { if (grab) pool.take(); }, onChunk: () => {} });
    first.stream.want(T0 + 2 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(first.sent).toHaveLength(2);
    const cut = first.sent[0].fromTs + 6 * HISTORY_WINDOW_MS;
    grab = true;
    first.stream.accept(first.sent[0].requestId, page(first.sent[0].fromTs, first.sent[0].toTs, cut));
    grab = false;
    expect(first.sent).toHaveLength(2);
    expect(pool.held).toBe(2);
    pool.free();
    first.tick(1_000);
    vi.advanceTimersByTime(1_000);
    expect(first.sent).toHaveLength(3);
    expect(first.sent[2].fromTs).toBe(cut);
    expect(pool.held).toBe(2);
    first.stream.setIdentity(null);

    const full = new InFlightPool(3);
    const second = harness({ maxInFlight: 2, maxPerMinute: 2, pool: full });
    second.stream.want(T0 + 2 * H, T0 + 4 * H, WARMUP, MARGIN);
    expect(second.sent).toHaveLength(2);
    const next = second.sent[0].fromTs + 6 * HISTORY_WINDOW_MS;
    second.stream.accept(second.sent[0].requestId, page(second.sent[0].fromTs, second.sent[0].toTs, next));
    expect(second.sent).toHaveLength(2);
    full.take();
    full.take();
    second.tick(60_000);
    vi.advanceTimersByTime(60_000);
    expect(second.sent).toHaveLength(2);
    expect(full.held).toBe(3);
    full.free();
    second.tick(1_000);
    vi.advanceTimersByTime(1_000);
    expect(second.sent).toHaveLength(3);
    expect(second.sent[2].fromTs).toBe(next);
    expect(full.held).toBe(3);
  });

  it("asks again within seconds when the runtime gave up on a busy host, not after the long pause", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 30_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    stream.accept(sent[0].requestId, { available: false, reason: "RATE_LIMITED" });
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    expect(STREAM_RATE_LIMIT_RETRY_MS).toBeLessThanOrEqual(5_000);
    tick(STREAM_RATE_LIMIT_RETRY_MS - 1);
    vi.advanceTimersByTime(STREAM_RATE_LIMIT_RETRY_MS - 1);
    expect(sent).toHaveLength(1);
    tick(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([sent[0].fromTs, sent[0].toTs]);
  });

  it("asks again after the delay the host named when it was busy, not after the long pause, and a fork's refusal reaches the lane that asked", () => {
    vi.useFakeTimers();
    const { stream, sent, chunks, tick } = harness({ retryMs: 30_000 });
    const fork = stream.fork();
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    fork.want(T0 + 2 * H, T0 + 3 * H, 0, 0);
    expect(sent).toHaveLength(2);
    stream.fail(sent[0].requestId, 250);
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    tick(1_900);
    vi.advanceTimersByTime(1_900);
    expect(sent).toHaveLength(2);
    tick(200);
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([sent[0].fromTs, sent[0].toTs]);
    stream.fail(sent[1].requestId, 250);
    tick(2_100);
    vi.advanceTimersByTime(2_100);
    expect(sent).toHaveLength(4);
    expect([sent[3].fromTs, sent[3].toTs]).toEqual([sent[1].fromTs, sent[1].toTs]);
  });

  it("a fork can keep its own pause after a failure the host gave no delay for, shorter than its parent's, and the parent keeps the long one", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ retryMs: 30_000 });
    const fork = stream.fork({ retryMs: 5_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    fork.want(T0 + 2 * H, T0 + 3 * H, 0, 0);
    expect(sent).toHaveLength(2);
    stream.fail(sent[0].requestId);
    stream.fail(sent[1].requestId);
    tick(4_999);
    vi.advanceTimersByTime(4_999);
    expect(sent).toHaveLength(2);
    tick(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([sent[1].fromTs, sent[1].toTs]);
    tick(24_999);
    vi.advanceTimersByTime(24_999);
    expect(sent).toHaveLength(3);
    tick(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(4);
    expect([sent[3].fromTs, sent[3].toTs]).toEqual([sent[0].fromTs, sent[0].toTs]);
    expect(stream.fork().retryMs).toBe(30_000);
  });

  it("still waits the long pause for a failure the host gave no delay for", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ retryMs: 30_000 });
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    stream.fail(sent[0].requestId);
    tick(10_000);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    tick(20_000);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(2);
  });

  it("reset forgets the hours it finished and the requests in flight but keeps the pair, takes the hours it is told are already held, and drops a late answer", () => {
    const { stream, sent, chunks } = harness();
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN);
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    expect(stream.isDone(T0 + 3 * H)).toBe(true);
    expect(sent).toHaveLength(3);
    stream.reset([T0 + 2 * H]);
    expect(stream.identity).toEqual(ID);
    expect(stream.status()).toEqual({ oldestDone: T0 + 2 * H, inFlight: 0, unavailable: null });
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    expect(chunks).toEqual([[T0 + 3 * H, true]]);
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent.slice(3).map((request) => request.fromTs + WARMUP)).toEqual([T0 + 3 * H, T0 + H]);
  });

  it("a reset from a listener on the last hour asks nothing more until the next want: the hours it finished are not fetched again", () => {
    const { stream, sent } = harness();
    stream.subscribe({ onPage: () => {}, onChunk: (start) => { if (start === T0) stream.reset(); } });
    stream.want(T0, T0 + 2 * H, 0, 0);
    expect(sent.map((request) => request.fromTs)).toEqual([T0 + H, T0]);
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    expect(sent).toHaveLength(2);
    expect(stream.status().inFlight).toBe(0);
    stream.want(T0, T0 + 2 * H, 0, 0);
    expect(sent.slice(2).map((request) => request.fromTs)).toEqual([T0 + H, T0]);
  });

  it("a fork is its own lane: it asks and finishes its hours apart from its parent and hears only its own pages, shares the request ids so an answer finds it through the parent, and follows the parent's pair", () => {
    const { stream, sent, chunks, pages } = harness();
    const fork = stream.fork();
    const forkPages: StreamPage[] = [];
    const forkChunks: [number, boolean][] = [];
    fork.subscribe({ onPage: (p) => forkPages.push(p), onChunk: (start, done) => forkChunks.push([start, done]) });
    expect(fork.identity).toEqual(ID);
    stream.want(T0 + 3 * H, T0 + 4 * H, WARMUP, MARGIN);
    fork.want(T0 + 3 * H, T0 + 4 * H, 0, 0);
    expect(sent).toHaveLength(2);
    expect(sent[1].requestId).not.toBe(sent[0].requestId);
    expect(stream.owns(sent[1].requestId)).toBe(true);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([T0 + 3 * H, T0 + 4 * H]);
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    expect(forkChunks).toEqual([[T0 + 3 * H, true]]);
    expect(forkPages).toHaveLength(1);
    expect([chunks, pages]).toEqual([[], []]);
    expect([stream.isDone(T0 + 3 * H), fork.isDone(T0 + 3 * H)]).toEqual([false, true]);
    stream.fail(sent[0].requestId);
    expect(chunks).toEqual([[T0 + 3 * H, false]]);
    expect(forkChunks).toHaveLength(1);
    stream.reset();
    expect(fork.isDone(T0 + 3 * H)).toBe(true);
    stream.setIdentity({ ...ID, symbol: "ETHUSDT" });
    expect(fork.identity?.symbol).toBe("ETHUSDT");
    expect(fork.isDone(T0 + 3 * H)).toBe(false);
  });

  it("a fork spends its parent's budget: together they send no more than one stream's requests a minute, and the fork wakes when a request frees (PR #40 review)", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ maxPerMinute: 2, pool: new InFlightPool(4) });
    const fork = stream.fork();
    expect(fork.budget).toBe(stream.budget);
    stream.want(T0 + 3 * H, T0 + 4 * H, 0, 0);
    fork.want(T0 + 2 * H, T0 + 4 * H, 0, 0);
    expect(sent).toHaveLength(2);
    tick(59_999);
    vi.advanceTimersByTime(59_999);
    expect(sent).toHaveLength(2);
    tick(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([T0 + 2 * H, T0 + 3 * H]);
  });

  it("spends a budget it is handed, so another reader's requests count against it too (PR #40 review)", () => {
    const pool = new RequestBudget(3);
    const other = pool.share();
    let now = T0 + 10 * H;
    const sent: HistoryRequest[] = [];
    const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), now: () => now, budget: pool.share(2) });
    stream.setIdentity(ID);
    other.take(now);
    other.take(now);
    stream.want(T0, T0 + 4 * H, 0, 0);
    expect(sent).toHaveLength(1);
    now += 60_000;
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    expect(sent).toHaveLength(3);
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    expect(sent).toHaveLength(3);
  });

  it("keeps to its request budget and wakes when it frees, and a pair switch forgets everything", () => {
    vi.useFakeTimers();
    const { stream, sent, tick } = harness({ maxPerMinute: 2 });
    stream.want(T0, T0 + 4 * H, WARMUP, MARGIN);
    expect(sent).toHaveLength(2);
    stream.accept(sent[0].requestId, page(sent[0].fromTs, sent[0].toTs));
    stream.accept(sent[1].requestId, page(sent[1].fromTs, sent[1].toTs));
    expect(sent).toHaveLength(2);
    tick(60_000);
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(4);
    stream.setIdentity({ ...ID, symbol: "ETHUSDT" });
    expect(stream.status()).toEqual({ oldestDone: null, inFlight: 0, unavailable: null });
    stream.accept(sent[2].requestId, page(sent[2].fromTs, sent[2].toTs));
    expect(stream.status().oldestDone).toBeNull();
  });
});

describe("column history stream: chunks older than the host", () => {
  it("finishes a chunk that ends at or before the host's oldest column as done and empty, and keeps retrying one the host could still fill", () => {
    // NQ 2026-10-08: the chart's bars began at 15:50 on 09-30, so the week's first day warmed up from 16:00, and the
    // host's columns began at 21:30; the four warm-up hours came back with no windows and were asked again every
    // thirty seconds for ever, the week never whole. Before the host's span there is nothing to wait for.
    const { stream, sent, chunks, tick } = harness();
    stream.want(T0, T0 + 2 * H, 0, 0);
    const older = { ...page(sent[0].fromTs, sent[0].toTs), windows: [], span: { oldest: T0 + 2 * H, newest: T0 + 48 * H } };
    stream.accept(sent[0].requestId, older);
    expect(chunks).toEqual([[T0 + H, true]]);
    const within = { ...page(sent[1].fromTs, sent[1].toTs), windows: [], span: { oldest: T0 + H / 2, newest: T0 + 48 * H } };
    stream.accept(sent[1].requestId, within);
    expect(chunks).toEqual([[T0 + H, true], [T0, false]]);
    tick(STREAM_RETRY_MS);
    stream.want(T0, T0 + 2 * H, 0, 0);
    expect(sent).toHaveLength(3);
    const unknown = { ...page(sent[2].fromTs, sent[2].toTs), windows: [], span: { oldest: null, newest: T0 + 48 * H } };
    stream.accept(sent[2].requestId, unknown);
    expect(chunks).toEqual([[T0 + H, true], [T0, false], [T0, false]]);
  });
});
