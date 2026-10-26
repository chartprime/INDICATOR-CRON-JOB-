// The geometry of one frame of the heatmap: where the grid's columns and rows
// land on the pane, which columns are in view, the bands the rows are grouped
// into at the current cluster size, the candles the run model needs, and the
// ladder rows beside the axis. Computed once per chart update by the primitive
// and read by the renderers and the hover; nothing here paints.

import type { IChartApiBase, ISeriesApi, Logical, SeriesType, Time } from "lightweight-charts";
import type { ChartRowsProvider } from "../../chart/chartData";
import { barGaps, chartMsOf, wallMsOf, type TimeGap } from "./chartTime";
import { FoldedCells, cellMsFor, foldColumns, runClocksFor } from "./liquidityCells";
import { HISTORY_WINDOW_MS, foldHistoryRows, type LaneFold } from "./heatmapHistoryDecode";
import type { HistoryReach, HistoryStatus, HistoryWant } from "./heatmapHistory";
import { liquidityIndexAtOrAfter, type HeatGrid, type LiquidityColumn } from "./liquidityGrid";
import { MAX_LANE, chooseLane, laneCandidates, laneHeatGrid, type HeatLanes, type LiquidityLaneChoice } from "./liquidityLanes";
import type { OhlcBar, RunClocks, RunTier } from "./liquidityRuns";
import { clusterIndex, clusterRowsFor, historyDaysOf, historyReachFor, liquidityReference, type LiquidityHistoryDays, type LiquiditySettings } from "./liquiditySettings";
import { laneFoldFor, liquidityStyleFor } from "./liquidityStyle";

export const COARSE_FROM_MS = 4 * 3_600_000;

const DEFAULT_BAR_INTERVAL_SEC = 60;
export const MAX_VISIBLE_ROWS = 4096;
const INTERVAL_SAMPLE_BARS = 8;
/** Media px kept between the last candle and whatever sits in the free margin. */
const FREE_RIGHT_GAP_PX = 4;

/** A server row, or a band of rows, and where it sits on the pane (media px). */
export interface RowBand {
  row: number; // the row index, or the band index when this is a band
  yTop: number;
  yBottom: number;
}

/** One tier of columns to paint: a time-ordered list of one column width, with the visible range inside it. */
export interface HeatTier extends RunTier {
  from: number; // first visible column
  to: number; // one past the last visible column
}

/** One entry of the size ladder beside the axis: the latest size of one side of one band. */
export interface LadderRow {
  yTop: number; // media px
  yBottom: number;
  side: "bid" | "ask";
  size: number;
}

export interface HeatHistorySource {
  reach(want: HistoryWant): HistoryReach;
  status(levelMs: number, rowFactor: number): HistoryStatus;
}

export interface HeatmapHistoryInfo {
  levelMs: number;
  rowFactor: number;
  days: LiquidityHistoryDays;
  loading: boolean;
  reachTs: number | null;
  drawn: boolean;
  refused: "GEOMETRY" | null;
  unavailable: string | null;
}

export interface HeatmapLayout {
  grid: HeatGrid;
  lane: number;
  history: HeatmapHistoryInfo | null;
  historyWant: HistoryWant | null;
  originX: number; // media x of `originMs`
  originMs: number; // the open of the last candle
  pxPerMs: number;
  rowWidth: number;
  clusterRows: number;
  bands: RowBand[]; // the bands in view, in price order (row = band index)
  tiers: HeatTier[]; // the deep tier up to where the fine one begins, then the fine tier; always all of them, so runs are tracked over what is out of view too
  bars: OhlcBar[]; // the candles over the retained span: the run model asks them where price printed
  gaps: readonly TimeGap[]; // the holes in the chart's bars (session breaks): time is laid out past them
  intervalMs: number; // one candle
  cellMs: number;
  clocks: RunClocks;
  reference: number; // the live colour reference (or the fixed scale size): the yardstick for columns that carry none of their own
  ladder: LadderRow[];
  ladderMax: number; // largest ladder size in view: the crypto colour scale
  freeRight: number; // media px between the last candle's right edge and the pane edge (0 when candles reach the axis)
}

