const {
  createLiquidityPublisher, liquidityOptionsFromEnv, liquidityLogLevel, rowClustersFor, windowRowsFor, MAX_WINDOW_ROWS, DEFAULT_COARSE_S, DEFAULT_STORE_MAX_BYTES,
} = require("../../../src/indicators/passive_liquidity/liquidity-publisher");

describe("liquidity publisher log levels (report 57 W5 logging sweep)", () => {
  test.each([
    ["liquidity-publisher: book for SPOT:BTCUSDT is unavailable, holding columns", "warn"],
    ["liquidity-publisher: dropped 3 stored deep columns for SPOT:BTCUSDT that span more than 2047 rows", "warn"],
    ["liquidity-publisher: stored history for SPOT:BTCUSDT was not restored (STALE), rebuilding from the recording", "warn"],
    ["liquidity-publisher: the recording holds no trades for SPOT:BTCUSDT over the 5 min from 2026-09-24T00:00:00.000Z; its columns keep no flow", "warn"],
    ["liquidity-publisher: no backfill for SPOT:BTCUSDT (NO_DATABASE), starting live", "warn"],
    ["liquidity-publisher: no deep backfill for SPOT:BTCUSDT behind the stored tier (NO_ROWS)", "warn"],
    ["liquidity-publisher: backfill failed for SPOT:BTCUSDT, starting live: boom", "error"],
    ["liquidity-publisher: could not store the history for SPOT:BTCUSDT: EACCES", "error"],
    ["liquidity-publisher: stored history for SPOT:BTCUSDT would not load (bad json), rebuilding from the recording", "error"],
    ["liquidity-publisher: dropped the stored history for SPOT:BTCUSDT: the picture it gave back cannot be sent", "error"],
    ["liquidity-publisher: tick failed for SPOT:BTCUSDT: boom", "error"],
    ["liquidity-publisher: trimmed the 12 oldest stored deep columns for SPOT:BTCUSDT to keep the store under 50331648 bytes (was 51000000)", "info"],
    ["liquidity-publisher: backfilled 1200 columns and 3 walls for SPOT:BTCUSDT from the collector's recording", "info"],
  ])("%s -> %s", (line, level) => {
    expect(liquidityLogLevel(line)).toBe(level);
  });
});
const { MAX_AGGRESSIVE_EVENTS, MAX_WIRE_MAGNITUDE } = require("../../../src/server/frames");
const { decodeColumn, sizeAt } = require("../../../src/indicators/passive_liquidity/liquidity-history");

const T0 = 1_700_000_000_000;
// The expectations below were written for $2 rows and a +-200-row window on BTC at 80,000.
// Backfill is off here (the machine may hold a real collector database); it has its own test below.
// The deep tier is off unless a test turns it on.
const GEOMETRY = Object.freeze({ rowBp: 0.25, windowBp: 50, backfillEnabled: false, deepS: 0, coarseS: 0, storeEnabled: false, wallSettleMs: 0 });

// A stand-in for the memory engine: a fixed cluster width and a mutable book.
function fakeEngine({ clusterWidth = 0.5, seeded = true } = {}) {
  const state = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [], asks: [] }; // price 80,000 at $0.50 bands
  return {
    state,
    live: true, // the source book is READY; a test flips it to model a dead book
    get seeded() {
      return seeded;
    },
    snapshot() {
      return { ...state, clusterWidth, priceFor: (key) => key * clusterWidth };
    },
    priceFor: (key) => key * clusterWidth,
    eventHead: () => 0,
    events: () => ({ events: [], nextSeq: 0, missed: 0 }),
  };
}

function memoryWith(engine) {
  return { getEngine: jest.fn(() => engine) };
}

