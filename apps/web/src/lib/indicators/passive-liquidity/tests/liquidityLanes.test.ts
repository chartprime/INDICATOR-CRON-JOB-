// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { IChartApiBase, ISeriesApi, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import type { LiquidityFrame, LiquidityLevel } from "../../../../types/frames";
import { LiquidityGrid } from "../liquidityGrid";
import { computeHeatmapLayout, MAX_VISIBLE_ROWS } from "../liquidityHeatmapLayout";
import { LiquidityHeatmapPrimitive } from "../liquidityHeatmapPrimitive";
import { chooseLane, laneCandidates, laneHeatGrid, type HeatLanes, type LaneCandidate } from "../liquidityLanes";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../liquiditySettings";
import { laneFoldFor, liquidityStyleFor } from "../liquidityStyle";
import type { HeatHistorySource } from "../liquidityHeatmapLayout";
import type { LiquidityColumn } from "../liquidityGrid";

/** The same book as `grid` on an index market, sizes scaled so its yardstick differs from a crypto lane's. */
function indexGrid(rowWidth: number, lo: number, hi: number, columnMs = 1_000, scale = 1): LiquidityGrid {
  const g = new LiquidityGrid();
  const bid: [number, number][] = [];
  const ask: [number, number][] = [];
  for (let offset = 0; offset <= hi - lo; offset += 1) (offset < (hi - lo) / 2 ? bid : ask).push([offset, scale * (1 + (offset % 7))]);
  g.apply({
    type: "liquidity", provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME", ts: T, seq: 2, reset: true,
    row_width: rowWidth, column_ms: columnMs,
    columns: [{ ts: T - columnMs, lo, hi, bid, ask }, { ts: T, lo, hi, bid: [[0, 9 * scale]], ask: [] }],
  } as unknown as LiquidityFrame);
  return g;
}

// P4c.2: the heatmap draws the finest zoom lane that covers the prices on
// screen with rows the layout can draw; lane 0 at the default zoom is the
// picture it always was.

const T = 1_700_000_000_000;

function grid(rowWidth: number, lo: number, hi: number, columnMs = 1_000, levels: LiquidityLevel[] = []): LiquidityGrid {
  const g = new LiquidityGrid();
  const bid: [number, number][] = [];
  const ask: [number, number][] = [];
  for (let offset = 0; offset <= hi - lo; offset += 1) (offset < (hi - lo) / 2 ? bid : ask).push([offset, 1 + (offset % 7)]);
  g.apply({
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 2, reset: true,
    row_width: rowWidth, column_ms: columnMs, levels,
    columns: [{ ts: T - columnMs, lo, hi, bid, ask }, { ts: T, lo, hi, bid: [[0, 9]], ask: [] }],
  } as unknown as LiquidityFrame);
  return g;
}

function lanesOf(byLane: Record<number, LiquidityGrid>): HeatLanes {
  return { grid: (lane) => byLane[lane] ?? null };
}

function chartShowing(priceTop: number, priceBottom: number, barSec = 60) {
  const height = 400;
  const perPx = (priceTop - priceBottom) / height;
  const chart = {
    timeScale: () => ({ timeToIndex: () => 2, logicalToCoordinate: () => 500, options: () => ({ barSpacing: 6 }), width: () => 600 }),
    paneSize: () => ({ height, width: 600 }),
  } as unknown as IChartApiBase<Time>;
  const series = {
    data: () => [0, 1, 2].map((i) => ({ time: T / 1000 - (2 - i) * barSec, high: 206, low: 202, close: 204 })),
    coordinateToPrice: (y: number) => priceTop - y * perPx,
    priceToCoordinate: (price: number) => (priceTop - price) / perPx,
  } as unknown as ISeriesApi<SeriesType, Time>;
  return { chart, series };
}

const candidate = (lane: number, rowWidth: number, priceLo: number, priceHi: number): LaneCandidate => ({ lane, rowWidth, priceLo, priceHi });

