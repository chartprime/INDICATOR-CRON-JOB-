import type {
  DrawingUtils,
  ITimeScaleApi,
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
import type { SessionDeltaProfile } from "./sessionDeltaProfile";
import {
  DEFAULT_SESSION_DELTA_PROFILE_SETTINGS,
  type SessionDeltaProfileSettings,
} from "./sessionDeltaProfileSettings";
import type { LineStyleKind } from "../../chart/draw/line";
import { applyLineStyle } from "../../chart/draw/kernelPrimitive";
import { timeToCoordinateNearest } from "../volume-profile/profilePeriodGeometry";

interface RenderSessionBar {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fill: string;
  onTop: boolean;
}

interface RenderSessionLine {
  x1: number;
  x2: number;
  y: number;
  color: string;
  style: LineStyleKind;
  lineWidth: number;
  onTop: boolean;
}

interface RenderSessionLabel {
  x: number;
  y: number;
  text: string;
  color: string;
}

class SessionDeltaBarRenderer implements IPrimitivePaneRenderer {
  private readonly _bars: readonly RenderSessionBar[];

  constructor(bars: readonly RenderSessionBar[]) {
    this._bars = bars;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      for (const bar of this._bars) {
        const width = bar.x2 - bar.x1;
        const height = Math.max(bar.yBottom - bar.yTop, 1);
        if (width <= 0) continue;
        context.fillStyle = bar.fill;
        context.fillRect(bar.x1, bar.yTop, width, height);
      }
      context.restore();
    });
  }
}

class SessionDeltaLineRenderer implements IPrimitivePaneRenderer {
  private readonly _lines: readonly RenderSessionLine[];
  private readonly _labels: readonly RenderSessionLabel[];

  constructor(
    lines: readonly RenderSessionLine[],
    labels: readonly RenderSessionLabel[] = [],
  ) {
    this._lines = lines;
    this._labels = labels;
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
      context.font = "11px sans-serif";
      context.textAlign = "left";
      context.textBaseline = "middle";
      for (const label of this._labels) {
        context.fillStyle = label.color;
        context.fillText(label.text, label.x, label.y);
      }
      context.restore();
    });
  }
}

class SessionDeltaBarPaneView implements IPrimitivePaneView {
  private readonly _primitive: SessionDeltaProfilePrimitive;

  constructor(primitive: SessionDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new SessionDeltaBarRenderer(this._primitive.renderBars);
  }
}

class SessionDeltaLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: SessionDeltaProfilePrimitive;

  constructor(primitive: SessionDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new SessionDeltaLineRenderer(
      this._primitive.renderLinesTop,
      this._primitive.renderLabels,
    );
  }
}

class SessionDeltaValueAreaLinePaneView implements IPrimitivePaneView {
  private readonly _primitive: SessionDeltaProfilePrimitive;

  constructor(primitive: SessionDeltaProfilePrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new SessionDeltaLineRenderer(this._primitive.renderLinesBottom);
  }
}

