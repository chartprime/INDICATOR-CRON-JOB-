const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RUNTIME_ROOT, dataRoot, logDir, runtimeDir } = require("../../src/platform/runtime-paths");

// Derived from this test file's own location, independently of the module.
const EXPECTED_RUNTIME_ROOT = path.resolve(__dirname, "..", "..");

describe("runtime-paths", () => {
  const saved = {};
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    saved.TT_DATA_ROOT = process.env.TT_DATA_ROOT;
    saved.TT_LOG_DIR = process.env.TT_LOG_DIR;
    saved.TT_RUNTIME_DIR = process.env.TT_RUNTIME_DIR;
    delete process.env.TT_DATA_ROOT;
    delete process.env.TT_LOG_DIR;
    delete process.env.TT_RUNTIME_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-"));
    tmpFile = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(tmpFile, "x");
  });

  afterEach(() => {
    for (const key of ["TT_DATA_ROOT", "TT_LOG_DIR", "TT_RUNTIME_DIR"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("unset env falls back to the checkout data/ and logs/ directories", () => {
    expect(RUNTIME_ROOT).toBe(EXPECTED_RUNTIME_ROOT);
    expect(dataRoot()).toBe(path.join(EXPECTED_RUNTIME_ROOT, "data"));
    expect(logDir()).toBe(path.join(EXPECTED_RUNTIME_ROOT, "logs"));
    // Existence is deliberately not asserted. Both directories are gitignored,
    // so they are absent from a clean checkout, and unlike runtimeDir this
    // fallback does not create them -- see the runtimeDir test below. Asserting
    // it passed only on a machine that had already run the app, and failed the
    // suite on a fresh checkout of the host.
    expect(path.isAbsolute(dataRoot())).toBe(true);
    expect(path.isAbsolute(logDir())).toBe(true);
  });

  test("an empty env value is treated as unset", () => {
    process.env.TT_DATA_ROOT = "";
    expect(dataRoot()).toBe(path.join(EXPECTED_RUNTIME_ROOT, "data"));
  });

  test("an existing absolute directory is honoured verbatim", () => {
    process.env.TT_DATA_ROOT = tmpDir;
    process.env.TT_LOG_DIR = tmpDir;
    expect(dataRoot()).toBe(tmpDir);
    expect(logDir()).toBe(tmpDir);
  });

  test("a relative path is rejected", () => {
    process.env.TT_DATA_ROOT = "relative/data";
    expect(() => dataRoot()).toThrow(/absolute path/);
  });

  test("a non-existent absolute path is rejected", () => {
    process.env.TT_LOG_DIR = path.join(tmpDir, "missing", "deeper");
    expect(() => logDir()).toThrow(/not accessible/);
  });

  test("an absolute path that is a file, not a directory, is rejected", () => {
    process.env.TT_DATA_ROOT = tmpFile;
    expect(() => dataRoot()).toThrow(/existing directory/);
  });

  test("runtimeDir falls back to a local run/ dir and creates it, unlike dataRoot/logDir", () => {
    const expected = path.join(EXPECTED_RUNTIME_ROOT, "run");
    fs.rmSync(expected, { recursive: true, force: true });
    expect(runtimeDir()).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  test("runtimeDir honours an existing configured directory verbatim", () => {
    process.env.TT_RUNTIME_DIR = tmpDir;
    expect(runtimeDir()).toBe(tmpDir);
  });

  test("runtimeDir rejects a configured path that does not exist, same as dataRoot/logDir", () => {
    process.env.TT_RUNTIME_DIR = path.join(tmpDir, "missing");
    expect(() => runtimeDir()).toThrow(/not accessible/);
  });
});
