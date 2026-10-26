const Database = require("better-sqlite3");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { attachReadTelemetry } = require("../read-telemetry");
const {
  EVENT_TYPES,
  ASSET_CLASSES,
  isAllowedAssetClass,
  isAllowedDxFeedSymbol,
} = require("../../providers/dxfeed/dxfeed-instrument-catalog");
const { tradeMagnitude } = require("../../indicators/large-trade/large-trade-detection");
const { PRICE_SUBUNIT_EXPR, floorDivExpr, toPriceSubunits: toSubunits } = require("../price-bucketing");
const { isEquityChartTime } = require("../../providers/shared/market-calendar");

const TABLE_BY_EVENT_TYPE = new Map([
  [EVENT_TYPES.QUOTE, "dxfeed_quotes"],
  [EVENT_TYPES.TRADE, "dxfeed_trades"],
  [EVENT_TYPES.TIMEANDSALE, "dxfeed_time_and_sales"],
]);
const MAX_READ_LIMIT = 10_000;
const MAX_CANDLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EQUITY_CHART_TIME_FUNCTION = "tt_equity_chart_time";
const AGGRESSIVE_PRINT_COLUMNS = "id, symbol, asset_class, event_kind, event_time, time, time_nano_part, sequence, price, size, aggressor_side, spread_leg, valid_tick";

function studyScopePredicateFor(assetClass) {
  if (assetClass === ASSET_CLASSES.FUTURE) return "AND valid_tick = 1 ";
  if (assetClass === ASSET_CLASSES.EQUITY) return `AND ${EQUITY_CHART_TIME_FUNCTION}(event_time) = 1 `;
  return "";
}

function toPriceSubunits(value, field) {
  return toSubunits(value, field, "dxfeed-storage-reader");
}

function largeTradeMagnitudeExpr(assetClass) {
  return assetClass === ASSET_CLASSES.FUTURE ? "size" : "(price * size)";
}

function largeTradesSql(assetClass) {
  const futuresValidityPredicate = assetClass === ASSET_CLASSES.FUTURE ? "AND valid_tick = 1 " : "";
  return "SELECT * FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_symbol_time " +
    "WHERE symbol = ? AND asset_class = ? AND event_time <= ? " +
    "AND event_kind = 'NEW' AND aggressor_side IN ('BUY', 'SELL') " +
    futuresValidityPredicate +
    `ORDER BY ${largeTradeMagnitudeExpr(assetClass)} DESC LIMIT ?`;
}

function timeCoveredLargeTradesSql(assetClass) {
  const futuresPredicate = assetClass === ASSET_CLASSES.FUTURE ? "AND valid_tick = 1 " : "";
  return "SELECT * FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_symbol_time " +
    `WHERE symbol = @symbol AND asset_class = '${assetClass}' AND event_time >= @fromMs AND event_time <= @nowMs ` +
    "AND event_kind = 'NEW' AND aggressor_side IN ('BUY', 'SELL') " +
    futuresPredicate;
}

function queryLargeTradesFrom(conn, { assetClass, symbol, nowMs, limit }) {
  return conn.prepare(largeTradesSql(assetClass)).all(symbol, assetClass, nowMs, limit)
    .sort((left, right) => (left.event_time - right.event_time) || (left.id - right.id));
}

