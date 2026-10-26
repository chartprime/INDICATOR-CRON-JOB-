"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { assertAllowedSymbol, assertAllowedMarketKind } = require("../providers/binance/binance-subscription-guard");
const { createRouteTelemetry } = require("./route-telemetry");
const { readTelemetry } = require("../storage/read-telemetry");
const { validateBandOptions } = require("./band-history");
const { retryAfterHeaders } = require("./retry-after");
const { LEVELS_MS } = require("../indicators/l2-memory/pyramid/pyramid-levels");
const { ROW_FACTORS } = require("../indicators/l2-memory/pyramid/pyramid-reader");
const { DEFAULT_WALL_PAGE, WALL_OUTCOMES } = require("../indicators/l2-memory/pyramid/pyramid-store");
const { MAX_PAGE: MAX_ICEBERG_PAGE } = require("../indicators/iceberg/iceberg-host-store");
const { MAX_ID_LENGTH: MAX_ICEBERG_ID_LENGTH } = require("../indicators/iceberg/iceberg-history");

const REPLAY_BOOK_MODES = Object.freeze(["full", "sparse"]);

const LIVE_STORAGE_PATH_PREFIX = "/live-storage/";
const SERVICE_SECRET_HEADER = "x-live-storage-service-secret";
const CLIENT_HEADER = "x-live-storage-client";
const CONTRACT_VERSION_HEADER = "x-live-storage-contract-version";
const CORRELATION_ID_HEADER = "x-terminal-correlation-id";
const CONTRACT_VERSION = "live-storage/1";
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_REQUEST_BYTES = 65_536;
const MAX_OPTIONS_KEYS = 32;
const COALESCE_BUCKET_MS = 1_000;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 576, windowMs: 60_000 });
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
const QUERY_TIMEOUT_MS_BY_ROUTE = Object.freeze({ "replay-page": 30_000 });
const DEFAULT_MAX_CONCURRENT_QUERIES = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_WINDOW_MS = 8 * DAY_MS;
const DEFAULT_MAX_ROW_LIMIT = 5_000;
const MAX_WINDOW_MS_BY_ROUTE = Object.freeze({
  "minute-rollup": 31 * DAY_MS,
  "daily-notional": 31 * DAY_MS,
});
const MAX_ROW_LIMIT_BY_ROUTE = Object.freeze({
  "large-trades": 45_000,
  "aggressive-prints": 20_000,
  // Keep a maximum page below the relay and remote-reader 2 MB ceilings.
  // The VPIN consumer uses 2,000; 5,000 leaves bounded headroom without
  // admitting a response the transport cannot deliver.
  "trades-since": 5_000,
});
const REQUIRED_LIMIT_ROUTES = Object.freeze(new Set(["recent-trades"]));
const SLOW_AGGREGATE_ROUTES = Object.freeze({
  "daily-notional": { queryTimeoutMs: 45_000 },
  "minute-rollup": { queryTimeoutMs: 45_000 },
  "sliced-notional": { queryTimeoutMs: 45_000 },
  "band-history": { queryTimeoutMs: 45_000 },
});
const REPLAY_ROUTES = Object.freeze(new Set(["replay-page", "band-history"]));
const DEFAULT_MAX_CACHE_ENTRIES = 200;
const DEFAULT_SLOW_CACHE_TTL_MS = 900_000;
const COALESCED_CLOCK_FIELDS = new Set(["nowMs"]);
const WINDOW_FIELDS_BY_ROUTE = Object.freeze({
  "large-trades": ["fromMs", "nowMs"],
  "aggressive-prints": ["fromMs", "toMs"],
  "volume-profile": ["fromTs", "toTs"],
  "price-range": ["fromTs", "toTs"],
  "minute-rollup": ["fromTs", "toTs"],
  "daily-notional": ["fromTs", "toTs"],
  "sliced-notional": ["fromTs", "toTs"],
  "trades-since": ["fromTs", "toTs"],
});

const MALFORMED_REQUEST = "MALFORMED_REQUEST";
const UNAUTHORIZED = "UNAUTHORIZED";
const OVERLOADED = "OVERLOADED";
const SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE";
const STATUS = Object.freeze({
  [MALFORMED_REQUEST]: 400,
  [UNAUTHORIZED]: 401,
  [OVERLOADED]: 429,
  [SERVICE_UNAVAILABLE]: 503,
});

