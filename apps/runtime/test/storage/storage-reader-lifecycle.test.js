const { EventEmitter } = require("node:events");
const mockWorkers = [];
const mockDbClose = jest.fn();
jest.mock("better-sqlite3", () => jest.fn());
jest.mock("node:worker_threads", () => ({ Worker: jest.fn() }));
const { Worker } = require("node:worker_threads");
const Database = require("better-sqlite3");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { createDxFeedStorageReader } = require("../../src/storage/dxfeed/dxfeed-storage-reader");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const unavailable = { rows: [], available: false };

describe.each([
  ["Binance", createStorageReader, "BTCUSDT", "SPOT"],
  ["dxFeed", createDxFeedStorageReader, "AAPL", "EQUITY"],
])("%s reader worker ownership", (_provider, createReader, symbol, kind) => {
  let reader;
  beforeEach(() => {
    jest.resetAllMocks();
    Database.mockImplementation(() => ({
      close: mockDbClose,
      prepare: () => ({ get: () => ({ n: 0 }) }),
    }));
    mockWorkers.length = 0;
    Worker.mockImplementation(() => {
      const worker = new EventEmitter();
      let finish;
      const termination = new Promise((resolve) => { finish = resolve; });
      worker.terminate = jest.fn(() => termination);
      worker.finish = () => { worker.emit("exit", 1); finish(1); };
      mockWorkers.push(worker);
      return worker;
    });
    reader = createReader({ dbPath: "fixture-never-opened.sqlite" });
  });
  afterEach(async () => {
    for (const worker of mockWorkers) worker.finish();
    await Promise.resolve().then(() => reader.close()).catch(() => {});
  });
  const read = () => reader.readLargeTradesAsync(symbol, kind, {});

  test("a delivered result does not release ownership before the worker exits", async () => {
    const pending = read();
    const worker = mockWorkers[0];
    const result = { rows: [], available: true };
    worker.emit("message", result);
    await expect(pending).resolves.toEqual(result);
    const close = reader.close();
    let settled = false;
    Promise.resolve(close).then(() => { settled = true; });
    try {
      await tick();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(reader.close()).toBe(close);
    } finally {
      worker.finish();
      await close;
    }
  });

  test("even a successful exit without a result settles the read as unavailable", async () => {
    let result;
    read().then((value) => { result = value; });
    mockWorkers[0].emit("exit", 0);
    await tick();
    expect(result).toEqual(unavailable);
  });

  test("close cancels pending reads, rejects late results, and blocks new workers", async () => {
    let result;
    read().then((value) => { result = value; });
    const close = reader.close();
    try {
      mockWorkers[0].emit("message", { rows: [], available: true });
      await tick();
      expect(result).toEqual(unavailable);
      await expect(read()).resolves.toEqual(unavailable);
      expect(mockWorkers).toHaveLength(1);
    } finally {
      mockWorkers[0].finish();
      await close;
    }
  });

  test.each(["throw", "reject"])("a termination %s does not skip other workers or the database close", async (mode) => {
    const reads = [read(), read()];
    reader.readPriceRange(symbol, kind, { fromTs: 0, toTs: 1 });
    const failure = new Error("worker termination failed");
    mockWorkers[0].terminate.mockImplementation(() => {
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    });
    let close;
    try { close = reader.close(); } catch (error) { close = Promise.reject(error); }
    const outcome = Promise.resolve(close).then(() => null, (error) => error);
    let settled = false;
    outcome.then(() => { settled = true; });
    let earlySettlement;
    await tick();
    earlySettlement = settled;
    mockWorkers.forEach((worker) => worker.finish());
    const error = await outcome;
    expect(earlySettlement).toBe(false);
    expect(mockWorkers[1].terminate).toHaveBeenCalledTimes(1);
    expect(mockDbClose).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
    await expect(Promise.all(reads)).resolves.toEqual([unavailable, unavailable]);
  });

  test("a database close error is reported only after worker termination finishes", async () => {
    const pending = read();
    reader.readPriceRange(symbol, kind, { fromTs: 0, toTs: 1 });
    const failure = new Error("database close failed");
    mockDbClose.mockImplementation(() => { throw failure; });
    const close = reader.close();
    const outcome = close.then(() => null, (error) => error);
    let settled = false;
    outcome.then(() => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
      expect(reader.close()).toBe(close);
    } finally {
      mockWorkers[0].finish();
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
    await expect(pending).resolves.toEqual(unavailable);
    expect(mockDbClose).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["Binance", createStorageReader, "BTCUSDT", "SPOT", "__storageReaderWorkerError"],
  ["dxFeed", createDxFeedStorageReader, "AAPL", "EQUITY", "__dxfeedStorageReaderWorkerError"],
])("%s reader readAsync", (_provider, createReader, symbol, kind, errorField) => {
  let reader;
  beforeEach(() => {
    jest.resetAllMocks();
    Database.mockImplementation(() => ({
      close: mockDbClose,
      prepare: () => ({ get: () => ({ n: 0 }) }),
    }));
    mockWorkers.length = 0;
    Worker.mockImplementation(() => {
      const worker = new EventEmitter();
      let finish;
      const termination = new Promise((resolve) => { finish = resolve; });
      worker.terminate = jest.fn(() => { worker.emit("exit", 1); finish(1); return termination; });
      mockWorkers.push(worker);
      return worker;
    });
    reader = createReader({ dbPath: "fixture-never-opened.sqlite" });
  });
  afterEach(async () => {
    await Promise.resolve().then(() => reader.close()).catch(() => {});
  });

  test("an already-aborted signal resolves to the empty shape and terminates the spawned worker immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await reader.readAsync("readLargeTrades", symbol, kind, {}, { signal: controller.signal });
    expect(result).toEqual(unavailable);
    expect(mockWorkers[0].terminate).toHaveBeenCalledTimes(1);
  });

  test("aborting mid-flight terminates the worker and settles with the empty shape, not a hang", async () => {
    const controller = new AbortController();
    const pending = reader.readAsync("readLargeTrades", symbol, kind, {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual(unavailable);
    expect(mockWorkers[0].terminate).toHaveBeenCalledTimes(1);
  });

  test("an unsupported method is rejected before a worker is ever spawned", async () => {
    await expect(reader.readAsync("notAMethod", symbol, kind, {})).rejects.toThrow(/unsupported async method/);
    expect(mockWorkers).toHaveLength(0);
  });

  test("a worker-reported error rejects the caller instead of resolving to the empty fallback shape", async () => {
    const pending = reader.readAsync("readLargeTrades", symbol, kind, {});
    mockWorkers[0].emit("message", { [errorField]: "boom" });
    await expect(pending).rejects.toThrow("boom");
  });

  test("a successful exit without a posted message rejects instead of disguising a worker failure as unavailable data", async () => {
    const pending = reader.readAsync("readVolumeProfile", symbol, kind, {});
    mockWorkers[0].emit("exit", 0);
    await expect(pending).rejects.toThrow(/worker exited without a result \(code 0\)/);
  });

  test("a worker error rejects instead of disguising an infrastructure failure as unavailable data", async () => {
    const pending = reader.readAsync("readVolumeProfile", symbol, kind, {});
    mockWorkers[0].emit("error", new Error("worker heap exhausted"));
    await expect(pending).rejects.toThrow(/worker failed: worker heap exhausted/);
  });
});
