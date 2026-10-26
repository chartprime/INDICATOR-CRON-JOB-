import { LineStyle } from "lightweight-charts";
import type {
  DrawingUtils,
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
import { DEFAULT_BOX_FONT_FAMILY, DEFAULT_BOX_TEXT_PADDING, type BoxData, type BoxTextVAlign } from "./box";
import {
  computeFillPolygon,
  visibleFillPoints,
  type FillOptions,
  type FillPoint,
  type FillSegment,
} from "./fill";
import type { LabelData } from "./label";
import type { LineData, LineExtendKind, LineStyleKind } from "./line";
import type { PolylineData } from "./polyline";
import {
  handlesForOwners,
  ownerChangedAt,
  setRequestUpdate,
  type DrawObjectRecord,
} from "./registry";

export interface RenderBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  borderColor: string;
  backgroundColor: string;
  borderWidth: number;
  text: string;
  textColor: string;
  fontSize: number;
  textAlign: CanvasTextAlign;
  textBackground: string;
  cornerRadius: number;
  tailToX: number;
  fontFamily: string;
  textPadding: number;
  textAccent: string;
  keepTextClear: boolean;
  textAfterBox: boolean;
  textFallbacks: readonly string[];
  textOffsetY: number;
  textVAlign: BoxTextVAlign;
  textOverLines: boolean;
  textFitsHeight: boolean;
}

export interface RenderLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style: LineStyleKind;
}

export interface RenderPolylinePoint {
  x: number;
  y: number;
}

export interface RenderPolyline {
  points: readonly RenderPolylinePoint[];
  color: string;
  width: number;
  style: LineStyleKind;
}

export interface RenderLabel {
  x: number;
  y: number;
  text: string;
  color: string;
  textColor: string;
  size: number;
  textSize: number;
  textAlign: CanvasTextAlign;
  offsetX: number;
}

export interface KernelRenderPieces {
  fillSegments: readonly FillSegment[];
  boxes: readonly RenderBox[];
  lines: readonly RenderLine[];
  polylines: readonly RenderPolyline[];
  labels: readonly RenderLabel[];
}

type CoordinateFn = (value: number) => number | null;

const EMPTY_RENDER_PIECES: KernelRenderPieces = {
  fillSegments: [],
  boxes: [],
  lines: [],
  polylines: [],
  labels: [],
};

function extendLineEndpoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extend: LineExtendKind,
  paneWidthPx: number,
): { x1: number; y1: number; x2: number; y2: number } {
  if (extend === "none") return { x1, y1, x2, y2 };
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0) return { x1, y1, x2, y2 };
  let nx1 = x1;
  let ny1 = y1;
  let nx2 = x2;
  let ny2 = y2;
  if (extend === "left" || extend === "both") {
    const t = (0 - x1) / dx;
    nx1 = 0;
    ny1 = y1 + t * dy;
  }
  if (extend === "right" || extend === "both") {
    const t = (paneWidthPx - x1) / dx;
    nx2 = paneWidthPx;
    ny2 = y1 + t * dy;
  }
  return { x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
}

/**
 * Pure geometry: converts every currently-registered draw object plus each
 * owner's fill points into pixel-space render pieces. Kept separate from the
 * primitive class so it's testable against fake coordinate functions, the
 * same way computeProfileRender is tested without a real chart/series.
 */
