const CAPTURE_QUALITY = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  INVALID: "INVALID",
});

const COLLECTOR_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  RECOVERING: "RECOVERING",
  INVALID: "INVALID",
});

const INVALIDATING_EVENTS = new Set([
  "market_data.binance_backpressure.event_dropped",
  "market_data.binance_backpressure.queue_overflow",
  "market_data.binance_raw_ingress.queue_overflow",
  "storage.record_rejected",
]);

const WINDOW_OPEN_EVENTS = new Map([
  ["market_data.binance_connection.route_disconnected", "route"],
  ["market_data.binance_connection.route_silence_timeout", "route"],
  ["market_data.binance_connection.stale_subscription_recovery_started", "subscription"],
  ["market_data.binance_connection.depth_gap_recovery_attempt", "depth"],
]);

const WINDOW_CLOSE_EVENTS = new Map([
  ["market_data.binance_connection.route_reconnect_succeeded", "route"],
  ["market_data.binance_connection.stale_subscription_recovery_succeeded", "subscription"],
  ["market_data.binance_connection.depth_gap_recovery_succeeded", "depth"],
]);

const DATA_GAP_EVENTS = new Set([
  "market_data.binance_backpressure.queue_cleared",
  "storage.trade_id_gap",
  "storage.trade_id_session_boundary_gap",
  "storage.trade_id_non_monotonic",
]);

const OPERATIONAL_DEGRADING_EVENTS = new Set([
  "market_data.binance_connection.depth_snapshot_exception",
  "market_data.binance_connection.message_rejected",
  "storage.worker.maintenance_failed",
]);

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function entryTimestamp(entry, now) {
  const parsed = typeof entry?.ts === "string" ? Date.parse(entry.ts) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : now();
}

function scopeFor(entry, kind) {
  const marketKind = typeof entry.marketKind === "string" ? entry.marketKind : "UNKNOWN";
  if (kind === "route") return `route:${marketKind}:${entry.route ?? "unknown"}`;
  if (kind === "depth") return `depth:${marketKind}:${entry.symbol ?? "unknown"}`;
  return `subscription:${marketKind}:${entry.symbol ?? "unknown"}:${entry.eventType ?? "unknown"}:${entry.interval ?? "none"}`;
}

function incidentEntry(event, at, extra = {}) {
  return Object.freeze({ event, ts: new Date(at).toISOString(), ...extra });
}

