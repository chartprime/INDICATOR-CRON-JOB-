const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { runBackfillInProcess } = require("../../../src/indicators/l2-memory/liquidity-backfill");
const { createDeepFolder } = require("../../../src/indicators/passive_liquidity/liquidity-history");
const { laneZeroGeometry, rowClustersFor, windowRowsFor } = require("../../../src/indicators/passive_liquidity/liquidity-geometry");
const {
  WINDOW_MS, LEVELS_MS, WINDOW_STATES, windowStart, foldLevels, windowState, windowCoverage, encodeWindow, decodeWindow,
} = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");
const { openPyramidStore, pairFileName } = require("../../../src/indicators/l2-memory/pyramid/pyramid-store");
const { BASE_LEVEL_MS } = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");
const { createPyramidReader } = require("../../../src/indicators/l2-memory/pyramid/pyramid-reader");
const { createPyramidBuilder, resolveGeometry, needsRepin, probePrice } = require("../../../src/indicators/l2-memory/pyramid/pyramid-builder");

const SYMBOL = "BTCUSDT";
const PERP = "PERPETUAL";
const T0 = windowStart(1_700_000_000_000) + WINDOW_MS;
const GEOMETRY = Object.freeze({ tickSize: 1, clusterTicks: 1, rowClusters: 1, windowRows: 6, sizeDigits: 4, snapshotDepth: -1, columnMs: 1_000, rowWidth: 1, replayWarmupMs: 30 * 60_000, rowBp: 0.5, windowBp: 600, referenceBp: 50 });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-test-"));
}

function openFixtureDb() {
  const storageDb = createStorageDb({ dbPath: ":memory:" });
  const db = storageDb.raw;
  const insertSnapshot = db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)");
  const insertEvent = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertTrade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return { db, insertSnapshot, insertEvent, insertTrade, close: () => storageDb.close() };
}

function levels(map, descending) {
  return [...map.entries()].filter(([, size]) => size > 0).sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0])).map(([price, size]) => [price.toFixed(1), size.toFixed(1)]);
}

function seedSeries(fixture, { from, until, snapshotsAt = [] }) {
  const book = { bids: new Map([[100, 5], [99, 2], [98, 4], [97, 1]]), asks: new Map([[101, 3], [102, 1], [103, 6], [104, 2]]) };
  let u = 100;
  const snapshot = (ts) => fixture.insertSnapshot.run(ts, SYMBOL, PERP, u, JSON.stringify(levels(book.bids, true)), JSON.stringify(levels(book.asks, false)));
  snapshot(from - 90_000);
  const pending = [...snapshotsAt].sort((a, b) => a - b);
  let step = 0;
  let tradeId = 1;
  for (let ts = from - 89_000; ts < until; ts += 700) {
    while (pending.length > 0 && pending[0] <= ts) snapshot(pending.shift());
    step += 1;
    const bidSide = step % 2 === 0;
    const price = bidSide ? 100 - (step % 4) : 101 + (step % 4);
    const size = (step * 7) % 9;
    (bidSide ? book.bids : book.asks).set(price, size);
    const change = [[price.toFixed(1), size.toFixed(1)]];
    fixture.insertEvent.run(ts, ts + 5, SYMBOL, PERP, u, u + 1, u, JSON.stringify(bidSide ? change : []), JSON.stringify(bidSide ? [] : change));
    u += 1;
    if (step % 3 === 0) {
      fixture.insertTrade.run(ts - 1, SYMBOL, PERP, bidSide ? price : price, 0.5 + (step % 5) / 10, bidSide ? "sell" : "buy", tradeId);
      tradeId += 1;
    }
  }
}

function strip(column) {
  return { ts: column.ts, lo: column.lo, hi: column.hi, bid: Array.from(column.bid), ask: Array.from(column.ask), buy: column.buy, sell: column.sell, prints: column.prints, printsFloor: column.printsFloor };
}

function bookAndFlow(column) {
  const rest = strip(column);
  delete rest.prints;
  delete rest.printsFloor;
  return rest;
}

async function longRun(db, fromTs, toTs, warmupMs = 30 * 60_000) {
  const out = [];
  await runBackfillInProcess({
    db, symbol: SYMBOL, marketKind: PERP, fromTs: fromTs - warmupMs, toTs, columnMs: 1_000, foldMs: 10_000,
    rowClusters: GEOMETRY.rowClusters, windowRows: GEOMETRY.windowRows, sizeDigits: GEOMETRY.sizeDigits,
    tickSize: GEOMETRY.tickSize, clusterTicks: GEOMETRY.clusterTicks, snapshotDepth: Infinity,
    onColumn: (column) => { if (column.ts >= fromTs && column.ts < toTs) out.push(column); },
  });
  return out;
}

function column(ts, lo, bid, ask, extra = {}) {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask), ...extra };
}

describe("the browser's pyramid fixture", () => {
  test("the committed fixture is what the live runtime encodes today, constants included (closure audit, patterns R and AL)", () => {
    const { build, TARGET } = require("../../../scripts/bench/pyramid-page-fixture");
    expect(JSON.parse(fs.readFileSync(TARGET, "utf8"))).toEqual(JSON.parse(JSON.stringify(build())));
  });
});

describe("pyramid levels", () => {
  test("a full window folds to 30, 10, 5 and 1 columns, each level the fold of the 10 s level", () => {
    const base = [];
    for (let i = 0; i < 30; i += 1) base.push(Object.freeze(column(T0 + i * 10_000, 10 + (i % 3), [i % 7, 3, 1], [2, i % 5, 4], { buy: [[0, 1]], sell: [], prints: [], printsFloor: 0 })));
    const folded = foldLevels(base);
    expect(LEVELS_MS.map((levelMs) => folded.get(levelMs).length)).toEqual([30, 10, 5, 1]);
    expect(folded.get(10_000).map(strip)).toEqual(base.map(strip));
    for (const levelMs of LEVELS_MS.slice(1)) {
      const folder = createDeepFolder({ deepColumnMs: levelMs });
      const expected = [];
      for (const entry of base) { const done = folder.feed(entry); if (done) expected.push(done); }
      expected.push(folder.flush());
      expect(folded.get(levelMs).map(strip)).toEqual(expected.map(strip));
      for (const entry of folded.get(levelMs)) expect(entry.ts % levelMs).toBe(0);
    }
    const five = folded.get(300_000)[0];
    expect([five.lo, five.hi]).toEqual([10, 12]);
    expect(Array.from(five.bid)).toEqual([6, 6, 6]);
    expect(five.buy).toEqual([[0, 10], [1, 10], [2, 10]]);
  });

  test("a window's state says how many 10 s columns it holds", () => {
    expect(windowState(30)).toBe(WINDOW_STATES.COVERED);
    expect(windowState(12)).toBe(WINDOW_STATES.PARTIAL);
    expect(windowState(0)).toBe(WINDOW_STATES.NO_DATA);
  });

  test("COVERED requires every 10 s grid slot, not merely thirty samples", () => {
    const full = Array.from({ length: 30 }, (_, i) => ({ ts: T0 + i * 10_000 }));
    expect(windowCoverage(full, T0)).toBe(WINDOW_STATES.COVERED);
    expect(windowCoverage(full.slice(1), T0)).toBe(WINDOW_STATES.PARTIAL);
    expect(windowCoverage([...full.slice(0, 29), full[28]], T0)).toBe(WINDOW_STATES.PARTIAL);
    expect(windowCoverage([...full, full[29]], T0)).toBe(WINDOW_STATES.PARTIAL);
  });

  test("a window encodes as a chain from its own first column, so every window decodes alone", () => {
    const base = [column(T0, 10, [1, 2, 3], [0, 0, 1]), column(T0 + 10_000, 11, [2, 3, 0], [1, 0, 0])];
    const wires = encodeWindow(base);
    expect(wires[0].bid).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(decodeWindow(JSON.parse(JSON.stringify(wires))).map(strip)).toEqual(base.map(strip));
  });
});

