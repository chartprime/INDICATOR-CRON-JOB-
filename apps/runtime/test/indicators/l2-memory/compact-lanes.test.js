"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { lanesFor, laneWindowPctFor, DEFAULT_WINDOW_PCT, LANE_ROWS, MAX_LANES } = require("../../../src/indicators/l2-memory/compact/lane-geometry");
const { sampleLiquidityColumn, rowOf } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createLiquidityPublisher, liquidityOptionsFromEnv } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const { saveLiquidityHistory, saveLiquidityHistoryAsync, loadLiquidityHistory } = require("../../../src/indicators/l2-memory/liquidity-store");
const { dxfeedLiquidityFrame } = require("../../../src/server/frames");

const T = 1_780_000_000_000;
const PAIR = ["PERPETUAL", "BTCUSDT"];

function seededEngine() {
  const engine = createMemoryEngine({ tickSize: 1, clusterTicks: 1 });
  const bids = [];
  const asks = [];
  for (let i = 1; i <= 60; i += 1) {
    bids.push([String(100 - i), String(1 + (i % 7))]);
    asks.push([String(100 + i), String(2 + (i % 5))]);
  }
  engine.apply({ kind: "book", ts: T, status: "READY", book: { bids, asks } });
  return engine;
}

function publisherFor(engine, clock, options = {}) {
  return createLiquidityPublisher({
    memory: { getEngine: () => engine, rowClusters: () => 1 },
    backfillEnabled: false,
    storeEnabled: false,
    aggressiveEnabled: false,
    now: () => clock.at,
    log: () => {},
    ...options,
  });
}

function run21(publisher, clock, marketKind, symbol) {
  for (let i = 0; i < 21; i += 1) {
    clock.at += 1_000;
    publisher.tick(marketKind, symbol, clock.at);
  }
}

function run(publisher, clock, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    clock.at += 1_000;
    publisher.tick(...PAIR, clock.at);
  }
}

describe("lane geometry (report 61 P3c)", () => {
  test("each lane doubles the row height and the column time until the class window is reached", () => {
    const btc = lanesFor({ price: 77_962, rowClusters: 8, rowWidth: 4, windowRows: 1_023, windowPct: 7, columnMs: 1_000, deepColumnMs: 10_000 });
    expect(btc.map((lane) => [lane.k, lane.rowClusters, lane.rowWidth, lane.windowRows, lane.columnMs, lane.deepColumnMs])).toEqual([[1, 16, 8, LANE_ROWS, 2_000, 20_000]]);
    expect(btc[0].reachPct).toBeCloseTo(10.5, 1);
    const nq = lanesFor({ price: 29_501.75, rowClusters: 1, rowWidth: 0.25, windowRows: 1_023, windowPct: 3, columnMs: 1_000, deepColumnMs: 10_000 });
    expect(nq.map((lane) => [lane.k, lane.rowWidth, lane.columnMs])).toEqual([[1, 0.5, 2_000], [2, 1, 4_000]]);
    expect(nq[0].reachPct).toBeLessThan(3);
    expect(nq[1].reachPct).toBeGreaterThanOrEqual(3);
  });

  test("no lane when lane 0 already reaches the window, or when the inputs cannot say", () => {
    const base = { rowClusters: 1, rowWidth: 1, columnMs: 1_000, deepColumnMs: 10_000 };
    expect(lanesFor({ ...base, price: 100, windowRows: 7, windowPct: 7 })).toEqual([]);
    expect(lanesFor({ ...base, price: 100, windowRows: 6, windowPct: 7 })).toHaveLength(1);
    expect(lanesFor({ ...base, price: null, windowRows: 6, windowPct: 7 })).toEqual([]);
    expect(lanesFor({ ...base, price: 100, windowRows: 6, windowPct: null })).toEqual([]);
    expect(lanesFor({ ...base, price: 100, windowRows: 6, windowPct: 0 })).toEqual([]);
  });

  test("the pyramid stops at its cap", () => {
    expect(lanesFor({ price: 1e9, rowClusters: 1, rowWidth: 0.01, windowRows: 1, windowPct: 50, columnMs: 1_000, deepColumnMs: 10_000 })).toHaveLength(MAX_LANES);
  });

  test("class windows are crypto 7 %, futures and equities 3 %; a positive override wins", () => {
    expect(DEFAULT_WINDOW_PCT).toEqual({ SPOT: 7, PERPETUAL: 7, FUTURE: 3, EQUITY: 3 });
    expect(laneWindowPctFor("FUTURE", DEFAULT_WINDOW_PCT, null)).toBe(3);
    expect(laneWindowPctFor("SPOT", DEFAULT_WINDOW_PCT, 10)).toBe(10);
    expect(laneWindowPctFor("SPOT", DEFAULT_WINDOW_PCT, Number.NaN)).toBe(7);
    expect(laneWindowPctFor("SPOT", null, null)).toBeNull();
    expect(laneWindowPctFor("OPTION", DEFAULT_WINDOW_PCT, null)).toBeNull();
  });
});

