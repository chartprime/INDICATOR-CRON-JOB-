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
import type { InitiativeBand } from "../../../types/frames";
import type { InitiativeBook } from "../../l2/initiativeBook";
import { parseRgb } from "../passive-liquidity/liquidityHeatmapHost";
import { css } from "../aggressive-orders/aggressiveOrdersRenderer";
import { candleX } from "../aggressive-orders/aggressiveOrdersPrimitive";
import { barIntervalSecOf } from "../absorption-detector/absorptionPrimitive";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import { exhaustionLoadingLabel } from "../exhaustion/exhaustionSettings";
import { DEFAULT_INITIATIVE_SETTINGS, initiativeOpacityOf, initiativeSideColorOf, shownBands, type InitiativeSettings } from "./initiativeSettings";
import { describeInitiative, scoreLabel, type InitiativeHover } from "./initiativeHover";
import { pushersOf } from "./initiativeWords";

const REPAINT_MIN_INTERVAL_MS = 100;
const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

export const SHADE_CORE = 0.4;
export const SHADE_HOVER_BOOST = 1.6;
export const SHADE_FADE = 40;
export const LEADER_GAP = 4;
export const LEADER_LENGTH = 26;
export const LEADER_WIDTH = 1;
export const CHIP = Object.freeze({ height: 34, radius: 5, padX: 7, titleBaseline: 13, titlePx: 9, arrowGap: 5, arrowWidth: 7, arrowHeight: 8, arrowMid: 9.5, valueBaseline: 28, valuePx: 12, detailPx: 9, detailGap: 5, charEm: 0.62 });
export const CHIP_TITLE = "INITIATIVE";
export const CHIP_TITLE_FONT = `600 ${CHIP.titlePx}px ${MONO}`;
export const CHIP_VALUE_FONT = `700 ${CHIP.valuePx}px ${MONO}`;
export const CHIP_DETAIL_FONT = `500 ${CHIP.detailPx}px ${MONO}`;
export const CHIP_FILL = "rgba(15, 17, 26, 0.92)";
export const CHIP_RIM_ALPHA = 0.55;
export const CHIP_TITLE_INK = "rgba(226, 232, 240, 0.78)";
export const CHIP_VALUE_INK = "#f8fafc";
export const CHIP_DETAIL_INK = "rgba(226, 232, 240, 0.7)";
export const CHIP_GAP = 4;
export const CHIP_EDGE = 4;
export const CHIP_HIT_SLACK = 2;
export const CHIP_MAX_SHIFTS = 4;

export interface Point {
  x: number;
  y: number;
}

export interface InitiativeShade {
  left: number;
  right: number;
  top: number;
  bottom: number;
  fade: number;
}

export interface InitiativeChipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InitiativeChip extends InitiativeChipBox {
  title: string;
  value: string;
  detail: string;
  leader: { from: Point; to: Point };
}

export interface InitiativeMark {
  shade: InitiativeShade;
  showShade: boolean;
  chip: InitiativeChip | null;
  alpha: number;
  hovered: boolean;
  band: InitiativeBand;
}

export interface InitiativeCandle {
  ts: number;
  high: number;
  low: number;
}

export interface InitiativeGeometry {
  xOf: (ms: number) => number | null;
  yOf: (price: number) => number | null;
  candles: (fromTs: number, toTs: number) => readonly InitiativeCandle[];
  width: number;
  height: number;
}

export function chipTextWidth(text: string, px: number): number {
  return Math.ceil(text.length * px * CHIP.charEm);
}

export function chipWidthOf(chip: Pick<InitiativeChip, "title" | "value" | "detail">): number {
  const title = chipTextWidth(chip.title, CHIP.titlePx) + CHIP.arrowGap + CHIP.arrowWidth;
  const value = chipTextWidth(chip.value, CHIP.valuePx) + CHIP.detailGap + chipTextWidth(chip.detail, CHIP.detailPx);
  return CHIP.padX * 2 + Math.max(title, value);
}

function chipsTouch(a: InitiativeChipBox, b: InitiativeChipBox): boolean {
  return a.left < b.left + b.width + CHIP_GAP && b.left < a.left + a.width + CHIP_GAP && a.top < b.top + b.height + CHIP_GAP && b.top < a.top + a.height + CHIP_GAP;
}

export function shadeArea(shade: InitiativeShade): number {
  return (shade.right - shade.left) * (shade.bottom - shade.top);
}

export function insideShade(point: Point, shade: InitiativeShade): boolean {
  return point.x >= shade.left && point.x <= shade.right && point.y >= shade.top && point.y <= shade.bottom;
}

