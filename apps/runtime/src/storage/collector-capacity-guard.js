const DEFAULT_MAX_PENDING_WRITE_ITEMS = 80_000;
const DEFAULT_MAX_PENDING_INGRESS_ENVELOPES = 40_000;
const DEFAULT_MAX_OLDEST_PENDING_AGE_MS = 60_000;
const DEFAULT_MAX_OLDEST_INGRESS_AGE_MS = 60_000;
const DEFAULT_MAX_BACKPRESSURE_PENDING = 40_000;
const DEFAULT_MAX_RAW_INGRESS_PENDING = 40_000;
const DEFAULT_MAX_RAW_INGRESS_PENDING_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_OLDEST_RAW_INGRESS_AGE_MS = 60_000;
const DEFAULT_BREACH_DURATION_MS = 30_000;
const DEFAULT_MIN_FREE_DISK_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DB_BYTES = 64 * 1024 * 1024 * 1024;
const DB_CAPACITY_WARNING_LEVELS = Object.freeze([0.8, 0.9]);
const CAPACITY_STOP_EXIT_CODE = 78;

function dbCapacityTransition(previousLevel, dbFill) {
  if (dbFill === null || dbFill === undefined) return { level: previousLevel, announce: null };
  if (dbFill.level === previousLevel) return { level: previousLevel, announce: null };
  if (dbFill.level === null) return { level: null, announce: "RECOVERED" };
  if (previousLevel !== null && dbFill.level < previousLevel) return { level: dbFill.level, announce: null };
  return { level: dbFill.level, announce: "APPROACHING" };
}

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`collector-capacity-guard: ${name} must be a positive safe integer`);
  }
}