export function computeKernelRender(
  objects: readonly DrawObjectRecord[],
  fillPointsByOwner: ReadonlyMap<string, readonly (FillPoint | null)[]>,
  fillOptionsByOwner: ReadonlyMap<string, FillOptions>,
  timeToCoordinate: CoordinateFn,
  priceToCoordinate: CoordinateFn,
  paneWidthPx: number,
  rightEdgePx: number = paneWidthPx,
  dark = false,
  barSpacingPx = 0,
): KernelRenderPieces {
  if (objects.length === 0 && fillPointsByOwner.size === 0)
    return EMPTY_RENDER_PIECES;

  const boxes: RenderBox[] = [];
  const lines: RenderLine[] = [];
  const polylines: RenderPolyline[] = [];
  const labels: RenderLabel[] = [];

  for (const record of objects) {
    if (record.kind === "line") {
      const data = record.data as LineData;
      const x1 = timeToCoordinate(data.time1);
      const y1 = priceToCoordinate(data.price1);
      const x2 = timeToCoordinate(data.time2);
      const y2 = priceToCoordinate(data.price2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
      const extended = extendLineEndpoints(
        x1,
        y1,
        x2,
        y2,
        data.extend,
        paneWidthPx,
      );
      lines.push({
        ...extended,
        color: data.color,
        width: data.width,
        style: data.style,
      });
    } else if (record.kind === "box") {
      const data = record.data as BoxData;
      const x1 = timeToCoordinate(data.time1);
      const y1 = priceToCoordinate(data.price1);
      const x2 = timeToCoordinate(data.time2);
      const y2 = priceToCoordinate(data.price2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
      const grow = Math.max(0, (data.minHeightPx ?? 0) - Math.abs(y2 - y1)) / 2;
      boxes.push({
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2) - grow,
        x2: data.extendRight === true ? rightEdgePx : Math.max(x1, x2),
        y2: Math.max(y1, y2) + grow,
        borderColor: data.borderColor,
        backgroundColor: data.backgroundColor,
        borderWidth: data.borderWidth,
        text: data.text,
        textColor: dark && data.textColorOnDark ? data.textColorOnDark : data.textColor,
        fontSize: data.fontSize,
        textAlign: data.textAlign,
        textBackground: data.textBackground ?? "",
        cornerRadius: data.cornerRadius ?? 0,
        tailToX: data.tailFade === true ? Math.max(x1, x2, rightEdgePx) : Math.max(x1, x2),
        fontFamily: data.fontFamily ?? DEFAULT_BOX_FONT_FAMILY,
        textPadding: data.textPadding ?? DEFAULT_BOX_TEXT_PADDING,
        textAccent: data.textAccent ?? "",
        textAfterBox: data.textAfterBox === true,
        keepTextClear: data.keepTextClear === true,
        textFallbacks: data.textFallbacks ?? [],
        textOffsetY: data.textOffsetY ?? 0,
        textVAlign: data.textVAlign ?? "middle",
        textOverLines: data.textOverLines === true,
        textFitsHeight: data.textFitsHeight === true,
      });
    } else if (record.kind === "label") {
      const data = record.data as LabelData;
      let x = timeToCoordinate(data.time);
      const y = priceToCoordinate(data.price);
      if (x === null || y === null) continue;
      // A label may sit a whole number of bars into the future, where no time
      // exists to convert at all: the time scale's own bar width is what carries
      // it there, so it follows a zoom instead of freezing at one spacing.
      const barOffset = data.barOffset ?? 0;
      if (barOffset !== 0) x += barOffset * barSpacingPx;
      labels.push({
        x,
        y,
        text: data.text,
        color: data.color,
        textColor: data.textColor,
        size: data.size,
        textSize: data.textSize,
        textAlign: data.textAlign,
        offsetX: data.offsetX,
      });
    } else if (record.kind === "polyline") {
      const data = record.data as PolylineData;
      const points: RenderPolylinePoint[] = [];
      for (const point of data.points) {
        const x = timeToCoordinate(point.time);
        const y = priceToCoordinate(point.price);
        if (x === null || y === null) continue;
        points.push({ x, y });
      }
      if (points.length >= 2)
        polylines.push({
          points,
          color: data.color,
          width: data.width,
          style: data.style,
        });
    }
    // "table" is rendered as a DOM overlay, not by this canvas kernel.
  }

  const fillSegments: FillSegment[] = [];
  for (const [ownerId, points] of fillPointsByOwner) {
    fillSegments.push(
      ...computeFillPolygon(
        points,
        timeToCoordinate,
        priceToCoordinate,
        fillOptionsByOwner.get(ownerId),
      ),
    );
  }

  return { fillSegments, boxes, lines, polylines, labels };
}

export function applyLineStyle(
  context: CanvasRenderingContext2D,
  style: LineStyleKind,
  utils: DrawingUtils | undefined,
): void {
  if (utils) {
    utils.setLineStyle(
      context,
      style === "dashed"
        ? LineStyle.Dashed
        : style === "dotted"
          ? LineStyle.Dotted
          : LineStyle.Solid,
    );
    return;
  }
  context.setLineDash(
    style === "dashed" ? [6, 4] : style === "dotted" ? [2, 2] : [],
  );
}

class DrawKernelFillRenderer implements IPrimitivePaneRenderer {
  private readonly _segments: readonly FillSegment[];

  constructor(segments: readonly FillSegment[]) {
    this._segments = segments;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const segment of this._segments) {
          if (segment.points.length < 2) continue;
          context.fillStyle = segment.color;
          context.beginPath();
          context.moveTo(segment.points[0].x, segment.points[0].yA);
          for (const point of segment.points) context.lineTo(point.x, point.yA);
          for (let index = segment.points.length - 1; index >= 0; index -= 1) {
            context.lineTo(segment.points[index].x, segment.points[index].yB);
          }
          context.closePath();
          context.fill();
        }
      } finally {
        context.restore();
      }
    });
  }
}

