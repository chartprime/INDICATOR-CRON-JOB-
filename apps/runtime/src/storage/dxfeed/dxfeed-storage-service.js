const { types: utilTypes } = require("node:util");
const { createDxFeedStorageDb } = require("./dxfeed-storage-db");
const { createStorageLock } = require("../storage-lock");
const {
  EVENT_TYPES,
  isAllowedAssetClass,
  isAllowedEventType,
  isAllowedDxFeedSymbol,
} = require("../../providers/dxfeed/dxfeed-instrument-catalog");

const RECOVERY_STATES = new Set(["READY", "RECOVERING", "UNAVAILABLE"]);
const DEGRADED_REASONS = new Set([
  "MALFORMED_RAW_MESSAGE",
  "STREAM_SYMBOL_MISMATCH",
  "PROVIDER_EVENT_TYPE_MISMATCH",
  "MISSING_OR_INVALID_REQUIRED_FIELD",
]);
const MAX_VALID_EPOCH_MS = 8_640_000_000_000_000;
const CANDLE_INTERVAL_MS = 60_000;
const TIME_AND_SALE_TYPES = new Set(["NEW", "CORRECTION", "CANCEL"]);
const AGGRESSOR_SIDES = new Set(["BUY", "SELL", "UNDEFINED"]);
const HEALTHY_ENVELOPE_FIELDS = [
  "provider", "venue", "assetClass", "providerSymbol", "eventType", "eventTime",
  "receivedAt", "timingClass", "stale", "recoveryState", "payload",
];
const DEGRADED_ENVELOPE_FIELDS = [
  "provider", "venue", "assetClass", "providerSymbol", "eventType", "receivedAt",
  "timingClass", "stale", "recoveryState", "state", "reason", "missingFields",
];
const PAYLOAD_FIELDS = new Map([
  [EVENT_TYPES.QUOTE, ["bidPrice", "bidSize", "bidTime", "bidExchangeCode", "askPrice", "askSize", "askTime", "askExchangeCode"]],
  [EVENT_TYPES.TRADE, ["price", "size", "time", "exchangeCode", "change", "dayVolume", "dayTurnover", "tickDirection", "extendedTradingHours"]],
  [EVENT_TYPES.ORDER, ["index", "time", "action", "orderId", "price", "size", "side", "scope", "source", "marketMaker"]],
  [EVENT_TYPES.TIMEANDSALE, [
    "price", "size", "time", "timeNanoPart", "sequence", "exchangeCode",
    "extendedTradingHours", "aggressorSide", "spreadLeg", "validTick", "type", "index", "tradeId",
    "bidPrice", "askPrice",
  ]],
]);
const ORDER_V2_PAYLOAD_FIELDS = [
  "index", "eventFlags", "time", "action", "actionTime", "orderId", "price", "size", "side", "scope", "source", "marketMaker",
];
const DEFAULT_MAX_BATCH_ENVELOPES = 2_000;

function isUsableEpochMs(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_VALID_EPOCH_MS;
}

function parseEnvelopeTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : undefined;
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isSafeOptionalIdentifier(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isPlainDataRecord(value) {
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
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => Object.hasOwn(descriptor, "value") && descriptor.enumerable === true,
    );
  } catch {
    return false;
  }
}

function hasOnlyAllowedPayloadFields(eventType, payload) {
  const allowed = PAYLOAD_FIELDS.get(eventType);
  return allowed !== undefined && Object.keys(payload).every((field) => allowed.includes(field));
}

function hasExactFields(record, fields) {
  const keys = Object.keys(record);
  return keys.length === fields.length && keys.every((field) => fields.includes(field));
}

function expectedVenue(assetClass, symbol) {
  if (assetClass === "EQUITY") return null;
  if (assetClass !== "FUTURE" || typeof symbol !== "string") return undefined;
  const separatorIndex = symbol.lastIndexOf(":");
  if (separatorIndex === -1 || separatorIndex === symbol.length - 1) return undefined;
  const venue = symbol.slice(separatorIndex + 1);
  return isNonEmptyString(venue) ? venue : undefined;
}

