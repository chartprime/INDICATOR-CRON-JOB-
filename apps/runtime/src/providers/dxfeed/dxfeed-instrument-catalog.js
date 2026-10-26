const marketInstrumentCatalog = require("../../../../../config/market-instruments.json");

const ASSET_CLASSES = Object.freeze({ FUTURE: "FUTURE", EQUITY: "EQUITY" });
const EVENT_TYPES = Object.freeze({ QUOTE: "QUOTE", TRADE: "TRADE", ORDER: "ORDER", TIMEANDSALE: "TIMEANDSALE" });

const ALLOWED_ASSET_CLASSES = new Set(Object.values(ASSET_CLASSES));
const ALLOWED_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

const FUTURES_SYMBOL_PATTERN = /^(\/[A-Z]{2,3})[FGHJKMNQUVXZ]\d{2}:[A-Z]+$/;

function isAllowedAssetClass(assetClass) {
  return ALLOWED_ASSET_CLASSES.has(assetClass);
}

function isAllowedEventType(eventType) {
  return ALLOWED_EVENT_TYPES.has(eventType);
}

function listAllowedAssetClasses() {
  return Object.freeze([...ALLOWED_ASSET_CLASSES]);
}

function listAllowedEventTypes() {
  return Object.freeze([...ALLOWED_EVENT_TYPES]);
}

function futuresRootOf(symbol) {
  if (typeof symbol !== "string") {
    return null;
  }
  const match = symbol.match(FUTURES_SYMBOL_PATTERN);
  return match ? match[1] : null;
}

if (marketInstrumentCatalog.version !== 1 || !Array.isArray(marketInstrumentCatalog.dxfeed)) {
  throw new Error("dxfeed-config: invalid market instrument catalog");
}

const COLLECTOR_INSTRUMENTS = Object.freeze(marketInstrumentCatalog.dxfeed.map((entry) => {
  if (
    !ALLOWED_ASSET_CLASSES.has(entry.assetClass) ||
    typeof entry.label !== "string" ||
    entry.label.length === 0 ||
    typeof entry.symbol !== "string" ||
    typeof entry.orderSource !== "string" ||
    entry.orderSource.length === 0 ||
    typeof entry.tickSize !== "number" ||
    !Number.isFinite(entry.tickSize) ||
    entry.tickSize <= 0
  ) {
    throw new Error("dxfeed-config: invalid dxFeed catalog entry");
  }
  const expectedGroup = entry.assetClass === ASSET_CLASSES.FUTURE ? "Futures" : "Equities";
  if (entry.group !== expectedGroup) throw new Error("dxfeed-config: catalog group/assetClass mismatch");
  if (entry.assetClass === ASSET_CLASSES.FUTURE && futuresRootOf(entry.symbol) === null) {
    throw new Error("dxfeed-config: invalid futures catalog symbol");
  }
  if (entry.assetClass === ASSET_CLASSES.EQUITY && !/^[A-Z][A-Z0-9.]{0,15}$/.test(entry.symbol)) {
    throw new Error("dxfeed-config: invalid equity catalog symbol");
  }
  return Object.freeze({
    assetClass: entry.assetClass,
    symbol: entry.symbol,
    orderSource: entry.orderSource,
    tickSize: entry.tickSize,
  });
}));
if (COLLECTOR_INSTRUMENTS.length === 0) throw new Error("dxfeed-config: dxFeed catalog must not be empty");
const collectorIdentities = new Set();
for (const entry of COLLECTOR_INSTRUMENTS) {
  const identity = `${entry.assetClass}:${entry.symbol}`;
  if (collectorIdentities.has(identity)) throw new Error(`dxfeed-config: duplicate dxFeed catalog identity ${identity}`);
  collectorIdentities.add(identity);
}

const FUTURES_ROOTS = new Set(COLLECTOR_INSTRUMENTS
  .filter((entry) => entry.assetClass === ASSET_CLASSES.FUTURE)
  .map((entry) => futuresRootOf(entry.symbol)));
const EQUITY_SYMBOLS = new Set(COLLECTOR_INSTRUMENTS
  .filter((entry) => entry.assetClass === ASSET_CLASSES.EQUITY)
  .map((entry) => entry.symbol));

