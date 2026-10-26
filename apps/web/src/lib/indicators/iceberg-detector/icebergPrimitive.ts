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
import type { IcebergOrder } from "../../../types/frames";
import type { IcebergBook } from "../../l2/icebergBook";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import { css, sphereTones } from "../aggressive-orders/aggressiveOrdersRenderer";
import { parseRgb, type Rgb } from "../passive-liquidity/liquidityHeatmapHost";
import { barIntervalSecOf, chartCandleOpen } from "../absorption-detector/absorptionPrimitive";
import { DEFAULT_ICEBERG_SETTINGS, biggestPerCandle, icebergCardTextOf, icebergColorOf, icebergMarkScaleOf, icebergPlacementOf, icebergShapeOf, icebergTotalOf, shownIcebergs, type IcebergMarkShape, type IcebergSettings } from "./icebergSettings";
import { describeIceberg, type IcebergHover } from "./icebergHover";

const REPAINT_MIN_INTERVAL_MS = 100;
const SHOWN_REFRESH_MS = 60_000;
const HIT_SLACK = 4;
const CARD_HIT_SLACK = 2;
const HALO_PX = 3;
const HALO_ALPHA = 0.22;
const LINE_WIDTH = 1.5;
const RING_WIDTH = 2;
const LINE_DASH = [4, 3];
const POINT_DASH = [2, 2];
const CARD_RIM_ALPHA = 0.55;
const MAX_LENGTHS = 16;
const MAX_ATTEMPTS_PER_CARD = 4;
const MAX_SPAN_POINTS = 32;
const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';
export const ICEBERG_CHAR_EM = 0.62;
export const ICEBERG_MAX_CARDS = 40;
export const ICEBERG_DOT_MIN_PX = 3.5;
export const ICEBERG_DOT_MAX_PX = 10;
export const ICEBERG_FULL_SIZE_TYPICALS = 10;
const RADIUS_STEP_PX = 0.25;
export const ICEBERG_LINE_VISIBLE_PX = 8;
export const ICEBERG_DOT_CLEARANCE_PX = 1;
export const ICEBERG_LINE_PX = 100;
export const ICEBERG_LINE_MIN_PX = 28;
export const ICEBERG_CARD_GAP_PX = 4;
export const ICEBERG_EDGE_PX = 4;
export const ICEBERG_ANCHOR_INSET_PX = 12;
export const ICEBERG_CARD = Object.freeze({
  height: 36,
  radius: 5,
  padX: 7,
  titleBaseline: 14,
  titlePx: 9,
  arrowGap: 5,
  arrowWidth: 7,
  arrowHeight: 9,
  arrowMid: 10,
  valueBaseline: 29,
  valuePx: 12,
  detailPx: 9,
  detailGap: 5,
});
export const ICEBERG_CARD_TITLE = "ICEBERG";
export const ICEBERG_TITLE_FONT = `600 ${ICEBERG_CARD.titlePx}px ${MONO}`;
export const ICEBERG_VALUE_FONT = `700 ${ICEBERG_CARD.valuePx}px ${MONO}`;
export const ICEBERG_DETAIL_FONT = `500 ${ICEBERG_CARD.detailPx}px ${MONO}`;
export const ICEBERG_CARD_FILL = "rgba(15, 17, 26, 0.92)";
export const ICEBERG_CARD_FILL_ON_DARK = "rgba(36, 39, 51, 0.95)";
export const ICEBERG_RING_CENTER = "#ffffff";
export const ICEBERG_RING_CENTER_ON_DARK = "#0f1117";
const TITLE_INK = "rgba(226, 232, 240, 0.78)";
const VALUE_INK = "#f8fafc";
const DETAIL_INK = "rgba(226, 232, 240, 0.7)";

export interface IcebergCard {
  left: number;
  top: number;
  width: number;
  height: number;
  total: string;
  breakdown: string;
}

export interface IcebergSlot {
  down: boolean;
  anchor: -1 | 0 | 1;
  length: number;
}

export interface IcebergMark {
  x: number;
  y: number;
  r: number;
  shape: IcebergMarkShape;
  hollow: boolean;
  dashed: boolean;
  alpha: number;
  lineStart: number | null;
  lineEnd: number | null;
  card: IcebergCard | null;
  slot: IcebergSlot | null;
  iceberg: IcebergOrder;
}

export interface IcebergCandle {
  x: number;
  top: number;
  bottom: number;
}

