#!/usr/bin/env node

const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { DEFAULT_DB_PATH, verifyStorageIntegrity } = require("../../src/storage/storage-db");
const { createStorageLock } = require("../../src/storage/storage-lock");

async function main({
  logger = createCliLogger({ name: "verify-storage-integrity" }),
  dbPath = DEFAULT_DB_PATH,
  verify = verifyStorageIntegrity,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  exit = process.exit,
} = {}) {
  let lock = null;
  let exitCode = 0;
  try {
    lock = createLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
    logger.info("starting offline SQLite quick_check", { dbPath });
    const result = verify({ dbPath });
    logger.ok("offline SQLite integrity check passed", result);
  } catch (error) {
    exitCode = 1;
    logger.error("offline SQLite integrity check failed", {
      reason: error?.message ?? error,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
    });
  } finally {
    lock?.release();
  }
  await flushAndExit(logger, exit, exitCode);
  return exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("verify-storage-integrity: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main };
