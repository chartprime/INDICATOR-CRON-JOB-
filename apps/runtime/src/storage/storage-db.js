const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { MAX_DECIMAL_STRING_LENGTH } = require("../providers/binance/binance-event-normalizer");
const { dataRoot } = require("../platform/runtime-paths");


const DEFAULT_DB_PATH = path.join(dataRoot(), "live", "market-data.sqlite");
const SCHEMA_VERSION = 16;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_SIZE_LIMIT_BYTES = 256 * 1024 * 1024;
const TABLES = Object.freeze(["trades", "candles", "l2_depth_events", "l2_depth_snapshots"]);
const LEGACY_V1_TABLES = Object.freeze(["trades", "candles", "l2_depth_events"]);
const REQUIRED_COLUMNS = Object.freeze({
  storage_schema: ["version"],
  trades: ["id", "ts", "symbol", "market_kind", "price", "size", "side", "trade_id", "baseline_log_median", "baseline_log_mad", "baseline_sample_count"],
  candles: ["id", "ts_open", "symbol", "market_kind", "open", "high", "low", "close", "volume", "quote_volume", "trade_count", "taker_buy_base_volume", "taker_buy_quote_volume"],
  l2_depth_events: ["id", "ts", "received_at", "symbol", "market_kind", "first_update_id", "last_update_id", "previous_update_id", "bids", "asks"],
  l2_depth_snapshots: ["id", "captured_at", "symbol", "market_kind", "last_update_id", "bids", "asks"],
  capture_sessions: ["session_id", "started_at", "ended_at", "quality", "clean_shutdown", "termination_reason"],
  capture_incidents: ["id", "session_id", "ts", "severity", "event", "market_kind", "route", "symbol", "event_type", "affected_count", "details"],
  depth_continuity_audits: ["day_start", "symbol", "market_kind", "first_update_id", "last_update_id", "rows_checked", "gaps_detected", "anchor_status", "audited_at"],
  daily_notional_rollup: ["symbol", "market_kind", "day_bucket", "notional"],
  daily_notional_rollup_watermark: ["symbol", "market_kind", "last_trade_id", "updated_at"],
});
const INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "idx_trades_symbol_market_ts", sql: "CREATE INDEX IF NOT EXISTS idx_trades_symbol_market_ts ON trades(symbol, market_kind, ts);" }),
  Object.freeze({ name: "idx_trades_symbol_market_id", sql: "CREATE INDEX IF NOT EXISTS idx_trades_symbol_market_id ON trades(symbol, market_kind, id);" }),
  Object.freeze({ name: "idx_trades_notional", sql: "CREATE INDEX IF NOT EXISTS idx_trades_notional ON trades(symbol, market_kind, (CAST(price AS REAL) * CAST(size AS REAL)));" }),
  Object.freeze({ name: "idx_trades_ts", sql: "CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);" }),
  Object.freeze({ name: "idx_trades_vpin_covering", sql: "CREATE INDEX IF NOT EXISTS idx_trades_vpin_covering ON trades(symbol, market_kind, ts, side, price, size);" }),
  Object.freeze({ name: "idx_candles_symbol_market_ts", sql: "CREATE INDEX IF NOT EXISTS idx_candles_symbol_market_ts ON candles(symbol, market_kind, ts_open);" }),
  Object.freeze({ name: "idx_candles_ts_open", sql: "CREATE INDEX IF NOT EXISTS idx_candles_ts_open ON candles(ts_open);" }),
  Object.freeze({ name: "idx_l2_depth_events_symbol_market_ts", sql: "CREATE INDEX IF NOT EXISTS idx_l2_depth_events_symbol_market_ts ON l2_depth_events(symbol, market_kind, ts);" }),
  Object.freeze({ name: "idx_l2_depth_events_symbol_market_id", sql: "CREATE INDEX IF NOT EXISTS idx_l2_depth_events_symbol_market_id ON l2_depth_events(symbol, market_kind, id);" }),
  Object.freeze({ name: "idx_l2_depth_events_ts", sql: "CREATE INDEX IF NOT EXISTS idx_l2_depth_events_ts ON l2_depth_events(ts);" }),
  Object.freeze({ name: "idx_l2_depth_snapshots_symbol_market_captured_at", sql: "CREATE INDEX IF NOT EXISTS idx_l2_depth_snapshots_symbol_market_captured_at ON l2_depth_snapshots(symbol, market_kind, captured_at);" }),
  Object.freeze({ name: "idx_l2_depth_snapshots_captured_at", sql: "CREATE INDEX IF NOT EXISTS idx_l2_depth_snapshots_captured_at ON l2_depth_snapshots(captured_at);" }),
  Object.freeze({ name: "idx_capture_sessions_started_at", sql: "CREATE INDEX IF NOT EXISTS idx_capture_sessions_started_at ON capture_sessions(started_at);" }),
  Object.freeze({ name: "idx_capture_incidents_session_ts", sql: "CREATE INDEX IF NOT EXISTS idx_capture_incidents_session_ts ON capture_incidents(session_id, ts);" }),
  Object.freeze({ name: "idx_depth_continuity_audits_pair_day", sql: "CREATE INDEX IF NOT EXISTS idx_depth_continuity_audits_pair_day ON depth_continuity_audits(symbol, market_kind, day_start);" }),
]);

