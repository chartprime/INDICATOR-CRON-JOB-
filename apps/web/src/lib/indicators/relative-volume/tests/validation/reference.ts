import type { BarFrame } from "../../../../../types/frames";
import { nyLocalMinuteOfDay } from "../../../killzones/killzones";

/**
 * Validator's from-scratch batch reference for Relative Volume (Time of Day).
 * Written from the brief alone, not from `relativeVolumeMath.ts`: every bar is
 * keyed by its start minute of day, its denominator is the median of the last
 * `sessions` volumes filed under that key by STRICTLY EARLIER closed bars, the
 * rolling comparison is the mean of the previous 20 closed bars, and nothing
 * is incremental. Agreement with the incremental engine on the frozen fixtures
 * is the independent evidence for the stored denominator and the clock.
 */

export interface ReferenceSettings {
  sessions: number;
  minSessions: number;
  clock: "newYork" | "utc";
}

export interface ReferenceRow {
  key: number;
  priorCount: number;
  slotMedian: number | null;
  slotMean: number | null;
  rollingMean: number | null;
  rvol: number | null;
  slotMeanRatio: number | null;
  rolling: number | null;
}

export function referenceKey(tsOpen: number, clock: "newYork" | "utc"): number {
  return clock === "utc" ? Math.floor((tsOpen % 86_400_000) / 60_000) : nyLocalMinuteOfDay(tsOpen);
}

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function ratio(volume: number, denominator: number | null): number | null {
  if (denominator === null || !(denominator > 0)) return null;
  const value = volume / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Every bar is treated as closed; a bar with an unusable volume reads null and files nothing. */
export function referenceSeries(bars: readonly BarFrame[], settings: ReferenceSettings): ReferenceRow[] {
  const bySlot = new Map<number, number[]>();
  const committed: number[] = [];
  const rows: ReferenceRow[] = [];
  const required = Math.max(1, Math.min(settings.minSessions, settings.sessions));
  for (const bar of bars) {
    const key = referenceKey(bar.ts_open, settings.clock);
    const prior = (bySlot.get(key) ?? []).slice(-settings.sessions);
    const slotMedian = prior.length > 0 ? medianOf(prior) : null;
    const slotMean = prior.length > 0 ? meanOf(prior) : null;
    const previous = committed.slice(-20);
    const rollingMean = previous.length === 20 ? meanOf(previous) : null;
    const usable = Number.isFinite(bar.volume) && bar.volume >= 0;
    const row: ReferenceRow = {
      key,
      priorCount: prior.length,
      slotMedian,
      slotMean,
      rollingMean,
      rvol: usable && prior.length >= required ? ratio(bar.volume, slotMedian) : null,
      slotMeanRatio: usable && prior.length >= required ? ratio(bar.volume, slotMean) : null,
      rolling: usable ? ratio(bar.volume, rollingMean) : null,
    };
    rows.push(row);
    if (usable) {
      const slot = bySlot.get(key);
      if (slot) slot.push(bar.volume);
      else bySlot.set(key, [bar.volume]);
      committed.push(bar.volume);
    }
  }
  return rows;
}
