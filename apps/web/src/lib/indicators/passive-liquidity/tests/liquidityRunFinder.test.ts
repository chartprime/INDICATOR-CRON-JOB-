import { describe, expect, it, vi } from "vitest";
import type { LiquidityFrame, LiquidityLevel } from "../../../../types/frames";
import { bandSizeCache } from "../liquidityBandSizes";
import { LiquidityGrid } from "../liquidityGrid";
import type { HeatmapLayout } from "../liquidityHeatmapLayout";
import { createRunFinder, HISTORY_RESCAN_MS, showsFate } from "../liquidityRunFinder";
import { DEFAULT_RUN_CLOCKS } from "../liquidityRuns";
import type { OhlcBar } from "../liquidityRuns";

const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock("../liquidityRuns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../liquidityRuns")>();
  return {
    ...actual,
    createRunScanner: (...args: Parameters<typeof actual.createRunScanner>) => {
      scans.count += 1;
      return actual.createRunScanner(...args);
    },
  };
});
import { DEFAULT_LIQUIDITY_SETTINGS, QUIET_FLOOR_MULTIPLE, type LiquiditySettings } from "../liquiditySettings";

const T = 1_700_000_000_000;
/** A fixed colour scale, so the floors are plain arithmetic instead of a running percentile. */
const FIXED: Partial<LiquiditySettings> = { scaleMode: "fixed", scaleSize: 10, clusterRows: 2, quietBands: 1 };

/** One reset frame over rows 100..104 (so the column's mid row is 102, band 51 at two rows a band). */
function gridWith(provider: string, symbol: string, bid: [number, number][], ask: [number, number][] = [], levels?: LiquidityLevel[], later: { ts: number; bid: [number, number][] }[] = []): LiquidityGrid {
  const grid = new LiquidityGrid();
  grid.apply({
    type: "liquidity",
    provider,
    marketKind: provider === "DXFEED" ? "FUTURE" : "PERPETUAL",
    assetClass: "FUTURE",
    symbol,
    ts: T,
    seq: 1,
    reset: true,
    row_width: 2,
    column_ms: 1000,
    columns: [{ ts: T, lo: 100, hi: 104, bid, ask }, ...later.map((column) => ({ ts: column.ts, lo: 100, hi: 104, bid: column.bid, ask: [] }))],
    levels,
  } as unknown as LiquidityFrame);
  return grid;
}

// The layout carries the yardstick of the rows drawn: under FIXED that is the scale size itself.
function layoutFor(grid: LiquidityGrid, clusterRows: number, intervalMs = 60_000, clocks = DEFAULT_RUN_CLOCKS, reference = FIXED.scaleSize as number): HeatmapLayout {
  return {
    grid,
    lane: 0,
    history: null,
    historyWant: null,
    originX: 0,
    originMs: T,
    pxPerMs: 1,
    rowWidth: grid.rowWidth,
    clusterRows,
    bands: [],
    tiers: [{ columns: grid.columns, columnMs: grid.columnMs, from: 0, to: grid.columns.length, scanTo: grid.columns.length }],
    bars: [],
    intervalMs,
    cellMs: 0,
    clocks,
    reference,
    ladder: [],
    ladderMax: 0,
    freeRight: 0, gaps: [],
  };
}

function finderFor(grid: LiquidityGrid, patch: Partial<LiquiditySettings> = FIXED) {
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...patch };
  return { finder: createRunFinder(grid, layoutFor(grid, settings.clusterRows), settings), settings };
}

