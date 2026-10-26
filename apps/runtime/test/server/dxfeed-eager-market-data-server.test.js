const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const { createVpinState, ingestVpinTrade } = require("../../src/indicators/vpin/vpin-engine");
const { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../../src/indicators/large-trade/large-trade-detection");
const {
  createDxFeedEagerMarketDataServer: createDxFeedEagerMarketDataServerImpl,
  PLANNED_TOKEN_ROTATION_REASON,
  SESSION_ENDED_REASON,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
} = require("../../src/server/dxfeed-eager-market-data-server");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../helpers/temp-files");
const { createIcebergIndicator, icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
const { createIcebergHistory } = require("../../src/indicators/iceberg/iceberg-history");
const { saveIcebergHistory, dropIcebergHistory } = require("../../src/indicators/iceberg/iceberg-store");

// Every server here keeps its iceberg store in this temp dir, never in the runtime's data root.
const ICEBERG_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eager-server-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));

test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

const activeServers = new Set();

// L1L2-V2-106. Same gap as the Binance relay, one step worse here: this suite
// never supplied a volumeProfileCache at all, so P7-04's new cache+worker path
// -- and its three cancel triggers -- never executed. This is the server
// `npm run dev:dxfeed:live` actually runs.
const mockHistoryJobCancel = jest.fn();
const mockStartHistoryJob = jest.fn(() => ({
  promise: new Promise(() => {}),
  cancel: mockHistoryJobCancel,
}));
jest.mock("../../src/indicators/volume-profile/volume-profile-history-job", () => ({
  startVolumeProfileHistoryJob: (...args) => mockStartHistoryJob(...args),
}));

function createDxFeedEagerMarketDataServer(options) {
  const server = createDxFeedEagerMarketDataServerImpl(options);
  activeServers.add(server);
  return server;
}

afterEach(() => {
  for (const server of activeServers) server.stop();
  activeServers.clear();
});

const NQ = { assetClass: "FUTURE", symbol: "/NQZ26:XCME", orderSource: "GLBX" };
const ES = { assetClass: "FUTURE", symbol: "/ESZ26:XCME", orderSource: "GLBX" };
const AAPL = { assetClass: "EQUITY", symbol: "AAPL", orderSource: "NTV" };
const TSLA = { assetClass: "EQUITY", symbol: "TSLA", orderSource: "NTV" };
const TEST_INSTRUMENTS = [NQ, ES, AAPL, TSLA];

let nextFakeChannelId = 1;

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    id: nextFakeChannelId++,
    sent,
    getState: jest.fn(() => state),
    send: jest.fn((payload) => sent.push(payload)),
    addMessageListener: jest.fn((listener) => listeners.message.push(listener)),
    removeMessageListener: jest.fn((listener) => {
      listeners.message = listeners.message.filter((entry) => entry !== listener);
    }),
    addErrorListener: jest.fn((listener) => listeners.error.push(listener)),
    removeErrorListener: jest.fn((listener) => {
      listeners.error = listeners.error.filter((entry) => entry !== listener);
    }),
    addStateChangeListener: jest.fn((listener) => listeners.state.push(listener)),
    removeStateChangeListener: jest.fn((listener) => {
      listeners.state = listeners.state.filter((entry) => entry !== listener);
    }),
    close: jest.fn(),
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection() {
  const listeners = { error: [], connection: [], auth: [] };
  let connectionState = DXLinkConnectionState.CONNECTING;
  let authState = DXLinkAuthState.UNAUTHORIZED;
  const channels = [];
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    channels,
    getStatus: jest.fn(() => ({ connectionState, authState })),
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn((_type, options) => {
      const channel = fakeChannel();
      channel.contract = options?.contract;
      channels.push(channel);
      return channel;
    }),
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    emitConnection: (state, prev) => {
      connectionState = state;
      [...listeners.connection].forEach((listener) => listener({ state, prev }));
    },
    emitAuth: (state, prev) => {
      authState = state;
      [...listeners.auth].forEach((listener) => listener({ state, prev }));
    },
  };
}

function fakeClient() {
  const sent = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send: jest.fn((payload) => sent.push(JSON.parse(payload))),
    close: jest.fn(),
  };
}

function fakeStorageReader({ tradeRowsBySymbol = {}, candleRowsBySymbol = {}, candlesCoverFullWindow = true, markerRowsBySymbol = {} } = {}) {
  return {
    readRecent: jest.fn((symbol) => ({ rows: tradeRowsBySymbol[symbol] ?? [], available: true })),
    readRecentCandles: jest.fn((symbol) => ({
      rows: candleRowsBySymbol[symbol] ?? [],
      available: true,
      startsAtRequestedWindow: candlesCoverFullWindow,
    })),
    readLargeTrades: jest.fn((symbol) => ({
      rows: (markerRowsBySymbol[symbol] ?? []).map((row) => ({ row, baselineSnapshot: null })),
      available: true,
    })),
  };
}

const NOW_MS = 1_800_025_200_000;
const VALID_EXPIRES_AT = new Date(NOW_MS + 30 * 60_000).toISOString();

function baseOptions(overrides = {}) {
  return {
    brokerUrl: "https://broker.example.ts.net",
    requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT })),
    now: () => NOW_MS,
    sessionRetryBaseMs: 30_000,
    storageReader: fakeStorageReader(),
    instruments: TEST_INSTRUMENTS,
    liquidityOptions: { storeEnabled: false, backfillEnabled: false },
    ...overrides,
  };
}

async function waitUntilChannelCount(connection, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (connection.channels.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntilChannelCount: never reached ${count} channels`);
}

async function waitUntilConnectionCount(connections, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (connections.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntilConnectionCount: never reached ${count} connections`);
}

// A channel opens asynchronously (sequential await inside the production
// loop), so drive it open: auth, then wait-for-exist + OPENED for each
// channel as it's created. All 4 instruments now share one STREAM channel
// (TimeAndSale + Order merged, DX3.05/Phase C's collapse), so the default
// of 1 covers every caller -- no test passes a different count.
async function driveToChannelsOpened(connection, expectedChannelCount = 1) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  for (let index = 0; index < expectedChannelCount; index += 1) {
    await waitUntilChannelCount(connection, index + 1);
    await Promise.resolve();
    await Promise.resolve();
    connection.channels[index].emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    await Promise.resolve();
  }
}

function mainChannel(connection) {
  return connection.channels[0];
}

function selectMessage(symbol, assetClass) {
  return JSON.stringify({ type: "select", symbol, assetClass });
}

function tokenBrokerFailure({ retryable }) {
  const error = new Error("token broker failure");
  error.name = "DxFeedTokenBrokerError";
  error.retryable = retryable;
  return error;
}

const NQ_TIMEANDSALE_ITEM = {
  eventType: "TimeAndSale", eventSymbol: "/NQZ26:XCME", eventTime: 0, eventFlags: 0,
  index: 7678176778774447000, time: NOW_MS, timeNanoPart: 0, sequence: 66860,
  exchangeCode: "G", price: 29219, size: 1, bidPrice: 29219, askPrice: 29220,
  tradeThroughExempt: "", aggressorSide: "SELL", spreadLeg: false,
  extendedTradingHours: false, validTick: true, type: "NEW",
};

const ES_TIMEANDSALE_ITEM = {
  ...NQ_TIMEANDSALE_ITEM, eventSymbol: "/ESZ26:XCME", price: 5800, aggressorSide: "BUY",
};

// Ordinary bar tests use an exchange-valid print. A dedicated regression test
// below proves that invalid equity prints remain on tape without polluting OHLC.
const AAPL_TIMEANDSALE_ITEM = {
  eventType: "TimeAndSale", eventSymbol: "AAPL", eventTime: 0, eventFlags: 0,
  index: 7679136203203489000, time: NOW_MS, timeNanoPart: 0, sequence: 601002,
  exchangeCode: "Q", price: 230.5, size: 10, bidPrice: 230.4, askPrice: 230.6,
  exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY", spreadLeg: false,
  extendedTradingHours: true, validTick: true, type: "NEW",
};

const TSLA_TIMEANDSALE_ITEM = {
  ...AAPL_TIMEANDSALE_ITEM, eventSymbol: "TSLA", price: 410.25, aggressorSide: "SELL", sequence: 701002,
};

async function bootServer(overrides = {}) {
  const connection = fakeConnection();
  const server = createDxFeedEagerMarketDataServer(baseOptions({ ...overrides, createConnection: () => connection }));
  server.start();
  await driveToChannelsOpened(connection);
  await Promise.resolve();
  return { connection, server };
}

describe("createDxFeedEagerMarketDataServer -- boot and subscription shape", () => {
  test("start() connects once and subscribes all 4 instruments' TimeAndSale plus every instrument's Order on one shared STREAM channel -- equities now use the same delivery contract as futures (this migration's channel collapse)", async () => {
    const { connection, server } = await bootServer();

    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.channels).toHaveLength(1);
    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "STREAM" });

    const subscribe = mainChannel(connection).sent.find((message) => message.type === "FEED_SUBSCRIPTION");
    expect(subscribe.add).toEqual([
      { symbol: "/NQZ26:XCME", type: "TimeAndSale" },
      { symbol: "/ESZ26:XCME", type: "TimeAndSale" },
      { symbol: "AAPL", type: "TimeAndSale" },
      { symbol: "TSLA", type: "TimeAndSale" },
      { symbol: "/NQZ26:XCME", type: "Order", source: "GLBX" },
      { symbol: "/ESZ26:XCME", type: "Order", source: "GLBX" },
      { symbol: "AAPL", type: "Order", source: "NTV" },
      { symbol: "TSLA", type: "Order", source: "NTV" },
    ]);
    expect(server.isActive()).toBe(true);
  });

  test("eager startup connects every live stream but defers heavy history until an instrument is selected", async () => {
    const storageReader = fakeStorageReader();
    const { server } = await bootServer({ storageReader });

    expect(storageReader.readRecent).not.toHaveBeenCalled();
    expect(storageReader.readRecentCandles).not.toHaveBeenCalled();

    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(storageReader.readRecent).toHaveBeenCalledTimes(1);
    expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(1);
    expect(storageReader.readRecent.mock.calls[0][0]).toBe("AAPL");
  });

  test("an instrument selected before the session streams warms up once the session does", async () => {
    const storageReader = fakeStorageReader();
    const connection = fakeConnection();
    const server = createDxFeedEagerMarketDataServer(baseOptions({ storageReader, createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    expect(storageReader.readRecentCandles).not.toHaveBeenCalled();

    await driveToChannelsOpened(connection);
    await Promise.resolve();

    expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(1);
    expect(storageReader.readRecentCandles.mock.calls[0][0]).toBe("/NQZ26:XCME");
    expect(storageReader.readRecent.mock.calls.map(([symbol]) => symbol)).toEqual(["/NQZ26:XCME"]);
  });

  test("retains only the configured number of selected history views and rewarms an evicted instrument", async () => {
    const storageReader = fakeStorageReader();
    let nowMs = NOW_MS;
    const { server } = await bootServer({ storageReader, warmViewLimit: 2, now: () => nowMs });
    const client = fakeClient();
    server.handleClientConnected(client);

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    nowMs += 10_000;
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(storageReader.readRecent.mock.calls.map(([symbol]) => symbol)).toEqual([
      "AAPL", "TSLA", "/NQZ26:XCME", "AAPL",
    ]);
  });

  test("readiness describes the selected instrument, and a closed market reads CLOSED, not DEGRADED (Block 8 #5, #10)", async () => {
    let currentTime = NOW_MS;
    const { server } = await bootServer({ storageReader: fakeStorageReader(), now: () => currentTime });
    currentTime = 1_800_000_000_000;
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    const equityAtThreeAmEt = server.currentReadiness();
    expect(equityAtThreeAmEt.marketClosed).toBe(true);
    expect(equityAtThreeAmEt.dimensions).toMatchObject({ transport: "CLOSED", capture: "IDLE", l2: "CLOSED" });

    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    const futuresOvernight = server.currentReadiness();
    expect(futuresOvernight.marketClosed).toBe(false);
    expect(futuresOvernight.dimensions.transport).not.toBe("CLOSED");
    expect(futuresOvernight.dimensions.l2).not.toBe("CLOSED");
  });

  test("rejects a non-positive warm history cache size", () => {
    expect(() => createDxFeedEagerMarketDataServer(baseOptions({ warmViewLimit: 0 }))).toThrow(/warmViewLimit/);
  });

  // Mirrors the lazy module's own regression: a remote candle read that
  // starts out unavailable used to leave that instrument's barHistory stuck
  // forever, since warm-up only ever ran once per view, at boot. The shared
  // VPIN poll loop must retry it the same way it already retries VPIN.
  test("a candle read that starts out unavailable recovers once the poll loop retries it, without a reconnect", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      let candlesAvailable = false;
      const storageReader = fakeStorageReader();
      storageReader.readRecentCandles.mockImplementation((symbol) => ({
        rows: candlesAvailable && symbol === "AAPL" ? [{ ts_open: NOW_MS - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1, buy_volume: 1, trade_count: 1 }] : [],
        available: candlesAvailable,
        startsAtRequestedWindow: candlesAvailable,
      }));
      const { server } = await bootServer({ storageReader, vpinPollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await jest.advanceTimersByTimeAsync(1);
      expect(client.sent.find((frame) => frame.type === "snapshot").bars).toEqual([]);

      candlesAvailable = true;
      await jest.advanceTimersByTimeAsync(15_000);

      const newcomer = fakeClient();
      server.handleClientConnected(newcomer);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), newcomer);
      expect(newcomer.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(1);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  // resetViews() used to clear every VPIN warm-up field per view but not
  // barsWarmupInFlight/barsWarmupRetryNotBeforeMs, so a stop() immediately
  // followed by a start() could leave a brand-new server instance's first
  // candle warm-up silently blocked by a retry cooldown set by the PRIOR
  // instance -- the cooldown check uses the real clock, not the injected
  // now(), so it survives a same-process restart.
  test("a stop() immediately followed by start() does not inherit a stale bars-warmup cooldown from the prior instance", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const storageReader = fakeStorageReader();
      storageReader.readRecentCandles.mockImplementation(() => ({ rows: [], available: false, startsAtRequestedWindow: false }));
      const { server } = await bootServer({ storageReader });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(1);

      server.stop();
      server.start();
      await Promise.resolve();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

      expect(storageReader.readRecentCandles).toHaveBeenCalledTimes(1);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("preloads a gappy/incomplete candle window for an eager view instead of discarding it -- sandbox backfill doesn't require perfect coverage", async () => {
    const storageReader = fakeStorageReader({
      candleRowsBySymbol: { "/NQZ26:XCME": [{ ts_open: NOW_MS - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1, buy_volume: 1, trade_count: 1 }] },
      candlesCoverFullWindow: false,
    });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    expect(client.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(1);
  });

  test("multiple candle rows with a real gap between them still all reach the snapshot, not just a single row", async () => {
    const storageReader = fakeStorageReader({
      candleRowsBySymbol: {
        "/NQZ26:XCME": [
          { ts_open: NOW_MS - 10 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1, buy_volume: 1, trade_count: 1 },
          { ts_open: NOW_MS - 2 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1, buy_volume: 1, trade_count: 1 },
        ],
      },
      candlesCoverFullWindow: false,
    });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    expect(client.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(2);
  });

  test("keeps stored history for an instrument that already built live bars before it was first selected", async () => {
    // Eager mode streams every instrument from startup but warms history only on first selection, so by then the
    // instrument has live closed bars. Live 2026-09-23: AAPL/TSLA/NVDA selected minutes after start showed only their
    // 4 live bars and "no observed history", because every older stored row was dropped as an out-of-order bar.
    const row = (minutesAgo) => ({ ts_open: NOW_MS - minutesAgo * 60_000, open: 230, high: 231, low: 229, close: 230.5, volume: 10, buy_volume: 6, sell_volume: 4, trade_count: 3 });
    const storageReader = fakeStorageReader({ candleRowsBySymbol: { AAPL: [row(10), row(9), row(8)] }, candlesCoverFullWindow: false });
    const { connection, server } = await bootServer({ storageReader });
    const trade = (minutesAgo, offset) => ({
      ...AAPL_TIMEANDSALE_ITEM,
      time: NOW_MS - minutesAgo * 60_000 + 1_000,
      index: AAPL_TIMEANDSALE_ITEM.index + offset,
      sequence: AAPL_TIMEANDSALE_ITEM.sequence + offset,
    });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [trade(3, 1)] });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [trade(2, 2)] });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [trade(1, 3)] });

    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = client.sent.filter((frame) => frame.type === "snapshot" && frame.symbol === "AAPL").at(-1);
    const opens = snapshot.bars.map((bar) => bar.ts_open);
    expect(opens.slice(0, 3)).toEqual([row(10).ts_open, row(9).ts_open, row(8).ts_open]);
    expect(opens.length).toBeGreaterThan(3);
    expect(opens).toEqual([...opens].sort((a, b) => a - b));
    expect(snapshot.bar_history).toEqual(expect.objectContaining({ availability: "AVAILABLE", earliestObservedTsOpen: row(10).ts_open }));
    server.stop();
  });

  test("retains the full seven-day one-minute warm-up in eager mode", async () => {
    const rows = Array.from({ length: 10_080 }, (_, index) => ({
      ts_open: NOW_MS - (10_080 - index) * 60_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      buy_volume: 1,
      trade_count: 1,
    }));
    const storageReader = fakeStorageReader({ candleRowsBySymbol: { "/NQZ26:XCME": rows } });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    const snapshot = client.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.bars).toHaveLength(10_080);
    expect(snapshot.bar_history).toEqual(expect.objectContaining({
      coverage: "START_COVERED",
      earliestObservedTsOpen: NOW_MS - 10_080 * 60_000,
    }));
    server.stop();
  });

  test("a fresh client gets nothing dxFeed-specific until it selects an instrument", async () => {
    const { server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(client.sent).toHaveLength(0);
  });

  test("marker history warms only for the selected instrument, on the shared per-bucket terms", async () => {
    const storageReader = fakeStorageReader();
    const { server } = await bootServer({ storageReader });

    expect(storageReader.readLargeTrades).not.toHaveBeenCalled();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(storageReader.readLargeTrades).toHaveBeenCalledTimes(1);
    // Futures and equities are asked for the same thing now: no floor of any
    // kind, and the same retention density both providers share.
    for (const [, , options] of storageReader.readLargeTrades.mock.calls) {
      expect(options.minNotionalUsd).toBeUndefined();
      expect(options.minContracts).toBeUndefined();
      expect(options.minZScore).toBeUndefined();
      expect(options).toEqual(expect.objectContaining({
        limit: 5_000,
        bucketMs: MARKER_BUCKET_MS,
        perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
        fromMs: expect.any(Number),
      }));
    }
  });

  test("a warmed-up marker for one instrument reaches a client only once that instrument is selected, never a different one", async () => {
    const markerRow = {
      symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
      price: 29100, size: 1, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 7,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    const storageReader = fakeStorageReader({ markerRowsBySymbol: { "/NQZ26:XCME": [markerRow] } });
    const { server } = await bootServer({ storageReader });

    const esClient = fakeClient();
    server.handleClientConnected(esClient);
    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), esClient);
    expect(esClient.sent.find((frame) => frame.type === "snapshot").markers).toHaveLength(0);

    const nqClient = fakeClient();
    server.handleClientConnected(nqClient);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), nqClient);
    // nqClient connected while ES was still selected, so its first
    // "snapshot" frame is ES's (0 markers) -- find the NQ one specifically.
    const snapshot = nqClient.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.markers).toHaveLength(1);
    expect(snapshot.markers[0]).toEqual(expect.objectContaining({ price: 29100, size: 1, side: "buy" }));
  });

  test("REGRESSION: a duplicated row read back from storage during warm-up (dxfeed_time_and_sales has no UNIQUE constraint) is not double-counted or double-sent", async () => {
    // Storage has no dedup on insert, so a replayed envelope can genuinely
    // be persisted as two distinct rows sharing the same synthesized
    // trade_id (symbol:time:timeNanoPart:sequence). Without rememberTrade's
    // own dedup, this reaches dxfeedSnapshotFrame's "trades must be
    // pair-matched and unique" invariant and throws.
    const valid = {
      symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
      price: 29100, size: 1, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 7,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    const storageReader = fakeStorageReader({
      tradeRowsBySymbol: { "/NQZ26:XCME": [valid, { ...valid }] },
    });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(() => server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client)).not.toThrow();

    const snapshot = client.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.trades).toHaveLength(1);
  });

  test("historical futures tape excludes retained corrections, invalid ticks, and unclassified prints", async () => {
    const valid = {
      symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
      price: 29100, size: 1, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 7,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    const storageReader = fakeStorageReader({
      tradeRowsBySymbol: {
        "/NQZ26:XCME": [
          { ...valid, sequence: 10, aggressor_side: "UNDEFINED" },
          { ...valid, sequence: 11, event_kind: "CORRECTION" },
          { ...valid, sequence: 12, valid_tick: 0 },
          valid,
        ],
      },
    });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    const snapshot = client.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toEqual(expect.objectContaining({ trade_id: expect.stringContaining(":7") }));
  });

  test("historical equity tape still excludes retained corrections and unclassified prints, but admits a valid_tick:0 row -- the asymmetric-policy regression guard", async () => {
    const valid = {
      symbol: "AAPL", asset_class: "EQUITY", event_time: NOW_MS - 60_000,
      price: 230.5, size: 10, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 601001,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 0,
    };
    const storageReader = fakeStorageReader({
      tradeRowsBySymbol: {
        AAPL: [
          { ...valid, sequence: 601010, aggressor_side: "UNDEFINED" },
          { ...valid, sequence: 601011, event_kind: "CORRECTION" },
          valid,
        ],
      },
    });
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    const snapshot = client.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "AAPL");
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toEqual(expect.objectContaining({ trade_id: expect.stringContaining(":601001") }));
  });
});

