const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
jest.mock("../../src/providers/shared/instrument-tick-size", () => ({
  createInstrumentTickSizeResolver: () => ({
    getBinanceTickSize: jest.fn(async () => null),
    getDxFeedTickSize: jest.fn(() => null),
  }),
}));
const { createApp } = require("../../src/server/app");
const { safeRm } = require("../helpers/temp-files");
const { createIcebergHistory } = require("../../src/indicators/iceberg/iceberg-history");
const { saveIcebergHistory } = require("../../src/indicators/iceberg/iceberg-store");
const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
const ICEBERG_STORE_DIR = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "app-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

function fakeDxFeedChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    sent,
    getState: () => state,
    send: (payload) => sent.push(payload),
    addMessageListener: (listener) => listeners.message.push(listener),
    removeMessageListener: (listener) => {
      listeners.message = listeners.message.filter((entry) => entry !== listener);
    },
    addErrorListener: (listener) => listeners.error.push(listener),
    removeErrorListener: (listener) => {
      listeners.error = listeners.error.filter((entry) => entry !== listener);
    },
    addStateChangeListener: (listener) => listeners.state.push(listener),
    removeStateChangeListener: (listener) => {
      listeners.state = listeners.state.filter((entry) => entry !== listener);
    },
    close: () => {},
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeDxFeedConnection() {
  const listeners = { error: [], connection: [], auth: [] };
  let connectionState = DXLinkConnectionState.CONNECTING;
  let authState = DXLinkAuthState.UNAUTHORIZED;
  const channel = fakeDxFeedChannel();
  function subscribable(bucket) {
    return (listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    };
  }
  return {
    channel,
    getStatus: () => ({ connectionState, authState }),
    connect: () => {},
    disconnect: () => {},
    openChannel: () => channel,
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    hasAuthListener: () => listeners.auth.length > 0,
    emitAuth: (state, prev) => {
      authState = state;
      [...listeners.auth].forEach((listener) => listener({ state, prev }));
    },
  };
}

async function waitUntil(predicate, { timeoutMs = 2_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("waitUntil: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function disconnectLogs(consoleInfo) {
  return consoleInfo.mock.calls
    .filter(([message]) => message === "app: WebSocket client disconnected")
    .map(([, details]) => details);
}

async function driveDxFeedChannelOpened(connection) {
  // The select message travels over a real socket and is processed
  // asynchronously (route -> startSession -> await token fetch ->
  // register connection listeners); wait for that registration to
  // actually happen before emitting state changes on it.
  await waitUntil(() => connection.hasAuthListener());
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

// A path that deliberately never exists -- these tests exercise the WS
// server on its own, not the storage read path; a real, isolated,
// definitely-missing path keeps the storage reader's fail-soft branch
// the one actually running here, not whatever happens to be at the
// real default location on whichever machine runs this suite.
function noStorageDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-app-test-no-storage-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

// Real end-to-end proof: a real ws.WebSocketServer bound to a real
// ephemeral port, a real ws.WebSocket client connecting to it, and a
// fake-WebSocket-driven Binance connection feeding it -- not just the
// pure orchestration logic market-data-server.test.js already covers in
// isolation. This is what actually proves the wire transport works, not
// just the translation functions.

function createFakeWebSocketImpl() {
  const instances = [];
  class FakeBinanceWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sentMessages = [];
      instances.push(this);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error("cannot send while not open");
      this.sentMessages.push(data);
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
    simulateOpen() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }
    simulateMessage(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  }
  return { WebSocketImpl: FakeBinanceWebSocket, instances };
}

function tradeWire(tradeId) {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: { e: "trade", E: 1786444824142, s: "BTCUSDT", t: tradeId, p: "64275.99", q: "0.002", T: 1786444824142, m: false, M: true },
  });
}

