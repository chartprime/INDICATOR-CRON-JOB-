"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanStale, matchCount } = require("../../../scripts/verify/mutation-stale");

describe("scripts/verify/mutation-stale", () => {
  let dir;
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const git = (...args) => childProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const mutant = (id, find, file = "src/a.js") => ({ id, file, find, replace: "x", command: ["node", "t.js"] });
  const specs = (mutations) => write("benchmarks/mutations/a.json", JSON.stringify({ mutations }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-stale-"));
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    write("src/a.js", "const one = 1;\nconst two = 2;\nconst gone = 0;\n");
    specs([mutant("one", "const one = 1;"), mutant("old-stale", "const three = 3;"), mutant("will-break", "const gone = 0;")]);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("tag", "base");
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("lists every mutant whose find text does not occur exactly once", () => {
    write("src/a.js", "const one = 1;\nconst one = 1;\n");
    expect(scanStale({ repoRoot: dir }).stale.map((entry) => [entry.id, entry.matches])).toEqual([
      ["one", 2], ["old-stale", 0], ["will-break", 0],
    ]);
  });

  test("against a base, blocks only what the branch broke or added stale; what was stale before is reported, not blocking", () => {
    write("src/a.js", "const one = 1;\nconst two = 2;\n");
    specs([mutant("one", "const one = 1;"), mutant("old-stale", "const three = 3;"), mutant("will-break", "const gone = 0;"), mutant("new-one", "const four = 4;")]);
    const { stale, blocking } = scanStale({ repoRoot: dir, base: "base" });
    expect(stale.map((entry) => [entry.id, entry.cause])).toEqual([
      ["old-stale", "pre-existing"], ["will-break", "broken"], ["new-one", "new-stale"],
    ]);
    expect(blocking.map((entry) => entry.id)).toEqual(["will-break", "new-one"]);
  });

  test("a mutant retargeted to text that does not match is new-stale, and one pointed at a missing file says so", () => {
    specs([mutant("one", "const one = 11;"), mutant("old-stale", "const three = 3;"), mutant("will-break", "const gone = 0;", "src/missing.js")]);
    const { blocking } = scanStale({ repoRoot: dir, base: "base" });
    expect(blocking.map((entry) => [entry.id, entry.cause, entry.matches])).toEqual([["one", "new-stale", 0], ["will-break", "new-stale", null]]);
  });

  test("counts a multi-line find against a CRLF file the way the mutation check matches it", () => {
    expect(matchCount("a\r\nb\r\nc\r\n", "a\nb")).toBe(1);
    expect(matchCount("a\nb\n", "a\nb")).toBe(1);
    expect(matchCount("ab ab", "ab")).toBe(2);
    expect(matchCount(null, "a")).toBeNull();
  });

  test("refuses a base it cannot resolve", () => {
    expect(() => scanStale({ repoRoot: dir, base: "no-such-ref" })).toThrow(/cannot compare with no-such-ref/);
  });
});
