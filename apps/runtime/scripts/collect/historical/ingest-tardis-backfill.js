#!/usr/bin/env node
"use strict";

const { spawnSync, execFile } = require("node:child_process");
const { Transform, pipeline } = require("node:stream");
const { promisify } = require("node:util");
const { coverageFiles } = require("./coverage-files");
const { streamToRclone } = require("../../../src/platform/rclone-stream");
const path = require("node:path");
const fs = require("node:fs");
const { getApiKeyAccessInfo } = require("tardis-dev");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { fetchWithRetry } = require("./tardis-datasets-api");

const execFileAsync = promisify(execFile);

const BUCKET = "s3:chartprime-historical-data";
const S3_ROOT = `${BUCKET}/raw/tardis`;
const ANCHOR_DATE = new Date(Date.UTC(2025, 8, 6));
const DEFAULT_CONCURRENCY_LIMIT = 4;
const DEFAULT_STALL_MS = 5 * 60_000;
const DEFAULT_UPLOAD_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_JOB_ATTEMPTS = 3;
const VERIFY_CONCURRENCY_LIMIT = 8;
const PROGRESS_LOG_INTERVAL_MS = 60_000;
const PROVIDER_GAP_STATUSES = new Set([403, 404]);

function resolvePositiveInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function resolveConcurrencyLimit(env = process.env) {
  return resolvePositiveInteger(env, "TARDIS_BACKFILL_CONCURRENCY", DEFAULT_CONCURRENCY_LIMIT);
}

function resolveJobSettings(env = process.env) {
  return {
    stallMs: resolvePositiveInteger(env, "TARDIS_STALL_MS", DEFAULT_STALL_MS),
    uploadMaxMs: resolvePositiveInteger(env, "TARDIS_UPLOAD_MAX_MS", DEFAULT_UPLOAD_MAX_MS),
    jobAttempts: resolvePositiveInteger(env, "TARDIS_JOB_ATTEMPTS", DEFAULT_JOB_ATTEMPTS),
  };
}

const CONCURRENCY_LIMIT = resolveConcurrencyLimit();
const JOB_SETTINGS = resolveJobSettings();

const PERP_ONLY_TYPES = ["derivative_ticker", "liquidations"];
const SHARED_TYPES = ["trades", "incremental_book_L2", "book_snapshot_25", "book_ticker"];
const SERIES_ORDER = ["liquidations", "derivative_ticker", "trades", "book_snapshot_25", "book_ticker", "incremental_book_L2"];

const TARGETS = [
  { exchange: "binance", symbol: "btcusdt", dataTypes: SHARED_TYPES },
  { exchange: "binance", symbol: "ethusdt", dataTypes: SHARED_TYPES },
  { exchange: "binance-futures", symbol: "btcusdt", dataTypes: [...SHARED_TYPES, ...PERP_ONLY_TYPES] },
  { exchange: "binance-futures", symbol: "ethusdt", dataTypes: [...SHARED_TYPES, ...PERP_ONLY_TYPES] },
];

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeCutoffDate() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return now.getUTCHours() >= 6 ? addDays(today, -1) : addDays(today, -2);
}

function findRclone() {
  const whereBin = process.platform === "win32" ? "where" : "which";
  const whereResult = spawnSync(whereBin, ["rclone"], { encoding: "utf-8" });
  if (whereResult.status === 0) {
    const first = (whereResult.stdout || "").split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
  }
  const wingetRoot = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(wingetRoot)) {
    const stack = [wingetRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === "rclone.exe") return full;
      }
    }
  }
  throw new Error("rclone.exe not found on PATH or in WinGet packages");
}

function latestCoverageFor(rcloneBin, exchange, dataType, symbolUpper) {
  const target = `${S3_ROOT}/exchange=${exchange}/data_type=${dataType}/symbol=${symbolUpper}/`;
  const fileNames = [...coverageFiles(rcloneBin, target)].map((line) => line.split("/").pop());
  let latest = null;
  for (const fileName of fileNames) {
    const match = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!match) continue;
    const covered = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!latest || covered > latest) latest = covered;
  }
  return latest;
}

function destPathFor(exchange, dataType, symbolUpper, date) {
  const dateStr = isoDate(date);
  const fileName = `${exchange}_${dataType}_${dateStr}_${symbolUpper}.csv.gz`;
  return `raw/tardis/exchange=${exchange}/data_type=${dataType}/symbol=${symbolUpper}/year=${date.getUTCFullYear()}/month=${pad(date.getUTCMonth() + 1)}/day=${pad(date.getUTCDate())}/${fileName}`;
}

