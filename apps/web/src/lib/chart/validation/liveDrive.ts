import type { BarFrame } from "../../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "../candleLifecycle";
import { mergeChartBar, type ChartBarMutation } from "../chartData";
import type { MarkerCall } from "../draw/markers";
import type { IndicatorL2 } from "../indicatorL2";
import type { IndicatorLiquidity } from "../indicatorLiquidity";
import { createIndicatorRuntime, type IndicatorRuntime } from "../indicatorRuntime";
import type { IndicatorTicks } from "../indicatorTicks";
import type { RuntimeIndicatorDef } from "../indicatorTypes";
import type { Arrival, ArrivalSession } from "./fixtures";

/**
 * Drives one indicator through the real `indicatorRuntime` the way the chart
 * does: bars are classified with `mergeChartBar`, the retained array is capped
 * at `MAX_RETAINED_SOURCE_BARS` with `discardLeading` on the rollover, and the
 * outputs and markers read back are the runtime's own. The hand-built ctx of
 * `replayBars` is deliberately not used here: a validation check has to see
 * what the chart would see, including the runtime's replace and marker
 * bookkeeping.
 */

export interface LiveExtras {
  ticks?: IndicatorTicks | null;
  l2?: IndicatorL2 | null;
  liquidity?: IndicatorLiquidity | null;
}

export type Outputs = Readonly<Record<string, readonly (number | null)[]>>;

export interface Capture {
  outputs: Outputs;
  markers: readonly MarkerCall[];
  /** Null when the runtime latched the indicator as faulted. */
  faulted: boolean;
}

export interface LiveSession<S, T> extends ArrivalSession {
  readonly def: RuntimeIndicatorDef<S, T>;
  readonly runtime: IndicatorRuntime;
  readonly bars: BarFrame[];
  readonly mutations: ChartBarMutation[];
  /** How many bars the rollover has trimmed off the front so far. */
  readonly discarded: number;
  dispatch(arrival: Arrival): ChartBarMutation;
  capture(): Capture;
  /** Removes the indicator so its draw handles leave the registry. */
  close(): void;
}

function copyOutputs(outputs: Outputs | null): Outputs {
  if (outputs === null) return {};
  const copy: Record<string, (number | null)[]> = {};
  for (const [key, values] of Object.entries(outputs)) copy[key] = [...values];
  return copy;
}

export function captureOf(runtime: IndicatorRuntime, id: string, hasLines: boolean): Capture {
  const outputs = runtime.getOutput(id);
  const markers = runtime.getMarkers(id);
  return {
    outputs: copyOutputs(outputs),
    markers: markers === null ? [] : markers.map((call) => ({ ...call })),
    faulted: hasLines ? outputs === null : markers === null,
  };
}

export function openLiveSession<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  settings: T,
  extras: LiveExtras = {},
  warmup: readonly BarFrame[] = [],
): LiveSession<S, T> {
  const runtime = createIndicatorRuntime([def as RuntimeIndicatorDef<unknown, unknown>]);
  const bars: BarFrame[] = [...warmup];
  const mutations: ChartBarMutation[] = [];
  let discarded = 0;
  if (extras.ticks !== undefined) runtime.setTicks(extras.ticks, []);
  if (extras.l2 !== undefined) runtime.setL2(extras.l2, []);
  if (extras.liquidity !== undefined) runtime.setLiquidity(extras.liquidity, []);
  runtime.setActive(new Set([def.id]), { [def.id]: settings }, bars);

  const session: LiveSession<S, T> = {
    def,
    runtime,
    bars,
    mutations,
    get discarded() {
      return discarded;
    },
    setTicks(ticks) {
      runtime.setTicks(ticks, bars);
    },
    setL2(l2) {
      runtime.setL2(l2, bars);
    },
    updateSettings(next) {
      runtime.updateSettings(def.id, next, bars);
    },
    dispatch(arrival) {
      arrival.act?.(session);
      const mutation = mergeChartBar(bars, arrival.bar);
      mutations.push(mutation);
      if (mutation === "REJECTED_REOPEN") return mutation;
      let removed = 0;
      if (bars.length > MAX_RETAINED_SOURCE_BARS) {
        removed = bars.length - MAX_RETAINED_SOURCE_BARS;
        bars.splice(0, removed);
        discarded += removed;
      }
      runtime.onBar(arrival.bar, mutation, bars, arrival.trades, arrival.tradeAvailability);
      if (removed > 0 && mutation === "APPENDED") runtime.discardLeading(removed, bars[0]?.ts_open);
      return mutation;
    },
    capture() {
      return captureOf(runtime, def.id, def.lines.length > 0);
    },
    close() {
      runtime.setActive(new Set(), {}, []);
    },
  };
  return session;
}

