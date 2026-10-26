"use strict";

const crypto = require("node:crypto");
const { remoteErrorDiagnostic } = require("../remote-error-diagnostic");

const {
  CONTRACT_VERSION_HEADER,
  CONTRACT_VERSION,
} = require("../remote-storage-reader");
const {
  retryAfterMs, rateLimitWaitMs, createPauses,
  DEFAULT_RATE_LIMIT_BACKOFF_MS, MAX_RETRY_AFTER_MS, DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS,
} = require("../rate-limit-pause");
const { hostReadMeter } = require("../../platform/host-read-meter");

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES_BY_ROUTE = Object.freeze({ "recent-candles": 4_000_000, "aggressive-prints": 4_000_000, "band-history": 4_000_000 });
const LARGE_TRADES_SLICE_ROWS = 1_500;
const TIMEOUT_MS_BY_ROUTE = Object.freeze({ "recent-candles": 30_000, "aggressive-prints": 30_000, "band-history": 70_000, "volume-profile": 20_000 });

const FALLBACK_SHAPES = Object.freeze({
  "recent-events": () => ({ rows: [], available: false }),
  "recent-candles": () => ({ rows: [], available: false, startsAtRequestedWindow: false }),
  "large-trades": () => ({ rows: [], available: false }),
  "aggressive-prints": () => ({ rows: [], available: false, hasMore: false, nextCursor: null }),
  "volume-profile": () => ({ buckets: [], available: false }),
  "price-range": () => ({ minPrice: null, maxPrice: null, tradeCount: 0, available: false }),
  "minute-rollup": () => ({ rows: [], available: false }),
  "daily-notional": () => ({ rows: [], available: false }),
  "sliced-notional": () => ({ rows: [], available: false }),
  "trades-since": () => ({ rows: [], nextCursor: null, available: false }),
  "band-history": () => ({ columns: [], available: false, reason: "STORAGE_UNAVAILABLE" }),
});

const RESPONSE_PROTOTYPE = globalThis.Response?.prototype;
const STREAM_PROTOTYPE = globalThis.ReadableStream?.prototype;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validResponseShape(routeName, body) {
  if (!isRecord(body)) return false;
  if (routeName === "recent-candles") {
    return Array.isArray(body.rows) && typeof body.available === "boolean" &&
      typeof body.startsAtRequestedWindow === "boolean";
  }
  if (["recent-events", "large-trades", "minute-rollup", "daily-notional", "sliced-notional"].includes(routeName)) {
    return Array.isArray(body.rows) && typeof body.available === "boolean";
  }
  if (routeName === "aggressive-prints") {
    return Array.isArray(body.rows) && typeof body.available === "boolean" && typeof body.hasMore === "boolean" &&
      (body.nextCursor === null || isRecord(body.nextCursor));
  }
  if (routeName === "band-history") {
    return typeof body.available === "boolean" && Array.isArray(body.columns) && (body.reason === null || typeof body.reason === "string");
  }
  if (routeName === "trades-since") {
    return Array.isArray(body.rows) && typeof body.available === "boolean" &&
      (body.nextCursor === null ||
        (isRecord(body.nextCursor) && isNullableSafeInteger(body.nextCursor.ts) && body.nextCursor.ts !== null &&
          isNullableSafeInteger(body.nextCursor.id) && body.nextCursor.id !== null));
  }
  if (routeName === "volume-profile") return Array.isArray(body.buckets) && typeof body.available === "boolean";
  if (routeName === "price-range") {
    return typeof body.available === "boolean" && isNullableSafeInteger(body.tradeCount) &&
      (body.minPrice === null || Number.isFinite(body.minPrice)) &&
      (body.maxPrice === null || Number.isFinite(body.maxPrice));
  }
  return false;
}

function isGenuineResponse(response) {
  return response !== null && typeof response === "object" && RESPONSE_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(response) === RESPONSE_PROTOTYPE;
}

function isGenuineStream(stream) {
  return stream !== null && typeof stream === "object" && STREAM_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(stream) === STREAM_PROTOTYPE;
}