function hasValidPayload(eventType, payload) {
  if (!isPlainDataRecord(payload) || !hasOnlyAllowedPayloadFields(eventType, payload)) return false;
  if (eventType === EVENT_TYPES.QUOTE) {
    return (
      isPositiveFiniteNumber(payload.bidPrice) &&
      isNonNegativeFiniteNumber(payload.bidSize) &&
      isUsableEpochMs(payload.bidTime) &&
      isNonEmptyString(payload.bidExchangeCode) &&
      isPositiveFiniteNumber(payload.askPrice) &&
      isNonNegativeFiniteNumber(payload.askSize) &&
      isUsableEpochMs(payload.askTime) &&
      isNonEmptyString(payload.askExchangeCode)
    );
  }
  if (eventType === EVENT_TYPES.TRADE) {
    return (
      isPositiveFiniteNumber(payload.price) &&
      isPositiveFiniteNumber(payload.size) &&
      isUsableEpochMs(payload.time) &&
      isNonEmptyString(payload.exchangeCode) &&
      isFiniteNumber(payload.change) &&
      isNonNegativeFiniteNumber(payload.dayVolume) &&
      isNonNegativeFiniteNumber(payload.dayTurnover) &&
      isNonEmptyString(payload.tickDirection) &&
      typeof payload.extendedTradingHours === "boolean"
    );
  }
  if (eventType === EVENT_TYPES.TIMEANDSALE) {
    return (
      isPositiveFiniteNumber(payload.price) &&
      isPositiveFiniteNumber(payload.size) &&
      isUsableEpochMs(payload.time) &&
      Number.isSafeInteger(payload.timeNanoPart) && payload.timeNanoPart >= 0 &&
      Number.isSafeInteger(payload.sequence) && payload.sequence >= 0 &&
      isNonEmptyString(payload.exchangeCode) &&
      typeof payload.extendedTradingHours === "boolean" &&
      AGGRESSOR_SIDES.has(payload.aggressorSide) &&
      typeof payload.spreadLeg === "boolean" &&
      typeof payload.validTick === "boolean" &&
      TIME_AND_SALE_TYPES.has(payload.type) &&
      Object.hasOwn(payload, "index") && isSafeOptionalIdentifier(payload.index) &&
      Object.hasOwn(payload, "tradeId") && isSafeOptionalIdentifier(payload.tradeId) &&
      (payload.bidPrice === undefined || isPositiveFiniteNumber(payload.bidPrice)) &&
      (payload.askPrice === undefined || isPositiveFiniteNumber(payload.askPrice))
    );
  }
  const hasCoreGenericOrderFields = (
    Object.hasOwn(payload, "index") &&
    isSafeOptionalIdentifier(payload.index) &&
    isNonEmptyString(payload.action) &&
    Object.hasOwn(payload, "orderId") &&
    isSafeOptionalIdentifier(payload.orderId) &&
    isValidOrderV2Price(payload.price, payload.action) &&
    (payload.size === null || isNonNegativeFiniteNumber(payload.size)) &&
    isNonEmptyString(payload.side) &&
    isNonEmptyString(payload.scope) &&
    isNonEmptyString(payload.source) &&
    (payload.marketMaker === undefined || isNonEmptyString(payload.marketMaker))
  );
  if (!hasCoreGenericOrderFields) return false;
  return ZERO_PRICE_ACTIONS.has(payload.action) || isUsableEpochMs(payload.time);
}

function isBigIntIndexString(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 20) {
    return false;
  }
  try {
    BigInt(value);
  } catch {
    return false;
  }
  return true;
}

const ZERO_PRICE_ACTIONS = new Set(["TRADE", "BUST"]);
const REMOVE_EVENT_FLAG = 0x02;

function isValidOrderV2Price(price, action) {
  return isPositiveFiniteNumber(price) || (price === 0 && ZERO_PRICE_ACTIONS.has(action));
}

function isOrderV2Removal(payload) {
  return (payload.eventFlags & REMOVE_EVENT_FLAG) !== 0;
}

