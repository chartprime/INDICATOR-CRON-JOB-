import { describe, expect, it } from "vitest";
import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid } from "../liquidityGrid";
import { COARSE_FROM_MS, computeHeatmapLayout, type HeatHistorySource } from "../liquidityHeatmapLayout";
import type { HistoryWant } from "../heatmapHistory";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../liquiditySettings";
import { runClocksFor } from "../liquidityCells";

const T = 1_700_000_000_000;
const ROW_WIDTH = 2;
const BAR_SEC = 60;
const BAR_SPACING = 6; // px per bar, so 0.1 px per second
const PANE_HEIGHT = 400;
const PANE_WIDTH = 600;
const TOP_PRICE = 212; // price at y = 0; 20 px to the price unit
const PX_PER_PRICE = 20;

/** One reset frame carrying `columns` seconds of a five-row window (rows 100..104, prices 200..210). */
function gridWith(columns: LiquidityFrame["columns"]): LiquidityGrid {
  const grid = new LiquidityGrid();
  grid.apply({
    type: "liquidity",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    ts: T,
    seq: columns.length,
    reset: true,
    row_width: ROW_WIDTH,
    column_ms: 1000,
    columns,
  } as LiquidityFrame);
  return grid;
}

const column = (second: number, bid: [number, number][], ask: [number, number][]) => ({ ts: T + second * 1000, lo: 100, hi: 104, bid, ask });

/** A chart showing three candles, one minute each unless told otherwise, the last of them opening at T. */
function fakeChart(barSec = BAR_SEC) {
  const chart = {
    timeScale: () => ({
      timeToIndex: () => 2,
      logicalToCoordinate: () => 500, // centre of the last bar
      options: () => ({ barSpacing: BAR_SPACING }),
      width: () => PANE_WIDTH,
    }),
    paneSize: () => ({ height: PANE_HEIGHT, width: PANE_WIDTH }),
  } as unknown as IChartApiBase<Time>;
  const series = {
    data: () => [0, 1, 2].map((i) => ({ time: T / 1000 - (2 - i) * barSec, high: 206, low: 202, close: 204 })),
    coordinateToPrice: (y: number) => TOP_PRICE - y / PX_PER_PRICE,
    priceToCoordinate: (price: number) => (TOP_PRICE - price) * PX_PER_PRICE,
  } as unknown as ISeriesApi<SeriesType, Time>;
  return { chart, series };
}

/** The same chart with a hole in its bars: a two-hour gap before the last candle, the chart drawing them side by side. */
function fakeChartWithGap() {
  const { chart, series } = fakeChart();
  const data = () => [T / 1000 - 7260, T / 1000 - 7200, T / 1000].map((time) => ({ time, high: 206, low: 202, close: 204 }));
  return { chart, series: { ...series, data } as unknown as ISeriesApi<SeriesType, Time> };
}

function layoutOf(grid: LiquidityGrid, patch: Partial<LiquiditySettings> = {}, barSec = BAR_SEC) {
  const { chart, series } = fakeChart(barSec);
  return computeHeatmapLayout(chart, series, grid, { ...DEFAULT_LIQUIDITY_SETTINGS, ...patch });
}

