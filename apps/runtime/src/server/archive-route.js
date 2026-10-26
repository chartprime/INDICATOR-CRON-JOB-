"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { createArchiveAuth } = require("./archive-auth");
const { retryAfterHeaders } = require("./retry-after");

const ARCHIVE_QUERY_PATH = "/archive/query";
const CONTRACT_VERSION = "archive-query/1";
const MAX_REQUEST_BYTES = 65_536;
const MAX_LIMIT = 10_000;
const MIN_LIMIT = 1;
const MAX_INSTRUMENT_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 512;
const MAX_POINTER_TOKEN_LENGTH = 512;
const MAX_SCAN_BYTES = 268_435_456;
const FAMILIES = Object.freeze([
  "candle", "candle_1m", "candle_1h", "candle_1d", "trade", "quote", "depth",
  "trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m",
]);
const REQUEST_FIELDS = Object.freeze([
  "contractVersion", "instrumentId", "family", "from", "to",
  "limit", "cursor", "maxScanBytes", "pointerToken",
]);
const REQUIRED_FIELDS = Object.freeze(["contractVersion", "instrumentId", "family", "from", "to"]);

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUE_WAIT_MS = 15_000;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 72, windowMs: 60_000 });
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const GZIP_THRESHOLD_BYTES = 1_024;
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1024 * 1024;

const MALFORMED_REQUEST = "MALFORMED_REQUEST";
const UNAUTHORIZED = "UNAUTHORIZED";
const OVERLOADED = "OVERLOADED";
const READER_UNAVAILABLE = "READER_UNAVAILABLE";
const CANCELLED = "CANCELLED";
const INVALID_WINDOW = "INVALID_WINDOW";
const UNSUPPORTED_FAMILY = "UNSUPPORTED_FAMILY";
const RESTART_CODES = Object.freeze(["POINTER_TOKEN_INVALID", "CURSOR_MALFORMED"]);
const RESTART_HEADER = "x-archive-restart";
const CORRELATION_ID_HEADER = "x-terminal-correlation-id";
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REFUSAL_STATUS = Object.freeze({
  MALFORMED_REQUEST: 400,
  UNAUTHORIZED: 401,
  INVALID_WINDOW: 400,
  UNSUPPORTED_FAMILY: 400,
  CURSOR_MALFORMED: 400,
  CURSOR_POINTER_MISMATCH: 400,
  UNKNOWN_INSTRUMENT: 404,
  POINTER_TOKEN_INVALID: 409,
  RANGE_TOO_LARGE: 413,
  WINDOW_TOO_LARGE: 413,
  OVERLOADED: 429,
  CANCELLED: 499,
  CATALOG_INTEGRITY_FAILURE: 500,
  PARTITION_VERIFICATION_FAILED: 500,
  ESTIMATE_UNVERIFIED: 503,
  CACHE_CAPACITY_EXCEEDED: 503,
  READER_UNAVAILABLE: 503,
});

const SUCCESS_RESPONSE_FIELDS = Object.freeze([
  "contractVersion", "pointer", "pointerToken", "family", "rows",
  "nextCursor", "queryFingerprint", "coverage", "scan",
]);
const ERROR_RESPONSE_FIELDS = Object.freeze([
  "contractVersion", "error", "family", "detail", "requestedWindowNs",
  "maxWindowNs", "estimatedScanBytes", "effectiveMaxScanBytes", "retryAfterMs",
]);

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COVERAGE_STATES = new Set([
  "PUBLISHED", "QUIET", "MARKET_CLOSED", "MISSING", "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN",
]);
const GAP_STATES = new Set(["MISSING", "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN"]);
const COVERAGE_FIELDS = new Set(["requested", "served", "partitions", "states", "gaps", "corrupt"]);
const SCAN_INTEGER_FIELDS = new Set([
  "partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead", "cacheHits", "cacheMisses",
]);
const SCAN_DURATION_FIELDS = new Set(["fetchMs", "queryMs"]);

function errorBody(code, reason) {
  const body = { contractVersion: CONTRACT_VERSION, error: code };
  if (reason !== undefined) body.detail = String(reason).slice(0, 512);
  return body;
}

