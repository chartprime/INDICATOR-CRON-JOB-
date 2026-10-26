#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../../..");
const RUNNERS = Object.freeze({
  http: path.join(__dirname, "live-storage-load.js"),
  browser: path.join(__dirname, "browser-load.js"),
  ws: path.join(__dirname, "ws-fanout-load.js"),
});
const STATES = new Set(["cold", "warm", "neutral"]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function resolvedInsideRoot(relative, label) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) throw new Error(`o2-campaign: ${label} must be a relative path`);
  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error(`o2-campaign: ${label} escapes the repository`);
  return resolved;
}

function validateCampaign(value, { exists = fs.existsSync, read = fs.readFileSync } = {}) {
  if (!record(value) || value.version !== 1 || typeof value.name !== "string" || !Array.isArray(value.workloads) || value.workloads.length === 0) {
    throw new Error("o2-campaign: campaign must be version 1 with a name and workloads");
  }
  const ids = new Set();
  for (const [index, workload] of value.workloads.entries()) {
    if (!record(workload) || typeof workload.id !== "string" || !/^[a-z0-9-]+$/.test(workload.id) || ids.has(workload.id)) throw new Error(`o2-campaign: workloads[${index}].id is invalid or duplicated`);
    ids.add(workload.id);
    if (!["http", "browser", "ws", "external"].includes(workload.runner)) throw new Error(`o2-campaign: ${workload.id} has an unknown runner`);
    if (!Number.isSafeInteger(workload.repetitions) || workload.repetitions < 1 || workload.repetitions > 20) throw new Error(`o2-campaign: ${workload.id}.repetitions must be 1..20`);
    if (!Array.isArray(workload.states) || workload.states.length === 0 || workload.states.some((state) => !STATES.has(state)) || new Set(workload.states).size !== workload.states.length) throw new Error(`o2-campaign: ${workload.id}.states are invalid`);
    if (workload.runner === "external") {
      if (typeof workload.procedure !== "string" || workload.procedure.length === 0) throw new Error(`o2-campaign: ${workload.id} needs an external procedure`);
    } else {
      const manifestPath = resolvedInsideRoot(workload.manifest, `${workload.id}.manifest`);
      if (!exists(manifestPath)) throw new Error(`o2-campaign: ${workload.id} manifest does not exist`);
      const manifest = JSON.parse(read(manifestPath, "utf8"));
      if (workload.runner === "http" && manifest.rounds !== 1 && workload.processMode !== "burst") throw new Error(`o2-campaign: ${workload.id} must use rounds:1; repetitions are separate processes`);
      if (workload.runner === "http" && workload.telemetry === "required" && manifest.serverDelta !== true) throw new Error(`o2-campaign: ${workload.id} requires serverDelta telemetry`);
    }
    if (!Array.isArray(workload.metrics)) throw new Error(`o2-campaign: ${workload.id}.metrics must be an array`);
    if (workload.completion !== undefined && !["required", "progressive"].includes(workload.completion)) throw new Error(`o2-campaign: ${workload.id}.completion is invalid`);
    if (workload.telemetry !== undefined && workload.telemetry !== "required") throw new Error(`o2-campaign: ${workload.id}.telemetry is invalid`);
    if (workload.processMode !== undefined && workload.processMode !== "burst") throw new Error(`o2-campaign: ${workload.id}.processMode is invalid`);
    if (workload.processMode === "burst" && workload.runner !== "http") throw new Error(`o2-campaign: ${workload.id} burst mode is only supported by the HTTP runner`);
    if (workload.allowedFailureClasses !== undefined && (workload.runner !== "http" || !Array.isArray(workload.allowedFailureClasses) || workload.allowedFailureClasses.length === 0 || workload.allowedFailureClasses.some((value) => typeof value !== "string" || value.length === 0))) throw new Error(`o2-campaign: ${workload.id}.allowedFailureClasses is invalid`);
    for (const metric of workload.metrics) {
      if (!record(metric) || typeof metric.name !== "string" || typeof metric.path !== "string" || !["max", "min"].includes(metric.operator) || !Number.isFinite(metric.threshold)) throw new Error(`o2-campaign: ${workload.id} has an invalid metric`);
    }
  }
  return value;
}

