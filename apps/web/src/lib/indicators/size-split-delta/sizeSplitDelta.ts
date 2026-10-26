import { draw } from "../../chart/draw";
import type { TableHandle } from "../../chart/draw/table";
import type { LineOutputSpec, PlacementSpec, RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { BarFrame, FrameIdentity } from "../../../types/frames";
import {
  MAX_TAPE_SHARE,
  SIZE_SPLIT_DEFAULT_K,
  SIZE_SPLIT_DEFAULT_M,
  SIZE_SPLIT_DEFAULT_MIN_TAPE_SHARE,
  SIZE_SPLIT_DEFAULT_Q,
  SIZE_SPLIT_DEFAULT_TIER_SIZE,
  TIER_MIN_SIZES,
  createSizeSplitEngine,
  formatClock,
  formatMagnitude,
  formatSigned,
  type SizeSplitAnchor,
  type SizeSplitEngine,
  type SizeSplitReading,
  type TierMode,
} from "./sizeSplitDeltaMath";

/**
 * Size-Split Delta (large vs small): the cumulative aggressive delta of the
 * prints at or above a size tier and of the rest, since the anchor, so a
 * trader sees whether the large prints made the new price extreme with price
 * or lagged it. Own pane, two lines, a three-row table, a divergence arrow
 * (primary) and an optional conflict circle. Tape only: reads `ctx.ticks`
 * and never the candle sides; honest nulls wherever the store does not cover the bar.
 */

export const SIZE_SPLIT_LARGE_COLOR = "#8672b3";
export const SIZE_SPLIT_SMALL_COLOR = "#2563eb";
export const SIZE_SPLIT_BAR_LINE_COLOR = "#787b86";
export const SIZE_SPLIT_TABLE_TEXT_COLOR = "#d1d4dc";
export const SIZE_SPLIT_PROVISIONAL_ALPHA = 0.5;
export const SIZE_SPLIT_UNAVAILABLE = "—";
export const SIZE_SPLIT_TABLE_MAX_CHARS = 30;

export interface SizeSplitDeltaSettings {
  tierMode: TierMode;
  tierSize: number;
  anchor: SizeSplitAnchor;
  K: number;
  m: number;
  q: number;
  minTapeShare: number;
  showSmall: boolean;
  showDivergence: boolean;
  showConflict: boolean;
  showBarLines: boolean;
}

export interface SizeSplitDeltaState {
  engine: SizeSplitEngine;
  table: TableHandle;
  /** The settings the state was created with; `readOutput` reads the Visibility toggles from here. */
  settings: SizeSplitDeltaSettings;
  reading: SizeSplitReading | null;
  provider: BarFrame["provider"] | null;
  symbol: string | null;
  assetClass: FrameIdentity["assetClass"] | null;
}

export const SIZE_SPLIT_DEFAULT_SETTINGS: SizeSplitDeltaSettings = Object.freeze({
  tierMode: "auto",
  tierSize: SIZE_SPLIT_DEFAULT_TIER_SIZE,
  anchor: "day",
  K: SIZE_SPLIT_DEFAULT_K,
  m: SIZE_SPLIT_DEFAULT_M,
  q: SIZE_SPLIT_DEFAULT_Q,
  minTapeShare: SIZE_SPLIT_DEFAULT_MIN_TAPE_SHARE,
  showSmall: true,
  showDivergence: true,
  showConflict: false,
  showBarLines: false,
});

/** `#rgb` or `#rrggbb` with an alpha; any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return color;
  let digits = hex[1];
  if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const LARGE_PROVISIONAL = withAlpha(SIZE_SPLIT_LARGE_COLOR, SIZE_SPLIT_PROVISIONAL_ALPHA);
const SMALL_PROVISIONAL = withAlpha(SIZE_SPLIT_SMALL_COLOR, SIZE_SPLIT_PROVISIONAL_ALPHA);
const BAR_LINE_PROVISIONAL = withAlpha(SIZE_SPLIT_BAR_LINE_COLOR, SIZE_SPLIT_PROVISIONAL_ALPHA);

function provisional(reading: SizeSplitReading | null): boolean {
  return reading !== null && !reading.confirmed;
}

export function largeLineColor(reading: SizeSplitReading | null): string {
  return provisional(reading) ? LARGE_PROVISIONAL : SIZE_SPLIT_LARGE_COLOR;
}

export function smallLineColor(reading: SizeSplitReading | null): string {
  return provisional(reading) ? SMALL_PROVISIONAL : SIZE_SPLIT_SMALL_COLOR;
}

function barLineColor(reading: SizeSplitReading | null): string {
  return provisional(reading) ? BAR_LINE_PROVISIONAL : SIZE_SPLIT_BAR_LINE_COLOR;
}

/** The size unit named in the ready status: the coin on Binance, contracts on a future, shares on an equity. */
export function sizeUnitOf(state: Pick<SizeSplitDeltaState, "provider" | "symbol" | "assetClass">): string {
  if (state.provider === "BINANCE") {
    const symbol = state.symbol ?? "";
    const dash = symbol.indexOf("-");
    return dash > 0 ? symbol.slice(0, dash) : symbol || "units";
  }
  if (state.assetClass === "FUTURE") return "contracts";
  if (state.assetClass === "EQUITY") return "shares";
  return "units";
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Rule 12 and amendment 5: the status row, first match wins; each string stays within 30 characters. */
export function statusText(reading: SizeSplitReading | null, unit: string, minTapeShare: number): string {
  if (reading === null) return "Needs live tape · no feed";
  switch (reading.status) {
    case "noFeed":
      return "Needs live tape · no feed";
    case "thinned":
      return "Needs live tape · thinned";
    case "learning":
      return `Learning sizes · ${reading.sizesLearned}/${TIER_MIN_SIZES}`;
    case "shareUnknown":
      return "Tape share unknown";
    case "shareMismatch":
      return `Tape ${percent(reading.share ?? MAX_TAPE_SHARE)} · mismatch`;
    case "shareLow":
      return `Tape ${percent(reading.share ?? 0)} · below ${percent(minTapeShare)}`;
    case "gap":
      return `Tape gap · ${reading.gapBars} bar${reading.gapBars === 1 ? "" : "s"}`;
    case "forming":
      return "Forming";
    default:
      return `≥ ${formatMagnitude(reading.tier ?? 0)} ${unit} · tape ${percent(reading.share ?? 0)}`;
  }
}

/** Row (a): the confirmation state at the current bar with compact values (amendment 7). */
export function stateText(reading: SizeSplitReading | null, K: number): string {
  if (reading === null || !reading.valid) return SIZE_SPLIT_UNAVAILABLE;
  if (reading.state === null) return `Need ${K} valid bars`;
  const word = reading.state === "noExtreme" ? "no extreme" : reading.state;
  const withValues = `L ${formatSigned(reading.large ?? 0)} · S ${formatSigned(reading.small ?? 0)} · ${word}`;
  return withValues.length <= SIZE_SPLIT_TABLE_MAX_CHARS ? withValues : word;
}

/** Row (b): the last condition with its time and value, `—` when none in this anchor window. */
export function conditionText(reading: SizeSplitReading | null, provider: BarFrame["provider"] | null): string {
  const condition = reading?.condition ?? null;
  if (condition === null) return SIZE_SPLIT_UNAVAILABLE;
  const time = formatClock(condition.tsOpen, provider ?? "BINANCE");
  if (condition.kind === "divergence") {
    const arrow = condition.direction === "bearish" ? "↓" : "↑";
    return `Div ${arrow} ${time} · ${formatSigned(condition.values[0] ?? 0)}`;
  }
  const text = `Conflict ${time} · ${formatSigned(condition.values[0] ?? 0)}/${formatSigned(condition.values[1] ?? 0)}`;
  return text.length <= SIZE_SPLIT_TABLE_MAX_CHARS ? text : `Conflict ${time}`;
}

export interface SizeSplitTableRow {
  text: string;
  color: string;
}

export function sizeSplitTableRows(
  reading: SizeSplitReading | null,
  settings: SizeSplitDeltaSettings,
  state: Pick<SizeSplitDeltaState, "provider" | "symbol" | "assetClass">,
): readonly SizeSplitTableRow[] {
  return [
    { text: stateText(reading, settings.K), color: largeLineColor(reading) },
    { text: conditionText(reading, state.provider), color: SIZE_SPLIT_TABLE_TEXT_COLOR },
    { text: statusText(reading, sizeUnitOf(state), settings.minTapeShare), color: SIZE_SPLIT_TABLE_TEXT_COLOR },
  ];
}

/** The four output keys, with the Visibility toggles applied (a hidden line reads null). */
export function visibleOutputs(reading: SizeSplitReading | null, settings: SizeSplitDeltaSettings): Record<string, number | null> {
  return {
    large: reading?.large ?? null,
    small: settings.showSmall ? (reading?.small ?? null) : null,
    largeBar: settings.showBarLines ? (reading?.largeBar ?? null) : null,
    smallBar: settings.showBarLines ? (reading?.smallBar ?? null) : null,
  };
}

const SIZE_SPLIT_LINES: readonly LineOutputSpec<SizeSplitDeltaState, SizeSplitDeltaSettings>[] = [
  // The colours are constants, so `recolor` keeps every bar's colour: a settings
  // update that changes no recompute key never replays.
  { key: "large", lineWidth: 2, color: (state) => largeLineColor(state.reading), recolor: (current) => current ?? SIZE_SPLIT_LARGE_COLOR },
  { key: "small", lineWidth: 1, color: (state) => smallLineColor(state.reading), recolor: (current) => current ?? SIZE_SPLIT_SMALL_COLOR },
  { key: "largeBar", lineWidth: 1, color: (state) => barLineColor(state.reading), recolor: (current) => current ?? SIZE_SPLIT_BAR_LINE_COLOR },
  { key: "smallBar", lineWidth: 1, color: (state) => barLineColor(state.reading), recolor: (current) => current ?? SIZE_SPLIT_BAR_LINE_COLOR },
];

const SIZE_SPLIT_PLACEMENT: PlacementSpec = { kind: "ownPane", priceLines: [0] };

export const SIZE_SPLIT_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SizeSplitDeltaSettings>[] = [
  {
    kind: "select",
    key: "tierMode",
    label: "Large tier",
    options: [
      { value: "auto", label: "Top 2% of recent sizes" },
      { value: "fixed", label: "Fixed size" },
    ],
    affects: "recompute",
  },
  {
    kind: "numeric",
    key: "tierSize",
    label: "Large from (units)",
    min: 0.001,
    max: 1_000_000,
    step: 0.001,
    affects: "recompute",
    visibleIf: (settings) => settings.tierMode === "fixed",
  },
  {
    kind: "select",
    key: "anchor",
    label: "Anchor",
    options: [
      { value: "day", label: "Day (UTC)" },
      { value: "week", label: "Week (UTC)" },
      { value: "tape", label: "Tape start" },
    ],
    affects: "recompute",
  },
  {
    kind: "staticHint",
    text:
      "Needs the live tape: 200 trade frames from complete windows, then the next bar open. Lines start where the store's complete tape starts. Arrow: a price extreme the large tier did not make. Circle: the two tiers pulling apart. Replays every bar.",
  },
  { kind: "numeric", key: "K", label: "Window (bars)", min: 10, max: 60, step: 5, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "m", label: "Divergence depth (×)", min: 1, max: 4, step: 0.5, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "q", label: "Conflict strength (×)", min: 1, max: 4, step: 0.5, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "minTapeShare", label: "Minimum tape share", min: 0.2, max: 1, step: 0.05, affects: "recompute", tab: "advanced" },
  { kind: "boolean", key: "showSmall", label: "Show small tier", affects: "recompute", tab: "visibility" },
  { kind: "boolean", key: "showDivergence", label: "Show divergence arrows", affects: "recompute", tab: "visibility" },
  { kind: "boolean", key: "showConflict", label: "Show conflict circles", affects: "recompute", tab: "visibility" },
  { kind: "boolean", key: "showBarLines", label: "Show per-bar contributions", affects: "recompute", tab: "visibility" },
];

/** Suggested fixed sizes per instrument (0.5 BTC, 20 contracts, 2,000 shares) appear in the field's label; the stored default stays 0.5. */
export function sizeSplitSettingsFieldsFor(identity: { symbol: string } & FrameIdentity): Partial<Record<keyof SizeSplitDeltaSettings, SettingsFieldSchema<SizeSplitDeltaSettings>>> {
  const base = SIZE_SPLIT_SETTINGS_SCHEMA.find((field) => field.kind === "numeric" && field.key === "tierSize");
  if (base === undefined || base.kind !== "numeric") return {};
  if (identity.provider === "BINANCE") {
    const coin = identity.symbol.includes("-") ? identity.symbol.slice(0, identity.symbol.indexOf("-")) : identity.symbol;
    return { tierSize: { ...base, label: `Large from (${coin}, try 0.5)` } };
  }
  if (identity.assetClass === "FUTURE") return { tierSize: { ...base, label: "Large from (contracts, try 20)", min: 1, step: 1 } };
  if (identity.assetClass === "EQUITY") return { tierSize: { ...base, label: "Large from (shares, try 2,000)", min: 1, step: 100 } };
  return {};
}

export const sizeSplitDeltaIndicator: RuntimeIndicatorDef<SizeSplitDeltaState, SizeSplitDeltaSettings> = {
  kind: "runtime",
  id: "sizeSplitDelta",
  label: "Size-Split Delta (large vs small)",
  category: "l1",
  ticksWanted: true,
  maxReplayBars: 10_080,
  defaultSettings: SIZE_SPLIT_DEFAULT_SETTINGS,
  settingsSchema: SIZE_SPLIT_SETTINGS_SCHEMA,
  settingsFieldsFor: sizeSplitSettingsFieldsFor,
  lines: SIZE_SPLIT_LINES,
  placement: SIZE_SPLIT_PLACEMENT,
  createState: (settings) => ({
    engine: createSizeSplitEngine({
      tierMode: settings.tierMode,
      tierSize: settings.tierSize,
      anchor: settings.anchor,
      K: settings.K,
      m: settings.m,
      q: settings.q,
      minTapeShare: settings.minTapeShare,
    }),
    table: draw.table(),
    settings,
    reading: null,
    provider: null,
    symbol: null,
    assetClass: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings } = ctx;
    state.provider = bar.provider;
    state.symbol = bar.symbol;
    state.assetClass = bar.assetClass ?? null;
    const reading = state.engine.onBar(bar, ctx.ticks);
    state.reading = reading;

    if (reading.valid) {
      const color = largeLineColor(reading);
      if (settings.showDivergence && reading.divergence !== null) {
        ctx.markers.plotshape({
          shape: reading.divergence === "bearish" ? "arrowDown" : "arrowUp",
          position: reading.divergence === "bearish" ? "aboveBar" : "belowBar",
          color,
          size: 1,
        });
      }
      if (settings.showConflict && reading.conflictOnset) {
        ctx.markers.plotshape({ shape: "circle", position: "inBar", color, size: 1 });
      }
    }

    if (ctx.drawNow !== false) {
      const rows = sizeSplitTableRows(reading, settings, state);
      for (let row = 0; row < rows.length; row += 1) state.table.cell(row, 0, { text: rows[row].text, textColor: rows[row].color });
    }
  },
  readOutput: (state) => visibleOutputs(state.reading, state.settings),
};
