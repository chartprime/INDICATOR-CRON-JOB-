import type { BarFrame } from "../../../types/frames";
import type { ChartRowsProvider } from "../../chart/chartData";
import { AxisProfilePrimitive, MARKER_ARROW_PX, MARKER_GAP_PX, drawRowMarker, type AxisProfileFrame, type DrawSpace } from "../axis-profile/axisProfilePrimitive";
import type { DeltaSource } from "./candleDeltaSource";
import { StatusLog, barPx, fitsInside, labelFontPx, layoutDelta, mergeRows, placeLabels, profileStatus, withAlpha, type DeltaBar } from "./deltaProfileLayout";
import { formatDelta } from "./liveDeltaProfileNumbers";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, MAX_WIDTH_SHARE, MIN_WIDTH_SHARE, drawnRowFactor, rowFactorFor, type LiveDeltaProfileSettings } from "./liveDeltaProfileSettings";

export { EASE_SHARE, EDGE_GAP_PX, MARKER_ARROW_PX, MARKER_GAP_PX, MIN_REACH_PX, NEIGHBOUR_GAP_PX, type AxisNeighbour } from "../axis-profile/axisProfilePrimitive";
export const FLASH_MS = 420;
export const BAR_EDGE_GAP_PX = 12;
const LABEL_BG_ALPHA = 0.85;
const INSIDE_TEXT = "rgba(255, 255, 255, 0.95)";

export type DeltaFrame = AxisProfileFrame<DeltaBar>;

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [128, 128, 128];
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export class LiveDeltaProfilePrimitive extends AxisProfilePrimitive<DeltaSource, DeltaBar, LiveDeltaProfileSettings> {
  private readonly _status = new StatusLog();

  constructor(bars: () => readonly BarFrame[], rows: ChartRowsProvider | null = null) {
    super({ ...DEFAULT_LIVE_DELTA_PROFILE_SETTINGS }, bars, rows);
  }

  get store(): DeltaSource | null {
    return this.source;
  }

  setStore(store: DeltaSource | null): void {
    this.setSource(store);
  }

  protected override _sourceChanged(): void {
    this._status.reset();
  }

  protected override _framed(source: DeltaSource, bars: readonly BarFrame[]): void {
    this._status.report(profileStatus(source, bars));
  }

  protected override _anchorPrice(source: DeltaSource): number | undefined {
    return source.rows().at(-1)?.price;
  }

  protected _factor(intervalMs: number, baseRowPx: number): number {
    return drawnRowFactor(rowFactorFor(this.settings, intervalMs), baseRowPx);
  }

  protected _place(source: DeltaSource, factor: number, yOf: (price: number) => number | null, height: number): DeltaBar[] {
    return layoutDelta(mergeRows(source.rows(), source.rowWidth, factor), yOf, height);
  }

  protected _targetWidth(bar: DeltaBar, roomPx: number, rowPx: number): number {
    return barPx(bar.share, roomPx, formatDelta(bar.net), labelFontPx(rowPx));
  }

  protected _markerIndex(source: DeltaSource, factor: number): number | null {
    return source.lastIndex === null ? null : Math.floor(source.lastIndex / factor);
  }

  protected _shareBounds(): readonly [number, number] {
    return [MIN_WIDTH_SHARE, MAX_WIDTH_SHARE];
  }

  protected override _reservePx(): number {
    return MARKER_GAP_PX + MARKER_ARROW_PX;
  }

  protected override _barEdgeGapPx(): number {
    return BAR_EDGE_GAP_PX;
  }

  protected override _flashes(source: DeltaSource, factor: number, now: number): { flash: Map<number, number>; until: number } {
    const flash = new Map<number, number>();
    let until = 0;
    for (const recent of source.recent) {
      const age = now - recent.at;
      if (age >= FLASH_MS) continue;
      const index = Math.floor(recent.index / factor);
      flash.set(index, Math.max(flash.get(index) ?? 0, 1 - age / FLASH_MS));
      until = Math.max(until, recent.at + FLASH_MS);
    }
    return { flash, until };
  }

  drawBars(frame: DeltaFrame, { context, hpr, vpr }: DrawSpace): void {
    const settings = this.settings;
    const right = Math.round(frame.right * hpr);
    for (const bar of frame.bars) {
      const y0 = Math.round(bar.yTop * vpr);
      const y1 = Math.max(y0 + 1, Math.round(bar.yBottom * vpr));
      const gap = y1 - y0 >= 4 ? 1 : 0;
      const width = Math.max(bar.net === 0 ? 0 : 1, Math.round((frame.widths.get(bar.index) ?? 0) * hpr));
      const flash = frame.flash.get(bar.index) ?? 0;
      if (width > 0) {
        context.fillStyle = rgba(bar.net >= 0 ? settings.buyColor : settings.sellColor, settings.opacity + (1 - settings.opacity) * flash);
        context.fillRect(right - width, y0 + gap, width, Math.max(1, y1 - y0 - gap * 2));
      }
    }
  }

  drawLabels(frame: DeltaFrame, { context, hpr, vpr, look }: DrawSpace): void {
    const settings = this.settings;
    const right = Math.round(frame.right * hpr);
    const last = frame.lastIndex === null ? undefined : frame.bars.find((bar) => bar.index === frame.lastIndex);
    if (last) {
      drawRowMarker(context, hpr, vpr, {
        color: settings.markerColor,
        yMid: (last.yTop + last.yBottom) / 2,
        tickTop: last.yTop,
        tickBottom: last.yBottom,
        candleRight: frame.candleRight,
        right: frame.right,
      });
    }
    if (settings.showNumbers) {
      const mediaFontPx = labelFontPx(frame.rowPx);
      const fontPx = Math.round(mediaFontPx * vpr);
      context.font = `600 ${fontPx}px ${look.fontFamily}`;
      context.textBaseline = "middle";
      context.textAlign = "right";
      for (const bar of placeLabels(frame.bars, mediaFontPx)) {
        const text = formatDelta(bar.net);
        const width = Math.round((frame.widths.get(bar.index) ?? 0) * hpr);
        const textWidth = context.measureText(text).width;
        const yMid = ((bar.yTop + bar.yBottom) / 2) * vpr;
        if (fitsInside(width / hpr, textWidth / hpr)) {
          context.fillStyle = INSIDE_TEXT;
          context.fillText(text, right - 3 * hpr, yMid);
        } else {
          const x = right - width - 3 * hpr;
          context.fillStyle = withAlpha(look.background, LABEL_BG_ALPHA);
          context.fillRect(x - textWidth - 2 * hpr, Math.round(yMid - fontPx / 2 - hpr), textWidth + 4 * hpr, fontPx + 2 * hpr);
          context.fillStyle = bar.net >= 0 ? settings.buyColor : settings.sellColor;
          context.fillText(text, x, yMid);
        }
      }
    }
  }
}
