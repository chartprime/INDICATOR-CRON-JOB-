import type { FrameIdentity } from "../../../types/frames";
import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import { instrumentKey } from "../../chart/drawingStore";
import { minSizeFor, strongSizeFor, type Side } from "../institutional-order-blocks-v2/institutionalV2Rules";
import { cellMsFor } from "../passive-liquidity/liquidityCells";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_HISTORY_OPTIONS, bandFactorFor, clusterRowsFor, historyDaysOf, liquidityReference, minBandSizeFor, type LiquidityHistoryDays, type LiquiditySettings } from "../passive-liquidity/liquiditySettings";
import { liquidityStyleFor } from "../passive-liquidity/liquidityStyle";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export const FLASH_WALL_MS = 180_000;

export type AbsorptionShape = "circle" | "triangle" | "square";

export const ABSORPTION_SHAPE_OPTIONS: readonly (readonly [AbsorptionShape, string])[] = Object.freeze([["circle", "Circle"], ["triangle", "Triangle"], ["square", "Square"]]);

export interface AbsorptionSettings {
  opacity: number;
  bubbleScale?: number;

  bidColor?: string;
  askColor?: string;

  /** Spheres whose wall broke later are drawn hollow; off hides them. */
  showBroken?: boolean;

  /** What has to trade into the wall, as a percentage of what it held when the attack began, for a sphere. */
  absorbedPercent?: number;

  /** The percentage of the wall at which the sphere becomes the strong ring. */
  strongPercent?: number;

  /** What has to trade into the wall, as a multiple of the book's typical level, for a sphere. */
  absorbedMultiple?: number;

  historyDays?: number;

  shape?: AbsorptionShape;
}

export type AbsorptionHistoryDays = 0 | LiquidityHistoryDays;

export const ABSORPTION_HISTORY_OPTIONS: readonly (readonly [AbsorptionHistoryDays, string])[] = Object.freeze([[0, "Off"], ...LIQUIDITY_HISTORY_OPTIONS]);

export const DEFAULT_HISTORY_DAYS: LiquidityHistoryDays = 1;
export const DEFAULT_ABSORPTION_SHAPE: AbsorptionShape = "circle";

export interface SettingSlider {
  min: number;
  max: number;
  step: number;
}

// The rule's three numbers, measured on NQ host data 2026-10-07 (typical level about 8 contracts a band, heatmap
// sensitivity 20): 200% and 40x print about 0.3 an hour on a quiet 5m stretch and 3 an hour on a busy 1m session.
export const DEFAULT_ABSORBED_PERCENT = 200;
export const DEFAULT_STRONG_PERCENT = 300;
export const DEFAULT_ABSORBED_MULTIPLE = 40;
export const ABSORBED_PERCENT_SLIDER: SettingSlider = Object.freeze({ min: 50, max: 500, step: 10 });
export const STRONG_PERCENT_SLIDER: SettingSlider = Object.freeze({ min: 150, max: 1000, step: 10 });
export const ABSORBED_MULTIPLE_SLIDER: SettingSlider = Object.freeze({ min: 3, max: 200, step: 1 });

/** Where an attack is recorded: the sliders' lowest numbers, so every setting above them reads the records without the host. */
export const RECORD_PERCENT = ABSORBED_PERCENT_SLIDER.min;
export const RECORD_MULTIPLE = ABSORBED_MULTIPLE_SLIDER.min;

function sliderSteps(slider: SettingSlider): readonly number[] {
  return Object.freeze(Array.from({ length: Math.round((slider.max - slider.min) / slider.step) + 1 }, (_, i) => slider.min + i * slider.step));
}

export const ASKED_PERCENTS = sliderSteps(ABSORBED_PERCENT_SLIDER);
export const ASKED_MULTIPLES = sliderSteps(ABSORBED_MULTIPLE_SLIDER);

