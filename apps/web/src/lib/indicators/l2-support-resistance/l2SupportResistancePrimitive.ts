import type {
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
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type { LiquidityGrid } from "../passive-liquidity/liquidityGrid";

export interface L2SupportResistanceSettings {
  maxLevels: number;
  minimumDistanceRows: number;
  lookbackMinutes: number;
  minimumLiquiditySize: number;
  bidColor: string;
  askColor: string;
}

export const DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS: L2SupportResistanceSettings =
  {
    maxLevels: 15,
    minimumDistanceRows: 15,
    lookbackMinutes: 10,
    minimumLiquiditySize: 0,
    bidColor: "#16ad80",
    askColor: "#d8116e",
  };

function clampFiniteInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export const L2_SUPPORT_RESISTANCE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<L2SupportResistanceSettings>[] = [
  { kind: "numeric", key: "maxLevels", label: "Max levels", min: 1, max: 20, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "minimumDistanceRows", label: "Minimum distance", min: 1, max: 100, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "lookbackMinutes", label: "Lookback", min: 1, max: 120, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "numeric", key: "minimumLiquiditySize", label: "Minimum size", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
  { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
];

export function normalizeL2SupportResistanceSettings(
  settings: Partial<L2SupportResistanceSettings> | null | undefined,
): L2SupportResistanceSettings {
  const source = settings ?? {};
  const minimumLiquiditySize =
    typeof source.minimumLiquiditySize === "number" &&
    Number.isFinite(source.minimumLiquiditySize) &&
    source.minimumLiquiditySize >= 0
      ? source.minimumLiquiditySize
      : DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.minimumLiquiditySize;
  return {
    maxLevels: clampFiniteInt(
      source.maxLevels,
      1,
      20,
      DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.maxLevels,
    ),
    minimumDistanceRows: clampFiniteInt(
      source.minimumDistanceRows,
      1,
      100,
      DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.minimumDistanceRows,
    ),
    lookbackMinutes: clampFiniteInt(
      source.lookbackMinutes,
      1,
      120,
      DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.lookbackMinutes,
    ),
    minimumLiquiditySize,
    bidColor: isValidHexColor(source.bidColor)
      ? source.bidColor
      : DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.bidColor,
    askColor: isValidHexColor(source.askColor)
      ? source.askColor
      : DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.askColor,
  };
}

interface RenderLevel {
  price: number;
  size: number;
  side: "bid" | "ask";
  detail?: string;
}

class L2LevelsRenderer implements IPrimitivePaneRenderer {
  private readonly _levels: readonly RenderLevel[];
  private readonly _series: ISeriesApi<SeriesType, Time>;

  private readonly _settings: L2SupportResistanceSettings;
  private readonly _sourceStatus: string | null;

  constructor(
    levels: readonly RenderLevel[],
    series: ISeriesApi<SeriesType, Time>,
    settings: L2SupportResistanceSettings,
    sourceStatus: string | null,
  ) {
    this._levels = levels;
    this._series = series;
    this._settings = settings;
    this._sourceStatus = sourceStatus;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        context.font = "10px monospace";
        context.textAlign = "right";
        context.textBaseline = "middle";
        const maxSize = this._levels.reduce(
          (maximum, level) => Math.max(maximum, level.size),
          0,
        );
        for (const level of this._levels) {
          const y = this._series.priceToCoordinate(level.price);
          if (y === null) continue;
          const color =
            level.side === "bid"
              ? this._settings.bidColor
              : this._settings.askColor;
          const strength = maxSize > 0 ? Math.sqrt(level.size / maxSize) : 0;
          const zoneHeight = 5 + strength * 19;
          context.fillStyle = color;
          context.globalAlpha = 0.08 + strength * 0.22;
          context.fillRect(0, y - zoneHeight / 2, mediaSize.width, zoneHeight);
          context.globalAlpha = 0.35 + strength * 0.5;
          context.shadowColor = color;
          context.shadowBlur = 4 + strength * 8;
          context.fillRect(0, y - 0.5, mediaSize.width, 1);
          context.shadowBlur = 0;
          context.globalAlpha = 1;
          const sideLabel = level.side === "bid" ? "S" : "R";
          const label = `${level.price.toFixed(2)}  ${formatSize(level.size)}${level.detail ?? ""}`;
          const labelWidth = context.measureText(label).width + 28;
          const labelX = mediaSize.width - labelWidth - 6;
          const labelY = y - 10;
          context.fillStyle = "rgba(241, 241, 241, 0.92)";
          context.strokeStyle = color;
          context.lineWidth = 1;
          context.beginPath();
          context.roundRect(labelX, labelY, labelWidth, 20, 4);
          context.fill();
          context.stroke();
          context.fillStyle = color;
          context.font = "bold 9px monospace";
          context.textAlign = "left";
          context.fillText(sideLabel, labelX + 7, y);
          context.font = "10px monospace";
          context.textAlign = "right";
          context.fillStyle = color;
          context.fillText(label, mediaSize.width - 12, y);
        }
        if (this._sourceStatus !== null) drawStatusBadge(context, STATUS_BADGE_SLOT.supportResistance, this._sourceStatus);
      } finally {
        context.restore();
      }
    });
  }
}

class L2LevelsPaneView implements IPrimitivePaneView {
  private readonly _primitive: L2SupportResistancePrimitive;

