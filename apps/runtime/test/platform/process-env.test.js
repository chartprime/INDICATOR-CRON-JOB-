const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadProcessEnv, bootProcess } = require("../../src/platform/process-env");

const OPERATOR_SECRETS = {
  TT_QUERY_S3_ACCESS_KEY_ID: "query-key",
  TT_QUERY_S3_SECRET_ACCESS_KEY: "query-secret",
  TT_QUERY_SERVICE_SECRET: "service-secret",
  RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID: "convert-key",
  RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY: "convert-secret",
  TT_ARCHIVE_CLIENT_TOKENS: "owner:token",
  TT_LIVE_STORAGE_SERVICE_SECRET: "storage-secret",
  DXFEED_TEMP_TOKEN: "aaa.bbb",
  databento_key: "provider-key",
  tardis_key: "provider-key-2",
};

function envFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return { dir, file };
}

describe("loadProcessEnv (least privilege, O-14)", () => {
  let fixture;
  afterEach(() => {
    if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
    fixture = null;
  });

  test("Terminal C takes only its own settings from a shared .env that also holds operator secrets", () => {
    fixture = envFile([
      "TT_LIVE_STORAGE_SERVICE_URL=http://10.88.0.1:8001/live-storage",
      "TT_LIVE_STORAGE_CLIENT_TOKEN=bearer",
      "L2_HEATMAP_DEEP_S=39600",
      "L2_HEATMAP_DEEPS=1",
      ...Object.entries(OPERATOR_SECRETS).map(([name, value]) => `${name}=${value}`),
    ]);
    const env = {};
    const result = loadProcessEnv("terminal-c", { file: fixture.file, env });

    expect(Object.keys(env).sort()).toEqual(["L2_HEATMAP_DEEP_S", "TT_LIVE_STORAGE_CLIENT_TOKEN", "TT_LIVE_STORAGE_SERVICE_URL"]);
    for (const name of Object.keys(OPERATOR_SECRETS)) expect(env).not.toHaveProperty(name);
    expect([...result.ignored].sort()).toEqual(Object.keys(OPERATOR_SECRETS).sort());
    expect(result.unknown).toEqual(["L2_HEATMAP_DEEPS"]);
  });

  test("a value already in the environment wins over the file, as with node --env-file", () => {
    fixture = envFile(["L2_HEATMAP_DEEP_S=39600"]);
    const env = { L2_HEATMAP_DEEP_S: "0" };
    const result = loadProcessEnv("terminal-c", { file: fixture.file, env });
    expect(env.L2_HEATMAP_DEEP_S).toBe("0");
    expect(result.loaded).toEqual([]);
  });

  test("no .env is not an error", () => {
    const env = {};
    const result = loadProcessEnv("terminal-c", { file: path.join(os.tmpdir(), "no-such-dir-process-env", ".env"), env });
    expect(result.present).toBe(false);
    expect(env).toEqual({});
  });
});

describe("bootProcess", () => {
  test("does nothing when the module is imported rather than run", () => {
    const exit = jest.fn();
    expect(bootProcess("terminal-c", { isMain: false, env: { L2_HEATMAP_DEEP_S: "x" }, exit })).toBeNull();
    expect(exit).not.toHaveBeenCalled();
  });

  test("exits 1 with the setting named, and passes a valid environment", () => {
    const writes = [];
    const stderr = { write: (text) => writes.push(text) };
    const exit = jest.fn();
    bootProcess("gateway", { isMain: true, env: { TT_ARCHIVE_GATEWAY_PORT: "70000" }, stderr, exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(writes.join("")).toContain("config: TT_ARCHIVE_GATEWAY_PORT must be a whole number, above 0, at most 65535");

    const exitOk = jest.fn();
    bootProcess("gateway", { isMain: true, env: { TT_ARCHIVE_GATEWAY_PORT: "8001" }, stderr, exit: exitOk });
    expect(exitOk).not.toHaveBeenCalled();
  });
});