describe("pyramid store", () => {
  const levelsFor = (ts, count = 30) => foldLevels(Array.from({ length: count }, (_, i) => Object.freeze(column(ts + i * 10_000, 10, [i, 1], [1, i]))));

  test("stores a window's levels atomically and pages them back decoded, oldest first, within a byte budget", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin(GEOMETRY);
    for (let w = 0; w < 4; w += 1) store.putWindow({ windowTs: T0 + w * WINDOW_MS, state: "COVERED", columns: 30, frames: 100, builtAt: 1, levels: levelsFor(T0 + w * WINDOW_MS) });
    const reader = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    const all = reader.readPage({ levelMs: 30_000, fromTs: T0 + 1, toTs: T0 + 4 * WINDOW_MS, maxBytes: 1e9 });
    expect(all.windows.map((w) => w.ts)).toEqual([0, 1, 2, 3].map((w) => T0 + w * WINDOW_MS));
    expect(all.next).toBeNull();
    expect(decodeWindow(all.windows[1].columns).map(strip)).toEqual(levelsFor(T0 + WINDOW_MS).get(30_000).map(strip));
    const firstBytes = JSON.stringify(all.windows[0].columns).length;
    const paged = reader.readPage({ levelMs: 30_000, fromTs: T0, toTs: T0 + 4 * WINDOW_MS, maxBytes: firstBytes * 2 + 1 });
    expect(paged.windows.map((w) => w.ts)).toEqual([T0, T0 + WINDOW_MS]);
    expect(paged.next).toBe(T0 + 2 * WINDOW_MS);
    expect(reader.readPage({ levelMs: 30_000, fromTs: T0, toTs: T0 + WINDOW_MS, maxBytes: 1 }).windows).toHaveLength(1);
    expect(() => reader.putWindow({ windowTs: T0, state: "COVERED", columns: 0, frames: 0, builtAt: 1, levels: new Map() })).toThrow(/read-only/);
    reader.close();
    store.close();
  });

  test("a window with no data is stored as a hole, not as missing, and pages back with no columns", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.putWindow({ windowTs: T0, state: "NO_DATA", columns: 0, frames: 0, builtAt: 1, levels: foldLevels([]) });
    expect(store.readPage({ levelMs: 10_000, fromTs: T0, toTs: T0 + WINDOW_MS, maxBytes: 1e6 }).windows).toEqual([{ ts: T0, state: "NO_DATA", columns: [] }]);
    expect(store.readPage({ levelMs: 10_000, fromTs: T0 + WINDOW_MS, toTs: T0 + 2 * WINDOW_MS, maxBytes: 1e6 }).windows).toEqual([]);
    store.close();
  });

  test("a rewrite replaces a window whole, and a column outside its window is refused before anything is written", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.putWindow({ windowTs: T0, state: "COVERED", columns: 30, frames: 9, builtAt: 1, levels: levelsFor(T0) });
    store.putWindow({ windowTs: T0, state: "PARTIAL", columns: 3, frames: 9, builtAt: 2, levels: levelsFor(T0, 3) });
    expect(store.stats().levels.map((l) => [l.levelMs, l.columns])).toEqual([[10_000, 3], [30_000, 1], [60_000, 1], [300_000, 1]]);
    const outside = new Map([[10_000, [Object.freeze(column(T0 + WINDOW_MS, 10, [1], [1]))]]]);
    expect(() => store.putWindow({ windowTs: T0, state: "COVERED", columns: 1, frames: 1, builtAt: 3, levels: outside })).toThrow(/outside/);
    expect(store.windowRecords(T0, T0 + WINDOW_MS)).toEqual([{ ts: T0, state: "PARTIAL", columns: 3, frames: 9, reason: null, builtAt: 2 }]);
    store.close();
  });

  test("pinning the same geometry keeps the windows; a new geometry wipes them, so no page mixes grids", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    expect(store.pin(GEOMETRY)).toBe(true);
    const firstGeneration = store.generation();
    expect(firstGeneration).toMatch(/^[0-9a-f-]{36}$/);
    store.putWindow({ windowTs: T0, state: "COVERED", columns: 30, frames: 9, builtAt: 1, levels: levelsFor(T0) });
    expect(store.pin({ ...GEOMETRY })).toBe(false);
    expect(store.generation()).toBe(firstGeneration);
    expect(store.stats().windows).toBe(1);
    expect(store.pin({ ...GEOMETRY, rowClusters: 2 })).toBe(true);
    expect(store.generation()).not.toBe(firstGeneration);
    expect(store.stats().windows).toBe(0);
    expect(store.geometry().rowClusters).toBe(2);
    store.putWindow({ windowTs: T0, state: "COVERED", columns: 30, frames: 9, builtAt: 1, levels: levelsFor(T0) });
    expect(store.pin({ ...GEOMETRY, rowClusters: 2, replayWarmupMs: 60 * 60_000 })).toBe(true);
    expect(store.stats().windows).toBe(0);
    expect(store.geometry().replayWarmupMs).toBe(60 * 60_000);
    store.close();
  });

  test("the reader returns a consistent generation and rows across a re-pin", () => {
    const dir = tempDir();
    const pairKey = "binance:PERPETUAL:BTCUSDT";
    const store = openPyramidStore({ dir, pairKey });
    store.pin(GEOMETRY);
    store.putWindow({ windowTs: T0, state: "COVERED", columns: 30, frames: 1, builtAt: 1, levels: levelsFor(T0) });
    const reader = createPyramidReader({ dir });
    const options = { levelMs: 10_000, fromTs: T0, toTs: T0 + WINDOW_MS };
    const first = reader.readHeatmapColumns("binance", SYMBOL, PERP, options);
    expect(first.generation).toBe(store.generation());
    expect(first.windows).toHaveLength(1);
    store.pin({ ...GEOMETRY, rowClusters: 2, rowWidth: 2 });
    const second = reader.readHeatmapColumns("binance", SYMBOL, PERP, options);
    expect(second.generation).toBe(store.generation());
    expect(second.generation).not.toBe(first.generation);
    expect(second.geometry.rowWidth).toBe(2);
    expect(second.windows).toHaveLength(0);
    reader.close();
    store.close();
  });

  test("rewrites and prunes find a window's levels by key, never by scanning every stored level (closure audit, pattern AT)", () => {
    const { DELETE_LEVELS_SQL, PRUNE_LEVELS_SQL } = require("../../../src/indicators/l2-memory/pyramid/pyramid-store");
    const Database = require("better-sqlite3");
    const dir = tempDir();
    openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" }).close();
    const db = new Database(path.join(dir, pairFileName("binance:PERPETUAL:BTCUSDT")), { readonly: true });
    for (const sql of [DELETE_LEVELS_SQL, PRUNE_LEVELS_SQL]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(10_000, T0).map((row) => row.detail).join(" | ");
      expect(plan).toMatch(/^SEARCH levels USING PRIMARY KEY \(level_ms=\? AND window_ts/);
    }
    db.close();
  });

  test("prune drops whole windows older than the cutoff, levels with them", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    for (let w = 0; w < 3; w += 1) store.putWindow({ windowTs: T0 + w * WINDOW_MS, state: "COVERED", columns: 30, frames: 9, builtAt: 1, levels: levelsFor(T0 + w * WINDOW_MS) });
    expect(store.prune(T0 + WINDOW_MS + 1)).toBe(1);
    expect(store.windowRecords(0, T0 + 10 * WINDOW_MS).map((r) => r.ts)).toEqual([T0 + WINDOW_MS, T0 + 2 * WINDOW_MS]);
    expect(store.stats().levels.every((l) => l.windows === 2)).toBe(true);
    store.close();
  });

  test("a store that does not exist opens read-only as null, and file names never leave the directory", () => {
    expect(openPyramidStore({ dir: tempDir(), pairKey: "dxfeed:FUTURE:/NQZ26:XCME", readonly: true })).toBeNull();
    expect(pairFileName("dxfeed:FUTURE:/NQZ26:XCME")).toBe("dxfeed_FUTURE__NQZ26_XCME.sqlite");
    expect(() => pairFileName("../../etc/passwd x")).toThrow(/pair key/);
  });
});

