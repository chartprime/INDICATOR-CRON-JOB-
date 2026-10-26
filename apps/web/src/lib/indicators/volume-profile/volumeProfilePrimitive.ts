import type {
  DrawingUtils,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ITimeScaleApi,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { ProfileFrame } from "../../../types/frames";
import type { LineStyleKind } from "../../chart/draw/line";
import { applyLineStyle } from "../../chart/draw/kernelPrimitive";
import {
  MIN_BAR_HEIGHT_PX,
  POC_LINE_WIDTH_PX,
  VAH_VAL_LINE_WIDTH_PX,
  resolveBandEdges,
  resolveProfilePeriodGeometry,
  withOpacity,
} from "./profilePeriodGeometry";
import {
  ProfileLevelLabelRenderer,
  computeBinOpacity,
  formatLabelPrice,
  formatLabelVolume,
  type RenderLevelLabel,
  LEVEL_LABEL_MARGIN_PX,
} from "./profileLevelLabels";


export interface VolumeProfileSettings {
  maxBarWidthPx: number;
  valueAreaColor: string;
  outsideValueAreaColor: string;
  sellColor: string;
  sellValueAreaColor: string;
  pocColor: string;
  vahValColor: string;
  developingOpacity: number;
  showPocLine: boolean;
  showValueAreaLines: boolean;
  vahValStyle: LineStyleKind;
}

export const DEFAULT_VOLUME_PROFILE_SETTINGS: VolumeProfileSettings = {
  maxBarWidthPx: 110,




  valueAreaColor: "#28aadd",
  outsideValueAreaColor: "#2acccc",
  sellColor: "#ff5050",
  sellValueAreaColor: "#ff5050",
  pocColor: "#ff5050",
  vahValColor: "#0a0a0a",
  developingOpacity: 0.7,
  showPocLine: true,
  showValueAreaLines: true,
  vahValStyle: "dashed",
};

interface RenderBucketBin {
  x1: number;
  x2: number;

  sellX2: number;
  yTop: number;
  yBottom: number;
  totalFill: string;
  sellFill: string;
  onTop: boolean;
}

interface RenderLevelLine {
  x1: number;
  x2: number;
  y: number;
  color: string;
  style: LineStyleKind;
  lineWidth: number;
}

class VolumeProfileBarRenderer implements IPrimitivePaneRenderer {
  private readonly _bins: readonly RenderBucketBin[];

  constructor(bins: readonly RenderBucketBin[]) {
    this._bins = bins;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const bin of this._bins) {
        const width = bin.x2 - bin.x1;
        const height = Math.max(bin.yBottom - bin.yTop, MIN_BAR_HEIGHT_PX);
        if (width <= 0) continue;

        context.fillStyle = bin.totalFill;
        context.fillRect(bin.x1, bin.yTop, width, height);




        const sellWidth = Math.min(bin.sellX2 - bin.x1, width);
        if (sellWidth > 0) {
          context.fillStyle = bin.sellFill;
          context.fillRect(bin.x1, bin.yTop, sellWidth, height);
        }
      }
      context.restore();
    });
  }
}

class VolumeProfileLineRenderer implements IPrimitivePaneRenderer {
  private readonly _lines: readonly RenderLevelLine[];

  constructor(lines: readonly RenderLevelLine[]) {
    this._lines = lines;
  }

  draw(target: CanvasRenderingTarget2D, utils?: DrawingUtils): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const line of this._lines) {
        context.strokeStyle = line.color;
        context.lineWidth = line.lineWidth;
        applyLineStyle(context, line.style, utils);
        context.beginPath();
        context.moveTo(line.x1, line.y);
        context.lineTo(line.x2, line.y);
        context.stroke();
      }
      context.restore();
    });
  }
}

class VolumeProfileBarPaneView implements IPrimitivePaneView {
  private readonly _primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new VolumeProfileBarRenderer(this._primitive.renderBarsBottom);
  }
}

