const { createCollectorCapacityGuard } = require("../../src/storage/collector-capacity-guard");

describe("collector-capacity-guard", () => {
  test("does not stop for a transient backlog breach and resets its elapsed duration after recovery", () => {
    let now = 1_000;
    const guard = createCollectorCapacityGuard({
      maxPendingWriteItems: 10_000,
      breachDurationMs: 2_000,
      now: () => now,
    });

    expect(guard.observe({ pendingWriteItems: 10_001 })).toMatchObject({
      breached: true, shouldStop: false, breachDurationMs: 0,
    });
    expect(guard.getStats()).toMatchObject({ capacityBreached: true, capacityBreachDurationMs: 0 });
    now += 1_999;
    expect(guard.observe({ pendingWriteItems: 10_001 })).toMatchObject({
      breached: true, shouldStop: false, breachDurationMs: 1_999,
    });
    expect(guard.observe({ pendingWriteItems: 0 })).toMatchObject({
      breached: false, shouldStop: false, breachDurationMs: 0,
    });
    now += 2_000;
    expect(guard.observe({ pendingWriteItems: 10_001 })).toMatchObject({
      breached: true, shouldStop: false, breachDurationMs: 0,
    });
  });

  test("requests a fail-closed shutdown only after a sustained measured breach", () => {
    let now = 5_000;
    const guard = createCollectorCapacityGuard({
      maxBackpressurePending: 100,
      breachDurationMs: 3_000,
      now: () => now,
    });

    guard.observe({ backpressurePending: 101 });
    now += 2_999;
    expect(guard.observe({ backpressurePending: 101 })).toEqual(expect.objectContaining({
      breached: true,
      shouldStop: false,
      breachDurationMs: 2_999,
      reason: "market-data backlog exceeded 100 events",
    }));
    now += 1;
    expect(guard.observe({ backpressurePending: 101 })).toEqual(expect.objectContaining({
      breached: true,
      shouldStop: true,
      breachDurationMs: 3_000,
      reason: "market-data backlog exceeded 100 events",
    }));
  });

  test("guards ingress queue age separately from queue depth and durable-write age", () => {
    const guard = createCollectorCapacityGuard({
      maxPendingIngressEnvelopes: 100,
      maxOldestIngressAgeMs: 50,
      breachDurationMs: 1,
    });

    expect(guard.observe({ pendingIngressEnvelopes: 100, storageIngressOldestAgeMs: 51 }, 10)).toEqual(expect.objectContaining({
      shouldStop: false,
      reason: "oldest storage ingress envelope exceeded 50ms",
    }));
  });

  test("guards raw ingress depth and age before downstream queues are affected", () => {
    const depthGuard = createCollectorCapacityGuard({
      maxRawIngressPending: 100,
      breachDurationMs: 1,
    });
    expect(depthGuard.observe({ rawIngressPending: 101 })).toMatchObject({
      breached: true,
      reason: "raw market-data ingress exceeded 100 frames",
    });

    const ageGuard = createCollectorCapacityGuard({
      maxOldestRawIngressAgeMs: 50,
      breachDurationMs: 1,
    });
    expect(ageGuard.observe({ rawIngressPending: 1, rawIngressOldestAgeMs: 51 })).toMatchObject({
      breached: true,
      reason: "oldest raw market-data frame exceeded 50ms",
    });

    const bytesGuard = createCollectorCapacityGuard({
      maxRawIngressPendingBytes: 1_000,
      breachDurationMs: 1,
    });
    expect(bytesGuard.observe({ rawIngressPending: 1, rawIngressPendingBytes: 1_001 })).toMatchObject({
      breached: true,
      reason: "raw market-data ingress exceeded 1000 bytes",
    });
  });

  test("treats low disk reserve and an oversized live database as fail-closed capacity conditions", () => {
    const diskGuard = createCollectorCapacityGuard({ minFreeDiskBytes: 1_000, breachDurationMs: 1 });
    expect(diskGuard.observe({ freeDiskBytes: 999, dbSizeBytes: 100 }, 10)).toMatchObject({
      breached: true,
      reason: "free disk below required reserve of 1000 bytes",
    });

    const sizeGuard = createCollectorCapacityGuard({ minFreeDiskBytes: 1, maxDbBytes: 1_000, breachDurationMs: 1 });
    expect(sizeGuard.observe({ freeDiskBytes: 10_000, dbSizeBytes: 1_001 }, 10)).toMatchObject({
      breached: true,
      reason: "live database exceeded maximum size of 1000 bytes",
    });
  });

  test("treats an unavailable capacity probe as a sustained fail-closed condition", () => {
    const guard = createCollectorCapacityGuard({ breachDurationMs: 100 });
    expect(guard.observe({ diskProbeHealthy: false, schedulerHealthy: true }, 1_000)).toMatchObject({
      breached: true,
      shouldStop: false,
      reason: "storage capacity probe unavailable",
    });
    expect(guard.observe({ diskProbeHealthy: false, schedulerHealthy: true }, 1_100)).toMatchObject({
      shouldStop: true,
    });
  });

  test("recognizes rising free disk as recovery progress and never mistakes falling free disk for progress", () => {
    const guard = createCollectorCapacityGuard({ minFreeDiskBytes: 1_000, breachDurationMs: 100 });
    guard.observe({ freeDiskBytes: 900, dbSizeBytes: 100, schedulerHealthy: true }, 1_000);
    expect(guard.observe({ freeDiskBytes: 800, dbSizeBytes: 110, schedulerHealthy: true }, 1_100)).toMatchObject({
      shouldStop: true,
      noProgressDurationMs: 100,
    });

    const recovering = createCollectorCapacityGuard({ minFreeDiskBytes: 1_000, breachDurationMs: 100 });
    recovering.observe({ freeDiskBytes: 800, dbSizeBytes: 100, schedulerHealthy: true }, 2_000);
    expect(recovering.observe({ freeDiskBytes: 900, dbSizeBytes: 100, schedulerHealthy: true }, 2_100)).toMatchObject({
      shouldStop: false,
      noProgressDurationMs: 0,
    });
  });

  test("persistent event-loop unhealth terminates after grace even when another breach has priority", () => {
    const guard = createCollectorCapacityGuard({ maxPendingWriteItems: 10, breachDurationMs: 100 });
    expect(guard.observe({ pendingWriteItems: 11, schedulerHealthy: false }, 1_000)).toMatchObject({
      breached: true,
      shouldStop: false,
      schedulerBreachDurationMs: 0,
    });
    expect(guard.observe({ pendingWriteItems: 12, schedulerHealthy: false }, 1_100)).toMatchObject({
      shouldStop: true,
      schedulerBreachDurationMs: 100,
      reason: "event-loop health remained below the collector safety threshold",
    });
  });

  test("keeps a bounded post-stall catch-up alive while ingress backlog is making measurable progress", () => {
    let now = 10_000;
    const guard = createCollectorCapacityGuard({
      maxOldestIngressAgeMs: 60_000,
      breachDurationMs: 30_000,
      now: () => now,
    });

    guard.observe({ pendingIngressEnvelopes: 3_000, storageIngressOldestAgeMs: 180_000 });
    now += 30_000;
    expect(guard.observe({ pendingIngressEnvelopes: 2_000, storageIngressOldestAgeMs: 190_000 })).toMatchObject({
      breached: true,
      shouldStop: false,
      breachDurationMs: 30_000,
      noProgressDurationMs: 0,
    });
    now += 30_000;
    expect(guard.observe({ pendingIngressEnvelopes: 1_000, storageIngressOldestAgeMs: 120_000 })).toMatchObject({
      shouldStop: false,
      noProgressDurationMs: 0,
    });
    now += 29_999;
    expect(guard.observe({ pendingIngressEnvelopes: 1_000, storageIngressOldestAgeMs: 149_999 })).toMatchObject({
      shouldStop: false,
      noProgressDurationMs: 29_999,
    });
    now += 1;
    expect(guard.observe({ pendingIngressEnvelopes: 1_000, storageIngressOldestAgeMs: 150_000 })).toMatchObject({
      shouldStop: true,
      noProgressDurationMs: 30_000,
    });
  });

  test("a different active capacity constraint receives its own grace interval", () => {
    let now = 1_000;
    const guard = createCollectorCapacityGuard({
      maxPendingIngressEnvelopes: 100,
      maxBackpressurePending: 100,
      breachDurationMs: 1_000,
      now: () => now,
    });

    guard.observe({ pendingIngressEnvelopes: 101 });
    now += 999;
    expect(guard.observe({ pendingIngressEnvelopes: 101 })).toMatchObject({ shouldStop: false });
    now += 1;
    expect(guard.observe({ backpressurePending: 101 })).toMatchObject({
      shouldStop: false,
      breachDurationMs: 0,
    });
  });

  test("does not treat time spent in a frozen scheduler as observed no-progress time", () => {
    let now = 1_000;
    const guard = createCollectorCapacityGuard({
      maxOldestPendingAgeMs: 100,
      breachDurationMs: 1_000,
      now: () => now,
    });

    guard.observe({ pendingWriteItems: 10, storageOldestPendingAgeMs: 101, schedulerHealthy: true });
    now += 60_000;
    expect(guard.observe({
      pendingWriteItems: 20,
      storageOldestPendingAgeMs: 60_101,
      schedulerHealthy: false,
    })).toMatchObject({
      breached: true,
      shouldStop: false,
      noProgressDurationMs: 0,
      schedulerSuspended: true,
    });
    now += 999;
    expect(guard.observe({
      pendingWriteItems: 20,
      storageOldestPendingAgeMs: 61_100,
      schedulerHealthy: true,
    })).toMatchObject({ shouldStop: false, noProgressDurationMs: 999 });
    now += 1;
    expect(guard.observe({
      pendingWriteItems: 20,
      storageOldestPendingAgeMs: 61_101,
      schedulerHealthy: true,
    })).toMatchObject({ shouldStop: true, noProgressDurationMs: 1_000 });
  });

  test("rejects malformed safety limits", () => {
    expect(() => createCollectorCapacityGuard({ maxPendingWriteItems: 0 })).toThrow(/maxPendingWriteItems/);
    expect(() => createCollectorCapacityGuard({ maxPendingIngressEnvelopes: 0 })).toThrow(/maxPendingIngressEnvelopes/);
    expect(() => createCollectorCapacityGuard({ maxOldestPendingAgeMs: 0 })).toThrow(/maxOldestPendingAgeMs/);
    expect(() => createCollectorCapacityGuard({ maxOldestIngressAgeMs: 0 })).toThrow(/maxOldestIngressAgeMs/);
    expect(() => createCollectorCapacityGuard({ maxBackpressurePending: 0 })).toThrow(/maxBackpressurePending/);
    expect(() => createCollectorCapacityGuard({ maxRawIngressPending: 0 })).toThrow(/maxRawIngressPending/);
    expect(() => createCollectorCapacityGuard({ maxRawIngressPendingBytes: 0 })).toThrow(/maxRawIngressPendingBytes/);
    expect(() => createCollectorCapacityGuard({ maxOldestRawIngressAgeMs: 0 })).toThrow(/maxOldestRawIngressAgeMs/);
    expect(() => createCollectorCapacityGuard({ breachDurationMs: 0 })).toThrow(/breachDurationMs/);
    expect(() => createCollectorCapacityGuard({ minFreeDiskBytes: 0 })).toThrow(/minFreeDiskBytes/);
    expect(() => createCollectorCapacityGuard({ maxDbBytes: 0 })).toThrow(/maxDbBytes/);
    expect(() => createCollectorCapacityGuard({ now: 0 })).toThrow(/now/);
  });
});

