import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETAINED_SOURCE_BARS } from "../../../chart/candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  busyTapeFor,
  formatFormingBarProbe,
  formatPooledReplayProbe,
  formatReplayProbe,
  formatRolloverProbe,
  probeFormingBar,
  probeReplay,
  probeReplayPooled,
  probeRollover,
  tapeOf,
  ticksOf,
  trendBars,
} from "../../../chart/validation";
import { SIZE_SPLIT_DEFAULT_SETTINGS, sizeSplitDeltaIndicator, type SizeSplitDeltaSettings } from "../sizeSplitDelta";
import { withTapeVolume } from "./helpers";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Protocol check 6 with the brief's frozen method: `probeReplayPooled` (three
 * untimed warm-ups, five timed runs, `onBar` plus `readOutput`) on 10,080
 * trend bars whose 20 prints each sit in one store of 201,600 prints (under
 * the tape's cap, so every window is `"all"`); `probeReplay` for the real
 * activation; `probeFormingBar` in fixed mode so the whole classification path
 * runs on 1,000 prints revised 50 times a second; `probeRollover` for the
 * bounded state. Set SIZE_SPLIT_PERF_OUT=<file> to keep the JSON.
 */

const POOLED_P99_CEILING_MS = 0.5;
const FORMING_P99_CEILING_MS = 0.1;

describe("sizeSplitDelta -- performance (protocol check 6, brief Performance)", () => {
  it("pooled p99 under 0.5 ms, forming p99 under 0.1 ms, replay wall under 5 s, every output key 10,080 long after the rollover with flat heap growth", () => {
    const { bars: raw } = trendBars({ count: MAX_RETAINED_SOURCE_BARS, driftPerBar: 0.5, noise: 25 });
    const printsByBar = busyTapeFor(raw, { printsPerBar: 20 });
    const bars = withTapeVolume(raw, printsByBar);
    const prints = bars.flatMap((bar) => printsByBar.get(bar.ts_open) ?? []);
    expect(prints).toHaveLength(201_600);
    const ticks = ticksOf(tapeOf(prints, bars[0].ts_open));
    const settings: SizeSplitDeltaSettings = { ...SIZE_SPLIT_DEFAULT_SETTINGS, anchor: "tape" };

    const pooled = probeReplayPooled(sizeSplitDeltaIndicator, bars, settings, { warmupRuns: 3, timedRuns: 5, extras: { ticks } });
    const replay = probeReplay(sizeSplitDeltaIndicator, bars, settings, { ticks });
    const rollover = probeRollover(sizeSplitDeltaIndicator, bars, settings, { extraBars: 1_000, extras: { ticks } });
    const fixed: SizeSplitDeltaSettings = { ...settings, tierMode: "fixed", tierSize: 0.5 };
    const forming = probeFormingBar(sizeSplitDeltaIndicator, bars.slice(-300), fixed, { seconds: 60, revisionsPerSecond: 50, printsPerMinute: 1_000 });

    const lines = [
      formatPooledReplayProbe(pooled),
      formatReplayProbe(replay),
      formatFormingBarProbe(forming),
      `sizeSplitDelta p99 side by side: replay (pooled) ${pooled.pooled.p99.toFixed(4)} ms, forming bar ${forming.onBar.p99.toFixed(4)} ms`,
      formatRolloverProbe(rollover),
    ];
    console.log(lines.join("\n"));
    if (process.env.SIZE_SPLIT_PERF_OUT) {
      mkdirSync(dirname(process.env.SIZE_SPLIT_PERF_OUT), { recursive: true });
      writeFileSync(process.env.SIZE_SPLIT_PERF_OUT, `${JSON.stringify({ node: process.version, pooled, replay, forming, rollover }, null, 2)}\n`);
    }

    expect(pooled.faulted).toBe(false);
    expect(pooled.pooled.count).toBe(MAX_RETAINED_SOURCE_BARS * 5);
    expect(pooled.pooled.p99).toBeLessThan(POOLED_P99_CEILING_MS);
    expect(replay.faulted).toBe(false);
    expect(replay.onBar.p99).toBeLessThanOrEqual(0.5);
    expect(replay.wallMs).toBeLessThanOrEqual(5_000);
    expect(forming.faulted).toBe(false);
    expect(forming.revisions).toBe(3_000);
    expect(forming.prints).toBe(1_000);
    expect(forming.onBar.p99).toBeLessThanOrEqual(FORMING_P99_CEILING_MS);
    expect(rollover.faulted).toBe(false);
    expect(rollover.retainedBars).toBe(MAX_RETAINED_SOURCE_BARS);
    expect(rollover.outputLengths).toEqual({ large: MAX_RETAINED_SOURCE_BARS, small: MAX_RETAINED_SOURCE_BARS, largeBar: MAX_RETAINED_SOURCE_BARS, smallBar: MAX_RETAINED_SOURCE_BARS });
    expect(rollover.markersBeforeRetention).toBe(0);
    // The heap slope is meaningful only under NODE_OPTIONS=--expose-gc; without it the probe says so and the number is reported, not judged.
    if (rollover.heap.gcExposed) expect(rollover.bytesPerExtraBar).toBeLessThanOrEqual(3 * 370);
    else console.log("sizeSplitDelta rollover heap slope not judged: gc not exposed");
  }, 600_000);
});
