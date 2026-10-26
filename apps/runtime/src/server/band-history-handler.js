"use strict";

const { bandHistoryFrame, MAX_BAND_HISTORY_COLUMNS } = require("./frames");
const { bandRowsFor, MAX_BAND_ROWS, MAX_BAND_WINDOW_MS, MIN_COLUMN_MS, MAX_COLUMN_MS } = require("./band-history");

const FUTURE_SKEW_MS = 60_000;
const REQUEST_KEYS = Object.freeze(["column_ms", "from_ts", "price_hi", "price_lo", "request_id", "to_ts", "type"]);
const DEFAULT_MAX_CONCURRENT_READS = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUE_WAIT_MS = 15_000;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 30, windowMs: 60_000 });

function hasExactKeys(value, keys) {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function parseBandHistoryRequest(parsed, nowMs) {
  if (!hasExactKeys(parsed, REQUEST_KEYS)) return "unexpected fields";
  const { request_id: requestId, from_ts: fromMs, to_ts: toMs, price_lo: priceLo, price_hi: priceHi, column_ms: columnMs } = parsed;
  if (!Number.isSafeInteger(requestId) || requestId < 0) return "request_id must be a non-negative safe integer";
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) return "from_ts must be a non-negative safe integer";
  if (!Number.isSafeInteger(toMs) || toMs <= fromMs) return "to_ts must be a safe integer after from_ts";
  if (toMs > nowMs + FUTURE_SKEW_MS) return "to_ts is in the future";
  if (toMs - fromMs > MAX_BAND_WINDOW_MS) return "window is longer than two hours";
  if (typeof priceLo !== "number" || !Number.isFinite(priceLo) || priceLo <= 0) return "price_lo must be a positive finite number";
  if (typeof priceHi !== "number" || !Number.isFinite(priceHi) || priceHi < priceLo) return "price_hi must be a finite number at or above price_lo";
  if (!Number.isSafeInteger(columnMs) || columnMs < MIN_COLUMN_MS || columnMs > MAX_COLUMN_MS || columnMs % MIN_COLUMN_MS !== 0) return "column_ms must be whole seconds between one and sixty";
  return { requestId, fromMs, toMs, priceLo, priceHi, columnMs };
}

