const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  CONFIG_REGISTRY, PROCESSES, MAX_WIRE_MAGNITUDE, validateProcessEnv, assertProcessEnv, valueIsValid,
} = require("../../src/platform/config-registry");
const { liquidityOptionsFromEnv } = require("../../src/indicators/passive_liquidity/liquidity-publisher");
const { assertBrokerUrl } = require("../../src/providers/dxfeed/token-broker-client");
const { MAX_WIRE_MAGNITUDE: WIRE_MAGNITUDE } = require("../../src/server/wire-fields");

const RUNTIME_ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_NAMES = new Set(["LOCALAPPDATA", "ProgramFiles", "PATH", "NODE_ENV", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "HOME"]);
const byName = new Map(CONFIG_REGISTRY.map((item) => [item.name, item]));

function sourceFiles(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".venv", ".pytest_cache", "__pycache__", "tests", "test"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

function namesReadByCode() {
  const names = new Set();
  const js = [...sourceFiles(path.join(RUNTIME_ROOT, "src"), [".js"]), ...sourceFiles(path.join(RUNTIME_ROOT, "scripts"), [".js", ".cjs"])];
  for (const file of js) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:process\.env|env|environment|childEnv)\??(?:\.([A-Za-z_][A-Za-z0-9_]*)|\["([A-Za-z_][A-Za-z0-9_]*)"\])/g)) {
      const name = match[1] ?? match[2];
      if (/^[A-Z]/.test(name) || /^[a-z]+_key$/.test(name)) names.add(name);
    }
    for (const match of text.matchAll(/(?:readPositiveInt|resolveConfiguredDir)\(\s*"([A-Z_][A-Z0-9_]*)"/g)) names.add(match[1]);
  }
  for (const file of sourceFiles(path.join(RUNTIME_ROOT, "conversion"), [".py"])) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:os\.environ\.get|os\.environ\[|getenv|positive_env)\(?\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) names.add(match[1]);
  }
  for (const name of SYSTEM_NAMES) names.delete(name);
  return names;
}

