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
import type { ChartRowsProvider } from "../../chart/chartData";
import type { ExhaustionShade, ExhaustionStatus } from "../../../types/frames";
import type { ExhaustionBook } from "../../l2/exhaustionBook";
import { parseRgb } from "../passive-liquidity/liquidityHeatmapHost";
import { css } from "../aggressive-orders/aggressiveOrdersRenderer";
import { candleX } from "../aggressive-orders/aggressiveOrdersPrimitive";
import { barIntervalSecOf } from "../absorption-detector/absorptionPrimitive";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import { DEFAULT_EXHAUSTION_SETTINGS, DEFAULT_ZONE_SCALE, exhaustionCalibrated, exhaustionColorOf, exhaustionLoadingLabel, exhaustionOpacityOf, exhaustionZoneScaleOf, legSettingsOf, shownShades, zoneHeightOf, type ExhaustionSettings } from "./exhaustionSettings";
import { describeExhaustion, scoreLabel, type ExhaustionHover } from "./exhaustionHover";
import { catchLegs, type Leg, type LegBar } from "./legCatcher";

export const LEG_RIM_WIDTH = 1;
export const LEG_FILL_SHARE = 0.08;
export const LEG_OPEN_DASH: readonly number[] = [4, 3];
export const LEG_LABEL_FONT = "600 10px 'JetBrains Mono', 'Fira Code', monospace";
export const LEG_LABEL_PAD = 3;

export interface LegBox {
  left: number;
  top: number;
  width: number;
  height: number;
  leg: Leg;
}

export function layoutLegs(legs: readonly Leg[], geometry: ExhaustionGeometry): LegBox[] {
  const boxes: LegBox[] = [];
  for (const leg of legs) {
    const left = geometry.xOf(leg.startTime * 1000);
    const right = geometry.xOf(leg.extremeTime * 1000);
    const up = leg.side === "up";
    const top = geometry.yOf(up ? leg.extremePrice : leg.startPrice);
    const bottom = geometry.yOf(up ? leg.startPrice : leg.extremePrice);
    if (left === null || right === null || top === null || bottom === null) continue;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    if (left + width < 0 || left > geometry.width || bottom < 0 || top > geometry.height) continue;
    boxes.push({ left, top, width, height, leg });
  }
  return boxes;
}

const REPAINT_MIN_INTERVAL_MS = 100;

export const FLASH_HALF_PERIOD_MS = 500;
export const BOX_MIN_HEIGHT_PX = 4;
export const STRIP_SHARE = 1;
export const LEG_OUTLINE_WIDTH = 1;
export const PENDING_SHARE = 0.5;
export const SCORE_LABEL_MIN_WIDTH = 36;
export const INTENSITY_SHARE: Readonly<Record<number, number>> = Object.freeze({ 1: 0.7, 2: 0.85, 3: 1 });
export const BROKEN_DASH: readonly number[] = [3, 3];
export const RIM_WIDTH = 1.5;
export const HOVER_RIM = "#141414";
export const HOVER_RIM_WIDTH = 1.5;

export interface ExhaustionBox {
  left: number;
  top: number;
  width: number;
  height: number;
  zoneLeft: number;
  zoneTop: number;
  zoneWidth: number;
  zoneHeight: number;
  state: ExhaustionStatus;
  lit: boolean;
  hovered: boolean;
  alpha: number;
  shade: ExhaustionShade;
}

export interface LegOutline {
  left: number;
  top: number;
  width: number;
  height: number;
  side: ExhaustionShade["side"];
  alpha: number;
}

export function legOutlinesOf(boxes: readonly ExhaustionBox[]): LegOutline[] {
  const outlines = new Map<string, LegOutline>();
  for (const box of boxes) {
    const key = `${box.shade.side}|${box.shade.legStartTs}|${box.shade.legStartPrice}`;
    const held = outlines.get(key);
    if (held === undefined) {
      outlines.set(key, { left: box.left, top: box.top, width: box.width, height: box.height, side: box.shade.side, alpha: box.alpha });
      continue;
    }
    const right = Math.max(held.left + held.width, box.left + box.width);
    const bottom = Math.max(held.top + held.height, box.top + box.height);
    held.left = Math.min(held.left, box.left);
    held.top = Math.min(held.top, box.top);
    held.width = right - held.left;
    held.height = bottom - held.top;
    held.alpha = Math.max(held.alpha, box.alpha);
  }
  return [...outlines.values()];
}

