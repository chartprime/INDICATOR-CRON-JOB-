import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame, TradeFrame } from "../../../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "../../../chart/candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { AggressiveTape } from "../../aggressive-orders/aggressiveTape";
import { indicatorTicksOf } from "../../../chart/indicatorTicks";
import {
  DXFEED_EQUITY,
  FIXTURE_T0,
  busyTapeFor,
  checkDuplicateClosedIdempotent,
  checkLiveReplayEquivalence,
  checkRebuiltEquivalence,
  checkTruncationInvariance,
  compressionBreakoutBars,
  diffMarkers,
  diffOutputs,
  driveLive,
  equityUnsidedBars,
  historyTapeOf,
  openLiveSession,
  referenceClassify,
  replayCapture,
  sampledIndices,
  sizeSplitFixture,
  summarizeEquivalence,
  summarizeTruncation,
  tapeOf,
  ticksOf,
  timeGapBars,
  trendBars,
  type Arrival,
} from "../../../chart/validation";
import { SIZE_SPLIT_DEFAULT_SETTINGS, sizeSplitDeltaIndicator, type SizeSplitDeltaSettings } from "../sizeSplitDelta";
import { SIZE_RING_CAPACITY, TIER_MIN_SIZES, anchorStartFor, createSizeSplitEngine } from "../sizeSplitDeltaMath";
import { fixtureTicks, markerIndices, withTapeVolume } from "./helpers";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** The per-bar seams are compared too, so they are switched on; the anchor is the tape so no reset hides a difference. */
const AUTO: SizeSplitDeltaSettings = { ...SIZE_SPLIT_DEFAULT_SETTINGS, anchor: "tape", showBarLines: true, showConflict: true };
const FIXED: SizeSplitDeltaSettings = { ...AUTO, tierMode: "fixed", tierSize: 0.5 };
const FIXTURE = sizeSplitFixture();

function noNaN(outputs: Readonly<Record<string, readonly (number | null)[]>>): void {
  for (const values of Object.values(outputs)) for (const value of values) expect(value === null || Number.isFinite(value)).toBe(true);
}

/** A busy synthetic instrument whose candles carry their prints' volume, with every print in one store. */
function busyInstrument(count: number, printsPerBar: number, seed = 5) {
  const { bars: raw } = trendBars({ count, driftPerBar: 0.5, noise: 25 });
  const printsByBar = busyTapeFor(raw, { printsPerBar, seed });
  const bars = withTapeVolume(raw, printsByBar);
  const prints = bars.flatMap((bar) => printsByBar.get(bar.ts_open) ?? []);
  return { bars, prints, printsByBar, ticks: ticksOf(tapeOf(prints, bars[0].ts_open)) };
}

