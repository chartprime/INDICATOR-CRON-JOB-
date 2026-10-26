"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");

const {
  ROUTES, LIVE_STORAGE_PATH_PREFIX, SERVICE_SECRET_HEADER, CLIENT_HEADER,
  CONTRACT_VERSION_HEADER, CORRELATION_ID_HEADER, CONTRACT_VERSION, validatePayload, SLOW_AGGREGATE_ROUTES,
} = require("./live-storage-route");
const { createRouteTelemetry } = require("./route-telemetry");
const { retryAfterHeaders } = require("./retry-after");

const MAX_REQUEST_BYTES = 65_536;
const MIN_COMPRESS_BYTES = 1_024;
// Match the bounded remote reader. Production 15-minute profile roll-ups can
// legitimately exceed 1 MiB, while still remaining below this hard ceiling.
const MAX_UPSTREAM_RESPONSE_BYTES = 2_000_000;
const MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE = Object.freeze({ "recent-candles": 4_000_000, "aggressive-prints": 4_000_000, "band-history": 4_000_000 });
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 576, windowMs: 60_000 });
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const SLOW_ROUTE_TIMEOUT_MARGIN_MS = 5_000;
const UPSTREAM_TIMEOUT_MS_BY_ROUTE = Object.freeze({
  "replay-page": 35_000,
  ...Object.fromEntries(
    Object.entries(SLOW_AGGREGATE_ROUTES).map(([routeName, slow]) => [routeName, slow.queryTimeoutMs + SLOW_ROUTE_TIMEOUT_MARGIN_MS]),
  ),
});

const MALFORMED_REQUEST = "MALFORMED_REQUEST";
const UNAUTHORIZED = "UNAUTHORIZED";
const OVERLOADED = "OVERLOADED";
const READER_UNAVAILABLE = "READER_UNAVAILABLE";
const STATUS = Object.freeze({
  [MALFORMED_REQUEST]: 400,
  [UNAUTHORIZED]: 401,
  [OVERLOADED]: 429,
  [READER_UNAVAILABLE]: 503,
});

function routeNameFromUrl(url) {
  if (typeof url !== "string" || !url.startsWith(LIVE_STORAGE_PATH_PREFIX)) return null;
  const rest = url.slice(LIVE_STORAGE_PATH_PREFIX.length);
  return Object.hasOwn(ROUTES, rest) ? rest : null;
}

function loopbackOrPrivateServiceUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("live-storage-relay: internalUrl must be a string");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("live-storage-relay: internalUrl must be an absolute loopback URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("live-storage-relay: internalUrl must be an unauthenticated loopback URL with no path");
  }
  return url.origin;
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

