const { main } = require("../../../scripts/maintain/maintain-storage");

// L1L2-V2-033/025: the live writer deliberately runs PASSIVE checkpoints only,
// deferring TRUNCATE + incremental_vacuum to an offline job -- which did not
// exist. Measured 2026-09-03: Binance WAL 855.5 MB against dxFeed's 6.2 MB on
// comparable databases, because the dxFeed collector runs its own deep cycle.

function fakeLogger() {
  const calls = { info: [], ok: [], error: [] };
  return {
    calls,
    info: (...a) => calls.info.push(a),
    ok: (...a) => calls.ok.push(a),
    error: (...a) => calls.error.push(a),
    flush: () => Promise.resolve(),
  };
}

function fakeLock(order, { acquireError = null } = {}) {
  return {
    acquire: () => { order.push("acquire"); if (acquireError) throw acquireError; },
    release: () => order.push("release"),
  };
}

const BASE = {
  dbPath: "/tmp/maintain.sqlite",
  createDb: () => ({ close: () => {} }),
  checkpoint: () => ({ mode: "TRUNCATE", checkpointedFrames: 10, busy: 0, logFrames: 10 }),
  statSync: () => ({ size: 0 }),
  exit: () => {},
};

describe("maintain-storage", () => {
  test("runs a DEEP checkpoint -- a PASSIVE one is what leaves the WAL unbounded", () => {
    let options = null;
    return main({
      ...BASE,
      logger: fakeLogger(),
      createLock: () => fakeLock([]),
      checkpoint: (_db, opts) => {
        options = opts;
        return { mode: "TRUNCATE", checkpointedFrames: 1 };
      },
    }).then(() => {
      expect(options).toMatchObject({ deep: true });
    });
  });

  test("holds the exclusive lock across the checkpoint and releases it after", async () => {
    const order = [];
    await main({
      ...BASE,
      logger: fakeLogger(),
      createLock: () => fakeLock(order),
      createDb: () => { order.push("open"); return { close: () => order.push("close") }; },
      checkpoint: () => { order.push("checkpoint"); return { mode: "TRUNCATE" }; },
    });

    expect(order).toEqual(["acquire", "open", "checkpoint", "close", "release"]);
  });

  test("never runs against a database another process holds", async () => {
    const order = [];
    let opened = false;
    const exitCode = await main({
      ...BASE,
      logger: fakeLogger(),
      createLock: () => fakeLock(order, { acquireError: new Error("already locked") }),
      createDb: () => { opened = true; return { close: () => {} }; },
    });

    expect(opened).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("releases the lock even when the checkpoint throws", async () => {
    const order = [];
    const exitCode = await main({
      ...BASE,
      logger: fakeLogger(),
      createLock: () => fakeLock(order),
      checkpoint: () => { throw new Error("checkpoint failed"); },
    });

    expect(order).toEqual(["acquire", "release"]);
    expect(exitCode).toBe(1);
  });

  test("reports how much WAL it actually reclaimed, so the job's effect is visible", async () => {
    const sizes = [900 * 1024 * 1024, 4 * 1024 * 1024];
    let call = 0;
    const logger = fakeLogger();
    await main({
      ...BASE,
      logger,
      createLock: () => fakeLock([]),
      statSync: () => ({ size: sizes[Math.min(call++, sizes.length - 1)] }),
    });

    expect(logger.calls.ok[0][1]).toMatchObject({
      walBytesBefore: sizes[0],
      walBytesAfter: sizes[1],
      walBytesReclaimed: sizes[0] - sizes[1],
    });
  });

  test("a missing WAL file is reported as unknown rather than crashing the job", async () => {
    const logger = fakeLogger();
    const exitCode = await main({
      ...BASE,
      logger,
      createLock: () => fakeLock([]),
      statSync: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    });

    expect(exitCode).toBe(0);
    expect(logger.calls.ok[0][1]).toMatchObject({ walBytesBefore: null, walBytesAfter: null, walBytesReclaimed: null });
  });

  test("does not migrate -- maintenance must never change the schema underneath a collector", async () => {
    let dbOptions = null;
    await main({
      ...BASE,
      logger: fakeLogger(),
      createLock: () => fakeLock([]),
      createDb: (opts) => { dbOptions = opts; return { close: () => {} }; },
    });

    expect(dbOptions).toMatchObject({ bootstrap: false, verifyIntegrity: false });
  });
});
