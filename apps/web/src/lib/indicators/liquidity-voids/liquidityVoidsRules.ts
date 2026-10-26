import marketInstrumentCatalog from "../../../../../../config/market-instruments.json";
import type { FrameIdentity } from "../../../types/frames";
import { instrumentKey } from "../../chart/drawingStore";
import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import { defaultAggressiveOrdersSettingsFor } from "../aggressive-orders/aggressiveOrdersSettings";
import { DEFAULT_SWEEP_RULES, type SweepRules } from "./sweepModel";

export type VoidSource = "sweep" | "walls" | "both";
export type Identity = { symbol: string } & FrameIdentity;

export type LevelsBy = "nearest" | "furthest";
export type Sensitivity = "low" | "normal" | "high";
export type ThresholdRule = "fixed" | "learned";
export type ThresholdKey = "thresholdsIndex" | "thresholdsOther";

export interface LiquidityVoidsSettings {
  source: VoidSource;
  windowS: number;
  sensitivity: Sensitivity;
  thresholdsIndex: ThresholdRule;
  thresholdsOther: ThresholdRule;
  maxTradedByInstrument: Record<string, number>;
  levelsBy: LevelsBy;
  boxesPerSide: number;
  historyHours: number;
  askColor: string;
  bidColor: string;
}

export const DEFAULT_LIQUIDITY_VOIDS_SETTINGS: LiquidityVoidsSettings = {
  source: "sweep",
  windowS: 30,
  sensitivity: "normal",
  thresholdsIndex: "learned",
  thresholdsOther: "fixed",
  maxTradedByInstrument: {},
  levelsBy: "nearest",
  boxesPerSide: 3,
  historyHours: 48,
  askColor: "#2dd4bf",
  bidColor: "#fb7185",
};

export const MAX_VOID_SLOTS = 16;
export const MAX_HISTORY_HOURS = 168;

export function historyHoursOf(settings: Pick<LiquidityVoidsSettings, "historyHours"> | undefined): number {
  const hours = settings?.historyHours;
  return typeof hours === "number" && Number.isFinite(hours) && hours >= 0 ? Math.min(MAX_HISTORY_HOURS, hours) : DEFAULT_LIQUIDITY_VOIDS_SETTINGS.historyHours;
}
export const EQUITY_MIN_MOVE_BP = 2;
export const MAX_TRADED_BUBBLES = 3;
export const MIN_MOVE_ROWS = 2;
export const SENSITIVITY_LEVELS: Readonly<Record<Sensitivity, number>> = Object.freeze({ low: 70, normal: 50, high: 30 });
export const SENSITIVITY_BASE = 30;
export const LEARNED_K: Readonly<Record<Sensitivity, number>> = Object.freeze({ high: 1, normal: 1.25, low: 1.5 });
export const WARMUP_WINDOWS = 120;
export const EQUITY_WARMUP_FACTOR = 4;

export const INDEX_MAX_TRADED: Readonly<Record<string, number>> = Object.freeze({ "/NQ": 100, "/MNQ": 100, "/ES": 300, "/MES": 300 });

function indexRootOf(identity: Identity): string | null {
  const root = isIndexProvider(identity.provider) ? futuresRoot(identity.symbol) : null;
  return root !== null && root in INDEX_MAX_TRADED ? root : null;
}

export function isIndexFuture(identity: Identity): boolean {
  return indexRootOf(identity) !== null;
}

export function thresholdKeyFor(identity: Identity): ThresholdKey {
  return isIndexFuture(identity) ? "thresholdsIndex" : "thresholdsOther";
}

export function thresholdRuleFor(settings: Partial<Pick<LiquidityVoidsSettings, ThresholdKey>> | undefined, identity: Identity): ThresholdRule {
  const key = thresholdKeyFor(identity);
  const chosen = settings?.[key];
  return chosen === "learned" || chosen === "fixed" ? chosen : DEFAULT_LIQUIDITY_VOIDS_SETTINGS[key];
}

export function isMaxTradedByInstrument(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
}

export function learnedMaxTradedOf(settings: Partial<Pick<LiquidityVoidsSettings, "maxTradedByInstrument">>, identity: Identity, intervalMs: number): number {
  const chosen = settings.maxTradedByInstrument?.[instrumentKey(identity)];
  return (chosen !== undefined && chosen > 0 ? chosen : maxTradedFor(identity)) * timeframeFactor(intervalMs);
}

