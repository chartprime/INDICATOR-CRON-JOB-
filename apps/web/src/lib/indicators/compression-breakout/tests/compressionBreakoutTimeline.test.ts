import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { compressionBreakoutBars, replayCapture } from "../../../chart/validation";
import { COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, compressionBreakoutIndicator } from "../compressionBreakout";
import { createCompressionBreakoutEngine } from "../compressionBreakoutMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Brief amendments 2 and 3, the pinned seed-7 timeline: the range opens on the
 * qualifying committed bar with age 0 (index 39 at the earliest), is eligible
 * to break once six later committed bars closed inside (index 46 at the
 * earliest), breaks at 220 with both tests passed, is pending 221..225, is held
 * outside at 225 with its edges still reported on that bar, and reports no
 * range from 226 until a new one qualifies.
 */
describe("compressionBreakout -- the pinned seed-7 timeline", () => {
  const { bars, labels } = compressionBreakoutBars({ seed: 7 });
  const capture = replayCapture(compressionBreakoutIndicator, bars, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
  const out = capture.outputs;

  it("does not fault and emits every output key", () => {
    expect(capture.faulted).toBe(false);
    for (const key of ["rangeHigh", "rangeLow"]) expect(out[key]).toHaveLength(bars.length);
  });

  it("breaks at the labelled bar with grade 3 and basis 3, pulses only there, pends 221..225 and is held outside at 225", () => {
    const b = labels.breakoutIndex;
    expect(b).toBe(220);
    const engine = createCompressionBreakoutEngine(COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
    const readings = bars.map((bar) => engine.onBar(bar));
    expect(readings[b].decision.kind).toBe("break");
    expect(readings[b].decision.dir).toBe(1);
    expect(readings[b].decision.grade).toBe(3);
    expect(readings[b].decision.basis).toBe(3);
    expect(readings[b].pending).toBe(0);
    expect(readings[b].rangeHigh).not.toBeNull();
    expect(readings[b].rangeHigh!).toBeLessThanOrEqual(labels.compressionHigh);
    expect(readings[b].rangeLow!).toBeGreaterThanOrEqual(labels.compressionLow);
    expect(bars[b].close).toBeGreaterThan(readings[b].rangeHigh!);
    for (let index = b + 1; index <= b + 5; index += 1) {
      expect(readings[index].pending).toBe(1);
      expect(readings[index].pendingBars).toBe(index - b);
      expect(readings[index].rangeHigh).toBe(readings[b].rangeHigh);
    }
    for (let index = b + 1; index <= b + 4; index += 1) expect(readings[index].decision.kind).toBe("pending");
    expect(readings[b + 5].decision.kind).toBe("heldOutside");
    expect(readings[b + 6].pending).toBe(0);
    expect(readings[b + 6].rangeHigh).toBeNull();
    expect(readings.filter((reading) => reading.decision.kind === "break")).toHaveLength(readings.filter((reading) => reading.decision.kind === "break" && reading.tsOpen === bars[b].ts_open).length);
    // lastEvent updates at the event bar's commit.
    expect(readings[b].lastEvent?.kind).toBe("break");
    expect(readings[b + 5].lastEvent?.kind).toBe("heldOutside");
    // The held range is drawn from 226 and freed at 266's commit (holdBars 40).
    expect(readings[b + 6].held.some((held) => held.closedTs === bars[b + 5].ts_open)).toBe(true);
    expect(readings[b + 45].held.some((held) => held.closedTs === bars[b + 5].ts_open)).toBe(true);
    expect(readings[b + 46].held.some((held) => held.closedTs === bars[b + 5].ts_open)).toBe(false);
  });

  it("opens no range before index 39 and never before 2 × rangeLength valid committed bars; the earliest eligible break is 46", () => {
    const engine = createCompressionBreakoutEngine(COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
    const readings = bars.map((bar) => engine.onBar(bar));
    for (let index = 0; index < 39; index += 1) {
      expect(readings[index].rangeReady).toBe(false);
      expect(readings[index].rangeHigh).toBeNull();
      expect(readings[index].qualified).toBeNull();
    }
    expect(readings[39].rangeReady).toBe(true);
    const firstOpen = readings.findIndex((reading) => reading.rangeHigh !== null);
    expect(firstOpen).toBeGreaterThanOrEqual(40); // reported one bar after the opening commit
    const firstBreak = readings.findIndex((reading) => reading.decision.kind === "break");
    expect(firstBreak === -1 || firstBreak >= 46).toBe(true);
    // age 0 at open: the first reading that shows the range reports age 0.
    expect(readings[firstOpen].rangeAge).toBe(0);
  });
});
