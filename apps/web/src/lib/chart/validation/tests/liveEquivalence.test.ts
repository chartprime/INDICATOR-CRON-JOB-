import { afterEach, describe, expect, it } from "vitest";
import { bollingerIndicator } from "../../../indicators/bollinger/bollinger";
import { largeTradeBubblesIndicator } from "../../../indicators/large-trade-bubbles/largeTradeBubbles";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import { sumPrintsIn } from "../../indicatorTicks";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";
import { liveArrivals, trendBars, type Arrival } from "../fixtures";
import { driveLive } from "../liveDrive";
import {
  checkArrivalsAgainstReplay,
  checkDuplicateClosedIdempotent,
  checkLiveReplayEquivalence,
  checkRebuiltEquivalence,
  summarizeEquivalence,
} from "../liveEquivalence";
import { busyTapeFor, tapeOf, ticksOf } from "../syntheticTape";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** A running sum of closes that ignores `replace`: every forming revision is added as if it were a new bar. */
const forgetsReplace: RuntimeIndicatorDef<{ sum: number }, Record<string, never>> = {
  kind: "runtime",
  id: "forgetsReplace",
  label: "Forgets Replace",
  category: "technical",
  defaultSettings: {},
  lines: [{ key: "sum" }],
  placement: { kind: "overlay" },
  createState: () => ({ sum: 0 }),
  onBar: (ctx) => {
    ctx.state.sum += ctx.bar.close;
  },
  readOutput: (state) => ({ sum: state.sum }),
};

/** Volume priced by the tick store: the bar's prints when the window is fully covered, null otherwise. */
const tickVolume: RuntimeIndicatorDef<{ value: number | null }, Record<string, never>> = {
  kind: "runtime",
  id: "tickVolume",
  label: "Tick Volume",
  category: "l1",
  defaultSettings: {},
  lines: [{ key: "value" }],
  placement: { kind: "ownPane" },
  ticksWanted: true,
  createState: () => ({ value: null }),
  onBar: (ctx) => {
    const from = ctx.bar.ts_open;
    const to = from + ctx.bar.interval_ms;
    if (ctx.ticks === undefined || ctx.ticks.coverageOf(from, to) !== "all") {
      ctx.state.value = null;
      return;
    }
    ctx.state.value = sumPrintsIn(ctx.ticks.prints, from, to).volume;
  },
  readOutput: (state) => ({ value: state.value }),
};

describe("live versus replay equivalence", () => {
  const { bars } = trendBars({ count: 120 });

  it("RSI and Bollinger end on the same committed values whether fed live with revisions or replayed", () => {
    const rsi = checkLiveReplayEquivalence(rsiIndicator, bars, { length: 14 }, { revisionsPerBar: 7 });
    expect(rsi.mutations.filter((mutation) => mutation === "REPLACED_EDGE")).toHaveLength(120 * 7);
    expect(rsi.equal).toBe(true);
    const bollinger = checkLiveReplayEquivalence(bollingerIndicator, bars, { length: 20, mult: 2 });
    expect(bollinger.equal).toBe(true);
    expect(summarizeEquivalence("bollinger", bollinger)).toContain("PASS");
  });

  it("catches an indicator that commits forming revisions", () => {
    const report = checkLiveReplayEquivalence(forgetsReplace, bars.slice(0, 10), {}, { revisionsPerBar: 2 });
    expect(report.equal).toBe(false);
    expect(report.outputsEqual).toBe(false);
    expect(report.outputDiffs[0]).toMatchObject({ index: 0, key: "sum" });
    expect(summarizeEquivalence("forgetsReplace", report)).toContain("disagreement");
  });

  it("a tick-only indicator differs exactly as documented: bubbles live, honest nothing in replay", () => {
    const prints = busyTapeFor(bars, { printsPerBar: 30, largeShare: 0.05 });
    const report = checkLiveReplayEquivalence(largeTradeBubblesIndicator, bars, { multiplier: 2 }, {
      revisionsPerBar: 3,
      tradesFor: (bar, revision, revisions) => {
        const all = prints.get(bar.ts_open)!;
        return { trades: all.slice(0, Math.ceil((all.length * (revision + 1)) / revisions)), tradeAvailability: "LIVE_COMPLETE" };
      },
    });
    expect(report.outputsEqual).toBe(true);
    expect(report.markersEqual).toBe(false);
    expect(report.markerDiff.leftOnly.length).toBeGreaterThan(0);
    expect(report.markerDiff.rightOnly).toEqual([]);
    expect(report.replay.markers).toEqual([]);
  });

  it("a duplicated closed bar is a REPLACED_EDGE that changes nothing", () => {
    const report = checkDuplicateClosedIdempotent(rsiIndicator, bars.slice(0, 40), { length: 14 }, 25);
    expect(report.duplicateMutation).toBe("REPLACED_EDGE");
    expect(report.equal).toBe(true);
    const broken = checkDuplicateClosedIdempotent(forgetsReplace, bars.slice(0, 10), {}, 4);
    expect(broken.equal).toBe(false);
  });

  it("a late bar rebuilds to exactly what a clean replay gives", () => {
    const report = checkRebuiltEquivalence(bollingerIndicator, bars.slice(0, 60), { length: 20, mult: 2 }, 30);
    expect(report.sawRebuilt).toBe(true);
    expect(report.equal).toBe(true);
    expect(report.live.outputs.basis).toHaveLength(60);
  });

  it("a reconnect that clears the tick store turns earlier bars into honest nulls, never stale values", () => {
    const series = bars.slice(0, 8);
    const prints = busyTapeFor(series, { printsPerBar: 10 });
    const tape = tapeOf([], series[0].ts_open);
    const arrivals: Arrival[] = series.map((bar, index) => ({
      bar,
      act: (session) => {
        if (index === 5) {
          // The connection dropped: the store is reset and handed over again, empty.
          tape.reset();
          session.setTicks(ticksOf(tape));
        }
        for (const print of prints.get(bar.ts_open)!) tape.add(print);
      },
    }));
    const result = driveLive(tickVolume, arrivals, {}, { ticks: ticksOf(tape) });
    const values = result.outputs.value;
    expect(values).toHaveLength(8);
    for (let index = 0; index < 5; index += 1) expect(values[index]).toBeNull();
    for (let index = 5; index < 8; index += 1) {
      expect(values[index]).toBeCloseTo(prints.get(series[index].ts_open)!.reduce((sum, print) => sum + print.size, 0), 6);
    }
    expect(values.some((value) => value !== null && Number.isNaN(value))).toBe(false);
  });

  it("an arbitrary arrival script can be judged against a clean replay of what it produced", () => {
    const arrivals = liveArrivals(bars.slice(0, 15), 2);
    const report = checkArrivalsAgainstReplay(rsiIndicator, arrivals, { length: 5 });
    expect(report.equal).toBe(true);
    expect(report.live.outputs.value).toHaveLength(15);
  });
});
