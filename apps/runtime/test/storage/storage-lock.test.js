const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createStorageLock, MAX_ACQUIRE_ATTEMPTS, LOCK_WRITE_GRACE_MS } = require("../../src/storage/storage-lock");
const { safeRm } = require("../helpers/temp-files");

function tempLockPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

describe("createStorageLock", () => {
  let lockPath;
  let spawnedChild;

  afterEach(async () => {
    if (spawnedChild) {
      spawnedChild.kill();
      await new Promise((resolve) => spawnedChild.once("exit", resolve));
      spawnedChild = null;
    }
    if (lockPath && fs.existsSync(lockPath)) {
      safeRm(lockPath, { force: true });
    }
  });

  test("rejects a missing/empty lockPath", () => {
    expect(() => createStorageLock({ lockPath: "" })).toThrow(/lockPath/);
  });

  test("acquires cleanly when no lock file exists, writing an owner token for this process", () => {
    lockPath = tempLockPath();
    const lock = createStorageLock({ lockPath });

    expect(() => lock.acquire()).not.toThrow();

    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, token: expect.any(String) });
    lock.release();
  });

  test("release() removes the lock file once it's ours", () => {
    lockPath = tempLockPath();
    const lock = createStorageLock({ lockPath });
    lock.acquire();

    lock.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release() is a no-op before acquire(), and safe to call twice", () => {
    lockPath = tempLockPath();
    const lock = createStorageLock({ lockPath });

    expect(() => lock.release()).not.toThrow();
    lock.acquire();
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("release() never deletes a lock file that a different process re-acquired after us", () => {
    lockPath = tempLockPath();
    const lock = createStorageLock({ lockPath });
    lock.acquire();

    fs.writeFileSync(lockPath, "999999");
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("999999");
  });

  test("a stale lock file left by a PID that no longer exists is silently reclaimed", () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, "999999");
    const lock = createStorageLock({ lockPath });

    expect(() => lock.acquire()).not.toThrow();

    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, token: expect.any(String) });
    lock.release();
  });

  test("exclusive creation prevents a second lock instance in this process from overwriting the owner", () => {
    lockPath = tempLockPath();
    const first = createStorageLock({ lockPath });
    const second = createStorageLock({ lockPath });
    first.acquire();
    const original = fs.readFileSync(lockPath, "utf8");

    expect(() => second.acquire()).toThrow(new RegExp(`PID ${process.pid}\\b`));
    expect(fs.readFileSync(lockPath, "utf8")).toBe(original);
    first.release();
  });

  test("creates a missing parent directory before atomically acquiring the lock", () => {
    const parent = path.join(os.tmpdir(), `terminal-l1-l2-storage-lock-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    lockPath = path.join(parent, "nested", "database.lock");
    const lock = createStorageLock({ lockPath });

    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
    safeRm(parent, { recursive: true, force: true });
  });

  test("restores (does not delete) a lock file another process concurrently wrote between our staleness check and cleanup", () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, "999999");
    const lock = createStorageLock({ lockPath });
    const concurrentOwner = JSON.stringify({ pid: process.pid, token: "concurrent-owner-token" });

    const realRename = fs.renameSync;
    let intercepted = false;
    const renameSpy = jest.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (!intercepted && src === lockPath) {
        intercepted = true;
        fs.writeFileSync(lockPath, concurrentOwner);
      }
      return realRename(src, dest);
    });

    try {
      expect(() => lock.acquire()).toThrow(new RegExp(`PID ${process.pid}\\b`));
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(lockPath, "utf8")).toBe(concurrentOwner);
  });

  test("a lock file containing garbage (not a valid PID) is treated as absent, not fatal", () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, "not-a-pid");
    const lock = createStorageLock({ lockPath });

    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });

  test("an empty lock file another collector has just created is waited on, not taken, until it names its owner", async () => {
    lockPath = tempLockPath();
    // The other collector's two steps: create the file, then write its owner.
    const child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.closeSync(fs.openSync(${JSON.stringify(lockPath)}, "wx"));
      process.stdout.write("created\\n");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, token: "other" })), 300);
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    spawnedChild = child;
    await new Promise((resolve) => child.stdout.once("data", resolve));

    const lock = createStorageLock({ lockPath });
    expect(() => lock.acquire()).toThrow(new RegExp(`PID ${child.pid}\\b`));
  });

  test("an empty lock file older than the write grace is reclaimed", () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, "");
    const past = (Date.now() - 10 * LOCK_WRITE_GRACE_MS) / 1_000;
    fs.utimesSync(lockPath, past, past);
    const lock = createStorageLock({ lockPath });

    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });

  test("an existing but permanently unreadable lock file gives up loudly instead of spinning forever", () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: "x" }));
    const readSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => {
      const error = new Error("EBUSY: resource busy or locked");
      error.code = "EBUSY";
      throw error;
    });
    try {
      const lock = createStorageLock({ lockPath, maxAcquireAttempts: 5 });
      expect(() => lock.acquire()).toThrow(/gave up acquiring .* after 5 attempts/);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("maxAcquireAttempts defaults to the exported bound and rejects an invalid override", () => {
    lockPath = tempLockPath();
    expect(Number.isSafeInteger(MAX_ACQUIRE_ATTEMPTS) && MAX_ACQUIRE_ATTEMPTS > 0).toBe(true);
    expect(() => createStorageLock({ lockPath, maxAcquireAttempts: 0 })).toThrow(/maxAcquireAttempts/);
  });

  test("acquire() throws, naming the real PID, when a genuinely running process already holds the lock", async () => {
    lockPath = tempLockPath();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.unref();
    spawnedChild = child;
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(lockPath, String(child.pid));

    const lock = createStorageLock({ lockPath });
    expect(() => lock.acquire()).toThrow(new RegExp(`PID ${child.pid}\\b`));
  });
});
