"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { createArchiveAuth } = require("./archive-auth");
const {
  readBody,
  readUpstreamBody,
  loopbackServiceUrl,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_PATTERN,
  CONTRACT_VERSION: ARCHIVE_QUERY_CONTRACT_VERSION,
  MAX_UPSTREAM_RESPONSE_BYTES,
  MAX_LIMIT,
  MAX_POINTER_TOKEN_LENGTH,
  isCoverage,
  GAP_STATES,
} = require("./archive-route");
const {
  createSegmentedArchiveReader,
  MAX_SEGMENTS,
} = require("../storage/segmented-archive-reader");
const { runStudy, ArchiveStudyError } = require("./archive-study");
const cryptoTicks = require("../../../../config/archive-crypto-ticks.json");
const { retryAfterHeaders } = require("./retry-after");

const ARCHIVE_STUDY_PATH = "/archive/study";
const CONTRACT_VERSION = "archive-study/1";
const MAX_REQUEST_BYTES = 65_536;
const REQUEST_FIELDS = Object.freeze([
  "contractVersion",
  "requestId",
  "study",
  "symbol",
  "assetClass",
  "tickSize",
  "segments",
  "ranges",
  "options",
  "pointerToken",
]);
const OPTION_FIELDS = Object.freeze(["mode", "binSizeMultiplier", "ticksPerRow", "bucketMs"]);
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 36, windowMs: 60_000 });
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_STUDY_DEADLINE_MS = 180_000;
const DEFAULT_PAGE_TIMEOUT_MS = 60_000;
const GZIP_THRESHOLD_BYTES = 1_024;
const STUDY_CLIENT_SUFFIX = ".study";
const STUDY_GAP_STATES = Object.freeze(
  new Set([...GAP_STATES].filter((state) => state !== "UNKNOWN")),
);
const MAX_UPSTREAM_CLIENT_LENGTH = 128;

const MALFORMED_REQUEST = "MALFORMED_REQUEST";
const INVALID_STUDY = "INVALID_STUDY";
const UNAUTHORIZED = "UNAUTHORIZED";
const OVERLOADED = "OVERLOADED";
const READER_UNAVAILABLE = "READER_UNAVAILABLE";
const UPSTREAM_REFUSED = "UPSTREAM_REFUSED";
const STUDY_TIMEOUT = "STUDY_TIMEOUT";
const CANCELLED = "CANCELLED";
const UPSTREAM_UNREACHABLE = "UPSTREAM_UNREACHABLE";
const PAGE_TIMEOUT = "PAGE_TIMEOUT";
const PACE_EXCEEDS_DEADLINE = "ARCHIVE_PACE_EXCEEDS_DEADLINE";

const REFUSAL_STATUS = Object.freeze({
  [MALFORMED_REQUEST]: 400,
  [INVALID_STUDY]: 400,
  [UNAUTHORIZED]: 401,
  [OVERLOADED]: 429,
  [CANCELLED]: 499,
  [UPSTREAM_REFUSED]: 502,
  [READER_UNAVAILABLE]: 503,
  [STUDY_TIMEOUT]: 504,
});

class UpstreamRefusal extends Error {
  constructor(code, detail, retryAfterMs = null) {
    super(`${UPSTREAM_REFUSED}:${code}`);
    this.upstreamCode = code;
    this.detail = detail;
    this.retryAfterMs =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : null;
  }
}

function upstreamClientFor(clientId) {
  return `${clientId.slice(0, MAX_UPSTREAM_CLIENT_LENGTH - STUDY_CLIENT_SUFFIX.length)}${STUDY_CLIENT_SUFFIX}`;
}

function isPointerClientMismatch(error) {
  if (!(error instanceof UpstreamRefusal) || error.upstreamCode !== "POINTER_TOKEN_INVALID") return false;
  let detail = error.detail;
  if (typeof detail === "string") {
    try {
      detail = JSON.parse(detail);
    } catch {
      return false;
    }
  }
  return detail !== null && typeof detail === "object" && detail.reason === "CLIENT_MISMATCH";
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(CANCELLED));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(CANCELLED));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorBody(code, reason) {
  const body = { contractVersion: CONTRACT_VERSION, error: code };
  if (reason !== undefined) body.reason = String(reason).slice(0, 256);
  return body;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function window(value) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["fromTs", "toTs"].includes(key)) &&
    Number.isSafeInteger(value.fromTs) &&
    Number.isSafeInteger(value.toTs)
  );
}

