"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  validateCampaign, validateCacheEvidence, expectedSlots, reportFileName, reportPasses, assessCampaign, nearestRank,
} = require("../../../scripts/bench/o2-campaign");

const ROOT = path.resolve(__dirname, "../../../../..");

describe("scripts/bench/o2-campaign", () => {
  test("the production campaign is valid and every automated manifest exists", () => {
    const campaign = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks/o2/campaign-v1.json"), "utf8"));
    expect(() => validateCampaign(campaign)).not.toThrow();
    expect(campaign.workloads).toHaveLength(30);
    expect(expectedSlots(campaign)).toHaveLength(240);
    expect(campaign.workloads.some((workload) => workload.id === "browser-hidden-tab" && workload.runner === "external")).toBe(true);
    expect(campaign.workloads.some((workload) => workload.id === "independent-five-user-mixed" && workload.runner === "external")).toBe(true);
    expect(campaign.workloads.filter((workload) => workload.runner === "external")).toHaveLength(3);
    expect(campaign.workloads.filter((workload) => workload.runner === "http" && workload.manifest.startsWith("benchmarks/live-storage/")).every((workload) => workload.telemetry === "required")).toBe(true);
    expect(campaign.workloads.filter((workload) => workload.id.endsWith("-complete")).map((workload) => workload.id)).toEqual(["replay-4h-complete", "replay-11h-complete", "replay-1d-complete"]);
  });

  test("plans repetitions as separate process slots and never folds cold into warm", () => {
    const campaign = { version: 1, name: "x", workloads: [{ id: "x", runner: "external", procedure: "do it", states: ["cold", "warm"], repetitions: 5, metrics: [] }] };
    validateCampaign(campaign);
    const slots = expectedSlots(campaign);
    expect(slots).toHaveLength(10);
    expect(slots.filter((slot) => slot.state === "cold").map((slot) => slot.repetition)).toEqual([1, 2, 3, 4, 5]);
  });

  test("requires cache evidence to pin every identity needed to interpret cold and warm", () => {
    const evidence = { version: 1, state: "cold", observedAtUtc: "now", hostRelease: "h", databaseIdentity: "d", catalogIdentity: "c", clientIdentity: "i", networkPath: "n", preparation: "p", healthBefore: { ready: true } };
    expect(validateCacheEvidence(evidence, "cold")).toBe(evidence);
    expect(() => validateCacheEvidence({ ...evidence, state: "warm" }, "cold")).toThrow(/cache evidence/);
    expect(() => validateCacheEvidence({ ...evidence, databaseIdentity: "" }, "cold")).toThrow(/cache evidence/);
  });

  test("distinguishes progressive replay from full-window completion", () => {
    const source = { git: { dirty: false }, nodeVersion: "v24.21.0" };
    const incomplete = { source, summary: { failed: 0 }, pagination: { incomplete: 1 } };
    expect(reportPasses({ runner: "http", completion: "progressive" }, incomplete)).toBe(true);
    expect(reportPasses({ runner: "http", completion: "required" }, incomplete)).toBe(false);
    expect(reportPasses({ runner: "http", completion: "required" }, { source, summary: { failed: 0 }, pagination: { incomplete: 0 } })).toBe(true);
    expect(reportPasses({ runner: "http", completion: "required" }, { source: { git: { dirty: true }, nodeVersion: "v24.21.0" }, summary: { failed: 0 } })).toBe(false);
    expect(reportPasses({ runner: "http", telemetry: "required" }, { source, summary: { failed: 0 } })).toBe(false);
    expect(reportPasses({ runner: "http", telemetry: "required" }, { source, summary: { failed: 0 }, serverDelta: { inFlight: { drained: true } } })).toBe(true);
    expect(reportPasses({ runner: "http", telemetry: "required" }, { source, summary: { failed: 0 }, serverDelta: { error: "HEALTH_UNAVAILABLE" } })).toBe(false);
    expect(reportPasses({ runner: "http", allowedFailureClasses: ["CLIENT_ABORTED"] }, { source, summary: { failed: 1 }, samples: [{ failureClass: "CLIENT_ABORTED" }] })).toBe(true);
    expect(reportPasses({ runner: "http", allowedFailureClasses: ["CLIENT_ABORTED"] }, { source, summary: { failed: 1 }, samples: [{ failureClass: "CLIENT_TIMEOUT" }] })).toBe(false);
  });

  test("uses nearest-rank p95 and ranks measured SLO pressure without inventing missing evidence", () => {
    expect(nearestRank([1, 2, 3, 4, 100], 0.95)).toBe(100);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "o2-campaign-"));
    try {
      const campaign = { version: 1, name: "test", workloads: [{ id: "route", runner: "external", procedure: "fixture", states: ["neutral"], repetitions: 2, metrics: [{ name: "latency", path: "metrics.p95", operator: "max", threshold: 10 }] }] };
      const cacheEvidence = { version: 1, state: "neutral", observedAtUtc: "now", hostRelease: "h", databaseIdentity: "d", catalogIdentity: "c", clientIdentity: "i", networkPath: "n", preparation: "p", healthBefore: { ready: true } };
      for (let repetition = 1; repetition <= 2; repetition += 1) {
        const name = reportFileName("route", "neutral", repetition);
        const bytes = Buffer.from(`${JSON.stringify({ pass: true, metrics: { p95: repetition * 6 } })}\n`);
        fs.writeFileSync(path.join(directory, name), bytes);
        fs.writeFileSync(path.join(directory, `${name}.evidence.json`), JSON.stringify({ campaign: "test", workload: "route", state: "neutral", repetition, runnerExitCode: 0, accepted: true, reportFile: name, reportSha256: crypto.createHash("sha256").update(bytes).digest("hex"), cacheEvidence }));
      }
      const result = assessCampaign(campaign, directory);
      expect(result).toMatchObject({ complete: true, summary: { pass: 0, fail: 1, unmeasured: 0, missing: 0 } });
      expect(result.rows[0].metrics[0]).toMatchObject({ observedP95: 12, verdict: "FAIL" });
      expect(result.bottlenecks[0]).toMatchObject({ workload: "route", pressure: 1.2 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not count a slot whose runner exited non-zero, however healthy the report it left behind looks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "o2-campaign-"));
    try {
      const campaign = { version: 1, name: "test", workloads: [{ id: "route", runner: "external", procedure: "fixture", states: ["neutral"], repetitions: 2, metrics: [] }] };
      const cacheEvidence = { version: 1, state: "neutral", observedAtUtc: "now", hostRelease: "h", databaseIdentity: "d", catalogIdentity: "c", clientIdentity: "i", networkPath: "n", preparation: "p", healthBefore: { ready: true } };
      for (let repetition = 1; repetition <= 2; repetition += 1) {
        const name = reportFileName("route", "neutral", repetition);
        const bytes = Buffer.from(`${JSON.stringify({ pass: true })}
`);
        fs.writeFileSync(path.join(directory, name), bytes);
        fs.writeFileSync(path.join(directory, `${name}.evidence.json`), JSON.stringify({
          campaign: "test", workload: "route", state: "neutral", repetition, runnerExitCode: repetition === 1 ? 1 : 0,
          accepted: repetition !== 1, reportFile: name, reportSha256: crypto.createHash("sha256").update(bytes).digest("hex"), cacheEvidence,
        }));
      }
      const result = assessCampaign(campaign, directory);
      expect(result.rows[0]).toMatchObject({ completed: 1, required: 2, verdict: "FAIL" });
      expect(result.rows[0].rejected).toEqual([{ workload: "route", state: "neutral", repetition: 1, runnerExitCode: 1 }]);
      expect(result.summary.rejected).toBe(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not judge a workload that declares intentional failure classes on sample-set determinism", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "o2-campaign-"));
    try {
      const campaign = { version: 1, name: "test", workloads: [{ id: "cancel", runner: "http", manifest: "benchmarks/live-storage/o2-cancel-replay-once.json", states: ["neutral"], repetitions: 2, metrics: [], allowedFailureClasses: ["CLIENT_ABORTED"] }] };
      validateCampaign(campaign);
      const cacheEvidence = { version: 1, state: "neutral", observedAtUtc: "now", hostRelease: "h", databaseIdentity: "d", catalogIdentity: "c", clientIdentity: "i", networkPath: "n", preparation: "p", healthBefore: { ready: true } };
      // The abort is a deadline, so one repetition reaches a page the other does not.
      for (const [repetition, pages] of [[1, [1, 2]], [2, [1, 2, 3]]]) {
        const name = reportFileName("cancel", "neutral", repetition);
        const report = { source: { git: { dirty: false }, nodeVersion: "v24.21.0" }, summary: { failed: pages.length }, pagination: { incomplete: 0 },
          samples: pages.map((page) => ({ user: 1, round: 1, requestIndex: 1, route: "replay-page", page, failureClass: "CLIENT_ABORTED", bodySha256: null })) };
        const bytes = Buffer.from(`${JSON.stringify(report)}
`);
        fs.writeFileSync(path.join(directory, name), bytes);
        fs.writeFileSync(path.join(directory, `${name}.evidence.json`), JSON.stringify({
          campaign: "test", workload: "cancel", state: "neutral", repetition, runnerExitCode: 0, accepted: true,
          reportFile: name, reportSha256: crypto.createHash("sha256").update(bytes).digest("hex"), cacheEvidence,
        }));
      }
      const result = assessCampaign(campaign, directory);
      expect(result.rows[0]).toMatchObject({ completed: 2, semanticDrift: false, verdict: "PASS" });
      expect(result.rows[0].semanticDigests).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses traversal, duplicate ids, combined-process HTTP repeats, and unknown metrics", () => {
    const base = { version: 1, name: "x", workloads: [{ id: "x", runner: "external", procedure: "p", states: ["neutral"], repetitions: 1, metrics: [] }] };
    expect(() => validateCampaign({ ...base, workloads: [base.workloads[0], base.workloads[0]] })).toThrow(/duplicated/);
    expect(() => validateCampaign({ ...base, workloads: [{ ...base.workloads[0], metrics: [{}] }] })).toThrow(/invalid metric/);
    expect(() => validateCampaign({ ...base, workloads: [{ id: "x", runner: "http", manifest: "../outside.json", states: ["cold"], repetitions: 1, metrics: [] }] })).toThrow(/escapes/);
  });
});
