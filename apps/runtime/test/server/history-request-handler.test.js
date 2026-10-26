"use strict";

const { createHistoryRequestHandler } = require("../../src/server/history-request-handler");
const { wallHistoryFrame, eventHistoryFrame, parseWallHistoryRequest, parseEventHistoryRequest, MAX_HISTORY_WALLS, MAX_HISTORY_EVENTS } = require("../../src/server/history-frames");
const { createWallHistory } = require("../../src/indicators/l2-memory/history/wall-history");
const { createEventHistory } = require("../../src/indicators/l2-memory/history/event-history");

const T = 1_780_000_000_000;
const GEOMETRY = { rowWidth: 2, rowClusters: 4, tickSize: 0.1, clusterTicks: 5 };
const BINANCE = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const IDENTITY = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const REQUEST = { requestId: 7, fromTs: T - 3_600_000, toTs: T, priceLo: 79_000, priceHi: 81_000 };

function ended(over = {}) {
  return { side: "bid", row: 40_000, span: 1, startTs: T - 60_000, endTs: T - 30_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0, fill: 0.1, eaten: 0.2, detail: { traded: 6, absorbed: 6, swept: 0, hidden: 0, cleared: 30, crossSide: 1, fillRatio: 0.2, firstShrinkTs: null, reachedAtFirstShrink: null, endDistanceRows: 2, clearedByTrades: false, repeats: 1, evidenceGap: true }, ...over };
}

function harness({ walls = null, events = null, geometry = GEOMETRY, rateLimit } = {}) {
  const sent = [];
  const lines = [];
  let at = T;
  const handler = createHistoryRequestHandler({
    provider: "BINANCE",
    geometryFor: () => geometry,
    wallHistoryOf: () => walls,
    eventHistoryOf: () => events,
    safelySend: (client, frame) => sent.push([client, frame]),
    now: () => at,
    log: (...args) => lines.push(args.join(" ")),
    label: "test",
    ...(rateLimit ? { rateLimit } : {}),
  });
  return { handler, sent, lines, advance: (ms) => { at += ms; } };
}

