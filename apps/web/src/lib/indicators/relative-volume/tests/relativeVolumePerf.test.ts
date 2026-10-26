import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETAINED_SOURCE_BARS } from "../../../chart/candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
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
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator } from "../relativeVolume";
import { createRelativeVolumeEngine, ringMedian } from "../relativeVolumeMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Success criterion 4, measured the way amendment 9 freezes it: three untimed
 * warm-up replays, five timed replays of the first 10,080 crypto bars, per-bar
 * `onBar` plus `readOutput` samples pooled, p99 by nearest rank, no-op draw and
 * marker namespaces (drawing is excluded). The forming-bar probe (ruling 5)
 * warms every slot with all 10,080 bars first, then revises the next bar 500
 * times crossing the unusual threshold on every revision, and reports its p99
 * beside the replay p99. `probeReplay` and `probeRollover` add the protocol's
 * real-runtime numbers. Set RVOL_PERF_OUT=<file> to keep the JSON.
 */

const P99_CEILING_MS = 0.05;
const FORMING_REVISIONS = 500;

describe("relativeVolume -- performance (success criterion 4, protocol check 6)", () => {
  const { bars, labels } = relativeVolumeCryptoFixture();
  const timing = bars.slice(labels.timingIndices.first, labels.timingIndices.last + 1);

  it("pooled onBar plus readOutput p99 over the first 10,080 crypto bars is under 0.05 ms; the forming bar with warmed slots and threshold crossings is reported beside it", () => {
    expect(timing).toHaveLength(10_080);
    const pooled = probeReplayPooled(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS, { warmupRuns: 3, timedRuns: 5 });
    const replay = probeReplay(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const rollover = probeRollover(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS, { extraBars: 1_000 });

    // Forming bar: every slot warmed on the full timing window, then the next bar revised 500 times,
    // alternating 2.5x and 1.5x of its slot median so the marker appears and disappears on every revision.
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "utc" });
    for (const bar of timing) engine.onBar(bar);
    const next = bars[labels.timingIndices.last + 1];
    const slotMedian = ringMedian(engine.slotRing(labels.minuteOfDay[labels.timingIndices.last + 1])!)!;
    expect(engine.slotRing(labels.minuteOfDay[labels.timingIndices.last + 1])!.items).toHaveLength(7);
    const { def: timed, samples } = timedDef(relativeVolumeIndicator);
    const session = openLiveSession(timed, RELATIVE_VOLUME_DEFAULT_SETTINGS, {}, timing);
    let hot = 0;
    let formingWallMs = 0;
    try {
      samples.length = 0;
      const started = performance.now();
      for (let revision = 0; revision < FORMING_REVISIONS; revision += 1) {
        const volume = Math.round(slotMedian * (revision % 2 === 0 ? 2.5 : 1.5));
        session.dispatch({ bar: { ...next, volume, closed: revision === FORMING_REVISIONS - 1 } });
        if (session.runtime.getMarkers(timed.id)!.some((call) => call.time === next.ts_open)) hot += 1;
      }
      formingWallMs = performance.now() - started;
      const last = session.capture();
      expect(last.faulted).toBe(false);
      expect(last.outputs.rvol.at(-1)).toBeCloseTo(Math.round(slotMedian * 1.5) / slotMedian, 12);
      expect(last.outputs.rvol.at(-1)).not.toBeNull();
    } finally {
      session.close();
    }
    const forming = percentilesOf(samples);
    expect(forming.count).toBe(FORMING_REVISIONS);
    expect(hot).toBe(FORMING_REVISIONS / 2);

    const formingLine = `relativeVolume forming bar, slots warmed on ${timing.length} bars, ${FORMING_REVISIONS} revisions crossing the threshold each time (${hot} hot): onBar p50 ${forming.p50.toFixed(4)} ms p99 ${forming.p99.toFixed(4)} ms max ${forming.max.toFixed(3)} ms; wall ${formingWallMs.toFixed(0)} ms`;
    const lines = [
      formatPooledReplayProbe(pooled),
      formatReplayProbe(replay),
      `relativeVolume p99 side by side: replay (pooled) ${pooled.pooled.p99.toFixed(4)} ms, forming bar (warmed slots) ${forming.p99.toFixed(4)} ms`,
      formingLine,
      formatRolloverProbe(rollover),
    ];
    console.log(lines.join("\n"));
    if (process.env.RVOL_PERF_OUT) {
      mkdirSync(dirname(process.env.RVOL_PERF_OUT), { recursive: true });
      writeFileSync(
        process.env.RVOL_PERF_OUT,
        `${JSON.stringify({ node: process.version, pooled, replay, rollover, forming: { warmedBars: timing.length, revisions: FORMING_REVISIONS, hotRevisions: hot, onBar: forming, wallMs: formingWallMs } }, null, 2)}\n`,
      );
    }
    expect(pooled.faulted).toBe(false);
    expect(pooled.pooled.count).toBe(10_080 * 5);
    expect(pooled.pooled.p99).toBeLessThan(P99_CEILING_MS);
    expect(replay.faulted).toBe(false);
    expect(replay.onBar.p99).toBeLessThanOrEqual(0.5);
    expect(replay.wallMs).toBeLessThanOrEqual(2_000);
    expect(forming.p99).toBeLessThanOrEqual(1);
    // Bounded state: after the rollover every line holds exactly the retained bars and no marker is older than the oldest one.
    expect(rollover.faulted).toBe(false);
    expect(rollover.retainedBars).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(rollover.outputLengths).toEqual({ rvol: MAX_RETAINED_SOURCE_BARS, rolling: MAX_RETAINED_SOURCE_BARS });
    expect(rollover.markersBeforeRetention).toBe(0);
  }, 600_000);
});
