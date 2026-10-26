"use strict";

const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { createLargeLevelTracker } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
const { createWallService, LIFECYCLE_CAP } = require("../../../src/indicators/l2-memory/wall-service");

const T = 1_780_000_000_000;
const MID = 1_000;
const WALL_OPTIONS = { minSize: 40, multiplier: 0, gapRows: 0, settleMs: 1_000, keepEndedMs: 7_200_000, deepKeepEndedMs: 7_200_000, maxLevels: 60 };

// A one-tick-per-row book around 1000 with thin 5-lot levels, so any row
// holding 40 or more is a wall (multiplier 0 makes the threshold minSize).
function harness({ ledgerOptions } = {}) {
  const engine = createMemoryEngine({ tickSize: 1, ...(ledgerOptions ? { ledgerOptions } : {}) });
  const book = { bid: new Map(), ask: new Map() };
  for (let i = 1; i <= 30; i += 1) {
    book.bid.set(MID - i, 5);
    book.ask.set(MID + i, 5);
  }
  const tuples = (side) => [...book[side].entries()].map(([price, size]) => [String(price), String(size)]);
  engine.apply({ kind: "book", ts: T, status: "READY", book: { bids: tuples("bid"), asks: tuples("ask") } });
  const service = createWallService({ engine, ...WALL_OPTIONS });
  const bare = createLargeLevelTracker(WALL_OPTIONS);
  let now = T;
  const best = (side) => (side === "bid" ? Math.max(...book.bid.keys()) : Math.min(...book.ask.keys()));

  function set(changes) {
    now += 10;
    const delta = { bids: [], asks: [] };
    for (const [side, price, size] of changes) {
      if (size === 0) book[side].delete(price);
      else book[side].set(price, size);
      delta[side === "bid" ? "bids" : "asks"].push([String(price), String(size)]);
    }
    engine.apply({ kind: "book", ts: now, status: "READY", book: { bestBid: best("bid"), bestAsk: best("ask") }, delta });
  }

  function trade(price, size, side) {
    now += 1;
    engine.apply({ kind: "trade", ts: now, price: String(price), size: String(size), side });
  }

  function loseCoverage(side, price) {
    now += 10;
    book[side].delete(price);
    engine.apply({ kind: "book", ts: now, status: "READY",
      book: { bids: tuples("bid"), asks: tuples("ask") },
      delta: { bids: [], asks: [] },
      coverage: {
        unobserved: { bids: side === "bid" ? [String(price)] : [], asks: side === "ask" ? [String(price)] : [] },
        preexisting: { bids: [], asks: [] },
      },
    });
  }

  function tick(stepMs = 1_000) {
    now = Math.floor(now / 1_000) * 1_000 + stepMs;
    const snapshot = engine.liteSnapshot();
    const column = sampleLiquidityColumn(snapshot, { ts: now, rowClusters: 1, windowRows: 40 });
    service.update({ ts: now, column, snapshot, rowClusters: 1, referenceRows: 10 });
    bare.update({ ts: now, column, snapshot, rowClusters: 1, referenceRows: 10 });
    return now;
  }

  function columnAt(ts) {
    const snapshot = engine.liteSnapshot();
    const column = sampleLiquidityColumn(snapshot, { ts, rowClusters: 1, windowRows: 40 });
    service.update({ ts, column, snapshot, rowClusters: 1, referenceRows: 10 });
    bare.update({ ts, column, snapshot, rowClusters: 1, referenceRows: 10 });
  }

  function ticks(count, stepMs = 1_000) {
    for (let i = 0; i < count; i += 1) tick(stepMs);
    return now;
  }

  const wallAt = (price) => service.levels().filter((level) => level.row === price);
  return { engine, service, bare, set, trade, loseCoverage, tick, ticks, columnAt, now: () => now, wallAt, unavailable: () => { now += 10; engine.apply({ kind: "book", ts: now, status: "UNAVAILABLE" }); }, ready: () => { now += 10; engine.apply({ kind: "book", ts: now, status: "READY", book: { bids: tuples("bid"), asks: tuples("ask") } }); } };
}