interface PaneGeometry {
  xOf: (ms: number) => number | null;
  yOf: (price: number) => number | null;
  width: number;
  height: number;
  cardRight?: number;
  candles?: readonly IcebergCandle[];
  candleHalfPx?: number;
}

interface Point {
  iceberg: IcebergOrder;
  x: number;
  y: number;
  r: number;
  total: number;
}

interface Field {
  geometry: PaneGeometry;
  placed: readonly Spot[];
  sorted: readonly Point[];
  reach: number;
}

interface Segment {
  x: number;
  top: number;
  bottom: number;
}

interface Spot {
  card: IcebergCard;
  slot: IcebergSlot;
  lineStart: number;
  lineEnd: number;
  line: Segment;
}

interface Side {
  from: number;
  floor: number;
}

export interface IcebergSizeReference {
  typical: number;
  full: number;
}

type SideColors = Record<IcebergOrder["side"], Rgb>;

const ANCHORS: readonly IcebergSlot["anchor"][] = [0, 1, -1];

function textWidth(text: string, px: number): number {
  return text.length * px * ICEBERG_CHAR_EM;
}

export function icebergCardWidth(total: string, breakdown: string): number {
  const title = textWidth(ICEBERG_CARD_TITLE, ICEBERG_CARD.titlePx) + ICEBERG_CARD.arrowGap + ICEBERG_CARD.arrowWidth;
  const value = textWidth(total, ICEBERG_CARD.valuePx) + ICEBERG_CARD.detailGap + textWidth(breakdown, ICEBERG_CARD.detailPx);
  return Math.ceil(2 * ICEBERG_CARD.padX + Math.max(title, value));
}

function cardsTouch(a: IcebergCard, b: IcebergCard): boolean {
  return a.left < b.left + b.width + ICEBERG_CARD_GAP_PX
    && b.left < a.left + a.width + ICEBERG_CARD_GAP_PX
    && a.top < b.top + b.height + ICEBERG_CARD_GAP_PX
    && b.top < a.top + a.height + ICEBERG_CARD_GAP_PX;
}

function lineMeetsCard(line: Segment, card: IcebergCard): boolean {
  const half = LINE_WIDTH / 2;
  return line.x + half > card.left && line.x - half < card.left + card.width && line.top < card.top + card.height && line.bottom > card.top;
}

export function icebergSizeReference(totals: Iterable<number>): IcebergSizeReference {
  const sizes = [...totals].filter((total) => total > 0).sort((a, b) => a - b);
  if (sizes.length === 0) return { typical: 0, full: 0 };
  const typical = sizes[(sizes.length - 1) >> 1];
  return { typical, full: Math.max(sizes[sizes.length - 1], typical * ICEBERG_FULL_SIZE_TYPICALS) };
}

export function icebergMarkRadius(total: number, reference: IcebergSizeReference, scale: number): number {
  const { typical, full } = reference;
  const share = typical > 0 && total > 0 ? Math.min(1, Math.log1p(total / typical) / Math.log1p(full / typical)) : 0;
  const radius = (ICEBERG_DOT_MIN_PX + (ICEBERG_DOT_MAX_PX - ICEBERG_DOT_MIN_PX) * share) * scale;
  return Math.round(radius / RADIUS_STEP_PX) * RADIUS_STEP_PX;
}

function dotMeetsCard(point: Point, card: IcebergCard): boolean {
  const reach = point.r + ICEBERG_DOT_CLEARANCE_PX;
  return point.x + reach > card.left && point.x - reach < card.left + card.width && point.y + reach > card.top && point.y - reach < card.top + card.height;
}

function lineMeetsDot(line: Segment, point: Point): boolean {
  return Math.abs(point.x - line.x) < point.r + LINE_WIDTH / 2 && line.top < point.y + point.r && line.bottom > point.y - point.r;
}

function between<T extends { x: number }>(sorted: readonly T[], minX: number, maxX: number): T[] {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid].x < minX) low = mid + 1;
    else high = mid;
  }
  const out: T[] = [];
  for (let i = low; i < sorted.length && sorted[i].x <= maxX; i += 1) out.push(sorted[i]);
  return out;
}

function candlesUnder(geometry: PaneGeometry, left: number, right: number): IcebergCandle[] {
  const half = geometry.candleHalfPx ?? 0;
  return between(geometry.candles ?? [], left - half, right + half);
}