describe("createRunFinder", () => {
  it("keeps historical automatic floors anchored to each column's captured reference", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 10]]);
    const oldColumn = { ...grid.columns[0], reference: 5, median: 2.5 };
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "auto" as const, clusterRows: 2, quietBands: 0 };
    const layout = { ...layoutFor(grid, 2), reference: 100 };
    const finder = createRunFinder(grid, layout, settings);
    expect(finder.floorsAt(oldColumn, 50, false).paint).toBeCloseTo(settings.heatFloor * 5 * 2);
  });

  it("raises the trader's floor with the chart's bar on crypto, where a wider band sums more rows, and leaves it on an index", () => {
    // Fixed scale 10 at a heat floor of 0.4 and two rows a band: the paint floor is 8, so a floor of 4 does nothing on a
    // minute chart; on an hourly chart (x8) the floor is 32 and it is what a level must hold. Band 45 is clear of the
    // quiet zone around the column's mid.
    const crypto = gridWith("BINANCE", "BTC-USDT", [[0, 10]]);
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, minBandSize: 4 };
    expect(createRunFinder(crypto, layoutFor(crypto, 2), settings).floorsAt(crypto.columns[0], 45, false).paint).toBe(8);
    expect(createRunFinder(crypto, layoutFor(crypto, 2, 3_600_000), settings).floorsAt(crypto.columns[0], 45, false).paint).toBe(32);
    const index = gridWith("DXFEED", "/NQU26:XCME", [[0, 10]]);
    const indexSettings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, minBandSize: 50 };
    expect(createRunFinder(index, layoutFor(index, 2, 3_600_000), indexSettings).floorsAt(index.columns[0], 45, false).paint).toBe(50);
  });

  it("feeds the kept scan in time order across tiers: the host's columns filling a hole between the runtime's end a level where it left", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 30]], [], undefined, [{ ts: T + 40_000, bid: [[0, 30]] }, { ts: T + 41_000, bid: [[0, 30]] }]);
    const filler = [30, 30, 0].map((size, i) => ({ ts: T + 10_000 * (i + 1), lo: 100, hi: 104, bid: Float64Array.of(size, 0, 0, 0, 0), ask: new Float64Array(5), reference: 10 }));
    const base = layoutFor(grid, 2);
    const layout: HeatmapLayout = { ...base, tiers: [{ columns: filler, columnMs: 10_000, from: 0, to: 3, scanTo: 3 }, ...base.tiers], bars: [{ time: T + 60_000, high: 300, low: 290, close: 295 }] };
    const runs = createRunFinder(grid, layout, { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, quietBands: 0 }).runsFor(50, "bid");
    expect(runs.map((segment) => [segment.startTs - T, segment.endTs - T, segment.fate])).toEqual([[0, 30_000, "pulled"], [40_000, 42_000, "resting"]]);
  });

  it("reads a band the way its market does: crypto sums the rows, an index takes the biggest", () => {
    const rows: [number, number][] = [[0, 3], [1, 4]]; // rows 100 and 101, one band at two rows
    expect(finderFor(gridWith("BINANCE", "BTC-USDT", rows)).finder.sizesAt(gridWith("BINANCE", "BTC-USDT", rows).columns[0], 50)).toEqual({ bid: 7, ask: 0 });
    const index = gridWith("DXFEED", "/NQU26:XCME", rows);
    expect(finderFor(index).finder.sizesAt(index.columns[0], 50)).toEqual({ bid: 4, ask: 0 });
  });

  it("raises the floor a level needs to APPEAR near price, never the floor a standing level needs", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 3]]);
    const { finder } = finderFor(grid);
    const column = grid.columns[0];
    const plain = 0.4 * 10 * 2; // heatFloor x the fixed scale x the rows in a band
    // Far from the mid: the ordinary floor, standing or not.
    expect(finder.floorsAt(column, 48, false).paint).toBeCloseTo(plain);
    expect(finder.floorsAt(column, 48, true).paint).toBeCloseTo(plain);
    // Band 51 holds the column's mid: churn there has to clear the quiet multiple to appear...
    expect(finder.floorsAt(column, 51, false).paint).toBeCloseTo(plain * QUIET_FLOOR_MULTIPLE);
    // ... but a level already standing keeps its ordinary floor when price comes to it.
    expect(finder.floorsAt(column, 51, true).paint).toBeCloseTo(plain);
    // The link floor is half the paint floor, so a level that thins stays one level.
    expect(finder.floorsAt(column, 51, true).link).toBeCloseTo(plain / 2);
  });

  it("gives a level the server tracks no pass through the quiet zone: the server's bar for a wall is not the trader's", () => {
    // 2026-09-15: inside the zone, 98% of what NQ painted and 81% of what ES painted was there only because the server
    // tracked a "wall" on that band, at 1.5x a 95th-percentile row of 5 contracts. The zone hid nothing near price.
    const wall = { side: "bid", row: 102, span: 1, start_ts: T - 1000, end_ts: null, size: 9, peak: 9, ended_by: null, ratio: 3, chain: 0, fill: 0, eaten: 0, absorbing: false } as LiquidityLevel;
    const grid = gridWith("BINANCE", "BTC-USDT", [[2, 9]], [], [wall]);
    const { finder } = finderFor(grid);
    expect(finder.floorsAt(grid.columns[0], 51, false).paint).toBeCloseTo(0.4 * 10 * 2 * QUIET_FLOOR_MULTIPLE);
    // Once it stands, it keeps its ordinary floor like any other run.
    expect(finder.floorsAt(grid.columns[0], 51, true).paint).toBeCloseTo(0.4 * 10 * 2);
  });

  it("finds the runs of a band, still standing at the end of the data", () => {
    // 40 clears the quiet zone at this band (the plain floor is 8, quadrupled near the mid).
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const runs = finderFor(grid).finder.runsFor(50, "bid");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ startTs: T, endTs: T + 1000, fate: "resting", peak: 40 });
  });

  it("reads each side of a band from its own side of the book", () => {
    const bidOnly = finderFor(gridWith("BINANCE", "BTC-USDT", [[0, 40]])).finder;
    expect([bidOnly.runsFor(50, "bid").length, bidOnly.runsFor(50, "ask").length]).toEqual([1, 0]);
    const askOnly = finderFor(gridWith("BINANCE", "BTC-USDT", [], [[4, 40]])).finder;
    expect([askOnly.runsFor(52, "bid").length, askOnly.runsFor(52, "ask").length]).toEqual([0, 1]);
  });

  it("judges the runs by the layout's clocks: a run under the minimum is dropped, and the ledger is matched within the layout's window", () => {
    // 40 stands one second and is gone; a wall the server saw eaten ended 90 s later.
    const eaten: LiquidityLevel = { side: "bid", row: 100, span: 1, start_ts: T, end_ts: T + 91_000, size: 0, peak: 40, ended_by: "filled", ratio: 0, chain: 0, fill: 0, eaten: 0.9, absorbing: false };
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]], [], [eaten], [{ ts: T + 1000, bid: [[0, 0]] }]);
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED };
    expect(createRunFinder(grid, layoutFor(grid, 2), settings).runsFor(50, "bid")[0]).toMatchObject({ fate: "pulled", fill: null });
    expect(createRunFinder(grid, layoutFor(grid, 2, 60_000, { ...DEFAULT_RUN_CLOCKS, matchMs: 120_000 }), settings).runsFor(50, "bid")[0]).toMatchObject({ fate: "consumed", fill: 0.9 });
    expect(createRunFinder(grid, layoutFor(grid, 2, 60_000, { ...DEFAULT_RUN_CLOCKS, minRunMs: 5_000 }), settings).runsFor(50, "bid")).toEqual([]);
  });

  it("asks the candles about the drawn tier's prices: on a coarse layout a band's touch is judged at the coarse row width", () => {
    // Coarse rows of 4: band 50 is prices 200..204, which the candle printed in; on the fine rows it would be 100..102, which it did not.
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const coarse = (ts: number, size: number) => ({ ts, lo: 50, hi: 52, bid: Float64Array.from([size, 0, 0]), ask: new Float64Array(3) });
    const columns = [coarse(T, 40), coarse(T + 1000, 0)];
    const layout = { ...layoutFor(grid, 1), rowWidth: 4, tiers: [{ columns, columnMs: 1000, from: 0, to: 2, scanTo: 2 }], bars: [{ time: T, low: 201, high: 203, close: 202 }] };
    const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, clusterRows: 1, quietBands: 0 };
    expect(createRunFinder(grid, layout, settings).runsFor(50, "bid")[0]).toMatchObject({ fate: "consumed", reach: "touch" });
    expect(createRunFinder(grid, { ...layout, rowWidth: 2 }, settings).runsFor(50, "bid")[0]).toMatchObject({ fate: "pulled" });
  });

  it("draws nothing where the quiet zone swallows the churn at the top of the book", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 30]]); // over the plain floor, under the quiet one
    expect(finderFor(grid).finder.runsFor(50, "bid")).toEqual([]);
  });
});