describe("lane sampling (report 61 P3c)", () => {
  test("unquantized, a lane row is exactly the sum of the two rows below it", () => {
    const engine = seededEngine();
    const snapshot = engine.liteSnapshot();
    const fine = sampleLiquidityColumn(snapshot, { ts: T, rowClusters: 3, windowRows: 40, sizeDigits: 15 });
    const coarse = sampleLiquidityColumn(snapshot, { ts: T, rowClusters: 6, windowRows: 40, sizeDigits: 15 });
    let checked = 0;
    for (let row = coarse.lo; row <= coarse.hi; row += 1) {
      const a = 2 * row;
      const b = 2 * row + 1;
      if (a < fine.lo || b > fine.hi) continue;
      for (const side of ["bid", "ask"]) {
        expect(coarse[side][row - coarse.lo]).toBe(fine[side][a - fine.lo] + fine[side][b - fine.lo]);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(15);
  });

  test("the publisher samples its lanes from the same snapshot, at 2 s columns and 2,047 rows", () => {
    const engine = seededEngine();
    const clock = { at: T };
    const publisher = publisherFor(engine, clock);
    run(publisher, clock, 11);
    const view = publisher.lanes(...PAIR);
    expect(view.windowPct).toBe(7);
    expect(view.lanes).toHaveLength(1);
    const [lane] = view.lanes;
    expect(lane).toMatchObject({ k: 1, rowClusters: 2, rowWidth: 2, windowRows: LANE_ROWS, columnMs: 2_000, deepColumnMs: 20_000 });
    expect(lane.recent.map((column) => column.ts)).toEqual([T, T + 2_000, T + 4_000, T + 6_000, T + 8_000]);
    expect(lane.recent.every((column) => column.hi - column.lo + 1 === 2 * LANE_ROWS + 1 || column.lo === 0)).toBe(true);
    expect(lane.sideBufferBytes).toBeGreaterThan(0);
    expect(publisher.lanes("SPOT", "NOPE")).toBeNull();
    publisher.stop();
  });

  test("a lane that fails to sample does not break the client's chain: the next frame starts over with a reset", () => {
    const engine = seededEngine();
    const clock = { at: T };
    const publisher = publisherFor(engine, clock);
    run(publisher, clock, 3);
    const state = publisher.activeStateForTests();
    const take = state.lanes[0].flow.take;
    state.lanes[0].flow = { ...state.lanes[0].flow, take: () => { throw new Error("lane sampling broke"); } };
    clock.at += 1_000;
    expect(() => publisher.tick(...PAIR, clock.at)).toThrow(/lane sampling broke/);
    state.lanes[0].flow = { ...state.lanes[0].flow, take };
    clock.at += 1_000;
    const next = publisher.tick(...PAIR, clock.at);
    expect(next.reset).toBe(true);
    publisher.stop();
  });

  test("a futures pair's lane holds each row's biggest tick, so a band reads the same as on lane 0; a crypto pair's lane still sums", () => {
    const expected = (snapshot, rowClusters, lo, hi, fold) => {
      const out = { bid: new Array(hi - lo + 1).fill(0), ask: new Array(hi - lo + 1).fill(0) };
      for (const [side, levels] of [["bid", snapshot.bids], ["ask", snapshot.asks]]) {
        for (const { key, size } of levels) {
          const row = rowOf(key, rowClusters);
          if (!(size > 0) || row < lo || row > hi) continue;
          out[side][row - lo] = fold === "max" ? Math.max(out[side][row - lo], size) : out[side][row - lo] + size;
        }
      }
      return out;
    };
    for (const [marketKind, symbol, fold] of [["FUTURE", "/NQZ26:XCME", "max"], ["PERPETUAL", "BTCUSDT", "sum"]]) {
      const engine = seededEngine();
      const clock = { at: T };
      const publisher = publisherFor(engine, clock, {
        memory: { getEngine: () => engine, rowClusters: () => 1, laneWindowPct: () => 7 },
        ...(marketKind === "FUTURE" ? { buildFrame: dxfeedLiquidityFrame } : {}),
      });
      for (let i = 0; i < 5; i += 1) {
        clock.at += 1_000;
        publisher.tick(marketKind, symbol, clock.at);
      }
      const [lane] = publisher.lanes(marketKind, symbol).lanes;
      expect(lane.rowClusters).toBe(2);
      const column = lane.recent[lane.recent.length - 1];
      const want = expected(engine.liteSnapshot(), lane.rowClusters, column.lo, column.hi, fold);
      expect([marketKind, Array.from(column.bid)]).toEqual([marketKind, want.bid]);
      expect([marketKind, Array.from(column.ask)]).toEqual([marketKind, want.ask]);
      // The seeded book differs from one tick to the next, so the two folds cannot agree by chance.
      expect(want.bid.some((value, i) => value !== expected(engine.liteSnapshot(), lane.rowClusters, column.lo, column.hi, fold === "max" ? "sum" : "max").bid[i])).toBe(true);
      publisher.stop();
    }
  });

  test("lanes switch off by environment, and the binding can widen a pair's window", () => {
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_LANES: "0" })).toMatchObject({ laneWindowPct: null });
    expect(liquidityOptionsFromEnv({})).not.toHaveProperty("laneWindowPct");
    const off = publisherFor(seededEngine(), { at: T }, { laneWindowPct: null });
    const offClock = { at: T };
    run(off, offClock, 2);
    expect(off.lanes(...PAIR).lanes).toEqual([]);
    const engine = seededEngine();
    const clock = { at: T };
    const wide = createLiquidityPublisher({
      memory: { getEngine: () => engine, rowClusters: () => 1, laneWindowPct: () => 5_000 },
      backfillEnabled: false, storeEnabled: false, aggressiveEnabled: false, now: () => clock.at, log: () => {},
    });
    run(wide, clock, 2);
    const view = wide.lanes(...PAIR);
    expect(view.windowPct).toBe(5_000);
    expect(view.lanes.length).toBeGreaterThan(1);
    expect(view.lanes[view.lanes.length - 1].reachPct).toBeGreaterThanOrEqual(5_000);
  });
});