function weakerCandidate(leftMagnitude, leftRow, rightMagnitude, rightRow) {
  if (leftMagnitude !== rightMagnitude) return leftMagnitude < rightMagnitude;
  if (leftRow.event_time !== rightRow.event_time) return leftRow.event_time < rightRow.event_time;
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

function queryTimeCoveredLargeTradesFrom(conn, {
  assetClass, symbol, nowMs, fromMs, bucketMs, perBucketSideLimit,
}) {
  const statement = conn.prepare(timeCoveredLargeTradesSql(assetClass));
  const buckets = new Map();
  for (const row of statement.iterate({ symbol, nowMs, fromMs })) {
    const magnitude = tradeMagnitude("DXFEED", assetClass, Number(row.price), Number(row.size));
    if (!(magnitude > 0)) continue;
    const key = Math.floor(row.event_time / bucketMs) * 2 + (row.aggressor_side === "BUY" ? 0 : 1);
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
  return rows.sort((left, right) => (left.event_time - right.event_time) || (left.id - right.id));
}

function createDxFeedStorageReader({ dbPath, timeoutMs = 2000 }) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new Error("dxfeed-storage-reader: dbPath must be a non-empty string");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("dxfeed-storage-reader: timeoutMs must be a non-negative integer");
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
      db.function(EQUITY_CHART_TIME_FUNCTION, { deterministic: true }, (eventTime) => (isEquityChartTime(Number(eventTime)) ? 1 : 0));
      unavailableLogged = false;
    } catch (error) {
      if (!unavailableLogged) {
        console.error("dxfeed-storage-reader: unavailable", error?.message ?? error);
        unavailableLogged = true;
      }
    }
    return db;
  }

  function readRecent(symbol, assetClass, eventType, { limit = 100 } = {}) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!TABLE_BY_EVENT_TYPE.has(eventType)) {
      throw new Error(
        `dxfeed-storage-reader: eventType must be one of ${[...TABLE_BY_EVENT_TYPE.keys()].join(", ")}`,
      );
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_READ_LIMIT) {
      throw new Error(`dxfeed-storage-reader: limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false };
    }
    const table = TABLE_BY_EVENT_TYPE.get(eventType);
    try {
      const rows = conn
        .prepare(`SELECT * FROM ${table} WHERE symbol = ? AND asset_class = ? ORDER BY event_time DESC, id DESC LIMIT ?`)
        .all(symbol, assetClass, limit);
      return { rows, available: true };
    } catch (error) {
      console.error("dxfeed-storage-reader: read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function queryRecentCandlesFrom(conn, { symbol, assetClass, windowStart, closedBoundary }) {
    return conn
      .prepare(
        "SELECT * FROM dxfeed_candles WHERE symbol = ? AND asset_class = ? AND ts_open >= ? AND ts_open < ? " +
        "ORDER BY ts_open ASC, trade_count DESC, id DESC",
      )
      .all(symbol, assetClass, windowStart, closedBoundary);
  }

  function mergeCandleRowSets(rowSets) {
    const seenTsOpen = new Set();
    const merged = [];
    for (const rows of rowSets) {
      for (const row of rows) {
        if (seenTsOpen.has(row.ts_open)) continue;
        seenTsOpen.add(row.ts_open);
        merged.push(row);
      }
    }
    return merged.sort((a, b) => a.ts_open - b.ts_open);
  }

  function readRecentCandles(symbol, assetClass, { intervalMs = 60_000, windowMs, nowMs } = {}) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("dxfeed-storage-reader: intervalMs must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > MAX_CANDLE_WINDOW_MS) {
      throw new Error(`dxfeed-storage-reader: windowMs must be a positive integer no greater than ${MAX_CANDLE_WINDOW_MS}`);
    }
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new Error("dxfeed-storage-reader: nowMs must be a positive safe integer");
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false, startsAtRequestedWindow: false };
    }
    const closedBoundary = Math.floor(nowMs / intervalMs) * intervalMs;
    const windowStart = closedBoundary - windowMs;
    try {
      const rowSets = [queryRecentCandlesFrom(conn, { symbol, assetClass, windowStart, closedBoundary })];
      const rows = mergeCandleRowSets(rowSets);
      const startsAtRequestedWindow = rows.length > 0 && rows[0].ts_open - windowStart < intervalMs;
      return { rows, available: true, startsAtRequestedWindow };
    } catch (error) {
      console.error("dxfeed-storage-reader: candle read failed", error?.message ?? error);
      return { rows: [], available: false, startsAtRequestedWindow: false };
    }
  }

  function readLargeTrades(symbol, assetClass, {
    nowMs, limit,
    fromMs = null, bucketMs = null, perBucketSideLimit = null,
  } = {}) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new Error("dxfeed-storage-reader: nowMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("dxfeed-storage-reader: limit must be a positive safe integer");
    }
    const timeCovered = fromMs !== null || bucketMs !== null || perBucketSideLimit !== null;
    if (timeCovered) {
      if (!Number.isSafeInteger(fromMs) || fromMs < 0 || fromMs > nowMs) {
        throw new Error("dxfeed-storage-reader: fromMs must be a non-negative safe integer no greater than nowMs");
      }
      if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
        throw new Error("dxfeed-storage-reader: bucketMs must be a positive safe integer");
      }
      if (!Number.isSafeInteger(perBucketSideLimit) || perBucketSideLimit <= 0) {
        throw new Error("dxfeed-storage-reader: perBucketSideLimit must be a positive safe integer");
      }
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false };
    }
    try {
      const selectedRows = timeCovered
        ? queryTimeCoveredLargeTradesFrom(conn, {
          assetClass, symbol, nowMs, fromMs, bucketMs, perBucketSideLimit,
        })
        : queryLargeTradesFrom(conn, { assetClass, symbol, nowMs, limit });
      const rows = (timeCovered && selectedRows.length > limit ? selectedRows.slice(-limit) : selectedRows)
        .map((row) => ({ row }));
      return { rows, available: true };
    } catch (error) {
      console.error("dxfeed-storage-reader: large-trade read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readAggressivePrints(symbol, assetClass, { fromMs, toMs, minSize = 0, limit, cursor = null }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    if (!Number.isSafeInteger(fromMs) || fromMs < 0) throw new Error("dxfeed-storage-reader: fromMs must be a non-negative safe integer");
    if (!Number.isSafeInteger(toMs) || toMs <= fromMs) throw new Error("dxfeed-storage-reader: toMs must be a safe integer after fromMs");
    if (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0) throw new Error("dxfeed-storage-reader: minSize must be a non-negative finite number");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("dxfeed-storage-reader: limit must be a positive safe integer");
    if (cursor !== null && (!cursor || !Number.isSafeInteger(cursor.ts) || cursor.ts < fromMs || cursor.ts >= toMs || !Number.isSafeInteger(cursor.id) || cursor.id <= 0)) {
      throw new Error("dxfeed-storage-reader: cursor must contain a row id and timestamp inside the requested window");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false, hasMore: false, nextCursor: null };
    const futuresValidityPredicate = assetClass === ASSET_CLASSES.FUTURE ? "AND valid_tick = 1 " : "";
    try {
      const raw = conn
        .prepare(
          `SELECT ${AGGRESSIVE_PRINT_COLUMNS} FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_symbol_time ` +
            "WHERE symbol = ? AND asset_class = ? AND event_time >= ? AND event_time < ? " +
            `AND size >= ? AND event_kind = 'NEW' ${futuresValidityPredicate}AND aggressor_side IN ('BUY', 'SELL') ` +
            (cursor === null ? "" : "AND (event_time < ? OR (event_time = ? AND id < ?)) ") +
            "ORDER BY event_time DESC, id DESC LIMIT ?",
        )
        .all(symbol, assetClass, fromMs, toMs, minSize, ...(cursor === null ? [] : [cursor.ts, cursor.ts, cursor.id]), limit + 1);
      const hasMore = raw.length > limit;
      const rows = hasMore ? raw.slice(0, limit) : raw;
      const last = rows.at(-1);
      return { rows, available: true, hasMore, nextCursor: hasMore && last ? { ts: last.event_time, id: last.id } : null };
    } catch (error) {
      console.error("dxfeed-storage-reader: aggressive prints read failed", error?.message ?? error);
      return { rows: [], available: false, hasMore: false, nextCursor: null };
    }
  }

  function readAggressivePrintsAsync(symbol, assetClass, options, { signal } = {}) {
    return readOnWorker("readAggressivePrints", symbol, assetClass, options, { rows: [], available: false, hasMore: false, nextCursor: null }, signal, true);
  }

  function readLargeTradesAsync(symbol, assetClass, options) {
    return readOnWorker("readLargeTrades", symbol, assetClass, options, { rows: [], available: false });
  }

  function readOnWorker(method, symbol, assetClass, options, empty, signal, propagateErrors = false) {
    if (closed) return Promise.resolve(empty);
    const requestedAt = performance.now();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "dxfeed-storage-reader-worker.js"), {
        workerData: { dbPath, timeoutMs, method, symbol, assetClass, options, propagateErrors },
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
        if (propagateErrors && typeof result?.__dxfeedStorageReaderWorkerError === "string") {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(result.__dxfeedStorageReaderWorkerError));
          return;
        }
        if (result?.__dxfeedStorageReaderWorkerResult === true) {
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
        if (propagateErrors) fail(new Error(`dxfeed-storage-reader: worker failed: ${error?.message ?? error}`));
        else settle(empty);
      });
      worker.once("exit", (code) => {
        activeReadWorkers.delete(worker);
        if (propagateErrors) fail(new Error(`dxfeed-storage-reader: worker exited without a result (code ${code})`));
        else settle(empty);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  const EMPTY_BY_METHOD = Object.freeze({
    readRecent: { rows: [], available: false },
    readRecentCandles: { rows: [], available: false, startsAtRequestedWindow: false },
    readLargeTrades: { rows: [], available: false },
    readVolumeProfile: { buckets: [], available: false },
    readAggressivePrints: { rows: [], available: false, hasMore: false, nextCursor: null },
    readPriceRange: { minPrice: null, maxPrice: null, tradeCount: 0, available: false },
    readMinuteRollup: { rows: [], available: false },
    readDailyNotional: { rows: [], available: false },
    readSlicedNotional: { rows: [], available: false },
    readTradesSince: { rows: [], nextCursor: null, available: false },
  });

  function readAsync(method, symbol, assetClass, options, { signal } = {}) {
    const empty = EMPTY_BY_METHOD[method];
    if (empty === undefined) return Promise.reject(new Error(`dxfeed-storage-reader: unsupported async method ${method}`));
    return readOnWorker(method, symbol, assetClass, options, empty, signal, true);
  }

  function readPriceRange(symbol, assetClass, { fromTs, toTs }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer not before fromTs");
    }
    const conn = tryOpen();
    if (!conn) {
      return { minPrice: null, maxPrice: null, tradeCount: 0, available: false };
    }
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const row = conn
        .prepare(
          "SELECT MIN(price) AS lo, MAX(price) AS hi, COUNT(*) AS n " +
            "FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering " +
            "WHERE symbol = @symbol AND asset_class = @assetClass " +
            "AND event_time >= @fromTs AND event_time < @toTs " +
            `AND event_kind = 'NEW' ${studyScopePredicate}`,
        )
        .get({ symbol, assetClass, fromTs, toTs });
      if (!row || !Number.isSafeInteger(row.n) || row.n <= 0) {
        return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
      }
      if (!Number.isFinite(row.lo) || !Number.isFinite(row.hi) || row.hi < row.lo) {
        return { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
      }
      return { minPrice: row.lo, maxPrice: row.hi, tradeCount: row.n, available: true };
    } catch (error) {
      console.error("dxfeed-storage-reader: price-range read failed", error?.message ?? error);
      return { minPrice: null, maxPrice: null, tradeCount: 0, available: false };
    }
  }

  function readMinuteRollup(symbol, assetClass, { fromTs, toTs, tickSize }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer not before fromTs");
    }
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error("dxfeed-storage-reader: tickSize must be a positive finite number");
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], available: false };
    }
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const tickSubunits = toPriceSubunits(tickSize, "tickSize");
      if (tickSubunits <= 0) {
        throw new Error("dxfeed-storage-reader: tickSize is finer than the representable price grid");
      }
      const raw = conn
        .prepare(
          "SELECT event_time - (event_time % 60000) AS minute_ts, " +
            `${floorDivExpr(PRICE_SUBUNIT_EXPR, "@tickSubunits")} AS price_bucket, ` +
            "SUM(size) AS volume, " +
            "SUM(CASE WHEN aggressor_side = 'BUY' THEN size ELSE 0 END) AS buy_volume, " +
            "SUM(CASE WHEN aggressor_side = 'SELL' THEN size ELSE 0 END) AS sell_volume, " +
            "COUNT(*) AS trade_count " +
            "FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering " +
            "WHERE symbol = @symbol AND asset_class = @assetClass " +
            "AND event_time >= @fromTs AND event_time < @toTs " +
            `AND event_kind = 'NEW' ${studyScopePredicate}GROUP BY minute_ts, price_bucket`,
        )
        .all({ tickSubunits, symbol, assetClass, fromTs, toTs });
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
      console.error("dxfeed-storage-reader: minute-rollup read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readDailyNotional(symbol, assetClass, { fromTs, toTs }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer not before fromTs");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false };
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const raw = conn.prepare(
        "SELECT CAST(event_time / 86400000 AS INTEGER) AS day_bucket, " +
          "SUM(price * size) AS notional " +
          "FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering " +
          "WHERE symbol = @symbol AND asset_class = @assetClass " +
          "AND event_time >= @fromTs AND event_time < @toTs " +
          `AND event_kind = 'NEW' ${studyScopePredicate}AND aggressor_side IN ('BUY', 'SELL') ` +
          "GROUP BY day_bucket ORDER BY day_bucket ASC",
      ).all({ symbol, assetClass, fromTs, toTs });
      const rows = [];
      for (const row of raw) {
        if (!Number.isSafeInteger(row.day_bucket) || row.day_bucket < 0 || !Number.isFinite(row.notional) || row.notional < 0) continue;
        rows.push({ dayTs: row.day_bucket * 86_400_000, notional: row.notional });
      }
      return { rows, available: true };
    } catch (error) {
      console.error("dxfeed-storage-reader: daily-notional read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readSlicedNotional(symbol, assetClass, { fromTs, toTs, sliceMs }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer not before fromTs");
    }
    if (!Number.isSafeInteger(sliceMs) || sliceMs <= 0) {
      throw new Error("dxfeed-storage-reader: sliceMs must be a positive safe integer");
    }
    const conn = tryOpen();
    if (!conn) return { rows: [], available: false };
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const raw = conn.prepare(
        "SELECT CAST(event_time / @sliceMs AS INTEGER) AS slice_bucket, " +
          "SUM(CASE WHEN aggressor_side = 'BUY' THEN price * size ELSE 0 END) AS buy_notional, " +
          "SUM(CASE WHEN aggressor_side = 'SELL' THEN price * size ELSE 0 END) AS sell_notional, " +
          "MAX(event_time) AS last_ts " +
          "FROM dxfeed_time_and_sales INDEXED BY idx_dxfeed_time_and_sales_vpin_covering " +
          "WHERE symbol = @symbol AND asset_class = @assetClass " +
          "AND event_time >= @fromTs AND event_time < @toTs " +
          `AND event_kind = 'NEW' ${studyScopePredicate}AND aggressor_side IN ('BUY', 'SELL') ` +
          "GROUP BY slice_bucket ORDER BY slice_bucket ASC",
      ).all({ sliceMs, symbol, assetClass, fromTs, toTs });
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
      console.error("dxfeed-storage-reader: sliced-notional read failed", error?.message ?? error);
      return { rows: [], available: false };
    }
  }

  function readVolumeProfile(symbol, assetClass, { fromTs, toTs, originPrice, rowWidth }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs <= fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer greater than fromTs");
    }
    if (!Number.isFinite(originPrice)) {
      throw new Error("dxfeed-storage-reader: originPrice must be a finite number");
    }
    if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
      throw new Error("dxfeed-storage-reader: rowWidth must be a positive finite number");
    }
    const conn = tryOpen();
    if (!conn) {
      return { buckets: [], available: false };
    }
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const originSubunits = toPriceSubunits(originPrice, "originPrice");
      const rowWidthSubunits = toPriceSubunits(rowWidth, "rowWidth");
      if (rowWidthSubunits <= 0) {
        throw new Error("dxfeed-storage-reader: rowWidth is finer than the representable price grid");
      }
      const raw = conn
        .prepare(
          "SELECT " +
            `${floorDivExpr("price_subunits - @originSubunits", "@rowWidthSubunits")} AS bucket, ` +
            "SUM(size) AS volume, " +
            "SUM(CASE WHEN aggressor_side = 'BUY' THEN size ELSE 0 END) AS buy_volume, " +
            "SUM(CASE WHEN aggressor_side = 'SELL' THEN size ELSE 0 END) AS sell_volume, " +
            "COUNT(*) AS trade_count " +
            "FROM (SELECT " +
            `${PRICE_SUBUNIT_EXPR} AS price_subunits, size, aggressor_side FROM dxfeed_time_and_sales ` +
            "INDEXED BY idx_dxfeed_time_and_sales_vpin_covering " +
            "WHERE symbol = @symbol AND asset_class = @assetClass " +
            "AND event_time >= @fromTs AND event_time < @toTs " +
            `AND event_kind = 'NEW' ${studyScopePredicate}) GROUP BY bucket ORDER BY bucket ASC`,
        )
        .all({ originSubunits, rowWidthSubunits, symbol, assetClass, fromTs, toTs });
      const buckets = [];
      for (const row of raw) {
        if (
          !Number.isSafeInteger(row.bucket) ||
          !Number.isFinite(row.volume) || row.volume < 0 ||
          !Number.isFinite(row.buy_volume) || row.buy_volume < 0 ||
          !Number.isFinite(row.sell_volume) || row.sell_volume < 0 ||
          row.buy_volume + row.sell_volume > row.volume + 1e-9 ||
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
      console.error("dxfeed-storage-reader: volume-profile read failed", error?.message ?? error);
      return { buckets: [], available: false };
    }
  }

  function readTradesSince(symbol, assetClass, { fromTs, toTs, cursor = null, limit }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol !== symbol.trim()) {
      throw new Error("dxfeed-storage-reader: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-storage-reader: assetClass must be FUTURE or EQUITY");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-storage-reader: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
      throw new Error("dxfeed-storage-reader: fromTs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
      throw new Error("dxfeed-storage-reader: toTs must be a safe integer not before fromTs");
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
      throw new Error("dxfeed-storage-reader: cursor must contain non-negative safe-integer ts and id values or be null");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_READ_LIMIT) {
      throw new Error(`dxfeed-storage-reader: limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
    }
    const conn = tryOpen();
    if (!conn) {
      return { rows: [], nextCursor: null, available: false };
    }
    const studyScopePredicate = studyScopePredicateFor(assetClass);
    try {
      const scanFromTs =
        cursor === null ? fromTs : Math.max(fromTs, cursor.ts);
      const raw = cursor === null
        ? conn
          .prepare(
            "SELECT * FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? " +
              "AND event_time >= ? AND event_time < ? AND event_kind = 'NEW' " +
              `${studyScopePredicate}ORDER BY event_time ASC, id ASC LIMIT ?`,
          )
          .all(symbol, assetClass, fromTs, toTs, limit)
        : conn
          .prepare(
            "SELECT * FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? " +
              "AND event_time >= ? AND event_time < ? AND event_kind = 'NEW' " +
              `${studyScopePredicate}AND (event_time > ? OR (event_time = ? AND id > ?)) ` +
              "ORDER BY event_time ASC, id ASC LIMIT ?",
          )
          .all(symbol, assetClass, scanFromTs, toTs, cursor.ts, cursor.ts, cursor.id, limit);
      const lastRaw = raw.at(-1);
      return {
        rows: raw,
        nextCursor: lastRaw ? { ts: lastRaw.event_time, id: lastRaw.id } : null,
        available: true,
      };
    } catch (error) {
      console.error("dxfeed-storage-reader: trade-since read failed", error?.message ?? error);
      return { rows: [], nextCursor: null, available: false };
    }
  }

  function countAll() {
    const conn = tryOpen();
    if (!conn) return null;
    try {
      return {
        quotes: conn.prepare("SELECT COUNT(*) AS n FROM dxfeed_quotes").get().n,
        trades: conn.prepare("SELECT COUNT(*) AS n FROM dxfeed_trades").get().n,
        orderBookCapture: conn.prepare("SELECT COUNT(*) AS n FROM dxfeed_order_book_capture").get().n,
        timeAndSales: conn.prepare("SELECT COUNT(*) AS n FROM dxfeed_time_and_sales").get().n,
        candles: conn.prepare("SELECT COUNT(*) AS n FROM dxfeed_candles").get().n,
      };
    } catch (error) {
      console.error("dxfeed-storage-reader: count failed", error?.message ?? error);
      return null;
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
      if (errors.length > 0) rejectClose(new AggregateError(errors, "dxfeed-storage-reader: shutdown failed"));
      else resolveClose();
    });
    return closePromise;
  }

  return Object.freeze({
    dbPath,
    readRecent, readRecentCandles, readLargeTrades, readLargeTradesAsync, readAggressivePrints, readAggressivePrintsAsync, readPriceRange, readMinuteRollup, readSlicedNotional,
    readDailyNotional,
    readVolumeProfile, readTradesSince, readAsync, countAll, close,
  });
}

module.exports = {
  createDxFeedStorageReader, MAX_READ_LIMIT, MAX_CANDLE_WINDOW_MS,
};
