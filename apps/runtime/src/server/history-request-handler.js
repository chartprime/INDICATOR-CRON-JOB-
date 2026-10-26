"use strict";

const { wallHistoryFrame, eventHistoryFrame, parseWallHistoryRequest, parseEventHistoryRequest, MAX_HISTORY_WALLS, MAX_HISTORY_EVENTS } = require("./history-frames");
const { bandRowsFor } = require("./band-history");

const DEFAULT_RATE_LIMIT = Object.freeze({ max: 30, windowMs: 60_000 });

function createHistoryRequestHandler({
  provider,
  geometryFor,
  wallHistoryOf,
  eventHistoryOf,
  safelySend,
  now = () => Date.now(),
  log = console.error,
  label = "history",
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  if (provider !== "BINANCE" && provider !== "DXFEED") throw new Error("history-request-handler: provider must be BINANCE or DXFEED");
  for (const [name, value] of [["geometryFor", geometryFor], ["wallHistoryOf", wallHistoryOf], ["eventHistoryOf", eventHistoryOf], ["safelySend", safelySend]]) {
    if (typeof value !== "function") throw new Error(`history-request-handler: ${name} must be a function`);
  }
  for (const [name, value] of [["rateLimit.max", rateLimit?.max], ["rateLimit.windowMs", rateLimit?.windowMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`history-request-handler: ${name} must be a positive safe integer`);
  }
  const requestTimes = new Map();
  const rejectionLoggedAt = new Map();
  const counters = { answered: 0, rejected: 0, refused: 0, dropped: 0, walls: 0, trades: 0, wallTrades: 0 };
  let disposed = false;

  function identityOf(instrument) {
    return provider === "BINANCE"
      ? { provider, symbol: instrument.symbol, marketKind: instrument.marketKind }
      : { provider, symbol: instrument.symbol, assetClass: instrument.assetClass };
  }

  function kindOf(instrument) {
    return provider === "BINANCE" ? instrument.marketKind : instrument.assetClass;
  }

  function build(kind, identity, body) {
    return kind === "wall_history" ? wallHistoryFrame(identity, body) : eventHistoryFrame(identity, body);
  }

  function send(client, kind, instrument, body) {
    let frame;
    try {
      frame = build(kind, identityOf(instrument), body);
    } catch (error) {
      log(`${label}: failed to build the ${kind} frame`, error?.message ?? error);
      return false;
    }
    safelySend(client, frame);
    return true;
  }

  function refuse(client, kind, instrument, raw, reason) {
    const request = { requestId: raw.request_id, fromTs: raw.from_ts, toTs: raw.to_ts, priceLo: raw.price_lo, priceHi: raw.price_hi };
    if (!send(client, kind, instrument, { request, rowWidth: null, complete: false, reason })) return false;
    counters.refused += 1;
    return true;
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

  function echoOf(request) {
    return { requestId: request.requestId, fromTs: request.fromMs, toTs: request.toMs, priceLo: request.priceLo, priceHi: request.priceHi };
  }

  function answerWalls(client, instrument, request, geometry, rows) {
    const history = wallHistoryOf(kindOf(instrument), instrument.symbol);
    if (!history) {
      send(client, "wall_history", instrument, { request: echoOf(request), rowWidth: null, complete: false, reason: "HISTORY_UNAVAILABLE" });
      return;
    }
    const page = history.query({ fromTs: request.fromMs, toTs: request.toMs, rowLo: rows.rowLo, rowHi: rows.rowHi, limit: MAX_HISTORY_WALLS, cursor: request.cursor });
    counters.walls += page.walls.length;
    counters.answered += 1;
    send(client, "wall_history", instrument, { request: echoOf(request), rowWidth: geometry.rowWidth, complete: true, walls: page.walls, next: page.next });
  }

  function answerEvents(client, instrument, request, geometry, rows) {
    const history = eventHistoryOf(kindOf(instrument), instrument.symbol);
    if (!history) {
      send(client, "l2_event_history", instrument, { request: echoOf(request), rowWidth: null, complete: false, reason: "HISTORY_UNAVAILABLE" });
      return;
    }
    const cursor = request.cursor ?? { trades: null, wallTrades: null };
    const trades = history.queryTrades({ fromTs: request.fromMs, toTs: request.toMs, rowLo: rows.rowLo, rowHi: rows.rowHi, limit: MAX_HISTORY_EVENTS, cursor: cursor.trades });
    const wallTrades = history.queryWallTrades({ fromTs: request.fromMs, toTs: request.toMs, limit: MAX_HISTORY_EVENTS, cursor: cursor.wallTrades });
    counters.trades += trades.records.length;
    counters.wallTrades += wallTrades.records.length;
    counters.answered += 1;
    send(client, "l2_event_history", instrument, {
      request: echoOf(request),
      rowWidth: geometry.rowWidth,
      complete: true,
      trades: trades.records.map((record) => [record.ts, record.columnMs, record.row, record.aggressor, record.mode, record.size, record.count]),
      wallTrades: wallTrades.records.map((record) => [record.ts, record.wall, record.mode, record.size, record.count]),
      tradesHeldFrom: history.heldFrom(request.fromMs, request.toMs),
      next: trades.next === null && wallTrades.next === null ? null : {
        trades: trades.next === null ? null : { ts: trades.next.ts, row: trades.next.row, aggressor: trades.next.aggressor, mode: trades.next.mode },
        wallTrades: wallTrades.next === null ? null : { ts: wallTrades.next.ts, wall: wallTrades.next.wall, mode: wallTrades.next.mode },
      },
    });
  }

  function handle(parsed, client, instrument) {
    if (disposed || !instrument || !parsed || typeof parsed !== "object") return;
    const kind = parsed.type;
    if (kind !== "wall_history" && kind !== "l2_event_history") return;
    const request = kind === "wall_history" ? parseWallHistoryRequest(parsed, now()) : parseEventHistoryRequest(parsed, now());
    if (typeof request === "string") {
      if (refuse(client, kind, instrument, parsed, "BAD_REQUEST")) return;
      counters.dropped += 1;
      log(`${label}: dropped ${kind} request: ${request}`);
      return;
    }
    const geometry = geometryFor(instrument) ?? null;
    if (geometry === null) {
      send(client, kind, instrument, { request: echoOf(request), rowWidth: null, complete: false, reason: "GEOMETRY_UNAVAILABLE" });
      return;
    }
    const at = now();
    const retryAfterMs = reserveRateBudget(client, at);
    if (retryAfterMs !== null) {
      counters.rejected += 1;
      if ((rejectionLoggedAt.get(client) ?? -Infinity) + rateLimit.windowMs <= at) {
        rejectionLoggedAt.set(client, at);
        log(`${label}: ${kind} request refused (rate budget)`);
      }
      send(client, kind, instrument, { request: echoOf(request), rowWidth: geometry.rowWidth, complete: false, reason: "OVERLOADED", retryAfterMs });
      return;
    }
    const rows = bandRowsFor({ priceLo: request.priceLo, priceHi: request.priceHi, ...geometry });
    if (kind === "wall_history") answerWalls(client, instrument, request, geometry, rows);
    else answerEvents(client, instrument, request, geometry, rows);
  }

  function forget(client) {
    requestTimes.delete(client);
    rejectionLoggedAt.delete(client);
  }

  function dispose() {
    disposed = true;
    requestTimes.clear();
    rejectionLoggedAt.clear();
  }

  function stats() {
    return Object.freeze({ ...counters });
  }

  return Object.freeze({ handle, forget, dispose, stats });
}

module.exports = { createHistoryRequestHandler, DEFAULT_RATE_LIMIT };
