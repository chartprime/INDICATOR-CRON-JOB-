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
import {
  MIN_BAR_HEIGHT_PX,
  POC_LINE_WIDTH_PX,
  VAH_VAL_LINE_WIDTH_PX,
  resolveBandEdges,
  resolveProfilePeriodGeometry,
  withOpacity,
} from "../volume-profile/profilePeriodGeometry";
import {
  ProfileLevelLabelRenderer,
  DEFAULT_BIN_VALUE_BACKGROUND,
  computeBinOpacityInBand,
  drawBinValue,
  formatLabelDelta,
  formatLabelPrice,
  type RenderLevelLabel,
  LEVEL_LABEL_MARGIN_PX,
  MAX_LABELLED_HISTORICAL_PROFILES,
} from "../volume-profile/profileLevelLabels";
import {
  OUTSIDE_VALUE_AREA_BIN_OPACITY,
  VALUE_AREA_BIN_OPACITY,
  DEFAULT_DELTA_VALUE_AREA_PCT,
  bucketDelta,
  computeDeltaLevels,
} from "../volume-profile/deltaProfileLevels";
import type { LineStyleKind } from "../../chart/draw/line";
import { applyLineStyle } from "../../chart/draw/kernelPrimitive";

export interface NetDeltaProfileSettings {
  maxBarWidthPx: number;
  buyColor: string;
  buyValueAreaColor: string;
  sellColor: string;
  sellValueAreaColor: string;
  pocColor: string;
  vahValColor: string;
  developingOpacity: number;
  showPocLine: boolean;
  showValueAreaLines: boolean;
  valueAreaPercent: number;
  vahValStyle: LineStyleKind;
}

export const DEFAULT_NET_DELTA_PROFILE_SETTINGS: NetDeltaProfileSettings = {
  maxBarWidthPx: 110,
  buyColor: "#1e6fe0",
  buyValueAreaColor: "#2f8bff",
  sellColor: "#dc2626",
  sellValueAreaColor: "#ff3b3b",
  pocColor: "#f5a623",
  vahValColor: "#9aa0a6",
  developingOpacity: 0.7,
  showPocLine: true,
  showValueAreaLines: true,
  valueAreaPercent: DEFAULT_DELTA_VALUE_AREA_PCT,
  vahValStyle: "dashed",
};

interface RenderBucketBin {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fill: string;
  onTop: boolean;
  valueText: string;
}

interface RenderLevelLine {
  x1: number;
  x2: number;
  y: number;
  color: string;
  style: LineStyleKind;
  lineWidth: number;
}

class NetDeltaProfileBarRenderer implements IPrimitivePaneRenderer {
  private readonly _bins: readonly RenderBucketBin[];
  private readonly _background: string;

  constructor(bins: readonly RenderBucketBin[], background: string) {
    this._bins = bins;
    this._background = background;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const bin of this._bins) {
        const width = bin.x2 - bin.x1;
        const height = Math.max(bin.yBottom - bin.yTop, MIN_BAR_HEIGHT_PX);
        if (width <= 0) continue;
        context.fillStyle = bin.fill;
        context.fillRect(bin.x1, bin.yTop, width, height);
        if (bin.valueText.length > 0) {
          drawBinValue(
            context,
            bin,
            bin.valueText,
            bin.fill,
            "left",
            this._background,
          );
        }
      }
      context.restore();
    });
  }
}

class NetDeltaProfileLineRenderer implements IPrimitivePaneRenderer {
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

class NetDeltaProfileBarPaneView implements IPrimitivePaneView {
  private readonly _primitive: NetDeltaProfilePrimitive;

  constructor(primitive: NetDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new NetDeltaProfileBarRenderer(
      this._primitive.renderBarsBottom,
      this._primitive.valueBackground,
    );
  }
}

class NetDeltaProfileBarOnTopPaneView implements IPrimitivePaneView {
  private readonly _primitive: NetDeltaProfilePrimitive;

  constructor(primitive: NetDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new NetDeltaProfileBarRenderer(
      this._primitive.renderBarsTop,
      this._primitive.valueBackground,
    );
  }
}

class NetDeltaProfileLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: NetDeltaProfilePrimitive;

  constructor(primitive: NetDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new NetDeltaProfileLineRenderer(this._primitive.renderLines);
  }
}

class NetDeltaProfileLabelPaneView implements IPrimitivePaneView {
  private readonly _primitive: NetDeltaProfilePrimitive;

