const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { WINDOW_MS, windowStart } = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");
const { openPyramidStore } = require("../../../src/indicators/l2-memory/pyramid/pyramid-store");
const { createPyramidService, pyramidPairs, pyramidOptionsFromEnv, createCaptureClock, trackerOptionsFor, STATUS_FILE, TRACKER_MAX_LEVELS } = require("../../../src/indicators/l2-memory/pyramid/pyramid-service");
const { resolveGeometry } = require("../../../src/indicators/l2-memory/pyramid/pyramid-builder");
const { SNAPSHOT_DEPTH_BY_MARKET_KIND } = require("../../../src/indicators/l2-memory/live-binding");
const { DEFAULT_SIZE_DIGITS } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const catalog = require("../../../../../config/market-instruments.json");

const T0 = windowStart(1_700_000_000_000) + WINDOW_MS;

function seedCapture(dbPath, until) {
  const storageDb = createStorageDb({ dbPath });
  const db = storageDb.raw;
  const book = { bids: new Map([[100, 5], [99, 2]]), asks: new Map([[101, 3], [102, 1]]) };
  const levels = (map, desc) => [...map].filter(([, s]) => s > 0).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).map(([p, s]) => [p.toFixed(1), s.toFixed(1)]);
  let u = 100;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(T0 - 40 * 60_000, "BTCUSDT", "PERPETUAL", u, JSON.stringify(levels(book.bids, true)), JSON.stringify(levels(book.asks, false)));
  const insert = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let step = 0;
  for (let ts = T0 - 40 * 60_000 + 500; ts < until; ts += 900) {
    step += 1;
    const change = [[(step % 2 ? 100 : 99).toFixed(1), String(1 + (step % 5))]];
    insert.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify(change), "[]");
    u += 1;
  }
  storageDb.close();
}

const PERP_ONLY = { version: 1, binance: [{ group: "Crypto", label: "BTC", symbol: "BTC-USDT", marketKind: "PERPETUAL", l2: { clusterTicks: 1, minSliceSize: 0 } }], dxfeed: [] };

