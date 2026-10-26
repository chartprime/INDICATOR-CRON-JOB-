import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IndicatorL2, L2ColumnView, L2LaneView } from "../../chart/indicatorL2";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { L2LaneInfo } from "../../l2/types";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type {
  LiquidityGrid,
  LiquiditySide,
} from "../passive-liquidity/liquidityGrid";

export interface L2BookMapSettings {
  priceBinRows: number;
  verticalRangeRows: number;
  windowBuckets: number;
  minVolume: number;
  showProfile: boolean;
  showBidPoc: boolean;
  showAskPoc: boolean;
  profileBidColor: string;
  profileAskColor: string;
  lowVolumeColor: string;
  midVolumeColor: string;
  highVolumeColor: string;
}

// The lookback is counted in time buckets (bars), not milliseconds: one bucket spans one candle whatever the
// timeframe, so the same count follows the trader as they switch timeframes.
export const MAX_L2_BOOK_MAP_WINDOW_BUCKETS = 5_000;
const MAX_L2_BOOK_MAP_CELLS = 100_000;

export const DEFAULT_L2_BOOK_MAP_SETTINGS: L2BookMapSettings = {
  priceBinRows: 20,
  verticalRangeRows: 0,
  windowBuckets: 500,
  minVolume: 0,
  showProfile: true,
  showBidPoc: true,
  showAskPoc: true,
  profileBidColor: "#ff6d29",
  profileAskColor: "#498cff",
  lowVolumeColor: "#498cff",
  midVolumeColor: "#3271d6",
  highVolumeColor: "#ff6d29",
};

export const BOOK_MAP_PROFILE_EDGE_GAP_PX = 4;

export function bookMapProfileWidthPx(paneWidth: number): number {
  return Math.min(132, Math.max(72, paneWidth * 0.12));
}

function clampFiniteInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length !== 6) return [255, 255, 255];
  const int = Number.parseInt(clean, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

type Rgb = [number, number, number];

function volumeColor(
  low: Rgb,
  mid: Rgb,
  high: Rgb,
  intensity: number,
  alpha: number,
): string {
  const ratio = Math.min(1, Math.max(0, intensity));
  const from = ratio < 0.5 ? low : mid;
  const to = ratio < 0.5 ? mid : high;
  const segmentRatio = ratio < 0.5 ? ratio * 2 : (ratio - 0.5) * 2;
  const red = Math.round(from[0] + (to[0] - from[0]) * segmentRatio);
  const green = Math.round(from[1] + (to[1] - from[1]) * segmentRatio);
  const blue = Math.round(from[2] + (to[2] - from[2]) * segmentRatio);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export const L2_BOOK_MAP_SETTINGS_SCHEMA: readonly SettingsFieldSchema<L2BookMapSettings>[] = [
  { kind: "numeric", key: "priceBinRows", label: "Price bin rows", min: 0, max: 50, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "verticalRangeRows", label: "Vertical range", min: 0, max: 5_000, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "windowBuckets", label: "Window", min: 1, max: MAX_L2_BOOK_MAP_WINDOW_BUCKETS, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "minVolume", label: "Minimum volume", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "boolean", key: "showProfile", label: "Show profile", affects: "cosmetic" },
  { kind: "boolean", key: "showBidPoc", label: "Show bid POC", affects: "cosmetic" },
  { kind: "boolean", key: "showAskPoc", label: "Show ask POC", affects: "cosmetic" },
  { kind: "color", key: "profileBidColor", label: "Profile bid colour", affects: "cosmetic" },
  { kind: "color", key: "profileAskColor", label: "Profile ask colour", affects: "cosmetic" },
  { kind: "color", key: "lowVolumeColor", label: "Low volume colour", affects: "cosmetic" },
  { kind: "color", key: "midVolumeColor", label: "Mid volume colour", affects: "cosmetic" },
  { kind: "color", key: "highVolumeColor", label: "High volume colour", affects: "cosmetic" },
];

export function normalizeL2BookMapSettings(
  settings: Partial<L2BookMapSettings> | null | undefined,
): L2BookMapSettings {
  const source = settings ?? {};
  return {
    priceBinRows: clampFiniteInt(
      source.priceBinRows,
      0,
      50,
      DEFAULT_L2_BOOK_MAP_SETTINGS.priceBinRows,
    ),
    verticalRangeRows: clampFiniteInt(
      source.verticalRangeRows,
      0,
      5_000,
      DEFAULT_L2_BOOK_MAP_SETTINGS.verticalRangeRows,
    ),
    windowBuckets: clampFiniteInt(
      source.windowBuckets,
      1,
      MAX_L2_BOOK_MAP_WINDOW_BUCKETS,
      DEFAULT_L2_BOOK_MAP_SETTINGS.windowBuckets,
    ),
    minVolume:
      typeof source.minVolume === "number" &&
      Number.isFinite(source.minVolume) &&
      source.minVolume >= 0
        ? source.minVolume
        : DEFAULT_L2_BOOK_MAP_SETTINGS.minVolume,
    showProfile:
      typeof source.showProfile === "boolean"
        ? source.showProfile
        : DEFAULT_L2_BOOK_MAP_SETTINGS.showProfile,
    showBidPoc:
      typeof source.showBidPoc === "boolean"
        ? source.showBidPoc
        : DEFAULT_L2_BOOK_MAP_SETTINGS.showBidPoc,
    showAskPoc:
      typeof source.showAskPoc === "boolean"
        ? source.showAskPoc
        : DEFAULT_L2_BOOK_MAP_SETTINGS.showAskPoc,
    profileBidColor: isValidHexColor(source.profileBidColor)
      ? source.profileBidColor
      : DEFAULT_L2_BOOK_MAP_SETTINGS.profileBidColor,
    profileAskColor: isValidHexColor(source.profileAskColor)
      ? source.profileAskColor
      : DEFAULT_L2_BOOK_MAP_SETTINGS.profileAskColor,
    lowVolumeColor: isValidHexColor(source.lowVolumeColor)
      ? source.lowVolumeColor
      : DEFAULT_L2_BOOK_MAP_SETTINGS.lowVolumeColor,
    midVolumeColor: isValidHexColor(source.midVolumeColor)
      ? source.midVolumeColor
      : DEFAULT_L2_BOOK_MAP_SETTINGS.midVolumeColor,
    highVolumeColor: isValidHexColor(source.highVolumeColor)
      ? source.highVolumeColor
      : DEFAULT_L2_BOOK_MAP_SETTINGS.highVolumeColor,
  };
}

export interface L2BookMapCell {
  side: LiquiditySide;
  volume: number;
  priceLo: number;
  priceHi: number;
  timeStartMs: number;
  timeEndMs: number;
}

interface L2BookMapProfileRow {
  bid: number;
  ask: number;
  priceLo: number;
  priceHi: number;
}

export interface ChartTimeGeometry {
  originX: number;
  barSpacing: number;
  intervalMs: number;
  barOpensMs: readonly number[];
}

export interface ChartBarOpens {
  readonly revision: number;
  readonly opensMs: readonly number[];
}

const orderedOpens = new WeakSet<readonly number[]>();

function isOrdered(opens: readonly number[]): boolean {
  if (orderedOpens.has(opens)) return true;
  if (opens.some((open, index) => !Number.isFinite(open) || (index > 0 && open <= opens[index - 1]))) return false;
  orderedOpens.add(opens);
  return true;
}

export function chartTimeGeometry(
  chart: IChartApiBase<Time>,
  series: ISeriesApi<SeriesType, Time>,
  intervalMs: number,
  opens: readonly number[] | null = null,
): ChartTimeGeometry | null {
  const barOpensMs = opens ?? series.data().map((bar) => Number(bar.time) * 1000);
  if (barOpensMs.length === 0) return null;
  if (!isOrdered(barOpensMs)) return null;
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) return null;
  const timeScale = chart.timeScale();
  const lastIndex = timeScale.timeToIndex((barOpensMs[barOpensMs.length - 1] / 1000) as Time, false);
  const xCenter =
    lastIndex === null
      ? null
      : timeScale.logicalToCoordinate(lastIndex as unknown as Logical);
  const barSpacing = timeScale.options().barSpacing;
  if (xCenter === null || !(barSpacing > 0)) return null;
  return {
    originX: xCenter - barSpacing / 2,
    barSpacing,
    intervalMs,
    barOpensMs,
  };
}

export function barIndexAt(timeMs: number, opens: readonly number[]): number {
  let low = 0;
  let high = opens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (opens[middle] <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function cellEdges(cell: L2BookMapCell, geometry: ChartTimeGeometry): { left: number; right: number } | null {
  const index = barIndexAt(cell.timeStartMs, geometry.barOpensMs);
  if (index < 0) return null;
  const open = geometry.barOpensMs[index];
  const nextOpen = geometry.barOpensMs[index + 1];
  const contiguous = nextOpen === open + geometry.intervalMs;
  const end = Math.min(cell.timeEndMs, open + geometry.intervalMs * (contiguous ? 2 : 1));
  if (cell.timeStartMs >= open + geometry.intervalMs || end <= cell.timeStartMs) return null;
  const slotLeft = geometry.originX + (index - geometry.barOpensMs.length + 1) * geometry.barSpacing;
  const scale = geometry.barSpacing / geometry.intervalMs;
  return { left: slotLeft + (cell.timeStartMs - open) * scale, right: slotLeft + (end - open) * scale };
}

function timeAtX(x: number, geometry: ChartTimeGeometry): number | null {
  const slot = (x - geometry.originX) / geometry.barSpacing;
  const offset = Math.floor(slot);
  const index = geometry.barOpensMs.length - 1 + offset;
  if (index < 0 || index >= geometry.barOpensMs.length) return null;
  return geometry.barOpensMs[index] + (slot - offset) * geometry.intervalMs;
}

function firstCellAtOrAfter(cells: readonly L2BookMapCell[], timeMs: number): number {
  let low = 0;
  let high = cells.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cells[middle].timeStartMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function chartCellRange(
  cells: readonly L2BookMapCell[],
  geometry: ChartTimeGeometry,
  width: number,
): readonly [number, number] {
  const lastIndex = geometry.barOpensMs.length - 1;
  const firstIndex = Math.max(0, lastIndex + Math.floor(-geometry.originX / geometry.barSpacing));
  const endIndex = Math.min(lastIndex, lastIndex + Math.floor((width - geometry.originX) / geometry.barSpacing));
  if (firstIndex > endIndex) return [0, 0];
  const earliest = geometry.barOpensMs[firstIndex] - geometry.intervalMs;
  const latest = geometry.barOpensMs[endIndex] + geometry.intervalMs;
  return [firstCellAtOrAfter(cells, earliest), firstCellAtOrAfter(cells, latest)];
}

function profileRows(cells: readonly L2BookMapCell[]): L2BookMapProfileRow[] {
  const rows = new Map<string, L2BookMapProfileRow>();
  for (const cell of cells) {
    const key = `${cell.priceLo}:${cell.priceHi}`;
    const row = rows.get(key) ?? {
      bid: 0,
      ask: 0,
      priceLo: cell.priceLo,
      priceHi: cell.priceHi,
    };
    row[cell.side] += cell.volume;
    rows.set(key, row);
  }
  return [...rows.values()].sort((left, right) => left.priceLo - right.priceLo);
}

function verticalPriceBounds(
  cells: readonly L2BookMapCell[],
  series: ISeriesApi<SeriesType, Time>,
  settings: L2BookMapSettings,
  bookMid: number | null,
): { low: number; high: number } | null {
  if (settings.verticalRangeRows <= 0 || cells.length === 0) return null;
  const latestBar = series.data().at(-1) as { close?: unknown } | undefined;
  const currentPrice = bookMid ?? latestBar?.close;
  if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) return null;
  const rowWidth = Math.abs(cells[0].priceHi - cells[0].priceLo) / Math.max(1, settings.priceBinRows);
  if (!(rowWidth > 0)) return null;
  const offset = settings.verticalRangeRows * rowWidth;
  return { low: currentPrice - offset, high: currentPrice + offset };
}

function latestBookMid(column: L2ColumnView | null, rowWidth: number): number | null {
  if (!column) return null;
  let bidRow: number | null = null;
  let askRow: number | null = null;
  for (let index = column.bid.length - 1; index >= 0; index -= 1) {
    if (column.bid[index] > 0) { bidRow = column.lo + index; break; }
  }
  for (let index = 0; index < column.ask.length; index += 1) {
    if (column.ask[index] > 0) { askRow = column.lo + index; break; }
  }
  if (bidRow === null && askRow === null) return null;
  return ((bidRow ?? askRow ?? 0) + (askRow ?? bidRow ?? 0)) * rowWidth / 2;
}

type BookMapPaint =
  | { kind: "fill"; style: string; x: number; y: number; width: number; height: number }
  | { kind: "poc"; color: string; y: number; toX: number }
  | { kind: "truncated" }
  | { kind: "status"; label: string };

type BookMapColumn = L2ColumnView;

type BookMapFeed = Readonly<{
  key: string;
  identity: string;
  rowWidth: number;
  latest: BookMapColumn;
  columns: readonly BookMapColumn[];
  columnMs: number;
  deepColumns: readonly BookMapColumn[];
  deepColumnMs: number;
}>;

interface BookMapPaintCache {
  cells: readonly L2BookMapCell[];
  settings: L2BookMapSettings;
  opens: readonly number[];
  key: string;
  paint: readonly BookMapPaint[];
}

const MAX_BOOK_MAP_IMAGE_PIXELS = 40_000_000;

interface BookMapImage {
  paint: readonly BookMapPaint[];
  scaleX: number;
  scaleY: number;
  canvas: HTMLCanvasElement;
}

function bookMapPaint(
  paneCells: readonly { cell: L2BookMapCell; edges: { left: number; right: number } }[],
  settings: L2BookMapSettings,
  truncated: boolean,
  mediaSize: { width: number; height: number },
  yOf: (price: number) => number | null,
): BookMapPaint[] {
  const paint: BookMapPaint[] = [];
  const maxVolume = paneCells.reduce(
    (maximum, { cell }) => Math.max(maximum, cell.volume),
    0,
  );
  const low = hexToRgb(settings.lowVolumeColor);
  const mid = hexToRgb(settings.midVolumeColor);
  const high = hexToRgb(settings.highVolumeColor);

  for (const { cell, edges } of paneCells) {
    const x1 = edges.left;
    const x2 = edges.right;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    if (right < 0 || left > mediaSize.width) continue;
    const yTop = yOf(cell.priceHi);
    const yBottom = yOf(cell.priceLo);
    if (yTop === null || yBottom === null) continue;

    const intensity =
      maxVolume > 0 ? Math.min(1, cell.volume / maxVolume) : 0;
    const alpha = 0.0 + intensity;
    const color = volumeColor(low, mid, high, intensity, alpha);

    const top = Math.min(yTop, yBottom);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(yTop - yBottom);

    paint.push({ kind: "fill", style: color, x: left, y: top, width: Math.max(width, 1), height: Math.max(height, 1) });

    const tick = Math.max(1, Math.min(3, Math.round(1 + intensity * 3)));
    const tickStyle =
      cell.side === "bid"
        ? "rgba(255,255,255,0.15)"
        : "rgba(255,255,255,0.12)";
    paint.push({ kind: "fill", style: tickStyle, x: left + 1, y: top + 1, width: Math.max(1, width - 2), height: tick });
    paint.push({
      kind: "fill",
      style: tickStyle,
      x: left + 1,
      y: top + Math.max(1, height - tick - 1),
      width: Math.max(1, width - 2),
      height: tick,
    });
  }

  if (settings.showProfile) {
    const rows = profileRows(paneCells.map(({ cell }) => cell));
    const profileMax = rows.reduce(
      (maximum, row) => Math.max(maximum, row.bid, row.ask),
      0,
    );
    if (rows.length > 0 && profileMax > 0) {
      const profileWidth = bookMapProfileWidthPx(mediaSize.width);
      const profileRight = mediaSize.width - BOOK_MAP_PROFILE_EDGE_GAP_PX;
      const profileCenter = profileRight - profileWidth / 2;
      const halfWidth = profileWidth / 2 - 3;

      paint.push({ kind: "fill", style: "rgba(255, 255, 255, 0.72)", x: profileCenter - halfWidth - 3, y: 0, width: profileWidth + 6, height: mediaSize.height });
      paint.push({ kind: "fill", style: "rgba(20, 20, 30, 0.22)", x: profileCenter - 0.5, y: 0, width: 1, height: mediaSize.height });

      for (const row of rows) {
        const yTop = yOf(row.priceHi);
        const yBottom = yOf(row.priceLo);
        if (yTop === null || yBottom === null) continue;
        const top = Math.min(yTop, yBottom);
        const height = Math.max(1, Math.abs(yBottom - yTop));
        const bidWidth = halfWidth * Math.min(1, row.bid / profileMax);
        const askWidth = halfWidth * Math.min(1, row.ask / profileMax);

        if (bidWidth > 0) {
          const intensity = row.bid / profileMax;
          paint.push({ kind: "fill", style: `rgba(${hexToRgb(settings.profileBidColor).join(", ")}, ${0.25 + intensity * 0.55})`, x: profileCenter, y: top, width: bidWidth, height });
        }
        if (askWidth > 0) {
          const intensity = row.ask / profileMax;
          paint.push({ kind: "fill", style: `rgba(${hexToRgb(settings.profileAskColor).join(", ")}, ${0.25 + intensity * 0.55})`, x: profileCenter - askWidth, y: top, width: askWidth, height });
        }
      }

      const bidPoc =
        rows.reduce<L2BookMapProfileRow | null>(
          (best, row) => (row.bid > (best?.bid ?? 0) ? row : best),
          null,
        );
      const askPoc =
        rows.reduce<L2BookMapProfileRow | null>(
          (best, row) => (row.ask > (best?.ask ?? 0) ? row : best),
          null,
        );
      const pocAt = (
        row: L2BookMapProfileRow | null,
        volume: number,
        color: string,
      ) => {
        if (!row || volume <= 0) return;
        const yTop = yOf(row.priceHi);
        const yBottom = yOf(row.priceLo);
        if (yTop === null || yBottom === null) return;
        const y = (Math.min(yTop, yBottom) + Math.max(yTop, yBottom)) / 2;
        paint.push({ kind: "poc", color, y, toX: profileCenter });
      };
      if (settings.showBidPoc) {
        pocAt(bidPoc, bidPoc?.bid ?? 0, settings.profileBidColor);
      }
      if (settings.showAskPoc) {
        pocAt(askPoc, askPoc?.ask ?? 0, settings.profileAskColor);
      }
    }
  }
  if (truncated) paint.push({ kind: "truncated" });
  return paint;
}

function paintBookMap(context: CanvasRenderingContext2D, paint: readonly BookMapPaint[]): void {
  for (const step of paint) {
    if (step.kind === "fill") {
      context.fillStyle = step.style;
      context.fillRect(step.x, step.y, step.width, step.height);
    } else if (step.kind === "poc") {
      context.save();
      context.strokeStyle = step.color;
      context.globalAlpha = 0.72;
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(0, step.y);
      context.lineTo(step.toX, step.y);
      context.stroke();
      context.restore();
    } else if (step.kind === "truncated") {
      drawStatusBadge(context, STATUS_BADGE_SLOT.bookMapCellCap, "BOOKMAP PARTIAL · CELL CAP");
    } else {
      drawStatusBadge(context, STATUS_BADGE_SLOT.bookMapSource, step.label);
    }
  }
}

class L2BookMapRenderer implements IPrimitivePaneRenderer {
  private readonly _primitive: L2BookMapPrimitive;

  constructor(primitive: L2BookMapPrimitive) {
    this._primitive = primitive;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        this._primitive.render(context, mediaSize);
      } finally {
        context.restore();
      }
    });
  }
}

