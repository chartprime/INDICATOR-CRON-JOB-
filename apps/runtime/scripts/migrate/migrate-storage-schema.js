#!/usr/bin/env node

const path = require("node:path");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { createStorageDb, DEFAULT_DB_PATH, SCHEMA_VERSION } = require("../../src/storage/storage-db");
const { createStorageLock } = require("../../src/storage/storage-lock");

async function main({
  logger = createCliLogger({ name: "migrate-storage-schema" }),
  dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH,
  createDb = createStorageDb,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  exit = process.exit,
} = {}) {
  let lock = null;
  let storageDb = null;
  let exitCode = 0;
  try {
    lock = createLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
    logger.info("starting exclusive offline storage migration", { dbPath, targetSchemaVersion: SCHEMA_VERSION });
    storageDb = createDb({ dbPath, bootstrap: true, verifyIntegrity: false });
    logger.ok("offline storage migration complete", { dbPath, schemaVersion: SCHEMA_VERSION });
  } catch (error) {
    exitCode = 1;
    logger.error("offline storage migration failed", {
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
    console.error("migrate-storage-schema: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main };
