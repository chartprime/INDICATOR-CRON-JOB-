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
import type { IndicatorL2 } from "../../chart/indicatorL2";
import { claimRightOffset } from "../../chart/rightOffsetRoom";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type { WallFilter, WallSizeBands } from "../../l2/hostWalls";
import type { WallHistoryStream } from "../../l2/wallHistoryStream";
import { chartTimeGeometry, type ChartBarOpens, type ChartTimeGeometry } from "../l2-book-map/l2BookMapPrimitive";
import { describeStanding, describeWall, type WhaleCard } from "./whaleCard";
import { fmtDuration, fmtUsd } from "./whaleFormat";
import { bandAlpha, bandColor, bandThickness, nearestWalls, pickLabelRows, timeToX, xToTime } from "./whaleGeometry";
import { DEFAULT_WHALE_SETTINGS, bandsFor, cutUsdOf, normalizeWhaleSettings, outcomesOf, sideOf, type WhaleSettings } from "./whaleSettings";
import { WhaleWallStore, visibleRange, type Selection, type StandingWall, type WhaleBands, type WhaleWall } from "./wallStore";

export const WHALE_LADDER_MAX_PX = 176;
export const WHALE_LADDER_SHARE = 0.3;
export const WHALE_NOW_GAP_PX = 56;
export const WHALE_RAYS_FREE_SHARE = 0.14;
export const WHALE_THICKEST_PX = 8;
export const WHALE_LIVE_INGEST_MS = 1_000;
export const WHALE_REBUILD_MS = 1_000;
export const WHALE_RELOAD_EVERY_MS = 300_000;
export const WHALE_RELOAD_SPAN_MS = 5_400_000;
export const WHALE_FILTER_HEADROOM = 0.8;
export const WHALE_FILTER_REFETCH_RISE = 2;
export const WHALE_STATUS_UNTRUSTED = "WHALE · L2 UNTRUSTED";
export const WHALE_STATUS_UNSUPPORTED = "WHALE · BINANCE ONLY";

const HOUR_MS = 3_600_000;
const END_MARK_HIT_PX = 5;
const LABEL_GAP_PX = 13;

export type WhaleHit =
  | { readonly kind: "wall"; readonly index: number; readonly wall: WhaleWall }
  | { readonly kind: "standing"; readonly index: number; readonly wall: StandingWall };

interface Frame {
  readonly geometry: ChartTimeGeometry;
  readonly width: number;
  readonly height: number;
  readonly timeWidth: number;
  readonly ladderWidth: number;
}

interface LadderRow {
  readonly index: number;
  readonly x0: number;
  readonly cy: number;
  readonly height: number;
}

export interface WhaleStats {
  rebuilds: number;
  draws: number;
  lastDrawMs: number;
  pages: number;
  walls: number;
  liveIngests: number;
}

class WhaleHistoryRenderer implements IPrimitivePaneRenderer {
  private readonly _primitive: WhaleLimitHeatmapPrimitive;

  constructor(primitive: WhaleLimitHeatmapPrimitive) {
    this._primitive = primitive;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        this._primitive.renderHistory(context, mediaSize);
      } finally {
        context.restore();
      }
    });
  }
}

class WhaleLiveRenderer implements IPrimitivePaneRenderer {
  private readonly _primitive: WhaleLimitHeatmapPrimitive;

  constructor(primitive: WhaleLimitHeatmapPrimitive) {
    this._primitive = primitive;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        this._primitive.renderLive(context);
      } finally {
        context.restore();
      }
    });
  }
}

class WhalePaneView implements IPrimitivePaneView {
  private readonly _primitive: WhaleLimitHeatmapPrimitive;
  private readonly _order: PrimitivePaneViewZOrder;
  private readonly _live: boolean;

  constructor(primitive: WhaleLimitHeatmapPrimitive, order: PrimitivePaneViewZOrder, live: boolean) {
    this._primitive = primitive;
    this._order = order;
    this._live = live;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._order;
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this._primitive.chart || !this._primitive.series) return null;
    return this._live ? new WhaleLiveRenderer(this._primitive) : new WhaleHistoryRenderer(this._primitive);
  }
}

function coinOf(symbol: string): string {
  return symbol.replace("-", "").replace(/USDT$/, "");
}

