import type { BarFrame } from "../../../types/frames";
import type { ChartBarMutation } from "../chartData";
import type { RuntimeIndicatorDef } from "../indicatorTypes";
import { duplicateClosedArrivals, liveArrivals, rebuiltArrivals, type Arrival } from "./fixtures";
import {
  diffMarkers,
  diffOutputs,
  driveLive,
  replayCapture,
  type Capture,
  type LiveExtras,
  type MarkerDiff,
  type OutputDiff,
} from "./liveDrive";

/**
 * Protocol check 2, replay versus live. The same bars are fed two ways: live,
 * one bar at a time with `revisionsPerBar` forming revisions before each
 * close (APPENDED then REPLACED_EDGE, as the chart dispatches them), and as a
 * clean replay (`onSnapshot`). The committed outputs and markers must agree,
 * or the indicator must document the difference; a tick-only indicator is
 * expected to differ (markers live, none in replay) and the report shows
 * exactly that difference so the test can pin it.
 *
 * Protocol check 3 lives here too: a duplicated closed dispatch and a late bar
 * (`REBUILT`) must leave the indicator where a clean feed would have.
 */

export interface EquivalenceOptions {
  /** Forming revisions per bar before its close (default 5). */
  revisionsPerBar?: number;
  tolerance?: number;
  extras?: LiveExtras;
  /** Trades and availability for each live frame; replay always sees none. */
  tradesFor?: Parameters<typeof liveArrivals>[2];
}

export interface EquivalenceReport {
  equal: boolean;
  outputsEqual: boolean;
  markersEqual: boolean;
  outputDiffs: OutputDiff[];
  /** `leftOnly` are live-only markers, `rightOnly` replay-only. */
  markerDiff: MarkerDiff;
  live: Capture;
  replay: Capture;
  mutations: ChartBarMutation[];
}

function compare(live: Capture, replay: Capture, tolerance: number, mutations: ChartBarMutation[]): EquivalenceReport {
  const outputDiffs = diffOutputs(live.outputs, replay.outputs, tolerance);
  const markerDiff = diffMarkers(live.markers, replay.markers);
  const outputsEqual = outputDiffs.length === 0 && !live.faulted && !replay.faulted;
  const markersEqual = markerDiff.leftOnly.length === 0 && markerDiff.rightOnly.length === 0;
  return { equal: outputsEqual && markersEqual, outputsEqual, markersEqual, outputDiffs, markerDiff, live, replay, mutations };
}

export function checkLiveReplayEquivalence<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  options: EquivalenceOptions = {},
): EquivalenceReport {
  const arrivals = liveArrivals(bars, options.revisionsPerBar ?? 5, options.tradesFor);
  const live = driveLive(def, arrivals, settings, options.extras);
  const replay = replayCapture(def, bars, settings, options.extras);
  return compare(live, replay, options.tolerance ?? 0, live.mutations);
}

/** Any arrival script against a clean replay of the bars the script ends with. */
export function checkArrivalsAgainstReplay<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  arrivals: readonly Arrival[],
  settings: T,
  options: Pick<EquivalenceOptions, "tolerance" | "extras"> = {},
): EquivalenceReport {
  const live = driveLive(def, arrivals, settings, options.extras);
  const replay = replayCapture(def, live.bars, settings, options.extras);
  return compare(live, replay, options.tolerance ?? 0, live.mutations);
}

/** The closed bar at `duplicateIndex` arrives twice; the result must equal a feed where it arrived once. */
export function checkDuplicateClosedIdempotent<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  duplicateIndex: number,
  options: Pick<EquivalenceOptions, "tolerance" | "extras"> = {},
): EquivalenceReport & { duplicateMutation: ChartBarMutation } {
  const { arrivals } = duplicateClosedArrivals(bars, duplicateIndex);
  const withDuplicate = driveLive(def, arrivals, settings, options.extras);
  const clean = driveLive(def, bars.map((bar) => ({ bar })), settings, options.extras);
  const report = compare(withDuplicate, clean, options.tolerance ?? 0, withDuplicate.mutations);
  return { ...report, duplicateMutation: withDuplicate.mutations[duplicateIndex + 1] };
}

/** `bars[lateIndex]` arrives late (a `REBUILT`); the result must equal a clean replay of the full series. */
export function checkRebuiltEquivalence<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  lateIndex: number,
  options: Pick<EquivalenceOptions, "tolerance" | "extras"> & { lateBy?: number } = {},
): EquivalenceReport & { sawRebuilt: boolean } {
  const { arrivals } = rebuiltArrivals(bars, lateIndex, options.lateBy ?? 2);
  const report = checkArrivalsAgainstReplay(def, arrivals, settings, options);
  return { ...report, sawRebuilt: report.mutations.includes("REBUILT") };
}

export function summarizeEquivalence(label: string, report: EquivalenceReport): string {
  if (report.equal) return `${label}: PASS (outputs and markers identical)`;
  const lines = [`${label}: ${report.outputsEqual ? "outputs identical" : `${report.outputDiffs.length} output disagreement(s)`}, ${report.markersEqual ? "markers identical" : `${report.markerDiff.leftOnly.length} live-only and ${report.markerDiff.rightOnly.length} replay-only marker(s)`}`];
  if (report.live.faulted) lines.push("  live run faulted");
  if (report.replay.faulted) lines.push("  replay faulted");
  for (const diff of report.outputDiffs.slice(0, 5)) lines.push(`  bar ${diff.index} ${diff.key}: live=${String(diff.left)} replay=${String(diff.right)}`);
  if (report.outputDiffs.length > 5) lines.push(`  ... ${report.outputDiffs.length - 5} more`);
  return lines.join("\n");
}