const REQUIRED_INDEXES = Object.freeze(INDEX_DEFINITIONS.map((index) => index.name));

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS storage_schema (
  version INTEGER NOT NULL CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL CHECK (ts >= 0),
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  price TEXT NOT NULL CHECK (length(price) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND price NOT GLOB '*[^0-9.]*' AND substr(price, 1, 1) <> '.' AND substr(price, -1, 1) <> '.' AND (instr(price, '.') = 0 OR instr(substr(price, instr(price, '.') + 1), '.') = 0) AND trim(price, '0.') <> ''),
  size TEXT NOT NULL CHECK (length(size) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND size NOT GLOB '*[^0-9.]*' AND substr(size, 1, 1) <> '.' AND substr(size, -1, 1) <> '.' AND (instr(size, '.') = 0 OR instr(substr(size, instr(size, '.') + 1), '.') = 0) AND trim(size, '0.') <> ''),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  trade_id TEXT NOT NULL CHECK (trade_id <> ''),
  baseline_log_median REAL CHECK (baseline_log_median IS NULL OR baseline_log_median BETWEEN -100 AND 100),
  baseline_log_mad REAL CHECK (baseline_log_mad IS NULL OR baseline_log_mad >= 0),
  baseline_sample_count INTEGER CHECK (baseline_sample_count IS NULL OR baseline_sample_count >= 0),
  UNIQUE (symbol, market_kind, trade_id)
);

CREATE TABLE IF NOT EXISTS candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_open INTEGER NOT NULL CHECK (ts_open >= 0 AND ts_open % 60000 = 0),
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  open TEXT NOT NULL CHECK (length(open) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND open NOT GLOB '*[^0-9.]*' AND substr(open, 1, 1) <> '.' AND substr(open, -1, 1) <> '.' AND (instr(open, '.') = 0 OR instr(substr(open, instr(open, '.') + 1), '.') = 0) AND trim(open, '0.') <> ''),
  high TEXT NOT NULL CHECK (length(high) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND high NOT GLOB '*[^0-9.]*' AND substr(high, 1, 1) <> '.' AND substr(high, -1, 1) <> '.' AND (instr(high, '.') = 0 OR instr(substr(high, instr(high, '.') + 1), '.') = 0) AND trim(high, '0.') <> ''),
  low TEXT NOT NULL CHECK (length(low) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND low NOT GLOB '*[^0-9.]*' AND substr(low, 1, 1) <> '.' AND substr(low, -1, 1) <> '.' AND (instr(low, '.') = 0 OR instr(substr(low, instr(low, '.') + 1), '.') = 0) AND trim(low, '0.') <> ''),
  close TEXT NOT NULL CHECK (length(close) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND close NOT GLOB '*[^0-9.]*' AND substr(close, 1, 1) <> '.' AND substr(close, -1, 1) <> '.' AND (instr(close, '.') = 0 OR instr(substr(close, instr(close, '.') + 1), '.') = 0) AND trim(close, '0.') <> ''),
  volume TEXT NOT NULL CHECK (length(volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND volume NOT GLOB '*[^0-9.]*' AND substr(volume, 1, 1) <> '.' AND substr(volume, -1, 1) <> '.' AND (instr(volume, '.') = 0 OR instr(substr(volume, instr(volume, '.') + 1), '.') = 0)),
  quote_volume TEXT CHECK (quote_volume IS NULL OR (length(quote_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND quote_volume NOT GLOB '*[^0-9.]*' AND substr(quote_volume, 1, 1) <> '.' AND substr(quote_volume, -1, 1) <> '.' AND (instr(quote_volume, '.') = 0 OR instr(substr(quote_volume, instr(quote_volume, '.') + 1), '.') = 0))),
  trade_count INTEGER NOT NULL CHECK (trade_count >= 0),
  taker_buy_base_volume TEXT CHECK (taker_buy_base_volume IS NULL OR (length(taker_buy_base_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_base_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_base_volume, 1, 1) <> '.' AND substr(taker_buy_base_volume, -1, 1) <> '.' AND (instr(taker_buy_base_volume, '.') = 0 OR instr(substr(taker_buy_base_volume, instr(taker_buy_base_volume, '.') + 1), '.') = 0) AND CAST(taker_buy_base_volume AS REAL) <= CAST(volume AS REAL))),
  taker_buy_quote_volume TEXT CHECK (taker_buy_quote_volume IS NULL OR (length(taker_buy_quote_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_quote_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_quote_volume, 1, 1) <> '.' AND substr(taker_buy_quote_volume, -1, 1) <> '.' AND (instr(taker_buy_quote_volume, '.') = 0 OR instr(substr(taker_buy_quote_volume, instr(taker_buy_quote_volume, '.') + 1), '.') = 0) AND (quote_volume IS NULL OR CAST(taker_buy_quote_volume AS REAL) <= CAST(quote_volume AS REAL)))),
  UNIQUE (symbol, market_kind, ts_open)
);

CREATE TABLE IF NOT EXISTS l2_depth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL CHECK (ts >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  first_update_id INTEGER NOT NULL CHECK (first_update_id >= 0),
  last_update_id INTEGER NOT NULL CHECK (last_update_id >= first_update_id),
  previous_update_id INTEGER CHECK (previous_update_id IS NULL OR previous_update_id >= 0),
  bids TEXT NOT NULL CHECK (length(bids) <= 11000000 AND json_valid(bids) AND json_type(bids) = 'array' AND json_array_length(bids) <= 5000),
  asks TEXT NOT NULL CHECK (length(asks) <= 11000000 AND json_valid(asks) AND json_type(asks) = 'array' AND json_array_length(asks) <= 5000),
  CHECK ((market_kind = 'SPOT' AND previous_update_id IS NULL) OR (market_kind = 'PERPETUAL' AND previous_update_id IS NOT NULL)),
  UNIQUE (symbol, market_kind, first_update_id, last_update_id)
);

CREATE TABLE IF NOT EXISTS l2_depth_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL CHECK (captured_at >= 0),
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  last_update_id INTEGER NOT NULL CHECK (last_update_id >= 0),
  bids TEXT NOT NULL CHECK (length(bids) <= 11000000 AND json_valid(bids) AND json_type(bids) = 'array' AND json_array_length(bids) <= 5000),
  asks TEXT NOT NULL CHECK (length(asks) <= 11000000 AND json_valid(asks) AND json_type(asks) = 'array' AND json_array_length(asks) <= 5000),
  UNIQUE (symbol, market_kind, last_update_id)
);

