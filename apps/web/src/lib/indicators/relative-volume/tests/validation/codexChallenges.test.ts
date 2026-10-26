import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../../chart/draw/registry";
import { mergeChartBar } from "../../../../chart/chartData";
import {
  BINANCE_PERP,
  barFrame,
  countMarkers,
  judgeBudget,
  openLiveSession,
  percentilesOf,
  relativeVolumeCryptoFixture,
  replayCapture,
  summarizeBudget,
  timedDef,
} from "../../../../chart/validation";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator, type RelativeVolumeSettings } from "../../relativeVolume";
import { HOUR_MS, MINUTE_MS, createRelativeVolumeEngine } from "../../relativeVolumeMath";
import { medianOf } from "./reference";

// Validation loop 1: the validator's own reproductions of Codex's G3 items
// (PM/log/validation/relativeVolume/codex-g3-round1.md), each judged against
// the PM's ruling. Items the ruling accepts as behaviour are pinned as such;
// items the builder must fix are in rules.test.ts under "amended brief".

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const SETTINGS: RelativeVolumeSettings = { ...RELATIVE_VOLUME_DEFAULT_SETTINGS, showRolling: true };
const T0 = Date.UTC(2026, 2, 2);

function minuteBars(count: number, volumeAt: (index: number) => number): BarFrame[] {
  return Array.from({ length: count }, (_, index) => barFrame(T0 + index * MINUTE_MS, { open: 1, close: 1, high: 1, low: 1, volume: volumeAt(index) }, BINANCE_PERP));
}

/** Codex items 1 and 2: eleven days of one-minute crypto, 100 then 300 per minute, last bar 450. */
const ELEVEN_DAYS = minuteBars(11 * 1_440, (index) => (index === 11 * 1_440 - 1 ? 450 : index < 5 * 1_440 ? 100 : 300));

describe("Codex item 1: a colour change replays and can change a number (reproduced; ruling: builder must fix)", () => {
  it("rollingColor alone drops the latest ratio from 2.25x to 1.5x and removes its confirmed marker on ce8d11c", () => {
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    try {
      for (const bar of ELEVEN_DAYS) session.dispatch({ bar });
      expect(session.bars).toHaveLength(10_080);
      const before = session.capture();
      expect(before.outputs.rvol.at(-1)).toBe(2.25);
      expect(before.markers.some((call) => call.time === ELEVEN_DAYS[ELEVEN_DAYS.length - 1].ts_open)).toBe(true);
      session.updateSettings({ ...SETTINGS, rollingColor: "#123456" });
      const after = session.capture();
      // Live state held ten prior observations for the slot (five at 100, five at 300: median 200);
      // the replay over the retained seven days holds at most six (median 300).
      expect(after.outputs.rvol.at(-1)).toBe(1.5);
      expect(after.markers.some((call) => call.time === ELEVEN_DAYS[ELEVEN_DAYS.length - 1].ts_open)).toBe(false);
    } finally {
      session.close();
    }
  }, 120_000);
});

