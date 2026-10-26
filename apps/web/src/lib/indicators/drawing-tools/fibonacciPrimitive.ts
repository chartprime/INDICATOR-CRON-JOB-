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
import type { DrawingPoint, FibonacciDrawing } from "../../chart/drawingStore";
import { fibonacciHitCandidates, fibonacciLevelPrice, fibonacciPixelLevels, FIBONACCI_LEVELS } from "./fibonacciGeometry";
import { hitTestTrendlines, snappedTimeToCoordinate, type DrawingHit, type TrendlineHitCandidate } from "./trendlineGeometry";

const LINE_COLOR = "#0d9488";
const SELECTED_COLOR = "#f59e0b";
const LINE_WIDTH_PX = 1.2;
const SELECTED_WIDTH_PX = 2;
const PENDING_COLOR = "rgba(13, 148, 136, 0.55)";
const PENDING_DASH: [number, number] = [4, 4];
const HIT_TEST_TOLERANCE_PX = 5;
const LABEL_FONT = "600 10px sans-serif";
const LABEL_OFFSET_PX = 4;

interface RenderLevel {
  x1: number;
  x2: number;
  y: number;
  color: string;
  width: number;
  dash: readonly [number, number] | null;
  label: string;
}

class FibonacciRenderer implements IPrimitivePaneRenderer {
  private readonly _levels: readonly RenderLevel[];

  constructor(levels: readonly RenderLevel[]) {
    this._levels = levels;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const level of this._levels) {
          context.beginPath();
          context.strokeStyle = level.color;
          context.lineWidth = level.width;
          context.setLineDash(level.dash ?? []);
          context.moveTo(level.x1, level.y);
          context.lineTo(level.x2, level.y);
          context.stroke();

          context.fillStyle = level.color;
          context.font = LABEL_FONT;
          context.textAlign = "left";
          context.textBaseline = "bottom";
          context.fillText(level.label, Math.max(level.x1, level.x2) + LABEL_OFFSET_PX, level.y - LABEL_OFFSET_PX);
        }
      } finally {
        context.restore();
      }
    });
  }
}

class FibonacciPaneView implements IPrimitivePaneView {
  private readonly _primitive: FibonacciPrimitive;

  constructor(primitive: FibonacciPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new FibonacciRenderer(this._primitive.renderLevels);
  }
}

function formatFibonacciLabel(fraction: number, price: number): string {
  return `${(fraction * 100).toFixed(1)}% ${price.toFixed(2)}`;
}

export class FibonacciPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _seriesTimes: readonly number[] = [];
  private _drawings: readonly FibonacciDrawing[] = [];
  private _selectedId: string | null = null;
  private _pending: { first: DrawingPoint; cursor: DrawingPoint } | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _hitCandidates: readonly TrendlineHitCandidate[] = [];
  renderLevels: readonly RenderLevel[] = [];

  constructor() {
    this._paneViews = [new FibonacciPaneView(this)];
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
      this.renderLevels = [];
      this._hitCandidates = [];
      return;
    }
    const timeScale = chart.timeScale();
    const timeToCoordinate = snappedTimeToCoordinate(
      (time: number) => timeScale.timeToCoordinate(time as Time),
      this._seriesTimes,
    );
    const priceToCoordinate = (price: number) => series.priceToCoordinate(price);

    const renderLevels: RenderLevel[] = [];
    const hitCandidates: TrendlineHitCandidate[] = [];
    for (const drawing of this._drawings) {
      const levels = fibonacciPixelLevels(drawing, timeToCoordinate, priceToCoordinate);
      if (!levels) continue;
      const selected = drawing.id === this._selectedId;
      for (const level of levels) {
        renderLevels.push({
          x1: level.x1,
          x2: level.x2,
          y: level.y,
          color: selected ? SELECTED_COLOR : LINE_COLOR,
          width: selected ? SELECTED_WIDTH_PX : LINE_WIDTH_PX,
          dash: null,
          label: formatFibonacciLabel(level.fraction, level.price),
        });
      }
      hitCandidates.push(...fibonacciHitCandidates(drawing.id, levels));
    }
    if (this._pending) {
      const x1 = timeToCoordinate(this._pending.first.time);
      const x2 = timeToCoordinate(this._pending.cursor.time);
      if (x1 !== null && x2 !== null) {
        for (const fraction of FIBONACCI_LEVELS) {
          const price = fibonacciLevelPrice(this._pending.first, this._pending.cursor, fraction);
          const y = priceToCoordinate(price);
          if (y === null) continue;
          renderLevels.push({
            x1, x2, y, color: PENDING_COLOR, width: LINE_WIDTH_PX, dash: PENDING_DASH,
            label: formatFibonacciLabel(fraction, price),
          });
        }
      }
    }
    this.renderLevels = renderLevels;
    this._hitCandidates = hitCandidates;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setSeriesTimes(times: readonly number[]): void {
    this._seriesTimes = times;
    this._requestUpdate?.();
  }

  setDrawings(drawings: readonly FibonacciDrawing[]): void {
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