describe("showsFate", () => {
  const settings = (patch: Partial<LiquiditySettings>) => ({ ...DEFAULT_LIQUIDITY_SETTINGS, ...patch });

  it("follows the Show filter for resting and consumed levels", () => {
    expect(showsFate(settings({ levelFilter: "all" }), "resting")).toBe(true);
    expect(showsFate(settings({ levelFilter: "resting" }), "consumed")).toBe(false);
    expect(showsFate(settings({ levelFilter: "consumed" }), "resting")).toBe(false);
    expect(showsFate(settings({ levelFilter: "consumed" }), "consumed")).toBe(true);
  });

  it("gives pulled levels their own switch, independent of the filter", () => {
    expect(showsFate(settings({ levelFilter: "resting", showPulled: true }), "pulled")).toBe(true);
    expect(showsFate(settings({ levelFilter: "all", showPulled: false }), "pulled")).toBe(false);
  });
});

describe("createRunFinder across repaints", () => {
  // Gate E Block 6: every repaint and every hover rebuilt every band's runs
  // over the whole retained span (23.5% of the busiest frame). Runs depend on
  // the grid, the candles, the scale inputs and the settings, never on where
  // the view sits, so a repaint that changes none of those reuses them.
  const column = (ts: number, size: number) => ({ ts, lo: 100, hi: 104, bid: [[0, size]] as [number, number][], ask: [] as [number, number][] });
  const frame = (seq: number, columns: ReturnType<typeof column>[]) => ({
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", assetClass: "FUTURE", symbol: "BTC-USDT",
    ts: columns[columns.length - 1].ts, seq, reset: false, row_width: 2, column_ms: 1000, columns,
  }) as unknown as LiquidityFrame;
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED };
  const candle: OhlcBar = { time: T, high: 210, low: 200, close: 205 };

  function setup() {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 30]]);
    const layout = (patch: Partial<HeatmapLayout> = {}): HeatmapLayout => ({ ...layoutFor(grid, 2), bars: [{ ...candle }], ...patch });
    const scanned = (at: HeatmapLayout, with_ = settings) => {
      const before = scans.count;
      const finder = createRunFinder(grid, at, with_);
      finder.runsFor(50, "bid");
      finder.runsFor(50, "bid");
      return scans.count - before;
    };
    return { grid, layout, scanned };
  }

  it("reuses the runs of a repaint that changes nothing they depend on, wherever the view sits", () => {
    const { layout, scanned } = setup();
    expect(scanned(layout())).toBe(1);
    expect(scanned(layout())).toBe(0);
    expect(scanned({ ...layout(), originX: 400, pxPerMs: 3, tiers: layout().tiers.map((tier) => ({ ...tier, from: 0, to: 0 })) })).toBe(0);
    expect(scanned(layout(), { ...settings })).toBe(0);
  });

  it("reuses the runs while the live candle ticks inside the bands it already touches", () => {
    const { layout, scanned } = setup();
    expect(scanned(layout())).toBe(1);
    expect(scanned(layout({ bars: [{ ...candle, close: 201 }] }))).toBe(0);
    expect(scanned(layout({ bars: [{ ...candle, high: 211, low: 201, close: 209 }] }))).toBe(0);
  });

  it("scans again only when what the settled columns are judged by changes, and answers from the kept scan otherwise", () => {
    const { grid, layout, scanned } = setup();
    const fresh = (at: HeatmapLayout, with_ = settings) => {
      const alone = { provider: grid.provider, symbol: grid.symbol, marketKind: grid.marketKind, levels: grid.levels, version: grid.version, epoch: grid.epoch } as unknown as LiquidityGrid;
      return JSON.stringify(createRunFinder(alone, at, with_).runsFor(50, "bid"));
    };
    const answer = (at: HeatmapLayout, with_ = settings) => JSON.stringify(createRunFinder(grid, at, with_).runsFor(50, "bid"));
    const later = { time: T + 60_000, high: 211, low: 201, close: 206 };
    const rescans: [string, () => [HeatmapLayout, typeof settings?]][] = [
      ["the candle interval", () => [layout({ intervalMs: 30_000 })]],
      ["the rows per band", () => [layout({ clusterRows: 1 })]],
      ["how far the tier is scanned", () => [layout({ tiers: [{ ...layout().tiers[0], scanTo: 0 }] })]],
      ["a setting", () => [layout(), { ...settings, minBandSize: 5 }]],
    ];
    const keeps: [string, () => [HeatmapLayout, typeof settings?]][] = [
      ["another candle", () => [layout({ bars: [{ ...candle }, later] })]],
      ["a candle that grew into another band", () => [layout({ bars: [{ ...candle, high: 220 }] })]],
      ["a candle that fell into another band", () => [layout({ bars: [{ ...candle, low: 190 }] })]],
      ["a candle that opened later", () => [layout({ bars: [{ ...candle, time: T + 60_000 }] })]],
      // Nothing settled here is floored by it: the one column is the live candle's, fed again each frame.
      ["the colour reference", () => [layout({ reference: 99 })]],
      ["the ladder's largest size", () => [layout({ ladderMax: 7 })]],
    ];
    for (const [what, make] of rescans) {
      scanned(layout());
      const [at, with_] = make();
      expect([what, scanned(at, with_)]).toEqual([what, 1]);
      expect([what, answer(at, with_)]).toEqual([what, fresh(at, with_)]);
    }
    for (const [what, make] of keeps) {
      scanned(layout());
      const [at, with_] = make();
      expect([what, scanned(at, with_)]).toEqual([what, 0]);
      expect([what, answer(at, with_)]).toEqual([what, fresh(at, with_)]);
    }

    scanned(layout({ bars: [{ ...candle }, later] }));
    const revised = layout({ bars: [{ ...candle, low: 150 }, later] });
    expect(["a closed candle revised", scanned(revised)]).toEqual(["a closed candle revised", 1]);
    expect(answer(revised)).toBe(fresh(revised));

    scanned(layout({ bars: [{ ...candle }, later] }));
    const moved = layout({ bars: [{ ...candle, time: T - 60_000 }, later] });
    expect(["a closed candle moved in time", scanned(moved)]).toEqual(["a closed candle moved in time", 1]);
    expect(answer(moved)).toBe(fresh(moved));

    scanned(layout());
    expect(grid.apply(frame(2, [column(T + 1_000, 30)]))).toBe(true);
    expect(["a new frame", scanned(layout())]).toEqual(["a new frame", 0]);
    expect(answer(layout())).toBe(fresh(layout()));

    scanned(layout());
    expect(grid.apply(frame(4, [column(T + 2_000, 30), column(T + 1_500, 30)]))).toBe(false);
    expect(["a frame that landed a column before it was refused", scanned(layout())]).toEqual(["a frame that landed a column before it was refused", 0]);
    expect(answer(layout())).toBe(fresh(layout()));
  });
});

