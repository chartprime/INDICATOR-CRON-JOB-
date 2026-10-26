const {
  createBinanceConnection: createBinanceConnectionImpl,
  MAX_WS_MESSAGE_BYTES,
} = require("../../../src/providers/binance/binance-connection");

const activeConnections = new Set();

function createBinanceConnection(options) {
  const connection = createBinanceConnectionImpl(options);
  activeConnections.add(connection);
  return connection;
}

afterEach(() => {
  for (const connection of activeConnections) connection.disconnect();
  activeConnections.clear();
});

function createFakeWebSocketImpl({ autoAcknowledgeControls = true, honorPause = false } = {}) {
  const instances = [];

  class FakeBinanceWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sentMessages = [];
      this.paused = false;
      this.pauseCalls = 0;
      this.resumeCalls = 0;
      this.bufferedMessages = [];
      instances.push(this);
    }

    send(data) {
      if (this.readyState !== 1) {
        throw new Error("FakeBinanceWebSocket: cannot send while not open");
      }
      this.sentMessages.push(data);
      if (autoAcknowledgeControls && this.onmessage) {
        const control = JSON.parse(data);
        this.onmessage({ data: JSON.stringify({ id: control.id, result: null }) });
      }
    }

    close() {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }

    resume() {
      this.resumeCalls += 1;
      this.paused = false;
      if (!honorPause) return;
      while (!this.paused && this.bufferedMessages.length > 0) {
        const data = this.bufferedMessages.shift();
        if (this.onmessage) this.onmessage({ data });
      }
    }

    simulateOpen() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    simulateMessage(data) {
      if (honorPause && this.paused) {
        this.bufferedMessages.push(data);
        return;
      }
      if (this.onmessage) this.onmessage({ data });
    }

    simulateError(error) {
      if (this.onerror) this.onerror(error);
    }

    simulateServerClose() {
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
  }

  return { WebSocketImpl: FakeBinanceWebSocket, instances };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Drain until a condition actually holds rather than for a fixed number of
// turns. A fixed flush encodes an assumption about how much work one tick
// completes, which stops holding under parallel-suite load -- see L1L2-V2-016.
async function flushUntil(predicate, maxTurns = 200) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

function createNetworkDisabledFetchImpl() {
  return jest.fn(async () => {
    throw new Error("network calls are not allowed in this test");
  });
}

function instanceForUrl(instances, urlSuffix) {
  return instances.find((instance) => instance.url.endsWith(urlSuffix));
}

function connectAndOpenAll(connection, instances) {
  connection.connect();
  for (const instance of instances) {
    instance.simulateOpen();
  }
}

