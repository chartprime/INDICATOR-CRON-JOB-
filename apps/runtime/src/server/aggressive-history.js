"use strict";

const {
  aggressiveHistoryFrame,
  storageTradeRowToTradeFrame,
  dxfeedTradeFrame,
  MAX_AGGRESSIVE_HISTORY_TRADES,
} = require("./frames");
const { isStoredDxFeedTimeAndSaleTapeRow, adaptStoredDxFeedTimeAndSaleRow } = require("../providers/dxfeed/dxfeed-trade-adapter");

const MAX_AGGRESSIVE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;
const REQUEST_KEYS = Object.freeze(["from_ts", "min_size", "request_id", "to_ts", "type"]);
const REQUEST_KEYS_WITH_CURSOR = Object.freeze(["cursor", ...REQUEST_KEYS]);
const HISTORY_CURSOR_KEYS = Object.freeze(["f", "i", "k", "m", "p", "s", "t", "v", "x"]);
const HISTORY_CURSOR_VERSION = 1;
const MAX_HISTORY_CURSOR_LENGTH = 512;
const DEFAULT_MAX_CONCURRENT_READS = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUE_WAIT_MS = 15_000;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 60, windowMs: 60_000 });

function hasExactKeys(value, keys) {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function historyCursorScope(provider, instrument) {
  return provider === "BINANCE" ? `market:${instrument.marketKind}` : `asset:${instrument.assetClass}`;
}

function encodeHistoryCursor(provider, instrument, request, row) {
  const ts = provider === "BINANCE" ? row?.ts : row?.event_time;
  const id = row?.id;
  if (!Number.isSafeInteger(ts) || ts < 0 || !Number.isSafeInteger(id) || id <= 0) return null;
  return Buffer.from(JSON.stringify({
    v: HISTORY_CURSOR_VERSION,
    p: provider,
    s: instrument.symbol,
    k: historyCursorScope(provider, instrument),
    f: request.fromMs,
    t: request.toMs,
    m: request.minSize,
    x: ts,
    i: id,
  }), "utf8").toString("base64url");
}

function decodeHistoryCursor(token, provider, instrument, request) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_HISTORY_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof decoded !== "object" || decoded === null || !hasExactKeys(decoded, HISTORY_CURSOR_KEYS) ||
    decoded.v !== HISTORY_CURSOR_VERSION ||
    decoded.p !== provider ||
    decoded.s !== instrument.symbol ||
    decoded.k !== historyCursorScope(provider, instrument) ||
    decoded.f !== request.fromMs || decoded.t !== request.toMs || decoded.m !== request.minSize ||
    !Number.isSafeInteger(decoded.x) || decoded.x < request.fromMs || decoded.x >= request.toMs ||
    !Number.isSafeInteger(decoded.i) || decoded.i <= 0
  ) {
    return null;
  }
  return { ts: decoded.x, id: decoded.i };
}

function parseAggressiveHistoryRequest(parsed, nowMs) {
  const hasCursor = Object.hasOwn(parsed, "cursor");
  if (!hasExactKeys(parsed, hasCursor ? REQUEST_KEYS_WITH_CURSOR : REQUEST_KEYS)) return "unexpected fields";
  const { request_id: requestId, from_ts: fromMs, to_ts: toMs, min_size: minSize, cursor } = parsed;
  if (!Number.isSafeInteger(requestId) || requestId < 0) return "request_id must be a non-negative safe integer";
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) return "from_ts must be a non-negative safe integer";
  if (!Number.isSafeInteger(toMs) || toMs <= fromMs) return "to_ts must be a safe integer after from_ts";
  if (toMs > nowMs + FUTURE_SKEW_MS) return "to_ts is in the future";
  if (toMs - fromMs > MAX_AGGRESSIVE_HISTORY_WINDOW_MS) return "window is longer than a day";
  if (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0) return "min_size must be a non-negative finite number";
  if (hasCursor && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_HISTORY_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
    return "cursor must be a non-empty base64url string within the length limit";
  }
  return { requestId, fromMs, toMs, minSize, cursor: hasCursor ? cursor : null };
}

