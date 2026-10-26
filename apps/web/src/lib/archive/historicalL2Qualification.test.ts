// @vitest-environment jsdom
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistoricalL2Client, HISTORICAL_L2_PROFILES, type HistoricalL2Page, type HistoricalL2Query } from "./historicalL2Client";
import { HistoricalL2States } from "./historicalL2States";
import { historicalBookL2 } from "./historicalBookL2";
import { historicalBookLiquidity } from "./historicalBookLiquidity";
import { historicalWallL2 } from "./historicalWallL2";
import { historicalPrints } from "./historicalPrints";
import { HistoricalLiquidityGrid } from "./historicalLiquidityGrid";
import { createIndicatorRuntime } from "../chart/indicatorRuntime";
import { HISTORICAL_INDICATOR_POLICIES, INDICATOR_REGISTRY, RUNTIME_INDICATOR_DEFS, historicalIndicatorAvailability } from "../chart/indicatorRegistry";
import { resetDrawRegistryForTests } from "../chart/draw/registry";
import { L2SupportResistancePrimitive } from "../indicators/l2-support-resistance/l2SupportResistancePrimitive";
import { WhaleWallStore } from "../indicators/whale-limit-order-heatmap/wallStore";
import type { BarFrame } from "../../types/frames";
import type { ArchivePage } from "./archiveClient";
import { archivePageBars } from "./archiveChartBars";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import { historicalLiquidityDefaults } from "./historicalL2Settings";
import { computeHeatmapLayout } from "../indicators/passive-liquidity/liquidityHeatmapLayout";
import { LiquidityHeatRenderer } from "../indicators/passive-liquidity/liquidityHeatRenderer";
import { parseRgb } from "../indicators/passive-liquidity/liquidityHeatmapHost";

// Operator evidence stays outside Git. This checks real transport data, not visual chart acceptance.
const capturePath = process.env.TT_HISTORICAL_L2_CAPTURE;
const capture = capturePath ? JSON.parse(readFileSync(capturePath, "utf8")) as {
  catalog: unknown; captures: { query: HistoricalL2Query; pages: HistoricalL2Page[] }[];
  candles?: { instrument: string; page: ArchivePage }[];
} : null;
const measurements: unknown[] = [];
afterEach(() => { resetDrawRegistryForTests(); vi.restoreAllMocks(); });