describe("liquidity-publisher", () => {
  test("drains and bounds pending trades during a dead book without emitting invented columns", () => {
    const engine = fakeEngine();
    let pending = [];
    engine.drainPrints = () => { const out = pending; pending = []; return out; };
    const publish = jest.fn();
    const publisher = createLiquidityPublisher({ memory: memoryWith(engine), publish, ...GEOMETRY });
    publisher.tick("SPOT", "BTCUSDT", T0);
    publish.mockClear();
    engine.live = false;
    for (let i = 1; i <= 30; i += 1) {
      pending.push({ ts: T0 + i * 1_000, price: 80_000, size: 1, side: "buy", id: String(i) });
      expect(publisher.tick("SPOT", "BTCUSDT", T0 + i * 1_000)).toBeNull();
      expect(pending).toHaveLength(0);
    }
    expect(publish).not.toHaveBeenCalled();
    const retention = publisher.stats().retentionByPair["SPOT:BTCUSDT"];
    expect(retention.pendingFlowPrints).toBe(2);
    expect(retention.recentColumns).toBe(1);
    expect(retention.sideBufferBytes).toBeGreaterThan(0);
    engine.live = true;
    expect(publisher.tick("SPOT", "BTCUSDT", T0 + 30_000)).not.toBeNull();
    publisher.stop();
  });
  test("derives rows and windows from price", () => {
    expect(rowClustersFor(80_000, 0.5, 0.25)).toBe(4); // $2 rows
    expect(rowClustersFor(4_000, 0.025, 0.25)).toBe(4); // $0.10 rows on ETH
    expect(rowClustersFor(null, 0.5, 0.25)).toBe(1);
    expect(windowRowsFor(80_000, 2, 50)).toBe(200); // +-$400
    expect(windowRowsFor(80_000, 0.5, 50_000)).toBe(MAX_WINDOW_ROWS);
    expect(windowRowsFor(null, 2, 50)).toBe(MAX_WINDOW_ROWS);
  });

  test("reads its knobs from the environment", () => {
    expect(liquidityOptionsFromEnv({})).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_ROW_BP: "0.5", L2_HEATMAP_WINDOW_BP: "25", L2_HEATMAP_COLUMN_MS: "2000", L2_HEATMAP_HISTORY_S: "600" }))
      .toEqual({ rowBp: 0.5, windowBp: 25, columnMs: 2000, historyS: 600 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_ROW_BP: "nope" })).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_DEEP_S: "0", L2_HEATMAP_DEEP_COLUMN_MS: "5000" })).toEqual({ deepS: 0, deepColumnMs: 5000 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_DEEP_S: "7200" })).toEqual({ deepS: 7200 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_DEEP_CHUNK_S: "3600" })).toEqual({ deepChunkS: 3600 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_COARSE_S: "0", L2_HEATMAP_COARSE_COLUMN_MS: "600000", L2_HEATMAP_COARSE_ROWS: "20" })).toEqual({ coarseS: 0, coarseColumnMs: 600000, coarseRows: 20 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_COARSE_ROWS: "2.5" })).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_WALL_SETTLE_MS: "3000" })).toEqual({ wallSettleMs: 3000 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL_MAX_S: "300", L2_HEATMAP_STORE_MAX_AGE_S: "86400", L2_HEATMAP_HISTORY_FLOOR: "2026-09-06T21:00:00Z" }))
      .toEqual({ backfillMaxS: 300, storeMaxAgeS: 86400, historyFloorMs: Date.parse("2026-09-06T21:00:00Z") });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL_WORKERS: "2", L2_HEATMAP_BACKFILL_TIMEOUT_S: "120" })).toEqual({ backfillWorkers: 2, backfillTimeoutS: 120 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL_WORKERS: "0", L2_HEATMAP_BACKFILL_TIMEOUT_S: "-1" })).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_HISTORY_FLOOR: "not a time" })).toEqual({});
    expect(liquidityOptionsFromEnv({ TT_LIVE_STORAGE_SERVICE_URL: "https://host/live-storage", TT_LIVE_STORAGE_CLIENT_TOKEN: "token" }))
      .toEqual({ remoteReplay: { baseUrl: "https://host/live-storage", token: "token" } });
    expect(liquidityOptionsFromEnv({ TT_LIVE_STORAGE_SERVICE_URL: "https://host/live-storage" })).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_AGGRESSIVE: "0" })).toEqual({ aggressiveEnabled: false });
    expect(liquidityOptionsFromEnv({ L2_AGGRESSIVE_PERCENTILE: "0.995", L2_AGGRESSIVE_FLOOR: "15", L2_AGGRESSIVE_MIN: "2" }))
      .toEqual({ aggressive: { floorPercentile: 0.995, floor: 15, minFloor: 2 } });
    expect(liquidityOptionsFromEnv({ L2_AGGRESSIVE_PERCENTILE: "1.5", L2_AGGRESSIVE_FLOOR: "-1", L2_AGGRESSIVE_MIN: "" })).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_AGGRESSIVE_FLOOR: String(MAX_WIRE_MAGNITUDE) })).toEqual({ aggressive: { floor: MAX_WIRE_MAGNITUDE } });
    expect(() => liquidityOptionsFromEnv({ L2_AGGRESSIVE_FLOOR: String(MAX_WIRE_MAGNITUDE + 1) })).toThrow(/L2_AGGRESSIVE_FLOOR/);
    expect(() => liquidityOptionsFromEnv({ L2_AGGRESSIVE_MIN: String(MAX_WIRE_MAGNITUDE + 1) })).toThrow(/L2_AGGRESSIVE_MIN/);
  });

  test("the deep tier: one column per window holding the largest size each row held in it, on its own chain", () => {
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), columnMs: 1000, deepColumnMs: 1500 })).toThrow(/multiple/);
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 5_000, memory: memoryWith(engine), now: () => T0 });
    expect(publisher.deepColumnMs).toBe(5_000);
    expect(publisher.maxDeepColumns).toBe(12);
    // The first window opens: only the fine frame goes out, the deep column is still being built.
    const first = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(first).toMatchObject({ column_ms: 1_000, seq: 1, reset: true });
    expect(first.levels).toBeDefined();
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).toMatchObject({ column_ms: 1_000, seq: 2, reset: false });
    // A wall stands for one second inside the window and is gone again.
    engine.state.bids = [{ key: 160_000, size: 3 }];
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    engine.state.bids = [{ key: 160_000, size: 1 }];
    for (let i = 3; i < 5; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    // The next window opens: the finished one lands, deep first, holding the window's largest size (3, not the 1 at its edges).
    const boundary = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 5_000);
    expect(boundary.map((f) => [f.column_ms, f.seq, f.reset, f.ts])).toEqual([[5_000, 1, true, T0], [1_000, 6, false, T0 + 5_000]]);
    expect(boundary[0].columns[0].bid).toEqual([[200, 3]]);
    expect(publisher.activeState).toMatchObject({ length: 6, seq: 6, deepLength: 1, deepSeq: 1 });
    // The second window, all size 1: its delta against the first shows the drop.
    for (let i = 6; i < 10; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    const second = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 10_000);
    expect(second.map((f) => [f.column_ms, f.seq, f.reset, f.ts])).toEqual([[5_000, 2, false, T0 + 5_000], [1_000, 11, false, T0 + 10_000]]);
    expect(second[0].columns[0].bid).toEqual([[200, 1]]);
    // A new client gets the deep chunks first, then the recent ones; walls ride on the very last frame.
    const frames = publisher.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(frames.map((f) => [f.column_ms, f.reset, f.columns.length, "levels" in f])).toEqual([[5_000, true, 2, false], [1_000, true, 10, true]]);
    // The recent ring rolls (historyS 10 s) while the deep one keeps every finished window.
    for (let i = 11; i <= 25; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    expect(publisher.activeState).toMatchObject({ length: 10, deepLength: 5 });
  });
  test("the coarse tier: one column per coarse window on rows coarseRows times as tall, folded from the deep columns as they land, on its own chain and row width", () => {
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), deepColumnMs: 5_000, coarseColumnMs: 7_000 })).toThrow(/multiple of deepColumnMs/);
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), deepColumnMs: 5_000, coarseColumnMs: 5_000 })).toThrow(/above it/);
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), coarseRows: 0 })).toThrow(/coarseRows/);
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), coarseColumnMs: 20_000, coarseSampleMs: 3_000 })).toThrow(/coarseSampleMs/);
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }, { key: 160_001, size: 2 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 5_000, coarseS: 120, coarseColumnMs: 10_000, coarseRows: 2, memory: memoryWith(engine), now: () => T0 });
    // The horizon the bubbles and the rest of the server warm up over stays the deep tier's; the coarse tier has its own.
    expect([publisher.coarseColumnMs, publisher.coarseRows, publisher.maxCoarseColumns, publisher.horizonMs, publisher.coarseHorizonMs]).toEqual([10_000, 2, 12, 60_000, 120_000]);
    // Off without a deep tier, or when it reaches no further than the deep one.
    expect(createLiquidityPublisher({ ...GEOMETRY, coarseS: 120, memory: memoryWith(fakeEngine()) }).coarseColumnMs).toBe(0);
    expect(createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, coarseS: 60, memory: memoryWith(fakeEngine()) })).toMatchObject({ horizonMs: 60_000, coarseHorizonMs: 0, coarseColumnMs: 0 });
    for (let i = 0; i <= 4; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    engine.state.bids = [{ key: 160_000, size: 3 }, { key: 160_001, size: 2 }];
    for (let i = 5; i <= 9; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    engine.state.bids = [{ key: 160_000, size: 1 }, { key: 160_001, size: 2 }];
    // The deep windows at T0 and T0 + 5 s have landed; the coarse window at T0 is still open until a deep column of the next one lands.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 10_000).map((f) => f.column_ms)).toEqual([5_000, 1_000]);
    expect(publisher.activeState).toMatchObject({ deepLength: 2, coarseLength: 0 });
    for (let i = 11; i <= 14; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    const landed = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 15_000);
    expect(landed.map((f) => [f.column_ms, f.seq, f.reset, f.ts, f.row_width])).toEqual([[10_000, 1, true, T0, 4], [5_000, 3, false, T0 + 10_000, 2], [1_000, 16, false, T0 + 15_000, 2]]);
    // Rows 40,000 and 40,001 (sizes 3 at most and 2) fold into coarse row 20,000: 5, on a window of half the fine rows.
    const coarse = landed[0].columns[0];
    expect(coarse.bid).toEqual([[100, 5]]);
    expect(coarse.hi - coarse.lo + 1).toBe(201);
    expect(publisher.activeState).toMatchObject({ coarseLength: 1, coarseSeq: 1 });
    // A new client gets the coarse chunks first, on their own row width, then the deep and recent ones.
    const frames = publisher.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(frames.map((f) => [f.column_ms, f.reset, f.row_width, f.columns.length])).toEqual([[10_000, true, 4, 1], [5_000, true, 2, 3], [1_000, true, 2, 10]]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].coarse).toEqual({ state: "IDLE", reason: "NOT_STARTED" });
  });

  test("the coarse tier is off unless asked for, and its rebuild samples at the deep column width so both halves of the tier measure the same thing", async () => {
    expect(DEFAULT_COARSE_S).toBe(0);
    const off = createLiquidityPublisher({ ...GEOMETRY, coarseS: undefined, deepS: 60, historyS: 10, memory: memoryWith(fakeEngine()), now: () => T0 });
    expect(off).toMatchObject({ coarseColumnMs: 0, coarseHorizonMs: 0 });
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: {}, levels: [], aggressive: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2, coarseChunkS: 20,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const coarsePasses = calls.filter((c) => c.foldMs === 20_000);
    expect(coarsePasses.length).toBeGreaterThan(0);
    expect(coarsePasses.every((c) => c.columnMs === 10_000)).toBe(true);
  });

  test("the coarse tier is rebuilt behind the deep tier once the deep passes are done, newest chunk first, sampled on the coarse rows without walls, and stored", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const backfill = async (request) => {
      calls.push(request);
      const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 3 }], asks: [] };
      const column = (ts) => sampleLiquidityColumn(snapshot, { ts, rowClusters: request.rowClusters, windowRows: request.windowRows });
      if (request.columnMs === 5_000) {
        if (request.fromTs === T0 - 80_000) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: {}, levels: [], aggressive: [] };
        request.onColumn(column(request.fromTs));
        // A worker that overruns its window by one column: that column is already the tier's, and is not taken twice.
        if (request.fromTs === T0 - 60_000) request.onColumn(column(request.toTs));
        return { columns: request.fromTs === T0 - 60_000 ? 2 : 1, frames: 10, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      if (request.foldMs === undefined) {
        request.onColumn(column(T0 - 9_000));
        return { columns: 1, frames: 10, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      request.onColumn(column(T0 - 40_000));
      request.onColumn(column(T0 - 30_000));
      return { columns: 2, frames: 20, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const saveHistory = jest.fn(() => ({ ok: true }));
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2, coarseSampleMs: 5_000, coarseChunkS: 20,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // After the recent pass and the deep pass: three coarse chunks from the deep tier's first column back to the horizon, newest first.
    const coarsePasses = calls.filter((c) => c.columnMs === 5_000);
    expect(coarsePasses.map((c) => [c.fromTs - T0, c.toTs - T0, c.foldMs, c.rowClusters, c.windowRows, c.trackerOptions, c.aggressiveOptions])).toEqual([
      [-60_000, -40_000, 20_000, 8, 100, undefined, undefined],
      [-80_000, -60_000, 20_000, 8, 100, undefined, undefined],
      [-100_000, -80_000, 20_000, 8, 100, undefined, undefined],
    ]);
    expect(calls.findIndex((c) => c.columnMs === 5_000)).toBe(calls.findIndex((c) => c.foldMs === 10_000 && c.columnMs === 1_000) + 1);
    // The chunks that answered landed in front of the tier, in time order before the window folded from the deep tier; the empty one is counted, not invented.
    expect(publisher.activeState).toMatchObject({ coarseLength: 3 });
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].coarse).toMatchObject({ state: "DEGRADED", reason: "PARTIAL_COVERAGE", emptyChunks: 1 });
    expect(lines.filter((l) => /coarse-backfilled 1 columns/.test(l))).toHaveLength(2);
    expect(lines.some((l) => /no coarse backfill for PERPETUAL:BTCUSDT \(NO_DATA_IN_WINDOW\) over 1 of 3 chunks/.test(l))).toBe(true);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(frames.map((f) => [f.column_ms, f.row_width, f.columns.map((c) => c.ts - T0)])).toEqual([
      [20_000, 4, [-100_000, -60_000, -40_000]],
      [10_000, 2, [-40_000, -30_000, -10_000]],
      [1_000, 2, [-9_000, 0, 1_000]],
    ]);
    // The store carries the coarse tier on its own geometry.
    expect(saveHistory.mock.calls.at(-1)[0].coarse).toMatchObject({ columnMs: 20_000, rows: 2 });
    expect(saveHistory.mock.calls.at(-1)[0].coarse.columns).toHaveLength(3);
  });

  test("the coarse rebuild starts behind what the store gave back, not behind the deep tier", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const wire = (ts) => ({ ts, lo: 19_900, hi: 20_100, bid: [[100, 2]], ask: [] });
    const stored = {
      savedAt: T0 - 4_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [{ ts: T0 - 4_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] }],
      deep: [],
      levels: [],
      coarse: { columnMs: 20_000, rows: 2, columns: [wire(T0 - 60_000), wire(T0 - 40_000)] },
    };
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: {}, levels: [], aggressive: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", deepS: 60, historyS: 10, deepColumnMs: 10_000,
      coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2, coarseSampleMs: 5_000, coarseChunkS: 20,
      storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((c) => c.columnMs === 5_000).map((c) => [c.fromTs - T0, c.toTs - T0])).toEqual([[-80_000, -60_000], [-100_000, -80_000]]);
  });

  test("a store is worth reading as long as the coarse tier reaches, not only a week: a month of coarse columns survives a long stop", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const loadHistory = jest.fn(() => null);
    const month = 30 * 24 * 3_600;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 10_000, coarseS: month, coarseColumnMs: 20_000, coarseRows: 2,
      storeEnabled: true, storeDir: "unused", loadHistory, saveHistory: () => ({ ok: true }), memory: memoryWith(engine), now: () => T0,
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ maxAgeMs: month * 1_000 }));
    const week = createLiquidityPublisher({
      ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 10_000, coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2,
      storeEnabled: true, storeDir: "unused", loadHistory, saveHistory: () => ({ ok: true }), memory: memoryWith(fakeEngine()), now: () => T0,
    });
    week.tick("PERPETUAL", "BTCUSDT", T0);
    expect(loadHistory).toHaveBeenLastCalledWith(expect.objectContaining({ maxAgeMs: 7 * 24 * 3_600_000 }));
  });

  test("a stored coarse tier is restored on its own geometry, without the window that was still open when the store was written", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const wire = (ts) => ({ ts, lo: 19_900, hi: 20_100, bid: [[100, 2]], ask: [] });
    const stored = {
      savedAt: T0 - 4_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [{ ts: T0 - 4_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] }],
      deep: [],
      levels: [],
      coarse: { columnMs: 20_000, rows: 2, columns: [wire(T0 - 60_000), wire(T0 - 40_000), wire(T0 - 20_000)] },
    };
    const lines = [];
    const make = (coarse) => createLiquidityPublisher({
      ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 10_000, coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2,
      storeEnabled: true, storeDir: "unused", loadHistory: () => ({ ...stored, coarse }), saveHistory: () => ({ ok: true }),
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    const publisher = make(stored.coarse);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(frames.map((f) => [f.column_ms, f.row_width, f.columns.map((c) => c.ts - T0)])).toEqual([[20_000, 4, [-60_000, -40_000]], [1_000, 2, [-4_000, 0]]]);
    expect(lines.some((l) => /restored 1 columns, 0 deep, 2 coarse and 0 walls/.test(l))).toBe(true);
    // Another geometry in the store is not this tier's: nothing of it is taken.
    expect(make({ ...stored.coarse, rows: 4 }).tick("PERPETUAL", "BTCUSDT", T0).map((f) => f.column_ms)).toEqual([1_000]);
    expect(make(null).tick("PERPETUAL", "BTCUSDT", T0).map((f) => f.column_ms)).toEqual([1_000]);
  });

  // Block 8 #8: restoring the real 18.8 MB BTC perp store blocked the event
  // loop for 1,139 ms in one piece (measured on the laptop's store), the
  // 1,984 ms stall the recorder caught. The production path now restores in
  // slices; these pin that it holds the pair while it runs and ends in exactly
  // the picture the one-piece restore gives.
  describe("restoring a store without blocking (Block 8 #8)", () => {
    const wire = (ts) => ({ ts, lo: 19_900, hi: 20_100, bid: [[100, 2]], ask: [] });
    const stored = {
      savedAt: T0 - 4_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [{ ts: T0 - 5_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] }, { ts: T0 - 4_000, lo: 39_800, hi: 40_200, bid: [[200, 7]], ask: [] }],
      deep: [],
      levels: [],
      coarse: { columnMs: 20_000, rows: 2, columns: [wire(T0 - 60_000), wire(T0 - 40_000), wire(T0 - 20_000)] },
    };
    function options(overrides) {
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      return {
        ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 10_000, coarseS: 100, coarseColumnMs: 20_000, coarseRows: 2,
        storeEnabled: true, storeDir: "unused", memory: memoryWith(engine), now: () => T0, log: () => {}, ...overrides,
      };
    }
    async function turns(count = 30) {
      for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }

    test("the pair is held while its store loads: no column, no replay, and nothing saved over the store", async () => {
      let release;
      const saveHistory = jest.fn(() => ({ ok: true }));
      const publisher = createLiquidityPublisher(options({
        loadHistory: () => { throw new Error("the one-piece path must not run"); },
        loadHistoryAsync: () => new Promise((resolve) => { release = () => resolve(stored); }),
        saveHistory, storeS: 0.001, restoreSliceColumns: 1,
      }));
      for (let i = 0; i < 3; i += 1) expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + i)).toBeNull();
      expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")).toEqual([]);
      expect(saveHistory).not.toHaveBeenCalled();
      release();
      await turns();
      expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toEqual(expect.any(Array));
    });

    test("the sliced restore ends in the same replay as the one-piece restore", async () => {
      const sliced = createLiquidityPublisher(options({
        loadHistory: () => { throw new Error("the one-piece path must not run"); },
        loadHistoryAsync: async () => stored, saveHistory: () => ({ ok: true }), restoreSliceColumns: 1,
      }));
      expect(sliced.tick("PERPETUAL", "BTCUSDT", T0)).toBeNull();
      await turns();
      const whole = createLiquidityPublisher(options({ loadHistory: () => stored, saveHistory: () => ({ ok: true }) }));
      const expected = whole.tick("PERPETUAL", "BTCUSDT", T0);
      expect(expected.map((frame) => frame.column_ms)).toEqual([20_000, 1_000]);
      expect(sliced.tick("PERPETUAL", "BTCUSDT", T0)).toEqual(expected);
    });

    test("a store that will not load still leaves the pair live, rebuilt from the recording", async () => {
      const lines = [];
      const publisher = createLiquidityPublisher(options({
        loadHistory: () => null, loadHistoryAsync: async () => { throw new Error("disk gone"); },
        saveHistory: () => ({ ok: true }), log: (line) => lines.push(line),
      }));
      expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toBeNull();
      await turns();
      expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).not.toBeNull();
      expect(lines.some((line) => /could not read the stored history .*disk gone/.test(line))).toBe(true);
    });
  });

  test("deepColumnsAfter hands out the deep tier after a timestamp, in bounded batches: null for an unknown pair or no tier, an empty list when nothing is newer, the first column strictly after the mark", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 5_000, memory: memoryWith(engine), now: () => T0 });
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", null, 10)).toBeNull();
    for (let i = 0; i <= 15; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    const all = publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", null, undefined);
    expect(all.map((c) => c.ts)).toEqual([T0, T0 + 5_000, T0 + 10_000]);
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", null, 2).map((c) => c.ts)).toEqual([T0, T0 + 5_000]);
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", T0, 10).map((c) => c.ts)).toEqual([T0 + 5_000, T0 + 10_000]);
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", T0 + 4_999, 1).map((c) => c.ts)).toEqual([T0 + 5_000]);
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", T0 + 10_000, 10)).toEqual([]);
    expect(publisher.deepColumnsAfter("PERPETUAL", "BTCUSDT", T0 + 20_000, 10)).toEqual([]);
    expect(publisher.deepColumnsAfter("SPOT", "ETHUSDT", null, 10)).toBeNull();
    const noDeep = createLiquidityPublisher({ ...GEOMETRY, deepS: 0, historyS: 10, memory: memoryWith(fakeEngine()), now: () => T0 });
    noDeep.tick("PERPETUAL", "BTCUSDT", T0);
    expect(noDeep.deepColumnsAfter("PERPETUAL", "BTCUSDT", null, 10)).toBeNull();
  });

  test("a deep column keeps the rows of its window's first column even when the mid drifts, so it never outgrows the wire", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 5_000, memory: memoryWith(engine), now: () => T0 });
    const first = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    const span = first.columns[0].hi - first.columns[0].lo + 1;
    // Price jumps by a whole window inside the deep window: the fine columns move with it.
    engine.state.bestBidKey = 160_000 + 4 * 300;
    engine.state.bestAskKey = 160_001 + 4 * 300;
    engine.state.bids = [{ key: 160_000 + 4 * 300, size: 7 }];
    for (let i = 1; i < 5; i += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    const boundary = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 5_000);
    const deep = boundary[0].columns[0];
    expect(boundary[0].column_ms).toBe(5_000);
    expect(deep.hi - deep.lo + 1).toBe(span); // the first column's rows, not the union
    expect(deep.lo).toBe(first.columns[0].lo);
  });
  test("the deep tier is a second pass: the recent one lands first, deep columns fill in behind, held columns follow", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    // Ended before the recent window: real history. Resting, or ended inside the
    // recent window: the recent pass owns those, so they are not adopted twice.
    // It rested a minute and a half, so the tracker keeps it past the recent window (a flicker would be dropped).
    const past = { side: "bid", row: 39_990, span: 1, startTs: T0 - 130_000, endTs: T0 - 40_000, size: 0, peak: 30, endedBy: "pulled" };
    const stillThere = { side: "bid", row: 39_991, span: 1, startTs: T0 - 50_000, endTs: null, size: 20, peak: 20, endedBy: null };
    let openDeepGate;
    const deepGate = new Promise((resolve) => { openDeepGate = resolve; });
    const backfill = async (request) => {
      calls.push(request);
      const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 3 }], asks: [] };
      const column = (ts) => sampleLiquidityColumn(snapshot, { ts, rowClusters: request.rowClusters, windowRows: request.windowRows });
      if (request.foldMs === undefined) {
        request.onColumn(column(T0 - 10_000)); // on a deep boundary: held until the deep pass lands
        request.onColumn(column(T0 - 9_000));
        return { columns: 2, frames: 10, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      await deepGate; // the deep pass runs while the chart is already live
      request.onColumn(column(T0 - 40_000));
      request.onColumn(column(T0 - 30_000));
      return { columns: 2, frames: 20, reason: null, stats: {}, levels: [past, stillThere], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toMatchObject({ reset: true, seq: 1, column_ms: 1_000 });
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The recent pass is in behind the live column, and the deep pass has been asked for the hours before them.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.columnMs, c.foldMs])).toEqual([[-10_000, 0, 1_000, undefined], [-60_000, -10_000, 1_000, 10_000]]);
    expect(calls[1].trackerOptions).toMatchObject({ keepEndedMs: 10_000, deepKeepEndedMs: 60_000 });
    expect(publisher.activeState).toMatchObject({ length: 3, deepLength: 0 }); // the boundary column waits
    expect(lines.some((l) => /backfilled 2 columns and 0 walls/.test(l))).toBe(true);
    // Live meanwhile: the fine tier publishes, the deep tier stays quiet.
    // The rebuilt recent history is replayed at once; there is no deep tier to send yet.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000).map((f) => [f.column_ms, f.reset])).toEqual([[1_000, true]]);
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 10_000)).toMatchObject({ column_ms: 1_000 }); // a deep boundary, held
    expect(publisher.activeState).toMatchObject({ deepLength: 0 });
    // The deep pass finishes: its columns land first, then the held ones, in time order.
    openDeepGate();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(publisher.activeState).toMatchObject({ deepLength: 4 });
    expect(lines.some((l) => /deep-backfilled 2 columns and 1 past walls/.test(l))).toBe(true);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 11_000);
    // Deep columns are finished windows: the window that opened at T0 landed when T0 + 10 s began; the one at T0 + 10 s is still being built.
    expect(frames.map((f) => [f.column_ms, f.reset, f.columns.map((c) => c.ts - T0)])).toEqual([
      [10_000, true, [-40_000, -30_000, -10_000, 0]],
      [1_000, true, [-10_000, -9_000, 0, 1_000, 10_000, 11_000]],
    ]);
    // Only the wall that ended before the recent window was taken on.
    expect(frames[1].levels.map((l) => [l.row, l.ended_by])).toEqual([[39_990, "pulled"]]);
  });

  // Property: the deep tier (hours of coarse columns, ~1 MB a page over a
  // ~200 KB/s laptop link) does not start until whoever started the publisher
  // admits it, so the small visible-first warm-ups are not starved by it; the
  // fine tier (the live window) never waits. Oracle: the backfill call log
  // against a gate the test holds. A broken gate must not strand the tier:
  // a throw or rejection starts it at once.
  test("the deep tier waits for admission after the recent pass; the recent pass itself never waits", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const backfill = async (request) => {
      calls.push(request);
      const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 3 }], asks: [] };
      const column = (ts) => sampleLiquidityColumn(snapshot, { ts, rowClusters: request.rowClusters, windowRows: request.windowRows });
      request.onColumn(column(request.foldMs === undefined ? T0 - 9_000 : T0 - 40_000));
      return { columns: 1, frames: 10, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    let admit;
    const admission = jest.fn(() => new Promise((resolve) => { admit = resolve; }));
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: () => {}, deepAdmission: admission });
    try {
      publisher.tick("PERPETUAL", "BTCUSDT", T0);
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(calls.map((c) => c.foldMs)).toEqual([undefined]);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(admission).toHaveBeenCalledWith("PERPETUAL:BTCUSDT");
      expect(publisher.activeState).toMatchObject({ deepLength: 0 });
      admit();
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(calls.map((c) => c.foldMs)).toEqual([undefined, 10_000]);
      expect(publisher.activeState).toMatchObject({ deepLength: 2 });
    } finally {
      publisher.stop();
    }
  });

  test("a deep admission that throws or rejects starts the deep tier at once, and a non-function is refused at start", async () => {
    const lines = [];
    for (const admission of [() => { throw new Error("gate exploded"); }, () => Promise.reject(new Error("gate rejected"))]) {
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const calls = [];
      const backfill = async (request) => {
        calls.push(request.foldMs);
        return { columns: 0, frames: 0, reason: null, stats: {}, levels: [], aggressive: [] };
      };
      const publisher = createLiquidityPublisher({
        ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
        memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
      });
      publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: () => {}, deepAdmission: admission });
      try {
        publisher.tick("PERPETUAL", "BTCUSDT", T0);
        for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
        expect(calls).toEqual([undefined, 10_000]);
      } finally {
        publisher.stop();
      }
    }
    expect(lines.filter((l) => /deep admission failed .* starting the deep tier now/.test(l))).toHaveLength(2);
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), now: () => T0 });
    expect(() => publisher.start({ activePair: () => null, publish: () => {}, deepAdmission: "later" })).toThrow(/deepAdmission/);
  });

  test("backfill passes go through one scheduler: one runs while the next waits, and stop cancels what is left", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const started = [];
    const backfill = (request) => new Promise((resolve) => started.push({ request, resolve }));
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 60, deepS: 0,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    publisher.tick("SPOT", "BTCUSDT", T0);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(started.map((s) => s.request.key)).toEqual(["PERPETUAL:BTCUSDT"]);
    expect(publisher.stats().backfill).toMatchObject({ running: 1, queued: 1, started: 1 });
    started[0].resolve({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] });
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(started.map((s) => s.request.key)).toEqual(["PERPETUAL:BTCUSDT", "SPOT:BTCUSDT"]);
    expect(started[1].request.shouldContinue()).toBe(true);
    publisher.stop();
    expect(started[1].request.shouldContinue()).toBe(false);
    expect(publisher.stats().backfill).toMatchObject({ running: 1, queued: 0, cancelled: 1 });
  });

  test("the pair on screen is scheduled ahead of the pairs already waiting", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    try {
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const started = [];
      const backfill = (request) => new Promise((resolve) => started.push({ request, resolve }));
      const publisher = createLiquidityPublisher({
        ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 60, deepS: 0,
        memory: memoryWith(engine), log: () => {},
      });
      publisher.tick("PERPETUAL", "BTCUSDT", T0);
      publisher.tick("SPOT", "BTCUSDT", T0);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      publisher.start({ activePair: () => ({ marketKind: "SPOT", symbol: "ETHUSDT" }), publish: () => {} });
      jest.advanceTimersByTime(800);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      expect(publisher.stats().backfill).toMatchObject({ running: 1, queued: 2 });
      started[0].resolve({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] });
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      expect(started.map((s) => s.request.key)).toEqual(["PERPETUAL:BTCUSDT", "SPOT:ETHUSDT"]);
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("progress during a rebuild is announced at most once per announce interval, and once more when it lands", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    let at = T0;
    let pass;
    const backfill = (request) => new Promise((resolve) => { pass = { request, resolve }; });
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 3_600, deepS: 0, backfillAnnounceS: 15,
      memory: memoryWith(engine), now: () => at, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 3 }], asks: [] };
    const deliver = (from, count) => {
      for (let i = 0; i < count; i += 1) pass.request.onColumn(sampleLiquidityColumn(snapshot, { ts: T0 - 300_000 + (from + i) * 1_000, rowClusters: pass.request.rowClusters, windowRows: pass.request.windowRows }));
    };
    deliver(0, 120);
    at = T0 + 1_000;
    expect(Array.isArray(publisher.tick("PERPETUAL", "BTCUSDT", at))).toBe(true);
    deliver(120, 120);
    at = T0 + 2_000;
    expect(Array.isArray(publisher.tick("PERPETUAL", "BTCUSDT", at))).toBe(false);
    at = T0 + 16_000;
    deliver(240, 1);
    expect(Array.isArray(publisher.tick("PERPETUAL", "BTCUSDT", at))).toBe(true);
    pass.resolve({ columns: 241, frames: 1, reason: null, stats: {}, levels: [], aggressive: [] });
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    at = T0 + 17_000;
    const landed = publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(Array.isArray(landed)).toBe(true);
    expect(publisher.activeState).toMatchObject({ length: 241 + 5 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL_ANNOUNCE_S: "5" })).toEqual({ backfillAnnounceS: 5 });
  });

  test("backfill from the recording is on unless the environment turns it off", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const backfill = jest.fn(async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] }));
    const publisher = createLiquidityPublisher({ ...GEOMETRY, backfillEnabled: undefined, backfill, dbPath: "unused.sqlite", memory: memoryWith(engine), now: () => T0, log: () => {} });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL: "0" })).toEqual({ backfillEnabled: false });
  });

  test("the prints the engine saw since the last tick ride the column: traded volume per row per side, the big ones by name, their floor", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    engine.state.asks = [{ key: 160_001, size: 1 }];
    let prints = [];
    engine.drainPrints = () => { const out = prints; prints = []; return out; };
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    prints = [
      { ts: T0 - 900, price: 80_000.5, size: 2, side: "buy", id: "1" },
      { ts: T0 - 800, price: 80_000, size: 0.5, side: "sell", id: "2" },
      { ts: T0 - 700, price: 80_000, size: 1.5, side: "sell", id: "3" },
      { ts: T0 + 5, price: 80_000, size: 9, side: "sell", id: "next" },
    ];
    const first = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(first.columns[0].buy).toEqual([[200, 2]]);
    expect(first.columns[0].sell).toEqual([[200, 2]]);
    expect(first.columns[0].prints.map((print) => print.id)).toEqual(["1", "2", "3"]);
    expect(first.columns[0].prints_floor).toBe(0);
    const second = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(second.columns[0].prints.map((print) => print.id)).toEqual(["next"]);
    expect(second.columns[0].sell).toEqual([[200, 9]]);
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")[0].columns[1].prints[0].id).toBe("next");
  });

  test("a print that reaches the publisher after its second was taken is credited to the next column and counted late; older than that it is dropped and counted", () => {
    // The finding of 2026-09-20: prints arrive 0.5-0.7 s after they print, the column is taken on the first tick after
    // its second, so half of every second used to vanish. Here "late" printed at T0 - 100 but was drained only at the
    // T0 + 1 s tick; it lands there, one column late, rather than in the bin.
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    let prints = [];
    engine.drainPrints = () => { const out = prints; prints = []; return out; };
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    prints = [{ ts: T0 - 900, price: 80_000, size: 1, side: "sell", id: "own" }];
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    prints = [
      { ts: T0 - 100, price: 80_000, size: 5, side: "sell", id: "late" },
      { ts: T0 + 500, price: 80_000, size: 1, side: "sell", id: "next" },
    ];
    const second = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(second.columns[0].prints.map((print) => print.id)).toEqual(["late", "next"]);
    expect(second.columns[0].sell).toEqual([[200, 6]]);
    expect(publisher.stats()).toMatchObject({ flowLate: 1, flowDropped: 0 });
    prints = [{ ts: T0 - 1_500, price: 80_000, size: 7, side: "sell", id: "gone" }];
    const third = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    expect(third.columns[0].prints).toEqual([]);
    expect(third.columns[0].sell).toEqual([]);
    expect(publisher.stats()).toMatchObject({ flowLate: 1, flowDropped: 1 });
  });

  test("requires a memory binding", () => {
    expect(() => createLiquidityPublisher({})).toThrow(/memory/);
  });

  test("stats() reports per-tick timing", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    expect(publisher.stats()).toEqual({ pairs: 0, retentionByPair: {}, tickCount: 0, tickMsAvg: 0, tickMsMax: 0, tickLateMsAvg: 0, tickLateMsMax: 0, announces: 0, announceFrames: 0, flowLate: 0, flowDropped: 0, flowClipped: 0, backfill: null, laneWalls: { posted: 0, dropped: 0, replies: 0, errors: 0, inFlight: 0, pairs: 0, enabled: true } });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const stats = publisher.stats();
    expect(stats.pairs).toBe(1);
    expect(stats.tickCount).toBe(2);
    expect(stats.tickMsMax).toBeGreaterThanOrEqual(0);
    expect(stats.tickMsAvg).toBeGreaterThanOrEqual(0);
  });

  test("stats() reports how late the sampling clock fires", () => {
    jest.useFakeTimers();
    try {
      let clock = T0 + 300;
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => clock });
      publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: () => {} });
      // Due at T0 + 1005 (the column boundary plus 5 ms); the loop was busy and it fires 100 ms late.
      clock = T0 + 1_105;
      jest.advanceTimersByTime(705);
      expect(publisher.stats()).toMatchObject({ tickCount: 1, tickLateMsAvg: 100, tickLateMsMax: 100 });
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("publishes nothing until the engine is seeded and has a best price", () => {
    const unseeded = fakeEngine({ seeded: false });
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(unseeded), now: () => T0 });
    expect(publisher.tick("PERPETUAL", "BTCUSDT")).toBeNull();
    const noBest = fakeEngine();
    noBest.state.bestBidKey = null;
    noBest.state.bestAskKey = null;
    expect(createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(noBest), now: () => T0 }).tick("PERPETUAL", "BTCUSDT")).toBeNull();
    expect(createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => null }, now: () => T0 }).tick("PERPETUAL", "BTCUSDT")).toBeNull();
  });

  test("a memory that fixes the row width (dxFeed: ticks per row) overrides the price rule", () => {
    const engine = fakeEngine();
    const byPrice = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 + 250 }).tick("PERPETUAL", "BTCUSDT");
    const fixed = createLiquidityPublisher({ ...GEOMETRY, memory: { ...memoryWith(engine), rowClusters: () => 3 }, now: () => T0 + 250 }).tick("PERPETUAL", "BTCUSDT");
    expect(fixed.row_width).toBeCloseTo(engine.snapshot().clusterWidth * 3);
    expect(fixed.row_width).not.toBe(byPrice.row_width);
    // Anything but a positive integer falls back to the price rule.
    const bogus = createLiquidityPublisher({ ...GEOMETRY, memory: { ...memoryWith(engine), rowClusters: () => null }, now: () => T0 + 250 }).tick("PERPETUAL", "BTCUSDT");
    expect(bogus.row_width).toBe(byPrice.row_width);
  });

  test("first tick is a full reset frame, later ticks are deltas, same column is skipped", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1.5 }, { key: 159_999, size: 0.5 }, { key: 159_990, size: 4 }];
    engine.state.asks = [{ key: 160_001, size: 2 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 + 250 });

    const first = publisher.tick("PERPETUAL", "BTCUSDT");
    expect(first).toMatchObject({ type: "liquidity", symbol: "BTC-USDT", marketKind: "PERPETUAL", ts: T0, seq: 1, reset: true, row_width: 2, column_ms: 1000, levels: [] });
    expect(first.columns).toHaveLength(1);
    const col = first.columns[0];
    expect(col.ts).toBe(T0);
    expect(col.hi - col.lo).toBe(400); // 200 rows each side of the mid
    // rows: key 160000 -> row 40000, 159999 -> 39999, 159990 -> 39997; ask 160001 -> row 40000
    expect(col.bid).toEqual([[39_997 - col.lo, 4], [39_999 - col.lo, 0.5], [40_000 - col.lo, 1.5]]);
    expect(col.ask).toEqual([[40_000 - col.lo, 2]]);

    // Same second again: nothing.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 900)).toBeNull();

    // Next second, one level changed.
    engine.state.bids[0] = { key: 160_000, size: 3 };
    const second = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(second).toMatchObject({ ts: T0 + 1_000, seq: 2, reset: false });
    expect(second.columns[0].bid).toEqual([[40_000 - col.lo, 3]]);
    expect(second.columns[0].ask).toEqual([]);
    expect(second.levels).toBeUndefined(); // no wall appeared or left: the client keeps its list
    expect(publisher.activeState).toMatchObject({ key: "PERPETUAL:BTCUSDT", rowClusters: 4, windowRows: 200, rowWidth: 2, length: 2, seq: 2 });
  });

  test("sellers hitting a bid ride along as an aggressive-order cluster, which closes once the printing stops", () => {
    const engine = fakeEngine();
    // Row 40,000 holds 5 BTC. A fixed floor of 2 keeps the scenario short; wallMultiplier off so no wall interferes.
    engine.state.bids = [{ key: 160_000, size: 5, traded: 0, cancelled: 0, absorbed: 0 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, wallMultiplier: 0, aggressive: { floor: 2, gapMs: 3_000 } });
    const first = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(first.aggressive).toEqual([]); // a reset carries the list, empty
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000).aggressive).toBeUndefined(); // nothing changed: no key on the wire
    engine.state.bids = [{ key: 160_000, size: 4, traded: 3, cancelled: 0, absorbed: 3 }];
    const opened = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    expect(opened.aggressive).toEqual([{ side: "sell", row: 40_000, span: 1, start_ts: T0 + 2_000, end_ts: null, volume: 3, peak: 3, floor: 2 }]);
    // Quiet for the gap: the cluster closes at its last print and stays on the wire.
    let frame = null;
    for (let i = 3; i <= 20; i += 1) frame = publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000) ?? frame;
    const closed = publisher.snapshotFrames("PERPETUAL", "BTCUSDT").at(-1).aggressive;
    expect(closed).toEqual([expect.objectContaining({ side: "sell", end_ts: T0 + 2_000, volume: 3 })]);
    // Switched off: no key at all, not even on a reset.
    const off = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, aggressiveEnabled: false });
    expect(off.tick("PERPETUAL", "BTCUSDT", T0).aggressive).toBeUndefined();
  });

  test("more open clusters than the wire carries: the frame holds the newest 200 and publication goes on", () => {
    const engine = fakeEngine();
    const bids = (traded) => Array.from({ length: 201 }, (_, i) => ({ key: 160_000 - i * 8, size: 5, traded, cancelled: 0, absorbed: traded }));
    engine.state.bids = bids(0);
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, wallMultiplier: 0, aggressive: { floor: 2, gapMs: 3_000 } });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    engine.state.bids = bids(3);
    const frame = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(frame.aggressive).toHaveLength(MAX_AGGRESSIVE_EVENTS);
    expect(frame.aggressive.every((event) => event.end_ts === null && event.floor === 2)).toBe(true);
    const snapshot = publisher.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(snapshot.at(-1).aggressive).toHaveLength(MAX_AGGRESSIVE_EVENTS);
  });

  test("no column is emitted while the source book is dead: the chart gets a gap, not a copy of the last book", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 3, traded: 0, cancelled: 0 }];
    const lines = [];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, log: (line) => lines.push(line) });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).not.toBeNull();
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).not.toBeNull();
    // The book dies (a crossed dxFeed book, a lost session). The ledger still holds the 3 BTC; it must not be painted.
    engine.live = false;
    for (let i = 2; i <= 6; i += 1) expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000)).toBeNull();
    expect(publisher.activeState).toMatchObject({ length: 2, seq: 2 });
    expect(lines.some((line) => /unavailable, holding columns/.test(line))).toBe(true);
    // Back: the next column carries on the same chain, five seconds later. The gap is in the history, not papered over.
    engine.live = true;
    const resumed = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 7_000);
    expect(resumed).toMatchObject({ reset: false, seq: 3 });
    expect(resumed.columns[0].ts).toBe(T0 + 7_000);
    expect(publisher.activeStateForTests().history.latest().ts).toBe(T0 + 7_000);
    expect(lines.some((line) => /back after 5s, columns resume/.test(line))).toBe(true);
    // An engine that does not report liveness at all (an older fake) is treated as live.
    const legacy = fakeEngine();
    delete legacy.live;
    expect(createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(legacy), now: () => T0 }).tick("PERPETUAL", "BTCUSDT", T0)).not.toBeNull();
  });

  test("walls above the notional threshold ride along as levels, with their verdict when they leave", () => {
    const engine = fakeEngine();
    // $500k at 80,000 = 6.25 BTC per $2 row. With one row in the book the
    // relative part (3 x p95 = 21) would hide it, so it is switched off here.
    engine.state.bids = [{ key: 160_000, size: 7, traded: 0, cancelled: 0 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, wallMultiplier: 0 });
    const first = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(first.levels).toEqual([{ side: "bid", row: 40_000, span: 1, start_ts: T0, end_ts: null, size: 7, peak: 7, ended_by: null, ratio: expect.any(Number), chain: 0, fill: 0, eaten: 0, absorbing: false }]);
    // Unchanged wall: no levels key on the wire.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000).levels).toBeUndefined();
    // Eaten: the row's bands traded 7 since it appeared.
    engine.state.bids = [{ key: 160_000, size: 0, traded: 7, cancelled: 0 }];
    const gone = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    expect(gone.levels).toEqual([{ side: "bid", row: 40_000, span: 1, start_ts: T0, end_ts: T0 + 2_000, size: 0, peak: 7, ended_by: "filled", ratio: expect.any(Number), chain: 0, fill: 1, eaten: expect.any(Number), absorbing: false }]);
    // The snapshot's last chunk carries the current list too (only there: an
    // earlier chunk's ts would predate walls that appeared after it).
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT").at(-1).levels).toHaveLength(1);
    const long = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, historyS: 200, wallMultiplier: 0 });
    engine.state.bids = [];
    for (let i = 0; i < 150; i += 1) {
      if (i === 140) engine.state.bids = [{ key: 160_000, size: 7, traded: 0, cancelled: 0 }];
      long.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    }
    const chunks = long.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].levels).toBeUndefined();
    expect(chunks[1].levels).toEqual([expect.objectContaining({ start_ts: T0 + 140_000, ended_by: null })]);
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_LEVEL_MIN_USD: "250000", L2_HEATMAP_WALL_MULT: "0", L2_HEATMAP_REF_BP: "25", L2_HEATMAP_WALL_GAP: "1" })).toEqual({ levelMinUsd: 250_000, wallMultiplier: 0, referenceBp: 25, wallGapRows: 1 });
    // Default: the wall must also be 3x the book's typical row.
    const relative = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, wallMultiplier: 3 });
    // Twenty rows of 7 BTC (each above the $500k floor) and one of 30: only the 30 is a wall.
    engine.state.bids = [];
    for (let i = 0; i < 20; i += 1) engine.state.bids.push({ key: 160_000 - i * 4, size: 7 });
    engine.state.bids.push({ key: 159_900, size: 30 });
    expect(relative.tick("PERPETUAL", "BTCUSDT", T0).levels).toEqual([expect.objectContaining({ row: 39_975, peak: 30 })]);
  });

  test("snapshotFrames replays the history for a new client, chunked and chained", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, historyS: 3 });
    // Before any tick: nothing to replay (the first live column carries its own reset).
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")).toEqual([]);
    for (let i = 0; i < 5; i += 1) {
      engine.state.bids = [{ key: 160_000, size: 1 + i }];
      publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000);
    }
    const frames = publisher.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ reset: true, seq: 5, ts: T0 + 4_000, row_width: 2 });
    expect(frames[0].columns.map((c) => c.ts)).toEqual([T0 + 2_000, T0 + 3_000, T0 + 4_000]);
    expect(frames[0].columns[0].bid).toEqual([[200, 3]]); // full: the retained first column
    expect(frames[0].columns[1].bid).toEqual([[200, 4]]);
    // Another pair: not this history.
    expect(publisher.snapshotFrames("SPOT", "BTCUSDT")).toEqual([]);
  });

  test("a pair switch keeps every pair's history: the chart is served from memory", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    publisher.reset();
    expect(publisher.activeState).toMatchObject({ key: "PERPETUAL:BTCUSDT", length: 1 });
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")).toHaveLength(1);
    const again = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(again).toMatchObject({ reset: false, seq: 2 });
    // Another pair gets its own state; the first is untouched.
    publisher.tick("SPOT", "ETHUSDT", T0 + 1_000);
    expect(publisher.activeState).toMatchObject({ key: "SPOT:ETHUSDT", length: 1 });
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")[0].columns).toHaveLength(2);
  });

  test("start samples every listed pair and publishes only the active one", () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine) });
    const published = [];
    publisher.start({
      activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }),
      pairs: () => [{ marketKind: "PERPETUAL", symbol: "BTCUSDT" }, { marketKind: "SPOT", symbol: "ETHUSDT" }],
      publish: (frame) => published.push(frame),
    });
    jest.advanceTimersByTime(800);
    expect(published).toHaveLength(1);
    expect(published[0].symbol).toBe("BTC-USDT"); // the wire symbol
    expect(publisher.snapshotFrames("SPOT", "ETHUSDT")).toHaveLength(1); // sampled all along, ready for a switch
    publisher.stop();
    jest.useRealTimers();
  });

  test("start runs the clock on column boundaries and publishes through the callback", () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine) });
    const published = [];
    publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: (frame) => published.push(frame) });
    jest.advanceTimersByTime(600);
    expect(published).toHaveLength(0);
    jest.advanceTimersByTime(200); // crosses T0 + 1000 (+5 ms)
    expect(published).toHaveLength(1);
    expect(published[0].ts).toBe(T0 + 1_000);
    jest.advanceTimersByTime(1_000);
    expect(published).toHaveLength(2);
    publisher.stop();
    jest.advanceTimersByTime(5_000);
    expect(published).toHaveLength(2);
    expect(publisher.tick("PERPETUAL", "BTCUSDT")).toBeNull();
    jest.useRealTimers();
  });

  test("start hands an announced snapshot to publishSnapshot whole, and live columns to publish", () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    try {
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine) });
      const published = [];
      const snapshots = [];
      publisher.start({
        activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }),
        publish: (frame) => published.push(frame),
        publishSnapshot: (frames) => snapshots.push(frames),
      });
      jest.advanceTimersByTime(800);
      expect(published).toHaveLength(1);
      publisher.activeStateForTests().announce = true;
      jest.advanceTimersByTime(1_000);
      expect(published).toHaveLength(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0][0]).toMatchObject({ type: "liquidity", reset: true });
      jest.advanceTimersByTime(1_000);
      expect(published).toHaveLength(2);
      expect(snapshots).toHaveLength(1);
      expect(publisher.stats()).toMatchObject({ announces: 1, announceFrames: snapshots[0].length });
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("without publishSnapshot an announced snapshot still goes out through publish, and a non-function is refused", () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    try {
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine) });
      expect(() => publisher.start({ activePair: () => null, publish: () => {}, publishSnapshot: "later" })).toThrow(/publishSnapshot/);
      const published = [];
      publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: (frame) => published.push(frame) });
      jest.advanceTimersByTime(800);
      publisher.activeStateForTests().announce = true;
      jest.advanceTimersByTime(1_000);
      expect(published.length).toBeGreaterThan(1);
      expect(published[1]).toMatchObject({ reset: true });
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a snapshot that cannot be built is logged and yields nothing, so the client still connects", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const lines = [];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0, log: (line) => lines.push(line) });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    // Corrupt the retained state the way a bug would: a wall the frame builder rejects (peak under size).
    // A wall timed after the last column is not a corruption any more: the snapshot's ts covers it.
    publisher.activeStateForTests().tracker = { update: () => true, levels: () => [{ side: "bid", row: 40_000, span: 1, startTs: T0, endTs: null, size: 5, peak: 1, endedBy: null }] };
    expect(publisher.snapshotFrames("PERPETUAL", "BTCUSDT")).toEqual([]);
    expect(lines[0]).toMatch(/snapshot failed/);
  });

  test("a restored store whose picture cannot be sent is dropped, so the next restore does not loop on it", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const dropHistory = jest.fn(() => true);
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 0 },
      recent: [{ ts: T0 - 1_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [], buy: [], sell: [], prints: [{ ts: T0 - 9_000, price: 80_000, size: 1, side: "buy", id: "stale" }], printsFloor: 0 }],
      deep: [],
      levels: [],
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }), dropHistory,
      memory: memoryWith(engine), now: () => T0, log: (line) => lines.push(line),
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toEqual([]);
    expect(lines.some((line) => /snapshot failed/.test(line))).toBe(true);
    expect(dropHistory).toHaveBeenCalledWith({ dir: "unused", pairKey: "PERPETUAL:BTCUSDT" });
    expect(lines.some((line) => /dropped the stored history for PERPETUAL:BTCUSDT/.test(line))).toBe(true);
  });

  test("a tick that fails after its column was appended makes the next frame a full reset", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    const state = publisher.activeStateForTests();
    const goodTracker = state.tracker;
    // A tracker reporting a wall the frame builder rejects (peak under size).
    state.tracker = { update: () => true, levels: () => [{ side: "bid", row: 40_000, span: 1, startTs: T0, endTs: null, size: 5, peak: 1, endedBy: null }] };
    expect(() => publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).toThrow(/peak/);
    expect(publisher.activeState.seq).toBe(2); // the column was appended, its frame never sent
    state.tracker = goodTracker;
    const next = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    expect(next).toMatchObject({ seq: 3, reset: true });
    expect(next.columns[0].bid).toEqual([[200, 1]]); // complete column, not a delta
    expect(next.levels).toEqual([]);
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 3_000)).toMatchObject({ seq: 4, reset: false });
  });

  test("a new pair is backfilled from the recording while live sampling continues, then the whole history is announced", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    // A stand-in for liquidity-backfill: two columns from "the recording", sampled with the live
    // geometry, plus a wall the worker's own tracker found.
    const wall = { side: "bid", row: 39_997, span: 1, startTs: T0 - 2_000, endTs: null, size: 30, peak: 30, endedBy: null };
    const backfill = async (request) => {
      calls.push(request);
      const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
      for (const [ts, size] of [[T0 - 2_000, 3], [T0 - 1_000, 4]]) {
        const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size }], asks: [] };
        request.onColumn(sampleLiquidityColumn(snapshot, { ts, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      }
      return { columns: 2, frames: 10, reason: null, stats: {}, levels: [wall], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l) });
    // The first tick creates the pair state, starts the backfill, and publishes live at once.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toMatchObject({ reset: true, seq: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ symbol: "BTCUSDT", marketKind: "PERPETUAL", fromTs: T0 - 600_000, toTs: T0, columnMs: 1000, rowClusters: 4, windowRows: 200 });
    expect(calls[0].trackerOptions).toMatchObject({ multiplier: 1.5, gapRows: 2, settleMs: 0 }); // the live tracker's own options
    expect(publisher.activeState).toMatchObject({ length: 3, seq: 3 });
    expect(lines.some((l) => /backfilled 2 columns and 1 walls/.test(l))).toBe(true);
    // The next tick appends the live column and replays everything as a reset: the rebuilt past, then the live columns.
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ reset: true, seq: 4 });
    expect(frames[0].columns.map((c) => c.ts)).toEqual([T0 - 2_000, T0 - 1_000, T0, T0 + 1_000]);
    expect(frames[0].columns[0].bid).toEqual([[200, 3]]);
    expect(frames[0].columns[2].bid).toEqual([[200, 1]]);
    expect(frames[0].columns[3].bid).toEqual([]);
    // The worker's wall was adopted, keeping the start time it had in the recording.
    // The live book has nothing at that row, so this column also ends it: adoption
    // hands the wall over, it does not keep it alive.
    expect(frames[0].levels).toEqual([expect.objectContaining({ side: "bid", row: 39_997, start_ts: T0 - 2_000, peak: 30 })]);
    // Then plain deltas again.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000)).toMatchObject({ reset: false, seq: 5 });
  });

  test("a stored history is restored instead of rebuilt, and only the gap since it is replayed", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    // Two columns as the store keeps them: the first complete, the rest deltas.
    const stored = {
      savedAt: T0 - 4_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 0 },
      recent: [
        { ts: T0 - 5_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] },
        { ts: T0 - 4_000, lo: 39_800, hi: 40_200, bid: [[200, 6]], ask: [] },
      ],
      deep: [],
      levels: [{ side: "bid", row: 40_000, span: 1, startTs: T0 - 300_000, endTs: null, size: 6, peak: 9, endedBy: null, ratio: 3, chain: 0 }],
    };
    const loadHistory = jest.fn(() => stored);
    const saveHistory = jest.fn(() => ({ ok: true, bytes: 10, columns: 2 }));
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, loadHistory, saveHistory, storeDir: "unused", backfillEnabled: true, backfill,
      dbPath: "unused.sqlite", historyS: 600, memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    // The first tick replays what the store gave back at once, with a reset, plus the live column it sampled:
    // the clients were cleared by the pair switch and would drop every delta otherwise.
    const restoredFrames = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(restoredFrames.map((f) => [f.reset, f.columns.length])).toEqual([[true, 3]]);
    expect(restoredFrames[0].levels).toHaveLength(1);
    // Asked for its own pair and geometry, and refused anything older than the window it would have to replay.
    expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({
      pairKey: "PERPETUAL:BTCUSDT", maxAgeMs: 600_000, geometry: stored.geometry,
    }));
    expect(publisher.activeState).toMatchObject({ length: 3, seq: 3 });
    expect(lines.some((l) => /restored 2 columns, 0 deep and 1 walls .* last column 4s old/.test(l))).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // Only the seconds since the last stored column come from the recording.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fromTs: T0 - 3_000, toTs: T0, columnMs: 1_000 });
    // The restored wall kept the age it had before the restart.
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(frames[0].columns.map((c) => c.ts)).toEqual([T0 - 5_000, T0 - 4_000, T0, T0 + 1_000]);
    expect(frames[0].levels).toEqual([expect.objectContaining({ row: 40_000, start_ts: T0 - 300_000 })]);
    expect(frames[0].columns[1].bid).toEqual([[200, 6]]); // the delta decoded and re-encoded unchanged
  });

  test("a store older than the recent window keeps its deep tier and past walls, and the deep pass fills the hole", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    // It rested 90s, so it counts as history rather than a flicker.
    const gone = { side: "bid", row: 39_990, span: 1, startTs: T0 - 3_740_000, endTs: T0 - 3_650_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0 };
    const resting = { side: "bid", row: 39_991, span: 1, startTs: T0 - 3_700_000, endTs: null, size: 20, peak: 20, endedBy: null, ratio: 3, chain: 0 };
    const stored = {
      savedAt: T0 - 3_600_000, // an hour old: past the recent window, inside the deep one
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [gone, resting],
    };
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    // What the store gave back (the deep tier only) is replayed at once, with a reset, and the live column starts the fine tier.
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0).map((f) => [f.column_ms, f.reset, f.columns.length])).toEqual([[10_000, true, 2], [1_000, true, 1]]);
    // The stale fine columns are dropped; the deep ones, worth minutes of replay, are kept.
    expect(publisher.activeState).toMatchObject({ length: 1, deepLength: 2 });
    expect(lines.some((l) => /store .* is 3600s old: kept 2 deep columns/.test(l))).toBe(true);
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The recent window is rebuilt whole, the deep pass covers the hole between the
    // last stored deep column and the start of that window in twenty-minute chunks
    // oldest first, then what lies before the first stored deep column back to the
    // deep window's start, newest first.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.columnMs, c.foldMs])).toEqual([
      [-600_000, 0, 1_000, undefined],
      [-3_590_000, -2_390_000, 1_000, 10_000],
      [-2_390_000, -1_190_000, 1_000, 10_000],
      [-1_190_000, -600_000, 1_000, 10_000],
      [-4_810_000, -3_610_000, 1_000, 10_000],
      [-6_010_000, -4_810_000, 1_000, 10_000],
      [-7_200_000, -6_010_000, 1_000, 10_000],
    ]);
    // Only the wall that had already ended came back: a resting one from an hour ago may be long gone.
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(frames[frames.length - 1].levels.map((l) => [l.row, l.ended_by])).toEqual([[39_990, "pulled"]]);
  });

  test("the history floor hides stored deep columns from the chart but keeps them in the store, as one chain it can read back", async () => {
    // 2026-09-15: a runtime launched with a floor at 12:16 restored nothing of the night and saved the store
    // over it sixty seconds later. Eleven hours of columns were gone from disk for a launch flag.
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_640_000, 5), column(T0 - 3_630_000, 6), column(T0 - 3_620_000, 7), column(T0 - 3_610_000, 8)],
      levels: [],
    };
    const saveHistory = jest.fn(() => ({ ok: true }));
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory, storeS: 60,
      historyS: 600, deepS: 7_200, deepColumnMs: 10_000, historyFloorMs: T0 - 3_625_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    // Two of the four are older than the floor: off the chart, and said so.
    expect(publisher.activeState).toMatchObject({ deepLength: 2 });
    expect(lines.some((l) => /history floor hides 2 stored deep columns for PERPETUAL:BTCUSDT .*; they stay in the store/.test(l))).toBe(true);
    // The next save writes all four, the hidden two first, chained so the store decodes every size as it was.
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 61_000);
    const saved = saveHistory.mock.calls.at(-1)[0];
    expect(saved.deep.slice(0, 4).map((c) => c.ts - T0)).toEqual([-3_640_000, -3_630_000, -3_620_000, -3_610_000]);
    let prev = null;
    const sizes = [];
    for (const wire of saved.deep) {
      prev = decodeColumn(prev, wire);
      sizes.push(sizeAt(prev, "bid", 40_000));
    }
    expect(sizes.slice(0, 4)).toEqual([5, 6, 7, 8]);
    // Read back with no floor, the file gives the chart all four.
    const again = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => ({ ...stored, deep: saved.deep, savedAt: T0 + 61_000 }), saveHistory: () => ({ ok: true }),
      historyS: 600, deepS: 7_200, deepColumnMs: 10_000, memory: memoryWith(engine), now: () => T0 + 62_000,
    });
    again.tick("PERPETUAL", "BTCUSDT", T0 + 62_000);
    expect(again.activeState.deepLength).toBeGreaterThanOrEqual(4);
  });

  test("columns the deep ring lets go of stay in the store behind the ones it keeps", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 2_000), column(T0 - 1_000)],
      deep: [column(T0 - 30_000, 5), column(T0 - 20_000, 6), column(T0 - 10_000, 7)],
      levels: [],
    };
    const saveHistory = jest.fn(() => ({ ok: true }));
    // A three-column deep ring: every live deep column from here on evicts one.
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory, storeS: 60,
      historyS: 10, deepS: 30, deepColumnMs: 10_000, memory: memoryWith(engine), now: () => T0,
    });
    for (let s = 0; s <= 61; s += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + s * 1_000);
    expect(publisher.activeState).toMatchObject({ deepLength: 3 });
    const saved = saveHistory.mock.calls.at(-1)[0];
    expect(saved.deep.slice(0, 3).map((c) => c.ts - T0)).toEqual([-30_000, -20_000, -10_000]);
    expect(saved.deep.length).toBeGreaterThan(3);
    let prev = null;
    const sizes = [];
    for (const wire of saved.deep) {
      prev = decodeColumn(prev, wire);
      sizes.push(sizeAt(prev, "bid", 40_000));
    }
    expect(sizes.slice(0, 3)).toEqual([5, 6, 7]);
    expect(sizes.slice(3).every((size) => size === 1)).toBe(true); // the live book's 1 at row 160,000 / 4 = 40,000
  });

  test("the shelf is pruned to the store's max age on every save, not just the next restore, so a long-lived process stays bounded", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 2_000), column(T0 - 1_000)],
      deep: [column(T0 - 30_000, 5), column(T0 - 20_000, 6), column(T0 - 10_000, 7)],
      levels: [],
    };
    const decodeDeep = (saved) => {
      let prev = null;
      const decoded = [];
      for (const wire of saved.deep) {
        prev = decodeColumn(prev, wire);
        decoded.push(prev);
      }
      return decoded;
    };
    const saveHistory = jest.fn(() => ({ ok: true }));
    let clockMs = T0;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory,
      historyS: 10, deepS: 30, deepColumnMs: 10_000, storeMaxAgeS: 60, storeS: 5,
      memory: memoryWith(engine), now: () => clockMs,
    });
    // Run long enough (five minutes of 1s ticks) for the shelf to accumulate
    // real entries past the ring's own capacity, then to run well past
    // storeMaxAgeS many times over -- the shape of a long-lived process,
    // not a fresh restart.
    for (let s = 0; s <= 300; s += 1) {
      clockMs = T0 + s * 1_000;
      publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
    }
    const saves = saveHistory.mock.calls.map((call) => call[0]);
    const grown = saves.find((saved) => decodeDeep(saved).length > 3);
    expect(grown).toBeDefined(); // the shelf really did accumulate beyond the ring at some point

    const last = saves.at(-1);
    const lastDecoded = decodeDeep(last);
    const cutoff = last.savedAt - 60_000;
    expect(lastDecoded.every((c) => c.ts >= cutoff)).toBe(true);
    for (let i = 1; i < lastDecoded.length; i += 1) expect(lastDecoded[i].ts).toBeGreaterThan(lastDecoded[i - 1].ts);

    // The point of the fix: this five-minute run does not keep growing --
    // it reaches a bounded steady state well before the final save.
    const steady = saves.slice(-5).map((saved) => decodeDeep(saved).length);
    expect(new Set(steady).size).toBe(1);
    expect(steady[0]).toBeLessThan(10);
  });

  test("a save decodes only the shelf columns that aged out plus the one that becomes first, and leaves the rest of the chain as it was", () => {
    // Gate E GE-13: pruneShelf decoded and re-encoded the whole shelf (up to a
    // week of deep columns) on every save, freezing the runtime once a minute.
    const historyModule = "../../../src/indicators/passive_liquidity/liquidity-history";
    const run = (storeMaxAgeS) => {
      let decodes = 0;
      let publisherModule;
      jest.isolateModules(() => {
        jest.doMock(historyModule, () => {
          const actual = jest.requireActual(historyModule);
          return { ...actual, decodeColumn: (prev, wire) => { decodes += 1; return actual.decodeColumn(prev, wire); } };
        });
        publisherModule = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
      });
      jest.dontMock(historyModule);
      const engine = fakeEngine();
      engine.state.bids = [{ key: 160_000, size: 1 }];
      const column = (ts, size) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
      const deep = Array.from({ length: 40 }, (_, i) => column(T0 - 400_000 + i * 10_000, i + 1));
      const stored = {
        savedAt: T0 - 1_000,
        geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
        recent: [column(T0 - 2_000, 9), column(T0 - 1_000, 9)],
        deep,
        levels: [],
      };
      const saveHistory = jest.fn(() => ({ ok: true }));
      let clockMs = T0;
      const publisher = publisherModule.createLiquidityPublisher({
        ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory,
        historyS: 10, deepS: 30, deepColumnMs: 10_000, storeMaxAgeS, storeS: 5,
        memory: memoryWith(engine), now: () => clockMs,
      });
      publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
      decodes = 0;
      for (let s = 1; s <= 5; s += 1) {
        clockMs = T0 + s * 1_000;
        publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
      }
      expect(saveHistory).toHaveBeenCalledTimes(1);
      let prev = null;
      const sizes = [];
      for (const wire of saveHistory.mock.calls[0][0].deep) {
        prev = decodeColumn(prev, wire);
        sizes.push(sizeAt(prev, "bid", 40_000));
      }
      return { decodes, sizes };
    };

    const nothingOld = run(3_600);
    expect(nothingOld.decodes).toBe(0);
    expect(nothingOld.sizes).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    const oneOld = run(402);
    expect(oneOld.decodes).toBe(2);
    expect(oneOld.sizes).toEqual(Array.from({ length: 39 }, (_, i) => i + 2));
  });

  test("a column rebuilt behind the tier and let go of again never lands behind a newer one in the store: the file stays one chain in time order", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 2_000), column(T0 - 1_000)],
      deep: [column(T0 - 10_000, 5)],
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    let releaseSecondChunk;
    const secondChunkGate = new Promise((resolve) => { releaseSecondChunk = resolve; });
    const backfill = async (request) => {
      if (request.foldMs === undefined) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      if (request.fromTs === T0 - 30_000) await secondChunkGate;
      request.onColumn(sampleLiquidityColumn(engine.snapshot(), { ts: request.fromTs + 5_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const saveHistory = jest.fn(() => ({ ok: true }));
    const lines = [];
    // A four-column ring, ten-second chunks behind the one stored column: three chunks, newest first.
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory,
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 40, deepColumnMs: 10_000, deepChunkS: 10,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    const behind = () => lines.filter((l) => /behind the stored tier/.test(l)).length;
    for (let i = 0; i < 40 && behind() < 1; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(behind()).toBe(1);
    // Live columns fill the ring and push the oldest two out to the store's shelf while the second chunk is still being read.
    for (let s = 1; s <= 41; s += 1) publisher.tick("PERPETUAL", "BTCUSDT", T0 + s * 1_000);
    releaseSecondChunk();
    for (let i = 0; i < 80 && behind() < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(behind()).toBe(3);
    // The last two chunks landed older columns that the ring let go of at once, behind what the shelf already ends at.
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 61_000);
    const saved = saveHistory.mock.calls.at(-1)[0];
    const ts = saved.deep.map((c) => c.ts - T0);
    expect(ts).toEqual([-15_000, -10_000, 0, 10_000, 20_000, 30_000]);
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1])).toBe(true);
  });

  test("the hole in front of the stored tier is rebuilt in chunks too, oldest first, and a chunk that fails does not cost the others", async () => {
    // 2026-09-15: a five-hour gap in front of the store was one window against a five-minute pass timeout, so it rebuilt nothing.
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      if (request.foldMs === undefined || request.fromTs < T0 - 3_590_000) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      if (request.fromTs === T0 - 2_390_000) throw new Error("pass timed out");
      request.onColumn(sampleLiquidityColumn(engine.snapshot(), { ts: request.fromTs + 10_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The recent window, then the hole in twenty-minute chunks oldest first, then the chunks behind the stored tier newest first.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0])).toEqual([
      [-600_000, 0], [-3_590_000, -2_390_000], [-2_390_000, -1_190_000], [-1_190_000, -600_000],
      [-4_810_000, -3_610_000], [-6_010_000, -4_810_000], [-7_200_000, -6_010_000],
    ]);
    expect(lines.filter((l) => /deep backfill failed for PERPETUAL:BTCUSDT \(20 min from .*pass timed out/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /deep-backfilled 1 columns .* before the live window/.test(l))).toHaveLength(2);
    expect(lines.filter((l) => /no deep backfill for PERPETUAL:BTCUSDT \(NO_DATA_IN_WINDOW\)/.test(l))).toHaveLength(0);
    // Two stored, two rebuilt either side of the failed chunk; the tier goes out whole with a reset, in time order.
    expect(publisher.activeState).toMatchObject({ deepLength: 4 });
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const deep = frames.filter((f) => f.column_ms === 10_000);
    expect(deep[0].reset).toBe(true);
    expect(deep.flatMap((f) => f.columns.map((c) => c.ts - T0))).toEqual([-3_610_000, -3_600_000, -3_580_000, -1_180_000]);
  });

  test("the deep pass also rebuilds what lies before the stored tier, in chunks newest first, and the tier is replayed whole", async () => {
    // 2026-09-14: the collector had recorded since 12:02, the store held 18:34 on, and an eleven-hour deep window
    // rebuilt one column: the pass only ever looked forward from what the store gave back.
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      if (request.foldMs === undefined || request.toTs > T0 - 3_610_000) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      // A pass behind the stored tier: one deep column, ten seconds into its window.
      request.onColumn(sampleLiquidityColumn(engine.snapshot(), { ts: request.fromTs + 10_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 14_400, deepColumnMs: 10_000, deepChunkS: 7_200,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The recent window, the hole up to it, then chunks of the given two hours from the first stored deep column back to the window's start.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.foldMs])).toEqual([
      [-600_000, 0, undefined],
      [-3_590_000, -600_000, 10_000],
      [-10_810_000, -3_610_000, 10_000],
      [-14_400_000, -10_810_000, 10_000],
    ]);
    // Both chunks landed in front of the stored columns, in time order, and the whole tier is replayed with a reset.
    expect(publisher.activeState).toMatchObject({ deepLength: 4 });
    expect(lines.filter((l) => /behind the stored tier/.test(l))).toHaveLength(2);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const deep = frames.filter((f) => f.column_ms === 10_000);
    expect(deep[0].reset).toBe(true);
    expect(deep.flatMap((f) => f.columns.map((c) => c.ts - T0))).toEqual([-14_390_000, -10_800_000, -3_610_000, -3_600_000]);
    // The replay put every client back in step: the next live deep column chains on it, with no reset that would wipe the tier.
    const later = [];
    for (let i = 2; i <= 11; i += 1) later.push(publisher.tick("PERPETUAL", "BTCUSDT", T0 + i * 1_000));
    expect(later.flat().filter((f) => f && f.column_ms === 10_000).map((f) => [f.reset, f.seq, f.columns.length, f.ts - T0])).toEqual([[false, 5, 1, 0]]);
  });

  test("a chunk that fails is logged and skipped; the chunks behind it still land", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      if (request.foldMs === undefined || request.toTs > T0 - 3_610_000) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      if (request.toTs === T0 - 3_610_000) throw new Error("pass timed out");
      request.onColumn(sampleLiquidityColumn(engine.snapshot(), { ts: request.fromTs + 10_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 14_400, deepColumnMs: 10_000, deepChunkS: 7_200,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0])).toEqual([[-600_000, 0], [-3_590_000, -600_000], [-10_810_000, -3_610_000], [-14_400_000, -10_810_000]]);
    expect(lines.filter((l) => /behind the stored tier failed .*pass timed out/.test(l))).toHaveLength(1);
    expect(publisher.activeState).toMatchObject({ deepLength: 3 });
  });

  test("with no hole between the stored deep tier and the recent window, the deep pass still rebuilds behind the tier", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 601_000), column(T0 - 600_000)],
      deep: [column(T0 - 610_000), column(T0 - 600_000)],
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      if (request.foldMs === undefined) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      request.onColumn(sampleLiquidityColumn(engine.snapshot(), { ts: request.fromTs + 10_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
      return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0,
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The fresh store's fine columns run to the recent window's edge, so the recent pass starts a second later; nothing to fill
    // before it, and the default twenty-minute chunks reach back to the deep window's start.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.foldMs])).toEqual([
      [-599_000, 0, undefined],
      [-1_810_000, -610_000, 10_000],
      [-3_010_000, -1_810_000, 10_000],
      [-4_210_000, -3_010_000, 10_000],
      [-5_410_000, -4_210_000, 10_000],
      [-6_610_000, -5_410_000, 10_000],
      [-7_200_000, -6_610_000, 10_000],
    ]);
    expect(publisher.activeState).toMatchObject({ deepLength: 8 });
  });

  function repairFixture({ collectorHasTrades }) {
    // 2026-09-14 20:12 on ETH perp: the trade queue overflowed for a minute and the columns of that
    // stretch carry no flow, while the collector (its own connection) kept every trade.
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const D0 = T0 - 3_600_000;
    const column = (ts, flow) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [], buy: flow ? [[0, 1]] : [], sell: [] });
    const deep = [];
    for (let i = 0; i < 30; i += 1) deep.push(column(D0 + i * 10_000, i < 10 || i > 21));
    const stored = {
      savedAt: T0 - 3_300_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_301_000, true), column(T0 - 3_300_000, true)],
      deep,
      levels: [],
    };
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      if (request.foldMs === undefined || request.toTs !== D0 + 220_000) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
      for (let ts = request.fromTs; ts < request.toTs; ts += 10_000) {
        const sampled = sampleLiquidityColumn(engine.snapshot(), { ts, rowClusters: request.rowClusters, windowRows: request.windowRows });
        request.onColumn({ ...sampled, buy: collectorHasTrades ? [[0, 2]] : [], sell: [] });
      }
      return { columns: 12, frames: 60, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 3_600, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    return { publisher, calls, lines, D0 };
  }

  test("a stretch of stored deep columns with no flow is rebuilt from the recording and the tier replayed whole", async () => {
    const { publisher, calls, lines, D0 } = repairFixture({ collectorHasTrades: true });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The recent window, the hole up to it in twenty-minute chunks, then the flow-less stretch (columns 10 to 21, two minutes).
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.foldMs])).toEqual([
      [-600_000, 0, undefined],
      [-3_300_000, -2_100_000, 10_000],
      [-2_100_000, -900_000, 10_000],
      [-900_000, -600_000, 10_000],
      [D0 + 100_000 - T0, D0 + 220_000 - T0, 10_000],
    ]);
    expect(publisher.activeState).toMatchObject({ deepLength: 30 });
    expect(lines.filter((l) => /repaired 12 columns/.test(l))).toHaveLength(1);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const deep = frames.filter((f) => f.column_ms === 10_000);
    expect(deep[0].reset).toBe(true);
    const columns = deep.flatMap((f) => f.columns);
    expect(columns).toHaveLength(30);
    expect(columns.map((c) => c.ts - D0)).toEqual(columns.map((_, i) => i * 10_000));
    expect(columns.slice(10, 22).every((c) => c.buy.length === 1 && c.buy[0][1] === 2)).toBe(true);
    expect(columns.filter((c) => c.buy.length === 0)).toHaveLength(0);
  });

  test("a flow-less stretch the recording cannot fill is left as it is and not asked for again", async () => {
    const { publisher, calls, lines } = repairFixture({ collectorHasTrades: false });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    // A save tick while the rebuild is still running does not start a second chain over the same stretch.
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 60_000);
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(5); // the recent window, the hole in three chunks, the repair
    expect(lines.filter((l) => /holds no trades/.test(l))).toHaveLength(1);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 61_000);
    expect(frames.filter((f) => f.column_ms === 10_000).flatMap((f) => f.columns).filter((c) => c.ts < T0 && c.buy.length === 0)).toHaveLength(12);
    // The next save tick scans again and finds nothing new to ask for.
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 121_000);
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(5);
  });

  test("a flow-less stretch that ended less than two minutes ago waits: the recording may not hold its trades yet", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const D0 = T0 - 300_000;
    const column = (ts, flow) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [], buy: flow ? [[0, 1]] : [], sell: [] });
    const deep = [];
    for (let i = 0; i < 30; i += 1) deep.push(column(D0 + i * 10_000, i < 5 || (i > 16 && i < 22)));
    const stored = {
      savedAt: T0 - 10_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 11_000, true), column(T0 - 10_000, true)],
      deep,
      levels: [],
    };
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 3_600, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // The gap since the store, then the stretch of columns 5 to 16 (ended 130 s ago) ahead of the chunks
    // before the stored tier; the stretch of columns 22 to 29 ended just now and is not asked for.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.foldMs])).toEqual([
      [-9_000, 0, undefined],
      [-250_000, -130_000, 10_000],
      [-1_500_000, -300_000, 10_000],
      [-2_700_000, -1_500_000, 10_000],
      [-3_600_000, -2_700_000, 10_000],
    ]);
  });

  test("a restored wall that ended after the last deep column still rides the snapshot: the frame's ts covers every wall it carries", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const lastDeep = T0 - 3_608_000;
    const lastRecent = T0 - 3_600_000;
    const gone = { side: "bid", row: 39_990, span: 1, startTs: T0 - 3_740_000, endTs: lastRecent - 2_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0 };
    const stored = {
      savedAt: lastRecent,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(lastRecent - 1_000), column(lastRecent)],
      deep: [column(lastDeep - 10_000), column(lastDeep)],
      levels: [gone],
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill: async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] }),
      dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    // A dead book on the first tick: the restored deep tier and its walls are all the snapshot has.
    engine.live = false;
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toBeNull();
    const frames = publisher.snapshotFrames("PERPETUAL", "BTCUSDT");
    expect(lines.filter((l) => /snapshot failed/.test(l))).toEqual([]);
    expect(frames.map((f) => [f.column_ms, f.reset, f.columns.length, f.ts])).toEqual([[10_000, true, 2, gone.endTs]]);
    expect(frames[0].levels.map((l) => [l.row, l.end_ts, l.ended_by])).toEqual([[39_990, gone.endTs, "pulled"]]);
    expect(publisher.activeState).toMatchObject({ length: 0, deepLength: 2 });
  });

  test("a store from the day before still comes back, its deep tier and past walls, and the floor cuts what is older", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const FLOOR = T0 - 72_000_000; // 20 h ago
    const older = { side: "bid", row: 39_990, span: 1, startTs: T0 - 80_000_000, endTs: T0 - 79_000_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0 };
    const kept = { side: "bid", row: 39_991, span: 1, startTs: T0 - 71_000_000, endTs: T0 - 70_000_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0 };
    const stored = {
      savedAt: T0 - 70_000_000, // about 19.5 h old: far past the deep window, inside the week a store is kept
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 70_001_000), column(T0 - 70_000_000)],
      deep: [column(T0 - 73_000_000), column(T0 - 72_000_000), column(T0 - 71_000_000), column(T0 - 70_000_000)],
      levels: [older, kept],
    };
    const loadHistory = jest.fn(() => stored);
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      historyFloorMs: FLOOR, memory: memoryWith(engine), now: () => T0,
    });
    // The store is asked for with a week's allowance, not the deep window's four hours.
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ maxAgeMs: 7 * 24 * 3_600_000 }));
    // The deep column before the floor is off the chart (it stays in the store), the three at or after it are back; only the wall born after the floor.
    expect(publisher.activeState).toMatchObject({ length: 1, deepLength: 3 });
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(frames[frames.length - 1].levels.map((l) => l.row)).toEqual([39_991]);
    // The deep pass fills only the last two hours (the deep window), in twenty-minute chunks oldest first, never past the floor.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.columnMs, c.foldMs])).toEqual([
      [-600_000, 0, 1_000, undefined],
      [-7_200_000, -6_000_000, 1_000, 10_000],
      [-6_000_000, -4_800_000, 1_000, 10_000],
      [-4_800_000, -3_600_000, 1_000, 10_000],
      [-3_600_000, -2_400_000, 1_000, 10_000],
      [-2_400_000, -1_200_000, 1_000, 10_000],
      [-1_200_000, -600_000, 1_000, 10_000],
    ]);
  });

  test("a fresh store with no retained recent column after the history floor still starts safely", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY,
      storeEnabled: true,
      loadHistory: () => ({
        savedAt: T0 - 100,
        geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 0 },
        recent: [column(T0 - 1_000)],
        deep: [],
        levels: [{ side: "bid", row: 40_000, span: 1, startTs: T0 - 200, endTs: null, size: 9, peak: 9, endedBy: null, ratio: 3, chain: 0 }],
      }),
      saveHistory: () => ({ ok: true }),
      historyFloorMs: T0 - 500,
      memory: memoryWith(engine), now: () => T0, log: (line) => lines.push(line),
    });

    expect(() => publisher.tick("PERPETUAL", "BTCUSDT", T0)).not.toThrow();
    expect(lines).toContainEqual(expect.stringMatching(/no recent column after the history floor/));
  });

  test("a long gap is replayed at fine resolution only for the last minutes; the deep pass takes the rest in the background", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 400_000, // the runtime was down for 400 s while the collector kept recording
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 401_000), column(T0 - 400_000)],
      deep: [column(T0 - 410_000), column(T0 - 400_000)],
      levels: [],
    };
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000, backfillMaxS: 120,
      memory: memoryWith(engine), now: () => T0,
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // Fine replay: the last 120 s only. Deep pass: from the last stored deep column up to where
    // the fine replay begins, then from the deep window's start up to the first stored deep column.
    expect(calls.map((c) => [c.fromTs - T0, c.toTs - T0, c.columnMs, c.foldMs])).toEqual([
      [-120_000, 0, 1_000, undefined],
      [-390_000, -120_000, 1_000, 10_000],
      [-1_610_000, -410_000, 1_000, 10_000],
      [-2_810_000, -1_610_000, 1_000, 10_000],
      [-4_010_000, -2_810_000, 1_000, 10_000],
      [-5_210_000, -4_010_000, 1_000, 10_000],
      [-6_410_000, -5_210_000, 1_000, 10_000],
      [-7_200_000, -6_410_000, 1_000, 10_000],
    ]);
  });

  test("a store that will not load is dropped and the recording rebuilds the window", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const backfill = async (request) => {
      calls.push(request);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600,
      // Columns that decode but cannot be appended in this order.
      loadHistory: () => ({ savedAt: T0, geometry: {}, deep: [], levels: [], recent: [{ ts: T0, lo: 39_800, hi: 40_200, bid: [], ask: [] }, { ts: T0 - 1_000, lo: 39_800, hi: 40_200, bid: [], ask: [] }] }),
      saveHistory: () => ({ ok: true }), memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toMatchObject({ reset: true, seq: 1 });
    expect(publisher.activeState).toMatchObject({ length: 1 });
    expect(lines.some((l) => /would not load .* rebuilding from the recording/.test(l))).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls[0]).toMatchObject({ fromTs: T0 - 600_000, toTs: T0 }); // the whole window, as before
  });

  test("the history is written after a rebuild, on the clock, and on the way out", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const saveHistory = jest.fn(() => ({ ok: true, bytes: 10, columns: 1 }));
    let at = T0;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", storeS: 60, saveHistory, loadHistory: () => null,
      backfillEnabled: true, dbPath: "unused.sqlite", historyS: 600,
      backfill: async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [] }),
      memory: memoryWith(engine), now: () => at,
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(saveHistory).toHaveBeenCalledTimes(1); // the rebuild landed: the live column sampled meanwhile is worth keeping
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 2_000);
    expect(saveHistory).toHaveBeenCalledTimes(1); // the clock has not come round
    at = T0 + 61_000;
    publisher.tick("PERPETUAL", "BTCUSDT", T0 + 61_000);
    expect(saveHistory).toHaveBeenCalledTimes(2);
    expect(saveHistory.mock.calls[1][0]).toMatchObject({
      pairKey: "PERPETUAL:BTCUSDT",
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 0 },
    });
    // The columns go out delta encoded, the first one whole, as the store expects them.
    const written = saveHistory.mock.calls[1][0];
    expect(written.recent.map((c) => c.ts)).toEqual([T0, T0 + 1_000, T0 + 2_000]);
    expect(written.recent[0].bid).toEqual([[200, 1]]);
    expect(written.recent[1].bid).toEqual([]);
    expect(Array.isArray(written.levels)).toBe(true);
    publisher.stop();
    expect(saveHistory).toHaveBeenCalledTimes(3);
  });

  test("the store can be switched off, and the environment says so", () => {
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_STORE: "0", L2_HEATMAP_STORE_DIR: "C:/cache", L2_HEATMAP_STORE_S: "30" }))
      .toEqual({ storeEnabled: false, storeDir: "C:/cache", storeS: 30 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_STORE: "1" })).toEqual({ storeEnabled: true });
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const loadHistory = jest.fn();
    const saveHistory = jest.fn();
    const publisher = createLiquidityPublisher({ ...GEOMETRY, storeEnabled: false, loadHistory, saveHistory, memory: memoryWith(engine), now: () => T0 });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    publisher.stop();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(saveHistory).not.toHaveBeenCalled();
  });

  test("a failed backfill is logged and live sampling starts from scratch", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill: async () => { throw new Error("disk on fire"); }, dbPath: "unused.sqlite",
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toMatchObject({ reset: true, seq: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.some((l) => /backfill failed .* disk on fire/.test(l))).toBe(true);
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).toMatchObject({ reset: false, seq: 2 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL: "0", L2_HEATMAP_DB_PATH: "C:/x.sqlite" })).toEqual({ backfillEnabled: false, dbPath: "C:/x.sqlite" });
    // On by default; the environment can still say so, or turn it off.
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_BACKFILL: "1" })).toEqual({ backfillEnabled: true });
  });

  test("a tick failure is logged, not thrown, and the clock keeps running", () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const engine = fakeEngine();
    engine.snapshot = () => {
      throw new Error("boom");
    };
    const lines = [];
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), log: (line) => lines.push(line) });
    publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: () => {} });
    jest.advanceTimersByTime(2_100);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/boom/);
    publisher.stop();
    jest.useRealTimers();
  });

  it("hands the band-history handler the rows the heatmap is using, and null for a pair it has not sampled or an engine without a tick", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    Object.assign(engine, { tickSize: 0.1, clusterTicks: 5 });
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    expect(publisher.geometryFor("PERPETUAL", "BTCUSDT")).toBeNull();
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(publisher.geometryFor("PERPETUAL", "BTCUSDT")).toEqual({ rowWidth: 2, rowClusters: 4, tickSize: 0.1, clusterTicks: 5 });
    expect(publisher.geometryFor("SPOT", "BTCUSDT")).toBeNull();
    engine.tickSize = 0;
    expect(publisher.geometryFor("PERPETUAL", "BTCUSDT")).toBeNull();
  });
});

