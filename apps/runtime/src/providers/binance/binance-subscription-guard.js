const { types: utilTypes } = require("node:util");
const {
  EVENT_TYPES,
  isAllowedSymbol,
  isAllowedMarketKind,
  isAllowedEventType,
  isAllowedCandleInterval,
} = require("./binance-config");

const SUBSCRIPTION_FIELDS = Object.freeze(["symbol", "marketKind", "eventType", "interval"]);

function categoryFor(value) {
  return value === undefined ? "missing" : "unrecognized";
}

function assertAllowedSymbol(symbol) {
  if (!isAllowedSymbol(symbol)) {
    throw new Error(`Unproven Binance symbol, subscription blocked (symbol=${categoryFor(symbol)})`);
  }
}

function assertAllowedMarketKind(marketKind) {
  if (!isAllowedMarketKind(marketKind)) {
    throw new Error(
      `Unproven Binance market kind, subscription blocked (marketKind=${categoryFor(marketKind)})`,
    );
  }
}

function assertAllowedEventType(eventType) {
  if (!isAllowedEventType(eventType)) {
    throw new Error(
      `Unproven Binance event type, subscription blocked (eventType=${categoryFor(eventType)})`,
    );
  }
}

function assertAllowedInterval(interval) {
  if (!isAllowedCandleInterval(interval)) {
    throw new Error(
      `Unproven Binance candle interval, subscription blocked (interval=${categoryFor(interval)})`,
    );
  }
}

function assertAllowedSubscriptionTuple({ symbol, marketKind, eventType, interval }) {
  assertAllowedSymbol(symbol);
  assertAllowedMarketKind(marketKind);
  assertAllowedEventType(eventType);
  if (eventType === EVENT_TYPES.KLINE) {
    assertAllowedInterval(interval);
    return;
  }
  if (interval !== undefined) {
    throw new Error(
      `interval is only valid for KLINE subscriptions, subscription blocked (eventType=${eventType})`,
    );
  }
}

function safeTelemetrySymbol(symbol) {
  return isAllowedSymbol(symbol) ? symbol : "[UNRECOGNIZED_SYMBOL]";
}

function safeTelemetryMarketKind(marketKind) {
  return isAllowedMarketKind(marketKind) ? marketKind : "[UNRECOGNIZED_MARKET_KIND]";
}

function safeTelemetryErrorCode(code) {
  return Number.isInteger(code) ? code : "UNRECOGNIZED_ERROR_CODE";
}

function snapshotSubscriptionInput(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const snapshot = {};
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !SUBSCRIPTION_FIELDS.includes(key) ||
      !Object.hasOwn(descriptors[key], "value") ||
      descriptors[key].enumerable !== true
    ) {
      return null;
    }
    snapshot[key] = descriptors[key].value;
  }
  return snapshot;
}

function describeBinanceSubscription(input) {
  const snapshot = snapshotSubscriptionInput(input);
  if (!snapshot) {
    throw new Error("Binance subscription request must be a plain own-data object.");
  }
  assertAllowedSubscriptionTuple(snapshot);
  return Object.freeze(
    snapshot.eventType === EVENT_TYPES.KLINE
      ? {
          symbol: snapshot.symbol,
          marketKind: snapshot.marketKind,
          eventType: snapshot.eventType,
          interval: snapshot.interval,
        }
      : { symbol: snapshot.symbol, marketKind: snapshot.marketKind, eventType: snapshot.eventType },
  );
}

module.exports = {
  assertAllowedSymbol,
  assertAllowedMarketKind,
  assertAllowedEventType,
  assertAllowedInterval,
  assertAllowedSubscriptionTuple,
  safeTelemetrySymbol,
  safeTelemetryMarketKind,
  safeTelemetryErrorCode,
  describeBinanceSubscription,
};
