const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { createDxFeedStorageReader } = require("./dxfeed-storage-reader");

const SUPPORTED_METHODS = new Set([
  "readRecent", "readRecentCandles", "readLargeTrades", "readAggressivePrints",
  "readVolumeProfile", "readPriceRange", "readMinuteRollup", "readDailyNotional", "readSlicedNotional",
  "readTradesSince",
]);
const EMPTY_BY_METHOD = {
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
};

const method = workerData.method ?? "readLargeTrades";
let reader = null;
const workerStartedAt = performance.now();
try {
  if (!SUPPORTED_METHODS.has(method)) throw new Error(`dxfeed-storage-reader-worker: unsupported method ${method}`);
  reader = createDxFeedStorageReader({ dbPath: workerData.dbPath, timeoutMs: workerData.timeoutMs });
  const openedAt = performance.now();
  const result = method === "readRecent"
    ? reader.readRecent(
      workerData.symbol,
      workerData.assetClass,
      workerData.options?.eventType,
      { limit: workerData.options?.limit },
    )
    : reader[method](
      workerData.symbol,
      workerData.assetClass,
      workerData.options,
    );
  const completedAt = performance.now();
  parentPort.postMessage({
    __dxfeedStorageReaderWorkerResult: true,
    result,
    // The reader opens SQLite lazily on its first method call; queryMs includes
    // that open. readerSetupMs is intentionally limited to object construction.
    telemetry: { readerSetupMs: openedAt - workerStartedAt, queryMs: completedAt - openedAt },
  });
} catch (error) {
  if (workerData.propagateErrors === true) {
    parentPort.postMessage({ __dxfeedStorageReaderWorkerError: String(error?.message ?? error).slice(0, 512) });
  } else {
    parentPort.postMessage(EMPTY_BY_METHOD[method] ?? { available: false });
  }
} finally {
  reader?.close();
}
