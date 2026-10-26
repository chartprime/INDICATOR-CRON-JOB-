const http = require("node:http");
const { createRuntimeHealthMonitor } = require("../platform/runtime-health-monitor");
const { WebSocket, WebSocketServer } = require("ws");
const { createBinanceConnection } = require("../providers/binance/binance-connection");
const { binanceEndpointsFromEnv } = require("../providers/binance/binance-config");
const { assertAllowedSymbol } = require("../providers/binance/binance-subscription-guard");
const { createMarketDataServer } = require("./market-data-server");
const { createDxFeedMarketDataServer } = require("./dxfeed-market-data-server");
const { createDxFeedEagerMarketDataServer } = require("./dxfeed-eager-market-data-server");
const { createProviderRouter } = require("./provider-router");
const { createArchiveRouteOrRefuse } = require("./archive-route");
const { createHistoricalL2Route } = require("./historical-l2-route");
const { createHeatmapRoute, HEATMAP_WALLS_PATH } = require("./heatmap-route");
const { createPyramidReader } = require("../indicators/l2-memory/pyramid/pyramid-reader");
const { defaultHeatmapDir } = require("../indicators/l2-memory/pyramid/pyramid-paths");
const { createStorageReader } = require("../storage/storage-reader");
const { createRemoteStorageReader } = require("../storage/remote-storage-reader");
const { DEFAULT_DB_PATH } = require("../storage/storage-db");
const { createVolumeProfileCache, DEFAULT_VOLUME_PROFILE_CACHE_PATH } = require("../indicators/volume-profile/volume-profile-cache");
const { createDxFeedStorageReader } = require("../storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../storage/dxfeed/remote-dxfeed-storage-reader");
const { DEFAULT_DB_PATH: DEFAULT_DXFEED_DB_PATH } = require("../storage/dxfeed/dxfeed-storage-db");
const { listAllowedSymbols } = require("../providers/binance/binance-config");
const { hostReadMeter } = require("../platform/host-read-meter");

const DEFAULT_PORT = 8001;
const DEFAULT_SYMBOL = listAllowedSymbols()[0];
const DEFAULT_HOST = "127.0.0.1";
const MAX_CLIENT_MESSAGE_BYTES = 16_384;
const DEFAULT_MAX_WS_CLIENTS = 32;
const DEFAULT_MAX_CLIENT_MESSAGES_PER_WINDOW = 120;
const DEFAULT_CLIENT_MESSAGE_RATE_WINDOW_MS = 1_000;
const DEFAULT_WS_HEARTBEAT_MS = 30_000;
const DEFAULT_BINANCE_TRADE_QUEUE_DEPTH = 5_000;

