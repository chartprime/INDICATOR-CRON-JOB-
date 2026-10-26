#!/usr/bin/env node
"use strict";

// One command for the whole local gate: the pinned Node, then the docs check,
// lint, type check, build, both test suites and the stale-mutant check, run
// side by side. Prints a Markdown report and keeps every step's full log.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const RUNTIME = path.join(ROOT, "apps", "runtime");
const CONVERSION = path.join(RUNTIME, "conversion");
const DEFAULT_BASE = "origin/development-indicator-sdk";

function moduleFile(...candidates) {
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}

function hasUv() {
  const probe = childProcess.spawnSync("uv", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

const LOAD_BENCH = "test/scripts/bench/ws-fanout-load.test.js";

function steps({ base, uv = hasUv() }) {
  const node = (cwd, file, ...args) => ({ cwd, command: [process.execPath, file, ...args] });
  return [
    { name: "docs", ...node(ROOT, path.join(ROOT, "scripts", "validate-docs.cjs")) },
    { name: "eslint", ...node(ROOT, path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js"), ".") },
    { name: "oxlint", ...node(WEB, moduleFile(path.join(WEB, "node_modules", "oxlint", "bin", "oxlint"), path.join(ROOT, "node_modules", "oxlint", "bin", "oxlint"))) },
    { name: "typecheck", ...node(WEB, moduleFile(path.join(WEB, "node_modules", "typescript", "bin", "tsc"), path.join(ROOT, "node_modules", "typescript", "bin", "tsc")), "-b") },
    { name: "build", ...node(WEB, path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build") },
    { name: "runtime tests", heavy: true, parse: jestCounts, ...node(RUNTIME, path.join(ROOT, "node_modules", "jest", "bin", "jest.js"), "--testPathIgnorePatterns", LOAD_BENCH) },
    { name: "web tests", heavy: true, parse: vitestCounts, ...node(WEB, path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run") },
    uv
      ? { name: "conversion tests", heavy: true, parse: pytestCounts, cwd: CONVERSION, command: ["uv", "run", "--frozen", "pytest", "-q", "-p", "no:cacheprovider"] }
      : { name: "conversion tests", skip: "uv is not installed (see apps/runtime/conversion)" },
    base === null
      ? { name: "stale mutants", skip: "no base to compare with (pass --base <ref>)" }
      : { name: "stale mutants", ...node(ROOT, path.join(RUNTIME, "scripts", "verify", "mutation-stale.js"), "--base", base) },
    // A real-time load benchmark: it measures whether every healthy client gets every trade at a fixed
    // rate, so it runs once the suites are done rather than beside them on a starved CPU.
    { name: "runtime load bench", alone: true, parse: jestCounts, ...node(RUNTIME, path.join(ROOT, "node_modules", "jest", "bin", "jest.js"), LOAD_BENCH) },
  ];
}

function jestCounts(output) {
  const line = output.split(/\r?\n/).reverse().find((text) => /^Tests:\s/.test(text));
  if (!line) return null;
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { passed: count("passed"), failed: count("failed"), skipped: count("skipped") };
}

function vitestCounts(output) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split(/\r?\n/).reverse().find((text) => /^\s*Tests\s{2}/.test(text));
  if (!line) return null;
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { passed: count("passed"), failed: count("failed"), skipped: count("skipped") };
}

function pytestCounts(output) {
  const line = output.split(/\r?\n/).reverse().find((text) => /\d+ (passed|failed)/.test(text) && / in [\d.]+s/.test(text));
  if (!line) return null;
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { passed: count("passed"), failed: count("failed") + count("error"), skipped: count("skipped") };
}

function runStep(step, logDir, spawn = childProcess.spawn) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logFile = path.join(logDir, `${step.name.replace(/\s+/g, "-")}.log`);
    const log = fs.createWriteStream(logFile);
    const chunks = [];
    const child = spawn(step.command[0], step.command.slice(1), { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => {
      chunks.push(chunk);
      log.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code, error) => {
      log.end();
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({
        name: step.name, ok: code === 0, code, seconds: (Date.now() - started) / 1_000, logFile,
        counts: step.parse ? step.parse(output) : null, error: error?.message ?? null,
      });
    };
    child.on("error", (error) => finish(-1, error));
    child.on("close", (code) => finish(code));
  });
}

/** Light steps start at once; the three test suites share `heavySlots` slots; `alone` steps run last, one at a time. */
async function runGate({ base = DEFAULT_BASE, heavySlots = 3, logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), spawn, uv } = {}) {
  const plan = steps({ base, uv });
  const results = new Array(plan.length);
  const heavy = [];
  const light = [];
  const alone = [];
  plan.forEach((step, index) => {
    if (step.skip) results[index] = { name: step.name, ok: true, skipped: step.skip, seconds: 0 };
    else (step.alone ? alone : step.heavy ? heavy : light).push(index);
  });
  const started = Date.now();
  const lane = async (queue) => {
    while (queue.length > 0) {
      const index = queue.shift();
      results[index] = await runStep(plan[index], logDir, spawn);
    }
  };
  await Promise.all([...light.map((index) => runStep(plan[index], logDir, spawn).then((result) => { results[index] = result; })),
    ...Array.from({ length: Math.max(1, heavySlots) }, () => lane(heavy))]);
  await lane(alone);
  return { results, seconds: (Date.now() - started) / 1_000, logDir };
}

function git(args) {
  const result = childProcess.spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function report({ results, seconds, logDir }, { base }) {
  const commit = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
  const dirty = (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
  const lines = [
    `### Local gate: ${results.every((result) => result.ok) ? "pass" : "FAIL"}`,
    "",
    `Node ${process.versions.node}, ${os.platform()} ${os.cpus().length} cores, commit ${commit}${dirty ? " with uncommitted changes" : ""}${base ? `, stale mutants against ${base}` : ""}; ${seconds.toFixed(0)} s.`,
    "",
    "| Step | Result | Time |",
    "|---|---|---|",
  ];
  for (const result of results) {
    const counts = result.counts ? ` (${result.counts.passed} passed${result.counts.failed ? `, ${result.counts.failed} failed` : ""}${result.counts.skipped ? `, ${result.counts.skipped} skipped` : ""})` : "";
    const outcome = result.skipped ? `skipped: ${result.skipped}` : result.ok ? `pass${counts}` : `**FAIL**${counts}${result.error ? `: ${result.error}` : ""}`;
    lines.push(`| ${result.name} | ${outcome} | ${result.seconds.toFixed(1)} s |`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) lines.push("", ...failed.map((result) => `Log of ${result.name}: ${result.logFile}`));
  lines.push("", `Logs: ${logDir}`);
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, heavySlots: 3, reportFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`gate: ${arg} requires a value`);
      index += 1;
      return argv[index];
    };
    if (arg === "--base") options.base = value();
    else if (arg === "--no-base") options.base = null;
    else if (arg === "--heavy") {
      options.heavySlots = Number(value());
      if (!Number.isSafeInteger(options.heavySlots) || options.heavySlots < 1) throw new Error("gate: --heavy must be a positive integer");
    } else if (arg === "--report") options.reportFile = path.resolve(value());
    else throw new Error(`gate: unknown option ${arg}; usage: gate [--base <ref> | --no-base] [--heavy <n>] [--report <file>]`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const required = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node;
  if (required && process.versions.node !== required) {
    throw new Error(`gate: the repository pins Node ${required}; this is Node ${process.versions.node}. Select it (see .nvmrc) and run again.`);
  }
  if (options.base !== null && git(["rev-parse", "--verify", "--quiet", `${options.base}^{commit}`]) === null) {
    throw new Error(`gate: cannot find ${options.base}; fetch it, pass --base <ref>, or --no-base`);
  }
  const outcome = await runGate({ base: options.base, heavySlots: options.heavySlots });
  const text = report(outcome, options);
  process.stdout.write(text);
  if (options.reportFile) fs.writeFileSync(options.reportFile, text);
  if (!outcome.results.every((result) => result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  });
}

module.exports = { runGate, report, parseArgs, jestCounts, vitestCounts, pytestCounts, steps };
