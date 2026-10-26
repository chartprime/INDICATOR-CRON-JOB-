const { createBackfillScheduler, DEFAULT_MAX_WORKERS, DEFAULT_TIMEOUT_MS } = require("../../../src/indicators/l2-memory/liquidity-backfill-scheduler");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeBackfill() {
  const started = [];
  const backfill = jest.fn((request) => {
    const gate = deferred();
    started.push({ request, gate });
    return gate.promise;
  });
  return { backfill, started };
}

const EMPTY = { columns: 0, frames: 0, reason: null, stats: null, levels: [], aggressive: [] };

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("liquidity-backfill-scheduler", () => {
  test("defaults and argument checks", () => {
    expect(DEFAULT_MAX_WORKERS).toBe(1);
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
    expect(() => createBackfillScheduler({ backfill: () => {}, maxWorkers: 0 })).toThrow(/maxWorkers/);
    expect(() => createBackfillScheduler({ backfill: () => {}, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createBackfillScheduler({})).toThrow(/backfill/);
  });

  test("runs at most maxWorkers passes at once and starts the next when one lands", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    const a = scheduler.run({ key: "A", fromTs: 0, toTs: 1 });
    const b = scheduler.run({ key: "B", fromTs: 0, toTs: 1 });
    await settle();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(scheduler.stats()).toMatchObject({ running: 1, queued: 1, started: 1 });
    started[0].gate.resolve({ ...EMPTY, columns: 3 });
    await expect(a).resolves.toMatchObject({ columns: 3 });
    await settle();
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(backfill.mock.calls[1][0]).toMatchObject({ key: "B" });
    started[1].gate.resolve(EMPTY);
    await expect(b).resolves.toEqual(EMPTY);
    expect(scheduler.stats()).toMatchObject({ running: 0, queued: 0, started: 2, completed: 2 });
  });

  test("a queued pass marked urgent goes ahead of the ones waiting", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    scheduler.run({ key: "A" });
    scheduler.run({ key: "B" });
    scheduler.run({ key: "C" }, { urgent: true });
    await settle();
    started[0].gate.resolve(EMPTY);
    await settle();
    expect(backfill.mock.calls.map((c) => c[0].key)).toEqual(["A", "C"]);
  });

  test("a pass that outlives the timeout is told to stop and resolves with TIMEOUT", async () => {
    jest.useFakeTimers();
    try {
      const { backfill, started } = fakeBackfill();
      const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1, timeoutMs: 1_000 });
      const shouldContinue = jest.fn(() => true);
      const pass = scheduler.run({ key: "A", shouldContinue });
      await Promise.resolve();
      expect(started[0].request.shouldContinue()).toBe(true);
      jest.advanceTimersByTime(1_001);
      expect(started[0].request.shouldContinue()).toBe(false);
      await expect(pass).resolves.toMatchObject({ columns: 0, reason: "TIMEOUT" });
      started[0].gate.resolve({ ...EMPTY, columns: 9 });
      await Promise.resolve();
      expect(scheduler.stats()).toMatchObject({ timedOut: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  test("the caller's own shouldContinue still counts", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    let keep = true;
    scheduler.run({ key: "A", shouldContinue: () => keep });
    await settle();
    expect(started[0].request.shouldContinue()).toBe(true);
    keep = false;
    expect(started[0].request.shouldContinue()).toBe(false);
  });

  test("cancel drops a queued pass with CANCELLED and stops a running one", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    const a = scheduler.run({ key: "A" });
    const b = scheduler.run({ key: "B" });
    await settle();
    scheduler.cancel("B");
    await expect(b).resolves.toMatchObject({ columns: 0, reason: "CANCELLED" });
    expect(backfill).toHaveBeenCalledTimes(1);
    scheduler.cancel("A");
    expect(started[0].request.shouldContinue()).toBe(false);
    started[0].gate.resolve({ ...EMPTY, reason: "CANCELLED" });
    await expect(a).resolves.toMatchObject({ reason: "CANCELLED" });
    expect(scheduler.stats()).toMatchObject({ cancelled: 2 });
  });

  test("dispose cancels everything and refuses new passes", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    const a = scheduler.run({ key: "A" });
    const b = scheduler.run({ key: "B" });
    await settle();
    scheduler.dispose();
    expect(started[0].request.shouldContinue()).toBe(false);
    await expect(b).resolves.toMatchObject({ reason: "CANCELLED" });
    started[0].gate.resolve(EMPTY);
    await expect(a).resolves.toEqual(EMPTY);
    await expect(scheduler.run({ key: "C" })).resolves.toMatchObject({ reason: "DISPOSED" });
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  test("a rejected backfill rejects the caller and frees the worker", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    const a = scheduler.run({ key: "A" });
    const b = scheduler.run({ key: "B" });
    await settle();
    started[0].gate.reject(new Error("disk on fire"));
    await expect(a).rejects.toThrow(/disk on fire/);
    await settle();
    expect(backfill).toHaveBeenCalledTimes(2);
    started[1].gate.resolve(EMPTY);
    await expect(b).resolves.toEqual(EMPTY);
    expect(scheduler.stats()).toMatchObject({ failed: 1, completed: 1 });
  });

  test("a background pass waits until nothing else is queued or running, and a pass queued after it still goes first", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    const a = scheduler.run({ key: "A", fromTs: 0, toTs: 1 });
    const fill = scheduler.run({ key: "A", fromTs: 0, toTs: 1, background: true });
    const b = scheduler.run({ key: "B", fromTs: 0, toTs: 1 });
    await settle();
    expect(backfill).toHaveBeenCalledTimes(1);
    started[0].gate.resolve(EMPTY);
    await a;
    await settle();
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(backfill.mock.calls[1][0]).toMatchObject({ key: "B" });
    started[1].gate.resolve(EMPTY);
    await b;
    await settle();
    expect(backfill).toHaveBeenCalledTimes(3);
    expect(backfill.mock.calls[2][0]).toMatchObject({ key: "A", background: true });
    const c = scheduler.run({ key: "C", fromTs: 0, toTs: 1 });
    await settle();
    expect(backfill).toHaveBeenCalledTimes(3);
    expect(scheduler.stats()).toMatchObject({ running: 1, queued: 1 });
    started[2].gate.resolve(EMPTY);
    await fill;
    await settle();
    expect(backfill).toHaveBeenCalledTimes(4);
    started[3].gate.resolve(EMPTY);
    await c;
    // With room for two, a background pass still waits for the running one to land.
    const wide = fakeBackfill();
    const two = createBackfillScheduler({ backfill: wide.backfill, maxWorkers: 2 });
    const d = two.run({ key: "D", fromTs: 0, toTs: 1 });
    const quiet = two.run({ key: "D", fromTs: 0, toTs: 1, background: true });
    await settle();
    expect(wide.backfill).toHaveBeenCalledTimes(1);
    expect(two.stats()).toMatchObject({ running: 1, queued: 1 });
    wide.started[0].gate.resolve(EMPTY);
    await d;
    await settle();
    expect(wide.backfill).toHaveBeenCalledTimes(2);
    wide.started[1].gate.resolve(EMPTY);
    await quiet;
  });
});

describe("liquidity-backfill-scheduler prioritise", () => {
  test("prioritise moves a key's queued passes ahead of the others, behind the ones already urgent", async () => {
    const { backfill, started } = fakeBackfill();
    const scheduler = createBackfillScheduler({ backfill, maxWorkers: 1 });
    scheduler.run({ key: "A" });
    scheduler.run({ key: "B" });
    scheduler.run({ key: "C" });
    scheduler.run({ key: "D" }, { urgent: true });
    await settle();
    expect(scheduler.prioritise("C")).toBe(1);
    expect(scheduler.prioritise("C")).toBe(0);
    expect(scheduler.prioritise("Z")).toBe(0);
    expect(scheduler.prioritise(null)).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      started[i].gate.resolve(EMPTY);
      await settle();
    }
    expect(backfill.mock.calls.map((c) => c[0].key)).toEqual(["A", "D", "C", "B"]);
  });
});
