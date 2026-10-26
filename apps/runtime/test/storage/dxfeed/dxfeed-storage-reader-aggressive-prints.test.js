const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { MAX_AGGRESSIVE_HISTORY_TRADES } = require("../../../src/server/frames");
const { safeRm } = require("../../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-dxfeed-reader-prints-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

const BASE = {
  eventTime: 1000, receivedAt: 1001, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY", price: 29111.25, size: 2,
  time: 1000, timeNanoPart: 0, sequence: 42, exchangeCode: "G", extendedTradingHours: 0,
  aggressorSide: "SELL", spreadLeg: 0, validTick: 1, eventKind: "NEW", providerIndex: null,
  providerTradeId: null, bidPrice: null, askPrice: null,
};

function seed(storageDb, eventTime, overrides = {}) {
  storageDb.insert("dxfeed_time_and_sales", { ...BASE, eventTime, time: eventTime, sequence: eventTime % 100_000, ...overrides });
}

describe("createDxFeedStorageReader.readAggressivePrints", () => {
  let dbPath;

  afterEach(() => {
    try {
      if (dbPath && fs.existsSync(dbPath)) safeRm(dbPath, { force: true });
    } catch {
      void 0;
    }
  });

  test("returns new-tick prints with a known aggressor at least minSize big inside the window, newest first, capped", async () => {
    dbPath = tempDbPath();
    const writer = createDxFeedStorageDb({ dbPath });
    seed(writer, 1_000, { size: 1 }); // too small
    seed(writer, 2_000, { size: 7 });
    seed(writer, 3_000, { size: 7, aggressorSide: "UNDEFINED" }); // no aggressor: not a print for this
    seed(writer, 3_500, { size: 7, eventKind: "CANCEL" }); // not a new tick
    seed(writer, 4_000, { size: 12, aggressorSide: "BUY" });
    seed(writer, 4_250, { size: 12, validTick: 0 }); // futures tape rejects it before the cap
    seed(writer, 2_500, { sequence: 1 });
    seed(writer, 2_500, { sequence: 2 });
    seed(writer, 2_500, { sequence: 3 });
    seed(writer, 5_000, { size: 12 }); // at toMs: excluded
    seed(writer, 4_500, { size: 12, symbol: "/ESZ26:XCME" }); // other instrument
    writer.close();

    const reader = createDxFeedStorageReader({ dbPath });
    try {
      const { rows, available } = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 2_000, toMs: 5_000, minSize: 5, limit: 10 });
      expect(available).toBe(true);
      expect(rows.map((row) => [row.event_time, row.aggressor_side, row.size])).toEqual([[4_000, "BUY", 12], [2_000, "SELL", 7]]);
      expect(rows[0]).toMatchObject({ symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_kind: "NEW", valid_tick: 1, time: 4_000, time_nano_part: 0, sequence: 4_000 });
      const capped = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 0, toMs: 5_000, minSize: 0, limit: 1 });
      expect(capped.rows.map((row) => row.event_time)).toEqual([4_000]);
      const tiedFirst = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 2_001, toMs: 3_000, minSize: 0, limit: 2 });
      const cursor = { ts: tiedFirst.rows.at(-1).event_time, id: tiedFirst.rows.at(-1).id };
      const tiedSecond = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 2_001, toMs: 3_000, minSize: 0, limit: 2, cursor });
      expect(new Set([...tiedFirst.rows, ...tiedSecond.rows].map((row) => row.id)).size).toBe(3);
      const viaWorker = await reader.readAggressivePrintsAsync("/NQZ26:XCME", "FUTURE", { fromMs: 2_000, toMs: 5_000, minSize: 10, limit: 10 });
      expect(viaWorker.available).toBe(true);
      expect(viaWorker.rows.map((row) => row.event_time)).toEqual([4_000]);
    } finally {
      reader.close();
    }
  });

  test("validates the instrument and options, and answers unavailable when the file is missing", async () => {
    dbPath = tempDbPath();
    const reader = createDxFeedStorageReader({ dbPath });
    try {
      expect(() => reader.readAggressivePrints("", "FUTURE", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toThrow(/symbol/);
      expect(() => reader.readAggressivePrints("/NQZ26:XCME", "CRYPTO", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toThrow(/assetClass/);
      expect(() => reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 10, toMs: 10, minSize: 0, limit: 1 })).toThrow(/toMs/);
      expect(() => reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 0, toMs: 10, minSize: Number.NaN, limit: 1 })).toThrow(/minSize/);
      expect(() => reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 0, toMs: 10, minSize: 0, limit: -1 })).toThrow(/limit/);
      expect(reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
      expect(await reader.readAggressivePrintsAsync("/NQZ26:XCME", "FUTURE", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
    } finally {
      reader.close();
    }
  });

  test("filters invalid future ticks before a capped page, so eligible older prints remain reachable", () => {
    dbPath = tempDbPath();
    const writer = createDxFeedStorageDb({ dbPath });
    seed(writer, 1_000, { validTick: 1, sequence: 1 });
    for (let i = 0; i < MAX_AGGRESSIVE_HISTORY_TRADES + 1; i += 1) {
      seed(writer, 2_000 + i, { validTick: 0, sequence: i + 2 });
    }
    writer.close();

    const reader = createDxFeedStorageReader({ dbPath });
    try {
      const result = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", {
        fromMs: 0, toMs: 30_000, minSize: 0, limit: MAX_AGGRESSIVE_HISTORY_TRADES + 1,
      });
      expect(result).toMatchObject({ available: true });
      expect(result.rows.map((row) => [row.event_time, row.valid_tick])).toEqual([[1_000, 1]]);
    } finally {
      reader.close();
    }
  });

  test("walks 20,001 valid futures records tied at one timestamp without omitting or repeating a storage row", () => {
    dbPath = tempDbPath();
    const writer = createDxFeedStorageDb({ dbPath });
    for (let i = 0; i < MAX_AGGRESSIVE_HISTORY_TRADES + 1; i += 1) {
      seed(writer, 2_500, { sequence: i + 1 });
    }
    writer.close();

    const reader = createDxFeedStorageReader({ dbPath });
    try {
      const first = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", {
        fromMs: 2_500, toMs: 2_501, minSize: 0, limit: MAX_AGGRESSIVE_HISTORY_TRADES,
      });
      expect(first.rows).toHaveLength(MAX_AGGRESSIVE_HISTORY_TRADES);
      const cursor = { ts: first.rows.at(-1).event_time, id: first.rows.at(-1).id };
      const second = reader.readAggressivePrints("/NQZ26:XCME", "FUTURE", {
        fromMs: 2_500, toMs: 2_501, minSize: 0, limit: MAX_AGGRESSIVE_HISTORY_TRADES, cursor,
      });
      expect(second.rows).toHaveLength(1);
      const ids = [...first.rows, ...second.rows].map((row) => row.id);
      expect(new Set(ids).size).toBe(MAX_AGGRESSIVE_HISTORY_TRADES + 1);
    } finally {
      reader.close();
    }
  });

  test("retains an equity valid_tick zero print because that provider policy is intentionally different", () => {
    dbPath = tempDbPath();
    const writer = createDxFeedStorageDb({ dbPath });
    seed(writer, 1_000, { assetClass: "EQUITY", symbol: "AAPL", validTick: 0 });
    writer.close();

    const reader = createDxFeedStorageReader({ dbPath });
    try {
      const result = reader.readAggressivePrints("AAPL", "EQUITY", { fromMs: 0, toMs: 2_000, minSize: 0, limit: 1 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ asset_class: "EQUITY", symbol: "AAPL", valid_tick: 0 });
    } finally {
      reader.close();
    }
  });
});
