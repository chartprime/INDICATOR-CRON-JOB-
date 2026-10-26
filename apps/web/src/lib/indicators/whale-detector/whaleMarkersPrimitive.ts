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
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { formatTokenSize } from "../../chart/formatTokenSize";
import { clusterWhaleMarkers, deltaShareForCluster, displaySizeForCluster, type WhaleClusterMode, type WhaleMarkerCluster } from "./whaleMarkerClusters";
import {
  computeLocalMedianBaselines,
  hitTestWhaleMarkers,
  whaleMarkerFillOpacity,
  whaleMarkerRadiusPx,
  type WhaleHitCandidate,
} from "./whaleMarkerGeometry";
import type { WhaleTradeStat } from "./whaleTrades";

const BUY_STROKE = "#16a34a";
const BUY_FILL_RGB = "22, 163, 74";
const SELL_STROKE = "#dc2626";
const SELL_FILL_RGB = "220, 38, 38";
const STROKE_WIDTH_PX = 1.6;
const HIT_TEST_TOLERANCE_PX = 2;
const LABEL_COLOR = "#ffffff";
const LABEL_MIN_RADIUS_FOR_TEXT_PX = 10;
const MIN_LABEL_FONT_PX = 9;
const MAX_LABEL_FONT_PX = 20;
const LABEL_FONT_RADIUS_RATIO = 0.7;
const LABEL_FIT_RADIUS_MULTIPLIER = 1.7;

interface RenderPoint {
  x: number;
  y: number;
  radiusPx: number;
  fill: string;
  stroke: string;
  label: string;
  labelRounded: string;
}

function lowerBoundClusterTs(clusters: readonly WhaleMarkerCluster[], targetTs: number): number {
  let low = 0;
  let high = clusters.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (clusters[middle].ts < targetTs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundClusterTs(clusters: readonly WhaleMarkerCluster[], targetTs: number): number {
  let low = 0;
  let high = clusters.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (clusters[middle].ts <= targetTs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fitLabelWidth(
  context: CanvasRenderingContext2D,
  label: string,
  startFontPx: number,
  maxWidthPx: number,
): { fontSizePx: number; width: number } {
  context.font = `800 ${startFontPx}px sans-serif`;
  let width = context.measureText(label).width;
  if (width <= maxWidthPx) return { fontSizePx: startFontPx, width };
  const shrunkFontPx = Math.max(startFontPx * (maxWidthPx / width), MIN_LABEL_FONT_PX);
  context.font = `800 ${shrunkFontPx}px sans-serif`;
  width = context.measureText(label).width;
  return { fontSizePx: shrunkFontPx, width };
}

class WhaleMarkersRenderer implements IPrimitivePaneRenderer {
  private readonly _points: readonly RenderPoint[];

  constructor(points: readonly RenderPoint[]) {
    this._points = points;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        context.textAlign = "center";
        context.textBaseline = "middle";
        for (const point of this._points) {
          context.beginPath();
          context.arc(point.x, point.y, point.radiusPx, 0, Math.PI * 2);
          context.fillStyle = point.fill;
          context.fill();
          context.lineWidth = STROKE_WIDTH_PX;
          context.strokeStyle = point.stroke;
          context.stroke();

          if (point.radiusPx < LABEL_MIN_RADIUS_FOR_TEXT_PX) continue;
          const baseFontPx = Math.min(Math.max(point.radiusPx * LABEL_FONT_RADIUS_RATIO, MIN_LABEL_FONT_PX), MAX_LABEL_FONT_PX);
          const maxWidthPx = point.radiusPx * LABEL_FIT_RADIUS_MULTIPLIER;
          let label = point.label;
          let fit = fitLabelWidth(context, label, baseFontPx, maxWidthPx);
          if (fit.width > maxWidthPx && point.labelRounded !== point.label) {
            label = point.labelRounded;
            fit = fitLabelWidth(context, label, baseFontPx, maxWidthPx);
          }
          context.font = `800 ${fit.fontSizePx}px sans-serif`;
          context.fillStyle = LABEL_COLOR;
          context.fillText(label, point.x, point.y);
        }
      } finally {
        context.restore();
      }
    });
  }
}

class WhaleMarkersPaneView implements IPrimitivePaneView {
  private readonly _primitive: WhaleMarkersPrimitive;

  constructor(primitive: WhaleMarkersPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new WhaleMarkersRenderer(this._primitive.renderPoints);
  }
}

export class WhaleMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _clusters: readonly WhaleMarkerCluster[] = [];
  private _localMedians: readonly number[] = [];
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _hitCandidates: readonly WhaleHitCandidate<WhaleMarkerCluster>[] = [];
  renderPoints: readonly RenderPoint[] = [];

  constructor() {
    this._paneViews = [new WhaleMarkersPaneView(this)];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || this._clusters.length === 0) {
      this.renderPoints = [];
      this._hitCandidates = [];
      return;
    }
    const timeScale = chart.timeScale();
    const visibleRange = timeScale.getVisibleRange();
    const startIndex = visibleRange === null
      ? 0
      : lowerBoundClusterTs(this._clusters, Number(visibleRange.from) * 1000);
    const endIndex = visibleRange === null
      ? this._clusters.length
      : upperBoundClusterTs(this._clusters, Number(visibleRange.to) * 1000);
    const points: RenderPoint[] = [];
    const hitCandidates: WhaleHitCandidate<WhaleMarkerCluster>[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const cluster = this._clusters[index];
      const x = timeScale.timeToCoordinate((cluster.ts / 1000) as Time);
      const y = series.priceToCoordinate(cluster.price);
      if (x === null || y === null) continue;
      const isBuy = cluster.side === "buy";
      const radiusPx = whaleMarkerRadiusPx(cluster.magnitude, this._localMedians[index] ?? 0);
      const fillOpacity = whaleMarkerFillOpacity(cluster.count);
      const fill = `rgba(${isBuy ? BUY_FILL_RGB : SELL_FILL_RGB}, ${fillOpacity})`;
      points.push({
        x, y, radiusPx, fill, stroke: isBuy ? BUY_STROKE : SELL_STROKE,
        label: formatTokenSize(displaySizeForCluster(cluster)),
        labelRounded: formatTokenSize(displaySizeForCluster(cluster), 0),
      });
      hitCandidates.push({ x, y, radiusPx, value: cluster });
    }
    points.sort((a, b) => a.radiusPx - b.radiusPx);
    this.renderPoints = points;
    this._hitCandidates = hitCandidates;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setStats(
    stats: readonly WhaleTradeStat[],
    intervalMs: number,
    mode: WhaleClusterMode = "delta",
    minDeltaShare = 0,
  ): void {
    const clustered = clusterWhaleMarkers(stats, intervalMs, mode);
    this._clusters = mode === "delta" && minDeltaShare > 0
      ? clustered.filter((cluster) => deltaShareForCluster(cluster) >= minDeltaShare)
      : clustered;
    this._localMedians = computeLocalMedianBaselines(
      this._clusters.map((cluster) => ({ ts: cluster.ts, magnitude: cluster.magnitude })),
    );
    this._requestUpdate?.();
  }

  hitTestCluster(x: number, y: number): WhaleMarkerCluster | null {
    return hitTestWhaleMarkers(this._hitCandidates, x, y, HIT_TEST_TOLERANCE_PX);
  }

  getClusters(): readonly WhaleMarkerCluster[] {
    return this._clusters;
  }
}