describe("createRunFinder while host history lands", () => {
  // Pages of host history arrive every few hundred milliseconds and each one is a new
  // oldest tier. The kept scan is thrown away for that at most once per HISTORY_RESCAN_MS;
  // in between the frame answers from the scan it has.
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, clusterRows: 1, quietBands: 0 };
  const S = 1_000;
  const col = (ts: number, size: number) => ({ ts, lo: 50, hi: 52, bid: Float64Array.from([size, 0, 0]), ask: new Float64Array(3), reference: 10 });
  const fine = [col(T, 40), col(T + S, 40), col(T + 2 * S, 0)];
  const olderHistory = [col(T - 40 * S, 40), col(T - 30 * S, 40), col(T - 20 * S, 0), col(T - 10 * S, 40)];
  const history = olderHistory.slice(2);
  const grid = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", levels: [], version: 0, epoch: 0, columns: [], columnMs: S, rowWidth: 4, referenceSize: 10 };
  const layoutOf = (past: typeof fine): HeatmapLayout => ({
    ...layoutFor(grid as unknown as LiquidityGrid, 1),
    rowWidth: 4,
    tiers: [
      { columns: past as unknown as HeatmapLayout["tiers"][number]["columns"], columnMs: 10 * S, from: 0, to: past.length, scanTo: past.length },
      { columns: fine as unknown as HeatmapLayout["tiers"][number]["columns"], columnMs: S, from: 0, to: fine.length, scanTo: fine.length },
    ],
    bars: [{ time: T - 60 * S, low: 300, high: 310, close: 305 }, { time: T, low: 300, high: 310, close: 305 }],
  });
  const fresh = (past: typeof fine, at: HeatmapLayout = layoutOf(past)) => JSON.stringify(createRunFinder({ ...grid } as unknown as LiquidityGrid, at, settings).runsFor(50, "bid"));
  const runsAt = (own: typeof grid, past: typeof fine, at: number) => JSON.stringify(createRunFinder(own as unknown as LiquidityGrid, layoutOf(past), settings, at).runsFor(50, "bid"));

  it("answers from the kept scan while the history tier keeps changing, and scans again once the hold is over", () => {
    const own = { ...grid };
    const expectHistory = fresh(history);
    const expectOlder = fresh(olderHistory);
    expect(expectHistory).not.toBe(expectOlder);
    const before = scans.count;
    expect(runsAt(own, history, 1_000)).toBe(expectHistory);
    expect(scans.count - before).toBe(1);
    expect(runsAt(own, olderHistory, 1_000 + HISTORY_RESCAN_MS - 1)).toBe(expectHistory);
    expect(scans.count - before).toBe(1);
    expect(runsAt(own, olderHistory, 1_000 + HISTORY_RESCAN_MS)).toBe(expectOlder);
    expect(scans.count - before).toBe(2);
    expect(runsAt(own, olderHistory, 1_000 + HISTORY_RESCAN_MS + 50)).toBe(expectOlder);
    expect(scans.count - before).toBe(2);
  });

  it("scans again at once when the history tier appears or goes, or another tier changes", () => {
    const own = { ...grid };
    const without: HeatmapLayout = { ...layoutOf(history), tiers: layoutOf(history).tiers.slice(1) };
    const expectWithout = fresh(history, without);
    const before = scans.count;
    runsAt(own, history, 5_000);
    expect(scans.count - before).toBe(1);
    expect(JSON.stringify(createRunFinder(own as unknown as LiquidityGrid, without, settings, 5_010).runsFor(50, "bid"))).toBe(expectWithout);
    expect(scans.count - before).toBe(2);
    runsAt(own, history, 5_020);
    expect(scans.count - before).toBe(3);
    const otherFine: HeatmapLayout = { ...layoutOf(history), tiers: [layoutOf(history).tiers[0], { ...layoutOf(history).tiers[1], columns: fine.slice() as unknown as HeatmapLayout["tiers"][number]["columns"] }] };
    createRunFinder(own as unknown as LiquidityGrid, otherFine, settings, 5_030).runsFor(50, "bid");
    expect(scans.count - before).toBe(4);
  });
});

