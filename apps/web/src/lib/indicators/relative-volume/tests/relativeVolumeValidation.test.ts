import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { replayBars } from "../../../chart/replayBars";
import {
  checkArrivalsAgainstReplay,
  checkDuplicateClosedIdempotent,
  checkLiveReplayEquivalence,
  checkRebuiltEquivalence,
  checkTruncationInvariance,
  compressionBreakoutBars,
  countMarkers,
  countMarkersOver,
  diffOutputs,
  driveLive,
  duplicateClosedArrivals,
  formingRevisions,
  liveArrivals,
  relativeVolumeCryptoFixture,
  relativeVolumeEquityFixture,
  replayCapture,
  sampledIndices,
  summarizeEquivalence,
  summarizeTruncation,
  timeGapBars,
  trendBars,
  type Arrival,
} from "../../../chart/validation";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator, type RelativeVolumeSettings } from "../relativeVolume";
import { RVOL_ROLLING_LENGTH, createRelativeVolumeEngine, slotKeyOf } from "../relativeVolumeMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** The equivalence checks compare the rolling line too, so it is switched on. */
const SETTINGS: RelativeVolumeSettings = { ...RELATIVE_VOLUME_DEFAULT_SETTINGS, showRolling: true };
const EQUITY = relativeVolumeEquityFixture();
const CRYPTO = relativeVolumeCryptoFixture();

function noNaN(outputs: Readonly<Record<string, readonly (number | null)[]>>): void {
  for (const values of Object.values(outputs)) {
    for (const value of values) expect(value === null || Number.isFinite(value)).toBe(true);
  }
}

describe("relativeVolume -- no future data: truncation invariance (protocol check 1)", () => {
  it("passes on a sampled sweep of the equity fixture, numbers and confirmed markers", () => {
    const report = checkTruncationInvariance(relativeVolumeIndicator, EQUITY.bars, SETTINGS, { indices: sampledIndices(EQUITY.bars.length, 97) });
    console.log(summarizeTruncation(report));
    expect(report.faulted).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.markerViolations).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("passes at every cut of compressionBreakoutBars and trendBars", () => {
    for (const { bars } of [compressionBreakoutBars(), trendBars({ count: 600 })]) {
      const report = checkTruncationInvariance(relativeVolumeIndicator, bars, SETTINGS);
      expect(report.checked).toBe(bars.length);
      expect(report.ok).toBe(true);
    }
  }, 120_000);
});

describe("relativeVolume -- replay versus live equivalence (protocol check 2)", () => {
  it("ends on the same committed values and markers whether fed live with forming revisions or replayed", () => {
    const report = checkLiveReplayEquivalence(relativeVolumeIndicator, EQUITY.bars, SETTINGS, { revisionsPerBar: 5 });
    console.log(summarizeEquivalence("relativeVolume equity fixture", report));
    expect(report.mutations.filter((mutation) => mutation === "REPLACED_EDGE")).toHaveLength(EQUITY.bars.length * 5);
    expect(report.outputsEqual).toBe(true);
    expect(report.markersEqual).toBe(true);
    expect(report.equal).toBe(true);
    expect(report.live.markers.length).toBeGreaterThan(0);
    noNaN(report.live.outputs);
    noNaN(report.replay.outputs);
  }, 120_000);

  it("a bar whose close never arrived is committed by the next bar: its numbers match the replay, its marker stays provisional and is excluded", () => {
    // Every anomaly bar loses its closed dispatch: the forming revisions arrive, then the next bar.
    const anomalyIndices = new Set(EQUITY.labels.anomalyIndices);
    const arrivals: Arrival[] = [];
    EQUITY.bars.forEach((bar, index) => {
      const frames = formingRevisions(bar, 3);
      if (anomalyIndices.has(index)) frames.pop();
      for (const frame of frames) arrivals.push({ bar: frame });
    });
    const live = driveLive(relativeVolumeIndicator, arrivals, SETTINGS);
    const replay = replayCapture(relativeVolumeIndicator, EQUITY.bars, SETTINGS);
    // The last forming revision carries 3/4 of the bar's volume; the replay sees the whole bar, so compare on the volumes live saw.
    const liveBars = live.bars;
    const replayOfLiveBars = replayCapture(relativeVolumeIndicator, liveBars.map((bar) => ({ ...bar, closed: true })), SETTINGS);
    expect(diffOutputs(live.outputs, replayOfLiveBars.outputs)).toEqual([]);
    expect(replay.markers.length).toBeGreaterThanOrEqual(EQUITY.labels.anomalies.length);
    const provisional = live.markers.filter((call) => call.color.startsWith("rgba("));
    const confirmed = live.markers.filter((call) => !call.color.startsWith("rgba("));
    expect(provisional.length).toBeGreaterThan(0);
    for (const call of provisional) expect(anomalyIndices.has(EQUITY.bars.findIndex((bar) => bar.ts_open === call.time))).toBe(true);
    for (const call of confirmed) expect(anomalyIndices.has(EQUITY.bars.findIndex((bar) => bar.ts_open === call.time))).toBe(false);
  }, 120_000);

  it("a replay whose tail is a forming bar keeps the tail pending and provisional", () => {
    const bars = EQUITY.bars.slice(0, 5 * 390 + 100);
    const tailOpen = { ...bars[bars.length - 1], closed: false, volume: Math.round(bars[bars.length - 1].volume / 2) } as BarFrame;
    const withTail = [...bars.slice(0, -1), tailOpen];
    const capture = replayCapture(relativeVolumeIndicator, withTail, SETTINGS);
    expect(capture.faulted).toBe(false);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const bar of withTail) engine.onBar(bar);
    expect(engine.tail!.committed).toBe(false);
    expect(engine.tail!.confirmed).toBe(false);
    expect(engine.current!.status).toBe("forming");
    expect(capture.outputs.rvol[withTail.length - 1]).toBe(engine.current!.rvol);
    expect(engine.current!.rvol).not.toBeNull();
    noNaN(capture.outputs);
  });
});