class L2BookMapPaneView implements IPrimitivePaneView {
  private readonly _primitive: L2BookMapPrimitive;

  constructor(primitive: L2BookMapPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this._primitive.chart || !this._primitive.series) return null;
    return new L2BookMapRenderer(this._primitive);
  }
}

export class L2BookMapPrimitive implements ISeriesPrimitive<Time> {
  private readonly _intervalMsProvider: () => number;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _grid: LiquidityGrid | null = null;
  private _l2: IndicatorL2 | null = null;
  private _settings: L2BookMapSettings = {
    ...DEFAULT_L2_BOOK_MAP_SETTINGS,
  };
  private _gridVersion = "";
  private _feedIdentity = "";
  private _bookMid: number | null = null;
  private _sourceStatus: string | null = null;
  private readonly _columnCells = new Map<BookMapColumn, { start: number; end: number; cells: ReadonlyMap<string, L2BookMapCell> }>();
  private readonly _bucketCells = new Map<string, L2BookMapCell>();
  private readonly _bucketFeeds = new Map<string, number>();
  private readonly _paneViews: readonly IPrimitivePaneView[] = [
    new L2BookMapPaneView(this),
  ];
  private readonly _barOpensProvider: () => ChartBarOpens | null;
  private _paintCache: BookMapPaintCache | null = null;
  private _image: BookMapImage | null = null;
  cells: readonly L2BookMapCell[] = [];
  truncated = false;

