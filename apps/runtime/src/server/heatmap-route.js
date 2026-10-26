"use strict";

const zlib = require("node:zlib");
const { readBody } = require("./archive-route");
const { validateQueryBounds } = require("./live-storage-route");
const { isAllowedSymbol, isAllowedMarketKind } = require("../providers/binance/binance-config");
const { isAllowedAssetClass, isAllowedDxFeedSymbol } = require("../providers/dxfeed/dxfeed-instrument-catalog");

const HEATMAP_COLUMNS_PATH = "/heatmap/columns";
const HEATMAP_WALLS_PATH = "/heatmap/walls";
const MAX_REQUEST_BYTES = 4_096;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 240, windowMs: 60_000 });
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const BUSY_RETRY_AFTER_MS = 250;
const GZIP_THRESHOLD_BYTES = 1_024;
const REQUEST_FIELDS = Object.freeze({
  "heatmap-columns": Object.freeze(["provider", "marketKind", "symbol", "levelMs", "fromTs", "toTs", "rowFactor"]),
  "wall-history": Object.freeze(["provider", "marketKind", "symbol", "fromTs", "toTs", "limit", "after", "minUsd", "alwaysOutcomes"]),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHeatmapRequest(payload, routeName = "heatmap-columns") {
  if (!isRecord(payload)) return { error: "REQUEST_NOT_AN_OBJECT" };
  const fields = REQUEST_FIELDS[routeName];
  if (fields === undefined) return { error: "ROUTE_NOT_RECOGNIZED" };
  const unknown = Object.keys(payload).filter((key) => !fields.includes(key));
  if (unknown.length > 0) return { error: `UNKNOWN_REQUEST_FIELDS:${unknown.sort().join(",")}` };
  const { provider, marketKind, symbol } = payload;
  if (provider !== "BINANCE" && provider !== "DXFEED") return { error: "PROVIDER_NOT_RECOGNIZED" };
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 64) return { error: "SYMBOL_NOT_A_STRING" };
  if (typeof marketKind !== "string" || marketKind.length === 0 || marketKind.length > 32) return { error: "MARKET_KIND_NOT_A_STRING" };
  let storageSymbol = symbol;
  if (provider === "BINANCE") {
    storageSymbol = symbol.replace("-", "");
    if (!isAllowedSymbol(storageSymbol) || !isAllowedMarketKind(marketKind)) return { error: "INSTRUMENT_NOT_ALLOWED" };
  } else if (!isAllowedAssetClass(marketKind) || !isAllowedDxFeedSymbol(symbol, marketKind)) {
    return { error: "INSTRUMENT_NOT_ALLOWED" };
  }
  const options = routeName === "heatmap-columns"
    ? { levelMs: payload.levelMs, fromTs: payload.fromTs, toTs: payload.toTs, ...(payload.rowFactor === undefined ? {} : { rowFactor: payload.rowFactor }) }
    : {
      fromTs: payload.fromTs,
      toTs: payload.toTs,
      ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      ...(payload.after === undefined ? {} : { after: payload.after }),
      ...(payload.minUsd === undefined ? {} : { minUsd: payload.minUsd }),
      ...(payload.alwaysOutcomes === undefined ? {} : { alwaysOutcomes: Array.isArray(payload.alwaysOutcomes) ? [...payload.alwaysOutcomes].sort() : payload.alwaysOutcomes }),
    };
  if (routeName === "wall-history" && provider !== "BINANCE" && (options.minUsd !== undefined || options.alwaysOutcomes !== undefined)) return { error: "SIZE_FILTER_NEEDS_BINANCE" };
  const problem = validateQueryBounds(routeName, options);
  if (problem !== null) return { error: problem };
  return { provider, marketKind, symbol: storageSymbol, options };
}

function createHeatmapRoute({
  read,
  allowedOrigins,
  path = HEATMAP_COLUMNS_PATH,
  routeName = "heatmap-columns",
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES,
  rateLimit = DEFAULT_RATE_LIMIT,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  now = () => Date.now(),
  log = console.error,
}) {
  if (typeof read !== "function") throw new Error("heatmap-route: read must be a function");
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("heatmap-route: path must start with /");
  if (REQUEST_FIELDS[routeName] === undefined) throw new Error("heatmap-route: routeName is not a heatmap route");
  if (!(allowedOrigins instanceof Set)) throw new Error("heatmap-route: allowedOrigins must be a Set");
  for (const [name, value] of [["cacheTtlMs", cacheTtlMs], ["cacheMaxBytes", cacheMaxBytes], ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs], ["maxConcurrent", maxConcurrent], ["requestBodyTimeoutMs", requestBodyTimeoutMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`heatmap-route: ${name} must be a positive safe integer`);
  }
  const cache = new Map();
  let cacheBytes = 0;
  const requestTimes = new Map();
  const controllers = new Set();
  const flights = new Map();
  const counters = { served: 0, cached: 0, shared: 0, refused: 0, forbidden: 0, busy: 0, failed: 0 };
  let inFlight = 0;
  let disposed = false;

  function sendPayload(request, response, status, payload) {
    if (response.writableEnded || response.destroyed) return;
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    const wantsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "") && payload.length >= GZIP_THRESHOLD_BYTES;
    if (!wantsGzip) {
      headers["content-length"] = String(payload.length);
      response.writeHead(status, headers);
      response.end(payload);
      return;
    }
    zlib.gzip(payload, (error, compressed) => {
      if (response.writableEnded || response.destroyed) return;
      if (error) {
        headers["content-length"] = String(payload.length);
        response.writeHead(status, headers);
        response.end(payload);
        return;
      }
      headers["content-encoding"] = "gzip";
      headers["content-length"] = String(compressed.length);
      response.writeHead(status, headers);
      response.end(compressed);
    });
  }

  function send(request, response, status, body) {
    sendPayload(request, response, status, Buffer.from(JSON.stringify(body), "utf8"));
  }

  function refuse(request, response, status, error, extra = {}) {
    counters.refused += 1;
    send(request, response, status, { error, ...extra });
  }

  function reserveRate(origin, at) {
    const fresh = (requestTimes.get(origin) ?? []).filter((t) => at - t < rateLimit.windowMs);
    if (fresh.length >= rateLimit.max) {
      requestTimes.set(origin, fresh);
      return Math.max(1, fresh[0] + rateLimit.windowMs - at);
    }
    fresh.push(at);
    requestTimes.set(origin, fresh);
    return null;
  }

  function cached(key, at) {
    const entry = cache.get(key);
    if (entry === undefined) return null;
    cache.delete(key);
    if (at - entry.at >= cacheTtlMs) {
      cacheBytes -= entry.payload.length;
      return null;
    }
    cache.set(key, entry);
    return entry.payload;
  }

  function remember(key, payload, at) {
    if (payload.length > cacheMaxBytes) return;
    const existing = cache.get(key);
    if (existing !== undefined) {
      cache.delete(key);
      cacheBytes -= existing.payload.length;
    }
    cache.set(key, { payload, at });
    cacheBytes += payload.length;
    while (cacheBytes > cacheMaxBytes) {
      const [oldestKey, oldest] = cache.entries().next().value;
      cache.delete(oldestKey);
      cacheBytes -= oldest.payload.length;
    }
  }

  function startFlight(key, parsed) {
    inFlight += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const abandoned = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const flight = { controller, waiters: 0, promise: null, abandoned };
    flight.promise = (async () => {
      try {
        const result = await read(parsed.provider, parsed.symbol, parsed.marketKind, parsed.options, controller.signal);
        if (controller.signal.aborted) return null;
        const body = Buffer.from(JSON.stringify(result), "utf8");
        if (result?.available === true) remember(key, body, now());
        return body;
      } catch (error) {
        if (controller.signal.aborted) return null;
        log(`heatmap-route: ${routeName} could not be read`, error?.message ?? error);
        throw error;
      } finally {
        inFlight -= 1;
        controllers.delete(controller);
        if (flights.get(key) === flight) flights.delete(key);
      }
    })();
    flights.set(key, flight);
    return flight;
  }

  async function respond(request, response) {
    let raw;
    try {
      raw = await readBody(request, MAX_REQUEST_BYTES, requestBodyTimeoutMs);
    } catch (error) {
      refuse(request, response, 400, "MALFORMED_REQUEST", { detail: String(error?.message ?? error).slice(0, 64) });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      refuse(request, response, 400, "MALFORMED_REQUEST", { detail: "BODY_NOT_JSON" });
      return;
    }
    const parsed = validateHeatmapRequest(payload, routeName);
    if (parsed.error !== undefined) {
      refuse(request, response, 400, "MALFORMED_REQUEST", { detail: parsed.error });
      return;
    }
    const keyed = routeName === "heatmap-columns" ? { ...parsed.options, rowFactor: parsed.options.rowFactor ?? 1 } : parsed.options;
    const key = JSON.stringify([routeName, parsed.provider, parsed.marketKind, parsed.symbol, keyed, Object.keys(keyed).sort()]);
    const hit = cached(key, now());
    if (hit !== null) {
      counters.cached += 1;
      sendPayload(request, response, 200, hit);
      return;
    }
    let flight = flights.get(key);
    if (flight !== undefined && !flight.controller.signal.aborted) {
      counters.shared += 1;
    } else {
      if (inFlight >= maxConcurrent) {
        counters.busy += 1;
        refuse(request, response, 429, "BUSY", { retryAfterMs: BUSY_RETRY_AFTER_MS });
        return;
      }
      flight = startFlight(key, parsed);
    }
    const joined = flight;
    joined.waiters += 1;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      joined.waiters -= 1;
      if (joined.waiters === 0) joined.controller.abort();
    };
    response.once("close", leave);
    try {
      const body = await Promise.race([joined.promise, joined.abandoned]);
      if (response.destroyed) return;
      if (body === null) {
        refuse(request, response, 503, "HEATMAP_UNAVAILABLE");
        return;
      }
      counters.served += 1;
      sendPayload(request, response, 200, body);
    } catch {
      counters.failed += 1;
      refuse(request, response, 503, "HEATMAP_UNAVAILABLE");
    } finally {
      left = true;
      response.removeListener("close", leave);
    }
  }

  function handle(request, response) {
    if (request.url !== path) return false;
    if (request.method !== "POST") {
      refuse(request, response, 405, "METHOD_NOT_ALLOWED");
      return true;
    }
    if (disposed) {
      refuse(request, response, 503, "SERVER_SHUTTING_DOWN");
      return true;
    }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
      counters.forbidden += 1;
      refuse(request, response, 403, "ORIGIN_NOT_ALLOWED");
      return true;
    }
    const retryAfterMs = reserveRate(origin, now());
    if (retryAfterMs !== null) {
      refuse(request, response, 429, "RATE_BUDGET_EXCEEDED", { retryAfterMs });
      return true;
    }
    void respond(request, response);
    return true;
  }

  function stats() {
    return Object.freeze({ ...counters, inFlight, cacheEntries: cache.size, cacheBytes });
  }

  function dispose() {
    disposed = true;
    for (const controller of controllers) controller.abort();
    cache.clear();
    cacheBytes = 0;
  }

  return Object.freeze({ handle, stats, dispose });
}

module.exports = { createHeatmapRoute, validateHeatmapRequest, HEATMAP_COLUMNS_PATH, HEATMAP_WALLS_PATH, DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_MAX_BYTES, DEFAULT_RATE_LIMIT, DEFAULT_MAX_CONCURRENT };