function createBandHistoryHandler({
  provider,
  storageReader = null,
  geometryFor,
  safelySend,
  now = () => Date.now(),
  log = console.error,
  label = "band-history",
  maxConcurrentReads = DEFAULT_MAX_CONCURRENT_READS,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxQueueWaitMs = DEFAULT_MAX_QUEUE_WAIT_MS,
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  if (provider !== "BINANCE" && provider !== "DXFEED") throw new Error("band-history: provider must be BINANCE or DXFEED");
  if (typeof geometryFor !== "function") throw new Error("band-history: geometryFor must be a function");
  if (typeof safelySend !== "function") throw new Error("band-history: safelySend must be a function");
  for (const [name, value] of [
    ["maxConcurrentReads", maxConcurrentReads], ["maxQueued", maxQueued], ["maxQueueWaitMs", maxQueueWaitMs],
    ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`band-history: ${name} must be a positive safe integer`);
  }
  const latestByClient = new Map();
  const readingClients = new Set();
  const readsByKey = new Map();
  const queue = [];
  const requestTimes = new Map();
  const rejectionLoggedAt = new Map();
  const counters = { admitted: 0, queued: 0, rejected: 0, refused: 0, cancelled: 0, completed: 0, failed: 0, dropped: 0, columns: 0, elapsedMs: 0 };
  let reading = 0;
  let disposed = false;

  function identityOf(instrument) {
    return provider === "BINANCE"
      ? { provider, symbol: instrument.symbol, marketKind: instrument.marketKind }
      : { provider, symbol: instrument.symbol, assetClass: instrument.assetClass };
  }

  function scopeOf(instrument) {
    return provider === "BINANCE" ? instrument.marketKind : instrument.assetClass;
  }

  function requestKeyFor(instrument, request) {
    return `${instrument.symbol}\0${scopeOf(instrument)}\0${request.fromMs}\0${request.toMs}\0${request.priceLo}\0${request.priceHi}\0${request.columnMs}`;
  }

  function send(client, instrument, request, geometry, columns, complete, reason, retryAfterMs = null) {
    if (disposed || latestByClient.get(client) !== request) return;
    latestByClient.delete(client);
    let frame;
    try {
      const rows = geometry === null ? null : bandRowsFor({ priceLo: request.priceLo, priceHi: request.priceHi, ...geometry });
      frame = bandHistoryFrame(identityOf(instrument), {
        requestId: request.requestId, fromTs: request.fromMs, toTs: request.toMs, priceLo: request.priceLo, priceHi: request.priceHi, columnMs: request.columnMs,
        rowWidth: rows?.rowWidth ?? null, rowLo: rows?.rowLo ?? null, rowHi: rows?.rowHi ?? null, complete, reason, retryAfterMs, columns,
      });
    } catch (error) {
      log(`${label}: failed to build the band history frame`, error?.message ?? error);
      return;
    }
    safelySend(client, frame);
  }

  function refuse(client, instrument, raw, reason) {
    let frame;
    try {
      frame = bandHistoryFrame(identityOf(instrument), {
        requestId: raw.request_id, fromTs: raw.from_ts, toTs: raw.to_ts, priceLo: raw.price_lo, priceHi: raw.price_hi, columnMs: raw.column_ms,
        rowWidth: null, rowLo: null, rowHi: null, complete: false, reason, retryAfterMs: null, columns: [],
      });
    } catch {
      return false;
    }
    counters.refused += 1;
    safelySend(client, frame);
    return true;
  }

  function reject(client, instrument, request, geometry, why, retryAfterMs = null) {
    counters.rejected += 1;
    const at = now();
    if ((rejectionLoggedAt.get(client) ?? -Infinity) + rateLimit.windowMs <= at) {
      rejectionLoggedAt.set(client, at);
      log(`${label}: band history request refused (${why}); reading ${reading}, waiting ${queue.length}`);
    }
    send(client, instrument, request, geometry, [], false, "OVERLOADED", retryAfterMs);
  }

  function reserveRateBudget(client, at) {
    const fresh = (requestTimes.get(client) ?? []).filter((t) => at - t < rateLimit.windowMs);
    if (fresh.length >= rateLimit.max) {
      requestTimes.set(client, fresh);
      return Math.max(1, fresh[0] + rateLimit.windowMs - at);
    }
    fresh.push(at);
    requestTimes.set(client, fresh);
    return null;
  }

  function dropQueued(client) {
    const index = queue.findIndex((entry) => entry.client === client);
    if (index === -1) return;
    queue.splice(index, 1);
    counters.cancelled += 1;
  }

  function run(requestKey) {
    const entry = readsByKey.get(requestKey);
    const { instrument, request, geometry, controller } = entry;
    reading += 1;
    counters.admitted += 1;
    const startedAt = now();
    let read;
    try {
      read = typeof storageReader?.readBandHistory === "function"
        ? storageReader.readBandHistory(instrument.symbol, scopeOf(instrument), {
          fromTs: request.fromMs, toTs: request.toMs, tickSize: geometry.tickSize, clusterTicks: geometry.clusterTicks, rowClusters: geometry.rowClusters,
          priceLo: request.priceLo, priceHi: request.priceHi, columnMs: request.columnMs,
        }, { signal: controller.signal })
        : Promise.resolve({ columns: [], available: false });
    } catch (error) {
      read = Promise.reject(error);
    }
    Promise.resolve(read).then(({ columns = [], available = true, reason: upstreamReason = null } = {}) => {
      if (controller.signal.aborted) return;
      counters.completed += 1;
      const kept = Array.isArray(columns) ? columns.slice(0, MAX_BAND_HISTORY_COLUMNS) : [];
      counters.columns += kept.length;
      const reason = !available ? upstreamReason === "READ_TIMEOUT" ? "READ_TIMEOUT" : ["RATE_LIMITED", "QUEUE_FULL", "QUEUE_TIMEOUT"].includes(upstreamReason) ? "OVERLOADED" : "STORAGE_UNAVAILABLE" : Array.isArray(columns) && columns.length > MAX_BAND_HISTORY_COLUMNS ? "READ_FAILED" : null;
      for (const [subscribedClient, subscribedRequest] of entry.subscribers) {
        send(subscribedClient, instrument, subscribedRequest, geometry, reason === null ? kept : [], reason === null, reason);
      }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      counters.failed += 1;
      log(`${label}: band history read failed`, error?.message ?? error);
      for (const [subscribedClient, subscribedRequest] of entry.subscribers) {
        send(subscribedClient, instrument, subscribedRequest, geometry, [], false, "READ_FAILED");
      }
    }).finally(() => {
      counters.elapsedMs += now() - startedAt;
      reading -= 1;
      for (const subscribedClient of entry.subscribers.keys()) readingClients.delete(subscribedClient);
      if (readsByKey.get(requestKey) === entry) readsByKey.delete(requestKey);
      dispatch();
    });
  }

  function attachOrLaunch(client, instrument, request, geometry) {
    const requestKey = requestKeyFor(instrument, request);
    const sharedEntry = readsByKey.get(requestKey);
    if (sharedEntry) {
      sharedEntry.subscribers.set(client, request);
      readingClients.add(client);
      return;
    }
    readsByKey.set(requestKey, { instrument, request, geometry, controller: new AbortController(), subscribers: new Map([[client, request]]) });
    readingClients.add(client);
    run(requestKey);
  }

  function dispatch() {
    while (!disposed && reading < maxConcurrentReads) {
      const index = queue.findIndex((entry) => !readingClients.has(entry.client));
      if (index === -1) return;
      const [entry] = queue.splice(index, 1);
      if (latestByClient.get(entry.client) !== entry.request) {
        counters.cancelled += 1;
        continue;
      }
      if (now() - entry.queuedAt > maxQueueWaitMs) {
        reject(entry.client, entry.instrument, entry.request, entry.geometry, "waited too long");
        continue;
      }
      attachOrLaunch(entry.client, entry.instrument, entry.request, entry.geometry);
    }
  }

  function handle(parsed, client, instrument) {
    if (disposed || !instrument) return;
    const request = parseBandHistoryRequest(parsed, now());
    if (typeof request === "string") {
      if (typeof parsed === "object" && parsed !== null && refuse(client, instrument, parsed, "BAD_REQUEST")) return;
      counters.dropped += 1;
      log(`${label}: dropped band_history request: ${request}`);
      return;
    }
    const geometry = geometryFor(instrument) ?? null;
    latestByClient.set(client, request);
    dropQueued(client);
    if (geometry === null) {
      send(client, instrument, request, null, [], false, "GEOMETRY_UNAVAILABLE");
      return;
    }
    const { rowLo, rowHi } = bandRowsFor({ priceLo: request.priceLo, priceHi: request.priceHi, ...geometry });
    if (rowHi - rowLo + 1 > MAX_BAND_ROWS) {
      counters.refused += 1;
      send(client, instrument, request, null, [], false, "BAND_TOO_WIDE");
      return;
    }
    const retryAfterMs = reserveRateBudget(client, now());
    if (retryAfterMs !== null) {
      reject(client, instrument, request, geometry, "rate budget", retryAfterMs);
      return;
    }
    if (readingClients.has(client) || reading >= maxConcurrentReads) {
      if (queue.length >= maxQueued) {
        reject(client, instrument, request, geometry, "queue full");
        return;
      }
      queue.push({ client, instrument, request, geometry, queuedAt: now() });
      counters.queued += 1;
      return;
    }
    attachOrLaunch(client, instrument, request, geometry);
  }

  function forget(client) {
    latestByClient.delete(client);
    requestTimes.delete(client);
    rejectionLoggedAt.delete(client);
    dropQueued(client);
    readingClients.delete(client);
    for (const [key, entry] of readsByKey) {
      entry.subscribers.delete(client);
      if (entry.subscribers.size === 0) {
        if (readsByKey.get(key) === entry) readsByKey.delete(key);
        entry.controller.abort();
      }
    }
  }

  function dispose() {
    disposed = true;
    counters.cancelled += queue.length;
    queue.length = 0;
    latestByClient.clear();
    requestTimes.clear();
    rejectionLoggedAt.clear();
    for (const entry of readsByKey.values()) entry.controller.abort();
    readsByKey.clear();
  }

  function stats() {
    return Object.freeze({ ...counters, reading, waiting: queue.length });
  }

  return Object.freeze({ handle, forget, dispose, stats });
}

module.exports = {
  createBandHistoryHandler,
  parseBandHistoryRequest,
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  DEFAULT_RATE_LIMIT,
};
