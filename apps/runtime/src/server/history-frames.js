"use strict";

const { selectionFrame, dxfeedSelectionFrame } = require("./frames");
const { MAX_VALID_EPOCH_MS, decimalToFiniteNumber } = require("./wire-fields");

const MAX_HISTORY_WALLS = 400;
const MAX_HISTORY_EVENTS = 2_000;
const MAX_HISTORY_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;
const MAX_HISTORY_WALL_KEY_LENGTH = 80;
const HISTORY_REASONS = Object.freeze(["BAD_REQUEST", "OVERLOADED", "GEOMETRY_UNAVAILABLE", "HISTORY_UNAVAILABLE"]);
const HISTORY_ROWLESS_REASONS = new Set(["BAD_REQUEST", "GEOMETRY_UNAVAILABLE", "HISTORY_UNAVAILABLE"]);
const WALL_VERDICTS = Object.freeze(["filled", "partial", "hit", "pulled", "moved"]);
const AGGRESSORS = Object.freeze(["buy", "sell"]);
const MODES = Object.freeze(["absorbed", "swept"]);
const FUTURE_SKEW_MS = 60_000;
const WALL_REQUEST_KEYS = Object.freeze(["from_ts", "price_hi", "price_lo", "request_id", "to_ts", "type"]);
const WALL_REQUEST_KEYS_WITH_CURSOR = Object.freeze(["cursor", ...WALL_REQUEST_KEYS]);
const EVENT_REQUEST_KEYS = WALL_REQUEST_KEYS;
const EVENT_REQUEST_KEYS_WITH_CURSOR = WALL_REQUEST_KEYS_WITH_CURSOR;

function identityFields(identity, field) {
  if (identity?.provider === "BINANCE") return selectionFrame(identity.symbol, identity.marketKind);
  if (identity?.provider === "DXFEED") return dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  throw new Error(`${field}: invalid provider`);
}

function hasExactKeys(value, keys) {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function epochMs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALID_EPOCH_MS) throw new Error(`${field}: must be a non-negative epoch-ms integer`);
  return value;
}

function nullableEpochMs(value, field) {
  return value === null || value === undefined ? null : epochMs(value, field);
}

function counter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}: must be a non-negative integer`);
  return value;
}

function share(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field}: must be a number from 0 to 1`);
  return value;
}

function amount(value, field) {
  return decimalToFiniteNumber(value, field, { allowZero: true });
}