function hasValidOrderV2Payload(payload) {
  if (!isPlainDataRecord(payload)) return false;
  const allowed = ORDER_V2_PAYLOAD_FIELDS;
  if (!Object.keys(payload).every((field) => allowed.includes(field))) return false;
  const commonFieldsAreValid = (
    isBigIntIndexString(payload.index) &&
    Number.isSafeInteger(payload.eventFlags) && payload.eventFlags >= 0 &&
    isNonEmptyString(payload.source) &&
    (payload.time === undefined || isUsableEpochMs(payload.time)) &&
    (payload.action === undefined || isNonEmptyString(payload.action)) &&
    (payload.actionTime === undefined || isUsableEpochMs(payload.actionTime)) &&
    (payload.orderId === undefined || isSafeOptionalIdentifier(payload.orderId)) &&
    (payload.price === undefined || isValidOrderV2Price(payload.price, payload.action)) &&
    (payload.size === undefined || payload.size === null || isNonNegativeFiniteNumber(payload.size)) &&
    (payload.side === undefined || isNonEmptyString(payload.side)) &&
    (payload.scope === undefined || isNonEmptyString(payload.scope)) &&
    (payload.marketMaker === undefined || isNonEmptyString(payload.marketMaker))
  );
  if (!commonFieldsAreValid) return false;
  if (isOrderV2Removal(payload)) return true;
  const hasCoreOrderFields = (
    isNonEmptyString(payload.action) &&
    Object.hasOwn(payload, "orderId") &&
    isSafeOptionalIdentifier(payload.orderId) &&
    isValidOrderV2Price(payload.price, payload.action) &&
    (payload.size === null || isNonNegativeFiniteNumber(payload.size)) &&
    isNonEmptyString(payload.side) &&
    isNonEmptyString(payload.scope)
  );
  if (!hasCoreOrderFields) return false;
  return ZERO_PRICE_ACTIONS.has(payload.action) || isUsableEpochMs(payload.time);
}

function hasValidIdentity(envelope) {
  const venue = expectedVenue(envelope.assetClass, envelope.providerSymbol);
  return (
    envelope.provider === "DXFEED" &&
    isAllowedAssetClass(envelope.assetClass) &&
    isAllowedEventType(envelope.eventType) &&
    typeof envelope.providerSymbol === "string" &&
    envelope.providerSymbol.trim().length > 0 &&
    isAllowedDxFeedSymbol(envelope.providerSymbol, envelope.assetClass) &&
    venue !== undefined &&
    envelope.venue === venue &&
    envelope.timingClass === "REALTIME" &&
    typeof envelope.stale === "boolean" &&
    RECOVERY_STATES.has(envelope.recoveryState) &&
    (envelope.recoveryState === "READY" || envelope.stale === true)
  );
}

function isValidDegradedEnvelope(envelope) {
  const missingFieldsAreValid =
    Array.isArray(envelope.missingFields) && envelope.missingFields.every((field) => isNonEmptyString(field));
  const receivedAtMs = parseEnvelopeTimestamp(envelope.receivedAt);
  return (
    hasExactFields(envelope, DEGRADED_ENVELOPE_FIELDS) &&
    hasValidIdentity(envelope) &&
    envelope.state === "UNAVAILABLE" &&
    isUsableEpochMs(receivedAtMs) &&
    DEGRADED_REASONS.has(envelope.reason) &&
    missingFieldsAreValid &&
    (envelope.reason === "MISSING_OR_INVALID_REQUIRED_FIELD"
      ? envelope.missingFields.length > 0
      : envelope.missingFields.length === 0)
  );
}

function eventTimeMatchesPayload(eventType, payload, eventTimeMs, receivedAtMs) {
  if (eventType === EVENT_TYPES.QUOTE) {
    return eventTimeMs === Math.max(payload.bidTime, payload.askTime);
  }
  return eventTimeMs === (payload.time ?? receivedAtMs);
}

