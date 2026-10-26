const { createSizeHistory } = require("../../../src/indicators/l2-memory/size-history");

describe("size-history", () => {
  test("validates inputs and time order", () => {
    expect(() => createSizeHistory({ windowMs: 0 })).toThrow(/windowMs/);
    const h = createSizeHistory();
    expect(() => h.record({ ts: 1, side: "mid", key: 1, size: 1 })).toThrow(/side/);
    expect(() => h.record({ ts: 1, side: "bid", key: 1, size: -1 })).toThrow(/size/);
    h.record({ ts: 1_000, side: "bid", key: 1, size: 1 });
    expect(() => h.record({ ts: 999, side: "bid", key: 1, size: 1 })).toThrow(/time order/);
  });

  test("answers the size at any past instant from sparse samples", () => {
    const h = createSizeHistory();
    h.record({ ts: 1_000, side: "ask", key: 7, size: 5 });
    h.record({ ts: 3_000, side: "ask", key: 7, size: 2 });
    h.record({ ts: 3_000, side: "ask", key: 7, size: 3 }); // same instant overwrites
    h.record({ ts: 6_000, side: "ask", key: 7, size: 0 });
    expect(h.sizeAt({ side: "ask", key: 7, ts: 500 })).toBeNull();
    expect(h.sizeAt({ side: "ask", key: 7, ts: 1_000 })).toBe(5);
    expect(h.sizeAt({ side: "ask", key: 7, ts: 2_999 })).toBe(5);
    expect(h.sizeAt({ side: "ask", key: 7, ts: 3_000 })).toBe(3);
    expect(h.sizeAt({ side: "ask", key: 7, ts: 5_000 })).toBe(3);
    expect(h.sizeAt({ side: "ask", key: 7, ts: 9_000 })).toBe(0);
    expect(h.sizeAt({ side: "bid", key: 7, ts: 9_000 })).toBeNull();
  });

  test("change reports then/now/delta and null when the level did not exist yet", () => {
    const h = createSizeHistory();
    h.record({ ts: 10_000, side: "bid", key: 3, size: 8 });
    h.record({ ts: 14_000, side: "bid", key: 3, size: 2 });
    expect(h.change({ side: "bid", key: 3, ts: 15_000, lookbackMs: 5_000 })).toEqual({ then: 8, now: 2, delta: -6 });
    expect(h.change({ side: "bid", key: 3, ts: 15_000, lookbackMs: 10_000 })).toEqual({ then: null, now: 2, delta: null });
    expect(h.change({ side: "bid", key: 99, ts: 15_000, lookbackMs: 1_000 })).toEqual({ then: null, now: 0, delta: null });
  });

  test("coverage exit discards an old size baseline before a price re-enters", () => {
    const h = createSizeHistory();
    h.record({ ts: 10_000, side: "bid", key: 3, size: 8 });
    h.forget({ ts: 11_000, side: "bid", key: 3 });
    expect(h.change({ side: "bid", key: 3, ts: 11_000, lookbackMs: 5_000 })).toEqual({ then: null, now: 0, delta: null });
    h.record({ ts: 12_000, side: "bid", key: 3, size: 7 });
    expect(h.change({ side: "bid", key: 3, ts: 12_000, lookbackMs: 5_000 })).toEqual({ then: null, now: 7, delta: null });
    expect(() => h.forget({ ts: 11_999, side: "bid", key: 3 })).toThrow(/time order/);
  });

  test("totalAt sums a set of keys, treating unknown ones as empty", () => {
    const h = createSizeHistory();
    h.record({ ts: 1_000, side: "ask", key: 1, size: 1 });
    h.record({ ts: 1_000, side: "ask", key: 2, size: 2 });
    h.record({ ts: 2_000, side: "ask", key: 2, size: 5 });
    expect(h.totalAt({ side: "ask", keys: [1, 2, 3], ts: 1_500 })).toBe(3);
    expect(h.totalAt({ side: "ask", keys: [1, 2, 3], ts: 2_500 })).toBe(6);
  });

  test("prune drops old samples, keeps the last pre-window one, and forgets dead levels", () => {
    const h = createSizeHistory({ windowMs: 10_000 });
    h.record({ ts: 1_000, side: "bid", key: 1, size: 4 });
    h.record({ ts: 2_000, side: "bid", key: 1, size: 6 });
    h.record({ ts: 3_000, side: "bid", key: 2, size: 0 });
    h.record({ ts: 20_000, side: "bid", key: 1, size: 7 });
    h.prune(25_000); // cutoff 15_000
    // key 1: samples at 1000 and 2000 are before the cutoff; keep only the 2000 one plus 20000.
    expect(h.stats()).toMatchObject({ bidKeys: 1, samples: 2 });
    expect(h.sizeAt({ side: "bid", key: 1, ts: 15_000 })).toBe(6);
    expect(h.sizeAt({ side: "bid", key: 1, ts: 21_000 })).toBe(7);
    // key 2 was empty and untouched since before the cutoff: forgotten.
    expect(h.sizeAt({ side: "bid", key: 2, ts: 21_000 })).toBeNull();
  });
});
