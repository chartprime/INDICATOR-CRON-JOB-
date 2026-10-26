const DEFAULT_MAX_PENDING_ITEMS = 50_000;
const DEFAULT_MAX_BATCH_ITEMS = 1_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 5_000;

function retryableWriteError(error) {
  return error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED";
}

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`storage-write-queue: ${name} must be a positive safe integer`);
  }
}

function createStorageWriteQueue({
  storageDb,
  maxPendingItems = DEFAULT_MAX_PENDING_ITEMS,
  maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
  maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  onFatalError = null,
} = {}) {
  if (!storageDb || typeof storageDb.insert !== "function" || typeof storageDb.raw?.transaction !== "function") {
    throw new Error("storage-write-queue: storageDb must expose insert() and raw.transaction()");
  }
  for (const [name, value] of [
    ["maxPendingItems", maxPendingItems],
    ["maxBatchItems", maxBatchItems],
    ["maxRetryAttempts", maxRetryAttempts],
    ["retryBaseDelayMs", retryBaseDelayMs],
  ]) {
    assertPositiveInteger(name, value);
  }
  if (onFatalError !== null && typeof onFatalError !== "function") {
    throw new Error("storage-write-queue: onFatalError must be a function when provided");
  }

  const queue = [];
  let scheduledHandle = null;
  let scheduledWithTimeout = false;
  let stopped = false;
  let failure = null;
  let retryAttempt = 0;
  let runBatch = null;

  function notifyFatal(error) {
    if (failure) return;
    failure = error;
    console.error("storage-write-queue: storage is no longer writable", error?.message ?? error);
    try {
      onFatalError?.(error);
    } catch (callbackError) {
      console.error("storage-write-queue: fatal-error callback failed", callbackError?.message ?? callbackError);
    }
  }

  function clearScheduledDrain() {
    if (scheduledHandle === null) return;
    if (scheduledWithTimeout) clearTimeout(scheduledHandle);
    else clearImmediate(scheduledHandle);
    scheduledHandle = null;
    scheduledWithTimeout = false;
  }

  function scheduleDrain(delayMs = 0) {
    if (scheduledHandle !== null || stopped || failure) return;
    const run = () => {
      scheduledHandle = null;
      scheduledWithTimeout = false;
      drainOnce();
    };
    if (delayMs > 0) {
      scheduledWithTimeout = true;
      scheduledHandle = setTimeout(run, delayMs);
      scheduledHandle.unref?.();
      return;
    }
    scheduledHandle = setImmediate(run);
  }

  function batchWriter() {
    if (!runBatch) {
      runBatch = storageDb.raw.transaction((items) => {
        for (const item of items) {
          storageDb.insert(item.table, item.record);
        }
      });
    }
    return runBatch;
  }

  function retryDelayMs() {
    return Math.min(retryBaseDelayMs * 2 ** (retryAttempt - 1), MAX_RETRY_DELAY_MS);
  }

  function drainOnce({ duringStop = false } = {}) {
    if (failure) {
      if (duringStop) throw failure;
      return 0;
    }
    if (queue.length === 0) return 0;
    const batch = queue.splice(0, maxBatchItems);
    try {
      batchWriter()(batch);
      retryAttempt = 0;
      if (queue.length > 0 && !duringStop) scheduleDrain();
      return batch.length;
    } catch (error) {
      queue.unshift(...batch);
      if (duringStop || !retryableWriteError(error)) {
        notifyFatal(error);
        if (duringStop) throw error;
        return 0;
      }
      retryAttempt += 1;
      if (retryAttempt > maxRetryAttempts) {
        notifyFatal(error);
        return 0;
      }
      console.error(
        `storage-write-queue: batch write deferred after retryable SQLite failure (attempt ${retryAttempt}/${maxRetryAttempts})`,
        error?.message ?? error,
      );
      scheduleDrain(retryDelayMs());
      return 0;
    }
  }

  function push(table, record) {
    if (stopped) {
      throw new Error("storage-write-queue: cannot enqueue after stop");
    }
    if (failure) {
      throw new Error("storage-write-queue: cannot enqueue after a fatal storage failure");
    }
    if (queue.length >= maxPendingItems) {
      const error = new Error(`storage-write-queue: pending-write limit (${maxPendingItems}) exceeded`);
      notifyFatal(error);
      throw error;
    }
    queue.push({ table, record });
    scheduleDrain();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearScheduledDrain();
    while (queue.length > 0) {
      drainOnce({ duringStop: true });
    }
  }

  function pendingCount() {
    return queue.length;
  }

  function isHealthy() {
    return failure === null;
  }

  return Object.freeze({ push, drainOnce, stop, pendingCount, isHealthy });
}

module.exports = {
  createStorageWriteQueue,
  DEFAULT_MAX_PENDING_ITEMS,
  DEFAULT_MAX_BATCH_ITEMS,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
};