function withOpacity(color: string, alpha: number): string {
  if (color.startsWith("rgba(") || color.startsWith("rgb(")) {
    return color;
  }
  if (color.startsWith("#") && color.length === 7) {
    const hex = color.slice(1);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function sessionTimeToCoordinate(
  timeScale: ITimeScaleApi<Time>,
  timeSeconds: number,
): number | null {
  if (typeof timeScale.timeToIndex === "function") {
    return timeToCoordinateNearest(timeScale, timeSeconds);
  }
  return timeScale.timeToCoordinate(timeSeconds as Time);
}

function computeSessionRender(
  profile: SessionDeltaProfile,
  timeScale: ITimeScaleApi<Time>,
  series: ISeriesApi<SeriesType, Time>,
  settings: SessionDeltaProfileSettings,
): { bars: RenderSessionBar[]; lines: RenderSessionLine[] } {
  if (!profile || profile.rows.length === 0) {
    return { bars: [], lines: [] };
  }

  const bars: RenderSessionBar[] = [];
  const lines: RenderSessionLine[] = [];

  const maxSideVolume = profile.rows.reduce(
    (max, row) => Math.max(max, row.buyVolume, row.sellVolume),
    0,
  );

  const sessionStartX = sessionTimeToCoordinate(
    timeScale,
    profile.sessionStartTs / 1000,
  );
  if (sessionStartX === null) {
    return { bars: [], lines: [] };
  }

  // Anchor the right edge to this session's own last observed bar rather than
  // the nominal sessionEndTs: that boundary may not correspond to any real
  // bar (e.g. right after the session length setting changes), in which case
  // it snaps to whatever bar happens to be nearest -- often the chart's very
  // last bar -- stretching every historical session's lines to the same spot.
  const lastBarX = Number.isFinite(profile.lastBarTs)
    ? sessionTimeToCoordinate(timeScale, profile.lastBarTs / 1000)
    : null;
  const effectiveSessionEndX =
    lastBarX ?? sessionStartX + settings.maxBarWidthPx;
  const sessionWidth = Math.abs(effectiveSessionEndX - sessionStartX);
  if (sessionWidth <= 0) return { bars: [], lines: [] };
  const profileWidth = Math.min(settings.maxBarWidthPx, sessionWidth);
  const centerX = sessionStartX;
  const profileLeft = centerX - profileWidth / 2;
  const profileRight = centerX + profileWidth / 2;
  const opacity = settings.developingOpacity;
  const halfRowWidth = profile.rowWidth / 2;

  function rowOpacity(volume: number): number {
    const volumeRatio = volume / maxSideVolume;
    return (
      opacity *
      (settings.smallRowOpacity + (1 - settings.smallRowOpacity) * volumeRatio)
    );
  }

  for (const row of profile.rows) {
    const yTop = series.priceToCoordinate(row.price + halfRowWidth);
    const yBottom = series.priceToCoordinate(row.price - halfRowWidth);
    if (yTop === null || yBottom === null || maxSideVolume <= 0) continue;

    const top = Math.min(yTop, yBottom);
    const bottom = Math.max(yTop, yBottom);

    if (row.buyVolume > 0) {
      const buyWidth = Math.max(
        1,
        (row.buyVolume / maxSideVolume) * (profileRight - centerX),
      );
      bars.push({
        x1: centerX,
        x2: centerX + buyWidth,
        yTop: top,
        yBottom: bottom,
        fill: withOpacity(settings.buyColor, rowOpacity(row.buyVolume)),
        onTop: false,
      });
    }
    if (row.sellVolume > 0) {
      const sellWidth = Math.max(
        1,
        (row.sellVolume / maxSideVolume) * (centerX - profileLeft),
      );
      bars.push({
        x1: centerX - sellWidth,
        x2: centerX,
        yTop: top,
        yBottom: bottom,
        fill: withOpacity(settings.sellColor, rowOpacity(row.sellVolume)),
        onTop: false,
      });
    }
  }

  if (settings.showBuyPoc && Number.isFinite(profile.buyPocPrice)) {
    const yBuyPoc = series.priceToCoordinate(profile.buyPocPrice);
    if (yBuyPoc !== null) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: yBuyPoc,
        color: withOpacity(settings.buyPocColor, opacity),
        style: settings.buyPocStyle,
        lineWidth: 1,
        onTop: true,
      });
    }
  }

  if (settings.showSellPoc && Number.isFinite(profile.sellPocPrice)) {
    const ySellPoc = series.priceToCoordinate(profile.sellPocPrice);
    if (ySellPoc !== null) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: ySellPoc,
        color: withOpacity(settings.sellPocColor, opacity),
        style: settings.sellPocStyle,
        lineWidth: 1,
        onTop: true,
      });
    }
  }

  if (
    settings.showValueAreaLines &&
    Number.isFinite(profile.vahPrice) &&
    Number.isFinite(profile.valPrice)
  ) {
    const yVah = series.priceToCoordinate(profile.vahPrice);
    const yVal = series.priceToCoordinate(profile.valPrice);
    if (yVah !== null) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: yVah,
        color: withOpacity(settings.vahValColor, opacity),
        style: "solid",
        lineWidth: 1,
        onTop: false,
      });
    }
    if (yVal !== null && profile.valPrice !== profile.vahPrice) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: yVal,
        color: withOpacity(settings.vahValColor, opacity),
        style: "solid",
        lineWidth: 1,
        onTop: false,
      });
    }
  }

  if (
    settings.showSessionHighLow &&
    Number.isFinite(profile.sessionHigh) &&
    Number.isFinite(profile.sessionLow)
  ) {
    const yHigh = series.priceToCoordinate(profile.sessionHigh);
    const yLow = series.priceToCoordinate(profile.sessionLow);

    if (yHigh !== null) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: yHigh,
        color: withOpacity(settings.sessionHighLowColor, opacity),
        style: "dotted",
        lineWidth: 1,
        onTop: false,
      });
    }

    if (yLow !== null && profile.sessionLow !== profile.sessionHigh) {
      lines.push({
        x1: sessionStartX,
        x2: effectiveSessionEndX,
        y: yLow,
        color: withOpacity(settings.sessionHighLowColor, opacity),
        style: "dotted",
        lineWidth: 1,
        onTop: false,
      });
    }
  }

  return { bars, lines };
}