/** The layout for this chart state, or null while there is nothing to draw. */
export function computeHeatmapLayout(
  chart: IChartApiBase<Time>,
  series: ISeriesApi<SeriesType, Time>,
  grid: HeatGrid,
  settings: LiquiditySettings,
  chartRows: ReturnType<ChartRowsProvider> | null = null,
  lanes: HeatLanes | null = null,
  laneChoice: LiquidityLaneChoice = "auto",
  history: HeatHistorySource | null = null,
): HeatmapLayout | null {
  if (grid.columns.length === 0 || !(grid.rowWidth > 0)) return null;
  const bars = chartRows ?? series.data();
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const lastSec = Number(last.time);
  if (!Number.isFinite(lastSec)) return null;
  // The bar: the shortest step among the last few bars, so a session break just behind the live bar does not pass for one.
  let intervalSec = Infinity;
  for (let i = bars.length - 1; i > 0 && i > bars.length - 1 - INTERVAL_SAMPLE_BARS; i -= 1) {
    const step = Number(bars[i].time) - Number(bars[i - 1].time);
    if (Number.isFinite(step) && step > 0 && step < intervalSec) intervalSec = step;
  }
  if (!Number.isFinite(intervalSec)) intervalSec = DEFAULT_BAR_INTERVAL_SEC;
  const timeScale = chart.timeScale();
  const lastIndex = timeScale.timeToIndex(last.time, false);
  if (lastIndex === null) return null;
  // TimePointIndex and Logical are the same integer under different brands.
  const xCenter = timeScale.logicalToCoordinate(lastIndex as unknown as Logical);
  if (xCenter === null) return null;
  const barSpacing = timeScale.options().barSpacing;
  if (!(barSpacing > 0)) return null;
  const pxPerMs = barSpacing / (intervalSec * 1000);
  // A bar is centred on its index and spans one interval from its open time.
  const originX = xCenter - barSpacing / 2;
  const originMs = lastSec * 1000;
  const width = timeScale.width();
  const intervalMs = intervalSec * 1000;
  const gaps = gapsOf(bars, intervalMs);
  const originChart = chartMsOf(originMs, gaps);
  const msAt = (x: number) => wallMsOf(originChart + (x - originX) / pxPerMs, gaps);

  const cellMs = cellMsFor(intervalMs);
  const height = chart.paneSize().height;
  if (!(height > 0)) return null;
  const priceTop = series.coordinateToPrice(0);
  const priceBottom = series.coordinateToPrice(height);
  if (priceTop === null || priceBottom === null) return null;
  const coarse = intervalMs >= COARSE_FROM_MS && grid.coarseColumns.length > 0;
  const lane = coarse ? 0 : chooseLane(laneCandidates(grid, lanes), Number(priceBottom), Number(priceTop), MAX_VISIBLE_ROWS, laneChoice);
  const laneGrid = lane === 0 ? null : lanes?.grid(lane) ?? null;
  const drawn: HeatGrid = laneGrid === null ? grid : laneHeatGrid(laneGrid, grid, lane);
  const rowWidth = coarse ? grid.coarseRowWidth : drawn.rowWidth;
  const leftMs = msAt(0);
  const rightMs = msAt(width);
  const liveTiers = coarse ? foldedTiers(grid, cellMs, "coarse", leftMs, rightMs) : cellMs > 0 ? foldedTiers(drawn, cellMs, "fine", leftMs, rightMs) : visibleTiers(drawn, leftMs, rightMs);
  const past = coarse ? null : historyTier(history, grid, drawn, lane, cellMs, leftMs, rightMs, liveTiers, settings);
  const tiers = past === null || past.tier === null ? liveTiers : [past.tier, ...liveTiers];
  const ohlc = retainedBars(bars, intervalMs, Math.min(...tiers.map((tier) => tier.columns[0].ts)));

  const rows = visibleRows(series, rowWidth, Number(priceTop), Number(priceBottom));
  // The settings belong to the market on screen (MainPanel keeps one set per style), so this is its own cluster size.
  const fineClusterRows = clusterRowsFor(settings, intervalMs);
  const sameRows = rowWidth === grid.rowWidth;
  const clusterRows = sameRows ? fineClusterRows : Math.max(1, Math.round((fineClusterRows * grid.rowWidth) / rowWidth));
  const bands = bandsOf(rows, clusterRows);
  // The axis bands the price range directly on lane 0's rows: the heat's row cap sends a tall view to a wider lane, the ladder stays.
  const ladderBands = sameRows && bands.length > 0 ? bands : ladderBandsOf(series, grid.rowWidth, fineClusterRows, Number(priceTop), Number(priceBottom));
  const { ladder, ladderMax } = ladderOf(grid, ladderBands, fineClusterRows, lanes, series);

  return {
    grid: drawn,
    lane,
    history: past?.info ?? null,
    historyWant: past?.want ?? null,
    originX,
    originMs,
    pxPerMs,
    rowWidth,
    clusterRows,
    bands,
    tiers,
    bars: ohlc,
    gaps,
    intervalMs,
    cellMs,
    clocks: runClocksFor(intervalMs),
    // A fixed size is per row of the finest lane: on a market that sums rows a wider row holds that many of them; on one read by the biggest tick it is the same quantity.
    reference: liquidityReference(settings, laneGrid === null ? grid : drawn, laneGrid === null || laneFoldFor(grid.provider, grid.symbol, grid.marketKind) === "max" ? 1 : 2 ** lane),
    ladder,
    ladderMax,
    freeRight: Math.max(0, width - (originX + barSpacing) - FREE_RIGHT_GAP_PX),
  };
}