const ROUTES = Object.freeze({
  "replay-page": "readReplayPage",
  "band-history": "readBandHistory",
  "recent-events": "readRecent",
  "recent-candles": "readRecentCandles",
  "recent-trades": "readRecentTrades",
  "large-trades": "readLargeTrades",
  "aggressive-prints": "readAggressivePrints",
  "volume-profile": "readVolumeProfile",
  "price-range": "readPriceRange",
  "minute-rollup": "readMinuteRollup",
  "daily-notional": "readDailyNotional",
  "sliced-notional": "readSlicedNotional",
  "trades-since": "readTradesSince",
  "recording-age": "readRecordingAge",
  "heatmap-columns": "readHeatmapColumns",
  "wall-history": "readWallHistory",
  "event-history": "readEventHistory",
  "iceberg-history": "readIcebergHistory",
});

const DXFEED_ROUTES = Object.freeze(new Set([
  "recent-events", "recent-candles", "large-trades", "aggressive-prints", "volume-profile",
  "price-range", "minute-rollup", "daily-notional", "sliced-notional", "trades-since",
]));
const HEATMAP_ROUTE = "heatmap-columns";
const WALL_HISTORY_ROUTE = "wall-history";
const MAX_WALL_MIN_USD = 1e12;
const EVENT_HISTORY_ROUTE = "event-history";
const PYRAMID_ROUTES = Object.freeze(new Set([HEATMAP_ROUTE, WALL_HISTORY_ROUTE, EVENT_HISTORY_ROUTE]));
const ICEBERG_HISTORY_ROUTE = "iceberg-history";
const ICEBERG_ROUTES = Object.freeze(new Set([ICEBERG_HISTORY_ROUTE]));
const HEATMAP_LEVELS_MS = LEVELS_MS;
const HEATMAP_ROW_FACTORS = ROW_FACTORS;
const DXFEED_RECENT_EVENT_TYPES = Object.freeze(new Set(["QUOTE", "TRADE", "TIMEANDSALE"]));

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function routeNameFromUrl(url) {
  if (typeof url !== "string" || !url.startsWith(LIVE_STORAGE_PATH_PREFIX)) return null;
  const rest = url.slice(LIVE_STORAGE_PATH_PREFIX.length);
  return Object.hasOwn(ROUTES, rest) ? rest : null;
}

function resolveGatewayClient(headers, serviceSecret) {
  if (typeof serviceSecret !== "string" || serviceSecret.length === 0) return null;
  const presented = headers[SERVICE_SECRET_HEADER];
  if (typeof presented !== "string" || presented.length === 0) return null;
  if (!crypto.timingSafeEqual(digest(presented), digest(serviceSecret))) return null;
  const clientId = headers[CLIENT_HEADER];
  if (typeof clientId !== "string" || clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)) {
    return null;
  }
  return clientId;
}