export function insideChip(point: Point, chip: InitiativeChipBox, slack = 0): boolean {
  return point.x >= chip.left - slack && point.x <= chip.left + chip.width + slack && point.y >= chip.top - slack && point.y <= chip.top + chip.height + slack;
}

export function layoutInitiative(bands: readonly InitiativeBand[], geometry: InitiativeGeometry, opacity: number, hoveredId: string | null = null, showShade = true, showChip = true): InitiativeMark[] {
  const marks: InitiativeMark[] = [];
  for (const band of bands) {
    const up = band.side === "up";
    const start = geometry.xOf(band.pivotTs);
    const end = geometry.xOf(band.frozenTs + band.candleMs);
    if (start === null || end === null || end <= start) continue;
    let high = Math.max(band.pivotPrice, band.frozenPrice);
    let low = Math.min(band.pivotPrice, band.frozenPrice);
    for (const candle of geometry.candles(band.pivotTs, band.frozenTs)) {
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
    }
    const top = geometry.yOf(high);
    const bottom = geometry.yOf(low);
    if (top === null || bottom === null) continue;
    const cx = (start + end) / 2;
    const shade: InitiativeShade = { left: start, right: end, top, bottom, fade: Math.min(SHADE_FADE, (bottom - top) / 2) };
    if (shade.right < 0 || shade.left > geometry.width || shade.bottom < 0 || shade.top > geometry.height) continue;
    let chip: InitiativeChip | null = null;
    if (showChip) {
      const text = { title: CHIP_TITLE, value: scoreLabel(band), detail: pushersOf(band.side) };
      const chipWidth = chipWidthOf(text);
      const anchor = { x: cx, y: up ? bottom + LEADER_GAP : top - LEADER_GAP };
      const leftEdge = Math.min(Math.max(cx - chipWidth / 2, CHIP_EDGE), Math.max(CHIP_EDGE, geometry.width - chipWidth - CHIP_EDGE));
      const placed = { left: leftEdge, top: up ? anchor.y + LEADER_LENGTH : anchor.y - LEADER_LENGTH - CHIP.height, width: chipWidth, height: CHIP.height, ...text };
      for (let shift = 0; shift < CHIP_MAX_SHIFTS; shift += 1) {
        const touching = marks.map((mark) => mark.chip).find((other): other is InitiativeChip => other !== null && chipsTouch(other, placed));
        if (touching === undefined) break;
        placed.top = up ? touching.top + touching.height + CHIP_GAP : touching.top - CHIP.height - CHIP_GAP;
      }
      const x = Math.min(Math.max(anchor.x, placed.left + CHIP.radius), placed.left + placed.width - CHIP.radius);
      chip = { ...placed, leader: { from: anchor, to: { x, y: up ? placed.top : placed.top + placed.height } } };
    }
    marks.push({ shade, showShade, chip, alpha: opacity, hovered: band.id === hoveredId, band });
  }
  return marks;
}

export function markHit(point: Point, mark: InitiativeMark): "chip" | "shade" | null {
  if (mark.chip !== null && insideChip(point, mark.chip, CHIP_HIT_SLACK)) return "chip";
  if (mark.showShade && insideShade(point, mark.shade)) return "shade";
  return null;
}

export function initiativeStatusText(book: InitiativeBook | null): string | null {
  if (book === null) return "INITIATIVE · WAITING FOR THE RUNTIME";
  if (!book.trusted()) return "INITIATIVE · UNTRUSTED UNTIL THE NEXT PAGE";
  const loading = exhaustionLoadingLabel(book.loading, book.lastTs);
  if (loading !== null) return `INITIATIVE · LOADING ${loading.toUpperCase()}`;
  return null;
}

class InitiativeStatusRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { book: InitiativeBook | null; shown: boolean };
  constructor(host: { book: InitiativeBook | null; shown: boolean }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    if (!this._host.shown) return;
    const text = initiativeStatusText(this._host.book);
    if (text === null) return;
    target.useMediaCoordinateSpace(({ context }) => drawStatusBadge(context, STATUS_BADGE_SLOT.initiative, text));
  }
}

