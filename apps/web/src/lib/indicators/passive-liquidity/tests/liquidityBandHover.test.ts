import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../../types/frames";
import { bandAt } from "../liquidityBandHover";
import { LiquidityGrid } from "../liquidityGrid";
import type { HeatmapLayout } from "../liquidityHeatmapLayout";
import { DEFAULT_RUN_CLOCKS } from "../liquidityRuns";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../liquiditySettings";

const T = 1_700_000_000_000;

function gridWith(columns: LiquidityFrame["columns"], rowWidth: number, columnMs: number): LiquidityGrid {
  const grid = new LiquidityGrid();
  grid.apply({ type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T, seq: columns.length, reset: true, row_width: rowWidth, column_ms: columnMs, columns } as LiquidityFrame);
  return grid;
}

function layoutOver(columns: LiquidityGrid["columns"], columnMs: number, rowWidth: number, clusterRows: number): HeatmapLayout {
  return {
    grid: new LiquidityGrid(), lane: 0, history: null, historyWant: null,
    originX: 0, originMs: T, pxPerMs: 1 / 1000, rowWidth, clusterRows,
    bands: [{ row: 50, yTop: 0, yBottom: 10 }],
    tiers: [{ columns, columnMs, from: 0, to: columns.length, scanTo: columns.length }],
    bars: [], intervalMs: 60_000, cellMs: 0, clocks: DEFAULT_RUN_CLOCKS, reference: 10, ladder: [], ladderMax: 0, freeRight: 0, gaps: [],
  };
}

describe("bandAt", () => {
  it("names the band's prices by the drawn tier's row width and reads the size from the drawn tier's column", () => {
    // Fine rows of 2 (rows 100..104, prices 200..210); the layout draws a coarse tier of rows of 4 (rows 50..52), banded one row each.
    const fine = gridWith([{ ts: T, lo: 100, hi: 104, bid: [[0, 40]], ask: [] }], 2, 1000);
    const coarse = gridWith([{ ts: T - 300_000, lo: 50, hi: 52, bid: [[0, 90]], ask: [] }], 4, 300_000);
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed" as const, scaleSize: 10, quietBands: 0 };
    const hover = bandAt(fine, layoutOver(coarse.columns, 300_000, 4, 1), settings, -100, 5);
    expect(hover).toMatchObject({ side: "bid", size: 90, priceLo: 200, priceHi: 204, state: "resting" });
    expect(bandAt(fine, layoutOver(fine.columns, 1000, 2, 1), settings, -100, 5)).toBeNull();
  });

  it("reads the time under the cursor through the chart's holes: a column before a session break is found where the chart draws it, two bars before the bar after the break", () => {
    const fine = gridWith([{ ts: T - 7_200_000, lo: 100, hi: 104, bid: [[0, 40]], ask: [] }, { ts: T, lo: 100, hi: 104, bid: [[0, 40]], ask: [] }], 2, 1000);
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed" as const, scaleSize: 10, quietBands: 0 };
    // One bar before the hole at T - 2 h, the next at T: the chart gives the 119 minutes between one bar of room, its break point.
    const layout = { ...layoutOver(fine.columns, 1000, 2, 1), bands: [{ row: 100, yTop: 0, yBottom: 10 }], gaps: [{ start: T - 7_080_000, end: T }] };
    // One pixel a second: the bar before the hole opens 120 px left of the origin, where its column is; the break's slot holds nothing.
    expect(bandAt(fine, layout, settings, -120, 5)?.size).toBe(40);
    expect(bandAt(fine, layout, settings, -60, 5)).toBeNull();
    expect(bandAt(fine, { ...layout, gaps: [] }, settings, -120, 5)).toBeNull();
  });

  it("names the price-zoom lane the band was drawn from, so the tooltip can say the rows are merged (P4c.2)", () => {
    const fine = gridWith([{ ts: T, lo: 100, hi: 104, bid: [[0, 40]], ask: [] }], 2, 1000);
    const coarse = gridWith([{ ts: T - 300_000, lo: 50, hi: 52, bid: [[0, 90]], ask: [] }], 4, 300_000);
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed" as const, scaleSize: 10, quietBands: 0 };
    expect(bandAt(fine, layoutOver(coarse.columns, 300_000, 4, 1), settings, -100, 5)?.lane).toBe(0);
    expect(bandAt(fine, { ...layoutOver(coarse.columns, 300_000, 4, 1), lane: 1 }, settings, -100, 5)?.lane).toBe(1);
  });
});
