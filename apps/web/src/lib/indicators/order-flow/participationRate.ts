import type { BarFrame, MarkerFrame } from "../../../types/frames";

export const DEFAULT_PARTICIPATION_WINDOW_MS = 5 * 60_000;

export function computeParticipationRateForSize(
  size: number,
  bars: readonly BarFrame[],
  nowMs: number,
  windowMs: number = DEFAULT_PARTICIPATION_WINDOW_MS,
): number | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) return null;
  const windowStart = nowMs - windowMs;
  const relevantBars = bars.filter((bar) => bar.closed && bar.ts_open >= windowStart && bar.ts_open < nowMs);
  if (relevantBars.length === 0) return null;
  const totalVolume = relevantBars.reduce((sum, bar) => sum + bar.volume, 0);
  if (totalVolume <= 0) return null;
  return size / totalVolume;
}

export function computeParticipationRate(
  marker: MarkerFrame,
  bars: readonly BarFrame[],
  nowMs: number,
  windowMs: number = DEFAULT_PARTICIPATION_WINDOW_MS,
): number | null {
  return computeParticipationRateForSize(marker.size, bars, nowMs, windowMs);
}