CREATE TABLE IF NOT EXISTS capture_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id <> ''),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  quality TEXT NOT NULL CHECK (quality IN ('HEALTHY', 'DEGRADED', 'INVALID')),
  clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
  termination_reason TEXT
);

CREATE TABLE IF NOT EXISTS capture_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES capture_sessions(session_id),
  ts INTEGER NOT NULL CHECK (ts >= 0),
  severity TEXT NOT NULL CHECK (severity IN ('DEGRADED', 'INVALID')),
  event TEXT NOT NULL CHECK (event <> ''),
  market_kind TEXT,
  route TEXT,
  symbol TEXT,
  event_type TEXT,
  affected_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_count >= 0),
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object')
);

CREATE TABLE IF NOT EXISTS depth_continuity_audits (
  day_start INTEGER NOT NULL CHECK (day_start >= 0 AND day_start % 86400000 = 0),
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  first_update_id INTEGER CHECK (first_update_id IS NULL OR first_update_id >= 0),
  last_update_id INTEGER CHECK (last_update_id IS NULL OR last_update_id >= 0),
  rows_checked INTEGER NOT NULL CHECK (rows_checked >= 0),
  gaps_detected INTEGER NOT NULL CHECK (gaps_detected >= 0),
  anchor_status TEXT NOT NULL CHECK (anchor_status IN ('ANCHORED', 'BASELINE', 'NO_DATA')),
  audited_at INTEGER NOT NULL CHECK (audited_at >= 0),
  PRIMARY KEY (day_start, symbol, market_kind),
  CHECK ((rows_checked = 0 AND first_update_id IS NULL AND last_update_id IS NULL) OR
         (rows_checked > 0 AND first_update_id IS NOT NULL AND last_update_id IS NOT NULL AND last_update_id >= first_update_id))
);

CREATE TABLE IF NOT EXISTS daily_notional_rollup (
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  day_bucket INTEGER NOT NULL CHECK (day_bucket >= 0 AND day_bucket % 86400000 = 0),
  notional REAL NOT NULL CHECK (notional >= 0),
  PRIMARY KEY (symbol, market_kind, day_bucket)
);