function rowsToTradeFrames(provider, instrument, rows) {
  const frames = [];
  let dropped = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    try {
      if (provider === "BINANCE") {
        frames.push(storageTradeRowToTradeFrame(row, instrument.symbol, instrument.marketKind));
      } else {
        const requireValidTick = instrument.assetClass === "FUTURE";
        if (!isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick })) continue;
        frames.push(dxfeedTradeFrame(adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick })));
      }
    } catch {
      dropped += 1;
    }
  }
  return { frames, dropped };
}

function createAggressiveHistoryHandler({
  provider,
  storageReader = null,
  safelySend,
  now = () => Date.now(),
  log = console.error,
  label = "aggressive-history",
  maxConcurrentReads = DEFAULT_MAX_CONCURRENT_READS,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxQueueWaitMs = DEFAULT_MAX_QUEUE_WAIT_MS,
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  if (provider !== "BINANCE" && provider !== "DXFEED") throw new Error("aggressive-history: provider must be BINANCE or DXFEED");
  if (typeof safelySend !== "function") throw new Error("aggressive-history: safelySend must be a function");
  for (const [name, value] of [
    ["maxConcurrentReads", maxConcurrentReads], ["maxQueued", maxQueued], ["maxQueueWaitMs", maxQueueWaitMs],
    ["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`aggressive-history: ${name} must be a positive safe integer`);
  }
  const latestByClient = new Map();
  const readingClients = new Set();
  const readsByKey = new Map();
  const queue = [];
  const requestTimes = new Map();
  const rejectionLoggedAt = new Map();
  const counters = { admitted: 0, queued: 0, rejected: 0, cancelled: 0, completed: 0, failed: 0, capped: 0, dropped: 0, rows: 0, elapsedMs: 0 };
  let reading = 0;
  let disposed = false;

  function identityOf(instrument) {
    return provider === "BINANCE"
      ? { provider, symbol: instrument.symbol, marketKind: instrument.marketKind }
      : { provider, symbol: instrument.symbol, assetClass: instrument.assetClass };
  }

  function requestKeyFor(instrument, request, cursor) {
    const scope = provider === "BINANCE" ? instrument.marketKind : instrument.assetClass;
    return `${instrument.symbol}\0${scope}\0${request.fromMs}\0${request.toMs}\0${request.minSize}\0${cursor === null ? "" : `${cursor.ts}:${cursor.id}`}`;
  }

  function send(client, instrument, request, trades, complete, reason, nextCursor = null, retryAfterMs = null) {
    if (disposed || latestByClient.get(client) !== request) return;
    latestByClient.delete(client);
    let frame;
    try {
      frame = aggressiveHistoryFrame(identityOf(instrument), {
        requestId: request.requestId, fromTs: request.fromMs, toTs: request.toMs, minSize: request.minSize, complete, reason, nextCursor, retryAfterMs, trades,
      });
    } catch (error) {
      log(`${label}: failed to build the history frame`, error?.message ?? error);
      return;
    }
    safelySend(client, frame);
  }

  function reject(client, instrument, request, why, retryAfterMs = null) {
    counters.rejected += 1;
    const at = now();
    if ((rejectionLoggedAt.get(client) ?? -Infinity) + rateLimit.windowMs <= at) {
      rejectionLoggedAt.set(client, at);
      log(`${label}: history request refused (${why}); reading ${reading}, waiting ${queue.length}`);
    }
    send(client, instrument, request, [], false, "OVERLOADED", null, retryAfterMs);
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
    const { instrument, request, cursor, controller } = entry;
    reading += 1;
    counters.admitted += 1;
    const startedAt = now();
    let read;
    try {
      read = typeof storageReader?.readAggressivePrintsAsync === "function"
        ? storageReader.readAggressivePrintsAsync(instrument.symbol, provider === "BINANCE" ? instrument.marketKind : instrument.assetClass, {
          fromMs: request.fromMs, toMs: request.toMs, minSize: request.minSize, limit: MAX_AGGRESSIVE_HISTORY_TRADES + 1,
          ...(cursor === null ? {} : { cursor }),
        }, { signal: controller.signal })
        : Promise.resolve({ rows: [], available: false });
    } catch (error) {
      read = Promise.reject(error);
    }
    Promise.resolve(read).then(({ rows = [], available = true } = {}) => {
      const capped = rows.length > MAX_AGGRESSIVE_HISTORY_TRADES;
      const kept = capped ? rows.slice(0, MAX_AGGRESSIVE_HISTORY_TRADES) : rows;
      const { frames, dropped } = rowsToTradeFrames(provider, instrument, kept);
      counters.completed += 1;
      counters.rows += frames.length;
      if (capped) counters.capped += 1;
      if (dropped > 0) {
        counters.dropped += dropped;
        log(`${label}: ${dropped} of ${kept.length} recorded rows could not be converted to trade frames; the reply is marked CONVERSION_INCOMPLETE`);
      }
      const nextCursor = capped ? encodeHistoryCursor(provider, instrument, request, kept.at(-1)) : null;
      if (capped && nextCursor === null) {
        log(`${label}: capped history page has no usable stable cursor`);
      }
      const reason = !available ? "STORAGE_UNAVAILABLE" : dropped > 0 || (capped && nextCursor === null) ? "CONVERSION_INCOMPLETE" : capped ? "CAP_REACHED" : null;
      for (const [subscribedClient, subscribedRequest] of entry.subscribers) {
        send(subscribedClient, instrument, subscribedRequest, frames, reason === null, reason, reason === "CAP_REACHED" ? nextCursor : null);
      }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      counters.failed += 1;
      log(`${label}: history read failed`, error?.message ?? error);
      for (const [subscribedClient, subscribedRequest] of entry.subscribers) {
        send(subscribedClient, instrument, subscribedRequest, [], false, "READ_FAILED");
      }
    }).finally(() => {
      counters.elapsedMs += now() - startedAt;
      reading -= 1;
      for (const subscribedClient of entry.subscribers.keys()) readingClients.delete(subscribedClient);
      if (readsByKey.get(requestKey) === entry) readsByKey.delete(requestKey);
      dispatch();
    });
  }

  function attachOrLaunch(client, instrument, request, cursor) {
    const requestKey = requestKeyFor(instrument, request, cursor);
    const sharedEntry = readsByKey.get(requestKey);
    if (sharedEntry) {
      sharedEntry.subscribers.set(client, request);
      readingClients.add(client);
      return;
    }
    readsByKey.set(requestKey, {
      instrument, request, cursor, controller: new AbortController(), subscribers: new Map([[client, request]]),
    });
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
        reject(entry.client, entry.instrument, entry.request, "waited too long");
        continue;
      }
      attachOrLaunch(entry.client, entry.instrument, entry.request, entry.cursor);
    }
  }

  function handle(parsed, client, instrument) {
    if (disposed || !instrument) return;
    const request = parseAggressiveHistoryRequest(parsed, now());
    if (typeof request === "string") {
      log(`${label}: dropped aggressive_history request: ${request}`);
      return;
    }
    const cursor = request.cursor === null ? null : decodeHistoryCursor(request.cursor, provider, instrument, request);
    if (request.cursor !== null && cursor === null) {
      log(`${label}: dropped aggressive_history request: cursor does not match the selected history window`);
      return;
    }
    latestByClient.set(client, request);
    dropQueued(client);
    const retryAfterMs = reserveRateBudget(client, now());
    if (retryAfterMs !== null) {
      reject(client, instrument, request, "rate budget", retryAfterMs);
      return;
    }
    if (readingClients.has(client) || reading >= maxConcurrentReads) {
      if (queue.length >= maxQueued) {
        reject(client, instrument, request, "queue full");
        return;
      }
      queue.push({ client, instrument, request, cursor, queuedAt: now() });
      counters.queued += 1;
      return;
    }
    attachOrLaunch(client, instrument, request, cursor);
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
  createAggressiveHistoryHandler,
  parseAggressiveHistoryRequest,
  rowsToTradeFrames,
  MAX_AGGRESSIVE_HISTORY_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  DEFAULT_RATE_LIMIT,
};
