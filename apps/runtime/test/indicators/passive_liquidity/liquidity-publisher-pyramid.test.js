const { createLiquidityPublisher, liquidityOptionsFromEnv } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const { decodeColumn } = require("../../../src/indicators/passive_liquidity/liquidity-history");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { createPyramidWarmup } = require("../../../src/indicators/l2-memory/pyramid/pyramid-warmup");

// P4c.5: Terminal C takes a pair's pinned rows from the host pyramid, so its
// live columns and the pyramid share a grid, and fills the deep tier from the
// pyramid before the raw replay runs. Raw replay still runs for everything
// the pyramid cannot give (walls, bubbles, the wider lanes) and fills only
// the pyramid's holes.

const T0 = 1_700_000_000_000;
const GEOMETRY = Object.freeze({ rowBp: 0.25, windowBp: 50, backfillEnabled: false, deepS: 0, coarseS: 0, storeEnabled: false, wallSettleMs: 0 });

function fakeEngine({ tickSize = 0.1, clusterTicks = 5 } = {}) {
  const clusterWidth = tickSize * clusterTicks;
  const state = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size: 1 }], asks: [] };
  return {
    state,
    live: true,
    seeded: true,
    tickSize,
    clusterTicks,
    snapshot() {
      return { ...state, clusterWidth, priceFor: (key) => key * clusterWidth };
    },
    priceFor: (key) => key * clusterWidth,
    eventHead: () => 0,
    events: () => ({ events: [], nextSeq: 0, missed: 0 }),
  };
}

function fakePyramid({ pin = null, deep = async () => ({ columns: [], reason: "NO_PYRAMID" }), walls = null, events = null } = {}) {
  return { pinned: jest.fn(() => pin), deepColumns: jest.fn(deep), ...(walls === null ? {} : { wallHistory: jest.fn(walls) }), ...(events === null ? {} : { eventHistory: jest.fn(events) }) };
}

function column(ts, size, rowClusters = 4, windowRows = 200) {
  const snapshot = { bestBidKey: 160_000, bestAskKey: 160_001, bids: [{ key: 160_000, size }], asks: [] };
  return sampleLiquidityColumn(snapshot, { ts, rowClusters, windowRows });
}

function deepTier(frames) {
  const frame = frames.find((f) => f.column_ms === 10_000);
  let prev = null;
  return frame.columns.map((wire) => {
    prev = decodeColumn(prev, wire);
    return prev;
  });
}

