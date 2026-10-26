"use strict";

const { performance } = require("node:perf_hooks");

const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]);
const EVENT_FIELDS = Object.freeze(new Set(["cacheHits", "cacheMisses", "coalesced", "overloaded", "timedOut", "cancelled"]));
const STAGE_FIELDS = Object.freeze(new Set([
  "poolQueueMs", "workerStartupMs", "readerSetupMs", "queryMs", "workerTotalMs",
  "serializationMs", "responseWriteMs",
]));
const FAILURE_REASONS = Object.freeze(new Set([
  "route_timeout", "reader_timeout", "reader_aborted", "worker_failed",
  "worker_exited", "worker_query_failed", "service_unavailable",
]));

function createRouteTelemetry({ routes, now = () => performance.now(), latencyBucketsMs = DEFAULT_LATENCY_BUCKETS_MS } = {}) {
  if (!Array.isArray(routes) || routes.length === 0 || routes.some((route) => typeof route !== "string" || route.length === 0)) {
    throw new Error("route-telemetry: routes must be a non-empty string array");
  }
  if (typeof now !== "function") throw new Error("route-telemetry: now must be a function");
  if (!Array.isArray(latencyBucketsMs) || latencyBucketsMs.length === 0 || latencyBucketsMs.some((value, index) =>
    !Number.isFinite(value) || value <= 0 || (index > 0 && value <= latencyBucketsMs[index - 1]))) {
    throw new Error("route-telemetry: latencyBucketsMs must be strictly increasing positive numbers");
  }

  const allowedRoutes = new Set(routes);
  const records = new Map();

  function recordFor(routeName) {
    if (!allowedRoutes.has(routeName)) throw new Error(`route-telemetry: unknown route ${routeName}`);
    let record = records.get(routeName);
    if (record === undefined) {
      record = {
        requests: 0, successes: 0, clientErrors: 0, serverErrors: 0,
        cacheHits: 0, cacheMisses: 0, coalesced: 0, overloaded: 0, timedOut: 0, cancelled: 0,
        requestBytes: 0, responseBytes: 0, durationMsTotal: 0, durationMsMax: 0,
        latencyBuckets: Array(latencyBucketsMs.length + 1).fill(0),
        stages: {},
        failureReasons: {},
      };
      records.set(routeName, record);
    }
    return record;
  }

  function increment(routeName, field) {
    if (!EVENT_FIELDS.has(field)) throw new Error(`route-telemetry: unknown event ${field}`);
    recordFor(routeName)[field] += 1;
  }

  function observeStage(routeName, field, durationMs) {
    if (!STAGE_FIELDS.has(field)) throw new Error(`route-telemetry: unknown stage ${field}`);
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const record = recordFor(routeName);
    const stage = record.stages[field] ?? { count: 0, totalMs: 0, maxMs: 0, latencyBuckets: Array(latencyBucketsMs.length + 1).fill(0) };
    stage.count += 1;
    stage.totalMs += durationMs;
    stage.maxMs = Math.max(stage.maxMs, durationMs);
    const bucket = latencyBucketsMs.findIndex((limit) => durationMs <= limit);
    stage.latencyBuckets[bucket === -1 ? latencyBucketsMs.length : bucket] += 1;
    record.stages[field] = stage;
  }

  function observeFailure(routeName, reason) {
    const normalized = FAILURE_REASONS.has(reason) ? reason : "service_unavailable";
    const record = recordFor(routeName);
    record.failureReasons[normalized] = (record.failureReasons[normalized] ?? 0) + 1;
  }

  function start(routeName, requestBytes = 0) {
    const startedAt = now();
    let completed = false;
    return Object.freeze({
      finish(statusCode, responseBytes = 0) {
        if (completed) return;
        completed = true;
        const durationMs = Math.max(0, now() - startedAt);
        const record = recordFor(routeName);
        record.requests += 1;
        if (statusCode >= 200 && statusCode < 400) record.successes += 1;
        else if (statusCode >= 400 && statusCode < 500) record.clientErrors += 1;
        else record.serverErrors += 1;
        record.requestBytes += Number.isSafeInteger(requestBytes) && requestBytes >= 0 ? requestBytes : 0;
        record.responseBytes += Number.isSafeInteger(responseBytes) && responseBytes >= 0 ? responseBytes : 0;
        record.durationMsTotal += durationMs;
        record.durationMsMax = Math.max(record.durationMsMax, durationMs);
        const bucket = latencyBucketsMs.findIndex((limit) => durationMs <= limit);
        record.latencyBuckets[bucket === -1 ? latencyBucketsMs.length : bucket] += 1;
      },
    });
  }

  function snapshot() {
    return {
      latencyBucketsMs: [...latencyBucketsMs, "+Inf"],
      routes: Object.fromEntries([...records.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([routeName, record]) => [
        routeName,
        {
          ...record,
          durationMsTotal: Math.round(record.durationMsTotal * 1_000) / 1_000,
          durationMsMax: Math.round(record.durationMsMax * 1_000) / 1_000,
          latencyBuckets: [...record.latencyBuckets],
          stages: Object.fromEntries(Object.entries(record.stages).map(([name, stage]) => [name, {
            ...stage,
            totalMs: Math.round(stage.totalMs * 1_000) / 1_000,
            maxMs: Math.round(stage.maxMs * 1_000) / 1_000,
            latencyBuckets: [...stage.latencyBuckets],
          }])),
        },
      ])),
    };
  }

  return Object.freeze({ start, increment, observeStage, observeFailure, snapshot });
}

module.exports = { createRouteTelemetry, DEFAULT_LATENCY_BUCKETS_MS, FAILURE_REASONS };