function readBody(request, limitBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(reject, new Error("REQUEST_BODY_TIMEOUT"));
      request.resume();
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      fn(value);
    };
    function onData(chunk) {
      total += chunk.length;
      if (total > limitBytes) {
        chunks.length = 0;
        finish(reject, new Error("REQUEST_BODY_TOO_LARGE"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() { finish(resolve, Buffer.concat(chunks)); }
    function onError(error) { finish(reject, error); }
    function onAborted() { finish(reject, new Error("REQUEST_ABORTED")); }
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePayload(payload) {
  if (!isRecord(payload)) return "REQUEST_NOT_AN_OBJECT";
  if (typeof payload.symbol !== "string" || payload.symbol.length === 0 || payload.symbol.length > 64) {
    return "SYMBOL_NOT_A_STRING";
  }
  const provider = Object.hasOwn(payload, "provider") ? payload.provider : "binance";
  if (provider !== "binance" && provider !== "dxfeed") return "PROVIDER_NOT_RECOGNIZED";
  const identityField = provider === "dxfeed" ? "assetClass" : "marketKind";
  if (typeof payload[identityField] !== "string" || payload[identityField].length === 0 || payload[identityField].length > 32) {
    return identityField === "assetClass" ? "ASSET_CLASS_NOT_A_STRING" : "MARKET_KIND_NOT_A_STRING";
  }
  if (Object.hasOwn(payload, "options") && !isRecord(payload.options)) {
    return "OPTIONS_NOT_AN_OBJECT";
  }
  if (isRecord(payload.options) && Object.keys(payload.options).length > MAX_OPTIONS_KEYS) {
    return "OPTIONS_TOO_LARGE";
  }
  const knownKeys = new Set(["symbol", "options", "provider", identityField]);
  const unknown = Object.keys(payload).filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) return `UNKNOWN_REQUEST_FIELDS:${unknown.sort().join(",")}`;
  return null;
}

function validateQueryBounds(routeName, options) {
  if (routeName === "replay-page") {
    const allowed = new Set(["fromTs", "toTs", "tickSize", "clusterTicks", "rowClusters", "windowRows", "cursor", "bookMode"]);
    const unknown = Object.keys(options).filter((key) => !allowed.has(key));
    if (unknown.length > 0) return `UNKNOWN_OPTIONS:${unknown.sort().join(",")}`;
    if (options.bookMode !== undefined && !REPLAY_BOOK_MODES.includes(options.bookMode)) return "BOOK_MODE_INVALID";
    if (!Number.isSafeInteger(options.fromTs) || !Number.isSafeInteger(options.toTs) || options.fromTs < 0 ||
        options.toTs < options.fromTs || options.toTs - options.fromTs > DEFAULT_MAX_WINDOW_MS) return "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs";
    if (!Number.isFinite(options.tickSize) || options.tickSize <= 0) return "TICK_SIZE_OUT_OF_RANGE";
    for (const field of ["clusterTicks", "rowClusters", "windowRows"]) {
      if (!Number.isSafeInteger(options[field]) || options[field] <= 0 || options[field] > 100_000) return `${field.toUpperCase()}_OUT_OF_RANGE`;
    }
    if (options.cursor !== null && options.cursor !== undefined &&
        (typeof options.cursor !== "string" || options.cursor.length > 4_096)) return "CURSOR_INVALID";
    return null;
  }
  if (routeName === "band-history") return validateBandOptions(options);
  if (ICEBERG_ROUTES.has(routeName)) {
    const allowed = ["fromTs", "toTs", "limit", "after"];
    const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) return `UNKNOWN_OPTIONS:${unknown.sort().join(",")}`;
    if (!Number.isSafeInteger(options.fromTs) || !Number.isSafeInteger(options.toTs) || options.fromTs < 0 ||
        options.toTs <= options.fromTs || options.toTs - options.fromTs > DEFAULT_MAX_WINDOW_MS) return "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs";
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_ICEBERG_PAGE)) return `LIMIT_OUT_OF_RANGE:1..${MAX_ICEBERG_PAGE}`;
    if (options.after !== undefined && options.after !== null) {
      const after = options.after;
      if (!after || typeof after !== "object" || Array.isArray(after) || Object.keys(after).sort().join(",") !== "id,markedAt" ||
          !Number.isSafeInteger(after.markedAt) || after.markedAt < 0 || typeof after.id !== "string" || after.id.length === 0 || after.id.length > MAX_ICEBERG_ID_LENGTH) return "CURSOR_INVALID";
    }
    return null;
  }
  if (PYRAMID_ROUTES.has(routeName)) {
    const allowed = routeName === HEATMAP_ROUTE ? ["levelMs", "fromTs", "toTs", "rowFactor"] : routeName === WALL_HISTORY_ROUTE ? ["fromTs", "toTs", "limit", "after", "minUsd", "alwaysOutcomes"] : ["fromTs", "toTs"];
    const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) return `UNKNOWN_OPTIONS:${unknown.sort().join(",")}`;
    if (routeName === HEATMAP_ROUTE && !HEATMAP_LEVELS_MS.includes(options.levelMs)) return "LEVEL_NOT_A_PYRAMID_LEVEL";
    if (!Number.isSafeInteger(options.fromTs) || !Number.isSafeInteger(options.toTs) || options.fromTs < 0 ||
        options.toTs <= options.fromTs || options.toTs - options.fromTs > DEFAULT_MAX_WINDOW_MS) return "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs";
    if (routeName === HEATMAP_ROUTE && options.rowFactor !== undefined && !HEATMAP_ROW_FACTORS.includes(options.rowFactor)) return "ROW_FACTOR_OUT_OF_RANGE";
    if (routeName === WALL_HISTORY_ROUTE) {
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > DEFAULT_WALL_PAGE)) return `LIMIT_OUT_OF_RANGE:1..${DEFAULT_WALL_PAGE}`;
      if (options.after !== undefined && options.after !== null) {
        const after = options.after;
        if (!after || typeof after !== "object" || Array.isArray(after) || Object.keys(after).sort().join(",") !== "endTs,id" ||
            !Number.isSafeInteger(after.endTs) || after.endTs < 0 || !Number.isSafeInteger(after.id) || after.id < 0) return "CURSOR_INVALID";
      }
      if (options.minUsd !== undefined && (typeof options.minUsd !== "number" || !Number.isFinite(options.minUsd) || options.minUsd < 0 || options.minUsd > MAX_WALL_MIN_USD)) return "MIN_USD_OUT_OF_RANGE";
      if (options.alwaysOutcomes !== undefined) {
        const outcomes = options.alwaysOutcomes;
        if (options.minUsd === undefined) return "ALWAYS_OUTCOMES_NEEDS_MIN_USD";
        if (!Array.isArray(outcomes) || outcomes.length > WALL_OUTCOMES.length || new Set(outcomes).size !== outcomes.length ||
            outcomes.some((outcome) => !WALL_OUTCOMES.includes(outcome))) return "ALWAYS_OUTCOMES_INVALID";
      }
    }
    return null;
  }
  if (routeName === "recent-events") {
    const unknown = Object.keys(options).filter((key) => key !== "eventType" && key !== "limit");
    if (unknown.length > 0) return `UNKNOWN_OPTIONS:${unknown.sort().join(",")}`;
  }
  const maxRowLimit = MAX_ROW_LIMIT_BY_ROUTE[routeName] ?? DEFAULT_MAX_ROW_LIMIT;
  const maxWindowMs = MAX_WINDOW_MS_BY_ROUTE[routeName] ?? DEFAULT_MAX_WINDOW_MS;
  if (REQUIRED_LIMIT_ROUTES.has(routeName) && (!Object.hasOwn(options, "limit") || options.limit === null)) {
    return "LIMIT_REQUIRED";
  }
  if (Object.hasOwn(options, "limit") && options.limit !== null &&
      (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > maxRowLimit)) {
    return `LIMIT_OUT_OF_RANGE:1..${maxRowLimit}`;
  }
  if (Object.hasOwn(options, "windowMs") &&
      (!Number.isSafeInteger(options.windowMs) || options.windowMs < 0 || options.windowMs > maxWindowMs)) {
    return `WINDOW_OUT_OF_RANGE:0..${maxWindowMs}`;
  }
  const fields = WINDOW_FIELDS_BY_ROUTE[routeName];
  if (fields && Object.hasOwn(options, fields[0])) {
    const [fromField, toField] = fields;
    const from = options[fromField];
    const to = options[toField];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > maxWindowMs) {
      return `TIME_RANGE_OUT_OF_RANGE:${fromField}/${toField}`;
    }
  }
  return null;
}

