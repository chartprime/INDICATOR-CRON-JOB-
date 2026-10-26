const { createOperationalReadiness, STATES, REASONS } = require("../../src/server/operational-readiness");

describe("server/operational-readiness", () => {
  test("publishes bounded, deterministic transition snapshots and durations", () => {
    let at = 1_000;
    const log = jest.fn();
    const readiness = createOperationalReadiness({ now: () => at, log });
    readiness.transition("binance.spot.btcusdt.candles", "RUNNING", { reason: "IN_PROGRESS", metrics: { pages: 1 } });
    at = 1_250;
    readiness.transition("binance.spot.btcusdt.candles", "READY", { metrics: { pages: 2 } });
    expect(readiness.snapshot()).toEqual({
      "binance.spot.btcusdt.candles": {
        feature: "binance.spot.btcusdt.candles", state: "READY", reason: null,
        updatedAt: 1_250, startedAt: 1_000, durationMs: 250, metrics: { pages: 2 },
      },
    });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("does not log duplicate state/reason and rejects stale generations", () => {
    const log = jest.fn();
    const readiness = createOperationalReadiness({ now: () => 2_000, log });
    const generation = readiness.beginGeneration();
    expect(readiness.transition("dxfeed.future.nq.candles", "RUNNING", { reason: "IN_PROGRESS", generation })).toBe(true);
    expect(readiness.transition("dxfeed.future.nq.candles", "RUNNING", { reason: "IN_PROGRESS", generation })).toBe(true);
    readiness.beginGeneration();
    expect(readiness.transition("dxfeed.future.nq.candles", "READY", { generation })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readiness.snapshot()["dxfeed.future.nq.candles"].state).toBe("RUNNING");
  });

  test("keeps states and reasons governed", () => {
    expect(STATES).toEqual(["DISABLED", "IDLE", "STARTING", "RUNNING", "READY", "DEGRADED", "UNAVAILABLE", "FAILED"]);
    expect(REASONS).toContain("DISABLED_BY_CONFIG");
    const readiness = createOperationalReadiness();
    expect(() => readiness.transition("valid.feature", "BROKEN")).toThrow(/state is invalid/);
    expect(() => readiness.transition("valid.feature", "FAILED", { reason: "FREE_TEXT" })).toThrow(/reason is invalid/);
  });
});
