import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../../chart/draw/creationScope";
import { resetDrawRegistryForTests, tablesForOwners } from "../../../../chart/draw/registry";
import type { TableData } from "../../../../chart/draw/table";
import {
  checkTruncationInvariance,
  openLiveSession,
  relativeVolumeCryptoFixture,
  relativeVolumeEquityFixture,
  replayCapture,
  sampledIndices,
  summarizeTruncation,
} from "../../../../chart/validation";
import { nyLocalMinuteOfDay } from "../../../killzones/killzones";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator, type RelativeVolumeSettings } from "../../relativeVolume";
import { createRelativeVolumeEngine, slotKeyOf } from "../../relativeVolumeMath";
import { medianOf, referenceKey, referenceSeries } from "./reference";

// Validation loop 1 (PM/log/validation/relativeVolume/loop-1.md), protocol
// checks 1, 2 and 4 judged against the validator's own batch reference rather
// than the builder's engine.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const SETTINGS: RelativeVolumeSettings = { ...RELATIVE_VOLUME_DEFAULT_SETTINGS, showRolling: true };
const EQUITY = relativeVolumeEquityFixture();
const CRYPTO = relativeVolumeCryptoFixture();

describe("validator reference: the incremental engine equals a from-scratch batch computation", () => {
  it("equity fixture under the New York clock: rvol and rolling agree bar for bar, exactly", () => {
    const capture = replayCapture(relativeVolumeIndicator, EQUITY.bars, SETTINGS);
    const reference = referenceSeries(EQUITY.bars, { sessions: 10, minSessions: 3, clock: "newYork" });
    expect(capture.faulted).toBe(false);
    let ready = 0;
    EQUITY.bars.forEach((_, index) => {
      expect(capture.outputs.rvol[index]).toBe(reference[index].rvol);
      expect(capture.outputs.rolling[index]).toBe(reference[index].rolling);
      if (reference[index].rvol !== null) ready += 1;
    });
    // Sessions 4..15 at every minute are ready: the DST change between sessions 5 and 6 did not split any slot.
    expect(ready).toBe(12 * 390);
  });

  it("crypto fixture under UTC: agrees bar for bar on all 12,000 bars at the default lookback", () => {
    const capture = replayCapture(relativeVolumeIndicator, CRYPTO.bars, SETTINGS);
    const reference = referenceSeries(CRYPTO.bars, { sessions: 10, minSessions: 3, clock: "utc" });
    CRYPTO.bars.forEach((_, index) => {
      expect(capture.outputs.rvol[index]).toBe(reference[index].rvol);
      expect(capture.outputs.rolling[index]).toBe(reference[index].rolling);
    });
    expect(capture.outputs.rvol.filter((value) => value !== null)).toHaveLength(12_000 - 3 * 1_440);
  });

  it("the stored denominator never includes the bar's own volume: rvol × median(strictly earlier same-slot volumes) = volume", () => {
    const capture = replayCapture(relativeVolumeIndicator, EQUITY.bars, SETTINGS);
    const seen = new Map<number, number[]>();
    EQUITY.bars.forEach((bar, index) => {
      const key = nyLocalMinuteOfDay(bar.ts_open);
      const earlier = (seen.get(key) ?? []).slice(-10);
      const rvol = capture.outputs.rvol[index];
      if (rvol !== null) {
        expect(earlier.length).toBeGreaterThanOrEqual(3);
        expect(rvol * medianOf(earlier)).toBeCloseTo(bar.volume, 9);
        // A denominator that included the bar itself would differ whenever the bar is an anomaly.
        if (EQUITY.labels.anomalyIndices.includes(index)) expect(rvol * medianOf([...earlier, bar.volume])).not.toBeCloseTo(bar.volume, 6);
      }
      seen.set(key, [...(seen.get(key) ?? []), bar.volume]);
    });
  });

  it("New York keys: every equity bar keys 570 + minute in all 15 sessions, and the crypto fixture under the New York clock crosses the DST hour exactly as killzones does", () => {
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    EQUITY.bars.forEach((bar, index) => {
      engine.onBar(bar);
      expect(engine.tail!.key).toBe(570 + (index % 390));
    });
    // 2026-03-08 07:00 UTC: 01:59 EST becomes 03:00 EDT; the New York minute jumps from 119 to 180.
    const forced = createRelativeVolumeEngine({ sessions: 3, minSessions: 3, clock: "newYork" });
    let jumps = 0;
    let previousKey: number | null = null;
    for (const bar of CRYPTO.bars.slice(0, 8 * 1_440)) {
      forced.onBar(bar);
      const key = forced.tail!.key!;
      expect(key).toBe(nyLocalMinuteOfDay(bar.ts_open));
      expect(key).toBe(referenceKey(bar.ts_open, "newYork"));
      if (previousKey !== null && key !== (previousKey + 1) % 1_440) {
        jumps += 1;
        expect(previousKey).toBe(119);
        expect(key).toBe(180);
        expect(bar.ts_open).toBe(Date.UTC(2026, 2, 8, 7, 0));
      }
      previousKey = key;
    }
    expect(jumps).toBe(1);
    expect(slotKeyOf(Date.UTC(2026, 2, 8, 6, 59), "newYork")).toBe(119);
    expect(slotKeyOf(Date.UTC(2026, 2, 8, 7, 0), "newYork")).toBe(180);
  });

  it("no NaN anywhere: outputs, fill points, marker colours and table text across a live feed of the equity fixture", () => {
    const session = openLiveSession(relativeVolumeIndicator, SETTINGS, {}, []);
    try {
      for (const bar of EQUITY.bars) session.dispatch({ bar });
      const capture = session.capture();
      for (const values of Object.values(capture.outputs)) for (const value of values) expect(value === null || Number.isFinite(value)).toBe(true);
      const fill = session.runtime.getFillPoints(relativeVolumeIndicator.id)!;
      expect(fill.points).toHaveLength(EQUITY.bars.length);
      for (const point of fill.points) if (point !== null) expect(Number.isFinite(point.valueA) && Number.isFinite(point.valueB)).toBe(true);
      for (const marker of capture.markers) expect(marker.color).not.toMatch(/NaN|undefined/);
      const owner = session.runtime.getDrawOwnerId(relativeVolumeIndicator.id)!;
      const grid = (tablesForOwners([owner])[0].data as TableData).committedGrid;
      for (const cell of Object.values(grid)) expect(cell.text).not.toMatch(/NaN|undefined|Infinity/);
      expect(grid["0,0"].text).toMatch(/^RVOL \d+\.\d× · 10 prior$/);
    } finally {
      session.close();
    }
  });
});

describe("validator: no future data (check 1) on a denser sweep than the builder's", () => {
  it("truncation at every 13th index plus the last 50 of the equity fixture changes nothing earlier", () => {
    const indices = sampledIndices(EQUITY.bars.length, 13, 50);
    const report = checkTruncationInvariance(relativeVolumeIndicator, EQUITY.bars, SETTINGS, { indices });
    console.log(summarizeTruncation(report));
    expect(report.checked).toBe(indices.length);
    expect(report.ok).toBe(true);
  }, 300_000);
});
