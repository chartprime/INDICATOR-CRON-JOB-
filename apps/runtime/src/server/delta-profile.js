"use strict";

const { deltaProfileFrame, MAX_DELTA_PROFILE_ROWS } = require("./frames");

const PIECE_MS = 2 * 60 * 60 * 1000;
const MAX_DELTA_PROFILE_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;
const CLOSED_GRACE_MS = 2 * 60 * 1000;
const RECENT_PIECE_TTL_MS = 30 * 60 * 1000;
const MIN_PIECE_MS = 30 * 60 * 1000;
const REQUEST_KEYS = Object.freeze(["from_ts", "request_id", "row_width", "to_ts", "type"]);
const REQUEST_KEYS_WITH_PIECE = Object.freeze(["from_ts", "piece_ms", "request_id", "row_width", "to_ts", "type"]);
const DEFAULT_MAX_CONCURRENT_READS = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUE_WAIT_MS = 15_000;
const DEFAULT_MAX_CACHED_PIECES = 1_024;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 30, windowMs: 60_000 });
const UPSTREAM_OVERLOAD_REASONS = Object.freeze(["RATE_LIMITED", "QUEUE_FULL", "QUEUE_TIMEOUT", "READ_TIMEOUT"]);

function hasExactKeys(value, keys) {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function parseDeltaProfileRequest(parsed, nowMs, maxPieceMs = PIECE_MS) {
  const hasPiece = Object.hasOwn(parsed, "piece_ms");
  if (!hasExactKeys(parsed, hasPiece ? REQUEST_KEYS_WITH_PIECE : REQUEST_KEYS)) return "unexpected fields";
  const { request_id: requestId, from_ts: fromMs, to_ts: toMs, row_width: rowWidth, piece_ms: pieceMs } = parsed;
  if (hasPiece && (!Number.isSafeInteger(pieceMs) || pieceMs < MIN_PIECE_MS || pieceMs > maxPieceMs || maxPieceMs % pieceMs !== 0)) {
    return "piece_ms must be a whole divisor of the piece length, at least half an hour";
  }
  if (!Number.isSafeInteger(requestId) || requestId < 0) return "request_id must be a non-negative safe integer";
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) return "from_ts must be a non-negative safe integer";
  if (!Number.isSafeInteger(toMs) || toMs <= fromMs) return "to_ts must be a safe integer after from_ts";
  if (toMs > nowMs + FUTURE_SKEW_MS) return "to_ts is in the future";
  if (toMs - fromMs > MAX_DELTA_PROFILE_WINDOW_MS) return "window is longer than eight days";
  if (typeof rowWidth !== "number" || !Number.isFinite(rowWidth) || rowWidth <= 0) return "row_width must be a positive finite number";
  return { requestId, fromMs, toMs, rowWidth, pieceMs: hasPiece ? pieceMs : maxPieceMs };
}

function piecesOf(fromMs, toMs, pieceMs) {
  const pieces = [];
  let to = toMs;
  while (to > fromMs) {
    const from = Math.max(fromMs, Math.floor((to - 1) / pieceMs) * pieceMs);
    pieces.push({ from, to });
    to = from;
  }
  return pieces;
}

function rowsFromBuckets(buckets, rowWidth) {
  const rows = [];
  let previousPrice = 0;
  for (const bucket of buckets) {
    const price = Number((bucket.bucket * rowWidth).toPrecision(12));
    if (!(price > previousPrice)) continue;
    rows.push([price, bucket.buyVolume, bucket.sellVolume]);
    previousPrice = price;
  }
  return rows;
}

