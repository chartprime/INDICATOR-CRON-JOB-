const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const { createVpinState, ingestVpinTrade } = require("../../src/indicators/vpin/vpin-engine");
const { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../../src/indicators/large-trade/large-trade-detection");
const {
  createDxFeedMarketDataServer: createDxFeedMarketDataServerImpl,
  SESSION_ENDED_REASON,
  SESSION_START_FAILED_REASON,
  NOT_CONFIGURED_REASON,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
} = require("../../src/server/dxfeed-market-data-server");

const activeServers = new Set();

function createDxFeedMarketDataServer(options) {
  const server = createDxFeedMarketDataServerImpl(options);
  activeServers.add(server);
  return server;
}

afterEach(() => {
  for (const server of activeServers) server.stop();
  activeServers.clear();
});

function fakeChannel({ id } = {}) {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    id,
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

function fakeConnection({ channel = fakeChannel(), channels } = {}) {
  const listeners = { error: [], connection: [], auth: [] };
  let connectionState = DXLinkConnectionState.CONNECTING;
  let authState = DXLinkAuthState.UNAUTHORIZED;
  const channelQueue = channels ? [...channels] : null;
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    channel,
    getStatus: jest.fn(() => ({ connectionState, authState })),
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => (channelQueue && channelQueue.length > 0 ? channelQueue.shift() : channel)),
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

function fakeStorageReader(rows = [], { candleRows = [], candlesAvailable = true, candlesCoverFullWindow = true, markerRows = [], markersAvailable = true } = {}) {
  return {
    readRecent: jest.fn(() => ({ rows, available: true })),
    readRecentCandles: jest.fn(() => ({ rows: candleRows, available: candlesAvailable, startsAtRequestedWindow: candlesCoverFullWindow })),
    readLargeTrades: jest.fn(() => ({ rows: markerRows, available: markersAvailable })),
  };
}

const NOW_MS = 1_800_025_200_000;
const VALID_EXPIRES_AT = new Date(NOW_MS + 30 * 60_000).toISOString();

function baseOptions(overrides = {}) {
  return {
    brokerUrl: "https://broker.example.ts.net",
    requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT })),
    now: () => NOW_MS,
    // Failure-path tests intentionally inspect a server before stopping it.
    // Keep their background supervisor dormant unless a test opts into a
    // short retry interval explicitly.
    sessionRetryBaseMs: 30_000,
    ...overrides,
  };
}

async function driveToChannelOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