describe("createRunFinder and the live colour reference", () => {
  // A settled column that carries no yardstick of its own is floored by the live reference,
  // so the kept scan depends on it; one that carries its own does not.
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 1, quietBands: 0, scaleMode: "auto" as const, heatFloor: 0.5 };
  const S = 1_000;
  const col = (ts: number, size: number, reference?: number) => ({ ts, lo: 50, hi: 52, bid: Float64Array.from([size, 0, 0]), ask: new Float64Array(3), ...(reference === undefined ? {} : { reference }) });
  const grid = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", levels: [], version: 0, epoch: 0, columns: [], columnMs: S, rowWidth: 4, referenceSize: 10 };
  const layoutOf = (columns: ReturnType<typeof col>[], reference: number): HeatmapLayout => ({
    ...layoutFor(grid as unknown as LiquidityGrid, 1),
    rowWidth: 4,
    reference,
    tiers: [{ columns: columns as unknown as HeatmapLayout["tiers"][number]["columns"], columnMs: S, from: 0, to: columns.length, scanTo: columns.length }],
    bars: [{ time: T - 60 * S, low: 300, high: 310, close: 305 }, { time: T + 60 * S, low: 300, high: 310, close: 305 }],
  });

  it("scans again when the colour reference changes and a settled column had no yardstick of its own", () => {
    const own = { ...grid };
    const columns = [col(T, 8), col(T + S, 8), col(T + 2 * S, 8)];
    const before = scans.count;
    const low = createRunFinder(own as unknown as LiquidityGrid, layoutOf(columns, 10), settings).runsFor(50, "bid");
    expect(low).toHaveLength(1);
    expect(scans.count - before).toBe(1);
    const high = createRunFinder(own as unknown as LiquidityGrid, layoutOf(columns, 100), settings).runsFor(50, "bid");
    expect(high).toHaveLength(0);
    expect(scans.count - before).toBe(2);
  });

  it("keeps the scan across a reference change when every settled column carries its own yardstick", () => {
    const own = { ...grid };
    const columns = [col(T, 8, 10), col(T + S, 8, 10), col(T + 2 * S, 8, 10)];
    const before = scans.count;
    expect(createRunFinder(own as unknown as LiquidityGrid, layoutOf(columns, 10), settings).runsFor(50, "bid")).toHaveLength(1);
    expect(createRunFinder(own as unknown as LiquidityGrid, layoutOf(columns, 100), settings).runsFor(50, "bid")).toHaveLength(1);
    expect(scans.count - before).toBe(1);
  });
});

