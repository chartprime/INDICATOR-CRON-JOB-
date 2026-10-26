const { types: utilTypes } = require("node:util");
const {
  EVENT_TYPES,
  MARKET_KINDS,
  candleIntervalMsFor,
  isAllowedSymbol,
  isAllowedMarketKind,
  isAllowedEventType,
  isAllowedCandleInterval,
} = require("./binance-config");
const { assessLiveEventTime } = require("../shared/live-event-time-policy");

const PRICE_STRING_PATTERN = /^\d+(\.\d+)?$/;
const MAX_DECIMAL_STRING_LENGTH = 1024;
const MAX_VALID_EPOCH_MS = 8640000000000000;
const MAX_DEPTH_ENTRIES = 5000;
const RECOVERY_STATES = new Set(["READY", "RECOVERING", "UNAVAILABLE"]);
const RESOLVED_CONTEXT_KEYS = new Set(["marketKind", "symbol", "eventType", "interval", "raw"]);
const NORMALIZATION_CONTEXT_KEYS = new Set(["receivedAtMs", "stale", "recoveryState"]);

const TRADE_ALLOWED_KEYS = ["e", "E", "T", "s", "t", "p", "q", "X", "m", "st", "M"];
const BOOK_TICKER_ALLOWED_KEYS = ["e", "u", "s", "ps", "b", "B", "a", "A", "T", "E", "st"];
const KLINE_ALLOWED_KEYS = ["e", "E", "s", "k"];
const KLINE_K_ALLOWED_KEYS = ["t", "T", "s", "i", "f", "L", "o", "c", "h", "l", "v", "n", "x", "q", "V", "Q", "B"];
const DEPTH_ALLOWED_KEYS = ["e", "E", "T", "s", "ps", "U", "u", "pu", "b", "a", "st"];

const TOP_LEVEL_ALLOWED_KEYS = new Map([
  [EVENT_TYPES.TRADE, TRADE_ALLOWED_KEYS],
  [EVENT_TYPES.BOOK_TICKER, BOOK_TICKER_ALLOWED_KEYS],
  [EVENT_TYPES.KLINE, KLINE_ALLOWED_KEYS],
  [EVENT_TYPES.DEPTH, DEPTH_ALLOWED_KEYS],
]);

const WIRE_EVENT_NAME = new Map([
  [EVENT_TYPES.TRADE, "trade"],
  [EVENT_TYPES.BOOK_TICKER, "bookTicker"],
  [EVENT_TYPES.KLINE, "kline"],
  [EVENT_TYPES.DEPTH, "depthUpdate"],
]);

const REQUIRED_PAYLOAD_FIELDS = new Map([
  [EVENT_TYPES.TRADE, ["tradeId", "price", "quantity", "isBuyerMaker"]],
  [
    EVENT_TYPES.BOOK_TICKER,
    ["updateId", "bestBidPrice", "bestBidQuantity", "bestAskPrice", "bestAskQuantity"],
  ],
  [
    EVENT_TYPES.KLINE,
    [
      "interval",
      "openTime",
      "closeTime",
      "open",
      "close",
      "high",
      "low",
      "baseVolume",
      "quoteVolume",
      "takerBuyBaseVolume",
      "takerBuyQuoteVolume",
      "numberOfTrades",
      "isClosed",
    ],
  ],
  [EVENT_TYPES.DEPTH, ["firstUpdateId", "lastUpdateId", "bids", "asks"]],
]);

function isUsableTimestamp(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_VALID_EPOCH_MS
  );
}

function isPlainOwnDataObject(value, allowedKeys) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).every(
      (key) =>
        typeof key === "string" &&
        allowedKeys.has(key) &&
        Object.hasOwn(descriptors[key], "value") &&
        descriptors[key].enumerable === true,
    );
  } catch {
    return false;
  }
}

