#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { parseEnv } = require("node:util");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const POSIX_FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const WINDOWS_HELD_SIGNALS = Object.freeze(["SIGINT", "SIGBREAK"]);

function requiredVersion(root = REPOSITORY_ROOT) {
  return fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
}

function envFileValue(name, root) {
  try {
    return parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8"))[name];
  } catch {
    return undefined;
  }
}

function executableIn(candidate, platform, statImpl = fs.statSync) {
  const binary = platform === "win32" ? "node.exe" : "node";
  let stat;
  try {
    stat = statImpl(candidate);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return candidate;
  for (const option of [path.join(candidate, binary), path.join(candidate, "bin", binary)]) {
    try {
      if (statImpl(option).isFile()) return option;
    } catch {
      continue;
    }
  }
  return null;
}

function candidatePaths({ env, root, platform, homedir, version }) {
  const list = [];
  const configured = env.TT_NODE_BIN || envFileValue("TT_NODE_BIN", root);
  if (configured) list.push({ source: "TT_NODE_BIN", path: configured });
  if (env.NVM_HOME) list.push({ source: "nvm-windows", path: path.join(env.NVM_HOME, `v${version}`) });
  if (env.NVM_DIR) list.push({ source: "nvm", path: path.join(env.NVM_DIR, "versions", "node", `v${version}`) });
  list.push({ source: "nvm", path: path.join(homedir, ".nvm", "versions", "node", `v${version}`) });
  const fnmRoot = env.FNM_DIR || (platform === "win32"
    ? path.join(env.APPDATA || path.join(homedir, "AppData", "Roaming"), "fnm")
    : path.join(homedir, ".local", "share", "fnm"));
  list.push({ source: "fnm", path: path.join(fnmRoot, "node-versions", `v${version}`, "installation") });
  const voltaRoot = env.VOLTA_HOME || (platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(homedir, "AppData", "Local"), "Volta")
    : path.join(homedir, ".volta"));
  list.push({ source: "volta", path: path.join(voltaRoot, "tools", "image", "node", version) });
  return list;
}

function probeVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().replace(/^v/, "") : null;
}

function resolvePinnedNode({
  env = process.env,
  root = REPOSITORY_ROOT,
  platform = process.platform,
  homedir = os.homedir(),
  currentExecutable = process.execPath,
  currentVersion = process.versions.node,
  probe = probeVersion,
  statImpl = fs.statSync,
} = {}) {
  const version = requiredVersion(root);
  if (currentVersion === version) return Object.freeze({ executable: currentExecutable, source: "current", version, tried: [] });
  const tried = [];
  for (const candidate of candidatePaths({ env, root, platform, homedir, version })) {
    const executable = executableIn(candidate.path, platform, statImpl);
    if (executable === null) {
      tried.push(`${candidate.source}: ${candidate.path} not found`);
      continue;
    }
    const found = probe(executable);
    if (found === version) return Object.freeze({ executable, source: candidate.source, version, tried });
    tried.push(`${candidate.source}: ${executable} is ${found === null ? "not runnable" : `Node ${found}`}`);
  }
  return Object.freeze({ executable: null, source: null, version, currentVersion, tried });
}

function refusal(pinned) {
  return [
    `terminal-l1-l2 needs Node ${pinned.version}; this shell runs Node ${pinned.currentVersion} and no Node ${pinned.version} was found.`,
    ...pinned.tried.map((line) => `  tried ${line}`),
    `Install Node ${pinned.version} (nvm, fnm or volta work), or set TT_NODE_BIN in .env to its node executable or folder.`,
    "",
  ].join("\n");
}

function launch(argv, {
  resolve = resolvePinnedNode,
  spawnImpl = spawn,
  processImpl = process,
  platform = process.platform,
  stderr = process.stderr,
} = {}) {
  if (argv.length === 0) {
    stderr.write("node-launcher: usage: node-launcher.cjs <node arguments…>\n");
    processImpl.exitCode = 2;
    return null;
  }
  const pinned = resolve();
  if (pinned.executable === null) {
    stderr.write(refusal(pinned));
    processImpl.exitCode = 1;
    return null;
  }
  const child = spawnImpl(pinned.executable, argv, { stdio: "inherit" });
  const handlers = new Map();
  const signals = platform === "win32" ? WINDOWS_HELD_SIGNALS : POSIX_FORWARDED_SIGNALS;
  for (const signal of signals) {
    const handler = platform === "win32"
      ? () => {}
      : () => {
        try {
          child.kill(signal);
        } catch {
          void 0;
        }
      };
    handlers.set(signal, handler);
    processImpl.on(signal, handler);
  }
  const release = () => {
    for (const [signal, handler] of handlers) processImpl.off(signal, handler);
    handlers.clear();
  };
  child.on("error", (error) => {
    release();
    stderr.write(`node-launcher: could not start ${pinned.executable}: ${error?.message ?? error}\n`);
    processImpl.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    release();
    processImpl.exitCode = code ?? (signal ? 1 : 0);
  });
  return child;
}

if (require.main === module) {
  launch(process.argv.slice(2));
}

module.exports = { launch, resolvePinnedNode, candidatePaths, executableIn, requiredVersion, refusal };