function candleAt(geometry: PaneGeometry, x: number): IcebergCandle | null {
  let nearest: IcebergCandle | null = null;
  for (const candle of candlesUnder(geometry, x, x)) {
    if (nearest === null || Math.abs(candle.x - x) < Math.abs(nearest.x - x)) nearest = candle;
  }
  return nearest;
}

function cardMeetsCandle(card: IcebergCard, candle: IcebergCandle): boolean {
  return card.top < candle.bottom + ICEBERG_CARD_GAP_PX && card.top + card.height > candle.top - ICEBERG_CARD_GAP_PX;
}

function anchorLeft(anchor: IcebergSlot["anchor"], x: number, width: number, limit: number): number | null {
  const raw = anchor === 0 ? x - width / 2 : anchor === 1 ? x - ICEBERG_ANCHOR_INSET_PX : x - width + ICEBERG_ANCHOR_INSET_PX;
  const clamp = (margin: number) => Math.max(margin, Math.min(raw, limit - margin - width));
  const holds = (left: number, inset: number) => x >= left + inset && x <= left + width - inset;
  if (anchor !== 0) {
    const left = clamp(ICEBERG_EDGE_PX);
    return holds(left, ICEBERG_ANCHOR_INSET_PX / 2) ? left : null;
  }
  const centred = clamp(ICEBERG_EDGE_PX);
  if (holds(centred, ICEBERG_CARD.radius + LINE_WIDTH)) return centred;
  const flush = clamp(0);
  return holds(flush, LINE_WIDTH) ? flush : null;
}

function sideOf(own: Point, down: boolean, field: Field): Side {
  const { x, y, r } = own;
  let from = down ? y + r : y - r;
  for (const point of between(field.sorted, x, x)) {
    if (point === own || Math.abs(point.y - y) + r > point.r) continue;
    from = down ? Math.max(from, point.y + point.r) : Math.min(from, point.y - point.r);
  }
  return { from, floor: Math.max(ICEBERG_LINE_MIN_PX, Math.abs(from - y) + ICEBERG_LINE_VISIBLE_PX) };
}

function isClear(spot: Spot, own: Point, field: Field): boolean {
  const { card, line } = spot;
  const { geometry, placed, sorted, reach } = field;
  for (const other of placed) {
    if (cardsTouch(card, other.card) || lineMeetsCard(line, other.card) || lineMeetsCard(other.line, card)) return false;
  }
  const under = between(sorted, card.left - reach, card.left + card.width + reach);
  if (under.length > MAX_SPAN_POINTS) return false;
  for (const point of under) {
    if (point !== own && dotMeetsCard(point, card)) return false;
  }
  for (const point of between(sorted, line.x - reach - LINE_WIDTH, line.x + reach + LINE_WIDTH)) {
    if (point !== own && lineMeetsDot(line, point)) return false;
  }
  for (const candle of candlesUnder(geometry, card.left, card.left + card.width)) {
    if (cardMeetsCandle(card, candle)) return false;
  }
  return true;
}

function lengthsFor(down: boolean, own: Point, side: Side, room: number, left: number, width: number, field: Field): number[] {
  const { y } = own;
  const { geometry, placed, sorted, reach } = field;
  const height = ICEBERG_CARD.height;
  const right = left + width;
  const blocks: { top: number; bottom: number }[] = [];
  let floor = side.floor;
  for (const candle of candlesUnder(geometry, left, right)) {
    floor = Math.max(floor, down ? candle.bottom + ICEBERG_CARD_GAP_PX - y : y - candle.top + ICEBERG_CARD_GAP_PX);
  }
  if (floor > room) return [];
  for (const other of placed) {
    if (other.card.left < right + ICEBERG_CARD_GAP_PX && left < other.card.left + other.card.width + ICEBERG_CARD_GAP_PX) {
      blocks.push({ top: other.card.top, bottom: other.card.top + other.card.height });
    }
    if (other.line.x + LINE_WIDTH / 2 > left && other.line.x - LINE_WIDTH / 2 < right) blocks.push(other.line);
  }
  const under = between(sorted, left - reach, right + reach);
  if (under.length > MAX_SPAN_POINTS) return [];
  for (const point of under) {
    const clearance = point.r + ICEBERG_DOT_CLEARANCE_PX;
    if (point !== own) blocks.push({ top: point.y - clearance, bottom: point.y + clearance });
  }
  const lengths = new Set([Math.max(floor, Math.min(ICEBERG_LINE_PX, room))]);
  for (const block of blocks) {
    const edges = down
      ? [block.top - height - ICEBERG_CARD_GAP_PX - y, block.bottom + ICEBERG_CARD_GAP_PX - y]
      : [y - height - block.bottom - ICEBERG_CARD_GAP_PX, y - block.top + ICEBERG_CARD_GAP_PX];
    for (const edge of edges) if (edge >= floor && edge <= room) lengths.add(edge);
  }
  return [...lengths].sort((a, b) => Math.abs(a - ICEBERG_LINE_PX) - Math.abs(b - ICEBERG_LINE_PX) || b - a).slice(0, MAX_LENGTHS);
}