function isAllowedDxFeedSymbol(symbol, assetClass) {
  if (assetClass === ASSET_CLASSES.EQUITY) {
    return typeof symbol === "string" && EQUITY_SYMBOLS.has(symbol);
  }
  if (assetClass === ASSET_CLASSES.FUTURE) {
    const root = futuresRootOf(symbol);
    return root !== null && FUTURES_ROOTS.has(root);
  }
  return false;
}

function listAllowedFuturesRoots() {
  return Object.freeze([...FUTURES_ROOTS]);
}

function listAllowedEquitySymbols() {
  return Object.freeze([...EQUITY_SYMBOLS]);
}

const WIRE_TO_CANONICAL_EVENT_TYPE = Object.freeze({
  Quote: EVENT_TYPES.QUOTE,
  Trade: EVENT_TYPES.TRADE,
  Order: EVENT_TYPES.ORDER,
  TimeAndSale: EVENT_TYPES.TIMEANDSALE,
});

function listCollectorInstruments() {
  return COLLECTOR_INSTRUMENTS;
}

function collectorCellKey(symbol, wireEventType) {
  return `${symbol}|${wireEventType}`;
}

function buildCollectorSubscriptionEntries({ nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("dxfeed-config: nowMs must be a non-negative safe integer");
  const candleFromTime = Math.floor(nowMs / 60_000) * 60_000 - 60_000;
  const entries = [];
  for (const { symbol, orderSource } of COLLECTOR_INSTRUMENTS) {
    entries.push({ symbol, type: "Quote" });
    entries.push({ symbol, type: "Trade" });
    entries.push({ symbol, type: "Order", source: orderSource });
    entries.push({ symbol, type: "TimeAndSale" });
    entries.push({ symbol: `${symbol}{=m}`, type: "Candle", fromTime: Math.max(0, candleFromTime) });
  }
  return entries;
}

function buildCollectorContextIndex() {
  const index = new Map();
  for (const { assetClass, symbol, orderSource } of COLLECTOR_INSTRUMENTS) {
    for (const [wireEventType, eventType] of Object.entries(WIRE_TO_CANONICAL_EVENT_TYPE)) {
      index.set(collectorCellKey(symbol, wireEventType), {
        assetClass,
        symbol,
        eventType,
        source: wireEventType === "Order" ? orderSource : undefined,
      });
    }
    index.set(collectorCellKey(`${symbol}{=m}`, "Candle"), {
      assetClass,
      symbol,
      eventType: "CANDLE",
      nativeCandle: true,
    });
  }
  return index;
}

function findCollectorInstrumentByEventSymbol(eventSymbol) {
  return COLLECTOR_INSTRUMENTS.find((instrument) => instrument.symbol === eventSymbol);
}

function tickSizeFor(assetClass, symbol) {
  const requestedRoot = assetClass === ASSET_CLASSES.FUTURE ? futuresRootOf(symbol) : null;
  const instrument = COLLECTOR_INSTRUMENTS.find((entry) => (
    entry.assetClass === assetClass &&
    (entry.symbol === symbol || (requestedRoot !== null && futuresRootOf(entry.symbol) === requestedRoot))
  ));
  return instrument ? instrument.tickSize : null;
}

function orderSourceFor(assetClass, symbol) {
  const requestedRoot = assetClass === ASSET_CLASSES.FUTURE ? futuresRootOf(symbol) : null;
  const instrument = COLLECTOR_INSTRUMENTS.find((entry) => (
    entry.assetClass === assetClass &&
    (entry.symbol === symbol || (requestedRoot !== null && futuresRootOf(entry.symbol) === requestedRoot))
  ));
  return instrument?.orderSource ?? null;
}

module.exports = {
  ASSET_CLASSES,
  EVENT_TYPES,
  isAllowedAssetClass,
  isAllowedEventType,
  listAllowedAssetClasses,
  listAllowedEventTypes,
  futuresRootOf,
  isAllowedDxFeedSymbol,
  listAllowedFuturesRoots,
  listAllowedEquitySymbols,
  WIRE_TO_CANONICAL_EVENT_TYPE,
  listCollectorInstruments,
  collectorCellKey,
  buildCollectorSubscriptionEntries,
  buildCollectorContextIndex,
  findCollectorInstrumentByEventSymbol,
  tickSizeFor,
  orderSourceFor,
};