describe("pyramid geometry", () => {
  test("pins the same lane-0 geometry the live publisher derives from a price", () => {
    const pinned = resolveGeometry({ price: 60_000, tickSize: 0.1, clusterTicks: 5, rowBp: 0.5, windowBp: 600, referenceBp: 50, sizeDigits: 4, snapshotDepth: 1000 });
    const live = laneZeroGeometry({ price: 60_000, clusterWidth: 0.1 * 5, rowBp: 0.5, windowBp: 600, referenceBp: 50 });
    expect([pinned.rowClusters, pinned.rowWidth, pinned.windowRows]).toEqual([live.rowClusters, live.rowWidth, live.windowRows]);
    expect(live.rowClusters).toBe(rowClustersFor(60_000, 0.5, 0.5));
    expect(live.windowRows).toBe(windowRowsFor(60_000, live.rowWidth, 600));
    expect(live.referenceRows).toBe(windowRowsFor(60_000, live.rowWidth, 50));
    expect(live.referenceRows).not.toBe(live.windowRows);
    const fixed = resolveGeometry({ price: 20_000, tickSize: 0.25, clusterTicks: 1, fixedRows: 1, rowBp: 0.5, windowBp: 600, referenceBp: 50, sizeDigits: 4, snapshotDepth: Infinity });
    expect([fixed.rowClusters, fixed.rowWidth, fixed.snapshotDepth, fixed.fixedRows]).toEqual([1, 0.25, -1, 1]);
  });

  test("re-pins only when the price moved the row width more than twofold, or the configuration changed", () => {
    const at = (price, extra = {}) => resolveGeometry({ price, tickSize: 0.1, clusterTicks: 5, rowBp: 0.5, windowBp: 600, referenceBp: 50, sizeDigits: 4, snapshotDepth: 1000, ...extra });
    const pinned = at(60_000);
    expect(needsRepin(null, pinned, 0.5)).toBe(true);
    expect(needsRepin(pinned, at(66_000), 0.5)).toBe(false);
    expect(needsRepin(pinned, at(115_000), 0.5)).toBe(false);
    expect(needsRepin(pinned, at(125_000), 0.5)).toBe(true);
    expect(needsRepin(pinned, at(28_000), 0.5)).toBe(false);
    expect(needsRepin(pinned, at(20_000), 0.5)).toBe(true);
    expect(needsRepin(pinned, at(60_000, { clusterTicks: 10 }), 0.5)).toBe(true);
    expect(needsRepin(pinned, at(60_000, { replayWarmupMs: 60 * 60_000 }), 0.5)).toBe(true);
    expect(needsRepin(pinned, at(60_000, { windowBp: 300 }), 0.5)).toBe(true);
    const fixedPin = at(20_000, { fixedRows: 4 });
    expect(needsRepin(fixedPin, at(90_000, { fixedRows: 4 }), 0.5)).toBe(false);
    expect(needsRepin(fixedPin, at(20_000, { fixedRows: 2 }), 0.5)).toBe(true);
  });

  test("probes the price from the recording the way the live lane reads it", async () => {
    const fixture = openFixtureDb();
    seedSeries(fixture, { from: T0, until: T0 + 60_000 });
    const price = await probePrice({ pair: { symbol: SYMBOL, marketKind: PERP }, at: T0 + 30_000, tickSize: 1, clusterTicks: 1, sourceOptions: { db: fixture.db } });
    expect(price).toBeGreaterThanOrEqual(96);
    expect(price).toBeLessThanOrEqual(100);
    fixture.close();
  });
});