describe("pyramid service", () => {
  test("capture progress is isolated by symbol and market kind for both providers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-clock-"));
    const binancePath = path.join(dir, "binance.sqlite");
    const binanceDb = createStorageDb({ dbPath: binancePath });
    const insertDepth = binanceDb.raw.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertDepth.run(T0, T0, "BTCUSDT", "PERPETUAL", 1, 1, 0, "[]", "[]");
    insertDepth.run(T0 + WINDOW_MS, T0 + WINDOW_MS, "ETHUSDT", "PERPETUAL", 1, 1, 0, "[]", "[]");
    insertDepth.run(T0 + 2 * WINDOW_MS, T0 + 2 * WINDOW_MS, "BTCUSDT", "SPOT", 1, 1, null, "[]", "[]");
    insertDepth.run(T0 - 1_000, T0 + 3 * WINDOW_MS, "BTCUSDT", "PERPETUAL", 2, 2, 1, "[]", "[]");
    binanceDb.close();
    const binance = createCaptureClock({ dbPath: binancePath, provider: "binance" });
    expect(binance.latest({ symbol: "BTCUSDT", marketKind: "PERPETUAL" })).toBe(T0);
    expect(binance.latest({ symbol: "ETHUSDT", marketKind: "PERPETUAL" })).toBe(T0 + WINDOW_MS);
    expect(binance.latest({ symbol: "BTCUSDT", marketKind: "SPOT" })).toBe(T0 + 2 * WINDOW_MS);
    expect(binance.latest({ symbol: "MISSING", marketKind: "SPOT" })).toBeNull();
    binance.close();

    const dxfeedPath = path.join(dir, "dxfeed.sqlite");
    const Database = require("better-sqlite3");
    const dxfeedDb = new Database(dxfeedPath);
    dxfeedDb.exec("CREATE TABLE dxfeed_order_book_capture (id INTEGER PRIMARY KEY, symbol TEXT, asset_class TEXT, source TEXT, event_time INTEGER, received_at INTEGER); CREATE INDEX pair_time ON dxfeed_order_book_capture (symbol, asset_class, source, event_time, id)");
    const insertBook = dxfeedDb.prepare("INSERT INTO dxfeed_order_book_capture (symbol, asset_class, source, event_time, received_at) VALUES (?, ?, ?, ?, ?)");
    insertBook.run("AAPL", "EQUITY", "NTV", T0, T0);
    insertBook.run("/NQZ26:XCME", "FUTURE", "GLBX", T0 + WINDOW_MS, T0 + WINDOW_MS);
    insertBook.run("AAPL", "EQUITY", "OTHER", T0 + 2 * WINDOW_MS, T0 + 2 * WINDOW_MS);
    expect(dxfeedDb.prepare("EXPLAIN QUERY PLAN SELECT received_at AS ts FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? ORDER BY event_time DESC LIMIT 1").all("AAPL", "EQUITY", "NTV").some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
    dxfeedDb.close();
    const dxfeed = createCaptureClock({ dbPath: dxfeedPath, provider: "dxfeed" });
    expect(dxfeed.latest({ symbol: "AAPL", marketKind: "EQUITY" })).toBe(T0);
    expect(dxfeed.latest({ symbol: "/NQZ26:XCME", marketKind: "FUTURE" })).toBe(T0 + WINDOW_MS);
    dxfeed.close();
  });

  test("builds a pair for every catalog instrument, with dxFeed rows from the same settings the live binding reads", () => {
    const pairs = pyramidPairs({ catalog, env: { L2_HEATMAP_FUTURE_ROW_TICKS: "4" } });
    expect(pairs.filter((p) => p.provider === "binance").map((p) => `${p.marketKind}:${p.symbol}`).sort()).toEqual(["PERPETUAL:BTCUSDT", "PERPETUAL:ETHUSDT", "SPOT:BTCUSDT", "SPOT:ETHUSDT"]);
    const nq = pairs.find((p) => p.symbol === "/NQZ26:XCME");
    expect(nq).toMatchObject({ provider: "dxfeed", marketKind: "FUTURE", tickSize: 0.25, clusterTicks: 1, fixedRows: 4 });
    expect(pairs.find((p) => p.symbol === "AAPL").fixedRows).toBe(1);
    expect(pairs.find((p) => p.symbol === "BTCUSDT" && p.marketKind === "PERPETUAL")).toMatchObject({ clusterTicks: 5, snapshotDepth: 1000, tickSize: null });
    expect(pyramidPairs({ catalog, pairFilter: new Set(["dxfeed:EQUITY:AAPL"]) }).map((p) => p.symbol)).toEqual(["AAPL"]);
  });

  test("reads its knobs from the environment, with the live publisher's row settings", () => {
    expect(pyramidOptionsFromEnv({})).toMatchObject({ rowBp: 0.5, windowBp: 600, retentionMs: 7 * 86_400_000, cycleMs: 60_000, windowsPerCycle: 12, warmupMs: 1_800_000, pairFilter: null });
    const set = pyramidOptionsFromEnv({ L2_HEATMAP_ROW_BP: "1", TT_PYRAMID_RETENTION_DAYS: "2", TT_PYRAMID_WARMUP_MS: "600000", TT_PYRAMID_PAIRS: "binance:SPOT:BTCUSDT, dxfeed:EQUITY:AAPL" });
    expect(set).toMatchObject({ rowBp: 1, retentionMs: 2 * 86_400_000, warmupMs: 600_000 });
    expect([...set.pairFilter]).toEqual(["binance:SPOT:BTCUSDT", "dxfeed:EQUITY:AAPL"]);
  });

  test("pins a pair from the recording's last book even when the recording has stopped, builds what is due, writes its status, and does nothing more on the next cycle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-service-"));
    const dbPath = path.join(dir, "capture.sqlite");
    seedCapture(dbPath, T0 + 3 * WINDOW_MS + 20_000);
    const at = T0 + 7 * WINDOW_MS + 60_000;
    const logs = [];
    const service = createPyramidService({
      dir: path.join(dir, "heatmap"),
      dbPaths: { binance: dbPath, dxfeed: path.join(dir, "none.sqlite") },
      catalog: PERP_ONLY,
      options: { ...pyramidOptionsFromEnv({}), windowsPerCycle: 100, retentionMs: 7 * WINDOW_MS },
      tickSizeResolver: { getBinanceTickSize: async () => 1 },
      now: () => at,
      log: (line) => logs.push(line),
    });
    fs.mkdirSync(path.join(dir, "heatmap"));
    expect(await service.runOnce()).toBe(3);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "heatmap", STATUS_FILE), "utf8"));
    expect(status.pairs["binance:PERPETUAL:BTCUSDT"]).toMatchObject({ state: "RUNNING", built: 3, states: { COVERED: 3 } });
    expect(logs.some((line) => /pinned binance:PERPETUAL:BTCUSDT at 100: rows of 1/.test(line))).toBe(true);
    expect(await service.runOnce()).toBe(0);
    service.close();
    const store = openPyramidStore({ dir: path.join(dir, "heatmap"), pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    expect(store.windowRecords(T0, T0 + 10 * WINDOW_MS).map((r) => r.ts)).toEqual([T0, T0 + WINDOW_MS, T0 + 2 * WINDOW_MS]);
    expect(store.geometry()).toMatchObject({ rowClusters: 1, rowWidth: 1, pinnedPrice: 100 });
    store.close();
  }, 20_000);

  test("a pair without a tick size waits and says so, and stop ends the loop without waiting out the cycle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-service-"));
    const service = createPyramidService({
      dir,
      dbPaths: { binance: path.join(dir, "none.sqlite"), dxfeed: path.join(dir, "none-dx.sqlite") },
      catalog: PERP_ONLY,
      options: { ...pyramidOptionsFromEnv({}), cycleMs: 3_600_000 },
      tickSizeResolver: { getBinanceTickSize: async () => null },
      now: () => T0,
    });
    const running = service.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();
    await running;
    expect(service.status().pairs["binance:PERPETUAL:BTCUSDT"]).toEqual({ state: "WAITING", reason: "NO_TICK_SIZE" });
    service.close();
  });
});

