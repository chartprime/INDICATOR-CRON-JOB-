import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { FrameIdentity } from "../../../types/frames";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../passive-liquidity/liquiditySettings";

export type LiveRangeMode = "visible" | "selected" | "live";
export type CardSize = "small" | "medium" | "large";
export type VerdictSensitivity = "high" | "normal" | "strict";
export type RowKey = "volume" | "delta" | "prints" | "minutes" | "impact";

export interface LiveRangeSettings {
  rangeMode: LiveRangeMode;
  bigPrint: number;
  verdictSensitivity: VerdictSensitivity;
  zoneColor: string;
  zoneOpacity: number;
  bidColor: string;
  askColor: string;
  cardSize: CardSize;
  showZone: boolean;
  showVolumeRow: boolean;
  showDeltaRow: boolean;
  showPrintsRow: boolean;
  showMinutesRow: boolean;
  showImpactRow: boolean;
  showTips: boolean;
}

type RowSetting = "showVolumeRow" | "showDeltaRow" | "showPrintsRow" | "showMinutesRow" | "showImpactRow";

export interface PrintScale {
  min: number;
  max: number;
  step: number;
  fallback: number;
}

export const LIVE_RANGE_MODES: readonly (readonly [LiveRangeMode, string])[] = Object.freeze([["visible", "Visible range"], ["selected", "Selected zone"], ["live", "Live"]]);
export const CARD_SIZES: readonly (readonly [CardSize, string])[] = Object.freeze([["small", "Small"], ["medium", "Medium"], ["large", "Large"]]);
export const VERDICT_SENSITIVITIES: readonly (readonly [VerdictSensitivity, string])[] = Object.freeze([["high", "High"], ["normal", "Normal"], ["strict", "Strict"]]);
export const VERDICT_Z_FROM: Readonly<Record<VerdictSensitivity, number>> = Object.freeze({ high: 0, normal: 1, strict: 2 });
export const ROW_SETTINGS: readonly (readonly [RowKey, RowSetting, string])[] = Object.freeze([
  ["volume", "showVolumeRow", "Traded volume"],
  ["delta", "showDeltaRow", "Delta"],
  ["prints", "showPrintsRow", "Big prints"],
  ["minutes", "showMinutesRow", "Minutes won"],
  ["impact", "showImpactRow", "Price impact"],
]);
const ROW_SETTING_OF = Object.freeze(Object.fromEntries(ROW_SETTINGS.map(([row, key]) => [row, key])) as Record<RowKey, RowSetting>);
export const DEFAULT_ZONE_COLOR = "#2962ff";
export const DEFAULT_ZONE_OPACITY = 10;
export const ZONE_OPACITY_MIN = 1;
export const ZONE_OPACITY_MAX = 50;
export const CRYPTO_PRINT_SCALE: PrintScale = Object.freeze({ min: 0.5, max: 50, step: 0.5, fallback: 5 });
export const FUTURES_PRINT_SCALE: PrintScale = Object.freeze({ min: 1, max: 300, step: 1, fallback: 10 });
export const EQUITY_PRINT_SCALE: PrintScale = Object.freeze({ min: 100, max: 50_000, step: 100, fallback: 5_000 });

export const DEFAULT_LIVE_RANGE_SETTINGS: LiveRangeSettings = {
  rangeMode: "visible",
  bigPrint: 0,
  verdictSensitivity: "normal",
  zoneColor: DEFAULT_ZONE_COLOR,
  zoneOpacity: DEFAULT_ZONE_OPACITY,
  bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  cardSize: "medium",
  showZone: true,
  showVolumeRow: true,
  showDeltaRow: true,
  showPrintsRow: true,
  showMinutesRow: true,
  showImpactRow: true,
  showTips: true,
};

