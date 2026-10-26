import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../../indicators/compression-breakout/compressionBreakoutMath";
import {
  compressionBreakoutBars,
  compressionContinuationBars,
  compressionFailedBreakBars,
  constantWidthBars,
  longCompressionBars,
} from "../fixtures";

/**
 * Proving tests for the compression fixture family of the Compression Breakout
 * brief: the three aftermaths share one generator stream through the break
 * bar, the labelled outcomes are what the generators promise, and the
 * constant-width replay fixture has the properties amendment 1 relies on.
 */
describe("compression fixtures", () => {
  it("are deterministic by seed and differ between seeds", () => {
    expect(compressionBreakoutBars({ seed: 7 }).bars).toEqual(compressionBreakoutBars({ seed: 7 }).bars);
    expect(compressionBreakoutBars({ seed: 7 }).bars[50]).not.toEqual(compressionBreakoutBars({ seed: 8 }).bars[50]);
  });

  it("the failed-break and continuation fixtures are identical to the breakout fixture through the break bar", () => {
    for (const seed of [7, 9, 16]) {
      const breakout = compressionBreakoutBars({ seed });
      const failed = compressionFailedBreakBars({ seed });
      const held = compressionContinuationBars({ seed });
      const b = breakout.labels.breakoutIndex;
      expect(failed.bars.slice(0, b + 1)).toEqual(breakout.bars.slice(0, b + 1));
      expect(held.bars.slice(0, b + 1)).toEqual(breakout.bars.slice(0, b + 1));
      expect(failed.labels).toMatchObject({ ...breakout.labels, failIndex: b + 1 });
      expect(held.labels).toMatchObject({ ...breakout.labels, heldIndex: b + 5, heldBars: 5 });
    }
  });

  it("the failed break closes back at the start price on 1.5× volume and the compression resumes on reduced volume", () => {
    const { bars, labels } = compressionFailedBreakBars({ seed: 9, baseVolume: 100, startPrice: 60_000 });
    const fail = bars[labels.failIndex];
    expect(fail.open).toBe(bars[labels.breakoutIndex].close);
    expect(fail.close).toBe(60_000);
    expect(fail.volume).toBe(150);
    expect(fail.high).toBe(Math.max(fail.open, fail.close) + 5);
    for (const bar of bars.slice(labels.failIndex + 1)) {
      expect(bar.volume).toBeGreaterThanOrEqual(50);
      expect(bar.volume).toBeLessThanOrEqual(70);
      expect(bar.high).toBeLessThanOrEqual(60_000 + 30 + 1e-9);
      expect(bar.low).toBeGreaterThanOrEqual(60_000 - 30 - 1e-9);
    }
  });

  it("the continuation keeps every later close a fifth of the initial half width beyond the broken edge, in both directions", () => {
    for (const direction of [1, -1] as const) {
      const { bars, labels } = compressionContinuationBars({ seed: 12, direction });
      const edge = direction > 0 ? labels.compressionHigh : labels.compressionLow;
      for (const bar of bars.slice(labels.breakoutIndex + 1)) {
        if (direction > 0) expect(bar.close).toBeGreaterThanOrEqual(edge + 60 - 0.01);
        else expect(bar.close).toBeLessThanOrEqual(edge - 60 + 0.01);
      }
      expect(bars[labels.heldIndex].ts_open).toBe(bars[labels.breakoutIndex].ts_open + 5 * 60_000);
    }
  });

  it("the long compression coil outlives a 500-bar lifetime and rebuilds from 300 by default", () => {
    const { bars, labels } = longCompressionBars();
    expect(bars).toHaveLength(1_400);
    expect(labels.compressionStart).toBe(40);
    expect(labels.breakoutIndex).toBe(740);
    expect(labels.rebuildFromIndex).toBe(300);
    expect(bars[740].close).toBeGreaterThan(labels.compressionHigh);
  });

  it("the constant-width fixture: every bar's true range is 110, every 20-bar window spans 110, no close leaves the band", () => {
    const { bars, labels } = constantWidthBars();
    expect(bars).toHaveLength(3_000);
    expect(labels).toMatchObject({ width: 110, trueRange: 110, rebuildOffsets: [0, 137, 500] });
    for (let index = 1; index < bars.length; index += 1) {
      const bar = bars[index];
      const prev = bars[index - 1].close;
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
      expect(tr).toBe(110);
      expect(bar.close).toBeLessThanOrEqual(60_055);
      expect(bar.close).toBeGreaterThanOrEqual(59_945);
    }
    for (let start = 0; start + 20 <= bars.length; start += 97) {
      const window = bars.slice(start, start + 20);
      expect(Math.max(...window.map((bar) => bar.high)) - Math.min(...window.map((bar) => bar.low))).toBe(110);
    }
    const daily = constantWidthBars({ count: 50, intervalMs: DAY_MS });
    expect(daily.bars[1].ts_open - daily.bars[0].ts_open).toBe(DAY_MS);
  });
});
