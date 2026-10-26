#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const path = require("node:path");

const CONTRACT_VERSION = "live-storage/1";
const ARCHIVE_CONTRACT_VERSION = "archive-query/1";
const ARCHIVE_KIND = "archive-query";
const ARCHIVE_PATH = "/archive/query";
const MAX_USERS = 32;
const MAX_ROUNDS = 100;
const MAX_REQUESTS_PER_ROUND = 100;
const MAX_PAGINATE_PAGES = 2_048;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ABORT_AFTER_MS = 600_000;
const DEFAULT_HEALTH_SETTLE_MS = 5_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const HEALTH_SCRAPE_TIMEOUT_MS = 10_000;
const ABORT_CAUSE_BENCHMARK = "BENCHMARK_ABORT";
const ABORT_CAUSE_TIMEOUT = "CLIENT_TIMEOUT";
const ABORT_CAUSE_INTERRUPT = "PROCESS_INTERRUPT";
const FAILURE_CLASS_BY_ABORT_CAUSE = Object.freeze({
  [ABORT_CAUSE_BENCHMARK]: "CLIENT_ABORTED",
  [ABORT_CAUSE_TIMEOUT]: "CLIENT_TIMEOUT",
  [ABORT_CAUSE_INTERRUPT]: "PROCESS_INTERRUPTED",
});
const HEALTH_COUNTER_FIELDS = Object.freeze([
  "requests", "successes", "clientErrors", "serverErrors", "cancelled", "timedOut", "overloaded",
  "coalesced", "cacheHits", "cacheMisses",
]);
const HEALTH_FAILURE_REASONS = Object.freeze(new Set([
  "route_timeout", "reader_timeout", "reader_aborted", "worker_failed",
  "worker_exited", "worker_query_failed", "service_unavailable",
]));
const HEALTH_RUNTIME_FIELDS = Object.freeze(new Set([
  "eventLoopMaxDelayMs", "eventLoopP99DelayMs", "eventLoopUtilizationPct", "eventLoopSamples", "eventLoopSampleAgeMs", "eventLoopSampleLagMs",
  "processRssBytes", "processHeapUsedBytes", "processHeapTotalBytes", "processExternalBytes", "processArrayBuffersBytes",
  "processCpuUserMicros", "processCpuSystemMicros", "processFsReadOps", "processFsWriteOps",
  "processVoluntaryContextSwitches", "processInvoluntaryContextSwitches", "gcCount", "gcTotalDurationMs", "gcMaxDurationMs",
]));
const CUMULATIVE_RUNTIME_FIELDS = Object.freeze(new Set([
  "eventLoopSamples", "processCpuUserMicros", "processCpuSystemMicros", "processFsReadOps", "processFsWriteOps",
  "processVoluntaryContextSwitches", "processInvoluntaryContextSwitches", "gcCount", "gcTotalDurationMs",
]));
const HOST_WIDE_NOTE = "Counters come from the server's cumulative route telemetry and include every request the host served between the two scrapes, not only this run's.";
const REPLAY_STAT_FIELDS = Object.freeze(new Set([
  "snapshotsUsed", "eventsRead", "tradesRead", "booksEmitted", "gaps",
  "orderRows", "tapeRows", "anchors", "unavailable", "timestampGroupsExamined", "encodedBytes",
]));
const ARCHIVE_SCAN_INTEGER_FIELDS = Object.freeze(new Set([
  "partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead", "cacheHits", "cacheMisses",
]));
const ARCHIVE_SCAN_DURATION_FIELDS = Object.freeze(new Set(["fetchMs", "queryMs"]));

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    requests: samples.length,
    succeeded: samples.filter((sample) => sample.failureClass === "SUCCESS").length,
    failed: samples.filter((sample) => sample.failureClass !== "SUCCESS").length,
    responseBytes: samples.reduce((total, sample) => total + sample.responseBytes, 0),
    wireBytes: samples.reduce((total, sample) => total + (sample.wireBytes ?? sample.responseBytes), 0),
    latencyMs: {
      min: durations[0] ?? null,
      p50: percentile(durations, 0.50),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.at(-1) ?? null,
    },
    statuses: Object.fromEntries([...new Set(samples.map((sample) => sample.status))].sort((a, b) => a - b)
      .map((status) => [status, samples.filter((sample) => sample.status === status).length])),
    failureClasses: Object.fromEntries([...new Set(samples.map((sample) => sample.failureClass))].sort()
      .map((failureClass) => [failureClass, samples.filter((sample) => sample.failureClass === failureClass).length])),
  };
}

