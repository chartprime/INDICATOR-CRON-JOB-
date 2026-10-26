import type { BarFrame } from "../../../types/frames";
import type { ChartRowsProvider } from "../../chart/chartData";
import type { LiquiditySide } from "../passive-liquidity/liquidityGrid";
import { labelFontPx, withAlpha } from "../axis-profile/axisProfileLayout";
import { AxisProfilePrimitive, MARKER_ARROW_PX, MARKER_GAP_PX, drawRowMarker, type AxisProfileFrame, type DrawSpace } from "../axis-profile/axisProfilePrimitive";
import { MAX_WIDTH_SHARE, MIN_WIDTH_SHARE } from "../live-delta-profile/liveDeltaProfileSettings";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../passive-liquidity/liquiditySettings";
import { formatDelta } from "../live-delta-profile/liveDeltaProfileNumbers";
import { bookBarPx, bookColumnPx, bookLabels, bookRowsReadable, layoutBook, spreadPrice, type BookBar } from "./bookProfileLayout";
import type { BookProfileSource } from "./bookProfileSource";
import { layoutResting, reconcileResting, restingFill, restingUntil, type RestingBar, type RestingShown } from "./restingOrderLayout";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, clusterRowsOf, type LiveOrderBookProfileSettings } from "./liveOrderBookProfileSettings";

export const BAR_EDGE_GAP_PX = 12;
export const BOOK_SPINE_PX = 3;
export const LABEL_INSET_PX = 3;
export const SPREAD_TICK_PX = 2;
export const RESTING_FONT_PX = 11;
export const RESTING_LABEL_PAD_PX = 4;
export const RESTING_REACH_MS = 15 * 60_000;
const LABEL_TEXT = "rgba(255, 255, 255, 0.95)";
const RESTING_TEXT = "#ffffff";
const LIVE_LINE = "Live Order Book Profile: book live";
const STALE_LINE = "Live Order Book Profile: book stale, nothing drawn until columns resume";

export type BookFrame = AxisProfileFrame<BookBar>;

type YOf = (price: number) => number | null;

export class LiveOrderBookProfilePrimitive extends AxisProfilePrimitive<BookProfileSource, BookBar, LiveOrderBookProfileSettings> {
  private _heatmap: Pick<LiquiditySettings, "clusterRows"> = DEFAULT_LIQUIDITY_SETTINGS;
  private _spreadY: number | null = null;
  private _spine: { top: number; bottom: number } | null = null;
  private _live = false;
  private _wasLive: boolean | null = null;
  private readonly _resting = new Map<string, RestingShown>();
  private _restingBars: RestingBar[] = [];
  private _restingUntil = 0;
  private _restingRule = "";
  private _labels: { frame: BookFrame; fontPx: number; bars: BookBar[] } | null = null;

  constructor(bars: () => readonly BarFrame[], rows: ChartRowsProvider | null = null) {
    super({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS }, bars, rows);
  }

  get spreadY(): number | null {
    return this._spreadY;
  }

  get restingBars(): readonly RestingBar[] {
    return this._restingBars;
  }

  get restingUntil(): number {
    return this._restingUntil;
  }

  private _clearResting(): void {
    this._resting.clear();
    this._restingBars = [];
    this._restingUntil = 0;
  }

  private _placeResting(source: BookProfileSource, factor: number, yOf: YOf, height: number): void {
    if (!this.settings.showResting) {
      this._clearResting();
      return;
    }
    const rule = `${this.settings.restingMinSize}:${this.settings.restingStandS}`;
    if (rule !== this._restingRule) {
      this._restingRule = rule;
      this._clearResting();
    }
    const now = source.clockMs();
    reconcileResting(this._resting, source.resting(this.settings.restingMinSize, this.settings.restingStandS * 1_000), now);
    const bands = source.bands(factor);
    const sizeOf = (side: LiquiditySide, band: number) => bands.find((row) => row.index === band)?.[side] ?? 0;
    this._restingBars = layoutResting(this._resting, source.rowWidth, factor, sizeOf, yOf, height, now);
    this._restingUntil = restingUntil(this._resting);
  }

