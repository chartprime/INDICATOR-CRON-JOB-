"use strict";

const crypto = require("node:crypto");
const { remoteErrorDiagnostic } = require("./remote-error-diagnostic");
const { rateLimitWaitMs, createPauses, DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS } = require("./rate-limit-pause");
const { hostReadMeter } = require("../platform/host-read-meter");

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES_BY_ROUTE = Object.freeze({ "recent-candles": 4_000_000, "band-history": 4_000_000, "heatmap-columns": 2_200_000, "event-history": 2_200_000 });
const TIMEOUT_MS_BY_ROUTE = Object.freeze({ "recent-candles": 30_000, "aggressive-prints": 20_000, "band-history": 70_000, "heatmap-columns": 25_000, "wall-history": 25_000, "event-history": 25_000, "volume-profile": 20_000, "iceberg-history": 25_000 });
const CONTRACT_VERSION_HEADER = "x-live-storage-contract-version";
const CONTRACT_VERSION = "live-storage/1";

const RESPONSE_PROTOTYPE = globalThis.Response?.prototype;
const STREAM_PROTOTYPE = globalThis.ReadableStream?.prototype;

const FALLBACK_SHAPES = Object.freeze({
  "recent-candles": () => ({ rows: [], coversFullWindow: false }),
  "recent-trades": (options) => (options?.limit === null || options?.limit === undefined
    ? { rows: [], available: false }
    : { rows: [], nextCursor: null, available: false }),
  "large-trades": () => ({ rows: [], available: false }),
  "aggressive-prints": () => ({ rows: [], available: false, hasMore: false, nextCursor: null }),
  "volume-profile": () => ({ buckets: [], available: false }),
  "price-range": () => ({ minPrice: null, maxPrice: null, tradeCount: 0, available: false }),
  "minute-rollup": () => ({ rows: [], available: false }),
  "daily-notional": () => ({ rows: [], available: false }),
  "sliced-notional": () => ({ rows: [], available: false }),
  "recording-age": () => ({ latestTs: null, ageMs: null, available: false }),
  "band-history": () => ({ columns: [], available: false, reason: "STORAGE_UNAVAILABLE" }),
  "heatmap-columns": () => ({ available: false, reason: "STORAGE_UNAVAILABLE", windows: [], next: null }),
  "wall-history": () => ({ available: false, reason: "STORAGE_UNAVAILABLE", walls: [], next: null }),
  "event-history": () => ({ available: false, reason: "STORAGE_UNAVAILABLE", windows: [], next: null }),
  "iceberg-history": () => ({ available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null }),
});

function isHeatmapWindow(window) {
  return isRecord(window) && Number.isSafeInteger(window.ts) && typeof window.state === "string" && Array.isArray(window.columns);
}

function validHeatmapPage(body) {
  if (body.available === false) return typeof body.reason === "string";
  return body.available === true
    && Array.isArray(body.windows) && body.windows.every(isHeatmapWindow)
    && isRecord(body.geometry) && Number.isFinite(body.geometry.rowWidth) && body.geometry.rowWidth > 0
    && Number.isSafeInteger(body.levelMs) && Number.isSafeInteger(body.rowFactor)
    && (body.next === null || Number.isSafeInteger(body.next))
    && isRecord(body.span);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPyramidPage(body) {
  return body.available === true && typeof body.generation === "string"
    && isRecord(body.geometry) && Number.isFinite(body.geometry.rowWidth) && body.geometry.rowWidth > 0
    && isRecord(body.span);
}

function isHistoryWall(wall) {
  return isRecord(wall) && (wall.side === "bid" || wall.side === "ask")
    && Number.isSafeInteger(wall.row) && Number.isSafeInteger(wall.span) && wall.span >= 1
    && Number.isSafeInteger(wall.startTs) && Number.isSafeInteger(wall.endTs) && typeof wall.endedBy === "string"
    && Number.isFinite(wall.peak) && Number.isFinite(wall.size);
}

function validWallHistoryPage(body) {
  if (body.available === false) return typeof body.reason === "string";
  return validPyramidPage(body)
    && Array.isArray(body.walls) && body.walls.every(isHistoryWall)
    && (body.next === null || (isRecord(body.next) && Number.isSafeInteger(body.next.endTs) && Number.isSafeInteger(body.next.id)));
}

function isEventWindow(window) {
  return isRecord(window) && Number.isSafeInteger(window.ts) && isRecord(window.events)
    && Array.isArray(window.events.trades) && Array.isArray(window.events.wallTrades) && isRecord(window.events.fill);
}

function validEventHistoryPage(body) {
  if (body.available === false) return typeof body.reason === "string";
  return validPyramidPage(body)
    && Array.isArray(body.windows) && body.windows.every(isEventWindow)
    && (body.next === null || Number.isSafeInteger(body.next));
}

function isSpanPair(value) {
  return Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]) && value[0] < value[1];
}

