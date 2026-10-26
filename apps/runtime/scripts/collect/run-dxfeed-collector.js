#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("dxfeed-collector", { isMain: require.main === module });

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { loadDxFeedConfig } = require("../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../src/providers/dxfeed/dxlink-connection");
const { redactSecrets } = require("../../src/providers/dxfeed/redact");
const { normalizeDxFeedEvent } = require("../../src/providers/dxfeed/dxfeed-event-normalizer");
const { createDxFeedOrderV2Capture } = require("../../src/providers/dxfeed/dxfeed-order-v2-capture");
const {
  createDxFeedStorageService, DEFAULT_MAX_BATCH_ENVELOPES,
} = require("../../src/storage/dxfeed/dxfeed-storage-service");
const { DEFAULT_DB_PATH } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createStorageCheckpoint } = require("../../src/storage/storage-checkpoint");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { createCliHeartbeat } = require("../../src/platform/cli-heartbeat");
const { createRuntimeHealthMonitor } = require("../../src/platform/runtime-health-monitor");
const { collectorCapacityLimits } = require("../../src/platform/runtime-limits");
const {
  createCollectorCapacityGuard, DEFAULT_BREACH_DURATION_MS, dbCapacityTransition, CAPACITY_STOP_EXIT_CODE,
} = require("../../src/storage/collector-capacity-guard");
const {
  waitForAuthorized,
  waitForChannelOpened,
  AUTH_TIMEOUT_MS,
  CHANNEL_OPEN_TIMEOUT_MS,
} = require("../../src/providers/dxfeed/dxlink-handshake");
const { createDxFeedBarAggregator } = require("../../src/providers/dxfeed/dxfeed-bar-aggregator");
const { adaptNativeDxFeedCandle, isEmptyNativeCandle } = require("../../src/providers/dxfeed/dxfeed-candle-adapter");
const {
  adaptLiveDxFeedTimeAndSaleForBar,
  isDxFeedTimeAndSaleBarWorthy,
} = require("../../src/providers/dxfeed/dxfeed-trade-adapter");
const {
  EVENT_TYPES,
  listCollectorInstruments,
  collectorCellKey,
  buildCollectorSubscriptionEntries,
  buildCollectorContextIndex,
} = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const {
  SHUTDOWN_MARGIN_MS,
  MAX_TOKEN_LIFETIME_MS,
  PLANNED_ROTATION_EXIT_CODE,
  UNEXPECTED_DISCONNECT_EXIT_CODE,
  parseExpiresAtMs,
  computeShutdownDeadlineMs,
  resolveShutdownDeadline,
} = require("../../src/providers/dxfeed/dxfeed-token-lifecycle");

const CANDLE_FINALIZATION_INTERVAL_MS = 1_000;
const CAPACITY_WATCHDOG_INTERVAL_MS = 1_000;
const FAULT_COUNTER_KEYS = Object.freeze([
  "skipped", "rejected", "tradeIdGaps", "tradeIdNonMonotonic", "checkpointBusyRuns", "checkpointFailures",
]);

function counterIncreased(current, previous, key) {
  return (current?.[key] ?? 0) > (previous?.[key] ?? 0);
}

function readDiskStats(dbPath) {
  const stats = {};
  let footprintBytes = 0;
  let databaseReadable = false;
  try {
    footprintBytes = fs.statSync(dbPath).size;
    databaseReadable = Number.isSafeInteger(footprintBytes) && footprintBytes >= 0;
  } catch {
    void 0;
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const sidecarBytes = fs.statSync(`${dbPath}${suffix}`).size;
      if (!Number.isSafeInteger(sidecarBytes) || sidecarBytes < 0 || !Number.isSafeInteger(footprintBytes + sidecarBytes)) {
        databaseReadable = false;
      } else {
        footprintBytes += sidecarBytes;
      }
    } catch {
      void 0;
    }
  }
  if (databaseReadable) stats.dbSizeBytes = footprintBytes;
  let filesystemReadable = false;
  try {
    const { bavail, bsize } = fs.statfsSync(path.dirname(dbPath));
    const freeDiskBytes = bavail * bsize;
    if (Number.isSafeInteger(freeDiskBytes) && freeDiskBytes >= 0) {
      stats.freeDiskBytes = freeDiskBytes;
      filesystemReadable = true;
    }
  } catch {
    void 0;
  }
  stats.diskProbeHealthy = databaseReadable && filesystemReadable;
  return stats;
}

