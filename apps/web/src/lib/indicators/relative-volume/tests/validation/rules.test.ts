import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../../chart/draw/creationScope";
import { resetDrawRegistryForTests, tablesForOwners } from "../../../../chart/draw/registry";
import type { TableData } from "../../../../chart/draw/table";
import { HISTORICAL_INDICATOR_POLICIES, INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../../chart/indicatorRegistry";
import { resampleBars } from "../../../../chart/resampleBars";
import {
  BINANCE_PERP,
  DXFEED_EQUITY,
  barFrame,
  driveLive,
  equityUnsidedBars,
  openLiveSession,
  relativeVolumeEquityFixture,
  replayCapture,
  type Arrival,
} from "../../../../chart/validation";
import { nyLocalMinuteOfDay } from "../../../killzones/killzones";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, RELATIVE_VOLUME_SETTINGS_SCHEMA, relativeVolumeIndicator, type RelativeVolumeSettings } from "../../relativeVolume";
import { HOUR_MS, MINUTE_MS, RVOL_MIN_SESSIONS_SETTING, createRelativeVolumeEngine } from "../../relativeVolumeMath";
import { medianOf } from "./reference";

// Validation loop 1: the brief's rules as amended by the PM's rulings on the
// Codex G3 gate (PM/cycle1/brief-rvol-clock.md, "Rulings"). Tests under
// "amended brief" describe the required behaviour and FAIL against build
// ce8d11c until the builder's fix round; they are the settling tests.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const SETTINGS: RelativeVolumeSettings = { ...RELATIVE_VOLUME_DEFAULT_SETTINGS, showRolling: true };
const EQUITY = relativeVolumeEquityFixture();
const T0 = Date.UTC(2026, 2, 2);

function hourly(day: number, hour: number, volume: number, closed = true): BarFrame {
  return barFrame(T0 + day * 24 * HOUR_MS + hour * HOUR_MS, { open: 1, close: 1, high: 1, low: 1, volume }, BINANCE_PERP, HOUR_MS, closed);
}

function tableTexts(owner: string): string[] {
  const grid = (tablesForOwners([owner])[0].data as TableData).committedGrid;
  return ["0,0", "1,0", "2,0"].map((key) => grid[key]?.text ?? "");
}

describe("status precedence (rule 11) through the runtime's table, including the median-zero case the builder did not drive", () => {
  it("unsupported, no usable volume, learning, no usable baseline, forming, ready, in that order", () => {
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    const owner = () => session.runtime.getDrawOwnerId(relativeVolumeIndicator.id)!;
    try {
      // Hourly UTC bars, slot 0 only carries information: zero volume on days 1..3, so its median is 0 on day 4.
      for (let day = 0; day < 3; day += 1) {
        for (let hour = 0; hour < 24; hour += 1) session.dispatch({ bar: hourly(day, hour, hour === 0 ? 0 : 100) });
      }
      expect(tableTexts(owner())[2]).toBe("Learning · 2 of 3 prior");
      session.dispatch({ bar: hourly(3, 0, 50) });
      expect(tableTexts(owner())).toEqual(["RVOL — · 3 prior", "Rolling 0.5× · 20 bars", "No usable baseline"]);
      expect(session.capture().outputs.rvol.at(-1)).toBeNull();
      session.dispatch({ bar: hourly(3, 1, 70, false) });
      expect(tableTexts(owner())).toEqual(["RVOL 0.7× · 3 prior", "Rolling 0.7× · 20 bars", "Forming · vs full bar"]);
      session.dispatch({ bar: hourly(3, 1, Number.NaN, false) });
      expect(tableTexts(owner())).toEqual(["RVOL — · 3 prior", "Rolling — · 20 bars", "No usable volume"]);
      session.dispatch({ bar: hourly(3, 1, 120) });
      expect(tableTexts(owner())).toEqual(["RVOL 1.2× · 3 prior", "Rolling 1.2× · 20 bars", ""]);
      const twoHour = barFrame(T0 + 4 * 24 * HOUR_MS, { open: 1, close: 1, high: 1, low: 1, volume: Number.NaN }, BINANCE_PERP, 2 * HOUR_MS);
      session.dispatch({ bar: twoHour });
      // Unsupported wins over an unusable volume.
      expect(tableTexts(owner())).toEqual(["RVOL — · 0 prior", "Rolling — · 20 bars", "Needs 1m to 1h"]);
      expect(session.capture().faulted).toBe(false);
    } finally {
      session.close();
    }
  });
});