function assertNormalizationContext(resolved, context) {
  if (!isPlainOwnDataObject(resolved, RESOLVED_CONTEXT_KEYS)) {
    throw new Error("binance-event-normalizer: resolved event context must be a plain own-data object");
  }
  const { marketKind, symbol, eventType, interval } = resolved;
  if (!isAllowedMarketKind(marketKind) || !isAllowedSymbol(symbol) || !isAllowedEventType(eventType)) {
    throw new Error("binance-event-normalizer: resolved event context has an invalid identity");
  }
  if (
    (eventType === EVENT_TYPES.KLINE && !isAllowedCandleInterval(interval)) ||
    (eventType !== EVENT_TYPES.KLINE && interval !== undefined)
  ) {
    throw new Error("binance-event-normalizer: resolved event context has an invalid interval");
  }
  if (!isPlainOwnDataObject(context, NORMALIZATION_CONTEXT_KEYS)) {
    throw new Error("binance-event-normalizer: normalization context must be a plain own-data object");
  }
  if (Object.hasOwn(context, "receivedAtMs") && !isUsableTimestamp(context.receivedAtMs)) {
    throw new Error("binance-event-normalizer: normalization context has an invalid receivedAtMs");
  }
  const stale = context.stale ?? false;
  const recoveryState = context.recoveryState ?? "READY";
  if (typeof stale !== "boolean" || !RECOVERY_STATES.has(recoveryState)) {
    throw new Error("binance-event-normalizer: normalization context has invalid health fields");
  }
  if (recoveryState !== "READY" && stale !== true) {
    throw new Error("binance-event-normalizer: non-ready recoveryState requires stale: true");
  }
  return Object.freeze({
    receivedAtMs: context.receivedAtMs ?? Date.now(),
    stale,
    recoveryState,
  });
}

function isValidDecimalString(value) {
  return typeof value === "string" && value.length <= MAX_DECIMAL_STRING_LENGTH && PRICE_STRING_PATTERN.test(value);
}

function isPositiveDecimalString(value) {
  return isValidDecimalString(value) && compareDecimalStrings(value, "0") > 0;
}

function compareDecimalStrings(a, b) {
  const [aInt, aFrac = ""] = a.split(".");
  const [bInt, bFrac = ""] = b.split(".");
  const aIntTrimmed = aInt.replace(/^0+(?=\d)/, "");
  const bIntTrimmed = bInt.replace(/^0+(?=\d)/, "");

  if (aIntTrimmed.length !== bIntTrimmed.length) {
    return aIntTrimmed.length > bIntTrimmed.length ? 1 : -1;
  }
  if (aIntTrimmed !== bIntTrimmed) {
    return aIntTrimmed > bIntTrimmed ? 1 : -1;
  }

  const maxFracLength = Math.max(aFrac.length, bFrac.length);
  const aFracPadded = aFrac.padEnd(maxFracLength, "0");
  const bFracPadded = bFrac.padEnd(maxFracLength, "0");
  if (aFracPadded === bFracPadded) {
    return 0;
  }
  return aFracPadded > bFracPadded ? 1 : -1;
}

function canonicalizeDecimalString(value) {
  const [intPart, frac = ""] = value.split(".");
  const intTrimmed = intPart.replace(/^0+(?=\d)/, "");
  const fracTrimmed = frac.replace(/0+$/, "");
  return fracTrimmed.length === 0 ? intTrimmed : `${intTrimmed}.${fracTrimmed}`;
}

function isUsableNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSnapshottablePrimitive(value) {
  return value === null || ["boolean", "number", "string", "undefined"].includes(typeof value);
}

function snapshotFlatFields(value, allowedKeys, nestedKeys = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const snapshot = {};
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !allowedKeys.includes(key) ||
      !Object.hasOwn(descriptors[key], "value") ||
      descriptors[key].enumerable !== true
    ) {
      return null;
    }
    const fieldValue = descriptors[key].value;
    if (!nestedKeys.includes(key) && !isSnapshottablePrimitive(fieldValue)) {
      return null;
    }
    snapshot[key] = fieldValue;
  }
  return snapshot;
}

function ownDataElementAt(array, index) {
  const descriptor = Object.getOwnPropertyDescriptor(array, index);
  return descriptor && Object.hasOwn(descriptor, "value") ? { value: descriptor.value } : null;
}