describe("relativeVolume -- gap, duplicate and late-event behavior (protocol check 3)", () => {
  const session5 = EQUITY.bars.slice(0, 4 * 390 + 60);

  it("duplicate closed bar is idempotent", () => {
    const report = checkDuplicateClosedIdempotent(relativeVolumeIndicator, session5, SETTINGS, session5.length - 20);
    expect(report.duplicateMutation).toBe("REPLACED_EDGE");
    expect(report.equal).toBe(true);
    const budget = countMarkersOver(relativeVolumeIndicator, duplicateClosedArrivals(EQUITY.bars, EQUITY.labels.anomalyIndices[0]).arrivals, SETTINGS);
    expect(budget.total).toBe(countMarkers(relativeVolumeIndicator, EQUITY.bars, SETTINGS).total);
  }, 60_000);

  it("late bar rebuilds to the replay", () => {
    const report = checkRebuiltEquivalence(relativeVolumeIndicator, session5, SETTINGS, 4 * 390 + 10);
    expect(report.sawRebuilt).toBe(true);
    expect(report.equal).toBe(true);
    expect(report.live.outputs.rvol).toHaveLength(session5.length);
  }, 60_000);

  it("a correction to an older bar arrives as a REBUILT and every successor equals a fresh replay (amendment 1)", () => {
    const corrected = 3 * 390 + 200;
    const arrivals: Arrival[] = session5.map((bar) => ({ bar }));
    arrivals.push({ bar: { ...session5[corrected], volume: session5[corrected].volume * 4 }, label: "correction" });
    const report = checkArrivalsAgainstReplay(relativeVolumeIndicator, arrivals, SETTINGS);
    expect(report.mutations[report.mutations.length - 1]).toBe("REBUILT");
    expect(report.equal).toBe(true);
    const correctedSeries = session5.map((bar, index) => (index === corrected ? { ...bar, volume: bar.volume * 4 } : bar));
    const fresh = replayCapture(relativeVolumeIndicator, correctedSeries, SETTINGS);
    expect(diffOutputs(report.live.outputs, fresh.outputs)).toEqual([]);
    expect(diffOutputs(replayCapture(relativeVolumeIndicator, session5, SETTINGS).outputs, fresh.outputs).length).toBeGreaterThan(0);
  }, 60_000);

  it("changed-volume closed replacement: both rings take the new volume, the ratio uses the stored denominator, the marker follows, and later bars match a replay that only saw the final volume", () => {
    const index = 4 * 390 + 30;
    const bar = session5[index];
    const prefix = session5.slice(0, index);
    const base = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const earlier of prefix) base.onBar(earlier);
    const denominator = base.onBar({ ...bar, volume: 100 }).rvol;
    expect(denominator).not.toBeNull();
    const median = 100 / denominator!;
    const hotVolume = Math.ceil(median * 2.2);
    const arrivals: Arrival[] = prefix.map((earlier) => ({ bar: earlier }));
    arrivals.push({ bar: { ...bar, volume: 100 } });
    arrivals.push({ bar: { ...bar, volume: hotVolume }, label: "closed again" });
    for (const later of session5.slice(index + 1)) arrivals.push({ bar: later });
    const report = checkArrivalsAgainstReplay(relativeVolumeIndicator, arrivals, SETTINGS);
    expect(report.mutations[index + 1]).toBe("REPLACED_EDGE");
    expect(report.equal).toBe(true);
    expect(report.live.outputs.rvol[index]).toBeCloseTo(hotVolume / median, 12);
    expect(report.live.markers.some((call) => call.time === bar.ts_open)).toBe(true);
    // Back below the threshold on a third close: the marker disappears and the ratio still uses the stored median.
    const back = driveLive(relativeVolumeIndicator, [...arrivals.slice(0, index + 2), { bar: { ...bar, volume: 100 } }], SETTINGS);
    expect(back.outputs.rvol[index]).toBe(denominator);
    expect(back.markers.some((call) => call.time === bar.ts_open)).toBe(false);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const earlier of prefix) engine.onBar(earlier);
    engine.onBar({ ...bar, volume: 100 });
    engine.onBar({ ...bar, volume: hotVolume });
    const key = slotKeyOf(bar.ts_open, "newYork")!;
    expect(engine.slotRing(key)!.items[engine.slotRing(key)!.items.length - 1]).toEqual({ tsOpen: bar.ts_open, volume: hotVolume });
    expect(engine.rollingRing.items[RVOL_ROLLING_LENGTH - 1]).toEqual({ tsOpen: bar.ts_open, volume: hotVolume });
    expect(engine.slotRing(key)!.items.filter((item) => item.tsOpen === bar.ts_open)).toHaveLength(1);
  }, 60_000);

  it("valid to invalid to valid with both rings full (14 prior per slot) equals a replay that saw only the final state (amendment 2)", () => {
    const index = 14 * 390 + 45; // session 15: every slot already holds 10 observations, the rolling ring 20
    const bar = EQUITY.bars[index];
    const prefix = EQUITY.bars.slice(0, index);
    const arrivals: Arrival[] = prefix.map((earlier) => ({ bar: earlier }));
    arrivals.push({ bar: { ...bar, volume: bar.volume + 1 } });
    arrivals.push({ bar: { ...bar, volume: Number.NaN }, label: "invalid" });
    arrivals.push({ bar: { ...bar, volume: bar.volume * 3 }, label: "valid again" });
    for (const later of EQUITY.bars.slice(index + 1, index + 40)) arrivals.push({ bar: later });
    const report = checkArrivalsAgainstReplay(relativeVolumeIndicator, arrivals, SETTINGS);
    expect(report.equal).toBe(true);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const earlier of prefix) engine.onBar(earlier);
    const key = slotKeyOf(bar.ts_open, "newYork")!;
    const slotBefore = JSON.stringify(engine.slotRing(key)!.items);
    const rollingBefore = JSON.stringify(engine.rollingRing.items);
    expect(engine.slotRing(key)!.items).toHaveLength(10);
    engine.onBar({ ...bar, volume: bar.volume + 1 });
    expect(engine.slotRing(key)!.evictedByTail).not.toBeNull();
    const invalid = engine.onBar({ ...bar, volume: Number.NaN });
    expect(invalid.rvol).toBeNull();
    expect(invalid.status).toBe("noVolume");
    expect(JSON.stringify(engine.slotRing(key)!.items)).toBe(slotBefore);
    expect(JSON.stringify(engine.rollingRing.items)).toBe(rollingBefore);
    const valid = engine.onBar({ ...bar, volume: bar.volume * 3 });
    expect(valid.rvol).not.toBeNull();
    expect(engine.slotRing(key)!.items).toHaveLength(10);
    expect(engine.slotRing(key)!.items[9]).toEqual({ tsOpen: bar.ts_open, volume: bar.volume * 3 });
  }, 60_000);

  it("time gap: missing minutes file nothing, nothing before the gap changes, the rolling comparison carries across", () => {
    const { bars, labels } = timeGapBars({ count: 600 });
    const gapped = replayCapture(relativeVolumeIndicator, bars, SETTINGS);
    const prefix = replayCapture(relativeVolumeIndicator, bars.slice(0, labels.gapAfterIndex + 1), SETTINGS);
    expect(diffOutputs(gapped.outputs, prefix.outputs, 0, labels.gapAfterIndex)).toEqual([]);
    const after = labels.firstBarAfterGapIndex;
    const previous = bars.slice(after - RVOL_ROLLING_LENGTH, after);
    const mean = previous.reduce((sum, bar) => sum + bar.volume, 0) / RVOL_ROLLING_LENGTH;
    expect(gapped.outputs.rolling[after]).toBeCloseTo(bars[after].volume / mean, 9);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const bar of bars) engine.onBar(bar);
    for (let missing = 1; missing <= labels.missingBars; missing += 1) {
      const key = slotKeyOf(bars[labels.gapAfterIndex].ts_open + missing * 60_000, "utc")!;
      expect(engine.slotRing(key)).toBeUndefined();
    }
    noNaN(gapped.outputs);
  });
});

