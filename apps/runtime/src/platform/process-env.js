"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { namesForProcess, assertProcessEnv, CONFIG_REGISTRY } = require("./config-registry");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_ENV_FILE = path.join(REPOSITORY_ROOT, ".env");
const REGISTERED = new Set(CONFIG_REGISTRY.map((item) => item.name));

function readEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return parseEnv(text);
}

function loadProcessEnv(processName, { file = DEFAULT_ENV_FILE, env = process.env } = {}) {
  const parsed = readEnvFile(file);
  if (parsed === null) return Object.freeze({ file, present: false, loaded: Object.freeze([]), ignored: Object.freeze([]), unknown: Object.freeze([]) });
  const allowed = new Set(namesForProcess(processName));
  const loaded = [];
  const ignored = [];
  const unknown = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!allowed.has(name)) {
      (REGISTERED.has(name) ? ignored : unknown).push(name);
      continue;
    }
    if (env[name] !== undefined) continue;
    env[name] = value;
    loaded.push(name);
  }
  return Object.freeze({
    file,
    present: true,
    loaded: Object.freeze(loaded),
    ignored: Object.freeze(ignored),
    unknown: Object.freeze(unknown),
  });
}

function bootProcess(processName, {
  isMain,
  envFile = false,
  file = DEFAULT_ENV_FILE,
  env = process.env,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  if (!isMain) return null;
  const loaded = envFile ? loadProcessEnv(processName, { file, env }) : null;
  try {
    assertProcessEnv(processName, env, { warn: (line) => stderr.write(`${line}\n`) });
  } catch (error) {
    if (error?.code !== "CONFIG_INVALID") throw error;
    stderr.write(`${error.message}\n`);
    exit(1);
    return null;
  }
  return loaded;
}

module.exports = { loadProcessEnv, bootProcess, readEnvFile, DEFAULT_ENV_FILE, REPOSITORY_ROOT };