function classifyResponse(status, body) {
  if (status === 0) return "TRANSPORT_FAILURE";
  if (status === 401 || status === 403) return "AUTH_FAILURE";
  if (status === 429) return "ADMISSION_REJECTED";
  if (status >= 500) return "SERVICE_FAILURE";
  if (status >= 400) return "REQUEST_FAILURE";
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed?.available === false || parsed?.coversFullWindow === false) return "DATA_UNAVAILABLE";
  } catch { /* response validity remains the contract client's responsibility */ }
  return "SUCCESS";
}

function summarizeResponseBody(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const replayStats = parsed.stats && typeof parsed.stats === "object" && !Array.isArray(parsed.stats)
      ? Object.fromEntries(Object.entries(parsed.stats).filter(([key, value]) =>
        REPLAY_STAT_FIELDS.has(key) &&
        Number.isSafeInteger(value) && value >= 0))
      : null;
    const archiveScan = parsed.scan && typeof parsed.scan === "object" && !Array.isArray(parsed.scan)
      ? Object.fromEntries(Object.entries(parsed.scan).filter(([key, value]) =>
        (ARCHIVE_SCAN_INTEGER_FIELDS.has(key) && Number.isSafeInteger(value) && value >= 0) ||
        (ARCHIVE_SCAN_DURATION_FIELDS.has(key) && Number.isFinite(value) && value >= 0)))
      : null;
    return {
      ...(typeof parsed.available === "boolean" ? { available: parsed.available } : {}),
      ...(typeof parsed.coversFullWindow === "boolean" ? { coversFullWindow: parsed.coversFullWindow } : {}),
      ...(Array.isArray(parsed.rows) ? { rows: parsed.rows.length } : {}),
      ...(Array.isArray(parsed.buckets) ? { buckets: parsed.buckets.length } : {}),
      ...(Array.isArray(parsed.frames) ? { frames: parsed.frames.length } : {}),
      ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
      ...(replayStats !== null ? { stats: replayStats } : {}),
      ...(archiveScan !== null && Object.keys(archiveScan).length > 0 ? { scan: archiveScan } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error.slice(0, 80) } : {}),
      ...(typeof parsed.detail === "string" ? { detail: parsed.detail.slice(0, 160) } : {}),
    };
  } catch {
    return null;
  }
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) throw new Error("live-storage-load: manifest version must be 1");
  if (!Number.isSafeInteger(value.users) || value.users <= 0 || value.users > MAX_USERS) throw new Error(`live-storage-load: users must be 1..${MAX_USERS}`);
  if (!Number.isSafeInteger(value.rounds) || value.rounds <= 0 || value.rounds > MAX_ROUNDS) throw new Error(`live-storage-load: rounds must be 1..${MAX_ROUNDS}`);
  if (!Array.isArray(value.requests) || value.requests.length === 0 || value.requests.length > MAX_REQUESTS_PER_ROUND) {
    throw new Error(`live-storage-load: requests must contain 1..${MAX_REQUESTS_PER_ROUND} entries`);
  }
  for (const [index, request] of value.requests.entries()) {
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.route !== "string" || !/^[a-z-]+$/.test(request.route)) {
      throw new Error(`live-storage-load: requests[${index}] has an invalid route`);
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      throw new Error(`live-storage-load: requests[${index}] body must be an object`);
    }
    if (request.kind !== undefined && request.kind !== ARCHIVE_KIND) {
      throw new Error(`live-storage-load: requests[${index}].kind must be omitted or "${ARCHIVE_KIND}"`);
    }
    if (request.kind === ARCHIVE_KIND) {
      if (request.route !== ARCHIVE_KIND) throw new Error(`live-storage-load: requests[${index}] archive requests must use route "${ARCHIVE_KIND}"`);
      for (const field of ["instrumentId", "family", "from", "to"]) {
        if (typeof request.body[field] !== "string" || request.body[field].length === 0) {
          throw new Error(`live-storage-load: requests[${index}].body.${field} must be a non-empty string`);
        }
      }
    }
    if (request.paginate !== undefined) {
      if (typeof request.paginate !== "object" || Array.isArray(request.paginate) ||
          !Number.isSafeInteger(request.paginate.maxPages) || request.paginate.maxPages <= 0 || request.paginate.maxPages > MAX_PAGINATE_PAGES) {
        throw new Error(`live-storage-load: requests[${index}].paginate.maxPages must be 1..${MAX_PAGINATE_PAGES}`);
      }
    }
    if (request.abort !== undefined) {
      if (!request.abort || typeof request.abort !== "object" || Array.isArray(request.abort) ||
          Object.keys(request.abort).some((key) => key !== "afterMs") ||
          !Number.isSafeInteger(request.abort.afterMs) || request.abort.afterMs <= 0 || request.abort.afterMs > MAX_ABORT_AFTER_MS) {
        throw new Error(`live-storage-load: requests[${index}].abort must be { afterMs } with afterMs 1..${MAX_ABORT_AFTER_MS}`);
      }
    }
  }
  if (value.serverDelta !== undefined) {
    if (value.serverDelta !== true) throw new Error("live-storage-load: serverDelta must be omitted or true");
    if (!value.requests.some((request) => request.kind !== ARCHIVE_KIND)) {
      throw new Error("live-storage-load: serverDelta reads the live-storage service telemetry and needs at least one live-storage request");
    }
  }
  return value;
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function defaultRunGit(args) {
  const result = childProcess.spawnSync("git", args, { cwd: __dirname, maxBuffer: 512 * 1024 * 1024 });
  return result.error === undefined && result.status === 0 ? result.stdout : null;
}