// Report 57 W2, GE-17 (owner decision: about 48 MB, oldest first). The shelf
// is bounded by age only (seven days by default), and a dense book's week of
// deep columns is far larger than the store's 64 MiB read cap, so a
// long-lived process used to write a file that the next start refused
// outright. The publisher now keeps the store under a byte budget by dropping
// the oldest shelf columns, keeps the newest history, and records where the
// trimmed history now begins.
describe("liquidity-publisher store byte budget (GE-17)", () => {
  test("a long run stays under the byte budget, trims oldest first and advertises the trim", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 2_000), column(T0 - 1_000)],
      deep: [column(T0 - 30_000, 5), column(T0 - 20_000, 6), column(T0 - 10_000, 7)],
      levels: [],
    };
    const BUDGET = 1_500;
    const accepted = [];
    let refused = 0;
    const saveHistory = jest.fn((args) => {
      const bytes = JSON.stringify({ recent: args.recent, deep: args.deep, levels: args.levels, trimmedBefore: args.trimmedBefore }).length;
      if (bytes > args.maxBytes) {
        refused += 1;
        return { ok: false, reason: "OVER_BUDGET", bytes };
      }
      accepted.push({ ...args, bytes });
      return { ok: true, bytes };
    });
    const lines = [];
    let clockMs = T0;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory,
      historyS: 10, deepS: 30, deepColumnMs: 10_000, storeMaxAgeS: 3_600, storeS: 5, storeMaxBytes: BUDGET,
      memory: memoryWith(engine), now: () => clockMs, log: (line) => lines.push(line),
    });
    for (let s = 0; s <= 600; s += 1) {
      clockMs = T0 + s * 1_000;
      publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
    }
    expect(refused).toBeGreaterThan(0);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((save) => save.bytes <= BUDGET && save.maxBytes === BUDGET)).toBe(true);

    const last = accepted.at(-1);
    let prev = null;
    const decoded = last.deep.map((wire) => (prev = decodeColumn(prev, wire)));
    for (let i = 1; i < decoded.length; i += 1) expect(decoded[i].ts).toBeGreaterThan(decoded[i - 1].ts);
    expect(decoded.at(-1).ts).toBeGreaterThanOrEqual(clockMs - 30_000);
    expect(last.trimmedBefore).toBe(decoded[0].ts);
    expect(decoded[0].ts).toBeGreaterThan(T0);
    expect(lines.some((line) => /trimmed/.test(line))).toBe(true);
    publisher.stop();
  });

  test("a restore the store refuses is logged with its reason, not silently dropped (L-AY2)", () => {
    const lines = [];
    const loadHistory = jest.fn(({ onReject }) => {
      onReject("TOO_LARGE");
      return null;
    });
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory, saveHistory: () => ({ ok: true }),
      memory: memoryWith(fakeEngine()), now: () => T0, log: (line) => lines.push(line),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(loadHistory).toHaveBeenCalled();
    expect(lines.some((line) => /TOO_LARGE/.test(line) && /PERPETUAL:BTCUSDT/.test(line))).toBe(true);
    publisher.stop();
  });

  test("the budget defaults to 48 MiB and can be set from the environment", () => {
    expect(DEFAULT_STORE_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_STORE_MAX_BYTES: "1000000" })).toMatchObject({ storeMaxBytes: 1_000_000 });
  });
});

