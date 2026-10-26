// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import { historicalL2, type IndicatorL2, type L2ColumnView } from "../../../chart/indicatorL2";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import {
  DEFAULT_L2_BOOK_MAP_SETTINGS,
  L2BookMapPrimitive,
  normalizeL2BookMapSettings,
} from "../l2BookMapPrimitive";

const T = 1_700_000_000_000;

function gridWithBidAsk(): LiquidityGrid {
  const grid = new LiquidityGrid();
  const frame: LiquidityFrame = {
    type: "liquidity",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    ts: T,
    seq: 1,
    reset: true,
    row_width: 1,
    column_ms: 1000,
    columns: [
      {
        ts: T,
        lo: 0,
        hi: 10,
        bid: [
          [2, 8],
          [3, 7],
          [4, 5],
        ],
        ask: [
          [7, 2],
          [8, 4],
        ],
      },
    ],
    levels: [],
  };
  grid.apply(frame);
  return grid;
}

describe("L2BookMapPrimitive", () => {
  it("renders qualified historical close observations and keeps missing seconds empty", () => {
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    const columns = [T, T + 3000].map((ts) => ({ ts, lo: 400, hi: 400, bid: new Float64Array([5]), ask: new Float64Array([NaN]) }));
    const source: IndicatorL2 = { ...historicalL2(), availability: "HISTORICAL", version: 1,
      status: () => ({ synced: true, seq: null, lastTs: T + 3000, lastFrameAt: null }),
      lanes: () => [{ lane: 0, rowWidth: 0.25, columnMs: 1000, deepColumnMs: 1000, priceLo: 100, priceHi: 100.25 }],
      view: () => ({ epoch: 1, deep: null, fine: { columns, columnMs: 1000 } }),
    };
    primitive.setSource(source, null);
    expect(primitive.cells.map((cell) => cell.timeStartMs)).toEqual([T, T + 3000]);
    expect(primitive.cells.every((cell) => cell.side === "bid" && cell.volume === 5)).toBe(true);
    primitive.setSource(historicalL2(), null);
    expect(primitive.cells).toEqual([]);
  });
  it("selects a covering L2 lane from the visible price range and clears untrusted data", () => {
    let visible = { from: 100, to: 110 };
    let synced = true;
    let seq = 1;
    const column = (row: number) => ({ ts: T, lo: row, hi: row, bid: new Float64Array([4]), ask: new Float64Array([0]) });
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced, seq, lastTs: T, lastFrameAt: T }),
      lanes: () => [
        { lane: 0, rowWidth: 1, columnMs: 1000, deepColumnMs: 10_000, priceLo: 0, priceHi: 10 },
        { lane: 1, rowWidth: 2, columnMs: 1000, deepColumnMs: 10_000, priceLo: 90, priceHi: 120 },
      ],
      laneFor: (low, high) => low >= 90 && high <= 120 ? 1 : 0,
      view: (lane) => ({ epoch: 1, deep: null, fine: { columns: [column(lane === 1 ? 50 : 2)], columnMs: 1000 } }),
    };
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.attached({
      chart: { timeScale: () => ({}) },
      series: { priceScale: () => ({ getVisibleRange: () => visible }) },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.setSource(l2, gridWithBidAsk());
    expect(primitive.cells.map((cell) => cell.priceLo)).toEqual([100]);
    visible = { from: 0, to: 10 };
    primitive.updateAllViews();
    expect(primitive.cells.map((cell) => cell.priceLo)).toEqual([2]);
    synced = false;
    seq += 1;
    primitive.refresh();
    expect(primitive.cells).toEqual([]);
    primitive.setSource(null, gridWithBidAsk());
    expect(primitive.cells.length).toBeGreaterThan(0);
  });
  it("keeps a lane's deep history when the price scale asks for a lane that has none, so a zoom-out never drops the past", () => {
    const historical = T - 120_000;
    const column = (ts: number) => ({ ts, lo: 0, hi: 0, bid: new Float64Array([5]), ask: new Float64Array([0]) });
    const fine = [T, T + 1000].map(column);
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced: true, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [
        { lane: 0, rowWidth: 1, columnMs: 1000, deepColumnMs: 1000, priceLo: 0, priceHi: 10 },
        { lane: 1, rowWidth: 2, columnMs: 1000, deepColumnMs: 1000, priceLo: 90, priceHi: 120 },
      ],
      laneFor: () => 1,
      view: (lane) => lane === 1
        ? { epoch: 1, deep: null, fine: { columns: fine, columnMs: 1000 } }
        : { epoch: 1, deep: { columns: [column(historical)], columnMs: 1000 }, fine: { columns: fine, columnMs: 1000 } },
    };
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.attached({
      chart: { timeScale: () => ({}) },
      series: { priceScale: () => ({ getVisibleRange: () => ({ from: 90, to: 120 }) }) },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.setSource(l2, null);
    expect(primitive.cells.map((cell) => cell.timeStartMs)).toEqual([historical, T, T + 1000]);
  });
  it("moves off a lane whose deep tier has a hole, so a holed lane cannot cut the past out of the map", () => {
    const column = (ts: number, row = 0) => ({ ts, lo: row, hi: row, bid: new Float64Array([5]), ask: new Float64Array([0]) });
    const fine = [T, T + 1000].map((ts) => column(ts));
    const solid = [T - 200_000, T - 190_000, T - 180_000].map((ts) => column(ts));
    const holed = [T - 700_000, T - 690_000, T - 120_000, T - 110_000].map((ts) => column(ts));
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced: true, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [
        { lane: 0, rowWidth: 1, columnMs: 1000, deepColumnMs: 10_000, priceLo: 0, priceHi: 10 },
        { lane: 1, rowWidth: 2, columnMs: 1000, deepColumnMs: 10_000, priceLo: 90, priceHi: 120 },
      ],
      laneFor: () => 1,
      view: (lane) => lane === 1
        ? { epoch: 1, deep: { columns: holed, columnMs: 10_000 }, fine: { columns: fine, columnMs: 1000 } }
        : { epoch: 1, deep: { columns: solid, columnMs: 10_000 }, fine: { columns: fine, columnMs: 1000 } },
    };
    const primitive = new L2BookMapPrimitive(() => 10_000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.attached({
      chart: { timeScale: () => ({}) },
      series: { priceScale: () => ({ getVisibleRange: () => ({ from: 90, to: 120 }) }) },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.setSource(l2, null);
    // lane 0 (rowWidth 1) not lane 1 (rowWidth 2): every cell spans one row, and the solid deep reaches back.
    expect(primitive.cells.every((cell) => cell.priceHi - cell.priceLo === 1)).toBe(true);
    expect(primitive.cells.some((cell) => cell.timeStartMs <= T - 180_000)).toBe(true);
  });
  it("refreshes lane zero when its grid advances without a new L2 view sequence", () => {
    const grid = gridWithBidAsk();
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced: true, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [{ lane: 0, rowWidth: 1, columnMs: 1000, deepColumnMs: 10_000, priceLo: 0, priceHi: 11 }],
      view: () => ({ epoch: grid.epoch, deep: null, fine: { columns: grid.columns, columnMs: 1000 } }),
    };
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.setSource(l2, grid);
    const before = primitive.cells;
    grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
      ts: T + 1000, seq: 2, reset: false, row_width: 1, column_ms: 1000,
      columns: [{ ts: T + 1000, lo: 0, hi: 10, bid: [[2, 20]], ask: [] }], levels: [],
    });
    primitive.refresh();
    expect(primitive.cells).not.toBe(before);
    expect(primitive.cells.some((cell) => cell.side === "bid" && cell.volume === 20)).toBe(true);
  });
  // PR #55: the bucket is one candle and the window is a count of them, so both follow the chart's timeframe.
  function laneZero(columns: { ts: number }[], columnMs: number): IndicatorL2 {
    return {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced: true, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [{ lane: 0, rowWidth: 1, columnMs, deepColumnMs: columnMs, priceLo: 0, priceHi: 10 }],
      view: () => ({ epoch: 1, deep: null, fine: { columns: columns as L2ColumnView[], columnMs } }),
    };
  }
  const oneRow = (ts: number) => ({ ts, lo: 0, hi: 0, bid: new Float64Array([5]), ask: new Float64Array([0]) });

  it("counts its window in candles of the chart's timeframe, not in seconds", () => {
    // Two one-minute buckets reach back two minutes; read as two seconds they would keep only the newest column.
    const columns = [-300_000, -240_000, -180_000, -120_000, -60_000, 0].map((offset) => oneRow(T + offset));
    const primitive = new L2BookMapPrimitive(() => 60_000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1, windowBuckets: 2 });
    primitive.setSource(laneZero(columns, 60_000), null);
    const starts = primitive.cells.map((cell) => cell.timeStartMs);
    expect(Math.min(...starts)).toBeLessThanOrEqual(T - 60_000);
    expect(Math.min(...starts)).toBeGreaterThan(T - 180_000);
    expect(primitive.cells.every((cell) => cell.timeEndMs - cell.timeStartMs === 60_000)).toBe(true);
  });

  it("rebuilds its buckets when the chart's timeframe changes under the same feed", () => {
    let intervalMs = 1000;
    const columns = [0, 1000, 2000, 3000].map((offset) => oneRow(T + offset));
    const primitive = new L2BookMapPrimitive(() => intervalMs);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.setSource(laneZero(columns, 1000), null);
    expect(primitive.cells.every((cell) => cell.timeEndMs - cell.timeStartMs === 1000)).toBe(true);
    intervalMs = 60_000;
    primitive.refresh();
    expect(primitive.cells.length).toBeGreaterThan(0);
    expect(primitive.cells.every((cell) => cell.timeEndMs - cell.timeStartMs === 60_000)).toBe(true);
  });

  it("uses candle slots across a closed-session gap instead of linear weekend time", () => {
    const primitive = new L2BookMapPrimitive(() => 60_000);
    const previousOpen = T - 3 * 86_400_000;
    const cell = { side: "bid" as const, volume: 1, priceLo: 0, priceHi: 1, timeStartMs: previousOpen + 5_000, timeEndMs: previousOpen + 6_000 };
    primitive.cells = [cell];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: previousOpen / 1000, close: 1 }, { time: T / 1000, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    expect(primitive.cellAt(15.5, 0.5)).toEqual(cell);
  });

  it("draws a time bucket across two contiguous candle slots", () => {
    const primitive = new L2BookMapPrimitive(() => 60_000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = [{ side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T + 59_000, timeEndMs: T + 61_000 }];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000, close: 1 }, { time: T / 1000 + 60, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const fills: { x: number; width: number }[] = [];
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context: { save() {}, restore() {}, fillRect(x: number, _y: number, width: number) { fills.push({ x, width }); } }, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(fills[0]).toEqual({ x: 69, width: 2 });
    expect(primitive.cellAt(70.5, 0.5)).toEqual(primitive.cells[0]);
  });

  it("scales visible heat cells against visible depth, not a wall outside the chart", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = [
      { side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T, timeEndMs: T + 1000 },
      { side: "bid", volume: 1000, priceLo: 0, priceHi: 1, timeStartMs: T + 86_400_000, timeEndMs: T + 86_401_000 },
    ];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 - 60, close: 1 }, { time: T / 1000, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const fills: string[] = [];
    const context = { fillStyle: "", save() {}, restore() {}, fillRect(this: { fillStyle: string }) { fills.push(this.fillStyle); } };
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(fills[0]).toBe("rgba(255, 109, 41, 1)");
    expect(fills).toHaveLength(3);
  });

  it("profiles only chart-visible time, not an offscreen depth wall", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showBidPoc: false, showAskPoc: false });
    primitive.cells = [
      { side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T, timeEndMs: T + 1000 },
      { side: "bid", volume: 1000, priceLo: 10, priceHi: 11, timeStartMs: T + 86_400_000, timeEndMs: T + 86_401_000 },
    ];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 - 60, close: 1 }, { time: T / 1000, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const fills: { color: string; width: number }[] = [];
    const context = { fillStyle: "", save() {}, restore() {}, fillRect(this: { fillStyle: string }, _x: number, _y: number, width: number) { fills.push({ color: this.fillStyle, width }); } };
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(fills.filter(({ color }) => color === "rgba(255, 109, 41, 0.8)")).toEqual([
      { color: "rgba(255, 109, 41, 0.8)", width: 33 },
    ]);
  });

  it("spreads a coarse column across its interval and clips it where fine history begins", () => {
    const grid = new LiquidityGrid();
    const apply = (ts: number, columnMs: number, size: number) => grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
      ts, seq: 1, reset: true, row_width: 1, column_ms: columnMs,
      columns: [{ ts, lo: 0, hi: 0, bid: [[0, size]], ask: [] }], levels: [],
    } as LiquidityFrame);
    expect(apply(T, 1000, 3)).toBe(true);
    expect(apply(T - 5000, 10_000, 2)).toBe(true);
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1, windowBuckets: 15 });
    primitive.setGrid(grid);
    const bid = primitive.cells.filter((cell) => cell.side === "bid");
    expect(bid.map((cell) => [cell.timeStartMs, cell.volume])).toEqual([
      [T - 5000, 2], [T - 4000, 2], [T - 3000, 2], [T - 2000, 2], [T - 1000, 2], [T, 3],
    ]);
  });

  it("keeps historical bid exposure in the profile after price trades below it", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showBidPoc: false, showAskPoc: false });
    primitive.cells = [{ side: "bid", volume: 10, priceLo: 10, priceHi: 11, timeStartMs: T, timeEndMs: T + 1000 }];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 - 60, close: 5 }, { time: T / 1000, close: 5 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    let rectangles = 0;
    const context = { save() {}, restore() {}, fillRect() { rectangles += 1; } };
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(rectangles).toBeGreaterThan(3);
  });

  it("places depth at its actual timestamp rather than the right edge of the newest candle", () => {
    const primitive = new L2BookMapPrimitive(() => 60_000);
    const cell = { side: "bid" as const, volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T + 5_000, timeEndMs: T + 6_000 };
    primitive.cells = [cell];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 - 86_400, close: 1 }, { time: T / 1000, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    expect(primitive.cellAt(75.5, 0.5)).toEqual(cell);
    expect(primitive.cellAt(129.5, 0.5)).toBeNull();
  });

  it("discloses a cell-cap truncation on the chart", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = [{ side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T, timeEndMs: T + 1000 }];
    primitive.truncated = true;
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 - 60, close: 1 }, { time: T / 1000, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const labels: string[] = [];
    const context = { save() {}, restore() {}, fillRect() {}, fillText(value: string) { labels.push(value); } };
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(labels).toContain("BOOKMAP PARTIAL · CELL CAP");
  });

  it("bounds hover lookup to the hovered time bucket even with long retention", () => {
    const primitive = new L2BookMapPrimitive();
    const cells = Array.from({ length: 10_000 }, (_, index) => ({
      side: "bid" as const, volume: 1, priceLo: 0, priceHi: 1,
      timeStartMs: T + index * 1000, timeEndMs: T + (index + 1) * 1000,
    }));
    let rowReads = 0;
    primitive.cells = new Proxy(cells, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 + 9939, close: 1 }, { time: T / 1000 + 9999, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    expect(primitive.cellAt(70.5, 0.5)?.timeStartMs).toBe(T + 9999 * 1000);
    expect(rowReads).toBeLessThan(80);
  });

  it("does not scan the full retained cell history on every canvas repaint", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    const cells = Array.from({ length: 10_000 }, (_, index) => ({
      side: "bid" as const, volume: 1, priceLo: 0, priceHi: 1,
      timeStartMs: T + index * 1000, timeEndMs: T + (index + 1) * 1000,
    }));
    let rowReads = 0;
    primitive.cells = new Proxy(cells, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000 + 9939, close: 1 }, { time: T / 1000 + 9999, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context: { save() {}, restore() {}, fillRect() {} }, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(rowReads).toBeLessThan(200);
  });

  it("asks the chart for each price level's position once per repaint, however many cells share it", () => {
    // Every repaint follows a mouse move. Profiled 2026-09-23: the draw loop was the largest Book Map cost, with two
    // priceToCoordinate calls per cell although a pane's cells share a few dozen price levels across every time column.
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = Array.from({ length: 60 }, (_, bucket) => [0, 1, 2, 3].map((bin) => ({
      side: "bid" as const, volume: 1 + bin, priceLo: bin, priceHi: bin + 1, timeStartMs: T + bucket * 1000, timeEndMs: T + bucket * 1000 + 1000,
    }))).flat();
    let lookups = 0;
    const fills: string[] = [];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000, close: 1 }, { time: T / 1000 + 60, close: 1 }], priceToCoordinate: (price: number) => { lookups += 1; return price * 10; } },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const context = { fillStyle: "", save() {}, restore() {}, fillRect(this: { fillStyle: string }) { fills.push(this.fillStyle); } };
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize: { width: 200, height: 100 } });
      },
    } as never);
    expect(fills.length).toBeGreaterThan(60);
    expect(lookups).toBeLessThanOrEqual(5);
    expect(fills).toContain("rgba(255, 109, 41, 1)");
  });

  it("does not rescan retained depth rows when a new fine column arrives", () => {
    const grid = gridWithBidAsk();
    const primitive = new L2BookMapPrimitive();
    primitive.setGrid(grid);
    const old = grid.columns[0];
    let oldRowReads = 0;
    old.bid = new Proxy(old.bid, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) oldRowReads += 1;
        return Reflect.get(target, property, target);
      },
    });
    expect(grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
      ts: T + 1000, seq: 2, reset: false, row_width: 1, column_ms: 1000,
      columns: [{ ts: T + 1000, lo: 0, hi: 10, bid: [[2, 9]], ask: [] }],
    } as LiquidityFrame)).toBe(true);
    oldRowReads = 0;
    primitive.refresh();
    expect(oldRowReads).toBe(0);
  });

  it("matches a cold rebuild as fine and deep columns overlap, advance, and reset", () => {
    const grid = new LiquidityGrid(2, 2);
    const running = new L2BookMapPrimitive(() => 1000);
    const settings = { ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1, windowBuckets: 12 };
    running.setSettings(settings);
    running.setGrid(grid);
    const apply = (ts: number, seq: number, columnMs: number, reset: boolean, size: number) => {
      expect(grid.apply({
        type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
        ts, seq, reset, row_width: 1, column_ms: columnMs,
        columns: [{ ts, lo: 0, hi: 1, bid: [[0, size]], ask: [[1, size / 2]] }], levels: [],
      } as LiquidityFrame)).toBe(true);
      running.refresh();
      const cold = new L2BookMapPrimitive(() => 1000);
      cold.setSettings(settings);
      cold.setGrid(grid);
      expect(running.cells).toEqual(cold.cells);
    };
    apply(T, 1, 1000, true, 2);
    apply(T - 10_000, 1, 10_000, true, 3);
    apply(T + 1000, 2, 1000, false, 5);
    apply(T + 2000, 3, 1000, false, 7);
    apply(T + 3000, 4, 1000, false, 11);
    apply(T + 4000, 1, 1000, true, 13);
  });

  it("marks the map partial once retained cells pass the cap, dropping the oldest first", () => {
    const grid = new LiquidityGrid();
    const primitive = new L2BookMapPrimitive(() => 1000);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1 });
    primitive.setGrid(grid);
    const apply = (ts: number, seq: number, reset: boolean, rows: number) => {
      expect(grid.apply({
        type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
        ts, seq, reset, row_width: 1, column_ms: 1000,
        columns: [{ ts, lo: 0, hi: rows - 1, bid: Array.from({ length: rows }, (_, row) => [row, 1]), ask: [] }], levels: [],
      } as LiquidityFrame)).toBe(true);
      primitive.refresh();
    };
    apply(T, 1, true, 1);
    expect(primitive.truncated).toBe(false);
    apply(T + 1000, 2, false, 100_000);
    expect(primitive.truncated).toBe(true);
    expect(primitive.cells).toHaveLength(100_000);
    expect(primitive.cells.every((cell) => cell.timeStartMs === T + 1000)).toBe(true);
  });

  it("removes a bucket once every column that fed it has left, whatever float residue the subtraction leaves", () => {
    // At NVDA-scale depth a bin's share-seconds reach tens of millions: 48,000,000.3 + 300,000.7 added and then both
    // removed leaves 2.97e-9, above the old 1e-9 cut, so an invisible but hoverable "0" cell stayed and held a cap slot.
    // The book is an equity's, so it is read inside the regular session (10:00 New York); at T (17:13 New York) the
    // grid holds no columns and the test compared two empty maps.
    const S0 = Date.UTC(2023, 10, 14, 15, 0, 0);
    const grid = new LiquidityGrid();
    const running = new L2BookMapPrimitive(() => 2000);
    const settings = { ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1, windowBuckets: 2 };
    running.setSettings(settings);
    running.setGrid(grid);
    const apply = (ts: number, seq: number, reset: boolean, row: number, size: number) => {
      expect(grid.apply({
        type: "liquidity", provider: "DXFEED", assetClass: "EQUITY", symbol: "NVDA",
        ts, seq, reset, row_width: 1, column_ms: 1000,
        columns: [{ ts, lo: 0, hi: 10, bid: [[row, size]], ask: [] }], levels: [],
      } as LiquidityFrame)).toBe(true);
      running.refresh();
    };
    apply(S0, 1, true, 5, 48_000_000.3);
    apply(S0 + 1_000, 2, false, 5, 300_000.7);
    expect(running.cells.some((cell) => cell.timeStartMs === S0 && cell.volume > 48_000_000)).toBe(true);
    apply(S0 + 10_000, 3, false, 2, 10);
    const cold = new L2BookMapPrimitive(() => 2000);
    cold.setSettings(settings);
    cold.setGrid(grid);
    expect(running.cells).toEqual(cold.cells);
    expect(running.cells.some((cell) => cell.timeStartMs === S0)).toBe(false);
    expect(running.cells.length).toBeGreaterThan(0);
  });

  it("forgets the old geometry when a reconnect resets the same grid with a new row width", () => {
    const grid = new LiquidityGrid();
    const running = new L2BookMapPrimitive(() => 1000);
    const settings = { ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 2, windowBuckets: 12 };
    running.setSettings(settings);
    running.setGrid(grid);
    const reset = (rowWidth: number, row: number) => {
      expect(grid.apply({
        type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT",
        ts: T, seq: 1, reset: true, row_width: rowWidth, column_ms: 1000,
        columns: [{ ts: T, lo: 0, hi: 10, bid: [[row, 10]], ask: [] }], levels: [],
      } as LiquidityFrame)).toBe(true);
      running.refresh();
    };
    reset(1, 4);
    reset(2, 2);
    const cold = new L2BookMapPrimitive(() => 1000);
    cold.setSettings(settings);
    cold.setGrid(grid);
    expect(cold.cells).toHaveLength(1);
    expect(running.cells).toEqual(cold.cells);
  });

  it("does not offer hover for cells excluded by the vertical range", () => {
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 1, verticalRangeRows: 1 });
    primitive.setGrid(gridWithBidAsk());
    const series = {
      data: () => [{ time: T / 1000 - 60, close: 8 }, { time: T / 1000, close: 8 }],
      priceToCoordinate: (price: number) => price,
    };
    const chart = {
      timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }),
    };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as SeriesAttachedParameter<Time>);
    expect(primitive.cellAt(70.5, 2.5)).toBeNull();
    expect(primitive.cellAt(70.5, 4.5)?.side).toBe("bid");
    expect(primitive.cellAt(70.5, 8.5)).toBeNull();
  });

  it("aggregates both sides into price-time buckets and ignores values below the floor", () => {
    const grid = gridWithBidAsk();
    const primitive = new L2BookMapPrimitive();
    primitive.setSettings({
      ...DEFAULT_L2_BOOK_MAP_SETTINGS,
      priceBinRows: 2,
      minVolume: 4,
    });
    primitive.setGrid(grid);

    expect(
      primitive.cells.some((cell) => cell.side === "bid" && cell.volume >= 8),
    ).toBe(true);
    expect(
      primitive.cells.some((cell) => cell.side === "ask" && cell.volume >= 4),
    ).toBe(true);
    expect(primitive.cells.every((cell) => cell.volume >= 4)).toBe(true);
  });

  it("normalizes malformed persisted settings without breaking the map", () => {
    const normalized = normalizeL2BookMapSettings({
      priceBinRows: 0,
      windowBuckets: 0,
      minVolume: -1,
      lowVolumeColor: "not-a-color",
      midVolumeColor: "not-a-color",
      highVolumeColor: "#00ff00",
    });

    expect(normalized.priceBinRows).toBe(0);
    expect(normalized.windowBuckets).toBe(1);
    expect(normalized.minVolume).toBe(0);
    expect(normalized.lowVolumeColor).toBe(
      DEFAULT_L2_BOOK_MAP_SETTINGS.lowVolumeColor,
    );
    expect(normalized.midVolumeColor).toBe(
      DEFAULT_L2_BOOK_MAP_SETTINGS.midVolumeColor,
    );
    expect(normalized.highVolumeColor).toBe("#00ff00");
  });

  it("does not rebuild its cells on every price tick, when the chart hands it the grid it already has (report 57 W4)", () => {
    const grid = gridWithBidAsk();
    const primitive = new L2BookMapPrimitive();
    primitive.setGrid(grid);
    const cells = primitive.cells;
    expect(cells.length).toBeGreaterThan(0);
    primitive.setGrid(grid);
    expect(primitive.cells).toBe(cells);
    primitive.setGrid(gridWithBidAsk());
    expect(primitive.cells).not.toBe(cells);
    expect(primitive.cells).toEqual(cells);
  });

  it("repaints a mouse move from its finished paint, and works it out again when the candles, the price scale or the pane change (report 57 W4, GE-18)", () => {
    const opens = { revision: 1, opensMs: [T - 60_000, T] };
    const primitive = new L2BookMapPrimitive(() => 60_000, () => opens);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = [{ side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T, timeEndMs: T + 1000 }];
    const scale = { pxPerPrice: 1 };
    let dataReads = 0;
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => { dataReads += 1; return []; }, priceToCoordinate: (price: number) => price * scale.pxPerPrice },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    let fills = 0;
    const paint = (width = 200) => primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context: { save() {}, restore() {}, fillRect() { fills += 1; } }, mediaSize: { width, height: 100 } });
      },
    } as never);
    paint();
    const first = primitive.paintFor({ width: 200, height: 100 });
    paint();
    expect(primitive.paintFor({ width: 200, height: 100 })).toBe(first);
    expect(fills).toBe(6);
    scale.pxPerPrice = 2;
    expect(primitive.paintFor({ width: 200, height: 100 })).not.toBe(first);
    const scaled = primitive.paintFor({ width: 200, height: 100 });
    opens.opensMs = [T - 60_000, T];
    expect(primitive.paintFor({ width: 200, height: 100 })).not.toBe(scaled);
    expect(primitive.paintFor({ width: 300, height: 100 })).not.toBe(primitive.paintFor({ width: 200, height: 100 }));
    expect(dataReads).toBe(0);
  });
  it("repaints when the visible price range moves even though the first cell in view sits off the price scale", () => {
    // Vertical zoom/pan used to key the finished-pixel cache off a single probe cell. When that cell was off-view
    // its coordinate went null, the key stopped tracking the price scale, and every later pan/zoom drew stale
    // pixels -- the heatmap held its old rows and appeared to lose the ones the new scale had brought in.
    const opensMs = Array.from({ length: 100 }, (_, index) => T + index * 60_000);
    const opens = { revision: 1, opensMs };
    const primitive = new L2BookMapPrimitive(() => 60_000, () => opens);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false, showBidPoc: false, showAskPoc: false });
    primitive.cells = opensMs.flatMap((open) => [
      { side: "bid" as const, volume: 1, priceLo: 0, priceHi: 1, timeStartMs: open, timeEndMs: open + 60_000 },
      ...[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((price) => ({ side: "bid" as const, volume: 1 + price, priceLo: price, priceHi: price + 1, timeStartMs: open, timeEndMs: open + 60_000 })),
    ]);
    const view = { low: 5, high: 25 };
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: {
        priceToCoordinate: (price: number) => (price < view.low || price > view.high ? null : ((view.high - price) / (view.high - view.low)) * 100),
        priceScale: () => ({ getVisibleRange: () => ({ from: view.low, to: view.high }) }),
      },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    const first = primitive.paintFor({ width: 200, height: 100 });
    const firstFill = first.find((step) => step.kind === "fill") as { y: number };
    view.low = 3;
    view.high = 27;
    const second = primitive.paintFor({ width: 200, height: 100 });
    expect(second).not.toBe(first);
    expect((second.find((step) => step.kind === "fill") as { y: number }).y).not.toBe(firstFill.y);
  });
});

