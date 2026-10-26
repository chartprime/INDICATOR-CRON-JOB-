#!/usr/bin/env node

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { DEFAULT_DB_PATH: BINANCE_DB_PATH } = require("../../src/storage/storage-db");
const { DEFAULT_DB_PATH: DXFEED_DB_PATH } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createStorageLock } = require("../../src/storage/storage-lock");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");

const DEFAULT_MIN_SNAPSHOT_RESERVE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const PROVIDERS = Object.freeze([
  { name: "binance", dbPath: BINANCE_DB_PATH },
  { name: "dxfeed", dbPath: DXFEED_DB_PATH },
]);

function escapeSqliteStringLiteral(value) {
  return value.replace(/'/g, "''");
}

function vacuumSnapshot(dbPath, snapshotPath, { openDatabase = (p) => new Database(p, { readonly: true, fileMustExist: true }) } = {}) {
  const db = openDatabase(dbPath);
  try {
    db.exec(`VACUUM INTO '${escapeSqliteStringLiteral(snapshotPath)}'`);
  } finally {
    db.close();
  }
}

function snapshotSourceBytes(dbPath, { stat = fs.statSync } = {}) {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += stat(`${dbPath}${suffix}`).size;
    } catch (error) {
      if (suffix === "" || error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function preflightSnapshotSpace(dbPath, snapshotDir, {
  minReserveBytes = DEFAULT_MIN_SNAPSHOT_RESERVE_BYTES,
  stat = fs.statSync,
  statfs = fs.statfsSync,
} = {}) {
  if (!Number.isSafeInteger(minReserveBytes) || minReserveBytes < 0) {
    throw new Error("backup-to-drive: minReserveBytes must be a non-negative safe integer");
  }
  const sourceBytes = snapshotSourceBytes(dbPath, { stat });
  const { bavail, bsize } = statfs(snapshotDir);
  const freeBytes = bavail * bsize;
  const requiredBytes = sourceBytes + minReserveBytes;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < requiredBytes) {
    throw new Error(`backup-to-drive: snapshot volume requires ${requiredBytes} free bytes but only ${freeBytes} are available`);
  }
  return Object.freeze({ sourceBytes, freeBytes, requiredBytes });
}

function hashFileSha256(filePath, {
  open = fs.openSync,
  read = fs.readSync,
  close = fs.closeSync,
} = {}) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = open(filePath, "r");
  try {
    for (;;) {
      const bytesRead = read(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    close(fd);
  }
  return digest.digest("hex");
}

function backupRunId(now = () => new Date(), randomUuid = crypto.randomUUID) {
  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new Error("backup-to-drive: now() must return a valid Date");
  }
  const uuid = randomUuid();
  if (typeof uuid !== "string" || !/^[a-f0-9-]{8,}$/i.test(uuid)) {
    throw new Error("backup-to-drive: randomUuid() returned an invalid value");
  }
  return `${timestamp.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${uuid}`;
}

function artifactNames(provider, runId) {
  if (typeof provider?.name !== "string" || !/^[a-z0-9_-]+$/i.test(provider.name)) {
    throw new Error("backup-to-drive: provider name must be a safe filename component");
  }
  if (typeof runId !== "string" || !/^\d{8}T\d{9}Z-[a-f0-9-]+$/i.test(runId)) {
    throw new Error("backup-to-drive: runId is invalid");
  }
  const snapshotFileName = `${provider.name}-market-data-${runId}.sqlite`;
  return Object.freeze({ snapshotFileName, manifestFileName: `${snapshotFileName}.manifest.json` });
}

function verifySnapshot(snapshotPath, {
  openDatabase = (p) => new Database(p, { readonly: true, fileMustExist: true }),
  stat = fs.statSync,
  hashFile = hashFileSha256,
} = {}) {
  const db = openDatabase(snapshotPath);
  try {
    const result = db.pragma("integrity_check");
    const rows = Array.isArray(result) ? result : [result];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error("backup-to-drive: SQLite integrity_check did not return ok");
    }
  } finally {
    db.close();
  }
  const bytes = stat(snapshotPath).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("backup-to-drive: snapshot has no readable content");
  }
  const sha256 = hashFile(snapshotPath);
  return Object.freeze({ bytes, sha256, integrity: "ok" });
}

