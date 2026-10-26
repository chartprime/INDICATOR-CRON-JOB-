const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../../helpers/temp-files");
const {
  parseArgs,
  DEFAULT_EVENTS_PER_TUPLE,
  DEFAULT_DEPTH_EVENTS,
  DEFAULT_NOMINAL_EVENTS_PER_SECOND,
} = require("../../../scripts/qualify/qualify-collector-storage");

// 262 lines of operational tooling with no test file at all before A2.19.
// The argument surface is what a human types at 2am against a real database,
// so a mis-parse is not a cosmetic problem.

describe("qualify-collector-storage parseArgs", () => {
  test("returns the documented defaults for no arguments", () => {
    expect(parseArgs([])).toEqual({
      eventsPerTuple: DEFAULT_EVENTS_PER_TUPLE,
      depthEvents: DEFAULT_DEPTH_EVENTS,
      nominalEventsPerSecond: DEFAULT_NOMINAL_EVENTS_PER_SECOND,
      existingDb: null,
      keepSyntheticDb: false,
    });
  });

  test("parses every numeric flag", () => {
    const options = parseArgs([
      "--events-per-tuple", "10",
      "--depth-events", "20",
      "--nominal-events-per-second", "30",
    ]);
    expect(options).toMatchObject({ eventsPerTuple: 10, depthEvents: 20, nominalEventsPerSecond: 30 });
  });

  test("parses the keep-synthetic-db flag, which takes no value", () => {
    expect(parseArgs(["--keep-synthetic-db"]).keepSyntheticDb).toBe(true);
  });

  test("rejects an unsupported argument instead of ignoring it", () => {
    // Silently ignoring a typo would run the qualification with settings the
    // operator did not ask for and report a pass.
    expect(() => parseArgs(["--evnets-per-tuple", "10"])).toThrow(/unsupported argument/);
    expect(() => parseArgs(["10"])).toThrow(/unsupported argument/);
  });

  test("rejects non-positive, fractional and non-numeric counts", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parseArgs(["--events-per-tuple", bad])).toThrow(/positive safe integer/);
    }
  });

  test("rejects a numeric flag left dangling at the end of the argument list", () => {
    expect(() => parseArgs(["--depth-events"])).toThrow(/positive safe integer/);
    expect(() => parseArgs(["--nominal-events-per-second"])).toThrow(/positive safe integer/);
  });

  test("rejects --existing-db without a path", () => {
    expect(() => parseArgs(["--existing-db"])).toThrow(/requires a file path/);
  });

  test("rejects an --existing-db path that does not exist", () => {
    const missing = path.join(os.tmpdir(), `qualify-missing-${Date.now()}.sqlite`);
    expect(() => parseArgs(["--existing-db", missing])).toThrow(/must be an existing file/);
  });

  test("rejects an --existing-db that is a directory rather than a file", () => {
    expect(() => parseArgs(["--existing-db", os.tmpdir()])).toThrow(/must be an existing file/);
  });

  test("resolves --existing-db to an absolute path", () => {
    const file = path.join(os.tmpdir(), `qualify-real-${Date.now()}.sqlite`);
    fs.writeFileSync(file, "");
    try {
      expect(path.isAbsolute(parseArgs(["--existing-db", file]).existingDb)).toBe(true);
    } finally {
      safeRm(file);
    }
  });

  test("the returned options are frozen, so a later stage cannot rewrite what was requested", () => {
    const options = parseArgs([]);
    expect(Object.isFrozen(options)).toBe(true);
  });
});