function cacheKeyFor(provider, routeName, symbol, marketKind, options) {
  // Aggregate semantics include more than the time range (for example,
  // minute-rollup's tickSize). Omitting those fields can return a cached
  // result computed at a different price grain.
  return `${provider}\0${routeName}\0${symbol}\0${marketKind}\0${JSON.stringify(stableValue(options))}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function coalesceKey(routeName, symbol, marketKind, options, bucketMs = COALESCE_BUCKET_MS, provider = "binance") {
  const rounded = {};
  for (const [key, value] of Object.entries(options)) {
    // Only the observation clock is intentionally approximate. Range edges,
    // cursors, and record timestamps are part of the query's exact identity.
    rounded[key] = (COALESCED_CLOCK_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value))
      ? Math.floor(value / bucketMs) * bucketMs
      : value;
  }
  return `${provider}\0${routeName}\0${symbol}\0${marketKind}\0${JSON.stringify(stableValue(rounded))}`;
}

function createLiveStorageRoute({
  storageReader,
  dxfeedStorageReader = null,
  replayPageReader = null,
  heatmapReader = null,
  icebergReader = null,
  serviceSecret = process.env.TT_LIVE_STORAGE_SERVICE_SECRET,
  rateLimit = DEFAULT_RATE_LIMIT,
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  maxRequestBytes = MAX_REQUEST_BYTES,
  coalesceBucketMs = COALESCE_BUCKET_MS,
  queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  maxConcurrentQueries = DEFAULT_MAX_CONCURRENT_QUERIES,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  slowCacheTtlMs = DEFAULT_SLOW_CACHE_TTL_MS,
  now = () => Date.now(),
  telemetryNow,
  log = console.error,
} = {}) {
  if (!storageReader || typeof storageReader !== "object") {
    throw new Error("live-storage-route: storageReader is required");
  }
  if (dxfeedStorageReader !== null && (!dxfeedStorageReader || typeof dxfeedStorageReader !== "object")) {
    throw new Error("live-storage-route: dxfeedStorageReader must be an object or null");
  }
  if (replayPageReader !== null && (!replayPageReader || typeof replayPageReader !== "object")) {
    throw new Error("live-storage-route: replayPageReader must be an object or null");
  }
  if (heatmapReader !== null && (!heatmapReader || typeof heatmapReader.readAsync !== "function")) {
    throw new Error("live-storage-route: heatmapReader must have readAsync or be null");
  }
  if (icebergReader !== null && (!icebergReader || typeof icebergReader.readAsync !== "function")) {
    throw new Error("live-storage-route: icebergReader must have readAsync or be null");
  }
  const { isAllowedAssetClass, isAllowedDxFeedSymbol, isAllowedEventType } = dxfeedStorageReader === null && heatmapReader === null && icebergReader === null
    ? {}
    : require("../providers/dxfeed/dxfeed-instrument-catalog");
  for (const [name, value] of [
    ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
    ["requestBodyTimeoutMs", requestBodyTimeoutMs], ["maxRequestBytes", maxRequestBytes],
    ["coalesceBucketMs", coalesceBucketMs], ["queryTimeoutMs", queryTimeoutMs],
    ["maxConcurrentQueries", maxConcurrentQueries], ["maxCacheEntries", maxCacheEntries],
    ["slowCacheTtlMs", slowCacheTtlMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`live-storage-route: ${name} must be a positive safe integer`);
    }
  }

  const requestTimes = new Map();
  const inFlight = new Map();
  const directControllers = new Set();
  const resultCache = new Map();
  const telemetry = createRouteTelemetry({ routes: Object.keys(ROUTES), ...(telemetryNow ? { now: telemetryNow } : {}) });
  const counters = { admitted: 0, rejected: 0, unauthorized: 0, completed: 0, failed: 0, coalesced: 0, cached: 0 };
  let disposed = false;

  function errorBody(code, detail) {
    const body = { error: code };
    if (detail !== undefined) body.detail = String(detail).slice(0, 256);
    return body;
  }

  function send(response, status, body, routeName = null) {
    if (response.writableEnded || response.destroyed) return;
    const serializationStartedAt = performance.now();
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (routeName !== null) telemetry.observeStage(routeName, "serializationMs", performance.now() - serializationStartedAt);
    response.writeHead(status, {
      "content-type": "application/json", "content-length": String(payload.length), "cache-control": "no-store",
      ...retryAfterHeaders(status, body),
      [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
    });
    if (routeName !== null) {
      const writeStartedAt = performance.now();
      response.once("finish", () => telemetry.observeStage(routeName, "responseWriteMs", performance.now() - writeStartedAt));
    }
    response.end(payload);
  }

  function reserveRateBudget(clientId, at) {
    const fresh = (requestTimes.get(clientId) ?? []).filter((t) => at - t < rateLimit.windowMs);
    if (fresh.length >= rateLimit.max) {
      requestTimes.set(clientId, fresh);
      return Math.max(1, fresh[0] + rateLimit.windowMs - at);
    }
    fresh.push(at);
    requestTimes.set(clientId, fresh);
    return null;
  }

  function dispatch(reader, methodName, symbol, marketKind, options, signal, provider) {
    if (typeof reader.readAsync === "function") {
      return reader.readAsync(methodName, symbol, marketKind, options, { signal, provider });
    }
    if (methodName === "readRecent") {
      const { eventType, ...readOptions } = options;
      return Promise.resolve().then(() => reader.readRecent(symbol, marketKind, eventType, readOptions));
    }
    return Promise.resolve().then(() => reader[methodName](symbol, marketKind, options));
  }

  function recordReadStages(routeName, result) {
    const stages = readTelemetry(result);
    if (stages === null) return result;
    for (const field of ["poolQueueMs", "workerStartupMs", "readerSetupMs", "queryMs", "workerTotalMs"]) {
      telemetry.observeStage(routeName, field, stages[field]);
    }
    return result;
  }

  function cancelledRead() {
    const error = new Error("READ_ABORTED");
    error.code = SERVICE_UNAVAILABLE;
    error.telemetryReason = "reader_aborted";
    return error;
  }

  function subscribeRead(entry, signal) {
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        entry.subscribers -= 1;
        fn(value);
      };
      const abort = () => {
        finish(reject, cancelledRead());
        if (entry.subscribers === 0) entry.controller.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then((result) => finish(resolve, result), (error) => finish(reject, error));
      if (signal?.aborted) abort();
    });
  }

  function readCoalesced(provider, reader, routeName, methodName, symbol, marketKind, options, externalSignal) {
    if (externalSignal?.aborted) return Promise.reject(cancelledRead());
    const slow = SLOW_AGGREGATE_ROUTES[routeName];
    const cacheable = slow !== undefined && routeName !== "band-history";
    if (cacheable) {
      const cacheKey = cacheKeyFor(provider, routeName, symbol, marketKind, options);
      const entry = resultCache.get(cacheKey);
      if (entry !== undefined && now() - entry.cachedAt < slowCacheTtlMs) {
        counters.cached += 1;
        telemetry.increment(routeName, "cacheHits");
        resultCache.delete(cacheKey);
        resultCache.set(cacheKey, entry);
        return Promise.resolve(entry.result);
      }
      if (entry !== undefined) resultCache.delete(cacheKey);
      telemetry.increment(routeName, "cacheMisses");
    }
    const key = coalesceKey(routeName, symbol, marketKind, options, coalesceBucketMs, provider);
    const existing = inFlight.get(key);
    if (existing && !existing.controller.signal.aborted) {
      counters.coalesced += 1;
      telemetry.increment(routeName, "coalesced");
      return subscribeRead(existing, externalSignal);
    }
    if (inFlight.size + directControllers.size >= maxConcurrentQueries) {
      telemetry.increment(routeName, "overloaded");
      const error = new Error("CONCURRENT_QUERY_LIMIT_EXCEEDED");
      error.code = OVERLOADED;
      throw error;
    }
    const controller = new AbortController();
    const entry = { controller, subscribers: 0, promise: null };
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(cancelledRead()), { once: true });
    });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        telemetry.increment(routeName, "timedOut");
        const error = new Error("QUERY_TIMEOUT");
        error.code = SERVICE_UNAVAILABLE;
        error.telemetryReason = "route_timeout";
        reject(error);
        controller.abort();
      }, slow?.queryTimeoutMs ?? QUERY_TIMEOUT_MS_BY_ROUTE[routeName] ?? queryTimeoutMs);
    });
    const promise = Promise.race([dispatch(reader, methodName, symbol, marketKind, options, controller.signal, provider), deadline, cancelled])
      .then((result) => recordReadStages(routeName, result))
      .then((result) => {
        if (cacheable && !controller.signal.aborted && result?.available !== false) {
          const cacheKey = cacheKeyFor(provider, routeName, symbol, marketKind, options);
          if (!resultCache.has(cacheKey) && resultCache.size >= maxCacheEntries) {
            resultCache.delete(resultCache.keys().next().value);
          }
          resultCache.delete(cacheKey);
          resultCache.set(cacheKey, { result, cachedAt: now() });
        }
        return result;
      })
      .finally(() => { clearTimeout(timer); if (inFlight.get(key) === entry) inFlight.delete(key); });
    entry.promise = promise;
    inFlight.set(key, entry);
    return subscribeRead(entry, externalSignal);
  }

  function readDirect(provider, reader, routeName, methodName, symbol, marketKind, options, externalSignal) {
    if (inFlight.size + directControllers.size >= maxConcurrentQueries) {
      telemetry.increment(routeName, "overloaded");
      const error = new Error("CONCURRENT_QUERY_LIMIT_EXCEEDED");
      error.code = OVERLOADED;
      throw error;
    }
    const controller = new AbortController();
    directControllers.add(controller);
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(cancelledRead()), { once: true });
    });
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        telemetry.increment(routeName, "timedOut");
        const error = new Error("QUERY_TIMEOUT");
        error.code = SERVICE_UNAVAILABLE;
        error.telemetryReason = "route_timeout";
        reject(error);
        controller.abort();
      }, QUERY_TIMEOUT_MS_BY_ROUTE[routeName] ?? queryTimeoutMs);
    });
    return Promise.race([dispatch(reader, methodName, symbol, marketKind, options, controller.signal, provider), deadline, cancelled])
      .then((result) => recordReadStages(routeName, result))
      .finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        directControllers.delete(controller);
      });
  }

  async function respond(request, response, routeName, correlationId) {
    counters.admitted += 1;
    let raw;
    try {
      raw = await readBody(request, maxRequestBytes, requestBodyTimeoutMs);
    } catch (error) {
      counters.failed += 1;
      if (error?.message === "REQUEST_BODY_TOO_LARGE" || error?.message === "REQUEST_BODY_TIMEOUT") {
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, error.message));
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      counters.failed += 1;
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "BODY_NOT_JSON"));
      return;
    }
    const problem = validatePayload(payload);
    if (problem !== null) {
      counters.failed += 1;
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, problem));
      return;
    }
    const provider = payload.provider ?? "binance";
    const { symbol } = payload;
    const marketKind = provider === "dxfeed" ? payload.assetClass : payload.marketKind;
    const options = payload.options ?? {};
    const boundsProblem = validateQueryBounds(routeName, options);
    if (boundsProblem !== null) {
      counters.rejected += 1;
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, boundsProblem));
      return;
    }
    if (REPLAY_ROUTES.has(routeName) && replayPageReader === null) {
      counters.failed += 1;
      send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "REPLAY_NOT_CONFIGURED"));
      return;
    }
    if (PYRAMID_ROUTES.has(routeName) && heatmapReader === null) {
      counters.failed += 1;
      send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "HEATMAP_NOT_CONFIGURED"));
      return;
    }
    if (ICEBERG_ROUTES.has(routeName) && icebergReader === null) {
      counters.failed += 1;
      send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "ICEBERG_HISTORY_NOT_CONFIGURED"));
      return;
    }
    if (provider === "dxfeed") {
      if (dxfeedStorageReader === null && !PYRAMID_ROUTES.has(routeName) && !ICEBERG_ROUTES.has(routeName)) {
        counters.failed += 1;
        send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "DXFEED_NOT_CONFIGURED"));
        return;
      }
      if (!REPLAY_ROUTES.has(routeName) && !DXFEED_ROUTES.has(routeName) && !PYRAMID_ROUTES.has(routeName) && !ICEBERG_ROUTES.has(routeName)) {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "ROUTE_NOT_AVAILABLE_FOR_PROVIDER"));
        return;
      }
      if (!isAllowedAssetClass(marketKind) || !isAllowedDxFeedSymbol(symbol, marketKind)) {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "Unproven dxFeed symbol/assetClass"));
        return;
      }
      if (routeName === "recent-events" &&
          (!isAllowedEventType(options.eventType) || !DXFEED_RECENT_EVENT_TYPES.has(options.eventType))) {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "Unproven dxFeed eventType"));
        return;
      }
    } else {
      if (routeName === "recent-events" || routeName === "trades-since") {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "ROUTE_NOT_AVAILABLE_FOR_PROVIDER"));
        return;
      }
      try {
        assertAllowedSymbol(symbol);
        assertAllowedMarketKind(marketKind);
      } catch (error) {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, error.message));
        return;
      }
    }
    const heatmap = PYRAMID_ROUTES.has(routeName);
    const icebergs = ICEBERG_ROUTES.has(routeName);
    const reader = icebergs ? icebergReader : heatmap ? heatmapReader : REPLAY_ROUTES.has(routeName) ? replayPageReader : provider === "dxfeed" ? dxfeedStorageReader : storageReader;
    const readerErrorPrefix = icebergs ? "iceberg-host-reader:" : heatmap ? "pyramid-reader:" : REPLAY_ROUTES.has(routeName) ? "replay-page-reader:" : provider === "dxfeed" ? "dxfeed-storage-reader:" : "storage-reader:";
    const methodName = ROUTES[routeName];
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    request.once("aborted", abortRequest);
    response.once("close", abortRequest);
    try {
      const result = await (routeName === "replay-page"
        ? readDirect(provider, reader, routeName, methodName, symbol, marketKind, options, requestController.signal)
        : readCoalesced(provider, reader, routeName, methodName, symbol, marketKind, options, requestController.signal));
      counters.completed += 1;
      send(response, 200, result, routeName);
    } catch (error) {
      if (requestController.signal.aborted) return;
      if (error?.code === OVERLOADED) {
        counters.rejected += 1;
        send(response, STATUS[OVERLOADED], errorBody(OVERLOADED, error.message));
        return;
      }
      if (error?.code === SERVICE_UNAVAILABLE) {
        counters.failed += 1;
        telemetry.observeFailure(routeName, error.telemetryReason);
        log("live-storage-route: service unavailable", routeName, correlationId,
          error.telemetryReason ?? "service_unavailable", error?.message ?? error);
        send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, error.message));
        return;
      }
      if (typeof error?.message !== "string" || !error.message.startsWith(readerErrorPrefix)) {
        counters.failed += 1;
        log("live-storage-route: storage read failed", routeName, correlationId, error?.message ?? error);
        send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "STORAGE_READ_FAILED"));
        return;
      }
      counters.failed += 1;
      log("live-storage-route: request failed", routeName, correlationId, error?.message ?? error);
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "INVALID_OPTIONS"));
    } finally {
      request.removeListener("aborted", abortRequest);
      response.removeListener("close", abortRequest);
    }
  }

  function handle(request, response) {
    const routeName = routeNameFromUrl(request.url);
    if (routeName === null) return false;
    const presentedCorrelationId = request.headers[CORRELATION_ID_HEADER];
    const correlationId = typeof presentedCorrelationId === "string" && CORRELATION_ID_PATTERN.test(presentedCorrelationId)
      ? presentedCorrelationId : crypto.randomUUID();
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    const measurement = telemetry.start(routeName, Number(request.headers["content-length"] ?? 0));
    response.once("finish", () => measurement.finish(response.statusCode, Number(response.getHeader("content-length") ?? 0)));
    response.once("close", () => {
      if (!response.writableFinished) {
        telemetry.increment(routeName, "cancelled");
        measurement.finish(499, Number(response.getHeader("content-length") ?? 0));
      }
    });
    if (request.method !== "POST") {
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "METHOD_NOT_ALLOWED"));
      return true;
    }
    if (disposed) {
      send(response, STATUS[SERVICE_UNAVAILABLE], errorBody(SERVICE_UNAVAILABLE, "SERVER_SHUTTING_DOWN"));
      return true;
    }
    if (request.headers[CONTRACT_VERSION_HEADER] !== CONTRACT_VERSION) {
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "CONTRACT_VERSION_MISMATCH"));
      return true;
    }
    const clientId = resolveGatewayClient(request.headers, serviceSecret);
    if (clientId === null) {
      counters.unauthorized += 1;
      send(response, STATUS[UNAUTHORIZED], errorBody(UNAUTHORIZED, "GATEWAY_NOT_AUTHENTICATED"));
      return true;
    }
    const retryAfterMs = reserveRateBudget(clientId, now());
    if (retryAfterMs !== null) {
      counters.rejected += 1;
      telemetry.increment(routeName, "overloaded");
      const body = errorBody(OVERLOADED, "RATE_BUDGET_EXCEEDED");
      body.retryAfterMs = retryAfterMs;
      send(response, STATUS[OVERLOADED], body);
      return true;
    }
    void respond(request, response, routeName, correlationId);
    return true;
  }

  function stats() {
    return { ...counters, inFlight: inFlight.size + directControllers.size, cacheSize: resultCache.size, telemetry: telemetry.snapshot(), disposed };
  }

  function dispose() {
    disposed = true;
    for (const entry of inFlight.values()) entry.controller.abort();
    for (const controller of directControllers) controller.abort();
    directControllers.clear();
  }

  return Object.freeze({ handle, stats, dispose });
}

module.exports = {
  createLiveStorageRoute,
  LIVE_STORAGE_PATH_PREFIX,
  ROUTES,
  DXFEED_ROUTES,
  HEATMAP_LEVELS_MS,
  HEATMAP_ROW_FACTORS,
  SERVICE_SECRET_HEADER,
  CLIENT_HEADER,
  CONTRACT_VERSION_HEADER,
  CORRELATION_ID_HEADER,
  CONTRACT_VERSION,
  resolveGatewayClient,
  coalesceKey,
  validatePayload,
  validateQueryBounds,
  MAX_ROW_LIMIT_BY_ROUTE,
  SLOW_AGGREGATE_ROUTES,
};
