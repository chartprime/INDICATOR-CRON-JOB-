const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../../helpers/temp-files");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { SNAPSHOT_BEGIN_BIT } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
const { createDxFeedIcebergSource, createBinanceIcebergSource } = require("../../../src/indicators/iceberg/iceberg-capture-sources");

const SNAPSHOT_END_BIT = 0x08;
const SNAPSHOT_SNIP_BIT = 0x10;
const T = 1_700_000_000_000;
const SYMBOL = "/NQZ26:XCME";

function tempDbPath(name) {
  return path.join(os.tmpdir(), `iceberg-capture-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function order(storage, { ts, receivedAt = ts, index, flags = 0, action = "NEW", price, size, side }) {
  storage.insert("dxfeed_order_book_capture", {
    eventTime: ts, receivedAt, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: SYMBOL, stale: 0, recoveryState: "READY",
    orderIndex: String(index), eventFlags: flags, time: ts, action, actionTime: ts, orderId: Number(index), price, size, side, scope: "ORDER", source: "GLBX", marketMaker: null,
  });
}

describe("indicators/iceberg/iceberg-capture-sources", () => {
  describe("dxFeed", () => {
    let dbPath;
    let storage;
    beforeEach(() => {
      dbPath = tempDbPath("dxfeed");
      storage = createDxFeedStorageDb({ dbPath });
    });
    afterEach(() => {
      storage.close();
      safeRm(dbPath);
    });

    test("starts from the last snapshot before the window so every order life is known, hands each applied batch on with the capture's receive clock, and advances in steps", () => {
      order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 1_000, receivedAt: T + 1_050, index: 3, price: 101.25, size: 2, side: "SELL" });
      order(storage, { ts: T + 2_000, receivedAt: T + 2_050, index: 3, action: "PARTIAL", price: 101.25, size: 1, side: "SELL" });
      order(storage, { ts: T + 2_500, receivedAt: T + 2_550, index: 3, action: "PARTIAL", price: 101.25, size: 2, side: "SELL" });
      const batches = [];
      const statuses = [];
      const source = createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: (events, meta) => batches.push({ n: events.length, ...meta, actions: events.map((event) => event.action), index: events[0].index }), onStatus: (status, at) => statuses.push([status, at]) });
      expect(source.startedFromSnapshot).toBe(true);
      source.advanceTo(T + 1_500);
      expect(batches).toEqual([
        { n: 2, snapshot: true, receivedAt: T - 10_000, actions: ["NEW", "NEW"], index: "1" },
        { n: 1, snapshot: false, receivedAt: T + 1_050, actions: ["NEW"], index: "3" },
      ]);
      expect(statuses).toEqual([["READY", T - 10_000]]);
      source.advanceTo(T + 1_500);
      expect(batches).toHaveLength(2);
      source.advanceTo(T + 3_000);
      expect(batches.slice(2)).toEqual([
        { n: 1, snapshot: false, receivedAt: T + 2_050, actions: ["PARTIAL"], index: "3" },
        { n: 1, snapshot: false, receivedAt: T + 2_550, actions: ["PARTIAL"], index: "3" },
      ]);
      expect(source.stats).toEqual({ rows: 5, applied: 5, snapshots: 1, lastReceivedAt: T + 2_550, unavailable: 0 });
      expect(source.ready).toBe(true);
      source.close();
    });

    test("without a snapshot before the window the rows wait for the first one inside it, and an empty capture advances to nothing", () => {
      const batches = [];
      const empty = createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: (events) => batches.push(events.length) });
      expect(empty.startedFromSnapshot).toBe(false);
      empty.advanceTo(T + 60_000);
      expect(batches).toEqual([]);
      order(storage, { ts: T + 500, index: 9, price: 100, size: 1, side: "BUY" });
      order(storage, { ts: T + 1_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T + 1_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 2_000, index: 2, action: "PARTIAL", price: 101, size: 1, side: "SELL" });
      const source = createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: (events, meta) => batches.push([events.length, meta.snapshot]) });
      source.advanceTo(T + 3_000);
      expect(batches).toEqual([[2, true], [1, false]]);
      expect(() => createDxFeedIcebergSource({ dbPath, db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: () => {} })).toThrow(/exactly one/);
      expect(() => createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "SPOT", fromTs: T, onEvents: () => {} })).toThrow(/assetClass/);
      source.close();
    });

    test("a long-lived source on its own connection reads the rows the capture gains after it opened, from where its last advance stopped", () => {
      order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      const batches = [];
      const source = createDxFeedIcebergSource({ dbPath, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: (events, meta) => batches.push([meta.receivedAt, events.map((event) => event.action)]) });
      try {
        source.advanceTo(T + 1_000);
        expect(batches).toEqual([[T - 10_000, ["NEW", "NEW"]]]);
        order(storage, { ts: T + 2_000, receivedAt: T + 2_050, index: 2, action: "PARTIAL", price: 101, size: 1, side: "SELL" });
        order(storage, { ts: T + 2_500, receivedAt: T + 2_550, index: 2, action: "PARTIAL", price: 101, size: 3, side: "SELL" });
        order(storage, { ts: T + 9_000, receivedAt: T + 9_050, index: 4, price: 99, size: 1, side: "BUY" });
        source.advanceTo(T + 3_000);
        expect(batches.slice(1)).toEqual([[T + 2_050, ["PARTIAL"]], [T + 2_550, ["PARTIAL"]]]);
        source.advanceTo(T + 10_000);
        expect(batches.slice(3)).toEqual([[T + 9_050, ["NEW"]]]);
        expect(source.stats).toMatchObject({ rows: 5, lastReceivedAt: T + 9_050 });
      } finally {
        source.close();
      }
    });

    test("reports a live book the assembler drops, once, on the receive clock of the row that dropped it, the way the runtime ends its native lives; a crossing inside the grace, a re-snapshot and the rows while no book is held are no drop", () => {
      order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 1_000, receivedAt: T + 1_050, index: 3, price: 101.5, size: 1, side: "BUY" });
      order(storage, { ts: T + 11_000, receivedAt: T + 11_050, index: 2, action: "PARTIAL", price: 101, size: 2, side: "SELL" });
      order(storage, { ts: T + 31_000, receivedAt: T + 31_050, index: 2, action: "PARTIAL", price: 101, size: 1, side: "SELL" });
      order(storage, { ts: T + 35_000, receivedAt: T + 35_050, index: 2, action: "PARTIAL", price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 40_000, receivedAt: T + 40_050, index: 4, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T + 40_400, receivedAt: T + 40_450, index: 5, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 50_000, receivedAt: T + 50_050, index: 4, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T + 50_400, receivedAt: T + 50_450, index: 5, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
      order(storage, { ts: T + 60_000, receivedAt: T + 60_050, index: 4, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
      order(storage, { ts: T + 60_200, receivedAt: T + 60_250, index: 5, flags: SNAPSHOT_SNIP_BIT, price: 101, size: 3, side: "SELL" });
      const drops = [];
      const statuses = [];
      const source = createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T - 10_000, onEvents: () => {}, onStatus: (status, at) => statuses.push([status, at]), onBookDropped: (at) => drops.push(at) });
      source.advanceTo(T + 70_000);
      expect(drops).toEqual([T + 31_050, T + 60_250]);
      expect(statuses).toEqual([["READY", T - 10_000], ["UNAVAILABLE", T + 1_050], ["READY", T + 40_450], ["UNAVAILABLE", T + 50_050], ["READY", T + 50_450], ["UNAVAILABLE", T + 60_050]]);
      expect(() => createDxFeedIcebergSource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: () => {}, onBookDropped: true })).toThrow(/onBookDropped/);
      source.close();
    });

    test("a source opened on an empty capture finds its start once rows arrive, by the same rule as at open: the last snapshot before its window", () => {
      const batches = [];
      const source = createDxFeedIcebergSource({ dbPath, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, onEvents: (events, meta) => batches.push([meta.receivedAt, events.length, meta.snapshot]) });
      try {
        expect(source.startedFromSnapshot).toBe(false);
        source.advanceTo(T + 1_000);
        expect(batches).toEqual([]);
        order(storage, { ts: T - 5_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
        order(storage, { ts: T - 5_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
        order(storage, { ts: T + 1_500, receivedAt: T + 1_550, index: 2, action: "PARTIAL", price: 101, size: 1, side: "SELL" });
        source.advanceTo(T + 2_000);
        expect(batches).toEqual([[T - 5_000, 2, true], [T + 1_550, 1, false]]);
        expect(source.startedFromSnapshot).toBe(true);
      } finally {
        source.close();
      }
    });
  });

  describe("Binance", () => {
    let dbPath;
    let storage;
    beforeEach(() => {
      dbPath = tempDbPath("binance");
      storage = createStorageDb({ dbPath });
    });
    afterEach(() => {
      storage.close();
      safeRm(dbPath);
    });

    test("replays trades, snapshots and depth diffs in exchange-time order, trades first on a tie, as the live tap sees them, and advances in steps", () => {
      const db = storage.raw;
      db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)").run(T, "BTCUSDT", "PERPETUAL", 10, JSON.stringify([["100.0", "5.0"]]), JSON.stringify([["101.0", "3.0"]]));
      const diff = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      diff.run(T + 100, T + 105, "BTCUSDT", "PERPETUAL", 11, 12, 10, JSON.stringify([["100.0", "4.5"]]), "[]");
      diff.run(T + 300, T + 305, "BTCUSDT", "PERPETUAL", 13, 14, 12, "[]", JSON.stringify([["101.0", "2.0"], ["101.5", "1.0"]]));
      diff.run(T + 300, T + 306, "ETHUSDT", "PERPETUAL", 13, 14, 12, JSON.stringify([["1.0", "9.0"]]), "[]");
      const trade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
      trade.run(T + 100, "BTCUSDT", "PERPETUAL", "100.0", "0.5", "sell", "t1");
      trade.run(T + 200, "BTCUSDT", "PERPETUAL", "101.0", "0.25", "buy", "t2");
      const seen = [];
      const source = createBinanceIcebergSource({ db, symbol: "BTCUSDT", marketKind: "PERPETUAL", fromTs: T, onDepth: (entries, ts) => seen.push(["depth", ts, entries]), onTrade: (entry) => seen.push(["trade", entry.ts, entry]) });
      source.advanceTo(T + 150);
      expect(seen).toEqual([
        ["depth", T, [["bid", 100, 5], ["ask", 101, 3]]],
        ["trade", T + 100, { price: 100, size: 0.5, aggressor: "sell", ts: T + 100 }],
        ["depth", T + 100, [["bid", 100, 4.5]]],
      ]);
      source.advanceTo(T + 150);
      expect(seen).toHaveLength(3);
      source.advanceTo(T + 1_000);
      expect(seen.slice(3)).toEqual([
        ["trade", T + 200, { price: 101, size: 0.25, aggressor: "buy", ts: T + 200 }],
        ["depth", T + 300, [["ask", 101, 2], ["ask", 101.5, 1]]],
      ]);
      expect(source.stats).toEqual({ diffs: 2, snapshots: 1, trades: 2, lastTs: T + 300 });
      expect(() => createBinanceIcebergSource({ db, symbol: "BTCUSDT", marketKind: "FUTURE", fromTs: T, onDepth: () => {}, onTrade: () => {} })).toThrow(/marketKind/);
      source.close();
    });
  });
});
