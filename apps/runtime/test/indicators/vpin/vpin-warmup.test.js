const { EventEmitter } = require("node:events");
const { startVpinWarmup, WORKER_PATH } = require("../../../src/indicators/vpin/vpin-warmup");

class FakeWorker extends EventEmitter {
  constructor(path, options) {
    super();
    this.path = path;
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

describe("server/vpin-warmup", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  test("starts the historical replay outside the relay thread and resolves its typed result", async () => {
    const input = { dbPath: "test.sqlite", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
    const job = startVpinWarmup(input, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[0];
    expect(worker.path).toBe(WORKER_PATH);
    expect(worker.options.workerData).toEqual(input);
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 256 });

    worker.emit("message", { ok: true, result: { available: true, tradesApplied: 42 } });
    await expect(job.promise).resolves.toEqual({ available: true, tradesApplied: 42 });
  });

  test("surfaces a worker-side failure to the caller", async () => {
    const job = startVpinWarmup({ dbPath: "test.sqlite" }, { WorkerImpl: FakeWorker });
    FakeWorker.instances[0].emit("message", { ok: false, error: "database unavailable" });
    await expect(job.promise).rejects.toThrow("database unavailable");
  });

  test("cancels an unfinished replay during server shutdown", async () => {
    const job = startVpinWarmup({ dbPath: "test.sqlite" }, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[0];
    job.cancel();
    expect(worker.terminated).toBe(true);
    await expect(job.promise).rejects.toThrow("cancelled");
  });
});
