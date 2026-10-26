const { alignPeriodStart, deriveBucketingParams } = require("./volume-profile-setup");
const { createSession, seedSessionFromStorage } = require("./volume-profile-engine");

async function buildAlignedProfileSession({ adapter, tickSize, periodMs, binSizeMultiplier, nowMs, referenceLookbackMs }) {
  const periodStartTs = alignPeriodStart(nowMs, periodMs);
  const range = await adapter.readPriceRange(Math.max(0, nowMs - referenceLookbackMs), nowMs);
  if (!range.available) throw new Error("PROFILE_REFERENCE_UNAVAILABLE");
  const params = await deriveBucketingParams({
    adapter: { readPriceRange: async () => range }, tickSize,
    fromTs: Math.max(0, nowMs - referenceLookbackMs), toTs: nowMs, binSizeMultiplier,
  });
  if (params === null) return null;
  const session = createSession({ periodStartTs, originPrice: params.originPrice, rowWidth: params.rowWidth });
  const seedToTs = Math.floor(nowMs / 60_000) * 60_000;
  if (seedToTs > periodStartTs && !await seedSessionFromStorage(session, adapter, seedToTs)) {
    throw new Error("PROFILE_SEED_UNAVAILABLE");
  }
  return session;
}

function createProfilePollPolicy({ now, retryMs = 15_000, maxRetryMs = 60_000 }) {
  let status = "WARMING";
  let retryAt = 0;
  let failures = 0;
  let lastFailure = null;
  return {
    allow(open) {
      if (!open) { status = "CLOSED"; retryAt = 0; return false; }
      if (status === "CLOSED") { status = "WARMING"; retryAt = 0; }
      return now() >= retryAt;
    },
    settle(next) {
      status = next;
      failures = 0;
      lastFailure = null;
      retryAt = next === "EMPTY" ? now() + retryMs : 0;
    },
    fail(error) {
      const reason = error?.message ?? String(error);
      const changed = reason !== lastFailure;
      lastFailure = reason;
      status = "UNAVAILABLE";
      retryAt = now() + Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures, 8));
      failures += 1;
      return changed;
    },
    get status() { return status; },
  };
}

module.exports = { buildAlignedProfileSession, createProfilePollPolicy };
