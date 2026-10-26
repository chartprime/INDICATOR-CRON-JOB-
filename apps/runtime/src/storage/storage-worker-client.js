const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { Worker } = require("node:worker_threads");

const DEFAULT_MAX_PENDING_ITEMS = 100_000;
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BATCH_ITEMS = 1_000;
const DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_BATCHES = 1;
const DEFAULT_BATCH_FLUSH_INTERVAL_MS = 5;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_STALL_TIMEOUT_MS = 45_000;
const METRIC_SAMPLE_LIMIT = 4_096;

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`storage-worker-client: ${name} must be a positive safe integer`);
  }
}

function estimateRecordBytes(table, record) {
  let total = Buffer.byteLength(table, "utf8") + 64;
  for (const value of Object.values(record)) {
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
    else total += 16;
  }
  return total;
}

function errorFromWorker(value, fallback) {
  const error = new Error(value?.message ?? fallback);
  if (typeof value?.code === "string") error.code = value.code;
  if (typeof value?.stack === "string") error.stack = value.stack;
  return error;
}

function createRollingMetric(limit = METRIC_SAMPLE_LIMIT) {
  const values = new Array(limit);
  let count = 0;
  let cursor = 0;

  function record(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return;
    values[cursor] = numeric;
    cursor = (cursor + 1) % limit;
    count = Math.min(count + 1, limit);
  }

  function percentile(percent) {
    if (count === 0) return 0;
    const sorted = values.slice(0, count).sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
    return Number(sorted[Math.max(0, index)].toFixed(1));
  }

  return Object.freeze({ record, percentile, count: () => count });
}

