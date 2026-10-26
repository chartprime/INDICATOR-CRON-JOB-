const {
  assessLiveEventTime,
  MAX_LIVE_EVENT_FUTURE_SKEW_MS,
} = require("../../../src/providers/shared/live-event-time-policy");

// This module gates every live Binance event and every dxFeed bar, and had no
// test file of its own until L1L2-V2-009. It also used to carry an
// `enforceMaxAge`/`MAX_LIVE_EVENT_AGE_MS` branch that no caller could reach:
// the flag defaulted false, nothing set it, and `EVENT_TIME_TOO_OLD` appeared
// exactly once in the repo -- at its own definition. Phase 2 removed it rather
// than wiring it, because neither provider replays old prints on a live socket
// (Binance REST backfill validates grid alignment in parseKlineRows instead,
// and dxFeed STREAM is live-only), and enabling it would have let a forward NTP
// correction reject genuinely live data. These tests pin what the module
// actually promises, so the guarantee is no longer only inferable from callers.

const NOW = 1_800_000_000_000;

describe("assessLiveEventTime", () => {
  test("accepts an event at, just before, and slightly after receipt time", () => {
    expect(assessLiveEventTime(NOW, NOW)).toEqual({ ok: true, reason: null });
    expect(assessLiveEventTime(NOW - 5_000, NOW)).toEqual({ ok: true, reason: null });
    expect(assessLiveEventTime(NOW + 1_000, NOW)).toEqual({ ok: true, reason: null });
  });

  test("accepts an arbitrarily old event, which is the deliberate post-L1L2-V2-009 behaviour", () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    expect(assessLiveEventTime(NOW - thirtyDaysMs, NOW)).toEqual({ ok: true, reason: null });
  });

  test("rejects an event beyond the future-skew bound, and accepts one exactly on it", () => {
    expect(assessLiveEventTime(NOW + MAX_LIVE_EVENT_FUTURE_SKEW_MS, NOW))
      .toEqual({ ok: true, reason: null });
    expect(assessLiveEventTime(NOW + MAX_LIVE_EVENT_FUTURE_SKEW_MS + 1, NOW))
      .toEqual({ ok: false, reason: "EVENT_TIME_TOO_FAR_IN_FUTURE" });
  });

  test("honours a caller-supplied skew bound", () => {
    expect(assessLiveEventTime(NOW + 5_000, NOW, { maxFutureSkewMs: 1_000 }))
      .toEqual({ ok: false, reason: "EVENT_TIME_TOO_FAR_IN_FUTURE" });
    expect(assessLiveEventTime(NOW + 5_000, NOW, { maxFutureSkewMs: 10_000 }))
      .toEqual({ ok: true, reason: null });
  });

  test("rejects non-safe, non-positive, and non-integer epoch values on either argument", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "1800000000000", null, undefined]) {
      expect(assessLiveEventTime(bad, NOW)).toEqual({ ok: false, reason: "EVENT_TIME_INVALID" });
      expect(assessLiveEventTime(NOW, bad)).toEqual({ ok: false, reason: "EVENT_TIME_INVALID" });
    }
  });

  test("throws on an invalid skew bound rather than silently ignoring it", () => {
    expect(() => assessLiveEventTime(NOW, NOW, { maxFutureSkewMs: -1 })).toThrow(/time bounds/);
    expect(() => assessLiveEventTime(NOW, NOW, { maxFutureSkewMs: 1.5 })).toThrow(/time bounds/);
  });

  test("returns a frozen result so a caller cannot mutate a shared verdict", () => {
    const result = assessLiveEventTime(NOW, NOW);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("no longer exposes the unreachable max-age branch", () => {
    const policy = require("../../../src/providers/shared/live-event-time-policy");
    expect(policy.MAX_LIVE_EVENT_AGE_MS).toBeUndefined();
    // An old caller passing the removed options must not silently change behaviour.
    expect(assessLiveEventTime(NOW - 1_000_000_000, NOW, { enforceMaxAge: true, maxAgeMs: 1 }))
      .toEqual({ ok: true, reason: null });
  });
});
