import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { resampleBars } from "../../../chart/resampleBars";
import { BINANCE_PERP, DXFEED_EQUITY, MINUTE_MS, barFrame, relativeVolumeCryptoFixture, relativeVolumeEquityFixture } from "../../../chart/validation/fixtures";
import { nyLocalMinuteOfDay } from "../../killzones/killzones";
import {
  HOUR_MS,
  createClockCache,
  createRelativeVolumeEngine,
  createRing,
  readingOf,
  requiredPriorOf,
  resolveRvolClock,
  ringCapacityOf,
  ringInsert,
  ringMean,
  ringMedian,
  ringRemove,
  ringSupersede,
  ringUpdate,
  slotKeyOf,
  usableVolume,
  type RelativeVolumeMathSettings,
} from "../relativeVolumeMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const T0 = Date.UTC(2026, 2, 2); // Monday 2026-03-02 00:00 UTC
const EQUITY_SESSION_STARTS = relativeVolumeEquityFixture().labels.sessionStarts;

function hourlyBar(day: number, hour: number, volume: number, closed = true): BarFrame {
  return barFrame(T0 + day * 24 * HOUR_MS + hour * HOUR_MS, { open: 100, close: 100, high: 100, low: 100, volume }, BINANCE_PERP, HOUR_MS, closed);
}

/**
 * The hand-computed three-session fixture of success criterion 1. Hourly UTC
 * bars (24 slots a day), base volume 100 everywhere except slot 0:
 * day 1: 100, day 2: 300, day 3: 200, day 4: 500.
 */
function threeSessionBars(): BarFrame[] {
  const slotZero = [100, 300, 200, 500];
  const bars: BarFrame[] = [];
  for (let day = 0; day < 4; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      bars.push(hourlyBar(day, hour, hour === 0 ? slotZero[day] : 100));
    }
  }
  return bars;
}

const SETTINGS: RelativeVolumeMathSettings = { sessions: 10, minSessions: 2, clock: "utc" };

