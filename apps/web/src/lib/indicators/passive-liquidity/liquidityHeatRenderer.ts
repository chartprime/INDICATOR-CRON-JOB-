// The heat itself: every visible cell of the time x price matrix painted into
// RGBA buffers and blitted, brightest cell winning each pixel.
//
// The picture is drawn band by band, one run at a time. `liquidityRuns.ts` is
// the one place that says where a level begins and how it ends: resting,
// consumed (it emptied as price arrived, and a solid cap marks the spot) or
// pulled (it left on its own, drawn faint and only when asked for). A
// resting or consumed level is drawn at the most it has held over its run in
// every column, so a wall being eaten keeps its size and colour until price
// ends it (the trader's rule, 2026-09-14); only a pulled level is drawn as
// it was, a hairline where it thinned for a moment. Runs are tracked over the
// whole retained span and drawn only where they are visible.
//
// How bright and how thick a cell is, and whether it darkens as it ages, is
// the market's call: crypto reads against the largest level in view and ages a
// little (cryptoLiquidityStyle.ts), indexes are frozen with their column and
// paint only what stands above typical (indexLiquidityStyle.ts and the
// per-instrument files).
//
// Since 2026-10-07 the cells older than the live candle are kept between
// frames in a raster anchored to time. A pan moves it and paints only the
// strip it uncovers; columns that come, go or change under it (the oldest
// second dropping off, a late column, history landing) paint only their own
// strip again; a band whose runs change (a wall grows, is eaten, the ledger
// settles its fate) paints only its own rows again; a change to anything
// every cell reads (the settings, the colours, the zoom, the price axis, the
// colour scale, a candle closing) paints the view again. The live candle's
// columns are painted right of the split, and painted again only when the
// book or the view changed. Every region gets each cell that reaches into
// it, cut to it, so the pieces tile into the very picture one paint of the
// whole view makes. A pan by a fraction of a pixel is drawn at the nearest
// whole pixel while the view moves, and painted exactly once it has stood
// still for SETTLE_MS. A pan by whole pixels keeps the raster as it is: a
// column edge that falls exactly on a half pixel can then round a pixel the
// other way than a fresh paint would, until the view is painted again.

import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { chartMsOf, wallMsOf, type TimeGap } from "./chartTime";
import { liquidityIndexAtOrAfter, type LiquidityColumn } from "./liquidityGrid";
import type { HeatmapHost, Rgb } from "./liquidityHeatmapHost";
import type { HeatTier } from "./liquidityHeatmapLayout";
import { createRunFinder, showsFate, type RunFinder } from "./liquidityRunFinder";
import { CONNECTOR_ALPHA_SHARE, CONNECTOR_PX, type RunFate, type RunSegment } from "./liquidityRuns";
import type { LiquiditySettings } from "./liquiditySettings";
import type { LiquidityStyle, SaturationContext } from "./liquidityStyle";

/** The solid cap that ends a consumed level where price ate it. */
const CONSUMED_CAP_PX = 2;
/** A pulled level is drawn at this share of its brightness: it was there, and nothing happened to it. */
const PULLED_ALPHA_SHARE = 0.45;
/**
 * A resting level's newest column is at least this wide. At 1 s columns on a
 * 1-minute chart a level's first column is a tenth of a pixel, so without this
 * a level that just appeared hides as a sliver for its first half minute.
 */
const LIVE_EDGE_MIN_PX = 3;
/** How long the view must stand still after a pan by a fraction of a pixel before it is painted at its exact position. */
export const SETTLE_MS = 150;
/** The raster keeps this share of a view's width of settled heat either side of the screen, so a pan finds it painted. */
export const RASTER_SPARE_VIEWS = 0.25;
/** The widest the raster grows, in device pixels; a pane wider than that keeps no spare. */
export const RASTER_MAX_PX = 8_192;
/** A pan this close to a whole number of device pixels moves the raster without painting it again. */
const WHOLE_PX = 1e-6;
/** A region this many pixels or larger keeps its buffer for the next region of the same size. */
const KEPT_BUFFER_PX = 65_536;