describe("createRunFinder keeps the settled scan across live frames", () => {
  // A chart that lives: a column a second, the live candle wandering, a candle closing
  // every minute, seconds skipped now and then, and after a while the fine ring letting
  // its oldest columns go while the deep tier reaches that much further. Every frame
  // must answer exactly as a scan of everything the chart ever held would, and the
  // settled columns must be scanned once per band side, never again.
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, clusterRows: 1, quietBands: 0 };
  const S = 1_000;
  const column = (ts: number, sizes: Record<number, number>): LiquidityColumnFixture => {
    const bid = new Float64Array(6);
    const ask = new Float64Array(6);
    for (const [row, size] of Object.entries(sizes)) {
      const index = Number(row) - 48;
      if (Number(row) < 51) bid[index] = size;
      else ask[index] = size;
    }
    return { ts, lo: 48, hi: 53, bid, ask, reference: 10 };
  };
  type LiquidityColumnFixture = { ts: number; lo: number; hi: number; bid: Float64Array; ask: Float64Array; reference: number };

  function seeded(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  it("answers every frame as a scan of everything the chart ever held would, scanning the settled columns once", () => {
    const random = seeded(7);
    const sizeOf = () => {
      const roll = random();
      return roll < 0.3 ? 0 : roll < 0.45 ? 6 : roll < 0.8 ? 12 : 20;
    };
    const deep: LiquidityColumnFixture[] = [];
    for (let i = 0; i < 120; i += 1) deep.push(column(T - 600 * S + i * 10 * S, { 49: sizeOf(), 50: sizeOf(), 52: sizeOf() }));
    const ring: LiquidityColumnFixture[] = [];
    const everything: LiquidityColumnFixture[] = [];
    const bars: OhlcBar[] = [{ time: T - 120 * S, low: 203, high: 205, close: 204 }, { time: T - 60 * S, low: 201, high: 206, close: 202 }];
    let live: OhlcBar = { time: T, low: 202, high: 204, close: 203 };
    const grid = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", levels: [], version: 0, epoch: 0, columns: [], columnMs: S, rowWidth: 4, referenceSize: 10 };
    const seam = T + S;
    const layoutOf = (fine: LiquidityColumnFixture[], deepScanTo: number, candles: OhlcBar[]): HeatmapLayout => ({
      ...layoutFor(grid as unknown as LiquidityGrid, 1),
      rowWidth: 4,
      tiers: [
        { columns: deep as unknown as HeatmapLayout["tiers"][number]["columns"], columnMs: 10 * S, from: 0, to: 0, scanTo: deepScanTo },
        { columns: fine as unknown as HeatmapLayout["tiers"][number]["columns"], columnMs: S, from: 0, to: fine.length, scanTo: fine.length },
      ],
      bars: candles,
    });
    const deepIndexAtOrAfter = (ts: number) => deep.findIndex((entry) => entry.ts >= ts) === -1 ? deep.length : deep.findIndex((entry) => entry.ts >= ts);
    const bands: [number, "bid" | "ask"][] = [[49, "bid"], [50, "bid"], [52, "ask"]];
    const answers = (finder: ReturnType<typeof createRunFinder>) => JSON.stringify(bands.map(([band, side]) => finder.runsFor(band, side)));
    const before = scans.count;
    let ts = T;
    let compared = 0;
    for (let step = 1; step <= 420; step += 1) {
      ts += random() < 0.05 ? 8 * S : random() < 0.1 ? 3 * S : S;
      const next = column(ts, { 49: sizeOf(), 50: sizeOf(), 52: sizeOf() });
      ring.push(next);
      everything.push(next);
      if (step % 7 === 0) live = { ...live, low: 196 + Math.floor(random() * 6), high: 204 + Math.floor(random() * 8) };
      if (ts >= live.time + 60 * S) {
        bars.push(live);
        live = { time: live.time + 60 * S, low: 200 + Math.floor(random() * 4), high: 205 + Math.floor(random() * 4), close: 203 };
      }
      if (step > 250) ring.splice(0, 1);
      grid.version += 1;
      const candles = [...bars, live];
      const incremental = createRunFinder(grid as unknown as LiquidityGrid, layoutOf(ring, deepIndexAtOrAfter(ring[0].ts), candles), settings);
      const alone = { ...grid } as unknown as LiquidityGrid;
      const truth = createRunFinder(alone, layoutOf(everything, deepIndexAtOrAfter(seam), candles), settings);
      expect([step, answers(incremental)]).toEqual([step, answers(truth)]);
      compared += 1;
    }
    expect(compared).toBe(420);
    expect(bars.length).toBeGreaterThan(6);
    expect(everything.length - ring.length).toBeGreaterThan(100);
    // The ring let go of more than a deep column's worth: the deep tier's cut moved later and the kept scan was not rebuilt for it.
    expect(deepIndexAtOrAfter(ring[0].ts)).toBeGreaterThan(deepIndexAtOrAfter(seam) + 5);
    // The settled scan was built once per band side; every later frame forked it.
    const incrementalScans = (scans.count - before) - 420 * bands.length;
    expect(incrementalScans).toBe(bands.length);
  });
});