function createLiveStorageRelay({
  auth,
  internalUrl = process.env.TT_LIVE_STORAGE_INTERNAL_URL,
  serviceSecret = process.env.TT_LIVE_STORAGE_SERVICE_SECRET,
  fetchImpl = globalThis.fetch,
  rateLimit = DEFAULT_RATE_LIMIT,
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  upstreamTimeoutMsByRoute = UPSTREAM_TIMEOUT_MS_BY_ROUTE,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxUpstreamResponseBytes = MAX_UPSTREAM_RESPONSE_BYTES,
  maxUpstreamResponseBytesByRoute = MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE,
  now = () => Date.now(),
  telemetryNow,
  log = console.error,
} = {}) {
  if (!auth || typeof auth.identify !== "function") {
    throw new Error("live-storage-relay: auth is required");
  }
  internalUrl = loopbackOrPrivateServiceUrl(internalUrl);
  for (const [name, value] of [
    ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
    ["requestBodyTimeoutMs", requestBodyTimeoutMs], ["upstreamTimeoutMs", upstreamTimeoutMs],
    ["maxRequestBytes", maxRequestBytes], ["maxUpstreamResponseBytes", maxUpstreamResponseBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`live-storage-relay: ${name} must be a positive safe integer`);
    }
  }
  for (const [routeName, value] of Object.entries(upstreamTimeoutMsByRoute)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`live-storage-relay: upstreamTimeoutMsByRoute.${routeName} must be a positive safe integer`);
    }
  }
  for (const [routeName, value] of Object.entries(maxUpstreamResponseBytesByRoute)) {
    if (!Object.hasOwn(ROUTES, routeName) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`live-storage-relay: maxUpstreamResponseBytesByRoute.${routeName} must name a route and be a positive safe integer`);
    }
  }

  const requestTimes = new Map();
  const telemetry = createRouteTelemetry({ routes: Object.keys(ROUTES), ...(telemetryNow ? { now: telemetryNow } : {}) });
  const counters = { admitted: 0, rejected: 0, unauthorized: 0, completed: 0, failed: 0, timedOut: 0 };
  let disposed = false;

  function errorBody(code, detail) {
    const body = { error: code };
    if (detail !== undefined) body.detail = String(detail).slice(0, 256);
    return body;
  }

  function acceptsGzip(response) {
    const accepted = response.req?.headers["accept-encoding"];
    return typeof accepted === "string" && accepted.split(",").some((token) => token.trim().split(";")[0] === "gzip");
  }

  function send(response, status, body) {
    if (response.writableEnded) return;
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const compress = encoded.length >= MIN_COMPRESS_BYTES && acceptsGzip(response);
    const payload = compress ? zlib.gzipSync(encoded) : encoded;
    response.writeHead(status, {
      "content-type": "application/json", "content-length": String(payload.length), "cache-control": "no-store",
      vary: "accept-encoding",
      ...(compress ? { "content-encoding": "gzip" } : {}),
      ...retryAfterHeaders(status, body),
      [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
    });
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

  async function proxy(request, response, clientId, routeName, correlationId) {
    counters.admitted += 1;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    request.on("aborted", abort);
    response.on("close", () => { if (!response.writableEnded) abort(); });
    const routeTimeoutMs = upstreamTimeoutMsByRoute[routeName] ?? upstreamTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      telemetry.increment(routeName, "timedOut");
      abort();
    }, routeTimeoutMs);
    try {
      const raw = await readBody(request, maxRequestBytes, requestBodyTimeoutMs);
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
      if (!internalUrl || !serviceSecret) {
        counters.failed += 1;
        log("live-storage-relay: refusing a request because the live-storage service is not configured");
        send(response, STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "SERVICE_NOT_CONFIGURED"));
        return;
      }
      const upstream = await fetchImpl(`${internalUrl}${LIVE_STORAGE_PATH_PREFIX}${routeName}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SERVICE_SECRET_HEADER]: serviceSecret,
          [CLIENT_HEADER]: clientId,
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
          [CORRELATION_ID_HEADER]: correlationId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      });
      if (upstream.headers.get(CONTRACT_VERSION_HEADER) !== CONTRACT_VERSION) {
        counters.failed += 1;
        log("live-storage-relay: the live-storage service contract version did not match");
        send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_CONTRACT_VERSION_MISMATCH"));
        return;
      }
      const responseLimit = maxUpstreamResponseBytesByRoute[routeName] ?? maxUpstreamResponseBytes;
      const text = await readUpstreamBody(upstream, responseLimit);
      let body;
      try {
        body = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        counters.failed += 1;
        log("live-storage-relay: the live-storage service returned a body that was not JSON");
        send(response, STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "UPSTREAM_BODY_NOT_JSON"));
        return;
      }
      if (upstream.status >= 400) counters.failed += 1;
      else counters.completed += 1;
      send(response, upstream.status, body);
    } catch (error) {
      if (timedOut) {
        counters.timedOut += 1;
        log("live-storage-relay: the live-storage service did not answer within the upstream deadline");
        send(response, 504, errorBody(READER_UNAVAILABLE, "UPSTREAM_TIMEOUT"));
        return;
      }
      if (controller.signal.aborted) {
        if (!response.writableEnded) send(response, 499, errorBody(READER_UNAVAILABLE, "CLIENT_DISCONNECTED"));
        return;
      }
      if (error?.message === "REQUEST_BODY_TOO_LARGE" || error?.message === "REQUEST_BODY_TIMEOUT") {
        counters.failed += 1;
        send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, error.message));
        return;
      }
      if (error?.message === "UPSTREAM_BODY_TOO_LARGE") {
        counters.failed += 1;
        log("live-storage-relay: the live-storage service exceeded the bounded response size");
        send(response, STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "UPSTREAM_BODY_TOO_LARGE"));
        return;
      }
      counters.failed += 1;
      log("live-storage-relay: the live-storage service could not be reached", error?.message ?? error);
      send(response, 502, errorBody(READER_UNAVAILABLE, "UPSTREAM_UNREACHABLE"));
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", abort);
    }
  }

  function handle(request, response) {
    const routeName = routeNameFromUrl(request.url);
    if (routeName === null) return false;
    const presentedCorrelationId = request.headers[CORRELATION_ID_HEADER];
    const correlationId = typeof presentedCorrelationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(presentedCorrelationId)
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
      send(response, STATUS[READER_UNAVAILABLE], errorBody(READER_UNAVAILABLE, "SERVER_SHUTTING_DOWN"));
      return true;
    }
    if (request.headers[CONTRACT_VERSION_HEADER] !== CONTRACT_VERSION) {
      send(response, STATUS[MALFORMED_REQUEST], errorBody(MALFORMED_REQUEST, "CONTRACT_VERSION_MISMATCH"));
      return true;
    }
    const clientId = auth.identify(request.headers.authorization);
    if (clientId === null) {
      counters.unauthorized += 1;
      response.setHeader("www-authenticate", "Bearer");
      send(response, STATUS[UNAUTHORIZED], errorBody(UNAUTHORIZED, "CLIENT_NOT_AUTHENTICATED"));
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
    void proxy(request, response, clientId, routeName, correlationId);
    return true;
  }

  function stats() {
    return { ...counters, telemetry: telemetry.snapshot(), disabled: !internalUrl || !serviceSecret, disposed };
  }

  function dispose() {
    disposed = true;
  }

  return Object.freeze({ handle, stats, dispose });
}

function createLiveStorageRelayOrRefuse(options = {}, log = console.error) {
  try {
    return createLiveStorageRelay(options);
  } catch (error) {
    log("live-storage-relay: disabled because its configuration is invalid", error?.message ?? error);
    return Object.freeze({
      handle(request, response) {
        const routeName = routeNameFromUrl(request.url);
        if (routeName === null) return false;
        const payload = Buffer.from(JSON.stringify({ error: READER_UNAVAILABLE, detail: "SERVICE_NOT_CONFIGURED" }), "utf8");
        response.writeHead(503, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "cache-control": "no-store",
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
        });
        response.end(payload);
        return true;
      },
      stats() { return { disabled: true, disposed: false }; },
      dispose() {},
    });
  }
}

module.exports = {
  createLiveStorageRelay, createLiveStorageRelayOrRefuse, UPSTREAM_TIMEOUT_MS_BY_ROUTE,
  DEFAULT_UPSTREAM_TIMEOUT_MS, MAX_UPSTREAM_RESPONSE_BYTES, MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE,
};
