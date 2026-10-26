// The crypto heatmap (Binance spot and perpetual pairs), as the trader had it
// on 2026-09-06: numbers in coins beside the axis, the tooltip with the size,
// its peak, its state and its age, brightness against the largest level in
// view, and a run that darkens a little as it ages. Not to be changed
// without the trader's say-so.
//
// Every crypto pair is drawn exactly this way; what differs between them is
// where their settings start, since a band of two rows is $8 on BTC and 25
// cents on ETH. So the style is built from a name and a settings patch, and a
// pair with its own numbers gets a file of its own (btcLiquidityStyle.ts,
// ethLiquidityStyle.ts).

import { bandSizes, type LiquidityColumn } from "./liquidityGrid";
import {
  DEFAULT_LIQUIDITY_SETTINGS,
  LIQUIDITY_GAMMA,
  bandSpan,
  formatLiquiditySize,
  type LiquiditySettings,
} from "./liquiditySettings";
import type {
  AlphaContext,
  HoverWords,
  LiquidityStyle,
  SaturationContext,
} from "./liquidityStyle";

/** A level reaches full darkness once its run is this old. */
export const LEVEL_MATURE_MS = 15 * 60_000;
/** A brand new level is drawn at this share of its size's opacity: a light touch, so a big fresh wall still reads big. */
export const AGE_ALPHA_MIN = 0.8;

/** AGE_ALPHA_MIN at birth, 1 from LEVEL_MATURE_MS on, linear between. */
export function ageFactor(ageMs: number): number {
  const share = Math.min(1, Math.max(0, ageMs) / LEVEL_MATURE_MS);
  return AGE_ALPHA_MIN + (1 - AGE_ALPHA_MIN) * share;
}

/**
 * How dark a level is follows what is resting on the chart right now: the
 * largest level in view is the darkest and the rest sit under it, the same
 * scale the ladder uses, so a big wall reads big however thick the book. (A
 * 95th-percentile reference put an 80 BTC wall at a fifth of full on a thick
 * perpetual book.) A fixed scale is the trader's own yardstick.
 */
export function cryptoSaturation(
  _column: LiquidityColumn,
  { settings, clusterRows, ladderMax, reference }: SaturationContext,
): number {
  if (settings.scaleMode === "fixed" && settings.scaleSize > 0)
    return reference * clusterRows;
  return Math.max(ladderMax, reference * clusterRows * 0.5, Number.EPSILON);
}

/** The paint floor as it always was: the heat-floor share of the typical (95th percentile) row, per row of the band. */
export function cryptoPaintFloor(
  column: LiquidityColumn,
  { settings, clusterRows, reference }: SaturationContext,
): number {
  const yardstick =
    settings.scaleMode === "fixed" && settings.scaleSize > 0
      ? reference
      : column.reference !== undefined && column.reference > 0
        ? column.reference
        : reference;
  return settings.heatFloor * yardstick * clusterRows;
}

/** Brightness grows as size^gamma up to the saturation, capped by the trader's opacity setting. */
export function cryptoAlpha(
  ratio: number,
  settings: LiquiditySettings,
): number {
  const maxAlpha = Math.min(1, Math.max(0, settings.maxOpacity)) * 255;
  return maxAlpha * Math.min(1, Math.max(0, ratio)) ** LIQUIDITY_GAMMA;
}

/** "73.0 BTC · peak 80.0": the size in coins, and the most the run held when that is more. */
export function cryptoHoverWords(
  size: number,
  peak: number,
  unit: string,
): HoverWords {
  const sizeText = formatLiquiditySize(size);
  return {
    label: sizeText === "" ? "" : `${sizeText} ${unit}`.trim(),
    peakLabel: peak > size ? formatLiquiditySize(peak) : "",
    detail: "",
  };
}

export interface CryptoStyleParams {
  /** The key this pair's settings are kept under. */
  name: string;
  /** What its heatmap starts from, over the shared defaults. */
  settings: Partial<LiquiditySettings>;
}

/** The crypto style, with one pair's default settings. The drawing is the same for every pair. */
export function createCryptoStyle(params: CryptoStyleParams): LiquidityStyle {
  return Object.freeze({
    market: "crypto",
    name: params.name,
    defaultSettings: Object.freeze({
      ...DEFAULT_LIQUIDITY_SETTINGS,
      ...params.settings,
    }),
    bandSizes,
    typicalBand: (
      column: LiquidityColumn,
      { clusterRows, reference }: SaturationContext,
    ) => {
      const medianRow =
        column.median !== undefined && column.median > 0
          ? column.median
          : (column.reference !== undefined && column.reference > 0
              ? column.reference
              : reference) * 0.5;
      return medianRow * clusterRows;
    },
    paintFloor: cryptoPaintFloor,
    saturationAt: cryptoSaturation,
    wallSize: cryptoPaintFloor,
    alphaOf: (size: number, { saturation, settings }: AlphaContext) =>
      cryptoAlpha(size / saturation, settings),
    ageFactor,
    // A band thickens with size, from a quarter of its row to the whole row.
    bandSpan,
    ladderNumbers: true,
    ladderText: (size: number) => formatLiquiditySize(size),
    hoverWords: cryptoHoverWords,
  });
}

/** Any pair without settings of its own; BTC and ETH have their own files. */
export const cryptoLiquidityStyle: LiquidityStyle = createCryptoStyle({
  name: "crypto",
  settings: {},
});