function snapshotTupleArray(value, maxEntries, { requirePositivePrice = false } = {}) {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > maxEntries) {
    return null;
  }
  const result = [];
  for (let i = 0; i < value.length; i += 1) {
    const entryBox = ownDataElementAt(value, i);
    if (!entryBox) {
      return null;
    }
    const entry = entryBox.value;
    if (utilTypes.isProxy(entry) || !Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const priceBox = ownDataElementAt(entry, 0);
    const quantityBox = ownDataElementAt(entry, 1);
    if (!priceBox || !quantityBox) {
      return null;
    }
    const price = priceBox.value;
    const quantity = quantityBox.value;
    if (
      !isValidDecimalString(price) ||
      !isValidDecimalString(quantity) ||
      (requirePositivePrice && compareDecimalStrings(price, "0") === 0)
    ) {
      return null;
    }
    result.push(Object.freeze([price, quantity]));
  }
  return Object.freeze(result);
}

function snapshotBinanceMessage(eventType, raw) {
  const allowedKeys = TOP_LEVEL_ALLOWED_KEYS.get(eventType);
  if (!allowedKeys) {
    return null;
  }

  if (eventType === EVENT_TYPES.KLINE) {
    const snapshot = snapshotFlatFields(raw, allowedKeys, ["k"]);
    if (!snapshot || !Object.hasOwn(snapshot, "k")) {
      return null;
    }
    const k = snapshotFlatFields(snapshot.k, KLINE_K_ALLOWED_KEYS);
    if (!k) {
      return null;
    }
    snapshot.k = k;
    return snapshot;
  }

  if (eventType === EVENT_TYPES.DEPTH) {
    const snapshot = snapshotFlatFields(raw, allowedKeys, ["b", "a"]);
    if (!snapshot) {
      return null;
    }
    if (Object.hasOwn(snapshot, "b")) {
      const bids = snapshotTupleArray(snapshot.b, MAX_DEPTH_ENTRIES, { requirePositivePrice: true });
      if (!bids) {
        return null;
      }
      snapshot.b = bids;
    }
    if (Object.hasOwn(snapshot, "a")) {
      const asks = snapshotTupleArray(snapshot.a, MAX_DEPTH_ENTRIES, { requirePositivePrice: true });
      if (!asks) {
        return null;
      }
      snapshot.a = asks;
    }
    return snapshot;
  }

  return snapshotFlatFields(raw, allowedKeys);
}

function resolveEventTimeMs(eventType, raw) {
  if (eventType === EVENT_TYPES.TRADE) {
    return isUsableTimestamp(raw.T) ? raw.T : undefined;
  }
  if (eventType === EVENT_TYPES.BOOK_TICKER) {
    if (isUsableTimestamp(raw.T)) {
      return raw.T;
    }
    if (isUsableTimestamp(raw.E)) {
      return raw.E;
    }
    const hasTimeField = Object.hasOwn(raw, "T") || Object.hasOwn(raw, "E");
    return hasTimeField ? undefined : null;
  }
  if (eventType === EVENT_TYPES.KLINE) {
    return isUsableTimestamp(raw.E) ? raw.E : undefined;
  }
  if (isUsableTimestamp(raw.T)) {
    return raw.T;
  }
  return isUsableTimestamp(raw.E) ? raw.E : undefined;
}

function tradePayload(raw) {
  return {
    tradeId: isUsableNonNegativeInteger(raw.t) ? raw.t : undefined,
    price: isPositiveDecimalString(raw.p) ? raw.p : undefined,
    quantity: isPositiveDecimalString(raw.q) ? raw.q : undefined,
    isBuyerMaker: typeof raw.m === "boolean" ? raw.m : undefined,
  };
}

function bookTickerPayload(raw) {
  return {
    updateId: isUsableNonNegativeInteger(raw.u) ? raw.u : undefined,
    bestBidPrice: isPositiveDecimalString(raw.b) ? raw.b : undefined,
    bestBidQuantity: isValidDecimalString(raw.B) ? raw.B : undefined,
    bestAskPrice: isPositiveDecimalString(raw.a) ? raw.a : undefined,
    bestAskQuantity: isValidDecimalString(raw.A) ? raw.A : undefined,
  };
}