describe("createDxFeedEagerMarketDataServer -- tape/bar eligibility separation", () => {
  test("an unsided eligible equity print updates bars without throwing or inventing a sided aggressive print", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { connection, server } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, aggressorSide: "UNDEFINED" }] });
      expect(client.sent.some((frame) => frame.type === "bar")).toBe(true);
      expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  test("a 12.14-million-share invalidTick equity print stays on tape without polluting bars or book flow", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { connection, server } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, size: 12140109, validTick: false }] });
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "trade", size: 12140109 }));
      expect(client.sent.some((frame) => frame.type === "bar")).toBe(false);
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
  test("a live futures TimeAndSale print marked invalidTick is excluded from tape and bars", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, validTick: false }] });

    expect(client.sent.some((frame) => frame.type === "trade" || frame.type === "bar")).toBe(false);
  });

  test("a live equity TimeAndSale print marked invalidTick stays on tape but is excluded from bars", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, validTick: false }] });

    expect(client.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "bar")).toBe(false);
  });

  // Report 57 W1, O-3 (live only): an auction cross stays on the tape and in
  // the bar, but is flagged on the wire and kept off markers and bubbles.
  test("a live equity auction print is on tape and in the bar, flagged, and never a marker", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, exchangeSaleConditions: "@  6", size: 500_000 }] });

    expect(client.sent.filter((frame) => frame.type === "trade")).toEqual([expect.objectContaining({ auction: true, size: 500_000 })]);
    expect(client.sent.some((frame) => frame.type === "bar")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "marker")).toBe(false);
    expect(server.instrumentSnapshot().find((row) => row.symbol === "AAPL").retention).toMatchObject({ trades: 1, markers: 0 });
  });

  test("an ordinary equity print carries no auction flag and still becomes a marker", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    expect(client.sent.find((frame) => frame.type === "trade")).not.toHaveProperty("auction");
    expect(client.sent.some((frame) => frame.type === "marker")).toBe(true);
  });
});

describe("createDxFeedEagerMarketDataServer -- slow-client backpressure", () => {
  test("a client that stays over the outbound buffer budget past the grace window is closed and removed", async () => {
    let nowMs = NOW_MS;
    const { connection, server } = await bootServer({ now: () => nowMs, clientBufferGraceMs: 10_000 });
    const slowClient = { readyState: 1, bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1, close: jest.fn(), send: jest.fn() };
    const goodClient = fakeClient();
    server.handleClientConnected(slowClient);
    server.handleClientConnected(goodClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), goodClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), slowClient);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, index: AAPL_TIMEANDSALE_ITEM.index + 1, sequence: AAPL_TIMEANDSALE_ITEM.sequence + 1 }] });
    expect(slowClient.close).not.toHaveBeenCalled();
    expect(slowClient.send.mock.calls.map(([data]) => JSON.parse(data).type)).toEqual(expect.arrayContaining(["trade"]));

    nowMs += 10_000;
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, index: AAPL_TIMEANDSALE_ITEM.index + 2, sequence: AAPL_TIMEANDSALE_ITEM.sequence + 2 }] });
    expect(slowClient.close).toHaveBeenCalledWith(1013, "Client is too slow to receive market data");
    expect(slowClient.send.mock.calls.map(([data]) => JSON.parse(data)).filter((frame) => frame.type === "trade")).toHaveLength(1);
    expect(goodClient.sent.some((frame) => frame.type === "trade")).toBe(true);
  });

  test("during the grace window control and incremental frames remain lossless while bulk history is held back", async () => {
    const { connection, server } = await bootServer({ clientBufferGraceMs: 10_000 });
    const slowClient = { readyState: 1, bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1, close: jest.fn(), sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
    const goodClient = fakeClient();
    server.handleClientConnected(slowClient);
    server.handleClientConnected(goodClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), goodClient);

    expect(slowClient.sent).toContainEqual(expect.objectContaining({ type: "selection", symbol: "AAPL" }));
    expect(slowClient.sent.some((frame) => frame.type === "snapshot")).toBe(true);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(slowClient.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(goodClient.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(slowClient.close).not.toHaveBeenCalled();
  });

  test("a client past the hard buffer ceiling is closed immediately, without waiting out the grace window", async () => {
    const { connection, server } = await bootServer({ clientBufferGraceMs: 10_000 });
    const runawayClient = { readyState: 1, bufferedAmount: DEFAULT_CLIENT_BUFFER_HARD_BYTES + 1, close: jest.fn(), send: jest.fn() };
    server.handleClientConnected(runawayClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), runawayClient);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(runawayClient.close).toHaveBeenCalledWith(1013, "Client is too slow to receive market data");
    expect(runawayClient.send).not.toHaveBeenCalled();
  });
});

describe("createDxFeedEagerMarketDataServer -- session establishment", () => {
  // Before the channel collapse, this instead drove a second (equities/AUTO)
  // channel to fail after the first (futures/STREAM) had already opened, to
  // prove cleanup reached both. With every instrument now merged onto one
  // shared STREAM channel, there's no longer a second channel to fail
  // independently -- this covers the same cleanup-on-failure path for the
  // one channel that now carries everything.
  test("if the single shared channel fails to open, the session ends cleanly and the failed channel is still torn down", async () => {
    const connection = fakeConnection();
    const server = createDxFeedEagerMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();

    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    for (let attempt = 0; attempt < 50 && connection.channels.length < 1; attempt += 1) await Promise.resolve();
    connection.channels[0].emitState(DXLinkChannelState.CLOSED, DXLinkChannelState.REQUESTED);
    await Promise.resolve();
    await Promise.resolve();

    expect(server.isActive()).toBe(false);
    expect(connection.channels).toHaveLength(1);
    expect(connection.channels[0].close).toHaveBeenCalledTimes(1);
  });

  test("stop() aborts an in-flight channel open without a late timeout, error log, or retry", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const connections = [];
    const server = createDxFeedEagerMarketDataServer(baseOptions({
      sessionRetryBaseMs: 10,
      createConnection: () => {
        const connection = fakeConnection();
        connections.push(connection);
        return connection;
      },
    }));

    try {
      server.start();
      await waitUntilConnectionCount(connections, 1);
      connections[0].emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
      await waitUntilChannelCount(connections[0], 1);

      server.stop();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(15_010);

      expect(server.isActive()).toBe(false);
      expect(connections).toHaveLength(1);
      expect(connections[0].channels[0].close).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalledWith(
        "dxfeed eager market data server: failed to establish a FEED channel",
        expect.anything(),
      );
    } finally {
      server.stop();
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe("createDxFeedEagerMarketDataServer -- per-instrument isolation and instant switching", () => {
  test("a live trade for one instrument never leaks into another instrument's bars, tape, or markers", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    client.sent.length = 0;

    // ES trade arrives while NQ is selected -- must produce nothing for this client.
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [ES_TIMEANDSALE_ITEM] });
    expect(client.sent).toHaveLength(0);

    // NQ trade arrives -- must produce frames for this client.
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });
    expect(client.sent.some((frame) => frame.type === "bar" && frame.symbol === "/NQZ26:XCME")).toBe(true);
    expect(client.sent.some((frame) => frame.symbol === "/ESZ26:XCME")).toBe(false);
  });

  test("switching to an already-live instrument is instant: no new connect/auth/channel activity, and the new snapshot reflects data that already accumulated in the background", async () => {
    const { connection, server } = await bootServer();
    // AAPL accumulates a trade while nobody is watching it.
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.channels).toHaveLength(1);
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades.some((trade) => trade.price === 230.5)).toBe(true);
  });

  test("a client only ever sees frames for the currently-selected instrument, and switching moves it cleanly", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    client.sent.length = 0;

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [TSLA_TIMEANDSALE_ITEM] });
    expect(client.sent).toHaveLength(0);

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    expect(client.sent.some((frame) => frame.type === "selection" && frame.symbol === "TSLA")).toBe(true);

    client.sent.length = 0;
    // A distinct sequence -- the earlier TSLA item already landed once
    // while AAPL was selected, and the bar aggregator correctly treats a
    // repeated identical item as a duplicate to drop, not a new trade.
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...TSLA_TIMEANDSALE_ITEM, sequence: 701003 }] });
    expect(client.sent.some((frame) => frame.type === "trade" && frame.symbol === "TSLA")).toBe(true);
  });
});

describe("createDxFeedEagerMarketDataServer -- deactivate, expiry, and shutdown", () => {
  test("deactivate() is a no-op while the eager session is alive", async () => {
    const { connection, server } = await bootServer();
    server.deactivate();
    expect(server.isActive()).toBe(true);
    expect(connection.disconnect).not.toHaveBeenCalled();
  });

  test("shared token expiry cleanly replaces the dxFeed client, then returns the selected instrument to READY", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
      const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
      const connections = [];
      const server = createDxFeedEagerMarketDataServer(baseOptions({
        requestToken,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelsOpened(connections[0]);
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      client.sent.length = 0;

      await jest.advanceTimersByTimeAsync(25 * 60_000);
      await waitUntilConnectionCount(connections, 2);
      expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
      expect(client.sent).toContainEqual(expect.objectContaining({
        type: "health",
        recoveryState: "RECOVERING",
        reason: PLANNED_TOKEN_ROTATION_REASON,
      }));
      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(connections[1].connect).toHaveBeenCalledTimes(1);
      expect(connections[1].channels).toHaveLength(0);

      await driveToChannelsOpened(connections[1]);
      mainChannel(connections[1]).emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });

      expect(server.isActive()).toBe(true);
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "trade", symbol: "/NQZ26:XCME" }));
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY", printsQuiet: false }));
      expect(() => server.stop()).not.toThrow();
      infoSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  test("stop() tears down the connection and clears clients", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);

    server.stop();

    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(server.isActive()).toBe(false);
    expect(server.clientCount()).toBe(0);
  });

  test("a deliberate stop followed by start creates a clean session rather than reusing prior view or dedupe state", async () => {
    const connections = [];
    const storageReader = fakeStorageReader({
      markerRowsBySymbol: {
        "/NQZ26:XCME": [{
          symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
          price: 29100, size: 1, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 7,
          aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
        }],
      },
    });
    const server = createDxFeedEagerMarketDataServer(baseOptions({
      storageReader,
      createConnection: () => {
        const connection = fakeConnection();
        connections.push(connection);
        return connection;
      },
    }));
    server.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connections).toHaveLength(1);
    await driveToChannelsOpened(connections[0]);
    server.stop();

    server.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connections).toHaveLength(2);
    await driveToChannelsOpened(connections[1]);
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    const snapshot = client.sent.find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.markers).toHaveLength(1);
    expect(storageReader.readLargeTrades).toHaveBeenCalledTimes(1);
  });
});

describe("createDxFeedEagerMarketDataServer -- crash-risk guard parity with the lazy module", () => {
  // Mirrors dxfeed-market-data-server.test.js's own proven regression:
  // dxfeedSnapshotFrame throws if its bars aren't strictly chronological,
  // and there's no separate connection per instrument here to isolate the
  // blast radius -- a corrupted recentBars array for one instrument would
  // crash every future snapshot build for that instrument, for every
  // client. Verified as a real guard, not a tautology: with rememberBar's
  // ordering check temporarily removed, this exact scenario reproduced a
  // thrown error from handleClientConnected before the guard was restored.
  test("a live closed bar that collides with an already-warmed-up candle's ts_open is dropped, not appended, and never crashes a later snapshot", async () => {
    const nqBucketOpen = Math.floor(NOW_MS / 60_000) * 60_000;
    const storageReader = fakeStorageReader({
      candleRowsBySymbol: {
        "/NQZ26:XCME": [{
          ts_open: nqBucketOpen, open: 29100, high: 29250, low: 29050, close: 29200,
          volume: 40, buy_volume: 22, trade_count: 40,
        }],
      },
    });
    const { connection, server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    client.sent.length = 0;

    // Opens the live bucket for the same minute the warm-up candle already covers.
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });
    // Crosses into the next minute, closing that bucket at the same ts_open as warm-up's row.
    const laterItem = { ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, sequence: 66861 };
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [laterItem] });

    // Persisted history seeds the aggregator's finality watermark, so replay
    // overlap is discarded before it can be closed, broadcast, or logged as
    // an out-of-order bar. The first genuinely newer bucket remains live.
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed === true)).toHaveLength(0);
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed === false)).toHaveLength(1);

    // A fresh client connecting afterward must not crash building its snapshot.
    const freshClient = fakeClient();
    expect(() => server.handleClientConnected(freshClient)).not.toThrow();
    const snapshot = freshClient.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.bars).toHaveLength(1);
    expect(snapshot.bars[0].ts_open).toBe(nqBucketOpen);
  });
});