describe("relativeVolumeMath -- clock and slot key", () => {
  it("auto resolves to New York for dxFeed and Databento and to UTC for Binance", () => {
    expect(resolveRvolClock("auto", "DXFEED")).toBe("newYork");
    expect(resolveRvolClock("auto", "DATABENTO")).toBe("newYork");
    expect(resolveRvolClock("auto", "BINANCE")).toBe("utc");
    expect(resolveRvolClock("newYork", "BINANCE")).toBe("newYork");
    expect(resolveRvolClock("utc", "DXFEED")).toBe("utc");
  });

  it("keys a bar by its start minute of day with no division by bar length (hourly 09:30 keys 570, the 15:30 half hour keys 930)", () => {
    const open = Date.UTC(2026, 2, 2, 14, 30); // 09:30 New York, EST
    expect(slotKeyOf(open, "newYork")).toBe(570);
    expect(slotKeyOf(open + 6 * HOUR_MS, "newYork")).toBe(930);
    expect(slotKeyOf(open, "utc")).toBe(870);
    expect(slotKeyOf(Date.UTC(2026, 2, 2, 0, 0), "utc")).toBe(0);
    expect(slotKeyOf(Date.UTC(2026, 2, 2, 23, 59), "utc")).toBe(1_439);
  });

  it("agrees with the killzones New York clock through the DST change, with and without the hour cache", () => {
    const cache = createClockCache();
    const from = Date.UTC(2026, 2, 7, 0, 0);
    for (let ts = from; ts < from + 3 * 24 * HOUR_MS; ts += 7 * MINUTE_MS) {
      const expected = nyLocalMinuteOfDay(ts);
      expect(slotKeyOf(ts, "newYork", cache)).toBe(expected);
      expect(slotKeyOf(ts, "newYork")).toBe(expected);
    }
  });

  it("the equity fixture's New York start-minute keys are identical before and after the DST change while the UTC keys differ", () => {
    const starts = EQUITY_SESSION_STARTS;
    for (const start of starts) expect(nyLocalMinuteOfDay(start)).toBe(570);
    expect(slotKeyOf(starts[0], "newYork")).toBe(slotKeyOf(starts[5], "newYork"));
    expect(slotKeyOf(starts[0], "utc")).toBe(870);
    expect(slotKeyOf(starts[5], "utc")).toBe(810);
  });

  it("rejects an unusable timestamp and an unusable volume", () => {
    expect(slotKeyOf(Number.NaN, "utc")).toBeNull();
    expect(slotKeyOf(-1, "newYork")).toBeNull();
    expect(usableVolume(0)).toBe(0);
    expect(usableVolume(12.5)).toBe(12.5);
    expect(usableVolume(-1)).toBeNull();
    expect(usableVolume(Number.NaN)).toBeNull();
    expect(usableVolume(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableVolume(undefined)).toBeNull();
  });
});

describe("relativeVolumeMath -- observation rings", () => {
  it("keeps the last N observations, reports the exact median (even count: mean of the two middle values) and the mean", () => {
    const ring = createRing(3);
    ringInsert(ring, { tsOpen: 1, volume: 100 });
    expect(ringMedian(ring)).toBe(100);
    ringInsert(ring, { tsOpen: 2, volume: 300 });
    expect(ringMedian(ring)).toBe(200);
    ringInsert(ring, { tsOpen: 3, volume: 200 });
    expect(ringMedian(ring)).toBe(200);
    expect(ringMean(ring)).toBe(200);
    ringInsert(ring, { tsOpen: 4, volume: 900 });
    expect(ring.items.map((item) => item.tsOpen)).toEqual([2, 3, 4]);
    expect(ring.evictedByTail).toEqual({ tsOpen: 1, volume: 100 });
    expect(ringMedian(ring)).toBe(300);
    expect(ringMedian(createRing(2))).toBeNull();
  });

  it("a removal restores what the tail's insertion evicted; a supersede makes the eviction final", () => {
    const ring = createRing(2);
    ringInsert(ring, { tsOpen: 1, volume: 10 });
    ringInsert(ring, { tsOpen: 2, volume: 20 });
    ringInsert(ring, { tsOpen: 3, volume: 30 });
    expect(ringRemove(ring, 3)).toBe(true);
    expect(ring.items).toEqual([{ tsOpen: 1, volume: 10 }, { tsOpen: 2, volume: 20 }]);
    expect(ring.evictedByTail).toBeNull();
    ringInsert(ring, { tsOpen: 3, volume: 33 });
    ringSupersede(ring);
    expect(ring.evictedByTail).toBeNull();
    expect(ringRemove(ring, 3)).toBe(true);
    expect(ring.items).toEqual([{ tsOpen: 2, volume: 20 }]);
    expect(ringRemove(ring, 99)).toBe(false);
    expect(ringUpdate(ring, 2, 25)).toBe(true);
    expect(ring.items[0].volume).toBe(25);
    expect(ringUpdate(ring, 99, 1)).toBe(false);
  });
});

describe("relativeVolumeMath -- hand-computed three-session fixture (success criterion 1)", () => {
  it("median baseline, warm-up nulls and the rolling comparison take the exact hand-computed values", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const bars = threeSessionBars();
    const readings = bars.map((bar) => engine.onBar(bar));
    // Day 1: nothing prior anywhere.
    for (let index = 0; index < 24; index += 1) {
      expect(readings[index].rvol).toBeNull();
      expect(readings[index].status).toBe("learning");
      if (index < 20) expect(readings[index].rolling).toBeNull();
    }
    // Day 2 slot 0 (300): one prior (100) < minSessions 2 -> learning; rolling over the 20 previous bars (all 100) = 3.
    expect(readings[24].priorCount).toBe(1);
    expect(readings[24].rvol).toBeNull();
    expect(readings[24].status).toBe("learning");
    expect(readings[24].rollingCount).toBe(20);
    expect(readings[24].rolling).toBe(3);
    // The first bar with 20 committed predecessors is index 20.
    expect(readings[19].rolling).toBeNull();
    expect(readings[20].rolling).toBe(1);
    // Day 3 slot 0 (200): prior [100, 300], even count -> median 200 -> 1.0; rolling 2.0.
    expect(readings[48].priorCount).toBe(2);
    expect(readings[48].rvol).toBe(1);
    expect(readings[48].slotMeanRatio).toBe(1);
    expect(readings[48].rolling).toBe(2);
    expect(readings[48].status).toBe("ready");
    // Day 3 slot 1 (100): prior [100, 100] -> 1.0.
    expect(readings[49].rvol).toBe(1);
    // Day 4 slot 0 (500): prior [100, 300, 200] -> median 200 -> 2.5; rolling 5.
    expect(readings[72].priorCount).toBe(3);
    expect(readings[72].rvol).toBe(2.5);
    expect(readings[72].slotMeanRatio).toBe(2.5);
    expect(readings[72].rolling).toBe(5);
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200, 500]);
    expect(engine.rollingRing.items).toHaveLength(20);
    for (const reading of readings) {
      expect(reading.rvol === null || Number.isFinite(reading.rvol)).toBe(true);
      expect(reading.rolling === null || Number.isFinite(reading.rolling)).toBe(true);
    }
  });

  it("the forming bar grows toward its final value against the full-bar expectation and keeps its stored denominator after the close", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const bars = threeSessionBars();
    for (const bar of bars.slice(0, 72)) engine.onBar(bar);
    const forming = (volume: number, closed: boolean) => engine.onBar(hourlyBar(3, 0, volume, closed));
    const first = forming(100, false);
    expect(first.rvol).toBe(0.5);
    expect(first.status).toBe("forming");
    expect(first.confirmed).toBe(false);
    expect(engine.tail!.committed).toBe(false);
    expect(engine.slotRing(0)!.items).toHaveLength(3);
    expect(forming(300, false).rvol).toBe(1.5);
    const closed = forming(500, true);
    expect(closed.rvol).toBe(2.5);
    expect(closed.status).toBe("ready");
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200, 500]);
    // A later closed dispatch with a different volume divides by the stored 200, never by a median that includes itself.
    const corrected = forming(1_000, true);
    expect(corrected.rvol).toBe(5);
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200, 1_000]);
    expect(engine.rollingRing.items[19].volume).toBe(1_000);
    // Day 5 slot 0 then sees prior [100, 300, 200, 1000] -> median 250.
    const next = engine.onBar(hourlyBar(4, 0, 500));
    expect(next.priorCount).toBe(4);
    expect(next.rvol).toBe(2);
  });

  it("a duplicate identical closed dispatch changes nothing", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const bars = threeSessionBars();
    for (const bar of bars.slice(0, 73)) engine.onBar(bar);
    const before = JSON.stringify({ reading: engine.current, slot: engine.slotRing(0), rolling: engine.rollingRing });
    engine.onBar(bars[72]);
    expect(JSON.stringify({ reading: engine.current, slot: engine.slotRing(0), rolling: engine.rollingRing })).toBe(before);
  });

  it("a dispatch older than the current record is ignored", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const bars = threeSessionBars();
    for (const bar of bars.slice(0, 73)) engine.onBar(bar);
    const current = engine.current;
    expect(engine.onBar({ ...bars[10], volume: 9_999 })).toBe(current);
    expect(engine.slotRing(600)!.items.map((item) => item.volume)).toEqual([100, 100, 100]);
  });

  it("a bar superseded without ever closing contributes no observation to either ring and stays provisional (rule 7(b) withdrawn)", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const bars = threeSessionBars();
    for (const bar of bars.slice(0, 72)) engine.onBar(bar);
    const open = engine.onBar(hourlyBar(3, 0, 400, false));
    expect(open.confirmed).toBe(false);
    expect(open.status).toBe("forming");
    expect(open.rvol).toBe(2);
    const next = engine.onBar(hourlyBar(3, 1, 100));
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200]);
    expect(engine.rollingRing.items.some((item) => item.tsOpen === T0 + 3 * 24 * HOUR_MS)).toBe(false);
    expect(engine.rollingRing.items[19]).toEqual({ tsOpen: T0 + 3 * 24 * HOUR_MS + HOUR_MS, volume: 100 });
    // The superseded bar never entered the rolling mean either: the next bar's twenty predecessors are all 100.
    expect(next.rolling).toBe(1);
    // Day 5 slot 0 still sees three prior observations.
    expect(engine.onBar(hourlyBar(4, 0, 200)).priorCount).toBe(3);
  });
});

