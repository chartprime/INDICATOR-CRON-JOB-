#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");

const STUDY_CONTRACT_VERSION = "archive-study/1";
const QUERY_CONTRACT_VERSION = "archive-query/1";
const STUDY_PATH = "/archive/study";
const QUERY_PATH = "/archive/query";
const HEALTH_PATH = "/health";
const STUDIES = Object.freeze(new Set(["volume_profile", "vpin", "large_prints", "bar_flow"]));
const MINUTE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_PASSES = 5;
const MAX_RUNS = 200;
const MAX_ROUTE_RETRIES = 3;
const ARCHIVE_STAGES = Object.freeze(["serviceMs", "downloadMs", "cacheLookupMs", "queryMs"]);
const ATTRIBUTION_NOTE = "archiveQueries is the archive-query service's admitted-query count across the run minus the gateway's own /archive/query admissions in the same window; the gateway is the service's only caller, so a run whose chartQueries delta is 0 is attributed exactly and any other run is marked shared.";

class BenchError extends Error {}

function parseArgs(argv, env = process.env) {
  const options = { passes: 2, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plan", "--out", "--base", "--archive-health-cmd", "--passes", "--timeout-ms"].includes(flag)) {
      throw new BenchError(`unknown argument ${flag}`);
    }
    if (value === undefined) throw new BenchError(`${flag} requires a value`);
    index += 1;
    if (flag === "--plan") options.plan = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--base") options.base = value;
    else if (flag === "--archive-health-cmd") options.archiveHealthCmd = value;
    else if (flag === "--passes") options.passes = Number(value);
    else options.timeoutMs = Number(value);
  }
  options.base = options.base ?? env.TT_ARCHIVE_PROXY_URL;
  options.token = env.TT_ARCHIVE_BENCH_TOKEN || env.VITE_ARCHIVE_CLIENT_TOKEN;
  if (!options.plan || !options.out) throw new BenchError("--plan and --out are required");
  if (!options.archiveHealthCmd) throw new BenchError("--archive-health-cmd is required");
  if (typeof options.base !== "string" || !/^https?:\/\/[^/@]+$/.test(options.base.replace(/\/$/, ""))) {
    throw new BenchError("the gateway base must be an http(s) origin without credentials or a path");
  }
  options.base = options.base.replace(/\/$/, "");
  if (typeof options.token !== "string" || options.token.length === 0) {
    throw new BenchError("TT_ARCHIVE_BENCH_TOKEN or VITE_ARCHIVE_CLIENT_TOKEN must be set in the environment");
  }
  if (!Number.isSafeInteger(options.passes) || options.passes < 1 || options.passes > MAX_PASSES) {
    throw new BenchError(`--passes must be an integer from 1 to ${MAX_PASSES}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new BenchError("--timeout-ms must be an integer of at least 1000");
  }
  return options;
}

function epochMs(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed % MINUTE_MS !== 0) {
    throw new BenchError(`${field} must be a minute-aligned ISO time or epoch millisecond`);
  }
  return parsed;
}

function windowOf(value, field) {
  if (value === null || typeof value !== "object") throw new BenchError(`${field} must be an object`);
  const fromTs = epochMs(value.fromTs, `${field}.fromTs`);
  const toTs = epochMs(value.toTs, `${field}.toTs`);
  if (toTs <= fromTs) throw new BenchError(`${field} must end after it starts`);
  return { fromTs, toTs };
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.runs) || !Array.isArray(plan.instruments)) {
    throw new BenchError("the plan must carry instruments and runs arrays");
  }
  const instruments = new Map();
  for (const [index, instrument] of plan.instruments.entries()) {
    const field = `instruments[${index}]`;
    if (typeof instrument?.id !== "string" || instruments.has(instrument.id)) throw new BenchError(`${field}.id must be unique`);
    if (!["FUTURE", "EQUITY"].includes(instrument.assetClass)) throw new BenchError(`${field}.assetClass is invalid`);
    if (!(instrument.tickSize > 0)) throw new BenchError(`${field}.tickSize must be positive`);
    if (!Array.isArray(instrument.segments) || instrument.segments.length === 0) throw new BenchError(`${field}.segments is empty`);
    const segments = instrument.segments.map((segment, position) => {
      if (typeof segment?.instrumentId !== "string") throw new BenchError(`${field}.segments[${position}].instrumentId is missing`);
      return { instrumentId: segment.instrumentId, ...windowOf(segment, `${field}.segments[${position}]`) };
    });
    instruments.set(instrument.id, { symbol: instrument.symbol ?? instrument.id, assetClass: instrument.assetClass, tickSize: instrument.tickSize, segments });
  }
  if (plan.runs.length === 0 || plan.runs.length > MAX_RUNS) throw new BenchError(`the plan must hold 1 to ${MAX_RUNS} runs`);
  const ids = new Set();
  const runs = plan.runs.map((run, index) => {
    const field = `runs[${index}]`;
    if (typeof run?.id !== "string" || ids.has(run.id)) throw new BenchError(`${field}.id must be unique`);
    ids.add(run.id);
    const instrument = instruments.get(run.instrument);
    if (instrument === undefined) throw new BenchError(`${field}.instrument is not declared`);
    if (!STUDIES.has(run.study)) throw new BenchError(`${field}.study is invalid`);
    if (!Array.isArray(run.ranges) || run.ranges.length === 0) throw new BenchError(`${field}.ranges is empty`);
    const ranges = run.ranges.map((range, position) => windowOf(range, `${field}.ranges[${position}]`));
    return {
      id: run.id,
      purpose: run.purpose ?? "cost",
      expect: run.expect ?? null,
      request: {
        study: run.study,
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        tickSize: instrument.tickSize,
        segments: instrument.segments,
        ranges,
        ...(run.options === undefined ? {} : { options: run.options }),
      },
    };
  });
  const fenceProbe = plan.fenceProbe === undefined ? null : { ...plan.fenceProbe, ...windowOf(plan.fenceProbe, "fenceProbe") };
  return { runs, fenceProbe };
}

function requestJson(base, pathname, { method = "GET", token = null, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(pathname, base);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = transport.request(url, {
      method,
      headers: {
        "accept-encoding": "gzip",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": String(payload.length) }),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const wire = Buffer.concat(chunks);
        const gzip = /\bgzip\b/.test(response.headers["content-encoding"] ?? "");
        let text;
        try {
          text = (gzip ? zlib.gunzipSync(wire) : wire).toString("utf8");
        } catch (error) {
          reject(new BenchError(`${pathname}: response body could not be decoded (${error.message})`));
          return;
        }
        let parsed = null;
        try {
          parsed = text === "" ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        resolve({
          status: response.statusCode,
          body: parsed,
          wireBytes: wire.length,
          jsonBytes: Buffer.byteLength(text, "utf8"),
          gzip,
          wallMs: Math.round(performance.now() - started),
        });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new BenchError(`${pathname}: no answer within ${timeoutMs} ms`)));
    request.on("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

function archiveCounters(health) {
  const stages = health?.telemetry?.stages;
  if (stages === undefined || stages === null) throw new BenchError("archive-query health carries no telemetry stages");
  const counters = {};
  for (const stage of ARCHIVE_STAGES) {
    const entry = stages[stage];
    if (!Number.isSafeInteger(entry?.count)) throw new BenchError(`archive-query health is missing ${stage}.count`);
    counters[`${stage}.count`] = entry.count;
    counters[`${stage}.totalMs`] = entry.totalMs;
  }
  return counters;
}

function gatewayCounters(health) {
  if (health?.route === undefined || health?.study === undefined) throw new BenchError("gateway health carries no route or study counters");
  return {
    chartQueries: health.route.admitted,
    studyAdmitted: health.study.admitted,
    studyPacedWaits: health.study.pacedWaits,
    studyTimedOut: health.study.timedOut,
    studyFailed: health.study.failed,
  };
}

function deltas(before, after) {
  const archiveQueries = after.archive["serviceMs.count"] - before.archive["serviceMs.count"];
  const chartQueries = after.gateway.chartQueries - before.gateway.chartQueries;
  const counters = [archiveQueries, chartQueries, after.gateway.studyAdmitted - before.gateway.studyAdmitted];
  if (counters.some((value) => value < 0)) {
    return { valid: false, reason: "COUNTERS_WENT_BACKWARDS_SERVICE_RESTARTED" };
  }
  return {
    valid: true,
    attribution: chartQueries === 0 ? "exact" : "shared",
    archiveQueries: archiveQueries - chartQueries,
    chartQueries,
    s3Downloads: after.archive["downloadMs.count"] - before.archive["downloadMs.count"],
    cacheLookups: after.archive["cacheLookupMs.count"] - before.archive["cacheLookupMs.count"],
    archiveServiceMs: Math.round(after.archive["serviceMs.totalMs"] - before.archive["serviceMs.totalMs"]),
    archiveQueryMs: Math.round(after.archive["queryMs.totalMs"] - before.archive["queryMs.totalMs"]),
    pacedWaits: after.gateway.studyPacedWaits - before.gateway.studyPacedWaits,
  };
}

function payloadSummary(study, body) {
  if (body === null || typeof body !== "object") return null;
  if (study === "volume_profile") {
    const profiles = Array.isArray(body.profiles) ? body.profiles : [];
    return { profiles: profiles.length, profileRows: profiles.reduce((sum, profile) => sum + (profile.buckets?.length ?? 0), 0) };
  }
  if (study === "vpin") return { readings: Array.isArray(body.readings) ? body.readings.length : 0 };
  if (study === "bar_flow") {
    const bars = Array.isArray(body.bars) ? body.bars : [];
    const volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
    const unknown = bars.reduce((sum, bar) => sum + bar.unknown_volume, 0);
    const sided = bars.reduce((sum, bar) => sum + bar.buy_volume + bar.sell_volume, 0);
    return {
      bars: bars.length,
      volume,
      unsidedShare: volume > 0 ? Number((unknown / volume).toFixed(6)) : null,
      conserved: bars.every((bar) => Math.abs(bar.buy_volume + bar.sell_volume + bar.unknown_volume - bar.volume) <= 1e-6),
      sided,
    };
  }
  return { prints: Array.isArray(body.prints) ? body.prints.length : 0 };
}

function expectationMet(expect, record) {
  if (expect === null) return null;
  return Object.entries(expect).every(([key, value]) => record[key] === value);
}

async function runBench({ plan, base, token, passes, timeoutMs, scrapeArchive, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} }) {
  const { runs, fenceProbe } = validatePlan(plan);
  let requestId = 0;

  async function snapshot() {
    const [archive, gateway] = await Promise.all([
      scrapeArchive(),
      requestJson(base, HEALTH_PATH, { timeoutMs }),
    ]);
    if (gateway.status !== 200) throw new BenchError(`gateway health answered ${gateway.status}`);
    return { archive: archiveCounters(archive), gateway: gatewayCounters(gateway.body) };
  }

  async function fence() {
    if (fenceProbe === null) return null;
    const answer = await requestJson(base, QUERY_PATH, {
      method: "POST",
      token,
      timeoutMs,
      body: {
        contractVersion: QUERY_CONTRACT_VERSION,
        instrumentId: fenceProbe.instrumentId,
        family: fenceProbe.family,
        from: String(BigInt(fenceProbe.fromTs) * 1_000_000n),
        to: String(BigInt(fenceProbe.toTs) * 1_000_000n),
        limit: 1,
      },
    });
    return {
      status: answer.status,
      publisherFence: answer.body?.pointer?.publisher_fence ?? null,
      datasetVersion: answer.body?.pointer?.dataset_version ?? null,
    };
  }

  const fenceBefore = await fence();
  const records = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    for (const run of runs) {
      const before = await snapshot();
      let answer;
      let routeRetries = 0;
      for (;;) {
        requestId += 1;
        answer = await requestJson(base, STUDY_PATH, {
          method: "POST",
          token,
          timeoutMs,
          body: { contractVersion: STUDY_CONTRACT_VERSION, requestId, ...run.request },
        });
        const retryAfterMs = answer.body?.retryAfterMs;
        if (answer.status !== 429 || answer.body?.error !== "OVERLOADED" || !Number.isSafeInteger(retryAfterMs)
            || routeRetries >= MAX_ROUTE_RETRIES) break;
        routeRetries += 1;
        await sleep(retryAfterMs);
      }
      const after = await snapshot();
      const record = {
        id: run.id,
        pass,
        purpose: run.purpose,
        study: run.request.study,
        symbol: run.request.symbol,
        ranges: run.request.ranges.length,
        spanMs: run.request.ranges.at(-1).toTs - run.request.ranges[0].fromTs,
        status: answer.status,
        error: answer.body?.error ?? null,
        reason: answer.body?.reason ?? null,
        complete: answer.body?.complete ?? null,
        missingRanges: Array.isArray(answer.body?.missing) ? answer.body.missing.length : null,
        emptyRanges: Array.isArray(answer.body?.empty) ? answer.body.empty.length : null,
        missingReasons: Array.isArray(answer.body?.missing)
          ? [...new Set(answer.body.missing.map((entry) => entry.reason).filter((value) => typeof value === "string"))]
          : null,
        payload: payloadSummary(run.request.study, answer.body),
        wallMs: answer.wallMs,
        wireBytes: answer.wireBytes,
        jsonBytes: answer.jsonBytes,
        gzip: answer.gzip,
        routeRetries,
        host: deltas(before, after),
      };
      record.expectationMet = expectationMet(run.expect, record);
      records.push(record);
      log(record);
    }
  }
  const fenceAfter = await fence();
  return { fenceBefore, fenceAfter, records };
}

function summarize(records) {
  const byStudy = {};
  for (const record of records) {
    if (record.purpose !== "cost" || record.status !== 200) continue;
    const key = `${record.study}|pass${record.pass}`;
    const entry = byStudy[key] ?? { runs: 0, wallMsMax: 0, wireBytesMax: 0, archiveQueriesMax: 0, pacedWaits: 0, incomplete: 0 };
    entry.runs += 1;
    entry.wallMsMax = Math.max(entry.wallMsMax, record.wallMs);
    entry.wireBytesMax = Math.max(entry.wireBytesMax, record.wireBytes);
    if (record.host.valid) {
      entry.archiveQueriesMax = Math.max(entry.archiveQueriesMax, record.host.archiveQueries);
      entry.pacedWaits += record.host.pacedWaits;
    }
    if (record.complete !== true) entry.incomplete += 1;
    byStudy[key] = entry;
  }
  return {
    byStudy,
    expectationsFailed: records.filter((record) => record.expectationMet === false).map((record) => `${record.id}#${record.pass}`),
    sharedAttribution: records.filter((record) => record.host.valid && record.host.attribution === "shared").map((record) => `${record.id}#${record.pass}`),
    invalidAttribution: records.filter((record) => !record.host.valid).map((record) => `${record.id}#${record.pass}`),
  };
}