describe("Codex item 2: default lookback 10 exceeds one-minute crypto retention (reproduced; ruling: accepted, document, add this test)", () => {
  it("after eleven days live, a replay of the retained bars and an unchanged older duplicate (REBUILT) both change the latest ratio", () => {
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    try {
      for (const bar of ELEVEN_DAYS) session.dispatch({ bar });
      const live = session.capture();
      const retained = [...session.bars];
      const replay = replayCapture(relativeVolumeIndicator, retained, SETTINGS);
      expect(live.outputs.rvol.at(-1)).toBe(2.25);
      expect(replay.outputs.rvol.at(-1)).toBe(1.5);
      // Prior observations within the retained seven days for the last slot: days 5..10 only.
      const slotVolumes = retained.filter((bar, index) => index < retained.length - 1 && bar.ts_open % (24 * HOUR_MS) === retained[retained.length - 1].ts_open % (24 * HOUR_MS)).map((bar) => bar.volume);
      expect(slotVolumes).toHaveLength(6);
      expect(450 / medianOf(slotVolumes)).toBe(1.5);
      // An identical closed duplicate of an older retained bar is classified REBUILT and replays.
      const older = retained[100];
      const probe: BarFrame[] = [...retained];
      expect(mergeChartBar(probe, { ...older })).toBe("REBUILT");
      session.dispatch({ bar: { ...older } });
      expect(session.mutations.at(-1)).toBe("REBUILT");
      expect(session.capture().outputs.rvol.at(-1)).toBe(1.5);
    } finally {
      session.close();
    }
  }, 120_000);

  it("the doc's claim that ten fits one-minute crypto is false: 10,080 retained minutes hold at most six prior observations per minute of day", () => {
    expect(Math.floor(10_080 / 1_440)).toBe(7);
    // Seven retained days means a bar on the eighth retained day sees six earlier bars of its minute, never ten.
    const fixture = relativeVolumeCryptoFixture();
    const retained = fixture.bars.slice(fixture.labels.rebuiltFromIndex);
    const capture = replayCapture(relativeVolumeIndicator, retained, SETTINGS);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "utc" });
    let maxPrior = 0;
    for (const bar of retained) maxPrior = Math.max(maxPrior, engine.onBar(bar).priorCount);
    expect(maxPrior).toBe(6);
    expect(capture.outputs.rvol.filter((value) => value !== null).length).toBe(10_080 - 3 * 1_440);
  });
});

describe("Codex item 3: a resampled bucket truncated by a source gap is committed (reproduced; ruling: rule 7(b) withdrawn, settling test in rules.test.ts)", () => {
  it("on ce8d11c the half-filled hour enters the baseline: lookback two, observations [60, 30], next normal hour reads 1.33x", () => {
    const engine = createRelativeVolumeEngine({ sessions: 2, minSessions: 2, clock: "utc" });
    const hourly = (day: number, hour: number, volume: number, closed = true) =>
      barFrame(T0 + day * 24 * HOUR_MS + hour * HOUR_MS, { open: 1, close: 1, high: 1, low: 1, volume }, BINANCE_PERP, HOUR_MS, closed);
    for (let hour = 0; hour < 3; hour += 1) engine.onBar(hourly(0, hour, 60));
    engine.onBar(hourly(1, 0, 30, false));
    engine.onBar(hourly(1, 1, 60));
    const filed = engine.slotRing(0)!.items.map((item) => item.volume);
    const reading = engine.onBar(hourly(2, 0, 60));
    // Reproduction of the defect as built; the amended rule requires [60] and a learning null here.
    expect(filed).toEqual([60, 30]);
    expect(reading.rvol).toBeCloseTo(60 / 45, 12);
  });
});

