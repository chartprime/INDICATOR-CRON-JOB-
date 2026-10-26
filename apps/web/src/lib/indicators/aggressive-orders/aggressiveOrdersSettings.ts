import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import type { FrameIdentity } from "../../../types/frames";
import type { ClusterRules, OrderCluster } from "./aggressiveTape";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export interface AggressiveOrdersSettings {
  minVolume: number;
  sizeReference: number;
  clusterWidth: number;
  clusterGapMs: number;
  clusterMaxMs: number;
  bubbleScale: number;
  opacity: number;
  showBuyers: boolean;
  showSellers: boolean;
}

export const DEFAULT_AGGRESSIVE_ORDERS_SETTINGS: AggressiveOrdersSettings = {
  minVolume: 0,
  sizeReference: 0,
  clusterWidth: 0,
  clusterGapMs: 3_000,
  clusterMaxMs: 10_000,
  bubbleScale: 1,
  opacity: 0.9,
  showBuyers: true,
  showSellers: true,
};

export const AGGRESSIVE_ORDERS_SETTINGS_SCHEMA: readonly SettingsFieldSchema<AggressiveOrdersSettings>[] = [
  { kind: "numeric", key: "minVolume", label: "Show orders larger than", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "numeric", key: "sizeReference", label: "Size reference", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "numeric", key: "clusterWidth", label: "Grouping width", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "numeric", key: "clusterGapMs", label: "Grouping gap", min: 0, max: 600_000, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "clusterMaxMs", label: "Grouping span", min: 0, max: 600_000, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "bubbleScale", label: "Bubble size", min: 0.5, max: 2.5, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.2, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "boolean", key: "showBuyers", label: "Show buyers", affects: "cosmetic" },
  { kind: "boolean", key: "showSellers", label: "Show sellers", affects: "cosmetic" },
];

export function suggestedMinVolumeFor(identity: { symbol: string } & FrameIdentity): number {
  const symbol = identity.symbol ?? "";
  if (isIndexProvider(identity.provider)) {
    if (futuresRoot(symbol) === "/ES") return 10;
    if (futuresRoot(symbol) === "/NQ") return 5;
    if (symbol === "AAPL") return 500;
    if (symbol === "TSLA") return 500;
    if (symbol === "NVDA") return 1000;
    return identity.assetClass === "EQUITY" ? 500 : 0;
  }
  const base = symbol.split("-")[0];
  const perpetual = identity.marketKind === "PERPETUAL";
  if (base === "BTC") return perpetual ? 1 : 0.1;
  if (base === "ETH") return perpetual ? 20 : 4;
  return 0;
}

export type Grouping = "off" | "tight" | "normal" | "wide";
export const GROUPINGS: readonly Grouping[] = ["off", "tight", "normal", "wide"];

export interface GroupingStep {
  size: number;
  unit: "tick" | "cent" | "dollar";
}

export function groupingStepFor(identity: { symbol: string } & FrameIdentity): GroupingStep | null {
  const symbol = identity.symbol ?? "";
  if (isIndexProvider(identity.provider)) return identity.assetClass === "EQUITY" ? { size: 0.01, unit: "cent" } : { size: 0.25, unit: "tick" };
  const base = symbol.split("-")[0];
  if (base === "BTC") return { size: 0.5, unit: "dollar" };
  if (base === "ETH") return { size: 0.05, unit: "dollar" };
  return null;
}

export function groupingWidthsFor(identity: { symbol: string } & FrameIdentity): Record<Grouping, number> {
  const step = groupingStepFor(identity)?.size ?? 0;
  return { off: 0, tight: step, normal: step * 2, wide: step * 4 };
}

export function groupingOf(width: number, identity: { symbol: string } & FrameIdentity): Grouping | "custom" {
  const widths = groupingWidthsFor(identity);
  for (const grouping of GROUPINGS) if (Math.abs(widths[grouping] - width) < 1e-9) return grouping;
  return "custom";
}

