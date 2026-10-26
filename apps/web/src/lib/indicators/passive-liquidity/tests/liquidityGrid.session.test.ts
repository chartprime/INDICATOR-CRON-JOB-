import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid } from "../liquidityGrid";

// Report 57 W1, GE-14: equity heatmap columns are regular-session only. The
// columns are delta encoded, so a hidden pre-market column must still be
// decoded: the first regular-session column is built on top of it.
const PRE = Date.parse("2026-09-23T13:29:58Z"); // 09:29:58 EDT

function equityFrame(columns: LiquidityFrame["columns"], assetClass: "EQUITY" | "FUTURE" = "EQUITY"): LiquidityFrame {
  return {
    type: "liquidity", provider: "DXFEED", assetClass, symbol: assetClass === "EQUITY" ? "AAPL" : "/NQZ26:XCME",
    ts: PRE + 4_000, seq: columns.length, reset: true, row_width: 1, column_ms: 1_000, columns,
  } as LiquidityFrame;
}

const columns: LiquidityFrame["columns"] = [
  { ts: PRE, lo: 100, hi: 102, bid: [[0, 5], [1, 6]], ask: [[2, 7]] },
  { ts: PRE + 1_000, lo: 100, hi: 102, bid: [[1, 9]], ask: [] },
  { ts: PRE + 2_000, lo: 100, hi: 102, bid: [], ask: [[2, 1]] },
  { ts: PRE + 3_000, lo: 100, hi: 102, bid: [[0, 0]], ask: [] },
];

describe("LiquidityGrid regular-session scope (GE-14)", () => {
  it("keeps only the regular-session equity columns, decoded from the hidden ones before them", () => {
    const grid = new LiquidityGrid();
    expect(grid.apply(equityFrame(columns))).toBe(true);
    expect(grid.columns.map((column) => column.ts)).toEqual([PRE + 2_000, PRE + 3_000]);
    expect(Array.from(grid.columns[0].bid)).toEqual([5, 9, 0]);
    expect(Array.from(grid.columns[0].ask)).toEqual([0, 0, 1]);
    expect(Array.from(grid.columns[1].bid)).toEqual([0, 9, 0]);
  });

  it("chains the next frame from the last decoded column, hidden or not", () => {
    const grid = new LiquidityGrid();
    grid.apply(equityFrame(columns.slice(0, 1)));
    expect(grid.columns).toHaveLength(0);
    const next = { ...equityFrame(columns.slice(1, 3)), reset: false, seq: 3 };
    expect(grid.apply(next)).toBe(true);
    expect(grid.columns.map((column) => column.ts)).toEqual([PRE + 2_000]);
    expect(Array.from(grid.columns[0].bid)).toEqual([5, 9, 0]);
  });

  it("keeps every futures column", () => {
    const grid = new LiquidityGrid();
    grid.apply(equityFrame(columns, "FUTURE"));
    expect(grid.columns).toHaveLength(4);
  });
});