const gapsByBars = new WeakMap<readonly { time: unknown }[], { length: number; last: unknown; intervalMs: number; gaps: TimeGap[] }>();

function gapsOf(bars: readonly { time: unknown }[], intervalMs: number): readonly TimeGap[] {
  const last = bars[bars.length - 1]?.time;
  const cached = gapsByBars.get(bars);
  if (cached !== undefined && cached.length === bars.length && cached.last === last && cached.intervalMs === intervalMs) return cached.gaps;
  const gaps = barGaps(bars, intervalMs);
  gapsByBars.set(bars, { length: bars.length, last, intervalMs, gaps });
  return gaps;
}

const foldedByGrid = new WeakMap<HeatGrid, FoldedCells>();
const foldedHistory = new WeakMap<readonly LiquidityColumn[], { cellMs: number; cells: LiquidityColumn[] }>();
const lanedHistory = new WeakMap<readonly LiquidityColumn[], { factor: number; rowWidth: number; fold: LaneFold; columns: LiquidityColumn[] }>();
const fillerHistory = new WeakMap<readonly LiquidityColumn[], { key: string; columns: readonly LiquidityColumn[] }>();

function edgesOf(columns: readonly LiquidityColumn[]): string {
  return `${columns.length}:${columns.length > 0 ? columns[0].ts : ""}:${columns.length > 0 ? columns[columns.length - 1].ts : ""}`;
}

/**
 * The host's columns where the lane on screen has none of its own: behind its
 * oldest column and in every hole between, so the lanes draw the same past
 * whatever each one restored. A column is covered when one of the lane's own
 * columns falls in its slot of `columnMs`, the slot aligned when the chart
 * folds columns into cells. The same array comes back while the choice has
 * not changed, so the kept scan and the raster stand.
 */
function fillHoles(columns: readonly LiquidityColumn[], own: readonly (readonly LiquidityColumn[])[], liveEdge: number, columnMs: number, aligned: boolean): readonly LiquidityColumn[] {
  const key = `${columnMs}:${aligned}:${liveEdge}|${own.map(edgesOf).join("|")}`;
  const cached = fillerHistory.get(columns);
  if (cached !== undefined && cached.key === key) return cached.columns;
  const out: LiquidityColumn[] = [];
  for (const column of columns) {
    if (column.ts >= liveEdge) break;
    const start = aligned ? Math.floor(column.ts / columnMs) * columnMs : column.ts;
    const covered = own.some((list) => {
      const index = liquidityIndexAtOrAfter(list, start);
      return index < list.length && list[index].ts < start + columnMs;
    });
    if (!covered) out.push(column);
  }
  const same = cached !== undefined && cached.columns.length === out.length && out.every((column, i) => cached.columns[i] === column);
  const result = same ? cached.columns : out;
  fillerHistory.set(columns, { key, columns: result });
  return result;
}

function laneHistory(columns: readonly LiquidityColumn[], factor: number, laneRowWidth: number, levelMs: number, fold: LaneFold): readonly LiquidityColumn[] {
  if (factor === 1) return columns;
  const cached = lanedHistory.get(columns);
  if (cached !== undefined && cached.factor === factor && cached.fold === fold && sameRowWidth(cached.rowWidth, laneRowWidth)) return cached.columns;
  const folded = foldHistoryRows(columns, factor, laneRowWidth, levelMs, fold);
  lanedHistory.set(columns, { factor, rowWidth: laneRowWidth, fold, columns: folded });
  return folded;
}

