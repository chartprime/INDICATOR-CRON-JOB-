const { types: utilTypes } = require("node:util");
const {
  EVENT_TYPES,
  ASSET_CLASSES,
  isAllowedAssetClass,
  isAllowedEventType,
  isAllowedDxFeedSymbol,
} = require("./dxfeed-instrument-catalog");

const MAX_VALID_EPOCH_MS = 8640000000000000;
const NAN_TOKEN = "NaN";
const MAX_ORDER_V2_INDEX_LENGTH = 20;
const RECOVERY_STATES = new Set(["READY", "RECOVERING", "UNAVAILABLE"]);
const TIME_AND_SALE_TYPES = new Set(["NEW", "CORRECTION", "CANCEL"]);
const AGGRESSOR_SIDES = new Set(["BUY", "SELL", "UNDEFINED"]);

const QUOTE_ALLOWED_KEYS = [
  "eventType", "eventSymbol", "eventTime", "sequence", "timeNanoPart",
  "bidTime", "bidExchangeCode", "bidPrice", "bidSize",
  "askTime", "askExchangeCode", "askPrice", "askSize",
];
const TRADE_ALLOWED_KEYS = [
  "eventType", "eventSymbol", "eventTime", "time", "timeNanoPart", "sequence",
  "exchangeCode", "price", "change", "size", "dayId", "dayVolume", "dayTurnover",
  "tickDirection", "extendedTradingHours",
];
const ORDER_ALLOWED_KEYS = [
  "eventType", "eventSymbol", "eventTime", "eventFlags", "index", "time",
  "timeNanoPart", "sequence", "source", "action", "actionTime", "orderId",
  "auxOrderId", "price", "size", "executedSize", "count", "exchangeCode",
  "side", "scope", "tradeId", "tradePrice", "tradeSize", "marketMaker",
];
const TIMEANDSALE_ALLOWED_KEYS = [
  "eventType", "eventSymbol", "eventTime", "eventFlags", "index", "time",
  "timeNanoPart", "sequence", "exchangeCode", "price", "size", "bidPrice",
  "askPrice", "tradeThroughExempt", "exchangeSaleConditions", "aggressorSide",
  "spreadLeg", "extendedTradingHours", "validTick", "type", "tradeId",
];

const TOP_LEVEL_ALLOWED_KEYS = new Map([
  [EVENT_TYPES.QUOTE, QUOTE_ALLOWED_KEYS],
  [EVENT_TYPES.TRADE, TRADE_ALLOWED_KEYS],
  [EVENT_TYPES.ORDER, ORDER_ALLOWED_KEYS],
  [EVENT_TYPES.TIMEANDSALE, TIMEANDSALE_ALLOWED_KEYS],
]);

const WIRE_EVENT_NAME = new Map([
  [EVENT_TYPES.QUOTE, "Quote"],
  [EVENT_TYPES.TRADE, "Trade"],
  [EVENT_TYPES.ORDER, "Order"],
  [EVENT_TYPES.TIMEANDSALE, "TimeAndSale"],
]);

const REQUIRED_PAYLOAD_FIELDS = new Map([
  [
    EVENT_TYPES.QUOTE,
    ["bidPrice", "bidSize", "bidTime", "bidExchangeCode", "askPrice", "askSize", "askTime", "askExchangeCode"],
  ],
  [
    EVENT_TYPES.TRADE,
    ["price", "size", "time", "exchangeCode", "change", "dayVolume", "dayTurnover", "tickDirection", "extendedTradingHours"],
  ],
  [EVENT_TYPES.ORDER, ["time", "action", "price", "side", "scope", "source"]],
  [
    EVENT_TYPES.TIMEANDSALE,
    [
      "price", "size", "time", "timeNanoPart", "sequence", "exchangeCode",
      "extendedTradingHours", "aggressorSide", "spreadLeg", "validTick", "type",
    ],
  ],
]);
const REQUIRED_GENERIC_ORDER_ZERO_PRICE_ACTION_FIELDS = ["action", "price", "side", "scope", "source"];

function requiredGenericOrderFields(raw) {
  return ZERO_PRICE_ACTIONS.has(raw.action)
    ? REQUIRED_GENERIC_ORDER_ZERO_PRICE_ACTION_FIELDS
    : REQUIRED_PAYLOAD_FIELDS.get(EVENT_TYPES.ORDER);
}