export const LIVE_RANGE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<LiveRangeSettings>[] = [
  { kind: "radioGroup", key: "rangeMode", label: "Mode", options: LIVE_RANGE_MODES.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "numeric", key: "bigPrint", label: "Big print from", min: 0, max: EQUITY_PRINT_SCALE.max, step: CRYPTO_PRINT_SCALE.step, clampOnRestore: true, affects: "recompute" },
  { kind: "radioGroup", key: "verdictSensitivity", label: "Verdict sensitivity", options: VERDICT_SENSITIVITIES.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "color", key: "zoneColor", label: "Zone colour", affects: "cosmetic" },
  { kind: "slider", key: "zoneOpacity", label: "Zone opacity", min: ZONE_OPACITY_MIN, max: ZONE_OPACITY_MAX, step: 1, affects: "cosmetic" },
  { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
  { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
  { kind: "radioGroup", key: "cardSize", label: "Monitor size", options: CARD_SIZES.map(([value, label]) => ({ value, label })), affects: "cosmetic" },
  { kind: "boolean", key: "showZone", label: "Show zone", affects: "cosmetic" },
  ...ROW_SETTINGS.map(([, key, label]): SettingsFieldSchema<LiveRangeSettings> => ({ kind: "boolean", key, label: `Show ${label}`, affects: "cosmetic" })),
  { kind: "boolean", key: "showTips", label: "Show hover tips", affects: "cosmetic" },
];

export function rangeModeOf(settings: Pick<LiveRangeSettings, "rangeMode"> | undefined): LiveRangeMode {
  const mode = settings?.rangeMode;
  return LIVE_RANGE_MODES.some(([known]) => known === mode) ? (mode as LiveRangeMode) : DEFAULT_LIVE_RANGE_SETTINGS.rangeMode;
}

export function cardSizeOf(settings: Pick<LiveRangeSettings, "cardSize"> | undefined): CardSize {
  const size = settings?.cardSize;
  return CARD_SIZES.some(([known]) => known === size) ? (size as CardSize) : DEFAULT_LIVE_RANGE_SETTINGS.cardSize;
}

export function zoneOpacityOf(settings: Pick<LiveRangeSettings, "zoneOpacity"> | undefined): number {
  const value = settings?.zoneOpacity;
  if (typeof value !== "number" || !Number.isInteger(value) || value < ZONE_OPACITY_MIN || value > ZONE_OPACITY_MAX) return DEFAULT_ZONE_OPACITY;
  return value;
}

export function zoneShownOf(settings: Pick<LiveRangeSettings, "showZone"> | undefined): boolean {
  return settings?.showZone !== false;
}

export function verdictSensitivityOf(settings: Pick<LiveRangeSettings, "verdictSensitivity"> | undefined): VerdictSensitivity {
  const value = settings?.verdictSensitivity;
  return VERDICT_SENSITIVITIES.some(([known]) => known === value) ? (value as VerdictSensitivity) : DEFAULT_LIVE_RANGE_SETTINGS.verdictSensitivity;
}

export function zFromOf(settings: Pick<LiveRangeSettings, "verdictSensitivity"> | undefined): number {
  return VERDICT_Z_FROM[verdictSensitivityOf(settings)];
}

export function rowShownOf(settings: Partial<Pick<LiveRangeSettings, RowSetting>> | undefined, row: RowKey): boolean {
  return settings?.[ROW_SETTING_OF[row]] !== false;
}

export function tipsShownOf(settings: Pick<LiveRangeSettings, "showTips"> | undefined): boolean {
  return settings?.showTips !== false;
}

export function printScaleFor(identity: Pick<FrameIdentity, "provider"> & { assetClass?: string }): PrintScale {
  if (identity.provider === "BINANCE") return CRYPTO_PRINT_SCALE;
  return identity.assetClass === "EQUITY" ? EQUITY_PRINT_SCALE : FUTURES_PRINT_SCALE;
}

export function bigPrintOf(settings: Pick<LiveRangeSettings, "bigPrint"> | undefined, scale: PrintScale): number {
  const value = settings?.bigPrint;
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) return scale.fallback;
  const bounded = Math.min(scale.max, Math.max(scale.min, value));
  return Number((Math.round(bounded / scale.step) * scale.step).toFixed(6));
}
