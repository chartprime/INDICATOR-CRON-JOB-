const path = require("path");
const os = require("os");
const fs = require("fs");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { backfillLiquidity, runBackfillInProcess } = require("../../../src/indicators/l2-memory/liquidity-backfill");
const { createBackfillScheduler } = require("../../../src/indicators/l2-memory/liquidity-backfill-scheduler");
const { createReplaySource } = require("../../../src/indicators/l2-memory/replay-source");

const SYMBOL = "BTCUSDT";
const PERP = "PERPETUAL";
const T = 1_700_000_000_000;

function openFixtureDb(dbPath = ":memory:") {
  const storageDb = createStorageDb({ dbPath });
  const db = storageDb.raw;
  const insertSnapshot = db.prepare(
    "INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTrade = db.prepare(
    "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    db,
    snapshot: ({ capturedAt, lastUpdateId, bids, asks }) =>
      insertSnapshot.run(capturedAt, SYMBOL, PERP, lastUpdateId, JSON.stringify(bids), JSON.stringify(asks)),
    event: ({ ts, U, u, pu, bids = [], asks = [] }) =>
      insertEvent.run(ts, ts + 5, SYMBOL, PERP, U, u, pu, JSON.stringify(bids), JSON.stringify(asks)),
    trade: ({ ts, price, size, side, id }) => insertTrade.run(ts, SYMBOL, PERP, price, size, side, id),
    close: () => storageDb.close(),
  };
}

// Perpetual: the first diff must bridge the snapshot (U <= lastUpdateId <= u).
function seedBook(fixture) {
  fixture.snapshot({ capturedAt: T, lastUpdateId: 100, bids: [["100.0", "5.0"], ["99.0", "2.0"]], asks: [["101.0", "3.0"]] });
  fixture.event({ ts: T + 200, U: 100, u: 101, pu: 99, bids: [["100.0", "6.0"]] }); // bid grows to 6
  fixture.event({ ts: T + 1_500, U: 102, u: 102, pu: 101, asks: [["101.0", "0"]] }); // ask pulled
  fixture.trade({ ts: T + 2_100, price: 100, size: 1, side: "sell", id: 7 });
  fixture.event({ ts: T + 2_200, U: 103, u: 103, pu: 102, bids: [["100.0", "5.0"]] }); // bid eaten by 1
}

const GEOMETRY = { columnMs: 1_000, rowClusters: 1, windowRows: 5, tickSize: 1, clusterTicks: 1, snapshotDepth: 1000 };

