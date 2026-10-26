import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { FrameIdentity } from "../../../types/frames";
import type { LevelsBy } from "../liquidity-voids/liquidityVoidsRules";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../passive-liquidity/liquiditySettings";

export interface EmptyOrderbookSettings {
  thinPctCrypto: number;
  thinPctIndex: number;
  refillPctCrypto: number;
  refillPctIndex: number;
  fixedHeight: boolean;
  heightRows: number;
  clearRows: number;
  zoneLengthMin: number;
  levelsBy: LevelsBy;
  zonesPerSide: number;
  showFlash: boolean;
  askColor: string;
  bidColor: string;
}

export const MIN_ZONE_LENGTH_MIN = 1;
export const MAX_ZONE_LENGTH_MIN = 240;
export const MAX_ZONES_PER_SIDE = 8;
export const MAX_CLEAR_ROWS = 20;
export const MAX_HEIGHT_ROWS = 20;
export const MIN_THIN_PCT = 10;
export const MAX_THIN_PCT = 100;
export const MIN_REFILL_PCT = 100;
export const MAX_REFILL_PCT = 300;
export type ThinKey = "thinPctCrypto" | "thinPctIndex";
export type RefillKey = "refillPctCrypto" | "refillPctIndex";

export const DEFAULT_EMPTY_ORDERBOOK_SETTINGS: EmptyOrderbookSettings = {
  thinPctCrypto: 50,
  thinPctIndex: 75,
  refillPctCrypto: 100,
  refillPctIndex: 100,
  fixedHeight: false,
  heightRows: 1,
  clearRows: 4,
  zoneLengthMin: 30,
  levelsBy: "nearest",
  zonesPerSide: 3,
  showFlash: true,
  askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
};

export function zoneLengthMsOf(settings: Pick<EmptyOrderbookSettings, "zoneLengthMin">): number {
  const minutes = Number.isFinite(settings.zoneLengthMin) ? settings.zoneLengthMin : DEFAULT_EMPTY_ORDERBOOK_SETTINGS.zoneLengthMin;
  return Math.min(MAX_ZONE_LENGTH_MIN, Math.max(MIN_ZONE_LENGTH_MIN, minutes)) * 60_000;
}

export function thinKeyFor(identity: Pick<FrameIdentity, "provider">): ThinKey {
  return identity.provider === "BINANCE" ? "thinPctCrypto" : "thinPctIndex";
}

export function refillKeyFor(identity: Pick<FrameIdentity, "provider">): RefillKey {
  return thinKeyFor(identity) === "thinPctCrypto" ? "refillPctCrypto" : "refillPctIndex";
}

function pctOf<K extends ThinKey | RefillKey>(settings: Pick<EmptyOrderbookSettings, K>, key: K, min: number, max: number): number {
  const pct = Number.isFinite(settings[key]) ? settings[key] : DEFAULT_EMPTY_ORDERBOOK_SETTINGS[key];
  return Math.min(max, Math.max(min, pct)) / 100;
}

export function thinShareOf(settings: Pick<EmptyOrderbookSettings, ThinKey>, identity: Pick<FrameIdentity, "provider">): number {
  return pctOf(settings, thinKeyFor(identity), MIN_THIN_PCT, MAX_THIN_PCT);
}

export function refillMultipleOf(settings: Pick<EmptyOrderbookSettings, RefillKey>, identity: Pick<FrameIdentity, "provider">): number {
  return pctOf(settings, refillKeyFor(identity), MIN_REFILL_PCT, MAX_REFILL_PCT);
}

export function heightRowsOf(settings: Pick<EmptyOrderbookSettings, "fixedHeight" | "heightRows">): number | null {
  if (settings.fixedHeight !== true) return null;
  const rows = Number.isFinite(settings.heightRows) ? Math.floor(settings.heightRows) : DEFAULT_EMPTY_ORDERBOOK_SETTINGS.heightRows;
  return Math.min(MAX_HEIGHT_ROWS, Math.max(1, rows));
}