function collectToolProvenance({ manifestBytes, scriptPath = __filename, runGit = defaultRunGit, nodeVersion = process.version }) {
  const head = runGit(["rev-parse", "HEAD"]);
  const status = head === null ? null : runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  let git = null;
  if (head !== null && status !== null) {
    const lines = status.toString("utf8").split("\n").filter((line) => line.length > 0);
    const untrackedFiles = lines.filter((line) => line.startsWith("??")).length;
    const trackedChanges = lines.length - untrackedFiles;
    const diff = trackedChanges > 0 ? runGit(["diff", "HEAD", "--binary"]) : null;
    git = {
      commit: head.toString("utf8").trim(),
      dirty: lines.length > 0,
      trackedChanges,
      untrackedFiles,
      trackedDiffSha256: diff === null ? null : sha256Hex(diff),
    };
  }
  return {
    git,
    scriptSha256: sha256Hex(fs.readFileSync(scriptPath)),
    manifestSha256: sha256Hex(manifestBytes),
    nodeVersion,
  };
}

function configuredUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("live-storage-load: TT_BENCH_LIVE_STORAGE_URL is required");
  const url = new URL(raw);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("live-storage-load: base URL must be an unauthenticated HTTP(S) URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function isAbortRejection(cause, controller) {
  if (!controller.signal.aborted) return false;
  const reason = controller.signal.reason;
  return cause === reason || cause?.cause === reason || cause?.name === "AbortError";
}

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function pickRouteCounters(record) {
  const counters = Object.fromEntries(HEALTH_COUNTER_FIELDS.map((field) => [field, boundedCounter(record?.[field])]));
  const failureReasons = record?.failureReasons && typeof record.failureReasons === "object" && !Array.isArray(record.failureReasons)
    ? Object.fromEntries(Object.entries(record.failureReasons)
      .filter(([reason, count]) => HEALTH_FAILURE_REASONS.has(reason) && Number.isSafeInteger(count) && count >= 0))
    : {};
  return { ...counters, failureReasons };
}

