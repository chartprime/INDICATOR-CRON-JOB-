import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { HISTORICAL_INDICATOR_POLICIES, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import { replayBars } from "../../../chart/replayBars";
import {
  checkArrivalsAgainstReplay,
  checkDuplicateClosedIdempotent,
  checkLiveReplayEquivalence,
  checkRebuiltEquivalence,
  checkTruncationInvariance,
  compressionBreakoutBars,
  compressionContinuationBars,
  compressionFailedBreakBars,
  constantWidthBars,
  countMarkers,
  countMarkersOver,
  diffOutputs,
  duplicateClosedArrivals,
  equityUnsidedBars,
  judgeBudget,
  longCompressionBars,
  rangeBars,
  replayCapture,
  summarizeEquivalence,
  summarizeTruncation,
  timeGapBars,
  trendBars,
  type Arrival,
  type Outputs,
} from "../../../chart/validation";
import { COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, compressionBreakoutIndicator, type CompressionBreakoutSettings } from "../compressionBreakout";
import { DAY_MS, RANGE_LIFETIME, createCompressionBreakoutEngine } from "../compressionBreakoutMath";
import { SEAM_KEYS, compressionBreakoutSeamDef } from "./seamDef";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const SETTINGS: CompressionBreakoutSettings = COMPRESSION_BREAKOUT_DEFAULT_SETTINGS;
const SEED7 = compressionBreakoutBars({ seed: 7 });
const FAILED9 = compressionFailedBreakBars({ seed: 9 });
const HELD9 = compressionContinuationBars({ seed: 9 });

function noNaN(outputs: Outputs): void {
  for (const values of Object.values(outputs)) {
    for (const value of values) expect(value === null || Number.isFinite(value)).toBe(true);
  }
}

/** Amendment 1: the first retained bar with no active and no held range once the denominators and the trend window lie inside retention. */
function quietBarIndex(outputs: Outputs, from: number, settings: CompressionBreakoutSettings): number {
  const warm = from + Math.max(2 * settings.rangeLength, 20, settings.trendSlow + 5);
  for (let index = warm; index < outputs.activeHigh.length; index += 1) {
    if (outputs.activeHigh[index] === null && outputs.heldCount[index] === 0) return index;
  }
  return -1;
}

describe("compressionBreakout -- no future data: truncation invariance (protocol check 1)", () => {
  it("passes at every cut of the breakout, failed-break, continuation and trend fixtures, seams and markers alike", () => {
    for (const { bars } of [SEED7, FAILED9, HELD9, trendBars({ count: 600 })]) {
      const seams = checkTruncationInvariance(compressionBreakoutSeamDef, bars, SETTINGS);
      expect(seams.checked).toBe(bars.length);
      expect(seams.ok).toBe(true);
      const product = checkTruncationInvariance(compressionBreakoutIndicator, bars, SETTINGS);
      console.log(summarizeTruncation(product));
      expect(product.markerViolations).toEqual([]);
      expect(product.ok).toBe(true);
    }
  }, 300_000);
});

describe("compressionBreakout -- replay versus live equivalence (protocol check 2)", () => {
  it("ends on the same committed seams and markers whether fed live with five forming revisions per bar or replayed", () => {
    for (const { bars } of [SEED7, FAILED9, { bars: constantWidthBars({ count: 700 }).bars }]) {
      const seams = checkLiveReplayEquivalence(compressionBreakoutSeamDef, bars, SETTINGS, { revisionsPerBar: 5 });
      expect(seams.mutations.filter((mutation) => mutation === "REPLACED_EDGE")).toHaveLength(bars.length * 5);
      expect(seams.equal).toBe(true);
      noNaN(seams.live.outputs);
      const product = checkLiveReplayEquivalence(compressionBreakoutIndicator, bars, SETTINGS, { revisionsPerBar: 5 });
      console.log(summarizeEquivalence("compressionBreakout", product));
      expect(product.equal).toBe(true);
    }
    expect(replayCapture(compressionBreakoutIndicator, SEED7.bars, SETTINGS).markers.length).toBeGreaterThan(0);
  }, 300_000);

  it("a replay whose tail is a forming bar keeps the tail provisional: its marker is faded and nothing is committed for it", () => {
    const bars = SEED7.bars.slice(0, 221);
    const tail = { ...bars[220], closed: false } as BarFrame;
    const capture = replayCapture(compressionBreakoutIndicator, [...bars.slice(0, 220), tail], SETTINGS);
    expect(capture.faulted).toBe(false);
    const marker = capture.markers.find((call) => call.time === tail.ts_open);
    expect(marker).toBeDefined();
    expect(marker!.color.startsWith("rgba(")).toBe(true);
    const engine = createCompressionBreakoutEngine(SETTINGS);
    for (const bar of [...bars.slice(0, 220), tail]) engine.onBar(bar);
    expect(engine.committed.committedIndex).toBe(220);
    expect(engine.current!.confirmed).toBe(false);
    expect(engine.current!.decision.kind).toBe("break");
  });
});

describe("compressionBreakout -- gap, duplicate, late and corrected bars (protocol check 3, amendments 4 to 6)", () => {
  it("duplicate closed bar is idempotent, inside the failure window included, and adds no marker", () => {
    for (const index of [221, 100]) {
      const report = checkDuplicateClosedIdempotent(compressionBreakoutSeamDef, SEED7.bars, SETTINGS, index);
      expect(report.duplicateMutation).toBe("REPLACED_EDGE");
      expect(report.equal).toBe(true);
    }
    const budget = countMarkersOver(compressionBreakoutIndicator, duplicateClosedArrivals(FAILED9.bars, 220).arrivals, SETTINGS);
    expect(budget.total).toBe(countMarkers(compressionBreakoutIndicator, FAILED9.bars, SETTINGS).total);
  }, 120_000);

  it("late bar rebuilds to the replay", () => {
    const report = checkRebuiltEquivalence(compressionBreakoutSeamDef, SEED7.bars, SETTINGS, 150);
    expect(report.sawRebuilt).toBe(true);
    expect(report.equal).toBe(true);
    expect(report.live.outputs.activeHigh).toHaveLength(SEED7.bars.length);
  }, 120_000);

  it("a correction to an older bar arrives as a REBUILT and every successor equals a fresh replay", () => {
    const arrivals: Arrival[] = SEED7.bars.map((bar) => ({ bar }));
    const corrected = { ...SEED7.bars[150], volume: SEED7.bars[150].volume * 4 } as BarFrame;
    arrivals.push({ bar: corrected, label: "correction" });
    const report = checkArrivalsAgainstReplay(compressionBreakoutSeamDef, arrivals, SETTINGS);
    expect(report.mutations.at(-1)).toBe("REBUILT");
    expect(report.equal).toBe(true);
  }, 120_000);

  it("the tail corrections of the brief: cancelled break, volume invalid then valid, failure removed; each equals a clean feed of the corrected series", () => {
    const b = SEED7.labels.breakoutIndex;
    const prefix: Arrival[] = SEED7.bars.slice(0, b).map((bar) => ({ bar }));
    const rest = (from: number): Arrival[] => SEED7.bars.slice(from).map((bar) => ({ bar }));
    // The range's frozen high (it opened inside the contraction) is below the labelled compression high: "inside" means inside the frozen edges.
    const edge = replayCapture(compressionBreakoutSeamDef, SEED7.bars, SETTINGS).outputs.activeHigh[b] as number;
    expect(edge).toBeLessThanOrEqual(SEED7.labels.compressionHigh);
    // 1. The break bar closes again inside the range: the event disappears and the range stays active.
    const inside220 = { ...SEED7.bars[b], close: edge - 1, low: Math.min(SEED7.bars[b].low, edge - 1) } as BarFrame;
    const cancelled = checkArrivalsAgainstReplay(compressionBreakoutSeamDef, [...prefix, { bar: SEED7.bars[b] }, { bar: inside220, label: "closed again" }, ...rest(b + 1)], SETTINGS);
    expect(cancelled.mutations[b + 1]).toBe("REPLACED_EDGE");
    expect(cancelled.equal).toBe(true);
    expect(cancelled.live.outputs.breakDir[b]).toBe(0);
    expect(cancelled.live.outputs.activeHigh[b + 1]).not.toBeNull();
    const cleanInside = replayCapture(compressionBreakoutSeamDef, SEED7.bars.map((bar, index) => (index === b ? inside220 : bar)), SETTINGS);
    expect(diffOutputs(cancelled.live.outputs, cleanInside.outputs)).toEqual([]);
    // 2. The break bar first arrives with an invalid volume (range only, vol n/a), then valid (range+vol).
    const noVolume = { ...SEED7.bars[b], volume: Number.NaN } as BarFrame;
    const flipped = checkArrivalsAgainstReplay(compressionBreakoutSeamDef, [...prefix, { bar: noVolume }, { bar: SEED7.bars[b], label: "valid again" }, ...rest(b + 1)], SETTINGS);
    expect(flipped.equal).toBe(true);
    expect(flipped.live.outputs.breakGrade[b]).toBe(3);
    const onlyInvalid = replayCapture(compressionBreakoutSeamDef, SEED7.bars.map((bar, index) => (index === b ? noVolume : bar)), SETTINGS);
    expect(onlyInvalid.outputs.breakGrade[b]).toBe(1);
    expect(onlyInvalid.outputs.gradeBasis[b]).toBe(1);
    // 3. The bar after the break first closes inside (failure), then outside (pending again).
    const inside221 = { ...SEED7.bars[b + 1], close: edge - 1, low: Math.min(SEED7.bars[b + 1].low, edge - 2) } as BarFrame;
    const removed = checkArrivalsAgainstReplay(compressionBreakoutSeamDef, [...prefix, { bar: SEED7.bars[b] }, { bar: inside221 }, { bar: SEED7.bars[b + 1], label: "outside again" }, ...rest(b + 2)], SETTINGS);
    expect(removed.equal).toBe(true);
    expect(removed.live.outputs.failed[b + 1]).toBe(0);
    expect(removed.live.outputs.pending[b + 1]).toBe(1);
    expect(removed.live.outputs.heldOutside[b + 5]).toBe(1);
    const onlyInside = replayCapture(compressionBreakoutSeamDef, SEED7.bars.map((bar, index) => (index === b + 1 ? inside221 : bar)), SETTINGS);
    expect(onlyInside.outputs.failed[b + 1]).toBe(1);
  }, 120_000);

  it("time gap below one day: the first bar after the hole reads a reset range, its true range is high − low, nothing earlier changes", () => {
    const { bars, labels } = timeGapBars({ count: 600 });
    const gapped = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
    const prefix = replayCapture(compressionBreakoutSeamDef, bars.slice(0, labels.gapAfterIndex + 1), SETTINGS);
    expect(diffOutputs(gapped.outputs, prefix.outputs, 0, labels.gapAfterIndex)).toEqual([]);
    expect(gapped.outputs.activeHigh[labels.firstBarAfterGapIndex]).toBeNull();
    const engine = createCompressionBreakoutEngine(SETTINGS);
    let after = null as ReturnType<typeof engine.onBar> | null;
    bars.forEach((bar, index) => {
      const reading = engine.onBar(bar);
      if (index === labels.firstBarAfterGapIndex) after = reading;
    });
    const gapBar = bars[labels.firstBarAfterGapIndex];
    expect(after!.gap).toBe(true);
    expect(after!.trueRange).toBe(gapBar.high - gapBar.low);
    noNaN(gapped.outputs);
  });

  it("the gap rule applies only below one-day intervals: a three-day hole in daily bars keeps the range, a three-minute hole in 1m bars resets it", () => {
    for (const [intervalMs, expectReset] of [
      [60_000, true],
      [DAY_MS, false],
    ] as const) {
      const { bars } = constantWidthBars({ count: 120, intervalMs });
      const gapped = bars.map((bar, index) => (index >= 80 ? ({ ...bar, ts_open: bar.ts_open + 2 * intervalMs } as BarFrame) : bar));
      const capture = replayCapture(compressionBreakoutSeamDef, gapped, SETTINGS);
      expect(capture.faulted).toBe(false);
      expect(capture.outputs.activeHigh[79]).not.toBeNull();
      if (expectReset) expect(capture.outputs.activeHigh[80]).toBeNull();
      else expect(capture.outputs.activeHigh[80]).toBe(capture.outputs.activeHigh[79]);
    }
  });

  it("equity bars at one-minute and daily intervals run without a fault, read no side, and reset only on the intraday overnight hole", () => {
    for (const intervalMs of [60_000, DAY_MS]) {
      const { bars } = equityUnsidedBars({ intervalMs, count: 400 });
      const capture = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
      expect(capture.faulted).toBe(false);
      noNaN(capture.outputs);
      expect(capture.outputs.qualified.slice(39).some((value) => value !== null)).toBe(true);
    }
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "compressionBreakoutMath.ts"), "utf8") + readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "compressionBreakout.ts"), "utf8");
    expect(source.includes("buy_volume")).toBe(false);
    expect(source.includes("barSides")).toBe(false);
    expect(source.includes("provider ===")).toBe(false);
  });
});

