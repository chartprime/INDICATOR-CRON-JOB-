import { fmtUsd } from "./whaleFormat";
import { WHALE_OUTCOMES, type WhaleBands, type WhaleSideFilter } from "./wallStore";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export type WhaleCutBasis = "usd" | "ratio";
export type WhaleSide = "both" | "bid" | "ask";
export type WhaleLiveView = "ladder" | "rays" | "both" | "off";

export interface WhaleSettings {
  cutPreset: number;
  cutBasis: WhaleCutBasis;
  ratioMin: number;
  fills: boolean;
  outcomeMask: number;
  sideFilter: WhaleSide;
  liveView: WhaleLiveView;
  labels: boolean;
  hours: number;
  thickness: number;
}

export const WHALE_CUT_PRESETS: readonly { readonly key: keyof WhaleBands; readonly label: string }[] = Object.freeze([
  { key: "p50", label: "median" },
  { key: "p75", label: "top 25%" },
  { key: "p90", label: "top 10%" },
  { key: "p95", label: "top 5%" },
  { key: "p99", label: "top 1%" },
]);

export const WHALE_HOURS_CHOICES: readonly number[] = Object.freeze([12, 24, 48, 168]);
export const WHALE_ALL_OUTCOMES_MASK = (1 << WHALE_OUTCOMES.length) - 1;
export const MIN_WHALE_THICKNESS = 2;
export const MAX_WHALE_THICKNESS = 8;
export const MAX_WHALE_RATIO = 1_000;

export const DEFAULT_WHALE_SETTINGS: WhaleSettings = Object.freeze({
  cutPreset: 2,
  cutBasis: "usd",
  ratioMin: 5,
  fills: true,
  outcomeMask: 0b01111,
  sideFilter: "both",
  liveView: "ladder",
  labels: true,
  hours: 48,
  thickness: 3,
});

export const WHALE_FALLBACK_BANDS: Readonly<Record<string, WhaleBands>> = Object.freeze({
  "PERPETUAL:BTCUSDT": { p50: 8_288_082, p75: 12_479_940, p90: 18_797_056, p95: 24_243_910, p99: 40_272_960 },
  "PERPETUAL:ETHUSDT": { p50: 5_060_152, p75: 7_176_197, p90: 10_536_355, p95: 13_338_662, p99: 21_055_099 },
  "SPOT:BTCUSDT": { p50: 1_626_754, p75: 2_488_920, p90: 4_406_395, p95: 6_470_281, p99: 10_279_561 },
  "SPOT:ETHUSDT": { p50: 888_449, p75: 1_453_517, p90: 2_093_987, p95: 2_536_545, p99: 3_540_281 },
});

function integerIn(value: unknown, low: number, high: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;
}

function numberIn(value: unknown, low: number, high: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

export const WHALE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<WhaleSettings>[] = [
  { kind: "select", key: "hours", label: "History", options: WHALE_HOURS_CHOICES.map((value) => ({ value, label: `${value} hours` })), affects: "recompute" },
  { kind: "select", key: "cutBasis", label: "Cut walls by", options: [{ value: "usd", label: "Dollar size" }, { value: "ratio", label: "Importance" }], affects: "recompute" },
  { kind: "numeric", key: "cutPreset", label: "Size cut", min: 0, max: WHALE_CUT_PRESETS.length - 1, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "ratioMin", label: "Importance at least", min: 1, max: MAX_WHALE_RATIO, step: 0, clampOnRestore: true, affects: "recompute" },
  { kind: "boolean", key: "fills", label: "Always show filled walls", affects: "recompute" },
  { kind: "select", key: "sideFilter", label: "Side", options: [{ value: "both", label: "Bids and asks" }, { value: "bid", label: "Bids only" }, { value: "ask", label: "Asks only" }], affects: "recompute" },
  { kind: "slider", key: "thickness", label: "Thickness", min: MIN_WHALE_THICKNESS, max: MAX_WHALE_THICKNESS, step: 1, clampOnRestore: true, affects: "cosmetic" },
  { kind: "numeric", key: "outcomeMask", label: "Outcomes shown", min: 0, max: WHALE_ALL_OUTCOMES_MASK, step: 1, affects: "cosmetic" },
  { kind: "select", key: "liveView", label: "Live book", options: [{ value: "ladder", label: "Ladder strip" }, { value: "rays", label: "Rays" }, { value: "both", label: "Ladder and rays" }, { value: "off", label: "Off" }], affects: "cosmetic" },
  { kind: "boolean", key: "labels", label: "Label live walls", affects: "cosmetic" },
];

export function normalizeWhaleSettings(value: unknown): WhaleSettings {
  const raw = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const defaults = DEFAULT_WHALE_SETTINGS;
  const hours = typeof raw.hours === "number" && WHALE_HOURS_CHOICES.includes(raw.hours) ? raw.hours : defaults.hours;
  return {
    cutPreset: integerIn(raw.cutPreset, 0, WHALE_CUT_PRESETS.length - 1, defaults.cutPreset),
    cutBasis: raw.cutBasis === "ratio" || raw.cutBasis === "usd" ? raw.cutBasis : defaults.cutBasis,
    ratioMin: numberIn(raw.ratioMin, 1, MAX_WHALE_RATIO, defaults.ratioMin),
    fills: typeof raw.fills === "boolean" ? raw.fills : defaults.fills,
    outcomeMask: integerIn(raw.outcomeMask, 0, WHALE_ALL_OUTCOMES_MASK, defaults.outcomeMask),
    sideFilter: raw.sideFilter === "bid" || raw.sideFilter === "ask" || raw.sideFilter === "both" ? raw.sideFilter : defaults.sideFilter,
    liveView: raw.liveView === "ladder" || raw.liveView === "rays" || raw.liveView === "both" || raw.liveView === "off" ? raw.liveView : defaults.liveView,
    labels: typeof raw.labels === "boolean" ? raw.labels : defaults.labels,
    hours,
    thickness: integerIn(raw.thickness, MIN_WHALE_THICKNESS, MAX_WHALE_THICKNESS, defaults.thickness),
  };
}

export function outcomesOf(mask: number): boolean[] {
  return WHALE_OUTCOMES.map((_, index) => (mask & (1 << index)) !== 0);
}

export function sideOf(setting: WhaleSide): WhaleSideFilter {
  return setting === "bid" ? 0 : setting === "ask" ? 1 : "both";
}

export function bandsFor(marketKind: string, symbol: string): WhaleBands | null {
  return WHALE_FALLBACK_BANDS[`${marketKind}:${symbol.replace("-", "")}`] ?? null;
}

export function cutUsdOf(settings: WhaleSettings, bands: WhaleBands): number {
  return bands[WHALE_CUT_PRESETS[settings.cutPreset].key];
}

export function whaleLegendDetail(settings: WhaleSettings, marketKind: string, symbol: string): string {
  const preset = WHALE_CUT_PRESETS[settings.cutPreset].label;
  const bands = bandsFor(marketKind, symbol);
  const cut = settings.cutBasis === "ratio" ? `importance ≥ ${settings.ratioMin}x` : bands === null ? preset : `${preset} · ≥ ${fmtUsd(cutUsdOf(settings, bands))}`;
  return `${cut}${settings.fills ? " + fills" : ""} · ${settings.hours} h`;
}
