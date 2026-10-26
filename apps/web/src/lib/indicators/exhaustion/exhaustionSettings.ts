import type { ExhaustionShade, ExhaustionSide } from "../../../types/frames";
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_HISTORY_OPTIONS, historyDaysLabel, historyDaysOf, type LiquidityHistoryDays } from "../passive-liquidity/liquiditySettings";
import { DEFAULT_LEG_SETTINGS, type LegSettings } from "./legCatcher";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export interface ExhaustionSettings {
  opacity: number;
  buyerColor?: string;
  sellerColor?: string;
  showBroken?: boolean;
  historyDays?: number;
  showLegs?: boolean;
  hideNestedLegs?: boolean;
  showMonitor?: boolean;
  legAtr?: number;
  legReverseAtr?: number;
  legEfficiency?: number;
  minScore?: number;
  zoneScale?: number;
  zonesOnly?: boolean;
}

export const LEG_ATR_RANGE: readonly [number, number] = [2, 40];
export const LEG_REVERSE_RANGE: readonly [number, number] = [1, 10];
export const LEG_EFFICIENCY_RANGE: readonly [number, number] = [0.2, 0.95];
export const SCORE_RANGE: readonly [number, number] = [3, 6];
export const DEFAULT_MIN_SCORE = 5;
export const ZONE_SCALE_RANGE: readonly [number, number] = [1, 5];
export const DEFAULT_ZONE_SCALE = 2;
export const ZONE_SHARE = 0.2;

function within(value: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}

export function legSettingsOf(settings: Pick<ExhaustionSettings, "legAtr" | "legReverseAtr" | "legEfficiency"> | undefined): LegSettings {
  return {
    atrPeriod: DEFAULT_LEG_SETTINGS.atrPeriod,
    atrMultiple: within(settings?.legAtr, LEG_ATR_RANGE, DEFAULT_LEG_SETTINGS.atrMultiple),
    reverseAtr: within(settings?.legReverseAtr, LEG_REVERSE_RANGE, DEFAULT_LEG_SETTINGS.reverseAtr),
    minEfficiency: within(settings?.legEfficiency, LEG_EFFICIENCY_RANGE, DEFAULT_LEG_SETTINGS.minEfficiency),
  };
}

export function exhaustionCalibrated(settings: ExhaustionSettings | undefined): boolean {
  const legs = legSettingsOf(settings);
  return legs.atrMultiple === DEFAULT_LEG_SETTINGS.atrMultiple && legs.minEfficiency === DEFAULT_LEG_SETTINGS.minEfficiency;
}

export function exhaustionMinScoreOf(settings: Pick<ExhaustionSettings, "minScore"> | undefined): number {
  return Math.round(within(settings?.minScore, SCORE_RANGE, DEFAULT_MIN_SCORE));
}

export function exhaustionZoneScaleOf(settings: Pick<ExhaustionSettings, "zoneScale"> | undefined): number {
  return within(settings?.zoneScale, ZONE_SCALE_RANGE, DEFAULT_ZONE_SCALE);
}

export function zoneHeightOf(shade: Pick<ExhaustionShade, "legSize">, zoneScale: number): number {
  return Math.min(shade.legSize, shade.legSize * ZONE_SHARE * zoneScale);
}

export type ExhaustionHistoryDays = 0 | LiquidityHistoryDays;

export const EXHAUSTION_HISTORY_OPTIONS: readonly (readonly [ExhaustionHistoryDays, string])[] = Object.freeze([[0, "Off"], ...LIQUIDITY_HISTORY_OPTIONS]);

export const DEFAULT_EXHAUSTION_HISTORY_DAYS: LiquidityHistoryDays = 1;

