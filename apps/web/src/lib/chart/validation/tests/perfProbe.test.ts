import { afterEach, describe, expect, it } from "vitest";
import { l2FeedStatusIndicator } from "../../../indicators/l2-feed-status/l2FeedStatus";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { MAX_RETAINED_SOURCE_BARS } from "../../candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";
import { barSides } from "../../../indicators/barSides";
import type { BarFrame } from "../../../../types/frames";
import { fakeL2, ladderOf } from "../fakeL2";
import type { IndicatorLiquidity } from "../../indicatorLiquidity";
import { MINUTE_MS, equityUnsidedBars, seeded, trendBars } from "../fixtures";
import {
  formatFormingBarProbe,
  formatPooledReplayProbe,
  formatReplayProbe,
  formatRolloverProbe,
  percentilesOf,
  probeFormingBar,
  probeReplay,
  probeReplayPooled,
  probeRollover,
  rolloverBar,
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

  it("rollover bars carry coherent sides through barSides (Codex finding 7)", () => {
    const random = seeded(1);
    const sidedLast = trendBars({ count: 1 }).bars[0];
    const { bars: equity, labels } = equityUnsidedBars({ count: 6 });
    const partial = equity[labels.partiallySidedIndices[0]];
    const unsided = equity[labels.unsidedIndices[0]];
    const buyOnly = { ...sidedLast } as BarFrame & { sell_volume?: number };
    delete buyOnly.sell_volume;

    let last = sidedLast;
    for (let index = 0; index < 50; index += 1) {
      const bar = rolloverBar(last, random);
      const sides = barSides(bar);
      expect(bar.ts_open).toBe(last.ts_open + last.interval_ms);
      expect(sides.known).toBe(true);
      // Two-decimal rounding of buy and sell can leave a float residue of 1e-14; that is arithmetic, not unknown volume.
      expect(sides.unknown).toBeCloseTo(0, 9);
      expect(sides.buy + sides.sell).toBeCloseTo(bar.volume, 6);
      expect(sides.buy).toBeGreaterThan(0);
      expect(sides.sell).toBeGreaterThan(0);
      last = bar;
    }
    const fromPartial = rolloverBar(partial, random);
    const partialSides = barSides(fromPartial);
    expect(partialSides.known).toBe(true);
    expect(partialSides.unknown / fromPartial.volume).toBeCloseTo(barSides(partial).unknown / partial.volume, 2);
    expect(partialSides.buy + partialSides.sell + partialSides.unknown).toBeCloseTo(fromPartial.volume, 6);
    const fromUnsided = rolloverBar(unsided, random);
    expect(barSides(fromUnsided).known).toBe(false);
    expect(fromUnsided.buy_volume).toBeUndefined();
    expect(fromUnsided.sell_volume).toBeUndefined();
    const fromBuyOnly = rolloverBar(buyOnly, random);
    expect(fromBuyOnly.sell_volume).toBeUndefined();
    expect(barSides(fromBuyOnly)).toMatchObject({ known: true, unknown: 0 });
  });

  it("the brief's pooled method: warm-ups untimed, timed runs pooled, onBar plus readOutput only", () => {
    const { bars } = trendBars({ count: 500 });
    let onBarCalls = 0;
    const counted: RuntimeIndicatorDef<unknown, unknown> = {
      ...(rsiIndicator as RuntimeIndicatorDef<unknown, unknown>),
      onBar: (ctx) => {
        onBarCalls += 1;
        rsiIndicator.onBar(ctx as never);
      },
    };
    const probe = probeReplayPooled(counted, bars, { length: 14 }, { warmupRuns: 2, timedRuns: 3 });
    expect(onBarCalls).toBe(5 * 500);
    expect(probe.pooled.count).toBe(3 * 500);
    expect(probe.perRun).toHaveLength(3);
    expect(probe.runWallMs).toHaveLength(3);
    expect(probe.perRun.every((run) => run.count === 500)).toBe(true);
    expect(probe.pooled.p99).toBeGreaterThanOrEqual(probe.pooled.p50);
    expect(probe.faulted).toBe(false);
    expect(formatPooledReplayProbe(probe)).toContain("pooled replay 500 bars x 3 after 2 warm-ups");
    const sorted = [...probe.perRun.flatMap(() => [])];
    expect(sorted).toEqual([]);
    expect(probeReplayPooled(rsiIndicator, bars, { length: 14 }).warmupRuns).toBe(3);
  });

  it("the pooled method applies the runtime's liquidity cutoff, so a historical provider never leaks future columns (Codex round-2 finding 3)", () => {
    const { bars } = trendBars({ count: 20 });
    const requested: number[] = [];
    const futureColumn = { ts: bars[bars.length - 1].ts_open + 10 * MINUTE_MS, lo: 0, hi: 1, bid: new Float64Array([1, 1]), ask: new Float64Array([1, 1]) };
    const seen: number[] = [];
    const provider: IndicatorLiquidity = {
      feed: { epoch: 1, deep: null, fine: { columns: [futureColumn], columnMs: 1_000 } },
      rowWidth: 1,
      baseAsset: "BTC",
      version: 1,
      atTime: (timeMs) => {
        requested.push(timeMs);
        // Nothing is known before the 10th bar's close; afterwards, an empty feed cut at the time asked.
        if (timeMs < bars[10].ts_open + MINUTE_MS) return null;
        return { feed: { epoch: 1, deep: null, fine: { columns: [], columnMs: 1_000 } }, rowWidth: 1, baseAsset: "BTC", version: 1 };
      },
    };
    const reader: RuntimeIndicatorDef<{ value: number | null }, Record<string, never>> = {
      kind: "runtime",
      id: "liquidityReader",
      label: "Liquidity Reader",
      category: "l2",
      defaultSettings: {},
      lines: [{ key: "value" }],
      placement: { kind: "overlay" },
      createState: () => ({ value: null }),
      onBar: (ctx) => {
        if (ctx.liquidity === undefined) {
          ctx.state.value = null;
          return;
        }
        for (const column of ctx.liquidity.feed.fine.columns) seen.push(column.ts);
        ctx.state.value = ctx.liquidity.feed.fine.columns.length;
      },
      readOutput: (state) => ({ value: state.value }),
    };
    const probe = probeReplayPooled(reader, bars, {}, { warmupRuns: 1, timedRuns: 1, extras: { liquidity: provider } });
    expect(probe.faulted).toBe(false);
    expect(seen).toEqual([]);
    expect(requested).toEqual([...bars, ...bars].map((bar) => bar.ts_open + MINUTE_MS));
    // A provider without atTime is handed over as is, exactly as makeCtx does.
    const plain: IndicatorLiquidity = { feed: provider.feed, rowWidth: 1, baseAsset: "BTC", version: 1 };
    probeReplayPooled(reader, bars.slice(0, 2), {}, { warmupRuns: 0, timedRuns: 1, extras: { liquidity: plain } });
    expect(seen).toEqual([futureColumn.ts, futureColumn.ts]);
  });

  it("the pooled method marks a faulting indicator", () => {
    const thrower: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      ...hoarder,
      id: "pooledThrower",
      createState: () => ({}),
      onBar: () => {
        throw new Error("boom");
      },
      readOutput: () => ({ value: null }),
    } as unknown as RuntimeIndicatorDef<Record<string, never>, Record<string, never>>;
    expect(probeReplayPooled(thrower, trendBars({ count: 5 }).bars, {}, { warmupRuns: 0, timedRuns: 1 }).faulted).toBe(true);
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
