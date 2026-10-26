import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export const BIN_GRADIENT_MIN_OPACITY = 0.5;

export function computeBinOpacity(volume: number, maxVolume: number): number {
  if (maxVolume <= 0) return 1;
  const ratio = Math.min(Math.max(volume / maxVolume, 0), 1);
  return BIN_GRADIENT_MIN_OPACITY + (1 - BIN_GRADIENT_MIN_OPACITY) * ratio;
}

export interface BinOpacityBand {
  min: number;
  max: number;
}

export function computeBinOpacityInBand(
  weight: number,
  maxWeight: number,
  { min, max }: BinOpacityBand,
): number {
  if (maxWeight <= 0) return max;
  const ratio = Math.min(Math.max(weight / maxWeight, 0), 1);
  return min + (max - min) * ratio;
}

export interface RenderLevelLabel {
  x: number;
  y: number;
  text: string;
  color: string;
}

export const LEVEL_LABEL_FONT = "11px sans-serif";

export const LEVEL_LABEL_MARGIN_PX = 8;

const LEVEL_LABEL_PAD_X_PX = 5;
const LEVEL_LABEL_PAD_Y_PX = 3;
const LEVEL_LABEL_PLATE_RADIUS_PX = 3;

const LEVEL_LABEL_HALF_LINE_PX = 5.5;

export const LEVEL_LABEL_PLATE_FILL = "#ffffff";