function baseRecord(envelope, eventTimeMs, receivedAtMs) {
  return {
    eventTime: eventTimeMs,
    receivedAt: receivedAtMs,
    provider: envelope.provider,
    venue: envelope.venue ?? null,
    assetClass: envelope.assetClass,
    symbol: envelope.providerSymbol,
    stale: envelope.stale ? 1 : 0,
    recoveryState: envelope.recoveryState,
  };
}

function isValidClosedBar(bar) {
  return (
    isPlainDataRecord(bar) &&
    Number.isSafeInteger(bar.ts_open) &&
    bar.ts_open >= 0 &&
    bar.ts_open % CANDLE_INTERVAL_MS === 0 &&
    isPositiveFiniteNumber(bar.open) &&
    isPositiveFiniteNumber(bar.high) &&
    isPositiveFiniteNumber(bar.low) &&
    isPositiveFiniteNumber(bar.close) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= bar.high &&
    isPositiveFiniteNumber(bar.volume) &&
    (bar.buy_volume === null || bar.buy_volume === undefined ||
      (isNonNegativeFiniteNumber(bar.buy_volume) && bar.buy_volume <= bar.volume)) &&
    (bar.sell_volume === null || bar.sell_volume === undefined ||
      (isNonNegativeFiniteNumber(bar.sell_volume) && bar.sell_volume <= bar.volume)) &&
    (bar.buy_volume === null || bar.buy_volume === undefined || bar.sell_volume === null || bar.sell_volume === undefined ||
      bar.buy_volume + bar.sell_volume <= bar.volume + 1e-9) &&
    Number.isSafeInteger(bar.trade_count) &&
    bar.trade_count > 0 &&
    bar.closed === true
  );
}