function createCollectorCapacityGuard({
  maxPendingWriteItems = DEFAULT_MAX_PENDING_WRITE_ITEMS,
  maxPendingIngressEnvelopes = DEFAULT_MAX_PENDING_INGRESS_ENVELOPES,
  maxOldestPendingAgeMs = DEFAULT_MAX_OLDEST_PENDING_AGE_MS,
  maxOldestIngressAgeMs = DEFAULT_MAX_OLDEST_INGRESS_AGE_MS,
  maxBackpressurePending = DEFAULT_MAX_BACKPRESSURE_PENDING,
  maxRawIngressPending = DEFAULT_MAX_RAW_INGRESS_PENDING,
  maxRawIngressPendingBytes = DEFAULT_MAX_RAW_INGRESS_PENDING_BYTES,
  maxOldestRawIngressAgeMs = DEFAULT_MAX_OLDEST_RAW_INGRESS_AGE_MS,
  breachDurationMs = DEFAULT_BREACH_DURATION_MS,
  minFreeDiskBytes = DEFAULT_MIN_FREE_DISK_BYTES,
  maxDbBytes = DEFAULT_MAX_DB_BYTES,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of [
    ["maxPendingWriteItems", maxPendingWriteItems],
    ["maxPendingIngressEnvelopes", maxPendingIngressEnvelopes],
    ["maxOldestPendingAgeMs", maxOldestPendingAgeMs],
    ["maxOldestIngressAgeMs", maxOldestIngressAgeMs],
    ["maxBackpressurePending", maxBackpressurePending],
    ["maxRawIngressPending", maxRawIngressPending],
    ["maxRawIngressPendingBytes", maxRawIngressPendingBytes],
    ["maxOldestRawIngressAgeMs", maxOldestRawIngressAgeMs],
    ["breachDurationMs", breachDurationMs],
    ["minFreeDiskBytes", minFreeDiskBytes],
    ["maxDbBytes", maxDbBytes],
  ]) assertPositiveInteger(name, value);
  if (typeof now !== "function") {
    throw new Error("collector-capacity-guard: now must be a function");
  }

  let lastReason = null;
  let breachStartedAt = null;
  let lastProgressAt = null;
  let priorBreachSample = null;
  let schedulerBreachStartedAt = null;

  function breachState(stats) {
    if (stats?.diskProbeHealthy === false) {
      return {
        reason: "storage capacity probe unavailable",
        value: 1,
        companion: 0,
      };
    }
    if (Number.isSafeInteger(stats?.freeDiskBytes) && stats.freeDiskBytes < minFreeDiskBytes) {
      return {
        reason: `free disk below required reserve of ${minFreeDiskBytes} bytes`,
        value: stats.freeDiskBytes,
        companion: stats.dbSizeBytes ?? 0,
        valueProgress: "higher",
        companionProgress: "lower",
      };
    }
    if (Number.isSafeInteger(stats?.dbSizeBytes) && stats.dbSizeBytes > maxDbBytes) {
      return {
        reason: `live database exceeded maximum size of ${maxDbBytes} bytes`,
        value: stats.dbSizeBytes,
        companion: stats.freeDiskBytes ?? 0,
        valueProgress: "lower",
        companionProgress: "higher",
      };
    }
    if ((stats?.rawIngressPending ?? 0) > maxRawIngressPending) {
      return {
        reason: `raw market-data ingress exceeded ${maxRawIngressPending} frames`,
        value: stats.rawIngressPending,
        companion: stats.rawIngressOldestAgeMs ?? 0,
      };
    }
    if ((stats?.rawIngressPendingBytes ?? 0) > maxRawIngressPendingBytes) {
      return {
        reason: `raw market-data ingress exceeded ${maxRawIngressPendingBytes} bytes`,
        value: stats.rawIngressPendingBytes,
        companion: stats.rawIngressPending ?? 0,
      };
    }
    if ((stats?.rawIngressOldestAgeMs ?? 0) > maxOldestRawIngressAgeMs) {
      return {
        reason: `oldest raw market-data frame exceeded ${maxOldestRawIngressAgeMs}ms`,
        value: stats.rawIngressOldestAgeMs,
        companion: stats.rawIngressPending ?? 0,
      };
    }
    if ((stats?.pendingWriteItems ?? 0) > maxPendingWriteItems) {
      return {
        reason: `durable-write backlog exceeded ${maxPendingWriteItems} items`,
        value: stats.pendingWriteItems,
        companion: stats.storageOldestPendingAgeMs ?? 0,
      };
    }
    if ((stats?.pendingIngressEnvelopes ?? 0) > maxPendingIngressEnvelopes) {
      return {
        reason: `storage ingress backlog exceeded ${maxPendingIngressEnvelopes} envelopes`,
        value: stats.pendingIngressEnvelopes,
        companion: stats.storageIngressOldestAgeMs ?? 0,
      };
    }
    if ((stats?.storageOldestPendingAgeMs ?? 0) > maxOldestPendingAgeMs) {
      return {
        reason: `oldest durable write exceeded ${maxOldestPendingAgeMs}ms`,
        value: stats.storageOldestPendingAgeMs,
        companion: stats.pendingWriteItems ?? 0,
      };
    }
    if ((stats?.storageIngressOldestAgeMs ?? 0) > maxOldestIngressAgeMs) {
      return {
        reason: `oldest storage ingress envelope exceeded ${maxOldestIngressAgeMs}ms`,
        value: stats.storageIngressOldestAgeMs,
        companion: stats.pendingIngressEnvelopes ?? 0,
      };
    }
    if ((stats?.backpressurePending ?? 0) > maxBackpressurePending) {
      return {
        reason: `market-data backlog exceeded ${maxBackpressurePending} events`,
        value: stats.backpressurePending,
        companion: 0,
      };
    }
    if (stats?.schedulerHealthy === false) {
      return {
        reason: "event-loop health remained below the collector safety threshold",
        value: stats.eventLoopSampleLagMs ?? 0,
        companion: stats.eventLoopSampleAgeMs ?? 0,
        stopWhileActive: true,
      };
    }
    return null;
  }

  function dbFillOf(stats) {
    if (!Number.isSafeInteger(stats?.dbSizeBytes) || stats.dbSizeBytes < 0) return null;
    const ratio = stats.dbSizeBytes / maxDbBytes;
    let level = null;
    for (const threshold of DB_CAPACITY_WARNING_LEVELS) if (ratio >= threshold) level = threshold;
    return Object.freeze({ ratio, level });
  }

  function observe(stats, observedAt = now()) {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error("collector-capacity-guard: observedAt must be a non-negative safe integer");
    }
    const dbFill = dbFillOf(stats);
    if (stats?.schedulerHealthy === false) {
      schedulerBreachStartedAt ??= observedAt;
    } else {
      schedulerBreachStartedAt = null;
    }
    const schedulerBreachDurationMs = schedulerBreachStartedAt === null
      ? 0
      : Math.max(0, observedAt - schedulerBreachStartedAt);
    const schedulerShouldStop = schedulerBreachStartedAt !== null && schedulerBreachDurationMs >= breachDurationMs;
    const state = breachState(stats);
    if (state === null) {
      lastReason = null;
      breachStartedAt = null;
      lastProgressAt = null;
      priorBreachSample = null;
      return Object.freeze({
        breached: false,
        shouldStop: schedulerShouldStop,
        breachDurationMs: 0,
        schedulerBreachDurationMs,
        reason: schedulerShouldStop ? "event-loop health remained below the collector safety threshold" : null,
        dbFill,
      });
    }
    if (state.reason !== lastReason || breachStartedAt === null) {
      breachStartedAt = observedAt;
      lastProgressAt = observedAt;
      priorBreachSample = state;
    } else if (stats?.schedulerHealthy === false && state.stopWhileActive !== true) {
      lastProgressAt = observedAt;
    } else if (priorBreachSample !== null && (
      (state.valueProgress === "higher"
        ? state.value > priorBreachSample.value
        : state.value < priorBreachSample.value) ||
      (state.companionProgress === "higher"
        ? state.companion > priorBreachSample.companion
        : state.companion < priorBreachSample.companion)
    )) {
      lastProgressAt = observedAt;
    }
    lastReason = state.reason;
    priorBreachSample = state;
    const elapsedBreachDurationMs = Math.max(0, observedAt - breachStartedAt);
    const noProgressDurationMs = Math.max(0, observedAt - lastProgressAt);
    return Object.freeze({
      breached: true,
      shouldStop: schedulerShouldStop || (state.stopWhileActive === true
        ? elapsedBreachDurationMs >= breachDurationMs
        : stats?.schedulerHealthy !== false &&
          elapsedBreachDurationMs >= breachDurationMs &&
          noProgressDurationMs >= breachDurationMs),
      breachDurationMs: elapsedBreachDurationMs,
      schedulerBreachDurationMs,
      noProgressDurationMs,
      schedulerSuspended: stats?.schedulerHealthy === false,
      breachStartedAt,
      reason: schedulerShouldStop
        ? "event-loop health remained below the collector safety threshold"
        : state.reason,
      dbFill,
    });
  }

  function getStats() {
    const sampledAt = now();
    const capacityBreachDurationMs = breachStartedAt === null
      ? 0
      : Math.max(0, sampledAt - breachStartedAt);
    return Object.freeze({
      capacityBreached: breachStartedAt !== null,
      capacityBreachDurationMs,
      capacityNoProgressDurationMs: lastProgressAt === null ? 0 : Math.max(0, sampledAt - lastProgressAt),
      capacityBreachStartedAt: breachStartedAt,
      capacityLastBreachReason: lastReason,
      schedulerBreachStartedAt,
      schedulerBreachDurationMs: schedulerBreachStartedAt === null
        ? 0
        : Math.max(0, sampledAt - schedulerBreachStartedAt),
    });
  }

  return Object.freeze({ observe, getStats });
}

module.exports = {
  createCollectorCapacityGuard,
  dbCapacityTransition,
  DB_CAPACITY_WARNING_LEVELS,
  CAPACITY_STOP_EXIT_CODE,
  DEFAULT_MAX_PENDING_WRITE_ITEMS,
  DEFAULT_MAX_PENDING_INGRESS_ENVELOPES,
  DEFAULT_MAX_OLDEST_PENDING_AGE_MS,
  DEFAULT_MAX_OLDEST_INGRESS_AGE_MS,
  DEFAULT_MAX_BACKPRESSURE_PENDING,
  DEFAULT_MAX_RAW_INGRESS_PENDING,
  DEFAULT_MAX_RAW_INGRESS_PENDING_BYTES,
  DEFAULT_MAX_OLDEST_RAW_INGRESS_AGE_MS,
  DEFAULT_BREACH_DURATION_MS,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_MAX_DB_BYTES,
};
