const { types: utilTypes } = require("node:util");
const { restBaseUrlFor, isAllowedCandleInterval } = require("./binance-config");
const { assertAllowedSymbol, assertAllowedMarketKind } = require("./binance-subscription-guard");

const RESPONSE_PROTOTYPE = globalThis.Response?.prototype;
const STREAM_PROTOTYPE = globalThis.ReadableStream?.prototype;

const DEPTH_SNAPSHOT_PATHS = Object.freeze({
  SPOT: "/api/v3/depth",
  PERPETUAL: "/fapi/v1/depth",
});

const SERVER_TIME_PATHS = Object.freeze({
  SPOT: "/api/v3/time",
  PERPETUAL: "/fapi/v1/time",
});


const DEPTH_SNAPSHOT_LIMITS = Object.freeze({
  SPOT: "5000",
  PERPETUAL: "1000",
});

const KLINES_PATHS = Object.freeze({
  SPOT: "/api/v3/klines",
  PERPETUAL: "/fapi/v1/klines",
});

const EXCHANGE_INFO_PATHS = Object.freeze({
  SPOT: "/api/v3/exchangeInfo",
  PERPETUAL: "/fapi/v1/exchangeInfo",
});

const MAX_KLINES_PER_REQUEST = 1000;

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function failure(reason, extra = {}) {
  return Object.freeze({ ok: false, reason, ...extra });
}

function parseRetryAfterMs(headers, nowMs = Date.now()) {
  const headerEntry = headers && typeof headers === "object"
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")
    : undefined;
  const raw = headerEntry?.[1];
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
  const deadlineMs = Date.parse(trimmed);
  return Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - nowMs) : undefined;
}

function success(value) {
  return Object.freeze({ ok: true, value: Object.freeze(value) });
}

function plainHeadersFrom(headers) {
  const record = {};
  if (!headers || typeof headers.entries !== "function") {
    return record;
  }
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  return record;
}

function isGenuineResponse(response) {
  return (
    response !== null &&
    typeof response === "object" &&
    !utilTypes.isProxy(response) &&
    RESPONSE_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(response) === RESPONSE_PROTOTYPE
  );
}

function isGenuineStream(stream) {
  return (
    stream !== null &&
    typeof stream === "object" &&
    !utilTypes.isProxy(stream) &&
    STREAM_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(stream) === STREAM_PROTOTYPE
  );
}

async function readBoundedBody(response, maxBytes) {
  let body;
  try {
    body = response.body;
  } catch {
    return failure("INVALID_RESPONSE");
  }
  if (!isGenuineResponse(response) || !isGenuineStream(body)) {
    return failure("INVALID_RESPONSE");
  }

  let reader;
  try {
    reader = body.getReader();
  } catch {
    return failure("INVALID_RESPONSE");
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk || typeof chunk !== "object") {
        await reader.cancel().catch(() => {});
        return failure("INVALID_RESPONSE");
      }
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return failure("INVALID_RESPONSE");
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return failure("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } catch {
    return failure("NETWORK_ERROR");
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
  return success({ bytes });
}

async function discardResponseBody(response) {
  try {
    const body = response.body;
    if (isGenuineStream(body)) await body.cancel();
  } catch {
    void 0;
  }
}

function decodeJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure("MALFORMED_RESPONSE_BODY");
  }
  try {
    return success({ body: JSON.parse(text) });
  } catch {
    return failure("MALFORMED_RESPONSE_BODY");
  }
}