describe("compressionBreakout -- warm-up, empty input and NaN (protocol check 4)", () => {
  it("readiness per component: qualification from index 39, edges only once established, trend from index 205, never NaN or a stand-in zero", () => {
    const capture = replayCapture(compressionBreakoutSeamDef, SEED7.bars, SETTINGS);
    for (let index = 0; index < 39; index += 1) {
      expect(capture.outputs.qualified[index]).toBeNull();
      expect(capture.outputs.widthRatio[index]).toBeNull();
      expect(capture.outputs.activeHigh[index]).toBeNull();
      expect(capture.outputs.rangeHigh[index]).toBeNull();
    }
    expect(capture.outputs.qualified[39]).not.toBeNull();
    const firstEdge = capture.outputs.rangeHigh.findIndex((value) => value !== null);
    expect(firstEdge).toBeGreaterThanOrEqual(39 + SETTINGS.minCompressionBars + 1);
    for (let index = 0; index < 205; index += 1) expect(capture.outputs.trend[index]).toBeNull();
    expect(capture.outputs.trend[205]).not.toBeNull();
    noNaN(capture.outputs);
    const shorter = replayCapture(compressionBreakoutSeamDef, SEED7.bars.slice(0, 39), SETTINGS);
    expect(shorter.outputs.qualified.every((value) => value === null)).toBe(true);
  });

  it("handles an empty bar array and a bar with an unusable price", () => {
    expect(replayBars(compressionBreakoutIndicator, [], SETTINGS).perBar.rangeHigh).toEqual([]);
    expect(replayCapture(compressionBreakoutIndicator, [], SETTINGS).faulted).toBe(false);
    const bars = SEED7.bars.map((bar, index) => (index === 100 ? ({ ...bar, high: Number.NaN } as BarFrame) : bar));
    const capture = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
    expect(capture.faulted).toBe(false);
    noNaN(capture.outputs);
    expect(capture.outputs.breakDir[220]).toBe(1);
  });
});

