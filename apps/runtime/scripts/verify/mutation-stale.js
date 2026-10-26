#!/usr/bin/env node
"use strict";

// Finds mutants whose find text no longer occurs exactly once in their file,
// so a spec cannot go stale unnoticed. With --base it fails only on what the
// branch broke: a mutant that matched once at the base and does not now, or a
// mutant the branch added or changed that does not match.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SPEC_DIR = path.join("benchmarks", "mutations");

function matchCount(text, find) {
  if (typeof text !== "string") return null;
  const variants = text.includes("\r\n") && !find.includes("\r\n") ? [find, find.replace(/\n/g, "\r\n")] : [find];
  let count = 0;
  for (const candidate of variants) {
    for (let start = text.indexOf(candidate); start !== -1; start = text.indexOf(candidate, start + candidate.length)) count += 1;
    if (count > 0) return count;
  }
  return 0;
}

function git(repoRoot, args) {
  const result = childProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function specsOf(text) {
  try {
    const parsed = JSON.parse(text);
    const mutations = Array.isArray(parsed) ? parsed : parsed?.mutations;
    return Array.isArray(mutations) ? mutations.filter((m) => typeof m?.file === "string" && typeof m?.find === "string" && m.find.length > 0) : [];
  } catch {
    return [];
  }
}

function scanStale({ repoRoot = REPO_ROOT, base = null } = {}) {
  const specDir = path.join(repoRoot, SPEC_DIR);
  const now = new Map();
  const then = new Map();
  const readNow = (file) => {
    if (!now.has(file)) {
      const full = path.join(repoRoot, file);
      now.set(file, fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null);
    }
    return now.get(file);
  };
  const readThen = (file) => {
    if (!then.has(file)) then.set(file, git(repoRoot, ["show", `${base}:${file.replace(/\\/g, "/")}`]));
    return then.get(file);
  };
  const baseSpecs = new Map();
  const baseMutant = (name, id) => {
    if (!baseSpecs.has(name)) {
      const text = git(repoRoot, ["show", `${base}:${SPEC_DIR.replace(/\\/g, "/")}/${name}`]);
      baseSpecs.set(name, new Map((text === null ? [] : specsOf(text)).map((mutant) => [mutant.id, mutant])));
    }
    return baseSpecs.get(name).get(id);
  };
  if (base !== null && git(repoRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    throw new Error(`mutation-stale: cannot compare with ${base}`);
  }
  const stale = [];
  for (const name of fs.readdirSync(specDir).filter((entry) => entry.endsWith(".json")).sort()) {
    for (const mutant of specsOf(fs.readFileSync(path.join(specDir, name), "utf8"))) {
      const count = matchCount(readNow(mutant.file), mutant.find);
      if (count === 1) continue;
      const entry = { spec: name, id: mutant.id, file: mutant.file, matches: count, cause: "stale" };
      if (base !== null) {
        const before = baseMutant(name, mutant.id);
        if (before === undefined || before.file !== mutant.file || before.find !== mutant.find) entry.cause = "new-stale";
        else entry.cause = matchCount(readThen(mutant.file), mutant.find) === 1 ? "broken" : "pre-existing";
      }
      stale.push(entry);
    }
  }
  const blocking = stale.filter((entry) => entry.cause !== "pre-existing");
  return { stale, blocking };
}

function main(argv = process.argv.slice(2)) {
  let base = null;
  const at = argv.indexOf("--base");
  if (at !== -1) {
    base = argv[at + 1];
    if (!base) throw new Error("usage: mutation-stale [--base <ref>]");
  }
  const { stale, blocking } = scanStale({ base });
  const describe = (entry) => `  ${entry.spec} ${entry.id} (${entry.file}: ${entry.matches === null ? "file missing" : `${entry.matches} matches`})`;
  if (base === null) {
    process.stdout.write(`mutation-stale: ${stale.length} stale mutants\n${stale.map(describe).join("\n")}${stale.length ? "\n" : ""}`);
  } else {
    const label = { broken: "broken since the base", "new-stale": "added or changed by this branch, and stale" };
    for (const cause of ["broken", "new-stale"]) {
      const list = blocking.filter((entry) => entry.cause === cause);
      if (list.length) process.stdout.write(`${label[cause]}: ${list.length}\n${list.map(describe).join("\n")}\n`);
    }
    process.stdout.write(`mutation-stale: ${blocking.length} blocking, ${stale.length - blocking.length} stale before ${base}\n`);
  }
  if (blocking.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  }
}

module.exports = { scanStale, matchCount };