CREATE TABLE IF NOT EXISTS daily_notional_rollup_watermark (
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
  last_trade_id INTEGER NOT NULL CHECK (last_trade_id >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (symbol, market_kind)
);
`;

const INSERT_SQL = Object.freeze({
  trades:
    "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (@ts, @symbol, @marketKind, @price, @size, @side, @tradeId) ON CONFLICT(symbol, market_kind, trade_id) DO NOTHING",
  candles:
    "INSERT INTO candles (ts_open, symbol, market_kind, open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume) VALUES (@tsOpen, @symbol, @marketKind, @open, @high, @low, @close, @volume, @quoteVolume, @tradeCount, @takerBuyBaseVolume, @takerBuyQuoteVolume) ON CONFLICT(symbol, market_kind, ts_open) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume, quote_volume = excluded.quote_volume, trade_count = excluded.trade_count, taker_buy_base_volume = excluded.taker_buy_base_volume, taker_buy_quote_volume = excluded.taker_buy_quote_volume",
  l2_depth_events:
    "INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (@ts, @receivedAt, @symbol, @marketKind, @firstUpdateId, @lastUpdateId, @previousUpdateId, @bids, @asks) ON CONFLICT(symbol, market_kind, first_update_id, last_update_id) DO NOTHING",
  l2_depth_snapshots:
    "INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (@capturedAt, @symbol, @marketKind, @lastUpdateId, @bids, @asks) ON CONFLICT(symbol, market_kind, last_update_id) DO NOTHING",
  capture_incidents:
    "INSERT INTO capture_incidents (session_id, ts, severity, event, market_kind, route, symbol, event_type, affected_count, details) VALUES (@sessionId, @ts, @severity, @event, @marketKind, @route, @symbol, @eventType, @affectedCount, @details)",
});

function isCorruptionError(error) {
  return error?.code === "SQLITE_CORRUPT" || error?.code === "SQLITE_NOTADB";
}

function openRawDatabase(dbPath) {
  return new Database(dbPath, { timeout: DEFAULT_BUSY_TIMEOUT_MS });
}

function tableExists(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function schemaVersion(db) {
  if (!tableExists(db, "storage_schema")) return null;
  const rows = db.prepare("SELECT version FROM storage_schema").all();
  if (rows.length !== 1) {
    throw new Error(`storage-db: schema version table must contain exactly one row, found ${rows.length}`);
  }
  if (!Number.isSafeInteger(rows[0].version) || rows[0].version < 1) {
    throw new Error("storage-db: schema version must be a positive safe integer");
  }
  return rows[0].version;
}

function validateSchemaTables(db) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) {
      throw new Error(`storage-db: schema version ${SCHEMA_VERSION} is missing table ${table}`);
    }
    const actualColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const column of expectedColumns) {
      if (!actualColumns.has(column)) {
        throw new Error(`storage-db: schema version ${SCHEMA_VERSION} table ${table} is missing column ${column}`);
      }
    }
  }
}

function validateCurrentSchema(db, { verifyIntegrity = false } = {}) {
  validateSchemaTables(db);
  const findIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?");
  for (const index of REQUIRED_INDEXES) {
    if (findIndex.get(index) === undefined) {
      throw new Error(`storage-db: schema version ${SCHEMA_VERSION} is missing index ${index}`);
    }
  }
  if (verifyIntegrity) {
    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") {
      throw new Error(`storage-db: schema quick_check failed: ${quickCheck}`);
    }
  }
}

function createCurrentSchema(db) {
  db.pragma("auto_vacuum = INCREMENTAL");
  db.exec(CREATE_SCHEMA_SQL);
  db.prepare("DELETE FROM storage_schema").run();
  db.prepare("INSERT INTO storage_schema (version) VALUES (?)").run(SCHEMA_VERSION);
}

function createCurrentIndexes(db) {
  for (const index of INDEX_DEFINITIONS) db.exec(index.sql);
}

function migrateV6ToV10Schema(db) {
  db.exec(`
    CREATE TABLE capture_sessions (
      session_id TEXT PRIMARY KEY CHECK (session_id <> ''),
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
      quality TEXT NOT NULL CHECK (quality IN ('HEALTHY', 'DEGRADED', 'INVALID')),
      clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
      termination_reason TEXT
    );
    CREATE INDEX idx_capture_sessions_started_at ON capture_sessions(started_at);
    CREATE TABLE capture_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES capture_sessions(session_id),
      ts INTEGER NOT NULL CHECK (ts >= 0),
      severity TEXT NOT NULL CHECK (severity IN ('DEGRADED', 'INVALID')),
      event TEXT NOT NULL CHECK (event <> ''),
      market_kind TEXT,
      route TEXT,
      symbol TEXT,
      event_type TEXT,
      affected_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_count >= 0),
      details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object')
    );
    CREATE INDEX idx_capture_incidents_session_ts ON capture_incidents(session_id, ts);
    ALTER TABLE candles ADD COLUMN taker_buy_base_volume TEXT CHECK (taker_buy_base_volume IS NULL OR (length(taker_buy_base_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_base_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_base_volume, 1, 1) <> '.' AND substr(taker_buy_base_volume, -1, 1) <> '.' AND (instr(taker_buy_base_volume, '.') = 0 OR instr(substr(taker_buy_base_volume, instr(taker_buy_base_volume, '.') + 1), '.') = 0) AND CAST(taker_buy_base_volume AS REAL) <= CAST(volume AS REAL)));
    UPDATE storage_schema SET version = 10;
  `);
}

function migrateV7ToV10Schema(db) {
  db.exec(`
    ALTER TABLE candles ADD COLUMN taker_buy_base_volume TEXT CHECK (taker_buy_base_volume IS NULL OR (length(taker_buy_base_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_base_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_base_volume, 1, 1) <> '.' AND substr(taker_buy_base_volume, -1, 1) <> '.' AND (instr(taker_buy_base_volume, '.') = 0 OR instr(substr(taker_buy_base_volume, instr(taker_buy_base_volume, '.') + 1), '.') = 0) AND CAST(taker_buy_base_volume AS REAL) <= CAST(volume AS REAL)));
    UPDATE storage_schema SET version = 10;
  `);
}

function migrateV8ToV10Schema(db) {
  db.exec(`
    ALTER TABLE candles ADD COLUMN taker_buy_base_volume TEXT CHECK (taker_buy_base_volume IS NULL OR (length(taker_buy_base_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_base_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_base_volume, 1, 1) <> '.' AND substr(taker_buy_base_volume, -1, 1) <> '.' AND (instr(taker_buy_base_volume, '.') = 0 OR instr(substr(taker_buy_base_volume, instr(taker_buy_base_volume, '.') + 1), '.') = 0) AND CAST(taker_buy_base_volume AS REAL) <= CAST(volume AS REAL)));
    UPDATE storage_schema SET version = 10;
  `);
}

function migrateV9ToV10Schema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(candles)").all().map((column) => column.name));
  if (!columns.has("quote_volume")) {
    db.exec(`ALTER TABLE candles ADD COLUMN quote_volume TEXT CHECK (quote_volume IS NULL OR (length(quote_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND quote_volume NOT GLOB '*[^0-9.]*' AND substr(quote_volume, 1, 1) <> '.' AND substr(quote_volume, -1, 1) <> '.' AND (instr(quote_volume, '.') = 0 OR instr(substr(quote_volume, instr(quote_volume, '.') + 1), '.') = 0)));`);
  }
  if (!columns.has("taker_buy_quote_volume")) {
    db.exec(`ALTER TABLE candles ADD COLUMN taker_buy_quote_volume TEXT CHECK (taker_buy_quote_volume IS NULL OR (length(taker_buy_quote_volume) BETWEEN 1 AND ${MAX_DECIMAL_STRING_LENGTH} AND taker_buy_quote_volume NOT GLOB '*[^0-9.]*' AND substr(taker_buy_quote_volume, 1, 1) <> '.' AND substr(taker_buy_quote_volume, -1, 1) <> '.' AND (instr(taker_buy_quote_volume, '.') = 0 OR instr(substr(taker_buy_quote_volume, instr(taker_buy_quote_volume, '.') + 1), '.') = 0) AND (quote_volume IS NULL OR CAST(taker_buy_quote_volume AS REAL) <= CAST(quote_volume AS REAL))));`);
  }
  db.prepare("UPDATE storage_schema SET version = ?").run(10);
}

function migrateV10ToCurrentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS depth_continuity_audits (
      day_start INTEGER NOT NULL CHECK (day_start >= 0 AND day_start % 86400000 = 0),
      symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
      market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
      first_update_id INTEGER CHECK (first_update_id IS NULL OR first_update_id >= 0),
      last_update_id INTEGER CHECK (last_update_id IS NULL OR last_update_id >= 0),
      rows_checked INTEGER NOT NULL CHECK (rows_checked >= 0),
      gaps_detected INTEGER NOT NULL CHECK (gaps_detected >= 0),
      anchor_status TEXT NOT NULL CHECK (anchor_status IN ('ANCHORED', 'BASELINE', 'NO_DATA')),
      audited_at INTEGER NOT NULL CHECK (audited_at >= 0),
      PRIMARY KEY (day_start, symbol, market_kind),
      CHECK ((rows_checked = 0 AND first_update_id IS NULL AND last_update_id IS NULL) OR
             (rows_checked > 0 AND first_update_id IS NOT NULL AND last_update_id IS NOT NULL AND last_update_id >= first_update_id))
    );
  `);
  db.prepare("UPDATE storage_schema SET version = ?").run(11);
}

