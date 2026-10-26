// The Passive Liquidity chart layer: a lightweight-charts series primitive
// that owns the grid, the per-frame layout and the three renderers, and
// answers the tooltip. It holds no drawing rules of its own; each concern
// lives in its own file:
//
//   liquidityGrid.ts            the browser's copy of the server's columns
//   liquidityRuns.ts            what a level is and how it ends (the run model)
//   liquidityStyle.ts + friends how each market is coloured, sized and worded
//   liquidityHeatmapLayout.ts   where the columns, bands and ladder land on the pane
//   liquidityRunFinder.ts       the run model bound to one frame (floors, fates)
//   liquidityHeatRenderer.ts    the heat under the candles
//   liquidityLadderRenderer.ts  the size ladder beside the price axis
//   liquidityBandHover.ts       the band under the cursor, for the tooltip
//
// The picture is two things drawn from one grid. The heat: every visible cell
// of the time x price matrix, the settled part kept in a raster between
// frames and the live candle painted every frame. The ladder: for every band
// in view, a bar growing leftwards from the axis in proportion to the latest
// column's size.
// A hard reload is needed after editing this file: the class is instantiated
// once, so Vite's HMR does not swap the running instance.

import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { ChartRowsProvider } from "../../chart/chartData";
import { claimRightOffset } from "../../chart/rightOffsetRoom";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { bandAt } from "./liquidityBandHover";
import type { LiquidityGrid } from "./liquidityGrid";
import { LiquidityHeatRenderer } from "./liquidityHeatRenderer";
import { parseRgb, type HeatmapHost, type Rgb } from "./liquidityHeatmapHost";
import { computeHeatmapLayout, type HeatHistorySource, type HeatmapHistoryInfo, type HeatmapLayout } from "./liquidityHeatmapLayout";
import type { HistoryWant } from "./heatmapHistory";
import type { HeatLanes, LiquidityLaneChoice } from "./liquidityLanes";
import { LADDER_EDGE_GAP_PX, LADDER_LABEL_WIDTH_PX, LiquidityLadderBarsRenderer, LiquidityLadderLabelsRenderer, ladderReachPx } from "./liquidityLadderRenderer";
import { DEFAULT_LIQUIDITY_SETTINGS, historyDaysLabel, type LiquiditySettings } from "./liquiditySettings";

export type { BandState, WallHover } from "./liquidityBandHover";

/** Media px kept clear of the ladder numbers when the chart's right offset is nudged for them. */
const LADDER_MARGIN_PX = LADDER_LABEL_WIDTH_PX + 8;

/** "HEATMAP · LOADING 1 DAY" while the chosen reach of history is on its way; "HISTORY UNAVAILABLE" when the host refuses it; nothing once it is drawn. */
export function heatmapStatusText(info: HeatmapHistoryInfo | null): string | null {
  if (info === null) return null;
  if (info.loading) return `HEATMAP · LOADING ${historyDaysLabel(info.days).toUpperCase()}`;
  if (!info.drawn && info.unavailable !== null) return "HEATMAP · HISTORY UNAVAILABLE";
  return null;
}

class LiquidityStatusRenderer implements IPrimitivePaneRenderer {
  private readonly _host: HeatmapHost;

  constructor(host: HeatmapHost) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const text = heatmapStatusText(this._host.layout?.history ?? null);
    if (text === null) return;
    target.useMediaCoordinateSpace(({ context }) => drawStatusBadge(context, STATUS_BADGE_SLOT.heatmap, text));
  }
}

