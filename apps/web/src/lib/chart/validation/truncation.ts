import type { BarFrame } from "../../../types/frames";
import type { MarkerCall } from "../draw/markers";
import type { RuntimeIndicatorDef } from "../indicatorTypes";
import { diffMarkers, diffOutputs, replayCapture, type LiveExtras, type OutputDiff } from "./liveDrive";

/**
 * Protocol check 1, no future data. A bar's committed output must be the same
 * whether or not later bars exist. The series is replayed once in full and
 * then truncated at every index (or at `indices`); the truncated replay's
 * outputs and markers up to the cut must equal the full replay's. Anything
 * that differs is a value that depended on bars after its own close -- a
 * repaint, a centred window, a `barCount`-anchored lookahead.
 */

export interface TruncationOptions {
  /** Indices to truncate at; every index by default (`sampledIndices` cheapens a long series). */
  indices?: readonly number[];
  /** Absolute tolerance for numeric outputs; 0 (exact) by default. */
  tolerance?: number;
  extras?: LiveExtras;
  /** Compare markers too (default true). */
  markers?: boolean;
}

export interface MarkerViolation {
  truncatedAt: number;
  /** Markers the full replay placed at or before the cut that the truncated replay did not. */
  missing: MarkerCall[];
  /** Markers the truncated replay placed that the full replay did not. */
  extra: MarkerCall[];
}

export interface TruncationReport {
  ok: boolean;
  bars: number;
  checked: number;
  /** `[truncatedAt, diff]`: at which cut each output disagreement showed. */
  violations: { truncatedAt: number; diff: OutputDiff }[];
  markerViolations: MarkerViolation[];
  faulted: boolean;
}

export function checkTruncationInvariance<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  options: TruncationOptions = {},
): TruncationReport {
  const tolerance = options.tolerance ?? 0;
  const compareMarkers = options.markers ?? true;
  const indices = options.indices ?? bars.map((_, index) => index);
  const full = replayCapture(def, bars, settings, options.extras);
  const violations: TruncationReport["violations"] = [];
  const markerViolations: MarkerViolation[] = [];
  let faulted = full.faulted;
  let checked = 0;
  for (const cut of indices) {
    if (cut < 0 || cut >= bars.length) continue;
    checked += 1;
    const truncated = replayCapture(def, bars.slice(0, cut + 1), settings, options.extras);
    faulted = faulted || truncated.faulted;
    for (const diff of diffOutputs(full.outputs, truncated.outputs, tolerance, cut)) violations.push({ truncatedAt: cut, diff });
    if (compareMarkers) {
      const { leftOnly, rightOnly } = diffMarkers(full.markers, truncated.markers, bars[cut].ts_open);
      if (leftOnly.length > 0 || rightOnly.length > 0) markerViolations.push({ truncatedAt: cut, missing: leftOnly, extra: rightOnly });
    }
  }
  return {
    ok: !faulted && violations.length === 0 && markerViolations.length === 0,
    bars: bars.length,
    checked,
    violations,
    markerViolations,
    faulted,
  };
}

/** One line per distinct offending key, for the evidence file. */
export function summarizeTruncation(report: TruncationReport): string {
  if (report.ok) return `truncation invariance: PASS (${report.checked} cuts over ${report.bars} bars)`;
  const lines = [`truncation invariance: FAIL (${report.checked} cuts over ${report.bars} bars)`];
  if (report.faulted) lines.push("  the indicator faulted during a replay");
  const byKey = new Map<string, { count: number; first: TruncationReport["violations"][number] }>();
  for (const violation of report.violations) {
    const entry = byKey.get(violation.diff.key);
    if (entry) entry.count += 1;
    else byKey.set(violation.diff.key, { count: 1, first: violation });
  }
  for (const [key, { count, first }] of byKey) {
    lines.push(
      `  ${key}: ${count} disagreement(s); first at bar ${first.diff.index} when truncated at ${first.truncatedAt}: full=${String(first.diff.left)} truncated=${String(first.diff.right)}`,
    );
  }
  for (const violation of report.markerViolations.slice(0, 5)) {
    lines.push(`  markers truncated at ${violation.truncatedAt}: ${violation.missing.length} missing, ${violation.extra.length} extra`);
  }
  if (report.markerViolations.length > 5) lines.push(`  ... ${report.markerViolations.length - 5} more marker disagreement(s)`);
  return lines.join("\n");
}