describe("compressionBreakout -- marker budget (protocol check 5)", () => {
  it("stays under the signal ceiling with at most one marker per bar on the range and trend controls, and reports the counts", () => {
    const lines: string[] = [];
    for (const regime of ["range", "trend"] as const) {
      let total = 0;
      for (let seed = 7; seed <= 11; seed += 1) {
        const { bars } = regime === "range" ? rangeBars({ seed, count: 1_000 }) : trendBars({ seed, count: 1_000 });
        const budget = countMarkers(compressionBreakoutIndicator, bars, SETTINGS);
        const verdict = judgeBudget(budget, 40, 1);
        expect(verdict.ok).toBe(true);
        total += budget.total;
        lines.push(`${regime} seed ${seed}: ${budget.total} markers (${budget.per1000Bars.toFixed(1)} per 1,000), max per bar ${budget.maxPerBar}`);
      }
      lines.push(`${regime} control, 5 × 1,000 bars: ${(total / 5).toFixed(1)} markers per 1,000`);
    }
    console.log(lines.join("\n"));
  }, 120_000);
});

describe("compressionBreakout -- Historical Mode policy is honest (protocol check 10)", () => {
  it("declares OHLCV_POLICY, is available wherever candles are, and a candle-only replay produces real values", () => {
    expect(HISTORICAL_INDICATOR_POLICIES.compressionBreakout).toEqual({ requiredCapabilities: ["ohlcv"] });
    expect(historicalIndicatorAvailability("compressionBreakout", new Set(["ohlcv"]))).toEqual({ available: true, reason: null });
    expect(historicalIndicatorAvailability("compressionBreakout", new Set([])).available).toBe(false);
    const capture = replayCapture(compressionBreakoutSeamDef, SEED7.bars, SETTINGS);
    expect(capture.outputs.breakDir[220]).toBe(1);
    expect(capture.markers.length).toBeGreaterThan(0);
  });
});