describe("chooseLane", () => {
  const lanes = [candidate(0, 2, 180, 220), candidate(1, 4, 160, 240), candidate(2, 8, 120, 280)];

  it("takes the finest lane whose coverage holds the prices on screen", () => {
    expect(chooseLane(lanes, 190, 210, MAX_VISIBLE_ROWS)).toBe(0);
    expect(chooseLane(lanes, 170, 230, MAX_VISIBLE_ROWS)).toBe(1);
    expect(chooseLane(lanes, 130, 270, MAX_VISIBLE_ROWS)).toBe(2);
    expect(chooseLane(lanes, 230, 170, MAX_VISIBLE_ROWS)).toBe(1);
    expect(chooseLane(lanes, 190, 230, MAX_VISIBLE_ROWS)).toBe(1);
    expect(chooseLane(lanes, 170, 210, MAX_VISIBLE_ROWS)).toBe(1);
  });

  it("skips a covering lane with more rows in view than the layout draws", () => {
    expect(chooseLane(lanes, 190, 210, 5)).toBe(1);
    expect(chooseLane(lanes, 190, 210, 2)).toBe(2);
  });

  it("with nothing covering, takes the widest lane that still fits, else the widest", () => {
    expect(chooseLane(lanes, 100, 300, MAX_VISIBLE_ROWS)).toBe(2);
    expect(chooseLane(lanes, 100, 300, 30)).toBe(2);
    expect(chooseLane(lanes, 100, 300, 10)).toBe(2);
    expect(chooseLane([], 0, 1, MAX_VISIBLE_ROWS)).toBe(0);
  });

  it("a pinned lane with more rows in view than the layout draws gives way to the lane auto would pick, so the finest rows never leave the chart empty", () => {
    expect(chooseLane(lanes, 190, 210, MAX_VISIBLE_ROWS, "0")).toBe(0);
    expect(chooseLane(lanes, 190, 210, 5, "0")).toBe(1);
    expect(chooseLane(lanes, 190, 210, 2, "0")).toBe(2);
    expect(chooseLane(lanes, 190, 210, 2, "1")).toBe(2);
  });

  it("a pinned lane wins when it exists, and a lane the pair does not have falls back to auto", () => {
    expect(chooseLane(lanes, 130, 270, MAX_VISIBLE_ROWS, "0")).toBe(0);
    expect(chooseLane(lanes, 190, 210, MAX_VISIBLE_ROWS, "2")).toBe(2);
    expect(chooseLane(lanes, 170, 230, MAX_VISIBLE_ROWS, "5")).toBe(1);
  });
});

describe("laneHeatGrid", () => {
  const level = (row: number, span: number): LiquidityLevel => ({ side: "bid", row, span, start_ts: T - 5_000, end_ts: T, size: 10, peak: 12, ended_by: "consumed", ratio: 3, chain: 0, fill: 0, eaten: 0, absorbing: false } as unknown as LiquidityLevel);

  it("reads columns, rows and yardstick from the lane, identity from lane 0, and maps lane 0's walls onto the lane's rows", () => {
    const base = grid(2, 90, 110, 1_000, [level(96, 3), level(101, 1)]);
    const lane = grid(4, 45, 55, 2_000);
    const view = laneHeatGrid(lane, base, 1);
    expect(view.columns).toBe(lane.columns);
    expect([view.rowWidth, view.columnMs]).toEqual([4, 2_000]);
    expect(view.referenceSize).toBe(lane.referenceSize);
    expect([view.provider, view.symbol, view.baseAsset]).toEqual([base.provider, base.symbol, base.baseAsset]);
    expect(view.levels.map((l) => [l.row, l.span])).toEqual([[48, 2], [50, 1]]);
    expect(view.version).toBe(lane.version + base.version);
    expect(laneHeatGrid(lane, base, 1)).toBe(view);
    expect(view.levels).toBe(view.levels);
  });

  it("on an index market reads the yardstick from lane 0, since a lane row is the biggest tick and not a sum; a crypto lane keeps its own", () => {
    const base = indexGrid(2, 90, 110);
    const lane = indexGrid(4, 45, 55, 2_000, 10);
    expect(base.referenceSize).not.toBe(lane.referenceSize);
    expect(laneHeatGrid(lane, base, 1).referenceSize).toBe(base.referenceSize);
    expect([laneFoldFor(base.provider, base.symbol, base.marketKind), laneFoldFor("BINANCE", "BTC-USDT", "PERPETUAL")]).toEqual(["max", "sum"]);
  });

  it("laneCandidates lists lane 0 and every lane with columns, with their price coverage", () => {
    const base = grid(2, 90, 110);
    const one = grid(4, 45, 55);
    expect(laneCandidates(base, lanesOf({ 1: one }))).toEqual([candidate(0, 2, 180, 222), candidate(1, 4, 180, 224)]);
    expect(laneCandidates(base, null)).toEqual([candidate(0, 2, 180, 222)]);
    expect(laneCandidates(base, lanesOf({ 1: new LiquidityGrid() }))).toEqual([candidate(0, 2, 180, 222)]);
  });
});