describe("older-than-tail dispatch, duplicate close and the forming tail, through the indicator def", () => {
  it("a dispatch older than the tail changes no output, no ring and no marker", () => {
    const bars = EQUITY.bars.slice(0, 4 * 390 + 30);
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    try {
      for (const bar of bars) session.dispatch({ bar });
      const before = session.capture();
      // The runtime would classify this REBUILT; drive the def directly to reach the engine's own guard.
      const older = { ...bars[3 * 390 + 5], volume: 9_999_999, closed: true };
      const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
      for (const bar of bars) engine.onBar(bar);
      const snapshot = JSON.stringify({ tail: engine.tail, slot: engine.slotRing(575), rolling: engine.rollingRing });
      const reading = engine.onBar(older);
      expect(reading).toBe(engine.current);
      expect(JSON.stringify({ tail: engine.tail, slot: engine.slotRing(575), rolling: engine.rollingRing })).toBe(snapshot);
      expect(session.capture()).toEqual(before);
    } finally {
      session.close();
    }
  });

  it("a replay whose tail is forming leaves the tail provisional: marker at 50 percent alpha, status Forming, nothing filed", () => {
    const bars = EQUITY.bars.slice(0, 4 * 390 + 10);
    const last = bars[bars.length - 1];
    const prior = EQUITY.bars.filter((bar, index) => index < bars.length - 1 && nyLocalMinuteOfDay(bar.ts_open) === nyLocalMinuteOfDay(last.ts_open)).map((bar) => bar.volume);
    const median = medianOf(prior.slice(-10));
    const tail = { ...last, closed: false, volume: Math.ceil(median * 2.5) } as BarFrame;
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, [...bars.slice(0, -1), tail]);
    try {
      const capture = session.capture();
      expect(capture.outputs.rvol.at(-1)).toBeCloseTo(tail.volume / median, 12);
      const marker = capture.markers.find((call) => call.time === tail.ts_open);
      expect(marker).toMatchObject({ shape: "circle", position: "aboveBar", color: "rgba(37,99,235,0.5)" });
      const owner = session.runtime.getDrawOwnerId(relativeVolumeIndicator.id)!;
      expect(tableTexts(owner)[2]).toBe("Forming · vs full bar");
      const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
      for (const bar of [...bars.slice(0, -1), tail]) engine.onBar(bar);
      expect(engine.tail!.committed).toBe(false);
      expect(engine.slotRing(nyLocalMinuteOfDay(tail.ts_open))!.items.some((item) => item.tsOpen === tail.ts_open)).toBe(false);
    } finally {
      session.close();
    }
  });
});

describe("corrections through the runtime (amendments 1 and 2), judged against a feed that only saw the final state", () => {
  const index = 14 * 390 + 100; // session 15: every slot holds 10, the rolling ring 20
  const bar = EQUITY.bars[index];
  const prefix = EQUITY.bars.slice(0, index);
  const suffix = EQUITY.bars.slice(index + 1, index + 30);

  function finalStateFeed(finalVolume: number): ReturnType<typeof driveLive> {
    return driveLive(relativeVolumeIndicator, [...prefix, { ...bar, volume: finalVolume } as BarFrame, ...suffix].map((b) => ({ bar: b })), SETTINGS);
  }

  it("valid(a) → valid(b) → invalid → valid(c) → next bars equals a feed that only ever saw c", () => {
    const arrivals: Arrival[] = prefix.map((b) => ({ bar: b }));
    arrivals.push({ bar: { ...bar, volume: 500 } }, { bar: { ...bar, volume: 900 } }, { bar: { ...bar, volume: Number.NaN } }, { bar: { ...bar, volume: 3_000 } });
    for (const later of suffix) arrivals.push({ bar: later });
    const corrected = driveLive(relativeVolumeIndicator, arrivals, SETTINGS);
    const clean = finalStateFeed(3_000);
    expect(corrected.outputs).toEqual(clean.outputs);
    expect(corrected.markers).toEqual(clean.markers);
    expect(corrected.outputs.rvol[index]).toBeGreaterThan(2);
  });

  it("valid → invalid, then the next bar arrives: the observation stays out and what its insertion evicted stays restored", () => {
    const arrivals: Arrival[] = prefix.map((b) => ({ bar: b }));
    arrivals.push({ bar: { ...bar, volume: 500 } }, { bar: { ...bar, volume: Number.NaN } });
    for (const later of suffix) arrivals.push({ bar: later });
    const corrected = driveLive(relativeVolumeIndicator, arrivals, SETTINGS);
    const clean = finalStateFeed(Number.NaN);
    expect(corrected.outputs).toEqual(clean.outputs);
    expect(corrected.outputs.rvol[index]).toBeNull();
    // The same slot one session earlier still counts: ten prior observations for the next bar of this slot would have been 10 either way.
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    for (const b of prefix) engine.onBar(b);
    const key = nyLocalMinuteOfDay(bar.ts_open);
    const before = engine.slotRing(key)!.items.map((item) => item.tsOpen);
    engine.onBar({ ...bar, volume: 500 });
    engine.onBar({ ...bar, volume: Number.NaN });
    engine.onBar(suffix[0]);
    expect(engine.slotRing(key)!.items.map((item) => item.tsOpen)).toEqual(before);
    expect(engine.slotRing(key)!.evictedByTail).toBeNull();
  });
});

