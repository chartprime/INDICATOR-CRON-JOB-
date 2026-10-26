#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_LEDGER = path.join(REPO_ROOT, "benchmarks", "mutation-ledger.jsonl");
const FAILURE_LINE = /^\s*(?:● .+|FAILED .+|FAIL {2}\S.* > .+|× .+)$/;
const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
const MAX_OBSERVED_FAILURES = 25;
const OUTCOME_KILLED = "KILLED";
const OUTCOME_TIMED_OUT = "TIMED_OUT";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const JOURNAL_DIR_NAME = ".mutation-inflight";
const LEDGER_LOCK_WAIT_MS = 30_000;
const IN_PLACE_COMMANDS = new Set(["uv", "python", "python3", "py", "pytest"]);
const SKIPPED_MODULE_ENTRIES = new Set([".vite", ".vite-temp", ".cache", ".tmp"]);

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function quoteArgument(part) {
  return SAFE_ARGUMENT.test(part) ? part : `"${part.replace(/"/g, '\\"')}"`;
}

/**
 * A spec's `node` is this Node, the pinned one, not whichever is first on PATH.
 * `npx <bin>` costs about half a second a run; the bin it would find is the
 * nearest node_modules/.bin entry, so run that file with this Node instead.
 * Windows keeps npx: its .bin entries are .cmd shims.
 */
function resolveCommand(command, cwd, platform = process.platform) {
  if (command[0] === "node") return [process.execPath, ...command.slice(1)];
  if (platform === "win32" || command[0] !== "npx" || command.length < 2 || command[1].startsWith("-")) return command;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin", command[1]);
    if (fs.existsSync(bin)) return [process.execPath, fs.realpathSync(bin), ...command.slice(2)];
    if (path.dirname(dir) === dir) return command;
  }
}

function killTree(child, direct = false) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = childProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true,
      });
      // Directly spawned commands need no shell tree and remain killable even
      // when a restricted Windows session refuses taskkill's process query.
      if (direct) try { child.kill("SIGKILL"); } catch { void 0; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        resolve();
      };
      // Await taskkill so the caller never restores a mutation while a
      // grandchild still owns the file. Bound taskkill itself independently.
      const deadline = setTimeout(() => {
        try { killer.kill("SIGKILL"); } catch { void 0; }
        finish();
      }, 5_000);
      deadline.unref?.();
      killer.once("error", finish);
      killer.once("close", finish);
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  return Promise.resolve();
}

function defaultRun(command, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requiresWindowsShell = process.platform === "win32" && /^(?:npm|npx)(?:\.cmd)?$/i.test(command[0]);
    const child = requiresWindowsShell
      ? childProcess.spawn(command.map(quoteArgument).join(" "), {
        cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: false,
      })
      : childProcess.spawn(command[0], command.slice(1), {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on("data", (chunk) => chunks.stdout.push(chunk));
    child.stderr.on("data", (chunk) => chunks.stderr.push(chunk));
    let timedOut = false;
    let settled = false;
    let forceSettleTimer = null;
    let killPromise = null;
    let waitingForKill = false;
    const finish = (status) => {
      if (settled) return;
      if (timedOut && killPromise && !waitingForKill) {
        waitingForKill = true;
        killPromise.finally(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          settle(status);
        });
        return;
      }
      settle(status);
    };
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceSettleTimer !== null) clearTimeout(forceSettleTimer);
      resolve({
        exitCode: !timedOut && typeof status === "number" ? status : -1,
        timedOut,
        output: `${Buffer.concat(chunks.stdout).toString("utf8")}\n${Buffer.concat(chunks.stderr).toString("utf8")}`,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killPromise = killTree(child, !requiresWindowsShell);
      // Do not let inherited pipe handles in a stuck grandchild hold the
      // mutation runner forever even if Windows delays process-tree cleanup.
      forceSettleTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 6_000);
      forceSettleTimer.unref?.();
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); if (!settled) reject(error); });
    child.on("close", finish);
  });
}