function migrateV11ToV12Schema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(trades)").all().map((column) => column.name));
  if (!columns.has("baseline_log_median")) {
    db.exec("ALTER TABLE trades ADD COLUMN baseline_log_median REAL CHECK (baseline_log_median IS NULL OR baseline_log_median BETWEEN -100 AND 100);");
  }
  if (!columns.has("baseline_log_mad")) {
    db.exec("ALTER TABLE trades ADD COLUMN baseline_log_mad REAL CHECK (baseline_log_mad IS NULL OR baseline_log_mad >= 0);");
  }
  db.prepare("UPDATE storage_schema SET version = ?").run(12);
}

function migrateV12ToV13Schema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(trades)").all().map((column) => column.name));
  if (!columns.has("baseline_sample_count")) {
    db.exec("ALTER TABLE trades ADD COLUMN baseline_sample_count INTEGER CHECK (baseline_sample_count IS NULL OR baseline_sample_count >= 0);");
  }
  db.prepare("UPDATE storage_schema SET version = ?").run(13);
}

function migrateV13ToV14Schema(db) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_trades_vpin_covering ON trades(symbol, market_kind, ts, side, price, size);");
  db.prepare("UPDATE storage_schema SET version = ?").run(14);
  migrateV14ToV15Schema(db);
}

