#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CONVERSION_DIR = path.join(__dirname, "..", "..", "conversion");
const OPT_ROOT = process.env.TT_OPT_ROOT || "/opt/terminal-l1-l2";

function fail(message, code = 1) {
  process.stderr.write(`run-conversion: ${message}\n`);
  process.exit(code);
}

function which(bin) {
  return (process.env.PATH || "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch { return false; }
  });
}

const uvBin = process.env.TT_UV_BIN
  || (fs.existsSync(path.join(OPT_ROOT, "uv-0.10.10", "uv")) ? path.join(OPT_ROOT, "uv-0.10.10", "uv") : "uv");

const args = process.argv.slice(2);
if (args.length === 0) fail("usage: run-conversion.js --source <path> --schema <s> --dataset-version <v> --staging-root <d> --curated-root <d> --catalog-root <d>");

const uvArgs = ["run", "--project", CONVERSION_DIR, "--frozen", "python", path.join(CONVERSION_DIR, "cli.py"), ...args];

let command = uvBin;
let commandArgs = uvArgs;
if (process.platform !== "win32" && which("nice") && which("ionice")) {
  command = "nice";
  commandArgs = ["-n", "15", "ionice", "-c", "3", uvBin, ...uvArgs];
}

const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error) fail(`failed to launch conversion: ${result.error.message}`);
process.exit(result.status ?? 1);
