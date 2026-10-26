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
  BrowserBinanceTransport,
  DEFAULT_ENDPOINTS,
  HEALTH_REASON_NO_TAPE_HISTORY,
  HEALTH_REASON_READY,
  MAX_AGGRESSIVE_HISTORY_TRADES,
  MAX_SNAPSHOT_MARKERS,
  SEAM_FILL_FAILURES_BEFORE_GIVING_UP,
  STREAM_BACKOFF_INITIAL_MS,
  TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED,
  TAPE_BOOTSTRAP_PAGE,
  parseAggTradesPage,
  type UpstreamSocket,
} from "../browserBinanceTransport";
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
};

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
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserBinanceTransport tape bootstrap", () => {
  it("pages recent aggregate trades from the mirror and re-broadcasts a snapshot whose markers and pool pass the parser and equal the runtime's", async () => {
    const h = harness();
    await openAndSelect(h);
    await settle();
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
    await settle();
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
      await settle();
      expect(h.aggTradesMock).toHaveBeenCalledTimes(3);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar", "snapshot", "bar", "marker_history"]);
      const snapshot = frames[5];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const read = recorded.slice(-2_000);
      expect(snapshot.markers).toEqual(runtimeMarkers(read));
      expect(frames.filter((frame) => frame.type === "health")).toHaveLength(1);
      // Coverage is the two pages read, not the page that failed.
      const floor = snapshot.aggressive_prints_floor!;
      expect(await askHistory(h, historyRequest(1, read[0].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: true, reason: null });
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
      expect(String(h.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${NEWEST_TS + 1}`);
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
    await settle();
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
    await settle();
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
      if (!url.includes("startTime")) return Promise.resolve(jsonResponse(recordedPage(url, recorded)));
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(recordedPage(url, tape)));
      });
    });
    await openAndSelect(h);
    await settle();
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
    h.stream().message(liveTrade(9_000_000_001, liveFrom, SEAM_SIZE, false));
    await vi.advanceTimersByTimeAsync(0);
    expect(String(h.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${NEWEST_TS + 1}`);
    // Until the fill lands, the hole between the newest page and the first
    // live trade is inside no claim (the live print's size has moved the
    // floor, so these ask well above it).
    const aboveFloor = 1;
    expect(await askHistory(h, historyRequest(3, OLDEST_TS, liveFrom + 1_000, aboveFloor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    expect(await askHistory(h, historyRequest(4, liveFrom, liveFrom + 1_000, aboveFloor))).toMatchObject({ complete: true });
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
    expect(ids).toContain("9000000001");
    const whole = await askHistory(h, historyRequest(5, OLDEST_TS, liveFrom + 1_000, aboveFloor));
    expect(whole).toMatchObject({ complete: true, reason: null });
    expect(whole!.trades.map((trade) => trade.trade_id).slice(-3)).toEqual([`a${LAST_ID + 1}`, `a${LAST_ID + 2}`, "9000000001"]);
  });

  it("keeps a reconnect hole outside every claim when the seam cannot be read, and closes it when it can", async () => {
    let seamReads = 0;
    let seamFails = true;
    const holeRows: TradeFrame[] = [];
    const h = harness(async (url) => {
      if (!url.includes("startTime")) return jsonResponse([]);
      seamReads += 1;
      if (seamFails) throw new Error("network");
      return jsonResponse(recordedPage(url, holeRows));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await settle();
      h.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      h.frames.length = 0;
      const t1 = NOW_MS - 60_000;
      const t2 = NOW_MS - 50_000;
      h.stream().message(liveTrade(1, t1, SEAM_SIZE, false));
      h.stream().message(liveTrade(2, t2, SEAM_SIZE, true));
      expect(await askHistory(h, historyRequest(1, t1, t2 + 1, 0))).toMatchObject({ complete: true });
      h.stream().drop();
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      h.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      // The closed span is observed up to its last trade only.
      expect(await askHistory(h, historyRequest(2, t1, t2 + 1, 0))).toMatchObject({ complete: true });
      expect(await askHistory(h, historyRequest(3, t1, t2 + 2, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
      const t3 = NOW_MS - 20_000;
      h.stream().message(liveTrade(3, t3, SEAM_SIZE, false));
      // Three failed seam reads with backoff: the hole stays open, every claim stops at it.
      let delay = STREAM_BACKOFF_INITIAL_MS;
      for (let failure = 1; failure < SEAM_FILL_FAILURES_BEFORE_GIVING_UP; failure += 1) {
        await settle();
        await vi.advanceTimersByTimeAsync(delay);
        delay *= 2;
      }
      await settle();
      expect(seamReads).toBe(SEAM_FILL_FAILURES_BEFORE_GIVING_UP);
      expect(await askHistory(h, historyRequest(4, t1, t3 + 1, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
      expect(await askHistory(h, historyRequest(5, t3, t3 + 1, 0))).toMatchObject({ complete: true });
      expect(await askHistory(h, historyRequest(6, t1, t2 + 1, 0))).toMatchObject({ complete: true });
      expect(h.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(0);

      // A second disconnect whose seam can be read: the mirror holds one print inside the hole.
      h.stream().drop();
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      h.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      const t4 = NOW_MS - 5_000;
      holeRows.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: t3 + 7_000, price: 79_530, size: 5, side: "sell", trade_id: "a77" });
      holeRows.push({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: t4 + 100, price: 79_530, size: 5, side: "sell", trade_id: "a78" });
      seamFails = false;
      h.frames.length = 0;
      h.stream().message(liveTrade(4, t4, SEAM_SIZE, false));
      await settle();
      expect(String(h.aggTradesMock.mock.calls.at(-1)![0])).toContain(`startTime=${t3 + 1}`);
      // The first hole was given up and is not re-read; the second is closed and the snapshot says so.
      const snapshot = h.parsed().find((frame) => frame.type === "snapshot");
      if (snapshot === undefined || snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.aggressive_prints_from).toBe(t3);
      expect(snapshot.aggressive_prints!.map((print) => print.trade_id)).toContain("a77");
      expect(snapshot.aggressive_prints!.map((print) => print.trade_id)).not.toContain("a78");
      expect(await askHistory(h, historyRequest(7, t3, t4 + 1, 0))).toMatchObject({ complete: true });
      expect(await askHistory(h, historyRequest(8, t1, t4 + 1, 0))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE" });
    } finally {
      warn.mockRestore();
    }
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
      await settle();
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
      await settle();
      expect(h.aggTradesMock).toHaveBeenCalledTimes(2);
      const snapshot = h.parsed()[5];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const read = recorded.slice(-1_000);
      expect(snapshot.markers).toEqual(runtimeMarkers(read));
      const floor = snapshot.aggressive_prints_floor!;
      expect(await askHistory(h, historyRequest(1, read[0].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: true });
      // The page with the missing row is not coverage: a window reaching into it is unavailable.
      expect(await askHistory(h, historyRequest(2, recorded[8_500].ts_exchange, NEWEST_TS + 1, floor))).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    } finally {
      warn.mockRestore();
    }
  });
});