function placeCard(own: Point, field: Field, prior: IcebergSlot | undefined): Spot | null {
  const { geometry } = field;
  const { total, breakdown } = icebergCardTextOf(own.iceberg);
  const width = icebergCardWidth(total, breakdown);
  const height = ICEBERG_CARD.height;
  const { x, y } = own;
  const below = sideOf(own, true, field);
  const above = sideOf(own, false, field);
  const sideFor = (down: boolean) => (down ? below : above);
  const build = (down: boolean, anchor: IcebergSlot["anchor"], left: number, length: number): Spot => {
    const top = down ? y + length : y - length - height;
    const lineEnd = down ? top : top + height;
    const { from } = sideFor(down);
    return { card: { left, top, width, height, total, breakdown }, slot: { down, anchor, length }, lineStart: from, lineEnd, line: { x, top: Math.min(from, lineEnd), bottom: Math.max(from, lineEnd) } };
  };
  const preferDown = own.iceberg.side === "bid";
  const limit = geometry.cardRight ?? geometry.width;
  const roomOn = (down: boolean) => (down ? geometry.height - ICEBERG_EDGE_PX - height - y : y - ICEBERG_EDGE_PX - height);
  if (prior !== undefined && prior.down === preferDown && prior.length >= sideFor(prior.down).floor && prior.length <= roomOn(prior.down)) {
    const left = anchorLeft(prior.anchor, x, width, limit);
    const kept = left === null ? null : build(prior.down, prior.anchor, left, prior.length);
    if (kept !== null && isClear(kept, own, field)) return kept;
  }
  const down = preferDown;
  const side = sideFor(down);
  const room = roomOn(down);
  if (room < side.floor) return null;
  const tried: number[] = [];
  for (const anchor of ANCHORS) {
    const left = anchorLeft(anchor, x, width, limit);
    if (left === null || tried.includes(left)) continue;
    tried.push(left);
    for (const length of lengthsFor(down, own, side, room, left, width, field)) {
      const spot = build(down, anchor, left, length);
      if (isClear(spot, own, field)) return spot;
    }
  }
  return null;
}

function placementOrder(points: readonly Point[]): Point[] {
  const live = (point: Point) => (point.iceberg.status === "active" ? 1 : 0);
  return [...points].sort((a, b) => live(b) - live(a)
    || b.total - a.total
    || b.iceberg.markedAt - a.iceberg.markedAt
    || (a.iceberg.id < b.iceberg.id ? -1 : a.iceberg.id > b.iceberg.id ? 1 : 0));
}

export function layoutIcebergs(
  icebergs: readonly IcebergOrder[],
  settings: IcebergSettings,
  geometry: PaneGeometry,
  columnOf: (ts: number) => number | null,
  previous: ReadonlyMap<string, IcebergSlot> = new Map(),
  sizes?: IcebergSizeReference,
): IcebergMark[] {
  const scale = icebergMarkScaleOf(settings);
  const onCandle = icebergPlacementOf(settings) === "candle";
  const totals = new Map(icebergs.map((iceberg) => [iceberg, icebergTotalOf(iceberg).total]));
  const reference = sizes ?? icebergSizeReference(totals.values());
  const points: Point[] = [];
  for (const iceberg of icebergs) {
    const column = columnOf(iceberg.markedAt);
    if (column === null) continue;
    const x = geometry.xOf(column);
    if (x === null || x < 0 || x > geometry.width) continue;
    const candle = onCandle ? candleAt(geometry, x) : null;
    const y = candle === null ? geometry.yOf(iceberg.price) : iceberg.side === "ask" ? candle.top : candle.bottom;
    if (y === null || y < 0 || y > geometry.height) continue;
    const total = totals.get(iceberg) ?? 0;
    points.push({ iceberg, x, y, r: icebergMarkRadius(total, reference, scale), total });
  }
  const spots = new Map<Point, Spot>();
  if (settings.labels !== false) {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const placed: Spot[] = [];
    const field: Field = { geometry, placed, sorted, reach: points.reduce((most, point) => Math.max(most, point.r), 0) + ICEBERG_DOT_CLEARANCE_PX };
    let attempts = 0;
    for (const point of placementOrder(points)) {
      if (placed.length >= ICEBERG_MAX_CARDS || attempts >= ICEBERG_MAX_CARDS * MAX_ATTEMPTS_PER_CARD) break;
      attempts += 1;
      const spot = placeCard(point, field, previous.get(point.iceberg.id));
      if (spot === null) continue;
      placed.push(spot);
      spots.set(point, spot);
    }
  }
  const marks = points.map((point) => {
    const { iceberg } = point;
    const spot = spots.get(point) ?? null;
    const shape = icebergShapeOf(settings, iceberg.kind);
    const dashed = iceberg.confidence === "weak" || iceberg.status === "pulled" || iceberg.status === "interrupted";
    return {
      x: point.x,
      y: point.y,
      r: point.r,
      shape,
      hollow: shape === "circle" || dashed,
      dashed,
      alpha: iceberg.status !== "active" ? 0.8 : 1,
      lineStart: spot === null ? null : spot.lineStart,
      lineEnd: spot === null ? null : spot.lineEnd,
      card: spot === null ? null : spot.card,
      slot: spot === null ? null : spot.slot,
      iceberg,
    };
  });
  return marks.sort((a, b) => b.r - a.r);
}

