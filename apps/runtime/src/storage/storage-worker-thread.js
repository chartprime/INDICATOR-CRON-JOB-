const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { createStorageDb } = require("./storage-db");
const {
  runCheckpointCycle,
  DEFAULT_INTERVAL_MS: DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_INCREMENTAL_VACUUM_PAGES,
} = require("./storage-checkpoint");

const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 5_000;

if (!parentPort) {
  throw new Error("storage-worker-thread must run inside a Worker");
}

const { dbPath } = workerData;

parentPort.postMessage({ type: "initializing", stage: "opening_writer_connection" });
const storageDb = createStorageDb({ dbPath, bootstrap: false });
parentPort.postMessage({ type: "initializing", stage: "database_ready" });
const writeBatch = storageDb.raw.transaction((items) => {
  for (const item of items) storageDb.insert(item.table, item.record);
});

const batches = [];
const pendingMaintenance = new Map();
let processing = false;
let retryScheduled = false;
let stopping = false;
let failed = false;
let checkpointTimer = null;

function serializeError(error) {
  return {
    message: error?.message ?? String(error),
    code: typeof error?.code === "string" ? error.code : undefined,
    stack: typeof error?.stack === "string" ? error.stack : undefined,
  };
}

function post(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}

function retryableWriteError(error) {
  return error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED";
}

function retryDelayMs(attempt) {
  return Math.min(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

function clearAllTimers() {
  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = null;
}

function closeWorker() {
  clearAllTimers();
  storageDb.close();
  post("stopped");
  parentPort.close();
}

function fail(error) {
  if (failed) return;
  failed = true;
  clearAllTimers();
  post("fatal", { error: serializeError(error) });
  try {
    storageDb.close();
  } catch {
    void 0;
  }
  parentPort.close();
}

function processNext() {
  if (processing || failed || retryScheduled) return;
  const next = batches[0];
  if (!next) {
    const maintenance = pendingMaintenance.entries().next().value;
    if (maintenance) {
      const [name, operation] = maintenance;
      pendingMaintenance.delete(name);
      runMaintenance(name, operation);
      setImmediate(processNext);
      return;
    }
    if (stopping) {
      closeWorker();
      return;
    }
    return;
  }
  processing = true;
  const startedAt = performance.now();
  try {
    if (!next.writeStarted) {
      next.writeStarted = true;
      post("write_started", { id: next.id, itemCount: next.items.length });
    }
    writeBatch(next.items);
    batches.shift();
    processing = false;
    post("ack", {
      id: next.id,
      itemCount: next.items.length,
      durationMs: performance.now() - startedAt,
    });
    setImmediate(processNext);
  } catch (error) {
    processing = false;
    next.attempt += 1;
    if (retryableWriteError(error) && next.attempt <= DEFAULT_MAX_RETRY_ATTEMPTS) {
      post("write_retry", {
        id: next.id,
        attempt: next.attempt,
        delayMs: retryDelayMs(next.attempt),
        error: serializeError(error),
      });
      retryScheduled = true;
      setTimeout(() => {
        retryScheduled = false;
        processNext();
      }, retryDelayMs(next.attempt));
      return;
    }
    fail(error);
  }
}

function queueMaintenance(name, operation) {
  if (failed || stopping || pendingMaintenance.has(name)) return;
  pendingMaintenance.set(name, operation);
  processNext();
}

function runMaintenance(name, operation) {
  if (failed) return;
  const startedAt = performance.now();
  try {
    const result = operation();
    post("maintenance", { name, ok: true, durationMs: performance.now() - startedAt, result });
  } catch (error) {
    post("maintenance", {
      name,
      ok: false,
      durationMs: performance.now() - startedAt,
      error: serializeError(error),
    });
  }
}

checkpointTimer = setInterval(() => {
  queueMaintenance("checkpoint", () => {
    return {
      deep: false,
      ...runCheckpointCycle(storageDb, {
        incrementalVacuumPages: DEFAULT_INCREMENTAL_VACUUM_PAGES,
        deep: false,
      }),
    };
  });
}, DEFAULT_CHECKPOINT_INTERVAL_MS);
checkpointTimer.unref?.();

parentPort.on("message", (message) => {
  if (message?.type === "write" && !stopping && !failed) {
    batches.push({ id: message.id, items: message.items, attempt: 0, writeStarted: false });
    processNext();
    return;
  }
  if (message?.type === "shutdown") {
    stopping = true;
    processNext();
  }
});

post("ready");
