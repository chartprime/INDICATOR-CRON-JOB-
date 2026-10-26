const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb, SCHEMA_VERSION } = require("../../src/storage/storage-db");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("createStorageDb", () => {
  test("rejects a missing/empty dbPath before touching the filesystem", () => {
    expect(() => createStorageDb({ dbPath: "" })).toThrow(/dbPath/);
    expect(() => createStorageDb({ dbPath: undefined })).toThrow(/dbPath/);
  });

  test("creates all raw-event and replay-baseline tables on a fresh in-memory database", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const tableNames = storageDb.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tableNames).toEqual([
      "candles",
      "capture_incidents",
      "capture_sessions",
      "daily_notional_rollup",
      "daily_notional_rollup_watermark",
      "depth_continuity_audits",
      "l2_depth_events",
      "l2_depth_snapshots",
      "storage_schema",
      "trades",
    ]);
    expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    storageDb.close();
  });

  test("persists capture-session quality and invalidates an abandoned prior session", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    storageDb.beginCaptureSession({ sessionId: "session-a", startedAt: 1000 });
    storageDb.beginCaptureSession({ sessionId: "session-b", startedAt: 2000 });
    storageDb.finishCaptureSession({
      sessionId: "session-b",
      endedAt: 3000,
      quality: "DEGRADED",
      cleanShutdown: true,
      terminationReason: "operator stop",
    });

    expect(storageDb.raw.prepare(
      "SELECT session_id, ended_at, quality, clean_shutdown, termination_reason FROM capture_sessions ORDER BY started_at",
    ).all()).toEqual([
      {
        session_id: "session-a",
        ended_at: 2000,
        quality: "INVALID",
        clean_shutdown: 0,
        termination_reason: "UNCLEAN_PREVIOUS_PROCESS_EXIT",
      },
      {
        session_id: "session-b",
        ended_at: 3000,
        quality: "DEGRADED",
        clean_shutdown: 1,
        termination_reason: "operator stop",
      },
    ]);
    storageDb.close();
  });

  test("migrates schema v11 in place by adding the nullable large-trade baseline columns, preserving existing rows", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "50000.00", size: "0.001", side: "buy", tradeId: "v11-trade",
    });
    initial.close();

    const versionEleven = new Database(dbPath);
    versionEleven.exec(
      "ALTER TABLE trades DROP COLUMN baseline_log_median; ALTER TABLE trades DROP COLUMN baseline_log_mad; UPDATE storage_schema SET version = 11;",
    );
    versionEleven.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT trade_id, baseline_log_median, baseline_log_mad FROM trades").get()).toEqual({
      trade_id: "v11-trade", baseline_log_median: null, baseline_log_mad: null,
    });
    migrated.insert("trades", {
      ts: 2000, symbol: "BTCUSDT", marketKind: "SPOT", price: "51000.00", size: "0.002", side: "sell", tradeId: "v11-trade-2",
    });
    // L1L2-V2-084: the columns survive the migration but are no longer written.
    expect(migrated.raw.prepare("SELECT baseline_log_median, baseline_log_mad FROM trades WHERE trade_id = ?").get("v11-trade-2")).toEqual({
      baseline_log_median: null, baseline_log_mad: null,
    });
    // L1L2-V2-084. The columns stay -- dropping one from a 40GB table costs a
    // full rewrite and buys nothing -- but the z-score index built for the
    // removed detector must be gone after migration, not merely unused.
    expect(
      migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_large_trade_z_score'").get(),
    ).toBeUndefined();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  // L1L2-V2-023. Every migration from legacy v1 through v11 had a test; v12->v13
  // and v13->v14 -- the two newest, added during the VPIN backfill work -- had
  // none. v13 adds baseline_sample_count and rebuilds the z-score index to
  // include it; v14 adds the VPIN covering index.
  test("migrates schema v12 in place by adding baseline_sample_count, and drops the retired z-score index", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "50000.00", size: "0.001", side: "buy", tradeId: "v12-trade",
    });
    initial.close();

    const versionTwelve = new Database(dbPath);
    versionTwelve.exec(
      "DROP INDEX idx_trades_vpin_covering; " +
      "ALTER TABLE trades DROP COLUMN baseline_sample_count; " +
      // A genuine v12 database carries the z-score index; recreate it so that
      // asserting its absence after migration proves the DROP actually ran.
      "CREATE INDEX idx_trades_large_trade_z_score ON trades(symbol, market_kind, baseline_log_median); " +
      "UPDATE storage_schema SET version = 12;",
    );
    versionTwelve.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    // The pre-existing row survives, with the new column null rather than defaulted.
    expect(migrated.raw.prepare("SELECT trade_id, baseline_log_median, baseline_sample_count FROM trades").get()).toEqual({
      trade_id: "v12-trade", baseline_log_median: null, baseline_sample_count: null,
    });
    migrated.insert("trades", {
      ts: 2000, symbol: "BTCUSDT", marketKind: "SPOT", price: "51000.00", size: "0.002", side: "sell", tradeId: "v12-trade-2",
    });
    expect(migrated.raw.prepare("SELECT baseline_sample_count FROM trades WHERE trade_id = ?").get("v12-trade-2")).toEqual({
      baseline_sample_count: null,
    });
    expect(
      migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_vpin_covering'").get(),
    ).toBeDefined();
    expect(
      migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_large_trade_z_score'").get(),
    ).toBeUndefined();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v13 in place by adding the VPIN covering index, and the query planner actually uses it", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "50000.00", size: "0.001", side: "buy", tradeId: "v13-trade",
    });
    initial.close();

    const versionThirteen = new Database(dbPath);
    versionThirteen.exec("DROP INDEX idx_trades_vpin_covering; UPDATE storage_schema SET version = 13;");
    versionThirteen.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT trade_id FROM trades").get()).toEqual({ trade_id: "v13-trade" });
    const plan = migrated.raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ts, side, price, size FROM trades " +
        "WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT' AND ts >= 0 AND ts < 9999999999999",
      )
      .all();
    expect(plan.some((step) => step.detail.includes("idx_trades_vpin_covering"))).toBe(true);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v15 in place by adding the daily-notional rollup and its watermark table, preserving existing rows", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "50000.00", size: "0.001", side: "buy", tradeId: "v15-trade",
    });
    initial.close();

    const versionFifteen = new Database(dbPath);
    versionFifteen.exec("DROP TABLE daily_notional_rollup; DROP TABLE daily_notional_rollup_watermark; UPDATE storage_schema SET version = 15;");
    versionFifteen.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT trade_id FROM trades").get()).toEqual({ trade_id: "v15-trade" });
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_notional_rollup'").get()).toBeDefined();
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_notional_rollup_watermark'").get()).toBeDefined();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  // L1L2-V2-024. validateCurrentSchema used to run before createCurrentIndexes,
  // so a database already at the current version but missing a required index
  // threw instead of being repaired -- and bootstrap:true is exactly what
  // `npm run migrate:storage-schema` uses, so the documented repair tool could
  // not repair. The writer path (bootstrap:false) must still refuse, because a
  // capture process silently rebuilding indexes is not the same guarantee.
  test("bootstrap repairs a dropped index on a current-version database, while the writer path still refuses", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "50000.00", size: "0.001", side: "buy", tradeId: "repair-trade",
    });
    initial.close();

    const dropped = new Database(dbPath);
    dropped.exec("DROP INDEX idx_trades_vpin_covering;");
    expect(dropped.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    dropped.close();

    expect(() => createStorageDb({ dbPath, bootstrap: false }))
      .toThrow(/missing index idx_trades_vpin_covering/);

    const repaired = createStorageDb({ dbPath, bootstrap: true });
    expect(
      repaired.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_vpin_covering'").get(),
    ).toBeDefined();
    expect(repaired.raw.prepare("SELECT trade_id FROM trades").get()).toEqual({ trade_id: "repair-trade" });
    repaired.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v10 in place by adding the durable depth-continuity ledger", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.close();

    const versionTen = new Database(dbPath);
    versionTen.exec("DROP TABLE depth_continuity_audits; UPDATE storage_schema SET version = 10;");
    versionTen.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'depth_continuity_audits'").get()).toBeDefined();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("fails closed when a database claims the current version but has lost a required table", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.close();
    const tampered = new Database(dbPath);
    tampered.exec("DROP TABLE depth_continuity_audits;");
    tampered.close();

    expect(() => createStorageDb({ dbPath })).toThrow(/missing table depth_continuity_audits/);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("fails closed when the schema-version table is ambiguous", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.close();
    const tampered = new Database(dbPath);
    tampered.prepare("INSERT INTO storage_schema (version) VALUES (?)").run(SCHEMA_VERSION);
    tampered.close();

    expect(() => createStorageDb({ dbPath })).toThrow(/exactly one row/);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("persists and reads the latest durable depth-continuity anchor per pair", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    storageDb.recordDepthContinuityAudit({
      dayStart: 0, symbol: "BTCUSDT", marketKind: "SPOT", firstUpdateId: 1, lastUpdateId: 10,
      rowsChecked: 2, gapsDetected: 0, anchorStatus: "BASELINE", auditedAt: 100,
    });
    storageDb.recordDepthContinuityAudit({
      dayStart: 86_400_000, symbol: "BTCUSDT", marketKind: "SPOT", firstUpdateId: 11, lastUpdateId: 20,
      rowsChecked: 2, gapsDetected: 0, anchorStatus: "ANCHORED", auditedAt: 200,
    });

    expect(storageDb.getLatestDepthContinuityAudit({
      beforeDayStart: 2 * 86_400_000, symbol: "BTCUSDT", marketKind: "SPOT",
    })).toMatchObject({ day_start: 86_400_000, last_update_id: 20, anchor_status: "ANCHORED" });
    storageDb.close();
  });

  test("migrates schema v6 in place by adding capture lineage without rebuilding market-data tables", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      price: "1",
      size: "1",
      side: "buy",
      tradeId: "v6-trade",
    });
    initial.close();

    const versionSix = new Database(dbPath);
    versionSix.exec(`
      DROP TABLE capture_incidents;
      DROP TABLE capture_sessions;
      DROP INDEX idx_trades_symbol_market_id;
      DROP INDEX IF EXISTS idx_trades_notional;
      ALTER TABLE candles DROP COLUMN taker_buy_base_volume;
      UPDATE storage_schema SET version = 6;
    `);
    versionSix.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT trade_id FROM trades").get().trade_id).toBe("v6-trade");
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_sessions'").get()).toBeDefined();
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_symbol_market_id'").get()).toBeDefined();
    expect(
      migrated.raw.prepare("SELECT * FROM pragma_table_info('candles') WHERE name = 'taker_buy_base_volume'").get(),
    ).toBeDefined();
    migrated.insert("candles", {
      tsOpen: 60_000,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "10",
      tradeCount: 3,
      takerBuyBaseVolume: "6",
    });
    expect(migrated.raw.prepare("SELECT taker_buy_base_volume FROM candles").get().taker_buy_base_volume).toBe("6");
    migrated.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v7 in place by adding the notional expression index, and the query planner actually uses it", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("trades", {
      ts: 1, symbol: "BTCUSDT", marketKind: "SPOT", price: "100", size: "1", side: "buy", tradeId: "v7-trade",
    });
    initial.close();

    const versionSeven = new Database(dbPath);
    versionSeven.exec(`
      DROP INDEX idx_trades_notional;
      ALTER TABLE candles DROP COLUMN taker_buy_base_volume;
      UPDATE storage_schema SET version = 7;
    `);
    versionSeven.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT trade_id FROM trades").get().trade_id).toBe("v7-trade");
    expect(
      migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_trades_notional'").get(),
    ).toBeDefined();
    expect(
      migrated.raw.prepare("SELECT * FROM pragma_table_info('candles') WHERE name = 'taker_buy_base_volume'").get(),
    ).toBeDefined();

    const plan = migrated.raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM trades WHERE symbol = 'BTCUSDT' AND market_kind = 'SPOT' " +
          "AND (CAST(price AS REAL) * CAST(size AS REAL)) >= 50",
      )
      .all();
    expect(plan.some((step) => step.detail.includes("idx_trades_notional"))).toBe(true);
    migrated.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v8 in place by adding the taker-buy-volume column, tolerant of NULL on pre-existing rows", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("candles", {
      tsOpen: 60_000,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "10",
      tradeCount: 3,
      takerBuyBaseVolume: "6",
    });
    initial.close();

    const versionEight = new Database(dbPath);
    versionEight.exec(`
      ALTER TABLE candles DROP COLUMN taker_buy_base_volume;
      UPDATE storage_schema SET version = 8;
    `);
    versionEight.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT taker_buy_base_volume FROM candles").get().taker_buy_base_volume).toBeNull();

    migrated.insert("candles", {
      tsOpen: 120_000,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "100.5",
      high: "102",
      low: "100",
      close: "101",
      volume: "8",
      tradeCount: 2,
      takerBuyBaseVolume: "5",
    });
    expect(
      migrated.raw.prepare("SELECT taker_buy_base_volume FROM candles WHERE ts_open = 120000").get()
        .taker_buy_base_volume,
    ).toBe("5");
    migrated.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("migrates schema v9 in place by adding raw quote-volume fields without rewriting existing candles", () => {
    const dbPath = tempDbPath();
    const initial = createStorageDb({ dbPath });
    initial.insert("candles", {
      tsOpen: 60_000,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "10",
      tradeCount: 3,
      takerBuyBaseVolume: "6",
      quoteVolume: "1000",
      takerBuyQuoteVolume: "600",
    });
    initial.close();

    const versionNine = new Database(dbPath);
    versionNine.exec(`
      ALTER TABLE candles DROP COLUMN taker_buy_quote_volume;
      ALTER TABLE candles DROP COLUMN quote_volume;
      UPDATE storage_schema SET version = 9;
    `);
    versionNine.close();

    const migrated = createStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT quote_volume, taker_buy_quote_volume FROM candles").get()).toEqual({
      quote_volume: null,
      taker_buy_quote_volume: null,
    });
    migrated.insert("candles", {
      tsOpen: 120_000,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "100",
      high: "102",
      low: "99",
      close: "101",
      volume: "8",
      tradeCount: 2,
      takerBuyBaseVolume: "5",
      quoteVolume: "808",
      takerBuyQuoteVolume: "505",
    });
    expect(migrated.raw.prepare("SELECT quote_volume, taker_buy_quote_volume FROM candles WHERE ts_open = 120000").get()).toEqual({
      quote_volume: "808",
      taker_buy_quote_volume: "505",
    });
    migrated.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("a fresh database enables incremental auto_vacuum from creation, so rotation's deletes are actually reclaimable", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    expect(storageDb.raw.pragma("auto_vacuum", { simple: true })).toBe(2);
    storageDb.close();
  });

  test("insert() writes a row that's readable back through the raw handle, for every table", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });

    storageDb.insert("trades", { ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: 100, size: 1, side: "buy", tradeId: "1" });
    storageDb.insert("candles", { tsOpen: 60_000, symbol: "BTCUSDT", marketKind: "SPOT", open: 1, high: 2, low: 1, close: 1.5, volume: 10, tradeCount: 4, takerBuyBaseVolume: 6 });
    storageDb.insert("l2_depth_events", {
      ts: 1000, receivedAt: 1001, symbol: "BTCUSDT", marketKind: "SPOT",
      firstUpdateId: 1, lastUpdateId: 2, previousUpdateId: null, bids: "[]", asks: "[]",
    });
    storageDb.insert("l2_depth_snapshots", {
      capturedAt: 1000, symbol: "BTCUSDT", marketKind: "SPOT", lastUpdateId: 2, bids: "[]", asks: "[]",
    });

    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM candles").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM l2_depth_events").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM l2_depth_snapshots").get().n).toBe(1);
    storageDb.close();
  });

  test("the CHECK constraint rejects taker_buy_base_volume greater than volume at the DB layer, not just in application code", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const row = { tsOpen: 60_000, symbol: "BTCUSDT", marketKind: "SPOT", open: 1, high: 2, low: 1, close: 1.5, volume: 10, tradeCount: 4 };

    expect(() => storageDb.insert("candles", { ...row, takerBuyBaseVolume: 10.0001 })).toThrow(/CHECK constraint failed/);
    expect(() => storageDb.insert("candles", { ...row, takerBuyBaseVolume: 999_999 })).toThrow(/CHECK constraint failed/);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM candles").get().n).toBe(0);

    storageDb.insert("candles", { ...row, takerBuyBaseVolume: 10 }); // equal is the boundary, must be allowed
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM candles").get().n).toBe(1);
    storageDb.close();
  });

  test("every table's id column is a strictly increasing monotonic key, independent of ts", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    // Out-of-order timestamps, still inserted in this call order.
    storageDb.insert("trades", { ts: 5000, symbol: "BTCUSDT", marketKind: "SPOT", price: 1, size: 1, side: "buy", tradeId: "a" });
    storageDb.insert("trades", { ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: 1, size: 1, side: "buy", tradeId: "b" });
    const rows = storageDb.raw.prepare("SELECT id, trade_id FROM trades ORDER BY id").all();
    expect(rows.map((r) => r.trade_id)).toEqual(["a", "b"]);
    expect(rows[1].id).toBeGreaterThan(rows[0].id);
    storageDb.close();
  });

  test("writes are idempotent by exchange identity, while a repeated closed candle corrects the stored OHLCV row", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const trade = { ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: "100.000", size: "1.250", side: "buy", tradeId: "1" };
    const depth = {
      ts: 1000, receivedAt: 1001, symbol: "BTCUSDT", marketKind: "SPOT",
      firstUpdateId: 1, lastUpdateId: 2, previousUpdateId: null, bids: "[]", asks: "[]",
    };
    const candle = {
      tsOpen: 60_000, symbol: "BTCUSDT", marketKind: "SPOT",
      open: "100.000", high: "101.000", low: "99.000", close: "100.000", volume: "1.000", tradeCount: 4,
      takerBuyBaseVolume: "0.500",
    };

    storageDb.insert("trades", trade);
    storageDb.insert("trades", trade);
    storageDb.insert("l2_depth_events", depth);
    storageDb.insert("l2_depth_events", depth);
    storageDb.insert("l2_depth_snapshots", {
      capturedAt: 1000, symbol: "BTCUSDT", marketKind: "SPOT", lastUpdateId: 2, bids: "[]", asks: "[]",
    });
    storageDb.insert("l2_depth_snapshots", {
      capturedAt: 1001, symbol: "BTCUSDT", marketKind: "SPOT", lastUpdateId: 2, bids: "[]", asks: "[]",
    });
    storageDb.insert("candles", candle);
    storageDb.insert("candles", { ...candle, close: "100.500", volume: "2.000", tradeCount: 5 });

    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM l2_depth_events").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM l2_depth_snapshots").get().n).toBe(1);
    expect(storageDb.raw.prepare("SELECT close, volume, trade_count FROM candles").get()).toEqual({
      close: "100.500",
      volume: "2.000",
      trade_count: 5,
    });
    storageDb.close();
  });

  test("preserves decimal storage as text rather than silently round-tripping through SQLite REAL affinity", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const price = "12345678901234567890.12345678901234567890";
    storageDb.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price, size: "0.000000000000000001", side: "buy", tradeId: "1",
    });

    expect(storageDb.raw.prepare("SELECT price, typeof(price) AS price_type FROM trades").get()).toEqual({
      price,
      price_type: "text",
    });
    storageDb.close();
  });

  test("persists an exact positive decimal below SQLite REAL's range without treating it as zero", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const tiny = `0.${"0".repeat(400)}1`;

    expect(() => storageDb.insert("trades", {
      ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: tiny, size: tiny, side: "buy", tradeId: "tiny",
    })).not.toThrow();
    expect(storageDb.raw.prepare("SELECT price, size FROM trades WHERE trade_id = 'tiny'").get()).toEqual({
      price: tiny,
      size: tiny,
    });
    const tableSql = storageDb.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trades'").get().sql;
    expect(tableSql).not.toContain("CAST(price AS REAL)");
    storageDb.close();
  });

  test.each(["", "0", "000.000", ".1", "1.", "1..2", "-1", "1e3", "1x"])(
    "rejects a malformed or non-positive direct database price value %p",
    (price) => {
      const storageDb = createStorageDb({ dbPath: ":memory:" });
      expect(() => storageDb.insert("trades", {
        ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price, size: "1", side: "buy", tradeId: "invalid",
      })).toThrow();
      storageDb.close();
    },
  );

  test("rejects invalid table names and writes after close at the database boundary", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("unknown", {})).toThrow(/unsupported table/);
    storageDb.close();
    expect(() => storageDb.close()).not.toThrow();
    expect(() => storageDb.insert("trades", {})).toThrow(/after close/);
  });

  test("rejects a candle open time that is not aligned to the canonical one-minute grid", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("candles", {
      tsOpen: 1,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      open: "1",
      high: "1",
      low: "1",
      close: "1",
      volume: "0",
      tradeCount: 0,
      takerBuyBaseVolume: null,
    })).toThrow();
    storageDb.close();
  });

  test("rejects non-array and oversized depth JSON plus market-specific pu violations at the database boundary", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const base = {
      ts: 1,
      receivedAt: 1,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      firstUpdateId: 1,
      lastUpdateId: 2,
      previousUpdateId: null,
      bids: "[]",
      asks: "[]",
    };

    expect(() => storageDb.insert("l2_depth_events", { ...base, bids: "{}" })).toThrow();
    expect(() => storageDb.insert("l2_depth_events", {
      ...base,
      bids: JSON.stringify(Array.from({ length: 5_001 }, () => [])),
    })).toThrow();
    expect(() => storageDb.insert("l2_depth_events", { ...base, previousUpdateId: 0 })).toThrow();
    expect(() => storageDb.insert("l2_depth_events", {
      ...base,
      marketKind: "PERPETUAL",
      previousUpdateId: null,
    })).toThrow();
    expect(() => storageDb.insert("l2_depth_snapshots", {
      capturedAt: 1,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      lastUpdateId: 2,
      bids: "{}",
      asks: "[]",
    })).toThrow();
    storageDb.close();
  });

  describe("corrupted/missing database file", () => {
    let dbPath;

    afterEach(() => {
      for (const candidate of fs.readdirSync(os.tmpdir())) {
        if (candidate.startsWith(path.basename(dbPath))) {
          safeRm(path.join(os.tmpdir(), candidate), { force: true });
        }
      }
    });

    test("a missing database file is created fresh, not treated as an error", () => {
      dbPath = tempDbPath();
      expect(fs.existsSync(dbPath)).toBe(false);
      const storageDb = createStorageDb({ dbPath });
      expect(fs.existsSync(dbPath)).toBe(true);
      storageDb.close();
    });

    test("a corrupted database file fails closed without replacing or modifying capture history", () => {
      dbPath = tempDbPath();
      fs.writeFileSync(dbPath, "this is not a valid sqlite file");

      expect(() => createStorageDb({ dbPath })).toThrow(/collector halted/);
      expect(fs.readFileSync(dbPath, "utf8")).toBe("this is not a valid sqlite file");
    });

    test("migrates the original Phase 2 schema without losing the newest record for each idempotency key", () => {
      dbPath = tempDbPath();
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, market_kind TEXT NOT NULL, price REAL NOT NULL, size REAL NOT NULL, side TEXT NOT NULL, trade_id TEXT NOT NULL);
        CREATE TABLE candles (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_open INTEGER NOT NULL, symbol TEXT NOT NULL, market_kind TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, trade_count INTEGER NOT NULL);
        CREATE TABLE l2_depth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, received_at INTEGER NOT NULL, symbol TEXT NOT NULL, market_kind TEXT NOT NULL, first_update_id INTEGER NOT NULL, last_update_id INTEGER NOT NULL, previous_update_id INTEGER, bids TEXT NOT NULL, asks TEXT NOT NULL);
      `);
      legacy.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, "BTCUSDT", "SPOT", 1, 1, "buy", "a");
      legacy.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(2, "BTCUSDT", "SPOT", 2, 1, "buy", "a");
      legacy.prepare("INSERT INTO candles (ts_open, symbol, market_kind, open, high, low, close, volume, trade_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(60_000, "BTCUSDT", "SPOT", 1, 1, 1, 1, 1, 1);
      legacy.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "BTCUSDT", "SPOT", 1, 2, null, "[]", "[]");
      legacy.close();

      const storageDb = createStorageDb({ dbPath });

      expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
      expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(1);
      expect(storageDb.raw.prepare("SELECT ts, price, typeof(price) AS price_type FROM trades").get()).toEqual({
        ts: 2,
        price: "2.0",
        price_type: "text",
      });
      expect(storageDb.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_candles_symbol_market_ts'").get()).toBeDefined();
      storageDb.close();
    });

    test("migrates version 2 by adding the raw depth-snapshot replay baseline without rewriting existing rows", () => {
      dbPath = tempDbPath();
      const initial = createStorageDb({ dbPath });
      initial.insert("trades", { ts: 1, symbol: "BTCUSDT", marketKind: "SPOT", price: "1", size: "1", side: "buy", tradeId: "a" });
      initial.close();

      const versionTwo = new Database(dbPath);
      versionTwo.exec("DROP TABLE l2_depth_snapshots; UPDATE storage_schema SET version = 2;");
      versionTwo.close();

      const storageDb = createStorageDb({ dbPath });

      expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
      expect(storageDb.raw.prepare("SELECT trade_id FROM trades").all()).toEqual([{ trade_id: "a" }]);
      expect(storageDb.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'l2_depth_snapshots'").get()).toBeDefined();
      storageDb.close();
    });

    test("migrates version 3 by enabling incremental auto_vacuum on an already-populated file, without losing rows", () => {
      dbPath = tempDbPath();
      const initial = createStorageDb({ dbPath });
      initial.insert("trades", { ts: 1, symbol: "BTCUSDT", marketKind: "SPOT", price: "1", size: "1", side: "buy", tradeId: "a" });
      initial.insert("l2_depth_snapshots", { capturedAt: 1, symbol: "BTCUSDT", marketKind: "SPOT", lastUpdateId: 5, bids: "[]", asks: "[]" });
      initial.close();

      const versionThree = new Database(dbPath);
      versionThree.exec("UPDATE storage_schema SET version = 3;");
      versionThree.close();

      const storageDb = createStorageDb({ dbPath });

      expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
      expect(storageDb.raw.pragma("auto_vacuum", { simple: true })).toBe(2);
      expect(storageDb.raw.prepare("SELECT trade_id FROM trades").all()).toEqual([{ trade_id: "a" }]);
      expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM l2_depth_snapshots").get().n).toBe(1);
      storageDb.close();
    });

    test("migrates version 4 through the exact-decimal schema rebuild without losing rows or indexes", () => {
      dbPath = tempDbPath();
      const initial = createStorageDb({ dbPath });
      initial.insert("trades", { ts: 1, symbol: "BTCUSDT", marketKind: "SPOT", price: "1.25", size: "2", side: "buy", tradeId: "a" });
      initial.close();

      const versionFour = new Database(dbPath);
      versionFour.exec("UPDATE storage_schema SET version = 4;");
      versionFour.close();

      const storageDb = createStorageDb({ dbPath });
      expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
      expect(storageDb.raw.prepare("SELECT price, size FROM trades WHERE trade_id = 'a'").get()).toEqual({ price: "1.25", size: "2" });
      expect(storageDb.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_l2_depth_events_symbol_market_id'").get()).toBeDefined();
      storageDb.close();
    });

    test("migrates version 5 through the depth-integrity schema rebuild without losing valid rows", () => {
      dbPath = tempDbPath();
      const initial = createStorageDb({ dbPath });
      initial.insert("l2_depth_events", {
        ts: 1,
        receivedAt: 2,
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        firstUpdateId: 1,
        lastUpdateId: 2,
        previousUpdateId: null,
        bids: "[]",
        asks: "[]",
      });
      initial.close();

      const versionFive = new Database(dbPath);
      versionFive.exec("UPDATE storage_schema SET version = 5;");
      versionFive.close();

      const storageDb = createStorageDb({ dbPath });
      expect(storageDb.raw.prepare("SELECT version FROM storage_schema").get().version).toBe(SCHEMA_VERSION);
      expect(storageDb.raw.prepare("SELECT first_update_id, last_update_id FROM l2_depth_events").get()).toEqual({
        first_update_id: 1,
        last_update_id: 2,
      });
      storageDb.close();
    });
  });
});