const HEARTBEAT_ACTIVITY_KEYS = Object.freeze(["quotes", "trades", "timeAndSales", "orderBookCapture"]);

async function main({
  logger = createCliLogger({ name: "dxfeed-collector" }),
  loadConfig = loadDxFeedConfig,
  createConnection = createDxLinkConnection,
  createStorageService = createDxFeedStorageService,
  createHeartbeat = createCliHeartbeat,
  createHealthMonitor = createRuntimeHealthMonitor,
  createCapacityGuard = createCollectorCapacityGuard,
  readStorageCapacity = readDiskStats,
  createOrderV2Capture = createDxFeedOrderV2Capture,
  createCheckpoint = createStorageCheckpoint,
  dbPath = DEFAULT_DB_PATH,
  env = process.env,
  now = () => Date.now(),
  signalProcess = process,
  exit = process.exit,
  deadlineKeepsProcessAlive = true,
} = {}) {
  const initialNowMs = now();
  if (!Number.isSafeInteger(initialNowMs) || initialNowMs <= 0) {
    logger.error("local clock returned an invalid timestamp -- refusing to start");
    await flushAndExit(logger, exit, 1);
    return;
  }
  const deadline = resolveShutdownDeadline(env.DXFEED_TOKEN_EXPIRES_AT, initialNowMs);
  if (!deadline.ok) {
    if (deadline.reason === "MISSING_OR_INVALID_EXPIRY") {
      logger.error("missing or invalid DXFEED_TOKEN_EXPIRES_AT -- refusing to start without a real self-termination deadline");
    } else if (deadline.reason === "PAST_SAFE_MARGIN") {
      logger.error("token is already at or past its safe self-termination margin -- refusing to start a session with no real runway", {
        expiresAt: env.DXFEED_TOKEN_EXPIRES_AT,
      });
    } else {
      logger.error("token expiry exceeds the approved temporary-token lifetime -- refusing to arm an unsafe timer");
    }
    await flushAndExit(logger, exit, 1);
    return;
  }
  const shutdownDeadlineMs = deadline.shutdownDeadlineMs;

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    logger.error("invalid dxFeed config", { reason: error?.message ?? error });
    await flushAndExit(logger, exit, 1);
    return;
  }
  if (config.marketDataMode !== "realtime") {
    logger.error("dxFeed collector requires realtime mode");
    await flushAndExit(logger, exit, 1);
    return;
  }
  const secrets = [config.tempToken];

  let storageService;
  try {
    storageService = createStorageService({ dbPath, bootstrap: false });
  } catch (error) {
    logger.error("failed to initialize dxFeed storage", { reason: error?.message ?? error });
    await flushAndExit(logger, exit, 1);
    return;
  }
  let resumeState;
  try {
    resumeState = storageService.getCaptureResumeState();
  } catch (error) {
    logger.error("failed to read dxFeed storage resume state", { reason: error?.message ?? error });
    try {
      storageService.close();
    } catch {
      void 0;
    }
    await flushAndExit(logger, exit, 1);
    return;
  }
  if (resumeState.hasExistingData) {
    logger.info("dxFeed storage resumed existing dataset", {
      previousSession: resumeState.previousSessionCleanShutdown === true ? "clean" : "unclean_or_unknown",
      previousQuality: resumeState.previousSessionQuality ?? "unknown",
      ...(resumeState.previousSessionEndedAt === null ? {} : { previousSessionEndedAt: new Date(resumeState.previousSessionEndedAt).toISOString() }),
    });
  } else {
    logger.info("dxFeed storage initialized new dataset");
  }
  const captureSessionId = randomUUID();
  try {
    storageService.beginCaptureSession({ sessionId: captureSessionId, startedAt: initialNowMs });
  } catch (error) {
    logger.error("failed to begin dxFeed capture session", { reason: error?.message ?? error });
    try {
      storageService.close();
    } catch {
      void 0;
    }
    await flushAndExit(logger, exit, 1);
    return;
  }

  let checkpoint;
  const checkpointHealth = {
    runs: 0, busyRuns: 0, failures: 0, lastBusy: null, lastLogFrames: null, lastCheckpointedFrames: null,
  };
  try {
    const storageDb = storageService.getStorageDb();
    checkpoint = createCheckpoint({
      storageDb,
      onError: (error) => {
        checkpointHealth.failures += 1;
        logger.error("dxfeed WAL checkpoint failed", { reason: error?.message ?? error });
      },
      onResult: (result) => {
        checkpointHealth.runs += 1;
        checkpointHealth.lastBusy = result.busy;
        checkpointHealth.lastLogFrames = result.logFrames;
        checkpointHealth.lastCheckpointedFrames = result.checkpointedFrames;
        if ((result.busy ?? 0) > 0) {
          checkpointHealth.busyRuns += 1;
          logger.warn("dxfeed WAL checkpoint remained busy", {
            busy: result.busy, logFrames: result.logFrames, checkpointedFrames: result.checkpointedFrames,
          });
        }
      },
    });
    checkpoint.start();
  } catch (error) {
    logger.error("failed to initialize dxFeed checkpoint", { reason: error?.message ?? error });
    try {
      storageService.finishCaptureSession({
        endedAt: Math.max(initialNowMs, now()), quality: "INVALID", cleanShutdown: false,
        terminationReason: "checkpoint initialization failed",
      });
    } catch (finishError) {
      logger.error("failed to finish dxFeed capture session", { reason: finishError?.message ?? finishError });
    }
    try {
      storageService.close();
    } catch (closeError) {
      logger.error("storage service close failed", { reason: closeError?.message ?? closeError });
    }
    await flushAndExit(logger, exit, 1);
    return;
  }

  const contextIndex = buildCollectorContextIndex();
  const instruments = listCollectorInstruments();
  const barAggregator = createDxFeedBarAggregator();
  const pendingNativeCandles = new Map();

  let connection;
  let settled = false;
  let channel = null;
  let onMessage = null;
  let onChannelError = null;
  let entries = [];
  let unsubscribeConnectionError = null;
  let unsubscribeConnectionDrop = null;
  let resolveAbortPromise;
  let shutdownPromise = null;
  let shutdownExitCode = null;
  let shutdownReason = null;
  let heartbeat = null;
  let runtimeHealth = null;
  let capacityGuard = null;
  let capacityWatchdog = null;
  let capacityWarningActive = false;
  let dbCapacityLevel = null;
  let deadlineTimer = null;
  let orderV2Capture = null;
  let candleFinalizationTimer = null;
  let filteredEvents = 0;
  const reportedDegradedCells = new Set();
  const abortPromise = new Promise((resolve) => {
    resolveAbortPromise = resolve;
  });

  function orderV2CorrelationStats() {
    const status = orderV2Capture?.getCorrelationStatus?.();
    if (!status) return {};
    return {
      orderV2PendingFrames: status.pendingFrames,
      orderV2PendingIndexValues: status.pendingIndexValues,
      orderV2CorrelationHealthy: status.healthy,
    };
  }

  function millisecondsRemaining() {
    const currentNowMs = now();
    if (!Number.isSafeInteger(currentNowMs) || currentNowMs <= 0) return 0;
    return Math.max(0, shutdownDeadlineMs - currentNowMs);
  }

  function finalizeDueCandles() {
    const finalized = barAggregator.finalizeThrough(now());
    for (const { symbol, assetClass, bar } of finalized) {
      storageService.recordCandle(symbol, assetClass, bar);
    }
    return finalized.length;
  }

  function startCandleFinalization() {
    if (candleFinalizationTimer) return;
    candleFinalizationTimer = setInterval(() => {
      if (settled) return;
      try {
        finalizeDueCandles();
      } catch (error) {
        logger.error("failed to finalize due dxFeed candles", { reason: redactSecrets(String(error?.message ?? error), secrets) });
        void shutdown("failed to finalize due dxFeed candles", 1);
      }
    }, CANDLE_FINALIZATION_INTERVAL_MS);
    candleFinalizationTimer.unref?.();
  }

  function stopCandleFinalization() {
    if (!candleFinalizationTimer) return;
    clearInterval(candleFinalizationTimer);
    candleFinalizationTimer = null;
  }

  function closeChannel() {
    if (!channel) return true;
    let clean = true;
    function attempt(name, operation) {
      try {
        operation();
      } catch (error) {
        clean = false;
        logger.error(`${name} failed`, {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
      }
    }
    try {
      if (onMessage) channel.removeMessageListener(onMessage);
    } catch (error) {
      clean = false;
      logger.error("FEED message-listener cleanup failed", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
    }
    if (onChannelError) attempt("FEED error-listener cleanup", () => channel.removeErrorListener?.(onChannelError));
    if (entries.length > 0) {
      attempt("FEED unsubscribe", () => channel.send({ type: "FEED_SUBSCRIPTION", remove: entries }));
    }
    attempt("FEED channel close", () => channel.close());
    channel = null;
    onMessage = null;
    onChannelError = null;
    entries = [];
    return clean;
  }

  function exitPriority(code) {
    if (code === 1) return 3;
    if (code === 130 || code === 143) return 2;
    return 1;
  }

  function shutdown(reason, requestedExitCode) {
    if (shutdownPromise) {
      if (exitPriority(requestedExitCode) > exitPriority(shutdownExitCode)) {
        shutdownExitCode = requestedExitCode;
        shutdownReason = reason;
      }
      return shutdownPromise;
    }
    settled = true;
    shutdownExitCode = requestedExitCode;
    shutdownReason = reason;
    resolveAbortPromise();
    shutdownPromise = Promise.resolve().then(async () => {
      function markCleanupFailure() {
        shutdownExitCode = 1;
      }
      logger.info(`${shutdownReason}, shutting down`, {});
      try {
        signalProcess.off("SIGINT", onSigint);
        signalProcess.off("SIGTERM", onSigterm);
      } catch (error) {
        markCleanupFailure();
        logger.error("failed to remove signal handlers", { reason: error?.message ?? error });
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      for (const [name, cleanup] of [
        ["heartbeat", () => heartbeat?.stop()],
        ["runtime health monitor", () => runtimeHealth?.stop()],
        ["capacity watchdog", () => { if (capacityWatchdog) clearInterval(capacityWatchdog); }],
        ["candle finalizer", stopCandleFinalization],
        ["connection error listener", () => unsubscribeConnectionError?.()],
        ["connection state listener", () => unsubscribeConnectionDrop?.()],
      ]) {
        try {
          cleanup();
        } catch (error) {
          markCleanupFailure();
          logger.error(`${name} cleanup failed`, { reason: error?.message ?? error });
        }
      }
      if (!closeChannel()) markCleanupFailure();
      try {
        connection?.disconnect();
      } catch (error) {
        markCleanupFailure();
        logger.error("disconnect failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
      }
      try {
        finalizeDueCandles();
      } catch (error) {
        markCleanupFailure();
        logger.error("failed to flush due dxFeed candles during shutdown", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
      }
      try {
        checkpoint?.stop();
      } catch (error) {
        markCleanupFailure();
        logger.error("WAL checkpoint cleanup failed", { reason: error?.message ?? error });
      }
      let countersAtShutdown;
      try {
        countersAtShutdown = storageService.getCounters();
      } catch (error) {
        markCleanupFailure();
        countersAtShutdown = { unavailable: true };
        logger.error("failed to read storage counters during shutdown", { reason: error?.message ?? error });
      }
      logger.info("dxFeed collector capture stopped", { countersAtShutdown });
      try {
        const planned = shutdownExitCode === 0 || shutdownExitCode === PLANNED_ROTATION_EXIT_CODE;
        const interrupted = shutdownExitCode === 130 || shutdownExitCode === 143;
        const counters = countersAtShutdown?.unavailable ? {} : countersAtShutdown;
        const observedDegradation = reportedDegradedCells.size > 0 || (counters.rejected ?? 0) > 0 ||
          (counters.tradeIdGaps ?? 0) > 0 || (counters.tradeIdNonMonotonic ?? 0) > 0 ||
          checkpointHealth.busyRuns > 0 || checkpointHealth.failures > 0;
        storageService.finishCaptureSession({
          endedAt: Math.max(initialNowMs, now()),
          quality: planned && !observedDegradation ? "HEALTHY" : (planned || interrupted) ? "DEGRADED" : "INVALID",
          cleanShutdown: planned || interrupted,
          terminationReason: shutdownReason,
        });
      } catch (error) {
        markCleanupFailure();
        logger.error("failed to finish dxFeed capture session", { reason: error?.message ?? error });
      }
      try {
        storageService.close();
      } catch (error) {
        markCleanupFailure();
        logger.error("storage service close failed", { reason: error?.message ?? error });
      }
      await flushAndExit(logger, exit, shutdownExitCode);
    });
    return shutdownPromise;
  }

  function onSigint() {
    logger.warn("received SIGINT, stopping the collector");
    void shutdown("received SIGINT", 130);
  }
  function onSigterm() {
    logger.warn("received SIGTERM, stopping the collector");
    void shutdown("received SIGTERM", 143);
  }
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);

  try {
    orderV2Capture = createOrderV2Capture({
      resolveOrderContext: (eventSymbol) => contextIndex.get(collectorCellKey(eventSymbol, "Order")) ?? null,
      onEnvelopes: (envelopes) => {
        if (settled) return;
        const accepted = [];
        for (const envelope of envelopes) {
          const context = contextIndex.get(collectorCellKey(envelope?.providerSymbol, "Order"));
          if (!context) {
            throw new Error(
              `raw order-book capture lost canonical integrity for ${String(envelope?.providerSymbol)}: no collector context for this cell`,
            );
          }
          if (envelope?.state === "UNAVAILABLE") {
            throw new Error(
              `raw order-book capture lost canonical integrity for ${String(envelope?.providerSymbol)}: ` +
              `${String(envelope?.reason)} missingFields=${JSON.stringify(envelope?.missingFields ?? [])}`,
            );
          }
          if (envelope.payload.source !== context.source) {
            filteredEvents += 1;
            continue;
          }
          accepted.push(envelope);
        }
        if (accepted.length > 0 && !storageService.handleOrderV2Envelopes(accepted).every((result) => result === true)) {
          throw new Error("canonical order-book envelope was rejected by storage");
        }
      },
      onCaptureError: (error) => {
        if (settled) return;
        logger.error("raw order-book capture failed", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
        void shutdown("raw order-book capture failed", 1);
      },
      now,
    });
  } catch (error) {
    logger.error("failed to initialize raw order-book capture", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    return shutdown("could not start", 1);
  }

  try {
    connection = createConnection(config, { createConnector: orderV2Capture.createConnector });
  } catch (error) {
    logger.error("failed to initialize dxFeed connection", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    return shutdown("could not start", 1);
  }

  deadlineTimer = setTimeout(() => {
    void shutdown("planned token rotation window reached", PLANNED_ROTATION_EXIT_CODE);
  }, millisecondsRemaining());
  if (!deadlineKeepsProcessAlive) deadlineTimer.unref?.();

  try {
    unsubscribeConnectionError = connection.onError((error) => {
      if (settled) return;
      logger.error("connection error", {
        type: typeof error?.type === "string" ? error.type : undefined,
        message: redactSecrets(typeof error?.message === "string" ? error.message : "dxLink error", secrets),
      });
      void shutdown("market-data connection failed", 1);
    });
    unsubscribeConnectionDrop = connection.onConnectionStateChange(({ state, prev }) => {
      if (settled) return;
      if (state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
        logger.error("connection dropped, stopping the collector");
        void shutdown("market-data connection dropped", UNEXPECTED_DISCONNECT_EXIT_CODE);
      }
    });
  } catch (error) {
    logger.error("failed to attach dxFeed connection listeners", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }

  try {
    connection.connect();
  } catch (error) {
    logger.error("connection failed before authorization", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }

  try {
    const authorized = await waitForAuthorized({ connection, timeoutMs: AUTH_TIMEOUT_MS, abortPromise });
    if (!authorized || settled) return shutdownPromise;
  } catch (error) {
    if (settled) return shutdownPromise;
    logger.error("failed to authorize", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }
  logger.ok("AUTHORIZED");

  try {
    channel = connection.openChannel("FEED", { contract: "AUTO" });
    const opened = await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
    if (!opened || settled) return shutdownPromise;
    channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
    orderV2Capture.setChannelId(channel.id);
  } catch (error) {
    if (settled) return shutdownPromise;
    logger.error("failed to open FEED channel", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }

  onMessage = function onMessage(message) {
    if (message?.type !== "FEED_DATA" || !Array.isArray(message.data)) return;
    try {
      if (message.data.length > DEFAULT_MAX_BATCH_ENVELOPES) {
        throw new Error(`provider FEED_DATA batch exceeded ${DEFAULT_MAX_BATCH_ENVELOPES} items`);
      }
      orderV2Capture.handleChannelMessage(message);
      const normalized = [];
      for (const item of message.data) {
        if (settled) return;
        const context = contextIndex.get(collectorCellKey(item?.eventSymbol, item?.eventType));
        if (!context || (context.source !== undefined && item?.source !== context.source)) {
          filteredEvents += 1;
          continue;
        }
        if (context.eventType === EVENT_TYPES.ORDER) {
          filteredEvents += 1;
          continue;
        }
        if (context.nativeCandle === true) {
          if (isEmptyNativeCandle(item)) continue;
          let candle;
          try {
            candle = adaptNativeDxFeedCandle(item, { symbol: context.symbol });
          } catch (error) {
            const cell = `${context.symbol}|CANDLE|REJECTED`;
            if (!reportedDegradedCells.has(cell)) {
              reportedDegradedCells.add(cell);
              logger.warn("native candle rejected, not stored", {
                symbol: context.symbol,
                reason: redactSecrets(String(error?.message ?? error), secrets),
              });
            }
            continue;
          }
          const key = `${context.assetClass}:${context.symbol}`;
          const previous = pendingNativeCandles.get(key);
          if (previous && candle.ts_open > previous.ts_open) {
            storageService.recordCandle(context.symbol, context.assetClass, previous, { derivation: "NATIVE" });
          }
          if (!previous || candle.ts_open >= previous.ts_open) pendingNativeCandles.set(key, candle);
          continue;
        }
        const envelope = normalizeDxFeedEvent(
          { assetClass: context.assetClass, symbol: context.symbol, eventType: context.eventType, raw: item },
          { receivedAtMs: now() },
        );
        normalized.push({ context, envelope, raw: item });
      }
      if (normalized.length === 0) return;
      const results = storageService.handleEnvelopes(normalized.map(({ envelope }) => envelope));
      for (let index = 0; index < normalized.length; index += 1) {
        const { context, envelope, raw } = normalized[index];
        if (envelope.state === "UNAVAILABLE") {
          const cell = `${context.symbol}|${context.eventType}|${envelope.reason}`;
          if (!reportedDegradedCells.has(cell)) {
            reportedDegradedCells.add(cell);
            logger.warn("degraded envelope, not stored", {
              symbol: context.symbol,
              eventType: context.eventType,
              reason: envelope.reason,
              missingFields: JSON.stringify(envelope.missingFields ?? []),
            });
          }
        } else if (results[index] !== true) {
          throw new Error("canonical envelope was rejected by storage");
        } else if (
          context.eventType === EVENT_TYPES.TIMEANDSALE &&
          isDxFeedTimeAndSaleBarWorthy(envelope.payload, { requireValidTick: true })
        ) {
          const adapted = adaptLiveDxFeedTimeAndSaleForBar(envelope, raw);
          const { closedBar } = barAggregator.ingest({ ...adapted, nowMs: now() });
          if (closedBar) {
            storageService.recordCandle(context.symbol, context.assetClass, closedBar);
          }
        }
      }
    } catch (error) {
      logger.error("failed to normalize or store a dxFeed event batch", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      void shutdown("failed to normalize or store an event batch", 1);
    }
  };
  onChannelError = (error) => {
    if (settled) return;
    logger.error("FEED channel error", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    void shutdown("market-data connection failed", 1);
  };
  try {
    channel.addMessageListener(onMessage);
    channel.addErrorListener?.(onChannelError);
    entries = buildCollectorSubscriptionEntries({ nowMs: now() });
  } catch (error) {
    logger.error("failed to attach FEED channel listeners", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }
  try {
    channel.send({ type: "FEED_SUBSCRIPTION", add: entries });
  } catch (error) {
    logger.error("failed to subscribe", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }
  logger.banner([
    "DXFEED COLLECTOR (Terminal 0 equivalent)",
    `instruments  ${instruments.map((i) => i.symbol).join(", ")}`,
    `subscribed   ${entries.length} entries (Quote+Trade+Order+TimeAndSale+Candle per instrument)`,
    `storage      ${dbPath}`,
    `expires      ${env.DXFEED_TOKEN_EXPIRES_AT}`,
    "rotation     planned session rotation before expiry; the token launcher starts the next session after this process exits",
  ]);
  startCandleFinalization();

  try {
    runtimeHealth = createHealthMonitor();
    runtimeHealth.start();
    capacityGuard = createCapacityGuard(collectorCapacityLimits());
    capacityWatchdog = setInterval(() => {
      try {
        const health = runtimeHealth.getStats();
        const observed = {
          ...storageService.getCounters(), ...health,
          schedulerHealthy: health.eventLoopHealthy,
          ...readStorageCapacity(dbPath),
        };
        const result = capacityGuard.observe(observed);
        const capacityStep = dbCapacityTransition(dbCapacityLevel, result.dbFill);
        dbCapacityLevel = capacityStep.level;
        if (capacityStep.announce === "APPROACHING") {
          logger.warn("dxFeed storage database approaching its size cap", {
            dbSizeBytes: observed.dbSizeBytes, fillPct: Math.round(result.dbFill.ratio * 1_000) / 10, level: capacityStep.level,
          });
        } else if (capacityStep.announce === "RECOVERED") {
          logger.ok("dxFeed storage database back under its size warning level", { dbSizeBytes: observed.dbSizeBytes });
        }
        if (result.breached && !capacityWarningActive) {
          capacityWarningActive = true;
          logger.warn("dxFeed storage capacity pressure elevated", {
            reason: result.reason, graceSeconds: DEFAULT_BREACH_DURATION_MS / 1_000,
            dbSizeBytes: observed.dbSizeBytes ?? null, freeDiskBytes: observed.freeDiskBytes ?? null,
          });
        } else if (!result.breached && capacityWarningActive) {
          capacityWarningActive = false;
          logger.ok("dxFeed storage capacity pressure recovered");
        }
        if (result.shouldStop) {
          logger.error("dxFeed storage capacity safeguard triggered", {
            reason: result.reason, breachDurationMs: result.breachDurationMs,
          });
          void shutdown("dxFeed storage capacity safety limit exceeded", CAPACITY_STOP_EXIT_CODE);
        }
      } catch (error) {
        logger.error("dxFeed storage capacity watchdog failed", { reason: error?.message ?? error });
        void shutdown("dxFeed storage capacity watchdog failed", 1);
      }
    }, CAPACITY_WATCHDOG_INTERVAL_MS);
    capacityWatchdog.unref?.();
    heartbeat = createHeartbeat({
      logger,
      activityKeys: HEARTBEAT_ACTIVITY_KEYS,
      collect: () => ({
        ...storageService.getCounters(),
        ...runtimeHealth.getStats(),
        ...(capacityGuard?.getStats() ?? {}),
        ...readStorageCapacity(dbPath),
        checkpointRuns: checkpointHealth.runs,
        checkpointBusyRuns: checkpointHealth.busyRuns,
        checkpointFailures: checkpointHealth.failures,
        checkpointLogFrames: checkpointHealth.lastLogFrames,
        checkpointedFrames: checkpointHealth.lastCheckpointedFrames,
        ...orderV2CorrelationStats(),
        filtered: filteredEvents,
        remainingMs: millisecondsRemaining(),
      }),
      displayCounters: (stats) => ({
        quotes: stats.quotes,
        trades: stats.trades,
        timeAndSales: stats.timeAndSales,
        candles: stats.candles,
        orderBookCapture: stats.orderBookCapture,
        skipped: stats.skipped,
        rejected: stats.rejected,
        tradeIdGaps: stats.tradeIdGaps,
        tradeIdNonMonotonic: stats.tradeIdNonMonotonic,
        orderV2PendingFrames: stats.orderV2PendingFrames,
        filtered: stats.filtered,
        remainingMin: Math.round(stats.remainingMs / 60_000),
      }),
      isNominal: (current, previous) =>
        current.eventLoopHealthy === true &&
        current.diskProbeHealthy === true &&
        current.capacityBreached !== true &&
        !FAULT_COUNTER_KEYS.some((key) => counterIncreased(current, previous, key)) &&
        current.remainingMs > 0 &&
        ["quotes", "trades", "orders", "timeAndSales"].some((key) => (current[key] ?? 0) > (previous?.[key] ?? 0)),
      degradedReason: (current, previous) => {
        if (current.eventLoopHealthy !== true) return "event-loop delay above limit";
        if (current.diskProbeHealthy !== true) return "storage capacity probe unavailable";
        if (current.capacityBreached === true) return current.capacityLastBreachReason ?? "storage capacity pressure";
        if (counterIncreased(current, previous, "rejected")) return "new canonical storage rejection this interval";
        if (counterIncreased(current, previous, "tradeIdGaps") || counterIncreased(current, previous, "tradeIdNonMonotonic")) {
          return "new trade-ID continuity break this interval";
        }
        if (counterIncreased(current, previous, "skipped")) return "one or more canonical feed cells degraded this interval";
        if (counterIncreased(current, previous, "checkpointFailures")) return "WAL checkpoint maintenance failed this interval";
        if (counterIncreased(current, previous, "checkpointBusyRuns")) return "WAL checkpoint remained busy this interval";
        if (current.remainingMs <= 0) return "past self-termination deadline";
        return "no new market data since last heartbeat";
      },
    });
    heartbeat.start();
  } catch (error) {
    logger.error("failed to start collector health monitoring", { reason: error?.message ?? error });
    void shutdown("could not start", 1);
    return shutdownPromise;
  }
  logger.ok("running, capturing all known instruments", { remainingMin: Math.round(millisecondsRemaining() / 60_000) });
  return shutdownPromise;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("run-dxfeed-collector: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  HEARTBEAT_ACTIVITY_KEYS,
  main,
  parseExpiresAtMs,
  computeShutdownDeadlineMs,
  SHUTDOWN_MARGIN_MS,
  MAX_TOKEN_LIFETIME_MS,
  PLANNED_ROTATION_EXIT_CODE,
  readDiskStats,
};
