import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../types/frames";
import { LiquidityGrid } from "../../indicators/passive-liquidity/liquidityGrid";
import { indicatorLiquidityOf } from "../indicatorLiquidity";

const T = 1_700_000_000_000;

type FrameFields = Pick<LiquidityFrame, "ts" | "seq" | "reset" | "row_width" | "column_ms" | "columns">;

function frame(overrides: Partial<FrameFields>): LiquidityFrame {
  const base: LiquidityFrame = {
    type: "liquidity",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    ts: T,
    seq: 1,
    reset: true,
    row_width: 2,
    column_ms: 1000,
    columns: [],
  };
  return { ...base, ...overrides };
}

function column(ts: number) {
  return { ts, lo: 100, hi: 104, bid: [[0, 1], [2, 3]] as [number, number][], ask: [[3, 4]] as [number, number][] };
}

function gridWith(...tss: number[]): LiquidityGrid {
  const grid = new LiquidityGrid();
  grid.apply(frame({ seq: 1, reset: true, columns: tss.map(column) }));
  return grid;
}

describe("indicatorLiquidityOf", () => {
  it("carries the column history lane it is given, and none by default", () => {
    const lane = { want: () => undefined } as unknown as Parameters<typeof indicatorLiquidityOf>[1];
    expect(indicatorLiquidityOf(gridWith(T))?.history).toBeNull();
    expect(indicatorLiquidityOf(gridWith(T), lane)?.history).toBe(lane);
    expect(indicatorLiquidityOf(null, lane)).toBeNull();
  });

  it("reports the heatmap's Row Size as the chart holds it when asked, so a change reaches the next bar, and none by default", () => {
    let rows: number | null = 3;
    const reader = indicatorLiquidityOf(gridWith(T), null, () => rows)!;
    expect(reader.heatmapClusterRows).toBe(3);
    rows = 7;
    expect(reader.heatmapClusterRows).toBe(7);
    expect(indicatorLiquidityOf(gridWith(T))!.heatmapClusterRows).toBeNull();
  });

  it("is null for no grid, so an indicator sees the same absence whether the feed is off or missing", () => {
    expect(indicatorLiquidityOf(null)).toBeNull();
  });

  it("carries the grid's geometry and identity alongside the columns", () => {
    const reader = indicatorLiquidityOf(gridWith(T))!;
    expect(reader.rowWidth).toBe(2);
    expect(reader.baseAsset).toBe("BTC");
    expect(reader.feed.fine.columnMs).toBe(1000);
    expect(reader.feed.fine.columns).toHaveLength(1);
  });

  it("follows the grid across a reset, which swaps the column array out rather than emptying it in place", () => {
    const grid = gridWith(T);
    const reader = indicatorLiquidityOf(grid)!;
    expect(reader.feed.fine.columns).toHaveLength(1);
    grid.apply(frame({ ts: T + 1000, seq: 9, reset: true, columns: [column(T + 1000), column(T + 2000)] }));
    expect(reader.feed.fine.columns).toHaveLength(2);
    expect(reader.version).toBe(grid.version);
  });

  it("reports no deep tier rather than an empty one, which eachColumn would otherwise scan every pass", () => {
    const reader = indicatorLiquidityOf(gridWith(T))!;
    expect(reader.feed.deep).toBeNull();
  });

  it("picks up a deep tier that only appears once the coarse frames start arriving", () => {
    const grid = gridWith(T);
    const reader = indicatorLiquidityOf(grid)!;
    expect(reader.feed.deep).toBeNull();
    grid.apply(frame({ seq: 1, reset: true, column_ms: 10_000, columns: [column(T)] }));
    expect(reader.feed.deep?.columnMs).toBe(10_000);
    expect(reader.feed.fine.columns).toHaveLength(1);
  });

  it("carries the grid's epoch so a reader can tell a re-anchored book from a continuous one", () => {
    const grid = gridWith(T);
    expect(indicatorLiquidityOf(grid)!.feed.epoch).toBe(grid.epoch);
  });
});
