const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createStorageLock } = require("../../../src/storage/storage-lock");
const { main } = require("../../../scripts/verify/dxfeed/verify-dxfeed-storage-integrity");
const { safeRm } = require("../../helpers/temp-files");

// A2.19. The Binance integrity verifier has had a test file since Phase 6; its
// dxFeed twin, reachable as `npm run verify:dxfeed-storage-integrity`, had
// none -- the same one-sided coverage that let L1L2-V2-044 ship in three
// servers at once. What matters here is not that quick_check works (the db
// module covers that) but that the check holds the collector's exclusive lock
// for its whole run, releases it on every path, and reports a failure as a
// non-zero exit rather than a quiet pass.

function tempDbPath() {
  return path.join(os.tmpdir(), `dxfeed-integrity-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function cleanup(dbPath) {
  for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
}

function logger() {
  return { info: jest.fn(), ok: jest.fn(), error: jest.fn(), flush: jest.fn(() => Promise.resolve()) };
}

describe("verify-dxfeed-storage-integrity operational tool", () => {
  test("verifies a current offline database and leaves no lock behind", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const exit = jest.fn();
    const log = logger();
    try {
      const exitCode = await main({ dbPath, logger: log, exit });

      expect(exitCode).toBe(0);
      expect(exit).toHaveBeenCalledWith(0);
      expect(log.ok).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    } finally {
      cleanup(dbPath);
    }
  });

  test("holds the exclusive lock for the whole scan, not merely around the open", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    let lockedDuringVerify = false;
    try {
      await main({
        dbPath,
        logger: logger(),
        exit: jest.fn(),
        verify: () => {
          lockedDuringVerify = fs.existsSync(`${dbPath}.lock`);
          return { ok: true };
        },
      });

      expect(lockedDuringVerify).toBe(true);
      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    } finally {
      cleanup(dbPath);
    }
  });

  test("refuses to run while a live collector holds the lock", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const held = createStorageLock({ lockPath: `${dbPath}.lock` });
    held.acquire();
    const log = logger();
    let verified = false;
    try {
      const exitCode = await main({
        dbPath,
        logger: log,
        exit: jest.fn(),
        verify: () => {
          verified = true;
          return { ok: true };
        },
      });

      expect(exitCode).toBe(1);
      expect(verified).toBe(false);
      expect(log.ok).not.toHaveBeenCalled();
    } finally {
      held.release();
      cleanup(dbPath);
    }
  });

  test("reports a corrupt database as a non-zero exit, not a silent pass", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const log = logger();
    try {
      const failure = new Error("database disk image is malformed");
      failure.code = "SQLITE_CORRUPT";
      const exitCode = await main({
        dbPath,
        logger: log,
        exit: jest.fn(),
        verify: () => {
          throw failure;
        },
      });

      expect(exitCode).toBe(1);
      expect(log.ok).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0][1]).toMatchObject({
        reason: "database disk image is malformed",
        code: "SQLITE_CORRUPT",
      });
    } finally {
      cleanup(dbPath);
    }
  });

  test("releases the lock even when the check throws", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    try {
      await main({
        dbPath,
        logger: logger(),
        exit: jest.fn(),
        verify: () => {
          throw new Error("boom");
        },
      });

      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    } finally {
      cleanup(dbPath);
    }
  });

  test("verifies the database it was asked about, under that database's own lock", async () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    let lockPath = null;
    let verifiedPath = null;
    try {
      await main({
        dbPath,
        logger: logger(),
        exit: jest.fn(),
        createLock: (options) => {
          lockPath = options.lockPath;
          return { acquire: () => {}, release: () => {} };
        },
        verify: (options) => {
          verifiedPath = options.dbPath;
          return { ok: true };
        },
      });

      expect(lockPath).toBe(`${dbPath}.lock`);
      expect(verifiedPath).toBe(dbPath);
    } finally {
      cleanup(dbPath);
    }
  });
});