  constructor(
    intervalMsProvider: () => number = () => 60_000,
    barOpensProvider: () => ChartBarOpens | null = () => null,
  ) {
    this._intervalMsProvider = intervalMsProvider;
    this._barOpensProvider = barOpensProvider;
  }

  private _geometry(): ChartTimeGeometry | null {
    if (!this._chart || !this._series) return null;
    return chartTimeGeometry(this._chart, this._series, this.intervalMs, this._barOpensProvider()?.opensMs ?? null);
  }

  paintFor(mediaSize: { width: number; height: number }): readonly BookMapPaint[] {
    const series = this._series;
    const geometry = this._geometry();
    const cells = this.cells;
    if (!series || !geometry) return [];
    if (cells.length === 0) return this._sourceStatus === null ? [] : [{ kind: "status", label: this._sourceStatus }];
    const bounds = verticalPriceBounds(cells, series, this._settings, this._bookMid);
    const [from, to] = chartCellRange(cells, geometry, mediaSize.width);
    const positions = new Map<number, number | null>();
    const yOf = (price: number): number | null => {
      let y = positions.get(price);
      if (y === undefined) {
        y = series.priceToCoordinate(price);
        positions.set(price, y);
      }
      return y;
    };
    // The paint holds finished pixels, so the key has to move with the price scale as well as the time axis.
    // Sampling one cell is not enough: that cell can sit off-view, its coordinate goes null, and the key then
    // ignores every vertical pan and zoom and hands back stale pixels ("pixels rot on pan/zoom"). Key off the
    // visible price range's own endpoints (the pane edges are fixed, so their price VALUES are the signature).
    const probe = from < to ? cells[from] : null;
    const priceScale = typeof series.priceScale === "function" ? series.priceScale() : null;
    const priceRange = priceScale !== null && typeof priceScale.getVisibleRange === "function" ? priceScale.getVisibleRange() : null;
    const scaleSignature = priceRange === null
      ? `${probe === null ? "" : yOf(probe.priceHi)}:${probe === null ? "" : yOf(probe.priceLo)}`
      : `${priceRange.from}:${priceRange.to}`;
    const key = [
      geometry.originX, geometry.barSpacing, geometry.intervalMs, mediaSize.width, mediaSize.height, from, to,
      scaleSignature,
      bounds === null ? "" : `${bounds.low}:${bounds.high}`, this._bookMid ?? "", this.truncated, this._sourceStatus ?? "",
    ].join("|");
    const cached = this._paintCache;
    if (cached !== null && cached.cells === cells && cached.settings === this._settings && cached.opens === geometry.barOpensMs && cached.key === key) {
      return cached.paint;
    }
    const visible = cells.slice(from, to);
    const inBounds = bounds !== null
      ? visible.filter((cell) => cell.priceHi >= bounds.low && cell.priceLo <= bounds.high)
      : visible;
    const paneCells = inBounds.flatMap((cell) => {
      const edges = cellEdges(cell, geometry);
      return edges && edges.right >= 0 && edges.left <= mediaSize.width ? [{ cell, edges }] : [];
    });
    const paint = bookMapPaint(paneCells, this._settings, this.truncated, mediaSize, yOf);
    if (this._sourceStatus !== null) paint.push({ kind: "status", label: this._sourceStatus });
    this._paintCache = { cells, settings: this._settings, opens: geometry.barOpensMs, key, paint };
    return paint;
  }