const FATE_CODE: Record<RunFate, number> = { resting: 0, consumed: 1, pulled: 2 };

/** Paint a cell into RGBA data where it is brighter than what is already there. */
function fillCell(data: Uint8ClampedArray, width: number, x0: number, x1: number, y0: number, y1: number, rgb: Rgb, alpha: number): void {
  for (let y = y0; y < y1; y += 1) {
    let index = (y * width + x0) * 4;
    for (let x = x0; x < x1; x += 1, index += 4) {
      if (data[index + 3] < alpha) {
        data[index] = rgb.r;
        data[index + 1] = rgb.g;
        data[index + 2] = rgb.b;
        data[index + 3] = alpha;
      }
    }
  }
}

/** The darkness of the cap on a consumed level: the trader's opacity, full. */
function capAlphaOf(maxOpacity: number): number {
  return Math.round(Math.min(1, Math.max(0, maxOpacity)) * 255);
}

export function cellOf(run: RunSegment, size: number, paintFloor: number): { size: number; full: boolean; fade: number } {
  if (run.fate === "pulled") return { size, full: size >= paintFloor, fade: PULLED_ALPHA_SHARE };
  return { size: Math.max(size, run.peak), full: true, fade: 1 };
}

/** Time to device x: where the chart puts a time, rounded, then moved by a whole number of pixels. */
interface Mapping {
  originX: number;
  originMs: number;
  originChart: number;
  gaps: readonly TimeGap[];
  pxPerMs: number;
  ratio: number;
  shift: number;
}

function xAt(mapping: Mapping, ms: number): number {
  return Math.round((mapping.originX + (chartMsOf(ms, mapping.gaps) - mapping.originChart) * mapping.pxPerMs) * mapping.ratio) + mapping.shift;
}

function msAt(mapping: Mapping, x: number): number {
  return wallMsOf(mapping.originChart + ((x - mapping.shift) / mapping.ratio - mapping.originX) / mapping.pxPerMs, mapping.gaps);
}

/** A band in view, in device pixels, cut to the pane. */
interface PaintBand {
  row: number;
  y0: number;
  y1: number;
}

/** What one frame's cells are painted from. */
interface Painter {
  tiers: readonly HeatTier[];
  bands: readonly PaintBand[];
  runs: RunFinder;
  settings: LiquiditySettings;
  bidRgb: Rgb;
  askRgb: Rgb;
  livePx: number;
  connector: number;
  cap: number;
  capAlpha: number;
  /** The open of the oldest column held: nothing is painted left of it. */
  dataStart: number;
}

/** The columns of one tier whose cells can reach a stretch of x: indices [first, stop). */
interface ColumnSpan {
  tier: HeatTier;
  index: number;
  first: number;
  stop: number;
}

/** Every column whose cell can reach x [x0, x1), but none from `untilMs` on. */
function columnSpans(painter: Painter, mapping: Mapping, x0: number, x1: number, untilMs: number): ColumnSpan[] {
  const fromMs = msAt(mapping, x0 - painter.livePx - 2);
  const toMs = Math.min(untilMs, msAt(mapping, x1 + painter.cap + 2));
  const spans: ColumnSpan[] = [];
  painter.tiers.forEach((tier, index) => {
    const first = liquidityIndexAtOrAfter(tier.columns, fromMs - tier.columnMs);
    const stop = Math.min(tier.scanTo, liquidityIndexAtOrAfter(tier.columns, toMs));
    if (stop > first) spans.push({ tier, index, first, stop });
  });
  return spans;
}

