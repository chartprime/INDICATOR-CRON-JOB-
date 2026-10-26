const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const {
  createDxFeedStorageReader,
  MAX_READ_LIMIT,
  MAX_CANDLE_WINDOW_MS,
} = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { safeRm } = require("../../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-dxfeed-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

// Equity study reads are regular-session only (report 57 W1, GE-14), so the
// aggregation tests below place their synthetic prints inside a real RTH
// minute: 2026-09-23 10:00 EDT. Futures are unaffected by the shift.
const RTH = Date.parse("2026-09-23T14:00:00Z");

const VALID_TRADE = {
  eventTime: 1000, receivedAt: 1000, provider: "DXFEED", venue: null, assetClass: "EQUITY",
  symbol: "TSLA", stale: 0, recoveryState: "READY",
  price: 349.03, size: 120, time: 1000, exchangeCode: "L", change: -13.83,
  dayVolume: 34651826.7, dayTurnover: 12302399792.64278, tickDirection: "ZERO_UP", extendedTradingHours: 1,
};

const VALID_TIME_AND_SALE = {
  eventTime: 1000, receivedAt: 1001, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY", price: 29111.25, size: 2,
  time: 1000, timeNanoPart: 0, sequence: 42, exchangeCode: "G", extendedTradingHours: 0,
  aggressorSide: "SELL", spreadLeg: 0, validTick: 1, eventKind: "NEW", providerIndex: null,
  providerTradeId: null, bidPrice: null, askPrice: null,
};

// Real captured shape: fractional size, validTick:false by default -- equities
// don't require validTick, unlike VALID_TIME_AND_SALE's futures default of 1.
const VALID_EQUITY_TIME_AND_SALE = {
  eventTime: 1000, receivedAt: 1001, provider: "DXFEED", venue: "NTV", assetClass: "EQUITY",
  symbol: "TSLA", stale: 0, recoveryState: "READY", price: 349.03, size: 120,
  time: 1000, timeNanoPart: 0, sequence: 601002, exchangeCode: "L", extendedTradingHours: 1,
  aggressorSide: "BUY", spreadLeg: 0, validTick: 0, eventKind: "NEW", providerIndex: null,
  providerTradeId: null, bidPrice: null, askPrice: null,
};

describe("createDxFeedStorageReader", () => {
  // L1L2-V2-083. The reader is only usable through this surface, and a
  // property the servers read but the reader never exposes fails silently:
  // `undefined` is not an error, it is just a disabled feature. VPIN warm-up
  // was dead on all four dxFeed instruments for exactly this reason.
  describe("exported surface", () => {
    const REQUIRED_BY_BOTH_DXFEED_SERVERS = [
      "dbPath",
      "readLargeTrades",
      "readLargeTradesAsync",
      "readMinuteRollup",
      "readRecent",
      "readRecentCandles",
      "readTradesSince",
      "readVolumeProfile",
    ];

    test("exposes every property the dxFeed servers read off it", () => {
      const dbPath = tempDbPath();
      const reader = createDxFeedStorageReader({ dbPath });
      for (const property of REQUIRED_BY_BOTH_DXFEED_SERVERS) {
        expect(reader[property]).toBeDefined();
      }
      reader.close();
    });

    test("exposes dbPath as the non-empty string the vpin warm-up guard checks for", () => {
      const dbPath = tempDbPath();
      const reader = createDxFeedStorageReader({ dbPath });
      expect(typeof reader.dbPath).toBe("string");
      expect(reader.dbPath.length).toBeGreaterThan(0);
      expect(reader.dbPath).toBe(dbPath);
      reader.close();
    });
  });

  test("rejects a missing/empty dbPath", () => {
    expect(() => createDxFeedStorageReader({ dbPath: "" })).toThrow(/dbPath/);
    expect(() => createDxFeedStorageReader({ dbPath: "   " })).toThrow(/dbPath/);
  });

  test("fails soft (empty rows, no throw) when the database file doesn't exist yet", () => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    const result = reader.readRecent("TSLA", "EQUITY", "TRADE", {});
    expect(result.rows).toEqual([]);
    expect(result.available).toBe(false);
    expect(reader.countAll()).toBeNull();
    reader.close();
  });

  test("rejects an unrecognized assetClass/eventType before touching the database", () => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    expect(() => reader.readRecent("TSLA", "CRYPTO", "TRADE", {})).toThrow(/assetClass/);
    expect(() => reader.readRecent("TSLA", "EQUITY", "CANDLE", {})).toThrow(/eventType/);
    reader.close();
  });

  // L1L2-V2-102. Every reader that takes a (symbol, assetClass) pair is
  // supposed to reject an unsupported one before it reaches SQL. Only
  // readVolumeProfile was actually pinned to that, and readDailyNotional --
  // added late -- had simply omitted the check. Asserting it across all of
  // them together is what stops the next reader from quietly skipping it.
  test.each([
    ["readRecent", (reader) => reader.readRecent("MSFT", "EQUITY", "TRADE", {})],
    ["readPriceRange", (reader) => reader.readPriceRange("MSFT", "EQUITY", { fromTs: 0, toTs: 1 })],
    ["readMinuteRollup", (reader) => reader.readMinuteRollup("MSFT", "EQUITY", { fromTs: 0, toTs: 1, tickSize: 0.01 })],
    ["readDailyNotional", (reader) => reader.readDailyNotional("MSFT", "EQUITY", { fromTs: 0, toTs: 1 })],
  ])("%s rejects an unsupported symbol/assetClass pair before touching the database", (_label, call) => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    expect(() => call(reader)).toThrow(/unsupported/);
    reader.close();
  });

  // L1L2-V2-101. ORDER is still a real dxFeed event type -- the book assembler
  // consumes it live -- but it has no table here any more, so this reader
  // cannot serve it. Validation used to defer to the provider-wide allow-list,
  // which meant ORDER passed the check and then resolved to no table at all,
  // turning a rejection into "SELECT * FROM undefined" caught as a read
  // failure. The check now derives from the table map itself, so the two
  // cannot drift apart again.
  test("rejects an event type the reader has no table for, even a valid dxFeed one", () => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    expect(() => reader.readRecent("TSLA", "EQUITY", "ORDER", {})).toThrow(/eventType/);
    reader.close();
  });

  test("rejects a blank symbol before touching the database", () => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    expect(() => reader.readRecent("   ", "EQUITY", "TRADE", {})).toThrow(/symbol/);
    expect(() => reader.readRecent(" TSLA", "EQUITY", "TRADE", {})).toThrow(/symbol/);
    reader.close();
  });

  test("bounds read size to prevent an accidental unbounded materialization", () => {
    const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
    expect(() => reader.readRecent("TSLA", "EQUITY", "TRADE", { limit: MAX_READ_LIMIT + 1 })).toThrow(/between/);
    reader.close();
  });

  test("reads back rows written through the writer, most recent first", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 1000 });
    storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 2000 });
    storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 3000, symbol: "AAPL" });
    storageDb.close();

    const reader = createDxFeedStorageReader({ dbPath });
    const result = reader.readRecent("TSLA", "EQUITY", "TRADE", { limit: 10 });
    expect(result.rows).toHaveLength(2);
    expect(result.available).toBe(true);
    expect(result.rows[0].event_time).toBe(2000);
    expect(result.rows[1].event_time).toBe(1000);

    const counts = reader.countAll();
    expect(counts).toEqual({ quotes: 0, trades: 3, orderBookCapture: 0, timeAndSales: 0, candles: 0 });
    reader.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("respects the limit option", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    for (let i = 0; i < 5; i += 1) {
      storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 1000 + i });
    }
    storageDb.close();

    const reader = createDxFeedStorageReader({ dbPath });
    const result = reader.readRecent("TSLA", "EQUITY", "TRADE", { limit: 2 });
    expect(result.rows).toHaveLength(2);
    reader.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("reads stored TimeAndSale rows through the canonical event-type route", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    storageDb.insert("dxfeed_time_and_sales", VALID_TIME_AND_SALE);
    storageDb.close();
    const reader = createDxFeedStorageReader({ dbPath });
    const result = reader.readRecent("/NQZ26:XCME", "FUTURE", "TIMEANDSALE", { limit: 1 });
    expect(result).toMatchObject({ available: true, rows: [expect.objectContaining({ event_kind: "NEW", sequence: 42 })] });
    reader.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("orders rows deterministically by insertion id when event timestamps tie", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 1000, price: 1 });
    storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 1000, price: 2 });
    storageDb.close();

    const reader = createDxFeedStorageReader({ dbPath });
    const result = reader.readRecent("TSLA", "EQUITY", "TRADE", { limit: 2 });
    expect(result.rows.map((row) => row.price)).toEqual([2, 1]);
    reader.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  describe("readRecentCandles", () => {
    const MINUTE_MS = 60_000;
    const BASE = 1_800_000_000_000;
    const NOW_MS = BASE + 90_000;
    const WINDOW_MS = 5 * MINUTE_MS;
    const CLOSED_BOUNDARY = BASE + MINUTE_MS;
    const WINDOW_START = CLOSED_BOUNDARY - WINDOW_MS;

    const CANDLE = {
      tsOpen: BASE, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/NQZ26:XCME",
      open: 100, high: 101, low: 99, close: 100.5, volume: 10, buyVolume: 5, tradeCount: 3,
    };

    test("rejects invalid inputs before touching the database", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      expect(() => reader.readRecentCandles("", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS })).toThrow(/symbol/);
      expect(() => reader.readRecentCandles("/NQZ26:XCME", "CRYPTO", { windowMs: WINDOW_MS, nowMs: NOW_MS })).toThrow(/assetClass/);
      expect(() => reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { intervalMs: 0, windowMs: WINDOW_MS, nowMs: NOW_MS })).toThrow(/intervalMs/);
      expect(() => reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: 0, nowMs: NOW_MS })).toThrow(/windowMs/);
      expect(() => reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: MAX_CANDLE_WINDOW_MS + 1, nowMs: NOW_MS })).toThrow(/windowMs/);
      expect(() => reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: -1 })).toThrow(/nowMs/);
      reader.close();
    });

    test("fails soft when the database file doesn't exist yet", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result).toEqual({ rows: [], available: false, startsAtRequestedWindow: false });
      reader.close();
    });

    test("returns only rows inside [windowStart, closedBoundary), a quiet minute in between is absent (not an error)", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: WINDOW_START - MINUTE_MS }); // before window: excluded
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: WINDOW_START }); // earliest in-window
      // WINDOW_START + 2*MINUTE_MS deliberately quiet -- no row
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE }); // latest fully-closed bar
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: CLOSED_BOUNDARY }); // still forming: excluded
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result.available).toBe(true);
      expect(result.rows.map((r) => r.ts_open)).toEqual([WINDOW_START, BASE]);
      expect(result.startsAtRequestedWindow).toBe(true);
      reader.close();
      safeRm(dbPath, { force: true });
      safeRm(`${dbPath}-wal`, { force: true });
      safeRm(`${dbPath}-shm`, { force: true });
    });

    test("upserts a repeated reconstructed minute deterministically", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE, tradeCount: 9, close: 999 });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE, tradeCount: 2, close: 1 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].trade_count).toBe(2);
      expect(result.rows[0].close).toBe(1);
      reader.close();
      safeRm(dbPath, { force: true });
      safeRm(`${dbPath}-wal`, { force: true });
      safeRm(`${dbPath}-shm`, { force: true });
    });

    test("startsAtRequestedWindow is false when the first observed row is after the requested start", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE }); // only the latest bar exists
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result.startsAtRequestedWindow).toBe(false);
      reader.close();
      safeRm(dbPath, { force: true });
      safeRm(`${dbPath}-wal`, { force: true });
      safeRm(`${dbPath}-shm`, { force: true });
    });

    test("startsAtRequestedWindow is false when there are no rows at all", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result.startsAtRequestedWindow).toBe(false);
      reader.close();
    });

    test("never leaks a different symbol or assetClass into the read", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE, symbol: "/ESZ26:XCME" });
      storageDb.insert("dxfeed_candles", { ...CANDLE, tsOpen: BASE, symbol: "AAPL", assetClass: "EQUITY", venue: null });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readRecentCandles("/NQZ26:XCME", "FUTURE", { windowMs: WINDOW_MS, nowMs: NOW_MS });
      expect(result.rows).toHaveLength(0);
      reader.close();
      safeRm(dbPath, { force: true });
      safeRm(`${dbPath}-wal`, { force: true });
      safeRm(`${dbPath}-shm`, { force: true });
    });
  });

  describe("readLargeTrades", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const NOW_MS = 2_000_000_000_000;

    test("rejects invalid inputs before touching the database", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const valid = { nowMs: NOW_MS, limit: 10};
      expect(() => reader.readLargeTrades("", "FUTURE", valid)).toThrow(/symbol/);
      expect(() => reader.readLargeTrades("/NQZ26:XCME", "CRYPTO", valid)).toThrow(/assetClass/);
      expect(() => reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { ...valid, nowMs: -1 })).toThrow(/nowMs/);
      expect(() => reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { ...valid, limit: 0 })).toThrow(/limit/);
      expect(() => reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { ...valid, fromMs: NOW_MS - HOUR_MS })).toThrow(/bucketMs/);
      expect(() => reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { ...valid, fromMs: NOW_MS + 1, bucketMs: 60_000, perBucketSideLimit: 1 })).toThrow(/fromMs/);
      reader.close();
    });

    test("fails soft when the database file doesn't exist yet", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 10});
      expect(result).toEqual({ rows: [], available: false });
      reader.close();
    });

    test("the asynchronous history read returns the same persisted marker result without using the relay event loop", async () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1_000, size: 100, baselineLogMedian: 0, baselineLogMad: 1, baselineSampleCount: 200 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      await expect(reader.readLargeTradesAsync("/NQZ26:XCME", "FUTURE", {
        nowMs: NOW_MS, limit: 10,
      })).resolves.toEqual(expect.objectContaining({
        available: true,
        rows: [expect.objectContaining({ row: expect.objectContaining({ size: 100 }) })],
      }));
      // L1L2-V2-015. close() resolves only once every async read worker has
      // actually exited. Receiving a worker's result message is not the same
      // as the worker having released the SQLite file, and on Windows a
      // lingering handle makes this rmSync fail with EPERM.
      await reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("futures: ranks by contract count, largest first", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, size: 1000 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 2000, size: 1 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 1});
      expect(result.available).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row.size).toBe(1000);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("futures: a 1-contract print is a candidate like any other, ranked below larger ones", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      // 1 contract: below the floor
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, size: 1 });
      // 100 contracts: above the floor
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 2000, size: 100 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 10});
      expect(result.rows.map(({ row }) => row.size)).toEqual([100, 1]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("time-covered history keeps the strongest qualifying print for each side in each bucket", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      const bucketMs = 5 * 60 * 1000;
      const firstBucket = NOW_MS - (2 * bucketMs);
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: firstBucket + 1, size: 120, aggressorSide: "BUY" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: firstBucket + 2, size: 60, aggressorSide: "BUY" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: firstBucket + 3, size: 80, aggressorSide: "SELL" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: firstBucket + bucketMs + 1, size: 70, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", {
        nowMs: NOW_MS,
        fromMs: firstBucket,
        bucketMs,
        perBucketSideLimit: 1,
        limit: 10,
      });
      expect(result.available).toBe(true);
      expect(result.rows.map(({ row }) => [row.event_time, row.aggressor_side, row.size])).toEqual([
        [firstBucket + 1, "BUY", 120],
        [firstBucket + 3, "SELL", 80],
        [firstBucket + bucketMs + 1, "BUY", 70],
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("has no time window -- a trade far in the past is still ranked on its own magnitude", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: 1000, size: 1000 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: 365 * DAY_MS, limit: 10});
      expect(result.rows).toHaveLength(1);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("futures: excludes corrections/cancels and invalid ticks even though they're stored", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, size: 100, eventKind: "CORRECTION" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 2000, size: 100, validTick: 0 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 10});
      expect(result.rows).toHaveLength(0);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("futures: excludes invalid ticks before adaptive ranking and LIMIT, so they cannot consume the warm-up budget", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, size: 10_000, validTick: 0,
      });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 900, size: 100, validTick: 1,
      });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 1});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row).toEqual(expect.objectContaining({ size: 100, valid_tick: 1 }));
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("futures: excludes unclassified prints before ranking, so they cannot displace a usable marker", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, size: 1000, aggressorSide: "UNDEFINED",
      });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 900, size: 100, aggressorSide: "BUY",
      });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 10});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row).toEqual(expect.objectContaining({ size: 100, aggressor_side: "BUY" }));
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("equities: ranks by dollar notional, largest first", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 1000, price: 1000, size: 1 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 2000, price: 1, size: 1 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("TSLA", "EQUITY", { nowMs: NOW_MS, limit: 1});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row.price).toBe(1000);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("equities: the largest notional wins the slot, with no floor involved", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      // $10,000: below floor
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 1000, price: 100, size: 100 });
      // $60,000: above floor
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 2000, price: 100, size: 600 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("TSLA", "EQUITY", { nowMs: NOW_MS, limit: 1});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row.size).toBe(600);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("equities: excludes corrections/cancels and non-BUY/SELL aggressor sides, even though validTick isn't required", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 1000, price: 100, size: 1000, eventKind: "CORRECTION",
      });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 2000, price: 100, size: 1000, aggressorSide: "UNDEFINED",
      });
      storageDb.insert("dxfeed_time_and_sales", {
        ...VALID_EQUITY_TIME_AND_SALE, eventTime: NOW_MS - 3000, price: 100, size: 600, validTick: 0,
      });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("TSLA", "EQUITY", { nowMs: NOW_MS, limit: 10});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].row).toEqual(expect.objectContaining({ size: 600, valid_tick: 0 }));
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("never leaks a different symbol or assetClass", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000, symbol: "/ESZ26:XCME", size: 999 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 500, size: 100 }); // the one real match
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 10});
      expect(result.rows.map(({ row }) => row.size)).toEqual([100]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("limit bounds the result set, keeping the most significant rows first", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      for (let i = 0; i < 5; i += 1) {
        storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: NOW_MS - 1000 - i, size: 100 });
      }
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = reader.readLargeTrades("/NQZ26:XCME", "FUTURE", { nowMs: NOW_MS, limit: 2});
      expect(result.rows).toHaveLength(2);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });
  });

  describe("readVolumeProfile", () => {
    function seedEquityTimeAndSale(storageDb, overrides = {}) {
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, ...overrides });
    }

    test("buckets by price, splitting volume into buy/sell", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 2, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100.5, size: 3, aggressorSide: "SELL" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 3000, time: RTH + 3000, price: 101, size: 4, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([
        { bucket: 0, volume: 5, buyVolume: 2, sellVolume: 3, tradeCount: 2 },
        { bucket: 1, volume: 4, buyVolume: 4, sellVolume: 0, tradeCount: 1 },
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("a trade exactly on a bucket boundary lands in the upper bucket, not the lower one", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 101, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 3000, time: RTH + 3000, price: 100.9999, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([
        { bucket: 0, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 2 },
        { bucket: 1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("a bucket whose aggregate is defensively invalid is dropped, not thrown -- other buckets still come through", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.raw.pragma("ignore_check_constraints = ON");
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, eventTime: RTH + 1000, time: RTH + 1000, price: 200, size: -3 });
      storageDb.raw.pragma("ignore_check_constraints = OFF");
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([{ bucket: 0, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("decimal boundary prices use the shared integer grid, never binary floating-point division", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 0.1, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 0.3, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 0.1, rowWidth: 0.1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([
        { bucket: 0, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
        { bucket: 2, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("buckets below originPrice are the same width as buckets above it", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 98.5, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 99.5, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 3000, time: RTH + 3000, price: 100, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 4000, time: RTH + 4000, price: 100.5, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([
        { bucket: -2, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
        { bucket: -1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
        { bucket: 0, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 2 },
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("an UNDEFINED-aggressor trade counts toward volume but not the buy/sell split", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 5, aggressorSide: "UNDEFINED" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([{ bucket: 0, volume: 5, buyVolume: 0, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("a CORRECTION/CANCEL row is excluded", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 5, aggressorSide: "BUY", eventKind: "CORRECTION" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100, size: 3, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([{ bucket: 0, volume: 3, buyVolume: 3, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("for FUTURE symbols, a row with valid_tick = 0 is excluded", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 1000, time: RTH + 1000, price: 29111, size: 5, validTick: 0 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 2000, time: RTH + 2000, price: 29111, size: 3, validTick: 1 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("/NQZ26:XCME", "FUTURE", {
        fromTs: RTH, toTs: RTH + 5000, originPrice: 29111, rowWidth: 1,
      });

      expect(buckets).toEqual([{ bucket: 0, volume: 3, buyVolume: 0, sellVolume: 3, tradeCount: 1 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("an empty range returns an empty, available result rather than an error", () => {
      const dbPath = tempDbPath();
      createDxFeedStorageDb({ dbPath }).close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 1000, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("a missing database file fails soft -- no buckets, never a throw", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const args = { fromTs: RTH, toTs: RTH + 1000, originPrice: 100, rowWidth: 1 };

      expect(() => reader.readVolumeProfile("TSLA", "EQUITY", args)).not.toThrow();
      expect(reader.readVolumeProfile("TSLA", "EQUITY", args)).toEqual({ buckets: [], available: false });
      reader.close();
    });

    test("rejects invalid arguments", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const base = { fromTs: RTH, toTs: RTH + 1000, originPrice: 100, rowWidth: 1 };
      expect(() => reader.readVolumeProfile("TSLA", "EQUITY", { ...base, fromTs: -1 })).toThrow(/fromTs/);
      expect(() => reader.readVolumeProfile("TSLA", "EQUITY", { ...base, toTs: RTH + 0 })).toThrow(/toTs/);
      expect(() => reader.readVolumeProfile("TSLA", "EQUITY", { ...base, originPrice: NaN })).toThrow(/originPrice/);
      expect(() => reader.readVolumeProfile("TSLA", "EQUITY", { ...base, rowWidth: 0 })).toThrow(/rowWidth/);
      expect(() => reader.readVolumeProfile("TSLA", "CRYPTO", base)).toThrow(/assetClass/);
      expect(() => reader.readVolumeProfile("MSFT", "EQUITY", base)).toThrow(/unsupported/);
      reader.close();
    });
  });

  describe("readTradesSince", () => {
    function seedEquityTimeAndSale(storageDb, overrides = {}) {
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, ...overrides });
    }

    test("cursor pagination across repeated calls produces no duplicates and no gaps", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      for (let i = 0; i < 7; i += 1) {
        seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000 + i, time: RTH + 1000 + i, price: 100 + i, size: 1 });
      }
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const range = { fromTs: RTH, toTs: RTH + 2000 };
      const unpaginated = reader.readTradesSince("TSLA", "EQUITY", { ...range, limit: 100 });
      expect(unpaginated.rows).toHaveLength(7);

      const pages = [];
      let cursor = null;
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const page = reader.readTradesSince("TSLA", "EQUITY", { ...range, limit: 3, cursor });
        pages.push(...page.rows);
        if (page.nextCursor === null || page.rows.length === 0) break;
        cursor = page.nextCursor;
      }

      expect(pages.map((row) => row.event_time)).toEqual(unpaginated.rows.map((row) => row.event_time));
      expect(new Set(pages.map((row) => row.id)).size).toBe(pages.length);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    // Closure-audit regression, caught live: a volume profile session rolling
    // over immediately polls its own fresh period, reading fromTs === toTs.
    // The adapter layer passes this straight through with no guard of its
    // own -- it is this reader's own strict "toTs > fromTs" check that threw
    // "toTs must be a safe integer greater than fromTs" the first time this
    // ran against a live server. Unlike Binance's inclusive upper bound, this
    // reader's own bound is exclusive (event_time < toTs), so a zero-width
    // window must return nothing, not error.
    test("a zero-width window (fromTs === toTs) is a legitimate query, not an error -- the exclusive upper bound means it matches nothing", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { fromTs: RTH + 1000, toTs: RTH + 1000, limit: 10 })).not.toThrow();
      const { rows, available } = reader.readTradesSince("TSLA", "EQUITY", { fromTs: RTH + 1000, toTs: RTH + 1000, limit: 10 });
      expect(rows).toEqual([]);
      expect(available).toBe(true);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("rejects toTs strictly before fromTs -- an inverted window is a real caller error, unlike a zero-width one", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { fromTs: RTH + 1000, toTs: RTH + 999, limit: 10 })).toThrow(/toTs/);
      reader.close();
    });

    test("excludes CORRECTION/CANCEL rows and, for FUTURE, invalid-tick rows", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 1000, time: RTH + 1000, validTick: 0 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 2000, time: RTH + 2000, eventKind: "CANCEL" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 3000, time: RTH + 3000 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readTradesSince("/NQZ26:XCME", "FUTURE", { fromTs: RTH, toTs: RTH + 5000, limit: 10 });

      expect(rows).toHaveLength(1);
      expect(rows[0].event_time).toBe(RTH + 3000);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("a missing database file fails soft -- no rows, never a throw", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const args = { fromTs: RTH, toTs: RTH + 1000, limit: 10 };

      expect(() => reader.readTradesSince("TSLA", "EQUITY", args)).not.toThrow();
      expect(reader.readTradesSince("TSLA", "EQUITY", args)).toEqual({ rows: [], nextCursor: null, available: false });
      reader.close();
    });

    test("the cursor-present branch independently excludes CORRECTION/CANCEL and, for FUTURE, invalid-tick rows", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 1000, time: RTH + 1000 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 2000, time: RTH + 2000, validTick: 0 });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 3000, time: RTH + 3000, eventKind: "CANCEL" });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: RTH + 4000, time: RTH + 4000 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readTradesSince("/NQZ26:XCME", "FUTURE", {
        fromTs: RTH, toTs: RTH + 5000, limit: 10, cursor: { ts: RTH + 1000, id: 1 },
      });

      expect(rows.map((row) => row.event_time)).toEqual([RTH + 4000]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("rejects invalid arguments", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const base = { fromTs: RTH, toTs: RTH + 1000, limit: 10 };
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { ...base, fromTs: -1 })).toThrow(/fromTs/);
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { ...base, toTs: -1 })).toThrow(/toTs/);
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { ...base, cursor: { ts: RTH + 1, id: -1 } })).toThrow(/cursor/);
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { ...base, limit: 0 })).toThrow(/limit/);
      expect(() => reader.readTradesSince("TSLA", "EQUITY", { ...base, limit: MAX_READ_LIMIT + 1 })).toThrow(/limit/);
      reader.close();
    });
  });

  describe("readSlicedNotional", () => {
    function seedEquityTimeAndSale(storageDb, overrides = {}) {
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_EQUITY_TIME_AND_SALE, ...overrides });
    }

    function seedFutureTimeAndSale(storageDb, overrides = {}) {
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, ...overrides });
    }

    test("aggregates buy/sell notional per time slice, with sliceTs as the slice's last trade timestamp", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 2, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1010, time: RTH + 1010, price: 100, size: 3, aggressorSide: "SELL" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 61000, time: RTH + 61000, price: 50, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows, available } = reader.readSlicedNotional("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 120_000, sliceMs: 60_000,
      });

      expect(available).toBe(true);
      expect(rows).toEqual([
        { sliceTs: RTH + 1010, buyNotional: 200, sellNotional: 300 },
        { sliceTs: RTH + 61000, buyNotional: 50, sellNotional: 0 },
      ]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("an UNDEFINED-aggressor trade is excluded entirely -- not counted toward volume at all, unlike readVolumeProfile", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 5, aggressorSide: "UNDEFINED" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: RTH + 2000, buyNotional: 100, sellNotional: 0 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("excludes CORRECTION/CANCEL event kinds, keeping only NEW", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 5, aggressorSide: "BUY", eventKind: "CORRECTION" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100, size: 1, aggressorSide: "BUY", eventKind: "NEW" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 5000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: RTH + 2000, buyNotional: 100, sellNotional: 0 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("for FUTURE, excludes trades with valid_tick 0", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedFutureTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, size: 5, aggressorSide: "SELL", validTick: 0 });
      seedFutureTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, size: 2, aggressorSide: "SELL", validTick: 1 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("/NQZ26:XCME", "FUTURE", {
        fromTs: RTH, toTs: RTH + 5000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: RTH + 2000, buyNotional: 0, sellNotional: 2 * 29111.25 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("the upper bound is exclusive -- a trade exactly at toTs is not included", () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 1000, time: RTH + 1000, price: 100, size: 1, aggressorSide: "BUY" });
      seedEquityTimeAndSale(storageDb, { eventTime: RTH + 2000, time: RTH + 2000, price: 100, size: 1, aggressorSide: "BUY" });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 2000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: RTH + 1000, buyNotional: 100, sellNotional: 0 }]);
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("reports unavailable, not a throw, when the database cannot be opened", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const { rows, available } = reader.readSlicedNotional("TSLA", "EQUITY", {
        fromTs: RTH, toTs: RTH + 1000, sliceMs: 250,
      });
      expect(available).toBe(false);
      expect(rows).toEqual([]);
      reader.close();
    });

    test("rejects invalid arguments", () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      const base = { fromTs: RTH, toTs: RTH + 1000, sliceMs: 250 };
      expect(() => reader.readSlicedNotional("", "EQUITY", base)).toThrow(/symbol/);
      expect(() => reader.readSlicedNotional("TSLA", "CRYPTO", base)).toThrow(/assetClass/);
      expect(() => reader.readSlicedNotional("TSLA", "EQUITY", { ...base, fromTs: -1 })).toThrow(/fromTs/);
      expect(() => reader.readSlicedNotional("TSLA", "EQUITY", { ...base, toTs: -1 })).toThrow(/toTs/);
      expect(() => reader.readSlicedNotional("TSLA", "EQUITY", { ...base, sliceMs: 0 })).toThrow(/sliceMs/);
      expect(() => reader.readSlicedNotional("TSLA", "EQUITY", { ...base, sliceMs: -1 })).toThrow(/sliceMs/);
      reader.close();
    });
  });

  describe("readAsync", () => {
    const NOW_MS = 2_000_000_000_000;

    test("dispatches a newly worker-eligible method (readDailyNotional) through the real worker and returns the persisted row", async () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: 1_000, price: 100, size: 5 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      await expect(reader.readAsync("readDailyNotional", "/NQZ26:XCME", "FUTURE", { fromTs: 0, toTs: 2_000 }))
        .resolves.toEqual({ rows: [{ dayTs: 0, notional: 500 }], available: true });
      await reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("dispatches readVolumeProfile through the real worker and returns the persisted bucket", async () => {
      const dbPath = tempDbPath();
      const storageDb = createDxFeedStorageDb({ dbPath });
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: 1_000, price: 100, size: 5 });
      storageDb.close();

      const reader = createDxFeedStorageReader({ dbPath });
      const result = await reader.readAsync("readVolumeProfile", "/NQZ26:XCME", "FUTURE", { fromTs: 0, toTs: 2_000, originPrice: 100, rowWidth: 1 });
      expect(result.available).toBe(true);
      expect(result.buckets).toEqual([expect.objectContaining({ volume: 5, tradeCount: 1 })]);
      await reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    });

    test("an unsupported method is rejected before ever reaching a worker", async () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      await expect(reader.readAsync("notAMethod", "/NQZ26:XCME", "FUTURE", {})).rejects.toThrow(/unsupported async method/);
      reader.close();
    });

    test("a real validation error thrown inside the worker rejects the promise instead of resolving to a fallback shape", async () => {
      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      await expect(reader.readAsync("readDailyNotional", "", "FUTURE", { fromTs: 0, toTs: 1, nowMs: NOW_MS }))
        .rejects.toThrow(/symbol/);
      await reader.close();
    });

    // Only 4 of the 8 methods live-storage-route.js's DXFEED_ROUTES maps to are
    // exercised individually above. A method missing from the worker's
    // SUPPORTED_METHODS/EMPTY_BY_METHOD tables would still leave the full
    // suite green if nothing ever actually dispatched it through readAsync --
    // this drives every one of them, not just the hand-picked few.
    test("every DXFEED_ROUTES-mapped method is reachable through readAsync, not silently missing from SUPPORTED_METHODS", async () => {
      const { ROUTES, DXFEED_ROUTES } = require("../../../src/server/live-storage-route");
      const methods = [...DXFEED_ROUTES].map((routeName) => ROUTES[routeName]);
      expect(methods.sort()).toEqual([
        "readAggressivePrints", "readDailyNotional", "readLargeTrades", "readMinuteRollup",
        "readPriceRange", "readRecent", "readRecentCandles", "readSlicedNotional", "readTradesSince",
        "readVolumeProfile",
      ]);

      const reader = createDxFeedStorageReader({ dbPath: tempDbPath() });
      for (const method of methods) {
        let rejection = null;
        try {
          await reader.readAsync(method, "/NQZ26:XCME", "FUTURE", {});
        } catch (error) {
          rejection = error;
        }
        expect(rejection).not.toBeNull();
        // Two independent tables can each go stale: the reader's own
        // EMPTY_BY_METHOD ("unsupported async method") and the worker's
        // SUPPORTED_METHODS ("unsupported method") -- catch either.
        expect(rejection.message).not.toMatch(/unsupported/);
      }
      await reader.close();
    });
  });
});

