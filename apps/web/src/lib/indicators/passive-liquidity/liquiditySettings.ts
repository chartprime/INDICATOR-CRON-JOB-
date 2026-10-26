import type { LiquidityGrid } from "./liquidityGrid";
import type { LiquidityMarket } from "./liquidityStyle";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

// User-facing settings for the Passive Liquidity heatmap. Colour scale and
// palette are decided in the browser; the server sends the same columns
// whatever the settings.

export type LiquidityScaleMode = "auto" | "fixed";
/** Which levels to draw: everything, only what is still on the book, or only what price consumed. */
export type LiquidityLevelFilter = "all" | "resting" | "consumed";

export interface LiquiditySettings {
  // Server rows in one band: summed on crypto (1 = the server's own rows, about
  // $4 on BTC), ticks per band on an index. Each market keeps its own settings,
  // so this means what it should for the instrument on screen.
  clusterRows: number;
  quietBands: number; // bands either side of price where only walls paint: the churn at the top of the book is noise (0 = off)
  // 16 bands is about $128 either side of price on BTC at the default cluster,
  // close to the 19 bp the old walls-only band used.
  minBandSize: number; // base units; liquidity under this is not painted on the chart; the ladder still shows the whole book (0 = show everything)
  levelFilter: LiquidityLevelFilter;
  showPulled: boolean; // with `all`: also draw levels that left the book without price reaching them (faint)
  bidColor: string; // resting bids
  askColor: string; // resting asks
  scaleMode: LiquidityScaleMode; // auto: follow the book's 95th percentile; fixed: `scaleSize` saturates
  scaleSize: number; // base units (e.g. BTC) that map to full brightness in fixed mode
  maxOpacity: number; // 0..1, brightness of a saturated cell
  heatFloor: number; // 0..1 share of the scale under which background liquidity is not painted
  showLadder: boolean; // the size ladder beside the price axis
  ladderReach: number; // 0..1 share of the pane width the largest ladder bar extends into the chart
  historyDays: number; // how far back the host's history is loaded behind the live tiers: one of LIQUIDITY_HISTORY_OPTIONS
  timeframeWidening: number; // share of the automatic widening on 15m and up (x3, x8, x30, x80): 1 as the chart sets it, halved per step finer, doubled per step thicker
}

export type LiquidityHistoryDays = 1 | 3 | 5 | 7;
export const LIQUIDITY_HISTORY_OPTIONS: readonly (readonly [LiquidityHistoryDays, string])[] = [[1, "1 day"], [3, "3 days"], [5, "5 days"], [7, "1 week"]];
export const DEFAULT_LIQUIDITY_HISTORY_DAYS: LiquidityHistoryDays = 1;

/** The setting as one of the offered reaches; anything else saved reads as the default. */
export function historyDaysOf(settings: Pick<LiquiditySettings, "historyDays">): LiquidityHistoryDays {
  const found = LIQUIDITY_HISTORY_OPTIONS.find(([days]) => days === settings.historyDays);
  return found === undefined ? DEFAULT_LIQUIDITY_HISTORY_DAYS : found[0];
}

/** "1 day", "1 week": the reach's name. */
export function historyDaysLabel(days: LiquidityHistoryDays): string {
  return LIQUIDITY_HISTORY_OPTIONS.find(([option]) => option === days)?.[1] ?? `${days} days`;
}

/**
 * One column width per reach, so a whole reach fits in the browser: a day
 * of one-minute columns, longer reaches at five minutes. A day at the host's
 * finest ten seconds would be some 290 MB at full rows.
 */
export function historyReachFor(days: LiquidityHistoryDays): { levelMs: number; reachMs: number } {
  return { levelMs: days <= 1 ? 60_000 : 300_000, reachMs: days * 86_400_000 };
}

export const MIN_LADDER_REACH = 0.05;
export const MAX_LADDER_REACH = 0.8;

/** The widest a level can be set on the dialog's slider, in rows (ticks on an index). */
export const MAX_LEVEL_WIDTH = 50;