describe("relativeVolumeMath -- corrections and eviction rollback (amendments 1 and 2)", () => {
  it("valid to invalid removes the observation and yields null; invalid to valid inserts it", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    for (const bar of threeSessionBars().slice(0, 72)) engine.onBar(bar);
    engine.onBar(hourlyBar(3, 0, 500));
    expect(engine.slotRing(0)!.items).toHaveLength(4);
    const invalid = engine.onBar(hourlyBar(3, 0, Number.NaN));
    expect(invalid.rvol).toBeNull();
    expect(invalid.rolling).toBeNull();
    expect(invalid.status).toBe("noVolume");
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200]);
    expect(engine.rollingRing.items).toHaveLength(20);
    expect(engine.rollingRing.items[19].tsOpen).toBe(T0 + 2 * 24 * HOUR_MS + 23 * HOUR_MS);
    const valid = engine.onBar(hourlyBar(3, 0, 600));
    expect(valid.rvol).toBe(3);
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([100, 300, 200, 600]);
  });

  it("valid, invalid, valid with both rings full restores the evicted observation and ends equal to a feed that only saw the final state", () => {
    const settings: RelativeVolumeMathSettings = { sessions: 3, minSessions: 2, clock: "utc" };
    const bars = threeSessionBars(); // 4 days: slot rings reach capacity 3 at day 4; the rolling ring is full after 20 bars
    const engine = createRelativeVolumeEngine(settings);
    for (const bar of bars.slice(0, 72)) engine.onBar(bar);
    const slotBefore = JSON.stringify(engine.slotRing(0)!.items);
    const rollingBefore = JSON.stringify(engine.rollingRing.items);
    engine.onBar(hourlyBar(3, 0, 500));
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([300, 200, 500]);
    expect(engine.slotRing(0)!.evictedByTail).toEqual({ tsOpen: T0, volume: 100 });
    expect(engine.rollingRing.evictedByTail).not.toBeNull();
    engine.onBar(hourlyBar(3, 0, Number.NaN));
    expect(JSON.stringify(engine.slotRing(0)!.items)).toBe(slotBefore);
    expect(JSON.stringify(engine.rollingRing.items)).toBe(rollingBefore);
    expect(engine.slotRing(0)!.evictedByTail).toBeNull();
    const final = engine.onBar(hourlyBar(3, 0, 700));
    engine.onBar(hourlyBar(3, 1, 100));
    const clean = createRelativeVolumeEngine(settings);
    for (const bar of bars.slice(0, 72)) clean.onBar(bar);
    const cleanFinal = clean.onBar(hourlyBar(3, 0, 700));
    clean.onBar(hourlyBar(3, 1, 100));
    expect(final.rvol).toBe(cleanFinal.rvol);
    expect(JSON.stringify(engine.slotRing(0))).toBe(JSON.stringify(clean.slotRing(0)));
    expect(JSON.stringify(engine.rollingRing)).toBe(JSON.stringify(clean.rollingRing));
    expect(engine.slotRing(0)!.evictedByTail).toBeNull();
  });

  it("minSessions is clamped to sessions at read time, and sessions itself to 3..60", () => {
    expect(requiredPriorOf({ sessions: 4, minSessions: 5, clock: "utc" })).toBe(4);
    expect(requiredPriorOf({ sessions: 2, minSessions: 5, clock: "utc" })).toBe(3);
    expect(requiredPriorOf({ sessions: 10, minSessions: 3, clock: "utc" })).toBe(3);
    expect(requiredPriorOf({ sessions: 10, minSessions: 0, clock: "utc" })).toBe(1);
    expect(ringCapacityOf({ sessions: 2, minSessions: 1, clock: "utc" })).toBe(3);
    expect(ringCapacityOf({ sessions: 61, minSessions: 1, clock: "utc" })).toBe(60);
    expect(createRelativeVolumeEngine({ sessions: 2, minSessions: 2, clock: "utc" }).rollingRing.capacity).toBe(20);
  });
});

