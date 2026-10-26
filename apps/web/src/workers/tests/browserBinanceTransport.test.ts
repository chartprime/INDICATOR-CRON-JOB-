import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK_REASON_STREAM_CONNECTING,
  BrowserBinanceTransport,
  DEFAULT_ENDPOINTS,
  HEALTH_REASON_NO_DXFEED,
  HEALTH_REASON_PERPETUAL_UNREACHABLE,
  HEALTH_REASON_READY,
  HEALTH_REASON_REST_FAILED,
  HEALTH_REASON_STREAM_CLOSED,
  HEALTH_REASON_STREAM_UNAVAILABLE,
  STREAM_BACKOFF_CAP_MS,
  STREAM_BACKOFF_INITIAL_MS,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_FAILURES_BEFORE_UNAVAILABLE,
  resolveDataSource,
  type UpstreamSocket,
} from "../browserBinanceTransport";
import { parseServerFrame, type ServerFrame } from "../../types/frames";
import klineRows from "./fixtures/binance-mirror/klines.json";
import tradeEvents from "./fixtures/binance-mirror/trades.json";
import depthEvent from "./fixtures/binance-mirror/depth20.json";
import klineEvents from "./fixtures/binance-mirror/kline-events.json";

// The fixtures sit in the minute that opens at 1761400140000; "now" is inside
// that minute, so the first two REST rows are closed and the third is forming.
const NOW_MS = 1_761_400_150_000;
const SPOT = { type: "select", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" };

class FakeUpstreamSocket implements UpstreamSocket {
  static instances: FakeUpstreamSocket[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeUpstreamSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
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
  fetchMock: ReturnType<typeof vi.fn>;
  stream: () => FakeUpstreamSocket;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness(fetchImpl?: (url: string) => Promise<Response>, nowMs = NOW_MS): Harness {
  FakeUpstreamSocket.instances = [];
  const fetchMock = vi.fn(fetchImpl ?? (async () => jsonResponse(klineRows)));
  const transport = new BrowserBinanceTransport("ws://127.0.0.1:8000/ws", {
    fetch: fetchMock as unknown as typeof fetch,
    WebSocket: FakeUpstreamSocket,
    now: () => nowMs,
  });
  const frames: Record<string, unknown>[] = [];
  transport.onmessage = (event) => {
    expect(typeof event.data).toBe("string");
    frames.push(JSON.parse(event.data as string) as Record<string, unknown>);
  };
  return {
    transport,
    frames,
    parsed: () => frames.map((frame) => {
      const parsed = parseServerFrame(frame, { nowMs: NOW_MS });
      if (parsed === null) throw new Error(`frame rejected by parseServerFrame: ${JSON.stringify(frame)}`);
      return parsed;
    }),
    fetchMock,
    stream: () => FakeUpstreamSocket.instances.at(-1)!,
  };
}

// As the worker does: capabilities and the selection go out synchronously
// inside onopen, so the transport never falls back to its default pair.
async function openAndSelect(h: Harness, select: Record<string, unknown> = SPOT): Promise<void> {
  const opened = vi.fn(() => {
    h.transport.send(JSON.stringify({ type: "capabilities", marker_history: true }));
    h.transport.send(JSON.stringify(select));
  });
  h.transport.onopen = opened;
  await vi.advanceTimersByTimeAsync(0);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(h.transport.readyState).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserBinanceTransport", () => {
  it("answers a spot selection with selection, snapshot, health READY, book, forming bar, in that order, every frame passing the parser", async () => {
    const h = harness();
    await openAndSelect(h);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(String(h.fetchMock.mock.calls[0]![0])).toBe(`${DEFAULT_ENDPOINTS.spotRestBase}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=901`);

    const snapshot = frames[1];
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", trades: [], markers: [], vpin_status: "DISABLED" });
    expect(snapshot.bars.map((bar) => bar.ts_open)).toEqual([1_761_400_020_000, 1_761_400_080_000]);
    expect(snapshot.bars.every((bar) => bar.closed === true && bar.reconstructed === true && bar.interval_ms === 60_000)).toBe(true);
    expect(snapshot.bars[0]).toMatchObject({ open: 65000, high: 65050, low: 64980, close: 65020.5, volume: 12.345, buy_volume: 7.1, trade_count: 321 });
    expect(snapshot.bars[0]).not.toHaveProperty("sell_volume");

    expect(frames[2]).toEqual({ type: "health", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", recoveryState: "READY", stale: false, reason: HEALTH_REASON_READY });
    expect(frames[3]).toEqual({ type: "book", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", status: "UNAVAILABLE", reason: BOOK_REASON_STREAM_CONNECTING });
    expect(frames[4]).toMatchObject({ type: "bar", ts_open: 1_761_400_140_000, closed: false, close: 65095, trade_count: 40, buy_volume: 0.7 });
    expect(frames[4]).not.toHaveProperty("reconstructed");

    expect(FakeUpstreamSocket.instances).toHaveLength(1);
    expect(h.stream().url).toBe(`${DEFAULT_ENDPOINTS.spotStreamBase}/stream?streams=btcusdt@kline_1m/btcusdt@trade/btcusdt@depth20@100ms`);
  });

  it("forwards kline events as forming then closed bars, trades with the side from the maker flag, and depth20 as a READY book", async () => {
    const h = harness();
    await openAndSelect(h);
    h.stream().open();
    h.frames.length = 0;
    h.stream().message(klineEvents.forming);
    for (const trade of tradeEvents) h.stream().message(trade);
    h.stream().message(depthEvent);
    h.stream().message(klineEvents.closed);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "trade", "trade", "trade", "book", "bar"]);

    expect(frames[0]).toMatchObject({ type: "bar", ts_open: 1_761_400_140_000, closed: false, open: 65080, high: 65100, low: 65070, close: 65091, volume: 1.469, buy_volume: 0.719, trade_count: 43 });
    expect(frames[5]).toMatchObject({ type: "bar", ts_open: 1_761_400_140_000, closed: true, close: 65088, volume: 9.8, buy_volume: 5.1, trade_count: 160 });
    expect(frames[5]).not.toHaveProperty("reconstructed");

    expect(frames[1]).toEqual({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: 1_761_400_150_005, price: 65090, size: 0.015, side: "buy", trade_id: "5100000001" });
    expect(frames[2]).toMatchObject({ side: "sell", trade_id: "5100000002", size: 0.25 });
    expect(frames[3]).toMatchObject({ side: "buy", trade_id: "5100000003" });

    expect(frames[4]).toEqual({
      type: "book", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", status: "READY", lastUpdateId: 77_123_456_789, stale: false,
      bids: [{ price: 65090, size: 0.52 }, { price: 65089.9, size: 1.1 }, { price: 65089, size: 3.25 }],
      asks: [{ price: 65090.1, size: 0.3 }, { price: 65090.5, size: 2 }, { price: 65091, size: 0.75 }],
    });
  });

  it("does not repeat a closed bar the snapshot already carried", async () => {
    const h = harness();
    await openAndSelect(h);
    h.stream().open();
    h.frames.length = 0;
    const stale = JSON.parse(JSON.stringify(klineEvents.closed)) as typeof klineEvents.closed;
    stale.data.k.t = 1_761_400_080_000;
    stale.data.k.T = 1_761_400_139_999;
    h.stream().message(stale);
    expect(h.frames).toHaveLength(0);
  });

  it("answers requests it cannot serve with the contract's unavailable reply and ignores the ones without one", async () => {
    const h = harness();
    await openAndSelect(h);
    h.frames.length = 0;
    const requests = [
      { type: "aggressive_history", request_id: 7, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, min_size: 0.5 },
      { type: "delta_profile", request_id: 9, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, row_width: 1 },
      { type: "band_history", request_id: 12, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, price_lo: 64000, price_hi: 64040, column_ms: 10_000 },
      { type: "wall_history", request_id: 13, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, price_lo: 64000, price_hi: 64040 },
      { type: "l2_event_history", request_id: 14, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, price_lo: 64000, price_hi: 64040 },
      { type: "profile_config", mode: "continuous", period_ms: 86_400_000, bin_size_multiplier: null, range_start_ts: null, range_end_ts: null },
      { type: "liquidity_resync" },
      { type: "l2_resync", channel: "l2_walls" },
      { type: "exhaustion_history", from_ts: 1_761_390_000_000 },
      { type: "initiative_history", from_ts: 1_761_390_000_000 },
    ];
    for (const request of requests) h.transport.send(JSON.stringify(request));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["aggressive_history", "delta_profile", "band_history", "wall_history", "l2_event_history", "analytics_status"]);
    expect(frames[0]).toMatchObject({ request_id: 7, from_ts: 1_761_390_000_000, to_ts: 1_761_400_000_000, min_size: 0.5, complete: false, reason: "STORAGE_UNAVAILABLE", next_cursor: null, retry_after_ms: null, trades: [] });
    expect(frames[1]).toMatchObject({ request_id: 9, row_width: 1, complete: false, reason: "STORAGE_UNAVAILABLE", pending: 0, rows: [] });
    expect(frames[2]).toMatchObject({ request_id: 12, complete: false, reason: "GEOMETRY_UNAVAILABLE", row_width: null, row_lo: null, row_hi: null, columns: [] });
    expect(frames[3]).toMatchObject({ request_id: 13, complete: false, reason: "HISTORY_UNAVAILABLE", row_width: null, walls: [], next: null });
    expect(frames[4]).toMatchObject({ request_id: 14, complete: false, reason: "HISTORY_UNAVAILABLE", trades: [], wall_trades: [], trades_held_from: null, next: null });
    expect(frames[5]).toEqual({ type: "analytics_status", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", indicator: "PROFILE", status: "UNAVAILABLE" });
  });

  it("reports a dropped stream as RECOVERING, reconnects with backoff, turns UNAVAILABLE after repeated failures and READY again once the stream is back", async () => {
    const h = harness();
    await openAndSelect(h);
    h.stream().open();
    h.frames.length = 0;
    let delay = STREAM_BACKOFF_INITIAL_MS;
    for (let failure = 1; failure <= STREAM_FAILURES_BEFORE_UNAVAILABLE; failure += 1) {
      const sockets = FakeUpstreamSocket.instances.length;
      h.stream().drop();
      const health = h.parsed().at(-1);
      expect(health).toMatchObject(
        failure < STREAM_FAILURES_BEFORE_UNAVAILABLE
          ? { type: "health", recoveryState: "RECOVERING", stale: true, reason: HEALTH_REASON_STREAM_CLOSED }
          : { type: "health", recoveryState: "UNAVAILABLE", stale: true, reason: HEALTH_REASON_STREAM_UNAVAILABLE },
      );
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeUpstreamSocket.instances).toHaveLength(sockets);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeUpstreamSocket.instances).toHaveLength(sockets + 1);
      delay = Math.min(delay * 2, STREAM_BACKOFF_CAP_MS);
    }
    h.frames.length = 0;
    h.fetchMock.mockResolvedValueOnce(jsonResponse([klineRows[1], klineRows[2]]));
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    // The gap fill re-reads from the last closed bar on; nothing newer closed, so only health follows.
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(String(h.fetchMock.mock.calls[1]![0])).toContain("startTime=1761400140000");
    expect(frames.map((frame) => frame.type)).toEqual(["health"]);
    expect(frames[0]).toMatchObject({ recoveryState: "READY", stale: false, reason: HEALTH_REASON_READY });
  });

  it("gives up on a stream that never opens, reports RECOVERING and tries again, so a swallowed upgrade cannot leave the book connecting forever", async () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      h.frames.length = 0;
      await vi.advanceTimersByTimeAsync(STREAM_CONNECT_TIMEOUT_MS - 1);
      expect(h.frames).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.stream().closed).toBe(true);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", stale: true, reason: HEALTH_REASON_STREAM_CLOSED });
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(FakeUpstreamSocket.instances).toHaveLength(2);
      h.frames.length = 0;
      h.stream().open();
      await vi.advanceTimersByTimeAsync(STREAM_CONNECT_TIMEOUT_MS);
      expect(h.stream().closed).toBe(false);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
    } finally {
      warn.mockRestore();
    }
  });

  it("fills the closed bars a dropped stream missed from REST, marked reconstructed, before saying READY", async () => {
    const gapRow = [1_761_400_080_000, "65020.50", "65090.00", "65010.00", "65080.00", "8.500", 1_761_400_139_999, "0", 210, "4.250", "0", "0"];
    const h = harness(async (url) => jsonResponse(url.includes("startTime") ? [gapRow] : [klineRows[0]]));
    await openAndSelect(h);
    h.stream().open();
    h.stream().drop();
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(String(h.fetchMock.mock.calls[1]![0])).toContain("startTime=1761400080000");
    const filled = h.parsed();
    expect(filled.map((frame) => frame.type)).toEqual(["bar", "health"]);
    expect(filled[0]).toMatchObject({ ts_open: 1_761_400_080_000, closed: true, reconstructed: true, buy_volume: 4.25 });
    expect(filled[1]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
  });

  // A later clock for the reconnect cases: minutes A (…020000) to D (…200000)
  // have closed, E (…260000) is forming.
  const LATER_NOW_MS = 1_761_400_270_000;
  const klineRow = (openTime: number, close: string) => [openTime, "65000.00", "65100.00", "64900.00", close, "5.000", openTime + 59_999, "0", 50, "2.000", "0", "0"];
  const klineEvent = (openTime: number, closed: boolean, close: string) => ({
    stream: "btcusdt@kline_1m",
    data: { e: "kline", E: openTime + (closed ? 60_010 : 10_000), s: "BTCUSDT", k: { t: openTime, T: openTime + 59_999, s: "BTCUSDT", i: "1m", o: "65000.00", c: close, h: "65500.00", l: "64900.00", v: "5.000", n: 50, x: closed, q: "0", V: "2.000", Q: "0", B: "0" } },
  });
  const A = 1_761_400_020_000, B = 1_761_400_080_000, C = 1_761_400_140_000, D = 1_761_400_200_000, E = 1_761_400_260_000;

  type Deferred = { resolve: (response: Response) => void; reject: (error: Error) => void };
  function reconnectHarness(): { h: Harness; pending: () => Deferred } {
    const deferred: Deferred[] = [];
    const h = harness((url) => {
      if (!url.includes("startTime")) return Promise.resolve(jsonResponse([klineRow(A, "65010.00")]));
      return new Promise<Response>((resolve, reject) => deferred.push({ resolve, reject }));
    }, LATER_NOW_MS);
    return { h, pending: () => deferred.at(-1)! };
  }

  async function dropAndReopen(h: Harness): Promise<void> {
    h.stream().drop();
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("delivers the closed bars a reconnect missed in order, even when the live stream closes a later bar before the REST answer lands", async () => {
    const { h, pending } = reconnectHarness();
    await openAndSelect(h);
    expect(h.frames.filter((frame) => frame.type === "bar")).toHaveLength(0);
    h.stream().open();
    await dropAndReopen(h);
    expect(String(h.fetchMock.mock.calls[1]![0])).toContain(`startTime=${B}`);
    // B and C are missing; the new stream reports D forming, then closed, before REST answers.
    h.stream().message(klineEvent(D, false, "65300.00"));
    h.stream().message(klineEvent(D, true, "65310.00"));
    h.stream().message(tradeEvents[0]);
    expect(h.frames.map((frame) => frame.type)).toEqual(["trade"]);
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00")]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["trade", "bar", "bar", "bar", "health"]);
    expect(frames.slice(1, 4).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
    expect(frames[1]).toMatchObject({ closed: true, reconstructed: true, close: 65020 });
    expect(frames[2]).toMatchObject({ closed: true, reconstructed: true, close: 65030 });
    expect(frames[3]).toMatchObject({ closed: true, close: 65310 });
    expect(frames[3]).not.toHaveProperty("reconstructed");
    expect(frames[4]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
    // Back to live: the next events pass straight through.
    h.frames.length = 0;
    h.stream().message(klineEvent(E, false, "65400.00"));
    expect(h.parsed().map((frame) => frame.type)).toEqual(["bar"]);
    expect(h.frames[0]).toMatchObject({ ts_open: E, closed: false });
  });

  it("holds a forming bar back during a gap fill and releases the latest one after the missed closes", async () => {
    const { h, pending } = reconnectHarness();
    await openAndSelect(h);
    h.stream().open();
    await dropAndReopen(h);
    h.stream().message(klineEvent(D, false, "65300.00"));
    h.stream().message(klineEvent(D, false, "65305.00"));
    expect(h.frames).toHaveLength(0);
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00")]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
    expect(frames[2]).toMatchObject({ ts_open: D, closed: false, close: 65305 });
  });

  it("stays RECOVERING when the gap fill is rejected, retries it with backoff, and turns READY only once a fill succeeds", async () => {
    const { h, pending } = reconnectHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      h.stream().open();
      await dropAndReopen(h);
      h.stream().message(klineEvent(D, true, "65310.00"));
      pending().reject(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", stale: true, reason: HEALTH_REASON_REST_FAILED });
      expect(h.fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS - 1);
      expect(h.fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fetchMock).toHaveBeenCalledTimes(3);
      expect(String(h.fetchMock.mock.calls[2]![0])).toContain(`startTime=${B}`);
      h.frames.length = 0;
      pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00")]));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
      expect(frames.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
      expect(frames[3]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
      expect(FakeUpstreamSocket.instances).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("a stream that closes while its gap fill is pending cannot turn the feed READY; the next stream fills from the same boundary", async () => {
    const { h, pending } = reconnectHarness();
    await openAndSelect(h);
    h.stream().open();
    await dropAndReopen(h);
    const firstFill = pending();
    h.stream().drop();
    expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
    expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", reason: HEALTH_REASON_STREAM_CLOSED });
    firstFill.resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS * 2);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${B}`);
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00")]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
    expect(frames.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
    expect(frames[3]).toMatchObject({ recoveryState: "READY" });
  });

  it("reports a perpetual stream that drops or never opens as UNAVAILABLE with the perpetual reason on the first failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dropped = harness();
      await openAndSelect(dropped, { ...SPOT, marketKind: "PERPETUAL" });
      expect(dropped.parsed().map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
      expect(dropped.stream().url).toBe(`${DEFAULT_ENDPOINTS.perpetualStreamBase}/stream?streams=btcusdt@kline_1m/btcusdt@trade/btcusdt@depth20@100ms`);
      dropped.stream().open();
      dropped.frames.length = 0;
      dropped.stream().drop();
      expect(dropped.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(dropped.frames[0]).toMatchObject({ marketKind: "PERPETUAL", recoveryState: "UNAVAILABLE", stale: true, reason: HEALTH_REASON_PERPETUAL_UNREACHABLE });
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(FakeUpstreamSocket.instances).toHaveLength(2);

      const silent = harness();
      await openAndSelect(silent, { ...SPOT, marketKind: "PERPETUAL" });
      silent.frames.length = 0;
      await vi.advanceTimersByTimeAsync(STREAM_CONNECT_TIMEOUT_MS);
      expect(silent.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(silent.frames[0]).toMatchObject({ recoveryState: "UNAVAILABLE", reason: HEALTH_REASON_PERPETUAL_UNREACHABLE });
    } finally {
      warn.mockRestore();
    }
  });

  it("marks a failed history read UNAVAILABLE with a reason and retries it with backoff", async () => {
    const h = harness(async () => jsonResponse({ code: -1, msg: "blocked" }, 451));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["selection", "health"]);
      expect(h.frames[1]).toMatchObject({ recoveryState: "UNAVAILABLE", stale: true, reason: HEALTH_REASON_REST_FAILED });
      expect(FakeUpstreamSocket.instances).toHaveLength(0);
      h.fetchMock.mockResolvedValueOnce(jsonResponse(klineRows));
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(h.fetchMock).toHaveBeenCalledTimes(2);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["selection", "health", "snapshot", "health", "book", "bar"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("tries the futures endpoints for a perpetual and says so when they cannot be reached", async () => {
    const h = harness(async () => {
      throw new TypeError("Failed to fetch");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h, { ...SPOT, marketKind: "PERPETUAL" });
      expect(String(h.fetchMock.mock.calls[0]![0])).toBe(`${DEFAULT_ENDPOINTS.perpetualRestBase}/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=901`);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["selection", "health"]);
      expect(frames[1]).toMatchObject({ marketKind: "PERPETUAL", recoveryState: "UNAVAILABLE", stale: true, reason: HEALTH_REASON_PERPETUAL_UNREACHABLE });
    } finally {
      warn.mockRestore();
    }
  });

  it("confirms a dxFeed selection, clears the bars and reports the feed unavailable without touching the network", async () => {
    const h = harness();
    await openAndSelect(h, { type: "select", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" });
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health"]);
    expect(frames[1]).toMatchObject({ provider: "DXFEED", assetClass: "EQUITY", symbol: "AAPL", bars: [], trades: [], markers: [] });
    expect(frames[2]).toMatchObject({ recoveryState: "UNAVAILABLE", stale: true, reason: HEALTH_REASON_NO_DXFEED });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(FakeUpstreamSocket.instances).toHaveLength(0);
  });

  it("starts the catalog's first spot pair when the worker opens without a selection, as the runtime pushes its current pair", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parsed().map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
    expect(h.frames[0]).toEqual({ type: "selection", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" });
  });

  it("a new selection ends the old session: its fetch is abandoned, its stream closed, and no frame of it arrives later", async () => {
    let release: ((response: Response) => void) | null = null;
    const h = harness((url) => url.includes("ETHUSDT") ? Promise.resolve(jsonResponse(klineRows)) : new Promise<Response>((resolve) => { release = resolve; }));
    await openAndSelect(h);
    expect(h.frames.map((frame) => frame.type)).toEqual(["selection"]);
    h.transport.send(JSON.stringify({ ...SPOT, symbol: "ETH-USDT" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames.map((frame) => frame.type)).toEqual(["selection", "selection", "snapshot", "health", "book", "bar"]);
    expect(h.frames.slice(1).every((frame) => frame.symbol === "ETH-USDT")).toBe(true);
    release!(jsonResponse(klineRows));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames).toHaveLength(6);
    expect(FakeUpstreamSocket.instances).toHaveLength(1);
  });

  it("close() stops everything: no frame, no reconnect, no new stream", async () => {
    const h = harness();
    await openAndSelect(h);
    h.stream().open();
    h.transport.close();
    expect(h.transport.readyState).toBe(3);
    expect(h.stream().closed).toBe(true);
    h.frames.length = 0;
    h.stream().message(klineEvents.forming);
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_CAP_MS);
    expect(h.frames).toHaveLength(0);
    expect(FakeUpstreamSocket.instances).toHaveLength(1);
    expect(() => h.transport.send(JSON.stringify(SPOT))).toThrow();
  });
});

describe("resolveDataSource", () => {
  it("reads the query first, then the build-time variable, and treats anything else as the runtime", () => {
    expect(resolveDataSource(undefined, "")).toBeUndefined();
    expect(resolveDataSource("browser-binance", "")).toBe("browser-binance");
    expect(resolveDataSource("browser-binance", undefined)).toBe("browser-binance");
    expect(resolveDataSource(undefined, "?source=browser-binance")).toBe("browser-binance");
    expect(resolveDataSource("browser-binance", "?source=runtime")).toBeUndefined();
    expect(resolveDataSource("runtime", "?x=1")).toBeUndefined();
    expect(resolveDataSource("BROWSER-BINANCE", "")).toBeUndefined();
  });
});