function sameRowWidth(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

function foldHistory(columns: readonly LiquidityColumn[], cellMs: number): LiquidityColumn[] {
  const cached = foldedHistory.get(columns);
  if (cached !== undefined && cached.cellMs === cellMs) return cached.cells;
  const cells = foldColumns(columns, cellMs);
  foldedHistory.set(columns, { cellMs, cells });
  return cells;
}

function historyTier(
  history: HeatHistorySource | null,
  base: HeatGrid,
  drawn: HeatGrid,
  lane: number,
  cellMs: number,
  leftMs: number,
  rightMs: number,
  live: readonly HeatTier[],
  settings: LiquiditySettings,
): { tier: HeatTier | null; want: HistoryWant; info: HeatmapHistoryInfo } | null {
  if (history === null) return null;
  const oldestLive = Math.min(...live.map((tier) => (tier.columns.length > 0 ? tier.columns[0].ts : Infinity)));
  if (!Number.isFinite(oldestLive)) return null;
  // Up to the end of the five-minute window holding the live edge: the ask moves once a window, not once a column, so what the store hands back keeps its identity.
  const liveEdge = Math.max(...live.map((tier) => (tier.columns.length > 0 ? tier.columns[tier.columns.length - 1].ts + tier.columnMs : -Infinity)));
  const askedTo = Math.floor((liveEdge - 1) / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS + HISTORY_WINDOW_MS;
  const days = historyDaysOf(settings);
  const { levelMs, reachMs } = historyReachFor(days);
  const rowFactor = 1;
  const laneFactor = 2 ** lane;
  const want: HistoryWant = { levelMs, rowFactor, fromTs: oldestLive - reachMs, toTs: askedTo, beforeTs: askedTo };
  const reach = history.reach(want);
  const status = history.status(levelMs, rowFactor);
  const info: HeatmapHistoryInfo = { levelMs, rowFactor, days, loading: reach.loading, reachTs: null, drawn: false, refused: null, unavailable: status.unavailable };
  const shown = reach.shown;
  if (shown === null || reach.columns.length === 0) return { tier: null, want, info };
  const shownStatus = history.status(shown.levelMs, shown.rowFactor);
  if (shownStatus.rowWidth === null) return { tier: null, want, info };
  if (!sameRowWidth(shownStatus.rowWidth, base.rowWidth) || !sameRowWidth(shownStatus.rowWidth * laneFactor, drawn.rowWidth)) return { tier: null, want, info: { ...info, refused: "GEOMETRY" } };
  const laned = laneHistory(reach.columns, laneFactor, drawn.rowWidth, shown.levelMs, laneFoldFor(base.provider, base.symbol, base.marketKind));
  const columnMs = Math.max(cellMs, shown.levelMs);
  const filler = fillHoles(laned, [drawn.deepColumns, drawn.columns], liveEdge, columnMs, cellMs > shown.levelMs);
  const columns = cellMs > shown.levelMs ? foldHistory(filler, cellMs) : filler;
  if (columns.length === 0) return { tier: null, want, info: { ...info, reachTs: shownStatus.reachTs, drawn: true } };
  const from = liquidityIndexAtOrAfter(columns, leftMs - columnMs);
  const to = liquidityIndexAtOrAfter(columns, rightMs);
  return { tier: { columns, columnMs, from, to: Math.max(from, to), scanTo: columns.length }, want, info: { ...info, reachTs: shownStatus.reachTs, drawn: true } };
}

function foldedTiers(grid: HeatGrid, cellMs: number, source: "fine" | "coarse", leftMs: number, rightMs: number): HeatTier[] {
  let folded = foldedByGrid.get(grid);
  if (folded === undefined) {
    folded = new FoldedCells();
    foldedByGrid.set(grid, folded);
  }
  const columns = folded.update(source === "coarse" ? { columns: grid.coarseColumns, deepColumns: [], epoch: grid.epoch } : grid, cellMs, source);
  const from = liquidityIndexAtOrAfter(columns, leftMs - cellMs);
  const to = liquidityIndexAtOrAfter(columns, rightMs);
  return [{ columns, columnMs: cellMs, from, to: Math.max(from, to), scanTo: columns.length }];
}

/**
 * What to paint: the deep tier up to where the fine tier begins, then the fine
 * tier. The deep tier is always present, with an empty visible range when
 * none of it is on screen, so runs are tracked over it either way.
 */
function visibleTiers(grid: HeatGrid, leftMs: number, rightMs: number): HeatTier[] {
  const tiers: HeatTier[] = [];
  if (grid.deepColumns.length > 0) {
    const fineStart = grid.columns[0].ts;
    const deepFrom = grid.deepIndexAtOrAfter(leftMs - grid.deepColumnMs);
    const deepTo = Math.min(grid.deepIndexAtOrAfter(rightMs), grid.deepIndexAtOrAfter(fineStart));
    tiers.push({ columns: grid.deepColumns, columnMs: grid.deepColumnMs, from: deepFrom, to: Math.max(deepFrom, deepTo), scanTo: grid.deepIndexAtOrAfter(fineStart) });
  }
  const from = grid.indexAtOrAfter(leftMs - grid.columnMs);
  const to = grid.indexAtOrAfter(rightMs);
  tiers.push({ columns: grid.columns, columnMs: grid.columnMs, from, to: Math.max(from, to), scanTo: grid.columns.length });
  return tiers;
}

/**
 * The candles over everything retained, oldest first, as plain numbers in ms:
 * a run can begin long before the visible range, and a candle back then still
 * says whether price printed at the band.
 */
function retainedBars(bars: readonly { time: unknown }[], intervalMs: number, earliestTs: number): OhlcBar[] {
  const ohlc: OhlcBar[] = [];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i] as { time: unknown; high?: unknown; low?: unknown; close?: unknown };
    const timeMs = Number(bar.time) * 1000;
    if (!Number.isFinite(timeMs) || timeMs + intervalMs <= earliestTs) break;
    if (typeof bar.high !== "number" || typeof bar.low !== "number" || typeof bar.close !== "number") continue;
    ohlc.push({ time: timeMs, high: bar.high, low: bar.low, close: bar.close });
  }
  ohlc.reverse();
  return ohlc;
}