describe("relativeVolume -- warm-up, empty input and NaN (protocol check 4)", () => {
  it("warm-up is null, never NaN or zero: the first ratio appears when a slot has minSessions prior observations", () => {
    const capture = replayCapture(relativeVolumeIndicator, EQUITY.bars.slice(0, 4 * 390), SETTINGS);
    for (let index = 0; index < 3 * 390; index += 1) expect(capture.outputs.rvol[index]).toBeNull();
    expect(capture.outputs.rvol[3 * 390]).not.toBeNull();
    expect(capture.outputs.rvol[3 * 390]).not.toBe(0);
    for (let index = 0; index < RVOL_ROLLING_LENGTH; index += 1) expect(capture.outputs.rolling[index]).toBeNull();
    expect(capture.outputs.rolling[RVOL_ROLLING_LENGTH]).not.toBeNull();
    noNaN(capture.outputs);
    const shorter = replayCapture(relativeVolumeIndicator, EQUITY.bars.slice(0, 3 * 390), SETTINGS);
    expect(shorter.outputs.rvol.every((value) => value === null)).toBe(true);
  });

  it("handles an empty bar array", () => {
    const { perBar } = replayBars(relativeVolumeIndicator, [], RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(perBar.rvol).toEqual([]);
    expect(perBar.rolling).toEqual([]);
    const capture = replayCapture(relativeVolumeIndicator, [], RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(capture.faulted).toBe(false);
  });

  it("a bar with no usable volume yields null and never poisons later bars", () => {
    const bars = EQUITY.bars.slice(0, 4 * 390 + 5).map((bar, index) => (index === 4 * 390 + 2 ? ({ ...bar, volume: Number.NaN } as BarFrame) : bar));
    const capture = replayCapture(relativeVolumeIndicator, bars, SETTINGS);
    expect(capture.faulted).toBe(false);
    expect(capture.outputs.rvol[4 * 390 + 2]).toBeNull();
    expect(capture.outputs.rolling[4 * 390 + 2]).toBeNull();
    expect(capture.outputs.rvol[4 * 390 + 3]).not.toBeNull();
    noNaN(capture.outputs);
  });

  it("the rolling line is off by default: its output is null while the table value is still computed", () => {
    const capture = replayCapture(relativeVolumeIndicator, EQUITY.bars.slice(0, 100), RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(capture.outputs.rolling.every((value) => value === null)).toBe(true);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    let last = null;
    for (const bar of EQUITY.bars.slice(0, 100)) last = engine.onBar(bar);
    expect(last!.rolling).not.toBeNull();
  });
});

describe("relativeVolume -- crypto fixture: rollover and REBUILT equivalence at sessions = 3 (amendment 7)", () => {
  const settings: RelativeVolumeSettings = { ...SETTINGS, sessions: 3, minSessions: 3 };

  it("a REBUILT replay over the retained 10,080 bars reproduces live outputs for every bar whose full lookback lies within them", () => {
    const retained = CRYPTO.bars.slice(CRYPTO.labels.rebuiltFromIndex);
    expect(retained).toHaveLength(10_080);
    const live = driveLive(relativeVolumeIndicator, CRYPTO.bars.map((bar) => ({ bar })), settings);
    expect(live.bars).toHaveLength(10_080);
    expect(live.bars[0].ts_open).toBe(retained[0].ts_open);
    const replay = replayCapture(relativeVolumeIndicator, retained, settings);
    const priorByKey = new Map<number, number>();
    let compared = 0;
    let withheld = 0;
    retained.forEach((bar, index) => {
      const key = slotKeyOf(bar.ts_open, "utc")!;
      const prior = priorByKey.get(key) ?? 0;
      priorByKey.set(key, prior + 1);
      if (prior >= 3 && index >= RVOL_ROLLING_LENGTH) {
        compared += 1;
        expect(replay.outputs.rvol[index]).toBe(live.outputs.rvol[index]);
        expect(replay.outputs.rolling[index]).toBe(live.outputs.rolling[index]);
        expect(live.outputs.rvol[index]).not.toBeNull();
      } else if (replay.outputs.rvol[index] !== live.outputs.rvol[index]) {
        withheld += 1;
      }
    });
    console.log(`crypto REBUILT equivalence: ${compared} bars compared equal, ${withheld} early retained bars differ because live state kept observations from discarded bars`);
    expect(compared).toBeGreaterThan(0);
    expect(compared).toBe(10_080 - 3 * 1_440);
    expect(withheld).toBeGreaterThan(0);
    noNaN(live.outputs);
  }, 120_000);

  it("the runtime's own REBUILT path on the retained bars equals a clean replay, with a non-zero count of compared bars", () => {
    const retained = CRYPTO.bars.slice(CRYPTO.labels.rebuiltFromIndex);
    const report = checkRebuiltEquivalence(relativeVolumeIndicator, retained, settings, 5_000);
    expect(report.sawRebuilt).toBe(true);
    expect(report.equal).toBe(true);
    const compared = report.live.outputs.rvol.filter((value) => value !== null).length;
    expect(compared).toBeGreaterThan(0);
  }, 120_000);

  it("live versus replay equivalence holds on the first 10,080 crypto bars with forming revisions", () => {
    const report = checkLiveReplayEquivalence(relativeVolumeIndicator, CRYPTO.bars.slice(0, 10_080), settings, { revisionsPerBar: 2 });
    expect(report.equal).toBe(true);
    expect(liveArrivals(CRYPTO.bars.slice(0, 2), 2)).toHaveLength(6);
  }, 120_000);
});