describe("sizeSplitDelta -- no future data: truncation invariance (protocol check 1, rule 13)", () => {
  it("passes at every cut of the mechanism fixture with the whole tape in the store: a committed bar ignores prints past its window end", () => {
    const report = checkTruncationInvariance(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, { extras: { ticks: fixtureTicks(FIXTURE) } });
    console.log(summarizeTruncation(report));
    expect(report.checked).toBe(FIXTURE.bars.length);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("passes on compressionBreakoutBars and a sampled trend sweep with a busy tape", () => {
    const breakout = compressionBreakoutBars();
    const breakoutPrints = busyTapeFor(breakout.bars, { printsPerBar: 40 });
    const breakoutBars = withTapeVolume(breakout.bars, breakoutPrints);
    const breakoutTicks = ticksOf(tapeOf(breakoutBars.flatMap((bar) => breakoutPrints.get(bar.ts_open) ?? []), breakoutBars[0].ts_open));
    const first = checkTruncationInvariance(sizeSplitDeltaIndicator, breakoutBars, AUTO, { extras: { ticks: breakoutTicks }, indices: sampledIndices(breakoutBars.length, 13) });
    expect(first.ok).toBe(true);
    const busy = busyInstrument(600, 60);
    const second = checkTruncationInvariance(sizeSplitDeltaIndicator, busy.bars, AUTO, { extras: { ticks: busy.ticks }, indices: sampledIndices(busy.bars.length, 17) });
    expect(second.ok).toBe(true);
  }, 120_000);

  it("a store loaded with the whole fixture up front equals one fed bar by bar", () => {
    const upFront = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, { ticks: fixtureTicks(FIXTURE) });
    const tape = new AggressiveTape(() => FIXTURE_T0);
    tape.reset();
    const ticks = indicatorTicksOf(tape)!;
    const arrivals: Arrival[] = FIXTURE.bars.map((bar, index) => ({
      bar,
      act: () => {
        for (const print of FIXTURE.printsByBar[index]) tape.add(print);
      },
    }));
    const fed = driveLive(sizeSplitDeltaIndicator, arrivals, AUTO, { ticks });
    expect(diffOutputs(upFront.outputs, fed.outputs)).toEqual([]);
    const markers = diffMarkers(upFront.markers, fed.markers);
    expect(markers.leftOnly).toEqual([]);
    expect(markers.rightOnly).toEqual([]);
  }, 60_000);
});

describe("sizeSplitDelta -- replay versus live equivalence (protocol check 2, round 3 ruling 4)", () => {
  it("ends on the same committed values and markers whether fed live with forming revisions or replayed, both reading the same store", () => {
    const report = checkLiveReplayEquivalence(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, { revisionsPerBar: 5, extras: { ticks: fixtureTicks(FIXTURE) } });
    console.log(summarizeEquivalence("sizeSplitDelta mechanism fixture", report));
    expect(report.mutations.filter((mutation) => mutation === "REPLACED_EDGE")).toHaveLength(FIXTURE.bars.length * 5);
    expect(report.equal).toBe(true);
    expect(report.live.markers.length).toBeGreaterThan(0);
    noNaN(report.live.outputs);
  }, 120_000);

  it("exact eligibility after the rollover: per-bar seams, cumulatives and markers agree from the first retained bar whose anchor start and preceding 4,096 committed sizes both lie inside the retained series", () => {
    const extra = 300;
    const busy = busyInstrument(MAX_RETAINED_SOURCE_BARS + extra, 20, 11);
    const settings: SizeSplitDeltaSettings = { ...AUTO, anchor: "day" };
    const live = driveLive(sizeSplitDeltaIndicator, busy.bars.map((bar) => ({ bar })), settings, { ticks: busy.ticks });
    expect(live.bars).toHaveLength(MAX_RETAINED_SOURCE_BARS);
    const retained = live.bars;
    const replay = replayCapture(sizeSplitDeltaIndicator, retained, settings, { ticks: busy.ticks });
    let sizesBefore = 0;
    let eligibleFrom = -1;
    for (let index = 0; index < retained.length; index += 1) {
      const anchorInside = (anchorStartFor(retained[index].ts_open, "day") as number) >= retained[0].ts_open;
      if (anchorInside && sizesBefore >= SIZE_RING_CAPACITY) {
        eligibleFrom = index;
        break;
      }
      sizesBefore += (busy.printsByBar.get(retained[index].ts_open) ?? []).length;
    }
    expect(eligibleFrom).toBeGreaterThan(0);
    let compared = 0;
    for (const key of Object.keys(replay.outputs)) {
      for (let index = eligibleFrom; index < retained.length; index += 1) {
        expect(replay.outputs[key][index]).toBe(live.outputs[key][index]);
        if (key === "large" && live.outputs[key][index] !== null) compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
    const cutoff = retained[eligibleFrom].ts_open;
    const liveMarkers = live.markers.filter((call) => call.time >= cutoff);
    const replayMarkers = replay.markers.filter((call) => call.time >= cutoff);
    const diff = diffMarkers(liveMarkers, replayMarkers);
    expect(diff.leftOnly).toEqual([]);
    expect(diff.rightOnly).toEqual([]);
    console.log(`sizeSplitDelta retention equivalence: eligible from retained bar ${eligibleFrom}, ${compared} large values compared equal, ${liveMarkers.length} markers compared`);
  }, 300_000);

  it("forming prefix (amendment 4): at every revision the forming output equals the frozen cumulative plus the contribution of the prints received so far", () => {
    const index = 60;
    const bars = FIXTURE.bars.slice(0, index + 1);
    const tape = new AggressiveTape(() => FIXTURE_T0);
    tape.reset();
    for (let bar = 0; bar < index; bar += 1) for (const print of FIXTURE.printsByBar[bar]) tape.add(print);
    const ticks = indicatorTicksOf(tape)!;
    const session = openLiveSession(sizeSplitDeltaIndicator, AUTO, { ticks }, []);
    try {
      for (let bar = 0; bar < index; bar += 1) session.dispatch({ bar: bars[bar] });
      const before = session.capture();
      const base = before.outputs.large[index - 1] as number;
      const baseSmall = before.outputs.small[index - 1] as number;
      const engine = createSizeSplitEngine({ tierMode: "auto", tierSize: 0.5, anchor: "tape", K: 20, m: 2, q: 2, minTapeShare: 0.5 });
      for (let bar = 0; bar < index; bar += 1) engine.onBar(bars[bar], ticks);
      const forming = bars[index];
      const prints = FIXTURE.printsByBar[index];
      const revisions = 6;
      let received: TradeFrame[] = [];
      for (let revision = 1; revision <= revisions; revision += 1) {
        const cutoff = forming.ts_open + Math.floor((revision / revisions) * forming.interval_ms);
        const incoming = prints.filter((print) => print.ts_exchange < cutoff && !received.includes(print));
        for (const print of incoming) tape.add(print);
        received = [...received, ...incoming];
        const volume = received.reduce((sum, print) => sum + print.size, 0);
        const closed = revision === revisions;
        session.dispatch({ bar: { ...forming, volume, close: received[received.length - 1]?.price ?? forming.open, closed } as BarFrame });
        const capture = session.capture();
        const tier = engine.tail?.tierAtOpen ?? engine.sizeRing.threshold();
        const expected = referenceClassify(received, forming.ts_open, forming.ts_open + forming.interval_ms, tier);
        expect(capture.outputs.large[index]).toBeCloseTo(base + (expected.largeBar as number), 9);
        expect(capture.outputs.small[index]).toBeCloseTo(baseSmall + (expected.smallBar as number), 9);
        expect(capture.outputs.largeBar[index]).toBeCloseTo(expected.largeBar as number, 9);
      }
      expect(received).toHaveLength(prints.length);
    } finally {
      session.close();
    }
  }, 60_000);
});

describe("sizeSplitDelta -- gap, duplicate, late and reconnect behaviour (protocol check 3, rule 6, amendment 1)", () => {
  const ticks = fixtureTicks(FIXTURE);

  it("duplicate closed bar is idempotent and adds no marker", () => {
    const report = checkDuplicateClosedIdempotent(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, 75, { extras: { ticks } });
    expect(report.duplicateMutation).toBe("REPLACED_EDGE");
    expect(report.equal).toBe(true);
  }, 60_000);

  it("late bar rebuilds to the replay", () => {
    const report = checkRebuiltEquivalence(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, 100, { extras: { ticks } });
    expect(report.sawRebuilt).toBe(true);
    expect(report.equal).toBe(true);
  }, 60_000);

  it("a print arriving after the tail's last revision and before supersession leaves the committed outputs equal to the displayed history and to a replay built from the same displayed decisions; a REBUILT then includes it", () => {
    const index = 80;
    const tape = new AggressiveTape(() => FIXTURE_T0);
    tape.reset();
    for (let bar = 0; bar <= index; bar += 1) for (const print of FIXTURE.printsByBar[bar]) if (bar < index || print.ts_exchange < FIXTURE.bars[index].ts_open + 50_000) tape.add(print);
    const live = indicatorTicksOf(tape)!;
    const session = openLiveSession(sizeSplitDeltaIndicator, AUTO, { ticks: live }, []);
    try {
      for (let bar = 0; bar < index; bar += 1) session.dispatch({ bar: FIXTURE.bars[bar] });
      const partial = FIXTURE.printsByBar[index].filter((print) => print.ts_exchange < FIXTURE.bars[index].ts_open + 50_000);
      session.dispatch({ bar: { ...FIXTURE.bars[index], closed: false, volume: partial.reduce((sum, print) => sum + print.size, 0) } as BarFrame });
      const displayed = session.capture();
      const shownLarge = displayed.outputs.largeBar[index];
      // The late print: one of the fixture's own large prints of this bar, landing after the last revision.
      const late = FIXTURE.printsByBar[index].find((print) => print.ts_exchange >= FIXTURE.bars[index].ts_open + 50_000 && print.size === 1)!;
      tape.add(late);
      session.dispatch({ bar: FIXTURE.bars[index + 1] });
      const after = session.capture();
      expect(after.outputs.largeBar[index]).toBe(shownLarge);
      expect(after.outputs.large[index]).toBe(displayed.outputs.large[index]);
      // The replay built from the same displayed decisions (a store without the late print) equals the live history.
      const tapeWithout = new AggressiveTape(() => FIXTURE_T0);
      tapeWithout.reset();
      for (let bar = 0; bar <= index; bar += 1) for (const print of FIXTURE.printsByBar[bar]) if (bar < index || partial.includes(print)) tapeWithout.add(print);
      const ticksWithout = indicatorTicksOf(tapeWithout)!;
      const replayDisplayed = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars.slice(0, index + 2).map((bar, i) => (i === index + 1 ? { ...bar, closed: false } : bar)) as BarFrame[], AUTO, { ticks: ticksWithout });
      expect(replayDisplayed.outputs.largeBar[index]).toBe(shownLarge);
      // A REBUILT over the store that holds the late print includes it, once the candle's volume carries the print too
      // (a revised candle for an older bar is itself a REBUILT); with the stale partial volume the bar would fail the share gate.
      const partialVolume = partial.reduce((sum, print) => sum + print.size, 0);
      session.dispatch({ bar: { ...FIXTURE.bars[index], closed: false, volume: partialVolume + late.size } as BarFrame });
      expect(session.mutations.at(-1)).toBe("REBUILT");
      const rebuilt = session.capture();
      expect(rebuilt.outputs.largeBar[index]).not.toBe(shownLarge);
      expect(rebuilt.outputs.largeBar[index]).toBeCloseTo((shownLarge as number) + (late.side === "buy" ? 1 : -1), 9);
    } finally {
      session.close();
    }
  }, 60_000);

  it("reconnect clears the store honestly: bars the new store does not cover read null, the rest recover after the warm-up", () => {
    const at = 150;
    const arrivals: Arrival[] = FIXTURE.bars.map((bar, index) => ({
      bar,
      act:
        index === at
          ? (session) => {
              session.setTicks(ticksOf(tapeOf(FIXTURE.prints.filter((print) => print.ts_exchange >= bar.ts_open), bar.ts_open)));
            }
          : undefined,
    }));
    const result = driveLive(sizeSplitDeltaIndicator, arrivals, AUTO, { ticks });
    for (let index = 0; index < at; index += 1) expect(result.outputs.large[index]).toBeNull();
    expect(result.outputs.large[at]).toBeNull();
    expect(result.outputs.large[at + 1]).toBeNull();
    expect(result.outputs.large[at + 2]).not.toBeNull();
    expect(result.markers.every((call) => call.time >= FIXTURE.bars[at].ts_open)).toBe(true);
    noNaN(result.outputs);
  }, 60_000);

  it("out-of-order prints: a shuffled store gives the same outputs as an in-order one", () => {
    let state = 99;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const shuffled = [...FIXTURE.prints];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    const ordered = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, { ticks });
    const unordered = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, AUTO, { ticks: ticksOf(tapeOf(shuffled, FIXTURE_T0)) });
    expect(diffOutputs(ordered.outputs, unordered.outputs)).toEqual([]);
  }, 60_000);

  it("time gap: the cumulative carries across missing minutes and nothing before the gap changes", () => {
    const { bars: raw, labels } = timeGapBars({ count: 400 });
    const printsByBar = busyTapeFor(raw, { printsPerBar: 40 });
    const bars = withTapeVolume(raw, printsByBar);
    const gapTicks = ticksOf(tapeOf(bars.flatMap((bar) => printsByBar.get(bar.ts_open) ?? []), bars[0].ts_open));
    const gapped = replayCapture(sizeSplitDeltaIndicator, bars, FIXED, { ticks: gapTicks });
    const prefix = replayCapture(sizeSplitDeltaIndicator, bars.slice(0, labels.gapAfterIndex + 1), FIXED, { ticks: gapTicks });
    expect(diffOutputs(gapped.outputs, prefix.outputs, 0, labels.gapAfterIndex)).toEqual([]);
    const after = labels.firstBarAfterGapIndex;
    expect(gapped.outputs.large[after]).toBeCloseTo((gapped.outputs.large[after - 1] as number) + (gapped.outputs.largeBar[after] as number), 9);
    noNaN(gapped.outputs);
  }, 60_000);

  it("thin history is null: a store that only holds the server's floor-filtered prints covers no window", () => {
    const thin = historyTapeOf(FIXTURE.prints.filter((print) => print.size >= 1), 1, FIXTURE_T0, FIXTURE_T0 + FIXTURE.bars.length * 60_000);
    const capture = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, FIXED, { ticks: ticksOf(thin) });
    expect(capture.outputs.large.every((value) => value === null)).toBe(true);
    expect(capture.markers).toEqual([]);
    const full = historyTapeOf(FIXTURE.prints, 0, FIXTURE_T0, FIXTURE_T0 + FIXTURE.bars.length * 60_000);
    const served = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, FIXED, { ticks: ticksOf(full) });
    expect(served.outputs.large.filter((value) => value !== null).length).toBe(FIXTURE.bars.length);
  }, 60_000);
});

