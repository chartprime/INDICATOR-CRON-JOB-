const DAY_MS = 24 * 60 * 60 * 1000;

function assertSafeNonNegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`archive-schedule: ${name} must be a safe non-negative integer`);
  }
}

function dayStartMs(nowMs) {
  assertSafeNonNegativeInteger("nowMs", nowMs);
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

module.exports = {
  DAY_MS,
  dayStartMs,
};
