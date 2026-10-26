// The heatmap's every-pair sampling keeps feeds open across a switch; these tests assert the single-pair lifecycle.
process.env.L2_HEATMAP_TRACK_ALL = "0";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../helpers/temp-files");
const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
// Every server here keeps its iceberg store in this temp dir, never in the runtime's data root.
const ICEBERG_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "binance-server-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});
jest.mock("../../src/providers/shared/instrument-tick-size", () => ({
  createInstrumentTickSizeResolver: () => ({
    getBinanceTickSize: jest.fn(async () => null),
    getDxFeedTickSize: jest.fn(() => null),
  }),
}));
const {
  createBinanceConnection,
} = require("../../src/providers/binance/binance-connection");
const {
  createMarketDataServer,
  BACKFILL_DAYS,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  MAX_SELECTIONS_PER_WINDOW,
  VPIN_WARMUP_REMOTE_TIMEOUT_MS,
} = require("../../src/server/market-data-server");
const {
  createHistoryBuffer,
  DEFAULT_MAX_MARKERS,
} = require("../../src/server/history");
const {
  MAX_SNAPSHOT_MARKERS,
  MAX_MARKER_HISTORY_ROWS,
  markerHistoryFrame,
} = require("../../src/server/frames");
const {
  validateQueryBounds,
  MAX_ROW_LIMIT_BY_ROUTE,
} = require("../../src/server/live-storage-route");
const {
  createVpinState,
  ingestVpinTrade,
} = require("../../src/indicators/vpin/vpin-engine");
// L1L2-V2-106. The worker-offload path is gated on canOffload, which needs BOTH
// storageReader.dbPath and volumeProfileCache.dbPath to be strings. No fake in
// this file supplied either, so the whole offload branch -- including all three
// job-cancel triggers -- never executed. Every one of them could be deleted with
// the full 2,651-test runtime suite still green.
//
// The job itself is spawned through a real Worker, so it is mocked here: this
// suite's subject is the SERVER's lifecycle wiring, not the worker.
const mockHistoryJobCancel = jest.fn();
const mockStartHistoryJob = jest.fn(() => ({
  promise: new Promise(() => {}), // never settles, so the job stays "in flight"
  cancel: mockHistoryJobCancel,
}));
jest.mock(
  "../../src/indicators/volume-profile/volume-profile-history-job",
  () => ({
    startVolumeProfileHistoryJob: (...args) => mockStartHistoryJob(...args),
  }),
);

// Same fake-WebSocket shape binance-connection.test.js already uses to
// drive the connection layer without hitting live Binance.
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

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeClient() {
  return {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };
}

function tradeWire(
  tradeId,
  { price = "64275.99", quantity = "0.002", eventTimeMs = Date.now() } = {},
) {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: {
      e: "trade",
      E: eventTimeMs,
      s: "BTCUSDT",
      t: tradeId,
      p: price,
      q: quantity,
      T: eventTimeMs,
      m: false,
      M: true,
    },
  });
}

function klineWire({ closed = false, openTime = 1786449720000 } = {}) {
  return JSON.stringify({
    stream: "btcusdt@kline_1m",
    data: {
      e: "kline",
      E: 1786449754019,
      s: "BTCUSDT",
      k: {
        t: openTime,
        T: openTime + 59_999,
        s: "BTCUSDT",
        i: "1m",
        f: 1,
        L: 2,
        o: "64419.99",
        c: "64435.29",
        h: "64436.00",
        l: "64419.99",
        v: "5.7233",
        n: 10,
        x: closed,
        q: "1",
        V: "1",
        Q: "1",
        B: "0",
      },
    },
  });
}

function depthWire({ U, u, pu, b = [], a = [] }) {
  const data = { e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U, u, b, a };
  if (pu !== undefined) {
    data.pu = pu;
  }
  return JSON.stringify({ stream: "btcusdt@depth@100ms", data });
}

// A raw wire message the normalizer degrades to state:"UNAVAILABLE" --
// missing the required lastUpdateId (u) field.
function malformedDepthWire() {
  return JSON.stringify({
    stream: "btcusdt@depth@100ms",
    data: { e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U: 1, b: [], a: [] },
  });
}

// Every server created via this helper is auto-stopped in afterEach --
// otherwise the health-poll setInterval (20ms here) keeps firing past the
// end of whichever test created it, the same dangling-timer class that
// has bitten this project's own connection-layer tests before.
let serversToStop = [];