describe("sizeSplitDelta -- warm-up, empty input and NaN (protocol check 4)", () => {
  it("auto mode is null until 200 trade frames from complete windows have been committed, then values appear at the next bar; fixed mode values from the first bar; never NaN or a fabricated zero", () => {
    const auto = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars.slice(0, 10), AUTO, { ticks: fixtureTicks(FIXTURE) });
    expect(auto.outputs.large[0]).toBeNull();
    expect(auto.outputs.large[1]).toBeNull();
    expect(auto.outputs.large[2]).not.toBeNull();
    expect(FIXTURE.printsByBar[0].length + FIXTURE.printsByBar[1].length).toBe(TIER_MIN_SIZES);
    const fixed = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars.slice(0, 10), FIXED, { ticks: fixtureTicks(FIXTURE) });
    expect(fixed.outputs.large[0]).not.toBeNull();
    noNaN(auto.outputs);
    noNaN(fixed.outputs);
    const shorter = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars.slice(0, 2), AUTO, { ticks: fixtureTicks(FIXTURE) });
    expect(shorter.outputs.large.every((value) => value === null)).toBe(true);
  });

  it("handles an empty bar array and a store without prints", () => {
    const capture = replayCapture(sizeSplitDeltaIndicator, [], AUTO, { ticks: ticksOf(tapeOf([], FIXTURE_T0)) });
    expect(capture.faulted).toBe(false);
    expect(capture.outputs.large).toEqual([]);
    const empty = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars.slice(0, 5), FIXED, { ticks: ticksOf(tapeOf([], FIXTURE_T0)) });
    expect(empty.faulted).toBe(false);
    expect(empty.outputs.large.every((value) => value === null)).toBe(true);
  });
});