describe("config registry inventory", () => {
  test("every setting the runtime, its scripts and the conversion code read is registered, so none can be missed by validation or the docs", () => {
    const missing = [...namesReadByCode()].filter((name) => !byName.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test("names are unique and every entry belongs to known processes with a documented kind", () => {
    expect(byName.size).toBe(CONFIG_REGISTRY.length);
    const processes = new Set(Object.values(PROCESSES));
    for (const item of CONFIG_REGISTRY) {
      expect(item.processes.length).toBeGreaterThan(0);
      for (const name of item.processes) expect(processes.has(name)).toBe(true);
      expect(typeof item.doc).toBe("string");
      expect(item.doc.length).toBeGreaterThan(0);
    }
  });

  test("the aggressive floors are capped by the wire's own magnitude", () => {
    expect(MAX_WIRE_MAGNITUDE).toBe(WIRE_MAGNITUDE);
  });
});

describe("validator agrees with the parsers it guards", () => {
  test("L2_ICEBERG_FILL_DELAY_S: 0 fills at once, accepted by the validator as by the parser; a negative or non-number value is refused by both", () => {
    const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
    const item = byName.get("L2_ICEBERG_FILL_DELAY_S");
    for (const [value, ms] of [["0", 0], ["120", 120_000], ["0.5", 500]]) {
      expect(valueIsValid(item, value)).toBe(true);
      expect(icebergOptionsFromEnv({ L2_ICEBERG_FILL_DELAY_S: value }).hostFillDelayMs).toBe(ms);
    }
    for (const value of ["-1", "soon"]) {
      expect(valueIsValid(item, value)).toBe(false);
      expect(icebergOptionsFromEnv({ L2_ICEBERG_FILL_DELAY_S: value })).not.toHaveProperty("hostFillDelayMs");
    }
  });

  const heatmapCases = [
    ["L2_HEATMAP_ROW_BP", "rowBp", ["0.25", "2"], ["0", "-1", "abc"]],
    ["L2_HEATMAP_WINDOW_BP", "windowBp", ["600"], ["0", "x"]],
    ["L2_HEATMAP_COLUMN_MS", "columnMs", ["1000"], ["0", "never"]],
    ["L2_HEATMAP_HISTORY_S", "historyS", ["1200"], ["-5", "abc"]],
    ["L2_HEATMAP_DEEP_S", "deepS", ["0", "39600"], ["-1", "abc", "11h"]],
    ["L2_HEATMAP_DEEP_COLUMN_MS", "deepColumnMs", ["10000"], ["0"]],
    ["L2_HEATMAP_STORE_S", "storeS", ["60"], ["0"]],
    ["L2_HEATMAP_LEVEL_MIN_USD", "levelMinUsd", ["500000"], ["-1"]],
    ["L2_HEATMAP_WALL_MULT", "wallMultiplier", ["0", "3"], ["-1", "three"]],
    ["L2_HEATMAP_REF_BP", "referenceBp", ["50"], ["0"]],
    ["L2_HEATMAP_WALL_SETTLE_MS", "wallSettleMs", ["0", "5000"], ["1.5", "-1"]],
    ["L2_HEATMAP_WALL_GAP", "wallGapRows", ["0", "2"], ["2.5", "-1"]],
    ["L2_HEATMAP_BACKFILL_MAX_S", "backfillMaxS", ["600"], ["0"]],
    ["L2_HEATMAP_DEEP_CHUNK_S", "deepChunkS", ["1200"], ["0"]],
    ["L2_HEATMAP_BACKFILL_WORKERS", "backfillWorkers", ["1", "4"], ["0", "1.5"]],
    ["L2_HEATMAP_BACKFILL_TIMEOUT_S", "backfillTimeoutS", ["300"], ["0"]],
    ["L2_HEATMAP_BACKFILL_ANNOUNCE_S", "backfillAnnounceS", ["15"], ["0"]],
    ["L2_HEATMAP_STORE_MAX_AGE_S", "storeMaxAgeS", ["604800"], ["0"]],
    ["L2_HEATMAP_STORE_MAX_BYTES", "storeMaxBytes", ["50331648"], ["0"]],
    ["L2_HEATMAP_HISTORY_FLOOR", "historyFloorMs", ["2026-09-01T00:00:00Z"], ["yesterday"]],
  ];

  test.each(heatmapCases)("%s: a value the validator accepts is used, one it refuses was silently ignored before", (name, option, good, bad) => {
    const item = byName.get(name);
    for (const value of good) {
      expect(valueIsValid(item, value)).toBe(true);
      expect(liquidityOptionsFromEnv({ [name]: value })).toHaveProperty(option);
    }
    for (const value of bad) {
      expect(valueIsValid(item, value)).toBe(false);
      expect(liquidityOptionsFromEnv({ [name]: value })).not.toHaveProperty(option);
    }
  });

  test("the broker URL check matches the token broker client's own rule", () => {
    const samples = [
      "https://broker.tail1234.ts.net", "https://broker.tail1234.ts.net/", "http://broker.tail1234.ts.net",
      "https://ts.net", "https://example.com", "https://broker.tail1234.ts.net/token", "https://user:x@broker.tail1234.ts.net",
      "https://broker.tail1234.ts.net?x=1", "not a url",
    ];
    const item = byName.get("TT_DXFEED_TOKEN_BROKER_URL");
    for (const sample of samples) {
      let accepted = true;
      try {
        assertBrokerUrl(sample);
      } catch {
        accepted = false;
      }
      expect([sample, valueIsValid(item, sample)]).toEqual([sample, accepted]);
    }
  });

  test("capacity limits accept exactly what the collectors' strict parser accepts", () => {
    const item = byName.get("TT_MAX_DB_BYTES");
    for (const value of ["429496729600", "1"]) expect(valueIsValid(item, value)).toBe(true);
    for (const value of ["0", "-1", "1e9", "400GiB", "01", "99999999999999999999"]) expect(valueIsValid(item, value)).toBe(false);
  });

  test("the spot endpoint overrides accept bare origins of their own scheme only, matching binance-config's rule", () => {
    const ws = byName.get("TT_BINANCE_SPOT_WS_BASE_URL");
    expect(valueIsValid(ws, "wss://data-stream.binance.vision:9443")).toBe(true);
    expect(valueIsValid(ws, "ws://127.0.0.1:9001")).toBe(true);
    expect(valueIsValid(ws, "https://stream.binance.com")).toBe(false);
    expect(valueIsValid(ws, "wss://stream.binance.com/stream")).toBe(false);
    expect(valueIsValid(ws, "wss://user:pw@stream.binance.com")).toBe(false);
    const rest = byName.get("TT_BINANCE_SPOT_REST_BASE_URL");
    expect(valueIsValid(rest, "https://data-api.binance.vision")).toBe(true);
    expect(valueIsValid(rest, "http://127.0.0.1:8099")).toBe(true);
    expect(valueIsValid(rest, "wss://data-api.binance.vision")).toBe(false);
    expect(valueIsValid(rest, "https://data-api.binance.vision/api")).toBe(false);
  });

  test("flags are 0 or 1 only, so TT_VPIN_ENABLED=false can no longer silently mean enabled", () => {
    const item = byName.get("TT_VPIN_ENABLED");
    expect(valueIsValid(item, "0")).toBe(true);
    expect(valueIsValid(item, "1")).toBe(true);
    expect(valueIsValid(item, "false")).toBe(false);
    expect(valueIsValid(item, "true")).toBe(false);
  });
});

describe("validateProcessEnv", () => {
  test("an empty value is unset, a bad value is an error naming the setting and its range but never the value", () => {
    const result = validateProcessEnv("terminal-c", {
      L2_HEATMAP_DEEP_S: "abc",
      L2_HEATMAP_ROW_BP: "",
      TT_LIVE_STORAGE_CLIENT_TOKEN: "secret-bearer-value",
      TT_LIVE_STORAGE_SERVICE_URL: "not-a-url-secret-looking",
    });
    expect(result.errors.map((error) => error.name).sort()).toEqual(["L2_HEATMAP_DEEP_S", "TT_LIVE_STORAGE_SERVICE_URL"]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("abc");
    expect(text).not.toContain("secret-bearer-value");
    expect(text).not.toContain("not-a-url-secret-looking");
    expect(result.errors.find((error) => error.name === "L2_HEATMAP_DEEP_S").problem).toBe("must be a number, at least 0");
  });

  test("settings of other processes are left to them, and unknown project names are reported as likely typos", () => {
    const result = validateProcessEnv("terminal-c", {
      TT_MAX_DB_BYTES: "not-a-number",
      L2_HEATMAP_DEEPS: "39600",
      SOMETHING_ELSE: "x",
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(["L2_HEATMAP_DEEPS"]);
  });

  test("the collectors refuse an invalid capacity limit before capturing", () => {
    expect(validateProcessEnv("collector", { TT_MAX_DB_BYTES: "400GiB" }).errors.map((error) => error.name)).toEqual(["TT_MAX_DB_BYTES"]);
    expect(() => validateProcessEnv("nobody", {})).toThrow(/unknown process/);
  });

  test("assertProcessEnv throws a CONFIG_INVALID error listing every bad setting and passes warnings to its sink", () => {
    const warnings = [];
    expect(() => assertProcessEnv("terminal-c", { L2_HEATMAP_DEEP_S: "x", L2_HEATMAP_ROW_BP: "0", L2_TYPO: "1" }, { warn: (line) => warnings.push(line) }))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining("config: L2_HEATMAP_ROW_BP must be a number, above 0") }));
    expect(warnings).toEqual(["config: L2_TYPO is not a setting any process reads; check the spelling"]);
  });
});

describe("entry points refuse to start on a bad setting", () => {
  const entries = [
    ["Terminal C", "scripts/serve/run-ws-server.js", { L2_HEATMAP_DEEP_S: "abc" }, "L2_HEATMAP_DEEP_S"],
    ["live-storage", "scripts/serve/run-live-storage-service.js", { TT_LIVE_STORAGE_PORT: "eighty" }, "TT_LIVE_STORAGE_PORT"],
    ["gateway", "scripts/serve/run-archive-gateway.js", { TT_ARCHIVE_GATEWAY_PORT: "port-zero" }, "TT_ARCHIVE_GATEWAY_PORT"],
    ["iceberg history", "scripts/serve/run-iceberg-history.js", { TT_ICEBERG_CYCLE_MS: "soon" }, "TT_ICEBERG_CYCLE_MS"],
    ["Binance collector", "scripts/collect/run-collector.js", { TT_MAX_DB_BYTES: "400GiB" }, "TT_MAX_DB_BYTES"],
    ["dxFeed collector", "scripts/collect/run-dxfeed-collector.js", { TT_MIN_FREE_DISK_BYTES: "minus-one" }, "TT_MIN_FREE_DISK_BYTES"],
  ];

  test.each(entries)("%s exits 1 naming the setting before it opens anything", (_label, script, bad, name) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: RUNTIME_ROOT,
      env: { ...process.env, ...bad },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`config: ${name} must be`);
    expect(result.stderr).not.toContain(Object.values(bad)[0]);
  });
});
