"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createRemoteStorageReader } = require("../../../src/storage/remote-storage-reader");
const { createService } = require("../../../scripts/serve/run-live-storage-service");
const { createGateway } = require("../../../scripts/serve/run-archive-gateway");
const { MIN_TOKEN_LENGTH } = require("../../../src/server/archive-auth");
const { WINDOW_MS, windowStart } = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");
const { openPyramidStore } = require("../../../src/indicators/l2-memory/pyramid/pyramid-store");
const { createPyramidService, pyramidOptionsFromEnv } = require("../../../src/indicators/l2-memory/pyramid/pyramid-service");
const { createPyramidWarmup } = require("../../../src/indicators/l2-memory/pyramid/pyramid-warmup");
const { createLiquidityPublisher } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const { safeRm } = require("../../helpers/temp-files");

const DEV_SECRET = "d".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "internal-service-secret-under-test-chain";
const T0 = windowStart(1_700_000_000_000) + WINDOW_MS;
const PAIR_KEY = "binance:PERPETUAL:BTCUSDT";
const CATALOG = { version: 1, binance: [{ group: "Crypto", label: "BTC", symbol: "BTC-USDT", marketKind: "PERPETUAL", l2: { clusterTicks: 1, minSliceSize: 0 } }], dxfeed: [] };

function seedCapture(dbPath, until) {
  const storageDb = createStorageDb({ dbPath });
  const db = storageDb.raw;
  const book = { bids: new Map([[100, 5], [99, 2], [98, 1]]), asks: new Map([[101, 3], [102, 1]]) };
  const levels = (map, desc) => [...map].filter(([, s]) => s > 0).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).map(([p, s]) => [p.toFixed(1), s.toFixed(1)]);
  let u = 100;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(T0 - 40 * 60_000, "BTCUSDT", "PERPETUAL", u, JSON.stringify(levels(book.bids, true)), JSON.stringify(levels(book.asks, false)));
  const insert = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertTrade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let step = 0;
  for (let ts = T0 - 40 * 60_000 + 500; ts < until; ts += 900) {
    step += 1;
    const wallUp = ts >= T0 + 60_000 && ts < T0 + 180_000;
    const change = [[(step % 2 ? 100 : 99).toFixed(1), String(1 + (step % 5))], ["98.0", wallUp ? "80" : "1"]];
    insert.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify(change), "[]");
    u += 1;
    if (step % 3 === 0) insertTrade.run(ts - 1, "BTCUSDT", "PERPETUAL", step % 2 ? 100 : 101, 0.5, step % 2 ? "sell" : "buy", step);
  }
  storageDb.close();
}

function fakeEngine() {
  const state = { bestBidKey: 100, bestAskKey: 101, bids: [{ key: 100, size: 1 }], asks: [] };
  return {
    state, live: true, seeded: true, tickSize: 1, clusterTicks: 1,
    snapshot() {
      return { ...state, clusterWidth: 1, priceFor: (key) => key };
    },
    priceFor: (key) => key,
    eventHead: () => 0,
    events: () => ({ events: [], nextSeq: 0, missed: 0 }),
  };
}