// Report 57 W2, FA-6: the periodic store save runs in the background (one at
// a time per pair) instead of blocking the tick; the shutdown save stays
// synchronous and supersedes any background write still in flight.
describe("liquidity-publisher background store saves (FA-6)", () => {
  test("periodic saves go to the background writer, never overlap, and a shutdown save supersedes the one in flight", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const inFlight = [];
    const saveHistoryInBackground = jest.fn((_args, options) => new Promise((resolve) => inFlight.push({ resolve, options })));
    const saveHistory = jest.fn(() => ({ ok: true }));
    let clockMs = T0;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory, saveHistoryInBackground,
      historyS: 10, storeS: 5, memory: memoryWith(engine), now: () => clockMs,
    });
    for (let s = 0; s <= 30; s += 1) {
      clockMs = T0 + s * 1_000;
      publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
    }
    expect(saveHistoryInBackground).toHaveBeenCalledTimes(1);
    expect(saveHistory).not.toHaveBeenCalled();
    expect(inFlight[0].options.shouldCommit()).toBe(true);
    publisher.stop();
    expect(saveHistory).toHaveBeenCalled();
    expect(inFlight[0].options.shouldCommit()).toBe(false);
  });

  test("a background save over the budget trims the shelf for the next save", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const lines = [];
    let clockMs = T0;
    const column = (ts, size = 9) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, size]], ask: [] });
    const stored = {
      savedAt: T0 - 1_000, geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 2_000), column(T0 - 1_000)], deep: [column(T0 - 30_000, 5), column(T0 - 20_000, 6), column(T0 - 10_000, 7)], levels: [],
    };
    const saveHistoryInBackground = jest.fn(async () => ({ ok: false, reason: "OVER_BUDGET", bytes: 10_000_000 }));
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }), saveHistoryInBackground,
      historyS: 10, deepS: 30, deepColumnMs: 10_000, storeMaxAgeS: 3_600, storeS: 5, storeMaxBytes: 1_000,
      memory: memoryWith(engine), now: () => clockMs, log: (line) => lines.push(line),
    });
    for (let s = 0; s <= 120; s += 1) {
      clockMs = T0 + s * 1_000;
      publisher.tick("PERPETUAL", "BTCUSDT", clockMs);
      await Promise.resolve();
    }
    expect(saveHistoryInBackground.mock.calls.length).toBeGreaterThan(1);
    expect(lines.some((line) => /trimmed/.test(line))).toBe(true);
    publisher.stop();
  });

  test("a restored store holding a column over the wire magnitude loses that column, not the pair: the next snapshot is sent and the store is kept", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const dropHistory = jest.fn(() => true);
    const stored = {
      savedAt: T0 - 1_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 0 },
      recent: [
        { ts: T0 - 2_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [], buy: [], sell: [[22, 17_000_000]], prints: [], printsFloor: 0 },
        { ts: T0 - 1_000, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [], buy: [], sell: [], prints: [], printsFloor: 0 },
      ],
      deep: [],
      levels: [],
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }), dropHistory,
      memory: memoryWith(engine), now: () => T0, log: (line) => lines.push(line),
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toEqual([]);
    expect(lines.some((line) => /dropped 1 column for PERPETUAL:BTCUSDT that cannot be sent/.test(line))).toBe(true);
    expect(dropHistory).not.toHaveBeenCalled();
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    expect(Array.isArray(frames) && frames.length > 0).toBe(true);
    expect(frames[0]).toMatchObject({ reset: true });
    expect(frames.flatMap((frame) => frame.columns.map((column) => column.ts))).toEqual([T0 - 1_000, T0, T0 + 1_000]);
    expect(publisher.stats().retentionByPair["PERPETUAL:BTCUSDT"].recentColumns).toBe(3);
  });

  test("a print over the wire magnitude is clipped where the column is made, and the stats count it", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    let pending = [{ ts: T0 - 500, price: 80_000, size: 17_000_000, side: "sell", id: "auction" }];
    engine.drainPrints = () => { const out = pending; pending = []; return out; };
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), now: () => T0 });
    const frame = publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(frame).not.toBeNull();
    const column = frame.columns[0];
    expect(column.sell.every(([, size]) => size <= MAX_WIRE_MAGNITUDE)).toBe(true);
    expect(column.sell.some(([, size]) => size === MAX_WIRE_MAGNITUDE)).toBe(true);
    expect(publisher.stats().flowClipped).toBe(1);
    publisher.stop();
  });

  test("a wall standing at the end of a replayed window hands its birth to the wall born there, window after window, so a wall that stood for an hour is dated an hour back", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const wall = (startTs, endTs = null, endedBy = null) => ({ side: "bid", row: 39_991, span: 1, startTs, endTs, size: endTs === null ? 20 : 0, peak: 20, endedBy, ratio: 3, chain: 0 });
    const backfill = async (request) => {
      calls.push([request.fromTs - T0, request.toTs - T0]);
      if (request.foldMs === undefined) return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs)], aggressive: [] };
      return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs)], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 70, deepColumnMs: 10_000, deepChunkS: 20,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([[-10_000, 0], [-70_000, -50_000], [-50_000, -30_000], [-30_000, -10_000]]);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const levels = (Array.isArray(frames) ? frames : [frames]).flatMap((frame) => frame.levels ?? []);
    expect(levels).toEqual([expect.objectContaining({ row: 39_991, start_ts: T0 - 70_000, end_ts: null })]);
    expect(lines.filter((l) => /birth from an earlier window/.test(l))).toEqual(["liquidity-publisher: 3 walls for PERPETUAL:BTCUSDT got their birth from an earlier window"]);
    expect(publisher.activeStateForTests().standing).toEqual([]);
  });

  test("a wall standing at the live start takes its birth from the recording's fill chunk before it, when no deep pass replayed that stretch (ticket item 2)", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const wall = (startTs, endTs = null, endedBy = null) => ({ side: "bid", row: 39_991, span: 1, startTs, endTs, size: endTs === null ? 20 : 0, peak: 20, endedBy, ratio: 3, chain: 0 });
    const grid = { rowClusters: 0, windowRows: 0 };
    const backfill = async (request) => {
      calls.push([request.fromTs - T0, request.toTs - T0, request.background === true]);
      grid.rowClusters = request.rowClusters;
      grid.windowRows = request.windowRows;
      if (request.foldMs === undefined) return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs)], aggressive: [] };
      if (request.background === true) return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs)], aggressive: [], events: null };
      return { columns: 0, frames: 0, reason: "WORKER_EXITED", stats: null, levels: [], aggressive: [], events: null };
    };
    const lines = [];
    const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
    const deep = () => Array.from({ length: 6 }, (_, i) => sampleLiquidityColumn({ bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 7 }], asks: [] }, { ts: T0 - 70_000 + i * 10_000, rowClusters: grid.rowClusters, windowRows: grid.windowRows }));
    const pyramid = { pinned: () => null, deepColumns: async () => ({ columns: deep(), reason: null }) };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 70, deepColumnMs: 10_000, deepChunkS: 20, fillHistoryS: 120, pyramid,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 120; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter(([, , background]) => background)[0]).toEqual([-30_000, -10_000, true]);
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const levels = (Array.isArray(frames) ? frames : [frames]).flatMap((frame) => frame.levels ?? []);
    expect(levels).toEqual([expect.objectContaining({ row: 39_991, start_ts: T0 - 120_000, end_ts: null })]);
    expect(lines.filter((l) => /birth from an earlier window/.test(l))).toEqual(Array.from({ length: 6 }, () => "liquidity-publisher: 1 wall for PERPETUAL:BTCUSDT got its birth from an earlier window"));
    publisher.stop();
  });

  test("the startup pass's events land in the event history, and a batch the history cannot take is logged (PR #31 review)", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const passEvents = (columnMs) => ({ version: 1, columnMs, deepColumnMs: columnMs, fill: null, trades: [[T0 - 6_000, columnMs, 40_000, "buy", "absorbed", 2, 1]], wallTrades: [] });
    const run = async (columnMs) => {
      const lines = [];
      const backfill = async (request) => ({ columns: 0, frames: 10, reason: null, stats: {}, levels: [], aggressive: [], events: request.foldMs === undefined ? passEvents(columnMs) : null });
      const publisher = createLiquidityPublisher({
        ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, deepChunkS: 20,
        memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
      });
      publisher.tick("PERPETUAL", "BTCUSDT", T0);
      for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const records = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: T0 - 20_000, toTs: T0 }).records.map((r) => r.ts - T0);
      publisher.stop();
      return { records, lines };
    };
    const taken = await run(1_000);
    expect(taken.records).toEqual([-6_000]);
    expect(taken.lines.some((l) => /could not take/.test(l))).toBe(false);
    const refused = await run(2_000);
    expect(refused.records).toEqual([]);
    expect(refused.lines.some((l) => /the event history for PERPETUAL:BTCUSDT could not take the events of the startup pass/.test(l))).toBe(true);
  });

  test("a wall whose birth moves back after the wall history took it is kept once, under its earlier birth (PR #31 review)", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    let open = null;
    const gate = new Promise((resolve) => { open = resolve; });
    const wall = (startTs, endTs = null, endedBy = null) => ({ side: "bid", row: 39_991, span: 1, startTs, endTs, size: endTs === null ? 20 : 0, peak: 20, endedBy, ratio: 3, chain: 0 });
    const backfill = async (request) => {
      if (request.foldMs === undefined) return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs, request.fromTs + 5_000, "pulled")], aggressive: [] };
      await gate;
      return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs)], aggressive: [] };
    };
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 70, deepColumnMs: 10_000, deepChunkS: 20,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const births = () => publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: T0 - 600_000, toTs: T0 + 60_000 }).walls.filter((entry) => entry.row === 39_991).map((entry) => entry.startTs - T0);
    expect(births()).toEqual([-10_000]);
    open();
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(births()).toEqual([-70_000]);
    publisher.stop();
  });

  test("a wall standing in a stale store is the wall the first replayed window after it saw from its first column", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const resting = { side: "bid", row: 39_991, span: 1, startTs: T0 - 7_200_000, endTs: null, size: 20, peak: 20, endedBy: null, ratio: 3, chain: 0 };
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [resting],
    };
    const backfill = async (request) => {
      if (request.fromTs === T0 - 3_590_000) {
        return { columns: 0, frames: 10, reason: null, stats: {}, levels: [{ ...resting, startTs: request.fromTs, endTs: T0 - 3_000_000, size: 0, endedBy: "pulled" }], aggressive: [] };
      }
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }), storeS: 60,
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(publisher.activeStateForTests().standing).toEqual([{ level: resting, until: T0 - 3_600_000, toleranceMs: 71_000 }]);
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const frames = publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000);
    const levels = (Array.isArray(frames) ? frames : [frames]).flatMap((frame) => frame.levels ?? []);
    expect(levels).toEqual([expect.objectContaining({ row: 39_991, start_ts: T0 - 7_200_000, end_ts: T0 - 3_000_000, ended_by: "pulled" })]);
    expect(publisher.activeStateForTests().standing).toEqual([]);
  });

  test("the wall history takes a wall the moment it ends, sweeps the tracker's list at each store save, writes its own file and reads it back for a new state", async () => {
    const engine = fakeEngine();
    const thin = Array.from({ length: 20 }, (_, i) => ({ key: 160_000 - 4 * i, size: 1 }));
    engine.state.bids = [...thin, { key: 159_600, size: 100 }];
    const saves = [];
    const saveWallHistory = jest.fn(async (request) => { saves.push(request); return { ok: true, bytes: 100 }; });
    let stored = null;
    const loadWallHistory = jest.fn(({ suffix }) => (suffix === "walls" ? stored : null));
    const lines = [];
    const options = {
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", storeS: 1, loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory, loadWallHistory,
      memory: memoryWith(engine), log: (l) => lines.push(l),
    };
    let at = T0;
    const publisher = createLiquidityPublisher({ ...options, now: () => at });
    expect(() => createLiquidityPublisher({ ...options, now: () => at, wallHistoryMaxBytes: 0 })).toThrow(/wallHistoryMaxBytes/);
    expect(() => createLiquidityPublisher({ ...options, now: () => at, loadWallHistory: "x" })).toThrow(/loadWallHistory/);
    expect(() => createLiquidityPublisher({ ...options, now: () => at, loadWallHistory: null, saveWallHistory: null })).not.toThrow();
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(loadWallHistory).toHaveBeenCalledWith(expect.objectContaining({ dir: "unused", pairKey: "PERPETUAL:BTCUSDT", geometry: { rowWidth: 2, rowClusters: 4, tickSize: undefined, clusterTicks: undefined } }));
    const history = publisher.wallHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.size).toBe(0);
    engine.state.bids = [...thin, { key: 159_600, size: 0, cancelled: 100 }];
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(history.size).toBe(1);
    expect(history.query({ fromTs: T0, toTs: at }).walls[0]).toMatchObject({ hid: 1, side: "bid", historical: true, endedBy: expect.any(String), detail: expect.objectContaining({ traded: 0 }) });
    const past = { side: "ask", row: 40_100, span: 1, startTs: T0 - 600_000, endTs: T0 - 300_000, size: 0, peak: 30, endedBy: "filled", ratio: 3, chain: 0 };
    publisher.activeStateForTests().tracker.adopt([past]);
    expect(history.size).toBe(1);
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    await new Promise((resolve) => setImmediate(resolve));
    expect(history.size).toBe(2);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ dir: "unused", pairKey: "PERPETUAL:BTCUSDT", savedAt: at, suffix: "walls", history: { version: 1, nextId: 3 } });
    expect(saves[0].history.walls.map((wall) => [wall.hid, wall.side, wall.endedBy])).toEqual([[2, "ask", "filled"], [1, "bid", expect.any(String)]]);
    expect(history.dirty).toBe(false);
    expect(publisher.stats().retentionByPair["PERPETUAL:BTCUSDT"].historyWalls).toBe(2);
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    await new Promise((resolve) => setImmediate(resolve));
    expect(saves).toHaveLength(1);
    expect(publisher.wallHistoryOf("SPOT", "ETHUSDT")).toBeNull();

    stored = { savedAt: at, geometry: {}, history: saves[0].history };
    const again = createLiquidityPublisher({ ...options, memory: memoryWith(fakeEngine()), now: () => at + 10_000 });
    again.tick("PERPETUAL", "BTCUSDT", at + 10_000);
    const back = again.wallHistoryOf("PERPETUAL", "BTCUSDT");
    expect(back.size).toBe(2);
    expect(back.nextId).toBe(3);
    expect(lines.some((l) => /restored 2 ended walls for PERPETUAL:BTCUSDT from the walls history/.test(l))).toBe(true);
    stored = { savedAt: at, geometry: {}, history: { version: 1, nextId: 1, walls: "x" } };
    const broken = createLiquidityPublisher({ ...options, memory: memoryWith(fakeEngine()), now: () => at + 10_000 });
    broken.tick("PERPETUAL", "BTCUSDT", at + 10_000);
    expect(broken.wallHistoryOf("PERPETUAL", "BTCUSDT").size).toBe(0);
    expect(lines.some((l) => /stored walls history for PERPETUAL:BTCUSDT was not restored \(MALFORMED\)/.test(l))).toBe(true);
  });

  test("a wall history over its byte budget drops its least meaningful walls and is written again at the next save; the sync save at stop does the same at once", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const answers = [{ ok: false, reason: "OVER_BUDGET", bytes: 2_000 }, { ok: true, bytes: 900 }];
    const saveWallHistory = jest.fn(() => answers.shift());
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", storeS: 1, loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory, loadWallHistory: () => null, wallHistoryMaxBytes: 1_000,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    const walls = [];
    for (let i = 0; i < 10; i += 1) walls.push({ side: "ask", row: 40_100 + i, span: 1, startTs: T0 - 600_000, endTs: T0 - 300_000 + i, size: 0, peak: 30, endedBy: i < 5 ? "filled" : "moved", ratio: 3, chain: 0 });
    publisher.activeStateForTests().tracker.adopt(walls);
    publisher.stop();
    expect(saveWallHistory).toHaveBeenCalledTimes(2);
    expect(saveWallHistory.mock.calls[0][0].history.walls).toHaveLength(10);
    expect(saveWallHistory.mock.calls[1][0].history.walls.map((wall) => wall.endedBy)).toEqual(["filled", "filled", "filled", "filled"]);
  });

  test("the event history takes the engine's trades near the mid and into walls on every tick, is written as its own file at the store save and read back for a new state", async () => {
    const engine = fakeEngine();
    const thin = Array.from({ length: 20 }, (_, i) => ({ key: 160_000 - 4 * i, size: 1 }));
    engine.state.bids = [...thin, { key: 159_600, size: 100 }];
    let pending = [];
    let seq = 0;
    engine.events = () => {
      const events = pending;
      pending = [];
      seq += events.length;
      return { events, nextSeq: seq, missed: 0 };
    };
    engine.eventHead = () => seq;
    const saves = [];
    const saveWallHistory = jest.fn(async (request) => { saves.push(request); return { ok: true, bytes: 100 }; });
    let stored = null;
    const loadWallHistory = jest.fn(({ suffix }) => (suffix === "events" ? stored : null));
    const options = {
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", storeS: 1, loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory, loadWallHistory,
      memory: memoryWith(engine), log: () => {},
    };
    let at = T0;
    const publisher = createLiquidityPublisher({ ...options, now: () => at });
    expect(() => createLiquidityPublisher({ ...options, now: () => at, tradeHistoryMaxBytes: 0 })).toThrow(/tradeHistoryMaxBytes/);
    expect(() => createLiquidityPublisher({ ...options, now: () => at, wallTradeHistoryMaxBytes: 0 })).toThrow(/wallTradeHistoryMaxBytes/);
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(loadWallHistory).toHaveBeenCalledWith(expect.objectContaining({ suffix: "events" }));
    const wallBorn = at;
    at += 1_000;
    pending = [
      { type: "trade", ts: at - 500, key: 159_600, side: "bid", aggressor: "sell", kind: "absorbed", price: 79_800, size: 3 },
      { type: "trade", ts: at - 400, key: 160_000, side: "bid", aggressor: "sell", kind: "swept", price: 80_000, size: 1 },
      { type: "trade", ts: at - 300, key: 100_000, side: "bid", aggressor: "sell", kind: "swept", price: 50_000, size: 9 },
    ];
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.queryTrades({ fromTs: T0, toTs: at }).records.map((r) => [r.row, r.aggressor, r.mode, r.size])).toEqual([[39_900, "sell", "absorbed", 3], [40_000, "sell", "swept", 1]]);
    expect(history.queryWallTrades({ fromTs: T0, toTs: at }).records).toEqual([expect.objectContaining({ wall: "bid:39900:1:" + String(wallBorn), mode: "absorbed", size: 3, count: 1 })]);
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    await new Promise((resolve) => setImmediate(resolve));
    expect(saves.map((save) => save.suffix)).toEqual(["events"]);
    expect(saves[0].history).toMatchObject({ version: 1, columnMs: 1_000 });
    expect(saves[0].history.trades).toHaveLength(2);
    expect(saves[0].history.wallTrades).toHaveLength(1);
    expect(publisher.stats().retentionByPair["PERPETUAL:BTCUSDT"]).toMatchObject({ historyTrades: 2, historyWallTrades: 1 });
    expect(publisher.eventHistoryOf("SPOT", "ETHUSDT")).toBeNull();

    stored = { savedAt: at, geometry: {}, history: saves[0].history };
    const again = createLiquidityPublisher({ ...options, memory: memoryWith(fakeEngine()), now: () => at + 10_000 });
    again.tick("PERPETUAL", "BTCUSDT", at + 10_000);
    const back = again.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(back.tradeBuckets).toBe(2);
    expect(back.wallTradeBuckets).toBe(1);
  });

  test("the event history a request reads already holds the live stretch up to now, without waiting for a store save to note it (PR #39 review)", () => {
    let at = T0;
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(fakeEngine()), now: () => at });
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    at += 30_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.covered).toEqual([[T0, at]]);
    expect(history.heldFrom(T0 - 60_000, at)).toBe(T0);
    expect(history.heldFrom(T0 - 60_000, T0)).toBe(T0);
  });

  test("after the deep tier is ready, the fill replays the recording further back in the background, newest first, feeding only the wall and event histories, and remembers how far it got", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const wall = (from, until) => ({ side: "bid", row: 39_991, span: 1, startTs: from, endTs: Math.min(until - 1, from + 5_000), size: 0, peak: 20, endedBy: "pulled", ratio: 3, chain: 0 });
    const standing = (from) => ({ side: "ask", row: 40_050, span: 1, startTs: from, endTs: null, size: 30, peak: 30, endedBy: null, ratio: 3, chain: 0 });
    const events = (from) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: [[from, 10_000, 40_000, "buy", "absorbed", 2, 1]], wallTrades: [] });
    const backfill = async (request) => {
      calls.push({ from: request.fromTs - T0, until: request.toTs - T0, background: request.background === true, lanes: request.lanes.length });
      if (request.background !== true) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
      return { columns: 0, frames: 10, reason: null, stats: {}, levels: [wall(request.fromTs, request.toTs), standing(request.fromTs)], aggressive: [], events: events(request.fromTs) };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, deepChunkS: 20, fillHistoryS: 120,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(engine), fillHistoryS: -1 })).toThrow(/fillHistoryS/);
    const noStore = createLiquidityPublisher({ ...GEOMETRY, backfillEnabled: true, backfill: async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] }), dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, fillHistoryS: 120, memory: memoryWith(fakeEngine()), now: () => T0 });
    noStore.tick("PERPETUAL", "BTCUSDT", T0);
    expect(noStore.readiness()["PERPETUAL:BTCUSDT"].fill).toEqual({ state: "DISABLED", reason: "DISABLED_BY_CONFIG" });
    expect(publisher.readiness()).toEqual({});
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toEqual({ state: "IDLE", reason: "NOT_STARTED" });
    for (let i = 0; i < 80; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((call) => call.background).map((call) => [call.from, call.until, call.lanes])).toEqual([[-80_000, -60_000, 0], [-100_000, -80_000, 0], [-120_000, -100_000, 0]]);
    expect(calls.filter((call) => !call.background).every((call) => call.from >= -70_000)).toBe(true);
    const walls = publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: T0 - 200_000, toTs: T0 });
    expect(walls.walls.map((w) => [w.side, w.startTs - T0, w.endTs === null])).toEqual([[ "bid", -120_000, false], ["bid", -100_000, false], ["bid", -80_000, false]]);
    expect(publisher.activeStateForTests().tracker.levels()).toEqual([]);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.queryTrades({ fromTs: T0 - 200_000, toTs: T0 }).records.map((r) => r.ts - T0)).toEqual([-120_000, -100_000, -80_000]);
    expect(history.fill).toEqual({ from: T0 - 120_000, until: T0 - 60_000 });
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", chunks: 3, emptyChunks: 0, from: T0 - 120_000, until: T0 - 60_000 });
    expect(lines.some((l) => /filled the wall and event histories for PERPETUAL:BTCUSDT from the recording: 3 chunks/.test(l))).toBe(true);
  });

  test("the fill resumes from where it got to, skips a window the recording does not hold, and stops on a failed pass without pretending", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const backfill = async (request) => {
      if (request.background !== true) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
      calls.push([request.fromTs - T0, request.toTs - T0]);
      if (calls.length === 1) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
      return { columns: 0, frames: 0, reason: "TIMEOUT", stats: null, levels: [], aggressive: [], events: null };
    };
    const saves = [];
    const saveWallHistory = jest.fn(async (request) => { saves.push(request); return { ok: true, bytes: 1 }; });
    let stored = null;
    const loadWallHistory = jest.fn(({ suffix }) => (suffix === "events" ? stored : null));
    const lines = [];
    const options = {
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, deepChunkS: 20, fillHistoryS: 120,
      storeEnabled: true, storeDir: "unused", storeS: 1, loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory, loadWallHistory,
      memory: memoryWith(engine), log: (l) => lines.push(l),
    };
    let at = T0;
    const publisher = createLiquidityPublisher({ ...options, now: () => at });
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    for (let i = 0; i < 80; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([[-80_000, -60_000], [-100_000, -80_000]]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "DEGRADED", reason: "TIMEOUT", chunks: 1, emptyChunks: 1, from: T0 - 80_000, until: T0 - 60_000 });
    expect(lines.some((l) => /history fill for PERPETUAL:BTCUSDT stopped after 1 chunks \(TIMEOUT\)/.test(l))).toBe(true);
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    at += 1_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    await new Promise((resolve) => setImmediate(resolve));
    const saved = saves.find((save) => save.suffix === "events");
    expect(saved.history.fill).toEqual({ from: T0 - 80_000, until: T0 - 60_000 });

    stored = { savedAt: at, geometry: {}, history: saved.history };
    calls.length = 0;
    const again = createLiquidityPublisher({ ...options, backfill: async (request) => {
      if (request.background !== true) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
      calls.push([request.fromTs - T0, request.toTs - T0]);
      return { columns: 0, frames: 1, reason: null, stats: {}, levels: [], aggressive: [], events: null };
    }, memory: memoryWith(fakeEngine()), now: () => T0 });
    again.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 80; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([[-100_000, -80_000], [-120_000, -100_000]]);
    expect(again.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", chunks: 2, from: T0 - 120_000, until: T0 - 60_000 });
    const off = createLiquidityPublisher({ ...options, fillHistoryS: 0, memory: memoryWith(fakeEngine()), now: () => T0 });
    off.tick("PERPETUAL", "BTCUSDT", T0);
    expect(off.readiness()["PERPETUAL:BTCUSDT"].fill).toEqual({ state: "DISABLED", reason: "DISABLED_BY_CONFIG" });
  });

  test("the fill stops at a window whose events the history refuses, so the range it reports filled holds no window it could not take", async () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = [];
    const events = (from, columnMs = 1_000) => ({ version: 1, columnMs, deepColumnMs: 10_000, fill: null, trades: [[from, 10_000, 40_000, "buy", "absorbed", 2, 1]], wallTrades: [] });
    const backfill = async (request) => {
      if (request.background !== true) return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
      calls.push(request.fromTs - T0);
      return { columns: 0, frames: 10, reason: null, stats: {}, levels: [], aggressive: [], events: events(request.fromTs, calls.length === 2 ? 2_000 : 1_000) };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, deepChunkS: 20, fillHistoryS: 120,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
      memory: memoryWith(engine), now: () => T0, log: (l) => lines.push(l),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 80; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([-80_000, -100_000]);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.fill).toEqual({ from: T0 - 80_000, until: T0 - 60_000 });
    expect(history.uncovered(T0 - 120_000, T0 - 60_000)).toEqual([[T0 - 120_000, T0 - 80_000]]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "DEGRADED", reason: "EVENTS_REFUSED", chunks: 1 });
    expect(lines.some((l) => /could not take the events of the fill/.test(l))).toBe(true);
  });

  test("the deep pass hands its events to the event history, and the fill horizon comes from the environment", async () => {
    const { DEFAULT_FILL_S } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const events = (from) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: [[from, 10_000, 40_000, "buy", "swept", 1, 1]], wallTrades: [] });
    const backfill = async (request) => ({ columns: 0, frames: 10, reason: null, stats: {}, levels: [], aggressive: [], events: request.foldMs === undefined ? null : events(request.fromTs) });
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000, deepChunkS: 20,
      memory: memoryWith(engine), now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 80; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: T0 - 70_000, toTs: T0 }).records.map((r) => r.ts - T0)).toEqual([-60_000, -40_000, -20_000]);
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_FILL_S: "0" })).toEqual({ fillHistoryS: 0 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_FILL_S: "3600" })).toEqual({ fillHistoryS: 3_600 });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_FILL_S: "-1" })).toEqual({});
    expect(DEFAULT_FILL_S).toBe(86_400);
  });

  test("the pair on screen hands each finished wider-lane column to the lane walls worker with the book packed beside it; the other pairs do not, and a pair that leaves the screen is forgotten", () => {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    const calls = { configure: [], post: [], forget: [] };
    const laneWallsClient = {
      enabled: true,
      configure: (pair, lanes, trackerOptions) => { if (!calls.configure.some((call) => call.pair === pair)) calls.configure.push({ pair, lanes: lanes.map((lane) => lane.k), trackerOptions }); },
      forget: (pair) => { if (!calls.forget.includes(pair)) calls.forget.push(pair); },
      post: (request) => { calls.post.push(request); return true; },
      wallsOf: () => [],
      stop: () => {},
      stats: () => ({ posted: calls.post.length }),
    };
    const published = [];
    expect(() => createLiquidityPublisher({ ...GEOMETRY, laneWalls: "yes", memory: memoryWith(engine) })).toThrow(/laneWalls/);
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const publisher = createLiquidityPublisher({ ...GEOMETRY, deepS: 60, historyS: 10, deepColumnMs: 5_000, laneWallsClient, memory: memoryWith(engine), now: () => Date.now(), log: () => {} });
    try {
      let pair = { marketKind: "PERPETUAL", symbol: "BTCUSDT" };
      publisher.start({ activePair: () => pair, publish: (frame) => published.push(frame), pairs: () => [pair, { marketKind: "SPOT", symbol: "ETHUSDT" }] });
      jest.advanceTimersByTime(3_200);
      expect(calls.configure.map((call) => call.pair)).toEqual(["PERPETUAL:BTCUSDT"]);
      expect(calls.configure[0].lanes).toEqual([1, 2]);
      expect(calls.configure[0].trackerOptions).toMatchObject({ multiplier: expect.any(Number), maxLevels: 100 });
      expect(calls.post.map((request) => [request.pair, request.lane, request.column.lo <= request.column.hi, request.snapshot.bids.length, request.referenceRows])).toEqual([["PERPETUAL:BTCUSDT", 1, true, 1, expect.any(Number)]]);
      expect(calls.post[0].referenceRows).toBe(Math.max(1, Math.ceil(publisher.activeStateForTests().referenceRows / 2)));
      expect(publisher.stats().laneWalls).toEqual({ posted: 1 });
      // Over 22 s only the recent lane columns go: eleven of lane 1 (every 2 s) and five of lane 2 (every 4 s); the deep lane columns (10 s and 20 s wide) never do.
      jest.advanceTimersByTime(18_900);
      const perLane = calls.post.reduce((acc, request) => ({ ...acc, [request.lane]: (acc[request.lane] ?? 0) + 1 }), {});
      expect(perLane).toEqual({ 1: 11, 2: 5 });
      expect(calls.post.every((request) => request.pair === "PERPETUAL:BTCUSDT")).toBe(true);
      pair = { marketKind: "SPOT", symbol: "ETHUSDT" };
      jest.advanceTimersByTime(1_100);
      expect(calls.forget).toEqual(["PERPETUAL:BTCUSDT"]);
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
    const quiet = createLiquidityPublisher({ ...GEOMETRY, laneWalls: false, memory: memoryWith(fakeEngine()), now: () => T0 });
    expect(quiet.stats().laneWalls).toMatchObject({ enabled: false });
  });

  test("L2_HEATMAP_HISTORY=0 keeps the wall and event histories off: nothing is recorded, stored, restored or filled, and the history requests find none", async () => {
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_HISTORY: "0" })).toEqual({ histories: false });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_HISTORY: "1" })).toEqual({ histories: true });
    expect(() => createLiquidityPublisher({ ...GEOMETRY, histories: "no", memory: memoryWith(fakeEngine()) })).toThrow(/histories/);
    const engine = fakeEngine();
    const thin = Array.from({ length: 20 }, (_, i) => ({ key: 160_000 - 4 * i, size: 1 }));
    engine.state.bids = [...thin, { key: 159_600, size: 100 }];
    const saves = [];
    const saveWallHistory = jest.fn(async (request) => { saves.push(request); return { ok: true, bytes: 100 }; });
    const loadWallHistory = jest.fn(() => ({ savedAt: T0, geometry: {}, history: { version: 1, nextId: 2, walls: [{ hid: 1, side: "ask", row: 40_100, span: 1, startTs: T0 - 600_000, endTs: T0 - 300_000, size: 0, peak: 30, endedBy: "filled", ratio: 3, chain: 0 }] } }));
    const backfill = jest.fn(async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null }));
    const options = {
      ...GEOMETRY, histories: false, storeEnabled: true, storeDir: "unused", storeS: 1, loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory, loadWallHistory,
      deepS: 60, historyS: 10, deepColumnMs: 5_000, backfillEnabled: true, backfill, fillHistoryS: 3_600, memory: memoryWith(engine), log: () => {},
    };
    let at = T0;
    const publisher = createLiquidityPublisher({ ...options, now: () => at });
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(loadWallHistory).not.toHaveBeenCalled();
    expect(publisher.wallHistoryOf("PERPETUAL", "BTCUSDT")).toBeNull();
    expect(publisher.eventHistoryOf("PERPETUAL", "BTCUSDT")).toBeNull();
    engine.state.bids = [...thin, { key: 159_600, size: 0, cancelled: 100 }];
    for (let i = 0; i < 3; i += 1) {
      at += 1_000;
      publisher.tick("PERPETUAL", "BTCUSDT", at);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const state = publisher.activeStateForTests();
    expect(state.tracker.walls().some((wall) => wall.endTs !== null)).toBe(true);
    expect(state.wallHistory.size).toBe(0);
    expect(state.eventHistory.tradeBuckets).toBe(0);
    expect(saves).toEqual([]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toEqual({ state: "DISABLED", reason: "DISABLED_BY_CONFIG" });
    expect(backfill.mock.calls.every(([request]) => request.background !== true)).toBe(true);
    expect(publisher.stats().retentionByPair["PERPETUAL:BTCUSDT"]).toMatchObject({ historyWalls: 0, historyTrades: 0 });
  });
});