/** Every server row between the pane's top and bottom price, with its pixel edges; none when the view is absurdly tall. */
function visibleRows(series: ISeriesApi<SeriesType, Time>, rowWidth: number, priceTop: number, priceBottom: number): RowBand[] {
  const rowHi = Math.floor(priceTop / rowWidth);
  const rowLo = Math.max(0, Math.floor(priceBottom / rowWidth));
  const rows: RowBand[] = [];
  if (rowHi < rowLo || rowHi - rowLo + 1 > MAX_VISIBLE_ROWS) return rows;
  for (let row = rowLo; row <= rowHi; row += 1) {
    const yTop = series.priceToCoordinate((row + 1) * rowWidth);
    const yBottom = series.priceToCoordinate(row * rowWidth);
    if (yTop === null || yBottom === null) continue;
    rows.push({ row, yTop, yBottom });
  }
  return rows;
}

/** The bands between the pane's top and bottom price on `rowWidth` rows, their edges cut to the rows in view, however many rows that is; none when the view is absurdly tall. */
function ladderBandsOf(series: ISeriesApi<SeriesType, Time>, rowWidth: number, clusterRows: number, priceTop: number, priceBottom: number): RowBand[] {
  const rowHi = Math.floor(priceTop / rowWidth);
  const rowLo = Math.max(0, Math.floor(priceBottom / rowWidth));
  const first = clusterIndex(rowLo, clusterRows);
  const last = clusterIndex(rowHi, clusterRows);
  const bands: RowBand[] = [];
  if (last < first || last - first + 1 > MAX_VISIBLE_ROWS) return bands;
  const rows = Math.max(1, Math.floor(clusterRows));
  for (let band = first; band <= last; band += 1) {
    const yTop = series.priceToCoordinate(Math.min((band + 1) * rows, rowHi + 1) * rowWidth);
    const yBottom = series.priceToCoordinate(Math.max(band * rows, rowLo) * rowWidth);
    if (yTop === null || yBottom === null) continue;
    bands.push({ row: band, yTop, yBottom });
  }
  return bands;
}

/** Rows grouped into bands of `clusterRows`, aligned to the absolute row index so a band never moves as the view scrolls or zooms. */
function bandsOf(rows: readonly RowBand[], clusterRows: number): RowBand[] {
  const bands: RowBand[] = [];
  let current: RowBand | null = null;
  for (const band of rows) {
    const index = clusterIndex(band.row, clusterRows);
    if (current && current.row === index) {
      current.yTop = Math.min(current.yTop, band.yTop);
      current.yBottom = Math.max(current.yBottom, band.yBottom);
    } else {
      current = { row: index, yTop: band.yTop, yBottom: band.yBottom };
      bands.push(current);
    }
  }
  return bands;
}

