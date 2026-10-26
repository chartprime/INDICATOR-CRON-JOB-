const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Database = require("better-sqlite3");
const { Worker } = require("node:worker_threads");
const { startVpinWarmup } = require("../../src/indicators/vpin/vpin-warmup");
const { startVpinLivePoll } = require("../../src/indicators/vpin/vpin-live-poll");
const { startVolumeProfileHistoryJob } = require("../../src/indicators/volume-profile/volume-profile-history-job");
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe.each([
  ["VPIN warm-up", startVpinWarmup],
  ["VPIN live poll", startVpinLivePoll],
  ["profile history", startVolumeProfileHistoryJob],
])("%s worker result and exit boundaries", (_label, startJob) => {
  let worker;
  class DelayedWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
      this.termination = new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
      this.terminate = jest.fn(() => this.termination);
    }
  }
  afterEach(() => {
    worker?.emit("exit", 0);
    worker?.finish(0);
    jest.useRealTimers();
  });

  test("result delivery keeps an awaitable cleanup boundary and remains cancellable before exit", async () => {
    const job = startJob({}, { WorkerImpl: DelayedWorker });
    worker.emit("message", { ok: true, result: { available: true } });
    await expect(job.promise).resolves.toEqual({ available: true });
    expect(typeof job.closed?.then).toBe("function");
    let closed = false;
    job.closed.then(() => { closed = true; });
    const cancellation = job.cancel();
    expect(cancellation).toBe(job.closed);
    expect(job.cancel()).toBe(cancellation);
    await tick();
    expect(closed).toBe(false);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.emit("exit", 1);
    worker.finish(1);
    await cancellation;
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
  });

  test.each([0, 1])("exit code %s without a result rejects promptly and releases ownership", async (code) => {
    const job = startJob({}, { WorkerImpl: DelayedWorker });
    let outcome;
    job.promise.then((value) => { outcome = value; }, (error) => { outcome = error; });
    worker.emit("exit", code);
    await tick();
    expect(outcome).toBeInstanceOf(Error);
    await expect(job.closed).resolves.toBeUndefined();
  });

  test.each(["throw", "reject"])("termination %s is exposed without accepting late results", async (mode) => {
    const job = startJob({}, { WorkerImpl: DelayedWorker });
    const outcome = job.promise.catch((error) => error);
    const failure = new Error("fixture cleanup failure");
    worker.terminate.mockImplementation(() => {
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    });
    const cleanup = job.cancel();
    worker.emit("message", { ok: true, result: "late" });
    expect(await outcome).toBeInstanceOf(Error);
    await expect(cleanup).rejects.toBe(failure);
    expect(job.cancel()).toBe(cleanup);
  });

  test("a timeout cancels work but cleanup remains pending until termination completes", async () => {
    jest.useFakeTimers();
    const job = startJob({}, { WorkerImpl: DelayedWorker, timeoutMs: 10 });
    const outcome = job.promise.catch((error) => error);
    jest.advanceTimersByTime(10);
    expect(await outcome).toBeInstanceOf(Error);
    expect(typeof job.closed?.then).toBe("function");
    let closed = false;
    job.closed.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    worker.emit("exit", 1);
    worker.finish(1);
    await job.closed;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test("constructor failure leaves no worker cleanup pending", async () => {
    const failure = new Error("fixture worker construction failed");
    const job = startJob({}, { WorkerImpl: class { constructor() { throw failure; } } });
    await expect(job.promise).rejects.toBe(failure);
    await expect(job.closed).resolves.toBeUndefined();
  });

  test("cancellation after a real thread's result awaits exit and releases its SQLite lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w5-analytics-exit-"));
    const dbPath = path.join(dir, "fixture.sqlite");
    const db = new Database(dbPath, { timeout: 1 });
    db.exec("CREATE TABLE evidence (value INTEGER)");
    let thread;
    class FixtureWorker extends Worker {
      constructor(_workerPath, options) {
        super(path.join(__dirname, "../fixtures/analytics-worker-reports-and-waits.js"), options);
        thread = this;
      }
    }
    const job = startJob({ dbPath }, { WorkerImpl: FixtureWorker });
    try {
      await expect(job.promise).resolves.toBe("delivered before exit");
      expect(thread.threadId).toBeGreaterThan(0);
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      await job.cancel();
      expect(thread.threadId).toBe(-1);
      await expect(job.closed).resolves.toBeUndefined();
      db.exec("INSERT INTO evidence VALUES (2)");
      expect(db.prepare("SELECT value FROM evidence").all()).toEqual([{ value: 2 }]);
    } finally {
      await thread?.terminate();
      db.close();
      for (const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, entry));
      fs.rmdirSync(dir);
    }
  });
});
