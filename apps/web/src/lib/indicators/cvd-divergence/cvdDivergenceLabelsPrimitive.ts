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
import type { BarFrame } from "../../../types/frames";
import type { Divergence } from "../delta-divergence/deltaDivergence";
import { CVD_TONE_COLORS } from "./cvdDivergence";

export const LABEL_FONT = "700 10px sans-serif";
export const BULLISH_LABEL_TEXT = "DiV+";
export const BEARISH_LABEL_TEXT = "DiV-";
export const CUMULATIVE_DIAMOND_GLYPH = "⯁";

export type DivergenceLabelStyle = "oscillator" | "cumulative";

export type DivergenceLabelMark = "plate" | "diamond";

export const BULLISH_LABEL_COLOR = CVD_TONE_COLORS.intenseUp;
export const BEARISH_LABEL_COLOR = CVD_TONE_COLORS.intenseDown;
export const LABEL_TEXT_COLOR = "#ffffff";

const LABEL_PAD_X_PX = 3;
const LABEL_PAD_Y_PX = 2;
export const LABEL_LINE_HEIGHT_PX = 12;
export const LABEL_PLATE_HEIGHT_PX = LABEL_LINE_HEIGHT_PX + LABEL_PAD_Y_PX * 2;
export const LABEL_ARROW_HALF_WIDTH_PX = 5;
export const LABEL_ARROW_HEIGHT_PX = 6;
export const LABEL_OFFSET_PX =
  LABEL_PLATE_HEIGHT_PX / 2 + LABEL_ARROW_HEIGHT_PX;

export interface RenderDivergenceArrow {
  x: number;
  apexY: number;
  baseY: number;
  halfWidth: number;
}

export interface RenderTextLabel {
  x: number;
  y: number;
  text: string;
  color: string;
  mark: DivergenceLabelMark;
  arrow: RenderDivergenceArrow;
}

export type RenderDivergenceLabel = RenderTextLabel;

export function divergenceLabelMark(
  style: DivergenceLabelStyle,
): DivergenceLabelMark {
  return style === "cumulative" ? "diamond" : "plate";
}

export function divergenceLabelText(type: Divergence["type"]): string {
  return type === "bullish" ? BULLISH_LABEL_TEXT : BEARISH_LABEL_TEXT;
}

export function divergenceLabelColor(type: Divergence["type"]): string {
  return type === "bullish" ? BULLISH_LABEL_COLOR : BEARISH_LABEL_COLOR;
}

export function buildDivergenceLabel(
  divergence: Divergence,
  x: number,
  y: number,
  style: DivergenceLabelStyle = "oscillator",
): RenderDivergenceLabel {
  const bullish = divergence.type === "bullish";
  const labelY = bullish ? y + LABEL_OFFSET_PX : y - LABEL_OFFSET_PX;
  const facingEdgeY = bullish
    ? labelY - LABEL_PLATE_HEIGHT_PX / 2
    : labelY + LABEL_PLATE_HEIGHT_PX / 2;
  const mark = divergenceLabelMark(style);
  return {
    x,
    y: labelY,
    text:
      mark === "diamond"
        ? CUMULATIVE_DIAMOND_GLYPH
        : divergenceLabelText(divergence.type),
    color: divergenceLabelColor(divergence.type),
    mark,
    arrow: {
      x,
      apexY: y,
      baseY: facingEdgeY,
      halfWidth: LABEL_ARROW_HALF_WIDTH_PX,
    },
  };
}

export function isLabelInRange(x: number, width: number): boolean {
  return x >= 0 && x <= width;
}

export function divergenceAnchorPrice(
  divergence: Divergence,
  bars: readonly BarFrame[],
): number | null {
  const bar = bars[divergence.priceTo.index];
  if (bar === undefined) return null;
  return divergence.type === "bullish" ? bar.low : bar.high;
}

export function buildDivergenceLabels(
  divergences: readonly Divergence[],
  bars: readonly BarFrame[],
  timeToCoordinate: (tsMs: number) => number | null,
  priceToCoordinate: (price: number) => number | null,
  width: number,
  style: DivergenceLabelStyle = "oscillator",
): RenderDivergenceLabel[] {
  const labels: RenderDivergenceLabel[] = [];
  for (const divergence of divergences) {
    const x = timeToCoordinate(divergence.priceTo.ts_open);
    const anchorPrice = divergenceAnchorPrice(divergence, bars);
    if (anchorPrice === null) continue;
    const y = priceToCoordinate(anchorPrice);
    if (x === null || y === null || !isLabelInRange(x, width)) continue;
    labels.push(buildDivergenceLabel(divergence, x, y, style));
  }
  return labels;
}

class DivergenceLabelRenderer implements IPrimitivePaneRenderer {
  private readonly _labels: readonly RenderDivergenceLabel[];

  constructor(labels: readonly RenderDivergenceLabel[]) {
    this._labels = labels;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        context.font = LABEL_FONT;
        context.textAlign = "center";
        context.textBaseline = "middle";
        for (const label of this._labels) {
          context.fillStyle = label.color;
          const { arrow } = label;
          context.beginPath();
          context.moveTo(arrow.x, arrow.apexY);
          context.lineTo(arrow.x - arrow.halfWidth, arrow.baseY);
          context.lineTo(arrow.x + arrow.halfWidth, arrow.baseY);
          context.closePath();
          context.fill();
          if (label.mark === "plate") {
            const width =
              context.measureText(label.text).width + LABEL_PAD_X_PX * 2;
            context.fillStyle = label.color;
            context.fillRect(
              label.x - width / 2,
              label.y - LABEL_PLATE_HEIGHT_PX / 2,
              width,
              LABEL_PLATE_HEIGHT_PX,
            );
          }
          context.fillStyle =
            label.mark === "diamond" ? label.color : LABEL_TEXT_COLOR;
          context.fillText(label.text, label.x, label.y);
        }
      } finally {
        context.restore();
      }
    });
  }
}

class DivergenceLabelPaneView implements IPrimitivePaneView {
  private readonly _primitive: CvdDivergenceLabelsPrimitive;

  constructor(primitive: CvdDivergenceLabelsPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DivergenceLabelRenderer(this._primitive.renderLabels);
  }
}

export class CvdDivergenceLabelsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _divergences: readonly Divergence[] = [];
  private _bars: readonly BarFrame[] = [];
  private _visible = true;
  private readonly _style: DivergenceLabelStyle;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderLabels: readonly RenderDivergenceLabel[] = [];

  constructor(style: DivergenceLabelStyle = "oscillator") {
    this._style = style;
    this._paneViews = [new DivergenceLabelPaneView(this)];
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
    this._bars = [];
    this.renderLabels = [];
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || !this._visible || this._divergences.length === 0) {
      this.renderLabels = [];
      return;
    }
    const timeScale = chart.timeScale();
    this.renderLabels = buildDivergenceLabels(
      this._divergences,
      this._bars,
      (tsMs) => timeScale.timeToCoordinate((tsMs / 1000) as Time),
      (price) => series.priceToCoordinate(price),
      timeScale.width(),
      this._style,
    );
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setDivergences(
    divergences: readonly Divergence[],
    bars: readonly BarFrame[],
  ): void {
    this._divergences = divergences;
    this._bars = bars;
    this._requestUpdate?.();
  }

  setLabelsVisible(visible: boolean): void {
    if (this._visible === visible) return;
    this._visible = visible;
    this._requestUpdate?.();
  }
}
