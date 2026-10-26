const { monitorEventLoopDelay, performance, PerformanceObserver } = require("node:perf_hooks");

const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_MAX_EVENT_LOOP_DELAY_MS = 1_000;

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? value / 1_000_000 : 0;
}

function createRuntimeHealthMonitor({
  resolutionMs = DEFAULT_RESOLUTION_MS,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxEventLoopDelayMs = DEFAULT_MAX_EVENT_LOOP_DELAY_MS,
} = {}) {
  for (const [name, value] of [
    ["resolutionMs", resolutionMs],
    ["sampleIntervalMs", sampleIntervalMs],
    ["maxEventLoopDelayMs", maxEventLoopDelayMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`runtime-health-monitor: ${name} must be a positive safe integer`);
    }
  }

  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  let timer = null;
  let running = false;
  let priorUtilization = performance.eventLoopUtilization();
  let maxDelayMs = 0;
  let p99DelayMs = 0;
  let timerLagMs = 0;
  let utilizationPct = 0;
  let lastSampleAt = null;
  let samplesTaken = 0;
  let gcObserver = null;
  let gcCount = 0;
  let gcTotalDurationMs = 0;
  let gcMaxDurationMs = 0;

  function sample() {
    if (!running) return null;
    const now = Date.now();
    timerLagMs = lastSampleAt === null
      ? 0
      : Math.max(0, now - lastSampleAt - sampleIntervalMs);
    const utilization = performance.eventLoopUtilization(priorUtilization);
    priorUtilization = performance.eventLoopUtilization();
    utilizationPct = Math.max(0, Math.min(100, utilization.utilization * 100));
    maxDelayMs = Math.max(nanosecondsToMilliseconds(histogram.max), timerLagMs);
    p99DelayMs = nanosecondsToMilliseconds(histogram.percentile(99));
    histogram.reset();
    lastSampleAt = now;
    samplesTaken += 1;
    return getStats();
  }

  function start() {
    if (timer) return;
    priorUtilization = performance.eventLoopUtilization();
    histogram.reset();
    histogram.enable();
    maxDelayMs = 0;
    p99DelayMs = 0;
    timerLagMs = 0;
    utilizationPct = 0;
    samplesTaken = 0;
    gcCount = 0;
    gcTotalDurationMs = 0;
    gcMaxDurationMs = 0;
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcCount += 1;
        gcTotalDurationMs += entry.duration;
        gcMaxDurationMs = Math.max(gcMaxDurationMs, entry.duration);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    lastSampleAt = Date.now();
    running = true;
    timer = setInterval(sample, sampleIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    histogram.disable();
    gcObserver?.disconnect();
    gcObserver = null;
    running = false;
  }

  function getStats() {
    const sampleAgeMs = lastSampleAt === null ? null : Math.max(0, Date.now() - lastSampleAt);
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const resources = process.resourceUsage();
    return Object.freeze({
      eventLoopMaxDelayMs: Math.round(maxDelayMs),
      eventLoopP99DelayMs: Math.round(p99DelayMs),
      eventLoopUtilizationPct: Number(utilizationPct.toFixed(1)),
      eventLoopSamples: samplesTaken,
      eventLoopSampleAgeMs: sampleAgeMs,
      eventLoopSampleLagMs: Math.round(timerLagMs),
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
      processHeapTotalBytes: memory.heapTotal,
      processExternalBytes: memory.external,
      processArrayBuffersBytes: memory.arrayBuffers,
      processCpuUserMicros: cpu.user,
      processCpuSystemMicros: cpu.system,
      processFsReadOps: resources.fsRead,
      processFsWriteOps: resources.fsWrite,
      processVoluntaryContextSwitches: resources.voluntaryContextSwitches,
      processInvoluntaryContextSwitches: resources.involuntaryContextSwitches,
      gcCount,
      gcTotalDurationMs: Number(gcTotalDurationMs.toFixed(1)),
      gcMaxDurationMs: Number(gcMaxDurationMs.toFixed(1)),
      eventLoopHealthy: running && samplesTaken > 0 && maxDelayMs <= maxEventLoopDelayMs &&
        (sampleAgeMs === null || sampleAgeMs <= sampleIntervalMs * 2),
    });
  }

  return Object.freeze({ start, stop, sample, getStats });
}

module.exports = {
  createRuntimeHealthMonitor,
  DEFAULT_RESOLUTION_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_MAX_EVENT_LOOP_DELAY_MS,
};