function flag(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field}: must be a boolean`);
  return value;
}

function nullableFlag(value, field) {
  return value === null || value === undefined ? null : flag(value, field);
}

function wallKey(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HISTORY_WALL_KEY_LENGTH) throw new Error(`${field}: must be a short non-empty string`);
  return value;
}

function requestEcho(request, field) {
  const requestId = counter(request.requestId, `${field}.requestId`);
  const fromTs = epochMs(request.fromTs, `${field}.fromTs`);
  const toTs = epochMs(request.toTs, `${field}.toTs`);
  if (toTs < fromTs) throw new Error(`${field}.toTs: must be at or after fromTs`);
  if (typeof request.priceLo !== "number" || !Number.isFinite(request.priceLo) || request.priceLo <= 0) throw new Error(`${field}.priceLo: must be a positive finite number`);
  if (typeof request.priceHi !== "number" || !Number.isFinite(request.priceHi) || request.priceHi < request.priceLo) throw new Error(`${field}.priceHi: must be a finite number at or above priceLo`);
  return { request_id: requestId, from_ts: fromTs, to_ts: toTs, price_lo: request.priceLo, price_hi: request.priceHi };
}

function outcome({ complete, reason = null, retryAfterMs = null, rowWidth }, field) {
  flag(complete, `${field}.complete`);
  if (complete ? reason !== null : !HISTORY_REASONS.includes(reason)) throw new Error(`${field}.reason: must be null when complete, else one of ${HISTORY_REASONS.join(", ")}`);
  if (reason === "OVERLOADED") {
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 24 * 60 * 60 * 1_000)) throw new Error(`${field}.retryAfterMs: must be a positive safe integer no greater than one day or null`);
  } else if (retryAfterMs !== null) {
    throw new Error(`${field}.retryAfterMs: is only valid when OVERLOADED`);
  }
  const geometryKnown = !HISTORY_ROWLESS_REASONS.has(reason);
  if (geometryKnown) {
    if (typeof rowWidth !== "number" || !Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error(`${field}.rowWidth: must be a positive finite number`);
  } else if (rowWidth !== null) {
    throw new Error(`${field}.rowWidth: must be null when the geometry is unavailable`);
  }
  return { row_width: geometryKnown ? rowWidth : null, complete, reason, retry_after_ms: retryAfterMs };
}

function historyDetail(detail, field) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object") throw new Error(`${field}: must be an object or null`);
  const repeats = detail.repeats;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error(`${field}.repeats: must be a positive integer`);
  return Object.freeze({
    traded: amount(detail.traded, `${field}.traded`),
    absorbed: amount(detail.absorbed, `${field}.absorbed`),
    swept: amount(detail.swept, `${field}.swept`),
    hidden: amount(detail.hidden, `${field}.hidden`),
    cleared: amount(detail.cleared, `${field}.cleared`),
    cross_side: amount(detail.crossSide, `${field}.crossSide`),
    fill_ratio: share(detail.fillRatio, `${field}.fillRatio`),
    first_shrink_ts: nullableEpochMs(detail.firstShrinkTs, `${field}.firstShrinkTs`),
    reached_at_first_shrink: nullableFlag(detail.reachedAtFirstShrink, `${field}.reachedAtFirstShrink`),
    end_distance_rows: detail.endDistanceRows === null || detail.endDistanceRows === undefined ? null : amount(detail.endDistanceRows, `${field}.endDistanceRows`),
    cleared_by_trades: flag(detail.clearedByTrades, `${field}.clearedByTrades`),
    repeats,
    evidence_gap: flag(detail.evidenceGap, `${field}.evidenceGap`),
  });
}

function historyWall(wall, field) {
  if (!wall || typeof wall !== "object") throw new Error(`${field}: must be a wall`);
  const hid = counter(wall.hid, `${field}.hid`);
  if (hid < 1) throw new Error(`${field}.hid: must be a positive integer`);
  if (wall.side !== "bid" && wall.side !== "ask") throw new Error(`${field}.side: must be bid or ask`);
  if (!Number.isSafeInteger(wall.row) || wall.row < 0) throw new Error(`${field}.row: must be a non-negative integer`);
  if (!Number.isSafeInteger(wall.span) || wall.span < 1) throw new Error(`${field}.span: must be a positive integer`);
  const startTs = epochMs(wall.startTs, `${field}.startTs`);
  const endTs = epochMs(wall.endTs, `${field}.endTs`);
  if (endTs < startTs) throw new Error(`${field}.endTs: must be at or after startTs`);
  if (!WALL_VERDICTS.includes(wall.endedBy)) throw new Error(`${field}.endedBy: must be one of ${WALL_VERDICTS.join(", ")}`);
  const size = amount(wall.size, `${field}.size`);
  const peak = amount(wall.peak, `${field}.peak`);
  if (peak < size) throw new Error(`${field}.peak: must be no smaller than size`);
  return Object.freeze({
    hid,
    side: wall.side,
    row: wall.row,
    span: wall.span,
    start_ts: startTs,
    end_ts: endTs,
    size,
    peak,
    ended_by: wall.endedBy,
    ratio: amount(wall.ratio ?? 0, `${field}.ratio`),
    chain: counter(wall.chain ?? 0, `${field}.chain`),
    fill: share(wall.fill ?? 0, `${field}.fill`),
    eaten: share(wall.eaten ?? 0, `${field}.eaten`),
    detail: historyDetail(wall.detail, `${field}.detail`),
  });
}

function wallCursor(cursor, field) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "object") throw new Error(`${field}: must be a cursor or null`);
  const hid = counter(cursor.hid, `${field}.hid`);
  if (hid < 1) throw new Error(`${field}.hid: must be a positive integer`);
  return Object.freeze({ end_ts: epochMs(cursor.endTs, `${field}.endTs`), hid });
}

function wallHistoryFrame(identity, { request, rowWidth = null, complete, reason = null, retryAfterMs = null, walls = [], next = null }) {
  const wire = identityFields(identity, "wallHistoryFrame");
  const echo = requestEcho(request, "wallHistoryFrame.request");
  const result = outcome({ complete, reason, retryAfterMs, rowWidth }, "wallHistoryFrame");
  if (!Array.isArray(walls) || walls.length > MAX_HISTORY_WALLS) throw new Error(`wallHistoryFrame.walls: must be an array of at most ${MAX_HISTORY_WALLS} walls`);
  if (!complete && walls.length > 0) throw new Error("wallHistoryFrame: an incomplete reply carries no walls");
  const seen = new Set();
  let previous = null;
  const wireWalls = walls.map((wall, index) => {
    const checked = historyWall(wall, `wallHistoryFrame.walls[${index}]`);
    if (seen.has(checked.hid)) throw new Error(`wallHistoryFrame.walls[${index}].hid: ids must be unique`);
    seen.add(checked.hid);
    if (previous !== null && (checked.end_ts < previous.end_ts || (checked.end_ts === previous.end_ts && checked.hid <= previous.hid))) throw new Error(`wallHistoryFrame.walls[${index}]: walls must be in order of ending`);
    previous = checked;
    return checked;
  });
  const cursor = wallCursor(next, "wallHistoryFrame.next");
  if (cursor !== null && !complete) throw new Error("wallHistoryFrame.next: an incomplete reply has no next page");
  return Object.freeze({ ...wire, type: "wall_history", ...echo, ...result, walls: Object.freeze(wireWalls), next: cursor });
}

function tradeRow(entry, field) {
  if (!Array.isArray(entry) || entry.length !== 7) throw new Error(`${field}: must be [ts, column_ms, row, aggressor, mode, size, count]`);
  const [ts, columnMs, row, aggressor, mode, size, count] = entry;
  epochMs(ts, `${field}[0]`);
  if (!Number.isSafeInteger(columnMs) || columnMs <= 0) throw new Error(`${field}[1]: must be a positive integer`);
  if (!Number.isSafeInteger(row) || row < 0) throw new Error(`${field}[2]: must be a non-negative integer`);
  if (!AGGRESSORS.includes(aggressor)) throw new Error(`${field}[3]: must be buy or sell`);
  if (!MODES.includes(mode)) throw new Error(`${field}[4]: must be absorbed or swept`);
  const checkedSize = amount(size, `${field}[5]`);
  if (checkedSize <= 0) throw new Error(`${field}[5]: must be positive`);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${field}[6]: must be a positive integer`);
  return Object.freeze([ts, columnMs, row, aggressor, mode, checkedSize, count]);
}