function pickFiniteFields(record, allowed) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => allowed.has(key) && Number.isFinite(value) && value >= 0));
}

function pickStorageFootprint(storage) {
  const result = {};
  for (const provider of ["binance", "dxfeed"]) {
    const candidate = storage?.[provider];
    result[provider] = Object.fromEntries(["database", "wal", "shm"].map((field) => [field,
      Number.isSafeInteger(candidate?.[field]) && candidate[field] >= 0 ? candidate[field] : null]));
  }
  return result;
}

async function scrapeHealth({ url, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_SCRAPE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
    const parsed = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
    const routes = parsed?.route?.telemetry?.routes;
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) throw new Error("health response has no live-storage route telemetry");
    return {
      inFlight: Number.isSafeInteger(parsed.route.inFlight) && parsed.route.inFlight >= 0 ? parsed.route.inFlight : null,
      routes: Object.fromEntries(Object.entries(routes).map(([name, record]) => [name, pickRouteCounters(record)])),
      runtime: pickFiniteFields(parsed.runtime, HEALTH_RUNTIME_FIELDS),
      storage: pickStorageFootprint(parsed.storage),
    };
  } finally {
    clearTimeout(timer);
  }
}

function diffRouteCounters(before, after, routeNames, runRequestsByRoute) {
  const routes = {};
  for (const name of routeNames) {
    const left = before.routes[name] ?? pickRouteCounters(null);
    const right = after.routes[name] ?? pickRouteCounters(null);
    const delta = Object.fromEntries(HEALTH_COUNTER_FIELDS.map((field) => [field, right[field] - left[field]]));
    if (Object.values(delta).some((value) => value < 0)) return null;
    const failureReasons = {};
    for (const reason of new Set([...Object.keys(left.failureReasons), ...Object.keys(right.failureReasons)])) {
      const change = (right.failureReasons[reason] ?? 0) - (left.failureReasons[reason] ?? 0);
      if (change < 0) return null;
      if (change > 0) failureReasons[reason] = change;
    }
    const runRequests = runRequestsByRoute[name] ?? 0;
    routes[name] = { delta, failureReasons, runRequests, unattributedRequests: Math.max(0, delta.requests - runRequests) };
  }
  return routes;
}

function resourceEvidence(before, after) {
  const delta = {};
  for (const field of CUMULATIVE_RUNTIME_FIELDS) {
    if (Number.isFinite(before.runtime[field]) && Number.isFinite(after.runtime[field])) {
      const change = after.runtime[field] - before.runtime[field];
      delta[field] = change >= 0 ? change : null;
    }
  }
  const storageDelta = {};
  for (const provider of ["binance", "dxfeed"]) {
    storageDelta[provider] = {};
    for (const field of ["database", "wal", "shm"]) {
      const left = before.storage[provider][field];
      const right = after.storage[provider][field];
      storageDelta[provider][field] = left === null || right === null ? null : right - left;
    }
  }
  return {
    runtime: { before: before.runtime, after: after.runtime, cumulativeDelta: delta },
    storage: { before: before.storage, after: after.storage, byteDelta: storageDelta },
  };
}