describe("sizeSplitDelta -- equity tape share (protocol check 9, rule 5)", () => {
  it("draws when the sided tape covers 60 percent of the candle volume and is null with the share row at 40 percent; candle sides are never read", () => {
    const { bars: raw } = trendBars({ count: 120, identity: DXFEED_EQUITY, startPrice: 190, driftPerBar: 0.02, noise: 0.3 });
    const printsByBar = busyTapeFor(raw, { printsPerBar: 50, identity: DXFEED_EQUITY, smallSize: 10 });
    const taped = withTapeVolume(raw, printsByBar);
    const prints = taped.flatMap((bar) => printsByBar.get(bar.ts_open) ?? []);
    const equityTicks = ticksOf(tapeOf(prints, taped[0].ts_open));
    const settings: SizeSplitDeltaSettings = { ...FIXED, tierSize: 50 };
    const sixty = taped.map((bar) => ({ ...bar, volume: bar.volume / 0.6, buy_volume: undefined, sell_volume: undefined }) as BarFrame);
    const forty = taped.map((bar) => ({ ...bar, volume: bar.volume / 0.4, buy_volume: undefined, sell_volume: undefined }) as BarFrame);
    const ok = replayCapture(sizeSplitDeltaIndicator, sixty, settings, { ticks: equityTicks });
    expect(ok.outputs.large.every((value) => value !== null)).toBe(true);
    const low = replayCapture(sizeSplitDeltaIndicator, forty, settings, { ticks: equityTicks });
    expect(low.outputs.large.every((value) => value === null)).toBe(true);
    expect(low.markers).toEqual([]);
    const engine = createSizeSplitEngine({ tierMode: "fixed", tierSize: 50, anchor: "tape", K: 20, m: 2, q: 2, minTapeShare: 0.5 });
    const readingLow = engine.onBar(forty[0], equityTicks);
    expect(readingLow.status).toBe("shareLow");
    expect(readingLow.share).toBeCloseTo(0.4, 9);
  });

  it("equityUnsidedBars without a tape is null throughout, whatever the candle sides say", () => {
    const { bars } = equityUnsidedBars();
    const capture = replayCapture(sizeSplitDeltaIndicator, bars, FIXED);
    expect(capture.faulted).toBe(false);
    for (const values of Object.values(capture.outputs)) expect(values.every((value) => value === null)).toBe(true);
    expect(capture.markers).toEqual([]);
  });
});

