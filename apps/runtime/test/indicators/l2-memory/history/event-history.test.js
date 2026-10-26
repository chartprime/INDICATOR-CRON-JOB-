"use strict";

const { createEventHistory, wallKeyOf, BYTES_PER_TRADE, BYTES_PER_WALL_TRADE } = require("../../../../src/indicators/l2-memory/history/event-history");

const T = 1_780_000_000_000;
const OPTIONS = { columnMs: 1_000, deepColumnMs: 10_000, recentMs: 60_000, maxAgeMs: 86_400_000 };
const WALL = { side: "bid", row: 100, span: 2, startTs: T - 300_000 };

function trade(over = {}) {
  return { ts: T + 500, row: 100, aggressor: "sell", mode: "absorbed", size: 2, ...over };
}

function wallTrade(over = {}) {
  return { ts: T + 500, wall: WALL, mode: "absorbed", size: 2, price: 100, ...over };
}

describe("event history (P4e2 step 4): trades near the mid and into walls, folded like the heatmap", () => {
  test("validates its options and input", () => {
    expect(() => createEventHistory({ ...OPTIONS, columnMs: 0 })).toThrow(/columnMs/);
    expect(() => createEventHistory({ ...OPTIONS, deepColumnMs: 1_500 })).toThrow(/deepColumnMs/);
    expect(() => createEventHistory({ ...OPTIONS, recentMs: -1 })).toThrow(/recentMs/);
    expect(() => createEventHistory({ ...OPTIONS, maxAgeMs: 0 })).toThrow(/maxAgeMs/);
    expect(() => createEventHistory({ ...OPTIONS, maxTradeBytes: 0 })).toThrow(/maxTradeBytes/);
    expect(() => createEventHistory({ ...OPTIONS, maxWallTradeBytes: 0 })).toThrow(/maxWallTradeBytes/);
    const history = createEventHistory(OPTIONS);
    expect(() => history.recordTrades("x")).toThrow(/array/);
    expect(() => history.recordWallTrades("x")).toThrow(/array/);
    expect(() => history.advance("x")).toThrow(/time/);
    expect(() => history.queryTrades({ fromTs: T, toTs: T - 1 })).toThrow(/fromTs/);
    expect(() => history.queryWallTrades({ fromTs: T, toTs: T, limit: 0 })).toThrow(/limit/);
    expect(history.recordTrades([trade({ aggressor: "x" }), trade({ mode: "x" }), trade({ size: 0 }), trade({ row: -1 })])).toBe(0);
    expect(history.recordWallTrades([wallTrade({ wall: { ...WALL, side: "x" } }), wallTrade({ size: 0 })])).toBe(0);
    expect(history.size).toBe(0);
  });

  test("trades fold into one-second buckets per row, aggressor and mode; the same bucket sums size and count", () => {
    const history = createEventHistory(OPTIONS);
    expect(history.recordTrades([trade(), trade({ ts: T + 900, size: 3 }), trade({ ts: T + 1_200 }), trade({ row: 101 }), trade({ aggressor: "buy" }), trade({ mode: "swept" })])).toBe(6);
    expect(history.tradeBuckets).toBe(5);
    expect(history.dirty).toBe(true);
    const { records, next } = history.queryTrades({ fromTs: T, toTs: T + 5_000 });
    expect(next).toBeNull();
    expect(records.map((r) => [r.ts - T, r.row, r.aggressor, r.mode, r.size, r.count, r.columnMs])).toEqual([
      [0, 100, "buy", "absorbed", 2, 1, 1_000],
      [0, 100, "sell", "absorbed", 5, 2, 1_000],
      [0, 100, "sell", "swept", 2, 1, 1_000],
      [0, 101, "sell", "absorbed", 2, 1, 1_000],
      [1_000, 100, "sell", "absorbed", 2, 1, 1_000],
    ]);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(history.queryTrades({ fromTs: T + 1_000, toTs: T + 1_000 }).records.map((r) => r.ts - T)).toEqual([1_000]);
    expect(history.queryTrades({ fromTs: T, toTs: T, rowLo: 101, rowHi: 101 }).records.map((r) => r.row)).toEqual([101]);
    expect(history.queryTrades({ fromTs: T + 2_000, toTs: T + 3_000 }).records).toEqual([]);
  });

  test("beyond the recent window a bucket folds to the deep width, and a query reads both tiers in time order with a cursor", () => {
    const history = createEventHistory(OPTIONS);
    const list = [];
    for (let i = 0; i < 25; i += 1) list.push(trade({ ts: T + i * 1_000 }));
    history.recordTrades(list);
    expect(history.advance(T + 24_000 + 60_000)).toEqual({ folded: 24, pruned: 0, evicted: 0 });
    expect(history.stats()).toMatchObject({ fine: 1, deep: 3, folded: 24 });
    const all = history.queryTrades({ fromTs: T, toTs: T + 30_000 });
    expect(all.records.map((r) => [r.ts - T, r.columnMs, r.size, r.count])).toEqual([[0, 10_000, 20, 10], [10_000, 10_000, 20, 10], [20_000, 10_000, 8, 4], [24_000, 1_000, 2, 1]]);
    expect(history.queryTrades({ fromTs: T + 15_000, toTs: T + 15_000 }).records.map((r) => r.ts - T)).toEqual([10_000]);
    const first = history.queryTrades({ fromTs: T, toTs: T + 30_000, limit: 2 });
    expect(first.records.map((r) => r.ts - T)).toEqual([0, 10_000]);
    expect(first.next).toMatchObject({ ts: T + 10_000 });
    const second = history.queryTrades({ fromTs: T, toTs: T + 30_000, limit: 2, cursor: first.next });
    expect(second.records.map((r) => r.ts - T)).toEqual([20_000, 24_000]);
    expect(second.next).toBeNull();
  });

  test("trades into a wall fold per wall, second and mode, keyed by the wall's side, rows and birth", () => {
    const history = createEventHistory(OPTIONS);
    expect(history.recordWallTrades([wallTrade(), wallTrade({ ts: T + 700, size: 1 }), wallTrade({ mode: "swept" }), wallTrade({ wall: { ...WALL, startTs: T } })])).toBe(4);
    expect(history.wallTradeBuckets).toBe(3);
    expect(wallKeyOf(WALL)).toBe("bid:100:2:" + String(T - 300_000));
    const { records } = history.queryWallTrades({ fromTs: T, toTs: T + 1_000 });
    expect(records.map((r) => [r.ts - T, r.wall, r.mode, r.size, r.count])).toEqual([[0, wallKeyOf(WALL), "absorbed", 3, 2], [0, wallKeyOf(WALL), "swept", 2, 1], [0, wallKeyOf({ ...WALL, startTs: T }), "absorbed", 2, 1]]);
    expect(history.queryWallTrades({ fromTs: T, toTs: T + 1_000, wall: wallKeyOf({ ...WALL, startTs: T }) }).records).toHaveLength(1);
    const page = history.queryWallTrades({ fromTs: T, toTs: T + 1_000, limit: 2 });
    expect(history.queryWallTrades({ fromTs: T, toTs: T + 1_000, limit: 2, cursor: page.next }).records.map((r) => r.wall)).toEqual([wallKeyOf({ ...WALL, startTs: T })]);
  });

  test("each series is bounded by bytes, oldest buckets out first, deep before fine; walls past the age window go on prune", () => {
    const history = createEventHistory({ ...OPTIONS, maxTradeBytes: 3 * BYTES_PER_TRADE, maxWallTradeBytes: 2 * BYTES_PER_WALL_TRADE });
    const list = [];
    for (let i = 0; i < 6; i += 1) list.push(trade({ ts: T + i * 1_000 }));
    history.recordTrades(list);
    history.recordWallTrades([wallTrade({ ts: T }), wallTrade({ ts: T + 1_000 }), wallTrade({ ts: T + 2_000 })]);
    expect(history.advance(T + 5_000)).toEqual({ folded: 0, pruned: 0, evicted: 4 });
    expect(history.queryTrades({ fromTs: T, toTs: T + 10_000 }).records.map((r) => r.ts - T)).toEqual([3_000, 4_000, 5_000]);
    expect(history.queryWallTrades({ fromTs: T, toTs: T + 10_000 }).records.map((r) => r.ts - T)).toEqual([1_000, 2_000]);
    const old = createEventHistory({ ...OPTIONS, maxAgeMs: 10_000 });
    old.recordTrades([trade({ ts: T }), trade({ ts: T + 20_000 })]);
    old.recordWallTrades([wallTrade({ ts: T })]);
    expect(old.advance(T + 20_000)).toEqual({ folded: 0, pruned: 2, evicted: 0 });
    expect(old.size).toBe(1);
  });

  test("over the file budget it drops a share of both series to land under nine tenths of the caps", () => {
    const history = createEventHistory({ ...OPTIONS, maxTradeBytes: 10 * BYTES_PER_TRADE, maxWallTradeBytes: 10 * BYTES_PER_WALL_TRADE });
    history.recordTrades(Array.from({ length: 10 }, (_, i) => trade({ ts: T + i * 1_000 })));
    history.recordWallTrades(Array.from({ length: 10 }, (_, i) => wallTrade({ ts: T + i * 1_000 })));
    expect(history.trimToBytes(10 * (BYTES_PER_TRADE + BYTES_PER_WALL_TRADE))).toBe(0);
    expect(history.trimToBytes(20 * (BYTES_PER_TRADE + BYTES_PER_WALL_TRADE))).toBe(12);
    expect(history.tradeBuckets).toBe(4);
    expect(history.wallTradeBuckets).toBe(4);
  });

  test("round-trips through JSON as compact rows and refuses a shape, width or duplicate it cannot trust", () => {
    const history = createEventHistory(OPTIONS);
    history.recordTrades([trade(), trade({ ts: T - 120_000 })]);
    history.recordWallTrades([wallTrade()]);
    history.advance(T + 1_000);
    const saved = JSON.parse(JSON.stringify(history.toJSON()));
    expect(saved).toMatchObject({ version: 1, columnMs: 1_000, deepColumnMs: 10_000 });
    expect(saved.trades).toEqual([[T - 120_000, 10_000, 100, "sell", "absorbed", 2, 1], [T, 1_000, 100, "sell", "absorbed", 2, 1]]);
    expect(saved.wallTrades).toEqual([[T, wallKeyOf(WALL), "absorbed", 2, 1]]);
    const back = createEventHistory(OPTIONS);
    expect(back.load(saved)).toBe(true);
    expect(back.dirty).toBe(false);
    expect(back.queryTrades({ fromTs: T - 200_000, toTs: T })).toEqual(history.queryTrades({ fromTs: T - 200_000, toTs: T }));
    expect(back.queryWallTrades({ fromTs: T, toTs: T })).toEqual(history.queryWallTrades({ fromTs: T, toTs: T }));
    const bads = [null, { ...saved, version: 2 }, { ...saved, columnMs: 2_000 }, { ...saved, trades: "x" }, { ...saved, trades: [[T, 5_000, 100, "sell", "absorbed", 2, 1]] }, { ...saved, trades: [saved.trades[1], saved.trades[1]] }, { ...saved, wallTrades: [[T, "", "absorbed", 2, 1]] }, { ...saved, wallTrades: [saved.wallTrades[0], saved.wallTrades[0]] }];
    for (const bad of bads) expect(back.load(bad)).toBe(false);
    expect(back.size).toBe(3);
    back.clear();
    expect(back.size).toBe(0);
  });

  test("merge takes a pass folded at its own column width, as the startup pass is, as one-second buckets the next advance folds, and still refuses another width (PR #31 review)", () => {
    const pass = createEventHistory({ ...OPTIONS, deepColumnMs: 1_000, recentMs: 0 });
    pass.recordTrades([trade({ ts: T + 200 }), trade({ ts: T + 1_300, size: 3 })]);
    pass.advance(T + 10_000);
    const held = createEventHistory(OPTIONS);
    expect(held.merge(JSON.parse(JSON.stringify(pass.toJSON())))).toBe(true);
    expect(held.queryTrades({ fromTs: T, toTs: T + 2_000 }).records.map((r) => [r.ts - T, r.columnMs, r.size])).toEqual([[0, 1_000, 2], [1_000, 1_000, 3]]);
    held.advance(T + OPTIONS.recentMs + 20_000);
    expect(held.queryTrades({ fromTs: T, toTs: T + 20_000 }).records.map((r) => [r.ts - T, r.columnMs, r.size])).toEqual([[0, 10_000, 5]]);
    expect(held.merge({ ...pass.toJSON(), columnMs: 2_000, deepColumnMs: 2_000 })).toBe(false);
    expect(held.merge({ ...pass.toJSON(), deepColumnMs: 5_000 })).toBe(false);
  });

  test("merge adds a replayed window's folded buckets onto what is held, and the fill range rides with the JSON", () => {
    const history = createEventHistory(OPTIONS);
    history.recordTrades([trade()]);
    history.recordWallTrades([wallTrade()]);
    const other = createEventHistory(OPTIONS);
    other.recordTrades([trade({ size: 5 }), trade({ ts: T - 120_000 })]);
    other.recordWallTrades([wallTrade({ size: 1 })]);
    other.advance(T + 1_000);
    expect(history.merge(JSON.parse(JSON.stringify(other.toJSON())))).toBe(true);
    expect(history.queryTrades({ fromTs: T - 200_000, toTs: T }).records.map((r) => [r.ts - T, r.columnMs, r.size, r.count])).toEqual([[-120_000, 10_000, 2, 1], [0, 1_000, 7, 2]]);
    expect(history.queryWallTrades({ fromTs: T, toTs: T }).records.map((r) => [r.size, r.count])).toEqual([[3, 2]]);
    expect(history.stats().merged).toBe(3);
    expect(history.merge({ ...other.toJSON(), trades: "x" })).toBe(false);
    expect(history.tradeBuckets).toBe(2);
    expect(history.fill).toBeNull();
    expect(() => history.setFill({ from: T, until: T - 1 })).toThrow(/fill/);
    history.markSaved();
    history.setFill({ from: T - 3_600_000, until: T });
    expect(history.dirty).toBe(true);
    expect(history.fill).toEqual({ from: T - 3_600_000, until: T });
    const saved = JSON.parse(JSON.stringify(history.toJSON()));
    expect(saved.fill).toEqual({ from: T - 3_600_000, until: T });
    const back = createEventHistory(OPTIONS);
    expect(back.load(saved)).toBe(true);
    expect(back.fill).toEqual({ from: T - 3_600_000, until: T });
    expect(back.load({ ...saved, fill: { from: T, until: T - 1 } })).toBe(false);
    const older = createEventHistory(OPTIONS);
    const withoutFill = { ...saved };
    delete withoutFill.fill;
    expect(older.load(withoutFill)).toBe(true);
    expect(older.fill).toBeNull();
    back.clear();
    expect(back.fill).toBeNull();
  });

  test("knows the spans it already holds: a merge over a span adds only what lies outside them, and the spans ride with the file (PR #32 re-review)", () => {
    const batch = (...stamps) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: stamps.map((ts) => [ts, 10_000, 100, "buy", "swept", 1, 1]), wallTrades: [] });
    const history = createEventHistory(OPTIONS);
    expect(history.covered).toEqual([]);
    expect(history.uncovered(T, T + 60_000)).toEqual([[T, T + 60_000]]);
    expect(history.merge(batch(T, T + 10_000), { from: T, until: T + 20_000 })).toBe(true);
    expect(history.merge(batch(T + 10_000, T + 20_000), { from: T + 10_000, until: T + 30_000 })).toBe(true);
    expect(history.queryTrades({ fromTs: T, toTs: T + 60_000 }).records.map((record) => [record.ts - T, record.size])).toEqual([[0, 1], [10_000, 1], [20_000, 1]]);
    expect(history.stats().skipped).toBe(1);
    expect(history.covered).toEqual([[T, T + 30_000]]);
    history.cover(T + 40_000, T + 50_000);
    history.setFill({ from: T - 20_000, until: T - 10_000 });
    expect(history.uncovered(T - 30_000, T + 60_000)).toEqual([[T - 30_000, T - 20_000], [T - 10_000, T], [T + 30_000, T + 40_000], [T + 50_000, T + 60_000]]);
    expect(history.merge(batch(T - 15_000), { from: T - 15_000, until: T - 5_000 })).toBe(true);
    expect(history.queryTrades({ fromTs: T - 20_000, toTs: T - 1 }).records).toEqual([]);
    expect(history.merge(batch(T + 10_000))).toBe(true);
    expect(history.queryTrades({ fromTs: T + 10_000, toTs: T + 10_000 }).records.map((record) => record.size)).toEqual([2]);
    expect(() => history.merge(batch(T), { from: T + 1, until: T })).toThrow(/from <= until/);
    expect(() => history.cover("x", T)).toThrow(/cover/);
    const back = createEventHistory(OPTIONS);
    expect(back.load(history.toJSON())).toBe(true);
    expect(back.covered).toEqual([[T - 15_000, T - 5_000], [T, T + 30_000], [T + 40_000, T + 50_000]]);
    expect(back.covered).toEqual(history.covered);
    expect(back.load({ ...history.toJSON(), covered: [[T, T]] })).toBe(false);
    back.advance(T + OPTIONS.maxAgeMs + 45_000);
    expect(back.covered).toEqual([[T + 45_000, T + 50_000]]);
    back.clear();
    expect(back.covered).toEqual([]);
  });

  test("says how far back it holds trades without a hole up to a time: the start of the span holding that time on a whole deep bucket, never before the ask, and the time itself when nothing is held there; the fill's own range, which spans windows it found empty, claims nothing (PR #39 and #40 reviews)", () => {
    const history = createEventHistory(OPTIONS);
    expect(history.heldFrom(T - 60_000, T)).toBe(T);
    history.cover(T - 30_000, T);
    expect(history.heldFrom(T - 60_000, T)).toBe(T - 30_000);
    expect(history.heldFrom(T - 20_000, T)).toBe(T - 20_000);
    expect(history.heldFrom(T - 60_000, T - 5_000)).toBe(T - 30_000);
    expect(history.heldFrom(T - 60_000, T + 1)).toBe(T + 1);
    history.cover(T - 50_000, T - 40_000);
    expect(history.heldFrom(T - 60_000, T)).toBe(T - 30_000);
    expect(history.heldFrom(T - 60_000, T - 35_000)).toBe(T - 35_000);
    expect(history.heldFrom(T - 60_000, T - 40_000)).toBe(T - 50_000);
    expect(history.heldFrom(T - 60_000, T - 50_000)).toBe(T - 50_000);
    history.setFill({ from: T - 40_000, until: T - 30_000 });
    expect(history.uncovered(T - 60_000, T)).toEqual([[T - 60_000, T - 50_000]]);
    expect(history.heldFrom(T - 60_000, T)).toBe(T - 30_000);
    history.cover(T - 40_000, T - 30_000);
    expect(history.heldFrom(T - 60_000, T)).toBe(T - 50_000);
    const ragged = createEventHistory(OPTIONS);
    ragged.cover(T - 34_500, T);
    expect(ragged.heldFrom(T - 60_000, T)).toBe(T - 30_000);
    expect(ragged.heldFrom(T - 60_000, T - 32_000)).toBe(T - 32_000);
    expect(() => history.heldFrom(T, T - 1)).toThrow(/heldFrom/);
    expect(() => history.heldFrom("x", T)).toThrow(/heldFrom/);
  });

  test("never claims the trades the byte cap or the age window dropped: what it holds starts after the newest bucket it lost, and that rides with the file; a file saved before that was recorded holds from its oldest trade (PR #39 review)", () => {
    const capped = createEventHistory({ ...OPTIONS, maxTradeBytes: 3 * BYTES_PER_TRADE });
    capped.cover(T - 60_000, T);
    capped.recordTrades([50_000, 41_500, 30_000, 20_000, 10_000].map((ago) => trade({ ts: T - ago })));
    expect(capped.advance(T)).toMatchObject({ evicted: 2 });
    expect(capped.advance(T + 1_000)).toMatchObject({ evicted: 0 });
    expect(capped.covered).toEqual([[T - 60_000, T]]);
    expect(capped.heldFrom(T - 60_000, T)).toBe(T - 40_000);
    expect(capped.heldFrom(T - 60_000, T - 45_000)).toBe(T - 45_000);
    expect(capped.toJSON().lostBefore).toBe(T - 41_000);
    const back = createEventHistory({ ...OPTIONS, maxTradeBytes: 3 * BYTES_PER_TRADE });
    expect(back.load(JSON.parse(JSON.stringify(capped.toJSON())))).toBe(true);
    expect(back.heldFrom(T - 60_000, T)).toBe(T - 40_000);
    expect(back.load({ ...capped.toJSON(), lostBefore: "x" })).toBe(false);
    const legacy = { ...capped.toJSON() };
    delete legacy.lostBefore;
    expect(back.load(legacy)).toBe(true);
    expect(back.heldFrom(T - 60_000, T)).toBe(T - 30_000);
    expect(back.load({ ...legacy, trades: [] })).toBe(true);
    expect(back.heldFrom(T - 60_000, T)).toBe(T - 60_000);
    back.load(JSON.parse(JSON.stringify(capped.toJSON())));
    back.clear();
    back.cover(T - 60_000, T);
    expect(back.heldFrom(T - 60_000, T)).toBe(T - 60_000);
    const folded = createEventHistory({ ...OPTIONS, maxTradeBytes: 2 * BYTES_PER_TRADE });
    folded.cover(T - 300_000, T);
    folded.recordTrades([200_000, 150_000, 10_000, 5_000].map((ago) => trade({ ts: T - ago })));
    expect(folded.advance(T)).toMatchObject({ folded: 2, evicted: 2 });
    expect(folded.queryTrades({ fromTs: T - 300_000, toTs: T }).records.map((record) => record.ts - T)).toEqual([-10_000, -5_000]);
    expect(folded.heldFrom(T - 300_000, T)).toBe(T - 140_000);
    const walls = createEventHistory({ ...OPTIONS, maxWallTradeBytes: BYTES_PER_WALL_TRADE });
    walls.cover(T - 60_000, T);
    walls.recordWallTrades([wallTrade({ ts: T - 50_000 }), wallTrade({ ts: T - 10_000 })]);
    expect(walls.advance(T)).toMatchObject({ evicted: 1 });
    expect(walls.heldFrom(T - 60_000, T)).toBe(T - 60_000);
    const aged = createEventHistory({ ...OPTIONS, maxAgeMs: 100_000 });
    aged.cover(T - 200_000, T);
    expect(aged.heldFrom(T - 200_000, T)).toBe(T - 200_000);
    aged.advance(T - 5_000);
    expect(aged.heldFrom(T - 200_000, T)).toBe(T - 100_000);
    aged.cover(T - 200_000, T - 100_000);
    expect(aged.heldFrom(T - 200_000, T)).toBe(T - 100_000);
  });
});