function eatenWall(traded) {
  const h = harness();
  h.tick();
  h.set([["bid", 990, 100]]);
  h.tick();
  h.trade(990, traded, "sell");
  h.set([["bid", 990, 0]]);
  h.ticks(3);
  const [level] = h.wallAt(990);
  return level;
}

describe("wall service (report 61 P2): the whale prototype's rules as fixture cases", () => {
  test("fill ratio is traded over the size the wall lost, either side of the 0.70 and 0.30 bands", () => {
    expect(eatenWall(70).detail.fillRatio).toBeCloseTo(0.7, 10);
    expect(eatenWall(69).detail.fillRatio).toBeCloseTo(0.69, 10);
    expect(eatenWall(30).detail.fillRatio).toBeCloseTo(0.3, 10);
    expect(eatenWall(29).detail.fillRatio).toBeCloseTo(0.29, 10);
    expect(eatenWall(150).detail.fillRatio).toBe(1);
    expect(eatenWall(70).detail).toMatchObject({ traded: 70, swept: 70, absorbed: 0 });
  });

  test("a wall that emptied with trades behind at least half of what cleared was cleared by trades, however long it lived", () => {
    const run = ({ lifeS, traded }) => {
      const h = harness();
      h.tick();
      h.set([["bid", 990, 100]]);
      h.tick();
      h.ticks(lifeS - 1);
      if (traded > 0) h.trade(990, traded, "sell");
      h.set([["bid", 990, 0]]);
      h.ticks(3);
      return h.wallAt(990)[0].detail;
    };
    expect(run({ lifeS: 30, traded: 50 })).toMatchObject({ clearedByTrades: true, cleared: 100 });
    expect(run({ lifeS: 30, traded: 49 }).clearedByTrades).toBe(false);
    expect(run({ lifeS: 180, traded: 80 })).toMatchObject({ clearedByTrades: true, lifeMs: 180_000 });
    expect(run({ lifeS: 30, traded: 0 }).clearedByTrades).toBe(false);
  });

  test("a row of a resting wall emptied by trades does not judge the wall while it still stands", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100], ["bid", 991, 100]]);
    h.tick();
    h.trade(991, 100, "sell");
    h.set([["bid", 991, 0]]);
    h.ticks(3);
    const [level] = h.wallAt(990);
    expect(level.endedBy).toBeNull();
    expect(level.detail).toMatchObject({ cleared: 100, traded: 100, clearedByTrades: false });
  });

  test("price at the wall when it first shrank counts even though price had left by the time it ended", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 995, 100]]);
    h.tick();
    h.set([["bid", 996, 0], ["bid", 997, 0], ["bid", 998, 0], ["bid", 999, 0], ["ask", 996, 5]]);
    h.set([["bid", 995, 80]]);
    h.tick();
    h.set([["ask", 996, 0], ["bid", 996, 5], ["bid", 997, 5], ["bid", 998, 5], ["bid", 999, 5]]);
    h.ticks(2);
    h.set([["bid", 995, 0]]);
    h.ticks(3);
    const [level] = h.wallAt(995);
    expect(level.endedBy).not.toBeNull();
    expect(level.detail).toMatchObject({ firstShrinkExact: true, reachedAtFirstShrink: true });
    expect(level.detail.endDistanceRows).toBeGreaterThan(0);
  });

  test("a first shrink far from price is not reached, and a shrink the event stream cannot see falls back to the column", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 980, 3]]);
    h.set([["bid", 980, 100]]);
    h.tick();
    h.set([["bid", 980, 70]]);
    h.tick();
    const [level] = h.wallAt(980);
    expect(level.detail).toMatchObject({ firstShrinkExact: false, reachedAtFirstShrink: false });
    expect(level.detail.firstShrinkTs).toBe(Math.floor(T / 1_000) * 1_000 + 3_000);
  });

  test("a wall re-placed within 20 s of the last one ending carries continuity; 21 s does not", () => {
    const run = (gapS) => {
      const h = harness();
      h.tick();
      h.set([["bid", 990, 100]]);
      h.tick();
      h.set([["bid", 990, 0]]);
      const emptiedAt = h.tick();
      h.ticks(gapS - 1);
      h.set([["bid", 985, 60]]);
      const bornAt = h.tick();
      return { detail: h.wallAt(985)[0].detail, gap: bornAt - emptiedAt };
    };
    const near = run(20);
    expect(near.gap).toBe(20_000);
    expect(near.detail.continuity).toMatchObject({ gapMs: 20_000, prevId: expect.any(Number) });
    const far = run(21);
    expect(far.gap).toBe(21_000);
    expect(far.detail.continuity).toBeNull();
  });

  test("cross-side volume is aggression into the wall's side near mid, not on the wall and not away from mid", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 999, 100]]);
    h.tick();
    h.trade(999, 6, "sell");
    h.trade(998, 3, "sell");
    h.trade(997, 9, "sell");
    h.trade(1_001, 8, "buy");
    h.tick();
    const [level] = h.wallAt(999);
    expect(level.detail.crossSide).toBe(3);
    expect(level.detail.traded).toBe(6);
    expect(level.detail.absorbed).toBe(6);
    expect(level.detail.crossSideShare).toBeCloseTo(3 / 100, 10);
  });

  test("the first shrink is the earliest across all of the wall's rows", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100], ["bid", 991, 100]]);
    h.tick();
    h.set([["bid", 990, 90]]);
    const firstAt = h.tick();
    h.set([["bid", 991, 90]]);
    h.tick();
    const [level] = h.wallAt(990);
    expect(level.span).toBe(2);
    expect(level.detail.firstShrinkExact).toBe(true);
    expect(level.detail.firstShrinkTs).toBeGreaterThan(firstAt - 1_000);
    expect(level.detail.firstShrinkTs).toBeLessThan(firstAt);
  });

  test("repeat appearances on the same rows count within the trailing hour and not beyond", () => {
    const h = harness();
    h.tick();
    const cycle = () => {
      h.set([["bid", 990, 100]]);
      h.tick();
      const detail = h.wallAt(990).find((level) => level.endedBy === null).detail;
      h.set([["bid", 990, 5]]);
      h.ticks(3);
      return detail;
    };
    expect(cycle().repeats).toBe(1);
    h.ticks(30, 60_000);
    expect(cycle().repeats).toBe(2);
    h.ticks(40, 60_000);
    expect(cycle().repeats).toBe(2);
  });

  test("repeat counts say whether a full hour was watched; walls brought back from a store count towards them", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.tick();
    expect(h.wallAt(990)[0].detail).toMatchObject({ repeats: 1, repeatsComplete: false });
    h.set([["bid", 990, 5]]);
    h.ticks(3);
    const past = h.wallAt(990)[0];
    h.ticks(61, 60_000);
    h.set([["bid", 980, 100]]);
    h.tick();
    expect(h.wallAt(980)[0].detail).toMatchObject({ repeats: 1, repeatsComplete: true });

    const restored = harness();
    restored.service.adopt([{ ...past, startTs: restored.now() - 600_000, endTs: restored.now() - 590_000 }]);
    restored.tick();
    restored.set([["bid", 990, 100]]);
    restored.tick();
    const fresh = restored.service.levels().find((level) => level.row === 990 && level.endedBy === null);
    expect(fresh.detail).toMatchObject({ repeats: 2, repeatsComplete: false });
  });

  test("the events of the interval a wall is born in are credited to it at birth", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.trade(990, 7, "sell");
    h.tick();
    expect(h.wallAt(990)[0].detail).toMatchObject({ traded: 7, swept: 7 });
  });

  test("a column clock running ahead of the exchange clock does not hide a wall's first shrink", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    const ahead = h.now() + 5_000;
    h.columnAt(ahead);
    h.set([["bid", 990, 80]]);
    h.columnAt(ahead + 1_000);
    const [level] = h.wallAt(990);
    expect(level.startTs).toBe(ahead);
    expect(level.detail.firstShrinkExact).toBe(true);
    expect(level.detail.firstShrinkTs).toBeLessThan(ahead);
  });

  test("clear forgets every wall and its history; the tracker's readings pass straight through", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.ticks(2);
    expect(h.service.activeCount).toBe(1);
    expect(h.service.minSize).toBe(40);
    expect(h.service.threshold()).toBe(40);
    expect(h.service.reference).toBe(h.bare.reference);
    h.service.clear();
    expect(h.service.levels()).toEqual([]);
    expect(h.service.activeCount).toBe(0);
    h.set([["bid", 990, 5]]);
    h.tick();
    h.set([["bid", 990, 100]]);
    h.tick();
    expect(h.wallAt(990)[0].detail).toMatchObject({ repeats: 1, repeatsComplete: false, traded: 0 });
  });

  test("a malformed adopt throws before any evidence is kept", () => {
    const h = harness();
    expect(() => h.service.adopt("walls")).toThrow(/array/);
    expect(() => h.service.adopt([{ side: "mid", row: 1, span: 1, startTs: T, size: 1, peak: 1 }])).toThrow(/side/);
    expect(h.service.levels()).toEqual([]);
  });

  test("a wall swallowed by an older neighbour hands its evidence to the survivor", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.tick();
    h.set([["bid", 992, 100]]);
    h.tick();
    expect(h.service.levels().filter((level) => level.endedBy === null)).toHaveLength(2);
    h.trade(992, 7, "sell");
    h.set([["bid", 991, 30]]);
    h.tick();
    const resting = h.service.levels().filter((level) => level.endedBy === null);
    expect(resting).toHaveLength(1);
    expect(resting[0]).toMatchObject({ row: 990, span: 3 });
    expect(resting[0].detail.traded).toBe(7);
  });

  test("a lost book, a missed read and an adopted wall all mark the evidence as incomplete", () => {
    const gap = harness();
    gap.tick();
    gap.set([["bid", 990, 100]]);
    gap.tick();
    gap.unavailable();
    gap.ready();
    gap.tick();
    expect(gap.wallAt(990)[0].detail.evidenceGap).toBe(true);

    const missed = harness({ ledgerOptions: { eventCapacity: 4 } });
    missed.tick();
    missed.set([["bid", 990, 100]]);
    missed.tick();
    for (let i = 0; i < 6; i += 1) missed.trade(999, 1, "sell");
    missed.tick();
    expect(missed.wallAt(990)[0].detail.evidenceGap).toBe(true);

    const clean = harness();
    clean.tick();
    clean.set([["bid", 990, 100]]);
    clean.tick();
    clean.trade(990, 30, "sell");
    clean.set([["bid", 990, 0]]);
    clean.ticks(3);
    clean.set([["bid", 985, 100]]);
    clean.ticks(2);
    const ended = clean.wallAt(990)[0];
    const resting = clean.wallAt(985)[0];
    expect(ended.endedBy).not.toBeNull();
    expect(resting.endedBy).toBeNull();
    expect(ended.detail.evidenceGap).toBe(false);
    expect(resting.detail.evidenceGap).toBe(false);

    const restored = harness();
    restored.service.adopt([{ ...ended }, { ...resting }, { ...ended, row: 975, detail: undefined }]);
    const byRow = Object.fromEntries(restored.service.levels().map((level) => [level.row, level.detail]));
    expect(byRow[990]).toMatchObject({ evidenceGap: false, traded: 30 });
    expect(byRow[985]).toMatchObject({ evidenceGap: true });
    expect(byRow[975]).toMatchObject({ evidenceGap: true, traded: 0 });
  });

  test("the wire fields are exactly the tracker's, tick by tick", () => {
    const h = harness();
    h.tick();
    const script = [
      () => h.set([["bid", 990, 100]]),
      () => h.trade(990, 20, "sell"),
      () => h.set([["bid", 990, 60], ["ask", 1_008, 90]]),
      () => h.set([["bid", 990, 0]]),
      () => h.set([["ask", 1_008, 0], ["ask", 1_010, 85]]),
      () => h.trade(1_010, 40, "buy"),
    ];
    const wireOf = (level) => {
      const wire = { ...level };
      delete wire.detail;
      return wire;
    };
    for (const step of script) {
      step();
      h.tick();
      expect(h.service.levels().map(wireOf)).toEqual(h.bare.levels());
    }
    h.ticks(20);
    expect(h.service.levels().map(wireOf)).toEqual(h.bare.levels());
  });

  test("an engine is required", () => {
    expect(() => createWallService({ ...WALL_OPTIONS })).toThrow(/engine/);
  });
});