describe("sizeSplitDelta -- anchor rollover on the fixture (rule 8, round 3 ruling 3)", () => {
  it("the first bar of the new UTC day shows only its own contribution, the ring is empty and no marker crosses the reset", () => {
    const settings: SizeSplitDeltaSettings = { ...AUTO, anchor: "day" };
    const capture = replayCapture(sizeSplitDeltaIndicator, FIXTURE.bars, settings, { ticks: fixtureTicks(FIXTURE) });
    const first = FIXTURE.bars.findIndex((bar, index) => index > 0 && anchorStartFor(bar.ts_open, "day") !== anchorStartFor(FIXTURE.bars[index - 1].ts_open, "day"));
    expect(first).toBe(214);
    expect(capture.outputs.large[first]).toBeCloseTo(capture.outputs.largeBar[first] as number, 9);
    expect(capture.outputs.small[first]).toBeCloseTo(capture.outputs.smallBar[first] as number, 9);
    expect(capture.outputs.large[first - 1]).not.toBeCloseTo(capture.outputs.largeBar[first - 1] as number, 3);
    const arrows = [...markerIndices(capture.markers, FIXTURE.bars, "arrowDown"), ...markerIndices(capture.markers, FIXTURE.bars, "arrowUp")];
    expect(arrows.filter((index) => index >= first && index < first + 20)).toEqual([]);
    expect(arrows.filter((index) => index >= first + 20).length).toBeGreaterThan(0);
  });
});
