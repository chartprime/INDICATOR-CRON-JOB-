const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createAnalyticsWorkerJob } = require("../../platform/analytics-worker-job");

const WORKER_PATH = path.join(__dirname, "vpin-live-poll-worker.js");
const DEFAULT_VPIN_LIVE_POLL_TIMEOUT_MS = 5_000;
const VPIN_LIVE_POLL_MAX_OLD_SPACE_MB = 128;

function startVpinLivePoll(input, { WorkerImpl = Worker, timeoutMs = DEFAULT_VPIN_LIVE_POLL_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("vpin live poll: timeoutMs must be a positive safe integer");
  }
  return createAnalyticsWorkerJob({
    WorkerImpl, workerPath: WORKER_PATH, input,
    maxOldGenerationSizeMb: VPIN_LIVE_POLL_MAX_OLD_SPACE_MB, timeoutMs, label: "vpin live poll",
  });
}

module.exports = { startVpinLivePoll, WORKER_PATH, DEFAULT_VPIN_LIVE_POLL_TIMEOUT_MS, VPIN_LIVE_POLL_MAX_OLD_SPACE_MB };