function positiveIntegerFromEnv(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_ALLOWED_ORIGINS = Object.freeze(["http://127.0.0.1:8000", "http://localhost:8000"]);
const ALLOWED_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isSerializedHttpOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function resolveStorageReader({ dbPath, liveStorageServiceUrl, liveStorageClientToken, log = console.error }) {
  if (!liveStorageServiceUrl) return createStorageReader({ dbPath });
  try {
    return createRemoteStorageReader({ baseUrl: liveStorageServiceUrl, token: liveStorageClientToken });
  } catch (error) {
    log("app: remote storage reader misconfigured, falling back to local", error?.message ?? error);
    return createStorageReader({ dbPath });
  }
}

function resolveDxFeedStorageReader({ dbPath, liveStorageServiceUrl, liveStorageClientToken, log = console.error }) {
  if (!liveStorageServiceUrl) return createDxFeedStorageReader({ dbPath });
  try {
    return createRemoteDxFeedStorageReader({ baseUrl: liveStorageServiceUrl, token: liveStorageClientToken });
  } catch (error) {
    log("app: remote dxFeed storage reader misconfigured, falling back to local", error?.message ?? error);
    return createDxFeedStorageReader({ dbPath });
  }
}

function createApp({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  symbol = DEFAULT_SYMBOL,
  telemetry,
  webSocketImpl = WebSocket,
  fetchImpl,
  tickSizeResolver,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  dbPath = DEFAULT_DB_PATH,
  dxfeedDbPath = DEFAULT_DXFEED_DB_PATH,
  volumeProfileCachePath = DEFAULT_VOLUME_PROFILE_CACHE_PATH,
  dxfeedBrokerUrl = process.env.TT_DXFEED_TOKEN_BROKER_URL,
  liveStorageServiceUrl = process.env.TT_LIVE_STORAGE_SERVICE_URL,
  liveStorageClientToken = process.env.TT_LIVE_STORAGE_CLIENT_TOKEN,
  dxfeedCreateConnection,
  dxfeedRequestToken,
  dxfeedEager = false,
  maxWsClients = DEFAULT_MAX_WS_CLIENTS,
  maxClientMessagesPerWindow = DEFAULT_MAX_CLIENT_MESSAGES_PER_WINDOW,
  clientMessageRateWindowMs = DEFAULT_CLIENT_MESSAGE_RATE_WINDOW_MS,
  wsHeartbeatMs = DEFAULT_WS_HEARTBEAT_MS,
  binanceTradeQueueDepth = positiveIntegerFromEnv(process.env.BINANCE_TRADE_QUEUE_DEPTH) ?? DEFAULT_BINANCE_TRADE_QUEUE_DEPTH,
  binanceEndpoints = binanceEndpointsFromEnv(process.env),
  archiveRoute = createArchiveRouteOrRefuse(),
  historicalL2Route = createHistoricalL2Route(),
  heatmapRoute,
  heatmapWallsRoute,
  heatmapDir = process.env.TT_HEATMAP_DIR || null,
  clientBufferSoftBytes,
  clientBufferHardBytes,
  clientBufferGraceMs,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("createApp: port must be an integer between 0 and 65535");
  }
  if (typeof host !== "string" || !ALLOWED_BIND_HOSTS.has(host)) {
    throw new Error("createApp: host must be an explicit loopback address");
  }
  assertAllowedSymbol(symbol);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => !isSerializedHttpOrigin(origin))) {
    throw new Error("createApp: allowedOrigins must contain only serialized HTTP(S) origins");
  }
  for (const [name, value] of [
    ["maxWsClients", maxWsClients],
    ["maxClientMessagesPerWindow", maxClientMessagesPerWindow],
    ["clientMessageRateWindowMs", clientMessageRateWindowMs],
    ["wsHeartbeatMs", wsHeartbeatMs],
    ["binanceTradeQueueDepth", binanceTradeQueueDepth],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`createApp: ${name} must be a positive safe integer`);
    }
  }
  const allowedOriginSet = new Set(allowedOrigins);
  const connection = createBinanceConnection({
    telemetry, webSocketImpl, fetchImpl, backpressureMaxQueueDepth: binanceTradeQueueDepth, endpoints: binanceEndpoints,
  });
  const storageReader = resolveStorageReader({ dbPath, liveStorageServiceUrl, liveStorageClientToken });
  const volumeProfileCache = createVolumeProfileCache({ dbPath: volumeProfileCachePath });
  const clientBufferOptions = {
    ...(clientBufferSoftBytes === undefined ? {} : { clientBufferSoftBytes }),
    ...(clientBufferHardBytes === undefined ? {} : { clientBufferHardBytes }),
    ...(clientBufferGraceMs === undefined ? {} : { clientBufferGraceMs }),
  };
  const marketDataServer = createMarketDataServer({ connection, symbol, storageReader, volumeProfileCache, ...clientBufferOptions, ...(tickSizeResolver ? { tickSizeResolver } : {}) });
  const dxfeedStorageReader = resolveDxFeedStorageReader({
    dbPath: dxfeedDbPath,
    liveStorageServiceUrl,
    liveStorageClientToken,
  });
  const createDxfeedServer = dxfeedEager ? createDxFeedEagerMarketDataServer : createDxFeedMarketDataServer;
  const dxfeedMarketDataServer = createDxfeedServer({
    storageReader: dxfeedStorageReader,
    volumeProfileCache,
    telemetry,
    brokerUrl: dxfeedBrokerUrl,
    ...clientBufferOptions,
    ...(tickSizeResolver ? { tickSizeResolver } : {}),
    ...(dxfeedCreateConnection ? { createConnection: dxfeedCreateConnection } : {}),
    ...(dxfeedRequestToken ? { requestToken: dxfeedRequestToken } : {}),
  });
  const router = createProviderRouter({ binanceServer: marketDataServer, dxfeedServer: dxfeedMarketDataServer });
  const localHeatmapReader = heatmapRoute !== undefined || typeof storageReader.readHeatmapColumns === "function"
    ? null
    : createPyramidReader({ dir: heatmapDir ?? defaultHeatmapDir() });
  const heatmap = heatmapRoute ?? createHeatmapRoute({
    allowedOrigins: allowedOriginSet,
    read: localHeatmapReader === null
      ? (provider, symbol, kind, options, signal) => storageReader.readHeatmapColumns(symbol, kind, options, { signal, provider: provider === "DXFEED" ? "dxfeed" : "binance" })
      : (provider, symbol, kind, options) => localHeatmapReader.readHeatmapColumns(provider === "DXFEED" ? "dxfeed" : "binance", symbol, kind, options),
  });
  const heatmapWalls = heatmapWallsRoute ?? createHeatmapRoute({
    allowedOrigins: allowedOriginSet,
    path: HEATMAP_WALLS_PATH,
    routeName: "wall-history",
    read: localHeatmapReader === null
      ? (provider, symbol, kind, options, signal) => (typeof storageReader.readWallHistory === "function"
        ? storageReader.readWallHistory(symbol, kind, options, { signal, provider: provider === "DXFEED" ? "dxfeed" : "binance" })
        : Promise.resolve({ available: false, reason: "NO_READER", walls: [], next: null }))
      : (provider, symbol, kind, options) => localHeatmapReader.readWallHistory(provider === "DXFEED" ? "dxfeed" : "binance", symbol, kind, options),
  });
  let ready = false;
  let starting = false;
  let permanentlyStopped = false;
  let lifecycleGeneration = 0;
  let stopPromise = null;
  let listenPromise = null;
  let heartbeatTimer = null;
  const messageWindowsByClient = new Map();
  const runtimeHealth = createRuntimeHealthMonitor();

  function activeRouteHealth() {
    const provider = router.getActiveProvider();
    const providerReadiness = provider === "DXFEED"
      ? dxfeedMarketDataServer.currentReadiness()
      : marketDataServer.currentReadiness();
    const dimensions = providerReadiness?.dimensions ?? {};
    const identity = provider === "DXFEED"
      ? { provider, ...(dxfeedMarketDataServer.currentSymbolInfo() ?? {}) }
      : { provider, ...(providerReadiness?.identity ?? {}) };
    const binancePublicStatus = provider === "BINANCE"
      ? connection.getStatus()?.[identity.marketKind]?.public
      : null;
    const marketClosed = provider === "DXFEED" && dimensions.transport === "CLOSED";
    const routeReady = provider === "DXFEED"
      ? marketClosed || (dimensions.transport === "READY" && dimensions.capture === "READY")
      : binancePublicStatus === "CONNECTED";
    return Object.freeze({ ready: routeReady, marketClosed, identity: Object.freeze(identity), readiness: providerReadiness });
  }

  function markClientClose(socket, cause) {
    if (socket.closeCause !== undefined) return;
    socket.closeCause = cause;
    socket.closeBufferedAmount = socket.bufferedAmount;
  }

  function logClientDisconnect(socket, code, reasonBuffer) {
    const window = messageWindowsByClient.get(socket);
    console.info("app: WebSocket client disconnected", {
      code,
      reason: Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString("utf8").slice(0, 64) : String(reasonBuffer ?? ""),
      cause: socket.closeCause ?? "peer",
      ageMs: typeof socket.connectedAtMs === "number" ? Date.now() - socket.connectedAtMs : null,
      bufferedAmount: socket.closeBufferedAmount ?? socket.bufferedAmount ?? null,
      messagesInWindow: window?.messages ?? 0,
      remainingClients: wss.clients.size,
    });
  }

  function closeClient(socket, code, reason) {
    markClientClose(socket, `server-${code}`);
    try {
      socket.close(code, reason);
    } catch {
      try {
        socket.terminate?.();
      } catch {
        void 0;
      }
    }
  }

  function allowClientMessage(socket, nowMs = Date.now()) {
    let window = messageWindowsByClient.get(socket);
    if (!window || nowMs < window.startedAtMs || nowMs - window.startedAtMs >= clientMessageRateWindowMs) {
      window = { startedAtMs: nowMs, messages: 0 };
      messageWindowsByClient.set(socket, window);
    }
    window.messages += 1;
    return window.messages <= maxClientMessagesPerWindow;
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      try {
        const activeRoute = activeRouteHealth();
        const payload = {
          ready: ready && activeRoute.ready,
          serviceReady: ready,
          activeProvider: activeRoute.identity.provider,
          activeRoute,
          status: connection.getStatus(),
          connections: router.connectedClientCount(),
          runtime: { ...runtimeHealth.getStats(), hostReads: hostReadMeter.snapshot() },
          delivery: connection.getOperationalStats(),
          analytics: marketDataServer.currentAnalyticsStatus(),
          readiness: marketDataServer.currentReadiness(),
          recording: marketDataServer.recordingStatus(),
          heatmapHistory: heatmap.stats(),
          dxfeed: {
            active: dxfeedMarketDataServer.isActive(),
            recoveryState: dxfeedMarketDataServer.currentRecoveryState(),
            selection: dxfeedMarketDataServer.currentSymbolInfo(),
            orderV2Capture: dxfeedMarketDataServer.orderV2CaptureStatus(),
            instruments: dxfeedMarketDataServer.instrumentSnapshot(),
            readiness: dxfeedMarketDataServer.currentReadiness(),
          },
        };
        res.writeHead(payload.ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(payload));
      } catch (error) {
        console.error("app: health probe failed", error?.message ?? error);
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ready: false, error: "HEALTH_PROBE_FAILED" }));
      }
      return;
    }
    if (heatmap.handle(req, res)) return;
    if (heatmapWalls.handle(req, res)) return;
    if (archiveRoute && archiveRoute.handle(req, res)) return;
    if (historicalL2Route && historicalL2Route.handle(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    // The frames are JSON and repeat their field names on every bar, trade and
    // book row, so they compress about eight times over. A client's first
    // snapshot carries a week of candles and was ~3 MB on the wire; deflated it
    // is ~0.36 MB, and the live stream costs about a fifth of what it did.
    // Browsers negotiate this themselves, so nothing on the client changes.
    // Settings follow the ws project's guidance: a cheap compression level, no
    // context carried between messages (bounded memory per client), and a
    // threshold so small frames are sent as they are rather than deflated.
    perMessageDeflate: {
      zlibDeflateOptions: { level: 3, memLevel: 7, chunkSize: 1024 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024,
    },
    verifyClient: ({ origin }, done) => {
      if (!origin || allowedOriginSet.has(origin)) {
        done(true);
        return;
      }
      done(false, 403, "Forbidden origin");
    },
  });
  wss.on("error", (error) => {
    if (ready) {
      console.error("websocket server error", error?.message ?? error);
    }
  });
  wss.on("connection", (socket) => {
    if (!ready) {
      closeClient(socket, 1013, "Market data service is starting");
      return;
    }
    if (wss.clients.size > maxWsClients) {
      closeClient(socket, 1013, "Market data service client capacity reached");
      return;
    }
    try {
      router.handleConnection(socket);
    } catch (error) {
      console.error("app: failed to register WebSocket client", error?.message ?? error);
      try {
        router.handleDisconnection(socket);
      } catch {
        void 0;
      }
      closeClient(socket, 1011, "Unable to initialize market data session");
      return;
    }
    socket.isAlive = true;
    socket.connectedAtMs = Date.now();
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("close", (code, reasonBuffer) => {
      try {
        logClientDisconnect(socket, code, reasonBuffer);
      } catch {
        void 0;
      }
      messageWindowsByClient.delete(socket);
      try {
        router.handleDisconnection(socket);
      } catch (error) {
        console.error("app: WebSocket client cleanup failed", error?.message ?? error);
      }
    });
    socket.on("error", () => {});
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        closeClient(socket, 1003, "Text messages only");
        return;
      }
      if (!allowClientMessage(socket)) {
        closeClient(socket, 1008, "Client message rate limit exceeded");
        return;
      }
      try {
        router.handleMessage(raw.toString("utf8"), socket);
      } catch (error) {
        console.error("app: client message handling failed", error?.message ?? error);
        closeClient(socket, 1011, "Unable to process market data request");
      }
    });
  });

  async function start() {
    if (starting || ready || permanentlyStopped) {
      throw new Error("app: start() is only supported once");
    }
    starting = true;
    const generationAtStart = ++lifecycleGeneration;
    try {
      listenPromise = new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", onError);
          resolve();
        });
      });
      await listenPromise;
      if (permanentlyStopped || generationAtStart !== lifecycleGeneration) {
        throw new Error("app: stopped during startup");
      }
      await marketDataServer.start();
      if (permanentlyStopped || generationAtStart !== lifecycleGeneration) {
        throw new Error("app: stopped during startup");
      }
      dxfeedMarketDataServer.start();
      runtimeHealth.start();
      ready = true;
      heartbeatTimer = setInterval(() => {
        for (const client of wss.clients) {
          if (client.isAlive === false) {
            markClientClose(client, "heartbeat-missed-pong");
            try {
              client.terminate();
            } catch {
              void 0;
            }
            continue;
          }
          client.isAlive = false;
          try {
            client.ping();
          } catch {
            markClientClose(client, "heartbeat-ping-failed");
            try {
              client.terminate();
            } catch {
              void 0;
            }
          }
        }
      }, wsHeartbeatMs);
      heartbeatTimer.unref?.();
    } catch (error) {
      try {
        await stop();
      } catch (cleanupError) {
        console.error("app: startup cleanup failed", cleanupError?.message ?? cleanupError);
      }
      throw error;
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    ready = false;
    runtimeHealth.stop();
    permanentlyStopped = true;
    lifecycleGeneration += 1;
    let resolveStop;
    let rejectStop;
    // Publish completion before invoking owners: cleanup can reenter stop().
    stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    const cleanupErrors = [];
    function attempt(operation) {
      try {
        return Promise.resolve(operation()).catch((error) => { cleanupErrors.push(error); });
      } catch (error) {
        cleanupErrors.push(error);
        return Promise.resolve();
      }
    }
    if (archiveRoute) attempt(() => archiveRoute.dispose());
    if (historicalL2Route) attempt(() => historicalL2Route.dispose());
    attempt(() => heatmap.dispose());
    attempt(() => heatmapWalls.dispose());
    const providersStopped = Promise.all([
      attempt(() => marketDataServer.stop()),
      attempt(() => dxfeedMarketDataServer.stop()),
    ]);
    const storesClosed = providersStopped.then(() => Promise.all([
      attempt(() => storageReader.close()),
      attempt(() => dxfeedStorageReader.close()),
      attempt(() => volumeProfileCache.close()),
      attempt(() => localHeatmapReader?.close()),
    ]));
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const clientsTerminated = [...wss.clients].map((client) => attempt(() => client.terminate()));
    messageWindowsByClient.clear();
    Promise.all([
      storesClosed,
      ...clientsTerminated,
      new Promise((resolve) => {
        try {
          wss.close((error) => {
            if (error) cleanupErrors.push(error);
            resolve();
          });
        } catch (error) {
          if (!String(error?.message ?? error).includes("not running")) cleanupErrors.push(error);
          resolve();
        }
      }),
      // A stop during bind must also close a listener that becomes ready later.
      // Wait only for bind, not start(): cancelled startup itself awaits stop().
      Promise.resolve(listenPromise).catch(() => {}).then(() => attempt(() => new Promise((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }))),
    ]).then(() => {
      if (cleanupErrors.length > 0) {
        rejectStop(new AggregateError(cleanupErrors, "app: one or more shutdown steps failed"));
      } else {
        resolveStop();
      }
    }, rejectStop);
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    httpServer,
    wss,
    connection,
    marketDataServer,
    storageReader,
    dxfeedMarketDataServer,
    dxfeedStorageReader,
    router,
  });
}

module.exports = {
  createApp,
  DEFAULT_PORT,
  DEFAULT_SYMBOL,
  DEFAULT_HOST,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_DB_PATH,
  DEFAULT_DXFEED_DB_PATH,
  MAX_CLIENT_MESSAGE_BYTES,
  DEFAULT_MAX_WS_CLIENTS,
  DEFAULT_MAX_CLIENT_MESSAGES_PER_WINDOW,
  DEFAULT_CLIENT_MESSAGE_RATE_WINDOW_MS,
  DEFAULT_WS_HEARTBEAT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
};