// Report 57 W2, FA-7: the Binance capture database grows about 8.8 GB a day
// and the guard's only response to its size cap is to stop capture after a
// 30 s grace (it did so on 2026-09-17 at the old 64 GiB cap). The guard now
// reports how full the database is, and the collectors log each 80 % and 90 %
// crossing once, so an operator hears about it days before capture stops.
describe("collector-capacity-guard early warning (FA-7)", () => {
  const { dbCapacityTransition } = require("../../src/storage/collector-capacity-guard");
  const GIB = 1024 * 1024 * 1024;

  test("every observation reports the database fill level against the cap", () => {
    const guard = createCollectorCapacityGuard({ maxDbBytes: 100 * GIB, now: () => 1_000 });
    expect(guard.observe({ dbSizeBytes: 79 * GIB }).dbFill).toEqual({ ratio: 0.79, level: null });
    expect(guard.observe({ dbSizeBytes: 85 * GIB }).dbFill).toEqual({ ratio: 0.85, level: 0.8 });
    expect(guard.observe({ dbSizeBytes: 95 * GIB }).dbFill).toEqual({ ratio: 0.95, level: 0.9 });
    expect(guard.observe({ dbSizeBytes: 101 * GIB }).dbFill).toEqual({ ratio: 1.01, level: 0.9 });
    expect(guard.observe({}).dbFill).toBeNull();
  });

  test("a crossing is announced once per level, upward as a warning and downward as a recovery", () => {
    expect(dbCapacityTransition(null, { ratio: 0.5, level: null })).toEqual({ level: null, announce: null });
    expect(dbCapacityTransition(null, { ratio: 0.81, level: 0.8 })).toEqual({ level: 0.8, announce: "APPROACHING" });
    expect(dbCapacityTransition(0.8, { ratio: 0.82, level: 0.8 })).toEqual({ level: 0.8, announce: null });
    expect(dbCapacityTransition(0.8, { ratio: 0.91, level: 0.9 })).toEqual({ level: 0.9, announce: "APPROACHING" });
    expect(dbCapacityTransition(0.9, { ratio: 0.5, level: null })).toEqual({ level: null, announce: "RECOVERED" });
    expect(dbCapacityTransition(0.9, null)).toEqual({ level: 0.9, announce: null });
  });
});