afterEach(() => {
  for (const server of serversToStop) {
    server.stop();
  }
  serversToStop = [];
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

// A real, empty-but-valid REST depth snapshot and an empty-but-valid
// REST klines page -- start() now fires both a DEPTH snapshot request
// (subscribe()'s own existing behavior) and a kline backfill request
// (ensurePairWarm) for real, so every test using this helper would
// otherwise hit live Binance for both. URL-routed so each gets a
// response shaped correctly for what actually asked -- an empty klines
// array is genuinely valid (parseKlineRows([]) === []), unlike the
// depth-shaped object that used to be returned for every request
// before backfill existed, which the real kline-row parser would
// (correctly) reject as malformed.
function fakeFetchImpl() {
  return jest.fn(async (url) => {
    if (String(url).includes("/klines")) {
      return jsonResponse([]);
    }
    return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
  });
}

function selectWire(symbol, marketKind) {
  return JSON.stringify({ type: "select", symbol, marketKind });
}

// PERPETUAL's TRADE/DEPTH route through "public"; KLINE routes through
// "market" (ROUTE_FOR_EVENT_TYPE.PERPETUAL in binance-connection.js) --
// a switch to PERPETUAL needs both open, or subscribe() throws for
// whichever route isn't CONNECTED yet.
function perpetualPublicSocket(instances) {
  return instances.find((i) =>
    i.url.endsWith("fstream.binance.com/public/stream"),
  );
}
function perpetualMarketSocket(instances) {
  return instances.find((i) =>
    i.url.endsWith("fstream.binance.com/market/stream"),
  );
}

async function startedServer({
  fetchImpl = fakeFetchImpl(),
  ...overrides
} = {}) {
  const { WebSocketImpl, instances } = createFakeWebSocketImpl();
  const connection = createBinanceConnection({
    webSocketImpl: WebSocketImpl,
    fetchImpl,
  });
  const server = createMarketDataServer({
    connection,
    symbol: "BTCUSDT",
    connectPollMs: 5,
    healthPollMs: 20,
    ...overrides,
  });
  serversToStop.push(server);
  const startPromise = server.start();
  // The route only becomes CONNECTED once its socket simulates onopen;
  // the poll picks that up on its next tick.
  await new Promise((resolve) => setImmediate(resolve));
  const spotSocket = instances.find((i) =>
    i.url.endsWith("stream.binance.com/stream"),
  );
  spotSocket.simulateOpen();
  // connect() opens every route (SPOT public, PERPETUAL public, PERPETUAL
  // market) up front, exactly like a real live connection would -- open
  // all of them here too so any test can switch to PERPETUAL without a
  // separate helper.
  perpetualPublicSocket(instances)?.simulateOpen();
  perpetualMarketSocket(instances)?.simulateOpen();
  await startPromise;
  return { server, spotSocket, connection, instances };
}

describe("server/market-data-server", () => {
  test("the slow-client threshold exceeds the largest permitted initial snapshot", () => {
    const bar = {
      type: "bar",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "PERPETUAL",
      interval_ms: 60_000,
      ts_open: 8_640_000_000_000_000,
      open: 10_000_000,
      high: 10_000_000,
      low: 10_000_000,
      close: 10_000_000,
      volume: 10_000_000,
      trade_count: Number.MAX_SAFE_INTEGER,
      closed: true,
    };
    const trade = {
      type: "trade",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "PERPETUAL",
      ts_exchange: 8_640_000_000_000_000,
      price: 10_000_000,
      size: 10_000_000,
      side: "sell",
      trade_id: "9".repeat(128),
    };
    const marker = {
      type: "marker",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "PERPETUAL",
      ts_exchange: 8_640_000_000_000_000,
      price: 10_000_000,
      size: 10_000_000,
      side: "sell",
      trade_id: "9".repeat(128),
      // Every real marker now carries these once a symbol's baseline has
      // enough samples -- a worst-case snapshot must include them, not the
      // pre-Tier-1 shape that omitted them.
      baseline_log_median: -99.99999999999999,
      baseline_log_mad: 99.99999999999999,
    };
    const largestSnapshot = JSON.stringify({
      type: "snapshot",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "PERPETUAL",
      bars: Array(10_080).fill(bar),
      trades: Array(100).fill(trade),
      markers: Array(MAX_SNAPSHOT_MARKERS).fill(marker),
    });

    expect(Buffer.byteLength(largestSnapshot)).toBeLessThan(
      MAX_CLIENT_BUFFERED_BYTES,
    );

    // The rest of the retained markers travel as separate, paced history
    // chunks; the largest possible chunk must fit under the threshold too.
    const widestMarkers = Array.from(
      { length: MAX_MARKER_HISTORY_ROWS },
      (_, index) => ({
        ...marker,
        trade_id: `${"9".repeat(120)}${String(index).padStart(8, "0")}`,
      }),
    );
    const largestChunk = JSON.stringify(
      markerHistoryFrame(
        { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
        { reset: true, seq: 0, markers: widestMarkers },
      ),
    );
    expect(Buffer.byteLength(largestChunk)).toBeLessThan(
      MAX_CLIENT_BUFFERED_BYTES / 4,
    );
    expect(DEFAULT_MAX_MARKERS).toBeGreaterThan(MAX_SNAPSHOT_MARKERS);
  });

  test("rejects invalid constructor selection and timer controls before opening a connection", () => {
    const connection = {};
    expect(() =>
      createMarketDataServer({ connection, symbol: "DOGEUSDT" }),
    ).toThrow(/symbol must be an allowed/);
    expect(() =>
      createMarketDataServer({
        connection,
        symbol: "BTCUSDT",
        marketKind: "MARGIN",
      }),
    ).toThrow(/marketKind must be an allowed/);
    expect(() =>
      createMarketDataServer({
        connection,
        symbol: "BTCUSDT",
        connectPollMs: 0,
      }),
    ).toThrow(/connectPollMs/);
    expect(() =>
      createMarketDataServer({
        connection,
        symbol: "BTCUSDT",
        connectTimeoutMs: 1.5,
      }),
    ).toThrow(/connectTimeoutMs/);
    expect(() =>
      createMarketDataServer({
        connection,
        symbol: "BTCUSDT",
        healthPollMs: -1,
      }),
    ).toThrow(/healthPollMs/);
  });

  test("start() waits for the route to connect, then subscribes to TRADE, KLINE 1m, and DEPTH", async () => {
    const { spotSocket } = await startedServer();
    const sent = spotSocket.sentMessages.map((m) => JSON.parse(m));
    expect(sent).toHaveLength(1);
    expect(sent.every((m) => m.method === "SUBSCRIBE")).toBe(true);
    expect(sent.flatMap((m) => m.params)).toEqual(
      expect.arrayContaining([
        "btcusdt@trade",
        "btcusdt@kline_1m",
        "btcusdt@depth@100ms",
      ]),
    );
  });

  test("a transient destination subscribe failure preserves the active pair and a later client retry can commit the switch", async () => {
    let perpetualKlineAttempts = 0;
    const connection = {
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
      subscribe: ({ marketKind, eventType }) => {
        if (marketKind === "PERPETUAL" && eventType === "KLINE") {
          perpetualKlineAttempts += 1;
          if (perpetualKlineAttempts === 1) {
            throw new Error("perpetual market route is still reconnecting");
          }
        }
      },
      unsubscribe() {},
      getStatus: () => ({
        SPOT: { public: "CONNECTED" },
        PERPETUAL: { public: "CONNECTED", market: "CONNECTED" },
      }),
      getFeedHealth: () => undefined,
      getOrderBook: () => undefined,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
      healthPollMs: 5,
    });
    serversToStop.push(server);
    await server.start();

    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    expect(() =>
      server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL")),
    ).toThrow(/market route is still reconnecting/);
    expect(client.sent.filter((frame) => frame.type === "selection")).toEqual(
      [],
    );

    expect(() =>
      server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL")),
    ).not.toThrow();

    expect(perpetualKlineAttempts).toBeGreaterThanOrEqual(2);
    expect(client.sent.filter((frame) => frame.type === "selection")).toEqual([
      {
        type: "selection",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "PERPETUAL",
      },
    ]);
  });

  describe("a selection made before its Binance routes connect", () => {
    function startupConnection() {
      const status = {
        SPOT: { public: "CONNECTED" },
        PERPETUAL: { public: "CONNECTED", market: "CONNECTING" },
      };
      const subscribed = [];
      const connection = {
        onMessage: () => () => {},
        connect() {},
        disconnect() {},
        subscribe: (request) => {
          if (request.marketKind === "PERPETUAL" && status.PERPETUAL.market !== "CONNECTED") {
            throw new Error("Cannot subscribe before the Binance PERPETUAL market route is connected.");
          }
          subscribed.push(`${request.marketKind}:${request.eventType}`);
        },
        unsubscribe() {},
        getStatus: () => status,
        getFeedHealth: () => undefined,
        getOrderBook: () => undefined,
        fetchRecentKlines: async () => ({ ok: true, rows: [] }),
      };
      return { connection, status, subscribed };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
    const selections = (client) => client.sent.filter((frame) => frame.type === "selection").map((frame) => `${frame.symbol}:${frame.marketKind}`);

    test("is held, keeps the client connected, and is applied once the routes connect", async () => {
      const { connection, status, subscribed } = startupConnection();
      const server = createMarketDataServer({ connection, symbol: "BTCUSDT", connectPollMs: 5, healthPollMs: 1_000 });
      serversToStop.push(server);
      await server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      expect(() => server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL"), client)).not.toThrow();
      await settle();
      expect(selections(client)).toEqual([]);

      status.PERPETUAL.market = "CONNECTED";
      await settle();
      expect(selections(client)).toEqual(["BTC-USDT:PERPETUAL"]);
      expect(subscribed).toEqual(expect.arrayContaining(["PERPETUAL:TRADE", "PERPETUAL:KLINE", "PERPETUAL:DEPTH"]));
    });

    test("is dropped when the active pair is chosen again before the routes connect", async () => {
      const { connection, status } = startupConnection();
      const server = createMarketDataServer({ connection, symbol: "BTCUSDT", connectPollMs: 5, healthPollMs: 1_000 });
      serversToStop.push(server);
      await server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL"), client);
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"), client);
      status.PERPETUAL.market = "CONNECTED";
      await settle();
      expect(selections(client)).toEqual([]);
    });

    test("still surfaces a failure when the routes report connected", async () => {
      const { connection, status } = startupConnection();
      status.PERPETUAL.market = "CONNECTED";
      connection.subscribe = () => {
        throw new Error("perpetual market route is still reconnecting");
      };
      const server = createMarketDataServer({ connection, symbol: "BTCUSDT", connectPollMs: 5, healthPollMs: 1_000 });
      serversToStop.push(server);
      connection.subscribe = () => {};
      await server.start();
      connection.subscribe = () => {
        throw new Error("perpetual market route is still reconnecting");
      };
      expect(() => server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL"))).toThrow(/still reconnecting/);
    });
  });

  test("a live trade broadcasts a translated frame to every connected client", async () => {
    // A fresh subscribe leaves feed health RECOVERING until a real event
    // proves it (P1.04 behavior) -- so this first trade legitimately also
    // flips health to READY and broadcasts that too. Filtering by type
    // isolates the trade-translation assertion from that real, separate
    // transition, which has its own dedicated test below.
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = []; // drop the initial snapshot, isolate the trade frame

    spotSocket.simulateMessage(tradeWire(1));
    await flushAsync();

    expect(client.sent.filter((f) => f.type === "trade")).toEqual([
      expect.objectContaining({
        type: "trade",
        symbol: "BTC-USDT",
        trade_id: "1",
        side: "buy",
      }),
    ]);
  });

  test("a replayed trade id is neither rebroadcast nor duplicated in client history", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.simulateMessage(tradeWire(77));
    spotSocket.simulateMessage(tradeWire(77));
    await flushAsync();

    expect(
      client.sent.filter(
        (frame) => frame.type === "trade" && frame.trade_id === "77",
      ),
    ).toHaveLength(1);
  });

  test("a malformed trade (missing required price field) degrades to state:UNAVAILABLE at the normalizer and is silently absorbed here -- no frame, no crash, no corrupted state for the next real trade", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    const malformed = JSON.stringify({
      stream: "btcusdt@trade",
      data: {
        e: "trade",
        E: 1786444824142,
        s: "BTCUSDT",
        t: 999,
        q: "0.002",
        T: 1786444824142,
        m: false,
        M: true,
      },
    });
    expect(() => spotSocket.simulateMessage(malformed)).not.toThrow();
    await flushAsync();
    expect(client.sent).toEqual([]);

    spotSocket.simulateMessage(tradeWire(1000));
    await flushAsync();
    expect(client.sent.filter((f) => f.type === "trade")).toEqual([
      expect.objectContaining({ type: "trade", trade_id: "1000" }),
    ]);
  });

  test("a still-forming kline broadcasts but is not recorded into history; a closed one is both", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.simulateMessage(klineWire({ closed: false }));
    await flushAsync();
    expect(client.sent.filter((f) => f.type === "bar")).toEqual([
      expect.objectContaining({ type: "bar", closed: false }),
    ]);

    spotSocket.simulateMessage(klineWire({ closed: true }));
    await flushAsync();
    expect(client.sent.filter((f) => f.type === "bar")[1]).toEqual(
      expect.objectContaining({ type: "bar", closed: true }),
    );

    const freshClient = fakeClient();
    server.handleClientConnected(freshClient);
    expect(freshClient.sent.find((f) => f.type === "snapshot")).toEqual({
      type: "snapshot",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      bars: [expect.objectContaining({ closed: true })],
      trades: [],
      markers: [],
    });
  });

  test("a newly connected client immediately receives selection, snapshot, book, and aggregate health in that order", async () => {
    const historyBuffer = createHistoryBuffer();
    const { server } = await startedServer({ historyBuffer });
    const client = fakeClient();

    server.handleClientConnected(client);

    expect(client.sent).toEqual([
      {
        type: "selection",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
      },
      {
        type: "snapshot",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [],
      },
      expect.objectContaining({
        type: "book",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
      }),
      expect.objectContaining({
        type: "health",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
      }),
    ]);
  });

  // Property: a client that connects while the pair holds more markers than the
  // snapshot may carry inline gets the newest ones in the snapshot and every
  // retained marker, oldest first, as paced marker_history pages that start with
  // a reset. Oracle: the history buffer's own sorted snapshot, expanded row by row.
  test("marker history is withheld from legacy clients and sent reset-first after an explicit capability opt-in", async () => {
    const historyBuffer = createHistoryBuffer();
    const base = Date.now() - 24 * 60 * 60 * 1000;
    for (let index = 0; index < 12_000; index += 1) {
      historyBuffer.recordMarker({
        type: "marker",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        ts_exchange: base + index * 60_000 + (index % 3),
        price: 64_000 + (index % 97),
        size: 1 + (index % 5),
        side: index % 2 ? "buy" : "sell",
        trade_id: `hist-${index}`,
      });
    }
    const retained = historyBuffer.snapshotMarkers();
    expect(retained).toHaveLength(12_000);
    const { server } = await startedServer({ historyBuffer });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushAsync();
    expect(client.sent.some((frame) => frame.type === "marker_history")).toBe(
      false,
    );
    server.handleClientMessage(
      JSON.stringify({ type: "capabilities", marker_history: true }),
      client,
    );
    await flushAsync();

    const kinds = client.sent.map((frame) => frame.type);
    expect(kinds.slice(0, 4)).toEqual([
      "selection",
      "snapshot",
      "book",
      "health",
    ]);
    const snapshot = client.sent[1];
    expect(snapshot.markers).toHaveLength(MAX_SNAPSHOT_MARKERS);
    expect(snapshot.markers.map((marker) => marker.trade_id)).toEqual(
      retained.slice(-MAX_SNAPSHOT_MARKERS).map((marker) => marker.trade_id),
    );
    const pages = client.sent.filter(
      (frame) => frame.type === "marker_history",
    );
    expect(
      pages.map((page) => [page.reset, page.seq, page.rows.length]),
    ).toEqual([
      [true, 0, 5_000],
      [false, 1, 5_000],
      [false, 2, 2_000],
    ]);
    const expanded = pages.flatMap((page) =>
      page.rows.map(([ts, price, size, side, id]) => ({
        ts_exchange: ts,
        price,
        size,
        side: side === "b" ? "buy" : "sell",
        trade_id: id,
      })),
    );
    expect(expanded).toEqual(
      retained.map(({ ts_exchange, price, size, side, trade_id }) => ({
        ts_exchange,
        price,
        size,
        side,
        trade_id,
      })),
    );
    expect(JSON.stringify(pages).length).toBeLessThan(
      JSON.stringify(retained).length / 2,
    );
  });

  test("malformed capability claims are ignored and cannot enable marker-history delivery", async () => {
    const historyBuffer = createHistoryBuffer();
    historyBuffer.recordMarker({
      type: "marker",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      ts_exchange: Date.now(),
      price: 64_000,
      size: 2,
      side: "buy",
      trade_id: "legacy-safe",
    });
    const { server } = await startedServer({ historyBuffer });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(
      JSON.stringify({ type: "capabilities", marker_history: false }),
      client,
    );
    server.handleClientMessage(
      JSON.stringify({
        type: "capabilities",
        marker_history: true,
        extra: true,
      }),
      client,
    );
    await flushAsync();
    expect(client.sent.some((frame) => frame.type === "marker_history")).toBe(
      false,
    );
  });

  test("a pair with no retained markers sends no history page at all", async () => {
    const { server } = await startedServer({
      historyBuffer: createHistoryBuffer(),
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushAsync();
    expect(client.sent.some((frame) => frame.type === "marker_history")).toBe(
      false,
    );
  });

  test("a real DEPTH delta broadcasts a book frame reflecting the reconciled book, not the raw delta payload", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    // The REST snapshot subscribe() fired is a real (fake-fetchImpl-backed)
    // async chain -- it must actually resolve before a bridging delta can
    // reach READY, same timing this project's own DEPTH tests always need.
    await flushAsync();
    client.sent = [];

    spotSocket.simulateMessage(depthWire({ U: 101, u: 105 }));

    const bookFrames = client.sent.filter((f) => f.type === "book");
    expect(bookFrames).toHaveLength(1);
    expect(bookFrames[0]).toEqual(
      expect.objectContaining({
        type: "book",
        symbol: "BTC-USDT",
        status: "READY",
        stale: false,
      }),
    );
  });

  test("a malformed DEPTH delta still broadcasts a real book frame -- the book's source of truth is getOrderBook(), not the individual envelope", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    expect(() =>
      spotSocket.simulateMessage(malformedDepthWire()),
    ).not.toThrow();

    const bookFrames = client.sent.filter((f) => f.type === "book");
    expect(bookFrames).toHaveLength(1);
    // UPSTREAM_EVENT_UNAVAILABLE, not BUFFERING -- the assembler's own
    // sanitizeDeltaEnvelope() rejects a delta with no usable
    // lastUpdateId outright, which is a distinct reason from "a
    // well-formed delta arrived but nothing has bridged the snapshot yet."
    expect(bookFrames[0]).toEqual(
      expect.objectContaining({
        type: "book",
        status: "UNAVAILABLE",
        reason: "UPSTREAM_EVENT_UNAVAILABLE",
      }),
    );
  });

  test("DEPTH is synchronous, same as before this ticket: a book frame is not deferred through the backpressure queue the way trade/bar are", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.simulateMessage(depthWire({ U: 101, u: 105 }));

    // No flushAsync() -- if this were queued, nothing would be here yet.
    expect(client.sent.filter((f) => f.type === "book")).toHaveLength(1);
  });

  test("a silent connection loss with zero further DEPTH envelopes still eventually broadcasts a book frame reflecting CONNECTION_DOWN, via the same poll that already covers feed health", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.close();
    // The on-envelope path can never fire again -- only the periodic
    // poll (healthPollMs: 20 here) can catch this.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const bookFrames = client.sent.filter((f) => f.type === "book");
    expect(bookFrames.length).toBeGreaterThan(0);
    expect(
      bookFrames.some(
        (f) => f.status === "UNAVAILABLE" && f.reason === "CONNECTION_DOWN",
      ),
    ).toBe(true);

    server.stop();
  });

  test("a silent DEPTH feed on a still-CONNECTED socket broadcasts READY+stale rather than leaving the last ladder frozen with no indication", async () => {
    let depthStale = false;
    const readyBook = {
      status: "READY",
      book: { bids: [["100", "1"]], asks: [["101", "1"]], lastUpdateId: 42 },
    };
    const connection = {
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
      subscribe() {},
      getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
      getFeedHealth: (_marketKind, _symbol, eventType) => ({
        stale: eventType === "DEPTH" ? depthStale : false,
        recoveryState: "READY",
      }),
      getOrderBook: () => readyBook,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
      healthPollMs: 20,
    });
    serversToStop.push(server);
    await server.start();

    const client = fakeClient();
    server.handleClientConnected(client);
    expect(client.sent.filter((f) => f.type === "book")).toEqual([
      expect.objectContaining({
        type: "book",
        status: "READY",
        stale: false,
        lastUpdateId: 42,
      }),
    ]);

    client.sent = [];
    depthStale = true;
    // Same poll that already covers CONNECTION_DOWN -- status/reason
    // are unchanged, only the DEPTH stale bit flipped.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const staleBooks = client.sent.filter((f) => f.type === "book");
    expect(
      staleBooks.some(
        (f) =>
          f.status === "READY" && f.stale === true && f.lastUpdateId === 42,
      ),
    ).toBe(true);
  });

  test("the health poll recovers a stale active feed", async () => {
    const recoverStaleSubscription = jest.fn(() => true);
    const connection = {
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
      subscribe() {},
      unsubscribe() {},
      getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
      getFeedHealth: (_marketKind, symbol, eventType) => ({
        stale: symbol === "ETHUSDT" && eventType === "TRADE",
        recoveryState: "READY",
      }),
      getOrderBook: () => ({ status: "UNAVAILABLE", reason: "NO_SNAPSHOT" }),
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
      recoverStaleSubscription,
    };
    const server = createMarketDataServer({
      connection,
      symbol: "ETHUSDT",
      connectPollMs: 5,
      healthPollMs: 20,
    });
    serversToStop.push(server);
    await server.start();

    server.handleClientMessage(
      JSON.stringify({
        type: "select",
        symbol: "ETH-USDT",
        marketKind: "SPOT",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(recoverStaleSubscription).toHaveBeenCalledWith({
      symbol: "ETHUSDT",
      marketKind: "SPOT",
      eventType: "TRADE",
    });
  });

  describe("multi-pair switching (P3.03)", () => {
    test("switching symbol releases the old pair and subscribes to all three feeds for the new pair in route batches", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(
        JSON.stringify({ type: "capabilities", marker_history: true }),
        client,
      );
      client.sent = [];

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));

      // A fresh subscribe also legitimately fires a RECOVERING health
      // frame (P1.04 behavior, same as any first subscribe) -- filter by
      // type to isolate the selection/snapshot/book ordering under test
      // from that real, separate broadcast.
      expect(client.sent[0]).toEqual({
        type: "selection",
        provider: "BINANCE",
        symbol: "ETH-USDT",
        marketKind: "SPOT",
      });
      expect(client.sent[1]).toEqual({
        type: "snapshot",
        provider: "BINANCE",
        symbol: "ETH-USDT",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [],
      });
      expect(client.sent.filter((f) => f.type === "book")).toEqual([
        expect.objectContaining({
          type: "book",
          symbol: "ETH-USDT",
          marketKind: "SPOT",
        }),
      ]);

      const sent = spotSocket.sentMessages.map((m) => JSON.parse(m));
      const unsubscribed = sent
        .filter((m) => m.method === "UNSUBSCRIBE")
        .flatMap((m) => m.params);
      const subscribed = sent
        .filter((m) => m.method === "SUBSCRIBE")
        .flatMap((m) => m.params);
      expect(unsubscribed).toEqual(
        expect.arrayContaining([
          "btcusdt@trade",
          "btcusdt@kline_1m",
          "btcusdt@depth@100ms",
        ]),
      );
      expect(subscribed).toEqual(
        expect.arrayContaining([
          "ethusdt@trade",
          "ethusdt@kline_1m",
          "ethusdt@depth@100ms",
        ]),
      );
    });

    test("a pair switch replays the new pair's heatmap paced (not one synchronous dump) to every client", async () => {
      const replay = liquidityFrames(12);
      const liquidity = fakeLiquidityPublisher(replay);
      const { server } = await startedServer({ liquidity });
      const a = fakeClient();
      const b = fakeClient();
      server.handleClientConnected(a);
      server.handleClientConnected(b);
      a.sent = [];
      b.sent = [];

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), a);
      // first batch only, synchronously
      expect(a.sent.filter((f) => f.type === "liquidity").length).toBeLessThan(
        replay.length,
      );

      await waitUntil(() =>
        [a, b].every(
          (c) =>
            c.sent.filter((f) => f.type === "liquidity").length >=
            replay.length,
        ),
      );
      for (const c of [a, b]) {
        expect(c.sent.filter((f) => f.type === "liquidity")).toEqual(replay);
        expect(c.close).toBeUndefined();
      }
    });

    test("switching market kind alone (SPOT -> PERPETUAL, same symbol), using the already-open PERPETUAL routes", async () => {
      const { server, instances } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      server.handleClientMessage(selectWire("BTC-USDT", "PERPETUAL"));

      expect(client.sent[0]).toEqual({
        type: "selection",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "PERPETUAL",
      });
      const perpPublicSent = perpetualPublicSocket(instances).sentMessages.map(
        (m) => JSON.parse(m),
      );
      expect(
        perpPublicSent.some(
          (m) => m.method === "SUBSCRIBE" && m.params.includes("btcusdt@trade"),
        ),
      ).toBe(true);
      expect(
        perpPublicSent.some(
          (m) =>
            m.method === "SUBSCRIBE" &&
            m.params.includes("btcusdt@depth@100ms"),
        ),
      ).toBe(true);
      const perpMarketSent = perpetualMarketSocket(instances).sentMessages.map(
        (m) => JSON.parse(m),
      );
      expect(
        perpMarketSent.some(
          (m) =>
            m.method === "SUBSCRIBE" && m.params.includes("btcusdt@kline_1m"),
        ),
      ).toBe(true);
    });

    test("switching both symbol and market kind together", async () => {
      const { server, instances } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      server.handleClientMessage(selectWire("ETH-USDT", "PERPETUAL"));

      expect(client.sent[0]).toEqual({
        type: "selection",
        provider: "BINANCE",
        symbol: "ETH-USDT",
        marketKind: "PERPETUAL",
      });
      const perpPublicSent = perpetualPublicSocket(instances).sentMessages.map(
        (m) => JSON.parse(m),
      );
      expect(
        perpPublicSent.some(
          (m) => m.method === "SUBSCRIBE" && m.params.includes("ethusdt@trade"),
        ),
      ).toBe(true);
      expect(
        perpPublicSent.some(
          (m) =>
            m.method === "SUBSCRIBE" &&
            m.params.includes("ethusdt@depth@100ms"),
        ),
      ).toBe(true);
      const perpMarketSent = perpetualMarketSocket(instances).sentMessages.map(
        (m) => JSON.parse(m),
      );
      expect(
        perpMarketSent.some(
          (m) =>
            m.method === "SUBSCRIBE" && m.params.includes("ethusdt@kline_1m"),
        ),
      ).toBe(true);
    });

    test("a trade, bar, and depth envelope for the previously selected pair are all discarded after a switch, even arriving on the same still-open route", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      await flushAsync(); // let BTC's DEPTH snapshot resolve before switching away

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      client.sent = [];

      // Stray BTC envelopes -- simulate messages already queued before the
      // server's own UNSUBSCRIBE for BTC actually took effect.
      spotSocket.simulateMessage(tradeWire(999));
      spotSocket.simulateMessage(klineWire({ closed: true }));
      spotSocket.simulateMessage(depthWire({ U: 200, u: 205 }));
      await flushAsync();

      expect(client.sent.filter((f) => f.type === "trade")).toEqual([]);
      expect(client.sent.filter((f) => f.type === "bar")).toEqual([]);
      expect(
        client.sent.filter((f) => f.type === "book" && f.symbol === "BTC-USDT"),
      ).toEqual([]);
    });

    test("a rapid double-switch (ETH then immediately back to BTC) ends in the correct final state with no duplicate/dangling subscriptions", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));

      const selections = client.sent.filter((f) => f.type === "selection");
      expect(selections.at(-1)).toEqual({
        type: "selection",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
      });

      const sent = spotSocket.sentMessages.map((m) => JSON.parse(m));
      for (const stream of [
        "btcusdt@trade",
        "btcusdt@kline_1m",
        "btcusdt@depth@100ms",
      ]) {
        expect(
          sent.filter(
            (m) => m.method === "SUBSCRIBE" && m.params.includes(stream),
          ),
        ).toHaveLength(2);
        expect(
          sent.filter(
            (m) => m.method === "UNSUBSCRIBE" && m.params.includes(stream),
          ),
        ).toHaveLength(1);
      }
    });

    test("a switch still completes even if releasing the old pair's DEPTH subscription throws -- e.g. the old pair's own route is what's down, which is why the user is switching away in the first place", async () => {
      const client = fakeClient();
      const connection = {
        onMessage: () => () => {},
        connect() {},
        disconnect() {},
        subscribe() {},
        unsubscribe: () => {
          throw new Error(
            "Cannot unsubscribe before the Binance SPOT public route is connected.",
          );
        },
        getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
        getFeedHealth: () => ({ stale: false, recoveryState: "READY" }),
        getOrderBook: () => undefined,
        fetchRecentKlines: async () => ({ ok: true, rows: [] }),
      };
      const server = createMarketDataServer({
        connection,
        symbol: "BTCUSDT",
        connectPollMs: 5,
        healthPollMs: 20,
      });
      serversToStop.push(server);
      await server.start();
      server.handleClientConnected(client);
      client.sent = [];

      expect(() =>
        server.handleClientMessage(selectWire("ETH-USDT", "SPOT")),
      ).not.toThrow();

      expect(client.sent.filter((f) => f.type === "selection")).toEqual([
        {
          type: "selection",
          provider: "BINANCE",
          symbol: "ETH-USDT",
          marketKind: "SPOT",
        },
      ]);
    });

    test("an invalid select request (malformed JSON, unproven symbol, unproven marketKind, or wrong message type) is logged and ignored -- never crashes or changes the active pair", async () => {
      const { server } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      expect(() => server.handleClientMessage("not json")).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          JSON.stringify({
            type: "select",
            symbol: "DOGE-USDT",
            marketKind: "SPOT",
          }),
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          JSON.stringify({
            type: "select",
            symbol: "BTC-USDT",
            marketKind: "MARGIN",
          }),
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          JSON.stringify({
            type: "not-select",
            symbol: "BTC-USDT",
            marketKind: "SPOT",
          }),
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          JSON.stringify({
            type: "select",
            symbol: "ETH-USDT",
            marketKind: "SPOT",
            extra: true,
          }),
        ),
      ).not.toThrow();

      expect(client.sent.filter((f) => f.type === "selection")).toEqual([]);
    });

    test("switching to the already-active pair is a no-op: no unsubscribe/resubscribe churn, no selection re-broadcast", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];
      const sentBefore = spotSocket.sentMessages.length;

      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));

      expect(client.sent).toEqual([]);
      expect(spotSocket.sentMessages.length).toBe(sentBefore);
    });

    test("selection churn beyond the per-client upstream-safe budget closes only the requesting client", async () => {
      const { server } = await startedServer();
      const client = { readyState: 1, sent: [], send() {}, close: jest.fn() };

      for (let index = 0; index < MAX_SELECTIONS_PER_WINDOW; index += 1) {
        server.handleClientMessage(
          selectWire("ETH-USDT", index % 2 === 0 ? "SPOT" : "PERPETUAL"),
          client,
        );
      }
      client.sent = [];
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"), client);

      expect(client.close).toHaveBeenCalledWith(
        1008,
        "Too many pair selection requests",
      );
      expect(client.sent).toEqual([]);
    });

    test("one client's selection budget cannot be exhausted by another client", async () => {
      const { server } = await startedServer();
      const first = { close: jest.fn() };
      const second = { close: jest.fn() };

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), first);
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"), first);
      server.handleClientMessage(selectWire("ETH-USDT", "PERPETUAL"), second);

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    });

    test("same-pair requests do not consume the requesting client's rate budget", async () => {
      const { server } = await startedServer();
      const client = { close: jest.fn() };
      for (let index = 0; index < 10; index += 1) {
        server.handleClientMessage(selectWire("BTC-USDT", "SPOT"), client);
      }

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"), client);
      expect(client.close).not.toHaveBeenCalled();

      server.handleClientMessage(selectWire("ETH-USDT", "PERPETUAL"), client);
      expect(client.close).toHaveBeenCalledWith(
        1008,
        "Too many pair selection requests",
      );
    });

    test("history is kept per pair: switching away and back does not lose the earlier pair's recorded bars", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);

      spotSocket.simulateMessage(klineWire({ closed: true }));
      await flushAsync();

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));

      const snapshots = client.sent.filter((f) => f.type === "snapshot");
      expect(snapshots.at(-1).bars).toEqual([
        expect.objectContaining({ symbol: "BTC-USDT", closed: true }),
      ]);
    });
  });

  test("a client whose send() throws does not stop the broadcast to the other clients", async () => {
    const { server, spotSocket } = await startedServer();
    const brokenClient = {
      readyState: 1,
      send: () => {
        throw new Error("boom");
      },
    };
    const goodClient = fakeClient();
    server.handleClientConnected(brokenClient);
    server.handleClientConnected(goodClient);
    goodClient.sent = [];

    expect(() => spotSocket.simulateMessage(tradeWire(1))).not.toThrow();
    await flushAsync();

    expect(goodClient.sent.filter((f) => f.type === "trade")).toEqual([
      expect.objectContaining({ type: "trade" }),
    ]);
    expect(server.clientCount()).toBe(1);
  });

  test("a client that stays over the outbound buffer budget past the grace window is closed and removed", async () => {
    let nowMs = 1_000_000;
    const { server, spotSocket } = await startedServer({
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const slowClient = {
      readyState: 1,
      bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1,
      close: jest.fn(),
      send: jest.fn(),
    };
    const goodClient = fakeClient();
    server.handleClientConnected(slowClient);
    server.handleClientConnected(goodClient);
    goodClient.sent = [];

    spotSocket.simulateMessage(tradeWire(88));
    await flushAsync();

    expect(slowClient.close).not.toHaveBeenCalled();
    expect(
      slowClient.send.mock.calls.map(([data]) => JSON.parse(data).type),
    ).toEqual(expect.arrayContaining(["trade"]));
    expect(server.clientCount()).toBe(2);

    nowMs += 10_000;
    spotSocket.simulateMessage(tradeWire(89));
    await flushAsync();

    expect(slowClient.close).toHaveBeenCalledWith(
      1013,
      "Client is too slow to receive market data",
    );
    expect(
      slowClient.send.mock.calls
        .map(([data]) => JSON.parse(data))
        .filter((frame) => frame.type === "trade"),
    ).toHaveLength(1);
    expect(server.clientCount()).toBe(1);
    expect(goodClient.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "trade", trade_id: "89" }),
      ]),
    );
  });

  test("a client briefly over the outbound buffer budget is not closed and resumes once it drains", async () => {
    let nowMs = 1_000_000;
    const { server, spotSocket } = await startedServer({
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const client = {
      readyState: 1,
      bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1,
      close: jest.fn(),
      sent: [],
      send(data) {
        this.sent.push(JSON.parse(data));
      },
    };

    server.handleClientConnected(client);
    await flushAsync();
    expect(client.close).not.toHaveBeenCalled();
    expect(client.sent.some((frame) => frame.type === "snapshot")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
    expect(server.clientCount()).toBe(1);

    nowMs += 5_000;
    client.bufferedAmount = 0;
    spotSocket.simulateMessage(tradeWire(7));
    await flushAsync();
    expect(client.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "trade", trade_id: "7" }),
      ]),
    );
    expect(client.close).not.toHaveBeenCalled();

    nowMs += 5_000;
    client.bufferedAmount = MAX_CLIENT_BUFFERED_BYTES + 1;
    spotSocket.simulateMessage(tradeWire(8));
    await flushAsync();
    expect(client.close).not.toHaveBeenCalled();
    expect(server.clientCount()).toBe(1);
  });

  test("during the grace window control and incremental frames remain lossless while bulk history is held back", async () => {
    let nowMs = 1_000_000;
    const { server, spotSocket } = await startedServer({
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const client = {
      readyState: 1,
      bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1,
      close: jest.fn(),
      sent: [],
      send(data) {
        this.sent.push(JSON.parse(data));
      },
    };
    server.handleClientConnected(client);
    await flushAsync();
    client.sent = [];

    spotSocket.simulateMessage(tradeWire(7));
    await flushAsync();
    expect(client.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "trade", trade_id: "7" }),
      ]),
    );

    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
    await flushAsync();
    expect(client.sent).toContainEqual(
      expect.objectContaining({ type: "selection" }),
    );
    expect(client.sent.some((frame) => frame.type === "snapshot")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(client.close).not.toHaveBeenCalled();

  });

  test("during the grace window a bulk history reply is skipped, never a reason to evict the client, and is answered again once it has drained", async () => {
    let nowMs = Date.now();
    const { server } = await startedServer({
      storageReader: { readAggressivePrintsAsync: () => Promise.resolve({ rows: [], available: true }) },
      aggressivePoolWarmup: false,
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const client = {
      readyState: 1,
      bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1,
      close: jest.fn(),
      sent: [],
      send(data) {
        this.sent.push(JSON.parse(data));
      },
    };
    const settle = async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const ask = (requestId) => server.handleClientMessage(JSON.stringify({
      type: "aggressive_history", request_id: requestId, from_ts: nowMs - 60_000 - requestId, to_ts: nowMs, min_size: 0,
    }), client);
    server.handleClientConnected(client);
    await settle();
    ask(1);
    await settle();
    expect(client.sent.some((frame) => frame.type === "aggressive_history")).toBe(false);
    expect(client.close).not.toHaveBeenCalled();

    nowMs += 1_000;
    client.bufferedAmount = 0;
    ask(2);
    await settle();
    expect(client.sent.filter((frame) => frame.type === "aggressive_history").map((frame) => frame.request_id)).toEqual([2]);
    expect(client.close).not.toHaveBeenCalled();
  });

  test("once the grace window has expired, even a control frame evicts the backed-up client instead of keeping it alive", async () => {
    let nowMs = 1_000_000;
    const { server, spotSocket } = await startedServer({
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const client = {
      readyState: 1,
      bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1,
      close: jest.fn(),
      send: jest.fn(),
    };
    server.handleClientConnected(client);
    await flushAsync();
    expect(client.close).not.toHaveBeenCalled();

    spotSocket.simulateMessage(depthWire({ U: 101, u: 105 }));
    expect(client.close).not.toHaveBeenCalled();
    expect(
      client.send.mock.calls.map(([data]) => JSON.parse(data).type),
    ).toContain("book");

    nowMs += 10_000;
    spotSocket.simulateMessage(depthWire({ U: 106, u: 110 }));
    expect(client.close).toHaveBeenCalledWith(
      1013,
      "Client is too slow to receive market data",
    );
    expect(server.clientCount()).toBe(0);
  });

  test("a client past the hard buffer ceiling is closed immediately, without waiting out the grace window", async () => {
    let nowMs = 1_000_000;
    const { server } = await startedServer({
      now: () => nowMs,
      clientBufferGraceMs: 10_000,
    });
    const runawayClient = {
      readyState: 1,
      bufferedAmount: DEFAULT_CLIENT_BUFFER_HARD_BYTES + 1,
      close: jest.fn(),
      send: jest.fn(),
    };

    server.handleClientConnected(runawayClient);
    await flushAsync();

    expect(runawayClient.close).toHaveBeenCalledWith(
      1013,
      "Client is too slow to receive market data",
    );
    expect(runawayClient.send).not.toHaveBeenCalled();
    expect(server.clientCount()).toBe(0);
  });

  function fakeLiquidityPublisher(frames = []) {
    return {
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
      snapshotFrames: jest.fn(() => frames),
    };
  }

  function l2Wall(size) {
    return {
      id: 7, side: "bid", row: 10, span: 1, startTs: 1_000, endTs: null, size, peak: 12, endedBy: null,
      ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null,
    };
  }

  function l2Output(overrides = {}) {
    return {
      ts: 5_000, rowWidth: 0.5, fresh: false, segment: { id: "SPOT:BTCUSDT:1000:LIVE", state: "LIVE" },
      view: [], viewReset: false,
      walls: { seq: 2, reset: false, walls: [l2Wall(10)], removed: [] },
      events: { seq: 1, events: [{ event: "hidden", ts: 4_000, side: "bid", price: 100, volume: 1 }], missed: 0 },
      ladder: { depth: 50, bids: [[100, 1]], asks: [[101, 1]] },
      ...overrides,
    };
  }

  function l2Publisher() {
    const snapshot = {
      ts: 4_000, rowWidth: 0.5, segment: { id: "SPOT:BTCUSDT:1000:LIVE", state: "LIVE" }, view: [],
      walls: { seq: 1, reset: true, walls: [l2Wall(12)], removed: [] },
      events: { seq: 0, reset: true, events: [], missed: 0 },
      ladder: { depth: 50, bids: [[100, 2]], asks: [[101, 1]] },
    };
    return { ...fakeLiquidityPublisher([]), l2Snapshot: jest.fn(() => snapshot) };
  }

  const l2Types = (client) => client.sent.filter((frame) => frame.type.startsWith("l2_")).map((frame) => [frame.type, frame.reset ?? null]);

  test("P4a: L2 frames reach only a client that declared them, and only the channels it chose", async () => {
    const liquidity = l2Publisher();
    const { server } = await startedServer({ liquidity });
    const oldClient = fakeClient();
    const newClient = fakeClient();
    server.handleClientConnected(oldClient);
    server.handleClientConnected(newClient);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_walls: true, l2_ladder: true }), newClient);
    await flushAsync();
    expect(l2Types(newClient)).toEqual([["l2_walls", true], ["l2_ladder", null]]);
    expect(newClient.sent.find((frame) => frame.type === "l2_ladder").bids).toEqual([[100, 2]]);
    expect(liquidity.l2Snapshot).toHaveBeenCalledWith("SPOT", "BTCUSDT");

    const { publishL2 } = liquidity.start.mock.calls[0][0];
    publishL2(l2Output(), { marketKind: "SPOT", symbol: "BTCUSDT" });
    await flushAsync();
    expect(l2Types(newClient)).toEqual([["l2_walls", true], ["l2_ladder", null], ["l2_walls", false], ["l2_ladder", null]]);
    expect(newClient.sent.find((frame) => frame.type === "l2_walls" && frame.reset === false)).toMatchObject({
      provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", seq: 2, walls: [expect.objectContaining({ id: 7, size: 10 })],
    });
    expect(l2Types(oldClient)).toEqual([]);
  });

  test("P4a: marker_history and the L2 flags can be declared together, and a malformed declaration changes nothing", async () => {
    const liquidity = l2Publisher();
    const { server } = await startedServer({ liquidity });
    const client = fakeClient();
    server.handleClientConnected(client);
    for (const claim of [{ l2_walls: false }, { l2_walls: true, l2_depth: true }, { l2_walls: "yes" }]) {
      server.handleClientMessage(JSON.stringify({ type: "capabilities", ...claim }), client);
    }
    await flushAsync();
    expect(l2Types(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", marker_history: true, l2_walls: true }), client);
    await flushAsync();
    expect(l2Types(client)).toEqual([["l2_walls", true]]);
  });

  test("P4a: an l2_resync re-sends only the named channel, to only that client", async () => {
    const liquidity = l2Publisher();
    const { server } = await startedServer({ liquidity });
    const clientA = fakeClient();
    const clientB = fakeClient();
    for (const client of [clientA, clientB]) {
      server.handleClientConnected(client);
      server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_walls: true, l2_events: true }), client);
    }
    await flushAsync();
    clientA.sent = [];
    clientB.sent = [];
    server.handleClientMessage(JSON.stringify({ type: "l2_resync", channel: "l2_walls" }), clientA);
    server.handleClientMessage(JSON.stringify({ type: "l2_resync", channel: "l2_walls", extra: 1 }), clientB);
    await flushAsync();
    expect(l2Types(clientA)).toEqual([["l2_walls", true]]);
    expect(l2Types(clientB)).toEqual([]);
  });

  test("P4a: output for a pair that is not the active one is not sent", async () => {
    const liquidity = l2Publisher();
    const { server } = await startedServer({ liquidity });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_walls: true }), client);
    await flushAsync();
    client.sent = [];
    liquidity.start.mock.calls[0][0].publishL2(l2Output(), { marketKind: "PERPETUAL", symbol: "ETHUSDT" });
    await flushAsync();
    expect(l2Types(client)).toEqual([]);
  });

  test("P4a: a disconnected client is forgotten by the L2 channels", async () => {
    const liquidity = l2Publisher();
    const { server } = await startedServer({ liquidity });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_walls: true }), client);
    await flushAsync();
    server.handleClientDisconnected(client);
    client.sent = [];
    liquidity.start.mock.calls[0][0].publishL2(l2Output(), { marketKind: "SPOT", symbol: "BTCUSDT" });
    await flushAsync();
    expect(client.sent).toEqual([]);
  });

  test("a liquidity_resync request replays the heatmap snapshot frames to just that client", async () => {
    const frameA = {
      type: "liquidity",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      seq: 1,
      reset: true,
      columns: [],
    };
    const frameB = {
      type: "liquidity",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      seq: 2,
      reset: false,
      columns: [],
    };
    const liquidity = fakeLiquidityPublisher([frameA, frameB]);
    const { server } = await startedServer({ liquidity });
    const clientA = fakeClient();
    const clientB = fakeClient();
    server.handleClientConnected(clientA);
    server.handleClientConnected(clientB);
    clientA.sent = [];
    clientB.sent = [];

    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync" }),
      clientA,
    );

    expect(clientA.sent).toEqual([frameA, frameB]);
    expect(clientB.sent).toEqual([]);
  });

  test("a liquidity_resync repeated inside the min interval is ignored, then honoured once it elapses", async () => {
    let nowMs = 1_000_000;
    const liquidity = fakeLiquidityPublisher([]);
    const { server } = await startedServer({ liquidity, now: () => nowMs });
    const client = fakeClient();
    server.handleClientConnected(client); // snapshotFrames call #1

    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync" }),
      client,
    ); // #2
    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync" }),
      client,
    ); // ignored
    expect(liquidity.snapshotFrames).toHaveBeenCalledTimes(2);

    nowMs += 2_000;
    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync" }),
      client,
    ); // #3
    expect(liquidity.snapshotFrames).toHaveBeenCalledTimes(3);
  });

  // Property: the L2 deep tier is admitted only once the pair's marker and
  // aggressive-print warm-ups have settled, or after a bounded wait, so the
  // small visible-first reads are not starved by ~1 MB replay pages on a
  // ~200 KB/s link. Oracle: the admission promise the server hands the
  // publisher, driven by a stubbed clock while the marker read hangs.
  test("the deep tier's admission waits for the small warm-ups and gives up waiting at the cap", async () => {
    const liquidity = fakeLiquidityPublisher([]);
    let releaseLargeTrades;
    let hangLargeTrades = true;
    const storageReader = {
      readRecentCandles: jest.fn(() => ({ rows: [], coversFullWindow: true })),
      readRecentTrades: jest.fn(() => ({ rows: [] })),
      readAggressivePrintsAsync: jest.fn(async () => ({
        rows: [],
        available: true,
        hasMore: false,
        nextCursor: null,
      })),
      readLargeTradesAsync: jest.fn(() =>
        hangLargeTrades
          ? new Promise((resolve) => {
              releaseLargeTrades = resolve;
            })
          : Promise.resolve({ rows: [], available: true }),
      ),
    };
    let clock = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const { server } = await startedServer({ liquidity, storageReader });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { deepAdmission } = liquidity.start.mock.calls[0][0];
      expect(typeof deepAdmission).toBe("function");
      let admitted = false;
      deepAdmission("SPOT:BTCUSDT").then(() => {
        admitted = true;
      });
      clock += 30_000;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(admitted).toBe(false);
      clock += 61_000;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(admitted).toBe(true);

      await expect(deepAdmission("PERPETUAL:ETHUSDT")).resolves.toBeUndefined();

      let settled = false;
      deepAdmission("SPOT:BTCUSDT").then(() => {
        settled = true;
      });
      hangLargeTrades = false;
      releaseLargeTrades({ rows: [], available: true });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(storageReader.readAggressivePrintsAsync).toHaveBeenCalled();
      expect(settled).toBe(true);
      server.stop();
    } finally {
      nowSpy.mockRestore();
    }
  }, 15_000);

  test("O-21: a large-trade warm-up abandoned by a switch reports IDLE (CANCELLED) instead of RUNNING, and resumes where it stopped", async () => {
    const liquidity = fakeLiquidityPublisher([]);
    const pending = [];
    const storageReader = {
      readRecentCandles: jest.fn(() => ({ rows: [], coversFullWindow: true })),
      readRecentTrades: jest.fn(() => ({ rows: [] })),
      readAggressivePrintsAsync: jest.fn(async () => ({ rows: [], available: true, hasMore: false, nextCursor: null })),
      readLargeTradesAsync: jest.fn((symbol, marketKind, options) => new Promise((resolve) => { pending.push({ symbol, options, resolve }); })),
    };
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const waitFor = async (condition) => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    try {
      const { server } = await startedServer({ liquidity, storageReader });
      await waitFor(() => pending.some((call) => call.symbol === "BTCUSDT"));
      const first = pending.find((call) => call.symbol === "BTCUSDT");

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      first.resolve({ rows: [], available: true });
      const cancelled = () => info.mock.calls.find(([message, details]) => message === "market data server: operational.transition"
        && details?.feature === "binance.spot.btcusdt.large_trades" && details.state === "IDLE");
      await waitFor(() => cancelled() !== undefined);
      expect(cancelled()?.[1]).toMatchObject({ feature: "binance.spot.btcusdt.large_trades", state: "IDLE", reason: "CANCELLED" });

      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      await waitFor(() => pending.filter((call) => call.symbol === "BTCUSDT").length >= 2);
      const resumed = pending.filter((call) => call.symbol === "BTCUSDT")[1];
      expect(resumed.options.nowMs).toBe(first.options.nowMs);
      expect(resumed.options.fromMs).toBe(first.options.fromMs);
      server.stop();
    } finally {
      info.mockRestore();
    }
  }, 15_000);

  test("a liquidity_resync with surplus fields is dropped", async () => {
    const liquidity = fakeLiquidityPublisher([]);
    const { server } = await startedServer({ liquidity });
    const client = fakeClient();
    server.handleClientConnected(client);
    liquidity.snapshotFrames.mockClear();

    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync", extra: 1 }),
      client,
    );

    expect(liquidity.snapshotFrames).not.toHaveBeenCalled();
  });

  function liquidityFrames(count) {
    return Array.from({ length: count }, (_unused, i) => ({
      type: "liquidity",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      seq: i + 1,
      reset: i === 0,
      columns: [],
    }));
  }

  const drainMacrotasks = () =>
    new Promise((resolve) => setTimeout(resolve, 40));
  // A paced replay finishes after however many timer turns the machine gives it; a fixed 40 ms wait failed whenever
  // the host was busy (Gate E GE-8). Wait for the frames themselves, with a deadline, instead.
  const waitUntil = async (condition, deadlineMs = 5_000) => {
    const deadline = Date.now() + deadlineMs;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
  };

  test("a large heatmap replay is delivered across event-loop turns, and a live frame during it lands last, in order", async () => {
    const replay = liquidityFrames(10);
    const liquidity = fakeLiquidityPublisher(replay);
    const { server } = await startedServer({ liquidity });
    const publish = liquidity.start.mock.calls[0][0].publish;
    const client = fakeClient();

    server.handleClientConnected(client);
    const sentInFirstTurn = client.sent.filter(
      (f) => f.type === "liquidity",
    ).length;
    expect(sentInFirstTurn).toBeGreaterThan(0);
    expect(sentInFirstTurn).toBeLessThan(replay.length);

    const live = {
      type: "liquidity",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      seq: 11,
      reset: false,
      columns: [],
    };
    publish(live);
    await waitUntil(
      () =>
        client.sent.filter((f) => f.type === "liquidity").length >=
        replay.length + 1,
    );

    const got = client.sent.filter((f) => f.type === "liquidity");
    expect(got).toEqual([...replay, live]);
    expect(client.close).toBeUndefined();
    expect(server.clientCount()).toBe(1);
  });

  test("disconnecting mid-replay stops the pacer with no further frames", async () => {
    const liquidity = fakeLiquidityPublisher(liquidityFrames(40));
    const { server } = await startedServer({ liquidity });
    const client = fakeClient();

    server.handleClientConnected(client);
    const before = client.sent.filter((f) => f.type === "liquidity").length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(40);

    server.handleClientDisconnected(client);
    await drainMacrotasks();

    expect(client.sent.filter((f) => f.type === "liquidity").length).toBe(
      before,
    );
  });

  test("P4c: a backfill announce waits for a slow client's buffer and is paced through it, never pushed whole", async () => {
    // Before P4c every announce was broadcast whole into every socket; a
    // browser behind a slow link then sat past the soft limit and was evicted.
    const liquidity = fakeLiquidityPublisher([]);
    const { server } = await startedServer({ liquidity });
    const slow = fakeClient();
    const fast = fakeClient();
    server.handleClientConnected(slow);
    server.handleClientConnected(fast);
    await drainMacrotasks();
    const { publishSnapshot } = liquidity.start.mock.calls[0][0];
    expect(typeof publishSnapshot).toBe("function");
    slow.bufferedAmount = 8 * 1024 * 1024;
    slow.sent = [];
    fast.sent = [];
    publishSnapshot(liquidityFrames(20));
    await waitUntil(() => fast.sent.filter((f) => f.type === "liquidity").length === 20);
    await drainMacrotasks();
    expect(slow.sent.filter((f) => f.type === "liquidity")).toEqual([]);
    slow.bufferedAmount = 0;
    await waitUntil(() => slow.sent.filter((f) => f.type === "liquidity").length === 20);
    expect(slow.sent.filter((f) => f.type === "liquidity").map((f) => f.seq)).toEqual(Array.from({ length: 20 }, (_unused, i) => i + 1));
    expect(slow.close).toBeUndefined();
  });

  test("with zero clients the server keeps recording state that a later client then receives", async () => {
    const { server, spotSocket } = await startedServer();
    const first = fakeClient();
    server.handleClientConnected(first);
    server.handleClientDisconnected(first);
    expect(server.clientCount()).toBe(0);

    // fed while nobody is connected -- broadcast() short-circuits, but the
    // history buffer must still take the trade
    spotSocket.simulateMessage(tradeWire(4141));
    await flushAsync();

    const late = fakeClient();
    server.handleClientConnected(late);
    const snapshot = late.sent.find((f) => f.type === "snapshot");
    expect(snapshot.trades.some((t) => t.trade_id === "4141")).toBe(true);
  });

  test("all of several connected clients receive the whole paced heatmap replay; a resync targets only its sender", async () => {
    const replay = liquidityFrames(12);
    const liquidity = fakeLiquidityPublisher(replay);
    const { server } = await startedServer({ liquidity });
    const clientsList = [fakeClient(), fakeClient(), fakeClient()];
    for (const c of clientsList) server.handleClientConnected(c);
    await drainMacrotasks();

    for (const c of clientsList) {
      expect(c.sent.filter((f) => f.type === "liquidity")).toEqual(replay);
      expect(c.close).toBeUndefined();
    }
    expect(server.clientCount()).toBe(3);

    for (const c of clientsList) c.sent = [];
    server.handleClientMessage(
      JSON.stringify({ type: "liquidity_resync" }),
      clientsList[1],
    );
    await drainMacrotasks();
    expect(clientsList[1].sent.filter((f) => f.type === "liquidity")).toEqual(
      replay,
    );
    expect(clientsList[0].sent).toEqual([]);
    expect(clientsList[2].sent).toEqual([]);
  });

  test("aggregate health stays recovering until both trade and kline have produced live data", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.simulateMessage(tradeWire(1));
    await flushAsync();

    expect(client.sent.filter((f) => f.type === "health")).toEqual([]);

    spotSocket.simulateMessage(klineWire({ closed: false }));
    await flushAsync();

    expect(client.sent.filter((f) => f.type === "health")).toEqual([
      expect.objectContaining({
        symbol: "BTC-USDT",
        recoveryState: "READY",
        stale: false,
      }),
    ]);
  });

  test("an exact decimal outside the numeric wire range is dropped and degrades aggregate health honestly", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      spotSocket.simulateMessage(tradeWire(1, { price: "9".repeat(400) }));
      await flushAsync();

      expect(
        client.sent.find((frame) => frame.type === "trade"),
      ).toBeUndefined();
      expect(client.sent.find((frame) => frame.type === "health")).toEqual(
        expect.objectContaining({
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "WIRE_VALUE_OUT_OF_RANGE",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("an out-of-range cached book cannot escape the initial-client send path", () => {
    const connection = {
      getOrderBook: () => ({
        status: "READY",
        book: {
          bids: [["10000001", "1"]],
          asks: [["10000002", "1"]],
          lastUpdateId: 1,
        },
      }),
      getFeedHealth: () => ({ stale: false, recoveryState: "READY" }),
    };
    const server = createMarketDataServer({ connection, symbol: "BTCUSDT" });
    const client = fakeClient();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() => server.handleClientConnected(client)).not.toThrow();

    expect(client.sent.find((frame) => frame.type === "book")).toEqual({
      type: "book",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      status: "UNAVAILABLE",
      reason: "WIRE_VALUE_OUT_OF_RANGE",
    });
    consoleError.mockRestore();
  });

  test("a client that stops being OPEN (readyState !== 1) between connect and a live frame is skipped, not sent to", async () => {
    const { server, spotSocket } = await startedServer();
    const closingClient = fakeClient();
    server.handleClientConnected(closingClient);
    closingClient.sent = [];
    closingClient.readyState = 2; // CLOSING, mid-session -- realistic: a client only ever reaches handleClientConnected already OPEN

    spotSocket.simulateMessage(tradeWire(1));
    await flushAsync();

    expect(closingClient.sent).toEqual([]);
  });

  test("handleClientDisconnected removes the client from the broadcast set", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(server.clientCount()).toBe(1);

    server.handleClientDisconnected(client);
    client.sent = [];
    spotSocket.simulateMessage(tradeWire(1));

    expect(server.clientCount()).toBe(0);
    expect(client.sent).toEqual([]);
  });

  test("a route disconnect broadcasts a health frame reflecting the real feed-health transition", async () => {
    const { server, spotSocket } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];

    spotSocket.close();
    // The connection's own onclose records the disconnect synchronously,
    // but this server only checks/broadcasts health on the next message
    // or the periodic poll tick (healthPollMs: 20 here) -- not on close
    // itself, since getFeedHealth has no push notification of its own.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const healthFrames = client.sent.filter((f) => f.type === "health");
    expect(healthFrames.length).toBeGreaterThan(0);
    expect(healthFrames.some((f) => f.recoveryState === "UNAVAILABLE")).toBe(
      true,
    );

    server.stop();
  });

  test("stop() disconnects the underlying connection and clears the client set", async () => {
    const { server, connection } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);

    server.stop();

    expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
    expect(server.clientCount()).toBe(0);
  });

  test("start() rejects if the route never reaches CONNECTED within the configured timeout", async () => {
    const { WebSocketImpl } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({
      webSocketImpl: WebSocketImpl,
    });
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
      connectTimeoutMs: 20,
    });

    await expect(server.start()).rejects.toThrow(/never reached CONNECTED/);
  });

  test("a failed startup subscription is fully cleaned up and the same server can start successfully on a later attempt", async () => {
    let rejectSubscription = true;
    const unsubscribeListener = jest.fn();
    const connection = {
      onMessage: jest.fn(() => unsubscribeListener),
      connect: jest.fn(),
      disconnect: jest.fn(),
      subscribeMany: jest.fn(() => {
        if (rejectSubscription) throw new Error("subscription install failed");
      }),
      unsubscribeMany: jest.fn(),
      getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
      getFeedHealth: () => ({ stale: false, recoveryState: "READY" }),
      getOrderBook: () => undefined,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
    });

    await expect(server.start()).rejects.toThrow("subscription install failed");
    expect(unsubscribeListener).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);

    rejectSubscription = false;
    await expect(server.start()).resolves.toBeUndefined();
    serversToStop.push(server);
    expect(connection.connect).toHaveBeenCalledTimes(2);
  });

  test("PERPETUAL startup waits for both the public and market routes before installing its three-feed subscription", async () => {
    let marketRoute = "CONNECTING";
    const connection = {
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
      subscribeMany: jest.fn(),
      unsubscribeMany() {},
      getStatus: () => ({
        PERPETUAL: { public: "CONNECTED", market: marketRoute },
      }),
      getFeedHealth: () => ({ stale: false, recoveryState: "READY" }),
      getOrderBook: () => undefined,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      marketKind: "PERPETUAL",
      connectPollMs: 5,
      connectTimeoutMs: 100,
    });
    serversToStop.push(server);
    const startPromise = server.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(connection.subscribeMany).not.toHaveBeenCalled();

    marketRoute = "CONNECTED";
    await startPromise;
    expect(connection.subscribeMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "TRADE" }),
        expect.objectContaining({ eventType: "KLINE" }),
        expect.objectContaining({ eventType: "DEPTH" }),
      ]),
      "ws-server",
    );
  });

  test("a dependency exception in the health poll degrades health without killing the poll, then publishes recovery", async () => {
    let healthThrows = false;
    const connection = {
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
      subscribeMany() {},
      unsubscribeMany() {},
      getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
      getFeedHealth: () => {
        if (healthThrows) throw new Error("health dependency failed");
        return { stale: false, recoveryState: "READY" };
      },
      getOrderBook: () => undefined,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
      healthPollMs: 10,
    });
    serversToStop.push(server);
    await server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    client.sent = [];
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      healthThrows = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        client.sent.some(
          (frame) =>
            frame.type === "health" &&
            frame.reason === "SERVER_CONTROL_PLANE_FAILURE",
        ),
      ).toBe(true);

      healthThrows = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        client.sent.some(
          (frame) =>
            frame.type === "health" &&
            frame.recoveryState === "READY" &&
            frame.stale === false,
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("stop is idempotent and attempts connection cleanup even when listener cleanup fails", async () => {
    const client = { readyState: 1, send() {}, close: jest.fn() };
    const listenerCleanup = jest.fn(() => {
      throw new Error("listener cleanup failed");
    });
    const connection = {
      onMessage: () => listenerCleanup,
      connect() {},
      disconnect: jest.fn(),
      subscribeMany() {},
      unsubscribeMany() {},
      getStatus: () => ({ SPOT: { public: "CONNECTED" } }),
      getFeedHealth: () => ({ stale: false, recoveryState: "READY" }),
      getOrderBook: () => undefined,
      fetchRecentKlines: async () => ({ ok: true, rows: [] }),
    };
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
    });
    await server.start();
    server.handleClientConnected(client);

    const stopping = server.stop();
    await expect(stopping).rejects.toThrow(AggregateError);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(server.clientCount()).toBe(0);
    expect(server.stop()).toBe(stopping);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  test("start() after stop() is a fresh session: it can subscribe again rather than staying permanently stopped", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    // fetchImpl is required here, not optional -- start() now also
    // triggers ensurePairWarm()'s kline backfill (fire-and-forget), which
    // without this would hit live Binance for real on every test run,
    // same reasoning as fakeFetchImpl()'s own comment above.
    const connection = createBinanceConnection({
      webSocketImpl: WebSocketImpl,
      fetchImpl: fakeFetchImpl(),
    });
    const server = createMarketDataServer({
      connection,
      symbol: "BTCUSDT",
      connectPollMs: 5,
      healthPollMs: 20,
    });
    serversToStop.push(server);

    const firstStart = server.start();
    await new Promise((resolve) => setImmediate(resolve));
    instances
      .find((i) => i.url.endsWith("stream.binance.com/stream"))
      .simulateOpen();
    await firstStart;
    server.stop();

    const secondStart = server.start();
    await new Promise((resolve) => setImmediate(resolve));
    const reopened = instances
      .filter((i) => i.url.endsWith("stream.binance.com/stream"))
      .at(-1);
    reopened.simulateOpen();
    await secondStart;

    const sent = reopened.sentMessages.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.method === "SUBSCRIBE")).toBe(true);
  });

  describe("kline backfill + background-warm pairs", () => {
    function klineRow(openTime) {
      return [
        openTime,
        "64200.00",
        "64300.50",
        "64150.25",
        "64275.99",
        "12.345",
        openTime + 59_999,
        "792345.11",
        418,
        "6.0",
        "385000.0",
        "0",
      ];
    }

    // Routes /klines to a per-symbol page of rows, /depth to the usual
    // empty-but-valid snapshot -- lets a test control exactly what each
    // symbol's backfill returns, matching real per-pair independence.
    function fetchImplWithKlines(rowsBySymbol) {
      return jest.fn(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) {
          const requestedSymbol = parsed.searchParams.get("symbol");
          return jsonResponse(rowsBySymbol[requestedSymbol] ?? []);
        }
        return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
      });
    }

    test("a live kline jump invalidates warm status and immediately repairs the missing interval", async () => {
      const observedOpenTime = 1786449720000;
      const previousOpenTime = observedOpenTime - 2 * 60_000;
      const historyBuffer = createHistoryBuffer();
      const storedBar = {
        type: "bar",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: previousOpenTime,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
        buy_volume: 0.6,
        trade_count: 1,
        closed: true,
      };
      historyBuffer.recordBar(storedBar);
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [storedBar],
          coversFullWindow: true,
        })),
      };
      const { spotSocket } = await startedServer({
        historyBuffer,
        storageReader,
      });
      expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(1);

      spotSocket.simulateMessage(klineWire({ openTime: observedOpenTime }));
      await flushAsync();
      await flushAsync();

      expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(2);
    });

    test("start() backfills the boot pair and broadcasts a corrected snapshot to a connected client", async () => {
      let openTime;
      const fetchImpl = jest.fn(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) {
          openTime = Number(parsed.searchParams.get("startTime"));
          return jsonResponse([klineRow(openTime)]);
        }
        return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
      });
      const { server } = await startedServer({
        fetchImpl,
        backfillRetryBaseMs: 5,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      // The first snapshot on connect is whatever's in the buffer right
      // now -- empty, since backfill is still in flight (fire-and-forget,
      // not awaited by start()).
      expect(client.sent.find((f) => f.type === "snapshot")).toEqual(
        expect.objectContaining({ bars: [] }),
      );
      client.sent = [];

      await flushAsync();
      await flushAsync();

      // The concurrently seeded depth snapshot can legitimately reach this
      // client in the same turn as the kline repair. The guarantee is that a
      // corrected snapshot arrives, not that two independent publishers are
      // serialized into one wire frame.
      const corrected = client.sent.filter(
        (frame) =>
          frame.type === "snapshot" &&
          frame.bars.some((bar) => bar.ts_open === openTime && bar.closed),
      );
      expect(corrected).not.toHaveLength(0);
    });

    test("switching to a never-visited pair triggers exactly one backfill request even when switched to it twice rapidly", async () => {
      const fetchImpl = fetchImplWithKlines({
        ETHUSDT: [klineRow(Date.now() - 60_000)],
      });
      const { server } = await startedServer({ fetchImpl });
      const klinesCallsBefore = fetchImpl.mock.calls.filter(([url]) =>
        new URL(url).pathname.endsWith("/klines"),
      ).length;

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      await flushAsync();

      const ethKlineCalls = fetchImpl.mock.calls.filter(
        ([url]) =>
          new URL(url).pathname.endsWith("/klines") &&
          new URL(url).searchParams.get("symbol") === "ETHUSDT",
      ).length;
      expect(ethKlineCalls).toBe(1);
      void klinesCallsBefore;
    });

    test("switching away from an already-warm pair and back does not re-trigger its backfill", async () => {
      const ethBar = {
        type: "bar",
        provider: "BINANCE",
        symbol: "ETH-USDT",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: Math.floor((Date.now() - 60_000) / 60_000) * 60_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1,
        buy_volume: 0.6,
        trade_count: 1,
        closed: true,
      };
      const storageReader = {
        readRecentCandles: jest.fn((symbol) => ({
          rows: symbol === "ETHUSDT" ? [ethBar] : [],
          coversFullWindow: true,
        })),
      };
      const { server } = await startedServer({
        storageReader,
        backfillRetryBaseMs: 5,
      });

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      await flushAsync();
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();

      const ethWarmupReads = storageReader.readRecentCandles.mock.calls.filter(
        ([symbol, marketKind]) => symbol === "ETHUSDT" && marketKind === "SPOT",
      ).length;
      expect(ethWarmupReads).toBe(1);
    });

    test("an incomplete backfill is eligible for a later retry instead of being marked warm forever", async () => {
      let ethKlineCalls = 0;
      const fetchImpl = jest.fn(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) {
          if (parsed.searchParams.get("symbol") === "ETHUSDT") {
            ethKlineCalls += 1;
            if (ethKlineCalls === 1) {
              return new Response("upstream failure", { status: 500 });
            }
            return jsonResponse([klineRow(Date.now() - 60_000)]);
          }
          return jsonResponse([]);
        }
        return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
      });
      const { server } = await startedServer({
        fetchImpl,
        backfillRetryBaseMs: 5,
      });

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      await flushAsync();
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      await flushAsync();

      expect(ethKlineCalls).toBeGreaterThanOrEqual(2);
    });

    test("late frames for an unsubscribed pair are ignored and cannot contaminate the next selection", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      await flushAsync();

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      client.sent = [];

      spotSocket.simulateMessage(tradeWire(555));
      spotSocket.simulateMessage(klineWire({ closed: true }));
      await flushAsync();

      expect(
        client.sent.filter((f) => f.type === "trade" || f.type === "bar"),
      ).toEqual([]);

      client.sent = [];
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      const snapshot = client.sent.find((f) => f.type === "snapshot");
      expect(snapshot.trades).toEqual([]);
      expect(snapshot.bars).toEqual([]);
    });

    test("a backfill that resolves after the user already switched away does not broadcast to the now-different active pair", async () => {
      let resolveKlines;
      const fetchImpl = jest.fn(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) {
          if (parsed.searchParams.get("symbol") === "ETHUSDT") {
            await new Promise((resolve) => {
              resolveKlines = resolve;
            });
            return jsonResponse([klineRow(Date.now() - 60_000)]);
          }
          return jsonResponse([]);
        }
        return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
      });
      const { server } = await startedServer({ fetchImpl });
      const client = fakeClient();
      server.handleClientConnected(client);
      await flushAsync();

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT")); // backfill now in flight, blocked on resolveKlines
      await flushAsync();
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT")); // switched away before it resolved
      await flushAsync();
      client.sent = [];

      resolveKlines();
      await flushAsync();
      await flushAsync();

      expect(client.sent.filter((f) => f.type === "snapshot")).toEqual([]);
    });

    function storageBar(
      tsOpen,
      providerSymbol = "ETHUSDT",
      marketKind = "SPOT",
    ) {
      return {
        type: "bar",
        provider: "BINANCE",
        symbol: `${providerSymbol.slice(0, -4)}-USDT`,
        marketKind,
        interval_ms: 60_000,
        ts_open: tsOpen,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1,
        buy_volume: 0.6,
        trade_count: 1,
        closed: true,
      };
    }

    describe("storage-first warm-up", () => {
      test("BACKFILL_DAYS keeps UI recovery bounded to the seven-day REST contract", () => {
        expect(BACKFILL_DAYS).toBe(7);
      });

      test("full storage coverage skips REST entirely and still lands in backfilledPairs", async () => {
        const fetchImpl = fetchImplWithKlines({});
        const storageReader = {
          readRecentCandles: jest.fn((providerSymbol, pairMarketKind) => ({
            rows: [
              storageBar(
                Math.floor(Date.now() / 60_000) * 60_000 - 60_000,
                providerSymbol,
                pairMarketKind,
              ),
            ],
            coversFullWindow: true,
          })),
        };
        const { server } = await startedServer({ fetchImpl, storageReader });

        server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
        await flushAsync();
        await flushAsync();

        const ethKlineCalls = fetchImpl.mock.calls.filter(
          ([url]) =>
            new URL(url).pathname.endsWith("/klines") &&
            new URL(url).searchParams.get("symbol") === "ETHUSDT",
        ).length;
        expect(ethKlineCalls).toBe(0);

        storageReader.readRecentCandles.mockClear();
        server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
        server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
        await flushAsync();
        expect(storageReader.readRecentCandles).not.toHaveBeenCalled();
      });

      test("partial storage coverage feeds rows in immediately and still fires the existing REST backfill once", async () => {
        let restOpenTime;
        const fetchImpl = jest.fn(async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname.endsWith("/klines")) {
            restOpenTime = Number(parsed.searchParams.get("startTime"));
            return jsonResponse([klineRow(restOpenTime)]);
          }
          return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
        });
        const storageOpenTime =
          Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
        const storageReader = {
          readRecentCandles: jest.fn((providerSymbol, pairMarketKind) => ({
            rows: [storageBar(storageOpenTime, providerSymbol, pairMarketKind)],
            coversFullWindow: false,
          })),
        };
        // The retry base must not be able to elapse during this test's flushes:
        // this asserts the backfill fires exactly ONCE, and a 5ms base raced the
        // flushes under parallel load and fired a second REST call (L1L2-V2-016).
        // Nothing here needs a retry -- fetchImpl always succeeds.
        const { server } = await startedServer({
          fetchImpl,
          storageReader,
          backfillRetryBaseMs: 60_000,
        });
        const client = fakeClient();
        server.handleClientConnected(client);
        await flushAsync();
        client.sent = [];

        server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
        await flushAsync();
        const afterStorage = client.sent.filter((f) => f.type === "snapshot");
        expect(afterStorage.length).toBeGreaterThanOrEqual(1);
        expect(afterStorage.at(-1).bars).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ ts_open: storageOpenTime }),
          ]),
        );

        await flushAsync();
        await flushAsync();

        const ethKlineCalls = fetchImpl.mock.calls.filter(
          ([url]) =>
            new URL(url).pathname.endsWith("/klines") &&
            new URL(url).searchParams.get("symbol") === "ETHUSDT",
        ).length;
        expect(ethKlineCalls).toBe(1);

        const finalSnapshot = client.sent
          .filter((f) => f.type === "snapshot")
          .at(-1);
        expect(finalSnapshot.bars).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ ts_open: storageOpenTime }),
            expect.objectContaining({ ts_open: restOpenTime }),
          ]),
        );
      });

      test("a storageReader that throws falls through to REST unchanged, not aborting the whole warm-up", async () => {
        const fetchImpl = fetchImplWithKlines({
          ETHUSDT: [klineRow(Date.now() - 60_000)],
        });
        const storageReader = {
          readRecentCandles: jest.fn(() => {
            throw new Error("boom");
          }),
        };
        const { server } = await startedServer({ fetchImpl, storageReader });

        server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
        await flushAsync();
        await flushAsync();

        const ethKlineCalls = fetchImpl.mock.calls.filter(
          ([url]) =>
            new URL(url).pathname.endsWith("/klines") &&
            new URL(url).searchParams.get("symbol") === "ETHUSDT",
        ).length;
        expect(ethKlineCalls).toBe(1);
      });
    });
  });

  describe("large trade detector wiring (P4.01)", () => {
    // There is no notional floor and no baseline any more. Every trade is a
    // marker candidate; what reaches a client is decided purely by magnitude
    // rank within its (bucket, side), so a quiet instrument is never starved
    // and a busy one is never flooded.

    test("a large trade on the active pair broadcasts a marker frame to connected clients", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(tradeWire(1, { quantity: "1" }));
      await flushAsync();

      const markers = client.sent.filter((f) => f.type === "marker");
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        type: "marker",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        side: "buy",
        trade_id: "1",
      });
    });

    test("a small trade is still a candidate -- no notional floor can starve a quiet instrument", async () => {
      const { server, spotSocket } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(tradeWire(1, { quantity: "0.002" }));
      await flushAsync();

      const markers = client.sent.filter((f) => f.type === "marker");
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ trade_id: "1", size: 0.002 });
    });

    test("one bucket-side retains only its largest few, so a burst cannot flood the snapshot", async () => {
      const {
        MARKERS_PER_BUCKET_SIDE,
      } = require("../../src/indicators/large-trade/large-trade-detection");
      const { server, spotSocket } = await startedServer();

      for (let i = 0; i < 10; i += 1) {
        spotSocket.simulateMessage(tradeWire(i + 1, { quantity: "0.002" }));
      }
      await flushAsync();

      const client = fakeClient();
      server.handleClientConnected(client);
      const snapshot = client.sent.find((f) => f.type === "snapshot");
      expect(snapshot.markers).toHaveLength(MARKERS_PER_BUCKET_SIDE);
    });

    test("a large trade from an unsubscribed pair is ignored rather than retained for a later selection", async () => {
      const { server, spotSocket } = await startedServer();
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      await flushAsync();

      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(tradeWire(1, { quantity: "1" }));
      await flushAsync();
      expect(client.sent.filter((f) => f.type === "marker")).toEqual([]);

      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      await flushAsync();

      const btcSnapshots = client.sent.filter(
        (f) => f.type === "snapshot" && f.symbol === "BTC-USDT",
      );
      const lastSnapshot = btcSnapshots[btcSnapshots.length - 1];
      expect(lastSnapshot.markers).toEqual([]);
    });

    test("a fresh client connecting to the currently active pair sees no markers until one actually fires -- an empty snapshot is honest, not a placeholder", async () => {
      const { server } = await startedServer();
      const client = fakeClient();
      server.handleClientConnected(client);

      const snapshot = client.sent.find((f) => f.type === "snapshot");
      expect(snapshot.markers).toEqual([]);
    });

    test("warm-up replays large trades from storage history for the active pair, marking each as a marker in the initial snapshot", async () => {
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readRecentTrades: jest.fn(() => ({ rows: [] })),
        readLargeTrades: jest.fn(() => ({
          rows: [
            {
              trade: {
                ts_exchange: Date.now() - 1000,
                price: 64275.99,
                size: 1,
                side: "buy",
                trade_id: "warm-1",
              },
              baselineSnapshot: null,
            },
          ],
        })),
      };
      const { server } = await startedServer({ storageReader });
      const client = fakeClient();
      server.handleClientConnected(client);

      const snapshot = client.sent.find((f) => f.type === "snapshot");
      expect(snapshot.markers).toHaveLength(1);
      expect(snapshot.markers[0]).toMatchObject({
        trade_id: "warm-1",
        symbol: "BTC-USDT",
      });
      expect(storageReader.readLargeTrades).toHaveBeenCalledWith(
        "BTCUSDT",
        "SPOT",
        expect.objectContaining({
          bucketMs: expect.any(Number),
          perBucketSideLimit: expect.any(Number),
          limit: expect.any(Number),
        }),
      );
    });

    // Property: every warm-up chunk request is one the live-storage route
    // accepts. Oracle: the route's own validator, so a retention-cap change
    // can never again push the per-chunk limit past the route's row ceiling
    // (100k markers vs a 45k route cap refused every chunk with a 400 on
    // 2026-09-20 and no bubbles were backfilled at all).
    test("the warm-up asks storage for a chunk the live-storage route will accept, whatever the marker retention cap is", async () => {
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readRecentTrades: jest.fn(() => ({ rows: [] })),
        readLargeTrades: jest.fn(() => ({ rows: [] })),
      };
      await startedServer({ storageReader });
      expect(storageReader.readLargeTrades).toHaveBeenCalled();
      for (const [, , options] of storageReader.readLargeTrades.mock.calls) {
        expect(validateQueryBounds("large-trades", options)).toBeNull();
        expect(options.limit).toBe(MAX_ROW_LIMIT_BY_ROUTE["large-trades"]);
        expect(options.limit).toBeLessThan(DEFAULT_MAX_MARKERS);
      }
    });

    test("a slow asynchronous marker warm-up never blocks server startup or live client snapshots", async () => {
      let resolveLargeTrades;
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readRecentTrades: jest.fn(() => ({ rows: [] })),
        readLargeTradesAsync: jest.fn(
          () =>
            new Promise((resolve) => {
              resolveLargeTrades = resolve;
            }),
        ),
      };
      const { server } = await startedServer({ storageReader });
      const client = fakeClient();
      server.handleClientConnected(client);
      expect(
        client.sent.find((frame) => frame.type === "snapshot").markers,
      ).toEqual([]);

      resolveLargeTrades({
        available: true,
        rows: [
          {
            trade: {
              ts_exchange: Date.now() - 1000,
              price: 64_275.99,
              size: 1,
              side: "buy",
              trade_id: "async-warm",
            },
            baselineSnapshot: null,
          },
        ],
      });
      await flushAsync();

      const warmed = client.sent
        .filter((frame) => frame.type === "snapshot")
        .at(-1);
      expect(warmed.markers).toEqual([
        expect.objectContaining({ trade_id: "async-warm" }),
      ]);
    });

    test("a warm-up slice publishes its new markers as an appending history page, not a reset", async () => {
      let resolveLargeTrades;
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readRecentTrades: jest.fn(() => ({ rows: [] })),
        readLargeTradesAsync: jest.fn(
          () =>
            new Promise((resolve) => {
              resolveLargeTrades = resolve;
            }),
        ),
      };
      const { server } = await startedServer({ storageReader });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(
        JSON.stringify({ type: "capabilities", marker_history: true }),
        client,
      );
      client.sent = [];

      const base = Date.now() - 60 * 60 * 1000;
      resolveLargeTrades({
        available: true,
        rows: [2, 0, 1].map((offset) => ({
          trade: {
            ts_exchange: base + offset * 60_000,
            price: 64_275.99,
            size: 1,
            side: "buy",
            trade_id: `slice-${offset}`,
          },
          baselineSnapshot: null,
        })),
      });
      await flushAsync();

      const pages = client.sent.filter(
        (frame) => frame.type === "marker_history",
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ reset: false, seq: 0 });
      expect(pages[0].rows.map((row) => row[4])).toEqual([
        "slice-0",
        "slice-1",
        "slice-2",
      ]);
      const snapshotIndex = client.sent.findIndex(
        (frame) => frame.type === "snapshot",
      );
      expect(client.sent.indexOf(pages[0])).toBeGreaterThan(snapshotIndex);
    });

    test("a live replay of a storage-warmed large trade does not emit a duplicate marker", async () => {
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readLargeTrades: jest.fn(() => ({
          rows: [
            {
              trade: {
                ts_exchange: Date.now() - 1000,
                price: 64275.99,
                size: 1,
                side: "buy",
                trade_id: "1",
              },
              baselineSnapshot: null,
            },
          ],
        })),
      };
      const { server, spotSocket } = await startedServer({ storageReader });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(tradeWire(1, { quantity: "1" }));
      await flushAsync();

      expect(client.sent.filter((frame) => frame.type === "marker")).toEqual(
        [],
      );
    });

    test("a transient large-trade storage read failure is retried when the pair is revisited", async () => {
      let ethAttempts = 0;
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readLargeTrades: jest.fn((pairSymbol) => {
          if (pairSymbol !== "ETHUSDT") return { rows: [] };
          ethAttempts += 1;
          if (ethAttempts === 1) throw new Error("temporarily locked");
          return {
            rows: [
              {
                trade: {
                  ts_exchange: Date.now() - 1000,
                  price: 64275.99,
                  size: 1,
                  side: "buy",
                  trade_id: "eth-recovered",
                },
                baselineSnapshot: null,
              },
            ],
          };
        }),
      };
      const { server } = await startedServer({
        storageReader,
        healthPollMs: 10_000,
      });
      const client = fakeClient();
      server.handleClientConnected(client);

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();

      expect(ethAttempts).toBeGreaterThanOrEqual(2);
      const snapshot = client.sent
        .filter(
          (frame) => frame.type === "snapshot" && frame.symbol === "ETH-USDT",
        )
        .at(-1);
      expect(snapshot.markers).toEqual([
        expect.objectContaining({ trade_id: "eth-recovered" }),
      ]);
    });

    test("an unavailable fail-soft storage read is not mistaken for a completed empty marker warm-up", async () => {
      let ethAttempts = 0;
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readLargeTrades: jest.fn((pairSymbol) => {
          if (pairSymbol !== "ETHUSDT") return { rows: [], available: true };
          ethAttempts += 1;
          if (ethAttempts === 1) return { rows: [], available: false };
          return {
            available: true,
            rows: [
              {
                trade: {
                  ts_exchange: Date.now() - 1000,
                  price: 64_275.99,
                  size: 1,
                  side: "buy",
                  trade_id: "eth-recovered",
                },
                baselineSnapshot: null,
              },
            ],
          };
        }),
      };
      const { server } = await startedServer({
        storageReader,
        healthPollMs: 10_000,
      });
      const client = fakeClient();
      server.handleClientConnected(client);

      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      await flushAsync();

      expect(ethAttempts).toBeGreaterThanOrEqual(2);
      const snapshot = client.sent
        .filter(
          (frame) => frame.type === "snapshot" && frame.symbol === "ETH-USDT",
        )
        .at(-1);
      expect(snapshot.markers).toEqual([
        expect.objectContaining({ trade_id: "eth-recovered" }),
      ]);
    });

    test("passive maintenance does not hammer unavailable marker and aggressive-print storage", async () => {
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readLargeTradesAsync: jest.fn(async () => ({
          rows: [],
          available: false,
        })),
        readAggressivePrintsAsync: jest.fn(async () => ({
          rows: [],
          available: false,
          hasMore: false,
          nextCursor: null,
        })),
      };
      const { server } = await startedServer({
        storageReader,
        healthPollMs: 5,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(storageReader.readLargeTradesAsync).toHaveBeenCalledTimes(1);
      expect(storageReader.readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    });

    // Property: a marker warm-up that loses a chunk resumes at that chunk on
    // its next attempt instead of starting over from the live edge (the first
    // real run re-downloaded eight hours of markers three times while the
    // link was saturated). Oracle: the windows the storage reader is asked
    // for across the attempts, and the retained marker count.
    test("a marker warm-up that fails mid-way resumes from the failed chunk, not from the beginning", async () => {
      const windows = [];
      let failAtCall = 3;
      let calls = 0;
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
        readLargeTradesAsync: jest.fn(async (_symbol, _marketKind, options) => {
          calls += 1;
          windows.push([options.fromMs, options.nowMs]);
          if (calls === failAtCall) return { rows: [], available: false };
          return {
            rows: [
              {
                trade: {
                  ts_exchange: options.nowMs - 1,
                  price: 64_275.99,
                  size: 1,
                  side: "buy",
                  trade_id: `w-${calls}`,
                },
                baselineSnapshot: null,
              },
            ],
            available: true,
          };
        }),
      };
      let clock = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
      try {
        const { server } = await startedServer({
          storageReader,
          healthPollMs: 5,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(windows).toHaveLength(3);
        const [, secondWindow, failedWindow] = windows;
        expect(failedWindow[1]).toBe(secondWindow[0] - 1);

        clock += 16_000;
        failAtCall = -1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(windows.length).toBeGreaterThan(3);
        expect(windows[3]).toEqual(failedWindow);
        expect(windows.slice(3).some(([, to]) => to === windows[0][1])).toBe(
          false,
        );
        const floorMs = Math.max(
          0,
          windows[0][1] - BACKFILL_DAYS * 24 * 60 * 60 * 1000,
        );
        const complete = await new Promise((resolve) => {
          const started = performance.now();
          const poll = setInterval(() => {
            if (windows.at(-1)[0] === floorMs) {
              clearInterval(poll);
              resolve(true);
            } else if (performance.now() - started > 5_000) {
              clearInterval(poll);
              resolve(false);
            }
          }, 10);
        });
        expect(complete).toBe(true);
        const ids = new Set(windows.map(([, to]) => to));
        expect(ids.size).toBe(windows.length - 1);
        server.stop();
      } finally {
        nowSpy.mockRestore();
      }
    }, 15_000);
  });

  describe("large trade detector -- rank within a bucket, not an absolute floor", () => {
    async function seedBucket(spotSocket, low, high, count = 24) {
      for (let i = 0; i < count; i += 1) {
        const notional = i % 2 === 0 ? low : high;
        spotSocket.simulateMessage(
          tradeWire(1_000 + i, { price: "1", quantity: String(notional) }),
        );
      }
      // Raw ingress yields after bounded work. Under parallel-suite CPU pressure
      // 24 frames can legitimately require several turns, so one setImmediate
      // is not a completion barrier and can leak seed markers into the client
      // assertions below. Drain enough bounded batches before connecting it.
      for (let turn = 0; turn < 4; turn += 1) await flushAsync();
    }

    test("a large trade is NOT shown when everything else in its bucket is larger", async () => {
      const { server, spotSocket } = await startedServer();
      await seedBucket(spotSocket, 150_000, 250_000);
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(
        tradeWire(2_000, { price: "1", quantity: "210000" }),
      );
      await flushAsync();

      expect(client.sent.filter((f) => f.type === "marker")).toEqual([]);
    });

    test("a small trade IS shown when it dwarfs everything else in its bucket", async () => {
      const { server, spotSocket } = await startedServer();
      await seedBucket(spotSocket, 100, 150);
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(
        tradeWire(2_001, { price: "1", quantity: "5000" }),
      );
      await flushAsync();

      const markers = client.sent.filter((f) => f.type === "marker");
      expect(markers).toHaveLength(1);
      expect(markers[0].trade_id).toBe("2001");
    });

    test("an enormous outlier is always shown, whatever the surrounding scale", async () => {
      const { server, spotSocket } = await startedServer();
      await seedBucket(spotSocket, 150_000, 250_000);
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(
        tradeWire(2_002, { price: "1", quantity: "5000000" }),
      );
      await flushAsync();

      expect(client.sent.filter((f) => f.type === "marker")).toHaveLength(1);
    });

    test("a marker carries no baseline fields -- nothing on the wire can go degenerate any more", async () => {
      const { server, spotSocket } = await startedServer();
      await seedBucket(spotSocket, 100, 150);
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      spotSocket.simulateMessage(
        tradeWire(2_003, { price: "1", quantity: "5000" }),
      );
      await flushAsync();

      const [marker] = client.sent.filter((f) => f.type === "marker");
      expect(marker.baseline_log_median).toBeUndefined();
      expect(marker.baseline_log_mad).toBeUndefined();
    });
  });

  describe("volume profile wiring (P4.09 Steps 4-5)", () => {
    // Timestamps sit just before "now" because the server derives row width
    // from a lookback window ending at Date.now(). Fixture rows parked at
    // epoch 1970 fall outside every real query window.
    function volumeProfileTradeRows(nowMs = Date.now()) {
      return [
        {
          ts_exchange: nowMs - 3_000,
          trade_id: "vp-1",
          price: 64270,
          size: 1,
          side: "buy",
        },
        {
          ts_exchange: nowMs - 2_000,
          trade_id: "vp-2",
          price: 64280,
          size: 2,
          side: "sell",
        },
        {
          ts_exchange: nowMs - 1_000,
          trade_id: "vp-3",
          price: 64290,
          size: 1,
          side: "buy",
        },
      ];
    }

    // A minimal simulated bucketed backend: `readRecentTrades` serves its
    // fixture rows exactly once per cursor chain (cursor: null), then empty
    // pages thereafter, exactly like a real cursor-based reader that has
    // caught up -- returning the same rows unconditionally would double-
    // apply them on every poll tick. `readVolumeProfile` re-derives buckets
    // from the same fixture using the same floor-bucketing math the real
    // engine uses, keyed by whatever originPrice/rowWidth the caller
    // resolved -- this is what finalizePeriod (rollover) and
    // sendFixedRangeProfile (fixed_range) each call directly.
    function fakeVolumeProfileStorageReader({
      tradeRows = volumeProfileTradeRows(),
    } = {}) {
      const readRecentTrades = jest.fn((_symbol, _marketKind, { cursor }) => {
        if (cursor !== null)
          return { rows: [], nextCursor: cursor, available: true };
        if (tradeRows.length === 0)
          return { rows: [], nextCursor: null, available: true };
        return {
          rows: tradeRows,
          nextCursor: {
            ts: tradeRows[tradeRows.length - 1].ts_exchange,
            id: tradeRows.length,
          },
          available: true,
        };
      });
      const readVolumeProfile = jest.fn(
        (_symbol, _marketKind, { fromTs, toTs, originPrice, rowWidth }) => {
          const buckets = new Map();
          for (const row of tradeRows) {
            if (row.ts_exchange < fromTs || row.ts_exchange > toTs) continue;
            const bucketIndex = Math.floor(
              (row.price - originPrice) / rowWidth,
            );
            const existing = buckets.get(bucketIndex) ?? {
              volume: 0,
              buyVolume: 0,
              sellVolume: 0,
            };
            existing.volume += row.size;
            if (row.side === "buy") existing.buyVolume += row.size;
            else if (row.side === "sell") existing.sellVolume += row.size;
            buckets.set(bucketIndex, existing);
          }
          return {
            buckets: [...buckets.entries()].map(([bucket, v]) => ({
              bucket,
              ...v,
            })),
            available: true,
          };
        },
      );
      // The real reader derives row width from an aggregate over the whole
      // window. A double that omits this reports "no price range", which
      // makes every warm-up silently bail -- so it has to answer honestly.
      const readPriceRange = jest.fn(
        (_symbol, _marketKind, { fromTs, toTs }) => {
          const inWindow = tradeRows.filter(
            (row) => row.ts_exchange >= fromTs && row.ts_exchange < toTs,
          );
          if (inWindow.length === 0)
            return {
              minPrice: null,
              maxPrice: null,
              tradeCount: 0,
              available: true,
            };
          return {
            minPrice: Math.min(...inWindow.map((row) => row.price)),
            maxPrice: Math.max(...inWindow.map((row) => row.price)),
            tradeCount: inWindow.length,
            available: true,
          };
        },
      );
      return { readRecentTrades, readVolumeProfile, readPriceRange };
    }

    function fakeTickSizeResolver(tickSize = 1) {
      return { getBinanceTickSize: jest.fn(async () => tickSize) };
    }

    function profileConfigWire(fields) {
      return JSON.stringify({
        type: "profile_config",
        mode: "continuous",
        period_ms: null,
        bin_size_multiplier: null,
        range_start_ts: null,
        range_end_ts: null,
        ...fields,
      });
    }

    async function settle(ms = 50) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    function profileHistoryWire(fields) {
      return JSON.stringify({
        type: "profile_history",
        mode: "continuous",
        request_id: 1,
        period_ms: 60_000,
        bin_size_multiplier: null,
        ranges: [],
        ...fields,
      });
    }

    // A cache double that answers the batched path, so these tests actually
    // execute sendHistoricalProfiles rather than short-circuiting on a null
    // cache the way every other test in this file does.
    function fakeVolumeProfileCache({
      byPeriod = new Map(),
      spans = null,
    } = {}) {
      return {
        coverageGaps: () => [],
        materialize: () => true,
        readBucketRange: () => ({ minBucket: 0, maxBucket: 40, rowCount: 1 }),
        readPeriodBucketSpans: () =>
          spans ??
          [...byPeriod.keys()].map((periodStartTs) => ({
            periodStartTs,
            minBucket: 0,
            maxBucket: 40,
          })),
        readPeriodBuckets: () => byPeriod,
        close: () => {},
      };
    }

    function alignedRanges(periodMs, count, nowMs) {
      const end = Math.floor(nowMs / periodMs) * periodMs;
      const out = [];
      for (let i = count; i > 0; i -= 1) {
        const start = end - i * periodMs;
        out.push({ range_start_ts: start, range_end_ts: start + periodMs });
      }
      return out;
    }

    // Report 57 W2, O-6: a warm-up that finds no trades in its window (the
    // BTC-perp capture gap during FA-1) used to leave the feature at RUNNING
    // forever while the 2 s health poll re-ran the whole warm-up, overlapping
    // itself, with no backoff. It must say DEGRADED, retry on a bounded
    // backoff one attempt at a time, and recover once trades exist.
    test("a volume profile warm-up with no trades is DEGRADED, retried on backoff without overlap, then recovers (O-6)", async () => {
      const tradeRows = [];
      const storageReader = fakeVolumeProfileStorageReader({ tradeRows });
      let inFlight = 0;
      let maxInFlight = 0;
      const priceRange = storageReader.readPriceRange.getMockImplementation();
      storageReader.readPriceRange.mockImplementation(async (...args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 60));
        inFlight -= 1;
        return priceRange(...args);
      });
      const { server } = await startedServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10, volumeProfileRetryBaseMs: 400 });
      await settle(300);
      const feature = "binance.spot.btcusdt.volume_profile";
      expect(server.currentReadiness().warmups[feature]).toMatchObject({ state: "DEGRADED", reason: "RETRY_SCHEDULED" });
      const attemptsWhileBackingOff = storageReader.readPriceRange.mock.calls.length;
      expect(attemptsWhileBackingOff).toBeLessThanOrEqual(2);
      expect(maxInFlight).toBe(1);
      tradeRows.push(...volumeProfileTradeRows());
      await settle(1_200);
      expect(server.currentReadiness().warmups[feature]).toMatchObject({ state: "READY" });
      expect(maxInFlight).toBe(1);
    });

    test("a volume profile read finishing after stop makes no late readiness transition", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      let releaseRead;
      storageReader.readPriceRange.mockImplementation(() => new Promise((resolve) => { releaseRead = resolve; }));
      const { server } = await startedServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      await settle(30);
      expect(releaseRead).toEqual(expect.any(Function));
      await server.stop();
      const atStop = JSON.stringify(server.currentReadiness());
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        releaseRead({ minPrice: null, maxPrice: null, tradeCount: 0, available: true });
        await settle(30);
        expect(JSON.stringify(server.currentReadiness())).toBe(atStop);
        expect(info.mock.calls.some(([event]) => event === "market data server: operational.transition")).toBe(false);
        expect(warn.mock.calls.some(([event]) => event === "market data server: operational.transition")).toBe(false);
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    });

    test("withdraws a live profile on reader failure, replays failure to new clients, and recovers without duplicating volume", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const healthyRead =
        storageReader.readRecentTrades.getMockImplementation();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      const before = client.sent
        .filter((frame) => frame.type === "profile")
        .at(-1);
      expect(before).toBeDefined();
      storageReader.readRecentTrades.mockImplementation(() => ({
        rows: [],
        nextCursor: null,
        available: false,
      }));
      client.sent = [];
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile")).toEqual(
        [],
      );
      expect(client.sent).toContainEqual(
        expect.objectContaining({
          type: "analytics_status",
          indicator: "PROFILE",
          status: "UNAVAILABLE",
        }),
      );
      expect(server.currentAnalyticsStatus().profile).toBe("UNAVAILABLE");
      const newcomer = fakeClient();
      server.handleClientConnected(newcomer);
      expect(newcomer.sent).toContainEqual(
        expect.objectContaining({
          type: "analytics_status",
          indicator: "PROFILE",
          status: "UNAVAILABLE",
        }),
      );
      storageReader.readRecentTrades.mockImplementation(healthyRead);
      await settle();
      const after = client.sent
        .filter((frame) => frame.type === "profile")
        .at(-1);
      expect(after.buckets).toEqual(before.buckets);
      expect(server.currentAnalyticsStatus().profile).toBe("READY");
      expect(
        client.sent
          .filter(
            (frame) =>
              frame.type === "analytics_status" &&
              frame.indicator === "PROFILE",
          )
          .at(-1).status,
      ).toBe("READY");
    });

    test("warms up a session for the active pair and broadcasts a profile frame on the next poll tick", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame).toBeDefined();
      expect(frame.mode).toBe("continuous");
      expect(frame.period_end_ts).toBeNull();
      expect(frame.buckets.length).toBeGreaterThan(0);
    });

    test("never touches the tick-size resolver when storageReader lacks readVolumeProfile/readRecentTrades -- matching every other test's fake storageReader in this file", async () => {
      const storageReader = {
        readRecentCandles: jest.fn(() => ({
          rows: [],
          coversFullWindow: true,
        })),
      };
      const tickSizeResolver = fakeTickSizeResolver();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver,
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(tickSizeResolver.getBinanceTickSize).not.toHaveBeenCalled();
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
    });

    test("does not create a session when the reference lookback window has no trades", async () => {
      const storageReader = fakeVolumeProfileStorageReader({ tradeRows: [] });
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
    });

    test("broadcasts no profile frame at all when no storageReader is configured", async () => {
      const { server } = await startedServer({ volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
    });

    test("an invalid profile_config request (missing/extra fields, unrecognized mode, invalid period_ms/bin_size_multiplier, or a range on a non-fixed_range mode) is logged and ignored -- never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      expect(() =>
        server.handleClientMessage("not json", client),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          JSON.stringify({ type: "profile_config", mode: "continuous" }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(profileConfigWire({ extra: true }), client),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({ mode: "bogus" }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(profileConfigWire({ period_ms: 0 }), client),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({ period_ms: 1.5 }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({ bin_size_multiplier: 0 }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({ range_start_ts: 100 }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({ mode: "fixed_range" }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({
            mode: "fixed_range",
            range_start_ts: 500,
            range_end_ts: 500,
          }),
          client,
        ),
      ).not.toThrow();
      expect(() =>
        server.handleClientMessage(
          profileConfigWire({
            mode: "fixed_range",
            range_start_ts: 500,
            range_end_ts: 100,
          }),
          client,
        ),
      ).not.toThrow();

      expect(client.sent).toEqual([]);
    });

    test("a valid profile_config changes the active pair's mode and period, visible on the next broadcast frame", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      server.handleClientMessage(
        profileConfigWire({ mode: "per_candle" }),
        client,
      );
      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame.mode).toBe("per_candle");
    });

    test("a profile setting sent before warm-up completes is retained", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(profileConfigWire({ mode: "per_candle", bin_size_multiplier: 2 }), client);
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile").at(-1)?.mode).toBe("per_candle");
    });

    test("the latest of overlapping asynchronous profile rebuilds wins", async () => {
      const pending = [];
      // Only the REBUILDS are deferred, not warm-up: the mock resolves normally
      // until warm-up is done, then queues. A rebuild awaits the volatility
      // reading before it can size anything, so that is what holds it open.
      let deferFrom = Infinity;
      const volumeProfileAtr = {
        getReading: jest.fn(
          () =>
            new Promise((resolve) => {
              if (volumeProfileAtr.getReading.mock.calls.length <= deferFrom) {
                resolve(null);
                return;
              }
              pending.push(resolve);
            }),
        ),
        invalidate: jest.fn(),
      };
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
        volumeProfileAtr,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];
      // Every read so far was warm-up; defer everything from here on.
      deferFrom = volumeProfileAtr.getReading.mock.calls.length;

      server.handleClientMessage(
        profileConfigWire({ period_ms: 60_000 }),
        client,
      );
      server.handleClientMessage(
        profileConfigWire({ period_ms: 120_000 }),
        client,
      );
      await flushAsync();
      expect(pending).toHaveLength(2);

      // The newer rebuild resolves second, and must be the one that survives.
      pending[1](null);
      await settle();
      expect(
        client.sent.filter((frame) => frame.type === "profile").at(-1)
          .period_start_ts % 120_000,
      ).toBe(0);

      // The older rebuild resolving late must not overwrite the newer session.
      pending[0](null);
      await settle();
      expect(
        client.sent.filter((frame) => frame.type === "profile").at(-1)
          .period_start_ts % 120_000,
      ).toBe(0);
    });

    test("unavailable rollover withdraws the old period and recovers when the range returns", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      server.handleClientMessage(
        profileConfigWire({ period_ms: 1000 }),
        client,
      );
      await settle();
      const range = storageReader.readPriceRange.getMockImplementation();
      storageReader.readPriceRange.mockReturnValue({
        available: false,
        minPrice: null,
        maxPrice: null,
        tradeCount: 0,
      });
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2500);
      client.sent = [];
      await settle();
      expect(
        client.sent.filter((frame) => frame.type === "profile"),
      ).toHaveLength(0);
      expect(server.currentAnalyticsStatus().profile).toBe("UNAVAILABLE");
      storageReader.readPriceRange.mockImplementation(range);
      await settle();
      expect(server.currentAnalyticsStatus().profile).toBe("READY");
      expect(client.sent.some((frame) => frame.type === "profile")).toBe(true);
    });

    test("a small period_ms rolls the open period over to a fresh session on the next poll tick", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();

      const [firstFrame] = client.sent.filter((f) => f.type === "profile");
      expect(firstFrame).toBeDefined();
      client.sent = [];

      jest
        .spyOn(Date, "now")
        .mockReturnValue(Math.floor(Date.now() / 1000) * 1000 + 2500);
      server.handleClientMessage(
        profileConfigWire({ period_ms: 1000 }),
        client,
      );
      await settle();

      const [rolledFrame] = client.sent.filter((f) => f.type === "profile");
      expect(rolledFrame).toBeDefined();
      expect(rolledFrame.period_start_ts).toBeGreaterThan(
        firstFrame.period_start_ts,
      );
    });

    test("a bin_size_multiplier override actually reaches row-width resolution on the next rollover -- not just accepted and silently dropped", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();

      const [firstFrame] = client.sent.filter((f) => f.type === "profile");
      expect(firstFrame.row_width).toBeGreaterThanOrEqual(1);
      client.sent = [];

      jest
        .spyOn(Date, "now")
        .mockReturnValue(Math.floor(Date.now() / 1000) * 1000 + 2500);
      server.handleClientMessage(
        profileConfigWire({ period_ms: 1000, bin_size_multiplier: 7 }),
        client,
      );
      await settle();

      const [rolledFrame] = client.sent.filter((f) => f.type === "profile");
      expect(rolledFrame).toBeDefined();
      expect(rolledFrame.row_width).toBeGreaterThan(firstFrame.row_width);
    });

    test("a bin_size_multiplier override on a fixed_range request reaches that one-off query's row-width resolution", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      server.handleClientMessage(
        profileConfigWire({
          mode: "fixed_range",
          range_start_ts: Date.now() - 10_000,
          range_end_ts: Date.now() + 5_000,
          bin_size_multiplier: 7,
        }),
        client,
      );
      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame).toBeDefined();
      expect(frame.row_width).toBeCloseTo((20 * 7) / 75);
    });

    test("a valid fixed_range profile_config sends a single profile frame directly to the requesting client, not broadcast", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      // A poll interval far longer than this test's own settle window --
      // isolates the fixed_range response from the unrelated, legitimate
      // background continuous-mode broadcasts every connected client
      // (this test's requester included) would otherwise also receive.
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      });
      const requester = fakeClient();
      const bystander = fakeClient();
      server.handleClientConnected(requester);
      server.handleClientConnected(bystander);
      await settle();
      requester.sent = [];
      bystander.sent = [];

      const rangeStartTs = Date.now() - 10_000;
      const rangeEndTs = Date.now() + 5_000;
      server.handleClientMessage(
        profileConfigWire({
          mode: "fixed_range",
          range_start_ts: rangeStartTs,
          range_end_ts: rangeEndTs,
        }),
        requester,
      );
      await settle();

      const requesterFrames = requester.sent.filter(
        (f) => f.type === "profile",
      );
      expect(requesterFrames).toHaveLength(1);
      expect(requesterFrames[0].mode).toBe("fixed_range");
      expect(requesterFrames[0].period_start_ts).toBe(rangeStartTs);
      expect(requesterFrames[0].period_end_ts).toBe(rangeEndTs);
      expect(bystander.sent.filter((f) => f.type === "profile")).toEqual([]);
    });

    test("a fixed-range profile that finishes after selection changes is discarded", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      const originalReadPriceRange =
        storageReader.readPriceRange.getMockImplementation();
      let resolveRange;
      storageReader.readPriceRange.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRange = resolve;
          }),
      );
      server.handleClientMessage(
        profileConfigWire({
          mode: "fixed_range",
          range_start_ts: Date.now() - 10_000,
          range_end_ts: Date.now() + 5_000,
        }),
        client,
      );
      await flushAsync();
      expect(resolveRange).toBeDefined();

      storageReader.readPriceRange.mockImplementation(originalReadPriceRange);
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
      client.sent = [];
      resolveRange({
        minPrice: 100,
        maxPrice: 110,
        tradeCount: 2,
        available: true,
      });
      await settle();

      expect(
        client.sent.filter(
          (frame) => frame.type === "profile" && frame.symbol === "BTC-USDT",
        ),
      ).toEqual([]);
    });

    describe("batched historical profiles (profile_history)", () => {
      function bucketsFor(entries) {
        return new Map(
          entries.map(([index, volume]) => [
            index,
            { volume, buyVolume: volume, sellVolume: 0, tradeCount: 1 },
          ]),
        );
      }

      async function historyServer({ byPeriod }) {
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await startedServer({
          storageReader,
          volumeProfileCache: fakeVolumeProfileCache({ byPeriod }),
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        });
        const client = fakeClient();
        server.handleClientConnected(client);
        await settle();
        client.sent = [];
        return { server, client };
      }

      test("warm-up and historical zones read the volatility under one key per instrument, so spot and perpetual never share a reading", async () => {
        const volumeProfileAtr = {
          getReading: jest.fn(async () => null),
          invalidate: jest.fn(),
        };
        const { server } = await startedServer({
          storageReader: fakeVolumeProfileStorageReader(),
          volumeProfileCache: fakeVolumeProfileCache({ byPeriod: new Map() }),
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
          volumeProfileAtr,
        });
        const client = fakeClient();
        server.handleClientConnected(client);
        await settle();
        const warmupCalls = volumeProfileAtr.getReading.mock.calls.length;
        expect(warmupCalls).toBeGreaterThan(0);
        server.handleClientMessage(
          profileHistoryWire({ period_ms: 60_000, ranges: alignedRanges(60_000, 2, Date.now()) }),
          client,
        );
        await settle();
        const historyCalls = volumeProfileAtr.getReading.mock.calls.length;
        expect(historyCalls).toBeGreaterThan(warmupCalls);
        // A new period rebuilds the session under the key the warm-up stored.
        server.handleClientMessage(profileConfigWire({ period_ms: 300_000 }), client);
        await settle();
        expect(volumeProfileAtr.getReading.mock.calls.length).toBeGreaterThan(historyCalls);
        expect(new Set(volumeProfileAtr.getReading.mock.calls.map(([key]) => key))).toEqual(new Set(["SPOT:BTCUSDT"]));
      });

      // L1L2-V2-106. P7-04 claims one active job per client, and that a new
      // request, a disconnect and shutdown each terminate superseded work.
      // Reaching that code at all requires both fakes to carry a dbPath.
      describe("cancellable history worker (P7-04)", () => {
        async function offloadServer(clientOverride = null) {
          const storageReader = fakeVolumeProfileStorageReader();
          storageReader.dbPath = "/tmp/offload-reader.sqlite";
          const volumeProfileCache = fakeVolumeProfileCache({
            byPeriod: new Map(),
          });
          volumeProfileCache.dbPath = "/tmp/offload-cache.sqlite";
          const { server, spotSocket } = await startedServer({
            storageReader,
            volumeProfileCache,
            tickSizeResolver: fakeTickSizeResolver(),
            volumeProfilePollMs: 10_000,
          });
          const client = clientOverride ?? fakeClient();
          server.handleClientConnected(client);
          await settle();
          if (Array.isArray(client.sent)) client.sent = [];
          return { server, client, spotSocket };
        }

        beforeEach(() => {
          mockStartHistoryJob.mockClear();
          mockHistoryJobCancel.mockClear();
        });

        test("offloads a historical request to the bounded worker instead of building it inline", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client } = await offloadServer();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();

          expect(mockStartHistoryJob).toHaveBeenCalledTimes(1);
        });

        test("a replacement request cancels the superseded job", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client } = await offloadServer();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();
          expect(mockHistoryJobCancel).not.toHaveBeenCalled();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });

        test("a disconnect cancels that client's in-flight job", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client } = await offloadServer();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();

          server.handleClientDisconnected(client);

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });

        test("shutdown cancels every in-flight job", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client } = await offloadServer();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();

          await server.stop();

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });

        // L1L2-V2-108. Backpressure eviction is a fourth way a client leaves,
        // alongside the three P7-04 names. safelySendSerialized drops the client
        // from `clients` and forgets its rate-limit window, but does not touch
        // its history job -- it relies on close(1013) producing a close event
        // that reaches handleClientDisconnected. That call is deliberately
        // wrapped in try/catch because it can throw, and when it does the job
        // keeps running and the jobs-by-client Map keeps the evicted client
        // object alive.
        test("evicting a slow client cancels its in-flight history job, even when close() throws", async () => {
          // Healthy at connect time, so the job actually starts; it falls behind
          // afterwards -- which is the real sequence a slow consumer follows.
          const slowClient = {
            readyState: 1,
            bufferedAmount: 0,
            close: jest.fn(() => {
              throw new Error("socket already torn down");
            }),
            send: jest.fn(),
          };
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client, spotSocket } =
            await offloadServer(slowClient);

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          );
          await settle();
          expect(mockStartHistoryJob).toHaveBeenCalledTimes(1);

          slowClient.bufferedAmount = DEFAULT_CLIENT_BUFFER_HARD_BYTES + 1;

          // over the hard ceiling: safelySendSerialized evicts at once, no grace
          spotSocket.simulateMessage(tradeWire(4242));
          await flushAsync();

          expect(server.clientCount()).toBe(0);
          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });

        test("two clients requesting the identical historical range share one worker instead of launching a duplicate", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client: clientA } = await offloadServer();
          const clientB = fakeClient();
          server.handleClientConnected(clientB);
          await settle();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            clientA,
          );
          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            clientB,
          );
          await settle();

          expect(mockStartHistoryJob).toHaveBeenCalledTimes(1);
        });

        test("one of two sharing clients disconnecting does not cancel the job the other still needs", async () => {
          const ranges = alignedRanges(60_000, 2, Date.now());
          const { server, client: clientA } = await offloadServer();
          const clientB = fakeClient();
          server.handleClientConnected(clientB);
          await settle();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            clientA,
          );
          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            clientB,
          );
          await settle();

          server.handleClientDisconnected(clientA);
          expect(mockHistoryJobCancel).not.toHaveBeenCalled();

          server.handleClientDisconnected(clientB);
          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });

        test("requests with different ranges are not merged into the same worker", async () => {
          const nowMs = Date.now();
          const rangesA = alignedRanges(60_000, 2, nowMs);
          const rangesB = alignedRanges(60_000, 3, nowMs);
          const { server, client: clientA } = await offloadServer();
          const clientB = fakeClient();
          server.handleClientConnected(clientB);
          await settle();

          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges: rangesA }),
            clientA,
          );
          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges: rangesB }),
            clientB,
          );
          await settle();

          expect(mockStartHistoryJob).toHaveBeenCalledTimes(2);
        });
      });

      test("answers one batched request with one historical frame per requested period", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 3, nowMs);
        const byPeriod = new Map(
          ranges.map((r) => [
            r.range_start_ts,
            bucketsFor([
              [10, 3],
              [11, 7],
              [12, 2],
            ]),
          ]),
        );
        const { server, client } = await historyServer({ byPeriod });

        server.handleClientMessage(
          profileHistoryWire({ period_ms: 60_000, ranges }),
          client,
        );
        await settle();

        const frames = client.sent.filter((f) => f.type === "profile");
        expect(frames).toHaveLength(3);
        for (const frame of frames) {
          expect(frame.mode).toBe("continuous");
          expect(frame.delivery_scope).toBe("HISTORICAL");
          expect(frame.history_request_id).toBe(1);
          expect(frame.buckets.length).toBeGreaterThan(0);
        }
        expect(
          frames.map((f) => f.period_start_ts).sort((a, b) => a - b),
        ).toEqual(ranges.map((r) => r.range_start_ts).sort((a, b) => a - b));
      });

      test("every frame in a batch shares one row width so buckets line up across zones", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 3, nowMs);
        const byPeriod = new Map(
          ranges.map((r, i) => [
            r.range_start_ts,
            bucketsFor([
              [10 + i, 4],
              [11 + i, 9],
            ]),
          ]),
        );
        const { server, client } = await historyServer({ byPeriod });

        server.handleClientMessage(
          profileHistoryWire({ period_ms: 60_000, ranges }),
          client,
        );
        await settle();

        const widths = new Set(
          client.sent
            .filter((f) => f.type === "profile")
            .map((f) => f.row_width),
        );
        expect(widths.size).toBe(1);
      });

      test("sends only to the requesting client, never broadcast", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 2, nowMs);
        const byPeriod = new Map(
          ranges.map((r) => [r.range_start_ts, bucketsFor([[10, 5]])]),
        );
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await startedServer({
          storageReader,
          volumeProfileCache: fakeVolumeProfileCache({ byPeriod }),
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        });
        const requester = fakeClient();
        const bystander = fakeClient();
        server.handleClientConnected(requester);
        server.handleClientConnected(bystander);
        await settle();
        requester.sent = [];
        bystander.sent = [];

        server.handleClientMessage(
          profileHistoryWire({ period_ms: 60_000, ranges }),
          requester,
        );
        await settle();

        expect(
          requester.sent.filter((f) => f.type === "profile").length,
        ).toBeGreaterThan(0);
        expect(bystander.sent.filter((f) => f.type === "profile")).toEqual([]);
      });

      test.each([
        [
          "a range whose length does not match the period",
          (r, p) => [{ ...r[0], range_end_ts: r[0].range_start_ts + p * 2 }],
        ],
        [
          "a range not aligned to the period grid",
          (r) => [
            {
              range_start_ts: r[0].range_start_ts + 1,
              range_end_ts: r[0].range_end_ts + 1,
            },
          ],
        ],
        [
          "an inverted range",
          (r) => [
            {
              range_start_ts: r[0].range_end_ts,
              range_end_ts: r[0].range_start_ts,
            },
          ],
        ],
        ["a duplicated range", (r) => [r[0], r[0]]],
        [
          "a range carrying an unexpected extra field",
          (r) => [{ ...r[0], extra: 1 }],
        ],
      ])("drops a batch containing %s", async (_label, mutate) => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 2, nowMs);
        const byPeriod = new Map(
          ranges.map((r) => [r.range_start_ts, bucketsFor([[10, 5]])]),
        );
        const { server, client } = await historyServer({ byPeriod });

        server.handleClientMessage(
          profileHistoryWire({
            period_ms: 60_000,
            ranges: mutate(ranges, 60_000),
          }),
          client,
        );
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      });

      test("drops a batch with more ranges than the server cap", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 200, nowMs);
        const { server, client } = await historyServer({ byPeriod: new Map() });

        server.handleClientMessage(
          profileHistoryWire({ period_ms: 60_000, ranges }),
          client,
        );
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      });

      test("drops a profile_history message carrying unexpected top-level fields", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 1, nowMs);
        const { server, client } = await historyServer({ byPeriod: new Map() });

        server.handleClientMessage(
          JSON.stringify({
            type: "profile_history",
            mode: "continuous",
            request_id: 1,
            period_ms: 60_000,
            bin_size_multiplier: null,
            ranges,
            rogue: true,
          }),
          client,
        );
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      });

      test("pre-warms recent history in bounded chunks, yielding between each one", async () => {
        const storageReader = fakeVolumeProfileStorageReader();
        const gapsAsked = [];
        const cache = {
          ...fakeVolumeProfileCache(),
          coverageGaps: (_instrument, fromMinuteTs, toMinuteTs) => {
            gapsAsked.push({ fromMinuteTs, toMinuteTs });
            return [];
          },
        };
        await startedServer({
          storageReader,
          volumeProfileCache: cache,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
          preWarmMs: 60 * 60 * 1000,
          preWarmChunkMs: 15 * 60 * 1000,
          preWarmPauseMs: 1,
        });
        await settle(120);

        expect(gapsAsked.length).toBeGreaterThan(1);
        for (const asked of gapsAsked) {
          expect(asked.toMinuteTs - asked.fromMinuteTs).toBeLessThanOrEqual(
            15 * 60 * 1000,
          );
        }
        // Walks backwards from now, never past the configured horizon.
        const oldest = Math.min(...gapsAsked.map((a) => a.fromMinuteTs));
        expect(Date.now() - oldest).toBeLessThanOrEqual(
          60 * 60 * 1000 + 60_000,
        );
      });

      test("a single chunk's materialize failure does not permanently stop the rest of the pre-warm sweep", async () => {
        const storageReader = {
          ...fakeVolumeProfileStorageReader(),
          readMinuteRollup: jest.fn((_symbol, _marketKind, { fromTs }) => ({
            rows: [
              {
                minuteTs: fromTs,
                priceBucket: 0,
                volume: 1,
                buyVolume: 1,
                sellVolume: 0,
                tradeCount: 1,
              },
            ],
            available: true,
          })),
        };
        let materializeCalls = 0;
        const cache = {
          ...fakeVolumeProfileCache(),
          coverageGaps: (_instrument, fromMinuteTs, toMinuteTs) => [
            { fromMinuteTs, toMinuteTs },
          ],
          materialize: () => {
            materializeCalls += 1;
            if (materializeCalls === 1)
              throw new Error(
                "simulated boundary violation on the first chunk only",
              );
            return true;
          },
        };
        await startedServer({
          storageReader,
          volumeProfileCache: cache,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
          preWarmMs: 60 * 60 * 1000,
          preWarmChunkMs: 15 * 60 * 1000,
          preWarmPauseMs: 1,
        });
        await settle(120);

        // Four 15-minute chunks cover the one-hour horizon. If the first
        // chunk's failure permanently stopped the sweep, only one call would
        // ever happen.
        expect(materializeCalls).toBeGreaterThan(1);
      });

      test("does no pre-warm work at all when no cache is configured", async () => {
        const storageReader = fakeVolumeProfileStorageReader();
        await startedServer({
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
          preWarmPauseMs: 1,
        });
        await settle(60);
        expect(storageReader.readVolumeProfile).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ tickSize: expect.anything() }),
        );
      });

      test("sends nothing rather than crashing when no cache is configured", async () => {
        const nowMs = Date.now();
        const ranges = alignedRanges(60_000, 2, nowMs);
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await startedServer({
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        });
        const client = fakeClient();
        server.handleClientConnected(client);
        await settle();
        client.sent = [];

        expect(() =>
          server.handleClientMessage(
            profileHistoryWire({ period_ms: 60_000, ranges }),
            client,
          ),
        ).not.toThrow();
        await settle();
        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      });
    });

    test("a fixed_range request over a window with no trades sends nothing, never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader({ tradeRows: [] });
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      expect(() =>
        server.handleClientMessage(
          profileConfigWire({
            mode: "fixed_range",
            range_start_ts: 0,
            range_end_ts: 5_000,
          }),
          client,
        ),
      ).not.toThrow();
      await settle();

      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
    });
  });

  describe("vpin wiring (P4.12 Step 4)", () => {
    test("live query failure withdraws READY, replays to a new client, and recovers with the correct native pair", async () => {
      const storageReader = fakeVpinStorageReader();
      let unavailable = true;
      const successfulPoll = fakeVpinLivePoll([]);
      const livePoll = jest.fn((input) =>
        unavailable
          ? {
              promise: Promise.reject(new Error("test database unavailable")),
              cancel() {},
            }
          : successfulPoll(input),
      );
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
        vpinLivePoll: livePoll,
        vpinPollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      expect(livePoll).toHaveBeenCalled();
      expect(livePoll.mock.calls[0][0]).toMatchObject({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
      });
      expect(server.vpinWarmupStatusFor("BTCUSDT", "SPOT")).toBe("UNAVAILABLE");
      expect(client.sent).toContainEqual(
        expect.objectContaining({
          type: "analytics_status",
          indicator: "VPIN",
          status: "UNAVAILABLE",
        }),
      );
      const joiningClient = fakeClient();
      server.handleClientConnected(joiningClient);
      expect(joiningClient.sent).toContainEqual(
        expect.objectContaining({
          type: "analytics_status",
          indicator: "VPIN",
          status: "UNAVAILABLE",
        }),
      );
      unavailable = false;
      await settle();
      expect(server.vpinWarmupStatusFor("BTCUSDT", "SPOT")).toBe("READY");
      expect(
        client.sent
          .filter(
            (frame) =>
              frame.type === "analytics_status" && frame.indicator === "VPIN",
          )
          .at(-1).status,
      ).toBe("READY");
    });

    test("the VPIN calibration reader gets its own longer remote timeout, not the shared reader's short one", async () => {
      const storageReader = fakeVpinStorageReader();
      storageReader.remote = Object.freeze({
        baseUrl: "https://example.test/live-storage",
        token: "tok",
        timeoutMs: 5_000,
      });
      let capturedRemote = null;
      const vpinWarmup = (input) => {
        capturedRemote = input.remote;
        return fakeVpinWarmup(storageReader.tradeRows)(input);
      };
      await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinWarmup,
      });
      await settle();

      expect(capturedRemote).toEqual({
        baseUrl: "https://example.test/live-storage",
        token: "tok",
        timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS,
      });
      expect(VPIN_WARMUP_REMOTE_TIMEOUT_MS).toBeGreaterThan(5_000);
    });

    // Property: over remote storage the worker is told to backfill from the
    // sliced aggregate at the remote geometry (the exact 7-day trade backfill
    // is 4.25 GB over a 200 KB/s link and can never finish); over a local
    // database it stays exact. Oracle: the worker input the server builds.
    test("a remote storage reader makes the VPIN warm-up sliced at the remote geometry; a local one stays exact", async () => {
      const remoteReader = fakeVpinStorageReader();
      remoteReader.remote = Object.freeze({
        baseUrl: "https://example.test/live-storage",
        token: "tok",
        timeoutMs: 5_000,
      });
      const inputs = [];
      const vpinWarmup = (input) => {
        inputs.push(input);
        return fakeVpinWarmup(remoteReader.tradeRows)(input);
      };
      const remote = await startedServer({
        storageReader: remoteReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinWarmup,
      });
      await settle();
      expect(inputs[0]).toMatchObject({
        backfillMode: "SLICED_APPROXIMATE",
        backfillSliceMs: 2_000,
        backfillChunkMs: 6 * 60 * 60 * 1_000,
      });
      remote.server.stop();

      inputs.length = 0;
      const localReader = fakeVpinStorageReader();
      await startedServer({
        storageReader: localReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinWarmup,
      });
      await settle();
      expect(inputs[0]).toMatchObject({ backfillMode: "EXACT" });
      expect(inputs[0]).not.toHaveProperty("backfillSliceMs");
    });

    // Property: a warm-up that keeps coming back unavailable is relaunched on
    // an escalating schedule, not every 15 s, so a backfill this link cannot
    // carry stops being a permanent background download. Oracle: launch
    // count against the health poll with a stubbed clock.
    test("a warm-up that keeps failing backs off instead of relaunching every 15 s, and logs its reason once", async () => {
      const storageReader = fakeVpinStorageReader();
      let launches = 0;
      const vpinWarmup = () => {
        launches += 1;
        return {
          promise: Promise.resolve({
            available: false,
            reason: "SLICED_UNAVAILABLE",
            slicesRead: 0,
            chunksRead: 0,
          }),
          cancel() {},
        };
      };
      const errors = jest.spyOn(console, "error").mockImplementation(() => {});
      let clock = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
      try {
        const { server } = await startedServer({
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          vpinWarmup,
          healthPollMs: 5,
        });
        await settle();
        expect(launches).toBe(1);
        expect(server.vpinWarmupStatusFor("BTCUSDT", "SPOT")).toBe(
          "UNAVAILABLE",
        );
        clock += 16_000;
        await settle();
        expect(launches).toBe(2);
        clock += 16_000;
        await settle();
        expect(launches).toBe(2);
        clock += 45_000;
        await settle();
        expect(launches).toBe(3);
        clock += 5 * 60_000;
        await settle();
        expect(launches).toBe(3);
        clock += 5 * 60_000 + 1_000;
        await settle();
        expect(launches).toBe(4);
        const reasonLogs = errors.mock.calls.filter((call) =>
          String(call[0]).includes(
            "vpin warm-up for SPOT:BTCUSDT is unavailable",
          ),
        );
        expect(reasonLogs).toHaveLength(1);
        expect(reasonLogs[0][0]).toContain("SLICED_UNAVAILABLE");
        server.stop();
      } finally {
        nowSpy.mockRestore();
        errors.mockRestore();
      }
    });
    // Every value*size here comfortably clears the 1_000 USD minVBucket
    // floor on its own, so each of these three trades individually seals
    // its own bucket during the backfill replay.
    function vpinTradeRows(nowMs = Date.now()) {
      return [
        {
          ts_exchange: nowMs - 3_000,
          trade_id: "vpin-1",
          price: 64270,
          size: 1,
          side: "buy",
        },
        {
          ts_exchange: nowMs - 2_000,
          trade_id: "vpin-2",
          price: 64280,
          size: 2,
          side: "sell",
        },
        {
          ts_exchange: nowMs - 1_000,
          trade_id: "vpin-3",
          price: 64290,
          size: 1,
          side: "buy",
        },
      ];
    }

    // readVolumeProfile is a required-but-unused stub here -- the adapter
    // constructor itself asserts it exists even though ensureVpinWarm
    // never calls it, only ensureVolumeProfileWarm does. readRecentTrades
    // actually honors windowMs/nowMs like a real trailing-window store
    // would -- unlike a fake that answers its fixture unconditionally
    // whenever cursor is null, that distinction matters here: it is what
    // correctly stops the live poll from re-serving the exact rows the
    // backfill already consumed once session.pollCursor resets to null.
    // tradeRows is taken by reference, not copied, so a test can push a
    // fresh trade onto it after warm-up to simulate one arriving live.
    function fakeVpinStorageReader({ tradeRows = vpinTradeRows() } = {}) {
      const readRecentTrades = jest.fn(
        (_symbol, _marketKind, { cursor, windowMs, nowMs }) => {
          if (cursor !== null)
            return { rows: [], nextCursor: cursor, available: true };
          const fromTs = nowMs - windowMs;
          const rows = tradeRows.filter(
            (row) => row.ts_exchange >= fromTs && row.ts_exchange <= nowMs,
          );
          if (rows.length === 0)
            return { rows: [], nextCursor: null, available: true };
          return {
            rows,
            nextCursor: {
              ts: rows[rows.length - 1].ts_exchange,
              id: rows.length,
            },
            available: true,
          };
        },
      );
      const readMinuteRollup = jest.fn(() => ({ rows: [], available: true }));
      const readVolumeProfile = jest.fn(() => ({
        buckets: [],
        available: true,
      }));
      return {
        tradeRows,
        readRecentTrades,
        readMinuteRollup,
        readVolumeProfile,
      };
    }

    function fakeTickSizeResolver(tickSize = 1) {
      return { getBinanceTickSize: jest.fn(async () => tickSize) };
    }

    // Worker execution is tested independently.  This deterministic job
    // preserves the server wiring assertions without doing SQLite work in
    // Jest's main process.
    function fakeVpinWarmup(tradeRows) {
      return ({ nowMs }) => {
        const vpinState = createVpinState({ vBucket: 1_000 });
        const history = [];
        for (const row of tradeRows) {
          const results = ingestVpinTrade(vpinState, {
            ts: row.ts_exchange,
            price: row.price,
            size: row.size,
            side: row.side,
          });
          for (const result of results)
            history.push({ sealTs: result.sealed.sealTs, ...result.reading });
        }
        return {
          promise: Promise.resolve({
            available: true,
            vBucket: 1_000,
            vpinState,
            history,
            pollFromTs: nowMs,
            pollCursor: null,
          }),
          cancel() {},
        };
      };
    }

    function fakeVpinLivePoll(tradeRows) {
      return (input) => {
        expect(["BTCUSDT", "ETHUSDT"]).toContain(input.symbol);
        expect(["SPOT", "PERPETUAL"]).toContain(input.marketKind);
        const vpinState = JSON.parse(JSON.stringify(input.vpinState));
        const rows =
          input.pollCursor === null
            ? tradeRows.filter(
                (row) =>
                  row.ts_exchange >= input.pollFromTs &&
                  row.ts_exchange <= input.nowMs,
              )
            : [];
        const readings = [];
        for (const row of rows) {
          for (const result of ingestVpinTrade(vpinState, {
            ts: row.ts_exchange,
            price: row.price,
            size: row.size,
            side: row.side,
          })) {
            readings.push({ sealTs: result.sealed.sealTs, ...result.reading });
          }
        }
        return {
          promise: Promise.resolve({
            vpinState,
            pollFromTs: input.pollFromTs,
            pollCursor:
              rows.length > 0
                ? { ts: rows.at(-1).ts_exchange, id: rows.length }
                : input.pollCursor,
            readings,
          }),
          cancel() {},
        };
      };
    }

    async function settle(ms = 50) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("an explicit VPIN suspension performs no calibration or live polling", async () => {
      const storageReader = fakeVpinStorageReader();
      const vpinWarmup = jest.fn(fakeVpinWarmup(storageReader.tradeRows));
      const vpinLivePoll = jest.fn(fakeVpinLivePoll(storageReader.tradeRows));
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinEnabled: false,
        vpinPollMs: 10,
        vpinWarmup,
        vpinLivePoll,
      });

      await settle();

      expect(vpinWarmup).not.toHaveBeenCalled();
      expect(vpinLivePoll).not.toHaveBeenCalled();
      expect(server.vpinWarmupStatusFor("BTCUSDT", "SPOT")).toBe("DISABLED");
    });

    test("stop awaits workers even after their results were published", async () => {
      const storageReader = fakeVpinStorageReader();
      const jobs = [];
      const vpinWarmup = (input) => {
        let finish;
        const closed = new Promise((resolve) => {
          finish = resolve;
        });
        const job = {
          ...fakeVpinWarmup(storageReader.tradeRows)(input),
          closed,
          finish,
          cancel: jest.fn(() => closed),
        };
        jobs.push(job);
        return job;
      };
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinWarmup,
      });
      await settle();
      expect(jobs.length).toBeGreaterThan(0);
      const stopping = server.stop();
      expect(server.stop()).toBe(stopping);
      let finished = false;
      stopping.then(() => {
        finished = true;
      });
      await settle();
      expect(finished).toBe(false);
      for (const job of jobs) expect(job.cancel).toHaveBeenCalledTimes(1);
      await expect(server.start()).rejects.toThrow("previous worker shutdown");
      for (const job of jobs) job.finish();
      await stopping;
      expect(finished).toBe(true);
    });

    test("warms up a session for the active pair, backfilling history that reaches a client connecting after warm-up already finished", async () => {
      const storageReader = fakeVpinStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
        vpinLivePoll: fakeVpinLivePoll(storageReader.tradeRows),
      });

      // Warm-up races the server's own connection setup, so it may well
      // finish before any client exists to catch its one-time broadcast --
      // this is exactly the "no discrimination" case: a client connecting
      // late must still see the backfilled history on its own initial
      // snapshot, not just clients lucky enough to already be listening.
      await settle();
      const client = fakeClient();
      server.handleClientConnected(client);

      const [frame] = client.sent.filter(
        (f) =>
          f.type === "snapshot" &&
          Array.isArray(f.vpin_readings) &&
          f.vpin_readings.length > 0,
      );
      expect(frame).toBeDefined();
      expect(frame.vpin_readings.length).toBeGreaterThanOrEqual(3);
      expect(frame.vpin_readings[0]).toEqual(
        expect.objectContaining({
          active: false,
          direction: null,
          strength: 0,
          activated_at_ts: null,
        }),
      );
    });

    test("switching back to a previously warmed pair delivers its vpin history immediately on the switch snapshot, not just on connect", async () => {
      const storageReader = fakeVpinStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();

      // Switching away never clears vpinByPair -- only warmPairs, which
      // just gates polling/re-warming eligibility. BTC's already-backfilled
      // session should still be sitting there when the user switches back.
      server.handleClientMessage(selectWire("ETH-USDT", "SPOT"));
      client.sent = [];
      server.handleClientMessage(selectWire("BTC-USDT", "SPOT"));

      const [frame] = client.sent.filter(
        (f) =>
          f.type === "snapshot" &&
          Array.isArray(f.vpin_readings) &&
          f.vpin_readings.length > 0,
      );
      expect(frame).toBeDefined();
      expect(frame.symbol).toBe("BTC-USDT");
      expect(frame.vpin_readings.length).toBeGreaterThanOrEqual(3);
    });

    test("does not create a vpin session when storageReader lacks readMinuteRollup -- the vpin-specific calibration requirement", async () => {
      const storageReader = fakeVpinStorageReader();
      delete storageReader.readMinuteRollup;
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
      expect(
        client.sent.some(
          (f) => f.type === "snapshot" && Array.isArray(f.vpin_readings),
        ),
      ).toBe(false);
    });

    test("does not broadcast vpin_readings when the backfill window has no trades", async () => {
      const storageReader = fakeVpinStorageReader({ tradeRows: [] });
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(
        client.sent.some(
          (f) => f.type === "snapshot" && Array.isArray(f.vpin_readings),
        ),
      ).toBe(false);
      expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
    });

    test("broadcasts no vpin data at all when no storageReader is configured", async () => {
      const { server } = await startedServer({ vpinPollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      client.sent = [];

      await settle();

      expect(
        client.sent.some(
          (f) => f.type === "snapshot" && Array.isArray(f.vpin_readings),
        ),
      ).toBe(false);
      expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
    });

    test("a live poll publishes every bucket sealed by one oversized active-pair trade", async () => {
      const tradeRows = [];
      const storageReader = fakeVpinStorageReader({ tradeRows });
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
        vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
        vpinLivePoll: fakeVpinLivePoll(storageReader.tradeRows),
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();
      client.sent = [];

      tradeRows.push({
        ts_exchange: Date.now(),
        trade_id: "vpin-live-1",
        price: 100,
        size: 25,
        side: "buy",
      });
      await settle();

      const frames = client.sent.filter((f) => f.type === "vpin");
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual(
        expect.objectContaining({
          type: "vpin",
          provider: "BINANCE",
          symbol: "BTC-USDT",
          marketKind: "SPOT",
        }),
      );
    });

    test("stop() while vpin sessions exist does not throw and stops further vpin broadcasts", async () => {
      const storageReader = fakeVpinStorageReader();
      const { server } = await startedServer({
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        vpinPollMs: 10,
      });
      const client = fakeClient();
      server.handleClientConnected(client);
      await settle();

      expect(() => server.stop()).not.toThrow();

      client.sent = [];
      await settle();

      expect(client.sent.filter((f) => f.type === "vpin")).toEqual([]);
    });
  });
});