export const EXHAUSTION_CANDLE_LENGTHS: readonly number[] = Object.freeze([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);

const DAY_MS = 86_400_000;

export const DEFAULT_EXHAUSTION_SETTINGS: ExhaustionSettings = {
  opacity: 0.6,
  buyerColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  sellerColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  showBroken: true,
  historyDays: DEFAULT_EXHAUSTION_HISTORY_DAYS,
  showLegs: false,
  hideNestedLegs: false,
  showMonitor: true,
  legAtr: DEFAULT_LEG_SETTINGS.atrMultiple,
  legReverseAtr: DEFAULT_LEG_SETTINGS.reverseAtr,
  legEfficiency: DEFAULT_LEG_SETTINGS.minEfficiency,
  minScore: DEFAULT_MIN_SCORE,
  zoneScale: DEFAULT_ZONE_SCALE,
  zonesOnly: false,
};

export const EXHAUSTION_SETTINGS_SCHEMA: readonly SettingsFieldSchema<ExhaustionSettings>[] = [
  { kind: "slider", key: "legAtr", label: "Leg size in ATR", min: LEG_ATR_RANGE[0], max: LEG_ATR_RANGE[1], step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "legReverseAtr", label: "Leg reversal in ATR", min: LEG_REVERSE_RANGE[0], max: LEG_REVERSE_RANGE[1], step: 0.5, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "legEfficiency", label: "Leg straightness", min: LEG_EFFICIENCY_RANGE[0], max: LEG_EFFICIENCY_RANGE[1], step: 0.05, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "minScore", label: "Confidence score", min: SCORE_RANGE[0], max: SCORE_RANGE[1], step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "zoneScale", label: "Exhaustion area size", min: ZONE_SCALE_RANGE[0], max: ZONE_SCALE_RANGE[1], step: 0.5, clampOnRestore: true, affects: "cosmetic" },
  { kind: "boolean", key: "zonesOnly", label: "Show exhaustion areas only", affects: "cosmetic" },
  { kind: "boolean", key: "showLegs", label: "Show legs", affects: "cosmetic" },
  { kind: "boolean", key: "hideNestedLegs", label: "Hide nested legs", affects: "cosmetic" },
  { kind: "boolean", key: "showBroken", label: "Show broken", affects: "cosmetic" },
  { kind: "boolean", key: "showMonitor", label: "Show monitor", affects: "cosmetic" },
  { kind: "select", key: "historyDays", label: "History", options: EXHAUSTION_HISTORY_OPTIONS.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "color", key: "buyerColor", label: "Buyers exhausted", affects: "cosmetic" },
  { kind: "color", key: "sellerColor", label: "Sellers exhausted", affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.15, max: 1, step: 0.05, clampOnRestore: true, affects: "cosmetic" },
];

export function exhaustionHistoryDaysOf(settings: Pick<ExhaustionSettings, "historyDays"> | undefined): ExhaustionHistoryDays {
  if (settings?.historyDays === 0) return 0;
  return historyDaysOf({ historyDays: settings?.historyDays ?? DEFAULT_EXHAUSTION_HISTORY_DAYS });
}

export function exhaustionColorOf(settings: Pick<ExhaustionSettings, "buyerColor" | "sellerColor"> | undefined, side: ExhaustionSide): string {
  const chosen = side === "buyers" ? settings?.buyerColor : settings?.sellerColor;
  if (typeof chosen === "string" && chosen.length > 0) return chosen;
  return side === "buyers" ? DEFAULT_LIQUIDITY_SETTINGS.askColor : DEFAULT_LIQUIDITY_SETTINGS.bidColor;
}

export function exhaustionOpacityOf(settings: Pick<ExhaustionSettings, "opacity"> | undefined): number {
  const opacity = settings?.opacity;
  return typeof opacity === "number" && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : DEFAULT_EXHAUSTION_SETTINGS.opacity;
}

export const EQUITY_LONGEST_CANDLE_MS = 1_800_000;

export function exhaustionCandleMsOf(intervalMs: number, assetClass?: string): number | null {
  if (assetClass === "EQUITY" && intervalMs > EQUITY_LONGEST_CANDLE_MS) return null;
  return EXHAUSTION_CANDLE_LENGTHS.includes(intervalMs) ? intervalMs : null;
}

export function shownShades(shades: readonly ExhaustionShade[], settings: ExhaustionSettings, candleMs: number | null, nowMs: number): ExhaustionShade[] {
  if (candleMs === null) return [];
  const days = exhaustionHistoryDaysOf(settings);
  const from = nowMs - days * DAY_MS;
  const showBroken = settings.showBroken !== false;
  const legs = legSettingsOf(settings);
  const minScore = exhaustionMinScoreOf(settings);
  const shown = shades.filter((shade) => shade.candleMs === candleMs && (showBroken || shade.status !== "broke") && (days === 0 ? shade.origin === "runtime" : shade.endTs >= from) && shade.legSize / shade.atr >= legs.atrMultiple && shade.efficiency >= legs.minEfficiency && shade.score >= minScore);
  return settings.hideNestedLegs === true ? withoutNestedShades(shown) : shown;
}

function priceSpan(shade: ExhaustionShade): [number, number] {
  return shade.legStartPrice <= shade.extremePrice ? [shade.legStartPrice, shade.extremePrice] : [shade.extremePrice, shade.legStartPrice];
}

function nestedIn(inner: ExhaustionShade, outer: ExhaustionShade): boolean {
  if (outer === inner) return false;
  if (outer.legStartTs > inner.legStartTs || outer.endTs < inner.endTs) return false;
  const [innerLow, innerHigh] = priceSpan(inner);
  const [outerLow, outerHigh] = priceSpan(outer);
  if (outerLow > innerLow || outerHigh < innerHigh) return false;
  return outer.legSize > inner.legSize || (outer.legSize === inner.legSize && (outer.startTs > inner.startTs || (outer.startTs === inner.startTs && outer.id > inner.id)));
}

function outerFirst(a: ExhaustionShade, b: ExhaustionShade): number {
  return a.legStartTs - b.legStartTs || b.endTs - a.endTs || b.legSize - a.legSize || b.startTs - a.startTs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function withoutNestedShades(shades: readonly ExhaustionShade[]): ExhaustionShade[] {
  const sides = new Map<ExhaustionSide, ExhaustionShade[]>();
  for (const shade of shades) {
    const side = sides.get(shade.side);
    if (side === undefined) sides.set(shade.side, [shade]);
    else side.push(shade);
  }
  const nested = new Set<ExhaustionShade>();
  for (const side of sides.values()) {
    side.sort(outerFirst);
    let widestEnd = -Infinity;
    for (let i = 0; i < side.length; i += 1) {
      const inner = side[i];
      if (widestEnd >= inner.endTs) {
        for (let j = i - 1; j >= 0; j -= 1) {
          if (nestedIn(inner, side[j])) {
            nested.add(inner);
            break;
          }
        }
      }
      if (inner.endTs > widestEnd) widestEnd = inner.endTs;
    }
  }
  return shades.filter((shade) => !nested.has(shade));
}

export function exhaustionLoadingLabel(loading: number | null, at: number): string | null {
  if (loading === null) return null;
  const days = Math.max(1, Math.round((at - loading) / DAY_MS));
  return LIQUIDITY_HISTORY_OPTIONS.some(([option]) => option === days) ? historyDaysLabel(days as LiquidityHistoryDays) : `${days} days`;
}

export function exhaustionLiveSinceText(from: number | null): string {
  if (from === null) return "";
  const at = new Date(from);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}
