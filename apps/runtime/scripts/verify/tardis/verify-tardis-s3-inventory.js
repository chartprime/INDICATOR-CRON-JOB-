#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");

const RUNTIME_ROOT = path.join(__dirname, "..", "..", "..");
const DATA_ROOT = path.join(RUNTIME_ROOT, "data", "historical", "tardis");
const S3_TARGET = "s3:chartprime-historical-data/raw/tardis";

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
    maxBuffer: 512 * 1024 * 1024,
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
    const exchange = p.exchange || "(unknown exchange)";
    const dataType = p.data_type || "(unknown data_type)";
    const symbol = p.symbol || "(unknown symbol)";
    tree[exchange] ??= {};
    tree[exchange][dataType] ??= {};
    tree[exchange][dataType][symbol] ??= { fileCount: 0, totalBytes: 0, days: new Set() };
    const bucket = tree[exchange][dataType][symbol];
    bucket.fileCount += 1;
    bucket.totalBytes += file.Size;
    if (p.year && p.month && p.day) bucket.days.add(`${p.year}-${p.month}-${p.day}`);
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
  for (const [exchange, dataTypes] of Object.entries(tree).sort()) {
    console.log(`\nexchange=${exchange}`);
    for (const [dataType, symbols] of Object.entries(dataTypes).sort()) {
      console.log(`  data_type=${dataType}`);
      for (const [symbol, bucket] of Object.entries(symbols).sort()) {
        const days = [...bucket.days].sort();
        const span = days.length > 0 ? `${days[0]} .. ${days[days.length - 1]} (${days.length} days)` : "(no dated partitions)";
        console.log(`    symbol=${symbol}  ${String(bucket.fileCount).padStart(5)} files  ${humanBytes(bucket.totalBytes).padStart(10)}  ${span}`);
        grandTotalFiles += bucket.fileCount;
        grandTotalBytes += bucket.totalBytes;
      }
    }
  }
  logger.info("inventory totals", { totalFiles: grandTotalFiles, totalSize: humanBytes(grandTotalBytes) });
}

function toJsonableTree(tree) {
  const out = {};
  for (const [exchange, dataTypes] of Object.entries(tree)) {
    out[exchange] = {};
    for (const [dataType, symbols] of Object.entries(dataTypes)) {
      out[exchange][dataType] = {};
      for (const [symbol, bucket] of Object.entries(symbols)) {
        out[exchange][dataType][symbol] = {
          fileCount: bucket.fileCount,
          totalBytes: bucket.totalBytes,
          daysCovered: [...bucket.days].sort(),
        };
      }
    }
  }
  return out;
}

function main({
  logger = createCliLogger({ name: "verify-tardis-s3-inventory" }),
  exit = process.exit,
} = {}) {
  let rcloneBin;
  try {
    rcloneBin = findRclone();
  } catch (error) {
    logger.error("rclone not found", { reason: error.message });
    return flushAndExit(logger, exit, 1);
  }

  logger.banner(["TARDIS S3 INVENTORY", "read-only -- lsjson only, no copy/sync/delete", `target: ${S3_TARGET}`]);

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