  render(context: CanvasRenderingContext2D, mediaSize: { width: number; height: number }): void {
    const paint = this.paintFor(mediaSize);
    const image = this._imageFor(context, paint, mediaSize);
    if (image === null) {
      paintBookMap(context, paint);
      return;
    }
    context.drawImage(image.canvas, 0, 0, image.canvas.width / image.scaleX, image.canvas.height / image.scaleY);
  }

  private _releaseImage(): void {
    const held = this._image;
    if (held === null) return;
    held.canvas.width = 0;
    held.canvas.height = 0;
    this._image = null;
  }

  private _imageFor(context: CanvasRenderingContext2D, paint: readonly BookMapPaint[], mediaSize: { width: number; height: number }): BookMapImage | null {
    if (paint.length === 0) {
      this._releaseImage();
      return null;
    }
    if (typeof document === "undefined" || typeof context.getTransform !== "function") return null;
    const { a: scaleX, d: scaleY } = context.getTransform();
    if (!(scaleX > 0) || !(scaleY > 0)) return null;
    const width = Math.max(1, Math.round(mediaSize.width * scaleX));
    const height = Math.max(1, Math.round(mediaSize.height * scaleY));
    if (!(width * height <= MAX_BOOK_MAP_IMAGE_PIXELS)) return null;
    const held = this._image;
    if (held !== null && held.paint === paint && held.scaleX === scaleX && held.scaleY === scaleY) return held;
    const canvas = held?.canvas ?? document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const offscreen = canvas.getContext("2d");
    if (offscreen === null) return null;
    offscreen.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    paintBookMap(offscreen, paint);
    const image: BookMapImage = { paint, scaleX, scaleY, canvas };
    this._image = image;
    return image;
  }