describe("liquidity-backfill (in process)", () => {
  test("validates its arguments", async () => {
    await expect(runBackfillInProcess({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 1, dbPath: "x" })).rejects.toThrow(/onColumn/);
    await expect(runBackfillInProcess({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: 5, toTs: 1, dbPath: "x", onColumn: () => {} })).rejects.toThrow(/fromTs/);
    await expect(runBackfillInProcess({ ...GEOMETRY, columnMs: 0, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 1, dbPath: "x", onColumn: () => {} })).rejects.toThrow(/columnMs/);
  });

  test("a missing database file is nothing to do, not an error", async () => {
    const result = await runBackfillInProcess({
      ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 5_000,
      dbPath: path.join(os.tmpdir(), "does-not-exist-liquidity-backfill.sqlite"), onColumn: () => {},
    });
    expect(result).toEqual({ columns: 0, frames: 0, reason: "NO_DATABASE", stats: null, levels: [], aggressive: [] });
  });

  test("replays the stored book and samples one column per boundary with the live sampler's geometry", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000,
      onColumn: (column) => received.push(column),
    });
    fixture.close();
    expect(result.reason).toBeNull();
    expect(result.frames).toBeGreaterThan(0);
    // Boundaries T+1000, T+2000, T+3000 land inside the recording (last frame T+2200).
    expect(received.map((c) => c.ts)).toEqual([T + 1_000, T + 2_000, T + 3_000]);
    const at = (column, side, price) => column[side][price - column.lo];
    expect(at(received[0], "bid", 100)).toBe(6); // grew at T+200
    expect(at(received[0], "ask", 101)).toBe(3);
    expect(at(received[1], "ask", 101)).toBe(0); // pulled at T+1500
    expect(at(received[2], "bid", 100)).toBe(5); // eaten at T+2200
    expect(received[0].hi - received[0].lo).toBe(10); // windowRows 5 each side
    expect(result.columns).toBe(3);
    expect(result.levels).toEqual([]); // no tracker requested
  });

  test("accepts an async replay source without changing sampling semantics", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000,
      createSource: (sourceOptions) => {
        const local = createReplaySource({
          db: sourceOptions.db, symbol: sourceOptions.symbol, marketKind: sourceOptions.marketKind,
          fromTs: sourceOptions.fromTs, toTs: sourceOptions.toTs,
        });
        return {
          stats: local.stats,
          close: local.close,
          async *frames() {
            for (const frame of local.frames()) {
              await Promise.resolve();
              yield frame;
            }
          },
        };
      },
      onColumn: (column) => received.push(column),
    });
    fixture.close();
    expect(result).toMatchObject({ reason: null, columns: 3 });
    expect(received.map((column) => column.ts)).toEqual([T + 1_000, T + 2_000, T + 3_000]);
  });

  test("folds fine samples into deep windows that hold the largest size each row held, like the live deep tier", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    fixture.event({ ts: T + 10_500, U: 104, u: 104, pu: 103, asks: [["102.0", "1.0"]] });
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, foldMs: 10_000, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 12_000,
      onColumn: (column) => received.push(column),
    });
    fixture.close();
    expect(result.reason).toBeNull();
    expect(received.map((c) => c.ts)).toEqual([T]);
    expect(received[0].bid[100 - received[0].lo]).toBe(6);
    expect(result.columns).toBe(1);
    await expect(runBackfillInProcess({ ...GEOMETRY, foldMs: 1_500, dbPath: "x", symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 1, onColumn: () => {} })).rejects.toThrow(/foldMs/);
  });

  test("a history source of the caller's choosing feeds the rebuild instead of the collector's file", async () => {
    const frames = [
      { kind: "anchor", ts: T, lastUpdateId: 1 },
      { kind: "book", ts: T + 100, status: "READY", book: { bids: [["100", "5"]], asks: [["101", "3"]], lastUpdateId: 2 }, delta: { bids: [["100", "5"]], asks: [["101", "3"]] } },
      { kind: "book", ts: T + 1_500, status: "READY", book: { bids: [["100", "7"]], asks: [["101", "3"]], lastUpdateId: 3 }, delta: { bids: [["100", "7"]], asks: [] } },
    ];
    const close = jest.fn();
    const createSource = jest.fn(() => ({ frames: function* () { yield* frames; }, stats: { fake: true }, close }));
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, createSource, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 3_000,
      onColumn: (column) => received.push(column),
    });
    expect(createSource).toHaveBeenCalledWith(expect.objectContaining({ symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 3_000 }));
    expect(received.map((c) => c.ts)).toEqual([T + 1_000, T + 2_000]);
    expect(received[0].bid[100 - received[0].lo]).toBe(5);
    expect(received[1].bid[100 - received[1].lo]).toBe(7);
    expect(result).toMatchObject({ columns: 2, frames: 3, reason: null, stats: { fake: true } });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("tracks the walls alongside, so they come back with their real ages", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000,
      trackerOptions: { minSize: 4, multiplier: 0, gapRows: 0 },
      onColumn: () => {},
    });
    fixture.close();
    // Rows 99 (2.0) and 100 (6 then 5) each clear half the floor of 4 and together
    // clear it, so they are one wall spanning both, first seen at the first column.
    expect(result.levels).toEqual([
      expect.objectContaining({ side: "bid", row: 99, span: 2, startTs: T + 1_000, endTs: null, peak: 8, size: 7 }),
    ]);
  });

  test("with a tracker alongside, the trades near the mid and into its walls come back folded to the pass's column width", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000, foldMs: 2_000,
      trackerOptions: { minSize: 4, multiplier: 0, gapRows: 0 },
      onColumn: () => {},
    });
    fixture.close();
    expect(result.events).toMatchObject({ version: 1, columnMs: 1_000, deepColumnMs: 2_000, fill: null });
    expect(result.events.trades).toEqual([[T + 2_000, 2_000, 100, "sell", "absorbed", 1, 1]]);
    expect(result.events.wallTrades).toEqual([[T + 2_000, "bid:99:2:" + String(T + 1_000), "absorbed", 1, 1]]);
    const bare = await runBackfillInProcess({ ...GEOMETRY, createSource: () => ({ frames: function* () {}, stats: null, close() {} }), symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 1_000, onColumn: () => {} });
    expect(bare.events).toBeNull();
  });

  test("an aggressive-orders tracker runs alongside when asked, and its clusters come back with the columns", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 5_000,
      // One coin sold into the bid at 100: with a floor of 1 that is a seller bubble.
      aggressiveOptions: { floor: 1, gapBands: 0 },
      onColumn: () => {},
    });
    fixture.close();
    // The recording ends inside the cluster's gap, so it comes back still open
    // and the live tracker closes it from there.
    expect(result.aggressive).toEqual([
      expect.objectContaining({ side: "sell", row: 100, span: 1, volume: 1, peak: 1, floor: 1, endTs: null }),
    ]);
  });

  test("without aggressiveOptions no clusters are tracked", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 5_000, onColumn: () => {},
    });
    fixture.close();
    expect(result.aggressive).toEqual([]);
  });

  test("a window the recording does not reach reports NO_DATA_IN_WINDOW even when older tape exists", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T + 3_600_000, toTs: T + 3_660_000,
      onColumn: (column) => received.push(column),
    });
    fixture.close();
    expect(received).toEqual([]);
    expect(result).toMatchObject({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW" });
  });

  test("reports an empty window when the recording has nothing there, and never invents columns past its end", async () => {
    const fixture = openFixtureDb();
    seedBook(fixture);
    const received = [];
    const result = await runBackfillInProcess({
      ...GEOMETRY, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: T + 60_000, toTs: T + 120_000,
      onColumn: (column) => received.push(column),
    });
    fixture.close();
    expect(received).toEqual([]);
    expect(result.columns).toBe(0);
  });
});

