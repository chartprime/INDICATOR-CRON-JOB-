#!/usr/bin/env node

const path = require("node:path");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { DAY_MS, dayStartMs } = require("../../src/storage/archive-schedule");
const { createStorageDb, DEFAULT_DB_PATH } = require("../../src/storage/storage-db");
const { auditAndRecordDepthContinuityDay } = require("../../src/storage/storage-gap-audit");
const { createStorageLock } = require("../../src/storage/storage-lock");

function parseDay(value, nowMs) {
  if (value === undefined) return dayStartMs(nowMs) - DAY_MS;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("audit-storage-continuity: day must be YYYY-MM-DD in UTC");
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed % DAY_MS !== 0) {
    throw new Error("audit-storage-continuity: day is outside the supported UTC range");
  }
  return parsed;
}

async function main({
  logger = createCliLogger({ name: "audit-storage-continuity" }),
  argv = process.argv.slice(2),
  now = () => Date.now(),
  createDb = createStorageDb,
  audit = auditAndRecordDepthContinuityDay,
  createLock = ({ lockPath }) => createStorageLock({ lockPath }),
  exit = process.exit,
} = {}) {
  const dbPath = argv[0] ? path.resolve(argv[0]) : DEFAULT_DB_PATH;
  let lock = null;
  let storageDb = null;
  let exitCode = 0;
  try {
    const auditedAt = now();
    const targetDayStartMs = parseDay(argv[1], auditedAt);
    lock = createLock({ lockPath: `${dbPath}.lock` });
    lock.acquire();
    storageDb = createDb({ dbPath, bootstrap: false, verifyIntegrity: false });
    logger.info("starting exclusive offline depth continuity audit", {
      dbPath, day: new Date(targetDayStartMs).toISOString().slice(0, 10),
    });
    const result = audit(storageDb, { dayStartMs: targetDayStartMs, auditedAt });
    if (result.totalGaps > 0) {
      exitCode = 2;
      logger.error("depth continuity audit found sequence gaps", result);
    } else {
      logger.ok("depth continuity audit complete", result);
    }
  } catch (error) {
    exitCode = 1;
    logger.error("depth continuity audit failed", { dbPath, reason: error?.message ?? error });
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
    console.error("audit-storage-continuity: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main, parseDay };