describe("binance-connection", () => {
  test("connect() opens one route for spot and two routes for perpetual, at the correct combined-stream URLs", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

    connection.connect();

    expect(instances).toHaveLength(3);
    expect(instances.map((instance) => instance.url).sort()).toEqual([
      "wss://fstream.binance.com/market/stream",
      "wss://fstream.binance.com/public/stream",
      "wss://stream.binance.com/stream",
    ]);
    expect(instances.every((instance) => instance.options.maxPayload === MAX_WS_MESSAGE_BYTES)).toBe(true);
    expect(instances.every((instance) => instance.options.perMessageDeflate === false)).toBe(true);
  });

  test("endpoints.spotWsBaseUrl moves only the SPOT route to the mirror; the PERPETUAL routes keep their fixed origins", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({
      webSocketImpl: WebSocketImpl,
      endpoints: { spotWsBaseUrl: "wss://data-stream.binance.vision:9443" },
    });

    connection.connect();

    expect(instances.map((instance) => instance.url).sort()).toEqual([
      "wss://data-stream.binance.vision:9443/stream",
      "wss://fstream.binance.com/market/stream",
      "wss://fstream.binance.com/public/stream",
    ]);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, endpoints: { spotWsBaseUrl: "https://wrong" } }))
      .toThrow(/TT_BINANCE_SPOT_WS_BASE_URL/);
  });

  test("endpoints.spotRestBaseUrl sends the SPOT depth snapshot to the mirror", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ lastUpdateId: 100, bids: [], asks: [] }), { status: 200 }));
    const connection = createBinanceConnection({
      webSocketImpl: WebSocketImpl,
      fetchImpl,
      endpoints: { spotRestBaseUrl: "https://data-api.binance.vision" },
    });
    connectAndOpenAll(connection, instances);
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "c1");
    await flushUntil(() => fetchImpl.mock.calls.length > 0);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=5000");
  });

  test("getStatus reports CONNECTING, then CONNECTED, then DISCONNECTED per route independently", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

    connection.connect();
    expect(connection.getStatus()).toEqual({
      SPOT: { public: "CONNECTING" },
      PERPETUAL: { public: "CONNECTING", market: "CONNECTING" },
    });

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.simulateOpen();
    expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
    expect(connection.getStatus().PERPETUAL.public).toBe("CONNECTING");

    spotSocket.simulateServerClose();
    expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
  });

  test("connect() is idempotent: calling it twice does not open a second socket per route", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

    connection.connect();
    connection.connect();

    expect(instances).toHaveLength(3);
  });

  test("disconnect() closes every route and reports DISCONNECTED", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    connection.disconnect();

    expect(instances.every((instance) => instance.readyState === 3)).toBe(true);
    expect(connection.getStatus()).toEqual({
      SPOT: { public: "DISCONNECTED" },
      PERPETUAL: { public: "DISCONNECTED", market: "DISCONNECTED" },
    });
  });

  test("subscribe() before the relevant route is connected throws rather than queuing silently", () => {
    const { WebSocketImpl } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

    expect(() =>
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a"),
    ).toThrow(/before the Binance SPOT public route is connected/);
  });

  test("a failed subscribe() rolls back the registry entry, so a later successful subscribe() still reports it as new", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

    expect(() =>
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a"),
    ).toThrow();

    connectAndOpenAll(connection, instances);
    const isNew = connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );

    expect(isNew).toBe(true);
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    expect(spotSocket.sentMessages).toHaveLength(1);
  });

  test("unsubscribe() releases desired state while its route is down, so reconnect cannot resurrect it", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.simulateServerClose();

    expect(
      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a"),
    ).toBe(true);

    connection.connect();
    const reopened = instances.filter((i) => i.url.endsWith("stream.binance.com/stream")).at(-1);
    reopened.simulateOpen();
    expect(reopened.sentMessages).toHaveLength(0);
    expect(connection.unsubscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    )).toBe(false);
  });

  test("subscribe() sends a SUBSCRIBE control message with the correct stream name once connected, and reports it as new", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    const isNew = connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );

    expect(isNew).toBe(true);
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    expect(spotSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(spotSocket.sentMessages[0])).toEqual({
      method: "SUBSCRIBE",
      params: ["btcusdt@trade"],
      id: 1,
    });
  });

  test("subscribeMany() batches all new tuples into one control message per route", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl: createNetworkDisabledFetchImpl() });
    connectAndOpenAll(connection, instances);

    const added = connection.subscribeMany([
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" },
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" },
      { symbol: "ETHUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" },
    ], "collector");

    expect(added).toBe(4);
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    const perpetualMarketSocket = instanceForUrl(instances, "fstream.binance.com/market/stream");
    expect(spotSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(spotSocket.sentMessages[0]).params).toEqual([
      "btcusdt@trade",
      "ethusdt@trade",
      "btcusdt@kline_1m",
    ]);
    expect(perpetualMarketSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(perpetualMarketSocket.sentMessages[0]).params).toEqual(["ethusdt@kline_1m"]);
  });

  test("unsubscribeMany() releases a group in one control message per route", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl: createNetworkDisabledFetchImpl() });
    connectAndOpenAll(connection, instances);
    const requests = [
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" },
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" },
    ];
    connection.subscribeMany(requests, "server");

    expect(connection.unsubscribeMany(requests, "server")).toBe(3);
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    const unsubscribes = spotSocket.sentMessages
      .map((message) => JSON.parse(message))
      .filter((message) => message.method === "UNSUBSCRIBE");
    expect(unsubscribes).toEqual([
      expect.objectContaining({ params: ["btcusdt@trade", "btcusdt@kline_1m", "btcusdt@depth@100ms"] }),
    ]);
  });

  test("a KLINE subscription includes the interval in the wire stream name", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "5m" },
      "consumer-a",
    );

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    expect(JSON.parse(spotSocket.sentMessages[0]).params).toEqual(["btcusdt@kline_5m"]);
  });

  test("the same consumer subscribing twice does not refcount: one unsubscribe fully releases the wire subscription", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    const first = connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );
    const second = connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );
    expect(first).toBe(true);
    expect(second).toBe(false);

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    expect(spotSocket.sentMessages).toHaveLength(1);

    const released = connection.unsubscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );
    expect(released).toBe(true);
    expect(JSON.parse(spotSocket.sentMessages[1])).toEqual(
      expect.objectContaining({ method: "UNSUBSCRIBE", params: ["btcusdt@trade"] }),
    );
  });

  test("a second consumer subscribing to the same already-active tuple reuses it: no second wire message, reported as not new", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    const isNewForSecondConsumer = connection.subscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-b",
    );

    expect(isNewForSecondConsumer).toBe(false);
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    expect(spotSocket.sentMessages).toHaveLength(1);
  });

  test("unsubscribe() sends UNSUBSCRIBE only once the last consumer releases the tuple", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-b");
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.sentMessages.length = 0;

    const releasedByFirst = connection.unsubscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    );
    expect(releasedByFirst).toBe(false);
    expect(spotSocket.sentMessages).toHaveLength(0);

    const releasedByLast = connection.unsubscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-b",
    );
    expect(releasedByLast).toBe(true);
    expect(JSON.parse(spotSocket.sentMessages[0])).toEqual(
      expect.objectContaining({ method: "UNSUBSCRIBE", params: ["btcusdt@trade"] }),
    );
  });

  test("removeConsumer() sends UNSUBSCRIBE for every last-held tuple and leaves shared tuples on the wire", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);

    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-b");
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.sentMessages.length = 0;

    const released = connection.removeConsumer("consumer-a");
    expect(released).toEqual([
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
    ]);
    expect(spotSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(spotSocket.sentMessages[0])).toEqual(
      expect.objectContaining({ method: "UNSUBSCRIBE", params: ["btcusdt@trade"] }),
    );

    const releasedShared = connection.unsubscribe(
      { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-b",
    );
    expect(releasedShared).toBe(true);
  });

  test("removeConsumer() releases desired state while its route is down, so reconnect cannot resurrect it", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.simulateServerClose();

    expect(connection.removeConsumer("consumer-a")).toEqual([
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
    ]);

    connection.connect();
    const reopened = instances.filter((i) => i.url.endsWith("stream.binance.com/stream")).at(-1);
    reopened.simulateOpen();
    expect(reopened.sentMessages).toHaveLength(0);
    expect(connection.unsubscribe(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      "consumer-a",
    )).toBe(false);
  });

  test("a removeConsumer() send failure releases every tuple locally and forces a clean reconnect", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
    spotSocket.sentMessages.length = 0;
    const realSend = spotSocket.send.bind(spotSocket);
    let sendCount = 0;
    spotSocket.send = (data) => {
      sendCount += 1;
      if (sendCount === 2) {
        throw new Error("simulated mid-loop send failure");
      }
      realSend(data);
    };

    expect(connection.removeConsumer("consumer-a")).toEqual([
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" },
    ]);
    expect(spotSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(spotSocket.sentMessages[0])).toEqual(
      expect.objectContaining({ method: "UNSUBSCRIBE", params: ["btcusdt@trade"] }),
    );

    expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
    connection.connect();
    const reopened = instances.filter((i) => i.url.endsWith("stream.binance.com/stream")).at(-1);
    reopened.simulateOpen();

    // Neither tuple can be resurrected after a partially failed control write.
    expect(
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-c"),
    ).toBe(true);
    expect(
      connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-c"),
    ).toBe(true);
  });

  test("a missing, empty, or non-string consumerId is rejected on every consumer-scoped entry point", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

    for (const badId of ["", undefined, null, 42, {}, ["consumer-a"]]) {
      expect(() => connection.subscribe(request, badId)).toThrow(/non-empty consumerId/);
      expect(() => connection.unsubscribe(request, badId)).toThrow(/non-empty consumerId/);
      expect(() => connection.removeConsumer(badId)).toThrow(/non-empty consumerId/);
    }
    expect(spotSocket.sentMessages).toHaveLength(0);

    expect(connection.subscribe(request, "consumer-a")).toBe(true);
    expect(spotSocket.sentMessages).toHaveLength(1);

    // Rejection must happen before registry mutation: a live last-holder
    // must still be last-holder after every bad unsubscribe / removeConsumer.
    for (const badId of ["", undefined, null, 42, {}, ["consumer-a"]]) {
      expect(() => connection.unsubscribe(request, badId)).toThrow(/non-empty consumerId/);
      expect(() => connection.removeConsumer(badId)).toThrow(/non-empty consumerId/);
    }
    expect(spotSocket.sentMessages).toHaveLength(1);
    expect(connection.unsubscribe(request, "consumer-a")).toBe(true);
  });

  test("subscribe() and unsubscribe() work on an already-connected route without any reconnect", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl();
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    const socketCountBefore = instances.length;

    connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
    connection.unsubscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

    expect(instances).toHaveLength(socketCountBefore);
    expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
  });

  test("too many unacknowledged control commands reset only the saturated route", () => {
    const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
    const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
    connectAndOpenAll(connection, instances);
    const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
    const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

    for (let index = 0; index < 50; index += 1) {
      expect(connection.subscribe(request, "consumer-a")).toBe(true);
      expect(connection.unsubscribe(request, "consumer-a")).toBe(true);
    }

    expect(spotSocket.sentMessages).toHaveLength(100);
    expect(() => connection.subscribe(request, "consumer-a")).toThrow(/Too many unacknowledged/);
    expect(connection.getStatus()).toEqual({
      SPOT: { public: "DISCONNECTED" },
      PERPETUAL: { public: "CONNECTED", market: "CONNECTED" },
    });
  });

  describe("perpetual routing: KLINE on /market, TRADE/BOOK_TICKER/DEPTH on /public", () => {
    test("routes KLINE to the market route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe(
        { symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" },
        "consumer-a",
      );

      const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");
      const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
      expect(marketRoute.sentMessages).toHaveLength(1);
      expect(publicRoute.sentMessages).toHaveLength(0);
    });

    test("routes TRADE, BOOK_TICKER, and DEPTH to the public route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        fetchImpl: createNetworkDisabledFetchImpl(),
      });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "BOOK_TICKER" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "DEPTH" }, "consumer-a");

      const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");
      const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
      expect(publicRoute.sentMessages).toHaveLength(3);
      expect(marketRoute.sentMessages).toHaveLength(0);
      connection.disconnect();
    });

    test("both BTCUSDT and ETHUSDT share the same route sockets, not separate sockets per symbol", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      expect(instances).toHaveLength(3);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      expect(spotSocket.sentMessages).toHaveLength(2);
      expect(JSON.parse(spotSocket.sentMessages[0]).params).toEqual(["btcusdt@trade"]);
      expect(JSON.parse(spotSocket.sentMessages[1]).params).toEqual(["ethusdt@trade"]);
    });
  });

  describe("incoming raw message handling", () => {
    const REAL_SPOT_TRADE = {
      e: "trade", E: 1786444824142, s: "BTCUSDT", t: 6567786021,
      p: "64275.99000000", q: "0.00206000", T: 1786444824142, m: false, M: true,
    };

    test("a message for an active subscription is dispatched to onMessage listeners as a normalized canonical envelope", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      await flushAsync();

      expect(received).toHaveLength(1);
      // A fresh subscribe() calls feedHealth.beginRecovery() before any wire
      // data has arrived. This message is a valid trade, so recordEvent
      // clears recovery and the dispatched envelope is recomputed after
      // that — the first healthy event reports READY on itself.
      expect(received[0]).toEqual(
        expect.objectContaining({
          provider: "BINANCE",
          venue: "BINANCE",
          marketKind: "SPOT",
          providerSymbol: "BTCUSDT",
          eventType: "TRADE",
          timingClass: "REALTIME",
          stale: false,
          recoveryState: "READY",
          payload: {
            tradeId: 6567786021,
            price: "64275.99000000",
            quantity: "0.00206000",
            isBuyerMaker: false,
          },
        }),
      );
      expect(typeof received[0].receivedAt).toBe("string");
      expect(typeof received[0].eventTime).toBe("string");

      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      await flushAsync();
      expect(received[1]).toEqual(expect.objectContaining({ stale: false, recoveryState: "READY" }));
    });

    test("a malformed message for an active subscription still reaches onMessage listeners, as an explicit degraded envelope, not a silent drop", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      const withoutPrice = { ...REAL_SPOT_TRADE };
      delete withoutPrice.p;
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: withoutPrice }));
      await flushAsync();

      expect(received).toHaveLength(1);
      // Same fresh-subscribe beginRecovery as the healthy-envelope test
      // above -- and this message is malformed, so it never reaches
      // recordEvent() at all (state !== "UNAVAILABLE" gates it), meaning
      // recovery stays open and the dispatched envelope still reports it.
      expect(received[0]).toEqual({
        provider: "BINANCE",
        venue: "BINANCE",
        marketKind: "SPOT",
        providerSymbol: "BTCUSDT",
        eventType: "TRADE",
        receivedAt: received[0].receivedAt,
        timingClass: "REALTIME",
        stale: true,
        recoveryState: "RECOVERING",
        state: "UNAVAILABLE",
        reason: "MISSING_OR_INVALID_REQUIRED_FIELD",
        missingFields: ["price"],
      });
    });

    test("a combined-stream envelope with a stream name but no data field at all degrades cleanly, not a crash", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      expect(() =>
        spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade" })),
      ).not.toThrow();
      await flushAsync();
      expect(received).toHaveLength(1);
      expect(received[0].state).toBe("UNAVAILABLE");
      expect(received[0].reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("a trade arriving on the spot socket is tagged SPOT even when the same symbol is also subscribed on perpetual", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      await flushAsync();

      expect(received).toHaveLength(1);
      expect(received[0].marketKind).toBe("SPOT");
      expect(received[0].providerSymbol).toBe("BTCUSDT");
    });

    test("a subscribed stream arriving on the wrong market-kind route is rejected", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const marketSocket = instanceForUrl(instances, "fstream.binance.com/market/stream");
      marketSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      await flushAsync();

      expect(received).toEqual([]);
      expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "TRADE")).toEqual({
        stale: true,
        recoveryState: "RECOVERING",
      });
    });

    test("a message for a stream nobody is actively subscribed to is not dispatched", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: { p: "123.45" } }));

      expect(received).toHaveLength(0);
    });

    test("a default-cadence depth wrapper cannot masquerade as the subscribed 100ms L2 stream", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        fetchImpl: createNetworkDisabledFetchImpl(),
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      const received = [];
      connection.onMessage((payload) => received.push(payload));

      instanceForUrl(instances, "stream.binance.com/stream").simulateMessage(JSON.stringify({
        stream: "btcusdt@depth",
        data: {},
      }));

      expect(received).toEqual([]);
      await flushAsync();
      expect(connection.getOperationalStats().depthSnapshotRetryTimers).toBe(1);
      connection.disconnect();
      expect(connection.getOperationalStats().depthSnapshotRetryTimers).toBe(0);
    });

    test("malformed JSON is rejected without throwing", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      expect(() => spotSocket.simulateMessage("{not json")).not.toThrow();
    });

    test("an oversized frame is rejected without throwing", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      const oversized = JSON.stringify({ stream: "btcusdt@trade", data: "x".repeat(300_000) });

      expect(() => spotSocket.simulateMessage(oversized)).not.toThrow();
    });

    test("a control-message error response for a pending command notifies error listeners and reconnects the affected route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const errors = [];
      connection.onError((payload) => errors.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      const id = JSON.parse(spotSocket.sentMessages[0]).id;
      spotSocket.simulateMessage(JSON.stringify({ id, error: { code: -1121, msg: "Invalid symbol" } }));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ marketKind: "SPOT", route: "public", code: -1121 }),
      );
      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
    });

    test("an unsolicited control-shaped frame cannot close a healthy route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const errors = [];
      connection.onError((payload) => errors.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({ id: 99_999, code: -1121, msg: "Invalid symbol" }));

      expect(errors).toHaveLength(0);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
    });

    test("a successful control acknowledgement consumes its id, so a replayed error cannot close the route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const errors = [];
      connection.onError((payload) => errors.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      const id = JSON.parse(spotSocket.sentMessages[0]).id;
      spotSocket.simulateMessage(JSON.stringify({ id, result: null }));
      spotSocket.simulateMessage(JSON.stringify({ id, code: -1121, msg: "Invalid symbol" }));

      expect(errors).toHaveLength(0);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
    });

    test.each([
      [{ result: "accepted" }, "non-null result"],
      [{ result: null, unexpected: true }, "unexpected fields"],
    ])("a pending control acknowledgement with %s is rejected as a protocol violation", (ackFields) => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const errors = [];
      connection.onError((payload) => errors.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      const id = JSON.parse(spotSocket.sentMessages[0]).id;

      spotSocket.simulateMessage(JSON.stringify({ id, ...ackFields }));

      expect(errors).toEqual([expect.objectContaining({ code: "INVALID_CONTROL_ACK" })]);
      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
    });

    test("a stream payload carrying a pending control id cannot spoof an acknowledgement", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      const id = JSON.parse(spotSocket.sentMessages[0]).id;

      spotSocket.simulateMessage(JSON.stringify({ id, stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      spotSocket.simulateMessage(JSON.stringify({ id, code: -1121, msg: "Invalid symbol" }));

      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
    });

    test("an unacknowledged control message times out and rebuilds only its route", () => {
      jest.useFakeTimers();
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        const errors = [];
        connection.onError((payload) => errors.push(payload));
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        jest.advanceTimersByTime(10_000);

        expect(errors).toEqual([
          expect.objectContaining({
            marketKind: "SPOT",
            route: "public",
            message: "Binance did not acknowledge a control message before the deadline.",
          }),
        ]);
        expect(connection.getStatus()).toEqual({
          SPOT: { public: "DISCONNECTED" },
          PERPETUAL: { public: "CONNECTED", market: "CONNECTED" },
        });
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a !serverShutdown message closes only that route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
      const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");
      marketRoute.simulateMessage(JSON.stringify({ stream: "!serverShutdown", data: {} }));

      expect(connection.getStatus().PERPETUAL).toEqual({ public: "CONNECTED", market: "DISCONNECTED" });
      expect(publicRoute.readyState).toBe(1);
    });
  });

  describe("reconnect and resubscription", () => {
    function latestInstanceForUrl(instances, urlSuffix) {
      const matches = instances.filter((instance) => instance.url.endsWith(urlSuffix));
      return matches[matches.length - 1];
    }

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test("an unexpected close schedules a reconnect that reopens the route", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();
      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");

      jest.advanceTimersByTime(1500);
      expect(instances.filter((i) => i.url.endsWith("stream.binance.com/stream"))).toHaveLength(2);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTING");
    });

    test("connect() after an explicit disconnect() resubscribes previously-active tuples on the new sockets", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      connection.disconnect();
      connection.connect();

      const reopened = latestInstanceForUrl(instances, "stream.binance.com/stream");
      reopened.simulateOpen();

      expect(reopened.sentMessages).toHaveLength(1);
      const message = JSON.parse(reopened.sentMessages[0]);
      expect(message.method).toBe("SUBSCRIBE");
      expect(message.params.sort()).toEqual(["btcusdt@trade", "ethusdt@trade"]);
    });

    test("a WebSocket constructor failure does not leave the route stuck CONNECTING", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let remainingFailures = 3;
      function FlakyWebSocket(url) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("handshake failed");
        }
        return new WebSocketImpl(url);
      }
      const connection = createBinanceConnection({ webSocketImpl: FlakyWebSocket });

      connection.connect();
      expect(connection.getStatus()).toEqual({
        SPOT: { public: "DISCONNECTED" },
        PERPETUAL: { public: "DISCONNECTED", market: "DISCONNECTED" },
      });
      expect(instances).toHaveLength(0);

      jest.advanceTimersByTime(1500);
      expect(instances).toHaveLength(3);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTING");
    });

    test("a throwing telemetry sink does not skip resubscribe-on-reconnect", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry: () => {
          throw new Error("sink down");
        },
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();
      jest.advanceTimersByTime(1500);

      const reopened = latestInstanceForUrl(instances, "stream.binance.com/stream");
      expect(() => reopened.simulateOpen()).not.toThrow();
      expect(JSON.parse(reopened.sentMessages[0])).toEqual(
        expect.objectContaining({ method: "SUBSCRIBE", params: ["btcusdt@trade"] }),
      );
    });

    test("a resubscribe send() failure closes the route and schedules reconnect instead of sitting CONNECTED with an empty wire", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();
      jest.advanceTimersByTime(1500);

      const reopened = latestInstanceForUrl(instances, "stream.binance.com/stream");
      reopened.send = () => {
        throw new Error("send failed");
      };
      reopened.simulateOpen();
      await Promise.resolve();

      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");

      jest.advanceTimersByTime(3000);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTING");
      expect(instances.filter((i) => i.url.endsWith("stream.binance.com/stream")).length).toBeGreaterThan(2);
    });

    test("a reconnect resubscribes every previously-active subscription on that route in one batched message", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.sentMessages.length = 0;
      spotSocket.simulateServerClose();
      jest.advanceTimersByTime(1500);

      const reopened = latestInstanceForUrl(instances, "stream.binance.com/stream");
      reopened.simulateOpen();

      expect(reopened.sentMessages).toHaveLength(1);
      const message = JSON.parse(reopened.sentMessages[0]);
      expect(message.method).toBe("SUBSCRIBE");
      expect(message.params.sort()).toEqual(["btcusdt@trade", "ethusdt@trade"]);
    });

    test("a route with no active subscriptions sends nothing on reconnect", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();
      jest.advanceTimersByTime(1500);
      const reopened = latestInstanceForUrl(instances, "stream.binance.com/stream");
      reopened.simulateOpen();

      expect(reopened.sentMessages).toHaveLength(0);
    });

    test("PERPETUAL's two routes reconnect and resubscribe fully independently -- dropping 'market' never touches 'public'", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");
      connection.subscribe(
        { symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" },
        "consumer-a",
      );

      const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
      const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");
      publicRoute.sentMessages.length = 0;
      marketRoute.sentMessages.length = 0;

      marketRoute.simulateServerClose();
      expect(connection.getStatus().PERPETUAL).toEqual({ public: "CONNECTED", market: "DISCONNECTED" });
      expect(publicRoute.readyState).toBe(1);

      jest.advanceTimersByTime(1500);
      const reopenedMarket = latestInstanceForUrl(instances, "fstream.binance.com/market/stream");
      reopenedMarket.simulateOpen();

      expect(reopenedMarket.sentMessages).toHaveLength(1);
      expect(JSON.parse(reopenedMarket.sentMessages[0])).toEqual(
        expect.objectContaining({ method: "SUBSCRIBE", params: ["btcusdt@kline_1m"] }),
      );
      expect(publicRoute.sentMessages).toHaveLength(0);
      expect(connection.getStatus().PERPETUAL).toEqual({ public: "CONNECTED", market: "CONNECTED" });
    });

    test("a reconnect whose handshake never completes is abandoned and retried, so a route cannot sit CONNECTING forever", () => {
      // FA-1: on the host, PERPETUAL public reconnected at 14:34:50 and then
      // never logged again for 11 h while spot kept cycling. A socket stuck in
      // CONNECTING has no watchdog (it starts on open) and no reconnect timer.
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");
      const publicAttempts = () => instances.filter((i) => i.url.endsWith("fstream.binance.com/public/stream"));

      instanceForUrl(instances, "fstream.binance.com/public/stream").simulateServerClose();
      jest.advanceTimersByTime(1500);
      const hung = latestInstanceForUrl(instances, "fstream.binance.com/public/stream");
      expect(publicAttempts()).toHaveLength(2);
      expect(connection.getStatus().PERPETUAL.public).toBe("CONNECTING");

      jest.advanceTimersByTime(30_000);
      expect(hung.readyState).toBe(3);
      expect(connection.getStatus().PERPETUAL.public).toBe("DISCONNECTED");

      jest.advanceTimersByTime(5_000);
      expect(publicAttempts()).toHaveLength(3);
      const retried = latestInstanceForUrl(instances, "fstream.binance.com/public/stream");
      expect(connection.getStatus().PERPETUAL.public).toBe("CONNECTING");
      retried.simulateOpen();
      expect(connection.getStatus().PERPETUAL.public).toBe("CONNECTED");
      expect(JSON.parse(retried.sentMessages.at(-1))).toEqual(
        expect.objectContaining({ method: "SUBSCRIBE", params: ["btcusdt@trade"] }),
      );
    });

    test("no reconnect is ever scheduled after an explicit disconnect()", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      connection.disconnect();
      jest.advanceTimersByTime(60_000);

      expect(instances).toHaveLength(3);
    });

    test("a reconnect already pending (scheduled) before an explicit disconnect() never fires", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();

      connection.disconnect();
      jest.advanceTimersByTime(60_000);

      expect(instances).toHaveLength(3);
    });

    test("reconnect backoff grows across consecutive attempts and stays within the max delay", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, telemetry });
      connectAndOpenAll(connection, instances);

      const scheduledDelays = () =>
        telemetry.mock.calls
          .map((call) => call[0])
          .filter((entry) => entry.event === "market_data.binance_connection.route_reconnect_scheduled")
          .map((entry) => entry.delayMs);

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();
      const [firstDelay] = scheduledDelays();

      jest.advanceTimersByTime(30_000);
      const secondAttempt = latestInstanceForUrl(instances, "stream.binance.com/stream");
      secondAttempt.simulateServerClose();
      const secondDelay = scheduledDelays().at(-1);

      expect(secondDelay).toBeGreaterThan(firstDelay);
      expect(secondDelay).toBeLessThanOrEqual(30_000 * 1.2);
    });

    test("a TCP open that flaps before the stability window does not reset reconnect backoff", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        reconnectStabilityMs: 30_000,
      });
      connectAndOpenAll(connection, instances);
      const scheduledDelays = () => telemetry.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry.event === "market_data.binance_connection.route_reconnect_scheduled")
        .map((entry) => entry.delayMs);

      instanceForUrl(instances, "stream.binance.com/stream").simulateServerClose();
      const firstDelay = scheduledDelays().at(-1);
      jest.advanceTimersByTime(2_000);
      const reconnect = latestInstanceForUrl(instances, "stream.binance.com/stream");
      reconnect.simulateOpen();
      reconnect.simulateServerClose();

      expect(scheduledDelays().at(-1)).toBeGreaterThan(firstDelay);
    });

    test("reconnect backoff resets to a fresh delay after an explicit disconnect(), even if the new session's first attempt also fails", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, telemetry });
      connectAndOpenAll(connection, instances);

      const spotDelays = () =>
        telemetry.mock.calls
          .map((call) => call[0])
          .filter(
            (entry) =>
              entry.event === "market_data.binance_connection.route_reconnect_scheduled" &&
              entry.marketKind === "SPOT",
          )
          .map((entry) => entry.delayMs);

      let spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      for (let i = 0; i < 5; i += 1) {
        spotSocket.simulateServerClose();
        jest.advanceTimersByTime(40_000);
        spotSocket = latestInstanceForUrl(instances, "stream.binance.com/stream");
      }
      expect(spotDelays().at(-1)).toBeGreaterThan(10_000);

      connection.disconnect();
      connection.connect();
      const freshSocket = latestInstanceForUrl(instances, "stream.binance.com/stream");
      freshSocket.simulateServerClose();

      expect(spotDelays().at(-1)).toBeLessThan(2_000);
    });
  });

  describe("listener management", () => {
    test("onMessage returns an unsubscribe function that stops further delivery", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const received = [];
      const stop = connection.onMessage((payload) => received.push(payload));
      stop();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: {} }));

      expect(received).toHaveLength(0);
    });

    test("a throwing listener does not prevent other listeners from receiving the message", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const received = [];
      connection.onMessage(() => {
        throw new Error("boom");
      });
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      // Delivery is deferred through the backpressure drain now, so the
      // throw (safely contained by notifyMessageListeners either way)
      // happens inside the setImmediate tick, not synchronously here.
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: {} }));
      await flushAsync();

      expect(received).toHaveLength(1);
    });

    test("onMessage refuses to register more than 50 listeners, and a released slot can be reused", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

      const stops = [];
      for (let i = 0; i < 50; i += 1) {
        stops.push(connection.onMessage(() => {}));
      }
      expect(() => connection.onMessage(() => {})).toThrow(/more than 50/);

      // The cap is on live registrations, not on lifetime count: releasing
      // one frees exactly one slot back up.
      stops[0]();
      expect(() => connection.onMessage(() => {})).not.toThrow();
      expect(() => connection.onMessage(() => {})).toThrow(/more than 50/);
    });

    test("listener registration rejects non-functions and remains idempotent at capacity", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      const listener = () => {};

      expect(() => connection.onMessage(null)).toThrow(/must be a function/);
      expect(() => connection.onError({})).toThrow(/must be a function/);
      connection.onMessage(listener);
      for (let i = 0; i < 49; i += 1) connection.onMessage(() => {});
      expect(() => connection.onMessage(listener)).not.toThrow();
    });

    test("onError enforces its own 50-listener cap independently of onMessage's", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

      const stops = [];
      for (let i = 0; i < 50; i += 1) {
        stops.push(connection.onError(() => {}));
      }
      expect(() => connection.onError(() => {})).toThrow(/more than 50/);

      // Filling the error set must not have consumed any message-listener slots.
      expect(() => connection.onMessage(() => {})).not.toThrow();

      stops[0]();
      expect(() => connection.onError(() => {})).not.toThrow();
      expect(() => connection.onError(() => {})).toThrow(/more than 50/);
    });
  });

  describe("backpressure (non-DEPTH delivery is deferred, DEPTH stays synchronous)", () => {
    function tradeMessage(symbol, tradeId) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@trade`,
        data: { e: "trade", E: 1, s: symbol, t: tradeId, p: "1.0", q: "1.0", T: 1, m: false, M: true },
      });
    }

    function klineMessage(symbol, interval) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@kline_${interval}`,
        data: {
          e: "kline",
          E: 1,
          s: symbol,
          k: {
            t: 1, T: 2, s: symbol, i: interval, f: 1, L: 1,
            o: "1.0", c: "1.0", h: "1.0", l: "1.0", v: "1.0", n: 1,
            x: false, q: "1.0", V: "1.0", Q: "1.0", B: "0",
          },
        },
      });
    }

    function depthMessage(symbol, U, u) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@depth@100ms`,
        data: { e: "depthUpdate", E: Date.now(), s: symbol, U, u, b: [], a: [] },
      });
    }

    function bookTickerMessage(symbol, updateId) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@bookTicker`,
        data: { u: updateId, s: symbol, b: "1.0", B: "1.0", a: "1.0", A: "1.0" },
      });
    }

    test("BOOK_TICKER delivery is deferred through the same queue as TRADE and KLINE", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "BOOK_TICKER" }, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      spotSocket.simulateMessage(bookTickerMessage("BTCUSDT", 1));
      expect(received).toEqual([]);

      await flushAsync();
      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe("BOOK_TICKER");
      expect(received[0].payload.updateId).toBe(1);
    });

    test("a non-last-holder unsubscribe from a queued BOOK_TICKER leaves the shared queue and delivery to the remaining consumer untouched", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "BOOK_TICKER" };
      connection.subscribe(request, "consumer-a");
      connection.subscribe(request, "consumer-b");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(bookTickerMessage("BTCUSDT", 1));

      connection.unsubscribe(request, "consumer-a");

      const received = [];
      connection.onMessage((payload) => received.push(payload));
      await flushAsync();

      expect(received).toHaveLength(1);
      expect(received[0].payload.updateId).toBe(1);
    });

    test("TRADE delivery is deferred one setImmediate tick; DEPTH stays synchronous", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        fetchImpl: createNetworkDisabledFetchImpl(),
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const received = [];
      connection.onMessage((payload) => received.push(payload.eventType));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 1));
      expect(received).toEqual([]);

      spotSocket.simulateMessage(depthMessage("BTCUSDT", 1, 1));
      expect(received).toEqual(["DEPTH"]);

      await flushAsync();
      expect(received).toEqual(["DEPTH", "TRADE"]);

      // The network-disabled fetch means the DEPTH subscribe above armed a
      // real (non-faked) snapshot retry timer that would fire ~1s from now,
      // fail again, and schedule a further retry -- logging telemetry long
      // after this test is done. Disconnect so the retry's generation guard
      // no-ops it instead.
      connection.disconnect();
    });

    test("a listener that disconnects mid-batch stops the rest of that already-detached batch from being delivered", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const delivered = [];
      connection.onMessage((payload) => {
        delivered.push(payload.payload.tradeId);
        if (delivered.length === 1) {
          connection.disconnect();
        }
      });
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 1));
      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 2));

      await flushAsync();

      expect(delivered).toEqual([1]);
    });

    test("a listener that unsubscribes mid-batch stops the rest of that already-detached batch from being delivered", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
      const delivered = [];
      connection.onMessage((payload) => {
        delivered.push(payload.payload.tradeId);
        if (delivered.length === 1) {
          connection.unsubscribe(request, "consumer-a");
        }
      });
      connection.subscribe(request, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 1));
      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 2));

      await flushAsync();

      expect(delivered).toEqual([1]);
    });

    test("a listener that unsubscribes and immediately resubscribes mid-batch does not deliver the rest of the old batch into the new subscription", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
      const delivered = [];
      connection.onMessage((payload) => {
        delivered.push(payload.payload.tradeId);
        if (delivered.length === 1) {
          connection.unsubscribe(request, "consumer-a");
          connection.subscribe(request, "consumer-a");
        }
      });
      connection.subscribe(request, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      const trade = (tradeId) => JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", E: 1, s: "BTCUSDT", t: tradeId, p: "1.0", q: "1.0", T: 1, m: false, M: true },
      });
      spotSocket.simulateMessage(trade(1));
      spotSocket.simulateMessage(trade(2));
      spotSocket.simulateMessage(trade(3));

      await flushAsync();
      expect(delivered).toEqual([1]);

      spotSocket.simulateMessage(tradeMessage("BTCUSDT", 4));
      await flushAsync();
      expect(delivered).toEqual([1, 4]);
    });

    test("an unexpected disconnect preserves queued events from both the affected and unaffected PERPETUAL routes", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");
      connection.subscribe(
        { symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" },
        "consumer-a",
      );

      const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
      const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");

      // Queue one event on each route, then drop only the market route
      // before either has drained.
      publicRoute.simulateMessage(tradeMessage("BTCUSDT", 1));
      marketRoute.simulateMessage(klineMessage("BTCUSDT", "1m"));
      marketRoute.simulateServerClose();

      const received = [];
      connection.onMessage((payload) => received.push(payload.eventType));
      await flushAsync();

      expect(received).toEqual(["TRADE", "KLINE"]);
    });

    test("a busy TRADE stream cannot starve a queued KLINE out of the same drain tick", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe(
        { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" },
        "consumer-a",
      );

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      for (let i = 0; i < 1000; i += 1) {
        spotSocket.simulateMessage(tradeMessage("BTCUSDT", i));
      }
      spotSocket.simulateMessage(klineMessage("BTCUSDT", "1m"));

      const received = [];
      connection.onMessage((payload) => received.push(payload.eventType));
      await flushUntil(() => received.includes("KLINE"));

      // Fair share hands the single KLINE through after roughly 25 trades, not
      // behind all 1000. Asserting its POSITION rather than "arrived within one
      // drain tick" keeps the starvation check meaningful without depending on
      // how much work a single tick completes under load.
      const klineIndex = received.indexOf("KLINE");
      expect(klineIndex).toBeGreaterThanOrEqual(0);
      expect(klineIndex).toBeLessThan(100);

      // TRADE's own 500-deep queue is nowhere near fully drained yet (fair
      // share keeps splitting budget with KLINE's now-empty but still-
      // registered entry) -- disconnect to clear the remaining backlog
      // instead of leaving dozens of further drain ticks scheduled past
      // the end of this test.
      connection.disconnect();
    });

    test("a queued event's stale/recoveryState reflects delivery time, not arrival time", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        // First trade: arrives and drains (to no listeners yet) at the
        // current fake time, recordEvent stamping lastReceivedAtMs then.
        spotSocket.simulateMessage(tradeMessage("BTCUSDT", 1));
        await flushAsync();

        // Second trade: recordEvent fires on arrival (same fake "now" as
        // above) and it gets queued, but the clock jumps past TRADE's 30s
        // stale threshold *before* the drain tick actually runs -- setImmediate
        // itself is real (doNotFake), so this only moves what Date.now()
        // reports, not when the already-scheduled drain fires.
        spotSocket.simulateMessage(tradeMessage("BTCUSDT", 2));
        jest.setSystemTime(Date.now() + 30_001);

        const received = [];
        connection.onMessage((payload) => received.push(payload));
        await flushAsync();

        expect(received).toHaveLength(1);
        expect(received[0].payload.tradeId).toBe(2);
        expect(received[0].stale).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("depth order-book assembly", () => {
    function jsonResponse(body) {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    async function flushAsync() {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    function depthWireMessage({ symbol, U, u, pu, b = [], a = [] }) {
      const data = { e: "depthUpdate", E: Date.now(), s: symbol, U, u, b, a };
      if (pu !== undefined) {
        data.pu = pu;
      }
      return JSON.stringify({ stream: `${symbol.toLowerCase()}@depth@100ms`, data });
    }

    test("subscribing to DEPTH fetches a REST snapshot and applies it to a fresh book assembler", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toEqual({
        ok: true,
        value: {
          status: 200,
          headers: expect.any(Object),
          body: { lastUpdateId: 100, bids: [], asks: [] },
        },
      });
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });
    });

    test("a live delta bridging the snapshot brings the book to READY", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "READY",
        book: { bids: [], asks: [], lastUpdateId: 105 },
      });
    });

    test("a detected sequence gap on an established book triggers a fresh snapshot request", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 200, u: 205 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE",
        reason: "SEQUENCE_GAP",
      });

      await flushAsync();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // The gap snapshot (lastUpdateId 100) cannot bridge U=200, so the
      // assembler stays UNAVAILABLE and the connection now schedules a
      // retry. Tear down so that timer cannot leak past this test.
      connection.disconnect();
    });

    test("the hard retained-level cap remains a fail-safe if an in-flight proactive refresh cannot complete first", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const snapshotLevels = Array.from({ length: 5000 }, (_, index) => [`${index + 1}`, "1"]);
      const firstDeltaLevels = Array.from({ length: 5000 }, (_, index) => [`${index + 5001}`, "1"]);
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: snapshotLevels, asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl, telemetry });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 101, b: firstDeltaLevels }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 102, u: 102, b: [["10001", "1"]] }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE",
        reason: "BOOK_LEVEL_CAP_EXCEEDED",
      });

      await flushAsync();
      // Initial snapshot + proactive soft-cap refresh + hard-cap recovery.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(telemetry.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "market_data.binance_connection.depth_gap_recovery_attempt",
          reason: "BOOK_LEVEL_CAP_EXCEEDED",
        }),
      ]));
      connection.disconnect();
    });

    test("a gap detected while already UNAVAILABLE does not trigger a second re-snapshot request for the same episode", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 200, u: 205 }));
      await flushAsync();
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 300, u: 305 }));
      await flushAsync();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      connection.disconnect();
    });

    test("unsubscribing from DEPTH clears the book assembler, snapshot, and request epoch", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeDefined();

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("removeConsumer() on the last DEPTH holder clears the book assembler the same way unsubscribe does", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeDefined();

      const released = connection.removeConsumer("consumer-a");
      expect(released).toEqual([{ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }]);
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("a non-last-holder unsubscribe from DEPTH leaves the shared book assembler untouched for the remaining consumer", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-b");
      await flushAsync();
      const bookBefore = connection.getOrderBook("SPOT", "BTCUSDT");
      expect(bookBefore).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual(bookBefore);
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeDefined();

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-b");
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("SPOT and PERPETUAL DEPTH book state for the same symbol never bleed into each other", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async (url) =>
        jsonResponse({
          lastUpdateId: String(url).includes("fapi.binance.com") ? 200 : 100,
          bids: [],
          asks: [],
        }),
      );
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(100);
      expect(connection.getDepthSnapshot("PERPETUAL", "BTCUSDT").value.body.lastUpdateId).toBe(200);

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getOrderBook("PERPETUAL", "BTCUSDT")).toBeDefined();
    });

    test("getOrderBook and getDepthSnapshot return undefined for a symbol never subscribed to DEPTH", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("disconnect() clears book-assembler state for every symbol", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeDefined();

      connection.disconnect();

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("a stale REST response from before an unsubscribe/resubscribe cycle is discarded, not applied to the new assembler", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let resolveFirstFetch;
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstFetch = resolve;
            }),
        )
        .mockImplementation(async () => jsonResponse({ lastUpdateId: 500, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(500);

      resolveFirstFetch(jsonResponse({ lastUpdateId: 1, bids: [["1.0", "1.0"]], asks: [] }));
      await flushAsync();

      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(500);
    });

    test("a failed snapshot fetch is recorded but leaves the book assembler intact rather than corrupting it", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => {
          throw new Error("ECONNRESET");
        });
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toEqual({ ok: false, reason: "NETWORK_ERROR" });
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });

        // Disconnect (rather than letting the scheduled retry run out the clock
        // on a real network-disabled mock) so the pending retry's own guard
        // no-ops it cleanly instead of leaving a dangling timer behind.
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a 200 snapshot the assembler rejects as malformed schedules a retry, not a dead end", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => jsonResponse({ bids: [], asks: [] }))
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "UNAVAILABLE",
          reason: "SNAPSHOT_MALFORMED",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1500);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });
      } finally {
        jest.useRealTimers();
      }
    });

    test("a 200 snapshot too old to bridge already-buffered deltas schedules a retry, not a dead end", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveFirstFetch;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveFirstFetch = resolve;
              }),
          )
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 500, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 200, u: 210 }));

        resolveFirstFetch(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        await flushAsync();
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "UNAVAILABLE",
          reason: "SNAPSHOT_TOO_OLD",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1500);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });
      } finally {
        jest.useRealTimers();
      }
    });

    test("a failed snapshot fetch schedules a retry that eventually recovers the book, without any further live delta needed to trigger it", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => new Response(null, { status: 500 }))
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toEqual({ ok: false, reason: "HTTP_ERROR" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1500);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").ok).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test("a 429/RATE_LIMITED snapshot fetch honors a real Retry-After header instead of the shorter default backoff", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => new Response(JSON.stringify({ msg: "too many requests" }), {
            status: 429,
            headers: { "retry-after": "5" },
          }))
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toEqual({
          ok: false, reason: "RATE_LIMITED", retryAfterMs: 5000,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        // The default exponential backoff (base 1000ms +/-20% jitter) would
        // have already retried by 1500ms -- confirm the 5s Retry-After is
        // actually the one governing the wait, not just present and ignored.
        await jest.advanceTimersByTimeAsync(1500);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(4000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").ok).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test("a resubscribe that succeeds cancels a still-pending retry from an earlier failed attempt", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => new Response(null, { status: 500 }))
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        // Unsubscribe/resubscribe recovers on its own (the fresh call succeeds)
        // before the first attempt's retry timer ever fires.
        connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").ok).toBe(true);

        // The original failed attempt's retry timer still fires here, but its
        // own guard (the retry-attempt counter no longer matches, since the
        // successful resubscribe reset it) must no-op it rather than issuing
        // a superfluous third fetch.
        await jest.advanceTimersByTimeAsync(1500);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test("an older snapshot request that resolves after a newer one for the same still-live assembler is discarded (epoch guard)", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveFirstFetch;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveFirstFetch = resolve;
              }),
          )
          .mockImplementation(async () => jsonResponse({ lastUpdateId: 500, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);

        // Request #1 (epoch 1) fires and is held pending.
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        const assemblerBefore = connection.getOrderBook("SPOT", "BTCUSDT");
        expect(assemblerBefore).toEqual({ status: "UNAVAILABLE", reason: "BUFFERING" });

        // An unexpected drop + reconnect resubscribes the still-active DEPTH
        // entry against the SAME assembler (never deleted -- only an
        // explicit unsubscribe or disconnect() does that), firing request #2
        // (epoch 2) for the identical key while request #1 is still in flight.
        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateServerClose();
        jest.advanceTimersByTime(1500);
        const reopened = instances[instances.length - 1];
        reopened.simulateOpen();
        await flushAsync();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(500);

        // Request #1 (epoch 1, now stale) finally resolves. The assembler is
        // still the very same object both requests captured -- only the
        // epoch guard, not the assembler-identity guard, can catch this.
        resolveFirstFetch(jsonResponse({ lastUpdateId: 1, bids: [["1.0", "1.0"]], asks: [] }));
        await flushAsync();

        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(500);
      } finally {
        jest.useRealTimers();
      }
    });

    test("strict collector overflow is fatal and does not reconnect the affected route", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        backpressureOverflowPolicy: "FAIL",
        backpressureMaxQueueDepth: 2,
        backpressureDrainBatchSize: 1,
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "collector");
      const onError = jest.fn();
      const delivered = [];
      connection.onError(onError);
      connection.onMessage((envelope) => delivered.push(envelope.payload.tradeId));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      const strictTradeMessage = (tradeId) => JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", E: 1, s: "BTCUSDT", t: tradeId, p: "1.0", q: "1.0", T: 1, m: false, M: true },
      });
      spotSocket.simulateMessage(strictTradeMessage(1));
      spotSocket.simulateMessage(strictTradeMessage(2));
      spotSocket.simulateMessage(strictTradeMessage(3));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        code: "BACKPRESSURE_OVERFLOW",
        fatal: true,
      }));
      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
      await flushAsync();
      expect(delivered).toEqual([1, 2]);
      expect(connection.getOperationalStats()).toMatchObject({
        backpressurePending: 0,
        backpressureOverflows: 1,
        backpressureCleared: 0,
      });
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_backpressure.queue_overflow",
        droppedCount: 1,
      }));
      expect(telemetry.mock.calls.map((call) => call[0].event))
        .not.toContain("market_data.binance_backpressure.queue_cleared");
      expect(telemetry.mock.calls.map((call) => call[0].event))
        .not.toContain("market_data.binance_connection.route_reconnect_scheduled");
      connection.disconnect();
    });

    test("a snapshot request still in flight when disconnect() fires does not repopulate the cleared state once it resolves", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let resolveFetch;
      const fetchImpl = jest.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.disconnect();

      resolveFetch(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      await flushAsync();

      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
    });
  });

  describe("feed health", () => {
    const REAL_SPOT_TRADE = {
      e: "trade", E: 1786444824142, s: "BTCUSDT", t: 6567786021,
      p: "64275.99000000", q: "0.00206000", T: 1786444824142, m: false, M: true,
    };

    function jsonResponse(body) {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    async function flushAsync() {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    function depthWireMessage({ symbol, U, u, pu, b = [], a = [] }) {
      const data = { e: "depthUpdate", E: Date.now(), s: symbol, U, u, b, a };
      if (pu !== undefined) {
        data.pu = pu;
      }
      return JSON.stringify({ stream: `${symbol.toLowerCase()}@depth@100ms`, data });
    }

    test("getFeedHealth returns undefined for a tuple never subscribed to", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toBeUndefined();
    });

    test("getFeedHealth returns undefined for an unrecognized market kind or event type, not a fake UNAVAILABLE", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      expect(connection.getFeedHealth("COIN_M", "BTCUSDT", "TRADE")).toBeUndefined();
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "AGG_TRADE")).toBeUndefined();
    });

    test("the unsubscribe/resubscribe boundary: getFeedHealth honestly reports undefined while unsubscribed, and a fresh resubscribe never inherits stale-free state from the old subscription", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
        stale: false,
        recoveryState: "READY",
      });

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toBeUndefined();

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      // Not a false READY carried over from the old subscription's fresh
      // state -- beginRecovery on the new subscribe forces RECOVERING
      // immediately, before any new event has arrived to prove otherwise.
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
        stale: true,
        recoveryState: "RECOVERING",
      });
    });

    test("a route disconnect/reconnect cycle is visible through getFeedHealth, not silently masked by elapsed-time staleness alone", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: false,
          recoveryState: "READY",
        });

        spotSocket.simulateServerClose();
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "UNAVAILABLE",
        });

        jest.advanceTimersByTime(1500);
        const reopened = instances[instances.length - 1];
        reopened.simulateOpen();

        // Reconnect resubscribes and re-arms recovery -- the pre-disconnect
        // READY timestamp does not silently read as fresh again just
        // because the route is back up.
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "RECOVERING",
        });
      } finally {
        jest.useRealTimers();
      }
    });

    test("getOrderBook reports CONNECTION_DOWN on a disconnected route even though the assembler itself still thinks it has a READY book", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

      spotSocket.simulateServerClose();
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE",
        reason: "CONNECTION_DOWN",
      });
    });

    test("a reconnect surfaces RECOVERY_IN_PROGRESS for a book the assembler still reports READY, until a fresh snapshot and a confirming delta clear it", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveReconnectFetch;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveReconnectFetch = resolve;
              }),
          );
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
        expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

        spotSocket.simulateServerClose();
        jest.advanceTimersByTime(1500);
        const reopened = instances[instances.length - 1];
        reopened.simulateOpen();
        await flushAsync();

        // The resubscribe's own snapshot fetch is still pending; the
        // assembler's old book is untouched (still reports READY), but
        // feed health knows a fresh reconnect just re-armed recovery.
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "UNAVAILABLE",
          reason: "RECOVERY_IN_PROGRESS",
        });

        resolveReconnectFetch(jsonResponse({ lastUpdateId: 200, bids: [], asks: [] }));
        await flushAsync();

        // The fresh snapshot is accepted but nothing has bridged it yet --
        // BUFFERING, not RECOVERY_IN_PROGRESS (a different, more specific
        // UNAVAILABLE reason), and recovery is still open.
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "UNAVAILABLE",
          reason: "BUFFERING",
        });

        reopened.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 201, u: 205 }));
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "READY",
          book: { bids: [], asks: [], lastUpdateId: 205 },
        });
      } finally {
        jest.useRealTimers();
      }
    });

    test("a DEPTH recovery in progress well past the plain 5s staleness default is still RECOVERING, not prematurely UNAVAILABLE, while the snapshot fetch is genuinely still pending", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveReconnectFetch;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveReconnectFetch = resolve;
              }),
          );
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));

        spotSocket.simulateServerClose();
        jest.advanceTimersByTime(1500);
        const reopened = instances[instances.length - 1];
        reopened.simulateOpen();
        await flushAsync();

        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").recoveryState).toBe("RECOVERING");

        jest.advanceTimersByTime(5_500);
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").recoveryState).toBe("RECOVERING");

        resolveReconnectFetch(jsonResponse({ lastUpdateId: 200, bids: [], asks: [] }));
        await flushAsync();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a route disconnect while a snapshot fetch is in flight still reports CONNECTION_DOWN once that fetch resolves, regardless of what it did to the assembler", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let resolveFetch;
      const fetchImpl = jest.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateServerClose();

      resolveFetch(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      await flushAsync();

      // The snapshot resolved successfully and the assembler is BUFFERING
      // (a real, accepted state) -- but the route is down, and that check
      // always wins over the assembler's own idea of its status.
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE",
        reason: "CONNECTION_DOWN",
      });
    });

    test("a snapshot that bridges immediately via an already-buffered delta reaches READY inside requestDepthSnapshot itself, and correctly ends a recovery that was already in progress", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let resolveGapFetch;
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveGapFetch = resolve;
            }),
        );
      const telemetry = jest.fn();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl, telemetry });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

      // A gap -- beginRecovery fires, a fresh snapshot request goes out and
      // is held pending.
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 300, u: 305 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE",
        reason: "SEQUENCE_GAP",
      });
      telemetry.mockClear();

      // A live delta arrives while the snapshot is still pending -- the
      // assembler has no snapshot right now, so this just buffers.
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 306, u: 310 }));

      // The pending snapshot resolves at lastUpdateId 305, which the
      // buffered U=306 delta bridges immediately -- applySnapshot reaches
      // READY synchronously inside requestDepthSnapshot, not via a later
      // handleRawMessage delta.
      resolveGapFetch(jsonResponse({ lastUpdateId: 305, bids: [], asks: [] }));
      await flushAsync();

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "READY",
        book: { bids: [], asks: [], lastUpdateId: 310 },
      });
      const succeededEvents = telemetry.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry.event === "market_data.binance_connection.depth_gap_recovery_succeeded");
      expect(succeededEvents).toHaveLength(1);
    });

    test("a snapshot-bridged READY book stamps DEPTH freshness at recovery, not at the gap that triggered it", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveGapFetch;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveGapFetch = resolve;
              }),
          );
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 300, u: 305 }));
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 306, u: 310 }));

        // REST snapshot slower than the DEPTH stale budget -- the gap event's
        // timestamp must not leak through as "last received" after recovery.
        jest.setSystemTime(Date.now() + 5_001);
        resolveGapFetch(jsonResponse({ lastUpdateId: 305, bids: [], asks: [] }));
        await flushAsync();

        expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH")).toEqual({
          stale: false,
          recoveryState: "READY",
        });
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("PERPETUAL's dual routes are isolated for feed health too -- a KLINE subscription (routed via 'market') is unaffected by the 'public' route dropping, and vice versa", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe(
          { symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" },
          "consumer-a",
        );
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");

        const publicRoute = instanceForUrl(instances, "fstream.binance.com/public/stream");
        const marketRoute = instanceForUrl(instances, "fstream.binance.com/market/stream");

        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "KLINE", "1m").recoveryState).toBe("RECOVERING");
        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "TRADE").recoveryState).toBe("RECOVERING");

        // Dropping only the market route (KLINE's route) must not affect
        // the still-connected public route's TRADE tuple.
        marketRoute.simulateServerClose();
        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "KLINE", "1m")).toEqual({
          stale: true,
          recoveryState: "UNAVAILABLE",
        });
        // Still RECOVERING from its own since-subscribe state (no live
        // TRADE event has arrived yet) -- specifically not UNAVAILABLE,
        // which is what it would incorrectly show if the public route's
        // connectedness were wrongly derived from the market route.
        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "TRADE").recoveryState).toBe("RECOVERING");

        jest.advanceTimersByTime(1500);
        const reopenedMarket = instances[instances.length - 1];
        reopenedMarket.simulateOpen();

        // publicRoute itself was never touched.
        expect(publicRoute.readyState).toBe(1);
        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "KLINE", "1m").recoveryState).toBe("RECOVERING");
      } finally {
        jest.useRealTimers();
      }
    });

    test("a DEPTH tuple's unsubscribe/resubscribe boundary through getFeedHealth: recovery-in-progress state from before the unsubscribe never leaks into the fresh subscription", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").recoveryState).toBe("READY");

      // A gap leaves this tuple mid-recovery (DEPTH never auto-clears).
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 300, u: 305 }));
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").recoveryState).toBe("RECOVERING");

      connection.unsubscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH")).toBeUndefined();

      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      // Still RECOVERING -- correctly re-armed by the fresh subscribe, not
      // a leftover artifact from the old gap that was never cleaned up.
      expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").recoveryState).toBe("RECOVERING");
    });

    test("elapsed silence on a still-connected route reports stale without flipping recoveryState to UNAVAILABLE", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(JSON.stringify({ stream: "btcusdt@trade", data: REAL_SPOT_TRADE }));
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: false,
          recoveryState: "READY",
        });

        jest.advanceTimersByTime(30_001);
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "READY",
        });
        expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
      } finally {
        jest.useRealTimers();
      }
    });

    test("the route watchdog rebuilds a subscribed socket that stops delivering every frame", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const telemetry = jest.fn();
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          telemetry,
          routeSilenceTimeoutMs: 1000,
          routeWatchdogIntervalMs: 100,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        jest.advanceTimersByTime(1100);

        expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
          event: "market_data.binance_connection.route_silence_timeout",
          marketKind: "SPOT",
        }));
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("the route watchdog defers a false reconnect while the local scheduler is unhealthy", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const telemetry = jest.fn();
        let schedulerHealthy = false;
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          telemetry,
          routeSilenceTimeoutMs: 1000,
          routeWatchdogIntervalMs: 100,
          routeSilenceRecoveryAllowed: () => schedulerHealthy,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        jest.advanceTimersByTime(1100);

        expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
          event: "market_data.binance_connection.route_silence_recovery_deferred",
          marketKind: "SPOT",
        }));
        expect(telemetry.mock.calls.map((call) => call[0].event))
          .not.toContain("market_data.binance_connection.route_silence_timeout");

        schedulerHealthy = true;
        jest.advanceTimersByTime(100);
        expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("raw ingress preserves receive order and capture timestamps while yielding before normalization", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        rawIngressEnabled: true,
        rawIngressDrainBatchSize: 2,
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      await flushAsync();

      const delivered = [];
      connection.onMessage((envelope) => delivered.push(envelope));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      const receivedAtMs = Date.now();
      for (let tradeId = 1; tradeId <= 5; tradeId += 1) {
        spotSocket.simulateMessage(JSON.stringify({
          stream: "btcusdt@trade",
          data: { e: "trade", E: tradeId, s: "BTCUSDT", t: tradeId, p: "1", q: "1", T: tradeId, m: false, M: true },
        }));
      }

      expect(delivered).toEqual([]);
      expect(connection.getOperationalStats()).toMatchObject({ rawIngressPending: 5 });
      await connection.quiesce();

      expect(delivered.map((entry) => entry.payload.tradeId)).toEqual([1, 2, 3, 4, 5]);
      expect(delivered.every((entry) => Date.parse(entry.receivedAt) >= receivedAtMs)).toBe(true);
      expect(connection.getOperationalStats()).toMatchObject({
        rawIngressPending: 0,
        rawIngressPendingBytes: 0,
        rawIngressProcessed: 6,
        rawIngressOverflows: 0,
        rawIngressHighWaterMark: 5,
      });
      connection.disconnect();
    });

    test("raw ingress applies transport backpressure and drains a same-route burst without loss", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl({ honorPause: true });
      const telemetry = jest.fn();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        backpressureOverflowPolicy: "FAIL",
        backpressureMaxQueueDepth: 200,
        backpressureDrainBatchSize: 20,
        rawIngressEnabled: true,
        rawIngressMaxQueueDepth: 20,
        rawIngressPauseQueueDepth: 5,
        rawIngressResumeQueueDepth: 1,
        rawIngressDrainBatchSize: 2,
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      await flushAsync();

      const delivered = [];
      connection.onMessage((envelope) => delivered.push(envelope.payload.tradeId));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      for (let tradeId = 1; tradeId <= 100; tradeId += 1) {
        spotSocket.simulateMessage(JSON.stringify({
          stream: "btcusdt@trade",
          data: { e: "trade", E: tradeId, s: "BTCUSDT", t: tradeId, p: "1", q: "1", T: tradeId, m: false, M: true },
        }));
      }

      expect(connection.getOperationalStats()).toMatchObject({
        rawIngressPending: 5,
        rawIngressPausedRoutes: 1,
        rawIngressOverflows: 0,
      });
      expect(spotSocket.bufferedMessages).toHaveLength(95);

      for (let attempt = 0; attempt < 200 && delivered.length < 100; attempt += 1) {
        await flushAsync();
      }

      expect(delivered).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      expect(spotSocket.bufferedMessages).toHaveLength(0);
      expect(spotSocket.pauseCalls).toBeGreaterThan(1);
      expect(spotSocket.resumeCalls).toBe(spotSocket.pauseCalls);
      expect(connection.getOperationalStats()).toMatchObject({
        rawIngressPending: 0,
        rawIngressPausedRoutes: 0,
        rawIngressAccepted: 101,
        rawIngressProcessed: 101,
        rawIngressOverflows: 0,
        rawIngressFlowControlFailures: 0,
      });
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_raw_ingress.flow_control_paused",
        marketKind: "SPOT",
        route: "public",
      }));
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_raw_ingress.flow_control_resumed",
        reason: "LOW_WATERMARK",
      }));
      expect(telemetry.mock.calls.map((call) => call[0].event))
        .not.toContain("market_data.binance_raw_ingress.queue_overflow");
      connection.disconnect();
    });

    test("raw ingress enforces a byte bound independently of frame count", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        backpressureOverflowPolicy: "FAIL",
        rawIngressEnabled: true,
        rawIngressMaxQueueDepth: 100,
        rawIngressMaxQueueBytes: 5,
      });
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      spotSocket.simulateMessage("{}");
      spotSocket.simulateMessage("{}");

      expect(connection.getOperationalStats()).toMatchObject({
        rawIngressPending: 1,
        rawIngressPendingBytes: 4,
        rawIngressOverflows: 1,
        rawIngressHighWaterBytes: 4,
      });
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_raw_ingress.queue_overflow",
        queueDepth: 1,
        queueBytes: 4,
        incomingBytes: 4,
        limitKind: "BYTES",
      }));
      connection.disconnect();
    });

    test("raw ingress yields on elapsed time even when its item budget has capacity", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let monotonic = 0;
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        rawIngressEnabled: true,
        rawIngressDrainBatchSize: 200,
        rawIngressDrainMaxMs: 1,
        rawIngressNow: () => {
          monotonic += 2;
          return monotonic;
        },
      });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      await flushAsync();
      const delivered = [];
      connection.onMessage((envelope) => delivered.push(envelope.payload.tradeId));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      for (let tradeId = 1; tradeId <= 64; tradeId += 1) {
        spotSocket.simulateMessage(JSON.stringify({
          stream: "btcusdt@trade",
          data: { e: "trade", E: tradeId, s: "BTCUSDT", t: tradeId, p: "1", q: "1", T: tradeId, m: false, M: true },
        }));
      }

      await connection.quiesce();
      expect(delivered).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
      expect(connection.getOperationalStats().rawIngressDrainTimeYields).toBeGreaterThanOrEqual(7);
      connection.disconnect();
    });

    test("raw ingress enforces its hard bound before parsing and reports a fatal capture loss", () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const errors = [];
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        backpressureOverflowPolicy: "FAIL",
        rawIngressEnabled: true,
        rawIngressMaxQueueDepth: 2,
      });
      connection.onError((error) => errors.push(error));
      connectAndOpenAll(connection, instances);
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      spotSocket.simulateMessage("{}");
      spotSocket.simulateMessage("{}");
      spotSocket.simulateMessage("{}");

      expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
      expect(connection.getOperationalStats()).toMatchObject({
        rawIngressPending: 2,
        rawIngressAccepted: 2,
        rawIngressOverflows: 1,
        rawIngressHighWaterMark: 2,
      });
      expect(errors).toContainEqual(expect.objectContaining({
        code: "RAW_INGRESS_OVERFLOW",
        fatal: true,
      }));
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_raw_ingress.queue_overflow",
        droppedCount: 1,
        queueDepth: 2,
      }));
      connection.disconnect();
    });

    test("stale recovery waits for accepted raw frames to clear before changing subscriptions", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        rawIngressEnabled: true,
        rawIngressDrainBatchSize: 1,
      });
      connectAndOpenAll(connection, instances);
      const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
      connection.subscribe(request, "consumer-a");
      await flushAsync();
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", E: 1, s: "BTCUSDT", t: 1, p: "1", q: "1", T: 1, m: false, M: true },
      }));

      expect(connection.recoverStaleSubscription(request, { automatic: true })).toBe(false);
      expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
      await flushAsync();
      expect(connection.recoverStaleSubscription(request, { automatic: true })).toBe(true);
      connection.disconnect();
    });

    test("backpressure delivery yields on its time budget and rotates the first tuple fairly", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let monotonic = 0;
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        backpressureMaxQueueDepth: 200,
        backpressureDrainBatchSize: 200,
        backpressureDrainMaxMs: 1,
        backpressureNow: () => {
          monotonic += 2;
          return monotonic;
        },
      });
      connectAndOpenAll(connection, instances);
      connection.subscribeMany([
        { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
        { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" },
      ], "consumer-a");
      const delivered = [];
      connection.onMessage((envelope) => delivered.push(`${envelope.providerSymbol}:${envelope.payload.tradeId}`));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      for (let tradeId = 1; tradeId <= 64; tradeId += 1) {
        for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
          spotSocket.simulateMessage(JSON.stringify({
            stream: `${symbol.toLowerCase()}@trade`,
            data: { e: "trade", E: tradeId, s: symbol, t: tradeId, p: "1", q: "1", T: tradeId, m: false, M: true },
          }));
        }
      }

      await connection.quiesce();
      expect(delivered).toHaveLength(128);
      for (let offset = 0; offset < delivered.length; offset += 8) {
        const expectedSymbol = (offset / 8) % 2 === 0 ? "BTCUSDT:" : "ETHUSDT:";
        expect(delivered.slice(offset, offset + 8).every((entry) => entry.startsWith(expectedSymbol))).toBe(true);
      }
      const operationalStats = connection.getOperationalStats();
      expect(operationalStats).toMatchObject({
        backpressurePending: 0,
      });
      expect(operationalStats.backpressureDrainTimeYields).toBeGreaterThanOrEqual(3);
      expect(operationalStats.backpressureDrained).toBe(128);
      expect(operationalStats.backpressureDrainSteps).toBeGreaterThanOrEqual(4);
      expect(operationalStats.backpressureDrainMs).toBeGreaterThan(0);
      connection.disconnect();
    });

    test("explicit stale-subscription recovery resubscribes only the stale tuple without rebuilding its shared route", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const telemetry = jest.fn();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, telemetry });
        connectAndOpenAll(connection, instances);
        const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };

        expect(connection.recoverStaleSubscription(request)).toBe(false);
        connection.subscribe(request, "consumer-a");
        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        const sentBeforeRecovery = spotSocket.sentMessages.length;
        expect(connection.recoverStaleSubscription(request)).toBe(true);
        expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
        expect(spotSocket.sentMessages.slice(sentBeforeRecovery).map((message) => JSON.parse(message).method))
          .toEqual(["UNSUBSCRIBE", "SUBSCRIBE"]);
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
          event: "market_data.binance_connection.stale_subscription_recovery_started",
          eventType: "TRADE",
          symbol: "BTCUSDT",
        }));

        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("automatic stale recovery reconnects its shared route once and resubscribes all active tuples", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        const btcTrade = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
        const ethTrade = { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" };
        connection.subscribeMany([btcTrade, ethTrade], "consumer-a");

        expect(connection.recoverStaleSubscription(btcTrade, { automatic: true })).toBe(true);
        expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
        expect(connection.recoverStaleSubscription(ethTrade, { automatic: true })).toBe(false);

        jest.advanceTimersByTime(1_200);
        const reopenedSocket = instances.filter((instance) => instance.url.endsWith("stream.binance.com/stream")).at(-1);
        reopenedSocket.simulateOpen();
        expect(reopenedSocket.sentMessages).toHaveLength(1);
        expect(JSON.parse(reopenedSocket.sentMessages[0])).toEqual(expect.objectContaining({
          method: "SUBSCRIBE",
          params: expect.arrayContaining(["btcusdt@trade", "ethusdt@trade"]),
        }));
        expect(JSON.parse(reopenedSocket.sentMessages[0]).method).not.toBe("UNSUBSCRIBE");
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("stale TRADE recovery drains accepted queued messages before it resubscribes", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const telemetry = jest.fn();
      const connection = createBinanceConnection({
        webSocketImpl: WebSocketImpl,
        telemetry,
        backpressureDrainBatchSize: 1,
      });
      connectAndOpenAll(connection, instances);
      const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
      connection.subscribe(request, "consumer-a");
      const delivered = [];
      connection.onMessage((payload) => delivered.push(payload.payload.tradeId));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      spotSocket.simulateMessage(JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", E: 1, s: "BTCUSDT", t: 1, p: "1", q: "1", T: 1, m: false, M: true },
      }));

      expect(connection.recoverStaleSubscription(request)).toBe(false);
      await flushAsync();
      expect(delivered).toEqual([1]);
      expect(connection.recoverStaleSubscription(request)).toBe(true);
      spotSocket.simulateMessage(JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", E: 2, s: "BTCUSDT", t: 2, p: "1", q: "1", T: 2, m: false, M: true },
      }));
      await flushAsync();
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
        event: "market_data.binance_connection.stale_subscription_recovery_succeeded",
        marketKind: "SPOT",
        symbol: "BTCUSDT",
        eventType: "TRADE",
      }));
      expect(telemetry.mock.calls.map((call) => call[0].event))
        .not.toContain("market_data.binance_backpressure.queue_cleared");

      connection.disconnect();
    });

    test("the first DEPTH book reaching READY does not emit depth_gap_recovery_succeeded — that event is only a real gap recovery", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const telemetry = jest.fn();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl, telemetry });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 105 }));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

      const succeededEvents = telemetry.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry.event === "market_data.binance_connection.depth_gap_recovery_succeeded");
      expect(succeededEvents).toHaveLength(0);
    });
  });

  test("createBinanceConnection throws when given a non-function WebSocket implementation", () => {
    expect(() => createBinanceConnection({ webSocketImpl: null })).toThrow(
      /requires a WebSocket implementation/,
    );
  });

  test("createBinanceConnection rejects malformed raw-ingress controls", () => {
    const { WebSocketImpl } = createFakeWebSocketImpl();
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressEnabled: 1 })).toThrow(/rawIngressEnabled/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressMaxQueueDepth: 0 })).toThrow(/rawIngressMaxQueueDepth/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressMaxQueueBytes: 0 })).toThrow(/rawIngressMaxQueueBytes/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressDrainBatchSize: 0 })).toThrow(/rawIngressDrainBatchSize/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressDrainMaxMs: 0 })).toThrow(/rawIngressDrainMaxMs/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressPauseQueueDepth: 0 })).toThrow(/rawIngressPauseQueueDepth/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressMaxQueueDepth: 10, rawIngressPauseQueueDepth: 11 })).toThrow(/rawIngressPauseQueueDepth/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressPauseQueueDepth: 5, rawIngressResumeQueueDepth: 5 })).toThrow(/rawIngressResumeQueueDepth/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressPauseQueueBytes: 0 })).toThrow(/rawIngressPauseQueueBytes/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressMaxQueueBytes: 10, rawIngressPauseQueueBytes: 11 })).toThrow(/rawIngressPauseQueueBytes/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressPauseQueueBytes: 5, rawIngressResumeQueueBytes: 5 })).toThrow(/rawIngressResumeQueueBytes/);
    expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, rawIngressNow: 0 })).toThrow(/rawIngressNow/);
  });

  describe("periodic depth snapshot refresh (DX3.19)", () => {
    function jsonResponse(body) {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    function depthWireMessage({ symbol, U, u, b = [], a = [] }) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@depth@100ms`,
        data: { e: "depthUpdate", E: Date.now(), s: symbol, U, u, b, a },
      });
    }

    test("rejects a non-positive depthSnapshotRefreshIntervalMs before constructing anything", () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      expect(() => createBinanceConnection({ webSocketImpl: WebSocketImpl, depthSnapshotRefreshIntervalMs: 0 }))
        .toThrow(/depthSnapshotRefreshIntervalMs/);
    });

    test("a periodic tick re-fetches a snapshot for every currently-active depth subscription, across both market kinds", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        connection.subscribe({ symbol: "ETHUSDT", marketKind: "PERPETUAL", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        await flushAsync();
        // One initial fetch per subscription, already existing behavior.
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(1_000);
        // One more fetch per still-active subscription from the periodic tick.
        expect(fetchImpl).toHaveBeenCalledTimes(4);
      } finally {
        jest.useRealTimers();
      }
    });

    test("a ready book remains continuously available while a shadow snapshot refresh races live deltas", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const telemetry = jest.fn();
        let resolveRefresh;
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
          .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          telemetry,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 101 }));
        expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        spotSocket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 102, u: 102 }));
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "READY",
          book: { bids: [], asks: [], lastUpdateId: 102 },
        });

        resolveRefresh(jsonResponse({ lastUpdateId: 101, bids: [], asks: [] }));
        await flushAsync();
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
          status: "READY",
          book: { bids: [], asks: [], lastUpdateId: 102 },
        });
        expect(telemetry.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
          expect.objectContaining({
            event: "market_data.binance_connection.depth_snapshot_refresh_succeeded",
            triggerReason: "PERIODIC_REFRESH",
          }),
        ]));
        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a periodic tick with no active depth subscription performs no fetch", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test("an old shadow snapshot warns while retaining the active book and later refreshes successfully", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      let connection;
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const telemetry = jest.fn();
        let finish;
        const fetchImpl = jest.fn()
          .mockResolvedValueOnce(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }))
          .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
          .mockResolvedValueOnce(jsonResponse({ lastUpdateId: 102, bids: [], asks: [] }));
        connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl, telemetry, depthSnapshotRefreshIntervalMs: 1_000 });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer");
        await flushAsync();
        const socket = instanceForUrl(instances, "stream.binance.com/stream");
        socket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 101, u: 101 }));
        await jest.advanceTimersByTimeAsync(1_000);
        socket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 102, u: 102 }));
        finish(jsonResponse({ lastUpdateId: 90, bids: [], asks: [] }));
        await flushAsync();
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toMatchObject({ status: "READY", book: { lastUpdateId: 102 } });
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ event: "market_data.binance_connection.depth_snapshot_refresh_failed", reason: "SNAPSHOT_TOO_OLD", severity: "warn", activeBookRetained: true, retryAfterMs: 1_000 }));
        await jest.advanceTimersByTimeAsync(1_000);
        socket.simulateMessage(depthWireMessage({ symbol: "BTCUSDT", U: 103, u: 103 }));
        await flushAsync();
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ event: "market_data.binance_connection.depth_snapshot_refresh_succeeded" }));
      } finally { connection?.disconnect(); jest.useRealTimers(); }
    });

    test("a periodic tick racing an in-flight snapshot fetch for the same key: only the later request's result is kept", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        let resolveInitial;
        let resolvePeriodic;
        const fetchImpl = jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
          .mockImplementationOnce(() => new Promise((resolve) => { resolvePeriodic = resolve; }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // Resolve the newer (periodic) request first -- its result must apply.
        resolvePeriodic(jsonResponse({ lastUpdateId: 200, bids: [], asks: [] }));
        await flushAsync();
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(200);

        // The older (initial-subscribe) request resolves after -- its epoch
        // is now stale, so it must not clobber the newer snapshot.
        resolveInitial(jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        await flushAsync();
        expect(connection.getDepthSnapshot("SPOT", "BTCUSDT").value.body.lastUpdateId).toBe(200);
      } finally {
        jest.useRealTimers();
      }
    });

    test("disconnect() clears the periodic refresh timer -- no further ticks fire afterward", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        fetchImpl.mockClear();

        connection.disconnect();
        await jest.advanceTimersByTimeAsync(10_000);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a tick after quiesce() does not fetch, independent of the timer itself being cleared", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();
        fetchImpl.mockClear();

        connection.quiesce().catch(() => {});
        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(connection.getOperationalStats().depthSnapshotRetryTimers).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    // L1L2-V2-008. disconnect() clears every book assembler but deliberately
    // keeps the subscription registry, since reconnect uses it as its source
    // of truth. So between a reconnect and the route actually opening, a DEPTH
    // tuple is registered with no assembler behind it. A periodic tick landing
    // in that window used to call requestDepthSnapshot() anyway; because REST
    // is independent of the WebSocket route, the fetch succeeded and the
    // handler dereferenced an undefined assembler. That threw inside an async
    // function nobody awaits, which is an unhandled rejection -- process exit
    // on Node >=15, i.e. the collector dies during a WS outage.
    test("a periodic tick during a WS-down/REST-up window does not crash on a registered DEPTH tuple whose assembler was cleared", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const rejections = [];
      const captureRejection = (reason) => rejections.push(reason);
      process.on("unhandledRejection", captureRejection);
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({
          webSocketImpl: WebSocketImpl,
          fetchImpl,
          depthSnapshotRefreshIntervalMs: 1_000,
        });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        await flushAsync();

        // Drops every assembler; the DEPTH registry entry survives on purpose.
        connection.disconnect();
        instances.length = 0;
        // Reconnect, but leave every socket in CONNECTING: the WS feed is down
        // while Binance's REST endpoint stays reachable.
        connection.connect();
        expect(connection.getStatus().SPOT.public).toBe("CONNECTING");
        fetchImpl.mockClear();

        await jest.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        await flushAsync();

        expect(rejections).toEqual([]);
        // Nothing to refresh without an assembler, so no REST call is spent
        // against the rate limit while the route is still down.
        expect(fetchImpl).not.toHaveBeenCalled();
        // Fail-closed: with no assembler there is no book to serve at all,
        // rather than a stale one left over from before the disconnect.
        expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      } finally {
        process.off("unhandledRejection", captureRejection);
        jest.useRealTimers();
      }
    });
  });

  // P1.06's own cross-cutting pass. Each of these spans subsystems that no
  // single prior ticket's suite exercises together -- routing, the book
  // assembler, feed health, and the backpressure queue all live on one
  // connection here, and the assertions are about how they interact rather
  // than about any one of them in isolation.
  describe("cross-cutting: routing x book x health x backpressure on one connection", () => {
    function jsonResponse(body) {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    function tradeWire(symbol, tradeId) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@trade`,
        data: { e: "trade", E: 1, s: symbol, t: tradeId, p: "1.0", q: "1.0", T: 1, m: false, M: true },
      });
    }

    function klineWire(symbol, interval) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@kline_${interval}`,
        data: {
          e: "kline", E: 1, s: symbol,
          k: {
            t: 1, T: 2, s: symbol, i: interval, f: 1, L: 1,
            o: "1.0", c: "1.0", h: "1.0", l: "1.0", v: "1.0", n: 1,
            x: false, q: "1.0", V: "1.0", Q: "1.0", B: "0",
          },
        },
      });
    }

    function depthWire(symbol, U, u) {
      return JSON.stringify({
        stream: `${symbol.toLowerCase()}@depth@100ms`,
        data: { e: "depthUpdate", E: Date.now(), s: symbol, U, u, b: [], a: [] },
      });
    }

    // Both symbols x both market kinds x all four event types, on all three
    // sockets at once. This is the full Phase 1 subscription surface.
    function subscribeEverything(connection) {
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        for (const marketKind of ["SPOT", "PERPETUAL"]) {
          connection.subscribe({ symbol, marketKind, eventType: "TRADE" }, "consumer-a");
          connection.subscribe({ symbol, marketKind, eventType: "BOOK_TICKER" }, "consumer-a");
          connection.subscribe({ symbol, marketKind, eventType: "KLINE", interval: "1m" }, "consumer-a");
          connection.subscribe({ symbol, marketKind, eventType: "DEPTH" }, "consumer-a");
        }
      }
    }

    test("matrix 1: dropping any one of the three sockets leaves the other two routes' health and books fully intact", async () => {
      const routeCases = [
        { drop: "stream.binance.com/stream", label: "SPOT:public" },
        { drop: "fstream.binance.com/public/stream", label: "PERPETUAL:public" },
        { drop: "fstream.binance.com/market/stream", label: "PERPETUAL:market" },
      ];

      for (const { drop, label } of routeCases) {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);
        subscribeEverything(connection);
        await flushAsync();

        instanceForUrl(instances, drop).simulateServerClose();

        // KLINE is the only event type whose route differs between market
        // kinds, so it is the one that proves routing is really consulted.
        const health = (marketKind, symbol, eventType, interval) =>
          connection.getFeedHealth(marketKind, symbol, eventType, interval)?.recoveryState;

        const spotDown = label === "SPOT:public";
        const perpPublicDown = label === "PERPETUAL:public";
        const perpMarketDown = label === "PERPETUAL:market";

        expect(health("SPOT", "BTCUSDT", "TRADE")).toBe(spotDown ? "UNAVAILABLE" : "RECOVERING");
        expect(health("SPOT", "BTCUSDT", "KLINE", "1m")).toBe(spotDown ? "UNAVAILABLE" : "RECOVERING");
        expect(health("PERPETUAL", "BTCUSDT", "TRADE")).toBe(perpPublicDown ? "UNAVAILABLE" : "RECOVERING");
        expect(health("PERPETUAL", "BTCUSDT", "KLINE", "1m")).toBe(perpMarketDown ? "UNAVAILABLE" : "RECOVERING");

        // Books live on the DEPTH route (public for both kinds); the market
        // route dropping must never disturb either book.
        expect(connection.getOrderBook("SPOT", "BTCUSDT").reason)
          .toBe(spotDown ? "CONNECTION_DOWN" : "BUFFERING");
        expect(connection.getOrderBook("PERPETUAL", "ETHUSDT").reason)
          .toBe(perpPublicDown ? "CONNECTION_DOWN" : "BUFFERING");

        // A surviving public route's TRADE queue must still drain. The QA
        // asked for queues untouched, not only health/books.
        const survivingTrade = spotDown
          ? { marketKind: "PERPETUAL", socket: instanceForUrl(instances, "fstream.binance.com/public/stream") }
          : { marketKind: "SPOT", socket: instanceForUrl(instances, "stream.binance.com/stream") };
        const received = [];
        connection.onMessage((payload) => {
          if (payload.eventType === "TRADE" && payload.marketKind === survivingTrade.marketKind) {
            received.push(payload.payload.tradeId);
          }
        });
        survivingTrade.socket.simulateMessage(tradeWire("BTCUSDT", 7));
        await flushAsync();
        expect(received).toEqual([7]);

        connection.disconnect();
      }
    });

    test("matrix 2: a SPOT BTC depth gap leaves ETH's book READY and a PERP trade queue still draining", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.subscribe({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "TRADE" }, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      const perpPublic = instanceForUrl(instances, "fstream.binance.com/public/stream");

      // Bring both spot books to READY off the same snapshot id.
      spotSocket.simulateMessage(depthWire("BTCUSDT", 101, 105));
      spotSocket.simulateMessage(depthWire("ETHUSDT", 101, 105));
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");
      expect(connection.getOrderBook("SPOT", "ETHUSDT").status).toBe("READY");

      const received = [];
      connection.onMessage((payload) => {
        if (payload.eventType === "TRADE") received.push(payload.payload.tradeId);
      });

      // Gap only BTC (skip from 105 straight to 200), queue a PERP trade.
      perpPublic.simulateMessage(tradeWire("BTCUSDT", 1));
      spotSocket.simulateMessage(depthWire("BTCUSDT", 200, 205));

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toEqual({
        status: "UNAVAILABLE", reason: "SEQUENCE_GAP",
      });
      // ETH is on the same socket and the same market kind -- it must not be
      // dragged into BTC's recovery.
      expect(connection.getOrderBook("SPOT", "ETHUSDT").status).toBe("READY");

      await flushAsync();
      expect(received).toEqual([1]);

      connection.disconnect();
    });

    test("matrix 3: disconnecting mid-TRADE-batch while a DEPTH snapshot is in flight blocks both the batch and the snapshot", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      let releaseSnapshot;
      const snapshotGate = new Promise((resolve) => {
        releaseSnapshot = resolve;
      });
      const fetchImpl = jest.fn(async () => {
        await snapshotGate;
        return jsonResponse({ lastUpdateId: 100, bids: [], asks: [] });
      });
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");

      const delivered = [];
      connection.onMessage((payload) => {
        delivered.push(payload.payload.tradeId);
        if (delivered.length === 1) {
          connection.disconnect();
        }
      });

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(tradeWire("BTCUSDT", 1));
      spotSocket.simulateMessage(tradeWire("BTCUSDT", 2));

      await flushAsync();
      expect(delivered).toEqual([1]);

      // The snapshot resolves only now, after disconnect() already cleared
      // every assembler. It must not resurrect the book.
      releaseSnapshot();
      await flushAsync();
      await flushAsync();

      expect(connection.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
      expect(connection.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    });

    test("matrix 4: unsubscribing and resubscribing TRADE and DEPTH together rebuilds the book and discards the old batch", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
      connectAndOpenAll(connection, instances);
      const tradeReq = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
      const depthReq = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" };
      connection.subscribe(tradeReq, "consumer-a");
      connection.subscribe(depthReq, "consumer-a");
      await flushAsync();

      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
      spotSocket.simulateMessage(depthWire("BTCUSDT", 101, 105));
      const bookBefore = connection.getOrderBook("SPOT", "BTCUSDT");
      expect(bookBefore.status).toBe("READY");

      const delivered = [];
      connection.onMessage((payload) => {
        if (payload.eventType !== "TRADE") return;
        delivered.push(payload.payload.tradeId);
        if (delivered.length === 1) {
          connection.unsubscribe(tradeReq, "consumer-a");
          connection.unsubscribe(depthReq, "consumer-a");
          connection.subscribe(tradeReq, "consumer-a");
          connection.subscribe(depthReq, "consumer-a");
        }
      });

      spotSocket.simulateMessage(tradeWire("BTCUSDT", 1));
      spotSocket.simulateMessage(tradeWire("BTCUSDT", 2));
      spotSocket.simulateMessage(tradeWire("BTCUSDT", 3));

      await flushAsync();
      // Epoch bumped by the teardown+resubscribe, so 2 and 3 are abandoned.
      expect(delivered).toEqual([1]);

      // The DEPTH resubscribe built a brand-new assembler: the old READY book
      // must not have survived the round trip.
      await flushAsync();
      expect(connection.getOrderBook("SPOT", "BTCUSDT").status).not.toBe("READY");

      connection.disconnect();
    });

    test("matrix 5: a >500 TRADE burst alongside one KLINE and one DEPTH delta drops only the oldest trades", async () => {
      const { WebSocketImpl, instances } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
      const telemetry = jest.fn();
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl, telemetry });
      connectAndOpenAll(connection, instances);
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" }, "consumer-a");
      connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
      await flushAsync();

      const received = [];
      connection.onMessage((payload) => received.push(payload.eventType));
      const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");

      // All in one turn, before any drain tick can run.
      for (let i = 0; i < 600; i += 1) {
        spotSocket.simulateMessage(tradeWire("BTCUSDT", i));
      }
      spotSocket.simulateMessage(klineWire("BTCUSDT", "1m"));
      spotSocket.simulateMessage(depthWire("BTCUSDT", 101, 105));

      // DEPTH bypasses the queue entirely -- it is already delivered.
      expect(received).toEqual(["DEPTH"]);

      const dropped = telemetry.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry.event === "market_data.binance_backpressure.event_dropped");
      expect(dropped).toHaveLength(100);
      expect(dropped[0]).toEqual(expect.objectContaining({ symbol: "BTCUSDT", eventType: "TRADE", queueDepth: 500 }));

      await flushAsync();
      // Fair share guarantees the single KLINE is not starved by 500 trades.
      expect(received).toContain("KLINE");

      connection.disconnect();
    });

    test("matrix 6: elapsed TRADE silence, a live DEPTH feed, and a down route are three distinguishable states at once", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 100, bids: [], asks: [] }));
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" }, "consumer-a");
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" }, "consumer-a");
        await flushAsync();

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(tradeWire("BTCUSDT", 1));
        await flushAsync();
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE"))
          .toEqual({ stale: false, recoveryState: "READY" });

        // Drop the PERPETUAL market route, then let TRADE go silent past its
        // 30s threshold while DEPTH keeps diffing on a still-open socket.
        instanceForUrl(instances, "fstream.binance.com/market/stream").simulateServerClose();
        jest.setSystemTime(Date.now() + 30_001);
        spotSocket.simulateMessage(depthWire("BTCUSDT", 101, 105));

        // Silent but connected: stale, yet still READY -- not UNAVAILABLE.
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE"))
          .toEqual({ stale: true, recoveryState: "READY" });
        // Actively flowing on the same socket.
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "DEPTH").stale).toBe(false);
        // Genuinely disconnected, a different state from mere silence.
        expect(connection.getFeedHealth("PERPETUAL", "BTCUSDT", "KLINE", "1m"))
          .toEqual({ stale: true, recoveryState: "UNAVAILABLE" });
        // The book itself is still live despite the sibling route being down.
        expect(connection.getOrderBook("SPOT", "BTCUSDT").status).toBe("READY");

        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("matrix 7: a rejected SUBSCRIBE closes the route and retries the active registry", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl({ autoAcknowledgeControls: false });
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        const request = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
        connection.subscribe(request, "consumer-a");

        const errors = [];
        connection.onError((payload) => errors.push(payload));
        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        const subscribeId = JSON.parse(spotSocket.sentMessages[0]).id;
        spotSocket.simulateMessage(JSON.stringify({ id: subscribeId, code: -1121, msg: "Invalid symbol" }));

        expect(errors).toEqual([
          expect.objectContaining({ marketKind: "SPOT", route: "public", code: -1121 }),
        ]);
        expect(connection.getStatus().SPOT.public).toBe("DISCONNECTED");
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "UNAVAILABLE",
        });

        jest.advanceTimersByTime(1500);
        const reopened = instances.filter((instance) => instance.url.endsWith("stream.binance.com/stream")).at(-1);
        reopened.simulateOpen();
        expect(JSON.parse(reopened.sentMessages[0])).toEqual(
          expect.objectContaining({ method: "SUBSCRIBE", params: ["btcusdt@trade"] }),
        );
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "RECOVERING",
        });

        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    test("matrix 8 (residual): a silent still-open socket goes stale without being killed", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { WebSocketImpl, instances } = createFakeWebSocketImpl();
        const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl });
        connectAndOpenAll(connection, instances);
        connection.subscribe({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" }, "consumer-a");

        const spotSocket = instanceForUrl(instances, "stream.binance.com/stream");
        spotSocket.simulateMessage(tradeWire("BTCUSDT", 1));
        await flushAsync();
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: false,
          recoveryState: "READY",
        });

        jest.setSystemTime(Date.now() + 30_001);
        expect(connection.getFeedHealth("SPOT", "BTCUSDT", "TRADE")).toEqual({
          stale: true,
          recoveryState: "READY",
        });
        expect(connection.getStatus().SPOT.public).toBe("CONNECTED");
        expect(spotSocket.readyState).toBe(1);

        connection.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("fetchRecentKlines (thin wiring to binance-kline-backfill.js)", () => {
    // A light integration check that the connection's own fetchImpl/
    // telemetry actually reach the backfill module -- pagination,
    // partial-failure handling, and row validation are already
    // exhaustively covered in binance-kline-backfill.test.js and
    // binance-event-normalizer.test.js; this isn't a relitigation of
    // that, just confirmation the wiring is real.
    function klineRow(openTime) {
      return [openTime, "100.00", "101.00", "99.00", "100.50", "1.0", openTime + 59_999, "100.5", 5, "0.5", "50.0", "0"];
    }

    function jsonResponse(body) {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    test("threads this connection's own fetchImpl through to a real backfill call", async () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const openTime = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
      const fetchImpl = jest.fn(async () => jsonResponse([klineRow(openTime)]));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });

      const result = await connection.fetchRecentKlines("SPOT", "BTCUSDT", {
        interval: "1m",
        intervalMs: 60_000,
        days: 60_000 / (24 * 60 * 60 * 1000),
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringContaining("/api/v3/klines?symbol=BTCUSDT&interval=1m"),
        expect.any(Object),
      );
      expect(result.ok).toBe(true);
      expect(result.rows).toEqual([
        {
          openTime, open: "100.00", high: "101.00", low: "99.00", close: "100.50", volume: "1.0",
          closeTime: openTime + 59_999, quoteVolume: "100.5", numberOfTrades: 5,
          takerBuyBaseVolume: "0.5", takerBuyQuoteVolume: "50.0",
        },
      ]);
    });

    test("a failed page surfaces the same honest partial-failure shape binance-kline-backfill.js itself produces", async () => {
      const { WebSocketImpl } = createFakeWebSocketImpl();
      const fetchImpl = jest.fn(async () => new Response("{}", { status: 500 }));
      const connection = createBinanceConnection({ webSocketImpl: WebSocketImpl, fetchImpl });

      const result = await connection.fetchRecentKlines("SPOT", "BTCUSDT", {
        interval: "1m",
        intervalMs: 60_000,
        days: 1,
      });

      expect(result).toEqual({ ok: false, reason: "HTTP_ERROR", rows: [] });
    });
  });
});
