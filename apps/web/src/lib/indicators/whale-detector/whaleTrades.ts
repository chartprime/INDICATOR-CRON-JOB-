import type { MarkerFrame } from "../../../types/frames";

export interface WhaleTradeStat {
  marker: MarkerFrame;
  magnitude: number;
}

export type WhaleDetectionMode = "size" | "topPercent";

export const MIN_WHALE_THRESHOLD_USD = 20_000;
export const MAX_WHALE_THRESHOLD_USD = 50_000_000;
export const DEFAULT_WHALE_THRESHOLD_USD = 75_000;

export const MIN_WHALE_THRESHOLD_CONTRACTS = 1;
export const MAX_WHALE_THRESHOLD_CONTRACTS = 400;
export const DEFAULT_WHALE_THRESHOLD_CONTRACTS = 20;

export const MIN_TOP_FRACTION = 0.0000125;
export const MAX_TOP_FRACTION = 0.02;
export const DEFAULT_TOP_FRACTION = 0.0005;

export interface TopFractionResult {
  stats: WhaleTradeStat[];
  target: number;
  truncated: boolean;
  effectiveFraction: number;
  resolvedThreshold: number | null;
}

export function markerMagnitude(marker: MarkerFrame): number {
  return (marker.provider === "DXFEED" || marker.provider === "DATABENTO") && marker.assetClass === "FUTURE"
    ? marker.size
    : marker.price * marker.size;
}

export function computeWhaleTradeStats(
  markers: readonly MarkerFrame[],
  nowMs: number = Date.now(),
): WhaleTradeStat[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("computeWhaleTradeStats: nowMs must be a non-negative safe integer");
  }
  const stats: WhaleTradeStat[] = [];
  for (const marker of markers) {
    if (marker.ts_exchange > nowMs) continue;
    const magnitude = markerMagnitude(marker);
    if (!Number.isFinite(magnitude) || magnitude <= 0) continue;
    stats.push({ marker, magnitude });
  }
  return stats;
}

export function filterWhaleTradesBySize(
  stats: readonly WhaleTradeStat[],
  minMagnitude: number,
  maxMagnitude: number | null = null,
): WhaleTradeStat[] {
  if (!Number.isFinite(minMagnitude) || minMagnitude <= 0) {
    throw new Error("filterWhaleTradesBySize: minMagnitude must be a positive finite number");
  }
  if (maxMagnitude !== null && (!Number.isFinite(maxMagnitude) || maxMagnitude < minMagnitude)) {
    throw new Error("filterWhaleTradesBySize: maxMagnitude must be a finite number no smaller than minMagnitude");
  }
  return stats.filter((stat) =>
    stat.magnitude >= minMagnitude && (maxMagnitude === null || stat.magnitude <= maxMagnitude));
}

export function filterWhaleTradesByTopFraction(
  stats: readonly WhaleTradeStat[],
  totalTradeCount: number,
  fraction: number,
): TopFractionResult {
  if (!Number.isSafeInteger(totalTradeCount) || totalTradeCount < 0) {
    throw new Error("filterWhaleTradesByTopFraction: totalTradeCount must be a non-negative safe integer");
  }
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("filterWhaleTradesByTopFraction: fraction must be a finite number in (0, 1]");
  }
  const target = totalTradeCount === 0 ? 0 : Math.max(1, Math.ceil(totalTradeCount * fraction));
  const ranked = [...stats].sort((left, right) =>
    right.magnitude - left.magnitude ||
    right.marker.ts_exchange - left.marker.ts_exchange ||
    (right.marker.trade_id < left.marker.trade_id ? -1 : 1));
  const kept = ranked.slice(0, Math.min(target, ranked.length));
  kept.sort((left, right) =>
    left.marker.ts_exchange - right.marker.ts_exchange ||
    (left.marker.trade_id < right.marker.trade_id ? -1 : 1));
  return {
    stats: kept,
    target,
    truncated: kept.length < target,
    effectiveFraction: totalTradeCount === 0 ? 0 : kept.length / totalTradeCount,
    resolvedThreshold: kept.length === 0 ? null : ranked[kept.length - 1].magnitude,
  };
}

export interface WhaleSelectionSource {
  size(): number;
  topByMagnitude(limit: number): { stats: WhaleTradeStat[]; resolvedThreshold: number | null };
  atLeastMagnitude(minMagnitude: number, maxMagnitude?: number | null): WhaleTradeStat[];
}

export function selectWhaleTradesBySize(
  source: WhaleSelectionSource,
  minMagnitude: number,
  maxMagnitude: number | null = null,
): WhaleTradeStat[] {
  if (!Number.isFinite(minMagnitude) || minMagnitude <= 0) {
    throw new Error("selectWhaleTradesBySize: minMagnitude must be a positive finite number");
  }
  if (maxMagnitude !== null && (!Number.isFinite(maxMagnitude) || maxMagnitude < minMagnitude)) {
    throw new Error("selectWhaleTradesBySize: maxMagnitude must be a finite number no smaller than minMagnitude");
  }
  return source.atLeastMagnitude(minMagnitude, maxMagnitude);
}

export function selectWhaleTradesByTopFraction(
  source: WhaleSelectionSource,
  totalTradeCount: number,
  fraction: number,
): TopFractionResult {
  if (!Number.isSafeInteger(totalTradeCount) || totalTradeCount < 0) {
    throw new Error("selectWhaleTradesByTopFraction: totalTradeCount must be a non-negative safe integer");
  }
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("selectWhaleTradesByTopFraction: fraction must be a finite number in (0, 1]");
  }
  const target = totalTradeCount === 0 ? 0 : Math.max(1, Math.ceil(totalTradeCount * fraction));
  const { stats, resolvedThreshold } = source.topByMagnitude(Math.min(target, source.size()));
  return {
    stats,
    target,
    truncated: stats.length < target,
    effectiveFraction: totalTradeCount === 0 ? 0 : stats.length / totalTradeCount,
    resolvedThreshold,
  };
}