describe("histories on the host, end to end (P4e3 step 6): the pyramid builds them, live-storage serves them, the runtime takes them", () => {
  let dir = null;
  let service = null;
  let gateway = null;

  afterEach(async () => {
    if (gateway) { await gateway.stop(); gateway = null; }
    if (service) { await service.stop(); service = null; }
    if (dir) { try { safeRm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } dir = null; }
  });

  test("a wall the capture shows ends up in the runtime's wall history with the host's birth, the trades near the mid in its event history, and the recording is asked only for what lies before the host", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-chain-"));
    const dbPath = path.join(dir, "capture.sqlite");
    const heatmapDir = path.join(dir, "heatmap");
    fs.mkdirSync(heatmapDir);
    seedCapture(dbPath, T0 + 3 * WINDOW_MS + 20_000);
    const at = T0 + 7 * WINDOW_MS + 60_000;
    const logs = [];
    const builder = createPyramidService({
      dir: heatmapDir,
      dbPaths: { binance: dbPath, dxfeed: path.join(dir, "none.sqlite") },
      catalog: CATALOG,
      options: { ...pyramidOptionsFromEnv({ L2_HEATMAP_LEVEL_MIN_USD: "500", L2_HEATMAP_WALL_MULT: "0", L2_HEATMAP_WALL_SETTLE_MS: "0" }), windowsPerCycle: 100, retentionMs: 7 * WINDOW_MS },
      tickSizeResolver: { getBinanceTickSize: async () => 1 },
      now: () => at,
      log: (line) => logs.push(line),
    });
    expect(await builder.runOnce()).toBe(3);
    builder.close();
    const store = openPyramidStore({ dir: heatmapDir, pairKey: PAIR_KEY, readonly: true });
    const built = store.readWalls({ fromTs: T0, toTs: T0 + 3 * WINDOW_MS, limit: 400 }).walls;
    const wall = built.find((entry) => entry.peak >= 80);
    expect(wall).toMatchObject({ side: "bid", endedBy: "hit" });
    expect(wall.startTs).toBeGreaterThanOrEqual(T0 + 60_000);
    expect(wall.endTs).toBeGreaterThanOrEqual(T0 + 180_000);
    expect(store.historyWindows(T0, T0 + 3 * WINDOW_MS)).toEqual([T0, T0 + WINDOW_MS, T0 + 2 * WINDOW_MS]);
    const geometry = store.geometry();
    store.close();

    service = createService({
      port: 0, host: "127.0.0.1", dbPath, storageReader: createStorageReader({ dbPath }), heatmapDir,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.01 },
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: { TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`, TT_LIVE_STORAGE_INTERNAL_URL: `http://127.0.0.1:${service.server.address().port}`, TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET },
    });
    await gateway.start();
    const remote = createRemoteStorageReader({ baseUrl: `http://127.0.0.1:${gateway.server.address().port}/live-storage`, token: DEV_SECRET, log: () => {} });
    const warmup = createPyramidWarmup({
      read: (provider, symbol, kind, options) => remote.readHeatmapColumns(symbol, kind, options, { provider }),
      readWalls: (provider, symbol, kind, options) => remote.readWallHistory(symbol, kind, options, { provider }),
      readEvents: (provider, symbol, kind, options) => remote.readEventHistory(symbol, kind, options, { provider }),
      close: () => remote.close(),
      now: () => at,
    });
    const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: T0, toTs: T0 + 3 * WINDOW_MS, geometry: { rowWidth: geometry.rowWidth, tickSize: geometry.tickSize, clusterTicks: geometry.clusterTicks } };
    const served = await warmup.wallHistory(ask);
    expect(served.reason).toBeNull();
    expect(served.walls.find((entry) => entry.peak >= 80)).toEqual(wall);
    const windows = await warmup.eventHistory(ask);
    expect(windows.reason).toBeNull();
    expect(windows.windows.map((window) => window.ts)).toEqual([T0, T0 + WINDOW_MS, T0 + 2 * WINDOW_MS]);
    expect(windows.windows[0].events.trades.length).toBeGreaterThan(0);

    const calls = [];
    const backfill = async (request) => {
      calls.push({ from: request.fromTs, until: request.toTs, background: request.background === true });
      return { columns: 0, frames: 0, reason: "NO_DATA_IN_WINDOW", stats: null, levels: [], aggressive: [], events: null };
    };
    const lines = [];
    const publisher = createLiquidityPublisher({
      rowBp: 0.5, windowBp: 600, backfillEnabled: true, backfill, dbPath: "unused.sqlite", historyS: 10, deepS: 600, deepColumnMs: 10_000, deepChunkS: 300, coarseS: 0, fillHistoryS: 3_600, wallSettleMs: 0,
      storeEnabled: true, storeDir: "unused", loadHistory: () => null, saveHistory: () => ({ ok: true }), saveWallHistory: async () => ({ ok: true, bytes: 1 }), loadWallHistory: () => null,
      memory: { getEngine: () => fakeEngine() }, pyramid: warmup, now: () => at, log: (line) => lines.push(line),
    });
    await warmup.prefetch([{ marketKind: "PERPETUAL", symbol: "BTCUSDT" }]);
    publisher.tick("PERPETUAL", "BTCUSDT", at);
    for (let i = 0; i < 400 && publisher.readiness()["PERPETUAL:BTCUSDT"]?.fill?.state !== "READY"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const fill = publisher.readiness()["PERPETUAL:BTCUSDT"].fill;
    expect(fill).toMatchObject({ state: "READY", pyramid: { reason: null, refused: 0 } });
    expect(fill.pyramid.walls).toBeGreaterThanOrEqual(1);
    expect(fill.pyramid.windows).toBeGreaterThanOrEqual(1);
    const taken = publisher.wallHistoryOf("PERPETUAL", "BTCUSDT").query({ fromTs: T0, toTs: at }).walls.find((entry) => entry.peak >= 80);
    expect(taken).toMatchObject({ side: "bid", startTs: wall.startTs, endTs: wall.endTs, endedBy: "hit", historical: true });
    expect(publisher.eventHistoryOf("PERPETUAL", "BTCUSDT").queryTrades({ fromTs: T0, toTs: at }).records.length).toBeGreaterThan(0);
    const hostOldest = T0;
    const background = calls.filter((call) => call.background);
    expect(background.every((call) => call.until <= hostOldest || call.from >= T0 + 3 * WINDOW_MS)).toBe(true);
    expect(background.some((call) => call.from >= T0 + 3 * WINDOW_MS)).toBe(true);
    expect(lines.some((line) => /took \d+ walls and \d+ event windows for PERPETUAL:BTCUSDT from the heatmap pyramid/.test(line))).toBe(true);
    publisher.stop();
    await remote.close();
  }, 60_000);
});
