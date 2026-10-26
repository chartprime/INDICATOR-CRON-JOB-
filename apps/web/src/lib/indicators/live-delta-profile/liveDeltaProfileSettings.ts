import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export type ProfileWindowMode = "auto" | "week" | "day" | "session" | "rolling" | "visible";

export interface LiveDeltaProfileSettings {
  windowMode: ProfileWindowMode;
  rollingHours: number;
  rowFactor: number;
  widthShare: number;
  showNumbers: boolean;
  buyColor: string;
  sellColor: string;
  markerColor: string;
  opacity: number;
}

export const DEFAULT_LIVE_DELTA_PROFILE_SETTINGS: LiveDeltaProfileSettings = {
  windowMode: "auto",
  rollingHours: 4,
  rowFactor: 0,
  widthShare: 0.12,
  showNumbers: true,
  buyColor: "#2f7de1",
  sellColor: "#d9453b",
  markerColor: "#c98a1b",
  opacity: 0.85,
};

export const WINDOW_MODES: readonly ProfileWindowMode[] = ["auto", "week", "day", "session", "rolling", "visible"];
export const AUTO_ROLLING_MAX_INTERVAL_MS = 300_000;
export const AUTO_ROLLING_HOURS = 0.5;

/** What Auto means on a chart of this timeframe: the last half hour on 1m and 5m, the trading day above. */
export function autoWindowMode(intervalMs: number): "rolling" | "day" {
  return intervalMs <= AUTO_ROLLING_MAX_INTERVAL_MS ? "rolling" : "day";
}
export const ROLLING_STEP_HOURS = 0.5;
export const MIN_ROLLING_HOURS = 0.5;
export const MAX_ROLLING_HOURS = 24;
export const ROW_FACTOR_CHOICES: readonly number[] = [0, 1, 4, 12, 24, 40, 80, 160];
export const MIN_WIDTH_SHARE = 0.05;
export const MAX_WIDTH_SHARE = 0.6;
export const MIN_ROW_PX = 6;

export const LIVE_DELTA_PROFILE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<LiveDeltaProfileSettings>[] = [
  { kind: "select", key: "windowMode", label: "Window", options: WINDOW_MODES.map((value) => ({ value, label: value })), affects: "recompute" },
  { kind: "numeric", key: "rollingHours", label: "Last N hours", min: MIN_ROLLING_HOURS, max: MAX_ROLLING_HOURS, step: 0, clampOnRestore: true, affects: "recompute" },
  { kind: "select", key: "rowFactor", label: "Row size", options: ROW_FACTOR_CHOICES.map((value) => ({ value, label: String(value) })), affects: "recompute" },
  { kind: "slider", key: "widthShare", label: "Profile width", min: MIN_WIDTH_SHARE, max: MAX_WIDTH_SHARE, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "boolean", key: "showNumbers", label: "Show numbers", affects: "cosmetic" },
  { kind: "color", key: "buyColor", label: "Buy colour", affects: "cosmetic" },
  { kind: "color", key: "sellColor", label: "Sell colour", affects: "cosmetic" },
  { kind: "color", key: "markerColor", label: "Marker colour", affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.2, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
];

const AUTO_ROW_FACTOR_STEPS: readonly (readonly [number, number])[] = [
  [86_400_000, 400],
  [14_400_000, 120],
  [3_600_000, 40],
  [900_000, 12],
  [300_000, 4],
];

/** The rolling window's length in whole half hours, inside its bounds. */
export function rollingHoursOf(settings: Pick<LiveDeltaProfileSettings, "rollingHours">): number {
  const steps = Math.round(settings.rollingHours / ROLLING_STEP_HOURS);
  return Math.min(MAX_ROLLING_HOURS, Math.max(MIN_ROLLING_HOURS, steps * ROLLING_STEP_HOURS));
}

/** Base rows per drawn row for a chart interval: $1 on the 1m BTC chart, $4 on 5m, $12 on 15m and so on. */
export function autoRowFactorFor(intervalMs: number): number {
  for (const [atLeastMs, factor] of AUTO_ROW_FACTOR_STEPS) if (intervalMs >= atLeastMs) return factor;
  return 1;
}

export function rowFactorFor(settings: Pick<LiveDeltaProfileSettings, "rowFactor">, intervalMs: number): number {
  return settings.rowFactor > 0 ? Math.floor(settings.rowFactor) : autoRowFactorFor(intervalMs);
}

/** The factor the chart draws at: the timeframe's, merged further while a drawn row would be under MIN_ROW_PX tall. */
export function drawnRowFactor(factor: number, baseRowPx: number, minRowPx: number = MIN_ROW_PX): number {
  if (!(baseRowPx > 0)) return factor;
  return factor * Math.max(1, Math.ceil(minRowPx / (baseRowPx * factor)));
}
