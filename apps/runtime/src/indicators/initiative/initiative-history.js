"use strict";

const { readHours, probeBack, HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY } = require("../exhaustion/exhaustion-history");
const { CANDLE_MS } = require("../exhaustion/exhaustion-engine");

const GROUPS = Object.freeze([
  Object.freeze({ maxMs: 180_000, warm: 5, after: 1 }),
  Object.freeze({ maxMs: 300_000, warm: 6, after: 2 }),
  Object.freeze({ maxMs: 900_000, warm: 9, after: 5 }),
  Object.freeze({ maxMs: SHORT_MAX_MS, warm: 14, after: 8 }),
]);

function groupOf(candleMs) {
  if (!CANDLE_MS.includes(candleMs) || candleMs > SHORT_MAX_MS) return null;
  return GROUPS.find((group) => candleMs <= group.maxMs);
}

function isShort(candleMs) {
  return groupOf(candleMs) !== null;
}

function warmHours(lengths) {
  return Math.max(0, ...lengths.map((candleMs) => groupOf(candleMs)?.warm ?? 0));
}

function afterHours(lengths) {
  return Math.max(0, ...lengths.map((candleMs) => groupOf(candleMs)?.after ?? 0));
}

module.exports = { readHours, probeBack, groupOf, isShort, warmHours, afterHours, GROUPS, HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY };
