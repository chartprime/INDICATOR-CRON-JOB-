const { EventEmitter } = require("node:events");
const {
  startVolumeProfileHistoryJob,
  HISTORY_JOB_MAX_OLD_SPACE_MB,
  WORKER_PATH,
} = require("../../../src/indicators/volume-profile/volume-profile-history-job");

class FakeWorker extends EventEmitter {
  constructor(workerPath, options) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}
FakeWorker.instances = [];

// The timeout is armed only when the job is still unsettled. A Worker
// constructor failure settles the promise immediately and leaves no worker to
// supervise, so arming a timer in that path would schedule a callback with
// nothing to cancel. Note: no test below exercises the constructor-failure
// path itself -- see the coverage note in Phase 22.
describe("volume-profile-history-job", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  test("runs historical construction outside the relay event loop with an explicit memory ceiling", async () => {
    const input = { provider: "BINANCE", storageDbPath: "market.sqlite", cacheDbPath: "cache.sqlite" };
    const job = startVolumeProfileHistoryJob(input, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[0];
    expect(worker.workerPath).toBe(WORKER_PATH);
    expect(worker.options.workerData).toEqual(input);
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: HISTORY_JOB_MAX_OLD_SPACE_MB });

    worker.emit("message", { ok: true, result: [{ session: { periodStartTs: 1 } }] });
    await expect(job.promise).resolves.toEqual([{ session: { periodStartTs: 1 } }]);
  });

  test("cancellation terminates superseded work and rejects its promise", async () => {
    const job = startVolumeProfileHistoryJob({ provider: "BINANCE" }, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[0];
    job.cancel();
    expect(worker.terminated).toBe(true);
    await expect(job.promise).rejects.toThrow("cancelled");
  });
});