async function measureServerDelta({ before, healthUrl, fetchImpl, routeNames, runRequestsByRoute, settleMs, pollMs, sleep, now }) {
  const drainStartedAt = now();
  let after = null;
  let drained = null;
  let drainedAfterMs = null;
  try {
    for (;;) {
      after = await scrapeHealth({ url: healthUrl, fetchImpl });
      const elapsed = now() - drainStartedAt;
      if (before.inFlight === null || after.inFlight === null) break;
      if (after.inFlight <= before.inFlight) {
        drained = true;
        drainedAfterMs = Number(elapsed.toFixed(3));
        break;
      }
      if (elapsed >= settleMs) {
        drained = false;
        break;
      }
      await sleep(pollMs);
    }
  } catch (cause) {
    return { attribution: "HOST_WIDE", note: HOST_WIDE_NOTE, error: "HEALTH_UNAVAILABLE", detail: String(cause?.message ?? cause).slice(0, 160) };
  }
  const routes = diffRouteCounters(before, after, routeNames, runRequestsByRoute);
  if (routes === null) return { attribution: "HOST_WIDE", note: HOST_WIDE_NOTE, error: "SERVER_COUNTERS_RESET" };
  return {
    attribution: "HOST_WIDE",
    note: HOST_WIDE_NOTE,
    routes,
    ...resourceEvidence(before, after),
    inFlight: { before: before.inFlight, after: after.inFlight, drained, drainedAfterMs, settleMs },
  };
}