describe("liquidity-publisher with the host pyramid (P4c.5)", () => {
  test("the pyramid is on for the servers unless the environment turns it off", () => {
    expect(liquidityOptionsFromEnv({})).toEqual({});
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_PYRAMID: "0" })).toEqual({ pyramid: null });
    expect(liquidityOptionsFromEnv({ L2_HEATMAP_PYRAMID: "1" })).toEqual({ pyramid: "auto" });
    expect(() => createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => null }, pyramid: {} })).toThrow(/pyramid/);
  });

  test("takes the pinned rows when the pyramid pinned them on the engine's own ticks, and the price-derived rows otherwise", () => {
    const rowWidthWith = (pin, engine = fakeEngine()) => {
      const pyramid = fakePyramid({ pin });
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => engine }, pyramid, now: () => T0 });
      const frames = [].concat(publisher.tick("PERPETUAL", "BTCUSDT", T0));
      publisher.stop();
      expect(pyramid.pinned).toHaveBeenCalledWith("PERPETUAL", "BTCUSDT");
      return frames[0].row_width;
    };
    expect(rowWidthWith(null)).toBe(2);
    expect(rowWidthWith({ rowClusters: 6, tickSize: 0.1, clusterTicks: 5 })).toBe(3);
    expect(rowWidthWith({ rowClusters: 6, tickSize: 0.01, clusterTicks: 5 })).toBe(2);
    expect(rowWidthWith({ rowClusters: 6, tickSize: 0.1, clusterTicks: 50 })).toBe(2);
  });

  test("asks for a pair's pinned rows from its first tick, before its book is ready, so they are known when its lane is made", () => {
    const pyramid = fakePyramid();
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => null }, pyramid, now: () => T0 });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toBeNull();
    expect(pyramid.pinned).toHaveBeenCalledWith("PERPETUAL", "BTCUSDT");
    publisher.stop();
  });

  test("does not freeze live geometry before the first asynchronous pin lookup settles", async () => {
    let respond;
    const read = jest.fn(() => new Promise((resolve) => { respond = resolve; }));
    const pyramid = createPyramidWarmup({ read, now: () => T0 });
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => fakeEngine() }, pyramid, now: () => T0 });
    expect(publisher.tick("PERPETUAL", "BTCUSDT", T0)).toBeNull();
    respond({ available: true, geometry: { rowClusters: 6, tickSize: 0.1, clusterTicks: 5 } });
    await pyramid.refreshPin("PERPETUAL", "BTCUSDT");
    expect([].concat(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000))[0].row_width).toBe(3);
    publisher.stop();
  });

  test("\"auto\" reads the local pyramid in TT_HEATMAP_DIR for the pinned rows, and lets go of its store when the publisher stops (closure audit)", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { openPyramidStore } = require("../../../src/indicators/l2-memory/pyramid/pyramid-store");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-pyramid-"));
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ tickSize: 0.1, clusterTicks: 5, rowClusters: 6, rowWidth: 3, windowRows: 200, sizeDigits: 4, snapshotDepth: 1000, columnMs: 1_000, replayWarmupMs: 1_800_000, rowBp: 0.5, windowBp: 600, referenceBp: 50 });
    store.close();
    const previous = process.env.TT_HEATMAP_DIR;
    process.env.TT_HEATMAP_DIR = dir;
    try {
      let seeded = false;
      const engine = fakeEngine();
      const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => (seeded ? engine : null) }, pyramid: "auto", now: () => Date.now() });
      publisher.tick("PERPETUAL", "BTCUSDT", T0);
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
      seeded = true;
      expect([].concat(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000))[0].row_width).toBe(3);
      publisher.stop();
      expect(() => fs.rmSync(dir, { recursive: true, force: true })).not.toThrow();
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TT_HEATMAP_DIR;
      else process.env.TT_HEATMAP_DIR = previous;
    }
  });

  test("hostColumns reads the host's 10-second columns through the pyramid on the pair's own rows, and says why when it cannot", async () => {
    const none = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => null }, pyramid: null, now: () => T0 });
    expect(await none.hostColumns("PERPETUAL", "BTCUSDT", T0 - 3_600_000, T0)).toEqual({ columns: [], reason: "NO_HOST" });
    none.stop();
    const pyramid = fakePyramid({ pin: { rowClusters: 6, tickSize: 0.1, clusterTicks: 5 }, deep: async () => ({ columns: [column(T0 - 60_000, 7)], reason: null }) });
    const engine = fakeEngine();
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => engine, rowClusters: () => 1 }, pyramid, now: () => T0 });
    expect(await publisher.hostColumns("PERPETUAL", "BTCUSDT", T0 - 3_600_000, T0)).toEqual({ columns: [], reason: "NO_GEOMETRY" });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    const out = await publisher.hostColumns("PERPETUAL", "BTCUSDT", T0 - 3_600_000, T0);
    expect(out).toEqual({ columns: [expect.objectContaining({ ts: T0 - 60_000 })], reason: null });
    const { rowWidth } = publisher.geometryFor("PERPETUAL", "BTCUSDT");
    expect(rowWidth).toBeCloseTo(0.5);
    expect(pyramid.deepColumns).toHaveBeenLastCalledWith({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: T0 - 3_600_000, toTs: T0, geometry: { rowWidth, tickSize: 0.1, clusterTicks: 5 } });
    publisher.stop();
  });

  test("an instrument whose rows are configured in ticks keeps them; the pyramid pins the same rows there", () => {
    const pyramid = fakePyramid({ pin: { rowClusters: 6, tickSize: 0.1, clusterTicks: 5 } });
    const engine = fakeEngine();
    const publisher = createLiquidityPublisher({ ...GEOMETRY, memory: { getEngine: () => engine, rowClusters: () => 1 }, pyramid, now: () => T0 });
    expect([].concat(publisher.tick("PERPETUAL", "BTCUSDT", T0))[0].row_width).toBeCloseTo(0.5);
    publisher.stop();
  });

  test("fills the deep tier from the pyramid first, still runs the raw passes, and lets them fill only the pyramid's holes", async () => {
    const engine = fakeEngine();
    const calls = [];
    const backfill = async (request) => {
      calls.push({ fromTs: request.fromTs, toTs: request.toTs, foldMs: request.foldMs });
      if (request.foldMs === undefined) {
        request.onColumn(column(T0 - 9_000, 1));
        return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      request.onColumn(column(T0 - 40_000, 3));
      request.onColumn(column(T0 - 30_000, 3));
      return { columns: 2, frames: 9, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const pyramid = fakePyramid({ deep: async () => ({ columns: [column(T0 - 60_000, 7), column(T0 - 50_000, 7), column(T0 - 30_000, 7)], reason: null }) });
    const lines = [];
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      memory: { getEngine: () => engine }, pyramid, now: () => T0, log: (line) => lines.push(line),
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(pyramid.deepColumns).toHaveBeenCalledWith(expect.objectContaining({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: T0 - 60_000, toTs: T0 - 10_000, geometry: { rowWidth: 2, tickSize: 0.1, clusterTicks: 5 } }));
    expect(calls.some((c) => c.foldMs === 10_000 && c.fromTs === T0 - 60_000)).toBe(true);
    const deep = deepTier(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000));
    const sizeAtWall = (c) => c.bid[40_000 - c.lo];
    expect(deep.map((c) => [c.ts - T0, sizeAtWall(c)])).toEqual([[-60_000, 7], [-50_000, 7], [-40_000, 3], [-30_000, 7], [-10_000, 1]]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].deep).toMatchObject({ state: "READY", pyramid: { columns: 3, reason: null } });
    expect(lines.some((l) => /filled 3 deep columns for PERPETUAL:BTCUSDT from the heatmap pyramid/.test(l))).toBe(true);
    publisher.stop();
  });

  test("a deep tier restored from Terminal C's own store keeps its columns; the pyramid and the raw passes fill around them (closure audit, pattern H)", async () => {
    const { encodeColumn } = require("../../../src/indicators/passive_liquidity/liquidity-history");
    const engine = fakeEngine();
    const backfill = async (request) => {
      if (request.foldMs === undefined) {
        request.onColumn(column(T0 - 9_000, 1));
        return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
      }
      request.onColumn(column(T0 - 40_000, 3));
      request.onColumn(column(T0 - 30_000, 3));
      return { columns: 2, frames: 9, reason: null, stats: {}, levels: [], aggressive: [] };
    };
    const stored = {
      savedAt: T0 - 60_000,
      geometry: { rowWidth: 2, rowClusters: 4, windowRows: 200, columnMs: 1_000, deepColumnMs: 10_000 },
      recent: [],
      deep: [encodeColumn(null, column(T0 - 50_000, 9))],
      levels: [],
    };
    const pyramid = fakePyramid({ deep: async () => ({ columns: [column(T0 - 60_000, 7), column(T0 - 50_000, 7), column(T0 - 30_000, 7)], reason: null }) });
    const publisher = createLiquidityPublisher({
      ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
      storeEnabled: true, storeDir: "unused", loadHistory: () => stored, saveHistory: () => ({ ok: true }),
      memory: { getEngine: () => engine }, pyramid, now: () => T0, log: () => {},
    });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const deep = deepTier(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).map((c) => [c.ts - T0, c.bid[40_000 - c.lo]]);
    expect(deep).toEqual([[-60_000, 7], [-50_000, 9], [-40_000, 3], [-30_000, 7], [-10_000, 1]]);
    publisher.stop();
  });

  test("with no pyramid, or one in other rows, the deep tier is exactly the raw rebuild", async () => {
    const run = async (pyramid) => {
      const engine = fakeEngine();
      const backfill = async (request) => {
        if (request.foldMs === undefined) {
          request.onColumn(column(T0 - 9_000, 1));
          return { columns: 1, frames: 5, reason: null, stats: {}, levels: [], aggressive: [] };
        }
        request.onColumn(column(T0 - 40_000, 3));
        request.onColumn(column(T0 - 30_000, 3));
        return { columns: 2, frames: 9, reason: null, stats: {}, levels: [], aggressive: [] };
      };
      const lines = [];
      const publisher = createLiquidityPublisher({
        ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 60, deepColumnMs: 10_000,
        memory: { getEngine: () => engine }, pyramid, now: () => T0, log: (line) => lines.push(line),
      });
      publisher.tick("PERPETUAL", "BTCUSDT", T0);
      for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const deep = deepTier(publisher.tick("PERPETUAL", "BTCUSDT", T0 + 1_000)).map((c) => [c.ts - T0, c.bid[40_000 - c.lo]]);
      const readiness = publisher.readiness()["PERPETUAL:BTCUSDT"].deep;
      publisher.stop();
      return { deep, readiness, lines };
    };
    const raw = await run(null);
    const refused = await run(fakePyramid({ deep: async () => ({ columns: [], reason: "GEOMETRY" }) }));
    expect(raw.deep).toEqual([[-40_000, 3], [-30_000, 3], [-10_000, 1]]);
    expect(refused.deep).toEqual(raw.deep);
    expect(refused.readiness.pyramid).toMatchObject({ columns: 0, reason: "GEOMETRY" });
    expect(refused.lines.some((l) => /no heatmap pyramid for PERPETUAL:BTCUSDT \(GEOMETRY\)/.test(l))).toBe(true);
    const thrown = await run(fakePyramid({ deep: async () => { throw new Error("socket hang up"); } }));
    expect(thrown.deep).toEqual(raw.deep);
  });
});