  constructor(primitive: L2SupportResistancePrimitive) {
    this._primitive = primitive;
  }
  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer | null {
    return this._primitive.series
      ? new L2LevelsRenderer(
          this._primitive.levels,
          this._primitive.series,
          this._primitive.settings,
          this._primitive.sourceStatus,
        )
      : null;
  }
}

function formatSize(size: number): string {
  if (size >= 1000) return `${(size / 1000).toFixed(1)}k`;
  if (size >= 100) return size.toFixed(0);
  return size.toFixed(2);
}

export class L2SupportResistancePrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _grid: LiquidityGrid | null = null;
  private _l2: IndicatorL2 | null = null;
  private _settings: L2SupportResistanceSettings = {
    ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
  };
  private _gridVersion = -1;
  private _l2Version = "";
  sourceStatus: string | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[] = [
    new L2LevelsPaneView(this),
  ];
  levels: readonly RenderLevel[] = [];

  get series(): ISeriesApi<SeriesType, Time> | null {
    return this._series;
  }
  get settings(): L2SupportResistanceSettings {
    return this._settings;
  }
  attached(param: SeriesAttachedParameter<Time>): void {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }
  detached(): void {
    this._series = null;
    this._requestUpdate = null;
    this.levels = [];
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setGrid(grid: LiquidityGrid | null): void {
    this.setSource(null, grid);
  }

  setSource(l2: IndicatorL2 | null, grid: LiquidityGrid | null): void {
    if (this._l2 !== l2) {
      this._l2Version = "";
      this._gridVersion = -1;
    }
    this._l2 = l2;
    if (this._grid === grid) {
      this.refresh();
      return;
    }
    this._grid = grid;
    this._gridVersion = -1;
    this.refresh();
  }

  setSettings(settings: L2SupportResistanceSettings): void {
    this._settings = normalizeL2SupportResistanceSettings(settings);
    this._gridVersion = -1;
    this._l2Version = "";
    this.refresh();
  }

  refresh(): void {
    this._rebuildLevels();
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    this._rebuildLevels();
  }

  private _rebuildLevels(): void {
    const l2 = this._l2;
    if (l2 !== null) {
      if (l2.availability === "HISTORICAL_UNAVAILABLE" || l2.segment()?.state !== "LIVE" || !l2.status("l2_walls").synced) {
        this.levels = [];
        this.sourceStatus = "L2 S/R · UNTRUSTED";
        this._l2Version = "";
        return;
      }
      const rowWidth = l2.lanes().find((info) => info.lane === 0)?.rowWidth;
      const latest = l2.status("l2_walls").lastTs;
      const key = `${l2.status("l2_walls").seq ?? l2.version}:${rowWidth ?? ""}:${latest ?? ""}`;
      if (this._l2Version === key) return;
      this._l2Version = key;
      this.sourceStatus = l2.availability === "HISTORICAL"
        ? `L2 S/R · TOP 10 · INDEXED WALLS ≥ ${l2.wallProfile?.minimumSize ?? "?"}` : null;
      if (rowWidth === undefined || !(rowWidth > 0) || latest === null) {
        this.levels = [];
        this.sourceStatus = "L2 S/R · VIEW UNAVAILABLE";
        return;
      }
      const cutoff = latest - this._settings.lookbackMinutes * 60_000;
      const selected: RenderLevel[] = [];
      for (const wall of [...l2.walls(0)]
        .filter((wall) => wall.endTs === null && wall.startTs >= cutoff && Number.isFinite(wall.size)
          && wall.size > 0 && wall.size >= this._settings.minimumLiquiditySize)
        .sort((left, right) => right.ratio - left.ratio || right.size - left.size)) {
        const price = (wall.row + wall.span / 2) * rowWidth;
        if (selected.some((level) => Math.abs(level.price - price) < rowWidth * this._settings.minimumDistanceRows)) continue;
        const detail = wall.detail === null ? undefined
          : `  F${Math.round(wall.detail.fillRatio * 100)}%${wall.detail.evidenceGap ? " GAP" : ""}`;
        selected.push({ price, size: wall.size, side: wall.side, detail });
        if (selected.length === this._settings.maxLevels) break;
      }
      this.levels = selected;
      return;
    }
    const grid = this._grid;
    const latest = grid?.latest;
    if (!grid || !latest || !(grid.rowWidth > 0)) {
      this.levels = [];
      this.sourceStatus = null;
      this._gridVersion = -1;
      return;
    }
    if (grid.version === this._gridVersion) return;
    this._gridVersion = grid.version;
    this.sourceStatus = "L2 S/R · LEGACY GRID";
    const selected: RenderLevel[] = [];
    const cutoff = latest.ts - this._settings.lookbackMinutes * 60_000;
    for (const wall of [...grid.levels]
      .filter(
        (wall) =>
          wall.end_ts === null &&
          wall.start_ts >= cutoff &&
          Number.isFinite(wall.size) &&
          wall.size > 0 &&
          wall.size >= this._settings.minimumLiquiditySize,
      )
      .sort(
        (left, right) => right.ratio - left.ratio || right.size - left.size,
      )) {
      const price = (wall.row + wall.span / 2) * grid.rowWidth;
      if (
        selected.some(
          (level) =>
            Math.abs(level.price - price) <
            grid.rowWidth * this._settings.minimumDistanceRows,
        )
      )
        continue;
      selected.push({ price, size: wall.size, side: wall.side });
      if (selected.length === this._settings.maxLevels) break;
    }
    this.levels = selected;
  }
}