export const MAX_TRADED_SLIDER_FLOOR = 100;

export function maxTradedSliderRange(fallback: number): { min: number; max: number; step: number } {
  const max = Math.max(10 * fallback, MAX_TRADED_SLIDER_FLOOR);
  const step = max >= 1_000 ? 1 : 0.5;
  return { min: step, max, step };
}

export function learnedKOf(settings: Pick<LiquidityVoidsSettings, "sensitivity">): number {
  return LEARNED_K[settings.sensitivity] ?? LEARNED_K.normal;
}

export function warmupMsFor(identity: Identity, windowMs: number): number {
  return WARMUP_WINDOWS * windowMs * (isIndexProvider(identity.provider) && identity.assetClass === "EQUITY" ? EQUITY_WARMUP_FACTOR : 1);
}

export function minMoveFor(identity: Identity, price: number): number {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return Math.max(0.01, Math.round(price * EQUITY_MIN_MOVE_BP) / 10_000);
    const root = futuresRoot(identity.symbol);
    if (root === "/NQ" || root === "/MNQ") return 22;
    if (root === "/ES" || root === "/MES") return 6;
    const tick = tickSizeFor(identity);
    const move = Math.max(0.01, Math.round(price * EQUITY_MIN_MOVE_BP) / 10_000);
    return tick === null ? move : Math.max(1, Math.round(move / tick));
  }
  const base = identity.symbol.split("-")[0];
  if (base === "BTC") return 30;
  if (base === "ETH") return 1;
  return Math.max(0.01, Math.round(price * EQUITY_MIN_MOVE_BP) / 10_000);
}

export const TIMEFRAME_FACTOR_PER_DOUBLING = 0.3;

export function timeframeFactor(intervalMs: number): number {
  const minutes = intervalMs / 60_000;
  if (!(minutes > 1)) return 1;
  return Math.round((1 + TIMEFRAME_FACTOR_PER_DOUBLING * Math.log2(minutes)) * 10) / 10;
}

export function minMoveOf(settings: Pick<LiquidityVoidsSettings, "sensitivity">, identity: Identity, price: number, intervalMs: number): number {
  const level = SENSITIVITY_LEVELS[settings.sensitivity] ?? SENSITIVITY_LEVELS.normal;
  const width = (minMoveFor(identity, price) * level) / SENSITIVITY_BASE;
  const unit = isIndexProvider(identity.provider) && identity.assetClass === "FUTURE" ? (tickSizeFor(identity) ?? 1) : 1;
  return width * unit * timeframeFactor(intervalMs);
}

export function maxTradedFor(identity: Identity): number {
  const root = indexRootOf(identity);
  return root !== null ? INDEX_MAX_TRADED[root] : bubbleSizeFor(identity) * MAX_TRADED_BUBBLES;
}

export function maxTradedOf(identity: Identity, intervalMs: number): number {
  return maxTradedFor(identity) * timeframeFactor(intervalMs);
}

export function tickSizeFor(identity: Identity): number | null {
  if (identity.provider === "BINANCE") return null;
  if (identity.provider === "DATABENTO") return identity.assetClass === "EQUITY" ? 0.01 : 0.25;
  const entry = marketInstrumentCatalog.dxfeed.find((candidate) => candidate.symbol === identity.symbol);
  return entry !== undefined && Number.isFinite(entry.tickSize) && entry.tickSize > 0 ? entry.tickSize : null;
}

export function priceUnitFor(identity: Identity): "$" | "pts" {
  return isIndexProvider(identity.provider) && identity.assetClass === "FUTURE" ? "pts" : "$";
}

export function bubbleSizeFor(identity: Identity): number {
  return defaultAggressiveOrdersSettingsFor(identity).minVolume;
}

export function sweepRulesFor(settings: LiquidityVoidsSettings, minMove: number, rowWidth: number): SweepRules {
  return {
    ...DEFAULT_SWEEP_RULES,
    windowMs: Math.max(1_000, Math.round(settings.windowS * 1_000)),
    minMoveRows: Math.max(MIN_MOVE_ROWS, Math.round(minMove / rowWidth)),
  };
}

export function isVoidSource(value: unknown): value is VoidSource {
  return value === "sweep" || value === "walls" || value === "both";
}
