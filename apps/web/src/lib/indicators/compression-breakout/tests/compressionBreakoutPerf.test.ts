import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "../../../chart/candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  constantWidthBars,
  formatPooledReplayProbe,
  formatReplayProbe,
  formatRolloverProbe,
  openLiveSession,
  percentilesOf,
  probeReplay,
  probeReplayPooled,
  probeRollover,
  relativeVolumeCryptoFixture,
  timedDef,
} from "../../../chart/validation";
import { COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, compressionBreakoutIndicator } from "../compressionBreakout";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Success criterion 3 and protocol check 6, measured the frozen way: three
 * untimed warm-up replays, five timed replays of the first 10,080 crypto
 * bars, per-bar `onBar` plus `readOutput` pooled (the per-bar snapshot copy
 * is inside the timed region), p99 by nearest rank. The forming-bar probe
 * warms a range on 10,080 constant-width bars, then revises the next bar 500
 * times alternating a breaking close and an inside close, so the break
 * marker appears and disappears on every revision. Set CB_PERF_OUT=<file>
 * to keep the JSON.
 */

const P99_CEILING_MS = 0.05;
const FORMING_REVISIONS = 500;

describe("compressionBreakout -- performance", () => {
  const { bars, labels } = relativeVolumeCryptoFixture();
  const timing = bars.slice(labels.timingIndices.first, labels.timingIndices.last + 1);

  it("pooled onBar plus readOutput p99 under 0.05 ms over 10,080 bars; forming revisions under 1 ms; bounded state after the rollover", () => {
    expect(timing).toHaveLength(10_080);
    const pooled = probeReplayPooled(compressionBreakoutIndicator, timing, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, { warmupRuns: 3, timedRuns: 5 });
    const replay = probeReplay(compressionBreakoutIndicator, timing, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
    const rollover = probeRollover(compressionBreakoutIndicator, timing, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, { extraBars: 1_000 });

    const warm = constantWidthBars({ count: 10_081 }).bars;
    const { def: timed, samples } = timedDef(compressionBreakoutIndicator);
    const session = openLiveSession(timed, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, {}, warm.slice(0, 10_080));
    const next = warm[10_080];
    let marked = 0;
    let formingWallMs = 0;
    try {
      samples.length = 0;
      const started = performance.now();
      for (let revision = 0; revision < FORMING_REVISIONS; revision += 1) {
        const breaking = revision % 2 === 0;
        const frame = { ...next, open: 60_050, high: breaking ? 60_305 : 60_055, low: 60_045, close: breaking ? 60_300 : 60_050, volume: 200, closed: revision === FORMING_REVISIONS - 1 } as BarFrame;
        session.dispatch({ bar: frame });
        if (session.runtime.getMarkers(timed.id)!.some((call) => call.time === next.ts_open)) marked += 1;
      }
      formingWallMs = performance.now() - started;
      expect(session.capture().faulted).toBe(false);
    } finally {
      session.close();
    }
    const forming = percentilesOf(samples);
    expect(forming.count).toBe(FORMING_REVISIONS);
    expect(marked).toBe(FORMING_REVISIONS / 2);

    const lines = [
      formatPooledReplayProbe(pooled),
      formatReplayProbe(replay),
      `compressionBreakout forming bar, range warmed on 10,080 bars, ${FORMING_REVISIONS} revisions crossing the edge each time (${marked} marked): onBar p50 ${forming.p50.toFixed(4)} ms p99 ${forming.p99.toFixed(4)} ms max ${forming.max.toFixed(3)} ms; wall ${formingWallMs.toFixed(0)} ms`,
      formatRolloverProbe(rollover),
    ];
    console.log(lines.join("\n"));
    if (process.env.CB_PERF_OUT) {
      mkdirSync(dirname(process.env.CB_PERF_OUT), { recursive: true });
      writeFileSync(process.env.CB_PERF_OUT, `${JSON.stringify({ node: process.version, pooled, replay, rollover, forming: { revisions: FORMING_REVISIONS, marked, onBar: forming, wallMs: formingWallMs } }, null, 2)}\n`);
    }
    expect(pooled.faulted).toBe(false);
    expect(pooled.pooled.count).toBe(10_080 * 5);
    expect(pooled.pooled.p99).toBeLessThan(P99_CEILING_MS);
    expect(replay.faulted).toBe(false);
    expect(replay.onBar.p99).toBeLessThanOrEqual(0.5);
    expect(replay.wallMs).toBeLessThanOrEqual(2_000);
    expect(forming.p99).toBeLessThanOrEqual(1);
    expect(rollover.faulted).toBe(false);
    expect(rollover.retainedBars).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(rollover.outputLengths).toEqual({ rangeHigh: MAX_RETAINED_SOURCE_BARS, rangeLow: MAX_RETAINED_SOURCE_BARS });
    expect(rollover.markersBeforeRetention).toBe(0);
  }, 600_000);
});