function depthWire({ U, u, pu, b = [], a = [] }) {
  const data = { e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U, u, b, a };
  if (pu !== undefined) {
    data.pu = pu;
  }
  return JSON.stringify({ stream: "btcusdt@depth@100ms", data });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

// DEPTH subscribe now fires a real REST snapshot fetch (market-data-server
// subscribes to it in start()) -- every test needs a fake fetchImpl or it
// would attempt a real network call against Binance.
function fakeFetchImpl() {
  return jest.fn(async (url) => (
    String(url).includes("/klines")
      ? jsonResponse([])
      : jsonResponse({ lastUpdateId: 100, bids: [], asks: [] })
  ));
}

// A plain client.once("message") race-loses against back-to-back server
// sends (e.g. snapshot immediately followed by a book frame on connect):
// if both arrive before the next once-listener is attached, the first
// event fires with no listener present and is gone for good. Buffer
// every message from the moment the client is created instead.
function createMessageReader(client) {
  const queue = [];
  const waiters = [];
  client.on("message", (data) => {
    const parsed = JSON.parse(data.toString());
    if (waiters.length > 0) {
      waiters.shift()(parsed);
    } else {
      queue.push(parsed);
    }
  });
  return function nextMessage() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function runningApp({ fetchImpl = fakeFetchImpl(), ...appOverrides } = {}) {
  const { WebSocketImpl, instances } = createFakeWebSocketImpl();
  const app = createApp({
    port: 0, // ephemeral -- avoid clashing with a real dev server or another test run
    host: "127.0.0.1",
    symbol: "BTCUSDT",
    webSocketImpl: WebSocketImpl,
    fetchImpl,
    dbPath: noStorageDbPath(),
    dxfeedDbPath: noStorageDbPath(),
    volumeProfileCachePath: ":memory:",
    dxfeedBrokerUrl: "",
    ...appOverrides,
  });
  const startPromise = app.start();
  await new Promise((resolve) => setImmediate(resolve));
  const spotSocket = instances.find((i) => i.url.endsWith("stream.binance.com/stream"));
  spotSocket.simulateOpen();
  await startPromise;
  const port = app.httpServer.address().port;
  return { app, spotSocket, port };
}

describe("server/app (real HTTP + real ws client, fake Binance socket)", () => {
  let current;

  afterEach(async () => {
    if (current) {
      await current.app.stop();
      current = null;
    }
  });

  test("the app reads its iceberg store from the suite's temp dir, never from the runtime's data root", async () => {
    const at = Date.now();
    const history = createIcebergHistory({ maxAgeMs: 7 * 86_400_000 });
    history.record({
      id: "BTCUSDT|seeded", kind: "probable", confidence: "probable", side: "ask", price: 64275.99, display: 1, tranches: 3, executed: 2.4,
      startedAt: at - 120_000, markedAt: at - 110_000, updatedAt: at - 60_000, status: "ended", origin: "runtime",
    });
    expect(saveIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey: "SPOT:BTCUSDT", savedAt: at - 60_000, history: history.toJSON(), cuts: null, coverage: [] }).ok).toBe(true);
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await new Promise((resolve) => client.once("open", resolve));
    client.send(JSON.stringify({ type: "capabilities", iceberg_orders: true }));
    let frame = await nextMessage();
    while (frame.type !== "iceberg_orders") frame = await nextMessage();
    expect(frame).toMatchObject({ reset: true, icebergs: [expect.objectContaining({ id: "BTCUSDT|seeded", status: "ended" })] });
    client.close();
  });

  test("a real ws client connects to /ws and immediately receives the current selection, then an empty snapshot frame", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);

    expect(await nextMessage()).toEqual({ type: "selection", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" });
    expect(await nextMessage()).toEqual({ type: "snapshot", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", bars: [], trades: [], markers: [], aggressive_prints: [], aggressive_prints_floor: 0, aggressive_prints_from: expect.any(Number) });

    client.close();
  });

  test("rejects a browser WebSocket from an untrusted origin before it reaches market-data handling", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`, {
      headers: { Origin: "https://untrusted.example" },
    });

    const statusCode = await new Promise((resolve, reject) => {
      client.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      client.once("error", reject);
    });

    expect(statusCode).toBe(403);
    expect(current.app.marketDataServer.clientCount()).toBe(0);
  });

  test("a real trade delivered through the fake Binance socket reaches a real connected ws client as a translated frame", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage(); // the current selection
    await nextMessage(); // the initial snapshot
    await nextMessage(); // the immediate book frame sent on connect
    await nextMessage(); // the aggregate trade/kline health frame

    current.spotSocket.simulateMessage(tradeWire(42));

    expect(await nextMessage()).toEqual(expect.objectContaining({
      type: "trade",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      trade_id: "42",
      side: "buy",
    }));

    client.close();
  });

  test("fans a bounded trade burst to eight real clients without loss and remains health-responsive", async () => {
    const clientCount = 8;
    // Keep the lossless qualification inside the connection's documented
    // 500-item bounded ingress capacity. A larger same-tick injection is an
    // overload test and is intentionally shed rather than allowed to grow
    // memory without bound.
    const tradeCount = 400;
    current = await runningApp({ maxWsClients: clientCount + 2 });
    const clients = Array.from({ length: clientCount }, () => new WebSocket(`ws://127.0.0.1:${current.port}/ws`));

    await Promise.all(clients.map((client) => new Promise((resolve, reject) => {
      if (client.readyState === WebSocket.OPEN) return resolve();
      client.once("open", resolve);
      client.once("error", reject);
    })));
    await waitUntil(() => current.app.router.connectedClientCount() === clientCount);

    const received = new Array(clientCount).fill(0);
    const delivered = clients.map((client, index) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`client ${index} did not receive the complete burst`)), 10_000);
      client.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "trade" || !String(frame.trade_id).startsWith("900")) return;
        received[index] += 1;
        if (received[index] === tradeCount) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }));

    const startedAt = Date.now();
    for (let index = 0; index < tradeCount; index += 1) {
      current.spotSocket.simulateMessage(tradeWire(Number(`900${String(index).padStart(4, "0")}`)));
    }
    await Promise.all(delivered);
    const deliveryElapsedMs = Date.now() - startedAt;

    const health = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${current.port}/health`, (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => resolve(JSON.parse(raw)));
      }).on("error", reject);
    });

    expect(received).toEqual(new Array(clientCount).fill(tradeCount));
    expect(deliveryElapsedMs).toBeLessThan(10_000);
    expect(health).toEqual(expect.objectContaining({ ready: true, connections: clientCount }));

    clients.forEach((client) => client.close());
    await waitUntil(() => current.app.router.connectedClientCount() === 0);
  }, 20_000);

  test("commits one client's instrument switch atomically to every connected real client", async () => {
    current = await runningApp();
    const first = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const second = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const firstReader = createMessageReader(first);
    const secondReader = createMessageReader(second);

    await waitUntil(() => current.app.router.connectedClientCount() === 2);
    async function nextSelection(reader, symbol) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const frame = await reader();
        if (frame.type === "selection" && frame.symbol === symbol) return frame;
      }
      throw new Error(`selection ${symbol} not delivered`);
    }
    await Promise.all([nextSelection(firstReader, "BTC-USDT"), nextSelection(secondReader, "BTC-USDT")]);

    first.send(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" }));

    await expect(Promise.all([
      nextSelection(firstReader, "ETH-USDT"),
      nextSelection(secondReader, "ETH-USDT"),
    ])).resolves.toEqual([
      { type: "selection", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" },
      { type: "selection", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" },
    ]);
    expect(current.app.router.getActiveProvider()).toBe("BINANCE");

    first.close();
    second.close();
  });

  test("a real DEPTH delta delivered through the fake Binance socket reaches a real connected ws client as a book frame", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage(); // the current selection
    await nextMessage(); // the initial snapshot
    await nextMessage(); // the immediate book frame sent on connect (UNAVAILABLE/BUFFERING, no snapshot bridged yet)
    await nextMessage(); // the aggregate trade/kline health frame

    // Let the REST snapshot fetch triggered by the DEPTH subscribe resolve
    // before sending a delta that bridges it -- same real async chain
    // market-data-server.test.js's own DEPTH tests have to wait out.
    await new Promise((resolve) => setImmediate(resolve));

    current.spotSocket.simulateMessage(depthWire({ U: 90, u: 110, b: [["64275.99", "1.5"]], a: [["64276.00", "0.5"]] }));

    expect(await nextMessage()).toEqual({
      type: "book",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      status: "READY",
      bids: [{ price: 64275.99, size: 1.5 }],
      asks: [{ price: 64276, size: 0.5 }],
      lastUpdateId: 110,
      stale: false,
    });

    client.close();
  });

  test("a real select message sent by a real ws client switches the active pair for every connected client", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage(); // the current selection
    await nextMessage(); // the initial snapshot
    await nextMessage(); // the immediate book frame sent on connect
    await nextMessage(); // the aggregate trade/kline health frame

    // Receiving the book frame already proves the connection is open.
    client.send(JSON.stringify({ type: "select", symbol: "ETH-USDT", marketKind: "SPOT" }));

    expect(await nextMessage()).toEqual({ type: "selection", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" });
    expect(await nextMessage()).toEqual({ type: "snapshot", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT", bars: [], trades: [], markers: [] });

    client.close();
  });

  test("an explicit provider: BINANCE select still switches the pair -- proves the router's provider-stripping actually reaches the real strict-3-key market-data-server.js", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage(); // the current selection
    await nextMessage(); // the initial snapshot
    await nextMessage(); // the immediate book frame sent on connect
    await nextMessage(); // the aggregate trade/kline health frame

    client.send(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" }));

    expect(await nextMessage()).toEqual({ type: "selection", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" });

    client.close();
  });

  test("GET /health returns real connection status and the current client count over real HTTP", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage();

    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${current.port}/health`, (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => resolve(JSON.parse(raw)));
      }).on("error", reject);
    });

    expect(body.connections).toBe(1);
    expect(body.ready).toBe(true);
    expect(body.serviceReady).toBe(true);
    expect(body.activeProvider).toBe("BINANCE");
    expect(body.activeRoute).toEqual(expect.objectContaining({
      ready: true,
      identity: expect.objectContaining({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" }),
    }));
    expect(body.status.SPOT.public).toBe("CONNECTED");
    expect(body.delivery).toMatchObject({ backpressureDropped: 0, rawIngressOverflows: 0 });
    expect(body.runtime).toEqual(expect.objectContaining({ processRssBytes: expect.any(Number), eventLoopSamples: expect.any(Number) }));
    expect(body.analytics.profile).toBe("IDLE");
    expect(body.readiness).toEqual(expect.objectContaining({
      dimensions: expect.objectContaining({ transport: expect.any(String), capture: "DEGRADED", storage: "UNAVAILABLE", analytics: expect.any(String) }),
      warmups: expect.any(Object),
    }));
    expect(body.dxfeed.readiness).toEqual(expect.objectContaining({
      dimensions: expect.objectContaining({ transport: "IDLE", capture: "IDLE", storage: "IDLE" }),
      instruments: expect.any(Array),
    }));
    // No collector recording behind this app: the probe says so rather than guessing a fresh one.
    expect(body.recording).toEqual({ symbol: "BTCUSDT", marketKind: "SPOT", available: false, latestTradeTs: null, ageMs: null, stale: true });

    client.close();
  });

  test("closing the ws client is observed server-side: clientCount drops back to zero", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    await createMessageReader(client)();
    expect(current.app.marketDataServer.clientCount()).toBe(1);

    const closed = new Promise((resolve) => client.once("close", resolve));
    client.close();
    await closed;

    // The client observing its own close and the server observing its
    // side of the same socket are two separate async events over a real
    // loopback round trip -- poll briefly rather than guess a fixed delay.
    const deadline = Date.now() + 2000;
    while (current.app.marketDataServer.clientCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(current.app.marketDataServer.clientCount()).toBe(0);
  });

  test("binary client input is rejected at the transport boundary instead of being treated as a select command", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage();
    await nextMessage();
    const closed = new Promise((resolve) => client.once("close", (code) => resolve(code)));

    client.send(Buffer.from('{"type":"select","symbol":"ETH-USDT","marketKind":"SPOT"}'), { binary: true });

    await expect(closed).resolves.toBe(1003);
  });

  test("bounds concurrent WebSocket clients and rejects excess clients without disturbing the admitted client", async () => {
    current = await runningApp({ maxWsClients: 1 });
    const admitted = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(admitted);
    await nextMessage();

    const excess = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const rejected = new Promise((resolve) => excess.once("close", (code) => resolve(code)));
    await expect(rejected).resolves.toBe(1013);
    expect(admitted.readyState).toBe(WebSocket.OPEN);
    expect(current.app.router.connectedClientCount()).toBe(1);
    admitted.close();
  });

  test("bounds all text messages, including malformed traffic that bypasses selection-specific rate limits", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = jest.spyOn(console, "info").mockImplementation(() => {});
    current = await runningApp({ maxClientMessagesPerWindow: 2, clientMessageRateWindowMs: 60_000 });
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage();
    const closed = new Promise((resolve) => client.once("close", (code) => resolve(code)));
    client.send("not-json-1");
    client.send("not-json-2");
    client.send("not-json-3");
    await expect(closed).resolves.toBe(1008);
    await waitUntil(() => disconnectLogs(consoleInfo).length === 1);
    expect(disconnectLogs(consoleInfo)[0]).toMatchObject({ code: 1008, cause: "server-1008", messagesInWindow: 3, remainingClients: 0 });
    expect(disconnectLogs(consoleInfo)[0].ageMs).toBeGreaterThanOrEqual(0);
    consoleError.mockRestore();
    consoleInfo.mockRestore();
  });

  test("terminates a WebSocket peer that misses the heartbeat instead of letting dead sessions consume capacity indefinitely", async () => {
    const consoleInfo = jest.spyOn(console, "info").mockImplementation(() => {});
    current = await runningApp({ wsHeartbeatMs: 20 });
    // A peer that never answers a ping. Marking the server's socket dead raced the client's automatic pong: a ping
    // already in flight brought a pong that marked it alive again, and the test waited for a close that never came.
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`, { autoPong: false });
    const closed = new Promise((resolve) => client.once("close", () => resolve()));
    const nextMessage = createMessageReader(client);
    await nextMessage();

    await closed;
    await waitUntil(() => current.app.router.connectedClientCount() === 0);

    expect(current.app.wss.clients.size).toBe(0);
    await waitUntil(() => disconnectLogs(consoleInfo).length === 1);
    expect(disconnectLogs(consoleInfo)[0]).toMatchObject({ code: 1006, cause: "heartbeat-missed-pong" });
    consoleInfo.mockRestore();
  });

  test("logs a peer-initiated disconnect with the code and reason the browser sent", async () => {
    const consoleInfo = jest.spyOn(console, "info").mockImplementation(() => {});
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage();

    client.close(4001, "tab hidden");

    await waitUntil(() => disconnectLogs(consoleInfo).length === 1);
    expect(disconnectLogs(consoleInfo)[0]).toMatchObject({ code: 4001, reason: "tab hidden", cause: "peer" });
    consoleInfo.mockRestore();
  });

  test("a port collision rejects startup cleanly without an unhandled WebSocketServer error", async () => {
    const occupied = http.createServer();
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const app = createApp({
      port: occupied.address().port,
      host: "127.0.0.1",
      symbol: "BTCUSDT",
      webSocketImpl: WebSocketImpl,
      fetchImpl: fakeFetchImpl(),
      dbPath: noStorageDbPath(),
      dxfeedDbPath: noStorageDbPath(),
      volumeProfileCachePath: ":memory:",
      dxfeedBrokerUrl: "",
    });

    const startup = app.start();
    await expect(startup).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(instances).toHaveLength(0);
    await new Promise((resolve) => occupied.close(resolve));
  });

  test("stop waits for the HTTP and WebSocket listeners to close and remains idempotent", async () => {
    current = await runningApp();
    const firstStop = current.app.stop();
    const secondStop = current.app.stop();

    expect(secondStop).toBe(firstStop);
    await firstStop;
    expect(current.app.httpServer.listening).toBe(false);
    current = null;
  });

  test("stop terminates an attached WebSocket client instead of waiting indefinitely for it to close itself", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    await nextMessage();
    const closed = new Promise((resolve) => client.once("close", resolve));

    await current.app.stop();

    await expect(closed).resolves.toBeDefined();
    expect(current.app.httpServer.listening).toBe(false);
    current = null;
  });

  test("createApp rejects an unproven symbol before opening any sockets", () => {
    expect(() => createApp({ symbol: "DOGEUSDT", webSocketImpl: class {} })).toThrow(/Unproven Binance symbol/);
  });

  test("createApp rejects invalid client capacity and rate controls before opening sockets", () => {
    expect(() => createApp({ maxWsClients: 0 })).toThrow(/maxWsClients/);
    expect(() => createApp({ maxClientMessagesPerWindow: 0 })).toThrow(/maxClientMessagesPerWindow/);
    expect(() => createApp({ clientMessageRateWindowMs: 1.5 })).toThrow(/clientMessageRateWindowMs/);
    expect(() => createApp({ wsHeartbeatMs: 0 })).toThrow(/wsHeartbeatMs/);
  });

  test("starts and serves Binance normally with no dxFeed broker configured at all", async () => {
    current = await runningApp();
    const client = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const nextMessage = createMessageReader(client);
    expect(await nextMessage()).toEqual({ type: "selection", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" });
    expect(current.app.dxfeedMarketDataServer.isActive()).toBe(false);
    client.close();
  });

  test("two clients move together from Binance to a real dxFeed session and receive the same live trade end to end", async () => {
    const connection = fakeDxFeedConnection();
    current = await runningApp({
      dxfeedBrokerUrl: "https://broker.example.ts.net",
      dxfeedCreateConnection: () => connection,
      dxfeedRequestToken: async () => ({ token: "fresh.token", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    });
    const first = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const second = new WebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const firstReader = createMessageReader(first);
    const secondReader = createMessageReader(second);
    async function waitFor(nextMessage, predicate) {
      const deadline = Date.now() + 2_000;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        let timeout;
        const frame = await Promise.race([
          nextMessage(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("timed out waiting for a frame")), remainingMs);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (predicate(frame)) return frame;
      }
      throw new Error("waitFor: no matching frame arrived within the deadline");
    }

    await Promise.all([
      waitFor(firstReader, (frame) => frame.type === "selection" && frame.provider === "BINANCE"),
      waitFor(secondReader, (frame) => frame.type === "selection" && frame.provider === "BINANCE"),
    ]);

    first.send(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }));
    await driveDxFeedChannelOpened(connection);

    await Promise.all([
      waitFor(firstReader, (frame) => frame.type === "selection" && frame.provider === "DXFEED" && frame.symbol === "AAPL"),
      waitFor(secondReader, (frame) => frame.type === "selection" && frame.provider === "DXFEED" && frame.symbol === "AAPL"),
    ]);
    expect(current.app.router.getActiveProvider()).toBe("DXFEED");
    expect(current.app.dxfeedMarketDataServer.isActive()).toBe(true);

    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{
        eventType: "TimeAndSale", eventSymbol: "AAPL", eventTime: 0, eventFlags: 0,
        index: 7679136203203489000, time: Date.now(), timeNanoPart: 0, sequence: 601002,
        exchangeCode: "Q", price: 230.5, size: 5, bidPrice: 230.4, askPrice: 230.6,
        exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY", spreadLeg: false,
        extendedTradingHours: true, validTick: false, type: "NEW",
      }],
    });

    await Promise.all([
      waitFor(firstReader, (frame) => frame.type === "health" && frame.provider === "DXFEED" && frame.recoveryState === "READY"),
      waitFor(secondReader, (frame) => frame.type === "health" && frame.provider === "DXFEED" && frame.recoveryState === "READY"),
    ]);
    await Promise.all([
      waitFor(firstReader, (frame) => frame.type === "trade" && frame.provider === "DXFEED" && frame.symbol === "AAPL" && frame.price === 230.5),
      waitFor(secondReader, (frame) => frame.type === "trade" && frame.provider === "DXFEED" && frame.symbol === "AAPL" && frame.price === 230.5),
    ]);

    const health = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${current.port}/health`, (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => resolve(JSON.parse(raw)));
      }).on("error", reject);
    });
    expect(health).toEqual(expect.objectContaining({
      connections: 2,
      ready: true,
      serviceReady: true,
      activeProvider: "DXFEED",
      activeRoute: expect.objectContaining({
        ready: true,
        identity: { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" },
      }),
      dxfeed: expect.objectContaining({
        active: true,
        recoveryState: "READY",
        selection: { symbol: "AAPL", assetClass: "EQUITY" },
        orderV2Capture: expect.objectContaining({ healthy: true, lastFailure: null }),
        instruments: [expect.objectContaining({
          symbol: "AAPL", assetClass: "EQUITY",
          l1: { recoveryState: "READY", quiet: false },
        })],
      }),
    }));

    first.close();
    second.close();
  }, 15_000);

  test("dxfeedEager selects the eager, all-instrument dxFeed server -- it connects at boot with zero clients, unlike the default lazy factory", async () => {
    // Every instrument (futures and equities alike) now shares one STREAM
    // channel (TimeAndSale + Order merged, DX3.05/Phase C's channel
    // collapse), same topology as fakeDxFeedConnection() above's
    // single-channel lazy session.
    function fakeEagerDxFeedConnection() {
      const listeners = { error: [], connection: [], auth: [] };
      const channels = [];
      function fakeChannel() {
        const stateListeners = [];
        return {
          getState: () => "REQUESTED",
          send: () => {},
          addMessageListener: () => {},
          removeMessageListener: () => {},
          addErrorListener: () => {},
          removeErrorListener: () => {},
          addStateChangeListener: (listener) => stateListeners.push(listener),
          removeStateChangeListener: (listener) => {
            const index = stateListeners.indexOf(listener);
            if (index !== -1) stateListeners.splice(index, 1);
          },
          close: () => {},
          emitOpened: () => stateListeners.forEach((listener) => listener(DXLinkChannelState.OPENED)),
        };
      }
      function subscribable(bucket) {
        return (listener) => {
          listeners[bucket].push(listener);
          return () => {
            listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
          };
        };
      }
      return {
        channels,
        getStatus: () => ({ connectionState: DXLinkConnectionState.CONNECTING, authState: DXLinkAuthState.UNAUTHORIZED }),
        connect: () => {},
        disconnect: () => {},
        openChannel: () => {
          const channel = fakeChannel();
          channels.push(channel);
          return channel;
        },
        onError: subscribable("error"),
        onConnectionStateChange: subscribable("connection"),
        onAuthStateChange: subscribable("auth"),
        hasAuthListener: () => listeners.auth.length > 0,
        emitAuth: (state, prev) => [...listeners.auth].forEach((listener) => listener({ state, prev })),
      };
    }

    const connection = fakeEagerDxFeedConnection();
    current = await runningApp({
      dxfeedEager: true,
      dxfeedBrokerUrl: "https://broker.example.ts.net",
      dxfeedCreateConnection: () => connection,
      dxfeedRequestToken: async () => ({ token: "fresh.token", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    });

    await waitUntil(() => connection.hasAuthListener());
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await waitUntil(() => connection.channels.length >= 1);
    connection.channels[0].emitOpened();
    await waitUntil(() => current.app.dxfeedMarketDataServer.isActive());

    // Proven with zero clients ever having connected -- this is exactly
    // what distinguishes the eager factory from the default lazy one.
    expect(current.app.router.connectedClientCount()).toBe(0);
    expect(current.app.dxfeedMarketDataServer.isActive()).toBe(true);
    expect(current.app.dxfeedMarketDataServer.currentSymbolInfo()).toBeNull();
  });

  test("createApp rejects invalid bind controls before creating a listening server", () => {
    expect(() => createApp({ port: -1, webSocketImpl: class {} })).toThrow(/port/);
    expect(() => createApp({ port: 65_536, webSocketImpl: class {} })).toThrow(/port/);
    expect(() => createApp({ host: "", webSocketImpl: class {} })).toThrow(/host/);
    expect(() => createApp({ host: "0.0.0.0", webSocketImpl: class {} })).toThrow(/loopback/);
    expect(() => createApp({ allowedOrigins: [""], webSocketImpl: class {} })).toThrow(/allowedOrigins/);
    expect(() => createApp({ allowedOrigins: ["*"], webSocketImpl: class {} })).toThrow(/allowedOrigins/);
    expect(() => createApp({ allowedOrigins: ["ws://localhost:8000"], webSocketImpl: class {} })).toThrow(/allowedOrigins/);
    expect(() => createApp({ allowedOrigins: ["http://localhost:8000/path"], webSocketImpl: class {} })).toThrow(/allowedOrigins/);
  });

  test("with no liveStorageServiceUrl configured, storageReader stays the local sqlite reader", () => {
    const dbPath = noStorageDbPath();
    const dxfeedDbPath = noStorageDbPath();
    const app = createApp({ webSocketImpl: class {}, dbPath, dxfeedDbPath, volumeProfileCachePath: ":memory:", dxfeedBrokerUrl: "" });
    expect(app.storageReader.dbPath).toBe(dbPath);
    expect(app.storageReader.remote).toBeUndefined();
    expect(app.dxfeedStorageReader.dbPath).toBe(dxfeedDbPath);
    expect(app.dxfeedStorageReader.remote).toBeUndefined();
  });

  test("a liveStorageServiceUrl with a token switches storageReader to the remote reader instead of the local one", () => {
    const app = createApp({
      webSocketImpl: class {},
      dbPath: noStorageDbPath(),
      dxfeedDbPath: noStorageDbPath(),
      volumeProfileCachePath: ":memory:",
      dxfeedBrokerUrl: "",
      liveStorageServiceUrl: "http://10.88.0.1:8003",
      liveStorageClientToken: "dev-token",
    });
    expect(app.storageReader.dbPath).toBeUndefined();
    expect(app.storageReader.remote).toEqual({ baseUrl: "http://10.88.0.1:8003", token: "dev-token", timeoutMs: 5_000 });
    expect(app.dxfeedStorageReader.dbPath).toBeUndefined();
    expect(app.dxfeedStorageReader.remote).toEqual({
      provider: "dxfeed", baseUrl: "http://10.88.0.1:8003", token: "dev-token", timeoutMs: 5_000,
    });
  });

  test("a liveStorageServiceUrl with no token falls back to the local reader instead of crashing startup", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = noStorageDbPath();
    const app = createApp({
      webSocketImpl: class {},
      dbPath,
      dxfeedDbPath: noStorageDbPath(),
      volumeProfileCachePath: ":memory:",
      dxfeedBrokerUrl: "",
      liveStorageServiceUrl: "http://10.88.0.1:8003",
    });
    expect(app.storageReader.dbPath).toBe(dbPath);
    expect(app.storageReader.remote).toBeUndefined();
    expect(app.dxfeedStorageReader.dbPath).toBeDefined();
    expect(app.dxfeedStorageReader.remote).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "app: remote storage reader misconfigured, falling back to local",
      expect.stringMatching(/token must be a non-empty string/),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "app: remote dxFeed storage reader misconfigured, falling back to local",
      expect.stringMatching(/token must be a non-empty string/),
    );
    consoleError.mockRestore();
  });

  test("serves the heatmap history at /heatmap/columns from the local pyramid when it reads locally, to the allowed origins only (P4c.4)", async () => {
    const fs = require("node:fs");
    const { openPyramidStore } = require("../../src/indicators/l2-memory/pyramid/pyramid-store");
    const { WINDOW_MS, foldLevels } = require("../../src/indicators/l2-memory/pyramid/pyramid-levels");
    const heatmapDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-heatmap-"));
    const W0 = Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS;
    const store = openPyramidStore({ dir: heatmapDir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ tickSize: 0.1, clusterTicks: 5, rowClusters: 8, rowWidth: 4, windowRows: 1023, sizeDigits: 4, snapshotDepth: 1000, columnMs: 1_000, replayWarmupMs: 1_800_000, rowBp: 0.5, windowBp: 600, referenceBp: 50 });
    const base = Array.from({ length: 30 }, (_, i) => Object.freeze({ ts: W0 + i * 10_000, lo: 100, hi: 101, bid: Float64Array.from([1, i]), ask: Float64Array.from([2, 0]) }));
    store.putWindow({ windowTs: W0, state: "COVERED", columns: 30, frames: 1, builtAt: 1, levels: foldLevels(base) });
    store.close();
    current = await runningApp({ heatmapDir });
    const post = (origin) => fetch(`http://127.0.0.1:${current.port}/heatmap/columns`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", levelMs: 300_000, fromTs: W0, toTs: W0 + WINDOW_MS }),
    });
    const served = await post("http://127.0.0.1:8000");
    expect(served.status).toBe(200);
    const page = await served.json();
    expect(page).toMatchObject({ available: true, levelMs: 300_000, geometry: { rowWidth: 4 }, windows: [{ ts: W0, state: "COVERED" }] });
    expect(page.windows[0].columns).toHaveLength(1);
    expect((await post("https://elsewhere.example")).status).toBe(403);
  });

  test("serves the host's wall history at /heatmap/walls from the local pyramid when it reads locally, to the allowed origins only", async () => {
    const fs = require("node:fs");
    const { openPyramidStore } = require("../../src/indicators/l2-memory/pyramid/pyramid-store");
    const { WINDOW_MS, foldLevels } = require("../../src/indicators/l2-memory/pyramid/pyramid-levels");
    const heatmapDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-heatmap-walls-"));
    const W0 = Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS;
    const store = openPyramidStore({ dir: heatmapDir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ tickSize: 0.1, clusterTicks: 5, rowClusters: 8, rowWidth: 4, windowRows: 1023, sizeDigits: 4, snapshotDepth: 1000, columnMs: 1_000, replayWarmupMs: 1_800_000, rowBp: 0.5, windowBp: 600, referenceBp: 50 });
    const base = Array.from({ length: 30 }, (_, i) => Object.freeze({ ts: W0 + i * 10_000, lo: 100, hi: 101, bid: Float64Array.from([1, i]), ask: Float64Array.from([2, 0]) }));
    const wall = { side: "bid", row: 100, span: 1, startTs: W0 - 50_000, endTs: W0 + 100_000, size: 0, peak: 50, endedBy: "hit", ratio: 2, chain: 0, fill: 0.5, eaten: 0.2, absorbing: false };
    const events = { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: W0, until: W0 + WINDOW_MS }, trades: [], wallTrades: [] };
    store.putWindow({ windowTs: W0, state: "COVERED", columns: 30, frames: 1, builtAt: 1, levels: foldLevels(base), walls: [wall], events });
    store.close();
    current = await runningApp({ heatmapDir });
    const post = (origin) => fetch(`http://127.0.0.1:${current.port}/heatmap/walls`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", fromTs: W0, toTs: W0 + WINDOW_MS, limit: 10 }),
    });
    const served = await post("http://127.0.0.1:8000");
    expect(served.status).toBe(200);
    const page = await served.json();
    expect(page).toMatchObject({ available: true, geometry: { rowWidth: 4 }, next: null });
    expect(page.walls).toHaveLength(1);
    expect(page.walls[0]).toMatchObject({ side: "bid", row: 100, startTs: W0 - 50_000, endTs: W0 + 100_000, peak: 50, endedBy: "hit" });
    expect((await post("https://elsewhere.example")).status).toBe(403);
  });
});
