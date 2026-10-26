const { parentPort, workerData } = require("node:worker_threads");
const { createStorageReader } = require("../../storage/storage-reader");
const {
  createDxFeedStorageReader,
} = require("../../storage/dxfeed/dxfeed-storage-reader");
const {
  createBinanceVolumeProfileAdapter,
  createDxFeedVolumeProfileAdapter,
} = require("./volume-profile-adapters");
const { createVolumeProfileCache } = require("./volume-profile-cache");
const { buildHistoricalProfiles } = require("./volume-profile-history");
const { createVolumeProfileAtrReference } = require("./volume-profile-atr");

function assertInput(input) {
  if (!input || typeof input !== "object")
    throw new Error("volume-profile-history-worker: workerData is required");
  if (input.provider !== "BINANCE" && input.provider !== "DXFEED")
    throw new Error("volume-profile-history-worker: provider is invalid");
  for (const field of [
    "storageDbPath",
    "cacheDbPath",
    "symbol",
    "instrument",
  ]) {
    if (typeof input[field] !== "string" || input[field].length === 0)
      throw new Error(`volume-profile-history-worker: ${field} is required`);
  }
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0)
    throw new Error("volume-profile-history-worker: tickSize is invalid");
  if (!Number.isSafeInteger(input.periodMs) || input.periodMs <= 0)
    throw new Error("volume-profile-history-worker: periodMs is invalid");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
    throw new Error("volume-profile-history-worker: nowMs is invalid");
  if (!Array.isArray(input.ranges) || input.ranges.length === 0)
    throw new Error("volume-profile-history-worker: ranges are required");
}

async function run(input) {
  assertInput(input);
  const cache = createVolumeProfileCache({ dbPath: input.cacheDbPath });
  const reader =
    input.provider === "BINANCE"
      ? createStorageReader({ dbPath: input.storageDbPath })
      : createDxFeedStorageReader({ dbPath: input.storageDbPath });
  try {
    const adapter =
      input.provider === "BINANCE"
        ? createBinanceVolumeProfileAdapter(
            reader,
            input.symbol,
            input.marketKind,
          )
        : createDxFeedVolumeProfileAdapter(
            reader,
            input.symbol,
            input.assetClass,
          );
    // The worker owns its reader, so it measures the volatility reading itself
    // rather than taking one from the parent thread -- that is the reason this
    // work was moved off the relay's event loop in the first place.
    const atrReading = await createVolumeProfileAtrReference().getReading(
      input.instrument,
      {
        readCandles: (options) => adapter.readCandles(options),
        readPriceRange: (window) =>
          adapter.readPriceRange(window.fromTs, window.toTs),
      },
    );
    return await buildHistoricalProfiles({
      cache,
      adapter,
      instrument: input.instrument,
      tickSize: input.tickSize,
      ranges: input.ranges,
      periodMs: input.periodMs,
      binSizeMultiplier: input.binSizeMultiplier,
      atrReading,
      nowMs: input.nowMs,
    });
  } finally {
    reader.close();
    cache.close();
  }
}

run(workerData).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) =>
    parentPort.postMessage({
      ok: false,
      error: error?.message ?? String(error),
    }),
);