function wallTradeRow(entry, field) {
  if (!Array.isArray(entry) || entry.length !== 5) throw new Error(`${field}: must be [ts, wall, mode, size, count]`);
  const [ts, wall, mode, size, count] = entry;
  epochMs(ts, `${field}[0]`);
  wallKey(wall, `${field}[1]`);
  if (!MODES.includes(mode)) throw new Error(`${field}[2]: must be absorbed or swept`);
  const checkedSize = amount(size, `${field}[3]`);
  if (checkedSize <= 0) throw new Error(`${field}[3]: must be positive`);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${field}[4]: must be a positive integer`);
  return Object.freeze([ts, wall, mode, checkedSize, count]);
}

function tradeCursor(cursor, field) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "object") throw new Error(`${field}: must be a cursor or null`);
  if (!Number.isSafeInteger(cursor.row) || cursor.row < 0) throw new Error(`${field}.row: must be a non-negative integer`);
  if (!AGGRESSORS.includes(cursor.aggressor)) throw new Error(`${field}.aggressor: must be buy or sell`);
  if (!MODES.includes(cursor.mode)) throw new Error(`${field}.mode: must be absorbed or swept`);
  return Object.freeze({ ts: epochMs(cursor.ts, `${field}.ts`), row: cursor.row, aggressor: cursor.aggressor, mode: cursor.mode });
}

function wallTradeCursor(cursor, field) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "object") throw new Error(`${field}: must be a cursor or null`);
  if (!MODES.includes(cursor.mode)) throw new Error(`${field}.mode: must be absorbed or swept`);
  return Object.freeze({ ts: epochMs(cursor.ts, `${field}.ts`), wall: wallKey(cursor.wall, `${field}.wall`), mode: cursor.mode });
}

function heldFrom(value, complete, echo, field) {
  if (!complete) {
    if (value !== null) throw new Error(`${field}: an incomplete reply holds nothing`);
    return null;
  }
  const ts = epochMs(value, field);
  if (ts < echo.from_ts || ts > echo.to_ts) throw new Error(`${field}: must lie inside the asked range`);
  return ts;
}

function eventHistoryFrame(identity, { request, rowWidth = null, complete, reason = null, retryAfterMs = null, trades = [], wallTrades = [], tradesHeldFrom = null, next = null }) {
  const wire = identityFields(identity, "eventHistoryFrame");
  const echo = requestEcho(request, "eventHistoryFrame.request");
  const result = outcome({ complete, reason, retryAfterMs, rowWidth }, "eventHistoryFrame");
  const held = heldFrom(tradesHeldFrom, complete, echo, "eventHistoryFrame.tradesHeldFrom");
  if (!Array.isArray(trades) || trades.length > MAX_HISTORY_EVENTS) throw new Error(`eventHistoryFrame.trades: must be an array of at most ${MAX_HISTORY_EVENTS} rows`);
  if (!Array.isArray(wallTrades) || wallTrades.length > MAX_HISTORY_EVENTS) throw new Error(`eventHistoryFrame.wallTrades: must be an array of at most ${MAX_HISTORY_EVENTS} rows`);
  if (!complete && (trades.length > 0 || wallTrades.length > 0)) throw new Error("eventHistoryFrame: an incomplete reply carries no rows");
  const wireTrades = trades.map((entry, index) => tradeRow(entry, `eventHistoryFrame.trades[${index}]`));
  for (let index = 1; index < wireTrades.length; index += 1) {
    if (wireTrades[index][0] < wireTrades[index - 1][0]) throw new Error(`eventHistoryFrame.trades[${index}]: rows must be in time order`);
  }
  const wireWallTrades = wallTrades.map((entry, index) => wallTradeRow(entry, `eventHistoryFrame.wallTrades[${index}]`));
  for (let index = 1; index < wireWallTrades.length; index += 1) {
    if (wireWallTrades[index][0] < wireWallTrades[index - 1][0]) throw new Error(`eventHistoryFrame.wallTrades[${index}]: rows must be in time order`);
  }
  const cursors = next === null || next === undefined ? null : Object.freeze({
    trades: tradeCursor(next.trades, "eventHistoryFrame.next.trades"),
    wall_trades: wallTradeCursor(next.wallTrades, "eventHistoryFrame.next.wallTrades"),
  });
  if (cursors !== null && !complete) throw new Error("eventHistoryFrame.next: an incomplete reply has no next page");
  return Object.freeze({ ...wire, type: "l2_event_history", ...echo, ...result, trades: Object.freeze(wireTrades), wall_trades: Object.freeze(wireWallTrades), trades_held_from: held, next: cursors });
}

function parseRequestBase(parsed, nowMs, keys, keysWithCursor) {
  if (!parsed || typeof parsed !== "object") return "not an object";
  const withCursor = Object.hasOwn(parsed, "cursor");
  if (!hasExactKeys(parsed, withCursor ? keysWithCursor : keys)) return "unexpected fields";
  const { request_id: requestId, from_ts: fromMs, to_ts: toMs, price_lo: priceLo, price_hi: priceHi } = parsed;
  if (!Number.isSafeInteger(requestId) || requestId < 0) return "request_id must be a non-negative safe integer";
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) return "from_ts must be a non-negative safe integer";
  if (!Number.isSafeInteger(toMs) || toMs < fromMs) return "to_ts must be a safe integer at or after from_ts";
  if (toMs > nowMs + FUTURE_SKEW_MS) return "to_ts is in the future";
  if (toMs - fromMs > MAX_HISTORY_WINDOW_MS) return "window is longer than eight days";
  if (typeof priceLo !== "number" || !Number.isFinite(priceLo) || priceLo <= 0) return "price_lo must be a positive finite number";
  if (typeof priceHi !== "number" || !Number.isFinite(priceHi) || priceHi < priceLo) return "price_hi must be a finite number at or above price_lo";
  return { requestId, fromMs, toMs, priceLo, priceHi, cursor: withCursor ? parsed.cursor : null };
}

function parseWallHistoryRequest(parsed, nowMs) {
  if (!parsed || typeof parsed !== "object" || parsed.type !== "wall_history") return "not a wall_history request";
  const base = parseRequestBase(parsed, nowMs, WALL_REQUEST_KEYS, WALL_REQUEST_KEYS_WITH_CURSOR);
  if (typeof base === "string") return base;
  if (base.cursor !== null) {
    const cursor = base.cursor;
    if (!cursor || typeof cursor !== "object" || !hasExactKeys(cursor, ["end_ts", "hid"]) || !Number.isSafeInteger(cursor.end_ts) || cursor.end_ts < 0 || !Number.isSafeInteger(cursor.hid) || cursor.hid < 1) return "cursor must be { end_ts, hid }";
    base.cursor = { endTs: cursor.end_ts, hid: cursor.hid };
  }
  return base;
}

function parseEventHistoryRequest(parsed, nowMs) {
  if (!parsed || typeof parsed !== "object" || parsed.type !== "l2_event_history") return "not an l2_event_history request";
  const base = parseRequestBase(parsed, nowMs, EVENT_REQUEST_KEYS, EVENT_REQUEST_KEYS_WITH_CURSOR);
  if (typeof base === "string") return base;
  if (base.cursor !== null) {
    const cursor = base.cursor;
    if (!cursor || typeof cursor !== "object" || !hasExactKeys(cursor, ["trades", "wall_trades"])) return "cursor must be { trades, wall_trades }";
    const trades = cursor.trades;
    if (trades !== null && (!trades || typeof trades !== "object" || !hasExactKeys(trades, ["aggressor", "mode", "row", "ts"]) || !Number.isSafeInteger(trades.ts) || trades.ts < 0 || !Number.isSafeInteger(trades.row) || trades.row < 0 || !AGGRESSORS.includes(trades.aggressor) || !MODES.includes(trades.mode))) return "cursor.trades must be { ts, row, aggressor, mode } or null";
    const wallTrades = cursor.wall_trades;
    if (wallTrades !== null && (!wallTrades || typeof wallTrades !== "object" || !hasExactKeys(wallTrades, ["mode", "ts", "wall"]) || !Number.isSafeInteger(wallTrades.ts) || wallTrades.ts < 0 || typeof wallTrades.wall !== "string" || wallTrades.wall.length === 0 || wallTrades.wall.length > MAX_HISTORY_WALL_KEY_LENGTH || !MODES.includes(wallTrades.mode))) return "cursor.wall_trades must be { ts, wall, mode } or null";
    base.cursor = { trades: trades === null ? null : { ts: trades.ts, row: trades.row, aggressor: trades.aggressor, mode: trades.mode }, wallTrades: wallTrades === null ? null : { ts: wallTrades.ts, wall: wallTrades.wall, mode: wallTrades.mode } };
  }
  return base;
}

module.exports = {
  wallHistoryFrame,
  eventHistoryFrame,
  parseWallHistoryRequest,
  parseEventHistoryRequest,
  HISTORY_REASONS,
  MAX_HISTORY_WALLS,
  MAX_HISTORY_EVENTS,
  MAX_HISTORY_WINDOW_MS,
};