// A2.21 / L1L2-V2-036. Four reads hit dxfeed_time_and_sales with the same
// predicate shape; readMinuteRollup and readSlicedNotional pinned the covering
// index, readPriceRange and readVolumeProfile pinned nothing and left the
// planner to choose on a 47 GB table. (The finding said one of three; it was
// two of four.) Every column those queries touch lives in the index, so pinning
// makes them true covering reads -- asserted through the planner rather than by
// reading the SQL, because only the planner can say it actually happened.
describe("aggregation reads are covered by the VPIN index", () => {
  const Database = require("better-sqlite3");

  function planFor(sql) {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((step) => step.detail);
    } finally {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  }

  const PREDICATE =
    "WHERE symbol = '/NQ' AND asset_class = 'FUTURE' AND event_time >= 0 AND event_time < 9 " +
    "AND event_kind = 'NEW' AND valid_tick = 1";

  test.each([
    ["readPriceRange", `SELECT MIN(price) lo, MAX(price) hi, COUNT(*) n FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering ${PREDICATE}`],
    ["readVolumeProfile", `SELECT CAST(price AS INTEGER) bucket, SUM(size) v, COUNT(*) c FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering ${PREDICATE} GROUP BY bucket`],
  ])("%s is a covering-index search, never a table scan", (_name, sql) => {
    const plan = planFor(sql);

    expect(plan.some((d) => d.includes("COVERING INDEX idx_dxfeed_time_and_sales_vpin_covering"))).toBe(true);
    expect(plan.some((d) => /SCAN dxfeed_time_and_sales(?! USING)/.test(d))).toBe(false);
  });

  test("readTradesSince (SELECT *, no hint) still resolves to an index search, not a table scan", () => {
    const sql = "SELECT * FROM dxfeed_time_and_sales WHERE symbol = '/NQ' AND asset_class = 'FUTURE' " +
      "AND event_time >= 0 AND event_time < 9 AND event_kind = 'NEW' AND valid_tick = 1 " +
      "ORDER BY event_time ASC, id ASC LIMIT 100";
    const plan = planFor(sql);

    expect(plan.some((d) => d.includes("SEARCH dxfeed_time_and_sales USING INDEX idx_dxfeed_time_and_sales_symbol_time"))).toBe(true);
    expect(plan.some((d) => /SCAN dxfeed_time_and_sales(?! USING)/.test(d))).toBe(false);
  });
});

