import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { BarFrame } from "../../../types/frames";
import type { ChartRowsProvider } from "../../chart/chartData";
import { claimRightOffset } from "../../chart/rightOffsetRoom";
import { neighbourWidthAt, onBaseHandle, onReachHandle, reachShareAt } from "./axisProfileLayout";

export const EASE_SHARE = 0.28;
export const EDGE_GAP_PX = 3;
export const NEIGHBOUR_GAP_PX = 8;
export const MIN_REACH_PX = 8;
export const MARKER_GAP_PX = 6;
export const MARKER_ARROW_PX = 8;
export const HANDLE_COLOR = "rgba(120, 115, 105, 0.55)";

export type HandleLine = "edge" | "base";

export interface RowMarker {
  color: string;
  yMid: number;
  tickTop: number;
  tickBottom: number;
  candleRight: number;
  right: number;
}

export function drawRowMarker(context: CanvasRenderingContext2D, hpr: number, vpr: number, marker: RowMarker): void {
  const yMid = Math.round(marker.yMid * vpr) + 0.5;
  const right = Math.round(marker.right * hpr);
  const base = Math.round((marker.candleRight + MARKER_GAP_PX) * hpr);
  const tip = base + Math.round(MARKER_ARROW_PX * hpr);
  context.fillStyle = marker.color;
  context.strokeStyle = marker.color;
  context.lineWidth = Math.max(1, Math.round(1.5 * vpr));
  context.beginPath();
  context.moveTo(tip, yMid);
  context.lineTo(base, yMid - MARKER_ARROW_PX * 0.6 * vpr);
  context.lineTo(base, yMid + MARKER_ARROW_PX * 0.6 * vpr);
  context.closePath();
  context.fill();
  context.setLineDash([Math.round(2 * hpr), Math.round(4 * hpr)]);
  context.beginPath();
  context.moveTo(tip, yMid);
  context.lineTo(right + EDGE_GAP_PX * hpr, yMid);
  context.stroke();
  context.setLineDash([]);
  const y0 = Math.round(marker.tickTop * vpr);
  const y1 = Math.max(y0 + 1, Math.round(marker.tickBottom * vpr));
  context.fillRect(right, y0, Math.max(1, Math.round(EDGE_GAP_PX * hpr)), y1 - y0);
}
const DEFAULT_BACKGROUND = "#1a1b1e";
const DEFAULT_FONT_FAMILY = "sans-serif";
const DEFAULT_INTERVAL_MS = 60_000;

export interface AxisNeighbour {
  widthPx(paneWidth: number): number;
  resize(widthPx: number, paneWidth: number): void;
}

export interface AxisProfileSource {
  readonly version: number;
  readonly rowWidth: number;
}

export interface AxisProfileBar {
  index: number;
  yTop: number;
  yBottom: number;
  share: number;
}

export interface AxisProfileFrame<TBar extends AxisProfileBar> {
  bars: readonly TBar[];
  widths: ReadonlyMap<number, number>;
  flash: ReadonlyMap<number, number>;
  lastIndex: number | null;
  candleRight: number;
  barSpacing: number;
  intervalMs: number;
  right: number;
  reach: number;
  rowPx: number;
  width: number;
  height: number;
}

export interface Flashes {
  flash: Map<number, number>;
  until: number;
}

export interface ChartLook {
  fontFamily: string;
  background: string;
}

export interface DrawSpace {
  context: CanvasRenderingContext2D;
  hpr: number;
  vpr: number;
  look: ChartLook;
}

type YOf = (price: number) => number | null;

class ProfilePaneView implements IPrimitivePaneView {
  private readonly _zOrder: PrimitivePaneViewZOrder;
  private readonly _renderer: IPrimitivePaneRenderer;

  constructor(zOrder: PrimitivePaneViewZOrder, renderer: IPrimitivePaneRenderer) {
    this._zOrder = zOrder;
    this._renderer = renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._zOrder;
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

class BarsRenderer<TBar extends AxisProfileBar> implements IPrimitivePaneRenderer {
  private readonly _host: AxisProfilePrimitive<AxisProfileSource, TBar, { widthShare: number }>;

  constructor(host: AxisProfilePrimitive<AxisProfileSource, TBar, { widthShare: number }>) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const frame = this._host.frame;
    if (!frame || frame.bars.length === 0) return;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      context.save();
      try {
        this._host.drawBars(frame, { context, hpr, vpr, look: this._host.chartLook() });
      } finally {
        context.restore();
      }
    });
  }
}

class LabelsRenderer<TBar extends AxisProfileBar> implements IPrimitivePaneRenderer {
  private readonly _host: AxisProfilePrimitive<AxisProfileSource, TBar, { widthShare: number }>;