export interface ExhaustionGeometry {
  xOf: (ms: number) => number | null;
  yOf: (price: number) => number | null;
  width: number;
  height: number;
}

export function flashLit(nowMs: number): boolean {
  return Math.floor(nowMs / FLASH_HALF_PERIOD_MS) % 2 === 0;
}

export function shadeAlpha(shade: Pick<ExhaustionShade, "intensity">, opacity: number): number {
  return opacity * (INTENSITY_SHARE[shade.intensity] ?? INTENSITY_SHARE[1]);
}

export function zoneStartTs(shade: ExhaustionShade, bars: readonly LegBar[], zone: number): number {
  const up = shade.side === "buyers";
  const near = up ? shade.extremePrice - zone : shade.extremePrice + zone;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].time * 1000 < shade.endTs) lo = mid + 1;
    else hi = mid;
  }
  let from = shade.startTs;
  for (let i = lo - 1; i >= 0; i -= 1) {
    const ts = bars[i].time * 1000;
    if (ts < shade.legStartTs) break;
    if (ts >= shade.startTs) continue;
    if (up ? bars[i].high < near : bars[i].low > near) break;
    from = ts;
  }
  return from;
}

export function layoutExhaustion(shades: readonly ExhaustionShade[], geometry: ExhaustionGeometry, nowMs: number, opacity: number, hoveredId: string | null = null, bars: readonly LegBar[] = [], zoneScale: number = DEFAULT_ZONE_SCALE): ExhaustionBox[] {
  const boxes: ExhaustionBox[] = [];
  for (const shade of shades) {
    const endMs = shade.status === "open" ? Math.max(nowMs, shade.endTs) : shade.endTs;
    const left = geometry.xOf(shade.legStartTs);
    const right = geometry.xOf(endMs);
    if (left === null || right === null) continue;
    const up = shade.side === "buyers";
    let top = geometry.yOf(up ? shade.extremePrice : shade.legStartPrice);
    let bottom = geometry.yOf(up ? shade.legStartPrice : shade.extremePrice);
    if (top === null || bottom === null) continue;
    if (bottom - top < BOX_MIN_HEIGHT_PX) {
      if (up) bottom = top + BOX_MIN_HEIGHT_PX;
      else top = bottom - BOX_MIN_HEIGHT_PX;
    }
    const zone = zoneHeightOf(shade, zoneScale);
    const zoneLeft = geometry.xOf(zoneStartTs(shade, bars, zone));
    let zoneTop = geometry.yOf(up ? shade.extremePrice : shade.extremePrice + zone);
    let zoneBottom = geometry.yOf(up ? shade.extremePrice - zone : shade.extremePrice);
    if (zoneLeft === null || zoneTop === null || zoneBottom === null) continue;
    if (zoneBottom - zoneTop < BOX_MIN_HEIGHT_PX) {
      if (up) zoneBottom = zoneTop + BOX_MIN_HEIGHT_PX;
      else zoneTop = zoneBottom - BOX_MIN_HEIGHT_PX;
    }
    const width = Math.max(1, right - left);
    if (left + width < 0 || left > geometry.width || bottom < 0 || top > geometry.height) continue;
    boxes.push({ left, top, width, height: bottom - top, zoneLeft, zoneTop, zoneWidth: Math.max(1, right - zoneLeft), zoneHeight: zoneBottom - zoneTop, state: shade.status, lit: shade.status !== "open" || flashLit(nowMs), hovered: shade.id === hoveredId, alpha: shadeAlpha(shade, opacity), shade });
  }
  return boxes;
}