/** The quiet zone's slider runs to 100 bands, or to twice the market's own default when that is more. */
export function quietZoneMaxFor(defaults: Pick<LiquiditySettings, "quietBands">): number {
  return Math.max(100, 2 * defaults.quietBands);
}

/** Round sizes within a decade: a slider of sizes steps through these, times powers of ten. */
const ROUND_SIZES = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9];
/**
 * A size slider runs from a quarter of its anchor, where the heatmap's own
 * floor starts to decide on its own, to fifty times it, where only the
 * largest walls are left.
 */
const SIZE_SLIDER_BELOW = 4;
const SIZE_SLIDER_ABOVE = 50;
/** The anchor of a share book that has not yet said how big its levels are: an equity's levels run to thousands. */
const SHARE_BOOK_ANCHOR = 1_000;
/** The anchor of any other book in the same case. */
const BOOK_ANCHOR = 10;

/**
 * What a market's size sliders are built around: its own minimum level, or,
 * for a market without one (NVDA), the book's typical row as the dialog read
 * it when it opened, or failing that a usual level for its kind of book.
 */
export function sliderAnchorFor(defaults: Pick<LiquiditySettings, "minBandSize">, typicalSize: number, unit: string): number {
  if (defaults.minBandSize > 0) return defaults.minBandSize;
  if (typicalSize > 0) return Number(typicalSize.toPrecision(1));
  return unit === "shares" ? SHARE_BOOK_ANCHOR : BOOK_ANCHOR;
}

/**
 * The sizes a size slider steps through: round numbers from a quarter of the
 * anchor to fifty times it, the anchor and the sizes given among them (the
 * span widens to take them in), whole numbers only on an index, whose books
 * count whole contracts and shares.
 */
export function sliderSizes(anchor: number, market: LiquidityMarket, include: readonly number[] = []): number[] {
  const own = [anchor, ...include.filter((size) => size > 0)];
  const lo = Math.min(anchor / SIZE_SLIDER_BELOW, ...own);
  const hi = Math.max(anchor * SIZE_SLIDER_ABOVE, ...own);
  const sizes = new Set<number>(own);
  for (let exponent = Math.floor(Math.log10(lo)); 10 ** exponent <= hi; exponent += 1) {
    for (const mantissa of ROUND_SIZES) {
      const size = Number((mantissa * 10 ** exponent).toPrecision(2));
      if (size >= lo && size <= hi) sizes.add(size);
    }
  }
  return [...sizes].filter((size) => market !== "index" || Number.isInteger(size)).sort((a, b) => a - b);
}

/** The next whole size of at most two significant digits at or above `size`: 1..99, then 100, 110 .. 990, then 1,000, 1,100 .. */
function nextTwoDigitSize(size: number): number {
  const whole = Math.max(1, Math.ceil(size));
  const step = whole < 100 ? 1 : 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.ceil(whole / step) * step;
}

/**
 * The sizes the sensitivity slider steps through. An index counts whole
 * contracts and shares, so it gets every whole size of two significant digits
 * across the slider's span, one contract at a time from 10 to 99; the anchor
 * is always among them. Crypto keeps the round sizes.
 */
export function sensitivitySizes(anchor: number, market: LiquidityMarket): number[] {
  if (market !== "index") return sliderSizes(anchor, market);
  const hi = anchor * SIZE_SLIDER_ABOVE;
  const sizes = new Set<number>([anchor]);
  for (let size = nextTwoDigitSize(anchor / SIZE_SLIDER_BELOW); size <= hi; size = nextTwoDigitSize(size + 1)) sizes.add(size);
  return [...sizes].sort((a, b) => a - b);
}

/** The sensitivity slider's stops: the sizes from the largest down, then 0, no minimum. Further right hides less. */
export function sensitivityStops(sizes: readonly number[]): number[] {
  return [...sizes].reverse().concat(0);
}