function cardUnder(marks: readonly IcebergMark[], x: number, y: number): IcebergMark | null {
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const card = marks[i].card;
    if (card === null) continue;
    const inside = x >= card.left - CARD_HIT_SLACK && x <= card.left + card.width + CARD_HIT_SLACK
      && y >= card.top - CARD_HIT_SLACK && y <= card.top + card.height + CARD_HIT_SLACK;
    if (inside) return marks[i];
  }
  return null;
}

type Corner = readonly [number, number];

function triangleCorners(x: number, y: number, r: number, side: "bid" | "ask"): readonly [Corner, Corner, Corner] {
  const tip = side === "bid" ? -1 : 1;
  return [[x, y + tip * r], [x + r, y - tip * r], [x - r, y - tip * r]];
}

function cornersOf(mark: IcebergMark): readonly [Corner, Corner, Corner] {
  return triangleCorners(mark.x, mark.y, mark.r, mark.iceberg.side);
}

function turn(from: Corner, to: Corner, x: number, y: number): number {
  return (to[0] - from[0]) * (y - from[1]) - (to[1] - from[1]) * (x - from[0]);
}

function segmentGap(x: number, y: number, from: Corner, to: Corner): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const along = Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (from[0] + along * dx), y - (from[1] + along * dy));
}

function underCursor(mark: IcebergMark, x: number, y: number): boolean {
  if (mark.shape !== "triangle") return Math.hypot(x - mark.x, y - mark.y) <= mark.r;
  const [a, b, c] = cornersOf(mark);
  const turns = [turn(a, b, x, y), turn(b, c, x, y), turn(c, a, x, y)];
  return turns.every((value) => value >= 0) || turns.every((value) => value <= 0);
}

function gapTo(mark: IcebergMark, x: number, y: number): number {
  if (mark.shape !== "triangle") return Math.hypot(x - mark.x, y - mark.y) - mark.r;
  const [a, b, c] = cornersOf(mark);
  return Math.min(segmentGap(x, y, a, b), segmentGap(x, y, b, c), segmentGap(x, y, c, a));
}

export function icebergMarkAt(marks: readonly IcebergMark[], x: number, y: number): IcebergMark | null {
  const onCard = cardUnder(marks, x, y);
  if (onCard !== null) return onCard;
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    if (underCursor(marks[i], x, y)) return marks[i];
  }
  let nearest: IcebergMark | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const away = gapTo(marks[i], x, y);
    if (away <= HIT_SLACK && away < gap) {
      nearest = marks[i];
      gap = away;
    }
  }
  return nearest;
}

export function traceArrow(context: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">, x: number, y: number, side: "bid" | "ask"): void {
  const apex = side === "bid" ? -1 : 1;
  const half = ICEBERG_CARD.arrowWidth / 2;
  const reach = ICEBERG_CARD.arrowHeight / 2;
  const shaft = 1;
  const neck = 0.5;
  context.moveTo(x, y + apex * reach);
  context.lineTo(x + half, y + apex * neck);
  context.lineTo(x + shaft, y + apex * neck);
  context.lineTo(x + shaft, y - apex * reach);
  context.lineTo(x - shaft, y - apex * reach);
  context.lineTo(x - shaft, y + apex * neck);
  context.lineTo(x - half, y + apex * neck);
  context.closePath();
}

