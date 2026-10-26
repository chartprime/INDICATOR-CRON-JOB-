const { fetchExchangeInfo } = require("../binance/binance-http-client");
const { tickSizeFor } = require("../dxfeed/dxfeed-instrument-catalog");

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 8_000_000;

function binanceCacheKey(marketKind, symbol) {
  return `${marketKind}:${symbol}`;
}

function tickSizeFromExchangeInfoBody(body, symbol) {
  if (!body || !Array.isArray(body.symbols)) return null;
  const entry = body.symbols.find((candidate) => candidate?.symbol === symbol);
  if (!entry || !Array.isArray(entry.filters)) return null;
  const priceFilter = entry.filters.find((filter) => filter?.filterType === "PRICE_FILTER");
  if (!priceFilter || typeof priceFilter.tickSize !== "string") return null;
  const parsed = Number(priceFilter.tickSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function createInstrumentTickSizeResolver({
  fetchExchangeInfoImpl = fetchExchangeInfo,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  nowFn = Date.now,
  fetchImpl,
  timeoutMs,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchExchangeInfoImpl !== "function") {
    throw new Error("instrument-tick-size: fetchExchangeInfoImpl must be a function");
  }
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new Error("instrument-tick-size: cacheTtlMs must be a positive safe integer");
  }
  if (typeof nowFn !== "function") {
    throw new Error("instrument-tick-size: nowFn must be a function");
  }

  const cache = new Map();
  const inFlight = new Map();

  async function refreshBinanceTickSize(marketKind, symbol) {
    const key = binanceCacheKey(marketKind, symbol);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const result = await fetchExchangeInfoImpl(marketKind, symbol, {
        fetchImpl,
        timeoutMs,
        maxResponseBytes,
      });
      if (!result.ok) {
        console.error("instrument-tick-size: exchangeInfo fetch failed", marketKind, symbol, result.reason);
        return cache.get(key)?.tickSize ?? null;
      }
      const tickSize = tickSizeFromExchangeInfoBody(result.value.body, symbol);
      if (tickSize === null) {
        console.error("instrument-tick-size: exchangeInfo response missing a usable PRICE_FILTER", marketKind, symbol);
        return cache.get(key)?.tickSize ?? null;
      }
      cache.set(key, { tickSize, fetchedAtMs: nowFn() });
      return tickSize;
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, promise);
    return promise;
  }

  async function getBinanceTickSize(marketKind, symbol) {
    const key = binanceCacheKey(marketKind, symbol);
    const cached = cache.get(key);
    if (cached && nowFn() - cached.fetchedAtMs < cacheTtlMs) {
      return cached.tickSize;
    }
    return refreshBinanceTickSize(marketKind, symbol);
  }

  function getDxFeedTickSize(assetClass, symbol) {
    return tickSizeFor(assetClass, symbol);
  }

  return Object.freeze({ getBinanceTickSize, getDxFeedTickSize });
}

module.exports = {
  createInstrumentTickSizeResolver,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
};