function defaultGit(repoRoot) {
  const run = (args) => {
    const result = childProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    return result.error === undefined && result.status === 0 ? result.stdout : null;
  };
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "--untracked-files=no"]);
  return commit === null || status === null ? null : { commit: commit.trim(), dirty: status.trim().length > 0 };
}

function validateSpec(spec) {
  const fail = (message) => { throw new Error(`mutation-check: ${message}`); };
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("spec must be an object");
  if (typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(spec.id)) fail("id must be a lowercase slug");
  if (typeof spec.file !== "string" || spec.file.length === 0) fail(`${spec.id}: file is required`);
  if (typeof spec.find !== "string" || spec.find.length === 0) fail(`${spec.id}: find must be a non-empty string`);
  if (typeof spec.replace !== "string" || spec.replace === spec.find) fail(`${spec.id}: replace must be a string different from find`);
  if (spec.find.includes("\r") || spec.replace.includes("\r")) fail(`${spec.id}: find and replace must not contain a carriage return (write line endings as \\n)`);
  if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.some((part) => typeof part !== "string" || part.length === 0)) {
    fail(`${spec.id}: command must be a non-empty array of strings`);
  }
  if (spec.mustFail !== undefined && (!Array.isArray(spec.mustFail) || spec.mustFail.some((part) => typeof part !== "string" || part.length === 0))) {
    fail(`${spec.id}: mustFail must be an array of non-empty strings`);
  }
  if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    fail(`${spec.id}: timeoutMs must be a positive safe integer`);
  }
  return { ...spec, mustFail: spec.mustFail ?? [], cwd: spec.cwd ?? ".", timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

function locate(text, find, replace) {
  const variants = text.includes("\r\n") && !find.includes("\r\n")
    ? [[find, replace], [find.replace(/\n/g, "\r\n"), replace.replace(/\n/g, "\r\n")]]
    : [[find, replace]];
  for (const [candidate, replacement] of variants) {
    const start = text.indexOf(candidate);
    if (start === -1) continue;
    if (text.indexOf(candidate, start + candidate.length) !== -1) throw new Error("mutation-check: find text occurs more than once");
    return { start, matched: candidate, replacement };
  }
  throw new Error("mutation-check: find text not found in the target file");
}

function failureLines(output) {
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (FAILURE_LINE.test(line)) seen.add(line.trim());
    if (seen.size >= MAX_OBSERVED_FAILURES) break;
  }
  return [...seen];
}

/**
 * Run `fn` holding the ledger's lock file, so a run's append never lands in a
 * file another run is rewriting. A lock whose process is gone is taken over.
 */
