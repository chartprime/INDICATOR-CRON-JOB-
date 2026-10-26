// What the renderers need from the primitive that owns them: the current
// layout and grid, the settings, the two colours, and the reusable pixel
// buffers. Kept as an interface so a renderer can be read, and tested, without
// the chart.

import type { LiquidityGrid } from "./liquidityGrid";
import type { HeatmapLayout } from "./liquidityHeatmapLayout";
import type { LiquiditySettings } from "./liquiditySettings";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** "#rrggbb" to its three channels; a bad value falls back to the given colour. */
export function parseRgb(hex: string, fallback: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const source = match ? match[1] : /^#?([0-9a-f]{6})$/i.exec(fallback)![1];
  const value = parseInt(source, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
}

export interface HeatmapHost {
  readonly grid: LiquidityGrid | null;
  readonly layout: HeatmapLayout | null;
  readonly settings: LiquiditySettings;
  readonly bidRgb: Rgb;
  readonly askRgb: Rgb;
  /** A cleared RGBA buffer of the given size, reused between frames. */
  imageBuffer(width: number, height: number): ImageData | null;
  /** An offscreen 2D context of the given size, reused between frames. */
  offscreen(width: number, height: number): CanvasRenderingContext2D | null;
  /** One of two offscreen 2D contexts that keep the settled heat between frames; resized, and so cleared, only when the size changes. */
  raster(slot: 0 | 1, width: number, height: number): CanvasRenderingContext2D | null;
  /** Ask for another frame after this long: the exact picture once the view has stood still. */
  scheduleRepaint(delayMs: number): void;
}
