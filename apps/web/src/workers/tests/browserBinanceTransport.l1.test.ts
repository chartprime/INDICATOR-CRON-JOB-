// The tape-derived frames of browser-direct mode: markers from the live tape
// and from the REST bootstrap of recent aggregate trades, the aggressive-print
// pool on the snapshot, aggressive_history answered from the pool, marker_history
// for a client that opted in, and the honest states when the bootstrap fails.
// The bootstrap pages come from the same 10,000 recorded BTC-USDT aggregate
// trades the parity test drives the runtime modules with, so the markers on
// the wire are compared with the runtime's own history buffer here as well.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_COMMIT_GRACE_MS,
  BrowserBinanceTransport,
  DEFAULT_ENDPOINTS,
  HEALTH_REASON_NO_TAPE_HISTORY,
  HEALTH_REASON_READY,
  MAX_AGGRESSIVE_HISTORY_TRADES,
  MAX_COVERAGE_ENTRIES,
  MAX_SNAPSHOT_MARKERS,
  MAX_TAPE_BOOTSTRAP_PAGES,
  SEAM_FILL_FAILURES_BEFORE_GIVING_UP,
  STREAM_BACKOFF_CAP_MS,
  STREAM_BACKOFF_INITIAL_MS,
  TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED,
  TAPE_BOOTSTRAP_PAGE,
  clearBrowserTapeStates,
  parseAggTradesPage,
  type UpstreamSocket,
} from "../browserBinanceTransport";
import { DEFAULT_WINDOW_MS as POOL_WINDOW_MS } from "../../lib/tape/aggressivePool";
import { parseServerFrame, type MarkerFrame, type ServerFrame, type TradeFrame } from "../../types/frames";
import { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } from "../../lib/tape/largeTradeDetection";
import { loadRecordedTrades } from "./recordedTape";

const requireRuntime = createRequire(import.meta.url);
const { createHistoryBuffer } = requireRuntime(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../runtime/src/server/history.js")) as {
  createHistoryBuffer(options: { markerBucketMs: number; maxMarkersPerBucketSide: number }): {
    recordMarker(marker: MarkerFrame): boolean;
    snapshotMarkers(): MarkerFrame[];
  };
};