function validateRequest(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return errorBody(MALFORMED_REQUEST, "REQUEST_NOT_AN_OBJECT");
  }
  if (payload.contractVersion !== CONTRACT_VERSION) {
    return errorBody(MALFORMED_REQUEST, "CONTRACT_VERSION_MISMATCH");
  }
  const unknown = Object.keys(payload).filter((key) => !REQUEST_FIELDS.includes(key));
  if (unknown.length > 0) {
    return errorBody(MALFORMED_REQUEST, `UNKNOWN_REQUEST_FIELDS:${unknown.sort().join(",")}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in payload)) return errorBody(MALFORMED_REQUEST, `MISSING_REQUEST_FIELD:${field}`);
  }
  if (typeof payload.instrumentId !== "string" || payload.instrumentId.length === 0
      || payload.instrumentId.length > MAX_INSTRUMENT_ID_LENGTH) {
    return errorBody(MALFORMED_REQUEST, "INSTRUMENT_ID_NOT_A_STRING");
  }
  if (!FAMILIES.includes(payload.family)) return errorBody(UNSUPPORTED_FAMILY, "FAMILY_OUTSIDE_CONTRACT");
  for (const field of ["from", "to"]) {
    if (typeof payload[field] !== "string" || !DECIMAL_PATTERN.test(payload[field])) {
      return errorBody(INVALID_WINDOW, `${field.toUpperCase()}_NOT_DECIMAL_NANOSECONDS`);
    }
  }
  if (BigInt(payload.to) <= BigInt(payload.from)) {
    return errorBody(INVALID_WINDOW, "WINDOW_NOT_HALF_OPEN");
  }
  if ("limit" in payload) {
    const limit = payload.limit;
    if (!Number.isSafeInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
      return errorBody(MALFORMED_REQUEST, `LIMIT_OUTSIDE_BOUNDS:${String(limit).slice(0, 32)}`);
    }
  }
  if ("cursor" in payload && payload.cursor !== null
      && (typeof payload.cursor !== "string" || payload.cursor.length === 0
          || payload.cursor.length > MAX_CURSOR_LENGTH)) {
    return errorBody(MALFORMED_REQUEST, "CURSOR_NOT_A_STRING");
  }
  if ("pointerToken" in payload && payload.pointerToken !== null
      && (typeof payload.pointerToken !== "string" || payload.pointerToken.length === 0
          || payload.pointerToken.length > MAX_POINTER_TOKEN_LENGTH
          || !/^[A-Za-z0-9_-]+$/.test(payload.pointerToken))) {
    return errorBody(MALFORMED_REQUEST, "POINTER_TOKEN_NOT_A_STRING");
  }
  if ("maxScanBytes" in payload
      && (!Number.isSafeInteger(payload.maxScanBytes) || payload.maxScanBytes < 1
          || payload.maxScanBytes > MAX_SCAN_BYTES)) {
    return errorBody(MALFORMED_REQUEST, "MAX_SCAN_BYTES_OUTSIDE_BOUNDS");
  }
  return null;
}

function loopbackServiceUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("archive-route: serviceUrl must be a string");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("archive-route: serviceUrl must be an absolute loopback URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.pathname !== "/query" || url.search || url.hash || url.username || url.password) {
    throw new Error("archive-route: serviceUrl must be an unauthenticated loopback /query URL");
  }
  return url.href;
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

async function readUpstreamBody(upstream, limitBytes) {
  const declared = upstream.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limitBytes) {
    throw new Error("UPSTREAM_BODY_TOO_LARGE");
  }
  if (upstream.body === null) return "";
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new Error("UPSTREAM_BODY_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWindow(value) {
  if (!isRecord(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "from") || !Object.hasOwn(value, "to")
      || typeof value.from !== "string" || typeof value.to !== "string"
      || !DECIMAL_PATTERN.test(value.from) || !DECIMAL_PATTERN.test(value.to)) return false;
  return BigInt(value.from) < BigInt(value.to);
}

function isCoverageEntry(value, states) {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.date === "string" && DATE_PATTERN.test(value.date)
    && typeof value.state === "string" && states.has(value.state);
}

function isCorruptEntry(value) {
  return isRecord(value)
    && Object.keys(value).every((field) => field === "date" || field === "reason")
    && typeof value.date === "string" && DATE_PATTERN.test(value.date)
    && (!Object.hasOwn(value, "reason") || value.reason === null
      || (typeof value.reason === "string" && value.reason.length <= 128));
}

function isCoverage(value) {
  if (!isRecord(value) || Object.keys(value).some((field) => !COVERAGE_FIELDS.has(field))
      || !Object.hasOwn(value, "requested") || !Object.hasOwn(value, "served")
      || !Object.hasOwn(value, "partitions") || !Object.hasOwn(value, "states")
      || !isWindow(value.requested)
      || (value.served !== null && !isWindow(value.served))
      || !Number.isSafeInteger(value.partitions) || value.partitions < 0
      || !isRecord(value.states)) return false;
  if (value.served !== null
      && (BigInt(value.served.from) < BigInt(value.requested.from)
        || BigInt(value.served.to) > BigInt(value.requested.to))) return false;
  if (Object.entries(value.states).some(([state, count]) =>
    !COVERAGE_STATES.has(state) || !Number.isSafeInteger(count) || count < 0)) return false;
  if (Object.hasOwn(value, "gaps")
      && (!Array.isArray(value.gaps) || value.gaps.length > 512
        || value.gaps.some((gap) => !isCoverageEntry(gap, GAP_STATES)))) return false;
  return !Object.hasOwn(value, "corrupt") || (Array.isArray(value.corrupt) && value.corrupt.length <= 512
    && value.corrupt.every(isCorruptEntry));
}

function isScan(value) {
  if (!isRecord(value)
      || Object.keys(value).length !== SCAN_INTEGER_FIELDS.size + SCAN_DURATION_FIELDS.size
      || Object.keys(value).some((field) => !SCAN_INTEGER_FIELDS.has(field) && !SCAN_DURATION_FIELDS.has(field))) return false;
  return [...SCAN_INTEGER_FIELDS].every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)
    && [...SCAN_DURATION_FIELDS].every((field) => typeof value[field] === "number"
      && Number.isFinite(value[field]) && value[field] >= 0);
}

function isContractEnvelope(status, body, request) {
  if (!isRecord(body) || body.contractVersion !== CONTRACT_VERSION) return false;
  if (status === 200) {
    if (Object.hasOwn(body, "error")
        || SUCCESS_RESPONSE_FIELDS.some((field) => !Object.hasOwn(body, field))
        || Object.keys(body).some((field) => !SUCCESS_RESPONSE_FIELDS.includes(field))) return false;
    return body.family === request.family
      && FAMILIES.includes(body.family)
      && Array.isArray(body.rows)
      && body.rows.length <= (request.limit ?? MAX_LIMIT)
      && typeof body.pointer === "object" && body.pointer !== null && !Array.isArray(body.pointer)
      && typeof body.pointerToken === "string" && body.pointerToken.length > 0
      && body.pointerToken.length <= MAX_POINTER_TOKEN_LENGTH
      && /^[A-Za-z0-9_-]+$/.test(body.pointerToken)
      && typeof body.queryFingerprint === "string" && /^[0-9a-f]{64}$/.test(body.queryFingerprint)
      && (body.nextCursor === null || (typeof body.nextCursor === "string"
        && body.nextCursor.length > 0 && body.nextCursor.length <= MAX_CURSOR_LENGTH))
      && isCoverage(body.coverage) && isScan(body.scan);
  }
  return typeof body.error === "string"
    && Object.hasOwn(REFUSAL_STATUS, body.error)
    && REFUSAL_STATUS[body.error] === status
    && Object.keys(body).every((field) => ERROR_RESPONSE_FIELDS.includes(field));
}

function createArchiveRoute({
  auth = createArchiveAuth(),
  serviceUrl = process.env.TT_ARCHIVE_SERVICE_URL,
  serviceSecret = process.env.TT_QUERY_SERVICE_SECRET,
  fetchImpl = globalThis.fetch,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxQueuedPerClient = undefined,
  maxQueueWaitMs = DEFAULT_MAX_QUEUE_WAIT_MS,
  rateLimit = DEFAULT_RATE_LIMIT,
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  maxRequestBytes = MAX_REQUEST_BYTES,
  routePath = ARCHIVE_QUERY_PATH,
  contractVersion = CONTRACT_VERSION,
  requestValidator = validateRequest,
  responseValidator = isContractEnvelope,
  maxResponseBytes = MAX_UPSTREAM_RESPONSE_BYTES,
  now = () => Date.now(),
  log = console.error,
} = {}) {
  if (!/^\/archive\/[a-z0-9-]+$/.test(routePath) || typeof contractVersion !== "string"
      || contractVersion.length > 64 || typeof requestValidator !== "function"
      || typeof responseValidator !== "function" || !Number.isSafeInteger(maxResponseBytes)
      || maxResponseBytes < 1 || maxResponseBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("archive-route: invalid contract configuration");
  }
  const errorBody = (code, reason) => ({ contractVersion, error: code,
    ...(reason === undefined ? {} : { detail: String(reason).slice(0, 512) }) });
  serviceUrl = loopbackServiceUrl(serviceUrl);
  for (const [name, value] of [
    ["maxConcurrent", maxConcurrent], ["maxQueueWaitMs", maxQueueWaitMs],
    ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
    ["requestBodyTimeoutMs", requestBodyTimeoutMs],
    ["upstreamTimeoutMs", upstreamTimeoutMs], ["maxRequestBytes", maxRequestBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`archive-route: ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new Error("archive-route: maxQueued must be a non-negative safe integer");
  }
  if (maxQueuedPerClient === undefined) {
    const clientCount = Number.isSafeInteger(auth?.clientCount) && auth.clientCount > 0
      ? auth.clientCount : 1;
    maxQueuedPerClient = maxQueued === 0 ? 0 : Math.max(1, Math.floor(maxQueued / clientCount));
  }
  if (!Number.isSafeInteger(maxQueuedPerClient) || maxQueuedPerClient < 0
      || maxQueuedPerClient > maxQueued || (maxQueued > 0 && maxQueuedPerClient === 0)) {
    throw new Error("archive-route: maxQueuedPerClient must be within the queue capacity");
  }
  const overloadRetryAfterMs = Math.max(1, Math.min(maxQueueWaitMs, 1_000));

  const counters = {
    admitted: 0, queued: 0, rejected: 0, unauthorized: 0, completed: 0,
    failed: 0, cancelled: 0, timedOut: 0, restarts: 0,
  };
  const requestTimes = new Map();
  const queue = [];
  const activeClients = new Set();
  const activeControllers = new Set();
  let inFlight = 0;
  let disposed = false;

  function send(response, status, body, { restart = false, acceptEncoding = "" } = {}) {
    if (response.writableEnded) return;
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers = { "content-type": "application/json", "cache-control": "no-store", ...retryAfterHeaders(status, body) };
    if (restart) headers[RESTART_HEADER] = "1";
    const wantsGzip = /\bgzip\b/.test(acceptEncoding) && payload.length >= GZIP_THRESHOLD_BYTES;
    if (!wantsGzip) {
      headers["content-length"] = String(payload.length);
      response.writeHead(status, headers);
      response.end(payload);
      return;
    }
    zlib.gzip(payload, (error, compressed) => {
      if (response.writableEnded) return;
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

  function expire(entry) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    detachQueuedCancellation(entry);
    counters.rejected += 1;
    const body = errorBody(OVERLOADED, "QUEUE_WAIT_EXCEEDED");
    body.retryAfterMs = overloadRetryAfterMs;
    send(entry.response, 429, body,
         { acceptEncoding: entry.acceptEncoding });
  }

  function pump() {
    while (!disposed && inFlight < maxConcurrent && queue.length > 0) {
      const index = queue.findIndex((entry) => !entry.settled && !activeClients.has(entry.clientId));
      if (index === -1) return;
      const [entry] = queue.splice(index, 1);
      entry.settled = true;
      clearTimeout(entry.timer);
      detachQueuedCancellation(entry);
      void proxy(entry.request, entry.response, entry.clientId, entry.acceptEncoding);
    }
  }

  function detachQueuedCancellation(entry) {
    entry.request.removeListener("aborted", entry.onAborted);
    entry.response.removeListener("close", entry.onClose);
  }

  function cancelQueued(entry) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    detachQueuedCancellation(entry);
    counters.cancelled += 1;
  }

  async function proxy(request, response, clientId, acceptEncoding) {
    inFlight += 1;
    activeClients.add(clientId);
    counters.admitted += 1;
    const controller = new AbortController();
    activeControllers.add(controller);
    const abort = () => controller.abort();
    let timedOut = false;
    request.on("aborted", abort);
    response.on("close", () => { if (!response.writableEnded) abort(); });
    const timer = setTimeout(() => { timedOut = true; abort(); }, upstreamTimeoutMs);
    try {
      const raw = await readBody(request, maxRequestBytes, requestBodyTimeoutMs);
      if (raw.length === 0) {
        send(response, 400, errorBody(MALFORMED_REQUEST, "EMPTY_BODY"), { acceptEncoding });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        send(response, 400, errorBody(MALFORMED_REQUEST, "BODY_NOT_JSON"), { acceptEncoding });
        return;
      }
      const invalid = requestValidator(payload);
      if (invalid !== null) {
        send(response, 400, invalid, { acceptEncoding });
        return;
      }
      const upstream = await fetchImpl(serviceUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-archive-service-secret": serviceSecret ?? "",
          "x-archive-client": clientId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await readUpstreamBody(upstream, maxResponseBytes);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        counters.failed += 1;
        log("archive-route: the archive service returned a body that was not JSON");
        send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_BODY_NOT_JSON"), { acceptEncoding });
        return;
      }
      if (!responseValidator(upstream.status, body, payload)) {
        counters.failed += 1;
        log("archive-route: the archive service returned an envelope outside the contract");
        send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_CONTRACT_VIOLATION"), { acceptEncoding });
        return;
      }
      const restart = typeof body.error === "string" && RESTART_CODES.includes(body.error);
      if (restart) counters.restarts += 1;
      if (upstream.status >= 400) counters.failed += 1;
      else counters.completed += 1;
      send(response, upstream.status, body, { restart, acceptEncoding });
    } catch (error) {
      if (timedOut) {
        counters.timedOut += 1;
        log("archive-route: the archive service did not answer within the upstream deadline");
        send(response, 504, errorBody(READER_UNAVAILABLE, "UPSTREAM_TIMEOUT"), { acceptEncoding });
        return;
      }
      if (controller.signal.aborted) {
        counters.cancelled += 1;
        if (!response.writableEnded) {
          send(response, 499, errorBody(CANCELLED, "CLIENT_DISCONNECTED"), { acceptEncoding });
        }
        return;
      }
      if (error?.message === "REQUEST_BODY_TOO_LARGE") {
        response.setHeader("connection", "close");
        send(response, 400, errorBody(MALFORMED_REQUEST, "REQUEST_BODY_TOO_LARGE"), { acceptEncoding });
        return;
      }
      if (error?.message === "REQUEST_BODY_TIMEOUT") {
        response.setHeader("connection", "close");
        send(response, 400, errorBody(MALFORMED_REQUEST, "REQUEST_BODY_TIMEOUT"), { acceptEncoding });
        return;
      }
      if (error?.message === "UPSTREAM_BODY_TOO_LARGE") {
        counters.failed += 1;
        log("archive-route: the archive service exceeded the bounded response size");
        send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_BODY_TOO_LARGE"), { acceptEncoding });
        return;
      }
      counters.failed += 1;
      log("archive-route: the archive service could not be reached", error?.message ?? error);
      send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_UNREACHABLE"), { acceptEncoding });
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", abort);
      activeControllers.delete(controller);
      activeClients.delete(clientId);
      inFlight -= 1;
      pump();
    }
  }

  function handle(request, response) {
    if (request.url !== routePath) return false;
    const presentedCorrelationId = request.headers[CORRELATION_ID_HEADER];
    response.setHeader(
      CORRELATION_ID_HEADER,
      typeof presentedCorrelationId === "string" && CORRELATION_ID_PATTERN.test(presentedCorrelationId)
        ? presentedCorrelationId
        : crypto.randomUUID(),
    );
    if (request.method !== "POST") {
      send(response, REFUSAL_STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "METHOD_NOT_ALLOWED"));
      return true;
    }
    const acceptEncoding = request.headers["accept-encoding"] ?? "";
    if (disposed) {
      send(response, REFUSAL_STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "SERVER_SHUTTING_DOWN"), { acceptEncoding });
      return true;
    }
    const clientId = auth.identify(request.headers.authorization);
    if (clientId === null) {
      counters.unauthorized += 1;
      response.setHeader("www-authenticate", "Bearer");
      send(response, REFUSAL_STATUS[UNAUTHORIZED], errorBody(UNAUTHORIZED, "CLIENT_NOT_AUTHENTICATED"), { acceptEncoding });
      return true;
    }
    if (!serviceUrl || !serviceSecret) {
      log("archive-route: refusing a query because the archive service is not configured");
      send(response, REFUSAL_STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "SERVICE_NOT_CONFIGURED"), { acceptEncoding });
      return true;
    }
    const retryAfterMs = reserveRateBudget(clientId, now());
    if (retryAfterMs !== null) {
      counters.rejected += 1;
      const body = errorBody(OVERLOADED, "RATE_BUDGET_EXCEEDED");
      body.retryAfterMs = retryAfterMs;
      send(response, REFUSAL_STATUS[OVERLOADED], body, { acceptEncoding });
      return true;
    }
    if (inFlight >= maxConcurrent || activeClients.has(clientId)) {
      const queuedForClient = queue.reduce(
        (count, entry) => count + Number(!entry.settled && entry.clientId === clientId), 0);
      if (queuedForClient >= maxQueuedPerClient) {
        counters.rejected += 1;
        const body = errorBody(OVERLOADED, "CLIENT_QUEUE_LIMIT");
        body.retryAfterMs = overloadRetryAfterMs;
        send(response, REFUSAL_STATUS[OVERLOADED], body, { acceptEncoding });
        return true;
      }
      if (queue.length >= maxQueued) {
        counters.rejected += 1;
        const body = errorBody(OVERLOADED, "QUEUE_FULL");
        body.retryAfterMs = overloadRetryAfterMs;
        send(response, REFUSAL_STATUS[OVERLOADED], body, { acceptEncoding });
        return true;
      }
      counters.queued += 1;
      const entry = { request, response, clientId, acceptEncoding, queuedAt: now(), settled: false };
      entry.onAborted = () => cancelQueued(entry);
      entry.onClose = () => {
        if (!response.writableEnded) cancelQueued(entry);
      };
      request.on("aborted", entry.onAborted);
      response.on("close", entry.onClose);
      entry.timer = setTimeout(() => expire(entry), maxQueueWaitMs);
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      queue.push(entry);
      return true;
    }
    void proxy(request, response, clientId, acceptEncoding);
    return true;
  }

  function dispose() {
    disposed = true;
    for (const entry of queue.splice(0)) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      detachQueuedCancellation(entry);
      counters.cancelled += 1;
      send(entry.response, REFUSAL_STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "SERVER_SHUTTING_DOWN"));
    }
    for (const controller of activeControllers) controller.abort();
    requestTimes.clear();
  }

  function stats() {
    return Object.freeze({ ...counters, inFlight, waiting: queue.length });
  }

  return Object.freeze({ handle, dispose, stats });
}

