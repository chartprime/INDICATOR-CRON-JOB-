#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("collector", { isMain: require.main === module });

const fs = require("node:fs");
const path = require("node:path");
const { createBinanceConnection } = require("../../src/providers/binance/binance-connection");
const { MARKET_KINDS, listAllowedSymbols, listAllowedMarketKinds } = require("../../src/providers/binance/binance-config");
const { createStorageService } = require("../../src/storage/storage-service");
const { DEFAULT_DB_PATH } = require("../../src/storage/storage-db");
const {
  createCollectorFeedMaintenance,
  listCollectorSubscriptions,
} = require("../../src/storage/collector-feed-maintenance");
const { createThrottledConsoleSink } = require("../../src/platform/telemetry-console-sink");
const { createCliLogger } = require("../../src/platform/cli-logger");
const { createCliHeartbeat } = require("../../src/platform/cli-heartbeat");
const { createCollectorIntegrityMonitor } = require("../../src/storage/collector-integrity-monitor");
const {
  createCollectorCapacityGuard,
  dbCapacityTransition,
  DEFAULT_BREACH_DURATION_MS,
  CAPACITY_STOP_EXIT_CODE,
} = require("../../src/storage/collector-capacity-guard");
const { createRuntimeHealthMonitor } = require("../../src/platform/runtime-health-monitor");
const { collectorCapacityLimits } = require("../../src/platform/runtime-limits");
const { runtimeDir } = require("../../src/platform/runtime-paths");
const { writeCollectorHealthFile } = require("../../src/storage/collector-health-file");
const { OVERFLOW_POLICIES } = require("../../src/providers/binance/binance-backpressure-queue");

const COLLECTOR_CONSUMER_ID = "storage-collector";
const CONNECT_POLL_MS = 200;
const CONNECT_TIMEOUT_MS = 30_000;
const COLLECTOR_BACKPRESSURE_MAX_DEPTH = 50_000;
const COLLECTOR_BACKPRESSURE_DRAIN_BATCH_SIZE = 1_000;
const COLLECTOR_BACKPRESSURE_DRAIN_MAX_MS = 8;
const COLLECTOR_RAW_INGRESS_MAX_DEPTH = 50_000;
const COLLECTOR_RAW_INGRESS_MAX_BYTES = 64 * 1024 * 1024;
const COLLECTOR_RAW_INGRESS_DRAIN_BATCH_SIZE = 1_000;
const COLLECTOR_RAW_INGRESS_DRAIN_MAX_MS = 8;
const COLLECTOR_INGRESS_DRAIN_BATCH_SIZE = 1_000;
const COLLECTOR_INGRESS_DRAIN_MAX_MS = 8;
const CAPACITY_WATCHDOG_INTERVAL_MS = 1_000;
const COLLECTOR_HEALTH_FILE = "collector-health.json";
const STORAGE_STOP_TIMEOUT_MS = 60_000;
const TERMINAL_INTEGRITY_EVENTS = new Set([
  "market_data.binance_backpressure.event_dropped",
  "market_data.binance_backpressure.queue_overflow",
  "market_data.binance_raw_ingress.queue_overflow",
  "storage.record_rejected",
]);
const COMPACT_SUPPRESSED_TELEMETRY_EVENTS = new Set([
  "storage.trade_id_provider_discontinuity",
  "storage.worker.maintenance_succeeded",
  "market_data.binance_connection.route_connected",
  "market_data.binance_connection.route_disconnected",
  "market_data.binance_connection.route_reconnect_scheduled",
  "market_data.binance_connection.route_reconnect_succeeded",
  "market_data.binance_connection.route_resubscribed",
  "market_data.binance_connection.stale_subscription_recovery_started",
  "market_data.binance_connection.stale_subscription_recovery_succeeded",
  "market_data.binance_connection.depth_gap_recovery_attempt",
  "market_data.binance_connection.depth_gap_recovery_succeeded",
  "market_data.binance_connection.depth_snapshot_fetched",
  "market_data.binance_connection.depth_snapshot_retry_scheduled",
  "market_data.binance_raw_ingress.flow_control_resumed",
]);

