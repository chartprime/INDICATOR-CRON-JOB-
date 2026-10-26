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
import type { DrawingPoint, TrendlineDrawing } from "../../chart/drawingStore";
import { hitTestTrendlines, snappedTimeToCoordinate, trendlinePixelPoints, type DrawingHit, type TrendlineHitCandidate } from "./trendlineGeometry";

const LINE_COLOR = "#2563eb";
const SELECTED_COLOR = "#f59e0b";
const LINE_WIDTH_PX = 1.6;
const SELECTED_WIDTH_PX = 2.4;
const PENDING_COLOR = "rgba(37, 99, 235, 0.55)";
const PENDING_DASH: [number, number] = [4, 4];
const HIT_TEST_TOLERANCE_PX = 5;

interface RenderLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  dash: readonly [number, number] | null;
}

class TrendlineRenderer implements IPrimitivePaneRenderer {
  private readonly _lines: readonly RenderLine[];

  constructor(lines: readonly RenderLine[]) {
    this._lines = lines;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const line of this._lines) {
          context.beginPath();
          context.strokeStyle = line.color;
          context.lineWidth = line.width;
          context.setLineDash(line.dash ?? []);
          context.moveTo(line.x1, line.y1);
          context.lineTo(line.x2, line.y2);
          context.stroke();
        }
      } finally {
        context.restore();
      }
    });
  }
}

class TrendlinePaneView implements IPrimitivePaneView {
  private readonly _primitive: TrendlinePrimitive;

  constructor(primitive: TrendlinePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new TrendlineRenderer(this._primitive.renderLines);
  }
}

export class TrendlinePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _seriesTimes: readonly number[] = [];
  private _drawings: readonly TrendlineDrawing[] = [];
  private _selectedId: string | null = null;
  private _pending: { first: DrawingPoint; cursor: DrawingPoint } | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _hitCandidates: readonly TrendlineHitCandidate[] = [];
  renderLines: readonly RenderLine[] = [];

  constructor() {
    this._paneViews = [new TrendlinePaneView(this)];
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
    if (!chart || !series) {
      this.renderLines = [];
      this._hitCandidates = [];
      return;
    }
    const timeScale = chart.timeScale();
    const timeToCoordinate = snappedTimeToCoordinate(
      (time: number) => timeScale.timeToCoordinate(time as Time),
      this._seriesTimes,
    );
    const priceToCoordinate = (price: number) => series.priceToCoordinate(price);

    const lines: RenderLine[] = [];
    const hitCandidates: TrendlineHitCandidate[] = [];
    for (const drawing of this._drawings) {
      const segment = trendlinePixelPoints(drawing, timeToCoordinate, priceToCoordinate);
      if (!segment) continue;
      const selected = drawing.id === this._selectedId;
      lines.push({
        ...segment,
        color: selected ? SELECTED_COLOR : LINE_COLOR,
        width: selected ? SELECTED_WIDTH_PX : LINE_WIDTH_PX,
        dash: null,
      });
      hitCandidates.push({ id: drawing.id, segment });
    }
    if (this._pending) {
      const x1 = timeToCoordinate(this._pending.first.time);
      const y1 = priceToCoordinate(this._pending.first.price);
      const x2 = timeToCoordinate(this._pending.cursor.time);
      const y2 = priceToCoordinate(this._pending.cursor.price);
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        lines.push({ x1, y1, x2, y2, color: PENDING_COLOR, width: LINE_WIDTH_PX, dash: PENDING_DASH });
      }
    }
    this.renderLines = lines;
    this._hitCandidates = hitCandidates;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setSeriesTimes(times: readonly number[]): void {
    this._seriesTimes = times;
    this._requestUpdate?.();
  }

  setDrawings(drawings: readonly TrendlineDrawing[]): void {
    this._drawings = drawings;
    this._requestUpdate?.();
  }

  setSelectedId(id: string | null): void {
    this._selectedId = id;
    this._requestUpdate?.();
  }

  setPending(pending: { first: DrawingPoint; cursor: DrawingPoint } | null): void {
    this._pending = pending;
    this._requestUpdate?.();
  }

  hitTestDrawing(x: number, y: number): DrawingHit | null {
    return hitTestTrendlines(this._hitCandidates, x, y, HIT_TEST_TOLERANCE_PX);
  }
}