describe("pyramid builder", () => {
  const pair = { symbol: SYMBOL, marketKind: PERP };

  function builderOver(fixture, dir, extra = {}) {
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin(GEOMETRY);
    const builder = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: { db: fixture.db }, ...extra });
    return { store, builder };
  }

  test("builds each 5 min window with the book and flow one long replay produces over the same span; the prints kept follow the recent print history", async () => {
    const fixture = openFixtureDb();
    seedSeries(fixture, { from: T0, until: T0 + 3 * WINDOW_MS + 20_000, snapshotsAt: [T0 + 6 * 60_000, T0 + 11 * 60_000 + 500] });
    const { store, builder } = builderOver(fixture, tempDir());
    const outcomes = await builder.buildRun(T0, 3);
    expect(outcomes.map((o) => [o.windowTs, o.state, o.columns])).toEqual([0, 1, 2].map((w) => [T0 + w * WINDOW_MS, "COVERED", 30]));
    const expected = await longRun(fixture.db, T0, T0 + 3 * WINDOW_MS);
    expect(expected).toHaveLength(90);
    const built = store.readPage({ levelMs: 10_000, fromTs: T0, toTs: T0 + 3 * WINDOW_MS, maxBytes: 1e9 }).windows.flatMap((w) => decodeWindow(w.columns));
    expect(built.map(bookAndFlow)).toEqual(expected.map(bookAndFlow));
    for (let i = 0; i < built.length; i += 1) {
      const ids = new Set(expected[i].prints.map((print) => print.id));
      if (built[i].printsFloor <= expected[i].printsFloor) for (const print of expected[i].prints) expect(built[i].prints.map((p) => p.id)).toContain(print.id);
      else for (const print of built[i].prints) expect(ids.has(print.id)).toBe(true);
    }
    const fiveMinute = store.readPage({ levelMs: 300_000, fromTs: T0, toTs: T0 + 3 * WINDOW_MS, maxBytes: 1e9 }).windows.map((w) => decodeWindow(w.columns)[0]);
    expect(fiveMinute.map(bookAndFlow)).toEqual([0, 1, 2].map((w) => bookAndFlow(foldLevels(expected.slice(w * 30, w * 30 + 30)).get(300_000)[0])));
    store.close();
    fixture.close();
  });

  test("groups due windows into contiguous runs, newest first, capped in length, and holds a short run at the tail until it has waited long enough", () => {
    const fixture = openFixtureDb();
    const { store, builder } = builderOver(fixture, tempDir(), { maxRunWindows: 3, minTailWindows: 2, tailWaitMs: 15 * 60_000, lagMs: 60_000 });
    const at = T0 + 20 * WINDOW_MS + 90_000;
    const w = (n) => T0 + n * WINDOW_MS;
    expect(builder.runsOf([w(19), w(18), w(17), w(16), w(15), w(12), w(11)], at)).toEqual([[w(17), w(18), w(19)], [w(15), w(16)], [w(11), w(12)]]);
    expect(builder.runsOf([w(19)], at)).toEqual([]);
    expect(builder.runsOf([w(19)], T0 + 23 * WINDOW_MS)).toEqual([[w(19)]]);
    expect(builder.runsOf([w(19)], T0 + 20 * WINDOW_MS + 15 * 60_000)).toEqual([[w(19)]]);
    expect(builder.runsOf([w(10)], at)).toEqual([[w(10)]]);
    store.close();
    fixture.close();
  });

  test("without the warm-up a window would lose its first second, which is why the builder replays from before the run", async () => {
    const fixture = openFixtureDb();
    seedSeries(fixture, { from: T0, until: T0 + WINDOW_MS + 20_000 });
    const cold = await longRun(fixture.db, T0 + WINDOW_MS, T0 + 2 * WINDOW_MS, 0);
    const warm = await longRun(fixture.db, T0 + WINDOW_MS, T0 + 2 * WINDOW_MS);
    expect(warm.length).toBeGreaterThan(0);
    expect(cold.map(strip)).not.toEqual(warm.map(strip));
    fixture.close();
  });

  test("plans newest first, skips built windows, waits for the recording to pass a window unless it has settled, and never looks past retention", () => {
    const fixture = openFixtureDb();
    const dir = tempDir();
    let captured = T0 + 10 * WINDOW_MS;
    const { store, builder } = builderOver(fixture, dir, { captureLatestTs: () => captured, lagMs: 60_000, settleMs: 30 * 60_000, retentionMs: 6 * WINDOW_MS });
    const at = T0 + 10 * WINDOW_MS + 90_000;
    expect(builder.plan(at)).toEqual([9, 8, 7, 6, 5, 4].map((w) => T0 + w * WINDOW_MS));
    store.putWindow({ windowTs: T0 + 8 * WINDOW_MS, state: "NO_DATA", columns: 0, frames: 0, builtAt: 1, levels: new Map() });
    expect(builder.plan(at)).toEqual([9, 7, 6, 5, 4].map((w) => T0 + w * WINDOW_MS));
    captured = T0 + 7 * WINDOW_MS;
    expect(builder.plan(at)).toEqual([6, 5, 4].map((w) => T0 + w * WINDOW_MS));
    const margined = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: { db: fixture.db }, captureLatestTs: () => captured, captureMarginMs: 60_000, lagMs: 60_000, settleMs: 30 * 60_000, retentionMs: 6 * WINDOW_MS });
    expect(margined.plan(at)).toEqual([5, 4].map((w) => T0 + w * WINDOW_MS));
    captured = null;
    expect(builder.plan(at)).toEqual([]);
    const settling = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: { db: fixture.db }, captureLatestTs: () => null, lagMs: 60_000, settleMs: 2 * WINDOW_MS, retentionMs: 6 * WINDOW_MS });
    expect(settling.plan(at)).toEqual([7, 6, 5, 4].map((w) => T0 + w * WINDOW_MS));
    store.close();
    fixture.close();
  });

  test("a killed cycle resumes where it stopped: no window twice, none skipped, and the result equals one uninterrupted build", async () => {
    const fixture = openFixtureDb();
    seedSeries(fixture, { from: T0, until: T0 + 4 * WINDOW_MS + 20_000, snapshotsAt: [T0 + 7 * 60_000] });
    const at = T0 + 4 * WINDOW_MS + 120_000;
    const options = { captureLatestTs: () => T0 + 4 * WINDOW_MS + 20_000, retentionMs: 4 * WINDOW_MS + 60_000, now: () => at, maxRunWindows: 2, minTailWindows: 1 };
    const interrupted = builderOver(fixture, tempDir(), options);
    const first = await interrupted.builder.runCycle({ maxWindows: 2 });
    expect(first.built.map((b) => b.windowTs)).toEqual([T0 + 2 * WINDOW_MS, T0 + 3 * WINDOW_MS]);
    interrupted.store.close();
    const resumedStore = openPyramidStore({ dir: path.dirname(interrupted.store.file), pairKey: "binance:PERPETUAL:BTCUSDT" });
    const resumed = createPyramidBuilder({ store: resumedStore, pair, geometry: GEOMETRY, sourceOptions: { db: fixture.db }, ...options });
    const second = await resumed.runCycle();
    expect(second.built.map((b) => b.windowTs)).toEqual([T0, T0 + WINDOW_MS]);
    expect((await resumed.runCycle()).built).toEqual([]);
    const straight = builderOver(fixture, tempDir(), options);
    await straight.builder.runCycle();
    const pages = (store) => LEVELS_MS.map((levelMs) => store.readPage({ levelMs, fromTs: T0, toTs: T0 + 4 * WINDOW_MS, maxBytes: 1e9 }).windows);
    expect(pages(resumedStore)).toEqual(pages(straight.store));
    expect(resumedStore.windowRecords(T0, T0 + 4 * WINDOW_MS).map((r) => r.state)).toEqual(["COVERED", "COVERED", "COVERED", "COVERED"]);
    resumedStore.close();
    straight.store.close();
    fixture.close();
  });

  test("cycle budget limits windows even when a configured run is longer", async () => {
    const fixture = openFixtureDb();
    const at = T0 + 4 * WINDOW_MS + 120_000;
    const { store, builder } = builderOver(fixture, tempDir(), {
      now: () => at, captureLatestTs: () => at, retentionMs: 4 * WINDOW_MS + 60_000, minTailWindows: 1,
      maxRunWindows: 12,
      runBackfill: async ({ fromTs, toTs, onColumn }) => {
        for (let ts = Math.max(T0, fromTs); ts < toTs; ts += 10_000) onColumn(column(ts, 10, [1], [1]));
        return { frames: 1, reason: null };
      },
    });
    const first = await builder.runCycle({ maxWindows: 2 });
    expect(first.built.map((entry) => entry.windowTs)).toEqual([T0 + 2 * WINDOW_MS, T0 + 3 * WINDOW_MS]);
    expect((await builder.runCycle({ maxWindows: 2 })).built.map((entry) => entry.windowTs)).toEqual([T0, T0 + WINDOW_MS]);
    expect((await builder.runCycle({ maxWindows: 2 })).built).toEqual([]);
    store.close();
    fixture.close();
  });

  test("a window the recording does not reach is a hole, a failed replay retries after cooldown, and a missing database stops the builder", async () => {
    const fixture = openFixtureDb();
    seedSeries(fixture, { from: T0, until: T0 + WINDOW_MS + 20_000 });
    const { store, builder } = builderOver(fixture, tempDir());
    expect(await builder.buildWindow(T0 + 5 * WINDOW_MS)).toMatchObject({ state: "NO_DATA", columns: 0 });
    let at = T0 + 8 * WINDOW_MS + 60_000;
    const throwing = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: {}, now: () => at, failedRetryMs: 60_000, captureLatestTs: () => at, runBackfill: async () => { throw new Error("bad row"); } });
    expect(await throwing.buildWindow(T0 + 6 * WINDOW_MS)).toMatchObject({ state: "FAILED", reason: "REPLAY_FAILED: bad row" });
    expect(store.windowRecords(T0 + 6 * WINDOW_MS, T0 + 7 * WINDOW_MS)[0].state).toBe("FAILED");
    expect(throwing.plan(at)).not.toContain(T0 + 6 * WINDOW_MS);
    at += 60_000;
    expect(throwing.plan(at)).toContain(T0 + 6 * WINDOW_MS);
    const recovered = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: {}, now: () => at, runBackfill: async ({ fromTs, toTs, onColumn }) => {
      for (let ts = Math.max(T0 + 6 * WINDOW_MS, fromTs); ts < toTs; ts += 10_000) onColumn(column(ts, 10, [1], [1]));
      return { frames: 1, reason: null };
    } });
    expect(await recovered.buildWindow(T0 + 6 * WINDOW_MS)).toMatchObject({ state: "COVERED", columns: 30 });
    const missing = createPyramidBuilder({ store, pair, geometry: GEOMETRY, sourceOptions: { dbPath: path.join(os.tmpdir(), "no-such-capture.sqlite") } });
    await expect(missing.buildWindow(T0 + 7 * WINDOW_MS)).rejects.toThrow(/capture database is missing/);
    expect(store.windowRecords(T0 + 7 * WINDOW_MS, T0 + 8 * WINDOW_MS)).toEqual([]);
    store.close();
    fixture.close();
  });

  test("a settled hole is revisited once capture passes it, then remains settled", async () => {
    const fixture = openFixtureDb();
    let captured = T0 - WINDOW_MS;
    let at = T0 + 8 * WINDOW_MS;
    let replayColumns = 0;
    const { store, builder } = builderOver(fixture, tempDir(), {
      now: () => at, captureLatestTs: () => captured, retentionMs: 8 * WINDOW_MS,
      runBackfill: async ({ onColumn }) => {
        if (replayColumns > 0) for (let i = 0; i < replayColumns; i += 1) onColumn(column(T0 + i * 10_000, 10, [1], [1]));
        return { frames: replayColumns, reason: replayColumns > 0 ? null : "NO_DATA_IN_WINDOW" };
      },
    });
    expect(await builder.buildWindow(T0)).toMatchObject({ state: "NO_DATA" });
    expect(store.windowRecords(T0, T0 + WINDOW_MS)[0].reason).toBe("AWAITING_CAPTURE");
    expect(builder.plan(at)).not.toContain(T0);
    captured = T0 + WINDOW_MS + 1;
    expect(builder.plan(at)).toContain(T0);
    replayColumns = 30;
    expect(await builder.buildWindow(T0)).toMatchObject({ state: "COVERED" });
    at += WINDOW_MS;
    expect(builder.plan(at)).not.toContain(T0);
    store.close();
    fixture.close();
  });

  test("capture that catches up while a window replays does not settle the partial result the replay read", async () => {
    const fixture = openFixtureDb();
    let captured = T0 - WINDOW_MS;
    const { store, builder } = builderOver(fixture, tempDir(), {
      now: () => T0 + 8 * WINDOW_MS, captureLatestTs: () => captured,
      runBackfill: async () => {
        captured = T0 + 4 * WINDOW_MS;
        return { frames: 0, reason: "NO_DATA_IN_WINDOW" };
      },
    });
    expect(await builder.buildWindow(T0)).toMatchObject({ state: "NO_DATA", reason: "AWAITING_CAPTURE" });
    expect(store.windowRecords(T0, T0 + WINDOW_MS)[0].reason).toBe("AWAITING_CAPTURE");
    expect(builder.plan(T0 + 8 * WINDOW_MS)).toContain(T0);
    store.close();
    fixture.close();
  });

  test("a cycle prunes what fell out of retention before it builds", async () => {
    const fixture = openFixtureDb();
    const { store, builder } = builderOver(fixture, tempDir(), { retentionMs: 2 * WINDOW_MS, now: () => T0 + 10 * WINDOW_MS, captureLatestTs: () => null, settleMs: 0, minTailWindows: 1 });
    store.putWindow({ windowTs: T0, state: "NO_DATA", columns: 0, frames: 0, builtAt: 1, levels: new Map() });
    const cycle = await builder.runCycle();
    expect(cycle.pruned).toBe(1);
    expect(store.windowRecords(0, T0 + 20 * WINDOW_MS).map((r) => r.ts)).toEqual([T0 + 8 * WINDOW_MS]);
    store.close();
    fixture.close();
  });
});

