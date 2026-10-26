"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

test("documentation validation excludes generated runtime data before traversing it", () => {
  const file = path.join(__dirname, "validate-docs.cjs");
  const source = fs.readFileSync(file, "utf8");
  const generated = path.resolve(__dirname, "../apps/runtime/data");
  function run(code) {
    const result = { exitCode: 0 };
    const errors = [];
    const guardedFs = {
      ...fs,
      existsSync: (target) => path.resolve(target) === generated || fs.existsSync(target),
      statSync: (target) => path.resolve(target) === generated ? { isFile: () => false } : fs.statSync(target),
      readdirSync(target, ...options) {
        if (path.resolve(target) === generated) throw new Error("generated data must not be scanned");
        const entries = fs.readdirSync(target, ...options);
        if (path.resolve(target) === path.dirname(generated) && !entries.some((entry) => entry.name === "data")) {
          entries.push({ name: "data", isDirectory: () => true });
        }
        return entries;
      },
    };
    vm.runInNewContext(code, {
      __dirname,
      require: (name) => name === "node:fs" ? guardedFs : require(name),
      console: { log: () => {}, error: (message) => errors.push(message) },
      process: result,
    }, { filename: file });
    assert.equal(result.exitCode, 0, errors.join("\n"));
  }
  run(source);
  const mutant = source.replace(/^[ \t]*if \(TRANSIENT_ROOTS\.has\(path\.relative\(ROOT, target\)\)\) return \[\];\r?\n/m, "");
  assert.notEqual(mutant, source);
  assert.throws(() => run(mutant), /generated data must not be scanned/);
});
