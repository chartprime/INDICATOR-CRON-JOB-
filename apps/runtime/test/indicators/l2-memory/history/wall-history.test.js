"use strict";

const { createWallHistory, keyOf, validEnded, DEFAULT_PAGE } = require("../../../../src/indicators/l2-memory/history/wall-history");

const T = 1_780_000_000_000;
const DAY = 86_400_000;

function ended(over = {}) {
  return { side: "bid", row: 100, span: 1, startTs: T - 60_000, endTs: T, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0, fill: 0.1, eaten: 0.2, detail: { traded: 6, absorbed: 6, swept: 0, hidden: 0, cleared: 30, fillRatio: 0.2, crossSide: 1, firstShrinkTs: T - 30_000, reachedAtFirstShrink: true, endDistanceRows: 2, clearedByTrades: false, repeats: 2, evidenceGap: false }, ...over };
}

describe("wall history (P4e2 step 3): a pair's ended walls kept by time", () => {
  test("validates its options and its input", () => {
    expect(() => createWallHistory({})).toThrow(/maxAgeMs/);
    expect(() => createWallHistory({ maxAgeMs: DAY, maxWalls: 0 })).toThrow(/maxWalls/);
    expect(() => createWallHistory({ maxAgeMs: DAY, maxBytes: 0 })).toThrow(/maxBytes/);
    const history = createWallHistory({ maxAgeMs: DAY });
    expect(() => history.record("x")).toThrow(/array/);
    expect(() => history.query({ fromTs: T, toTs: T - 1 })).toThrow(/fromTs/);
    expect(() => history.query({ fromTs: T, toTs: T, limit: 0 })).toThrow(/limit/);
    expect(validEnded(ended())).toBe(true);
    expect(validEnded(ended({ endTs: null }))).toBe(false);
    expect(validEnded(ended({ endedBy: null }))).toBe(false);
    expect(validEnded(ended({ endedBy: "gone" }))).toBe(false);
    expect(validEnded(ended({ peak: 1, size: 2 }))).toBe(false);
    expect(validEnded(ended({ endTs: T - 70_000 }))).toBe(false);
  });

  test("a wall is known by its side, rows and birth: recorded once with its own id, updated when its verdict or evidence moves, never duplicated", () => {
    const history = createWallHistory({ maxAgeMs: DAY });
    expect(history.record([ended(), ended({ endTs: null }), ended({ side: "ask" })])).toEqual({ added: 2, updated: 0 });
    expect(history.size).toBe(2);
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.record([ended()])).toEqual({ added: 0, updated: 0 });
    expect(history.dirty).toBe(false);
    expect(history.record([ended({ endedBy: "moved" })])).toEqual({ added: 0, updated: 1 });
    expect(history.dirty).toBe(true);
    const { walls } = history.query({ fromTs: T - DAY, toTs: T });
    expect(walls.map((wall) => [wall.hid, wall.side, wall.endedBy, wall.historical])).toEqual([[1, "bid", "moved", true], [2, "ask", "pulled", true]]);
    expect(walls[0].detail).toEqual({ traded: 6, absorbed: 6, swept: 0, hidden: 0, cleared: 30, crossSide: 1, fillRatio: 0.2, firstShrinkTs: T - 30_000, reachedAtFirstShrink: true, endDistanceRows: 2, clearedByTrades: false, repeats: 2, evidenceGap: false });
    expect(Object.isFrozen(walls[0])).toBe(true);
    expect(keyOf(ended())).toBe("bid:100:1:" + String(T - 60_000));
    expect(history.record([ended({ detail: null })])).toEqual({ added: 0, updated: 1 });
    expect(history.query({ fromTs: T, toTs: T }).walls[0].detail).toBeNull();
  });

  test("queries by the life overlapping a time range and by rows, in order of ending, a page at a time with a cursor", () => {
    const history = createWallHistory({ maxAgeMs: DAY });
    const list = [];
    for (let i = 0; i < 10; i += 1) list.push(ended({ row: 100 + i, startTs: T + i * 1_000, endTs: T + i * 1_000 + 5_000 }));
    history.record(list);
    expect(history.query({ fromTs: T + 7_000, toTs: T + 7_000 }).walls.map((w) => w.row)).toEqual([102, 103, 104, 105, 106, 107]);
    expect(history.query({ fromTs: T - DAY, toTs: T + 1_000_000, rowLo: 108, rowHi: 200 }).walls.map((w) => w.row)).toEqual([108, 109]);
    expect(history.query({ fromTs: T - DAY, toTs: T + 1_000_000, side: "ask" }).walls).toEqual([]);
    const first = history.query({ fromTs: T - DAY, toTs: T + 1_000_000, limit: 4 });
    expect(first.walls.map((w) => w.row)).toEqual([100, 101, 102, 103]);
    expect(first.next).toEqual({ endTs: T + 8_000, hid: 4 });
    const second = history.query({ fromTs: T - DAY, toTs: T + 1_000_000, limit: 4, cursor: first.next });
    expect(second.walls.map((w) => w.row)).toEqual([104, 105, 106, 107]);
    const third = history.query({ fromTs: T - DAY, toTs: T + 1_000_000, limit: 4, cursor: second.next });
    expect(third.walls.map((w) => w.row)).toEqual([108, 109]);
    expect(third.next).toBeNull();
    expect(DEFAULT_PAGE).toBe(400);
  });

  test("walls that ended before the age window go on prune; over the count cap the ones that meant least go first, oldest first within a class", () => {
    const history = createWallHistory({ maxAgeMs: DAY, maxWalls: 3 });
    history.record([
      ended({ row: 1, startTs: T - 2 * DAY, endTs: T - 2 * DAY + 90_000, endedBy: "filled" }),
      ended({ row: 2, startTs: T - 90_000, endTs: T - 10_000, endedBy: "filled" }),
      ended({ row: 3, startTs: T - 80_000, endTs: T - 9_000, endedBy: "hit" }),
      ended({ row: 4, startTs: T - 70_000, endTs: T - 8_000, endedBy: "pulled" }),
      ended({ row: 5, startTs: T - 7_500, endTs: T - 7_000, endedBy: "pulled" }),
      ended({ row: 6, startTs: T - 60_000, endTs: T - 6_000, endedBy: "moved" }),
    ]);
    expect(history.prune(T)).toBe(1);
    expect(history.trim()).toBe(2);
    expect(history.query({ fromTs: T - DAY, toTs: T }).walls.map((w) => [w.row, w.endedBy])).toEqual([[2, "filled"], [3, "hit"], [4, "pulled"]]);
    expect(history.stats()).toEqual({ added: 6, updated: 0, pruned: 1, trimmed: 2, walls: 3 });
    const tie = createWallHistory({ maxAgeMs: DAY, maxWalls: 1 });
    tie.record([ended({ row: 1, endTs: T - 2_000, endedBy: "hit" }), ended({ row: 2, endTs: T - 1_000, endedBy: "hit" })]);
    tie.trim();
    expect(tie.query({ fromTs: T - DAY, toTs: T }).walls.map((w) => w.row)).toEqual([2]);
  });

  test("over the byte cap it drops enough of the least meaningful walls to land under nine tenths of it", () => {
    const history = createWallHistory({ maxAgeMs: DAY, maxBytes: 1_000 });
    history.record(Array.from({ length: 10 }, (_, i) => ended({ row: i, endedBy: i < 5 ? "filled" : "moved" })));
    expect(history.trimToBytes(900)).toBe(0);
    expect(history.trimToBytes(2_000)).toBe(6);
    expect(history.query({ fromTs: T, toTs: T }).walls.map((w) => w.endedBy)).toEqual(["filled", "filled", "filled", "filled"]);
  });

  test("round-trips through JSON with its ids and counter, and refuses a saved shape it cannot trust", () => {
    const history = createWallHistory({ maxAgeMs: DAY });
    history.record([ended({ row: 1 }), ended({ row: 2, endedBy: "filled" })]);
    const saved = JSON.parse(JSON.stringify(history.toJSON()));
    expect(saved).toMatchObject({ version: 1, nextId: 3 });
    expect(saved.walls.map((w) => w.hid)).toEqual([1, 2]);
    const back = createWallHistory({ maxAgeMs: DAY });
    expect(back.load(saved)).toBe(true);
    expect(back.query({ fromTs: T, toTs: T })).toEqual(history.query({ fromTs: T, toTs: T }));
    expect(back.nextId).toBe(3);
    expect(back.dirty).toBe(false);
    back.record([ended({ row: 3 })]);
    expect(back.query({ fromTs: T, toTs: T }).walls.map((w) => w.hid)).toEqual([1, 2, 3]);
    const bads = [null, { version: 2, nextId: 3, walls: [] }, { version: 1, nextId: 0, walls: [] }, { version: 1, nextId: 3, walls: [{ ...saved.walls[0], hid: 3 }] }, { version: 1, nextId: 3, walls: [saved.walls[0], saved.walls[0]] }, { version: 1, nextId: 3, walls: [{ ...saved.walls[0], endedBy: "x" }] }];
    for (const bad of bads) expect(back.load(bad)).toBe(false);
    expect(back.size).toBe(3);
    back.clear();
    expect(back.size).toBe(0);
  });

  test("extend: a wall standing at the end of a replayed window pushes the birth of the stored wall born there back to its own, same side and rows, within the tolerance", () => {
    const history = createWallHistory({ maxAgeMs: DAY });
    history.record([ended({ row: 100, span: 2, startTs: T - 60_000, endTs: T, endedBy: "hit", peak: 30 }), ended({ row: 200, startTs: T - 60_000, endTs: T })]);
    expect(() => history.extend("x", { until: T, toleranceMs: 1 })).toThrow(/array/);
    expect(() => history.extend([], { until: -1, toleranceMs: 1 })).toThrow(/until/);
    expect(() => history.extend([], { until: T, toleranceMs: -1 })).toThrow(/toleranceMs/);
    const standing = (over) => ({ side: "bid", row: 101, span: 1, startTs: T - 600_000, endTs: null, size: 20, peak: 40, endedBy: null, ...over });
    expect(history.extend([standing({ side: "ask" }), standing({ row: 150 }), standing({ startTs: T - 59_000 }), { side: "bid" }], { until: T - 60_000, toleranceMs: 1_000 })).toEqual([]);
    expect(history.extend([standing()], { until: T - 70_000, toleranceMs: 1_000 })).toEqual([]);
    expect(history.extend([standing()], { until: T - 60_000, toleranceMs: 1_000 })).toEqual([{ hid: 1, from: T - 60_000, startTs: T - 600_000 }]);
    const { walls } = history.query({ fromTs: T, toTs: T });
    expect(walls.map((w) => [w.hid, w.row, w.startTs, w.peak])).toEqual([[1, 100, T - 600_000, 40], [2, 200, T - 60_000, 30]]);
    expect(history.record([ended({ row: 100, span: 2, startTs: T - 600_000, endTs: T, endedBy: "hit", peak: 40 })])).toEqual({ added: 0, updated: 0 });
    expect(history.extend([standing({ startTs: T - 900_000 })], { until: T - 600_000, toleranceMs: 1_000 })).toHaveLength(1);
    expect(history.query({ fromTs: T, toTs: T }).walls[0].startTs).toBe(T - 900_000);
  });
});