export function traceTriangle(context: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">, x: number, y: number, r: number, side: "bid" | "ask"): void {
  const [apex, right, left] = triangleCorners(x, y, r, side);
  context.moveTo(apex[0], apex[1]);
  context.lineTo(right[0], right[1]);
  context.lineTo(left[0], left[1]);
  context.closePath();
}

function tracePoint(context: CanvasRenderingContext2D, mark: IcebergMark, r: number): void {
  if (mark.shape === "triangle") traceTriangle(context, mark.x, mark.y, r, mark.iceberg.side);
  else context.arc(mark.x, mark.y, r, 0, Math.PI * 2);
}

function traceCard(context: CanvasRenderingContext2D, card: IcebergCard): void {
  const { left, top, width, height } = card;
  const radius = ICEBERG_CARD.radius;
  context.moveTo(left + radius, top);
  context.arcTo(left + width, top, left + width, top + height, radius);
  context.arcTo(left + width, top + height, left, top + height, radius);
  context.arcTo(left, top + height, left, top, radius);
  context.arcTo(left, top, left + width, top, radius);
  context.closePath();
}

function drawLines(context: CanvasRenderingContext2D, marks: readonly IcebergMark[], sides: SideColors): void {
  context.lineWidth = LINE_WIDTH;
  for (const mark of marks) {
    if (mark.lineStart === null || mark.lineEnd === null) continue;
    context.beginPath();
    context.moveTo(mark.x, mark.lineStart);
    context.lineTo(mark.x, mark.lineEnd);
    context.strokeStyle = css(sides[mark.iceberg.side], mark.alpha);
    if (mark.dashed) context.setLineDash(LINE_DASH);
    context.stroke();
    if (mark.dashed) context.setLineDash([]);
  }
}

function drawPoints(context: CanvasRenderingContext2D, marks: readonly IcebergMark[], sides: SideColors, dark: boolean): void {
  for (const mark of marks) {
    const side = sides[mark.iceberg.side];
    context.beginPath();
    tracePoint(context, mark, mark.r + HALO_PX);
    context.fillStyle = css(side, HALO_ALPHA * mark.alpha);
    context.fill();
    context.beginPath();
    tracePoint(context, mark, mark.r);
    if (mark.hollow) {
      context.fillStyle = dark ? ICEBERG_RING_CENTER_ON_DARK : ICEBERG_RING_CENTER;
      context.fill();
      context.strokeStyle = css(side, mark.alpha);
      context.lineWidth = RING_WIDTH;
    } else {
      context.fillStyle = css(side, mark.alpha);
      context.fill();
      context.strokeStyle = css(sphereTones(side).rim, Math.min(1, mark.alpha + 0.2));
      context.lineWidth = 1;
    }
    if (mark.dashed) context.setLineDash(POINT_DASH);
    context.stroke();
    if (mark.dashed) context.setLineDash([]);
  }
}

function drawCards(context: CanvasRenderingContext2D, marks: readonly IcebergMark[], sides: SideColors, dark: boolean): void {
  const titleWidth = textWidth(ICEBERG_CARD_TITLE, ICEBERG_CARD.titlePx);
  for (const mark of marks) {
    const card = mark.card;
    if (card === null) continue;
    context.beginPath();
    traceCard(context, card);
    context.fillStyle = dark ? ICEBERG_CARD_FILL_ON_DARK : ICEBERG_CARD_FILL;
    context.fill();
    context.strokeStyle = css(sides[mark.iceberg.side], CARD_RIM_ALPHA);
    context.lineWidth = 1;
    context.stroke();
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.font = ICEBERG_TITLE_FONT;
    context.fillStyle = TITLE_INK;
    context.fillText(ICEBERG_CARD_TITLE, card.left + ICEBERG_CARD.padX, card.top + ICEBERG_CARD.titleBaseline);
    context.beginPath();
    traceArrow(context, card.left + ICEBERG_CARD.padX + titleWidth + ICEBERG_CARD.arrowGap + ICEBERG_CARD.arrowWidth / 2, card.top + ICEBERG_CARD.arrowMid, mark.iceberg.side);
    context.fillStyle = css(sides[mark.iceberg.side], 1);
    context.fill();
    context.font = ICEBERG_VALUE_FONT;
    context.fillStyle = VALUE_INK;
    context.fillText(card.total, card.left + ICEBERG_CARD.padX, card.top + ICEBERG_CARD.valueBaseline);
    context.font = ICEBERG_DETAIL_FONT;
    context.fillStyle = DETAIL_INK;
    context.fillText(card.breakdown, card.left + ICEBERG_CARD.padX + textWidth(card.total, ICEBERG_CARD.valuePx) + ICEBERG_CARD.detailGap, card.top + ICEBERG_CARD.valueBaseline);
  }
}