  setHeatmapSettings(settings: Pick<LiquiditySettings, "clusterRows">): void {
    this._heatmap = settings;
    this._repaint();
  }

  protected override _sourceChanged(): void {
    this._spreadY = null;
    this._wasLive = null;
    this._clearResting();
  }

  protected override _anchorPrice(source: BookProfileSource): number | undefined {
    return spreadPrice(source.spread(source.clockMs()), source.rowWidth) ?? source.bands(1)[0]?.price;
  }

  protected _factor(intervalMs: number): number {
    return clusterRowsOf(this.settings, this._heatmap, intervalMs);
  }

  protected _place(source: BookProfileSource, factor: number, yOf: YOf, height: number): BookBar[] {
    const now = source.clockMs();
    this._live = source.live(now);
    if (!this._live) {
      this._spreadY = null;
      this._clearResting();
      return [];
    }
    const price = spreadPrice(source.spread(now), source.rowWidth);
    this._spreadY = price === null ? null : yOf(price);
    const extent = source.extent();
    const top = extent === null ? null : yOf((extent.highRow + 1) * source.rowWidth);
    const bottom = extent === null ? null : yOf(extent.lowRow * source.rowWidth);
    this._spine = top === null || bottom === null ? null : { top: Math.min(top, bottom), bottom: Math.max(top, bottom) };
    this._placeResting(source, factor, yOf, height);
    return layoutBook(source.bands(factor), yOf, height);
  }

  protected override _flashes(): { flash: Map<number, number>; until: number } {
    return { flash: new Map(), until: this._restingUntil };
  }

  protected override _framed(): void {
    if (this._live === this._wasLive) return;
    this._wasLive = this._live;
    if (this._live) console.info(LIVE_LINE);
    else console.warn(STALE_LINE);
  }

  protected _targetWidth(bar: BookBar, roomPx: number, rowPx: number): number {
    const fontPx = labelFontPx(rowPx);
    if (!bookRowsReadable(rowPx)) return bookColumnPx(bar.share, roomPx, fontPx, rowPx);
    return bookBarPx(bar.share, roomPx, formatDelta(bar.size), fontPx);
  }

  protected _markerIndex(): number | null {
    return null;
  }

  protected _shareBounds(): readonly [number, number] {
    return [MIN_WIDTH_SHARE, MAX_WIDTH_SHARE];
  }

  protected override _barEdgeGapPx(): number {
    return BAR_EDGE_GAP_PX;
  }

  protected override _reservePx(): number {
    return MARKER_GAP_PX + MARKER_ARROW_PX;
  }

  protected override _handlesAlwaysShown(): boolean {
    return false;
  }

  drawBars(frame: BookFrame, { context, hpr, vpr, look }: DrawSpace): void {
    const settings = this.settings;
    const right = Math.round(frame.right * hpr);
    const bid = withAlpha(settings.bidColor, settings.opacity);
    const ask = withAlpha(settings.askColor, settings.opacity);
    this._drawSpine(context, right, hpr, vpr, bid, ask);
    for (const bar of frame.bars) {
      const width = Math.round((frame.widths.get(bar.index) ?? 0) * hpr);
      const y0 = Math.round(bar.yTop * vpr);
      const y1 = Math.max(y0 + 1, Math.round(bar.yBottom * vpr));
      context.fillStyle = bar.side === "bid" ? bid : ask;
      context.fillRect(right - width, y0, width, y1 - y0);
    }
    this._drawRestingBars(frame, { context, hpr, vpr, look });
  }

  drawLabels(frame: BookFrame, { context, hpr, vpr, look }: DrawSpace): void {
    const settings = this.settings;
    const right = Math.round(frame.right * hpr);
    if (this._spreadY !== null) {
      drawRowMarker(context, hpr, vpr, {
        color: settings.spreadColor,
        yMid: this._spreadY,
        tickTop: this._spreadY - SPREAD_TICK_PX,
        tickBottom: this._spreadY + SPREAD_TICK_PX,
        candleRight: frame.candleRight,
        right: frame.right,
      });
    }
    const source = this.source;
    if (settings.showNumbers && source !== null) {
      const fontPx = Math.round(labelFontPx(frame.rowPx) * vpr);
      context.font = `600 ${fontPx}px ${look.fontFamily}`;
      context.textBaseline = "middle";
      context.textAlign = "right";
      context.fillStyle = LABEL_TEXT;
      for (const bar of this._labelled(frame, fontPx / vpr)) context.fillText(source.label(bar.size), right - LABEL_INSET_PX * hpr, ((bar.yTop + bar.yBottom) / 2) * vpr);
    }
    this._drawRestingLabels(frame, { context, hpr, vpr, look });
  }