describe("createDxFeedEagerMarketDataServer -- market-quiet signal (printsQuiet)", () => {
  test("flips printsQuiet to true after 90s of silence on the selected instrument, without touching recoveryState", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const { server, connection } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      client.sent.length = 0;

      jest.advanceTimersByTime(90_000);

      const quietFrame = client.sent.find((frame) => frame.type === "health");
      expect(quietFrame).toEqual(expect.objectContaining({ recoveryState: "RECOVERING", printsQuiet: true }));
      void connection;
    } finally {
      jest.useRealTimers();
    }
  });

  test("a fresh qualifying print after going quiet clears printsQuiet and resets the countdown", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const { server, connection } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      jest.advanceTimersByTime(90_000);
      client.sent.length = 0;

      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });

      const healthFrames = client.sent.filter((frame) => frame.type === "health");
      expect(healthFrames).toContainEqual(expect.objectContaining({ recoveryState: "READY", printsQuiet: false }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("printsQuiet never fires after an unexpected shared-session end (UNAVAILABLE always wins)", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { server, connection } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

      connection.emitError(new Error("transport closed"));
      client.sent.length = 0;

      // Advance well past where a quiet-timer, if still armed, would fire.
      jest.advanceTimersByTime(90_000);

      expect(client.sent.some((frame) => frame.type === "health")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a quiet instrument that isn't currently selected accumulates the flag in the background, surfaced instantly on switch", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const { server, connection } = await bootServer();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      // Keep NQ alive so only ES goes quiet.
      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });

      jest.advanceTimersByTime(90_000);
      client.sent.length = 0;

      server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), client);

      expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", symbol: "/ESZ26:XCME", printsQuiet: true }));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("createDxFeedEagerMarketDataServer -- token-expiry safety", () => {
  test("a permanent broker rejection is visible but never turns the eager relay into a 30-second request loop", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const requestToken = jest.fn(async () => {
        throw tokenBrokerFailure({ retryable: false });
      });
      const server = createDxFeedEagerMarketDataServer(baseOptions({ requestToken, sessionRetryBaseMs: 10 }));
      server.start();
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(requestToken).toHaveBeenCalledTimes(1);
      expect(server.isActive()).toBe(false);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("a retryable broker failure at startup is retried with doubling delays, then given up", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const requestToken = jest.fn(async () => {
        throw tokenBrokerFailure({ retryable: true });
      });
      const server = createDxFeedEagerMarketDataServer(baseOptions({ requestToken, sessionRetryBaseMs: 1_000, sessionRetryMaxAttempts: 3 }));
      server.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(requestToken).toHaveBeenCalledTimes(1);
      // Retries at 1 s, then 2 s more, then 4 s more; nothing after the third.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(requestToken).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(requestToken).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(requestToken).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(requestToken).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(60 * 60_000);
      expect(requestToken).toHaveBeenCalledTimes(4);
      expect(server.isActive()).toBe(false);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("a replacement-token failure leaves the server visibly unavailable and does not retry", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const requestToken = jest.fn()
        .mockResolvedValueOnce({ token: "first.token", expiresAt: VALID_EXPIRES_AT })
        .mockRejectedValueOnce(new Error("broker unavailable"));
      const connections = [];
      const server = createDxFeedEagerMarketDataServer(baseOptions({
        requestToken,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelsOpened(connections[0]);
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      client.sent.length = 0;

      await jest.advanceTimersByTimeAsync(25 * 60_000);

      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(connections).toHaveLength(1);
      expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
      expect(server.isActive()).toBe(false);
      expect(server.currentRecoveryState()).toBe("UNAVAILABLE");
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "UNAVAILABLE" }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("stop during replacement-token acquisition prevents a late replacement connection", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      let resolveReplacementToken;
      const requestToken = jest.fn()
        .mockResolvedValueOnce({ token: "first.token", expiresAt: VALID_EXPIRES_AT })
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveReplacementToken = resolve;
        }));
      const connections = [];
      const server = createDxFeedEagerMarketDataServer(baseOptions({
        requestToken,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelsOpened(connections[0]);

      await jest.advanceTimersByTimeAsync(25 * 60_000);
      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
      server.stop();
      resolveReplacementToken({ token: "late.token", expiresAt: VALID_EXPIRES_AT });
      await Promise.resolve();
      await Promise.resolve();

      expect(connections).toHaveLength(1);
      expect(server.isActive()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Exact raw-frame correlation is covered in dxfeed-order-v2-capture.test.js.
// This server harness substitutes that boundary with canonical envelopes so
// these tests can focus on routing, selection, replay, and lifecycle behavior.
describe("createDxFeedEagerMarketDataServer -- live order book wiring (DX3.07 Phase C)", () => {
  function orderItem(symbol, source) {
    return {
      eventType: "Order", eventSymbol: symbol, eventFlags: 12, index: 1, time: NOW_MS,
      action: "NEW", price: 100, size: 1, side: "BUY", scope: "ORDER", source,
    };
  }

  function canonicalCapture(options) {
    return {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage(message) {
        for (const item of message?.data ?? []) {
          if (item?.eventType !== "Order") continue;
          const context = options.resolveOrderContext(item.eventSymbol);
          if (!context) continue;
          options.onEnvelope({
            provider: "DXFEED", eventType: "ORDER", providerSymbol: context.symbol, assetClass: context.assetClass,
            payload: { ...item, index: String(item.index) },
          });
        }
      },
    };
  }

  function bootOrderServer(overrides = {}) {
    return bootServer({ createOrderV2Capture: canonicalCapture, ...overrides });
  }

  test("an Order message for the currently-selected instrument drives its assembler and broadcasts a book frame", async () => {
    const { connection, server } = await bootOrderServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });

    const bookFrame = client.sent.find((frame) => frame.type === "book");
    expect(bookFrame).toEqual(expect.objectContaining({
      type: "book", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY",
      status: "READY",
    }));
  });

  test("an Order message for a non-selected instrument updates its assembler silently, then replays on selection", async () => {
    const { connection, server } = await bootOrderServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    client.sent.length = 0;

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("TSLA", "NTV")] });
    expect(client.sent.some((frame) => frame.type === "book")).toBe(false);

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    expect(client.sent.some((frame) => frame.type === "book" && frame.symbol === "TSLA")).toBe(true);
  });

  test("an Order message for a symbol outside the instrument set is ignored, not misrouted to another instrument's book", async () => {
    const { connection, server } = await bootOrderServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(() => mainChannel(connection).emitMessage({
      type: "FEED_DATA", data: [orderItem("MSFT", "NTV")],
    })).not.toThrow();
    expect(client.sent.some((frame) => frame.type === "book")).toBe(false);
  });

  test("does not open a second channel -- Order merges onto the same shared STREAM channel as every instrument's TimeAndSale", async () => {
    const { connection } = await bootServer();
    expect(connection.channels).toHaveLength(1);
  });

  test("an order-capture setup failure publishes an explicit unavailable book for every selectable instrument", async () => {
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(() => { throw new Error("missing channel id"); }),
      handleChannelMessage: jest.fn(),
    };
    const { server } = await bootServer({ createOrderV2Capture: () => capture });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      symbol: "AAPL", status: "UNAVAILABLE", reason: "ORDER_CHANNEL_SETUP_FAILED",
    }));
  });

  test("a shared raw-index capture fault clears every selected book instead of allowing old indexed state to resume", async () => {
    let captureOptions;
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage: jest.fn(),
    };
    const { server } = await bootServer({
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "1", eventFlags: 12, action: "NEW", price: 100, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({ status: "READY" }));

    captureOptions.onCaptureError(new Error("raw correlation overflow"));
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR",
    }));

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR",
    }));

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "3", eventFlags: 12, action: "NEW", price: 102, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      status: "READY", bids: [{ price: 102, size: 1 }],
    }));
  });

  test("a READY book that keeps moving is broadcast at most once per interval, always ending on the latest state; status changes go out at once", async () => {
    let clock = NOW_MS;
    let captureOptions;
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const { server } = await bootServer({ createOrderV2Capture: (options) => { captureOptions = options; return capture; }, now: () => clock, bookBroadcastMinIntervalMs: 100 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    const books = () => client.sent.filter((frame) => frame.type === "book" && frame.status === "READY");
    const order = (index, price, flags = 0) => captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY", providerSymbol: "AAPL",
      payload: { index, eventFlags: flags, action: "NEW", price, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    // The snapshot's first READY book goes out at once.
    order("1", 100, 12);
    expect(books()).toHaveLength(1);
    // Four more changes inside the same 100 ms: nothing yet.
    order("2", 101);
    order("3", 102);
    order("4", 103);
    order("5", 104);
    expect(books()).toHaveLength(1);
    // The interval ends: one frame, carrying the book as it stands now.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(books()).toHaveLength(2);
    expect(books().pop().bids[0]).toEqual({ price: 104, size: 1 });
    // A change after the interval has passed is not held back.
    clock += 100;
    order("6", 105);
    expect(books()).toHaveLength(3);
    // A status change never waits: the capture faults and the unavailable book is on the wire immediately.
    order("7", 106);
    captureOptions.onCaptureError(new Error("raw correlation overflow"));
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({ status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR" }));
    expect(() => createDxFeedEagerMarketDataServer(baseOptions({ bookBroadcastMinIntervalMs: -1 }))).toThrow(/bookBroadcastMinIntervalMs/);
  });

  test("a crossed book that outlives its grace makes the server drop that instrument's Order subscription and add it back after a gap, backing off while books keep failing", async () => {
    let clock = NOW_MS;
    let captureOptions;
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const { server, connection } = await bootServer({ createOrderV2Capture: (options) => { captureOptions = options; return capture; }, now: () => clock, bookCrossedGraceMs: 1_000 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    const order = (index, price, side, flags = 0, action = "NEW") => captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY", providerSymbol: "AAPL",
      payload: { index, eventFlags: flags, action, price, size: action === "DELETE" ? null : 1, side, scope: "ORDER", source: "NTV" },
    });
    const subscriptions = () => mainChannel(connection).sent.filter((message) => message.type === "FEED_SUBSCRIPTION").length;
    const before = subscriptions();
    order("1", 100, "BUY", 4);
    order("2", 101, "SELL", 8);
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({ status: "READY" }));
    // A ghost bid above the ask: unavailable at once, but nothing is resubscribed while the grace runs.
    order("3", 102, "BUY");
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" }));
    expect(subscriptions()).toBe(before);
    // Still crossed when the grace ends: the Order entry is removed now and added back after the gap.
    clock += 1_000;
    order("4", 103, "SELL");
    const entry = { symbol: "AAPL", type: "Order", source: "NTV" };
    expect(mainChannel(connection).sent.filter((message) => message.type === "FEED_SUBSCRIPTION").slice(before)).toEqual([{ type: "FEED_SUBSCRIPTION", remove: [entry] }]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mainChannel(connection).sent.filter((message) => message.type === "FEED_SUBSCRIPTION").slice(before)).toEqual([
      { type: "FEED_SUBSCRIPTION", remove: [entry] },
      { type: "FEED_SUBSCRIPTION", add: [entry] },
    ]);
    // Another failure inside the interval is held back; the interval has doubled, so 15 s is still inside it.
    order("5", 104, "SELL");
    clock += 15_000;
    order("6", 105, "SELL");
    expect(subscriptions()).toBe(before + 2);
    clock += 5_000;
    order("7", 106, "SELL");
    expect(subscriptions()).toBe(before + 3);
    // The fresh snapshot brings the book back.
    order("8", 100, "BUY", 12);
    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({ status: "READY", bids: [{ price: 100, size: 1 }] }));
    expect(() => createDxFeedEagerMarketDataServer(baseOptions({ bookCrossedGraceMs: -1 }))).toThrow(/bookCrossedGraceMs/);
  });

  test("a cross that heals inside the grace never reaches the client as a lost book: unavailable, then READY again, no resubscribe", async () => {
    let clock = NOW_MS;
    let captureOptions;
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const { server, connection } = await bootServer({ createOrderV2Capture: (options) => { captureOptions = options; return capture; }, now: () => clock, bookCrossedGraceMs: 2_000 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    const order = (index, price, side, flags = 0, action = "NEW") => captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY", providerSymbol: "AAPL",
      payload: { index, eventFlags: flags, action, price, size: action === "DELETE" ? null : 1, side, scope: "ORDER", source: "NTV" },
    });
    const before = mainChannel(connection).sent.filter((message) => message.type === "FEED_SUBSCRIPTION").length;
    order("1", 100, "BUY", 4);
    order("2", 101, "SELL", 8);
    order("3", 102, "BUY");
    clock += 500;
    order("3", 102, "BUY", 0, "DELETE");
    const books = client.sent.filter((frame) => frame.type === "book").map((frame) => frame.status);
    expect(books.slice(-2)).toEqual(["UNAVAILABLE", "READY"]);
    expect(mainChannel(connection).sent.filter((message) => message.type === "FEED_SUBSCRIPTION").length).toBe(before);
  });

  test("an instrument off screen costs no book frame per order event; its frame is built when it is selected", async () => {
    let captureOptions;
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const { server } = await bootServer({ createOrderV2Capture: (options) => { captureOptions = options; return capture; } });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    // TSLA's book builds up while AAPL is on screen: nothing about TSLA reaches the client.
    for (const [index, price] of [["1", 300], ["2", 301], ["3", 302]]) {
      captureOptions.onEnvelope({
        provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY", providerSymbol: "TSLA",
        payload: { index, eventFlags: index === "1" ? 12 : 0, action: "NEW", price, size: 2, side: "BUY", scope: "ORDER", source: "NTV" },
      });
    }
    expect(client.sent.some((frame) => frame.type === "book" && frame.symbol === "TSLA")).toBe(false);
    // Selecting TSLA delivers its book as it stands, all three levels.
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    const tsla = client.sent.filter((frame) => frame.type === "book" && frame.symbol === "TSLA").pop();
    expect(tsla).toEqual(expect.objectContaining({ status: "READY", bids: [{ price: 302, size: 2 }, { price: 301, size: 2 }, { price: 300, size: 2 }] }));
  });

  test("durably telemetrizes per-instrument book unavailable/recovery transitions, without re-emitting for repeated identical states", async () => {
    let captureOptions;
    const telemetryEvents = [];
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage: jest.fn(),
    };
    const { server } = await bootServer({
      telemetry: (entry) => telemetryEvents.push(entry),
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    const bookEvents = () => telemetryEvents.filter((e) => e.event.startsWith("market_data.dxfeed_book_assembler."));

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "1", eventFlags: 12, action: "NEW", price: 100, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(bookEvents()).toHaveLength(0);

    captureOptions.onCaptureError(new Error("raw correlation overflow"));
    expect(bookEvents()).toEqual([
      expect.objectContaining({
        event: "market_data.dxfeed_book_assembler.unavailable",
        symbol: "AAPL", assetClass: "EQUITY", reason: "ORDER_CAPTURE_ERROR", previousStatus: "READY",
      }),
    ]);

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(bookEvents()).toHaveLength(1);

    captureOptions.onEnvelope({
      provider: "DXFEED", eventType: "ORDER", assetClass: "EQUITY",
      providerSymbol: "AAPL",
      payload: { index: "3", eventFlags: 12, action: "NEW", price: 102, size: 1, side: "BUY", scope: "ORDER", source: "NTV" },
    });
    expect(bookEvents()).toEqual([
      expect.objectContaining({ event: "market_data.dxfeed_book_assembler.unavailable" }),
      expect.objectContaining({
        event: "market_data.dxfeed_book_assembler.recovery_succeeded", symbol: "AAPL", assetClass: "EQUITY",
      }),
    ]);
  });

  test("an equity book reads stale while the equity session is closed, though its order book is complete (O-10)", async () => {
    const saturday = Date.parse("2027-01-16T15:00:00Z");
    let captureOptions;
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage(message) {
        for (const item of message?.data ?? []) {
          if (item?.eventType !== "Order") continue;
          const context = captureOptions.resolveOrderContext(item.eventSymbol);
          if (!context) continue;
          captureOptions.onEnvelope({
            provider: "DXFEED", eventType: "ORDER", providerSymbol: context.symbol, assetClass: context.assetClass,
            payload: { ...item, index: String(item.index) },
          });
        }
      },
    };
    const { connection, server } = await bootServer({
      now: () => saturday,
      requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: new Date(saturday + 30 * 60_000).toISOString() })),
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
    const aapl = server.instrumentSnapshot()[2];
    expect(aapl.symbol).toBe("AAPL");
    expect(aapl.session.state).not.toBe("REGULAR");
    expect(aapl.l2).toEqual({ status: "READY", reason: null, stale: true });
  });

  test("instrumentSnapshot reports all four configured instruments, live L1/L2 state per row, in configured order", async () => {
    let captureOptions;
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage(message) {
        for (const item of message?.data ?? []) {
          if (item?.eventType !== "Order") continue;
          const context = captureOptions.resolveOrderContext(item.eventSymbol);
          if (!context) continue;
          captureOptions.onEnvelope({
            provider: "DXFEED", eventType: "ORDER", providerSymbol: context.symbol, assetClass: context.assetClass,
            payload: { ...item, index: String(item.index) },
          });
        }
      },
    };
    const { connection, server } = await bootServer({
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });

    const beforeAnyTraffic = server.instrumentSnapshot();
    expect(beforeAnyTraffic.map((row) => row.symbol)).toEqual(["/NQZ26:XCME", "/ESZ26:XCME", "AAPL", "TSLA"]);
    expect(beforeAnyTraffic[2]).toEqual({
      analytics: { profile: "IDLE", vpin: "IDLE" },
      dataQuality: {
        accepted: 0, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: {}, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 0, markers: 0, heavyHistoryWarm: false },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "RECOVERING", quiet: false },
      l2: { status: "BUFFERING", reason: null },
    });

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    const afterTraffic = server.instrumentSnapshot();
    expect(afterTraffic[2]).toEqual({
      analytics: { profile: "IDLE", vpin: "IDLE" },
      dataQuality: {
        accepted: 1, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: { "@  o": 1 }, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 1, markers: 1, heavyHistoryWarm: false },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "READY", quiet: false },
      l2: { status: "READY", reason: null },
    });
    expect(afterTraffic[3]).toEqual({
      analytics: { profile: "IDLE", vpin: "IDLE" },
      dataQuality: {
        accepted: 0, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: {}, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 0, markers: 0, heavyHistoryWarm: false },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "TSLA", assetClass: "EQUITY",
      l1: { recoveryState: "RECOVERING", quiet: false },
      l2: { status: "BUFFERING", reason: null },
    });

    captureOptions.onCaptureError(new Error("raw correlation overflow"));
    expect(server.instrumentSnapshot()[2]).toEqual({
      analytics: { profile: "IDLE", vpin: "IDLE" },
      dataQuality: {
        accepted: 1, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: { "@  o": 1 }, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 1, markers: 1, heavyHistoryWarm: false },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "READY", quiet: false },
      l2: { status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR" },
    });
  });

  test("a closed equity that never recovered reads CLOSED, not RECOVERING, while an open future and a recovered equity keep their state", async () => {
    let simulatedNowMs = NOW_MS;
    const { connection, server } = await bootServer({ now: () => simulatedNowMs });
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(server.instrumentSnapshot().find((row) => row.symbol === "TSLA").l1.recoveryState).toBe("RECOVERING");

    simulatedNowMs = Date.parse("2026-09-30T00:30:00Z");
    const rows = server.instrumentSnapshot();
    const bySymbol = (symbol) => rows.find((row) => row.symbol === symbol);

    expect(bySymbol("TSLA")).toMatchObject({ session: { state: "CLOSED" }, l1: { recoveryState: "CLOSED" } });
    expect(bySymbol("AAPL")).toMatchObject({ session: { state: "CLOSED" }, l1: { recoveryState: "READY" } });
    expect(bySymbol("/NQZ26:XCME").session.state).not.toBe("CLOSED");
    expect(bySymbol("/NQZ26:XCME").l1.recoveryState).toBe("RECOVERING");
    server.stop();
  });

  test("orderV2CaptureStatus exposes the shared capture module's live correlation health", async () => {
    const { server } = await bootServer();

    expect(server.orderV2CaptureStatus()).toEqual(expect.objectContaining({ healthy: true, lastFailure: null }));

    server.stop();
    expect(server.orderV2CaptureStatus()).toBeNull();
  });

  // A correlation loss caused by ONE instrument's traffic used to surface only
  // as a raw console.error, unattributed and never persisted -- the exact gap
  // that made tonight's live incident take a purpose-built probe to diagnose
  // instead of a log line. It must now be durably attributed to the instrument
  // that actually caused it.
  test("attributes a shared correlation fault to its triggering instrument via telemetry", async () => {
    const telemetryEvents = [];
    let captureOptions;
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage: jest.fn(),
    };
    const { server } = await bootServer({
      telemetry: (entry) => telemetryEvents.push(entry),
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    const error = new Error("dxfeed-order-v2-capture: parsed FEED_DATA arrived without its raw frame");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["/NQZ26:XCME"];
    captureOptions.onCaptureError(error);

    const failure = telemetryEvents.find((e) => e.event === "market_data.dxfeed_order_v2_capture.correlation_failed");
    expect(failure).toEqual(expect.objectContaining({
      code: "DXFEED_ORDER_V2_CORRELATION_LOST",
      eventSymbols: ["/NQZ26:XCME"],
      channelId: expect.any(Number),
    }));
  });

  // All four instruments share one physical channel (contract "STREAM"), so
  // there is no order-only channel to isolate -- recovery must close and
  // reopen the ONE shared channel on the SAME connection. No new token: this
  // must not call requestToken again, and it must resubscribe every
  // instrument's TimeAndSale plus Order on the fresh channel, not just Order.
  test("recovers from a correlation loss by reopening the shared channel on the same connection, without a new token", async () => {
    const telemetryEvents = [];
    let captureOptions;
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage: jest.fn(),
    };
    const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
    const { connection, server } = await bootServer({
      telemetry: (entry) => telemetryEvents.push(entry),
      requestToken,
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const firstChannel = mainChannel(connection);
    expect(requestToken).toHaveBeenCalledTimes(1);

    const error = new Error("dxfeed-order-v2-capture: parsed FEED_DATA arrived without its raw frame");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["/NQZ26:XCME"];
    captureOptions.onCaptureError(error);

    expect(firstChannel.removeMessageListener).toHaveBeenCalled();
    expect(firstChannel.close).toHaveBeenCalled();
    await waitUntilChannelCount(connection, 2);
    const reopenedChannel = connection.channels[1];
    await Promise.resolve();
    await Promise.resolve();
    reopenedChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(reopenedChannel.send).toHaveBeenCalledWith(expect.objectContaining({ type: "FEED_SETUP" }));
    const resubscribe = reopenedChannel.sent.find((m) => m.type === "FEED_SUBSCRIPTION");
    expect(resubscribe.add).toEqual(expect.arrayContaining([
      { symbol: "/NQZ26:XCME", type: "TimeAndSale" },
      { symbol: "/NQZ26:XCME", type: "Order", source: "GLBX" },
    ]));
    expect(capture.setChannelId).toHaveBeenLastCalledWith(reopenedChannel.id);

    const succeeded = telemetryEvents.find((e) => e.event === "market_data.dxfeed_order_v2_capture.channel_reopen_succeeded");
    expect(succeeded).toEqual(expect.objectContaining({
      attempt: 1, newChannelId: reopenedChannel.id, previousChannelId: firstChannel.id,
    }));
    server.stop();
  });

  test("gives up after 3 failed reopen attempts rather than retrying forever", async () => {
    const telemetryEvents = [];
    let captureOptions;
    const capture = { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
    const { connection, server } = await bootServer({
      telemetry: (entry) => telemetryEvents.push(entry),
      sessionRetryBaseMs: 1,
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    });

    const error = new Error("dxfeed-order-v2-capture: parsed FEED_DATA arrived without its raw frame");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["/NQZ26:XCME"];
    captureOptions.onCaptureError(error);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (let wait = 0; wait < 50 && connection.channels.length < attempt + 2; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const failingChannel = connection.channels[attempt + 1];
      await Promise.resolve();
      await Promise.resolve();
      failingChannel.emitState(DXLinkChannelState.CLOSED, DXLinkChannelState.REQUESTED);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let wait = 0; wait < 50 && !telemetryEvents.some((e) => e.event.endsWith("channel_reopen_exhausted")); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const exhausted = telemetryEvents.find((e) => e.event === "market_data.dxfeed_order_v2_capture.channel_reopen_exhausted");
    expect(exhausted).toEqual(expect.objectContaining({ attempts: 3 }));
    expect(connection.channels).toHaveLength(4);
    server.stop();
  });

  test("a newly-connected client is replayed the currently-selected instrument's last book frame", async () => {
    const { connection, server } = await bootOrderServer();
    const firstClient = fakeClient();
    server.handleClientConnected(firstClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), firstClient);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
    const bookFrame = firstClient.sent.find((frame) => frame.type === "book");

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);
    expect(lateClient.sent).toContainEqual(bookFrame);
  });

  test("schedules a book-staleness timer once an order message arrives for an instrument, fully cleared on stop -- no timer leak", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const { connection, server } = await bootOrderServer();
      const timersBeforeOrderEvent = jest.getTimerCount();

      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
      // The staleness timer, and the heatmap's short wait before it diffs the book (dxfeed-liquidity-binding).
      expect(jest.getTimerCount()).toBe(timersBeforeOrderEvent + 2);

      server.stop();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a connection error ends the session and transitions every instrument's book to UNAVAILABLE, not left frozen at its last state -- Stage 3 audit finding", async () => {
    const { connection, server } = await bootOrderServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
    const bookFramesBeforeError = client.sent.filter((frame) => frame.type === "book").length;
    expect(bookFramesBeforeError).toBeGreaterThan(0);

    connection.emitError(new Error("connection boom"));

    const bookFramesAfterError = client.sent.filter((frame) => frame.type === "book");
    expect(bookFramesAfterError.length).toBeGreaterThan(bookFramesBeforeError);
    expect(bookFramesAfterError[bookFramesAfterError.length - 1]).toEqual(expect.objectContaining({
      type: "book", symbol: "AAPL", status: "UNAVAILABLE", reason: SESSION_ENDED_REASON,
    }));
    expect(server.instrumentSnapshot().find((row) => row.symbol === "AAPL").l2).toEqual({ status: "UNAVAILABLE", reason: SESSION_ENDED_REASON });
    expect(server.isActive()).toBe(false);
  });

  test("supervises an unexpected shared-session failure and restores all eager subscriptions", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const connections = [];
      const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
      const server = createDxFeedEagerMarketDataServer(baseOptions({
        requestToken,
        sessionRetryBaseMs: undefined,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelsOpened(connections[0]);

      connections[0].emitError(new Error("transport lost"));
      expect(server.isActive()).toBe(false);
      await jest.advanceTimersByTimeAsync(119_999);
      expect(requestToken).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await waitUntilConnectionCount(connections, 2);
      await driveToChannelsOpened(connections[1]);

      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(server.isActive()).toBe(true);
      const subscribe = mainChannel(connections[1]).sent.find((message) => message.type === "FEED_SUBSCRIPTION");
      expect(subscribe.add).toHaveLength(8);
      // A later drop gets the same ladder again, not a single attempt (2026-09-10: one
      // retry left the feed dead until a manual restart six times in a day): the third
      // session comes two minutes on.
      connections[1].emitError(new Error("retry connection failed"));
      expect(server.isActive()).toBe(false);
      await jest.advanceTimersByTimeAsync(120_000);
      await waitUntilConnectionCount(connections, 3);
      expect(requestToken).toHaveBeenCalledTimes(3);
      await server.stop();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("a routine planned token rotation transitions the book to UNAVAILABLE too, not just health -- the specific scenario this audit was most concerned with, since rotation is periodic and expected, not an error", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    let server;
    try {
      const requestToken = jest.fn()
        .mockResolvedValueOnce({ token: "first.token", expiresAt: VALID_EXPIRES_AT })
        .mockResolvedValueOnce({ token: "second.token", expiresAt: VALID_EXPIRES_AT });
      const connections = [];
      server = createDxFeedEagerMarketDataServer(baseOptions({
        requestToken,
        createOrderV2Capture: canonicalCapture,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelsOpened(connections[0]);
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      mainChannel(connections[0]).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
      client.sent.length = 0;

      await jest.advanceTimersByTimeAsync(25 * 60_000);

      expect(connections).toHaveLength(2);
      expect(client.sent).toContainEqual(expect.objectContaining({
        type: "book", symbol: "AAPL", status: "UNAVAILABLE", reason: PLANNED_TOKEN_ROTATION_REASON,
      }));
    } finally {
      server?.stop();
      jest.useRealTimers();
    }
  });

  test("a deliberate stop() stays silent for the book, exactly matching the existing health-frame precedent", async () => {
    const { connection, server } = await bootOrderServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [orderItem("AAPL", "NTV")] });
    const bookFramesBeforeStop = client.sent.filter((frame) => frame.type === "book").length;
    const healthFramesBeforeStop = client.sent.filter((frame) => frame.type === "health").length;

    server.stop();

    expect(client.sent.filter((frame) => frame.type === "book")).toHaveLength(bookFramesBeforeStop);
    expect(client.sent.filter((frame) => frame.type === "health")).toHaveLength(healthFramesBeforeStop);
  });
});

describe("createDxFeedEagerMarketDataServer -- adaptive large-trade baseline (per-instrument)", () => {
  test("each instrument ranks within its own buckets -- an outsized NQ print wins its slot regardless of ES", async () => {
    const { connection, server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    for (let i = 0; i < 24; i += 1) {
      const size = i % 2 === 0 ? 40 : 60;
      mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 80_000 + i, size }] });
    }
    client.sent.length = 0;

    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 80_100, size: 500 }] });

    const marker = client.sent.find((frame) => frame.type === "marker" && frame.symbol === "/NQZ26:XCME");
    expect(marker).toBeDefined();
    expect(marker.size).toBe(500);
    expect(marker.baseline_log_median).toBeUndefined();
  });

  describe("volume profile wiring (P4.09 Steps 4-5)", () => {
    function volumeProfileTradeRows() {
      // Anchored to the suite's fixed clock: the server derives row width
      // from a lookback window ending at now(), so rows outside it are
      // invisible to warm-up.
      return [
        { event_time: NOW_MS - 3_000, provider_trade_id: 1, price: 190, size: 1, aggressor_side: "BUY" },
        { event_time: NOW_MS - 2_000, provider_trade_id: 2, price: 200, size: 2, aggressor_side: "SELL" },
        { event_time: NOW_MS - 1_000, provider_trade_id: 3, price: 210, size: 1, aggressor_side: "BUY" },
      ];
    }

    // Symbol-keyed and cursor-aware like the other two servers' own volume
    // profile suites: every instrument gets the same fixture by default
    // (each instrument's session tracks its own independent pollCursor, so
    // this doesn't cause cross-instrument interference), served once per
    // cursor chain, then empty pages once the cursor has advanced.
    function fakeVolumeProfileStorageReader({ tradeRowsBySymbol = {} } = {}) {
      const readTradesSince = jest.fn((symbol, _assetClass, { cursor }) => {
        const rows = tradeRowsBySymbol[symbol] ?? volumeProfileTradeRows();
        if (cursor !== null || rows.length === 0) return { rows: [], nextCursor: cursor, available: true };
        return { rows, nextCursor: { ts: rows[rows.length - 1].event_time, id: rows.length }, available: true };
      });
      const readVolumeProfile = jest.fn((symbol, _assetClass, { fromTs, toTs, originPrice, rowWidth }) => {
        const rows = tradeRowsBySymbol[symbol] ?? volumeProfileTradeRows();
        const buckets = new Map();
        for (const row of rows) {
          if (row.event_time < fromTs || row.event_time >= toTs) continue;
          const bucketIndex = Math.floor((row.price - originPrice) / rowWidth);
          const existing = buckets.get(bucketIndex) ?? { volume: 0, buyVolume: 0, sellVolume: 0 };
          existing.volume += row.size;
          if (row.aggressor_side === "BUY") existing.buyVolume += row.size;
          else if (row.aggressor_side === "SELL") existing.sellVolume += row.size;
          buckets.set(bucketIndex, existing);
        }
        return { buckets: [...buckets.entries()].map(([bucket, v]) => ({ bucket, ...v })), available: true };
      });
      // The real reader derives row width from an aggregate over the whole
      // window. A double that omits this reports "no price range", which
      // makes every warm-up silently bail -- so it has to answer honestly.
      const readPriceRange = jest.fn((symbol, _assetClass, { fromTs, toTs }) => {
        const rows = tradeRowsBySymbol[symbol] ?? volumeProfileTradeRows();
        const inWindow = rows.filter((row) => row.event_time >= fromTs && row.event_time < toTs);
        if (inWindow.length === 0) return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
        return {
          minPrice: Math.min(...inWindow.map((row) => row.price)),
          maxPrice: Math.max(...inWindow.map((row) => row.price)),
          tradeCount: inWindow.length,
          available: true,
        };
      });
      return { readTradesSince, readVolumeProfile, readPriceRange };
    }

    function fakeTickSizeResolver(tickSize = 1) {
      return { getDxFeedTickSize: jest.fn(() => tickSize), getBinanceTickSize: jest.fn() };
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

    test("warms heavy profile history on selection and broadcasts only for the selected instrument", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const tickSizeResolver = fakeTickSizeResolver();
      const { connection, server } = await bootServer({ storageReader, tickSizeResolver, volumeProfilePollMs: 10 });
      void connection;
      expect(tickSizeResolver.getDxFeedTickSize).not.toHaveBeenCalled();

      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(tickSizeResolver.getDxFeedTickSize).toHaveBeenCalled();

      const aaplFrames = client.sent.filter((f) => f.type === "profile");
      expect(aaplFrames.length).toBeGreaterThan(0);
      expect(aaplFrames.every((f) => f.symbol === "AAPL")).toBe(true);
      client.sent.length = 0;

      // Switching to TSLA starts its independent selected-history warm-up.
      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      await settle();

      const tslaFrames = client.sent.filter((f) => f.type === "profile");
      expect(tslaFrames.length).toBeGreaterThan(0);
      expect(tslaFrames.every((f) => f.symbol === "TSLA")).toBe(true);
      server.stop();
    });

    test("a warm instrument that is not selected is polled once per background interval, not every tick (Block 8 #1)", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      let offsetMs = NOW_MS - Date.now();
      const { server } = await bootServer({
        storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10, backgroundPollMs: 60_000, now: () => Date.now() + offsetMs,
      });
      const callsFor = (symbol) => storageReader.readTradesSince.mock.calls.filter(([called]) => called === symbol).length;
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      await settle();
      const aaplBefore = callsFor("AAPL");
      const tslaBefore = callsFor("TSLA");
      await settle(100);
      expect(callsFor("AAPL")).toBe(aaplBefore);
      expect(callsFor("TSLA")).toBeGreaterThan(tslaBefore);
      offsetMs += 60_000;
      await settle();
      expect(callsFor("AAPL")).toBeGreaterThan(aaplBefore);
      server.stop();
    });

    test("rejects a non-positive background poll interval", () => {
      expect(() => createDxFeedEagerMarketDataServer(baseOptions({ backgroundPollMs: 0 }))).toThrow(/backgroundPollMs/);
    });

    test("a profile setting sent during initial warm-up is not lost", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      server.handleClientMessage(profileConfigWire({ mode: "per_candle", bin_size_multiplier: 2 }), client);
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile" && frame.symbol === "AAPL").at(-1)?.mode).toBe("per_candle");
      server.stop();
    });

    test("never calls the tick-size resolver when storageReader lacks readVolumeProfile/readTradesSince", async () => {
      const tickSizeResolver = fakeTickSizeResolver();
      // baseOptions() itself defaults storageReader to a fakeStorageReader()
      // implementing only readRecent/readRecentCandles/readLargeTrades.
      const { server } = await bootServer({ tickSizeResolver, volumeProfilePollMs: 10 });
      expect(tickSizeResolver.getDxFeedTickSize).not.toHaveBeenCalled();
      server.stop();
    });

    test("a profile_config sent before any instrument has been selected is safely ignored", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);

      expect(() => server.handleClientMessage(profileConfigWire({ mode: "per_candle" }), client)).not.toThrow();
      expect(() =>
        server.handleClientMessage(profileConfigWire({ mode: "fixed_range", range_start_ts: NOW_MS - 10_000, range_end_ts: NOW_MS + 5_000 }), client),
      ).not.toThrow();
      await settle();
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      server.stop();
    });

    test("an invalid profile_config request (missing/extra fields, unrecognized mode, invalid period_ms/bin_size_multiplier, or a range on a non-fixed_range mode) is logged and ignored -- never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      client.sent.length = 0;

      expect(() => server.handleClientMessage("not json", client)).not.toThrow();
      expect(() => server.handleClientMessage(JSON.stringify({ type: "profile_config", mode: "continuous" }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ extra: true }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ mode: "bogus" }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ period_ms: 0 }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ bin_size_multiplier: -1 }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ range_start_ts: 100 }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ mode: "fixed_range" }), client)).not.toThrow();
      expect(() => server.handleClientMessage(profileConfigWire({ mode: "fixed_range", range_start_ts: 500, range_end_ts: 100 }), client)).not.toThrow();

      expect(client.sent).toEqual([]);
      server.stop();
    });

    test("a valid profile_config changes only the selected view's mode -- a different, non-selected instrument's mode is unaffected", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      server.handleClientMessage(profileConfigWire({ mode: "per_candle" }), client);
      await settle();
      const [aaplFrame] = client.sent.filter((f) => f.type === "profile");
      expect(aaplFrame.mode).toBe("per_candle");
      client.sent.length = 0;

      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      await settle();
      const [tslaFrame] = client.sent.filter((f) => f.type === "profile");
      expect(tslaFrame).toBeDefined();
      expect(tslaFrame.mode).toBe("continuous");
      server.stop();
    });

    test("the latest of overlapping asynchronous profile rebuilds wins", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(0.01), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      const pending = [];
      storageReader.readPriceRange.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      server.handleClientMessage(profileConfigWire({ bin_size_multiplier: 3 }), client);
      server.handleClientMessage(profileConfigWire({ bin_size_multiplier: 7 }), client);
      await new Promise((resolve) => setImmediate(resolve));
      expect(pending).toHaveLength(2);

      pending[1]({ minPrice: 100, maxPrice: 110, tradeCount: 2, available: true });
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile").at(-1).row_width).toBeCloseTo((10 * 7) / 75);

      pending[0]({ minPrice: 100, maxPrice: 110, tradeCount: 2, available: true });
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile").at(-1).row_width).toBeCloseTo((10 * 7) / 75);
      server.stop();
    });

    test("a small period_ms rolls the open period over to a fresh session on the next poll tick", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      // baseOptions() freezes `now`, under which rollover-due-ness could
      // never be observed (nowMs never advances past periodStartTs +
      // periodMs once periodMs > 0) -- an incrementing clock is needed
      // here specifically, unlike every other test in this suite.
      let simulatedNowMs = NOW_MS;
      const now = () => (simulatedNowMs += 5);
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10, now });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();

      const [firstFrame] = client.sent.filter((f) => f.type === "profile");
      expect(firstFrame).toBeDefined();
      expect(storageReader.readVolumeProfile).not.toHaveBeenCalled();
      client.sent.length = 0;

      server.handleClientMessage(profileConfigWire({ period_ms: 1 }), client);
      await settle();

      const [rolledFrame] = client.sent.filter((f) => f.type === "profile");
      expect(rolledFrame).toBeDefined();
      // A rollover now rebuilds the session on the epoch grid instead of
      // finalizing the closed one, whose buckets were computed and then
      // discarded. The advancing period start is the observable proof it
      // ran; the old finalize read is gone.
     expect(rolledFrame.period_start_ts).toBeGreaterThan(firstFrame.period_start_ts);
      const range = storageReader.readPriceRange.getMockImplementation();
      storageReader.readPriceRange.mockReturnValue({ available: false, minPrice: null, maxPrice: null, tradeCount: 0 });
      client.sent.length = 0;
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile")).toHaveLength(0);
      expect(server.instrumentSnapshot().find((item) => item.symbol === "AAPL").analytics.profile).toBe("UNAVAILABLE");
      storageReader.readPriceRange.mockImplementation(range);
      simulatedNowMs += 15_000;
      await settle();
      expect(server.instrumentSnapshot().find((item) => item.symbol === "AAPL").analytics.profile).toBe("READY");
      expect(client.sent.some((frame) => frame.type === "profile")).toBe(true);
      server.stop();
    });

    test("Friday's CME closure suspends profile reads instead of repeating rollover failures", async () => {
      let simulatedNowMs = NOW_MS;
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10, backgroundPollMs: 10, now: () => simulatedNowMs });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await settle();
      simulatedNowMs = Date.parse("2027-01-15T23:00:03Z");
      await settle();
      const reads = storageReader.readPriceRange.mock.calls.length;
      const polls = storageReader.readTradesSince.mock.calls.length;
      expect(server.instrumentSnapshot().find((row) => row.symbol === "/NQZ26:XCME").analytics.profile).toBe("CLOSED");
      await settle();
      expect(storageReader.readPriceRange).toHaveBeenCalledTimes(reads);
      expect(storageReader.readTradesSince).toHaveBeenCalledTimes(polls);
      await server.stop();
    });

    test("a valid fixed_range profile_config sends a single profile frame for the selected instrument", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      server.handleClientMessage(profileConfigWire({ mode: "fixed_range", range_start_ts: NOW_MS - 10_000, range_end_ts: NOW_MS + 5_000 }), client);
      await settle();

      const frames = client.sent.filter((f) => f.type === "profile");
      expect(frames).toHaveLength(1);
      expect(frames[0].mode).toBe("fixed_range");
      expect(frames[0].symbol).toBe("AAPL");
      expect(frames[0].period_start_ts).toBe(NOW_MS - 10_000);
      expect(frames[0].period_end_ts).toBe(NOW_MS + 5_000);
      server.stop();
    });

    test("a fixed-range profile that finishes after selection changes is discarded", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      const originalReadPriceRange = storageReader.readPriceRange.getMockImplementation();
      let resolveRange;
      storageReader.readPriceRange.mockImplementation(() => new Promise((resolve) => { resolveRange = resolve; }));
      server.handleClientMessage(profileConfigWire({ mode: "fixed_range", range_start_ts: NOW_MS - 10_000, range_end_ts: NOW_MS + 5_000 }), client);
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolveRange).toBeDefined();

      storageReader.readPriceRange.mockImplementation(originalReadPriceRange);
      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      client.sent.length = 0;
      resolveRange({ minPrice: 100, maxPrice: 110, tradeCount: 2, available: true });
      await settle();

      expect(client.sent.filter((frame) => frame.type === "profile" && frame.symbol === "AAPL")).toEqual([]);
      server.stop();
    });

    test("a bin_size_multiplier override on a fixed_range request reaches that one-off query's row-width resolution", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      server.handleClientMessage(
        profileConfigWire({ mode: "fixed_range", range_start_ts: NOW_MS - 10_000, range_end_ts: NOW_MS + 5_000, bin_size_multiplier: 7 }),
        client,
      );
      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame).toBeDefined();
      expect(frame.row_width).toBeCloseTo((20 * 7) / 75);
      server.stop();
    });

    // A2.19 / L1L2-V2-045, closing the coverage half of L1L2-V2-044. The lazy
    // server carries this exact regression test; the eager server's fix was
    // byte-parallel but unasserted, which is how one defect in three servers
    // was caught by none. The suite's frozen clock is what gives it teeth: no
    // rollover can occur, so the config handler itself has to apply the grid.
    test("a bin_size_multiplier change rebuilds the session grid immediately, not at the next period rollover", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      const [firstFrame] = client.sent.filter((f) => f.type === "profile");
      expect(firstFrame).toBeDefined();
      client.sent.length = 0;

      server.handleClientMessage(profileConfigWire({ bin_size_multiplier: 10 }), client);
      await settle();

      const [regridded] = client.sent.filter((f) => f.type === "profile");
      expect(regridded).toBeDefined();
      expect(regridded.row_width).not.toBe(firstFrame.row_width);
      expect(regridded.period_start_ts).toBe(firstFrame.period_start_ts);
      server.stop();
    });

    test("a fixed_range request over a window with no trades sends nothing, never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader({ tradeRowsBySymbol: { AAPL: [] } });
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      client.sent.length = 0;

      expect(() =>
        server.handleClientMessage(profileConfigWire({ mode: "fixed_range", range_start_ts: NOW_MS - 10_000, range_end_ts: NOW_MS + 5_000 }), client),
      ).not.toThrow();
      await settle();

      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      server.stop();
    });

    describe("batched historical profiles (profile_history)", () => {
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

      function alignedRanges(periodMs, count, nowMs) {
        const end = Math.floor(nowMs / periodMs) * periodMs;
        const out = [];
        for (let i = count; i > 0; i -= 1) {
          const start = end - i * periodMs;
          out.push({ range_start_ts: start, range_end_ts: start + periodMs });
        }
        return out;
      }

      async function historyServer() {
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
        const client = fakeClient();
        server.handleClientConnected(client);
        server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
        await settle();
        client.sent.length = 0;
        return { server, client };
      }

      describe("cancellable history worker (P7-04)", () => {
        async function offloadServer() {
          const storageReader = fakeVolumeProfileStorageReader();
          storageReader.dbPath = "/tmp/eager-offload-reader.sqlite";
          const { server } = await bootServer({
            storageReader,
            volumeProfileCache: { dbPath: "/tmp/eager-offload-cache.sqlite" },
            tickSizeResolver: fakeTickSizeResolver(),
          });
          const client = fakeClient();
          server.handleClientConnected(client);
          server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
          await settle();
          client.sent.length = 0;
          return { server, client };
        }

        beforeEach(() => {
          mockStartHistoryJob.mockClear();
          mockHistoryJobCancel.mockClear();
        });

        test("offloads a historical request to the bounded worker", async () => {
          const { server, client } = await offloadServer();
          const ranges = alignedRanges(60_000, 1, NOW_MS);

          server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
          await settle();

          expect(mockStartHistoryJob).toHaveBeenCalledTimes(1);
          server.stop();
        });

        test("a replacement request cancels the superseded job", async () => {
          const { server, client } = await offloadServer();
          const ranges = alignedRanges(60_000, 1, NOW_MS);

          server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
          await settle();
          expect(mockHistoryJobCancel).not.toHaveBeenCalled();

          server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
          await settle();

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
          server.stop();
        });

        test("a disconnect cancels that client's in-flight job", async () => {
          const { server, client } = await offloadServer();
          const ranges = alignedRanges(60_000, 1, NOW_MS);

          server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
          await settle();

          server.handleClientDisconnected(client);

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
          server.stop();
        });

        test("shutdown cancels every in-flight job", async () => {
          const { server, client } = await offloadServer();
          const ranges = alignedRanges(60_000, 1, NOW_MS);

          server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
          await settle();

          server.stop();

          expect(mockHistoryJobCancel).toHaveBeenCalledTimes(1);
        });
      });

      test("answers a batched request with one historical frame per requested period", async () => {
        const { server, client } = await historyServer();
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
        await settle();

        const frames = client.sent.filter((f) => f.type === "profile");
        expect(frames).toHaveLength(1);
        expect(frames[0].mode).toBe("continuous");
        expect(frames[0].delivery_scope).toBe("HISTORICAL");
        expect(frames[0].history_request_id).toBe(1);
        expect(frames[0].symbol).toBe("AAPL");
        expect(frames[0].period_start_ts).toBe(ranges[0].range_start_ts);
        expect(frames[0].period_end_ts).toBe(ranges[0].range_end_ts);
        server.stop();
      });

      test("sends only to the requesting client, never broadcast", async () => {
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
        const requester = fakeClient();
        const bystander = fakeClient();
        server.handleClientConnected(requester);
        server.handleClientConnected(bystander);
        server.handleClientMessage(selectMessage("AAPL", "EQUITY"), requester);
        await settle();
        requester.sent.length = 0;
        bystander.sent.length = 0;

        const ranges = alignedRanges(60_000, 1, NOW_MS);
        server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), requester);
        await settle();

        expect(requester.sent.filter((f) => f.type === "profile").length).toBeGreaterThan(0);
        expect(bystander.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test.each([
        ["a range whose length does not match the period", (r, p) => [{ ...r[0], range_end_ts: r[0].range_start_ts + p * 2 }]],
        ["a range not aligned to the period grid", (r) => [{ range_start_ts: r[0].range_start_ts + 1, range_end_ts: r[0].range_end_ts + 1 }]],
        ["an inverted range", (r) => [{ range_start_ts: r[0].range_end_ts, range_end_ts: r[0].range_start_ts }]],
        ["a duplicated range", (r) => [r[0], r[0]]],
        ["a range carrying an unexpected extra field", (r) => [{ ...r[0], extra: 1 }]],
      ])("drops a batch containing %s", async (_label, mutate) => {
        const { server, client } = await historyServer();
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges: mutate(ranges, 60_000) }), client);
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test("drops a batch with more ranges than the server cap", async () => {
        const { server, client } = await historyServer();
        const ranges = alignedRanges(60_000, 200, NOW_MS);

        server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client);
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test("drops a profile_history message carrying unexpected top-level fields", async () => {
        const { server, client } = await historyServer();
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        server.handleClientMessage(
          JSON.stringify({ type: "profile_history", mode: "continuous", request_id: 1, period_ms: 60_000, bin_size_multiplier: null, ranges, rogue: true }),
          client,
        );
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test("an invalid period_ms/bin_size_multiplier is logged and ignored -- never crashes", async () => {
        const { server, client } = await historyServer();
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        expect(() => server.handleClientMessage(profileHistoryWire({ period_ms: 0, ranges }), client)).not.toThrow();
        expect(() => server.handleClientMessage(profileHistoryWire({ period_ms: -1, ranges }), client)).not.toThrow();
        expect(() => server.handleClientMessage(profileHistoryWire({ bin_size_multiplier: -1, ranges }), client)).not.toThrow();
        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test("a batch over a window with no trades sends nothing, never crashes", async () => {
        const storageReader = fakeVolumeProfileStorageReader({ tradeRowsBySymbol: { AAPL: [] } });
        const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10 });
        const client = fakeClient();
        server.handleClientConnected(client);
        server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
        client.sent.length = 0;
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        expect(() => server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client)).not.toThrow();
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });

      test("no instrument ever selected sends nothing, never crashes", async () => {
        const storageReader = fakeVolumeProfileStorageReader();
        const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10_000 });
        const client = fakeClient();
        server.handleClientConnected(client);
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        expect(() => server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client)).not.toThrow();
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });
    });

    // Closure-audit regression. warmUpAllViews() runs exactly once per
    // process (session restarts pass warmUp:false), and warmUpVolumeProfile
    // returns silently when the 15-minute reference lookback is empty. Booting
    // outside market hours -- guaranteed pre-market for the equities -- there-
    // fore left an instrument with no volume profile for the whole process
    // lifetime, with nothing logged. The poll loop must keep retrying.
    test("an instrument with no trades at boot still gets a profile once trades appear, instead of staying dead for the process lifetime", async () => {
      let simulatedNowMs = NOW_MS;
      let tradesExistYet = false;
      const rowsWhenLive = volumeProfileTradeRows();
      const readTradesSince = jest.fn((_symbol, _assetClass, { cursor }) => {
        if (!tradesExistYet) return { rows: [], nextCursor: null, available: true };
        if (cursor !== null) return { rows: [], nextCursor: cursor, available: true };
        return {
          rows: rowsWhenLive,
          nextCursor: { ts: rowsWhenLive[rowsWhenLive.length - 1].event_time, id: rowsWhenLive.length },
          available: true,
        };
      });
      // Honours the same dead-market gate as readTradesSince: with no trades
      // there is no price range either, which is what must keep warm-up from
      // producing a session before the market opens.
      const readPriceRange = jest.fn((_symbol, _assetClass, { fromTs, toTs }) => {
        if (!tradesExistYet) return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
        const inWindow = rowsWhenLive.filter((row) => row.event_time >= fromTs && row.event_time < toTs);
        if (inWindow.length === 0) return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
        return {
          minPrice: Math.min(...inWindow.map((row) => row.price)),
          maxPrice: Math.max(...inWindow.map((row) => row.price)),
          tradeCount: inWindow.length,
          available: true,
        };
      });
      const storageReader = { readTradesSince, readVolumeProfile: jest.fn(() => ({ buckets: [], available: true })), readPriceRange };
      const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), volumeProfilePollMs: 10, now: () => simulatedNowMs });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();

      // Booted into a dead market: nothing to profile yet.
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);

      // Market opens.
      tradesExistYet = true;
      simulatedNowMs += 15_000;
      client.sent.length = 0;
      await settle();

      const frames = client.sent.filter((f) => f.type === "profile");
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].symbol).toBe("AAPL");
      server.stop();
    });
  });
});

