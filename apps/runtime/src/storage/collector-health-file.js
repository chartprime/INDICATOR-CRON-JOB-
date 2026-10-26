const fs = require("node:fs");

function writeCollectorHealthFile(filePath, { pendingWriteItems, writeLagMs, sessionQuality, collectorStatus, recoveryAgeMs, ackP99Ms, ackSampleCount }, { now = () => new Date() } = {}) {
  if (!Number.isSafeInteger(pendingWriteItems) || pendingWriteItems < 0) {
    throw new Error("collector-health-file: pendingWriteItems must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(writeLagMs) || writeLagMs < 0) {
    throw new Error("collector-health-file: writeLagMs must be a non-negative safe integer");
  }
  if (typeof sessionQuality !== "string" || sessionQuality.length === 0) {
    throw new Error("collector-health-file: sessionQuality must be a non-empty string");
  }
  const metrics = {};
  if (collectorStatus !== undefined || recoveryAgeMs !== undefined) {
    if (!["HEALTHY", "RECOVERING", "INVALID"].includes(collectorStatus)
      || !Number.isSafeInteger(recoveryAgeMs) || recoveryAgeMs < 0) {
      throw new Error("collector-health-file: invalid recovery metrics");
    }
    Object.assign(metrics, { collectorStatus, recoveryAgeMs });
  }
  if (ackP99Ms !== undefined || ackSampleCount !== undefined) {
    if (!Number.isFinite(ackP99Ms) || ackP99Ms < 0 || !Number.isSafeInteger(ackSampleCount) || ackSampleCount < 0) {
      throw new Error("collector-health-file: invalid acknowledgement metrics");
    }
    Object.assign(metrics, { ackP99Ms, ackSampleCount });
  }
  const payload = JSON.stringify({ pendingWriteItems, writeLagMs, sessionQuality, ...metrics, updatedAt: now().toISOString() });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", mode: 0o644 });
  fs.chmodSync(tmpPath, 0o644);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { writeCollectorHealthFile };
