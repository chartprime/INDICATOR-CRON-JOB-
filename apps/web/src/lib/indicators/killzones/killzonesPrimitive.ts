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
import type { KillzoneOccurrence, KillzoneSessionDef } from "./killzones";

const LABEL_FONT = "700 26px sans-serif";
const LABEL_OPACITY = 0.16;
const PIVOT_LINE_WIDTH_PX = 1.2;
const PIVOT_LABEL_FONT = "600 10px sans-serif";
const PIVOT_LABEL_OFFSET_PX = 3;

interface RenderBox {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fill: string;
  color: string;
  label: string;
}

interface RenderPivotLine {
  x1: number;
  x2: number;
  y: number;
  color: string;
  label: string;
  labelAbove: boolean;
}

export interface KillzoneSessionInput {
  session: KillzoneSessionDef;
  occurrences: readonly KillzoneOccurrence[];
}

class KillzonesBoxRenderer implements IPrimitivePaneRenderer {
  private readonly _boxes: readonly RenderBox[];

  constructor(boxes: readonly RenderBox[]) {
    this._boxes = boxes;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      for (const box of this._boxes) {
        const width = box.x2 - box.x1;
        const height = box.yBottom - box.yTop;
        if (width <= 0 || height <= 0) continue;
        context.fillStyle = box.fill;
        context.fillRect(box.x1, box.yTop, width, height);

        context.save();
        context.globalAlpha = LABEL_OPACITY;
        context.fillStyle = box.color;
        context.font = LABEL_FONT;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(box.label, (box.x1 + box.x2) / 2, (box.yTop + box.yBottom) / 2);
        context.restore();
      }
    });
  }
}

class KillzonesLineRenderer implements IPrimitivePaneRenderer {
  private readonly _lines: readonly RenderPivotLine[];

  constructor(lines: readonly RenderPivotLine[]) {
    this._lines = lines;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      for (const line of this._lines) {
        context.strokeStyle = line.color;
        context.lineWidth = PIVOT_LINE_WIDTH_PX;
        context.beginPath();
        context.moveTo(line.x1, line.y);
        context.lineTo(line.x2, line.y);
        context.stroke();

        context.fillStyle = line.color;
        context.font = PIVOT_LABEL_FONT;
        context.textAlign = "left";
        context.textBaseline = line.labelAbove ? "bottom" : "top";
        const labelY = line.labelAbove ? line.y - PIVOT_LABEL_OFFSET_PX : line.y + PIVOT_LABEL_OFFSET_PX;
        context.fillText(line.label, line.x1, labelY);
      }
    });
  }
}

class KillzonesBoxPaneView implements IPrimitivePaneView {
  private readonly _primitive: KillzonesPrimitive;

  constructor(primitive: KillzonesPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new KillzonesBoxRenderer(this._primitive.renderBoxes);
  }
}

class KillzonesLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: KillzonesPrimitive;

  constructor(primitive: KillzonesPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new KillzonesLineRenderer(this._primitive.renderLines);
  }
}

export class KillzonesPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _sessions: readonly KillzoneSessionInput[] = [];
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBoxes: readonly RenderBox[] = [];
  renderLines: readonly RenderPivotLine[] = [];

  constructor() {
    this._paneViews = [new KillzonesBoxPaneView(this), new KillzonesLinePaneView(this)];
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
    if (!chart || !series || this._sessions.length === 0) {
      this.renderBoxes = [];
      this.renderLines = [];
      return;
    }
    const timeScale = chart.timeScale();
    const barSpacing = timeScale.options().barSpacing;
    const boxes: RenderBox[] = [];
    const lines: RenderPivotLine[] = [];

    for (const { session, occurrences } of this._sessions) {
      for (let i = 0; i < occurrences.length; i += 1) {
        const occurrence = occurrences[i];
        const x1 = timeScale.timeToCoordinate((occurrence.startMs / 1000) as Time);
        const xBoxEnd = timeScale.timeToCoordinate((occurrence.boxEndMs / 1000) as Time);
        const yTop = series.priceToCoordinate(occurrence.high);
        const yBottom = series.priceToCoordinate(occurrence.low);
        if (x1 !== null && xBoxEnd !== null && yTop !== null && yBottom !== null) {
          boxes.push({ x1, x2: xBoxEnd + barSpacing, yTop, yBottom, fill: session.boxColor, color: session.lineColor, label: session.label });
        }

        const xHighEnd = timeScale.timeToCoordinate((occurrence.highLineEndMs / 1000) as Time);
        if (x1 !== null && xHighEnd !== null && yTop !== null) {
          lines.push({ x1, x2: xHighEnd, y: yTop, color: session.lineColor, label: `${session.label}.H`, labelAbove: true });
        }
        const xLowEnd = timeScale.timeToCoordinate((occurrence.lowLineEndMs / 1000) as Time);
        if (x1 !== null && xLowEnd !== null && yBottom !== null) {
          lines.push({ x1, x2: xLowEnd, y: yBottom, color: session.lineColor, label: `${session.label}.L`, labelAbove: false });
        }
      }
    }

    this.renderBoxes = boxes;
    this.renderLines = lines;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setSessions(sessions: readonly KillzoneSessionInput[]): void {
    this._sessions = sessions;
    this._requestUpdate?.();
  }
}
