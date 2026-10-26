import { bandMaxSizes, type LiquidityColumn } from "./liquidityGrid";
import {
  DEFAULT_LIQUIDITY_SETTINGS,
  LIQUIDITY_GAMMA,
  bandSpan,
  formatWholeSize,
  type LiquiditySettings,
} from "./liquiditySettings";
import type {
  AlphaContext,
  HoverWords,
  LiquidityStyle,
  SaturationContext,
} from "./liquidityStyle";

export interface IndexStyleParams {
  name: string;
  settings: Partial<LiquiditySettings>;
  typicalFloorMultiple: number;
  referenceFloorShare: number;
  saturationMultiple: number;
  monsterMultiple: number;
  rampGamma: number;
  opacityBoost: number;
}

export const INDEX_DEFAULTS: IndexStyleParams = Object.freeze({
  name: "index",
  settings: Object.freeze({ clusterRows: 1 }),
  typicalFloorMultiple: 1.25,
  referenceFloorShare: 0.6,
  saturationMultiple: 1.5,
  monsterMultiple: 4,
  rampGamma: LIQUIDITY_GAMMA,
  opacityBoost: 1.6,
});

function columnReferenceOf(column: LiquidityColumn, reference: number): number {
  return column.reference !== undefined && column.reference > 0 ? column.reference : reference;
}

export function indexTypicalRow(
  column: LiquidityColumn,
  { reference }: SaturationContext,
): number {
  return column.median !== undefined && column.median > 0
    ? column.median
    : columnReferenceOf(column, reference) * 0.5;
}

export function indexPaintFloorWith(params: IndexStyleParams) {
  return (column: LiquidityColumn, context: SaturationContext): number => {
    const { settings, reference } = context;
    if (settings.scaleMode === "fixed" && settings.scaleSize > 0)
      return settings.heatFloor * reference;
    const columnReference = columnReferenceOf(column, reference);
    return Math.max(
      settings.heatFloor * columnReference,
      params.typicalFloorMultiple * indexTypicalRow(column, context),
      params.referenceFloorShare * columnReference,
    );
  };
}

export function indexThresholdWith(multiple: number) {
  return (
    column: LiquidityColumn,
    { settings, reference }: SaturationContext,
  ): number => {
    if (settings.scaleMode === "fixed" && settings.scaleSize > 0)
      return reference;
    return Math.max(multiple * columnReferenceOf(column, reference), Number.EPSILON);
  };
}

export function indexSaturationWith(params: Pick<IndexStyleParams, "saturationMultiple">) {
  const threshold = indexThresholdWith(params.saturationMultiple);
  return (column: LiquidityColumn, context: SaturationContext): number => {
    const { settings } = context;
    if (settings.scaleMode === "fixed" && settings.scaleSize > 0)
      return threshold(column, context);
    const ceiling = column.ceiling !== undefined && column.ceiling > 0 ? column.ceiling : 0;
    return Math.max(ceiling, threshold(column, context));
  };
}

export function indexWallSizeWith(params: Pick<IndexStyleParams, "saturationMultiple" | "monsterMultiple">) {
  const threshold = indexThresholdWith(params.saturationMultiple);
  return (column: LiquidityColumn, context: SaturationContext): number => params.monsterMultiple * threshold(column, context);
}

export function indexAlphaWith(params: Pick<IndexStyleParams, "rampGamma" | "opacityBoost">) {
  return (size: number, { saturation, settings }: AlphaContext): number => {
    if (!(size > 0) || !(saturation > 0)) return 0;
    const maxAlpha =
      Math.min(1, Math.max(0, settings.maxOpacity) * params.opacityBoost) * 255;
    return maxAlpha * Math.min(1, size / saturation) ** params.rampGamma;
  };
}

export function indexHoverWords(
  size: number,
  peak: number,
  unit: string,
): HoverWords {
  const sizeText = formatWholeSize(size);
  return {
    label: sizeText === "" ? "" : `${sizeText} ${unit}`.trim(),
    peakLabel: peak > size ? formatWholeSize(peak) : "",
    detail: "",
  };
}

export function createIndexStyle(params: IndexStyleParams): LiquidityStyle {
  return Object.freeze({
    market: "index",
    name: params.name,
    defaultSettings: Object.freeze({
      ...DEFAULT_LIQUIDITY_SETTINGS,
      ...params.settings,
    }),
    bandSizes: bandMaxSizes,
    typicalBand: indexTypicalRow,
    paintFloor: indexPaintFloorWith(params),
    saturationAt: indexSaturationWith(params),
    wallSize: indexWallSizeWith(params),
    alphaOf: indexAlphaWith(params),
    ageFactor: () => 1,
    bandSpan,
    ladderNumbers: true,
    ladderText: (size: number) => formatWholeSize(size),
    hoverWords: indexHoverWords,
  });
}

export const indexLiquidityStyle: LiquidityStyle =
  createIndexStyle(INDEX_DEFAULTS);