  private _drawSpine(context: CanvasRenderingContext2D, right: number, hpr: number, vpr: number, bid: string, ask: string): void {
    const spine = this._spine;
    const mid = this._spreadY;
    if (spine === null || mid === null) return;
    const width = Math.round(BOOK_SPINE_PX * hpr);
    const top = Math.round(spine.top * vpr);
    const split = Math.round(Math.min(spine.bottom, Math.max(spine.top, mid)) * vpr);
    const bottom = Math.round(spine.bottom * vpr);
    if (split > top) {
      context.fillStyle = ask;
      context.fillRect(right - width, top, width, split - top);
    }
    if (bottom > split) {
      context.fillStyle = bid;
      context.fillRect(right - width, split, width, bottom - split);
    }
  }

  private _labelled(frame: BookFrame, fontPx: number): BookBar[] {
    const cached = this._labels;
    if (cached !== null && cached.frame === frame && cached.fontPx === fontPx) return cached.bars;
    const bars = bookLabels(frame.bars, fontPx);
    this._labels = { frame, fontPx, bars };
    return bars;
  }

  private _restingFont(context: CanvasRenderingContext2D, vpr: number, fontFamily: string): void {
    context.font = `600 ${Math.round(RESTING_FONT_PX * vpr)}px ${fontFamily}`;
    context.textBaseline = "middle";
    context.textAlign = "right";
  }

  private _restingStubPx(context: CanvasRenderingContext2D, hpr: number, size: number): number {
    return Math.round(context.measureText(formatDelta(size)).width + (LABEL_INSET_PX + RESTING_LABEL_PAD_PX) * hpr);
  }

  private _drawRestingBars(frame: BookFrame, { context, hpr, vpr, look }: DrawSpace): void {
    if (this._restingBars.length === 0) return;
    const settings = this.settings;
    const edge = Math.round(frame.right * hpr);
    const cap = edge - frame.candleRight * hpr + (RESTING_REACH_MS / frame.intervalMs) * frame.barSpacing * hpr;
    const reach = Math.min(settings.restingShare * frame.width * hpr, cap);
    this._restingFont(context, vpr, look.fontFamily);
    for (const bar of this._restingBars) {
      const stub = this._restingStubPx(context, hpr, bar.size);
      const length = Math.round(bar.share * reach);
      if (length <= stub) continue;
      const y0 = Math.round(bar.yTop * vpr);
      const y1 = Math.max(y0 + 1, Math.round(bar.yBottom * vpr));
      context.fillStyle = restingFill(bar.side === "bid" ? settings.bidColor : settings.askColor, bar.flash, bar.alpha * settings.opacity);
      context.fillRect(edge - length, y0, length - stub, y1 - y0);
    }
  }

  private _drawRestingLabels(frame: BookFrame, { context, hpr, vpr, look }: DrawSpace): void {
    if (this._restingBars.length === 0) return;
    const settings = this.settings;
    const edge = Math.round(frame.right * hpr);
    this._restingFont(context, vpr, look.fontFamily);
    for (const bar of this._restingBars) {
      const stub = this._restingStubPx(context, hpr, bar.size);
      const y0 = Math.round(bar.yTop * vpr);
      const y1 = Math.max(y0 + 1, Math.round(bar.yBottom * vpr));
      context.fillStyle = restingFill(bar.side === "bid" ? settings.bidColor : settings.askColor, bar.flash, bar.alpha * settings.opacity);
      context.fillRect(edge - stub, y0, stub, y1 - y0);
      context.fillStyle = withAlpha(RESTING_TEXT, bar.alpha);
      context.fillText(formatDelta(bar.size), edge - LABEL_INSET_PX * hpr, (y0 + y1) / 2);
    }
  }
}