function createCollectorIntegrityMonitor({ now = () => Date.now() } = {}) {
  if (typeof now !== "function") {
    throw new Error("collector-integrity-monitor: now must be a function");
  }

  let quality = CAPTURE_QUALITY.HEALTHY;
  let incidentCount = 0;
  let firstIncidentAt = null;
  let lastIncidentAt = null;
  let droppedEvents = 0;
  let queueClearedEvents = 0;
  let routeDisconnects = 0;
  let staleRecoveries = 0;
  let depthGapRecoveries = 0;
  let recoveredWindows = 0;
  let recordedGaps = 0;
  let fatalErrors = 0;
  let operationalDegradations = 0;
  let lastRecoveryAt = null;
  let lastRecoveryDurationMs = null;
  const activeWindows = new Map();

  function markIncident(nextQuality, at) {
    incidentCount += 1;
    firstIncidentAt ??= at;
    lastIncidentAt = at;
    if (nextQuality === CAPTURE_QUALITY.INVALID) {
      quality = CAPTURE_QUALITY.INVALID;
    } else if (quality === CAPTURE_QUALITY.HEALTHY) {
      quality = CAPTURE_QUALITY.DEGRADED;
    }
  }

  function recordTelemetry(entry) {
    if (entry === null || typeof entry !== "object" || typeof entry.event !== "string") {
      return Object.freeze({ isIncident: false, incidents: Object.freeze([]), kind: null });
    }
    const at = entryTimestamp(entry, now);
    const event = entry.event;
    if (INVALIDATING_EVENTS.has(event)) {
      markIncident(CAPTURE_QUALITY.INVALID, at);
      droppedEvents += 1;
      return Object.freeze({ isIncident: true, incidents: Object.freeze([entry]), kind: "invalid", at });
    }

    const windowKind =
      event === "market_data.binance_connection.stale_subscription_recovery_started" && entry.scope === "route"
        ? "route"
        : WINDOW_OPEN_EVENTS.get(event);
    if (windowKind) {
      const scope = scopeFor(entry, windowKind);
      if (activeWindows.has(scope)) {
        return Object.freeze({ isIncident: false, incidents: Object.freeze([]), kind: "already_recovering", scope, at });
      }
      markIncident(CAPTURE_QUALITY.DEGRADED, at);
      activeWindows.set(scope, Object.freeze({ scope, kind: windowKind, event, at, entry }));
      if (event === "market_data.binance_connection.route_disconnected") routeDisconnects += 1;
      if (event === "market_data.binance_connection.stale_subscription_recovery_started") staleRecoveries += 1;
      if (event === "market_data.binance_connection.depth_gap_recovery_attempt") depthGapRecoveries += 1;
      return Object.freeze({ isIncident: true, incidents: Object.freeze([entry]), kind: "window_opened", scope, at });
    }

    const closingKind = WINDOW_CLOSE_EVENTS.get(event);
    if (closingKind) {
      const scope = scopeFor(entry, closingKind);
      const opened = activeWindows.get(scope);
      if (!opened) {
        return Object.freeze({ isIncident: false, incidents: Object.freeze([]), kind: "unmatched_recovery", scope, at });
      }
      activeWindows.delete(scope);
      const durationMs = Math.max(0, at - opened.at);
      recoveredWindows += 1;
      lastRecoveryAt = at;
      lastRecoveryDurationMs = durationMs;
      const recovery = incidentEntry("collector.integrity_window_recovered", at, {
        marketKind: entry.marketKind ?? opened.entry.marketKind,
        route: entry.route ?? opened.entry.route,
        symbol: entry.symbol ?? opened.entry.symbol,
        eventType: entry.eventType ?? opened.entry.eventType,
        scope,
        triggerEvent: opened.event,
        recoveredEvent: event,
        startedAt: opened.at,
        endedAt: at,
        durationMs,
      });
      return Object.freeze({
        isIncident: true,
        incidents: Object.freeze([recovery]),
        kind: "window_recovered",
        scope,
        at,
        durationMs,
      });
    }

    if (DATA_GAP_EVENTS.has(event)) {
      markIncident(CAPTURE_QUALITY.DEGRADED, at);
      recordedGaps += 1;
      if (event === "market_data.binance_backpressure.queue_cleared") {
        queueClearedEvents += nonNegativeInteger(entry.discardedCount);
      }
      return Object.freeze({ isIncident: true, incidents: Object.freeze([entry]), kind: "gap_recorded", at });
    }

    if (OPERATIONAL_DEGRADING_EVENTS.has(event)) {
      markIncident(CAPTURE_QUALITY.DEGRADED, at);
      operationalDegradations += 1;
      return Object.freeze({ isIncident: true, incidents: Object.freeze([entry]), kind: "operational_degraded", at });
    }

    return Object.freeze({ isIncident: false, incidents: Object.freeze([]), kind: null, at });
  }

  function recordFatalError() {
    const at = now();
    fatalErrors += 1;
    markIncident(CAPTURE_QUALITY.INVALID, at);
  }

  function getStats() {
    const sampledAt = now();
    let recoveryAgeMs = 0;
    for (const window of activeWindows.values()) recoveryAgeMs = Math.max(recoveryAgeMs, sampledAt - window.at);
    return Object.freeze({
      captureQuality: quality,
      collectorStatus: quality === CAPTURE_QUALITY.INVALID
        ? COLLECTOR_STATUS.INVALID
        : activeWindows.size > 0
          ? COLLECTOR_STATUS.RECOVERING
          : COLLECTOR_STATUS.HEALTHY,
      integrityIncidents: incidentCount,
      activeDegradedWindows: activeWindows.size,
      recoveryAgeMs: Math.max(0, recoveryAgeMs),
      recoveredWindows,
      recordedGaps,
      droppedEvents,
      queueClearedEvents,
      routeDisconnects,
      staleRecoveries,
      depthGapRecoveries,
      fatalErrors,
      operationalDegradations,
      firstIncidentAt,
      lastIncidentAt,
      lastRecoveryAt,
      lastRecoveryDurationMs,
    });
  }

  return Object.freeze({ recordTelemetry, recordFatalError, getStats });
}

module.exports = { createCollectorIntegrityMonitor, CAPTURE_QUALITY, COLLECTOR_STATUS };
