const { createStorageDb } = require("../../src/storage/storage-db");
const {
  runCheckpointCycle,
  createStorageCheckpoint,
  DEFAULT_INTERVAL_MS,
  DEFAULT_DEEP_CYCLE_EVERY,
} = require("../../src/storage/storage-checkpoint");

function fakeStorageDb() {
  const pragmaCalls = [];
  return {
    pragmaCalls,
    raw: {
      pragma: (statement) => {
        pragmaCalls.push(statement);
      },
    },
  };
}

describe("createStorageCheckpoint", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("rejects a storageDb without a raw handle, and non-positive interval/deepCycleEvery", () => {
    expect(() => createStorageCheckpoint({ storageDb: {} })).toThrow(/raw/);
    expect(() => createStorageCheckpoint({ storageDb: fakeStorageDb(), intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => createStorageCheckpoint({ storageDb: fakeStorageDb(), deepCycleEvery: 0 })).toThrow(/deepCycleEvery/);
    expect(() => createStorageCheckpoint({ storageDb: fakeStorageDb(), incrementalVacuumPages: 0 })).toThrow(/incrementalVacuumPages/);
  });

  test("runOnce() issues a PASSIVE checkpoint on ordinary cycles, never touching incremental_vacuum", () => {
    const storageDb = fakeStorageDb();
    const checkpoint = createStorageCheckpoint({ storageDb, deepCycleEvery: 3 });

    const result1 = checkpoint.runOnce();
    const result2 = checkpoint.runOnce();

    expect(result1).toEqual({ deep: false, mode: "PASSIVE", busy: null, logFrames: null, checkpointedFrames: null });
    expect(result2).toEqual({ deep: false, mode: "PASSIVE", busy: null, logFrames: null, checkpointedFrames: null });
    expect(storageDb.pragmaCalls).toEqual(["wal_checkpoint(PASSIVE)", "wal_checkpoint(PASSIVE)"]);
  });

  test("exports the worker-facing checkpoint operation", () => {
    const storageDb = fakeStorageDb();

    expect(runCheckpointCycle(storageDb, { deep: true, incrementalVacuumPages: 250 })).toEqual({
      mode: "TRUNCATE", busy: null, logFrames: null, checkpointedFrames: null,
    });

    expect(storageDb.pragmaCalls).toEqual(["wal_checkpoint(TRUNCATE)", "incremental_vacuum(250)"]);
  });

  test("every Nth cycle is a deep cycle: TRUNCATE checkpoint plus an incremental_vacuum", () => {
    const storageDb = fakeStorageDb();
    const checkpoint = createStorageCheckpoint({ storageDb, deepCycleEvery: 3, incrementalVacuumPages: 250 });

    checkpoint.runOnce();
    checkpoint.runOnce();
    const result3 = checkpoint.runOnce();

    expect(result3).toEqual({ deep: true, mode: "TRUNCATE", busy: null, logFrames: null, checkpointedFrames: null });
    expect(storageDb.pragmaCalls).toEqual([
      "wal_checkpoint(PASSIVE)",
      "wal_checkpoint(PASSIVE)",
      "wal_checkpoint(TRUNCATE)",
      "incremental_vacuum(250)",
    ]);
  });

  test("start() schedules runOnce() on the configured interval, not immediately", () => {
    jest.useFakeTimers();
    const storageDb = fakeStorageDb();
    const checkpoint = createStorageCheckpoint({ storageDb, intervalMs: 1000 });

    checkpoint.start();
    expect(storageDb.pragmaCalls).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    expect(storageDb.pragmaCalls).toEqual(["wal_checkpoint(PASSIVE)"]);

    checkpoint.stop();
  });

  test("stop() prevents further scheduled cycles", () => {
    jest.useFakeTimers();
    const storageDb = fakeStorageDb();
    const checkpoint = createStorageCheckpoint({ storageDb, intervalMs: 1000 });

    checkpoint.start();
    checkpoint.stop();
    jest.advanceTimersByTime(5000);

    expect(storageDb.pragmaCalls).toHaveLength(0);
  });

  test("a failure during a scheduled cycle is logged and reported via onError, never thrown out of the timer", () => {
    jest.useFakeTimers();
    const storageDb = {
      raw: {
        pragma: () => {
          throw new Error("disk full");
        },
      },
    };
    const onError = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const checkpoint = createStorageCheckpoint({ storageDb, intervalMs: 1000, onError });

    checkpoint.start();
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe("disk full");
    errorSpy.mockRestore();
    checkpoint.stop();
  });

  test("scheduled checkpoint progress, including busy status, is published to the control plane", () => {
    jest.useFakeTimers();
    const storageDb = {
      raw: { pragma: jest.fn(() => [{ busy: 1, log: 250, checkpointed: 125 }]) },
    };
    const onResult = jest.fn();
    const checkpoint = createStorageCheckpoint({ storageDb, intervalMs: 1_000, onResult });
    checkpoint.start();
    jest.advanceTimersByTime(1_000);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      mode: "PASSIVE", busy: 1, logFrames: 250, checkpointedFrames: 125,
    }));
    checkpoint.stop();
  });

  test("against a real database: a checkpoint cycle runs without error and the deep cycle's incremental_vacuum is a no-op (not a crash) when auto_vacuum isn't incremental", () => {
    const storageDb = createStorageDb({ dbPath: ":memory:" });
    const checkpoint = createStorageCheckpoint({ storageDb, deepCycleEvery: 1 });

    expect(() => checkpoint.runOnce()).not.toThrow();
    storageDb.close();
  });

  test("the defaults are named constants, not magic numbers", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_DEEP_CYCLE_EVERY).toBe(48);
  });

  test("returns SQLite checkpoint progress for durable maintenance telemetry", () => {
    const storageDb = {
      raw: {
        pragma: jest.fn(() => [{ busy: 0, log: 125, checkpointed: 120 }]),
      },
    };

    expect(runCheckpointCycle(storageDb)).toEqual({
      mode: "PASSIVE", busy: 0, logFrames: 125, checkpointedFrames: 120,
    });
  });

  test("reports a busy checkpoint without blocking or pretending all WAL frames were checkpointed", () => {
    const storageDb = {
      raw: {
        pragma: jest.fn(() => [{ busy: 1, log: 250, checkpointed: 125 }]),
      },
    };

    expect(runCheckpointCycle(storageDb)).toEqual({
      mode: "PASSIVE", busy: 1, logFrames: 250, checkpointedFrames: 125,
    });
  });
});