function klinePayload(raw, interval) {
  const k = raw.k;
  if (!k || typeof k !== "object") {
    return {};
  }
  const wireInterval = typeof k.i === "string" ? k.i : undefined;
  return {
    interval: wireInterval === interval ? wireInterval : undefined,
    openTime: isUsableTimestamp(k.t) ? k.t : undefined,
    closeTime: isUsableTimestamp(k.T) ? k.T : undefined,
    open: isPositiveDecimalString(k.o) ? k.o : undefined,
    close: isPositiveDecimalString(k.c) ? k.c : undefined,
    high: isPositiveDecimalString(k.h) ? k.h : undefined,
    low: isPositiveDecimalString(k.l) ? k.l : undefined,
    baseVolume: isValidDecimalString(k.v) ? k.v : undefined,
    quoteVolume: isValidDecimalString(k.q) ? k.q : undefined,
    takerBuyBaseVolume: isValidDecimalString(k.V) ? k.V : undefined,
    takerBuyQuoteVolume: isValidDecimalString(k.Q) ? k.Q : undefined,
    numberOfTrades: isUsableNonNegativeInteger(k.n) ? k.n : undefined,
    isClosed: typeof k.x === "boolean" ? k.x : undefined,
  };
}

function depthPayload(raw, marketKind) {
  return {
    firstUpdateId: isUsableNonNegativeInteger(raw.U) ? raw.U : undefined,
    lastUpdateId: isUsableNonNegativeInteger(raw.u) ? raw.u : undefined,
    previousUpdateId:
      marketKind === MARKET_KINDS.PERPETUAL
        ? (isUsableNonNegativeInteger(raw.pu) ? raw.pu : undefined)
        : null,
    bids: Array.isArray(raw.b) ? Object.freeze(raw.b) : undefined,
    asks: Array.isArray(raw.a) ? Object.freeze(raw.a) : undefined,
  };
}

const PAYLOAD_BUILDERS = new Map([
  [EVENT_TYPES.TRADE, tradePayload],
  [EVENT_TYPES.BOOK_TICKER, bookTickerPayload],
]);

function buildPayloadFor(eventType, marketKind, raw, interval) {
  if (eventType === EVENT_TYPES.DEPTH) {
    return depthPayload(raw, marketKind);
  }
  if (eventType === EVENT_TYPES.KLINE) {
    return klinePayload(raw, interval);
  }
  return PAYLOAD_BUILDERS.get(eventType)(raw);
}