describe("equity unsided volume (check 9) and Historical Mode policy (check 10)", () => {
  it("reads only volume: outputs are identical with sides present, partially present or absent", () => {
    // Four UTC days of one-minute bars, so every minute of day has three prior observations by day four.
    const { bars } = equityUnsidedBars({ count: 4 * 1_440 + 300, identity: DXFEED_EQUITY });
    const stripped = bars.map((bar) => {
      const { buy_volume: _buy, sell_volume: _sell, ...rest } = bar;
      return rest as BarFrame;
    });
    const sided = bars.map((bar) => ({ ...bar, buy_volume: bar.volume * 0.6, sell_volume: bar.volume * 0.4 }) as BarFrame);
    const settings: RelativeVolumeSettings = { ...SETTINGS, clock: "utc" };
    const a = replayCapture(relativeVolumeIndicator, bars, settings).outputs;
    expect(replayCapture(relativeVolumeIndicator, stripped, settings).outputs).toEqual(a);
    expect(replayCapture(relativeVolumeIndicator, sided, settings).outputs).toEqual(a);
    expect(a.rvol.some((value) => value !== null)).toBe(true);
  });

  it("OHLCV_POLICY row, appended last in the registry, and a candle-only replay with no extras yields real ratios on every archived instrument", () => {
    expect(INDICATOR_REGISTRY[INDICATOR_REGISTRY.length - 1].id).toBe("relativeVolume");
    expect(HISTORICAL_INDICATOR_POLICIES.relativeVolume).toEqual({ requiredCapabilities: ["ohlcv"] });
    for (const provider of ["BINANCE", "DXFEED", "DATABENTO"] as const) {
      expect(historicalIndicatorAvailability("relativeVolume", new Set(["ohlcv"]), provider)).toEqual({ available: true, reason: null });
    }
    expect(historicalIndicatorAvailability("relativeVolume", new Set(["buy_volume"]), "BINANCE").available).toBe(false);
    const capture = replayCapture(relativeVolumeIndicator, EQUITY.bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(capture.faulted).toBe(false);
    expect(capture.outputs.rvol.slice(3 * 390).every((value) => value !== null && Number.isFinite(value))).toBe(true);
    expect(capture.markers.length).toBe(13);
  });
});

describe("the resampler's 15:30 hourly bar", () => {
  it("keys 930 through the def and divides only by earlier 15:30 bars, never by 15:00 bars", () => {
    const hourly: BarFrame[] = [];
    for (let session = 0; session < 5; session += 1) hourly.push(...resampleBars(EQUITY.bars.slice(session * 390, (session + 1) * 390), HOUR_MS));
    expect(hourly).toHaveLength(35);
    const capture = replayCapture(relativeVolumeIndicator, hourly, SETTINGS);
    const lastHalfHour = hourly[34];
    expect(nyLocalMinuteOfDay(lastHalfHour.ts_open)).toBe(930);
    expect(lastHalfHour.interval_ms).toBe(HOUR_MS);
    const earlier930 = hourly.filter((bar, index) => index < 34 && nyLocalMinuteOfDay(bar.ts_open) === 930).map((bar) => bar.volume);
    const earlier870 = hourly.filter((bar, index) => index < 34 && nyLocalMinuteOfDay(bar.ts_open) === 870).map((bar) => bar.volume);
    expect(earlier930).toHaveLength(4);
    expect(capture.outputs.rvol[34]).toBeCloseTo(lastHalfHour.volume / medianOf(earlier930), 12);
    expect(capture.outputs.rvol[34]).not.toBeCloseTo(lastHalfHour.volume / medianOf(earlier870), 3);
    // The half-hour bucket is smaller than the full 15:00 hour even with the closing surge, so the two denominators differ.
    expect(medianOf(earlier930) / medianOf(earlier870)).toBeLessThan(0.9);
  });
});

describe("amended brief (PM rulings on Codex G3): FAIL against ce8d11c until the builder's fix round", () => {
  it("rule 7(b) withdrawn: a bar superseded without ever closing contributes NO observation to either ring", () => {
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 2, clock: "utc" });
    for (let day = 0; day < 2; day += 1) for (let hour = 0; hour < 24; hour += 1) engine.onBar(hourly(day, hour, 60));
    engine.onBar(hourly(2, 0, 30, false)); // half the bucket arrived, then the source went quiet
    engine.onBar(hourly(2, 1, 60)); // the next bucket supersedes it
    expect(engine.slotRing(0)!.items.map((item) => item.volume)).toEqual([60, 60]);
    expect(engine.rollingRing.items.some((item) => item.tsOpen === T0 + 2 * 24 * HOUR_MS)).toBe(false);
    const next = engine.onBar(hourly(3, 0, 60));
    expect(next.priorCount).toBe(2);
    expect(next.rvol).toBe(1);
  });

  it("rule 7(b) withdrawn, through the runtime: a resampled bucket truncated by a source gap is not committed when the next bucket arrives", () => {
    // Source minutes: day 1 hours 0..2 complete; day 2 hour 0 has only its first 30 minutes, then minutes resume at hour 1.
    const minutes: BarFrame[] = [];
    const push = (day: number, hour: number, minute: number) =>
      minutes.push(barFrame(T0 + day * 24 * HOUR_MS + hour * HOUR_MS + minute * MINUTE_MS, { open: 1, close: 1, high: 1, low: 1, volume: 1 }, BINANCE_PERP));
    for (let hour = 0; hour < 3; hour += 1) for (let minute = 0; minute < 60; minute += 1) push(0, hour, minute);
    for (let minute = 0; minute < 30; minute += 1) push(1, 0, minute);
    for (let hour = 1; hour < 3; hour += 1) for (let minute = 0; minute < 60; minute += 1) push(1, hour, minute);
    for (let hour = 0; hour < 3; hour += 1) for (let minute = 0; minute < 60; minute += 1) push(2, hour, minute);
    const resampled = resampleBars(minutes, HOUR_MS);
    const truncated = resampled.find((bar) => bar.ts_open === T0 + 24 * HOUR_MS)!;
    expect(truncated).toMatchObject({ volume: 30, closed: false });
    const live = driveLive(relativeVolumeIndicator, resampled.map((bar) => ({ bar })), { ...SETTINGS, minSessions: 2 });
    const day3hour0 = resampled.findIndex((bar) => bar.ts_open === T0 + 2 * 24 * HOUR_MS);
    // Amended rule: prior observations for slot 0 are [60] only, below minSessions 2, so day 3 hour 0 is still learning (null), not 60 / median([60, 30]) = 1.33.
    expect(live.outputs.rvol[day3hour0]).toBeNull();
  });

  it("sessions has a minimum of 3 in the schema and in the engine's clamp", () => {
    const field = RELATIVE_VOLUME_SETTINGS_SCHEMA.find((candidate) => candidate.kind !== "staticHint" && candidate.key === "sessions");
    expect(field && field.kind === "numeric" ? field.min : null).toBe(3);
    expect(RVOL_MIN_SESSIONS_SETTING).toBe(3);
    const engine = createRelativeVolumeEngine({ sessions: 2, minSessions: 2, clock: "utc" });
    for (const volume of [100, 1_000, 250, 100]) engine.onBar(hourly(engine.tail === null ? 0 : (engine.tail.tsOpen - T0) / (24 * HOUR_MS) + 1, 0, volume));
    expect(engine.slotRing(0)!.capacity).toBeGreaterThanOrEqual(3);
  });

  it("a cosmetic setting never changes a number: changing a colour after a rollover leaves every output and marker as it was", () => {
    // Eleven days of one-minute bars: 100 per minute for five days, then 300, the last bar 450 (Codex item 1).
    const bars: BarFrame[] = [];
    for (let index = 0; index < 11 * 1_440; index += 1) {
      const volume = index === 11 * 1_440 - 1 ? 450 : index < 5 * 1_440 ? 100 : 300;
      bars.push(barFrame(T0 + index * MINUTE_MS, { open: 1, close: 1, high: 1, low: 1, volume }, BINANCE_PERP));
    }
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    try {
      for (const bar of bars) session.dispatch({ bar });
      const before = session.capture();
      expect(before.outputs.rvol.at(-1)).toBe(2.25);
      // Every setting the schema calls cosmetic, changed one at a time; if the builder removes the pickers the loop is empty and the rule holds trivially.
      const cosmetic = RELATIVE_VOLUME_SETTINGS_SCHEMA.filter((field) => field.kind !== "staticHint" && field.affects === "cosmetic");
      for (const field of cosmetic) {
        if (field.kind === "staticHint") continue;
        const key = field.key as keyof RelativeVolumeSettings;
        const value = field.kind === "color" ? "#123456" : field.kind === "boolean" ? !SETTINGS[key] : SETTINGS[key];
        session.updateSettings({ ...SETTINGS, [key]: value });
        const after = session.capture();
        expect(after.outputs.rvol.at(-1), `after changing cosmetic ${String(key)}`).toBe(2.25);
        expect(after.outputs.rvol).toEqual(before.outputs.rvol);
        expect(after.markers.map((call) => call.time)).toEqual(before.markers.map((call) => call.time));
        session.updateSettings(SETTINGS);
      }
    } finally {
      session.close();
    }
  });
});