describe("createDxFeedEagerMarketDataServer -- vpin wiring (P4.12 Step 4)", () => {
  // Mirrors the lazy module's own regression: ensureVpinWarm's missing-method
  // guard used to broadcast a full snapshot on every poll tick forever,
  // for every eager view, whenever the storage reader lacked
  // readTradesSince/readMinuteRollup -- it returned before ever reaching
  // the per-view vpinWarmupJob/cooldown guard.
  test("a storage reader missing the VPIN read methods does not rebroadcast a snapshot on every poll tick", async () => {
    const storageReader = fakeStorageReader();
    const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10 });
    try {
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "snapshot", vpin_status: "UNAVAILABLE" }));
      client.sent.length = 0;

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.sent.filter((frame) => frame.type === "snapshot")).toHaveLength(0);
    } finally { await server.stop(); }
  });

  test("TT_VPIN_ENABLED=0 (vpinEnabled false) reaches dxFeed too: no VPIN warm-up or live poll, status DISABLED (Block 8 #7)", async () => {
    const storageReader = {
      ...fakeStorageReader(),
      readTradesSince: jest.fn(() => ({ rows: [], nextCursor: null, available: true })),
      readMinuteRollup: jest.fn(() => ({ rows: [], available: true })),
    };
    const vpinWarmup = jest.fn();
    const vpinLivePoll = jest.fn();
    const { server } = await bootServer({
      storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10, vpinEnabled: false, vpinWarmup, vpinLivePoll,
    });
    try {
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(vpinWarmup).not.toHaveBeenCalled();
      expect(vpinLivePoll).not.toHaveBeenCalled();
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "snapshot", vpin_status: "DISABLED" }));
    } finally { await server.stop(); }
  });

  // Every value*size here comfortably clears the 1_000 USD minVBucket floor
  // on its own, so each of these three trades individually seals its own
  // bucket during the backfill replay.
  function vpinTradeRows() {
    return [
      { event_time: NOW_MS - 3_000, provider_trade_id: 1, price: 190, size: 10, aggressor_side: "BUY" },
      { event_time: NOW_MS - 2_000, provider_trade_id: 2, price: 200, size: 10, aggressor_side: "SELL" },
      { event_time: NOW_MS - 1_000, provider_trade_id: 3, price: 210, size: 10, aggressor_side: "BUY" },
    ];
  }

  // Symbol-keyed like the volume profile suite's own fixture, and windowed
  // by fromTs/toTs like a real store would be -- unlike a fake that ignores
  // the window and replays its fixture unconditionally on cursor:null, that
  // matters here: the suite's clock is frozen at NOW_MS, so once backfill
  // resets a session's pollCursor to null and advances pollFromTs to
  // NOW_MS, every live poll re-queries a zero-width [NOW_MS, NOW_MS]
  // window -- an unwindowed fake would re-seal the same backfilled trades
  // on the very next poll tick.
  function fakeVpinStorageReader({ tradeRowsBySymbol = {} } = {}) {
    const readTradesSince = jest.fn((symbol, _assetClass, { fromTs, toTs, cursor }) => {
      const allRows = tradeRowsBySymbol[symbol] ?? vpinTradeRows();
      if (cursor !== null) return { rows: [], nextCursor: cursor, available: true };
      const rows = allRows.filter((row) => row.event_time >= fromTs && row.event_time <= toTs);
      if (rows.length === 0) return { rows: [], nextCursor: null, available: true };
      return { rows, nextCursor: { ts: rows[rows.length - 1].event_time, id: rows.length }, available: true };
    });
    const readMinuteRollup = jest.fn(() => ({ rows: [], available: true }));
    const readVolumeProfile = jest.fn(() => ({ buckets: [], available: true }));
    return { readTradesSince, readMinuteRollup, readVolumeProfile };
  }

  function fakeTickSizeResolver(tickSize = 1) {
    return { getDxFeedTickSize: jest.fn(() => tickSize), getBinanceTickSize: jest.fn() };
  }

  async function settle(ms = 50) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Worker execution is tested independently. This deterministic job
  // preserves the server wiring assertions without doing SQLite work in
  // Jest's main process.
  function fakeVpinWarmup(tradeRowsBySymbol) {
    return ({ symbol, nowMs }) => {
      const rows = tradeRowsBySymbol[symbol] ?? vpinTradeRows();
      const vpinState = createVpinState({ vBucket: 1_000 });
      const history = [];
      for (const row of rows) {
        const results = ingestVpinTrade(vpinState, {
          ts: row.event_time,
          price: row.price,
          size: row.size,
          side: row.aggressor_side === "BUY" ? "buy" : row.aggressor_side === "SELL" ? "sell" : null,
        });
        for (const result of results) history.push({ sealTs: result.sealed.sealTs, ...result.reading });
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

  function fakeVpinLivePoll(tradeRowsBySymbol) {
    return (input) => {
      const vpinState = JSON.parse(JSON.stringify(input.vpinState));
      const rows = input.pollCursor === null
        ? (tradeRowsBySymbol[input.symbol] ?? []).filter((row) => row.event_time >= input.pollFromTs && row.event_time <= input.nowMs)
        : [];
      const readings = [];
      for (const row of rows) {
        const side = row.aggressor_side === "BUY" ? "buy" : row.aggressor_side === "SELL" ? "sell" : null;
        for (const result of ingestVpinTrade(vpinState, { ts: row.event_time, price: row.price, size: row.size, side })) {
          readings.push({ sealTs: result.sealed.sealTs, ...result.reading });
        }
      }
      return {
        promise: Promise.resolve({
          vpinState, pollFromTs: input.pollFromTs,
          pollCursor: rows.length > 0 ? { ts: rows.at(-1).event_time, id: rows.length } : input.pollCursor,
          readings,
        }),
        cancel() {},
      };
    };
  }

  test("stop awaits workers even after their results were published", async () => {
    const storageReader = fakeVpinStorageReader();
    const jobs = [];
    const vpinWarmup = (input) => {
      let finish;
      const closed = new Promise((resolve) => { finish = resolve; });
      const job = { ...fakeVpinWarmup({})(input), closed, finish, cancel: jest.fn(() => closed) };
      jobs.push(job);
      return job;
    };
    const { server } = await bootServer({ storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinWarmup });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();
    expect(jobs.length).toBeGreaterThan(0);
    const stopping = server.stop();
    expect(server.stop()).toBe(stopping);
    let finished = false;
    stopping.then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    for (const job of jobs) expect(job.cancel).toHaveBeenCalledTimes(1);
    expect(() => server.start()).toThrow("previous worker shutdown");
    for (const job of jobs) job.finish();
    await stopping;
    expect(finished).toBe(true);
  });

  test("live VPIN query failure survives selection/reconnect snapshots and recovers per instrument", async () => {
    let unavailable = true;
    const success = fakeVpinLivePoll({});
    const { server } = await bootServer({ storageReader: fakeVpinStorageReader(), tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup({}),
      vpinLivePoll: (input) => unavailable ? { promise: Promise.reject(new Error("database unavailable")), cancel() {} } : success(input),
    });
    try {
      await settle();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "analytics_status", symbol: "AAPL", indicator: "VPIN", status: "UNAVAILABLE" }));
      expect(server.instrumentSnapshot().find((row) => row.symbol === "AAPL").analytics.vpin).toBe("UNAVAILABLE");
      unavailable = false;
      await settle();
      expect(client.sent.filter((frame) => frame.type === "analytics_status" && frame.symbol === "AAPL" && frame.indicator === "VPIN").at(-1).status).toBe("READY");
    } finally { await server.stop(); }
  });

  test("warms VPIN only after selection, and the selected snapshot carries readings", async () => {
    const storageReader = fakeVpinStorageReader();
    const tickSizeResolver = fakeTickSizeResolver();
    const { server } = await bootServer({
      storageReader, tickSizeResolver, vpinPollMs: 10, vpinWarmup: fakeVpinWarmup({}),
    });
    expect(tickSizeResolver.getDxFeedTickSize).not.toHaveBeenCalled();

    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();
    expect(tickSizeResolver.getDxFeedTickSize).toHaveBeenCalled();
    expect(tickSizeResolver.getDxFeedTickSize.mock.calls.every(([, symbol]) => symbol === "AAPL")).toBe(true);

    const [frame] = client.sent.filter((f) => f.type === "snapshot" && f.symbol === "AAPL" && Array.isArray(f.vpin_readings) && f.vpin_readings.length > 0);
    expect(frame).toBeDefined();
    expect(frame.vpin_readings.length).toBe(6);
    expect(frame.vpin_readings[0]).toEqual(expect.objectContaining({
      active: false,
      direction: null,
      strength: 0,
      activated_at_ts: null,
    }));
    server.stop();
  });

  test("never calls the tick-size resolver when storageReader lacks readMinuteRollup -- the vpin-specific calibration requirement", async () => {
    const tickSizeResolver = fakeTickSizeResolver();
    // baseOptions() defaults storageReader to fakeStorageReader(), which
    // implements only readRecent/readRecentCandles/readLargeTrades.
    const { server } = await bootServer({ tickSizeResolver, vpinPollMs: 10 });
    await settle();
    expect(tickSizeResolver.getDxFeedTickSize).not.toHaveBeenCalled();
    server.stop();
  });

  test("switching instruments warms each on demand and never leaks the previous selection's VPIN readings", async () => {
    const aaplRows = vpinTradeRows();
    const tslaRows = [{ event_time: NOW_MS - 3_000, provider_trade_id: 101, price: 400, size: 10, aggressor_side: "SELL" }];
    const storageReader = fakeVpinStorageReader({ tradeRowsBySymbol: { AAPL: aaplRows, TSLA: tslaRows } });
    const { server } = await bootServer({
      storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup({ AAPL: aaplRows, TSLA: tslaRows }),
      vpinLivePoll: fakeVpinLivePoll({ AAPL: aaplRows, TSLA: tslaRows }),
    });
    await settle();
    const client = fakeClient();
    server.handleClientConnected(client);

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();
    const aaplFrame = client.sent.filter((f) => f.type === "snapshot" && f.symbol === "AAPL").at(-1);
    expect(aaplFrame.vpin_readings.length).toBe(6);
    client.sent.length = 0;

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    await settle();
    const tslaFrame = client.sent.filter((f) => f.type === "snapshot" && f.symbol === "TSLA").at(-1);
    expect(tslaFrame.vpin_readings.length).toBe(4);
    server.stop();
  });

  test("a live poll publishes every selected-instrument bucket and never leaks unselected output", async () => {
    const aaplRows = [];
    const tslaRows = [];
    const storageReader = fakeVpinStorageReader({ tradeRowsBySymbol: { AAPL: aaplRows, TSLA: tslaRows } });
    const { server } = await bootServer({
      storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup({ AAPL: aaplRows, TSLA: tslaRows }),
      vpinLivePoll: fakeVpinLivePoll({ AAPL: aaplRows, TSLA: tslaRows }),
    });
    await settle();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    client.sent.length = 0;

    aaplRows.push({ event_time: NOW_MS, provider_trade_id: 4, price: 100, size: 25, aggressor_side: "BUY" });
    tslaRows.push({ event_time: NOW_MS, provider_trade_id: 4, price: 100, size: 25, aggressor_side: "BUY" });
    await settle();

    const frames = client.sent.filter((f) => f.type === "vpin");
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.symbol === "AAPL")).toBe(true);
    server.stop();
  });
});

