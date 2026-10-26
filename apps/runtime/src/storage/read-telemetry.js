"use strict";

const telemetryByResult = new WeakMap();

function attachReadTelemetry(result, telemetry) {
  if (result !== null && typeof result === "object" && telemetry !== null && typeof telemetry === "object") {
    telemetryByResult.set(result, Object.freeze({ ...telemetry }));
  }
  return result;
}

function readTelemetry(result) {
  return result !== null && typeof result === "object" ? telemetryByResult.get(result) ?? null : null;
}

module.exports = { attachReadTelemetry, readTelemetry };