class InitiativePaneView implements IPrimitivePaneView {
  private readonly _renderer: IPrimitivePaneRenderer;
  private readonly _zOrder: PrimitivePaneViewZOrder;
  constructor(renderer: IPrimitivePaneRenderer, zOrder: PrimitivePaneViewZOrder) {
    this._renderer = renderer;
    this._zOrder = zOrder;
  }
  zOrder(): PrimitivePaneViewZOrder {
    return this._zOrder;
  }
  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

export type ShadeContext = Pick<CanvasRenderingContext2D, "createLinearGradient" | "fillRect" | "save" | "restore"> & { fillStyle: unknown };

export function drawInitiativeShades(context: ShadeContext, marks: readonly InitiativeMark[], settings: InitiativeSettings): void {
  context.save();
  try {
    for (const mark of marks) {
      if (!mark.showShade) continue;
      const colour = initiativeSideColorOf(settings, mark.band.side);
      const tone = parseRgb(colour, colour);
      const { left, right, top, bottom, fade } = mark.shade;
      const span = Math.max(1, bottom - top);
      const core = mark.alpha * SHADE_CORE * (mark.hovered ? SHADE_HOVER_BOOST : 1);
      const gradient = context.createLinearGradient(0, top, 0, top + span);
      gradient.addColorStop(0, css(tone, 0));
      gradient.addColorStop(fade / span, css(tone, core));
      gradient.addColorStop(1 - fade / span, css(tone, core));
      gradient.addColorStop(1, css(tone, 0));
      context.fillStyle = gradient;
      context.fillRect(left, top, right - left, span);
    }
  } finally {
    context.restore();
  }
}

export type MarkContext = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "arcTo" | "closePath" | "stroke" | "fill" | "fillText" | "setLineDash" | "save" | "restore"> & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline };

function traceChip(context: MarkContext, chip: InitiativeChip): void {
  const r = CHIP.radius;
  const { left, top, width, height } = chip;
  context.beginPath();
  context.moveTo(left + r, top);
  context.arcTo(left + width, top, left + width, top + height, r);
  context.arcTo(left + width, top + height, left, top + height, r);
  context.arcTo(left, top + height, left, top, r);
  context.arcTo(left, top, left + width, top, r);
  context.closePath();
}

function traceArrow(context: MarkContext, x: number, y: number, up: boolean): void {
  const half = CHIP.arrowWidth / 2;
  const h = CHIP.arrowHeight / 2;
  context.beginPath();
  if (up) {
    context.moveTo(x, y - h);
    context.lineTo(x + half, y + h);
    context.lineTo(x - half, y + h);
  } else {
    context.moveTo(x, y + h);
    context.lineTo(x + half, y - h);
    context.lineTo(x - half, y - h);
  }
  context.closePath();
}

export function drawInitiativeMarks(context: MarkContext, marks: readonly InitiativeMark[], settings: InitiativeSettings): void {
  context.save();
  try {
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.setLineDash([]);
    for (const mark of marks) {
      const chip = mark.chip;
      if (chip === null) continue;
      const colour = initiativeSideColorOf(settings, mark.band.side);
      const tone = parseRgb(colour, colour);
      const up = mark.band.side === "up";
      context.strokeStyle = css(tone, mark.alpha);
      context.lineWidth = LEADER_WIDTH;
      context.beginPath();
      context.moveTo(chip.leader.from.x, chip.leader.from.y);
      context.lineTo(chip.leader.to.x, chip.leader.to.y);
      context.stroke();
      traceChip(context, chip);
      context.fillStyle = CHIP_FILL;
      context.fill();
      context.strokeStyle = css(tone, mark.hovered ? 1 : CHIP_RIM_ALPHA);
      context.lineWidth = 1;
      context.stroke();
      context.font = CHIP_TITLE_FONT;
      context.fillStyle = CHIP_TITLE_INK;
      context.fillText(chip.title, chip.left + CHIP.padX, chip.top + CHIP.titleBaseline);
      traceArrow(context, chip.left + CHIP.padX + chipTextWidth(chip.title, CHIP.titlePx) + CHIP.arrowGap + CHIP.arrowWidth / 2, chip.top + CHIP.arrowMid, up);
      context.fillStyle = css(tone, 1);
      context.fill();
      context.font = CHIP_VALUE_FONT;
      context.fillStyle = CHIP_VALUE_INK;
      context.fillText(chip.value, chip.left + CHIP.padX, chip.top + CHIP.valueBaseline);
      context.font = CHIP_DETAIL_FONT;
      context.fillStyle = CHIP_DETAIL_INK;
      context.fillText(chip.detail, chip.left + CHIP.padX + chipTextWidth(chip.value, CHIP.valuePx) + CHIP.detailGap, chip.top + CHIP.valueBaseline);
    }
  } finally {
    context.restore();
  }
}

type MarksHost = { marks: readonly InitiativeMark[]; settings: InitiativeSettings };

