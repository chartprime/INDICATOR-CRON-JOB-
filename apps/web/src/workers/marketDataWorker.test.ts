// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// marketDataWorker.ts assigns `self.onmessage` and calls the global
// `postMessage` at module scope (worker-context globals) -- fresh-import
// it per test via vi.resetModules() so the module's own mutable state
// (ws/backoffMs/stopped) never bleeds between tests, and stub the
// WebSocket/postMessage globals it depends on before each import.

class FakeClientWebSocket {
  static instances: FakeClientWebSocket[] = [];
  static throwOnConstruction = false;
  static OPEN = 1;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  sentMessages: string[] = [];

  constructor(url: string) {
    if (FakeClientWebSocket.throwOnConstruction) throw new DOMException("Invalid URL", "SyntaxError");
    this.url = url;
    FakeClientWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  simulateOpen() {
    this.readyState = FakeClientWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateClose(code = 1006, reason = "") {
    this.onclose?.({ code, reason });
  }
}

// Every copy of the worker a test loads, stopped after the test: a copy left
// running keeps its reconnect loop on real timers, and on a slow machine that
// loop fires inside a later test and opens sockets there.
const loadedWorkers: Array<NonNullable<typeof self.onmessage>> = [];
afterEach(() => {
  for (const handler of loadedWorkers.splice(0)) handler.call(self, { data: { kind: "stop" } } as MessageEvent);
});

async function loadWorkerModule() {
  vi.resetModules();
  FakeClientWebSocket.instances = [];
  FakeClientWebSocket.throwOnConstruction = false;
  vi.stubGlobal("WebSocket", FakeClientWebSocket);
  const posted: unknown[] = [];
  const transfers: unknown[][] = [];
  vi.stubGlobal("postMessage", (message: unknown, options?: { transfer?: unknown[] }) => {
    posted.push(message);
    transfers.push(options?.transfer ?? []);
  });
  const workerModule = await import("./marketDataWorker");
  if (self.onmessage) loadedWorkers.push(self.onmessage);
  return { posted, transfers, workerModule, latestSocket: () => FakeClientWebSocket.instances.at(-1)! };
}

describe("marketDataWorker", () => {
  const declaredCapabilities = JSON.stringify({ type: "capabilities", marker_history: true, l2_view: true, l2_walls: true, l2_walls_lanes: true, l2_events: true, l2_ladder: true, iceberg_orders: true, exhaustion_shades: true, initiative_bands: true });
  const applicationMessages = (socket: FakeClientWebSocket) => socket.sentMessages.filter((message) => message !== declaredCapabilities);

  it("declares marker history and the four L2 channels before any selection, so a host-first rolling deploy stays legacy-safe", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    expect(latestSocket().sentMessages[0]).toBe(declaredCapabilities);
  });

  it("fetches heatmap history over HTTP beside the socket, posts the decoded page with its buffers transferred, and reports a failure without touching the feed (P4c.4)", async () => {
    const pages = (await import("../lib/indicators/passive-liquidity/tests/fixtures/pyramid-pages.json")).default as unknown as Record<string, { page: unknown }>;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(pages.L30000_R1.page), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { posted, transfers } = await loadWorkerModule();
      const request = { kind: "heatmap_history", request_id: 7, provider: "BINANCE", market_kind: "PERPETUAL", symbol: "BTC-USDT", level_ms: 30_000, from_ts: 1_757_340_000_000, to_ts: 1_757_341_200_000, row_factor: 1 };
      self.onmessage!({ data: request } as MessageEvent);
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ kind: "heatmap_history", request_id: 7, failed: true, page: null });
      self.onmessage!({ data: { kind: "start", url: "wss://terminal.example/ws" } } as MessageEvent);
      posted.length = 0;
      transfers.length = 0;
      self.onmessage!({ data: request } as MessageEvent);
      await vi.waitFor(() => expect(posted.some((m) => (m as { kind: string }).kind === "heatmap_history")).toBe(true));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://terminal.example/heatmap/columns");
      expect(JSON.parse(init.body as string)).toEqual({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", levelMs: 30_000, fromTs: 1_757_340_000_000, toTs: 1_757_341_200_000, rowFactor: 1 });
      const index = posted.findIndex((m) => (m as { kind: string }).kind === "heatmap_history");
      const message = posted[index] as { failed: boolean; page: { available: boolean; windows: { columns: unknown[] }[] } };
      expect(message.failed).toBe(false);
      expect(message.page.available).toBe(true);
      const columnCount = message.page.windows.reduce((n, w) => n + w.columns.length, 0);
      expect(transfers[index]).toHaveLength(2 * columnCount);
      fetchMock.mockImplementationOnce(async () => new Response("", { status: 503 }));
      posted.length = 0;
      self.onmessage!({ data: { ...request, request_id: 8 } } as MessageEvent);
      await vi.waitFor(() => expect(posted.some((m) => (m as { request_id?: number }).request_id === 8)).toBe(true));
      expect(posted.find((m) => (m as { request_id?: number }).request_id === 8)).toMatchObject({ failed: true, page: null });
      posted.length = 0;
      self.onmessage!({ data: { ...request, level_ms: 1_000 } } as MessageEvent);
      self.onmessage!({ data: { ...request, extra: 1 } } as MessageEvent);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes on how long the host asked for a refused history request to wait, only for a busy refusal that says so", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { posted } = await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "wss://terminal.example/ws" } } as MessageEvent);
      const history = { kind: "heatmap_history", provider: "BINANCE", market_kind: "PERPETUAL", symbol: "BTC-USDT", level_ms: 30_000, from_ts: 1_757_340_000_000, to_ts: 1_757_341_200_000, row_factor: 1 };
      const walls = { kind: "heatmap_walls", provider: "BINANCE", market_kind: "PERPETUAL", symbol: "BTC-USDT", from_ts: 1_757_340_000_000, to_ts: 1_757_341_200_000, limit: 100, after: null };
      const answers: [number, Record<string, unknown>, Response][] = [
        [11, history, new Response(JSON.stringify({ error: "BUSY", retryAfterMs: 250 }), { status: 429 })],
        [12, history, new Response(JSON.stringify({ error: "RATE_BUDGET_EXCEEDED", retryAfterMs: 4_000 }), { status: 429 })],
        [13, history, new Response("busy", { status: 429 })],
        [14, history, new Response(JSON.stringify({ retryAfterMs: 250 }), { status: 503 })],
        [15, walls, new Response(JSON.stringify({ error: "BUSY", retryAfterMs: 250 }), { status: 429 })],
        [16, history, new Response(JSON.stringify({ error: "BUSY", retryAfterMs: 0 }), { status: 429 })],
      ];
      for (const [id, request, response] of answers) {
        fetchMock.mockImplementationOnce(async () => response);
        self.onmessage!({ data: { ...request, request_id: id } } as MessageEvent);
        await vi.waitFor(() => expect(posted.some((m) => (m as { request_id?: number }).request_id === id)).toBe(true));
      }
      const reply = (id: number) => posted.find((m) => (m as { request_id?: number }).request_id === id) as { failed: boolean; retry_after_ms?: number };
      expect([11, 12, 13, 14, 15, 16].map((id) => [reply(id).failed, reply(id).retry_after_ms])).toEqual([[true, 250], [true, 4_000], [true, undefined], [true, undefined], [true, 250], [true, 0]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("puts the size filter in a wall request body only when it is whole and for Binance, and drops a half, a negative or an unknown filter", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: false, reason: "NO_PYRAMID" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { posted } = await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "wss://terminal.example/ws" } } as MessageEvent);
      const walls = { kind: "heatmap_walls", provider: "BINANCE", market_kind: "PERPETUAL", symbol: "BTC-USDT", from_ts: 1_757_340_000_000, to_ts: 1_757_341_200_000, limit: 100, after: null };
      self.onmessage!({ data: { ...walls, request_id: 21, min_usd: 5_000_000, always_outcomes: ["filled", "partial"] } } as MessageEvent);
      await vi.waitFor(() => expect(posted.some((m) => (m as { request_id?: number }).request_id === 21)).toBe(true));
      self.onmessage!({ data: { ...walls, request_id: 22, min_usd: 0 } } as MessageEvent);
      await vi.waitFor(() => expect(posted.some((m) => (m as { request_id?: number }).request_id === 22)).toBe(true));
      self.onmessage!({ data: { ...walls, request_id: 23 } } as MessageEvent);
      await vi.waitFor(() => expect(posted.some((m) => (m as { request_id?: number }).request_id === 23)).toBe(true));
      const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toMatchObject({ minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] });
      expect(bodies[1]).toMatchObject({ minUsd: 0, alwaysOutcomes: [] });
      expect(Object.hasOwn(bodies[2], "minUsd") || Object.hasOwn(bodies[2], "alwaysOutcomes")).toBe(false);
      const refused = [
        { provider: "DXFEED", market_kind: "FUTURE", symbol: "/NQZ26:XCME", min_usd: 1 },
        { always_outcomes: ["filled"] },
        { min_usd: -1 },
        { min_usd: 1e13 },
        { min_usd: "9" },
        { min_usd: 1, always_outcomes: ["lost"] },
        { min_usd: 1, always_outcomes: ["hit", "hit"] },
        { min_usd: 1, always_outcomes: "hit" },
        { min_usd: 1, extra: true },
      ];
      refused.forEach((extra, index) => self.onmessage!({ data: { ...walls, request_id: 40 + index, ...extra } } as MessageEvent));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards an l2_resync for one known channel while the socket is open, and drops a malformed one", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: { kind: "l2_resync", channel: "l2_walls" } } as MessageEvent);
    self.onmessage!({ data: { kind: "l2_resync", channel: "liquidity" } } as MessageEvent);
    self.onmessage!({ data: { kind: "l2_resync" } } as MessageEvent);
    self.onmessage!({ data: { kind: "l2_resync", channel: "l2_events", extra: 1 } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([JSON.stringify({ type: "l2_resync", channel: "l2_walls" })]);
  });
  it("restores the latest confirmed shared selection after reconnect, preserving an outstanding deliberate request", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    const frame = (symbol: string) => JSON.stringify({ type: "selection", symbol, provider: "BINANCE", marketKind: "SPOT" });
    self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" } } as MessageEvent);
    latestSocket().simulateMessage(frame("BTC-USDT"));
    latestSocket().simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();
    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).toMatchObject({ symbol: "ETH-USDT" });
    latestSocket().simulateMessage(frame("ETH-USDT"));
    latestSocket().simulateMessage(frame("BTC-USDT"));
    latestSocket().simulateClose();
    // Backoff no longer resets on the first frame -- only after a socket has
    // stayed up STABLE_CONNECTION_MS -- so the second reconnect waits ~850ms.
    await vi.advanceTimersByTimeAsync(1_500);
    latestSocket().simulateOpen();
    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).toMatchObject({ symbol: "BTC-USDT" });
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });

  it("resets the reconnect backoff only after a connection has been stable, not on the first frame", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    const frame = JSON.stringify({ type: "selection", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" });
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    latestSocket().simulateMessage(frame);
    latestSocket().simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    const flapping = latestSocket();
    flapping.simulateOpen();
    flapping.simulateMessage(frame);
    flapping.simulateClose(); // closed well before STABLE_CONNECTION_MS
    await vi.advanceTimersByTimeAsync(500);
    expect(latestSocket()).toBe(flapping); // 850ms backoff now -- no reconnect yet
    await vi.advanceTimersByTimeAsync(1_000);
    expect(latestSocket()).not.toBe(flapping);

    const stable = latestSocket();
    stable.simulateOpen();
    stable.simulateMessage(frame);
    await vi.advanceTimersByTimeAsync(12_000); // past STABLE_CONNECTION_MS
    stable.simulateClose();
    await vi.advanceTimersByTimeAsync(500); // backoff reset to initial after a stable run
    expect(latestSocket()).not.toBe(stable);
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });
  it("marks automatic dxFeed restoration separately from a deliberate new selection", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    const selection = { kind: "select", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" };
    self.onmessage!({ data: selection } as MessageEvent);
    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).not.toHaveProperty("resume");
    latestSocket().simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();
    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).toMatchObject({ resume: true });
    self.onmessage!({ data: selection } as MessageEvent);
    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).not.toHaveProperty("resume");
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });
  it("propagates a bounded selection generation internally without leaking it onto the server wire", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: {
      kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT",
      selectionTrace: { runId: "11111111-1111-4111-8111-111111111111", selectionGeneration: 7, requestedAtMs: 12.5 },
    } } as MessageEvent);

    expect(JSON.parse(latestSocket().sentMessages.at(-1)!)).toEqual({
      type: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT",
    });
    latestSocket().simulateMessage(JSON.stringify({ type: "selection", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" }));

    expect(posted).toContainEqual(expect.objectContaining({
      kind: "frame",
      selectionTrace: expect.objectContaining({
        connectionId: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        selectionGeneration: 7,
        requestedAtMs: 12.5,
        phase: "selection_confirmed",
      }),
    }));
  });
  it("retains the selection generation across reconnect and emits bounded backfill state changes once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T08:00:00Z"));
    const { posted, latestSocket } = await loadWorkerModule();
    const trace = { runId: "33333333-3333-4333-8333-333333333333", selectionGeneration: 9, requestedAtMs: 10 };
    const selectionFrame = JSON.stringify({ type: "selection", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" });
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: {
      kind: "select", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", selectionTrace: trace,
    } } as MessageEvent);
    latestSocket().simulateMessage(selectionFrame);
    latestSocket().simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();
    latestSocket().simulateMessage(selectionFrame);

    const liquidity = (status: "RUNNING" | "COMPLETE") => JSON.stringify({
      type: "liquidity", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
      ts: Date.now(), seq: status === "RUNNING" ? 0 : 1, reset: true,
      row_width: 1, column_ms: 1_000, columns: [], levels: [], aggressive: [],
      backfill: { status, reason: null },
    });
    latestSocket().simulateMessage(liquidity("RUNNING"));
    latestSocket().simulateMessage(liquidity("RUNNING"));
    latestSocket().simulateMessage(liquidity("COMPLETE"));

    const traces = posted.flatMap((message) => {
      const candidate = message as { selectionTrace?: { phase: string; selectionGeneration: number; backfillStatus?: string } };
      return candidate.selectionTrace ? [candidate.selectionTrace] : [];
    });
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "selection_confirmed", selectionGeneration: 9 }),
      expect.objectContaining({ phase: "recovery_confirmed", selectionGeneration: 9 }),
      expect.objectContaining({ phase: "backfill_status", backfillStatus: "RUNNING", selectionGeneration: 9 }),
      expect.objectContaining({ phase: "backfill_status", backfillStatus: "COMPLETE", selectionGeneration: 9 }),
    ]));
    expect(traces.filter((entry) => entry.phase === "backfill_status" && entry.backfillStatus === "RUNNING")).toHaveLength(1);
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });
  it("decodes heatmap and lane columns here, hands them over by transfer without their row lists, and starts over on a new selection", async () => {
    const { posted, transfers, latestSocket } = await loadWorkerModule();
    type Posted = { kind: string; frame?: { type: string; columns?: { bid: unknown[]; prints?: unknown[] }[] }; decodedLiquidity?: { accepted: boolean; columns: { bid: Float64Array }[] }; decodedLane?: { outcome: string } };
    const frameMessages = () => posted.flatMap((message, index) => ((message as Posted).kind === "frame" ? [{ message: message as Posted, transfer: transfers[index] }] : []));
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    const ts = Date.now();
    const identity = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" };
    const column = (at: number, first: boolean) => ({ ts: at, lo: 100, hi: 102, bid: first ? [[0, 1.5], [2, 3]] : [[1, 2]], ask: [[1, 4]], prints: [{ ts: at, price: 50, size: 2, side: "buy", id: `t${at}` }] });
    const heat = (seq: number, reset: boolean, at: number) => JSON.stringify({ type: "liquidity", ...identity, ts: at, seq, reset, row_width: 1, column_ms: 1_000, columns: [column(at, reset)] });
    latestSocket().simulateMessage(heat(1, true, ts - 2_000));
    latestSocket().simulateMessage(heat(2, false, ts - 1_000));
    latestSocket().simulateMessage(JSON.stringify({
      type: "l2_view", ...identity, lane: 1, tier: "recent", ts: ts - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 2_000,
      columns: [{ ts: ts - 2_000, lo: 50, hi: 51, bid: [[0, 1]], ask: [] }], segment: { id: "SPOT:BTCUSDT:1:LIVE", state: "LIVE" },
    }));
    const frames = frameMessages();
    expect(frames).toHaveLength(3);
    const [first, second, lane] = frames;
    expect(first.message.decodedLiquidity).toMatchObject({ accepted: true, reset: true });
    expect(second.message.decodedLiquidity).toMatchObject({ accepted: true, reset: false });
    expect(Array.from(second.message.decodedLiquidity!.columns[0].bid)).toEqual([1.5, 2, 3]);
    expect(first.message.frame!.columns![0].bid).toEqual([]);
    expect(first.message.frame!.columns![0].prints).toHaveLength(1);
    expect(first.transfer).toHaveLength(2);
    expect(lane.message.decodedLane).toMatchObject({ outcome: "applied" });
    expect(lane.transfer).toHaveLength(2);

    self.onmessage!({ data: { kind: "select", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" } } as MessageEvent);
    latestSocket().simulateMessage(heat(3, false, ts));
    const afterSelect = frameMessages().at(-1)!;
    expect(afterSelect.message.decodedLiquidity).toMatchObject({ accepted: false });
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });

  it("does not attribute an unrelated shared selection to the previous generation", async () => {
    vi.useFakeTimers();
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: {
      kind: "select", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
      selectionTrace: { runId: "66666666-6666-4666-8666-666666666666", selectionGeneration: 6, requestedAtMs: 10 },
    } } as MessageEvent);
    latestSocket().simulateMessage(JSON.stringify({ type: "selection", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }));
    latestSocket().simulateMessage(JSON.stringify({ type: "selection", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" }));
    latestSocket().simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();
    latestSocket().simulateMessage(JSON.stringify({ type: "selection", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" }));

    const tracedFrames = posted.filter((message) => (message as { selectionTrace?: unknown }).selectionTrace !== undefined);
    expect(tracedFrames).toHaveLength(1);
    expect(tracedFrames[0]).toEqual(expect.objectContaining({
      frame: expect.objectContaining({ symbol: "BTC-USDT" }),
      selectionTrace: expect.objectContaining({ phase: "selection_confirmed", selectionGeneration: 6 }),
    }));
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });
  it("bounds delivery to a frozen main thread and reconnects only after acknowledgements drain", async () => {
    vi.useFakeTimers();
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "flow_control" } } as MessageEvent);
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    const socket = latestSocket();
    socket.simulateOpen();
    const frame = JSON.stringify({ type: "health", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", recoveryState: "READY", stale: false });
    for (let i = 0; i < 10_000; i++) socket.simulateMessage(frame);
    expect(posted).toHaveLength(4_001);
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    expect(posted.at(-1)).toEqual({ kind: "status", status: "closed", reason: `flow-paused:4000/${2 * 256 + 3_998 * frameBytes}+${frameBytes}:health` });
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeClientWebSocket.instances).toHaveLength(1);
    for (let i = 0; i < 4_001; i++) self.onmessage!({ data: { kind: "ack" } } as MessageEvent);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeClientWebSocket.instances).toHaveLength(2);
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop and replacement clear first-frame deadlines even when socket close never fires", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    for (let i = 0; i < 20; i++) {
      self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
      expect(vi.getTimerCount()).toBe(1);
    }
    const socket = latestSocket();
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts a frame message for a well-formed health frame", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateMessage(JSON.stringify({ type: "health", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", recoveryState: "READY", stale: false }));

    expect(posted).toContainEqual({
      kind: "frame",
      frame: { type: "health", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", recoveryState: "READY", stale: false },
    });
  });

  it("enforces the server-message ceiling in UTF-8 bytes, with an allocation-free ASCII fast path", async () => {
    const { workerModule } = await loadWorkerModule();
    expect(workerModule.serverMessageExceedsByteLimit("1234567890", 10)).toBe(false);
    expect(workerModule.serverMessageExceedsByteLimit("12345678901", 10)).toBe(true);
    expect(workerModule.serverMessageExceedsByteLimit("€€€€", 10)).toBe(true);
    expect(workerModule.serverMessageExceedsByteLimit("anything", 0)).toBe(true);
  });

  it("drops malformed (non-JSON) data and logs a warning, fails closed rather than throwing", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    expect(() => latestSocket().simulateMessage("{not json")).not.toThrow();

    expect(posted.filter((m) => (m as { kind: string }).kind === "frame")).toEqual([]);
    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "malformed-json" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });

  it("drops a frame with an unrecognized type and logs a warning naming the type, fails closed", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateMessage(JSON.stringify({ type: "book_delta", symbol: "BTC-USDT" }));

    expect(posted.filter((m) => (m as { kind: string }).kind === "frame")).toEqual([]);
    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "parse-rejected:book_delta:BTC-USDT:? largest none within-ceiling" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized"), expect.stringContaining("book_delta"));
  });

  it("drops a trade frame missing required fields rather than posting a partial object", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateMessage(JSON.stringify({ type: "trade", symbol: "BTC-USDT" }));

    expect(posted.filter((m) => (m as { kind: string }).kind === "frame")).toEqual([]);
    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: expect.stringMatching(/^parse-rejected:trade:BTC-USDT:/) });
    expect(console.warn).toHaveBeenCalled();
  });

  it("fails the socket on a surplus server field so silent protocol drift cannot leave the UI looking live", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateMessage(JSON.stringify({
      type: "health", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY",
      recoveryState: "READY", stale: false, unexpected: true,
    }));

    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: expect.stringMatching(/^parse-rejected:health:AAPL:EQUITY /) });
    expect(posted.some((message) => (message as { kind?: string }).kind === "frame")).toBe(false);
  });

  it("a select message forwards as a real ws.send() call over the live socket -- the P3.03 outbound channel", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" }),
    ]);
  });

  it("a select message for a dxFeed symbol forwards its assetClass identity, not a marketKind", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "select", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" } } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "select", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" }),
    ]);
  });

  it("drops a select message whose provider/assetClass/symbol combination is not on the allowlist", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "select", symbol: "AAPL", provider: "DXFEED", marketKind: "SPOT" } } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("malformed select request"));
  });

  it("a select message before the socket is open is a silent no-op, not a throw or a queued send", async () => {
    await loadWorkerModule();

    expect(() => self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent)).not.toThrow();
  });

  it("a select message while the socket is still CONNECTING is retained without calling send()", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().send = () => {
      throw new DOMException("still in CONNECTING state", "InvalidStateError");
    };

    expect(() => self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent)).not.toThrow();

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("closes a live socket when sending a selection fails so reconnect can deliver the retained request", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    latestSocket().send = () => {
      throw new DOMException("connection failed", "InvalidStateError");
    };

    self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent);

    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "send-failed:select" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("rejects selection controls with surplus fields instead of forwarding an ambiguous protocol shape", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({
      data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL", assetClass: "EQUITY" },
    } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("malformed select request"));
  });

  it("delivers a selection made during CONNECTING once the socket opens", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent);
    latestSocket().simulateOpen();

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" }),
    ]);
  });

  it("resends the desired selection after a reconnect", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: { kind: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } } as MessageEvent);
    latestSocket().simulateClose();

    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "select", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" }),
    ]);
  });

  it("ignores late events from a superseded socket so they cannot close or contaminate the replacement connection", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://first" } } as MessageEvent);
    const firstSocket = latestSocket();
    self.onmessage!({ data: { kind: "start", url: "ws://second" } } as MessageEvent);
    const secondSocket = latestSocket();
    secondSocket.simulateOpen();
    const beforeLateEvents = [...posted];

    firstSocket.simulateOpen();
    firstSocket.simulateMessage(JSON.stringify({ type: "health", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", recoveryState: "READY", stale: false }));
    firstSocket.simulateClose();

    expect(posted).toEqual(beforeLateEvents);
    expect(secondSocket.closed).toBe(false);
  });

  it("contains invalid worker control input and a WebSocket construction failure", async () => {
    const { posted } = await loadWorkerModule();
    expect(() => self.onmessage!({ data: null } as MessageEvent)).not.toThrow();
    expect(() => self.onmessage!({ data: { kind: "select", symbol: 3, marketKind: "SPOT" } } as MessageEvent)).not.toThrow();

    FakeClientWebSocket.throwOnConstruction = true;
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);

    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "construct-failed" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("closes a transport that opens but never proves the application protocol with a valid frame", async () => {
    vi.useFakeTimers();
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "connect-timeout:1" });
  });

  it("reports the server's close code and reason when the peer closes the socket", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateClose(1013, "Client is too slow to receive market data");

    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "server-close:1013:Client is too slow to receive market data" });
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });

  it("names the frame and its oversized size when a liquidity column is rejected", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    latestSocket().simulateMessage(JSON.stringify({
      type: "liquidity", symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY", ts: 1_759_262_400_000,
      columns: [{ ts: 1_759_262_400_000, bid: [[227.5, 12_500_000]], ask: [[227.51, 300]] }],
    }));

    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "parse-rejected:liquidity:AAPL:EQUITY largest columns[0].bid[0][1]=12500000 >10000000" });
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
  });

  it("drops an invalid start URL without constructing a socket or entering a reconnect loop", async () => {
    vi.useFakeTimers();
    const { posted } = await loadWorkerModule();

    self.onmessage!({ data: { kind: "start", url: "https://example.test/ws" } } as MessageEvent);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeClientWebSocket.instances).toHaveLength(0);
    expect(posted).toEqual([{ kind: "status", status: "closed", reason: "invalid-start-url" }]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("sends a valid profile_config request while the socket is open", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({
      data: { kind: "profile_config", mode: "continuous", period_ms: 60_000, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
    } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "profile_config", mode: "continuous", period_ms: 60_000, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null }),
    ]);
  });

  it("forwards an exhaustion_history request as a ws.send() with its from_ts while the socket is open, drops a malformed one", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: { kind: "exhaustion_history", from_ts: 1_700_000_000_000 } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([JSON.stringify({ type: "exhaustion_history", from_ts: 1_700_000_000_000 })]);
    for (const bad of [{ kind: "exhaustion_history" }, { kind: "exhaustion_history", from_ts: -1 }, { kind: "exhaustion_history", from_ts: 1.5 }, { kind: "exhaustion_history", from_ts: "1" }, { kind: "exhaustion_history", from_ts: 1_700_000_000_000, extra: 1 }]) {
      self.onmessage!({ data: bad } as MessageEvent);
    }
    expect(applicationMessages(latestSocket())).toHaveLength(1);
  });

  it("forwards an initiative_history request as a ws.send() with its from_ts while the socket is open, drops a malformed one", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: { kind: "initiative_history", from_ts: 1_700_000_000_000 } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([JSON.stringify({ type: "initiative_history", from_ts: 1_700_000_000_000 })]);
    for (const bad of [{ kind: "initiative_history" }, { kind: "initiative_history", from_ts: -1 }, { kind: "initiative_history", from_ts: 1.5 }, { kind: "initiative_history", from_ts: "1" }, { kind: "initiative_history", from_ts: 1_700_000_000_000, extra: 1 }]) {
      self.onmessage!({ data: bad } as MessageEvent);
    }
    expect(applicationMessages(latestSocket())).toHaveLength(1);
  });

  it("forwards a liquidity_resync request as a ws.send() while the socket is open, drops it otherwise", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "liquidity_resync" } } as MessageEvent);
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "liquidity_resync" } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([JSON.stringify({ type: "liquidity_resync" })]);

    self.onmessage!({ data: { kind: "liquidity_resync", extra: 1 } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([JSON.stringify({ type: "liquidity_resync" })]);
  });

  it("forwards a first aggressive history request and its opaque capped-page cursor, while rejecting malformed cursors", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "aggressive_history", request_id: 1, from_ts: 0, to_ts: 200_000, min_size: 0 } } as MessageEvent);
    self.onmessage!({ data: { kind: "aggressive_history", request_id: 2, from_ts: 0, to_ts: 200_000, min_size: 0, cursor: "eyJ2IjoxfQ" } } as MessageEvent);
    self.onmessage!({ data: { kind: "aggressive_history", request_id: 3, from_ts: 0, to_ts: 200_000, min_size: 0, cursor: "not/a-token" } } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "aggressive_history", request_id: 1, from_ts: 0, to_ts: 200_000, min_size: 0 }),
      JSON.stringify({ type: "aggressive_history", request_id: 2, from_ts: 0, to_ts: 200_000, min_size: 0, cursor: "eyJ2IjoxfQ" }),
    ]);
  });