async function readBoundedJson(response, maxResponseBytes) {
  let body;
  try {
    body = response.body;
  } catch {
    return { ok: false };
  }
  if (!isGenuineStream(body)) return { ok: false };
  let reader;
  try {
    reader = body.getReader();
  } catch {
    return { ok: false };
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (!chunk || typeof chunk !== "object") {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      void 0;
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

function createRemoteDxFeedStorageReader({
  baseUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxResponseBytesByRoute = MAX_RESPONSE_BYTES_BY_ROUTE,
  timeoutMsByRoute = TIMEOUT_MS_BY_ROUTE,
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
  queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
  rateLimitRetryBudgetMs = DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS,
  fetchImpl = globalThis.fetch,
  log = (...args) => console.error(...args),
  warn = (...args) => console.warn(...args),
  meter = hostReadMeter,
} = {}) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("remote-dxfeed-storage-reader: baseUrl must be a non-empty string");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("remote-dxfeed-storage-reader: token must be a non-empty string");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("remote-dxfeed-storage-reader: timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("remote-dxfeed-storage-reader: maxResponseBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests <= 0) {
    throw new Error("remote-dxfeed-storage-reader: maxConcurrentRequests must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests <= 0 || !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs <= 0) {
    throw new Error("remote-dxfeed-storage-reader: invalid queue bounds");
  }
  if (!Number.isSafeInteger(rateLimitRetryBudgetMs) || rateLimitRetryBudgetMs < 0) {
    throw new Error("remote-dxfeed-storage-reader: rateLimitRetryBudgetMs must be a non-negative safe integer");
  }
  for (const [routeName, value] of Object.entries(maxResponseBytesByRoute)) {
    if (!Object.hasOwn(FALLBACK_SHAPES, routeName) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`remote-dxfeed-storage-reader: maxResponseBytesByRoute.${routeName} must name a route and be a positive safe integer`);
    }
  }
  for (const [routeName, value] of Object.entries(timeoutMsByRoute)) {
    if (!Object.hasOwn(FALLBACK_SHAPES, routeName) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`remote-dxfeed-storage-reader: timeoutMsByRoute.${routeName} must name a route and be a positive safe integer`);
    }
  }

  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const activeControllers = new Set();
  const pendingCalls = [];
  let activeCallCount = 0;
  let rateLimitedUntilMs = 0;
  let rateLimitTimer = null;
  let closed = false;
  const pauses = createPauses();

  async function performCall(routeName, symbol, assetClass, options = {}, context = {}) {
    const fallback = FALLBACK_SHAPES[routeName]();
    let waitedMs = 0;
    for (;;) {
      const outcome = await attemptCall(routeName, symbol, assetClass, options, context, fallback);
      if (outcome.rateLimitedMs === null) return outcome.value;
      const waitMs = outcome.rateLimitedMs;
      rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + waitMs);
      if (closed || context.signal?.aborted || waitedMs + waitMs > rateLimitRetryBudgetMs) {
        warn("remote-dxfeed-storage-reader: rate limited past the retry budget, giving up this read", routeName, { retryAfterMs: waitMs, waitedMs });
        return { ...fallback, reason: "RATE_LIMITED" };
      }
      warn("remote-dxfeed-storage-reader: rate limited, pausing queued reads", routeName, { retryAfterMs: waitMs });
      waitedMs += waitMs;
      await pauses.pause(waitMs, context.signal);
    }
  }

  async function attemptCall(routeName, symbol, assetClass, options, { signal } = {}, fallback) {
    const done = (value) => ({ rateLimitedMs: null, value });
    if (closed || signal?.aborted || typeof fetchImpl !== "function") return done(fallback);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    activeControllers.add(controller);
    const routeTimeoutMs = timeoutMsByRoute[routeName] ?? timeoutMs;
    const correlationId = crypto.randomUUID();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, routeTimeoutMs);
    try {
      let response;
      try {
        response = await Reflect.apply(fetchImpl, undefined, [
          `${base}/${routeName}`,
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
              "x-terminal-correlation-id": correlationId,
            },
            body: JSON.stringify({ provider: "dxfeed", symbol, assetClass, options }),
          },
        ]);
      } catch (error) {
        meter.record(routeName, null);
        if (!closed && !signal?.aborted) log("remote-dxfeed-storage-reader: request failed, falling back to unavailable", routeName, { correlationId, timedOut, reason: String(error?.message ?? error).split(token).join("[REDACTED]").slice(0, 256) });
        if (routeName === "volume-profile" && timedOut) return done({ ...fallback, reason: "READ_TIMEOUT" });
        return done(fallback);
      }
      meter.record(routeName, isGenuineResponse(response) ? response.status : null);
      if (!isGenuineResponse(response) || response.status < 200 || response.status >= 300) {
        const diagnostic = isGenuineResponse(response) ? await remoteErrorDiagnostic(response, correlationId, token) : { correlationId };
        if (isGenuineResponse(response) && response.status === 429) {
          warn("remote-dxfeed-storage-reader: overload response", routeName, diagnostic);
          return { rateLimitedMs: await rateLimitWaitMs(response), value: null };
        }
        log("remote-dxfeed-storage-reader: non-success response, falling back to unavailable", routeName, response?.status, diagnostic);
        if (isGenuineResponse(response)) void response.body?.cancel().catch(() => {});
        if (routeName === "band-history" && diagnostic.detail === "replay-page-reader: timeout") return done({ ...fallback, reason: "READ_TIMEOUT" });
        if (routeName === "volume-profile" && diagnostic.detail === "QUERY_TIMEOUT") return done({ ...fallback, reason: "READ_TIMEOUT" });
        return done(fallback);
      }
      if (response.headers.get(CONTRACT_VERSION_HEADER) !== CONTRACT_VERSION) {
        log("remote-dxfeed-storage-reader: contract version mismatch, falling back to unavailable", routeName);
        return done(fallback);
      }
      const parsed = await readBoundedJson(response, maxResponseBytesByRoute[routeName] ?? maxResponseBytes);
      if (!parsed.ok && timedOut) {
        log("remote-dxfeed-storage-reader: response body not received within the timeout, falling back to unavailable", routeName, routeTimeoutMs);
        return done(fallback);
      }
      if (!parsed.ok || !validResponseShape(routeName, parsed.body)) {
        log("remote-dxfeed-storage-reader: malformed response, falling back to unavailable", routeName);
        return done(fallback);
      }
      return done(parsed.body);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      activeControllers.delete(controller);
    }
  }

  function drainPendingCalls() {
    if (closed) return;
    const waitMs = rateLimitedUntilMs - Date.now();
    if (waitMs > 0) {
      if (rateLimitTimer === null) {
        rateLimitTimer = setTimeout(() => {
          rateLimitTimer = null;
          drainPendingCalls();
        }, waitMs);
        rateLimitTimer.unref?.();
      }
      return;
    }
    while (!closed && activeCallCount < maxConcurrentRequests && pendingCalls.length > 0) {
      const pending = pendingCalls.shift();
      pending.cleanup();
      activeCallCount += 1;
      performCall(...pending.args).then(pending.resolve, () => pending.resolve(pending.fallback)).finally(() => {
        activeCallCount -= 1;
        drainPendingCalls();
      });
    }
  }

  function call(routeName, symbol, assetClass, options = {}, context = {}) {
    const fallback = FALLBACK_SHAPES[routeName]();
    if (closed || context.signal?.aborted) return Promise.resolve(fallback);
    if (pendingCalls.length >= maxPendingRequests) {
      warn("remote-dxfeed-storage-reader: queue full", routeName, { pending: pendingCalls.length, maxPendingRequests });
      return Promise.resolve({ ...fallback, reason: "QUEUE_FULL" });
    }
    return new Promise((resolve) => {
      const remove = (reason) => {
        const index = pendingCalls.indexOf(pending);
        if (index < 0) return;
        pendingCalls.splice(index, 1);
        pending.cleanup();
        resolve(reason === null ? fallback : { ...fallback, reason });
      };
      const abort = () => remove(null);
      const timer = setTimeout(() => remove("QUEUE_TIMEOUT"), queueTimeoutMs);
      const pending = {
        args: [routeName, symbol, assetClass, options, context], fallback, resolve,
        cleanup: () => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); },
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      pendingCalls.push(pending);
      drainPendingCalls();
    });
  }

  async function readLargeTradesInSlices(symbol, assetClass, options = {}) {
    const { fromMs, nowMs, bucketMs, perBucketSideLimit, limit } = options;
    const timeCovered = [fromMs, nowMs, bucketMs, perBucketSideLimit].every(Number.isSafeInteger) &&
      bucketMs > 0 && perBucketSideLimit > 0 && nowMs >= fromMs;
    if (!timeCovered) return call("large-trades", symbol, assetClass, options);
    const sliceMs = Math.max(1, Math.floor(LARGE_TRADES_SLICE_ROWS / (2 * perBucketSideLimit))) * bucketMs;
    const pages = [];
    let collected = 0;
    let toMs = nowMs;
    while (toMs >= fromMs && !closed) {
      const sliceFromMs = Math.max(fromMs, Math.floor(toMs / sliceMs) * sliceMs);
      const result = await call("large-trades", symbol, assetClass, { ...options, fromMs: sliceFromMs, nowMs: toMs });
      if (!result.available) {
        if (pages.length === 0) return result;
        log("remote-dxfeed-storage-reader: a large-trades slice was unavailable, keeping the newer slices already read", "large-trades", { fromMs: sliceFromMs, toMs });
        break;
      }
      pages.push(result.rows);
      collected += result.rows.length;
      if (Number.isSafeInteger(limit) && collected >= limit) break;
      toMs = sliceFromMs - 1;
    }
    return { rows: pages.reverse().flat(), available: true };
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    if (rateLimitTimer !== null) clearTimeout(rateLimitTimer);
    rateLimitTimer = null;
    pauses.releaseAll();
    for (const pending of pendingCalls.splice(0)) { pending.cleanup(); pending.resolve(pending.fallback); }
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    return Promise.resolve();
  }

  return Object.freeze({
    dbPath: undefined,
    remote: Object.freeze({ provider: "dxfeed", baseUrl: base, token, timeoutMs }),
    readRecent: (symbol, assetClass, eventType, options = {}) => call("recent-events", symbol, assetClass, { ...options, eventType }),
    readRecentCandles: (symbol, assetClass, options) => call("recent-candles", symbol, assetClass, options),
    readLargeTrades: readLargeTradesInSlices,
    readLargeTradesAsync: readLargeTradesInSlices,
    readAggressivePrints: (symbol, assetClass, options) => call("aggressive-prints", symbol, assetClass, options),
    readAggressivePrintsAsync: (symbol, assetClass, options, context) => call("aggressive-prints", symbol, assetClass, options, context),
    readVolumeProfile: (symbol, assetClass, options) => call("volume-profile", symbol, assetClass, options),
    readVolumeProfileAsync: (symbol, assetClass, options, context) => call("volume-profile", symbol, assetClass, options, context),
    readPriceRange: (symbol, assetClass, options) => call("price-range", symbol, assetClass, options),
    readMinuteRollup: (symbol, assetClass, options) => call("minute-rollup", symbol, assetClass, options),
    readDailyNotional: (symbol, assetClass, options) => call("daily-notional", symbol, assetClass, options),
    readSlicedNotional: (symbol, assetClass, options) => call("sliced-notional", symbol, assetClass, options),
    readTradesSince: (symbol, assetClass, options) => call("trades-since", symbol, assetClass, options),
    readBandHistory: (symbol, assetClass, options, context) => call("band-history", symbol, assetClass, options, context),
    close,
  });
}

module.exports = {
  createRemoteDxFeedStorageReader, FALLBACK_SHAPES, validResponseShape,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT_REQUESTS, DEFAULT_RATE_LIMIT_BACKOFF_MS, MAX_RETRY_AFTER_MS,
  TIMEOUT_MS_BY_ROUTE, MAX_RESPONSE_BYTES_BY_ROUTE, DEFAULT_MAX_RESPONSE_BYTES, retryAfterMs,
};