describe("computeHeatmapLayout with lanes", () => {
  const base = grid(2, 90, 110);
  const one = grid(4, 30, 70, 2_000);
  const lanes = lanesOf({ 1: one });
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 2 };
  const strip = (layout: ReturnType<typeof computeHeatmapLayout>) => {
    if (layout === null) return null;
    const { grid: drawn, ...rest } = layout;
    return { ...rest, drawnRowWidth: drawn.rowWidth };
  };

  it("at the default zoom draws lane 0 exactly as it did with no lanes at all", () => {
    const { chart, series } = chartShowing(212, 192);
    const without = computeHeatmapLayout(chart, series, base, settings);
    const withLanes = computeHeatmapLayout(chart, series, base, settings, null, lanes);
    expect(withLanes?.lane).toBe(0);
    expect(withLanes?.grid).toBe(base);
    expect(strip(withLanes)).toEqual(strip(without));
  });

  it("zoomed out past lane 0 draws lane 1: its rows and tiers, bands scaled to the same price, its yardstick, and the ladder still on lane 0's rows where lane 0 reaches", () => {
    const { chart, series } = chartShowing(270, 130);
    const layout = computeHeatmapLayout(chart, series, base, settings, null, lanes);
    expect(layout?.lane).toBe(1);
    expect(layout?.rowWidth).toBe(4);
    expect(layout?.grid.columns).toBe(one.columns);
    expect(layout?.clusterRows).toBe(1);
    expect(layout?.reference).toBe(one.referenceSize);
    expect(layout?.tiers[layout.tiers.length - 1].columns).toBe(one.columns);
    const onBase = computeHeatmapLayout(chart, series, base, settings);
    const priceOf = (y: number) => 270 - y * ((270 - 130) / 400);
    expect(layout?.ladder.filter((row) => priceOf(row.yBottom) >= 179 && priceOf(row.yTop) <= 225)).toEqual(onBase?.ladder);
    expect(layout?.ladder.length).toBeGreaterThan(onBase?.ladder.length ?? 0);
  });

  it("a fixed colour scale reads the same on every lane: the size is per row of the finest lane, so a band of the same price has the same floor and saturation on rows twice as wide", () => {
    const { chart, series } = chartShowing(270, 130);
    const fixed = { ...settings, scaleMode: "fixed" as const, scaleSize: 10 };
    const fine = computeHeatmapLayout(chart, series, base, fixed, null, lanes, "0");
    const wide = computeHeatmapLayout(chart, series, base, fixed, null, lanes, "1");
    expect([fine?.lane, wide?.lane, fine?.clusterRows, wide?.clusterRows]).toEqual([0, 1, 2, 1]);
    expect([fine?.reference, wide?.reference]).toEqual([10, 20]);
    const style = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL");
    const column = { ts: T, lo: 0, hi: 0, bid: new Float64Array(1), ask: new Float64Array(1), reference: 3 };
    const contextOf = (layout: NonNullable<ReturnType<typeof computeHeatmapLayout>>) => ({ settings: fixed, clusterRows: layout.clusterRows, ladderMax: layout.ladderMax, reference: layout.reference });
    expect(style.paintFloor(column, contextOf(wide!))).toBeCloseTo(style.paintFloor(column, contextOf(fine!)));
    expect(style.saturationAt(column, contextOf(wide!))).toBeCloseTo(style.saturationAt(column, contextOf(fine!)));
    expect(style.paintFloor(column, contextOf(fine!))).toBeCloseTo(0.4 * 10 * 2);
  });

  it("on an index market a fixed scale is the trader's size on every lane, the lane's row being the biggest tick and not a sum", () => {
    const { chart, series } = chartShowing(270, 130);
    const fixed = { ...settings, scaleMode: "fixed" as const, scaleSize: 10 };
    const indexBase = indexGrid(2, 90, 110);
    const indexLanes = lanesOf({ 1: indexGrid(4, 30, 70, 2_000) });
    const fine = computeHeatmapLayout(chart, series, indexBase, fixed, null, indexLanes, "0");
    const wide = computeHeatmapLayout(chart, series, indexBase, fixed, null, indexLanes, "1");
    expect([fine?.lane, wide?.lane, fine?.reference, wide?.reference]).toEqual([0, 1, 10, 10]);
  });

  it("on an index market folds the host's history into a lane by the biggest tick with lane 0's yardstick; on crypto it sums", () => {
    const { chart, series } = chartShowing(270, 130);
    const stored: LiquidityColumn[] = [0, 1].map((i) => ({ ts: T - 600_000 + i * 60_000, lo: 90, hi: 93, bid: Float64Array.of(4, 6, 1, 2), ask: new Float64Array(4), reference: 5, median: 2, ceiling: 9 }));
    const history: HeatHistorySource = {
      reach: (want) => ({ columns: stored, shown: { ...want }, loading: false }),
      status: () => ({ rowWidth: 2, span: null, reachTs: stored[0].ts, unavailable: null }),
    };
    const indexPast = computeHeatmapLayout(chart, series, indexGrid(2, 90, 110), settings, null, lanesOf({ 1: indexGrid(4, 30, 70, 2_000) }), "1", history)?.tiers[0];
    expect(indexPast?.columns[0]).toMatchObject({ lo: 45, hi: 46, reference: 5, median: 2, ceiling: 9 });
    expect([...(indexPast?.columns[0].bid ?? [])]).toEqual([6, 2]);
    const cryptoPast = computeHeatmapLayout(chart, series, base, settings, null, lanes, "1", history)?.tiers[0];
    expect([...(cryptoPast?.columns[0].bid ?? [])]).toEqual([10, 3]);
  });

  it("keeps the ladder when the price axis shows more of lane 0's rows than the heat can draw: the axis bands straight from the price range, on lane 0's rows", () => {
    const { chart, series } = chartShowing(9_000, 0);
    const layout = computeHeatmapLayout(chart, series, base, settings, null, lanes);
    expect(layout?.lane).toBe(1);
    expect(layout?.bands.length).toBeGreaterThan(0);
    const onBaseRows = (at: ReturnType<typeof computeHeatmapLayout>, top: number, bottom: number) =>
      (at?.ladder ?? []).filter((row) => top - row.yBottom * ((top - bottom) / 400) >= 179 && top - row.yTop * ((top - bottom) / 400) <= 225).map((row) => [row.side, row.size]);
    expect(onBaseRows(layout, 9_000, 0)).toEqual(onBaseRows(computeHeatmapLayout(chartShowing(270, 130).chart, chartShowing(270, 130).series, base, settings, null, lanes), 270, 130));
    expect(layout?.ladderMax).toBeGreaterThan(0);
    const alone = computeHeatmapLayout(chart, series, base, settings);
    expect(alone?.bands).toEqual([]);
    expect(alone?.ladder.length).toBeGreaterThan(0);
  });

  it("carries the ladder past lane 0's window on the wider lanes' live columns: a band outside the finest book reads the finest lane that holds it, by the lane's rows when a band is thinner than one", () => {
    const wide = new LiquidityGrid();
    const bid: [number, number][] = [];
    const ask: [number, number][] = [];
    for (let row = 30; row <= 70; row += 1) (row < 50 ? bid : ask).push([row - 30, row < 50 ? 5 : 7]);
    wide.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 1, reset: true,
      row_width: 4, column_ms: 2_000, columns: [{ ts: T, lo: 30, hi: 70, bid, ask }],
    } as unknown as LiquidityFrame);
    const { chart, series } = chartShowing(270, 130);
    const perPx = (270 - 130) / 400;
    const layout = computeHeatmapLayout(chart, series, base, settings, null, lanesOf({ 1: wide }), "0");
    expect(layout?.lane).toBe(0);
    const priceOf = (y: number) => 270 - y * perPx;
    const rows = (layout?.ladder ?? []).map((row) => ({ side: row.side, size: row.size, from: Math.round(priceOf(row.yBottom)), to: Math.round(priceOf(row.yTop)) }));
    expect(rows.filter((row) => row.to <= 180)).toEqual([{ side: "bid", size: 5, from: 130, to: 132 }, ...Array.from({ length: 12 }, (_, i) => ({ side: "bid", size: 5, from: 132 + 4 * i, to: 136 + 4 * i }))]);
    expect(rows.filter((row) => row.from >= 222)).toEqual(Array.from({ length: 12 }, (_, i) => ({ side: "ask", size: 7, from: 224 + 4 * i, to: 228 + 4 * i })));
    expect(rows.find((row) => row.from === 180)).toEqual({ side: "bid", size: 11, from: 180, to: 184 });
    expect(layout?.ladderMax).toBe(13);

    const thin = computeHeatmapLayout(chart, series, base, { ...settings, clusterRows: 1 }, null, lanesOf({ 1: wide }), "0");
    const thinRows = (thin?.ladder ?? []).map((row) => ({ size: row.size, from: Math.round(priceOf(row.yBottom)), to: Math.round(priceOf(row.yTop)) }));
    expect(thinRows.filter((row) => row.to <= 180)).toEqual([{ size: 5, from: 130, to: 132 }, ...Array.from({ length: 12 }, (_, i) => ({ size: 5, from: 132 + 4 * i, to: 136 + 4 * i }))]);
    expect(thinRows.find((row) => row.from === 180)).toEqual({ size: 9, from: 180, to: 182 });

    const odd = new LiquidityGrid();
    odd.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 1, reset: true,
      row_width: 5, column_ms: 2_000, columns: [{ ts: T, lo: 20, hi: 60, bid: Array.from({ length: 41 }, (_, i) => [i, 1]), ask: [] }],
    } as unknown as LiquidityFrame);
    const withOdd = computeHeatmapLayout(chart, series, base, settings, null, lanesOf({ 1: odd }), "0");
    expect(withOdd?.ladder).toEqual(computeHeatmapLayout(chart, series, base, settings, null, null, "0")?.ladder);

    const alone = computeHeatmapLayout(chart, series, base, settings, null, null, "0");
    expect(alone?.ladder.every((row) => priceOf(row.yBottom) >= 179 && priceOf(row.yTop) <= 225)).toBe(true);
  });

  it("a pinned lane 0 keeps the finest rows even zoomed out", () => {
    const { chart, series } = chartShowing(270, 130);
    const layout = computeHeatmapLayout(chart, series, base, settings, null, lanes, "0");
    expect(layout?.lane).toBe(0);
    expect(layout?.rowWidth).toBe(2);
  });

  it("from 4h bars with a coarse tier, the coarse picture wins and lanes stay out of it", () => {
    const withCoarse = grid(2, 90, 110);
    withCoarse.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 1, reset: true,
      row_width: 80, column_ms: 300_000, columns: [{ ts: T - 300_000, lo: 2, hi: 3, bid: [[0, 5]], ask: [[1, 6]] }],
    } as unknown as LiquidityFrame);
    const { chart, series } = chartShowing(270, 130, 4 * 3_600);
    const layout = computeHeatmapLayout(chart, series, withCoarse, settings, null, lanes);
    expect(layout?.lane).toBe(0);
    expect(layout?.rowWidth).toBe(80);
  });

  it("the heatmap layer reports the lane it draws when it changes, and only then, for the legend", () => {
    const attach = (primitive: LiquidityHeatmapPrimitive, priceTop: number, priceBottom: number) => {
      const { chart, series } = chartShowing(priceTop, priceBottom);
      const scale = (chart as unknown as { timeScale: () => object }).timeScale();
      const withOffsets = { ...chart, timeScale: () => ({ ...scale, options: () => ({ barSpacing: 6, rightOffset: 0 }), applyOptions: () => undefined, scrollPosition: () => 0 }) };
      primitive.attached({ chart: withOffsets, series, requestUpdate: () => undefined } as unknown as SeriesAttachedParameter<Time>);
    };
    const primitive = new LiquidityHeatmapPrimitive();
    const seen: number[] = [];
    primitive.onLaneDrawn = (lane) => seen.push(lane);
    primitive.setSettings(settings);
    primitive.setGrid(base);
    primitive.setLanes(lanes);
    attach(primitive, 270, 130);
    primitive.updateAllViews();
    primitive.updateAllViews();
    expect(seen).toEqual([1]);
    attach(primitive, 212, 192);
    primitive.updateAllViews();
    expect(seen).toEqual([1, 0]);
  });
});