async function waitUntilConnectionCount(connections, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (connections.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntilConnectionCount: never reached ${count} connections`);
}

async function driveToOrderChannelOpened(connection, orderChannel) {
  await driveToChannelOpened(connection);
  await Promise.resolve();
  await Promise.resolve();
  orderChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
  await Promise.resolve();
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

const AAPL_TRADE_ITEM = {
  eventType: "Trade", eventSymbol: "AAPL", time: NOW_MS, timeNanoPart: 0, sequence: 1,
  exchangeCode: "Q", price: 230.5, change: 1.2, size: 10, dayId: 1,
  dayVolume: 1000, dayTurnover: 200000, tickDirection: "UP", extendedTradingHours: false,
};

// Shape matches the real /NQ TimeAndSale sample captured live in
// verify-dxfeed-extended-probe-2026-08-26.log (DX3.05's rescoping evidence).
const NQ_TIMEANDSALE_ITEM = {
  eventType: "TimeAndSale", eventSymbol: "/NQZ26:XCME", eventTime: 0, eventFlags: 0,
  index: 7678176778774447000, time: NOW_MS, timeNanoPart: 0, sequence: 66860,
  exchangeCode: "G", price: 29219, size: 1, bidPrice: 29219, askPrice: 29220,
  tradeThroughExempt: "", aggressorSide: "SELL", spreadLeg: false,
  extendedTradingHours: false, validTick: true, type: "NEW",
};

// Shape matches the real AAPL TimeAndSale sample captured live in the
// equity TimeAndSale probe. validTick:false is the realistic default for
// equities (odd-lot/fractional prints are commonly marked invalid despite
// being genuine executions) -- unlike NQ_TIMEANDSALE_ITEM's validTick:true
// futures default. Using it as the default here means most tests below
// Ordinary bar tests use an exchange-valid print. A dedicated regression test
// below proves that invalid equity prints remain on tape without polluting OHLC.
const AAPL_TIMEANDSALE_ITEM = {
  eventType: "TimeAndSale", eventSymbol: "AAPL", eventTime: 0, eventFlags: 0,
  index: 7679136203203489000, time: NOW_MS, timeNanoPart: 0, sequence: 601002,
  exchangeCode: "Q", price: 230.5, size: 10, bidPrice: 230.4, askPrice: 230.6,
  exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY", spreadLeg: false,
  extendedTradingHours: true, validTick: true, type: "NEW",
};

describe("createDxFeedMarketDataServer -- select validation", () => {
  test("drops a select for an unproven symbol/assetClass pair without ever requesting a token", () => {
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
    server.start();
    server.handleClientMessage(selectMessage("MSFT", "EQUITY"), fakeClient());
    expect(requestToken).not.toHaveBeenCalled();
    expect(server.isActive()).toBe(false);
  });

  test("P4a: accepts an L2 capability set without sending anything or opening a session, and warns on marker_history", () => {
    const requestToken = jest.fn();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
      server.start();
      const client = fakeClient();
      server.handleClientMessage(JSON.stringify({ type: "capabilities", l2_walls: true, l2_ladder: true }), client);
      server.handleClientMessage(JSON.stringify({ type: "capabilities" }), client);
      server.handleClientMessage(JSON.stringify({ type: "l2_resync", channel: "l2_walls" }), client);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      server.handleClientMessage(JSON.stringify({ type: "capabilities", marker_history: true }), client);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(requestToken).not.toHaveBeenCalled();
      expect(client.send).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("drops a select missing a required field", () => {
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
    server.start();
    server.handleClientMessage(JSON.stringify({ type: "select", symbol: "AAPL" }), fakeClient());
    expect(requestToken).not.toHaveBeenCalled();
  });

  test("drops malformed (non-JSON) messages", () => {
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
    server.start();
    expect(() => server.handleClientMessage("not json", fakeClient())).not.toThrow();
    expect(requestToken).not.toHaveBeenCalled();
  });

  test("a repeated select for the already-active symbol is a no-op", async () => {
    const connection = fakeConnection();
    const requestToken = jest.fn(async () => ({ token: "t", expiresAt: VALID_EXPIRES_AT }));
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);
    expect(requestToken).toHaveBeenCalledTimes(1);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    expect(requestToken).toHaveBeenCalledTimes(1);
  });
});

describe("createDxFeedMarketDataServer -- fail-closed startup", () => {
  test("missing broker URL confirms the selected view and reports dxFeed as not configured without requesting a token", () => {
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ brokerUrl: undefined, requestToken }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(requestToken).not.toHaveBeenCalled();
    expect(server.isActive()).toBe(false);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });
    expect(client.sent).toContainEqual(expect.objectContaining({ type: "selection", symbol: "AAPL" }));
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: "health", recoveryState: "UNAVAILABLE", reason: NOT_CONFIGURED_REASON,
    }));
    expect(client.sent).not.toContainEqual(expect.objectContaining({ reason: SESSION_START_FAILED_REASON }));
  });

  test("without a broker the selected instrument keeps its recorded host history: bars arrive and the VPIN warm-up is not cancelled", () => {
    const cancel = jest.fn();
    const vpinWarmup = jest.fn(() => ({ promise: new Promise(() => {}), cancel }));
    const storageReader = {
      ...fakeStorageReader([], {
        candleRows: [{
          ts_open: NOW_MS - 2 * 60_000, provider: "DXFEED", venue: null, asset_class: "EQUITY",
          symbol: "AAPL", open: 100, high: 105, low: 99, close: 104, volume: 10, buy_volume: 6, trade_count: 3,
        }],
      }),
      readTradesSince: jest.fn(() => ({ rows: [], available: true })),
      readMinuteRollup: jest.fn(() => ({ rows: [], available: true })),
      remote: { baseUrl: "http://10.88.0.1:8001/live-storage" },
    };
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ brokerUrl: undefined, requestToken, storageReader, vpinWarmup }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

    expect(requestToken).not.toHaveBeenCalled();
    expect(vpinWarmup).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    const snapshot = client.sent.filter((frame) => frame.type === "snapshot").at(-1);
    expect(snapshot.bars).toHaveLength(1);
    expect(snapshot.vpin_status).toBe("WARMING");
    expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "UNAVAILABLE", reason: NOT_CONFIGURED_REASON }));
  });

  test("a token-fetch failure leaves an unavailable selected view rather than an unconfirmed pending request", async () => {
    const requestToken = jest.fn(async () => {
      throw new Error("broker unreachable");
    });
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.isActive()).toBe(false);
    expect(server.currentRecoveryState()).toBe("UNAVAILABLE");
    expect(client.sent).toContainEqual(expect.objectContaining({ reason: SESSION_START_FAILED_REASON }));
  });

  test("a permanent broker rejection is visible but never turns the selected-symbol relay into a 30-second request loop", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const requestToken = jest.fn(async () => {
        throw tokenBrokerFailure({ retryable: false });
      });
      const server = createDxFeedMarketDataServer(baseOptions({ requestToken, sessionRetryBaseMs: 10 }));
      server.start();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(120_000);

      server.handleClientMessage(JSON.stringify({ ...JSON.parse(selectMessage("AAPL", "EQUITY")), resume: true }), fakeClient());
      await jest.advanceTimersByTimeAsync(120_000);
      expect(requestToken).toHaveBeenCalledTimes(1);
      expect(server.currentRecoveryState()).toBe("UNAVAILABLE");
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("a typed transient broker failure still receives the bounded session retry", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const connections = [];
      const requestToken = jest.fn()
        .mockRejectedValueOnce(tokenBrokerFailure({ retryable: true }))
        .mockResolvedValueOnce({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT });
      const server = createDxFeedMarketDataServer(baseOptions({
        requestToken,
        sessionRetryBaseMs: 10,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10);
      await waitUntilConnectionCount(connections, 1);

      expect(requestToken).toHaveBeenCalledTimes(2);
      server.stop();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("an expiry already past its safe margin refuses to connect", async () => {
    const connection = fakeConnection();
    const almostExpired = new Date(NOW_MS + 60_000).toISOString();
    const requestToken = jest.fn(async () => ({ token: "t", expiresAt: almostExpired }));
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.connect).not.toHaveBeenCalled();
    expect(server.isActive()).toBe(false);
    expect(server.currentRecoveryState()).toBe("UNAVAILABLE");
  });

  test("a partial connection-listener registration failure releases the listener already installed and disconnects", async () => {
    const connection = fakeConnection();
    const unsubscribeError = jest.fn();
    connection.onError = jest.fn(() => unsubscribeError);
    connection.onConnectionStateChange = jest.fn(() => {
      throw new Error("listener setup failed");
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();
    await Promise.resolve();

    expect(unsubscribeError).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(server.isActive()).toBe(false);
    expect(server.currentRecoveryState()).toBe("UNAVAILABLE");
    consoleError.mockRestore();
  });
});

describe("createDxFeedMarketDataServer -- warm-up and live streaming", () => {
  test("futures warm-up reads valid TimeAndSale rows, matching the live tape methodology", async () => {
    const connection = fakeConnection();
    const storedRow = {
      id: 1, event_time: NOW_MS - 1000, symbol: "/NQZ26:XCME", asset_class: "FUTURE",
      price: 29219, size: 50, time: NOW_MS - 1000, time_nano_part: 0, sequence: 66860,
      aggressor_side: "SELL", event_kind: "NEW", valid_tick: 1,
    };
    const storageReader = fakeStorageReader([storedRow]);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();

    expect(storageReader.readRecent).toHaveBeenCalledWith(
      "/NQZ26:XCME", "FUTURE", "TIMEANDSALE", { limit: 100 },
    );
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toEqual([
      expect.objectContaining({ provider: "DXFEED", assetClass: "FUTURE", side: "sell", size: 50 }),
    ]);
  });

  test("broadcasts selection, a warm-up snapshot, and a RECOVERING health frame immediately on select", async () => {
    const connection = fakeConnection();
    const storedRow = {
      id: 1, event_time: NOW_MS - 1000, symbol: "AAPL", asset_class: "EQUITY",
      price: 229, size: 5, time: NOW_MS - 1000, time_nano_part: 0, sequence: 601001,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 0,
    };
    const storageReader = fakeStorageReader([storedRow]);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await Promise.resolve();

    expect(client.sent).toContainEqual(expect.objectContaining({ type: "selection", provider: "DXFEED", symbol: "AAPL" }));
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0].price).toBe(229);
    expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "RECOVERING", stale: true }));
  });

  test("a live TimeAndSale print flips health to READY and broadcasts a real dxfeedTradeFrame, even with validTick:false", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY", stale: false }));
    const tradeFrame = client.sent.find((frame) => frame.type === "trade");
    expect(tradeFrame).toEqual(expect.objectContaining({
      provider: "DXFEED", assetClass: "EQUITY", symbol: "AAPL", price: 230.5, size: 10, side: "buy",
    }));
  });

  test("a client that stays over the outbound buffer budget past the grace window is closed and removed", async () => {
    let nowMs = NOW_MS;
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, now: () => nowMs, clientBufferGraceMs: 10_000,
    }));
    server.start();
    const slowClient = { readyState: 1, bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1, close: jest.fn(), send: jest.fn() };
    const goodClient = fakeClient();
    server.handleClientConnected(slowClient);
    server.handleClientConnected(goodClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), goodClient);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, index: AAPL_TIMEANDSALE_ITEM.index + 1, sequence: AAPL_TIMEANDSALE_ITEM.sequence + 1 }] });
    expect(slowClient.close).not.toHaveBeenCalled();
    expect(slowClient.send.mock.calls.map(([data]) => JSON.parse(data).type)).toEqual(expect.arrayContaining(["trade"]));

    nowMs += 10_000;
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, index: AAPL_TIMEANDSALE_ITEM.index + 2, sequence: AAPL_TIMEANDSALE_ITEM.sequence + 2 }] });
    expect(slowClient.close).toHaveBeenCalledWith(1013, "Client is too slow to receive market data");
    expect(slowClient.send.mock.calls.map(([data]) => JSON.parse(data)).filter((frame) => frame.type === "trade")).toHaveLength(1);
    expect(goodClient.sent).toContainEqual(expect.objectContaining({ type: "trade" }));
  });

  test("during the grace window control and incremental frames remain lossless while bulk history is held back", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, clientBufferGraceMs: 10_000,
    }));
    server.start();
    const slowClient = { readyState: 1, bufferedAmount: MAX_CLIENT_BUFFERED_BYTES + 1, close: jest.fn(), sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
    const goodClient = fakeClient();
    server.handleClientConnected(slowClient);
    server.handleClientConnected(goodClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), goodClient);
    await driveToChannelOpened(connection);

    expect(slowClient.sent).toContainEqual(expect.objectContaining({ type: "selection", symbol: "AAPL" }));
    expect(slowClient.sent.some((frame) => frame.type === "snapshot")).toBe(true);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(slowClient.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(goodClient.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(slowClient.close).not.toHaveBeenCalled();
  });

  test("a client past the hard buffer ceiling is closed immediately, without waiting out the grace window", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, clientBufferGraceMs: 10_000,
    }));
    server.start();
    const runawayClient = { readyState: 1, bufferedAmount: DEFAULT_CLIENT_BUFFER_HARD_BYTES + 1, close: jest.fn(), send: jest.fn() };
    server.handleClientConnected(runawayClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), runawayClient);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(runawayClient.close).toHaveBeenCalledWith(1013, "Client is too slow to receive market data");
    expect(runawayClient.send).not.toHaveBeenCalled();
  });

  test("the main channel subscribes to TimeAndSale only, not Quote -- Order now goes on its own dedicated channel (DX3.07 Phase C)", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);
    const subscribeMessage = connection.channel.sent.find((payload) => payload.type === "FEED_SUBSCRIPTION" && payload.add);
    expect(subscribeMessage.add).toEqual([{ symbol: "AAPL", type: "TimeAndSale" }]);
  });

  test("a Quote event for the same symbol is ignored, not misinterpreted as a Trade", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Quote", eventSymbol: "AAPL", bidPrice: 100, bidSize: 1, bidTime: NOW_MS, bidExchangeCode: "Q", askPrice: 101, askSize: 1, askTime: NOW_MS, askExchangeCode: "Q" }],
    });
    expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
    expect(client.sent.some((frame) => frame.type === "health" && frame.recoveryState === "READY")).toBe(false);
  });

  test("a client connecting mid-session receives the current selection, cached trades, and health state", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);

    expect(lateClient.sent).toContainEqual(expect.objectContaining({ type: "selection", symbol: "AAPL" }));
    const snapshot = lateClient.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toHaveLength(1);
    expect(lateClient.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY" }));
  });

  test("a client connecting after a session ends still receives the selected view, cached snapshot, and UNAVAILABLE health", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);

    expect(lateClient.sent).toContainEqual(expect.objectContaining({ type: "selection", symbol: "AAPL" }));
    expect(lateClient.sent.find((frame) => frame.type === "snapshot").trades).toHaveLength(1);
    expect(lateClient.sent).toContainEqual(expect.objectContaining({
      type: "health", recoveryState: "UNAVAILABLE", reason: SESSION_ENDED_REASON,
    }));
  });

  test("REGRESSION: a live trade replayed within the same open bar is already caught by the bar aggregator's own DUPLICATE_TRADE guard, before rememberTrade is even reached", async () => {
    // Documents why rememberTrade's own dedup can't be exercised through
    // the live-tape path for an immediate replay: dxfeed-bar-aggregator.js
    // already tracks tradeIds per open bucket and drops an exact repeat
    // (dropReason: "DUPLICATE_TRADE") before dxfeed-market-data-server.js
    // ever calls rememberTrade. The real gap rememberTrade's own dedup
    // closes is warm-up reading a genuinely duplicated row back out of
    // storage (dxfeed_time_and_sales has no UNIQUE constraint) -- see the
    // warm-up test below.
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(client.sent.filter((frame) => frame.type === "trade")).toHaveLength(1);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(client.sent.filter((frame) => frame.type === "trade")).toHaveLength(1);

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);
    const snapshot = lateClient.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toHaveLength(1);
  });

  test("REGRESSION: a duplicated row read back from storage during warm-up (dxfeed_time_and_sales has no UNIQUE constraint) is not double-counted or double-sent", async () => {
    const connection = fakeConnection();
    const storedRow = {
      id: 1, event_time: NOW_MS - 1000, symbol: "/NQZ26:XCME", asset_class: "FUTURE",
      price: 29219, size: 50, time: NOW_MS - 1000, time_nano_part: 0, sequence: 66860,
      aggressor_side: "SELL", event_kind: "NEW", valid_tick: 1,
    };
    // Storage has no dedup on insert, so a replayed envelope can genuinely
    // be persisted as two distinct rows sharing the same synthesized
    // trade_id (symbol:time:timeNanoPart:sequence). Without rememberTrade's
    // own dedup, this reaches dxfeedSnapshotFrame's "trades must be
    // pair-matched and unique" invariant and throws.
    const storageReader = fakeStorageReader([storedRow, { ...storedRow, id: 2 }]);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(() => server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client)).not.toThrow();
    await Promise.resolve();

    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toHaveLength(1);
  });

  test("REGRESSION: rememberTrade's dedup Set stays in sync with the 100-trade eviction window -- the oldest trade's id is evicted from both together, not left behind as a phantom", async () => {
    const connection = fakeConnection();
    // 101 distinct rows, newest first (matching real readRecent ordering,
    // which warmUp() reverses to replay oldest-to-newest) -- one more than
    // WARM_UP_TRADE_LIMIT (100), so the oldest (sequence 1) must be evicted.
    const rows = Array.from({ length: 101 }, (_, index) => {
      const sequence = 101 - index;
      return {
        id: sequence, event_time: NOW_MS - 1000, symbol: "/NQZ26:XCME", asset_class: "FUTURE",
        price: 29219, size: 1, time: NOW_MS - 1000, time_nano_part: 0, sequence,
        aggressor_side: "SELL", event_kind: "NEW", valid_tick: 1,
      };
    });
    const storageReader = fakeStorageReader(rows);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();

    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.trades).toHaveLength(100);
    // rememberTrade's eviction reads the trade_id off the exact object
    // shift()'d from recentTrades and deletes that same id from
    // recentTradeIds in one step -- so the oldest (sequence 1) trade_id
    // being genuinely gone from the snapshot is direct proof the Set was
    // pruned in lockstep with the array, not left holding a stale entry.
    expect(snapshot.trades.some((trade) => trade.trade_id.endsWith(":1"))).toBe(false);
  });

  test("a client connecting while idle (no active symbol) receives nothing dxFeed-specific", () => {
    const server = createDxFeedMarketDataServer(baseOptions());
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(client.sent).toHaveLength(0);
  });
});

describe("createDxFeedMarketDataServer -- futures TimeAndSale tape (DX3.05)", () => {
  test("a FUTURE select opens the FEED channel on a STREAM contract and subscribes to TimeAndSale, not Trade/AUTO", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient());
    await driveToChannelOpened(connection);

    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "STREAM" });
    const subscribeMessage = connection.channel.sent.find((payload) => payload.type === "FEED_SUBSCRIPTION" && payload.add);
    expect(subscribeMessage.add).toEqual([{ symbol: "/NQZ26:XCME", type: "TimeAndSale" }]);
  });

  test("an EQUITY select also opens the FEED channel on a STREAM contract and subscribes to TimeAndSale -- same delivery contract as futures", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);

    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "STREAM" });
    const subscribeMessage = connection.channel.sent.find((payload) => payload.type === "FEED_SUBSCRIPTION" && payload.add);
    expect(subscribeMessage.add).toEqual([{ symbol: "AAPL", type: "TimeAndSale" }]);
  });

  test("a live TimeAndSale NEW print broadcasts a trade frame using the real aggressorSide, not a tickDirection guess", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });

    expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY", stale: false }));
    const tradeFrame = client.sent.find((frame) => frame.type === "trade");
    expect(tradeFrame).toEqual(expect.objectContaining({
      provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME", price: 29219, size: 1, side: "sell",
    }));
  });

  test("a TimeAndSale CORRECTION print is ignored, not treated as a new trade", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...NQ_TIMEANDSALE_ITEM, type: "CORRECTION", tradeId: 123 }],
    });

    expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
  });

  test("an UNDEFINED aggressorSide contributes to OHLCV without fabricating a tape side", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...NQ_TIMEANDSALE_ITEM, aggressorSide: "UNDEFINED" }],
    });

    expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: "bar",
      volume: NQ_TIMEANDSALE_ITEM.size,
      trade_count: 1,
      closed: false,
    }));
    const bar = client.sent.find((frame) => frame.type === "bar");
    expect(Object.hasOwn(bar, "buy_volume")).toBe(false);
    expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY" }));
  });

  test("a Trade event for the selected futures symbol is ignored -- the futures path only reads TimeAndSale", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...AAPL_TRADE_ITEM, eventSymbol: "/NQZ26:XCME" }],
    });

    expect(client.sent.some((frame) => frame.type === "trade")).toBe(false);
  });
});

describe("createDxFeedMarketDataServer -- large trade detector (DX3.06)", () => {
  test("a futures print broadcasts its trade frame first, then its marker -- the marker is derived from the trade", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, size: 50 }] });

    const markerFrame = client.sent.find((frame) => frame.type === "marker");
    const tradeFrame = client.sent.find((frame) => frame.type === "trade");
    expect(markerFrame).toEqual(expect.objectContaining({
      provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME", price: 29219, size: 50, side: "sell",
    }));
    expect(client.sent.indexOf(tradeFrame)).toBeLessThan(client.sent.indexOf(markerFrame));
  });

  test("a 1-contract futures print is a candidate like any other -- no floor can starve /NQ, where 96% of prints are 1 contract", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 70_000, size: 1 }] });
    expect(client.sent.some((frame) => frame.type === "marker" && frame.size === 1)).toBe(true);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 70_001, size: 100 }] });
    expect(client.sent.some((frame) => frame.type === "marker" && frame.size === 100)).toBe(true);
    expect(client.sent.some((frame) => frame.type === "trade")).toBe(true);
  });

  test("an equity trade at/above the $50,000 notional threshold broadcasts a marker, even with validTick:false", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, price: 500, size: 100 }] });

    const markerFrame = client.sent.find((frame) => frame.type === "marker");
    expect(markerFrame).toEqual(expect.objectContaining({
      provider: "DXFEED", assetClass: "EQUITY", symbol: "AAPL", price: 500, size: 100, side: "buy",
    }));
  });

  test("a small equity trade is still a candidate -- no dollar floor gates the marker set", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });

    expect(client.sent.some((frame) => frame.type === "marker")).toBe(true);
  });

  test("a client connecting mid-session receives cached markers in its snapshot", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient());
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, size: 50 }] });

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);

    const snapshot = lateClient.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.markers).toHaveLength(1);
    expect(snapshot.markers[0]).toEqual(expect.objectContaining({ symbol: "/NQZ26:XCME", size: 50 }));
  });

  test("an ordinary futures print loses its bucket slot once four larger prints hold it", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    for (let i = 0; i < 24; i += 1) {
      const size = i % 2 === 0 ? 40 : 60;
      connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 70_000 + i, size }] });
    }
    client.sent.length = 0;

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 70_100, size: 52 }] });

    expect(client.sent.some((frame) => frame.type === "marker")).toBe(false);
  });

  test("an outsized futures print always wins its bucket slot, whatever surrounds it", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    for (let i = 0; i < 24; i += 1) {
      const size = i % 2 === 0 ? 40 : 60;
      connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 71_000 + i, size }] });
    }
    client.sent.length = 0;

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, sequence: 71_100, size: 500 }] });

    const marker = client.sent.find((frame) => frame.type === "marker");
    expect(marker).toBeDefined();
    expect(marker.size).toBe(500);
    expect(marker.baseline_log_median).toBeUndefined();
  });

  test("an ordinary equity print loses its bucket slot once four larger prints hold it", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    for (let i = 0; i < 24; i += 1) {
      const price = i % 2 === 0 ? 900 : 1_100;
      connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, sequence: 900_000 + i, price, size: 100 }] });
    }
    client.sent.length = 0;

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, sequence: 900_100, price: 1_050, size: 100 }] });

    expect(client.sent.some((frame) => frame.type === "marker")).toBe(false);
  });
});

describe("createDxFeedMarketDataServer -- candle warm-up and live bars (DX3.12)", () => {
  function candleRow(overrides = {}) {
    return {
      ts_open: NOW_MS - 2 * 60_000, provider: "DXFEED", venue: "XCME", asset_class: "FUTURE",
      symbol: "/NQZ26:XCME", open: 100, high: 105, low: 99, close: 104, volume: 10, buy_volume: 6, trade_count: 3,
      ...overrides,
    };
  }

  test("warm-up seeds recentBars from readRecentCandles and includes them in the snapshot", async () => {
    const connection = fakeConnection();
    const storageReader = fakeStorageReader([], { candleRows: [candleRow()] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();

    expect(storageReader.readRecentCandles).toHaveBeenCalledWith("/NQZ26:XCME", "FUTURE", expect.objectContaining({ windowMs: expect.any(Number), nowMs: NOW_MS }));
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.bars).toHaveLength(1);
    expect(snapshot.bars[0]).toEqual(expect.objectContaining({ open: 100, high: 105, low: 99, close: 104, closed: true }));
  });

  test("presents a gappy/incomplete candle window as warm-up history instead of discarding it -- sandbox backfill doesn't require perfect coverage", async () => {
    const connection = fakeConnection();
    const storageReader = fakeStorageReader([], { candleRows: [candleRow()], candlesCoverFullWindow: false });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();
    expect(client.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(1);
  });

  test("multiple rows with a real gap between them still all reach the snapshot, not just a single row", async () => {
    const connection = fakeConnection();
    const rows = [
      candleRow({ ts_open: NOW_MS - 10 * 60_000 }),
      candleRow({ ts_open: NOW_MS - 2 * 60_000 }),
    ];
    const storageReader = fakeStorageReader([], { candleRows: rows, candlesCoverFullWindow: false });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();
    expect(client.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(2);
  });

  test("a missing storageReader or unavailable candle read does not block session startup", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    expect(() => server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient())).not.toThrow();
  });

  // A remote storage read that times out (or is simply slow) used to leave
  // barHistory stuck at UNAVAILABLE for the rest of the session -- candle
  // warm-up only ever ran once, inside startSession, with no retry. The poll
  // loop must keep retrying it the same way it already retries VPIN.
  test("a candle read that starts out unavailable recovers once the poll loop retries it, without a session restart", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      let candlesAvailable = false;
      const storageReader = fakeStorageReader([], { candleRows: [candleRow()] });
      storageReader.readRecentCandles.mockImplementation(() => ({
        rows: candlesAvailable ? [candleRow()] : [],
        available: candlesAvailable,
        startsAtRequestedWindow: candlesAvailable,
      }));
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader, vpinPollMs: 10 }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await jest.advanceTimersByTimeAsync(1);
      expect(client.sent.find((frame) => frame.type === "snapshot").bars).toEqual([]);

      candlesAvailable = true;
      await jest.advanceTimersByTimeAsync(15_000);

      const newcomer = fakeClient();
      server.handleClientConnected(newcomer);
      expect(newcomer.sent.find((frame) => frame.type === "snapshot").bars).toHaveLength(1);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a candle retry that lands after live bars closed keeps the older stored history in front of them", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      let candlesAvailable = false;
      const stored = [candleRow({ ts_open: NOW_MS - 10 * 60_000 }), candleRow({ ts_open: NOW_MS - 9 * 60_000 })];
      const storageReader = fakeStorageReader([], { candleRows: stored });
      storageReader.readRecentCandles.mockImplementation(() => ({
        rows: candlesAvailable ? stored : [],
        available: candlesAvailable,
        startsAtRequestedWindow: false,
      }));
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader, vpinPollMs: 10 }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);
      for (let minute = 3; minute >= 1; minute -= 1) {
        connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS - minute * 60_000 + 1_000, index: NQ_TIMEANDSALE_ITEM.index + minute, sequence: NQ_TIMEANDSALE_ITEM.sequence + minute }] });
      }

      candlesAvailable = true;
      await jest.advanceTimersByTimeAsync(15_000);

      const newcomer = fakeClient();
      server.handleClientConnected(newcomer);
      const opens = newcomer.sent.find((frame) => frame.type === "snapshot").bars.map((bar) => bar.ts_open);
      expect(opens.slice(0, 2)).toEqual([NOW_MS - 10 * 60_000, NOW_MS - 9 * 60_000]);
      expect(opens.length).toBeGreaterThan(2);
      expect(opens).toEqual([...opens].sort((a, b) => a - b));
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a candle retry is throttled -- it does not re-query on every poll tick while still within its own cooldown", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const storageReader = fakeStorageReader([], { candleRows: [], candlesAvailable: false });
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader, vpinPollMs: 10 }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await jest.advanceTimersByTimeAsync(1);
      const callsAfterFirstAttempt = storageReader.readRecentCandles.mock.calls.length;
      expect(callsAfterFirstAttempt).toBeGreaterThan(0);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(storageReader.readRecentCandles.mock.calls.length).toBe(callsAfterFirstAttempt);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  // barsWarmupInFlight used to be a plain boolean cleared unconditionally in
  // warmUpBars' finally block. A session ending while its own warm-up read
  // was still pending let that orphaned read's own cleanup clobber a newer
  // session's in-flight guard once it finally resolved, breaking the
  // single-flight invariant the guard exists to enforce (mirrors the fix
  // already applied to vpinWarmupJob's identity-safe clear).
  test("an orphaned warm-up read's own cleanup cannot clear a newer session's in-flight guard", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const firstConnection = fakeConnection();
      const secondConnection = fakeConnection();
      const createConnection = jest.fn().mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
      const storageReader = fakeStorageReader([], { candleRows: [candleRow()] });
      const pending = [];
      storageReader.readRecentCandles.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection, storageReader, vpinPollMs: 10 }));
      server.start();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await Promise.resolve();
      expect(pending).toHaveLength(1);

      // Switch symbols: ends the AAPL session (its own read is still
      // pending, orphaned) and starts a fresh TSLA session, firing a second
      // warm-up read while the first is still unresolved.
      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), fakeClient());
      await Promise.resolve();
      expect(pending).toHaveLength(2);

      // TSLA's own read fails, marking its history UNAVAILABLE so the poll
      // loop will retry it -- this is what produces a third, genuinely
      // current in-flight read for the same (TSLA) session.
      pending[1]({ rows: [], available: false, startsAtRequestedWindow: false });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(pending).toHaveLength(3);

      // Only now does the orphaned AAPL read (still pending since the very
      // first assertion) finally resolve -- after TSLA's third read has
      // already legitimately taken ownership of the shared guard.
      pending[0]({ rows: [], available: false, startsAtRequestedWindow: false });
      await Promise.resolve();

      // If the orphaned read's cleanup incorrectly cleared the guard, the
      // next poll tick would start a fourth, overlapping read for TSLA
      // while its third is still genuinely pending.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(pending).toHaveLength(3);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("warm-up seeds recentMarkers from readLargeTrades and includes them in the snapshot -- even a 1-contract futures row, since futures have no server-side floor", async () => {
    const connection = fakeConnection();
    const markerRow = {
      symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
      price: 29100, size: 1, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 7,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    const storageReader = fakeStorageReader([], { markerRows: [{ row: markerRow, baselineSnapshot: null }] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await Promise.resolve();

    expect(storageReader.readLargeTrades).toHaveBeenCalledWith(
      "/NQZ26:XCME", "FUTURE",
      expect.objectContaining({
        nowMs: NOW_MS, limit: 5_000,
        fromMs: NOW_MS - (7 * 24 * 60 * 60 * 1000),
        bucketMs: MARKER_BUCKET_MS,
        perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
      }),
    );
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.markers).toHaveLength(1);
    expect(snapshot.markers[0]).toEqual(expect.objectContaining({ price: 29100, size: 1, side: "buy" }));
  });

  test("asynchronous marker history never delays the initial snapshot, then refreshes only the still-active view", async () => {
    const connection = fakeConnection();
    const markerRow = {
      symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: NOW_MS - 60_000,
      price: 29100, size: 100, time: NOW_MS - 60_000, time_nano_part: 0, sequence: 17,
      aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    let resolveRead;
    const storageReader = {
      ...fakeStorageReader(),
      readLargeTradesAsync: jest.fn(() => new Promise((resolve) => { resolveRead = resolve; })),
    };
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);

    expect(storageReader.readLargeTrades).not.toHaveBeenCalled();
    expect(storageReader.readLargeTradesAsync).toHaveBeenCalledTimes(1);
    expect(client.sent.find((frame) => frame.type === "snapshot").markers).toHaveLength(0);

    resolveRead({ rows: [{ row: markerRow, baselineSnapshot: null }], available: true });
    await Promise.resolve();
    await Promise.resolve();
    const snapshots = client.sent.filter((frame) => frame.type === "snapshot");
    expect(snapshots.at(-1).markers).toEqual([expect.objectContaining({ price: 29100, size: 100, side: "buy" })]);
  });

  test("equity marker warm-up asks storage for a per-bucket top-N slice, not a floor-filtered one", async () => {
    const connection = fakeConnection();
    const storageReader = fakeStorageReader();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();

    expect(storageReader.readLargeTrades).toHaveBeenCalledWith(
      "AAPL", "EQUITY",
      expect.objectContaining({ bucketMs: expect.any(Number), perBucketSideLimit: expect.any(Number) }),
    );
  });

  test("a missing storageReader or unavailable marker read does not block session startup", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    expect(() => server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient())).not.toThrow();
  });

  test("a live trade crossing a minute boundary broadcasts a live bar then a closed bar, in order", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS, price: 100, size: 1 }] });
    const firstBar = client.sent.find((f) => f.type === "bar");
    expect(firstBar).toEqual(expect.objectContaining({ open: 100, close: 100, closed: false }));

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, price: 200, size: 1 }] });
    const barFrames = client.sent.filter((f) => f.type === "bar");
    const closedIndex = barFrames.findIndex((f) => f.closed === true);
    const newLiveIndex = barFrames.findIndex((f) => f.closed === false && f.open === 200);
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(barFrames[closedIndex]).toEqual(expect.objectContaining({ open: 100, close: 100, closed: true }));
    expect(newLiveIndex).toBeGreaterThan(closedIndex);
  });

  test("a client connecting mid-session receives warm-up bars plus any closed-so-far live bars", async () => {
    const connection = fakeConnection();
    const storageReader = fakeStorageReader([], { candleRows: [candleRow({ ts_open: NOW_MS - 5 * 60_000 })] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient());
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS, price: 100 }] });
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, price: 200 }] });

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);
    const snapshot = lateClient.sent.find((f) => f.type === "snapshot");
    expect(snapshot.bars.map((b) => b.open)).toEqual([100, 100]);
    expect(snapshot.bars.every((b) => b.closed === true)).toBe(true);
  });

  test("an out-of-order/duplicate warm-up bar is dropped rather than corrupting recentBars or crashing a later snapshot build", async () => {
    const connection = fakeConnection();
    const storageReader = fakeStorageReader([], {
      candleRows: [
        candleRow({ ts_open: NOW_MS - 2 * 60_000 }),
        candleRow({ ts_open: NOW_MS - 2 * 60_000, open: 200, high: 210, low: 195, close: 205 }),
      ],
    });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient());
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      "dxfeed market data server: dropped an out-of-order closed bar",
      expect.objectContaining({ symbol: "/NQZ26:XCME" }),
    );
    const lateClient = fakeClient();
    expect(() => server.handleClientConnected(lateClient)).not.toThrow();
    const snapshot = lateClient.sent.find((f) => f.type === "snapshot");
    expect(snapshot.bars).toHaveLength(1);
    expect(snapshot.bars[0].open).toBe(100);
    consoleError.mockRestore();
  });

  test("persisted warm-up history seeds the finality watermark, so replayed prints for a stored minute are discarded silently", async () => {
    const connection = fakeConnection();
    const storedMinute = NOW_MS - 60_000;
    const storageReader = fakeStorageReader([], { candleRows: [candleRow({ ts_open: storedMinute })] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: storedMinute + 1_000, sequence: 1 }] });
    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS, sequence: 2 }] });

    expect(consoleError).not.toHaveBeenCalledWith("dxfeed market data server: dropped an out-of-order closed bar", expect.anything());
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed === true && frame.ts_open === storedMinute)).toHaveLength(0);
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed === false && frame.ts_open === NOW_MS)).toHaveLength(1);
    consoleError.mockRestore();
  });

  test("more warm-up candles than MAX_SNAPSHOT_BARS still produce a valid, truncated snapshot", async () => {
    const connection = fakeConnection();
    const rows = Array.from({ length: 10_081 }, (_, i) => candleRow({ ts_open: NOW_MS - (10_081 - i) * 60_000 }));
    const storageReader = fakeStorageReader([], { candleRows: rows });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, storageReader }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    expect(() => server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client)).not.toThrow();
    await Promise.resolve();
    const snapshot = client.sent.find((frame) => frame.type === "snapshot");
    expect(snapshot.bars).toHaveLength(10_080);
    expect(snapshot.bars[0].ts_open).toBe(NOW_MS - 10_080 * 60_000);
    expect(snapshot.bar_history).toEqual(expect.objectContaining({
      coverage: "START_COVERED",
      earliestObservedTsOpen: NOW_MS - 10_080 * 60_000,
    }));
    server.stop();
  });

  test("switching pairs resets the aggregator -- a partial bucket from the old pair never leaks into the new pair's first live bar", async () => {
    const firstConnection = fakeConnection();
    const secondConnection = fakeConnection();
    const createConnection = jest.fn().mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(firstConnection);
    firstConnection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS, price: 500, size: 3 }] });

    server.handleClientMessage(selectMessage("/ESZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(secondConnection);
    secondConnection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, eventSymbol: "/ESZ26:XCME", time: NOW_MS + 10_000, price: 5800, size: 1 }] });

    const liveBars = client.sent.filter((f) => f.type === "bar" && f.symbol === "/ESZ26:XCME");
    expect(liveBars).toHaveLength(1);
    expect(liveBars[0]).toEqual(expect.objectContaining({ open: 5800, trade_count: 1 }));
  });
});

describe("createDxFeedMarketDataServer -- symbol switching and teardown", () => {
  test("deactivate() releases the upstream session while keeping the server restartable", async () => {
    const firstConnection = fakeConnection();
    const secondConnection = fakeConnection();
    const createConnection = jest.fn().mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(firstConnection);

    server.handleClientDisconnected(client);
    server.deactivate();

    expect(firstConnection.disconnect).toHaveBeenCalledTimes(1);
    expect(server.isActive()).toBe(false);
    expect(server.currentSymbolInfo()).toBeNull();

    const nextClient = fakeClient();
    server.handleClientConnected(nextClient);
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), nextClient);
    await driveToChannelOpened(secondConnection);
    expect(server.isActive()).toBe(true);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "TSLA", assetClass: "EQUITY" });
  });

  test("a futures TimeAndSale event marked invalidTick is excluded from tape and bars", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...NQ_TIMEANDSALE_ITEM, validTick: false }] });

    expect(client.sent.some((frame) => frame.type === "trade" || frame.type === "bar")).toBe(false);
  });

  test("an equity TimeAndSale event marked invalidTick stays on tape but is excluded from bars", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, validTick: false }] });

    expect(client.sent.some((frame) => frame.type === "trade")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "bar")).toBe(false);
  });

  // Report 57 W1, O-3 (live only): an auction cross stays on the tape and in
  // the bar, but is flagged on the wire and kept off markers and bubbles.
  test.each([
    ["@  6", true],
    ["@  X", true],
    ["@  o", false],
  ])("an equity print with conditions %j: tape and bar always, auction flag %s, marker only when not an auction", async (exchangeSaleConditions, auction) => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.channel.emitMessage({ type: "FEED_DATA", data: [{ ...AAPL_TIMEANDSALE_ITEM, exchangeSaleConditions }] });

    const trades = client.sent.filter((frame) => frame.type === "trade");
    expect(trades).toHaveLength(1);
    expect(trades[0].auction === true).toBe(auction);
    expect(client.sent.some((frame) => frame.type === "bar")).toBe(true);
    expect(client.sent.some((frame) => frame.type === "marker")).toBe(!auction);
  });

  test("deactivate() cancels an in-flight token request and a late token cannot create a connection", async () => {
    let resolveToken;
    const requestToken = jest.fn(() => new Promise((resolve) => { resolveToken = resolve; }));
    const createConnection = jest.fn(() => fakeConnection());
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();

    server.deactivate();
    resolveToken({ token: "late.token", expiresAt: VALID_EXPIRES_AT });
    await Promise.resolve();
    await Promise.resolve();

    expect(createConnection).not.toHaveBeenCalled();
    expect(server.isActive()).toBe(false);
    expect(server.currentSymbolInfo()).toBeNull();
  });

  test("switching to a different symbol disconnects the old session and starts a fresh one", async () => {
    const firstConnection = fakeConnection();
    const secondConnection = fakeConnection();
    const createConnection = jest.fn().mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(firstConnection);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), fakeClient());
    expect(firstConnection.disconnect).toHaveBeenCalledTimes(1);
    await driveToChannelOpened(secondConnection);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "TSLA", assetClass: "EQUITY" });
  });

  test("a connection drop ends the session and broadcasts an UNAVAILABLE health frame with the session-ended reason", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);

    expect(server.isActive()).toBe(false);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: "health", recoveryState: "UNAVAILABLE", stale: true, reason: SESSION_ENDED_REASON,
    }));
  });

  test("supervises an unexpected main-session drop and reconnects the retained symbol", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connections = [];
      const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
      const server = createDxFeedMarketDataServer(baseOptions({
        requestToken,
        sessionRetryBaseMs: undefined,
        createConnection: () => {
          const connection = fakeConnection();
          connections.push(connection);
          return connection;
        },
      }));
      server.start();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await waitUntilConnectionCount(connections, 1);
      await driveToChannelOpened(connections[0]);

      connections[0].emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
      expect(server.isActive()).toBe(false);
      const pendingClient = fakeClient();
      server.handleClientMessage(JSON.stringify({ ...JSON.parse(selectMessage("AAPL", "EQUITY")), resume: true }), pendingClient);
      expect(pendingClient.sent).toContainEqual(expect.objectContaining({ reason: "DXFEED_RETRY_PENDING" }));
      await jest.advanceTimersByTimeAsync(119_999);
      expect(requestToken).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await waitUntilConnectionCount(connections, 2);
      await driveToChannelOpened(connections[1]);

      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(server.isActive()).toBe(true);
      expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });
      connections[1].emitError(new Error("retry connection failed"));
      await jest.advanceTimersByTimeAsync(240_000);
      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(server.isActive()).toBe(false);
      const resumedClient = fakeClient();
      server.handleClientMessage(JSON.stringify({ ...JSON.parse(selectMessage("AAPL", "EQUITY")), resume: true }), resumedClient);
      expect(requestToken).toHaveBeenCalledTimes(2);
      expect(resumedClient.sent).toContainEqual(expect.objectContaining({ reason: "DXFEED_RETRY_EXHAUSTED" }));
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await waitUntilConnectionCount(connections, 3);
      await server.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("reselecting the retained unavailable symbol starts a fresh session", async () => {
    const firstConnection = fakeConnection();
    const secondConnection = fakeConnection();
    const createConnection = jest.fn().mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
    const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(firstConnection);
    firstConnection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();
    await Promise.resolve();

    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(server.isActive()).toBe(true);
    expect(server.currentRecoveryState()).toBe("RECOVERING");
  });

  test("the 25-minute deadline firing rotates the session, unsubscribing before disconnecting", async () => {
    const connection = fakeConnection();
    const almostDue = new Date(NOW_MS + 5 * 60_000 + 20).toISOString();
    const requestToken = jest.fn().mockResolvedValueOnce({ token: "t", expiresAt: almostDue }).mockResolvedValue({ token: "next", expiresAt: VALID_EXPIRES_AT });
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection: jest.fn().mockReturnValueOnce(connection).mockImplementation(() => fakeConnection()) }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(connection.channel.sent.some((payload) => Array.isArray(payload.remove))).toBe(true);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(client.sent).toContainEqual(expect.objectContaining({ reason: SESSION_ENDED_REASON }));
  });

  test("a channel-close failure during teardown is logged, not silently swallowed", async () => {
    const connection = fakeConnection();
    connection.channel.close = jest.fn(() => {
      throw new Error("channel already gone");
    });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    server.stop();

    expect(consoleError).toHaveBeenCalledWith(
      "dxfeed market data server: channel cleanup step failed",
      expect.objectContaining({ reason: expect.stringContaining("channel already gone") }),
    );
    consoleError.mockRestore();
  });

  test("stop() called mid-handshake (token resolved, still awaiting AUTHORIZED) disconnects cleanly and a late AUTHORIZED event does not resurrect the session", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await Promise.resolve();
    await Promise.resolve();
    expect(server.isActive()).toBe(true);

    server.stop();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(server.isActive()).toBe(false);

    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
    await Promise.resolve();
    await Promise.resolve();

    expect(server.isActive()).toBe(false);
    expect(connection.openChannel).not.toHaveBeenCalled();
  });

  test("stop() ends any active session and clears all clients", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);

    server.stop();

    expect(server.isActive()).toBe(false);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(server.clientCount()).toBe(0);
  });

  test("a select arriving after stop() does not start a new session", () => {
    const requestToken = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken }));
    server.start();
    server.stop();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    expect(requestToken).not.toHaveBeenCalled();
  });
});

describe("createDxFeedMarketDataServer -- overlapping token-fetch race (DX3.03 closure-audit finding)", () => {
  test("a select superseded by a second select before its token fetch resolves never creates a connection or becomes the active session", async () => {
    let resolveFirst;
    let resolveSecond;
    let tokenCallCount = 0;
    const requestToken = jest.fn(() => {
      tokenCallCount += 1;
      if (tokenCallCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    const createConnection = jest.fn(() => fakeConnection());
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection }));
    server.start();
    const client = fakeClient();

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    expect(server.isActive()).toBe(true);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "TSLA", assetClass: "EQUITY" });

    resolveFirst({ token: "stale-token", expiresAt: VALID_EXPIRES_AT });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createConnection).not.toHaveBeenCalled();
    expect(server.isActive()).toBe(true);

    resolveSecond({ token: "winning-token", expiresAt: VALID_EXPIRES_AT });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "TSLA", assetClass: "EQUITY" });
  });

  test("three overlapping selects before any token resolves leave only the last one active, with exactly one real connection ever created", async () => {
    const resolvers = [];
    const requestToken = jest.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const createConnection = jest.fn(() => fakeConnection());
    const server = createDxFeedMarketDataServer(baseOptions({ requestToken, createConnection }));
    server.start();

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), fakeClient());
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    expect(resolvers).toHaveLength(3);

    resolvers[0]({ token: "t1", expiresAt: VALID_EXPIRES_AT });
    resolvers[1]({ token: "t2", expiresAt: VALID_EXPIRES_AT });
    resolvers[2]({ token: "t3", expiresAt: VALID_EXPIRES_AT });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });
  });
});

describe("createDxFeedMarketDataServer -- selection rate limiting", () => {
  test("closes a client that exceeds the pair-selection rate limit", () => {
    const nowMs = NOW_MS;
    const requestToken = jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT }));
    const server = createDxFeedMarketDataServer(baseOptions({
      requestToken,
      now: () => nowMs,
      createConnection: () => fakeConnection(),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(client.close).toHaveBeenCalledWith(1008, "Too many pair selection requests");
  });
});

describe("createDxFeedMarketDataServer -- market-quiet signal (printsQuiet)", () => {
  test("a qualifying print becomes one closed bar after the clock crosses the finality watermark, without a next print", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      let nowMs = NOW_MS;
      const connection = fakeConnection();
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, now: () => nowMs }));
      const client = fakeClient();
      server.start();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);
      client.sent.length = 0;
      connection.channel.emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });
      client.sent.length = 0;
      nowMs += 62_000;
      jest.advanceTimersByTime(1_000);
      expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed === true)).toHaveLength(1);
      server.stop();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("flips printsQuiet to true after 90s of silence, without touching recoveryState", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);
      client.sent.length = 0;

      jest.advanceTimersByTime(90_000);

      const quietFrame = client.sent.find((frame) => frame.type === "health");
      expect(quietFrame).toEqual(expect.objectContaining({ recoveryState: "RECOVERING", printsQuiet: true }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a fresh qualifying print after going quiet clears printsQuiet and resets the countdown, even when recoveryState never left READY", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);
      // A first print flips this view to READY well before the quiet threshold.
      connection.channel.emitMessage({ type: "FEED_DATA", data: [NQ_TIMEANDSALE_ITEM] });
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY" }));

      // Then a long lull -- recoveryState stays READY throughout, only printsQuiet changes.
      jest.advanceTimersByTime(90_000);
      expect(client.sent).toContainEqual(expect.objectContaining({ type: "health", recoveryState: "READY", printsQuiet: true }));
      client.sent.length = 0;

      // A fresh print resumes -- must clear printsQuiet even though recoveryState was already READY.
      connection.channel.emitMessage({
        type: "FEED_DATA",
        data: [{ ...NQ_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, sequence: 66861 }],
      });

      const healthFrames = client.sent.filter((frame) => frame.type === "health");
      expect(healthFrames).toContainEqual(expect.objectContaining({ recoveryState: "READY", printsQuiet: false }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("printsQuiet never fires once the connection has already dropped (UNAVAILABLE always wins)", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);

      connection.emitConnection(DXLinkConnectionState.NOT_CONNECTED, DXLinkConnectionState.CONNECTED);
      client.sent.length = 0;

      jest.advanceTimersByTime(90_000);

      expect(client.sent.some((frame) => frame.type === "health" && frame.printsQuiet === true)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("switching to a different symbol before 90s elapses clears the old instrument's quiet timer instead of leaking it", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connection = fakeConnection();
      const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), client);
      await driveToChannelOpened(connection);
      const timersWithOneSession = jest.getTimerCount();

      jest.advanceTimersByTime(45_000);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await driveToChannelOpened(connection);

      // A fresh AAPL session schedules its own deadline + quiet timer, same
      // as NQ's did -- the pending-timer count should return to what a
      // single live session holds, not grow by NQ's now-orphaned quiet timer.
      expect(jest.getTimerCount()).toBe(timersWithOneSession);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Real raw-frame index extraction (WebSocket-level) is exercised by
// dxfeed-order-v2-capture.test.js, and per-event book reconstruction by
// dxfeed-book-assembler.test.js -- this file's own fakeConnection/fakeChannel
// harness sits one layer above the raw WebSocket (parsed FEED_DATA messages
// only), so an Order item delivered here never has a raw-frame-sourced index
// and always normalizes to a DEGRADED envelope. These tests verify the
// wiring around that real, already-tested pipeline: channel topology,
// contract choice, subscription entries, broadcast/replay, cleanup, and
// error containment -- not the index-extraction or book-math logic itself.
describe("createDxFeedMarketDataServer -- live order book wiring (DX3.07 Phase C)", () => {
  const AAPL_ORDER_SNAPSHOT_ITEM = {
    eventType: "Order", eventSymbol: "AAPL", eventFlags: 12, index: 1, time: NOW_MS,
    action: "NEW", price: 230.5, size: 10, side: "BUY", scope: "ORDER", source: "NTV",
  };

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

  test("opens a dedicated STREAM-contract Order channel alongside the main channel, subscribing with the real order source", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(connection, orderChannel);

    expect(connection.openChannel).toHaveBeenNthCalledWith(1, "FEED", { contract: "STREAM" });
    expect(connection.openChannel).toHaveBeenNthCalledWith(2, "FEED", { contract: "STREAM" });
    const orderSubscribe = orderChannel.sent.find((payload) => payload.type === "FEED_SUBSCRIPTION" && payload.add);
    expect(orderSubscribe.add).toEqual([{ symbol: "AAPL", type: "Order", source: "NTV" }]);
  });

  test("passes createConnector through to createConnection for a symbol with resolvable order support", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const createConnection = jest.fn(() => connection);
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(connection, orderChannel);

    expect(createConnection).toHaveBeenCalledTimes(1);
    const [, options] = createConnection.mock.calls[0];
    expect(typeof options?.createConnector).toBe("function");
  });

  test("does not open an order channel for a symbol outside the hardcoded order-support instrument set, e.g. a different futures expiry", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("/NQU26:XCME", "FUTURE"), fakeClient());
    await driveToChannelOpened(connection);
    await Promise.resolve();

    expect(connection.openChannel).toHaveBeenCalledTimes(1);
    expect(server.currentSymbolInfo()).toEqual({ symbol: "/NQU26:XCME", assetClass: "FUTURE" });
  });

  test("an Order message on the order channel drives the assembler and broadcasts a book frame, replayed to a client connecting later", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });

    const bookFrame = client.sent.find((frame) => frame.type === "book");
    expect(bookFrame).toEqual(expect.objectContaining({
      type: "book", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY",
      status: "READY",
    }));

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);
    expect(lateClient.sent).toContainEqual(bookFrame);
  });

  test("an order-channel error does not end the session -- Trade data keeps flowing on the main channel", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    orderChannel.emitError(new Error("order channel boom"));
    expect(server.isActive()).toBe(true);

    mainChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_TIMEANDSALE_ITEM] });
    expect(client.sent.some((frame) => frame.type === "trade")).toBe(true);
  });

  test("reconnects a failed order channel independently while the main L1 stream stays active", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const mainChannel = fakeChannel({ id: 1 });
      const firstOrderChannel = fakeChannel({ id: 2 });
      const replacementOrderChannel = fakeChannel({ id: 3 });
      const connection = fakeConnection({
        channel: mainChannel,
        channels: [mainChannel, firstOrderChannel, replacementOrderChannel],
      });
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => connection,
        createOrderV2Capture: canonicalCapture,
        sessionRetryBaseMs: 10,
      }));
      server.start();
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
      await driveToOrderChannelOpened(connection, firstOrderChannel);

      firstOrderChannel.emitError(new Error("order transport lost"));
      expect(server.isActive()).toBe(true);
      expect(connection.openChannel).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(connection.openChannel).toHaveBeenCalledTimes(3);
      replacementOrderChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
      await Promise.resolve();
      await Promise.resolve();

      const replacementSubscribe = replacementOrderChannel.sent.find((payload) => payload.type === "FEED_SUBSCRIPTION" && payload.add);
      expect(replacementSubscribe.add).toEqual([{ symbol: "AAPL", type: "Order", source: "NTV" }]);
      expect(server.isActive()).toBe(true);
      server.stop();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("switching symbols tears down both the main and the order channel", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(connection, orderChannel);

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), fakeClient());
    await Promise.resolve();

    expect(mainChannel.close).toHaveBeenCalledTimes(1);
    expect(orderChannel.close).toHaveBeenCalledTimes(1);
  });

  test("schedules a book-staleness timer once an order message arrives, fully cleared on session teardown -- no timer leak", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const mainChannel = fakeChannel({ id: 1 });
      const orderChannel = fakeChannel({ id: 2 });
      const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => connection, createOrderV2Capture: canonicalCapture,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await driveToOrderChannelOpened(connection, orderChannel);
      const timersBeforeOrderEvent = jest.getTimerCount();

      orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });
      expect(jest.getTimerCount()).toBe(timersBeforeOrderEvent + 1);

      server.deactivate();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a connection error ends the session and transitions the book to UNAVAILABLE with the session-end reason, not left frozen at its last state -- Stage 3 audit finding (deactivate/symbol-switch deliberately stay silent here, matching the existing health-frame precedent, so this uses a real client-visible session end instead)", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);
    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });
    const bookFramesBeforeEnd = client.sent.filter((frame) => frame.type === "book").length;
    expect(bookFramesBeforeEnd).toBeGreaterThan(0);

    connection.emitError(new Error("connection boom"));

    const bookFramesAfterEnd = client.sent.filter((frame) => frame.type === "book");
    expect(bookFramesAfterEnd.length).toBeGreaterThan(bookFramesBeforeEnd);
    expect(bookFramesAfterEnd[bookFramesAfterEnd.length - 1]).toEqual(expect.objectContaining({
      type: "book", status: "UNAVAILABLE", reason: "DXFEED_SESSION_ENDED",
    }));
    expect(server.isActive()).toBe(false);
  });

  test("deactivate/symbol-switch stay silent for the book, exactly matching the existing health-frame precedent -- not a regression, a deliberate consistency", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);
    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });
    const bookFramesBeforeDeactivate = client.sent.filter((frame) => frame.type === "book").length;
    const healthFramesBeforeDeactivate = client.sent.filter((frame) => frame.type === "health").length;

    server.deactivate();

    expect(client.sent.filter((frame) => frame.type === "book")).toHaveLength(bookFramesBeforeDeactivate);
    expect(client.sent.filter((frame) => frame.type === "health")).toHaveLength(healthFramesBeforeDeactivate);
  });

  test("an order-channel error transitions the book specifically to UNAVAILABLE(ORDER_CHANNEL_ERROR) rather than leaving it frozen -- Stage 3 audit finding", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);
    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });

    orderChannel.emitError(new Error("order channel boom"));

    const bookFrame = client.sent.filter((frame) => frame.type === "book").pop();
    expect(bookFrame).toEqual(expect.objectContaining({
      type: "book", status: "UNAVAILABLE", reason: "ORDER_CHANNEL_ERROR",
    }));
    expect(server.isActive()).toBe(true);
  });

  test("an order-capture setup failure explicitly publishes UNAVAILABLE instead of leaving the book absent", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const capture = {
      createConnector: jest.fn(),
      setChannelId: jest.fn(() => { throw new Error("missing channel id"); }),
      handleChannelMessage: jest.fn(),
    };
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection,
      createOrderV2Capture: () => capture,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      status: "UNAVAILABLE", reason: "ORDER_CHANNEL_SETUP_FAILED",
    }));
    expect(server.isActive()).toBe(true);
  });

  test("an order-capture runtime fault invalidates the published book immediately", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    let captureOptions;
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection,
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
      },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    captureOptions.onCaptureError(new Error("correlation overflow"));

    expect(client.sent.filter((frame) => frame.type === "book").pop()).toEqual(expect.objectContaining({
      status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR",
    }));
  });

  // Same gap as the eager relay: a correlation loss used to surface only as an
  // unattributed console.error, never persisted. Must now name the instrument
  // that caused it and the channel it happened on, via durable telemetry.
  test("attributes an order-capture fault to its triggering instrument and channel via telemetry", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const telemetryEvents = [];
    let captureOptions;
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection,
      telemetry: (entry) => telemetryEvents.push(entry),
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
      },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    const error = new Error("dxfeed-order-v2-capture: parsed FEED_DATA arrived without its raw frame");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["AAPL"];
    captureOptions.onCaptureError(error);

    const failure = telemetryEvents.find((e) => e.event === "market_data.dxfeed_order_v2_capture.correlation_failed");
    expect(failure).toEqual(expect.objectContaining({
      code: "DXFEED_ORDER_V2_CORRELATION_LOST",
      eventSymbols: ["AAPL"],
      channelId: 2,
    }));
  });

  test("durably telemetrizes book unavailable/recovery transitions, without re-emitting for repeated identical states", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const reopenedOrderChannel = fakeChannel({ id: 3 });
    const connection = fakeConnection({
      channel: mainChannel,
      channels: [mainChannel, orderChannel, reopenedOrderChannel],
    });
    const telemetryEvents = [];
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
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection,
      sessionRetryBaseMs: 5,
      telemetry: (entry) => telemetryEvents.push(entry),
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return capture;
      },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    const bookEvents = () => telemetryEvents.filter((e) => e.event.startsWith("market_data.dxfeed_book_assembler."));

    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });
    expect(bookEvents()).toHaveLength(0);

    const error = new Error("dxfeed-order-v2-capture: raw and parsed Order item counts or exact indices do not match");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["AAPL"];
    captureOptions.onCaptureError(error);
    expect(bookEvents()).toEqual([
      expect.objectContaining({
        event: "market_data.dxfeed_book_assembler.unavailable",
        symbol: "AAPL", assetClass: "EQUITY", reason: "ORDER_CAPTURE_ERROR", previousStatus: "READY",
      }),
    ]);

    captureOptions.onCaptureError(error);
    expect(bookEvents()).toHaveLength(1);

    for (let attempt = 0; attempt < 50 && connection.openChannel.mock.calls.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    reopenedOrderChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    await Promise.resolve();
    await Promise.resolve();

    reopenedOrderChannel.emitMessage({
      type: "FEED_DATA",
      data: [{ ...AAPL_ORDER_SNAPSHOT_ITEM, index: 2 }],
    });
    expect(bookEvents()).toEqual([
      expect.objectContaining({ event: "market_data.dxfeed_book_assembler.unavailable" }),
      expect.objectContaining({
        event: "market_data.dxfeed_book_assembler.recovery_succeeded", symbol: "AAPL", assetClass: "EQUITY",
      }),
    ]);
  });

  test("instrumentSnapshot reports the one currently-selected instrument's live L1/L2 state, empty when none is selected", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();

    expect(server.instrumentSnapshot()).toEqual([]);

    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(connection, orderChannel);

    expect(server.instrumentSnapshot()).toEqual([{
      analytics: { profile: "IDLE", vpin: "UNAVAILABLE" },
      dataQuality: {
        accepted: 0, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: {}, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 0, markers: 0, heavyHistoryWarm: true },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "RECOVERING", quiet: false },
      l2: { status: "BUFFERING", reason: null },
    }]);

    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });

    expect(server.instrumentSnapshot()).toEqual([{
      analytics: { profile: "IDLE", vpin: "UNAVAILABLE" },
      dataQuality: {
        accepted: 0, rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 0 },
        lastRejectedAtMs: null, lastRejection: null,
        saleConditions: {}, saleConditionsOverflow: 0,
      },
      retention: { bars: 0, trades: 0, markers: 0, heavyHistoryWarm: true },
      session: { policy: "EQUITY_CHART_REGULAR_ONLY", state: "REGULAR" },
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "RECOVERING", quiet: false },
      l2: { status: "READY", reason: null },
    }]);
  });

  // Report 57 W1, O-10: while the equity market is closed a live-looking READY
  // book is stale by definition; in the regular session the same book is fresh.
  test("an equity book is fresh in the regular session and stale while the equity session is closed (O-10)", async () => {
    const regular = Date.parse("2027-01-15T15:00:00Z");
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const connection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const server = createDxFeedMarketDataServer(baseOptions({
      now: () => regular,
      requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: new Date(regular + 30 * 60_000).toISOString() })),
      createConnection: () => connection, createOrderV2Capture: canonicalCapture,
    }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(connection, orderChannel);
    orderChannel.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });

    const [row] = server.instrumentSnapshot();
    expect(row.session.state).toBe("REGULAR");
    expect(row.l2).toEqual({ status: "READY", reason: null });

    const saturday = Date.parse("2027-01-16T15:00:00Z");
    const closedMain = fakeChannel({ id: 1 });
    const closedOrders = fakeChannel({ id: 2 });
    const closedConnection = fakeConnection({ channel: closedMain, channels: [closedMain, closedOrders] });
    const closed = createDxFeedMarketDataServer(baseOptions({
      now: () => saturday,
      requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: new Date(saturday + 30 * 60_000).toISOString() })),
      createConnection: () => closedConnection, createOrderV2Capture: canonicalCapture,
    }));
    closed.start();
    closed.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(closedConnection, closedOrders);
    closedOrders.emitMessage({ type: "FEED_DATA", data: [AAPL_ORDER_SNAPSHOT_ITEM] });

    const [closedRow] = closed.instrumentSnapshot();
    expect(closedRow.session.state).not.toBe("REGULAR");
    expect(closedRow.l2).toEqual({ status: "READY", reason: null, stale: true });
  });

  test("orderV2CaptureStatus exposes the live capture module's correlation health, null when order support is unavailable", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("/NQU26:XCME", "FUTURE"), fakeClient());
    await driveToChannelOpened(connection);
    await Promise.resolve();

    expect(server.orderV2CaptureStatus()).toBeNull();

    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const orderedConnection = fakeConnection({ channel: mainChannel, channels: [mainChannel, orderChannel] });
    const orderedServer = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => orderedConnection,
      createOrderV2Capture: () => ({
        createConnector: jest.fn(),
        setChannelId: jest.fn(),
        handleChannelMessage: jest.fn(),
        getCorrelationStatus: () => ({ healthy: true, pendingFrames: 0, pendingIndexValues: 0, lastFailure: null }),
      }),
    }));
    orderedServer.start();
    orderedServer.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToOrderChannelOpened(orderedConnection, orderChannel);

    expect(orderedServer.orderV2CaptureStatus()).toEqual(expect.objectContaining({ healthy: true, lastFailure: null }));
  });

  // The channel is still open and authenticated when correlation is lost --
  // only the capture module's internal state is poisoned. Recovery must close
  // that channel and reopen a FRESH one on the SAME connection (no new token),
  // reusing the existing, already-tested establishOrderChannel/
  // scheduleOrderChannelRestart path real transport errors already use.
  test("a correlation loss closes the poisoned order channel and reopens a fresh one on the same connection", async () => {
    const mainChannel = fakeChannel({ id: 1 });
    const orderChannel = fakeChannel({ id: 2 });
    const reopenedOrderChannel = fakeChannel({ id: 3 });
    const connection = fakeConnection({
      channel: mainChannel,
      channels: [mainChannel, orderChannel, reopenedOrderChannel],
    });
    let captureOptions;
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection,
      sessionRetryBaseMs: 5,
      createOrderV2Capture: (options) => {
        captureOptions = options;
        return { createConnector: jest.fn(), setChannelId: jest.fn(), handleChannelMessage: jest.fn() };
      },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToOrderChannelOpened(connection, orderChannel);

    const error = new Error("dxfeed-order-v2-capture: parsed FEED_DATA arrived without its raw frame");
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = ["AAPL"];
    captureOptions.onCaptureError(error);

    expect(orderChannel.removeMessageListener).toHaveBeenCalled();
    expect(orderChannel.send).toHaveBeenCalledWith(expect.objectContaining({ type: "FEED_SUBSCRIPTION" }));

    for (let attempt = 0; attempt < 50 && connection.openChannel.mock.calls.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    reopenedOrderChannel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.openChannel).toHaveBeenCalledTimes(3);
    expect(reopenedOrderChannel.send).toHaveBeenCalledWith(expect.objectContaining({ type: "FEED_SETUP" }));
    expect(reopenedOrderChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "FEED_SUBSCRIPTION", add: [{ symbol: "AAPL", type: "Order", source: "NTV" }],
    }));
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

    // Same cursor-aware, once-per-chain fixture strategy as
    // market-data-server.test.js's own volume profile suite: a real
    // cursor-based reader returns its rows once, then empty pages once the
    // cursor has advanced past them -- returning the same rows
    // unconditionally would double-apply them on every poll tick.
    // readVolumeProfile re-derives buckets from the same fixture using the
    // same floor-bucketing math the real engine uses.
    function fakeVolumeProfileStorageReader({ tradeRows = volumeProfileTradeRows() } = {}) {
      const readTradesSince = jest.fn((_symbol, _assetClass, { cursor }) => {
        if (cursor !== null) return { rows: [], nextCursor: cursor, available: true };
        if (tradeRows.length === 0) return { rows: [], nextCursor: null, available: true };
        return {
          rows: tradeRows,
          nextCursor: { ts: tradeRows[tradeRows.length - 1].event_time, id: tradeRows.length },
          available: true,
        };
      });
      const readVolumeProfile = jest.fn((_symbol, _assetClass, { fromTs, toTs, originPrice, rowWidth }) => {
        const buckets = new Map();
        for (const row of tradeRows) {
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
      const readPriceRange = jest.fn((_symbol, _assetClass, { fromTs, toTs }) => {
        const inWindow = tradeRows.filter((row) => row.event_time >= fromTs && row.event_time < toTs);
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

    test("warms up a session synchronously on select and broadcasts a profile frame on the next poll tick", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const tickSizeResolver = fakeTickSizeResolver();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver,
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

      // Warm-up itself is synchronous (dxFeed's tick size lookup never
      // touches the network) -- confirm it ran before the poll timer even
      // gets a chance to fire.
      expect(tickSizeResolver.getDxFeedTickSize).toHaveBeenCalledWith("EQUITY", "AAPL");
      client.sent.length = 0;

      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame).toBeDefined();
      expect(frame.mode).toBe("continuous");
      expect(frame.period_end_ts).toBeNull();
      expect(frame.buckets.length).toBeGreaterThan(0);
      server.stop();
    });

    test("a profile setting sent while the initial session is warming is applied after warm-up", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      server.handleClientMessage(profileConfigWire({ mode: "per_candle", bin_size_multiplier: 2 }), client);
      await settle();
      expect(client.sent.filter((frame) => frame.type === "profile").at(-1)?.mode).toBe("per_candle");
      server.stop();
    });

    test("never calls the tick-size resolver when storageReader lacks readVolumeProfile/readTradesSince", async () => {
      const storageReader = { readRecent: jest.fn(() => ({ rows: [], available: true })) };
      const tickSizeResolver = fakeTickSizeResolver();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver,
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);

      expect(tickSizeResolver.getDxFeedTickSize).not.toHaveBeenCalled();
      client.sent.length = 0;
      await settle();
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      server.stop();
    });

    test("does not create a session for an instrument with no configured tick size", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      // DOGE isn't in either hardcoded dxFeed tick-size table.
      server.handleClientMessage(JSON.stringify({ type: "select", symbol: "DOGE", assetClass: "EQUITY" }), client);
      client.sent.length = 0;
      await settle();
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
      server.stop();
    });

    test("switching symbols discards the previous symbol's volume profile state -- no stale frame mislabeled under the new symbol", async () => {
      // Symbol-aware: AAPL has reference trades, TSLA has none yet. This is
      // the actual failure mode a missing reset in endSession would produce
      // -- ensureVolumeProfileWarm's own "no trades in the lookback window"
      // branch no-ops without touching volumeProfileState, so nothing else
      // would overwrite the stale AAPL session on its own; only an
      // explicit reset on session teardown prevents it from continuing to
      // broadcast under the newly-selected TSLA label.
      const tradeRowsBySymbol = {
        AAPL: [
          { event_time: NOW_MS - 3_000, provider_trade_id: 1, price: 190, size: 1, aggressor_side: "BUY" },
          { event_time: NOW_MS - 2_000, provider_trade_id: 2, price: 200, size: 2, aggressor_side: "SELL" },
          { event_time: NOW_MS - 1_000, provider_trade_id: 3, price: 210, size: 1, aggressor_side: "BUY" },
        ],
        TSLA: [],
      };
      const readTradesSince = jest.fn((symbol, _assetClass, { cursor }) => {
        const rows = tradeRowsBySymbol[symbol] ?? [];
        if (cursor !== null || rows.length === 0) return { rows: [], nextCursor: cursor, available: true };
        return { rows, nextCursor: { ts: rows[rows.length - 1].event_time, id: rows.length }, available: true };
      });
      const readVolumeProfile = jest.fn(() => ({ buckets: [], available: true }));
      const readPriceRange = jest.fn((symbol, _assetClass, { fromTs, toTs }) => {
        const inWindow = (tradeRowsBySymbol[symbol] ?? []).filter((row) => row.event_time >= fromTs && row.event_time < toTs);
        if (inWindow.length === 0) return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
        return {
          minPrice: Math.min(...inWindow.map((row) => row.price)),
          maxPrice: Math.max(...inWindow.map((row) => row.price)),
          tradeCount: inWindow.length,
          available: true,
        };
      });
      const storageReader = { readTradesSince, readVolumeProfile, readPriceRange };
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(client.sent.filter((f) => f.type === "profile" && f.symbol === "AAPL").length).toBeGreaterThan(0);
      client.sent.length = 0;

      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      await settle();

      const frames = client.sent.filter((f) => f.type === "profile");
      expect(frames).toEqual([]);
      server.stop();
    });

    // Report 57 W2, FA-11 (stale selection): a volume profile warm-up for one
    // symbol that finishes after the user switched must be thrown away. It
    // used to install itself as the live profile, and the next poll
    // broadcast it labelled with the new symbol: AAPL's profile on TSLA.
    test("a volume profile warm-up that lands after a switch is discarded, never shown on the new symbol (FA-11)", async () => {
      const aaplRows = [
        { event_time: NOW_MS - 3_000, provider_trade_id: 1, price: 190, size: 1, aggressor_side: "BUY" },
        { event_time: NOW_MS - 2_000, provider_trade_id: 2, price: 200, size: 2, aggressor_side: "SELL" },
      ];
      const readTradesSince = jest.fn((symbol, _assetClass, { cursor }) => {
        const rows = symbol === "AAPL" ? aaplRows : [];
        if (cursor !== null || rows.length === 0) return { rows: [], nextCursor: cursor, available: true };
        return { rows, nextCursor: { ts: rows[rows.length - 1].event_time, id: rows.length }, available: true };
      });
      const readVolumeProfile = jest.fn(() => ({ buckets: [], available: true }));
      const heldAapl = [];
      const readPriceRange = jest.fn((symbol) => {
        if (symbol !== "AAPL") return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
        return new Promise((resolve) => heldAapl.push(() => resolve({ minPrice: 190, maxPrice: 200, tradeCount: 2, available: true })));
      });
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader: { readTradesSince, readVolumeProfile, readPriceRange },
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(heldAapl.length).toBeGreaterThan(0);
      server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
      await settle();
      client.sent.length = 0;
      for (const release of heldAapl.splice(0)) release();
      await settle();
      await settle();
      expect(client.sent.filter((f) => f.type === "profile" && f.symbol === "TSLA")).toEqual([]);
      server.stop();
    });

    test("an invalid profile_config request (missing/extra fields, unrecognized mode, invalid period_ms/bin_size_multiplier, or a range on a non-fixed_range mode) is logged and ignored -- never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
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

    test("a valid profile_config changes the active view's mode, visible on the next broadcast frame", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      client.sent.length = 0;

      server.handleClientMessage(profileConfigWire({ mode: "per_candle" }), client);
      await settle();

      const [frame] = client.sent.filter((f) => f.type === "profile");
      expect(frame.mode).toBe("per_candle");
      server.stop();
    });

    test("the latest of overlapping asynchronous profile rebuilds wins", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(0.01),
        volumeProfilePollMs: 10,
      }));
      server.start();
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

    // The Binance server rebuilds the profile session as soon as the grid
    // changes (market-data-server.js handleProfileConfigMessage). Both dxFeed
    // servers only assigned the field, so a row-width change was invisible
    // until the next period rollover -- up to an hour on the default period.
    // `baseOptions()` freezes `now`, so no rollover can occur here and the
    // grid change has to be applied by the config handler itself.
    test("a bin_size_multiplier change rebuilds the session grid immediately, not at the next period rollover", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
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
      server.stop();
    });

    test("a small period_ms rolls the open period over to a fresh session on the next poll tick", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      // baseOptions() freezes `now` at a single fixed instant, under which
      // nowMs < periodStartTs + periodMs can never go false once periodMs >
      // 0 -- rollover-due-ness could never be observed at all. An
      // incrementing clock is needed here specifically, unlike every other
      // test in this suite.
      let simulatedNowMs = NOW_MS;
      const now = () => (simulatedNowMs += 5);
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
        now,
      }));
      server.start();
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
      expect(rolledFrame.period_start_ts).toBeGreaterThan(firstFrame.period_start_ts);
      // A rollover now rebuilds the session on the epoch grid instead of
      // finalizing the closed one, because the closed session's buckets were
      // computed and then discarded. The advancing, grid-aligned period start
      // is the observable proof it ran; the old finalize read is gone.
     expect(rolledFrame.period_start_ts % 1).toBe(0);
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

    test("a valid fixed_range profile_config sends a single profile frame directly, and works with no volume profile session ever warmed up", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      }));
      server.start();
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
      expect(frames[0].period_start_ts).toBe(NOW_MS - 10_000);
      expect(frames[0].period_end_ts).toBe(NOW_MS + 5_000);
      server.stop();
    });

    test("a fixed-range profile that finishes after selection changes is discarded", async () => {
      const storageReader = fakeVolumeProfileStorageReader();
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      }));
      server.start();
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
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10_000,
      }));
      server.start();
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

    test("a fixed_range request over a window with no trades sends nothing, never crashes", async () => {
      const storageReader = fakeVolumeProfileStorageReader({ tradeRows: [] });
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
      }));
      server.start();
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
        const server = createDxFeedMarketDataServer(baseOptions({
          createConnection: () => fakeConnection(),
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        }));
        server.start();
        const client = fakeClient();
        server.handleClientConnected(client);
        server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
        await settle();
        client.sent.length = 0;
        return { server, client };
      }

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
        expect(frames[0].period_start_ts).toBe(ranges[0].range_start_ts);
        expect(frames[0].period_end_ts).toBe(ranges[0].range_end_ts);
        server.stop();
      });

      test("sends only to the requesting client, never broadcast", async () => {
        const storageReader = fakeVolumeProfileStorageReader();
        const server = createDxFeedMarketDataServer(baseOptions({
          createConnection: () => fakeConnection(),
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        }));
        server.start();
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
        const storageReader = fakeVolumeProfileStorageReader({ tradeRows: [] });
        const server = createDxFeedMarketDataServer(baseOptions({
          createConnection: () => fakeConnection(),
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        }));
        server.start();
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
        const server = createDxFeedMarketDataServer(baseOptions({
          createConnection: () => fakeConnection(),
          storageReader,
          tickSizeResolver: fakeTickSizeResolver(),
          volumeProfilePollMs: 10_000,
        }));
        server.start();
        const client = fakeClient();
        server.handleClientConnected(client);
        const ranges = alignedRanges(60_000, 1, NOW_MS);

        expect(() => server.handleClientMessage(profileHistoryWire({ period_ms: 60_000, ranges }), client)).not.toThrow();
        await settle();

        expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);
        server.stop();
      });
    });

    // Closure-audit regression, mirroring the eager server's. Warm-up ran only
    // inside startSession, and returns silently when the reference lookback is
    // empty -- so selecting an instrument during a quiet market left it without
    // a volume profile until an unrelated session restart happened to re-run
    // warm-up. The poll loop must keep retrying instead.
    test("an instrument selected during a quiet market still gets a profile once trades appear", async () => {
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
      // Honours the same quiet-market gate as readTradesSince: while there
      // are no trades there is no price range either, which is exactly what
      // must keep warm-up from producing a session.
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
      const server = createDxFeedMarketDataServer(baseOptions({
        createConnection: () => fakeConnection(),
        storageReader,
        tickSizeResolver: fakeTickSizeResolver(),
        volumeProfilePollMs: 10,
        now: () => simulatedNowMs,
      }));
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(client.sent.filter((f) => f.type === "profile")).toEqual([]);

      tradesExistYet = true;
      simulatedNowMs += 15_000;
      client.sent.length = 0;
      await settle();

      expect(client.sent.filter((f) => f.type === "profile").length).toBeGreaterThan(0);
      server.stop();
    });
  });
});

describe("createDxFeedMarketDataServer -- vpin wiring (P4.12 Step 4)", () => {
  // ensureVpinWarm's missing-method guard used to broadcast a full snapshot
  // to every client on every poll tick, forever, whenever the storage
  // reader lacked readTradesSince/readMinuteRollup -- it returned before
  // ever reaching the vpinWarmupJob/cooldown guard, and set no cooldown of
  // its own. It must broadcast once per genuine transition into
  // UNAVAILABLE, not once per poll tick.
  test("a storage reader missing the VPIN read methods does not rebroadcast a snapshot on every poll tick", async () => {
    const storageReader = fakeStorageReader();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(), storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
    }));
    try {
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.instrumentSnapshot()[0].analytics.vpin).toBe("UNAVAILABLE");
      client.sent.length = 0;

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.sent.filter((frame) => frame.type === "snapshot")).toHaveLength(0);
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

  // readTradesSince honors fromTs/toTs like a real windowed store would.
  // That matters here: the suite's clock is frozen at NOW_MS, so once
  // backfill resets the session's pollCursor to null and advances
  // pollFromTs to NOW_MS, every live poll re-queries a zero-width
  // [NOW_MS, NOW_MS] window -- a fake that ignored the window and just
  // replayed its fixture unconditionally on cursor:null would re-seal the
  // same backfilled trades on the very next poll tick. tradeRows is taken
  // by reference so a test can push a fresh event_time:NOW_MS trade onto
  // it after warm-up to simulate one arriving live.
  function fakeVpinStorageReader({ tradeRows = vpinTradeRows() } = {}) {
    const readTradesSince = jest.fn((_symbol, _assetClass, { fromTs, toTs, cursor }) => {
      if (cursor !== null) return { rows: [], nextCursor: cursor, available: true };
      const rows = tradeRows.filter((row) => row.event_time >= fromTs && row.event_time <= toTs);
      if (rows.length === 0) return { rows: [], nextCursor: null, available: true };
      return { rows, nextCursor: { ts: rows[rows.length - 1].event_time, id: rows.length }, available: true };
    });
    const readMinuteRollup = jest.fn(() => ({ rows: [], available: true }));
    const readVolumeProfile = jest.fn(() => ({ buckets: [], available: true }));
    return { tradeRows, readTradesSince, readMinuteRollup, readVolumeProfile };
  }

  function fakeTickSizeResolver(tickSize = 1) {
    return { getDxFeedTickSize: jest.fn(() => tickSize), getBinanceTickSize: jest.fn() };
  }

  function fakeVpinWarmup(tradeRows) {
    return ({ nowMs }) => {
      const vpinState = createVpinState({ vBucket: 1_000 });
      const history = [];
      for (const row of tradeRows) {
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

  function fakeVpinLivePoll(tradeRows) {
    return (input) => {
      const vpinState = JSON.parse(JSON.stringify(input.vpinState));
      const rows = input.pollCursor === null
        ? tradeRows.filter((row) => row.event_time >= input.pollFromTs && row.event_time <= input.nowMs)
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

  async function settle(ms = 50) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  test("live VPIN failure is unavailable in status and reconnect snapshot, and a later successful query recovers", async () => {
    const storageReader = fakeVpinStorageReader();
    let unavailable = true;
    const success = fakeVpinLivePoll([]);
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(), storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
      vpinLivePoll: (input) => unavailable ? { promise: Promise.reject(new Error("database unavailable")), cancel() {} } : success(input),
    }));
    try {
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle();
      expect(server.vpinWarmupStatus()).toBe("UNAVAILABLE");
      expect(server.instrumentSnapshot()[0].analytics.vpin).toBe("UNAVAILABLE");
      const newcomer = fakeClient();
      server.handleClientConnected(newcomer);
      expect(newcomer.sent).toContainEqual(expect.objectContaining({ type: "snapshot", vpin_status: "UNAVAILABLE" }));
      expect(newcomer.sent).toContainEqual(expect.objectContaining({ type: "analytics_status", indicator: "VPIN", status: "UNAVAILABLE" }));
      unavailable = false;
      await settle();
      expect(server.vpinWarmupStatus()).toBe("READY");
      expect(client.sent.filter((frame) => frame.type === "analytics_status" && frame.indicator === "VPIN").at(-1).status).toBe("READY");
    } finally { await server.stop(); }
  });

  test("vpinEnabled false (TT_VPIN_ENABLED=0) means no VPIN warm-up or live poll and a DISABLED status (Block 8 #7)", async () => {
    const storageReader = fakeVpinStorageReader();
    const vpinWarmup = jest.fn();
    const vpinLivePoll = jest.fn();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(), storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinPollMs: 10,
      vpinEnabled: false, vpinWarmup, vpinLivePoll,
    }));
    try {
      server.start();
      const client = fakeClient();
      server.handleClientConnected(client);
      server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
      await settle(80);
      expect(vpinWarmup).not.toHaveBeenCalled();
      expect(vpinLivePoll).not.toHaveBeenCalled();
      expect(server.vpinWarmupStatus()).toBe("DISABLED");
    } finally { await server.stop(); }
  });

  test("warms up a session on select and its snapshot carries vpin_readings once warm-up settles", async () => {
    const storageReader = fakeVpinStorageReader();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver: fakeTickSizeResolver(),
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();

    const [frame] = client.sent.filter((f) => f.type === "snapshot" && Array.isArray(f.vpin_readings) && f.vpin_readings.length > 0);
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

  test("a client connecting after warm-up already finished still receives vpin_readings on its own initial snapshot", async () => {
    const storageReader = fakeVpinStorageReader();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver: fakeTickSizeResolver(),
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
    }));
    server.start();
    const firstClient = fakeClient();
    server.handleClientConnected(firstClient);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), firstClient);
    await settle();

    const lateClient = fakeClient();
    server.handleClientConnected(lateClient);

    const [frame] = lateClient.sent.filter((f) => f.type === "snapshot" && Array.isArray(f.vpin_readings) && f.vpin_readings.length > 0);
    expect(frame).toBeDefined();
    expect(frame.vpin_readings.length).toBe(6);
    server.stop();
  });

  test("never calls the tick-size resolver when storageReader lacks readMinuteRollup -- the vpin-specific calibration requirement", async () => {
    const storageReader = fakeVpinStorageReader();
    delete storageReader.readMinuteRollup;
    const tickSizeResolver = fakeTickSizeResolver();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver,
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();

    expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
    expect(client.sent.some((f) => f.type === "snapshot" && Array.isArray(f.vpin_readings))).toBe(false);
    server.stop();
  });

  test("does not include vpin_readings when the backfill window has no trades", async () => {
    const storageReader = fakeVpinStorageReader({ tradeRows: [] });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver: fakeTickSizeResolver(),
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();

    expect(client.sent.some((f) => f.type === "snapshot" && Array.isArray(f.vpin_readings))).toBe(false);
    expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
    server.stop();
  });

  test("broadcasts no vpin data at all when no storageReader is configured", async () => {
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      vpinPollMs: 10,
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();

    expect(client.sent.some((f) => f.type === "snapshot" && Array.isArray(f.vpin_readings))).toBe(false);
    expect(client.sent.some((f) => f.type === "vpin")).toBe(false);
    server.stop();
  });

  test("a live poll publishes every bucket sealed by one oversized trade", async () => {
    const tradeRows = [];
    const storageReader = fakeVpinStorageReader({ tradeRows });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver: fakeTickSizeResolver(),
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(tradeRows),
      vpinLivePoll: fakeVpinLivePoll(tradeRows),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await settle();
    client.sent.length = 0;

    tradeRows.push({ event_time: NOW_MS, provider_trade_id: 4, price: 100, size: 25, aggressor_side: "BUY" });
    await settle();

    const frames = client.sent.filter((f) => f.type === "vpin");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(expect.objectContaining({
      type: "vpin",
      provider: "DXFEED",
      symbol: "AAPL",
      assetClass: "EQUITY",
    }));
    server.stop();
  });

  test("switching to a new instrument re-warms vpin for it, not just the first-ever selection", async () => {
    const storageReader = fakeVpinStorageReader();
    const tickSizeResolver = fakeTickSizeResolver();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver,
      vpinPollMs: 10,
      vpinWarmup: fakeVpinWarmup(storageReader.tradeRows),
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(tickSizeResolver.getDxFeedTickSize).toHaveBeenCalledWith("EQUITY", "AAPL");
    await settle();
    client.sent.length = 0;

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    await settle();

    expect(tickSizeResolver.getDxFeedTickSize).toHaveBeenCalledWith("EQUITY", "TSLA");
    const tslaSnapshot = client.sent.find((f) => f.type === "snapshot" && f.symbol === "TSLA" && Array.isArray(f.vpin_readings) && f.vpin_readings.length > 0);
    expect(tslaSnapshot).toBeDefined();
    expect(tslaSnapshot.vpin_readings.length).toBe(6);
    server.stop();
  });

  test("stop awaits workers even after their results were published", async () => {
    const storageReader = fakeVpinStorageReader();
    const jobs = [];
    const vpinWarmup = (input) => {
      let finish;
      const closed = new Promise((resolve) => { finish = resolve; });
      const job = { ...fakeVpinWarmup(storageReader.tradeRows)(input), closed, finish, cancel: jest.fn(() => closed) };
      jobs.push(job);
      return job;
    };
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => fakeConnection(), storageReader, tickSizeResolver: fakeTickSizeResolver(), vpinWarmup }));
    server.start();
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

  test("a warm-up cancelled by switching away never reports failure or clobbers the new instrument's warm-up state", async () => {
    const storageReader = fakeVpinStorageReader();
    const controllableJobs = [];
    const vpinWarmup = jest.fn((input) => {
      if (input.symbol === "AAPL") {
        let rejectFn;
        const promise = new Promise((_resolve, reject) => {
          rejectFn = reject;
        });
        const job = { promise, cancel: jest.fn(() => rejectFn(new Error("vpin warm-up cancelled"))) };
        controllableJobs.push(job);
        return job;
      }
      return fakeVpinWarmup(storageReader.tradeRows)(input);
    });
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => fakeConnection(),
      storageReader,
      tickSizeResolver: fakeTickSizeResolver(),
      vpinPollMs: 10,
      vpinWarmup,
    }));
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    expect(controllableJobs).toHaveLength(1);
    consoleError.mockClear();

    server.handleClientMessage(selectMessage("TSLA", "EQUITY"), client);
    expect(controllableJobs[0].cancel).toHaveBeenCalledTimes(1);
    await settle();

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("vpin worker warm-up failed"),
      expect.anything(),
    );
    const tslaSnapshot = client.sent.find((f) => f.type === "snapshot" && f.symbol === "TSLA" && Array.isArray(f.vpin_readings) && f.vpin_readings.length > 0);
    expect(tslaSnapshot).toBeDefined();
    server.stop();
  });
});

 test("bar capacity failure stops publication through the rest of the current batch", async () => {
   const { createDxFeedBarAggregator } = require("../../src/providers/dxfeed/dxfeed-bar-aggregator");
   const createBarAggregator = () => createDxFeedBarAggregator({ maxTradesPerBar: 1 });
   const connection = fakeConnection();
   const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection, createBarAggregator }));
   server.start();
   const client = fakeClient();
   server.handleClientConnected(client);
   server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
   await driveToChannelOpened(connection);
   client.sent.length = 0;
   connection.channel.emitMessage({ type: "FEED_DATA", data: [1, 2, 3].map((i) => ({ ...AAPL_TIMEANDSALE_ITEM, index: i, sequence: i })) });
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
    const storageReader = { ...fakeStorageReader([]), readAggressivePrintsAsync };
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => fakeConnection(), storageReader, aggressivePoolWarmup: false }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
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
      expect.objectContaining({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY", request_id: 1, complete: true, reason: null, trades: [] }),
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
  const profileWire = (requestId) => JSON.stringify({ type: "delta_profile", request_id: requestId, from_ts: NOW_MS - 60_000, to_ts: NOW_MS, row_width: 0.01 });

  async function selectedClient(readVolumeProfileAsync) {
    const storageReader = { ...fakeStorageReader([]), readVolumeProfileAsync };
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => fakeConnection(), storageReader, aggressivePoolWarmup: false }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await flushProfile();
    client.sent.length = 0;
    return { server, client };
  }

  test("a request is answered through the server with the selected instrument's identity and the rows on the wire", async () => {
    const readVolumeProfileAsync = jest.fn(() => Promise.resolve({ buckets: [{ bucket: 23_012, volume: 300, buyVolume: 200, sellVolume: 100, tradeCount: 2 }], available: true }));
    const { server, client } = await selectedClient(readVolumeProfileAsync);
    server.handleClientMessage(profileWire(1), client);
    await flushProfile();
    expect(readVolumeProfileAsync).toHaveBeenCalledWith("AAPL", "EQUITY", expect.objectContaining({ originPrice: 0, rowWidth: 0.01 }), { signal: expect.any(AbortSignal) });
    expect(client.sent.filter((frame) => frame.type === "delta_profile")).toEqual([
      expect.objectContaining({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY", request_id: 1, complete: true, reason: null, pending: 0, rows: [[230.12, 200, 100]] }),
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
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), other);
    await flushProfile();
    other.sent.length = 0;
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

// Report 57 W2, FA-9 (lazy lifecycle): a session starts mid-minute on every
// selection here, so the open minute is seeded from the stored prints too.
describe("createDxFeedMarketDataServer -- open minute seeded at session start (FA-9)", () => {
  test("does not close a partial first minute while its stored seed is still reading", async () => {
    let resolveRead;
    const readTradesSince = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, now: () => NOW_MS + 30_000,
      requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: new Date(NOW_MS + 30 * 60_000).toISOString() })),
      storageReader: { readTradesSince },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);
    connection.channel.emitMessage({ type: "FEED_DATA", data: [
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 30_000, timeNanoPart: 0, sequence: 3, size: 5 },
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 60_000, timeNanoPart: 0, sequence: 4, size: 6 },
    ] });
    resolveRead({ rows: [
      { id: 1, symbol: "AAPL", asset_class: "EQUITY", event_kind: "NEW", event_time: NOW_MS + 5_000, time: NOW_MS + 5_000, time_nano_part: 0, sequence: 1, price: 230, size: 10, aggressor_side: "BUY", spread_leg: 0, valid_tick: 1 },
      { id: 2, symbol: "AAPL", asset_class: "EQUITY", event_kind: "NEW", event_time: NOW_MS + 10_000, time: NOW_MS + 10_000, time_nano_part: 0, sequence: 2, price: 230, size: 20, aggressor_side: "BUY", spread_leg: 0, valid_tick: 1 },
    ], nextCursor: null, available: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.sent.filter((frame) => frame.type === "bar" && frame.closed && frame.ts_open === NOW_MS).at(-1)).toMatchObject({ volume: 35, trade_count: 3 });
    server.stop();
  });

  test("the first live bar of a new session includes the minute's stored prints, each counted once", async () => {
    const storedPrint = (offsetMs, size, sequence) => ({
      id: sequence, symbol: "AAPL", asset_class: "EQUITY", event_kind: "NEW", event_time: NOW_MS + offsetMs, time: NOW_MS + offsetMs,
      time_nano_part: 0, sequence, price: 230, size, aggressor_side: "BUY", spread_leg: 0, valid_tick: 1,
    });
    const readTradesSince = jest.fn(async () => ({ rows: [storedPrint(5_000, 10, 1), storedPrint(10_000, 20, 2)], nextCursor: null, available: true }));
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({
      createConnection: () => connection, now: () => NOW_MS + 30_000,
      requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: new Date(NOW_MS + 30 * 60_000).toISOString() })),
      storageReader: { readTradesSince },
    }));
    server.start();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    await driveToChannelOpened(connection);
    await new Promise((resolve) => setImmediate(resolve));
    connection.channel.emitMessage({ type: "FEED_DATA", data: [
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 10_000, timeNanoPart: 0, sequence: 2, size: 20 },
      { ...AAPL_TIMEANDSALE_ITEM, time: NOW_MS + 20_000, timeNanoPart: 0, sequence: 3, size: 5 },
    ] });

    expect(readTradesSince).toHaveBeenCalledWith("AAPL", "EQUITY", expect.objectContaining({ fromTs: NOW_MS }));
    expect(client.sent.filter((frame) => frame.type === "bar").at(-1)).toMatchObject({ ts_open: NOW_MS, volume: 35, trade_count: 3 });
    server.stop();
  });
});
