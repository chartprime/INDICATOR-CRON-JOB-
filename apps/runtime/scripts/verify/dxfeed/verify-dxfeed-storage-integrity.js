#!/usr/bin/env node

const path = require("node:path");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const {
  DEFAULT_DB_PATH, verifyDxFeedStorageIntegrity,
} = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createStorageLock } = require("../../../src/storage/storage-lock");

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-storage-integrity" }),
  dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH,
  verify = verifyDxFeedStorageIntegrity,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  exit = process.exit,
} = {}) {
  let lock = null;
  let exitCode = 0;
  try {
    lock = createLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
    logger.info("starting offline dxFeed SQLite quick_check", { dbPath });
    logger.ok("offline dxFeed SQLite integrity check passed", verify({ dbPath }));
  } catch (error) {
    exitCode = 1;
    logger.error("offline dxFeed SQLite integrity check failed", {
      dbPath, reason: error?.message ?? error,
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
    console.error("verify-dxfeed-storage-integrity: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main };
