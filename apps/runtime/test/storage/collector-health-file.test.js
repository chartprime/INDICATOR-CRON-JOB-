const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeCollectorHealthFile } = require("../../src/storage/collector-health-file");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "health-file-")), "collector-health.json");
}

test("publishes sampled acknowledgement latency and rejects invalid metrics", () => {
  const file = tmpFile();
  const values = { pendingWriteItems: 0, writeLagMs: 0, sessionQuality: "HEALTHY", ackP99Ms: 12.5, ackSampleCount: 200 };
  writeCollectorHealthFile(file, values);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ ackP99Ms: 12.5, ackSampleCount: 200 });
  expect(() => writeCollectorHealthFile(file, { ...values, ackP99Ms: NaN })).toThrow();
});

test("publishes active recovery age so the freshness timer can detect a live-but-stalled collector", () => {
  const file = tmpFile();
  const values = { pendingWriteItems: 0, writeLagMs: 0, sessionQuality: "DEGRADED", collectorStatus: "RECOVERING", recoveryAgeMs: 600_000 };
  writeCollectorHealthFile(file, values);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ collectorStatus: "RECOVERING", recoveryAgeMs: 600_000 });
  expect(() => writeCollectorHealthFile(file, { ...values, recoveryAgeMs: -1 })).toThrow(/recovery metrics/);
});

test("writes the exact four-field shape the design lock specifies", () => {
  const file = tmpFile();
  writeCollectorHealthFile(file, { pendingWriteItems: 12, writeLagMs: 340, sessionQuality: "HEALTHY" },
    { now: () => new Date("2026-09-10T12:00:00.000Z") });
  const payload = JSON.parse(fs.readFileSync(file, "utf-8"));
  expect(payload).toEqual({
    pendingWriteItems: 12, writeLagMs: 340, sessionQuality: "HEALTHY", updatedAt: "2026-09-10T12:00:00.000Z",
  });
});

test("writes atomically -- no partial file ever visible at the final path", () => {
  const file = tmpFile();
  writeCollectorHealthFile(file, { pendingWriteItems: 0, writeLagMs: 0, sessionQuality: "HEALTHY" });
  const tmp = `${file}.tmp`;
  expect(fs.existsSync(tmp)).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
});

test("a second write replaces the first cleanly, readers never see a torn write", () => {
  const file = tmpFile();
  writeCollectorHealthFile(file, { pendingWriteItems: 1, writeLagMs: 1, sessionQuality: "HEALTHY" });
  writeCollectorHealthFile(file, { pendingWriteItems: 99, writeLagMs: 5000, sessionQuality: "DEGRADED" });
  const payload = JSON.parse(fs.readFileSync(file, "utf-8"));
  expect(payload.pendingWriteItems).toBe(99);
  expect(payload.sessionQuality).toBe("DEGRADED");
});

test.each([
  ["pendingWriteItems", { pendingWriteItems: -1, writeLagMs: 0, sessionQuality: "HEALTHY" }],
  ["pendingWriteItems", { pendingWriteItems: 1.5, writeLagMs: 0, sessionQuality: "HEALTHY" }],
  ["writeLagMs", { pendingWriteItems: 0, writeLagMs: -1, sessionQuality: "HEALTHY" }],
  ["sessionQuality", { pendingWriteItems: 0, writeLagMs: 0, sessionQuality: "" }],
  ["sessionQuality", { pendingWriteItems: 0, writeLagMs: 0, sessionQuality: 5 }],
])("rejects an invalid %s rather than writing a malformed health file", (_field, bad) => {
  const file = tmpFile();
  expect(() => writeCollectorHealthFile(file, bad)).toThrow();
  expect(fs.existsSync(file)).toBe(false);
});
