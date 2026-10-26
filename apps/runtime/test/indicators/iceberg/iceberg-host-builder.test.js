const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { SNAPSHOT_BEGIN_BIT } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
const { openIcebergHostStore } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { createIcebergIndicator } = require("../../../src/indicators/iceberg/iceberg-indicator");
const { createDxFeedIcebergSource } = require("../../../src/indicators/iceberg/iceberg-capture-sources");
const { createIcebergHostBuilder, createCaptureBounds, DEFAULT_CHUNK_MS, DEFAULT_REWARM_MS, DEFAULT_WARMUP_MS } = require("../../../src/indicators/iceberg/iceberg-host-builder");

const SNAPSHOT_END_BIT = 0x08;
const T0 = 1_700_000_100_000;
const MIN = 60_000;
const FIXED = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3, minRatioSamples: 1 });
const fixedCuts = () => ({ current: () => FIXED, observeTouch() {}, observeEpisode() {} });
const BTC = { provider: "binance", marketKind: "PERPETUAL", symbol: "BTCUSDT" };
const NQ = { provider: "dxfeed", marketKind: "FUTURE", symbol: "/NQZ26:XCME" };
const ES = { ...NQ, symbol: "/ESZ26:XCME" };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-host-builder-"));
}

function seedBinance(dbPath, { defendAt = T0 + 10_000, quietUntil = T0 + 60_000 } = {}) {
  const storage = createStorageDb({ dbPath });
  const db = storage.raw;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(T0 - 5_000, "BTCUSDT", "PERPETUAL", 1, JSON.stringify([["81000.0", "1.0"], ["80999.0", "2.0"]]), JSON.stringify([["81001.0", "3.0"]]));
  const diff = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const trade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let u = 2;
  for (let i = 0; i < 8; i += 1) {
    const ts = defendAt + i * 1000;
    trade.run(ts, "BTCUSDT", "PERPETUAL", "81000.0", "0.3", "sell", `d${i}`);
    diff.run(ts + 50, ts + 55, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["81000.0", "1.0"]]), "[]");
    u += 1;
  }
  for (let ts = defendAt + 10_000; ts < quietUntil; ts += 5_000) {
    diff.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["80999.0", String(2 + (u % 3))]]), "[]");
    u += 1;
  }
  storage.close();
}

function seedDxFeed(dbPath) {
  const storage = createDxFeedStorageDb({ dbPath });
  const order = ({ ts, index, flags = 0, action = "NEW", price, size, side }) => storage.insert("dxfeed_order_book_capture", {
    eventTime: ts, receivedAt: ts, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY",
    orderIndex: String(index), eventFlags: flags, time: ts, action, actionTime: ts, orderId: Number(index), price, size, side, scope: "ORDER", source: "GLBX", marketMaker: null,
  });
  order({ ts: T0 - 20_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 31000, size: 10, side: "BUY" });
  order({ ts: T0 - 20_000, index: 2, flags: SNAPSHOT_END_BIT, price: 31001, size: 3, side: "SELL" });
  order({ ts: T0 + 1_000, index: 1, action: "PARTIAL", price: 31000, size: 3, side: "BUY" });
  order({ ts: T0 + 2_000, index: 1, action: "PARTIAL", price: 31000, size: 10, side: "BUY" });
  order({ ts: T0 + 3_000, index: 1, action: "EXECUTE", price: 31000, size: Number.NaN, side: "BUY" });
  for (let ts = T0 + 10_000; ts < T0 + 130_000; ts += 20_000) order({ ts, index: 2, action: "PARTIAL", price: 31001, size: 3, side: "SELL" });
  storage.close();
}

function writeNq(dbPath, rows) {
  const storage = createDxFeedStorageDb({ dbPath });
  storage.transaction(() => {
    for (const { ts, index, flags = 0, action = "NEW", price, size, side } of [...rows].sort((a, b) => a.ts - b.ts)) {
      storage.insert("dxfeed_order_book_capture", {
        eventTime: ts, receivedAt: ts, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY",
        orderIndex: String(index), eventFlags: flags, time: ts, action, actionTime: ts, orderId: Number(index), price, size, side, scope: "ORDER", source: "GLBX", marketMaker: null,
      });
    }
  });
  storage.close();
}

function snapshotRows(beginTs, endTs) {
  return [
    { ts: beginTs, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 31000, size: 10, side: "BUY" },
    { ts: endTs, index: 2, flags: SNAPSHOT_END_BIT, price: 31001, size: 3, side: "SELL" },
  ];
}

function askRefresh(ts) {
  return { ts, index: 2, action: "PARTIAL", price: 31001, size: 3, side: "SELL" };
}

function droppedBookRows(nextSnapshotAt) {
  const rows = [
    ...snapshotRows(T0 - 20_000, T0 - 20_000),
    { ts: T0 + 1_000, index: 1, action: "PARTIAL", price: 31000, size: 3, side: "BUY" },
    { ts: T0 + 2_000, index: 1, action: "PARTIAL", price: 31000, size: 10, side: "BUY" },
    { ts: T0 + 25_000, index: 3, action: "NEW", price: 31005, size: 1, side: "BUY" },
  ];
  for (let ts = T0 - 10_000; ts < nextSnapshotAt + 60_000; ts += 10_000) rows.push(askRefresh(ts));
  return [...rows, ...snapshotRows(nextSnapshotAt, nextSnapshotAt)];
}