describe("pyramid builder histories (P4e3 step 1): the tracker rides the replay", () => {
  const pair = { symbol: SYMBOL, marketKind: PERP };
  const TRACKER = Object.freeze({ minSize: 1, multiplier: 1.5, gapRows: 2, settleMs: 0, keepEndedMs: 1e9, deepKeepEndedMs: 1e9, maxLevels: 4_000 });
  const PINNED = Object.freeze({ ...GEOMETRY, pinnedPrice: 100 });
  const WARMUP = 30 * 60_000;
  const level = (side, row, startTs, endTs, endedBy) => ({ side, row, span: 1, startTs, endTs, size: endTs === null ? 5 : 0, peak: 5, endedBy, ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false });

  function fakeStore() {
    const puts = [];
    const standings = [];
    return { puts, standings, putWindow: (window) => { puts.push(window); return 0; }, putHistories: (histories) => { puts.push(histories); }, putStanding: (standing) => { standings.push(standing); }, windowRecords: () => [] };
  }

  test("each window keeps the walls that ended in it and its share of the folded events; the walls standing at the next run's seed go to the store with the seed time, the one born at this run's seed included; the warm-up's own walls and events are dropped", async () => {
    const store = fakeStore();
    const end = T0 + 2 * WINDOW_MS;
    const boundary = end - WARMUP;
    const walls = {
      seedBorn: level("bid", 3, T0 - WARMUP, T0 - 1_000, "pulled"),
      endedBeforeSeed: level("ask", 6, T0 - WARMUP, T0 - 1_400_000, "pulled"),
      first: level("bid", 4, T0 - 20_000, T0 + 100_000, "hit"),
      second: level("ask", 7, T0 + 10_000, T0 + WINDOW_MS + 50_000, "filled"),
      standingOld: level("ask", 8, T0 - 1_500_000, null, null),
      standingYoung: level("bid", 2, T0 + 20_000, null, null),
      endedAfterSeed: level("bid", 5, T0 - 1_700_000, T0 - 1_100_000, "moved"),
      endsNextRun: level("ask", 9, T0 + 30_000, end + 5, "pulled"),
    };
    const trade = (ts, row) => [ts, 10_000, row, "buy", "absorbed", 2, 1];
    const wallTrade = (ts) => [ts, "bid:4:1:" + (T0 - 20_000), "absorbed", 4, 1];
    const events = { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: [trade(T0 - 10_000, 5), trade(T0, 5), trade(T0 + WINDOW_MS + 290_000, 6), trade(end, 6)], wallTrades: [wallTrade(T0 - 5_000), wallTrade(T0 + 20_000)] };
    const seen = [];
    const builder = createPyramidBuilder({
      store, pair, geometry: PINNED, sourceOptions: {}, trackerOptions: TRACKER, now: () => end + 60_000,
      runBackfill: async (options) => {
        seen.push(options);
        for (let ts = Math.max(T0, options.fromTs); ts < options.toTs; ts += 10_000) options.onColumn(column(ts, 10, [1], [1]));
        return { frames: 7, reason: null, levels: Object.values(walls), aggressive: [], events };
      },
    });
    const outcomes = await builder.buildRun(T0, 2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ trackerOptions: TRACKER, referenceRows: 1, fromTs: T0 - WARMUP, toTs: end });
    expect(outcomes.map((o) => [o.windowTs, o.state, o.walls, o.events])).toEqual([[T0, "COVERED", 1, 2], [T0 + WINDOW_MS, "COVERED", 1, 1]]);
    expect(store.puts.map((w) => w.walls)).toEqual([[walls.first], [walls.second]]);
    expect(store.puts[0].events).toEqual({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: T0, until: T0 + WINDOW_MS }, trades: [trade(T0, 5)], wallTrades: [wallTrade(T0 + 20_000)] });
    expect(store.puts[1].events).toEqual({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: T0 + WINDOW_MS, until: end }, trades: [trade(T0 + WINDOW_MS + 290_000, 6)], wallTrades: [] });
    expect(store.standings).toEqual([{ until: boundary, toleranceMs: BASE_LEVEL_MS, walls: [walls.seedBorn, walls.standingOld, walls.endedAfterSeed] }]);
  });

  test("a failed replay stores the windows as failed with nothing behind them and hands nothing over; without tracker options the replay runs as before and the store sees no histories", async () => {
    const failing = fakeStore();
    const builder = createPyramidBuilder({ store: failing, pair, geometry: PINNED, sourceOptions: {}, trackerOptions: TRACKER, now: () => T0 + 3 * WINDOW_MS, runBackfill: async () => { throw new Error("bad row"); } });
    const outcomes = await builder.buildRun(T0, 1);
    expect(outcomes.map((o) => o.state)).toEqual(["FAILED"]);
    expect(failing.puts[0]).toMatchObject({ state: "FAILED", walls: [], events: null });
    expect(failing.standings).toEqual([]);

    const plain = fakeStore();
    const seen = [];
    const untracked = createPyramidBuilder({ store: { putWindow: plain.putWindow }, pair, geometry: GEOMETRY, sourceOptions: {}, now: () => T0 + 3 * WINDOW_MS, runBackfill: async (options) => { seen.push(options); return { frames: 1, reason: null, levels: [], aggressive: [] }; } });
    await untracked.buildRun(T0, 1);
    expect(seen[0]).not.toHaveProperty("trackerOptions");
    expect(plain.puts[0]).not.toHaveProperty("walls");
    expect(plain.puts[0]).not.toHaveProperty("events");
    expect(plain.standings).toEqual([]);

    expect(() => createPyramidBuilder({ store: { putWindow: () => 0 }, pair, geometry: PINNED, sourceOptions: {}, trackerOptions: TRACKER })).toThrow(/putStanding/);
    expect(() => createPyramidBuilder({ store: fakeStore(), pair, geometry: GEOMETRY, sourceOptions: {}, trackerOptions: TRACKER })).toThrow(/pinnedPrice/);
    expect(() => createPyramidBuilder({ store: fakeStore(), pair, geometry: PINNED, sourceOptions: {}, trackerOptions: "yes" })).toThrow(/trackerOptions/);
  });
});