// Report 57 W1, GE-14: for US equities everything on the chart is regular
// session only. The reader is the one choke point for server-side studies
// (volume profile, VPIN), so every study read drops pre-market and
// after-hours prints for equities, while the raw tape read keeps them.
describe("equity study reads are regular-session only; the tape is not (GE-14)", () => {
  const PRE = Date.parse("2026-09-23T13:29:00Z"); // 09:29 EDT
  const OPEN = Date.parse("2026-09-23T13:30:00Z"); // 09:30 EDT
  const LAST = Date.parse("2026-09-23T19:59:59Z"); // 15:59:59 EDT
  const POST = Date.parse("2026-09-23T20:00:00Z"); // 16:00 EDT
  let dbPath;
  let reader;

  beforeAll(() => {
    dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    const equity = (eventTime, price, aggressorSide) => storageDb.insert("dxfeed_time_and_sales", {
      ...VALID_EQUITY_TIME_AND_SALE, eventTime, receivedAt: eventTime, time: eventTime, sequence: eventTime % 1_000_000, price, size: 10, aggressorSide,
    });
    for (let i = 0; i < 5; i += 1) equity(PRE + i * 1000, 90, "SELL");
    equity(OPEN, 100, "BUY");
    equity(LAST, 101, "SELL");
    for (let i = 0; i < 5; i += 1) equity(POST + i * 1000, 110, "BUY");
    for (const eventTime of [PRE, OPEN, POST]) {
      storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime, receivedAt: eventTime, time: eventTime });
    }
    storageDb.close();
    reader = createDxFeedStorageReader({ dbPath });
  });

  afterAll(() => {
    reader.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  const window = { fromTs: PRE, toTs: POST + 60_000 };

  test("volume profile, price range, minute rollup and notional reads see only the two regular-session prints", () => {
    expect(reader.readPriceRange("TSLA", "EQUITY", window)).toEqual({ minPrice: 100, maxPrice: 101, tradeCount: 2, available: true });
    const profile = reader.readVolumeProfile("TSLA", "EQUITY", { ...window, originPrice: 90, rowWidth: 1 });
    expect(profile.buckets.map((bucket) => [bucket.bucket, bucket.volume])).toEqual([[10, 10], [11, 10]]);
    const rollup = reader.readMinuteRollup("TSLA", "EQUITY", { ...window, tickSize: 0.01 });
    expect(rollup.rows.map((row) => row.minuteTs)).toEqual([OPEN, LAST - (LAST % 60_000)]);
    const daily = reader.readDailyNotional("TSLA", "EQUITY", window);
    expect(daily.rows.map((row) => row.notional)).toEqual([100 * 10 + 101 * 10]);
    const sliced = reader.readSlicedNotional("TSLA", "EQUITY", { ...window, sliceMs: 60_000 });
    expect(sliced.rows.map((row) => row.sliceTs)).toEqual([OPEN, LAST]);
  });

  test("trade pagination skips extended-hours prints without ending early", () => {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = reader.readTradesSince("TSLA", "EQUITY", { ...window, cursor, limit: 1 });
      seen.push(...result.rows.map((row) => row.event_time));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([OPEN, LAST]);
  });

  test("the raw tape read keeps every equity print, and futures studies keep every hour", () => {
    expect(reader.readRecent("TSLA", "EQUITY", "TIMEANDSALE", { limit: 100 }).rows).toHaveLength(12);
    expect(reader.readPriceRange("/NQZ26:XCME", "FUTURE", window).tradeCount).toBe(3);
  });
});