export function describeGrouping(
  grouping: Grouping | "custom",
  width: number,
  identity: { symbol: string } & FrameIdentity,
  settings: Pick<AggressiveOrdersSettings, "clusterGapMs" | "clusterMaxMs">,
  bucketMs = 0,
): string {
  if (grouping === "off" || width <= 0) return "Every order is its own bubble. An order that sweeps several levels at once is still one bubble.";
  const step = groupingStepFor(identity);
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`.replace(".0 s", " s");
  let distance: string;
  if (step === null) distance = `${width}`;
  else if (step.unit === "dollar") distance = "$" + width.toFixed(2);
  else {
    const steps = Math.round((width / step.size) * 100) / 100;
    const word = step.unit === "tick" ? (steps === 1 ? "tick" : "ticks") : (steps === 1 ? "cent" : "cents");
    distance = step.unit === "tick" ? `${steps} ${word} (${width.toFixed(2)})` : `${steps} ${word}`;
  }
  if (bucketMs > 0) return `Each candle owns its bubbles: same-side orders within ${distance} of each other in one candle become one bubble, drawn on that candle, buyers to the right and sellers to the left.`;
  return `Same-side orders within ${distance} and ${seconds(settings.clusterGapMs)} of each other become one bubble. A bubble lives at most ${seconds(settings.clusterMaxMs)}.`;
}

export function suggestedClusterWidthFor(identity: { symbol: string } & FrameIdentity): number {
  return groupingWidthsFor(identity).normal;
}

export function defaultAggressiveOrdersSettingsFor(identity: { symbol: string } & FrameIdentity): AggressiveOrdersSettings {
  const shared = { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, sizeReference: suggestedMinVolumeFor(identity), clusterWidth: suggestedClusterWidthFor(identity) };
  if (isIndexProvider(identity.provider) && futuresRoot(identity.symbol) === "/NQ") return { ...shared, minVolume: suggestedMinVolumeFor(identity) };
  if (isIndexProvider(identity.provider) && futuresRoot(identity.symbol) === "/ES") return { ...shared, minVolume: 20, clusterWidth: groupingWidthsFor(identity).wide, bubbleScale: 0.8 };
  if (identity.provider === "BINANCE" && identity.marketKind === "PERPETUAL" && identity.symbol.startsWith("BTC")) return { ...shared, minVolume: 10, bubbleScale: 0.8 };
  if (identity.provider === "BINANCE" && identity.marketKind === "SPOT" && identity.symbol.startsWith("BTC")) return { ...shared, minVolume: 2, bubbleScale: 0.6 };
  if (identity.provider === "BINANCE" && identity.marketKind === "SPOT" && identity.symbol.startsWith("ETH")) return { ...shared, minVolume: 10, bubbleScale: 0.5 };
  if (identity.provider === "BINANCE" && identity.marketKind === "PERPETUAL" && identity.symbol.startsWith("ETH")) return { ...shared, minVolume: 40, bubbleScale: 0.8 };
  if (isIndexProvider(identity.provider) && identity.symbol === "AAPL") return { ...shared, minVolume: 1_000, bubbleScale: 0.6 };
  if (isIndexProvider(identity.provider) && identity.symbol === "TSLA") return { ...shared, minVolume: 2_000, bubbleScale: 0.7 };
  return shared;
}

export function clusterRulesFor(settings: AggressiveOrdersSettings): ClusterRules {
  return {
    minVolume: Math.max(0, settings.minVolume),
    width: Math.max(0, settings.clusterWidth),
    gapMs: Math.max(0, settings.clusterGapMs),
    maxMs: Math.max(0, settings.clusterMaxMs),
    bucketMs: 0,
  };
}

export const BASE_INTERVAL_MS = 60_000;
export const MAX_CLUSTER_GAP_MS = 60_000;
export const MAX_CLUSTER_LIFE_MS = 300_000;
export const LINK_TO_CANDLE_FROM_MS = 15 * 60_000;
export const MAX_WIDTH_MULTIPLIER = 4;
export const MAX_AGGRESSIVE_INTERVAL_MS = 4 * 60 * 60_000;

export function linksToCandles(intervalMs: number): boolean {
  return Number.isFinite(intervalMs) && intervalMs >= LINK_TO_CANDLE_FROM_MS;
}

export function isAggressiveTimeframeSupported(intervalMs: number): boolean {
  return Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= MAX_AGGRESSIVE_INTERVAL_MS;
}

export function widthMultiplierFor(intervalMs: number): number {
  const candles = Number.isFinite(intervalMs) && intervalMs > BASE_INTERVAL_MS ? intervalMs / BASE_INTERVAL_MS : 1;
  return Math.min(MAX_WIDTH_MULTIPLIER, Math.sqrt(candles));
}

export function scaledClusterRules(
  settings: AggressiveOrdersSettings,
  { intervalMs = BASE_INTERVAL_MS, step = 0 }: { intervalMs?: number; step?: number } = {},
): ClusterRules {
  const base = clusterRulesFor(settings);
  const candles = Number.isFinite(intervalMs) && intervalMs > BASE_INTERVAL_MS ? intervalMs / BASE_INTERVAL_MS : 1;
  const widened = base.width * widthMultiplierFor(intervalMs);
  const width = base.width <= 0 ? 0 : step > 0 ? Math.max(step, Math.round(widened / step) * step) : widened;
  if (linksToCandles(intervalMs)) {
    return { minVolume: base.minVolume, width, gapMs: intervalMs, maxMs: intervalMs, bucketMs: intervalMs };
  }
  return {
    minVolume: base.minVolume,
    width,
    gapMs: Math.min(MAX_CLUSTER_GAP_MS, base.gapMs * candles),
    maxMs: Math.min(MAX_CLUSTER_LIFE_MS, base.maxMs * candles),
    bucketMs: 0,
  };
}

export function sizeReferenceFor(settings: AggressiveOrdersSettings, autoFloor: number): number {
  return settings.sizeReference > 0 ? settings.sizeReference : autoFloor;
}

export const BUBBLE_MIN_RADIUS_PX = 4;
export const BUBBLE_MAX_RADIUS_PX = 30;

export function bubbleRadius(size: number, reference: number, scale: number = 1): number {
  const multiples = reference > 0 ? size / reference : 1;
  const radius = multiples > 0 ? BUBBLE_MIN_RADIUS_PX * Math.sqrt(multiples) : BUBBLE_MIN_RADIUS_PX;
  const clamped = Math.min(BUBBLE_MAX_RADIUS_PX, Math.max(BUBBLE_MIN_RADIUS_PX, radius));
  return clamped * Math.max(0.1, scale);
}

export function visibleOrders(orders: readonly OrderCluster[], settings: AggressiveOrdersSettings): OrderCluster[] {
  return orders.filter((order) => (order.side === "buy" ? settings.showBuyers : settings.showSellers));
}