function runRclone(args, { spawnImpl = spawn, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    return Promise.reject(new Error("backup-to-drive: rclone args must be a non-empty string array"));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("backup-to-drive: rclone timeoutMs must be a positive safe integer"));
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timeout = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(value);
    };
    try {
      child = spawnImpl("rclone", args, { stdio: "inherit" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        settle(reject, new Error("rclone was not found on PATH -- install and configure it first (see rclone.org), this script cannot do that for you"));
        return;
      }
      settle(reject, error);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        settle(reject, new Error(`rclone was terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        settle(reject, new Error(`rclone exited with code ${code}`));
        return;
      }
      settle(resolve);
    });
    timeout = setTimeout(() => {
      try {
        child.kill?.("SIGTERM");
      } catch {
        void 0;
      }
      settle(reject, new Error(`rclone did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });
}

async function main({
  logger = createCliLogger({ name: "backup-to-drive" }),
  env = process.env,
  providers = PROVIDERS,
  snapshotDir = os.tmpdir(),
  vacuum = vacuumSnapshot,
  verify = verifySnapshot,
  runUpload = runRclone,
  now = () => new Date(),
  randomUuid = crypto.randomUUID,
  preflight = preflightSnapshotSpace,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  exit = process.exit,
} = {}) {
  const remote = env.TT_BACKUP_REMOTE;
  if (typeof remote !== "string" || remote.trim().length === 0 || /[\r\n\0]/.test(remote)) {
    logger.error("TT_BACKUP_REMOTE is not set -- expected an rclone remote:path, e.g. gdrive:arkeos-backups");
    await flushAndExit(logger, exit, 1);
    return;
  }

  logger.banner([
    "MANUAL DRIVE BACKUP",
    "one-shot VACUUM INTO snapshot + rclone upload, run only when you choose to",
    `remote   ${remote}`,
  ]);

  let anyFailed = false;
  let completedProviders = 0;
  let runId;
  let backupStartedAt;
  try {
    backupStartedAt = now();
    runId = backupRunId(() => backupStartedAt, randomUuid);
  } catch (error) {
    logger.error("could not establish a unique backup run identity", { reason: error?.message ?? error });
    await flushAndExit(logger, exit, 1);
    return;
  }
  const providerNames = new Set();
  for (const provider of providers) {
    if (providerNames.has(provider?.name)) {
      logger.error("backup provider names must be unique", { provider: provider?.name });
      await flushAndExit(logger, exit, 1);
      return;
    }
    providerNames.add(provider?.name);
  }
  for (const provider of providers) {
    if (!fs.existsSync(provider.dbPath)) {
      logger.warn(`${provider.name}: no live database found at ${provider.dbPath}, skipping`);
      continue;
    }
    const names = artifactNames(provider, runId);
    const snapshotPath = path.join(snapshotDir, names.snapshotFileName);
    const manifestPath = path.join(snapshotDir, names.manifestFileName);
    let lock = null;
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      lock = createLock({ lockPath: `${provider.dbPath}.lock` });
      lock.acquire();
      const capacity = preflight(provider.dbPath, snapshotDir);
      logger.info(`${provider.name}: taking a consistent snapshot`, { dbPath: provider.dbPath, snapshotPath });
      vacuum(provider.dbPath, snapshotPath);
      const verification = verify(snapshotPath);
      lock.release();
      lock = null;
      const manifest = Object.freeze({
        version: 1,
        backupCommit: "COMPLETE",
        provider: provider.name,
        createdAt: backupStartedAt.toISOString(),
        snapshotFileName: names.snapshotFileName,
        ...verification,
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" });
      logger.info(`${provider.name}: uploading immutable snapshot and manifest`, { remote, sha256: verification.sha256, bytes: verification.bytes });
      logger.info(`${provider.name}: local capacity preflight passed`, capacity);
      await runUpload(["copyto", "--checksum", snapshotPath, `${remote}/${names.snapshotFileName}`], { logger });
      await runUpload(["copyto", "--checksum", manifestPath, `${remote}/${names.manifestFileName}`], { logger });
      logger.ok(`${provider.name}: backup uploaded and locally verified`);
      completedProviders += 1;
      fs.rmSync(snapshotPath, { force: true });
      fs.rmSync(manifestPath, { force: true });
    } catch (error) {
      anyFailed = true;
      logger.error(`${provider.name}: backup failed; local artifacts retained for inspection/retry`, { reason: error?.message ?? error });
    } finally {
      lock?.release();
    }
  }

  if (completedProviders === 0) {
    anyFailed = true;
    logger.error("backup produced no completed provider artifacts");
  }
  await flushAndExit(logger, exit, anyFailed ? 1 : 0);
}

if (require.main === module) {
  main().catch(() => {
    console.error("backup-to-drive: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = {
  main,
  vacuumSnapshot,
  verifySnapshot,
  backupRunId,
  artifactNames,
  runRclone,
  hashFileSha256,
  snapshotSourceBytes,
  preflightSnapshotSpace,
  PROVIDERS,
  DEFAULT_MIN_SNAPSHOT_RESERVE_BYTES,
  DEFAULT_UPLOAD_TIMEOUT_MS,
};
