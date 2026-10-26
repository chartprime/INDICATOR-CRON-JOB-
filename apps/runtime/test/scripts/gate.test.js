"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const { runGate, report, parseArgs, jestCounts, vitestCounts, pytestCounts, steps } = require("../../../../scripts/gate.cjs");

function fakeSpawn(behaviour, log) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const name = behaviour.nameOf(args, options.cwd);
    log.push({ event: "start", name, at: Date.now() });
    const { code = 0, output = "", delayMs = 0 } = behaviour[name] ?? {};
    setTimeout(() => {
      child.stdout.end(output);
      child.stderr.end();
      log.push({ event: "end", name, at: Date.now() });
      child.emit("close", code);
    }, delayMs);
    return child;
  };
}

describe("scripts/gate", () => {
  let logDir;
  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  });
  afterEach(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const nameOf = (args) => {
    const file = args[0];
    if (file.includes("validate-docs")) return "docs";
    if (file.includes("eslint")) return "eslint";
    if (file.includes("oxlint")) return "oxlint";
    if (file.includes("tsc")) return "typecheck";
    if (file.includes("vite.js")) return "build";
    if (file.includes("jest")) return args.includes("--testPathIgnorePatterns") ? "runtime tests" : "runtime load bench";
    if (file.includes("vitest")) return "web tests";
    if (file === "run") return "conversion tests";
    return "stale mutants";
  };

  test("reads the test counts from jest's and vitest's summaries", () => {
    expect(jestCounts("noise\nTests:       3 failed, 5 skipped, 5468 passed, 5476 total\nTime: 98 s\n")).toEqual({ passed: 5468, failed: 3, skipped: 5 });
    expect(vitestCounts(" Test Files  283 passed | 1 skipped (284)\n      Tests  4249 passed | 1 skipped (4250)\n")).toEqual({ passed: 4249, failed: 0, skipped: 1 });
    expect(vitestCounts("\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m | 10 passed (12)\n")).toEqual({ passed: 10, failed: 2, skipped: 0 });
    expect(jestCounts("no summary")).toBeNull();
    expect(pytestCounts("....\n27 failed, 1090 passed, 1 skipped in 140.50s (0:02:20)\n")).toEqual({ passed: 1090, failed: 27, skipped: 1 });
    expect(pytestCounts("1117 passed, 1 skipped in 148.63s (0:02:28)\n")).toEqual({ passed: 1117, failed: 0, skipped: 1 });
  });

  test("runs every step, the two suites in their own slots, and fails the gate when one step fails", async () => {
    const log = [];
    const spawn = fakeSpawn({
      nameOf,
      "runtime tests": { output: "Tests:       1 failed, 9 passed, 10 total\n", code: 1, delayMs: 30 },
      "web tests": { output: "      Tests  7 passed (7)\n", delayMs: 30 },
    }, log);
    const outcome = await runGate({ base: "base-ref", heavySlots: 1, logDir, spawn, uv: true });
    expect(outcome.results.map((result) => [result.name, result.ok])).toEqual([
      ["docs", true], ["eslint", true], ["oxlint", true], ["typecheck", true], ["build", true],
      ["runtime tests", false], ["web tests", true], ["conversion tests", true], ["stale mutants", true], ["runtime load bench", true],
    ]);
    expect(outcome.results[5].counts).toEqual({ passed: 9, failed: 1, skipped: 0 });
    const runtimeEnd = log.find((entry) => entry.event === "end" && entry.name === "runtime tests").at;
    const webStart = log.find((entry) => entry.event === "start" && entry.name === "web tests").at;
    expect(webStart).toBeGreaterThanOrEqual(runtimeEnd);
    expect(fs.readFileSync(outcome.results[5].logFile, "utf8")).toContain("1 failed, 9 passed");
    const text = report(outcome, { base: "base-ref" });
    expect(text).toMatch(/^### Local gate: FAIL/);
    expect(text).toContain("| runtime tests | **FAIL** (9 passed, 1 failed) |");
    expect(text).toContain("| web tests | pass (7 passed) |");
    expect(text).toContain(`Log of runtime tests: ${outcome.results[5].logFile}`);
    expect(log.find((entry) => entry.event === "start" && entry.name === "conversion tests")).toBeDefined();
  });

  test("with two slots the suites run side by side, and without a base the stale check is skipped with its reason", async () => {
    const log = [];
    const spawn = fakeSpawn({ nameOf, "runtime tests": { delayMs: 40 }, "web tests": { delayMs: 40 } }, log);
    const outcome = await runGate({ base: null, heavySlots: 2, logDir, spawn, uv: false });
    const webStart = log.find((entry) => entry.event === "start" && entry.name === "web tests").at;
    const runtimeEnd = log.find((entry) => entry.event === "end" && entry.name === "runtime tests").at;
    expect(webStart).toBeLessThan(runtimeEnd);
    expect(outcome.results.every((result) => result.ok)).toBe(true);
    expect(log.some((entry) => entry.name === "stale mutants")).toBe(false);
    const text = report(outcome, { base: null });
    expect(text).toMatch(/^### Local gate: pass/);
    expect(text).toContain("| stale mutants | skipped: no base to compare with (pass --base <ref>) |");
    expect(text).toContain("| conversion tests | skipped: uv is not installed (see apps/runtime/conversion) |");
  });

  test("runs the real-time load benchmark alone, after every other step, and keeps it out of the runtime suite", async () => {
    const log = [];
    const spawn = fakeSpawn({ nameOf, "runtime tests": { delayMs: 30 }, "web tests": { delayMs: 50 }, "conversion tests": { delayMs: 40 } }, log);
    const outcome = await runGate({ base: "base-ref", heavySlots: 3, logDir, spawn, uv: true });
    expect(outcome.results.every((result) => result.ok)).toBe(true);
    const benchStart = log.find((entry) => entry.event === "start" && entry.name === "runtime load bench").at;
    for (const entry of log.filter((item) => item.event === "end" && item.name !== "runtime load bench")) expect(benchStart).toBeGreaterThanOrEqual(entry.at);
    const plan = steps({ base: "b", uv: true });
    const bench = plan.find((step) => step.name === "runtime load bench").command.at(-1);
    expect(plan.find((step) => step.name === "runtime tests").command.slice(-2)).toEqual(["--testPathIgnorePatterns", bench]);
  });

  test("runs every Node tool with this Node, never through npx or a shell, and the conversion suite through uv", () => {
    const plan = steps({ base: "b", uv: true });
    for (const step of plan.filter((entry) => entry.name !== "conversion tests")) expect(step.command[0]).toBe(process.execPath);
    expect(plan.find((entry) => entry.name === "conversion tests").command.slice(0, 3)).toEqual(["uv", "run", "--frozen"]);
  });

  test("parses its options", () => {
    expect(parseArgs([])).toEqual({ base: "origin/development-indicator-sdk", heavySlots: 3, reportFile: null });
    expect(parseArgs(["--no-base", "--heavy", "1", "--report", "r.md"])).toMatchObject({ base: null, heavySlots: 1, reportFile: path.resolve("r.md") });
    expect(() => parseArgs(["--heavy", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--fast"])).toThrow(/unknown option/);
  });
});