describe("computeHeatmapLayout", () => {
  it("has nothing to draw without columns or geometry", () => {
    expect(layoutOf(new LiquidityGrid())).toBeNull();
  });

  it("places time from the last candle: its open sits half a bar left of its centre", () => {
    const layout = layoutOf(gridWith([column(0, [[0, 3]], [])]));
    expect(layout).not.toBeNull();
    expect(layout?.originMs).toBe(T);
    expect(layout?.originX).toBe(500 - BAR_SPACING / 2);
    expect(layout?.pxPerMs).toBeCloseTo(BAR_SPACING / (BAR_SEC * 1000));
    expect(layout?.intervalMs).toBe(BAR_SEC * 1000);
    // Only candles the columns reach into are kept: here the grid holds one second, so one candle.
    expect(layout?.bars).toHaveLength(1);
  });

  it("widens the bands with the chart's bar: the trader's cluster on a minute chart, three times it on 15m, so the ladder and the heat band the same rows", () => {
    const grid = gridWith([column(0, [[0, 3], [1, 5], [2, 4]], [])]);
    expect(layoutOf(grid, { clusterRows: 2 })?.clusterRows).toBe(2);
    const slow = layoutOf(grid, { clusterRows: 2 }, 15 * 60);
    expect(slow?.intervalMs).toBe(15 * 60_000);
    expect(slow?.clusterRows).toBe(6);
    // Rows 100..104 at six a band fall in two bands, rows 96..101 and 102..107: the ladder sums each.
    expect(slow?.ladder.map((row) => [row.side, row.size])).toEqual([["bid", 8], ["bid", 4]]);
    expect(layoutOf(grid, { clusterRows: 2 })?.ladder.map((row) => row.size)).toEqual([8, 4]);
  });

  it("knows the holes in the chart's bars, and reads the pane's edges in wall time through them: a column before a session break lies two bars left of the one after it, the break's own slot between", () => {
    const grid = gridWith([column(-7200, [[0, 3]], []), column(0, [[0, 3]], [])]);
    const { chart, series } = fakeChartWithGap();
    const layout = computeHeatmapLayout(chart, series, grid, DEFAULT_LIQUIDITY_SETTINGS);
    expect(layout?.gaps).toEqual([{ start: T - 7_080_000, end: T }]);
    // The pane is 600 px at 0.1 px a second: without the hole its left edge would be 4,970 s before T; with it, the hole's 7,080 s further.
    expect(layout?.tiers[0].from).toBe(0);
    const plain = layoutOf(gridWith([column(-7200, [[0, 3]], []), column(0, [[0, 3]], [])]));
    expect(plain?.gaps).toEqual([]);
    expect(plain?.tiers[0].from).toBe(1);
    expect(layoutOf(gridWith([column(0, [[0, 3]], [])]))?.gaps).toEqual([]);
  });

  it("keeps every candle the retained columns reach into, oldest first", () => {
    const layout = layoutOf(gridWith([column(-90, [[0, 3]], []), column(0, [[0, 3]], [])]));
    expect(layout?.bars.map((bar) => bar.time)).toEqual([T - 120_000, T - 60_000, T]);
  });

  it("groups the visible rows into bands aligned to the absolute row index, so a band never moves", () => {
    const layout = layoutOf(gridWith([column(0, [[0, 3]], [])]), { clusterRows: 2 });
    // The pane spans prices 192..212, i.e. rows 96..106 at a row width of 2.
    expect(layout?.bands.map((band) => band.row)).toEqual([48, 49, 50, 51, 52, 53]);
    const band = layout?.bands.find((entry) => entry.row === 50); // rows 100 and 101, prices 200..204
    expect(band?.yTop).toBe((TOP_PRICE - 204) * PX_PER_PRICE);
    expect(band?.yBottom).toBe((TOP_PRICE - 200) * PX_PER_PRICE);
  });

  it("folds the columns into cells of an eighth of the bar from 15m, one tier scanned whole, with the run clocks in cells, and leaves a minute chart's columns as they came", () => {
    const grid = gridWith([column(0, [[0, 3]], []), column(1, [[0, 4]], []), column(200, [[0, 2]], [])]);
    const quick = layoutOf(grid);
    expect([quick?.cellMs, quick?.clocks]).toEqual([0, runClocksFor(60_000)]);
    expect(quick?.tiers[0].columnMs).toBe(1000);
    const slow = layoutOf(grid, {}, 15 * 60);
    expect(slow?.cellMs).toBe(112_500);
    expect(slow?.clocks).toEqual(runClocksFor(15 * 60_000));
    expect(slow?.tiers).toHaveLength(1);
    expect(slow?.tiers[0].columnMs).toBe(112_500);
    expect(slow?.tiers[0].scanTo).toBe(2);
    expect(slow?.tiers[0].columns.map((cell) => [cell.ts, cell.bid[0]])).toEqual([[Math.floor(T / 112_500) * 112_500, 4], [Math.floor((T + 200_000) / 112_500) * 112_500, 2]]);
    // The fold is kept on the grid: the next layout reads the same cells.
    expect(layoutOf(grid, {}, 15 * 60)?.tiers[0].columns).toBe(slow?.tiers[0].columns);
  });

  it("fills the holes in the runtime's columns from the host as well as the stretch behind them: the past tier holds the host's columns wherever the lane has none of its own, asked up to the live edge, the same array while nothing changes", () => {
    const seconds = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 180 + i)];
    const grid = gridWith(seconds.map((second) => column(second, [[0, 3]], [])));
    const stored = Array.from({ length: 10 }, (_, i) => ({ ts: T - 420_000 + i * 60_000, lo: 100, hi: 104, bid: Float64Array.of(3, 0, 0, 0, 0), ask: new Float64Array(5) }));
    const wants: HistoryWant[] = [];
    const history: HeatHistorySource = {
      reach: (want) => { wants.push(want); return { columns: stored, shown: { ...want }, loading: false }; },
      status: () => ({ rowWidth: ROW_WIDTH, span: null, reachTs: stored[0].ts, unavailable: null }),
    };
    const at = (source: LiquidityGrid, barSec = BAR_SEC) => {
      const { chart, series } = fakeChart(barSec);
      return computeHeatmapLayout(chart, series, source, DEFAULT_LIQUIDITY_SETTINGS, null, null, "auto", history);
    };
    const layout = at(grid);
    const windowEnd = Math.floor((T + 190_000 - 1) / 300_000) * 300_000 + 300_000;
    expect(wants[0]).toEqual({ levelMs: 60_000, rowFactor: 1, fromTs: T - 86_400_000, toTs: windowEnd, beforeTs: windowEnd });
    // Before the runtime's first column and in the hole between its two stretches; not at T, where it has columns of its own.
    expect(layout?.tiers[0].columnMs).toBe(60_000);
    expect(layout?.tiers[0].columns.map((cell) => (cell.ts - T) / 60_000)).toEqual([-7, -6, -5, -4, -3, -2, -1, 1, 2]);
    expect(at(grid)?.tiers[0].columns).toBe(layout?.tiers[0].columns);
    // A live column landing at the edge changes nothing about which host columns are drawn: the same array, so the kept scan stands.
    expect(grid.apply({ type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T + 190_000, seq: 21, reset: false, row_width: ROW_WIDTH, column_ms: 1000, columns: [column(190, [[0, 3]], [])] } as LiquidityFrame)).toBe(true);
    expect(at(grid)?.tiers[0].columns).toBe(layout?.tiers[0].columns);
    // The runtime fills part of the hole itself: the host's column there goes, the other stays.
    const filled = gridWith([...seconds, ...Array.from({ length: 10 }, (_, i) => 60 + i)].sort((a, b) => a - b).map((second) => column(second, [[0, 3]], [])));
    expect(at(filled)?.tiers[0].columns.map((cell) => (cell.ts - T) / 60_000)).toEqual([-7, -6, -5, -4, -3, -2, -1, 2]);
    // From 15m the columns are judged by the cell they fold into: both of the hole's minutes share a cell with a live column, so only the stretch behind is drawn, folded.
    const slow = at(grid, 15 * 60);
    expect(slow?.tiers[0].columnMs).toBe(112_500);
    expect(slow?.tiers[0].columns.map((cell) => cell.ts)).toEqual([...new Set(stored.filter((cell) => cell.ts < T).map((cell) => Math.floor(cell.ts / 112_500) * 112_500))]);
  });

  it("draws the host's five-minute columns five minutes wide when the chart's cells are finer than that, and folds them into the cells when the cells are coarser", () => {
    const grid = gridWith([column(0, [[0, 3]], [])]);
    const stored = [-3, -2, -1].map((i) => ({ ts: T + i * 300_000, lo: 100, hi: 104, bid: Float64Array.of(3, 0, 0, 0, 0), ask: new Float64Array(5) }));
    const history: HeatHistorySource = {
      reach: (want) => ({ columns: stored, shown: { ...want }, loading: false }),
      status: () => ({ rowWidth: ROW_WIDTH, span: null, reachTs: stored[0].ts, unavailable: null }),
    };
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, historyDays: 7 as const };
    const at = (barSec: number) => {
      const { chart, series } = fakeChart(barSec);
      return computeHeatmapLayout(chart, series, grid, settings, null, null, "auto", history);
    };
    const quarter = at(15 * 60);
    expect(quarter?.cellMs).toBe(112_500);
    expect(quarter?.history?.levelMs).toBe(300_000);
    expect(quarter?.tiers[0].columnMs).toBe(300_000);
    expect(quarter?.tiers[0].columns.map((cell) => cell.ts)).toEqual(stored.map((cell) => cell.ts));
    const hour = at(60 * 60);
    expect(hour?.cellMs).toBe(450_000);
    expect(hour?.tiers[0].columnMs).toBe(450_000);
    // The hour's cell that holds the live column at T is the runtime's; the host's column inside it is not drawn over it.
    expect(hour?.tiers[0].columns.map((cell) => cell.ts)).toEqual([...new Set(stored.filter((cell) => Math.floor(cell.ts / 450_000) !== Math.floor(T / 450_000)).map((cell) => Math.floor(cell.ts / 450_000) * 450_000))]);
    const minute = at(60);
    expect(minute?.tiers[0].columnMs).toBe(300_000);
  });

  it("reads the coarse tier on its own rows from 4h up when the grid holds one, bands it by the same price as the fine rows would, folds it to the bar, and keeps the ladder on the fine rows", () => {
    const grid = gridWith([column(0, [[0, 3], [1, 5]], [])]);
    // A coarse tier on rows four times as tall (price 8 a row): rows 25..26 are prices 200..216.
    grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 2, reset: true, row_width: 4 * ROW_WIDTH, column_ms: 300_000,
      columns: [{ ts: T - 7_200_000, lo: 25, hi: 26, bid: [[0, 9]], ask: [] }, { ts: T - 3_600_000, lo: 25, hi: 26, bid: [[0, 4]], ask: [] }],
    } as LiquidityFrame);
    expect(COARSE_FROM_MS).toBe(4 * 3_600_000);
    const hourly = layoutOf(grid, { clusterRows: 1 }, 3_600);
    expect([hourly?.rowWidth, hourly?.clusterRows, hourly?.tiers[0].columnMs]).toEqual([ROW_WIDTH, 8, 450_000]);
    const slow = layoutOf(grid, { clusterRows: 1 }, 4 * 3_600);
    // One fine row a band, x30 on 4h, is 30 fine rows: seven and a half coarse rows, so eight.
    expect([slow?.rowWidth, slow?.clusterRows, slow?.cellMs]).toEqual([4 * ROW_WIDTH, 8, 1_800_000]);
    expect(slow?.tiers).toHaveLength(1);
    expect(slow?.tiers[0].columnMs).toBe(1_800_000);
    expect(slow?.tiers[0].columns.map((cell) => [cell.ts, cell.bid[0]])).toEqual([[Math.floor((T - 7_200_000) / 1_800_000) * 1_800_000, 9], [Math.floor((T - 3_600_000) / 1_800_000) * 1_800_000, 4]]);
    // The bands are laid on the coarse rows: the pane's prices 192..212 are coarse rows 24..26, band 3 at eight a band.
    expect(slow?.bands.map((band) => band.row)).toEqual([3]);
    // The ladder still reads the fine tier's latest column on the fine rows banded x30 (rows 90..119, prices 180..240, clipped to the rows in view).
    expect(slow?.ladder).toEqual([{ yTop: (TOP_PRICE - 214) * PX_PER_PRICE, yBottom: PANE_HEIGHT, side: "bid", size: 8 }]);
    // Without a coarse tier a 4h chart folds the fine and deep tiers as before.
    const plain = layoutOf(gridWith([column(0, [[0, 3]], [])]), { clusterRows: 1 }, 4 * 3_600);
    expect([plain?.rowWidth, plain?.clusterRows, plain?.tiers[0].columnMs]).toEqual([ROW_WIDTH, 30, 1_800_000]);
  });

  it("keeps one tier when the grid has one, and scans all of it for runs", () => {
    const grid = gridWith([column(0, [[0, 3]], []), column(1, [[0, 4]], [])]);
    const layout = layoutOf(grid);
    expect(layout?.tiers).toHaveLength(1);
    expect(layout?.tiers[0].scanTo).toBe(2);
    expect(layout?.tiers[0].columnMs).toBe(1000);
  });

  it("gives the ladder one entry per band of the latest column, biggest size as the scale", () => {
    const grid = gridWith([column(0, [[0, 3]], [[3, 5]])]); // bid row 100, ask row 103
    const layout = layoutOf(grid, { clusterRows: 2 });
    expect(layout?.ladder).toEqual([
      { yTop: (TOP_PRICE - 204) * PX_PER_PRICE, yBottom: (TOP_PRICE - 200) * PX_PER_PRICE, side: "bid", size: 3 },
      { yTop: (TOP_PRICE - 208) * PX_PER_PRICE, yBottom: (TOP_PRICE - 204) * PX_PER_PRICE, side: "ask", size: 5 },
    ]);
    expect(layout?.ladderMax).toBe(5);
  });

  it("splits a band that holds both sides: bid below, ask above", () => {
    const layout = layoutOf(gridWith([column(0, [[0, 3]], [[1, 5]])]), { clusterRows: 2 }); // rows 100 and 101, one band
    const mid = ((TOP_PRICE - 204) * PX_PER_PRICE + (TOP_PRICE - 200) * PX_PER_PRICE) / 2;
    expect(layout?.ladder).toEqual([
      { yTop: mid, yBottom: (TOP_PRICE - 200) * PX_PER_PRICE, side: "bid", size: 3 },
      { yTop: (TOP_PRICE - 204) * PX_PER_PRICE, yBottom: mid, side: "ask", size: 5 },
    ]);
  });

  it("keeps the whole book on the ladder whatever the trader's minimum: that filters the chart, not the axis", () => {
    const grid = gridWith([column(0, [[0, 3]], [[3, 5]])]);
    expect(layoutOf(grid, { clusterRows: 2, minBandSize: 4 })?.ladder.map((row) => row.size)).toEqual([3, 5]);
    expect(layoutOf(grid, { clusterRows: 2, minBandSize: 4 })?.ladderMax).toBe(5);
  });
});

describe("computeHeatmapLayout from the chart rows it is handed (report 57 W4)", () => {
  it("lays out exactly as from series.data(), without asking the series to rebuild every candle", () => {
    const { chart, series } = fakeChart();
    const grid = gridWith([column(0, [[0, 3]], [[4, 2]]), column(1, [[1, 5]], [])]);
    const rows = series.data();
    const fromSeries = computeHeatmapLayout(chart, series, grid, DEFAULT_LIQUIDITY_SETTINGS);
    let rebuilds = 0;
    const counted = { ...series, data: () => { rebuilds += 1; return rows; } } as unknown as ISeriesApi<SeriesType, Time>;
    const fromRows = computeHeatmapLayout(chart, counted, grid, DEFAULT_LIQUIDITY_SETTINGS, rows as never);
    expect(fromRows).toEqual(fromSeries);
    expect(rebuilds).toBe(0);
  });
});