class DrawKernelTopRenderer implements IPrimitivePaneRenderer {
  private readonly _primitive: DrawKernelPrimitive;
  private readonly _boxes: readonly RenderBox[];
  private readonly _lines: readonly RenderLine[];
  private readonly _polylines: readonly RenderPolyline[];
  private readonly _labels: readonly RenderLabel[];

  private readonly _paneWidthPx: number;

  constructor(
    primitive: DrawKernelPrimitive,
    boxes: readonly RenderBox[],
    lines: readonly RenderLine[],
    polylines: readonly RenderPolyline[],
    labels: readonly RenderLabel[],
    paneWidthPx: number,
  ) {
    this._primitive = primitive;
    this._paneWidthPx = paneWidthPx;
    this._boxes = boxes;
    this._lines = lines;
    this._polylines = polylines;
    this._labels = labels;
  }

  draw(target: CanvasRenderingTarget2D, utils?: DrawingUtils): void {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        const placements = this._primitive.cardPlacements(context, this._boxes, this._paneWidthPx);
        this._boxes.forEach((box, index) => {
          const { card, dy } = placements[index];
          const tailToX = card === null ? (box.text.length > 0 ? box.x2 : box.tailToX) : card.backing === null || box.textAfterBox ? box.tailToX : Math.min(card.backing.x2, box.tailToX);
          paintBoxShape(context, box, tailToX);
          if (card !== null && !box.textOverLines) paintCard(context, box, card, dy);
        });
        for (const line of this._lines) {
          context.strokeStyle = line.color;
          context.lineWidth = line.width;
          applyLineStyle(context, line.style, utils);
          context.beginPath();
          context.moveTo(line.x1, line.y1);
          context.lineTo(line.x2, line.y2);
          context.stroke();
        }
        for (const polyline of this._polylines) {
          context.strokeStyle = polyline.color;
          context.lineWidth = polyline.width;
          applyLineStyle(context, polyline.style, utils);
          context.beginPath();
          context.moveTo(polyline.points[0].x, polyline.points[0].y);
          for (const point of polyline.points.slice(1))
            context.lineTo(point.x, point.y);
          context.stroke();
        }
        context.setLineDash([]);
        this._boxes.forEach((box, index) => {
          const { card, dy } = placements[index];
          if (card !== null && box.textOverLines) paintCard(context, box, card, dy);
        });
        for (const label of this._labels) {
          context.fillStyle = label.color;
          context.beginPath();
          context.arc(label.x, label.y, label.size / 2, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = label.textColor;
          context.font = `${label.textSize}px sans-serif`;
          context.textAlign = label.textAlign;
          context.textBaseline = "middle";
          context.fillText(label.text, label.x + label.offsetX, label.y);
        }
      } finally {
        context.restore();
      }
    });
  }
}