describe("liquidity-publisher histories from the host pyramid (P4e3 step 4)", () => {
  const W = 300_000;
  const wall = (endTs) => ({ side: "bid", row: 39_991, span: 1, startTs: endTs - 50_000, endTs, size: 0, peak: 20, endedBy: "pulled", ratio: 3, chain: 0, fill: 0, eaten: 0, absorbing: false });
  const eventsOf = (ts) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: ts, until: ts + W }, trades: [[ts, 10_000, 40_000, "buy", "absorbed", 2, 1]], wallTrades: [] });
  const options = (engine, pyramid, backfill, lines) => ({
    ...GEOMETRY, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 600, deepColumnMs: 10_000, deepChunkS: 300, fillHistoryS: 3_600,
    storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
    memory: { getEngine: () => engine }, pyramid, now: () => T0, log: (line) => lines.push(line),
  });
  const settle = async () => { for (let i = 0; i < 120; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  test("a deep tier the pyramid filled is asked for from the host like the rest, and the recording replays the chunk before the live start whatever the host held (ticket item 2)", async () => {
    const engine = fakeEngine();
    const calls = [];
    const backfill = async (request) => {
      calls.push({ from: request.fromTs - T0, until: request.toTs - T0, background: request.background === true });
      if (request.background !== true) return { columns: 0, frames: 0, reason: "WORKER_EXITED", stats: null, levels: [], aggressive: [], events: null };
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
    };
    const deep = Array.from({ length: 60 }, (_, i) => column(T0 - 600_000 + i * 10_000, 7));
    const pyramid = fakePyramid({
      deep: async () => ({ columns: deep, reason: null }),
      walls: async () => ({ walls: [], reason: null }),
      events: async (ask) => ({ windows: Array.from({ length: Math.ceil((ask.toTs - ask.fromTs) / W) }, (_, i) => ({ ts: ask.fromTs + i * W, events: eventsOf(ask.fromTs + i * W) })), reason: null }),
    });
    const lines = [];
    const publisher = createLiquidityPublisher(options(engine, pyramid, backfill, lines));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(pyramid.wallHistory).toHaveBeenCalledWith(expect.objectContaining({ fromTs: T0 - 3_600_000, toTs: T0 - 10_000 }));
    expect(pyramid.eventHistory).toHaveBeenCalledWith(expect.objectContaining({ fromTs: T0 - 3_600_000, toTs: T0 - 10_000 }));
    const background = calls.filter((call) => call.background);
    expect(background).toEqual([{ from: -310_000, until: -10_000, background: true }]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", chunks: 1, pyramid: { windows: 12 } });
    publisher.stop();
  });

  test("a window the local recording does not hold is still asked for from the host: a deep pass that found no data covers nothing, claims no trades, and the recording fill does not replay it again (PR #40 review)", async () => {
    const engine = fakeEngine();
    const calls = [];
    const backfill = async (request) => {
      calls.push({ from: request.fromTs - T0, until: request.toTs - T0, background: request.background === true });
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
    };
    const asked = [];
    const pyramid = fakePyramid({
      walls: async () => ({ walls: [], reason: null }),
      events: async (ask) => {
        asked.push([ask.fromTs - T0, ask.toTs - T0]);
        return { windows: [], reason: null };
      },
    });
    const publisher = createLiquidityPublisher(options(engine, pyramid, backfill, []));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(asked).toEqual([[-3_600_000, -10_000]]);
    expect(pyramid.wallHistory).toHaveBeenCalledWith(expect.objectContaining({ fromTs: T0 - 3_600_000, toTs: T0 - 10_000 }));
    const deepPasses = calls.filter((call) => !call.background && call.until <= -10_000);
    expect(deepPasses.length).toBeGreaterThan(0);
    const background = calls.filter((call) => call.background);
    expect(background).toHaveLength(10);
    expect(background.every((call) => call.until <= -600_000)).toBe(true);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.covered).toEqual([]);
    expect(publisher.activeStateForTests().emptyPasses).toEqual([[T0 - 600_000, T0 - 10_000]]);
    expect(history.heldFrom(T0 - 600_000, T0 - 10_000)).toBe(T0 - 10_000);
    expect(history.heldFrom(T0 - 3_600_000, T0 - 600_000)).toBe(T0 - 600_000);
    publisher.stop();
  });

  test("takes the host's walls and events over the fill horizon before the recording, and the local fill then replays only what lies before the host's oldest window", async () => {
    const engine = fakeEngine();
    const calls = [];
    const backfill = async (request) => {
      calls.push({ from: request.fromTs - T0, until: request.toTs - T0, background: request.background === true });
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
    };
    const hostFrom = T0 - 3_000_000;
    const pyramid = fakePyramid({
      walls: async () => ({ walls: [wall(T0 - 2_500_000), wall(T0 - 1_000_000)], reason: null }),
      events: async () => ({ windows: [{ ts: hostFrom, events: eventsOf(hostFrom) }, { ts: hostFrom + W, events: eventsOf(hostFrom + W) }, { ts: T0 - 900_000, events: { ...eventsOf(T0 - 900_000), deepColumnMs: 5_000 } }], reason: null }),
    });
    const lines = [];
    const publisher = createLiquidityPublisher(options(engine, pyramid, backfill, lines));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(pyramid.wallHistory).toHaveBeenCalledWith({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: T0 - 3_600_000, toTs: T0 - 10_000, geometry: { rowWidth: 2, tickSize: 0.1, clusterTicks: 5 } });
    expect(pyramid.eventHistory).toHaveBeenCalledWith({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: T0 - 3_600_000, toTs: T0 - 10_000, geometry: { rowWidth: 2, tickSize: 0.1, clusterTicks: 5 } });
    const walls = publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: T0 - 3_600_000, toTs: T0 });
    expect(walls.walls.map((w) => w.endTs - T0)).toEqual([-2_500_000, -1_000_000]);
    const history = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT");
    expect(history.queryTrades({ fromTs: T0 - 3_600_000, toTs: T0 }).records.map((r) => r.ts - T0)).toEqual([-3_000_000, -2_700_000]);
    expect(history.fill).toEqual({ from: T0 - 3_600_000, until: T0 - 600_000 });
    const background = calls.filter((call) => call.background);
    expect(background[0]).toEqual({ from: -900_000, until: -600_000, background: true });
    expect(background.some((call) => call.until <= hostFrom - T0)).toBe(true);
    expect(background.every((call) => call.until <= hostFrom - T0 || call.from >= hostFrom + 2 * W - T0)).toBe(true);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", pyramid: { walls: 2, windows: 2, refused: 1, reason: null } });
    expect(lines.some((l) => /took 2 walls and 2 event windows for PERPETUAL:BTCUSDT from the heatmap pyramid/.test(l))).toBe(true);
    publisher.stop();
  });

  test("the host's windows count in the fill range it reports even when the local fill stops on its first window", async () => {
    const engine = fakeEngine();
    const backfill = async (request) => (request.background === true
      ? { columns: 0, frames: 0, reason: "TIMEOUT", stats: null, levels: [], aggressive: [], events: null }
      : { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null });
    const hostFrom = T0 - 3_000_000;
    const pyramid = fakePyramid({
      walls: async () => ({ walls: [], reason: null }),
      events: async () => ({ windows: [{ ts: hostFrom, events: eventsOf(hostFrom) }, { ts: hostFrom + W, events: eventsOf(hostFrom + W) }], reason: null }),
    });
    const publisher = createLiquidityPublisher(options(engine, pyramid, backfill, []));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "DEGRADED", reason: "TIMEOUT", chunks: 0, from: hostFrom, until: hostFrom + 2 * W });
    publisher.stop();
  });

  test("a host window that breaks the event history stops the history fill for that pair, logged, instead of escaping as a rejection the runtime treats as fatal", async () => {
    const engine = fakeEngine();
    const backfill = async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null });
    const broken = T0 - 3_000_000 + 0.5;
    const pyramid = fakePyramid({
      walls: async () => ({ walls: [], reason: null }),
      events: async () => ({ windows: [{ ts: broken, events: eventsOf(T0 - 3_000_000) }], reason: null }),
    });
    const lines = [];
    const publisher = createLiquidityPublisher(options(engine, pyramid, backfill, lines));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "DEGRADED", reason: expect.stringMatching(/^WORKER_ERROR: event-history: merge needs integer/) });
    expect(lines.some((l) => /the history fill for PERPETUAL:BTCUSDT failed: event-history: merge needs integer/.test(l))).toBe(true);
    expect(publisher.activeStateForTests().deepBusy).toBe(false);
    publisher.stop();
  });

  test("a restart takes from the host only what the restored histories do not hold, so a window's trades are counted once however many starts (PR #32 review)", async () => {
    const W0 = T0 - 1_800_000;
    const hostWindows = [{ ts: W0, events: eventsOf(W0) }];
    const hostWalls = [wall(W0 + 60_000)];
    const asks = [];
    const pyramid = fakePyramid({
      walls: async (ask) => { asks.push(["walls", ask.fromTs - T0, ask.toTs - T0]); return { walls: hostWalls.filter((entry) => entry.endTs >= ask.fromTs && entry.endTs < ask.toTs), reason: null }; },
      events: async (ask) => { asks.push(["events", ask.fromTs - T0, ask.toTs - T0]); return { windows: hostWindows.filter((window) => window.ts >= ask.fromTs && window.ts < ask.toTs), reason: null }; },
    });
    const saves = {};
    const backfill = async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null });
    const start = async () => {
      let clock = T0;
      const publisher = createLiquidityPublisher({
        ...options(fakeEngine(), pyramid, backfill, []), storeS: 1, now: () => clock,
        saveWallHistory: async (request) => { saves[request.suffix] = JSON.parse(JSON.stringify(request.history)); return { ok: true, bytes: 1 }; },
        loadWallHistory: ({ suffix }) => (saves[suffix] === undefined ? null : { savedAt: T0, geometry: {}, history: saves[suffix] }),
      });
      publisher.tick("PERPETUAL", "BTCUSDT", clock);
      await settle();
      for (let i = 1; i <= 3; i += 1) {
        clock = T0 + i * 1_000;
        publisher.tick("PERPETUAL", "BTCUSDT", clock);
        await settle();
      }
      const trades = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: W0, toTs: W0 + W }).records.reduce((sum, record) => sum + record.size, 0);
      const walls = publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: W0, toTs: W0 + W }).walls.length;
      const fill = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").fill;
      publisher.stop();
      return { trades, walls, fill };
    };
    const first = await start();
    expect(first).toEqual({ trades: 2, walls: 1, fill: { from: T0 - 3_600_000, until: T0 - 600_000 } });
    expect(asks).toEqual([["walls", -3_600_000, -10_000], ["events", -3_600_000, -10_000]]);
    expect(Object.keys(saves).sort()).toEqual(["events", "walls"]);
    const nobodyHolds = [["walls", -600_000, -10_000], ["events", -600_000, -10_000]];
    asks.length = 0;
    expect(await start()).toEqual(first);
    expect(asks).toEqual(nobodyHolds);
    asks.length = 0;
    expect(await start()).toEqual(first);
    expect(asks).toEqual(nobodyHolds);
  });

  test("a host window inside the stretch the restored history already covers is not added again even when the host sends it (PR #32 review)", async () => {
    const W0 = T0 - 1_800_000;
    const pyramid = fakePyramid({ walls: async () => ({ walls: [wall(W0 + 60_000)], reason: null }), events: async () => ({ windows: [{ ts: W0, events: eventsOf(W0) }], reason: null }) });
    const stored = { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: W0, until: W0 + W }, trades: [[W0, 10_000, 40_000, "buy", "absorbed", 2, 1]], wallTrades: [] };
    const backfill = async () => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null });
    const publisher = createLiquidityPublisher({ ...options(fakeEngine(), pyramid, backfill, []), loadWallHistory: ({ suffix }) => (suffix === "events" ? { savedAt: T0, geometry: {}, history: stored } : null) });
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: W0, toTs: W0 + W }).records.map((record) => record.size)).toEqual([2]);
    expect(publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: W0, toTs: W0 + W }).walls).toEqual([]);
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", pyramid: { walls: 0, windows: 0, refused: 4, reason: null } });
    publisher.stop();
  });

  test("a later restart asks the host only for the downtime, never for the stretch the run before rebuilt itself, so its deep passes and live trades are counted once (PR #32 re-review)", async () => {
    const base = Math.floor(T0 / W) * W;
    const trade = (ts) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: ts, until: ts + W }, trades: [[ts, 10_000, 40_000, "buy", "swept", 1, 1]], wallTrades: [] });
    const asks = [];
    const pyramid = () => fakePyramid({
      walls: async () => ({ walls: [], reason: null }),
      events: async ({ fromTs, toTs }) => {
        asks.push([fromTs - base, toTs - base]);
        const windows = [];
        for (let ts = Math.ceil(fromTs / W) * W; ts < toTs; ts += W) windows.push({ ts, events: trade(ts) });
        return { windows, reason: null };
      },
    });
    const saves = {};
    const start = async (at, after = at) => {
      let clock = at;
      const publisher = createLiquidityPublisher({
        ...options(fakeEngine(), pyramid(), async (request) => ({ columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: request.background !== true ? trade(request.fromTs) : null }), []),
        storeS: 1, now: () => clock,
        saveWallHistory: async (request) => { saves[request.suffix] = JSON.parse(JSON.stringify(request.history)); return { ok: true, bytes: 1 }; },
        loadWallHistory: ({ suffix }) => (saves[suffix] === undefined ? null : { savedAt: at, geometry: {}, history: saves[suffix] }),
      });
      publisher.tick("PERPETUAL", "BTCUSDT", clock);
      await settle();
      while (clock < after) {
        clock = Math.min(after, clock + 60_000);
        publisher.tick("PERPETUAL", "BTCUSDT", clock);
        await settle();
      }
      const sizes = publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: base - 3_600_000, toTs: base + 3_600_000 }).records.map((record) => [record.ts - base, record.size]);
      publisher.stop();
      return sizes;
    };
    const first = await start(base, base + 600_000);
    expect(first.filter(([ts]) => ts === -600_000 || ts === -300_000)).toEqual([[-600_000, 1], [-300_000, 1]]);
    expect(asks).toEqual([[-3_600_000, -600_000]]);
    asks.length = 0;
    const second = await start(base + 1_800_000);
    // The run before saved its history last at +60 s, the last save that had something new to write (nothing traded
    // live in this fake); everything up to there, deep passes and startup pass included, is never asked again.
    expect(asks).toEqual([[60_000, 1_200_000]]);
    expect(second.every(([, size]) => size === 1)).toBe(true);
    expect(second.filter(([ts]) => ts === -600_000 || ts === -300_000)).toEqual([[-600_000, 1], [-300_000, 1]]);
  });

  test("a host without histories, in other rows, or down leaves the fill exactly as it was; a pyramid without the history readers is never asked", async () => {
    const engine = fakeEngine();
    const calls = [];
    const backfill = async (request) => {
      calls.push(request.background === true);
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
    };
    const lines = [];
    const refused = fakePyramid({ walls: async () => ({ walls: [], reason: null }), events: async () => { throw new Error("socket hang up"); } });
    const publisher = createLiquidityPublisher(options(engine, refused, backfill, lines));
    publisher.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(publisher.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", pyramid: { walls: 0, windows: 0, reason: "READ_FAILED: socket hang up" } });
    expect(publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").fill).toEqual({ from: T0 - 3_600_000, until: T0 - 600_000 });
    expect(calls.filter(Boolean).length).toBe(10);
    expect(lines.some((l) => /no histories for PERPETUAL:BTCUSDT from the heatmap pyramid \(READ_FAILED: socket hang up\)/.test(l))).toBe(true);
    publisher.stop();
    const bare = fakePyramid();
    const plain = createLiquidityPublisher(options(fakeEngine(), bare, backfill, []));
    plain.tick("PERPETUAL", "BTCUSDT", T0);
    await settle();
    expect(plain.readiness()["PERPETUAL:BTCUSDT"].fill).toMatchObject({ state: "READY", pyramid: null });
    plain.stop();
  });
});