function renderDevelopingLabels(
  profile: SessionDeltaProfile,
  series: ISeriesApi<SeriesType, Time>,
  lineEndX: number,
  paneWidth: number,
  settings: SessionDeltaProfileSettings,
): RenderSessionLabel[] {
  const labels: RenderSessionLabel[] = [];
  const labelX = Math.min(
    Math.max(4, lineEndX + 6),
    Math.max(4, paneWidth - 150),
  );

  const addPriceLabel = (name: string, price: number, color: string) => {
    const y = series.priceToCoordinate(price);
    if (y !== null && Number.isFinite(price)) {
      labels.push({ x: labelX, y, text: `${name}: ${price}`, color });
    }
  };

  if (settings.showValueAreaLines) {
    addPriceLabel("VAH", profile.vahPrice, settings.vahValColor);
    addPriceLabel("VAL", profile.valPrice, settings.vahValColor);
  }

  const buyPoc = profile.rows.find((row) => row.price === profile.buyPocPrice);
  if (settings.showBuyPoc && buyPoc && buyPoc.buyVolume > 0) {
    const y = series.priceToCoordinate(profile.buyPocPrice);
    if (y !== null) {
      labels.push({
        x: labelX,
        y,
        text: `BUY POC: ${buyPoc.buyVolume.toFixed(2)}`,
        color: settings.buyPocColor,
      });
    }
  }

  const sellPoc = profile.rows.find(
    (row) => row.price === profile.sellPocPrice,
  );
  if (settings.showSellPoc && sellPoc && sellPoc.sellVolume > 0) {
    const y = series.priceToCoordinate(profile.sellPocPrice);
    if (y !== null) {
      labels.push({
        x: labelX,
        y,
        text: `SELL POC: ${sellPoc.sellVolume.toFixed(2)}`,
        color: settings.sellPocColor,
      });
    }
  }

  return labels;
}

export class SessionDeltaProfilePrimitive implements ISeriesPrimitive<Time> {
  private _timeScale: ITimeScaleApi<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _profiles: readonly SessionDeltaProfile[] = [];
  private _developingSessionStartTs: number | null = null;
  private _settings: SessionDeltaProfileSettings =
    DEFAULT_SESSION_DELTA_PROFILE_SETTINGS;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  renderBars: readonly RenderSessionBar[] = [];
  renderLines: readonly RenderSessionLine[] = [];
  renderLinesTop: readonly RenderSessionLine[] = [];
  renderLinesBottom: readonly RenderSessionLine[] = [];
  renderLabels: readonly RenderSessionLabel[] = [];

  constructor() {
    this._paneViews = [
      new SessionDeltaBarPaneView(this),
      new SessionDeltaValueAreaLinePaneView(this),
      new SessionDeltaLinePaneView(this),
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._timeScale = param.chart.timeScale();
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._timeScale = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews(): void {
    const series = this._series;
    if (!series || !this._timeScale || this._profiles.length === 0) {
      this.renderBars = [];
      this.renderLines = [];
      this.renderLinesTop = [];
      this.renderLinesBottom = [];
      this.renderLabels = [];
      return;
    }

    const bars: RenderSessionBar[] = [];
    const lines: RenderSessionLine[] = [];
    const labels: RenderSessionLabel[] = [];
    for (const profile of this._profiles) {
      const isDeveloping =
        profile.sessionStartTs === this._developingSessionStartTs;
      const rendered = computeSessionRender(
        profile,
        this._timeScale,
        series,
        isDeveloping
          ? this._settings
          : { ...this._settings, developingOpacity: 1 },
      );
      bars.push(...rendered.bars);
      lines.push(...rendered.lines);
      if (isDeveloping) {
        labels.push(
          ...renderDevelopingLabels(
            profile,
            series,
            rendered.lines[0]?.x2 ?? 0,
            this._timeScale.width(),
            this._settings,
          ),
        );
      }
    }
    this.renderBars = bars;
    this.renderLines = lines;
    this.renderLinesTop = lines.filter((line) => line.onTop);
    this.renderLinesBottom = lines.filter((line) => !line.onTop);
    this.renderLabels = labels;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setProfile(profile: SessionDeltaProfile | null): void {
    this._profiles = profile ? [profile] : [];
    this._developingSessionStartTs = profile?.sessionStartTs ?? null;
    this._requestUpdate?.();
  }

  setProfiles(
    profiles: readonly SessionDeltaProfile[],
    developingSessionStartTs: number | null = null,
  ): void {
    this._profiles = profiles;
    this._developingSessionStartTs = developingSessionStartTs;
    this._requestUpdate?.();
  }

  setSettings(settings: SessionDeltaProfileSettings): void {
    this._settings = settings;
    this._requestUpdate?.();
  }
}