function createStorageWorkerClient({
  dbPath,
  maxPendingItems = DEFAULT_MAX_PENDING_ITEMS,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  maxInFlightBatches = DEFAULT_MAX_IN_FLIGHT_BATCHES,
  batchFlushIntervalMs = DEFAULT_BATCH_FLUSH_INTERVAL_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  writeStallTimeoutMs = DEFAULT_WRITE_STALL_TIMEOUT_MS,
  workerFile = path.join(__dirname, "storage-worker-thread.js"),
  onFatalError = null,
  onTelemetry = null,
} = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:") {
    throw new Error("storage-worker-client: dbPath must identify a file-backed database");
  }
  for (const [name, value] of [
    ["maxPendingItems", maxPendingItems],
    ["maxPendingBytes", maxPendingBytes],
    ["maxBatchItems", maxBatchItems],
    ["maxBatchBytes", maxBatchBytes],
    ["maxInFlightBatches", maxInFlightBatches],
    ["batchFlushIntervalMs", batchFlushIntervalMs],
    ["readyTimeoutMs", readyTimeoutMs],
    ["writeStallTimeoutMs", writeStallTimeoutMs],
  ]) assertPositiveInteger(name, value);
  if (onFatalError !== null && typeof onFatalError !== "function") {
    throw new Error("storage-worker-client: onFatalError must be a function when provided");
  }
  if (onTelemetry !== null && typeof onTelemetry !== "function") {
    throw new Error("storage-worker-client: onTelemetry must be a function when provided");
  }

  const worker = new Worker(workerFile, { workerData: { dbPath } });
  const buffered = [];
  const inFlight = new Map();
  let bufferedHead = 0;
  let nextBatchId = 1;
  let pendingItems = 0;
  let pendingBytes = 0;
  let pendingItemsHighWaterMark = 0;
  let pendingBytesHighWaterMark = 0;
  let ready = false;
  let stopping = false;
  let shutdownSent = false;
  let stopped = false;
  let failure = null;
  let stopPromise = null;
  let resolveStop = null;
  let rejectStop = null;
  let resolveReady = null;
  let rejectReady = null;
  let writtenItems = 0;
  let commitCount = 0;
  let lastCommitDurationMs = 0;
  let maxCommitDurationMs = 0;
  let lastAckLatencyMs = 0;
  let maxAckLatencyMs = 0;
  const commitDurationMetric = createRollingMetric();
  const ackLatencyMetric = createRollingMetric();
  let lastMaintenance = null;
  const lastMaintenanceByName = {};
  let lastAckAt = null;
  let flushTimer = null;
  let readyTimer = null;
  let stallTimer = null;
  let stallCheckScheduled = false;
  let workerTermination = null;
  let shutdownTimer = null;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void readyPromise.catch(() => {});

  function emit(entry) {
    try {
      onTelemetry?.(Object.freeze(entry));
    } catch {
      void 0;
    }
  }

  function terminateWorker() {
    if (workerTermination) return workerTermination;
    workerTermination = Promise.resolve()
      .then(() => worker.terminate())
      .catch(() => undefined);
    return workerTermination;
  }

  function settleStopFailure() {
    if (!failure || !rejectStop) return;
    void terminateWorker().finally(() => rejectStop(failure));
  }

  function notifyFatal(error) {
    if (failure) return;
    failure = error;
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    clearFlushTimer();
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    emit({
      event: "storage.worker.fatal",
      reason: error.message,
      ts: new Date().toISOString(),
    });
    try {
      onFatalError?.(error);
    } catch {
      void 0;
    }
    rejectReady?.(error);
    settleStopFailure();
    void terminateWorker();
  }

  readyTimer = setTimeout(() => {
    notifyFatal(new Error(`storage-worker-client: worker did not become ready within ${readyTimeoutMs}ms`));
  }, readyTimeoutMs);

  function oldestInFlightBatch() {
    let selected = null;
    for (const [id, batch] of inFlight.entries()) {
      if (selected === null || batch.sentAt < selected.batch.sentAt) selected = { id, batch };
    }
    return selected;
  }

  function enrichWorkerFailure(error, code, exitCode = null) {
    const enriched = error instanceof Error ? error : new Error(String(error));
    if (typeof enriched.code !== "string") enriched.code = code;
    if (exitCode !== null) enriched.workerExitCode = exitCode;
    const oldest = oldestInFlightBatch();
    if (oldest) {
      enriched.batchId = oldest.id;
      enriched.itemCount = oldest.batch.itemCount;
      enriched.bytes = oldest.batch.bytes;
      enriched.phase = oldest.batch.startedAt === null ? "QUEUED" : "WRITING";
    }
    return enriched;
  }

  function failForStalledBatch(batchId) {
    if (failure || stopped || inFlight.size === 0) return;
    const batch = inFlight.get(batchId);
    if (!batch) return;
    const oldest = oldestInFlightBatch();
    if (!oldest || oldest.id !== batchId) return;
    const ageMs = Math.max(0, performance.now() - oldest.batch.sentAt);
    if (ageMs < writeStallTimeoutMs) return;
    const error = new Error(
      `storage-worker-client: worker did not acknowledge batch ${oldest.id} within ${writeStallTimeoutMs}ms`,
    );
    error.code = "STORAGE_WORKER_WRITE_STALL";
    error.batchId = oldest.id;
    error.itemCount = oldest.batch.itemCount;
    error.bytes = oldest.batch.bytes;
    error.ageMs = Number(ageMs.toFixed(1));
    error.phase = oldest.batch.startedAt === null ? "QUEUED" : "WRITING";
    notifyFatal(error);
  }

  function monitorWriteStall() {
    if (failure || stopped || stallCheckScheduled || inFlight.size === 0) return;
    const oldest = oldestInFlightBatch();
    if (!oldest) return;
    const ageMs = Math.max(0, performance.now() - oldest.batch.sentAt);
    if (ageMs < writeStallTimeoutMs) return;
    stallCheckScheduled = true;
    setImmediate(() => {
      stallCheckScheduled = false;
      failForStalledBatch(oldest.id);
    });
  }

  stallTimer = setInterval(monitorWriteStall, Math.min(1_000, writeStallTimeoutMs));
  stallTimer.unref?.();

  function compactBuffered() {
    if (bufferedHead >= 1024 && bufferedHead * 2 >= buffered.length) {
      buffered.splice(0, bufferedHead);
      bufferedHead = 0;
    }
  }

  function maybeShutdown() {
    if (!stopping || shutdownSent || failure || !ready || pendingItems !== 0) return;
    shutdownSent = true;
    shutdownTimer = setTimeout(() => {
      const error = new Error(`storage-worker-client: worker did not exit within ${writeStallTimeoutMs}ms of shutdown`);
      error.code = "STORAGE_WORKER_SHUTDOWN_STALL";
      notifyFatal(error);
    }, writeStallTimeoutMs);
    try {
      worker.postMessage({ type: "shutdown" });
    } catch (error) {
      notifyFatal(error);
    }
  }

  function clearFlushTimer() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush() {
    if (flushTimer || stopping || failure || stopped || bufferedHead >= buffered.length) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      pump(true);
    }, batchFlushIntervalMs);
    flushTimer.unref?.();
  }

  function pump(force = false) {
    if (!ready || (stopping && pendingItems === 0) || failure || stopped) {
      maybeShutdown();
      return;
    }
    while (inFlight.size < maxInFlightBatches && bufferedHead < buffered.length) {
      if (!force && buffered.length - bufferedHead < maxBatchItems) {
        scheduleFlush();
        break;
      }
      const batch = [];
      let batchBytes = 0;
      let oldestAcceptedAt = 0;
      while (bufferedHead < buffered.length && batch.length < maxBatchItems) {
        const item = buffered[bufferedHead];
        if (batch.length > 0 && batchBytes + item.bytes > maxBatchBytes) break;
        bufferedHead += 1;
        if (batch.length === 0) oldestAcceptedAt = item.acceptedAt;
        batch.push({ table: item.table, record: item.record });
        batchBytes += item.bytes;
      }
      compactBuffered();
      const id = nextBatchId;
      nextBatchId += 1;
      inFlight.set(id, {
        itemCount: batch.length,
        bytes: batchBytes,
        oldestAcceptedAt,
        sentAt: performance.now(),
        startedAt: null,
      });
      try {
        worker.postMessage({ type: "write", id, items: batch });
      } catch (error) {
        notifyFatal(error);
        return;
      }
    }
    if (!force && bufferedHead < buffered.length) scheduleFlush();
    maybeShutdown();
  }

  worker.on("message", (message) => {
    if (message?.type === "initializing") {
      emit({
        event: "storage.worker.initializing",
        stage: typeof message.stage === "string" ? message.stage : "unknown",
        ts: new Date().toISOString(),
      });
      return;
    }
    if (message?.type === "ready") {
      ready = true;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      resolveReady?.();
      emit({ event: "storage.worker.ready", ts: new Date().toISOString() });
      pump(true);
      return;
    }
    if (message?.type === "ack") {
      const batch = inFlight.get(message.id);
      if (!batch) {
        notifyFatal(new Error(`storage-worker-client: unknown acknowledgement ${String(message.id)}`));
        return;
      }
      inFlight.delete(message.id);
      pendingItems -= batch.itemCount;
      pendingBytes -= batch.bytes;
      writtenItems += batch.itemCount;
      commitCount += 1;
      lastCommitDurationMs = Number(message.durationMs) || 0;
      maxCommitDurationMs = Math.max(maxCommitDurationMs, lastCommitDurationMs);
      lastAckLatencyMs = Math.max(0, performance.now() - batch.oldestAcceptedAt);
      maxAckLatencyMs = Math.max(maxAckLatencyMs, lastAckLatencyMs);
      commitDurationMetric.record(lastCommitDurationMs);
      ackLatencyMetric.record(lastAckLatencyMs);
      lastAckAt = Date.now();
      pump(stopping);
      return;
    }
    if (message?.type === "write_started") {
      const batch = inFlight.get(message.id);
      if (!batch) {
        notifyFatal(new Error(`storage-worker-client: unknown write-start notification ${String(message.id)}`));
        return;
      }
      if (batch.startedAt !== null) {
        notifyFatal(new Error(`storage-worker-client: duplicate write-start notification ${String(message.id)}`));
        return;
      }
      batch.startedAt = performance.now();
      return;
    }
    if (message?.type === "write_retry") {
      emit({
        event: "storage.worker.write_retry",
        attempt: message.attempt,
        delayMs: message.delayMs,
        reason: message.error?.message,
        ts: new Date().toISOString(),
      });
      return;
    }
    if (message?.type === "maintenance") {
      lastMaintenance = Object.freeze({
        name: message.name,
        ok: message.ok === true,
        durationMs: Number(message.durationMs) || 0,
        at: Date.now(),
        ...(message.result !== null && typeof message.result === "object" ? { result: message.result } : {}),
      });
      if (typeof message.name === "string" && message.name.length > 0) {
        lastMaintenanceByName[message.name] = lastMaintenance;
      }
      emit({
        event: message.ok === true ? "storage.worker.maintenance_succeeded" : "storage.worker.maintenance_failed",
        name: message.name,
        durationMs: Math.round(Number(message.durationMs) || 0),
        ...(message.result !== null && typeof message.result === "object" ? message.result : {}),
        ...(message.error?.message ? { reason: message.error.message } : {}),
        ts: new Date().toISOString(),
      });
      return;
    }
    if (message?.type === "fatal") {
      notifyFatal(errorFromWorker(message.error, "storage worker failed"));
      return;
    }
    if (message?.type === "stopped") {
      // This acknowledges database closure, not thread termination. Ownership
      // and stop completion remain with the parent until the exit event.
      if (!shutdownSent) notifyFatal(new Error("storage-worker-client: unsolicited stopped notification"));
    }
  });

  worker.on("error", (error) => notifyFatal(enrichWorkerFailure(error, "STORAGE_WORKER_ERROR")));
  worker.on("exit", (code) => {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    stopped = true;
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    if (failure) {
      rejectStop?.(failure);
      return;
    }
    if (!shutdownSent || code !== 0) {
      notifyFatal(enrichWorkerFailure(
        new Error(`storage-worker-client: worker exited unexpectedly with code ${code}`),
        "STORAGE_WORKER_EXIT",
        code,
      ));
      return;
    }
    resolveStop?.();
  });

  function push(table, record) {
    if (stopping || stopped) throw new Error("storage-worker-client: cannot enqueue after stop");
    if (failure) throw new Error("storage-worker-client: cannot enqueue after a fatal storage failure");
    const bytes = estimateRecordBytes(table, record);
    if (pendingItems >= maxPendingItems || pendingBytes + bytes > maxPendingBytes) {
      const error = new Error(
        `storage-worker-client: durable-write backlog limit exceeded (${pendingItems} items, ${pendingBytes} bytes)`,
      );
      error.code = "STORAGE_BACKLOG_OVERFLOW";
      notifyFatal(error);
      throw error;
    }
    buffered.push({ table, record, bytes, acceptedAt: performance.now() });
    pendingItems += 1;
    pendingBytes += bytes;
    pendingItemsHighWaterMark = Math.max(pendingItemsHighWaterMark, pendingItems);
    pendingBytesHighWaterMark = Math.max(pendingBytesHighWaterMark, pendingBytes);
    if (buffered.length - bufferedHead >= maxBatchItems) {
      clearFlushTimer();
      pump();
    } else {
      scheduleFlush();
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearFlushTimer();
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    if (failure) {
      settleStopFailure();
      return stopPromise;
    }
    pump(true);
    maybeShutdown();
    return stopPromise;
  }

  function getStats() {
    let oldestAcceptedAt = Infinity;
    if (bufferedHead < buffered.length) oldestAcceptedAt = buffered[bufferedHead].acceptedAt;
    let activeWrite = null;
    for (const [id, batch] of inFlight.entries()) {
      oldestAcceptedAt = Math.min(oldestAcceptedAt, batch.oldestAcceptedAt);
      if (batch.startedAt !== null && (activeWrite === null || batch.startedAt < activeWrite.batch.startedAt)) {
        activeWrite = { id, batch };
      }
    }
    const oldestPendingAgeMs = Number.isFinite(oldestAcceptedAt)
      ? Math.max(0, performance.now() - oldestAcceptedAt)
      : 0;
    return Object.freeze({
      pendingWriteItems: pendingItems,
      pendingWriteBytes: pendingBytes,
      pendingWriteItemsHighWaterMark: pendingItemsHighWaterMark,
      pendingWriteBytesHighWaterMark: pendingBytesHighWaterMark,
      storageWorkerReady: ready,
      storageWorkerHealthy: failure === null,
      storageWrittenItems: writtenItems,
      storageCommitCount: commitCount,
      storageLastCommitMs: Number(lastCommitDurationMs.toFixed(1)),
      storageMaxCommitMs: Number(maxCommitDurationMs.toFixed(1)),
      storageCommitSampleCount: commitDurationMetric.count(),
      storageCommitP50Ms: commitDurationMetric.percentile(50),
      storageCommitP95Ms: commitDurationMetric.percentile(95),
      storageCommitP99Ms: commitDurationMetric.percentile(99),
      storageLastAckLatencyMs: Number(lastAckLatencyMs.toFixed(1)),
      storageMaxAckLatencyMs: Number(maxAckLatencyMs.toFixed(1)),
      storageAckSampleCount: ackLatencyMetric.count(),
      storageAckP50Ms: ackLatencyMetric.percentile(50),
      storageAckP95Ms: ackLatencyMetric.percentile(95),
      storageAckP99Ms: ackLatencyMetric.percentile(99),
      storageOldestPendingAgeMs: Number(oldestPendingAgeMs.toFixed(1)),
      storageLastAckAt: lastAckAt,
      storageLastAckAgeMs: lastAckAt === null ? null : Math.max(0, Date.now() - lastAckAt),
      storageBufferedItems: buffered.length - bufferedHead,
      storageInFlightBatches: inFlight.size,
      storageActiveWriteBatchId: activeWrite?.id ?? null,
      storageActiveWriteItems: activeWrite?.batch.itemCount ?? 0,
      storageActiveWriteAgeMs: activeWrite === null
        ? 0
        : Number(Math.max(0, performance.now() - activeWrite.batch.startedAt).toFixed(1)),
      storageWorkerState: failure !== null
        ? "FAILED"
        : stopped
          ? "STOPPED"
          : !ready
            ? "STARTING"
            : activeWrite !== null
              ? "WRITING"
              : inFlight.size > 0
                ? "QUEUED"
                : stopping
                  ? "STOPPING"
                  : "IDLE",
      storageLastMaintenance: lastMaintenance,
      storageLastMaintenanceByName: Object.freeze({ ...lastMaintenanceByName }),
    });
  }

  return Object.freeze({
    push,
    stop,
    waitUntilReady: () => readyPromise,
    pendingCount: () => pendingItems,
    isHealthy: () => failure === null,
    getStats,
  });
}

module.exports = {
  createStorageWorkerClient,
  DEFAULT_MAX_PENDING_ITEMS,
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_BATCH_ITEMS,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_IN_FLIGHT_BATCHES,
  DEFAULT_BATCH_FLUSH_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_WRITE_STALL_TIMEOUT_MS,
  METRIC_SAMPLE_LIMIT,
};
