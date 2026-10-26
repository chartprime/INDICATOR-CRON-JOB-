import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK_REASON_STREAM_CONNECTING,
  BrowserBinanceTransport,
  CLOSE_CONFIRMATION_MARGIN_MS,
  DEFAULT_ENDPOINTS,
  GAP_FILL_PAGE,
  HEALTH_REASON_NO_DXFEED,
  HEALTH_REASON_PERPETUAL_UNREACHABLE,
  HEALTH_REASON_READY,
  HEALTH_REASON_REST_FAILED,
  HEALTH_REASON_STREAM_CLOSED,
  HEALTH_REASON_STREAM_UNAVAILABLE,
  MAX_GAP_FILL_MS,
  MAX_HOLE_RETRIES,
  MAX_HELD_CLOSED_BARS,
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

// The kline reads go to `fetchMock`; the tape bootstrap's aggTrades pages go to
// `aggTrades` (an empty page by default: no history, nothing re-broadcast), so
// the kline assertions below count only kline requests. The tape-derived
// frames have their own file, browserBinanceTransport.l1.test.ts.
function harness(
  fetchImpl?: (url: string) => Promise<Response>,
  now: number | (() => number) = NOW_MS,
  aggTrades: (url: string) => Promise<Response> = async () => jsonResponse([]),
): Harness {
  FakeUpstreamSocket.instances = [];
  const fetchMock = vi.fn(fetchImpl ?? (async () => jsonResponse(klineRows)));
  const nowFn = typeof now === "number" ? () => now : now;
  const transport = new BrowserBinanceTransport("ws://127.0.0.1:8000/ws", {
    fetch: ((url: string) => (url.includes("/aggTrades") ? aggTrades(url) : fetchMock(url))) as unknown as typeof fetch,
    WebSocket: FakeUpstreamSocket,
    now: nowFn,
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
      const parsed = parseServerFrame(frame, { nowMs: nowFn() });
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

// Opens the upstream stream and lets its on-open reconcile (one REST read
// from the last confirmed close) settle, as the live path does.
async function openStream(h: Harness): Promise<void> {
  h.stream().open();
  await vi.advanceTimersByTimeAsync(0);
  h.frames.length = 0;
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
    await openStream(h);
    h.stream().message(klineEvents.forming);
    for (const trade of tradeEvents) h.stream().message(trade);
    h.stream().message(depthEvent);
    h.stream().message(klineEvents.closed);
    // Each trade is the first of its minute and side, so the runtime's
    // retention admits it and a marker follows it (see the l1 test file).
    const all = h.parsed();
    expect(all.map((frame) => frame.type)).toEqual(["bar", "trade", "marker", "trade", "marker", "trade", "marker", "book", "bar"]);
    const frames = all.filter((frame) => frame.type !== "marker");

    expect(frames[0]).toMatchObject({ type: "bar", ts_open: 1_761_400_140_000, closed: false, open: 65080, high: 65100, low: 65070, close: 65091, volume: 1.469, buy_volume: 0.719, trade_count: 43 });
    expect(frames[5]).toMatchObject({ type: "bar", ts_open: 1_761_400_140_000, closed: true, close: 65088, volume: 9.8, buy_volume: 5.1, trade_count: 160 });
    expect(frames[5]).not.toHaveProperty("reconstructed");

    expect(frames[1]).toEqual({ type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts_exchange: 1_761_400_150_005, price: 65090, size: 0.015, side: "buy", trade_id: "5100000001" });
    expect(all[2]).toEqual({ ...frames[1], type: "marker" });
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
    await openStream(h);
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
    await openStream(h);
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
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(String(h.fetchMock.mock.calls[2]![0])).toContain("startTime=1761400140000");
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
    // Bootstrap while B forms (boundary A); the first open confirms nothing new;
    // the stream then drops until E is forming, so B, C and D are missing.
    const clock = { now: B + 10_000 };
    const h = harness(async (url) => {
      if (!url.includes("startTime")) return jsonResponse([klineRow(A, "65010.00"), klineRow(B, "65015.00")]);
      const start = Number(new URL(url).searchParams.get("startTime"));
      const rows: unknown[] = [];
      for (let openTime = start; openTime <= clock.now; openTime += 60_000) rows.push(klineRow(openTime, "65020.00"));
      return jsonResponse(rows);
    }, () => clock.now);
    await openAndSelect(h);
    expect((h.frames[1] as { bars: unknown[] }).bars).toHaveLength(1);
    await openStream(h);
    h.stream().drop();
    clock.now = LATER_NOW_MS;
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${B}`);
    const filled = h.parsed();
    expect(filled.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
    expect(filled.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
    expect(filled[0]).toMatchObject({ closed: true, reconstructed: true, buy_volume: 2 });
    expect(filled[3]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
  });

  // A later clock for the reconnect cases: minutes A (…020000) to D (…200000)
  // have closed, E (…260000) is forming.
  const LATER_NOW_MS = 1_761_400_270_000;
  const klineRow = (openTime: number, close: string) => [openTime, "65000.00", "65500.00", "64900.00", close, "5.000", openTime + 59_999, "0", 50, "2.000", "0", "0"];
  /** The REST row of the minute forming at `nowMs`: a read that reaches it has caught up with the exchange. */
  const formingRow = (nowMs: number) => klineRow(Math.floor(nowMs / 60_000) * 60_000, "65005.00");
  const klineEvent = (openTime: number, closed: boolean, close: string) => ({
    stream: "btcusdt@kline_1m",
    data: { e: "kline", E: openTime + (closed ? 60_010 : 10_000), s: "BTCUSDT", k: { t: openTime, T: openTime + 59_999, s: "BTCUSDT", i: "1m", o: "65000.00", c: close, h: "65500.00", l: "64900.00", v: "5.000", n: 50, x: closed, q: "0", V: "2.000", Q: "0", B: "0" } },
  });
  const A = 1_761_400_020_000, B = 1_761_400_080_000, C = 1_761_400_140_000, D = 1_761_400_200_000, E = 1_761_400_260_000;

  type Deferred = { resolve: (response: Response) => void; reject: (error: Error) => void };
  type Clock = { now: number };
  // Bootstrap while B is forming (A confirmed); the first stream's on-open
  // reconcile answers at once with B still forming; every later read is
  // deferred so a test decides when and how REST answers. The clock is moved
  // to LATER_NOW_MS (E forming) for the outage.
  function reconnectHarness(): { h: Harness; pending: () => Deferred; clock: Clock } {
    const deferred: Deferred[] = [];
    const clock: Clock = { now: B + 10_000 };
    let reads = 0;
    const h = harness((url) => {
      if (!url.includes("startTime")) return Promise.resolve(jsonResponse([klineRow(A, "65010.00"), klineRow(B, "65012.00")]));
      reads += 1;
      if (reads === 1) return Promise.resolve(jsonResponse([klineRow(B, "65012.00")]));
      return new Promise<Response>((resolve, reject) => deferred.push({ resolve, reject }));
    }, () => clock.now);
    return { h, pending: () => deferred.at(-1)!, clock };
  }

  async function dropAndReopen(h: Harness, clock: Clock): Promise<void> {
    h.stream().drop();
    clock.now = LATER_NOW_MS;
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("delivers the closed bars a reconnect missed in order, even when the live stream closes a later bar before the REST answer lands", async () => {
    const { h, pending, clock } = reconnectHarness();
    await openAndSelect(h);
    expect(h.frames.filter((frame) => frame.type === "bar")).toHaveLength(1);
    await openStream(h);
    await dropAndReopen(h, clock);
    expect(String(h.fetchMock.mock.calls[2]![0])).toContain(`startTime=${B}`);
    // B and C are missing; the new stream reports D forming, then closed, before REST answers.
    h.stream().message(klineEvent(D, false, "65300.00"));
    h.stream().message(klineEvent(D, true, "65310.00"));
    h.stream().message(tradeEvents[0]);
    expect(h.frames.map((frame) => frame.type)).toEqual(["trade", "marker"]);
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00")]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed().filter((frame) => frame.type !== "marker");
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
    const { h, pending, clock } = reconnectHarness();
    await openAndSelect(h);
    await openStream(h);
    await dropAndReopen(h, clock);
    h.stream().message(klineEvent(E, false, "65300.00"));
    h.stream().message(klineEvent(E, false, "65305.00"));
    expect(h.frames).toHaveLength(0);
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "bar", "health"]);
    expect(frames.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
    expect(frames[3]).toMatchObject({ ts_open: E, closed: false, close: 65305 });
  });

  it("stays RECOVERING when the gap fill is rejected, retries it with backoff, and turns READY only once a fill succeeds", async () => {
    const { h, pending, clock } = reconnectHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      h.stream().message(klineEvent(D, true, "65310.00"));
      pending().reject(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", stale: true, reason: HEALTH_REASON_REST_FAILED });
      expect(h.fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS - 1);
      expect(h.fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fetchMock).toHaveBeenCalledTimes(4);
      expect(String(h.fetchMock.mock.calls[3]![0])).toContain(`startTime=${B}`);
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
    const { h, pending, clock } = reconnectHarness();
    await openAndSelect(h);
    await openStream(h);
    await dropAndReopen(h, clock);
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
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
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
      await openStream(dropped);
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

  it("reconciles on the first stream open too: a minute that closed while the socket connected is fetched before the stream's bars flow", async () => {
    // The snapshot leaves C forming; by the time the stream opens C has closed and D is forming.
    let nowMs = NOW_MS;
    const h = harness(async (url) => jsonResponse(url.includes("startTime") ? [klineRow(C, "65095.00"), klineRow(D, "65120.00")] : klineRows), () => nowMs);
    await openAndSelect(h);
    expect(h.frames.at(-1)).toMatchObject({ type: "bar", ts_open: C, closed: false });
    nowMs = D + 10_000;
    h.frames.length = 0;
    h.stream().open();
    h.stream().message(klineEvent(D, false, "65125.00"));
    expect(h.frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(h.fetchMock.mock.calls[1]![0])).toContain(`startTime=${C}`);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar"]);
    expect(frames[0]).toMatchObject({ ts_open: C, closed: true, reconstructed: true, close: 65095 });
    expect(frames[1]).toMatchObject({ ts_open: D, closed: false, close: 65125 });
    h.frames.length = 0;
    h.stream().message(klineEvent(D, true, "65130.00"));
    expect(h.parsed().map((frame) => frame.type)).toEqual(["bar"]);
    expect(h.frames[0]).toMatchObject({ ts_open: D, closed: true });
  });

  it("pages the gap fill until it is continuous with the first live close, so an outage longer than one page loses no minute", async () => {
    const minutes = 1_500;
    const clock = { now: B + 10_000 };
    const pageFrom = (startTime: number) => {
      const rows: unknown[] = [];
      for (let openTime = startTime; rows.length < GAP_FILL_PAGE && openTime <= clock.now; openTime += 60_000) rows.push(klineRow(openTime, "65010.00"));
      return rows;
    };
    const h = harness(async (url) => {
      if (!url.includes("startTime")) return jsonResponse([klineRow(A, "65010.00"), klineRow(B, "65012.00")]);
      return jsonResponse(pageFrom(Number(new URL(url).searchParams.get("startTime"))));
    }, () => clock.now);
    await openAndSelect(h);
    await openStream(h);
    h.stream().drop();
    clock.now = A + (minutes + 2) * 60_000 + 10_000;
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    // The stream closes a minute before the first page lands.
    const liveClose = A + (minutes + 1) * 60_000;
    h.stream().message(klineEvent(liveClose, true, "65200.00"));
    await vi.advanceTimersByTimeAsync(0);
    const startTimes = h.fetchMock.mock.calls.slice(2).map((call) => Number(new URL(String(call[0])).searchParams.get("startTime")));
    expect(startTimes).toEqual([A + 60_000, A + 1_001 * 60_000]);
    const frames = h.parsed();
    const bars = frames.filter((frame) => frame.type === "bar") as Array<{ ts_open: number; reconstructed?: boolean }>;
    expect(bars).toHaveLength(minutes + 1);
    expect(bars.every((bar, index) => bar.ts_open === A + (index + 1) * 60_000)).toBe(true);
    expect(bars.slice(0, -1).every((bar) => bar.reconstructed === true)).toBe(true);
    // The minute the stream closed is delivered as the stream saw it, not as REST's copy.
    expect(bars.at(-1)).toMatchObject({ ts_open: liveClose, close: 65200 });
    expect(bars.at(-1)).not.toHaveProperty("reconstructed");
    expect(frames.at(-1)).toMatchObject({ type: "health", recoveryState: "READY" });
    expect(h.transport.heldClosedBarCount).toBe(0);
  });

  it("keeps RECOVERING when the exchange's pages end before the live close is reached, and retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, pending, clock } = reconnectHarness();
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      h.stream().message(klineEvent(D, true, "65310.00"));
      pending().resolve(jsonResponse([klineRow(B, "65020.00")]));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["bar", "health"]);
      expect(frames[0]).toMatchObject({ ts_open: B, reconstructed: true });
      expect(frames[1]).toMatchObject({ recoveryState: "RECOVERING", reason: HEALTH_REASON_REST_FAILED });
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${C}`);
      h.frames.length = 0;
      pending().resolve(jsonResponse([klineRow(C, "65030.00")]));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["bar", "bar", "health"]);
      expect(h.frames.map((frame) => frame.ts_open)).toEqual([C, D, undefined]);
      expect(h.frames[2]).toMatchObject({ recoveryState: "READY" });
    } finally {
      warn.mockRestore();
    }
  });

  it("re-reads the history as a fresh snapshot when a gap exceeds what the fill may page through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let nowMs = LATER_NOW_MS;
      const h = harness(async (url) => {
        if (!url.includes("startTime")) {
          const minute = Math.floor(nowMs / 60_000) * 60_000;
          return jsonResponse([klineRow(minute - 60_000, "65010.00"), formingRow(nowMs)]);
        }
        return jsonResponse([formingRow(nowMs)]);
      }, () => nowMs);
      await openAndSelect(h);
      await openStream(h);
      h.stream().drop();
      // The page stays open through an outage longer than the fill may page.
      nowMs += MAX_GAP_FILL_MS + 60_000;
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      h.frames.length = 0;
      h.stream().open();
      h.stream().message(klineEvent(Math.floor(nowMs / 60_000) * 60_000 - 60_000, true, "65200.00"));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["snapshot", "health", "book", "bar"]);
      expect((frames[0] as { bars: Array<{ ts_open: number }> }).bars.map((bar) => bar.ts_open)).toEqual([Math.floor(nowMs / 60_000) * 60_000 - 60_000]);
      expect(frames[1]).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_READY });
      expect(h.fetchMock.mock.calls.slice(2).map((call) => String(call[0]).includes("startTime="))).toEqual([false]);
      expect(h.transport.heldClosedBarCount).toBe(0);
      expect(FakeUpstreamSocket.instances).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("withdraws the book when the stream is lost and shows depth again only after a new depth message", async () => {
    const h = harness();
    await openAndSelect(h);
    await openStream(h);
    h.stream().message(depthEvent);
    expect(h.parsed().map((frame) => frame.type)).toEqual(["book"]);
    expect(h.frames[0]).toMatchObject({ status: "READY", stale: false });
    h.frames.length = 0;
    h.stream().drop();
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["book", "health"]);
    expect(frames[0]).toEqual({ type: "book", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", status: "UNAVAILABLE", reason: HEALTH_REASON_STREAM_CLOSED });
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
    h.frames.length = 0;
    h.stream().drop();
    expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS * 2);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    h.frames.length = 0;
    h.stream().message(depthEvent);
    expect(h.parsed().map((frame) => frame.type)).toEqual(["book"]);
    expect(h.frames[0]).toMatchObject({ status: "READY", stale: false });
  });

  it("bounds the closes held during a long REST outage and recovers the dropped ones through the paginated read, in order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const total = MAX_HELD_CLOSED_BARS + 30;
      let nowMs = LATER_NOW_MS;
      let restDown = false;
      const h = harness(async (url) => {
        if (!url.includes("startTime")) return jsonResponse([klineRow(A, "65010.00")]);
        if (restDown) throw new TypeError("Failed to fetch");
        const start = Number(new URL(url).searchParams.get("startTime"));
        const rows: unknown[] = [];
        for (let openTime = start; rows.length < GAP_FILL_PAGE && openTime <= nowMs; openTime += 60_000) rows.push(klineRow(openTime, "65010.00"));
        return jsonResponse(rows);
      }, () => nowMs);
      await openAndSelect(h);
      await openStream(h);
      restDown = true;
      h.stream().drop();
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      h.stream().open();
      await vi.advanceTimersByTimeAsync(0);
      // The stream is live but REST keeps failing: every closed minute arrives and waits.
      // (The first open's reconcile already confirmed B..D; the outage starts at E.)
      for (let index = 0; index < total; index += 1) {
        const openTime = E + index * 60_000;
        nowMs = openTime + 70_000;
        h.stream().message(klineEvent(openTime, true, "65300.00"));
        await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_CAP_MS);
      }
      expect(h.transport.heldClosedBarCount).toBe(MAX_HELD_CLOSED_BARS);
      expect(h.frames.filter((frame) => frame.type === "bar")).toHaveLength(0);
      expect(h.frames.every((frame) => frame.type === "health" && frame.recoveryState === "RECOVERING")).toBe(true);
      h.frames.length = 0;
      restDown = false;
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_CAP_MS);
      const frames = h.parsed();
      const bars = frames.filter((frame) => frame.type === "bar") as Array<{ ts_open: number; reconstructed?: boolean }>;
      expect(bars).toHaveLength(total);
      expect(bars.every((bar, index) => bar.ts_open === E + index * 60_000)).toBe(true);
      // The 30 oldest closes fell out of the bound and come back from REST; the retained 120 are the stream's own.
      expect(bars.slice(0, 30).every((bar) => bar.reconstructed === true)).toBe(true);
      expect(bars.slice(30).every((bar) => bar.reconstructed === undefined)).toBe(true);
      expect(frames.at(-1)).toMatchObject({ type: "health", recoveryState: "READY" });
      expect(h.transport.heldClosedBarCount).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays RECOVERING when the first minute after the boundary is missing from the page, and retries from it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, pending, clock } = reconnectHarness();
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      pending().resolve(jsonResponse([klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", reason: HEALTH_REASON_REST_FAILED });
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${B}`);
      h.frames.length = 0;
      pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
      expect(frames.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C, D]);
      expect(frames[3]).toMatchObject({ recoveryState: "READY" });
    } finally {
      warn.mockRestore();
    }
  });

  it("stops at a missing interior minute, keeps what came before it, and retries from the hole", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, pending, clock } = reconnectHarness();
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
      await vi.advanceTimersByTimeAsync(0);
      const first = h.parsed();
      expect(first.map((frame) => frame.type)).toEqual(["bar", "health"]);
      expect(first[0]).toMatchObject({ ts_open: B, closed: true, reconstructed: true });
      expect(first[1]).toMatchObject({ recoveryState: "RECOVERING", reason: HEALTH_REASON_REST_FAILED });
      // A close the stream reports past the hole waits too.
      h.stream().message(klineEvent(E, true, "65300.00"));
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${C}`);
      h.frames.length = 0;
      clock.now = E + 70_000;
      pending().resolve(jsonResponse([klineRow(C, "65030.00"), klineRow(D, "65040.00"), klineRow(E, "65050.00"), formingRow(E + 70_000)]));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar", "bar", "health"]);
      expect(frames.slice(0, 3).map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([C, D, E]);
      expect(frames[2]).toMatchObject({ close: 65300 });
      expect(frames[2]).not.toHaveProperty("reconstructed");
      expect(frames[3]).toMatchObject({ recoveryState: "READY" });
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a row the exchange serves malformed as a missing minute, even when the forming minute follows it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, pending, clock } = reconnectHarness();
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      clock.now = C + 10_000;
      const malformedB = [B, "65000.00", "65500.00", "64900.00", "not-a-price", "5.000", B + 59_999, "0", 50, "2.000", "0", "0"];
      pending().resolve(jsonResponse([malformedB, formingRow(C + 10_000)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.parsed().map((frame) => frame.type)).toEqual(["health"]);
      expect(h.frames[0]).toMatchObject({ recoveryState: "RECOVERING", reason: HEALTH_REASON_REST_FAILED });
      await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
      expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${B}`);
      h.frames.length = 0;
      pending().resolve(jsonResponse([klineRow(B, "65020.00"), formingRow(C + 10_000)]));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.parsed();
      expect(frames.map((frame) => frame.type)).toEqual(["bar", "health"]);
      expect(frames[0]).toMatchObject({ ts_open: B, closed: true, reconstructed: true });
      expect(frames[1]).toMatchObject({ recoveryState: "READY" });
    } finally {
      warn.mockRestore();
    }
  });

  it("re-reads the history when the exchange keeps omitting the same minute, so the gap stays a gap and nothing is fabricated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, pending, clock } = reconnectHarness();
      await openAndSelect(h);
      await openStream(h);
      await dropAndReopen(h, clock);
      let delay = STREAM_BACKOFF_INITIAL_MS;
      for (let attempt = 0; attempt < MAX_HOLE_RETRIES; attempt += 1) {
        pending().resolve(jsonResponse([klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.frames.at(-1)).toMatchObject({ type: "health", recoveryState: "RECOVERING" });
        await vi.advanceTimersByTimeAsync(delay);
        delay = Math.min(delay * 2, STREAM_BACKOFF_CAP_MS);
      }
      // The fill that finds the hole once more gives up and re-reads the snapshot.
      h.frames.length = 0;
      const sockets = FakeUpstreamSocket.instances.length;
      pending().resolve(jsonResponse([klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(LATER_NOW_MS)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain("limit=901");
      // The fixture's history has no forming row, so no forming bar follows the placeholder book.
      expect(h.parsed().map((frame) => frame.type)).toEqual(["snapshot", "health", "book"]);
      expect((h.frames[0] as { bars: Array<{ ts_open: number }> }).bars.map((bar) => bar.ts_open)).toEqual([A, B]);
      expect(FakeUpstreamSocket.instances).toHaveLength(sockets + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not take a REST row served around its minute's close as final: the stream's close for that minute is the one delivered", async () => {
    const { h, pending, clock } = reconnectHarness();
    await openAndSelect(h);
    await openStream(h);
    // The fill goes out 5 s before D closes and lands 2 s after: REST's D row may be partial.
    h.stream().drop();
    clock.now = D + 55_000;
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    clock.now = D + 62_000;
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(D + 62_000)]));
    await vi.advanceTimersByTimeAsync(0);
    let frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "bar"]);
    expect(frames.map((frame) => (frame as { ts_open: number }).ts_open)).toEqual([B, C]);
    // The stream closes D with its final values: delivered as the stream's, and the recovery ends.
    h.frames.length = 0;
    h.stream().message(klineEvent(D, true, "65310.00"));
    h.stream().message(klineEvent(E, false, "65320.00"));
    frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "health", "bar"]);
    expect(frames[0]).toMatchObject({ ts_open: D, closed: true, close: 65310 });
    expect(frames[0]).not.toHaveProperty("reconstructed");
    expect(frames[1]).toMatchObject({ recoveryState: "READY" });
    expect(frames[2]).toMatchObject({ ts_open: E, closed: false });
  });

  it("re-reads the minute at the edge once it is confirmable when the stream never closes it", async () => {
    const { h, pending, clock } = reconnectHarness();
    await openAndSelect(h);
    await openStream(h);
    h.stream().drop();
    clock.now = D + 55_000;
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_INITIAL_MS);
    h.frames.length = 0;
    h.stream().open();
    await vi.advanceTimersByTimeAsync(0);
    clock.now = D + 62_000;
    pending().resolve(jsonResponse([klineRow(B, "65020.00"), klineRow(C, "65030.00"), klineRow(D, "65040.00"), formingRow(D + 62_000)]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parsed().map((frame) => frame.type)).toEqual(["bar", "bar"]);
    const reads = h.fetchMock.mock.calls.length;
    clock.now = D + 60_000 + CLOSE_CONFIRMATION_MARGIN_MS + 1_000;
    await vi.advanceTimersByTimeAsync(CLOSE_CONFIRMATION_MARGIN_MS);
    expect(h.fetchMock.mock.calls.length).toBe(reads + 1);
    expect(String(h.fetchMock.mock.calls.at(-1)![0])).toContain(`startTime=${D}`);
    h.frames.length = 0;
    pending().resolve(jsonResponse([klineRow(D, "65045.00"), formingRow(clock.now)]));
    await vi.advanceTimersByTimeAsync(0);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["bar", "health"]);
    expect(frames[0]).toMatchObject({ ts_open: D, closed: true, reconstructed: true, close: 65045 });
    expect(frames[1]).toMatchObject({ recoveryState: "READY" });
  });

  it("shows the minute at the snapshot's edge as forming until the stream's reconcile confirms it", async () => {
    // The snapshot request goes out 2 s before B closes: B's row may be partial.
    const clock = { now: B + 58_000 };
    const h = harness(async (url) => {
      if (!url.includes("startTime")) {
        clock.now = B + 61_000;
        return jsonResponse([klineRow(A, "65010.00"), klineRow(B, "65015.00"), klineRow(C, "65016.00")]);
      }
      return jsonResponse([klineRow(B, "65018.00"), klineRow(C, "65016.00")]);
    }, () => clock.now);
    await openAndSelect(h);
    const frames = h.parsed();
    expect(frames.map((frame) => frame.type)).toEqual(["selection", "snapshot", "health", "book", "bar"]);
    expect((frames[1] as { bars: Array<{ ts_open: number }> }).bars.map((bar) => bar.ts_open)).toEqual([A]);
    expect(frames[4]).toMatchObject({ ts_open: B, closed: false, close: 65015 });
    h.frames.length = 0;
    clock.now = B + 70_000;
    h.stream().open();
    h.stream().message(klineEvent(B, true, "65019.00"));
    await vi.advanceTimersByTimeAsync(0);
    const after = h.parsed();
    expect(after.map((frame) => frame.type)).toEqual(["bar"]);
    expect(after[0]).toMatchObject({ ts_open: B, closed: true, close: 65019 });
    expect(after[0]).not.toHaveProperty("reconstructed");
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
    await openStream(h);
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
