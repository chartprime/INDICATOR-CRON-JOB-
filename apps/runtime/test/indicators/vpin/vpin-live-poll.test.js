const { EventEmitter } = require("node:events");
const {
  startVpinLivePoll,
  WORKER_PATH,
  DEFAULT_VPIN_LIVE_POLL_TIMEOUT_MS,
  VPIN_LIVE_POLL_MAX_OLD_SPACE_MB,
} = require("../../../src/indicators/vpin/vpin-live-poll");

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

describe("server/vpin-live-poll", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  test("runs live SQLite cursor work outside the relay and returns the complete replacement state", async () => {
    const input = {
      dbPath: "test.sqlite", provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL",
      vpinState: { sealer: { vBucket: 1_000 } }, pollFromTs: 1_000, pollCursor: null, nowMs: 2_000,
    };
    const job = startVpinLivePoll(input, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[0];
    expect(worker.path).toBe(WORKER_PATH);
    expect(worker.options.workerData).toEqual(input);
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: VPIN_LIVE_POLL_MAX_OLD_SPACE_MB });

    const result = { readings: [], vpinState: input.vpinState, pollFromTs: 1_000, pollCursor: { ts: 1_500, id: 2 } };
    worker.emit("message", { ok: true, result });
    await expect(job.promise).resolves.toEqual(result);
  });

  test("fails closed when the worker reports an error and can be cancelled during relay shutdown", async () => {
    const failed = startVpinLivePoll({}, { WorkerImpl: FakeWorker });
    FakeWorker.instances[0].emit("message", { ok: false, error: "database unavailable" });
    await expect(failed.promise).rejects.toThrow("database unavailable");

    const cancelled = startVpinLivePoll({}, { WorkerImpl: FakeWorker });
    const worker = FakeWorker.instances[1];
    cancelled.cancel();
    expect(worker.terminated).toBe(true);
    await expect(cancelled.promise).rejects.toThrow("cancelled");
  });

  test("validates a positive time budget", () => {
    expect(DEFAULT_VPIN_LIVE_POLL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(() => startVpinLivePoll({}, { WorkerImpl: FakeWorker, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
