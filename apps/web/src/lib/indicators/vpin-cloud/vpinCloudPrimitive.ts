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
import type { BarFrame, VpinReading } from "../../../types/frames";
import {
  CLOUD_BUY_RGB,
  CLOUD_LAYERS,
  CLOUD_SELL_RGB,
  buildCloudPoints,
  buildCloudPolygon,
  estimateBarDx,
  mapReadingsToBars,
  splitCloudRuns,
  type PolygonPoint,
  type VpinCloudRow,
} from "./vpinCloudGeometry";
import { computeVpinMotionState, scaleFillAlpha, type VpinMotionOptions, type VpinMotionState } from "./vpinCloudMotion";

export interface VpinCloudSettings {
  maxHeightPx: number;
}

export const DEFAULT_VPIN_CLOUD_SETTINGS: VpinCloudSettings = {
  maxHeightPx: 60,
};

const MAX_GAP_MULT = 2.2;
const OUTER_LAYER_INDEX = 0;
const BLOOM_ALPHA_BOOST = 0.6;
const EDGE_ALPHA_BOOST = 0.8;

interface RenderPolygon {
  points: readonly PolygonPoint[];
  fill: string;
  layerIndex: number;
}

class VpinCloudRenderer implements IPrimitivePaneRenderer {
  private readonly _polygons: readonly RenderPolygon[];

  constructor(polygons: readonly RenderPolygon[]) {
    this._polygons = polygons;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const polygon of this._polygons) {
        if (polygon.points.length < 3) continue;
        context.beginPath();
        context.moveTo(polygon.points[0].x, polygon.points[0].y);
        for (let i = 1; i < polygon.points.length; i += 1) {
          context.lineTo(polygon.points[i].x, polygon.points[i].y);
        }
        context.closePath();
        context.fillStyle = polygon.fill;
        context.fill();
      }
      context.restore();
    });
  }
}

class VpinCloudPaneView implements IPrimitivePaneView {
  private readonly _primitive: VpinCloudPrimitive;

  constructor(primitive: VpinCloudPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new VpinCloudRenderer(this._primitive.renderPolygons);
  }
}

function computePolygonsFromRows(
  chart: IChartApiBase<Time>,
  series: ISeriesApi<SeriesType, Time>,
  rows: readonly VpinCloudRow[],
  settings: VpinCloudSettings,
): RenderPolygon[] {
  if (rows.length === 0) return [];
  const chartWidth = Math.max(0, chart.timeScale().width());
  const points = buildCloudPoints(chart, series, chartWidth, rows);
  if (points.length === 0) return [];

  const buyPoints = points.filter((p) => p.buyStr > 0);
  const sellPoints = points.filter((p) => p.sellStr > 0);
  const barDx = estimateBarDx(points);
  const maxGap = barDx * MAX_GAP_MULT;
  const buyRuns = splitCloudRuns(buyPoints, maxGap);
  const sellRuns = splitCloudRuns(sellPoints, maxGap);

  const polygons: RenderPolygon[] = [];
  CLOUD_LAYERS.forEach(([frac, alpha], layerIndex) => {
    for (const run of buyRuns) {
      const points2 = buildCloudPolygon(run, settings.maxHeightPx, frac, true);
      if (points2.length > 0) polygons.push({ points: points2, fill: `rgba(${CLOUD_BUY_RGB},${alpha})`, layerIndex });
    }
    for (const run of sellRuns) {
      const points2 = buildCloudPolygon(run, settings.maxHeightPx, frac, false);
      if (points2.length > 0) polygons.push({ points: points2, fill: `rgba(${CLOUD_SELL_RGB},${alpha})`, layerIndex });
    }
  });
  return polygons;
}

function applyMotion(polygons: readonly RenderPolygon[], motion: VpinMotionState | null): readonly RenderPolygon[] {
  if (!motion || (motion.bloomPhase === 0 && motion.accelerationBoost === 0)) return polygons;
  const bloomMult = 1 + BLOOM_ALPHA_BOOST * motion.bloomPhase;
  const edgeMult = 1 + EDGE_ALPHA_BOOST * motion.accelerationBoost;
  return polygons.map((polygon) => {
    const multiplier = bloomMult * (polygon.layerIndex === OUTER_LAYER_INDEX ? edgeMult : 1);
    return multiplier === 1 ? polygon : { ...polygon, fill: scaleFillAlpha(polygon.fill, multiplier) };
  });
}

function applyDecayFade(polygons: readonly RenderPolygon[], decayPhase: number): readonly RenderPolygon[] {
  return polygons.map((polygon) => ({ ...polygon, fill: scaleFillAlpha(polygon.fill, decayPhase) }));
}

function isAnimatedMotion(motion: VpinMotionState | null): boolean {
  return motion !== null && (motion.bloomPhase > 0 || motion.decayPhase > 0);
}

export class VpinCloudPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _readings: readonly VpinReading[] = [];
  private _bars: readonly BarFrame[] = [];
  private _settings: VpinCloudSettings = DEFAULT_VPIN_CLOUD_SETTINGS;
  private _nowMs: number = Date.now();
  private _motionOptions: VpinMotionOptions = {};
  private _lastNonEmptyRows: readonly VpinCloudRow[] = [];
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderPolygons: readonly RenderPolygon[] = [];

  constructor() {
    this._paneViews = [new VpinCloudPaneView(this)];
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
    this._lastNonEmptyRows = [];
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) {
      this.renderPolygons = [];
      this._lastNonEmptyRows = [];
      return;
    }
    const motion = computeVpinMotionState(this._readings, this._nowMs, this._motionOptions);
    if (motion === null) {
      this.renderPolygons = [];
      this._lastNonEmptyRows = [];
      return;
    }
    const rows = mapReadingsToBars(this._readings, this._bars);
    const fresh = computePolygonsFromRows(chart, series, rows, this._settings);
    if (fresh.length > 0) {
      this._lastNonEmptyRows = rows;
      this.renderPolygons = applyMotion(fresh, motion);
      return;
    }
    if (motion && motion.decayPhase > 0) {
      const decayPolygons = computePolygonsFromRows(chart, series, this._lastNonEmptyRows, this._settings);
      this.renderPolygons = applyDecayFade(decayPolygons, motion.decayPhase);
      return;
    }
    this.renderPolygons = [];
    this._lastNonEmptyRows = [];
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setReadings(readings: readonly VpinReading[]): void {
    this._readings = readings;
    this._requestUpdate?.();
  }

  setBars(bars: readonly BarFrame[]): void {
    this._bars = bars;
    this._requestUpdate?.();
  }

  setSettings(settings: VpinCloudSettings): void {
    this._settings = settings;
    this._requestUpdate?.();
  }

  setMotionNow(nowMs: number): void {
    const previousMotion = computeVpinMotionState(this._readings, this._nowMs, this._motionOptions);
    this._nowMs = nowMs;
    const nextMotion = computeVpinMotionState(this._readings, this._nowMs, this._motionOptions);
    if (isAnimatedMotion(previousMotion) || isAnimatedMotion(nextMotion)) this._requestUpdate?.();
  }

  setMotionOptions(options: VpinMotionOptions): void {
    this._motionOptions = options;
    this._requestUpdate?.();
  }
}
