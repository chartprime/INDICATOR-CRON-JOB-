#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const readline = require("node:readline");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");

const RUNTIME_ROOT = path.join(__dirname, "..", "..", "..");
const SAMPLES_DIR = path.join(RUNTIME_ROOT, "data", "historical", "tardis", "samples");
const REVIEW_WINDOW_MICROS = 2 * 60 * 1_000_000;

function listSymbolDirs() {
  return fs
    .readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function listGzFiles(symbolDir) {
  return fs
    .readdirSync(symbolDir)
    .filter((name) => name.endsWith(".csv.gz"))
    .map((name) => path.join(symbolDir, name));
}

async function buildReviewSample(gzPath, outPath) {
  const input = fs.createReadStream(gzPath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let header = null;
  let timestampIdx = -1;
  let firstTimestamp = null;
  let rowCount = 0;
  let totalRowCount = 0;
  const outLines = [];

  for await (const line of rl) {
    if (header === null) {
      header = line;
      timestampIdx = header.split(",").indexOf("timestamp");
      outLines.push(line);
      continue;
    }
    totalRowCount += 1;
    if (timestampIdx < 0) continue;
    const ts = Number(line.split(",")[timestampIdx]);
    if (firstTimestamp === null) firstTimestamp = ts;
    if (ts - firstTimestamp <= REVIEW_WINDOW_MICROS) {
      outLines.push(line);
      rowCount += 1;
    }
  }
  rl.close();
  input.destroy();

  fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf-8");
  return { rowCount, totalRowCount, header };
}

async function main({
  logger = createCliLogger({ name: "build-tardis-review-samples" }),
  exit = process.exit,
} = {}) {
  logger.banner(["TARDIS REVIEW-SAMPLE BUILDER", `window: first ${REVIEW_WINDOW_MICROS / 1_000_000}s of each already-downloaded file`, "no new API calls -- reads local .csv.gz files only"]);

  const results = [];
  for (const symbolName of listSymbolDirs()) {
    const symbolDir = path.join(SAMPLES_DIR, symbolName);
    const reviewDir = path.join(symbolDir, "review-samples");
    fs.mkdirSync(reviewDir, { recursive: true });
    for (const gzPath of listGzFiles(symbolDir)) {
      const baseName = path.basename(gzPath, ".gz");
      const outPath = path.join(reviewDir, baseName);
      const { rowCount, totalRowCount, header } = await buildReviewSample(gzPath, outPath);
      console.log(`  ${symbolName.padEnd(9)} ${baseName.padEnd(55)} review=${rowCount} of ${totalRowCount} total`);
      results.push({ symbol: symbolName, file: baseName, reviewRows: rowCount, totalRows: totalRowCount, header, outPath });
    }
  }

  const summaryPath = path.join(SAMPLES_DIR, "review-samples-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), windowSeconds: REVIEW_WINDOW_MICROS / 1_000_000, results }, null, 2) + "\n", "utf-8");
  logger.ok("review samples built from real, already-downloaded data", { count: results.length, summaryPath });

  await flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = { main, buildReviewSample, REVIEW_WINDOW_MICROS };
