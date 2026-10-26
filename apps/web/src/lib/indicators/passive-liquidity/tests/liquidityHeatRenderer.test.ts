import { describe, expect, it } from "vitest";
import { cellOf } from "../liquidityHeatRenderer";
import type { RunSegment } from "../liquidityRuns";

function run(fate: RunSegment["fate"], peak: number): RunSegment {
  return { startTs: 0, endTs: 10_000, fate, reach: fate === "consumed" ? "touch" : "none", peak, fill: null };
}

describe("liquidityHeatRenderer cellOf", () => {
  it("draws a consumed level at its peak in every column, full strength, down to the column price ate it", () => {
    expect(cellOf(run("consumed", 900), 900, 100)).toEqual({ size: 900, full: true, fade: 1 });
    expect(cellOf(run("consumed", 900), 300, 100)).toEqual({ size: 900, full: true, fade: 1 });
    expect(cellOf(run("consumed", 900), 40, 100)).toEqual({ size: 900, full: true, fade: 1 });
  });

  it("draws a resting level at the most it has held so far, so a wall being eaten keeps its size until it is gone", () => {
    expect(cellOf(run("resting", 900), 500, 100)).toEqual({ size: 900, full: true, fade: 1 });
    expect(cellOf(run("resting", 900), 60, 100)).toEqual({ size: 900, full: true, fade: 1 });
  });

  it("draws a pulled level as it was, thin where it thinned and faint throughout", () => {
    expect(cellOf(run("pulled", 900), 500, 100)).toEqual({ size: 500, full: true, fade: 0.45 });
    expect(cellOf(run("pulled", 900), 60, 100)).toEqual({ size: 60, full: false, fade: 0.45 });
  });
});