function validateRequest(payload) {
  if (!isRecord(payload))
    return errorBody(MALFORMED_REQUEST, "REQUEST_NOT_AN_OBJECT");
  if (payload.contractVersion !== CONTRACT_VERSION)
    return errorBody(MALFORMED_REQUEST, "CONTRACT_VERSION_MISMATCH");
  const unknown = Object.keys(payload).filter(
    (key) => !REQUEST_FIELDS.includes(key),
  );
  if (unknown.length > 0)
    return errorBody(
      MALFORMED_REQUEST,
      `UNKNOWN_REQUEST_FIELDS:${unknown.sort().join(",")}`,
    );
  for (const field of REQUEST_FIELDS) {
    if (field !== "options" && field !== "pointerToken" && !(field in payload))
      return errorBody(MALFORMED_REQUEST, `MISSING_REQUEST_FIELD:${field}`);
  }
  if ("pointerToken" in payload && payload.pointerToken !== null
      && (typeof payload.pointerToken !== "string" || payload.pointerToken.length === 0
        || payload.pointerToken.length > MAX_POINTER_TOKEN_LENGTH
        || !/^[A-Za-z0-9_-]+$/.test(payload.pointerToken))) {
    return errorBody(MALFORMED_REQUEST, "POINTER_TOKEN_NOT_A_STRING");
  }
  if (
    typeof payload.symbol !== "string" ||
    payload.symbol.length === 0 ||
    payload.symbol.length > 32
  ) {
    return errorBody(MALFORMED_REQUEST, "SYMBOL_NOT_A_STRING");
  }
  if (
    !Array.isArray(payload.segments) ||
    payload.segments.length === 0 ||
    payload.segments.length > MAX_SEGMENTS ||
    !payload.segments.every(
      (segment) =>
        isRecord(segment) &&
        Object.keys(segment).every((key) =>
          ["instrumentId", "fromTs", "toTs"].includes(key),
        ) &&
        typeof segment.instrumentId === "string" &&
        window({ fromTs: segment.fromTs, toTs: segment.toTs }),
    )
  ) {
    return errorBody(MALFORMED_REQUEST, "SEGMENTS_MALFORMED");
  }
  if (payload.assetClass === "SPOT" || payload.assetClass === "PERPETUAL") {
    const expected = cryptoTicks.instruments.find((row) =>
      row.marketKind === payload.assetClass && row.symbol === payload.symbol);
    if (expected === undefined || payload.tickSize !== Number(expected.tickSize)) {
      return errorBody(INVALID_STUDY, "CRYPTO_GEOMETRY_MISMATCH");
    }
    for (const segment of payload.segments) {
      let identity;
      try {
        identity = JSON.parse(segment.instrumentId);
      } catch {
        return errorBody(INVALID_STUDY, "CRYPTO_IDENTITY_MISMATCH");
      }
      if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== "BINANCE"
        || identity[1] !== payload.assetClass || identity[2] !== payload.symbol
        || identity[3] !== "USDT" || identity[4] !== "COIN") {
        return errorBody(INVALID_STUDY, "CRYPTO_IDENTITY_MISMATCH");
      }
    }
  }
  if (!Array.isArray(payload.ranges) || !payload.ranges.every(window))
    return errorBody(MALFORMED_REQUEST, "RANGES_MALFORMED");
  if (
    "options" in payload &&
    (!isRecord(payload.options) ||
      !Object.keys(payload.options).every((key) => OPTION_FIELDS.includes(key)))
  ) {
    return errorBody(MALFORMED_REQUEST, "OPTIONS_MALFORMED");
  }
  for (let index = 1; index < payload.segments.length; index += 1) {
    if (payload.segments[index].fromTs !== payload.segments[index - 1].toTs) {
      return errorBody(INVALID_STUDY, "SEGMENTS_NOT_CONTIGUOUS");
    }
  }
  const first = payload.segments[0].fromTs;
  const last = payload.segments[payload.segments.length - 1].toTs;
  if (
    !payload.ranges.every(
      (range) => range.fromTs >= first && range.toTs <= last,
    )
  ) {
    return errorBody(INVALID_STUDY, "RANGE_OUTSIDE_SEGMENTS");
  }
  return null;
}

