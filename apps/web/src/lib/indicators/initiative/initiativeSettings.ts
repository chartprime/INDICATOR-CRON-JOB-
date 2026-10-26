import type { InitiativeBand, InitiativeDominant, InitiativeSide } from "../../../types/frames";
import { pushersOf } from "./initiativeWords";
import { LIQUIDITY_HISTORY_OPTIONS, historyDaysOf, type LiquidityHistoryDays } from "../passive-liquidity/liquiditySettings";
import { EXHAUSTION_CANDLE_LENGTHS, exhaustionCandleMsOf } from "../exhaustion/exhaustionSettings";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export interface InitiativeSettings {
  opacity: number;
  buyerColor?: string;
  sellerColor?: string;
  historyDays?: number;
  minScore?: number;
  minLegAtr?: number;
  showShade?: boolean;
  showLabels?: boolean;
}

export const MAX_SCORE = 5;
export const SCORE_RANGE: readonly [number, number] = [0, MAX_SCORE];
export const DEFAULT_MIN_SCORE = 4;
export const MIN_LEG_ATR_RANGE: readonly [number, number] = [3, 10];
export const DEFAULT_MIN_LEG_ATR = 7.5;
export const DEFAULT_BUYER_COLOR = "#22c55e";
export const DEFAULT_SELLER_COLOR = "#ef4444";

function within(value: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}

export function initiativeMinScoreOf(settings: Pick<InitiativeSettings, "minScore"> | undefined): number {
  return Math.round(within(settings?.minScore, SCORE_RANGE, DEFAULT_MIN_SCORE));
}

export function initiativeMinLegAtrOf(settings: Pick<InitiativeSettings, "minLegAtr"> | undefined): number {
  return Math.round(within(settings?.minLegAtr, MIN_LEG_ATR_RANGE, DEFAULT_MIN_LEG_ATR) * 2) / 2;
}

export function legReachAtr(band: Pick<InitiativeBand, "pivotPrice" | "legExtremePrice" | "atr">): number {
  return Math.abs(band.legExtremePrice - band.pivotPrice) / band.atr;
}

export type InitiativeHistoryDays = 0 | LiquidityHistoryDays;

export const INITIATIVE_HISTORY_OPTIONS: readonly (readonly [InitiativeHistoryDays, string])[] = Object.freeze([[0, "Off"], ...LIQUIDITY_HISTORY_OPTIONS]);

export const DEFAULT_INITIATIVE_HISTORY_DAYS: LiquidityHistoryDays = 1;

export const INITIATIVE_CANDLE_LENGTHS: readonly number[] = EXHAUSTION_CANDLE_LENGTHS;

const DAY_MS = 86_400_000;

export const DEFAULT_INITIATIVE_SETTINGS: InitiativeSettings = {
  opacity: 0.6,
  buyerColor: DEFAULT_BUYER_COLOR,
  sellerColor: DEFAULT_SELLER_COLOR,
  historyDays: DEFAULT_INITIATIVE_HISTORY_DAYS,
  minScore: DEFAULT_MIN_SCORE,
  minLegAtr: DEFAULT_MIN_LEG_ATR,
  showShade: true,
  showLabels: true,
};

export const INITIATIVE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<InitiativeSettings>[] = [
  { kind: "slider", key: "minScore", label: "Minimum score", min: SCORE_RANGE[0], max: SCORE_RANGE[1], step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "minLegAtr", label: "Minimum leg size", min: MIN_LEG_ATR_RANGE[0], max: MIN_LEG_ATR_RANGE[1], step: 0.5, clampOnRestore: true, affects: "recompute" },
  { kind: "select", key: "historyDays", label: "History", options: INITIATIVE_HISTORY_OPTIONS.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "boolean", key: "showShade", label: "Show shade", affects: "cosmetic" },
  { kind: "boolean", key: "showLabels", label: "Show chip", affects: "cosmetic" },
  { kind: "color", key: "buyerColor", label: "Buyers colour", affects: "cosmetic" },
  { kind: "color", key: "sellerColor", label: "Sellers colour", affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.15, max: 1, step: 0.05, clampOnRestore: true, affects: "cosmetic" },
];

export function initiativeHistoryDaysOf(settings: Pick<InitiativeSettings, "historyDays"> | undefined): InitiativeHistoryDays {
  if (settings?.historyDays === 0) return 0;
  return historyDaysOf({ historyDays: settings?.historyDays ?? DEFAULT_INITIATIVE_HISTORY_DAYS });
}

export function initiativeColorOf(settings: Pick<InitiativeSettings, "buyerColor" | "sellerColor"> | undefined, dominant: InitiativeDominant): string {
  const chosen = dominant === "buyers" ? settings?.buyerColor : settings?.sellerColor;
  if (typeof chosen === "string" && chosen.length > 0) return chosen;
  return dominant === "buyers" ? DEFAULT_BUYER_COLOR : DEFAULT_SELLER_COLOR;
}

export function initiativeSideColorOf(settings: Pick<InitiativeSettings, "buyerColor" | "sellerColor"> | undefined, side: InitiativeSide): string {
  return initiativeColorOf(settings, pushersOf(side));
}

export function initiativeOpacityOf(settings: Pick<InitiativeSettings, "opacity"> | undefined): number {
  const opacity = settings?.opacity;
  return typeof opacity === "number" && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : DEFAULT_INITIATIVE_SETTINGS.opacity;
}

export const initiativeCandleMsOf = exhaustionCandleMsOf;

export function shownBands(bands: readonly InitiativeBand[], settings: InitiativeSettings, candleMs: number | null, nowMs: number): InitiativeBand[] {
  const days = initiativeHistoryDaysOf(settings);
  const from = nowMs - days * DAY_MS;
  const minScore = initiativeMinScoreOf(settings);
  const minLegAtr = initiativeMinLegAtrOf(settings);
  return bands.filter((band) => band.candleMs === candleMs && (days === 0 ? band.origin === "runtime" : band.frozenTs >= from) && band.score >= minScore && legReachAtr(band) >= minLegAtr);
}
