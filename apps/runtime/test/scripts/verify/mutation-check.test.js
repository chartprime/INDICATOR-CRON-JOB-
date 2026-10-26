"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const childProcess = require("node:child_process");

const {
  runMutation, runSpecs, compactLedger, validateSpec, failureLines, quoteArgument, resolveCommand, recoverInterrupted, prepareWorkerTree, parseArgs, runsInPlace, requiredNode,
} = require("../../../scripts/verify/mutation-check");

describe("scripts/verify/mutation-check", () => {
  let dir;
  let ledgerPath;
  const targetPath = () => path.join(dir, "target.js");
  const write = (file, content) => fs.writeFileSync(path.join(dir, file), content);
  const ledger = () => fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const spec = (overrides = {}) => ({
    id: "one-returns-one", file: "target.js", find: "() => 1", replace: "() => 2", command: ["node", "check.js"],
    mustFail: ["one returns 1"], ...overrides,
  });
  const runSpec = (overrides) => runMutation({
    repoRoot: dir, spec: spec(overrides), ledgerPath, git: () => null, now: () => new Date("2026-09-20T00:00:00.000Z"),
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-check-"));
    ledgerPath = path.join(dir, "ledger.jsonl");
    write("target.js", "module.exports = {\n  one: () => 1,\n  two: () => 2,\n};\n");
    write("check.js", [
      'const t = require("./target.js");',
      'if (t.one() !== 1) { console.log("  ● one returns 1"); process.exit(1); }',
      "",
    ].join("\n"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a mutation the tests catch is recorded as killed with the failing test name and the file is restored byte-exact", async () => {
    const before = fs.readFileSync(targetPath());
    const result = await runSpec();
    expect(result).toMatchObject({ outcome: "KILLED", baselineExit: 0, mutatedExit: 1, restoredVerified: true });
    expect(result.observedFailures).toEqual(["● one returns 1"]);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({
      id: "one-returns-one", atUtc: "2026-09-20T00:00:00.000Z", file: "target.js", outcome: "KILLED",
      fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/), mutantSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(ledger()[0].fileSha256).not.toBe(ledger()[0].mutantSha256);
    expect(ledger()[0]).toMatchObject({ baselineMs: expect.any(Number), mutatedMs: expect.any(Number) });
    expect(ledger()[0].mutatedMs).toBeGreaterThan(0);
  });

  test("a mutation the tests do not catch survives and is reported, not hidden", async () => {
    const result = await runSpec({ id: "two-is-untested", find: "() => 2", replace: "() => 3" });
    expect(result.outcome).toBe("SURVIVED");
    expect(result.mutatedExit).toBe(0);
    expect(ledger()[0].outcome).toBe("SURVIVED");
  });

  test("a mutation caught by a different test than the one named is not counted as killed", async () => {
    expect((await runSpec({ mustFail: ["some other test"] })).outcome).toBe("KILLED_BY_UNEXPECTED_TEST");
  });

  test("a suite that already fails is never mutated, so a kill cannot be a pre-existing failure", async () => {
    write("target.js", "module.exports = {\n  one: () => 9,\n};\n");
    const before = fs.readFileSync(targetPath());
    const result = await runSpec({ find: "() => 9", replace: "() => 8" });
    expect(result.outcome).toBe("BASELINE_FAILED");
    expect(result.mutatedExit).toBeUndefined();
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
  });

  test("matches multi-line find text against a CRLF file and restores the CRLF bytes", async () => {
    write("target.js", "module.exports = {\r\n  one: () => 1,\r\n  two: () => 2,\r\n};\r\n");
    const before = fs.readFileSync(targetPath());
    const result = await runSpec({ find: "  one: () => 1,\n  two: () => 2,", replace: "  one: () => 2,\n  two: () => 2," });
    expect(result.outcome).toBe("KILLED");
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
  });

  test("restores the file even when the test runner itself throws", async () => {
    const before = fs.readFileSync(targetPath());
    let calls = 0;
    await expect(runMutation({
      repoRoot: dir, spec: spec(), ledgerPath, git: () => null,
      run: () => { calls += 1; if (calls === 2) throw new Error("runner crashed"); return { exitCode: 0, output: "" }; },
    })).rejects.toThrow(/runner crashed/);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
  });

  // Property: a mutant whose test run hangs is reported as TIMED_OUT, never as a
  // kill, and the file is restored byte-exact regardless. Oracle: an injected
  // runner that reports a timeout with the expected failure text already in its
  // partial output, which a naive kill check would have accepted.
  test("a hung test run is a timeout, not a kill, and the file still comes back byte-exact", async () => {
    const before = fs.readFileSync(targetPath());
    let calls = 0;
    const result = await runMutation({
      repoRoot: dir, spec: spec({ mustFail: ["one is one"] }), ledgerPath, git: () => null,
      run: (command, cwd, timeoutMs) => {
        calls += 1;
        expect(timeoutMs).toBe(10 * 60 * 1_000);
        return calls === 1 ? { exitCode: 0, timedOut: false, output: "" } : { exitCode: -1, timedOut: true, output: "  ● one is one\n" };
      },
    });
    expect(result.outcome).toBe("TIMED_OUT");
    expect(result.mutatedExit).toBe(-1);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
  });

  test("a spec may shorten the timeout, and a baseline that hangs is a baseline failure that names the timeout", async () => {
    const result = await runMutation({
      repoRoot: dir, spec: spec({ timeoutMs: 1_500 }), ledgerPath, git: () => null,
      run: (command, cwd, timeoutMs) => ({ exitCode: -1, timedOut: timeoutMs === 1_500, output: "" }),
    });
    expect(result).toMatchObject({ outcome: "BASELINE_FAILED", baselineTimedOut: true });
    expect(() => validateSpec({ ...spec(), timeoutMs: 0 })).toThrow(/timeoutMs must be a positive safe integer/);
  });

  // Property: a command that outlives its timeout is killed as a whole process
  // tree, so the grandchild the shell spawned does not linger (the hang that
  // left mutated files on disk twice before this existed). Oracle: the hung
  // child writes a pid file; after the run that pid must not be alive.
  test("the real runner kills a command that outlives its timeout, grandchildren included", async () => {
    write("hang.js", 'require("node:fs").writeFileSync("hang.pid", String(process.pid)); setInterval(() => {}, 1000);\n');
    const startedAt = Date.now();
    const result = await runMutation({
      repoRoot: dir, spec: spec({ command: ["node", "hang.js"], timeoutMs: 1_500 }), ledgerPath, git: () => null,
    });
    expect(result.outcome).toBe("BASELINE_FAILED");
    expect(result.baselineTimedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const hungPid = Number(fs.readFileSync(path.join(dir, "hang.pid"), "utf8"));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
    for (let attempt = 0; attempt < 50 && alive(hungPid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(hungPid)).toBe(false);
  }, 15_000);

  test("recognises vitest failure lines as well as jest's, so a browser-side mutation can name the test that killed it", () => {
    const output = [
      "   × the view path is cheaper 6ms",
      " FAIL  src/lib/chart/tests/markerSelectionScale.test.ts > marker selection at the cap > the view path is cheaper",
      "      2| it(\"the view path is cheaper\", () => {",
      "  ● jest style › also still seen",
      "FAILED test_python_style",
      "   ✓ a passing one 3ms",
      " PASS  src/other.test.ts",
    ].join("\n");
    expect(failureLines(output)).toEqual([
      "× the view path is cheaper 6ms",
      "FAIL  src/lib/chart/tests/markerSelectionScale.test.ts > marker selection at the cap > the view path is cheaper",
      "● jest style › also still seen",
      "FAILED test_python_style",
    ]);
  });

  test("refuses find text that is absent or ambiguous, touching neither the file nor the ledger", async () => {
    const before = fs.readFileSync(targetPath());
    await expect(runSpec({ find: "() => 42", replace: "() => 43" })).rejects.toThrow(/not found/);
    await expect(runSpec({ find: "=>", replace: "->" })).rejects.toThrow(/more than once/);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  test("passes arguments that contain spaces or quotes to the test command intact", async () => {
    write("args-check.js", [
      'const [, , first, second] = process.argv;',
      'const t = require("./target.js");',
      'if (first !== "two words" || second !== \'say "hi"\') { console.log("  ● arguments were split or altered: " + JSON.stringify([first, second])); process.exit(1); }',
      'if (t.one() !== 1) { console.log("  ● one returns 1"); process.exit(1); }',
      "",
    ].join("\n"));
    const result = await runSpec({ command: ["node", "args-check.js", "two words", 'say "hi"'] });
    expect(result).toMatchObject({ outcome: "KILLED", baselineExit: 0, mutatedExit: 1 });
    expect(result.observedFailures).toEqual(["● one returns 1"]);
  });

  test("quotes only what needs quoting", async () => {
    expect(quoteArgument("test/scripts/bench/ws.test.js")).toBe("test/scripts/bench/ws.test.js");
    expect(quoteArgument("C:\\repo\\a.js")).toBe("C:\\repo\\a.js");
    expect(quoteArgument("a slow client")).toBe('"a slow client"');
    expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("validates spec shape", async () => {
    expect(() => validateSpec(spec({ id: "Bad Id" }))).toThrow(/slug/);
    expect(() => validateSpec(spec({ replace: "() => 1" }))).toThrow(/different from find/);
    expect(() => validateSpec(spec({ command: [] }))).toThrow(/command/);
    expect(() => validateSpec(spec({ mustFail: [""] }))).toThrow(/mustFail/);
    expect(validateSpec(spec({ mustFail: undefined })).mustFail).toEqual([]);
  });

  test("refuses a find or replace with a carriage return", async () => {
    expect(() => validateSpec(spec({ find: "() => 1;\r\n", replace: "() => 2;\n" }))).toThrow(/carriage return/);
    expect(() => validateSpec(spec({ find: "() => 1;\n", replace: "() => 2;\r\n" }))).toThrow(/carriage return/);
    expect(() => validateSpec(spec({ find: "() => 1;\r", replace: "() => 2;" }))).toThrow(/carriage return/);
    expect(validateSpec(spec({ find: "() => 1;\n", replace: "() => 2;\n" })).find).toBe("() => 1;\n");
  });

  test("extracts jest and pytest failure headings only, deduplicated", async () => {
    expect(failureLines("  ● suite › does a thing\nnoise\n  ● suite › does a thing\nFAILED tests/test_x.py::test_y - assert 1 == 2\n"))
      .toEqual(["● suite › does a thing", "FAILED tests/test_x.py::test_y - assert 1 == 2"]);
  });

  test("measures a command's clean run once and reuses it for every mutant that shares the command", async () => {
    const commands = [];
    const run = (command) => {
      commands.push(command.join(" "));
      const mutated = fs.readFileSync(targetPath(), "utf8") !== "module.exports = {\n  one: () => 1,\n  two: () => 2,\n};\n";
      return { exitCode: mutated ? 1 : 0, timedOut: false, output: mutated ? "  ● one returns 1\n" : "" };
    };
    const baselines = new Map();
    const first = await runMutation({ repoRoot: dir, spec: spec(), ledgerPath, git: () => null, run, baselines });
    const second = await runMutation({ repoRoot: dir, spec: spec({ id: "two-changes", find: "() => 2", replace: "() => 3" }), ledgerPath, git: () => null, run, baselines });
    expect([first.outcome, second.outcome]).toEqual(["KILLED", "KILLED"]);
    expect(commands).toHaveLength(3);
    expect(ledger().map((entry) => entry.baselineExit)).toEqual([0, 0]);
    expect(ledger()[1].baselineMs).toBe(ledger()[0].baselineMs);
  });

  test("a run killed mid-mutant leaves a journal, and the next run puts the file back unless it was edited since", async () => {
    const before = fs.readFileSync(targetPath());
    const journalDir = path.join(dir, ".mutation-inflight");
    let seen = null;
    await runMutation({
      repoRoot: dir, spec: spec(), ledgerPath, git: () => null, journalDir,
      run: (command, cwd) => {
        if (fs.readFileSync(targetPath()).equals(before)) return { exitCode: 0, output: "" };
        seen = fs.readdirSync(journalDir).map((name) => JSON.parse(fs.readFileSync(path.join(journalDir, name), "utf8")));
        fs.copyFileSync(path.join(journalDir, fs.readdirSync(journalDir)[0]), path.join(cwd, "kept-journal.json"));
        return { exitCode: 1, output: "  ● one returns 1\n" };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ target: targetPath(), originalBase64: before.toString("base64") });
    expect(fs.readdirSync(journalDir)).toEqual([]);

    const mutant = fs.readFileSync(targetPath(), "utf8").replace("() => 1", "() => 2");
    fs.writeFileSync(targetPath(), mutant);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "kept-journal.json"), "utf8"));
    expect(kept.pid).toBe(process.pid);
    fs.writeFileSync(path.join(dir, "kept-journal.json"), JSON.stringify({ ...kept, pid: childProcess.spawnSync(process.execPath, ["-e", "0"]).pid }));
    fs.copyFileSync(path.join(dir, "kept-journal.json"), path.join(journalDir, "left.json"));
    expect(recoverInterrupted(journalDir)).toEqual([targetPath()]);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);

    fs.writeFileSync(targetPath(), "an edit made after the crash\n");
    fs.copyFileSync(path.join(dir, "kept-journal.json"), path.join(journalDir, "left.json"));
    expect(recoverInterrupted(journalDir)).toEqual([]);
    expect(fs.readFileSync(targetPath(), "utf8")).toBe("an edit made after the crash\n");
    expect(fs.readdirSync(journalDir)).toEqual([]);
  });

  test("recovery leaves a journal alone while the run that wrote it is still alive, so a second run cannot undo a live mutant", () => {
    const journalDir = path.join(dir, ".mutation-inflight");
    fs.mkdirSync(journalDir, { recursive: true });
    const before = fs.readFileSync(targetPath());
    const mutant = Buffer.from(before.toString("utf8").replace("() => 1", "() => 2"));
    fs.writeFileSync(targetPath(), mutant);
    const entry = (pid) => JSON.stringify({ target: targetPath(), originalBase64: before.toString("base64"), mutantSha256: require("node:crypto").createHash("sha256").update(mutant).digest("hex"), pid });
    const live = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(path.join(journalDir, "live.json"), entry(live.pid));
      expect(recoverInterrupted(journalDir)).toEqual([]);
      expect(fs.readFileSync(targetPath()).equals(mutant)).toBe(true);
      expect(fs.readdirSync(journalDir)).toEqual(["live.json"]);
    } finally {
      live.kill("SIGKILL");
    }
    const gone = childProcess.spawnSync(process.execPath, ["-e", "0"]).pid;
    fs.writeFileSync(path.join(journalDir, "live.json"), entry(gone));
    expect(recoverInterrupted(journalDir)).toEqual([targetPath()]);
    expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
  });

  test("runs npx bins directly with this Node, except on Windows or when no bin is found", () => {
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    write("node_modules/.bin/tool", "#!/usr/bin/env node\n");
    const nested = path.join(dir, "apps", "web");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveCommand(["npx", "tool", "run", "a b"], nested, "linux")).toEqual([process.execPath, fs.realpathSync(path.join(bin, "tool")), "run", "a b"]);
    expect(resolveCommand(["npx", "tool", "run"], nested, "win32")).toEqual(["npx", "tool", "run"]);
    expect(resolveCommand(["npx", "absent", "run"], nested, "linux")).toEqual(["npx", "absent", "run"]);
    expect(resolveCommand(["npx", "--yes", "tool"], nested, "linux")).toEqual(["npx", "--yes", "tool"]);
    expect(resolveCommand(["node", "check.js"], nested, "linux")).toEqual([process.execPath, "check.js"]);
  });

  test("reads the pinned Node from the repository's engines field", () => {
    write("package.json", JSON.stringify({ engines: { node: "24.21.0" } }));
    expect(requiredNode(dir)).toBe("24.21.0");
    write("package.json", JSON.stringify({}));
    expect(requiredNode(dir)).toBeNull();
  });

  test("compacting keeps each mutant's latest run whatever the line order (as a union merge leaves it), the later line on a tie, and lines it cannot read", () => {
    const line = (id, atUtc, outcome) => JSON.stringify({ id, atUtc, outcome });
    fs.writeFileSync(ledgerPath, [
      line("b", "2026-09-02T00:00:00.000Z", "KILLED"),
      line("a", "2026-09-03T00:00:00.000Z", "KILLED"),
      "not json",
      line("b", "2026-09-01T00:00:00.000Z", "SURVIVED"),
      line("a", "2026-09-03T00:00:00.000Z", "SURVIVED"),
      "",
    ].join("\r\n"));
    expect(compactLedger(ledgerPath)).toEqual({ lines: 5, kept: 3 });
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(`${line("a", "2026-09-03T00:00:00.000Z", "SURVIVED")}\n${line("b", "2026-09-02T00:00:00.000Z", "KILLED")}\nnot json\n`);
    expect(compactLedger(path.join(dir, "absent.jsonl"))).toBeNull();
  });

  test("the ledger lock of a process that is gone is taken over; the lock is released after", () => {
    const gone = childProcess.spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(ledgerPath, `${JSON.stringify({ id: "a", atUtc: "2026-09-01T00:00:00.000Z" })}\n`);
    fs.writeFileSync(`${ledgerPath}.lock`, String(gone));
    expect(compactLedger(ledgerPath)).toEqual({ lines: 1, kept: 1 });
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  describe("runSpecs", () => {
    const git = (args, cwd = dir) => childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
    const specFile = (name, mutations) => {
      write(name, JSON.stringify({ mutations }));
      return path.join(dir, name);
    };
    const lines = [];
    const out = (line) => lines.push(line);

    beforeEach(() => {
      lines.length = 0;
      git(["init", "-q"]);
      git(["add", "-A"]);
    });

    test("runs on worker copies, so the checkout never holds a mutant, and every mutant is reported", async () => {
      const before = fs.readFileSync(targetPath());
      const roots = [];
      const file = specFile("specs.json", [spec(), spec({ id: "two-is-untested", find: "() => 2", replace: "() => 3" })]);
      const summary = await runSpecs({
        files: [file], repoRoot: dir, ledgerPath, workers: 2, git: () => null, out,
        workerRoot: () => {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-worker-test-"));
          roots.push(root);
          return root;
        },
        run: async (command, cwd) => {
          expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
          expect(roots.some((root) => cwd.startsWith(root))).toBe(true);
          const result = childProcess.spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8" });
          return { exitCode: result.status, timedOut: false, output: result.stdout };
        },
      });
      expect(summary).toMatchObject({ total: 2, allKilled: false });
      expect(summary.counts).toEqual({ KILLED: 1, SURVIVED: 1 });
      expect(lines.filter((line) => /^(KILLED|SURVIVED) /.test(line)).sort()).toEqual([
        `${"KILLED".padEnd(26)} one-returns-one`, `${"SURVIVED".padEnd(26)} two-is-untested`,
      ]);
      expect(ledger().map((entry) => entry.id).sort()).toEqual(["one-returns-one", "two-is-untested"]);
      expect(roots).toHaveLength(2);
      for (const root of roots) expect(fs.existsSync(root)).toBe(false);
      expect(fs.readFileSync(targetPath()).equals(before)).toBe(true);
    });

    test("folds the ledger to the latest run of each mutant, sorted by id, after the run", async () => {
      fs.writeFileSync(ledgerPath, [
        JSON.stringify({ id: "zz-retired", atUtc: "2026-01-01T00:00:00.000Z", outcome: "KILLED" }),
        JSON.stringify({ id: "one-returns-one", atUtc: "2026-01-01T00:00:00.000Z", outcome: "SURVIVED" }),
        "",
      ].join("\n"));
      await runSpecs({ files: [specFile("specs.json", [spec()])], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out, now: () => new Date("2026-09-20T00:00:00.000Z") });
      expect(ledger().map((entry) => [entry.id, entry.outcome])).toEqual([["one-returns-one", "KILLED"], ["zz-retired", "KILLED"]]);
      expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
    });

    test("in place, every mutant run is counted in the total, so a run that kills them all says so", async () => {
      const file = specFile("specs.json", [spec()]);
      const summary = await runSpecs({ files: [file], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out, inPlace: true });
      expect(summary).toMatchObject({ total: 1, allKilled: true, counts: { KILLED: 1 } });
      expect(lines.at(-1)).toMatch(/^mutation-check: 1 mutants in /);
    });

    test("a stale mutant is reported and skipped; the mutants after it still run", async () => {
      const file = specFile("specs.json", [spec({ id: "gone", find: "() => 42", replace: "() => 43" }), spec()]);
      const summary = await runSpecs({ files: [file], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out });
      expect(summary.counts).toEqual({ STALE: 1, KILLED: 1 });
      expect(lines.some((line) => line.startsWith("STALE") && line.includes("gone (find text not found"))).toBe(true);
      expect(ledger().map((entry) => entry.id)).toEqual(["one-returns-one"]);
    });

    test("a mutant whose file is gone is stale, a mutant whose run breaks is an error, and neither stops the others", async () => {
      const file = specFile("specs.json", [
        spec({ id: "file-gone", file: "deleted.js" }),
        spec({ id: "runner-breaks" }),
        spec({ id: "still-runs", find: "() => 2", replace: "() => 3" }),
      ]);
      let calls = 0;
      const summary = await runSpecs({
        files: [file], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out,
        run: (command, cwd) => {
          calls += 1;
          if (calls === 2) throw new Error("runner crashed");
          const result = childProcess.spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8" });
          return { exitCode: result.status, timedOut: false, output: result.stdout };
        },
      });
      expect(summary).toMatchObject({ total: 3, allKilled: false, counts: { STALE: 1, ERROR: 1, SURVIVED: 1 } });
      expect(lines.some((line) => line.startsWith("STALE") && line.includes("file-gone (target file not found: deleted.js)"))).toBe(true);
      expect(lines.some((line) => line.startsWith("ERROR") && line.includes("runner-breaks (runner crashed)"))).toBe(true);
    });

    test("--only picks mutants by id, and a progress file skips the ones already killed", async () => {
      const file = specFile("specs.json", [spec(), spec({ id: "two-is-untested", find: "() => 2", replace: "() => 3" })]);
      const progress = path.join(dir, "progress.jsonl");
      const first = await runSpecs({ files: [file], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out, progress, only: new Set(["one-returns-one"]) });
      expect(first.total).toBe(1);
      const second = await runSpecs({ files: [file], repoRoot: dir, ledgerPath, workers: 1, git: () => null, out, progress });
      expect(second).toMatchObject({ total: 1, counts: { SURVIVED: 1 } });
      expect(ledger().map((entry) => entry.id)).toEqual(["one-returns-one", "two-is-untested"]);
    });

    test("a Python spec runs in the checkout, never on a copy", async () => {
      expect(runsInPlace({ command: ["uv", "run", "pytest"] })).toBe(true);
      expect(runsInPlace({ command: ["C:\\Python\\python.exe", "-m", "pytest"] })).toBe(true);
      expect(runsInPlace({ command: ["npx", "vitest", "run"] })).toBe(false);
      const file = specFile("specs.json", [spec({ command: ["python3", "check.py"] })]);
      const cwds = [];
      await runSpecs({
        files: [file], repoRoot: dir, ledgerPath, workers: 3, git: () => null, out,
        workerRoot: () => { throw new Error("no copy is needed"); },
        run: (command, cwd) => {
          cwds.push(cwd);
          return { exitCode: 0, output: "" };
        },
      });
      expect(cwds).toEqual([dir, dir]);
    });
  });

  test("a worker copy holds edits not yet committed and new files, and its workspace links resolve inside the copy", () => {
    const git = (args) => childProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q"]);
    write(".gitignore", "node_modules/\n");
    fs.mkdirSync(path.join(dir, "apps", "lib"), { recursive: true });
    write("apps/lib/index.js", "module.exports = 'committed';\n");
    git(["add", "-A"]);
    write("apps/lib/index.js", "module.exports = 'edited';\n");
    write("apps/lib/new.js", "module.exports = 'new';\n");
    fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    write("node_modules/dep/index.js", "module.exports = 'shared';\n");
    fs.mkdirSync(path.join(dir, "node_modules", "@scope"), { recursive: true });
    fs.symlinkSync(process.platform === "win32" ? path.join(dir, "apps", "lib") : path.join("..", "..", "apps", "lib"),
      path.join(dir, "node_modules", "@scope", "lib"), process.platform === "win32" ? "junction" : "dir");
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-copy-"));
    try {
      prepareWorkerTree(dir, copy);
      expect(fs.readFileSync(path.join(copy, "apps/lib/index.js"), "utf8")).toBe("module.exports = 'edited';\n");
      expect(fs.existsSync(path.join(copy, "apps/lib/new.js"))).toBe(true);
      expect(fs.realpathSync(path.join(copy, "node_modules", "@scope", "lib"))).toBe(fs.realpathSync(path.join(copy, "apps", "lib")));
      expect(fs.realpathSync(path.join(copy, "node_modules", "dep"))).toBe(fs.realpathSync(path.join(dir, "node_modules", "dep")));
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
    expect(fs.readFileSync(path.join(dir, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 'shared';\n");
  });

  test("parses the options and refuses what it does not know", () => {
    expect(parseArgs(["a.json", "b.json", "--workers", "3", "--only", "x, y", "--in-place"])).toMatchObject({
      files: ["a.json", "b.json"], workers: 3, inPlace: true, only: new Set(["x", "y"]),
    });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["a.json", "--workers", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["a.json", "--fast"])).toThrow(/unknown option/);
  });
});
