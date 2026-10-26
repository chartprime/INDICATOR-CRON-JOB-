#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { loadDatabentoKey, requestJson, requestRaw, RUNTIME_ROOT } = require("./databento-hist-api");

const OUTPUT_DIR = path.join(RUNTIME_ROOT, "data", "historical", "databento", "samples");

const SYMBOLS = [
  { name: "ES", dataset: "GLBX.MDP3", symbols: "ES.n.0", stypeIn: "continuous" },
  { name: "NQ", dataset: "GLBX.MDP3", symbols: "NQ.n.0", stypeIn: "continuous" },
  { name: "AAPL", dataset: "XNAS.ITCH", symbols: "AAPL", stypeIn: "raw_symbol" },
  { name: "TSLA", dataset: "XNAS.ITCH", symbols: "TSLA", stypeIn: "raw_symbol" },
];

const LIQUID_SCHEMAS = ["ohlcv-1s", "mbp-1", "mbp-10", "trades"];
const FULL_DAY_SCHEMAS = ["definition", "statistics", "status"];
const SCHEMAS = [...LIQUID_SCHEMAS, ...FULL_DAY_SCHEMAS];

function liquidWindow() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  end.setUTCHours(15, 2, 0, 0);
  const start = new Date(end);
  start.setUTCMinutes(start.getUTCMinutes() - 2);
  return { start: start.toISOString(), end: end.toISOString() };
}

function fullDayWindow() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function windowFor(schema) {
  return LIQUID_SCHEMAS.includes(schema) ? liquidWindow() : fullDayWindow();
}

function buildJobs() {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    for (const schema of SCHEMAS) {
      jobs.push({ ...symbol, schema, window: windowFor(schema) });
    }
  }
  return jobs;
}

const JOBS = buildJobs();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quoteJob(key, job) {
  const params = {
    dataset: job.dataset,
    schema: job.schema,
    symbols: job.symbols,
    stype_in: job.stypeIn,
    start: job.window.start,
    end: job.window.end,
  };
  const { status, body } = await requestJson(key, "metadata.get_cost", params);
  const cost = status === 200 && typeof body === "number" ? body : null;
  return { ok: status === 200 && cost === 0, status, cost };
}

function summarizeMbp1Actions(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return { rows: 0, actions: {} };
  const header = lines[0].split(",");
  const actionIdx = header.indexOf("action");
  const actions = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const action = actionIdx >= 0 ? cells[actionIdx] : undefined;
    if (action === undefined) continue;
    actions[action] = (actions[action] || 0) + 1;
  }
  return { rows: lines.length - 1, actions, header };
}

async function main({
  logger = createCliLogger({ name: "verify-databento-content" }),
  exit = process.exit,
} = {}) {
  let key;
  try {
    key = loadDatabentoKey();
  } catch (error) {
    logger.error("could not load databento_key", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }

  logger.banner([
    "DATABENTO SAMPLE DATASET",
    `${SYMBOLS.length} symbols x ${SCHEMAS.length} schemas = ${JOBS.length} jobs`,
    "cost-guarded: aborts whole run if any quote is not $0",
  ]);

  logger.info("quoting all jobs before requesting any real data...");
  const quotes = [];
  for (const job of JOBS) {
    const quote = await quoteJob(key, job);
    quotes.push({ job, quote });
    console.log(`  ${job.name.padEnd(6)} ${job.schema.padEnd(12)} cost=${quote.cost ?? `HTTP ${quote.status}`}`);
    await sleep(100);
  }
  const notFree = quotes.filter(({ quote }) => !quote.ok);
  if (notFree.length > 0) {
    logger.error("ABORT: one or more windows did not quote at exactly $0 -- refusing to request any data", {
      notFree: notFree.map(({ job, quote }) => `${job.name}/${job.schema}: ${JSON.stringify(quote)}`),
    });
    await flushAndExit(logger, exit, 2);
    return;
  }
  logger.ok("all jobs quoted at $0 -- proceeding");

  const summary = { generatedAt: new Date().toISOString(), jobs: [] };

  for (const job of JOBS) {
    const symbolDir = path.join(OUTPUT_DIR, job.name);
    fs.mkdirSync(symbolDir, { recursive: true });
    const params = {
      dataset: job.dataset,
      schema: job.schema,
      symbols: job.symbols,
      stype_in: job.stypeIn,
      start: job.window.start,
      end: job.window.end,
      encoding: "csv",
    };
    logger.info(`timeseries.get_range -- ${job.name} ${job.schema}`);
    const { status, text } = await requestRaw(key, "timeseries.get_range", params);
    if (status !== 200) {
      logger.warn("get_range failed", { job: `${job.name}/${job.schema}`, status, bodyPreview: (text || "").slice(0, 300) });
      summary.jobs.push({ name: job.name, schema: job.schema, window: job.window, status, ok: false });
      await sleep(150);
      continue;
    }
    const outPath = path.join(symbolDir, `${job.schema}.csv`);
    fs.writeFileSync(outPath, text, "utf-8");
    const lines = text.trim().split("\n");
    const rows = text.trim().length === 0 ? 0 : lines.length - 1;
    console.log(`\n  --- ${job.name} ${job.schema} (${rows} rows, saved to ${outPath}) ---`);
    console.log(`  header: ${lines[0] || "(empty)"}`);
    for (const line of lines.slice(1, 4)) console.log(`  ${line}`);

    const entry = { name: job.name, schema: job.schema, window: job.window, status, rows, outPath, ok: true };
    if (job.schema === "mbp-1") {
      const actionSummary = summarizeMbp1Actions(text);
      entry.actionCounts = actionSummary.actions;
      console.log(`  action-value counts: ${JSON.stringify(actionSummary.actions)}`);
    }
    summary.jobs.push(entry);
    await sleep(150);
  }

  const summaryPath = path.join(OUTPUT_DIR, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  const emptyJobs = summary.jobs.filter((entry) => entry.ok && entry.rows === 0);
  if (emptyJobs.length > 0) {
    logger.warn("sample dataset complete, but some jobs came back with zero rows", {
      empty: emptyJobs.map((entry) => `${entry.name}/${entry.schema}`),
    });
  } else {
    logger.ok("sample dataset complete, every job returned at least one row", { summaryPath, outputDir: OUTPUT_DIR });
  }

  await flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = { main, liquidWindow, fullDayWindow, windowFor, summarizeMbp1Actions, SYMBOLS, SCHEMAS, JOBS };