function createArchiveStudyRoute({
  auth = createArchiveAuth(),
  serviceUrl = process.env.TT_ARCHIVE_SERVICE_URL,
  serviceSecret = process.env.TT_QUERY_SERVICE_SECRET,
  fetchImpl = globalThis.fetch,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  rateLimit = DEFAULT_RATE_LIMIT,
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  studyDeadlineMs = DEFAULT_STUDY_DEADLINE_MS,
  pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  now = () => Date.now(),
  log = console.error,
} = {}) {
  serviceUrl = loopbackServiceUrl(serviceUrl);
  for (const [name, value] of [
    ["maxConcurrent", maxConcurrent],
    ["rateLimit.max", rateLimit?.max],
    ["rateLimit.windowMs", rateLimit?.windowMs],
    ["requestBodyTimeoutMs", requestBodyTimeoutMs],
    ["studyDeadlineMs", studyDeadlineMs],
    ["pageTimeoutMs", pageTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(
        `archive-study-route: ${name} must be a positive safe integer`,
      );
  }

  const counters = {
    admitted: 0,
    completed: 0,
    refused: 0,
    unauthorized: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    pacedWaits: 0,
    viewerFallbacks: 0,
  };
  const requestTimes = new Map();
  const activeClients = new Set();
  const activeControllers = new Set();
  let inFlight = 0;
  let disposed = false;

  function send(response, status, body, acceptEncoding = "") {
    if (response.writableEnded) return;
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...retryAfterHeaders(status, body),
    };
    if (
      !/\bgzip\b/.test(acceptEncoding) ||
      payload.length < GZIP_THRESHOLD_BYTES
    ) {
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

  function refuse(response, code, reason, acceptEncoding, extra = {}) {
    counters.refused += 1;
    send(
      response,
      REFUSAL_STATUS[code],
      { ...errorBody(code, reason), ...extra },
      acceptEncoding,
    );
  }

  function reserveRateBudget(clientId, at) {
    const fresh = (requestTimes.get(clientId) ?? []).filter(
      (t) => at - t < rateLimit.windowMs,
    );
    if (fresh.length >= rateLimit.max) {
      requestTimes.set(clientId, fresh);
      return Math.max(1, fresh[0] + rateLimit.windowMs - at);
    }
    fresh.push(at);
    requestTimes.set(clientId, fresh);
    return null;
  }

  function pageFetcher(clientId, signal, deadlineAt, requestedPointerToken) {
    // Studies read under the `.study` budget class, pinned or not, so a study
    // never spends the chart's own rate budget and reader slot. A pin belongs to
    // the viewer, and the archive reads `.study` as a budget class rather than an
    // identity, so the viewer's pin resolves for it. An id too long to keep whole
    // with the suffix, or an archive that still ties a pin to the exact header,
    // reads the pin under the viewer's own identity instead.
    const studyClient = upstreamClientFor(clientId);
    const keepsIdentity = studyClient === `${clientId}${STUDY_CLIENT_SUFFIX}`;
    let fetchOnce = pageFetcherOnce(
      requestedPointerToken == null || keepsIdentity ? studyClient : clientId,
      signal,
    );
    let viewerFallback = requestedPointerToken != null && keepsIdentity;
    let pinnedPointerToken = requestedPointerToken ?? null;
    return async (request) => {
      for (;;) {
        try {
          const page = await fetchOnce({ ...request, pointerToken: pinnedPointerToken });
          if (page !== null) {
            if (pinnedPointerToken !== null && page.pointerToken !== pinnedPointerToken)
              throw new UpstreamRefusal("POINTER_TOKEN_MISMATCH");
            pinnedPointerToken = page.pointerToken;
          }
          return page;
        } catch (error) {
          if (viewerFallback && isPointerClientMismatch(error)) {
            viewerFallback = false;
            counters.viewerFallbacks += 1;
            fetchOnce = pageFetcherOnce(clientId, signal);
            continue;
          }
          if (
            !(error instanceof UpstreamRefusal) ||
            error.upstreamCode !== OVERLOADED ||
            error.retryAfterMs === null
          ) {
            throw error;
          }
          if (now() + error.retryAfterMs >= deadlineAt)
            throw new UpstreamRefusal(PACE_EXCEEDS_DEADLINE, error.detail);
          counters.pacedWaits += 1;
          await pause(error.retryAfterMs, signal);
        }
      }
    };
  }

  function pageFetcherOnce(upstreamClient, signal) {
    return async (request) => {
      const body = {
        contractVersion: ARCHIVE_QUERY_CONTRACT_VERSION,
        instrumentId: request.instrumentId,
        family: request.family,
        from: request.from,
        to: request.to,
        limit: Math.min(request.limit, MAX_LIMIT),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.pointerToken ? { pointerToken: request.pointerToken } : {}),
      };
      const pageController = new AbortController();
      const abortPage = () => pageController.abort();
      signal.addEventListener("abort", abortPage, { once: true });
      const timer = setTimeout(abortPage, pageTimeoutMs);
      try {
        let upstream;
        let text;
        try {
          upstream = await fetchImpl(serviceUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-archive-service-secret": serviceSecret ?? "",
              "x-archive-client": upstreamClient,
            },
            body: JSON.stringify(body),
            signal: pageController.signal,
            redirect: "error",
          });
          text = await readUpstreamBody(upstream, MAX_UPSTREAM_RESPONSE_BYTES);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new UpstreamRefusal(
            pageController.signal.aborted ? PAGE_TIMEOUT : UPSTREAM_UNREACHABLE,
          );
        }
        let answer;
        try {
          answer = JSON.parse(text);
        } catch {
          throw new UpstreamRefusal("UPSTREAM_BODY_NOT_JSON");
        }
        if (upstream.status >= 400 || typeof answer?.error === "string") {
          throw new UpstreamRefusal(
            typeof answer?.error === "string"
              ? answer.error
              : `HTTP_${upstream.status}`,
            answer?.detail,
            answer?.retryAfterMs,
          );
        }
        if (
          !Array.isArray(answer?.rows) ||
          answer.family !== request.family ||
          !isCoverage(answer.coverage) ||
          typeof answer.pointerToken !== "string" ||
          answer.pointerToken.length === 0 ||
          answer.pointerToken.length > MAX_POINTER_TOKEN_LENGTH ||
          !/^[A-Za-z0-9_-]+$/.test(answer.pointerToken)
        ) {
          throw new UpstreamRefusal("UPSTREAM_CONTRACT_VIOLATION");
        }
        if (request.pointerToken !== null && request.pointerToken !== undefined
            && answer.pointerToken !== request.pointerToken)
          throw new UpstreamRefusal("POINTER_TOKEN_MISMATCH");
        if (
          [...STUDY_GAP_STATES].some(
            (state) => (answer.coverage.states[state] ?? 0) > 0,
          )
        )
          return null;
        return {
          rows: answer.rows,
          nextCursor: answer.nextCursor ?? null,
          pointerToken: answer.pointerToken ?? null,
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortPage);
      }
    };
  }

  async function serve(request, response, clientId, acceptEncoding) {
    inFlight += 1;
    activeClients.add(clientId);
    counters.admitted += 1;
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    const abort = () => controller.abort();
    request.on("aborted", abort);
    response.on("close", () => {
      if (!response.writableEnded) abort();
    });
    const deadlineAt = now() + studyDeadlineMs;
    const deadline = setTimeout(() => {
      timedOut = true;
      abort();
    }, studyDeadlineMs);
    let reader = null;
    try {
      const raw = await readBody(
        request,
        MAX_REQUEST_BYTES,
        requestBodyTimeoutMs,
      );
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        refuse(response, MALFORMED_REQUEST, "BODY_NOT_JSON", acceptEncoding);
        return;
      }
      const invalid = validateRequest(payload);
      if (invalid !== null) {
        counters.refused += 1;
        send(response, REFUSAL_STATUS[invalid.error], invalid, acceptEncoding);
        return;
      }
      reader = createSegmentedArchiveReader({
        segments: payload.segments,
        fetchPage: pageFetcher(clientId, controller.signal, deadlineAt, payload.pointerToken),
      });
      const result = await runStudy({
        reader,
        symbol: payload.symbol,
        study: payload.study,
        assetClass: payload.assetClass,
        tickSize: payload.tickSize,
        ranges: payload.ranges,
        requestId: payload.requestId,
        options: payload.options ?? {},
      });
      counters.completed += 1;
      send(
        response,
        200,
        { contractVersion: CONTRACT_VERSION, ...result },
        acceptEncoding,
      );
    } catch (error) {
      if (timedOut) {
        counters.timedOut += 1;
        refuse(response, STUDY_TIMEOUT, "DEADLINE_EXCEEDED", acceptEncoding);
        return;
      }
      if (controller.signal.aborted) {
        counters.cancelled += 1;
        if (!response.writableEnded)
          refuse(response, CANCELLED, "CLIENT_DISCONNECTED", acceptEncoding);
        return;
      }
      if (error instanceof ArchiveStudyError) {
        refuse(response, INVALID_STUDY, error.reason, acceptEncoding);
        return;
      }
      if (error instanceof UpstreamRefusal) {
        const code =
          error.upstreamCode === UPSTREAM_UNREACHABLE
            ? READER_UNAVAILABLE
            : error.upstreamCode === PAGE_TIMEOUT ||
                error.upstreamCode === PACE_EXCEEDS_DEADLINE
              ? STUDY_TIMEOUT
              : UPSTREAM_REFUSED;
        if (code === STUDY_TIMEOUT) counters.timedOut += 1;
        else counters.failed += 1;
        refuse(response, code, error.upstreamCode, acceptEncoding);
        return;
      }
      if (
        error?.message === "REQUEST_BODY_TOO_LARGE" ||
        error?.message === "REQUEST_BODY_TIMEOUT"
      ) {
        response.setHeader("connection", "close");
        refuse(response, MALFORMED_REQUEST, error.message, acceptEncoding);
        return;
      }
      if (
        /segmented-archive-reader|archive-storage-reader/.test(
          error?.message ?? "",
        )
      ) {
        refuse(
          response,
          INVALID_STUDY,
          String(error.message).replace(/^[^:]*: /, ""),
          acceptEncoding,
        );
        return;
      }
      counters.failed += 1;
      log("archive-study-route: a study failed", error?.message ?? error);
      refuse(response, READER_UNAVAILABLE, "STUDY_FAILED", acceptEncoding);
    } finally {
      clearTimeout(deadline);
      reader?.close();
      request.removeListener("aborted", abort);
      activeControllers.delete(controller);
      activeClients.delete(clientId);
      inFlight -= 1;
    }
  }

  function handle(request, response) {
    if (request.url !== ARCHIVE_STUDY_PATH) return false;
    const presented = request.headers[CORRELATION_ID_HEADER];
    response.setHeader(
      CORRELATION_ID_HEADER,
      typeof presented === "string" && CORRELATION_ID_PATTERN.test(presented)
        ? presented
        : crypto.randomUUID(),
    );
    const acceptEncoding = request.headers["accept-encoding"] ?? "";
    if (request.method !== "POST") {
      refuse(response, MALFORMED_REQUEST, "METHOD_NOT_ALLOWED", acceptEncoding);
      return true;
    }
    if (disposed) {
      refuse(
        response,
        READER_UNAVAILABLE,
        "SERVER_SHUTTING_DOWN",
        acceptEncoding,
      );
      return true;
    }
    const clientId = auth.identify(request.headers.authorization);
    if (clientId === null) {
      counters.unauthorized += 1;
      response.setHeader("www-authenticate", "Bearer");
      send(
        response,
        REFUSAL_STATUS[UNAUTHORIZED],
        errorBody(UNAUTHORIZED, "CLIENT_NOT_AUTHENTICATED"),
        acceptEncoding,
      );
      return true;
    }
    if (!serviceUrl || !serviceSecret) {
      refuse(
        response,
        READER_UNAVAILABLE,
        "SERVICE_NOT_CONFIGURED",
        acceptEncoding,
      );
      return true;
    }
    const retryAfterMs = reserveRateBudget(clientId, now());
    if (retryAfterMs !== null) {
      refuse(response, OVERLOADED, "RATE_BUDGET_EXCEEDED", acceptEncoding, {
        retryAfterMs,
      });
      return true;
    }
    if (activeClients.has(clientId)) {
      refuse(response, OVERLOADED, "ONE_STUDY_PER_CLIENT", acceptEncoding, {
        retryAfterMs: 1_000,
      });
      return true;
    }
    if (inFlight >= maxConcurrent) {
      refuse(response, OVERLOADED, "STUDY_CAPACITY_FULL", acceptEncoding, {
        retryAfterMs: 1_000,
      });
      return true;
    }
    void serve(request, response, clientId, acceptEncoding);
    return true;
  }

  function dispose() {
    disposed = true;
    for (const controller of activeControllers) controller.abort();
    requestTimes.clear();
  }

  function stats() {
    return Object.freeze({ ...counters, inFlight });
  }

  return Object.freeze({ handle, dispose, stats });
}

function createArchiveStudyRouteOrRefuse(options = {}, log = console.error) {
  try {
    return createArchiveStudyRoute(options);
  } catch (error) {
    log(
      "archive-study-route: archive studies are disabled because the configuration is invalid",
      error?.message ?? error,
    );
    return Object.freeze({
      handle(request, response) {
        if (request.url !== ARCHIVE_STUDY_PATH) return false;
        const payload = Buffer.from(
          JSON.stringify(
            errorBody(READER_UNAVAILABLE, "SERVICE_NOT_CONFIGURED"),
          ),
          "utf8",
        );
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
  createArchiveStudyRoute,
  createArchiveStudyRouteOrRefuse,
  validateRequest,
  ARCHIVE_STUDY_PATH,
  CONTRACT_VERSION,
  REFUSAL_STATUS,
};
