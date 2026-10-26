const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const Database = require("better-sqlite3");
const {
  main, vacuumSnapshot, verifySnapshot, backupRunId, artifactNames, runRclone,
  preflightSnapshotSpace,
} = require("../../../scripts/maintain/backup-to-drive");
const { createStorageLock } = require("../../../src/storage/storage-lock");
const { safeRm } = require("../../helpers/temp-files");

function noopLogger() {
  return { info: jest.fn(), ok: jest.fn(), warn: jest.fn(), error: jest.fn(), banner: jest.fn() };
}

function tempPath(name) {
  return path.join(os.tmpdir(), `terminal-l1-l2-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function baseOptions(overrides = {}) {
  return {
    logger: noopLogger(),
    env: { TT_BACKUP_REMOTE: "gdrive:arkeos-backups" },
    exit: jest.fn(),
    providers: [
      { name: "binance", dbPath: tempPath("binance.sqlite"), snapshotFileName: "binance-backup.sqlite" },
      { name: "dxfeed", dbPath: tempPath("dxfeed.sqlite"), snapshotFileName: "dxfeed-backup.sqlite" },
    ],
    vacuum: jest.fn(),
    verify: jest.fn(() => ({ bytes: 8, sha256: "a".repeat(64) })),
    runUpload: jest.fn(async () => undefined),
    now: () => new Date("2026-08-29T21:33:49.123Z"),
    randomUuid: () => "12345678-1234-4123-8123-123456789abc",
    ...overrides,
  };
}

describe("backup-to-drive main()", () => {
  test("fails closed with a clear message when TT_BACKUP_REMOTE is not set -- never silently does nothing", async () => {
    const exit = jest.fn();
    const logger = noopLogger();
    await main(baseOptions({ env: {}, exit, logger }));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("TT_BACKUP_REMOTE"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("fails visibly when no provider database exists so a no-op cannot masquerade as a backup", async () => {
    const exit = jest.fn();
    const vacuum = jest.fn();
    const logger = noopLogger();
    const options = baseOptions({ exit, vacuum, logger });
    // Neither provider's dbPath exists on disk (tempPath() never creates the file).
    await main(options);

    expect(vacuum).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("backup produced no completed provider artifacts");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("happy path: writes a unique immutable snapshot plus checksum manifest, uploads both, then removes local artifacts", async () => {
    const dbPath = tempPath("binance.sqlite");
    fs.writeFileSync(dbPath, "");
    const exit = jest.fn();
    const vacuum = jest.fn((from, to) => fs.writeFileSync(to, "snapshot"));
    const runUpload = jest.fn(async () => undefined);
    const providers = [{ name: "binance", dbPath }];
    await main(baseOptions({ exit, vacuum, runUpload, providers }));

    expect(vacuum).toHaveBeenCalledWith(dbPath, expect.stringContaining("binance-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite"));
    expect(runUpload).toHaveBeenCalledWith(
      ["copyto", "--checksum", expect.stringContaining("binance-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite"), "gdrive:arkeos-backups/binance-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite"],
      expect.anything(),
    );
    expect(runUpload).toHaveBeenCalledWith(
      ["copyto", "--checksum", expect.stringContaining(".manifest.json"), "gdrive:arkeos-backups/binance-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite.manifest.json"],
      expect.anything(),
    );
    expect(runUpload).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(0);
    safeRm(dbPath, { force: true });
  });

  test("one provider's vacuum failure is reported and fails the run, but does not stop the other provider from being attempted", async () => {
    const binancePath = tempPath("binance.sqlite");
    const dxfeedPath = tempPath("dxfeed.sqlite");
    fs.writeFileSync(binancePath, "");
    fs.writeFileSync(dxfeedPath, "");
    const exit = jest.fn();
    const logger = noopLogger();
    const vacuum = jest.fn((from) => {
      if (from === binancePath) throw new Error("disk full");
    });
    const runUpload = jest.fn(async () => undefined);
    const providers = [{ name: "binance", dbPath: binancePath }, { name: "dxfeed", dbPath: dxfeedPath }];
    await main(baseOptions({ exit, logger, vacuum, runUpload, providers }));

    expect(logger.error).toHaveBeenCalledWith("binance: backup failed; local artifacts retained for inspection/retry", expect.objectContaining({ reason: "disk full" }));
    expect(vacuum).toHaveBeenCalledTimes(2);
    expect(runUpload).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(1);
    safeRm(binancePath, { force: true });
    safeRm(dxfeedPath, { force: true });
  });

  test("a failed upload leaves both local snapshot and manifest artifacts on disk, instead of deleting recovery evidence", async () => {
    const dbPath = tempPath("binance.sqlite");
    fs.writeFileSync(dbPath, "");
    const snapshotDir = os.tmpdir();
    const vacuum = jest.fn((from, to) => fs.writeFileSync(to, "snapshot"));
    const runUpload = jest.fn(async () => {
      throw new Error("rclone exited with code 1");
    });
    const providers = [{ name: "binance", dbPath }];
    await main(baseOptions({ vacuum, runUpload, providers, snapshotDir }));

    const names = artifactNames(providers[0], backupRunId(() => new Date("2026-08-29T21:33:49.123Z"), () => "12345678-1234-4123-8123-123456789abc"));
    expect(fs.existsSync(path.join(snapshotDir, names.snapshotFileName))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, names.manifestFileName))).toBe(true);
    safeRm(path.join(snapshotDir, names.snapshotFileName), { force: true });
    safeRm(path.join(snapshotDir, names.manifestFileName), { force: true });
    safeRm(dbPath, { force: true });
  });

  test("refuses to snapshot a database while its collector ownership lock is held", async () => {
    const dbPath = tempPath("locked.sqlite");
    fs.writeFileSync(dbPath, "");
    const held = createStorageLock({ lockPath: `${dbPath}.lock` });
    held.acquire();
    const exit = jest.fn();
    const logger = noopLogger();
    try {
      await main(baseOptions({ providers: [{ name: "binance", dbPath }], exit, logger }));
      expect(exit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(
        "binance: backup failed; local artifacts retained for inspection/retry",
        expect.objectContaining({ reason: expect.stringMatching(/already owned/) }),
      );
    } finally {
      held.release();
      safeRm(dbPath, { force: true });
    }
  });
});

describe("vacuumSnapshot", () => {
  test("produces a real, independently-readable snapshot of a live database's current rows", () => {
    const dbPath = tempPath("source.sqlite");
    const snapshotPath = tempPath("snapshot.sqlite");
    const source = new Database(dbPath);
    source.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    source.prepare("INSERT INTO t (value) VALUES (?)").run("hello");
    source.close();

    vacuumSnapshot(dbPath, snapshotPath);

    const snapshot = new Database(snapshotPath, { readonly: true });
    expect(snapshot.prepare("SELECT value FROM t").get()).toEqual({ value: "hello" });
    snapshot.close();
    for (const p of [dbPath, snapshotPath]) {
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${p}${suffix}`, { force: true });
    }
  });

  test("refuses to overwrite an existing immutable snapshot artifact", () => {
    const dbPath = tempPath("source.sqlite");
    const snapshotPath = tempPath("snapshot.sqlite");
    const source = new Database(dbPath);
    source.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    source.close();
    fs.writeFileSync(snapshotPath, "stale garbage from a prior failed run");

    expect(() => vacuumSnapshot(dbPath, snapshotPath)).toThrow();
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe("stale garbage from a prior failed run");
    for (const p of [dbPath, snapshotPath]) {
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${p}${suffix}`, { force: true });
    }
  });
});

describe("backup artifact verification", () => {
  test("uses a timestamp plus UUID path, preventing overwrite of an earlier remote backup", () => {
    const runId = backupRunId(() => new Date("2026-08-29T21:33:49.123Z"), () => "12345678-1234-4123-8123-123456789abc");
    expect(artifactNames({ name: "dxfeed" }, runId)).toEqual({
      snapshotFileName: "dxfeed-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite",
      manifestFileName: "dxfeed-market-data-20260829T213349123Z-12345678-1234-4123-8123-123456789abc.sqlite.manifest.json",
    });
  });

  test("accepts an independently readable SQLite snapshot and returns its immutable digest", () => {
    const dbPath = tempPath("verified.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
    expect(verifySnapshot(dbPath)).toEqual(expect.objectContaining({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("fails capacity preflight before snapshot creation when free space cannot hold source plus reserve", () => {
    expect(() => preflightSnapshotSpace("source.sqlite", os.tmpdir(), {
      minReserveBytes: 100,
      stat: (pathname) => {
        if (pathname === "source.sqlite") return { size: 1_000 };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      statfs: () => ({ bavail: 10, bsize: 10 }),
    })).toThrow(/requires 1100 free bytes but only 100/);
  });

  test("hashing is delegated to a bounded file hasher rather than reading the snapshot wholesale", () => {
    const dbPath = tempPath("hash-injected.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
    const hashFile = jest.fn(() => "b".repeat(64));
    expect(verifySnapshot(dbPath, { hashFile })).toMatchObject({ sha256: "b".repeat(64), integrity: "ok" });
    expect(hashFile).toHaveBeenCalledWith(dbPath);
    safeRm(dbPath, { force: true });
  });
});

describe("runRclone", () => {
  function fakeChild() {
    const emitter = new EventEmitter();
    return emitter;
  }

  test("a friendly, actionable error when rclone is not installed (ENOENT), not a raw stack trace", async () => {
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const promise = runRclone(["copyto", "a", "b"], { spawnImpl });
    const enoent = Object.assign(new Error("spawn rclone ENOENT"), { code: "ENOENT" });
    child.emit("error", enoent);

    await expect(promise).rejects.toThrow(/rclone was not found on PATH/);
  });

  test("a non-zero exit code is reported, not silently treated as success", async () => {
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const promise = runRclone(["copyto", "a", "b"], { spawnImpl });
    child.emit("exit", 1, null);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  test("a successful run (exit code 0) resolves", async () => {
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const promise = runRclone(["copyto", "a", "b"], { spawnImpl });
    child.emit("exit", 0, null);

    await expect(promise).resolves.toBeUndefined();
  });

  test("termination by signal is reported, not silently treated as success", async () => {
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const promise = runRclone(["copyto", "a", "b"], { spawnImpl });
    child.emit("exit", null, "SIGKILL");

    await expect(promise).rejects.toThrow(/SIGKILL/);
  });

  test("a hung upload is terminated after its explicit deadline", async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    child.kill = jest.fn();
    const promise = runRclone(["copyto", "a", "b"], { spawnImpl: () => child, timeoutMs: 1_000 });
    jest.advanceTimersByTime(1_000);
    await expect(promise).rejects.toThrow(/did not complete within 1000ms/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    jest.useRealTimers();
  });
});
