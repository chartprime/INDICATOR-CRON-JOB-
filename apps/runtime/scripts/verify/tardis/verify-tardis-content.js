#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const readline = require("node:readline");
const { init, downloadDatasets } = require("tardis-dev");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");

const RUNTIME_ROOT = path.join(__dirname, "..", "..", "..");
const OUTPUT_DIR = path.join(RUNTIME_ROOT, "data", "historical", "tardis", "samples");

const WINDOW = { from: "2026-09-01", to: "2026-09-02" };

const PERP_DATA_TYPES = ["trades", "incremental_book_L2", "quotes", "derivative_ticker", "book_snapshot_5", "book_snapshot_25", "liquidations", "book_ticker"];
const SPOT_DATA_TYPES = ["trades", "incremental_book_L2", "quotes", "book_snapshot_5", "book_snapshot_25", "book_ticker"];

const SYMBOLS = [
  { name: "BTC-spot", exchange: "binance", symbol: "btcusdt", dataTypes: SPOT_DATA_TYPES },
  { name: "ETH-spot", exchange: "binance", symbol: "ethusdt", dataTypes: SPOT_DATA_TYPES },
  { name: "BTC-perp", exchange: "binance-futures", symbol: "btcusdt", dataTypes: PERP_DATA_TYPES },
  { name: "ETH-perp", exchange: "binance-futures", symbol: "ethusdt", dataTypes: PERP_DATA_TYPES },
];

function buildJobs() {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    for (const dataType of symbol.dataTypes) {
      jobs.push({ name: symbol.name, exchange: symbol.exchange, symbol: symbol.symbol, dataType });
    }
  }
  return jobs;
}

const JOBS = buildJobs();

async function countGzippedCsvRows(filePath) {
  const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let rows = 0;
  for await (const line of rl) {
    if (header === null) {
      header = line;
      continue;
    }
    rows += 1;
  }
  rl.close();
  input.destroy();
  return { rows, header: header || "(empty)" };
}

async function runJob(job, logger) {
  const symbolDir = path.join(OUTPUT_DIR, job.name);
  fs.mkdirSync(symbolDir, { recursive: true });
  try {
    await downloadDatasets({
      exchange: job.exchange,
      dataTypes: [job.dataType],
      symbols: [job.symbol],
      from: WINDOW.from,
      to: WINDOW.to,
      downloadDir: symbolDir,
    });
    const fileName = `${job.exchange}_${job.dataType}_${WINDOW.from}_${job.symbol.toUpperCase()}.csv.gz`;
    const filePath = path.join(symbolDir, fileName);
    if (!fs.existsSync(filePath)) {
      logger.warn(`${job.name} ${job.dataType}: download reported success but file missing`, { filePath });
      return { ...job, ok: false, reason: "file missing after download" };
    }
    const { rows, header } = await countGzippedCsvRows(filePath);
    console.log(`  ${job.name.padEnd(9)} ${job.dataType.padEnd(20)} rows=${rows}`);
    return { ...job, ok: true, rows, header, filePath };
  } catch (error) {
    console.log(`  ${job.name.padEnd(9)} ${job.dataType.padEnd(20)} FAILED: ${error.message.slice(0, 120)}`);
    return { ...job, ok: false, reason: error.message };
  }
}

async function main({
  logger = createCliLogger({ name: "verify-tardis-content" }),
  exit = process.exit,
} = {}) {
  const apiKey = process.env.tardis_key;
  if (!apiKey) {
    logger.error("tardis_key not set in environment");
    await flushAndExit(logger, exit, 1);
    return;
  }
  init({ apiKey });

  logger.banner([
    "TARDIS SAMPLE DATASET",
    `${SYMBOLS.length} symbols x their applicable data types = ${JOBS.length} jobs`,
    `window: ${WINDOW.from} -> ${WINDOW.to}`,
  ]);

  const results = [];
  for (const job of JOBS) {
    results.push(await runJob(job, logger));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    window: WINDOW,
    jobs: results.map((entry) => ({ name: entry.name, exchange: entry.exchange, symbol: entry.symbol, dataType: entry.dataType, ok: entry.ok, rows: entry.rows, header: entry.header, reason: entry.reason })),
  };
  const summaryPath = path.join(OUTPUT_DIR, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    logger.warn("sample dataset complete, some jobs failed", { failed: failed.map((entry) => `${entry.name}/${entry.dataType}`) });
  } else {
    logger.ok("sample dataset complete, every job returned real data", { summaryPath, outputDir: OUTPUT_DIR });
  }

  await flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = { main, SYMBOLS, JOBS, WINDOW };
