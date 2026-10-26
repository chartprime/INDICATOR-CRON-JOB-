"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_ROOT = path.join(__dirname, "..", "..");

function resolveConfiguredDir(envName, fallbackDir) {
  const configured = process.env[envName];
  if (configured === undefined || configured === "") {
    return fallbackDir;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`${envName} must be an absolute path, received ${JSON.stringify(configured)}`);
  }
  let stats;
  try {
    stats = fs.statSync(configured);
  } catch (error) {
    throw new Error(`${envName} points at ${JSON.stringify(configured)} which is not accessible: ${error?.code ?? error?.message ?? error}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${envName} must point at an existing directory, ${JSON.stringify(configured)} is not one`);
  }
  return configured;
}

function dataRoot() {
  return resolveConfiguredDir("TT_DATA_ROOT", path.join(RUNTIME_ROOT, "data"));
}

function logDir() {
  return resolveConfiguredDir("TT_LOG_DIR", path.join(RUNTIME_ROOT, "logs"));
}

function runtimeDir() {
  if (process.env.TT_RUNTIME_DIR !== undefined && process.env.TT_RUNTIME_DIR !== "") {
    return resolveConfiguredDir("TT_RUNTIME_DIR", null);
  }
  const fallback = path.join(RUNTIME_ROOT, "run");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

module.exports = { RUNTIME_ROOT, dataRoot, logDir, runtimeDir };