function candleEdge(bar: object, edge: "high" | "low"): number | null {
  const value = (bar as Record<string, unknown>)[edge];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function icebergStatusText(book: IcebergBook | null, shown: boolean): string | null {
  if (!shown) return null;
  if (book === null || book.lastTs === 0) return "ICEBERG DETECTOR · WAITING FOR THE FEED";
  if (!book.trusted()) return "ICEBERG DETECTOR · UNTRUSTED UNTIL THE NEXT PAGE";
  return null;
}

class IcebergPaneView implements IPrimitivePaneView {
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

class IcebergStatusRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { book: IcebergBook | null; shown: boolean };
  constructor(host: { book: IcebergBook | null; shown: boolean }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const text = icebergStatusText(this._host.book, this._host.shown);
    if (text === null) return;
    target.useMediaCoordinateSpace(({ context }) => drawStatusBadge(context, STATUS_BADGE_SLOT.iceberg, text));
  }
}

class IcebergRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { marks: readonly IcebergMark[]; settings: IcebergSettings; dark: boolean };
  constructor(host: { marks: readonly IcebergMark[]; settings: IcebergSettings; dark: boolean }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const { marks, settings, dark } = this._host;
    if (marks.length === 0) return;
    const sides: SideColors = {
      bid: parseRgb(icebergColorOf(settings, "bid"), icebergColorOf(settings, "bid")),
      ask: parseRgb(icebergColorOf(settings, "ask"), icebergColorOf(settings, "ask")),
    };
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        drawLines(context, marks, sides);
        drawPoints(context, marks, sides, dark);
        drawCards(context, marks, sides, dark);
      } finally {
        context.restore();
      }
    });
  }
}