class InitiativeShadeRenderer implements IPrimitivePaneRenderer {
  private readonly _host: MarksHost;
  constructor(host: MarksHost) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const { marks, settings } = this._host;
    if (marks.length === 0) return;
    target.useMediaCoordinateSpace(({ context }) => drawInitiativeShades(context, marks, settings));
  }
}

class InitiativeMarkRenderer implements IPrimitivePaneRenderer {
  private readonly _host: MarksHost;
  constructor(host: MarksHost) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const { marks, settings } = this._host;
    if (marks.length === 0) return;
    target.useMediaCoordinateSpace(({ context }) => drawInitiativeMarks(context, marks, settings));
  }
}

type Bar = { time: unknown; high: number; low: number };

export function candlesBetween(bars: readonly Bar[], fromTs: number, toTs: number): InitiativeCandle[] {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(bars[mid].time) * 1000 < fromTs) lo = mid + 1;
    else hi = mid;
  }
  const candles: InitiativeCandle[] = [];
  for (let i = lo; i < bars.length; i += 1) {
    const ts = Number(bars[i].time) * 1000;
    if (ts > toTs) break;
    candles.push({ ts, high: bars[i].high, low: bars[i].low });
  }
  return candles;
}

export class InitiativePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _frame: number | null = null;
  private _frameKind: "raf" | "timer" | null = null;
  private _lastPaintAt = -Infinity;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private readonly _rows: ChartRowsProvider | null;
  private readonly _now: () => number;
  settings: InitiativeSettings = { ...DEFAULT_INITIATIVE_SETTINGS };
  book: InitiativeBook | null = null;
  candleMs: number | null = null;
  shown = false;
  hovered: string | null = null;
  marks: readonly InitiativeMark[] = [];
  private _shown: readonly InitiativeBand[] = [];
  private _shownKey = "";
  private _shownBook: InitiativeBook | null = null;
  private _shownSettings: InitiativeSettings | null = null;

  constructor(rows: ChartRowsProvider | null = null, now: () => number = () => Date.now()) {
    this._rows = rows;
    this._now = now;
    this._paneViews = [
      new InitiativePaneView(new InitiativeShadeRenderer(this), "bottom"),
      new InitiativePaneView(new InitiativeMarkRenderer(this), "top"),
      new InitiativePaneView(new InitiativeStatusRenderer(this), "top"),
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._cancelScheduledUpdate();
    this.marks = [];
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

  boxAt(x: number, y: number): InitiativeHover | null {
    let found: InitiativeMark | null = null;
    let foundOn: "chip" | "shade" | null = null;
    for (const mark of this.marks) {
      const on = markHit({ x, y }, mark);
      if (on === null) continue;
      if (found === null || (on === "chip" && foundOn === "shade") || (on === foundOn && shadeArea(mark.shade) < shadeArea(found.shade))) {
        found = mark;
        foundOn = on;
      }
    }
    return found === null ? null : describeInitiative(found.band);
  }

  setBook(book: InitiativeBook | null): void {
    this.book = book;
    this._schedule();
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

  setSettings(settings: InitiativeSettings): void {
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

  private _shownBands(book: InitiativeBook, candleMs: number | null, now: number): readonly InitiativeBand[] {
    const key = `${book.version}|${candleMs}|${Math.floor(now / 60_000)}`;
    if (key !== this._shownKey || book !== this._shownBook || this.settings !== this._shownSettings) {
      this._shown = shownBands(book.list(), this.settings, candleMs, now);
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
    this.marks = [];
    if (!chart || !series || !this.shown || book === null) return;
    const now = this._now();
    const bars = (this._rows?.() ?? series.data()) as readonly Bar[];
    if (bars.length === 0) return;
    const intervalMs = barIntervalSecOf(bars) * 1000;
    const timeScale = chart.timeScale();
    const height = chart.paneSize().height;
    const width = timeScale.width();
    if (!(height > 0) || !(width > 0)) return;
    const barSpacing = timeScale.options().barSpacing;
    const geometry: InitiativeGeometry = {
      xOf: (ms) => candleX(bars, ms, intervalMs, barSpacing, (time) => {
        const center = timeScale.timeToCoordinate(time);
        return center === null ? null : Number(center);
      }),
      yOf: (price) => {
        const y = series.priceToCoordinate(price);
        return y === null ? null : Number(y);
      },
      candles: (fromTs, toTs) => candlesBetween(bars, fromTs, toTs),
      width,
      height,
    };
    this.marks = layoutInitiative(this._shownBands(book, this.candleMs, now), geometry, initiativeOpacityOf(this.settings), this.hovered, this.settings.showShade !== false, this.settings.showLabels !== false);
  }
}