function* expectedDays(cutoff = safeCutoffDate()) {
  for (const target of TARGETS) {
    const symbolUpper = target.symbol.toUpperCase();
    for (const dataType of target.dataTypes) {
      for (let cursor = new Date(ANCHOR_DATE); cursor <= cutoff; cursor = addDays(cursor, 1)) {
        yield {
          exchange: target.exchange,
          symbol: target.symbol,
          symbolUpper,
          dataType,
          date: new Date(cursor),
          destPath: destPathFor(target.exchange, dataType, symbolUpper, cursor),
        };
      }
    }
  }
}

function buildJobs(rcloneBin, { cutoff = safeCutoffDate(), coverageImpl = coverageFiles } = {}) {
  const existingByPrefix = new Map();
  const jobs = [];
  for (const job of expectedDays(cutoff)) {
    const prefix = `raw/tardis/exchange=${job.exchange}/data_type=${job.dataType}/symbol=${job.symbolUpper}/`;
    if (!existingByPrefix.has(prefix)) existingByPrefix.set(prefix, coverageImpl(rcloneBin, `${BUCKET}/${prefix}`));
    if (!existingByPrefix.get(prefix).has(job.destPath.slice(prefix.length))) jobs.push(job);
  }
  return jobs;
}

function seriesRank(job) {
  const base = SERIES_ORDER.indexOf(job.dataType);
  const rank = base === -1 ? SERIES_ORDER.length : base;
  return rank * 2 + (job.dataType === "incremental_book_L2" && job.exchange === "binance-futures" ? 1 : 0);
}

function orderJobs(jobs) {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((a, b) => seriesRank(a.job) - seriesRank(b.job) || a.index - b.index)
    .map(({ job }) => job);
}

function providerSize(res) {
  const headers = res.headers || {};
  for (const name of ["content-length", "x-dataset-size"]) {
    const value = Number(headers[name]);
    if (headers[name] !== undefined && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function stallGuard(source, stallMs) {
  let bytes = 0;
  let timer = null;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      arm();
      callback(null, chunk);
    },
  });
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      counter.destroy(Object.assign(new Error(`no bytes moved for ${stallMs} ms`), { code: "TARDIS_STALL" }));
    }, stallMs);
  }
  counter.on("end", () => clearTimeout(timer));
  counter.on("close", () => clearTimeout(timer));
  arm();
  pipeline(source, counter, () => clearTimeout(timer));
  return { stream: counter, bytes: () => bytes };
}