/** Index of the first run ending after `ts`. */
function firstEndingAfter(segments: readonly RunSegment[], ts: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].endTs <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first column in [lo, hi) at or after `ts`; `hi` when none. */
function firstColumnFrom(columns: readonly LiquidityColumn[], ts: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Paint every cell that reaches into device pixels [x0, x1) x [y0, y1), x by
 * `mapping` and y on the pane, cut to them, into `data`, whose pixel (0, 0)
 * is (x0, y0). The cells, their order and the brightest-wins rule are those
 * of one paint of the whole view, so regions painted apart tile into it.
 * Columns from `untilMs` on are left out. Each run is walked over its own
 * columns, and what a column reads from the colour scale is read once.
 */
function paintRegion(painter: Painter, mapping: Mapping, x0: number, x1: number, y0: number, y1: number, untilMs: number, data: Uint8ClampedArray): void {
  const { bands, runs, settings, livePx, connector, cap, capAlpha } = painter;
  const style = runs.style;
  const width = x1 - x0;
  const left = Math.max(x0, xAt(mapping, painter.dataStart));
  const spans = columnSpans(painter, mapping, x0, x1, untilMs);
  if (spans.length === 0 || left >= x1) return;
  const scales = spans.map(({ first, stop }) => new Float64Array((stop - first) * 4).fill(Number.NaN));
  const fill = (fromX: number, toX: number, fromY: number, toY: number, rgb: Rgb, alpha: number) => {
    const from = Math.max(fromX, left);
    const to = Math.min(toX, x1);
    const top = Math.max(fromY, y0);
    const bottom = Math.min(toY, y1);
    if (to > from && bottom > top) fillCell(data, width, from - x0, to - x0, top - y0, bottom - y0, rgb, alpha);
  };
  for (const band of bands) {
    if (band.y1 + connector <= y0 || band.y0 - connector >= y1) continue;
    // One run per side. A band where both sides rest (the spread sits inside
    // it) is split, bid below and ask above, so it never flips colour.
    for (const side of ["bid", "ask"] as const) {
      const segments = runs.runsFor(band.row, side);
      if (segments.length === 0) continue;
      const rgb = side === "bid" ? painter.bidRgb : painter.askRgb;
      for (let s = 0; s < spans.length; s += 1) {
        const { tier, first, stop } = spans[s];
        const columns = tier.columns;
        const scale = scales[s];
        let c = first;
        for (let ri = firstEndingAfter(segments, columns[first].ts); ri < segments.length && c < stop; ri += 1) {
          const run = segments[ri];
          if (!showsFate(settings, run.fate)) continue;
          if (columns[c].ts < run.startTs) c = firstColumnFrom(columns, run.startTs, c, stop);
          for (; c < stop && columns[c].ts < run.endTs; c += 1) {
            const column = columns[c];
            const last = column.ts + tier.columnMs >= run.endTs;
            const x = xAt(mapping, column.ts);
            let right = xAt(mapping, column.ts + tier.columnMs);
            if (right <= x) right = x + 1;
            // A resting level's newest column gets a small head past the live edge.
            if (run.fate === "resting" && last) right = Math.max(right, x + livePx);
            if (right <= left || Math.min(x, right - cap) >= x1) continue;
            const at = (c - first) * 4;
            if (Number.isNaN(scale[at])) {
              const floors = runs.floorsAt(column, band.row, true);
              scale[at] = floors.paint;
              scale[at + 1] = floors.link;
              scale[at + 2] = style.saturationAt(column, runs.saturation);
              scale[at + 3] = style.typicalBand(column, runs.saturation);
            }
            const paintFloor = scale[at];
            const linkFloor = scale[at + 1];
            const sizes = runs.sizesAt(column, band.row);
            const size = sizes[side];
            if (!(size >= linkFloor)) continue;
            const shared = sizes[side === "bid" ? "ask" : "bid"] >= linkFloor;
            const mid = Math.round((band.y0 + band.y1) / 2);
            const hy0 = shared ? (side === "bid" ? mid : band.y0) : band.y0;
            const hy1 = shared ? (side === "bid" ? band.y1 : mid) : band.y1;
            if (hy1 <= hy0) continue;

            const cell = cellOf(run, size, paintFloor);
            const age = style.ageFactor(column.ts + tier.columnMs - run.startTs) * cell.fade;
            const saturation = scale[at + 2];
            const median = scale[at + 3];
            if (cell.full) {
              const alpha = Math.round(style.alphaOf(cell.size, { settings, paint: paintFloor, saturation, median }) * age);
              if (alpha > 0) {
                const span = style.bandSpan(cell.size / saturation, hy1 - hy0);
                const top = hy0 + span.offset;
                fill(x, right, top, top + span.size, rgb, alpha);
              }
            } else {
              // Thinned for the moment but still there: a hairline keeps the level in one piece.
              const floorAlpha = style.alphaOf(paintFloor, { settings, paint: paintFloor, saturation, median });
              const alpha = Math.max(1, Math.round(floorAlpha * CONNECTOR_ALPHA_SHARE * age));
              const top = Math.round((hy0 + hy1) / 2) - Math.floor(connector / 2);
              fill(x, right, top, top + connector, rgb, alpha);
            }
            // Consumed: a solid cap on the last column marks where price ate it.
            if (run.fate === "consumed" && last) fill(right - cap, right, hy0, hy1, rgb, capAlpha);
          }
        }
      }
    }
  }
}

/** The columns under the spans, tier by tier: the very objects, so a column replaced in place shows. */
function columnsUnder(painter: Painter, spans: readonly ColumnSpan[]): LiquidityColumn[][] {
  const under: LiquidityColumn[][] = painter.tiers.map(() => []);
  for (const { tier, index, first, stop } of spans) under[index] = tier.columns.slice(first, stop);
  return under;
}

/** Whether two columns at the same time hold the same book: a list folded again makes new objects of the same columns. */
function sameColumn(a: LiquidityColumn, b: LiquidityColumn): boolean {
  if (a === b) return true;
  if (a.lo !== b.lo || a.hi !== b.hi || a.reference !== b.reference || a.median !== b.median || a.ceiling !== b.ceiling || a.bid.length !== b.bid.length || a.ask.length !== b.ask.length) return false;
  for (let i = 0; i < a.bid.length; i += 1) if (a.bid[i] !== b.bid[i] || a.ask[i] !== b.ask[i]) return false;
  return true;
}

/**
 * The stretches of time [from, to) whose columns differ from `before`: a
 * column gone, a column come, or another book at the same time. Null when
 * the tiers themselves changed.
 */
function changedStretches(before: readonly (readonly LiquidityColumn[])[], beforeMs: readonly number[], painter: Painter, spans: readonly ColumnSpan[]): [number, number][] | null {
  if (before.length !== painter.tiers.length) return null;
  const changed: [number, number][] = [];
  for (let t = 0; t < painter.tiers.length; t += 1) {
    const tier = painter.tiers[t];
    if (tier.columnMs !== beforeMs[t]) return null;
    const span = spans.find((candidate) => candidate.index === t);
    const was = before[t];
    const list = tier.columns;
    const stop = span?.stop ?? 0;
    let i = 0;
    let j = span?.first ?? 0;
    while (i < was.length || j < stop) {
      const old = i < was.length ? was[i] : null;
      const now = j < stop ? list[j] : null;
      if (now === null || (old !== null && old.ts < now.ts)) {
        const gone = old as LiquidityColumn;
        changed.push([gone.ts, gone.ts + tier.columnMs]);
        i += 1;
      } else if (old === null || now.ts < old.ts) {
        changed.push([now.ts, now.ts + tier.columnMs]);
        j += 1;
      } else {
        if (!sameColumn(old, now)) changed.push([now.ts, now.ts + tier.columnMs]);
        i += 1;
        j += 1;
      }
    }
  }
  return changed;
}

/** Whether every column of the spans reads the same paint floor, saturation and typical band under both colour scales. */
function sameScale(style: LiquidityStyle, spans: readonly ColumnSpan[], a: SaturationContext, b: SaturationContext): boolean {
  for (const { tier, first, stop } of spans) {
    for (let c = first; c < stop; c += 1) {
      const column = tier.columns[c];
      if (style.paintFloor(column, a) !== style.paintFloor(column, b)) return false;
      if (style.saturationAt(column, a) !== style.saturationAt(column, b)) return false;
      if (style.typicalBand(column, a) !== style.typicalBand(column, b)) return false;
    }
  }
  return true;
}

/**
 * Each band's runs as the columns of the spans see them, bid then ask: every
 * run that reaches one of those columns, by its start, its end (Infinity when
 * none of them can be its last column), its fate and its peak.
 */
function marksOf(painter: Painter, spans: readonly ColumnSpan[]): number[][] {
  let fromTs = Infinity;
  let lastTs = -Infinity;
  let endTs = -Infinity;
  for (const { tier, first, stop } of spans) {
    fromTs = Math.min(fromTs, tier.columns[first].ts);
    lastTs = Math.max(lastTs, tier.columns[stop - 1].ts);
    endTs = Math.max(endTs, tier.columns[stop - 1].ts + tier.columnMs);
  }
  const marks: number[][] = [];
  for (const band of painter.bands) {
    for (const side of ["bid", "ask"] as const) {
      const list: number[] = [];
      if (fromTs <= lastTs) {
        const segments = painter.runs.runsFor(band.row, side);
        for (let i = firstEndingAfter(segments, fromTs); i < segments.length && segments[i].startTs <= lastTs; i += 1) {
          const segment = segments[i];
          list.push(segment.startTs, segment.endTs > endTs ? Infinity : segment.endTs, FATE_CODE[segment.fate], segment.peak);
        }
      }
      marks.push(list);
    }
  }
  return marks;
}

function sameBands(a: readonly PaintBand[], b: readonly PaintBand[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i].row !== b[i].row || a[i].y0 !== b[i].y0 || a[i].y1 !== b[i].y1) return false;
  return true;
}