describe("createDxFeedEagerMarketDataServer -- unattended live session (L1L2-V2-048)", () => {
  // Eager mode deliberately keeps its dxFeed session alive when the last client
  // leaves -- `deactivate()` is a documented no-op. The consequence is that
  // `dev:dxfeed:live` holds a live dxFeed/CME connection with nobody watching
  // and keeps renewing it, against the standing "never left running
  // unattended" constraint. Ending the session is a product decision; making
  // the unattended state loud is not.

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("warns, repeatedly, while a live session is held with zero connected clients", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = await bootServer({ unattendedWarnIntervalMs: 60_000 });
    const client = fakeClient();
    server.handleClientConnected(client);

    await jest.advanceTimersByTimeAsync(180_000);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("zero connected clients"), expect.anything(),
    );

    server.handleClientDisconnected(client);
    await jest.advanceTimersByTimeAsync(180_000);

    const unattended = warnSpy.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("zero connected clients"));
    expect(unattended.length).toBeGreaterThanOrEqual(2);
    expect(unattended[0][1]).toMatchObject({ unattendedForMs: expect.any(Number) });
    server.stop();
  });

  it("stops warning as soon as somebody reconnects", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = await bootServer({ unattendedWarnIntervalMs: 60_000 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientDisconnected(client);
    await jest.advanceTimersByTimeAsync(120_000);
    const before = warnSpy.mock.calls.filter(([m]) => typeof m === "string" && m.includes("zero connected clients")).length;
    expect(before).toBeGreaterThan(0);

    server.handleClientConnected(fakeClient());
    await jest.advanceTimersByTimeAsync(600_000);

    const after = warnSpy.mock.calls.filter(([m]) => typeof m === "string" && m.includes("zero connected clients")).length;
    expect(after).toBe(before);
    server.stop();
  });

  it("stops warning once the server itself stops -- no timer outlives the process it describes", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = await bootServer({ unattendedWarnIntervalMs: 60_000 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientDisconnected(client);
    await jest.advanceTimersByTimeAsync(120_000);
    const before = warnSpy.mock.calls.filter(([m]) => typeof m === "string" && m.includes("zero connected clients")).length;

    server.stop();
    await jest.advanceTimersByTimeAsync(600_000);

    const after = warnSpy.mock.calls.filter(([m]) => typeof m === "string" && m.includes("zero connected clients")).length;
    expect(after).toBe(before);
  });

  it("can be disabled outright by passing a non-positive interval", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = await bootServer({ unattendedWarnIntervalMs: 0 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientDisconnected(client);
    await jest.advanceTimersByTimeAsync(600_000);

    expect(warnSpy.mock.calls.filter(([m]) => typeof m === "string" && m.includes("zero connected clients"))).toHaveLength(0);
    server.stop();
  });
});

// A2.21 pass-2 closure audit, Pattern V. The eager server had ZERO
// selection-rate-limit coverage while its lazy sibling had two tests -- the
// same asymmetry that let L1L2-V2-044/045 ship (one defect, three copies,
// every suite green). Extracting the limiter into
// market-data-server-shared.js made the gap visible: mutating the shared cap
// broke the lazy and Binance suites and left eager untouched.
//
// This matters more than on lazy: `npm run dev:dxfeed:live` runs the EAGER
// server, so this is the rate limiter that actually protects a live session.
describe("createDxFeedEagerMarketDataServer -- selection rate limiting", () => {
  test("closes a client that exceeds the pair-selection rate limit", async () => {
    const { server } = await bootServer({});
    const client = fakeClient();
    server.handleClientConnected(client);

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(client.close).toHaveBeenCalledWith(1008, "Too many pair selection requests");
    server.stop();
  });

  test("rate-limits each client independently, so one noisy tab cannot close another", async () => {
    const { server } = await bootServer({});
    const noisy = fakeClient();
    const quiet = fakeClient();
    server.handleClientConnected(noisy);
    server.handleClientConnected(quiet);

    for (let i = 0; i < 3; i += 1) {
      server.handleClientMessage(selectMessage(i % 2 ? "TSLA" : "AAPL", "EQUITY"), noisy);
    }
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), quiet);

    expect(noisy.close).toHaveBeenCalledWith(1008, "Too many pair selection requests");
    expect(quiet.close).not.toHaveBeenCalled();
    server.stop();
  });
});

 test("bar capacity failure stops publication through the rest of the current batch", async () => {
   const { createDxFeedBarAggregator } = require("../../src/providers/dxfeed/dxfeed-bar-aggregator");
   const createBarAggregator = () => createDxFeedBarAggregator({ maxTradesPerBar: 1 });
   const { server, connection } = await bootServer({ createBarAggregator });
   const client = fakeClient();
   server.handleClientConnected(client);
   server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

   client.sent.length = 0;
   mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [1, 2, 3].map((i) => ({ ...AAPL_TIMEANDSALE_ITEM, index: i, sequence: i })) });
   expect(server.isActive()).toBe(false);
   expect(client.sent.filter((frame) => frame.type === "trade")).toHaveLength(1);
   expect(client.sent.filter((frame) => frame.type === "health").at(-1)).toMatchObject({ recoveryState: "UNAVAILABLE", reason: "DXFEED_BAR_CAPACITY_EXCEEDED" });
   await server.stop();
 });