describe("compressionBreakout -- replay policy (amendment 1)", () => {
  function compareFromQuiet(bars: readonly BarFrame[], offset: number, label: string): number {
    const live = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
    const rebuilt = replayCapture(compressionBreakoutSeamDef, bars.slice(offset), SETTINGS);
    const quiet = quietBarIndex(live.outputs, offset, SETTINGS);
    expect(quiet).toBeGreaterThan(-1);
    let compared = 0;
    for (let index = quiet; index < bars.length; index += 1) {
      for (const key of SEAM_KEYS) expect(rebuilt.outputs[key][index - offset]).toBe(live.outputs[key][index]);
      compared += 1;
    }
    const liveMarkers = live.markers.filter((call) => call.time >= bars[quiet].ts_open).map((call) => JSON.stringify(call));
    const rebuiltMarkers = rebuilt.markers.filter((call) => call.time >= bars[quiet].ts_open).map((call) => JSON.stringify(call));
    expect(rebuiltMarkers).toEqual(liveMarkers);
    console.log(`${label}: quiet bar ${quiet}, ${compared} bars compared equal after it`);
    return compared;
  }

  it("outputs, events and markers are equal from the first quiet bar on the breakout and control fixtures, with a non-zero compared count", () => {
    expect(compareFromQuiet(compressionBreakoutBars({ seed: 7, count: 1_000 }).bars, 60, "breakout seed 7, offset 60")).toBeGreaterThan(0);
    expect(compareFromQuiet(trendBars({ seed: 7, count: 1_200 }).bars, 100, "trend control, offset 100")).toBeGreaterThan(0);
    expect(compareFromQuiet(rangeBars({ seed: 8, count: 1_500 }).bars, 137, "range control, offset 137")).toBeGreaterThan(0);
  }, 120_000);

  it("before any quiet bar the difference is the range phase, pinned on the constant-width fixture at offsets 0, 137 and 500", () => {
    const { bars, labels } = constantWidthBars();
    const live = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
    const opensOf = (outputs: Outputs): number[] => outputs.rangeAge.map((age, index) => (age === 0 ? index - 1 : -1)).filter((index) => index >= 0);
    const liveOpens = opensOf(live.outputs);
    expect(liveOpens).toEqual([39, 39 + RANGE_LIFETIME + 1, 39 + 2 * (RANGE_LIFETIME + 1), 39 + 3 * (RANGE_LIFETIME + 1), 39 + 4 * (RANGE_LIFETIME + 1), 39 + 5 * (RANGE_LIFETIME + 1)].filter((index) => index < bars.length));
    expect(quietBarIndex(live.outputs, 0, SETTINGS)).toBe(-1);
    for (const offset of labels.rebuildOffsets) {
      const rebuilt = replayCapture(compressionBreakoutSeamDef, bars.slice(offset), SETTINGS);
      const rebuiltOpens = opensOf(rebuilt.outputs).map((index) => index + offset);
      expect(rebuiltOpens).toEqual(liveOpens.map((index) => index + offset).filter((index) => index < bars.length));
      let ageDiffers = 0;
      for (let index = offset + 40; index < bars.length; index += 1) {
        // The edges are the band's constants on both sides; only the phase (age, expiry) differs when the offset is not a multiple of the period.
        if (rebuilt.outputs.activeHigh[index - offset] !== null && live.outputs.activeHigh[index] !== null) {
          expect(rebuilt.outputs.activeHigh[index - offset]).toBe(live.outputs.activeHigh[index]);
          expect(rebuilt.outputs.activeLow[index - offset]).toBe(live.outputs.activeLow[index]);
        }
        if (rebuilt.outputs.rangeAge[index - offset] !== live.outputs.rangeAge[index]) ageDiffers += 1;
      }
      if (offset === 0) expect(ageDiffers).toBe(0);
      else expect(ageDiffers).toBeGreaterThan(0);
      console.log(`constant width, offset ${offset}: rebuilt opens at ${rebuiltOpens.join(", ")}; live opens at ${liveOpens.join(", ")}; age differs on ${ageDiffers} bars`);
    }
  }, 120_000);

  it("a coil older than retention, rebuilt from index 300: both instances break at 740 with the same grade, edges may differ before, and they agree after the hold", () => {
    const { bars, labels } = longCompressionBars();
    const live = replayCapture(compressionBreakoutSeamDef, bars, SETTINGS);
    const rebuilt = replayCapture(compressionBreakoutSeamDef, bars.slice(labels.rebuildFromIndex), SETTINGS);
    const b = labels.breakoutIndex;
    const at = (outputs: Outputs, key: string, index: number, offset = 0): number | null => outputs[key][index - offset];
    expect(at(live.outputs, "breakDir", b)).toBe(1);
    expect(at(rebuilt.outputs, "breakDir", b, labels.rebuildFromIndex)).toBe(1);
    expect(at(rebuilt.outputs, "breakGrade", b, labels.rebuildFromIndex)).toBe(at(live.outputs, "breakGrade", b));
    const edgeDiffers = at(live.outputs, "activeHigh", b) !== at(rebuilt.outputs, "activeHigh", b, labels.rebuildFromIndex);
    console.log(`long coil: live edges ${at(live.outputs, "activeLow", b)}..${at(live.outputs, "activeHigh", b)}, rebuilt edges ${at(rebuilt.outputs, "activeLow", b, labels.rebuildFromIndex)}..${at(rebuilt.outputs, "activeHigh", b, labels.rebuildFromIndex)} (${edgeDiffers ? "differ" : "equal"})`);
    expect(compareFromQuiet(bars, labels.rebuildFromIndex, "long coil, offset 300")).toBeGreaterThan(0);
  }, 120_000);
});
