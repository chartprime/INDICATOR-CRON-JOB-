const path = require("node:path");
const Database = require("better-sqlite3");
const { dataRoot } = require("../../platform/runtime-paths");
const { ROLLUP_GRAIN_TICKS } = require("./volume-profile-engine");

const DEFAULT_VOLUME_PROFILE_CACHE_PATH = path.join(
  dataRoot(),
  "live",
  "volume-profile-cache.sqlite",
);
const CACHE_SCHEMA_VERSION = 3;
const MINUTE_MS = 60_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vp_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vp_rollup (
  instrument TEXT NOT NULL,
  minute_ts INTEGER NOT NULL CHECK (minute_ts >= 0 AND minute_ts % 60000 = 0),
  price_bucket INTEGER NOT NULL CHECK (price_bucket >= 0),
  volume REAL NOT NULL CHECK (volume >= 0),
  buy_volume REAL NOT NULL CHECK (buy_volume >= 0),
  sell_volume REAL NOT NULL CHECK (sell_volume >= 0),
  trade_count INTEGER NOT NULL CHECK (trade_count > 0),
  PRIMARY KEY (instrument, minute_ts, price_bucket)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS vp_coverage (
  instrument TEXT NOT NULL,
  minute_ts INTEGER NOT NULL CHECK (minute_ts >= 0 AND minute_ts % 60000 = 0),
  PRIMARY KEY (instrument, minute_ts)
) WITHOUT ROWID;
`;

function floorToMinute(ts) {
  return ts - (ts % MINUTE_MS);
}

function assertInstrument(instrument) {
  if (typeof instrument !== "string" || instrument.trim().length === 0) {
    throw new Error(
      "volume-profile-cache: instrument must be a non-empty string",
    );
  }
}

function assertMinuteWindow(fromMinuteTs, toMinuteTs, field) {
  if (
    !Number.isSafeInteger(fromMinuteTs) ||
    fromMinuteTs < 0 ||
    fromMinuteTs % MINUTE_MS !== 0
  ) {
    throw new Error(
      `volume-profile-cache: ${field} fromMinuteTs must be a non-negative minute boundary`,
    );
  }
  if (
    !Number.isSafeInteger(toMinuteTs) ||
    toMinuteTs < fromMinuteTs ||
    toMinuteTs % MINUTE_MS !== 0
  ) {
    throw new Error(
      `volume-profile-cache: ${field} toMinuteTs must be a minute boundary not before fromMinuteTs`,
    );
  }
}

function createVolumeProfileCache({ dbPath, timeoutMs = 5000 }) {
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("volume-profile-cache: dbPath must be a non-empty string");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      "volume-profile-cache: timeoutMs must be a non-negative integer",
    );
  }

  let db = null;
  let closed = false;
  let unavailableLogged = false;

  function tryOpen() {
    if (closed || db) return db;
    try {
      const conn = new Database(dbPath, { timeout: timeoutMs });
      conn.pragma("journal_mode = WAL");
      conn.pragma("synchronous = NORMAL");
      conn.exec(SCHEMA_SQL);
      const storedVersion = conn
        .prepare("SELECT value FROM vp_meta WHERE key = 'schema_version'")
        .get();
      if (!storedVersion) {
        conn
          .prepare(
            "INSERT INTO vp_meta (key, value) VALUES ('schema_version', ?)",
          )
          .run(String(CACHE_SCHEMA_VERSION));
      } else if (storedVersion.value !== String(CACHE_SCHEMA_VERSION)) {
        conn.exec(
          "DROP TABLE IF EXISTS vp_rollup; DROP TABLE IF EXISTS vp_coverage; DROP TABLE IF EXISTS vp_meta;",
        );
        conn.exec(SCHEMA_SQL);
        conn
          .prepare(
            "INSERT INTO vp_meta (key, value) VALUES ('schema_version', ?)",
          )
          .run(String(CACHE_SCHEMA_VERSION));
      }
      db = conn;
      unavailableLogged = false;
    } catch (error) {
      if (!unavailableLogged) {
        console.error(
          "volume-profile-cache: unavailable, falling back to direct reads",
          error?.message ?? error,
        );
        unavailableLogged = true;
      }
    }
    return db;
  }

  function ensureTickSize(conn, instrument, tickSize) {
    // A stored row's `price_bucket` is an ABSOLUTE index into a grid of
    // ROLLUP_GRAIN_TICKS-wide buckets, and the grain is not stored per row. So
    // the grain is part of what a row MEANS: reading 32-tick-indexed rows with
    // an 8-tick grid reports every price four times too coarse, silently and
    // without a single constraint failing. The grain is therefore folded into
    // this key alongside the instrument's tick size -- changing either discards
    // that instrument's rollup, which is the only safe response.
    const key = `tick:${instrument}:grain:${ROLLUP_GRAIN_TICKS}`;
    const stored = conn
      .prepare("SELECT value FROM vp_meta WHERE key = ?")
      .get(key);
    const wanted = String(tickSize);
    if (!stored) {
      conn
        .prepare("INSERT INTO vp_meta (key, value) VALUES (?, ?)")
        .run(key, wanted);
      return true;
    }
    if (stored.value === wanted) return true;
    conn.prepare("DELETE FROM vp_rollup WHERE instrument = ?").run(instrument);
    conn
      .prepare("DELETE FROM vp_coverage WHERE instrument = ?")
      .run(instrument);
    conn.prepare("UPDATE vp_meta SET value = ? WHERE key = ?").run(wanted, key);
    return true;
  }

  function coverageGaps(instrument, fromMinuteTs, toMinuteTs) {
    assertInstrument(instrument);
    assertMinuteWindow(fromMinuteTs, toMinuteTs, "coverageGaps");
    const conn = tryOpen();
    if (!conn) return null;
    const covered = new Set();
    for (const row of conn
      .prepare(
        "SELECT minute_ts FROM vp_coverage WHERE instrument = ? AND minute_ts >= ? AND minute_ts < ?",
      )
      .all(instrument, fromMinuteTs, toMinuteTs)) {
      covered.add(row.minute_ts);
    }
    const gaps = [];
    let runStart = null;
    for (let minute = fromMinuteTs; minute < toMinuteTs; minute += MINUTE_MS) {
      if (covered.has(minute)) {
        if (runStart !== null) {
          gaps.push({ fromMinuteTs: runStart, toMinuteTs: minute });
          runStart = null;
        }
      } else if (runStart === null) {
        runStart = minute;
      }
    }
    if (runStart !== null) gaps.push({ fromMinuteTs: runStart, toMinuteTs });
    return gaps;
  }

  function materialize(
    instrument,
    { tickSize, fromMinuteTs, toMinuteTs, rows },
  ) {
    assertInstrument(instrument);
    assertMinuteWindow(fromMinuteTs, toMinuteTs, "materialize");
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error(
        "volume-profile-cache: materialize tickSize must be a positive finite number",
      );
    }
    if (!Array.isArray(rows)) {
      throw new Error(
        "volume-profile-cache: materialize rows must be an array",
      );
    }
    for (const row of rows) {
      if (!Number.isSafeInteger(row.priceBucket) || row.priceBucket < 0) {
        throw new Error(
          "volume-profile-cache: materialize price buckets must be non-negative safe integers",
        );
      }
      if (
        !Number.isSafeInteger(row.minuteTs) ||
        row.minuteTs < fromMinuteTs ||
        row.minuteTs >= toMinuteTs
      ) {
        throw new Error(
          "volume-profile-cache: materialize rows must fall inside the declared minute window",
        );
      }
    }
    const conn = tryOpen();
    if (!conn) return false;
    try {
      ensureTickSize(conn, instrument, tickSize);
      const insertRow = conn.prepare(
        "INSERT INTO vp_rollup (instrument, minute_ts, price_bucket, volume, buy_volume, sell_volume, trade_count) " +
          "VALUES (@instrument, @minuteTs, @priceBucket, @volume, @buyVolume, @sellVolume, @tradeCount) " +
          "ON CONFLICT(instrument, minute_ts, price_bucket) DO UPDATE SET " +
          "volume = excluded.volume, buy_volume = excluded.buy_volume, " +
          "sell_volume = excluded.sell_volume, trade_count = excluded.trade_count",
      );
      const insertCoverage = conn.prepare(
        "INSERT INTO vp_coverage (instrument, minute_ts) VALUES (?, ?) ON CONFLICT DO NOTHING",
      );
      conn.transaction(() => {
        for (const row of rows) {
          insertRow.run({
            instrument,
            minuteTs: row.minuteTs,
            priceBucket: row.priceBucket,
            volume: row.volume,
            buyVolume: row.buyVolume,
            sellVolume: row.sellVolume,
            tradeCount: row.tradeCount,
          });
        }
        for (
          let minute = fromMinuteTs;
          minute < toMinuteTs;
          minute += MINUTE_MS
        ) {
          insertCoverage.run(instrument, minute);
        }
      })();
      return true;
    } catch (error) {
      console.error(
        "volume-profile-cache: materialize failed",
        error?.message ?? error,
      );
      return false;
    }
  }

  function readBucketRange(instrument, { fromMinuteTs, toMinuteTs }) {
    assertInstrument(instrument);
    assertMinuteWindow(fromMinuteTs, toMinuteTs, "readBucketRange");
    const conn = tryOpen();
    if (!conn) return null;
    try {
      const row = conn
        .prepare(
          "SELECT MIN(price_bucket) AS lo, MAX(price_bucket) AS hi, COUNT(*) AS n FROM vp_rollup " +
            "WHERE instrument = ? AND minute_ts >= ? AND minute_ts < ?",
        )
        .get(instrument, fromMinuteTs, toMinuteTs);
      if (!row || !Number.isSafeInteger(row.n) || row.n <= 0) {
        return { minBucket: null, maxBucket: null, rowCount: 0 };
      }
      if (
        !Number.isSafeInteger(row.lo) ||
        !Number.isSafeInteger(row.hi) ||
        row.hi < row.lo
      ) {
        return { minBucket: null, maxBucket: null, rowCount: 0 };
      }
      return { minBucket: row.lo, maxBucket: row.hi, rowCount: row.n };
    } catch (error) {
      console.error(
        "volume-profile-cache: bucket-range read failed",
        error?.message ?? error,
      );
      return null;
    }
  }

  function readPeriodBucketSpans(
    instrument,
    { fromMinuteTs, toMinuteTs, periodMs },
  ) {
    assertInstrument(instrument);
    assertMinuteWindow(fromMinuteTs, toMinuteTs, "readPeriodBucketSpans");
    if (
      !Number.isSafeInteger(periodMs) ||
      periodMs <= 0 ||
      periodMs % MINUTE_MS !== 0
    ) {
      throw new Error(
        "volume-profile-cache: readPeriodBucketSpans periodMs must be a whole number of minutes",
      );
    }
    const conn = tryOpen();
    if (!conn) return null;
    try {
      const raw = conn
        .prepare(
          "SELECT minute_ts - (minute_ts % @periodMs) AS period_start, " +
            "MIN(price_bucket) AS lo, MAX(price_bucket) AS hi FROM vp_rollup " +
            "WHERE instrument = @instrument AND minute_ts >= @fromMinuteTs AND minute_ts < @toMinuteTs " +
            "GROUP BY period_start",
        )
        .all({ instrument, fromMinuteTs, toMinuteTs, periodMs });
      const spans = [];
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.period_start) ||
          !Number.isSafeInteger(row.lo) ||
          !Number.isSafeInteger(row.hi)
        ) {
          continue;
        }
        if (row.hi < row.lo) continue;
        spans.push({
          periodStartTs: row.period_start,
          minBucket: row.lo,
          maxBucket: row.hi,
        });
      }
      return spans;
    } catch (error) {
      console.error(
        "volume-profile-cache: period-span read failed",
        error?.message ?? error,
      );
      return null;
    }
  }

  function readPeriodBuckets(
    instrument,
    { fromMinuteTs, toMinuteTs, periodMs, ticksPerRow },
  ) {
    assertInstrument(instrument);
    assertMinuteWindow(fromMinuteTs, toMinuteTs, "readPeriodBuckets");
    if (!Number.isSafeInteger(periodMs) || periodMs <= 0) {
      throw new Error(
        "volume-profile-cache: readPeriodBuckets periodMs must be a positive safe integer",
      );
    }
    if (periodMs % MINUTE_MS !== 0) {
      throw new Error(
        "volume-profile-cache: readPeriodBuckets periodMs must be a whole number of minutes",
      );
    }
    if (!Number.isSafeInteger(ticksPerRow) || ticksPerRow <= 0) {
      throw new Error(
        "volume-profile-cache: readPeriodBuckets ticksPerRow must be a positive safe integer",
      );
    }
    const conn = tryOpen();
    if (!conn) return null;
    try {
      const raw = conn
        .prepare(
          "SELECT minute_ts - (minute_ts % @periodMs) AS period_start, " +
            "(price_bucket - (price_bucket % @ticksPerRow)) / @ticksPerRow AS bucket, " +
            "SUM(volume) AS volume, SUM(buy_volume) AS buy_volume, " +
            "SUM(sell_volume) AS sell_volume, SUM(trade_count) AS trade_count " +
            "FROM vp_rollup WHERE instrument = @instrument " +
            "AND minute_ts >= @fromMinuteTs AND minute_ts < @toMinuteTs " +
            "GROUP BY period_start, bucket ORDER BY period_start ASC, bucket ASC",
        )
        .all({ instrument, fromMinuteTs, toMinuteTs, periodMs, ticksPerRow });
      const byPeriod = new Map();
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.period_start) ||
          !Number.isSafeInteger(row.bucket) ||
          !Number.isFinite(row.volume) ||
          row.volume < 0 ||
          !Number.isFinite(row.buy_volume) ||
          row.buy_volume < 0 ||
          !Number.isFinite(row.sell_volume) ||
          row.sell_volume < 0 ||
          !Number.isSafeInteger(row.trade_count) ||
          row.trade_count <= 0
        ) {
          continue;
        }
        let buckets = byPeriod.get(row.period_start);
        if (buckets === undefined) {
          buckets = new Map();
          byPeriod.set(row.period_start, buckets);
        }
        buckets.set(row.bucket, {
          volume: row.volume,
          buyVolume: row.buy_volume,
          sellVolume: row.sell_volume,
          tradeCount: row.trade_count,
        });
      }
      return byPeriod;
    } catch (error) {
      console.error(
        "volume-profile-cache: period-bucket read failed",
        error?.message ?? error,
      );
      return null;
    }
  }

  function close() {
    try {
      db?.close();
    } catch {
      void 0;
    }
    db = null;
    closed = true;
  }

  return Object.freeze({
    dbPath,
    coverageGaps,
    materialize,
    readBucketRange,
    readPeriodBucketSpans,
    readPeriodBuckets,
    close,
  });
}

module.exports = {
  createVolumeProfileCache,
  DEFAULT_VOLUME_PROFILE_CACHE_PATH,
  CACHE_SCHEMA_VERSION,
  MINUTE_MS,
  ROLLUP_GRAIN_TICKS,
  floorToMinute,
};