/** The index of the stop nearest a size, on a log scale; 0 picks the stop for 0, or the first stop when there is none. */
export function nearestStop(stops: readonly number[], size: number): number {
  if (!(size > 0)) return Math.max(0, stops.indexOf(0));
  let best = -1;
  let bestDistance = Infinity;
  stops.forEach((stop, index) => {
    if (!(stop > 0)) return;
    const distance = Math.abs(Math.log(stop / size));
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return Math.max(0, best);
}

export const DEFAULT_LIQUIDITY_SETTINGS: LiquiditySettings = {
  clusterRows: 2,
  quietBands: 16,
  minBandSize: 0,
  levelFilter: "all",
  showPulled: true,
  bidColor: "#0e9a66",
  askColor: "#7c3aed",
  scaleMode: "auto",
  scaleSize: 10,
  maxOpacity: 0.6,
  heatFloor: 0.4,
  showLadder: true,
  ladderReach: 0.12,
  historyDays: 1,
  timeframeWidening: 1,
};

/**
 * Inside the quiet zone a level has to reach this many times the usual paint
 * floor to be drawn: a wall, not churn. At the default heat floor that is
 * 1.6x the typical size near price, near the 1.5x the server calls a wall.
 */
export const QUIET_FLOOR_MULTIPLE = 4;

/** Which band a server row belongs to when `clusterRows` rows make one band. */
export function clusterIndex(row: number, clusterRows: number): number {
  return Math.floor(row / Math.max(1, Math.floor(clusterRows)));
}

export const BAND_FACTOR_STEPS: readonly (readonly [number, number])[] = [
  [86_400_000, 80],
  [14_400_000, 30],
  [3_600_000, 8],
  [900_000, 3],
];

export function bandFactorFor(intervalMs: number): number {
  for (const [atLeastMs, factor] of BAND_FACTOR_STEPS) if (intervalMs >= atLeastMs) return factor;
  return 1;
}

/** The higher-timeframe slider's steps either side of auto: each step left halves the widening, each step right doubles it. */
export const MIN_WIDENING_STEP = -7;
export const MAX_WIDENING_STEP = 3;

export function liquiditySettingsSchemaFor(defaults: Pick<LiquiditySettings, "quietBands">): readonly SettingsFieldSchema<LiquiditySettings>[] {
  return [
    { kind: "numeric", key: "clusterRows", label: "Level width", min: 1, max: MAX_LEVEL_WIDTH, step: 1, clampOnRestore: true, affects: "recompute" },
    { kind: "numeric", key: "timeframeWidening", label: "Higher timeframes", min: 2 ** MIN_WIDENING_STEP, max: 2 ** MAX_WIDENING_STEP, step: 0, clampOnRestore: true, affects: "recompute" },
    { kind: "numeric", key: "quietBands", label: "Quiet zone", min: 0, max: quietZoneMaxFor(defaults), step: 1, clampOnRestore: true, affects: "recompute" },
    { kind: "numeric", key: "minBandSize", label: "Sensitivity", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
    { kind: "select", key: "historyDays", label: "History", options: LIQUIDITY_HISTORY_OPTIONS.map(([value, label]) => ({ value, label })), affects: "recompute" },
    { kind: "select", key: "levelFilter", label: "Levels", options: [{ value: "all", label: "All" }, { value: "resting", label: "Resting" }, { value: "consumed", label: "Consumed" }], affects: "recompute" },
    { kind: "boolean", key: "showPulled", label: "Show pulled", affects: "recompute" },
    { kind: "select", key: "scaleMode", label: "Scale", options: [{ value: "auto", label: "Auto" }, { value: "fixed", label: "Fixed" }], affects: "cosmetic" },
    { kind: "numeric", key: "scaleSize", label: "Saturation", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "cosmetic" },
    { kind: "slider", key: "maxOpacity", label: "Max opacity", min: 0, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
    { kind: "slider", key: "heatFloor", label: "Heat floor", min: 0, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
    { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
    { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
    { kind: "boolean", key: "showLadder", label: "Show ladder", affects: "cosmetic" },
    { kind: "slider", key: "ladderReach", label: "Ladder reach", min: MIN_LADDER_REACH, max: MAX_LADDER_REACH, step: 0, clampOnRestore: true, affects: "cosmetic" },
  ];
}

export function wideningOfStep(step: number): number {
  return 2 ** step;
}

export function wideningStepOf(widening: number): number {
  return Math.min(MAX_WIDENING_STEP, Math.max(MIN_WIDENING_STEP, Math.round(Math.log2(widening))));
}

/** The setting as it applies: a saved value it cannot use reads as auto, and the slider's reach bounds the rest. */
export function timeframeWideningOf(settings: Partial<Pick<LiquiditySettings, "timeframeWidening">>): number {
  const value = settings.timeframeWidening;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(wideningOfStep(MAX_WIDENING_STEP), Math.max(wideningOfStep(MIN_WIDENING_STEP), value));
}

/** How much a chart widens the 1m level width: its own factor (x3 on 15m, x8 on 1h ...) times the setting, never under 1; 1 under 15m. */
export function widenedBandFactorFor(settings: Partial<Pick<LiquiditySettings, "timeframeWidening">>, intervalMs: number): number {
  const auto = bandFactorFor(intervalMs);
  return auto > 1 ? Math.max(1, auto * timeframeWideningOf(settings)) : 1;
}

export function clusterRowsFor(settings: Pick<LiquiditySettings, "clusterRows"> & Partial<Pick<LiquiditySettings, "timeframeWidening">>, intervalMs: number): number {
  return Math.max(1, Math.round(Math.floor(settings.clusterRows) * widenedBandFactorFor(settings, intervalMs)));
}

export function minBandSizeFor(settings: Pick<LiquiditySettings, "minBandSize"> & Partial<Pick<LiquiditySettings, "timeframeWidening">>, market: LiquidityMarket, intervalMs: number): number {
  const floor = Math.max(0, settings.minBandSize);
  return market === "crypto" ? floor * widenedBandFactorFor(settings, intervalMs) : floor;
}

/** A band's thickness grows with size, from a quarter of its row at nothing to the whole row when saturated, centred in the row. */
export const BAND_MIN_SHARE = 0.25;
export function bandSpan(intensity: number, height: number): { offset: number; size: number } {
  const h = Math.max(1, Math.floor(height));
  const share = BAND_MIN_SHARE + (1 - BAND_MIN_SHARE) * Math.min(1, Math.max(0, intensity));
  const size = Math.max(1, Math.min(h, Math.round(h * share)));
  return { offset: Math.floor((h - size) / 2), size };
}

/** Brightness grows as size^gamma up to the reference: small resting size stays visible, walls saturate. */
export const LIQUIDITY_GAMMA = 0.6;

/** "12m" / "45s" for how long a band has been resting. */
export function formatWallAge(ageMs: number): string {
  if (!(ageMs > 0)) return "0s";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** The size that saturates the colour scale under these settings. */
/** The yardstick of the rows drawn: the grid's own in auto mode; in fixed mode the trader's size, set per row of the finest lane, times the rows a drawn row spans. */
export function liquidityReference(settings: LiquiditySettings, grid: Pick<LiquidityGrid, "referenceSize">, rowsPerDrawnRow = 1): number {
  if (settings.scaleMode === "fixed") return settings.scaleSize > 0 ? settings.scaleSize * rowsPerDrawnRow : 0;
  return grid.referenceSize;
}

/** "24 min" or "2.4 h" for the legend's history span. */
export function formatLiquiditySpan(spanMs: number): string {
  if (!(spanMs > 0)) return "0 min";
  const minutes = spanMs / 60_000;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/** A count of contracts or shares: "7", "96", "12.5k", "2.4M". */
export function formatWholeSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`;
  if (size >= 10_000) return `${(size / 1000).toFixed(1)}k`;
  return String(Math.max(1, Math.round(size)));
}

/** Compact size for the ladder: "0.42", "3.5", "128". */
export function formatLiquiditySize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size >= 1000) return `${(size / 1000).toFixed(1)}k`;
  if (size >= 100) return size.toFixed(0);
  if (size >= 10) return size.toFixed(1);
  return size.toFixed(2);
}
