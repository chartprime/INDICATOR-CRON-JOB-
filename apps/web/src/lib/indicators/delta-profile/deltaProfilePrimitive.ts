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
  type BinValueAlign,
  type RenderLevelLabel,
  LEVEL_LABEL_MARGIN_PX,
  MAX_LABELLED_HISTORICAL_PROFILES,
} from "../volume-profile/profileLevelLabels";
import {
  DEFAULT_DELTA_VALUE_AREA_PCT,
  OUTSIDE_VALUE_AREA_BIN_OPACITY,
  VALUE_AREA_BIN_OPACITY,
  bucketDelta,
  computeDeltaLevels,
} from "../volume-profile/deltaProfileLevels";
import type { LineStyleKind } from "../../chart/draw/line";
import { applyLineStyle } from "../../chart/draw/kernelPrimitive";

export interface DeltaProfileSettings {
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

export const DELTA_PROFILE_RENDER_DEFAULTS = {
  maxBarWidthPx: 110,
  pocColor: "#d32828",
  vahValColor: "#0a0a0a",
  developingOpacity: 0.6,
  showPocLine: true,
  showValueAreaLines: true,
  valueAreaPercent: DEFAULT_DELTA_VALUE_AREA_PCT,
  vahValStyle: "dashed",
} as const satisfies Partial<DeltaProfileSettings>;

export const DEFAULT_DELTA_PROFILE_SETTINGS: DeltaProfileSettings = {
  ...DELTA_PROFILE_RENDER_DEFAULTS,
  buyColor: "#16a7a7",
  buyValueAreaColor: "#3fd0d0",
  sellColor: "#dc267b",
  sellValueAreaColor: "#ff4fa8",
};

interface RenderDeltaBar {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fill: string;
  onTop: boolean;
  valueText: string;
  valueAlign: BinValueAlign;
}

interface RenderLevelLine {
  x1: number;
  x2: number;
  y: number;
  color: string;
  style: LineStyleKind;
  lineWidth: number;
}

class DeltaProfileBarRenderer implements IPrimitivePaneRenderer {
  private readonly _bars: readonly RenderDeltaBar[];
  private readonly _background: string;

  constructor(bars: readonly RenderDeltaBar[], background: string) {
    this._bars = bars;
    this._background = background;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const bar of this._bars) {
        const width = bar.x2 - bar.x1;
        const height = Math.max(bar.yBottom - bar.yTop, MIN_BAR_HEIGHT_PX);
        if (width <= 0) continue;
        context.fillStyle = bar.fill;
        context.fillRect(bar.x1, bar.yTop, width, height);
        if (bar.valueText.length > 0) {
          drawBinValue(
            context,
            bar,
            bar.valueText,
            bar.fill,
            bar.valueAlign,
            this._background,
          );
        }
      }
      context.restore();
    });
  }
}

class DeltaProfileLineRenderer implements IPrimitivePaneRenderer {
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

class DeltaProfileBarPaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaProfilePrimitive;

  constructor(primitive: DeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DeltaProfileBarRenderer(
      this._primitive.renderBarsBottom,
      this._primitive.valueBackground,
    );
  }
}

class DeltaProfileBarOnTopPaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaProfilePrimitive;

  constructor(primitive: DeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DeltaProfileBarRenderer(
      this._primitive.renderBarsTop,
      this._primitive.valueBackground,
    );
  }
}

class DeltaProfileLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaProfilePrimitive;

  constructor(primitive: DeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DeltaProfileLineRenderer(this._primitive.renderLines);
  }
}

class DeltaProfileLabelPaneView implements IPrimitivePaneView {
  private readonly _primitive: DeltaProfilePrimitive;

  constructor(primitive: DeltaProfilePrimitive) {
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
  bars: RenderDeltaBar[];
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

function computeDeltaProfileRender(
  profile: ProfileFrame,
  timeScale: ITimeScaleApi<Time>,
  series: ISeriesApi<SeriesType, Time>,
  settings: DeltaProfileSettings,
  isLive: boolean,
  allowHistoricalBinValues: boolean,
): ProfileRenderPieces {
  const geometry = resolveProfilePeriodGeometry(
    profile,
    timeScale,
    isLive,
    settings.maxBarWidthPx,
    settings.developingOpacity,
    "bar-budget",
  );
  if (geometry === null) return EMPTY_RENDER_PIECES;
  const { x1, lineRightEdge, isDeveloping, opacityMult, barWidthBudgetPx } =
    geometry;

  const axisX = x1;

  const rowWidth = profile.row_width;
  const levels = computeDeltaLevels(profile.buckets, settings.valueAreaPercent);
  const maxSideVolume = profile.buckets.reduce(
    (max, bucket) => Math.max(max, bucket.buy_volume, bucket.sell_volume),
    0,
  );
  const showBinValues =
    isLive ||
    allowHistoricalBinValues ||
    profile.delivery_scope === "FIXED_RANGE";

  const bars: RenderDeltaBar[] = [];
  for (const bucket of profile.buckets) {
    const delta = bucketDelta(bucket);
    if (delta === 0 || maxSideVolume <= 0) continue;

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
      (Math.abs(delta) / maxSideVolume) * barWidthBudgetPx,
    );
    const isBuy = delta > 0;
    bars.push({
      x1: isBuy ? axisX : axisX - width,
      x2: isBuy ? axisX + width : axisX,
      yTop: edges.yTop,
      yBottom: edges.yBottom,
      fill: withOpacity(
        isBuy
          ? inValueArea
            ? settings.buyValueAreaColor
            : settings.buyColor
          : inValueArea
            ? settings.sellValueAreaColor
            : settings.sellColor,
        computeBinOpacityInBand(
          Math.abs(delta),
          maxSideVolume,
          inValueArea ? VALUE_AREA_BIN_OPACITY : OUTSIDE_VALUE_AREA_BIN_OPACITY,
        ) * opacityMult,
      ),
      onTop: true,
      valueText: showBinValues ? formatLabelDelta(delta) : "",
      valueAlign: isBuy ? "left" : "right",
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

export class DeltaProfilePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _liveProfile: ProfileFrame | null = null;
  private _historicalProfiles: readonly ProfileFrame[] = [];
  private _settings: DeltaProfileSettings = DEFAULT_DELTA_PROFILE_SETTINGS;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBars: readonly RenderDeltaBar[] = [];
  renderBarsBottom: readonly RenderDeltaBar[] = [];
  renderBarsTop: readonly RenderDeltaBar[] = [];
  renderLines: readonly RenderLevelLine[] = [];
  renderLabels: readonly RenderLevelLabel[] = [];
  valueBackground: string = DEFAULT_BIN_VALUE_BACKGROUND;

  constructor() {
    this._paneViews = [
      new DeltaProfileBarPaneView(this),
      new DeltaProfileLinePaneView(this),
      new DeltaProfileBarOnTopPaneView(this),
      new DeltaProfileLabelPaneView(this),
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

    const bars: RenderDeltaBar[] = [];
    const lines: RenderLevelLine[] = [];
    const labels: RenderLevelLabel[] = [];
    const allowHistoricalBinValues =
      this._historicalProfiles.filter(
        (profile) => profile.delivery_scope === "HISTORICAL",
      ).length <= MAX_LABELLED_HISTORICAL_PROFILES;

    for (const profile of this._historicalProfiles) {
      const pieces = computeDeltaProfileRender(
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
      const pieces = computeDeltaProfileRender(
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

  setSettings(settings: DeltaProfileSettings): void {
    this._settings = settings;
    this._requestUpdate?.();
  }
}