function validateCacheEvidence(value, state) {
  const requiredStrings = ["observedAtUtc", "hostRelease", "databaseIdentity", "catalogIdentity", "clientIdentity", "networkPath", "preparation"];
  if (!record(value) || value.version !== 1 || value.state !== state || requiredStrings.some((key) => typeof value[key] !== "string" || value[key].length === 0) || !record(value.healthBefore)) {
    throw new Error(`o2-campaign: cache evidence must identify the ${state} state, release, data generations, client, network, preparation, and pre-run health`);
  }
  return value;
}

function expectedSlots(campaign) {
  return campaign.workloads.flatMap((workload) => workload.states.flatMap((state) =>
    Array.from({ length: workload.repetitions }, (_, index) => ({ workload: workload.id, runner: workload.runner, state, repetition: index + 1 }))));
}

function reportFileName(workload, state, repetition) {
  return `${workload}.${state}.${String(repetition).padStart(2, "0")}.json`;
}

function valueAt(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function reportPasses(workload, report) {
  const governedIdentity = workload.runner === "external" ||
    (report?.source?.git?.dirty === false && /^v24\./.test(report?.source?.nodeVersion ?? ""));
  if (!governedIdentity) return false;
  const telemetryPasses = workload.telemetry !== "required" ||
    (record(report?.serverDelta) && report.serverDelta.error === undefined && report.serverDelta.inFlight?.drained !== false);
  const httpOutcomesPass = workload.allowedFailureClasses === undefined
    ? report?.summary?.failed === 0
    : Array.isArray(report?.samples) && report.samples.length > 0 && report.samples.every((sample) => workload.allowedFailureClasses.includes(sample.failureClass));
  if (workload.runner === "http") return telemetryPasses && httpOutcomesPass &&
    (workload.completion === "progressive" || (report.pagination?.incomplete ?? 0) === 0) && report.interrupted !== true;
  if (workload.runner === "browser") return report?.pass === true;
  if (workload.runner === "ws") return report?.invariants?.producerKeptUp === true && report?.invariants?.incidents === 0 && report?.invariants?.duplicatesOrReordered === 0;
  return report?.pass === true;
}

function semanticFingerprint(report, workload) {
  if (!Array.isArray(report?.samples)) return null;
  if (workload?.allowedFailureClasses !== undefined) return null;
  const rows = report.samples.map((sample) => ({
    key: [sample.user, sample.round, sample.requestIndex, sample.route, sample.page].join(":"),
    failureClass: sample.failureClass,
    bodySha256: sample.bodySha256,
  })).sort((left, right) => left.key.localeCompare(right.key));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function nearestRank(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function assessCampaign(campaign, evidenceDirectory) {
  const rows = [];
  const missing = [];
  for (const workload of campaign.workloads) {
    for (const state of workload.states) {
      const reports = [];
      const rejected = [];
      let completedSlots = 0;
      for (let repetition = 1; repetition <= workload.repetitions; repetition += 1) {
        const wrapperPath = path.join(evidenceDirectory, `${reportFileName(workload.id, state, repetition)}.evidence.json`);
        if (!fs.existsSync(wrapperPath)) { missing.push({ workload: workload.id, state, repetition }); continue; }
        const wrapper = JSON.parse(fs.readFileSync(wrapperPath, "utf8"));
        if (wrapper.campaign !== campaign.name || wrapper.workload !== workload.id || wrapper.state !== state || wrapper.repetition !== repetition) throw new Error(`o2-campaign: evidence identity mismatch for ${wrapperPath}`);
        validateCacheEvidence(wrapper.cacheEvidence, state);
        const reportPath = path.resolve(path.dirname(wrapperPath), wrapper.reportFile);
        if (sha256File(reportPath) !== wrapper.reportSha256) throw new Error(`o2-campaign: report digest mismatch for ${wrapperPath}`);
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        reports.push(report);
        const acceptedByRunner = wrapper.accepted === true && wrapper.runnerExitCode === 0;
        if (!acceptedByRunner) rejected.push({ workload: workload.id, state, repetition, runnerExitCode: wrapper.runnerExitCode });
        if (acceptedByRunner && reportPasses(workload, report)) completedSlots += 1;
      }
      const metrics = workload.metrics.map((metric) => {
        const values = reports.map((report) => valueAt(report, metric.path)).filter(Number.isFinite);
        const observed = nearestRank(values, 0.95);
        const pass = observed !== null && (metric.operator === "max" ? observed <= metric.threshold : observed >= metric.threshold);
        return { ...metric, samples: values.length, observedP95: observed, verdict: observed === null ? "UNMEASURED" : pass ? "PASS" : "FAIL", distance: observed === null ? null : metric.operator === "max" ? observed / metric.threshold : metric.threshold / observed };
      });
      const completed = completedSlots;
      const semanticDigests = [...new Set(reports.map((report) => semanticFingerprint(report, workload)).filter((value) => value !== null))];
      const semanticDrift = workload.runner === "http" && semanticDigests.length > 1;
      rows.push({ workload: workload.id, state, required: workload.repetitions, reports: reports.length, completed, rejected, semanticDigests, semanticDrift, verdict: reports.length < workload.repetitions ? "UNMEASURED" : completed !== reports.length || semanticDrift || metrics.some((metric) => metric.verdict === "FAIL") ? "FAIL" : metrics.some((metric) => metric.verdict === "UNMEASURED") ? "UNMEASURED" : "PASS", metrics });
    }
  }
  for (const workload of campaign.workloads.filter((candidate) => candidate.runner === "http")) {
    const workloadRows = rows.filter((row) => row.workload === workload.id);
    const acrossStates = new Set(workloadRows.flatMap((row) => row.semanticDigests));
    if (acrossStates.size > 1) {
      for (const row of workloadRows) {
        row.semanticDrift = true;
        if (row.verdict !== "UNMEASURED") row.verdict = "FAIL";
      }
    }
  }
  const bottlenecks = rows.flatMap((row) => row.metrics.filter((metric) => metric.observedP95 !== null).map((metric) => ({ workload: row.workload, state: row.state, metric: metric.name, verdict: metric.verdict, pressure: metric.distance, observedP95: metric.observedP95, threshold: metric.threshold }))).sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1));
  return { contractVersion: 1, campaign: campaign.name, assessedAtUtc: new Date().toISOString(), complete: missing.length === 0, summary: { rejected: rows.reduce((total, row) => total + row.rejected.length, 0), pass: rows.filter((row) => row.verdict === "PASS").length, fail: rows.filter((row) => row.verdict === "FAIL").length, unmeasured: rows.filter((row) => row.verdict === "UNMEASURED").length, missing: missing.length }, rows, missing, bottlenecks };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, file);
}