describe("lanes rebuilt from the recording (report 61 P3c)", () => {
  test("the recent pass hands each lane its columns, which land in the lane's recent tier and fold into its deep tier", async () => {
    const engine = seededEngine();
    const clock = { at: T + 30_000 };
    const requests = [];
    const replayed = [];
    for (let second = 0; second < 30; second += 1) {
      const ts = T + second * 1_000;
      replayed.push(sampleLiquidityColumn(engine.liteSnapshot(), { ts, rowClusters: 2, windowRows: LANE_ROWS }));
    }
    const lanesFromRecording = [];
    for (let index = 0; index + 1 < replayed.length; index += 2) {
      const [a, b] = [replayed[index], replayed[index + 1]];
      lanesFromRecording.push({ ...a, bid: a.bid.map((value, i) => Math.max(value, b.bid[i])), ask: a.ask.map((value, i) => Math.max(value, b.ask[i])), buy: [], sell: [], prints: [] });
    }
    const publisher = publisherFor(engine, clock, {
      backfillEnabled: true,
      deepS: 0,
      backfill: async (request) => {
        requests.push(request);
        if (request.onLaneColumn) for (const column of lanesFromRecording) request.onLaneColumn(0, column);
        return { columns: 0, frames: 0, reason: null, stats: null, levels: [], aggressive: [] };
      },
    });
    publisher.tick(...PAIR, clock.at);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    run(publisher, clock, 1);
    expect(requests[0].lanes).toEqual([{ rowClusters: 2, windowRows: LANE_ROWS, factor: 2 }]);
    expect(typeof requests[0].onLaneColumn).toBe("function");
    const [lane] = publisher.lanes(...PAIR).lanes;
    expect(lane.recent.map((column) => column.ts)).toEqual(lanesFromRecording.map((column) => column.ts));
    publisher.stop();
  });
});

