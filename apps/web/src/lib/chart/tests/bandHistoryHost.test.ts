import { describe, expect, it } from "vitest";
import type { HistoryIdentity, HistoryRequest } from "../../indicators/passive-liquidity/heatmapHistory";
import type { DecodedHistoryPage, HistoryWindow, HistoryWindowState } from "../../indicators/passive-liquidity/heatmapHistoryDecode";
import type { LiquidityColumn } from "../../indicators/passive-liquidity/liquidityGrid";
import { zoneRows } from "../../indicators/institutional-order-blocks/institutionalRules";
import { columnMid } from "../../indicators/absorption-detector/absorptionColumns";
import { InFlightPool, RequestBudget } from "../../indicators/passive-liquidity/requestBudget";
import {
  BAND_COLUMN_ID_BASE,
  BAND_COLUMN_ID_SPAN,
  BAND_COLUMN_MAX_ATTEMPTS,
  BAND_COLUMN_MAX_PER_MINUTE,
  BAND_COLUMN_RETRY_MS,
  BAND_FLOW_LEVEL_MS,
  BAND_GIVE_UP_MS,
  BAND_HOST_LAG_MS,
  BAND_HOST_MAX_SPAN_MS,
  BAND_PENDING_MS,
  BAND_RETRY_MS,
  BandHistoryStore,
  type BandReach,
  bandKeyOf,
  bandLevelMsFor,
  ownsBandColumnId,
} from "../bandHistory";

const W = 300_000;
const T = 1_700_000_100_000;
const HOUR = 3_600_000;
const PERP: HistoryIdentity = { provider: "BINANCE", marketKind: "PERP", symbol: "BTCUSDT" };

function want(fromTs: number, toTs: number, priceLo = 80_000, priceHi = 80_008) {
  return { key: bandKeyOf(fromTs, toTs, priceLo, priceHi), fromTs, toTs, priceLo, priceHi, columnMs: 10_000 };
}

function host(identity: HistoryIdentity | null = PERP) {
  const sent: HistoryRequest[] = [];
  const store = new BandHistoryStore({ columns: { request: (request) => sent.push(request), identity: () => identity } });
  return { store, sent };
}

function column(ts: number, bid = [9, 1, 2, 3, 9]): LiquidityColumn {
  return { ts, lo: 19_998, hi: 20_002, bid: Float64Array.from(bid), ask: Float64Array.from([0, 0, 4, 0, 0]), buy: [[19_999, 5], [20_000, 1.5]], sell: [[20_001, 0.5], [20_002, 7]] };
}

function win(ts: number, levelMs = 10_000, state: HistoryWindowState = "COVERED", bid?: number[]): HistoryWindow {
  const columns: LiquidityColumn[] = [];
  if (state === "COVERED" || state === "PARTIAL") for (let at = ts; at < ts + W; at += levelMs) columns.push(column(at, bid));
  return { ts, state, columns };
}

function page(windows: HistoryWindow[], over: Partial<{ levelMs: number; rowWidth: number; next: number | null; oldest: number | null; newest: number | null }> = {}): DecodedHistoryPage {
  return {
    available: true,
    generation: "g1",
    levelMs: over.levelMs ?? 10_000,
    rowFactor: 1,
    rowWidth: over.rowWidth ?? 4,
    span: { oldest: over.oldest === undefined ? T - 100 * W : over.oldest, newest: over.newest === undefined ? T + 100 * W : over.newest },
    next: over.next ?? null,
    windows,
  };
}