describe("production-data historical L2 qualification", () => {
  it("every L2 indicator replays from the qualified L2 inputs unless its policy says why not, and the Iceberg Detector, Exhaustion, Initiative Continuation, the Aggressive Orders Profile and Live Range Control say why not", () => {
    const qualified = new Set(["ohlcv", "l2_states", "l2_walls", "l2_prints"] as const);
    const allL2 = INDICATOR_REGISTRY.filter((def) => def.category === "l2");
    expect(allL2).toHaveLength(17);
    const unavailable = allL2.filter((def) => HISTORICAL_INDICATOR_POLICIES[def.id].unavailableReason !== undefined);
    expect(unavailable.map((def) => def.id).sort()).toEqual(["aggressiveOrdersProfile", "exhaustion", "icebergDetector", "initiative", "liveRangeControl"]);
    for (const def of allL2) if (!unavailable.includes(def)) expect(historicalIndicatorAvailability(def.id, qualified, "DATABENTO").available).toBe(true);
    expect(historicalIndicatorAvailability("icebergDetector", qualified, "DATABENTO")).toEqual({ available: false, reason: HISTORICAL_INDICATOR_POLICIES.icebergDetector.unavailableReason });
    expect(historicalIndicatorAvailability("exhaustion", qualified, "DATABENTO")).toEqual({ available: false, reason: HISTORICAL_INDICATOR_POLICIES.exhaustion.unavailableReason });
    expect(historicalIndicatorAvailability("initiative", qualified, "DATABENTO")).toEqual({ available: false, reason: HISTORICAL_INDICATOR_POLICIES.initiative.unavailableReason });
    expect(historicalIndicatorAvailability("aggressiveOrdersProfile", qualified, "DATABENTO")).toEqual({ available: false, reason: HISTORICAL_INDICATOR_POLICIES.aggressiveOrdersProfile.unavailableReason });
    expect(historicalIndicatorAvailability("liveRangeControl", qualified, "DATABENTO")).toEqual({ available: false, reason: HISTORICAL_INDICATOR_POLICIES.liveRangeControl.unavailableReason });
  });

  it.runIf(capture !== null).each(HISTORICAL_L2_PROFILES)("admits and renders the qualified inputs for %s", async (instrument) => {
    const started = performance.now();
    const windows = new Map<string, HistoricalL2Page>();
    for (const family of ["states", "walls", "prints"] as const) {
      const input = capture!.captures.find((item) => item.query.instrumentId === instrument && item.query.family === family)!;
      let index = 0;
      const client = createHistoricalL2Client({ token: "qualification", fetchImpl: vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify(input.pages[index++]))) });
      windows.set(family, await client.window(input.query, { maxBytes: 64 * 1024 * 1024 }));
      expect(index).toBe(input.pages.length);
    }
    const admittedAt = performance.now(), states = windows.get("states")!, walls = windows.get("walls")!, prints = windows.get("prints")!;
    const fold = new HistoricalL2States(instrument, states.derivationId, states.tickSize);
    fold.push(states.rows);
    const individual = historicalPrints(prints.rows, fold.finish(), instrument, states.derivationId, states.asOfKey[0]);
    const seconds = individual.seconds, tick = Number(states.tickSize);
    const depth = historicalBookL2(seconds, tick, 1);
    const source = historicalWallL2(depth, walls.rows, 1, { id: walls.wallProfileId!, sampleMs: 1000,
      minimumSize: Number((walls.wallProfile!.tracker as { minSize: number }).minSize) });
    const identity = JSON.parse(instrument) as string[];
    const liquidity = historicalBookLiquidity(seconds, tick, 1, identity[1] === "FUTURE" ? "contracts" : "shares");
    const grid = new HistoricalLiquidityGrid(liquidity, source, instrument);
    expect(grid.columns.length).toBeGreaterThan(0);
    expect(source.trusted()).toBe(true);
    expect(individual.tape.prints.length).toBeGreaterThan(0);
    expect(individual.tape.clockMs()).toBe(Number(BigInt(states.asOfKey[0]) / 1000000n));
    const levelPrimitive = new L2SupportResistancePrimitive();
    levelPrimitive.setSource(source, grid); levelPrimitive.updateAllViews();
    expect(levelPrimitive.sourceStatus).toContain("INDEXED WALLS");
    const whales = new WhaleWallStore();
    whales.addHistorical(source.historicalWalls!(), tick, source.notionalMultiplier!);
    expect(whales.size + whales.standingCount).toBe(source.historicalWalls!().filter((wall) => wall.endTs === null || wall.endedBy !== null).length);
    // Use captured provider candles when supplied; older captures retain synthetic compatibility contexts.
    const selected = HISTORICAL_INSTRUMENTS.find((item) => item.symbol === identity[2]
      || item.group === "Futures" && identity[2].startsWith(item.symbol))!;
    const realCandles = capture!.candles?.find((item) => item.instrument === instrument);
    const bars: readonly BarFrame[] = realCandles !== undefined ? archivePageBars(selected, "1m", realCandles.page)
      : seconds.filter((second) => second.column !== null).filter((_s, index) => index % 60 === 0)
      .map((second) => {
        const column = second.column!, mid = (column.lo + column.hi) / 2 * tick;
        return { type: "bar", symbol: identity[2], provider: "DATABENTO", assetClass: identity[1] as "FUTURE" | "EQUITY",
          interval_ms: 60000, ts_open: column.ts, open: mid, high: mid + tick, low: mid - tick, close: mid,
          volume: 10, buy_volume: 5, trade_count: 1, closed: true } as BarFrame;
      });
    let paintedPixels: number | null = null;
    if (realCandles !== undefined) {
      expect(bars.length).toBeGreaterThanOrEqual(15);
      const settings = historicalLiquidityDefaults(selected), width = 1000, height = 500;
      const high = Math.max(...bars.map((bar) => bar.high)) + tick * 3, low = Math.min(...bars.map((bar) => bar.low)) - tick * 3;
      const spacing = width / 16;
      const chart = { timeScale: () => ({ timeToIndex: () => bars.length - 1, logicalToCoordinate: () => width - spacing,
        options: () => ({ barSpacing: spacing }), width: () => width }), paneSize: () => ({ width, height }) };
      const series = { data: () => bars.map((bar) => ({ time: bar.ts_open / 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
        coordinateToPrice: (y: number) => high - y / height * (high - low), priceToCoordinate: (price: number) => (high - price) / (high - low) * height };
      const layout = computeHeatmapLayout(chart as never, series as never, grid, settings);
      expect(layout).not.toBeNull();
      const images: Uint8ClampedArray[] = [];
      const offscreen = { canvas: {}, putImageData: vi.fn((image: ImageData) => images.push(image.data)) };
      const host = { grid, layout, settings, bidRgb: parseRgb(settings.bidColor, settings.bidColor), askRgb: parseRgb(settings.askColor, settings.askColor),
        raster: () => null, offscreen: () => offscreen as unknown as CanvasRenderingContext2D, scheduleRepaint: () => {},
        imageBuffer: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData };
      const renderer = new LiquidityHeatRenderer(host);
      renderer.draw({ useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context: { drawImage: vi.fn() },
        bitmapSize: { width, height }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }) } as never);
      paintedPixels = images.reduce((total, image) => total + image.filter((_value, index) => index % 4 === 3 && image[index] > 0).length, 0);
      expect(paintedPixels).toBeGreaterThan(0);
    }
    const defs = RUNTIME_INDICATOR_DEFS.filter((def) => def.category === "l2" || ["rsi", "orderFlow"].includes(def.id));
    const faults = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = createIndicatorRuntime(defs), ids = new Set(defs.map((def) => def.id));
    runtime.setL2(source); runtime.setLiquidity(liquidity);
    const constructedAt = performance.now(), replayTimes: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const at = performance.now(); runtime.setActiveAndReplay(ids, {}, bars); replayTimes.push(performance.now() - at);
      for (const def of defs) {
        const output = runtime.getOutput(def.id); expect(output).not.toBeNull();
        for (const values of Object.values(output!)) expect(values.every((v) => v === null || Number.isFinite(v))).toBe(true);
      }
    }
    expect(faults).not.toHaveBeenCalled();
    runtime.setActive(new Set(), {}, []);
    measurements.push({ instrument, seconds: seconds.length, sourcePrints: prints.rows.length, wallSamples: walls.rows.length,
      unknownPrints: individual.unknownCount, codecMs: admittedAt - started, adapterMs: constructedAt - admittedAt,
      runtimeIds: [...ids], replayTimes, syntheticCandles: realCandles === undefined, paintedPixels });
    if (process.env.TT_HISTORICAL_L2_BROWSER_REPORT) writeFileSync(process.env.TT_HISTORICAL_L2_BROWSER_REPORT,
      JSON.stringify({ cases: measurements, visualAcceptance: "not assessed" }, null, 2));
  }, 120000);
});
