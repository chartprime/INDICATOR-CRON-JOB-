import { describe, expect, it } from "vitest";
import type { IChartApiBase, Time } from "lightweight-charts";
import { claimRightOffset } from "../rightOffsetRoom";

// Like lightweight-charts: applying a rightOffset scrolls the view so the
// newest bar sits that many bars from the right edge, wherever the user had
// panned to. scrollPosition() is that distance for the current view.
function fakeChart(rightOffset: number) {
  const options = { rightOffset };
  const applied: number[] = [];
  const view = { lastIndex: 100, width: 50, scroll: rightOffset };
  const range = () => ({ from: view.lastIndex + view.scroll - view.width, to: view.lastIndex + view.scroll });
  const timeScale = {
    options: () => options,
    applyOptions: (next: { rightOffset: number }) => {
      applied.push(next.rightOffset);
      options.rightOffset = next.rightOffset;
      view.scroll = next.rightOffset;
    },
    scrollPosition: () => view.scroll,
    getVisibleLogicalRange: () => range(),
    setVisibleLogicalRange: (next: { from: number; to: number }) => {
      view.scroll = next.to - view.lastIndex;
      view.width = next.to - next.from;
    },
  };
  return { chart: { timeScale: () => timeScale } as unknown as IChartApiBase<Time>, options, applied, view, range };
}

describe("the room kept right of the newest candle", () => {
  it("is the widest claim while any stands, and the chart's own offset once every claim is dropped", () => {
    const { chart, options } = fakeChart(3);
    const ladder = {};
    const profile = {};
    claimRightOffset(chart, ladder, 10);
    claimRightOffset(chart, profile, 30);
    expect(options.rightOffset).toBe(30);
    claimRightOffset(chart, profile, null);
    expect(options.rightOffset).toBe(10);
    claimRightOffset(chart, ladder, null);
    expect(options.rightOffset).toBe(3);
  });

  it("takes an offset the app set underneath the claims as the chart's own", () => {
    const { chart, options } = fakeChart(0);
    const profile = {};
    claimRightOffset(chart, profile, 20);
    options.rightOffset = 40;
    claimRightOffset(chart, profile, 20);
    expect(options.rightOffset).toBe(40);
    claimRightOffset(chart, profile, null);
    expect(options.rightOffset).toBe(40);
  });

  it("writes to the chart only when the offset moves, unless told to", () => {
    const { chart, applied } = fakeChart(0);
    const profile = {};
    claimRightOffset(chart, profile, 20);
    claimRightOffset(chart, profile, 20);
    expect(applied).toEqual([20]);
    claimRightOffset(chart, profile, 20, true);
    expect(applied).toEqual([20, 20]);
  });

  it("leaves a view the user panned into the past where it was when a claim comes and goes, as a reconnect does to the ladder", () => {
    const { chart, options, view, range } = fakeChart(5);
    const ladder = {};
    claimRightOffset(chart, ladder, 12);
    view.scroll = -30;
    const panned = range();

    claimRightOffset(chart, ladder, null);
    expect(options.rightOffset).toBe(5);
    expect(range()).toEqual(panned);

    claimRightOffset(chart, ladder, 12);
    expect(options.rightOffset).toBe(12);
    expect(range()).toEqual(panned);

    claimRightOffset(chart, ladder, 12, true);
    expect(range()).toEqual(panned);
  });

  it("still follows the newest candle when the view was at the live edge", () => {
    const { chart, view } = fakeChart(5);
    const ladder = {};
    claimRightOffset(chart, ladder, 12);
    expect(view.scroll).toBe(12);
    view.scroll = 11.7;
    claimRightOffset(chart, ladder, 20);
    expect(view.scroll).toBe(20);
  });
});