describe("aggressive_history lifecycle wiring", () => {
  const flushHistory = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const historyWire = (requestId) => JSON.stringify({ type: "aggressive_history", request_id: requestId, from_ts: NOW_MS - 60_000, to_ts: NOW_MS, min_size: 0 });

  async function selectedClient(readAggressivePrintsAsync) {
    const storageReader = { ...fakeStorageReader(), readAggressivePrintsAsync };
    const { server } = await bootServer({ storageReader, aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await flushHistory();
    client.sent.length = 0;
    return { server, client };
  }

  test("a request is answered through the server with the reason field on the wire", async () => {
    const readAggressivePrintsAsync = jest.fn(() => Promise.resolve({ rows: [], available: true }));
    const { server, client } = await selectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    await flushHistory();
    expect(client.sent.filter((frame) => frame.type === "aggressive_history")).toEqual([
      expect.objectContaining({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", request_id: 1, complete: true, reason: null, trades: [] }),
    ]);
    await server.stop();
  });

  test("a client that disconnects with a read in flight and one waiting gets nothing, and the waiting one never starts", async () => {
    let resolveRead;
    const readAggressivePrintsAsync = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { server, client } = await selectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    server.handleClientMessage(historyWire(2), client);
    await flushHistory();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    server.handleClientDisconnected(client);
    resolveRead({ rows: [], available: true });
    await flushHistory();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(client.sent.filter((frame) => frame.type === "aggressive_history")).toEqual([]);
    await server.stop();
  });

  test("stop() disposes the history handler: a waiting request never starts and nothing is sent afterwards", async () => {
    let resolveRead;
    const readAggressivePrintsAsync = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { server, client } = await selectedClient(readAggressivePrintsAsync);
    server.handleClientMessage(historyWire(1), client);
    server.handleClientMessage(historyWire(2), client);
    await flushHistory();
    const stopping = server.stop();
    resolveRead({ rows: [], available: true });
    await flushHistory();
    await stopping;
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(client.sent.filter((frame) => frame.type === "aggressive_history")).toEqual([]);
  });
});

describe("delta_profile lifecycle wiring", () => {
  const flushProfile = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const profileWire = (requestId) => JSON.stringify({ type: "delta_profile", request_id: requestId, from_ts: NOW_MS - 60_000, to_ts: NOW_MS, row_width: 0.25 });

  async function selectedClient(readVolumeProfileAsync) {
    const storageReader = { ...fakeStorageReader(), readVolumeProfileAsync };
    const { server } = await bootServer({ storageReader, aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await flushProfile();
    client.sent.length = 0;
    return { server, client };
  }

  test("a request is answered through the server with the selected instrument's identity and the rows on the wire", async () => {
    const readVolumeProfileAsync = jest.fn(() => Promise.resolve({ buckets: [{ bucket: 100_000, volume: 3, buyVolume: 2, sellVolume: 1, tradeCount: 2 }], available: true }));
    const { server, client } = await selectedClient(readVolumeProfileAsync);
    server.handleClientMessage(profileWire(1), client);
    await flushProfile();
    expect(readVolumeProfileAsync).toHaveBeenCalledWith("/NQZ26:XCME", "FUTURE", expect.objectContaining({ originPrice: 0, rowWidth: 0.25 }), { signal: expect.any(AbortSignal) });
    expect(client.sent.filter((frame) => frame.type === "delta_profile")).toEqual([
      expect.objectContaining({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", request_id: 1, complete: true, reason: null, pending: 0, rows: [[25_000, 2, 1]] }),
    ]);
    await server.stop();
  });

  test("a client that disconnects with a read in flight gets nothing; stop() disposes the handler so nothing is sent afterwards", async () => {
    let resolveRead;
    const readVolumeProfileAsync = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { server, client } = await selectedClient(readVolumeProfileAsync);
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

describe("paced heatmap replay", () => {
  function fakeLiquidityPublisher(frames = []) {
    return {
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
      snapshotFrames: jest.fn(() => frames),
      stats: jest.fn(() => ({})),
    };
  }

  function liquidityFrames(count, symbol = "/NQZ26:XCME") {
    return Array.from({ length: count }, (_unused, i) => ({
      type: "liquidity", provider: "DXFEED", symbol, assetClass: "FUTURE",
      seq: i + 1, reset: i === 0, columns: [],
    }));
  }

  const drainMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 40));

  test("a heatmap replay on connect is delivered across event-loop turns, and a live frame during it lands last, in order", async () => {
    const replay = liquidityFrames(10);
    const liquidity = fakeLiquidityPublisher(replay);
    const { server } = await bootServer({ liquidity });
    const publish = liquidity.start.mock.calls[0][0].publish;
    const pilot = fakeClient();
    server.handleClientConnected(pilot);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), pilot);
    await drainMacrotasks();
    server.handleClientDisconnected(pilot);
    const client = fakeClient();
    server.handleClientConnected(client);
    const sentInFirstTurn = client.sent.filter((f) => f.type === "liquidity").length;
    expect(sentInFirstTurn).toBeGreaterThan(0);
    expect(sentInFirstTurn).toBeLessThan(replay.length);
    const live = { ...replay[0], seq: 11, reset: false };
    publish(live);
    await drainMacrotasks();
    expect(client.sent.filter((f) => f.type === "liquidity")).toEqual([...replay, live]);
    expect(client.close).not.toHaveBeenCalled();
    await server.stop();
  });

  test("P4c: a backfill announce waits for a slow client's buffer and is paced through it, never pushed whole", async () => {
    const liquidity = fakeLiquidityPublisher([]);
    const { server } = await bootServer({ liquidity });
    const { publishSnapshot } = liquidity.start.mock.calls[0][0];
    expect(typeof publishSnapshot).toBe("function");
    const slow = fakeClient();
    server.handleClientConnected(slow);
    await drainMacrotasks();
    slow.bufferedAmount = 8 * 1024 * 1024;
    slow.sent.length = 0;
    publishSnapshot(liquidityFrames(20));
    await drainMacrotasks();
    expect(slow.sent.filter((f) => f.type === "liquidity")).toEqual([]);
    slow.bufferedAmount = 0;
    const deadline = Date.now() + 5_000;
    while (slow.sent.filter((f) => f.type === "liquidity").length < 20 && Date.now() < deadline) await drainMacrotasks();
    expect(slow.sent.filter((f) => f.type === "liquidity").map((f) => f.seq)).toEqual(Array.from({ length: 20 }, (_unused, i) => i + 1));
    expect(slow.close).not.toHaveBeenCalled();
    await server.stop();
  });

  function l2Snapshot() {
    return {
      ts: 4_000, rowWidth: 0.25, segment: { id: "FUTURE:/NQZ26:XCME:1000:LIVE", state: "LIVE" }, view: [],
      walls: { seq: 1, reset: true, walls: [], removed: [] },
      events: { seq: 0, reset: true, events: [], missed: 0 },
      ladder: { depth: 50, bids: [[20_000, 3]], asks: [[20_000.25, 1]] },
    };
  }

  function l2Output() {
    return {
      ts: 5_000, rowWidth: 0.25, fresh: false, segment: { id: "FUTURE:/NQZ26:XCME:1000:LIVE", state: "LIVE" },
      view: [], viewReset: false, walls: null,
      events: { seq: 1, events: [{ event: "trade", ts: 4_500, side: "ask", aggressor: "buy", mode: "swept", price: 20_000.25, size: 2, late: false }], missed: 0 },
      ladder: { depth: 50, bids: [[20_000, 4]], asks: [[20_000.25, 1]] },
    };
  }

  const l2Kinds = (client) => client.sent.filter((frame) => frame.type.startsWith("l2_")).map((frame) => [frame.type, frame.reset ?? null]);

  test("P4a: on dxFeed the L2 frames reach only a client that declared them, with dxFeed identity", async () => {
    const liquidity = { ...fakeLiquidityPublisher([]), l2Snapshot: jest.fn(() => l2Snapshot()) };
    const { server } = await bootServer({ liquidity });
    const pilot = fakeClient();
    server.handleClientConnected(pilot);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), pilot);
    await drainMacrotasks();
    const oldClient = fakeClient();
    const newClient = fakeClient();
    server.handleClientConnected(oldClient);
    server.handleClientConnected(newClient);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_events: true, l2_ladder: true }), newClient);
    await drainMacrotasks();
    expect(l2Kinds(newClient)).toEqual([["l2_events", true], ["l2_ladder", null]]);
    expect(newClient.sent.find((frame) => frame.type === "l2_ladder").bids).toEqual([[20_000, 3]]);
    liquidity.start.mock.calls[0][0].publishL2(l2Output(), { marketKind: "FUTURE", symbol: "/NQZ26:XCME" });
    await drainMacrotasks();
    expect(l2Kinds(newClient)).toEqual([["l2_events", true], ["l2_ladder", null], ["l2_events", false], ["l2_ladder", null]]);
    expect(newClient.sent.filter((frame) => frame.type === "l2_ladder").at(-1)).toMatchObject({ provider: "DXFEED", assetClass: "FUTURE", bids: [[20_000, 4]] });
    expect(l2Kinds(oldClient)).toEqual([]);
    expect(l2Kinds(pilot)).toEqual([]);
    await server.stop();
  });

  test("P4a: dxFeed refuses marker_history in a capability set and malformed L2 requests", async () => {
    const liquidity = { ...fakeLiquidityPublisher([]), l2Snapshot: jest.fn(() => l2Snapshot()) };
    const { server } = await bootServer({ liquidity });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    server.handleClientMessage(JSON.stringify({ type: "capabilities", marker_history: true, l2_events: true }), client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_events: 1 }), client);
    server.handleClientMessage(JSON.stringify({ type: "l2_resync", channel: "liquidity" }), client);
    await drainMacrotasks();
    expect(l2Kinds(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_events: true }), client);
    await drainMacrotasks();
    server.handleClientMessage(JSON.stringify({ type: "l2_resync", channel: "l2_events" }), client);
    await drainMacrotasks();
    expect(l2Kinds(client)).toEqual([["l2_events", true], ["l2_events", true]]);
    await server.stop();
  });

  test("disconnecting mid-replay stops the pacer with no further frames", async () => {
    const liquidity = fakeLiquidityPublisher(liquidityFrames(40));
    const { server } = await bootServer({ liquidity });
    const pilot = fakeClient();
    server.handleClientConnected(pilot);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), pilot);
    await drainMacrotasks();
    server.handleClientDisconnected(pilot);
    const client = fakeClient();
    server.handleClientConnected(client);
    const before = client.sent.filter((f) => f.type === "liquidity").length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(40);
    server.handleClientDisconnected(client);
    await drainMacrotasks();
    expect(client.sent.filter((f) => f.type === "liquidity").length).toBe(before);
    await server.stop();
  });

  test("a liquidity_resync replays the heatmap to just that client, and a repeat inside the interval is ignored", async () => {
    const replay = liquidityFrames(2);
    const liquidity = fakeLiquidityPublisher(replay);
    const { server } = await bootServer({ liquidity });
    const pilot = fakeClient();
    server.handleClientConnected(pilot);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), pilot);
    await drainMacrotasks();
    server.handleClientDisconnected(pilot);
    const clientA = fakeClient();
    const clientB = fakeClient();
    server.handleClientConnected(clientA);
    server.handleClientConnected(clientB);
    await drainMacrotasks();
    const countA = () => clientA.sent.filter((f) => f.type === "liquidity").length;
    const countB = () => clientB.sent.filter((f) => f.type === "liquidity").length;
    expect(countA()).toBe(2);
    server.handleClientMessage(JSON.stringify({ type: "liquidity_resync" }), clientA);
    await drainMacrotasks();
    expect(countA()).toBe(4);
    expect(countB()).toBe(2);
    server.handleClientMessage(JSON.stringify({ type: "liquidity_resync" }), clientA);
    await drainMacrotasks();
    expect(countA()).toBe(4);
    server.handleClientMessage(JSON.stringify({ type: "liquidity_resync", extra: 1 }), clientB);
    await drainMacrotasks();
    expect(countB()).toBe(2);
    await server.stop();
  });

  test("an instrument switch replays the new instrument's heatmap paced to every client", async () => {
    const replay = liquidityFrames(12, "/ESZ26:XCME");
    const liquidity = fakeLiquidityPublisher(replay);
    const { server } = await bootServer({ liquidity });
    const clientA = fakeClient();
    const clientB = fakeClient();
    server.handleClientConnected(clientA);
    server.handleClientConnected(clientB);
    await drainMacrotasks();
    const markA = clientA.sent.length;
    const markB = clientB.sent.length;
    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), clientA);
    const firstTurnA = clientA.sent.slice(markA).filter((f) => f.type === "liquidity").length;
    expect(firstTurnA).toBeGreaterThan(0);
    expect(firstTurnA).toBeLessThan(replay.length);
    for (let attempt = 0; attempt < 50 && (
      clientA.sent.slice(markA).filter((f) => f.type === "liquidity").length < replay.length ||
      clientB.sent.slice(markB).filter((f) => f.type === "liquidity").length < replay.length
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(clientA.sent.slice(markA).filter((f) => f.type === "liquidity")).toEqual(replay);
    expect(clientB.sent.slice(markB).filter((f) => f.type === "liquidity")).toEqual(replay);
    await server.stop();
  });
});