class LiquidityPaneView implements IPrimitivePaneView {
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

export class LiquidityHeatmapPrimitive implements ISeriesPrimitive<Time>, HeatmapHost {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _settings: LiquiditySettings = { ...DEFAULT_LIQUIDITY_SETTINGS };
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _freeRight: number | null = null;
  private _image: ImageData | null = null;
  private _offscreen: CanvasRenderingContext2D | null = null;
  private _rasters: [CanvasRenderingContext2D | null, CanvasRenderingContext2D | null] = [null, null];
  private _repaintTimer: ReturnType<typeof setTimeout> | null = null;
  grid: LiquidityGrid | null = null;
  lanes: HeatLanes | null = null;
  laneChoice: LiquidityLaneChoice = "auto";
  onLaneDrawn: ((lane: number) => void) | null = null;
  private _drawnLane = 0;
  history: (HeatHistorySource & { want(want: HistoryWant): void }) | null = null;
  onHistoryDrawn: ((info: HeatmapHistoryInfo | null) => void) | null = null;
  private _historyKey = "";
  layout: HeatmapLayout | null = null;
  bidRgb: Rgb = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.bidColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor);
  askRgb: Rgb = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor);

  private readonly _rows: ChartRowsProvider | null;

  constructor(rows: ChartRowsProvider | null = null) {
    this._rows = rows;
    this._paneViews = [
      new LiquidityPaneView("bottom", new LiquidityHeatRenderer(this)),
      new LiquidityPaneView("bottom", new LiquidityLadderBarsRenderer(this)),
      new LiquidityPaneView("top", new LiquidityLadderLabelsRenderer(this)),
      new LiquidityPaneView("top", new LiquidityStatusRenderer(this)),
    ];
  }

  get settings(): LiquiditySettings {
    return this._settings;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.grid = null;
    this._applyRightOffset();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._image = null;
    this._offscreen = null;
    this._rasters = [null, null];
    if (this._repaintTimer !== null) clearTimeout(this._repaintTimer);
    this._repaintTimer = null;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const grid = this.grid;
    this.layout = chart && series && grid ? computeHeatmapLayout(chart, series, grid, this._settings, this._rows?.() ?? null, this.lanes, this.laneChoice, this.history) : null;
    this._applyRightOffset();
    const freeRight = this.layout?.freeRight ?? null;
    if (freeRight !== this._freeRight) {
      this._freeRight = freeRight;
      this._requestUpdate?.();
    }
    const lane = this.layout?.lane ?? 0;
    if (lane !== this._drawnLane) {
      this._drawnLane = lane;
      this.onLaneDrawn?.(lane);
    }
    const want = this.layout?.historyWant ?? null;
    if (want !== null && this.history !== null) this.history.want(want);
    const info = this.layout?.history ?? null;
    const key = info === null ? "" : `${info.levelMs}:${info.rowFactor}:${info.days}:${info.loading}:${info.reachTs}:${info.drawn}:${info.refused}:${info.unavailable}`;
    if (key !== this._historyKey) {
      this._historyKey = key;
      this.onHistoryDrawn?.(info);
    }
  }

  ladderWidthPx(paneWidth: number): number {
    return LADDER_EDGE_GAP_PX + Math.max(LADDER_LABEL_WIDTH_PX, ladderReachPx(this, paneWidth, 1));
  }

  setHistory(history: (HeatHistorySource & { want(want: HistoryWant): void }) | null): void {
    this.history = history;
    this._requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  /** Point the layer at a grid (the hook owns it and keeps filling it); null clears the layer. */
  setGrid(grid: LiquidityGrid | null): void {
    this.grid = grid;
    this._applyRightOffset();
    this._requestUpdate?.();
  }

  setLanes(lanes: HeatLanes | null): void {
    this.lanes = lanes;
    this._requestUpdate?.();
  }

  setLaneChoice(choice: LiquidityLaneChoice): void {
    this.laneChoice = choice;
    this._requestUpdate?.();
  }

  /** The grid gained columns: repaint. */
  refresh(): void {
    this._requestUpdate?.();
  }

  setSettings(settings: LiquiditySettings): void {
    this._settings = settings;
    this.bidRgb = parseRgb(settings.bidColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    this.askRgb = parseRgb(settings.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor);
    this._applyRightOffset();
    this._requestUpdate?.();
  }

  /** The band under a pane coordinate (media px), for the tooltip. */
  levelAt(x: number, y: number) {
    const layout = this.layout;
    if (!layout) return null;
    return bandAt(layout.grid, layout, this._settings, x, y);
  }

  /** A cleared RGBA buffer of the given size, reused between frames. */
  imageBuffer(width: number, height: number): ImageData | null {
    const offscreen = this.offscreen(width, height);
    if (!offscreen) return null;
    if (this._image && this._image.width === width && this._image.height === height) {
      this._image.data.fill(0);
      return this._image;
    }
    this._image = offscreen.createImageData(width, height);
    return this._image;
  }

  /** An offscreen 2D context of the given size, reused between frames. */
  offscreen(width: number, height: number): CanvasRenderingContext2D | null {
    if (typeof document === "undefined") return null;
    if (!this._offscreen) {
      const canvas = document.createElement("canvas");
      this._offscreen = canvas.getContext("2d");
      if (!this._offscreen) return null;
    }
    const canvas = this._offscreen.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return this._offscreen;
  }

  /** One of the two canvases the settled heat is kept in between frames; resized, and so cleared, only when the size changes. */
  raster(slot: 0 | 1, width: number, height: number): CanvasRenderingContext2D | null {
    if (typeof document === "undefined") return null;
    let context = this._rasters[slot];
    if (!context && (width === 0 || height === 0)) return null;
    if (!context) {
      context = document.createElement("canvas").getContext("2d");
      if (!context) return null;
      this._rasters[slot] = context;
    }
    const canvas = context.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return context;
  }

  scheduleRepaint(delayMs: number): void {
    if (this._repaintTimer !== null) return;
    this._repaintTimer = setTimeout(() => {
      this._repaintTimer = null;
      this._requestUpdate?.();
    }, Math.max(1, delayMs));
  }

  /**
   * The ladder numbers live in the pane's right margin. While they are shown,
   * keep enough right offset (in bars, so it follows the zoom) that the newest
   * candles stay left of them; hand the chart's own offset back when they are
   * hidden.
   */
  private _applyRightOffset(): void {
    const chart = this._chart;
    if (!chart) return;
    const options = chart.timeScale().options();
    const shown = this.grid !== null && this._settings.showLadder && options.barSpacing > 0;
    claimRightOffset(chart, this, shown ? Math.ceil(LADDER_MARGIN_PX / options.barSpacing) : null);
  }
}
