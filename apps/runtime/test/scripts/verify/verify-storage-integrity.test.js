const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageLock } = require("../../../src/storage/storage-lock");
const { main } = require("../../../scripts/verify/verify-storage-integrity");
const { safeRm } = require("../../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-integrity-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function cleanup(dbPath) {
  for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
}

function logger() {
  return { info: jest.fn(), ok: jest.fn(), error: jest.fn(), flush: jest.fn(() => Promise.resolve()) };
}

describe("verify-storage-integrity operational tool", () => {
  test("verifies a current offline database under the exclusive collector lock", async () => {
    const dbPath = tempDbPath();
    const db = createStorageDb({ dbPath });
    db.close();
    const exit = jest.fn();
    try {
      await main({ dbPath, logger: logger(), exit });
      expect(exit).toHaveBeenCalledWith(0);
      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    } finally {
      cleanup(dbPath);
    }
  });

  test("refuses to inspect a live collector database and never invokes SQLite verification", async () => {
    const dbPath = tempDbPath();
    const db = createStorageDb({ dbPath });
    db.close();
    const held = createStorageLock({ lockPath: `${dbPath}.lock` });
    held.acquire();
    const verify = jest.fn();
    const exit = jest.fn();
    try {
      await main({ dbPath, logger: logger(), verify, exit });
      expect(verify).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      held.release();
      cleanup(dbPath);
    }
  });

  test("releases ownership after verification failure so recovery tooling can proceed", async () => {
    const dbPath = tempDbPath();
    const db = createStorageDb({ dbPath });
    db.close();
    const exit = jest.fn();
    try {
      await main({ dbPath, logger: logger(), verify: () => { throw new Error("corrupt"); }, exit });
      expect(exit).toHaveBeenCalledWith(1);
      const next = createStorageLock({ lockPath: `${dbPath}.lock` });
      expect(() => next.acquire()).not.toThrow();
      next.release();
    } finally {
      cleanup(dbPath);
    }
  });

  test("fails closed when its own durable operator log cannot be flushed", async () => {
    const dbPath = tempDbPath();
    const db = createStorageDb({ dbPath });
    db.close();
    const exit = jest.fn();
    try {
      await main({ dbPath, logger: { ...logger(), flush: () => Promise.reject(new Error("disk full")) }, exit });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup(dbPath);
    }
  });
});