class VolumeProfileBarOnTopPaneView implements IPrimitivePaneView {
  private readonly _primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new VolumeProfileBarRenderer(this._primitive.renderBarsTop);
  }
}

class VolumeProfileLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new VolumeProfileLineRenderer(this._primitive.renderLines);
  }
}

class VolumeProfileLabelPaneView implements IPrimitivePaneView {
  private readonly _primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new ProfileLevelLabelRenderer(this._primitive.renderLabels);
  }
}

interface ProfileRenderPieces {
  bars: RenderBucketBin[];
  lines: RenderLevelLine[];
  labels: RenderLevelLabel[];
}

const EMPTY_RENDER_PIECES: ProfileRenderPieces = {
  bars: [],
  lines: [],
  labels: [],
};

function computeProfileRender(
  profile: ProfileFrame,
  timeScale: ITimeScaleApi<Time>,
  series: ISeriesApi<SeriesType, Time>,
  settings: VolumeProfileSettings,
  isLive: boolean,
): ProfileRenderPieces {
  const geometry = resolveProfilePeriodGeometry(
    profile,
    timeScale,
    isLive,
    settings.maxBarWidthPx,
    settings.developingOpacity,
  );
  if (geometry === null) return EMPTY_RENDER_PIECES;
  const {
    x1,
    lineRightEdge,
    isDeveloping,
    opacityMult,
    onTop,
    barWidthBudgetPx,
  } = geometry;

  const rowWidth = profile.row_width;
  const maxVolume = profile.buckets.reduce(
    (max, bucket) => Math.max(max, bucket.volume),
    0,
  );

  const bars: RenderBucketBin[] = [];
  for (const bucket of profile.buckets) {




    const edges = resolveBandEdges(
      (price) => series.priceToCoordinate(price),
      bucket.price,
      rowWidth,
    );
    if (edges === null || maxVolume <= 0) continue;
    const inValueArea =
      bucket.price >= profile.val_price && bucket.price <= profile.vah_price;



    const width = Math.max(1, (bucket.volume / maxVolume) * barWidthBudgetPx);


    const sellWidth =
      bucket.sell_volume > 0
        ? Math.max(1, (bucket.sell_volume / maxVolume) * barWidthBudgetPx)
        : 0;


    const binOpacity =
      computeBinOpacity(bucket.volume, maxVolume) * opacityMult;
    bars.push({
      x1,
      x2: x1 + width,
      sellX2: x1 + Math.min(sellWidth, width),
      yTop: edges.yTop,
      yBottom: edges.yBottom,
      totalFill: withOpacity(
        inValueArea ? settings.valueAreaColor : settings.outsideValueAreaColor,
        binOpacity,
      ),
      sellFill: withOpacity(
        inValueArea ? settings.sellValueAreaColor : settings.sellColor,
        binOpacity,
      ),
      onTop,
    });
  }

  const lines: RenderLevelLine[] = [];
  const labels: RenderLevelLabel[] = [];




  const labelX = timeScale.width() - LEVEL_LABEL_MARGIN_PX;
  if (settings.showPocLine) {





    const yPoc = series.priceToCoordinate(profile.poc_price + rowWidth / 2);
    if (yPoc !== null) {
      lines.push({
        x1,
        x2: lineRightEdge,
        y: yPoc,
        color: withOpacity(settings.pocColor, opacityMult),
        style: isDeveloping ? "dashed" : "solid",
        lineWidth: POC_LINE_WIDTH_PX,
      });
      if (isDeveloping) {


        const pocBucket = profile.buckets.find(
          (bucket) => bucket.price === profile.poc_price,
        );
        labels.push({
          x: labelX,
          y: yPoc,
          text: `POC: ${formatLabelPrice(profile.poc_price)}${
            pocBucket ? ` | ${formatLabelVolume(pocBucket.volume)}` : ""
          }`,
          color: withOpacity(settings.pocColor, opacityMult),
        });
      }
    }
  }
  if (settings.showValueAreaLines) {




    const yVah = series.priceToCoordinate(profile.vah_price + rowWidth);
    const yVal = series.priceToCoordinate(profile.val_price);



    if (yVah !== null) {
      lines.push({
        x1,
        x2: lineRightEdge,
        y: yVah,
        color: withOpacity(settings.vahValColor, opacityMult),
        style: settings.vahValStyle,
        lineWidth: VAH_VAL_LINE_WIDTH_PX,
      });
      if (isDeveloping) {
        labels.push({
          x: labelX,
          y: yVah,
          text: `VAH: ${formatLabelPrice(profile.vah_price)}`,
          color: withOpacity(settings.vahValColor, opacityMult),
        });
      }
    }
    if (yVal !== null && profile.val_price !== profile.vah_price) {
      lines.push({
        x1,
        x2: lineRightEdge,
        y: yVal,
        color: withOpacity(settings.vahValColor, opacityMult),
        style: settings.vahValStyle,
        lineWidth: VAH_VAL_LINE_WIDTH_PX,
      });
      if (isDeveloping) {
        labels.push({
          x: labelX,
          y: yVal,
          text: `VAL: ${formatLabelPrice(profile.val_price)}`,
          color: withOpacity(settings.vahValColor, opacityMult),
        });
      }
    }
  }

  return { bars, lines, labels };
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _liveProfile: ProfileFrame | null = null;
  private _historicalProfiles: readonly ProfileFrame[] = [];
  private _settings: VolumeProfileSettings = DEFAULT_VOLUME_PROFILE_SETTINGS;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBars: readonly RenderBucketBin[] = [];
  renderBarsBottom: readonly RenderBucketBin[] = [];
  renderBarsTop: readonly RenderBucketBin[] = [];
  renderLines: readonly RenderLevelLine[] = [];
  renderLabels: readonly RenderLevelLabel[] = [];

  constructor() {
    this._paneViews = [
      new VolumeProfileBarPaneView(this),
      new VolumeProfileBarOnTopPaneView(this),
      new VolumeProfileLinePaneView(this),
      new VolumeProfileLabelPaneView(this),
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
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) {
      this.renderBars = [];
      this.renderBarsBottom = [];
      this.renderBarsTop = [];
      this.renderLines = [];
      this.renderLabels = [];
      return;
    }
    const timeScale = chart.timeScale();
    const settings = this._settings;

    const bars: RenderBucketBin[] = [];
    const lines: RenderLevelLine[] = [];
    const labels: RenderLevelLabel[] = [];

    for (const profile of this._historicalProfiles) {
      const pieces = computeProfileRender(
        profile,
        timeScale,
        series,
        settings,
        false,
      );
      bars.push(...pieces.bars);
      lines.push(...pieces.lines);
      labels.push(...pieces.labels);
    }
    if (this._liveProfile) {
      const pieces = computeProfileRender(
        this._liveProfile,
        timeScale,
        series,
        settings,
        true,
      );
      bars.push(...pieces.bars);
      lines.push(...pieces.lines);
      labels.push(...pieces.labels);
    }

    this.renderBars = bars;
    this.renderBarsBottom = bars.filter((bar) => !bar.onTop);
    this.renderBarsTop = bars.filter((bar) => bar.onTop);
    this.renderLines = lines;
    this.renderLabels = labels;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setProfile(profile: ProfileFrame | null): void {
    this._liveProfile = profile;
    this._requestUpdate?.();
  }

  setHistoricalProfiles(profiles: readonly ProfileFrame[]): void {
    this._historicalProfiles = profiles;
    this._requestUpdate?.();
  }

  setSettings(settings: VolumeProfileSettings): void {
    this._settings = settings;
    this._requestUpdate?.();
  }
}