describe("lanes in the store (report 61 P3c)", () => {
  const made = [];
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  function storeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-store-"));
    made.push(dir);
    return dir;
  }

  function storedPublisher(engine, clock, dir) {
    return publisherFor(engine, clock, { storeEnabled: true, storeDir: dir, loadHistory: (request) => loadLiquidityHistory(request) });
  }

  test("lanes come back after a restart, column for column", () => {
    const dir = storeDir();
    const engine = seededEngine();
    const clock = { at: T };
    const first = storedPublisher(engine, clock, dir);
    run(first, clock, 21);
    const before = first.lanes(...PAIR).lanes[0];
    first.stop();
    expect(before.recent).toHaveLength(10);

    const second = storedPublisher(engine, clock, dir);
    clock.at += 500;
    second.tick(...PAIR, clock.at);
    const after = second.lanes(...PAIR).lanes[0];
    expect(after.recent.map((column) => column.ts)).toEqual(before.recent.map((column) => column.ts));
    expect(after.recent.map((column) => Array.from(column.bid))).toEqual(before.recent.map((column) => Array.from(column.bid)));
    expect(after.deep.map((column) => column.ts)).toEqual(before.deep.map((column) => column.ts));
    second.stop();
  });

  test("a file written before lanes existed still loads, and malformed lanes reject the file", () => {
    const dir = storeDir();
    const pairKey = "PERPETUAL:BTCUSDT";
    const geometry = { rowWidth: 1, rowClusters: 1, windowRows: 6, columnMs: 1_000, deepColumnMs: 10_000 };
    const recent = [{ ts: T, lo: 90, hi: 92, bid: [[0, 3]], ask: [] }];
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, savedAt: T }).ok).toBe(true);
    const plain = loadLiquidityHistory({ dir, pairKey, geometry, now: T });
    expect(plain).not.toBeNull();
    expect(plain).not.toHaveProperty("lanes");

    const lane = { k: 1, rowWidth: 2, rowClusters: 2, windowRows: 1_023, columnMs: 2_000, deepColumnMs: 20_000, recent, deep: [] };
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, lanes: [lane], savedAt: T }).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T }).lanes).toEqual([lane]);

    const reasons = [];
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, lanes: [{ ...lane, k: 0 }], savedAt: T }).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T, onReject: (reason) => reasons.push(reason) })).toBeNull();
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, lanes: [{ ...lane, recent: [{ ts: T, lo: 5, hi: 1 }] }], savedAt: T }).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T, onReject: (reason) => reasons.push(reason) })).toBeNull();
    expect(reasons).toEqual(["MALFORMED", "MALFORMED"]);
  });

  test("a stored lane whose geometry no longer matches is left out; lane 0 still restores", () => {
    const dir = storeDir();
    const engine = seededEngine();
    const clock = { at: T };
    const first = storedPublisher(engine, clock, dir);
    run(first, clock, 21);
    first.stop();
    const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    saved.lanes[0].rowWidth = 3;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(saved));

    const second = storedPublisher(engine, clock, dir);
    clock.at += 500;
    second.tick(...PAIR, clock.at);
    expect(second.activeState.length).toBeGreaterThan(15);
    expect(second.lanes(...PAIR).lanes[0].recent).toEqual([]);
    second.stop();
  });

  test("a lane is stored with its fold; one saved before folds existed restores only where rows were summed", () => {
    for (const [marketKind, symbol, fold, restores] of [["FUTURE", "/NQZ26:XCME", "max", false], ["PERPETUAL", "BTCUSDT", "sum", true]]) {
      const dir = storeDir();
      const engine = seededEngine();
      const clock = { at: T };
      const options = {
        memory: { getEngine: () => engine, rowClusters: () => 1, laneWindowPct: () => 7 },
        storeEnabled: true,
        storeDir: dir,
        loadHistory: (request) => loadLiquidityHistory(request),
        ...(marketKind === "FUTURE" ? { buildFrame: dxfeedLiquidityFrame } : {}),
      };
      const first = publisherFor(engine, clock, options);
      run21(first, clock, marketKind, symbol);
      first.stop();
      const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
      const saved = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      expect([marketKind, saved.lanes[0].fold]).toEqual([marketKind, fold]);

      const again = publisherFor(engine, clock, options);
      clock.at += 500;
      again.tick(marketKind, symbol, clock.at);
      expect([marketKind, again.lanes(marketKind, symbol).lanes[0].recent.length]).toEqual([marketKind, 10]);
      again.stop();

      delete saved.lanes[0].fold;
      fs.writeFileSync(path.join(dir, file), JSON.stringify(saved));
      const older = publisherFor(engine, clock, options);
      clock.at += 500;
      older.tick(marketKind, symbol, clock.at);
      expect([marketKind, older.lanes(marketKind, symbol).lanes[0].recent.length > 0]).toEqual([marketKind, restores]);
      older.stop();
    }
  });

  test("a lane with an unknown fold rejects the file", async () => {
    const dir = storeDir();
    const pairKey = "PERPETUAL:BTCUSDT";
    const geometry = { rowWidth: 1, rowClusters: 1, windowRows: 6, columnMs: 1_000, deepColumnMs: 10_000 };
    const recent = [{ ts: T, lo: 90, hi: 92, bid: [[0, 3]], ask: [] }];
    const lane = { k: 1, rowWidth: 2, rowClusters: 2, windowRows: 1_023, columnMs: 2_000, deepColumnMs: 20_000, fold: "max", recent, deep: [] };
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, lanes: [lane], savedAt: T }).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T }).lanes).toEqual([lane]);
    expect((await saveLiquidityHistoryAsync({ dir, pairKey, geometry, recent, lanes: [lane], savedAt: T })).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T }).lanes).toEqual([lane]);
    const reasons = [];
    expect(saveLiquidityHistory({ dir, pairKey, geometry, recent, lanes: [{ ...lane, fold: "mean" }], savedAt: T }).ok).toBe(true);
    expect(loadLiquidityHistory({ dir, pairKey, geometry, now: T, onReject: (reason) => reasons.push(reason) })).toBeNull();
    expect(reasons).toEqual(["MALFORMED"]);
  });
});
