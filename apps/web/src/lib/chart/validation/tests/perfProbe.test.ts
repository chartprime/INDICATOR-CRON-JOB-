import { afterEach, describe, expect, it } from "vitest";
import { l2FeedStatusIndicator } from "../../../indicators/l2-feed-status/l2FeedStatus";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { MAX_RETAINED_SOURCE_BARS } from "../../candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";
import { fakeL2, ladderOf } from "../fakeL2";
import { trendBars } from "../fixtures";
import {
  formatFormingBarProbe,
  formatReplayProbe,
  formatRolloverProbe,
  percentilesOf,
  probeFormingBar,
  probeReplay,
  probeRollover,
} from "../perfProbe";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** Keeps every bar it has ever seen on its state: the leak the rollover probe exists to show. */
const hoarder: RuntimeIndicatorDef<{ seen: object[]; value: number }, Record<string, never>> = {
  kind: "runtime",
  id: "hoarder",
  label: "Hoarder",
  category: "technical",
  defaultSettings: {},
  lines: [{ key: "value" }],
  placement: { kind: "overlay" },
  createState: () => ({ seen: [], value: 0 }),
  onBar: (ctx) => {
    ctx.state.seen.push({ ...ctx.bar, padding: new Array(64).fill(ctx.bar.close) });
    ctx.state.value = ctx.state.seen.length;
    if (ctx.bar.closed) ctx.markers.plotshape({ shape: "circle" });
  },
  readOutput: (state) => ({ value: state.value }),
};

describe("percentiles", () => {
  it("reports p50, p90, p99 and max of the samples", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    const p = percentilesOf(samples);
    expect(p).toMatchObject({ count: 100, p50: 50, p90: 90, p99: 99, max: 100, mean: 50.5, totalMs: 5050 });
    expect(percentilesOf([])).toMatchObject({ count: 0, p50: 0, p99: 0 });
  });
});

describe("perf probes", () => {
  it("times every onBar of a replay and reports a heap reading", () => {
    const { bars } = trendBars({ count: 2_000 });
    const probe = probeReplay(rsiIndicator, bars, { length: 14 });
    expect(probe.id).toBe("rsi");
    expect(probe.bars).toBe(2_000);
    expect(probe.onBar.count).toBe(2_000);
    expect(probe.onBar.p50).toBeLessThanOrEqual(probe.onBar.p99);
    expect(probe.onBar.p99).toBeLessThanOrEqual(probe.onBar.max);
    expect(probe.wallMs).toBeGreaterThanOrEqual(probe.onBar.totalMs);
    expect(Number.isFinite(probe.heap.deltaBytes)).toBe(true);
    expect(typeof probe.heap.gcExposed).toBe("boolean");
    expect(probe.faulted).toBe(false);
    expect(formatReplayProbe(probe)).toMatch(/^rsi replay 2000 bars: onBar p50 /);
  });

  it("revises one forming bar at the requested rate with prints landing in the store and in ctx.trades", () => {
    const { bars } = trendBars({ count: 30 });
    const probe = probeFormingBar(rsiIndicator, bars, { length: 14 }, { seconds: 2, revisionsPerSecond: 50, printsPerMinute: 1_200 });
    expect(probe.revisions).toBe(100);
    expect(probe.prints).toBe(40);
    // 30 replayed bars plus 100 revisions.
    expect(probe.onBar.count).toBe(130);
    expect(probe.faulted).toBe(false);
    expect(formatFormingBarProbe(probe)).toContain("forming bar 100 revisions, 40 prints");
  });

  it("the forming probe hands an L2 indicator its fake book", () => {
    const { bars } = trendBars({ count: 5 });
    const probe = probeFormingBar(l2FeedStatusIndicator, bars, {}, { seconds: 1, revisionsPerSecond: 10, printsPerMinute: 60, extras: { l2: fakeL2({ ladder: ladderOf(60_000, 5, 1, 1) }) } });
    expect(probe.revisions).toBe(10);
    expect(probe.faulted).toBe(false);
    expect(probe.onBar.count).toBe(15);
  });

  it("rolls the chart past its retention cap and shows what the indicator keeps", () => {
    const { bars } = trendBars({ count: MAX_RETAINED_SOURCE_BARS });
    const probe = probeRollover(rsiIndicator, bars, { length: 14 }, { extraBars: 50 });
    expect(probe.retainedBars).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(probe.discarded).toBe(50);
    expect(probe.outputLengths).toEqual({ value: MAX_RETAINED_SOURCE_BARS });
    expect(probe.markersBeforeRetention).toBe(0);
    expect(probe.onBar.count).toBe(50);
    expect(formatRolloverProbe(probe)).toContain("rollover +50 bars: retained 10080");
  });

  it("shows a hoarder growing per bar while the runtime's own caches stay bounded", () => {
    const { bars } = trendBars({ count: MAX_RETAINED_SOURCE_BARS });
    const probe = probeRollover(hoarder, bars, {}, { extraBars: 200 });
    expect(probe.outputLengths).toEqual({ value: MAX_RETAINED_SOURCE_BARS });
    expect(probe.markersRetained).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(probe.markersBeforeRetention).toBe(0);
    // The state itself kept every bar: visible in the output, which counts them.
    const session = probeReplay(hoarder, bars.slice(0, 10), {});
    expect(session.onBar.count).toBe(10);
    if (probe.heap.gcExposed) expect(probe.bytesPerExtraBar).toBeGreaterThan(0);
  });
});