describe("history frames (P4e2 step 6)", () => {
  test("a wall_history frame echoes the request, orders its walls by ending and refuses what it cannot carry", () => {
    const walls = [{ hid: 1, ...ended({ endTs: T - 40_000 }) }, { hid: 2, ...ended({ side: "ask", endTs: T - 30_000 }) }];
    const frame = wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls, next: { endTs: T - 30_000, hid: 2 } });
    expect(frame).toMatchObject({ type: "wall_history", symbol: "BTC-USDT", marketKind: "PERPETUAL", request_id: 7, from_ts: T - 3_600_000, to_ts: T, price_lo: 79_000, price_hi: 81_000, row_width: 2, complete: true, reason: null, retry_after_ms: null, next: { end_ts: T - 30_000, hid: 2 } });
    expect(frame.walls[0]).toEqual({ hid: 1, side: "bid", row: 40_000, span: 1, start_ts: T - 60_000, end_ts: T - 40_000, size: 0, peak: 30, ended_by: "pulled", ratio: 3, chain: 0, fill: 0.1, eaten: 0.2, detail: { traded: 6, absorbed: 6, swept: 0, hidden: 0, cleared: 30, cross_side: 1, fill_ratio: 0.2, first_shrink_ts: null, reached_at_first_shrink: null, end_distance_rows: 2, cleared_by_trades: false, repeats: 1, evidence_gap: true } });
    expect(Object.isFrozen(frame.walls)).toBe(true);
    expect(wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: null, complete: false, reason: "HISTORY_UNAVAILABLE" })).toMatchObject({ complete: false, reason: "HISTORY_UNAVAILABLE", row_width: null, walls: [], next: null });
    expect(wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "OVERLOADED", retryAfterMs: 500 })).toMatchObject({ reason: "OVERLOADED", retry_after_ms: 500 });
    expect(() => wallHistoryFrame({ provider: "X" }, { request: REQUEST, rowWidth: 2, complete: true })).toThrow(/provider/);
    expect(() => wallHistoryFrame(IDENTITY, { request: { ...REQUEST, toTs: REQUEST.fromTs - 1 }, rowWidth: 2, complete: true })).toThrow(/toTs/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, reason: "OVERLOADED" })).toThrow(/reason/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "nope" })).toThrow(/reason/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "HISTORY_UNAVAILABLE", retryAfterMs: 5 })).toThrow(/retryAfterMs/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "HISTORY_UNAVAILABLE" })).toThrow(/rowWidth/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: null, complete: true })).toThrow(/rowWidth/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "OVERLOADED", walls })).toThrow(/incomplete/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls: [walls[1], walls[0]] })).toThrow(/order of ending/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls: [walls[0], walls[0]] })).toThrow(/unique/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls: [{ hid: 1, ...ended({ endedBy: "gone" }) }] })).toThrow(/endedBy/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls: [{ hid: 1, ...ended({ detail: { repeats: 0 } }) }] })).toThrow(/repeats/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, walls: Array.from({ length: MAX_HISTORY_WALLS + 1 }, (_, i) => ({ hid: i + 1, ...ended({ endTs: T - 100_000 + i }) })) })).toThrow(/at most/);
    expect(() => wallHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, next: { endTs: T, hid: 0 } })).toThrow(/hid/);
  });

  test("an l2_event_history frame carries both series as compact rows in time order, with a cursor per series", () => {
    const trades = [[T - 20_000, 10_000, 40_000, "buy", "absorbed", 2, 1], [T - 1_000, 1_000, 40_001, "sell", "swept", 1, 1]];
    const wallTrades = [[T - 20_000, "bid:40000:1:" + String(T - 60_000), "absorbed", 2, 1]];
    const frame = eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, trades, wallTrades, next: { trades: { ts: T - 1_000, row: 40_001, aggressor: "sell", mode: "swept" }, wallTrades: null } });
    expect(frame).toMatchObject({ type: "l2_event_history", request_id: 7, row_width: 2, complete: true, reason: null, next: { trades: { ts: T - 1_000, row: 40_001, aggressor: "sell", mode: "swept" }, wall_trades: null } });
    expect(frame.trades).toEqual(trades);
    expect(frame.wall_trades).toEqual(wallTrades);
    expect(eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: null, complete: false, reason: "GEOMETRY_UNAVAILABLE" })).toMatchObject({ trades: [], wall_trades: [], next: null });
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, trades: [[T, 1_000, 1, "x", "absorbed", 1, 1]] })).toThrow(/buy or sell/);
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, trades: [trades[1], trades[0]] })).toThrow(/time order/);
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, wallTrades: [[T, "", "absorbed", 1, 1]] })).toThrow(/non-empty/);
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, trades: Array.from({ length: MAX_HISTORY_EVENTS + 1 }, () => trades[0]) })).toThrow(/at most/);
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "OVERLOADED", trades })).toThrow(/incomplete/);
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: true, tradesHeldFrom: REQUEST.fromTs, next: { trades: { ts: T, row: 1, aggressor: "buy", mode: "x" }, wallTrades: null } })).toThrow(/mode/);
  });

  test("an l2_event_history frame says from where the runtime holds the asked trades: required on a complete reply, inside the asked range, and null on a refusal (PR #39 review)", () => {
    const complete = { request: REQUEST, rowWidth: 2, complete: true };
    expect(eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: T - 60_000 })).toMatchObject({ complete: true, trades_held_from: T - 60_000 });
    expect(eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: REQUEST.fromTs }).trades_held_from).toBe(REQUEST.fromTs);
    expect(eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: REQUEST.toTs }).trades_held_from).toBe(REQUEST.toTs);
    expect(() => eventHistoryFrame(IDENTITY, complete)).toThrow(/tradesHeldFrom/);
    expect(() => eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: REQUEST.fromTs - 1 })).toThrow(/inside the asked range/);
    expect(() => eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: REQUEST.toTs + 1 })).toThrow(/inside the asked range/);
    expect(() => eventHistoryFrame(IDENTITY, { ...complete, tradesHeldFrom: 1.5 })).toThrow(/tradesHeldFrom/);
    expect(eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "OVERLOADED", retryAfterMs: 500 }).trades_held_from).toBeNull();
    expect(() => eventHistoryFrame(IDENTITY, { request: REQUEST, rowWidth: 2, complete: false, reason: "OVERLOADED", tradesHeldFrom: T })).toThrow(/holds nothing/);
  });

  test("the request parsers take exactly the documented keys, an optional cursor, and no window past eight days or into the future", () => {
    const base = { type: "wall_history", request_id: 1, from_ts: T - 1_000, to_ts: T, price_lo: 79_000, price_hi: 81_000 };
    expect(parseWallHistoryRequest(base, T)).toEqual({ requestId: 1, fromMs: T - 1_000, toMs: T, priceLo: 79_000, priceHi: 81_000, cursor: null });
    expect(parseWallHistoryRequest({ ...base, cursor: { end_ts: T - 500, hid: 3 } }, T)).toMatchObject({ cursor: { endTs: T - 500, hid: 3 } });
    expect(parseWallHistoryRequest({ ...base, cursor: { end_ts: T - 500 } }, T)).toMatch(/cursor/);
    expect(parseWallHistoryRequest({ ...base, extra: 1 }, T)).toMatch(/unexpected/);
    expect(parseWallHistoryRequest({ ...base, to_ts: T + 120_000 }, T)).toMatch(/future/);
    expect(parseWallHistoryRequest({ ...base, from_ts: T - 9 * 86_400_000 }, T)).toMatch(/eight days/);
    expect(parseWallHistoryRequest({ ...base, price_hi: 1 }, T)).toMatch(/price_hi/);
    expect(parseWallHistoryRequest({ ...base, type: "l2_event_history" }, T)).toMatch(/not a wall_history/);
    const events = { ...base, type: "l2_event_history" };
    expect(parseEventHistoryRequest(events, T)).toMatchObject({ requestId: 1, cursor: null });
    expect(parseEventHistoryRequest({ ...events, cursor: { trades: { ts: T, row: 1, aggressor: "buy", mode: "swept" }, wall_trades: null } }, T)).toMatchObject({ cursor: { trades: { ts: T, row: 1, aggressor: "buy", mode: "swept" }, wallTrades: null } });
    expect(parseEventHistoryRequest({ ...events, cursor: { trades: null, wall_trades: { ts: T, wall: "k", mode: "absorbed" } } }, T)).toMatchObject({ cursor: { trades: null, wallTrades: { ts: T, wall: "k", mode: "absorbed" } } });
    expect(parseEventHistoryRequest({ ...events, cursor: { trades: { ts: T }, wall_trades: null } }, T)).toMatch(/cursor.trades/);
    expect(parseEventHistoryRequest({ ...events, cursor: { trades: null } }, T)).toMatch(/cursor must/);
    expect(parseEventHistoryRequest(base, T)).toMatch(/not an l2_event_history/);
  });
});