function isHistoryIceberg(entry) {
  return isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0 && Number.isSafeInteger(entry.markedAt) && Number.isSafeInteger(entry.updatedAt) && typeof entry.status === "string";
}

function validIcebergHistoryPage(body) {
  if (body.available === false) return typeof body.reason === "string";
  return body.available === true && typeof body.generation === "string" && Number.isSafeInteger(body.rulesVersion)
    && isRecord(body.span) && Number.isSafeInteger(body.span.from) && Number.isSafeInteger(body.span.to)
    && Array.isArray(body.watched) && body.watched.every(isSpanPair)
    && Array.isArray(body.icebergs) && body.icebergs.every(isHistoryIceberg)
    && (body.next === null || (isRecord(body.next) && Number.isSafeInteger(body.next.markedAt) && typeof body.next.id === "string"));
}

function isNullableSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validResponseShape(routeName, body) {
  if (!isRecord(body)) return false;
  if (routeName === "recent-candles") return Array.isArray(body.rows) && typeof body.coversFullWindow === "boolean";
  if (["recent-trades", "large-trades", "minute-rollup", "daily-notional", "sliced-notional"].includes(routeName)) {
    return Array.isArray(body.rows) && typeof body.available === "boolean";
  }
  if (routeName === "aggressive-prints") {
    return Array.isArray(body.rows) && typeof body.available === "boolean" && typeof body.hasMore === "boolean"
      && (body.nextCursor === null || isRecord(body.nextCursor));
  }
  if (routeName === "volume-profile") return Array.isArray(body.buckets) && typeof body.available === "boolean";
  if (routeName === "price-range") {
    return typeof body.available === "boolean" && isNullableSafeInteger(body.tradeCount)
      && (body.minPrice === null || Number.isFinite(body.minPrice))
      && (body.maxPrice === null || Number.isFinite(body.maxPrice));
  }
  if (routeName === "recording-age") {
    return typeof body.available === "boolean" && isNullableSafeInteger(body.latestTs) && isNullableSafeInteger(body.ageMs);
  }
  if (routeName === "band-history") {
    return typeof body.available === "boolean" && Array.isArray(body.columns) && (body.reason === null || typeof body.reason === "string");
  }
  if (routeName === "heatmap-columns") return validHeatmapPage(body);
  if (routeName === "wall-history") return validWallHistoryPage(body);
  if (routeName === "event-history") return validEventHistoryPage(body);
  if (routeName === "iceberg-history") return validIcebergHistoryPage(body);
  return false;
}

function isGenuineResponse(response) {
  return (
    response !== null &&
    typeof response === "object" &&
    RESPONSE_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(response) === RESPONSE_PROTOTYPE
  );
}

