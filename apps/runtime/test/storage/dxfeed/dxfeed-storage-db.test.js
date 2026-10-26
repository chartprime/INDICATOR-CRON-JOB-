const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { safeRm } = require("../../helpers/temp-files");
const {
  createDxFeedStorageDb, verifyDxFeedStorageIntegrity, SCHEMA_VERSION, ORDER_BOOK_ARRIVAL_INDEX,
} = require("../../../src/storage/dxfeed/dxfeed-storage-db");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-dxfeed-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

const VALID_QUOTE = {
  eventTime: 1000, receivedAt: 1000, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY",
  bidPrice: 29111.5, bidSize: 2, bidTime: 1000, bidExchangeCode: "G",
  askPrice: 29112, askSize: 3, askTime: 1000, askExchangeCode: "G",
};

const VALID_TRADE = {
  eventTime: 1000, receivedAt: 1000, provider: "DXFEED", venue: null, assetClass: "EQUITY",
  symbol: "TSLA", stale: 0, recoveryState: "READY",
  price: 349.03, size: 120, time: 1000, exchangeCode: "L", change: -13.83,
  dayVolume: 34651826.7, dayTurnover: 12302399792.64278, tickDirection: "ZERO_UP", extendedTradingHours: 1,
};

const VALID_ORDER_BOOK_CAPTURE = {
  eventTime: 1000, receivedAt: 1000, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY",
  orderIndex: "5137554220647453001", eventFlags: 4, time: 1000, action: "NEW", actionTime: 1000,
  orderId: 0, price: 29139.75, size: 7, side: "SELL", scope: "ORDER", source: "GLBX", marketMaker: null,
};

const VALID_CANDLE = {
  tsOpen: 1787714820000, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", open: 29219, high: 29225, low: 29210, close: 29220,
  volume: 12, buyVolume: 7, tradeCount: 4,
};

const VALID_TIME_AND_SALE = {
  eventTime: 1000, receivedAt: 1001, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE",
  symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY", price: 29111.25, size: 2,
  time: 1000, timeNanoPart: 0, sequence: 42, exchangeCode: "G", extendedTradingHours: 0,
  aggressorSide: "SELL", spreadLeg: 0, validTick: 1, eventKind: "NEW", providerIndex: null,
  providerTradeId: null, bidPrice: null, askPrice: null,
};

