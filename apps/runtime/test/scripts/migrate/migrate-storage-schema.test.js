const { main: migrateBinance } = require("../../../scripts/migrate/migrate-storage-schema");
const { main: migrateDxFeed } = require("../../../scripts/migrate/migrate-dxfeed-storage-schema");

// These two scripts are the only things that mutate the live 40+GB databases,
// and neither had any test coverage (A2.19). What matters is not that a
// migration runs -- storage-db's own suites cover that -- but that the
// exclusive lock is always taken before and always released after, including
// on failure, and that a failure is reported as a non-zero exit rather than a
// silent success.

function fakeLogger() {
  const calls = { info: [], ok: [], error: [] };
  return {
    calls,
    info: (...args) => calls.info.push(args),
    ok: (...args) => calls.ok.push(args),
    error: (...args) => calls.error.push(args),
    flush: () => Promise.resolve(),
  };
}

function fakeLock(order, { acquireError = null } = {}) {
  return {
    acquire: () => {
      order.push("acquire");
      if (acquireError) throw acquireError;
    },
    release: () => order.push("release"),
  };
}

describe.each([
  ["migrate-storage-schema", migrateBinance],
  ["migrate-dxfeed-storage-schema", migrateDxFeed],
])("%s", (_name, main) => {
  test("takes the exclusive lock before migrating and releases it after", async () => {
    const order = [];
    const exit = jest.fn();
    const exitCode = await main({
      logger: fakeLogger(),
      dbPath: "/tmp/does-not-matter.sqlite",
      createLock: () => fakeLock(order),
      createDb: () => {
        order.push("migrate");
        return { close: () => order.push("close") };
      },
      exit,
    });

    expect(order).toEqual(["acquire", "migrate", "close", "release"]);
    expect(exitCode).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("releases the lock even when the migration itself throws", async () => {
    const order = [];
    const exit = jest.fn();
    const exitCode = await main({
      logger: fakeLogger(),
      dbPath: "/tmp/does-not-matter.sqlite",
      createLock: () => fakeLock(order),
      createDb: () => {
        throw new Error("migration blew up");
      },
      exit,
    });

    // A migration that failed while holding the lock would leave the database
    // permanently unopenable by the collector.
    expect(order).toEqual(["acquire", "release"]);
    expect(exitCode).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("reports a failed migration as a non-zero exit, not a silent success", async () => {
    const logger = fakeLogger();
    const exitCode = await main({
      logger,
      dbPath: "/tmp/does-not-matter.sqlite",
      createLock: () => fakeLock([]),
      createDb: () => {
        const error = new Error("disk full");
        error.code = "ENOSPC";
        throw error;
      },
      exit: jest.fn(),
    });

    expect(exitCode).toBe(1);
    expect(logger.calls.error).toHaveLength(1);
    expect(logger.calls.error[0][1]).toMatchObject({ reason: "disk full", code: "ENOSPC" });
    expect(logger.calls.ok).toHaveLength(0);
  });

  test("a lock it could not acquire is never released -- no stealing another process's lock", async () => {
    const order = [];
    const exitCode = await main({
      logger: fakeLogger(),
      dbPath: "/tmp/does-not-matter.sqlite",
      createLock: () => fakeLock(order, { acquireError: new Error("already locked") }),
      createDb: () => {
        order.push("migrate");
        return { close: () => order.push("close") };
      },
      exit: jest.fn(),
    });

    expect(order).toEqual(["acquire", "release"]);
    expect(exitCode).toBe(1);
  });

  test("locks the database it was asked to migrate, not a default path", async () => {
    let lockPath = null;
    await main({
      logger: fakeLogger(),
      dbPath: "/tmp/explicit-target.sqlite",
      createLock: (options) => {
        lockPath = options.lockPath;
        return fakeLock([]);
      },
      createDb: () => ({ close: () => {} }),
      exit: jest.fn(),
    });

    expect(lockPath).toBe("/tmp/explicit-target.sqlite.lock");
  });

  test("migrates with bootstrap on and integrity verification off", async () => {
    let dbOptions = null;
    await main({
      logger: fakeLogger(),
      dbPath: "/tmp/explicit-target.sqlite",
      createLock: () => fakeLock([]),
      createDb: (options) => {
        dbOptions = options;
        return { close: () => {} };
      },
      exit: jest.fn(),
    });

    expect(dbOptions).toMatchObject({
      dbPath: "/tmp/explicit-target.sqlite",
      bootstrap: true,
      verifyIntegrity: false,
    });
  });
});
