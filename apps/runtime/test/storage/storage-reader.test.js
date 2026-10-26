const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader, STORAGE_CANDLE_INTERVAL_MS, mergeLargeTradeRows } = require("../../src/storage/storage-reader");
const { safeRm } = require("../helpers/temp-files");

const ONE_MINUTE_MS = 60_000;

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedCandle(storageDb, tsOpen, overrides = {}) {
  storageDb.insert("candles", {
    tsOpen,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    tradeCount: 5,
    takerBuyBaseVolume: 6,
    ...overrides,
  });
}

function seedCandleRange(storageDb, startTs, count) {
  for (let i = 0; i < count; i += 1) {
    seedCandle(storageDb, startTs + i * ONE_MINUTE_MS);
  }
}

function seedTrade(storageDb, ts, overrides = {}) {
  storageDb.insert("trades", {
    ts,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    price: 100,
    size: 1,
    side: "buy",
    tradeId: `t-${ts}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

describe("createStorageReader", () => {
  let dbPath;

  afterEach(() => {
    // A failed-open attempt on a corrupted file can leave the native
    // module's OS-level handle released only asynchronously on Windows,
    // even though the reader itself never keeps a reference to it (the
    // throwing `new Database(...)` call never completes its assignment).
    // Best-effort cleanup here; a stray temp file isn't a real problem.
    try {
      if (dbPath && fs.existsSync(dbPath)) {
        safeRm(dbPath, { force: true });
      }
    } catch {
      // Ignore -- OS will reclaim temp files regardless.
    }
  });

  test("readRecordingAge says when the collector last wrote a trade for the pair, so a dead collector shows within a poll instead of the next day", () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000);
    seedTrade(writer, 5_000);
    seedTrade(writer, 9_000, { marketKind: "PERPETUAL" });
    writer.close();
    const reader = createStorageReader({ dbPath });
    expect(reader.readRecordingAge("BTCUSDT", "SPOT", { nowMs: 65_000 })).toEqual({ latestTs: 5_000, ageMs: 60_000, available: true });
    expect(reader.readRecordingAge("BTCUSDT", "PERPETUAL", { nowMs: 9_000 })).toEqual({ latestTs: 9_000, ageMs: 0, available: true });
    // A pair never recorded is known to be empty; that is an answer, not an outage.
    expect(reader.readRecordingAge("ETHUSDT", "SPOT", { nowMs: 65_000 })).toEqual({ latestTs: null, ageMs: null, available: true });
    expect(() => reader.readRecordingAge("BTCUSDT", "SPOT", { nowMs: -1 })).toThrow(/nowMs/);
    reader.close();
    // No recording at all: unavailable, never a guess.
    const none = createStorageReader({ dbPath: path.join(path.dirname(dbPath), "missing.sqlite") });
    expect(none.readRecordingAge("BTCUSDT", "SPOT", { nowMs: 65_000 })).toEqual({ latestTs: null, ageMs: null, available: false });
    none.close();
  });

  test("full, gapless coverage across the requested window reports coversFullWindow: true", () => {
    dbPath = tempDbPath();
    const nowMs = 10 * ONE_MINUTE_MS;
    const windowMs = 5 * ONE_MINUTE_MS;
    const writer = createStorageDb({ dbPath });
    for (let tsOpen = nowMs - windowMs; tsOpen < nowMs; tsOpen += ONE_MINUTE_MS) {
      seedCandle(writer, tsOpen);
    }
    writer.close();

    const reader = createStorageReader({ dbPath });
    const { rows, coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs });

    expect(coversFullWindow).toBe(true);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.ts_open)).toEqual([
      nowMs - 5 * ONE_MINUTE_MS, nowMs - 4 * ONE_MINUTE_MS, nowMs - 3 * ONE_MINUTE_MS, nowMs - 2 * ONE_MINUTE_MS, nowMs - ONE_MINUTE_MS,
    ]);
    expect(rows[0]).toMatchObject({ type: "bar", symbol: "BTC-USDT", marketKind: "SPOT", closed: true });
    reader.close();
  });

  describe("strict coverage", () => {
    const WINDOW_CANDLES = 140;
    const nowMs = (WINDOW_CANDLES + 100) * ONE_MINUTE_MS;
    const windowMs = WINDOW_CANDLES * ONE_MINUTE_MS;
    const windowStart = nowMs - windowMs;

    test("scattered internal gaps force REST completion instead of being misclassified as covered", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < WINDOW_CANDLES; i += 1) {
        if (i % 37 === 0) continue;
        seedCandle(writer, windowStart + i * ONE_MINUTE_MS);
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs });

      expect(coversFullWindow).toBe(false);
      reader.close();
    });

    test("a fully contiguous window is covered", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedCandleRange(writer, windowStart, WINDOW_CANDLES);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs });

      expect(coversFullWindow).toBe(true);
      reader.close();
    });

    test("pre-migration candles without taker-buy volume force REST completion even when timestamps are gapless", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < WINDOW_CANDLES; i += 1) {
        seedCandle(writer, windowStart + i * ONE_MINUTE_MS, { takerBuyBaseVolume: null });
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows, coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", {
        intervalMs: ONE_MINUTE_MS,
        windowMs,
        nowMs,
      });

      expect(rows).toHaveLength(WINDOW_CANDLES);
      expect(rows.every((row) => row.buy_volume === undefined)).toBe(true);
      expect(coversFullWindow).toBe(false);
      reader.close();
    });

    test("one missing candle forces REST completion", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedCandleRange(writer, windowStart, WINDOW_CANDLES - 1);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs });

      expect(coversFullWindow).toBe(false);
      reader.close();
    });

    test("a fresh collector with only a small fraction of the window covered correctly reports coversFullWindow: false", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedCandleRange(writer, windowStart, 10);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows, coversFullWindow } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs });

      expect(coversFullWindow).toBe(false);
      expect(rows).toHaveLength(10);
      reader.close();
    });
  });

  test("no rows at all for this pair reports coversFullWindow: false with an empty row set, not an error", () => {
    dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();

    const windowMs = 100 * ONE_MINUTE_MS;
    const reader = createStorageReader({ dbPath });
    const { rows, coversFullWindow } = reader.readRecentCandles("ETHUSDT", "PERPETUAL", { intervalMs: ONE_MINUTE_MS, windowMs, nowMs: windowMs + ONE_MINUTE_MS });

    expect(rows).toEqual([]);
    expect(coversFullWindow).toBe(false);
    reader.close();
  });

  test("a missing database file fails soft -- no coverage, never a throw", () => {
    dbPath = tempDbPath(); // deliberately never created
    const reader = createStorageReader({ dbPath });

    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 5 * ONE_MINUTE_MS })).not.toThrow();
    expect(reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 5 * ONE_MINUTE_MS })).toEqual({ rows: [], coversFullWindow: false });
  });

  test("a reader that starts before the collector retries and uses the database once it appears", () => {
    dbPath = tempDbPath();
    const nowMs = 10 * ONE_MINUTE_MS;
    const reader = createStorageReader({ dbPath });

    expect(reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: ONE_MINUTE_MS, nowMs })).toEqual({ rows: [], coversFullWindow: false });

    const writer = createStorageDb({ dbPath });
    seedCandle(writer, nowMs - ONE_MINUTE_MS);
    writer.close();

    expect(reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: ONE_MINUTE_MS, nowMs })).toMatchObject({
      rows: [expect.objectContaining({ ts_open: nowMs - ONE_MINUTE_MS })],
      coversFullWindow: true,
    });
    reader.close();
  });

  test("short windows require exact coverage instead of treating an empty or partial result as complete", () => {
    dbPath = tempDbPath();
    const nowMs = 10 * ONE_MINUTE_MS;
    const writer = createStorageDb({ dbPath });
    seedCandle(writer, nowMs - ONE_MINUTE_MS);
    writer.close();

    const reader = createStorageReader({ dbPath });
    expect(reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 2 * ONE_MINUTE_MS, nowMs })).toMatchObject({
      rows: [expect.objectContaining({ ts_open: nowMs - ONE_MINUTE_MS })],
      coversFullWindow: false,
    });
    reader.close();
  });

  test("a corrupted database file fails soft and is left untouched -- the reader never attempts recovery on a file it doesn't own", () => {
    dbPath = tempDbPath();
    fs.writeFileSync(dbPath, "not a real sqlite file");
    const reader = createStorageReader({ dbPath });

    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 5 * ONE_MINUTE_MS })).not.toThrow();
    expect(fs.readFileSync(dbPath, "utf8")).toBe("not a real sqlite file");
    const siblings = fs.readdirSync(path.dirname(dbPath));
    expect(siblings.some((name) => name.startsWith(`${path.basename(dbPath)}.corrupted-`))).toBe(false);
  });

  test("a row that fails frame conversion is dropped, not thrown -- the rest of the read still succeeds", () => {
    dbPath = tempDbPath();
    const nowMs = 10 * ONE_MINUTE_MS;
    const writer = createStorageDb({ dbPath });
    writer.raw.pragma("ignore_check_constraints = ON");
    seedCandle(writer, nowMs - 2 * ONE_MINUTE_MS, { open: -5 }); // fails decimalToFiniteNumber's positivity check
    writer.raw.pragma("ignore_check_constraints = OFF");
    seedCandle(writer, nowMs - ONE_MINUTE_MS);
    writer.close();

    const reader = createStorageReader({ dbPath });
    const { rows } = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 2 * ONE_MINUTE_MS, nowMs });

    expect(rows).toHaveLength(1);
    reader.close();
  });

  test("close() is safe to call before ever opening, and safe to call twice", () => {
    dbPath = tempDbPath();
    const reader = createStorageReader({ dbPath });
    expect(() => reader.close()).not.toThrow();
    expect(() => reader.close()).not.toThrow();
  });

  test("close() is permanent -- a read afterward fails soft instead of silently reopening a fresh handle", () => {
    dbPath = tempDbPath();
    const nowMs = 10 * ONE_MINUTE_MS;
    const writer = createStorageDb({ dbPath });
    seedCandle(writer, nowMs - ONE_MINUTE_MS);
    writer.close();

    const reader = createStorageReader({ dbPath });
    const beforeClose = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: ONE_MINUTE_MS, nowMs });
    expect(beforeClose.rows).toHaveLength(1);

    reader.close();

    const afterClose = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: ONE_MINUTE_MS, nowMs });
    expect(afterClose).toEqual({ rows: [], coversFullWindow: false });
  });

  test("rejects a missing/empty dbPath before touching the filesystem", () => {
    expect(() => createStorageReader({ dbPath: "" })).toThrow(/dbPath/);
    expect(() => createStorageReader({ dbPath: undefined })).toThrow(/dbPath/);
    expect(() => createStorageReader({ dbPath: "valid.sqlite", timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  test("rejects invalid read-window controls", () => {
    dbPath = tempDbPath();
    const reader = createStorageReader({ dbPath });
    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: 0, windowMs: ONE_MINUTE_MS })).toThrow(/intervalMs/);
    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: 5 * ONE_MINUTE_MS, windowMs: 5 * ONE_MINUTE_MS })).toThrow(/stored one-minute/);
    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: 90_000 })).toThrow(/windowMs/);
    expect(() => reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: ONE_MINUTE_MS, windowMs: ONE_MINUTE_MS, nowMs: -1 })).toThrow(/nowMs/);
  });

  test("exports the physical candle interval used by storage", () => {
    expect(STORAGE_CANDLE_INTERVAL_MS).toBe(ONE_MINUTE_MS);
  });

  describe("readRecentTrades", () => {
    test("returns trades within the window, oldest first, dropped once out of window", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const windowMs = 5 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - windowMs - 1, { size: 999 }); // just outside the window
      seedTrade(writer, nowMs - 4 * ONE_MINUTE_MS, { size: 2 });
      seedTrade(writer, nowMs - 3 * ONE_MINUTE_MS, { size: 3 });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs, nowMs });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.size)).toEqual([2, 3]);
      expect(rows[0]).toMatchObject({ type: "trade", symbol: "BTC-USDT", marketKind: "SPOT", side: "buy" });
      reader.close();
    });

    test("no rows for this pair returns an empty array, not an error", () => {
      dbPath = tempDbPath();
      createStorageDb({ dbPath }).close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readRecentTrades("ETHUSDT", "PERPETUAL", { windowMs: ONE_MINUTE_MS, nowMs: ONE_MINUTE_MS });

      expect(rows).toEqual([]);
      reader.close();
    });

    test("a limit caps the row count to the first N ascending from the window start -- bounds the cost of one call regardless of total window size", () => {
      dbPath = tempDbPath();
      const nowMs = 100 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < 50; i += 1) {
        seedTrade(writer, nowMs - (50 - i) * ONE_MINUTE_MS, { size: i + 1 });
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 60 * ONE_MINUTE_MS, nowMs, limit: 5 });

      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.size)).toEqual([1, 2, 3, 4, 5]);
      reader.close();
    });

    test("sinceTs pages forward: a second call picks up exactly where the first left off, with no gap or overlap", () => {
      dbPath = tempDbPath();
      const nowMs = 100 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < 12; i += 1) {
        seedTrade(writer, nowMs - (50 - i) * ONE_MINUTE_MS, { size: i + 1 });
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const firstPage = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 60 * ONE_MINUTE_MS, nowMs, limit: 5 });
      expect(firstPage.rows.map((r) => r.size)).toEqual([1, 2, 3, 4, 5]);

      const secondPage = reader.readRecentTrades("BTCUSDT", "SPOT", {
        windowMs: 60 * ONE_MINUTE_MS,
        nowMs,
        limit: 5,
        sinceTs: firstPage.rows[firstPage.rows.length - 1].ts_exchange,
      });
      expect(secondPage.rows.map((r) => r.size)).toEqual([6, 7, 8, 9, 10]);

      const thirdPage = reader.readRecentTrades("BTCUSDT", "SPOT", {
        windowMs: 60 * ONE_MINUTE_MS,
        nowMs,
        limit: 5,
        sinceTs: secondPage.rows[secondPage.rows.length - 1].ts_exchange,
      });
      expect(thirdPage.rows.map((r) => r.size)).toEqual([11, 12]);
      reader.close();
    });

    test("cursor pagination preserves every trade when a page boundary falls within one exchange millisecond", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      for (let index = 1; index <= 4; index += 1) {
        seedTrade(writer, nowMs - ONE_MINUTE_MS, { tradeId: `same-ms-${index}`, size: index });
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const first = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 5 * ONE_MINUTE_MS, nowMs, limit: 2 });
      const second = reader.readRecentTrades("BTCUSDT", "SPOT", {
        windowMs: 5 * ONE_MINUTE_MS,
        nowMs,
        limit: 2,
        cursor: first.nextCursor,
      });

      expect(first.rows.map((row) => row.trade_id)).toEqual(["same-ms-1", "same-ms-2"]);
      expect(second.rows.map((row) => row.trade_id)).toEqual(["same-ms-3", "same-ms-4"]);
      expect(second.nextCursor).not.toBeNull();
      reader.close();
    });

    test("rejects an invalid sinceTs", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, sinceTs: -1 })).toThrow(/sinceTs/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, sinceTs: 1.5 })).toThrow(/sinceTs/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, cursor: { ts: 1, id: -1 } })).toThrow(/cursor/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, sinceTs: 1, cursor: { ts: 1, id: 1 } })).toThrow(/cannot be used together/);
    });

    test("without a limit, the full window is returned unbounded (offline/calibration use)", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < 8; i += 1) seedTrade(writer, i * ONE_MINUTE_MS);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 10 * ONE_MINUTE_MS, nowMs });

      expect(rows).toHaveLength(8);
      reader.close();
    });

    test("rejects a non-positive-integer limit", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, limit: 0 })).toThrow(/limit/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, limit: 1.5 })).toThrow(/limit/);
    });

    test("a missing database file fails soft -- no rows, never a throw", () => {
      dbPath = tempDbPath(); // deliberately never created
      const reader = createStorageReader({ dbPath });

      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS })).not.toThrow();
      expect(reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS })).toEqual({ rows: [], available: false });
    });

    test("a row that fails frame conversion is dropped, not thrown -- the rest of the read still succeeds", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      writer.raw.pragma("ignore_check_constraints = ON");
      seedTrade(writer, nowMs - 2 * ONE_MINUTE_MS, { price: -5 }); // fails decimalToFiniteNumber's positivity check
      writer.raw.pragma("ignore_check_constraints = OFF");
      seedTrade(writer, nowMs - ONE_MINUTE_MS);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 2 * ONE_MINUTE_MS, nowMs });

      expect(rows).toHaveLength(1);
      reader.close();
    });

    test("rejects invalid read-window controls", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: -1 })).toThrow(/windowMs/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 1.5 })).toThrow(/windowMs/);
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, nowMs: -1 })).toThrow(/nowMs/);
    });

    // Closure-audit regression, caught live: a volume profile session
    // rolling over immediately polls its own fresh period, which reads
    // windowMs=0 (fromTs === toTs). The adapter layer was already fixed to
    // allow this, but nothing verified the underlying reader honored it --
    // it rejected exactly that call with "windowMs must be a positive safe
    // integer" the first time this ran against a live server.
    test("a zero-width window (windowMs: 0) is a legitimate query, not an error -- it must match nothing before it, everything at it", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs, { tradeId: "at-nowMs" });
      seedTrade(writer, nowMs - 1, { tradeId: "one-ms-before" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      expect(() => reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 0, nowMs })).not.toThrow();
      const { rows } = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 0, nowMs });
      expect(rows.map((r) => r.trade_id)).toEqual(["at-nowMs"]);
      reader.close();
    });

    test("close() is permanent -- a read afterward fails soft instead of silently reopening a fresh handle", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - ONE_MINUTE_MS);
      writer.close();

      const reader = createStorageReader({ dbPath });
      const beforeClose = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, nowMs });
      expect(beforeClose.rows).toHaveLength(1);

      reader.close();

      expect(reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: ONE_MINUTE_MS, nowMs })).toEqual({ rows: [], available: false });
    });
  });

  describe("mergeLargeTradeRows", () => {
    test("breaks a timestamp tie by database row id, ascending -- causal order, not arrival order from whichever branch found it first", () => {
      const rowA = { id: 5, ts: 1000, trade_id: "a" };
      const rowB = { id: 2, ts: 1000, trade_id: "b" };
      const rowC = { id: 8, ts: 1000, trade_id: "c" };
      const merged = mergeLargeTradeRows([[rowA], [rowC, rowB]]);
      expect(merged.map((row) => row.trade_id)).toEqual(["b", "a", "c"]);
    });
  });

  describe("readLargeTrades", () => {
    test("selects purely by magnitude -- no baseline, no threshold, nothing that can go degenerate", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, ONE_MINUTE_MS, { price: 1000, size: 1, tradeId: "large" });
      seedTrade(writer, ONE_MINUTE_MS, { price: 1, size: 1, tradeId: "ordinary" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 10 * ONE_MINUTE_MS, limit: 100,
      });

      expect(rows.map((row) => row.trade.trade_id)).toEqual(["large", "ordinary"]);
      expect(rows[0].trade).toMatchObject({ type: "trade", trade_id: "large", price: 1000, size: 1 });
      expect(rows[0].baselineSnapshot).toBeUndefined();
      reader.close();
    });

    test("has no time window -- a trade far in the past still qualifies purely on its own z-score", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 0, { price: 1000, size: 1, tradeId: "ancient-whale" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 365 * 24 * 60 * ONE_MINUTE_MS, limit: 100,
      });

      expect(rows.map((row) => row.trade.trade_id)).toEqual(["ancient-whale"]);
      reader.close();
    });

    test("a stale persisted baseline on a row changes nothing -- those columns are no longer read", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, ONE_MINUTE_MS, { price: 50_000, size: 1, tradeId: "no-baseline" });
      seedTrade(writer, ONE_MINUTE_MS, { price: 100, size: 1, tradeId: "small-no-baseline" });
      seedTrade(writer, ONE_MINUTE_MS, { price: 10, size: 1, tradeId: "tiny-with-baseline", baselineLogMedian: 0, baselineLogMad: 1, baselineSampleCount: 20 });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 10 * ONE_MINUTE_MS, limit: 2,
      });

      // Under the old z-score ranking "tiny-with-baseline" outranked both larger trades.
      expect(rows.map((row) => row.trade.trade_id)).toEqual(["no-baseline", "small-no-baseline"]);
      reader.close();
    });

    test("limit keeps the largest trades, then presents them chronologically", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      for (let i = 0; i < 5; i += 1) {
        seedTrade(writer, ONE_MINUTE_MS + i, { price: 1000 + i, size: 1, tradeId: `t-${i}` });
      }
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 10 * ONE_MINUTE_MS, limit: 2,
      });

      expect(rows.map((row) => row.trade.trade_id)).toEqual(["t-3", "t-4"]);
      reader.close();
    });

    test("an empty table returns an empty array, not an error", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 10 * ONE_MINUTE_MS, limit: 100,
      });

      expect(rows).toEqual([]);
      reader.close();
    });

    test("time-covered mode keeps the strongest qualifying trade per minute and side across the whole requested window", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 1_000, { price: 100, size: 1, side: "buy", tradeId: "minute-0-weak" });
      seedTrade(writer, 2_000, { price: 1_000, size: 1, side: "buy", tradeId: "minute-0-strong" });
      seedTrade(writer, 3_000, { price: 500, size: 1, side: "sell", tradeId: "minute-0-sell" });
      seedTrade(writer, ONE_MINUTE_MS + 1_000, { price: 200, size: 1, side: "buy", tradeId: "minute-1" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows, available } = reader.readLargeTrades("BTCUSDT", "SPOT", {
        nowMs: 2 * ONE_MINUTE_MS,
        fromMs: 0,
        bucketMs: ONE_MINUTE_MS,
        perBucketSideLimit: 1,
        limit: 100,
      });
      expect(available).toBe(true);
      expect(rows.map((row) => row.trade.trade_id)).toEqual([
        "minute-0-strong", "minute-0-sell", "minute-1",
      ]);
      reader.close();
    });

    test("the asynchronous path performs the same time-covered read off the caller's event loop", async () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 1_000, { price: 1_000, size: 1, tradeId: "async-large" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const result = await reader.readLargeTradesAsync("BTCUSDT", "SPOT", {
        nowMs: ONE_MINUTE_MS,
        fromMs: 0,
        bucketMs: ONE_MINUTE_MS,
        perBucketSideLimit: 1,
        limit: 100,
      });
      expect(result.available).toBe(true);
      expect(result.rows.map((row) => row.trade.trade_id)).toEqual(["async-large"]);
      reader.close();
    });

    test("a missing database file fails soft -- no rows, never a throw", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });

      const args = { nowMs: ONE_MINUTE_MS, limit: 100 };
      expect(() => reader.readLargeTrades("BTCUSDT", "SPOT", args)).not.toThrow();
      expect(reader.readLargeTrades("BTCUSDT", "SPOT", args)).toEqual({ rows: [], available: false });
    });

    test("rejects invalid arguments", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      const base = { nowMs: ONE_MINUTE_MS, limit: 100 };
      expect(() => reader.readLargeTrades("BTCUSDT", "SPOT", { ...base, nowMs: -1 })).toThrow(/nowMs/);
      expect(() => reader.readLargeTrades("BTCUSDT", "SPOT", { ...base, limit: 0 })).toThrow(/limit/);
      expect(() => reader.readLargeTrades("BTCUSDT", "SPOT", { ...base, limit: 1.5 })).toThrow(/limit/);
      expect(() => reader.readLargeTrades("BTCUSDT", "SPOT", { ...base, fromMs: 0 })).toThrow(/bucketMs/);
    });
  });

  test("readPriceRange reads [fromTs, toTs): a trade at toTs belongs to the next range", () => {
    dbPath = tempDbPath();
    const storageDb = createStorageDb({ dbPath });
    seedTrade(storageDb, 1_000, { price: 100 });
    seedTrade(storageDb, 1_999, { price: 110 });
    seedTrade(storageDb, 2_000, { price: 500 });
    storageDb.close();

    const reader = createStorageReader({ dbPath });
    expect(reader.readPriceRange("BTCUSDT", "SPOT", { fromTs: 1_000, toTs: 2_000 })).toEqual({ minPrice: 100, maxPrice: 110, tradeCount: 2, available: true });
    reader.close();
  });

  describe("readVolumeProfile", () => {
    test("buckets by price, splitting volume into buy/sell", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - 5 * ONE_MINUTE_MS, { price: 100, size: 2, side: "buy" });
      seedTrade(writer, nowMs - 4 * ONE_MINUTE_MS, { price: 100.5, size: 3, side: "sell" });
      seedTrade(writer, nowMs - 3 * ONE_MINUTE_MS, { price: 101, size: 4, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([
        { bucket: 0, volume: 5, buyVolume: 2, sellVolume: 3, tradeCount: 2 },
        { bucket: 1, volume: 4, buyVolume: 4, sellVolume: 0, tradeCount: 1 },
      ]);
      reader.close();
    });

    test("a trade exactly on a bucket boundary lands in the upper bucket, not the lower one", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - 5 * ONE_MINUTE_MS, { price: 100, size: 1, side: "buy" });
      seedTrade(writer, nowMs - 4 * ONE_MINUTE_MS, { price: 101, size: 1, side: "buy" });
      seedTrade(writer, nowMs - 3 * ONE_MINUTE_MS, { price: 100.9999, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([
        { bucket: 0, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 2 },
        { bucket: 1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
      ]);
      reader.close();
    });

    test("a bucket whose aggregate is defensively invalid is dropped, not thrown -- other buckets still come through", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      writer.raw.pragma("ignore_check_constraints = ON");
      seedTrade(writer, nowMs - 2 * ONE_MINUTE_MS, { price: 200, size: -3, side: "buy" });
      writer.raw.pragma("ignore_check_constraints = OFF");
      seedTrade(writer, nowMs - ONE_MINUTE_MS, { price: 100, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([{ bucket: 0, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
    });

    test("a bucket where buy+sell under-counts volume (a corrupted side value) is dropped, not silently under-reported", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      writer.raw.pragma("ignore_check_constraints = ON");
      seedTrade(writer, nowMs - 2 * ONE_MINUTE_MS, { price: 200, size: 5, side: "unknown" });
      writer.raw.pragma("ignore_check_constraints = OFF");
      seedTrade(writer, nowMs - ONE_MINUTE_MS, { price: 100, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([{ bucket: 0, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
    });

    test("buckets below originPrice are the same width as buckets above it", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - 6 * ONE_MINUTE_MS, { price: 98.5, size: 1, side: "buy" });
      seedTrade(writer, nowMs - 5 * ONE_MINUTE_MS, { price: 99.5, size: 1, side: "buy" });
      seedTrade(writer, nowMs - 4 * ONE_MINUTE_MS, { price: 100, size: 1, side: "buy" });
      seedTrade(writer, nowMs - 3 * ONE_MINUTE_MS, { price: 100.5, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([
        { bucket: -2, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
        { bucket: -1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 },
        { bucket: 0, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 2 },
      ]);
      reader.close();
    });

    test("a trade outside the [fromTs, toTs) range is excluded", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 5 * ONE_MINUTE_MS, { price: 100, size: 1 });
      seedTrade(writer, 10 * ONE_MINUTE_MS, { price: 100, size: 1 });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { buckets } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 5 * ONE_MINUTE_MS, toTs: 10 * ONE_MINUTE_MS, originPrice: 100, rowWidth: 1,
      });

      expect(buckets).toEqual([{ bucket: 0, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }]);
      reader.close();
    });

    test("an empty range returns an empty, available result rather than an error", () => {
      dbPath = tempDbPath();
      createStorageDb({ dbPath }).close();

      const reader = createStorageReader({ dbPath });
      const { buckets, available } = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: ONE_MINUTE_MS, originPrice: 100, rowWidth: 1,
      });

      expect(available).toBe(true);
      expect(buckets).toEqual([]);
      reader.close();
    });

    test("a missing database file fails soft -- no buckets, never a throw", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      const args = { fromTs: 0, toTs: ONE_MINUTE_MS, originPrice: 100, rowWidth: 1 };

      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", args)).not.toThrow();
      expect(reader.readVolumeProfile("BTCUSDT", "SPOT", args)).toEqual({ buckets: [], available: false });
    });

    test("rejects invalid arguments", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      const base = { fromTs: 0, toTs: ONE_MINUTE_MS, originPrice: 100, rowWidth: 1 };
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, fromTs: -1 })).toThrow(/fromTs/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, fromTs: 1.5 })).toThrow(/fromTs/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, toTs: 0 })).toThrow(/toTs/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, toTs: -1 })).toThrow(/toTs/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, originPrice: NaN })).toThrow(/originPrice/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, rowWidth: 0 })).toThrow(/rowWidth/);
      expect(() => reader.readVolumeProfile("BTCUSDT", "SPOT", { ...base, rowWidth: -1 })).toThrow(/rowWidth/);
    });
  });

  describe("readSlicedNotional", () => {
    test("aggregates buy/sell notional per time slice, with sliceTs as the slice's last trade timestamp", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, nowMs - 5 * ONE_MINUTE_MS, { price: 100, size: 2, side: "buy" });
      seedTrade(writer, nowMs - 5 * ONE_MINUTE_MS + 10, { price: 100, size: 3, side: "sell" });
      seedTrade(writer, nowMs - 4 * ONE_MINUTE_MS, { price: 50, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows, available } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, sliceMs: ONE_MINUTE_MS,
      });

      expect(available).toBe(true);
      expect(rows).toEqual([
        { sliceTs: nowMs - 5 * ONE_MINUTE_MS + 10, buyNotional: 200, sellNotional: 300 },
        { sliceTs: nowMs - 4 * ONE_MINUTE_MS, buyNotional: 50, sellNotional: 0 },
      ]);
      reader.close();
    });

    test("a trade exactly on a slice boundary lands in the upper slice, not the lower one", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 1_000, { price: 10, size: 1, side: "buy" });
      seedTrade(writer, 1_250, { price: 10, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, sliceMs: 250,
      });

      expect(rows).toEqual([
        { sliceTs: 1_000, buyNotional: 10, sellNotional: 0 },
        { sliceTs: 1_250, buyNotional: 10, sellNotional: 0 },
      ]);
      reader.close();
    });

    test("the upper bound is exclusive -- a trade exactly at toTs is not included", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 1_000, { price: 10, size: 1, side: "buy" });
      seedTrade(writer, 2_000, { price: 10, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: 2_000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: 1_000, buyNotional: 10, sellNotional: 0 }]);
      reader.close();
    });

    test("the lower bound is inclusive -- a trade exactly at fromTs is included", () => {
      dbPath = tempDbPath();
      const writer = createStorageDb({ dbPath });
      seedTrade(writer, 1_000, { price: 10, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 1_000, toTs: 2_000, sliceMs: 250,
      });

      expect(rows).toEqual([{ sliceTs: 1_000, buyNotional: 10, sellNotional: 0 }]);
      reader.close();
    });

    test("a slice whose aggregate is defensively invalid is dropped, not thrown -- other slices still come through", () => {
      dbPath = tempDbPath();
      const nowMs = 10 * ONE_MINUTE_MS;
      const writer = createStorageDb({ dbPath });
      writer.raw.pragma("ignore_check_constraints = ON");
      seedTrade(writer, nowMs - 2 * ONE_MINUTE_MS, { price: 200, size: -3, side: "buy" });
      writer.raw.pragma("ignore_check_constraints = OFF");
      seedTrade(writer, nowMs - ONE_MINUTE_MS, { price: 100, size: 1, side: "buy" });
      writer.close();

      const reader = createStorageReader({ dbPath });
      const { rows, available } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: nowMs, sliceMs: ONE_MINUTE_MS,
      });

      expect(available).toBe(true);
      expect(rows).toEqual([{ sliceTs: nowMs - ONE_MINUTE_MS, buyNotional: 100, sellNotional: 0 }]);
      reader.close();
    });

    test("reports unavailable, not a throw, when the database cannot be opened", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      const { rows, available } = reader.readSlicedNotional("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: ONE_MINUTE_MS, sliceMs: 250,
      });
      expect(available).toBe(false);
      expect(rows).toEqual([]);
      reader.close();
    });

    test("rejects invalid arguments", () => {
      dbPath = tempDbPath();
      const reader = createStorageReader({ dbPath });
      const base = { fromTs: 0, toTs: ONE_MINUTE_MS, sliceMs: 250 };
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, fromTs: -1 })).toThrow(/fromTs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, fromTs: 1.5 })).toThrow(/fromTs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, toTs: -1 })).toThrow(/toTs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, toTs: 1.5 })).toThrow(/toTs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, toTs: -5, fromTs: 0 })).toThrow(/toTs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, sliceMs: 0 })).toThrow(/sliceMs/);
      expect(() => reader.readSlicedNotional("BTCUSDT", "SPOT", { ...base, sliceMs: -1 })).toThrow(/sliceMs/);
    });
  });
});

// A2.21 / L1L2-V2-056. Volume Profile warm-up seeding ran readVolumeProfile as
// synchronous SQLite on the relay's event loop, blocking frame delivery to
// every connected client for its duration -- while VPIN's warm-up already ran
// in a worker. The shared reader worker is now generic, so the seed read can
// take the same off-thread path. Rollover and profile_config rebuilds stay
// synchronous on purpose (L1L2-V2-044).
describe("readVolumeProfileAsync", () => {
  test("returns the same result as the synchronous read, off the calling thread", async () => {
    const dbPath = tempDbPath();
    const db = createStorageDb({ dbPath });
    for (let i = 0; i < 40; i += 1) {
      db.insert("trades", {
        ts: 1_700_000_000_000 + i * 1000, symbol: "BTCUSDT", marketKind: "SPOT",
        price: String(60000 + (i % 5)), size: "1", side: i % 2 ? "buy" : "sell", tradeId: `t${i}`,
      });
    }
    db.close();

    const reader = createStorageReader({ dbPath, timeoutMs: 2_000 });
    const window = { fromTs: 1_700_000_000_000, toTs: 1_700_000_100_000, originPrice: 60000, rowWidth: 1 };
    try {
      const sync = reader.readVolumeProfile("BTCUSDT", "SPOT", window);
      const async = await reader.readVolumeProfileAsync("BTCUSDT", "SPOT", window);

      expect(async.available).toBe(true);
      expect(async.buckets).toEqual(sync.buckets);
      expect(async.buckets.length).toBeGreaterThan(0);
    } finally {
      reader.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("degrades to unavailable rather than throwing when the database cannot be opened", async () => {
    const reader = createStorageReader({ dbPath: `${tempDbPath()}-absent`, timeoutMs: 500 });
    try {
      await expect(reader.readVolumeProfileAsync("BTCUSDT", "SPOT", {
        fromTs: 0, toTs: 1, originPrice: 1, rowWidth: 1,
      })).resolves.toEqual({ buckets: [], available: false });
    } finally {
      reader.close();
    }
  });
});
