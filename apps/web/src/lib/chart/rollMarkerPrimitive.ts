import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export type HistoricalRollMarker = Readonly<{
  time: number;
  label: string;
}>;

type RenderedRollMarker = Readonly<{
  x: number;
  label: string;
}>;

class RollMarkerRenderer implements IPrimitivePaneRenderer {
  private readonly markers: readonly RenderedRollMarker[];

  constructor(markers: readonly RenderedRollMarker[]) {
    this.markers = markers;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        context.strokeStyle = "rgba(227, 184, 79, 0.72)";
        context.fillStyle = "rgba(227, 184, 79, 0.94)";
        context.lineWidth = 1;
        context.setLineDash([3, 3]);
        context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        context.textAlign = "left";
        context.textBaseline = "top";
        for (const marker of this.markers) {
          context.beginPath();
          context.moveTo(marker.x + 0.5, 0);
          context.lineTo(marker.x + 0.5, mediaSize.height);
          context.stroke();
          context.fillText(marker.label, marker.x + 4, 6);
        }
      } finally {
        context.restore();
      }
    });
  }
}

class RollMarkerPaneView implements IPrimitivePaneView {
  private readonly primitive: RollMarkerPrimitive;

  constructor(primitive: RollMarkerPrimitive) {
    this.primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new RollMarkerRenderer(this.primitive.rendered);
  }
}

export class RollMarkerPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private markers: readonly HistoricalRollMarker[] = [];
  private readonly views: readonly IPrimitivePaneView[];

  rendered: readonly RenderedRollMarker[] = [];

  constructor() {
    this.views = [new RollMarkerPaneView(this)];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
    this.markers = [];
    this.rendered = [];
  }

  updateAllViews(): void {
    const chart = this.chart;
    if (chart === null) {
      this.rendered = [];
      return;
    }
    const scale = chart.timeScale();
    const width = scale.width();
    this.rendered = this.markers.flatMap((marker) => {
      const x = scale.timeToCoordinate((marker.time / 1000) as Time);
      return x === null || x < 0 || x > width ? [] : [{ x, label: marker.label }];
    });
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  setMarkers(markers: readonly HistoricalRollMarker[]): void {
    const seen = new Set<number>();
    const ordered = [...markers].sort((left, right) => left.time - right.time);
    for (const marker of ordered) {
      if (!Number.isSafeInteger(marker.time) || marker.label.trim() === "" || seen.has(marker.time)) {
        throw new Error("historical roll markers must have unique safe timestamps and labels");
      }
      seen.add(marker.time);
    }
    this.markers = Object.freeze(ordered.map((marker) => Object.freeze({ ...marker })));
    this.requestUpdate?.();
  }
}