function isUsableTimestamp(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_VALID_EPOCH_MS
  );
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isPlainDataObject(value) {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !utilTypes.isProxy(value) &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) => Object.hasOwn(descriptor, "value") && descriptor.enumerable === true,
      )
    );
  } catch {
    return false;
  }
}

function assertNormalizationContext(resolved, context) {
  if (!isPlainDataObject(resolved)) {
    throw new Error("dxfeed-event-normalizer: resolved event context must be a plain object");
  }
  if (!isAllowedAssetClass(resolved.assetClass) || !isAllowedEventType(resolved.eventType) || !isNonEmptyString(resolved.symbol)) {
    throw new Error("dxfeed-event-normalizer: resolved event context has an invalid identity");
  }
  if (resolved.assetClass === ASSET_CLASSES.FUTURE && parseFuturesVenue(resolved.symbol) === null) {
    throw new Error("dxfeed-event-normalizer: futures context must include a non-blank venue suffix");
  }
  if (!isAllowedDxFeedSymbol(resolved.symbol, resolved.assetClass)) {
    throw new Error("dxfeed-event-normalizer: resolved event context has an unsupported symbol/assetClass pair");
  }
  if (!isPlainDataObject(context)) {
    throw new Error("dxfeed-event-normalizer: normalization context must be a plain object");
  }
  if (Object.hasOwn(context, "receivedAtMs") && !isUsableTimestamp(context.receivedAtMs)) {
    throw new Error("dxfeed-event-normalizer: normalization context has an invalid receivedAtMs");
  }
  const stale = context.stale ?? false;
  const recoveryState = context.recoveryState ?? "READY";
  if (typeof stale !== "boolean" || !RECOVERY_STATES.has(recoveryState)) {
    throw new Error("dxfeed-event-normalizer: normalization context has invalid health fields");
  }
  if (recoveryState !== "READY" && stale !== true) {
    throw new Error("dxfeed-event-normalizer: non-ready recoveryState requires stale: true");
  }
  return { stale, recoveryState };
}

function isSnapshottablePrimitive(value) {
  return value === null || ["boolean", "number", "string", "undefined"].includes(typeof value);
}

