#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { coverageFiles } = require("./coverage-files");
const { streamToRclone } = require("../../../src/platform/rclone-stream");
const path = require("node:path");
const fs = require("node:fs");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { loadDatabentoKey, requestJson, requestStream } = require("../../verify/databento/databento-hist-api");

const BUCKET = "s3:chartprime-historical-data";
const S3_ROOT = `${BUCKET}/raw/databento`;
const PUBLISH_LAG_DAYS_BY_DATASET = { "GLBX.MDP3": 2, "XNAS.ITCH": 3 };
const ANCHOR_DATE = new Date(Date.UTC(2025, 8, 6));
const ENTITLEMENT_BOUNDARIES_PATH = path.join(__dirname, "..", "..", "..", "..", "..", "docs", "contracts", "databento", "v1", "databento-entitlement-boundaries.json");

function loadEntitlementBoundaries(boundariesPath = ENTITLEMENT_BOUNDARIES_PATH) {
  try {
    return JSON.parse(fs.readFileSync(boundariesPath, "utf-8"));
  } catch (error) {
    throw new Error(`entitlement boundaries file unreadable at ${boundariesPath}: ${error.message}`);
  }
}

function freeStartDateFor(boundaries, dataset, symbolName, schema) {
  const entry = boundaries.results.find((r) => r.dataset === dataset && r.name === symbolName && r.schema === schema);
  if (!entry || entry.boundaries.length === 0) return null;
  const nearest = entry.boundaries[0];
  if (nearest.fromState !== "free") {
    throw new Error(`ENTITLEMENT_BOUNDARY_UNEXPECTED_SHAPE:${dataset}/${symbolName}/${schema} nearest-to-today state is "${nearest.fromState}", not "free"`);
  }
  return new Date(`${nearest.lastDateInFromState}T00:00:00Z`);
}

function effectiveAnchorFor(boundaries, symbol, schema) {
  const freeStart = freeStartDateFor(boundaries, symbol.dataset, symbol.name, schema);
  if (!freeStart || freeStart <= ANCHOR_DATE) return new Date(ANCHOR_DATE);
  return freeStart;
}

const SYMBOLS = [
  { name: "ES", dataset: "GLBX.MDP3", symbols: "ES.n.0", stypeIn: "continuous", namePrefix: "glbx-mdp3" },
  { name: "NQ", dataset: "GLBX.MDP3", symbols: "NQ.n.0", stypeIn: "continuous", namePrefix: "glbx-mdp3" },
  { name: "AAPL", dataset: "XNAS.ITCH", symbols: "AAPL", stypeIn: "raw_symbol", namePrefix: "xnas-itch" },
  { name: "TSLA", dataset: "XNAS.ITCH", symbols: "TSLA", stypeIn: "raw_symbol", namePrefix: "xnas-itch" },
];

const SCHEMA_CONFIG = [
  { schema: "mbp-1", cadence: "monthly", encoding: "dbn" },
  { schema: "mbp-10", cadence: "daily", encoding: "dbn" },
  { schema: "ohlcv-1s", cadence: "monthly", encoding: "csv" },
  { schema: "statistics", cadence: "monthly", encoding: "csv" },
  { schema: "status", cadence: "monthly", encoding: "csv" },
];

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function compactDate(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function safeCutoffDate(dataset) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return addDays(now, -PUBLISH_LAG_DAYS_BY_DATASET[dataset]);
}