function migrateV14ToV15Schema(db) {
  db.exec("DROP INDEX IF EXISTS idx_trades_large_trade_z_score;");
  db.prepare("UPDATE storage_schema SET version = ?").run(15);
  migrateV15ToCurrentSchema(db);
}

function migrateV15ToCurrentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_notional_rollup (
      symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
      market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
      day_bucket INTEGER NOT NULL CHECK (day_bucket >= 0 AND day_bucket % 86400000 = 0),
      notional REAL NOT NULL CHECK (notional >= 0),
      PRIMARY KEY (symbol, market_kind, day_bucket)
    );
    CREATE TABLE IF NOT EXISTS daily_notional_rollup_watermark (
      symbol TEXT NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT')),
      market_kind TEXT NOT NULL CHECK (market_kind IN ('SPOT', 'PERPETUAL')),
      last_trade_id INTEGER NOT NULL CHECK (last_trade_id >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (symbol, market_kind)
    );
  `);
  db.prepare("UPDATE storage_schema SET version = ?").run(SCHEMA_VERSION);
}

function rebuildVersionedSchema(db) {
  for (const table of TABLES) {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_previous`);
  }
  createCurrentSchema(db);
  db.exec(`
    INSERT INTO trades (id, ts, symbol, market_kind, price, size, side, trade_id)
    SELECT id, ts, symbol, market_kind, price, size, side, trade_id FROM trades_previous;
    INSERT INTO candles (id, ts_open, symbol, market_kind, open, high, low, close, volume, trade_count)
    SELECT id, ts_open, symbol, market_kind, open, high, low, close, volume, trade_count FROM candles_previous;
    INSERT INTO l2_depth_events (id, ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks)
    SELECT id, ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks FROM l2_depth_events_previous;
    INSERT INTO l2_depth_snapshots (id, captured_at, symbol, market_kind, last_update_id, bids, asks)
    SELECT id, captured_at, symbol, market_kind, last_update_id, bids, asks FROM l2_depth_snapshots_previous;
    DROP TABLE trades_previous;
    DROP TABLE candles_previous;
    DROP TABLE l2_depth_events_previous;
    DROP TABLE l2_depth_snapshots_previous;
  `);
  createCurrentIndexes(db);
}

function migrateLegacyV1ToCurrentSchema(db) {
  db.exec("ALTER TABLE trades RENAME TO trades_v1");
  db.exec("ALTER TABLE candles RENAME TO candles_v1");
  db.exec("ALTER TABLE l2_depth_events RENAME TO l2_depth_events_v1");
  createCurrentSchema(db);
  db.exec(`
    INSERT INTO trades (id, ts, symbol, market_kind, price, size, side, trade_id)
    SELECT id, ts, symbol, market_kind, CAST(price AS TEXT), CAST(size AS TEXT), side, trade_id
    FROM trades_v1
    WHERE id IN (SELECT MAX(id) FROM trades_v1 GROUP BY symbol, market_kind, trade_id);
    INSERT INTO candles (id, ts_open, symbol, market_kind, open, high, low, close, volume, trade_count)
    SELECT id, ts_open, symbol, market_kind, CAST(open AS TEXT), CAST(high AS TEXT), CAST(low AS TEXT), CAST(close AS TEXT), CAST(volume AS TEXT), trade_count
    FROM candles_v1
    WHERE id IN (SELECT MAX(id) FROM candles_v1 GROUP BY symbol, market_kind, ts_open);
    INSERT INTO l2_depth_events (id, ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks)
    SELECT id, ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks
    FROM l2_depth_events_v1
    WHERE id IN (SELECT MAX(id) FROM l2_depth_events_v1 GROUP BY symbol, market_kind, first_update_id, last_update_id);
    DROP TABLE trades_v1;
    DROP TABLE candles_v1;
    DROP TABLE l2_depth_events_v1;
  `);
}