describe("band history from the host's columns", () => {
  it("reads a window at 10 s up to two hours, 30 s up to six, one minute beyond, and never past the host's week", () => {
    expect(bandLevelMsFor(2 * HOUR)).toBe(10_000);
    expect(bandLevelMsFor(2 * HOUR + 1)).toBe(30_000);
    expect(bandLevelMsFor(6 * HOUR)).toBe(30_000);
    expect(bandLevelMsFor(6 * HOUR + 1)).toBe(60_000);
    expect(bandLevelMsFor(BAND_HOST_MAX_SPAN_MS)).toBe(60_000);
    const { store, sent } = host();
    const long = want(T, T + BAND_HOST_MAX_SPAN_MS + 1);
    const version = store.version;
    store.want(long);
    expect(store.older(long.key)).toBe(true);
    expect(store.version).toBe(version + 1);
    expect(store.nextRequest(T + BAND_HOST_MAX_SPAN_MS + HOUR)).toBeNull();
    expect(sent).toHaveLength(0);
    const week = want(T, T + BAND_HOST_MAX_SPAN_MS);
    store.want(week);
    expect(store.older(week.key)).toBe(false);
    expect(store.older("unknown")).toBe(false);
  });

  it("asks the host's columns instead of the raw replay, one request in flight, follows the cursor, and lays the zone's rows only", () => {
    const { store, sent } = host();
    const w = want(T + 60_000, T + 2 * W + 20_000);
    store.want(w);
    const now = T + HOUR;
    expect(store.nextRequest(now)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ requestId: sent[0].requestId, identity: PERP, levelMs: 10_000, rowFactor: 1, fromTs: T, toTs: T + 3 * W });
    expect(ownsBandColumnId(sent[0].requestId)).toBe(true);
    expect(sent[0].requestId).toBeGreaterThanOrEqual(BAND_COLUMN_ID_BASE);
    expect(sent[0].requestId).toBeLessThan(BAND_COLUMN_ID_BASE + BAND_COLUMN_ID_SPAN);
    expect(ownsBandColumnId(BAND_COLUMN_ID_BASE - 1)).toBe(false);
    expect(ownsBandColumnId(BAND_COLUMN_ID_BASE + BAND_COLUMN_ID_SPAN)).toBe(false);
    expect(store.nextRequest(now + 1_000)).toBeNull();
    expect(sent).toHaveLength(1);
    const version = store.version;
    expect(store.acceptColumns(sent[0].requestId + 7, page([win(T), win(T + W), win(T + 2 * W)]), now)).toBe(false);
    expect(store.feedFor(w.key)).toBeNull();
    expect(store.acceptColumns(sent[0].requestId, page([win(T), win(T + W)], { next: T + 2 * W }), now)).toBe(false);
    expect(store.feedFor(w.key)).toBeNull();
    expect(store.version).toBe(version);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ levelMs: 10_000, fromTs: T + 2 * W, toTs: T + 3 * W });
    expect(sent[1].requestId).toBeGreaterThan(sent[0].requestId);
    expect(store.acceptColumns(sent[1].requestId, page([win(T + 2 * W)]), now)).toBe(true);
    expect(store.version).toBe(version + 1);
    const answer = store.feedFor(w.key)!;
    expect(answer.rowWidth).toBe(4);
    expect(answer.gaps).toEqual([]);
    expect(answer.feed.deep).toBeNull();
    expect(answer.feed.fine.columnMs).toBe(10_000);
    const columns = answer.feed.fine.columns;
    expect(columns).toHaveLength(57);
    expect(columns[0].ts).toBe(T + 60_000);
    expect(columns.at(-1)!.ts).toBe(T + 2 * W + 20_000);
    const rows = zoneRows(w.priceHi, w.priceLo, 4)!;
    for (const laid of columns) {
      expect([laid.lo, laid.hi]).toEqual([rows.rowLo, rows.rowHi]);
      expect([...laid.bid]).toEqual([2, 3]);
      expect([...laid.ask]).toEqual([4, 0]);
      expect(laid.buy).toEqual([[20_000, 1.5]]);
      expect(laid.sell).toEqual([[20_001, 0.5]]);
    }
    expect(store.nextRequest(now + HOUR)).toBeNull();
    expect(sent).toHaveLength(2);
  });

  it("a column narrower than the zone reads zero outside its rows", () => {
    const { store, sent } = host();
    const w = want(T, T + 20_000, 79_992, 80_008);
    store.want(w);
    store.nextRequest(T + HOUR);
    const narrow: HistoryWindow = { ts: T, state: "COVERED", columns: [T, T + 10_000, T + 20_000].map((ts) => ({ ts, lo: 19_999, hi: 20_000, bid: Float64Array.from([6, 7]), ask: Float64Array.from([0, 0]) })) };
    expect(store.acceptColumns(sent[0].requestId, page([narrow]), T + HOUR)).toBe(true);
    const laid = store.feedFor(w.key)!.feed.fine.columns[0];
    expect([laid.lo, laid.hi]).toEqual([19_998, 20_001]);
    expect([...laid.bid]).toEqual([0, 6, 7, 0]);
    expect(laid.buy).toEqual([]);
    expect(laid.sell).toEqual([]);
  });

  it("asks the newest zone first, one page fills every zone that overlaps it, and the next zone asks only what it still lacks", () => {
    const { store, sent } = host();
    const a = want(T + 60_000, T + W + 20_000);
    const b = want(T + W + 30_000, T + 3 * W + 10_000);
    const c = want(T - 2 * W, T - 2 * W + 20_000);
    store.want(a);
    store.want(b);
    store.want(c);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(sent[0]).toMatchObject({ fromTs: T + W, toTs: T + 4 * W });
    expect(store.acceptColumns(sent[0].requestId, page([win(T + W, 10_000, "COVERED", [9, 1, 5, 5, 9]), win(T + 2 * W), win(T + 3 * W)]), now)).toBe(true);
    expect(store.feedFor(b.key)!.gaps).toEqual([]);
    expect(store.feedFor(b.key)!.feed.fine.columns[0].ts).toBe(T + W + 30_000);
    expect(store.feedFor(a.key)).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ fromTs: T, toTs: T + W });
    expect(store.acceptColumns(sent[1].requestId, page([win(T)]), now)).toBe(true);
    const columns = store.feedFor(a.key)!.feed.fine.columns;
    expect(columns[0].ts).toBe(T + 60_000);
    expect([...columns[0].bid]).toEqual([2, 3]);
    expect([...columns.at(-1)!.bid]).toEqual([5, 5]);
    expect(store.feedFor(a.key)!.gaps).toEqual([]);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ fromTs: T - 2 * W, toTs: T - W });
  });

  it("a page fills only the zones read at its level", () => {
    const { store, sent } = host();
    const short = want(T, T + 20_000);
    const long = want(T - 3 * HOUR, T + 20_000);
    store.want(short);
    store.want(long);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(sent[0]).toMatchObject({ levelMs: 10_000, fromTs: T, toTs: T + W });
    store.acceptColumns(sent[0].requestId, page([win(T)]), now);
    expect(store.feedFor(short.key)).not.toBeNull();
    expect(sent[1]).toMatchObject({ levelMs: 30_000, fromTs: T - 3 * HOUR, toTs: T + W });
    const windows: HistoryWindow[] = [];
    for (let ts = T - 3 * HOUR; ts <= T; ts += W) windows.push(win(ts, 30_000, "COVERED", [9, 1, 7, 7, 9]));
    expect(store.acceptColumns(sent[1].requestId, page(windows, { levelMs: 30_000 }), now)).toBe(true);
    const answer = store.feedFor(long.key)!;
    expect(answer.feed.fine.columnMs).toBe(30_000);
    expect(answer.feed.fine.columns).toHaveLength((3 * HOUR) / 30_000 + 1);
    expect([...answer.feed.fine.columns.at(-1)!.bid]).toEqual([7, 7]);
    expect(answer.gaps).toEqual([]);
  });

  it("a zone that starts before the host's oldest window is older than the recording: no more asks, no raw replay", () => {
    const { store, sent } = host();
    const old = want(T + 60_000, T + W);
    const older = want(T - 5 * W, T - 4 * W);
    const inside = want(T + 2 * W, T + 2 * W + 20_000);
    store.want(old);
    store.want(older);
    store.want(inside);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(sent[0]).toMatchObject({ fromTs: T + 2 * W, toTs: T + 3 * W });
    const version = store.version;
    expect(store.acceptColumns(sent[0].requestId, page([win(T + 2 * W)], { oldest: T + W }), now)).toBe(true);
    expect(store.version).toBe(version + 1);
    expect(store.older(old.key)).toBe(true);
    expect(store.older(older.key)).toBe(true);
    expect(store.older(inside.key)).toBe(false);
    expect(store.feedFor(old.key)).toBeNull();
    expect(store.feedFor(inside.key)).not.toBeNull();
    expect(store.nextRequest(now + BAND_GIVE_UP_MS * 2)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("waits for windows the host has not built yet and asks only those; a host that stopped building hands the zone to the raw replay", () => {
    const { store, sent } = host();
    const w = want(T + 60_000, T + 2 * W + 20_000);
    store.want(w);
    const now = T + 2 * W + 60_000;
    store.nextRequest(now);
    expect(store.acceptColumns(sent[0].requestId, page([win(T), win(T + W)], { newest: T + W }), now)).toBe(false);
    expect(store.feedFor(w.key)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(store.nextRequest(T + 3 * W - 1)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(store.nextRequest(T + 3 * W)).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ fromTs: T + 2 * W, toTs: T + 3 * W });
    expect(store.acceptColumns(sent[1].requestId, page([], { newest: T + W }), T + 3 * W)).toBe(false);
    expect(store.nextRequest(T + 3 * W + BAND_RETRY_MS - 1)).toBeNull();
    expect(sent).toHaveLength(2);
    store.nextRequest(T + 3 * W + BAND_RETRY_MS);
    expect(sent).toHaveLength(3);
    expect(store.acceptColumns(sent[2].requestId, page([win(T + 2 * W)], { newest: T + 2 * W }), T + 3 * W + BAND_RETRY_MS)).toBe(true);
    expect(store.feedFor(w.key)!.feed.fine.columns).toHaveLength(57);

    const stale = host();
    stale.store.want(w);
    const late = T + 3 * W + BAND_HOST_LAG_MS + 1;
    stale.store.nextRequest(late);
    stale.store.acceptColumns(stale.sent[0].requestId, page([win(T), win(T + W)], { newest: T + W }), late);
    const raw = stale.store.nextRequest(late);
    expect(raw).toMatchObject({ from_ts: w.fromTs, to_ts: w.toTs, price_lo: w.priceLo, price_hi: w.priceHi, column_ms: w.columnMs });
    expect(stale.sent).toHaveLength(1);

    const fresh = host();
    fresh.store.want(w);
    const edge = T + 3 * W + BAND_HOST_LAG_MS;
    fresh.store.nextRequest(edge);
    fresh.store.acceptColumns(fresh.sent[0].requestId, page([win(T), win(T + W)], { newest: T + W }), edge);
    expect(fresh.store.nextRequest(edge)).toBeNull();
  });

  it("a failed ask backs off, and after three the zone goes to the raw replay", () => {
    const { store, sent } = host();
    const w = want(T, T + 20_000);
    store.want(w);
    let now = T + HOUR;
    store.nextRequest(now);
    expect(store.acceptColumns(sent[0].requestId, null, now)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(store.nextRequest(now + BAND_COLUMN_RETRY_MS - 1)).toBeNull();
    expect(sent).toHaveLength(1);
    now += BAND_COLUMN_RETRY_MS;
    expect(store.nextRequest(now)).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ fromTs: T, toTs: T + W });
    store.acceptColumns(sent[1].requestId, null, now);
    expect(store.nextRequest(now + 2 * BAND_COLUMN_RETRY_MS - 1)).toBeNull();
    expect(sent).toHaveLength(2);
    now += 2 * BAND_COLUMN_RETRY_MS;
    expect(store.nextRequest(now)).toBeNull();
    expect(sent).toHaveLength(3);
    expect(BAND_COLUMN_MAX_ATTEMPTS).toBe(3);
    store.acceptColumns(sent[2].requestId, null, now);
    expect(store.nextRequest(now)).toMatchObject({ from_ts: T, to_ts: T + 20_000, price_lo: 80_000, price_hi: 80_008, column_ms: 10_000 });
    expect(sent).toHaveLength(3);
  });

  it("a success clears the failures, and a page at the wrong level or with a stuck cursor counts as one", () => {
    const { store, sent } = host();
    const w = want(T, T + W + 20_000);
    store.want(w);
    let now = T + HOUR;
    store.nextRequest(now);
    store.acceptColumns(sent[0].requestId, null, now);
    now += BAND_COLUMN_RETRY_MS;
    store.nextRequest(now);
    store.acceptColumns(sent[1].requestId, page([win(T, 30_000)], { levelMs: 30_000 }), now);
    expect(sent).toHaveLength(2);
    expect(store.nextRequest(now + 2 * BAND_COLUMN_RETRY_MS - 1)).toBeNull();
    expect(sent).toHaveLength(2);
    now += 2 * BAND_COLUMN_RETRY_MS;
    store.nextRequest(now);
    expect(sent).toHaveLength(3);
    store.acceptColumns(sent[2].requestId, page([win(T)], { next: T + W }), now);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ fromTs: T + W, toTs: T + 2 * W });
    store.acceptColumns(sent[3].requestId, page([], { next: T + W }), now);
    expect(sent).toHaveLength(4);
    expect(store.nextRequest(now + BAND_COLUMN_RETRY_MS - 1)).toBeNull();
    expect(sent).toHaveLength(4);
    now += BAND_COLUMN_RETRY_MS;
    expect(store.nextRequest(now)).toBeNull();
    expect(sent).toHaveLength(5);
    expect(store.acceptColumns(sent[4].requestId, page([win(T + W)]), now)).toBe(true);
  });

  it("a host without the pair's pyramid sends zones to the raw replay at once, and is not asked again for ten minutes", () => {
    const { store, sent } = host();
    const w = want(T, T + 20_000);
    store.want(w);
    const now = T + HOUR;
    store.nextRequest(now);
    store.acceptColumns(sent[0].requestId, { available: false, reason: "NO_PYRAMID" }, now);
    const raw = store.nextRequest(now)!;
    expect(raw).toMatchObject({ from_ts: T, to_ts: T + 20_000 });
    store.dropPending();
    const second = want(T + W, T + W + 20_000);
    store.want(second);
    store.forget(w.key);
    expect(store.nextRequest(now + BAND_GIVE_UP_MS - 1)).toMatchObject({ from_ts: T + W });
    expect(sent).toHaveLength(1);
    store.dropPending();
    const third = want(T + 2 * W, T + 2 * W + 20_000);
    store.want(third);
    store.forget(second.key);
    expect(store.nextRequest(now + BAND_GIVE_UP_MS)).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ fromTs: T + 2 * W });

    const empty = host();
    empty.store.want(w);
    const soon = T + W;
    empty.store.nextRequest(soon);
    empty.store.acceptColumns(empty.sent[0].requestId, page([], { oldest: null, newest: null }), soon);
    expect(empty.store.older(w.key)).toBe(false);
    expect(empty.store.nextRequest(soon)).toMatchObject({ from_ts: T });

    const unselected = host(null);
    unselected.store.want(w);
    expect(unselected.store.nextRequest(now)).toMatchObject({ from_ts: T });
    expect(unselected.sent).toHaveLength(0);
  });

  it("a window the host recorded nothing in, or lost, is a gap; time outside an equity's session is not", () => {
    const { store, sent } = host();
    const w = want(T, T + 4 * W + 20_000);
    store.want(w);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(store.acceptColumns(sent[0].requestId, page([win(T), win(T + W, 10_000, "NO_DATA"), win(T + 2 * W), win(T + 4 * W)]), now)).toBe(true);
    const answer = store.feedFor(w.key)!;
    expect(answer.gaps).toEqual([{ from: T + W - 10_000, to: T + 2 * W - 10_000 }, { from: T + 3 * W - 10_000, to: T + 4 * W - 10_000 }]);
    expect(answer.feed.fine.columns).toHaveLength((4 * W + 20_000) / 10_000 + 1);
    const hole = answer.feed.fine.columns.find((laid) => laid.ts === T + W)!;
    expect([...hole.bid]).toEqual([0, 0]);
    expect(hole.buy).toEqual([]);

    const close = Date.UTC(2023, 10, 14, 21, 0, 0);
    const zone = want(close - W, close + W + 20_000);
    const pageAtClose = () => page([win(close - W)], { oldest: close - 100 * W, newest: close + 100 * W });
    const equity = host({ provider: "DXFEED", marketKind: "EQUITY", symbol: "AAPL" });
    equity.store.want(zone);
    equity.store.nextRequest(close + HOUR);
    equity.store.acceptColumns(equity.sent[0].requestId, pageAtClose(), close + HOUR);
    expect(equity.store.feedFor(zone.key)!.gaps).toEqual([]);
    expect(equity.store.feedFor(zone.key)!.feed.fine.columns).toHaveLength((2 * W + 20_000) / 10_000 + 1);
    const crypto = host();
    crypto.store.want(zone);
    crypto.store.nextRequest(close + HOUR);
    crypto.store.acceptColumns(crypto.sent[0].requestId, pageAtClose(), close + HOUR);
    expect(crypto.store.feedFor(zone.key)!.gaps).toEqual([{ from: close - 10_000, to: close + W + 20_000 }]);
  });

  it("a page in another row geometry starts the zone over instead of mixing rows", () => {
    const { store, sent } = host();
    const w = want(T, T + W + 20_000);
    store.want(w);
    const now = T + HOUR;
    store.nextRequest(now);
    store.acceptColumns(sent[0].requestId, page([win(T)], { next: T + W }), now);
    expect(sent[1]).toMatchObject({ fromTs: T + W });
    expect(store.acceptColumns(sent[1].requestId, page([win(T + W)], { rowWidth: 8 }), now)).toBe(false);
    expect(store.feedFor(w.key)).toBeNull();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ fromTs: T, toTs: T + W });
    store.acceptColumns(sent[2].requestId, page([win(T)], { rowWidth: 8 }), now);
    const answer = store.feedFor(w.key)!;
    expect(answer.rowWidth).toBe(8);
    expect([answer.feed.fine.columns[0].lo, answer.feed.fine.columns[0].hi]).toEqual([10_000, 10_000]);
  });

  it("spends a budget it is handed, so the column streams' requests count against it too (PR #40 review)", () => {
    const pool = new RequestBudget(3);
    const streams = pool.share();
    const sent: HistoryRequest[] = [];
    const store = new BandHistoryStore({ columns: { request: (request) => sent.push(request), identity: () => PERP }, budget: pool.share(2) });
    expect(store.budget.pool).toBe(pool);
    const now = T + 200 * HOUR;
    streams.take(now);
    streams.take(now);
    for (let i = 0; i < 4; i += 1) store.want(want(T + i * HOUR, T + i * HOUR + 20_000));
    store.nextRequest(now);
    expect(sent).toHaveLength(1);
    store.acceptColumns(sent[0].requestId, page([win(sent[0].fromTs)]), now);
    store.nextRequest(now + 1);
    expect(sent).toHaveLength(1);
    store.nextRequest(now + 60_000);
    expect(sent).toHaveLength(2);
    store.acceptColumns(sent[1].requestId, page([win(sent[1].fromTs)]), now + 60_000);
    store.nextRequest(now + 60_001);
    expect(sent).toHaveLength(3);
    store.acceptColumns(sent[2].requestId, page([win(sent[2].fromTs)]), now + 60_001);
    store.nextRequest(now + 60_002);
    expect(sent).toHaveLength(3);
  });

  it("holds its one column read in the route's shared pool: none while other readers hold every slot, the slot freed on the answer and when the ask expires (PR #47 review)", () => {
    const pool = new InFlightPool(1);
    const sent: HistoryRequest[] = [];
    const store = new BandHistoryStore({ columns: { request: (request) => sent.push(request), identity: () => PERP }, pool });
    const now = T + 200 * HOUR;
    for (let i = 0; i < 4; i += 1) store.want(want(T + i * HOUR, T + i * HOUR + 20_000));
    pool.take();
    store.nextRequest(now);
    expect(sent).toHaveLength(0);
    pool.free();
    store.nextRequest(now + 1);
    expect(sent).toHaveLength(1);
    expect(pool.held).toBe(1);
    store.acceptColumns(sent[0].requestId, page([win(sent[0].fromTs)]), now + 2);
    expect(sent).toHaveLength(2);
    expect(pool.held).toBe(1);
    store.nextRequest(now + 2 + BAND_PENDING_MS);
    expect(sent).toHaveLength(3);
    expect(pool.held).toBe(1);
  });

  it("keeps its asks bounded: a budget per minute, an unanswered ask expires as a failure, ids never repeat across stores", () => {
    const { store, sent } = host();
    const now = T + 200 * HOUR;
    for (let i = 0; i < BAND_COLUMN_MAX_PER_MINUTE + 5; i += 1) store.want(want(T + i * HOUR, T + i * HOUR + 20_000));
    store.nextRequest(now);
    for (let i = 0; i < BAND_COLUMN_MAX_PER_MINUTE + 5 && i < sent.length; i += 1) store.acceptColumns(sent[i].requestId, page([win(sent[i].fromTs)]), now);
    expect(sent).toHaveLength(BAND_COLUMN_MAX_PER_MINUTE);
    expect(store.nextRequest(now + 59_999)).toBeNull();
    expect(sent).toHaveLength(BAND_COLUMN_MAX_PER_MINUTE);
    store.nextRequest(now + 60_000);
    expect(sent).toHaveLength(BAND_COLUMN_MAX_PER_MINUTE + 1);
    const stuck = sent.at(-1)!;
    expect(store.nextRequest(now + 60_000 + BAND_PENDING_MS - 1)).toBeNull();
    expect(sent).toHaveLength(BAND_COLUMN_MAX_PER_MINUTE + 1);
    store.nextRequest(now + 60_000 + BAND_PENDING_MS);
    expect(sent).toHaveLength(BAND_COLUMN_MAX_PER_MINUTE + 2);
    expect(sent.at(-1)!.fromTs).not.toBe(stuck.fromTs);
    expect(store.acceptColumns(stuck.requestId, page([win(stuck.fromTs)]), now + 60_000 + BAND_PENDING_MS)).toBe(false);

    const other = host();
    other.store.want(want(T, T + 20_000));
    other.store.nextRequest(now);
    expect(sent.map((request) => request.requestId)).not.toContain(other.sent[0].requestId);
    expect(other.store.acceptColumns(sent[0].requestId, page([win(T)]), now)).toBe(false);
    expect(other.store.feedFor(want(T, T + 20_000).key)).toBeNull();
  });

  it("a zone forgotten while its ask is in flight is not laid, and the page still serves the others", () => {
    const { store, sent } = host();
    const a = want(T, T + 20_000);
    const b = want(T + 30_000, T + 50_000);
    store.want(a);
    store.want(b);
    const now = T + HOUR;
    store.nextRequest(now);
    store.forget(b.key);
    expect(store.acceptColumns(sent[0].requestId, page([win(T)]), now)).toBe(true);
    expect(store.feedFor(b.key)).toBeNull();
    expect(store.feedFor(a.key)!.feed.fine.columns).toHaveLength(3);
    expect(sent).toHaveLength(1);
  });
});