function withLedgerLock(ledgerPath, fn) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lockPath = `${ledgerPath}.lock`;
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let holder = null;
      try {
        holder = Number(fs.readFileSync(lockPath, "utf8"));
      } catch {
        continue;
      }
      if (!processAlive(holder)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`mutation-check: ${lockPath} is held by process ${holder}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function appendLedger(ledgerPath, entry) {
  withLedgerLock(ledgerPath, () => fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8"));
}

/**
 * Keep one line per mutant, its latest run, sorted by id. A run appends; this
 * folds the appends (and the two sides of a union merge) back in, so the file
 * grows with the mutants, not the runs, and two branches touch the same line
 * only when they ran the same mutant. The older runs stay in git's history.
 */
function compactLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  return withLedgerLock(ledgerPath, () => {
    const latest = new Map();
    const unreadable = [];
    let lines = 0;
    for (const line of fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      lines += 1;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        entry = null;
      }
      if (typeof entry?.id !== "string") {
        unreadable.push(line);
        continue;
      }
      const held = latest.get(entry.id);
      if (held === undefined || String(entry.atUtc ?? "") >= String(held.entry.atUtc ?? "")) latest.set(entry.id, { entry, line });
    }
    const ids = [...latest.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const kept = [...ids.map((id) => latest.get(id).line), ...unreadable];
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
    fs.renameSync(temporary, ledgerPath);
    return { lines, kept: kept.length };
  });
}

function journalPathFor(journalDir, target) {
  return path.join(journalDir, `${sha256Hex(Buffer.from(target, "utf8")).slice(0, 16)}.json`);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Put back any file a killed run left mutated. A journal entry names the
 * target, its original bytes, the mutant's hash and the run's process; the
 * file is restored only once that process is gone and while the file still
 * holds that mutant, so neither a live run nor an edit made since is undone.
 */
function recoverInterrupted(journalDir) {
  const restored = [];
  if (!fs.existsSync(journalDir)) return restored;
  for (const name of fs.readdirSync(journalDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(journalDir, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (entry.pid === process.pid || processAlive(entry.pid)) continue;
    if (fs.existsSync(entry.target) && sha256Hex(fs.readFileSync(entry.target)) === entry.mutantSha256) {
      fs.writeFileSync(entry.target, Buffer.from(entry.originalBase64, "base64"));
      restored.push(entry.target);
    }
    fs.rmSync(file, { force: true });
  }
  return restored;
}

async function runMutation({
  repoRoot = REPO_ROOT, spec: rawSpec, ledgerPath = DEFAULT_LEDGER, run = defaultRun, now = () => new Date(), git = defaultGit,
  baselines = null, journalDir = path.join(repoRoot, JOURNAL_DIR_NAME),
}) {
  const spec = validateSpec(rawSpec);
  const target = path.resolve(repoRoot, spec.file);
  const cwd = path.resolve(repoRoot, spec.cwd);
  if (!fs.existsSync(target)) throw new Error(`mutation-check: target file not found: ${spec.file}`);
  const original = fs.readFileSync(target);
  const originalSha256 = sha256Hex(original);
  const { start, matched, replacement } = locate(original.toString("utf8"), spec.find, spec.replace);
  const entry = {
    id: spec.id,
    atUtc: now().toISOString(),
    git: git(repoRoot),
    file: spec.file.replace(/\\/g, "/"),
    fileSha256: originalSha256,
    find: spec.find,
    replace: spec.replace,
    command: spec.command.join(" "),
    mustFail: spec.mustFail,
  };
  // The tree is the same before every mutant of a run (each is restored
  // byte-exact), so a command's clean result is measured once and reused.
  const command = resolveCommand(spec.command, cwd);
  const baselineKey = `${cwd}\0${spec.timeoutMs}\0${command.join("\0")}`;
  let baseline = baselines?.get(baselineKey);
  if (baseline === undefined) {
    const baselineStarted = Date.now();
    baseline = { ...(await run(command, cwd, spec.timeoutMs)), ms: 0 };
    baseline.ms = Date.now() - baselineStarted;
    baselines?.set(baselineKey, baseline);
  }
  if (baseline.exitCode !== 0) {
    const result = {
      ...entry, baselineExit: baseline.exitCode, baselineMs: baseline.ms, outcome: "BASELINE_FAILED",
      ...(baseline.timedOut ? { baselineTimedOut: true } : {}), observedFailures: failureLines(baseline.output),
    };
    appendLedger(ledgerPath, result);
    return result;
  }
  const source = original.toString("utf8");
  const mutantText = `${source.slice(0, start)}${replacement}${source.slice(start + matched.length)}`;
  const mutantBytes = Buffer.from(mutantText, "utf8");
  const journal = journalPathFor(journalDir, target);
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(journal, JSON.stringify({ target, originalBase64: original.toString("base64"), mutantSha256: sha256Hex(mutantBytes), pid: process.pid }));
  let mutated;
  const mutatedStarted = Date.now();
  try {
    fs.writeFileSync(target, mutantBytes);
    mutated = await run(command, cwd, spec.timeoutMs);
  } finally {
    fs.writeFileSync(target, original);
    fs.rmSync(journal, { force: true });
  }
  if (sha256Hex(fs.readFileSync(target)) !== originalSha256) throw new Error(`mutation-check: ${spec.file} was not restored byte-exact`);
  const observedFailures = failureLines(mutated.output);
  const unmatched = spec.mustFail.filter((fragment) => !observedFailures.some((line) => line.includes(fragment)));
  const outcome = mutated.timedOut ? OUTCOME_TIMED_OUT
    : mutated.exitCode === 0 ? "SURVIVED" : unmatched.length > 0 ? "KILLED_BY_UNEXPECTED_TEST" : OUTCOME_KILLED;
  const result = {
    ...entry,
    mutantSha256: sha256Hex(mutantBytes),
    baselineExit: baseline.exitCode,
    baselineMs: baseline.ms,
    mutatedExit: mutated.exitCode,
    mutatedMs: Date.now() - mutatedStarted,
    observedFailures,
    outputSha256: sha256Hex(mutated.output),
    restoredVerified: true,
    outcome,
  };
  appendLedger(ledgerPath, result);
  return result;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function linkEntry(source, destination, platform) {
  const isDir = fs.statSync(source).isDirectory();
  try {
    fs.symlinkSync(source, destination, isDir ? (platform === "win32" ? "junction" : "dir") : "file");
  } catch (error) {
    if (isDir) throw error;
    fs.copyFileSync(source, destination);
  }
}

/**
 * A node_modules for a worker copy: every package is linked to the shared one,
 * except a workspace link (one that resolves into the repository outside any
 * node_modules), which points into the copy so a mutant is what gets loaded.
 */
function mirrorNodeModules(source, destination, repoRoot, copyRoot, platform) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (SKIPPED_MODULE_ENTRIES.has(name)) continue;
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (name.startsWith("@") && stat.isDirectory()) {
      mirrorNodeModules(from, to, repoRoot, copyRoot, platform);
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(from);
    } catch {
      continue;
    }
    const workspace = stat.isSymbolicLink() && isInside(repoRoot, real) && !path.relative(repoRoot, real).split(path.sep).includes("node_modules");
    linkEntry(workspace ? path.join(copyRoot, path.relative(repoRoot, real)) : real, to, platform);
  }
}

function findNodeModules(repoRoot, depth = 3) {
  const found = [];
  const walk = (dir, level) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") found.push(full);
      else if (level < depth) walk(full, level + 1);
    }
  };
  walk(repoRoot, 1);
  return found;
}

/** A private copy of the working tree, edits not yet committed included, for one worker. */
function prepareWorkerTree(repoRoot, copyRoot, { platform = process.platform } = {}) {
  const listed = childProcess.spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`mutation-check: git ls-files failed in ${repoRoot}`);
  for (const relative of listed.stdout.split("\0")) {
    if (relative === "") continue;
    const from = path.join(repoRoot, relative);
    if (!fs.existsSync(from)) continue;
    const to = path.join(copyRoot, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  for (const modules of findNodeModules(repoRoot)) {
    mirrorNodeModules(modules, path.join(copyRoot, path.relative(repoRoot, modules)), repoRoot, copyRoot, platform);
  }
  return copyRoot;
}

function runsInPlace(spec) {
  return Array.isArray(spec?.command) && IN_PLACE_COMMANDS.has(String(spec.command[0]).split(/[\\/]/).pop().replace(/\.exe$/i, ""));
}

function parseArgs(argv) {
  const options = { files: [], ledgerPath: DEFAULT_LEDGER, workers: null, inPlace: false, only: null, progress: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`mutation-check: ${arg} requires a value`);
      index += 1;
      return argv[index];
    };
    if (arg === "--ledger") options.ledgerPath = path.resolve(value());
    else if (arg === "--workers") {
      options.workers = Number(value());
      if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new Error("mutation-check: --workers must be a positive integer");
    } else if (arg === "--in-place") options.inPlace = true;
    else if (arg === "--only") options.only = new Set(value().split(",").map((id) => id.trim()).filter(Boolean));
    else if (arg === "--progress") options.progress = path.resolve(value());
    else if (arg.startsWith("--")) throw new Error(`mutation-check: unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (options.files.length === 0) {
    throw new Error("usage: mutation-check <spec.json>... [--workers <n>] [--in-place] [--only <id,...>] [--progress <file>] [--ledger <path>]");
  }
  return options;
}

