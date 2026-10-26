#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMPARED_FIELDS = Object.freeze(["status", "failureClass", "bodySha256", "responseBytes"]);

function sampleKey(sample) {
  return `${sample.user}:${sample.round}:${sample.requestIndex}:${sample.route}:${sample.page ?? 0}`;
}

function indexSamples(samples, side, differences) {
  const byKey = new Map();
  for (const sample of samples) {
    const key = sampleKey(sample);
    if (byKey.has(key)) {
      differences.push({ key, reason: `DUPLICATE_${side}` });
      continue;
    }
    byKey.set(key, sample);
  }
  return byKey;
}

function tally(counts, failureClass) {
  counts[failureClass] = (counts[failureClass] ?? 0) + 1;
}

function identityWarnings(before, after) {
  const warnings = [];
  for (const [side, source] of [["BEFORE", before], ["AFTER", after]]) {
    if (!source) {
      warnings.push({ reason: `SOURCE_MISSING_${side}` });
      continue;
    }
    if (source.git === null || source.git === undefined) warnings.push({ reason: `GIT_IDENTITY_MISSING_${side}` });
    else if (source.git.dirty) warnings.push({ reason: `TREE_DIRTY_${side}`, trackedDiffSha256: source.git.trackedDiffSha256 ?? null });
  }
  if (before && after && before.scriptSha256 !== after.scriptSha256) {
    warnings.push({ reason: "TOOL_SCRIPT_DIFFERS", before: before.scriptSha256 ?? null, after: after.scriptSha256 ?? null });
  }
  return warnings;
}

function compareReports(before, after, { strictIdentity = false } = {}) {
  if (!Array.isArray(before?.samples) || !Array.isArray(after?.samples)) throw new Error("compare-live-storage-reports: both reports require samples");
  const differences = [];
  const beforeSource = before.source ?? null;
  const afterSource = after.source ?? null;
  if (beforeSource && afterSource && beforeSource.manifestSha256 !== afterSource.manifestSha256) {
    differences.push({ reason: "MANIFEST_MISMATCH", before: beforeSource.manifestSha256 ?? null, after: afterSource.manifestSha256 ?? null });
  }
  const beforeByKey = indexSamples(before.samples, "BEFORE", differences);
  const afterByKey = indexSamples(after.samples, "AFTER", differences);
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const abortOutcomes = { before: {}, after: {} };
  let abortSamples = 0;
  for (const key of keys) {
    const left = beforeByKey.get(key);
    const right = afterByKey.get(key);
    if (!left || !right) {
      differences.push({ key, reason: left ? "MISSING_AFTER" : "MISSING_BEFORE" });
      continue;
    }
    if (left.abort !== undefined || right.abort !== undefined) {
      abortSamples += 1;
      tally(abortOutcomes.before, left.failureClass);
      tally(abortOutcomes.after, right.failureClass);
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if (left[field] !== right[field]) differences.push({ key, field, before: left[field], after: right[field] });
    }
  }
  const warnings = identityWarnings(beforeSource, afterSource);
  if (strictIdentity) differences.push(...warnings.map((warning) => ({ ...warning, strictIdentity: true })));
  return {
    equivalent: differences.length === 0,
    comparedSamples: keys.length,
    differences,
    warnings: strictIdentity ? [] : warnings,
    ...(abortSamples === 0 ? {} : { abortSamples: { count: abortSamples, notCompared: true, outcomes: abortOutcomes } }),
    sources: { before: beforeSource, after: afterSource },
  };
}

function main(argv = process.argv.slice(2)) {
  const strictIdentity = argv.includes("--strict-identity");
  const files = argv.filter((argument) => argument !== "--strict-identity");
  if (files.length !== 2) throw new Error("usage: compare-live-storage-reports [--strict-identity] <before.json> <after.json>");
  const reports = files.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
  const result = compareReports(reports[0], reports[1], { strictIdentity });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.equivalent) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  }
}

module.exports = { compareReports, sampleKey };