describe("Codex item 4: a session-wide shift marks every bar (reproduced; ruling: accepted for a descriptive tool, both budgets quoted)", () => {
  it("three days at 100 per minute then a day at 250: 1,440 of 1,440 eligible bars hot, 1,000 per 1,000", () => {
    const bars = minuteBars(4 * 1_440, (index) => (index < 3 * 1_440 ? 100 : 250));
    const budget = countMarkers(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const eligible = replayCapture(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS).outputs.rvol.filter((value) => value !== null).length;
    expect(eligible).toBe(1_440);
    expect(budget.total).toBe(1_440);
    expect(budget.maxPerBar).toBe(1);
    console.log(`${summarizeBudget("regime shift (3 days at 100, then 250)", budget)}; ${budget.total} of ${eligible} eligible bars hot = ${((budget.total / eligible) * 1_000).toFixed(0)} per 1,000 eligible`);
    expect(judgeBudget(budget, 200).ok).toBe(false);
  });

  it("a one-hour burst at 3x on an otherwise ordinary fourth day marks exactly that hour", () => {
    const bars = minuteBars(4 * 1_440, (index) => (index >= 3 * 1_440 + 600 && index < 3 * 1_440 + 660 ? 300 : 100));
    const budget = countMarkers(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(budget.total).toBe(60);
    expect(budget.barsWithMarkers).toBe(60);
    expect(judgeBudget(budget, 200).ok).toBe(true);
  });
});

describe("Codex item 5: the builder's forming probe timed nulls (reproduced); the validator's measurement with warmed slots and threshold crossings", () => {
  const { bars, labels } = relativeVolumeCryptoFixture();
  const timing = bars.slice(labels.timingIndices.first, labels.timingIndices.last + 1);

  it("warming with the last 300 bars leaves the forming bar's slot with no prior observation: rvol null, status learning", () => {
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "utc" });
    for (const bar of timing.slice(-300)) engine.onBar(bar);
    const next = bars[labels.timingIndices.last + 1];
    const reading = engine.onBar({ ...next, closed: false });
    expect(reading.priorCount).toBe(0);
    expect(reading.rvol).toBeNull();
    expect(reading.status).toBe("learning");
  });

  it("warmed on all 10,080 bars, 500 revisions of the forming bar crossing the threshold every revision: p99 reported beside the replay p99", () => {
    const { def, samples } = timedDef(relativeVolumeIndicator);
    const session = openLiveSession(def, RELATIVE_VOLUME_DEFAULT_SETTINGS, {}, timing);
    try {
      samples.length = 0;
      const next = bars[labels.timingIndices.last + 1];
      const prior = timing.filter((bar) => bar.ts_open % (24 * HOUR_MS) === next.ts_open % (24 * HOUR_MS)).map((bar) => bar.volume).slice(-10);
      expect(prior).toHaveLength(7);
      const median = medianOf(prior);
      let hot = 0;
      let cold = 0;
      for (let revision = 0; revision < 500; revision += 1) {
        const volume = Math.round(median * (revision % 2 === 0 ? 2.5 : 1.5));
        session.dispatch({ bar: { ...next, volume, closed: revision === 499 } });
        const markers = session.runtime.getMarkers(def.id)!;
        if (markers.some((call) => call.time === next.ts_open)) hot += 1;
        else cold += 1;
      }
      expect(hot).toBe(250);
      expect(cold).toBe(250);
      const forming = percentilesOf(samples);
      console.log(`forming bar, warmed slots, 500 threshold crossings: onBar p50 ${forming.p50.toFixed(4)} ms p99 ${forming.p99.toFixed(4)} ms max ${forming.max.toFixed(3)} ms`);
      expect(forming.count).toBe(500);
      expect(forming.p99).toBeLessThan(1);
      expect(session.capture().outputs.rvol.at(-1)).toBeCloseTo(Math.round(median * 1.5) / median, 12);
    } finally {
      session.close();
    }
  }, 120_000);
});

describe("Codex item 6: with sessions = 2 the even-count median is a mean (reproduced; ruling: sessions 3..60, settling test in rules.test.ts)", () => {
  it("same-slot volumes 100, 1,000 then 250 at sessions 2: stored median 550, the ordinary day reads 0.455x", () => {
    const engine = createRelativeVolumeEngine({ sessions: 2, minSessions: 2, clock: "utc" });
    const hourly = (day: number, volume: number) => barFrame(T0 + day * 24 * HOUR_MS, { open: 1, close: 1, high: 1, low: 1, volume }, BINANCE_PERP, HOUR_MS);
    engine.onBar(hourly(0, 100));
    engine.onBar(hourly(1, 1_000));
    const reading = engine.onBar(hourly(2, 250));
    expect(reading.priorCount).toBe(2);
    expect(reading.rvol).toBeCloseTo(250 / 550, 12);
    // At sessions 3 the news day is one of three and the median is the ordinary volume.
    const three = createRelativeVolumeEngine({ sessions: 3, minSessions: 3, clock: "utc" });
    for (const [day, volume] of [[0, 100], [1, 1_000], [2, 110]] as const) three.onBar(hourly(day, volume));
    expect(three.onBar(hourly(3, 250)).rvol).toBeCloseTo(250 / 110, 12);
  });
});
