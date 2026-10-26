function sqliteError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function setup({ insertImpl, checkpointIntervalMs = 999_999_999 } = {}) {
  jest.resetModules();
  jest.useFakeTimers();

  const messageHandlers = {};
  const parentPort = {
    postMessage: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event, handler) => {
      messageHandlers[event] = handler;
    }),
  };
  jest.doMock("node:worker_threads", () => ({
    parentPort,
    workerData: { dbPath: ":memory:" },
  }));

  const insert = jest.fn(insertImpl ?? (() => {}));
  const close = jest.fn();
  const raw = { transaction: jest.fn((fn) => fn) };
  const createStorageDb = jest.fn(() => ({ raw, insert, close }));
  jest.doMock("../../src/storage/storage-db", () => ({ createStorageDb }));

  const runCheckpointCycle = jest.fn(() => ({ mode: "PASSIVE" }));
  jest.doMock("../../src/storage/storage-checkpoint", () => ({
    runCheckpointCycle,
    DEFAULT_INTERVAL_MS: checkpointIntervalMs,
    DEFAULT_INCREMENTAL_VACUUM_PAGES: 100,
  }));

  require("../../src/storage/storage-worker-thread");

  function emitMessage(message) {
    messageHandlers.message(message);
  }

  function messagesOfType(type) {
    return parentPort.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
  }

  return { parentPort, insert, close, emitMessage, messagesOfType, runCheckpointCycle };
}

afterEach(() => {
  jest.useRealTimers();
  jest.dontMock("node:worker_threads");
  jest.dontMock("../../src/storage/storage-db");
  jest.dontMock("../../src/storage/storage-checkpoint");
});

