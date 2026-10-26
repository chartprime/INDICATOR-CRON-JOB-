const STATES = Object.freeze(["DISABLED", "IDLE", "STARTING", "RUNNING", "READY", "DEGRADED", "UNAVAILABLE", "FAILED"]);
const STATE_SET = new Set(STATES);
const REASONS = Object.freeze([
  "DISABLED_BY_CONFIG", "NOT_STARTED", "IN_PROGRESS", "PARTIAL_COVERAGE", "RETRY_SCHEDULED",
  "STORAGE_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "WORKER_ERROR", "WIRE_VALUE_OUT_OF_RANGE",
  "CANCELLED", "UNKNOWN",
]);
const REASON_SET = new Set(REASONS);
const TERMINAL = new Set(["DISABLED", "READY", "DEGRADED", "UNAVAILABLE", "FAILED"]);

function cleanMetrics(metrics) {
  if (metrics === undefined) return undefined;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) throw new Error("operational readiness metrics must be an object");
  const result = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (!/^[a-z][A-Za-z0-9]{0,47}$/.test(key)) throw new Error("operational readiness metric name is invalid");
    if (!(value === null || typeof value === "boolean" || typeof value === "string" || Number.isFinite(value))) {
      throw new Error("operational readiness metric value must be scalar");
    }
    result[key] = typeof value === "string" ? value.slice(0, 128) : value;
  }
  return Object.freeze(result);
}

function createOperationalReadiness({ now = () => Date.now(), log = null } = {}) {
  if (typeof now !== "function") throw new Error("createOperationalReadiness: now must be a function");
  const entries = new Map();
  let generation = 0;

  function transition(feature, state, { reason = null, metrics, generation: expectedGeneration } = {}) {
    if (typeof feature !== "string" || !/^[a-z][a-z0-9_.:-]{1,95}$/.test(feature)) throw new Error("operational readiness feature is invalid");
    if (!STATE_SET.has(state)) throw new Error("operational readiness state is invalid");
    if (reason !== null && !REASON_SET.has(reason)) throw new Error("operational readiness reason is invalid");
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("operational readiness clock must return epoch milliseconds");
    const prior = entries.get(feature);
    const startedAt = state === "STARTING" || state === "RUNNING"
      ? (prior && (prior.state === "STARTING" || prior.state === "RUNNING") ? prior.startedAt : at)
      : prior?.startedAt ?? null;
    const next = Object.freeze({
      feature, state, reason,
      updatedAt: at,
      ...(startedAt !== null ? { startedAt } : {}),
      ...(TERMINAL.has(state) && startedAt !== null ? { durationMs: Math.max(0, at - startedAt) } : {}),
      ...(metrics !== undefined ? { metrics: cleanMetrics(metrics) } : prior?.metrics ? { metrics: prior.metrics } : {}),
    });
    entries.set(feature, next);
    if ((!prior || prior.state !== state || prior.reason !== reason) && log) {
      log("operational.transition", next);
    }
    return true;
  }

  function beginGeneration() {
    generation += 1;
    return generation;
  }

  function snapshot(prefix = null) {
    const result = {};
    for (const [feature, value] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      if (prefix === null || feature.startsWith(prefix)) result[feature] = value;
    }
    return Object.freeze(result);
  }

  return Object.freeze({ transition, snapshot, beginGeneration, generation: () => generation, clear: () => entries.clear() });
}

module.exports = { createOperationalReadiness, STATES, REASONS };