function defaultWorkers() {
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cpus - 1));
}

/**
 * Run the mutants of every spec file. Most run on a pool of worker copies of
 * the tree, so the checkout is never edited and several run at once; a spec
 * whose command is Python runs in the checkout, one at a time, beside them.
 * A stale mutant (find text absent or repeated) is reported and skipped, so
 * it never hides the mutants after it.
 */
async function runSpecs({
  files, repoRoot = REPO_ROOT, ledgerPath = DEFAULT_LEDGER, workers = defaultWorkers(), inPlace = false, only = null, progress = null,
  run = defaultRun, git = defaultGit, now = () => new Date(), out = (line) => process.stdout.write(`${line}\n`),
  workerRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "mutation-worker-")),
}) {
  const startedAt = Date.now();
  const recovered = recoverInterrupted(path.join(repoRoot, JOURNAL_DIR_NAME));
  for (const file of recovered) out(`RESTORED                   ${path.relative(repoRoot, file)} (left mutated by an interrupted run)`);
  const done = new Set();
  if (progress !== null && fs.existsSync(progress)) {
    for (const line of fs.readFileSync(progress, "utf8").split(/\r?\n/)) {
      if (line === "") continue;
      try {
        const entry = JSON.parse(line);
        if (entry.outcome === OUTCOME_KILLED) done.add(entry.id);
      } catch {
        void 0;
      }
    }
  }
  const items = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    if (!Array.isArray(parsed.mutations)) throw new Error(`mutation-check: ${file} must contain a mutations array`);
    for (const spec of parsed.mutations) {
      if (only !== null && !only.has(spec.id)) continue;
      if (done.has(spec.id)) continue;
      items.push(spec);
    }
  }
  const gitInfo = git(repoRoot);
  const counts = {};
  const record = (id, outcome, line) => {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    out(line);
    if (progress !== null) fs.appendFileSync(progress, `${JSON.stringify({ id, outcome })}\n`);
  };
  const runOne = async (spec, root, baselines) => {
    try {
      const result = await runMutation({ repoRoot: root, spec, ledgerPath, run, now, git: () => gitInfo, baselines });
      record(result.id, result.outcome, `${result.outcome.padEnd(26)} ${result.id}`);
    } catch (error) {
      // One mutant's failure is reported and the run goes on: a throw here
      // would also pull the worker copies out from under the other lanes.
      const message = (error?.message ?? String(error)).replace(/^mutation-check: /, "");
      const outcome = /find text (not found|occurs more than once)|target file not found/.test(message) ? "STALE" : "ERROR";
      record(spec.id, outcome, `${outcome.padEnd(26)} ${spec.id} (${message})`);
    }
  };
  const lane = async (queue, root) => {
    const baselines = new Map();
    while (queue.length > 0) await runOne(queue.shift(), root, baselines);
  };
  const local = inPlace ? [...items] : items.filter(runsInPlace);
  const pooled = inPlace ? [] : items.filter((spec) => !runsInPlace(spec));
  const copies = [];
  try {
    const poolSize = Math.min(workers, pooled.length);
    const lanes = [lane(local, repoRoot)];
    for (let index = 0; index < poolSize; index += 1) {
      const root = workerRoot();
      copies.push(root);
      prepareWorkerTree(repoRoot, root);
      lanes.push(lane(pooled, root));
    }
    await Promise.all(lanes);
  } finally {
    for (const root of copies) fs.rmSync(root, { recursive: true, force: true });
  }
  compactLedger(ledgerPath);
  const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  out(`mutation-check: ${items.length} mutants in ${seconds} s; ${Object.entries(counts).map(([outcome, count]) => `${outcome} ${count}`).join(", ") || "none run"}`);
  return { counts, total: items.length, allKilled: items.length === (counts[OUTCOME_KILLED] ?? 0) };
}

function requiredNode(repoRoot = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).engines?.node ?? null;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const required = requiredNode();
  if (required !== null && process.versions.node !== required) {
    throw new Error(`mutation-check: the repository pins Node ${required}; this is Node ${process.versions.node}. A kill or a survival on another Node is not evidence.`);
  }
  const summary = await runSpecs({ ...options, workers: options.workers ?? defaultWorkers() });
  if (!summary.allKilled) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  });
}

module.exports = {
  runMutation, runSpecs, compactLedger, validateSpec, failureLines, locate, quoteArgument, resolveCommand, recoverInterrupted, prepareWorkerTree, parseArgs, runsInPlace, requiredNode,
};
