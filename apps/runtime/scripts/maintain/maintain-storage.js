#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { createStorageDb, DEFAULT_DB_PATH } = require("../../src/storage/storage-db");
const { createStorageLock } = require("../../src/storage/storage-lock");
const { runCheckpointCycle } = require("../../src/storage/storage-checkpoint");

function walBytes(dbPath, statSync) {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return null;
  }
}

async function main({
  logger = createCliLogger({ name: "maintain-storage" }),
  dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH,
  createDb = createStorageDb,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  checkpoint = runCheckpointCycle,
  statSync = fs.statSync,
  exit = process.exit,
} = {}) {
  let lock = null;
  let storageDb = null;
  let exitCode = 0;
  try {
    lock = createLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
    const walBefore = walBytes(dbPath, statSync);
    logger.info("starting exclusive offline storage maintenance", { dbPath, walBytesBefore: walBefore });
    storageDb = createDb({ dbPath, bootstrap: false, verifyIntegrity: false });
    const result = checkpoint(storageDb, { deep: true });
    const walAfter = walBytes(dbPath, statSync);
    logger.ok("offline storage maintenance complete", {
      dbPath,
      mode: result?.mode ?? null,
      checkpointedFrames: result?.checkpointedFrames ?? null,
      walBytesBefore: walBefore,
      walBytesAfter: walAfter,
      walBytesReclaimed: walBefore !== null && walAfter !== null ? walBefore - walAfter : null,
    });
  } catch (error) {
    exitCode = 1;
    logger.error("offline storage maintenance failed", {
      dbPath,
      reason: error?.message ?? error,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
    });
  } finally {
    try {
      storageDb?.close();
    } finally {
      lock?.release();
    }
  }
  await flushAndExit(logger, exit, exitCode);
  return exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("maintain-storage: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main };