async function runManifest({ manifest, baseUrl, token, archiveUrl = null, archiveToken = null, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => performance.now(), onSample = null, provenance = null, signal = null, healthUrl = null, healthSettleMs = DEFAULT_HEALTH_SETTLE_MS, healthPollMs = DEFAULT_HEALTH_POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  validateManifest(manifest);
  baseUrl = configuredUrl(baseUrl);
  const wantsServerDelta = manifest.serverDelta === true;
  if (wantsServerDelta && healthUrl === null) throw new Error("live-storage-load: TT_BENCH_HEALTH_URL is required by manifests with serverDelta");
  healthUrl = wantsServerDelta ? configuredUrl(healthUrl) : null;
  if (!Number.isSafeInteger(healthSettleMs) || healthSettleMs < 0 || !Number.isSafeInteger(healthPollMs) || healthPollMs <= 0) {
    throw new Error("live-storage-load: health settle and poll intervals must be non-negative and positive safe integers");
  }
  const hasArchiveRequests = manifest.requests.some((request) => request.kind === ARCHIVE_KIND);
  const hasLiveStorageRequests = manifest.requests.some((request) => request.kind !== ARCHIVE_KIND);
  if (hasLiveStorageRequests && (typeof token !== "string" || token.length === 0)) throw new Error("live-storage-load: token is required");
  if (hasArchiveRequests && (typeof archiveToken !== "string" || archiveToken.length === 0)) throw new Error("live-storage-load: archive token is required for archive-query requests");
  const archiveEndpoint = `${new URL(archiveUrl === null ? baseUrl : configuredUrl(archiveUrl)).origin}${ARCHIVE_PATH}`;
  if (typeof fetchImpl !== "function") throw new Error("live-storage-load: fetch is unavailable");
  if (onSample !== null && typeof onSample !== "function") throw new Error("live-storage-load: onSample must be a function or null");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("live-storage-load: timeoutMs must be a positive safe integer");
  const samples = [];
  const pagination = [];
  const runId = crypto.randomUUID();
  const inFlightAborts = new Set();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    for (const abortWith of [...inFlightAborts]) abortWith(ABORT_CAUSE_INTERRUPT);
  };
  if (signal !== null) {
    if (signal.aborted) interrupted = true;
    else signal.addEventListener("abort", onInterrupt, { once: true });
  }
  const healthBefore = wantsServerDelta ? await scrapeHealth({ url: healthUrl, fetchImpl }).catch((cause) => ({ unavailable: String(cause?.message ?? cause).slice(0, 160) })) : null;
  const startedAtUtc = new Date().toISOString();
  const startedAt = now();

  async function fireOne({ route, kind, body, user, round, requestIndex, page, abortAfterMs = null }) {
    const correlationId = `${runId}.${user}.${round}.${requestIndex}.${page}`;
    const controller = new AbortController();
    let abortCause = null;
    let abortTimerFired = false;
    let abortAttributed = false;
    let responseCompleted = false;
    const abortWith = (cause) => {
      if (abortCause !== null) return;
      abortCause = cause;
      controller.abort(new Error(`client abort: ${cause}`));
    };
    const timer = setTimeout(() => abortWith(ABORT_CAUSE_TIMEOUT), timeoutMs);
    const abortTimer = abortAfterMs === null ? null : setTimeout(() => {
      abortTimerFired = true;
      abortWith(ABORT_CAUSE_BENCHMARK);
    }, abortAfterMs);
    inFlightAborts.add(abortWith);
    const requestStartedAt = now();
    let status = 0;
    let responseBytes = 0;
    let wireBytes = 0;
    let contentEncoding = null;
    let bodySha256 = null;
    let responseSummary = null;
    let failureClass = "TRANSPORT_FAILURE";
    let error = null;
    let nextCursor = null;
    let pointerToken = null;
    let headersMs = null;
    let bodyMs = null;
    const isArchive = kind === ARCHIVE_KIND;
    try {
      const response = await fetchImpl(isArchive ? archiveEndpoint : `${baseUrl}/${route}`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: isArchive
          ? {
            authorization: `Bearer ${archiveToken}`,
            "content-type": "application/json",
            "x-terminal-correlation-id": correlationId,
          }
          : {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-live-storage-contract-version": CONTRACT_VERSION,
            "x-terminal-correlation-id": correlationId,
          },
        body: JSON.stringify(isArchive ? { contractVersion: ARCHIVE_CONTRACT_VERSION, ...body } : body),
      });
      const headersAt = now();
      headersMs = Number((headersAt - requestStartedAt).toFixed(3));
      status = response.status;
      const responseCorrelationId = response.headers.get("x-terminal-correlation-id");
      const responseBody = Buffer.from(await response.arrayBuffer());
      bodyMs = Number((now() - headersAt).toFixed(3));
      responseCompleted = true;
      responseBytes = responseBody.byteLength;
      const declaredLength = response.headers.get("content-length");
      wireBytes = declaredLength !== null && /^\d{1,15}$/.test(declaredLength) ? Number(declaredLength) : responseBytes;
      contentEncoding = response.headers.get("content-encoding");
      bodySha256 = crypto.createHash("sha256").update(responseBody).digest("hex");
      responseSummary = summarizeResponseBody(responseBody);
      failureClass = classifyResponse(status, responseBody);
      if (responseCorrelationId !== correlationId) {
        failureClass = "CORRELATION_MISMATCH";
        error = `expected correlation ID ${correlationId}, received ${responseCorrelationId ?? "none"}`;
      }
      if (failureClass === "SUCCESS") {
        try {
          const parsed = JSON.parse(responseBody.toString("utf8"));
          if (typeof parsed?.nextCursor === "string") nextCursor = parsed.nextCursor;
          if (isArchive && typeof parsed?.pointerToken === "string") pointerToken = parsed.pointerToken;
        } catch { /* pagination is best-effort; a malformed body already failed classification */ }
      }
    } catch (cause) {
      error = String(cause?.message ?? cause).slice(0, 160);
      if (abortCause !== null && !responseCompleted && isAbortRejection(cause, controller)) {
        failureClass = FAILURE_CLASS_BY_ABORT_CAUSE[abortCause];
        abortAttributed = true;
      }
    } finally {
      clearTimeout(timer);
      if (abortTimer !== null) clearTimeout(abortTimer);
      inFlightAborts.delete(abortWith);
    }
    const abortRaced = abortCause !== null && !abortAttributed;
    const sample = {
      user, round, requestIndex, route, page, correlationId, status, responseBytes, wireBytes,
      ...(contentEncoding === null ? {} : { contentEncoding }),
      bodySha256, responseSummary, failureClass,
      durationMs: Number((now() - requestStartedAt).toFixed(3)),
      headersMs, bodyMs,
      ...(abortAfterMs === null ? {} : { abort: { afterMs: abortAfterMs, fired: abortTimerFired } }),
      ...(abortRaced ? { abortRaced: true } : {}),
      ...(error === null ? {} : { error }),
    };
    samples.push(sample);
    if (onSample !== null) onSample(sample);
    return { sample, nextCursor, pointerToken };
  }

  async function virtualUser(user) {
    for (let round = 0; round < manifest.rounds; round += 1) {
      for (let requestIndex = 0; requestIndex < manifest.requests.length; requestIndex += 1) {
        if (interrupted) return;
        const request = manifest.requests[requestIndex];
        const maxPages = request.paginate?.maxPages;
        const abortAfterMs = request.abort?.afterMs ?? null;
        if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
          await fireOne({ route: request.route, kind: request.kind, body: request.body, user, round, requestIndex, page: 0, abortAfterMs });
          continue;
        }
        let cursor = null;
        let pointerToken = null;
        let outcome = null;
        for (let page = 0; page < maxPages; page += 1) {
          if (interrupted) return;
          let body = request.body;
          if (cursor !== null) {
            body = request.kind === ARCHIVE_KIND
              ? { ...request.body, cursor, ...(pointerToken === null ? {} : { pointerToken }) }
              : { ...request.body, options: { ...request.body.options, cursor } };
          }
          const result = await fireOne({ route: request.route, kind: request.kind, body, user, round, requestIndex, page, abortAfterMs });
          if (result.sample.failureClass !== "SUCCESS") {
            outcome = { complete: false, reason: result.sample.failureClass, pages: page + 1 };
            break;
          }
          if (result.nextCursor === null) {
            outcome = result.sample.responseSummary?.complete === false
              ? { complete: false, reason: "RESPONSE_INCOMPLETE", pages: page + 1 }
              : { complete: true, reason: null, pages: page + 1 };
            break;
          }
          cursor = result.nextCursor;
          if (result.pointerToken !== null) pointerToken = result.pointerToken;
        }
        pagination.push({
          user, round, requestIndex, route: request.route,
          ...(outcome ?? { complete: false, reason: "MAX_PAGES", pages: maxPages }),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: manifest.users }, (_, user) => virtualUser(user)));
  if (signal !== null) signal.removeEventListener("abort", onInterrupt);
  const wallMs = Number((now() - startedAt).toFixed(3));
  let serverDelta = null;
  if (wantsServerDelta) {
    const routeNames = [...new Set(manifest.requests.filter((request) => request.kind !== ARCHIVE_KIND).map((request) => request.route))].sort();
    const runRequestsByRoute = Object.fromEntries(routeNames.map((name) => [name, samples.filter((sample) => sample.route === name).length]));
    serverDelta = healthBefore.unavailable === undefined
      ? await measureServerDelta({
        before: healthBefore, healthUrl, fetchImpl, routeNames, runRequestsByRoute,
        settleMs: healthSettleMs, pollMs: healthPollMs, sleep, now,
      })
      : { attribution: "HOST_WIDE", note: HOST_WIDE_NOTE, error: "HEALTH_UNAVAILABLE", detail: healthBefore.unavailable };
  }
  const byRoute = Object.fromEntries([...new Set(samples.map((sample) => sample.route))].sort().map((route) => [
    route, summarize(samples.filter((sample) => sample.route === route)),
  ]));
  const paginatedRoutes = new Set(
    manifest.requests.filter((request) => request.paginate !== undefined).map((request) => request.route),
  );
  const byRoutePage = Object.fromEntries(
    [...paginatedRoutes].sort().map((route) => {
      const routeSamples = samples.filter((sample) => sample.route === route);
      const pages = [...new Set(routeSamples.map((sample) => sample.page))].sort((a, b) => a - b);
      return [route, Object.fromEntries(pages.map((page) => [page, summarize(routeSamples.filter((sample) => sample.page === page))]))];
    }),
  );
  return {
    contractVersion: 1,
    ...(provenance === null ? {} : {
      source: {
        ...provenance,
        contractVersions: {
          liveStorage: hasLiveStorageRequests ? CONTRACT_VERSION : null,
          archive: hasArchiveRequests ? ARCHIVE_CONTRACT_VERSION : null,
        },
        endpoints: {
          liveStorageOrigin: hasLiveStorageRequests ? new URL(baseUrl).origin : null,
          archiveOrigin: hasArchiveRequests ? new URL(archiveEndpoint).origin : null,
          healthOrigin: wantsServerDelta ? new URL(healthUrl).origin : null,
        },
      },
    }),
    name: manifest.name ?? null,
    startedAtUtc,
    users: manifest.users,
    rounds: manifest.rounds,
    wallMs,
    ...(interrupted ? { interrupted: true } : {}),
    summary: summarize(samples),
    byRoute,
    ...(Object.keys(byRoutePage).length > 0 ? { byRoutePage } : {}),
    ...(pagination.length > 0 ? {
      pagination: {
        workloads: pagination.length,
        completed: pagination.filter((outcome) => outcome.complete).length,
        incomplete: pagination.filter((outcome) => !outcome.complete).length,
        reasons: Object.fromEntries([...new Set(pagination.filter((outcome) => !outcome.complete).map((outcome) => outcome.reason))].sort()
          .map((reason) => [reason, pagination.filter((outcome) => outcome.reason === reason).length])),
        outcomes: pagination,
      },
    } : {}),
    ...(serverDelta === null ? {} : { serverDelta }),
    samples,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const manifestPath = argv[0];
  if (!manifestPath) throw new Error("usage: live-storage-load <manifest.json>");
  const manifestBytes = fs.readFileSync(path.resolve(manifestPath));
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  const provenance = collectToolProvenance({ manifestBytes });
  const outputPath = argv[1] ? path.resolve(argv[1]) : null;
  const progressPath = outputPath === null ? null : `${outputPath}.samples.jsonl`;
  if (progressPath !== null) {
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, "", { encoding: "utf8", flag: "wx" });
  }
  const interruption = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    interruption.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const report = await runManifest({
    manifest,
    baseUrl: env.TT_BENCH_LIVE_STORAGE_URL ?? env.TT_LIVE_STORAGE_SERVICE_URL,
    token: env.TT_LIVE_STORAGE_CLIENT_TOKEN,
    archiveUrl: env.TT_BENCH_ARCHIVE_URL ?? null,
    archiveToken: env.TT_BENCH_ARCHIVE_TOKEN ?? env.VITE_ARCHIVE_CLIENT_TOKEN ?? null,
    timeoutMs: env.TT_BENCH_TIMEOUT_MS === undefined ? DEFAULT_TIMEOUT_MS : Number(env.TT_BENCH_TIMEOUT_MS),
    healthUrl: env.TT_BENCH_HEALTH_URL ?? null,
    ...(env.TT_BENCH_HEALTH_SETTLE_MS === undefined ? {} : { healthSettleMs: Number(env.TT_BENCH_HEALTH_SETTLE_MS) }),
    signal: interruption.signal,
    provenance,
    ...(progressPath === null ? {} : { onSample: (sample) => fs.appendFileSync(progressPath, `${JSON.stringify(sample)}\n`, "utf8") }),
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (argv[1]) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, outputPath);
  } else {
    process.stdout.write(serialized);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = {
  main, runManifest, validateManifest, summarize, percentile, configuredUrl, classifyResponse, summarizeResponseBody,
  collectToolProvenance,
};
