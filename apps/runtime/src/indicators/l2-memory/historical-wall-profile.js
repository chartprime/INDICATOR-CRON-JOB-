"use strict";

const { createHash } = require("node:crypto");

const TRACKER_FIELDS = new Set(["minSize", "multiplier", "gapRows", "keepEndedMs", "deepKeepEndedMs", "maxLevels", "settleMs"]);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const bounded = (value, low, high) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

// Canonical, effective settings. Explicit defaults and reordered keys have the same identity.
function historicalWallProfile({ tickSize, sampleMs = 1000, rowClusters = 1, windowRows = 128, referenceRows = 128,
  fold = "sum", trackerOptions } = {}) {
  if (typeof tickSize !== "string" || !/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(tickSize)
      || !(Number(tickSize) > 0) || !Number.isFinite(Number(tickSize))
      || !integer(sampleMs, 1000, 60000) || sampleMs % 1000 !== 0
      || !integer(rowClusters, 1, 4096) || !integer(windowRows, 0, 1024)
      || !integer(referenceRows, 0, windowRows) || !["sum", "max"].includes(fold)
      || trackerOptions === null || typeof trackerOptions !== "object" || Array.isArray(trackerOptions)
      || Object.keys(trackerOptions).some((key) => !TRACKER_FIELDS.has(key))) {
    throw new Error("historical-wall-profile: bounded geometry and explicit tracker options required");
  }
  const { minSize, multiplier = 1.5, gapRows = 2, keepEndedMs = 1200000,
    deepKeepEndedMs = keepEndedMs, maxLevels = 60, settleMs = 5000 } = trackerOptions;
  if (!bounded(minSize, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER)
      || !bounded(multiplier, 0, Number.MAX_SAFE_INTEGER) || !integer(gapRows, 0, 4096)
      || !integer(keepEndedMs, 1, 86400000) || !integer(deepKeepEndedMs, keepEndedMs, 86400000)
      || !integer(maxLevels, 1, 256) || !integer(settleMs, 0, 60000)) {
    throw new Error("historical-wall-profile: bounded tracker settings required");
  }
  const normalTick = tickSize.includes(".") ? tickSize.replace(/0+$/, "").replace(/\.$/, "") : tickSize;
  const tracker = Object.freeze({ minSize, multiplier, gapRows, keepEndedMs, deepKeepEndedMs, maxLevels, settleMs });
  const profile = Object.freeze({ schema: "historical-l2-wall-profile/1", method: "retained-engine-wall-service/1",
    tick_size: normalTick, sample_ms: sampleMs, row_clusters: rowClusters, window_rows: windowRows, reference_rows: referenceRows,
    fold, tracker });
  const id = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  return Object.freeze({ id, profile });
}

module.exports = { historicalWallProfile };
