import { afterEach, describe, expect, it } from "vitest";
import { bollingerIndicator } from "../../../indicators/bollinger/bollinger";
import { largeTradeBubblesIndicator } from "../../../indicators/large-trade-bubbles/largeTradeBubbles";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";
import { FIXTURE_T0, MINUTE_MS, barFrame, compressionBreakoutBars, sampledIndices, trendBars } from "../fixtures";
import { checkTruncationInvariance, summarizeTruncation } from "../truncation";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** Draws each close, but at the right edge of the series repaints the newest bar as the highest close seen: a lookahead. */
const repainter: RuntimeIndicatorDef<{ max: number; value: number | null }, Record<string, never>> = {
  kind: "runtime",
  id: "repainter",
  label: "Repainter",
  category: "technical",
  defaultSettings: {},
  lines: [{ key: "value" }],
  placement: { kind: "overlay" },
  createState: () => ({ max: -Infinity, value: null }),
  onBar: (ctx) => {
    ctx.state.max = Math.max(ctx.state.max, ctx.bar.close);
    const atEdge = ctx.barIndex !== undefined && ctx.barCount !== undefined && ctx.barIndex === ctx.barCount - 1;
    ctx.state.value = atEdge ? ctx.state.max : ctx.bar.close;
  },
  readOutput: (state) => ({ value: state.value }),
};

/** Marks the bar that will turn out to be the highest close of the series: only knowable with future bars. */
const peakMarker: RuntimeIndicatorDef<{ closes: number[] }, Record<string, never>> = {
  kind: "runtime",
  id: "peakMarker",
  label: "Peak Marker",
  category: "technical",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({ closes: [] }),
  onBar: (ctx) => {
    ctx.state.closes.push(ctx.bar.close);
    const atEdge = ctx.barIndex === (ctx.barCount ?? 0) - 1;
    if (!atEdge) return;
    const peak = ctx.state.closes.indexOf(Math.max(...ctx.state.closes));
    ctx.markers.plotshape({ shape: "arrowDown", time: ctx.bar.ts_open - (ctx.state.closes.length - 1 - peak) * ctx.bar.interval_ms });
  },
  readOutput: () => ({}),
};

describe("truncation invariance", () => {
  it("RSI passes at every cut of a 200-bar series", () => {
    const { bars } = trendBars({ count: 200 });
    const report = checkTruncationInvariance(rsiIndicator, bars, { length: 14 });
    expect(report.checked).toBe(200);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(summarizeTruncation(report)).toContain("PASS");
  });

  it("Bollinger passes on a sampled sweep of the breakout fixture", () => {
    const { bars } = compressionBreakoutBars();
    const report = checkTruncationInvariance(bollingerIndicator, bars, { length: 20, mult: 2 }, { indices: sampledIndices(bars.length, 25) });
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(sampledIndices(bars.length, 25).length);
  });

  it("catches an output that repaints at the right edge", () => {
    const { bars } = trendBars({ count: 60, driftPerBar: 0, noise: 30 });
    const report = checkTruncationInvariance(repainter, bars, {});
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
    const first = report.violations[0];
    expect(first.diff.key).toBe("value");
    expect(first.diff.index).toBe(first.truncatedAt);
    expect(summarizeTruncation(report)).toContain("FAIL");
  });

  it("catches a marker placed on a bar whose status depends on later bars", () => {
    // Up for 20 bars, then down: the peak sits in the middle of the series.
    const bars = Array.from({ length: 40 }, (_, index) => barFrame(FIXTURE_T0 + index * MINUTE_MS, { open: 100, close: 100 + (index < 20 ? index : 40 - index), high: 0, low: 0, volume: 1 }));
    const report = checkTruncationInvariance(peakMarker, bars, {});
    expect(report.violations).toEqual([]);
    expect(report.markerViolations.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("Large Trade Bubbles draws nothing in a replay, so it passes trivially and honestly", () => {
    const { bars } = trendBars({ count: 50 });
    const report = checkTruncationInvariance(largeTradeBubblesIndicator, bars, { multiplier: 3 }, { indices: sampledIndices(50, 10) });
    expect(report.ok).toBe(true);
    expect(report.markerViolations).toEqual([]);
  });

  it("reports a faulting indicator as a failure rather than a pass", () => {
    const thrower: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      kind: "runtime",
      id: "thrower",
      label: "Thrower",
      category: "technical",
      defaultSettings: {},
      lines: [{ key: "value" }],
      placement: { kind: "overlay" },
      createState: () => ({}),
      onBar: () => {
        throw new Error("boom");
      },
      readOutput: () => ({ value: null }),
    };
    const report = checkTruncationInvariance(thrower, trendBars({ count: 5 }).bars, {});
    expect(report.faulted).toBe(true);
    expect(report.ok).toBe(false);
  });
});