const BOX_TEXT_LINE_HEIGHT = 1.3;
const BOX_TEXT_ACCENT_PX = 3;

function paintBoxShape(context: CanvasRenderingContext2D, box: RenderBox, tailToX: number): void {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  if (box.cornerRadius > 0) {
    context.beginPath();
    context.roundRect(box.x1, box.y1, width, height, box.cornerRadius);
    context.fillStyle = box.backgroundColor;
    context.fill();
    if (box.borderWidth > 0) {
      context.strokeStyle = box.borderColor;
      context.lineWidth = box.borderWidth;
      context.setLineDash([]);
      context.stroke();
    }
  } else {
    context.fillStyle = box.backgroundColor;
    context.fillRect(box.x1, box.y1, width, height);
    if (box.borderWidth > 0) {
      context.strokeStyle = box.borderColor;
      context.lineWidth = box.borderWidth;
      context.setLineDash([]);
      context.strokeRect(box.x1, box.y1, width, height);
    }
  }
  if (tailToX > box.x2) {
    const fade = context.createLinearGradient(box.x2, 0, tailToX, 0);
    fade.addColorStop(0, box.backgroundColor);
    fade.addColorStop(1, transparentOf(box.backgroundColor));
    context.fillStyle = fade;
    context.fillRect(box.x2, box.y1, tailToX - box.x2, height);
  }
}

function transparentOf(color: string): string {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  if (rgba !== null) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, 0)`;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) return "transparent";
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0)`;
}

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Card {
  lines: string[];
  lineHeight: number;
  textX: number;
  firstY: number;
  accent: number;
  backing: Rect | null;
  extent: Rect;
  width: number;
}

const CARD_GAP_PX = 6;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function moved(rect: Rect, dy: number): Rect {
  return { ...rect, y1: rect.y1 + dy, y2: rect.y2 + dy };
}

function clearBelow(backing: Rect, placed: readonly Rect[]): number {
  let dy = 0;
  for (;;) {
    const blocking = placed.filter((rect) => overlaps(moved(backing, dy), rect));
    if (blocking.length === 0) return dy;
    dy = Math.max(...blocking.map((rect) => rect.y2)) + CARD_GAP_PX - backing.y1;
  }
}

function clearAbove(backing: Rect, placed: readonly Rect[]): number {
  let dy = 0;
  for (;;) {
    const blocking = placed.filter((rect) => overlaps(moved(backing, dy), rect));
    if (blocking.length === 0) return dy;
    dy = Math.min(...blocking.map((rect) => rect.y1)) - CARD_GAP_PX - backing.y2;
  }
}

function shiftClear(backing: Rect, placed: readonly Rect[]): number {
  const down = clearBelow(backing, placed);
  const up = clearAbove(backing, placed);
  if (backing.y1 + up < 0) return down;
  return -up < down ? up : down;
}

function layoutCards(boxes: readonly RenderBox[], forms: readonly (readonly Card[])[]): { card: Card | null; dy: number }[] {
  const placements: { card: Card | null; dy: number }[] = boxes.map((_, index) => ({ card: forms[index][0] ?? null, dy: 0 }));
  const placed: Rect[] = [];
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const candidates = forms[index];
    if (!boxes[index].keepTextClear || candidates.length === 0) continue;
    let chosen = candidates.find((card) => !placed.some((rect) => overlaps(card.extent, rect)));
    let dy = 0;
    if (chosen === undefined) {
      chosen = candidates[0];
      dy = shiftClear(chosen.extent, placed);
      const box = boxes[index];
      const shifted = moved(chosen.extent, dy);
      if (box.textFitsHeight && !box.textAfterBox && (shifted.y1 < box.y1 || shifted.y2 > box.y2)) {
        placements[index] = { card: null, dy: 0 };
        continue;
      }
    }
    placements[index] = { card: chosen, dy };
    if (chosen.backing !== null || chosen.width > 0) placed.push(moved(chosen.extent, dy));
  }
  return placements;
}