describe("createDxFeedStorageDb", () => {
  test("rejects a missing/empty dbPath before touching the filesystem", () => {
    expect(() => createDxFeedStorageDb({ dbPath: "" })).toThrow(/dbPath/);
    expect(() => createDxFeedStorageDb({ dbPath: "   " })).toThrow(/dbPath/);
    expect(() => createDxFeedStorageDb({ dbPath: undefined })).toThrow(/dbPath/);
  });

  test("rejects a forged current version when a required table is missing", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const tampered = new Database(dbPath);
    tampered.exec("DROP TABLE dxfeed_trades");
    tampered.close();

    expect(() => createDxFeedStorageDb({ dbPath })).toThrow(/missing table dxfeed_trades/);
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("rejects an ambiguous schema version table instead of trusting an arbitrary row", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const tampered = new Database(dbPath);
    tampered.prepare("INSERT INTO dxfeed_storage_schema (version) VALUES (?)").run(SCHEMA_VERSION);
    tampered.close();

    expect(() => createDxFeedStorageDb({ dbPath })).toThrow(/exactly one row/);
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("creates all dxfeed data tables, capture-session lineage, and the schema-version table on a fresh in-memory database", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    const tableNames = storageDb.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tableNames).toEqual([
      "dxfeed_candles", "dxfeed_capture_sessions", "dxfeed_order_book_capture", "dxfeed_order_book_continuity_audits",
      "dxfeed_quotes", "dxfeed_storage_schema", "dxfeed_time_and_sales", "dxfeed_trades",
    ]);
    expect(storageDb.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    storageDb.close();
  });

  test("inserts a valid quote row", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_quotes", VALID_QUOTE);
    const row = storageDb.raw.prepare("SELECT * FROM dxfeed_quotes").get();
    expect(row.symbol).toBe("/NQZ26:XCME");
    expect(row.bid_price).toBe(29111.5);
    expect(row.venue).toBe("XCME");
    storageDb.close();
  });

  test("inserts a valid trade row with a nullable venue (equity)", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_trades", VALID_TRADE);
    const row = storageDb.raw.prepare("SELECT * FROM dxfeed_trades").get();
    expect(row.venue).toBeNull();
    expect(row.change).toBe(-13.83);
    expect(row.extended_trading_hours).toBe(1);
    storageDb.close();
  });


  test("inserts a valid TimeAndSale row without corrupting unsafe provider identifiers", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_time_and_sales", VALID_TIME_AND_SALE);
    const row = storageDb.raw.prepare("SELECT * FROM dxfeed_time_and_sales").get();
    expect(row).toMatchObject({ event_kind: "NEW", aggressor_side: "SELL", provider_index: null, valid_tick: 1 });
    storageDb.close();
  });

  test("TimeAndSale SQL constraints reject invalid classification values", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventKind: "REPLAY" })).toThrow();
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, validTick: 2 })).toThrow();
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, sequence: -1 })).toThrow();
    storageDb.close();
  });

  test("TimeAndSale bid_price/ask_price are optional but rejected when non-positive", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, bidPrice: 319.73, askPrice: 319.78 });
    const row = storageDb.raw.prepare("SELECT bid_price, ask_price FROM dxfeed_time_and_sales").get();
    expect(row).toEqual({ bid_price: 319.73, ask_price: 319.78 });
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, bidPrice: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, askPrice: -1 })).toThrow();
    storageDb.close();
  });

  test("rejects an unknown table name", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_nonexistent", VALID_TRADE)).toThrow(/unsupported table/);
    storageDb.close();
  });

  test("inserts a valid candle row, with a nullable buy_volume", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_candles", VALID_CANDLE);
    storageDb.insert("dxfeed_candles", { ...VALID_CANDLE, tsOpen: VALID_CANDLE.tsOpen + 60_000, buyVolume: null });
    const rows = storageDb.raw.prepare("SELECT * FROM dxfeed_candles ORDER BY ts_open").all();
    expect(rows).toHaveLength(2);
    expect(rows[0].buy_volume).toBe(7);
    expect(rows[1].buy_volume).toBeNull();
    storageDb.close();
  });

  test("dxfeed_candles is idempotent per symbol-minute", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_candles", VALID_CANDLE);
    storageDb.insert("dxfeed_candles", VALID_CANDLE);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_candles").get().n).toBe(1);
    storageDb.close();
  });

  test("CHECK constraint rejects a ts_open that doesn't align to the 60s candle interval", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_candles", { ...VALID_CANDLE, tsOpen: 1787714820123 })).toThrow();
    storageDb.close();
  });

  test("CHECK constraint rejects a non-positive candle open/volume, and a negative buy_volume", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_candles", { ...VALID_CANDLE, open: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_candles", { ...VALID_CANDLE, volume: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_candles", { ...VALID_CANDLE, buyVolume: -1 })).toThrow();
    storageDb.close();
  });

  test("rejects a write after close", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.close();
    expect(() => storageDb.insert("dxfeed_quotes", VALID_QUOTE)).toThrow(/cannot write after close/);
    expect(() => storageDb.transaction(() => {})).toThrow(/cannot transact after close/);
  });

  test("commits successful batches and rolls back the entire transaction on failure", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.transaction(() => {
      storageDb.insert("dxfeed_trades", VALID_TRADE);
      storageDb.insert("dxfeed_trades", { ...VALID_TRADE, price: 2 });
    });
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n).toBe(2);
    expect(() => storageDb.transaction(() => {
      storageDb.insert("dxfeed_trades", { ...VALID_TRADE, price: 3 });
      throw new Error("rollback");
    })).toThrow(/rollback/);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n).toBe(2);
    expect(() => storageDb.transaction(null)).toThrow(/work must be a function/);
    storageDb.close();
  });

  test("reopens an existing database and appends without deleting prior capture", () => {
    const dbPath = tempDbPath();
    const first = createDxFeedStorageDb({ dbPath });
    first.insert("dxfeed_trades", VALID_TRADE);
    first.close();
    const second = createDxFeedStorageDb({ dbPath });
    expect(second.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n).toBe(1);
    second.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: VALID_TRADE.eventTime + 1, time: VALID_TRADE.time + 1 });
    expect(second.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n).toBe(2);
    second.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("CHECK constraint rejects a non-positive bid price (SQL-level defense, not just JS-level)", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_quotes", { ...VALID_QUOTE, bidPrice: 0 })).toThrow();
    storageDb.close();
  });

  test("CHECK constraint rejects an asset_class outside FUTURE/EQUITY", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_trades", { ...VALID_TRADE, assetClass: "CRYPTO" })).toThrow();
    storageDb.close();
  });

  test("CHECK constraints reject a literal 0 event_time/time-family value, dxFeed's own not-usable sentinel, on every table that carries one", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_quotes", { ...VALID_QUOTE, eventTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_quotes", { ...VALID_QUOTE, bidTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_quotes", { ...VALID_QUOTE, askTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_trades", { ...VALID_TRADE, eventTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_trades", { ...VALID_TRADE, time: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, eventTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, time: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, eventTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, eventTime: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, time: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, actionTime: 0 })).toThrow();
    storageDb.close();
  });



  test("migrates a v2 database by adding dxfeed_candles, preserving all existing rows untouched", () => {
    const dbPath = tempDbPath();
    const original = createDxFeedStorageDb({ dbPath });
    original.insert("dxfeed_trades", VALID_TRADE);
    original.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    original.close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE dxfeed_candles;
      UPDATE dxfeed_storage_schema SET version = 2;
    `);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n).toBe(1);
    migrated.insert("dxfeed_candles", VALID_CANDLE);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_candles").get().n).toBe(1);
    migrated.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("a v1 database migrates all the way through to v3, gaining dxfeed_candles too", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE dxfeed_candles;
      DROP TABLE IF EXISTS dxfeed_orders;
      CREATE TABLE dxfeed_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, provider TEXT NOT NULL,
        venue TEXT, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, stale INTEGER NOT NULL,
        recovery_state TEXT NOT NULL, order_index INTEGER, time INTEGER NOT NULL, action TEXT NOT NULL,
        order_id INTEGER, price REAL NOT NULL, size REAL, side TEXT NOT NULL, scope TEXT NOT NULL,
        source TEXT NOT NULL, market_maker TEXT,
        UNIQUE (symbol, asset_class, order_index)
      );
      UPDATE dxfeed_storage_schema SET version = 1;
    `);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    migrated.insert("dxfeed_candles", VALID_CANDLE);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_candles").get().n).toBe(1);
    migrated.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("migrates a genuine v3 database by adding the TimeAndSale table", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE dxfeed_time_and_sales; UPDATE dxfeed_storage_schema SET version = 3;");
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    migrated.insert("dxfeed_time_and_sales", VALID_TIME_AND_SALE);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_time_and_sales").get().n).toBe(1);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("migrates a genuine v4 database by adding the order_book_capture table", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE dxfeed_order_book_capture; UPDATE dxfeed_storage_schema SET version = 4;");
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    migrated.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("migrates a genuine v14 database, preserving existing order-book-capture rows and relaxing the CHECK for TRADE/BUST", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE dxfeed_order_book_capture_v14legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, provider TEXT NOT NULL,
        venue TEXT, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, stale INTEGER NOT NULL,
        recovery_state TEXT NOT NULL, order_index TEXT NOT NULL, event_flags INTEGER NOT NULL,
        time INTEGER, action TEXT, action_time INTEGER, order_id INTEGER,
        price REAL CHECK (price IS NULL OR price > 0 OR action IN ('TRADE', 'BUST')),
        size REAL, side TEXT, scope TEXT, source TEXT NOT NULL, market_maker TEXT,
        CHECK ((event_flags & 2) != 0 OR (time IS NOT NULL AND action IS NOT NULL AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL))
      );
      INSERT INTO dxfeed_order_book_capture_v14legacy SELECT
        id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
        order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
        source, market_maker
      FROM dxfeed_order_book_capture;
      DROP TABLE dxfeed_order_book_capture;
      ALTER TABLE dxfeed_order_book_capture_v14legacy RENAME TO dxfeed_order_book_capture;
      UPDATE dxfeed_storage_schema SET version = 14;
    `);
    legacy.prepare(
      "INSERT INTO dxfeed_order_book_capture (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, order_index, event_flags, time, action, action_time, order_id, price, size, side, scope, source, market_maker) VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @orderIndex, @eventFlags, @time, @action, @actionTime, @orderId, @price, @size, @side, @scope, @source, @marketMaker)",
    ).run(VALID_ORDER_BOOK_CAPTURE);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    migrated.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "TRADE", time: null, price: 0 });
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(2);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("a fresh (bootstrap) database accepts a TRADE/BUST order-book-capture row with time: null", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    for (const action of ["TRADE", "BUST"]) {
      storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action, time: null, price: 0 });
    }
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(2);
    storageDb.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("a fresh (bootstrap) database still rejects a non-TRADE/BUST order-book-capture row with time: null", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, time: null })).toThrow(
      /CHECK constraint failed/,
    );
    storageDb.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("a fresh (bootstrap) database still requires price/side/scope even for TRADE/BUST, only time is relaxed", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath });
    expect(() =>
      storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "TRADE", time: null, side: null }),
    ).toThrow(/CHECK constraint failed/);
    storageDb.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });




  test("migrates a genuine v7 database by adding bid_price/ask_price to TimeAndSale, preserving existing rows", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE dxfeed_time_and_sales_v7 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, provider TEXT NOT NULL,
        venue TEXT, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, stale INTEGER NOT NULL,
        recovery_state TEXT NOT NULL, price REAL NOT NULL, size REAL NOT NULL, time INTEGER NOT NULL,
        time_nano_part INTEGER NOT NULL, sequence INTEGER NOT NULL, exchange_code TEXT NOT NULL,
        extended_trading_hours INTEGER NOT NULL, aggressor_side TEXT NOT NULL, spread_leg INTEGER NOT NULL,
        valid_tick INTEGER NOT NULL, event_kind TEXT NOT NULL, provider_index INTEGER, provider_trade_id INTEGER
      );
      INSERT INTO dxfeed_time_and_sales_v7 SELECT
        id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
        price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours,
        aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id
      FROM dxfeed_time_and_sales;
      DROP TABLE dxfeed_time_and_sales;
      ALTER TABLE dxfeed_time_and_sales_v7 RENAME TO dxfeed_time_and_sales;
      UPDATE dxfeed_storage_schema SET version = 7;
    `);
    const insertLegacy = legacy.prepare(
      "INSERT INTO dxfeed_time_and_sales (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id) VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @price, @size, @time, @timeNanoPart, @sequence, @exchangeCode, @extendedTradingHours, @aggressorSide, @spreadLeg, @validTick, @eventKind, @providerIndex, @providerTradeId)",
    );
    const { bidPrice, askPrice, ...preV8Shape } = VALID_TIME_AND_SALE;
    void bidPrice;
    void askPrice;
    insertLegacy.run(preV8Shape);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    const preExisting = migrated.raw.prepare("SELECT price, bid_price, ask_price FROM dxfeed_time_and_sales").get();
    expect(preExisting).toEqual({ price: VALID_TIME_AND_SALE.price, bid_price: null, ask_price: null });
    migrated.insert("dxfeed_time_and_sales", { ...VALID_TIME_AND_SALE, bidPrice: 100, askPrice: 101 });
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_time_and_sales").get().n).toBe(2);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("does not collide with the legacy migrateV1ToV2 migration's own transient dxfeed_orders_v2 rename-staging table", () => {
    // The v1->v2 migration internally creates a table literally named
    // dxfeed_orders_v2 as a rename-staging step, then renames it away to
    // dxfeed_orders within the same migration -- a real, found-live naming
    // collision risk against this table's own original working name
    // (dxfeed_orders_v2), which is exactly why this table is called
    // dxfeed_order_book_capture instead. This test starts from a v1
    // fixture (which already has today's fully-migrated schema, including
    // dxfeed_order_book_capture, since createDxFeedStorageDb() always
    // creates the current schema first) and proves the full v1->v5 chain
    // still succeeds with dxfeed_order_book_capture already present.
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE dxfeed_candles;
      DROP TABLE IF EXISTS dxfeed_orders;
      CREATE TABLE dxfeed_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, provider TEXT NOT NULL,
        venue TEXT, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, stale INTEGER NOT NULL,
        recovery_state TEXT NOT NULL, order_index INTEGER, time INTEGER NOT NULL, action TEXT NOT NULL,
        order_id INTEGER, price REAL NOT NULL, size REAL, side TEXT NOT NULL, scope TEXT NOT NULL,
        source TEXT NOT NULL, market_maker TEXT,
        UNIQUE (symbol, asset_class, order_index)
      );
      UPDATE dxfeed_storage_schema SET version = 1;
    `);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    migrated.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("inserts a valid order-book-capture row with the full-precision index preserved as text", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    const row = storageDb.raw.prepare("SELECT order_index, event_flags, action FROM dxfeed_order_book_capture").get();
    expect(row).toEqual({ order_index: "5137554220647453001", event_flags: 4, action: "NEW" });
    expect(BigInt(row.order_index) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    storageDb.close();
  });

  test("migrates a v9 database in place by adding durable capture-session lineage", () => {
    const dbPath = tempDbPath();
    const initial = createDxFeedStorageDb({ dbPath });
    initial.insert("dxfeed_time_and_sales", VALID_TIME_AND_SALE);
    initial.close();
    const versionNine = new Database(dbPath);
    versionNine.exec("DROP TABLE dxfeed_capture_sessions; UPDATE dxfeed_storage_schema SET version = 9;");
    versionNine.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_time_and_sales").get().n).toBe(1);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dxfeed_capture_sessions'").get()).toBeDefined();
    migrated.close();
    safeRm(dbPath, { force: true });
    safeRm(`${dbPath}-wal`, { force: true });
    safeRm(`${dbPath}-shm`, { force: true });
  });

  test("records a clean capture session outcome", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.beginCaptureSession({ sessionId: "session-a", startedAt: 1000 });
    storageDb.finishCaptureSession({
      sessionId: "session-a", endedAt: 2000, quality: "HEALTHY", cleanShutdown: true,
      terminationReason: "PLANNED_ROTATION",
    });

    expect(storageDb.raw.prepare("SELECT * FROM dxfeed_capture_sessions").get()).toMatchObject({
      session_id: "session-a", started_at: 1000, ended_at: 2000, quality: "HEALTHY",
      clean_shutdown: 1, termination_reason: "PLANNED_ROTATION",
    });
    storageDb.close();
  });

  test("marks an unfinished prior capture session invalid before opening the next one", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.beginCaptureSession({ sessionId: "session-a", startedAt: 1000 });
    storageDb.beginCaptureSession({ sessionId: "session-b", startedAt: 2000 });

    expect(storageDb.raw.prepare("SELECT * FROM dxfeed_capture_sessions WHERE session_id = ?").get("session-a")).toMatchObject({
      ended_at: 2000, quality: "INVALID", clean_shutdown: 0,
      termination_reason: "UNCLEAN_PREVIOUS_PROCESS_EXIT",
    });
    expect(storageDb.raw.prepare("SELECT * FROM dxfeed_capture_sessions WHERE session_id = ?").get("session-b")).toMatchObject({
      ended_at: null, quality: "HEALTHY", clean_shutdown: 0,
    });
    storageDb.close();
  });

  test("reports existing data and the previous capture-session outcome before a new session begins", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_trades", VALID_TRADE);
    storageDb.beginCaptureSession({ sessionId: "session-a", startedAt: 1000 });
    storageDb.finishCaptureSession({ sessionId: "session-a", endedAt: 2000, quality: "DEGRADED", cleanShutdown: true });

    expect(storageDb.getCaptureResumeState()).toEqual({
      hasExistingData: true, previousSessionEndedAt: 2000,
      previousSessionCleanShutdown: true, previousSessionQuality: "DEGRADED",
    });
    storageDb.close();
  });

  test("allows only a removal-flagged structural row to omit unavailable provider book fields", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_order_book_capture", {
      ...VALID_ORDER_BOOK_CAPTURE,
      eventTime: 2000,
      receivedAt: 2000,
      eventFlags: 0x0e,
      time: null,
      action: null,
      actionTime: null,
      orderId: null,
      price: null,
      size: null,
      side: null,
      scope: null,
    });
    expect(storageDb.raw.prepare(
      "SELECT time, action, price, side, scope FROM dxfeed_order_book_capture",
    ).get()).toEqual({ time: null, action: null, price: null, side: null, scope: null });
    expect(() => storageDb.insert("dxfeed_order_book_capture", {
      ...VALID_ORDER_BOOK_CAPTURE,
      eventFlags: 0x04,
      time: null,
      action: null,
      price: null,
      side: null,
      scope: null,
    })).toThrow();
    storageDb.close();
  });

  test("CHECK constraint rejects a non-digit or oversized order_index string (SQL-level defense, not just JS-level)", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, orderIndex: "" })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, orderIndex: "-5" })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, orderIndex: "12x34" })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, orderIndex: "1".repeat(21) })).toThrow();
    storageDb.close();
  });

  test("CHECK constraint rejects a negative event_flags value", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, eventFlags: -1 })).toThrow();
    storageDb.close();
  });

  test("CHECK constraint allows price 0 for TRADE/BUST actions but still rejects it for every other action", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "TRADE", price: 0 });
    storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "BUST", price: 0 });
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(2);
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "NEW", price: 0 })).toThrow();
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "DELETE", price: 0 })).toThrow();
    storageDb.close();
  });

  test("migrates a genuine v5 database, relaxing the price CHECK constraint for TRADE/BUST while preserving existing rows", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE dxfeed_order_book_capture;
      CREATE TABLE dxfeed_order_book_capture (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, provider TEXT NOT NULL,
        venue TEXT, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, stale INTEGER NOT NULL,
        recovery_state TEXT NOT NULL,
        order_index TEXT NOT NULL, event_flags INTEGER NOT NULL, time INTEGER NOT NULL,
        action TEXT NOT NULL, action_time INTEGER, order_id INTEGER,
        price REAL NOT NULL CHECK (price > 0), size REAL, side TEXT NOT NULL,
        scope TEXT NOT NULL, source TEXT NOT NULL, market_maker TEXT
      );
      UPDATE dxfeed_storage_schema SET version = 5;
    `);
    const insertLegacy = legacy.prepare(
      "INSERT INTO dxfeed_order_book_capture (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, order_index, event_flags, time, action, action_time, order_id, price, size, side, scope, source, market_maker) VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @orderIndex, @eventFlags, @time, @action, @actionTime, @orderId, @price, @size, @side, @scope, @source, @marketMaker)",
    );
    insertLegacy.run(VALID_ORDER_BOOK_CAPTURE);
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    migrated.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "TRADE", price: 0 });
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(2);
    expect(() => migrated.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "NEW", price: 0 })).toThrow();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("migrates a v6 database by adding the stable per-source replay index without rewriting captured rows", () => {
    const dbPath = tempDbPath();
    const current = createDxFeedStorageDb({ dbPath });
    current.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    current.close();
    const legacy = new Database(dbPath);
    legacy.exec("DROP INDEX idx_dxfeed_order_book_capture_replay; UPDATE dxfeed_storage_schema SET version = 6;");
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    expect(migrated.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_dxfeed_order_book_capture_replay'").get()).toBeDefined();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("allows a null size, action_time, order_id, and market_maker -- all legitimately optional on this feed", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_order_book_capture", {
      ...VALID_ORDER_BOOK_CAPTURE, size: null, actionTime: null, orderId: null, marketMaker: null,
    });
    const row = storageDb.raw.prepare("SELECT size, action_time, order_id, market_maker FROM dxfeed_order_book_capture").get();
    expect(row).toEqual({ size: null, action_time: null, order_id: null, market_maker: null });
    storageDb.close();
  });

  test("migrates a v8 capture table without losing prior rows, then accepts a structural removal", () => {
    const dbPath = tempDbPath();
    const current = createDxFeedStorageDb({ dbPath });
    current.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    current.close();
    const legacy = new Database(dbPath);
    legacy.exec("UPDATE dxfeed_storage_schema SET version = 8;");
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    migrated.insert("dxfeed_order_book_capture", {
      ...VALID_ORDER_BOOK_CAPTURE,
      eventTime: 2000,
      receivedAt: 2000,
      eventFlags: 0x0e,
      time: null,
      action: null,
      actionTime: null,
      orderId: null,
      price: null,
      size: null,
      side: null,
      scope: null,
    });
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(2);
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });


  test("migrates a v10 database by adding the order-book continuity ledger without losing prior rows", () => {
    const dbPath = tempDbPath();
    const current = createDxFeedStorageDb({ dbPath });
    current.insert("dxfeed_order_book_capture", VALID_ORDER_BOOK_CAPTURE);
    current.close();
    const legacy = new Database(dbPath);
    legacy.exec("UPDATE dxfeed_storage_schema SET version = 10;");
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n).toBe(1);
    expect(() => migrated.recordOrderBookContinuityAudit({
      dayStart: 0, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
      rowsChecked: 1, danglingAtDayEnd: false, anchorStatus: "CLEAN", auditedAt: 1000,
    })).not.toThrow();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("migrates a v11 database by adding the nullable large-trade baseline columns, dropping the retired indexes, preserving prior rows", () => {
    const dbPath = tempDbPath();
    const current = createDxFeedStorageDb({ dbPath });
    current.insert("dxfeed_time_and_sales", VALID_TIME_AND_SALE);
    current.close();
    const legacy = new Database(dbPath);
    legacy.exec(
      "ALTER TABLE dxfeed_time_and_sales DROP COLUMN baseline_log_median; " +
      "ALTER TABLE dxfeed_time_and_sales DROP COLUMN baseline_log_mad; " +
      "ALTER TABLE dxfeed_time_and_sales DROP COLUMN baseline_sample_count; " +
      "UPDATE dxfeed_storage_schema SET version = 11;",
    );
    legacy.close();

    const migrated = createDxFeedStorageDb({ dbPath });
    expect(migrated.raw.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT COUNT(*) AS n FROM dxfeed_time_and_sales").get().n).toBe(1);
    expect(migrated.raw.prepare("SELECT baseline_log_median, baseline_log_mad, baseline_sample_count FROM dxfeed_time_and_sales").get()).toEqual({
      baseline_log_median: null, baseline_log_mad: null, baseline_sample_count: null,
    });
    // L1L2-V2-084. The baseline columns stay -- dropping one from a 40GB table
    // costs a full rewrite -- but every index built for the retired detector
    // must be gone once migration completes.
    for (const retired of [
      "idx_dxfeed_time_and_sales_large_trade_z_score",
      "idx_dxfeed_time_and_sales_futures_fixed_floor",
      "idx_dxfeed_time_and_sales_equity_fixed_floor",
    ]) {
      expect(
        migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(retired),
      ).toBeUndefined();
    }
    expect(() => migrated.insert("dxfeed_time_and_sales", {
      ...VALID_TIME_AND_SALE, baselineLogMedian: 4.5, baselineLogMad: 0.6, baselineSampleCount: 20,
    })).not.toThrow();
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  describe("recordOrderBookContinuityAudit", () => {
    test("records a clean day and an interrupted day as distinct rows, keyed by day/symbol/assetClass/source", () => {
      const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
      storageDb.recordOrderBookContinuityAudit({
        dayStart: 0, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
        rowsChecked: 500, danglingAtDayEnd: false, anchorStatus: "CLEAN", auditedAt: 1000,
      });
      storageDb.recordOrderBookContinuityAudit({
        dayStart: 86_400_000, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
        rowsChecked: 300, danglingAtDayEnd: true, anchorStatus: "INTERRUPTED", auditedAt: 2000,
      });
      const rows = storageDb.raw.prepare(
        "SELECT day_start, dangling_at_day_end, anchor_status FROM dxfeed_order_book_continuity_audits ORDER BY day_start ASC",
      ).all();
      expect(rows).toEqual([
        { day_start: 0, dangling_at_day_end: 0, anchor_status: "CLEAN" },
        { day_start: 86_400_000, dangling_at_day_end: 1, anchor_status: "INTERRUPTED" },
      ]);
      storageDb.close();
    });

    test("re-auditing the same day overwrites the prior verdict instead of duplicating a row", () => {
      const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
      storageDb.recordOrderBookContinuityAudit({
        dayStart: 0, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
        rowsChecked: 300, danglingAtDayEnd: true, anchorStatus: "INTERRUPTED", auditedAt: 1000,
      });
      storageDb.recordOrderBookContinuityAudit({
        dayStart: 0, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
        rowsChecked: 500, danglingAtDayEnd: false, anchorStatus: "CLEAN", auditedAt: 2000,
      });
      const rows = storageDb.raw.prepare("SELECT * FROM dxfeed_order_book_continuity_audits").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rows_checked: 500, dangling_at_day_end: 0, anchor_status: "CLEAN", audited_at: 2000 });
      storageDb.close();
    });

    test("a genuine no-data day (rowsChecked 0, NO_DATA) is recorded honestly, not silently skipped", () => {
      const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
      storageDb.recordOrderBookContinuityAudit({
        dayStart: 0, symbol: "TSLA", assetClass: "EQUITY", source: "NTV",
        rowsChecked: 0, danglingAtDayEnd: false, anchorStatus: "NO_DATA", auditedAt: 1000,
      });
      const row = storageDb.raw.prepare("SELECT rows_checked, anchor_status FROM dxfeed_order_book_continuity_audits").get();
      expect(row).toEqual({ rows_checked: 0, anchor_status: "NO_DATA" });
      storageDb.close();
    });

    test("rejects a rowsChecked/anchorStatus mismatch, an invalid assetClass, and use after close", () => {
      const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
      const valid = {
        dayStart: 0, symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX",
        rowsChecked: 1, danglingAtDayEnd: false, anchorStatus: "CLEAN", auditedAt: 1000,
      };
      expect(() => storageDb.recordOrderBookContinuityAudit({ ...valid, rowsChecked: 0 }))
        .toThrow(/rowsChecked\/anchorStatus mismatch/);
      expect(() => storageDb.recordOrderBookContinuityAudit({ ...valid, anchorStatus: "NO_DATA" }))
        .toThrow(/rowsChecked\/anchorStatus mismatch/);
      expect(() => storageDb.recordOrderBookContinuityAudit({ ...valid, assetClass: "CRYPTO" })).toThrow(/assetClass/);
      expect(() => storageDb.recordOrderBookContinuityAudit({ ...valid, dayStart: 1 })).toThrow(/dayStart/);
      expect(() => storageDb.recordOrderBookContinuityAudit({ ...valid, danglingAtDayEnd: "yes" })).toThrow(/danglingAtDayEnd/);
      storageDb.close();
      expect(() => storageDb.recordOrderBookContinuityAudit(valid)).toThrow(/after close/);
    });
  });

  test("fails closed on corruption without renaming or replacing recovery evidence", () => {
    const dbPath = tempDbPath();
    const evidence = "not a real sqlite file";
    fs.writeFileSync(dbPath, evidence);
    expect(() => createDxFeedStorageDb({ dbPath })).toThrow(
      expect.objectContaining({ code: "DXFEED_STORAGE_CORRUPT_DATABASE" }),
    );
    expect(fs.readFileSync(dbPath, "utf8")).toBe(evidence);
    const quarantined = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith(path.basename(dbPath)) && name.includes(".corrupted-"));
    expect(quarantined).toEqual([]);
    safeRm(dbPath, { force: true });
  });

  test("validate-only live open rejects a missing operational index while offline bootstrap repairs it", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const tampered = new Database(dbPath);
    tampered.exec("DROP INDEX idx_dxfeed_time_and_sales_event_time");
    tampered.close();
    expect(() => createDxFeedStorageDb({ dbPath, bootstrap: false })).toThrow(/missing index idx_dxfeed_time_and_sales_event_time/);
    createDxFeedStorageDb({ dbPath, bootstrap: true }).close();
    expect(() => createDxFeedStorageDb({ dbPath, bootstrap: false }).close()).not.toThrow();
    safeRm(dbPath, { force: true });
  });

  test("a capture built before the arrival index gains it from the offline migration, and the collector refuses to write until then", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const older = new Database(dbPath);
    older.exec(`DROP INDEX ${ORDER_BOOK_ARRIVAL_INDEX}`);
    older.close();
    expect(() => createDxFeedStorageDb({ dbPath, bootstrap: false })).toThrow(new RegExp(`missing index ${ORDER_BOOK_ARRIVAL_INDEX}`));
    createDxFeedStorageDb({ dbPath, bootstrap: true }).close();
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ORDER_BOOK_ARRIVAL_INDEX).sql)
      .toBe(`CREATE INDEX ${ORDER_BOOK_ARRIVAL_INDEX} ON dxfeed_order_book_capture(symbol, asset_class, source)`);
    expect(reopened.prepare("SELECT version FROM dxfeed_storage_schema").get().version).toBe(SCHEMA_VERSION);
    reopened.close();
    expect(() => createDxFeedStorageDb({ dbPath, bootstrap: false }).close()).not.toThrow();
    safeRm(dbPath, { force: true });
  });

  test("generic Order storage permits documented zero-price TRADE/BUST actions only", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "TRADE", price: 0 });
    storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "BUST", price: 0 });
    expect(() => storageDb.insert("dxfeed_order_book_capture", { ...VALID_ORDER_BOOK_CAPTURE, action: "NEW", price: 0 })).toThrow();
    storageDb.close();
  });

  test("validate-only open rejects an old schema and offline integrity verification accepts a current file", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath, bootstrap: true });
    storageDb.close();
    expect(verifyDxFeedStorageIntegrity({ dbPath })).toEqual({ schemaVersion: SCHEMA_VERSION, integrity: "ok" });
    const raw = new Database(dbPath);
    raw.prepare("UPDATE dxfeed_storage_schema SET version = 12").run();
    raw.close();
    expect(() => createDxFeedStorageDb({ dbPath, bootstrap: false })).toThrow(/offline dxFeed schema migration/);
    safeRm(dbPath, { force: true });
  });
});
