import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { resampleBars } from "../../../chart/resampleBars";
import { diffMarkers, diffOutputs, markerBudgetOf, openLiveSession, replayCapture, type Outputs } from "../../../chart/validation";
import { COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, compressionBreakoutIndicator } from "../compressionBreakout";
import { plainFrozenRangeBaseline } from "./comparators";
import { compressionBreakoutSeamDef } from "./seamDef";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * The live observation run of the brief: real Binance spot candles recorded
 * from the REST transport (snapshot of 10,080 one-minute bars, then every bar
 * frame for thirty minutes) are driven through the real runtime the way the
 * chart receives them, then compared with a clean replay of the retained
 * series. Density, honesty and replay only: there is no label. Set
 * CB_LIVE_DIR to the directory holding `btc-usdt.json` and `eth-usdt.json`
 * (the recorder is `record-live.cjs`); the report goes to CB_LIVE_OUT.
 */

interface Recording {
  symbol: string;
  startedAt: string;
  endedAt: string;
  snapshotBars: BarFrame[];
  barFrames: (BarFrame & { receivedAt: number })[];
  counts: Record<string, number>;
}

const DIR = process.env.CB_LIVE_DIR ?? "";
const FILES = ["btc-usdt.json", "eth-usdt.json"].map((name) => join(DIR, name));
const available = DIR !== "" && FILES.every((file) => existsSync(file));

function eventsOf(outputs: Outputs, bars: readonly BarFrame[]): string[] {
  const lines: string[] = [];
  bars.forEach((bar, index) => {
    const when = new Date(bar.ts_open).toISOString().slice(5, 16).replace("T", " ");
    const dir = outputs.breakDir?.[index] ?? 0;
    if (dir !== 0) lines.push(`${when} break ${dir > 0 ? "↑" : "↓"} grade ${outputs.breakGrade?.[index]} basis ${outputs.gradeBasis?.[index]}`);
    if ((outputs.failed?.[index] ?? 0) === 1) lines.push(`${when} failed`);
    if ((outputs.heldOutside?.[index] ?? 0) === 1) lines.push(`${when} held outside`);
    if ((outputs.expired?.[index] ?? 0) === 1) lines.push(`${when} expired`);
  });
  return lines;
}

describe.skipIf(!available)("compressionBreakout -- live observation on BTC-USDT and ETH-USDT spot candles (REST transport)", () => {
  const report: string[] = ["# Compression Breakout live observation run", ""];

  it("live equals the replay of the retained series, nothing faults, and the marker density is under 40 per 1,000 on 1m and on resampled 5m", () => {
    for (const file of FILES) {
      const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
      const frames = recording.barFrames.map(({ receivedAt: _receivedAt, ...bar }) => bar as BarFrame);
      expect(recording.snapshotBars.length).toBeGreaterThan(1_000);
      // The chart's path: the snapshot is replayed on activation, then every bar frame is dispatched as it arrived.
      const session = openLiveSession(compressionBreakoutSeamDef, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, {}, recording.snapshotBars);
      let live;
      let retained: BarFrame[];
      let mutations: string[];
      try {
        for (const frame of frames) session.dispatch({ bar: frame });
        live = session.capture();
        retained = [...session.bars];
        mutations = [...session.mutations];
      } finally {
        session.close();
      }
      expect(live.faulted).toBe(false);
      const replay = replayCapture(compressionBreakoutSeamDef, retained, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
      const outputDiffs = diffOutputs(live.outputs, replay.outputs);
      // Amendment 1: equality is required from the first quiet bar; here the whole retained series is compared and the
      // disagreements, if any, are reported with their first index so the policy can be checked against them.
      const firstDiff = outputDiffs.length === 0 ? -1 : Math.min(...outputDiffs.map((diff) => diff.index));
      const productLive = (() => {
        const s = openLiveSession(compressionBreakoutIndicator, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, {}, recording.snapshotBars);
        try {
          for (const frame of frames) s.dispatch({ bar: frame });
          return s.capture();
        } finally {
          s.close();
        }
      })();
      const productReplay = replayCapture(compressionBreakoutIndicator, retained, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
      const confirmedLive = productLive.markers.filter((call) => !call.color.startsWith("rgba("));
      const confirmedReplay = productReplay.markers.filter((call) => !call.color.startsWith("rgba("));
      const markerDiff = diffMarkers(confirmedLive, confirmedReplay);
      const budget1m = markerBudgetOf(confirmedReplay, retained.length, productReplay.faulted);
      const fiveMinute = resampleBars(retained, 5 * 60_000);
      const replay5m = replayCapture(compressionBreakoutIndicator, fiveMinute, COMPRESSION_BREAKOUT_DEFAULT_SETTINGS);
      const budget5m = markerBudgetOf(replay5m.markers.filter((call) => !call.color.startsWith("rgba(")), fiveMinute.length, replay5m.faulted);
      const plain = replayCapture(plainFrozenRangeBaseline, retained, plainFrozenRangeBaseline.defaultSettings);
      const rangesOpened = replay.outputs.rangeAge.filter((age) => age === 0).length;
      const closes = frames.filter((frame) => frame.closed).length;
      report.push(
        `## ${recording.symbol}`,
        "",
        `Recorded ${recording.startedAt} to ${recording.endedAt}: snapshot ${recording.snapshotBars.length} bars, ${frames.length} bar frames (${closes} closes, ${new Set(frames.map((frame) => frame.ts_open)).size} distinct open times), mutations ${JSON.stringify(Object.fromEntries([...new Set(mutations)].map((kind) => [kind, mutations.filter((m) => m === kind).length])))}.`,
        "",
        `Live versus replay of the ${retained.length} retained bars: ${outputDiffs.length} seam disagreements${firstDiff >= 0 ? ` (first at index ${firstDiff})` : ""}, confirmed markers live-only ${markerDiff.leftOnly.length}, replay-only ${markerDiff.rightOnly.length}; faulted: ${live.faulted || replay.faulted}.`,
        "",
        `Ranges opened over the retained series: ${rangesOpened}. Markers: ${budget1m.total} on 1m (${budget1m.per1000Bars.toFixed(1)} per 1,000, max ${budget1m.maxPerBar} per bar); ${budget5m.total} on resampled 5m over ${fiveMinute.length} bars (${budget5m.per1000Bars.toFixed(1)} per 1,000).`,
        "",
        "Events, product (left) and plain frozen-range baseline (right):",
        "",
        "| Product | Plain frozen range |",
        "|---|---|",
      );
      const productEvents = eventsOf(replay.outputs, retained);
      const plainEvents = eventsOf(plain.outputs, retained);
      for (let index = 0; index < Math.max(productEvents.length, plainEvents.length); index += 1) report.push(`| ${productEvents[index] ?? ""} | ${plainEvents[index] ?? ""} |`);
      report.push("");
      expect(outputDiffs).toEqual([]);
      expect(markerDiff.leftOnly).toEqual([]);
      expect(markerDiff.rightOnly).toEqual([]);
      expect(budget1m.per1000Bars).toBeLessThanOrEqual(40);
      expect(budget5m.per1000Bars).toBeLessThanOrEqual(40);
      expect(budget1m.maxPerBar).toBeLessThanOrEqual(1);
    }
    const text = report.join("\n");
    console.log(text);
    if (process.env.CB_LIVE_OUT) {
      mkdirSync(dirname(process.env.CB_LIVE_OUT), { recursive: true });
      writeFileSync(process.env.CB_LIVE_OUT, `${text}\n`);
    }
  }, 600_000);
});
