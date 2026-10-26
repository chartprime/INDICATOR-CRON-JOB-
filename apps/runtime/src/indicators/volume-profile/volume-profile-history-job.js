const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createAnalyticsWorkerJob } = require("../../platform/analytics-worker-job");

const WORKER_PATH = path.join(__dirname, "volume-profile-history-worker.js");
const DEFAULT_HISTORY_JOB_TIMEOUT_MS = 30_000;
const HISTORY_JOB_MAX_OLD_SPACE_MB = 128;

function startVolumeProfileHistoryJob(input, { WorkerImpl = Worker, timeoutMs = DEFAULT_HISTORY_JOB_TIMEOUT_MS } = {}) {
  if (!input || typeof input !== "object") throw new Error("volume-profile-history-job: input is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("volume-profile-history-job: timeoutMs must be a positive safe integer");
  }
  return createAnalyticsWorkerJob({
    WorkerImpl, workerPath: WORKER_PATH, input,
    maxOldGenerationSizeMb: HISTORY_JOB_MAX_OLD_SPACE_MB, timeoutMs, label: "volume-profile-history-job",
  });
}

module.exports = { startVolumeProfileHistoryJob, WORKER_PATH, DEFAULT_HISTORY_JOB_TIMEOUT_MS, HISTORY_JOB_MAX_OLD_SPACE_MB };
