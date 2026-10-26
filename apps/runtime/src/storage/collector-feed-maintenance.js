const {
  EVENT_TYPES,
  listAllowedSymbols,
  listAllowedMarketKinds,
} = require("../providers/binance/binance-config");

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_CONSECUTIVE_STALE_OBSERVATIONS = 2;
const DEFAULT_RECOVERY_COOLDOWN_MS = 30_000;
const KLINE_INTERVAL = "1m";

function listCollectorSubscriptions() {
  const requests = [];
  for (const marketKind of listAllowedMarketKinds()) {
    for (const symbol of listAllowedSymbols()) {
      requests.push(
        Object.freeze({ symbol, marketKind, eventType: EVENT_TYPES.TRADE }),
        Object.freeze({ symbol, marketKind, eventType: EVENT_TYPES.KLINE, interval: KLINE_INTERVAL }),
        Object.freeze({ symbol, marketKind, eventType: EVENT_TYPES.DEPTH }),
      );
    }
  }
  return Object.freeze(requests);
}

function requestKey(request) {
  return JSON.stringify([request.marketKind, request.symbol, request.eventType, request.interval ?? null]);
}

function createCollectorFeedMaintenance({
  connection,
  intervalMs = DEFAULT_INTERVAL_MS,
  consecutiveStaleObservations = DEFAULT_CONSECUTIVE_STALE_OBSERVATIONS,
  recoveryCooldownMs = DEFAULT_RECOVERY_COOLDOWN_MS,
  now = () => Date.now(),
  shouldRecover = () => true,
  onError = null,
} = {}) {
  if (
    !connection ||
    typeof connection.getFeedHealth !== "function" ||
    typeof connection.recoverStaleSubscription !== "function"
  ) {
    throw new Error("collector-feed-maintenance: connection must expose getFeedHealth() and recoverStaleSubscription()");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("collector-feed-maintenance: intervalMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(consecutiveStaleObservations) || consecutiveStaleObservations <= 0) {
    throw new Error("collector-feed-maintenance: consecutiveStaleObservations must be a positive safe integer");
  }
  if (!Number.isSafeInteger(recoveryCooldownMs) || recoveryCooldownMs <= 0) {
    throw new Error("collector-feed-maintenance: recoveryCooldownMs must be a positive safe integer");
  }
  if (typeof now !== "function") {
    throw new Error("collector-feed-maintenance: now must be a function");
  }
  if (typeof shouldRecover !== "function") {
    throw new Error("collector-feed-maintenance: shouldRecover must be a function");
  }
  if (onError !== null && typeof onError !== "function") {
    throw new Error("collector-feed-maintenance: onError must be a function when provided");
  }

  const requests = listCollectorSubscriptions();
  let timer = null;
  const staleObservationCount = new Map();
  const lastRecoveryAt = new Map();

  function reportError(error, request = null) {
    const reported = error instanceof Error ? error : new Error(String(error));
    if (request !== null && reported.request === undefined) {
      try {
        reported.request = request;
      } catch {
        void 0;
      }
    }
    if (onError === null) {
      console.error("collector-feed-maintenance: check failed", reported.message);
      return;
    }
    try {
      onError(reported);
    } catch (callbackError) {
      console.error("collector-feed-maintenance: error callback failed", callbackError?.message ?? callbackError);
    }
  }

  function runOnce() {
    try {
      if (!shouldRecover()) {
        staleObservationCount.clear();
        return null;
      }
    } catch (error) {
      reportError(error);
      return null;
    }
    for (const request of requests) {
      try {
        const health = connection.getFeedHealth(
          request.marketKind,
          request.symbol,
          request.eventType,
          request.interval,
        );
        const key = requestKey(request);
        if (health?.stale !== true || health.recoveryState === "RECOVERING") {
          staleObservationCount.delete(key);
          continue;
        }
        const observations = (staleObservationCount.get(key) ?? 0) + 1;
        staleObservationCount.set(key, observations);
        if (observations < consecutiveStaleObservations) continue;
        const currentTime = now();
        const previousRecoveryAt = lastRecoveryAt.get(key);
        if (previousRecoveryAt !== undefined && currentTime - previousRecoveryAt < recoveryCooldownMs) continue;
        if (connection.recoverStaleSubscription(request, { automatic: true })) {
          staleObservationCount.delete(key);
          lastRecoveryAt.set(key, currentTime);
          return request;
        }
      } catch (error) {
        staleObservationCount.delete(requestKey(request));
        reportError(error, request);
      }
    }
    return null;
  }

  function start() {
    if (timer) return;
    timer = setInterval(runOnce, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ start, stop, runOnce });
}

module.exports = {
  createCollectorFeedMaintenance,
  listCollectorSubscriptions,
  DEFAULT_INTERVAL_MS,
  DEFAULT_CONSECUTIVE_STALE_OBSERVATIONS,
  DEFAULT_RECOVERY_COOLDOWN_MS,
  KLINE_INTERVAL,
};
