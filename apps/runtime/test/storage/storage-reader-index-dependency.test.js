const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { safeRm } = require("../helpers/temp-files");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");

// A2.19 / L1L2-V2-027. storage-reader opens with a bare `new Database(...)`
// rather than createStorageDb, so nothing checks the schema version or that
// the indexes its `INDEXED BY` clauses name are present. The recorded worry
// was that a read against a missing index would silently return no rows and
// report success.
//
// Measured, that does not happen: the one index this path actually pins is
// idx_trades_symbol_market_ts, and losing it fails closed -- available:false
// plus a logged error -- while the others do not change the result at all.
// The bare open therefore stays, and this file pins the behaviour so the
// convention cannot erode quietly into the silent-empty case it warned about.

const TRADE_INDEXES = [
  "idx_trades_symbol_market_ts",
  "idx_trades_symbol_market_id",
  "idx_trades_notional",
  "idx_trades_ts",
  "idx_trades_large_trade_z_score",
  "idx_trades_vpin_covering",
];

const NOW_MS = 1_700_000_000_000;
const TRADE_COUNT = 200;

function buildDb(droppedIndex) {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "reader-index-")),
    "binance.sqlite",
  );
  createStorageDb({ dbPath }).close();
  const db = new Database(dbPath);
  const insert = db.prepare(
    "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < TRADE_COUNT; i += 1) {
      insert.run(NOW_MS - 30_000 + i * 100, "BTCUSDT", "SPOT", "60000", String(i + 1), i % 2 ? "buy" : "sell", `t${i}`);
    }
  })();
  if (droppedIndex) db.exec(`DROP INDEX IF EXISTS ${droppedIndex}`);
  db.close();
  return dbPath;
}

function readLargeTrades(dbPath) {
  const reader = createStorageReader({ dbPath, timeoutMs: 1_000 });
  try {
    return reader.readLargeTrades("BTCUSDT", "SPOT", {
      limit: 50,
      nowMs: NOW_MS,
      fromMs: NOW_MS - 60_000,
      bucketMs: 60_000,
      perBucketSideLimit: 4,
    });
  } finally {
    reader.close();
  }
}

function withDb(droppedIndex, run) {
  const dbPath = buildDb(droppedIndex);
  try {
    return run(dbPath);
  } finally {
    safeRm(path.dirname(dbPath), { recursive: true, force: true });
  }
}

describe("storage-reader index dependency", () => {
  let healthyRowCount;

  beforeAll(() => {
    healthyRowCount = withDb(null, (dbPath) => {
      const result = readLargeTrades(dbPath);
      expect(result.available).toBe(true);
      expect(result.rows.length).toBeGreaterThan(0);
      return result.rows.length;
    });
  });

  // The failure this pins is not "an index went missing" -- it is a read that
  // reports available:true while quietly serving fewer rows than the data
  // holds. That is the shape an operator cannot detect, so no index may
  // produce it.
  test.each(TRADE_INDEXES)("dropping %s never yields a silently short success", (indexName) => {
    withDb(indexName, (dbPath) => {
      const result = readLargeTrades(dbPath);

      if (result.available) {
        expect(result.rows.length).toBe(healthyRowCount);
      } else {
        expect(result.rows).toEqual([]);
      }
    });
  });

  test("the large-trade read pins idx_trades_symbol_market_ts and fails closed without it", () => {
    withDb("idx_trades_symbol_market_ts", (dbPath) => {
      const result = readLargeTrades(dbPath);

      expect(result.available).toBe(false);
      expect(result.rows).toEqual([]);
    });
  });

  test("a reader pointed at a database that does not exist falls back rather than throwing", () => {
    const missing = path.join(os.tmpdir(), `reader-missing-${Date.now()}.sqlite`);
    const reader = createStorageReader({ dbPath: missing, timeoutMs: 1_000 });
    try {
      expect(readLargeTrades(missing)).toMatchObject({ rows: [], available: false });
    } finally {
      reader.close();
    }
  });
});
