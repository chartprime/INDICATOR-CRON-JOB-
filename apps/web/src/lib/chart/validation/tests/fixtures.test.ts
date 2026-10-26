import { describe, expect, it } from "vitest";
import { barSides } from "../../../indicators/barSides";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { mergeChartBar } from "../../chartData";
import { replayBars } from "../../replayBars";
import {
  MINUTE_MS,
  compressionBreakoutBars,
  duplicateClosedArrivals,
  equityUnsidedBars,
  formingRevisions,
  liveArrivals,
  rangeBars,
  rebuiltArrivals,
  sampledIndices,
  timeGapBars,
  trendBars,
  volumeSpikeBars,
} from "../fixtures";
import type { BarFrame } from "../../../../types/frames";

function chronological(bars: readonly BarFrame[]): boolean {
  return bars.every((bar, index) => index === 0 || bar.ts_open > bars[index - 1].ts_open);
}

function wellFormed(bars: readonly BarFrame[]): boolean {
  return bars.every(
    (bar) =>
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close) &&
      bar.volume > 0 &&
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite),
  );
}

describe("labelled fixtures", () => {
  it("are deterministic for a seed and differ across seeds", () => {
    expect(trendBars({ seed: 1 }).bars).toEqual(trendBars({ seed: 1 }).bars);
    expect(trendBars({ seed: 1 }).bars[50].close).not.toBe(trendBars({ seed: 2 }).bars[50].close);
  });

  it("trend: every bar is well formed, chronological, and the series ends where the label says", () => {
    const { bars, labels } = trendBars({ count: 300 });
    expect(chronological(bars)).toBe(true);
    expect(wellFormed(bars)).toBe(true);
    expect(bars[bars.length - 1].close).toBe(labels.endPrice);
    expect(labels.endPrice).toBeGreaterThan(labels.startPrice + 200 * labels.driftPerBar);
    const down = trendBars({ count: 300, direction: -1 });
    expect(down.labels.endPrice).toBeLessThan(down.labels.startPrice);
    // RSI agrees with the label: a persistent up-drift reads overbought at the end.
    const { perBar } = replayBars(rsiIndicator, bars, { length: 14 });
    expect(perBar.value[bars.length - 1]).toBeGreaterThan(70);
  });

  it("range: no high or low leaves the labelled band", () => {
    const { bars, labels } = rangeBars({ count: 500 });
    expect(wellFormed(bars)).toBe(true);
    expect(bars.every((bar) => bar.high <= labels.high && bar.low >= labels.low)).toBe(true);
    expect(Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low))).toBeGreaterThan(labels.halfWidth);
  });

  it("compression then breakout: the labelled bar is the first close outside the compressed range", () => {
    const { bars, labels } = compressionBreakoutBars();
    expect(wellFormed(bars)).toBe(true);
    const inside = (bar: BarFrame) => bar.close <= labels.compressionHigh && bar.close >= labels.compressionLow;
    for (let index = labels.compressionStart; index < labels.breakoutIndex; index += 1) expect(inside(bars[index])).toBe(true);
    expect(bars[labels.breakoutIndex].close).toBeGreaterThan(labels.compressionHigh);
    // The range really contracts: the last 20 compression bars span far less than the first 20.
    const span = (from: number, to: number) => Math.max(...bars.slice(from, to).map((b) => b.high)) - Math.min(...bars.slice(from, to).map((b) => b.low));
    expect(span(labels.breakoutIndex - 20, labels.breakoutIndex)).toBeLessThan(span(labels.compressionStart, labels.compressionStart + 20) / 2);
    const down = compressionBreakoutBars({ direction: -1 });
    expect(down.bars[down.labels.breakoutIndex].close).toBeLessThan(down.labels.compressionLow);
  });

  it("volume spike: exactly one bar carries the labelled multiple of the baseline", () => {
    const { bars, labels } = volumeSpikeBars({ count: 400, spikeIndex: 250, spikeMultiple: 10 });
    const sorted = [...bars].sort((a, b) => a.volume - b.volume);
    const median = sorted[Math.floor(sorted.length / 2)].volume;
    expect(bars[labels.spikeIndex].volume).toBeGreaterThanOrEqual(median * 7);
    expect(bars.filter((bar) => bar.volume > median * 3)).toHaveLength(1);
    expect(barSides(bars[labels.spikeIndex]).known).toBe(true);
  });

  it("time gap: one hole of the labelled length, and the array stays strictly chronological", () => {
    const { bars, labels } = timeGapBars({ count: 200, gapAfterIndex: 120, missingBars: 15 });
    expect(chronological(bars)).toBe(true);
    const holes = bars.map((bar, index) => (index === 0 ? 0 : bar.ts_open - bars[index - 1].ts_open)).filter((step) => step > MINUTE_MS);
    expect(holes).toEqual([labels.gapMs]);
    expect(bars[labels.firstBarAfterGapIndex].ts_open - bars[labels.gapAfterIndex].ts_open).toBe(16 * MINUTE_MS);
  });

  it("equity unsided: the labelled bars read as unknown through barSides, the others carry an unsided remainder", () => {
    const { bars, labels } = equityUnsidedBars({ count: 90 });
    expect(bars[0].provider).toBe("DXFEED");
    for (const index of labels.unsidedIndices) expect(barSides(bars[index]).known).toBe(false);
    for (const index of labels.partiallySidedIndices) {
      const sides = barSides(bars[index]);
      expect(sides.known).toBe(true);
      expect(sides.unknown / bars[index].volume).toBeCloseTo(labels.unknownShare, 2);
    }
    expect(labels.unsidedIndices.length + labels.partiallySidedIndices.length).toBe(90);
  });
});