describe("pyramid service histories (P4e3 step 1)", () => {
  test("the builder gets the live lane's tracker rule for the pair: the dollar floor over the price the recording shows now, not the one the rows were pinned at, and the contract's notional, the wall settings from the environment, and room for a whole run's walls", async () => {
    const options = pyramidOptionsFromEnv({ L2_HEATMAP_LEVEL_MIN_USD: "250000", L2_HEATMAP_WALL_MULT: "2", L2_HEATMAP_WALL_GAP: "3", L2_HEATMAP_WALL_SETTLE_MS: "7000" });
    expect(options).toMatchObject({ histories: true, levelMinUsd: 250_000, wallMultiplier: 2, wallGapRows: 3, wallSettleMs: 7_000 });
    expect(pyramidOptionsFromEnv({})).toMatchObject({ histories: true, levelMinUsd: 500_000, wallMultiplier: 1.5, wallGapRows: 2, wallSettleMs: 5_000 });
    expect(pyramidOptionsFromEnv({ TT_PYRAMID_HISTORIES: "0" }).histories).toBe(false);
    const nq = pyramidPairs({ catalog }).find((p) => p.symbol === "/NQZ26:XCME");
    const btc = pyramidPairs({ catalog }).find((p) => p.symbol === "BTCUSDT" && p.marketKind === "PERPETUAL");
    expect(trackerOptionsFor({ pair: nq, price: 20_000, options, warmupMs: 1_800_000 })).toEqual({ minSize: 250_000 / (20_000 * 20), multiplier: 2, gapRows: 3, settleMs: 7_000, keepEndedMs: 5_400_000, deepKeepEndedMs: 5_400_000, maxLevels: TRACKER_MAX_LEVELS });
    expect(trackerOptionsFor({ pair: btc, price: 80_000, options, warmupMs: 600_000 })).toMatchObject({ minSize: 250_000 / 80_000, keepEndedMs: 4_200_000 });
    expect(trackerOptionsFor({ pair: btc, price: 80_000, options: { ...options, histories: false }, warmupMs: 600_000 })).toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyramid-service-"));
    const dbPath = path.join(dir, "capture.sqlite");
    seedCapture(dbPath, T0 + 2 * WINDOW_MS + 20_000);
    const seen = [];
    const serviceOver = (openStore, sub, extra = {}) => createPyramidService({
      dir: path.join(dir, sub),
      dbPaths: { binance: dbPath, dxfeed: path.join(dir, "none.sqlite") },
      catalog: PERP_ONLY,
      options: { ...pyramidOptionsFromEnv({}), windowsPerCycle: 100, retentionMs: 7 * WINDOW_MS, ...extra },
      tickSizeResolver: { getBinanceTickSize: async () => 1 },
      now: () => T0 + 7 * WINDOW_MS + 60_000,
      openStore,
      runBackfill: async (request) => { seen.push(request); return { frames: 0, reason: "NO_DATA_IN_WINDOW", levels: [], aggressive: [], events: request.trackerOptions ? { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: null, trades: [], wallTrades: [] } : null }; },
    });
    fs.mkdirSync(path.join(dir, "keeping"));
    fs.mkdirSync(path.join(dir, "columns-only"));
    const base = pyramidOptionsFromEnv({});
    const pinnedEarlier = openPyramidStore({ dir: path.join(dir, "keeping"), pairKey: "binance:PERPETUAL:BTCUSDT" });
    pinnedEarlier.pin(resolveGeometry({ price: 50, tickSize: 1, clusterTicks: 1, fixedRows: null, rowBp: base.rowBp, windowBp: base.windowBp, referenceBp: base.referenceBp, sizeDigits: DEFAULT_SIZE_DIGITS, snapshotDepth: SNAPSHOT_DEPTH_BY_MARKET_KIND.PERPETUAL, replayWarmupMs: base.warmupMs }));
    pinnedEarlier.close();
    const keeping = serviceOver(openPyramidStore, "keeping");
    await keeping.runOnce();
    keeping.close();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].trackerOptions).toEqual({ minSize: 5_000, multiplier: 1.5, gapRows: 2, settleMs: 5_000, keepEndedMs: 5_400_000, deepKeepEndedMs: 5_400_000, maxLevels: TRACKER_MAX_LEVELS });
    const kept = openPyramidStore({ dir: path.join(dir, "keeping"), pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    expect(kept.geometry().pinnedPrice).toBe(50);
    expect(kept.historyWindows(T0, T0 + 3 * WINDOW_MS)).toEqual([T0, T0 + WINDOW_MS]);
    expect(kept.stats().standing).toBe(0);
    kept.close();
    seen.length = 0;
    const columnsOnly = serviceOver(openPyramidStore, "columns-only", { histories: false });
    await columnsOnly.runOnce();
    columnsOnly.close();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toHaveProperty("trackerOptions");
  });
});