export class IcebergPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _frame: number | null = null;
  private _frameKind: "raf" | "timer" | null = null;
  private _lastPaintAt = -Infinity;
  private _bookEpoch = 0;
  private _settingsVersion = 0;
  private _shownKey: string | null = null;
  private _shown: readonly IcebergOrder[] = [];
  private _sizes: IcebergSizeReference = icebergSizeReference([]);
  private _layoutKey: string | null = null;
  private _slots: ReadonlyMap<string, IcebergSlot> = new Map();
  private _rightInset: ((paneWidthPx: number) => number) | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private readonly _rows: ChartRowsProvider | null;
  private readonly _now: () => number;
  book: IcebergBook | null = null;
  shown = false;
  settings: IcebergSettings = { ...DEFAULT_ICEBERG_SETTINGS };
  dark = false;
  unit = "";
  marks: readonly IcebergMark[] = [];

  constructor(rows: ChartRowsProvider | null = null, now: () => number = () => Date.now()) {
    this._rows = rows;
    this._now = now;
    this._paneViews = [new IcebergPaneView(new IcebergRenderer(this)), new IcebergPaneView(new IcebergStatusRenderer(this))];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._cancelScheduledUpdate();
    this._forget();
    this.marks = [];
    this.book = null;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setBook(book: IcebergBook | null): void {
    if (book !== this.book) {
      this._bookEpoch += 1;
      this._forget();
    }
    this.book = book;
    this._schedule();
  }

  setShown(shown: boolean): void {
    if (this.shown === shown) return;
    this.shown = shown;
    this._schedule();
  }

  setSettings(settings: IcebergSettings): void {
    this.settings = settings;
    this._settingsVersion += 1;
    this._schedule();
  }

  setUnit(unit: string): void {
    this.unit = unit;
  }

  setDarkChart(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    this._schedule();
  }

  refresh(): void {
    this._schedule();
  }

  setRightInset(inset: ((paneWidthPx: number) => number) | null): void {
    this._rightInset = inset;
    this._layoutKey = null;
    this._schedule();
  }

  markAt(x: number, y: number): IcebergHover | null {
    const mark = icebergMarkAt(this.marks, x, y);
    return mark === null ? null : describeIceberg(mark.iceberg, this.unit);
  }

  cardAt(x: number, y: number): IcebergHover | null {
    const mark = cardUnder(this.marks, x, y);
    return mark === null ? null : describeIceberg(mark.iceberg, this.unit);
  }

  private _forget(): void {
    this._shownKey = null;
    this._shown = [];
    this._sizes = icebergSizeReference([]);
    this._layoutKey = null;
    this._slots = new Map();
  }

  private _schedule(): void {
    if (this._frame !== null) return;
    const hasAnimationFrame = typeof requestAnimationFrame === "function";
    const raf = hasAnimationFrame
      ? requestAnimationFrame
      : (callback: () => void) => setTimeout(callback, 16) as unknown as number;
    const paint = () => {
      this._frame = raf(() => {
        this._frame = null;
        this._frameKind = null;
        this._lastPaintAt = Date.now();
        this._requestUpdate?.();
      });
      this._frameKind = hasAnimationFrame ? "raf" : "timer";
    };
    const wait = REPAINT_MIN_INTERVAL_MS - (Date.now() - this._lastPaintAt);
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

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const book = this.book;
    if (!chart || !series || !book) {
      this.marks = [];
      this._forget();
      return;
    }
    const bars = this._rows?.() ?? series.data();
    const timeScale = chart.timeScale();
    const height = chart.paneSize().height;
    const width = timeScale.width();
    if (bars.length === 0 || !(height > 0) || !(width > 0)) {
      this.marks = [];
      this._layoutKey = null;
      return;
    }
    const now = this._now();
    const shownKey = `${this._bookEpoch}|${book.version}|${this._settingsVersion}|${Math.floor(now / SHOWN_REFRESH_MS)}`;
    if (shownKey !== this._shownKey) {
      const list = book.list();
      this._shown = shownIcebergs(list, this.settings, now, book.liveSince);
      const held = shownIcebergs(list, { ...this.settings, sizeTopPercent: 100, showPulled: true }, now, book.liveSince);
      this._sizes = icebergSizeReference(held.map((iceberg) => icebergTotalOf(iceberg).total));
      this._shownKey = shownKey;
    }
    const cardRight = Math.max(0, width - (this._rightInset?.(width) ?? 0));
    const layoutKey = [
      shownKey,
      width,
      height,
      cardRight,
      bars.length,
      bars[0].time,
      bars[bars.length - 1].time,
      timeScale.timeToCoordinate(bars[0].time),
      timeScale.timeToCoordinate(bars[bars.length - 1].time),
      series.priceToCoordinate(1),
      series.priceToCoordinate(2),
      candleEdge(bars[bars.length - 1], "high"),
      candleEdge(bars[bars.length - 1], "low"),
    ].join("|");
    if (layoutKey === this._layoutKey) return;
    const intervalMs = barIntervalSecOf(bars) * 1000;
    const xOf = (ms: number) => {
      const center = timeScale.timeToCoordinate((ms / 1000) as Time);
      return center === null ? null : Number(center);
    };
    const yOf = (price: number) => {
      const y = series.priceToCoordinate(price);
      return y === null ? null : Number(y);
    };
    const candles: IcebergCandle[] = [];
    for (const bar of bars) {
      const high = candleEdge(bar, "high");
      const low = candleEdge(bar, "low");
      if (high === null || low === null) continue;
      const x = Number(timeScale.timeToCoordinate(bar.time));
      if (!Number.isFinite(x) || x < 0 || x > width) continue;
      const top = yOf(high);
      const bottom = yOf(low);
      if (top === null || bottom === null) continue;
      candles.push({ x, top: Math.min(top, bottom), bottom: Math.max(top, bottom) });
    }
    const spacing = candles.length > 1 ? candles[candles.length - 1].x - candles[candles.length - 2].x : 0;
    const geometry = { xOf, yOf, width, height, cardRight, candles, candleHalfPx: Math.max(1, spacing / 2) };
    const candleOpenOf = (ts: number) => chartCandleOpen(bars, ts, intervalMs);
    const marks = layoutIcebergs(biggestPerCandle(this._shown, intervalMs, candleOpenOf), this.settings, geometry, candleOpenOf, this._slots, this._sizes);
    const slots = new Map<string, IcebergSlot>();
    for (const mark of marks) if (mark.slot !== null) slots.set(mark.iceberg.id, mark.slot);
    this.marks = marks;
    this._slots = slots;
    this._layoutKey = layoutKey;
  }
}
