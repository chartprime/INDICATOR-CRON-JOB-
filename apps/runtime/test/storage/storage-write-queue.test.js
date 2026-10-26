const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageWriteQueue } = require("../../src/storage/storage-write-queue");

function tradeRecord(overrides = {}) {
  return { ts: 1000, symbol: "BTCUSDT", marketKind: "SPOT", price: 1, size: 1, side: "buy", tradeId: "1", ...overrides };
}

describe("createStorageWriteQueue", () => {
  let storageDb;

  beforeEach(() => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
  });

  afterEach(() => {
    storageDb.close();
  });

  test("drainOnce() writes every pushed record and empties the queue", () => {
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("trades", tradeRecord({ tradeId: "a" }));
    queue.push("trades", tradeRecord({ tradeId: "b" }));

    const written = queue.drainOnce();

    expect(written).toBe(2);
    expect(queue.pendingCount()).toBe(0);
    const rows = storageDb.raw.prepare("SELECT trade_id FROM trades ORDER BY id").all();
    expect(rows.map((r) => r.trade_id)).toEqual(["a", "b"]);
  });

  test("drainOnce() on an empty queue writes nothing and returns 0", () => {
    const queue = createStorageWriteQueue({ storageDb });
    expect(queue.drainOnce()).toBe(0);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(0);
  });

  test("push() schedules its own flush -- a caller never needs to call drainOnce() manually", async () => {
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("trades", tradeRecord());

    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.pendingCount()).toBe(0);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(1);
  });

  test("several pushes before the scheduled flush fires are batched into a single transaction", async () => {
    const transactionSpy = jest.spyOn(storageDb.raw, "transaction");
    const queue = createStorageWriteQueue({ storageDb });

    queue.push("trades", tradeRecord({ tradeId: "a" }));
    queue.push("trades", tradeRecord({ tradeId: "b" }));
    queue.push("trades", tradeRecord({ tradeId: "c" }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(3);
  });

  test("a non-retryable write failure is retained and marks storage unhealthy instead of silently dropping its batch", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("not_a_real_table", tradeRecord());

    expect(() => queue.drainOnce()).not.toThrow();
    expect(queue.pendingCount()).toBe(1);
    expect(queue.isHealthy()).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith("storage-write-queue: storage is no longer writable", expect.anything());
    consoleErrorSpy.mockRestore();
  });

  test("stop() rethrows the stored fatal failure instead of silently discarding still-unwritten records", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("not_a_real_table", tradeRecord());
    queue.drainOnce();
    expect(queue.isHealthy()).toBe(false);
    expect(queue.pendingCount()).toBe(1);

    expect(() => queue.stop()).toThrow();
    expect(queue.pendingCount()).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  test("stop() flushes whatever is still pending, synchronously", () => {
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("trades", tradeRecord());

    queue.stop();

    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(1);
  });

  test("stop() writes every pending batch, not only the first, so a shutdown keeps everything recorded", () => {
    const queue = createStorageWriteQueue({ storageDb, maxBatchItems: 2 });
    for (const tradeId of ["a", "b", "c", "d", "e"]) queue.push("trades", tradeRecord({ tradeId }));

    queue.stop();

    expect(queue.pendingCount()).toBe(0);
    expect(storageDb.raw.prepare("SELECT trade_id FROM trades ORDER BY id").all().map((row) => row.trade_id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("after a fatal failure a push is refused rather than queued behind a store that cannot take it", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({ storageDb });
    queue.push("not_a_real_table", tradeRecord());
    queue.drainOnce();

    expect(() => queue.push("trades", tradeRecord())).toThrow(/after a fatal storage failure/);
    expect(queue.pendingCount()).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  test("after stop(), a later push is rejected explicitly rather than being retained forever", async () => {
    const queue = createStorageWriteQueue({ storageDb });
    queue.stop();
    expect(() => queue.push("trades", tradeRecord())).toThrow(/after stop/);

    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.pendingCount()).toBe(0);
    expect(storageDb.raw.prepare("SELECT COUNT(*) AS n FROM trades").get().n).toBe(0);
  });

  test("retries a transient SQLite lock without losing the original batch", async () => {
    let attempts = 0;
    const inserted = [];
    const transientStorageDb = {
      raw: {
        transaction: (fn) => (...args) => fn(...args),
      },
      insert: (_table, record) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("database is locked");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        inserted.push(record);
      },
    };
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({
      storageDb: transientStorageDb,
      retryBaseDelayMs: 1,
      maxRetryAttempts: 2,
    });

    queue.push("trades", tradeRecord());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(inserted).toEqual([tradeRecord()]);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.isHealthy()).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  const busyStore = (shouldFail) => {
    const inserted = [];
    return {
      inserted,
      raw: { transaction: (fn) => (...args) => fn(...args) },
      insert: (_table, record) => {
        if (shouldFail()) {
          const error = new Error("database is locked");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        inserted.push(record);
      },
    };
  };

  test("a lock that never clears is given up on after the retry cap, keeping its batch", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({ storageDb: busyStore(() => true), retryBaseDelayMs: 60_000, maxRetryAttempts: 2 });
    queue.push("trades", tradeRecord());

    queue.drainOnce();
    queue.drainOnce();
    expect(queue.isHealthy()).toBe(true);
    queue.drainOnce();
    expect(queue.isHealthy()).toBe(false);
    expect(queue.pendingCount()).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  test("the retry cap counts consecutive failures: a write that lands resets it", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let failures = 0;
    let failNext = true;
    const store = busyStore(() => {
      if (!failNext) return false;
      failNext = false;
      failures += 1;
      return true;
    });
    const queue = createStorageWriteQueue({ storageDb: store, retryBaseDelayMs: 60_000, maxRetryAttempts: 1 });
    queue.push("trades", tradeRecord({ tradeId: "a" }));
    queue.drainOnce();
    queue.drainOnce();
    failNext = true;
    queue.push("trades", tradeRecord({ tradeId: "b" }));
    queue.drainOnce();
    queue.drainOnce();

    expect(failures).toBe(2);
    expect(queue.isHealthy()).toBe(true);
    expect(store.inserted.map((record) => record.tradeId)).toEqual(["a", "b"]);
    queue.stop();
    consoleErrorSpy.mockRestore();
  });

  test("a bounded queue fails visibly before it can grow without limit", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = createStorageWriteQueue({ storageDb, maxPendingItems: 1 });
    queue.push("trades", tradeRecord({ tradeId: "a" }));

    expect(() => queue.push("trades", tradeRecord({ tradeId: "b" }))).toThrow(/pending-write limit/);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.isHealthy()).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  test("rejects malformed queue controls at construction", () => {
    expect(() => createStorageWriteQueue({ storageDb: null })).toThrow(/storageDb/);
    expect(() => createStorageWriteQueue({ storageDb, maxPendingItems: 0 })).toThrow(/maxPendingItems/);
    expect(() => createStorageWriteQueue({ storageDb, maxBatchItems: 1.5 })).toThrow(/maxBatchItems/);
    expect(() => createStorageWriteQueue({ storageDb, maxRetryAttempts: 0 })).toThrow(/maxRetryAttempts/);
    expect(() => createStorageWriteQueue({ storageDb, retryBaseDelayMs: 0 })).toThrow(/retryBaseDelayMs/);
    expect(() => createStorageWriteQueue({ storageDb, onFatalError: true })).toThrow(/onFatalError/);
  });
});