function applyBoxFont(context: CanvasRenderingContext2D, box: RenderBox): void {
  context.font = `${box.fontSize}px ${box.fontFamily}`;
}

function measureCards(context: CanvasRenderingContext2D, box: RenderBox, paneWidthPx: number): Card[] {
  if (box.textFallbacks.length === 0) return [layCard(context, box, box.text)];
  const room = box.textAfterBox ? paneWidthPx - box.x2 - CARD_GAP_PX : box.x2 - box.x1;
  const forms: Card[] = [];
  for (const text of [box.text, ...box.textFallbacks]) {
    const card = layCard(context, box, text);
    if (card.width <= room && (!box.textFitsHeight || box.textAfterBox || card.lines.length * card.lineHeight <= box.y2 - box.y1)) forms.push(card);
  }
  return forms;
}

function layCard(context: CanvasRenderingContext2D, box: RenderBox, text: string): Card {
  const lines = text.split("\n");
  const lineHeight = box.fontSize * BOX_TEXT_LINE_HEIGHT;
  const backed = box.textBackground.length > 0;
  const pad = box.textPadding;
  const inset = backed ? pad : 0;
  const accent = box.textAccent.length > 0 ? BOX_TEXT_ACCENT_PX : 0;
  applyBoxFont(context, box);
  const textX = box.textAfterBox
    ? box.x2 + CARD_GAP_PX + inset + accent
    : box.textAlign === "left"
      ? box.x1 + inset + accent
      : box.textAlign === "right"
        ? box.x2 - inset
        : (box.x1 + box.x2) / 2;
  const anchorY = box.textVAlign === "bottom" ? box.y2 - pad - lineHeight / 2 - ((lines.length - 1) * lineHeight) / 2 : (box.y1 + box.y2) / 2;
  const firstY = anchorY + box.textOffsetY - ((lines.length - 1) * lineHeight) / 2;
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, context.measureText(line).width);
  const textLeft = box.textAfterBox || box.textAlign === "left" ? textX : box.textAlign === "right" ? textX - widest : textX - widest / 2;
  const extent = { x1: textLeft, y1: firstY - lineHeight / 2, x2: textLeft + widest, y2: firstY - lineHeight / 2 + lines.length * lineHeight };
  if (!backed) return { lines, lineHeight, textX, firstY, accent, backing: null, extent, width: widest };
  const x1 = textLeft - pad - accent;
  const y1 = firstY - lineHeight / 2 - pad;
  const width = widest + pad * 2 + accent;
  const backing = { x1, y1, x2: x1 + width, y2: y1 + lines.length * lineHeight + pad * 2 };
  return { lines, lineHeight, textX, firstY, accent, backing, extent: backing, width };
}

function paintCard(context: CanvasRenderingContext2D, box: RenderBox, card: Card, dy: number): void {
  applyBoxFont(context, box);
  context.textAlign = box.textAfterBox ? "left" : box.textAlign;
  context.textBaseline = "middle";
  const { backing, accent } = card;
  if (backing !== null) {
    const top = backing.y1 + dy;
    const width = backing.x2 - backing.x1;
    const height = backing.y2 - backing.y1;
    context.fillStyle = box.textBackground;
    if (box.cornerRadius > 0) {
      context.beginPath();
      context.roundRect(backing.x1, top, width, height, box.cornerRadius);
      context.fill();
    } else {
      context.fillRect(backing.x1, top, width, height);
    }
    if (accent > 0) {
      context.fillStyle = box.textAccent;
      context.beginPath();
      context.roundRect(backing.x1, top, accent, height, [box.cornerRadius, 0, 0, box.cornerRadius]);
      context.fill();
    }
  }
  card.lines.forEach((line, index) => {
    context.fillStyle = index === 0 && accent > 0 ? box.textAccent : box.textColor;
    context.fillText(line, card.textX, card.firstY + dy + index * card.lineHeight);
  });
}