// `signal` lets a caller cancel the request (a subscription ending while its
// poll is in flight); the result is then ABORTED rather than TIMEOUT.
async function timedGetJson(url, { fetchImpl, timeoutMs, maxResponseBytes, signal }) {
  if (typeof fetchImpl !== "function") {
    return failure("FETCH_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timedGetJson: timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("timedGetJson: maxResponseBytes must be a positive safe integer");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error("timedGetJson: signal must be an AbortSignal when provided");
  }
  if (signal?.aborted) {
    return failure("ABORTED");
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  let timer;
  let settleDeadline;
  const deadline = new Promise((resolve) => {
    settleDeadline = resolve;
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure("TIMEOUT"));
    }, timeoutMs);
  });

  const attempt = performGetRequest({ controller, fetchImpl, maxResponseBytes, url, signal });

  try {
    const result = await Promise.race([attempt, deadline]);
    return signal?.aborted ? failure("ABORTED") : result;
  } finally {
    clearTimeout(timer);
    settleDeadline(failure("TIMEOUT"));
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function performGetRequest({ controller, fetchImpl, maxResponseBytes, url, signal }) {
  let response;
  try {
    response = await Reflect.apply(fetchImpl, undefined, [
      url.toString(),
      { method: "GET", redirect: "error", signal: controller.signal },
    ]);
  } catch (error) {
    if (error?.name === "AbortError") {
      return signal?.aborted ? failure("ABORTED") : failure("TIMEOUT");
    }
    return failure("NETWORK_ERROR");
  }

  if (!isGenuineResponse(response)) {
    return failure("INVALID_RESPONSE");
  }

  let headers;
  let status;
  try {
    headers = plainHeadersFrom(response.headers);
    status = response.status;
  } catch {
    return failure("INVALID_RESPONSE");
  }

  if (status < 200 || status >= 300) {
    await discardResponseBody(response);
    const frozenHeaders = Object.freeze(headers);
    // 429 is a rate limit the caller waits out; 418 is an IP ban that stops
    // every request for the whole Retry-After window. Both keep their status
    // and headers (Retry-After, x-mbx-used-weight-1m) for the caller's budget.
    if (status === 429 || status === 418) {
      const retryAfterMs = parseRetryAfterMs(headers);
      return failure(status === 418 ? "IP_BANNED" : "RATE_LIMITED", {
        status,
        headers: frozenHeaders,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    return failure("HTTP_ERROR", { status, headers: frozenHeaders });
  }

  const read = await readBoundedBody(response, maxResponseBytes);
  if (!read.ok) {
    return read;
  }

  const parsed = decodeJson(read.value.bytes);
  if (!parsed.ok) {
    return parsed;
  }

  return success({ status, headers, body: parsed.value.body });
}

async function fetchDepthSnapshot(marketKind, symbol, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    baseUrl: baseUrlOverride,
    signal,
  } = options;

  assertAllowedMarketKind(marketKind);
  assertAllowedSymbol(symbol);

  const baseUrl = baseUrlOverride ?? restBaseUrlFor(marketKind);
  const path = DEPTH_SNAPSHOT_PATHS[marketKind];
  const url = new URL(path, baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("limit", DEPTH_SNAPSHOT_LIMITS[marketKind]);

  return timedGetJson(url, { fetchImpl, timeoutMs, maxResponseBytes, signal });
}

async function fetchKlines(marketKind, symbol, options = {}) {
  const {
    interval,
    startTime,
    limit = MAX_KLINES_PER_REQUEST,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    baseUrl: baseUrlOverride,
    signal,
  } = options;

  assertAllowedMarketKind(marketKind);
  assertAllowedSymbol(symbol);
  if (!isAllowedCandleInterval(interval)) {
    throw new Error("fetchKlines: interval must be an allowed Binance candle interval");
  }
  if (!Number.isSafeInteger(startTime) || startTime < 0) {
    throw new Error("fetchKlines: startTime must be a safe non-negative integer (ms)");
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_KLINES_PER_REQUEST) {
    throw new Error(`fetchKlines: limit must be a positive integer <= ${MAX_KLINES_PER_REQUEST}`);
  }

  const baseUrl = baseUrlOverride ?? restBaseUrlFor(marketKind);
  const path = KLINES_PATHS[marketKind];
  const url = new URL(path, baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("limit", String(limit));

  return timedGetJson(url, { fetchImpl, timeoutMs, maxResponseBytes, signal });
}

async function fetchServerTime(marketKind, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    baseUrl: baseUrlOverride,
    signal,
  } = options;

  assertAllowedMarketKind(marketKind);

  const baseUrl = baseUrlOverride ?? restBaseUrlFor(marketKind);
  const url = new URL(SERVER_TIME_PATHS[marketKind], baseUrl);

  return timedGetJson(url, { fetchImpl, timeoutMs, maxResponseBytes, signal });
}

async function fetchExchangeInfo(marketKind, symbol, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    baseUrl: baseUrlOverride,
    signal,
  } = options;

  assertAllowedMarketKind(marketKind);
  assertAllowedSymbol(symbol);

  const baseUrl = baseUrlOverride ?? restBaseUrlFor(marketKind);
  const path = EXCHANGE_INFO_PATHS[marketKind];
  const url = new URL(path, baseUrl);
  url.searchParams.set("symbol", symbol);

  return timedGetJson(url, { fetchImpl, timeoutMs, maxResponseBytes, signal });
}

module.exports = {
  fetchDepthSnapshot,
  fetchKlines,
  fetchServerTime,
  fetchExchangeInfo,
  MAX_KLINES_PER_REQUEST,
  parseRetryAfterMs,
  DEFAULT_TIMEOUT_MS,
};