function runOne(campaign, workloadId, state, repetition, cacheEvidencePath, outputDirectory) {
  const workload = campaign.workloads.find((candidate) => candidate.id === workloadId);
  if (!workload) throw new Error(`o2-campaign: unknown workload ${workloadId}`);
  if (workload.runner === "external") throw new Error(`o2-campaign: ${workloadId} requires external evidence: ${workload.procedure}`);
  if (!workload.states.includes(state) || !Number.isSafeInteger(repetition) || repetition < 1 || repetition > workload.repetitions) throw new Error("o2-campaign: state or repetition is outside the campaign");
  const cacheEvidence = validateCacheEvidence(JSON.parse(fs.readFileSync(cacheEvidencePath, "utf8")), state);
  const reportName = reportFileName(workloadId, state, repetition);
  const reportPath = path.resolve(outputDirectory, reportName);
  if (fs.existsSync(reportPath) || fs.existsSync(`${reportPath}.evidence.json`)) throw new Error(`o2-campaign: refusing to overwrite ${reportName}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const result = childProcess.spawnSync(process.execPath, [RUNNERS[workload.runner], resolvedInsideRoot(workload.manifest, `${workload.id}.manifest`), reportPath], { cwd: path.dirname(RUNNERS[workload.runner]), stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (!fs.existsSync(reportPath)) throw new Error(`o2-campaign: runner produced no report (exit ${result.status})`);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const wrapper = { contractVersion: 1, campaign: campaign.name, workload: workloadId, state, repetition, runnerExitCode: result.status, reportFile: path.basename(reportPath), reportSha256: sha256File(reportPath), cacheEvidence, accepted: result.status === 0 && reportPasses(workload, report) };
  writeAtomic(`${reportPath}.evidence.json`, wrapper);
  if (!wrapper.accepted) process.exitCode = 1;
}

function importOne(campaign, workloadId, state, repetition, cacheEvidencePath, sourceReportPath, outputDirectory) {
  const workload = campaign.workloads.find((candidate) => candidate.id === workloadId);
  if (!workload || workload.runner !== "external") throw new Error(`o2-campaign: ${workloadId} is not an external workload`);
  if (!workload.states.includes(state) || !Number.isSafeInteger(repetition) || repetition < 1 || repetition > workload.repetitions) throw new Error("o2-campaign: state or repetition is outside the campaign");
  const cacheEvidence = validateCacheEvidence(JSON.parse(fs.readFileSync(cacheEvidencePath, "utf8")), state);
  const report = JSON.parse(fs.readFileSync(sourceReportPath, "utf8"));
  const reportName = reportFileName(workloadId, state, repetition);
  const reportPath = path.resolve(outputDirectory, reportName);
  if (fs.existsSync(reportPath) || fs.existsSync(`${reportPath}.evidence.json`)) throw new Error(`o2-campaign: refusing to overwrite ${reportName}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(sourceReportPath, reportPath, fs.constants.COPYFILE_EXCL);
  const wrapper = { contractVersion: 1, campaign: campaign.name, workload: workloadId, state, repetition, runnerExitCode: 0, reportFile: path.basename(reportPath), reportSha256: sha256File(reportPath), cacheEvidence, accepted: reportPasses(workload, report) };
  writeAtomic(`${reportPath}.evidence.json`, wrapper);
  if (!wrapper.accepted) process.exitCode = 1;
}

function main(argv = process.argv.slice(2)) {
  const [command, campaignArg, ...rest] = argv;
  if (!command || !campaignArg) throw new Error("usage: o2-campaign <plan|run|import|assess> <campaign.json> ...");
  const campaign = validateCampaign(JSON.parse(fs.readFileSync(path.resolve(campaignArg), "utf8")));
  if (command === "plan") return process.stdout.write(`${JSON.stringify({ campaign: campaign.name, slots: expectedSlots(campaign) }, null, 2)}\n`);
  if (command === "run") return runOne(campaign, rest[0], rest[1], Number(rest[2]), path.resolve(rest[3]), path.resolve(rest[4]));
  if (command === "import") return importOne(campaign, rest[0], rest[1], Number(rest[2]), path.resolve(rest[3]), path.resolve(rest[4]), path.resolve(rest[5]));
  if (command === "assess") return writeAtomic(path.resolve(rest[1]), assessCampaign(campaign, path.resolve(rest[0])));
  throw new Error(`o2-campaign: unknown command ${command}`);
}

if (require.main === module) { try { main(); } catch (error) { console.error(error?.message ?? error); process.exitCode = 1; } }

module.exports = { validateCampaign, validateCacheEvidence, expectedSlots, reportFileName, reportPasses, semanticFingerprint, assessCampaign, valueAt, nearestRank };