const recorded = loadRecordedTrades();
const FIRST_ID = Number(recorded[0].trade_id.slice(1));
const LAST_ID = Number(recorded[recorded.length - 1].trade_id.slice(1));
const OLDEST_TS = recorded[0].ts_exchange;
const NEWEST_TS = recorded[recorded.length - 1].ts_exchange;
// "now" is a few seconds after the newest recorded trade, inside the forming minute.
const NOW_MS = NEWEST_TS + 5_000;
const MINUTE = Math.floor(NOW_MS / 60_000) * 60_000;
const SPOT = { type: "select", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" };

/** The mirror's aggTrades row for a recorded trade. */
function aggTradeRow(trade: TradeFrame): Record<string, unknown> {
  const id = Number(trade.trade_id.slice(1));
  return { a: id, p: String(trade.price), q: String(trade.size), f: id, l: id, T: trade.ts_exchange, m: trade.side === "sell", M: true };
}

/** Serves a tape as the mirror would: the newest page without parameters, the 1,000 ids from `fromId`, or the first 1,000 rows at or after `startTime`. */
function recordedPage(url: string, rows: readonly TradeFrame[] = recorded): Record<string, unknown>[] {
  const params = new URL(url).searchParams;
  const fromId = params.get("fromId");
  const startTime = params.get("startTime");
  if (startTime !== null) return rows.filter((trade) => trade.ts_exchange >= Number(startTime)).slice(0, TAPE_BOOTSTRAP_PAGE).map(aggTradeRow);
  const first = Number(rows[0].trade_id.slice(1));
  const last = Number(rows[rows.length - 1].trade_id.slice(1));
  const start = fromId === null ? Math.max(first, last - TAPE_BOOTSTRAP_PAGE + 1) : Number(fromId);
  return rows.filter((trade) => {
    const id = Number(trade.trade_id.slice(1));
    return id >= start && id < start + TAPE_BOOTSTRAP_PAGE;
  }).map(aggTradeRow);
}

function historyRequest(requestId: number, fromTs: number, toTs: number, minSize: number, cursor?: string) {
  return { type: "aggressive_history", request_id: requestId, from_ts: fromTs, to_ts: toTs, min_size: minSize, ...(cursor === undefined ? {} : { cursor }) };
}

/** Sends one aggressive_history request and returns its reply (or null when the transport drops it). */
async function askHistory(h: Harness, request: Record<string, unknown>): Promise<Extract<ServerFrame, { type: "aggressive_history" }> | null> {
  const before = h.frames.length;
  h.transport.send(JSON.stringify(request));
  await vi.advanceTimersByTimeAsync(0);
  const reply = h.parsed().slice(before).find((frame) => frame.type === "aggressive_history");
  return reply === undefined ? null : reply as Extract<ServerFrame, { type: "aggressive_history" }>;
}

const klineRow = (openTime: number, close: string) => [openTime, "79500.00", "79600.00", "79400.00", close, "5.000", openTime + 59_999, "0", 50, "2.000", "0", "0"];
const klines = [klineRow(MINUTE - 120_000, "79510.00"), klineRow(MINUTE - 60_000, "79520.00"), klineRow(MINUTE, "79530.00")];

class FakeUpstreamSocket implements UpstreamSocket {
  static instances: FakeUpstreamSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeUpstreamSocket.instances.push(this);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  message(payload: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }
}

type Harness = {
  transport: BrowserBinanceTransport;
  frames: Record<string, unknown>[];
  parsed: () => ServerFrame[];
  aggTradesMock: ReturnType<typeof vi.fn>;
  stream: () => FakeUpstreamSocket;
  now: () => number;
};

/** The instance the worker creates after a transport closed: the same mirror, the same clock, the pair's kept tape state. */
function reconnected(previous: Harness): Harness {
  const previousAggTrades = previous.aggTradesMock as unknown as (url: string) => Promise<Response>;
  const next = harness((url) => previousAggTrades(url), previous.now);
  next.aggTradesMock = previous.aggTradesMock;
  return next;
}

/** A hand-built mirror row with explicit fill ids. */
function aggRow(a: number, T: number, f: number, l: number, q = "5.00000"): Record<string, unknown> {
  return { a, p: "79530.00", q, f, l, T, m: false, M: true };
}

/** Serves hand-built mirror rows (sorted by id) as the mirror would: newest page, the page from `fromId`, or the page from `startTime` on. */
function mirrorPage(url: string, raws: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const params = new URL(url).searchParams;
  const fromId = params.get("fromId");
  const startTime = params.get("startTime");
  const sorted = [...raws].sort((x, y) => (x.a as number) - (y.a as number));
  if (startTime !== null) return sorted.filter((row) => (row.T as number) >= Number(startTime)).slice(0, TAPE_BOOTSTRAP_PAGE);
  if (fromId !== null) return sorted.filter((row) => (row.a as number) >= Number(fromId)).slice(0, TAPE_BOOTSTRAP_PAGE);
  return sorted.slice(-TAPE_BOOTSTRAP_PAGE);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness(aggTrades: (url: string) => Promise<Response> = async (url) => jsonResponse(recordedPage(url)), now: () => number = () => NOW_MS): Harness {
  FakeUpstreamSocket.instances = [];
  const aggTradesMock = vi.fn(aggTrades);
  const transport = new BrowserBinanceTransport("ws://127.0.0.1:8000/ws", {
    fetch: ((url: string) => (url.includes("/aggTrades") ? aggTradesMock(url) : Promise.resolve(jsonResponse(klines)))) as unknown as typeof fetch,
    WebSocket: FakeUpstreamSocket,
    now,
  });
  const frames: Record<string, unknown>[] = [];
  transport.onmessage = (event) => {
    frames.push(JSON.parse(event.data as string) as Record<string, unknown>);
  };
  return {
    transport,
    frames,
    parsed: () => frames.map((frame) => {
      const parsed = parseServerFrame(frame, { nowMs: now() });
      if (parsed === null) throw new Error(`frame rejected by parseServerFrame: ${JSON.stringify(frame).slice(0, 400)}`);
      return parsed;
    }),
    aggTradesMock,
    stream: () => FakeUpstreamSocket.instances.at(-1)!,
    now,
  };
}

async function openAndSelect(h: Harness, { markerHistory = true } = {}): Promise<void> {
  h.transport.onopen = () => {
    if (markerHistory) h.transport.send(JSON.stringify({ type: "capabilities", marker_history: true }));
    h.transport.send(JSON.stringify(SPOT));
  };
  await vi.advanceTimersByTimeAsync(0);
  expect(h.transport.readyState).toBe(1);
}

/** Lets the sequential REST pages of the bootstrap resolve (each page is a few promise hops). */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Lets a bootstrap read its pages and, with a stream connecting or open but silent, wait out the grace before committing them. */
async function settleBootstrap(): Promise<void> {
  await settle();
  await vi.advanceTimersByTimeAsync(BOOTSTRAP_COMMIT_GRACE_MS);
  await settle();
}

function liveTrade(id: number, ts: number, size: string, sell: boolean, price = "79530.00") {
  return { stream: "btcusdt@trade", data: { e: "trade", E: ts + 5, s: "BTCUSDT", t: id, p: price, q: size, T: ts, m: sell, M: true } };
}

function runtimeMarkers(trades: readonly TradeFrame[]): MarkerFrame[] {
  const buffer = createHistoryBuffer({ markerBucketMs: MARKER_BUCKET_MS, maxMarkersPerBucketSide: MARKERS_PER_BUCKET_SIDE });
  for (const trade of trades) buffer.recordMarker({ ...trade, type: "marker" });
  return buffer.snapshotMarkers();
}

beforeEach(() => {
  vi.useFakeTimers();
  clearBrowserTapeStates();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserBinanceTransport tape bootstrap", () => {
  it("pages recent aggregate trades from the mirror and re-broadcasts a snapshot whose markers and pool pass the parser and equal the runtime's", async () => {
    const h = harness();
    await openAndSelect(h);
    await settleBootstrap();
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar", "snapshot", "bar", "marker_history"]);

    // Ten full pages, newest first by id, then the page before the recording is empty.
    expect(h.aggTradesMock).toHaveBeenCalledTimes(11);
    expect(String(h.aggTradesMock.mock.calls[0]![0])).toBe(`${DEFAULT_ENDPOINTS.spotRestBase}/api/v3/aggTrades?symbol=BTCUSDT&limit=1000`);
    expect(String(h.aggTradesMock.mock.calls[1]![0])).toBe(`${DEFAULT_ENDPOINTS.spotRestBase}/api/v3/aggTrades?symbol=BTCUSDT&limit=1000&fromId=${LAST_ID - 1_999}`);
    expect(String(h.aggTradesMock.mock.calls[10]![0])).toContain(`fromId=${FIRST_ID - 1_000}`);

    const first = frames[1];
    if (first.type !== "snapshot") throw new Error("expected a snapshot");
    expect(first.markers).toEqual([]);
    expect(first.aggressive_prints).toBeUndefined();

    const snapshot = frames[5];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.bars.map((bar) => bar.ts_open)).toEqual(first.bars.map((bar) => bar.ts_open));
    expect(snapshot.trades).toEqual([]);
    expect(snapshot.vpin_status).toBe("DISABLED");

    // Six minutes of tape, four per minute and side.
    const expected = runtimeMarkers(recorded);
    expect(expected.length).toBeGreaterThan(40);
    expect(expected.length).toBeLessThanOrEqual(MAX_SNAPSHOT_MARKERS);
    expect(snapshot.markers).toEqual(expected);
    expect(snapshot.markers.every((marker) => marker.trade_id.startsWith("a"))).toBe(true);

    // No stream delivers yet: the prints from the pages are there, but no
    // stretch of complete tape reaches now, so the snapshot claims none.
    expect(snapshot.aggressive_prints_from).toBe(NOW_MS);
    expect(snapshot.aggressive_prints_floor).toBeGreaterThan(0);
    const prints = snapshot.aggressive_prints!;
    expect(prints.length).toBeGreaterThan(100);
    expect(prints.length).toBeLessThan(recorded.length);
    for (let i = 1; i < prints.length; i += 1) expect(prints[i].ts_exchange).toBeGreaterThanOrEqual(prints[i - 1].ts_exchange);
    // Complete from the floor: every recorded print at or above it is in the pool.
    const floor = snapshot.aggressive_prints_floor!;
    const above = recorded.filter((trade) => trade.size >= floor).map((trade) => trade.trade_id);
    const poolIds = new Set(prints.map((print) => print.trade_id));
    expect(above.every((id) => poolIds.has(id))).toBe(true);

    expect(frames[6]).toMatchObject({ type: "bar", ts_open: MINUTE, closed: false });
    const history = frames[7];
    if (history.type !== "marker_history") throw new Error("expected marker_history");
    expect(history.reset).toBe(true);
    expect(history.seq).toBe(0);
    expect(history.markers).toEqual(expected);
  });

  it("sends no marker_history when the client did not opt in, and the full set when it opts in later", async () => {
    const h = harness();
    await openAndSelect(h, { markerHistory: false });
    await settleBootstrap();
    expect(h.frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar", "snapshot", "bar"]);
    h.frames.length = 0;
    h.transport.send(JSON.stringify({ type: "capabilities", marker_history: true }));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["marker_history"]);
    expect(frames[0]).toMatchObject({ reset: true, seq: 0 });
    expect((frames[0] as { markers: unknown[] }).markers).toEqual(runtimeMarkers(recorded));
  });

  it("drops bootstrap rows at or after the first live trade so nothing is counted twice", async () => {
    let release: (() => void) | null = null;
    const h = harness((url) => new Promise<Response>((resolve) => {
      release = () => resolve(jsonResponse(recordedPage(url)));
    }));
    await openAndSelect(h);
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    // A live trade from the middle of the recording's last page arrives before REST answers.
    const cutoff = recorded[recorded.length - 300].ts_exchange;
    h.stream().message(liveTrade(9_000_000_001, cutoff, "0.00100", false));
    h.frames.length = 0;
    for (let page = 0; page < 11; page += 1) {
      await settle();
      release!();
    }
    await settle();
    const snapshot = h.parsed().find((frame) => frame.type === "snapshot");
    if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    const kept = recorded.filter((trade) => trade.ts_exchange < cutoff);
    expect(snapshot.markers.filter((marker) => marker.trade_id.startsWith("a"))).toEqual(runtimeMarkers(kept).filter((marker) => marker.ts_exchange < cutoff));
    expect(snapshot.aggressive_prints!.every((print) => print.ts_exchange < cutoff || !print.trade_id.startsWith("a"))).toBe(true);
    expect(snapshot.trades).toHaveLength(1);
  });

  it("keeps what was read when a later page fails, with coverage starting at the oldest row read", async () => {
    let calls = 0;
    const h = harness(async (url) => {
      calls += 1;
      if (calls === 3) throw new Error("network");
      return jsonResponse(recordedPage(url));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await settleBootstrap();
      expect(h.aggTradesMock).toHaveBeenCalledTimes(3);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar", "snapshot", "bar", "marker_history"]);
      const snapshot = frames[5];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const read = recorded.slice(-2_000);
      expect(snapshot.markers).toEqual(runtimeMarkers(read));
      expect(frames.filter((frame) => frame.type === "health")).toHaveLength(1);
      // Coverage is the two pages read, not the page that failed; the oldest
      // millisecond read is not claimed either, since the walk did not reach
      // the exchange's first trade and that millisecond may continue in the
      // page never read.
      const floor = snapshot.aggressive_prints_floor!;
      expect(await askHistory(h, historyRequest(1, read[0].ts_exchange + 1, NEWEST_TS + 1, floor))).toMatchObject({ complete: true, reason: null });
      expect(await askHistory(h, historyRequest(3, read[0].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
      expect(await askHistory(h, historyRequest(2, recorded[7_000].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    } finally {
      warn.mockRestore();
    }
  });

  it("says the tape history is missing after three failed attempts, keeps marking live trades, and recovers when a later attempt succeeds", async () => {
    let failing = true;
    const h = harness(async (url) => {
      if (failing) throw new Error("network");
      return jsonResponse(recordedPage(url));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await settle();
      expect(h.parsed().map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
      h.frames.length = 0;
      let delay = STREAM_BACKOFF_INITIAL_MS;
      for (let attempt = 2; attempt <= TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED; attempt += 1) {
        await vi.advanceTimersByTimeAsync(delay);
        await settle();
        delay *= 2;
      }
      expect(h.aggTradesMock).toHaveBeenCalledTimes(TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED);
      expect(h.parsed()).toEqual([{ type: "health", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", recoveryState: "READY", stale: false, reason: HEALTH_REASON_NO_TAPE_HISTORY }]);
      h.frames.length = 0;

      // Markers still come from the live tape.
      h.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h.frames.length = 0;
      h.stream().message(liveTrade(9_000_000_001, NOW_MS, "0.50000", false));
      expect(h.parsed().map((frame) => frame.type)).toEqual(["trade", "marker"]);
      h.frames.length = 0;

      // The next retry succeeds: READY is plain again, the seam between the
      // pages and the live trade is read (nothing newer was recorded), and the
      // snapshot goes out claiming coverage from the oldest page.
      failing = false;
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["health", "snapshot", "bar", "marker_history"]);
      expect(frames[0]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
      expect(String(h.aggTradesMock.mock.calls.at(-1)![0])).toContain(`fromId=${LAST_ID + 1}`);
      const snapshot = frames[1];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.trades).toHaveLength(1);
      expect(snapshot.aggressive_prints_from).toBe(OLDEST_TS);
      expect(snapshot.markers.some((marker) => marker.trade_id === "9000000001")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("BrowserBinanceTransport live markers", () => {
  it("emits a marker right behind a trade the runtime's retention admits, and none for one it would not keep", async () => {
    const h = harness(async () => jsonResponse([]));
    await openAndSelect(h);
    await settle();
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    h.frames.length = 0;
    const minute = MINUTE;
    const sizes = ["1.00000", "0.90000", "0.80000", "0.70000"];
    sizes.forEach((size, index) => h.stream().message(liveTrade(100 + index, minute + index * 1_000, size, true)));
    // The fifth sell of the minute is the smallest: no marker.
    h.stream().message(liveTrade(104, minute + 4_000, "0.10000", true));
    // A buy opens its own side of the bucket.
    h.stream().message(liveTrade(105, minute + 5_000, "0.10000", false));
    // A bigger sell displaces the smallest retained one.
    h.stream().message(liveTrade(106, minute + 6_000, "2.00000", true));
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual([
      "trade", "marker", "trade", "marker", "trade", "marker", "trade", "marker",
      "trade",
      "trade", "marker",
      "trade", "marker",
    ]);
    expect(frames[1]).toEqual({ type: "marker", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: minute, price: 79530, size: 1, side: "sell", trade_id: "100" });
    expect(frames[12]).toMatchObject({ type: "marker", trade_id: "106", size: 2 });
    expect(frames.filter((frame) => frame.type === "marker").map((frame) => (frame as MarkerFrame).trade_id)).toEqual(["100", "101", "102", "103", "105", "106"]);
  });
});

describe("BrowserBinanceTransport aggressive_history", () => {
  async function bootstrapped(): Promise<{ h: Harness; floor: number; from: number; prints: TradeFrame[] }> {
    const h = harness();
    await openAndSelect(h);
    await settleBootstrap();
    const snapshot = h.parsed()[5];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    h.frames.length = 0;
    // The observed stretch is the recording itself; no stream delivers.
    return { h, floor: snapshot.aggressive_prints_floor!, from: OLDEST_TS, prints: snapshot.aggressive_prints! };
  }

  it("answers a window inside the observed tape at the pool's floor completely, in time order", async () => {
    const { h, floor, from, prints } = await bootstrapped();
    const toTs = OLDEST_TS + 120_000;
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 3, from_ts: from, to_ts: toTs, min_size: floor }));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames).toHaveLength(1);
    const reply = frames[0];
    if (reply.type !== "aggressive_history") throw new Error("expected aggressive_history");
    expect(reply).toMatchObject({ request_id: 3, from_ts: from, to_ts: toTs, min_size: floor, complete: true, reason: null, next_cursor: null, retry_after_ms: null });
    const expected = prints.filter((print) => print.ts_exchange >= from && print.ts_exchange < toTs);
    expect(expected.length).toBeGreaterThan(0);
    expect(reply.trades.map((trade) => trade.trade_id)).toEqual(expected.map((trade) => trade.trade_id));
    // A higher floor narrows it; a window inside the coverage is covered too.
    h.frames.length = 0;
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 4, from_ts: from + 60_000, to_ts: toTs, min_size: floor * 4 }));
    await vi.advanceTimersByTimeAsync(0);
    const narrower = h.parsed()[0];
    if (narrower.type !== "aggressive_history") throw new Error("expected aggressive_history");
    expect(narrower.complete).toBe(true);
    expect(narrower.trades.every((trade) => trade.size >= floor * 4 && trade.ts_exchange >= from + 60_000)).toBe(true);
  });

  it("is honestly STORAGE_UNAVAILABLE before the bootstrap, outside the observed tape, past its end, or below the floor", async () => {
    const early = harness(() => new Promise<Response>(() => {}));
    await openAndSelect(early);
    early.frames.length = 0;
    early.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 1, from_ts: OLDEST_TS, to_ts: NOW_MS, min_size: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(early.parsed()[0]).toMatchObject({ type: "aggressive_history", request_id: 1, complete: false, reason: "STORAGE_UNAVAILABLE", next_cursor: null, trades: [] });

    const { h, floor, from } = await bootstrapped();
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 5, from_ts: from - 1, to_ts: NEWEST_TS + 1, min_size: floor }));
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 6, from_ts: from, to_ts: NEWEST_TS + 1, min_size: floor / 2 }));
    // Past the newest row read: the tape from there to now was never observed.
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 9, from_ts: from, to_ts: NOW_MS, min_size: floor }));
    // Malformed or stale requests get no reply at all, as the runtime drops them.
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 7, from_ts: from, to_ts: NOW_MS + 120_000, min_size: floor }));
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 8, from_ts: from, to_ts: NOW_MS, min_size: floor, cursor: "bm90LWEtY3Vyc29y" }));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => (frame as { request_id: number }).request_id)).toEqual([5, 6, 9]);
    for (const frame of frames) expect(frame).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
  });

  it("pages a window of more than 10,000 prints with CAP_REACHED and a cursor bound to the request", async () => {
    // Twelve pages of equal-sized prints: the floor is that size, every print is kept.
    const synthetic: TradeFrame[] = [];
    for (let i = 0; i < 12_000; i += 1) {
      synthetic.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: NOW_MS - 3_600_000 + i * 250, price: 79_500 + (i % 7), size: 0.25, side: i % 3 === 0 ? "sell" : "buy", trade_id: `a${500_000 + i}` });
    }
    const h = harness(async (url) => jsonResponse(recordedPage(url, synthetic)));
    await openAndSelect(h);
    await settleBootstrap();
    const snapshot = h.parsed()[5];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.aggressive_prints).toHaveLength(12_000);
    expect(snapshot.aggressive_prints_floor).toBe(0.25);
    h.frames.length = 0;
    const from = synthetic[0].ts_exchange;
    const request = { type: "aggressive_history", request_id: 20, from_ts: from, to_ts: synthetic[synthetic.length - 1].ts_exchange + 1, min_size: 0.25 };
    h.transport.send(JSON.stringify(request));
    await vi.advanceTimersByTimeAsync(0);
    const page1 = h.parsed()[0];
    if (page1.type !== "aggressive_history") throw new Error("expected aggressive_history");
    expect(page1).toMatchObject({ complete: false, reason: "CAP_REACHED", retry_after_ms: null });
    expect(page1.trades).toHaveLength(MAX_AGGRESSIVE_HISTORY_TRADES);
    expect(typeof page1.next_cursor).toBe("string");
    h.frames.length = 0;
    h.transport.send(JSON.stringify({ ...request, request_id: 21, cursor: page1.next_cursor }));
    // The same cursor on another window is refused without a reply.
    h.transport.send(JSON.stringify({ ...request, request_id: 22, from_ts: from + 1, cursor: page1.next_cursor }));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames).toHaveLength(1);
    const page2 = frames[0];
    if (page2.type !== "aggressive_history") throw new Error("expected aggressive_history");
    expect(page2).toMatchObject({ request_id: 21, complete: true, reason: null, next_cursor: null });
    expect(page2.trades).toHaveLength(2_000);
    const ids = [...page1.trades, ...page2.trades].map((trade) => trade.trade_id);
    expect(new Set(ids).size).toBe(12_000);
    expect(ids).toEqual(synthetic.map((trade) => trade.trade_id));
  });
});