describe("relativeVolumeMath -- status precedence (rule 11)", () => {
  const base = { tsOpen: 0, key: 0, supported: true, volume: 100, committed: true, inRings: true, confirmed: true };
  const baseline = { slotMedian: 50, slotMean: 50, priorCount: 3, rollingMean: 50, rollingCount: 20 };

  it("unsupported timeframe, then no usable volume, then learning, then no usable baseline, then forming, then ready", () => {
    expect(readingOf({ ...base, supported: false, volume: null, baselineAtOpen: { ...baseline, priorCount: 0 } }, SETTINGS).status).toBe("unsupported");
    expect(readingOf({ ...base, volume: null, baselineAtOpen: { ...baseline, priorCount: 0 } }, SETTINGS).status).toBe("noVolume");
    const learning = readingOf({ ...base, baselineAtOpen: { ...baseline, priorCount: 1, slotMedian: 0 } }, SETTINGS);
    expect(learning.status).toBe("learning");
    expect(learning.rvol).toBeNull();
    expect(learning.rolling).toBe(2);
    const noBaseline = readingOf({ ...base, baselineAtOpen: { ...baseline, slotMedian: 0 } }, SETTINGS);
    expect(noBaseline.status).toBe("noBaseline");
    expect(noBaseline.rvol).toBeNull();
    expect(readingOf({ ...base, confirmed: false, baselineAtOpen: baseline }, SETTINGS).status).toBe("forming");
    const ready = readingOf({ ...base, baselineAtOpen: baseline }, SETTINGS);
    expect(ready.status).toBe("ready");
    expect(ready.rvol).toBe(2);
    expect(ready.requiredPrior).toBe(2);
  });

  it("a timeframe longer than one hour yields null everywhere and files nothing", () => {
    const engine = createRelativeVolumeEngine(SETTINGS);
    const fourHours = 4 * HOUR_MS;
    for (let index = 0; index < 30; index += 1) {
      const reading = engine.onBar(barFrame(T0 + index * fourHours, { open: 1, close: 1, high: 1, low: 1, volume: 100 }, BINANCE_PERP, fourHours));
      expect(reading.status).toBe("unsupported");
      expect(reading.rvol).toBeNull();
      expect(reading.rolling).toBeNull();
    }
    expect(engine.slotCount).toBe(0);
    expect(engine.rollingRing.items).toHaveLength(0);
    const hourly = createRelativeVolumeEngine(SETTINGS);
    expect(hourly.onBar(hourlyBar(0, 0, 100)).status).toBe("learning");
  });
});