function isGenuineStream(stream) {
  return (
    stream !== null &&
    typeof stream === "object" &&
    STREAM_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(stream) === STREAM_PROTOTYPE
  );
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function createRemoteStorageReader({
  baseUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxResponseBytesByRoute = MAX_RESPONSE_BYTES_BY_ROUTE,
  timeoutMsByRoute = TIMEOUT_MS_BY_ROUTE,
  rateLimitRetryBudgetMs = DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS,
  fetchImpl = globalThis.fetch,
  log = (...args) => console.error(...args),
  warn = (...args) => console.warn(...args),
  meter = hostReadMeter,
} = {}) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("remote-storage-reader: baseUrl must be a non-empty string");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("remote-storage-reader: token must be a non-empty string");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("remote-storage-reader: timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("remote-storage-reader: maxResponseBytes must be a positive safe integer");
  }
  for (const [routeName, value] of Object.entries(maxResponseBytesByRoute)) {
    if (!Object.hasOwn(FALLBACK_SHAPES, routeName) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`remote-storage-reader: maxResponseBytesByRoute.${routeName} must name a route and be a positive safe integer`);
    }
  }
  for (const [routeName, value] of Object.entries(timeoutMsByRoute)) {
    if (!Object.hasOwn(FALLBACK_SHAPES, routeName) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`remote-storage-reader: timeoutMsByRoute.${routeName} must name a route and be a positive safe integer`);
    }
  }

  if (!Number.isSafeInteger(rateLimitRetryBudgetMs) || rateLimitRetryBudgetMs < 0) {
    throw new Error("remote-storage-reader: rateLimitRetryBudgetMs must be a non-negative safe integer");
  }

  let closed = false;
  let rateLimitedUntilMs = 0;
  const pauses = createPauses();
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  async function call(routeName, symbol, marketKind, options = {}, context = {}) {
    const fallback = FALLBACK_SHAPES[routeName](options);
    let waitedMs = 0;
    for (;;) {
      const pausedMs = rateLimitedUntilMs - Date.now();
      if (pausedMs > 0 && !closed) {
        if (waitedMs + pausedMs > rateLimitRetryBudgetMs) return { ...fallback, reason: "RATE_LIMITED" };
        waitedMs += pausedMs;
        await pauses.pause(pausedMs, context.signal);
      }
      const outcome = await attemptCall(routeName, symbol, marketKind, options, context, fallback);
      if (outcome.rateLimitedMs === null) return outcome.value;
      const waitMs = outcome.rateLimitedMs;
      rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + waitMs);
      if (closed || context.signal?.aborted || waitedMs + waitMs > rateLimitRetryBudgetMs) {
        warn("remote-storage-reader: rate limited past the retry budget, giving up this read", routeName, { retryAfterMs: waitMs, waitedMs });
        return { ...fallback, reason: "RATE_LIMITED" };
      }
      warn("remote-storage-reader: rate limited, retrying after the host's wait", routeName, { retryAfterMs: waitMs });
    }
  }

  async function attemptCall(routeName, symbol, marketKind, options, { signal, provider } = {}, fallback) {
    const done = (value) => ({ rateLimitedMs: null, value });
    if (closed || typeof fetchImpl !== "function") return done(fallback);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const routeTimeoutMs = timeoutMsByRoute[routeName] ?? timeoutMs;
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
              "x-terminal-correlation-id": crypto.randomUUID(),
            },
            body: JSON.stringify(provider === "dxfeed" ? { provider, symbol, assetClass: marketKind, options } : { symbol, marketKind, options }),
          },
        ]);
      } catch (error) {
        meter.record(routeName, null);
        log("remote-storage-reader: request failed, falling back to unavailable", routeName, error?.message ?? error);
        if (routeName === "volume-profile" && timedOut) return done({ ...fallback, reason: "READ_TIMEOUT" });
        return done(fallback);
      }
      meter.record(routeName, isGenuineResponse(response) ? response.status : null);
      if (isGenuineResponse(response) && response.status === 429) {
        warn("remote-storage-reader: overload response", routeName, await remoteErrorDiagnostic(response, response.headers.get("x-terminal-correlation-id"), token));
        return { rateLimitedMs: await rateLimitWaitMs(response), value: null };
      }
      if (!isGenuineResponse(response) || response.status < 200 || response.status >= 300) {
        const diagnostic = isGenuineResponse(response) ? await remoteErrorDiagnostic(response, response.headers.get("x-terminal-correlation-id"), token) : null;
        log("remote-storage-reader: non-success response, falling back to unavailable", routeName, response?.status,
          diagnostic);
        if (isGenuineResponse(response)) void response.body?.cancel().catch(() => {});
        if (routeName === "band-history" && diagnostic?.detail === "replay-page-reader: timeout") return done({ ...fallback, reason: "READ_TIMEOUT" });
        if (routeName === "volume-profile" && diagnostic?.detail === "QUERY_TIMEOUT") return done({ ...fallback, reason: "READ_TIMEOUT" });
        return done(fallback);
      }
      if (response.headers.get(CONTRACT_VERSION_HEADER) !== CONTRACT_VERSION) {
        log("remote-storage-reader: contract version mismatch, falling back to unavailable", routeName);
        return done(fallback);
      }
      const parsed = await readBoundedJson(response, maxResponseBytesByRoute[routeName] ?? maxResponseBytes);
      if (!parsed.ok && timedOut) {
        log("remote-storage-reader: response body not received within the timeout, falling back to unavailable", routeName, routeTimeoutMs);
        return done(fallback);
      }
      if (!parsed.ok || !validResponseShape(routeName, parsed.body)) {
        log("remote-storage-reader: malformed response, falling back to unavailable", routeName);
        return done(fallback);
      }
      return done(parsed.body);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  function close() {
    closed = true;
    pauses.releaseAll();
    return Promise.resolve();
  }

  return Object.freeze({
    dbPath: undefined,
    remote: Object.freeze({ baseUrl: base, token, timeoutMs }),
    readRecentCandles: (symbol, marketKind, options) => call("recent-candles", symbol, marketKind, options),
    readRecentTrades: (symbol, marketKind, options) => call("recent-trades", symbol, marketKind, options),
    readLargeTrades: (symbol, marketKind, options) => call("large-trades", symbol, marketKind, options),
    readLargeTradesAsync: (symbol, marketKind, options) => call("large-trades", symbol, marketKind, options),
    readAggressivePrints: (symbol, marketKind, options) => call("aggressive-prints", symbol, marketKind, options),
    readAggressivePrintsAsync: (symbol, marketKind, options, context) => call("aggressive-prints", symbol, marketKind, options, context),
    readVolumeProfile: (symbol, marketKind, options) => call("volume-profile", symbol, marketKind, options),
    readVolumeProfileAsync: (symbol, marketKind, options, context) => call("volume-profile", symbol, marketKind, options, context),
    readPriceRange: (symbol, marketKind, options) => call("price-range", symbol, marketKind, options),
    readMinuteRollup: (symbol, marketKind, options) => call("minute-rollup", symbol, marketKind, options),
    readDailyNotional: (symbol, marketKind, options) => call("daily-notional", symbol, marketKind, options),
    readSlicedNotional: (symbol, marketKind, options) => call("sliced-notional", symbol, marketKind, options),
    readRecordingAge: (symbol, marketKind, options) => call("recording-age", symbol, marketKind, options),
    readBandHistory: (symbol, marketKind, options, context) => call("band-history", symbol, marketKind, options, context),
    readHeatmapColumns: (symbol, marketKind, options, context) => call("heatmap-columns", symbol, marketKind, options, context),
    readWallHistory: (symbol, marketKind, options, context) => call("wall-history", symbol, marketKind, options, context),
    readEventHistory: (symbol, marketKind, options, context) => call("event-history", symbol, marketKind, options, context),
    readIcebergHistory: (symbol, marketKind, options, context) => call("iceberg-history", symbol, marketKind, options, context),
    close,
  });
}

module.exports = {
  createRemoteStorageReader, FALLBACK_SHAPES, CONTRACT_VERSION_HEADER, CONTRACT_VERSION, validResponseShape,
  DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES_BY_ROUTE, DEFAULT_TIMEOUT_MS, TIMEOUT_MS_BY_ROUTE,
};