describe("pyramid store histories (P4e3 step 2): walls and events beside the columns", () => {
  const PAIR = "binance:PERPETUAL:BTCUSDT";
  const wall = (side, row, startTs, endTs, extra = {}) => ({ side, row, span: 1, startTs, endTs, size: 0, peak: 5, endedBy: "hit", ratio: 2, chain: 0, fill: 0.5, eaten: 0.2, absorbing: false, ...extra });
  const eventsOf = (windowTs, trades = []) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: windowTs, until: windowTs + WINDOW_MS }, trades, wallTrades: [] });
  const levelsFor = (ts) => foldLevels([Object.freeze(column(ts, 10, [1, 1], [1, 1]))]);
  const put = (store, windowTs, extra) => store.putWindow({ windowTs, state: "PARTIAL", columns: 1, frames: 1, builtAt: 1, levels: levelsFor(windowTs), ...extra });
  const bare = (walls) => walls.map((entry) => {
    expect(Number.isSafeInteger(entry.id) && entry.id > 0).toBe(true);
    const copy = { ...entry };
    delete copy.id;
    return copy;
  });

  test("a window's walls and events are stored with it, replaced whole on a rewrite, read back by the time the walls ended and by window, counted, pruned and wiped with the windows; a window built without them says so", () => {
    const dir = tempDir();
    const store = openPyramidStore({ dir, pairKey: PAIR });
    store.pin(GEOMETRY);
    const a = wall("bid", 10, T0 - 50_000, T0 + 100_000);
    const b = wall("ask", 12, T0 + 10_000, T0 + 200_000, { detail: { traded: 3 } });
    const c = wall("bid", 11, T0 + WINDOW_MS, T0 + WINDOW_MS + 5_000);
    put(store, T0, { walls: [b, a], events: eventsOf(T0, [[T0, 10_000, 10, "buy", "absorbed", 2, 1]]) });
    put(store, T0 + WINDOW_MS, { walls: [c], events: eventsOf(T0 + WINDOW_MS) });
    put(store, T0 + 2 * WINDOW_MS, {});
    expect(store.historyWindows(T0, T0 + 3 * WINDOW_MS)).toEqual([T0, T0 + WINDOW_MS]);
    expect(store.windowRecords(T0 + 2 * WINDOW_MS, T0 + 3 * WINDOW_MS)).toEqual([{ ts: T0 + 2 * WINDOW_MS, state: "PARTIAL", columns: 1, frames: 1, reason: null, builtAt: 1 }]);
    const reader = openPyramidStore({ dir, pairKey: PAIR, readonly: true });
    const everything = reader.readWalls({ fromTs: T0, toTs: T0 + 2 * WINDOW_MS, limit: 10 });
    expect(bare(everything.walls)).toEqual([a, b, c]);
    expect(everything.next).toBeNull();
    expect(new Set(everything.walls.map((entry) => entry.id)).size).toBe(3);
    expect(bare(reader.readWalls({ fromTs: T0 + 150_000, toTs: T0 + 2 * WINDOW_MS, limit: 10 }).walls)).toEqual([b, c]);
    const paged = reader.readWalls({ fromTs: T0, toTs: T0 + 2 * WINDOW_MS, limit: 2 });
    expect(bare(paged.walls)).toEqual([a, b]);
    expect(paged.next.id).toBe(paged.walls[1].id);
    expect(bare(reader.readWalls({ fromTs: T0, toTs: T0 + 2 * WINDOW_MS, limit: 2, after: paged.next }).walls)).toEqual([c]);
    expect(reader.readEvents({ fromTs: T0, toTs: T0 + 3 * WINDOW_MS, maxBytes: 1e9 })).toEqual({ windows: [{ ts: T0, events: eventsOf(T0, [[T0, 10_000, 10, "buy", "absorbed", 2, 1]]) }, { ts: T0 + WINDOW_MS, events: eventsOf(T0 + WINDOW_MS) }], next: null });
    expect(reader.readEvents({ fromTs: T0, toTs: T0 + 3 * WINDOW_MS, maxBytes: 1 })).toEqual({ windows: [{ ts: T0, events: eventsOf(T0, [[T0, 10_000, 10, "buy", "absorbed", 2, 1]]) }], next: T0 + WINDOW_MS });
    expect(() => reader.putStanding({ until: T0, toleranceMs: 1, walls: [] })).toThrow(/read-only/);
    reader.close();
    expect(store.stats()).toMatchObject({ walls: 3, eventWindows: 2, standing: 0 });
    put(store, T0, { walls: [a], events: eventsOf(T0) });
    expect(bare(store.readWalls({ fromTs: T0, toTs: T0 + WINDOW_MS, limit: 10 }).walls)).toEqual([a]);
    expect(store.readEvents({ fromTs: T0, toTs: T0 + WINDOW_MS, maxBytes: 1e9 }).windows[0].events.trades).toEqual([]);
    put(store, T0, { walls: [], events: null });
    expect(store.historyWindows(T0, T0 + 3 * WINDOW_MS)).toEqual([T0 + WINDOW_MS]);
    expect(() => put(store, T0, { walls: [{ side: "up", row: 1, span: 1, startTs: T0, endTs: T0 }], events: null })).toThrow(/wall/);
    expect(() => put(store, T0, { walls: [], events: { trades: "x" } })).toThrow(/events/);
    store.putStanding({ until: T0 + 3 * WINDOW_MS, toleranceMs: 10_000, walls: [wall("bid", 10, T0, null)] });
    expect(store.stats()).toMatchObject({ walls: 1, eventWindows: 1, standing: 1 });
    expect(store.prune(T0 + 2 * WINDOW_MS + 1)).toBe(2);
    expect(store.stats()).toMatchObject({ walls: 0, eventWindows: 0, standing: 1 });
    expect(store.prune(T0 + 4 * WINDOW_MS)).toBe(1);
    expect(store.stats()).toMatchObject({ standing: 0 });
    put(store, T0, { walls: [a], events: eventsOf(T0) });
    store.putStanding({ until: T0, toleranceMs: 10_000, walls: [wall("bid", 10, T0 - WINDOW_MS, null)] });
    store.pin({ ...GEOMETRY, rowClusters: 2 });
    expect(store.stats()).toMatchObject({ windows: 0, walls: 0, eventWindows: 0, standing: 0 });
    store.close();
  });

  test("a size filter keeps walls worth at least minUsd or ending in an exempt outcome, in end order, with a cursor that stays right across the dropped walls, and refuses what it cannot answer", () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: PAIR });
    store.pin(GEOMETRY);
    const at = (offset, side, row, span, endedBy, peak) => wall(side, row, T0 + offset, T0 + offset + 5_000, { span, endedBy, peak });
    const walls = [
      at(10_000, "bid", 100, 1, "pulled", 5),
      at(20_000, "ask", 100, 2, "filled", 5),
      at(30_000, "bid", 10, 1, "pulled", 1),
      at(40_000, "bid", 10, 1, "partial", 1),
      at(50_000, "bid", 10, 1, "hit", 1),
      at(60_000, "ask", 200, 1, "moved", 4),
    ];
    put(store, T0, { walls, events: eventsOf(T0) });
    const range = { fromTs: T0, toTs: T0 + WINDOW_MS };
    const all = store.readWalls({ ...range, limit: 10 }).walls;
    const usd = (item) => item.peak * (item.row + item.span / 2) * GEOMETRY.rowWidth;
    const kept = (minUsd, outcomes = []) => all.filter((item) => usd(item) >= minUsd || outcomes.includes(item.endedBy));
    const exempt = ["filled", "partial"];
    const filtered = store.readWalls({ ...range, limit: 10, minUsd: 502, alwaysOutcomes: exempt });
    expect(filtered.walls).toEqual(kept(502, exempt));
    expect(filtered.walls.map((item) => item.endedBy)).toEqual(["pulled", "filled", "partial", "moved"]);
    expect(filtered.next).toBeNull();
    expect(store.readWalls({ ...range, limit: 10, minUsd: 502 }).walls).toEqual(kept(502));
    expect(store.readWalls({ ...range, limit: 10, minUsd: 502 }).walls.map((item) => item.endedBy)).toEqual(["pulled", "filled", "moved"]);
    expect(store.readWalls({ ...range, limit: 10, minUsd: 0 }).walls).toEqual(all);
    expect(store.readWalls({ ...range, limit: 10, minUsd: 1e9, alwaysOutcomes: [] }).walls).toEqual([]);
    expect(store.readWalls({ ...range, limit: 10, minUsd: 1e9, alwaysOutcomes: ["moved", "hit"] }).walls.map((item) => item.endedBy)).toEqual(["hit", "moved"]);
    const first = store.readWalls({ ...range, limit: 2, minUsd: 502, alwaysOutcomes: exempt });
    expect(first.walls.map((item) => item.endedBy)).toEqual(["pulled", "filled"]);
    expect(first.next).toEqual({ endTs: first.walls[1].endTs, id: expect.any(Number) });
    const second = store.readWalls({ ...range, limit: 2, minUsd: 502, alwaysOutcomes: exempt, after: first.next });
    expect(second.walls.map((item) => item.endedBy)).toEqual(["partial", "moved"]);
    expect(second.next).toBeNull();
    expect([...first.walls, ...second.walls]).toEqual(filtered.walls);
    expect(() => store.readWalls({ ...range, minUsd: -1 })).toThrow(/minUsd/);
    expect(() => store.readWalls({ ...range, minUsd: Number.NaN })).toThrow(/minUsd/);
    expect(() => store.readWalls({ ...range, minUsd: 1, alwaysOutcomes: ["lost"] })).toThrow(/outcome/);
    expect(() => store.readWalls({ ...range, alwaysOutcomes: exempt })).toThrow(/minUsd/);
    store.close();
  });

  test("size bands are the stored walls' dollar sizes at the 50th, 75th, 90th, 95th and 99th percentile, none for an empty store, and need the pinned row width", () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: PAIR });
    store.pin(GEOMETRY);
    expect(store.sizeBands(1)).toBeNull();
    const walls = Array.from({ length: 10 }, (_, index) => wall("bid", (9 - index) * 10, T0 + index * 1_000, T0 + index * 1_000 + 500, { peak: 1 }));
    put(store, T0, { walls, events: eventsOf(T0) });
    expect(store.sizeBands(1)).toEqual({ n: 10, p50: 50.5, p75: 70.5, p90: 90.5, p95: 90.5, p99: 90.5 });
    expect(store.sizeBands(4)).toEqual({ n: 10, p50: 202, p75: 282, p90: 362, p95: 362, p99: 362 });
    expect(() => store.sizeBands(0)).toThrow(/row width/);
    expect(() => store.sizeBands(-1)).toThrow(/row width/);
    store.close();
  });

  test("a hand-over list gives the walls born at that seed their earlier birth and peak, whichever arrives first, and a chain of runs passes the birth all the way down to the walls a later run saw", () => {
    const seedA = T0 + 2 * WINDOW_MS;
    const seedB = T0 + WINDOW_MS;
    const seedC = T0 - 3 * WINDOW_MS;
    const stored = (store) => bare(store.readWalls({ fromTs: 0, toTs: T0 + 10 * WINDOW_MS, limit: 10 }).walls);
    const x = wall("bid", 10, seedA + 2_000, seedA + 100_000, { peak: 5 });
    const other = wall("bid", 10, seedA + 60_000, seedA + 120_000);
    const askSide = wall("ask", 10, seedA + 2_000, seedA + 130_000);
    const farRow = wall("bid", 30, seedA + 2_000, seedA + 140_000);

    const seedZ = seedA + 4 * WINDOW_MS;
    const z = wall("bid", 10, seedZ + 500, seedZ + 90_000, { peak: 3 });
    const forward = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    put(forward, seedA, { walls: [x, other, askSide, farRow], events: eventsOf(seedA) });
    put(forward, seedZ, { walls: [z], events: eventsOf(seedZ) });
    forward.putStanding({ until: seedZ, toleranceMs: 10_000, walls: [wall("bid", 10, seedA + 2_000, null, { peak: 5 })] });
    expect(stored(forward)).toEqual([x, other, askSide, farRow, { ...z, startTs: seedA + 2_000, peak: 5 }]);
    forward.putStanding({ until: seedA, toleranceMs: 10_000, walls: [wall("bid", 9, seedB + 1_000, null, { span: 2, peak: 7, size: 6 })] });
    expect(stored(forward)).toEqual([{ ...x, startTs: seedB + 1_000, peak: 7 }, other, askSide, farRow, { ...z, startTs: seedB + 1_000, peak: 7 }]);
    forward.putStanding({ until: seedB, toleranceMs: 10_000, walls: [wall("bid", 10, seedC, null, { peak: 4 })] });
    expect(stored(forward)).toEqual([{ ...x, startTs: seedC, peak: 7 }, other, askSide, farRow, { ...z, startTs: seedC, peak: 7 }]);
    forward.close();

    const backward = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    backward.putStanding({ until: seedB, toleranceMs: 10_000, walls: [wall("bid", 10, seedC, null, { peak: 4 })] });
    backward.putStanding({ until: seedA, toleranceMs: 10_000, walls: [wall("bid", 9, seedB + 1_000, null, { span: 2, peak: 7, size: 6 })] });
    put(backward, seedA, { walls: [x, other, askSide, farRow], events: eventsOf(seedA) });
    expect(stored(backward)).toEqual([{ ...x, startTs: seedC, peak: 7 }, other, askSide, farRow]);
    backward.putStanding({ until: seedA, toleranceMs: 10_000, walls: [] });
    expect(backward.stats().standing).toBe(1);
    put(backward, seedA, { walls: [x], events: eventsOf(seedA) });
    expect(stored(backward)).toEqual([x]);
    backward.close();
  });

  test("the planner replays a window again when it was built without histories and the tracker is on, and leaves it alone once it has them or when the tracker is off", () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ ...GEOMETRY, pinnedPrice: 100 });
    const at = T0 + 3 * WINDOW_MS + 120_000;
    const pair = { symbol: SYMBOL, marketKind: PERP };
    put(store, T0, {});
    put(store, T0 + WINDOW_MS, { walls: [], events: eventsOf(T0 + WINDOW_MS) });
    const options = { store, pair, geometry: { ...GEOMETRY, pinnedPrice: 100 }, sourceOptions: {}, now: () => at, captureLatestTs: () => at, retentionMs: 3 * WINDOW_MS + 60_000, minTailWindows: 1 };
    const tracking = createPyramidBuilder({ ...options, trackerOptions: { minSize: 1, multiplier: 1, gapRows: 1, settleMs: 0, keepEndedMs: 1e9, deepKeepEndedMs: 1e9, maxLevels: 10 } });
    expect(tracking.plan(at)).toEqual([T0 + 2 * WINDOW_MS, T0]);
    expect(createPyramidBuilder(options).plan(at)).toEqual([T0 + 2 * WINDOW_MS]);
    put(store, T0, { walls: [], events: eventsOf(T0) });
    expect(tracking.plan(at)).toEqual([T0 + 2 * WINDOW_MS]);
    store.close();
  });

  test("putHistories writes a window's walls and events and leaves its columns as they were", () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin(GEOMETRY);
    const three = foldLevels([0, 1, 2].map((i) => Object.freeze(column(T0 + i * 10_000, 10, [1, 1], [1, 1]))));
    store.putWindow({ windowTs: T0, state: "PARTIAL", columns: 3, frames: 9, builtAt: 1, levels: three });
    store.putHistories({ windowTs: T0, walls: [wall("bid", 10, T0 - 50_000, T0 + 100_000)], events: eventsOf(T0) });
    expect(store.windowRecords(T0, T0 + WINDOW_MS)).toEqual([{ ts: T0, state: "PARTIAL", columns: 3, frames: 9, reason: null, builtAt: 1 }]);
    expect(store.readPage({ levelMs: 10_000, fromTs: T0, toTs: T0 + WINDOW_MS, maxBytes: 1e9 }).windows[0].columns).toHaveLength(3);
    expect(store.historyWindows(T0, T0 + WINDOW_MS)).toEqual([T0]);
    expect(store.readWalls({ fromTs: T0, toTs: T0 + WINDOW_MS, limit: 10 }).walls).toHaveLength(1);
    expect(() => store.putHistories({ windowTs: T0, walls: "x", events: null })).toThrow(/walls/);
    store.close();
  });

  test("a window rebuilt for its histories keeps its stored columns unless the new replay covers at least as well, and a failed rebuild leaves it alone and waits before trying again (PR #32 review)", async () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ ...GEOMETRY, pinnedPrice: 100 });
    const pair = { symbol: SYMBOL, marketKind: PERP };
    const tracker = { minSize: 1, multiplier: 1, gapRows: 1, settleMs: 0, keepEndedMs: 1e9, deepKeepEndedMs: 1e9, maxLevels: 10 };
    const storedAt = (windowTs) => foldLevels([0, 1, 2].map((i) => Object.freeze(column(windowTs + i * 10_000, 10, [5, 5], [5, 5]))));
    store.putWindow({ windowTs: T0, state: "PARTIAL", columns: 3, frames: 9, builtAt: 1, levels: storedAt(T0) });
    const events = { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: [[T0, 10_000, 10, "buy", "absorbed", 2, 1]], wallTrades: [] };
    let at = T0 + 3 * WINDOW_MS;
    const replay = (count, from = T0) => async (options) => { for (let i = 0; i < count; i += 1) options.onColumn(column(from + i * 10_000, 10, [1, 1], [1, 1])); return { frames: 1, reason: null, levels: [], aggressive: [], events }; };
    const builderWith = (runBackfill) => createPyramidBuilder({ store, pair, geometry: { ...GEOMETRY, pinnedPrice: 100 }, sourceOptions: {}, trackerOptions: tracker, now: () => at, captureLatestTs: () => at, failedRetryMs: 60_000, runBackfill });
    const worse = await builderWith(replay(1)).buildRun(T0, 1);
    expect(worse[0]).toMatchObject({ windowTs: T0, state: "PARTIAL", columns: 3, kept: true, events: 1 });
    expect(store.windowRecords(T0, T0 + WINDOW_MS)[0]).toMatchObject({ state: "PARTIAL", columns: 3, builtAt: 1 });
    expect(Array.from(store.readPage({ levelMs: 10_000, fromTs: T0, toTs: T0 + WINDOW_MS, maxBytes: 1e9 }).windows[0].columns)).toHaveLength(3);
    expect(store.historyWindows(T0, T0 + WINDOW_MS)).toEqual([T0]);
    expect(builderWith(replay(1)).plan(at)).not.toContain(T0);
    const better = await builderWith(replay(4)).buildRun(T0, 1);
    expect(better[0]).toMatchObject({ windowTs: T0, state: "PARTIAL", columns: 4 });
    expect(better[0].kept).toBeUndefined();
    expect(store.windowRecords(T0, T0 + WINDOW_MS)[0]).toMatchObject({ columns: 4, builtAt: at });
    store.putWindow({ windowTs: T0 + 2 * WINDOW_MS, state: "NO_DATA", columns: 0, frames: 0, builtAt: 1, levels: new Map() });
    const upgraded = await builderWith(replay(1, T0 + 2 * WINDOW_MS)).buildRun(T0 + 2 * WINDOW_MS, 1);
    expect(upgraded[0]).toMatchObject({ windowTs: T0 + 2 * WINDOW_MS, state: "PARTIAL", columns: 1 });
    expect(upgraded[0].kept).toBeUndefined();
    expect(store.windowRecords(T0 + 2 * WINDOW_MS, T0 + 3 * WINDOW_MS)[0]).toMatchObject({ state: "PARTIAL", columns: 1, builtAt: at });
    store.putWindow({ windowTs: T0 + WINDOW_MS, state: "COVERED", columns: 30, frames: 9, builtAt: 1, levels: storedAt(T0 + WINDOW_MS) });
    const failing = builderWith(async () => { throw new Error("bad row"); });
    const failed = await failing.buildRun(T0 + WINDOW_MS, 1);
    expect(failed[0]).toMatchObject({ windowTs: T0 + WINDOW_MS, state: "COVERED", columns: 30, kept: true, reason: expect.stringMatching(/REPLAY_FAILED/) });
    expect(store.windowRecords(T0 + WINDOW_MS, T0 + 2 * WINDOW_MS)[0]).toMatchObject({ state: "COVERED", columns: 30, builtAt: 1 });
    expect(store.historyWindows(T0 + WINDOW_MS, T0 + 2 * WINDOW_MS)).toEqual([]);
    expect(failing.plan(at)).not.toContain(T0 + WINDOW_MS);
    at += 60_000;
    expect(failing.plan(at)).toContain(T0 + WINDOW_MS);
    store.close();
  });

  test("a replay with the tracker on that returns no events is a failed run, never a window that reads as built", async () => {
    const store = openPyramidStore({ dir: tempDir(), pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ ...GEOMETRY, pinnedPrice: 100 });
    const builder = createPyramidBuilder({ store, pair: { symbol: SYMBOL, marketKind: PERP }, geometry: { ...GEOMETRY, pinnedPrice: 100 }, sourceOptions: {}, now: () => T0 + 3 * WINDOW_MS, trackerOptions: { minSize: 1, multiplier: 1, gapRows: 1, settleMs: 0, keepEndedMs: 1e9, deepKeepEndedMs: 1e9, maxLevels: 10 }, runBackfill: async () => ({ frames: 1, reason: null, levels: [], aggressive: [] }) });
    const outcomes = await builder.buildRun(T0, 1);
    expect(outcomes.map((o) => [o.state, o.reason])).toEqual([["FAILED", expect.stringMatching(/REPLAY_FAILED: .*no events/)]]);
    expect(store.historyWindows(T0, T0 + WINDOW_MS)).toEqual([]);
    store.close();
  });
});
