const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { createStorageReader } = require("./storage-reader");

const SUPPORTED_METHODS = new Set([
  "readRecentCandles", "readRecentTrades", "readLargeTrades", "readAggressivePrints",
  "readVolumeProfile", "readPriceRange", "readMinuteRollup", "readDailyNotional",
  "readSlicedNotional", "readRecordingAge",
]);
const EMPTY_BY_METHOD = {
  readRecentCandles: { rows: [], coversFullWindow: false },
  readRecentTrades: { rows: [], available: false },
  readLargeTrades: { rows: [], available: false },
  readVolumeProfile: { buckets: [], available: false },
  readAggressivePrints: { rows: [], available: false, hasMore: false, nextCursor: null },
  readPriceRange: { minPrice: null, maxPrice: null, tradeCount: 0, available: false },
  readMinuteRollup: { rows: [], available: false },
  readDailyNotional: { rows: [], available: false },
  readSlicedNotional: { rows: [], available: false },
  readRecordingAge: { latestTs: null, ageMs: null, available: false },
};

const method = workerData.method ?? "readLargeTrades";
let reader = null;
const workerStartedAt = performance.now();
try {
  if (!SUPPORTED_METHODS.has(method)) throw new Error(`storage-reader-worker: unsupported method ${method}`);
  reader = createStorageReader({ dbPath: workerData.dbPath, timeoutMs: workerData.timeoutMs });
  const openedAt = performance.now();
  const result = reader[method](workerData.symbol, workerData.marketKind, workerData.options);
  const completedAt = performance.now();
  parentPort.postMessage({
    __storageReaderWorkerResult: true,
    result,
    // createStorageReader opens SQLite lazily, so queryMs includes the first
    // connection open. Do not mislabel reader construction as database-open time.
    telemetry: { readerSetupMs: openedAt - workerStartedAt, queryMs: completedAt - openedAt },
  });
} catch (error) {
  if (workerData.propagateErrors === true) {
    parentPort.postMessage({ __storageReaderWorkerError: String(error?.message ?? error).slice(0, 512) });
  } else {
    parentPort.postMessage(EMPTY_BY_METHOD[method] ?? { available: false });
  }
} finally {
  reader?.close();
}