describe("arrival scripts", () => {
  const { bars } = trendBars({ count: 12 });

  it("forming revisions walk open to close through the wicks and end on the closed bar itself", () => {
    const bar = bars[3];
    const frames = formingRevisions(bar, 5);
    expect(frames).toHaveLength(6);
    expect(frames[5]).toBe(bar);
    for (const frame of frames.slice(0, 5)) {
      expect(frame.closed).toBe(false);
      expect(frame.ts_open).toBe(bar.ts_open);
      expect(frame.high).toBeLessThanOrEqual(bar.high);
      expect(frame.low).toBeGreaterThanOrEqual(bar.low);
      expect(frame.volume).toBeLessThan(bar.volume);
      expect(barSides(frame).known).toBe(true);
    }
    expect(frames.map((frame) => frame.volume)).toEqual([...frames.map((frame) => frame.volume)].sort((a, b) => a - b));
  });

  it("the chart classifies live arrivals as APPENDED then REPLACED_EDGE for each bar", () => {
    const arrivals = liveArrivals(bars.slice(0, 2), 3);
    const chart: BarFrame[] = [];
    expect(arrivals.map((arrival) => mergeChartBar(chart, arrival.bar))).toEqual([
      "APPENDED", "REPLACED_EDGE", "REPLACED_EDGE", "REPLACED_EDGE",
      "APPENDED", "REPLACED_EDGE", "REPLACED_EDGE", "REPLACED_EDGE",
    ]);
    expect(chart).toEqual(bars.slice(0, 2));
  });

  it("a duplicated closed bar is classified as REPLACED_EDGE, not a new bar", () => {
    const { arrivals, labels } = duplicateClosedArrivals(bars, 4);
    expect(arrivals).toHaveLength(bars.length + 1);
    const chart: BarFrame[] = [];
    const mutations = arrivals.map((arrival) => mergeChartBar(chart, arrival.bar));
    expect(mutations[labels.duplicateIndex + 1]).toBe("REPLACED_EDGE");
    expect(mutations.filter((mutation) => mutation === "APPENDED")).toHaveLength(bars.length);
    expect(chart).toEqual(bars);
  });

  it("a late bar is classified as REBUILT and the chart ends complete", () => {
    const { arrivals, labels } = rebuiltArrivals(bars, 5, 2);
    const chart: BarFrame[] = [];
    const mutations = arrivals.map((arrival) => mergeChartBar(chart, arrival.bar));
    expect(mutations.filter((mutation) => mutation === "REBUILT")).toHaveLength(1);
    expect(arrivals.find((arrival) => arrival.label === "late")?.bar).toBe(bars[labels.lateIndex]);
    expect(chart).toEqual(bars);
  });

  it("sampled indices always include the first index and the whole tail", () => {
    expect(sampledIndices(100, 25, 5)).toEqual([0, 25, 50, 75, 95, 96, 97, 98, 99]);
  });
});
