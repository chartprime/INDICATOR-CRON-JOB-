const Database = require("better-sqlite3");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { attachReadTelemetry } = require("./read-telemetry");
const { storageCandleRowToBarFrame, storageTradeRowToTradeFrame } = require("../server/frames");
const { PRICE_SUBUNIT_EXPR, floorDivExpr, toPriceSubunits: toSubunits } = require("./price-bucketing");

const STORAGE_CANDLE_INTERVAL_MS = 60_000;
function toPriceSubunits(value, field) {
  return toSubunits(value, field, "storage-reader");
}
const LARGE_TRADE_NOTIONAL_EXPR = "(CAST(price AS REAL) * CAST(size AS REAL))";
const LARGE_TRADE_ROW_COLUMNS = "id, ts, price, size, side, trade_id";

function largeTradesSql() {
  return `SELECT ${LARGE_TRADE_ROW_COLUMNS} FROM trades INDEXED BY idx_trades_notional ` +
    `WHERE symbol = ? AND market_kind = ? AND ts <= ? ` +
    `ORDER BY ${LARGE_TRADE_NOTIONAL_EXPR} DESC LIMIT ?`;
}

function timeCoveredLargeTradesSql() {
  return `SELECT ${LARGE_TRADE_ROW_COLUMNS} FROM trades INDEXED BY idx_trades_symbol_market_ts ` +
    `WHERE symbol = @symbol AND market_kind = @marketKind AND ts >= @fromMs AND ts <= @nowMs`;
}

function weakerCandidate(leftMagnitude, leftRow, rightMagnitude, rightRow) {
  if (leftMagnitude !== rightMagnitude) return leftMagnitude < rightMagnitude;
  if (leftRow.ts !== rightRow.ts) return leftRow.ts < rightRow.ts;
  return leftRow.id < rightRow.id;
}

function offerBucketCandidate(bucket, row, magnitude, perBucketSideLimit) {
  if (bucket.length < perBucketSideLimit) {
    bucket.push({ row, magnitude });
    if (bucket.length === perBucketSideLimit) {
      bucket.sort((left, right) =>
        weakerCandidate(left.magnitude, left.row, right.magnitude, right.row) ? -1 : 1);
    }
    return;
  }
  const weakest = bucket[0];
  if (!weakerCandidate(weakest.magnitude, weakest.row, magnitude, row)) return;
  bucket[0] = { row, magnitude };
  for (let index = 0; index + 1 < perBucketSideLimit; index += 1) {
    const next = bucket[index + 1];
    const current = bucket[index];
    if (!weakerCandidate(next.magnitude, next.row, current.magnitude, current.row)) break;
    bucket[index] = next;
    bucket[index + 1] = current;
  }
}

