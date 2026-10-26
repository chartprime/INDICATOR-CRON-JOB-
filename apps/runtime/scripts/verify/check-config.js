#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { parseEnv } = require("node:util");
const { validateProcessEnv, PROCESSES } = require("../../src/platform/config-registry");

const USAGE = `usage: check-config.js <${Object.values(PROCESSES).join("|")}> [--env-file <path>]`;

function parseArgs(argv) {
  const [processName, ...rest] = argv;
  if (!processName || !Object.values(PROCESSES).includes(processName)) throw new Error(USAGE);
  let envFile = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--env-file" && typeof rest[index + 1] === "string") {
      envFile = rest[index + 1];
      index += 1;
    } else {
      throw new Error(USAGE);
    }
  }
  return { processName, envFile };
}

function checkConfig(argv, { env = process.env, readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const { processName, envFile } = parseArgs(argv);
  const source = envFile === null ? env : parseEnv(readFile(envFile));
  const result = validateProcessEnv(processName, source);
  const lines = [
    ...result.errors.map((error) => `FAIL ${error.name} ${error.problem}`),
    ...result.warnings.map((warning) => `WARN ${warning.name} ${warning.problem}`),
  ];
  lines.push(result.errors.length === 0
    ? `ok   ${processName}: every setting it reads is valid${envFile === null ? "" : ` in ${envFile}`}`
    : `${processName} would refuse to start: ${result.errors.length} invalid setting(s)`);
  return { ok: result.errors.length === 0, lines };
}

if (require.main === module) {
  try {
    const { ok, lines } = checkConfig(process.argv.slice(2));
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-config: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}

module.exports = { checkConfig, parseArgs };