describe("storage-worker-thread", () => {
  test("posts ready on load, then acks a clean write batch with the right item count", async () => {
    const { emitMessage, messagesOfType } = setup();
    expect(messagesOfType("ready")).toHaveLength(1);

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }, { table: "trades", record: {} }] });

    const writesStarted = messagesOfType("write_started");
    expect(writesStarted).toHaveLength(1);
    expect(writesStarted[0]).toMatchObject({ id: "1", itemCount: 2 });
    const acks = messagesOfType("ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ id: "1", itemCount: 2 });
    await Promise.resolve();
  });

  test("a SQLITE_BUSY failure schedules a backoff retry and does not ack immediately", async () => {
    const insertImpl = jest
      .fn()
      .mockImplementationOnce(() => {
        throw sqliteError("SQLITE_BUSY");
      })
      .mockImplementation(() => {});
    const { emitMessage, messagesOfType } = setup({ insertImpl });

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });

    expect(messagesOfType("write_retry")).toHaveLength(1);
    expect(messagesOfType("ack")).toHaveLength(0);

    jest.advanceTimersByTime(100);
    expect(messagesOfType("ack")).toHaveLength(1);
    expect(messagesOfType("write_started")).toHaveLength(1);
    await Promise.resolve();
  });

  test("regression: an incoming write during a pending SQLITE_BUSY backoff does not bypass the delay", async () => {
    const insertImpl = jest
      .fn()
      .mockImplementationOnce(() => {
        throw sqliteError("SQLITE_BUSY");
      })
      .mockImplementation(() => {});
    const { emitMessage, messagesOfType } = setup({ insertImpl });

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });
    expect(messagesOfType("write_retry")).toHaveLength(1);
    expect(messagesOfType("ack")).toHaveLength(0);

    // A second, unrelated batch arrives before the backoff timer fires.
    emitMessage({ type: "write", id: "2", items: [{ table: "trades", record: {} }] });

    // The failed batch must still not have been retried yet -- only the
    // scheduled timer, once it actually fires, is allowed to retry it.
    expect(messagesOfType("ack")).toHaveLength(0);

    jest.advanceTimersByTime(100);
    jest.runOnlyPendingTimers();
    const acks = messagesOfType("ack");
    expect(acks.map((a) => a.id)).toEqual(["1", "2"]);
    await Promise.resolve();
  });

  test("gives up and posts fatal after exhausting the retry budget on a persistently retryable error", async () => {
    const insertImpl = jest.fn(() => {
      throw sqliteError("SQLITE_LOCKED");
    });
    const { emitMessage, messagesOfType, close } = setup({ insertImpl });

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(5_000);
    }

    expect(messagesOfType("fatal")).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  test("a non-retryable write error fails immediately without any retry attempt", async () => {
    const insertImpl = jest.fn(() => {
      throw new Error("constraint violation");
    });
    const { emitMessage, messagesOfType } = setup({ insertImpl });

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });

    expect(messagesOfType("write_retry")).toHaveLength(0);
    expect(messagesOfType("fatal")).toHaveLength(1);
    await Promise.resolve();
  });

  test("a full disk is a terminal durability failure and is never retried as lock contention", async () => {
    const insertImpl = jest.fn(() => {
      throw sqliteError("SQLITE_FULL");
    });
    const { emitMessage, messagesOfType, close } = setup({ insertImpl });

    emitMessage({ type: "write", id: "disk-full", items: [{ table: "trades", record: {} }] });

    expect(messagesOfType("write_retry")).toHaveLength(0);
    expect(messagesOfType("ack")).toHaveLength(0);
    expect(messagesOfType("fatal")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "SQLITE_FULL" }) }),
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  test("shutdown drains any queued batch before closing", async () => {
    const { emitMessage, messagesOfType, close } = setup();

    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });
    emitMessage({ type: "shutdown" });

    expect(messagesOfType("ack").map((a) => a.id)).toEqual(["1"]);
    expect(messagesOfType("stopped")).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("shutdown drains an already-queued maintenance task before closing, instead of dropping it", async () => {
    const insertImpl = jest
      .fn()
      .mockImplementationOnce(() => {
        throw sqliteError("SQLITE_BUSY");
      })
      .mockImplementation(() => {});
    const { emitMessage, messagesOfType, close } = setup({ insertImpl, checkpointIntervalMs: 50 });

    // Start a write that will retry after 100ms, blocking processNext() in
    // the meantime.
    emitMessage({ type: "write", id: "1", items: [{ table: "trades", record: {} }] });
    expect(messagesOfType("write_retry")).toHaveLength(1);

    // The checkpoint timer fires at 50ms, while the write retry is still
    // pending -- this queues a checkpoint maintenance task that cannot run
    // yet, proving it is genuinely still queued (not already drained) when
    // shutdown is requested next.
    jest.advanceTimersByTime(50);
    expect(messagesOfType("maintenance").some((m) => m.name === "checkpoint")).toBe(false);

    emitMessage({ type: "shutdown" });
    expect(messagesOfType("stopped")).toHaveLength(0);

    // The write retry fires at the 100ms mark; once it succeeds and the
    // write queue empties, the still-pending checkpoint task must run
    // before the worker actually closes. The retry ack and the maintenance
    // drain each chain their own follow-up processNext() via setImmediate,
    // so drain the immediate queue in a small loop rather than once.
    jest.advanceTimersByTime(50);
    for (let i = 0; i < 5 && messagesOfType("stopped").length === 0; i += 1) {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    }

    expect(messagesOfType("maintenance").some((m) => m.name === "checkpoint")).toBe(true);
    expect(messagesOfType("stopped")).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("live maintenance is bounded to a PASSIVE checkpoint", async () => {
    const { runCheckpointCycle, messagesOfType } = setup({ checkpointIntervalMs: 50 });

    jest.advanceTimersByTime(50);
    jest.runOnlyPendingTimers();
    await Promise.resolve();

    expect(runCheckpointCycle).toHaveBeenCalledWith(expect.any(Object), {
      incrementalVacuumPages: 100,
      deep: false,
    });
    expect(messagesOfType("maintenance")).toContainEqual(expect.objectContaining({
      name: "checkpoint",
      ok: true,
      result: expect.objectContaining({ deep: false, mode: "PASSIVE" }),
    }));
  });
});
