const DEFAULT_INTERVAL_MS = 60_000;

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function hasNonZeroDelta(current, previous, activityKeys) {
  const keys = activityKeys ?? Object.keys(current).filter((key) => key !== "heartbeatIntervalLagMs");
  return keys.some((key) => (current[key] ?? 0) !== (previous?.[key] ?? 0));
}

function collectSnapshot(collect) {
  const value = collect();
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.then === "function") {
    throw new Error("createCliHeartbeat: collect must return a synchronous object");
  }
  return { ...value };
}

function createCliHeartbeat({
  logger,
  collect,
  intervalMs = DEFAULT_INTERVAL_MS,
  activityKeys = null,
  isNominal = null,
  degradedReason = null,
  displayCounters = null,
} = {}) {
  if (!logger || typeof logger.heartbeat !== "function") {
    throw new Error("createCliHeartbeat: logger must expose heartbeat()");
  }
  if (typeof collect !== "function") {
    throw new Error("createCliHeartbeat: collect must be a function");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("createCliHeartbeat: intervalMs must be a positive safe integer");
  }
  if (
    activityKeys !== null &&
    (!Array.isArray(activityKeys) || activityKeys.length === 0 || activityKeys.some((key) => typeof key !== "string" || key.length === 0))
  ) {
    throw new Error("createCliHeartbeat: activityKeys must be a non-empty string array when provided");
  }
  if (isNominal !== null && typeof isNominal !== "function") {
    throw new Error("createCliHeartbeat: isNominal must be a function when provided");
  }
  if (degradedReason !== null && typeof degradedReason !== "function") {
    throw new Error("createCliHeartbeat: degradedReason must be a function when provided");
  }
  if (displayCounters !== null && typeof displayCounters !== "function") {
    throw new Error("createCliHeartbeat: displayCounters must be a function when provided");
  }

  let timer = null;
  let startedAt = null;
  let previousCounters = null;
  let lastTickAt = null;

  function reportWarning(message, error) {
    try {
      logger.warn?.(message, { reason: error?.message ?? error });
    } catch {
      void 0;
    }
  }

  function tick() {
    const now = Date.now();
    const heartbeatIntervalLagMs = lastTickAt === null ? 0 : Math.max(0, now - lastTickAt - intervalMs);
    lastTickAt = now;
    try {
      const counters = { ...collectSnapshot(collect), heartbeatIntervalLagMs };
      const nominalResult = isNominal
        ? isNominal(counters, previousCounters)
        : hasNonZeroDelta(counters, previousCounters, activityKeys);
      if (typeof nominalResult !== "boolean") {
        throw new Error("createCliHeartbeat: isNominal must return a synchronous boolean");
      }
      const nominal = nominalResult;
      const reason = nominal || degradedReason === null
        ? undefined
        : degradedReason(counters, previousCounters);
      const countersForDisplay = displayCounters === null ? counters : displayCounters(counters);
      if (
        countersForDisplay === null ||
        typeof countersForDisplay !== "object" ||
        Array.isArray(countersForDisplay) ||
        typeof countersForDisplay.then === "function"
      ) {
        throw new Error("createCliHeartbeat: displayCounters must return a synchronous object");
      }
      logger.heartbeat(formatUptime(now - startedAt), countersForDisplay, nominal, reason);
      previousCounters = counters;
    } catch (error) {
      reportWarning("heartbeat collection failed", error);
    }
  }

  function start() {
    if (timer) return;
    startedAt = Date.now();
    lastTickAt = startedAt;
    try {
      previousCounters = { ...collectSnapshot(collect), heartbeatIntervalLagMs: 0 };
    } catch (error) {
      previousCounters = null;
      reportWarning("heartbeat initialization failed", error);
    }
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return Object.freeze({ start, stop });
}

module.exports = { createCliHeartbeat, formatUptime, DEFAULT_INTERVAL_MS };