export function clearRowsOf(settings: Pick<EmptyOrderbookSettings, "clearRows">): number {
  const rows = Number.isFinite(settings.clearRows) ? Math.floor(settings.clearRows) : DEFAULT_EMPTY_ORDERBOOK_SETTINGS.clearRows;
  return Math.min(MAX_CLEAR_ROWS, Math.max(0, rows));
}

export function zonesPerSideOf(settings: Pick<EmptyOrderbookSettings, "zonesPerSide">): number {
  const count = Number.isFinite(settings.zonesPerSide) ? Math.floor(settings.zonesPerSide) : DEFAULT_EMPTY_ORDERBOOK_SETTINGS.zonesPerSide;
  return Math.min(MAX_ZONES_PER_SIDE, Math.max(1, count));
}

export function marketFieldsFor(identity: Pick<FrameIdentity, "provider">): Partial<Record<keyof EmptyOrderbookSettings, SettingsFieldSchema<EmptyOrderbookSettings>>> {
  const hidden: readonly (ThinKey | RefillKey)[] = thinKeyFor(identity) === "thinPctCrypto" ? ["thinPctIndex", "refillPctIndex"] : ["thinPctCrypto", "refillPctCrypto"];
  const fields: Partial<Record<keyof EmptyOrderbookSettings, SettingsFieldSchema<EmptyOrderbookSettings>>> = {};
  for (const key of hidden) {
    const field = EMPTY_ORDERBOOK_SETTINGS_SCHEMA.find((candidate) => "key" in candidate && candidate.key === key);
    if (field !== undefined) fields[key] = { ...field, visibleIf: () => false };
  }
  return fields;
}

export const EMPTY_ORDERBOOK_SETTINGS_SCHEMA: readonly SettingsFieldSchema<EmptyOrderbookSettings>[] = [
  { key: "thinPctCrypto", label: "Size per Zone (%)", kind: "slider", min: MIN_THIN_PCT, max: MAX_THIN_PCT, step: 5, affects: "recompute" },
  { key: "thinPctIndex", label: "Size per Zone (%)", kind: "slider", min: MIN_THIN_PCT, max: MAX_THIN_PCT, step: 5, affects: "recompute" },
  { key: "refillPctCrypto", label: "Refill Size (%)", kind: "slider", min: MIN_REFILL_PCT, max: MAX_REFILL_PCT, step: 10, affects: "recompute" },
  { key: "refillPctIndex", label: "Refill Size (%)", kind: "slider", min: MIN_REFILL_PCT, max: MAX_REFILL_PCT, step: 10, affects: "recompute" },
  { key: "fixedHeight", label: "Fixed Zone Height", kind: "boolean", affects: "recompute" },
  { key: "heightRows", label: "Zone Height (rows)", kind: "slider", min: 1, max: MAX_HEIGHT_ROWS, step: 1, visibleIf: (settings) => settings.fixedHeight === true, affects: "recompute" },
  { key: "clearRows", label: "Rows Clear of Price", kind: "slider", min: 0, max: MAX_CLEAR_ROWS, step: 1, affects: "recompute" },
  { key: "zoneLengthMin", label: "Zone Length (min)", kind: "slider", min: MIN_ZONE_LENGTH_MIN, max: MAX_ZONE_LENGTH_MIN, step: 1, affects: "recompute" },
  {
    key: "levelsBy",
    label: "Keep the Levels",
    kind: "radioGroup",
    options: [
      { value: "nearest", label: "Nearest to Price", hint: "the zones price is trading into" },
      { value: "furthest", label: "Furthest from Price", hint: "the outer zones" },
    ],
    affects: "recompute",
  },
  { key: "zonesPerSide", label: "Zones per Side", kind: "slider", min: 1, max: MAX_ZONES_PER_SIDE, step: 1, affects: "recompute" },
  { key: "showFlash", label: "Flash Refilled Rows", kind: "boolean", affects: "recompute" },
  { key: "askColor", label: "Ask-Side Zone Color", kind: "color", tab: "visibility", affects: "recompute" },
  { key: "bidColor", label: "Bid-Side Zone Color", kind: "color", tab: "visibility", affects: "recompute" },
];
