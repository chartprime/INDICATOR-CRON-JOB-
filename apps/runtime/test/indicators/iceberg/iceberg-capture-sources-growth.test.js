const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { SNAPSHOT_BEGIN_BIT } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
const { openIcebergHostStore } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { createIcebergHostBuilder, createCaptureBounds } = require("../../../src/indicators/iceberg/iceberg-host-builder");

const SNAPSHOT_END_BIT = 0x08;
const T0 = 1_700_000_100_000;
const FIXED = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3, minRatioSamples: 1 });
const fixedCuts = () => ({ current: () => FIXED, observeTouch() {}, observeEpisode() {} });
const NQ = Object.freeze({ provider: "dxfeed", marketKind: "FUTURE", symbol: "/NQZ26:XCME" });
const BTC = Object.freeze({ provider: "binance", marketKind: "PERPETUAL", symbol: "BTCUSDT" });

describe("indicators/iceberg/iceberg-capture-sources over a growing capture", () => {
  let dir;
  let handles;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-capture-growth-"));
    handles = [];
  });
  afterEach(() => {
    for (const handle of handles.reverse()) handle.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("the host builder keeps reading a dxFeed capture that grows after it started: an iceberg written after the first chunk reaches the store", () => {
    const dbPath = path.join(dir, "dxfeed.sqlite");
    const capture = createDxFeedStorageDb({ dbPath });
    handles.push(capture);
    const order = ({ ts, index, flags = 0, action = "NEW", price, size, side }) => capture.insert("dxfeed_order_book_capture", {
      eventTime: ts, receivedAt: ts, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: NQ.symbol, stale: 0, recoveryState: "READY",
      orderIndex: String(index), eventFlags: flags, time: ts, action, actionTime: ts, orderId: Number(index), price, size, side, scope: "ORDER", source: "GLBX", marketMaker: null,
    });
    const quote = (fromTs, toTs) => {
      for (let ts = fromTs; ts <= toTs; ts += 10_000) order({ ts, index: 2, action: "PARTIAL", price: 31001, size: 3, side: "SELL" });
    };
    order({ ts: T0 - 20_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 31000, size: 10, side: "BUY" });
    order({ ts: T0 - 20_000, index: 2, flags: SNAPSHOT_END_BIT, price: 31001, size: 3, side: "SELL" });
    order({ ts: T0 + 1_000, index: 1, action: "PARTIAL", price: 31000, size: 3, side: "BUY" });
    order({ ts: T0 + 2_000, index: 1, action: "PARTIAL", price: 31000, size: 10, side: "BUY" });
    order({ ts: T0 + 3_000, index: 1, action: "EXECUTE", price: 31000, size: Number.NaN, side: "BUY" });
    quote(T0 + 10_000, T0 + 60_000);
    const bounds = createCaptureBounds({ dbPaths: { dxfeed: dbPath } });
    handles.push(bounds);
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    handles.push(store);
    const clock = { at: T0 + 60_000 };
    const builder = createIcebergHostBuilder({ store, pair: NQ, dbPath, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => bounds.of(NQ), now: () => clock.at });
    handles.push(builder);
    expect(builder.runChunk()).toEqual({ built: true, from: T0 - 20_000, to: T0 + 40_000, settled: 1, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 40_000 });
    order({ ts: T0 + 70_000, index: 5, price: 31002, size: 4, side: "SELL" });
    order({ ts: T0 + 71_000, index: 5, action: "PARTIAL", price: 31002, size: 1, side: "SELL" });
    order({ ts: T0 + 72_000, index: 5, action: "PARTIAL", price: 31002, size: 4, side: "SELL" });
    order({ ts: T0 + 73_000, index: 5, action: "EXECUTE", price: 31002, size: Number.NaN, side: "SELL" });
    quote(T0 + 80_000, T0 + 160_000);
    clock.at = T0 + 160_000;
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 40_000, to: T0 + 100_000, settled: 1, open: 0 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 100_000, to: T0 + 160_000, settled: 0, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 160_000 });
    expect(store.readPage({ fromTs: 0, toTs: T0 + 200_000 }).icebergs).toEqual([
      expect.objectContaining({ id: `/NQZ26:XCME|1|${T0 - 20_000}`, kind: "native", side: "bid", price: 31000, markedAt: T0 + 2_000, status: "filled" }),
      expect.objectContaining({ id: `/NQZ26:XCME|5|${T0 + 70_000}`, kind: "native", side: "ask", price: 31002, display: 4, tranches: 2, executed: 7, markedAt: T0 + 72_000, status: "filled" }),
    ]);
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 160_000, settledThrough: T0 + 160_000, coverage: [[T0 - 20_000, T0 + 160_000]], gaps: [] });
  });

  test("the host builder keeps reading a Binance capture that grows after it started: a level defended after the first chunk reaches the store", () => {
    const dbPath = path.join(dir, "binance.sqlite");
    const capture = createStorageDb({ dbPath });
    handles.push(capture);
    const db = capture.raw;
    const diff = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const trade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let u = 2;
    const quiet = (fromTs, toTs) => {
      for (let ts = fromTs; ts <= toTs; ts += 5_000) {
        diff.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["80999.0", String(2 + (u % 3))]]), "[]");
        u += 1;
      }
    };
    db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
      .run(T0 - 5_000, "BTCUSDT", "PERPETUAL", 1, JSON.stringify([["81000.0", "1.0"], ["80999.0", "2.0"]]), JSON.stringify([["81001.0", "3.0"]]));
    quiet(T0, T0 + 30_000);
    const bounds = createCaptureBounds({ dbPaths: { binance: dbPath } });
    handles.push(bounds);
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    handles.push(store);
    const clock = { at: T0 + 30_000 };
    const builder = createIcebergHostBuilder({ store, pair: BTC, dbPath, chunkMs: 30_000, lagMs: 0, captureMarginMs: 0, warmupMs: 0, retentionMs: 86_400_000, captureBounds: () => bounds.of(BTC), now: () => clock.at, cutsFactory: fixedCuts });
    handles.push(builder);
    expect(builder.runChunk()).toEqual({ built: true, from: T0 - 5_000, to: T0 + 25_000, settled: 0, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 25_000 });
    for (let i = 0; i < 8; i += 1) {
      const ts = T0 + 40_000 + i * 1_000;
      trade.run(ts, "BTCUSDT", "PERPETUAL", "81000.0", "0.3", "sell", `d${i}`);
      diff.run(ts + 50, ts + 55, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["81000.0", "1.0"]]), "[]");
      u += 1;
    }
    quiet(T0 + 50_000, T0 + 90_000);
    clock.at = T0 + 90_000;
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 25_000, to: T0 + 55_000, settled: 1, open: 0 });
    expect(builder.runChunk()).toEqual({ built: true, from: T0 + 55_000, to: T0 + 85_000, settled: 0, open: 0 });
    expect(builder.runChunk()).toEqual({ built: false, reason: "AWAITING_CAPTURE", from: T0 + 85_000 });
    expect(store.readPage({ fromTs: 0, toTs: T0 + 200_000 }).icebergs).toEqual([
      expect.objectContaining({ id: `BTCUSDT|PERPETUAL|bid|81000|${T0 + 40_000}`, kind: "probable", side: "bid", price: 81000, markedAt: T0 + 46_000, status: "ended" }),
    ]);
    expect(store.checkpoint()).toMatchObject({ cursor: T0 + 85_000, settledThrough: T0 + 85_000, coverage: [[T0 - 5_000, T0 + 85_000]], gaps: [] });
  });
});
