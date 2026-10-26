import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  swingAlphabetProfileIndicator,
  type SwingAlphabetProfileSettings,
  type SwingAlphabetProfileState,
} from "../swingAlphabetProfile";

// Report 57 W1, O-1 (GE-4 class): a profile box is placed a number of bars
// to the right of its leg's start. On a series with gaps -- the CME daily
// maintenance hour, weekends, and regular-session-only equities (GE-14) --
// "start + n * interval" is not a bar time, and a drawing anchored to a time
// that is not on the chart has no x coordinate. The box edges must be bar
// times (or, past the newest bar, times on the same one-interval grid).

const SETTINGS: SwingAlphabetProfileSettings = {
  swingLength: 2, showSwings: true, swingLineColor: "#787b86", maxSwingLines: 10, showProfile: true,
  profileResolution: 0.35, profileWidthLen: 20, profileTextColor: "#787b86", maxProfileBins: 50,
  showValueArea: true, valueAreaPercent: 50, valueAreaColor: "#1491da", valueAreaLineWidth: 4,
  showPoc: true, pocColor: "#1491da", pocLineWidth: 2, showBubbles: true, bubbleMinPercent: 50,
  bullBubbleColor: "#26a69a", bearBubbleColor: "#ef5350",
};

const MINUTE = 60_000;
const GAP_EVERY = 7;
const GAP_MS = 60 * MINUTE;

function timeOf(index: number): number {
  return index * MINUTE + Math.floor(index / GAP_EVERY) * GAP_MS;
}

function bar(index: number, high: number, low: number): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms: MINUTE, ts_open: timeOf(index),
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1, trade_count: 1, closed: true,
  } as BarFrame;
}

function feed(state: SwingAlphabetProfileState, bars: readonly BarFrame[]): void {
  for (const nextBar of bars) {
    const ctx: IndicatorBarCtx<SwingAlphabetProfileState, SwingAlphabetProfileSettings> = {
      bar: nextBar, trades: [], tradeAvailability: "HISTORICAL_UNAVAILABLE", state, settings: SETTINGS, replace: false,
      replaying: false, ta: {}, draw: { fill: () => {} }, markers: { plotshape: () => {}, plotchar: () => {} }, pane: { paneIndex: 0 },
    };
    swingAlphabetProfileIndicator.onBar(ctx);
  }
}

beforeEach(() => resetDrawRegistryForTests());
afterEach(() => resetDrawRegistryForTests());

describe("swing alphabet profile anchors on bar times across gaps (O-1)", () => {
  it("every finalized profile box edge is a bar time, or on the interval grid past the newest bar", () => {
    const state = withDrawOwnerScope("swing-alphabet-profile-bar-times", () => swingAlphabetProfileIndicator.createState(SETTINGS));
    const bars: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) bars.push(index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5));
    const base = bars.length;
    bars.push(bar(base, 10, 8), bar(base + 1, 12, 9), bar(base + 2, 11, 6), bar(base + 3, 9, 7), bar(base + 4, 10, 8));
    for (let index = base + 5; index < base + 40; index += 1) bars.push(bar(index, 9.2, 8.8));
    feed(state, bars);

    const barTimes = new Set(bars.map((b) => b.ts_open));
    const newest = bars.at(-1)!.ts_open;
    const onChart = (time: number) => barTimes.has(time) || (time > newest && (time - newest) % MINUTE === 0);
    expect(state.profileBins.length).toBeGreaterThan(0);
    for (const bin of state.profileBins) expect([bin.time1, onChart(bin.time1), bin.time2, onChart(bin.time2)]).toEqual([bin.time1, true, bin.time2, true]);
    for (const poc of state.pocRecords) expect([poc.time1, onChart(poc.time1)]).toEqual([poc.time1, true]);
  });
});
