const { createSubscriptionRegistry } = require("../shared/subscription-registry");
const marketInstrumentCatalog = require("../../../../../config/market-instruments.json");

const BINANCE_SPOT_WS_BASE_URL = "wss://stream.binance.com";
const BINANCE_USDM_WS_PUBLIC_BASE_URL = "wss://fstream.binance.com/public";
const BINANCE_USDM_WS_MARKET_BASE_URL = "wss://fstream.binance.com/market";
const BINANCE_SPOT_REST_BASE_URL = "https://api.binance.com";
const BINANCE_USDM_REST_BASE_URL = "https://fapi.binance.com";

const MARKET_KINDS = Object.freeze({ SPOT: "SPOT", PERPETUAL: "PERPETUAL" });
const EVENT_TYPES = Object.freeze({
  TRADE: "TRADE",
  BOOK_TICKER: "BOOK_TICKER",
  KLINE: "KLINE",
  DEPTH: "DEPTH",
});

if (marketInstrumentCatalog.version !== 1 || !Array.isArray(marketInstrumentCatalog.binance)) {
  throw new Error("binance-config: invalid market instrument catalog");
}
const catalogIdentities = new Set();
const L2_GEOMETRY = new Map();

function validL2Geometry(l2) {
  return l2 !== null && typeof l2 === "object" && !Array.isArray(l2) &&
    Object.keys(l2).every((key) => key === "clusterTicks" || key === "minSliceSize" || key === "windowPct") &&
    Number.isSafeInteger(l2.clusterTicks) && l2.clusterTicks > 0 &&
    Number.isFinite(l2.minSliceSize) && l2.minSliceSize >= 0 &&
    (l2.windowPct === undefined || (Number.isFinite(l2.windowPct) && l2.windowPct > 0 && l2.windowPct <= 100));
}

const ALLOWED_SYMBOLS = new Set(marketInstrumentCatalog.binance.map((entry) => {
  if (
    entry.group !== "Crypto" ||
    typeof entry.label !== "string" ||
    entry.label.length === 0 ||
    typeof entry.symbol !== "string" ||
    !/^[A-Z0-9]+-USDT$/.test(entry.symbol) ||
    !Object.values(MARKET_KINDS).includes(entry.marketKind) ||
    (entry.l2 !== undefined && !validL2Geometry(entry.l2))
  ) {
    throw new Error("binance-config: invalid Binance catalog entry");
  }
  const identity = `${entry.marketKind}:${entry.symbol}`;
  if (catalogIdentities.has(identity)) throw new Error(`binance-config: duplicate Binance catalog identity ${identity}`);
  catalogIdentities.add(identity);
  if (entry.l2 !== undefined) L2_GEOMETRY.set(`${entry.marketKind}:${entry.symbol.replace("-", "")}`, Object.freeze({ ...entry.l2 }));
  return entry.symbol.replace("-", "");
}));

function l2GeometryFor(marketKind, symbol) {
  return L2_GEOMETRY.get(`${marketKind}:${String(symbol).replace("-", "")}`) ?? null;
}
if (ALLOWED_SYMBOLS.size === 0) throw new Error("binance-config: Binance catalog must not be empty");
const ALLOWED_MARKET_KINDS = new Set(Object.values(MARKET_KINDS));
for (const symbol of ALLOWED_SYMBOLS) {
  const wireSymbol = symbol.replace(/USDT$/, "-USDT");
  for (const marketKind of ALLOWED_MARKET_KINDS) {
    if (!catalogIdentities.has(`${marketKind}:${wireSymbol}`)) {
      throw new Error("binance-config: catalog must cover the full symbol/market-kind cross-product");
    }
  }
}
const ALLOWED_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));
const CANDLE_INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
});
const ALLOWED_CANDLE_INTERVALS = new Set(Object.keys(CANDLE_INTERVAL_MS));

function isAllowedSymbol(symbol) {
  return ALLOWED_SYMBOLS.has(symbol);
}

function isAllowedMarketKind(marketKind) {
  return ALLOWED_MARKET_KINDS.has(marketKind);
}

function isAllowedEventType(eventType) {
  return ALLOWED_EVENT_TYPES.has(eventType);
}

function isAllowedCandleInterval(interval) {
  return ALLOWED_CANDLE_INTERVALS.has(interval);
}

function candleIntervalMsFor(interval) {
  return CANDLE_INTERVAL_MS[interval];
}

function listAllowedSymbols() {
  return Object.freeze([...ALLOWED_SYMBOLS]);
}

function listAllowedMarketKinds() {
  return Object.freeze([...ALLOWED_MARKET_KINDS]);
}

function listAllowedEventTypes() {
  return Object.freeze([...ALLOWED_EVENT_TYPES]);
}

function listAllowedCandleIntervals() {
  return Object.freeze([...ALLOWED_CANDLE_INTERVALS]);
}

function restBaseUrlFor(marketKind) {
  if (marketKind === MARKET_KINDS.SPOT) {
    return BINANCE_SPOT_REST_BASE_URL;
  }
  if (marketKind === MARKET_KINDS.PERPETUAL) {
    return BINANCE_USDM_REST_BASE_URL;
  }
  return undefined;
}

function wsBaseUrlsFor(marketKind) {
  if (marketKind === MARKET_KINDS.SPOT) {
    return Object.freeze({ public: BINANCE_SPOT_WS_BASE_URL });
  }
  if (marketKind === MARKET_KINDS.PERPETUAL) {
    return Object.freeze({
      public: BINANCE_USDM_WS_PUBLIC_BASE_URL,
      market: BINANCE_USDM_WS_MARKET_BASE_URL,
    });
  }
  return undefined;
}

function createBinanceMarketKindContext(marketKind) {
  if (!isAllowedMarketKind(marketKind)) {
    const category = marketKind === undefined ? "missing" : "unrecognized";
    throw new Error(
      `Unproven Binance market kind, context creation blocked (marketKind=${category})`,
    );
  }
  return Object.freeze({
    marketKind,
    wsBaseUrls: wsBaseUrlsFor(marketKind),
    subscriptionRegistry: createSubscriptionRegistry(),
  });
}

module.exports = {
  MARKET_KINDS,
  EVENT_TYPES,
  isAllowedSymbol,
  isAllowedMarketKind,
  isAllowedEventType,
  isAllowedCandleInterval,
  candleIntervalMsFor,
  listAllowedSymbols,
  listAllowedMarketKinds,
  listAllowedEventTypes,
  listAllowedCandleIntervals,
  restBaseUrlFor,
  wsBaseUrlsFor,
  createBinanceMarketKindContext,
  l2GeometryFor,
  validL2Geometry,
};