function createDeltaProfileHandler({
  provider,
  storageReader = null,
  safelySend,
  now = () => Date.now(),
  log = console.error,
  label = "delta-profile",
  pieceMs = PIECE_MS,
  closedGraceMs = CLOSED_GRACE_MS,
  recentPieceTtlMs = RECENT_PIECE_TTL_MS,
  maxConcurrentReads = DEFAULT_MAX_CONCURRENT_READS,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxQueueWaitMs = DEFAULT_MAX_QUEUE_WAIT_MS,
  maxCachedPieces = DEFAULT_MAX_CACHED_PIECES,
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  if (provider !== "BINANCE" && provider !== "DXFEED") throw new Error("delta-profile: provider must be BINANCE or DXFEED");
  if (typeof safelySend !== "function") throw new Error("delta-profile: safelySend must be a function");
  for (const [name, value] of [
    ["pieceMs", pieceMs], ["closedGraceMs", closedGraceMs], ["recentPieceTtlMs", recentPieceTtlMs], ["maxConcurrentReads", maxConcurrentReads], ["maxQueued", maxQueued],
    ["maxQueueWaitMs", maxQueueWaitMs], ["maxCachedPieces", maxCachedPieces], ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`delta-profile: ${name} must be a positive safe integer`);
  }
  const jobByClient = new Map();
  const queue = [];
  const readsByKey = new Map();
  const cache = new Map();
  const requestTimes = new Map();
  const rejectionLoggedAt = new Map();
  const counters = { admitted: 0, queued: 0, rejected: 0, refused: 0, cancelled: 0, completed: 0, failed: 0, capped: 0, cacheHits: 0, pieces: 0, rows: 0, elapsedMs: 0 };
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

  function pieceKey(instrument, rowWidth, piece) {
    return `${instrument.symbol}\0${scopeOf(instrument)}\0${rowWidth}\0${piece.from}\0${piece.to}`;
  }

  function closed(piece, ownPieceMs) {
    return piece.to - piece.from === ownPieceMs && piece.from % ownPieceMs === 0 && piece.to <= now() - closedGraceMs;
  }

  function remember(key, rows, piece) {
    const at = now();
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { rows, expiresAt: piece.to + recentPieceTtlMs > at ? at + recentPieceTtlMs : Infinity });
    while (cache.size > maxCachedPieces) cache.delete(cache.keys().next().value);
  }

  function sendPiece(job, piece, rows, reason, retryAfterMs = null) {
    let frame;
    try {
      frame = deltaProfileFrame(identityOf(job.instrument), {
        requestId: job.request.requestId, fromTs: piece.from, toTs: piece.to, rowWidth: job.request.rowWidth,
        complete: reason === null, reason, retryAfterMs, pending: job.pieces.length, rows,
      });
    } catch (error) {
      log(`${label}: failed to build the profile frame`, error?.message ?? error);
      return;
    }
    safelySend(job.client, frame);
  }

  function refuse(client, instrument, raw) {
    let frame;
    try {
      frame = deltaProfileFrame(identityOf(instrument), {
        requestId: raw.request_id, fromTs: raw.from_ts, toTs: raw.to_ts, rowWidth: raw.row_width,
        complete: false, reason: "BAD_REQUEST", retryAfterMs: null, pending: 0, rows: [],
      });
    } catch {
      return false;
    }
    counters.refused += 1;
    safelySend(client, frame);
    return true;
  }

  function finish(job) {
    if (jobByClient.get(job.client) === job) jobByClient.delete(job.client);
  }

  function reject(job, why, retryAfterMs = null) {
    counters.rejected += 1;
    const at = now();
    if ((rejectionLoggedAt.get(job.client) ?? -Infinity) + rateLimit.windowMs <= at) {
      rejectionLoggedAt.set(job.client, at);
      log(`${label}: profile request refused (${why}); reading ${reading}, waiting ${queue.length}`);
    }
    const piece = job.pieces.shift();
    job.pieces.length = 0;
    sendPiece(job, piece, [], "OVERLOADED", retryAfterMs);
    finish(job);
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

  function cancel(job) {
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    counters.cancelled += 1;
    for (const [key, entry] of readsByKey) {
      if (!entry.subscribers.delete(job)) continue;
      if (entry.subscribers.size === 0) {
        readsByKey.delete(key);
        entry.controller.abort();
      }
    }
  }

  function advance(job) {
    while (job.pieces.length > 0) {
      const piece = job.pieces[0];
      const cached = cache.get(pieceKey(job.instrument, job.request.rowWidth, piece));
      if (cached === undefined || cached.expiresAt <= now()) break;
      job.pieces.shift();
      counters.cacheHits += 1;
      sendPiece(job, piece, cached.rows, null);
    }
    if (job.pieces.length === 0) {
      finish(job);
      return;
    }
    if (queue.length >= maxQueued) {
      reject(job, "queue full");
      return;
    }
    job.queuedAt = now();
    queue.push(job);
    counters.queued += 1;
    dispatch();
  }

  function readPiece(instrument, rowWidth, piece, signal) {
    const options = { fromTs: piece.from, toTs: piece.to, originPrice: 0, rowWidth };
    if (typeof storageReader?.readVolumeProfileAsync === "function") {
      return storageReader.readVolumeProfileAsync(instrument.symbol, scopeOf(instrument), options, { signal });
    }
    if (typeof storageReader?.readAsync === "function") {
      return storageReader.readAsync("readVolumeProfile", instrument.symbol, scopeOf(instrument), options, { signal });
    }
    return Promise.resolve({ buckets: [], available: false });
  }

  function settle(entry, outcome) {
    const { key, piece } = entry;
    for (const job of entry.subscribers) {
      if (outcome.reason !== null) {
        job.pieces.length = 0;
        sendPiece(job, piece, [], outcome.reason);
        finish(job);
        continue;
      }
      sendPiece(job, piece, outcome.rows, null);
      advance(job);
    }
    if (outcome.reason === null && closed(piece, entry.pieceMs)) remember(key, outcome.rows, piece);
  }

  function run(entry) {
    const { piece, instrument, rowWidth, controller } = entry;
    reading += 1;
    counters.admitted += 1;
    const startedAt = now();
    let read;
    try {
      read = readPiece(instrument, rowWidth, piece, controller.signal);
    } catch (error) {
      read = Promise.reject(error);
    }
    Promise.resolve(read).then(({ buckets = [], available = true, reason: upstreamReason = null } = {}) => {
      if (controller.signal.aborted) return;
      counters.completed += 1;
      const capped = buckets.length > MAX_DELTA_PROFILE_ROWS;
      if (capped) counters.capped += 1;
      const reason = !available ? UPSTREAM_OVERLOAD_REASONS.includes(upstreamReason) ? "OVERLOADED" : "STORAGE_UNAVAILABLE" : capped ? "ROWS_CAPPED" : null;
      const rows = reason === null ? rowsFromBuckets(buckets, rowWidth) : [];
      counters.rows += rows.length;
      settle(entry, { rows, reason });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      counters.failed += 1;
      log(`${label}: profile read failed`, error?.message ?? error);
      settle(entry, { rows: [], reason: "READ_FAILED" });
    }).finally(() => {
      counters.elapsedMs += now() - startedAt;
      reading -= 1;
      if (readsByKey.get(entry.key) === entry) readsByKey.delete(entry.key);
      dispatch();
    });
  }

  function launch(job) {
    const piece = job.pieces.shift();
    counters.pieces += 1;
    const key = pieceKey(job.instrument, job.request.rowWidth, piece);
    const shared = readsByKey.get(key);
    if (shared) {
      shared.subscribers.add(job);
      return;
    }
    const entry = { key, piece, pieceMs: job.request.pieceMs, instrument: job.instrument, rowWidth: job.request.rowWidth, controller: new AbortController(), subscribers: new Set([job]) };
    readsByKey.set(key, entry);
    run(entry);
  }

  function dispatch() {
    while (!disposed && reading < maxConcurrentReads && queue.length > 0) {
      const job = queue.shift();
      if (now() - job.queuedAt > maxQueueWaitMs) {
        reject(job, "waited too long");
        continue;
      }
      launch(job);
    }
  }

  function handle(parsed, client, instrument) {
    if (disposed || !instrument) return;
    const request = parseDeltaProfileRequest(parsed, now(), pieceMs);
    if (typeof request === "string") {
      if (refuse(client, instrument, parsed)) return;
      log(`${label}: dropped delta_profile request: ${request}`);
      return;
    }
    const previous = jobByClient.get(client);
    if (previous) cancel(previous);
    const job = { client, instrument, request, pieces: piecesOf(request.fromMs, request.toMs, request.pieceMs), queuedAt: 0 };
    jobByClient.set(client, job);
    const retryAfterMs = reserveRateBudget(client, now());
    if (retryAfterMs !== null) {
      reject(job, "rate budget", retryAfterMs);
      return;
    }
    advance(job);
  }

  function forget(client) {
    const job = jobByClient.get(client);
    if (job) cancel(job);
    jobByClient.delete(client);
    requestTimes.delete(client);
    rejectionLoggedAt.delete(client);
  }

  function dispose() {
    disposed = true;
    for (const job of jobByClient.values()) cancel(job);
    jobByClient.clear();
    queue.length = 0;
    requestTimes.clear();
    rejectionLoggedAt.clear();
    readsByKey.clear();
    cache.clear();
  }

  function stats() {
    return Object.freeze({ ...counters, reading, waiting: queue.length, cached: cache.size });
  }

  return Object.freeze({ handle, forget, dispose, stats });
}

module.exports = {
  createDeltaProfileHandler,
  parseDeltaProfileRequest,
  piecesOf,
  rowsFromBuckets,
  PIECE_MS,
  MIN_PIECE_MS,
  CLOSED_GRACE_MS,
  RECENT_PIECE_TTL_MS,
  MAX_DELTA_PROFILE_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  DEFAULT_MAX_CACHED_PIECES,
  DEFAULT_RATE_LIMIT,
};