function createDxFeedStorageService({
  dbPath,
  bootstrap = dbPath === ":memory:",
  maxBatchEnvelopes = DEFAULT_MAX_BATCH_ENVELOPES,
} = {}) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new Error("dxfeed-storage-service: dbPath must be a non-empty string");
  }
  if (typeof bootstrap !== "boolean") {
    throw new Error("dxfeed-storage-service: bootstrap must be a boolean");
  }
  if (!Number.isSafeInteger(maxBatchEnvelopes) || maxBatchEnvelopes <= 0) {
    throw new Error("dxfeed-storage-service: maxBatchEnvelopes must be a positive safe integer");
  }
  let lock = null;
  if (dbPath !== ":memory:") {
    lock = createStorageLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
  }
  let storageDb;
  try {
    storageDb = createDxFeedStorageDb({ dbPath, bootstrap, verifyIntegrity: false });
  } catch (error) {
    lock?.release();
    throw error;
  }
  let closed = false;
  let captureSessionId = null;
  const counters = {
    quotes: 0, trades: 0, timeAndSales: 0, candles: 0, orderBookCapture: 0, skipped: 0, rejected: 0,
    tradeIdGaps: 0, missingTradeIds: 0, tradeIdNonMonotonic: 0, tradeIdUnavailable: 0,
  };
  const lastTradeIdByPair = new Map();

  function recordCandle(symbol, assetClass, bar, { derivation = "TIME_AND_SALE" } = {}) {
    if (closed) {
      throw new Error("dxfeed-storage-service: cannot write after close");
    }
    if (typeof symbol !== "string" || symbol.trim().length === 0) {
      throw new Error("dxfeed-storage-service: recordCandle symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-service: recordCandle assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-service: recordCandle symbol/assetClass pair is unsupported");
    }
    if (!isValidClosedBar(bar)) {
      throw new Error("dxfeed-storage-service: recordCandle bar failed validation");
    }
    if (derivation !== "TIME_AND_SALE" && derivation !== "NATIVE") {
      throw new Error("dxfeed-storage-service: recordCandle derivation is unsupported");
    }
    const venue = expectedVenue(assetClass, symbol);
    if (venue === undefined) {
      throw new Error("dxfeed-storage-service: recordCandle could not resolve a venue for this symbol/assetClass");
    }
    storageDb.insert("dxfeed_candles", {
      tsOpen: bar.ts_open,
      provider: "DXFEED",
      venue,
      assetClass,
      symbol,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      buyVolume: bar.buy_volume ?? null,
      sellVolume: bar.sell_volume ?? null,
      tradeCount: bar.trade_count,
      derivation,
    });
    counters.candles += 1;
  }

  function recordQuote(envelope, eventTimeMs, receivedAtMs) {
    const { payload } = envelope;
    storageDb.insert("dxfeed_quotes", {
      ...baseRecord(envelope, eventTimeMs, receivedAtMs),
      bidPrice: payload.bidPrice,
      bidSize: payload.bidSize,
      bidTime: payload.bidTime,
      bidExchangeCode: payload.bidExchangeCode,
      askPrice: payload.askPrice,
      askSize: payload.askSize,
      askTime: payload.askTime,
      askExchangeCode: payload.askExchangeCode,
    });
    counters.quotes += 1;
  }

  function recordTrade(envelope, eventTimeMs, receivedAtMs) {
    const { payload } = envelope;
    storageDb.insert("dxfeed_trades", {
      ...baseRecord(envelope, eventTimeMs, receivedAtMs),
      price: payload.price,
      size: payload.size,
      time: payload.time,
      exchangeCode: payload.exchangeCode,
      change: payload.change,
      dayVolume: payload.dayVolume,
      dayTurnover: payload.dayTurnover,
      tickDirection: payload.tickDirection,
      extendedTradingHours: payload.extendedTradingHours ? 1 : 0,
    });
    counters.trades += 1;
  }

  function recordOrderBookCapture(envelope, eventTimeMs, receivedAtMs) {
    const { payload } = envelope;
    storageDb.insert("dxfeed_order_book_capture", {
      ...baseRecord(envelope, eventTimeMs, receivedAtMs),
      orderIndex: payload.index,
      eventFlags: payload.eventFlags,
      time: payload.time ?? null,
      action: payload.action,
      actionTime: payload.actionTime ?? null,
      orderId: payload.orderId ?? null,
      price: payload.price ?? null,
      size: payload.size ?? null,
      side: payload.side,
      scope: payload.scope,
      source: payload.source,
      marketMaker: payload.marketMaker ?? null,
    });
    counters.orderBookCapture += 1;
  }

  function recordTradeContinuity(envelope, tradeId) {
    if (!Number.isSafeInteger(tradeId)) {
      counters.tradeIdUnavailable += 1;
      return true;
    }
    const continuityKey = `${envelope.assetClass}:${envelope.providerSymbol}`;
    const previousTradeId = lastTradeIdByPair.get(continuityKey);
    const isTradeIdAdvancing = !Number.isSafeInteger(previousTradeId) || tradeId > previousTradeId;
    if (Number.isSafeInteger(previousTradeId)) {
      if (tradeId > previousTradeId + 1) {
        counters.tradeIdGaps += 1;
        counters.missingTradeIds += tradeId - previousTradeId - 1;
      } else if (tradeId <= previousTradeId) {
        counters.tradeIdNonMonotonic += 1;
      }
    }
    if (isTradeIdAdvancing) {
      lastTradeIdByPair.set(continuityKey, tradeId);
    }
    return isTradeIdAdvancing;
  }

  function recordTimeAndSale(envelope, eventTimeMs, receivedAtMs) {
    const { payload } = envelope;
    recordTradeContinuity(envelope, payload.tradeId);

    storageDb.insert("dxfeed_time_and_sales", {
      ...baseRecord(envelope, eventTimeMs, receivedAtMs),
      price: payload.price,
      size: payload.size,
      time: payload.time,
      timeNanoPart: payload.timeNanoPart,
      sequence: payload.sequence,
      exchangeCode: payload.exchangeCode,
      extendedTradingHours: payload.extendedTradingHours ? 1 : 0,
      aggressorSide: payload.aggressorSide,
      spreadLeg: payload.spreadLeg ? 1 : 0,
      validTick: payload.validTick ? 1 : 0,
      eventKind: payload.type,
      providerIndex: payload.index,
      providerTradeId: payload.tradeId,
      bidPrice: payload.bidPrice ?? null,
      askPrice: payload.askPrice ?? null,
    });
    counters.timeAndSales += 1;
  }

  const RECORDERS = new Map([
    [EVENT_TYPES.QUOTE, recordQuote],
    [EVENT_TYPES.TRADE, recordTrade],
    [EVENT_TYPES.TIMEANDSALE, recordTimeAndSale],
  ]);

  function handleEnvelope(envelope) {
    if (closed) {
      throw new Error("dxfeed-storage-service: cannot write after close");
    }
    function reject(reason) {
      counters.rejected += 1;
      console.error(`dxfeed-storage-service: rejected ${reason}`);
    }
    if (!isPlainDataRecord(envelope)) {
      reject("a non-plain envelope");
      return false;
    }
    if (envelope.state === "UNAVAILABLE") {
      if (!isValidDegradedEnvelope(envelope)) {
        reject("an invalid degraded envelope");
        return false;
      }
      counters.skipped += 1;
      return false;
    }
    if (!hasValidIdentity(envelope)) {
      reject("an envelope with an invalid canonical identity");
      return false;
    }
    if (!hasExactFields(envelope, HEALTHY_ENVELOPE_FIELDS)) {
      reject("an envelope with an invalid canonical field set");
      return false;
    }
    const eventTimeMs = parseEnvelopeTimestamp(envelope.eventTime);
    const receivedAtMs = parseEnvelopeTimestamp(envelope.receivedAt);
    if (!isUsableEpochMs(eventTimeMs) || !isUsableEpochMs(receivedAtMs)) {
      reject("an envelope with an unparseable timestamp");
      return false;
    }
    const recorder = RECORDERS.get(envelope.eventType);
    if (!recorder) {
      reject("an envelope with an unsupported event type");
      return false;
    }
    if (!hasValidPayload(envelope.eventType, envelope.payload)) {
      reject("an envelope with an invalid canonical payload");
      return false;
    }
    if (!eventTimeMatchesPayload(envelope.eventType, envelope.payload, eventTimeMs, receivedAtMs)) {
      reject("an envelope whose eventTime disagrees with its payload");
      return false;
    }
    recorder(envelope, eventTimeMs, receivedAtMs);
    return true;
  }

  function handleEnvelopes(envelopes) {
    if (closed) {
      throw new Error("dxfeed-storage-service: cannot write after close");
    }
    if (!Array.isArray(envelopes)) {
      throw new Error("dxfeed-storage-service: envelopes must be an array");
    }
    if (envelopes.length > maxBatchEnvelopes) {
      throw new Error(`dxfeed-storage-service: envelope batch exceeds ${maxBatchEnvelopes} items`);
    }
    const countersBefore = { ...counters };
    const lastTradeIdByPairBefore = new Map(lastTradeIdByPair);
    try {
      return storageDb.transaction(() => envelopes.map((envelope) => {
        const validDegraded = envelope?.state === "UNAVAILABLE" && isValidDegradedEnvelope(envelope);
        const accepted = handleEnvelope(envelope);
        if ((!validDegraded && accepted !== true) || (validDegraded && accepted !== false)) {
          throw new Error("dxfeed-storage-service: envelope failed canonical validation");
        }
        return accepted;
      }));
    } catch (error) {
      const rejectedDuringBatch = Math.max(0, counters.rejected - countersBefore.rejected);
      Object.assign(counters, countersBefore);
      counters.rejected += rejectedDuringBatch;
      lastTradeIdByPair.clear();
      for (const [key, value] of lastTradeIdByPairBefore) lastTradeIdByPair.set(key, value);
      throw error;
    }
  }

  function handleOrderV2Envelope(envelope) {
    if (closed) {
      throw new Error("dxfeed-storage-service: cannot write after close");
    }
    function reject(reason) {
      counters.rejected += 1;
      console.error(`dxfeed-storage-service: rejected ${reason}`);
    }
    if (!isPlainDataRecord(envelope)) {
      reject("a non-plain order-book-capture envelope");
      return false;
    }
    if (envelope.state === "UNAVAILABLE") {
      if (!isValidDegradedEnvelope(envelope)) {
        reject("an invalid degraded order-book-capture envelope");
        return false;
      }
      counters.skipped += 1;
      return false;
    }
    if (envelope.eventType !== EVENT_TYPES.ORDER) {
      reject("an order-book-capture envelope with an unsupported event type");
      return false;
    }
    if (!hasValidIdentity(envelope)) {
      reject("an order-book-capture envelope with an invalid canonical identity");
      return false;
    }
    if (!hasExactFields(envelope, HEALTHY_ENVELOPE_FIELDS)) {
      reject("an order-book-capture envelope with an invalid canonical field set");
      return false;
    }
    const eventTimeMs = parseEnvelopeTimestamp(envelope.eventTime);
    const receivedAtMs = parseEnvelopeTimestamp(envelope.receivedAt);
    if (!isUsableEpochMs(eventTimeMs) || !isUsableEpochMs(receivedAtMs)) {
      reject("an order-book-capture envelope with an unparseable timestamp");
      return false;
    }
    if (!hasValidOrderV2Payload(envelope.payload)) {
      reject("an order-book-capture envelope with an invalid canonical payload");
      return false;
    }
    const expectedEventTimeMs = envelope.payload.time ?? receivedAtMs;
    if (eventTimeMs !== expectedEventTimeMs) {
      reject("an order-book-capture envelope whose eventTime disagrees with its payload");
      return false;
    }
    recordOrderBookCapture(envelope, eventTimeMs, receivedAtMs);
    return true;
  }

  function handleOrderV2Envelopes(envelopes) {
    if (closed) {
      throw new Error("dxfeed-storage-service: cannot write after close");
    }
    if (!Array.isArray(envelopes)) {
      throw new Error("dxfeed-storage-service: envelopes must be an array");
    }
    if (envelopes.length > maxBatchEnvelopes) {
      throw new Error(`dxfeed-storage-service: order-book-capture batch exceeds ${maxBatchEnvelopes} items`);
    }
    const countersBefore = { ...counters };
    try {
      return storageDb.transaction(() => envelopes.map((envelope) => {
        const validDegraded = envelope?.state === "UNAVAILABLE" && isValidDegradedEnvelope(envelope);
        const accepted = handleOrderV2Envelope(envelope);
        if ((!validDegraded && accepted !== true) || (validDegraded && accepted !== false)) {
          throw new Error("dxfeed-storage-service: order-book-capture envelope failed canonical validation");
        }
        return accepted;
      }));
    } catch (error) {
      const rejectedDuringBatch = Math.max(0, counters.rejected - countersBefore.rejected);
      Object.assign(counters, countersBefore);
      counters.rejected += rejectedDuringBatch;
      throw error;
    }
  }

  function getCounters() {
    return { ...counters };
  }

  function beginCaptureSession({ sessionId, startedAt }) {
    if (closed) throw new Error("dxfeed-storage-service: cannot begin a capture session after close");
    storageDb.beginCaptureSession({ sessionId, startedAt });
    captureSessionId = sessionId;
  }

  function getCaptureResumeState() {
    if (closed) throw new Error("dxfeed-storage-service: cannot read after close");
    return storageDb.getCaptureResumeState();
  }

  function finishCaptureSession({ endedAt, quality, cleanShutdown, terminationReason = null }) {
    if (closed) throw new Error("dxfeed-storage-service: cannot finish a capture session after close");
    if (captureSessionId === null) throw new Error("dxfeed-storage-service: no active capture session");
    storageDb.finishCaptureSession({ sessionId: captureSessionId, endedAt, quality, cleanShutdown, terminationReason });
    captureSessionId = null;
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      storageDb.close();
    } finally {
      lock?.release();
      lock = null;
    }
  }

  function getStorageDb() {
    return closed ? null : storageDb;
  }

  return Object.freeze({
    handleEnvelope, handleEnvelopes, handleOrderV2Envelope, handleOrderV2Envelopes, recordCandle, getCounters,
    beginCaptureSession, getCaptureResumeState, finishCaptureSession,
    getStorageDb, close,
  });
}

module.exports = { createDxFeedStorageService, DEFAULT_MAX_BATCH_ENVELOPES };