describe("L2BookMapPrimitive repaints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function recorder(transform?: { a: number; d: number }) {
    const calls: string[] = [];
    const drawn: unknown[][] = [];
    const context = {
      fillStyle: "",
      save() {},
      restore() {},
      setTransform() {},
      fillRect(this: { fillStyle: string }, x: number, y: number, width: number, height: number) { calls.push(`${this.fillStyle}|${x}|${y}|${width}|${height}`); },
      drawImage(...args: unknown[]) { calls.push("image"); drawn.push(args); },
      ...(transform === undefined ? {} : { getTransform: () => transform }),
    };
    return { context, calls, drawn };
  }

  function primitiveWithCell(): L2BookMapPrimitive {
    const opens = { revision: 1, opensMs: [T, T + 60_000] };
    const primitive = new L2BookMapPrimitive(() => 60_000, () => opens);
    primitive.setSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    primitive.cells = [{ side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T + 59_000, timeEndMs: T + 61_000 }];
    primitive.attached({
      chart: { timeScale: () => ({ timeToIndex: () => 1, logicalToCoordinate: () => 100, options: () => ({ barSpacing: 60 }) }) },
      series: { data: () => [{ time: T / 1000, close: 1 }, { time: T / 1000 + 60, close: 1 }], priceToCoordinate: (price: number) => price },
      requestUpdate: () => {},
    } as unknown as SeriesAttachedParameter<Time>);
    return primitive;
  }

  function draw(primitive: L2BookMapPrimitive, context: unknown, mediaSize = { width: 200, height: 100 }): void {
    primitive.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace(callback: (scope: unknown) => void) {
        callback({ context, mediaSize });
      },
    } as never);
  }

  function stubCanvas() {
    const offscreen = recorder();
    const canvases: { width: number; height: number; getContext: () => unknown }[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => offscreen.context };
        canvases.push(canvas);
        return canvas;
      },
    });
    return { offscreen, canvases };
  }

  it("paints a repaint that changes nothing from one cached image, not cell by cell", () => {
    const { offscreen, canvases } = stubCanvas();
    const primitive = primitiveWithCell();
    const main = recorder({ a: 2, d: 2 });
    draw(primitive, main.context);
    const painted = offscreen.calls.length;
    expect(painted).toBeGreaterThan(0);
    draw(primitive, main.context);
    draw(primitive, main.context);
    expect(offscreen.calls).toHaveLength(painted);
    expect(main.calls).toEqual(["image", "image", "image"]);
    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([400, 200]);
    expect(main.drawn.map((args) => args.slice(1))).toEqual([[0, 0, 200, 100], [0, 0, 200, 100], [0, 0, 200, 100]]);
  });

  it("paints the image again when the paint, the size or the pixel ratio changes", () => {
    const { offscreen } = stubCanvas();
    const primitive = primitiveWithCell();
    const main = recorder({ a: 2, d: 2 });
    draw(primitive, main.context);
    const first = offscreen.calls.length;
    draw(primitive, main.context, { width: 300, height: 100 });
    const resized = offscreen.calls.length;
    expect(resized).toBeGreaterThan(first);
    draw(primitive, recorder({ a: 1, d: 1 }).context, { width: 300, height: 100 });
    const rescaled = offscreen.calls.length;
    expect(rescaled).toBeGreaterThan(resized);
    primitive.cells = [{ side: "ask", volume: 2, priceLo: 0, priceHi: 1, timeStartMs: T + 59_000, timeEndMs: T + 61_000 }];
    draw(primitive, recorder({ a: 1, d: 1 }).context, { width: 300, height: 100 });
    expect(offscreen.calls.length).toBeGreaterThan(rescaled);
  });

  it("keeps one offscreen canvas for the life of the primitive and resizes it, however often the size or the paint changes", () => {
    const { canvases } = stubCanvas();
    const primitive = primitiveWithCell();
    draw(primitive, recorder({ a: 2, d: 2 }).context);
    draw(primitive, recorder({ a: 2, d: 2 }).context, { width: 300, height: 120 });
    primitive.cells = [{ side: "ask", volume: 2, priceLo: 0, priceHi: 1, timeStartMs: T + 59_000, timeEndMs: T + 61_000 }];
    draw(primitive, recorder({ a: 1, d: 1 }).context, { width: 300, height: 120 });
    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([300, 120]);
  });

  it("paints straight onto the chart, without making an image, when the pixel ratio is unusable or the image would be enormous", () => {
    const { canvases } = stubCanvas();
    const primitive = primitiveWithCell();
    for (const transform of [{ a: Number.POSITIVE_INFINITY, d: 1 }, { a: 1, d: Number.NaN }, { a: 0, d: 1 }, { a: 1, d: -2 }, { a: 1_000, d: 1_000 }]) {
      const main = recorder(transform);
      draw(primitive, main.context);
      expect(main.calls.length).toBeGreaterThan(0);
      expect(main.calls).not.toContain("image");
    }
    expect(canvases).toHaveLength(0);
  });

  it("lets go of the image's pixels when there is nothing to paint and when it is detached", () => {
    const { canvases } = stubCanvas();
    const primitive = primitiveWithCell();
    draw(primitive, recorder({ a: 2, d: 2 }).context);
    expect([canvases[0].width, canvases[0].height]).toEqual([400, 200]);
    primitive.cells = [];
    draw(primitive, recorder({ a: 2, d: 2 }).context);
    expect([canvases[0].width, canvases[0].height]).toEqual([0, 0]);
    primitive.cells = [{ side: "bid", volume: 1, priceLo: 0, priceHi: 1, timeStartMs: T + 59_000, timeEndMs: T + 61_000 }];
    draw(primitive, recorder({ a: 2, d: 2 }).context);
    expect(canvases).toHaveLength(2);
    expect([canvases[1].width, canvases[1].height]).toEqual([400, 200]);
    primitive.detached();
    expect([canvases[1].width, canvases[1].height]).toEqual([0, 0]);
  });

  it("puts the same cells on the image that it would put on the chart directly", () => {
    const { offscreen } = stubCanvas();
    const cached = primitiveWithCell();
    draw(cached, recorder({ a: 1, d: 1 }).context);
    vi.unstubAllGlobals();
    const direct = recorder();
    draw(primitiveWithCell(), direct.context);
    expect(offscreen.calls).toEqual(direct.calls);
  });
});