async function storedObjectSize(rcloneBin, destPath) {
  const { stdout } = await execFileAsync(rcloneBin, ["lsjson", `${BUCKET}/${destPath}`], {
    encoding: "utf-8", windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  const entry = JSON.parse(stdout).find((item) => !item.IsDir);
  return entry ? entry.Size : null;
}

function jobLabelFor(job) {
  return `${job.exchange}/${job.symbolUpper.padEnd(8)} ${job.dataType.padEnd(20)} ${isoDate(job.date)}`;
}

async function runJob(apiKey, job, logger, rcloneBin, {
  settings = JOB_SETTINGS,
  objectSizeImpl = storedObjectSize,
  sleepImpl = sleep,
} = {}) {
  const jobLabel = jobLabelFor(job);
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchWithRetry(apiKey, { exchange: job.exchange, dataType: job.dataType, date: job.date, symbol: job.symbol }, {
      onRetry: ({ attempt: requestAttempt, maxAttempts, reason, statusCode, waitMs }) => {
        logger.warn(`${jobLabel}  retrying`, { attempt: requestAttempt, maxAttempts, reason, statusCode: statusCode ?? "n/a", waitMs: Math.round(waitMs) });
      },
    });
    const expected = providerSize(res);
    const guard = stallGuard(res, settings.stallMs);
    try {
      await streamToRclone(guard.stream, `${BUCKET}/${job.destPath}`, { rcloneBin, timeoutMs: settings.uploadMaxMs });
      if (expected === null) {
        logger.warn(`${jobLabel}  streamed without a provider size`, { dest: job.destPath, bytes: guard.bytes() });
        return { verified: false, bytes: guard.bytes() };
      }
      const stored = await objectSizeImpl(rcloneBin, job.destPath);
      if (guard.bytes() !== expected || stored !== expected) {
        throw Object.assign(new Error(`size mismatch: provider ${expected}, streamed ${guard.bytes()}, stored ${stored}`), { code: "SIZE_MISMATCH" });
      }
      logger.info(`${jobLabel}  streamed`, { dest: job.destPath, bytes: expected });
      return { verified: true, bytes: expected };
    } catch (error) {
      if (error.code === "RCLONE_CHILD_EXIT_UNCONFIRMED" || attempt >= settings.jobAttempts) throw error;
      const waitMs = Math.min(2 ** attempt * 1000, 120_000) + Math.random() * 500;
      logger.warn(`${jobLabel}  day retrying`, {
        attempt, maxAttempts: settings.jobAttempts, reason: error.message, bytes: guard.bytes(), waitMs: Math.round(waitMs),
      });
      await sleepImpl(waitMs);
    }
  }
}

async function runWithConcurrency(jobs, limit, worker, { onTick } = {}) {
  let cursor = 0;
  let done = 0;
  const failed = [];
  const unverified = [];
  let ownershipLost = false;
  async function lane() {
    for (;;) {
      if (ownershipLost) return;
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      try {
        const result = await worker(jobs[index]);
        done += 1;
        if (result && result.verified === false) unverified.push(jobs[index]);
      } catch (error) {
        failed.push({ job: jobs[index], reason: error.message, status: error.status ?? null, code: error.code ?? null });
        if (error.code === "RCLONE_CHILD_EXIT_UNCONFIRMED") ownershipLost = true;
      }
      onTick?.({ done, failedCount: failed.length, total: jobs.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => lane()));
  return { done, failed, unverified, skipped: jobs.length - done - failed.length };
}

async function listStoredSizes(rcloneBin) {
  const { stdout } = await execFileAsync(rcloneBin, ["lsjson", "--recursive", "--files-only", S3_ROOT], {
    encoding: "utf-8", windowsHide: true, timeout: 600_000, maxBuffer: 512 * 1024 * 1024,
  });
  const sizes = new Map();
  for (const entry of JSON.parse(stdout)) sizes.set(`raw/tardis/${entry.Path.replace(/\\/g, "/")}`, entry.Size);
  return sizes;
}

async function probeProviderSize(apiKey, job) {
  const res = await fetchWithRetry(apiKey, { exchange: job.exchange, dataType: job.dataType, date: job.date, symbol: job.symbol });
  const size = providerSize(res);
  res.destroy();
  return size;
}

async function verifyExisting(apiKey, rcloneBin, logger, {
  cutoff = safeCutoffDate(),
  listImpl = listStoredSizes,
  probeImpl = probeProviderSize,
  limit = VERIFY_CONCURRENCY_LIMIT,
} = {}) {
  const stored = await listImpl(rcloneBin);
  const present = [...expectedDays(cutoff)].filter((job) => stored.has(job.destPath));
  const mismatched = [];
  const unverifiable = [];
  let lastProgressLoggedAt = 0;
  const { failed } = await runWithConcurrency(present, limit, async (job) => {
    const size = await probeImpl(apiKey, job);
    const storedSize = stored.get(job.destPath);
    if (size === null) unverifiable.push(job);
    else if (size !== storedSize) mismatched.push({ job, providerSize: size, storedSize });
  }, {
    onTick: ({ done, failedCount, total }) => {
      const t = Date.now();
      if (t - lastProgressLoggedAt < PROGRESS_LOG_INTERVAL_MS) return;
      lastProgressLoggedAt = t;
      logger.info(`verify: ${done + failedCount}/${total} existing objects checked`, { mismatched: mismatched.length, failed: failedCount });
    },
  });
  return { checked: present.length, mismatched, unverifiable, failed };
}

function countBySeries(jobs) {
  const counts = {};
  for (const job of jobs) {
    const key = `${job.exchange}/${job.symbolUpper}/${job.dataType}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function describeJob(job) {
  return `${job.exchange}/${job.symbolUpper}/${job.dataType}/${isoDate(job.date)}`;
}

async function checkEntitlement(apiKey, logger) {
  const info = await getApiKeyAccessInfo(apiKey);
  const byExchange = new Map(info.map((entry) => [entry.exchange, entry]));
  const missing = TARGETS.map((t) => t.exchange).filter((exchange, i, arr) => arr.indexOf(exchange) === i && !byExchange.has(exchange));
  if (missing.length > 0) {
    logger.error("real entitlement check failed -- not entitled to", { missing });
    return false;
  }
  for (const exchange of new Set(TARGETS.map((t) => t.exchange))) {
    const entry = byExchange.get(exchange);
    logger.info(`entitlement: ${exchange}`, { accessType: entry.accessType, dataPlan: entry.dataPlan, from: entry.from });
  }
  return true;
}

async function main({
  logger = createCliLogger({ name: "ingest-tardis-backfill" }),
  exit = process.exit,
  dryRun = false,
  verify = false,
  now = () => Date.now(),
} = {}) {
  const apiKey = process.env.tardis_key;
  if (!apiKey) {
    logger.error("tardis_key not set in environment");
    await flushAndExit(logger, exit, 1);
    return;
  }

  let rcloneBin;
  try {
    rcloneBin = findRclone();
  } catch (error) {
    logger.error("rclone not found", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }

  logger.banner([
    "TARDIS BACKFILL",
    "compares every expected daily object against S3 inventory, including interior gaps",
    verify ? "verifies every existing object's size against Tardis before pulling" : "existing objects are trusted; pass --verify-existing to size-check them",
    `publish-lag-aware cutoff: ${isoDate(safeCutoffDate())}`,
  ]);

  const entitled = await checkEntitlement(apiKey, logger);
  if (!entitled) {
    await flushAndExit(logger, exit, 1);
    return;
  }

  let jobs;
  try {
    jobs = buildJobs(rcloneBin);
  } catch (error) {
    logger.error("inventory failed; uploads not started", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }
  logger.info(`${jobs.length} missing day-file(s) across ${TARGETS.length} symbols`, { bySeries: countBySeries(jobs) });

  let unverifiableExisting = [];
  if (verify) {
    let result;
    try {
      result = await verifyExisting(apiKey, rcloneBin, logger);
    } catch (error) {
      logger.error("existing-object verification failed; uploads not started", { reason: error.message });
      await flushAndExit(logger, exit, 1);
      return;
    }
    unverifiableExisting = result.unverifiable;
    logger.info("existing objects verified against provider sizes", {
      checked: result.checked,
      mismatched: result.mismatched.length,
      unverifiable: result.unverifiable.length,
      probeFailures: result.failed.length,
      mismatchedDays: result.mismatched.slice(0, 30).map(({ job, providerSize: expected, storedSize }) => `${describeJob(job)}: provider ${expected}, stored ${storedSize}`),
    });
    if (result.failed.length > 0) {
      logger.error("some existing objects could not be probed; uploads not started", {
        failed: result.failed.slice(0, 30).map(({ job, reason }) => `${describeJob(job)}: ${reason}`),
      });
      await flushAndExit(logger, exit, 1);
      return;
    }
    jobs.push(...result.mismatched.map(({ job }) => job));
  }

  jobs = orderJobs(jobs);
  if (jobs.length === 0) {
    logger.ok("no missing or short objects through the safe cutoff", { unverifiableExisting: unverifiableExisting.length });
    await flushAndExit(logger, exit, 0);
    return;
  }
  logger.info(`${jobs.length} day-file(s) to pull`, { concurrency: CONCURRENCY_LIMIT, ...JOB_SETTINGS });

  if (dryRun) {
    for (const job of jobs.slice(0, 20)) {
      console.log(`  ${job.exchange}/${job.symbolUpper.padEnd(8)} ${job.dataType.padEnd(20)} ${isoDate(job.date)}  -> ${job.destPath}`);
    }
    if (jobs.length > 20) console.log(`  ... and ${jobs.length - 20} more`);
    await flushAndExit(logger, exit, 0);
    return;
  }

  let lastProgressLoggedAt = 0;
  const { done, failed, unverified, skipped } = await runWithConcurrency(jobs, CONCURRENCY_LIMIT, (job) => runJob(apiKey, job, logger, rcloneBin), {
    onTick: ({ done: doneCount, failedCount, total }) => {
      const t = now();
      if (t - lastProgressLoggedAt < PROGRESS_LOG_INTERVAL_MS) return;
      lastProgressLoggedAt = t;
      const processed = doneCount + failedCount;
      logger.info(`progress: ${processed}/${total} processed`, { done: doneCount, failed: failedCount, remaining: total - processed });
    },
  });

  const providerGaps = failed.filter(({ status }) => PROVIDER_GAP_STATUSES.has(status));
  const failures = failed.filter(({ status }) => !PROVIDER_GAP_STATUSES.has(status));
  const summary = {
    done,
    failedCount: failures.length,
    providerGapCount: providerGaps.length,
    unverifiedCount: unverified.length,
    skipped,
    failed: failures.slice(0, 30).map(({ job, reason }) => `${describeJob(job)}: ${reason}`),
    providerGaps: providerGaps.slice(0, 30).map(({ job, reason }) => `${describeJob(job)}: ${reason}`),
    unverified: unverified.slice(0, 30).map(describeJob),
  };
  if (failures.length > 0) {
    logger.warn("backfill complete with failures; re-run to resume", summary);
  } else {
    logger.ok("backfill complete; every pulled day matched the provider size", summary);
  }

  await flushAndExit(logger, exit, failures.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main({ dryRun: process.argv.includes("--dry-run"), verify: process.argv.includes("--verify-existing") });
}

module.exports = {
  main, buildJobs, latestCoverageFor, safeCutoffDate, destPathFor, runWithConcurrency, runJob, TARGETS, ANCHOR_DATE,
  resolveConcurrencyLimit, DEFAULT_CONCURRENCY_LIMIT, CONCURRENCY_LIMIT, PROGRESS_LOG_INTERVAL_MS,
  resolveJobSettings, DEFAULT_STALL_MS, DEFAULT_UPLOAD_MAX_MS, DEFAULT_JOB_ATTEMPTS,
  expectedDays, orderJobs, providerSize, stallGuard, verifyExisting,
};
