const MAX_LIVE_EVENT_FUTURE_SKEW_MS = 120_000;

function isSafeEpochMs(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assessLiveEventTime(eventTimeMs, receivedAtMs, {
  maxFutureSkewMs = MAX_LIVE_EVENT_FUTURE_SKEW_MS,
} = {}) {
  if (!isSafeEpochMs(eventTimeMs) || !isSafeEpochMs(receivedAtMs)) {
    return Object.freeze({ ok: false, reason: "EVENT_TIME_INVALID" });
  }
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new Error("live-event-time-policy: time bounds must be non-negative safe integers");
  }
  if (eventTimeMs > receivedAtMs + maxFutureSkewMs) {
    return Object.freeze({ ok: false, reason: "EVENT_TIME_TOO_FAR_IN_FUTURE" });
  }
  return Object.freeze({ ok: true, reason: null });
}

module.exports = {
  MAX_LIVE_EVENT_FUTURE_SKEW_MS,
  assessLiveEventTime,
};