describe("createRunFinder across live candle ticks", () => {
  const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, clusterRows: 1, quietBands: 0 };
  const coarse = (ts: number, size: number) => ({ ts, lo: 50, hi: 52, bid: Float64Array.from([size, 0, 0]), ask: new Float64Array(3) });
  const columns = [coarse(T, 40), coarse(T + 1000, 0)];
  const closed: OhlcBar = { time: T - 60_000, low: 300, high: 310, close: 305 };
  const ticks: { low: number; high: number; close: number }[] = [
    { low: 301, high: 303, close: 302 },
    { low: 301, high: 303, close: 305 },
    { low: 300, high: 303.5, close: 303 },
    { low: 201, high: 303, close: 202 },
    { low: 202, high: 303.5, close: 250 },
    { low: 301, high: 303, close: 302 },
    { low: 150, high: 190, close: 160 },
    { low: 150, high: 202, close: 160 },
  ];

  function layoutOf(grid: LiquidityGrid, live: { low: number; high: number; close: number }): HeatmapLayout {
    return {
      ...layoutFor(grid, 1),
      rowWidth: 4,
      tiers: [{ columns, columnMs: 1000, from: 0, to: 2, scanTo: 2 }],
      bars: [closed, { time: T, ...live }],
    };
  }

  const snapshot = (finder: ReturnType<typeof createRunFinder>) => JSON.stringify([49, 50, 51, 75, 76].flatMap((band) => [finder.runsFor(band, "bid"), finder.runsFor(band, "ask")]));

  it("answers every tick as a finder built from scratch would", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const fates: string[] = [];
    for (const tick of ticks) {
      const finder = createRunFinder(grid, layoutOf(grid, tick), settings);
      const fresh = createRunFinder(gridWith("BINANCE", "BTC-USDT", [[0, 40]]), layoutOf(grid, tick), settings);
      expect(snapshot(finder)).toBe(snapshot(fresh));
      fates.push(finder.runsFor(50, "bid")[0].fate);
    }
    expect(fates).toEqual(["pulled", "pulled", "pulled", "consumed", "consumed", "pulled", "pulled", "consumed"]);
  });

  it("keeps the same finder while a tick stays inside the bands the candle touches, and takes a new one when it enters or leaves a band", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const finders = ticks.map((tick) => createRunFinder(grid, layoutOf(grid, tick), settings));
    expect(finders.map((finder, index) => index === 0 || finder === finders[index - 1])).toEqual([true, true, true, false, true, false, false, false]);
  });

  it("follows a closed candle that changes", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const live = { time: T + 60_000, low: 301, high: 303, close: 302 };
    const layoutWith = (low: number, high: number): HeatmapLayout => ({ ...layoutOf(grid, ticks[0]), bars: [{ time: T, low, high, close: low }, live] });
    expect(createRunFinder(grid, layoutWith(300, 310), settings).runsFor(50, "bid")[0].fate).toBe("pulled");
    expect(createRunFinder(grid, layoutWith(201, 310), settings).runsFor(50, "bid")[0].fate).toBe("consumed");
    expect(createRunFinder(grid, layoutWith(150, 190), settings).runsFor(50, "bid")[0].fate).toBe("pulled");
    expect(createRunFinder(grid, layoutWith(150, 202), settings).runsFor(50, "bid")[0].fate).toBe("consumed");
  });

  it("scans once for the first tick and not again for ticks that touch the same bands", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const before = scans.count;
    for (const tick of ticks.slice(0, 3)) createRunFinder(grid, layoutOf(grid, tick), settings).runsFor(50, "bid");
    expect(scans.count - before).toBe(1);
  });

  const freshSnapshot = (tick: { low: number; high: number; close: number }) => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    return snapshot(createRunFinder(grid, layoutOf(grid, tick), settings));
  };

  it("answers a band it was first asked about after later ticks from the candle it was built with, as a finder built at the last tick would", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const built = createRunFinder(grid, layoutOf(grid, ticks[0]), settings);
    const later = createRunFinder(grid, layoutOf(grid, ticks[2]), settings);
    expect(later).toBe(built);
    expect(snapshot(built)).toBe(freshSnapshot(ticks[2]));
  });

  it("agrees with a finder built from scratch for candles whose edges sit on, just under and just over a band edge", () => {
    const edges = [195, 199.999999999, 200, 200.000000001, 203.999999999, 204, 204.000000001, 299.5, 300, 303.999999999, 304, 310];
    const pairs: [number, number][] = [];
    for (const low of edges) for (const high of edges) if (low <= high) pairs.push([low, high]);
    const tick = ([low, high]: [number, number]) => ({ low, high, close: low });
    let same = 0;
    let different = 0;
    pairs.forEach((pair, index) => {
      const partners: [number, number][] = [pairs[(index * 7 + 3) % pairs.length], [pair[0] + 1e-7, pair[1] - 1e-7]];
      for (const partner of partners) {
        if (partner[0] > partner[1]) continue;
        const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
        const first = createRunFinder(grid, layoutOf(grid, tick(pair)), settings);
        const second = createRunFinder(grid, layoutOf(grid, tick(partner)), settings);
        if (second === first) {
          same += 1;
          expect([pair, partner, snapshot(first)]).toEqual([pair, partner, freshSnapshot(tick(partner))]);
        } else different += 1;
      }
    });
    expect(same).toBeGreaterThan(10);
    expect(different).toBeGreaterThan(10);
  });

  it("puts a candle's edge in the right band where prices do not divide evenly into rows", () => {
    const uneven = { ...settings, clusterRows: 3 };
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const at = (low: number, high: number) => createRunFinder(grid, { ...layoutOf(grid, { low, high, close: low }), rowWidth: 0.1, clusterRows: 3 }, uneven);
    expect(at(0.9, 1.0)).toBe(at(0.9, 1.05));
    expect(at(0.9, 1.0)).toBe(at(0.9000001, 1.0));
    expect(at(0.9, 1.0)).not.toBe(at(0.8999999, 1.0));
    expect(at(0.9, 1.0)).not.toBe(at(0.9, 1.3));
    const flat = (low: number, high: number) => createRunFinder(grid, { ...layoutOf(grid, { low, high, close: low }), rowWidth: 0, clusterRows: 3 }, uneven);
    expect(flat(0.9, 1.0)).not.toBe(flat(0.9, 1.05));
  });

  it("does not hang on a candle beyond what a number can step through, and keys such a candle by its own values", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const huge = { low: 1e17, high: 1e17, close: 1e17 };
    const first = createRunFinder(grid, layoutOf(grid, huge), settings);
    expect(createRunFinder(grid, layoutOf(grid, { ...huge }), settings)).toBe(first);
    expect(createRunFinder(grid, layoutOf(grid, { low: 2e17, high: 2e17, close: 2e17 }), settings)).not.toBe(first);
  });

  it("takes a new finder when a bar closes and the next opens", () => {
    const grid = gridWith("BINANCE", "BTC-USDT", [[0, 40]]);
    const first = createRunFinder(grid, layoutOf(grid, ticks[0]), settings);
    const next = createRunFinder(grid, { ...layoutOf(grid, ticks[0]), bars: [closed, { time: T, ...ticks[0] }, { time: T + 60_000, low: 301, high: 303, close: 302 }] }, settings);
    expect(next).not.toBe(first);
  });
});