function scriptedSource(script) {
  return ({ fromTs, onEvents, onStatus }) => {
    let from = fromTs;
    return {
      advanceTo: (toTs) => {
        for (const [ts, status] of script) {
          if (ts < from || ts >= toTs) continue;
          if (status === undefined) onEvents([], { snapshot: false, receivedAt: ts });
          else onStatus(status, ts);
        }
        from = toTs;
      },
      close: () => {},
      stats: {},
    };
  };
}

describe("indicators/iceberg/iceberg-host-builder", () => {
  let dir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("the capture bounds say what a capture holds per pair, for both providers, and nothing for an unknown pair", () => {
    const binancePath = path.join(dir, "binance.sqlite");
    const dxfeedPath = path.join(dir, "dxfeed.sqlite");
    seedBinance(binancePath);
    seedDxFeed(dxfeedPath);
    const bounds = createCaptureBounds({ dbPaths: { binance: binancePath, dxfeed: dxfeedPath } });
    expect(bounds.of(BTC)).toEqual({ earliest: T0 - 5_000, latest: T0 + 55_000 });
    expect(bounds.of(NQ)).toEqual({ earliest: T0 - 20_000, latest: T0 + 110_000 });
    expect(bounds.of({ provider: "binance", marketKind: "SPOT", symbol: "ETHUSDT" })).toEqual({ earliest: null, latest: null });
    bounds.close();
  });

  test("a Binance pair is built chunk by chunk from the capture: the defended level becomes a probable iceberg in the store, settled when the level went quiet, with the cursor, the cuts and the watched spans checkpointed; the next chunk waits for the capture", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath);
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    const clock = { at: T0 + 50_000 };
    const builder = createIcebergHostBuilder({
      store, pair: BTC, dbPath, chunkMs: 30_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0 - 5_000, latest: clock.at }), now: () => clock.at, cutsFactory: fixedCuts,
    });
    expect(DEFAULT_CHUNK_MS).toBe(300_000);
    expect(DEFAULT_WARMUP_MS.binance).toBe(24 * 3_600_000);
    expect(DEFAULT_WARMUP_MS.dxfeed).toBe(0);
    expect(builder.runChunk()).toEqual({ built: true, from: T0 - 5_000, to: T0 + 25_000, settled: 1, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 25_000 });
    clock.at = T0 + 60_000;
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 25_000, to: T0 + 55_000, settled: 0, open: 0 });
    const page = store.readPage({ fromTs: 0, toTs: T0 + 100_000 });
    expect(page.icebergs).toEqual([expect.objectContaining({ kind: "probable", side: "bid", price: 81000, display: 1, status: "ended", markedAt: T0 + 16_000 })]);
    expect(page.icebergs[0].executed).toBeCloseTo(2.4, 6);
    const checkpoint = store.checkpoint();
    expect(checkpoint).toMatchObject({ cursor: T0 + 55_000, start: T0 - 5_000, settledThrough: T0 + 55_000, cuts: null, gaps: [] });
    expect(checkpoint.coverage).toEqual([[T0 - 5_000, T0 + 55_000]]);
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 55_000 });
    builder.close();
    store.close();
  });

  test("an open iceberg holds the settled line at its mark, so a restart re-warms the replay before the cursor and settles it once, without a duplicate", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath, { defendAt: T0 + 10_000, quietUntil: T0 + 120_000 });
    const pairKey = "binance:PERPETUAL:BTCUSDT";
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, pair: BTC, dbPath, chunkMs: 10_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 20_000 }), now: () => T0 + 20_000, cutsFactory: fixedCuts });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 5_000 });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 15_000, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 15_000 });
    builder.close();
    expect(first.checkpoint()).toMatchObject({ cursor: T0 + 15_000, settledThrough: T0 + 15_000 });
    first.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, pair: BTC, dbPath, chunkMs: 10_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 120_000 }), now: () => T0 + 120_000, cutsFactory: fixedCuts });
    expect(DEFAULT_REWARM_MS).toBe(600_000);
    const outcomes = [];
    for (let i = 0; i < 12; i += 1) outcomes.push(resumed.runChunk());
    expect(outcomes[0]).toMatchObject({ built: true, from: T0 + 15_000, to: T0 + 25_000 });
    expect(outcomes.filter((entry) => entry.built).reduce((sum, entry) => sum + entry.settled, 0)).toBe(1);
    expect(again.readPage({ fromTs: 0, toTs: T0 + 200_000 }).icebergs.map((entry) => [entry.id, entry.status])).toEqual([[`BTCUSDT|PERPETUAL|bid|81000|${T0 + 10_000}`, "ended"]]);
    expect(again.checkpoint()).toMatchObject({ cursor: T0 + 115_000, settledThrough: T0 + 115_000, coverage: [[T0 - 5_000, T0 + 115_000]] });
    resumed.close();
    again.close();
  });

  test("a dxFeed pair starts from the snapshot before its first chunk, the exchange-refilled order becomes a native iceberg marked on the capture's receive clock, and a book that goes unavailable leaves a gap", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    seedDxFeed(dbPath);
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    const builder = createIcebergHostBuilder({ store, pair: NQ, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 20_000, latest: T0 + 130_000 }), now: () => T0 + 130_000 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 - 20_000, to: T0 + 40_000, settled: 1, open: 0 });
    const page = store.readPage({ fromTs: 0, toTs: T0 + 100_000 });
    expect(page.icebergs).toEqual([expect.objectContaining({ id: `/NQZ26:XCME|1|${T0 - 20_000}`, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31000, display: 10, tranches: 2, executed: 17, markedAt: T0 + 2_000, status: "filled" })]);
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 100_000, settled: 0 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 100_000, settledThrough: T0 + 100_000, gaps: [] });
    expect(store.checkpoint().coverage).toEqual([[T0 - 20_000, T0 + 100_000]]);
    builder.close();
    store.close();
    const fake = { statuses: [], source: null };
    const gapped = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const withGap = createIcebergHostBuilder({
      store: gapped, pair: { ...NQ, symbol: "/ESZ26:XCME" }, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 130_000 }), now: () => T0 + 130_000,
      sourceFactory: ({ onEvents, onStatus }) => {
        let last = T0;
        fake.source = { advanceTo: (toTs) => { for (let ts = last + 10_000; ts <= toTs; ts += 10_000) { if (ts === T0 + 30_000) onStatus("UNAVAILABLE", ts); if (ts === T0 + 70_000) onStatus("READY", ts); onEvents([], { snapshot: false, receivedAt: ts }); last = ts; } }, close: () => {}, stats: {} };
        return fake.source;
      },
    });
    expect(withGap.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    expect(gapped.checkpoint().gaps).toEqual([[T0 + 30_000, T0 + 60_000, "BOOK_UNAVAILABLE"]]);
    expect(withGap.runChunk()).toMatchObject({ built: true, to: T0 + 120_000 });
    expect(gapped.checkpoint().gaps).toEqual([[T0 + 30_000, T0 + 70_000, "BOOK_UNAVAILABLE"]]);
    withGap.close();
    gapped.close();
  });

  test("the first run keeps the warm-up out of what is served: icebergs marked before the start are dropped, and the start is the capture's beginning plus the warm-up", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath);
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    const builder = createIcebergHostBuilder({ store, pair: BTC, dbPath, chunkMs: 30_000, lagMs: 0, captureMarginMs: 0, warmupMs: 25_000, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 60_000 }), now: () => T0 + 60_000, cutsFactory: fixedCuts });
    builder.runChunk();
    builder.runChunk();
    expect(store.readPage({ fromTs: 0, toTs: T0 + 100_000 }).icebergs).toEqual([]);
    expect(store.checkpoint()).toMatchObject({ start: T0 + 20_000, coverage: [[T0 + 20_000, T0 + 55_000]] });
    builder.close();
    store.close();
  });

  test("an iceberg still open at a chunk's end holds the settled line at its mark until it settles, and a stretch of capture silence is a gap", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath, { defendAt: T0 + 10_000, quietUntil: T0 + 120_000 });
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    const builder = createIcebergHostBuilder({ store, pair: BTC, dbPath, chunkMs: 8_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 120_000 }), now: () => T0 + 120_000, cutsFactory: fixedCuts });
    builder.runChunk();
    builder.runChunk();
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 11_000, to: T0 + 19_000, settled: 0, open: 1 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 19_000, settledThrough: T0 + 16_000 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 19_000, to: T0 + 27_000, settled: 1, open: 0 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 27_000, settledThrough: T0 + 27_000, gaps: [] });
    builder.close();
    store.close();
    const quiet = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const silent = createIcebergHostBuilder({
      store: quiet, pair: { ...NQ, symbol: "/ESZ26:XCME" }, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 130_000 }), now: () => T0 + 130_000,
      sourceFactory: ({ onEvents }) => ({ advanceTo: (toTs) => { for (const ts of [T0 + 5_000, T0 + 10_000, T0 + 55_000, T0 + 100_000, T0 + 110_000]) if (ts < toTs && ts >= toTs - 60_000) onEvents([], { snapshot: false, receivedAt: ts }); }, close: () => {}, stats: {} }),
    });
    silent.runChunk();
    silent.runChunk();
    expect(quiet.checkpoint()).toMatchObject({ gaps: [[T0 + 10_000, T0 + 55_000, "NO_CAPTURE"], [T0 + 55_000, T0 + 100_000, "NO_CAPTURE"]], coverage: [[T0, T0 + 120_000]] });
    expect(quiet.watched()).toEqual([[T0, T0 + 10_000], [T0 + 100_000, T0 + 120_000]]);
    silent.close();
    quiet.close();
  });

  test("the learned cuts are checkpointed with every chunk and handed back to the trackers after a restart", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath);
    const pairKey = "binance:PERPETUAL:BTCUSDT";
    const loaded = [];
    const cutsFactory = () => ({ ...fixedCuts(), toJSON: () => ({ version: 1, touch: [1], durations: [2], ratios: [3] }), load: (saved) => { loaded.push(saved); return true; } });
    const store = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store, pair: BTC, dbPath, chunkMs: 30_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 60_000 }), now: () => T0 + 60_000, cutsFactory });
    builder.runChunk();
    expect(store.checkpoint().cuts).toEqual({ version: 1, touch: [1], durations: [2], ratios: [3] });
    builder.close();
    store.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, pair: BTC, dbPath, chunkMs: 30_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: T0 + 60_000 }), now: () => T0 + 60_000, cutsFactory });
    resumed.runChunk();
    expect(loaded).toEqual([{ version: 1, touch: [1], durations: [2], ratios: [3] }]);
    resumed.close();
    again.close();
  });

  test("options are checked", () => {
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    expect(() => createIcebergHostBuilder({ store, pair: { provider: "okx", marketKind: "SPOT", symbol: "BTCUSDT" }, dbPath: "x" })).toThrow(/provider/);
    expect(() => createIcebergHostBuilder({ store, pair: BTC, dbPath: "x", chunkMs: 0 })).toThrow(/chunkMs/);
    expect(() => createIcebergHostBuilder({ pair: BTC, dbPath: "x" })).toThrow(/store/);
    store.close();
  });

  test("a book that crosses and uncrosses, or is snapshotted again, inside one receive millisecond leaves no gap, and the pair keeps building", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    const rows = snapshotRows(T0 - 20_000, T0 - 20_000);
    for (let ts = T0 - 10_000; ts < T0 + 130_000; ts += 10_000) rows.push(askRefresh(ts));
    rows.push({ ts: T0 + 30_000, index: 3, action: "NEW", price: 31002, size: 1, side: "BUY" }, { ts: T0 + 30_000, index: 3, action: "DELETE", price: 31002, size: 0, side: "BUY" });
    rows.push(...snapshotRows(T0 + 70_000, T0 + 70_000));
    writeNq(dbPath, rows);
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    const statuses = [];
    const lines = [];
    const builder = createIcebergHostBuilder({
      store, pair: NQ, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0 - 20_000, latest: T0 + 130_000 }), now: () => T0 + 130_000, log: (line) => lines.push(line),
      sourceFactory: ({ pair, dbPath: capture, fromTs, onEvents, onStatus }) => createDxFeedIcebergSource({
        dbPath: capture, symbol: pair.symbol, assetClass: pair.marketKind, fromTs, onEvents,
        onStatus: (status, ts) => {
          statuses.push([status, ts]);
          onStatus(status, ts);
        },
      }),
    });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 40_000 });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 100_000 });
    expect(statuses).toEqual([["READY", T0 - 20_000], ["UNAVAILABLE", T0 + 30_000], ["READY", T0 + 30_000], ["UNAVAILABLE", T0 + 70_000], ["READY", T0 + 70_000]]);
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 100_000, settledThrough: T0 + 100_000, gaps: [] });
    expect(builder.droppedGaps).toBe(0);
    expect(lines).toEqual([]);
    builder.close();
    store.close();
  });

  test("a gap the store could not hold is dropped, counted and logged once, and the pair keeps building instead of stalling", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const lines = [];
    const builder = createIcebergHostBuilder({
      store, pair: ES, dbPath: "unused", chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 200_000 }), now: () => T0 + 200_000, log: (line) => lines.push(line),
      sourceFactory: ({ onEvents, onStatus }) => {
        let from = T0;
        return {
          advanceTo: (toTs) => {
            for (let ts = from; ts < toTs; ts += 10_000) onEvents([], { snapshot: false, receivedAt: ts });
            from = toTs;
            if (toTs === T0 + 60_000) onStatus("UNAVAILABLE", toTs + 5_000);
            if (toTs === T0 + 120_000) {
              onStatus("READY", T0 + 70_000);
              onStatus("UNAVAILABLE", toTs + 5_000);
            }
          },
          close: () => {},
          stats: {},
        };
      },
    });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 60_000, gaps: [] });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 120_000 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 120_000, gaps: [[T0 + 65_000, T0 + 70_000, "BOOK_UNAVAILABLE"]] });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 180_000 });
    expect(store.checkpoint().gaps).toEqual([[T0 + 65_000, T0 + 70_000, "BOOK_UNAVAILABLE"], [T0 + 125_000, T0 + 180_000, "BOOK_UNAVAILABLE"]]);
    expect(builder.droppedGaps).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^iceberg-host-builder: \/ESZ26:XCME dropped a BOOK_UNAVAILABLE gap the store cannot hold/)]);
    builder.close();
    store.close();
  });

  test("a restart while the dxFeed book is unavailable keeps the saved gap open until the book is ready after the cursor, and the replay writes no inverted gap", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    const S1 = T0 - 60 * MIN;
    const S2 = T0 - 30 * MIN;
    const S3 = T0 + 22 * MIN;
    const rows = [...snapshotRows(S1, S1 + 400), ...snapshotRows(S2, S2 + 400), { ts: T0, index: 3, action: "NEW", price: 31005, size: 1, side: "BUY" }, ...snapshotRows(S3, S3 + 400)];
    for (let ts = S1 + 10_000; ts < T0 + 25 * MIN; ts += 20_000) rows.push(askRefresh(ts));
    writeNq(dbPath, rows);
    const pairKey = "dxfeed:FUTURE:/NQZ26:XCME";
    const clock = { at: T0 + 15 * MIN };
    const options = { pair: NQ, dbPath, chunkMs: 5 * MIN, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: S1, latest: clock.at }), now: () => clock.at };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    for (let i = 0; i < 16; i += 1) builder.runChunk();
    builder.close();
    expect(first.checkpoint()).toMatchObject({ cursor: T0 + 15 * MIN, gaps: [[S2, S2 + 400, "BOOK_UNAVAILABLE"], [T0, T0 + 15 * MIN, "BOOK_UNAVAILABLE"], [T0 + 30_000, T0 + 15 * MIN, "NO_CAPTURE"]] });
    first.close();
    clock.at = T0 + 25 * MIN;
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 15 * MIN, to: T0 + 20 * MIN });
    expect(again.checkpoint().gaps).toEqual([[S2, S2 + 400, "BOOK_UNAVAILABLE"], [T0, T0 + 20 * MIN, "BOOK_UNAVAILABLE"], [T0 + 30_000, T0 + 20 * MIN, "NO_CAPTURE"]]);
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 20 * MIN, to: T0 + 25 * MIN });
    expect(again.checkpoint().gaps).toEqual([[S2, S2 + 400, "BOOK_UNAVAILABLE"], [T0, S3 + 400, "BOOK_UNAVAILABLE"], [T0 + 30_000, S3 + 400, "NO_CAPTURE"]]);
    resumed.close();
    again.close();
  });

  test("a restart re-derives none of the saved gaps from the rows it replays before the cursor", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    const S1 = T0 - 60 * MIN;
    const S2 = T0 + 9 * MIN;
    const rows = [...snapshotRows(S1, S1 + 400), ...snapshotRows(S2, S2 + 400)];
    for (let ts = S1 + 10_000; ts < T0 + 25 * MIN; ts += 20_000) if (ts < T0 + 7 * MIN || ts >= T0 + 8 * MIN) rows.push(askRefresh(ts));
    writeNq(dbPath, rows);
    const pairKey = "dxfeed:FUTURE:/NQZ26:XCME";
    const clock = { at: T0 + 15 * MIN };
    const options = { pair: NQ, dbPath, chunkMs: 5 * MIN, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: S1, latest: clock.at }), now: () => clock.at };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    for (let i = 0; i < 16; i += 1) builder.runChunk();
    builder.close();
    const saved = first.checkpoint().gaps;
    expect(saved).toEqual([[T0 + 6 * MIN + 50_000, T0 + 8 * MIN + 10_000, "NO_CAPTURE"], [S2, S2 + 400, "BOOK_UNAVAILABLE"]]);
    first.close();
    clock.at = T0 + 25 * MIN;
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 15 * MIN });
    expect(resumed.runChunk()).toMatchObject({ built: true, to: T0 + 25 * MIN });
    expect(again.checkpoint().gaps).toEqual(saved);
    resumed.close();
    again.close();
  });

  test("a native iceberg ends where the runtime ends it: interrupted on the receive clock of the row that dropped the live book, not at the next snapshot", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    writeNq(dbPath, droppedBookRows(T0 + 130_000));
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    const builder = createIcebergHostBuilder({ store, pair: NQ, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 20_000, latest: T0 + 300_000 }), now: () => T0 + 300_000 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 - 20_000, to: T0 + 40_000, settled: 0, open: 1 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 40_000, to: T0 + 100_000, settled: 1, open: 0 });
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 100_000, settledThrough: T0 + 100_000 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 100_000, to: T0 + 160_000, settled: 0, open: 0 });
    expect(store.readPage({ fromTs: 0, toTs: T0 + 300_000 }).icebergs).toEqual([expect.objectContaining({ id: `/NQZ26:XCME|1|${T0 - 20_000}`, kind: "native", side: "bid", price: 31000, tranches: 2, markedAt: T0 + 2_000, updatedAt: T0 + 60_000, status: "interrupted" })]);
    builder.close();
    store.close();
  });

  test("a restart re-warms the native lives through a dropped book as well: the replay before the cursor ends them where the runtime did, so no stale life holds the settled line or settles again at the next snapshot", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    writeNq(dbPath, droppedBookRows(T0 + 190_000));
    const pairKey = "dxfeed:FUTURE:/NQZ26:XCME";
    const options = { pair: NQ, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 20_000, latest: T0 + 300_000 }), now: () => T0 + 300_000 };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    builder.runChunk();
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 100_000, settled: 1, open: 0 });
    builder.close();
    first.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toEqual({ built: true, from: T0 + 100_000, to: T0 + 160_000, settled: 0, open: 0 });
    expect(again.checkpoint()).toMatchObject({ settledThrough: T0 + 160_000, gaps: [[T0 + 25_000, T0 + 160_000, "BOOK_UNAVAILABLE"], [T0 + 60_000, T0 + 160_000, "NO_CAPTURE"]] });
    expect(resumed.runChunk()).toEqual({ built: true, from: T0 + 160_000, to: T0 + 220_000, settled: 0, open: 0 });
    expect(again.checkpoint().gaps).toEqual([[T0 + 25_000, T0 + 190_000, "BOOK_UNAVAILABLE"], [T0 + 60_000, T0 + 190_000, "NO_CAPTURE"]]);
    expect(again.readPage({ fromTs: 0, toTs: T0 + 300_000 }).icebergs).toEqual([expect.objectContaining({ id: `/NQZ26:XCME|1|${T0 - 20_000}`, updatedAt: T0 + 60_000, status: "interrupted" })]);
    expect(resumed.droppedGaps).toBe(0);
    resumed.close();
    again.close();
  });

  test("the saved gap that ends at the cursor is the one a restart keeps open, wherever it sorts among the saved gaps", () => {
    const pairKey = "dxfeed:FUTURE:/ESZ26:XCME";
    const script = [[T0 + 5_000], [T0 + 10_000, "UNAVAILABLE"], [T0 + 15_000], [T0 + 55_000], [T0 + 65_000], [T0 + 75_000], [T0 + 85_000], [T0 + 90_000, "READY"], [T0 + 95_000], [T0 + 105_000], [T0 + 115_000]];
    const options = {
      pair: ES, dbPath: "unused", chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 200_000 }), now: () => T0 + 200_000, sourceFactory: scriptedSource(script),
    };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    builder.close();
    expect(first.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 60_000, "BOOK_UNAVAILABLE"], [T0 + 15_000, T0 + 55_000, "NO_CAPTURE"]]);
    first.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 60_000, to: T0 + 120_000 });
    expect(again.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 90_000, "BOOK_UNAVAILABLE"], [T0 + 15_000, T0 + 55_000, "NO_CAPTURE"]]);
    resumed.close();
    again.close();
  });

  test("a chunk that ends inside a capture silence longer than the gap checkpoints it as an open NO_CAPTURE gap, which the next checkpoint extends or closes at the next event, never twice, and a blind source is never watched", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const options = { pair: ES, dbPath: "unused", chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0, latest: T0 + 300_000 }), now: () => T0 + 300_000 };
    const builder = createIcebergHostBuilder({ store, ...options, sourceFactory: scriptedSource([[T0 + 10_000], [T0 + 150_000], [T0 + 165_000]]) });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    expect(store.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 60_000, "NO_CAPTURE"]]);
    expect(store.watched()).toEqual([[T0, T0 + 10_000]]);
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 120_000 });
    expect(store.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 120_000, "NO_CAPTURE"]]);
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 180_000 });
    expect(store.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 150_000, "NO_CAPTURE"]]);
    expect(store.watched()).toEqual([[T0, T0 + 10_000], [T0 + 150_000, T0 + 180_000]]);
    expect(builder.droppedGaps).toBe(0);
    builder.close();
    store.close();
    const blindStore = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    const blind = createIcebergHostBuilder({ store: blindStore, ...options, pair: NQ, sourceFactory: scriptedSource([]) });
    expect(blind.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    expect(blindStore.checkpoint()).toMatchObject({ coverage: [[T0, T0 + 60_000]], gaps: [[T0, T0 + 60_000, "NO_CAPTURE"]] });
    expect(blind.runChunk()).toMatchObject({ built: true, to: T0 + 120_000 });
    expect(blindStore.checkpoint().gaps).toEqual([[T0, T0 + 120_000, "NO_CAPTURE"]]);
    expect(blindStore.watched()).toEqual([]);
    expect(blind.droppedGaps).toBe(0);
    blind.close();
    blindStore.close();
  });

  test("a restart inside a capture silence keeps the silence's true start, even one from before the re-warm, and saves its gap once", () => {
    const pairKey = "dxfeed:FUTURE:/ESZ26:XCME";
    const options = {
      pair: ES, dbPath: "unused", chunkMs: 60_000, rewarmMs: 20_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 300_000 }), now: () => T0 + 300_000, sourceFactory: scriptedSource([[T0 + 10_000], [T0 + 150_000], [T0 + 165_000]]),
    };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 60_000 });
    builder.close();
    expect(first.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 60_000, "NO_CAPTURE"]]);
    first.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 60_000, to: T0 + 120_000 });
    expect(again.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 120_000, "NO_CAPTURE"]]);
    expect(resumed.runChunk()).toMatchObject({ built: true, to: T0 + 180_000 });
    expect(again.checkpoint().gaps).toEqual([[T0 + 10_000, T0 + 150_000, "NO_CAPTURE"]]);
    expect(again.watched()).toEqual([[T0, T0 + 10_000], [T0 + 150_000, T0 + 180_000]]);
    expect(resumed.droppedGaps).toBe(0);
    resumed.close();
    again.close();
  });

  test("a restart in the middle of the Binance warm-up replays the rest of the warm-up from just before the cursor, and the capture's beginning is asked for only when an open needs it", () => {
    const HOUR = 3_600_000;
    const opened = [];
    const asked = [];
    const pairKey = "binance:PERPETUAL:BTCUSDT";
    const options = {
      pair: BTC, dbPath: "unused", chunkMs: HOUR, lagMs: 0, captureMarginMs: 0, warmupMs: 24 * HOUR, retentionMs: 7 * 86_400_000, cutsFactory: fixedCuts,
      captureBounds: (wanted) => {
        asked.push(wanted?.earliest);
        return { earliest: T0, latest: T0 + 48 * HOUR };
      },
      now: () => T0 + 48 * HOUR,
      sourceFactory: ({ fromTs }) => {
        opened.push(fromTs);
        return { advanceTo: () => {}, close: () => {}, stats: {} };
      },
    };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    for (let i = 0; i < 6; i += 1) expect(builder.runChunk()).toMatchObject({ built: true });
    builder.close();
    expect(first.checkpoint()).toMatchObject({ cursor: T0 + 6 * HOUR, start: T0 + 24 * HOUR, coverage: [] });
    first.close();
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    expect(resumed.runChunk()).toMatchObject({ built: true, from: T0 + 6 * HOUR, to: T0 + 7 * HOUR });
    expect(opened).toEqual([T0, T0 + 6 * HOUR - DEFAULT_REWARM_MS]);
    expect(asked).toEqual([true, false, false, false, false, false, false, true, false]);
    resumed.close();
    again.close();
  });

  test("a restart inside the Binance warm-up serves nothing marked before the start: the settled line never drops below it, so the warm-up's icebergs are not checkpointed", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    seedBinance(dbPath, { defendAt: T0 + 10_000, quietUntil: T0 + 120_000 });
    const pairKey = "binance:PERPETUAL:BTCUSDT";
    const clock = { at: T0 + 10_000 };
    const options = { pair: BTC, dbPath, chunkMs: 5_000, lagMs: 0, captureMarginMs: 0, warmupMs: 60_000, retentionMs: 86_400_000, captureBounds: () => ({ earliest: T0 - 5_000, latest: clock.at }), now: () => clock.at, cutsFactory: fixedCuts };
    const first = openIcebergHostStore({ dir, pairKey });
    const builder = createIcebergHostBuilder({ store: first, ...options });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 5_000 });
    builder.close();
    expect(first.checkpoint()).toMatchObject({ cursor: T0 + 5_000, start: T0 + 55_000, settledThrough: T0 + 5_000, coverage: [] });
    first.close();
    clock.at = T0 + 120_000;
    const again = openIcebergHostStore({ dir, pairKey });
    const resumed = createIcebergHostBuilder({ store: again, ...options });
    const outcomes = [];
    for (let i = 0; i < 24; i += 1) outcomes.push(resumed.runChunk());
    expect(outcomes.filter((entry) => entry.built)).toHaveLength(23);
    expect(outcomes[23]).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 120_000 });
    expect(again.checkpoint()).toMatchObject({ cursor: T0 + 120_000, start: T0 + 55_000, coverage: [[T0 + 55_000, T0 + 120_000]] });
    expect(again.readPage({ fromTs: 0, toTs: T0 + 200_000 }).icebergs).toEqual([]);
    expect(again.stats().icebergs).toBe(0);
    resumed.close();
    again.close();
  });

  test("a store prune sticks: the next checkpoint keeps the start, the coverage and the gaps at the retention cut", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const clock = { at: T0 + 15 * MIN };
    const script = [[T0 + 30_000], [T0 + 3 * MIN], [T0 + 3 * MIN + 15_000], [T0 + 11 * MIN]];
    for (let ts = T0 + 11 * MIN + 15_000; ts < T0 + 30 * MIN; ts += 15_000) script.push([ts]);
    const builder = createIcebergHostBuilder({
      store, pair: ES, dbPath: "unused", chunkMs: 5 * MIN, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 20 * MIN,
      captureBounds: () => ({ earliest: T0, latest: clock.at }), now: () => clock.at, sourceFactory: scriptedSource(script),
    });
    for (let i = 0; i < 3; i += 1) expect(builder.runChunk()).toMatchObject({ built: true });
    expect(store.checkpoint()).toMatchObject({ start: T0, coverage: [[T0, T0 + 15 * MIN]], gaps: [[T0 + 30_000, T0 + 3 * MIN, "NO_CAPTURE"], [T0 + 3 * MIN + 15_000, T0 + 11 * MIN, "NO_CAPTURE"]] });
    clock.at = T0 + 30 * MIN;
    store.prune(clock.at - 20 * MIN);
    expect(store.checkpoint()).toMatchObject({ start: T0 + 10 * MIN, coverage: [[T0 + 10 * MIN, T0 + 15 * MIN]], gaps: [[T0 + 10 * MIN, T0 + 11 * MIN, "NO_CAPTURE"]] });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 20 * MIN });
    expect(store.checkpoint()).toMatchObject({ start: T0 + 10 * MIN, coverage: [[T0 + 10 * MIN, T0 + 20 * MIN]], gaps: [[T0 + 10 * MIN, T0 + 11 * MIN, "NO_CAPTURE"]] });
    expect(builder.runChunk()).toMatchObject({ built: true, to: T0 + 25 * MIN });
    expect(store.checkpoint()).toMatchObject({ start: T0 + 10 * MIN, coverage: [[T0 + 10 * MIN, T0 + 25 * MIN]], gaps: [[T0 + 10 * MIN, T0 + 11 * MIN, "NO_CAPTURE"]] });
    expect(store.watched()).toEqual([[T0 + 11 * MIN, T0 + 25 * MIN]]);
    builder.close();
    store.close();
  });

  test("a source that fails to open fails its chunk and leaves nothing half open: close() still works and the next chunk opens it again", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const stopped = [];
    let attempts = 0;
    const builder = createIcebergHostBuilder({
      store, pair: ES, dbPath: "unused", chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => ({ earliest: T0, latest: T0 + 200_000 }), now: () => T0 + 200_000,
      indicatorFactory: (options) => {
        const indicator = createIcebergIndicator(options);
        const opening = attempts + 1;
        return { ...indicator, stop: () => { stopped.push(opening); indicator.stop(); } };
      },
      sourceFactory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("SQLITE_BUSY: database is locked");
        return { advanceTo: () => {}, close: () => {}, stats: {} };
      },
    });
    expect(() => builder.runChunk()).toThrow(/SQLITE_BUSY/);
    expect(stopped).toEqual([1]);
    expect(() => builder.close()).not.toThrow();
    expect(builder.runChunk()).toMatchObject({ built: true, from: T0, to: T0 + 60_000 });
    expect(attempts).toBe(2);
    builder.close();
    expect(stopped).toEqual([1, 2]);
    store.close();
  });

  test("a pair whose capture cannot be read says CAPTURE_UNREADABLE, when it opens and when a chunk waits, instead of NO_CAPTURE or AWAITING_CAPTURE", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/ESZ26:XCME" });
    const unreadable = { earliest: null, latest: null, reason: "CAPTURE_UNREADABLE" };
    const answers = [unreadable, { earliest: T0, latest: T0 + 200_000 }, unreadable];
    const builder = createIcebergHostBuilder({
      store, pair: ES, dbPath: "unused", chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000,
      captureBounds: () => answers.shift() ?? { earliest: T0, latest: T0 + 200_000 }, now: () => T0 + 200_000, sourceFactory: scriptedSource([]),
    });
    expect(builder.runChunk()).toEqual({ built: false, reason: "CAPTURE_UNREADABLE", from: null });
    expect(builder.runChunk()).toEqual({ built: false, reason: "CAPTURE_UNREADABLE", from: T0 });
    expect(builder.runChunk()).toMatchObject({ built: true, from: T0, to: T0 + 60_000 });
    builder.close();
    store.close();
  });

  test("the capture bounds are single-row lookups in index order on the pinned indexes, never a scan, a sort or an aggregate over the pair's rows, and the beginning is read only when asked for", () => {
    const binancePath = path.join(dir, "binance.sqlite");
    const dxfeedPath = path.join(dir, "dxfeed.sqlite");
    seedBinance(binancePath);
    seedDxFeed(dxfeedPath);
    const prepared = [];
    class Recording extends Database {
      prepare(sql) {
        prepared.push(sql);
        return super.prepare(sql);
      }
    }
    const bounds = createCaptureBounds({ dbPaths: { binance: binancePath, dxfeed: dxfeedPath }, Database: Recording });
    expect(bounds.of(BTC)).toEqual({ earliest: T0 - 5_000, latest: T0 + 55_000 });
    expect(bounds.of(NQ)).toEqual({ earliest: T0 - 20_000, latest: T0 + 110_000 });
    const pinned = { dxfeed_order_book_capture: "idx_dxfeed_order_book_capture_arrival", l2_depth_events: "idx_l2_depth_events_symbol_market_ts", l2_depth_snapshots: "idx_l2_depth_snapshots_symbol_market_captured_at" };
    const lookups = prepared.filter((sql) => /FROM (dxfeed_order_book_capture|l2_depth_events|l2_depth_snapshots) /.test(sql));
    for (const sql of lookups) {
      const table = /FROM (\w+) /.exec(sql)[1];
      const db = new Database(table === "dxfeed_order_book_capture" ? dxfeedPath : binancePath, { readonly: true });
      try {
        const params = (sql.match(/\?/g) ?? []).map(() => "x");
        expect(db.prepare(`EXPLAIN ${sql}`).all(...params).map((step) => step.opcode)).not.toContain("AggStep");
        expect(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((step) => step.detail)).toEqual([expect.stringMatching(new RegExp(`^SEARCH ${table} USING (COVERING )?INDEX ${pinned[table]} \\(`))]);
      } finally {
        db.close();
      }
    }
    expect(lookups.map((sql) => /FROM (\w+) /.exec(sql)[1]).sort()).toEqual(["dxfeed_order_book_capture", "dxfeed_order_book_capture", "l2_depth_events", "l2_depth_events", "l2_depth_snapshots", "l2_depth_snapshots"]);
    expect(bounds.of(NQ, { earliest: false })).toEqual({ earliest: null, latest: T0 + 110_000 });
    expect(bounds.of(BTC, { earliest: false })).toEqual({ earliest: null, latest: T0 + 55_000 });
    bounds.close();
  });

  test("a capture that cannot be read is not cached: the first failure is logged, the answer says CAPTURE_UNREADABLE, the open is retried until the file appears, and a missing pinned index fails the same way", () => {
    const lines = [];
    const dxfeedPath = path.join(dir, "late", "dxfeed.sqlite");
    const binancePath = path.join(dir, "binance.sqlite");
    seedBinance(binancePath);
    const raw = new Database(binancePath);
    raw.exec("DROP INDEX idx_l2_depth_events_symbol_market_ts");
    raw.close();
    const bounds = createCaptureBounds({ dbPaths: { binance: binancePath, dxfeed: dxfeedPath }, log: (line) => lines.push(line) });
    const unreadable = [bounds.of(NQ), bounds.of(NQ, { earliest: false }), bounds.of(BTC)];
    fs.mkdirSync(path.dirname(dxfeedPath));
    seedDxFeed(dxfeedPath);
    expect(bounds.of(NQ)).toEqual({ earliest: T0 - 20_000, latest: T0 + 110_000 });
    expect(unreadable).toEqual([0, 1, 2].map(() => ({ earliest: null, latest: null, reason: "CAPTURE_UNREADABLE" })));
    expect(lines).toEqual([
      expect.stringMatching(/^iceberg-host-builder: cannot read the dxfeed capture .*dxfeed\.sqlite/),
      expect.stringMatching(/^iceberg-host-builder: cannot read the binance capture .*no such index: idx_l2_depth_events_symbol_market_ts/),
      "iceberg-host-builder: the dxfeed capture opened after 2 failed attempts",
    ]);
    bounds.close();
  });
});