export function exhaustionStatusText(book: ExhaustionBook | null): string | null {
  if (book === null) return "EXHAUSTION · WAITING FOR THE RUNTIME";
  if (!book.trusted()) return "EXHAUSTION · UNTRUSTED UNTIL THE NEXT PAGE";
  const loading = exhaustionLoadingLabel(book.loading, book.lastTs);
  if (loading !== null) return `EXHAUSTION · LOADING ${loading.toUpperCase()}`;
  return null;
}

class ExhaustionStatusRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { book: ExhaustionBook | null; candleMs: number | null; shown: boolean };
  constructor(host: { book: ExhaustionBook | null; candleMs: number | null; shown: boolean }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    if (!this._host.shown) return;
    const text = exhaustionStatusText(this._host.book);
    if (text === null) return;
    target.useMediaCoordinateSpace(({ context }) => drawStatusBadge(context, STATUS_BADGE_SLOT.exhaustion, text));
  }
}

class ExhaustionPaneView implements IPrimitivePaneView {
  private readonly _renderer: IPrimitivePaneRenderer;
  constructor(renderer: IPrimitivePaneRenderer) {
    this._renderer = renderer;
  }
  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

type BoxContext = Pick<CanvasRenderingContext2D, "fillRect" | "strokeRect" | "setLineDash" | "save" | "restore"> & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number };
type LegContext = BoxContext & Pick<CanvasRenderingContext2D, "fillText"> & { font: string; textAlign: CanvasTextAlign };

export function drawLegBoxes(context: BoxContext, boxes: readonly LegBox[], settings: ExhaustionSettings): void {
  context.save();
  try {
    context.lineWidth = LEG_RIM_WIDTH;
    for (const box of boxes) {
      const colour = exhaustionColorOf(settings, box.leg.side === "up" ? "buyers" : "sellers");
      const tone = parseRgb(colour, colour);
      const inset = LEG_RIM_WIDTH / 2;
      context.setLineDash(box.leg.open ? [...LEG_OPEN_DASH] : []);
      context.strokeStyle = css(tone, 0.9);
      context.fillStyle = css(tone, LEG_FILL_SHARE);
      context.fillRect(box.left, box.top, box.width, box.height);
      context.strokeRect(box.left + inset, box.top + inset, box.width - LEG_RIM_WIDTH, box.height - LEG_RIM_WIDTH);
    }
    context.setLineDash([]);
  } finally {
    context.restore();
  }
}

export function drawLegOutlines(context: BoxContext, outlines: readonly LegOutline[], settings: ExhaustionSettings): void {
  context.save();
  try {
    context.lineWidth = LEG_OUTLINE_WIDTH;
    context.setLineDash([]);
    const inset = LEG_OUTLINE_WIDTH / 2;
    for (const outline of outlines) {
      const colour = exhaustionColorOf(settings, outline.side);
      context.strokeStyle = css(parseRgb(colour, colour), Math.min(1, outline.alpha + 0.2));
      context.strokeRect(outline.left + inset, outline.top + inset, outline.width - LEG_OUTLINE_WIDTH, outline.height - LEG_OUTLINE_WIDTH);
    }
  } finally {
    context.restore();
  }
}

export function drawExhaustionBoxes(context: LegContext, boxes: readonly ExhaustionBox[], settings: ExhaustionSettings): void {
  context.save();
  try {
    context.font = LEG_LABEL_FONT;
    context.textAlign = "left";
    for (const box of boxes) {
      const colour = exhaustionColorOf(settings, box.shade.side);
      const tone = parseRgb(colour, colour);
      const inset = RIM_WIDTH / 2;
      context.lineWidth = RIM_WIDTH;
      context.strokeStyle = css(tone, Math.min(1, box.alpha + 0.2));
      const dotted = box.state === "broke" || box.state === "interrupted";
      if (dotted) context.setLineDash([...BROKEN_DASH]);
      const fill = box.state === "held" || box.state === "open" ? 1 : box.state === "pending" ? PENDING_SHARE : 0;
      if (fill > 0 && box.lit) {
        context.fillStyle = css(tone, box.alpha * STRIP_SHARE * fill);
        context.fillRect(box.zoneLeft, box.zoneTop, box.zoneWidth, box.zoneHeight);
      }
      if (box.zoneWidth >= SCORE_LABEL_MIN_WIDTH) {
        context.fillStyle = css(tone, 1);
        context.fillText(scoreLabel(box.shade, exhaustionCalibrated(settings)), box.zoneLeft + LEG_LABEL_PAD, box.zoneTop + 10);
      }
      context.strokeRect(box.zoneLeft + inset, box.zoneTop + inset, box.zoneWidth - RIM_WIDTH, box.zoneHeight - RIM_WIDTH);
      if (dotted) context.setLineDash([]);
      if (box.hovered) {
        context.lineWidth = HOVER_RIM_WIDTH;
        context.strokeStyle = HOVER_RIM;
        context.strokeRect(box.zoneLeft - 1, box.zoneTop - 1.5, box.zoneWidth + 2, box.zoneHeight + 3);
      }
    }
  } finally {
    context.restore();
  }
}

class ExhaustionRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { boxes: readonly ExhaustionBox[]; legBoxes: readonly LegBox[]; settings: ExhaustionSettings };
  constructor(host: { boxes: readonly ExhaustionBox[]; legBoxes: readonly LegBox[]; settings: ExhaustionSettings }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const { boxes, legBoxes, settings } = this._host;
    if (boxes.length === 0 && legBoxes.length === 0) return;
    target.useMediaCoordinateSpace(({ context }) => {
      if (legBoxes.length > 0) drawLegBoxes(context, legBoxes, settings);
      if (boxes.length > 0) {
        if (settings.zonesOnly !== true) drawLegOutlines(context, legOutlinesOf(boxes), settings);
        drawExhaustionBoxes(context, boxes, settings);
      }
    });
  }
}

export class ExhaustionPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _frame: number | null = null;
  private _frameKind: "raf" | "timer" | null = null;
  private _flash: ReturnType<typeof setTimeout> | null = null;
  private _lastPaintAt = -Infinity;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private readonly _rows: ChartRowsProvider | null;
  private readonly _now: () => number;
  settings: ExhaustionSettings = { ...DEFAULT_EXHAUSTION_SETTINGS };
  unit = "";
  book: ExhaustionBook | null = null;
  candleMs: number | null = null;
  shown = false;
  hovered: string | null = null;
  boxes: readonly ExhaustionBox[] = [];
  legBoxes: readonly LegBox[] = [];
  legs: readonly Leg[] = [];
  private _legsKey = "";
  private _shown: readonly ExhaustionShade[] = [];
  private _shownKey = "";
  private _shownBook: ExhaustionBook | null = null;
  private _shownSettings: ExhaustionSettings | null = null;

  constructor(rows: ChartRowsProvider | null = null, now: () => number = () => Date.now()) {
    this._rows = rows;
    this._now = now;
    this._paneViews = [new ExhaustionPaneView(new ExhaustionRenderer(this)), new ExhaustionPaneView(new ExhaustionStatusRenderer(this))];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._cancelScheduledUpdate();
    this._stopFlash();
    this.boxes = [];
    this.book = null;
    this.shown = false;
    this.hovered = null;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  boxAt(x: number, y: number): ExhaustionHover | null {
    let found: ExhaustionBox | null = null;
    for (const box of this.boxes) {
      if (x < box.zoneLeft || x > box.zoneLeft + box.zoneWidth || y < box.zoneTop || y > box.zoneTop + box.zoneHeight) continue;
      if (found === null || box.zoneWidth * box.zoneHeight < found.zoneWidth * found.zoneHeight) found = box;
    }
    return found === null ? null : describeExhaustion(found.shade, exhaustionCalibrated(this.settings), this.unit);
  }

  setBook(book: ExhaustionBook | null): void {
    this.book = book;
    this._schedule();
  }

  setUnit(unit: string): void {
    this.unit = unit;
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    this._schedule();
  }

  setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this._schedule();
  }

  setCandleMs(candleMs: number | null): void {
    this.candleMs = candleMs;
    this._schedule();
  }

  refresh(): void {
    this._schedule();
  }

  setSettings(settings: ExhaustionSettings): void {
    this.settings = settings;
    this._schedule();
  }

  private _schedule(): void {
    if (this._frame !== null) return;
    const hasAnimationFrame = typeof requestAnimationFrame === "function";
    const raf = hasAnimationFrame ? requestAnimationFrame : (callback: () => void) => setTimeout(callback, 16) as unknown as number;
    const paint = () => {
      this._frame = raf(() => {
        this._frame = null;
        this._frameKind = null;
        this._lastPaintAt = this._now();
        this._requestUpdate?.();
      });
      this._frameKind = hasAnimationFrame ? "raf" : "timer";
    };
    const wait = REPAINT_MIN_INTERVAL_MS - (this._now() - this._lastPaintAt);
    if (wait <= 0) paint();
    else {
      this._frame = setTimeout(paint, wait) as unknown as number;
      this._frameKind = "timer";
    }
  }

  private _cancelScheduledUpdate(): void {
    if (this._frame === null || this._frameKind === null) return;
    if (this._frameKind === "raf") cancelAnimationFrame(this._frame);
    else clearTimeout(this._frame);
    this._frame = null;
    this._frameKind = null;
  }

  private _stopFlash(): void {
    if (this._flash !== null) clearTimeout(this._flash);
    this._flash = null;
  }

  private _keepFlashing(): void {
    if (!this.boxes.some((box) => box.state === "open")) {
      this._stopFlash();
      return;
    }
    if (this._flash !== null) return;
    this._flash = setTimeout(() => {
      this._flash = null;
      this._schedule();
    }, FLASH_HALF_PERIOD_MS);
  }

  private _catchLegs(bars: readonly LegBar[]): readonly Leg[] {
    const legSettings = legSettingsOf(this.settings);
    const key = `${bars.length}|${bars[bars.length - 1]?.time ?? 0}|${bars[bars.length - 1]?.close ?? 0}|${legSettings.atrMultiple}|${legSettings.reverseAtr}|${legSettings.minEfficiency}`;
    if (key !== this._legsKey) {
      this.legs = catchLegs(bars, legSettings);
      this._legsKey = key;
    }
    return this.legs;
  }

  private _shownShades(book: ExhaustionBook, candleMs: number, now: number): readonly ExhaustionShade[] {
    const key = `${book.version}|${candleMs}|${Math.floor(now / 60_000)}`;
    if (key !== this._shownKey || book !== this._shownBook || this.settings !== this._shownSettings) {
      this._shown = shownShades(book.list(), this.settings, candleMs, now);
      this._shownKey = key;
      this._shownBook = book;
      this._shownSettings = this.settings;
    }
    return this._shown;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const book = this.book;
    this.boxes = [];
    this.legBoxes = [];
    if (!chart || !series || !this.shown) {
      this._stopFlash();
      return;
    }
    const now = this._now();
    const bars = (this._rows?.() ?? series.data()) as readonly LegBar[];
    if (bars.length === 0) return;
    const intervalMs = barIntervalSecOf(bars) * 1000;
    const timeScale = chart.timeScale();
    const height = chart.paneSize().height;
    const width = timeScale.width();
    if (!(height > 0) || !(width > 0)) return;
    const barSpacing = timeScale.options().barSpacing;
    const geometry: ExhaustionGeometry = {
      xOf: (ms) => candleX(bars, ms, intervalMs, barSpacing, (time) => {
        const center = timeScale.timeToCoordinate(time);
        return center === null ? null : Number(center);
      }),
      yOf: (price) => {
        const y = series.priceToCoordinate(price);
        return y === null ? null : Number(y);
      },
      width,
      height,
    };
    if (this.settings.showLegs === true) this.legBoxes = layoutLegs(this._catchLegs(bars), geometry);
    if (book !== null && this.candleMs !== null) {
      this.boxes = layoutExhaustion(this._shownShades(book, this.candleMs, now), geometry, now, exhaustionOpacityOf(this.settings), this.hovered, bars, exhaustionZoneScaleOf(this.settings));
    }
    this._keepFlashing();
  }
}