export interface LiveResult extends Capture {
  bars: BarFrame[];
  mutations: ChartBarMutation[];
}

/** Feeds `arrivals` through a fresh session and returns what the runtime holds at the end. */
export function driveLive<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  arrivals: readonly Arrival[],
  settings: T,
  extras: LiveExtras = {},
  warmup: readonly BarFrame[] = [],
): LiveResult {
  const session = openLiveSession(def, settings, extras, warmup);
  try {
    for (const arrival of arrivals) session.dispatch(arrival);
    return { ...session.capture(), bars: [...session.bars], mutations: [...session.mutations] };
  } finally {
    session.close();
  }
}

/** A clean replay of `bars` through the runtime (`onSnapshot`), the way activation or a reconnect replays. */
export function replayCapture<S, T>(
  def: RuntimeIndicatorDef<S, T>,
  bars: readonly BarFrame[],
  settings: T,
  extras: LiveExtras = {},
): Capture {
  const session = openLiveSession(def, settings, extras, []);
  try {
    session.runtime.onSnapshot(bars);
    return session.capture();
  } finally {
    session.close();
  }
}

export interface OutputDiff {
  index: number;
  key: string;
  left: number | null | undefined;
  right: number | null | undefined;
}

export function valuesEqual(left: number | null | undefined, right: number | null | undefined, tolerance: number): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return Math.abs(left - right) <= tolerance;
}

/** Every position where two output maps disagree; keys present on one side only count as disagreements. */
export function diffOutputs(left: Outputs, right: Outputs, tolerance = 0, upToIndex = Infinity): OutputDiff[] {
  const diffs: OutputDiff[] = [];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = left[key] ?? [];
    const b = right[key] ?? [];
    const length = Math.min(Math.max(a.length, b.length), upToIndex + 1);
    for (let index = 0; index < length; index += 1) {
      if (!valuesEqual(a[index], b[index], tolerance)) diffs.push({ index, key, left: a[index], right: b[index] });
    }
  }
  return diffs;
}

export function markerKey(call: MarkerCall): string {
  return JSON.stringify([call.time, call.shape, call.position, call.color, call.text ?? null, call.size ?? null, call.price ?? null]);
}

export interface MarkerDiff {
  leftOnly: MarkerCall[];
  rightOnly: MarkerCall[];
}

/** Multiset difference of two marker lists, order-insensitive. */
export function diffMarkers(left: readonly MarkerCall[], right: readonly MarkerCall[], upToTime = Infinity): MarkerDiff {
  const counts = new Map<string, number>();
  const byKey = new Map<string, MarkerCall>();
  for (const call of left) {
    if (call.time > upToTime) continue;
    const key = markerKey(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byKey.set(key, call);
  }
  const rightOnly: MarkerCall[] = [];
  for (const call of right) {
    if (call.time > upToTime) continue;
    const key = markerKey(call);
    const count = counts.get(key) ?? 0;
    if (count === 0) rightOnly.push(call);
    else counts.set(key, count - 1);
  }
  const leftOnly: MarkerCall[] = [];
  for (const [key, count] of counts) {
    const call = byKey.get(key)!;
    for (let index = 0; index < count; index += 1) leftOnly.push(call);
  }
  return { leftOnly, rightOnly };
}
