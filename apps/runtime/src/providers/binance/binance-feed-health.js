const { EVENT_TYPES } = require("./binance-config");

const READY = "READY";
const RECOVERING = "RECOVERING";
const UNAVAILABLE = "UNAVAILABLE";

const DEFAULT_STALE_MS = Object.freeze({
  TRADE: 30_000,
  BOOK_TICKER: 5_000,
  KLINE: 10_000,
  DEPTH: 5_000,
});

function eventKey(marketKind, symbol, eventType, interval) {
  return JSON.stringify([marketKind, symbol, eventType, interval ?? null]);
}

function routeKey(marketKind, routeName) {
  return JSON.stringify([marketKind, routeName]);
}

function defaultStaleMs(eventType, interval) {
  void interval;
  return DEFAULT_STALE_MS[eventType] ?? DEFAULT_STALE_MS.TRADE;
}

function createBinanceFeedHealthMonitor({ now = () => Date.now() } = {}) {
  const lastReceivedAtMs = new Map();
  const connectedRoutes = new Set();
  const recoveryStartedAtMs = new Map();

  function recordEvent(marketKind, symbol, eventType, interval, receivedAtMs) {
    const key = eventKey(marketKind, symbol, eventType, interval);
    lastReceivedAtMs.set(key, receivedAtMs);
    if (eventType !== EVENT_TYPES.DEPTH) {
      recoveryStartedAtMs.delete(key);
    }
  }

  function recordRouteConnected(marketKind, routeName) {
    connectedRoutes.add(routeKey(marketKind, routeName));
  }

  function recordRouteDisconnected(marketKind, routeName) {
    connectedRoutes.delete(routeKey(marketKind, routeName));
  }

  function isRouteConnected(marketKind, routeName) {
    return connectedRoutes.has(routeKey(marketKind, routeName));
  }

  function beginRecovery(marketKind, symbol, eventType, interval) {
    recoveryStartedAtMs.set(eventKey(marketKind, symbol, eventType, interval), now());
  }

  function endRecovery(marketKind, symbol, eventType, interval) {
    recoveryStartedAtMs.delete(eventKey(marketKind, symbol, eventType, interval));
  }

  function isRecovering(marketKind, symbol, eventType, interval) {
    return recoveryStartedAtMs.has(eventKey(marketKind, symbol, eventType, interval));
  }

  function computeContext({ marketKind, symbol, eventType, interval, routeConnected, nowMs, staleMs, recoveryStaleMs }) {
    const key = eventKey(marketKind, symbol, eventType, interval);
    const resolvedNowMs = Number.isInteger(nowMs) ? nowMs : now();

    if (!routeConnected) {
      return Object.freeze({ stale: true, recoveryState: UNAVAILABLE });
    }
    const recoveryStartedAt = recoveryStartedAtMs.get(key);
    if (recoveryStartedAt !== undefined) {
      const threshold = Number.isInteger(recoveryStaleMs)
        ? recoveryStaleMs
        : Number.isInteger(staleMs) ? staleMs : defaultStaleMs(eventType, interval);
      if (resolvedNowMs - recoveryStartedAt > threshold) {
        return Object.freeze({ stale: true, recoveryState: UNAVAILABLE });
      }
      return Object.freeze({ stale: true, recoveryState: RECOVERING });
    }

    const lastAtMs = lastReceivedAtMs.get(key);
    if (lastAtMs === undefined) {
      return Object.freeze({ stale: false, recoveryState: READY });
    }

    const threshold = Number.isInteger(staleMs) ? staleMs : defaultStaleMs(eventType, interval);
    const stale = resolvedNowMs - lastAtMs > threshold;
    return Object.freeze({ stale, recoveryState: READY });
  }

  return Object.freeze({
    recordEvent,
    recordRouteConnected,
    recordRouteDisconnected,
    isRouteConnected,
    beginRecovery,
    endRecovery,
    isRecovering,
    computeContext,
  });
}

module.exports = {
  createBinanceFeedHealthMonitor,
  defaultStaleMs,
};