describe("liquidity-publisher snapshots, passes and store writes under load (latency, 2026-10-07)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");

  function withFakeTimers(run) {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    try {
      return run();
    } finally {
      jest.useRealTimers();
    }
  }

  function liveEngine() {
    const engine = fakeEngine();
    engine.state.bids = [{ key: 160_000, size: 1 }];
    return engine;
  }

  test("a snapshot announced for a pair that is not selected is built only once the pair is selected", () => {
    withFakeTimers(() => {
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(liveEngine()) });
      let active = { marketKind: "PERPETUAL", symbol: "BTCUSDT" };
      const snapshots = [];
      publisher.start({ activePair: () => active, pairs: () => [{ marketKind: "SPOT", symbol: "ETHUSDT" }], publish: () => {}, publishSnapshot: (frames) => snapshots.push(frames) });
      jest.advanceTimersByTime(800);
      const eth = publisher.activeStateForTests();
      expect(eth.key).toBe("SPOT:ETHUSDT");
      eth.announce = true;
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toEqual([]);
      expect(eth.announce).toBe(true);
      active = { marketKind: "SPOT", symbol: "ETHUSDT" };
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0][0]).toMatchObject({ symbol: "ETH-USDT", reset: true });
      expect(eth.announce).toBe(false);
      publisher.stop();
    });
  });

  test("a second announce inside the announce interval waits for it; a pass that lands goes out at once", () => {
    withFakeTimers(() => {
      const publisher = createLiquidityPublisher({ ...GEOMETRY, backfillAnnounceS: 15, memory: memoryWith(liveEngine()) });
      const published = [];
      const snapshots = [];
      publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: (frame) => published.push(frame), publishSnapshot: (frames) => snapshots.push(frames) });
      jest.advanceTimersByTime(800);
      const state = publisher.activeStateForTests();
      state.announce = true;
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(1);
      state.announce = true;
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(1);
      expect(published).toHaveLength(2);
      jest.advanceTimersByTime(13_000);
      expect(snapshots).toHaveLength(1);
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(2);
      state.announce = true;
      state.announceNow = true;
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(3);
      expect(state.announceNow).toBe(false);
      publisher.stop();
    });
  });

  test("with nobody connected an announced snapshot waits for a client, and hasClients must be a function", () => {
    withFakeTimers(() => {
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: memoryWith(liveEngine()) });
      expect(() => publisher.start({ activePair: () => null, publish: () => {}, hasClients: true })).toThrow(/hasClients/);
      const snapshots = [];
      let clients = 0;
      publisher.start({ activePair: () => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT" }), publish: () => {}, publishSnapshot: (frames) => snapshots.push(frames), hasClients: () => clients > 0 });
      jest.advanceTimersByTime(800);
      const state = publisher.activeStateForTests();
      state.announce = true;
      jest.advanceTimersByTime(2_000);
      expect(snapshots).toEqual([]);
      expect(state.announce).toBe(true);
      clients = 1;
      jest.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(1);
      publisher.stop();
    });
  });

  test("selecting a pair moves its queued rebuild passes ahead of the other pairs'", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0 + 300);
    try {
      const started = [];
      const backfill = (request) => new Promise((resolve) => started.push({ request, resolve }));
      const publisher = createLiquidityPublisher({ ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", memory: memoryWith(liveEngine()), log: () => {} });
      let active = { marketKind: "PERPETUAL", symbol: "BTCUSDT" };
      const tracked = [{ marketKind: "SPOT", symbol: "ETHUSDT" }, { marketKind: "SPOT", symbol: "SOLUSDT" }];
      publisher.start({ activePair: () => active, pairs: () => tracked, publish: () => {} });
      jest.advanceTimersByTime(800);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      expect(publisher.stats().backfill).toMatchObject({ running: 1, queued: 2 });
      active = { marketKind: "SPOT", symbol: "SOLUSDT" };
      jest.advanceTimersByTime(1_000);
      started[0].resolve({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      expect(started.map((s) => s.request.key)).toEqual(["PERPETUAL:BTCUSDT", "SPOT:SOLUSDT"]);
      publisher.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("deep columns merged behind the tier keep the live chain, and the snapshot that follows chains from its own first chunk", async () => {
    const engine = liveEngine();
    const column = (ts) => ({ ts, lo: 39_800, hi: 40_200, bid: [[200, 9]], ask: [] });
    const stored = {
      savedAt: T0 - 3_600_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [column(T0 - 3_601_000), column(T0 - 3_600_000)],
      deep: [column(T0 - 3_610_000), column(T0 - 3_600_000)],
      levels: [],
    };
    let openBehind;
    const behindGate = new Promise((resolve) => { openBehind = resolve; });
    const backfill = async (request) => {
      if (request.fromTs === T0 - 4_810_000) {
        await behindGate;
        const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 3 }], asks: [] };
        request.onColumn(sampleLiquidityColumn(snapshot, { ts: T0 - 4_800_000, rowClusters: request.rowClusters, windowRows: request.windowRows }));
        return { columns: 1, frames: 1, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [] };
    };
    const turns = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    let at = T0;
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 600, deepS: 7_200, deepColumnMs: 10_000, backfillAnnounceS: 60,
      memory: memoryWith(engine), now: () => at, log: () => {},
    });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", at).map((f) => [f.column_ms, f.reset, f.seq])).toEqual([[10_000, true, 2], [1_000, true, 1]]);
    await turns();
    at = T0 + 1_000;
    const landed = publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(landed.map((f) => [f.column_ms, f.reset, f.seq])).toEqual([[10_000, true, 2], [1_000, true, 2]]);
    at = T0 + 10_000;
    const live = publisher.tick("PERPETUAL", "BTCUSDT", at).find((f) => f.column_ms === 10_000);
    expect(live).toMatchObject({ reset: false, seq: 3 });
    expect(live.columns).toHaveLength(1);
    openBehind();
    await turns();
    expect(publisher.activeState).toMatchObject({ deepLength: 4, deepSeq: 3 });
    at = T0 + 11_000;
    expect(publisher.tick("PERPETUAL", "BTCUSDT", at)).toMatchObject({ column_ms: 1_000, reset: false });
    at = T0 + 20_000;
    const chained = publisher.tick("PERPETUAL", "BTCUSDT", at).find((f) => f.column_ms === 10_000);
    expect(chained).toMatchObject({ reset: false, seq: 4 });
    expect(chained.columns).toHaveLength(1);
    at = T0 + 61_000;
    const announced = publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(announced[0]).toMatchObject({ column_ms: 10_000, reset: true, seq: 6 });
    expect(announced[0].columns.map((c) => c.ts - T0)).toEqual([-4_800_000, -3_610_000, -3_600_000, 0, 10_000, 20_000]);
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 62_000)).toMatchObject({ column_ms: 1_000, reset: false });
  });

  test("a store that has not changed since its last write is not written again", () => {
    const engine = liveEngine();
    const saveHistory = jest.fn(() => ({ ok: true }));
    let at = T0;
    const publisher = createLiquidityPublisher({ ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory, storeS: 10, memory: memoryWith(engine), now: () => at });
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    at = T0 + 10_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(saveHistory).toHaveBeenCalledTimes(1);
    engine.live = false;
    at = T0 + 20_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(saveHistory).toHaveBeenCalledTimes(2);
    for (const later of [30_000, 40_000, 50_000]) {
      at = T0 + later;
      publisher.tick("PERPETUAL", "BTCUSDT", at);
    }
    expect(saveHistory).toHaveBeenCalledTimes(2);
    publisher.stop();
    expect(saveHistory).toHaveBeenCalledTimes(2);
  });

  test("a rebuild that merges older columns while no live column moves seq is still written on the clock, once (PR #47 review)", () => {
    const engine = liveEngine();
    const saveHistory = jest.fn(() => ({ ok: true }));
    let at = T0;
    const publisher = createLiquidityPublisher({ ...GEOMETRY, storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory, storeS: 10, memory: memoryWith(engine), now: () => at });
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    engine.live = false;
    at = T0 + 10_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    const saved = saveHistory.mock.calls.length;
    at = T0 + 20_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(saveHistory).toHaveBeenCalledTimes(saved);
    const state = publisher.activeStateForTests();
    const [first] = state.history.toArray();
    expect(state.history.merge([{ ...first, ts: first.ts - 1_000 }])).toBe(1);
    at = T0 + 30_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    expect(saveHistory).toHaveBeenCalledTimes(saved + 1);
    at = T0 + 40_000;
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    publisher.stop();
    expect(saveHistory).toHaveBeenCalledTimes(saved + 1);
  });

  test("the publisher sweeps the temporary store files an earlier process left behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidity-publisher-"));
    try {
      const stale = path.join(dir, "PERPETUAL_BTCUSDT.json.99.1.tmp");
      fs.writeFileSync(stale, "x");
      fs.utimesSync(stale, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000));
      const lines = [];
      createLiquidityPublisher({ ...GEOMETRY, storeEnabled: true, storeDir: dir, loadHistory: () => null, saveHistory: () => ({ ok: true }), memory: memoryWith(liveEngine()), now: () => T0, log: (line) => lines.push(line) });
      expect(fs.existsSync(stale)).toBe(false);
      expect(lines).toContain(`liquidity-publisher: removed 1 temporary store file left by an earlier run in ${dir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