export const DEFAULT_ABSORPTION_SETTINGS: AbsorptionSettings = {
  opacity: 0.7,
  bubbleScale: 0.5,
  bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  showBroken: true,
  absorbedPercent: DEFAULT_ABSORBED_PERCENT,
  strongPercent: DEFAULT_STRONG_PERCENT,
  absorbedMultiple: DEFAULT_ABSORBED_MULTIPLE,
  historyDays: DEFAULT_HISTORY_DAYS,
  shape: DEFAULT_ABSORPTION_SHAPE,
};

export const ABSORPTION_SETTINGS_SCHEMA: readonly SettingsFieldSchema<AbsorptionSettings>[] = [
  { kind: "slider", key: "absorbedPercent", label: "Absorbed share", min: ABSORBED_PERCENT_SLIDER.min, max: ABSORBED_PERCENT_SLIDER.max, step: ABSORBED_PERCENT_SLIDER.step, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "strongPercent", label: "Strong share", min: STRONG_PERCENT_SLIDER.min, max: STRONG_PERCENT_SLIDER.max, step: STRONG_PERCENT_SLIDER.step, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "absorbedMultiple", label: "Minimum absorbed", min: ABSORBED_MULTIPLE_SLIDER.min, max: ABSORBED_MULTIPLE_SLIDER.max, step: ABSORBED_MULTIPLE_SLIDER.step, clampOnRestore: true, affects: "recompute" },
  { kind: "boolean", key: "showBroken", label: "Show broken levels", affects: "cosmetic" },
  { kind: "select", key: "historyDays", label: "History", options: ABSORPTION_HISTORY_OPTIONS.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "select", key: "shape", label: "Shape", options: ABSORPTION_SHAPE_OPTIONS.map(([value, label]) => ({ value, label })), affects: "cosmetic" },
  { kind: "slider", key: "bubbleScale", label: "Sphere size", min: 0.5, max: 2.5, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.15, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
  { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
];

export function absorptionShapeOf(settings: Pick<AbsorptionSettings, "shape"> | undefined): AbsorptionShape {
  const shape = settings?.shape;
  return ABSORPTION_SHAPE_OPTIONS.some(([known]) => known === shape) ? (shape as AbsorptionShape) : DEFAULT_ABSORPTION_SHAPE;
}

/** How far behind the live book the spheres are read: off, or one of the heatmap's reaches; anything else saved reads as one day. */
export function absorptionHistoryDaysOf(settings: Pick<AbsorptionSettings, "historyDays"> | undefined): AbsorptionHistoryDays {
  if (settings?.historyDays === 0) return 0;
  return historyDaysOf({ historyDays: settings?.historyDays ?? DEFAULT_HISTORY_DAYS });
}

export function absorptionHistoryDaysFromHours(hours: number): AbsorptionHistoryDays {
  if (hours === 0) return 0;
  if (!(hours > 0)) return DEFAULT_HISTORY_DAYS;
  let nearest = LIQUIDITY_HISTORY_OPTIONS[0][0];
  for (const [days] of LIQUIDITY_HISTORY_OPTIONS) if (Math.abs(days * 24 - hours) < Math.abs(nearest * 24 - hours)) nearest = days;
  return nearest;
}

export function absorptionColorOf(settings: AbsorptionSettings, side: "bid" | "ask"): string {
  const chosen = side === "bid" ? settings.bidColor : settings.askColor;
  return typeof chosen === "string" && chosen.length > 0 ? chosen : side === "bid" ? DEFAULT_LIQUIDITY_SETTINGS.bidColor : DEFAULT_LIQUIDITY_SETTINGS.askColor;
}

export function absorptionBubbleScaleOf(settings: AbsorptionSettings): number {
  return Number.isFinite(settings.bubbleScale) && (settings.bubbleScale as number) > 0 ? (settings.bubbleScale as number) : 1;
}

/** A saved number held to its slider, at its nearest step; missing or nonsense reads as the default. */
function sliderValueOf(value: number | undefined, fallback: number, slider: SettingSlider): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(slider.max, Math.max(slider.min, slider.min + Math.round((value - slider.min) / slider.step) * slider.step));
}

export function absorbedPercentOf(settings: Pick<AbsorptionSettings, "absorbedPercent"> | undefined): number {
  return sliderValueOf(settings?.absorbedPercent, DEFAULT_ABSORBED_PERCENT, ABSORBED_PERCENT_SLIDER);
}

/** Never under the absorbed share: the strong ring is a further share of the wall. */
export function strongPercentOf(settings: Pick<AbsorptionSettings, "absorbedPercent" | "strongPercent"> | undefined): number {
  return Math.max(absorbedPercentOf(settings), sliderValueOf(settings?.strongPercent, DEFAULT_STRONG_PERCENT, STRONG_PERCENT_SLIDER));
}

export function absorbedMultipleOf(settings: Pick<AbsorptionSettings, "absorbedMultiple"> | undefined): number {
  return sliderValueOf(settings?.absorbedMultiple, DEFAULT_ABSORBED_MULTIPLE, ABSORBED_MULTIPLE_SLIDER);
}

export interface AbsorptionRules {

  instrument: string;

  /** The heatmap's band: its cluster rows on this chart. */
  bandRows: number;

  /** The heatmap settings the wall floor is made of, as a string, so two rules with the same key read the same walls. */
  wallKey: string;

  /** The size a band of this column must hold to be a wall: the heatmap's own paint floor, `reference` standing in for a column without a level of its own. */
  wallFloor: (column: LiquidityColumn, reference: number) => number;

  /** A band's size read the market's way: summed rows on crypto, the biggest row on an index. */
  bandSize: (column: LiquidityColumn, side: Side, band: number) => number;
  /** The least an attacked wall is measured as: what the heatmap paints as a whole wall on this book (never under the floor). */
  wallSize: (column: LiquidityColumn, reference: number) => number;

  absorbedPercent: number;

  strongPercent: number;

  absorbedMultiple: number;

  /** Where an attack is recorded: the sliders' lowest share of the wall and multiple of the level, so every setting reads the records. */
  recordPercent: number;

  recordMultiple: number;

  askedPercents: readonly number[];

  askedMultiples: readonly number[];

  quietMs: number;
  /** How long after the sphere a bar closing through its wall still breaks it: three bars, three minutes at least, an hour at most. */
  breakWindowMs: number;
}

export const ABSORPTION_QUIET_MS = 120_000;

export const ABSORPTION_BREAK_BARS = 3;
export const ABSORPTION_BREAK_MIN_MS = 3 * 60_000;
export const ABSORPTION_BREAK_MAX_MS = 60 * 60_000;

/** The heatmap settings that make the wall floor, and nothing else, so a colour change is not a new rule. */
export function wallKeyOf(styleName: string, clusterRows: number, minBandSize: number, settings: Pick<LiquiditySettings, "scaleMode" | "scaleSize" | "heatFloor">): string {
  return JSON.stringify([styleName, clusterRows, minBandSize, settings.scaleMode, settings.scaleSize, settings.heatFloor]);
}

export function absorptionRulesFor(identity: { symbol: string } & FrameIdentity, settings?: Pick<AbsorptionSettings, "absorbedPercent" | "strongPercent" | "absorbedMultiple">, intervalMs = 60_000, liquidity?: LiquiditySettings): AbsorptionRules {
  const factor = bandFactorFor(intervalMs);
  const style = liquidityStyleFor(identity.provider, identity.symbol, identity.marketKind);
  const heatmap = liquidity ?? style.defaultSettings;
  const clusterRows = clusterRowsFor(heatmap, intervalMs);
  const minBandSize = minBandSizeFor(heatmap, style.market, intervalMs);
  const contextOf = (column: LiquidityColumn, reference: number) => {
    const level = column.reference !== undefined && column.reference > 0 ? column.reference : reference;
    return { settings: heatmap, clusterRows, ladderMax: 0, reference: liquidityReference(heatmap, { referenceSize: level }) };
  };
  const wallFloor = (column: LiquidityColumn, reference: number) => Math.max(minBandSize, style.paintFloor(column, contextOf(column, reference)));
  return {
    instrument: factor > 1 ? `${instrumentKey(identity)}@x${factor}` : instrumentKey(identity),
    bandRows: clusterRows,
    wallKey: wallKeyOf(style.name, clusterRows, minBandSize, heatmap),
    wallFloor,
    bandSize: (column, side, band) => style.bandSizes(column, band, clusterRows)[side],
    wallSize: (column, reference) => Math.max(wallFloor(column, reference), style.wallSize(column, contextOf(column, reference))),
    absorbedPercent: absorbedPercentOf(settings),
    strongPercent: strongPercentOf(settings),
    absorbedMultiple: absorbedMultipleOf(settings),
    recordPercent: RECORD_PERCENT,
    recordMultiple: RECORD_MULTIPLE,
    askedPercents: ASKED_PERCENTS,
    askedMultiples: ASKED_MULTIPLES,
    quietMs: Math.max(ABSORPTION_QUIET_MS, cellMsFor(intervalMs)),
    breakWindowMs: Math.min(ABSORPTION_BREAK_MAX_MS, Math.max(ABSORPTION_BREAK_BARS * intervalMs, ABSORPTION_BREAK_MIN_MS)),
  };
}

// Session Levels' "absorbed" verdict still reads the floor and share the spheres were judged by until 2026-10-07: a
// number per chart from the second order-blocks indicator's tables, twice the wall on a thin book, a quarter on crypto.

export const CRYPTO_SHARES: readonly number[] = Object.freeze([0.25, 0.6]);

export const THIN_BOOK_SHARES: readonly number[] = Object.freeze([2, 3]);

const NVDA_FLOOR = 5000;
const BTC_PERP_FLOOR = 75;
const NQ_FLOOR = 75;
const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const CRYPTO_QUICK_FLOORS: Record<string, readonly [number, number]> = {
  "PERPETUAL:ETH": [5000, 10_000],
  "SPOT:ETH": [500, 500],
  "PERPETUAL:BTC": [100, 150],
  "SPOT:BTC": [30, 30],
};
const CRYPTO_TIER_FLOORS: Record<string, Readonly<Record<string, number>>> = {
  "PERPETUAL:BTC": { x3: 325 },
};

export function absorptionTierOf(intervalMs: number): string {
  if (intervalMs < FIVE_MINUTES_MS) return "1m";
  if (intervalMs < FIFTEEN_MINUTES_MS) return "5m";
  return `x${bandFactorFor(intervalMs)}`;
}

export function absorptionFloorFor(identity: { symbol: string } & FrameIdentity, intervalMs = 60_000): number {
  const factor = bandFactorFor(intervalMs);
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return (identity.symbol === "NVDA" ? NVDA_FLOOR : minSizeFor(identity)) * factor;
    return (futuresRoot(identity.symbol) === "/NQ" ? NQ_FLOOR : strongSizeFor(identity)) * factor;
  }
  const base = identity.symbol.split("-")[0];
  const tiered = CRYPTO_TIER_FLOORS[`${identity.marketKind}:${base}`]?.[absorptionTierOf(intervalMs)];
  if (tiered !== undefined) return tiered;
  const quick = CRYPTO_QUICK_FLOORS[`${identity.marketKind}:${base}`];
  if (quick !== undefined && intervalMs < FIFTEEN_MINUTES_MS) return intervalMs < FIVE_MINUTES_MS ? quick[0] : quick[1];
  const scaled = (base === "BTC" && identity.marketKind === "PERPETUAL" ? BTC_PERP_FLOOR : minSizeFor(identity)) * factor;
  return quick === undefined ? scaled : Math.max(scaled, quick[1]);
}

export function absorptionSharesFor(identity: FrameIdentity): readonly number[] {
  return isIndexProvider(identity.provider) ? THIN_BOOK_SHARES : CRYPTO_SHARES;
}

const SHARE_WORDS: Record<string, string> = { "0.25": "a quarter", "0.6": "sixty percent", "1": "all", "2": "twice", "3": "three times" };

export function shareWords(share: number): string {
  return SHARE_WORDS[String(share)] ?? (share >= 1 ? `${share} times` : `${Math.round(share * 100)} percent`);
}

export function shareOfWall(share: number): string {
  return share >= 1 ? `${shareWords(share)} the wall` : `${shareWords(share)} of the wall`;
}