function fileExt(encoding) {
  return encoding === "dbn" ? "dbn.zst" : "csv";
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

function parseCoverageEndDate(fileName) {
  const matches = fileName.match(/\d{8}/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const year = Number(last.slice(0, 4));
  const month = Number(last.slice(4, 6));
  const day = Number(last.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day));
}

function latestCoverageFor(rcloneBin, dataset, schema, symbolName) {
  const target = `${S3_ROOT}/dataset=${dataset}/schema=${schema}/symbol=${symbolName}/`;
  const fileNames = [...coverageFiles(rcloneBin, target)].map((line) => line.split("/").pop());
  let latest = null;
  for (const fileName of fileNames) {
    const covered = parseCoverageEndDate(fileName);
    if (covered && (!latest || covered > latest)) latest = covered;
  }
  return latest;
}

function buildDailyJobsFor(rcloneBin, schema, encoding, boundaries = loadEntitlementBoundaries()) {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    const cutoff = safeCutoffDate(symbol.dataset);
    const prefix = `raw/databento/dataset=${symbol.dataset}/schema=${schema}/symbol=${symbol.name}/`;
    const existing = coverageFiles(rcloneBin, `${BUCKET}/${prefix}`);
    let cursor = effectiveAnchorFor(boundaries, symbol, schema);
    while (cursor <= cutoff) {
      const next = addDays(cursor, 1);
      const fileName = `${symbol.namePrefix}-${compactDate(cursor)}.${schema}.${fileExt(encoding)}`;
      const relative = `year=${cursor.getUTCFullYear()}/month=${pad(cursor.getUTCMonth() + 1)}/day=${pad(cursor.getUTCDate())}/${fileName}`;
      if (existing.has(relative)) { cursor = next; continue; }
      jobs.push({
        symbol,
        schema,
        encoding,
        start: isoDate(cursor),
        end: isoDate(next),
        destPath: prefix + relative,
      });
      cursor = next;
    }
  }
  return jobs;
}

function buildMonthlyJobsFor(rcloneBin, schema, encoding, boundaries = loadEntitlementBoundaries()) {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    const cutoff = safeCutoffDate(symbol.dataset);
    const prefix = `raw/databento/dataset=${symbol.dataset}/schema=${schema}/symbol=${symbol.name}/`;
    const existing = coverageFiles(rcloneBin, `${BUCKET}/${prefix}`);
    let cursor = effectiveAnchorFor(boundaries, symbol, schema);
    for (;;) {
      const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      if (monthEnd > addDays(cutoff, 1)) break;
      const lastCoveredDate = addDays(monthEnd, -1);
      const fileName = `${symbol.namePrefix}-${compactDate(cursor)}-${compactDate(lastCoveredDate)}.${schema}.${fileExt(encoding)}`;
      const relative = `year=${cursor.getUTCFullYear()}/month=${pad(cursor.getUTCMonth() + 1)}/${fileName}`;
      if (existing.has(relative)) { cursor = monthEnd; continue; }
      jobs.push({
        symbol,
        schema,
        encoding,
        start: isoDate(cursor),
        end: isoDate(monthEnd),
        destPath: prefix + relative,
      });
      cursor = monthEnd;
    }
  }
  return jobs;
}

function definitionDestPath(symbol, start, end) {
  return `raw/databento/dataset=${symbol.dataset}/schema=definition/symbol=${symbol.name}/year=${end.getUTCFullYear()}/month=${pad(end.getUTCMonth() + 1)}/day=${pad(end.getUTCDate())}/${symbol.namePrefix}-${compactDate(start)}.definition.csv`;
}

function buildDefinitionJobs(rcloneBin) {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    const cutoff = safeCutoffDate(symbol.dataset);
    const prefix = `raw/databento/dataset=${symbol.dataset}/schema=definition/symbol=${symbol.name}/`;
    const existing = coverageFiles(rcloneBin, `${BUCKET}/${prefix}`);
    let cursor = new Date(ANCHOR_DATE);
    while (cursor <= cutoff) {
      const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      const end = monthEnd > cutoff ? cutoff : addDays(monthEnd, -1);
      const start = addDays(end, -1);
      const destPath = definitionDestPath(symbol, start, end);
      if (existing.has(destPath.slice(prefix.length))) { cursor = monthEnd; continue; }
      jobs.push({ symbol, schema: "definition", encoding: "csv", start: isoDate(start), end: isoDate(end), destPath });
      cursor = monthEnd;
    }
  }
  return jobs;
}

function costParams(job) {
  return {
    dataset: job.symbol.dataset,
    schema: job.schema,
    symbols: job.symbol.symbols,
    stype_in: job.symbol.stypeIn,
    start: job.start,
    end: job.end,
  };
}

async function quoteJob(key, job) {
  const { status, body } = await requestJson(key, "metadata.get_cost", costParams(job));
  const cost = status === 200 && typeof body === "number" ? body : null;
  return { ok: status === 200 && cost === 0, status, cost };
}