describe("liquidity-backfill (worker thread)", () => {
  const made = [];
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixtureFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-backfill-"));
    made.push(dir);
    const dbPath = path.join(dir, "market-data.sqlite");
    const fixture = openFixtureDb(dbPath);
    seedBook(fixture);
    fixture.close();
    return dbPath;
  }

  test("the worker loads the history source named by module path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-source-"));
    made.push(dir);
    const sourceModule = path.join(dir, "fake-source.js");
    fs.writeFileSync(sourceModule, `
      "use strict";
      const T = ${T};
      function createSource() {
        return {
          frames: function* () {
            yield { kind: "anchor", ts: T, lastUpdateId: 1 };
            yield { kind: "book", ts: T + 100, status: "READY", book: { bids: [["100", "5"]], asks: [["101", "3"]], lastUpdateId: 2 }, delta: { bids: [["100", "5"]], asks: [["101", "3"]] } };
            yield { kind: "book", ts: T + 1_500, status: "READY", book: { bids: [["100", "7"]], asks: [["101", "3"]], lastUpdateId: 3 }, delta: { bids: [["100", "7"]], asks: [] } };
          },
          stats: { module: true },
          close() {},
        };
      }
      module.exports = { createSource };
    `);
    const received = [];
    const result = await backfillLiquidity({
      ...GEOMETRY, sourceModule, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 3_000,
      onColumn: (column) => received.push(column),
    });
    expect(received.map((c) => c.ts)).toEqual([T + 1_000, T + 2_000]);
    expect(result).toMatchObject({ columns: 2, frames: 3, reason: null, stats: { module: true } });
  });

  test("the worker samples every lane in the same pass and posts its columns back (report 61 P3c)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-lanes-"));
    made.push(dir);
    const sourceModule = path.join(dir, "fake-source.js");
    fs.writeFileSync(sourceModule, `
      "use strict";
      const T = ${T};
      function createSource() {
        return {
          frames: function* () {
            yield { kind: "book", ts: T + 100, status: "READY", book: { bids: [["100", "5"], ["99", "4"]], asks: [["101", "3"]], lastUpdateId: 2 }, delta: { bids: [["100", "5"], ["99", "4"]], asks: [["101", "3"]] } };
            yield { kind: "book", ts: T + 4_500, status: "READY", book: { bids: [["100", "7"], ["99", "4"]], asks: [["101", "3"]], lastUpdateId: 3 }, delta: { bids: [["100", "7"]], asks: [] } };
          },
          stats: null,
          close() {},
        };
      }
      module.exports = { createSource };
    `);
    const fine = [];
    const lanes = [];
    const result = await backfillLiquidity({
      ...GEOMETRY, sourceModule, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 6_000,
      lanes: [{ rowClusters: GEOMETRY.rowClusters * 2, windowRows: 4, factor: 2 }, { rowClusters: GEOMETRY.rowClusters * 4, windowRows: 3, factor: 4 }],
      onColumn: (column) => fine.push(column),
      onLaneColumn: (index, column) => lanes.push([index, column.ts, column.hi - column.lo + 1]),
    });
    expect(result.reason).toBeNull();
    expect(fine.length).toBeGreaterThan(3);
    expect(lanes.filter(([index]) => index === 0).map(([, ts, rows]) => [ts, rows])).toEqual([[T, 9], [T + 2_000, 9]]);
    expect(lanes.filter(([index]) => index === 1).map(([, ts, rows]) => [ts, rows])).toEqual([[T, 7]]);

    const dropped = await backfillLiquidity({
      ...GEOMETRY, sourceModule, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 6_000,
      lanes: [{ rowClusters: GEOMETRY.rowClusters * 2, windowRows: 4, factor: 2 }],
      onColumn: () => {},
    });
    expect(dropped.reason).toBeNull();
  });

  test("a rebuild folds a futures pair's lanes by the biggest tick and a crypto pair's by the sum, like the live lanes", async () => {
    // Bids 98 and 99 share a lane row of two ticks.
    const frames = [
      { kind: "anchor", ts: T, lastUpdateId: 1 },
      { kind: "book", ts: T + 100, status: "READY", book: { bids: [["99", "5"], ["98", "4"]], asks: [["101", "3"]], lastUpdateId: 2 }, delta: { bids: [["99", "5"], ["98", "4"]], asks: [["101", "3"]] } },
      { kind: "book", ts: T + 4_500, status: "READY", book: { bids: [["99", "5"], ["98", "4"]], asks: [["101", "3"]], lastUpdateId: 3 }, delta: { bids: [], asks: [] } },
    ];
    const laneRow = async (marketKind) => {
      const lanes = [];
      await runBackfillInProcess({
        ...GEOMETRY, symbol: SYMBOL, marketKind, fromTs: T, toTs: T + 6_000,
        createSource: () => ({ frames: function* () { yield* frames; }, stats: null, close() {} }),
        lanes: [{ rowClusters: 2, windowRows: 4, factor: 2 }],
        onColumn: () => {},
        onLaneColumn: (index, column) => lanes.push(column),
      });
      expect(lanes.length).toBeGreaterThan(0);
      const column = lanes[lanes.length - 1];
      return column.bid[49 - column.lo];
    };
    expect(await laneRow(PERP)).toBe(9);
    expect(await laneRow("FUTURE")).toBe(5);
  });

  test("a lane without a callback is refused in process, and a malformed lane is refused", async () => {
    const base = { ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 1_000, createSource: () => ({ frames: function* () {}, stats: null, close() {} }), onColumn: () => {} };
    await expect(runBackfillInProcess({ ...base, lanes: [{ rowClusters: 2, windowRows: 1, factor: 2 }] })).rejects.toThrow(/onLaneColumn/);
    await expect(runBackfillInProcess({ ...base, lanes: [{ rowClusters: 0, windowRows: 1, factor: 2 }], onLaneColumn: () => {} })).rejects.toThrow(/each lane/);
    await expect(runBackfillInProcess({ ...base, lanes: "all" })).rejects.toThrow(/lanes must be an array/);
  });

  test("a missing database resolves without starting a worker", async () => {
    const result = await backfillLiquidity({
      ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000,
      dbPath: path.join(os.tmpdir(), "nope-liquidity-backfill.sqlite"), onColumn: () => {},
    });
    expect(result).toEqual({ columns: 0, frames: 0, reason: "NO_DATABASE", stats: null, levels: [], aggressive: [] });
  });

  test("rejects bad arguments before spawning anything", async () => {
    await expect(backfillLiquidity({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 1, dbPath: "x" })).rejects.toThrow(/onColumn/);
    await expect(backfillLiquidity({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, fromTs: 9, toTs: 1, dbPath: "x", onColumn: () => {} })).rejects.toThrow(/fromTs/);
  });

  test("replays on a worker and delivers the same columns and walls, without blocking the caller", async () => {
    const dbPath = fixtureFile();
    const columns = [];
    // The event loop must keep turning while the worker grinds.
    let ticks = 0;
    const interval = setInterval(() => (ticks += 1), 1);
    const result = await backfillLiquidity({
      ...GEOMETRY, dbPath, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000,
      trackerOptions: { minSize: 4, multiplier: 0, gapRows: 0 },
      onColumn: (column) => columns.push(column),
    });
    clearInterval(interval);
    expect(result.reason).toBeNull();
    expect(result.columns).toBe(3);
    expect(columns.map((c) => c.ts)).toEqual([T + 1_000, T + 2_000, T + 3_000]);
    // Float64Arrays survive the thread hop.
    expect(columns[0].bid[100 - columns[0].lo]).toBe(6);
    expect(result.levels).toEqual([expect.objectContaining({ side: "bid", row: 99, span: 2, peak: 8 })]);
    expect(result.stats.snapshotsUsed).toBe(1);
    expect(ticks).toBeGreaterThan(0);
  }, 20_000);

  test("shouldContinue false stops the worker and reports it", async () => {
    const dbPath = fixtureFile();
    const result = await backfillLiquidity({
      ...GEOMETRY, dbPath, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000, batchColumns: 1,
      shouldContinue: () => false,
      onColumn: () => {},
    });
    expect(result.reason).toBe("CANCELLED");
  }, 20_000);

  test("contains a consumer failure from the worker message boundary instead of throwing from the relay event loop", async () => {
    const dbPath = fixtureFile();
    const result = await backfillLiquidity({
      ...GEOMETRY, dbPath, symbol: SYMBOL, marketKind: PERP, fromTs: T, toTs: T + 4_000, batchColumns: 1,
      onColumn: () => { throw new Error("history sink failed"); },
    });
    expect(result).toEqual(expect.objectContaining({
      columns: 0,
      frames: 0,
      reason: "DELIVERY_FAILED: history sink failed",
      levels: [],
      aggressive: [],
    }));
  }, 20_000);
});