describe("createRunFinder with cached band sizes", () => {
  const LO = 40;
  const HI = 170;
  const MID = 105;

  function seeded(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function randomGrid(seed: number): LiquidityGrid {
    const random = seeded(seed);
    const walls = Array.from({ length: 10 }, () => ({ row: LO + Math.floor(random() * (HI - LO)), start: Math.floor(random() * 30), end: 8 + Math.floor(random() * 32) }));
    const columns = Array.from({ length: 40 }, (_, index) => {
      const bid: [number, number][] = [];
      const ask: [number, number][] = [];
      for (let row = LO; row <= HI; row += 1) {
        if (row === MID) continue;
        const wall = walls.some((entry) => entry.row === row && index >= entry.start && index < entry.end);
        const size = wall ? 60 + random() * 40 : random() * 5;
        (row < MID ? bid : ask).push([row - LO, Math.round(size * 100) / 100]);
      }
      return { ts: T + index * 1000, lo: LO, hi: HI, bid, ask };
    });
    const grid = new LiquidityGrid();
    grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", assetClass: "FUTURE", symbol: "BTC-USDT",
      ts: columns[columns.length - 1].ts, seq: columns.length, reset: true, row_width: 2, column_ms: 1000, columns, levels: [],
    } as unknown as LiquidityFrame);
    return grid;
  }

  const snapshot = (finder: ReturnType<typeof createRunFinder>, bands: number[]) => bands.flatMap((band) => [finder.runsFor(band, "bid"), finder.runsFor(band, "ask")]);

  it("finds the same runs as it does reading the style's sizes directly", () => {
    let runsSeen = 0;
    for (const seed of [1, 2, 3]) {
      for (const clusterRows of [1, 2, 4]) {
        const settings = { ...DEFAULT_LIQUIDITY_SETTINGS, ...FIXED, clusterRows, quietBands: 0 };
        const bands = Array.from({ length: Math.floor(HI / clusterRows) - Math.floor(LO / clusterRows) + 3 }, (_, index) => Math.floor(LO / clusterRows) - 1 + index);
        const cachedGrid = randomGrid(seed);
        const cached = snapshot(createRunFinder(cachedGrid, layoutFor(cachedGrid, clusterRows), settings), bands);
        const spy = vi.spyOn(bandSizeCache, "reader").mockImplementation((of, rows) => ({
          both: (column, band) => of(column, band, rows),
          side: (column, band, side) => of(column, band, rows)[side],
        }));
        const directGrid = randomGrid(seed);
        const direct = snapshot(createRunFinder(directGrid, layoutFor(directGrid, clusterRows), settings), bands);
        spy.mockRestore();
        expect([seed, clusterRows, cached]).toEqual([seed, clusterRows, direct]);
        runsSeen += cached.reduce((total, runs) => total + runs.length, 0);
      }
    }
    expect(runsSeen).toBeGreaterThan(20);
  });
});
