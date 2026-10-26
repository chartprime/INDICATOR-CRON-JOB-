const { WebSocket: DefaultWebSocket } = require("ws");
const {
  MARKET_KINDS,
  EVENT_TYPES,
  createBinanceMarketKindContext,
  restBaseUrlFor,
  resolveBinanceEndpoints,
  DEFAULT_BINANCE_ENDPOINTS,
} = require("./binance-config");
const {
  describeBinanceSubscription,
  safeTelemetrySymbol,
  safeTelemetryMarketKind,
  safeTelemetryErrorCode,
} = require("./binance-subscription-guard");
const { emitTelemetry } = require("../../platform/telemetry");
const { normalizeBinanceEvent } = require("./binance-event-normalizer");
const { fetchDepthSnapshot, DEFAULT_TIMEOUT_MS: DEPTH_SNAPSHOT_FETCH_TIMEOUT_MS } = require("./binance-http-client");
const { createBinanceBookAssembler } = require("./binance-book-assembler");
const { createBinanceFeedHealthMonitor } = require("./binance-feed-health");
const {
  createBinanceBackpressureQueue,
  OVERFLOW_POLICIES,
  BinanceBackpressureOverflowError,
} = require("./binance-backpressure-queue");
const { createBinanceKlineBackfill } = require("./binance-kline-backfill");
const { performance } = require("node:perf_hooks");

const ROUTE_FOR_EVENT_TYPE = Object.freeze({
  SPOT: Object.freeze({
    TRADE: "public",
    BOOK_TICKER: "public",
    KLINE: "public",
    DEPTH: "public",
  }),
  PERPETUAL: Object.freeze({
    TRADE: "public",
    BOOK_TICKER: "public",
    KLINE: "market",
    DEPTH: "public",
  }),
});

const COMBINED_STREAM_PATH = "/stream";
const DEPTH_STREAM_UPDATE_SPEED = "100ms";
const MAX_WS_MESSAGE_BYTES = 262_144;
const MAX_LISTENERS = 50;
const MAX_PENDING_CONTROL_MESSAGES = 100;
const CONTROL_ACK_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_RECONNECT_STABILITY_MS = 30_000;
const DEPTH_RETRY_BASE_DELAY_MS = 1000;
const DEPTH_RETRY_MAX_DELAY_MS = 30_000;
const DEPTH_RETRY_JITTER_RATIO = 0.2;
const DEPTH_RECOVERY_STALE_MS =
  Math.round(DEPTH_RETRY_BASE_DELAY_MS * (1 + DEPTH_RETRY_JITTER_RATIO)) +
  DEPTH_SNAPSHOT_FETCH_TIMEOUT_MS +
  DEPTH_RETRY_BASE_DELAY_MS;
const BACKPRESSURE_DRAIN_BATCH_SIZE = 50;
const DEFAULT_BACKPRESSURE_DRAIN_MAX_MS = 8;
const DEFAULT_BACKPRESSURE_MAX_QUEUE_DEPTH = 500;
const DEFAULT_RAW_INGRESS_MAX_QUEUE_DEPTH = 10_000;
const DEFAULT_RAW_INGRESS_MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RAW_INGRESS_DRAIN_BATCH_SIZE = 1_000;
const DEFAULT_RAW_INGRESS_DRAIN_MAX_MS = 8;
const DEFAULT_ROUTE_SILENCE_TIMEOUT_MS = 60_000;
const DEFAULT_ROUTE_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_ROUTE_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_AUTOMATIC_STALE_RECOVERY_ROUTE_COOLDOWN_MS = 30_000;
const DEFAULT_DEPTH_SNAPSHOT_REFRESH_INTERVAL_MS = 20 * 60_000;
const DEPTH_SHADOW_REFRESH_RETRY_COOLDOWN_MS = 1_000;

function assertConsumerId(consumerId) {
  if (typeof consumerId !== "string" || consumerId.length === 0) {
    throw new Error("A non-empty consumerId is required to subscribe or unsubscribe.");
  }
}

function wireStreamName(symbol, eventType, interval) {
  const lowerSymbol = symbol.toLowerCase();
  if (eventType === EVENT_TYPES.TRADE) return `${lowerSymbol}@trade`;
  if (eventType === EVENT_TYPES.BOOK_TICKER) return `${lowerSymbol}@bookTicker`;
  if (eventType === EVENT_TYPES.KLINE) return `${lowerSymbol}@kline_${interval}`;
  if (eventType === EVENT_TYPES.DEPTH) return `${lowerSymbol}@depth@${DEPTH_STREAM_UPDATE_SPEED}`;
  throw new Error(`Unsupported Binance event type for wire stream name (${eventType})`);
}

function parseWireStreamName(streamName) {
  if (typeof streamName !== "string") {
    return null;
  }
  const separator = streamName.indexOf("@");
  if (separator <= 0) {
    return null;
  }
  const symbol = streamName.slice(0, separator).toUpperCase();
  const suffix = streamName.slice(separator + 1);
  if (suffix === "trade") {
    return { symbol, eventType: EVENT_TYPES.TRADE };
  }
  if (suffix === "bookTicker") {
    return { symbol, eventType: EVENT_TYPES.BOOK_TICKER };
  }
  if (suffix === `depth@${DEPTH_STREAM_UPDATE_SPEED}`) {
    return { symbol, eventType: EVENT_TYPES.DEPTH };
  }
  if (suffix.startsWith("kline_")) {
    return { symbol, eventType: EVENT_TYPES.KLINE, interval: suffix.slice("kline_".length) };
  }
  return null;
}

function combinedStreamUrl(baseUrl) {
  return `${baseUrl}${COMBINED_STREAM_PATH}`;
}