describe("band history for a level and for a range: more than the band's rows", () => {
  function reaching(reach: BandReach, fromTs: number, toTs: number, priceLo = 80_000, priceHi = 80_008) {
    return { key: reach + ":" + bandKeyOf(fromTs, toTs, priceLo, priceHi), fromTs, toTs, priceLo, priceHi, columnMs: 10_000, reach };
  }

  function book(ts: number, bidTop: number, askBottom: number): LiquidityColumn {
    const lo = 19_990;
    const hi = 20_010;
    const bid = new Float64Array(hi - lo + 1);
    const ask = new Float64Array(hi - lo + 1);
    for (let row = lo; row <= bidTop; row += 1) bid[row - lo] = 1 + (row - lo);
    for (let row = askBottom; row <= hi; row += 1) ask[row - lo] = 100 + (row - lo);
    return { ts, lo, hi, bid, ask, buy: [[19_991, 5], [20_000, 1.5], [20_009, 2]], sell: [[19_992, 3], [20_001, 0.5]] };
  }

  it("a level's want keeps the whole flow and the book from its band to the mid, so the mid reads as it did on the full column", () => {
    const { store, sent } = host();
    const level = reaching("mid", T, T + 30_000);
    const zone = want(T, T + 30_000);
    store.want(level);
    store.want(zone);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(sent[0]).toMatchObject({ levelMs: 10_000, fromTs: T, toTs: T + W });
    const below = book(T, 19_995, 19_997);
    const above = book(T + 10_000, 20_005, 20_006);
    const empty: LiquidityColumn = { ts: T + 20_000, lo: 19_990, hi: 20_010, bid: new Float64Array(21), ask: new Float64Array(21) };
    const inside = book(T + 30_000, 20_000, 20_001);
    expect(store.acceptColumns(sent[0].requestId, page([{ ts: T, state: "COVERED", columns: [below, above, empty, inside] }]), now)).toBe(true);
    const laid = store.feedFor(level.key)!.feed.fine.columns;
    expect(laid).toHaveLength(4);
    expect([laid[0].lo, laid[0].hi]).toEqual([19_995, 20_001]);
    expect([...laid[0].bid]).toEqual([6, 0, 0, 0, 0, 0, 0]);
    expect([...laid[0].ask]).toEqual([0, 0, 107, 108, 109, 110, 111]);
    expect([laid[1].lo, laid[1].hi]).toEqual([20_000, 20_006]);
    expect([laid[2].lo, laid[2].hi]).toEqual([20_000, 20_001]);
    expect(laid[2].buy).toEqual([]);
    expect([laid[3].lo, laid[3].hi]).toEqual([20_000, 20_001]);
    for (const [i, full] of [below, above, empty, inside].entries()) expect(columnMid(laid[i], 4)).toBe(columnMid(full, 4));
    expect(columnMid(laid[0], 4)).not.toBeNull();
    expect(laid[0].buy).toEqual([[19_991, 5], [20_000, 1.5], [20_009, 2]]);
    expect(laid[0].sell).toEqual([[19_992, 3], [20_001, 0.5]]);
    const cut = store.feedFor(zone.key)!.feed.fine.columns;
    expect([cut[0].lo, cut[0].hi]).toEqual([20_000, 20_001]);
    expect(cut[0].buy).toEqual([[20_000, 1.5]]);
    expect(store.feedFor(level.key)!.rowWidth).toBe(4);
  });

  it("a range's want is read at one minute whatever its length and keeps the flow alone", () => {
    const { store, sent } = host();
    const range = reaching("flow", T, T + 2 * W - 1);
    store.want(range);
    const now = T + HOUR;
    store.nextRequest(now);
    expect(BAND_FLOW_LEVEL_MS).toBe(60_000);
    expect(sent[0]).toMatchObject({ levelMs: 60_000, fromTs: T, toTs: T + 2 * W });
    const windows: HistoryWindow[] = [T, T + W].map((ts) => ({ ts, state: "COVERED", columns: [0, 1, 2, 3, 4].map((i) => book(ts + i * 60_000, 19_995, 19_997)) }));
    expect(store.acceptColumns(sent[0].requestId, page(windows, { levelMs: 60_000 }), now)).toBe(true);
    const answer = store.feedFor(range.key)!;
    expect(answer.feed.fine.columnMs).toBe(60_000);
    expect(answer.gaps).toEqual([]);
    expect(answer.feed.fine.columns).toHaveLength(10);
    for (const laid of answer.feed.fine.columns) {
      expect([laid.lo, laid.hi]).toEqual([20_000, 20_000]);
      expect([...laid.bid]).toEqual([0]);
      expect([...laid.ask]).toEqual([0]);
      expect(laid.buy).toEqual([[19_991, 5], [20_000, 1.5], [20_009, 2]]);
      expect(laid.sell).toEqual([[19_992, 3], [20_001, 0.5]]);
    }
    const holed = host();
    holed.store.want(range);
    holed.store.nextRequest(now);
    holed.store.acceptColumns(holed.sent[0].requestId, page([windows[0], { ts: T + W, state: "NO_DATA", columns: [] }], { levelMs: 60_000 }), now);
    const gapped = holed.store.feedFor(range.key)!;
    expect(gapped.gaps).toEqual([{ from: T + W - 60_000, to: T + 2 * W - 1 }]);
    const filler = gapped.feed.fine.columns.at(-1)!;
    expect([filler.lo, filler.hi, filler.bid.length]).toEqual([20_000, 20_000, 1]);
  });

  it("a want the raw replay cannot serve never goes to it: it rests ten minutes and asks the host again", () => {
    for (const reach of ["mid", "flow"] as const) {
      const { store, sent } = host();
      const w = reaching(reach, T, T + 20_000);
      store.want(w);
      let now = T + HOUR;
      store.nextRequest(now);
      store.acceptColumns(sent[0].requestId, null, now);
      now += BAND_COLUMN_RETRY_MS;
      store.nextRequest(now);
      store.acceptColumns(sent[1].requestId, null, now);
      now += 2 * BAND_COLUMN_RETRY_MS;
      store.nextRequest(now);
      expect(sent).toHaveLength(3);
      store.acceptColumns(sent[2].requestId, null, now);
      expect(store.nextRequest(now)).toBeNull();
      expect(store.nextRequest(now + BAND_GIVE_UP_MS - 1)).toBeNull();
      expect(sent).toHaveLength(3);
      expect(store.nextRequest(now + BAND_GIVE_UP_MS)).toBeNull();
      expect(sent).toHaveLength(4);
      store.acceptColumns(sent[3].requestId, null, now + BAND_GIVE_UP_MS);
      expect(store.nextRequest(now + BAND_GIVE_UP_MS + BAND_COLUMN_RETRY_MS - 1)).toBeNull();
      expect(sent).toHaveLength(4);
      store.nextRequest(now + BAND_GIVE_UP_MS + BAND_COLUMN_RETRY_MS);
      expect(sent).toHaveLength(5);
    }

    const off = host();
    const level = reaching("mid", T, T + 20_000);
    const zone = want(T + W, T + W + 20_000);
    off.store.want(level);
    off.store.want(zone);
    const now = T + HOUR;
    off.store.nextRequest(now);
    off.store.acceptColumns(off.sent[0].requestId, { available: false, reason: "NO_PYRAMID" }, now);
    expect(off.store.nextRequest(now)).toMatchObject({ from_ts: T + W });
    off.store.dropPending();
    off.store.forget(zone.key);
    expect(off.store.nextRequest(now + BAND_GIVE_UP_MS - 1)).toBeNull();
    expect(off.sent).toHaveLength(1);
    expect(off.store.nextRequest(now + BAND_GIVE_UP_MS)).toBeNull();
    expect(off.sent).toHaveLength(2);
    expect(off.sent[1]).toMatchObject({ fromTs: T, toTs: T + W });
    expect(off.store.acceptColumns(off.sent[1].requestId, page([win(T)]), now + BAND_GIVE_UP_MS)).toBe(true);
    expect(off.store.feedFor(level.key)).not.toBeNull();

    const empty = host();
    empty.store.want(level);
    empty.store.nextRequest(T + W);
    empty.store.acceptColumns(empty.sent[0].requestId, page([], { oldest: null, newest: null }), T + W);
    expect(empty.store.nextRequest(T + W + BAND_GIVE_UP_MS - 1)).toBeNull();
    expect(empty.sent).toHaveLength(1);
    empty.store.nextRequest(T + W + BAND_GIVE_UP_MS);
    expect(empty.sent).toHaveLength(2);

    const stale = host();
    stale.store.want(level);
    const late = T + W + BAND_HOST_LAG_MS + 1;
    stale.store.nextRequest(late);
    stale.store.acceptColumns(stale.sent[0].requestId, page([], { newest: T - W }), late);
    expect(stale.store.nextRequest(late + BAND_GIVE_UP_MS - 1)).toBeNull();
    expect(stale.sent).toHaveLength(1);
    stale.store.nextRequest(late + BAND_GIVE_UP_MS);
    expect(stale.sent).toHaveLength(2);

    const sourceless = new BandHistoryStore();
    sourceless.want(level);
    expect(sourceless.nextRequest(now)).toBeNull();
    expect(sourceless.pending).toBe(0);
  });

  it("the same key asked with another reach starts over", () => {
    const { store, sent } = host();
    const zone = want(T, T + 20_000);
    store.want(zone);
    const now = T + HOUR;
    store.nextRequest(now);
    store.acceptColumns(sent[0].requestId, page([win(T)]), now);
    expect(store.feedFor(zone.key)).not.toBeNull();
    expect(store.want({ ...zone })).toBe(store.get(zone.key));
    expect(store.feedFor(zone.key)).not.toBeNull();
    store.want({ ...zone, reach: "mid" });
    expect(store.feedFor(zone.key)).toBeNull();
  });
});