function readDiskStats(dbPath) {
  const stats = {};
  let footprintBytes = 0;
  let storageProbeHealthy = false;
  try {
    footprintBytes = fs.statSync(dbPath).size;
    storageProbeHealthy = true;
  } catch {
    void 0;
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      footprintBytes += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      void 0;
    }
  }
  if (storageProbeHealthy) stats.dbSizeBytes = footprintBytes;
  let filesystemProbeHealthy = false;
  try {
    const { bavail, bsize } = fs.statfsSync(path.dirname(dbPath));
    stats.freeDiskBytes = bavail * bsize;
    filesystemProbeHealthy = true;
  } catch {
    void 0;
  }
  stats.diskProbeHealthy = storageProbeHealthy && filesystemProbeHealthy;
  return stats;
}

function allRoutesConnected(connection) {
  const status = connection.getStatus();
  return (
    status[MARKET_KINDS.SPOT]?.public === "CONNECTED" &&
    status[MARKET_KINDS.PERPETUAL]?.public === "CONNECTED" &&
    status[MARKET_KINDS.PERPETUAL]?.market === "CONNECTED"
  );
}

function waitForAllRoutesConnected(connection, {
  timeoutMs = CONNECT_TIMEOUT_MS,
  pollMs = CONNECT_POLL_MS,
  isCancelled = () => false,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("run-collector: route connection timeout must be a positive safe integer"));
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
    return Promise.reject(new Error("run-collector: route connection poll interval must be a positive safe integer"));
  }
  if (typeof isCancelled !== "function") {
    return Promise.reject(new Error("run-collector: isCancelled must be a function"));
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (isCancelled()) {
        const error = new Error("run-collector: startup cancelled while waiting for market-data routes");
        error.code = "COLLECTOR_STARTUP_CANCELLED";
        reject(error);
        return;
      }
      if (allRoutesConnected(connection)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`run-collector: routes never reached CONNECTED within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

function subscribeAllPairs(connection, logger) {
  const requests = listCollectorSubscriptions();
  try {
    connection.subscribeMany(requests, COLLECTOR_CONSUMER_ID);
  } catch (error) {
    logger.error("failed to subscribe collector routes", {
      subscriptionCount: requests.length,
      reason: error?.message ?? error,
    });
    throw error;
  }
}

function compactIncidentMeta(entry, extra = {}) {
  const meta = {
    ...(typeof entry.marketKind === "string" ? { marketKind: entry.marketKind } : {}),
    ...(typeof entry.route === "string" ? { route: entry.route } : {}),
    ...(typeof entry.symbol === "string" ? { symbol: entry.symbol } : {}),
    ...(typeof entry.eventType === "string" ? { eventType: entry.eventType } : {}),
    ...extra,
  };
  for (const key of ["closeCode", "missingCount", "discardedCount", "droppedCount", "durationMs", "reason"]) {
    if (entry[key] !== undefined) meta[key] = entry[key];
  }
  return meta;
}

function compactPressureMeta(stats, extra = {}) {
  const maintenance = stats.storageLastMaintenance;
  return {
    ...extra,
    pendingWriteItems: stats.pendingWriteItems ?? 0,
    pendingIngressEnvelopes: stats.pendingIngressEnvelopes ?? 0,
    ingressAgeMs: stats.storageIngressOldestAgeMs ?? 0,
    writeAgeMs: stats.storageOldestPendingAgeMs ?? 0,
    backpressurePending: stats.backpressurePending ?? 0,
    rawIngressPending: stats.rawIngressPending ?? 0,
    rawIngressPendingBytes: stats.rawIngressPendingBytes ?? 0,
    rawIngressAgeMs: stats.rawIngressOldestAgeMs ?? 0,
    rawIngressHighWaterMark: stats.rawIngressHighWaterMark ?? 0,
    rawIngressHighWaterBytes: stats.rawIngressHighWaterBytes ?? 0,
    rawIngressDrainTimeYields: stats.rawIngressDrainTimeYields ?? 0,
    rawIngressLastDrainMs: stats.rawIngressLastDrainMs ?? 0,
    rawIngressMaxDrainMs: stats.rawIngressMaxDrainMs ?? 0,
    rawIngressPausedRoutes: stats.rawIngressPausedRoutes ?? 0,
    rawIngressLongestActivePauseMs: stats.rawIngressLongestActivePauseMs ?? 0,
    rawIngressFlowControlPauses: stats.rawIngressFlowControlPauses ?? 0,
    rawIngressFlowControlResumes: stats.rawIngressFlowControlResumes ?? 0,
    rawIngressFlowControlFailures: stats.rawIngressFlowControlFailures ?? 0,
    rawIngressFlowControlMaxPausedMs: stats.rawIngressFlowControlMaxPausedMs ?? 0,
    eventLoopMaxDelayMs: stats.eventLoopMaxDelayMs ?? 0,
    eventLoopUtilizationPct: stats.eventLoopUtilizationPct ?? 0,
    storageLastCommitMs: stats.storageLastCommitMs ?? 0,
    storageLastAckLatencyMs: stats.storageLastAckLatencyMs ?? 0,
    storageLastAckAgeMs: stats.storageLastAckAgeMs ?? null,
    storageWorkerState: stats.storageWorkerState ?? "UNKNOWN",
    storageActiveWriteBatchId: stats.storageActiveWriteBatchId ?? null,
    storageActiveWriteItems: stats.storageActiveWriteItems ?? 0,
    storageActiveWriteAgeMs: stats.storageActiveWriteAgeMs ?? 0,
    storageIngressLastDrainMs: stats.storageIngressLastDrainMs ?? 0,
    storageIngressMaxDrainMs: stats.storageIngressMaxDrainMs ?? 0,
    backpressureHighWaterMark: stats.backpressureHighWaterMark ?? 0,
    backpressureDrainTimeYields: stats.backpressureDrainTimeYields ?? 0,
    capacityNoProgressMs: stats.capacityNoProgressDurationMs ?? 0,
    processRssBytes: stats.processRssBytes ?? 0,
    processHeapUsedBytes: stats.processHeapUsedBytes ?? 0,
    processHeapTotalBytes: stats.processHeapTotalBytes ?? 0,
    processExternalBytes: stats.processExternalBytes ?? 0,
    processArrayBuffersBytes: stats.processArrayBuffersBytes ?? 0,
    dbSizeBytes: stats.dbSizeBytes ?? null,
    freeDiskBytes: stats.freeDiskBytes ?? null,
    gcCount: stats.gcCount ?? 0,
    gcTotalDurationMs: stats.gcTotalDurationMs ?? 0,
    gcMaxDurationMs: stats.gcMaxDurationMs ?? 0,
    ...(maintenance && typeof maintenance === "object"
      ? {
          storageMaintenanceName: maintenance.name,
          storageMaintenanceOk: maintenance.ok,
          storageMaintenanceDurationMs: maintenance.durationMs,
          storageMaintenanceAt: maintenance.at,
        }
      : {}),
  };
}

function displayCollectorStatus(stats) {
  if (stats.collectorStatus !== "HEALTHY") return stats.collectorStatus;
  if (
    stats.diskProbeHealthy === false ||
    stats.operatorLogPersistenceHealthy === false ||
    stats.operatorLogOutputHealthy === false ||
    (stats.telemetryLogFailures ?? 0) > 0
  ) {
    return "DEGRADED";
  }
  if (
    stats.capacityBreached === true ||
    (stats.rawIngressPausedRoutes ?? 0) > 0 ||
    (stats.rawIngressPending ?? 0) >= 1_000 ||
    (stats.backpressurePending ?? 0) >= 1_000 ||
    (stats.pendingIngressEnvelopes ?? 0) >= 1_000 ||
    (stats.storageOldestPendingAgeMs ?? 0) >= 5_000
  ) {
    return "PRESSURED";
  }
  return "HEALTHY";
}

function displayCollectorHeartbeat(stats) {
  const status = displayCollectorStatus(stats);
  const recordedGaps = stats.recordedGaps ?? 0;
  const operationalDegradations = stats.operationalDegradations ?? 0;
  const session = stats.captureQuality === "HEALTHY"
    ? "CLEAN"
    : operationalDegradations > 0
      ? `${stats.captureQuality ?? "UNKNOWN"} (${recordedGaps} historical ${recordedGaps === 1 ? "gap" : "gaps"}, ${operationalDegradations} operational ${operationalDegradations === 1 ? "issue" : "issues"})`
      : `${stats.captureQuality ?? "UNKNOWN"} (${recordedGaps} historical ${recordedGaps === 1 ? "gap" : "gaps"})`;
  const counters = {
    status,
    session,
    trades: stats.trades,
    candles: stats.candles,
    depthEvents: stats.depthEvents,
    depthSnapshots: stats.depthSnapshots,
  };
  if (
    status !== "HEALTHY" ||
    (stats.pendingWriteItems ?? 0) >= 100 ||
    (stats.pendingIngressEnvelopes ?? 0) >= 100 ||
    (stats.backpressurePending ?? 0) > 0 ||
    (stats.rawIngressPending ?? 0) > 0 ||
    (stats.rawIngressPausedRoutes ?? 0) > 0 ||
    (stats.storageOldestPendingAgeMs ?? 0) >= 1_000
  ) {
    counters.pendingWriteItems = stats.pendingWriteItems;
    counters.pendingIngressEnvelopes = stats.pendingIngressEnvelopes;
    counters.ingressAgeMs = stats.storageIngressOldestAgeMs;
    counters.writeLagMs = stats.storageOldestPendingAgeMs;
    counters.backpressurePending = stats.backpressurePending;
    counters.rawIngressPending = stats.rawIngressPending;
    counters.rawIngressBytes = stats.rawIngressPendingBytes;
    counters.flowPausedRoutes = stats.rawIngressPausedRoutes;
  }
  return counters;
}

function awaitWithin(promise, timeoutMs, label) {
  let timeout = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function main() {
  const logger = createCliLogger({ name: "collector" });
  const integrityMonitor = createCollectorIntegrityMonitor();
  const capacityGuard = createCollectorCapacityGuard(collectorCapacityLimits());
  const runtimeHealth = createRuntimeHealthMonitor();
  const localSchedulerHealthy = () => {
    const health = runtimeHealth.getStats();
    return health.eventLoopHealthy === true;
  };
  const consoleTelemetry = createThrottledConsoleSink({ log: (...args) => logger.telemetryLine(...args) });
  let storageService;
  let captureActive = true;
  const telemetry = (entry) => {
    const integrity = captureActive
      ? integrityMonitor.recordTelemetry(entry)
      : { isIncident: false, incidents: [] };
    for (const incident of integrity.incidents) storageService?.recordIncident(incident);
    if (entry?.event === "market_data.binance_raw_ingress.flow_control_paused") {
      logger.warn("market-data burst buffering", compactIncidentMeta(entry, {
        queueDepth: entry.queueDepth,
        queueBytes: entry.queueBytes,
      }));
    } else if (
      entry?.event === "market_data.binance_raw_ingress.flow_control_resumed" &&
      entry.reason === "LOW_WATERMARK"
    ) {
      logger.ok("market-data burst recovered", compactIncidentMeta(entry, {
        durationMs: entry.durationMs,
        queueDepth: entry.queueDepth,
      }));
    } else if (entry?.event === "market_data.binance_raw_ingress.flow_control_failed") {
      logger.warn("market-data burst flow control failed", compactIncidentMeta(entry, {
        action: entry.action,
        reason: entry.reason,
      }));
    } else if (integrity.kind === "window_opened") {
      logger.warn("capture window degraded", compactIncidentMeta(entry, { scope: integrity.scope }));
    } else if (integrity.kind === "window_recovered") {
      logger.ok("capture window recovered", compactIncidentMeta(entry, {
        scope: integrity.scope,
        durationMs: integrity.durationMs,
      }));
    } else if (integrity.kind === "gap_recorded") {
      logger.warn("data continuity gap recorded", compactIncidentMeta(entry));
    } else if (integrity.kind === "invalid") {
      logger.error("capture loss detected", compactIncidentMeta(entry));
    } else if (!COMPACT_SUPPRESSED_TELEMETRY_EVENTS.has(entry?.event)) {
      consoleTelemetry(entry);
    }
    if (captureActive && TERMINAL_INTEGRITY_EVENTS.has(entry?.event)) {
      integrityMonitor.recordFatalError();
      void shutdown(`unrecoverable capture loss detected (${entry.event})`, 1);
    }
  };
  const connection = createBinanceConnection({
    telemetry,
    backpressureOverflowPolicy: OVERFLOW_POLICIES.FAIL,
    backpressureMaxQueueDepth: COLLECTOR_BACKPRESSURE_MAX_DEPTH,
    backpressureDrainBatchSize: COLLECTOR_BACKPRESSURE_DRAIN_BATCH_SIZE,
    backpressureDrainMaxMs: COLLECTOR_BACKPRESSURE_DRAIN_MAX_MS,
    rawIngressMaxQueueDepth: COLLECTOR_RAW_INGRESS_MAX_DEPTH,
    rawIngressMaxQueueBytes: COLLECTOR_RAW_INGRESS_MAX_BYTES,
    rawIngressDrainBatchSize: COLLECTOR_RAW_INGRESS_DRAIN_BATCH_SIZE,
    rawIngressDrainMaxMs: COLLECTOR_RAW_INGRESS_DRAIN_MAX_MS,
    routeSilenceRecoveryAllowed: localSchedulerHealthy,
    rawIngressEnabled: true,
  });
  let heartbeat;
  let feedMaintenance;
  let capacityWatchdog = null;
  let stopping = false;
  let unsubscribeConnectionError = null;
  let capacityWarningActive = false;
  let dbCapacityLevel = null;
  let shutdownPromise = null;
  let terminalExitCode = 0;

  logger.info("initializing durable storage", { dbPath: DEFAULT_DB_PATH });

  function shutdown(reason, requestedExitCode = 0) {
    terminalExitCode = terminalExitCode === 1 || requestedExitCode === 1 ? 1 : Math.max(terminalExitCode, requestedExitCode);
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
    stopping = true;
    let exitCode = terminalExitCode;
    const cleanup = (name, action) => {
      try { action(); }
      catch (error) {
        exitCode = 1;
        terminalExitCode = 1;
        logger.error(`${name} cleanup failed`, { reason: error?.message ?? error });
      }
    };
    logger.info(`${reason}, shutting down`);
    cleanup("heartbeat", () => heartbeat?.stop());
    cleanup("feed maintenance", () => feedMaintenance?.stop());
    if (capacityWatchdog) clearInterval(capacityWatchdog);
    capacityWatchdog = null;
    cleanup("runtime health", () => runtimeHealth.stop());

    try {
      await awaitWithin(connection.quiesce(), STORAGE_STOP_TIMEOUT_MS, "market-data ingress shutdown");
    } catch (error) {
      exitCode = 1;
      terminalExitCode = 1;
      integrityMonitor.recordFatalError();
      logger.error("failed to drain market-data ingress", { reason: error?.message ?? error });
    }

    captureActive = false;

    cleanup("connection error listener", () => unsubscribeConnectionError?.());
    unsubscribeConnectionError = null;
    try {
      connection.removeConsumer(COLLECTOR_CONSUMER_ID);
    } catch (error) {
      exitCode = 1;
      terminalExitCode = 1;
      logger.error("failed to release collector subscriptions", { reason: error?.message ?? error });
    } finally {
      cleanup("connection", () => connection.disconnect());
    }

    const finalQuality = integrityMonitor.getStats().captureQuality;
    exitCode = terminalExitCode;
    try {
      storageService?.setCaptureOutcome({
        quality: finalQuality,
        cleanShutdown: exitCode === 0,
        terminationReason: reason,
      });
      await awaitWithin(storageService?.stop(), STORAGE_STOP_TIMEOUT_MS, "durable storage shutdown");
    } catch (error) {
      exitCode = 1;
      terminalExitCode = 1;
      logger.error("failed to flush durable storage", { reason: error?.message ?? error });
    }
    exitCode = terminalExitCode;
    consoleTelemetry.stop?.();
    logger.info("collector shutdown complete", {
      exitCode,
      captureQuality: finalQuality,
      reason,
    });
    try {
      await logger.flush({ throwOnError: true });
    } catch (error) {
      exitCode = 1;
      terminalExitCode = 1;
      console.error("collector operator log persistence failed", error?.message ?? error);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    logger.close?.();
    process.exit(exitCode);
    })();
    return shutdownPromise;
  }

  const onSigint = () => void shutdown("received SIGINT");
  const onSigterm = () => void shutdown("received SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    storageService = createStorageService({
      connection,
      dbPath: DEFAULT_DB_PATH,
      useWorker: true,
      ingressDrainBatchSize: COLLECTOR_INGRESS_DRAIN_BATCH_SIZE,
      ingressDrainMaxMs: COLLECTOR_INGRESS_DRAIN_MAX_MS,
      telemetry,
      onFatalError: (error) => {
        integrityMonitor.recordFatalError();
        logger.error("storage capture failed", {
          reason: error?.message ?? error,
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
          ...(error?.batchId !== undefined ? { batchId: error.batchId } : {}),
          ...(error?.itemCount !== undefined ? { batchItems: error.itemCount } : {}),
          ...(error?.bytes !== undefined ? { batchBytes: error.bytes } : {}),
          ...(error?.ageMs !== undefined ? { batchAgeMs: error.ageMs } : {}),
          ...(typeof error?.phase === "string" ? { phase: error.phase } : {}),
        });
        void shutdown("storage is no longer durable", 1);
      },
    });
    storageService.start();
    await storageService.whenReady();
    if (stopping) {
      await shutdownPromise;
      return;
    }
    const resumeState = storageService.getResumeState();
    if (resumeState.hasExistingData) {
      logger.info("storage resumed existing dataset", {
        previousSession: resumeState.previousSessionCleanShutdown === true ? "clean" : "unclean_or_unknown",
        previousQuality: resumeState.previousSessionQuality ?? "unknown",
        ...(resumeState.lastTradeAt === null ? {} : { lastTradeAt: new Date(resumeState.lastTradeAt).toISOString() }),
      });
    } else {
      logger.info("storage initialized new dataset");
    }
    unsubscribeConnectionError = connection.onError((error) => {
      const log = error.fatal === true ? logger.error : logger.warn;
      log("market-data connection recovery", {
        marketKind: error.marketKind,
        route: error.route,
        code: error.code,
        reason: error.message,
      });
      if (error.fatal === true) {
        integrityMonitor.recordFatalError();
        void shutdown("market-data capture integrity failed", 1);
      }
    });
  } catch (error) {
    if (stopping || error?.code === "COLLECTOR_STARTUP_CANCELLED") {
      await shutdownPromise;
      return;
    }
    logger.error("failed to initialize durable storage", { reason: error?.message ?? error });
    await shutdown("durable storage initialization failed", 1);
    return;
  }

  try {
    runtimeHealth.start();
    connection.connect();
    await waitForAllRoutesConnected(connection, { isCancelled: () => stopping });
    if (stopping) {
      await shutdownPromise;
      return;
    }
    logger.banner([
      "TERMINAL 0 - raw market-data collector",
      `pairs    ${listAllowedSymbols().join(", ")} x ${listAllowedMarketKinds().join(", ")}`,
      `storage  ${DEFAULT_DB_PATH}`,
      "time     UTC",
    ]);
    subscribeAllPairs(connection, logger);

    feedMaintenance = createCollectorFeedMaintenance({
      connection,
      shouldRecover: localSchedulerHealthy,
      onError: (error) => logger.error("feed-health maintenance failed", { reason: error?.message ?? error }),
    });
    feedMaintenance.start();
    capacityWatchdog = setInterval(() => {
      try {
        const runtimeStats = runtimeHealth.getStats();
        const observedStats = {
          ...storageService.getStats(),
          ...connection.getOperationalStats(),
          ...runtimeStats,
          schedulerHealthy: runtimeStats.eventLoopHealthy,
          ...readDiskStats(DEFAULT_DB_PATH),
        };
        const guardResult = capacityGuard.observe(observedStats);
        const capacityStep = dbCapacityTransition(dbCapacityLevel, guardResult.dbFill);
        dbCapacityLevel = capacityStep.level;
        if (capacityStep.announce === "APPROACHING") {
          logger.warn("collector database approaching its size cap", {
            dbSizeBytes: observedStats.dbSizeBytes, fillPct: Math.round(guardResult.dbFill.ratio * 1_000) / 10, level: capacityStep.level,
          });
        } else if (capacityStep.announce === "RECOVERED") {
          logger.ok("collector database back under its size warning level", { dbSizeBytes: observedStats.dbSizeBytes });
        }
        try {
          const integrity = integrityMonitor.getStats();
          writeCollectorHealthFile(path.join(runtimeDir(), COLLECTOR_HEALTH_FILE), {
            pendingWriteItems: Math.max(0, Math.round(observedStats.pendingWriteItems ?? 0)),
            writeLagMs: Math.max(0, Math.round(observedStats.storageOldestPendingAgeMs ?? 0)),
            sessionQuality: integrity.captureQuality ?? "UNKNOWN",
            collectorStatus: integrity.collectorStatus,
            recoveryAgeMs: Math.round(integrity.recoveryAgeMs),
            ackP99Ms: observedStats.storageAckP99Ms ?? 0,
            ackSampleCount: observedStats.storageAckSampleCount ?? 0,
          });
        } catch (error) {
          logger.warn("collector health file write failed", { reason: error?.message ?? error });
        }
        if (guardResult.breached && !capacityWarningActive) {
          capacityWarningActive = true;
          logger.warn("collector pressure elevated", compactPressureMeta(observedStats, {
            reason: guardResult.reason,
            graceSeconds: DEFAULT_BREACH_DURATION_MS / 1_000,
          }));
          storageService.recordIncident({
            event: "collector.capacity_pressure_opened",
            severity: "DEGRADED",
            ts: new Date().toISOString(),
            details: compactPressureMeta(observedStats, { reason: guardResult.reason }),
          });
        } else if (!guardResult.breached && capacityWarningActive) {
          capacityWarningActive = false;
          logger.ok("collector pressure recovered", compactPressureMeta(observedStats));
        }
        if (!guardResult.shouldStop) return;
        integrityMonitor.recordFatalError();
        logger.error("collector capacity safeguard triggered", {
          reason: guardResult.reason,
          breachDurationMs: guardResult.breachDurationMs,
          noProgressDurationMs: guardResult.noProgressDurationMs,
        });
        void shutdown("collector capacity safety limit exceeded", CAPACITY_STOP_EXIT_CODE);
      } catch (error) {
        integrityMonitor.recordFatalError();
        logger.error("collector capacity watchdog failed", { reason: error?.message ?? error });
        void shutdown("collector capacity watchdog failed", 1);
      }
    }, CAPACITY_WATCHDOG_INTERVAL_MS);
    capacityWatchdog.unref?.();

    heartbeat = createCliHeartbeat({
      logger,
      activityKeys: ["trades", "candles", "depthEvents", "depthSnapshots"],
      displayCounters: displayCollectorHeartbeat,
      collect: () => {
        const storageStats = storageService.getStats();
        return {
          ...storageStats,
          ...connection.getOperationalStats(),
          ...runtimeHealth.getStats(),
          ...capacityGuard.getStats(),
          ...integrityMonitor.getStats(),
          ...readDiskStats(DEFAULT_DB_PATH),
          ...(logger.getStats?.() ?? {}),
          ...(consoleTelemetry.getStats?.() ?? {}),
          lastBackupAt: storageStats.storageLastMaintenanceByName?.backup?.at ?? null,
        };
      },
      isNominal: (current, previous) => {
        const hasActivity = ["trades", "candles", "depthEvents", "depthSnapshots"]
          .some((key) => (current[key] ?? 0) !== (previous?.[key] ?? 0));
        return hasActivity &&
          current.captureQuality !== "INVALID" &&
          current.collectorStatus === "HEALTHY" &&
          current.eventLoopHealthy === true &&
          current.storageWorkerHealthy === true &&
          current.storageWorkerReady === true &&
          (current.rawIngressPausedRoutes ?? 0) === 0 &&
          current.rawIngressPending === 0 &&
          current.backpressurePending === 0 &&
          current.capacityBreached !== true &&
          current.diskProbeHealthy === true &&
          current.operatorLogPersistenceHealthy !== false &&
          current.operatorLogOutputHealthy !== false &&
          (current.telemetryLogFailures ?? 0) === 0 &&
          current.heartbeatIntervalLagMs <= 5_000 &&
          allRoutesConnected(connection);
      },
      degradedReason: (current, previous) => {
        if (current.collectorStatus === "INVALID" || current.captureQuality === "INVALID") {
          return "capture integrity invalid";
        }
        if (current.collectorStatus === "RECOVERING") return "recovering an affected data window";
        if (current.storageWorkerHealthy !== true) return "storage worker unhealthy";
        if (current.storageWorkerReady !== true) return "storage worker not ready";
        if (current.eventLoopHealthy !== true) return "event-loop delay above limit";
        if (current.heartbeatIntervalLagMs > 5_000) return "collector heartbeat was delayed";
        if (!allRoutesConnected(connection)) return "one or more market-data routes disconnected";
        if (current.diskProbeHealthy !== true) return "storage capacity probe unavailable";
        if (current.operatorLogPersistenceHealthy === false) return "operator log persistence failed";
        if (current.operatorLogOutputHealthy === false) return "operator console output failed";
        if ((current.telemetryLogFailures ?? 0) > 0) return "telemetry output failed";
        if (current.capacityBreached === true) return current.capacityLastBreachReason ?? "collector capacity limit breached";
        if (current.rawIngressPausedRoutes > 0) return "absorbing a market-data burst";
        if (current.rawIngressPending > 0) return "raw market-data ingress pending";
        if (current.backpressurePending > 0) return "market-data backlog pending";
        const hasActivity = ["trades", "candles", "depthEvents", "depthSnapshots"]
          .some((key) => (current[key] ?? 0) !== (previous?.[key] ?? 0));
        return hasActivity ? "collector degraded" : "no new market data since last heartbeat";
      },
    });
    heartbeat.start();
    logger.ok("running, capturing all known pairs", { dbPath: DEFAULT_DB_PATH });
  } catch (error) {
    if (stopping || error?.code === "COLLECTOR_STARTUP_CANCELLED") {
      await shutdownPromise;
      return;
    }
    logger.error("collector startup failed", { reason: error?.message ?? error });
    await shutdown("collector could not start completely", 1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("run-collector: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  main,
  awaitWithin,
  waitForAllRoutesConnected,
  readDiskStats,
  displayCollectorStatus,
  displayCollectorHeartbeat,
  TERMINAL_INTEGRITY_EVENTS,
};