function withoutUndefined(target) {
  const result = {};
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function findMissingRequiredFields(eventType, marketKind, payload) {
  const missing = REQUIRED_PAYLOAD_FIELDS.get(eventType).filter(
    (field) => payload[field] === undefined,
  );
  if (
    eventType === EVENT_TYPES.DEPTH &&
    marketKind === MARKET_KINDS.PERPETUAL &&
    payload.previousUpdateId === undefined
  ) {
    missing.push("previousUpdateId");
  }
  return missing;
}

function isValidKlineTimeRange(openTime, closeTime, interval) {
  const intervalMs = candleIntervalMsFor(interval);
  return (
    Number.isInteger(intervalMs) &&
    openTime % intervalMs === 0 &&
    closeTime > openTime &&
    closeTime - openTime + 1 === intervalMs
  );
}

function isValidKlineOhlcRange({ open, high, low, close }) {
  return (
    compareDecimalStrings(high, low) >= 0 &&
    compareDecimalStrings(high, open) >= 0 &&
    compareDecimalStrings(high, close) >= 0 &&
    compareDecimalStrings(low, open) <= 0 &&
    compareDecimalStrings(low, close) <= 0
  );
}

function isValidKlineVolumeRange({ baseVolume, quoteVolume, takerBuyBaseVolume, takerBuyQuoteVolume }) {
  return (
    compareDecimalStrings(takerBuyBaseVolume, baseVolume) <= 0 &&
    compareDecimalStrings(takerBuyQuoteVolume, quoteVolume) <= 0
  );
}

function degradedState(eventType, marketKind, symbol, reason, context, missingFields = []) {
  return Object.freeze({
    provider: "BINANCE",
    venue: "BINANCE",
    marketKind,
    providerSymbol: symbol,
    eventType,
    receivedAt: new Date(context.receivedAtMs).toISOString(),
    timingClass: "REALTIME",
    stale: context.stale,
    recoveryState: context.recoveryState,
    state: "UNAVAILABLE",
    reason,
    missingFields: Object.freeze([...missingFields]),
  });
}

function buildEnvelope(
  { marketKind, symbol, eventType, interval, raw },
  context,
) {
  const { receivedAtMs, stale, recoveryState } = context;
  if (
    eventType === EVENT_TYPES.KLINE &&
    typeof raw.k?.i === "string" &&
    interval !== undefined &&
    raw.k.i !== interval
  ) {
    return degradedState(eventType, marketKind, symbol, "INTERVAL_MISMATCH", context);
  }

  if (
    eventType === EVENT_TYPES.KLINE &&
    typeof raw.k?.s === "string" &&
    raw.k.s !== symbol
  ) {
    return degradedState(eventType, marketKind, symbol, "STREAM_SYMBOL_MISMATCH", context);
  }

  const rawPayload = buildPayloadFor(eventType, marketKind, raw, interval);
  const cleanPayload = withoutUndefined(rawPayload);
  const missingFields = findMissingRequiredFields(eventType, marketKind, cleanPayload);

  const resolvedEventTimeMs = resolveEventTimeMs(eventType, raw);
  let eventTimeMs;
  if (resolvedEventTimeMs === null) {
    eventTimeMs = receivedAtMs;
  } else if (resolvedEventTimeMs === undefined) {
    missingFields.push("eventTime");
  } else {
    eventTimeMs = resolvedEventTimeMs;
  }

  if (missingFields.length > 0) {
    return degradedState(
      eventType,
      marketKind,
      symbol,
      "MISSING_OR_INVALID_REQUIRED_FIELD",
      context,
      missingFields,
    );
  }

  const eventTimeAssessment = assessLiveEventTime(eventTimeMs, receivedAtMs);
  if (!eventTimeAssessment.ok) {
    return degradedState(eventType, marketKind, symbol, eventTimeAssessment.reason, context);
  }

  if (
    eventType === EVENT_TYPES.DEPTH &&
    cleanPayload.lastUpdateId < cleanPayload.firstUpdateId
  ) {
    return degradedState(eventType, marketKind, symbol, "UPDATE_ID_RANGE_INVALID", context);
  }

  if (
    eventType === EVENT_TYPES.KLINE &&
    !isValidKlineTimeRange(cleanPayload.openTime, cleanPayload.closeTime, cleanPayload.interval)
  ) {
    return degradedState(eventType, marketKind, symbol, "KLINE_TIME_RANGE_INVALID", context);
  }

  if (eventType === EVENT_TYPES.KLINE) {
    const barTimeAssessment = assessLiveEventTime(cleanPayload.openTime, receivedAtMs);
    if (!barTimeAssessment.ok) {
      return degradedState(eventType, marketKind, symbol, barTimeAssessment.reason, context);
    }
  }

  if (
    eventType === EVENT_TYPES.KLINE &&
    !isValidKlineOhlcRange(cleanPayload)
  ) {
    return degradedState(eventType, marketKind, symbol, "KLINE_OHLC_RANGE_INVALID", context);
  }

  if (eventType === EVENT_TYPES.KLINE && !isValidKlineVolumeRange(cleanPayload)) {
    return degradedState(eventType, marketKind, symbol, "KLINE_VOLUME_RANGE_INVALID", context);
  }

  return Object.freeze({
    provider: "BINANCE",
    venue: "BINANCE",
    marketKind,
    providerSymbol: symbol,
    eventType,
    eventTime: new Date(eventTimeMs).toISOString(),
    receivedAt: new Date(receivedAtMs).toISOString(),
    timingClass: "REALTIME",
    stale,
    recoveryState,
    payload: Object.freeze(cleanPayload),
  });
}

const KLINE_ROW_LENGTH = 12;

function parseKlineRows(rawRows, intervalMs) {
  if (utilTypes.isProxy(rawRows) || !Array.isArray(rawRows)) {
    return null;
  }
  if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs <= 0)) {
    return null;
  }
  const rows = [];
  let previousOpenTime;
  for (let i = 0; i < rawRows.length; i += 1) {
    const rowBox = ownDataElementAt(rawRows, i);
    if (!rowBox) {
      return null;
    }
    const row = rowBox.value;
    if (utilTypes.isProxy(row) || !Array.isArray(row) || row.length !== KLINE_ROW_LENGTH) {
      return null;
    }

    const openTimeBox = ownDataElementAt(row, 0);
    const openBox = ownDataElementAt(row, 1);
    const highBox = ownDataElementAt(row, 2);
    const lowBox = ownDataElementAt(row, 3);
    const closeBox = ownDataElementAt(row, 4);
    const volumeBox = ownDataElementAt(row, 5);
    const closeTimeBox = ownDataElementAt(row, 6);
    const quoteVolumeBox = ownDataElementAt(row, 7);
    const numberOfTradesBox = ownDataElementAt(row, 8);
    const takerBuyBaseVolumeBox = ownDataElementAt(row, 9);
    const takerBuyQuoteVolumeBox = ownDataElementAt(row, 10);
    const ignoreBox = ownDataElementAt(row, 11);
    if (
      !openTimeBox ||
      !openBox ||
      !highBox ||
      !lowBox ||
      !closeBox ||
      !volumeBox ||
      !closeTimeBox ||
      !quoteVolumeBox ||
      !numberOfTradesBox ||
      !takerBuyBaseVolumeBox ||
      !takerBuyQuoteVolumeBox ||
      !ignoreBox
    ) {
      return null;
    }

    const openTime = openTimeBox.value;
    const open = openBox.value;
    const high = highBox.value;
    const low = lowBox.value;
    const close = closeBox.value;
    const volume = volumeBox.value;
    const closeTime = closeTimeBox.value;
    const quoteVolume = quoteVolumeBox.value;
    const numberOfTrades = numberOfTradesBox.value;
    const takerBuyBaseVolume = takerBuyBaseVolumeBox.value;
    const takerBuyQuoteVolume = takerBuyQuoteVolumeBox.value;

    if (
      !isUsableTimestamp(openTime) ||
      !isUsableTimestamp(closeTime) ||
      !isPositiveDecimalString(open) ||
      !isPositiveDecimalString(high) ||
      !isPositiveDecimalString(low) ||
      !isPositiveDecimalString(close) ||
      !isValidDecimalString(volume) ||
      !isValidDecimalString(quoteVolume) ||
      !isValidDecimalString(takerBuyBaseVolume) ||
      !isValidDecimalString(takerBuyQuoteVolume) ||
      compareDecimalStrings(takerBuyBaseVolume, volume) > 0 ||
      compareDecimalStrings(takerBuyQuoteVolume, quoteVolume) > 0 ||
      !isUsableNonNegativeInteger(numberOfTrades)
    ) {
      return null;
    }
    if (intervalMs !== undefined && openTime % intervalMs !== 0) {
      return null;
    }
    if (closeTime <= openTime || (intervalMs !== undefined && closeTime - openTime + 1 !== intervalMs)) {
      return null;
    }
    if (!isValidKlineOhlcRange({ open, high, low, close })) {
      return null;
    }
    if (
      previousOpenTime !== undefined &&
      (intervalMs === undefined ? openTime <= previousOpenTime : openTime - previousOpenTime !== intervalMs)
    ) {
      return null;
    }

    previousOpenTime = openTime;

    rows.push(
      Object.freeze({
        openTime,
        open,
        high,
        low,
        close,
        volume,
        closeTime,
        quoteVolume,
        numberOfTrades,
        takerBuyBaseVolume,
        takerBuyQuoteVolume,
      }),
    );
  }
  return Object.freeze(rows);
}