/**
 * The ladder: one entry per band of the latest column, the very bands the
 * heat draws, never merged, so a bar sits exactly where its level is. The
 * ladder is the whole book like a DOM, unfiltered: the trader's minimum size
 * hides levels on the chart, not on the axis. A band holding both sides (the
 * spread sits inside it) gets two entries, bid below and ask above. A band's
 * size is read the way its market reads it (summed rows on crypto, the biggest
 * row on indexes). Past the finest column's window the book goes on in the
 * wider lanes' live columns, so a band outside it reads the finest lane that
 * holds it: by the band when the band is whole lane rows, else by the lane's
 * rows, each once.
 */
function ladderOf(grid: HeatGrid, bands: readonly RowBand[], clusterRows: number, lanes: HeatLanes | null, series: ISeriesApi<SeriesType, Time>): { ladder: LadderRow[]; ladderMax: number } {
  const ladder: LadderRow[] = [];
  let ladderMax = 0;
  const latest = grid.latest;
  if (!latest) return { ladder, ladderMax };
  const style = liquidityStyleFor(grid.provider, grid.symbol, grid.marketKind);
  const rows = Math.max(1, Math.floor(clusterRows));
  const wider = widerLanes(grid, lanes);
  const yMin = Math.min(...bands.map((band) => band.yTop));
  const yMax = Math.max(...bands.map((band) => band.yBottom));
  const seen = new Set<string>();
  const push = (yTop: number, yBottom: number, bid: number, ask: number) => {
    const hasBid = bid > 0;
    const hasAsk = ask > 0;
    if (!hasBid && !hasAsk) return;
    if (hasBid && hasAsk) {
      const mid = (yTop + yBottom) / 2;
      ladder.push({ yTop: mid, yBottom, side: "bid", size: bid });
      ladder.push({ yTop, yBottom: mid, side: "ask", size: ask });
      return;
    }
    ladder.push({ yTop, yBottom, side: hasBid ? "bid" : "ask", size: hasBid ? bid : ask });
  };
  for (const band of bands) {
    const first = band.row * rows;
    const last = first + rows - 1;
    if (last >= latest.lo && first <= latest.hi) {
      const { bid, ask } = style.bandSizes(latest, band.row, rows);
      push(band.yTop, band.yBottom, bid, ask);
      continue;
    }
    const lane = wider.find((entry) => Math.floor(last / entry.factor) >= entry.latest.lo && Math.floor(first / entry.factor) <= entry.latest.hi);
    if (lane === undefined) continue;
    if (rows % lane.factor === 0) {
      const { bid, ask } = style.bandSizes(lane.latest, band.row, rows / lane.factor);
      push(band.yTop, band.yBottom, bid, ask);
      continue;
    }
    for (let row = Math.floor(first / lane.factor); row <= Math.floor(last / lane.factor); row += 1) {
      const key = `${lane.factor}:${row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const yTop = series.priceToCoordinate((row + 1) * lane.rowWidth);
      const yBottom = series.priceToCoordinate(row * lane.rowWidth);
      if (yTop === null || yBottom === null) continue;
      const { bid, ask } = style.bandSizes(lane.latest, row, 1);
      push(Math.max(yMin, yTop), Math.min(yMax, yBottom), bid, ask);
    }
  }
  for (const row of ladder) if (row.size > ladderMax) ladderMax = row.size;
  return { ladder, ladderMax };
}

export interface WiderLane {
  factor: number;
  rowWidth: number;
  latest: LiquidityColumn;
}

/** The wider lanes' live columns, finest first, each with its rows per finest row. */
export function widerLanes(grid: Pick<HeatGrid, "rowWidth">, lanes: HeatLanes | null): WiderLane[] {
  const out: WiderLane[] = [];
  if (lanes === null) return out;
  for (let lane = 1; lane <= MAX_LANE; lane += 1) {
    const laneGrid = lanes.grid(lane);
    const latest = laneGrid?.latest ?? null;
    if (laneGrid === null || latest === null) continue;
    const factor = Math.round(laneGrid.rowWidth / grid.rowWidth);
    if (factor < 2 || Math.abs(laneGrid.rowWidth - factor * grid.rowWidth) > 1e-9 * grid.rowWidth) continue;
    out.push({ factor, rowWidth: laneGrid.rowWidth, latest });
  }
  return out;
}