describe("liquidity-backfill-scheduler (real worker, cancellation is real)", () => {
  const made = [];
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixtureFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-backfill-sched-"));
    made.push(dir);
    const dbPath = path.join(dir, "market-data.sqlite");
    const fixture = openFixtureDb(dbPath);
    seedBook(fixture);
    fixture.close();
    return dbPath;
  }

  // A generator whose body never returns from its first synchronous step:
  // `runBackfillInProcess`'s `for...of` over this never receives a first
  // frame, so the worker never posts a "columns" or "done" message and
  // never observes `shouldContinue`. Only a hard `worker.terminate()` can
  // end it -- exactly the case the scheduler must recover a slot from.
  function hangingSourceModule() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-hang-source-"));
    made.push(dir);
    const sourceModule = path.join(dir, "hanging-source.js");
    fs.writeFileSync(sourceModule, `
      "use strict";
      function createSource() {
        return {
          frames: function* () { while (true) {} },
          stats: {},
          close() {},
        };
      }
      module.exports = { createSource };
    `);
    return sourceModule;
  }

  // Report 57 W2, O-16: the timeout is shared by both passes, and the second
  // is a real worker doing a real backfill. At 300 ms its cold start alone
  // overran the budget when the machine was saturated (reproduced with the
  // conversion suite running in parallel), so the healthy pass timed out too.
  // The hung pass never finishes, so any finite budget still proves the kill.
  test("a genuinely hung worker is terminated on timeout, freeing the slot for the next queued pass without manual resolution", async () => {
    const hangModule = hangingSourceModule();
    const okDb = fixtureFile();
    const scheduler = createBackfillScheduler({
      backfill: (request) => backfillLiquidity({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, onColumn: () => {}, ...request }),
      maxWorkers: 1,
      timeoutMs: 2_000,
    });
    const a = scheduler.run({ key: "A", sourceModule: hangModule, fromTs: T, toTs: T + 4_000 });
    const b = scheduler.run({ key: "B", dbPath: okDb, fromTs: T, toTs: T + 4_000 });
    await expect(a).resolves.toMatchObject({ reason: "TIMEOUT" });
    await expect(b).resolves.toMatchObject({ reason: null, columns: 3 });
    expect(scheduler.stats()).toMatchObject({ running: 0, queued: 0, started: 2, completed: 1, timedOut: 1 });
  }, 20_000);

  test("cancel on a genuinely hung worker actually terminates it, not just marks it stopped", async () => {
    const hangModule = hangingSourceModule();
    const scheduler = createBackfillScheduler({
      backfill: (request) => backfillLiquidity({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, onColumn: () => {}, ...request }),
      maxWorkers: 1,
      timeoutMs: 60_000,
    });
    const okDb = fixtureFile();
    const a = scheduler.run({ key: "A", sourceModule: hangModule, fromTs: T, toTs: T + 4_000 });
    const b = scheduler.run({ key: "B", dbPath: okDb, fromTs: T, toTs: T + 4_000 });
    await new Promise((resolve) => setImmediate(resolve));
    scheduler.cancel("A");
    await expect(a).resolves.toMatchObject({ reason: "CANCELLED" });
    await expect(b).resolves.toMatchObject({ reason: null, columns: 3 });
    expect(scheduler.stats()).toMatchObject({ running: 0, queued: 0, cancelled: 1 });
  }, 20_000);

  test("dispose on a genuinely hung worker terminates it rather than leaving it running past shutdown", async () => {
    const hangModule = hangingSourceModule();
    const scheduler = createBackfillScheduler({
      backfill: (request) => backfillLiquidity({ ...GEOMETRY, symbol: SYMBOL, marketKind: PERP, onColumn: () => {}, ...request }),
      maxWorkers: 1,
      timeoutMs: 60_000,
    });
    const a = scheduler.run({ key: "A", sourceModule: hangModule, fromTs: T, toTs: T + 4_000 });
    await new Promise((resolve) => setImmediate(resolve));
    scheduler.dispose();
    await expect(a).resolves.toMatchObject({ reason: "CANCELLED" });
    expect(scheduler.stats()).toMatchObject({ running: 0 });
  }, 20_000);
});
