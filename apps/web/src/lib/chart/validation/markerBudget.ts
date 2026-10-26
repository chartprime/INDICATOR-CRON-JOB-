import type { BarFrame } from "../../../types/frames";
import { plotCharCall, plotShapeCall, type MarkerCall, type MarkerPositionKind, type MarkerShapeKind } from "../draw/markers";
import type { MarkersNamespace, RuntimeIndicatorDef } from "../indicatorTypes";
import { liveArrivals, type Arrival } from "./fixtures";
import { driveLive, replayCapture, type LiveExtras } from "./liveDrive";

/**
 * Protocol check 5, the marker and alert budget. Counts what an indicator
 * plots per 1,000 bars on a busy synthetic instrument so the PM can set a
 * ceiling: a tool that marks every other bar is noise, however right each
 * mark is. In cycle 1 an "alert" is a marker, so this is also the alert
 * budget.
 */

export interface MarkerBudget {
  bars: number;
  total: number;
  per1000Bars: number;
  /** Most markers placed on a single bar time. */
  maxPerBar: number;
  barsWithMarkers: number;
  byShape: Partial<Record<MarkerShapeKind, number>>;
  byPosition: Partial<Record<MarkerPositionKind, number>>;
  byColor: Record<string, number>;
}

export function markerBudgetOf(markers: readonly MarkerCall[], bars: number): MarkerBudget {
  const perTime = new Map<number, number>();
  const byShape: Partial<Record<MarkerShapeKind, number>> = {};
  const byPosition: Partial<Record<MarkerPositionKind, number>> = {};
  const byColor: Record<string, number> = {};
  for (const call of markers) {
    perTime.set(call.time, (perTime.get(call.time) ?? 0) + 1);
    byShape[call.shape] = (byShape[call.shape] ?? 0) + 1;
    byPosition[call.position] = (byPosition[call.position] ?? 0) + 1;
    byColor[call.color] = (byColor[call.color] ?? 0) + 1;
  }
  let maxPerBar = 0;
  for (const count of perTime.values()) maxPerBar = Math.max(maxPerBar, count);
  return {
    bars,
    total: markers.length,
    per1000Bars: bars === 0 ? 0 : (markers.length / bars) * 1000,
    maxPerBar,
    barsWithMarkers: perTime.size,
    byShape,
    byPosition,
    byColor,
  };
}

export interface CountMarkersOptions {
  extras?: LiveExtras;
  /** Drive the bars live (with this many forming revisions each) instead of replaying; needed for tick-only indicators. */
  live?: { revisionsPerBar: number; tradesFor?: Parameters<typeof liveArrivals>[2] };
}

/** The budget of `def` over `bars`, from a clean replay or a live drive. */
export function countMarkers<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  options: CountMarkersOptions = {},
): MarkerBudget {
  const capture = options.live
    ? driveLive(def, liveArrivals(bars, options.live.revisionsPerBar, options.live.tradesFor), settings, options.extras)
    : replayCapture(def, bars, settings, options.extras);
  return markerBudgetOf(capture.markers, bars.length);
}

/** The budget of an arbitrary arrival script (duplicates, rebuilds, reconnects included). */
export function countMarkersOver<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  arrivals: readonly Arrival[],
  settings: T,
  extras: LiveExtras = {},
): MarkerBudget {
  const result = driveLive(def, arrivals, settings, extras);
  return markerBudgetOf(result.markers, result.bars.length);
}

export interface BudgetVerdict {
  ok: boolean;
  ceilingPer1000Bars: number;
  actualPer1000Bars: number;
  maxPerBarCeiling: number | null;
  maxPerBar: number;
}

/** Pass when the measured rate (and, if given, the per-bar maximum) is at or under the ceiling. */
export function judgeBudget(budget: MarkerBudget, ceilingPer1000Bars: number, maxPerBarCeiling: number | null = null): BudgetVerdict {
  const rateOk = budget.per1000Bars <= ceilingPer1000Bars;
  const perBarOk = maxPerBarCeiling === null || budget.maxPerBar <= maxPerBarCeiling;
  return { ok: rateOk && perBarOk, ceilingPer1000Bars, actualPer1000Bars: budget.per1000Bars, maxPerBarCeiling, maxPerBar: budget.maxPerBar };
}

export interface MarkerCapture {
  markers: MarkersNamespace;
  calls: MarkerCall[];
  /** Call before each hand-built `onBar` so the next bar's calls start from an empty list. */
  reset(): void;
}

/** A `ctx.markers` for a hand-built ctx that records every plotshape/plotchar call with the bar time it was made for. */
export function captureMarkers(timeOf: () => number): MarkerCapture {
  const calls: MarkerCall[] = [];
  return {
    calls,
    markers: {
      plotshape(options) {
        calls.push(plotShapeCall(timeOf(), options));
      },
      plotchar(options) {
        calls.push(plotCharCall(timeOf(), options));
      },
    },
    reset() {
      calls.length = 0;
    },
  };
}

export function summarizeBudget(label: string, budget: MarkerBudget, verdict?: BudgetVerdict): string {
  const head = `${label}: ${budget.total} marker(s) over ${budget.bars} bars = ${budget.per1000Bars.toFixed(1)} per 1,000 bars; ${budget.barsWithMarkers} bar(s) marked, at most ${budget.maxPerBar} on one bar`;
  if (!verdict) return head;
  return `${head}; ceiling ${verdict.ceilingPer1000Bars} per 1,000${verdict.maxPerBarCeiling === null ? "" : ` and ${verdict.maxPerBarCeiling} per bar`}: ${verdict.ok ? "PASS" : "FAIL"}`;
}