class DrawKernelFillPaneView implements IPrimitivePaneView {
  private readonly _primitive: DrawKernelPrimitive;

  constructor(primitive: DrawKernelPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DrawKernelFillRenderer(this._primitive.renderFillSegments);
  }
}

class DrawKernelTopPaneView implements IPrimitivePaneView {
  private readonly _primitive: DrawKernelPrimitive;

  constructor(primitive: DrawKernelPrimitive) {
    this._primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new DrawKernelTopRenderer(
      this._primitive,
      this._primitive.renderBoxes,
      this._primitive.renderLines,
      this._primitive.renderPolylines,
      this._primitive.renderLabels,
      this._primitive.renderPaneWidthPx,
    );
  }
}

/**
 * One instance per pane, not a global singleton -- an own-pane indicator
 * (e.g. RSI) must not have its drawn objects rendered on the main series.
 * `setOwnerIds` scopes which indicators' registered objects this instance
 * is responsible for; a pane hosting no draw-using indicator never has one
 * of these constructed at all.
 */
export class DrawKernelPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _ownerIds: readonly string[] = [];
  private _fillPointsByOwner = new Map<string, readonly (FillPoint | null)[]>();
  private _fillOptionsByOwner = new Map<string, FillOptions>();
  private readonly _paneViews: readonly IPrimitivePaneView[];

  renderFillSegments: readonly FillSegment[] = [];
  renderBoxes: readonly RenderBox[] = [];
  renderPaneWidthPx = 0;
  renderLines: readonly RenderLine[] = [];
  renderPolylines: readonly RenderPolyline[] = [];
  renderLabels: readonly RenderLabel[] = [];
  private _cards: { boxes: readonly RenderBox[]; paneWidthPx: number; placements: readonly { card: Card | null; dy: number }[] } | null = null;
  private _barTimesRevision: () => number = () => 0;
  private _rightInset: (paneWidthPx: number) => number = () => 0;
  private _dark = false;
  private _viewKey: string | null = null;
  private _viewFills: readonly unknown[] = [];

  constructor() {
    this._paneViews = [
      new DrawKernelFillPaneView(this),
      new DrawKernelTopPaneView(this),
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this._viewKey = null;
  }

  setBarTimesRevision(revision: () => number): void {
    this._barTimesRevision = revision;
    this._viewKey = null;
  }

  setRightInset(inset: (paneWidthPx: number) => number): void {
    this._rightInset = inset;
    this._requestUpdate?.();
  }

  setDarkChart(dark: boolean): void {
    this._dark = dark;
    this._viewKey = null;
    this._requestUpdate?.();
  }

  detached(): void {
    for (const ownerId of this._ownerIds) setRequestUpdate(ownerId, null);
    this._viewKey = null;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  /**
   * Registers this instance's own requestUpdate against every owner it's now
   * responsible for, so a direct handle mutation (line.setXY1(), box.delete(),
   * etc.) made any time between bar-transitions repaints immediately instead
   * of silently waiting for the next flushDrawState() call to happen to touch
   * this pane.
   */
  setOwnerIds(ownerIds: readonly string[]): void {
    for (const ownerId of this._ownerIds) {
      if (!ownerIds.includes(ownerId)) setRequestUpdate(ownerId, null);
    }
    for (const ownerId of ownerIds) {
      setRequestUpdate(ownerId, () => this._requestUpdate?.());
    }
    this._ownerIds = ownerIds;
    const ownerIdSet = new Set(ownerIds);
    for (const ownerId of [...this._fillPointsByOwner.keys()]) {
      if (!ownerIdSet.has(ownerId)) {
        this._fillPointsByOwner.delete(ownerId);
        this._fillOptionsByOwner.delete(ownerId);
      }
    }
    this._requestUpdate?.();
  }

  setFillPoints(
    ownerId: string,
    points: readonly (FillPoint | null)[],
    options?: FillOptions,
  ): void {
    this._fillPointsByOwner.set(ownerId, points);
    if (options) this._fillOptionsByOwner.set(ownerId, options);
    else this._fillOptionsByOwner.delete(ownerId);
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) {
      this.renderFillSegments = [];
      this.renderBoxes = [];
      this.renderPaneWidthPx = 0;
      this.renderLines = [];
      this.renderPolylines = [];
      this.renderLabels = [];
      return;
    }
    const timeScale = chart.timeScale();
    const logical = timeScale.getVisibleLogicalRange();
    const fills: unknown[] = [];
    for (const [ownerId, points] of this._fillPointsByOwner) {
      if (points.length === 0) continue;
      fills.push(ownerId, points, points.length, points[points.length - 1], this._fillOptionsByOwner.get(ownerId));
    }
    const paneWidthPx = timeScale.width();
    const rightEdgePx = paneWidthPx - Math.min(paneWidthPx, Math.max(0, this._rightInset(paneWidthPx)));
    const viewKey = [
      this._barTimesRevision(), logical?.from ?? "", logical?.to ?? "", timeScale.options().barSpacing, paneWidthPx, rightEdgePx,
      series.priceToCoordinate(1), series.priceToCoordinate(1000),
      ...this._ownerIds.map((ownerId) => `${ownerId}@${ownerChangedAt(ownerId)}`),
    ].join("|");
    if (viewKey === this._viewKey && fills.length === this._viewFills.length && fills.every((part, index) => Object.is(part, this._viewFills[index]))) return;
    this._viewKey = viewKey;
    this._viewFills = fills;
    const xByTime = new Map<number, number | null>();
    const yByPrice = new Map<number, number | null>();
    const timeToCoordinate: CoordinateFn = (time) => {
      let x = xByTime.get(time);
      if (x === undefined) {
        x = timeScale.timeToCoordinate((time / 1000) as Time);
        xByTime.set(time, x);
      }
      return x;
    };
    const priceToCoordinate: CoordinateFn = (price) => {
      let y = yByPrice.get(price);
      if (y === undefined) {
        y = series.priceToCoordinate(price);
        yByPrice.set(price, y);
      }
      return y;
    };

    const objects = handlesForOwners(this._ownerIds);
    const range = timeScale.getVisibleRange();
    const fillPoints = range === null
      ? this._fillPointsByOwner
      : new Map([...this._fillPointsByOwner].map(([ownerId, points]) => [ownerId, visibleFillPoints(points, Number(range.from) * 1000, Number(range.to) * 1000)]));
    const pieces = computeKernelRender(
      objects,
      fillPoints,
      this._fillOptionsByOwner,
      timeToCoordinate,
      priceToCoordinate,
      paneWidthPx,
      rightEdgePx,
      this._dark,
      timeScale.options().barSpacing,
    );
    this.renderFillSegments = pieces.fillSegments;
    this.renderBoxes = pieces.boxes;
    this.renderPaneWidthPx = paneWidthPx;
    this.renderLines = pieces.lines;
    this.renderPolylines = pieces.polylines;
    this.renderLabels = pieces.labels;
  }

  cardPlacements(
    context: CanvasRenderingContext2D,
    boxes: readonly RenderBox[],
    paneWidthPx: number,
  ): readonly { card: Card | null; dy: number }[] {
    const cached = this._cards;
    if (cached !== null && cached.boxes === boxes && cached.paneWidthPx === paneWidthPx) return cached.placements;
    const forms = boxes.map((box) => (box.text.length > 0 ? measureCards(context, box, paneWidthPx) : []));
    const placements = layoutCards(boxes, forms);
    this._cards = { boxes, paneWidthPx, placements };
    return placements;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }
}