describe("aggressive_history lifecycle wiring", () => {
  const flushHistory = async () => {
    for (let i = 0; i < 3; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const historyWire = (requestId) => {
    const now = Date.now();
    return JSON.stringify({
      type: "aggressive_history",
      request_id: requestId,
      from_ts: now - 60_000,
      to_ts: now,
      min_size: 0,
    });
  };

  async function connectedClient(readAggressivePrintsAsync) {
    const { server } = await startedServer({
      storageReader: { readAggressivePrintsAsync },
      aggressivePoolWarmup: false,
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushHistory();
    client.sent = [];
    return { server, client };
  }

  test("a request is answered through the server with the reason field on the wire", async () => {
    const readAggressivePrintsAsync = jest.fn(() =>
      Promise.resolve({ rows: [], available: true }),
    );
    const { server, client } = await connectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    await flushHistory();
    expect(
      client.sent.filter((frame) => frame.type === "aggressive_history"),
    ).toEqual([
      expect.objectContaining({
        symbol: "BTC-USDT",
        provider: "BINANCE",
        request_id: 1,
        complete: true,
        reason: null,
        trades: [],
      }),
    ]);
  });

  test("a client that disconnects with a read in flight and one waiting gets nothing, and the waiting one never starts", async () => {
    let resolveRead;
    const readAggressivePrintsAsync = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { server, client } = await connectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    server.handleClientMessage(historyWire(2), client);
    await flushHistory();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    server.handleClientDisconnected(client);
    resolveRead({ rows: [], available: true });
    await flushHistory();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(
      client.sent.filter((frame) => frame.type === "aggressive_history"),
    ).toEqual([]);
  });

  test("stop() disposes the history handler: a waiting request never starts and nothing is sent afterwards", async () => {
    let resolveRead;
    const readAggressivePrintsAsync = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { server, client } = await connectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    server.handleClientMessage(historyWire(2), client);
    await flushHistory();
    const stopping = server.stop();
    resolveRead({ rows: [], available: true });
    await flushHistory();
    await stopping;
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(
      client.sent.filter((frame) => frame.type === "aggressive_history"),
    ).toEqual([]);
  });
});

describe("delta_profile lifecycle wiring", () => {
  const flushProfile = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const profileWire = (requestId) => {
    const now = Date.now();
    return JSON.stringify({ type: "delta_profile", request_id: requestId, from_ts: now - 60_000, to_ts: now, row_width: 1 });
  };

  async function connectedClient(readVolumeProfileAsync) {
    const { server } = await startedServer({ storageReader: { readVolumeProfileAsync }, aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushProfile();
    client.sent = [];
    return { server, client };
  }

  test("a request is answered through the server with the pair's identity and the rows on the wire", async () => {
    const readVolumeProfileAsync = jest.fn(() => Promise.resolve({ buckets: [{ bucket: 84_610, volume: 3, buyVolume: 2, sellVolume: 1, tradeCount: 2 }], available: true }));
    const { server, client } = await connectedClient(readVolumeProfileAsync);
    server.handleClientMessage(profileWire(1), client);
    await flushProfile();
    expect(readVolumeProfileAsync).toHaveBeenCalledWith("BTCUSDT", "SPOT", expect.objectContaining({ originPrice: 0, rowWidth: 1 }), { signal: expect.any(AbortSignal) });
    expect(client.sent.filter((frame) => frame.type === "delta_profile")).toEqual([
      expect.objectContaining({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", request_id: 1, complete: true, reason: null, pending: 0, rows: [[84_610, 2, 1]] }),
    ]);
  });

  test("a client that disconnects with a read in flight gets nothing; stop() disposes the handler so nothing is sent afterwards", async () => {
    let resolveRead;
    const readVolumeProfileAsync = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { server, client } = await connectedClient(readVolumeProfileAsync);
    server.handleClientMessage(profileWire(1), client);
    await flushProfile();
    server.handleClientDisconnected(client);
    resolveRead({ buckets: [], available: true });
    await flushProfile();
    expect(client.sent.filter((frame) => frame.type === "delta_profile")).toEqual([]);
    const other = fakeClient();
    server.handleClientConnected(other);
    await flushProfile();
    server.handleClientMessage(profileWire(2), other);
    await flushProfile();
    const stopping = server.stop();
    resolveRead({ buckets: [], available: true });
    await flushProfile();
    await stopping;
    expect(readVolumeProfileAsync).toHaveBeenCalledTimes(2);
    expect(other.sent.filter((frame) => frame.type === "delta_profile")).toEqual([]);
  });
});

describe("recording age on the health frame", () => {
  test("a health frame says whether the collector is still writing this pair, and a recording that goes quiet flips it within a poll", async () => {
    // 2026-09-15: the collector died at 05:27 UTC, the feed stayed READY, the chart said LIVE, nobody knew until a query the next afternoon.
    let latestTs = Date.now() - 10_000;
    const readRecordingAge = jest.fn((symbol, marketKind, { nowMs }) => ({
      latestTs,
      ageMs: nowMs - latestTs,
      available: true,
    }));
    const { server } = await startedServer({
      storageReader: { readRecordingAge },
      recordingPollMs: 0,
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    const onConnect = client.sent.find((frame) => frame.type === "health");
    expect(onConnect).toEqual(
      expect.objectContaining({
        recordingStale: false,
        recordingLatestTs: latestTs,
      }),
    );
    expect(readRecordingAge).toHaveBeenCalledWith(
      "BTCUSDT",
      "SPOT",
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(server.recordingStatus()).toEqual(
      expect.objectContaining({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        available: true,
        latestTradeTs: latestTs,
        stale: false,
      }),
    );
    expect(server.recordingStatus().ageMs).toBeGreaterThanOrEqual(10_000);
    // The collector stops: the next health poll carries the flag and the last trade it wrote, with the feed itself untouched.
    latestTs = Date.now() - 7 * 3_600_000;
    client.sent = [];
    await new Promise((resolve) => setTimeout(resolve, 60));
    const flipped = client.sent.filter((frame) => frame.type === "health");
    expect(flipped).toHaveLength(1);
    expect(flipped[0]).toEqual(
      expect.objectContaining({
        recoveryState: onConnect.recoveryState,
        stale: onConnect.stale,
        recordingStale: true,
        recordingLatestTs: latestTs,
      }),
    );
    expect(server.recordingStatus().stale).toBe(true);
    // Nothing changes, nothing is resent.
    client.sent = [];
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.sent.filter((frame) => frame.type === "health")).toHaveLength(
      0,
    );
    await server.stop();
  });

  test("with no recording to read the frame says so, and a reader that throws is a stale recording, never a dead server", async () => {
    const { server } = await startedServer({ recordingPollMs: 0 });
    const client = fakeClient();
    server.handleClientConnected(client);
    const health = client.sent.find((frame) => frame.type === "health");
    expect(health).toEqual(expect.objectContaining({ recordingStale: true }));
    expect(health).not.toHaveProperty("recordingLatestTs");
    expect(server.recordingStatus()).toEqual(
      expect.objectContaining({
        available: false,
        latestTradeTs: null,
        ageMs: null,
        stale: true,
      }),
    );
    await server.stop();
    const throwing = await startedServer({
      storageReader: {
        readRecordingAge: () => {
          throw new Error("locked");
        },
      },
      recordingPollMs: 0,
    });
    expect(throwing.server.recordingStatus()).toEqual(
      expect.objectContaining({ available: false, stale: true }),
    );
    await throwing.server.stop();
  });

  test("an older recording read cannot overwrite a newer result for the same selection", async () => {
    const reads = [];
    const readRecordingAge = jest.fn(
      () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
    );
    const { server } = await startedServer({
      storageReader: { readRecordingAge },
      recordingPollMs: 0,
    });
    expect(reads).toHaveLength(1);

    expect(server.recordingStatus()).toEqual(
      expect.objectContaining({
        symbol: "BTCUSDT",
        available: false,
        latestTradeTs: null,
      }),
    );
    expect(reads).toHaveLength(2);

    reads[1]({ latestTs: 222, available: true });
    await flushAsync();
    reads[0]({ latestTs: 111, available: true });
    await flushAsync();
    expect(server.recordingStatus()).toEqual(
      expect.objectContaining({
        symbol: "BTCUSDT",
        available: true,
        latestTradeTs: 222,
      }),
    );
    await server.stop();
  });
});

describe("aggressive-print pool", () => {
  test("the pool reaches back as far as the heatmap's coarse tier, so the bubbles come back with the same hours the columns do", async () => {
    // 2026-09-15: the heatmap restored eleven hours and the bubbles four; the four sat inside a recording hole, so none came back.
    const reads = [];
    const readAggressivePrintsAsync = jest.fn(
      (symbol, marketKind, { fromMs, toMs, minSize }) => {
        reads.push({ fromMs, toMs, minSize });
        const rows =
          minSize === 0
            ? Array.from({ length: 300 }, (_unused, i) => ({
                id: i + 1,
                ts: toMs - 1_000 - i,
                price: "64000",
                size: String(((i * 7) % 10) + 1),
                side: "buy",
                trade_id: 1_000 + i,
              }))
            : [];
        return Promise.resolve({ rows, available: true });
      },
    );
    const publisherWith = (horizonMs) => ({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
      snapshotFrames: jest.fn(() => []),
      horizonMs,
    });
    const { server } = await startedServer({
      liquidity: publisherWith(11 * 3_600_000),
      storageReader: { readAggressivePrintsAsync },
    });
    for (let i = 0; i < 24; i += 1) await flushAsync();
    expect(reads).toHaveLength(12);
    expect(reads[0].toMs - reads[0].fromMs).toBe(15 * 60_000);
    expect(reads.at(-1).fromMs).toBe(reads[0].toMs - 11 * 3_600_000);
    await server.stop();
    // A tier shorter than the pool's own four hours never shrinks it.
    reads.length = 0;
    const short = await startedServer({
      liquidity: publisherWith(20 * 60_000),
      storageReader: { readAggressivePrintsAsync },
    });
    for (let i = 0; i < 24; i += 1) await flushAsync();
    expect(reads.at(-1).fromMs).toBe(reads[0].toMs - 4 * 3_600_000);
    await short.server.stop();
  });

  test("warms the pair's pool from storage newest first, then hourly at the floor it found, ships it in the snapshot, and keeps feeding it live", async () => {
    const reads = [];
    const readAggressivePrintsAsync = jest.fn(
      (symbol, marketKind, { fromMs, toMs, minSize }) => {
        reads.push({ symbol, marketKind, fromMs, toMs, minSize });
        const rows =
          minSize === 0
            ? Array.from({ length: 300 }, (_unused, i) => ({
                id: i + 1,
                ts: toMs - 1_000 - i,
                price: "64000",
                size: String(((i * 7) % 10) + 1),
                side: "buy",
                trade_id: 1_000 + i,
              }))
            : [
                {
                  id: 5_000 + reads.length,
                  ts: fromMs + 60_000,
                  price: "64000",
                  size: "50",
                  side: "sell",
                  trade_id: 9_000 + reads.length,
                },
              ];
        return Promise.resolve({ rows, available: true });
      },
    );
    const { server, spotSocket } = await startedServer({
      storageReader: { readAggressivePrintsAsync },
    });
    for (let i = 0; i < 12; i += 1) await flushAsync();
    expect(
      reads.map((read) => [read.symbol, read.marketKind, read.minSize > 0]),
    ).toEqual(
      Array.from({ length: 5 }, (_unused, i) => ["BTCUSDT", "SPOT", i > 0]),
    );
    expect(reads[0].toMs - reads[0].fromMs).toBe(15 * 60_000);
    expect(reads[4].fromMs).toBe(reads[0].toMs - 4 * 3_600_000);

    const client = fakeClient();
    server.handleClientConnected(client);
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.aggressive_prints_floor).toBeGreaterThan(0);
    expect(snapshot.aggressive_prints_from).toBeGreaterThanOrEqual(
      reads[4].fromMs,
    );
    expect(snapshot.aggressive_prints_from).toBeLessThan(
      reads[4].fromMs + 5_000,
    );
    expect(snapshot.aggressive_prints.length).toBeGreaterThan(4);
    expect(
      snapshot.aggressive_prints.every(
        (print) =>
          print.size >= snapshot.aggressive_prints_floor &&
          print.marketKind === "SPOT",
      ),
    ).toBe(true);
    expect(
      snapshot.aggressive_prints.filter((print) => print.size === 50),
    ).toHaveLength(4);

    const liveTs = Date.now();
    spotSocket.simulateMessage(
      JSON.stringify({
        stream: "btcusdt@trade",
        data: {
          e: "trade",
          E: liveTs,
          s: "BTCUSDT",
          t: 777,
          p: "64275.99",
          q: "100",
          T: liveTs,
          m: false,
          M: true,
        },
      }),
    );
    await flushAsync();
    const later = fakeClient();
    server.handleClientConnected(later);
    const next = later.sent.find((frame) => frame.type === "snapshot");
    expect(
      next.aggressive_prints.some(
        (print) => print.trade_id === "777" && print.size === 100,
      ),
    ).toBe(true);
    await server.stop();
  });

  test("a snapshot carries no pool fields until storage has answered or a print has landed", async () => {
    const { server } = await startedServer({ aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(Object.hasOwn(snapshot, "aggressive_prints")).toBe(false);
    await server.stop();
  });

  test("a chunk whose rows exceed the read limit is paginated via hasMore/nextCursor, not silently truncated to one page", async () => {
    const reads = [];
    const readAggressivePrintsAsync = jest.fn(
      (symbol, marketKind, { fromMs, toMs, minSize, cursor }) => {
        reads.push({ fromMs, toMs, minSize, cursor });
        const isCalibrationSpan = toMs - fromMs === 15 * 60_000;
        if (!isCalibrationSpan)
          return Promise.resolve({ rows: [], available: true });
        if (cursor === null) {
          return Promise.resolve({
            rows: [
              {
                id: 1,
                ts: toMs - 5_000,
                price: "64000",
                size: "3",
                side: "buy",
                trade_id: "cal-page-1",
              },
            ],
            available: true,
            hasMore: true,
            nextCursor: { ts: toMs - 5_000, id: "cal-page-1" },
          });
        }
        return Promise.resolve({
          rows: [
            {
              id: 2,
              ts: toMs - 1_000,
              price: "64000",
              size: "3",
              side: "buy",
              trade_id: "cal-page-2",
            },
          ],
          available: true,
          hasMore: false,
          nextCursor: null,
        });
      },
    );
    const { server } = await startedServer({
      storageReader: { readAggressivePrintsAsync },
    });
    for (let i = 0; i < 12; i += 1) await flushAsync();

    const calibrationReads = reads.filter(
      (read) => read.toMs - read.fromMs === 15 * 60_000,
    );
    expect(calibrationReads).toHaveLength(2);
    expect(calibrationReads[0].cursor).toBeNull();
    expect(calibrationReads[1].fromMs).toBe(calibrationReads[0].fromMs);
    expect(calibrationReads[1].toMs).toBe(calibrationReads[0].toMs);
    expect(calibrationReads[1].cursor).toEqual({
      ts: calibrationReads[0].toMs - 5_000,
      id: "cal-page-1",
    });
    await server.stop();
  });
});

describe("band_history lifecycle wiring", () => {
  const flushHistory = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const bandWire = (requestId) => {
    const now = Date.now();
    return JSON.stringify({ type: "band_history", request_id: requestId, from_ts: now - 60_000, to_ts: now, price_lo: 64_000, price_hi: 64_040, column_ms: 10_000 });
  };

  async function connectedClient(readBandHistory) {
    const { server } = await startedServer({ storageReader: { readBandHistory }, aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushHistory();
    client.sent = [];
    return { server, client };
  }

  test("a request is answered through the server: before the pair has a live book grid the reason is GEOMETRY_UNAVAILABLE on the wire, and the host is not asked", async () => {
    const readBandHistory = jest.fn(() => Promise.resolve({ available: true, columns: [], reason: null }));
    const { server, client } = await connectedClient(readBandHistory);
    server.handleClientMessage(bandWire(1), client);
    await flushHistory();
    expect(client.sent.filter((frame) => frame.type === "band_history")).toEqual([
      expect.objectContaining({ symbol: "BTC-USDT", provider: "BINANCE", request_id: 1, complete: false, reason: "GEOMETRY_UNAVAILABLE", columns: [] }),
    ]);
    expect(readBandHistory).not.toHaveBeenCalled();
  });

  test("stop() disposes the band handler: nothing is sent afterwards", async () => {
    const readBandHistory = jest.fn(() => Promise.resolve({ available: true, columns: [], reason: null }));
    const { server, client } = await connectedClient(readBandHistory);
    await server.stop();
    server.handleClientMessage(bandWire(1), client);
    await flushHistory();
    expect(client.sent.filter((frame) => frame.type === "band_history")).toEqual([]);
  });
});

describe("server/market-data-server -- Iceberg Detector channel", () => {
  const { createIcebergIndicator } = require("../../src/indicators/iceberg/iceberg-indicator");
  const FIXED_CUTS = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3 });
  const fixedCuts = () => ({ current: () => FIXED_CUTS, observeTouch() {}, observeEpisode() {} });
  const testIndicator = (options) => createIcebergIndicator({ ...options, histories: false, cutsFactory: fixedCuts });
  const icebergPages = (client) => client.sent.filter((frame) => frame.type === "iceberg_orders");

  test("a client that declares iceberg_orders gets a reset page, a defended ask level reaches it as a probable iceberg, and a pair switch resends the page", async () => {
    const { server, spotSocket } = await startedServer({ icebergIndicatorFactory: testIndicator });
    const client = fakeClient();
    server.handleClientConnected(client);
    await flushAsync();
    expect(icebergPages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", iceberg_orders: true }), client);
    await flushAsync();
    expect(icebergPages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, icebergs: [], provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" })]);

    const t0 = Date.now();
    let updateId = 101;
    spotSocket.simulateMessage(depthWire({ U: updateId, u: updateId, a: [["64275.99", "1"]] }));
    for (let i = 0; i < 8; i += 1) {
      spotSocket.simulateMessage(tradeWire(500 + i, { price: "64275.99", quantity: "0.3", eventTimeMs: t0 + i * 1000 }));
      updateId += 1;
      spotSocket.simulateMessage(depthWire({ U: updateId, u: updateId, a: [["64275.99", "1"]] }));
    }
    await flushAsync();
    const increments = icebergPages(client).filter((frame) => !frame.reset);
    expect(increments.length).toBeGreaterThan(0);
    expect(increments.at(-1).icebergs[0]).toMatchObject({ kind: "probable", confidence: "probable", origin: "runtime", status: "active", side: "ask", price: 64275.99, display: 1, tranches: 1 });
    expect(increments.at(-1).icebergs[0].executed).toBeCloseTo(2.4, 6);
    expect(increments.at(-1).symbol).toBe("BTC-USDT");

    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: true, symbol: "ETH-USDT", marketKind: "SPOT", icebergs: [] });
    await server.stop();
  });

  test("a client that never declares the flag is not sent iceberg pages, and dropping the flag stops them", async () => {
    const { server } = await startedServer({ icebergIndicatorFactory: testIndicator });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_ladder: true }), client);
    await flushAsync();
    expect(icebergPages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", iceberg_orders: true }), client);
    await flushAsync();
    expect(icebergPages(client)).toHaveLength(1);
    server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(icebergPages(client)).toHaveLength(1);
    await server.stop();
  });

  const capabilities = JSON.stringify({ type: "capabilities", iceberg_orders: true });

  function defendAskLevel(spotSocket) {
    const t0 = Date.now();
    let updateId = 101;
    spotSocket.simulateMessage(depthWire({ U: updateId, u: updateId, a: [["64275.99", "1"]] }));
    for (let i = 0; i < 8; i += 1) {
      spotSocket.simulateMessage(tradeWire(500 + i, { price: "64275.99", quantity: "0.3", eventTimeMs: t0 + i * 1000 }));
      updateId += 1;
      spotSocket.simulateMessage(depthWire({ U: updateId, u: updateId, a: [["64275.99", "1"]] }));
    }
  }

  test("a depth sequence gap takes the book out of sync: the pair's marked iceberg ends at once, and trades during the gap reach no tracker", async () => {
    const { server, spotSocket } = await startedServer({ icebergIndicatorFactory: testIndicator });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(capabilities, client);
    await flushAsync();
    defendAskLevel(spotSocket);
    await flushAsync();
    const marked = icebergPages(client).filter((frame) => !frame.reset).at(-1).icebergs[0];
    expect(marked).toMatchObject({ kind: "probable", status: "active", side: "ask", price: 64275.99 });
    const beforeGap = icebergPages(client).length;
    spotSocket.simulateMessage(depthWire({ U: 200, u: 200, a: [["64275.99", "1"]] }));
    await flushAsync();
    const afterGap = icebergPages(client).slice(beforeGap);
    expect(afterGap).toEqual([expect.objectContaining({ reset: false, icebergs: [expect.objectContaining({ id: marked.id, status: "ended" })] })]);
    const t1 = Date.now();
    for (let i = 0; i < 8; i += 1) {
      spotSocket.simulateMessage(tradeWire(700 + i, { price: "64275.99", quantity: "0.3", eventTimeMs: t1 + i * 1000 }));
      spotSocket.simulateMessage(depthWire({ U: 201 + i, u: 201 + i, a: [["64275.99", "1"]] }));
    }
    await flushAsync();
    expect(icebergPages(client).slice(beforeGap + afterGap.length)).toEqual([]);
    await server.stop();
  });

  test("a released client is forgotten by the iceberg channel: later increments reach only the clients still connected", async () => {
    const { server, spotSocket } = await startedServer({ icebergIndicatorFactory: testIndicator });
    const leaving = fakeClient();
    const staying = fakeClient();
    for (const client of [leaving, staying]) {
      server.handleClientConnected(client);
      server.handleClientMessage(capabilities, client);
    }
    await flushAsync();
    expect(icebergPages(leaving)).toHaveLength(1);

    server.handleClientDisconnected(leaving);
    defendAskLevel(spotSocket);
    await flushAsync();
    expect(icebergPages(staying).filter((frame) => !frame.reset).length).toBeGreaterThan(0);
    expect(icebergPages(leaving)).toHaveLength(1);
    await server.stop();
  });

  test("stop() stops the indicator once, its tick timer and the channel: no tick runs after it and a late host-fill publish reaches nobody", async () => {
    const calls = { tick: 0, stop: 0 };
    let publish = null;
    const icebergIndicatorFactory = (options) => {
      publish = options.publish;
      const indicator = testIndicator(options);
      return {
        ...indicator,
        tick: (at) => {
          calls.tick += 1;
          return indicator.tick(at);
        },
        stop: () => {
          calls.stop += 1;
          return indicator.stop();
        },
      };
    };
    const { server } = await startedServer({ icebergIndicatorFactory });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(capabilities, client);
    await flushAsync();
    expect(icebergPages(client)).toHaveLength(1);
    for (let i = 0; i < 100 && calls.tick === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.tick).toBeGreaterThan(0);

    await server.stop();
    const ticksAtStop = calls.tick;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(calls.tick).toBe(ticksAtStop);
    expect(calls.stop).toBe(1);
    const at = Date.now();
    publish(
      [{ id: "late", kind: "probable", confidence: "probable", side: "ask", price: 64275.99, display: 1, tranches: 2, executed: 2, startedAt: at - 2_000, markedAt: at - 1_000, updatedAt: at, status: "ended", origin: "host" }],
      { marketKind: "SPOT", symbol: "BTCUSDT" },
      at,
      [],
      at - 60_000,
    );
    expect(icebergPages(client)).toHaveLength(1);
  });

  test("the live reach on every iceberg page is the heatmap's own horizon", async () => {
    const liquidity = { start: jest.fn(), stop: jest.fn(), reset: jest.fn(), snapshotFrames: jest.fn(() => []), horizonMs: 20 * 60_000 };
    const { server } = await startedServer({ liquidity, icebergIndicatorFactory: testIndicator });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(capabilities, client);
    await flushAsync();
    const [page] = icebergPages(client);
    expect(page.ts - page.liveSince).toBe(liquidity.horizonMs);
    await server.stop();
  });
});

describe("iceberg store", () => {
  const { createIcebergHistory } = require("../../src/indicators/iceberg/iceberg-history");
  const { saveIcebergHistory } = require("../../src/indicators/iceberg/iceberg-store");

  test("a server this suite builds reads its iceberg store from the suite's temp dir, never from the runtime's data root", async () => {
    const at = Date.now();
    const history = createIcebergHistory({ maxAgeMs: 7 * 86_400_000 });
    history.record({
      id: "BTCUSDT|seeded", kind: "probable", confidence: "probable", side: "ask", price: 64275.99, display: 1, tranches: 3, executed: 2.4,
      startedAt: at - 120_000, markedAt: at - 110_000, updatedAt: at - 60_000, status: "ended", origin: "runtime",
    });
    expect(saveIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey: "SPOT:BTCUSDT", savedAt: at - 60_000, history: history.toJSON(), cuts: null, coverage: [] }).ok).toBe(true);
    const { server } = await startedServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", iceberg_orders: true }), client);
    await flushAsync();
    expect(client.sent.filter((frame) => frame.type === "iceberg_orders")).toEqual([
      expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ id: "BTCUSDT|seeded", status: "ended" })] }),
    ]);
    await server.stop();
  });
});

describe("server/market-data-server -- Exhaustion channel", () => {
  const exhaustionPages = (client) => client.sent.filter((frame) => frame.type === "exhaustion_shades");
  function fakeExhaustion() {
    const calls = { start: 0, stop: 0, snapshots: [], requests: [], options: null };
    const factory = (options) => {
      calls.options = options;
      return {
        start: () => { calls.start += 1; },
        stop: () => { calls.stop += 1; },
        tick: () => [],
        snapshot: (pair, at) => { calls.snapshots.push(pair); return { ts: at, shades: [], liveSince: at - 1000 }; },
        requestHistory: (pair, fromTs) => { calls.requests.push([pair, fromTs]); return true; },
        stats: () => ({}),
        provider: "BINANCE",
      };
    };
    return { factory, calls };
  }

  test("a client that declares exhaustion_shades gets a reset page for the active pair, a pair switch resends it, and the indicator is started and stopped with the server", async () => {
    const { factory, calls } = fakeExhaustion();
    const { server } = await startedServer({ exhaustionIndicatorFactory: factory });
    expect(calls.start).toBe(1);
    expect(typeof calls.options.columnsAfter).toBe("function");
    expect(typeof calls.options.geometryOf).toBe("function");
    expect(typeof calls.options.publish).toBe("function");
    expect(typeof calls.options.hostColumns).toBe("function");
    expect(calls.options.activePair()).toEqual({ marketKind: "SPOT", symbol: "BTCUSDT" });
    expect(typeof calls.options.reselect).toBe("function");
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "exhaustion_history", from_ts: 1_700_000_000_000 }), client);
    expect(calls.requests).toEqual([[{ marketKind: "SPOT", symbol: "BTCUSDT" }, 1_700_000_000_000]]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), client);
    await flushAsync();
    expect(exhaustionPages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, shades: [], provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" })]);
    expect(calls.snapshots).toEqual([{ marketKind: "SPOT", symbol: "BTCUSDT" }]);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(exhaustionPages(client).at(-1)).toMatchObject({ reset: true, symbol: "ETH-USDT" });
    await server.stop();
    expect(calls.stop).toBe(1);
  });

  test("a client that never declares the flag is not sent exhaustion pages, and dropping the flag stops them", async () => {
    const { factory } = fakeExhaustion();
    const { server } = await startedServer({ exhaustionIndicatorFactory: factory });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_ladder: true }), client);
    await flushAsync();
    expect(exhaustionPages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), client);
    await flushAsync();
    expect(exhaustionPages(client)).toHaveLength(1);
    server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(exhaustionPages(client)).toHaveLength(1);
    await server.stop();
  });

  test("with no tracked pairs the tick still feeds the active pair to the engine and the candle monitor, first, and follows a switch", async () => {
    const ticks = { engine: [], monitor: [] };
    const { factory } = fakeExhaustion();
    const exhaustionIndicatorFactory = (options) => ({ ...factory(options), tick: (pairs) => { ticks.engine.push(pairs); return []; } });
    const candleMonitorFactory = () => ({ tick: (pairs) => { ticks.monitor.push(pairs); }, snapshot: () => [], stats: () => ({}), stop: () => {} });
    const { server } = await startedServer({ exhaustionIndicatorFactory, candleMonitorFactory });
    for (let i = 0; i < 100 && ticks.monitor.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks.engine.at(-1)).toEqual([{ marketKind: "SPOT", symbol: "BTCUSDT" }]);
    expect(ticks.monitor.at(-1)).toEqual([{ marketKind: "SPOT", symbol: "BTCUSDT" }]);
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    const seen = ticks.monitor.length;
    for (let i = 0; i < 100 && ticks.monitor.length === seen; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks.engine.at(-1)[0]).toEqual({ marketKind: "SPOT", symbol: "ETHUSDT" });
    expect(ticks.monitor.at(-1)[0]).toEqual({ marketKind: "SPOT", symbol: "ETHUSDT" });
    await server.stop();
  });

  test("with tracked pairs the active pair is ticked first and only once", async () => {
    const ticks = [];
    const candleMonitorFactory = () => ({ tick: (pairs) => { ticks.push(pairs); }, snapshot: () => [], stats: () => ({}), stop: () => {} });
    process.env.L2_HEATMAP_TRACK_ALL = "1";
    let server;
    try {
      ({ server } = await startedServer({ exhaustionIndicatorFactory: fakeExhaustion().factory, candleMonitorFactory }));
    } finally {
      process.env.L2_HEATMAP_TRACK_ALL = "0";
    }
    for (let i = 0; i < 100 && ticks.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const pairs = ticks.at(-1);
    expect(pairs[0]).toEqual({ marketKind: "SPOT", symbol: "BTCUSDT" });
    expect(pairs.filter((pair) => pair.symbol === "BTCUSDT" && pair.marketKind === "SPOT")).toHaveLength(1);
    expect(pairs.length).toBeGreaterThan(1);
    expect(new Set(pairs.map((pair) => `${pair.marketKind}:${pair.symbol}`)).size).toBe(pairs.length);
    await server.stop();
  });

  test("a malformed exhaustion_history ask is dropped with a warning, like the other client messages: extra fields, a string, a negative or a huge from_ts never reach the indicator", async () => {
    const { factory, calls } = fakeExhaustion();
    const { server } = await startedServer({ exhaustionIndicatorFactory: factory });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient();
    server.handleClientConnected(client);
    for (const bad of [{ type: "exhaustion_history" }, { type: "exhaustion_history", from_ts: "1700000000000" }, { type: "exhaustion_history", from_ts: -1 }, { type: "exhaustion_history", from_ts: 1.5 }, { type: "exhaustion_history", from_ts: 1_700_000_000_000, extra: 1 }, { type: "exhaustion_history", from_ts: Number.MAX_SAFE_INTEGER }]) {
      server.handleClientMessage(JSON.stringify(bad), client);
    }
    expect(calls.requests).toEqual([]);
    expect(warn.mock.calls.filter((call) => /dropped exhaustion_history request with unexpected fields/.test(call[0]))).toHaveLength(6);
    server.handleClientMessage(JSON.stringify({ type: "exhaustion_history", from_ts: 0 }), client);
    expect(calls.requests).toEqual([[{ marketKind: "SPOT", symbol: "BTCUSDT" }, 0]]);
    warn.mockRestore();
    await server.stop();
  });

  test("the candle monitor's frames reach the clients that declared the flag and nobody else, and the monitor is stopped with the server", async () => {
    let publish = null;
    const stops = [];
    const candleMonitorFactory = (options) => { publish = options.publish; return { tick: () => {}, snapshot: () => [], stats: () => ({}), stop: () => { stops.push(1); } }; };
    const { server } = await startedServer({ exhaustionIndicatorFactory: fakeExhaustion().factory, candleMonitorFactory });
    expect(typeof publish).toBe("function");
    const subscribed = fakeClient();
    const silent = fakeClient();
    server.handleClientConnected(subscribed);
    server.handleClientConnected(silent);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), subscribed);
    await flushAsync();
    const entry = { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 31_190, size: 1.21 }, biggestSell: null };
    publish([entry], { marketKind: "SPOT", symbol: "BTCUSDT" }, 1_700_000_300_000);
    const frames = (client) => client.sent.filter((frame) => frame.type === "candle_monitor");
    expect(frames(subscribed)).toEqual([{ type: "candle_monitor", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", ts: 1_700_000_300_000, entries: [entry] }]);
    expect(frames(silent)).toEqual([]);
    publish([entry], { marketKind: "SPOT", symbol: "ETHUSDT" }, 1_700_000_301_000);
    expect(frames(subscribed)).toHaveLength(1);
    await server.stop();
    expect(stops).toEqual([1]);
    publish([entry], { marketKind: "SPOT", symbol: "BTCUSDT" }, 1_700_000_302_000);
    expect(frames(subscribed)).toHaveLength(1);
  });
});