function initializeSchema(db, { verifyIntegrity = false } = {}) {
  const version = schemaVersion(db);
  if (version === SCHEMA_VERSION) {
    validateSchemaTables(db);
    createCurrentIndexes(db);
    validateCurrentSchema(db, { verifyIntegrity });
    return;
  }
  let needsVacuum = false;
  db.transaction(() => {
    if (version === 15) {
      migrateV15ToCurrentSchema(db);
      return;
    }
    if (version === 14) {
      migrateV14ToV15Schema(db);
      return;
    }
    if (version === 13) {
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 12) {
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 11) {
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 10) {
      migrateV10ToCurrentSchema(db);
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 9) {
      migrateV9ToV10Schema(db);
      migrateV10ToCurrentSchema(db);
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 8) {
      migrateV8ToV10Schema(db);
      migrateV9ToV10Schema(db);
      migrateV10ToCurrentSchema(db);
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 7) {
      migrateV7ToV10Schema(db);
      migrateV9ToV10Schema(db);
      migrateV10ToCurrentSchema(db);
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 6) {
      migrateV6ToV10Schema(db);
      migrateV9ToV10Schema(db);
      migrateV10ToCurrentSchema(db);
      migrateV11ToV12Schema(db);
      migrateV12ToV13Schema(db);
      migrateV13ToV14Schema(db);
      return;
    }
    if (version === 2 || version === 3 || version === 4 || version === 5) {
      createCurrentSchema(db);
      rebuildVersionedSchema(db);
      needsVacuum = true;
      return;
    }
    if (version === null && LEGACY_V1_TABLES.every((table) => tableExists(db, table))) {
      migrateLegacyV1ToCurrentSchema(db);
      needsVacuum = true;
      return;
    }
    if (version === null && TABLES.every((table) => !tableExists(db, table))) {
      createCurrentSchema(db);
      return;
    }
    throw new Error(`storage-db: unsupported schema version ${String(version)}`);
  })();
  if (needsVacuum) {
    db.exec("VACUUM");
  }
  validateSchemaTables(db);
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
    if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  let db;
  try {
    db = readonly
      ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: DEFAULT_BUSY_TIMEOUT_MS })
      : openRawDatabase(dbPath);
    if (bootstrap) {
      initializeSchema(db, { verifyIntegrity });
    } else {
      const version = schemaVersion(db);
      if (version !== SCHEMA_VERSION) {
        throw new Error(`storage-db: writer requires schema version ${SCHEMA_VERSION}, found ${String(version)}`);
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
      `storage-db: database at ${dbPath} appears corrupt; collector halted without modifying recovery evidence`,
      { cause: error },
    );
    corruptionError.code = "STORAGE_CORRUPT_DATABASE";
    throw corruptionError;
  }
}

function assertKnownTable(table) {
  if (!Object.hasOwn(INSERT_SQL, table)) {
    throw new Error(`storage-db: unsupported table "${String(table)}"`);
  }
}