  constructor(host: AxisProfilePrimitive<AxisProfileSource, TBar, { widthShare: number }>) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const frame = this._host.frame;
    if (!frame) return;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const right = Math.round(frame.right * hpr);
      context.save();
      try {
        context.fillStyle = HANDLE_COLOR;
        const lineWidth = Math.max(1, Math.round(hpr));
        const lineHeight = Math.round(frame.height * vpr);
        const shown = this._host.handlesShown();
        if (shown.edge) context.fillRect(right - Math.round(frame.reach * hpr), 0, lineWidth, lineHeight);
        if (shown.base) context.fillRect(right, 0, lineWidth, lineHeight);
        this._host.drawLabels(frame, { context, hpr, vpr, look: this._host.chartLook() });
      } finally {
        context.restore();
      }
    });
  }
}

export abstract class AxisProfilePrimitive<
  TSource extends AxisProfileSource,
  TBar extends AxisProfileBar,
  TSettings extends { widthShare: number },
> implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _source: TSource | null = null;
  private _settings: TSettings;
  private _neighbour: AxisNeighbour | null = null;
  private _hover: HandleLine | null = null;
  private _widths = new Map<number, number>();
  private _widthsFactor = 0;
  private _seenVersion = -1;
  private _settled = true;
  private _flashUntil = 0;
  private _loop: number | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private readonly _rows: ChartRowsProvider | null;
  private readonly _bars: () => readonly BarFrame[];
  frame: AxisProfileFrame<TBar> | null = null;

  constructor(settings: TSettings, bars: () => readonly BarFrame[], rows: ChartRowsProvider | null = null) {
    this._settings = settings;
    this._bars = bars;
    this._rows = rows;
    this._paneViews = [new ProfilePaneView("bottom", new BarsRenderer(this)), new ProfilePaneView("top", new LabelsRenderer(this))];
  }

  protected abstract _factor(intervalMs: number, baseRowPx: number): number;
  protected abstract _place(source: TSource, factor: number, yOf: YOf, height: number): TBar[];
  protected abstract _targetWidth(bar: TBar, roomPx: number, rowPx: number): number;
  protected abstract _markerIndex(source: TSource, factor: number): number | null;
  protected abstract _shareBounds(): readonly [number, number];
  abstract drawBars(frame: AxisProfileFrame<TBar>, space: DrawSpace): void;
  abstract drawLabels(frame: AxisProfileFrame<TBar>, space: DrawSpace): void;

  protected _flashes(_source: TSource, _factor: number, _now: number): Flashes {
    return { flash: new Map(), until: 0 };
  }

  protected _reservePx(): number {
    return 0;
  }

  protected _barEdgeGapPx(): number {
    return 0;
  }

  protected _anchorPrice(_source: TSource): number | undefined {
    return undefined;
  }

  protected _sourceChanged(): void {}

  protected _handlesAlwaysShown(): boolean {
    return true;
  }

  handlesShown(): { edge: boolean; base: boolean } {
    const always = this._handlesAlwaysShown();
    return { edge: always || this._hover === "edge", base: always || this._hover === "base" };
  }

  setHandleHover(line: HandleLine | null): void {
    if (line === this._hover) return;
    this._hover = line;
    this._requestUpdate?.();
  }

  protected _repaint(): void {
    this._requestUpdate?.();
  }

  protected _framed(_source: TSource, _bars: readonly BarFrame[]): void {}

  get settings(): TSettings {
    return this._settings;
  }

  get source(): TSource | null {
    return this._source;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this._applyRightOffset();
    if (this._source) this._startLoop();
  }

  detached(): void {
    this._stopLoop();
    this._source = null;
    this._applyRightOffset();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this.frame = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setSource(source: TSource | null): void {
    if (source === this._source) return;
    this._source = source;
    this._widths.clear();
    this._seenVersion = -1;
    this._settled = true;
    this.frame = null;
    this._sourceChanged();
    this._applyRightOffset();
    if (source && this._chart) this._startLoop();
    else this._stopLoop();
    this._requestUpdate?.();
  }

  setSettings(settings: TSettings): void {
    this._settings = settings;
    this._applyRightOffset();
    this._requestUpdate?.();
  }

  setNeighbour(neighbour: AxisNeighbour | null): void {
    this._neighbour = neighbour;
    this._applyRightOffset();
    this._requestUpdate?.();
  }

  private _insetPx(paneWidth: number): number {
    return this._neighbour === null ? 0 : this._neighbour.widthPx(paneWidth) + NEIGHBOUR_GAP_PX;
  }

  widthPx(paneWidth: number): number {
    if (this.frame !== null) return paneWidth - (this.frame.right - this.frame.reach);
    return this._settings.widthShare * paneWidth + this._insetPx(paneWidth) + EDGE_GAP_PX;
  }

  chartLook(): ChartLook {
    const layout = this._chart?.options().layout;
    const background = layout?.background;
    return {
      fontFamily: layout?.fontFamily ?? DEFAULT_FONT_FAMILY,
      background: background?.type === "solid" ? background.color : DEFAULT_BACKGROUND,
    };
  }

  handleAt(x: number, y: number): boolean {
    return this.frame !== null && onReachHandle(this.frame, x, y);
  }

  reachShareAt(x: number): number | null {
    if (this.frame === null) return null;
    const [min, max] = this._shareBounds();
    return reachShareAt(this.frame, x, min, max);
  }

  baseHandleAt(x: number, y: number): boolean {
    return this.frame !== null && this._neighbour !== null && onBaseHandle(this.frame, x, y);
  }

  resizeNeighbour(x: number): void {
    if (this.frame === null || this._neighbour === null) return;
    this._neighbour.resize(neighbourWidthAt(this.frame, x, EDGE_GAP_PX + NEIGHBOUR_GAP_PX), this.frame.width);
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const source = this._source;
    this.frame = null;
    if (!chart || !series || !source) return;
    const timeScale = chart.timeScale();
    const width = timeScale.width();
    const height = chart.paneSize().height;
    if (!(width > 0) || !(height > 0)) return;
    const yOf: YOf = (price) => {
      const y = series.priceToCoordinate(price);
      return y === null ? null : Number(y);
    };
    const bars = this._bars();
    const anchor = bars.at(-1)?.close ?? this._anchorPrice(source);
    if (anchor === undefined) return;
    const y0 = yOf(anchor);
    const y1 = yOf(anchor + source.rowWidth);
    if (y0 === null || y1 === null) return;
    const baseRowPx = Math.abs(y1 - y0);
    const intervalMs = bars.at(-1)?.interval_ms ?? DEFAULT_INTERVAL_MS;
    const factor = this._factor(intervalMs, baseRowPx);
    if (factor !== this._widthsFactor) {
      this._widths.clear();
      this._widthsFactor = factor;
    }
    const placed = this._place(source, factor, yOf, height);
    const inset = this._insetPx(width);
    const right = width - EDGE_GAP_PX - inset;
    const candleRight = this._lastCandleRight(series, timeScale);
    const reach = Math.max(MIN_REACH_PX, Math.min(this._settings.widthShare * width, right - candleRight - NEIGHBOUR_GAP_PX - this._reservePx()));
    const widths = new Map<number, number>();
    let settled = true;
    const roomPx = Math.max(0, reach - this._barEdgeGapPx());
    const rowPx = baseRowPx * factor;
    for (const bar of placed) {
      const target = this._targetWidth(bar, roomPx, rowPx);
      const current = this._widths.get(bar.index) ?? 0;
      const next = Math.abs(target - current) < 0.5 ? target : current + (target - current) * EASE_SHARE;
      if (next !== target) settled = false;
      widths.set(bar.index, next);
    }
    this._widths = widths;
    this._settled = settled;
    const { flash, until } = this._flashes(source, factor, Date.now());
    this._flashUntil = until;
    this._seenVersion = source.version;
    this.frame = {
      bars: placed,
      widths,
      flash,
      lastIndex: this._markerIndex(source, factor),
      candleRight,
      barSpacing: timeScale.options().barSpacing,
      intervalMs,
      right,
      reach,
      rowPx,
      width,
      height,
    };
    this._framed(source, bars);
  }

  private _lastCandleRight(series: ISeriesApi<SeriesType, Time>, timeScale: ReturnType<IChartApiBase<Time>["timeScale"]>): number {
    const rows = this._rows?.() ?? series.data();
    const last = rows[rows.length - 1];
    if (!last) return 0;
    const index = timeScale.timeToIndex(last.time, false);
    if (index === null) return 0;
    const x = timeScale.logicalToCoordinate(index as unknown as Logical);
    if (x === null) return 0;
    return Number(x) + timeScale.options().barSpacing / 2;
  }

  private _startLoop(): void {
    if (this._loop !== null || typeof requestAnimationFrame !== "function") return;
    const tick = () => {
      this._loop = null;
      const source = this._source;
      if (!source || !this._chart) return;
      if (source.version !== this._seenVersion || !this._settled || Date.now() < this._flashUntil) this._requestUpdate?.();
      this._loop = requestAnimationFrame(tick);
    };
    this._loop = requestAnimationFrame(tick);
  }

  private _stopLoop(): void {
    if (this._loop === null) return;
    cancelAnimationFrame(this._loop);
    this._loop = null;
  }

  restoreRoom(): void {
    if (this._source === null) return;
    this._applyRightOffset(true);
  }

  private _applyRightOffset(force = false): void {
    const chart = this._chart;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const options = timeScale.options();
    let wanted: number | null = null;
    if (this._source !== null && options.barSpacing > 0) {
      const width = timeScale.width();
      const inset = this._insetPx(width);
      const marginPx = this._settings.widthShare * width + inset + EDGE_GAP_PX + NEIGHBOUR_GAP_PX + this._reservePx();
      wanted = Math.ceil(marginPx / options.barSpacing);
    }
    claimRightOffset(chart, this, wanted, force);
  }
}
