// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { LiquidityFrame } from "../../../../types/frames";
import { HeatmapHistory, type HistoryRequest } from "../heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../heatmapHistoryDecode";
import { LiquidityGrid, type LiquidityColumn } from "../liquidityGrid";
import { computeHeatmapLayout } from "../liquidityHeatmapLayout";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../liquiditySettings";
import type { HeatLanes } from "../liquidityLanes";

// P4c.4: the history tier holds pyramid columns older than every live
// column, at the level the view needs, and nothing when the rows differ.

const W = HISTORY_WINDOW_MS;
const T = Math.floor(1_757_340_000_000 / 60_000) * 60_000;
const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 2 };

function liveGrid(rowWidth = 2, firstTs = T - 60_000): LiquidityGrid {
  const g = new LiquidityGrid();
  g.apply({
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 2, reset: true,
    row_width: rowWidth, column_ms: 1_000,
    columns: [{ ts: firstTs, lo: 95, hi: 105, bid: [[0, 3], [1, 4]], ask: [[9, 2]] }, { ts: T, lo: 95, hi: 105, bid: [[0, 9]], ask: [] }],
  } as unknown as LiquidityFrame);
  return g;
}

function chart(barSec: number, barSpacing = 6) {
  const height = 400;
  const priceTop = 212;
  const priceBottom = 192;
  const perPx = (priceTop - priceBottom) / height;
  return {
    chart: {
      timeScale: () => ({ timeToIndex: () => 2, logicalToCoordinate: () => 500, options: () => ({ barSpacing }), width: () => 600 }),
      paneSize: () => ({ height, width: 600 }),
    } as unknown as IChartApiBase<Time>,
    series: {
      data: () => [0, 1, 2].map((i) => ({ time: T / 1000 - (2 - i) * barSec, high: 206, low: 202, close: 204 })),
      coordinateToPrice: (y: number) => priceTop - y * perPx,
      priceToCoordinate: (price: number) => (priceTop - price) / perPx,
    } as unknown as ISeriesApi<SeriesType, Time>,
  };
}

function column(ts: number): LiquidityColumn {
  return { ts, lo: 96, hi: 104, bid: Float64Array.from([5, 1, 0, 0, 0, 0, 0, 0, 0]), ask: Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0, 7]), reference: 5, median: 1 };
}