describe("delta_profile -- the delta profile request", () => {
  it("forwards a well-formed request and drops a malformed one", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    self.onmessage!({ data: { kind: "delta_profile", request_id: 1, from_ts: 0, to_ts: 7_200_000, row_width: 0.25 } } as MessageEvent);
    self.onmessage!({ data: { kind: "delta_profile", request_id: 2, from_ts: 0, to_ts: 7_200_000, row_width: 0 } } as MessageEvent);
    self.onmessage!({ data: { kind: "delta_profile", request_id: 3, from_ts: 7_200_000, to_ts: 7_200_000, row_width: 1 } } as MessageEvent);
    self.onmessage!({ data: { kind: "delta_profile", request_id: 4, from_ts: 0, to_ts: 7_200_000, row_width: 1, extra: 1 } } as MessageEvent);
    self.onmessage!({ data: { kind: "delta_profile", request_id: 5, from_ts: 0, to_ts: 7_200_000, row_width: 1, piece_ms: 1_800_000 } } as MessageEvent);
    self.onmessage!({ data: { kind: "delta_profile", request_id: 6, from_ts: 0, to_ts: 7_200_000, row_width: 1, piece_ms: 0 } } as MessageEvent);

    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "delta_profile", request_id: 1, from_ts: 0, to_ts: 7_200_000, row_width: 0.25 }),
      JSON.stringify({ type: "delta_profile", request_id: 5, from_ts: 0, to_ts: 7_200_000, row_width: 1, piece_ms: 1_800_000 }),
    ]);
  });
});

