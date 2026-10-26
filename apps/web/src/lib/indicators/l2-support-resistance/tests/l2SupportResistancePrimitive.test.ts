import { describe, expect, it } from "vitest";
import type { LiquidityFrame, LiquidityLevel } from "../../../../types/frames";
import { LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import { historicalL2, type IndicatorL2 } from "../../../chart/indicatorL2";
import type { L2Wall } from "../../../l2/types";
import {
  DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
  L2SupportResistancePrimitive,
  normalizeL2SupportResistanceSettings,
} from "../l2SupportResistancePrimitive";

const T = 1_700_000_000_000;
const ROW_WIDTH = 1;

function wall(overrides: Partial<LiquidityLevel> = {}): LiquidityLevel {
  return {
    side: "bid",
    row: 100,
    span: 1,
    start_ts: T,
    end_ts: null,
    size: 10,
    peak: 10,
    ended_by: null,
    ratio: 1,
    chain: 0,
    fill: 0,
    eaten: 0,
    absorbing: false,
    ...overrides,
  } as LiquidityLevel;
}

function applyLevels(
  grid: LiquidityGrid,
  options: {
    seq: number;
    reset: boolean;
    ts?: number;
    walls: readonly LiquidityLevel[];
  },
): boolean {
  const ts = options.ts ?? T;
  const frame: LiquidityFrame = {
    type: "liquidity",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    ts,
    seq: options.seq,
    reset: options.reset,
    row_width: ROW_WIDTH,
    column_ms: 1000,
    columns: [{ ts, lo: 0, hi: 1000, bid: [[0, 1]], ask: [[1, 1]] }],
    levels: [...options.walls],
  };
  return grid.apply(frame);
}

function gridWith(walls: readonly LiquidityLevel[]): LiquidityGrid {
  const grid = new LiquidityGrid();
  applyLevels(grid, { seq: 1, reset: true, walls });
  return grid;
}

function primitiveWith(
  grid: LiquidityGrid,
  settings: Partial<
    (typeof DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS)
  > = {},
): L2SupportResistancePrimitive {
  const primitive = new L2SupportResistancePrimitive();
  primitive.setSettings({ ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS, ...settings });
  primitive.setGrid(grid);
  return primitive;
}

describe("L2SupportResistancePrimitive", () => {
  it("uses engine walls only while the wall channel is live and synced", () => {
    let synced = true;
    const engineWall: L2Wall = {
      id: 7, lane: 0, side: "ask", row: 100, span: 1, startTs: T, endTs: null,
      size: 12, peak: 12, endedBy: null, ratio: 2, chain: 0, fill: 0,
      eaten: 0, absorbing: false, detail: null,
    };
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [{ lane: 0, rowWidth: 0.5, columnMs: 1000, deepColumnMs: 10_000, priceLo: 0, priceHi: 500 }],
      walls: () => [engineWall],
    };
    const primitive = new L2SupportResistancePrimitive();
    const grid = gridWith([wall({ row: 400 })]);
    primitive.setSource(l2, grid);
    expect(primitive.levels).toEqual([{ price: 50.25, size: 12, side: "ask", detail: undefined }]);
    synced = false;
    primitive.refresh();
    expect(primitive.levels).toEqual([]);
    expect(primitive.sourceStatus).toContain("UNTRUSTED");
    primitive.setSource(null, grid);
    expect(primitive.levels).toHaveLength(1);
    expect(primitive.sourceStatus).toContain("LEGACY");
  });
  it("repositions engine walls when lane-zero geometry changes at the same wall sequence", () => {
    let rowWidth = 0.5;
    const engineWall: L2Wall = {
      id: 1, lane: 0, side: "bid", row: 100, span: 1, startTs: T, endTs: null,
      size: 10, peak: 10, endedBy: null, ratio: 1, chain: 0, fill: 0,
      eaten: 0, absorbing: false, detail: null,
    };
    const l2: IndicatorL2 = {
      ...historicalL2(), availability: "LIVE", version: 1,
      segment: () => ({ id: "segment", state: "LIVE" }),
      status: () => ({ synced: true, seq: 1, lastTs: T, lastFrameAt: T }),
      lanes: () => [{ lane: 0, rowWidth, columnMs: 1000, deepColumnMs: 10_000, priceLo: 0, priceHi: 500 }],
      walls: () => [engineWall],
    };
    const primitive = new L2SupportResistancePrimitive();
    primitive.setSource(l2, null);
    expect(primitive.levels[0].price).toBe(50.25);
    rowWidth = 1;
    primitive.refresh();
    expect(primitive.levels[0].price).toBe(100.5);
  });
  it("selects only active walls, excluding ones that have already ended", () => {
    const active = wall({ side: "bid", row: 100, ratio: 2 });
    const ended = wall({ side: "ask", row: 500, end_ts: T - 1000, ratio: 5 });
    const primitive = primitiveWith(gridWith([active, ended]));

    expect(primitive.levels).toHaveLength(1);
    expect(primitive.levels[0].side).toBe("bid");
  });

  describe("lookback window", () => {
    it("includes a wall that formed exactly at the cutoff", () => {
      const lookbackMinutes = 10;
      const cutoff = T - lookbackMinutes * 60_000;
      const primitive = primitiveWith(
        gridWith([wall({ row: 100, start_ts: cutoff })]),
        { lookbackMinutes },
      );

      expect(primitive.levels).toHaveLength(1);
    });

    it("excludes a wall that formed one millisecond before the cutoff", () => {
      const lookbackMinutes = 10;
      const cutoff = T - lookbackMinutes * 60_000;
      const primitive = primitiveWith(
        gridWith([wall({ row: 100, start_ts: cutoff - 1 })]),
        { lookbackMinutes },
      );

      expect(primitive.levels).toHaveLength(0);
    });
  });

  describe("minimum liquidity size", () => {
    it("rejects a wall smaller than the configured minimum", () => {
      const primitive = primitiveWith(gridWith([wall({ row: 100, size: 4 })]), {
        minimumLiquiditySize: 5,
      });

      expect(primitive.levels).toHaveLength(0);
    });

    it("admits a wall exactly at the configured minimum", () => {
      const primitive = primitiveWith(gridWith([wall({ row: 100, size: 5 })]), {
        minimumLiquiditySize: 5,
      });

      expect(primitive.levels).toHaveLength(1);
    });

    it("keeps every wall when the minimum is left at its default of zero", () => {
      const primitive = primitiveWith(gridWith([wall({ row: 100, size: 0.0001 })]));

      expect(primitive.levels).toHaveLength(1);
    });
  });

  describe("ranking", () => {
    it("ranks by ratio first: a smaller, higher-ratio wall outranks a bigger, lower-ratio one for a capped slot", () => {
      const highRatio = wall({ row: 100, ratio: 5, size: 1 });
      const lowRatioBig = wall({ row: 500, ratio: 1, size: 1000 });
      const primitive = primitiveWith(gridWith([highRatio, lowRatioBig]), {
        maxLevels: 1,
        minimumDistanceRows: 1,
      });

      expect(primitive.levels).toHaveLength(1);
      expect(primitive.levels[0].size).toBe(1);
    });

    it("breaks a ratio tie by size", () => {
      const smaller = wall({ row: 100, ratio: 2, size: 10 });
      const bigger = wall({ row: 500, ratio: 2, size: 20 });
      const primitive = primitiveWith(gridWith([smaller, bigger]), {
        maxLevels: 1,
        minimumDistanceRows: 1,
      });

      expect(primitive.levels).toHaveLength(1);
      expect(primitive.levels[0].size).toBe(20);
    });
  });

  describe("minimum distance between selected levels", () => {
    it("suppresses a lower-ranked wall too close in price to an already-selected one", () => {
      const strong = wall({ row: 100, ratio: 5, size: 1 });
      const nearby = wall({ row: 101, ratio: 1, size: 1 });
      const primitive = primitiveWith(gridWith([strong, nearby]), {
        minimumDistanceRows: 5,
        maxLevels: 10,
      });

      expect(primitive.levels).toHaveLength(1);
    });

    it("admits both walls once they are far enough apart", () => {
      const strong = wall({ row: 100, ratio: 5, size: 1 });
      const far = wall({ row: 200, ratio: 1, size: 1 });
      const primitive = primitiveWith(gridWith([strong, far]), {
        minimumDistanceRows: 5,
        maxLevels: 10,
      });

      expect(primitive.levels).toHaveLength(2);
    });
  });

  it("stops exactly at maxLevels, not one more or one fewer", () => {
    const walls = Array.from({ length: 5 }, (_unused, index) =>
      wall({ row: index * 100, ratio: 5 - index, size: 1 }),
    );
    const primitive = primitiveWith(gridWith(walls), {
      maxLevels: 3,
      minimumDistanceRows: 1,
    });

    expect(primitive.levels).toHaveLength(3);
  });

  describe("malformed settings are normalized, not trusted", () => {
    it("clamps a NaN maxLevels back to the default instead of silently disabling the cap", () => {
      const walls = Array.from({ length: 25 }, (_unused, index) =>
        wall({ row: index * 100, ratio: 1, size: 1 }),
      );
      const primitive = new L2SupportResistancePrimitive();
      primitive.setSettings({
        ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
        maxLevels: Number.NaN,
        minimumDistanceRows: 1,
      });
      primitive.setGrid(gridWith(walls));

      expect(primitive.settings.maxLevels).toBe(
        DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.maxLevels,
      );
      expect(primitive.levels).toHaveLength(
        DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.maxLevels,
      );
    });

    it("falls back to the default color for an unusable persisted color value", () => {
      const primitive = new L2SupportResistancePrimitive();
      primitive.setSettings({
        ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
        bidColor: "not-a-color",
      });

      expect(primitive.settings.bidColor).toBe(
        DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS.bidColor,
      );
    });

    it("normalizeL2SupportResistanceSettings clamps out-of-range integers into their declared UI range", () => {
      const normalized = normalizeL2SupportResistanceSettings({
        maxLevels: 999,
        minimumDistanceRows: -5,
        lookbackMinutes: 0,
      });

      expect(normalized.maxLevels).toBe(20);
      expect(normalized.minimumDistanceRows).toBe(1);
      expect(normalized.lookbackMinutes).toBe(1);
    });
  });

  it("picks up new walls once the grid version advances and refresh runs, and skips redundant rebuilds otherwise", () => {
    const grid = new LiquidityGrid();
    applyLevels(grid, { seq: 1, reset: true, walls: [wall({ row: 100 })] });
    const primitive = new L2SupportResistancePrimitive();
    primitive.setGrid(grid);
    expect(primitive.levels).toHaveLength(1);
    const firstLevels = primitive.levels;

    primitive.refresh();
    expect(primitive.levels).toBe(firstLevels);

    applyLevels(grid, {
      seq: 2,
      reset: false,
      ts: T + 1000,
      walls: [wall({ row: 100 }), wall({ row: 300 })],
    });
    primitive.refresh();

    expect(primitive.levels).toHaveLength(2);
    expect(primitive.levels).not.toBe(firstLevels);
  });

  it("does not rebuild its levels when the chart hands it the grid it already has (report 57 W4)", () => {
    const grid = gridWith([wall({ row: 100 })]);
    const primitive = primitiveWith(grid);
    const levels = primitive.levels;
    primitive.setGrid(grid);
    expect(primitive.levels).toBe(levels);
    primitive.setGrid(gridWith([wall({ row: 100 })]));
    expect(primitive.levels).not.toBe(levels);
  });
});
