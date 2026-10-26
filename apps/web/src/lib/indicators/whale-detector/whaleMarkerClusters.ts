import type { WhaleTradeStat } from "./whaleTrades";
import type { Side } from "../../../types/frames";

export interface WhaleMarkerCluster {
  ts: number;
  side: Side;
  price: number;
  magnitude: number;
  sizeTokens: number;
  count: number;
  stats: readonly WhaleTradeStat[];
  netted: boolean;
}

export type WhaleClusterMode = "delta" | "buySell";

export function latestTradeTsForCluster(cluster: WhaleMarkerCluster): number {
  return Math.max(...cluster.stats.map((stat) => stat.marker.ts_exchange));
}

export function displaySizeForCluster(cluster: WhaleMarkerCluster): number {
  const marker = cluster.stats[0]?.marker;
  return marker?.provider === "DXFEED" && marker.assetClass === "FUTURE" && cluster.netted
    ? cluster.magnitude
    : cluster.sizeTokens;
}

export function findClusterByIdentity(
  clusters: readonly WhaleMarkerCluster[],
  ts: number,
  side: Side,
): WhaleMarkerCluster | null {
  return clusters.find((c) => c.ts === ts && c.side === side) ?? null;
}

function buildDeltaCluster(barOpenMs: number, group: readonly WhaleTradeStat[]): WhaleMarkerCluster {
  let buyMagnitude = 0;
  let sellMagnitude = 0;
  let buyTokens = 0;
  let sellTokens = 0;
  let priceWeighted = 0;
  let grossMagnitude = 0;
  for (const stat of group) {
    if (stat.marker.side === "buy") {
      buyMagnitude += stat.magnitude;
      buyTokens += stat.marker.size;
    } else {
      sellMagnitude += stat.magnitude;
      sellTokens += stat.marker.size;
    }
    priceWeighted += stat.marker.price * stat.magnitude;
    grossMagnitude += stat.magnitude;
  }
  const side: Side = buyMagnitude - sellMagnitude >= 0 ? "buy" : "sell";
  return {
    ts: barOpenMs,
    side,
    price: priceWeighted / grossMagnitude,
    magnitude: Math.abs(buyMagnitude - sellMagnitude),
    sizeTokens: side === "buy" ? buyTokens : sellTokens,
    count: group.length,
    stats: group,
    netted: buyMagnitude > 0 && sellMagnitude > 0,
  };
}

function buildSideCluster(barOpenMs: number, side: Side, group: readonly WhaleTradeStat[]): WhaleMarkerCluster {
  let magnitude = 0;
  let sizeTokens = 0;
  let priceWeighted = 0;
  for (const stat of group) {
    magnitude += stat.magnitude;
    sizeTokens += stat.marker.size;
    priceWeighted += stat.marker.price * stat.magnitude;
  }
  return {
    ts: barOpenMs,
    side,
    price: priceWeighted / magnitude,
    magnitude,
    sizeTokens,
    count: group.length,
    stats: group,
    netted: false,
  };
}

export function clusterWhaleMarkers(
  stats: readonly WhaleTradeStat[],
  intervalMs: number,
  mode: WhaleClusterMode = "delta",
): WhaleMarkerCluster[] {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("clusterWhaleMarkers: intervalMs must be a positive safe integer");
  }
  if (mode !== "delta" && mode !== "buySell") {
    throw new Error("clusterWhaleMarkers: mode must be delta or buySell");
  }
  const groups = new Map<number, WhaleTradeStat[]>();
  for (const stat of stats) {
    const barOpenMs = Math.floor(stat.marker.ts_exchange / intervalMs) * intervalMs;
    const group = groups.get(barOpenMs);
    if (group) group.push(stat);
    else groups.set(barOpenMs, [stat]);
  }

  const clusters: WhaleMarkerCluster[] = [];
  for (const [barOpenMs, group] of groups) {
    if (mode === "buySell") {
      for (const side of ["buy", "sell"] as const) {
        const sideGroup = group.filter((s) => s.marker.side === side);
        if (sideGroup.length === 0) continue;
        clusters.push(buildSideCluster(barOpenMs, side, sideGroup));
      }
    } else {
      const cluster = buildDeltaCluster(barOpenMs, group);
      if (cluster.magnitude > 0) clusters.push(cluster);
    }
  }
  return clusters.sort((a, b) => a.ts - b.ts || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1));
}

export function deltaShareForCluster(cluster: WhaleMarkerCluster): number {
  let gross = 0;
  for (const stat of cluster.stats) gross += stat.magnitude;
  return gross === 0 ? 0 : cluster.magnitude / gross;
}
