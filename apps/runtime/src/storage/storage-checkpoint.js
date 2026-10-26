const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DEEP_CYCLE_EVERY = 48;
const DEFAULT_INCREMENTAL_VACUUM_PAGES = 500;

function checkpointMetrics(result, mode) {
  const row = Array.isArray(result) ? result[0] : result;
  const numeric = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return Object.freeze({
    mode,
    busy: numeric(row?.busy),
    logFrames: numeric(row?.log),
    checkpointedFrames: numeric(row?.checkpointed),
  });
}

function runCheckpointCycle(storageDb, { incrementalVacuumPages = DEFAULT_INCREMENTAL_VACUUM_PAGES, deep = false } = {}) {
  if (!storageDb || typeof storageDb.raw !== "object" || storageDb.raw === null) {
    throw new Error("storage-checkpoint: storageDb must expose a raw better-sqlite3 handle");
  }
  if (!Number.isSafeInteger(incrementalVacuumPages) || incrementalVacuumPages <= 0) {
    throw new Error("storage-checkpoint: incrementalVacuumPages must be a positive safe integer");
  }
  const mode = deep ? "TRUNCATE" : "PASSIVE";
  const checkpointResult = storageDb.raw.pragma(`wal_checkpoint(${mode})`);
  if (deep) {
    storageDb.raw.pragma(`incremental_vacuum(${incrementalVacuumPages})`);
  }
  return checkpointMetrics(checkpointResult, mode);
}

function createStorageCheckpoint({
  storageDb,
  intervalMs = DEFAULT_INTERVAL_MS,
  deepCycleEvery = DEFAULT_DEEP_CYCLE_EVERY,
  incrementalVacuumPages = DEFAULT_INCREMENTAL_VACUUM_PAGES,
  onError = null,
  onResult = null,
} = {}) {
  if (!storageDb || typeof storageDb.raw !== "object" || storageDb.raw === null) {
    throw new Error("storage-checkpoint: storageDb must expose a raw better-sqlite3 handle");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("storage-checkpoint: intervalMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(deepCycleEvery) || deepCycleEvery <= 0) {
    throw new Error("storage-checkpoint: deepCycleEvery must be a positive safe integer");
  }
  if (!Number.isSafeInteger(incrementalVacuumPages) || incrementalVacuumPages <= 0) {
    throw new Error("storage-checkpoint: incrementalVacuumPages must be a positive safe integer");
  }
  if (onError !== null && typeof onError !== "function") {
    throw new Error("storage-checkpoint: onError must be a function when provided");
  }
  if (onResult !== null && typeof onResult !== "function") {
    throw new Error("storage-checkpoint: onResult must be a function when provided");
  }
  let timer = null;
  let cycleCount = 0;

  function runOnce() {
    cycleCount += 1;
    const deep = cycleCount % deepCycleEvery === 0;
    return Object.freeze({
      deep,
      ...runCheckpointCycle(storageDb, { incrementalVacuumPages, deep }),
    });
  }

  function runScheduledCycle() {
    try {
      const result = runOnce();
      onResult?.(result);
    } catch (error) {
      console.error("storage-checkpoint: scheduled checkpoint failed", error?.message ?? error);
      try {
        onError?.(error);
      } catch (callbackError) {
        console.error("storage-checkpoint: error callback failed", callbackError?.message ?? callbackError);
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(runScheduledCycle, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return Object.freeze({ start, stop, runOnce });
}

module.exports = {
  runCheckpointCycle,
  createStorageCheckpoint,
  DEFAULT_INTERVAL_MS,
  DEFAULT_DEEP_CYCLE_EVERY,
  DEFAULT_INCREMENTAL_VACUUM_PAGES,
};