function normalizeBinanceEvent(resolved, context = {}) {
  const resolvedContext = assertNormalizationContext(resolved, context);
  const { marketKind, symbol, eventType, interval, raw } = resolved;

  const snapshot = snapshotBinanceMessage(eventType, raw);
  if (!snapshot) {
    return degradedState(eventType, marketKind, symbol, "MALFORMED_RAW_MESSAGE", resolvedContext);
  }
  if (snapshot.s !== symbol) {
    return degradedState(eventType, marketKind, symbol, "STREAM_SYMBOL_MISMATCH", resolvedContext);
  }
  if (snapshot.e !== undefined && snapshot.e !== WIRE_EVENT_NAME.get(eventType)) {
    return degradedState(eventType, marketKind, symbol, "PROVIDER_EVENT_TYPE_MISMATCH", resolvedContext);
  }

  return buildEnvelope(
    { marketKind, symbol, eventType, interval, raw: snapshot },
    resolvedContext,
  );
}

module.exports = {
  normalizeBinanceEvent,
  isValidDecimalString,
  compareDecimalStrings,
  canonicalizeDecimalString,
  snapshotTupleArray,
  snapshotFlatFields,
  parseKlineRows,
  MAX_DEPTH_ENTRIES,
  MAX_DECIMAL_STRING_LENGTH,
};