  get intervalMs(): number {
    return this._intervalMsProvider();
  }

  get bookMid(): number | null {
    return this._bookMid;
  }

  get chart(): IChartApiBase<Time> | null {
    return this._chart;
  }

  get series(): ISeriesApi<SeriesType, Time> | null {
    return this._series;
  }

  get settings(): L2BookMapSettings {
    return this._settings;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._releaseImage();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this.cells = [];
    this.truncated = false;
    this._columnCells.clear();
    this._bucketCells.clear();
    this._bucketFeeds.clear();
    this._gridVersion = "";
    this._feedIdentity = "";
    this._bookMid = null;
    this._sourceStatus = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setGrid(grid: LiquidityGrid | null): void {
    this.setSource(null, grid);
  }

  setSource(l2: IndicatorL2 | null, grid: LiquidityGrid | null): void {
    if (this._l2 === l2 && this._grid === grid) {
      this.refresh();
      return;
    }
    this._columnCells.clear();
    this._bucketCells.clear();
    this._bucketFeeds.clear();
    this._grid = grid;
    this._l2 = l2;
    this._gridVersion = "";
    this._feedIdentity = "";
    this.refresh();
  }

  setSettings(settings: L2BookMapSettings): void {
    this._settings = normalizeL2BookMapSettings(settings);
    this._columnCells.clear();
    this._bucketCells.clear();
    this._bucketFeeds.clear();
    this._gridVersion = "";
    this.refresh();
  }

  cellAt(x: number, y: number): L2BookMapCell | null {
    if (!this._chart || !this._series || this.cells.length === 0) return null;
    const geometry = this._geometry();
    if (!geometry) return null;
    const bounds = verticalPriceBounds(this.cells, this._series, this._settings, this._bookMid);
    const hoverTimeMs = timeAtX(x, geometry);
    if (hoverTimeMs === null) return null;
    let low = 0;
    let high = this.cells.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.cells[middle].timeStartMs <= hoverTimeMs) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0; index -= 1) {
      const cell = this.cells[index];
      if (cell.timeEndMs < hoverTimeMs) break;
      if (bounds && (cell.priceHi < bounds.low || cell.priceLo > bounds.high)) continue;
      const yTop = this._series.priceToCoordinate(cell.priceHi);
      const yBottom = this._series.priceToCoordinate(cell.priceLo);
      if (yTop === null || yBottom === null) continue;
      if (y >= Math.min(yTop, yBottom) && y <= Math.max(yTop, yBottom)) {
        return cell;
      }
    }
    return null;
  }

  refresh(): void {
    this._rebuildCells();
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    this._rebuildCells();
  }

  private _feed(): BookMapFeed | null {
    const l2 = this._l2;
    if (l2 !== null) {
      const historical = l2.availability === "HISTORICAL";
      if ((!historical && (l2.availability !== "LIVE" || l2.segment()?.state !== "LIVE")) || !l2.status("l2_view").synced) {
        this._sourceStatus = "BOOKMAP · L2 UNTRUSTED";
        return null;
      }
      const bounds = this._series?.priceScale().getVisibleRange() ?? null;
      const lanes = l2.lanes();
      let lane = bounds === null ? 0 : l2.laneFor(bounds.from, bounds.to);
      let info = lanes.find((item) => item.lane === lane);
      let view = l2.view(lane);
      // A coarser lane can arrive with no deep tier, or with a deep tier that has a hole in it (the runtime does not
      // always backfill every lane's deep). Either way the map keeps only the ~20 min fine window and a zoom-out reads
      // as the heatmap vanishing. Losing the past is worse than a narrower band, so move to a lane whose deep tier is
      // continuous -- preferring one that also covers the view, then the one with the most history.
      const holdsHistory = (candidate: L2LaneView | null): boolean => {
        if (candidate === null || candidate.deep === null || candidate.deep.columns.length === 0) return false;
        const deepColumns = candidate.deep.columns;
        let gap = 0;
        for (let index = 1; index < deepColumns.length; index += 1) gap = Math.max(gap, deepColumns[index].ts - deepColumns[index - 1].ts);
        return gap <= Math.max(6 * candidate.deep.columnMs, 2 * 60_000);
      };
      if (!holdsHistory(view)) {
        const from = bounds === null ? null : Math.min(bounds.from, bounds.to);
        const to = bounds === null ? null : Math.max(bounds.from, bounds.to);
        const covers = (candidate: L2LaneInfo): boolean => from === null || to === null || (candidate.priceLo <= from && candidate.priceHi >= to);
        let best: { info: L2LaneInfo; view: L2LaneView; span: number } | null = null;
        for (const item of lanes) {
          const candidate = l2.view(item.lane);
          if (!holdsHistory(candidate)) continue;
          const deep = (candidate as L2LaneView).deep;
          const span = deep === null ? 0 : deep.columns.length * deep.columnMs;
          const better = best === null
            || (covers(item) && !covers(best.info))
            || (covers(item) === covers(best.info) && span > best.span);
          if (better) best = { info: item, view: candidate as L2LaneView, span };
        }
        if (best !== null) {
          lane = best.info.lane;
          info = best.info;
          view = best.view;
        }
      }
      const latest = view?.fine.columns.at(-1) ?? view?.deep?.columns.at(-1);
      if (info === undefined || view === null || latest === undefined) {
        this._sourceStatus = "BOOKMAP · L2 VIEW UNAVAILABLE";
        return null;
      }
      const complete = bounds === null || (info.priceLo <= bounds.from && info.priceHi >= bounds.to);
      this._sourceStatus = historical ? "BOOKMAP · HISTORICAL TOP 10 · 1s CLOSE" : complete ? null : "BOOKMAP PARTIAL · LANE RANGE";
      const identity = `l2:${lane}:${view.epoch}:${info.rowWidth}:${view.fine.columnMs}:${view.deep?.columnMs ?? 0}:${this.intervalMs}`;
      return {
        key: `${identity}:${lane === 0 ? this._grid?.version ?? l2.version : l2.version}`,
        identity,
        rowWidth: info.rowWidth,
        latest,
        columns: view.fine.columns,
        columnMs: view.fine.columnMs,
        deepColumns: view.deep?.columns ?? [],
        deepColumnMs: view.deep?.columnMs ?? 0,
      };
    }
    const grid = this._grid;
    const latest = grid?.latest;
    if (grid === null || latest === null || latest === undefined) {
      this._sourceStatus = null;
      return null;
    }
    this._sourceStatus = "BOOKMAP · LEGACY GRID";
    return {
      key: `grid:${grid.epoch}:${grid.rowWidth}:${grid.version}:${this.intervalMs}`,
      identity: `grid:${grid.epoch}:${grid.rowWidth}:${this.intervalMs}`,
      rowWidth: grid.rowWidth,
      latest,
      columns: grid.columns,
      columnMs: grid.columnMs,
      deepColumns: grid.deepColumns,
      deepColumnMs: grid.deepColumnMs,
    };
  }

  private _rebuildCells(): void {
    const feed = this._feed();
    const latest = feed?.latest;
    if (!feed || !latest || !(feed.rowWidth > 0)) {
      this.cells = [];
      this.truncated = false;
      this._columnCells.clear();
      this._bucketCells.clear();
      this._bucketFeeds.clear();
      this._gridVersion = "";
      this._feedIdentity = "";
      this._bookMid = null;
      return;
    }
    if (feed.key === this._gridVersion) return;
    if (this._feedIdentity !== feed.identity) {
      this._columnCells.clear();
      this._bucketCells.clear();
      this._bucketFeeds.clear();
      this._feedIdentity = feed.identity;
    }
    this._gridVersion = feed.key;
    this._bookMid = latestBookMid(latest, feed.rowWidth);

    const settings = normalizeL2BookMapSettings(this._settings);
    this._settings = settings;
    // One time bucket per candle: the timeframe's interval is the bucket, whatever the chart shows.
    const timeBucketMs = Math.max(1, this.intervalMs);
    const windowMs = settings.windowBuckets * timeBucketMs;
    const priceBinRows = Math.max(1, settings.priceBinRows);
    const priceBinWidth = priceBinRows * feed.rowWidth;
    const cutoff = latest.ts - windowMs;
    const activeColumns = new Set<BookMapColumn>();
    const fineStart = feed.columns[0]?.ts ?? Number.POSITIVE_INFINITY;
    const dropColumn = (column: BookMapColumn) => {
      const old = this._columnCells.get(column);
      if (!old) return;
      for (const [key, cell] of old.cells) {
        const bucket = this._bucketCells.get(key);
        if (!bucket) continue;
        const feeds = (this._bucketFeeds.get(key) ?? 1) - 1;
        if (feeds <= 0) {
          this._bucketCells.delete(key);
          this._bucketFeeds.delete(key);
        } else {
          bucket.volume -= cell.volume;
          this._bucketFeeds.set(key, feeds);
        }
      }
      this._columnCells.delete(column);
    };
    const addColumn = (
      column: BookMapColumn,
      columnMs: number,
      endLimit: number,
    ) => {
      const start = Math.max(column.ts, cutoff);
      const end = Math.min(column.ts + columnMs, endLimit);
      if (end <= start) return;
      activeColumns.add(column);
      const previous = this._columnCells.get(column);
      if (previous?.start === start && previous.end === end) return;
      if (previous) dropColumn(column);
      const contributions = new Map<string, L2BookMapCell>();
      for (let bucketStart = Math.floor(start / timeBucketMs) * timeBucketMs; bucketStart < end; bucketStart += timeBucketMs) {
        const sampleWeight = (Math.min(end, bucketStart + timeBucketMs) - Math.max(start, bucketStart)) / 1_000;
        for (const side of ["bid", "ask"] as const) {
          for (let row = column.lo; row <= column.hi; row += 1) {
            const value = column[side][row - column.lo];
            if (!(value > 0)) continue;
            const priceBinIndex = Math.floor(row / priceBinRows);
            const priceLo = priceBinIndex * priceBinWidth;
            const priceHi = priceLo + priceBinWidth;
            const bucketKey = `${side}:${bucketStart}:${priceBinIndex}`;
            const current = contributions.get(bucketKey) ?? {
              side,
              volume: 0,
              priceLo,
              priceHi,
              timeStartMs: bucketStart,
              timeEndMs: bucketStart + timeBucketMs,
            };
            current.volume += value * sampleWeight;
            contributions.set(bucketKey, current);
          }
        }
      }
      this._columnCells.set(column, { start, end, cells: contributions });
      for (const [key, cell] of contributions) {
        const bucket = this._bucketCells.get(key);
        if (bucket) bucket.volume += cell.volume;
        else this._bucketCells.set(key, { ...cell });
        this._bucketFeeds.set(key, (this._bucketFeeds.get(key) ?? 0) + 1);
      }
    };

    for (const column of feed.deepColumns) {
      if (column.ts >= fineStart) continue;
      addColumn(column, feed.deepColumnMs, fineStart);
    }
    for (const column of feed.columns) {
      addColumn(column, feed.columnMs, Number.POSITIVE_INFINITY);
    }

    for (const column of this._columnCells.keys()) {
      if (activeColumns.has(column)) continue;
      dropColumn(column);
    }

    const cells = Array.from(this._bucketCells.values())
      .filter((cell) => cell.volume >= settings.minVolume)
      .sort(
        (left, right) =>
          left.timeStartMs - right.timeStartMs ||
          left.priceLo - right.priceLo ||
          left.side.localeCompare(right.side),
      );
    this.truncated = cells.length > MAX_L2_BOOK_MAP_CELLS;
    this.cells =
      this.truncated
        ? cells.slice(-MAX_L2_BOOK_MAP_CELLS)
        : cells;
  }
}