describe("aggressive-print pool", () => {
  test("warms the selected instrument's pool newest stretch first, then at its floor", async () => {
    const reads = [];
    const readAggressivePrintsAsync = jest.fn((symbol, assetClass, { fromMs, toMs, minSize }) => {
      reads.push({ symbol, assetClass, fromMs, toMs, minSize });
      const row = (i, size, ts) => ({
        id: 1_000 + reads.length * 1_000 + i, symbol, asset_class: assetClass, event_time: ts, price: 29_100, size,
        time: ts, time_nano_part: 0, sequence: i, aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
      });
      const rows = minSize === 0
        ? Array.from({ length: 300 }, (_unused, i) => row(i, ((i * 7) % 10) + 1, toMs - 1_000 - i))
        : [row(1, 50, fromMs + 10)];
      return Promise.resolve({ rows, available: true });
    });
    const storageReader = { ...fakeStorageReader(), readAggressivePrintsAsync };
    const { server } = await bootServer({ storageReader });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    const nqReads = reads.filter((read) => read.symbol === "/NQZ26:XCME");
    expect(nqReads.map((read) => read.minSize > 0)).toEqual([false, true, true, true, true]);
    const snapshot = [...client.sent].reverse().find((frame) => frame.type === "snapshot" && frame.symbol === "/NQZ26:XCME");
    expect(snapshot.aggressive_prints_floor).toBeGreaterThan(0);
    expect(snapshot.aggressive_prints.every((print) => print.size >= snapshot.aggressive_prints_floor && print.assetClass === "FUTURE" && print.symbol === "/NQZ26:XCME")).toBe(true);
    expect(snapshot.aggressive_prints.filter((print) => print.size === 50)).toHaveLength(4);
    await server.stop();
  });
});

describe("band_history lifecycle wiring", () => {
  const flushHistory = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const bandWire = (requestId) => JSON.stringify({ type: "band_history", request_id: requestId, from_ts: NOW_MS - 60_000, to_ts: NOW_MS, price_lo: 29_100, price_hi: 29_110, column_ms: 10_000 });

  test("a request on the selected instrument is answered through the server with the reason on the wire, and stop() disposes the handler", async () => {
    const readBandHistory = jest.fn(() => Promise.resolve({ available: true, columns: [], reason: null }));
    const storageReader = { ...fakeStorageReader(), readBandHistory };
    const { server } = await bootServer({ storageReader, aggressivePoolWarmup: false });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await flushHistory();
    client.sent.length = 0;
    server.handleClientMessage(bandWire(1), client);
    await flushHistory();
    const replies = client.sent.filter((frame) => frame.type === "band_history");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", request_id: 1, complete: false, columns: [] });
    expect(["GEOMETRY_UNAVAILABLE", "STORAGE_UNAVAILABLE"]).toContain(replies[0].reason);
    await server.stop();
    client.sent.length = 0;
    server.handleClientMessage(bandWire(2), client);
    await flushHistory();
    expect(client.sent.filter((frame) => frame.type === "band_history")).toEqual([]);
  });
});

// Report 57 W2, FA-9: a session that starts mid-minute used to build that
// minute's bar from the prints it saw after starting, and show it as a
// normal bar. On real AAPL data the first live minute after a restart was
// missing 31 to 47 % of its volume. The open minute is now seeded from the
// collector's stored prints at session start, and a print that arrives both
// ways is counted once.
describe("createDxFeedEagerMarketDataServer -- open minute seeded at session start (FA-9)", () => {
  const storedPrint = (offsetMs, size, sequence) => ({
    id: sequence, symbol: "AAPL", asset_class: "EQUITY", event_kind: "NEW", event_time: NOW_MS + offsetMs, time: NOW_MS + offsetMs,
    time_nano_part: 0, sequence, price: 230, size, aggressor_side: "BUY", spread_leg: 0, valid_tick: 1,
  });

  test("does not close a partial first minute while its stored seed is still reading", async () => {
    let resolveRead;
    const readTradesSince = jest.fn((symbol) => symbol === "AAPL"
      ? new Promise((resolve) => { resolveRead = resolve; })
      : Promise.resolve({ rows: [], nextCursor: null, available: true }));
    const { connection, server } = await bootServer({ storageReader: { ...fakeStorageReader(), readTradesSince }, now: () => NOW_MS + 30_000 });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 30_000, timeNanoPart: 0, sequence: 3, size: 5 },
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, timeNanoPart: 0, sequence: 4, size: 6 },
    ] });
    resolveRead({ rows: [storedPrint(5_000, 10, 1), storedPrint(10_000, 20, 2)], nextCursor: null, available: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.symbol === "AAPL" && frame.closed && frame.ts_open === NOW_MS).at(-1))
      .toMatchObject({ volume: 35, trade_count: 3 });
    await server.stop();
  });

  test("a slow equity seed does not delay another instrument's live bars", async () => {
    let resolveAapl;
    const readTradesSince = jest.fn((symbol) => symbol === "AAPL"
      ? new Promise((resolve) => { resolveAapl = resolve; })
      : Promise.resolve({ rows: [], nextCursor: null, available: true }));
    const { connection, server } = await bootServer({ storageReader: { ...fakeStorageReader(), readTradesSince }, now: () => NOW_MS + 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [
      { ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 30_000, timeNanoPart: 0, sequence: 801, size: 1 },
      { ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, timeNanoPart: 0, sequence: 802, size: 2 },
    ] });
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.symbol === "/NQZ26:XCME" && frame.closed && frame.ts_open === NOW_MS).at(-1))
      .toMatchObject({ volume: 1, trade_count: 1 });
    resolveAapl({ rows: [], nextCursor: null, available: true });
    await server.stop();
  });

  test("the first live bar after a start includes the minute's stored prints, each counted once", async () => {
    const readTradesSince = jest.fn(async (symbol, _assetClass, { fromTs }) => {
      expect(fromTs).toBe(NOW_MS);
      return { rows: symbol === "AAPL" ? [storedPrint(5_000, 10, 1), storedPrint(10_000, 20, 2)] : [], nextCursor: null, available: true };
    });
    const { connection, server } = await bootServer({ storageReader: { ...fakeStorageReader(), readTradesSince }, now: () => NOW_MS + 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 10_000, timeNanoPart: 0, sequence: 2, size: 20 },
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 20_000, timeNanoPart: 0, sequence: 3, size: 5 },
    ] });

    expect(readTradesSince).toHaveBeenCalled();
    const bars = client.sent.filter((frame) => frame.type === "bar" && frame.symbol === "AAPL");
    expect(bars.at(-1)).toMatchObject({ ts_open: NOW_MS, volume: 35, trade_count: 3 });
    await server.stop();
  });

  test("a reader without the trades-since read, or a failed read, leaves live bars working", async () => {
    const readTradesSince = jest.fn(async () => ({ rows: [], nextCursor: null, available: false }));
    const { connection, server } = await bootServer({ storageReader: { ...fakeStorageReader(), readTradesSince }, now: () => NOW_MS + 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    mainChannel(connection).emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 20_000, timeNanoPart: 0, sequence: 3, size: 5 }] });
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.symbol === "AAPL").at(-1)).toMatchObject({ volume: 5, trade_count: 1 });
    await server.stop();
  });
});

