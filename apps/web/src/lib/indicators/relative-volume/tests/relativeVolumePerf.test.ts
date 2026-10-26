import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETAINED_SOURCE_BARS } from "../../../chart/candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  formatFormingBarProbe,
  formatPooledReplayProbe,
  formatReplayProbe,
  formatRolloverProbe,
  probeFormingBar,
  probeReplay,
  probeReplayPooled,
  probeRollover,
  relativeVolumeCryptoFixture,
} from "../../../chart/validation";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator } from "../relativeVolume";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Success criterion 4, measured the way amendment 9 freezes it: three untimed
 * warm-up replays, five timed replays of the first 10,080 crypto bars, per-bar
 * `onBar` plus `readOutput` samples pooled, p99 by nearest rank, no-op draw and
 * marker namespaces (drawing is excluded). `probeReplay` and `probeRollover`
 * add the protocol's real-runtime numbers. Set RVOL_PERF_OUT=<file> to keep the JSON.
 */

const P99_CEILING_MS = 0.05;

describe("relativeVolume -- performance (success criterion 4, protocol check 6)", () => {
  const { bars, labels } = relativeVolumeCryptoFixture();
  const timing = bars.slice(labels.timingIndices.first, labels.timingIndices.last + 1);

  it("pooled onBar plus readOutput p99 over the first 10,080 crypto bars is under 0.05 ms", () => {
    expect(timing).toHaveLength(10_080);
    const pooled = probeReplayPooled(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS, { warmupRuns: 3, timedRuns: 5 });
    const replay = probeReplay(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const rollover = probeRollover(relativeVolumeIndicator, timing, RELATIVE_VOLUME_DEFAULT_SETTINGS, { extraBars: 1_000 });
    const forming = probeFormingBar(relativeVolumeIndicator, timing.slice(-300), RELATIVE_VOLUME_DEFAULT_SETTINGS, { seconds: 10, revisionsPerSecond: 50, printsPerMinute: 1_000 });
    const lines = [formatPooledReplayProbe(pooled), formatReplayProbe(replay), formatRolloverProbe(rollover), formatFormingBarProbe(forming)];
    console.log(lines.join("\n"));
    if (process.env.RVOL_PERF_OUT) {
      mkdirSync(dirname(process.env.RVOL_PERF_OUT), { recursive: true });
      writeFileSync(process.env.RVOL_PERF_OUT, `${JSON.stringify({ node: process.version, pooled, replay, rollover, forming }, null, 2)}\n`);
    }
    expect(pooled.faulted).toBe(false);
    expect(pooled.pooled.count).toBe(10_080 * 5);
    expect(pooled.pooled.p99).toBeLessThan(P99_CEILING_MS);
    expect(replay.faulted).toBe(false);
    expect(replay.onBar.p99).toBeLessThanOrEqual(0.5);
    expect(replay.wallMs).toBeLessThanOrEqual(2_000);
    expect(forming.faulted).toBe(false);
    expect(forming.onBar.p99).toBeLessThanOrEqual(1);
    // Bounded state: after the rollover every line holds exactly the retained bars and no marker is older than the oldest one.
    expect(rollover.faulted).toBe(false);
    expect(rollover.retainedBars).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(rollover.outputLengths).toEqual({ rvol: MAX_RETAINED_SOURCE_BARS, rolling: MAX_RETAINED_SOURCE_BARS });
    expect(rollover.markersBeforeRetention).toBe(0);
  }, 600_000);
});