describe("BrowserBinanceTransport tape seams", () => {
  const SEAM_SIZE = "5.00000";
  /** Rows the mirror holds after the recording: two inside the seam, one at the live trade's time and one after it. */
  function seamRows(liveFrom: number): TradeFrame[] {
    return [NEWEST_TS + 1_000, NEWEST_TS + 2_000, liveFrom, liveFrom + 500].map((ts, index) => ({
      type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: ts, price: 79_530, size: Number(SEAM_SIZE), side: "buy", trade_id: `a${LAST_ID + 1 + index}`,
    }));
  }

  it("claims nothing across the seam when the stream connects after the bootstrap, then fills the seam from REST and claims the whole stretch", async () => {
    const liveFrom = NEWEST_TS + 3_000;
    const tape = [...recorded, ...seamRows(liveFrom)];
    let release: (() => void) | null = null;
    const h = harness((url) => {
      if (!url.includes(`fromId=${LAST_ID + 1}`)) return Promise.resolve(jsonResponse(recordedPage(url, recorded)));
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(recordedPage(url, tape)));
      });
    });
    await openAndSelect(h);
    await settleBootstrap();
    const first = h.parsed()[5];
    if (first.type !== "snapshot") throw new Error("expected a snapshot");
    const floor = first.aggressive_prints_floor!;
    expect(first.aggressive_prints_from).toBe(NOW_MS);
    expect(await askHistory(h, historyRequest(1, OLDEST_TS, NOW_MS, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    expect(await askHistory(h, historyRequest(2, OLDEST_TS, NEWEST_TS + 1, floor))).toMatchObject({ complete: true });

    // The stream connects late; its first trade opens the live span and starts the seam fill.
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    h.frames.length = 0;
    // Its trade id is below the mirror's fill ids at that millisecond, so those rows are the stream's.
    h.stream().message(liveTrade(100, liveFrom, SEAM_SIZE, false));
    await vi.advanceTimersByTimeAsync(0);
    // The pages ended at an aggregate id: the seam is read from the next id, no millisecond ambiguity.
    expect(String(h.aggTradesMock.mock.calls.at(-1)![0])).toContain(`fromId=${LAST_ID + 1}`);
    // Until the fill lands, the hole between the newest page and the first
    // live trade is inside no claim (the live print's size has moved the
    // floor, so these ask well above it).
    const aboveFloor = 1;
    expect(await askHistory(h, historyRequest(3, OLDEST_TS, liveFrom + 1, aboveFloor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    // Not even the first live trade's own millisecond: fills before it in that millisecond are unread until the seam closes.
    expect(await askHistory(h, historyRequest(4, liveFrom, liveFrom + 1, aboveFloor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    // The observed tape ends at the last trade seen: a window reaching past it, let alone into the future, is not complete.
    expect(await askHistory(h, historyRequest(14, liveFrom, liveFrom + 2, aboveFloor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    expect(await askHistory(h, historyRequest(15, liveFrom, NOW_MS + 30_000, aboveFloor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    expect(h.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(0);

    release!();
    await settle();
    const frames = h.parsed();
    expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
    const snapshot = frames.find((frame) => frame.type === "snapshot")!;
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.aggressive_prints_from).toBe(OLDEST_TS);
    // The seam's own prints are in the pool; the rows at and after the live trade were the stream's and are not.
    const ids = snapshot.aggressive_prints!.map((print) => print.trade_id);
    expect(ids).toContain(`a${LAST_ID + 1}`);
    expect(ids).toContain(`a${LAST_ID + 2}`);
    expect(ids).not.toContain(`a${LAST_ID + 3}`);
    expect(ids).toContain("100");
    const whole = await askHistory(h, historyRequest(5, OLDEST_TS, liveFrom + 1, aboveFloor));
    expect(whole).toMatchObject({ complete: true, reason: null });
    expect(whole!.trades.map((trade) => trade.trade_id).slice(-3)).toEqual([`a${LAST_ID + 1}`, `a${LAST_ID + 2}`, "100"]);
  });

  it("closes itself when a stream that delivered trades is lost, as a lost runtime socket would, and the next instance keeps the tape and leaves the hole outside every claim until REST can fill it", async () => {
    let seamFails = true;
    const holeRows: TradeFrame[] = [];
    const h1 = harness(async (url) => {
      if (!url.includes("startTime")) return jsonResponse(recordedPage(url));
      if (seamFails) throw new Error("network");
      return jsonResponse(recordedPage(url, holeRows));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settleBootstrap();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      const t1 = NEWEST_TS + 1_000;
      const t2 = NEWEST_TS + 1_500;
      h1.stream().message(liveTrade(1, t1, SEAM_SIZE, false));
      h1.stream().message(liveTrade(2, t2, SEAM_SIZE, true));
      await settle();
      const bootstrapReads = h1.aggTradesMock.mock.calls.length;
      expect(await askHistory(h1, historyRequest(1, t1, t2 + 1, 1))).toMatchObject({ complete: true });
      h1.frames.length = 0;
      const closed = vi.fn();
      h1.transport.onclose = closed;
      h1.stream().drop();
      // Not RECOVERING with the pair still "live": the transport is gone, the worker reconnects.
      expect(h1.transport.readyState).toBe(3);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(h1.frames).toEqual([]);

      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      // No second bootstrap: the kept markers and pool ride on the connect snapshot, which claims nothing (no stream delivers).
      expect(h2.aggTradesMock.mock.calls.length).toBe(bootstrapReads);
      const connectFrames = h2.parsed();
      expect(connectFrames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar", "marker_history"]);
      const connectSnapshot = connectFrames[1];
      if (connectSnapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(connectSnapshot.markers.length).toBeGreaterThan(40);
      expect(connectSnapshot.trades.map((trade) => trade.trade_id)).toEqual(["1", "2"]);
      expect(connectSnapshot.aggressive_prints_from).toBe(NOW_MS);
      // The closed span is observed up to its last trade only.
      expect(await askHistory(h2, historyRequest(2, t1, t2 + 1, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(3, t1, t2 + 2, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });

      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.frames.length = 0;
      const t3 = NEWEST_TS + 2_500;
      h2.stream().message(liveTrade(3, t3, SEAM_SIZE, false));
      // The span before ended at a trade id: the seam is read from its last millisecond and reconciled by fill id.
      expect(String(h2.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${t2}`);
      // Three failed seam reads with backoff: the hole stays open, every claim stops at it.
      let delay = STREAM_BACKOFF_INITIAL_MS;
      for (let failure = 1; failure < SEAM_FILL_FAILURES_BEFORE_GIVING_UP; failure += 1) {
        await settle();
        await vi.advanceTimersByTimeAsync(delay);
        delay *= 2;
      }
      await settle();
      expect(h2.aggTradesMock.mock.calls.length).toBe(bootstrapReads + SEAM_FILL_FAILURES_BEFORE_GIVING_UP);
      expect(await askHistory(h2, historyRequest(4, t1, t3 + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
      // The hole's two boundary milliseconds hold fills nobody read: unverified for good.
      expect(await askHistory(h2, historyRequest(5, t3, t3 + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(6, OLDEST_TS, t2 + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(16, OLDEST_TS, t2, 1))).toMatchObject({ complete: true });
      expect(h2.transport.tapeCoverage.unverified).toBe(2);
      expect(h2.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(0);
      h2.stream().drop();
      expect(h2.transport.readyState).toBe(3);

      // The next outage's seam can be read: the mirror holds one print inside the hole and one past it.
      holeRows.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: t3 + 700, price: 79_530, size: 5, side: "sell", trade_id: "a77" });
      const t4 = NEWEST_TS + 4_000;
      holeRows.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: t4 + 100, price: 79_530, size: 5, side: "sell", trade_id: "a78" });
      seamFails = false;
      const h3 = reconnected(h2);
      await openAndSelect(h3);
      await settle();
      h3.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h3.frames.length = 0;
      h3.stream().message(liveTrade(4, t4, SEAM_SIZE, false));
      await settle();
      expect(String(h3.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${t3}`);
      // The first hole was given up and is not re-read (its boundary t3 stays
      // unverified); the second is closed and the snapshot says so.
      const snapshot = h3.parsed().find((frame) => frame.type === "snapshot");
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.aggressive_prints_from).toBe(t3 + 1);
      expect(snapshot.aggressive_prints!.map((print) => print.trade_id)).toContain("a77");
      expect(snapshot.aggressive_prints!.map((print) => print.trade_id)).not.toContain("a78");
      expect(await askHistory(h3, historyRequest(7, t3 + 1, t4 + 1, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h3, historyRequest(9, t3, t4 + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h3, historyRequest(8, t1, t4 + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    } finally {
      warn.mockRestore();
    }
  });

  it("reconciles trades sharing a millisecond at both seam boundaries by fill id, and keeps an unverifiable millisecond outside every claim", async () => {
    const C = NEWEST_TS + 3_000;
    const L = C + 1_000;
    const M = C + 5_000;
    const h1 = harness(async (url) => {
      if (url.includes(`fromId=${LAST_ID + 1}`)) {
        // The seam after the pages: one row before the live span; at its first
        // millisecond one wholly before the first live trade (kept), one
        // straddling it (unverifiable) and one wholly after (the stream's).
        return jsonResponse([
          aggRow(LAST_ID + 1, NEWEST_TS + 1_000, 400, 400),
          aggRow(LAST_ID + 2, C, 490, 495),
          aggRow(LAST_ID + 3, C, 498, 500),
          aggRow(LAST_ID + 4, C, 505, 507),
          aggRow(LAST_ID + 5, C + 10, 508, 508),
        ]);
      }
      if (url.includes(`startTime=${L}`)) {
        // The seam after a lost stream whose last trade was id 502 at L: one
        // wholly delivered, one wholly after it (kept), one straddling it.
        return jsonResponse([
          aggRow(9_001, L, 501, 502),
          aggRow(9_002, L, 503, 504),
          aggRow(9_003, L, 502, 503),
          aggRow(9_004, M + 5, 700, 700),
        ]);
      }
      return jsonResponse(recordedPage(url));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settleBootstrap();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h1.frames.length = 0;
      h1.stream().message(liveTrade(500, C, SEAM_SIZE, false));
      h1.stream().message(liveTrade(501, C, SEAM_SIZE, true));
      h1.stream().message(liveTrade(502, L, SEAM_SIZE, false));
      await settle();
      const snapshot = h1.parsed().find((frame) => frame.type === "snapshot");
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const ids = snapshot.aggressive_prints!.map((print) => print.trade_id);
      expect(ids).toContain(`a${LAST_ID + 1}`);
      expect(ids).toContain(`a${LAST_ID + 2}`);
      expect(ids).not.toContain(`a${LAST_ID + 3}`);
      expect(ids).not.toContain(`a${LAST_ID + 4}`);
      expect(ids).not.toContain(`a${LAST_ID + 5}`);
      expect(ids).toEqual(expect.arrayContaining(["500", "501", "502"]));
      // Millisecond C holds a fill nobody can place: coverage reaching now starts after it.
      expect(snapshot.aggressive_prints_from).toBe(C + 1);
      expect(h1.transport.tapeCoverage.unverified).toBe(1);
      expect(await askHistory(h1, historyRequest(1, OLDEST_TS, C, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h1, historyRequest(2, OLDEST_TS, C + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h1, historyRequest(3, C + 1, L + 1, 1))).toMatchObject({ complete: true });

      h1.stream().drop();
      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.frames.length = 0;
      h2.stream().message(liveTrade(600, M, SEAM_SIZE, false));
      await settle();
      const after = h2.parsed().find((frame) => frame.type === "snapshot");
      if (after === undefined || after.type !== "snapshot") throw new Error("expected a snapshot");
      const afterIds = after.aggressive_prints!.map((print) => print.trade_id);
      expect(afterIds).toContain("a9002");
      expect(afterIds).not.toContain("a9001");
      expect(afterIds).not.toContain("a9003");
      expect(afterIds).not.toContain("a9004");
      expect(h2.transport.tapeCoverage.unverified).toBe(2);
      expect(after.aggressive_prints_from).toBe(L + 1);
      expect(await askHistory(h2, historyRequest(4, C + 1, L, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(5, C + 1, L + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(6, L + 1, M + 1, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(7, L + 1, M + 2, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    } finally {
      warn.mockRestore();
    }
  });

  it("commits the bootstrap pages only once the stream's first trade can be reconciled, so a page that landed first is not counted twice", async () => {
    const h = harness();
    await openAndSelect(h);
    h.stream().open();
    await settle();
    // Every page is read while the stream is open but silent: staged, not committed.
    expect(h.aggTradesMock).toHaveBeenCalledTimes(11);
    expect(h.transport.tapeCoverage.staged).toBe(10);
    expect(h.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
    expect(await askHistory(h, historyRequest(1, OLDEST_TS, NEWEST_TS + 1, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    // The first live trade lands inside the newest page (the stream connected before REST answered).
    const overlap = recorded[recorded.length - 300];
    const C = overlap.ts_exchange;
    const t0 = Number(overlap.trade_id.slice(1));
    h.frames.length = 0;
    h.stream().message(liveTrade(t0, C, "0.00100", false));
    await settle();
    const snapshot = h.parsed().find((frame) => frame.type === "snapshot");
    if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    const kept = recorded.filter((trade) => trade.ts_exchange < C || (trade.ts_exchange === C && Number(trade.trade_id.slice(1)) < t0));
    expect(snapshot.markers.filter((marker) => marker.trade_id.startsWith("a"))).toEqual(runtimeMarkers(kept).filter((marker) => marker.ts_exchange < C || Number(marker.trade_id.slice(1)) < t0));
    const restIds = new Set(kept.map((trade) => trade.trade_id));
    expect(snapshot.aggressive_prints!.every((print) => !print.trade_id.startsWith("a") || restIds.has(print.trade_id))).toBe(true);
    expect(h.transport.tapeCoverage.staged).toBe(0);
    // The pages reach into the live span: one stretch, claimed from the oldest row.
    expect(snapshot.aggressive_prints_from).toBe(OLDEST_TS);
  });

  it("commits the staged pages after a short grace while the stream is connecting or open but silent", async () => {
    const silent = harness();
    await openAndSelect(silent);
    await settle();
    // Every page read while the socket was still connecting: staged.
    expect(silent.transport.tapeCoverage.staged).toBe(10);
    expect(silent.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
    silent.stream().open();
    await vi.advanceTimersByTimeAsync(BOOTSTRAP_COMMIT_GRACE_MS - 1);
    expect(silent.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(silent.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(2);
    expect(silent.transport.tapeCoverage.staged).toBe(0);
  });

  it("bounds the coverage bookkeeping across many reconnects and forgets what is past the pool's retention", async () => {
    const clock = { now: NOW_MS };
    const nowFn = () => clock.now;
    let h = harness(async (url) => {
      if (url.includes("startTime")) throw new Error("network");
      return jsonResponse([]);
    }, nowFn);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rounds = 200;
      const stepMs = 2 * 60_000;
      for (let round = 0; round < rounds; round += 1) {
        if (round > 0) h = reconnected(h);
        await openAndSelect(h);
        await vi.advanceTimersByTimeAsync(0);
        h.stream().open();
        await vi.advanceTimersByTimeAsync(0);
        h.stream().message(liveTrade(round + 1, clock.now - 1_000, SEAM_SIZE, false));
        // Let the seam fill fail its three reads, then move on.
        await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS * 4);
        const coverage = h.transport.tapeCoverage;
        expect(coverage.observed).toBeLessThanOrEqual(MAX_COVERAGE_ENTRIES);
        expect(coverage.liveSpans).toBeLessThanOrEqual(MAX_COVERAGE_ENTRIES);
        expect(coverage.unfillable).toBeLessThanOrEqual(MAX_COVERAGE_ENTRIES);
        clock.now += stepMs;
        h.stream().drop();
      }
      // Six and a half hours of two-minute rounds: only the last four hours remain.
      const h2 = reconnected(h);
      await openAndSelect(h2);
      await vi.advanceTimersByTimeAsync(0);
      const kept = h2.transport.tapeCoverage;
      const withinRetention = Math.ceil(POOL_WINDOW_MS / stepMs) + 1;
      expect(kept.liveSpans).toBeLessThanOrEqual(withinRetention);
      expect(kept.liveSpans).toBeGreaterThan(withinRetention - 3);
      expect(kept.observed).toBeLessThanOrEqual(withinRetention);
      expect(kept.unfillable).toBeLessThanOrEqual(withinRetention);
      expect(kept.observed).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("BrowserBinanceTransport coverage edges", () => {
  const SIZE = "5.00000";

  it("reconciles a one-trade stream span against both of its id boundaries: aggregates before and after it are seeded, one within it is dropped, one straddling it leaves its millisecond unverified", async () => {
    const C = NEWEST_TS + 3_000;
    const M = C + 5_000;
    // The mirror after the recording: at C (the one-trade span, id 500) one
    // aggregate wholly before, one within, one after; at M (the next span,
    // id 600) one straddling it; then one newer.
    const extra = [
      aggRow(LAST_ID + 1, C, 490, 495),
      aggRow(LAST_ID + 2, C, 500, 500),
      aggRow(LAST_ID + 3, C, 505, 507),
      aggRow(LAST_ID + 4, M, 598, 601),
      aggRow(LAST_ID + 5, M + 2_000, 800, 800),
    ];
    const h1 = harness(async (url) => {
      const params = new URL(url).searchParams;
      const fromId = params.get("fromId");
      if (fromId !== null && Number(fromId) > LAST_ID) return jsonResponse(mirrorPage(url, extra));
      if (params.get("startTime") !== null) return jsonResponse(mirrorPage(url, extra));
      return jsonResponse(recordedPage(url));
    }, () => M + 10_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settleBootstrap();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h1.frames.length = 0;
      h1.stream().message(liveTrade(500, C, SIZE, false));
      await settle();
      // The seam after the pages is read by id and ends at the first row past C.
      expect(String(h1.aggTradesMock.mock.calls.at(-1)![0])).toContain(`fromId=${LAST_ID + 1}`);
      const first = h1.parsed().find((frame) => frame.type === "snapshot");
      if (first === undefined || first.type !== "snapshot") throw new Error("expected a snapshot");
      const ids = first.aggressive_prints!.map((print) => print.trade_id);
      expect(ids).toContain(`a${LAST_ID + 1}`);
      // While the stream delivers, every fill from its first trade on is the stream's.
      expect(ids).not.toContain(`a${LAST_ID + 2}`);
      expect(ids).not.toContain(`a${LAST_ID + 3}`);
      expect(ids).toContain("500");
      expect(h1.transport.tapeCoverage.unverified).toBe(0);
      expect(first.aggressive_prints_from).toBe(OLDEST_TS);
      expect(await askHistory(h1, historyRequest(1, OLDEST_TS, C + 1, 1))).toMatchObject({ complete: true });
      // The stream is lost right after its first trade: fills 505..507 at C were never delivered.
      h1.stream().drop();

      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.frames.length = 0;
      h2.stream().message(liveTrade(600, M, SIZE, false));
      h2.stream().message(liveTrade(601, M + 1_000, SIZE, false));
      await settle();
      // Read again from the first row the lost stream owned: against the span
      // as it ended (one trade, id 500), the row within it is the stream's and
      // the row after it is missing tape; the row at M straddles the new span's first trade.
      expect(String(h2.aggTradesMock.mock.calls.at(-1)![0])).toContain(`fromId=${LAST_ID + 2}`);
      const after = h2.parsed().find((frame) => frame.type === "snapshot");
      if (after === undefined || after.type !== "snapshot") throw new Error("expected a snapshot");
      const afterIds = after.aggressive_prints!.map((print) => print.trade_id);
      expect(afterIds).not.toContain(`a${LAST_ID + 2}`);
      expect(afterIds).toContain(`a${LAST_ID + 3}`);
      expect(afterIds).not.toContain(`a${LAST_ID + 4}`);
      expect(h2.transport.tapeCoverage.unverified).toBe(1);
      expect(after.aggressive_prints_from).toBe(M + 1);
      expect(await askHistory(h2, historyRequest(2, OLDEST_TS, M, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(3, OLDEST_TS, M + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(4, M + 1, M + 1_001, 1))).toMatchObject({ complete: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("never joins two stream spans whose trade ids are not consecutive, even when their milliseconds touch or coincide, until REST reconciles the fills between them", async () => {
    const tA = NOW_MS - 10_000;
    // Adjacent milliseconds: the first stream ends at tA with trade 100, the
    // next starts at tA+1 with trade 200; the mirror holds the fills between.
    const adjacent = [aggRow(1, tA, 101, 150), aggRow(2, tA + 1, 151, 199), aggRow(3, tA + 1, 200, 200), aggRow(4, tA + 500, 300, 300)];
    let release: (() => void) | null = null;
    const h1 = harness((url) => {
      if (!url.includes("startTime")) return Promise.resolve(jsonResponse([]));
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(mirrorPage(url, adjacent)));
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settle();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h1.stream().message(liveTrade(100, tA, SIZE, false));
      h1.stream().drop();
      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.frames.length = 0;
      h2.stream().message(liveTrade(200, tA + 1, SIZE, false));
      await vi.advanceTimersByTimeAsync(0);
      expect(String(h2.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${tA}`);
      // Until REST answers, the two spans are two stretches: nothing is
      // complete across them, nor at their boundary milliseconds, where the
      // fills after trade 100 and before trade 200 are still unread.
      expect(await askHistory(h2, historyRequest(1, tA, tA + 2, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(2, tA, tA + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      release!();
      await settle();
      const snapshot = h2.parsed().find((frame) => frame.type === "snapshot");
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const ids = snapshot.aggressive_prints!.map((print) => print.trade_id);
      expect(ids).toEqual(expect.arrayContaining(["a1", "a2", "100", "200"]));
      expect(ids).not.toContain("a3");
      expect(snapshot.aggressive_prints_from).toBe(tA);
      expect(await askHistory(h2, historyRequest(3, tA, tA + 2, 1))).toMatchObject({ complete: true });
      h2.stream().drop();

      // The same millisecond: the next stream starts at tA+1 again with trade
      // 400 while this one ended there with 200. The ids read so far end just
      // before the row the lost stream owned (its own trade 200), so the seam
      // is read from that id: that row is the stream's, one aggregate between
      // the spans is whole, one straddles the ended span, one is the new
      // stream's.
      const sameMs = [aggRow(3, tA + 1, 200, 200), aggRow(4, tA + 1, 201, 300), aggRow(5, tA + 1, 195, 205), aggRow(6, tA + 1, 400, 400), aggRow(7, tA + 900, 500, 500)];
      release = null;
      const h3 = harness((url) => {
        if (!url.includes("fromId") && !url.includes("startTime")) return Promise.resolve(jsonResponse([]));
        return Promise.resolve(jsonResponse(mirrorPage(url, sameMs)));
      }, h2.now);
      await openAndSelect(h3);
      await settle();
      h3.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h3.frames.length = 0;
      h3.stream().message(liveTrade(400, tA + 1, SIZE, false));
      h3.stream().message(liveTrade(401, tA + 800, SIZE, false));
      await settle();
      expect(String(h3.aggTradesMock.mock.calls.at(-1)![0])).toContain("fromId=3");
      const after = h3.parsed().find((frame) => frame.type === "snapshot");
      if (after === undefined || after.type !== "snapshot") throw new Error("expected a snapshot");
      const afterIds = after.aggressive_prints!.map((print) => print.trade_id);
      expect(afterIds).not.toContain("a3");
      expect(afterIds).toContain("a4");
      expect(afterIds).not.toContain("a5");
      expect(afterIds).not.toContain("a6");
      expect(h3.transport.tapeCoverage.unverified).toBe(1);
      // tA+1 holds a fill nobody can place: complete up to it and after it, never across it.
      expect(after.aggressive_prints_from).toBe(tA + 2);
      expect(await askHistory(h3, historyRequest(4, tA, tA + 1, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h3, historyRequest(5, tA, tA + 2, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h3, historyRequest(6, tA + 2, tA + 801, 1))).toMatchObject({ complete: true });
      h3.stream().drop();

      // Consecutive ids: the next stream's first trade is the one after this stream's last; no REST read, one stretch.
      const h4 = reconnected(h3);
      await openAndSelect(h4);
      await settle();
      h4.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      const reads = h4.aggTradesMock.mock.calls.length;
      h4.stream().message(liveTrade(402, tA + 801, SIZE, false));
      await settle();
      expect(h4.aggTradesMock.mock.calls.length).toBe(reads);
      expect(await askHistory(h4, historyRequest(7, tA + 2, tA + 802, 1))).toMatchObject({ complete: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("claims nothing at the millisecond two coincident spans share until the REST read between them lands, then everything", async () => {
    const tA = NOW_MS - 10_000;
    // Span A: trades 100 at tA-500 and 101 at tA; span B: 300 at tA and 301 at tA+500. The mirror holds fills 102..299 at tA.
    const rows = [aggRow(1, tA, 102, 200), aggRow(2, tA, 201, 299), aggRow(3, tA, 300, 300), aggRow(4, tA + 900, 500, 500)];
    let release: (() => void) | null = null;
    const h1 = harness((url) => {
      if (!url.includes("startTime")) return Promise.resolve(jsonResponse([]));
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(mirrorPage(url, rows)));
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settle();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h1.stream().message(liveTrade(100, tA - 500, SIZE, false));
      h1.stream().message(liveTrade(101, tA, SIZE, false));
      h1.stream().drop();
      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.frames.length = 0;
      h2.stream().message(liveTrade(300, tA, SIZE, false));
      h2.stream().message(liveTrade(301, tA + 500, SIZE, false));
      await vi.advanceTimersByTimeAsync(0);
      expect(String(h2.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${tA}`);
      // Pending: each span is complete away from the shared millisecond, nothing at or across it.
      expect(await askHistory(h2, historyRequest(1, tA - 500, tA, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(2, tA + 1, tA + 501, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(3, tA, tA + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(4, tA - 500, tA + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(5, tA - 500, tA + 501, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(h2.transport.tapeCoverage.unverified).toBe(0);
      release!();
      await settle();
      const snapshot = h2.parsed().find((frame) => frame.type === "snapshot");
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const ids = snapshot.aggressive_prints!.map((print) => print.trade_id);
      expect(ids).toEqual(expect.arrayContaining(["a1", "a2", "100", "101", "300", "301"]));
      expect(ids).not.toContain("a3");
      expect(snapshot.aggressive_prints_from).toBe(tA - 500);
      expect(await askHistory(h2, historyRequest(6, tA - 500, tA + 501, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(7, tA, tA + 1, 1))).toMatchObject({ complete: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the shared millisecond of two coincident spans outside every claim for good when the REST read between them fails", async () => {
    const tA = NOW_MS - 10_000;
    let seamReads = 0;
    const h1 = harness(async (url) => {
      if (!url.includes("startTime")) return jsonResponse([]);
      seamReads += 1;
      throw new Error("network");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h1);
      await settle();
      h1.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h1.stream().message(liveTrade(100, tA - 500, SIZE, false));
      h1.stream().message(liveTrade(101, tA, SIZE, false));
      h1.stream().drop();
      const h2 = reconnected(h1);
      await openAndSelect(h2);
      await settle();
      h2.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h2.stream().message(liveTrade(300, tA, SIZE, false));
      h2.stream().message(liveTrade(301, tA + 500, SIZE, false));
      // While the retries run, the millisecond stays pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(await askHistory(h2, historyRequest(1, tA, tA + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(h2.transport.tapeCoverage.unverified).toBe(0);
      let delay = STREAM_BACKOFF_INITIAL_MS;
      for (let failure = 1; failure < SEAM_FILL_FAILURES_BEFORE_GIVING_UP; failure += 1) {
        await settle();
        await vi.advanceTimersByTimeAsync(delay);
        delay *= 2;
      }
      await settle();
      expect(seamReads).toBe(SEAM_FILL_FAILURES_BEFORE_GIVING_UP);
      // Given up: the millisecond is unverified for good, each span complete away from it, nothing across.
      expect(h2.transport.tapeCoverage.unverified).toBe(1);
      expect(h2.transport.tapeCoverage.unfillable).toBe(1);
      expect(await askHistory(h2, historyRequest(2, tA, tA + 1, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      expect(await askHistory(h2, historyRequest(3, tA - 500, tA, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(4, tA + 1, tA + 501, 1))).toMatchObject({ complete: true });
      expect(await askHistory(h2, historyRequest(5, tA - 500, tA + 501, 1))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      // Nothing re-reads it.
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_CAP_MS);
      expect(seamReads).toBe(SEAM_FILL_FAILURES_BEFORE_GIVING_UP);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the bootstrap again when the pair was left during the commit grace, instead of remembering staged pages as done", async () => {
    const h = harness();
    await openAndSelect(h);
    await settle();
    expect(h.aggTradesMock).toHaveBeenCalledTimes(11);
    expect(h.transport.tapeCoverage.staged).toBe(10);
    // Away to another pair during the grace, and back.
    h.transport.send(JSON.stringify({ ...SPOT, symbol: "ETH-USDT" }));
    await settleBootstrap();
    const ethReads = h.aggTradesMock.mock.calls.length - 11;
    expect(ethReads).toBeGreaterThan(0);
    h.frames.length = 0;
    h.transport.send(JSON.stringify(SPOT));
    await settleBootstrap();
    expect(h.aggTradesMock.mock.calls.length).toBe(11 + ethReads + 11);
    const frames = h.parsed();
    const snapshot = frames.filter((frame) => frame.type === "snapshot").at(-1);
    if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.symbol).toBe("BTC-USDT");
    expect(snapshot.markers).toEqual(runtimeMarkers(recorded));
    expect(h.transport.tapeCoverage.staged).toBe(0);
  });

  it("does not claim the oldest millisecond of a walk its page budget cut through aggregates sharing a timestamp", async () => {
    // 31,000 aggregates; the budget reads the newest 30,000, whose oldest
    // row shares its millisecond with the two rows just outside the budget.
    const total = 31_000;
    const first = 7_000_000;
    const cut = total - MAX_TAPE_BOOTSTRAP_PAGES * TAPE_BOOTSTRAP_PAGE;
    const sharedTs = NOW_MS - 20_000 - (total - cut) * 10;
    const rows: TradeFrame[] = [];
    for (let i = 0; i < total; i += 1) {
      const ts = i >= cut - 2 && i <= cut + 1 ? sharedTs : NOW_MS - 20_000 - (total - i) * 10;
      rows.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: ts, price: 79_500, size: 0.25 + (i % 100) * 0.01, side: "buy", trade_id: `a${first + i}` });
    }
    const h = harness(async (url) => jsonResponse(recordedPage(url, rows)));
    await openAndSelect(h);
    await settleBootstrap();
    expect(h.aggTradesMock).toHaveBeenCalledTimes(MAX_TAPE_BOOTSTRAP_PAGES);
    const snapshot = h.parsed()[5];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    const floor = snapshot.aggressive_prints_floor!;
    const newest = rows[total - 1].ts_exchange;
    expect(await askHistory(h, historyRequest(1, sharedTs + 1, newest + 1, floor))).toMatchObject({ complete: true });
    expect(await askHistory(h, historyRequest(2, sharedTs, newest + 1, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
  });

  it("claims the oldest millisecond when the walk reached the exchange's first aggregate trade", async () => {
    const h = harness();
    await openAndSelect(h);
    await settleBootstrap();
    // The page below the recording is empty: nothing older exists.
    expect(h.aggTradesMock).toHaveBeenCalledTimes(11);
    const snapshot = h.parsed()[5];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(await askHistory(h, historyRequest(1, OLDEST_TS, NEWEST_TS + 1, snapshot.aggressive_prints_floor!))).toMatchObject({ complete: true });
  });

  it("answers a window reaching into the future, or past the last trade seen, as unavailable", async () => {
    const h = harness(async () => jsonResponse([]));
    await openAndSelect(h);
    await settle();
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    const t1 = NOW_MS - 10_000;
    const t2 = NOW_MS - 2_000;
    h.stream().message(liveTrade(1, t1, SIZE, false));
    h.stream().message(liveTrade(2, t2, SIZE, true));
    expect(await askHistory(h, historyRequest(1, t1, t2 + 1, 0))).toMatchObject({ complete: true });
    expect(await askHistory(h, historyRequest(2, t1, t2 + 2, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    expect(await askHistory(h, historyRequest(3, t1, NOW_MS, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    expect(await askHistory(h, historyRequest(4, t1, NOW_MS + 30_000, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    // Beyond the request skew the runtime drops the request; so does this.
    expect(await askHistory(h, historyRequest(5, t1, NOW_MS + 90_000, 0))).toBeNull();
  });
});

describe("BrowserBinanceTransport page integrity", () => {
  it("refuses a page with a malformed row, a gap in its ids, more rows than asked or a wrong start", () => {
    const good = recorded.slice(0, 5).map(aggTradeRow);
    expect(parseAggTradesPage(good, FIRST_ID)).toHaveLength(5);
    expect(() => parseAggTradesPage([...good.slice(0, 2), { ...good[2], q: "x" }, ...good.slice(3)], null)).toThrow("malformed row");
    expect(() => parseAggTradesPage([...good.slice(0, 2), ...good.slice(3)], null)).toThrow("id-contiguous");
    expect(() => parseAggTradesPage(good, FIRST_ID + 1)).toThrow("fromId");
    expect(() => parseAggTradesPage(new Array(TAPE_BOOTSTRAP_PAGE + 1).fill(good[0]), null)).toThrow("more rows");
    expect(() => parseAggTradesPage("nope", null)).toThrow("not an array");
  });

  it("treats a full page with one malformed row as a failed read: retried, never a shorter page that ends the walk with a hole inside claimed coverage", async () => {
    let calls = 0;
    const h = harness(async (url) => {
      calls += 1;
      const page = recordedPage(url);
      if (calls === 1) page[500] = { ...page[500], p: "not-a-price" };
      return jsonResponse(page);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await settle();
      // The first attempt failed on its first page: nothing published, nothing claimed.
      expect(h.aggTradesMock).toHaveBeenCalledTimes(1);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
      expect(await askHistory(h, historyRequest(1, OLDEST_TS, NEWEST_TS + 1, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      // The retry reads the same page whole.
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      await settleBootstrap();
      expect(h.aggTradesMock).toHaveBeenCalledTimes(12);
      const snapshot = h.parsed().find((frame) => frame.type === "snapshot" && frame.markers.length > 0);
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.markers).toEqual(runtimeMarkers(recorded));
      expect(await askHistory(h, historyRequest(2, OLDEST_TS, NEWEST_TS + 1, snapshot.aggressive_prints_floor!))).toMatchObject({ complete: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("ends the walk at a later malformed page and claims only the pages validated before it", async () => {
    let calls = 0;
    const h = harness(async (url) => {
      calls += 1;
      const page = recordedPage(url);
      if (calls === 2) page.splice(10, 1);
      return jsonResponse(page);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await settleBootstrap();
      expect(h.aggTradesMock).toHaveBeenCalledTimes(2);
      const snapshot = h.parsed()[5];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const read = recorded.slice(-1_000);
      expect(snapshot.markers).toEqual(runtimeMarkers(read));
      const floor = snapshot.aggressive_prints_floor!;
      expect(await askHistory(h, historyRequest(1, read[0].ts_exchange + 1, NEWEST_TS + 1, floor))).toMatchObject({ complete: true });
      // The page with the missing row is not coverage: a window reaching into it is unavailable.
      expect(await askHistory(h, historyRequest(2, recorded[8_500].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    } finally {
      warn.mockRestore();
    }
  });
});
