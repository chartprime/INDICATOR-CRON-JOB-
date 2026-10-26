import { DEFAULT_LIQUIDITY_SETTINGS, clusterRowsFor, type LiquiditySettings } from "../passive-liquidity/liquiditySettings";
import { MAX_WIDTH_SHARE, MIN_WIDTH_SHARE } from "../live-delta-profile/liveDeltaProfileSettings";
import { RESTING_MULTIPLE, RESTING_STAND_MS } from "./restingOrders";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export interface LiveOrderBookProfileSettings {
  rowFactor: number;
  widthShare: number;
  showNumbers: boolean;
  bidColor: string;
  askColor: string;
  spreadColor: string;
  opacity: number;
  showResting: boolean;
  restingMinSize: number;
  restingStandS: number;
  restingShare: number;
}

export const DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS: LiveOrderBookProfileSettings = {
  rowFactor: 0,
  widthShare: 0.12,
  showNumbers: true,
  bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  spreadColor: "#c98a1b",
  opacity: 1,
  showResting: true,
  restingMinSize: 0,
  restingStandS: RESTING_STAND_MS / 1_000,
  restingShare: 0.2,
};

export const RESTING_SIZE_SPAN = 12;
export const MIN_RESTING_STAND_S = 3;
export const MAX_RESTING_STAND_S = 120;
export const MIN_RESTING_SHARE = 0.01;
export const MAX_RESTING_SHARE = 0.5;

export function restingSizeRange(typicalSize: number): { max: number; step: number } {
  if (!(typicalSize > 0)) return { max: 100, step: 1 };
  const wanted = Math.max(10, RESTING_SIZE_SPAN * typicalSize);
  const power = 10 ** Math.floor(Math.log10(wanted));
  const max = [1, 2, 5, 10].map((unit) => unit * power).find((candidate) => candidate >= wanted) ?? wanted;
  return { max, step: max >= 1_000 ? 10 : 1 };
}

export function autoMinSize(typicalSize: number): number {
  return Math.round(RESTING_MULTIPLE * typicalSize);
}

export const ROW_FACTOR_CHOICES: readonly number[] = [0, 1, 2, 4, 8, 16, 32];

export const LIVE_ORDER_BOOK_PROFILE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<LiveOrderBookProfileSettings>[] = [
  { kind: "select", key: "rowFactor", label: "Row size", options: ROW_FACTOR_CHOICES.map((value) => ({ value, label: String(value) })), affects: "recompute" },
  { kind: "slider", key: "widthShare", label: "Profile width", min: MIN_WIDTH_SHARE, max: MAX_WIDTH_SHARE, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "boolean", key: "showNumbers", label: "Show sizes", affects: "cosmetic" },
  { kind: "boolean", key: "showResting", label: "Bigger order S/R zones", affects: "recompute" },
  { kind: "numeric", key: "restingMinSize", label: "Min size", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "slider", key: "restingStandS", label: "Show after", min: MIN_RESTING_STAND_S, max: MAX_RESTING_STAND_S, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "restingShare", label: "Bar length", min: MIN_RESTING_SHARE, max: MAX_RESTING_SHARE, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
  { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
  { kind: "color", key: "spreadColor", label: "Spread colour", affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.2, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
];

export function clusterRowsOf(settings: Pick<LiveOrderBookProfileSettings, "rowFactor">, heatmap: Pick<LiquiditySettings, "clusterRows">, intervalMs: number): number {
  return settings.rowFactor > 0 ? Math.floor(settings.rowFactor) : clusterRowsFor(heatmap, intervalMs);
}
