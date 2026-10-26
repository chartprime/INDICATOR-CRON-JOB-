#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");

const RUNTIME_DIR = path.resolve(__dirname, "..", "..");
const WEB_DIR = path.resolve(RUNTIME_DIR, "..", "web");
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 60_000;
const STEADY_MS = 10 * 60_000;
const FORCE_EXIT_GRACE_MS = 5_000;

function parseStackArgs(argv) {
  const options = { port: 8001, vitePort: 8000, symbol: "BTCUSDT", vite: true, collector: true, dxfeedEager: false };
  for (const arg of argv) {
    if (arg === "--no-vite") options.vite = false;
    else if (arg === "--no-collector") options.collector = false;
    else if (arg === "--dxfeed-eager") options.dxfeedEager = true;
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--vite-port=")) options.vitePort = Number(arg.slice("--vite-port=".length));
    else if (arg.startsWith("--symbol=")) options.symbol = arg.slice("--symbol=".length);
    else throw new Error(`run-stack: unknown argument ${arg}`);
  }
  for (const [name, value] of [["--port", options.port], ["--vite-port", options.vitePort]]) {
    if (!Number.isInteger(value) || value <= 0 || value > 65_535) throw new Error(`run-stack: ${name} must be a port number`);
  }
  if (options.symbol.length === 0) throw new Error("run-stack: --symbol must not be empty");
  return options;
}

function viteBinPath(fromDir = WEB_DIR) {
  let dir = path.dirname(require.resolve("vite", { paths: [fromDir] }));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.name === "vite") return path.join(dir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.vite);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("run-stack: could not find vite's package.json above its entry point");
    dir = parent;
  }
}

function stackCommands(options, { node = process.execPath, viteBin = null } = {}) {
  const commands = [{
    name: "runtime",
    cwd: RUNTIME_DIR,
    command: node,
    args: ["scripts/serve/run-ws-server.js", String(options.port), options.symbol, ...(options.dxfeedEager ? ["--dxfeed-eager"] : [])],
  }];
  if (options.collector) commands.push({ name: "collector", cwd: RUNTIME_DIR, command: node, args: ["scripts/collect/run-collector.js"] });
  if (options.vite) {
    commands.push({
      name: "vite",
      cwd: WEB_DIR,
      command: node,
      args: [viteBin ?? viteBinPath(), "--port", String(options.vitePort), "--strictPort"],
    });
  }
  return commands;
}

function restartDelay(entry, uptimeMs) {
  const steady = uptimeMs >= STEADY_MS;
  const delay = steady ? RESTART_BASE_MS : entry.backoffMs;
  entry.backoffMs = Math.min(RESTART_MAX_MS, (steady ? RESTART_BASE_MS : entry.backoffMs) * 2);
  return delay;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawn,
  logger = createCliLogger({ name: "run-stack" }),
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  viteBin = null,
  processImpl = process,
} = {}) {
  let options;
  try {
    options = parseStackArgs(argv);
  } catch (error) {
    logger.error(error.message);
    await flushAndExit(logger, processImpl.exit, 1);
    return null;
  }
  const specs = stackCommands(options, { node: processImpl.execPath, viteBin });
  const entries = new Map();
  let stopping = false;
  let settled = false;
  let forceExitTimer = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  function settle(exitCode) {
    if (settled) return;
    settled = true;
    if (forceExitTimer !== null) clearTimeoutImpl(forceExitTimer);
    for (const entry of entries.values()) if (entry.timer !== null) clearTimeoutImpl(entry.timer);
    processImpl.off("SIGINT", onSigint);
    processImpl.off("SIGTERM", onSigterm);
    Promise.resolve(flushAndExit(logger, processImpl.exit, exitCode)).then(() => resolveCompletion(exitCode), () => resolveCompletion(exitCode));
  }

  function everyChildGone() {
    return [...entries.values()].every((entry) => entry.child === null);
  }

  function launch(spec) {
    const entry = entries.get(spec.name);
    entry.timer = null;
    let child;
    try {
      child = spawnImpl(spec.command, spec.args, { cwd: spec.cwd, stdio: "inherit", env });
    } catch (error) {
      logger.error(`${spec.name} failed to launch`, { reason: error?.message ?? String(error) });
      scheduleRestart(spec, entry, 0);
      return;
    }
    entry.child = child;
    entry.startedAt = now();
    logger.ok(`${spec.name} started`, { pid: child.pid, command: [spec.command, ...spec.args].join(" ") });
    child.on("error", (error) => {
      logger.error(`${spec.name} errored`, { reason: error?.message ?? String(error) });
    });
    child.on("exit", (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      if (stopping) {
        if (everyChildGone()) settle(entry.exitCode ?? 0);
        return;
      }
      scheduleRestart(spec, entry, now() - entry.startedAt, { code, signal });
    });
  }

  function scheduleRestart(spec, entry, uptimeMs, exit = {}) {
    const delay = restartDelay(entry, uptimeMs);
    logger.warn(`${spec.name} exited, restarting`, { ...exit, uptimeMs, restartInMs: delay });
    entry.timer = setTimeoutImpl(() => launch(spec), delay);
  }

  function stop(signal = "SIGTERM") {
    if (stopping) return completion;
    stopping = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    for (const entry of entries.values()) {
      entry.exitCode = exitCode;
      if (entry.timer !== null) {
        clearTimeoutImpl(entry.timer);
        entry.timer = null;
      }
      if (entry.child !== null) {
        try {
          entry.child.kill(signal);
        } catch (error) {
          logger.error("failed to signal a child", { reason: error?.message ?? String(error) });
        }
      }
    }
    if (everyChildGone()) {
      settle(exitCode);
      return completion;
    }
    forceExitTimer = setTimeoutImpl(() => {
      for (const entry of entries.values()) {
        if (entry.child === null) continue;
        try {
          entry.child.kill("SIGKILL");
        } catch {
          void 0;
        }
      }
      settle(exitCode);
    }, FORCE_EXIT_GRACE_MS);
    return completion;
  }

  function onSigint() {
    logger.warn("received SIGINT, stopping the stack");
    stop("SIGINT");
  }

  function onSigterm() {
    logger.warn("received SIGTERM, stopping the stack");
    stop("SIGTERM");
  }

  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  for (const spec of specs) {
    entries.set(spec.name, { child: null, startedAt: 0, backoffMs: RESTART_BASE_MS, timer: null, exitCode: null });
    launch(spec);
  }
  return { stop, completion, children: () => [...entries.entries()].map(([name, entry]) => ({ name, pid: entry.child?.pid ?? null })) };
}

if (require.main === module) {
  main();
}

module.exports = { main, parseStackArgs, stackCommands, viteBinPath, restartDelay, RESTART_BASE_MS, RESTART_MAX_MS, STEADY_MS };