function createBinanceConnection(options = {}) {
  const {
    telemetry,
    webSocketImpl = DefaultWebSocket,
    fetchImpl = globalThis.fetch,
    routeSilenceTimeoutMs = DEFAULT_ROUTE_SILENCE_TIMEOUT_MS,
    routeConnectTimeoutMs = DEFAULT_ROUTE_CONNECT_TIMEOUT_MS,
    routeWatchdogIntervalMs = DEFAULT_ROUTE_WATCHDOG_INTERVAL_MS,
    automaticStaleRecoveryRouteCooldownMs = DEFAULT_AUTOMATIC_STALE_RECOVERY_ROUTE_COOLDOWN_MS,
    reconnectStabilityMs = DEFAULT_RECONNECT_STABILITY_MS,
    depthSnapshotRefreshIntervalMs = DEFAULT_DEPTH_SNAPSHOT_REFRESH_INTERVAL_MS,
    backpressureOverflowPolicy = OVERFLOW_POLICIES.DROP_OLDEST,
    backpressureMaxQueueDepth = DEFAULT_BACKPRESSURE_MAX_QUEUE_DEPTH,
    backpressureDrainBatchSize = BACKPRESSURE_DRAIN_BATCH_SIZE,
    backpressureDrainMaxMs = DEFAULT_BACKPRESSURE_DRAIN_MAX_MS,
    backpressureNow = () => performance.now(),
    routeSilenceRecoveryAllowed = () => true,
    rawIngressEnabled = false,
    rawIngressMaxQueueDepth = DEFAULT_RAW_INGRESS_MAX_QUEUE_DEPTH,
    rawIngressMaxQueueBytes = DEFAULT_RAW_INGRESS_MAX_QUEUE_BYTES,
    rawIngressDrainBatchSize = DEFAULT_RAW_INGRESS_DRAIN_BATCH_SIZE,
    rawIngressDrainMaxMs = DEFAULT_RAW_INGRESS_DRAIN_MAX_MS,
    rawIngressPauseQueueDepth = Math.max(1, Math.floor(rawIngressMaxQueueDepth * 0.4)),
    rawIngressResumeQueueDepth = Math.max(0, Math.floor(rawIngressMaxQueueDepth * 0.1)),
    rawIngressPauseQueueBytes = Math.max(1, Math.floor(rawIngressMaxQueueBytes * 0.5)),
    rawIngressResumeQueueBytes = Math.max(0, Math.floor(rawIngressMaxQueueBytes * 0.125)),
    rawIngressNow = () => performance.now(),
    endpoints = DEFAULT_BINANCE_ENDPOINTS,
  } = options;

  if (typeof webSocketImpl !== "function") {
    throw new Error("Binance connection requires a WebSocket implementation.");
  }
  const resolvedEndpoints = resolveBinanceEndpoints(endpoints);
  if (!Number.isSafeInteger(routeSilenceTimeoutMs) || routeSilenceTimeoutMs <= 0) {
    throw new Error("routeSilenceTimeoutMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(routeConnectTimeoutMs) || routeConnectTimeoutMs <= 0) {
    throw new Error("routeConnectTimeoutMs must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(routeWatchdogIntervalMs) ||
    routeWatchdogIntervalMs <= 0 ||
    routeWatchdogIntervalMs > routeSilenceTimeoutMs
  ) {
    throw new Error("routeWatchdogIntervalMs must be a positive safe integer no greater than routeSilenceTimeoutMs.");
  }
  if (
    !Number.isSafeInteger(automaticStaleRecoveryRouteCooldownMs) ||
    automaticStaleRecoveryRouteCooldownMs <= 0
  ) {
    throw new Error("automaticStaleRecoveryRouteCooldownMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(reconnectStabilityMs) || reconnectStabilityMs <= 0) {
    throw new Error("reconnectStabilityMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(depthSnapshotRefreshIntervalMs) || depthSnapshotRefreshIntervalMs <= 0) {
    throw new Error("depthSnapshotRefreshIntervalMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(backpressureDrainBatchSize) || backpressureDrainBatchSize <= 0) {
    throw new Error("backpressureDrainBatchSize must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(backpressureDrainMaxMs) || backpressureDrainMaxMs <= 0) {
    throw new Error("backpressureDrainMaxMs must be a positive safe integer.");
  }
  if (typeof backpressureNow !== "function") {
    throw new Error("backpressureNow must be a function.");
  }
  if (typeof routeSilenceRecoveryAllowed !== "function") {
    throw new Error("routeSilenceRecoveryAllowed must be a function.");
  }
  if (typeof rawIngressEnabled !== "boolean") {
    throw new Error("rawIngressEnabled must be a boolean.");
  }
  for (const [name, value] of [
    ["rawIngressMaxQueueDepth", rawIngressMaxQueueDepth],
    ["rawIngressMaxQueueBytes", rawIngressMaxQueueBytes],
    ["rawIngressDrainBatchSize", rawIngressDrainBatchSize],
    ["rawIngressDrainMaxMs", rawIngressDrainMaxMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  if (typeof rawIngressNow !== "function") {
    throw new Error("rawIngressNow must be a function.");
  }
  if (
    !Number.isSafeInteger(rawIngressPauseQueueDepth) ||
    rawIngressPauseQueueDepth <= 0 ||
    rawIngressPauseQueueDepth > rawIngressMaxQueueDepth
  ) {
    throw new Error("rawIngressPauseQueueDepth must be a positive safe integer no greater than rawIngressMaxQueueDepth.");
  }
  if (
    !Number.isSafeInteger(rawIngressResumeQueueDepth) ||
    rawIngressResumeQueueDepth < 0 ||
    rawIngressResumeQueueDepth >= rawIngressPauseQueueDepth
  ) {
    throw new Error("rawIngressResumeQueueDepth must be a non-negative safe integer below rawIngressPauseQueueDepth.");
  }
  if (
    !Number.isSafeInteger(rawIngressPauseQueueBytes) ||
    rawIngressPauseQueueBytes <= 0 ||
    rawIngressPauseQueueBytes > rawIngressMaxQueueBytes
  ) {
    throw new Error("rawIngressPauseQueueBytes must be a positive safe integer no greater than rawIngressMaxQueueBytes.");
  }
  if (
    !Number.isSafeInteger(rawIngressResumeQueueBytes) ||
    rawIngressResumeQueueBytes < 0 ||
    rawIngressResumeQueueBytes >= rawIngressPauseQueueBytes
  ) {
    throw new Error("rawIngressResumeQueueBytes must be a non-negative safe integer below rawIngressPauseQueueBytes.");
  }

  const marketKindContexts = Object.freeze({
    SPOT: createBinanceMarketKindContext(MARKET_KINDS.SPOT, resolvedEndpoints),
    PERPETUAL: createBinanceMarketKindContext(MARKET_KINDS.PERPETUAL, resolvedEndpoints),
  });
  const bookAssemblers = new Map();
  const depthSnapshots = new Map();
  const depthRequestEpoch = new Map();
  const depthRetryAttempt = new Map();
  const depthRetryTimers = new Map();
  const depthGapRecoveryPending = new Set();
  const depthShadowRefreshes = new Map();
  const depthShadowRefreshNotBefore = new Map();
  const feedHealth = createBinanceFeedHealthMonitor();
  const backpressureQueues = Object.freeze({
    SPOT: createBinanceBackpressureQueue({
      telemetry,
      maxQueueDepth: backpressureMaxQueueDepth,
      overflowPolicy: backpressureOverflowPolicy,
    }),
    PERPETUAL: createBinanceBackpressureQueue({
      telemetry,
      maxQueueDepth: backpressureMaxQueueDepth,
      overflowPolicy: backpressureOverflowPolicy,
    }),
  });
  const klineBackfill = createBinanceKlineBackfill({ fetchImpl, telemetry, endpoints: resolvedEndpoints });
  const backpressureDrainScheduled = { SPOT: false, PERPETUAL: false };
  const backpressureDrainCursor = { SPOT: 0, PERPETUAL: 0 };
  const backpressureEpochs = new Map();
  let backpressureDrainTimeYields = 0;
  let backpressureDrainSteps = 0;
  let backpressureDrained = 0;
  let backpressureDrainMs = 0;
  let rawIngressAccepted = 0;
  let rawIngressProcessed = 0;
  let rawIngressOverflows = 0;
  let rawIngressHighWaterMark = 0;
  let rawIngressHighWaterBytes = 0;
  let rawIngressDrainTimeYields = 0;
  let rawIngressLastDrainMs = 0;
  let rawIngressMaxDrainMs = 0;
  let rawIngressFlowControlPauses = 0;
  let rawIngressFlowControlResumes = 0;
  let rawIngressFlowControlFailures = 0;
  let rawIngressFlowControlTotalPausedMs = 0;
  let rawIngressFlowControlMaxPausedMs = 0;

  const messageListeners = new Set();
  const errorListeners = new Set();

  let sessionGeneration = 0;
  let acceptingMessages = true;
  let depthSnapshotRefreshTimer = null;

  function clearDepthRetryTimer(key) {
    const timer = depthRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    depthRetryTimers.delete(key);
  }

  function clearAllDepthRetryTimers() {
    for (const timer of depthRetryTimers.values()) clearTimeout(timer);
    depthRetryTimers.clear();
  }

  function buildRoutes() {
    const routes = new Map();
    for (const marketKind of Object.values(MARKET_KINDS)) {
      const context = marketKindContexts[marketKind];
      const routeNames = new Set(Object.values(ROUTE_FOR_EVENT_TYPE[marketKind]));
      for (const routeName of routeNames) {
        routes.set(`${marketKind}:${routeName}`, {
          marketKind,
          routeName,
          url: combinedStreamUrl(context.wsBaseUrls[routeName]),
          socket: null,
          connectionState: "DISCONNECTED",
          nextControlMessageId: 1,
          pendingControlMessages: new Map(),
          reconnectAttempt: 0,
          reconnectTimer: null,
          connectTimer: null,
          reconnectStabilityTimer: null,
          nextAutomaticStaleRecoveryAtMs: 0,
          lastMessageAtMs: null,
          watchdogTimer: null,
          rawFrames: [],
          rawFrameHead: 0,
          rawPendingBytes: 0,
          rawDrainScheduled: false,
          rawIngressPaused: false,
          rawIngressPausedAt: null,
        });
      }
    }
    return routes;
  }

  const routes = buildRoutes();

  function routeFor(marketKind, eventType) {
    const routeName = ROUTE_FOR_EVENT_TYPE[marketKind][eventType];
    return routes.get(`${marketKind}:${routeName}`);
  }

  function safelyInvokeListener(listener, payload, context) {
    try {
      listener(payload);
    } catch (error) {
      console.error(context, error?.message ?? error);
    }
  }

  function notifyMessageListeners(payload) {
    const frozen = Object.freeze(payload);
    if (messageListeners.size === 1) {
      const listener = messageListeners.values().next().value;
      safelyInvokeListener(listener, frozen, "binance message listener error");
      return;
    }
    for (const listener of [...messageListeners]) {
      safelyInvokeListener(listener, frozen, "binance message listener error");
    }
  }

  function notifyErrorListeners(payload) {
    const frozen = Object.freeze(payload);
    for (const listener of [...errorListeners]) {
      safelyInvokeListener(listener, frozen, "binance error listener error");
    }
  }

  function emitRouteTelemetry(eventName, route, extra = {}) {
    emitTelemetry(telemetry, eventName, {
      marketKind: safeTelemetryMarketKind(route.marketKind),
      route: route.routeName,
      ...extra,
    });
  }

  function pendingRawFrames(route) {
    return route.rawFrames.length - route.rawFrameHead;
  }

  function compactRawFrames(route) {
    if (route.rawFrameHead >= 1024 && route.rawFrameHead * 2 >= route.rawFrames.length) {
      route.rawFrames.splice(0, route.rawFrameHead);
      route.rawFrameHead = 0;
    }
  }

  function clearRawFrames(route) {
    route.rawFrames.length = 0;
    route.rawFrameHead = 0;
    route.rawPendingBytes = 0;
    route.rawDrainScheduled = false;
  }

  function finishRawIngressPause(route, socket, reason) {
    if (!route.rawIngressPaused) return true;
    const pausedAt = route.rawIngressPausedAt;
    route.rawIngressPaused = false;
    route.rawIngressPausedAt = null;
    const durationMs = pausedAt === null ? 0 : Math.max(0, rawIngressNow() - pausedAt);
    rawIngressFlowControlResumes += 1;
    rawIngressFlowControlTotalPausedMs += durationMs;
    rawIngressFlowControlMaxPausedMs = Math.max(rawIngressFlowControlMaxPausedMs, durationMs);
    let resumed = true;
    try {
      socket?.resume?.();
    } catch (error) {
      resumed = false;
      rawIngressFlowControlFailures += 1;
      emitRouteTelemetry("market_data.binance_raw_ingress.flow_control_failed", route, {
        action: "RESUME",
        reason: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
    if (!resumed) return false;
    if (route.socket === socket && route.connectionState === "CONNECTED") {
      route.lastMessageAtMs = Date.now();
    }
    emitRouteTelemetry("market_data.binance_raw_ingress.flow_control_resumed", route, {
      durationMs: Number(durationMs.toFixed(1)),
      queueDepth: pendingRawFrames(route),
      queueBytes: route.rawPendingBytes,
      reason,
    });
    return true;
  }

  function pauseRawIngressIfNeeded(route) {
    if (
      route.rawIngressPaused ||
      route.connectionState !== "CONNECTED" ||
      route.socket === null ||
      (pendingRawFrames(route) < rawIngressPauseQueueDepth && route.rawPendingBytes < rawIngressPauseQueueBytes)
    ) {
      return;
    }
    if (typeof route.socket.pause !== "function") return;
    try {
      route.socket.pause();
      route.rawIngressPaused = true;
      route.rawIngressPausedAt = rawIngressNow();
      rawIngressFlowControlPauses += 1;
      emitRouteTelemetry("market_data.binance_raw_ingress.flow_control_paused", route, {
        queueDepth: pendingRawFrames(route),
        queueBytes: route.rawPendingBytes,
      });
    } catch (error) {
      rawIngressFlowControlFailures += 1;
      emitRouteTelemetry("market_data.binance_raw_ingress.flow_control_failed", route, {
        action: "PAUSE",
        reason: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }

  function resumeRawIngressIfReady(route) {
    if (
      !route.rawIngressPaused ||
      pendingRawFrames(route) > rawIngressResumeQueueDepth ||
      route.rawPendingBytes > rawIngressResumeQueueBytes
    ) {
      return;
    }
    if (!finishRawIngressPause(route, route.socket, "LOW_WATERMARK")) {
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: "Binance raw-frame ingress transport could not resume.",
        code: "RAW_INGRESS_FLOW_CONTROL_FAILURE",
        fatal: false,
      });
      closeRoute(route);
      scheduleReconnect(route);
    }
  }

  function estimateRawFrameBytes(data) {
    if (typeof data === "string") return Math.max(2, data.length * 2);
    if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) return Math.max(1, data.byteLength);
    if (data instanceof ArrayBuffer) return Math.max(1, data.byteLength);
    return MAX_WS_MESSAGE_BYTES;
  }

  function drainRawFramesOnce(route) {
    const startedAt = rawIngressNow();
    let processed = 0;
    while (processed < rawIngressDrainBatchSize && route.rawFrameHead < route.rawFrames.length) {
      if (processed > 0 && processed % 8 === 0 && rawIngressNow() - startedAt >= rawIngressDrainMaxMs) {
        rawIngressDrainTimeYields += 1;
        break;
      }
      const frame = route.rawFrames[route.rawFrameHead];
      route.rawFrameHead += 1;
      route.rawPendingBytes = Math.max(0, route.rawPendingBytes - frame.bytes);
      processed += 1;
      rawIngressProcessed += 1;
      handleRawMessage(route, frame.data, frame.receivedAtMs);
    }
    compactRawFrames(route);
    rawIngressLastDrainMs = Math.max(0, rawIngressNow() - startedAt);
    rawIngressMaxDrainMs = Math.max(rawIngressMaxDrainMs, rawIngressLastDrainMs);
    resumeRawIngressIfReady(route);
    if (pendingRawFrames(route) > 0) scheduleRawFrameDrain(route);
  }

  function scheduleRawFrameDrain(route) {
    if (route.rawDrainScheduled || pendingRawFrames(route) === 0) return;
    route.rawDrainScheduled = true;
    setImmediate(() => {
      route.rawDrainScheduled = false;
      drainRawFramesOnce(route);
    }).unref?.();
  }

  function enqueueRawFrame(route, data, receivedAtMs) {
    const pending = pendingRawFrames(route);
    const bytes = estimateRawFrameBytes(data);
    const depthExceeded = pending >= rawIngressMaxQueueDepth;
    const bytesExceeded = route.rawPendingBytes + bytes > rawIngressMaxQueueBytes;
    if (depthExceeded || bytesExceeded) {
      rawIngressOverflows += 1;
      const fatal = backpressureOverflowPolicy === OVERFLOW_POLICIES.FAIL;
      emitRouteTelemetry("market_data.binance_raw_ingress.queue_overflow", route, {
        droppedCount: 1,
        queueDepth: pending,
        queueBytes: route.rawPendingBytes,
        incomingBytes: bytes,
        limitKind: depthExceeded ? "DEPTH" : "BYTES",
      });
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: depthExceeded
          ? `Binance raw-frame ingress queue overflow at depth ${pending}.`
          : `Binance raw-frame ingress queue exceeded ${rawIngressMaxQueueBytes} bytes.`,
        code: "RAW_INGRESS_OVERFLOW",
        fatal,
      });
      closeRoute(route);
      if (!fatal) scheduleReconnect(route);
      return;
    }
    route.rawFrames.push({ data, receivedAtMs, acceptedAt: rawIngressNow(), bytes });
    route.rawPendingBytes += bytes;
    rawIngressAccepted += 1;
    rawIngressHighWaterMark = Math.max(rawIngressHighWaterMark, pending + 1);
    rawIngressHighWaterBytes = Math.max(rawIngressHighWaterBytes, route.rawPendingBytes);
    pauseRawIngressIfNeeded(route);
    scheduleRawFrameDrain(route);
  }

  function openRoute(route) {
    if (route.socket && (route.connectionState === "CONNECTING" || route.connectionState === "CONNECTED")) {
      return;
    }
    route.connectionState = "CONNECTING";
    let socket;
    try {
      socket = new webSocketImpl(route.url, {
        maxPayload: MAX_WS_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
    } catch (error) {
      route.connectionState = "DISCONNECTED";
      route.socket = null;
      console.error("binance route open failed", error?.message ?? error);
      scheduleReconnect(route);
      return;
    }
    route.socket = socket;
    startConnectDeadline(route, socket);

    socket.onopen = () => {
      if (route.socket !== socket) {
        return;
      }
      clearConnectTimer(route);
      const generationAtOpen = sessionGeneration;
      const wasReconnect = route.reconnectAttempt > 0;
      clearPendingControlMessages(route);
      route.connectionState = "CONNECTED";
      route.lastMessageAtMs = Date.now();
      startRouteWatchdog(route);
      feedHealth.recordRouteConnected(route.marketKind, route.routeName);
      emitRouteTelemetry("market_data.binance_connection.route_connected", route);
      if (wasReconnect) {
        emitRouteTelemetry("market_data.binance_connection.route_reconnect_transport_open", route);
        startReconnectStabilityTimer(route, socket, generationAtOpen);
      }
      resubscribeRoute(route).catch((error) => {
        console.error("binance route resubscription failed", error?.message ?? error);
        if (route.socket !== socket || generationAtOpen !== sessionGeneration) {
          return;
        }
        closeRoute(route);
        scheduleReconnect(route);
      });
    };

    socket.onclose = (event) => {
      if (route.socket !== socket) {
        return;
      }
      route.connectionState = "DISCONNECTED";
      route.socket = null;
      finishRawIngressPause(route, socket, "ROUTE_CLOSED");
      clearConnectTimer(route);
      clearRouteWatchdog(route);
      clearReconnectStabilityTimer(route);
      route.lastMessageAtMs = null;
      clearPendingControlMessages(route);
      feedHealth.recordRouteDisconnected(route.marketKind, route.routeName);
      scheduleBackpressureDrain(route.marketKind);
      emitRouteTelemetry("market_data.binance_connection.route_disconnected", route, {
        closeCode: Number.isSafeInteger(event?.code) ? event.code : null,
        wasClean: event?.wasClean === true,
      });
      scheduleReconnect(route);
    };

    socket.onerror = (event) => {
      if (route.socket !== socket) {
        return;
      }
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: "Binance WebSocket connection error.",
      });
      emitRouteTelemetry("market_data.binance_connection.route_error", route);
      void event;
      closeRoute(route);
      scheduleReconnect(route);
    };

    socket.onmessage = (event) => {
      if (route.socket !== socket) {
        return;
      }
      const receivedAtMs = Date.now();
      route.lastMessageAtMs = receivedAtMs;
      if (!acceptingMessages) return;
      if (rawIngressEnabled) enqueueRawFrame(route, event?.data, receivedAtMs);
      else handleRawMessage(route, event?.data, receivedAtMs);
    };
  }

  function closeRoute(route) {
    const socket = route.socket;
    route.socket = null;
    route.connectionState = "DISCONNECTED";
    finishRawIngressPause(route, socket, "ROUTE_CLOSED");
    clearConnectTimer(route);
    clearRouteWatchdog(route);
    clearReconnectStabilityTimer(route);
    route.lastMessageAtMs = null;
    clearPendingControlMessages(route);
    feedHealth.recordRouteDisconnected(route.marketKind, route.routeName);
    scheduleBackpressureDrain(route.marketKind);
    if (socket) {
      emitRouteTelemetry("market_data.binance_connection.route_disconnected", route);
      try {
        socket.close();
      } catch {
        void 0;
      }
    }
  }

  function routeHasSubscriptions(route) {
    return marketKindContexts[route.marketKind].subscriptionRegistry
      .list()
      .some((entry) => ROUTE_FOR_EVENT_TYPE[route.marketKind][entry.eventType] === route.routeName);
  }

  function hasActiveSubscription(context, symbol, eventType, interval) {
    const registry = context.subscriptionRegistry;
    if (typeof registry.has === "function") {
      return registry.has(symbol, eventType, interval);
    }
    return registry.list().some(
      (entry) =>
        entry.symbol === symbol &&
        entry.eventType === eventType &&
        (entry.interval ?? null) === (interval ?? null),
    );
  }

  function clearRouteWatchdog(route) {
    if (route.watchdogTimer !== null) {
      clearInterval(route.watchdogTimer);
      route.watchdogTimer = null;
    }
  }

  function clearReconnectTimer(route) {
    if (route.reconnectTimer !== null) {
      clearTimeout(route.reconnectTimer);
      route.reconnectTimer = null;
    }
  }

  function clearConnectTimer(route) {
    if (route.connectTimer !== null) {
      clearTimeout(route.connectTimer);
      route.connectTimer = null;
    }
  }

  function startConnectDeadline(route, socket) {
    clearConnectTimer(route);
    route.connectTimer = setTimeout(() => {
      route.connectTimer = null;
      if (route.socket !== socket || route.connectionState !== "CONNECTING") return;
      emitRouteTelemetry("market_data.binance_connection.route_connect_timeout", route, {
        timeoutMs: routeConnectTimeoutMs,
      });
      closeRoute(route);
      scheduleReconnect(route);
    }, routeConnectTimeoutMs);
    route.connectTimer.unref?.();
  }

  function clearReconnectStabilityTimer(route) {
    if (route.reconnectStabilityTimer !== null) {
      clearTimeout(route.reconnectStabilityTimer);
      route.reconnectStabilityTimer = null;
    }
  }

  function startReconnectStabilityTimer(route, socket, generationAtOpen) {
    clearReconnectStabilityTimer(route);
    if (route.reconnectAttempt === 0) return;
    route.reconnectStabilityTimer = setTimeout(() => {
      route.reconnectStabilityTimer = null;
      if (
        route.socket !== socket ||
        route.connectionState !== "CONNECTED" ||
        generationAtOpen !== sessionGeneration
      ) {
        return;
      }
      route.reconnectAttempt = 0;
      emitRouteTelemetry("market_data.binance_connection.route_reconnect_succeeded", route, {
        stableForMs: reconnectStabilityMs,
      });
    }, reconnectStabilityMs);
    route.reconnectStabilityTimer.unref?.();
  }

  function startRouteWatchdog(route) {
    clearRouteWatchdog(route);
    route.watchdogTimer = setInterval(() => {
      if (route.connectionState !== "CONNECTED" || route.socket === null) return;
      if (!routeHasSubscriptions(route)) {
        route.lastMessageAtMs = Date.now();
        return;
      }
      if (route.lastMessageAtMs === null || Date.now() - route.lastMessageAtMs <= routeSilenceTimeoutMs) return;
      const silenceMs = Date.now() - route.lastMessageAtMs;
      if (route.rawIngressPaused || pendingRawFrames(route) > 0) {
        scheduleRawFrameDrain(route);
        emitRouteTelemetry("market_data.binance_connection.route_silence_recovery_deferred", route, {
          silenceMs,
          reason: "RAW_INGRESS_PENDING",
        });
        return;
      }
      let recoveryAllowed = false;
      try {
        recoveryAllowed = routeSilenceRecoveryAllowed(Object.freeze({
          marketKind: route.marketKind,
          route: route.routeName,
          silenceMs,
        })) === true;
      } catch {
        recoveryAllowed = false;
      }
      if (!recoveryAllowed) {
        emitRouteTelemetry("market_data.binance_connection.route_silence_recovery_deferred", route, { silenceMs });
        return;
      }
      emitRouteTelemetry("market_data.binance_connection.route_silence_timeout", route, {
        silenceMs,
      });
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: "Binance WebSocket route stopped delivering data.",
      });
      closeRoute(route);
      scheduleReconnect(route);
    }, routeWatchdogIntervalMs);
    route.watchdogTimer.unref?.();
  }

  function backpressureEpochKey(marketKind, symbol, eventType, interval) {
    return JSON.stringify([marketKind, symbol, eventType, interval ?? null]);
  }

  function bumpBackpressureEpoch(marketKind, symbol, eventType, interval) {
    const key = backpressureEpochKey(marketKind, symbol, eventType, interval);
    backpressureEpochs.set(key, (backpressureEpochs.get(key) ?? 0) + 1);
  }

  function getBackpressureEpoch(marketKind, symbol, eventType, interval) {
    return backpressureEpochs.get(backpressureEpochKey(marketKind, symbol, eventType, interval)) ?? 0;
  }

  function scheduleReconnect(route) {
    if (!acceptingMessages || route.reconnectTimer !== null) return;
    const generationAtSchedule = sessionGeneration;
    const attempt = route.reconnectAttempt;
    route.reconnectAttempt += 1;
    const rawDelayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    const jitterMs = rawDelayMs * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(rawDelayMs + jitterMs));
    emitRouteTelemetry("market_data.binance_connection.route_reconnect_scheduled", route, {
      attempt: attempt + 1,
      delayMs,
    });
    route.reconnectTimer = setTimeout(() => {
      route.reconnectTimer = null;
      if (generationAtSchedule !== sessionGeneration) {
        return;
      }
      openRoute(route);
    }, delayMs);
    route.reconnectTimer.unref?.();
  }

  async function resubscribeRoute(route) {
    const context = marketKindContexts[route.marketKind];
    const entries = context.subscriptionRegistry
      .list()
      .filter((entry) => ROUTE_FOR_EVENT_TYPE[route.marketKind][entry.eventType] === route.routeName);

    if (entries.length === 0) {
      return;
    }

    const descriptors = entries.map((entry) =>
      Object.freeze({
        symbol: entry.symbol,
        marketKind: route.marketKind,
        eventType: entry.eventType,
        ...(entry.interval !== undefined ? { interval: entry.interval } : {}),
      }),
    );

    sendControlMessage(route, "SUBSCRIBE", descriptors);

    for (const descriptor of descriptors) {
      feedHealth.beginRecovery(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
      if (descriptor.eventType === EVENT_TYPES.DEPTH) {
        assemblerFor(descriptor.marketKind, descriptor.symbol);
        requestDepthSnapshot(descriptor);
      }
    }

    emitRouteTelemetry("market_data.binance_connection.route_resubscribed", route, {
      count: descriptors.length,
    });
  }

  function collectActiveDepthDescriptors() {
    const descriptors = [];
    for (const marketKind of Object.values(MARKET_KINDS)) {
      const context = marketKindContexts[marketKind];
      for (const entry of context.subscriptionRegistry.list()) {
        if (entry.eventType !== EVENT_TYPES.DEPTH) continue;
        descriptors.push(Object.freeze({ marketKind, symbol: entry.symbol, eventType: EVENT_TYPES.DEPTH }));
      }
    }
    return descriptors;
  }

  function runPeriodicDepthSnapshotRefresh() {
    if (!acceptingMessages) return;
    for (const descriptor of collectActiveDepthDescriptors()) {
      const assembler = bookAssemblers.get(`${descriptor.marketKind}:${descriptor.symbol}`);
      if (!assembler) continue;
      if (assembler.getStatus().status === "READY") {
        requestShadowDepthSnapshot(descriptor, { triggerReason: "PERIODIC_REFRESH" });
      } else {
        requestDepthSnapshot(descriptor);
      }
    }
  }

  function startDepthSnapshotRefreshTimer() {
    if (depthSnapshotRefreshTimer) {
      clearInterval(depthSnapshotRefreshTimer);
    }
    depthSnapshotRefreshTimer = setInterval(runPeriodicDepthSnapshotRefresh, depthSnapshotRefreshIntervalMs);
    depthSnapshotRefreshTimer.unref?.();
  }

  function connect() {
    acceptingMessages = true;
    startDepthSnapshotRefreshTimer();
    for (const route of routes.values()) {
      openRoute(route);
    }
  }

  function disconnect() {
    acceptingMessages = false;
    sessionGeneration += 1;
    if (depthSnapshotRefreshTimer) {
      clearInterval(depthSnapshotRefreshTimer);
      depthSnapshotRefreshTimer = null;
    }
    for (const route of routes.values()) {
      clearReconnectTimer(route);
      closeRoute(route);
      route.reconnectAttempt = 0;
      clearRawFrames(route);
    }
    bookAssemblers.clear();
    depthSnapshots.clear();
    depthRequestEpoch.clear();
    depthRetryAttempt.clear();
    depthShadowRefreshes.clear();
    depthShadowRefreshNotBefore.clear();
    clearAllDepthRetryTimers();
    depthGapRecoveryPending.clear();
    backpressureQueues.SPOT.clearAll();
    backpressureQueues.PERPETUAL.clearAll();
  }

  function getStatus() {
    const status = {};
    for (const route of routes.values()) {
      status[route.marketKind] = status[route.marketKind] || {};
      status[route.marketKind][route.routeName] = route.connectionState;
    }
    return Object.freeze({
      SPOT: Object.freeze(status.SPOT || {}),
      PERPETUAL: Object.freeze(status.PERPETUAL || {}),
    });
  }

  function sendControlMessage(route, method, descriptors) {
    if (!route.socket || route.connectionState !== "CONNECTED") {
      throw new Error(
        `Cannot ${method === "SUBSCRIBE" ? "subscribe" : "unsubscribe"} before the Binance ${route.marketKind} ${route.routeName} route is connected.`,
      );
    }
    if (route.pendingControlMessages.size >= MAX_PENDING_CONTROL_MESSAGES) {
      throw new Error(`Too many unacknowledged Binance control messages on the ${route.marketKind} ${route.routeName} route.`);
    }
    const id = route.nextControlMessageId;
    route.nextControlMessageId += 1;
    const timer = setTimeout(() => {
      if (!route.pendingControlMessages.delete(id)) {
        return;
      }
      emitRouteTelemetry("market_data.binance_connection.control_message_timeout", route, { method });
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: "Binance did not acknowledge a control message before the deadline.",
      });
      closeRoute(route);
      scheduleReconnect(route);
    }, CONTROL_ACK_TIMEOUT_MS);
    timer.unref?.();
    route.pendingControlMessages.set(id, timer);
    try {
      route.socket.send(JSON.stringify({
        method,
        params: descriptors.map((descriptor) => wireStreamName(descriptor.symbol, descriptor.eventType, descriptor.interval)),
        id,
      }));
    } catch (error) {
      clearTimeout(timer);
      route.pendingControlMessages.delete(id);
      throw error;
    }
  }

  function clearPendingControlMessages(route) {
    for (const timer of route.pendingControlMessages.values()) {
      clearTimeout(timer);
    }
    route.pendingControlMessages.clear();
  }

  function recoverFromControlSendFailure(route, method) {
    emitRouteTelemetry("market_data.binance_connection.control_message_send_failed", route, { method });
    if (route.connectionState === "CONNECTED") {
      closeRoute(route);
      scheduleReconnect(route);
    }
  }

  function initializeNewSubscription(descriptor) {
    feedHealth.beginRecovery(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
    if (descriptor.eventType === EVENT_TYPES.DEPTH) {
      assemblerFor(descriptor.marketKind, descriptor.symbol);
      requestDepthSnapshot(descriptor);
    } else {
      bumpBackpressureEpoch(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
    }
  }

  function subscribeMany(requests, consumerId) {
    assertConsumerId(consumerId);
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("subscribeMany() requires a non-empty array of subscription requests.");
    }
    const descriptors = requests.map((request) => describeBinanceSubscription(request));
    const added = [];
    const grouped = new Map();
    for (const descriptor of descriptors) {
      const context = marketKindContexts[descriptor.marketKind];
      const isNewOnWire = context.subscriptionRegistry.add(
        descriptor.symbol,
        descriptor.eventType,
        consumerId,
        undefined,
        descriptor.interval,
      );
      if (!isNewOnWire) continue;
      added.push(descriptor);
      const route = routeFor(descriptor.marketKind, descriptor.eventType);
      const group = grouped.get(route) ?? [];
      group.push(descriptor);
      grouped.set(route, group);
    }

    for (const route of grouped.keys()) {
      if (!route.socket || route.connectionState !== "CONNECTED") {
        for (const descriptor of added) {
          marketKindContexts[descriptor.marketKind].subscriptionRegistry.remove(
            descriptor.symbol,
            descriptor.eventType,
            consumerId,
            descriptor.interval,
          );
        }
        throw new Error(`Cannot subscribe before the Binance ${route.marketKind} ${route.routeName} route is connected.`);
      }
    }

    const routesSent = [];
    let routeBeingSent = null;
    try {
      for (const [route, routeDescriptors] of grouped) {
        routeBeingSent = route;
        sendControlMessage(route, "SUBSCRIBE", routeDescriptors);
        routesSent.push(route);
      }
    } catch (error) {
      for (const descriptor of added) {
        marketKindContexts[descriptor.marketKind].subscriptionRegistry.remove(
          descriptor.symbol,
          descriptor.eventType,
          consumerId,
          descriptor.interval,
        );
      }
      for (const route of new Set([...routesSent, routeBeingSent].filter(Boolean))) {
        recoverFromControlSendFailure(route, "SUBSCRIBE");
      }
      throw error;
    }

    for (const descriptor of added) initializeNewSubscription(descriptor);
    return added.length;
  }

  function subscribe(request, consumerId) {
    return subscribeMany([request], consumerId) === 1;
  }

  function unsubscribe(request, consumerId) {
    return unsubscribeMany([request], consumerId) === 1;
  }

  function unsubscribeMany(requests, consumerId) {
    assertConsumerId(consumerId);
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("unsubscribeMany() requires a non-empty array of subscription requests.");
    }
    const descriptors = requests.map((request) => describeBinanceSubscription(request));
    const released = [];
    const grouped = new Map();

    for (const descriptor of descriptors) {
      const context = marketKindContexts[descriptor.marketKind];
      const lastHolderReleased = context.subscriptionRegistry.remove(
        descriptor.symbol,
        descriptor.eventType,
        consumerId,
        descriptor.interval,
      );
      if (!lastHolderReleased) continue;
      released.push(descriptor);
      const route = routeFor(descriptor.marketKind, descriptor.eventType);
      const group = grouped.get(route) ?? [];
      group.push(descriptor);
      grouped.set(route, group);
    }

    for (const [route, routeDescriptors] of grouped) {
      try {
        if (route.socket && route.connectionState === "CONNECTED") {
          sendControlMessage(route, "UNSUBSCRIBE", routeDescriptors);
        }
      } catch {
        recoverFromControlSendFailure(route, "UNSUBSCRIBE");
      }
    }
    for (const descriptor of released) {
      teardownLastHolder(descriptor);
    }
    return released.length;
  }

  function recoverStaleSubscription(request, { automatic = false } = {}) {
    if (typeof automatic !== "boolean") {
      throw new Error("recoverStaleSubscription(): automatic must be a boolean when provided.");
    }
    const descriptor = describeBinanceSubscription(request);
    const context = marketKindContexts[descriptor.marketKind];
    const active = context.subscriptionRegistry.list().some(
      (entry) =>
        entry.symbol === descriptor.symbol &&
        entry.eventType === descriptor.eventType &&
        (entry.interval ?? null) === (descriptor.interval ?? null),
    );
    const route = routeFor(descriptor.marketKind, descriptor.eventType);
    if (!active || route.connectionState !== "CONNECTED") return false;
    if (automatic && Date.now() < route.nextAutomaticStaleRecoveryAtMs) return false;
    if (pendingRawFrames(route) > 0) {
      scheduleRawFrameDrain(route);
      return false;
    }
    if (!automatic && descriptor.eventType !== EVENT_TYPES.DEPTH) {
      const queue = backpressureQueues[descriptor.marketKind];
      if (queue.size(descriptor.symbol, descriptor.eventType, descriptor.interval) > 0) {
        scheduleBackpressureDrain(descriptor.marketKind);
        return false;
      }
    }
    if (automatic) {
      route.nextAutomaticStaleRecoveryAtMs = Date.now() + automaticStaleRecoveryRouteCooldownMs;
    }
    emitRouteTelemetry("market_data.binance_connection.stale_subscription_recovery_started", route, {
      eventType: descriptor.eventType,
      symbol: safeTelemetrySymbol(descriptor.symbol),
      scope: automatic ? "route" : "subscription",
    });
    feedHealth.beginRecovery(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
    if (automatic) {
      closeRoute(route);
      scheduleReconnect(route);
      return true;
    }
    try {
      sendControlMessage(route, "UNSUBSCRIBE", [descriptor]);
      sendControlMessage(route, "SUBSCRIBE", [descriptor]);
    } catch {
      closeRoute(route);
      scheduleReconnect(route);
      return true;
    }
    if (descriptor.eventType === EVENT_TYPES.DEPTH) {
      const key = `${descriptor.marketKind}:${descriptor.symbol}`;
      bookAssemblers.delete(key);
      depthSnapshots.delete(key);
      depthShadowRefreshes.delete(key);
      depthShadowRefreshNotBefore.delete(key);
      depthRequestEpoch.set(key, (depthRequestEpoch.get(key) ?? 0) + 1);
      depthRetryAttempt.delete(key);
      clearDepthRetryTimer(key);
      assemblerFor(descriptor.marketKind, descriptor.symbol);
      requestDepthSnapshot(descriptor);
    } else {
      bumpBackpressureEpoch(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
    }
    return true;
  }

  function teardownLastHolder(descriptor) {
    if (descriptor.eventType === EVENT_TYPES.DEPTH) {
      const key = `${descriptor.marketKind}:${descriptor.symbol}`;
      bookAssemblers.delete(key);
      depthSnapshots.delete(key);
      depthShadowRefreshes.delete(key);
      depthShadowRefreshNotBefore.delete(key);
      depthRequestEpoch.delete(key);
      depthRetryAttempt.delete(key);
      clearDepthRetryTimer(key);
      depthGapRecoveryPending.delete(key);
      return;
    }
    bumpBackpressureEpoch(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
    backpressureQueues[descriptor.marketKind].clear(descriptor.symbol, descriptor.eventType, descriptor.interval);
  }

  function sendUnsubscribeIfConnected(descriptor) {
    const route = routeFor(descriptor.marketKind, descriptor.eventType);
    try {
      if (route.socket && route.connectionState === "CONNECTED") {
        sendControlMessage(route, "UNSUBSCRIBE", [descriptor]);
      }
    } catch {
      recoverFromControlSendFailure(route, "UNSUBSCRIBE");
    }
    teardownLastHolder(descriptor);
  }

  function removeConsumer(consumerId) {
    assertConsumerId(consumerId);
    const released = [];
    for (const marketKind of Object.values(MARKET_KINDS)) {
      const context = marketKindContexts[marketKind];
      const tuples = context.subscriptionRegistry.removeConsumer(consumerId);
      for (const tuple of tuples) {
        const descriptor = Object.freeze({
          symbol: tuple.symbol,
          marketKind,
          eventType: tuple.eventType,
          ...(tuple.interval !== undefined ? { interval: tuple.interval } : {}),
        });
        sendUnsubscribeIfConnected(descriptor);
        released.push(descriptor);
      }
    }
    return released;
  }

  function handleRawMessage(route, data, receivedAtMs = Date.now()) {
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_WS_MESSAGE_BYTES) {
      emitRouteTelemetry("market_data.binance_connection.message_rejected", route, {
        reason: "OVERSIZED_OR_NON_TEXT_FRAME",
      });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      emitRouteTelemetry("market_data.binance_connection.message_rejected", route, {
        reason: "MALFORMED_JSON",
      });
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      emitRouteTelemetry("market_data.binance_connection.message_rejected", route, {
        reason: "UNEXPECTED_SHAPE",
      });
      return;
    }

    const nestedErrorCode =
      parsed.error !== null &&
      typeof parsed.error === "object" &&
      !Array.isArray(parsed.error) &&
      typeof parsed.error.code !== "undefined"
        ? parsed.error.code
        : undefined;
    const hasControlResponseShape =
      typeof parsed.stream !== "string" &&
      (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "code") || Object.hasOwn(parsed, "error"));
    const controlTimer = hasControlResponseShape ? route.pendingControlMessages.get(parsed.id) : undefined;
    const isPendingControlResponse = controlTimer !== undefined;
    if (isPendingControlResponse) {
      clearTimeout(controlTimer);
      route.pendingControlMessages.delete(parsed.id);
    }
    const controlErrorCode = nestedErrorCode ?? parsed.code;
    if (isPendingControlResponse && controlErrorCode !== undefined) {
      const safeErrorCode = safeTelemetryErrorCode(controlErrorCode);
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: "Binance rejected a control message.",
        code: safeErrorCode,
      });
      emitRouteTelemetry("market_data.binance_connection.control_message_rejected", route, {
        code: safeErrorCode,
      });
      closeRoute(route);
      scheduleReconnect(route);
      return;
    }
    if (isPendingControlResponse) {
      const keys = Object.keys(parsed);
      const isExactSuccess =
        parsed.result === null &&
        keys.length === 2 &&
        keys.includes("id") &&
        keys.includes("result");
      if (!isExactSuccess) {
        notifyErrorListeners({
          marketKind: route.marketKind,
          route: route.routeName,
          message: "Binance returned a malformed control acknowledgement.",
          code: "INVALID_CONTROL_ACK",
        });
        emitRouteTelemetry("market_data.binance_connection.control_message_invalid_ack", route);
        closeRoute(route);
        scheduleReconnect(route);
        return;
      }
    }

    if (typeof parsed.stream !== "string") {
      return;
    }

    if (parsed.stream === "!serverShutdown") {
      emitRouteTelemetry("market_data.binance_connection.provider_server_shutdown", route);
      closeRoute(route);
      scheduleReconnect(route);
      return;
    }

    const resolved = parseWireStreamName(parsed.stream);
    if (!resolved) {
      emitRouteTelemetry("market_data.binance_connection.message_rejected", route, {
        reason: "UNRECOGNIZED_STREAM_NAME",
      });
      return;
    }

    if (ROUTE_FOR_EVENT_TYPE[route.marketKind][resolved.eventType] !== route.routeName) {
      emitRouteTelemetry("market_data.binance_connection.message_rejected", route, {
        reason: "STREAM_ON_WRONG_ROUTE",
      });
      return;
    }

    const context = marketKindContexts[route.marketKind];
    const isActiveSubscription = hasActiveSubscription(
      context,
      resolved.symbol,
      resolved.eventType,
      resolved.interval,
    );
    if (!isActiveSubscription) {
      emitRouteTelemetry("market_data.binance_connection.inactive_subscription_frame_ignored", route);
      return;
    }

    const normalized = normalizeBinanceEvent(
      {
        marketKind: route.marketKind,
        symbol: resolved.symbol,
        eventType: resolved.eventType,
        interval: resolved.interval,
        raw: parsed.data,
      },
      { receivedAtMs },
    );

    const completedStaleSubscriptionRecovery =
      normalized.state !== "UNAVAILABLE" &&
      resolved.eventType !== EVENT_TYPES.DEPTH &&
      feedHealth.isRecovering(route.marketKind, resolved.symbol, resolved.eventType, resolved.interval);
    if (normalized.state !== "UNAVAILABLE") {
      feedHealth.recordEvent(route.marketKind, resolved.symbol, resolved.eventType, resolved.interval, receivedAtMs);
    }
    if (completedStaleSubscriptionRecovery) {
      emitRouteTelemetry("market_data.binance_connection.stale_subscription_recovery_succeeded", route, {
        eventType: resolved.eventType,
        symbol: safeTelemetrySymbol(resolved.symbol),
      });
    }

    if (resolved.eventType === EVENT_TYPES.DEPTH) {
      const key = `${route.marketKind}:${resolved.symbol}`;
      const assembler = assemblerFor(route.marketKind, resolved.symbol);
      const statusBefore = assembler.getStatus();
      assembler.applyDeltaEventStatus(normalized);
      const statusAfter = assembler.getStatus();
      const shadowRefresh = depthShadowRefreshes.get(key);
      if (shadowRefresh) {
        shadowRefresh.assembler.applyDeltaEventStatus(normalized);
        completeShadowDepthRefreshIfReady(key, shadowRefresh);
      }
      if (statusAfter.status === "UNAVAILABLE" && statusBefore.status !== "UNAVAILABLE") {
        depthShadowRefreshes.delete(key);
        depthGapRecoveryPending.add(key);
        feedHealth.beginRecovery(route.marketKind, resolved.symbol, EVENT_TYPES.DEPTH);
        emitRouteTelemetry("market_data.binance_connection.depth_gap_recovery_attempt", route, {
          symbol: safeTelemetrySymbol(resolved.symbol),
          reason: statusAfter.reason,
        });
        requestDepthSnapshot({
          marketKind: route.marketKind,
          symbol: resolved.symbol,
          eventType: EVENT_TYPES.DEPTH,
        });
      }
      if (statusAfter.status === "READY" && statusBefore.status !== "READY") {
        const wasRecovering = feedHealth.isRecovering(route.marketKind, resolved.symbol, EVENT_TYPES.DEPTH);
        const completedGapRecovery = depthGapRecoveryPending.delete(`${route.marketKind}:${resolved.symbol}`);
        feedHealth.endRecovery(route.marketKind, resolved.symbol, EVENT_TYPES.DEPTH);
        if (wasRecovering && completedGapRecovery) {
          emitTelemetry(telemetry, "market_data.binance_connection.depth_gap_recovery_succeeded", {
            marketKind: safeTelemetryMarketKind(route.marketKind),
            symbol: safeTelemetrySymbol(resolved.symbol),
          });
        }
      }
      if (
        statusAfter.status === "READY" &&
        assembler.shouldRefreshSnapshot() &&
        !depthShadowRefreshes.has(key)
      ) {
        requestShadowDepthSnapshot({
          marketKind: route.marketKind,
          symbol: resolved.symbol,
          eventType: EVENT_TYPES.DEPTH,
        }, { triggerReason: "LEVEL_CAP_APPROACH", initialEvent: normalized });
      }
      notifyMessageListeners(
        patchEnvelopeHealthContext(route.marketKind, resolved.symbol, resolved.eventType, resolved.interval, Date.now(), normalized),
      );
      return;
    }

    try {
      backpressureQueues[route.marketKind].enqueue(
        resolved.symbol,
        resolved.eventType,
        {
          envelope: normalized,
          epoch: getBackpressureEpoch(route.marketKind, resolved.symbol, resolved.eventType, resolved.interval),
        },
        resolved.interval,
      );
    } catch (error) {
      if (!(error instanceof BinanceBackpressureOverflowError)) throw error;
      const fatalOverflow = backpressureOverflowPolicy === OVERFLOW_POLICIES.FAIL;
      notifyErrorListeners({
        marketKind: route.marketKind,
        route: route.routeName,
        message: error.message,
        code: error.code,
        fatal: fatalOverflow,
      });
      closeRoute(route);
      if (!fatalOverflow) scheduleReconnect(route);
      return;
    }
    scheduleBackpressureDrain(route.marketKind);
  }

  function patchEnvelopeHealthContext(marketKind, symbol, eventType, interval, nowMs, envelope) {
    const context = feedHealth.computeContext({
      marketKind,
      symbol,
      eventType,
      interval,
      routeConnected: feedHealth.isRouteConnected(marketKind, ROUTE_FOR_EVENT_TYPE[marketKind]?.[eventType]),
      nowMs,
      ...(eventType === EVENT_TYPES.DEPTH ? { recoveryStaleMs: DEPTH_RECOVERY_STALE_MS } : {}),
    });
    return Object.freeze({
      ...envelope,
      stale: context.stale,
      recoveryState: context.recoveryState,
    });
  }

  function drainBackpressureQueueOnce(marketKind) {
    const context = marketKindContexts[marketKind];
    const queue = backpressureQueues[marketKind];
    const drainSessionGeneration = sessionGeneration;
    const queuedEntries = context.subscriptionRegistry
      .list()
      .filter(
        (entry) =>
          entry.eventType !== EVENT_TYPES.DEPTH &&
          queue.size(entry.symbol, entry.eventType, entry.interval) > 0,
      );
    const startIndex = queuedEntries.length === 0 ? 0 : backpressureDrainCursor[marketKind] % queuedEntries.length;
    const entries = queuedEntries.length === 0
      ? queuedEntries
      : [...queuedEntries.slice(startIndex), ...queuedEntries.slice(0, startIndex)];
    backpressureDrainCursor[marketKind] = queuedEntries.length === 0 ? 0 : (startIndex + 1) % queuedEntries.length;
    let remainingBudget = backpressureDrainBatchSize;
    let remainingEntries = entries.length;
    let moreWorkRemains = false;
    let processedItems = 0;
    const startedAt = backpressureNow();
    let timeBudgetExhausted = false;
    for (const entry of entries) {
      const fairShare = remainingEntries > 0 ? Math.max(1, Math.ceil(remainingBudget / remainingEntries)) : 0;
      remainingEntries -= 1;
      if (remainingBudget > 0 && fairShare > 0) {
        const entryBudget = Math.min(fairShare, remainingBudget);
        for (let index = 0; index < entryBudget; index += 1) {
          if (processedItems > 0 && processedItems % 8 === 0 && backpressureNow() - startedAt >= backpressureDrainMaxMs) {
            timeBudgetExhausted = true;
            backpressureDrainTimeYields += 1;
            moreWorkRemains = true;
            break;
          }
          if (sessionGeneration !== drainSessionGeneration) {
            break;
          }
          const stillActive = hasActiveSubscription(
            context,
            entry.symbol,
            entry.eventType,
            entry.interval,
          );
          if (!stillActive) {
            break;
          }
          const item = queue.drainOne(entry.symbol, entry.eventType, entry.interval);
          if (item === null) break;
          remainingBudget -= 1;
          processedItems += 1;
          if (
            item.epoch !==
            getBackpressureEpoch(marketKind, entry.symbol, entry.eventType, entry.interval)
          ) {
            break;
          }
          notifyMessageListeners(
            patchEnvelopeHealthContext(marketKind, entry.symbol, entry.eventType, entry.interval, Date.now(), item.envelope),
          );
        }
      }
      if (queue.size(entry.symbol, entry.eventType, entry.interval) > 0) {
        moreWorkRemains = true;
      }
      if (timeBudgetExhausted) break;
    }
    backpressureDrainSteps += 1;
    backpressureDrained += processedItems;
    backpressureDrainMs += backpressureNow() - startedAt;
    if (moreWorkRemains) {
      scheduleBackpressureDrain(marketKind);
    }
  }

  function scheduleBackpressureDrain(marketKind) {
    if (backpressureDrainScheduled[marketKind]) {
      return;
    }
    backpressureDrainScheduled[marketKind] = true;
    setImmediate(() => {
      backpressureDrainScheduled[marketKind] = false;
      drainBackpressureQueueOnce(marketKind);
    }).unref?.();
  }

  function assemblerFor(marketKind, symbol) {
    const key = `${marketKind}:${symbol}`;
    let assembler = bookAssemblers.get(key);
    if (!assembler) {
      assembler = createBinanceBookAssembler({ marketKind });
      bookAssemblers.set(key, assembler);
    }
    return assembler;
  }

  function completeShadowDepthRefreshIfReady(key, refresh) {
    if (
      depthShadowRefreshes.get(key) !== refresh ||
      refresh.snapshotApplied !== true ||
      refresh.assembler.getStatus().status !== "READY" ||
      bookAssemblers.get(key) !== refresh.activeAssembler
    ) {
      return false;
    }
    bookAssemblers.set(key, refresh.assembler);
    depthShadowRefreshes.delete(key);
    depthShadowRefreshNotBefore.delete(key);
    depthRetryAttempt.delete(key);
    clearDepthRetryTimer(key);
    emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_refresh_succeeded", {
      marketKind: safeTelemetryMarketKind(refresh.descriptor.marketKind),
      symbol: safeTelemetrySymbol(refresh.descriptor.symbol),
      triggerReason: refresh.triggerReason,
    });
    return true;
  }

  async function requestShadowDepthSnapshot(descriptor, {
    triggerReason,
    initialEvent = null,
  }) {
    const key = `${descriptor.marketKind}:${descriptor.symbol}`;
    if (
      depthShadowRefreshes.has(key) ||
      Date.now() < (depthShadowRefreshNotBefore.get(key) ?? 0)
    ) return;
    const activeAssembler = bookAssemblers.get(key);
    if (!activeAssembler || activeAssembler.getStatus().status !== "READY") return;
    const generationAtRequest = sessionGeneration;
    const epochAtRequest = (depthRequestEpoch.get(key) ?? 0) + 1;
    depthRequestEpoch.set(key, epochAtRequest);
    const refresh = {
      descriptor,
      triggerReason,
      activeAssembler,
      assembler: createBinanceBookAssembler({ marketKind: descriptor.marketKind }),
      snapshotApplied: false,
      epochAtRequest,
    };
    if (initialEvent !== null) refresh.assembler.applyDeltaEventStatus(initialEvent);
    depthShadowRefreshes.set(key, refresh);
    emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_refresh_started", {
      marketKind: safeTelemetryMarketKind(descriptor.marketKind),
      symbol: safeTelemetrySymbol(descriptor.symbol),
      triggerReason,
    });

    let result;
    try {
      result = await fetchDepthSnapshot(descriptor.marketKind, descriptor.symbol, {
        fetchImpl,
        baseUrl: restBaseUrlFor(descriptor.marketKind, resolvedEndpoints),
      });
    } catch {
      result = Object.freeze({ ok: false, reason: "NETWORK_ERROR" });
    }
    if (
      !acceptingMessages || generationAtRequest !== sessionGeneration ||
      depthShadowRefreshes.get(key) !== refresh ||
      bookAssemblers.get(key) !== activeAssembler ||
      depthRequestEpoch.get(key) !== epochAtRequest
    ) return;

    depthSnapshots.set(key, result);
    if (result.ok) {
      refresh.snapshotApplied = true;
      const state = refresh.assembler.applySnapshotStatus(result.value.body);
      if (state.status !== "UNAVAILABLE" && completeShadowDepthRefreshIfReady(key, refresh)) return;
      if (state.status === "BUFFERING") return;
    }
    depthShadowRefreshes.delete(key);
    depthShadowRefreshNotBefore.set(key, Date.now() + DEPTH_SHADOW_REFRESH_RETRY_COOLDOWN_MS);
    emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_refresh_failed", {
      severity: activeAssembler.getStatus().status === "READY" ? "warn" : "error",
      activeBookRetained: activeAssembler.getStatus().status === "READY",
      retryAfterMs: DEPTH_SHADOW_REFRESH_RETRY_COOLDOWN_MS,
      marketKind: safeTelemetryMarketKind(descriptor.marketKind),
      symbol: safeTelemetrySymbol(descriptor.symbol),
      triggerReason,
      reason: result.ok ? refresh.assembler.getStatus().reason : result.reason,
    });
  }

  async function requestDepthSnapshot(descriptor) {
    const generationAtRequest = sessionGeneration;
    const key = `${descriptor.marketKind}:${descriptor.symbol}`;
    const assemblerAtRequest = bookAssemblers.get(key);
    const epochAtRequest = (depthRequestEpoch.get(key) ?? 0) + 1;
    depthRequestEpoch.set(key, epochAtRequest);

    let result;
    try {
      result = await fetchDepthSnapshot(descriptor.marketKind, descriptor.symbol, {
        fetchImpl,
        baseUrl: restBaseUrlFor(descriptor.marketKind, resolvedEndpoints),
      });
    } catch (error) {
      result = Object.freeze({ ok: false, reason: "NETWORK_ERROR" });
      emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_exception", {
        marketKind: safeTelemetryMarketKind(descriptor.marketKind),
        symbol: safeTelemetrySymbol(descriptor.symbol),
        reason: error instanceof Error ? error.name : "UNKNOWN",
      });
    }

    if (
      !acceptingMessages ||
      !assemblerAtRequest ||
      generationAtRequest !== sessionGeneration ||
      bookAssemblers.get(key) !== assemblerAtRequest ||
      depthRequestEpoch.get(key) !== epochAtRequest
    ) {
      return;
    }

    depthSnapshots.set(key, result);
    if (result.ok) {
      const wasRecovering = feedHealth.isRecovering(descriptor.marketKind, descriptor.symbol, EVENT_TYPES.DEPTH);
      const state = assemblerAtRequest.applySnapshotStatus(result.value.body);
      if (state.status === "READY") {
        feedHealth.recordEvent(descriptor.marketKind, descriptor.symbol, EVENT_TYPES.DEPTH, undefined, Date.now());
        const completedGapRecovery = depthGapRecoveryPending.delete(key);
        feedHealth.endRecovery(descriptor.marketKind, descriptor.symbol, EVENT_TYPES.DEPTH);
        if (wasRecovering && completedGapRecovery) {
          emitTelemetry(telemetry, "market_data.binance_connection.depth_gap_recovery_succeeded", {
            marketKind: safeTelemetryMarketKind(descriptor.marketKind),
            symbol: safeTelemetrySymbol(descriptor.symbol),
          });
        }
        depthRetryAttempt.delete(key);
        clearDepthRetryTimer(key);
      } else if (state.status === "UNAVAILABLE") {
        scheduleDepthSnapshotRetry(descriptor);
      } else {
        depthRetryAttempt.delete(key);
        clearDepthRetryTimer(key);
      }
    } else {
      scheduleDepthSnapshotRetry(descriptor, { retryAfterMs: result.retryAfterMs });
    }
    emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_fetched", {
      marketKind: safeTelemetryMarketKind(descriptor.marketKind),
      symbol: safeTelemetrySymbol(descriptor.symbol),
      ok: result.ok,
    });
  }

  function scheduleDepthSnapshotRetry(descriptor, { retryAfterMs } = {}) {
    const key = `${descriptor.marketKind}:${descriptor.symbol}`;
    clearDepthRetryTimer(key);
    const generationAtSchedule = sessionGeneration;
    const attempt = depthRetryAttempt.get(key) ?? 0;
    const attemptAtSchedule = attempt + 1;
    depthRetryAttempt.set(key, attemptAtSchedule);

    const rawDelayMs = Math.min(DEPTH_RETRY_BASE_DELAY_MS * 2 ** attempt, DEPTH_RETRY_MAX_DELAY_MS);
    const jitterMs = rawDelayMs * DEPTH_RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
    const backoffDelayMs = Math.max(0, Math.round(rawDelayMs + jitterMs));
    const honorsRetryAfter = Number.isSafeInteger(retryAfterMs) && retryAfterMs > backoffDelayMs;
    const delayMs = honorsRetryAfter ? retryAfterMs : backoffDelayMs;

    emitTelemetry(telemetry, "market_data.binance_connection.depth_snapshot_retry_scheduled", {
      marketKind: safeTelemetryMarketKind(descriptor.marketKind),
      symbol: safeTelemetrySymbol(descriptor.symbol),
      attempt: attemptAtSchedule,
      delayMs,
      honoredRetryAfter: honorsRetryAfter,
    });

    const timer = setTimeout(() => {
      if (depthRetryTimers.get(key) === timer) depthRetryTimers.delete(key);
      if (
        !acceptingMessages ||
        generationAtSchedule !== sessionGeneration ||
        !bookAssemblers.has(key) ||
        depthRetryAttempt.get(key) !== attemptAtSchedule
      ) {
        return;
      }
      requestDepthSnapshot(descriptor);
    }, delayMs);
    timer.unref?.();
    depthRetryTimers.set(key, timer);
  }

  function getDepthSnapshot(marketKind, symbol) {
    return depthSnapshots.get(`${marketKind}:${symbol}`);
  }

  function fetchRecentKlines(marketKind, symbol, options) {
    return klineBackfill.fetchRecentBars(marketKind, symbol, options);
  }

  /** The route and recovery gates every book reader goes through, whatever the assembler said. */
  function gateBookState(marketKind, symbol, state) {
    if (!state) {
      return state;
    }
    const routeName = ROUTE_FOR_EVENT_TYPE[marketKind]?.[EVENT_TYPES.DEPTH];
    if (!feedHealth.isRouteConnected(marketKind, routeName)) {
      return Object.freeze({ status: "UNAVAILABLE", reason: "CONNECTION_DOWN" });
    }
    const health = feedHealth.computeContext({
      marketKind,
      symbol,
      eventType: EVENT_TYPES.DEPTH,
      routeConnected: true,
      recoveryStaleMs: DEPTH_RECOVERY_STALE_MS,
    });
    if (state.status === "READY" && health.recoveryState === "RECOVERING") {
      return Object.freeze({ status: "UNAVAILABLE", reason: "RECOVERY_IN_PROGRESS" });
    }
    if (state.status === "READY" && health.recoveryState === "UNAVAILABLE") {
      return Object.freeze({ status: "UNAVAILABLE", reason: "RECOVERY_IN_PROGRESS" });
    }
    if (state.status === "BUFFERING") {
      return Object.freeze({ status: "UNAVAILABLE", reason: "BUFFERING" });
    }
    return state;
  }

  function getOrderBook(marketKind, symbol) {
    return gateBookState(marketKind, symbol, bookAssemblers.get(`${marketKind}:${symbol}`)?.getState());
  }

  /**
   * The book's status and best prices without its sorted sides: for a pair
   * kept live but not shown, where building the whole sorted book on every
   * depth event costs more than everything else the feed does.
   */
  function getOrderBookStatus(marketKind, symbol) {
    return gateBookState(marketKind, symbol, bookAssemblers.get(`${marketKind}:${symbol}`)?.getStatus());
  }
  function getFeedHealth(marketKind, symbol, eventType, interval) {
    const context = marketKindContexts[marketKind];
    const routeName = ROUTE_FOR_EVENT_TYPE[marketKind]?.[eventType];
    if (!context || !routeName) {
      return undefined;
    }
    const isActiveSubscription = context.subscriptionRegistry
      .list()
      .some(
        (entry) =>
          entry.symbol === symbol &&
          entry.eventType === eventType &&
          (entry.interval ?? null) === (interval ?? null),
      );
    if (!isActiveSubscription) {
      return undefined;
    }
    return feedHealth.computeContext({
      marketKind,
      symbol,
      eventType,
      interval,
      routeConnected: feedHealth.isRouteConnected(marketKind, routeName),
      ...(eventType === EVENT_TYPES.DEPTH ? { recoveryStaleMs: DEPTH_RECOVERY_STALE_MS } : {}),
    });
  }

  function onMessage(listener) {
    if (typeof listener !== "function") {
      throw new Error("Binance message listener must be a function.");
    }
    if (!messageListeners.has(listener) && messageListeners.size >= MAX_LISTENERS) {
      throw new Error(`Cannot register more than ${MAX_LISTENERS} Binance message listeners.`);
    }
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  }

  function onError(listener) {
    if (typeof listener !== "function") {
      throw new Error("Binance error listener must be a function.");
    }
    if (!errorListeners.has(listener) && errorListeners.size >= MAX_LISTENERS) {
      throw new Error(`Cannot register more than ${MAX_LISTENERS} Binance error listeners.`);
    }
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  }

  function getOperationalStats() {
    const spot = backpressureQueues.SPOT.getStats();
    const perpetual = backpressureQueues.PERPETUAL.getStats();
    let rawIngressPending = 0;
    let rawIngressPendingBytes = 0;
    let rawIngressOldestAgeMs = 0;
    let rawIngressPausedRoutes = 0;
    let rawIngressLongestActivePauseMs = 0;
    const sampledAt = rawIngressNow();
    for (const route of routes.values()) {
      rawIngressPending += pendingRawFrames(route);
      rawIngressPendingBytes += route.rawPendingBytes;
      const oldest = route.rawFrames[route.rawFrameHead];
      if (oldest) rawIngressOldestAgeMs = Math.max(rawIngressOldestAgeMs, sampledAt - oldest.acceptedAt);
      if (route.rawIngressPaused) {
        rawIngressPausedRoutes += 1;
        if (route.rawIngressPausedAt !== null) {
          rawIngressLongestActivePauseMs = Math.max(
            rawIngressLongestActivePauseMs,
            sampledAt - route.rawIngressPausedAt,
          );
        }
      }
    }
    return Object.freeze({
      rawIngressPending,
      rawIngressPendingBytes,
      rawIngressOldestAgeMs: Number(Math.max(0, rawIngressOldestAgeMs).toFixed(1)),
      rawIngressAccepted,
      rawIngressProcessed,
      rawIngressOverflows,
      rawIngressHighWaterMark,
      rawIngressHighWaterBytes,
      rawIngressDrainTimeYields,
      rawIngressLastDrainMs: Number(rawIngressLastDrainMs.toFixed(1)),
      rawIngressMaxDrainMs: Number(rawIngressMaxDrainMs.toFixed(1)),
      rawIngressPausedRoutes,
      rawIngressLongestActivePauseMs: Number(Math.max(0, rawIngressLongestActivePauseMs).toFixed(1)),
      rawIngressFlowControlPauses,
      rawIngressFlowControlResumes,
      rawIngressFlowControlFailures,
      rawIngressFlowControlTotalPausedMs: Number(rawIngressFlowControlTotalPausedMs.toFixed(1)),
      rawIngressFlowControlMaxPausedMs: Number(rawIngressFlowControlMaxPausedMs.toFixed(1)),
      backpressurePending: spot.pending + perpetual.pending,
      backpressureHighWaterMark: Math.max(spot.highWaterMark, perpetual.highWaterMark),
      backpressureDropped: spot.dropped + perpetual.dropped,
      backpressureOverflows: spot.overflows + perpetual.overflows,
      backpressureCleared: spot.cleared + perpetual.cleared,
      backpressureDrainTimeYields,
      backpressureDrainSteps,
      backpressureDrained,
      backpressureDrainMs: Number(backpressureDrainMs.toFixed(1)),
      depthSnapshotRetryTimers: depthRetryTimers.size,
      depthShadowRefreshes: depthShadowRefreshes.size,
    });
  }

  function quiesce({ timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("quiesce timeoutMs must be a positive safe integer."));
    }
    acceptingMessages = false;
    if (depthSnapshotRefreshTimer) {
      clearInterval(depthSnapshotRefreshTimer);
      depthSnapshotRefreshTimer = null;
    }
    clearAllDepthRetryTimers();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const inspect = () => {
        const { rawIngressPending, backpressurePending } = getOperationalStats();
        if (rawIngressPending === 0 && backpressurePending === 0) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(
            `Binance connection failed to drain ${rawIngressPending} raw frames and ` +
            `${backpressurePending} normalized events before shutdown.`,
          ));
          return;
        }
        for (const route of routes.values()) scheduleRawFrameDrain(route);
        scheduleBackpressureDrain(MARKET_KINDS.SPOT);
        scheduleBackpressureDrain(MARKET_KINDS.PERPETUAL);
        setTimeout(inspect, 10);
      };
      inspect();
    });
  }

  return Object.freeze({
    connect,
    disconnect,
    getStatus,
    subscribe,
    subscribeMany,
    unsubscribe,
    unsubscribeMany,
    recoverStaleSubscription,
    removeConsumer,
    onMessage,
    onError,
    getDepthSnapshot,
    getOrderBook,
    getOrderBookStatus,
    getFeedHealth,
    getOperationalStats,
    quiesce,
    fetchRecentKlines,
  });
}

module.exports = {
  createBinanceConnection,
  MAX_WS_MESSAGE_BYTES,
  DEFAULT_AUTOMATIC_STALE_RECOVERY_ROUTE_COOLDOWN_MS,
  DEFAULT_RAW_INGRESS_MAX_QUEUE_DEPTH,
  DEFAULT_RAW_INGRESS_MAX_QUEUE_BYTES,
  DEFAULT_RAW_INGRESS_DRAIN_BATCH_SIZE,
  DEFAULT_RAW_INGRESS_DRAIN_MAX_MS,
};