describe("createDxFeedEagerMarketDataServer -- Iceberg Detector channel", () => {
  const SNAPSHOT_BEGIN_END = 12;
  const drainMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 40));
  let savedHistoryFlag;
  beforeAll(() => {
    savedHistoryFlag = process.env.L2_ICEBERG_HISTORY;
    process.env.L2_ICEBERG_HISTORY = "0";
  });
  afterAll(() => {
    if (savedHistoryFlag === undefined) delete process.env.L2_ICEBERG_HISTORY;
    else process.env.L2_ICEBERG_HISTORY = savedHistoryFlag;
  });

  function orderItem(symbol, { index, flags = 0, action, price = 31000, size, side = "BUY" }) {
    return { eventType: "Order", eventSymbol: symbol, eventFlags: flags, index, time: NOW_MS, action, price, size, side, scope: "ORDER", source: "GLBX" };
  }

  function canonicalCapture(options) {
    return {
      createConnector: jest.fn(),
      setChannelId: jest.fn(),
      handleChannelMessage(message) {
        for (const item of message?.data ?? []) {
          if (item?.eventType !== "Order") continue;
          const context = options.resolveOrderContext(item.eventSymbol);
          if (!context) continue;
          options.onEnvelope({
            provider: "DXFEED", eventType: "ORDER", providerSymbol: context.symbol, assetClass: context.assetClass,
            payload: { ...item, index: String(item.index) },
          });
        }
      },
    };
  }

  const icebergPages = (client) => client.sent.filter((frame) => frame.type === "iceberg_orders");
  const capabilities = JSON.stringify({ type: "capabilities", iceberg_orders: true });

  test("a client that declares iceberg_orders gets a reset page, a refilled NQ order reaches it live, a late joiner gets it settled, and other instruments stay out", async () => {
    const { connection, server } = await bootServer({ createOrderV2Capture: canonicalCapture });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(icebergPages(client)).toEqual([]);
    server.handleClientMessage(capabilities, client);
    await drainMacrotasks();
    expect(icebergPages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, icebergs: [], provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" })]);

    const feed = (items) => mainChannel(connection).emitMessage({ type: "FEED_DATA", data: items });
    feed([orderItem("/NQZ26:XCME", { index: 1, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 10 })]);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 3 })]);
    await drainMacrotasks();
    expect(icebergPages(client)).toHaveLength(1);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 10 })]);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: false, seq: 1, icebergs: [expect.objectContaining({ kind: "native", confidence: "certain", origin: "runtime", status: "active", side: "bid", price: 31000, display: 10, tranches: 2, executed: 7 })] });

    feed([orderItem("/ESZ26:XCME", { index: 7, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 5 })]);
    feed([orderItem("/ESZ26:XCME", { index: 7, action: "PARTIAL", size: 1 })]);
    feed([orderItem("/ESZ26:XCME", { index: 7, action: "PARTIAL", size: 5 })]);
    await drainMacrotasks();
    expect(icebergPages(client)).toHaveLength(2);

    feed([orderItem("/NQZ26:XCME", { index: 1, action: "EXECUTE", size: null })]);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1).icebergs[0]).toMatchObject({ status: "filled", executed: 17, tranches: 2 });

    const late = fakeClient();
    server.handleClientConnected(late);
    server.handleClientMessage(capabilities, late);
    await drainMacrotasks();
    expect(icebergPages(late)).toEqual([expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ status: "filled", executed: 17 })] })]);

    const silent = fakeClient();
    server.handleClientConnected(silent);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_ladder: true }), silent);
    await drainMacrotasks();
    expect(icebergPages(silent)).toEqual([]);
    await server.stop();
  });

  test("a pair switch resends the page for the new instrument, carrying what that instrument holds", async () => {
    const { connection, server } = await bootServer({ createOrderV2Capture: canonicalCapture });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    server.handleClientMessage(capabilities, client);
    await drainMacrotasks();
    const feed = (items) => mainChannel(connection).emitMessage({ type: "FEED_DATA", data: items });
    feed([orderItem("/ESZ26:XCME", { index: 7, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 5, side: "SELL", price: 7800 })]);
    feed([orderItem("/ESZ26:XCME", { index: 7, action: "PARTIAL", size: 1, side: "SELL", price: 7800 })]);
    feed([orderItem("/ESZ26:XCME", { index: 7, action: "PARTIAL", size: 5, side: "SELL", price: 7800 })]);
    await drainMacrotasks();
    expect(icebergPages(client)).toHaveLength(1);
    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: true, symbol: "/ESZ26:XCME", icebergs: [expect.objectContaining({ side: "ask", price: 7800, status: "active", executed: 4 })] });
    await server.stop();
  });

  const SNAPSHOT_BEGIN_SNIP = 20;

  function spyIndicator(calls) {
    return (options) => {
      const indicator = createIcebergIndicator(options);
      return {
        ...indicator,
        onNativeUnavailable: (pair, at) => {
          calls.unavailable.push([pair.symbol, at]);
          return indicator.onNativeUnavailable(pair, at);
        },
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
  }

  async function bootWithActiveNqIceberg(overrides = {}) {
    const { connection, server } = await bootServer({ createOrderV2Capture: canonicalCapture, ...overrides });
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    server.handleClientMessage(capabilities, client);
    const feed = (items) => mainChannel(connection).emitMessage({ type: "FEED_DATA", data: items });
    feed([orderItem("/NQZ26:XCME", { index: 1, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 10 })]);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 3 })]);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 10 })]);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1).icebergs).toEqual([expect.objectContaining({ status: "active", executed: 7, tranches: 2 })]);
    return { connection, server, client, feed };
  }

  test("a book the assembler drops ends its open iceberg as interrupted at that moment, and a late joiner sees nothing still active", async () => {
    let clock = NOW_MS;
    const { server, client, feed } = await bootWithActiveNqIceberg({ now: () => clock });
    clock = NOW_MS + 90_000;
    feed([orderItem("/NQZ26:XCME", { index: 2, flags: SNAPSHOT_BEGIN_SNIP, action: "NEW", size: 4 })]);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: false, icebergs: [expect.objectContaining({ status: "interrupted", executed: 7, tranches: 2, updatedAt: NOW_MS + 90_000 })] });

    const late = fakeClient();
    server.handleClientConnected(late);
    server.handleClientMessage(capabilities, late);
    await drainMacrotasks();
    expect(icebergPages(late)).toEqual([expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ status: "interrupted", updatedAt: NOW_MS + 90_000 })] })]);
    await server.stop();
  });

  test("a crossed book keeps its iceberg open through the grace, and the drop when the grace runs out ends it then", async () => {
    let clock = NOW_MS;
    const { server, client, feed } = await bootWithActiveNqIceberg({ now: () => clock });
    const pagesBefore = icebergPages(client).length;
    feed([orderItem("/NQZ26:XCME", { index: 5, action: "NEW", size: 1, side: "SELL", price: 30990 })]);
    await drainMacrotasks();
    expect(client.sent.filter((frame) => frame.type === "book").at(-1)).toMatchObject({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(icebergPages(client)).toHaveLength(pagesBefore);

    clock = NOW_MS + 31_000;
    feed([orderItem("/NQZ26:XCME", { index: 6, action: "NEW", size: 1, side: "SELL", price: 30995 })]);
    await drainMacrotasks();
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: false, icebergs: [expect.objectContaining({ status: "interrupted", updatedAt: NOW_MS + 31_000 })] });
    await server.stop();
  });

  test("a session end ends the open icebergs of every book that was live, stamped when it ended, and tells the tracker nothing about books that never were", async () => {
    let clock = NOW_MS;
    const calls = { unavailable: [], tick: 0, stop: 0 };
    const { connection, server, client } = await bootWithActiveNqIceberg({ now: () => clock, icebergIndicatorFactory: spyIndicator(calls) });
    clock = NOW_MS + 45_000;
    connection.emitError({ type: "AUTH", message: "token refused" });
    await drainMacrotasks();
    expect(server.isActive()).toBe(false);
    expect(icebergPages(client).at(-1)).toMatchObject({ reset: false, icebergs: [expect.objectContaining({ status: "interrupted", updatedAt: NOW_MS + 45_000 })] });
    expect(calls.unavailable).toEqual([["/NQZ26:XCME", NOW_MS + 45_000]]);

    const late = fakeClient();
    server.handleClientConnected(late);
    server.handleClientMessage(capabilities, late);
    await drainMacrotasks();
    expect(icebergPages(late)).toEqual([expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ status: "interrupted" })] })]);
    await server.stop();
  });

  test("stop() ends the open iceberg of every live book as interrupted, stamped at the stop, and saves it: a server restarted on the same store serves it in its reset page", async () => {
    const savedFlag = process.env.L2_ICEBERG_HISTORY;
    process.env.L2_ICEBERG_HISTORY = "1";
    const pairKey = "FUTURE:/NQZ26:XCME";
    dropIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey });
    try {
      let clock = NOW_MS;
      const calls = { unavailable: [], tick: 0, stop: 0 };
      const { server } = await bootWithActiveNqIceberg({ now: () => clock, icebergIndicatorFactory: spyIndicator(calls) });
      clock = NOW_MS + 45_000;
      await server.stop();

      const { server: restarted } = await bootServer({ createOrderV2Capture: canonicalCapture, now: () => clock });
      const client = fakeClient();
      restarted.handleClientConnected(client);
      restarted.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      restarted.handleClientMessage(capabilities, client);
      await drainMacrotasks();
      expect(icebergPages(client)).toEqual([expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ status: "interrupted", executed: 7, tranches: 2, updatedAt: NOW_MS + 45_000 })] })]);
      expect(calls.unavailable).toEqual([["/NQZ26:XCME", NOW_MS + 45_000]]);
      await restarted.stop();
    } finally {
      dropIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey });
      if (savedFlag === undefined) delete process.env.L2_ICEBERG_HISTORY;
      else process.env.L2_ICEBERG_HISTORY = savedFlag;
    }
  });

  test("with the detector off, a dropped book and a session end leave the iceberg tracker alone", async () => {
    const savedFlag = process.env.L2_ICEBERG;
    process.env.L2_ICEBERG = "0";
    try {
      const calls = { unavailable: [], tick: 0, stop: 0 };
      const { connection, server } = await bootServer({ createOrderV2Capture: canonicalCapture, icebergIndicatorFactory: spyIndicator(calls) });
      const feed = (items) => mainChannel(connection).emitMessage({ type: "FEED_DATA", data: items });
      feed([orderItem("/NQZ26:XCME", { index: 1, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 10 })]);
      feed([orderItem("/NQZ26:XCME", { index: 2, flags: SNAPSHOT_BEGIN_SNIP, action: "NEW", size: 4 })]);
      feed([orderItem("/NQZ26:XCME", { index: 1, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 10 })]);
      connection.emitError({ type: "AUTH", message: "token refused" });
      await drainMacrotasks();
      expect(server.isActive()).toBe(false);
      expect(calls.unavailable).toEqual([]);
      await server.stop();
    } finally {
      if (savedFlag === undefined) delete process.env.L2_ICEBERG;
      else process.env.L2_ICEBERG = savedFlag;
    }
  });

  test("a released client is forgotten by the iceberg channel: later increments reach only the clients still connected", async () => {
    const { connection, server } = await bootServer({ createOrderV2Capture: canonicalCapture });
    const leaving = fakeClient();
    const staying = fakeClient();
    for (const client of [leaving, staying]) server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), staying);
    for (const client of [leaving, staying]) server.handleClientMessage(capabilities, client);
    await drainMacrotasks();
    expect(icebergPages(leaving)).toHaveLength(1);

    server.handleClientDisconnected(leaving);
    const feed = (items) => mainChannel(connection).emitMessage({ type: "FEED_DATA", data: items });
    feed([orderItem("/NQZ26:XCME", { index: 1, flags: SNAPSHOT_BEGIN_END, action: "NEW", size: 10 })]);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 3 })]);
    feed([orderItem("/NQZ26:XCME", { index: 1, action: "PARTIAL", size: 10 })]);
    await drainMacrotasks();
    expect(icebergPages(staying).filter((frame) => !frame.reset)).toHaveLength(1);
    expect(icebergPages(leaving)).toHaveLength(1);
    await server.stop();
  });

  test("stop() stops the iceberg indicator once and its tick timer: no tick runs after it", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const calls = { unavailable: [], tick: 0, stop: 0 };
      const { server } = await bootServer({ icebergIndicatorFactory: spyIndicator(calls) });
      await jest.advanceTimersByTimeAsync(2_000);
      const ticksBeforeStop = calls.tick;
      expect(ticksBeforeStop).toBeGreaterThan(0);
      await server.stop();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(calls.tick).toBe(ticksBeforeStop);
      expect(calls.stop).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("stop() forgets every iceberg subscriber: after a restart, a client from before the stop is sent no iceberg page", async () => {
    const { server } = await bootServer();
    const before = fakeClient();
    server.handleClientConnected(before);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), before);
    server.handleClientMessage(capabilities, before);
    await drainMacrotasks();
    expect(icebergPages(before)).toHaveLength(1);

    await server.stop();
    server.start();
    const after = fakeClient();
    server.handleClientConnected(after);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), after);
    server.handleClientMessage(capabilities, after);
    await drainMacrotasks();
    expect(icebergPages(after)).toHaveLength(1);
    expect(icebergPages(before)).toHaveLength(1);
  });

  test("the live reach on every iceberg page is the heatmap's own horizon, whatever its tiers are set to", async () => {
    const { createLiquidityPublisher } = require("../../src/indicators/passive_liquidity/liquidity-publisher");
    for (const tiers of [{}, { deepS: 0 }, { historyS: 600, deepS: 300 }]) {
      const heatmap = createLiquidityPublisher({ memory: { getEngine: () => null }, storeEnabled: false, backfillEnabled: false, ...tiers });
      const { server } = await bootServer({ liquidityOptions: { storeEnabled: false, backfillEnabled: false, ...tiers } });
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      server.handleClientMessage(capabilities, client);
      await drainMacrotasks();
      const [page] = icebergPages(client);
      expect(page.ts - page.liveSince).toBe(heatmap.horizonMs);
      await server.stop();
    }
  });
});

describe("createDxFeedEagerMarketDataServer -- iceberg store", () => {
  test("a server this suite builds reads its iceberg store from the suite's temp dir, never from the runtime's data root", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * 86_400_000 });
    history.record({
      id: "AAPL|seeded", kind: "native", confidence: "certain", side: "bid", price: 230.5, display: 100, tranches: 3, executed: 250,
      startedAt: NOW_MS - 120_000, markedAt: NOW_MS - 110_000, updatedAt: NOW_MS - 60_000, status: "filled", origin: "runtime",
    });
    expect(saveIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey: "EQUITY:AAPL", savedAt: NOW_MS - 60_000, history: history.toJSON(), cuts: null, coverage: [] }).ok).toBe(true);
    const { server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", iceberg_orders: true }), client);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.sent.filter((frame) => frame.type === "iceberg_orders")).toEqual([
      expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ id: "AAPL|seeded", status: "filled" })] }),
    ]);
    await server.stop();
  });
});

describe("createDxFeedEagerMarketDataServer -- Exhaustion channel", () => {
  const exhaustionPages = (client) => client.sent.filter((frame) => frame.type === "exhaustion_shades");
  const drainMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 40));
  function fakeExhaustion() {
    const calls = { start: 0, stop: 0, snapshots: [], requests: [] };
    const factory = () => ({
      start: () => { calls.start += 1; },
      stop: () => { calls.stop += 1; },
      tick: () => [],
      snapshot: (pair, at) => { calls.snapshots.push(pair); return { ts: at, shades: [], liveSince: at - 1000, loading: at - 90_000_000 }; },
      requestHistory: (pair, fromTs) => { calls.requests.push([pair, fromTs]); return true; },
      stats: () => ({}),
      provider: "DXFEED",
    });
    return { factory, calls };
  }

  test("a client that declares exhaustion_shades gets a reset page for the selected instrument, and the indicator is started and stopped with the server", async () => {
    const { factory, calls } = fakeExhaustion();
    const { server } = await bootServer({ exhaustionIndicatorFactory: factory });
    expect(calls.start).toBe(1);
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(exhaustionPages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), client);
    await drainMacrotasks();
    expect(exhaustionPages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, shades: [], provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", loading: expect.any(Number) })]);
    expect(calls.snapshots).toEqual([{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    server.handleClientMessage(JSON.stringify({ type: "exhaustion_history", from_ts: 1_700_000_000_000 }), client);
    for (const bad of [{ type: "exhaustion_history" }, { type: "exhaustion_history", from_ts: "1" }, { type: "exhaustion_history", from_ts: -1 }, { type: "exhaustion_history", from_ts: 1_700_000_000_000, extra: 1 }]) server.handleClientMessage(JSON.stringify(bad), client);
    expect(calls.requests).toEqual([[{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }, 1_700_000_000_000]]);
    expect(warn.mock.calls.filter((call) => /dropped exhaustion_history request with unexpected fields/.test(call[0]))).toHaveLength(4);
    warn.mockRestore();
    server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(exhaustionPages(client)).toHaveLength(1);
    await server.stop();
    expect(calls.stop).toBe(1);
  });

  test("the tick feeds every instrument to the engine and the candle monitor; the monitor's frames reach the clients that declared the flag for the selected instrument, and the monitor is stopped with the server", async () => {
    const ticks = { engine: [], monitor: [] };
    let publish = null;
    const stops = [];
    const { factory } = fakeExhaustion();
    const exhaustionIndicatorFactory = () => ({ ...factory(), tick: (pairs) => { ticks.engine.push(pairs); return []; } });
    const candleMonitorFactory = (options) => { publish = options.publish; return { tick: (pairs) => { ticks.monitor.push(pairs); }, snapshot: () => [], stats: () => ({}), stop: () => { stops.push(1); } }; };
    const { server } = await bootServer({ exhaustionIndicatorFactory, candleMonitorFactory });
    for (let i = 0; i < 100 && ticks.monitor.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks.engine.at(-1)).toEqual(expect.arrayContaining([{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }, { marketKind: "EQUITY", symbol: "AAPL" }]));
    expect(ticks.monitor.at(-1)).toEqual(ticks.engine.at(-1));
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", exhaustion_shades: true }), client);
    await drainMacrotasks();
    const entry = { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: null, biggestSell: { price: 20_100.25, size: 3 } };
    publish([entry], { marketKind: "FUTURE", symbol: "/NQZ26:XCME" }, 1_700_000_300_000);
    publish([entry], { marketKind: "FUTURE", symbol: "/ESZ26:XCME" }, 1_700_000_300_000);
    const frames = client.sent.filter((frame) => frame.type === "candle_monitor");
    expect(frames).toEqual([{ type: "candle_monitor", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 1_700_000_300_000, entries: [entry] }]);
    await server.stop();
    expect(stops).toEqual([1]);
  });
});

describe("createDxFeedEagerMarketDataServer -- Initiative Continuation channel", () => {
  const initiativePages = (client) => client.sent.filter((frame) => frame.type === "initiative_bands");
  const drainMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 40));
  function fakeInitiative() {
    const calls = { start: 0, stop: 0, snapshots: [], requests: [], ticks: [], options: null };
    const factory = (options) => {
      calls.options = options;
      return {
        start: () => { calls.start += 1; },
        stop: () => { calls.stop += 1; },
        tick: (pairs) => { calls.ticks.push(pairs); return []; },
        snapshot: (pair, at) => { calls.snapshots.push(pair); return { ts: at, bands: [], liveSince: at - 1000, loading: at - 90_000_000 }; },
        requestHistory: (pair, fromTs) => { calls.requests.push([pair, fromTs]); return true; },
        stats: () => ({}),
        provider: "DXFEED",
      };
    };
    return { factory, calls };
  }

  test("a client that declares initiative_bands gets a reset page for the selected instrument, asks reach the indicator, the tick feeds every instrument, and the indicator is started and stopped with the server", async () => {
    const { factory, calls } = fakeInitiative();
    const { server } = await bootServer({ initiativeIndicatorFactory: factory });
    expect(calls.start).toBe(1);
    expect(calls.options.provider).toBe("DXFEED");
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(initiativePages(client)).toEqual([]);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", initiative_bands: true }), client);
    await drainMacrotasks();
    expect(initiativePages(client)).toEqual([expect.objectContaining({ reset: true, seq: 0, bands: [], provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", loading: expect.any(Number) })]);
    expect(calls.snapshots).toEqual([{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    server.handleClientMessage(JSON.stringify({ type: "initiative_history", from_ts: 1_700_000_000_000 }), client);
    for (const bad of [{ type: "initiative_history" }, { type: "initiative_history", from_ts: "1" }, { type: "initiative_history", from_ts: -1 }, { type: "initiative_history", from_ts: 1_700_000_000_000, extra: 1 }]) server.handleClientMessage(JSON.stringify(bad), client);
    expect(calls.requests).toEqual([[{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }, 1_700_000_000_000]]);
    expect(warn.mock.calls.filter((call) => /dropped initiative_history request with unexpected fields/.test(call[0]))).toHaveLength(4);
    warn.mockRestore();
    for (let i = 0; i < 100 && calls.ticks.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.ticks.at(-1)).toEqual(expect.arrayContaining([{ marketKind: "FUTURE", symbol: "/NQZ26:XCME" }, { marketKind: "EQUITY", symbol: "AAPL" }]));
    server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), client);
    await drainMacrotasks();
    expect(initiativePages(client)).toHaveLength(1);
    await server.stop();
    expect(calls.stop).toBe(1);
  });
});