describe("band_history -- the band history request", () => {
  it("forwards a well-formed request and drops a malformed one", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({ data: { kind: "band_history", request_id: 1, from_ts: 0, to_ts: 200_000, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000 } } as MessageEvent);
    self.onmessage!({ data: { kind: "band_history", request_id: 2, from_ts: 0, to_ts: 200_000, price_lo: 80_000, price_hi: 79_000, column_ms: 10_000 } } as MessageEvent);
    self.onmessage!({ data: { kind: "band_history", request_id: 3, from_ts: 0, to_ts: 200_000, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000, extra: 1 } } as MessageEvent);
    expect(applicationMessages(latestSocket())).toEqual([
      JSON.stringify({ type: "band_history", request_id: 1, from_ts: 0, to_ts: 200_000, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000 }),
    ]);
  });
  });

  describe("profile_history -- the batched historical-zone request", () => {
    function ranges(periodMs: number, count: number, base = 0) {
      return Array.from({ length: count }, (_unused, i) => ({
        range_start_ts: base + i * periodMs,
        range_end_ts: base + (i + 1) * periodMs,
      }));
    }

    it("forwards a valid batch as one message, not one per range", async () => {
      const { latestSocket } = await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
      latestSocket().simulateOpen();

      self.onmessage!({
        data: { kind: "profile_history", mode: "continuous", request_id: 1, period_ms: 60_000, bin_size_multiplier: 1, ranges: ranges(60_000, 4) },
      } as MessageEvent);

      expect(applicationMessages(latestSocket())).toHaveLength(1);
      const sent = JSON.parse(applicationMessages(latestSocket())[0]) as { type: string; ranges: unknown[] };
      expect(sent.type).toBe("profile_history");
      expect(sent).toMatchObject({ mode: "continuous", request_id: 1 });
      expect(sent.ranges).toHaveLength(4);
    });

    it.each([
      ["an empty range list", { period_ms: 60_000, bin_size_multiplier: 1, ranges: [] }],
      ["a range whose span does not equal the period", {
        period_ms: 60_000, bin_size_multiplier: 1, ranges: [{ range_start_ts: 0, range_end_ts: 120_000 }],
      }],
      ["a range off the period grid", {
        period_ms: 60_000, bin_size_multiplier: 1, ranges: [{ range_start_ts: 1, range_end_ts: 60_001 }],
      }],
      ["a duplicated range", {
        period_ms: 60_000, bin_size_multiplier: 1,
        ranges: [{ range_start_ts: 0, range_end_ts: 60_000 }, { range_start_ts: 0, range_end_ts: 60_000 }],
      }],
      ["a non-positive period", { period_ms: 0, bin_size_multiplier: 1, ranges: [{ range_start_ts: 0, range_end_ts: 1 }] }],
      ["a range with an extra field", {
        period_ms: 60_000, bin_size_multiplier: 1, ranges: [{ range_start_ts: 0, range_end_ts: 60_000, extra: 1 }],
      }],
      ["more ranges than the cap", { period_ms: 60_000, bin_size_multiplier: 1, ranges: ranges(60_000, 200) }],
    ])("drops a batch with %s", async (_label, payload) => {
      const { latestSocket } = await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
      latestSocket().simulateOpen();

      self.onmessage!({ data: { kind: "profile_history", ...payload } } as MessageEvent);

      expect(applicationMessages(latestSocket())).toEqual([]);
    });

    it("silently drops a batch while there is no open socket", async () => {
      await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);

      expect(() => self.onmessage!({
        data: { kind: "profile_history", period_ms: 60_000, bin_size_multiplier: 1, ranges: ranges(60_000, 2) },
      } as MessageEvent)).not.toThrow();
    });
  });

  it("silently drops a profile_config request while there is no open socket -- it is a one-off command, not a resent desired state", async () => {
    const { posted } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);

    expect(() => self.onmessage!({
      data: { kind: "profile_config", mode: "continuous", period_ms: null, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
    } as MessageEvent)).not.toThrow();
    expect(posted.some((m) => (m as { kind: string }).kind === "profile_config")).toBe(false);
  });

  it("does not resend a profile_config request after a reconnect, unlike select", async () => {
    vi.useFakeTimers();
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    self.onmessage!({
      data: { kind: "profile_config", mode: "per_candle", period_ms: 60_000, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
    } as MessageEvent);
    latestSocket().simulateClose();

    await vi.advanceTimersByTimeAsync(500);
    latestSocket().simulateOpen();

    expect(applicationMessages(latestSocket())).toEqual([]);
  });

  it("drops a malformed profile_config request (bad mode, non-integer period_ms, negative range) without crashing or sending anything", async () => {
    const { latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();

    for (const bad of [
      { kind: "profile_config", mode: "bogus", period_ms: null, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
      { kind: "profile_config", mode: "continuous", period_ms: 1.5, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
      { kind: "profile_config", mode: "continuous", period_ms: 0, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
      { kind: "profile_config", mode: "fixed_range", period_ms: null, bin_size_multiplier: 1, range_start_ts: -1, range_end_ts: 100 },
      { kind: "profile_config", mode: "fixed_range", period_ms: null, bin_size_multiplier: 1, range_start_ts: 100, range_end_ts: -1 },
      { kind: "profile_config", mode: "fixed_range", period_ms: null, bin_size_multiplier: 1, range_start_ts: 100, range_end_ts: 100 },
      { kind: "profile_config", mode: "continuous", period_ms: null, bin_size_multiplier: 1, range_start_ts: 1, range_end_ts: 2 },
      { kind: "profile_config", mode: "continuous", period_ms: null, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null, extra: true },
      { kind: "profile_config", mode: "continuous", period_ms: null, bin_size_multiplier: 1, range_start_ts: null },
    ]) {
      expect(() => self.onmessage!({ data: bad } as MessageEvent)).not.toThrow();
    }

    expect(applicationMessages(latestSocket())).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("fails the current socket immediately when sending a profile_config throws", async () => {
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    latestSocket().simulateOpen();
    latestSocket().send = () => {
      throw new DOMException("connection failed", "InvalidStateError");
    };

    self.onmessage!({
      data: { kind: "profile_config", mode: "continuous", period_ms: 60_000, bin_size_multiplier: 1, range_start_ts: null, range_end_ts: null },
    } as MessageEvent);

    expect(latestSocket().closed).toBe(true);
    expect(posted).toContainEqual({ kind: "status", status: "closed", reason: "send-failed:profile_config" });
    expect(console.warn).toHaveBeenCalled();
  });
  it("the byte cap pauses delivery long before the frame cap, and a frozen main thread never triggers a reconnect", async () => {
    vi.useFakeTimers();
    const { posted, latestSocket } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "flow_control" } } as MessageEvent);
    self.onmessage!({ data: { kind: "start", url: "ws://test" } } as MessageEvent);
    const socket = latestSocket();
    socket.simulateOpen();
    const trades = Array.from({ length: 250 }, (_, i) => ({
      type: "trade", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts_exchange: 1_000 + i, price: 78_000.5, size: 1.25, side: "buy", trade_id: `h-${i}`,
    }));
    const reply = JSON.stringify({
      type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
      request_id: 1, from_ts: 0, to_ts: 200_000, min_size: 0, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades,
    });
    const replyBytes = new TextEncoder().encode(reply).byteLength;
    expect(replyBytes).toBeGreaterThan(8 * 1024); // big enough that 4,000 of them would blow past 32 MB
    const fitting = Math.floor((32 * 1024 * 1024) / replyBytes);
    for (let i = 0; i < fitting + 200; i++) socket.simulateMessage(reply);
    const delivered = posted.filter((message) => (message as { kind: string }).kind === "frame").length;
    expect(delivered).toBeLessThan(4_000);
    expect(delivered * replyBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect((delivered + 1) * replyBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(posted.at(-1)).toEqual({ kind: "status", status: "closed", reason: `flow-paused:${delivered + 2}/${2 * 256 + delivered * replyBytes}+${replyBytes}:aggressive_history` });
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeClientWebSocket.instances).toHaveLength(1); // a frozen main thread never triggers a reconnect; the drain-then-reconnect-once path is the test above
    self.onmessage!({ data: { kind: "stop" } } as MessageEvent);
    expect(vi.getTimerCount()).toBe(0);
  });

});