describe("history request handler (P4e2 step 6): the two requests answered from a pair's histories", () => {
  test("validates its wiring", () => {
    expect(() => createHistoryRequestHandler({ provider: "X", geometryFor: () => {}, wallHistoryOf: () => {}, eventHistoryOf: () => {}, safelySend: () => {} })).toThrow(/provider/);
    expect(() => createHistoryRequestHandler({ provider: "BINANCE", geometryFor: () => {}, wallHistoryOf: () => {}, safelySend: () => {} })).toThrow(/eventHistoryOf/);
    expect(() => createHistoryRequestHandler({ provider: "BINANCE", geometryFor: () => {}, wallHistoryOf: () => {}, eventHistoryOf: () => {}, safelySend: () => {}, rateLimit: { max: 0, windowMs: 1 } })).toThrow(/rateLimit/);
  });

  test("answers a wall_history request with the walls whose life overlaps the window inside the price range, by page, with the pair's row width", () => {
    const walls = createWallHistory({ maxAgeMs: 86_400_000 });
    walls.record([ended({ row: 39_500, endTs: T - 50_000 }), ended({ row: 40_000, endTs: T - 40_000 }), ended({ row: 40_010, startTs: T - 20_000, endTs: T - 10_000 }), ended({ row: 44_000, endTs: T - 5_000 })]);
    const { handler, sent } = harness({ walls });
    const client = {};
    handler.handle({ type: "wall_history", request_id: 3, from_ts: T - 45_000, to_ts: T, price_lo: 79_000, price_hi: 81_000 }, client, BINANCE);
    expect(sent).toHaveLength(1);
    const [, frame] = sent[0];
    expect(frame).toMatchObject({ type: "wall_history", request_id: 3, complete: true, row_width: 2, next: null });
    expect(frame.walls.map((wall) => [wall.hid, wall.row])).toEqual([[2, 40_000], [3, 40_010]]);
    handler.handle({ type: "wall_history", request_id: 4, from_ts: T - 60_000, to_ts: T, price_lo: 1, price_hi: 100_000, cursor: { end_ts: T - 50_000, hid: 1 } }, client, BINANCE);
    expect(sent[1][1].walls.map((wall) => wall.hid)).toEqual([2, 3, 4]);
    expect(handler.stats()).toMatchObject({ answered: 2, walls: 5 });
  });

  test("answers an l2_event_history request with both series, their cursors, and the same row range", () => {
    const events = createEventHistory({ columnMs: 1_000, deepColumnMs: 10_000, recentMs: 60_000, maxAgeMs: 86_400_000 });
    events.recordTrades([{ ts: T - 500, row: 40_000, aggressor: "sell", mode: "absorbed", size: 2 }, { ts: T - 500, row: 44_000, aggressor: "sell", mode: "absorbed", size: 9 }]);
    events.recordWallTrades([{ ts: T - 500, wall: { side: "bid", row: 40_000, span: 1, startTs: T - 60_000 }, mode: "absorbed", size: 2 }]);
    const { handler, sent } = harness({ events });
    const client = {};
    handler.handle({ type: "l2_event_history", request_id: 5, from_ts: T - 10_000, to_ts: T, price_lo: 79_000, price_hi: 81_000 }, client, BINANCE);
    const [, frame] = sent[0];
    expect(frame).toMatchObject({ type: "l2_event_history", request_id: 5, complete: true, row_width: 2, next: null });
    expect(frame.trades).toEqual([[T - 1_000, 1_000, 40_000, "sell", "absorbed", 2, 1]]);
    expect(frame.wall_trades).toEqual([[T - 1_000, "bid:40000:1:" + String(T - 60_000), "absorbed", 2, 1]]);
    expect(handler.stats()).toMatchObject({ answered: 1, trades: 1, wallTrades: 1 });
  });

  test("answers an l2_event_history request with how far back the history holds trades up to the asked end, so an empty page past its memory is not read as nothing traded (PR #39 review)", () => {
    const events = createEventHistory({ columnMs: 1_000, deepColumnMs: 10_000, recentMs: 60_000, maxAgeMs: 86_400_000 });
    events.cover(T - 30_000, T);
    events.recordTrades([{ ts: T - 500, row: 40_000, aggressor: "sell", mode: "absorbed", size: 2 }]);
    const { handler, sent, lines } = harness({ events });
    const ask = (from, to) => handler.handle({ type: "l2_event_history", request_id: sent.length, from_ts: from, to_ts: to, price_lo: 79_000, price_hi: 81_000 }, {}, BINANCE);
    ask(T - 60_000, T);
    expect(sent[0][1]).toMatchObject({ complete: true, trades_held_from: T - 30_000 });
    expect(sent[0][1].trades).toHaveLength(1);
    ask(T - 20_000, T);
    expect(sent[1][1]).toMatchObject({ complete: true, trades_held_from: T - 20_000 });
    ask(T - 120_000, T - 60_000);
    expect(sent[2][1]).toMatchObject({ complete: true, trades: [], next: null, trades_held_from: T - 60_000 });
    expect(lines).toEqual([]);
  });

  test("a bad request is refused with BAD_REQUEST, a pair without geometry or history says so, and a client over its rate budget is told when to retry", () => {
    const { handler, sent, lines, advance } = harness({ walls: createWallHistory({ maxAgeMs: 86_400_000 }), rateLimit: { max: 2, windowMs: 60_000 } });
    const client = {};
    const good = { type: "wall_history", request_id: 1, from_ts: T - 1_000, to_ts: T, price_lo: 79_000, price_hi: 81_000 };
    handler.handle({ ...good, extra: 1 }, client, BINANCE);
    expect(sent[0][1]).toMatchObject({ complete: false, reason: "BAD_REQUEST", row_width: null });
    handler.handle({ type: "wall_history" }, client, BINANCE);
    expect(sent).toHaveLength(1);
    expect(lines.some((line) => /dropped wall_history request/.test(line))).toBe(true);
    handler.handle(good, client, BINANCE);
    handler.handle(good, client, BINANCE);
    handler.handle(good, client, BINANCE);
    expect(sent[3][1]).toMatchObject({ complete: false, reason: "OVERLOADED", retry_after_ms: 60_000, row_width: 2 });
    expect(handler.stats()).toMatchObject({ refused: 1, dropped: 1, answered: 2, rejected: 1 });
    handler.forget(client);
    advance(1);
    handler.handle(good, client, BINANCE);
    expect(sent[4][1]).toMatchObject({ complete: true });
    const noGeometry = harness({ geometry: null });
    noGeometry.handler.handle(good, {}, BINANCE);
    expect(noGeometry.sent[0][1]).toMatchObject({ reason: "GEOMETRY_UNAVAILABLE", row_width: null });
    const noHistory = harness();
    noHistory.handler.handle(good, {}, BINANCE);
    noHistory.handler.handle({ ...good, type: "l2_event_history" }, {}, BINANCE);
    expect(noHistory.sent.map(([, frame]) => [frame.type, frame.reason])).toEqual([["wall_history", "HISTORY_UNAVAILABLE"], ["l2_event_history", "HISTORY_UNAVAILABLE"]]);
    noHistory.handler.dispose();
    noHistory.handler.handle(good, {}, BINANCE);
    expect(noHistory.sent).toHaveLength(2);
  });
});