function queryLargeTradesFrom(conn, { symbol, marketKind, nowMs, limit }) {
  return conn.prepare(largeTradesSql()).all(symbol, marketKind, nowMs, limit)
    .sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

function queryTimeCoveredLargeTradesFrom(conn, options) {
  const { bucketMs, perBucketSideLimit } = options;
  const statement = conn.prepare(timeCoveredLargeTradesSql());
  const buckets = new Map();
  for (const row of statement.iterate({
    symbol: options.symbol,
    marketKind: options.marketKind,
    fromMs: options.fromMs,
    nowMs: options.nowMs,
  })) {
    const magnitude = Number(row.price) * Number(row.size);
    if (!(magnitude > 0)) continue;
    const key = Math.floor(row.ts / bucketMs) * 2 + (row.side === "buy" ? 0 : 1);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
    }
    offerBucketCandidate(bucket, row, magnitude, perBucketSideLimit);
  }
  const rows = [];
  for (const bucket of buckets.values()) {
    for (const entry of bucket) rows.push(entry.row);
  }
  return rows.sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

function mergeLargeTradeRows(rowSets) {
  const byTradeId = new Map();
  for (const rows of rowSets) {
    for (const row of rows) {
      if (!byTradeId.has(row.trade_id)) byTradeId.set(row.trade_id, row);
    }
  }
  return [...byTradeId.values()].sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

function createStorageReader({ dbPath, timeoutMs = 2000 }) {
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("storage-reader: dbPath must be a non-empty string");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("storage-reader: timeoutMs must be a non-negative integer");
  }

  let db = null;
  let closed = false;
  let unavailableLogged = false;
  const activeReadWorkers = new Map();
  let closePromise = null;

  function tryOpen() {
    if (closed || db) return db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: timeoutMs });
      unavailableLogged = false;
    } catch (error) {
      if (!unavailableLogged) {
        console.error("storage-reader: unavailable, falling back to REST", error?.message ?? error);
        unavailableLogged = true;
      }
    }
    return db;
  }

  function readRecentCandles(symbol, marketKind, { intervalMs, windowMs, nowMs = Date.now() }) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("storage-reader: intervalMs must be a positive safe integer");
    }
    if (intervalMs !== STORAGE_CANDLE_INTERVAL_MS) {
      throw new Error("storage-reader: intervalMs must match the stored one-minute candle interval");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs % intervalMs !== 0) {
      throw new Error("storage-reader: windowMs must be a positive multiple of intervalMs");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("storage-reader: nowMs must be a non-negative safe integer");
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], coversFullWindow: false };
    }
    try {
      const closedBoundary = Math.floor(nowMs / intervalMs) * intervalMs;
      const windowStart = closedBoundary - windowMs;
      const raw = conn
        .prepare(
          "SELECT ts_open, open, high, low, close, volume, trade_count, taker_buy_base_volume FROM candles " +
            "WHERE symbol = ? AND market_kind = ? AND ts_open >= ? AND ts_open < ? ORDER BY ts_open ASC",
        )
        .all(symbol, marketKind, windowStart, closedBoundary);
      const expectedCount = Math.floor((closedBoundary - windowStart) / intervalMs);
      const rowsByOpenTime = new Map();
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.ts_open) ||
          row.ts_open < windowStart ||
          row.ts_open >= closedBoundary ||
          (row.ts_open - windowStart) % intervalMs !== 0 ||
          rowsByOpenTime.has(row.ts_open)
        ) {
          continue;
        }
        try {
          rowsByOpenTime.set(row.ts_open, storageCandleRowToBarFrame(row, symbol, marketKind, "1m"));
        } catch {
          continue;
        }
      }
      const rows = [...rowsByOpenTime.values()];
      const coversFullWindow =
        rows.length === expectedCount &&
        rows.every(
          (row, index) =>
            row.ts_open === windowStart + index * intervalMs &&
            row.buy_volume !== undefined,
        );
      return { rows, coversFullWindow };
    } catch (error) {
      console.error("storage-reader: read failed, falling back to REST", error?.message ?? error);
      return { rows: [], coversFullWindow: false };
    }
  }

  function readRecentTrades(symbol, marketKind, {
    windowMs,
    nowMs = Date.now(),
    limit = null,
    sinceTs = null,
    cursor = null,
  }) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 0) {
      throw new Error("storage-reader: windowMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("storage-reader: nowMs must be a non-negative safe integer");
    }
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("storage-reader: limit must be a positive integer or null");
    }
    if (sinceTs !== null && (!Number.isSafeInteger(sinceTs) || sinceTs < 0)) {
      throw new Error("storage-reader: sinceTs must be a non-negative safe integer or null");
    }
    if (
      cursor !== null &&
      (
        typeof cursor !== "object" ||
        !Number.isSafeInteger(cursor.ts) ||
        cursor.ts < 0 ||
        !Number.isSafeInteger(cursor.id) ||
        cursor.id < 0
      )
    ) {
      throw new Error("storage-reader: cursor must contain non-negative safe-integer ts and id values or be null");
    }
    if (sinceTs !== null && cursor !== null) {
      throw new Error("storage-reader: sinceTs and cursor cannot be used together");
    }
    const conn = tryOpen();
    if (!conn) {
      return limit === null ? { rows: [], available: false } : { rows: [], nextCursor: null, available: false };
    }
    try {
      const windowStart = nowMs - windowMs;
      const lowerBound = sinceTs !== null ? Math.max(windowStart, sinceTs + 1) : windowStart;
      const cursorScanStart = cursor === null ? windowStart : Math.max(windowStart, cursor.ts);
      const querySuffix = limit === null ? "" : " LIMIT ?";
      const raw = cursor === null
        ? conn
          .prepare(
            "SELECT id, ts, price, size, side, trade_id FROM trades " +
              "WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts <= ? " +
              `ORDER BY ts ASC, id ASC${querySuffix}`,
          )
          .all(symbol, marketKind, lowerBound, nowMs, ...(limit === null ? [] : [limit]))
        : conn
          .prepare(
            "SELECT id, ts, price, size, side, trade_id FROM trades " +
              "WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts <= ? " +
              "AND (ts > ? OR (ts = ? AND id > ?)) " +
              `ORDER BY ts ASC, id ASC${querySuffix}`,
          )
          .all(
            symbol,
            marketKind,
            cursorScanStart,
            nowMs,
            cursor.ts,
            cursor.ts,
            cursor.id,
            ...(limit === null ? [] : [limit]),
          );
      const rows = [];
      for (const row of raw) {
        try {
          rows.push(storageTradeRowToTradeFrame(row, symbol, marketKind));
        } catch {
          continue;
        }
      }
      const lastRaw = raw.at(-1);
      return limit === null
        ? { rows, available: rows.length === raw.length }
        : { rows, nextCursor: lastRaw ? { ts: lastRaw.ts, id: lastRaw.id } : null, available: rows.length === raw.length };
    } catch (error) {
      console.error("storage-reader: trade read failed, falling back to no warm-up history", error?.message ?? error);
      return limit === null ? { rows: [], available: false } : { rows: [], nextCursor: null, available: false };
    }
  }

  function readLargeTrades(symbol, marketKind, {
    nowMs = Date.now(), limit,
    fromMs = null, bucketMs = null, perBucketSideLimit = null,
  }) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("storage-reader: nowMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("storage-reader: limit must be a positive safe integer");
    }
    const timeCovered = fromMs !== null || bucketMs !== null || perBucketSideLimit !== null;
    if (timeCovered) {
      if (!Number.isSafeInteger(fromMs) || fromMs < 0 || fromMs > nowMs) {
        throw new Error("storage-reader: fromMs must be a non-negative safe integer no greater than nowMs");
      }
      if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
        throw new Error("storage-reader: bucketMs must be a positive safe integer");
      }
      if (!Number.isSafeInteger(perBucketSideLimit) || perBucketSideLimit <= 0) {
        throw new Error("storage-reader: perBucketSideLimit must be a positive safe integer");
      }
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false };
    }
    try {
      const mergedRows = timeCovered
        ? queryTimeCoveredLargeTradesFrom(conn, {
          symbol, marketKind, nowMs, fromMs, bucketMs, perBucketSideLimit,
        })
        : queryLargeTradesFrom(conn, { symbol, marketKind, nowMs, limit });
      const rows = [];
      const selectedRows = timeCovered && mergedRows.length > limit
        ? mergedRows.slice(-limit)
        : mergedRows;
      for (const row of selectedRows) {
        try {
          rows.push({
            trade: storageTradeRowToTradeFrame(row, symbol, marketKind),
          });
        } catch {
          continue;
        }
      }
      return { rows, available: true };
    } catch (error) {
      console.error("storage-reader: large-trade read failed, falling back to no warm-up history", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readOnWorker(method, symbol, marketKind, options, empty, signal, propagateErrors = false) {
    if (closed) return Promise.resolve(empty);
    const requestedAt = performance.now();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "storage-reader-worker.js"), {
        workerData: { dbPath, timeoutMs, method, symbol, marketKind, options, propagateErrors },
      });
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = () => {
        settle(empty);
        void worker.terminate().catch(() => {});
      };
      activeReadWorkers.set(worker, () => settle(empty));
      worker.once("message", (result) => {
        if (propagateErrors && typeof result?.__storageReaderWorkerError === "string") {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(result.__storageReaderWorkerError));
          return;
        }
        if (result?.__storageReaderWorkerResult === true) {
          const workerTotalMs = performance.now() - requestedAt;
          const workerResult = attachReadTelemetry(result.result, {
            ...result.telemetry,
            workerTotalMs,
            workerStartupMs: Math.max(0, workerTotalMs - Number(result.telemetry?.readerSetupMs ?? 0) - Number(result.telemetry?.queryMs ?? 0)),
          });
          settle(closed ? empty : workerResult);
          return;
        }
        settle(closed ? empty : result);
      });
      worker.once("error", (error) => {
        if (propagateErrors) fail(new Error(`storage-reader: worker failed: ${error?.message ?? error}`));
        else settle(empty);
      });
      worker.once("exit", (code) => {
        activeReadWorkers.delete(worker);
        // A worker may exit successfully without ever posting a result.
        if (propagateErrors) fail(new Error(`storage-reader: worker exited without a result (code ${code})`));
        else settle(empty);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  const EMPTY_BY_METHOD = Object.freeze({
    readRecentCandles: { rows: [], coversFullWindow: false },
    readRecentTrades: { rows: [], available: false },
    readLargeTrades: { rows: [], available: false },
    readAggressivePrints: { rows: [], available: false, hasMore: false, nextCursor: null },
    readVolumeProfile: { buckets: [], available: false },
    readPriceRange: { minPrice: null, maxPrice: null, tradeCount: 0, available: false },
    readMinuteRollup: { rows: [], available: false },
    readDailyNotional: { rows: [], available: false },
    readSlicedNotional: { rows: [], available: false },
    readRecordingAge: { latestTs: null, ageMs: null, available: false },
  });

  function readAsync(method, symbol, marketKind, options, { signal } = {}) {
    const empty = EMPTY_BY_METHOD[method];
    if (empty === undefined) return Promise.reject(new Error(`storage-reader: unsupported async method ${method}`));
    return readOnWorker(method, symbol, marketKind, options, empty, signal, true);
  }

  function readAggressivePrints(symbol, marketKind, { fromMs, toMs, minSize = 0, limit, cursor = null }) {
    if (!Number.isSafeInteger(fromMs) || fromMs < 0) throw new Error("storage-reader: fromMs must be a non-negative safe integer");
    if (!Number.isSafeInteger(toMs) || toMs <= fromMs) throw new Error("storage-reader: toMs must be a safe integer after fromMs");
    if (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0) throw new Error("storage-reader: minSize must be a non-negative finite number");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("storage-reader: limit must be a positive safe integer");
    if (cursor !== null && (!cursor || !Number.isSafeInteger(cursor.ts) || cursor.ts < fromMs || cursor.ts >= toMs || !Number.isSafeInteger(cursor.id) || cursor.id <= 0)) {
      throw new Error("storage-reader: cursor must contain a row id and timestamp inside the requested window");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false, hasMore: false, nextCursor: null };
    try {
      const raw = conn
        .prepare(
          "SELECT id, ts, price, size, side, trade_id FROM trades INDEXED BY idx_trades_symbol_market_ts " +
            "WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts < ? AND CAST(size AS REAL) >= ? " +
            (cursor === null ? "" : "AND (ts < ? OR (ts = ? AND id < ?)) ") +
            "ORDER BY ts DESC, id DESC LIMIT ?",
        )
        .all(symbol, marketKind, fromMs, toMs, minSize, ...(cursor === null ? [] : [cursor.ts, cursor.ts, cursor.id]), limit + 1);
      const hasMore = raw.length > limit;
      const rows = hasMore ? raw.slice(0, limit) : raw;
      const last = rows.at(-1);
      return { rows, available: true, hasMore, nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null };
    } catch (error) {
      console.error("storage-reader: aggressive prints read failed", error?.message ?? error);
      return { rows: [], available: false, hasMore: false, nextCursor: null };
    }
  }

  function readAggressivePrintsAsync(symbol, marketKind, options, { signal } = {}) {
    return readOnWorker("readAggressivePrints", symbol, marketKind, options, { rows: [], available: false, hasMore: false, nextCursor: null }, signal, true);
  }

  function readLargeTradesAsync(symbol, marketKind, options) {
    return readOnWorker("readLargeTrades", symbol, marketKind, options, { rows: [], available: false });
  }

  function readVolumeProfileAsync(symbol, marketKind, options, { signal } = {}) {
    return readOnWorker("readVolumeProfile", symbol, marketKind, options, { buckets: [], available: false }, signal);
  }

  function readPriceRange(symbol, marketKind, { fromTs, toTs }) {
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("storage-reader: toTs must be a safe integer not before fromTs");
    }
    const conn = tryOpen();
    if (!conn) {
      return { minPrice: null, maxPrice: null, tradeCount: 0, available: false };
    }
    try {
      const row = conn
        .prepare(
          "SELECT MIN(CAST(price AS REAL)) AS lo, MAX(CAST(price AS REAL)) AS hi, COUNT(*) AS n " +
            "FROM trades INDEXED BY idx_trades_vpin_covering WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts < ?",
        )
        .get(symbol, marketKind, fromTs, toTs);
      if (!row || !Number.isSafeInteger(row.n) || row.n <= 0) {
        return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
      }
      if (!Number.isFinite(row.lo) || !Number.isFinite(row.hi) || row.hi < row.lo) {
        return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
      }
      return { minPrice: row.lo, maxPrice: row.hi, tradeCount: row.n, available: true };
    } catch (error) {
      console.error("storage-reader: price-range read failed, falling back to no price range", error?.message ?? error);
      return { minPrice: null, maxPrice: null, tradeCount: 0, available: false };
    }
  }

  function readMinuteRollup(symbol, marketKind, { fromTs, toTs, tickSize }) {
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("storage-reader: toTs must be a safe integer not before fromTs");
    }
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error("storage-reader: tickSize must be a positive finite number");
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false };
    }
    try {
      const tickSubunits = toPriceSubunits(tickSize, "tickSize");
      if (tickSubunits <= 0) {
        throw new Error("storage-reader: tickSize is finer than the representable price grid");
      }
      const raw = conn
        .prepare(
          "SELECT minute_ts, " +
            `${floorDivExpr("price_subunits", "@tickSubunits")} AS price_bucket, ` +
            "SUM(trade_size) AS volume, " +
            "SUM(CASE WHEN side = 'buy' THEN trade_size ELSE 0 END) AS buy_volume, " +
            "SUM(CASE WHEN side = 'sell' THEN trade_size ELSE 0 END) AS sell_volume, " +
            "COUNT(*) AS trade_count FROM (" +
            "SELECT ts - (ts % 60000) AS minute_ts, " +
            `${PRICE_SUBUNIT_EXPR} AS price_subunits, ` +
            "CAST(size AS REAL) AS trade_size, side FROM trades INDEXED BY idx_trades_vpin_covering " +
            "WHERE symbol = @symbol AND market_kind = @marketKind AND ts >= @fromTs AND ts < @toTs" +
            ") GROUP BY minute_ts, price_bucket",
        )
        .all({ tickSubunits, symbol, marketKind, fromTs, toTs });
      const rows = [];
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.minute_ts) || row.minute_ts < 0 ||
          !Number.isSafeInteger(row.price_bucket) ||
          !Number.isFinite(row.volume) || row.volume < 0 ||
          !Number.isFinite(row.buy_volume) || row.buy_volume < 0 ||
          !Number.isFinite(row.sell_volume) || row.sell_volume < 0 ||
          !Number.isSafeInteger(row.trade_count) || row.trade_count <= 0
        ) {
          continue;
        }
        rows.push({
          minuteTs: row.minute_ts,
          priceBucket: row.price_bucket,
          volume: row.volume,
          buyVolume: row.buy_volume,
          sellVolume: row.sell_volume,
          tradeCount: row.trade_count,
        });
      }
      return { rows, available: true };
    } catch (error) {
      console.error("storage-reader: minute-rollup read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function rawDailyNotionalRows(conn, symbol, marketKind, fromTs, toTs) {
    if (fromTs >= toTs) return [];
    const raw = conn.prepare(
      "SELECT CAST(ts / 86400000 AS INTEGER) AS day_bucket, " +
        "SUM(CAST(price AS REAL) * CAST(size AS REAL)) AS notional " +
        "FROM trades INDEXED BY idx_trades_vpin_covering " +
        "WHERE symbol = @symbol AND market_kind = @marketKind AND ts >= @fromTs AND ts < @toTs " +
        "GROUP BY day_bucket ORDER BY day_bucket ASC",
    ).all({ symbol, marketKind, fromTs, toTs });
    const rows = [];
    for (const row of raw) {
      if (!Number.isSafeInteger(row.day_bucket) || row.day_bucket < 0 || !Number.isFinite(row.notional) || row.notional < 0) continue;
      rows.push({ dayTs: row.day_bucket * 86_400_000, notional: row.notional });
    }
    return rows;
  }

  function materializedThroughExclusiveFor(conn, symbol, marketKind) {
    const watermark = conn.prepare(
      "SELECT last_trade_id FROM daily_notional_rollup_watermark WHERE symbol = ? AND market_kind = ?",
    ).get(symbol, marketKind);
    if (!watermark) return 0;
    const watermarkTrade = conn.prepare("SELECT ts FROM trades WHERE id = ?").get(watermark.last_trade_id);
    if (!watermarkTrade) return 0;
    return Math.floor(watermarkTrade.ts / 86_400_000) * 86_400_000;
  }

  function readDailyNotional(symbol, marketKind, { fromTs, toTs }) {
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("storage-reader: toTs must be a safe integer not before fromTs");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false };
    try {
      const rollupFrom = Math.ceil(fromTs / 86_400_000) * 86_400_000;
      const lastFullDayExclusive = Math.floor(toTs / 86_400_000) * 86_400_000;
      const materializedThroughExclusive = materializedThroughExclusiveFor(conn, symbol, marketKind);
      const rollupTo = Math.max(rollupFrom, Math.min(lastFullDayExclusive, materializedThroughExclusive));

      const rows = [];
      rows.push(...rawDailyNotionalRows(conn, symbol, marketKind, fromTs, Math.min(rollupFrom, toTs)));
      if (rollupFrom < rollupTo) {
        const materialized = conn.prepare(
          "SELECT day_bucket AS dayTs, notional FROM daily_notional_rollup " +
            "WHERE symbol = @symbol AND market_kind = @marketKind AND day_bucket >= @rollupFrom AND day_bucket < @rollupTo " +
            "ORDER BY day_bucket ASC",
        ).all({ symbol, marketKind, rollupFrom, rollupTo });
        for (const row of materialized) {
          if (Number.isFinite(row.notional) && row.notional >= 0) rows.push(row);
        }
      }
      rows.push(...rawDailyNotionalRows(conn, symbol, marketKind, rollupTo, toTs));
      return { rows, available: true };
    } catch (error) {
      console.error("storage-reader: daily-notional read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readSlicedNotional(symbol, marketKind, { fromTs, toTs, sliceMs }) {
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("storage-reader: toTs must be a safe integer not before fromTs");
    }
    if (!Number.isSafeInteger(sliceMs) || sliceMs <= 0) {
      throw new Error("storage-reader: sliceMs must be a positive safe integer");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false };
    try {
      const raw = conn.prepare(
        "SELECT CAST(ts / @sliceMs AS INTEGER) AS slice_bucket, " +
          "SUM(CASE WHEN side = 'buy' THEN CAST(price AS REAL) * CAST(size AS REAL) ELSE 0 END) AS buy_notional, " +
          "SUM(CASE WHEN side = 'sell' THEN CAST(price AS REAL) * CAST(size AS REAL) ELSE 0 END) AS sell_notional, " +
          "MAX(ts) AS last_ts " +
          "FROM trades INDEXED BY idx_trades_vpin_covering " +
          "WHERE symbol = @symbol AND market_kind = @marketKind AND ts >= @fromTs AND ts < @toTs " +
          "GROUP BY slice_bucket ORDER BY slice_bucket ASC",
      ).all({ sliceMs, symbol, marketKind, fromTs, toTs });
      const rows = [];
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.slice_bucket) || row.slice_bucket < 0 ||
          !Number.isFinite(row.buy_notional) || row.buy_notional < 0 ||
          !Number.isFinite(row.sell_notional) || row.sell_notional < 0 ||
          !Number.isSafeInteger(row.last_ts) || row.last_ts < fromTs || row.last_ts >= toTs
        ) {
          continue;
        }
        rows.push({ sliceTs: row.last_ts, buyNotional: row.buy_notional, sellNotional: row.sell_notional });
      }
      return { rows, available: true };
    } catch (error) {
      console.error("storage-reader: sliced-notional read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readVolumeProfile(symbol, marketKind, { fromTs, toTs, originPrice, rowWidth }) {
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs <= fromTs) {
      throw new Error("storage-reader: toTs must be a safe integer greater than fromTs");
    }
    if (!Number.isFinite(originPrice)) {
      throw new Error("storage-reader: originPrice must be a finite number");
    }
    if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
      throw new Error("storage-reader: rowWidth must be a positive finite number");
    }
    const conn = tryOpen();
    if (!conn) {
      return { buckets: [], available: false };
    }
    try {
      const originSubunits = toPriceSubunits(originPrice, "originPrice");
      const rowWidthSubunits = toPriceSubunits(rowWidth, "rowWidth");
      if (rowWidthSubunits <= 0) {
        throw new Error("storage-reader: rowWidth is finer than the representable price grid");
      }
      const raw = conn
        .prepare(
          "SELECT " +
            `${floorDivExpr("offset_subunits", "@rowWidthSubunits")} AS bucket, ` +
            "SUM(trade_size) AS volume, " +
            "SUM(CASE WHEN side = 'buy' THEN trade_size ELSE 0 END) AS buy_volume, " +
            "SUM(CASE WHEN side = 'sell' THEN trade_size ELSE 0 END) AS sell_volume, " +
            "COUNT(*) AS trade_count FROM (" +
            `SELECT ${PRICE_SUBUNIT_EXPR} - @originSubunits AS offset_subunits, ` +
            "CAST(size AS REAL) AS trade_size, side FROM trades INDEXED BY idx_trades_vpin_covering " +
            "WHERE symbol = @symbol AND market_kind = @marketKind AND ts >= @fromTs AND ts < @toTs" +
            ") GROUP BY bucket ORDER BY bucket ASC",
        )
        .all({ originSubunits, rowWidthSubunits, symbol, marketKind, fromTs, toTs });
      const buckets = [];
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.bucket) ||
          !Number.isFinite(row.volume) || row.volume < 0 ||
          !Number.isFinite(row.buy_volume) || row.buy_volume < 0 ||
          !Number.isFinite(row.sell_volume) || row.sell_volume < 0 ||
          Math.abs(row.buy_volume + row.sell_volume - row.volume) > 1e-9 ||
          !Number.isSafeInteger(row.trade_count) || row.trade_count <= 0
        ) {
          continue;
        }
        buckets.push({
          bucket: row.bucket,
          volume: row.volume,
          buyVolume: row.buy_volume,
          sellVolume: row.sell_volume,
          tradeCount: row.trade_count,
        });
      }
      return { buckets, available: true };
    } catch (error) {
      console.error("storage-reader: volume-profile read failed, falling back to no volume profile", error?.message ?? error);
      return { buckets: [], available: false };
    }
  }

  function readRecordingAge(symbol, marketKind, { nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("storage-reader: nowMs must be a non-negative safe integer");
    }
    const conn = tryOpen();
    if (!conn) {
      return { latestTs: null, ageMs: null, available: false };
    }
    try {
      const row = conn
        .prepare("SELECT MAX(ts) AS ts FROM trades WHERE symbol = ? AND market_kind = ?")
        .get(symbol, marketKind);
      const latestTs = row && Number.isSafeInteger(row.ts) ? row.ts : null;
      return { latestTs, ageMs: latestTs === null ? null : Math.max(0, nowMs - latestTs), available: true };
    } catch (error) {
      console.error("storage-reader: recording age read failed", error?.message ?? error);
      return { latestTs: null, ageMs: null, available: false };
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const cleanups = [];
    function attempt(operation) {
      try { cleanups.push(Promise.resolve(operation())); }
      catch (error) { cleanups.push(Promise.reject(error)); }
    }
    for (const [worker, cancelRead] of activeReadWorkers) {
      cancelRead();
      attempt(() => worker.terminate());
    }
    attempt(() => db?.close());
    db = null;
    Promise.allSettled(cleanups).then((results) => {
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) rejectClose(new AggregateError(errors, "storage-reader: shutdown failed"));
      else resolveClose();
    });
    return closePromise;
  }

  return Object.freeze({
    dbPath,
    readRecentCandles, readRecentTrades, readLargeTrades, readLargeTradesAsync, readVolumeProfileAsync,
    readAggressivePrints, readAggressivePrintsAsync, readRecordingAge,
    readPriceRange, readMinuteRollup, readDailyNotional, readSlicedNotional, readVolumeProfile, readAsync, close,
  });
}

module.exports = { createStorageReader, STORAGE_CANDLE_INTERVAL_MS, mergeLargeTradeRows };