describe("server/market-data-server -- Initiative Continuation channel", () => {
  const initiativePages = (client) => client.sent.filter((frame) => frame.type === "initiative_bands");
  function fakeInitiative() {
    const calls = { start: 0, stop: 0, snapshots: [], requests: [], options: null, ticks: [] };
    const factory = (options) => {
      calls.options = options;
      return {
        start: () => { calls.start += 1; },
        stop: () => { calls.stop += 1; },
        tick: (pairs) => { calls.ticks.push(pairs); return []; },
        snapshot: (pair, at) => { calls.snapshots.push(pair); return { ts: at, bands: [], liveSince: at - 1000 }; },
        requestHistory: (pair, fromTs) => { calls.requests.push([pair, fromTs]); return true; },
        stats: () => ({}),
        provider: "BINANCE",
      };
    };
    return { factory, calls };
  }

  test("a client that declares initiative_bands gets a reset page for the active pair, a pair switch resends it, the tick feeds the active pair first, and the indicator is started and stopped with the server", async () => {
    const { factory, calls } = fakeInitiative();
    const { server } = await startedServer({ initiativeIndicatorFactory: factory });
    expect(calls.start).toBe(1);
    expect(typeof calls.options.columnsAfter).toBe("function");
    expect(typeof calls.options.geometryOf).toBe("function");
    expect(typeof calls.options.publish).toBe("function");
    expect(typeof calls.options.hostColumns).toBe("function");
    expect(calls.options.activePair()).toEqual({ marketKind: "SPOT", symbol: "BTCUSDT" });
    expect(typeof calls.options.reselect).toBe("function");
    expect(calls.options.provider).toBe("BINANCE");
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "initiative_history", from_ts: 1_700_000_000_000 }), client);
    expect(calls.requests).toEqual([[{ marketKind: "SPOT", symbol: "BTCUSDT" }, 1_700_000_000_000]]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", initiative_bands: true }), client);
    await flushAsync();
    expect(initiativePages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, bands: [], provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" })]);
    expect(calls.snapshots).toEqual([{ marketKind: "SPOT", symbol: "BTCUSDT" }]);
    for (let i = 0; i < 100 && calls.ticks.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.ticks.at(-1)).toEqual([{ marketKind: "SPOT", symbol: "BTCUSDT" }]);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(initiativePages(client).at(-1)).toMatchObject({ reset: true, symbol: "ETH-USDT" });
    const seen = calls.ticks.length;
    for (let i = 0; i < 100 && calls.ticks.length === seen; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.ticks.at(-1)[0]).toEqual({ marketKind: "SPOT", symbol: "ETHUSDT" });
    await server.stop();
    expect(calls.stop).toBe(1);
  });

  test("a client that never declares the flag is not sent initiative pages, and dropping the flag stops them; the exhaustion flag alone does not open this channel", async () => {
    const { factory } = fakeInitiative();
    const { server } = await startedServer({ initiativeIndicatorFactory: factory });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), client);
    await flushAsync();
    expect(initiativePages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", initiative_bands: true }), client);
    await flushAsync();
    expect(initiativePages(client)).toHaveLength(1);
    server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
    server.handleClientMessage(selectWire("ETH-USDT", "SPOT"), client);
    await flushAsync();
    expect(initiativePages(client)).toHaveLength(1);
    await server.stop();
  });

  test("a malformed initiative_history ask is dropped with a warning: extra fields, a string, a negative or a huge from_ts never reach the indicator; an exhaustion_history ask is not an initiative one", async () => {
    const { factory, calls } = fakeInitiative();
    const { server } = await startedServer({ initiativeIndicatorFactory: factory });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient();
    server.handleClientConnected(client);
    for (const bad of [{ type: "initiative_history" }, { type: "initiative_history", from_ts: "1700000000000" }, { type: "initiative_history", from_ts: -1 }, { type: "initiative_history", from_ts: 1.5 }, { type: "initiative_history", from_ts: 1_700_000_000_000, extra: 1 }, { type: "initiative_history", from_ts: Number.MAX_SAFE_INTEGER }]) {
      server.handleClientMessage(JSON.stringify(bad), client);
    }
    server.handleClientMessage(JSON.stringify({ type: "exhaustion_history", from_ts: 5 }), client);
    expect(calls.requests).toEqual([]);
    expect(warn.mock.calls.filter((call) => /dropped initiative_history request with unexpected fields/.test(call[0]))).toHaveLength(6);
    server.handleClientMessage(JSON.stringify({ type: "initiative_history", from_ts: 0 }), client);
    expect(calls.requests).toEqual([[{ marketKind: "SPOT", symbol: "BTCUSDT" }, 0]]);
    warn.mockRestore();
    await server.stop();
  });
});
