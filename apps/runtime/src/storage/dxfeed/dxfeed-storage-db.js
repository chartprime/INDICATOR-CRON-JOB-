const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { dataRoot } = require("../../platform/runtime-paths");


const DEFAULT_DB_PATH = path.join(dataRoot(), "live", "dxfeed-market-data.sqlite");
const SCHEMA_VERSION = 22;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_SIZE_LIMIT_BYTES = 256 * 1024 * 1024;
const CANDLE_INTERVAL_MS = 60_000;
const MAX_INDEX_STRING_LENGTH = 20;
const ORDER_BOOK_ARRIVAL_INDEX = "idx_dxfeed_order_book_capture_arrival";
const TABLES = Object.freeze([
  "dxfeed_quotes", "dxfeed_trades", "dxfeed_time_and_sales", "dxfeed_candles",
  "dxfeed_order_book_capture",
]);
const REQUIRED_COLUMNS = Object.freeze({
  dxfeed_storage_schema: ["version"],
  dxfeed_capture_sessions: ["session_id", "started_at", "ended_at", "quality", "clean_shutdown", "termination_reason"],
  dxfeed_quotes: [
    "id", "event_time", "received_at", "provider", "venue", "asset_class", "symbol", "stale",
    "recovery_state", "bid_price", "bid_size", "bid_time", "bid_exchange_code", "ask_price",
    "ask_size", "ask_time", "ask_exchange_code",
  ],
  dxfeed_trades: [
    "id", "event_time", "received_at", "provider", "venue", "asset_class", "symbol", "stale",
    "recovery_state", "price", "size", "time", "exchange_code", "change", "day_volume",
    "day_turnover", "tick_direction", "extended_trading_hours",
  ],
  dxfeed_time_and_sales: [
    "id", "event_time", "received_at", "provider", "venue", "asset_class", "symbol", "stale",
    "recovery_state", "price", "size", "time", "time_nano_part", "sequence", "exchange_code",
    "extended_trading_hours", "aggressor_side", "spread_leg", "valid_tick", "event_kind",
    "provider_index", "provider_trade_id", "bid_price", "ask_price",
    "baseline_log_median", "baseline_log_mad", "baseline_sample_count",
  ],
  dxfeed_candles: [
    "id", "ts_open", "provider", "venue", "asset_class", "symbol", "open", "high", "low",
    "close", "volume", "buy_volume", "sell_volume", "trade_count", "derivation",
  ],
  dxfeed_order_book_capture: [
    "id", "event_time", "received_at", "provider", "venue", "asset_class", "symbol", "stale",
    "recovery_state", "order_index", "event_flags", "time", "action", "action_time", "order_id",
    "price", "size", "side", "scope", "source", "market_maker",
  ],
  dxfeed_order_book_continuity_audits: [
    "day_start", "symbol", "asset_class", "source", "rows_checked", "dangling_at_day_end",
    "anchor_status", "audited_at",
  ],
});
const INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "idx_dxfeed_capture_sessions_started_at", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_capture_sessions_started_at ON dxfeed_capture_sessions(started_at);" }),
  Object.freeze({ name: "idx_dxfeed_quotes_symbol_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_quotes_symbol_time ON dxfeed_quotes(symbol, asset_class, event_time);" }),
  Object.freeze({ name: "idx_dxfeed_quotes_event_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_quotes_event_time ON dxfeed_quotes(event_time);" }),
  Object.freeze({ name: "idx_dxfeed_trades_symbol_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_trades_symbol_time ON dxfeed_trades(symbol, asset_class, event_time);" }),
  Object.freeze({ name: "idx_dxfeed_trades_event_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_trades_event_time ON dxfeed_trades(event_time);" }),
  Object.freeze({ name: "idx_dxfeed_time_and_sales_symbol_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_time_and_sales_symbol_time ON dxfeed_time_and_sales(symbol, asset_class, event_time);" }),
  Object.freeze({ name: "idx_dxfeed_time_and_sales_event_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_time_and_sales_event_time ON dxfeed_time_and_sales(event_time);" }),
  Object.freeze({ name: "idx_dxfeed_time_and_sales_vpin_covering", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_time_and_sales_vpin_covering ON dxfeed_time_and_sales(symbol, asset_class, event_time, event_kind, valid_tick, aggressor_side, price, size);" }),
  Object.freeze({ name: "idx_dxfeed_candles_symbol_ts", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_candles_symbol_ts ON dxfeed_candles(symbol, asset_class, ts_open);" }),
  Object.freeze({ name: "idx_dxfeed_candles_ts_open", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_candles_ts_open ON dxfeed_candles(ts_open);" }),
  Object.freeze({ name: "idx_dxfeed_candles_identity_minute", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_dxfeed_candles_identity_minute ON dxfeed_candles(symbol, asset_class, ts_open);" }),
  Object.freeze({ name: "idx_dxfeed_order_book_capture_symbol_index", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_order_book_capture_symbol_index ON dxfeed_order_book_capture(symbol, asset_class, order_index);" }),
  Object.freeze({ name: "idx_dxfeed_order_book_capture_symbol_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_order_book_capture_symbol_time ON dxfeed_order_book_capture(symbol, asset_class, event_time);" }),
  Object.freeze({ name: "idx_dxfeed_order_book_capture_event_time", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_order_book_capture_event_time ON dxfeed_order_book_capture(event_time);" }),
  Object.freeze({ name: "idx_dxfeed_order_book_capture_replay", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_order_book_capture_replay ON dxfeed_order_book_capture(symbol, asset_class, source, event_time, id);" }),
  Object.freeze({ name: ORDER_BOOK_ARRIVAL_INDEX, sql: `CREATE INDEX IF NOT EXISTS ${ORDER_BOOK_ARRIVAL_INDEX} ON dxfeed_order_book_capture(symbol, asset_class, source);` }),
  Object.freeze({ name: "idx_dxfeed_order_book_continuity_audits_pair_day", sql: "CREATE INDEX IF NOT EXISTS idx_dxfeed_order_book_continuity_audits_pair_day ON dxfeed_order_book_continuity_audits(symbol, asset_class, source, day_start);" }),
]);

const REQUIRED_INDEXES = Object.freeze(INDEX_DEFINITIONS.map((index) => index.name));

const ENVELOPE_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time INTEGER NOT NULL CHECK (event_time > 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  provider TEXT NOT NULL CHECK (provider = 'DXFEED'),
  venue TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
  symbol TEXT NOT NULL CHECK (symbol <> ''),
  stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
  recovery_state TEXT NOT NULL CHECK (recovery_state IN ('READY', 'RECOVERING', 'UNAVAILABLE'))
`;

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dxfeed_storage_schema (
  version INTEGER NOT NULL CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS dxfeed_capture_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id <> ''),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  quality TEXT NOT NULL CHECK (quality IN ('HEALTHY', 'DEGRADED', 'INVALID')),
  clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
  termination_reason TEXT
);

CREATE TABLE IF NOT EXISTS dxfeed_quotes (
  ${ENVELOPE_COLUMNS_SQL},
  bid_price REAL NOT NULL CHECK (bid_price > 0),
  bid_size REAL NOT NULL CHECK (bid_size >= 0),
  bid_time INTEGER NOT NULL CHECK (bid_time > 0),
  bid_exchange_code TEXT NOT NULL CHECK (bid_exchange_code <> ''),
  ask_price REAL NOT NULL CHECK (ask_price > 0),
  ask_size REAL NOT NULL CHECK (ask_size >= 0),
  ask_time INTEGER NOT NULL CHECK (ask_time > 0),
  ask_exchange_code TEXT NOT NULL CHECK (ask_exchange_code <> '')
);

CREATE TABLE IF NOT EXISTS dxfeed_trades (
  ${ENVELOPE_COLUMNS_SQL},
  price REAL NOT NULL CHECK (price > 0),
  size REAL NOT NULL CHECK (size > 0),
  time INTEGER NOT NULL CHECK (time > 0),
  exchange_code TEXT NOT NULL CHECK (exchange_code <> ''),
  change REAL NOT NULL,
  day_volume REAL NOT NULL CHECK (day_volume >= 0),
  day_turnover REAL NOT NULL CHECK (day_turnover >= 0),
  tick_direction TEXT NOT NULL CHECK (tick_direction <> ''),
  extended_trading_hours INTEGER NOT NULL CHECK (extended_trading_hours IN (0, 1))
);

CREATE TABLE IF NOT EXISTS dxfeed_time_and_sales (
  ${ENVELOPE_COLUMNS_SQL},
  price REAL NOT NULL CHECK (price > 0),
  size REAL NOT NULL CHECK (size > 0),
  time INTEGER NOT NULL CHECK (time > 0),
  time_nano_part INTEGER NOT NULL CHECK (time_nano_part >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  exchange_code TEXT NOT NULL CHECK (exchange_code <> ''),
  extended_trading_hours INTEGER NOT NULL CHECK (extended_trading_hours IN (0, 1)),
  aggressor_side TEXT NOT NULL CHECK (aggressor_side IN ('BUY', 'SELL', 'UNDEFINED')),
  spread_leg INTEGER NOT NULL CHECK (spread_leg IN (0, 1)),
  valid_tick INTEGER NOT NULL CHECK (valid_tick IN (0, 1)),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('NEW', 'CORRECTION', 'CANCEL')),
  provider_index INTEGER CHECK (provider_index IS NULL OR provider_index >= 0),
  provider_trade_id INTEGER CHECK (provider_trade_id IS NULL OR provider_trade_id >= 0),
  bid_price REAL CHECK (bid_price IS NULL OR bid_price > 0),
  ask_price REAL CHECK (ask_price IS NULL OR ask_price > 0),
  baseline_log_median REAL CHECK (baseline_log_median IS NULL OR baseline_log_median BETWEEN -100 AND 100),
  baseline_log_mad REAL CHECK (baseline_log_mad IS NULL OR baseline_log_mad >= 0),
  baseline_sample_count INTEGER CHECK (baseline_sample_count IS NULL OR baseline_sample_count >= 0)
);

CREATE TABLE IF NOT EXISTS dxfeed_candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_open INTEGER NOT NULL CHECK (ts_open >= 0 AND ts_open % ${CANDLE_INTERVAL_MS} = 0),
  provider TEXT NOT NULL CHECK (provider = 'DXFEED'),
  venue TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
  symbol TEXT NOT NULL CHECK (symbol <> ''),
  open REAL NOT NULL CHECK (open > 0),
  high REAL NOT NULL CHECK (high > 0),
  low REAL NOT NULL CHECK (low > 0),
  close REAL NOT NULL CHECK (close > 0),
  volume REAL NOT NULL CHECK (volume > 0),
  buy_volume REAL CHECK (buy_volume IS NULL OR buy_volume >= 0),
  sell_volume REAL CHECK (sell_volume IS NULL OR sell_volume >= 0),
  trade_count INTEGER NOT NULL CHECK (trade_count > 0),
  derivation TEXT NOT NULL DEFAULT 'TIME_AND_SALE' CHECK (derivation IN ('TIME_AND_SALE', 'NATIVE')),
  CHECK (buy_volume IS NULL OR sell_volume IS NULL OR buy_volume + sell_volume <= volume + 0.000001)
);

CREATE TABLE IF NOT EXISTS dxfeed_order_book_capture (
  ${ENVELOPE_COLUMNS_SQL},
  order_index TEXT NOT NULL CHECK (order_index <> '' AND order_index NOT GLOB '*[^0-9]*' AND length(order_index) <= ${MAX_INDEX_STRING_LENGTH}),
  event_flags INTEGER NOT NULL CHECK (event_flags >= 0),
  time INTEGER CHECK (time IS NULL OR time > 0),
  action TEXT CHECK (action IS NULL OR action <> ''),
  action_time INTEGER CHECK (action_time IS NULL OR action_time > 0),
  order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
  price REAL CHECK (price IS NULL OR price > 0 OR action IN ('TRADE', 'BUST')),
  size REAL CHECK (size IS NULL OR size >= 0),
  side TEXT CHECK (side IS NULL OR side <> ''),
  scope TEXT CHECK (scope IS NULL OR scope <> ''),
  source TEXT NOT NULL CHECK (source <> ''),
  market_maker TEXT,
  CHECK (
    (event_flags & 2) != 0
    OR (action IN ('TRADE', 'BUST') AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL)
    OR (time IS NOT NULL AND action IS NOT NULL AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS dxfeed_order_book_continuity_audits (
  day_start INTEGER NOT NULL CHECK (day_start >= 0 AND day_start % 86400000 = 0),
  symbol TEXT NOT NULL CHECK (symbol <> ''),
  asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
  source TEXT NOT NULL CHECK (source <> ''),
  rows_checked INTEGER NOT NULL CHECK (rows_checked >= 0),
  dangling_at_day_end INTEGER NOT NULL CHECK (dangling_at_day_end IN (0, 1)),
  anchor_status TEXT NOT NULL CHECK (anchor_status IN ('CLEAN', 'INTERRUPTED', 'NO_DATA')),
  audited_at INTEGER NOT NULL CHECK (audited_at >= 0),
  PRIMARY KEY (day_start, symbol, asset_class, source),
  CHECK ((rows_checked = 0 AND anchor_status = 'NO_DATA') OR (rows_checked > 0 AND anchor_status <> 'NO_DATA'))
);
`;

const INSERT_SQL = Object.freeze({
  dxfeed_quotes:
    "INSERT INTO dxfeed_quotes (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, bid_price, bid_size, bid_time, bid_exchange_code, ask_price, ask_size, ask_time, ask_exchange_code) " +
    "VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @bidPrice, @bidSize, @bidTime, @bidExchangeCode, @askPrice, @askSize, @askTime, @askExchangeCode)",
  dxfeed_trades:
    "INSERT INTO dxfeed_trades (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, exchange_code, change, day_volume, day_turnover, tick_direction, extended_trading_hours) " +
    "VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @price, @size, @time, @exchangeCode, @change, @dayVolume, @dayTurnover, @tickDirection, @extendedTradingHours)",
  dxfeed_time_and_sales:
    "INSERT INTO dxfeed_time_and_sales (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id, bid_price, ask_price) " +
    "VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @price, @size, @time, @timeNanoPart, @sequence, @exchangeCode, @extendedTradingHours, @aggressorSide, @spreadLeg, @validTick, @eventKind, @providerIndex, @providerTradeId, @bidPrice, @askPrice)",
  dxfeed_candles:
    "INSERT INTO dxfeed_candles (ts_open, provider, venue, asset_class, symbol, open, high, low, close, volume, buy_volume, sell_volume, trade_count, derivation) " +
    "VALUES (@tsOpen, @provider, @venue, @assetClass, @symbol, @open, @high, @low, @close, @volume, @buyVolume, @sellVolume, @tradeCount, @derivation) " +
    "ON CONFLICT(symbol, asset_class, ts_open) DO UPDATE SET " +
    "provider=excluded.provider, venue=excluded.venue, open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, " +
    "volume=excluded.volume, buy_volume=excluded.buy_volume, sell_volume=excluded.sell_volume, trade_count=excluded.trade_count, derivation=excluded.derivation " +
    "WHERE excluded.derivation = 'NATIVE' OR dxfeed_candles.derivation <> 'NATIVE'",
  dxfeed_order_book_capture:
    "INSERT INTO dxfeed_order_book_capture (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, order_index, event_flags, time, action, action_time, order_id, price, size, side, scope, source, market_maker) " +
    "VALUES (@eventTime, @receivedAt, @provider, @venue, @assetClass, @symbol, @stale, @recoveryState, @orderIndex, @eventFlags, @time, @action, @actionTime, @orderId, @price, @size, @side, @scope, @source, @marketMaker)",
});

function isCorruptionError(error) {
  return error?.code === "SQLITE_CORRUPT" || error?.code === "SQLITE_NOTADB";
}

function openRawDatabase(dbPath) {
  const db = new Database(dbPath, { timeout: DEFAULT_BUSY_TIMEOUT_MS });
  db.pragma("trusted_schema = OFF");
  db.pragma("foreign_keys = ON");
  return db;
}

function tableExists(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);
}

function schemaVersion(db) {
  if (!tableExists(db, "dxfeed_storage_schema")) return null;
  const rows = db.prepare("SELECT version FROM dxfeed_storage_schema").all();
  if (rows.length !== 1) {
    throw new Error(`dxfeed-storage-db: schema version table must contain exactly one row, found ${rows.length}`);
  }
  if (!Number.isSafeInteger(rows[0].version) || rows[0].version < 1) {
    throw new Error("dxfeed-storage-db: schema version must be a positive safe integer");
  }
  return rows[0].version;
}

function validateCurrentTables(db) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) {
      throw new Error(`dxfeed-storage-db: schema version ${SCHEMA_VERSION} is missing table ${table}`);
    }
    const actualColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (
      actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, index) => column !== expectedColumns[index])
    ) {
      throw new Error(`dxfeed-storage-db: schema version ${SCHEMA_VERSION} has an invalid ${table} layout`);
    }
  }
}

function validateCurrentSchema(db, { verifyIntegrity = false } = {}) {
  validateCurrentTables(db);
  const findIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?");
  for (const index of REQUIRED_INDEXES) {
    if (findIndex.get(index) === undefined) {
      throw new Error(`dxfeed-storage-db: schema version ${SCHEMA_VERSION} is missing index ${index}`);
    }
  }
  if (verifyIntegrity) {
    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") {
      const error = new Error(`dxfeed-storage-db: SQLite quick_check failed: ${quickCheck}`);
      error.code = "SQLITE_CORRUPT";
      throw error;
    }
  }
}

function createCurrentSchema(db) {
  db.pragma("auto_vacuum = INCREMENTAL");
  db.exec(CREATE_SCHEMA_SQL);
  db.prepare("DELETE FROM dxfeed_storage_schema").run();
  db.prepare("INSERT INTO dxfeed_storage_schema (version) VALUES (?)").run(SCHEMA_VERSION);
}

function createCurrentIndexes(db) {
  for (const index of INDEX_DEFINITIONS) db.exec(index.sql);
}

function migrateV1ToV2(db) {
  if (tableExists(db, "dxfeed_orders")) {
    db.exec(`
    CREATE TABLE dxfeed_orders_v2 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index INTEGER CHECK (order_index IS NULL OR order_index >= 0),
      time INTEGER NOT NULL CHECK (time >= 0),
      action TEXT NOT NULL CHECK (action <> ''),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL NOT NULL CHECK (price > 0),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT NOT NULL CHECK (side <> ''),
      scope TEXT NOT NULL CHECK (scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT
    );
    INSERT INTO dxfeed_orders_v2 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    FROM dxfeed_orders;
    DROP TABLE dxfeed_orders;
    ALTER TABLE dxfeed_orders_v2 RENAME TO dxfeed_orders;
    CREATE INDEX idx_dxfeed_orders_symbol_time ON dxfeed_orders(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_orders_event_time ON dxfeed_orders(event_time);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (2);
  `);
  }
}

function migrateV2ToV3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dxfeed_candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_open INTEGER NOT NULL CHECK (ts_open >= 0 AND ts_open % ${CANDLE_INTERVAL_MS} = 0),
      provider TEXT NOT NULL CHECK (provider = 'DXFEED'),
      venue TEXT,
      asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
      symbol TEXT NOT NULL CHECK (symbol <> ''),
      open REAL NOT NULL CHECK (open > 0),
      high REAL NOT NULL CHECK (high > 0),
      low REAL NOT NULL CHECK (low > 0),
      close REAL NOT NULL CHECK (close > 0),
      volume REAL NOT NULL CHECK (volume > 0),
      buy_volume REAL CHECK (buy_volume IS NULL OR buy_volume >= 0),
      trade_count INTEGER NOT NULL CHECK (trade_count > 0)
    );
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (3);
  `);
}

function migrateV3ToV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dxfeed_time_and_sales (
      ${ENVELOPE_COLUMNS_SQL},
      price REAL NOT NULL CHECK (price > 0),
      size REAL NOT NULL CHECK (size > 0),
      time INTEGER NOT NULL CHECK (time > 0),
      time_nano_part INTEGER NOT NULL CHECK (time_nano_part >= 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      exchange_code TEXT NOT NULL CHECK (exchange_code <> ''),
      extended_trading_hours INTEGER NOT NULL CHECK (extended_trading_hours IN (0, 1)),
      aggressor_side TEXT NOT NULL CHECK (aggressor_side IN ('BUY', 'SELL', 'UNDEFINED')),
      spread_leg INTEGER NOT NULL CHECK (spread_leg IN (0, 1)),
      valid_tick INTEGER NOT NULL CHECK (valid_tick IN (0, 1)),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('NEW', 'CORRECTION', 'CANCEL')),
      provider_index INTEGER CHECK (provider_index IS NULL OR provider_index >= 0),
      provider_trade_id INTEGER CHECK (provider_trade_id IS NULL OR provider_trade_id >= 0)
    );
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (4);
  `);
}

function migrateV4ToV5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dxfeed_order_book_capture (
      ${ENVELOPE_COLUMNS_SQL},
      order_index TEXT NOT NULL CHECK (order_index <> '' AND order_index NOT GLOB '*[^0-9]*' AND length(order_index) <= ${MAX_INDEX_STRING_LENGTH}),
      event_flags INTEGER NOT NULL CHECK (event_flags >= 0),
      time INTEGER NOT NULL CHECK (time >= 0),
      action TEXT NOT NULL CHECK (action <> ''),
      action_time INTEGER CHECK (action_time IS NULL OR action_time >= 0),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL NOT NULL CHECK (price > 0),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT NOT NULL CHECK (side <> ''),
      scope TEXT NOT NULL CHECK (scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT
    );
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (5);
  `);
}

function migrateV5ToV6(db) {
  db.exec(`
    CREATE TABLE dxfeed_order_book_capture_v6 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index TEXT NOT NULL CHECK (order_index <> '' AND order_index NOT GLOB '*[^0-9]*' AND length(order_index) <= ${MAX_INDEX_STRING_LENGTH}),
      event_flags INTEGER NOT NULL CHECK (event_flags >= 0),
      time INTEGER NOT NULL CHECK (time >= 0),
      action TEXT NOT NULL CHECK (action <> ''),
      action_time INTEGER CHECK (action_time IS NULL OR action_time >= 0),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL NOT NULL CHECK (price > 0 OR action IN ('TRADE', 'BUST')),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT NOT NULL CHECK (side <> ''),
      scope TEXT NOT NULL CHECK (scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT
    );
    INSERT INTO dxfeed_order_book_capture_v6 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    FROM dxfeed_order_book_capture;
    DROP TABLE dxfeed_order_book_capture;
    ALTER TABLE dxfeed_order_book_capture_v6 RENAME TO dxfeed_order_book_capture;
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_index ON dxfeed_order_book_capture(symbol, asset_class, order_index);
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_time ON dxfeed_order_book_capture(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_order_book_capture_event_time ON dxfeed_order_book_capture(event_time);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (6);
  `);
}

function migrateV6ToV7(db) {
  db.exec(`
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (7);
  `);
}

function migrateV7ToV8(db) {
  if (!columnExists(db, "dxfeed_time_and_sales", "bid_price")) {
    db.exec("ALTER TABLE dxfeed_time_and_sales ADD COLUMN bid_price REAL CHECK (bid_price IS NULL OR bid_price > 0);");
  }
  if (!columnExists(db, "dxfeed_time_and_sales", "ask_price")) {
    db.exec("ALTER TABLE dxfeed_time_and_sales ADD COLUMN ask_price REAL CHECK (ask_price IS NULL OR ask_price > 0);");
  }
  db.exec(`
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (8);
  `);
}

function migrateV8ToV9(db) {
  db.exec(`
    CREATE TABLE dxfeed_order_book_capture_v9 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index TEXT NOT NULL CHECK (order_index <> '' AND order_index NOT GLOB '*[^0-9]*' AND length(order_index) <= ${MAX_INDEX_STRING_LENGTH}),
      event_flags INTEGER NOT NULL CHECK (event_flags >= 0),
      time INTEGER CHECK (time IS NULL OR time > 0),
      action TEXT CHECK (action IS NULL OR action <> ''),
      action_time INTEGER CHECK (action_time IS NULL OR action_time > 0),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL CHECK (price IS NULL OR price > 0 OR action IN ('TRADE', 'BUST')),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT CHECK (side IS NULL OR side <> ''),
      scope TEXT CHECK (scope IS NULL OR scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT,
      CHECK ((event_flags & 2) != 0 OR (time IS NOT NULL AND action IS NOT NULL AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL))
    );
    INSERT INTO dxfeed_order_book_capture_v9 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    FROM dxfeed_order_book_capture;
    DROP TABLE dxfeed_order_book_capture;
    ALTER TABLE dxfeed_order_book_capture_v9 RENAME TO dxfeed_order_book_capture;
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_index ON dxfeed_order_book_capture(symbol, asset_class, order_index);
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_time ON dxfeed_order_book_capture(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_order_book_capture_event_time ON dxfeed_order_book_capture(event_time);
    CREATE INDEX idx_dxfeed_order_book_capture_replay ON dxfeed_order_book_capture(symbol, asset_class, source, event_time, id);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (9);
  `);
}

function migrateV9ToV10(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dxfeed_capture_sessions (
      session_id TEXT PRIMARY KEY CHECK (session_id <> ''),
      started_at INTEGER NOT NULL CHECK (started_at > 0),
      ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
      quality TEXT NOT NULL CHECK (quality IN ('HEALTHY', 'DEGRADED', 'INVALID')),
      clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
      termination_reason TEXT
    );
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (10);
  `);
}

function migrateV10ToV11(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dxfeed_order_book_continuity_audits (
      day_start INTEGER NOT NULL CHECK (day_start >= 0 AND day_start % 86400000 = 0),
      symbol TEXT NOT NULL CHECK (symbol <> ''),
      asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
      source TEXT NOT NULL CHECK (source <> ''),
      rows_checked INTEGER NOT NULL CHECK (rows_checked >= 0),
      dangling_at_day_end INTEGER NOT NULL CHECK (dangling_at_day_end IN (0, 1)),
      anchor_status TEXT NOT NULL CHECK (anchor_status IN ('CLEAN', 'INTERRUPTED', 'NO_DATA')),
      audited_at INTEGER NOT NULL CHECK (audited_at >= 0),
      PRIMARY KEY (day_start, symbol, asset_class, source),
      CHECK ((rows_checked = 0 AND anchor_status = 'NO_DATA') OR (rows_checked > 0 AND anchor_status <> 'NO_DATA'))
    );
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (11);
  `);
}

function migrateV11ToV12(db) {
  if (!columnExists(db, "dxfeed_time_and_sales", "baseline_log_median")) {
    db.exec("ALTER TABLE dxfeed_time_and_sales ADD COLUMN baseline_log_median REAL CHECK (baseline_log_median IS NULL OR baseline_log_median BETWEEN -100 AND 100);");
  }
  if (!columnExists(db, "dxfeed_time_and_sales", "baseline_log_mad")) {
    db.exec("ALTER TABLE dxfeed_time_and_sales ADD COLUMN baseline_log_mad REAL CHECK (baseline_log_mad IS NULL OR baseline_log_mad >= 0);");
  }
  db.exec("DELETE FROM dxfeed_storage_schema; INSERT INTO dxfeed_storage_schema (version) VALUES (12);");
}

function migrateV12ToV13(db) {
  if (!columnExists(db, "dxfeed_time_and_sales", "baseline_sample_count")) {
    db.exec("ALTER TABLE dxfeed_time_and_sales ADD COLUMN baseline_sample_count INTEGER CHECK (baseline_sample_count IS NULL OR baseline_sample_count >= 0);");
  }
  db.exec("DROP INDEX IF EXISTS idx_dxfeed_time_and_sales_large_trade_z_score;");
  db.exec("DELETE FROM dxfeed_storage_schema; INSERT INTO dxfeed_storage_schema (version) VALUES (13);");
  migrateV13ToV14(db);
}

function migrateV13ToV14(db) {
  if (tableExists(db, "dxfeed_orders")) {
    db.exec(`
    CREATE TABLE dxfeed_orders_v14 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index INTEGER CHECK (order_index IS NULL OR order_index >= 0),
      time INTEGER NOT NULL CHECK (time > 0),
      action TEXT NOT NULL CHECK (action <> ''),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL NOT NULL CHECK (price > 0 OR action IN ('TRADE', 'BUST')),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT NOT NULL CHECK (side <> ''),
      scope TEXT NOT NULL CHECK (scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT
    );
    INSERT INTO dxfeed_orders_v14 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    FROM dxfeed_orders;
    DROP TABLE dxfeed_orders;
    ALTER TABLE dxfeed_orders_v14 RENAME TO dxfeed_orders;
    CREATE INDEX idx_dxfeed_orders_symbol_time ON dxfeed_orders(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_orders_event_time ON dxfeed_orders(event_time);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (14);
  `);
  }
  migrateV14ToV15(db);
}

function migrateV14ToV15(db) {
  db.exec(`
    CREATE TABLE dxfeed_order_book_capture_v15 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index TEXT NOT NULL CHECK (order_index <> '' AND order_index NOT GLOB '*[^0-9]*' AND length(order_index) <= ${MAX_INDEX_STRING_LENGTH}),
      event_flags INTEGER NOT NULL CHECK (event_flags >= 0),
      time INTEGER CHECK (time IS NULL OR time > 0),
      action TEXT CHECK (action IS NULL OR action <> ''),
      action_time INTEGER CHECK (action_time IS NULL OR action_time > 0),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL CHECK (price IS NULL OR price > 0 OR action IN ('TRADE', 'BUST')),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT CHECK (side IS NULL OR side <> ''),
      scope TEXT CHECK (scope IS NULL OR scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT,
      CHECK (
        (event_flags & 2) != 0
        OR (action IN ('TRADE', 'BUST') AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL)
        OR (time IS NOT NULL AND action IS NOT NULL AND price IS NOT NULL AND side IS NOT NULL AND scope IS NOT NULL)
      )
    );
    INSERT INTO dxfeed_order_book_capture_v15 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, event_flags, time, action, action_time, order_id, price, size, side, scope,
      source, market_maker
    FROM dxfeed_order_book_capture;
    DROP TABLE dxfeed_order_book_capture;
    ALTER TABLE dxfeed_order_book_capture_v15 RENAME TO dxfeed_order_book_capture;
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_index ON dxfeed_order_book_capture(symbol, asset_class, order_index);
    CREATE INDEX idx_dxfeed_order_book_capture_symbol_time ON dxfeed_order_book_capture(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_order_book_capture_event_time ON dxfeed_order_book_capture(event_time);
    CREATE INDEX idx_dxfeed_order_book_capture_replay ON dxfeed_order_book_capture(symbol, asset_class, source, event_time, id);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (15);
  `);
  migrateV15ToV16(db);
}

function migrateV15ToV16(db) {
  if (tableExists(db, "dxfeed_orders")) {
    db.exec(`
    CREATE TABLE dxfeed_orders_v16 (
      ${ENVELOPE_COLUMNS_SQL},
      order_index INTEGER CHECK (order_index IS NULL OR order_index >= 0),
      time INTEGER CHECK (time IS NULL OR time > 0),
      action TEXT NOT NULL CHECK (action <> ''),
      order_id INTEGER CHECK (order_id IS NULL OR order_id >= 0),
      price REAL NOT NULL CHECK (price > 0 OR action IN ('TRADE', 'BUST')),
      size REAL CHECK (size IS NULL OR size >= 0),
      side TEXT NOT NULL CHECK (side <> ''),
      scope TEXT NOT NULL CHECK (scope <> ''),
      source TEXT NOT NULL CHECK (source <> ''),
      market_maker TEXT,
      CHECK (time IS NOT NULL OR action IN ('TRADE', 'BUST'))
    );
    INSERT INTO dxfeed_orders_v16 (
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    ) SELECT
      id, event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state,
      order_index, time, action, order_id, price, size, side, scope, source, market_maker
    FROM dxfeed_orders;
    DROP TABLE dxfeed_orders;
    ALTER TABLE dxfeed_orders_v16 RENAME TO dxfeed_orders;
    CREATE INDEX idx_dxfeed_orders_symbol_time ON dxfeed_orders(symbol, asset_class, event_time);
    CREATE INDEX idx_dxfeed_orders_event_time ON dxfeed_orders(event_time);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (16);
  `);
  }
  migrateV16ToV17(db);
}

function migrateV16ToV17(db) {
  db.exec(`
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (17);
  `);
  migrateV17ToV18(db);
}

function migrateV17ToV18(db) {
  db.exec(`
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (18);
  `);
  migrateV18ToV19(db);
}

function migrateV19ToV20(db) {
  db.exec(`
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (20);
  `);
  migrateV20ToV21(db);
}

function migrateV20ToV21(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_dxfeed_orders_symbol_time;
    DROP INDEX IF EXISTS idx_dxfeed_orders_event_time;
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (21);
  `);
  migrateV21ToV22(db);
}

function migrateV21ToV22(db) {
  const hasDerivation = columnExists(db, "dxfeed_candles", "derivation");
  const hasSellVolume = columnExists(db, "dxfeed_candles", "sell_volume");
  db.exec(`
    DROP INDEX IF EXISTS idx_dxfeed_candles_symbol_ts;
    DROP INDEX IF EXISTS idx_dxfeed_candles_ts_open;
    DROP INDEX IF EXISTS idx_dxfeed_candles_identity_minute;
    CREATE TABLE dxfeed_candles_v22 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_open INTEGER NOT NULL CHECK (ts_open >= 0 AND ts_open % ${CANDLE_INTERVAL_MS} = 0),
      provider TEXT NOT NULL CHECK (provider = 'DXFEED'),
      venue TEXT,
      asset_class TEXT NOT NULL CHECK (asset_class IN ('FUTURE', 'EQUITY')),
      symbol TEXT NOT NULL CHECK (symbol <> ''),
      open REAL NOT NULL CHECK (open > 0),
      high REAL NOT NULL CHECK (high > 0),
      low REAL NOT NULL CHECK (low > 0),
      close REAL NOT NULL CHECK (close > 0),
      volume REAL NOT NULL CHECK (volume > 0),
      buy_volume REAL CHECK (buy_volume IS NULL OR buy_volume >= 0),
      sell_volume REAL CHECK (sell_volume IS NULL OR sell_volume >= 0),
      trade_count INTEGER NOT NULL CHECK (trade_count > 0),
      derivation TEXT NOT NULL DEFAULT 'TIME_AND_SALE' CHECK (derivation IN ('TIME_AND_SALE', 'NATIVE')),
      CHECK (buy_volume IS NULL OR sell_volume IS NULL OR buy_volume + sell_volume <= volume + 0.000001)
    );
    INSERT INTO dxfeed_candles_v22 (
      id, ts_open, provider, venue, asset_class, symbol, open, high, low, close,
      volume, buy_volume, sell_volume, trade_count, derivation
    )
    SELECT
      id, ts_open, provider, venue, asset_class, symbol, open, high, low, close,
      volume, buy_volume, ${hasSellVolume ? "sell_volume" : "NULL"}, trade_count,
      ${hasDerivation ? "derivation" : "'TIME_AND_SALE'"}
    FROM dxfeed_candles
    WHERE id IN (SELECT MAX(id) FROM dxfeed_candles GROUP BY symbol, asset_class, ts_open);
    DROP TABLE dxfeed_candles;
    ALTER TABLE dxfeed_candles_v22 RENAME TO dxfeed_candles;
    CREATE UNIQUE INDEX idx_dxfeed_candles_identity_minute
      ON dxfeed_candles(symbol, asset_class, ts_open);
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (22);
  `);
}

function migrateV18ToV19(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_dxfeed_time_and_sales_large_trade_z_score;
    DROP INDEX IF EXISTS idx_dxfeed_time_and_sales_futures_fixed_floor;
    DROP INDEX IF EXISTS idx_dxfeed_time_and_sales_equity_fixed_floor;
    DELETE FROM dxfeed_storage_schema;
    INSERT INTO dxfeed_storage_schema (version) VALUES (19);
  `);
  migrateV19ToV20(db);
}

const MIGRATION_STEPS = Object.freeze({
  1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4, 4: migrateV4ToV5,
  5: migrateV5ToV6, 6: migrateV6ToV7, 7: migrateV7ToV8, 8: migrateV8ToV9,
  9: migrateV9ToV10, 10: migrateV10ToV11, 11: migrateV11ToV12, 12: migrateV12ToV13,
  13: migrateV13ToV14, 14: migrateV14ToV15, 15: migrateV15ToV16, 16: migrateV16ToV17,
  17: migrateV17ToV18, 18: migrateV18ToV19, 19: migrateV19ToV20,
  20: migrateV20ToV21, 21: migrateV21ToV22,
});

function initializeSchema(db, { verifyIntegrity = false } = {}) {
  const version = schemaVersion(db);
  if (version !== SCHEMA_VERSION) {
    db.transaction(() => {
      if (version === null && TABLES.every((table) => !tableExists(db, table))) {
        createCurrentSchema(db);
        return;
      }
      if (version === 1) {
        migrateV1ToV2(db);
        migrateV2ToV3(db);
        migrateV3ToV4(db);
        migrateV4ToV5(db);
        migrateV5ToV6(db);
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 2) {
        migrateV2ToV3(db);
        migrateV3ToV4(db);
        migrateV4ToV5(db);
        migrateV5ToV6(db);
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 3) {
        migrateV3ToV4(db);
        migrateV4ToV5(db);
        migrateV5ToV6(db);
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 4) {
        migrateV4ToV5(db);
        migrateV5ToV6(db);
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 5) {
        migrateV5ToV6(db);
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 6) {
        migrateV6ToV7(db);
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 7) {
        migrateV7ToV8(db);
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 8) {
        migrateV8ToV9(db);
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 9) {
        migrateV9ToV10(db);
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 10) {
        migrateV10ToV11(db);
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 11) {
        migrateV11ToV12(db);
        migrateV12ToV13(db);
        return;
      }
      if (version === 12) {
        migrateV12ToV13(db);
        return;
      }
      if (version === 13) {
        migrateV13ToV14(db);
        return;
      }
      if (version === 14) {
        migrateV14ToV15(db);
        return;
      }
      if (version === 15) {
        migrateV15ToV16(db);
        return;
      }
      if (version === 16) {
        migrateV16ToV17(db);
        return;
      }
      if (version === 20) {
        migrateV20ToV21(db);
        return;
      }
      if (version === 21) {
        migrateV21ToV22(db);
        return;
      }
      if (version === 19) {
        migrateV19ToV20(db);
        return;
      }
      if (version === 18) {
        migrateV18ToV19(db);
        return;
      }
      if (version === 17) {
        migrateV17ToV18(db);
        return;
      }
      throw new Error(`dxfeed-storage-db: unsupported schema version ${String(version)}`);
    })();
    const migratedVersion = schemaVersion(db);
    if (migratedVersion !== SCHEMA_VERSION) {
      throw new Error(
        `dxfeed-storage-db: migration from schema version ${String(version)} stopped at ${String(migratedVersion)} instead of ${SCHEMA_VERSION}`,
      );
    }
  }
  validateCurrentTables(db);
  createCurrentIndexes(db);
  validateCurrentSchema(db, { verifyIntegrity });
}

function configureConnection(db, { writable }) {
  if (writable) {
    db.pragma("journal_mode = WAL");
    db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  }
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
}

function openDatabase(dbPath, { bootstrap = true, verifyIntegrity = false, readonly = false } = {}) {
  if (dbPath !== ":memory:") {
    if (!readonly && bootstrap) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  let db;
  try {
    db = readonly
      ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: DEFAULT_BUSY_TIMEOUT_MS })
      : !bootstrap && dbPath !== ":memory:"
        ? new Database(dbPath, { fileMustExist: true, timeout: DEFAULT_BUSY_TIMEOUT_MS })
        : openRawDatabase(dbPath);
    if (bootstrap) {
      initializeSchema(db, { verifyIntegrity });
    } else {
      const version = schemaVersion(db);
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `dxfeed-storage-db: writer requires schema version ${SCHEMA_VERSION}, found ${String(version)}; run the offline dxFeed schema migration`,
        );
      }
      validateCurrentSchema(db, { verifyIntegrity });
    }
    configureConnection(db, { writable: !readonly });
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      void 0;
    }
    if (readonly || dbPath === ":memory:" || !isCorruptionError(error)) {
      throw error;
    }
    const corruptionError = new Error(
      `dxfeed-storage-db: database at ${dbPath} appears corrupt; collector halted without modifying recovery evidence`,
      { cause: error },
    );
    corruptionError.code = "DXFEED_STORAGE_CORRUPT_DATABASE";
    throw corruptionError;
  }
}

function assertKnownTable(table) {
  if (!Object.hasOwn(INSERT_SQL, table)) {
    throw new Error(`dxfeed-storage-db: unsupported table "${String(table)}"`);
  }
}

function createDxFeedStorageDb({ dbPath, bootstrap = true, verifyIntegrity = false, readonly = false } = {}) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new Error("dxfeed-storage-db: dbPath must be a non-empty string");
  }
  if (typeof bootstrap !== "boolean" || typeof verifyIntegrity !== "boolean" || typeof readonly !== "boolean") {
    throw new Error("dxfeed-storage-db: bootstrap, verifyIntegrity, and readonly must be booleans");
  }
  if (readonly && (dbPath === ":memory:" || bootstrap)) {
    throw new Error("dxfeed-storage-db: readonly mode requires a file-backed, validate-only database");
  }
  const db = openDatabase(dbPath, { bootstrap, verifyIntegrity, readonly });
  let insertStatements;
  try {
    insertStatements = Object.fromEntries(
      Object.entries(INSERT_SQL).map(([table, sql]) => [table, db.prepare(sql)]),
    );
  } catch (error) {
    try {
      db.close();
    } catch {
      void 0;
    }
    throw error;
  }
  let closed = false;

  const beginCaptureSessionTransaction = db.transaction(({ sessionId, startedAt }) => {
    db.prepare(
      "UPDATE dxfeed_capture_sessions SET ended_at = ?, quality = 'INVALID', clean_shutdown = 0, termination_reason = 'UNCLEAN_PREVIOUS_PROCESS_EXIT' WHERE ended_at IS NULL",
    ).run(startedAt);
    db.prepare(
      "INSERT INTO dxfeed_capture_sessions (session_id, started_at, quality, clean_shutdown) VALUES (?, ?, 'HEALTHY', 0)",
    ).run(sessionId, startedAt);
  });

  function insert(table, record) {
    assertKnownTable(table);
    if (closed) throw new Error("dxfeed-storage-db: cannot write after close");
    return insertStatements[table].run(
      table === "dxfeed_candles" && record?.derivation === undefined
        ? { ...record, derivation: "TIME_AND_SALE", sellVolume: record.sellVolume ?? null }
        : table === "dxfeed_candles" && record?.sellVolume === undefined
          ? { ...record, sellVolume: null }
        : record,
    );
  }

  function transaction(work) {
    if (closed) throw new Error("dxfeed-storage-db: cannot transact after close");
    if (typeof work !== "function") throw new Error("dxfeed-storage-db: transaction work must be a function");
    return db.transaction(work)();
  }

  function beginCaptureSession({ sessionId, startedAt }) {
    if (closed) throw new Error("dxfeed-storage-db: cannot begin a capture session after close");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("dxfeed-storage-db: capture sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new Error("dxfeed-storage-db: capture startedAt must be a positive safe integer");
    }
    beginCaptureSessionTransaction({ sessionId, startedAt });
  }

  function getCaptureResumeState() {
    if (closed) throw new Error("dxfeed-storage-db: cannot read after close");
    const priorSession = db.prepare(
      "SELECT ended_at, clean_shutdown, quality FROM dxfeed_capture_sessions ORDER BY started_at DESC LIMIT 1",
    ).get();
    const data = db.prepare(
      "SELECT EXISTS(SELECT 1 FROM dxfeed_quotes LIMIT 1) OR EXISTS(SELECT 1 FROM dxfeed_trades LIMIT 1) OR " +
      "EXISTS(SELECT 1 FROM dxfeed_time_and_sales LIMIT 1) OR " +
      "EXISTS(SELECT 1 FROM dxfeed_candles LIMIT 1) OR EXISTS(SELECT 1 FROM dxfeed_order_book_capture LIMIT 1) AS has_data",
    ).get();
    return Object.freeze({
      hasExistingData: data?.has_data === 1,
      previousSessionEndedAt: Number.isSafeInteger(priorSession?.ended_at) ? priorSession.ended_at : null,
      previousSessionCleanShutdown: priorSession?.clean_shutdown === 1
        ? true
        : priorSession?.clean_shutdown === 0
          ? false
          : null,
      previousSessionQuality: typeof priorSession?.quality === "string" ? priorSession.quality : null,
    });
  }

  function finishCaptureSession({ sessionId, endedAt, quality, cleanShutdown, terminationReason = null }) {
    if (closed) throw new Error("dxfeed-storage-db: cannot finish a capture session after close");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("dxfeed-storage-db: capture sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(endedAt) || endedAt <= 0) {
      throw new Error("dxfeed-storage-db: capture endedAt must be a positive safe integer");
    }
    if (!["HEALTHY", "DEGRADED", "INVALID"].includes(quality) || typeof cleanShutdown !== "boolean") {
      throw new Error("dxfeed-storage-db: capture outcome is invalid");
    }
    const result = db.prepare(
      "UPDATE dxfeed_capture_sessions SET ended_at = ?, quality = ?, clean_shutdown = ?, termination_reason = ? WHERE session_id = ? AND ended_at IS NULL",
    ).run(endedAt, quality, cleanShutdown ? 1 : 0, terminationReason, sessionId);
    if (result.changes !== 1) throw new Error("dxfeed-storage-db: active capture session was not found");
  }

  function recordOrderBookContinuityAudit({
    dayStart, symbol, assetClass, source, rowsChecked, danglingAtDayEnd, anchorStatus, auditedAt,
  }) {
    if (closed) throw new Error("dxfeed-storage-db: cannot write after close");
    if (!Number.isSafeInteger(dayStart) || dayStart < 0 || dayStart % (24 * 60 * 60 * 1000) !== 0) {
      throw new Error("dxfeed-storage-db: dayStart must be a UTC day-start safe integer");
    }
    if (typeof symbol !== "string" || symbol.length === 0) {
      throw new Error("dxfeed-storage-db: order-book continuity symbol is invalid");
    }
    if (!["FUTURE", "EQUITY"].includes(assetClass)) {
      throw new Error("dxfeed-storage-db: order-book continuity assetClass is invalid");
    }
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("dxfeed-storage-db: order-book continuity source is invalid");
    }
    if (!Number.isSafeInteger(rowsChecked) || rowsChecked < 0) {
      throw new Error("dxfeed-storage-db: order-book continuity rowsChecked is invalid");
    }
    if (typeof danglingAtDayEnd !== "boolean") {
      throw new Error("dxfeed-storage-db: order-book continuity danglingAtDayEnd must be a boolean");
    }
    if (!["CLEAN", "INTERRUPTED", "NO_DATA"].includes(anchorStatus)) {
      throw new Error("dxfeed-storage-db: order-book continuity anchorStatus is invalid");
    }
    if (!Number.isSafeInteger(auditedAt) || auditedAt < 0) {
      throw new Error("dxfeed-storage-db: order-book continuity auditedAt is invalid");
    }
    const noRows = rowsChecked === 0;
    if (noRows !== (anchorStatus === "NO_DATA")) {
      throw new Error("dxfeed-storage-db: order-book continuity rowsChecked/anchorStatus mismatch");
    }
    db.prepare(
      "INSERT INTO dxfeed_order_book_continuity_audits " +
      "(day_start, symbol, asset_class, source, rows_checked, dangling_at_day_end, anchor_status, audited_at) " +
      "VALUES (@dayStart, @symbol, @assetClass, @source, @rowsChecked, @danglingAtDayEnd, @anchorStatus, @auditedAt) " +
      "ON CONFLICT(day_start, symbol, asset_class, source) DO UPDATE SET " +
      "rows_checked = excluded.rows_checked, dangling_at_day_end = excluded.dangling_at_day_end, " +
      "anchor_status = excluded.anchor_status, audited_at = excluded.audited_at",
    ).run({
      dayStart, symbol, assetClass, source, rowsChecked,
      danglingAtDayEnd: danglingAtDayEnd ? 1 : 0, anchorStatus, auditedAt,
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return Object.freeze({
    insert, transaction, beginCaptureSession, getCaptureResumeState, finishCaptureSession,
    recordOrderBookContinuityAudit, close, raw: db,
  });
}

function verifyDxFeedStorageIntegrity({ dbPath }) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0 || dbPath === ":memory:") {
    throw new Error("dxfeed-storage-db: integrity verification requires a file-backed database path");
  }
  const db = openDatabase(dbPath, { bootstrap: false, verifyIntegrity: true, readonly: true });
  try {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, integrity: "ok" });
  } finally {
    db.close();
  }
}

module.exports = {
  ORDER_BOOK_ARRIVAL_INDEX,
  REQUIRED_INDEXES,
  createDxFeedStorageDb,
  verifyDxFeedStorageIntegrity,
  DEFAULT_DB_PATH,
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  TABLES,
  MIGRATION_STEPS,
};