function createArchiveRouteOrRefuse(options = {}, log = console.error) {
  try {
    return createArchiveRoute(options);
  } catch (error) {
    log("archive-route: archive queries are disabled because its configuration is invalid",
        error?.message ?? error);
    return Object.freeze({
      handle(request, response) {
        if (request.url !== (options.routePath ?? ARCHIVE_QUERY_PATH)) return false;
        const payload = Buffer.from(JSON.stringify(
          { ...errorBody(READER_UNAVAILABLE, "SERVICE_NOT_CONFIGURED"),
            contractVersion: options.contractVersion ?? CONTRACT_VERSION }), "utf8");
        response.writeHead(503, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "cache-control": "no-store",
        });
        response.end(payload);
        return true;
      },
      dispose() {},
      stats: () => Object.freeze({ disabled: true }),
    });
  }
}

module.exports = {
  createArchiveRoute,
  createArchiveRouteOrRefuse,
  validateRequest,
  readBody,
  readUpstreamBody,
  loopbackServiceUrl,
  CORRELATION_ID_PATTERN,
  ARCHIVE_QUERY_PATH,
  RESTART_HEADER,
  RESTART_CODES,
  CORRELATION_ID_HEADER,
  CONTRACT_VERSION,
  MAX_REQUEST_BYTES,
  MAX_LIMIT,
  MIN_LIMIT,
  MAX_INSTRUMENT_ID_LENGTH,
  MAX_CURSOR_LENGTH,
  MAX_POINTER_TOKEN_LENGTH,
  MAX_SCAN_BYTES,
  MAX_UPSTREAM_RESPONSE_BYTES,
  isCoverage,
  GAP_STATES,
  SUCCESS_RESPONSE_FIELDS,
  FAMILIES,
  REFUSAL_STATUS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  DEFAULT_RATE_LIMIT,
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
};
