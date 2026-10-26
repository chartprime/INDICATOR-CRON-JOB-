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
import type { Divergence } from "./deltaDivergence";
import {
  buildDivergenceRenderBands,
  buildDivergenceRenderLines,
  DIVERGENCE_LINE_WIDTH_PX,
  isDivergenceVisible,
  type DivergenceLinePalette,
  type DivergenceRenderBand,
  type DivergenceRenderLine,
  type DivergenceValueKind,
} from "./deltaDivergenceGeometry";

class DivergenceBandRenderer implements IPrimitivePaneRenderer {
  private readonly _bands: readonly DivergenceRenderBand[];

  constructor(bands: readonly DivergenceRenderBand[]) {
    this._bands = bands;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      for (const band of this._bands) {
        const width = band.x2 - band.x1;
        if (width <= 0) continue;
        context.fillStyle = band.color;
        context.fillRect(band.x1, 0, width, mediaSize.height);
      }
      context.restore();
    });
  }
}

class DivergenceLineRenderer implements IPrimitivePaneRenderer {
  private readonly _lines: readonly DivergenceRenderLine[];

  constructor(lines: readonly DivergenceRenderLine[]) {
    this._lines = lines;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const line of this._lines) {
        context.strokeStyle = line.color;
        context.lineWidth = DIVERGENCE_LINE_WIDTH_PX;
        context.beginPath();
        context.moveTo(line.x1, line.y1);
        context.lineTo(line.x2, line.y2);
        context.stroke();
      }
      context.restore();
    });
  }
}

class DivergenceBandPaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaDivergencePrimitive;

  constructor(primitive: DeltaDivergencePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DivergenceBandRenderer(this._primitive.renderBands);
  }
}

class DivergenceLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaDivergencePrimitive;

  constructor(primitive: DeltaDivergencePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DivergenceLineRenderer(this._primitive.renderLines);
  }
}

export class DeltaDivergencePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _divergences: readonly Divergence[] = [];
  private _linePalette: DivergenceLinePalette | undefined;
  private _showBands = true;
  private readonly _valueKind: DivergenceValueKind;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBands: readonly DivergenceRenderBand[] = [];
  renderLines: readonly DivergenceRenderLine[] = [];

  constructor(valueKind: DivergenceValueKind) {
    this._valueKind = valueKind;
    this._paneViews = [
      new DivergenceBandPaneView(this),
      new DivergenceLinePaneView(this),
    ];
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
    this._divergences = [];
    this._linePalette = undefined;
    this._showBands = true;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || this._divergences.length === 0) {
      this.renderBands = [];
      this.renderLines = [];
      return;
    }
    const timeScale = chart.timeScale();
    const visibleRange = timeScale.getVisibleRange();
    const visibleDivergences =
      visibleRange === null
        ? this._divergences
        : this._divergences.filter((divergence) =>
            isDivergenceVisible(
              divergence,
              Number(visibleRange.from),
              Number(visibleRange.to),
            ),
          );

    const timeToCoordinate = (tsMs: number) =>
      timeScale.timeToCoordinate((tsMs / 1000) as Time);
    const valueToCoordinate = (value: number) =>
      series.priceToCoordinate(value);

    this.renderBands = this._showBands
      ? buildDivergenceRenderBands(visibleDivergences, timeToCoordinate)
      : [];
    this.renderLines = buildDivergenceRenderLines(
      visibleDivergences,
      this._valueKind,
      timeToCoordinate,
      valueToCoordinate,
      this._linePalette,
    );
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setLinePalette(palette: DivergenceLinePalette | undefined): void {
    this._linePalette = palette;
    this._requestUpdate?.();
  }

  setBandsVisible(visible: boolean): void {
    if (this._showBands === visible) return;
    this._showBands = visible;
    this._requestUpdate?.();
  }

  setDivergences(divergences: readonly Divergence[]): void {
    this._divergences = divergences;
    this._requestUpdate?.();
  }
}