describe("relativeVolumeMath -- gaps, early closes and the resampler", () => {
  function equitySession(dayIndex: number, volumeOf: (minute: number) => number, minutes: readonly number[]): BarFrame[] {
    const open = EQUITY_SESSION_STARTS[dayIndex];
    return minutes.map((minute) => barFrame(open + minute * MINUTE_MS, { open: 1, close: 1, high: 1, low: 1, volume: volumeOf(minute) }, DXFEED_EQUITY));
  }

  it("a session missing minutes 120..179 contributes no observations for those keys and the bar after the gap has an unchanged baseline", () => {
    const all = Array.from({ length: 390 }, (_, minute) => minute);
    const gapped = all.filter((minute) => minute < 120 || minute > 179);
    const volumeOf = (minute: number) => 100 + minute;
    const withGap = createRelativeVolumeEngine({ sessions: 10, minSessions: 2, clock: "auto" });
    const without = createRelativeVolumeEngine({ sessions: 10, minSessions: 2, clock: "auto" });
    for (const day of [0, 1]) {
      for (const bar of equitySession(day, volumeOf, all)) {
        withGap.onBar(bar);
        without.onBar(bar);
      }
    }
    let afterGap = null;
    for (const bar of equitySession(2, volumeOf, gapped)) {
      const reading = withGap.onBar(bar);
      if (bar.ts_open === EQUITY_SESSION_STARTS[2] + 180 * MINUTE_MS) afterGap = reading;
    }
    let reference = null;
    for (const bar of equitySession(2, volumeOf, all)) {
      const reading = without.onBar(bar);
      if (bar.ts_open === EQUITY_SESSION_STARTS[2] + 180 * MINUTE_MS) reference = reading;
    }
    for (let minute = 120; minute <= 179; minute += 1) {
      expect(withGap.slotRing(570 + minute)!.items).toHaveLength(2);
      expect(without.slotRing(570 + minute)!.items).toHaveLength(3);
    }
    expect(afterGap!.rvol).toBe(reference!.rvol);
    expect(afterGap!.priorCount).toBe(2);
    expect(withGap.slotRing(750)!.items).toHaveLength(3);
    // The rolling ring sees the bar before the gap as the previous committed bar: no zero is ever filed.
    expect(withGap.rollingRing.items.every((item) => item.volume > 0)).toBe(true);
  });

  it("an early close at 13:00 enters its key as one observation and the next session's bar divides by the exact median (amendment 4)", () => {
    // Hourly equity bars: keys 570, 630, 690, 750, 810, 870, 930. Slot 750 (12:30) is a full hour on
    // ordinary days and a 30-minute bucket on the early-close day.
    const engine = createRelativeVolumeEngine({ sessions: 4, minSessions: 2, clock: "auto" });
    const starts = EQUITY_SESSION_STARTS;
    const hourlyVolume: Record<number, number[]> = { 750: [60, 62, 58] };
    const feed = (day: number, hours: number, slot750: number) => {
      for (let hour = 0; hour < hours; hour += 1) {
        const ts = starts[day] + hour * HOUR_MS;
        const key = 570 + hour * 60;
        const volume = key === 750 ? slot750 : 50;
        engine.onBar(barFrame(ts, { open: 1, close: 1, high: 1, low: 1, volume }, DXFEED_EQUITY, HOUR_MS));
      }
    };
    feed(0, 7, hourlyVolume[750][0]);
    feed(1, 7, hourlyVolume[750][1]);
    feed(2, 7, hourlyVolume[750][2]);
    feed(3, 4, 30); // early close: the 12:30 bucket ends at 13:00 and is the session's last bar
    expect(engine.slotRing(750)!.items.map((item) => item.volume)).toEqual([60, 62, 58, 30]);
    expect(engine.slotRing(810)!.items).toHaveLength(3);
    const reading = engine.onBar(barFrame(starts[4] + 3 * HOUR_MS, { open: 1, close: 1, high: 1, low: 1, volume: 59 }, DXFEED_EQUITY, HOUR_MS));
    // sorted [30, 58, 60, 62] -> median (58 + 60) / 2 = 59: the short bar moves the median from 60 to 59, it does not zero it.
    expect(reading.priorCount).toBe(4);
    expect(reading.rvol).toBe(59 / 59);
    expect(reading.slotMeanRatio).toBe(59 / 52.5);
  });

  it("one session of 1m fixture bars through the real resampler to 1h ends on a 15:30 bar that keys 930 and is its own slot", () => {
    const { bars } = relativeVolumeEquityFixture();
    const hourly = resampleBars(bars.slice(0, 390), HOUR_MS);
    expect(hourly).toHaveLength(7);
    const last = hourly[hourly.length - 1];
    expect(last.interval_ms).toBe(HOUR_MS); // the resampler reports the nominal interval even for the half-hour bucket
    expect(last.closed).toBe(true);
    expect(slotKeyOf(last.ts_open, "newYork")).toBe(930);
    expect(hourly.map((bar) => slotKeyOf(bar.ts_open, "newYork"))).toEqual([570, 630, 690, 750, 810, 870, 930]);
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (let session = 0; session < 4; session += 1) {
      for (const bar of resampleBars(bars.slice(session * 390, (session + 1) * 390), HOUR_MS)) engine.onBar(bar);
    }
    expect(engine.slotRing(930)!.items).toHaveLength(4);
    expect(engine.slotRing(930)!.items.every((item) => slotKeyOf(item.tsOpen, "newYork") === 930)).toBe(true);
    expect(engine.slotRing(870)!.items.every((item) => slotKeyOf(item.tsOpen, "newYork") === 870)).toBe(true);
    expect(engine.slotCount).toBe(7);
  });

  it("the crypto fixture keeps at most 1,440 keys, every ring at or under capacity, across all 12,000 bars", () => {
    const { bars } = relativeVolumeCryptoFixture();
    expect(bars).toHaveLength(12_000);
    const engine = createRelativeVolumeEngine({ sessions: 3, minSessions: 3, clock: "auto" });
    let ready = 0;
    for (const bar of bars) {
      const reading = engine.onBar(bar);
      if (reading.rvol !== null) ready += 1;
    }
    expect(engine.slotCount).toBe(1_440);
    for (let key = 0; key < 1_440; key += 1) expect(engine.slotRing(key)!.items.length).toBeLessThanOrEqual(3);
    expect(engine.rollingRing.items).toHaveLength(20);
    // Eight days and eight hours: the first three days learn, the rest are ready.
    expect(ready).toBe(12_000 - 3 * 1_440);
  });
});