function filled(rowWidth: number) {
  const requests: HistoryRequest[] = [];
  const history = new HeatmapHistory({ request: (r) => requests.push(r), now: () => 1 });
  history.setIdentity({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT" });
  const answer = (request: HistoryRequest): DecodedHistoryPage => {
    const windows = [];
    for (let ts = request.fromTs; ts < request.toTs; ts += W) {
      if (ts === request.fromTs + W) continue;
      windows.push({ ts, state: "COVERED" as const, columns: Array.from({ length: W / request.levelMs }, (_, i) => column(ts + i * request.levelMs)) });
    }
    return { available: true, generation: "layout-test", levelMs: request.levelMs, rowFactor: request.rowFactor, rowWidth, span: { oldest: T - 10 * 86_400_000, newest: T + W }, next: null, windows };
  };
  return { history, requests, answer };
}

describe("LiquidityHeatmapPrimitive with a history store", () => {
  it("asks the store for the chosen reach each frame and tells the legend when loading starts, lands, or goes away", async () => {
    const { LiquidityHeatmapPrimitive } = await import("../liquidityHeatmapPrimitive");
    const primitive = new LiquidityHeatmapPrimitive();
    const { chart: c, series } = chart(60);
    const scale = (c as unknown as { timeScale: () => object }).timeScale();
    const withOffsets = { ...c, timeScale: () => ({ ...scale, options: () => ({ barSpacing: 6, rightOffset: 0 }), applyOptions: () => undefined, scrollPosition: () => 0 }) };
    primitive.attached({ chart: withOffsets, series, requestUpdate: () => undefined } as unknown as Parameters<typeof primitive.attached>[0]);
    primitive.setSettings(settings);
    primitive.setGrid(liveGrid());
    const { history, requests, answer } = filled(2);
    const seen: (string | null)[] = [];
    primitive.onHistoryDrawn = (info) => seen.push(info === null ? null : `${info.levelMs}:${info.days}:${info.loading}:${info.drawn}`);
    primitive.setHistory(history);
    primitive.updateAllViews();
    primitive.updateAllViews();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    // Whole five-minute windows: from the one holding the oldest live column to the one holding the live edge.
    expect(requests.filter((request) => !(request.levelMs === 60_000 && request.toTs <= T + W && request.fromTs >= T - 60_000 - 86_400_000 - W)).map((request) => [request.levelMs, (request.fromTs - T) / 3_600_000, (request.toTs - T) / 3_600_000])).toEqual([]);
    expect(seen).toEqual(["60000:1:true:false"]);
    settle(history, requests, answer, () => primitive.updateAllViews());
    expect(seen).toEqual(["60000:1:true:false", "60000:1:false:true"]);
    primitive.setHistory(null);
    primitive.updateAllViews();
    expect(seen).toEqual(["60000:1:true:false", "60000:1:false:true", null]);
  });
});

const answeredBy = new WeakMap<HeatmapHistory, Set<number>>();

/** Answer every request the store has out and let the chart ask again, as a repaint would, until nothing more is asked. */
function settle(history: HeatmapHistory, requests: HistoryRequest[], answer: (request: HistoryRequest) => DecodedHistoryPage, pump: () => void): number {
  let answered = answeredBy.get(history);
  if (answered === undefined) {
    answered = new Set<number>();
    answeredBy.set(history, answered);
  }
  let rounds = 0;
  while (requests.some((request) => !answered.has(request.requestId))) {
    for (const request of requests.filter((request) => !answered.has(request.requestId))) {
      answered.add(request.requestId);
      history.accept(request.requestId, answer(request));
    }
    pump();
    rounds += 1;
    if (rounds > 200) throw new Error("the store keeps asking");
  }
  return rounds;
}

describe("computeHeatmapLayout with a history tier", () => {
  it("with no store there is no history; with one, the reach is asked for even while the view sits inside the live span", () => {
    const grid = liveGrid();
    const { chart: c, series } = chart(60);
    const without = computeHeatmapLayout(c, series, grid, settings);
    expect(without?.history).toBeNull();
    const { history } = filled(2);
    const inside = liveGrid(2, T - 10 * 3_600_000);
    const withHistory = computeHeatmapLayout(c, series, inside, settings, null, null, "auto", history);
    expect(withHistory?.history).toMatchObject({ days: 1, levelMs: 60_000, loading: true, drawn: false });
    expect(withHistory?.historyWant).toMatchObject({ levelMs: 60_000, rowFactor: 1, fromTs: T - 10 * 3_600_000 - 86_400_000, toTs: T + W, beforeTs: T + W });
  });

  it("asks for the setting's reach behind the oldest live column at that reach's column width, newest chunk first, and draws it only once it has all landed", () => {
    const grid = liveGrid();
    const { chart: c, series } = chart(60);
    const { history, requests, answer } = filled(2);
    const first = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    const want = first?.historyWant;
    if (!want) throw new Error("expected a want");
    expect(want).toEqual({ levelMs: 60_000, rowFactor: 1, fromTs: T - 60_000 - 86_400_000, toTs: T + W, beforeTs: T + W });
    expect(first?.history).toMatchObject({ days: 1, loading: true, drawn: false, refused: null });
    expect(first?.tiers.every((tier) => tier.columnMs !== 60_000)).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    for (let i = 1; i < requests.length; i += 1) expect(requests[i].toTs).toBeLessThanOrEqual(requests[i - 1].fromTs);
    history.accept(requests[0].requestId, answer(requests[0]));
    answeredBy.set(history, new Set([requests[0].requestId]));
    const partial = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    expect(partial?.history).toMatchObject({ loading: true, drawn: false });
    expect(partial?.tiers.every((tier) => tier.columnMs !== 60_000)).toBe(true);
    settle(history, requests, answer, () => computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history));
    const layout = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    const tier = layout?.tiers[0];
    if (!tier) throw new Error("expected tiers");
    expect(layout?.history).toMatchObject({ drawn: true, loading: false, levelMs: 60_000, days: 1 });
    expect(tier.columnMs).toBe(60_000);
    expect(tier.columns.every((col) => col.ts < T - 60_000)).toBe(true);
    expect(tier.columns.length).toBeGreaterThan(1_000);
    expect(layout?.tiers[layout.tiers.length - 1].columns).toBe(grid.columns);
  });

  it("a longer reach keeps the one on screen until the new one has all landed, then swaps; a week loads at five-minute columns", () => {
    const grid = liveGrid();
    const { chart: c, series } = chart(60);
    const { history, requests, answer } = filled(2);
    computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    settle(history, requests, answer, () => computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history));
    const day = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    expect(day?.history).toMatchObject({ drawn: true, loading: false, days: 1 });
    const dayColumns = day?.tiers[0].columns;
    const week = { ...settings, historyDays: 7 };
    const asked = computeHeatmapLayout(c, series, grid, week, null, null, "auto", history);
    expect(asked?.historyWant).toMatchObject({ levelMs: 300_000, fromTs: T - 60_000 - 7 * 86_400_000, toTs: T + W });
    expect(asked?.history).toMatchObject({ days: 7, loading: true, drawn: true, levelMs: 300_000 });
    expect(asked?.tiers[0].columns).toBe(dayColumns);
    settle(history, requests, answer, () => computeHeatmapLayout(c, series, grid, week, null, null, "auto", history));
    const landed = computeHeatmapLayout(c, series, grid, week, null, null, "auto", history);
    expect(landed?.history).toMatchObject({ days: 7, loading: false, drawn: true });
    expect(landed?.tiers[0].columnMs).toBe(300_000);
    expect(landed?.tiers[0].columns.length).toBeGreaterThan(1_500);
    expect(landed?.tiers[0].columns[0].ts).toBeLessThan(T - 6 * 86_400_000);
  });

  it("loads the reach once at the runtime's rows and draws it on whichever lane the price zoom picks, so a lane change asks the host for nothing", () => {
    const grid = liveGrid(2);
    const laneOne = new LiquidityGrid();
    laneOne.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 2, reset: true,
      row_width: 4, column_ms: 2_000,
      columns: [{ ts: T - 60_000, lo: 40, hi: 60, bid: [[0, 3]], ask: [[20, 2]] }, { ts: T, lo: 40, hi: 60, bid: [[0, 9]], ask: [] }],
    } as unknown as LiquidityFrame);
    const lanes: HeatLanes = { grid: (lane) => (lane === 1 ? laneOne : null) };
    const { chart: c, series } = chart(60);
    const { history, requests, answer } = filled(2);
    const onLaneOne = () => computeHeatmapLayout(c, series, grid, settings, null, lanes, "1", history);
    const onLaneZero = () => computeHeatmapLayout(c, series, grid, settings, null, lanes, "0", history);
    expect(onLaneOne()?.lane).toBe(1);
    expect(onLaneOne()?.historyWant).toMatchObject({ rowFactor: 1, levelMs: 60_000 });
    settle(history, requests, answer, onLaneOne);
    const asked = requests.length;
    const wide = onLaneOne();
    expect(wide?.history).toMatchObject({ drawn: true, loading: false, refused: null, rowFactor: 1 });
    const past = wide?.tiers[0];
    if (!past) throw new Error("expected the history tier");
    expect(past.columnMs).toBe(60_000);
    expect(past.columns[0]).toMatchObject({ lo: 48, hi: 52 });
    expect([...past.columns[0].bid]).toEqual([6, 0, 0, 0, 0]);
    expect([...past.columns[0].ask]).toEqual([0, 0, 0, 0, 7]);
    const narrow = onLaneZero();
    expect(narrow?.lane).toBe(0);
    expect(narrow?.history).toMatchObject({ drawn: true, loading: false });
    expect(narrow?.tiers[0].columns[0]).toMatchObject({ lo: 96, hi: 104 });
    expect(onLaneOne()?.tiers[0].columns).toBe(past.columns);
    expect(requests).toHaveLength(asked);
  });

  it("refuses a lane whose rows are not a whole multiple of the history's rows", () => {
    const grid = liveGrid(2);
    const odd = new LiquidityGrid();
    odd.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: 2, reset: true,
      row_width: 5, column_ms: 2_000,
      columns: [{ ts: T - 60_000, lo: 30, hi: 50, bid: [[0, 3]], ask: [[20, 2]] }, { ts: T, lo: 30, hi: 50, bid: [[0, 9]], ask: [] }],
    } as unknown as LiquidityFrame);
    const lanes: HeatLanes = { grid: (lane) => (lane === 1 ? odd : null) };
    const { chart: c, series } = chart(60);
    const { history, requests, answer } = filled(2);
    const onOdd = () => computeHeatmapLayout(c, series, grid, settings, null, lanes, "1", history);
    expect(onOdd()?.lane).toBe(1);
    settle(history, requests, answer, onOdd);
    const layout = onOdd();
    expect(layout?.history).toMatchObject({ refused: "GEOMETRY", drawn: false, loading: false });
    expect(layout?.tiers.every((tier) => tier.columnMs !== 60_000)).toBe(true);
  });

  it("never draws a page whose rows are not the drawn rows", () => {
    const grid = liveGrid(2);
    const { chart: c, series } = chart(60);
    const { history, requests, answer } = filled(2.5);
    computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    settle(history, requests, answer, () => computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history));
    const layout = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    expect(layout?.history).toMatchObject({ refused: "GEOMETRY", drawn: false, loading: false });
    expect(layout?.tiers.every((tier) => tier.columnMs !== 60_000)).toBe(true);
  });

  it("at 15 min bars it folds history into cells, and a hole between the live columns wider than a cell is filled with one", () => {
    const grid = liveGrid(2, T - 120_000);
    expect((T - 120_000) % 112_500).toBeGreaterThanOrEqual(60_000);
    const { chart: c, series } = chart(900, 6);
    const { history, requests, answer } = filled(2);
    const want = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history)!.historyWant!;
    expect(want.levelMs).toBe(60_000);
    settle(history, requests, answer, () => computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history));
    const layout = computeHeatmapLayout(c, series, grid, settings, null, null, "auto", history);
    if (!layout) throw new Error("expected a layout");
    const cellMs = layout.cellMs;
    expect(cellMs).toBeGreaterThan(0);
    const [past, live] = layout.tiers;
    expect(past.columnMs).toBe(cellMs);
    expect(past.columns.every((col) => col.ts % cellMs === 0)).toBe(true);
    // The live columns stand at T - 120 s and T: the cell between them has none of their own and takes the host's minute.
    expect(T % cellMs).toBe(0);
    expect(Math.max(...past.columns.map((col) => col.ts))).toBe(T - cellMs);
    expect(live.columns.map((col) => col.ts)).toEqual([T - 2 * cellMs, T]);
  });
});
