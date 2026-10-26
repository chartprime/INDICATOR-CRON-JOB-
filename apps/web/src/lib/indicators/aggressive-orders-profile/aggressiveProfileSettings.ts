import type { FrameIdentity } from "../../../types/frames";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../passive-liquidity/liquiditySettings";

export type ProfileView = "delta" | "sides";

export const PROFILE_VIEWS: readonly { value: ProfileView; label: string }[] = [
  { value: "delta", label: "Net delta" },
  { value: "sides", label: "Buys and sells" },
];

export interface AggressiveProfileSettings {
  floor: number;
  profileView: ProfileView;
  outlierFrom: number;
  buyColor: string;
  sellColor: string;
}

export interface AggressiveProfileReaderSettings {
  floor: number;
}

export const MAX_OUTLIER_FROM = 5;
export const OUTLIER_STEP = 0.5;

export const DEFAULT_AGGRESSIVE_PROFILE_SETTINGS: AggressiveProfileSettings = {
  floor: 0,
  profileView: "delta",
  outlierFrom: 2,
  buyColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  sellColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
};

export const AGGRESSIVE_PROFILE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<AggressiveProfileSettings>[] = [
  { kind: "numeric", key: "floor", label: "Big print floor", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "select", key: "profileView", label: "Show as", options: PROFILE_VIEWS, affects: "cosmetic" },
  { kind: "slider", key: "outlierFrom", label: "Highlight bars over", min: 0, max: MAX_OUTLIER_FROM, step: OUTLIER_STEP, clampOnRestore: true, affects: "cosmetic" },
  { kind: "color", key: "buyColor", label: "Buys colour", affects: "cosmetic" },
  { kind: "color", key: "sellColor", label: "Sells colour", affects: "cosmetic" },
];

export const FLOOR_MANTISSAS: readonly number[] = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
export const FLOOR_DECADES = 3;
export const FALLBACK_FLOOR_SPAN = 100;
export const FALLBACK_FLOOR_MAX = 100;
export const FLOOR_TOP_REACH = 10;

export interface FloorScale {
  max: number;
  whole: boolean;
}

function niceAtLeast(wanted: number): number {
  const power = 10 ** Math.floor(Math.log10(wanted));
  return [1, 2, 5, 10].map((unit) => Number((unit * power).toPrecision(12))).find((candidate) => candidate >= wanted) ?? wanted;
}

function fallbackFloorMax(autoFloor: number): number {
  if (!(autoFloor > 0) || !Number.isFinite(autoFloor)) return FALLBACK_FLOOR_MAX;
  return niceAtLeast(FALLBACK_FLOOR_SPAN * autoFloor);
}

function topAbove(top: number, autoFloor: number): number {
  return autoFloor >= top ? niceAtLeast(FLOOR_TOP_REACH * autoFloor) : top;
}

export function floorScaleFor(instrument: ({ symbol: string } & FrameIdentity) | null, autoFloor: number): FloorScale {
  if (instrument !== null && isIndexProvider(instrument.provider)) {
    const root = futuresRoot(instrument.symbol);
    if (root === "/NQ") return { max: topAbove(100, autoFloor), whole: true };
    if (root === "/ES") return { max: topAbove(300, autoFloor), whole: true };
    if (instrument.assetClass === "EQUITY") return { max: topAbove(2_000, autoFloor), whole: true };
    return { max: fallbackFloorMax(autoFloor), whole: true };
  }
  const base = instrument?.symbol.split("-")[0];
  if (base === "BTC") return { max: topAbove(50, autoFloor), whole: false };
  if (base === "ETH") return { max: topAbove(1_000, autoFloor), whole: false };
  return { max: fallbackFloorMax(autoFloor), whole: false };
}

export function floorStops({ max, whole }: FloorScale, above = 0): number[] {
  const low = whole ? 1 : max / 10 ** FLOOR_DECADES;
  const stops: number[] = [];
  for (let power = Math.floor(Math.log10(low)); 10 ** power < max; power += 1) {
    for (const mantissa of FLOOR_MANTISSAS) {
      const stop = Number((mantissa * 10 ** power).toPrecision(6));
      if (stop >= low && stop > above && stop < max && (!whole || Number.isInteger(stop))) stops.push(stop);
    }
  }
  if (max > above) stops.push(max);
  return stops;
}

export function floorPosition(stops: readonly number[], floor: number): number {
  if (!(floor > 0) || stops.length === 0) return 0;
  let nearest = 0;
  for (let i = 1; i < stops.length; i += 1) {
    if (Math.abs(Math.log(stops[i] / floor)) < Math.abs(Math.log(stops[nearest] / floor))) nearest = i;
  }
  return nearest + 1;
}

export function floorAt(stops: readonly number[], position: number): number {
  if (!(position >= 1)) return 0;
  return stops[Math.min(stops.length, Math.round(position)) - 1] ?? 0;
}

export function readerSettingsOf(settings: AggressiveProfileSettings): AggressiveProfileReaderSettings {
  return { floor: settings.floor };
}

function shortText(value: number, unit: string): string {
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`;
}

export function sizeText(size: number): string {
  if (!(size > 0)) return "0";
  const whole = Math.round(size);
  if (whole === 0) return "<1";
  if (whole < 1_000) return String(whole);
  if (Math.round(size / 1_000) < 1_000) return shortText(size / 1_000, "k");
  return shortText(size / 1_000_000, "M");
}

export function floorNumberText(floor: number): string {
  return floor >= 10 ? sizeText(floor) : String(Math.round(floor * 100) / 100);
}

export function outlierText(outlierFrom: number): string {
  if (!(outlierFrom > 0)) return "Highlight bars off";
  return `Highlight bars over ${Math.round(outlierFrom * 10) / 10}× the average`;
}