export class WhaleLimitHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private readonly _intervalMs: () => number;
  private readonly _opens: () => ChartBarOpens | null;
  private readonly _now: () => number;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _settings: WhaleSettings = { ...DEFAULT_WHALE_SETTINGS };
  private readonly _store = new WhaleWallStore();
  private _identity: { marketKind: string; symbol: string } | null = null;
  private _hostBands: WallSizeBands | null = null;
  private _stream: WallHistoryStream | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _l2: IndicatorL2 | null = null;
  private _selection: Selection | null = null;
  private _styles: readonly string[] = [];
  private _settingsKey = "";
  private _storeVersion = -1;
  private _selectedAt = 0;
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private _liveVersion = -1;
  private _liveAt = 0;
  private _liveTimer: ReturnType<typeof setTimeout> | null = null;
  private _reloadAt = 0;
  private _rowWidth = 0;
  private _frame: Frame | null = null;
  private _hover: WhaleHit | null = null;
  private _appliedFilter: number | "none" | null = null;
  private _active = true;
  private _frameY = new Float64Array(0);
  private _frameX = new Float64Array(0);
  private readonly _views: readonly IPrimitivePaneView[];
  private readonly _stats: WhaleStats = { rebuilds: 0, draws: 0, lastDrawMs: 0, pages: 0, walls: 0, liveIngests: 0 };

  constructor(intervalMs: () => number = () => 60_000, opens: () => ChartBarOpens | null = () => null, now: () => number = () => Date.now()) {
    this._intervalMs = intervalMs;
    this._opens = opens;
    this._now = now;
    this._views = [new WhalePaneView(this, "bottom", false), new WhalePaneView(this, "top", true)];
  }

  get chart(): IChartApiBase<Time> | null {
    return this._chart;
  }

  get series(): ISeriesApi<SeriesType, Time> | null {
    return this._series;
  }

  get settings(): WhaleSettings {
    return this._settings;
  }

  get selection(): Selection | null {
    return this._selection;
  }

  get store(): WhaleWallStore {
    return this._store;
  }

  stats(): Readonly<WhaleStats> {
    return { ...this._stats };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._stream?.stop();
    this._stream = null;
    this._l2 = null;
    this._dropData();
    if (this._chart !== null) claimRightOffset(this._chart, this, null);
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }

  get active(): boolean {
    return this._active;
  }

  setActive(active: boolean): void {
    if (active === this._active) return;
    this._active = active;
    if (!active) {
      this.setStream(null);
      this.setSource(null);
      this._dropData();
      if (this._chart !== null) claimRightOffset(this._chart, this, null);
    }
    this._requestUpdate?.();
  }

  setSettings(value: unknown): void {
    this._settings = normalizeWhaleSettings(value);
    this._requestUpdate?.();
  }

  setIdentity(marketKind: string, symbol: string): void {
    if (this._identity !== null && this._identity.marketKind === marketKind && this._identity.symbol === symbol) return;
    this._identity = { marketKind, symbol };
    this._dropData();
    this._requestUpdate?.();
  }

  setStream(stream: WallHistoryStream | null): void {
    if (stream === this._stream) return;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._stream?.stop();
    this._stream = stream;
    this._appliedFilter = null;
    if (stream === null) this._dropData();
    else {
      this._unsubscribe = stream.subscribe({
        onWalls: (walls, rowWidth) => {
          this._rowWidth = rowWidth;
          this._stats.pages += 1;
          this._stats.walls += walls.length;
          this._store.addHost(walls, rowWidth);
          this._requestUpdate?.();
        },
        onChunk: () => this._requestUpdate?.(),
        onBands: (bands) => {
          this._hostBands = bands;
          this._requestUpdate?.();
        },
      });
      stream.invalidateSince(0);
    }
    this._requestUpdate?.();
  }

  setSource(l2: IndicatorL2 | null): void {
    if (l2 !== this._l2 && (l2?.availability === "HISTORICAL" || this._l2?.availability === "HISTORICAL")) this._dropData();
    this._l2 = l2;
    this._liveVersion = -1;
    if (l2 === null) this._store.clearStanding();
    this._requestUpdate?.();
  }

  setHover(hit: WhaleHit | null): void {
    if (hit === this._hover || (hit !== null && this._hover !== null && hit.kind === this._hover.kind && hit.wall === this._hover.wall)) return;
    this._hover = hit;
    this._requestUpdate?.();
  }

  refresh(): void {
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    if (!this._active || this._chart === null || this._series === null) return;
    this._ingestLive();
    this._ensureSelection();
    this._drive();
    this._applyRightOffset();
  }

  bands(): WhaleBands | null {
    if (this._hostBands !== null) return this._hostBands;
    return this._identity === null ? null : bandsFor(this._identity.marketKind, this._identity.symbol);
  }

  trusted(): boolean {
    const l2 = this._l2;
    return l2 !== null && l2.availability !== "HISTORICAL_UNAVAILABLE" && l2.segment()?.state === "LIVE" && l2.status("l2_walls").synced;
  }

  private _clockMs(): number {
    return this._l2?.availability === "HISTORICAL" ? this._l2.status("l2_walls").lastTs ?? 0 : this._now();
  }

  private _dropData(): void {
    this._clearTimers();
    this._store.clear();
    this._selection = null;
    this._styles = [];
    this._frame = null;
    this._hover = null;
    this._hostBands = null;
    this._settingsKey = "";
    this._appliedFilter = null;
    this._liveVersion = -1;
    this._reloadAt = 0;
  }

  private _clearTimers(): void {
    if (this._rebuildTimer !== null) clearTimeout(this._rebuildTimer);
    if (this._liveTimer !== null) clearTimeout(this._liveTimer);
    this._rebuildTimer = null;
    this._liveTimer = null;
  }

  private _cutUsd(bands: WhaleBands | null): number | null {
    if (bands === null || this._settings.cutBasis !== "usd") return null;
    return cutUsdOf(this._settings, bands);
  }

  private _refilterFor(cut: number | null): WallFilter | null | undefined {
    const applied = this._appliedFilter;
    if (cut === null) return applied === "none" ? undefined : null;
    if (typeof applied === "number" && applied <= cut && cut * WHALE_FILTER_HEADROOM <= applied * WHALE_FILTER_REFETCH_RISE) return undefined;
    return { minUsd: Math.floor(cut * WHALE_FILTER_HEADROOM), alwaysOutcomes: ["filled", "partial"] };
  }

  private _drive(): void {
    const stream = this._stream;
    if (stream === null) return;
    if (this._identity === null || this._identity.marketKind === "") {
      stream.stop();
      return;
    }
    const filter = stream.filterDropped ? undefined : this._refilterFor(this._cutUsd(this.bands()));
    if (filter !== undefined) {
      this._appliedFilter = filter === null ? "none" : filter.minUsd;
      stream.setFilter(filter);
    }
    const now = this._now();
    stream.want(Math.max(0, now - this._settings.hours * HOUR_MS), now + 60_000);
    if (now - this._reloadAt >= WHALE_RELOAD_EVERY_MS) {
      if (this._reloadAt !== 0) stream.invalidateSince(now - WHALE_RELOAD_SPAN_MS);
      this._reloadAt = now;
    }
  }

  private _ingestLive(): void {
    const l2 = this._l2;
    if (l2 === null || l2.availability === "HISTORICAL_UNAVAILABLE") return;
    const version = l2.version;
    if (version === this._liveVersion) return;
    const now = this._clockMs();
    if (l2.availability === "LIVE" && now - this._liveAt < WHALE_LIVE_INGEST_MS) {
      if (this._liveTimer === null) {
        this._liveTimer = setTimeout(() => {
          this._liveTimer = null;
          this._requestUpdate?.();
        }, WHALE_LIVE_INGEST_MS - (now - this._liveAt));
      }
      return;
    }
    const rowWidth = l2.lanes().find((lane) => lane.lane === 0)?.rowWidth ?? this._rowWidth;
    if (!(rowWidth > 0)) return;
    this._rowWidth = rowWidth;
    this._liveVersion = version;
    this._liveAt = now;
    this._stats.liveIngests += 1;
    if (l2.availability === "HISTORICAL") {
      if (l2.notionalMultiplier === undefined || l2.historicalWalls === undefined) return;
      const walls = l2.historicalWalls();
      this._store.addHistorical(walls, rowWidth, l2.notionalMultiplier);
      const values = walls.map((wall) => wall.peak * (wall.row + (wall.span - 1) / 2) * rowWidth * l2.notionalMultiplier!).filter((value) => value > 0).sort((a, b) => a - b);
      const percentile = (q: number) => values[Math.round(q * (values.length - 1))] ?? 0;
      this._hostBands = { n: values.length, p50: percentile(0.5), p75: percentile(0.75), p90: percentile(0.9), p95: percentile(0.95), p99: percentile(0.99) };
    } else this._store.addLive(l2.walls(0), rowWidth);
  }

  private _settingsKeyOf(bands: WhaleBands | null): string {
    const s = this._settings;
    const cut = bands === null ? "" : cutUsdOf(s, bands);
    return [cut, s.cutBasis, s.ratioMin, s.fills, s.outcomeMask, s.sideFilter, s.hours, bands === null ? "" : `${bands.p50}:${bands.p99}`].join("|");
  }

  private _ensureSelection(): void {
    const bands = this.bands();
    if (bands === null) {
      this._selection = null;
      return;
    }
    const key = this._settingsKeyOf(bands);
    const settingsChanged = key !== this._settingsKey || this._selection === null;
    const storeChanged = this._store.version !== this._storeVersion;
    if (!settingsChanged && !storeChanged) return;
    const now = this._clockMs();
    if (this._l2?.availability !== "HISTORICAL" && !settingsChanged && now - this._selectedAt < WHALE_REBUILD_MS) {
      if (this._rebuildTimer === null) {
        this._rebuildTimer = setTimeout(() => {
          this._rebuildTimer = null;
          this._requestUpdate?.();
        }, WHALE_REBUILD_MS - (now - this._selectedAt));
      }
      return;
    }
    this._rebuild(bands, key, now);
  }

  private _rebuild(bands: WhaleBands, key: string, now: number): void {
    const s = this._settings;
    const selection = this._store.select({
      cutUsd: cutUsdOf(s, bands),
      ratioMin: s.cutBasis === "ratio" ? s.ratioMin : null,
      fills: s.fills,
      outcomes: outcomesOf(s.outcomeMask),
      side: sideOf(s.sideFilter),
      fromTs: now - s.hours * HOUR_MS,
      bands,
    });
    const styles: string[] = new Array<string>(selection.count);
    for (let index = 0; index < selection.count; index += 1) styles[index] = bandColor(selection.side[index] as 0 | 1, bandAlpha(selection.heat[index], selection.outcome[index]));
    this._selection = selection;
    this._styles = styles;
    this._settingsKey = key;
    this._storeVersion = this._store.version;
    this._selectedAt = now;
    this._stats.rebuilds += 1;
  }

  private _ladderWidth(width: number): number {
    const mode = this._settings.liveView;
    return mode === "ladder" || mode === "both" ? Math.min(WHALE_LADDER_MAX_PX, Math.floor(width * WHALE_LADDER_SHARE)) : 0;
  }

  restoreRoom(): void {
    if (!this._active) return;
    this._applyRightOffset(true);
  }

  private _applyRightOffset(force = false): void {
    const chart = this._chart;
    if (chart === null) return;
    const width = chart.timeScale().width();
    const spacing = chart.timeScale().options().barSpacing;
    const mode = this._settings.liveView;
    if (this.bands() === null || mode === "off" || !(width > 0) || !(spacing > 0)) {
      claimRightOffset(chart, this, null);
      return;
    }
    const room = mode === "rays" ? width * WHALE_RAYS_FREE_SHARE : this._ladderWidth(width) + WHALE_NOW_GAP_PX;
    claimRightOffset(chart, this, Math.ceil(room / spacing), force);
  }

  private _geometry(): ChartTimeGeometry | null {
    if (this._chart === null || this._series === null) return null;
    return chartTimeGeometry(this._chart, this._series, this._intervalMs(), this._opens()?.opensMs ?? null);
  }

  private _midPrice(): number | null {
    const ladder = this._l2?.ladder() ?? null;
    if (ladder === null || ladder.bids.length === 0 || ladder.asks.length === 0) return null;
    return (ladder.bids[0][0] + ladder.asks[0][0]) / 2;
  }

  private _yOf(price: number): number | null {
    return this._series === null ? null : this._series.priceToCoordinate(price);
  }

  private _ladderRows(selection: Selection, frame: Frame): LadderRow[] {
    const rows: LadderRow[] = [];
    const reach = Math.max(16, frame.ladderWidth - 92);
    for (let index = 0; index < selection.standing.length; index += 1) {
      const wall = selection.standing[index];
      const yHi = this._yOf(wall.hi);
      const yLo = this._yOf(wall.lo);
      if (yHi === null || yLo === null) continue;
      const cy = (yHi + yLo) / 2;
      if (cy < 4 || cy > frame.height - 4) continue;
      const heat = selection.standingHeat[index];
      const height = Math.max(5, Math.min(11, 5 + 5 * heat, Math.max(5, Math.abs(yLo - yHi) + 4)));
      rows.push({ index, x0: frame.width - 5 - (16 + (reach - 16) * heat), cy, height });
    }
    return rows;
  }

  renderHistory(context: CanvasRenderingContext2D, mediaSize: { width: number; height: number }): void {
    if (!this._active) return;
    const started = performance.now();
    const selection = this._selection;
    const series = this._series;
    const geometry = this._geometry();
    if (series === null || geometry === null) return;
    if (this.bands() === null) {
      drawStatusBadge(context, STATUS_BADGE_SLOT.whaleHeatmap, WHALE_STATUS_UNSUPPORTED);
      return;
    }
    if (selection === null) return;
    if (this._l2?.availability === "HISTORICAL") drawStatusBadge(context, STATUS_BADGE_SLOT.whaleHeatmap,
      "WHALE · TOP 10 · INDEXED WALL SAMPLE · INFERRED OUTCOMES");
    const mode = this._settings.liveView;
    const ladderWidth = this._ladderWidth(mediaSize.width);
    const timeWidth = mediaSize.width - ladderWidth;
    const frame: Frame = { geometry, width: mediaSize.width, height: mediaSize.height, timeWidth, ladderWidth };
    this._frame = frame;
    const from = xToTime(0, geometry);
    const to = xToTime(timeWidth, geometry);
    const [first, last] = visibleRange(selection, from, to);
    const thinnest = this._settings.thickness;
    context.save();
    context.beginPath();
    context.rect(0, 0, timeWidth, mediaSize.height);
    context.clip();
    const trusted = this.trusted();
    const xNow = this._nowX(geometry);
    if (mode === "rays" && trusted) {
      const edge = Math.max(0, xNow);
      context.fillStyle = "rgba(60,55,40,0.06)";
      context.fillRect(edge, 0, timeWidth - edge, mediaSize.height);
    }
    if (this._frameY.length < last) {
      this._frameY = new Float64Array(last + 1024);
      this._frameX = new Float64Array(last + 1024);
    }
    const frameY = this._frameY;
    const frameX = this._frameX;
    let lastStyle = "";
    for (let index = first; index < last; index += 1) {
      frameY[index] = Number.NaN;
      if (selection.end[index] < from) continue;
      const yHi = series.priceToCoordinate(selection.hi[index]);
      const yLo = series.priceToCoordinate(selection.lo[index]);
      if (yHi === null || yLo === null) continue;
      const height = bandThickness(selection.heat[index], Math.abs(yLo - yHi), thinnest, WHALE_THICKEST_PX);
      const cy = (yHi + yLo) / 2;
      frameY[index] = cy;
      const x1 = timeToX(selection.end[index], geometry);
      frameX[index] = x1;
      if (cy + height / 2 < 0 || cy - height / 2 > mediaSize.height) continue;
      const x0 = timeToX(selection.start[index], geometry);
      const drawn = selection.outcome[index] === 0 ? height + 1 : height;
      const style = this._styles[index];
      if (style !== lastStyle) {
        context.fillStyle = style;
        lastStyle = style;
      }
      context.fillRect(x0, cy - drawn / 2, Math.max(1.5, x1 - x0), drawn);
    }
    for (let index = first; index < last; index += 1) {
      const cy = frameY[index];
      if (Number.isNaN(cy)) continue;
      const x = frameX[index];
      if (x < -6 || x > timeWidth + 6) continue;
      if (cy < -6 || cy > mediaSize.height + 6) continue;
      drawEndMark(context, selection.outcome[index], selection.side[index] as 0 | 1, x, cy);
    }
    if (trusted && (mode === "rays" || mode === "both")) this._drawRays(context, selection, frame, xNow, mode === "rays");
    if (xNow > 0 && xNow < timeWidth) {
      context.strokeStyle = "rgba(20,20,20,0.5)";
      context.lineWidth = 1;
      context.setLineDash([2, 4]);
      context.beginPath();
      context.moveTo(Math.round(xNow) + 0.5, 0);
      context.lineTo(Math.round(xNow) + 0.5, mediaSize.height);
      context.stroke();
      context.setLineDash([]);
    }
    if (this._hover !== null && this._hover.kind === "wall") this._drawHighlight(context, selection, this._hover.index, geometry, thinnest);
    context.restore();
    if (!trusted && mode !== "off") drawStatusBadge(context, STATUS_BADGE_SLOT.whaleHeatmap, WHALE_STATUS_UNTRUSTED);
    this._stats.draws += 1;
    this._stats.lastDrawMs = performance.now() - started;
  }

  private _nowX(geometry: ChartTimeGeometry): number {
    return timeToX(this._clockMs(), geometry);
  }

  private _drawHighlight(context: CanvasRenderingContext2D, selection: Selection, index: number, geometry: ChartTimeGeometry, thinnest: number): void {
    if (index >= selection.count) return;
    const yHi = this._yOf(selection.hi[index]);
    const yLo = this._yOf(selection.lo[index]);
    if (yHi === null || yLo === null) return;
    const height = bandThickness(selection.heat[index], Math.abs(yLo - yHi), thinnest, WHALE_THICKEST_PX);
    const x0 = timeToX(selection.start[index], geometry);
    const x1 = timeToX(selection.end[index], geometry);
    context.lineWidth = 1.5;
    context.strokeStyle = "#141414";
    context.strokeRect(x0 - 1, (yHi + yLo) / 2 - height / 2 - 1.5, Math.max(2, x1 - x0) + 2, height + 3);
  }

  private _drawRays(context: CanvasRenderingContext2D, selection: Selection, frame: Frame, xNow: number, filled: boolean): void {
    const thinnest = this._settings.thickness;
    for (let index = 0; index < selection.standing.length; index += 1) {
      const wall = selection.standing[index];
      const yHi = this._yOf(wall.hi);
      const yLo = this._yOf(wall.lo);
      if (yHi === null || yLo === null) continue;
      const cy = (yHi + yLo) / 2;
      if (cy < -4 || cy > frame.height + 4) continue;
      const heat = selection.standingHeat[index];
      const height = bandThickness(heat, Math.abs(yLo - yHi), thinnest, WHALE_THICKEST_PX) + 1;
      const x0 = Math.max(0, timeToX(wall.start, frame.geometry));
      const edge = Math.max(0, Math.min(xNow, frame.timeWidth));
      context.strokeStyle = bandColor(wall.side, 0.5);
      context.lineWidth = 1.2;
      context.setLineDash([4, 3]);
      context.beginPath();
      context.moveTo(x0, cy);
      context.lineTo(edge, cy);
      context.stroke();
      context.setLineDash([]);
      if (filled) {
        const alpha = 0.3 + 0.6 * Math.pow(heat, 0.75);
        const gradient = context.createLinearGradient(edge, 0, frame.timeWidth, 0);
        gradient.addColorStop(0, bandColor(wall.side, alpha));
        gradient.addColorStop(1, bandColor(wall.side, alpha * 0.25));
        context.fillStyle = gradient;
        context.fillRect(edge, cy - height / 2, Math.max(0, frame.timeWidth - edge), height);
      }
    }
  }

  renderLive(context: CanvasRenderingContext2D): void {
    const selection = this._selection;
    const frame = this._frame;
    const mode = this._settings.liveView;
    if (selection === null || frame === null || this.bands() === null) return;
    if (mode === "ladder" || mode === "both") this._drawLadder(context, selection, frame);
    else if (mode === "rays" && this._settings.labels && this.trusted()) this._drawRayLabels(context, selection, frame);
  }

  private _drawRayLabels(context: CanvasRenderingContext2D, selection: Selection, frame: Frame): void {
    const now = this._clockMs();
    const centres = selection.standing.map((wall) => {
      const yHi = this._yOf(wall.hi);
      const yLo = this._yOf(wall.lo);
      return yHi === null || yLo === null ? Number.NaN : (yHi + yLo) / 2;
    });
    context.font = "500 10.5px 'IBM Plex Mono', monospace";
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const index of pickLabelRows(centres, LABEL_GAP_PX + 1, 8, frame.height - 8)) {
      const wall = selection.standing[index];
      const text = `${fmtUsd(wall.usd)} · ${fmtDuration(now - wall.start)}`;
      const width = context.measureText(text).width;
      context.fillStyle = "rgba(242,239,230,0.92)";
      context.fillRect(frame.timeWidth - width - 10, centres[index] - 7, width + 8, 14);
      context.fillStyle = wall.side === 0 ? "#12803f" : "#b02a2a";
      context.fillText(text, frame.timeWidth - 6, centres[index]);
    }
  }

  private _drawLadder(context: CanvasRenderingContext2D, selection: Selection, frame: Frame): void {
    const left = frame.timeWidth;
    context.fillStyle = "#e9e5d8";
    context.fillRect(left, 0, frame.ladderWidth, frame.height);
    context.strokeStyle = "#bdb7a4";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left + 0.5, 0);
    context.lineTo(left + 0.5, frame.height);
    context.stroke();
    const mid = this._midPrice();
    if (!this.trusted()) {
      context.fillStyle = "#5c5848";
      context.font = "500 10px 'IBM Plex Mono', monospace";
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      context.fillText("LIVE BOOK · L2 untrusted", left + 9, 14);
      return;
    }
    const rows = this._ladderRows(selection, frame);
    const now = this._clockMs();
    context.font = "500 10.5px 'IBM Plex Mono', monospace";
    context.textBaseline = "middle";
    const labelled = this._settings.labels ? new Set(pickLabelRows(rows.map((row) => row.cy), LABEL_GAP_PX, 4, frame.height - 4)) : new Set<number>();
    rows.forEach((row, position) => {
      const wall = selection.standing[row.index];
      const heat = selection.standingHeat[row.index];
      context.fillStyle = bandColor(wall.side, 0.38 + 0.55 * Math.pow(heat, 0.75));
      context.fillRect(row.x0, row.cy - row.height / 2, frame.width - 5 - row.x0, row.height);
      context.fillStyle = wall.side === 0 ? "#26c36e" : "#dc4141";
      context.fillRect(frame.width - 6, row.cy - row.height / 2, 2, row.height);
      if (labelled.has(position)) {
        context.textAlign = "right";
        context.fillStyle = wall.side === 0 ? "#12803f" : "#b02a2a";
        context.fillText(`${fmtUsd(wall.usd)} · ${fmtDuration(now - wall.start)}`, row.x0 - 5, row.cy);
      }
    });
    if (mid !== null) {
      const y = this._yOf(mid);
      if (y !== null) {
        context.strokeStyle = "rgba(20,20,20,0.55)";
        context.setLineDash([2, 3]);
        context.beginPath();
        context.moveTo(left, Math.round(y) + 0.5);
        context.lineTo(frame.width, Math.round(y) + 0.5);
        context.stroke();
        context.setLineDash([]);
      }
    }
    const near = mid === null ? { ask: null, bid: null } : nearestWalls(selection.standing, mid);
    context.fillStyle = "rgba(233,229,216,0.96)";
    context.fillRect(left + 1, 0, frame.ladderWidth - 1, 58);
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#5c5848";
    context.font = "500 10px 'IBM Plex Mono', monospace";
    context.fillText("LIVE BOOK · standing now", left + 9, 14);
    context.font = "500 11px 'IBM Plex Mono', monospace";
    context.fillStyle = "#b02a2a";
    context.fillText(near.ask === null ? "next ask none" : `next ask ${fmtUsd(near.ask.usd)} +${near.ask.pct.toFixed(2)}%`, left + 9, 33);
    context.fillStyle = "#12803f";
    context.fillText(near.bid === null ? "next bid none" : `next bid ${fmtUsd(near.bid.usd)} -${near.bid.pct.toFixed(2)}%`, left + 9, 49);
  }

  hitAt(x: number, y: number): WhaleHit | null {
    const selection = this._selection;
    const frame = this._frame;
    if (selection === null || frame === null || this._series === null) return null;
    if (frame.ladderWidth > 0 && x >= frame.timeWidth) return this._hitLadder(selection, frame, x, y);
    const wall = this._hitWall(selection, frame, x, y);
    if (wall !== null) return wall;
    return this._settings.liveView === "rays" && this.trusted() ? this._hitRay(selection, frame, x, y) : null;
  }

  private _hitLadder(selection: Selection, frame: Frame, x: number, y: number): WhaleHit | null {
    if (!this.trusted()) return null;
    for (const row of this._ladderRows(selection, frame)) {
      if (x >= row.x0 - 2 && Math.abs(y - row.cy) <= Math.max(row.height / 2, END_MARK_HIT_PX)) return { kind: "standing", index: row.index, wall: selection.standing[row.index] };
    }
    return null;
  }

  private _hitWall(selection: Selection, frame: Frame, x: number, y: number): WhaleHit | null {
    const from = xToTime(0, frame.geometry);
    const to = xToTime(frame.timeWidth, frame.geometry);
    const [first, last] = visibleRange(selection, from, to);
    const at = xToTime(x, frame.geometry);
    const msPerPx = Math.abs(xToTime(1, frame.geometry) - xToTime(0, frame.geometry));
    const reach = 4 * msPerPx;
    const endReach = END_MARK_HIT_PX * msPerPx;
    const thinnest = this._settings.thickness;
    let best = -1;
    let bestScore = -Infinity;
    for (let index = last - 1; index >= first; index -= 1) {
      if (selection.end[index] + endReach < at || selection.start[index] > at + reach) continue;
      const left = timeToX(selection.start[index], frame.geometry) - 3;
      const right = timeToX(selection.end[index], frame.geometry) + END_MARK_HIT_PX;
      if (x < left || x > right) continue;
      const yHi = this._yOf(selection.hi[index]);
      const yLo = this._yOf(selection.lo[index]);
      if (yHi === null || yLo === null) continue;
      const height = bandThickness(selection.heat[index], Math.abs(yLo - yHi), thinnest, WHALE_THICKEST_PX);
      if (Math.abs(y - (yHi + yLo) / 2) > height / 2 + 3) continue;
      const outcome = selection.outcome[index];
      const score = (outcome <= 1 ? 10 : 0) + (outcome === 2 ? 5 : 0) + Math.log(Math.max(1, selection.walls[index].usd));
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    return best < 0 ? null : { kind: "wall", index: best, wall: selection.walls[best] };
  }

  private _hitRay(selection: Selection, frame: Frame, x: number, y: number): WhaleHit | null {
    const xNow = this._nowX(frame.geometry);
    const thinnest = this._settings.thickness;
    for (let index = 0; index < selection.standing.length; index += 1) {
      const wall = selection.standing[index];
      const yHi = this._yOf(wall.hi);
      const yLo = this._yOf(wall.lo);
      if (yHi === null || yLo === null) continue;
      const height = bandThickness(selection.standingHeat[index], Math.abs(yLo - yHi), thinnest, WHALE_THICKEST_PX) + 1;
      if (Math.abs(y - (yHi + yLo) / 2) > height / 2 + 3) continue;
      if (x >= Math.max(0, xNow) - 4 && x <= frame.timeWidth) return { kind: "standing", index, wall };
    }
    return null;
  }

  card(hit: WhaleHit, detailed: boolean): WhaleCard {
    const coin = this._l2?.availability === "HISTORICAL" ? this._l2.notionalMultiplier === 1 ? "shares" : "contracts"
      : this._identity === null ? "" : coinOf(this._identity.symbol);
    const rowWidth = this._rowWidth > 0 ? this._rowWidth : 1;
    if (hit.kind === "wall") {
      const card = describeWall(hit.wall, { coin, rowWidth });
      const admitted = this._l2?.availability === "HISTORICAL" ? { ...card,
        sentence: `Depth/trade inference: ${card.sentence} Order-level cancellation is not observed.`,
        details: [...card.details, ["Size bands", "Loaded indexed walls; fixed detector threshold"] as const] } : card;
      return detailed ? admitted : { ...admitted, details: [] };
    }
    return describeStanding(hit.wall, { coin, rowWidth, now: this._clockMs(), lastClose: this._midPrice() });
  }
}

function drawEndMark(context: CanvasRenderingContext2D, outcome: number, side: 0 | 1, x: number, cy: number): void {
  const color = side === 0 ? "#26c36e" : "#dc4141";
  if (outcome === 0) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, cy, 4, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 1.2;
    context.strokeStyle = "#f2efe6";
    context.stroke();
  } else if (outcome === 1) {
    context.lineWidth = 1.4;
    context.strokeStyle = color;
    context.fillStyle = "#f2efe6";
    context.beginPath();
    context.arc(x, cy, 3.6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, cy, 3.6, Math.PI / 2, Math.PI * 1.5);
    context.closePath();
    context.fill();
  } else if (outcome === 2) {
    context.lineWidth = 1.2;
    context.strokeStyle = color;
    context.globalAlpha = 0.6;
    context.beginPath();
    context.arc(x, cy, 3, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
  } else if (outcome === 3) {
    context.lineWidth = 1;
    context.strokeStyle = color;
    context.globalAlpha = 0.45;
    context.beginPath();
    context.moveTo(x, cy - 3);
    context.lineTo(x, cy + 3);
    context.stroke();
    context.globalAlpha = 1;
  }
}