function streamToS3(readable, destPath, rcloneBin) {
  return streamToRclone(readable, `${BUCKET}/${destPath}`, { rcloneBin });
}

async function runJob(key, job, logger, rcloneBin) {
  const params = costParams(job);
  if (job.encoding !== "dbn") params.encoding = "csv";
  const res = await requestStream(key, "timeseries.get_range", params);
  if (res.statusCode !== 200) {
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    throw new Error(`timeseries.get_range HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf-8").slice(0, 300)}`);
  }
  await streamToS3(res, job.destPath, rcloneBin);
  logger.info(`${job.symbol.name.padEnd(6)} ${job.schema.padEnd(12)} ${job.start} -> ${job.end}  streamed`, { dest: job.destPath });
}

function buildJobs(rcloneBin) {
  const jobs = [];
  for (const { schema, cadence, encoding } of SCHEMA_CONFIG) {
    if (cadence === "daily") jobs.push(...buildDailyJobsFor(rcloneBin, schema, encoding));
    else jobs.push(...buildMonthlyJobsFor(rcloneBin, schema, encoding));
  }
  jobs.push(...buildDefinitionJobs(rcloneBin));
  return jobs;
}

async function main({
  logger = createCliLogger({ name: "ingest-databento-backfill" }),
  exit = process.exit,
  onlyQuote = false,
} = {}) {
  let key;
  try {
    key = loadDatabentoKey();
  } catch (error) {
    logger.error("could not load databento_key", { reason: error.message });
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
    "DATABENTO BACKFILL",
    "compares expected daily/monthly objects against S3 inventory, including interior gaps",
    "daily schemas (mbp-1/mbp-10/ohlcv-1s) never reopen a written file;",
    "monthly schemas (statistics/status) only get a file once that month is fully complete",
    "cost-guarded: aborts whole run if any quote is not $0",
  ]);

  let jobs;
  try {
    jobs = buildJobs(rcloneBin);
  } catch (error) {
    logger.error("inventory failed; uploads not started", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }
  if (jobs.length === 0) {
    logger.ok("no missing expected objects through the safe cutoff; object content requires separate verification");
    await flushAndExit(logger, exit, 0);
    return;
  }
  logger.info(`${jobs.length} real gap(s) found`);

  const quotes = [];
  for (const job of jobs) {
    const quote = await quoteJob(key, job);
    quotes.push({ job, quote });
    console.log(`  ${job.symbol.name.padEnd(6)} ${job.schema.padEnd(12)} ${job.start}..${job.end}  cost=${quote.cost ?? `HTTP ${quote.status}`}`);
  }
  const notFree = quotes.filter(({ quote }) => !quote.ok);
  if (notFree.length > 0) {
    logger.error("ABORT: one or more jobs did not quote at exactly $0", {
      notFree: notFree.map(({ job, quote }) => `${job.symbol.name}/${job.schema}/${job.start}: ${JSON.stringify(quote)}`),
    });
    await flushAndExit(logger, exit, 2);
    return;
  }
  logger.ok(`all ${jobs.length} jobs quoted at $0 -- proceeding`);

  if (onlyQuote) {
    await flushAndExit(logger, exit, 0);
    return;
  }

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await runJob(key, job, logger, rcloneBin);
      done += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`${job.symbol.name}/${job.schema}/${job.start} failed`, { reason: error.message });
      if (error.code === "RCLONE_CHILD_EXIT_UNCONFIRMED") break;
    }
  }

  if (failed > 0) {
    logger.warn("backfill complete with failures", { done, failed, skipped: jobs.length - done - failed, total: jobs.length });
  } else {
    logger.ok("all planned missing objects uploaded; run content verification separately", { done, total: jobs.length });
  }

  await flushAndExit(logger, exit, failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main({ onlyQuote: process.argv.includes("--quote-only") });
}

module.exports = {
  main, buildJobs, buildDefinitionJobs, buildDailyJobsFor, buildMonthlyJobsFor,
  latestCoverageFor, parseCoverageEndDate, ANCHOR_DATE, SCHEMA_CONFIG, SYMBOLS,
  quoteJob, runJob, findRclone, loadEntitlementBoundaries, freeStartDateFor, effectiveAnchorFor,
};