describe("wall service (report 61 P4a): the lifecycle log behind l2_events and the walls behind l2_walls", () => {
  function bestBidWall() {
    const h = harness();
    h.tick();
    h.set([["bid", 999, 100]]);
    h.tick();
    h.trade(999, 50, "sell");
    h.set([["bid", 999, 80]]);
    h.tick();
    h.set([["bid", 999, 0]]);
    h.ticks(3);
    return h;
  }

  test("one wall's life is logged in order: born, traded into, hidden fill, first shrink, end with its verdict", () => {
    const h = bestBidWall();
    const { records, dropped } = h.service.drainLifecycle();
    const [wall] = h.service.walls().filter((level) => level.row === 999);
    const own = records.filter((record) => record.wall === wall.id);
    const kinds = own.map((record) => record.kind);
    expect(dropped).toBe(0);
    expect(kinds[0]).toBe("wall_born");
    expect(kinds).toEqual(expect.arrayContaining(["wall_trade", "wall_hidden", "wall_shrink", "wall_end"]));
    expect(kinds.indexOf("wall_trade")).toBeLessThan(kinds.indexOf("wall_end"));
    expect(kinds[kinds.length - 1]).toBe("wall_end");
    expect(own.find((record) => record.kind === "wall_born")).toMatchObject({ side: "bid", row: 999, span: 1, size: 100 });
    expect(own.find((record) => record.kind === "wall_trade")).toMatchObject({ trade: "absorbed", price: 999, size: 50 });
    expect(own.find((record) => record.kind === "wall_hidden").volume).toBe(30);
    expect(own.find((record) => record.kind === "wall_shrink")).toMatchObject({
      exact: wall.detail.firstShrinkExact, reached: wall.detail.reachedAtFirstShrink, ts: wall.detail.firstShrinkTs,
    });
    expect(wall.detail.firstShrinkExact).toBe(true);
    expect(own.find((record) => record.kind === "wall_end")).toMatchObject({ endedBy: wall.endedBy, ts: wall.endTs });
    expect(own.filter((record) => record.kind === "wall_shrink")).toHaveLength(1);
    expect(own.filter((record) => record.kind === "wall_end")).toHaveLength(1);
  });

  test("draining empties the log, and clear forgets anything undrained", () => {
    const h = bestBidWall();
    expect(h.service.drainLifecycle().records.length).toBeGreaterThan(0);
    expect(h.service.drainLifecycle()).toEqual({ records: [], dropped: 0 });
    h.set([["bid", 990, 100]]);
    h.tick();
    h.service.clear();
    expect(h.service.drainLifecycle()).toEqual({ records: [], dropped: 0 });
  });

  test("an undrained log stops at its cap and counts what it dropped", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.tick();
    h.service.drainLifecycle();
    const trades = LIFECYCLE_CAP + 25;
    for (let i = 0; i < trades; i += 1) h.trade(990, 0.001, "sell");
    h.tick();
    const { records, dropped } = h.service.drainLifecycle();
    expect(records).toHaveLength(LIFECYCLE_CAP);
    expect(dropped).toBe(trades - LIFECYCLE_CAP + records.filter((record) => record.kind !== "wall_trade").length);
  });

  test("walls() is levels() with each wall's stable id, and the id is the one the log uses", () => {
    const h = bestBidWall();
    const records = h.service.drainLifecycle().records;
    const walls = h.service.walls();
    const withoutId = (wall) => {
      const rest = { ...wall };
      delete rest.id;
      return rest;
    };
    expect(walls.map(withoutId)).toEqual(h.service.levels());
    expect(new Set(walls.map((wall) => wall.id)).size).toBe(walls.length);
    for (const wall of walls) expect(Number.isSafeInteger(wall.id) && wall.id > 0).toBe(true);
    const born = records.filter((record) => record.kind === "wall_born").map((record) => record.wall);
    expect(walls.every((wall) => born.includes(wall.id))).toBe(true);
  });

  test("extend: an earlier birth from a replayed window moves the wall's life and its repeat count with it", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    h.tick();
    h.set([["bid", 990, 5]]);
    h.ticks(3);
    const first = h.wallAt(990)[0];
    expect(first.endedBy).not.toBeNull();
    h.set([["bid", 990, 100]]);
    const born = h.tick();
    const [second] = h.wallAt(990).filter((level) => level.endedBy === null);
    expect(second).toMatchObject({ startTs: born, detail: expect.objectContaining({ repeats: 2, lifeMs: 0, evidenceGap: false }) });
    expect(h.service.extend([{ side: "bid", row: 990, span: 1, startTs: first.startTs - 7_200_000, endTs: null, size: 100, peak: 100, endedBy: null }], { until: born, toleranceMs: 1_000 })).toHaveLength(1);
    const after = h.tick();
    const [moved] = h.wallAt(990).filter((level) => level.endedBy === null);
    expect(moved.startTs).toBe(first.startTs - 7_200_000);
    expect(moved.detail).toMatchObject({ repeats: 1, lifeMs: after - moved.startTs, evidenceGap: true });
    expect(h.service.extend([{ side: "ask", row: 990, span: 1, startTs: T - 1, endTs: null, size: 100, peak: 100, endedBy: null }], { until: born, toleranceMs: 1_000 })).toEqual([]);
  });

  test("onEnded hands over each wall the moment it ends, with its id, verdict and detail, once", () => {
    const seen = [];
    const engine = createMemoryEngine({ tickSize: 1 });
    engine.apply({ kind: "book", ts: T, status: "READY", book: { bids: [["990", "5"]], asks: [["1010", "5"]] } });
    expect(() => createWallService({ engine, onEnded: "x", ...WALL_OPTIONS })).toThrow(/onEnded/);
    const service = createWallService({ engine, onEnded: (wall) => seen.push(wall), ...WALL_OPTIONS });
    const column = (ts) => sampleLiquidityColumn(engine.liteSnapshot(), { ts, rowClusters: 1, windowRows: 40 });
    engine.apply({ kind: "book", ts: T + 10, status: "READY", book: { bestBid: 990, bestAsk: 1010 }, delta: { bids: [["990", "100"]], asks: [] } });
    service.update({ ts: T + 1_000, column: column(T + 1_000), snapshot: engine.liteSnapshot(), rowClusters: 1, referenceRows: 10 });
    expect(seen).toEqual([]);
    engine.apply({ kind: "book", ts: T + 1_010, status: "READY", book: { bestBid: 990, bestAsk: 1010 }, delta: { bids: [["990", "5"]], asks: [] } });
    for (let ts = T + 2_000; ts <= T + 4_000; ts += 1_000) service.update({ ts, column: column(ts), snapshot: engine.liteSnapshot(), rowClusters: 1, referenceRows: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 1, side: "bid", row: 990, endedBy: expect.any(String), endTs: expect.any(Number), detail: expect.objectContaining({ lifeMs: expect.any(Number) }) });
    expect(Object.isFrozen(seen[0])).toBe(true);
    for (let ts = T + 5_000; ts <= T + 7_000; ts += 1_000) service.update({ ts, column: column(ts), snapshot: engine.liteSnapshot(), rowClusters: 1, referenceRows: 10 });
    expect(seen).toHaveLength(1);
  });

  test("onTrades hands over the trades near the mid, with their row, aggressor and mode; onWallTrade the trades into a wall with the wall's side, rows and birth", () => {
    const trades = [];
    const wallTrades = [];
    const engine = createMemoryEngine({ tickSize: 1 });
    const book = { bid: new Map(), ask: new Map() };
    for (let i = 1; i <= 30; i += 1) {
      book.bid.set(MID - i, 5);
      book.ask.set(MID + i, 5);
    }
    const tuples = (side) => [...book[side].entries()].map(([price, size]) => [String(price), String(size)]);
    engine.apply({ kind: "book", ts: T, status: "READY", book: { bids: tuples("bid"), asks: tuples("ask") } });
    expect(() => createWallService({ engine, onTrades: 1, ...WALL_OPTIONS })).toThrow(/onTrades/);
    expect(() => createWallService({ engine, onWallTrade: 1, ...WALL_OPTIONS })).toThrow(/onWallTrade/);
    const service = createWallService({ engine, onTrades: (list) => trades.push(...list), onWallTrade: (trade) => wallTrades.push(trade), ...WALL_OPTIONS });
    const column = (ts) => sampleLiquidityColumn(engine.liteSnapshot(), { ts, rowClusters: 1, windowRows: 40 });
    const update = (ts) => service.update({ ts, column: column(ts), snapshot: engine.liteSnapshot(), rowClusters: 1, referenceRows: 10 });
    engine.apply({ kind: "book", ts: T + 10, status: "READY", book: { bestBid: MID - 1, bestAsk: MID + 1 }, delta: { bids: [[String(MID - 3), "100"]], asks: [] } });
    const born = T + 1_000;
    update(born);
    engine.apply({ kind: "trade", ts: T + 1_500, price: String(MID - 3), size: "4", side: "sell" });
    engine.apply({ kind: "trade", ts: T + 1_600, price: String(MID + 1), size: "1", side: "buy" });
    engine.apply({ kind: "trade", ts: T + 1_700, price: String(MID + 25), size: "1", side: "buy" });
    update(T + 2_000);
    expect(trades).toEqual([
      { ts: T + 1_500, row: MID - 3, aggressor: "sell", mode: "swept", size: 4 },
      { ts: T + 1_600, row: MID + 1, aggressor: "buy", mode: "absorbed", size: 1 },
    ]);
    expect(wallTrades).toEqual([{ ts: T + 1_500, wall: { side: "bid", row: MID - 3, span: 1, startTs: born }, mode: "swept", price: MID - 3, size: 4 }]);
    update(T + 3_000);
    expect(trades).toHaveLength(2);
    expect(wallTrades).toHaveLength(1);
  });

  test("a bounded-depth coverage exit retires only affected walls without a pulled verdict", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100], ["bid", 985, 100]]);
    h.tick();
    const lost = h.service.walls().find((wall) => wall.row === 990 && wall.endedBy === null);
    const kept = h.service.walls().find((wall) => wall.row === 985 && wall.endedBy === null);
    expect(lost).toBeDefined();
    expect(kept).toBeDefined();
    h.service.drainLifecycle();

    h.loseCoverage("bid", 990);
    h.trade(990, 5, "sell");
    h.tick();
    const first = h.service.drainLifecycle().records;
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "wall_unobserved", wall: lost.id, side: "bid", row: 990 }),
    ]));
    expect(first.some((event) => event.kind === "wall_end" && event.wall === lost.id)).toBe(false);
    expect(first.some((event) => event.kind === "wall_trade" && event.wall === lost.id)).toBe(false);
    expect(h.service.walls().some((wall) => wall.id === lost.id)).toBe(false);
    expect(h.service.walls().some((wall) => wall.id === kept.id && wall.endedBy === null)).toBe(true);

    h.ticks(16, 60_000);
    expect(h.service.walls().some((wall) => wall.id === lost.id)).toBe(false);
    expect(h.service.drainLifecycle().records.some((event) => event.kind === "wall_end" && event.wall === lost.id)).toBe(false);
  });
});
