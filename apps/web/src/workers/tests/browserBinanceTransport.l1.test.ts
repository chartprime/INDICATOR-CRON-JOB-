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
  STREAM_BACKOFF_INITIAL_MS,
  TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED,
  TAPE_BOOTSTRAP_PAGE,
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

/** Serves the recorded tape as the mirror would: the newest page without fromId, else the 1,000 ids from fromId. */
function recordedPage(url: string, rows: readonly TradeFrame[] = recorded): Record<string, unknown>[] {
  const fromId = new URL(url).searchParams.get("fromId");
  const first = Number(rows[0].trade_id.slice(1));
  const last = Number(rows[rows.length - 1].trade_id.slice(1));
  const start = fromId === null ? Math.max(first, last - TAPE_BOOTSTRAP_PAGE + 1) : Number(fromId);
  return rows.filter((trade) => {
    const id = Number(trade.trade_id.slice(1));
    return id >= start && id < start + TAPE_BOOTSTRAP_PAGE;
  }).map(aggTradeRow);
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

    expect(snapshot.aggressive_prints_from).toBe(OLDEST_TS);
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
      expect(snapshot.aggressive_prints_from).toBe(read[0].ts_exchange);
      expect(snapshot.markers).toEqual(runtimeMarkers(read));
      expect(frames.filter((frame) => frame.type === "health")).toHaveLength(1);
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

      // The next retry succeeds: the snapshot goes out and READY is plain again.
      failing = false;
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["snapshot", "bar", "marker_history", "health"]);
      expect(frames[3]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
      const snapshot = frames[0];
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.trades).toHaveLength(1);
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
    return { h, floor: snapshot.aggressive_prints_floor!, from: snapshot.aggressive_prints_from!, prints: snapshot.aggressive_prints! };
  }

  it("answers a window the pool covers at its floor completely, in time order", async () => {
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

  it("is honestly STORAGE_UNAVAILABLE before the bootstrap, before the coverage starts, or below the floor", async () => {
    const early = harness(() => new Promise<Response>(() => {}));
    await openAndSelect(early);
    early.frames.length = 0;
    early.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 1, from_ts: OLDEST_TS, to_ts: NOW_MS, min_size: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(early.parsed()[0]).toMatchObject({ type: "aggressive_history", request_id: 1, complete: false, reason: "STORAGE_UNAVAILABLE", next_cursor: null, trades: [] });

    const { h, floor, from } = await bootstrapped();
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 5, from_ts: from - 1, to_ts: NOW_MS, min_size: floor }));
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 6, from_ts: from, to_ts: NOW_MS, min_size: floor / 2 }));
    // Malformed or stale requests get no reply at all, as the runtime drops them.
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 7, from_ts: from, to_ts: NOW_MS + 120_000, min_size: floor }));
    h.transport.send(JSON.stringify({ type: "aggressive_history", request_id: 8, from_ts: from, to_ts: NOW_MS, min_size: floor, cursor: "bm90LWEtY3Vyc29y" }));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => (frame as { request_id: number }).request_id)).toEqual([5, 6]);
    expect(frames[0]).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
    expect(frames[1]).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });
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
    const from = snapshot.aggressive_prints_from!;
    const request = { type: "aggressive_history", request_id: 20, from_ts: from, to_ts: NOW_MS, min_size: 0.25 };
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
