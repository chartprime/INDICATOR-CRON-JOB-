#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function parseDemoArgs(argv) {
  const symbol = argv.find((arg) => !arg.startsWith("--")) ?? "BTCUSDT";
  const flag = (name) => {
    const raw = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (raw === undefined) return undefined;
    const value = Number(raw.slice(name.length + 3));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name} value "${raw}"`);
    return value;
  };
  return { symbol, seconds: flag("seconds") ?? 0, port: flag("port") ?? 8001 };
}

function start() {
  let parsed;
  try {
    parsed = parseDemoArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { symbol, seconds, port } = parsed;
  const envFile = path.resolve(__dirname, "../../../../.env");
  const nodeArgs = fs.existsSync(envFile) ? [`--env-file=${envFile}`] : [];
  console.log(`l2-memory demo: ${symbol} on port ${port}${seconds ? `, stopping after ${seconds}s` : ", Ctrl+C to stop"}`);
  console.log("l2-memory demo: the memory prints its top levels every 5 s once the book has seeded");
  const child = spawn(
    process.execPath,
    [...nodeArgs, path.join(__dirname, "run-ws-server.js"), String(port), symbol],
    { stdio: "inherit", env: { ...process.env, L2_MEMORY_DEBUG: "1" } },
  );
  if (seconds > 0) {
    const timer = setTimeout(() => child.kill("SIGINT"), seconds * 1000);
    timer.unref?.();
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (require.main === module) start();

module.exports = { parseDemoArgs };
