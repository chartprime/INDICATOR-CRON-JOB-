const {
  createRuntimeHealthMonitor,
  DEFAULT_MAX_EVENT_LOOP_DELAY_MS,
} = require("../../src/platform/runtime-health-monitor");

describe("runtime-health-monitor", () => {
  test("does not report an unstarted or stopped monitor as healthy", () => {
    const monitor = createRuntimeHealthMonitor();
    expect(monitor.getStats().eventLoopHealthy).toBe(false);
    monitor.start();
    expect(monitor.getStats()).toMatchObject({ eventLoopHealthy: false, eventLoopSamples: 0 });
    monitor.sample();
    expect(monitor.getStats().eventLoopHealthy).toBe(true);
    monitor.stop();
    expect(monitor.getStats().eventLoopHealthy).toBe(false);
  });

  test("samples bounded event-loop metrics and exposes an explicit health result", async () => {
    const monitor = createRuntimeHealthMonitor({ resolutionMs: 10, sampleIntervalMs: 1000 });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    monitor.sample();
    const stats = monitor.getStats();
    monitor.stop();

    expect(stats.eventLoopMaxDelayMs).toBeGreaterThanOrEqual(0);
    expect(stats.eventLoopP99DelayMs).toBeGreaterThanOrEqual(0);
    expect(stats.eventLoopUtilizationPct).toBeGreaterThanOrEqual(0);
    expect(stats.eventLoopSampleLagMs).toBeGreaterThanOrEqual(0);
    expect(stats.eventLoopSamples).toBe(1);
    expect(stats.eventLoopSampleAgeMs).toEqual(expect.any(Number));
    expect(stats.processRssBytes).toBeGreaterThan(0);
    expect(stats.processHeapUsedBytes).toBeGreaterThan(0);
    expect(stats.processCpuUserMicros).toBeGreaterThanOrEqual(0);
    expect(stats.processFsReadOps).toBeGreaterThanOrEqual(0);
    expect(stats.processFsWriteOps).toBeGreaterThanOrEqual(0);
    expect(stats.processVoluntaryContextSwitches).toBeGreaterThanOrEqual(0);
    expect(stats.processInvoluntaryContextSwitches).toBeGreaterThanOrEqual(0);
    expect(stats.processCpuSystemMicros).toBeGreaterThanOrEqual(0);
    expect(stats.processHeapTotalBytes).toBeGreaterThanOrEqual(stats.processHeapUsedBytes);
    expect(stats.processExternalBytes).toBeGreaterThanOrEqual(0);
    expect(stats.processArrayBuffersBytes).toBeGreaterThanOrEqual(0);
    expect(stats.gcCount).toBeGreaterThanOrEqual(0);
    expect(stats.gcTotalDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.gcMaxDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof stats.eventLoopHealthy).toBe("boolean");
  });

  test("rejects invalid sampling controls and exports the institutional delay ceiling", () => {
    expect(DEFAULT_MAX_EVENT_LOOP_DELAY_MS).toBe(1_000);
    expect(() => createRuntimeHealthMonitor({ resolutionMs: 0 })).toThrow(/resolutionMs/);
    expect(() => createRuntimeHealthMonitor({ sampleIntervalMs: 0 })).toThrow(/sampleIntervalMs/);
    expect(() => createRuntimeHealthMonitor({ maxEventLoopDelayMs: 0 })).toThrow(/maxEventLoopDelayMs/);
  });

  test("clears timer lag after a recovered sampling interval", () => {
    const now = jest.spyOn(Date, "now");
    const monitor = createRuntimeHealthMonitor({ resolutionMs: 10, sampleIntervalMs: 1_000 });

    now.mockReturnValue(0);
    monitor.start();
    now.mockReturnValue(1_800);
    monitor.sample();
    expect(monitor.getStats().eventLoopSampleLagMs).toBeGreaterThanOrEqual(800);

    now.mockReturnValue(2_800);
    monitor.sample();
    expect(monitor.getStats().eventLoopSampleLagMs).toBeLessThan(500);

    monitor.stop();
    now.mockRestore();
  });

  test("resets stale sample state across a restart", () => {
    const monitor = createRuntimeHealthMonitor({ resolutionMs: 10, sampleIntervalMs: 1_000 });
    monitor.start();
    monitor.sample();
    expect(monitor.getStats()).toMatchObject({ eventLoopHealthy: true, eventLoopSamples: 1 });
    monitor.stop();

    monitor.start();
    expect(monitor.getStats()).toMatchObject({ eventLoopHealthy: false, eventLoopSamples: 0 });
    monitor.stop();
  });
});