function snapshotFlatFields(value, allowedKeys) {
  try {
    if (!isPlainDataObject(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const snapshot = {};
    for (const key of keys) {
      if (typeof key !== "string" || !allowedKeys.includes(key)) {
        return null;
      }
      const fieldValue = descriptors[key].value;
      if (!isSnapshottablePrimitive(fieldValue)) {
        return null;
      }
      snapshot[key] = fieldValue;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotDxFeedMessage(eventType, raw) {
  const allowedKeys = TOP_LEVEL_ALLOWED_KEYS.get(eventType);
  if (!allowedKeys) {
    return null;
  }
  return snapshotFlatFields(raw, allowedKeys);
}

function parseFuturesVenue(symbol) {
  if (typeof symbol !== "string") {
    return null;
  }
  const separatorIndex = symbol.lastIndexOf(":");
  if (separatorIndex === -1 || separatorIndex === symbol.length - 1) {
    return null;
  }
  const venue = symbol.slice(separatorIndex + 1);
  return isNonEmptyString(venue) ? venue : null;
}

function resolveVenue(assetClass, symbol) {
  return assetClass === ASSET_CLASSES.FUTURE ? parseFuturesVenue(symbol) : null;
}

function resolveEventTimeMs(eventType, raw) {
  if (eventType === EVENT_TYPES.QUOTE) {
    const bidUsable = isUsableTimestamp(raw.bidTime);
    const askUsable = isUsableTimestamp(raw.askTime);
    if (bidUsable && askUsable) {
      return Math.max(raw.bidTime, raw.askTime);
    }
    if (bidUsable) {
      return raw.bidTime;
    }
    if (askUsable) {
      return raw.askTime;
    }
    return undefined;
  }
  return isUsableTimestamp(raw.time) ? raw.time : undefined;
}

function resolveOrderSize(raw) {
  if (raw.size === NAN_TOKEN) {
    return null;
  }
  return isNonNegativeFiniteNumber(raw.size) ? raw.size : undefined;
}

function resolveOrderIdentifier(value) {
  return isSafeNonNegativeInteger(value) ? value : null;
}

function quotePayload(raw) {
  return {
    bidPrice: isPositiveFiniteNumber(raw.bidPrice) ? raw.bidPrice : undefined,
    bidSize: isNonNegativeFiniteNumber(raw.bidSize) ? raw.bidSize : undefined,
    bidTime: isUsableTimestamp(raw.bidTime) ? raw.bidTime : undefined,
    bidExchangeCode: isNonEmptyString(raw.bidExchangeCode) ? raw.bidExchangeCode : undefined,
    askPrice: isPositiveFiniteNumber(raw.askPrice) ? raw.askPrice : undefined,
    askSize: isNonNegativeFiniteNumber(raw.askSize) ? raw.askSize : undefined,
    askTime: isUsableTimestamp(raw.askTime) ? raw.askTime : undefined,
    askExchangeCode: isNonEmptyString(raw.askExchangeCode) ? raw.askExchangeCode : undefined,
  };
}

function tradePayload(raw) {
  return {
    price: isPositiveFiniteNumber(raw.price) ? raw.price : undefined,
    size: isPositiveFiniteNumber(raw.size) ? raw.size : undefined,
    time: isUsableTimestamp(raw.time) ? raw.time : undefined,
    exchangeCode: isNonEmptyString(raw.exchangeCode) ? raw.exchangeCode : undefined,
    change: isFiniteNumber(raw.change) ? raw.change : undefined,
    dayVolume: isNonNegativeFiniteNumber(raw.dayVolume) ? raw.dayVolume : undefined,
    dayTurnover: isNonNegativeFiniteNumber(raw.dayTurnover) ? raw.dayTurnover : undefined,
    tickDirection: isNonEmptyString(raw.tickDirection) ? raw.tickDirection : undefined,
    extendedTradingHours: typeof raw.extendedTradingHours === "boolean" ? raw.extendedTradingHours : undefined,
  };
}

function orderPayload(raw) {
  return {
    index: resolveOrderIdentifier(raw.index),
    time: isUsableTimestamp(raw.time) ? raw.time : undefined,
    action: isNonEmptyString(raw.action) ? raw.action : undefined,
    orderId: resolveOrderIdentifier(raw.orderId),
    price: resolveOrderV2Price(raw.price, raw.action),
    size: resolveOrderSize(raw),
    side: isNonEmptyString(raw.side) ? raw.side : undefined,
    scope: isNonEmptyString(raw.scope) ? raw.scope : undefined,
    source: isNonEmptyString(raw.source) ? raw.source : undefined,
    marketMaker: isNonEmptyString(raw.marketMaker) ? raw.marketMaker : undefined,
  };
}

const RAW_INDEX_STRING_PATTERN = /^\d+$/;

function resolveRawIndexString(rawIndexString) {
  if (
    typeof rawIndexString !== "string" ||
    rawIndexString.length > MAX_ORDER_V2_INDEX_LENGTH ||
    !RAW_INDEX_STRING_PATTERN.test(rawIndexString)
  ) {
    return undefined;
  }
  try {
    BigInt(rawIndexString);
  } catch {
    return undefined;
  }
  return rawIndexString;
}

function isSafeEventFlags(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const ZERO_PRICE_ACTIONS = new Set(["TRADE", "BUST"]);

function isValidOrderV2Price(price, action) {
  return isPositiveFiniteNumber(price) || (price === 0 && ZERO_PRICE_ACTIONS.has(action));
}

function resolveOrderV2Price(price, action) {
  const normalized = price === NAN_TOKEN && ZERO_PRICE_ACTIONS.has(action) ? 0 : price;
  return isValidOrderV2Price(normalized, action) ? normalized : undefined;
}

function orderV2Payload(raw, rawIndexString) {
  return {
    index: resolveRawIndexString(rawIndexString),
    eventFlags: isSafeEventFlags(raw.eventFlags) ? raw.eventFlags : undefined,
    time: isUsableTimestamp(raw.time) ? raw.time : undefined,
    action: isNonEmptyString(raw.action) ? raw.action : undefined,
    actionTime: isUsableTimestamp(raw.actionTime) ? raw.actionTime : undefined,
    orderId: resolveOrderIdentifier(raw.orderId),
    price: resolveOrderV2Price(raw.price, raw.action),
    size: resolveOrderSize(raw),
    side: isNonEmptyString(raw.side) ? raw.side : undefined,
    scope: isNonEmptyString(raw.scope) ? raw.scope : undefined,
    source: isNonEmptyString(raw.source) ? raw.source : undefined,
    marketMaker: isNonEmptyString(raw.marketMaker) ? raw.marketMaker : undefined,
  };
}

const REQUIRED_ORDER_V2_PAYLOAD_FIELDS = Object.freeze([
  "index", "eventFlags", "time", "action", "price", "side", "scope", "source",
]);

const REQUIRED_ORDER_V2_ZERO_PRICE_ACTION_FIELDS = Object.freeze([
  "index", "eventFlags", "action", "side", "scope", "source",
]);

const REMOVE_EVENT_FLAG = 0x02;

function isRemoveEvent(eventFlags) {
  return isSafeEventFlags(eventFlags) && (eventFlags & REMOVE_EVENT_FLAG) !== 0;
}

function requiredOrderV2PayloadFields(raw) {
  if (isRemoveEvent(raw.eventFlags)) return ["index", "eventFlags", "source"];
  if (ZERO_PRICE_ACTIONS.has(raw.action)) return REQUIRED_ORDER_V2_ZERO_PRICE_ACTION_FIELDS;
  return REQUIRED_ORDER_V2_PAYLOAD_FIELDS;
}

function timeAndSalePayload(raw) {
  return {
    price: isPositiveFiniteNumber(raw.price) ? raw.price : undefined,
    size: isPositiveFiniteNumber(raw.size) ? raw.size : undefined,
    time: isUsableTimestamp(raw.time) ? raw.time : undefined,
    timeNanoPart: isSafeNonNegativeInteger(raw.timeNanoPart) ? raw.timeNanoPart : undefined,
    sequence: isSafeNonNegativeInteger(raw.sequence) ? raw.sequence : undefined,
    exchangeCode: isNonEmptyString(raw.exchangeCode) ? raw.exchangeCode : undefined,
    extendedTradingHours: typeof raw.extendedTradingHours === "boolean" ? raw.extendedTradingHours : undefined,
    aggressorSide: AGGRESSOR_SIDES.has(raw.aggressorSide) ? raw.aggressorSide : undefined,
    spreadLeg: typeof raw.spreadLeg === "boolean" ? raw.spreadLeg : undefined,
    validTick: typeof raw.validTick === "boolean" ? raw.validTick : undefined,
    type: TIME_AND_SALE_TYPES.has(raw.type) ? raw.type : undefined,
    index: resolveOrderIdentifier(raw.index),
    tradeId: resolveOrderIdentifier(raw.tradeId),
    bidPrice: isPositiveFiniteNumber(raw.bidPrice) ? raw.bidPrice : undefined,
    askPrice: isPositiveFiniteNumber(raw.askPrice) ? raw.askPrice : undefined,
  };
}

const PAYLOAD_BUILDERS = new Map([
  [EVENT_TYPES.QUOTE, quotePayload],
  [EVENT_TYPES.TRADE, tradePayload],
  [EVENT_TYPES.ORDER, orderPayload],
  [EVENT_TYPES.TIMEANDSALE, timeAndSalePayload],
]);

function withoutUndefined(target) {
  const result = {};
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function findMissingRequiredFields(requiredFields, payload) {
  return requiredFields.filter((field) => payload[field] === undefined);
}

function degradedState(eventType, assetClass, symbol, reason, context, missingFields = []) {
  return Object.freeze({
    provider: "DXFEED",
    venue: resolveVenue(assetClass, symbol),
    assetClass,
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

function buildEnvelope({ assetClass, symbol, eventType, raw }, context, {
  payloadBuilder,
  requiredFields,
  useReceivedAtForMissingEventTime = false,
} = {}) {
  const { receivedAtMs, stale, recoveryState } = context;
  const buildPayload = payloadBuilder ?? PAYLOAD_BUILDERS.get(eventType);
  const required = requiredFields ?? REQUIRED_PAYLOAD_FIELDS.get(eventType);
  const rawPayload = buildPayload(raw);
  const cleanPayload = withoutUndefined(rawPayload);
  const missingFields = findMissingRequiredFields(required, cleanPayload);

  const resolvedEventTimeMs = resolveEventTimeMs(eventType, raw);
  let eventTimeMs;
  if (resolvedEventTimeMs === undefined) {
    if (useReceivedAtForMissingEventTime) {
      eventTimeMs = receivedAtMs;
    } else {
      missingFields.push("eventTime");
    }
  } else {
    eventTimeMs = resolvedEventTimeMs;
  }

  if (missingFields.length > 0) {
    return degradedState(eventType, assetClass, symbol, "MISSING_OR_INVALID_REQUIRED_FIELD", context, missingFields);
  }

  return Object.freeze({
    provider: "DXFEED",
    venue: resolveVenue(assetClass, symbol),
    assetClass,
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

function normalizeDxFeedEvent(resolved, context = {}) {
  const { stale, recoveryState } = assertNormalizationContext(resolved, context);
  const { assetClass, symbol, eventType, raw } = resolved;
  const receivedAtMs = context.receivedAtMs ?? Date.now();
  const resolvedContext = { receivedAtMs, stale, recoveryState };

  const snapshot = snapshotDxFeedMessage(eventType, raw);
  if (!snapshot) {
    return degradedState(eventType, assetClass, symbol, "MALFORMED_RAW_MESSAGE", resolvedContext);
  }
  if (snapshot.eventSymbol !== symbol) {
    return degradedState(eventType, assetClass, symbol, "STREAM_SYMBOL_MISMATCH", resolvedContext);
  }
  if (snapshot.eventType !== WIRE_EVENT_NAME.get(eventType)) {
    return degradedState(eventType, assetClass, symbol, "PROVIDER_EVENT_TYPE_MISMATCH", resolvedContext);
  }

  const options = eventType === EVENT_TYPES.ORDER
    ? {
        requiredFields: requiredGenericOrderFields(snapshot),
        useReceivedAtForMissingEventTime: ZERO_PRICE_ACTIONS.has(snapshot.action),
      }
    : undefined;
  return buildEnvelope({ assetClass, symbol, eventType, raw: snapshot }, resolvedContext, options);
}

function normalizeDxFeedOrderV2Event({ assetClass, symbol, raw, rawIndexString }, context = {}) {
  const { stale, recoveryState } = assertNormalizationContext({ assetClass, symbol, eventType: EVENT_TYPES.ORDER, raw }, context);
  const receivedAtMs = context.receivedAtMs ?? Date.now();
  const resolvedContext = { receivedAtMs, stale, recoveryState };

  const snapshot = snapshotDxFeedMessage(EVENT_TYPES.ORDER, raw);
  if (!snapshot) {
    return degradedState(EVENT_TYPES.ORDER, assetClass, symbol, "MALFORMED_RAW_MESSAGE", resolvedContext);
  }
  if (snapshot.eventSymbol !== symbol) {
    return degradedState(EVENT_TYPES.ORDER, assetClass, symbol, "STREAM_SYMBOL_MISMATCH", resolvedContext);
  }
  if (snapshot.eventType !== WIRE_EVENT_NAME.get(EVENT_TYPES.ORDER)) {
    return degradedState(EVENT_TYPES.ORDER, assetClass, symbol, "PROVIDER_EVENT_TYPE_MISMATCH", resolvedContext);
  }

  return buildEnvelope(
    { assetClass, symbol, eventType: EVENT_TYPES.ORDER, raw: snapshot },
    resolvedContext,
    {
      payloadBuilder: (r) => orderV2Payload(r, rawIndexString),
      requiredFields: requiredOrderV2PayloadFields(snapshot),
      useReceivedAtForMissingEventTime: isRemoveEvent(snapshot.eventFlags) || ZERO_PRICE_ACTIONS.has(snapshot.action),
    },
  );
}

module.exports = {
  normalizeDxFeedEvent,
  normalizeDxFeedOrderV2Event,
  assertNormalizationContext,
  resolveEventTimeMs,
  resolveVenue,
  parseFuturesVenue,
  isFiniteNumber,
  isPositiveFiniteNumber,
  isNonNegativeFiniteNumber,
  isSafeNonNegativeInteger,
  isValidOrderV2Price,
  isRemoveEvent,
  resolveOrderIdentifier,
};