const WHOLE_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatLabelPrice(price: number): string {
  if (!Number.isFinite(price)) return "--";
  const magnitude = Math.abs(price);
  if (magnitude >= 100) return price.toFixed(2);
  if (magnitude >= 1)
    return price.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return price.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatLabelVolume(volume: number): string {
  if (!Number.isFinite(volume)) return "--";
  return WHOLE_NUMBER_FORMAT.format(Math.round(volume));
}

export function formatLabelDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "--";
  const rounded = Math.round(delta);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${WHOLE_NUMBER_FORMAT.format(Math.abs(rounded))}`;
}

export const BIN_VALUE_PAD_PX = 2;
export const BIN_VALUE_MIN_FONT_PX = 7;
export const BIN_VALUE_MAX_FONT_PX = 22;
export const BIN_VALUE_FONT_FAMILY = "sans-serif";

export const MAX_LABELLED_HISTORICAL_PROFILES = 4;

export const DEFAULT_BIN_VALUE_BACKGROUND = "#f2efe6";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

const PARSE_COLOR_CACHE_LIMIT = 4_096;
const PARSE_COLOR_CACHE = new Map<string, Rgba>();
const INK_CACHE_LIMIT = 8_192;
const INK_CACHE = new Map<string, string>();

function parseColor(color: string): Rgba | null {
  const cached = PARSE_COLOR_CACHE.get(color);
  if (cached !== undefined) return cached;
  const parsed = parseColorUncached(color);
  if (parsed !== null) {
    if (PARSE_COLOR_CACHE.size >= PARSE_COLOR_CACHE_LIMIT) {
      PARSE_COLOR_CACHE.delete(PARSE_COLOR_CACHE.keys().next().value as string);
    }
    PARSE_COLOR_CACHE.set(color, parsed);
  }
  return parsed;
}

function parseColorUncached(color: string): Rgba | null {
  const text = color.trim();
  const hex = HEX_COLOR.exec(text);
  if (hex !== null) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = RGB_COLOR.exec(text);
  if (rgb === null) return null;
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const alpha = Math.min(Math.max(top.a, 0), 1);
  const mix = (front: number, back: number) =>
    front * alpha + back * (1 - alpha);
  return {
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
    a: 1,
  };
}

const DARK_BIN_VALUE_INK = "#0a0a0a";
const LIGHT_BIN_VALUE_INK = "#ffffff";
const DARK_BIN_VALUE_INK_RGBA: Rgba = { r: 10, g: 10, b: 10, a: 1 };
const LIGHT_BIN_VALUE_INK_RGBA: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const CHANNEL_LINEAR = Float64Array.from({ length: 256 }, (_unused, value) => {
  const scaled = value / 255;
  return scaled <= 0.03928
    ? scaled / 12.92
    : ((scaled + 0.055) / 1.055) ** 2.4;
});

function linearChannel(value: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 255) {
    return CHANNEL_LINEAR[value];
  }
  const scaled = value / 255;
  return scaled <= 0.03928
    ? scaled / 12.92
    : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgba): number {
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

function contrastRatio(first: Rgba, second: Rgba): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function binValueTextColor(
  fill: string,
  background: string = DEFAULT_BIN_VALUE_BACKGROUND,
): string {
  const cacheKey = `${fill}\0${background}`;
  const cached = INK_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const fillColor = parseColor(fill);
  if (fillColor === null) return LIGHT_BIN_VALUE_INK;
  const behind =
    parseColor(background) ??
    (parseColor(DEFAULT_BIN_VALUE_BACKGROUND) as Rgba);
  const seen = compositeOver(fillColor, behind);
  const ink =
    contrastRatio(DARK_BIN_VALUE_INK_RGBA, seen) >=
    contrastRatio(LIGHT_BIN_VALUE_INK_RGBA, seen)
      ? DARK_BIN_VALUE_INK
      : LIGHT_BIN_VALUE_INK;
  if (INK_CACHE.size >= INK_CACHE_LIMIT) {
    INK_CACHE.delete(INK_CACHE.keys().next().value as string);
  }
  INK_CACHE.set(cacheKey, ink);
  return ink;
}

export function fitBinValueFont(
  measure: (text: string, fontSize: number) => number,
  text: string,
  boxWidth: number,
  boxHeight: number,
): number | null {
  const availWidth = boxWidth - BIN_VALUE_PAD_PX * 2;
  const availHeight = boxHeight - BIN_VALUE_PAD_PX * 2;
  if (availWidth <= 0 || availHeight <= 0) return null;
  let fontSize = Math.min(availHeight, BIN_VALUE_MAX_FONT_PX);
  if (fontSize < BIN_VALUE_MIN_FONT_PX) return null;
  const width = measure(text, fontSize);
  if (width > availWidth) {
    fontSize = fontSize * (availWidth / width);
    if (fontSize < BIN_VALUE_MIN_FONT_PX) return null;
  }
  return fontSize;
}

export type BinValueAlign = "center" | "left" | "right";

export function drawBinValue(
  context: CanvasRenderingContext2D,
  box: { x1: number; x2: number; yTop: number; yBottom: number },
  text: string,
  fill: string,
  align: BinValueAlign = "center",
  background: string = DEFAULT_BIN_VALUE_BACKGROUND,
): void {
  const fontSize = fitBinValueFont(
    (value, size) => {
      context.font = `${size}px ${BIN_VALUE_FONT_FAMILY}`;
      return context.measureText(value).width;
    },
    text,
    box.x2 - box.x1,
    box.yBottom - box.yTop,
  );
  if (fontSize === null) return;
  const x =
    align === "left"
      ? box.x1 + BIN_VALUE_PAD_PX
      : align === "right"
        ? box.x2 - BIN_VALUE_PAD_PX
        : (box.x1 + box.x2) / 2;
  context.font = `${fontSize}px ${BIN_VALUE_FONT_FAMILY}`;
  context.textAlign = align;
  context.textBaseline = "middle";
  context.fillStyle = binValueTextColor(fill, background);
  context.fillText(text, x, (box.yTop + box.yBottom) / 2);
}

export class ProfileLevelLabelRenderer implements IPrimitivePaneRenderer {
  private readonly _labels: readonly RenderLevelLabel[];

  constructor(labels: readonly RenderLevelLabel[]) {
    this._labels = labels;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      context.font = LEVEL_LABEL_FONT;
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (const label of this._labels) {
        const width = context.measureText(label.text).width;
        const plateX = label.x - width - LEVEL_LABEL_PAD_X_PX;
        const plateY =
          label.y - LEVEL_LABEL_PAD_Y_PX - LEVEL_LABEL_HALF_LINE_PX;
        const plateHeight =
          LEVEL_LABEL_PAD_Y_PX * 2 + LEVEL_LABEL_HALF_LINE_PX * 2;
        context.fillStyle = LEVEL_LABEL_PLATE_FILL;
        context.beginPath();
        context.roundRect(
          plateX,
          plateY,
          width + LEVEL_LABEL_PAD_X_PX * 2,
          plateHeight,
          LEVEL_LABEL_PLATE_RADIUS_PX,
        );
        context.fill();

        context.fillStyle = label.color;
        context.fillText(label.text, label.x, label.y);
      }
      context.restore();
    });
  }
}
