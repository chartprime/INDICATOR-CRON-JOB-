#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { RUNTIME_ROOT } = require("./databento-hist-api");

const DATA_ROOT = path.join(RUNTIME_ROOT, "data", "historical", "databento");
const S3_TARGET = "s3:chartprime-historical-data/raw/databento";

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

function listRealFiles(rcloneBin) {
  const raw = execFileSync(rcloneBin, ["lsjson", "--recursive", S3_TARGET], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(raw).filter((entry) => !entry.IsDir);
}

function parsePartitions(relativePath) {
  const segments = relativePath.split("/");
  const fileName = segments.pop();
  const partitions = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    partitions[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  return { ...partitions, fileName };
}

function buildTree(files) {
  const tree = {};
  for (const file of files) {
    const p = parsePartitions(file.Path.replace(/\\/g, "/"));
    const dataset = p.dataset || "(unknown dataset)";
    const schema = p.schema || "(unknown schema)";
    const symbol = p.symbol || "(unknown symbol)";
    tree[dataset] ??= {};
    tree[dataset][schema] ??= {};
    tree[dataset][schema][symbol] ??= { fileCount: 0, totalBytes: 0, months: new Set() };
    const bucket = tree[dataset][schema][symbol];
    bucket.fileCount += 1;
    bucket.totalBytes += file.Size;
    if (p.year && p.month) bucket.months.add(`${p.year}-${p.month}${p.day ? `-${p.day}` : ""}`);
  }
  return tree;
}

function humanBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

function printTree(tree, logger) {
  let grandTotalFiles = 0;
  let grandTotalBytes = 0;
  for (const [dataset, schemas] of Object.entries(tree).sort()) {
    console.log(`\ndataset=${dataset}`);
    for (const [schema, symbols] of Object.entries(schemas).sort()) {
      console.log(`  schema=${schema}`);
      for (const [symbol, bucket] of Object.entries(symbols).sort()) {
        const periods = [...bucket.months].sort();
        const span = periods.length > 0 ? `${periods[0]} .. ${periods[periods.length - 1]}` : "(no dated partitions)";
        console.log(`    symbol=${symbol}  ${String(bucket.fileCount).padStart(4)} files  ${humanBytes(bucket.totalBytes).padStart(10)}  ${span}`);
        grandTotalFiles += bucket.fileCount;
        grandTotalBytes += bucket.totalBytes;
      }
    }
  }
  logger.info("inventory totals", { totalFiles: grandTotalFiles, totalSize: humanBytes(grandTotalBytes) });
}

function toJsonableTree(tree) {
  const out = {};
  for (const [dataset, schemas] of Object.entries(tree)) {
    out[dataset] = {};
    for (const [schema, symbols] of Object.entries(schemas)) {
      out[dataset][schema] = {};
      for (const [symbol, bucket] of Object.entries(symbols)) {
        out[dataset][schema][symbol] = {
          fileCount: bucket.fileCount,
          totalBytes: bucket.totalBytes,
          periodsCovered: [...bucket.months].sort(),
        };
      }
    }
  }
  return out;
}

function main({
  logger = createCliLogger({ name: "verify-databento-s3-inventory" }),
  exit = process.exit,
} = {}) {
  let rcloneBin;
  try {
    rcloneBin = findRclone();
  } catch (error) {
    logger.error("rclone not found", { reason: error.message });
    return flushAndExit(logger, exit, 1);
  }

  logger.banner(["DATABENTO S3 INVENTORY", "read-only -- lsjson only, no copy/sync/delete", `target: ${S3_TARGET}`]);

  let files;
  try {
    files = listRealFiles(rcloneBin);
  } catch (error) {
    logger.error("rclone lsjson failed", { reason: error.message });
    return flushAndExit(logger, exit, 1);
  }

  const tree = buildTree(files);
  printTree(tree, logger);

  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const reportPath = path.join(DATA_ROOT, "s3-inventory.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), target: S3_TARGET, totalFiles: files.length, tree: toJsonableTree(tree) }, null, 2) + "\n",
    "utf-8",
  );
  logger.ok("inventory complete", { reportPath });

  return flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = { main, findRclone, listRealFiles, parsePartitions, buildTree };