function sameMarks(a: readonly number[], b: readonly number[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Sorted, merged ranges. */
function merged(ranges: [number, number][]): [number, number][] {
  ranges.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of ranges) {
    const tail = out[out.length - 1];
    if (tail !== undefined && from <= tail[1]) tail[1] = Math.max(tail[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The settled heat kept between frames: a canvas anchored to time, painted over x [from, to) of its own mapping. */
interface Raster {
  key: string;
  bands: readonly PaintBand[];
  slot: 0 | 1;
  context: CanvasRenderingContext2D;
  /** The view the raster was anchored to; its x is the raster's own. */
  mapping: Mapping;
  /** The x of the canvas's first pixel column, and the pane y of its first row. */
  left: number;
  top: number;
  width: number;
  height: number;
  from: number;
  to: number;
  liveOpen: number;
  /** The columns under the painted stretch, tier by tier, and the colour scale every one of them was painted by. */
  under: LiquidityColumn[][];
  underMs: number[];
  reference: number;
  ladderMax: number;
  /** The run finder the painted runs came from, and those runs, band by band. */
  runs: RunFinder;
  marks: number[][];
  /** Painted under a colour scale that has since moved, while the view moved: painted again once it stands still. */
  stale: boolean;
}

/** The live candle's picture as it was last painted. */
interface LiveImage {
  key: string;
  runs: RunFinder;
  canvas: CanvasImageSource;
}

export class LiquidityHeatRenderer implements IPrimitivePaneRenderer {
  private readonly _host: HeatmapHost;
  private readonly _now: () => number;
  private _raster: Raster | null = null;
  private _live: LiveImage | null = null;
  private _buffer: ImageData | null = null;
  private _view = "";
  private _bands: readonly PaintBand[] = [];
  private _bandsSeen = 0;
  private _movedAt = -Infinity;

  constructor(host: HeatmapHost, now: () => number = () => performance.now()) {
    this._host = host;
    this._now = now;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const host = this._host;
    const layout = host.layout;
    const grid = layout?.grid ?? null;
    if (!layout || !grid || layout.bands.length === 0 || !layout.tiers.some((tier) => tier.to > tier.from) || !(layout.reference > 0)) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      const width = bitmapSize.width;
      const height = bitmapSize.height;
      if (width <= 0 || height <= 0) return;

      // The bands in view, in device pixels, and the vertical span they cover.
      const bands: PaintBand[] = [];
      let minY = height;
      let maxY = 0;
      for (const band of layout.bands) {
        let y0 = Math.round(band.yTop * verticalPixelRatio);
        let y1 = Math.round(band.yBottom * verticalPixelRatio);
        if (y1 <= y0) y1 = y0 + 1;
        y0 = Math.max(0, y0);
        y1 = Math.min(height, y1);
        if (y1 <= y0) continue;
        bands.push({ row: band.row, y0, y1 });
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
      }
      if (bands.length === 0) return;

      const settings = host.settings;
      let dataStart = Infinity;
      for (const tier of layout.tiers) if (tier.scanTo > 0) dataStart = Math.min(dataStart, tier.columns[0].ts);
      const painter: Painter = {
        tiers: layout.tiers,
        bands,
        runs: createRunFinder(grid, layout, settings),
        settings,
        bidRgb: host.bidRgb,
        askRgb: host.askRgb,
        livePx: Math.max(1, Math.round(LIVE_EDGE_MIN_PX * horizontalPixelRatio)),
        connector: Math.max(1, Math.round(CONNECTOR_PX * verticalPixelRatio)),
        cap: Math.max(2, Math.round(CONSUMED_CAP_PX * horizontalPixelRatio)),
        capAlpha: capAlphaOf(settings.maxOpacity),
        dataStart,
      };
      const liveBar = layout.bars[layout.bars.length - 1];
      const liveOpen = liveBar === undefined ? Infinity : liveBar.time;
      const key = JSON.stringify([
        settings, host.bidRgb, host.askRgb, horizontalPixelRatio, verticalPixelRatio, width, height,
        layout.pxPerMs, layout.originMs, liveOpen, layout.lane, layout.rowWidth, layout.clusterRows, layout.intervalMs, layout.gaps,
      ]);
      const now = this._now();
      const view = `${key}|${layout.originX}`;
      const bandsMoved = !sameBands(bands, this._bands);
      if (bandsMoved) {
        this._bands = bands;
        this._bandsSeen += 1;
      }
      if (view !== this._view || bandsMoved) {
        this._view = view;
        this._movedAt = now;
      }

      // The raster stays while it is anchored to this zoom and price axis and
      // still holds what this frame would paint. While the view moves, a pan
      // off the whole pixel is drawn at the nearest one and a colour scale
      // that moved waits; both are painted exactly once the view stands still.
      const still = now - this._movedAt >= SETTLE_MS;
      const settleIn = Math.max(1, Math.ceil(SETTLE_MS - (now - this._movedAt)));
      let raster = this._raster !== null && this._raster.key === key && sameBands(this._raster.bands, bands) ? this._raster : null;
      let shift = 0;
      if (raster !== null) {
        const delta = (layout.originX - raster.mapping.originX) * horizontalPixelRatio;
        shift = Math.round(delta);
        if (Math.abs(delta - shift) > WHOLE_PX) {
          if (still) raster = null;
          else host.scheduleRepaint(settleIn);
        }
      }
      if (raster !== null && !this._holds(raster, painter, still)) raster = null;
      if (raster !== null && raster.stale) host.scheduleRepaint(settleIn);
      if (raster === null) shift = 0;
      const anchor: Mapping = raster?.mapping ?? { originX: layout.originX, originMs: layout.originMs, originChart: chartMsOf(layout.originMs, layout.gaps), gaps: layout.gaps, pxPerMs: layout.pxPerMs, ratio: horizontalPixelRatio, shift: 0 };
      const mapping: Mapping = { ...anchor, shift };

      // The settled part: the pane left of the split, in the raster's own x.
      const split = xAt(anchor, liveOpen) + 1 - painter.cap;
      const needFrom = -shift;
      const needTo = Math.min(width - shift, split);
      if (needTo > needFrom) raster = this._cover(raster, painter, anchor, key, liveOpen, needFrom, needTo, width, minY, maxY - minY, shift);
      this._raster = raster;
      if (raster !== null) {
        const from = Math.max(raster.from, needFrom);
        const to = Math.min(raster.to, needTo);
        if (to > from) context.drawImage(raster.context.canvas, from - raster.left, 0, to - from, raster.height, from + shift, raster.top, to - from, raster.height);
      }

      // The live candle, from the split to the newest column's head, painted
      // again only when the book or the view changed.
      let lastEnd = -Infinity;
      for (const tier of layout.tiers) if (tier.scanTo > 0) lastEnd = Math.max(lastEnd, tier.columns[tier.scanTo - 1].ts + tier.columnMs);
      const liveFrom = raster === null ? 0 : Math.max(0, split + shift);
      const liveTo = Math.min(width, xAt(mapping, lastEnd) + painter.livePx);
      if (liveTo <= liveFrom) return;
      const liveKey = `${key}|${this._bandsSeen}|${anchor.originX}|${liveFrom - shift}|${liveTo - shift}`;
      const kept = this._live;
      if (kept !== null && kept.runs === painter.runs && kept.key === liveKey) {
        const canvas = host.offscreen(liveTo - liveFrom, maxY - minY);
        if (canvas !== null && canvas.canvas === kept.canvas) {
          context.drawImage(canvas.canvas, liveFrom, minY);
          return;
        }
      }
      this._live = null;
      const image = host.imageBuffer(liveTo - liveFrom, maxY - minY);
      if (!image) return;
      paintRegion(painter, mapping, liveFrom, liveTo, minY, maxY, Infinity, image.data);
      const live = host.offscreen(liveTo - liveFrom, maxY - minY);
      if (!live) return;
      live.putImageData(image, 0, 0);
      this._live = { key: liveKey, runs: painter.runs, canvas: live.canvas };
      context.drawImage(live.canvas, liveFrom, minY);
    });
  }

  /**
   * Whether the raster still holds what this frame would paint there: the
   * same colour scale for every column under it, and the same columns and
   * runs, except where columns or a band's runs changed, which are painted
   * again here. A colour scale that moved while the view moves leaves the
   * raster stale until the view stands still.
   */
  private _holds(raster: Raster, painter: Painter, still: boolean): boolean {
    if (this._host.raster(raster.slot, raster.width, raster.height) !== raster.context) return false;
    if (raster.stale) return !still;
    const spans = columnSpans(painter, raster.mapping, raster.from, raster.to, raster.liveOpen);
    const changed = changedStretches(raster.under, raster.underMs, painter, spans);
    if (changed === null) return false;
    const runs = painter.runs;
    if (runs.saturation.reference !== raster.reference || runs.saturation.ladderMax !== raster.ladderMax) {
      const before: SaturationContext = { ...runs.saturation, reference: raster.reference, ladderMax: raster.ladderMax };
      if (!sameScale(runs.style, spans, before, runs.saturation)) {
        if (still) return false;
        raster.stale = true;
        return true;
      }
      raster.reference = runs.saturation.reference;
      raster.ladderMax = runs.saturation.ladderMax;
    }
    if (changed.length > 0) {
      const reach = Math.max(painter.livePx, painter.cap) + 1;
      const strips = merged(changed.map(([from, to]) => [xAt(raster.mapping, from) - reach, xAt(raster.mapping, to) + reach]));
      for (const [from, to] of strips) this._paint(raster, painter, Math.max(raster.from, from), Math.min(raster.to, to), raster.top, raster.top + raster.height);
      raster.under = columnsUnder(painter, spans);
    }
    if (runs !== raster.runs) {
      const marks = marksOf(painter, spans);
      const rows: [number, number][] = [];
      const bottom = raster.top + raster.height;
      for (let i = 0; i < marks.length; i += 1) {
        if (sameMarks(marks[i], raster.marks[i])) continue;
        const band = painter.bands[i >> 1];
        rows.push([Math.max(raster.top, band.y0 - painter.connector), Math.min(bottom, band.y1 + painter.connector)]);
      }
      for (const [y0, y1] of merged(rows)) this._paint(raster, painter, raster.from, raster.to, y0, y1);
      raster.marks = marks;
      raster.runs = runs;
    }
    return true;
  }

  /** Paint x [x0, x1) and pane y [y0, y1) of the raster afresh. */
  private _paint(raster: Raster, painter: Painter, x0: number, x1: number, y0: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    const image = this._bufferFor(raster.context, x1 - x0, y1 - y0);
    paintRegion(painter, raster.mapping, x0, x1, y0, y1, raster.liveOpen, image.data);
    raster.context.putImageData(image, x0 - raster.left, y0 - raster.top);
  }

  /** A cleared buffer of the size asked; a large one is kept for the next region of the same size. */
  private _bufferFor(context: CanvasRenderingContext2D, width: number, height: number): ImageData {
    const kept = this._buffer;
    if (kept !== null && kept.width === width && kept.height === height) {
      kept.data.fill(0);
      return kept;
    }
    const image = context.createImageData(width, height);
    if (width * height >= KEPT_BUFFER_PX) this._buffer = image;
    return image;
  }

  /**
   * The raster, made, or moved onto the other canvas when the view outran it,
   * and painted where it lacks the stretch [needFrom, needTo) of its own x.
   */
  private _cover(
    current: Raster | null,
    painter: Painter,
    anchor: Mapping,
    key: string,
    liveOpen: number,
    needFrom: number,
    needTo: number,
    paneWidth: number,
    top: number,
    height: number,
    shift: number,
  ): Raster | null {
    const host = this._host;
    const width = Math.max(needTo - needFrom, Math.min(RASTER_MAX_PX, paneWidth + 2 * Math.round(paneWidth * RASTER_SPARE_VIEWS)));
    const left = Math.min(needFrom, Math.max(needTo - width, -shift - Math.floor((width - paneWidth) / 2)));
    let raster = current;
    let moved = false;
    if (raster === null) {
      const slot = this._raster?.slot ?? 0;
      const context = host.raster(slot, width, height);
      if (context === null) return null;
      // The other canvas only ever receives a raster that outran its own; until then it holds nothing worth its memory.
      host.raster(slot === 0 ? 1 : 0, 0, 0);
      raster = {
        key, bands: painter.bands, slot, context, mapping: anchor, left, top, width, height, from: needFrom, to: needFrom, liveOpen,
        under: [], underMs: [], reference: painter.runs.saturation.reference, ladderMax: painter.runs.saturation.ladderMax,
        runs: painter.runs, marks: [], stale: false,
      };
    } else if (needFrom < raster.left || needTo > raster.left + raster.width) {
      const slot = raster.slot === 0 ? 1 : 0;
      const context = host.raster(slot, width, height);
      if (context === null) return null;
      const keepFrom = Math.max(raster.from, left);
      const keepTo = Math.min(raster.to, left + width);
      if (keepTo > keepFrom) {
        context.clearRect(keepFrom - left, 0, keepTo - keepFrom, height);
        context.drawImage(raster.context.canvas, keepFrom - raster.left, 0, keepTo - keepFrom, height, keepFrom - left, 0, keepTo - keepFrom, height);
      }
      raster = { ...raster, slot, context, left, width, from: keepTo > keepFrom ? keepFrom : needFrom, to: keepTo > keepFrom ? keepTo : needFrom };
      moved = true;
    }
    if (raster.to <= raster.from || needTo < raster.from || needFrom > raster.to) {
      this._paint(raster, painter, needFrom, needTo, top, top + height);
      raster.from = needFrom;
      raster.to = needTo;
    } else if (needFrom < raster.from || needTo > raster.to) {
      if (needFrom < raster.from) {
        this._paint(raster, painter, needFrom, raster.from, top, top + height);
        raster.from = needFrom;
      }
      if (needTo > raster.to) {
        this._paint(raster, painter, raster.to, needTo, top, top + height);
        raster.to = needTo;
      }
    } else if (!moved) {
      return raster;
    }

    // What the raster now holds.
    const spans = columnSpans(painter, raster.mapping, raster.from, raster.to, liveOpen);
    raster.under = columnsUnder(painter, spans);
    raster.underMs = painter.tiers.map((tier) => tier.columnMs);
    raster.reference = painter.runs.saturation.reference;
    raster.ladderMax = painter.runs.saturation.ladderMax;
    raster.marks = marksOf(painter, spans);
    raster.runs = painter.runs;
    return raster;
  }
}