function scrapeArchiveCommand(command) {
  return () => new Promise((resolve, reject) => {
    childProcess.exec(command, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new BenchError(`archive health command failed: ${error.message.split("\n")[0]}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new BenchError("archive health command did not print JSON"));
      }
    });
  });
}

function gitCommit() {
  try {
    return childProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const planText = fs.readFileSync(options.plan, "utf8");
  const plan = JSON.parse(planText);
  const startedAt = new Date().toISOString();
  const result = await runBench({
    plan,
    base: options.base,
    token: options.token,
    passes: options.passes,
    timeoutMs: options.timeoutMs,
    scrapeArchive: scrapeArchiveCommand(options.archiveHealthCmd),
    log: (record) => process.stderr.write(`${record.id}#${record.pass} ${record.status} ${record.wallMs}ms `
      + `${record.wireBytes}B queries=${record.host.archiveQueries ?? "?"} paced=${record.host.pacedWaits ?? "?"}\n`),
  });
  const report = {
    kind: "archive-study-cost",
    startedAt,
    finishedAt: new Date().toISOString(),
    gateway: new URL(options.base).host,
    commit: gitCommit(),
    node: process.version,
    plan: { path: path.relative(process.cwd(), path.resolve(options.plan)), sha256: crypto.createHash("sha256").update(planText).digest("hex") },
    passes: options.passes,
    attribution: ATTRIBUTION_NOTE,
    fence: { before: result.fenceBefore, after: result.fenceAfter },
    summary: summarize(result.records),
    records: result.records,
  };
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${options.out}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`archive-study-cost: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  validatePlan,
  requestJson,
  archiveCounters,
  gatewayCounters,
  deltas,
  expectationMet,
  runBench,
  summarize,
  BenchError,
};