  constructor(primitive: NetDeltaProfilePrimitive) {
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

function chartBackground(chart: IChartApiBase<Time>): string {
  const background = (
    chart.options?.() as { layout?: { background?: unknown } }
  )?.layout?.background as { color?: unknown } | undefined;
  return typeof background?.color === "string"
    ? background.color
    : DEFAULT_BIN_VALUE_BACKGROUND;
}

const EMPTY_RENDER_PIECES: ProfileRenderPieces = {
  bars: [],
  lines: [],
  labels: [],
};

function computeNetDeltaProfileRender(
  profile: ProfileFrame,
  timeScale: ITimeScaleApi<Time>,
  series: ISeriesApi<SeriesType, Time>,
  settings: NetDeltaProfileSettings,
  isLive: boolean,
  allowHistoricalBinValues: boolean,
): ProfileRenderPieces {
  const geometry = resolveProfilePeriodGeometry(
    profile,
    timeScale,
    isLive,
    settings.maxBarWidthPx,
    settings.developingOpacity,
  );
  if (geometry === null) return EMPTY_RENDER_PIECES;
  const { x1, lineRightEdge, isDeveloping, opacityMult, barWidthBudgetPx } =
    geometry;

  const rowWidth = profile.row_width;
  const levels = computeDeltaLevels(profile.buckets, settings.valueAreaPercent);
  const maxAbsDelta = levels.maxAbsDelta;
  const showBinValues =
    isLive ||
    allowHistoricalBinValues ||
    profile.delivery_scope === "FIXED_RANGE";

  const bars: RenderBucketBin[] = [];
  for (const bucket of profile.buckets) {
    const delta = bucketDelta(bucket);
    if (delta === 0 || maxAbsDelta <= 0) continue;

    const edges = resolveBandEdges(
      (price) => series.priceToCoordinate(price),
      bucket.price,
      rowWidth,
    );
    if (edges === null) continue;
    const inValueArea =
      bucket.price >= levels.valPrice && bucket.price <= levels.vahPrice;

    const width = Math.max(
      1,
      (Math.abs(delta) / maxAbsDelta) * barWidthBudgetPx,
    );
    const baseColor =
      delta > 0
        ? inValueArea
          ? settings.buyValueAreaColor
          : settings.buyColor
        : inValueArea
          ? settings.sellValueAreaColor
          : settings.sellColor;
    const binOpacity =
      computeBinOpacityInBand(
        Math.abs(delta),
        maxAbsDelta,
        inValueArea ? VALUE_AREA_BIN_OPACITY : OUTSIDE_VALUE_AREA_BIN_OPACITY,
      ) * opacityMult;
    bars.push({
      x1,
      x2: x1 + width,
      yTop: edges.yTop,
      yBottom: edges.yBottom,
      fill: withOpacity(baseColor, binOpacity),
      onTop: true,
      valueText: showBinValues ? formatLabelDelta(delta) : "",
    });
  }

  const lines: RenderLevelLine[] = [];
  const labels: RenderLevelLabel[] = [];

  const labelX = timeScale.width() - LEVEL_LABEL_MARGIN_PX;
  if (settings.showPocLine) {
    const yPoc = series.priceToCoordinate(levels.pocPrice + rowWidth / 2);
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
          (bucket) => bucket.price === levels.pocPrice,
        );
        labels.push({
          x: labelX,
          y: yPoc,
          text: `Δ POC: ${formatLabelPrice(levels.pocPrice)}${
            pocBucket ? ` | ${formatLabelDelta(bucketDelta(pocBucket))}` : ""
          }`,
          color: withOpacity(settings.pocColor, opacityMult),
        });
      }
    }
  }
  if (settings.showValueAreaLines) {
    const yVah = series.priceToCoordinate(levels.vahPrice + rowWidth);
    const yVal = series.priceToCoordinate(levels.valPrice);

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
          text: `Δ VAH: ${formatLabelPrice(levels.vahPrice)}`,
          color: withOpacity(settings.vahValColor, opacityMult),
        });
      }
    }
    if (yVal !== null && levels.valPrice !== levels.vahPrice) {
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
          text: `Δ VAL: ${formatLabelPrice(levels.valPrice)}`,
          color: withOpacity(settings.vahValColor, opacityMult),
        });
      }
    }
  }

  return { bars, lines, labels };
}

export class NetDeltaProfilePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _liveProfile: ProfileFrame | null = null;
  private _historicalProfiles: readonly ProfileFrame[] = [];
  private _settings: NetDeltaProfileSettings =
    DEFAULT_NET_DELTA_PROFILE_SETTINGS;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBars: readonly RenderBucketBin[] = [];
  renderBarsBottom: readonly RenderBucketBin[] = [];
  renderBarsTop: readonly RenderBucketBin[] = [];
  renderLines: readonly RenderLevelLine[] = [];
  renderLabels: readonly RenderLevelLabel[] = [];
  valueBackground: string = DEFAULT_BIN_VALUE_BACKGROUND;

  constructor() {
    this._paneViews = [
      new NetDeltaProfileBarPaneView(this),
      new NetDeltaProfileLinePaneView(this),
      new NetDeltaProfileBarOnTopPaneView(this),
      new NetDeltaProfileLabelPaneView(this),
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
    this.valueBackground = chartBackground(chart);

    const bars: RenderBucketBin[] = [];
    const lines: RenderLevelLine[] = [];
    const labels: RenderLevelLabel[] = [];
    const allowHistoricalBinValues =
      this._historicalProfiles.filter(
        (profile) => profile.delivery_scope === "HISTORICAL",
      ).length <= MAX_LABELLED_HISTORICAL_PROFILES;

    for (const profile of this._historicalProfiles) {
      const pieces = computeNetDeltaProfileRender(
        profile,
        timeScale,
        series,
        settings,
        false,
        allowHistoricalBinValues,
      );
      bars.push(...pieces.bars);
      lines.push(...pieces.lines);
      labels.push(...pieces.labels);
    }
    if (this._liveProfile) {
      const pieces = computeNetDeltaProfileRender(
        this._liveProfile,
        timeScale,
        series,
        settings,
        true,
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

  setSettings(settings: NetDeltaProfileSettings): void {
    this._settings = settings;
    this._requestUpdate?.();
  }
}
