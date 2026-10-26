const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-reader-prints-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedTrade(storageDb, ts, overrides = {}) {
  storageDb.insert("trades", {
    ts, symbol: "BTCUSDT", marketKind: "PERPETUAL", price: 78000, size: 1, side: "buy",
    tradeId: `t-${ts}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

describe("createStorageReader.readAggressivePrints", () => {
  let dbPath;

  afterEach(() => {
    try {
      if (dbPath && fs.existsSync(dbPath)) safeRm(dbPath, { force: true });
    } catch {
      void 0;
    }
  });

  test("returns the prints at least minSize big inside [fromMs, toMs), newest first, capped, for the pair only", async () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000, { size: 0.5 }); // too small
    seedTrade(writer, 2_000, { size: 2, side: "sell", tradeId: "big-2000" });
    seedTrade(writer, 3_000, { size: 5, tradeId: "big-3000" });
    seedTrade(writer, 4_000, { size: 9, tradeId: "big-4000" });
    seedTrade(writer, 5_000, { size: 9 }); // at toMs: excluded
    seedTrade(writer, 3_500, { size: 9, marketKind: "SPOT" }); // other pair
    seedTrade(writer, 3_600, { size: 9, symbol: "ETHUSDT" }); // other symbol
    writer.close();

    const reader = createStorageReader({ dbPath });
    try {
      const { rows, available } = reader.readAggressivePrints("BTCUSDT", "PERPETUAL", { fromMs: 2_000, toMs: 5_000, minSize: 2, limit: 10 });
      expect(available).toBe(true);
      expect(rows.map((row) => [row.ts, row.trade_id, row.side])).toEqual([[4_000, "big-4000", "buy"], [3_000, "big-3000", "buy"], [2_000, "big-2000", "sell"]]);
      expect(Object.keys(rows[0]).sort()).toEqual(["id", "price", "side", "size", "trade_id", "ts"]);
      const capped = reader.readAggressivePrints("BTCUSDT", "PERPETUAL", { fromMs: 0, toMs: 5_000, minSize: 0, limit: 2 });
      expect(capped.rows.map((row) => row.ts)).toEqual([4_000, 3_000]); // the newest survive the cap
      const viaWorker = await reader.readAggressivePrintsAsync("BTCUSDT", "PERPETUAL", { fromMs: 2_000, toMs: 5_000, minSize: 5, limit: 10 });
      expect(viaWorker.available).toBe(true);
      expect(viaWorker.rows.map((row) => row.trade_id)).toEqual(["big-4000", "big-3000"]);
    } finally {
      reader.close();
    }
  });

  test("validates its options and answers unavailable when the file is missing", async () => {
    dbPath = tempDbPath();
    const reader = createStorageReader({ dbPath });
    try {
      expect(() => reader.readAggressivePrints("BTCUSDT", "SPOT", { fromMs: -1, toMs: 10, minSize: 0, limit: 1 })).toThrow(/fromMs/);
      expect(() => reader.readAggressivePrints("BTCUSDT", "SPOT", { fromMs: 10, toMs: 10, minSize: 0, limit: 1 })).toThrow(/toMs/);
      expect(() => reader.readAggressivePrints("BTCUSDT", "SPOT", { fromMs: 0, toMs: 10, minSize: -1, limit: 1 })).toThrow(/minSize/);
      expect(() => reader.readAggressivePrints("BTCUSDT", "SPOT", { fromMs: 0, toMs: 10, minSize: 0, limit: 0 })).toThrow(/limit/);
      expect(reader.readAggressivePrints("BTCUSDT", "SPOT", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
      expect(await reader.readAggressivePrintsAsync("BTCUSDT", "SPOT", { fromMs: 0, toMs: 10, minSize: 0, limit: 1 })).toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
    } finally {
      reader.close();
    }
  });

  test("hasMore/nextCursor let a caller page through every qualifying row, including ties, with no duplicate or omission", async () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    // 5 qualifying rows against a limit of 2, so a full page-through needs 3
    // pages. Two rows share the same ts (a tie the cursor must break by id).
    seedTrade(writer, 1_000, { size: 5, tradeId: "r1" });
    seedTrade(writer, 2_000, { size: 5, tradeId: "r2" });
    seedTrade(writer, 2_000, { size: 5, tradeId: "r3" });
    seedTrade(writer, 3_000, { size: 5, tradeId: "r4" });
    seedTrade(writer, 4_000, { size: 5, tradeId: "r5" });
    writer.close();

    const reader = createStorageReader({ dbPath });
    try {
      const seen = [];
      let cursor = null;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 10) throw new Error("pagination did not terminate");
        const page = reader.readAggressivePrints("BTCUSDT", "PERPETUAL", { fromMs: 0, toMs: 5_000, minSize: 0, limit: 2, cursor });
        expect(page.available).toBe(true);
        expect(page.rows.length).toBeLessThanOrEqual(2);
        for (const row of page.rows) seen.push(row.trade_id);
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
      expect(new Set(seen).size).toBe(5); // no row delivered twice
    } finally {
      reader.close();
    }
  });

  test("a slice with exactly limit rows reports no more, so a caller does not fetch an empty extra page", async () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000, { size: 5, tradeId: "a" });
    seedTrade(writer, 2_000, { size: 5, tradeId: "b" });
    writer.close();

    const reader = createStorageReader({ dbPath });
    try {
      const page = reader.readAggressivePrints("BTCUSDT", "PERPETUAL", { fromMs: 0, toMs: 5_000, minSize: 0, limit: 2 });
      expect(page.rows.map((row) => row.trade_id)).toEqual(["b", "a"]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    } finally {
      reader.close();
    }
  });
});