function createStorageDb({ dbPath, bootstrap = true, verifyIntegrity = false, readonly = false } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("storage-db: dbPath must be a non-empty string");
  }
  if (typeof bootstrap !== "boolean" || typeof verifyIntegrity !== "boolean" || typeof readonly !== "boolean") {
    throw new Error("storage-db: bootstrap, verifyIntegrity, and readonly must be booleans");
  }
  if (readonly && dbPath === ":memory:") {
    throw new Error("storage-db: readonly mode requires a file-backed database");
  }
  if (readonly && bootstrap) {
    throw new Error("storage-db: readonly mode cannot bootstrap or migrate a database");
  }
  const db = openDatabase(dbPath, { bootstrap, verifyIntegrity, readonly });

  const insertStatements = Object.fromEntries(
    Object.entries(INSERT_SQL).map(([table, sql]) => [table, db.prepare(sql)]),
  );
  let closed = false;

  const beginCaptureSessionTransaction = db.transaction(({ sessionId, startedAt }) => {
    db.prepare(
      "UPDATE capture_sessions SET ended_at = ?, quality = 'INVALID', clean_shutdown = 0, termination_reason = 'UNCLEAN_PREVIOUS_PROCESS_EXIT' WHERE ended_at IS NULL",
    ).run(startedAt);
    db.prepare(
      "INSERT INTO capture_sessions (session_id, started_at, quality, clean_shutdown) VALUES (?, ?, 'HEALTHY', 0)",
    ).run(sessionId, startedAt);
  });

  function insert(table, record) {
    assertKnownTable(table);
    if (closed) throw new Error("storage-db: cannot write after close");
    const completeRecord = table === "candles"
      ? { quoteVolume: null, takerBuyQuoteVolume: null, ...record }
      : record;
    return insertStatements[table].run(completeRecord);
  }

  function beginCaptureSession({ sessionId, startedAt }) {
    if (closed) throw new Error("storage-db: cannot begin a capture session after close");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("storage-db: capture sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error("storage-db: capture startedAt must be a safe non-negative integer");
    }
    beginCaptureSessionTransaction({ sessionId, startedAt });
  }

  function finishCaptureSession({ sessionId, endedAt, quality, cleanShutdown, terminationReason = null }) {
    if (closed) throw new Error("storage-db: cannot finish a capture session after close");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("storage-db: capture sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(endedAt) || endedAt < 0) {
      throw new Error("storage-db: capture endedAt must be a safe non-negative integer");
    }
    if (!["HEALTHY", "DEGRADED", "INVALID"].includes(quality)) {
      throw new Error("storage-db: capture quality must be HEALTHY, DEGRADED, or INVALID");
    }
    if (typeof cleanShutdown !== "boolean") {
      throw new Error("storage-db: cleanShutdown must be a boolean");
    }
    const result = db.prepare(
      "UPDATE capture_sessions SET ended_at = ?, quality = ?, clean_shutdown = ?, termination_reason = ? WHERE session_id = ? AND ended_at IS NULL",
    ).run(endedAt, quality, cleanShutdown ? 1 : 0, terminationReason, sessionId);
    if (result.changes !== 1) {
      throw new Error("storage-db: active capture session was not found");
    }
  }

  function getLatestDepthContinuityAudit({ beforeDayStart, symbol, marketKind }) {
    if (closed) throw new Error("storage-db: cannot read after close");
    if (!Number.isSafeInteger(beforeDayStart) || beforeDayStart < 0 || beforeDayStart % (24 * 60 * 60 * 1000) !== 0) {
      throw new Error("storage-db: beforeDayStart must be a UTC day-start safe integer");
    }
    if (!["BTCUSDT", "ETHUSDT"].includes(symbol) || !["SPOT", "PERPETUAL"].includes(marketKind)) {
      throw new Error("storage-db: depth continuity identity is invalid");
    }
    return db.prepare(
      "SELECT * FROM depth_continuity_audits WHERE symbol = ? AND market_kind = ? AND day_start < ? " +
      "AND anchor_status IN ('ANCHORED', 'BASELINE') ORDER BY day_start DESC LIMIT 1",
    ).get(symbol, marketKind, beforeDayStart) ?? null;
  }

  function recordDepthContinuityAudit({
    dayStart, symbol, marketKind, firstUpdateId, lastUpdateId, rowsChecked, gapsDetected, anchorStatus, auditedAt,
  }) {
    if (closed) throw new Error("storage-db: cannot write after close");
    if (!Number.isSafeInteger(dayStart) || dayStart < 0 || dayStart % (24 * 60 * 60 * 1000) !== 0) {
      throw new Error("storage-db: dayStart must be a UTC day-start safe integer");
    }
    if (!["BTCUSDT", "ETHUSDT"].includes(symbol) || !["SPOT", "PERPETUAL"].includes(marketKind)) {
      throw new Error("storage-db: depth continuity identity is invalid");
    }
    if (!Number.isSafeInteger(rowsChecked) || rowsChecked < 0 || !Number.isSafeInteger(gapsDetected) || gapsDetected < 0) {
      throw new Error("storage-db: depth continuity counts are invalid");
    }
    if (!["ANCHORED", "BASELINE", "NO_DATA"].includes(anchorStatus)) {
      throw new Error("storage-db: depth continuity anchorStatus is invalid");
    }
    if (!Number.isSafeInteger(auditedAt) || auditedAt < 0) {
      throw new Error("storage-db: depth continuity auditedAt is invalid");
    }
    const noRows = rowsChecked === 0;
    if (
      (noRows && (firstUpdateId !== null || lastUpdateId !== null)) ||
      (!noRows && (!Number.isSafeInteger(firstUpdateId) || firstUpdateId < 0 || !Number.isSafeInteger(lastUpdateId) || lastUpdateId < firstUpdateId))
    ) {
      throw new Error("storage-db: depth continuity update-id bounds are invalid");
    }
    db.prepare(
      "INSERT INTO depth_continuity_audits (day_start, symbol, market_kind, first_update_id, last_update_id, rows_checked, gaps_detected, anchor_status, audited_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(day_start, symbol, market_kind) DO UPDATE SET first_update_id = excluded.first_update_id, last_update_id = excluded.last_update_id, rows_checked = excluded.rows_checked, gaps_detected = excluded.gaps_detected, anchor_status = excluded.anchor_status, audited_at = excluded.audited_at",
    ).run(dayStart, symbol, marketKind, firstUpdateId, lastUpdateId, rowsChecked, gapsDetected, anchorStatus, auditedAt);
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return Object.freeze({
    insert, beginCaptureSession, finishCaptureSession,
    getLatestDepthContinuityAudit, recordDepthContinuityAudit,
    close, raw: db,
  });
}

function verifyStorageIntegrity({ dbPath }) {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:") {
    throw new Error("storage-db: integrity verification requires a file-backed database path");
  }
  const db = openDatabase(dbPath, { bootstrap: false, verifyIntegrity: true, readonly: true });
  try {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, integrity: "ok" });
  } finally {
    db.close();
  }
}

module.exports = {
  REQUIRED_INDEXES,
  createStorageDb,
  verifyStorageIntegrity,
  DEFAULT_DB_PATH,
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
};
