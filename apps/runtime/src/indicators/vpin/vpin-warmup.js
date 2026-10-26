const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createAnalyticsWorkerJob } = require("../../platform/analytics-worker-job");

const WORKER_PATH = path.join(__dirname, "vpin-warmup-worker.js");
const DEFAULT_VPIN_WARMUP_TIMEOUT_MS = 10 * 60 * 1_000;
const VPIN_WARMUP_MAX_OLD_SPACE_MB = 256;

function startVpinWarmup(input, { WorkerImpl = Worker, timeoutMs = DEFAULT_VPIN_WARMUP_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("vpin warm-up: timeoutMs must be a positive safe integer");
  }
  return createAnalyticsWorkerJob({
    WorkerImpl, workerPath: WORKER_PATH, input,
    maxOldGenerationSizeMb: VPIN_WARMUP_MAX_OLD_SPACE_MB, timeoutMs, label: "vpin warm-up",
  });
}

module.exports = { startVpinWarmup, WORKER_PATH, DEFAULT_VPIN_WARMUP_TIMEOUT_MS, VPIN_WARMUP_MAX_OLD_SPACE_MB };
