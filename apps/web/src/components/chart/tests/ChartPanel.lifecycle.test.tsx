// @vitest-environment jsdom
// Renamed from ChartPanel.integration.test.tsx by A2.20 (L1L2-V2-091). The
// mocks below are the right tool for what this file tests -- that ChartPanel
// creates, wires, updates and tears down its series and primitives in the
// right order -- but they mean nothing here touches the real charting library,
// so "integration" claimed coverage that did not exist. That gap is why
// L1L2-V2-090 (drawings vanishing on a timeframe switch) could not be caught
// internally: only the real library knows a time absent from the current
// series resolves to null. The real time-scale behaviour is now pinned
// separately in src/lib/lightweightChartsTimeScale.contract.test.ts.

import { act } from "react";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeriesMarkers } from "lightweight-charts";
import type {
  BarFrame,
  FrameIdentity,
  TradeFrame,
} from "../../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "../../../lib/chart/candleLifecycle";
import { KillzonesPrimitive } from "../../../lib/indicators/killzones/killzonesPrimitive";
import { RollMarkerPrimitive } from "../../../lib/chart/rollMarkerPrimitive";
import { SessionDeltaProfilePrimitive } from "../../../lib/indicators/session-delta-profile/sessionDeltaProfilePrimitive";
import { CvdDivergenceLabelsPrimitive } from "../../../lib/indicators/cvd-divergence/cvdDivergenceLabelsPrimitive";
import { DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS } from "../../../lib/indicators/cvd-divergence/cvdDivergenceIndicator";
import { smaIndicator } from "../../../lib/indicators/sma/sma";
import { DrawKernelPrimitive } from "../../../lib/chart/draw/kernelPrimitive";
import { AXIS_INSET_GAP_PX } from "../../../lib/chart/axisInset";
import { DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS } from "../../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickSettings";
import { L2Store } from "../../../lib/l2/l2Store";
import { LiquidityHeatmapPrimitive } from "../../../lib/indicators/passive-liquidity/liquidityHeatmapPrimitive";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../../lib/indicators/passive-liquidity/liquiditySettings";
import { BOOK_MAP_PROFILE_EDGE_GAP_PX, DEFAULT_L2_BOOK_MAP_SETTINGS, bookMapProfileWidthPx } from "../../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import { LiveDeltaProfilePrimitive } from "../../../lib/indicators/live-delta-profile/liveDeltaProfilePrimitive";
import { LiveOrderBookProfilePrimitive } from "../../../lib/indicators/live-order-book-profile/liveOrderBookProfilePrimitive";
import { LiquidityGrid } from "../../../lib/indicators/passive-liquidity/liquidityGrid";
import { AggressiveProfilePane } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfilePane";
import { AggressiveProfilePrimitive } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfilePrimitive";
import { RangePrintStore } from "../../../lib/indicators/aggressive-orders-profile/rangePrintStore";
import type { AggressiveProfileSource } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfileSource";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { VolumeDeltaProfileTickPrimitive } from "../../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickPrimitive";
import { VolumeProfilePrimitive } from "../../../lib/indicators/volume-profile/volumeProfilePrimitive";
import { NetDeltaProfilePrimitive } from "../../../lib/indicators/net-delta-profile/netDeltaProfilePrimitive";
import { DeltaProfilePrimitive } from "../../../lib/indicators/delta-profile/deltaProfilePrimitive";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
} from "../../../lib/indicators/session-profile/sessionProfileSettings";
import { SESSION_PROFILE_INDICATOR_ID } from "../../../lib/indicators/session-profile/sessionProfileIds";
import type { ProfileFrame } from "../../../types/frames";
import { WhaleLimitHeatmapPrimitive, type WhaleHit } from "../../../lib/indicators/whale-limit-order-heatmap/whalePrimitive";
import { IcebergPrimitive } from "../../../lib/indicators/iceberg-detector/icebergPrimitive";
import { WhaleMarkersPrimitive } from "../../../lib/indicators/whale-detector/whaleMarkersPrimitive";
import { L2BookMapPrimitive } from "../../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import { IcebergBook } from "../../../lib/l2/icebergBook";
import { ExhaustionBook } from "../../../lib/l2/exhaustionBook";
import { InitiativeBook } from "../../../lib/l2/initiativeBook";
import { InitiativePrimitive } from "../../../lib/indicators/initiative/initiativePrimitive";
import { DEFAULT_INITIATIVE_SETTINGS } from "../../../lib/indicators/initiative/initiativeSettings";
import { describeInitiative } from "../../../lib/indicators/initiative/initiativeHover";
import { ExhaustionPrimitive } from "../../../lib/indicators/exhaustion/exhaustionPrimitive";
import { DEFAULT_EXHAUSTION_SETTINGS } from "../../../lib/indicators/exhaustion/exhaustionSettings";
import { LiveRangePrimitive, type LiveRangeReport } from "../../../lib/indicators/live-range-control/liveRangePrimitive";
import { DEFAULT_LIVE_RANGE_SETTINGS } from "../../../lib/indicators/live-range-control/liveRangeSettings";
import type { LiveRangeWindow } from "../../../lib/indicators/live-range-control/liveRangeWindow";
import type { CandleMonitorEntry, CandleMonitorFrame, ExhaustionShade, ExhaustionShadesFrame, InitiativeBand, InitiativeBandsFrame } from "../../../types/frames";
import { describeExhaustion } from "../../../lib/indicators/exhaustion/exhaustionHover";
import { DEFAULT_WHALE_SETTINGS as DEFAULT_WHALE_HEATMAP_SETTINGS } from "../../../lib/indicators/whale-limit-order-heatmap/whaleSettings";
import { WHALE_CARD_WIDTH_PX } from "../../../lib/indicators/whale-limit-order-heatmap/whaleCardLayout";
import type { WhaleCard } from "../../../lib/indicators/whale-limit-order-heatmap/whaleCard";
import { WallHistoryStream } from "../../../lib/l2/wallHistoryStream";
import type { ChartPanelHandle, ChartPanelProps } from "../ChartPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chartMock = vi.hoisted(() => {
  const timeScale = {
    getVisibleRange: vi.fn<() => { from: number; to: number } | null>(
      () => null,
    ),
    setVisibleRange: vi.fn(),
    getVisibleLogicalRange: vi.fn<() => { from: number; to: number } | null>(
      () => null,
    ),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
  };
  const priceScale = { applyOptions: vi.fn(), width: vi.fn(() => 64) };
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    priceScale: vi.fn(() => priceScale),
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    getPane: vi.fn(() => ({ paneIndex: () => 0 })),
    barsInLogicalRange: vi.fn<
      () => { barsBefore: number; barsAfter: number } | null
    >(() => null),
    coordinateToPrice: vi.fn(() => null),
    priceFormatter: vi.fn(() => ({ format: (price: number) => price.toFixed(2) })),
  };
  const chart = {
    addSeries: vi.fn(() => series),
    removeSeries: vi.fn(),
    panes: vi.fn(() => []),
    options: vi.fn(() => ({ layout: { fontFamily: "Inter" } })),
    priceScale: vi.fn(() => priceScale),
    timeScale: vi.fn(() => timeScale),
    applyOptions: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    remove: vi.fn(),
  };
  return { chart, series, timeScale, priceScale };
});

const noLineCreateState = vi.hoisted(() => vi.fn(() => ({ calls: 0 })));
const l2Seen = vi.hoisted((): string[] => []);
const liquiditySeen = vi.hoisted((): string[] => []);
const ticksReplays = vi.hoisted(() => ({ count: 0 }));
const indicatorRuntimes = vi.hoisted((): import("../../../lib/chart/indicatorRuntime").IndicatorRuntime[] => []);
const historicallyAdmitted = vi.hoisted(() => new Set<string>());

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => chartMock.chart),
  createSeriesMarkers: vi.fn(() => ({ setMarkers: vi.fn(), detach: vi.fn() })),
  CandlestickSeries: "CandlestickSeries",
  LineSeries: "LineSeries",
  HistogramSeries: "HistogramSeries",
  ColorType: { Solid: "Solid" },
  CrosshairMode: { Normal: 0 },
  LineStyle: {
    Solid: 0,
    Dotted: 1,
    Dashed: 2,
    LargeDashed: 3,
    SparseDotted: 4,
  },
}));

vi.mock("../../../lib/chart/indicatorLiquidity", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/chart/indicatorLiquidity")>();
  return { ...mod, indicatorLiquidityOf: vi.fn(mod.indicatorLiquidityOf) };
});

vi.mock("../../../lib/chart/indicatorL2", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/chart/indicatorL2")>();
  return { ...mod, indicatorL2Of: vi.fn(mod.indicatorL2Of) };
});

vi.mock("../../../lib/chart/indicatorRuntime", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/chart/indicatorRuntime")>();
  return {
    ...mod,
    createIndicatorRuntime: (...args: Parameters<typeof mod.createIndicatorRuntime>) => {
      const runtime = mod.createIndicatorRuntime(...args);
      indicatorRuntimes.push(runtime);
      return runtime;
    },
  };
});

vi.mock("../../../lib/chart/indicatorRegistry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../lib/chart/indicatorRegistry")
    >();
  const { draw } = await import("../../../lib/chart/draw");
  const brokenAfterTwoCalls = {
    kind: "runtime" as const,
    id: "brokenTestOnly" as const,
    label: "Broken (test only)",
    category: "technical" as const,
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" as const },
    createState: () => ({ calls: 0 }),
    onBar: (ctx: { state: { calls: number } }) => {
      ctx.state.calls += 1;
      if (ctx.state.calls > 2) throw new Error("boom");
    },
    readOutput: (state: { calls: number }) => ({ value: state.calls }),
  };
  const sharedTestOnly = {
    kind: "runtime" as const,
    id: "sharedTestOnly" as const,
    label: "Shared (test only)",
    category: "technical" as const,
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "sharedPane" as const, withIndicatorId: "rsi" },
    createState: () => ({ value: 1 }),
    onBar: () => {},
    readOutput: (state: { value: number }) => ({ value: state.value }),
  };
  const gatedTestOnly = {
    kind: "runtime" as const,
    id: "gatedTestOnly" as const,
    label: "Gated (test only)",
    category: "technical" as const,
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" as const },
    timeframeGate: (intervalMs: number) => intervalMs <= 60_000,
    createState: () => ({ value: 1 }),
    onBar: () => {},
    readOutput: (state: { value: number }) => ({ value: state.value }),
  };
  const tableTestOnly = {
    kind: "runtime" as const,
    id: "tableTestOnly" as const,
    label: "Table (test only)",
    category: "technical" as const,
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" as const },
    createState: () => ({ table: draw.table(), bars: 0 }),
    onBar: (ctx: {
      state: { table: ReturnType<typeof draw.table>; bars: number };
    }) => {
      ctx.state.bars += 1;
      ctx.state.table.cell(0, 0, { text: "VPIN" });
      ctx.state.table.cell(0, 1, { text: String(ctx.state.bars) });
    },
    readOutput: (state: { bars: number }) => ({ value: state.bars }),
  };
  const bottomTableTestOnly = {
    ...tableTestOnly,
    id: "bottomTableTestOnly" as const,
    label: "Bottom table (test only)",
    createState: () => ({ table: draw.table({ position: "bottom-right" }), bars: 0 }),
  };
  const noLineTestOnly = {
    kind: "runtime" as const,
    id: "noLineTestOnly" as const,
    label: "No line (test only)",
    category: "technical" as const,
    defaultSettings: {},
    lines: [],
    placement: { kind: "overlay" as const },
    createState: noLineCreateState,
    onBar: () => {},
    readOutput: () => ({}),
  };
  // Records which L2 source each call saw. Historical Mode admits it (no real
  // L2 indicator is available there until J1), so the source switch is visible.
  const l2ProbeTestOnly = {
    kind: "runtime" as const,
    id: "l2ProbeTestOnly" as const,
    label: "L2 probe (test only)",
    category: "l2" as const,
    defaultSettings: {},
    lines: [],
    placement: { kind: "overlay" as const },
    createState: () => ({}),
    onBar: (ctx: { l2?: { availability: string }; liquidity?: { baseAsset: string } }) => {
      l2Seen.push(ctx.l2?.availability ?? "none");
      liquiditySeen.push(ctx.liquidity?.baseAsset ?? "none");
    },
    readOutput: () => ({}),
  };
  // Counts its replays, and reads the print store, so a history replay is visible.
  const ticksProbeTestOnly = {
    kind: "runtime" as const,
    id: "ticksProbeTestOnly" as const,
    label: "Ticks probe (test only)",
    category: "l1" as const,
    ticksWanted: true,
    defaultSettings: {},
    lines: [],
    placement: { kind: "overlay" as const },
    createState: () => ({}),
    onBar: (ctx: { replaying: boolean }) => {
      if (ctx.replaying) ticksReplays.count += 1;
    },
    readOutput: () => ({}),
  };
  return {
    ...actual,
    historicalIndicatorAvailability: (...args: Parameters<typeof actual.historicalIndicatorAvailability>) =>
      (args[0] as string) === "l2ProbeTestOnly" || historicallyAdmitted.has(args[0]) ? { available: true, reason: null } : actual.historicalIndicatorAvailability(...args),
    INDICATOR_REGISTRY: [...actual.INDICATOR_REGISTRY, brokenAfterTwoCalls, sharedTestOnly, gatedTestOnly, tableTestOnly, bottomTableTestOnly, noLineTestOnly, l2ProbeTestOnly, ticksProbeTestOnly],
    RUNTIME_INDICATOR_DEFS: [...actual.RUNTIME_INDICATOR_DEFS, brokenAfterTwoCalls, sharedTestOnly, gatedTestOnly, tableTestOnly, bottomTableTestOnly, noLineTestOnly, l2ProbeTestOnly, ticksProbeTestOnly],
  };
});

const { ChartPanel } = await import("../ChartPanel");

function bar(tsOpen: number, closed = true, close = 100): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: tsOpen,
    open: 100,
    high: Math.max(100, close),
    low: Math.min(100, close),
    close,
    volume: 1,
    trade_count: 1,
    closed,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let resizeDisconnect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  chartMock.timeScale.getVisibleRange.mockReturnValue(null);
  resizeDisconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = resizeDisconnect;
    },
  );
  container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: 1200 });
  Object.defineProperty(container, "clientHeight", { value: 800 });
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const SESSION_PROFILE_FRAME: ProfileFrame = {
  type: "profile",
  provider: "BINANCE",
  symbol: "BTC-USDT",
  marketKind: "SPOT",
  mode: "continuous",
  period_start_ts: 1000,
  period_end_ts: null,
  row_width: 2,
  delivery_scope: "LIVE",
  history_request_id: null,
  buckets: [
    { price: 100, volume: 5, buy_volume: 3, sell_volume: 2, single_print: false },
    { price: 102, volume: 20, buy_volume: 15, sell_volume: 5, single_print: false },
  ],
  poc_price: 102,
  vah_price: 102,
  val_price: 100,
};

async function mountChart(
  instrumentIdentity: { symbol: string } & FrameIdentity = {
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
  },
  colorScheme?: "dark",
  props: Partial<ChartPanelProps> = {},
) {  const ref = createRef<ChartPanelHandle>();
  await act(async () => {
    root.render(
      <ChartPanel
        ref={ref}
        instrumentIdentity={instrumentIdentity}
        colorScheme={colorScheme}
        {...props}
      />,
    );
  });
  expect(ref.current).not.toBeNull();
  return ref;
}

describe("ChartPanel Lightweight Charts lifecycle", () => {
  it("uses directional candle strokes and a high-contrast CVD line in dark Historical Mode", async () => {
    document.documentElement.style.setProperty("--bg", "#0c0c0c");
    document.documentElement.style.setProperty(
      "--text",
      "rgba(250, 250, 247, 0.92)",
    );
    document.documentElement.style.setProperty(
      "--border",
      "rgba(255, 255, 255, 0.08)",
    );
    document.documentElement.style.setProperty("--bull", "#4ade80");
    document.documentElement.style.setProperty("--bear", "#f87171");
    document.documentElement.style.setProperty(
      "--text-3",
      "rgba(250, 250, 247, 0.42)",
    );
    const ref = await mountChart(undefined, "dark");

    expect(chartMock.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      "CandlestickSeries",
      expect.objectContaining({
        upColor: "#36d684",
        downColor: "#f16a72",
        borderUpColor: "#36d684",
        borderDownColor: "#f16a72",
        wickUpColor: "#36d684",
        wickDownColor: "#f16a72",
      }),
    );

    act(() => {
      ref.current?.applySnapshot([bar(0)]);
      ref.current?.setHistoricalIndicatorCapabilities(
        ["ohlcv", "buy_volume"],
        "BINANCE",
      );
      ref.current?.setIndicators(["orderFlow"]);
    });

    expect(chartMock.chart.addSeries).toHaveBeenCalledWith(
      "LineSeries",
      expect.objectContaining({
        color: "#facc15",
        lineWidth: 2,
      }),
      expect.any(Number),
    );
    expect(chartMock.series.createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "rgba(250, 250, 247, 0.32)",
      }),
    );
  });

  it("draws no border line between the pane and the price axis, so a profile beside the axis has no line in front of it", async () => {
    await mountChart();
    const { createChart } = await import("lightweight-charts");
    expect(vi.mocked(createChart).mock.lastCall?.[1]).toEqual(expect.objectContaining({ rightPriceScale: expect.objectContaining({ borderVisible: false }) }));
  });

  it("keeps the light Live chart's neutral candle outlines", async () => {
    await mountChart();

    expect(chartMock.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      "CandlestickSeries",
      expect.objectContaining({
        upColor: "#f8f8f5",
        downColor: "#111111",
        borderUpColor: "#111111",
        borderDownColor: "#111111",
        wickUpColor: "#111111",
        wickDownColor: "#111111",
      }),
    );
  });

  it("owns historical roll markers as a chart-local primitive and clears them with the chart lifecycle", async () => {
    const ref = await mountChart({
      symbol: "ES",
      provider: "DATABENTO",
      assetClass: "FUTURE",
    });
    const primitive = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof RollMarkerPrimitive);
    expect(primitive).toBeInstanceOf(RollMarkerPrimitive);
    const setMarkers = vi.spyOn(primitive as RollMarkerPrimitive, "setMarkers");

    act(() =>
      ref.current?.setHistoricalRollMarkers([
        { time: Date.parse("2025-09-17T00:00:00.000Z"), label: "ESU5 → ESZ5" },
      ]),
    );

    expect(setMarkers).toHaveBeenCalledWith([
      { time: Date.parse("2025-09-17T00:00:00.000Z"), label: "ESU5 → ESZ5" },
    ]);
    await act(async () => root.unmount());
    expect(chartMock.series.detachPrimitive).toHaveBeenCalledWith(primitive);
    root = createRoot(container);
  });

  it("a chart rebuilt for a new colour scheme hands its iceberg layer the trader's settings, unit and book", async () => {
    const ref = await mountChart();
    const book = new IcebergBook();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["icebergDetector"]);
      ref.current?.setIndicatorVisibility(["icebergDetector"]);
      ref.current?.setIcebergSettings({ historyDays: 3, markScale: 2 }, "BTC");
      ref.current?.applyIcebergs(book);
    });
    const icebergLayers = () =>
      chartMock.series.attachPrimitive.mock.calls
        .map(([candidate]) => candidate)
        .filter((candidate): candidate is IcebergPrimitive => candidate instanceof IcebergPrimitive);
    expect(icebergLayers()).toHaveLength(1);
    await mountChart(undefined, "dark");
    expect(icebergLayers()).toHaveLength(2);
    const rebuilt = icebergLayers()[1];
    expect(rebuilt.settings).toEqual({ historyDays: 3, markScale: 2 });
    expect(rebuilt.unit).toBe("BTC");
    expect(rebuilt.book).toBe(book);
    expect(rebuilt.shown).toBe(true);
    expect(rebuilt.dark).toBe(true);
  });

  it("the iceberg layer is shown only while the indicator is on and visible, so an inactive one never prints its badge", async () => {
    const ref = await mountChart();
    const layer = () =>
      chartMock.series.attachPrimitive.mock.calls
        .map(([candidate]) => candidate)
        .filter((candidate): candidate is IcebergPrimitive => candidate instanceof IcebergPrimitive)
        .at(-1)!;
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyIcebergs(new IcebergBook());
    });
    expect(layer().shown).toBe(false);
    act(() => {
      ref.current?.setIndicators(["icebergDetector"]);
      ref.current?.setIndicatorVisibility(["icebergDetector"]);
    });
    expect(layer().shown).toBe(true);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(layer().shown).toBe(false);
    expect(layer().book).toBeNull();
    act(() => {
      ref.current?.setIndicatorVisibility(["icebergDetector"]);
      ref.current?.setIndicators([]);
    });
    expect(layer().shown).toBe(false);
  });

  it("a chart rebuilt for a new colour scheme hands its exhaustion layer the trader's settings, unit, candle length and book", async () => {
    const ref = await mountChart();
    const book = new ExhaustionBook();
    const settings = { ...DEFAULT_EXHAUSTION_SETTINGS, minScore: 4 };
    act(() => {
      ref.current?.setIndicators(["exhaustion"]);
      ref.current?.setIndicatorVisibility(["exhaustion"]);
      ref.current?.setExhaustionSettings(settings, "BTC");
      ref.current?.setExhaustionCandle(300_000);
      ref.current?.applyExhaustions(book);
    });
    const exhaustionLayers = () =>
      chartMock.series.attachPrimitive.mock.calls
        .map(([candidate]) => candidate)
        .filter((candidate): candidate is ExhaustionPrimitive => candidate instanceof ExhaustionPrimitive);
    expect(exhaustionLayers()).toHaveLength(1);
    await mountChart(undefined, "dark");
    expect(exhaustionLayers()).toHaveLength(2);
    const rebuilt = exhaustionLayers()[1];
    expect(rebuilt.settings).toEqual(settings);
    expect(rebuilt.unit).toBe("BTC");
    expect(rebuilt.candleMs).toBe(300_000);
    expect(rebuilt.book).toBe(book);
    expect(rebuilt.shown).toBe(true);
  });

  it("a chart rebuilt for a new colour scheme hands its initiative layer the trader's settings, candle length and book", async () => {
    const ref = await mountChart();
    const book = new InitiativeBook();
    const settings = { ...DEFAULT_INITIATIVE_SETTINGS, minScore: 4 };
    act(() => {
      ref.current?.setIndicators(["initiative"]);
      ref.current?.setIndicatorVisibility(["initiative"]);
      ref.current?.setInitiativeSettings(settings);
      ref.current?.setInitiativeCandle(300_000);
      ref.current?.applyInitiatives(book);
    });
    const initiativeLayers = () =>
      chartMock.series.attachPrimitive.mock.calls
        .map(([candidate]) => candidate)
        .filter((candidate): candidate is InitiativePrimitive => candidate instanceof InitiativePrimitive);
    expect(initiativeLayers()).toHaveLength(1);
    expect(initiativeLayers()[0].shown).toBe(true);
    await mountChart(undefined, "dark");
    expect(initiativeLayers()).toHaveLength(2);
    const rebuilt = initiativeLayers()[1];
    expect(rebuilt.settings).toEqual(settings);
    expect(rebuilt.candleMs).toBe(300_000);
    expect(rebuilt.book).toBe(book);
    expect(rebuilt.shown).toBe(true);
  });

  it("the candle monitor sits left of the price axis at the head of the top-right column with the last closed candle of the chart's length, fresh however far the runtime's clock is from the browser's and stale once its own frame time passes the next candle's close, waits for a close on a length without one, and leaves with the candle, its switch or the indicator", async () => {
    const ref = await mountChart();
    const entry: CandleMonitorEntry = { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 83_180, size: 1.21 }, biggestSell: null };
    const frame: CandleMonitorFrame = { type: "candle_monitor", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts: entry.candleTs + 90_000, entries: [entry] };
    const monitor = () => container.querySelector<HTMLElement>(".candle-monitor");
    act(() => {
      ref.current?.setIndicators(["exhaustion"]);
      ref.current?.setIndicatorVisibility(["exhaustion"]);
      ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC");
      ref.current?.setExhaustionCandle(60_000);
      ref.current?.applyCandleMonitor({ frame, receivedAt: Date.now() });
    });
    expect(monitor()).not.toBeNull();
    const stack = container.querySelector<HTMLElement>(".draw-table-overlay-stack--monitor");
    expect(stack).not.toBeNull();
    expect(stack!.style.right).toBe(`${64 + AXIS_INSET_GAP_PX}px`);
    expect(stack!.firstElementChild).toBe(monitor());
    expect(monitor()!.dataset.stale).toBeUndefined();
    expect(monitor()!.querySelector(".candle-monitor-candle")!.textContent).toBe("1m · 22:17");
    expect(monitor()!.querySelector(".candle-monitor-value")!.textContent).toBe("2.97 BTC");
    expect(monitor()!.querySelector('[data-row="biggestBuy"] .candle-monitor-value')!.textContent).toBe("1.21 BTC @ 83180.00");
    act(() => ref.current?.applyCandleMonitor({ frame: { ...frame, ts: entry.candleTs + 2 * 60_000 + 15_001 }, receivedAt: Date.now() }));
    expect(monitor()!.dataset.stale).toBe("true");
    expect(monitor()!.querySelector(".candle-monitor-candle")!.textContent).toBe("stale · 1m · 22:17");
    act(() => ref.current?.applyCandleMonitor({ frame, receivedAt: Date.now() }));
    expect(monitor()!.querySelector(".candle-monitor-candle")!.textContent).toBe("1m · 22:17");
    act(() => ref.current?.setExhaustionCandle(300_000));
    expect(monitor()!.querySelector(".candle-monitor-candle")!.textContent).toBe("waiting for a close");
    act(() => ref.current?.setExhaustionCandle(null));
    expect(monitor()).toBeNull();
    expect(container.querySelector(".draw-table-overlay-stack--monitor")).toBeNull();
    act(() => {
      ref.current?.setExhaustionCandle(60_000);
      ref.current?.setExhaustionSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showMonitor: false }, "BTC");
    });
    expect(monitor()).toBeNull();
    act(() => ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC"));
    expect(monitor()).not.toBeNull();
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(monitor()).toBeNull();
    act(() => {
      ref.current?.setIndicatorVisibility(["exhaustion"]);
      ref.current?.applyCandleMonitor(null);
    });
    expect(monitor()!.querySelector(".candle-monitor-candle")!.textContent).toBe("no feed");
  });

  it("re-creates the CVD Divergence labels primitives after the chart is torn down and rebuilt", async () => {
    // Regression: these primitives were attached to the main series but the
    // refs were NOT cleared in the chart-destroy cleanup, unlike every sibling
    // ref in that block. The chart is disposed and recreated by this very
    // effect on a StrictMode double-mount, so the stale ref survived and the
    // `if (!ref)` guard skipped re-attaching -- leaving an object bound to a
    // dead chart and the markers permanently invisible. The oscillator's own
    // ref was fixed first; the CUMULATIVE one was missed, which is why its
    // diamonds never came back.
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["cvdDivergence"]);
    });
    const labelPrimitives = () =>
      chartMock.series.attachPrimitive.mock.calls
        .map(([candidate]) => candidate)
        .filter(
          (candidate) => candidate instanceof CvdDivergenceLabelsPrimitive,
        );
    // One mount attaches a PAIR: the oscillator's `DiV+`/`DiV-` plates and the
    // cumulative series' `⯁` diamonds.
    expect(labelPrimitives()).toHaveLength(2);

    // Remount the chart the way the effect does, then re-request the
    // indicator: both markers must attach to the NEW chart, not be skipped.
    await act(async () => root.unmount());
    root = createRoot(container);
    const secondRef = await mountChart();
    act(() => {
      secondRef.current?.applySnapshot([bar(0), bar(60_000)]);
      secondRef.current?.setIndicators(["cvdDivergence"]);
    });
    // 4, not 3: if the cumulative labels ref had survived the teardown, only
    // the oscillator's would be recreated here.
    expect(labelPrimitives()).toHaveLength(4);
  });

  it("re-creates the borrowed cumulative CVD series after the chart is torn down and rebuilt", async () => {
    // Same class of bug as the labels: these series live on the chart, so
    // their refs must be cleared in the destroy cleanup or a StrictMode
    // remount leaves them bound to a disposed chart.
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["cvdDivergence"]);
    });
    // The mock's addSeries is declared with no parameters, so its recorded
    // call tuples carry no element types; name them here rather than casting
    // each element to `unknown` at the use site. The trend-filter average
    // SHARES this price scale (it has to, to be comparable to the line it
    // gates), so it is excluded by line width: the data series is drawn at
    // the standard indicator width, the average at a hairline.
    const cumulativeSeriesCount = (
      seriesType: string,
      isAveraged: (options: { lineWidth?: number }) => boolean,
    ) =>
      (
        chartMock.chart.addSeries.mock.calls as unknown as readonly [
          string,
          { priceScaleId?: string; lineWidth?: number },
        ][]
      ).filter(
        ([type, options]) =>
          type === seriesType &&
          options.priceScaleId === "cvd-divergence-cumulative" &&
          !isAveraged(options),
      ).length;
    const isHairline = (options: { lineWidth?: number }) =>
      options.lineWidth === 1;
    const cumulativeLineCount = () =>
      cumulativeSeriesCount("LineSeries", isHairline);
    const cumulativeCandleCount = () =>
      // Candles carry no lineWidth at all, so nothing there is the average.
      cumulativeSeriesCount("CandlestickSeries", () => false);
    expect(cumulativeLineCount()).toBe(1);
    expect(cumulativeCandleCount()).toBe(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    const secondRef = await mountChart();
    act(() => {
      secondRef.current?.applySnapshot([bar(0), bar(60_000)]);
      secondRef.current?.setIndicators(["cvdDivergence"]);
    });
    expect(cumulativeLineCount()).toBe(2);
    expect(cumulativeCandleCount()).toBe(2);
  });

  it("marks cumulative-CVD divergences whenever showCumulativeDivergences is on", async () => {
    // The cumulative series' divergences are DETECTED regardless of the
    // toggle (it is cheap and independent) but only HANDED to the primitives
    // when `showCumulativeDivergences` is on -- and they never follow the
    // reference line's own visibility.
    const ref = await mountChart();
    // The mock chart never drives `updateAllViews`, so `renderLabels` stays
    // empty no matter what. Spy on the SETTER instead: what matters is whether
    // detection produced anything, not whether the mock drew it.
    const spy = vi.spyOn(
      CvdDivergenceLabelsPrimitive.prototype,
      "setDivergences",
    );
    // Cumulative CVD: pivot high at bar 2 (30), then a LOWER high at bar 5 (23),
    // while price closes HIGHER at bar 5 (110) than at bar 2 (100) -- bearish.
    const deltas = [10, 10, 10, -20, 5, 8, -15, -5, 3, 3];
    const closes = [100, 100, 100, 100, 100, 110, 110, 110, 110, 110];
    const bars = deltas.map((delta, index) => ({
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: index * 60_000,
      open: closes[index],
      high: closes[index],
      low: closes[index],
      close: closes[index],
      volume: 100,
      // barDelta = buy - sell, so these sides yield exactly `delta`.
      buy_volume: 50 + delta / 2,
      sell_volume: 50 - delta / 2,
      trade_count: 10,
      closed: true,
    })) as BarFrame[];

    act(() => {
      ref.current?.applySnapshot(bars);
      ref.current?.setIndicators(["cvdDivergence"], {
        cvdDivergence: {
          ...DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
          pivotPeriods: 1,
          showCumulativeCvd: false,
          showCumulativeDivergences: true,
          // Pinned rather than inherited: the cumulative pivots in this
          // fixture are 3 bars apart, so this test must keep measuring the
          // toggle's effect rather than the default distance window.
          cumulativeMinPivotDistance: 1,
          cumulativeMaxPivotDistance: 30,
        },
      });
      // Visibility is a separate axis from activation and starts empty, so
      // without this the indicator is enabled but not shown, and every
      // visibility-gated branch (including this one) is skipped.
      ref.current?.setIndicatorVisibility(["cvdDivergence"]);
    });

    // Detection runs independently of BOTH toggles, so the markers appear
    // even with the reference line itself switched off -- the starved-data
    // bug that hid these entirely.
    const nonEmpty = spy.mock.calls.filter(
      ([divergences]) => divergences.length > 0,
    );
    expect(nonEmpty.length).toBeGreaterThan(0);
    expect(nonEmpty.at(-1)?.[0][0].type).toBe("bearish");

    // Detection still runs when the marker toggle is off (it is cheap and
    // independent), but the markers are NOT handed to the primitives.
    spy.mockClear();
    act(() => {
      ref.current?.setIndicators(["cvdDivergence"], {
        cvdDivergence: {
          ...DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
          pivotPeriods: 1,
          showCumulativeDivergences: false,
        },
      });
    });
    const drawn = spy.mock.calls.filter(
      ([divergences]) => divergences.length > 0,
    );
    expect(drawn).toEqual([]);
    spy.mockRestore();
  });

  it("reads the cumulative trend filter in the direction the Inverse switch selects", async () => {
    // The coupling this pins is the SETTINGS SNAPSHOT, not the detector: a
    // changed flag riding through captureCvdDivergenceSettings into the
    // detection call is exactly the path that silently went stale before.
    const ref = await mountChart();
    const spy = vi.spyOn(
      CvdDivergenceLabelsPrimitive.prototype,
      "setDivergences",
    );
    // Cumulative total: [10, 20, 30, 10, 15, 23, 8, ...] -- a pivot high at
    // index 2 (30) and a LOWER high at index 5 (23) while price closes higher.
    // The 3-bar average at the confirming pivot (index 5) is 16, so the series
    // is ABOVE it there: enough for the two directions to disagree.
    const deltas = [10, 10, 10, -20, 5, 8, -15, -5, 3, 3];
    const closes = [100, 100, 100, 100, 100, 110, 110, 110, 110, 110];
    const bars = deltas.map((delta, index) => ({
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: index * 60_000,
      open: closes[index],
      high: closes[index],
      low: closes[index],
      close: closes[index],
      volume: 100,
      buy_volume: 50 + delta / 2,
      sell_volume: 50 - delta / 2,
      trade_count: 10,
      closed: true,
    })) as BarFrame[];

    const bearishAtConfirmingBar = () =>
      spy.mock.calls.some(([divergences]) =>
        divergences.some(
          (divergence) =>
            divergence.type === "bearish" && divergence.priceTo.index === 5,
        ),
      );

    // The bars must reach the chart BEFORE the indicator is switched on: this
    // panel does nothing at all while its bar array is empty.
    act(() => {
      ref.current?.applySnapshot(bars);
    });
    const applyFilter = (inverted: boolean) => {
      spy.mockClear();
      act(() => {
        ref.current?.setIndicators(["cvdDivergence"], {
          cvdDivergence: {
            ...DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
            pivotPeriods: 1,
            showCumulativeDivergences: true,
            cumulativeTrendFilterEnabled: true,
            cumulativeTrendFilterSmaLength: 3,
            cumulativeTrendFilterInverted: inverted,
            // Pinned rather than inherited: the pivots here are 3 bars apart,
            // so this test must not start measuring the default range if that
            // default is ever retuned.
            cumulativeMinPivotDistance: 1,
            cumulativeMaxPivotDistance: 30,
          },
        });
        ref.current?.setIndicatorVisibility(["cvdDivergence"]);
      });
    };

    // Normal reading: bearish demands the series BELOW its average, and this
    // one is above, so the divergence is filtered out.
    applyFilter(false);
    expect(bearishAtConfirmingBar()).toBe(false);

    // Inverse: bearish demands it ABOVE, which is what the series does here.
    applyFilter(true);
    expect(bearishAtConfirmingBar()).toBe(true);

    spy.mockRestore();
  });

  it("loads snapshots with setData and preserves an existing visible time window on refresh/timeframe replacement", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    expect(chartMock.series.setData).toHaveBeenCalledTimes(1);
    expect(chartMock.timeScale.setVisibleRange).toHaveBeenCalledTimes(1);

    chartMock.timeScale.getVisibleRange.mockReturnValue({ from: 30, to: 90 });
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000), bar(120_000)]));
    expect(chartMock.timeScale.setVisibleRange).toHaveBeenLastCalledWith({
      from: 30,
      to: 90,
    });
    expect(chartMock.priceScale.applyOptions).toHaveBeenCalledTimes(1);
  });

  it("enforces historical data capabilities in the chart runtime as well as the picker", async () => {
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "DATABENTO");
      ref.current?.setIndicators(["rsi", "orderFlow"]);
      ref.current?.setIndicatorVisibility(["rsi", "orderFlow"]);
    });
    const addedSeries = chartMock.chart.addSeries.mock
      .calls as unknown as readonly [string][];
    expect(addedSeries.map(([seriesType]) => seriesType)).not.toContain(
      "HistogramSeries",
    );

    act(() =>
      ref.current?.setHistoricalIndicatorCapabilities(
        ["ohlcv", "buy_volume"],
        "BINANCE",
      ),
    );
    expect(
      (
        chartMock.chart.addSeries.mock.calls as unknown as readonly [string][]
      ).map(([seriesType]) => seriesType),
    ).toContain("HistogramSeries");
  });

  it("gives the heatmap the live store's zoom lanes and the trader's lane choice (P4c.2)", async () => {
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    expect(heatmap).toBeInstanceOf(LiquidityHeatmapPrimitive);
    expect(heatmap.lanes).toBeNull();
    const store = new L2Store();
    act(() => ref.current?.applyL2(store));
    expect(heatmap.lanes).toBe(store.lanes);
    act(() => ref.current?.setLiquidityLane("1"));
    expect(heatmap.laneChoice).toBe("1");
    act(() => ref.current?.applyL2(null));
    expect(heatmap.lanes).toBeNull();
  });

  it("builds the indicators' L2 view with the host wall stream, and rebuilds it when the stream changes", async () => {
    const { WallHistoryStream } = await import("../../../lib/l2/wallHistoryStream");
    const { indicatorL2Of } = await import("../../../lib/chart/indicatorL2");
    const ref = await mountChart();
    const stream = new WallHistoryStream({ request: () => {} });
    act(() => ref.current?.applyL2(new L2Store()));
    act(() => ref.current?.applyHostWalls(stream));
    const built = vi.mocked(indicatorL2Of).mock.results.at(-1)?.value as { hostWalls: unknown } | null;
    expect(built?.hostWalls).toBe(stream);
    act(() => ref.current?.applyHostWalls(null));
    const rebuilt = vi.mocked(indicatorL2Of).mock.results.at(-1)?.value as { hostWalls: unknown } | null;
    expect(rebuilt?.hostWalls).toBeNull();
  });

  it("gives the runtime indicators their own lane of the column history through the liquidity handle, and takes it away with the stream", async () => {
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const { LiquidityGrid } = await import("../../../lib/indicators/passive-liquidity/liquidityGrid");
    const { indicatorLiquidityOf } = await import("../../../lib/chart/indicatorLiquidity");
    const ref = await mountChart();
    const stream = new ColumnHistoryStream({ request: () => {} });
    const fork = vi.spyOn(stream, "fork");
    const given = () => vi.mocked(indicatorLiquidityOf).mock.calls.filter((call) => call.length >= 2).at(-1)?.[1];
    act(() => ref.current?.applyLiquidity(new LiquidityGrid()));
    expect(given()).toBeNull();
    act(() => ref.current?.applyColumnHistory(stream));
    expect(fork).toHaveBeenCalledTimes(2);
    const lane = fork.mock.results[0].value;
    expect(lane).not.toBe(stream);
    expect(given()).toBe(lane);
    act(() => ref.current?.applyLiquidity(new LiquidityGrid()));
    expect(given()).toBe(lane);
    act(() => ref.current?.applyColumnHistory(null));
    expect(given()).toBeNull();
  });

  it("lets the runtime indicators read the heatmap's Row Size the chart was last given, through the liquidity handle", async () => {
    const { LiquidityGrid } = await import("../../../lib/indicators/passive-liquidity/liquidityGrid");
    const { indicatorLiquidityOf } = await import("../../../lib/chart/indicatorLiquidity");
    const ref = await mountChart();
    act(() => ref.current?.applyLiquidity(new LiquidityGrid()));
    const rows = vi.mocked(indicatorLiquidityOf).mock.calls.at(-1)?.[2];
    expect(rows?.()).toBeNull();
    act(() => ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 7 }));
    expect(rows?.()).toBe(7);
  });

  it("hands the absorption primitive the column stream, repaints it when a chunk lands, and lets go of a stream it no longer has", async () => {
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const ref = await mountChart();
    const absorption = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    expect(absorption).toBeInstanceOf(AbsorptionPrimitive);
    expect(absorption.history).toBeNull();
    const first = new ColumnHistoryStream({ request: () => {} });
    const second = new ColumnHistoryStream({ request: () => {} });
    const refresh = vi.spyOn(absorption, "refresh");
    act(() => ref.current?.applyColumnHistory(first));
    const firstHistory = absorption.history;
    expect(firstHistory).not.toBeNull();
    act(() => ref.current?.applyColumnHistory(second));
    expect(absorption.history).not.toBe(firstHistory);
    expect(absorption.history).not.toBeNull();
    act(() => ref.current?.applyColumnHistory(null));
    expect(absorption.history).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("hands the heatmap the history store, repaints it when pages land, and lets go of a store it no longer has (P4c.4)", async () => {
    const { HeatmapHistory } = await import("../../../lib/indicators/passive-liquidity/heatmapHistory");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    const first = new HeatmapHistory({ request: () => {} });
    const second = new HeatmapHistory({ request: () => {} });
    const refresh = vi.spyOn(heatmap, "refresh");
    act(() => ref.current?.applyHeatmapHistory(first));
    expect(heatmap.history).toBe(first);
    first.setIdentity({ provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT" });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => ref.current?.applyHeatmapHistory(second));
    expect(heatmap.history).toBe(second);
    first.setIdentity(null);
    expect(refresh).toHaveBeenCalledTimes(1);
    second.setIdentity({ provider: "BINANCE", marketKind: "SPOT", symbol: "ETH-USDT" });
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => ref.current?.applyHeatmapHistory(null));
    expect(heatmap.history).toBeNull();
  });

  it("tells the panel which price-zoom lane the heatmap is drawing, through the latest callback (P4c.2)", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const ref = createRef<ChartPanelHandle>();
    const identity = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" } as const;
    await act(async () => { root.render(<ChartPanel ref={ref} instrumentIdentity={identity} onLiquidityLaneDrawn={first} />); });
    await act(async () => { root.render(<ChartPanel ref={ref} instrumentIdentity={identity} onLiquidityLaneDrawn={latest} />); });
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    heatmap.onLaneDrawn?.(1);
    expect(latest).toHaveBeenCalledWith(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("hands L2 indicators the live store, the historical source in Historical Mode, and the live store again after", async () => {
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["l2ProbeTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["l2ProbeTestOnly" as never]);
    });
    l2Seen.length = 0;
    act(() => ref.current?.applyL2(new L2Store()));
    expect(l2Seen.at(-1)).toBe("LIVE");

    act(() => ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "BINANCE"));
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    expect(l2Seen.at(-1)).toBe("HISTORICAL_UNAVAILABLE");

    l2Seen.length = 0;
    act(() => {
      ref.current?.applyL2(new L2Store());
      ref.current?.refreshL2();
    });
    expect(l2Seen).toEqual([]);

    act(() => ref.current?.setHistoricalIndicatorCapabilities(null));
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    expect(l2Seen.at(-1)).toBe("LIVE");
  });

  it("isolates historical liquidity from live frames and history lanes, clears it on withdrawal and restores live mode", async () => {
    const { LiquidityGrid } = await import("../../../lib/indicators/passive-liquidity/liquidityGrid");
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const { historicalBookL2 } = await import("../../../lib/archive/historicalBookL2");
    const { historicalBookLiquidity } = await import("../../../lib/archive/historicalBookLiquidity");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["l2ProbeTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["l2ProbeTestOnly" as never]);
      ref.current?.applyLiquidity(new LiquidityGrid());
      ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "DATABENTO");
    });
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    expect(liquiditySeen.at(-1)).toBe("none");
    const source = historicalBookL2([], 0.01, 19);
    const depth = historicalBookLiquidity([], 0.01, 19, "shares");
    const cut = vi.fn(depth.atTime!);
    act(() => ref.current?.applyHistoricalL2(source, { ...depth, atTime: cut }));
    expect(liquiditySeen.at(-1)).toBe("shares");
    expect(cut.mock.calls.map(([time]) => time)).toContain(120_000);
    act(() => {
      ref.current?.applyLiquidity(new LiquidityGrid());
      ref.current?.applyColumnHistory(new ColumnHistoryStream({ request: () => {} }));
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
    });
    expect(liquiditySeen.at(-1)).toBe("shares");
    act(() => ref.current?.applyHistoricalL2(null));
    expect(liquiditySeen.at(-1)).toBe("none");
    act(() => {
      ref.current?.setHistoricalIndicatorCapabilities(null);
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
    });
    expect(liquiditySeen.at(-1)).not.toBe("none");
    expect(liquiditySeen.at(-1)).not.toBe("shares");
  });

  it("fits the complete published range only when Historical Mode explicitly asks for it", async () => {
    const ref = await mountChart({
      symbol: "AAPL",
      provider: "DATABENTO",
      assetClass: "EQUITY",
    });
    const daily = [0, 10].map((day) => ({
      type: "bar" as const,
      symbol: "AAPL",
      provider: "DATABENTO" as const,
      assetClass: "EQUITY" as const,
      interval_ms: 86_400_000,
      ts_open: day * 86_400_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1,
      trade_count: null,
      closed: true,
    }));

    act(() => ref.current?.applySnapshot(daily, { viewport: "all" }));

    expect(chartMock.timeScale.setVisibleRange).toHaveBeenLastCalledWith({
      from: 0,
      to: 950_400,
    });
    act(() => ref.current?.applySnapshot(daily));
    expect(chartMock.timeScale.setVisibleRange).toHaveBeenLastCalledWith({
      from: 345_600,
      to: 950_400,
    });
  });

  it("reports logical bars around the viewport for smooth historical prefetching", async () => {
    chartMock.timeScale.getVisibleLogicalRange.mockReturnValue({
      from: 4,
      to: 10,
    });
    chartMock.series.barsInLogicalRange.mockReturnValue({
      barsBefore: 40,
      barsAfter: 300,
    });
    const ref = await mountChart();
    const callback = vi.fn();

    const unsubscribe =
      ref.current?.subscribeVisibleLogicalRangeChange(callback);

    expect(callback).toHaveBeenCalledWith(40, 300);
    expect(
      chartMock.timeScale.subscribeVisibleLogicalRangeChange,
    ).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    expect(
      chartMock.timeScale.unsubscribeVisibleLogicalRangeChange,
    ).toHaveBeenCalledTimes(1);
  });

  it("renders an archive-provenance snapshot with unavailable trade count without changing the candle", async () => {
    const ref = await mountChart({
      symbol: "AAPL",
      provider: "DATABENTO",
      assetClass: "EQUITY",
    });
    const historical: BarFrame = {
      type: "bar",
      symbol: "AAPL",
      provider: "DATABENTO",
      assetClass: "EQUITY",
      interval_ms: 86_400_000,
      ts_open: 1_756_684_800_000,
      open: 100.25,
      high: 101.5,
      low: 99.75,
      close: 100.75,
      volume: 42.5,
      trade_count: null,
      closed: true,
    };

    act(() => ref.current?.applySnapshot([historical]));

    expect(chartMock.series.setData).toHaveBeenLastCalledWith([
      expect.objectContaining({
        time: 1_756_684_800,
        open: 100.25,
        high: 101.5,
        low: 99.75,
        close: 100.75,
      }),
    ]);
  });

  it("uses update for a contiguous edge, setData for a gap/correction, and rejects closed-to-open regression", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0)]));
    chartMock.series.setData.mockClear();
    chartMock.series.update.mockClear();

    act(() => ref.current?.applyBar(bar(60_000, false, 101)));
    expect(chartMock.series.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 60, close: 101 }),
    );

    act(() => ref.current?.applyBar(bar(60_000, true, 102)));
    expect(chartMock.series.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 60, close: 102 }),
    );
    chartMock.series.update.mockClear();
    chartMock.series.setData.mockClear();
    act(() => ref.current?.applyBar(bar(60_000, false, 999)));
    expect(chartMock.series.update).not.toHaveBeenCalled();
    expect(chartMock.series.setData).not.toHaveBeenCalled();

    act(() => ref.current?.applyBar(bar(180_000, false, 103)));
    expect(chartMock.series.setData).toHaveBeenCalledTimes(1);
    chartMock.series.setData.mockClear();
    act(() => ref.current?.applyBar(bar(0, true, 98)));
    expect(chartMock.series.setData).toHaveBeenCalledTimes(1);
  });

  it("creates a runtime indicator's own-pane series and price lines, feeds it real computed output, and tears it down on removal", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 20 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    chartMock.chart.addSeries.mockClear();
    chartMock.series.createPriceLine.mockClear();
    chartMock.series.setData.mockClear();

    act(() => {
      ref.current?.setIndicators(["rsi"]);
      ref.current?.setIndicatorVisibility(["rsi"]);
    });
    expect(chartMock.chart.addSeries).toHaveBeenCalledTimes(1);
    expect(chartMock.chart.addSeries).toHaveBeenCalledWith(
      "LineSeries",
      expect.objectContaining({ lastValueVisible: false }),
      0,
    );
    expect(chartMock.series.createPriceLine).toHaveBeenCalledTimes(3);
    const points = chartMock.series.setData.mock.calls.at(-1)?.[0];
    expect(
      points.some(
        (point: { value?: number }) => typeof point.value === "number",
      ),
    ).toBe(true);

    act(() => ref.current?.setIndicatorSettings("rsi", { length: 14 }));
    expect(chartMock.series.setData).toHaveBeenCalled();

    chartMock.chart.removeSeries.mockClear();
    act(() => ref.current?.setIndicators([]));
    expect(chartMock.chart.removeSeries).toHaveBeenCalledTimes(1);
  });

  it("creates a runtime indicator's overlay series per line with per-line widths, feeds per-bar colored output, and tears both down on removal", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    chartMock.chart.addSeries.mockClear();
    chartMock.series.setData.mockClear();

    act(() => {
      ref.current?.setIndicators(["ema"]);
      ref.current?.setIndicatorVisibility(["ema"]);
    });
    expect(chartMock.chart.addSeries).toHaveBeenCalledTimes(2);
    expect(chartMock.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      "LineSeries",
      expect.objectContaining({ lineWidth: 1 }),
      0,
    );
    expect(chartMock.chart.addSeries).toHaveBeenNthCalledWith(
      2,
      "LineSeries",
      expect.objectContaining({ lineWidth: 2 }),
      0,
    );

    const coloredCall = chartMock.series.setData.mock.calls.find(
      ([points]) =>
        Array.isArray(points) && points.some((point) => "color" in point),
    );
    expect(coloredCall).toBeDefined();

    chartMock.chart.removeSeries.mockClear();
    act(() => ref.current?.setIndicators([]));
    expect(chartMock.chart.removeSeries).toHaveBeenCalledTimes(2);
  });

  it("does not construct a throwaway runtime state for an overlay without line series", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0)]));
    noLineCreateState.mockClear();

    act(() => {
      ref.current?.setIndicators(["noLineTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["noLineTestOnly" as never]);
    });

    expect(noLineCreateState).toHaveBeenCalledTimes(1);
  });

  it("uses the active runtime state as the only state constructed when a line indicator is selected", async () => {
    const createState = vi.spyOn(smaIndicator, "createState");
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000), bar(120_000)]));
    createState.mockClear();

    act(() => {
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });

    expect(createState).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the session delta profile when an edge correction changes directional volume without changing candle volume or close", async () => {
    const setProfiles = vi.spyOn(
      SessionDeltaProfilePrimitive.prototype,
      "setProfiles",
    );
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 12 }, (_, index) => ({
      ...bar(index * 60_000, true, 100),
      buy_volume: 6,
    }));
    act(() => ref.current?.applySnapshot(snapshotBars));
    act(() => {
      ref.current?.setIndicators(["sessionDeltaProfile"]);
      ref.current?.setIndicatorVisibility(["sessionDeltaProfile"]);
    });
    const before = setProfiles.mock.calls.at(-1)?.[0];
    expect(before).toBeDefined();

    const corrected = { ...snapshotBars.at(-1)!, buy_volume: 2 };
    act(() => ref.current?.applyBar(corrected));

    const after = setProfiles.mock.calls.at(-1)?.[0];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("creates three overlay lines for Bollinger, feeds it real computed bands, and tears all three down on removal", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + (index % 5)),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    chartMock.chart.addSeries.mockClear();
    chartMock.series.setData.mockClear();

    act(() => {
      ref.current?.setIndicators(["bollinger"]);
      ref.current?.setIndicatorVisibility(["bollinger"]);
    });
    expect(chartMock.chart.addSeries).toHaveBeenCalledTimes(3);

    const numericCall = chartMock.series.setData.mock.calls.find(
      ([points]) =>
        Array.isArray(points) &&
        points.some(
          (point: { value?: number }) => typeof point.value === "number",
        ),
    );
    expect(numericCall).toBeDefined();

    chartMock.chart.removeSeries.mockClear();
    act(() => ref.current?.setIndicators([]));
    expect(chartMock.chart.removeSeries).toHaveBeenCalledTimes(3);
  });

  it("SMA: a cosmetic settings change (color) recolors the rendered line immediately, without a recompute-sized redraw of the wrong shape", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));

    act(() => {
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    chartMock.series.setData.mockClear();

    act(() =>
      ref.current?.setIndicatorSettings("sma", { length: 20, color: "blue" }),
    );
    const points = chartMock.series.setData.mock.calls.at(-1)?.[0];
    expect(
      points.some(
        (point: { color?: string; value?: number }) =>
          point.color === "#2563eb" && typeof point.value === "number",
      ),
    ).toBe(true);
  });

  it("updates a runtime line by one point for a normal contiguous live bar instead of rebuilding its full retained history", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    act(() => {
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    chartMock.series.setData.mockClear();
    chartMock.series.update.mockClear();

    act(() => ref.current?.applyBar(bar(25 * 60_000, false, 130)));

    expect(chartMock.series.update).toHaveBeenCalledWith(
      expect.objectContaining({ time: 1500, value: expect.any(Number) }),
    );
    expect(chartMock.series.setData).not.toHaveBeenCalled();
  });

  it("replays the print-priced indicators once a history reply settles in the print store, never for a live print or the same store twice", async () => {
    const { AggressiveTape } = await import("../../../lib/indicators/aggressive-orders/aggressiveTape");
    const print = (ts: number, id: string) => ({ type: "trade" as const, symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const, ts_exchange: ts, price: 100, size: 1, side: "buy" as const, trade_id: id });
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    act(() => {
      ref.current?.setIndicators(["ticksProbeTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["ticksProbeTestOnly" as never]);
    });
    vi.useFakeTimers();
    try {
      const tape = new AggressiveTape(() => 0);
      tape.reset();
      const before = ticksReplays.count;
      act(() => ref.current?.applyTicks(tape));
      const handed = ticksReplays.count;
      expect(handed).toBe(before + 2);
      act(() => ref.current?.applyTicks(tape));
      act(() => tape.add(print(90_000, "live")));
      act(() => vi.advanceTimersByTime(1_000));
      expect(ticksReplays.count).toBe(handed);
      act(() => {
        tape.addHistory([print(10_000, "past")]);
        tape.coverHistory(0, 60_000, 0);
      });
      expect(ticksReplays.count).toBe(handed);
      act(() => vi.advanceTimersByTime(250));
      expect(ticksReplays.count).toBe(handed + 2);
      act(() => ref.current?.applyTicks(null));
      act(() => tape.coverHistory(0, 120_000, 0));
      act(() => vi.advanceTimersByTime(1_000));
      expect(ticksReplays.count).toBe(handed + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pane's draw kernel on the price candles, so hiding one indicator cannot blank another's drawn objects", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));

    // sma and ema are both real "overlay" indicators -- in the real library
    // each gets its own distinct LineSeries on pane 0, unlike this shared
    // mock's default of returning the same object for every addSeries call.
    const emaSeries = {
      setData: vi.fn(),
      update: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn(), width: vi.fn(() => 64) })),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      createPriceLine: vi.fn(() => ({})),
      getPane: vi.fn(() => ({ paneIndex: () => 0 })),
      barsInLogicalRange: vi.fn(() => null),
      coordinateToPrice: vi.fn(() => null),
      priceFormatter: vi.fn(() => ({ format: (price: number) => price.toFixed(2) })),
    };
    chartMock.chart.addSeries
      .mockImplementationOnce(() => chartMock.series)
      .mockImplementationOnce(() => emaSeries);

    act(() => {
      ref.current?.setIndicators(["sma", "ema"]);
      ref.current?.setIndicatorVisibility(["sma", "ema"]);
    });

    // The pane's drawn objects are hosted on the candles -- the one series on
    // pane 0 that always holds data -- and never on an overlay indicator's own
    // line series.
    expect(chartMock.series.attachPrimitive).toHaveBeenCalled();
    expect(emaSeries.attachPrimitive).not.toHaveBeenCalled();

    emaSeries.attachPrimitive.mockClear();

    act(() => {
      ref.current?.setIndicators(["sma", "ema"]);
      ref.current?.setIndicatorVisibility(["ema"]);
    });

    // Hiding sma must not move the kernel onto ema's series: `priceToCoordinate`
    // returns null while a series holds no data (hiding empties one), so a host
    // an indicator can empty would blank every drawn object on the pane -- the
    // labels another indicator drew included.
    expect(emaSeries.attachPrimitive).not.toHaveBeenCalled();
  });

  it("does not silently draw a shared-pane indicator on price when its declared parent is absent, then resolves it once the parent is active", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    chartMock.chart.addSeries.mockClear();

    act(() => {
      ref.current?.setIndicators(["sharedTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["sharedTestOnly" as never]);
    });
    expect(chartMock.chart.addSeries).not.toHaveBeenCalled();

    act(() => {
      ref.current?.setIndicators(["rsi", "sharedTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["rsi", "sharedTestOnly" as never]);
    });
    expect(chartMock.chart.addSeries).toHaveBeenCalledTimes(2);
  });

  it("removes a timeframe-gated runtime indicator when a snapshot changes to an ineligible interval", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    chartMock.chart.addSeries.mockClear();

    act(() => {
      ref.current?.setIndicators(["gatedTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["gatedTestOnly" as never]);
    });
    expect(chartMock.chart.addSeries).toHaveBeenCalledTimes(1);

    chartMock.chart.removeSeries.mockClear();
    act(() =>
      ref.current?.applySnapshot([
        { ...bar(0), interval_ms: 5 * 60_000 },
        { ...bar(5 * 60_000), interval_ms: 5 * 60_000 },
      ]),
    );
    expect(chartMock.chart.removeSeries).toHaveBeenCalledTimes(1);
  });

  it("a draw.table() placed bottom-right renders in its own stack above the time axis, clear of the price axis, apart from the top-right one", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    act(() => {
      ref.current?.setIndicators(["tableTestOnly" as never, "bottomTableTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["tableTestOnly" as never, "bottomTableTestOnly" as never]);
    });
    const stacks = container.querySelectorAll(".draw-table-overlay-stack");
    expect(stacks).toHaveLength(2);
    expect(stacks[0].classList.contains("draw-table-overlay-stack--bottom")).toBe(false);
    expect(stacks[1].classList.contains("draw-table-overlay-stack--bottom")).toBe(true);
    expect(stacks[0].querySelectorAll(".draw-table-overlay")).toHaveLength(1);
    expect(stacks[1].querySelectorAll(".draw-table-overlay")).toHaveLength(1);
    expect((stacks[0] as HTMLElement).style.right).toBe("");
    expect((stacks[1] as HTMLElement).style.right).toBe(`${64 + AXIS_INSET_GAP_PX}px`);
  });

  it("draw.table() content is rendered as a real DOM overlay, replaced once per bar rather than accumulating", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));

    act(() => {
      ref.current?.setIndicators(["tableTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["tableTestOnly" as never]);
    });

    let cells = container.querySelectorAll(".draw-table-overlay td");
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe("VPIN");
    expect(cells[1].textContent).toBe("2");

    act(() => ref.current?.applyBar(bar(120_000)));
    cells = container.querySelectorAll(".draw-table-overlay td");
    expect(cells).toHaveLength(2); // still one row, not one appended per bar
    expect(cells[1].textContent).toBe("3");

    act(() => {
      ref.current?.setIndicators([]);
      ref.current?.setIndicatorVisibility([]);
    });
    expect(container.querySelector(".draw-table-overlay")).toBeNull();
  });

  it("TA.03.5 proof-of-concept: largeTradeBubbles uses ctx.trades and ctx.markers together to draw a bubble at a real oversized live trade's own price", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0)]));

    act(() => {
      ref.current?.setIndicators(["largeTradeBubbles" as never]);
      ref.current?.setIndicatorVisibility(["largeTradeBubbles" as never]);
    });

    const modestTrade = (tsOpen: number): TradeFrame => ({
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: tsOpen,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: `modest-${tsOpen}`,
    });

    // Warm the 20-bar rolling baseline with live, modest-sized trades --
    // ctx.trades is always empty during the snapshot replay above, so the
    // baseline can only be built through real applyBar calls.
    for (let index = 1; index <= 20; index += 1) {
      const tsOpen = index * 60_000;
      act(() =>
        ref.current?.applyBar(
          bar(tsOpen),
          [modestTrade(tsOpen)],
          "LIVE_COMPLETE",
        ),
      );
    }

    const hugeTrade: TradeFrame = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 21 * 60_000,
      price: 12_345,
      size: 500,
      side: "buy",
      trade_id: "huge",
    };
    act(() =>
      ref.current?.applyBar(bar(21 * 60_000), [hugeTrade], "LIVE_COMPLETE"),
    );

    const markerControllerCall = vi
      .mocked(createSeriesMarkers)
      .mock.results.at(-1);
    expect(markerControllerCall).toBeDefined();
    const setMarkers = vi.mocked(markerControllerCall!.value.setMarkers);
    expect(setMarkers).toHaveBeenCalled();
    const lastMarkers = setMarkers.mock.calls.at(-1)![0];
    expect(lastMarkers).toContainEqual(
      expect.objectContaining({
        shape: "circle",
        position: "atPriceMiddle",
        price: 12_345,
        color: "#22c55e",
      }),
    );
  });

  it("a faulted indicator never crashes applyBar once the live bars array outgrows its frozen output -- the fault stays isolated all the way through rendering", async () => {
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    act(() => {
      ref.current?.setIndicators(["brokenTestOnly" as never]);
      ref.current?.setIndicatorVisibility(["brokenTestOnly" as never]);
    });
    chartMock.series.setData.mockClear();

    expect(() => act(() => ref.current?.applyBar(bar(120_000)))).not.toThrow();
    expect(chartMock.series.setData).toHaveBeenLastCalledWith([]);
  });

  it("re-favoriting a runtime indicator after removing it restores its last customized settings, not the defaults", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));

    act(() => {
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    act(() =>
      ref.current?.setIndicatorSettings("sma", { length: 5, color: "green" }),
    );

    act(() => ref.current?.setIndicators([]));
    chartMock.series.setData.mockClear();

    act(() => {
      ref.current?.setIndicators(["sma"], {
        sma: { length: 5, color: "green" },
      });
      ref.current?.setIndicatorVisibility(["sma"]);
    });

    const points = chartMock.series.setData.mock.calls.at(-1)?.[0];
    expect(
      points.some((point: { color?: string }) => point.color === "#16a34a"),
    ).toBe(true);
  });

  it("applies changed settings when the requested indicator IDs stay the same", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from({ length: 25 }, (_, index) =>
      bar(index * 60_000, true, 100 + index),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    act(() => {
      ref.current?.setIndicators(["sma"], {
        sma: { length: 20, color: "blue" },
      });
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    chartMock.series.setData.mockClear();

    act(() =>
      ref.current?.setIndicators(["sma"], {
        sma: { length: 5, color: "green" },
      }),
    );

    const points = chartMock.series.setData.mock.calls.at(-1)?.[0];
    expect(points).toBeDefined();
    expect(
      points.some((point: { color?: string }) => point.color === "#16a34a"),
    ).toBe(true);
  });

  it("keeps runtime output aligned when the retained history rolls forward at its bar limit", async () => {
    const ref = await mountChart();
    const snapshotBars = Array.from(
      { length: MAX_RETAINED_SOURCE_BARS },
      (_, index) => bar(index * 60_000, true, 100 + (index % 10)),
    );
    act(() => ref.current?.applySnapshot(snapshotBars));
    act(() => {
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    chartMock.series.setData.mockClear();

    expect(() =>
      act(() =>
        ref.current?.applyBar(
          bar(MAX_RETAINED_SOURCE_BARS * 60_000, true, 110),
        ),
      ),
    ).not.toThrow();

    const points = chartMock.series.setData.mock.calls.at(-1)?.[0];
    expect(points).toHaveLength(MAX_RETAINED_SOURCE_BARS);
  });

  it("TA.04: killzonesIndicator's timeframeGate now drives the same 30-minute suppression ChartPanel.tsx enforced ad hoc before this migration", async () => {
    const setSessions = vi.spyOn(KillzonesPrimitive.prototype, "setSessions");
    const ref = await mountChart();
    act(() => ref.current?.applySnapshot([bar(0)]));
    act(() => {
      ref.current?.setIndicators(["killzones" as never]);
      ref.current?.setIndicatorVisibility(["killzones" as never]);
    });
    setSessions.mockClear();

    // An intraday (1m) bar: killzones' timeframeGate passes, sessions render.
    act(() => ref.current?.applyBar(bar(60_000)));
    const intradayCall = setSessions.mock.calls.at(-1)?.[0];
    expect(intradayCall).toBeDefined();
    expect(intradayCall!.length).toBeGreaterThan(0);

    // Switching to a 1h chart, the way a real timeframe change actually
    // arrives (a snapshot at the new interval, not an incremental applyBar
    // still carrying the old interval): the same gate that used to live
    // inline in ChartPanel.tsx as `interval_ms <= 30 * 60_000` now lives on
    // killzonesIndicator itself.
    const hourlyBar: BarFrame = { ...bar(0), interval_ms: 60 * 60_000 };
    act(() => ref.current?.applySnapshot([hourlyBar]));
    expect(setSessions.mock.calls.at(-1)?.[0]).toEqual([]);

    setSessions.mockRestore();
  });

  it("tells the price pane's draw kernel the chart is dark in Historical Mode", async () => {
    const setDarkChart = vi.spyOn(DrawKernelPrimitive.prototype, "setDarkChart");
    const ref = await mountChart(undefined, "dark");
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    expect(setDarkChart.mock.calls).toEqual([[true]]);
  });

  it("tells the price pane's draw kernel the Live chart is not dark", async () => {
    const setDarkChart = vi.spyOn(DrawKernelPrimitive.prototype, "setDarkChart");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["sma"]);
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    expect(setDarkChart.mock.calls).toEqual([[false]]);
  });

  it("keeps room at the price axis for the heatmap ladder as wide as the heatmap draws it, not as wide as its setting", async () => {
    const setRightInset = vi.spyOn(DrawKernelPrimitive.prototype, "setRightInset");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    vi.spyOn(heatmap, "ladderWidthPx").mockImplementation((paneWidth) => paneWidth / 20);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, showLadder: true, ladderReach: 0.12 });
      ref.current?.setIndicators(["passiveLiquidity", "sma"]);
      ref.current?.setIndicatorVisibility(["passiveLiquidity", "sma"]);
    });
    const inset = setRightInset.mock.calls.at(-1)![0];
    expect(inset(1_200)).toBe(60 + AXIS_INSET_GAP_PX);
  });

  it("sits the Live Delta Profile beside the ladder as wide as the heatmap draws it, and beside the Book Map's profile", async () => {
    const setNeighbour = vi.spyOn(LiveDeltaProfilePrimitive.prototype, "setNeighbour");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    vi.spyOn(heatmap, "ladderWidthPx").mockImplementation((paneWidth) => paneWidth / 20);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, showLadder: true, ladderReach: 0.12 });
      ref.current?.setIndicators(["passiveLiquidity", "liveDeltaProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["passiveLiquidity", "liveDeltaProfile", "sma"]);
    });
    expect(setNeighbour.mock.calls.at(-1)![0]?.widthPx(1_200)).toBe(60);
    act(() => {
      ref.current?.setIndicators(["l2BookMap", "liveDeltaProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["l2BookMap", "liveDeltaProfile", "sma"]);
    });
    expect(setNeighbour.mock.calls.at(-1)![0]?.widthPx(1_200)).toBe(BOOK_MAP_PROFILE_EDGE_GAP_PX + bookMapProfileWidthPx(1_200));
  });

  it("sits Volume Profile (Ticks) beside the ladder, and keeps room at the axis for both", async () => {
    const setRightInset = vi.spyOn(DrawKernelPrimitive.prototype, "setRightInset");
    const tickInset = vi.spyOn(VolumeDeltaProfileTickPrimitive.prototype, "setRightInset");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    vi.spyOn(heatmap, "ladderWidthPx").mockImplementation((paneWidth) => paneWidth / 20);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, showLadder: true, ladderReach: 0.12 });
      ref.current?.setIndicators(["passiveLiquidity", "volumeDeltaProfileTick", "sma"]);
      ref.current?.setIndicatorVisibility(["passiveLiquidity", "volumeDeltaProfileTick", "sma"]);
    });
    const profileWidth = DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS.profileWidth;
    expect(tickInset.mock.calls.at(-1)![0]!(1_200)).toBe(60 + AXIS_INSET_GAP_PX);
    expect(setRightInset.mock.calls.at(-1)![0](1_200)).toBe(60 + AXIS_INSET_GAP_PX + profileWidth + AXIS_INSET_GAP_PX);
  });

  it("sits the Live Delta Profile beside Volume Profile (Ticks), past the ladder", async () => {
    const setNeighbour = vi.spyOn(LiveDeltaProfilePrimitive.prototype, "setNeighbour");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    vi.spyOn(heatmap, "ladderWidthPx").mockImplementation((paneWidth) => paneWidth / 20);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, showLadder: true, ladderReach: 0.12 });
      ref.current?.setIndicators(["passiveLiquidity", "volumeDeltaProfileTick", "liveDeltaProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["passiveLiquidity", "volumeDeltaProfileTick", "liveDeltaProfile", "sma"]);
    });
    const profileWidth = DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS.profileWidth;
    expect(setNeighbour.mock.calls.at(-1)![0]?.widthPx(1_200)).toBe(60 + AXIS_INSET_GAP_PX + profileWidth);
  });

  it("keeps room at the price axis for the Live Delta Profile as far in as it draws", async () => {
    const setRightInset = vi.spyOn(DrawKernelPrimitive.prototype, "setRightInset");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["liveDeltaProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["liveDeltaProfile", "sma"]);
    });
    const delta = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiveDeltaProfilePrimitive) as LiveDeltaProfilePrimitive;
    delta.frame = { ...(delta.frame ?? {}), width: 1_200, right: 1_100, reach: 150 } as NonNullable<LiveDeltaProfilePrimitive["frame"]>;
    const inset = setRightInset.mock.calls.at(-1)![0];
    expect(inset(1_200)).toBe(1_200 - 1_100 + 150 + AXIS_INSET_GAP_PX);
  });

  it("keeps room at the price axis for the Live Order Book Profile as far in as it draws", async () => {
    const setRightInset = vi.spyOn(DrawKernelPrimitive.prototype, "setRightInset");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["liveOrderBookProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["liveOrderBookProfile", "sma"]);
    });
    const book = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiveOrderBookProfilePrimitive) as LiveOrderBookProfilePrimitive;
    book.frame = { ...(book.frame ?? {}), width: 1_200, right: 1_000, reach: 120 } as NonNullable<LiveOrderBookProfilePrimitive["frame"]>;
    const inset = setRightInset.mock.calls.at(-1)![0];
    expect(inset(1_200)).toBe(1_200 - 1_000 + 120 + AXIS_INSET_GAP_PX);
  });

  it("sits the Live Order Book Profile beside the ladder, never beside itself, however far in it draws", async () => {
    const setNeighbour = vi.spyOn(LiveOrderBookProfilePrimitive.prototype, "setNeighbour");
    const ref = await mountChart();
    const heatmap = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    vi.spyOn(heatmap, "ladderWidthPx").mockImplementation((paneWidth) => paneWidth / 20);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setLiquiditySettings({ ...DEFAULT_LIQUIDITY_SETTINGS, showLadder: true, ladderReach: 0.12 });
      ref.current?.setIndicators(["passiveLiquidity", "liveOrderBookProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["passiveLiquidity", "liveOrderBookProfile", "sma"]);
    });
    const book = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof LiveOrderBookProfilePrimitive) as LiveOrderBookProfilePrimitive;
    book.frame = { ...(book.frame ?? {}), width: 1_200, right: 900, reach: 300 } as NonNullable<LiveOrderBookProfilePrimitive["frame"]>;
    expect(setNeighbour.mock.calls.at(-1)![0]?.widthPx(1_200)).toBe(60);
  });

  it("puts the Aggressive Orders Profile pane under the chart while it is on and live, hands the primitive its settings, renders what it reads, and takes the pane down when it is hidden or the chart is historical", async () => {
    const attach = vi.spyOn(AggressiveProfilePane.prototype, "attach");
    const render = vi.spyOn(AggressiveProfilePane.prototype, "render");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyAggressiveProfile(new LiquidityGrid());
      ref.current?.setIndicators(["aggressiveOrdersProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["aggressiveOrdersProfile", "sma"]);
    });
    expect(attach).toHaveBeenCalledTimes(1);
    act(() => {
      ref.current?.applyAggressiveProfile(new LiquidityGrid());
    });
    expect(attach).toHaveBeenCalledTimes(1);
    const pane = attach.mock.instances[0] as unknown as AggressiveProfilePane;
    expect(pane.attached).toBe(true);
    const placeTag = vi.spyOn(pane, "placeTag");
    act(() => {
      ref.current?.setIndicators(["aggressiveOrdersProfile"]);
    });
    expect(placeTag).toHaveBeenCalled();
    act(() => {
      ref.current?.setIndicators(["aggressiveOrdersProfile", "sma"]);
    });
    const profile = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof AggressiveProfilePrimitive) as AggressiveProfilePrimitive;
    expect(profile.source).not.toBeNull();
    act(() => {
      ref.current?.setAggressiveProfileSettings({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
    });
    expect(profile.settings).toEqual({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
    render.mockClear();
    const range = { fromTs: 0, toTs: 60_000, open: true };
    profile.onRead?.([], range, profile.settings);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toEqual([]);
    expect(render.mock.calls[0][1].map((entry) => entry.ts_open)).toEqual([0, 60_000]);
    expect(render.mock.calls[0][2]).toBe(range);
    expect(render.mock.calls[0][3]).toEqual({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
    profile.onRead?.(null, null, profile.settings);
    expect(render.mock.calls[1][0]).toEqual([]);
    expect(render.mock.calls[1][2]).toBeNull();
    act(() => {
      ref.current?.setIndicatorVisibility(["sma"]);
    });
    expect(pane.attached).toBe(false);
    expect(profile.source).toBeNull();
    const repaint = vi.spyOn(profile, "repaint");
    act(() => {
      ref.current?.setIndicatorVisibility(["aggressiveOrdersProfile", "sma"]);
    });
    expect(pane.attached).toBe(true);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(repaint).toHaveBeenCalled();
    act(() => {
      ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "BINANCE");
    });
    expect(pane.attached).toBe(false);
    expect(profile.source).toBeNull();
  });

  it("hands the Aggressive Orders Profile the range print store, feeds its live bar only the prints at or above the profile's floor, repaints it when the store records more, and lets go of it, and gives the profile no source while it is hidden or the chart is historical", async () => {
    const ref = await mountChart();
    const grid = new LiquidityGrid();
    grid.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]] }],
    });
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyAggressiveProfile(grid);
      ref.current?.setIndicators(["aggressiveOrdersProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["aggressiveOrdersProfile", "sma"]);
    });
    const profile = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof AggressiveProfilePrimitive) as AggressiveProfilePrimitive;
    const source = profile.source as AggressiveProfileSource;
    expect(source.prints).toBeNull();
    const repaint = vi.spyOn(profile, "repaint");
    const store = new RangePrintStore();
    act(() => ref.current?.applyAggressiveProfilePrints(store));
    expect(source.prints).toBe(store);
    expect(repaint).toHaveBeenCalledTimes(1);
    store.setWant({ from: 0, to: 60_000, floor: 5 }, 1_000);
    expect(repaint).toHaveBeenCalledTimes(2);
    const push = vi.spyOn(AggressiveProfilePane.prototype, "pushLive");
    store.addTrade({ ts_exchange: 2_000, price: 1, size: 6, side: "buy" });
    expect(push).toHaveBeenLastCalledWith({ ts: 2_000, size: 6, buy: true });
    act(() => ref.current?.setAggressiveProfileSettings({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 }));
    push.mockClear();
    store.addTrade({ ts_exchange: 2_100, price: 1, size: 14, side: "sell" });
    expect(push).not.toHaveBeenCalled();
    store.addTrade({ ts_exchange: 2_200, price: 1, size: 15, side: "sell" });
    expect(push).toHaveBeenLastCalledWith({ ts: 2_200, size: 15, buy: false });
    act(() => ref.current?.setAggressiveProfileSettings(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS));
    store.addTrade({ ts_exchange: 2_300, price: 1, size: 5, side: "buy" });
    expect(push).toHaveBeenLastCalledWith({ ts: 2_300, size: 5, buy: true });
    act(() => ref.current?.applyAggressiveProfilePrints(store));
    expect(repaint).toHaveBeenCalledTimes(2);
    const other = new RangePrintStore();
    act(() => ref.current?.applyAggressiveProfilePrints(other));
    expect(source.prints).toBe(other);
    push.mockClear();
    store.addTrade({ ts_exchange: 3_000, price: 1, size: 6, side: "buy" });
    expect(push).not.toHaveBeenCalled();
    store.reanchor();
    expect(repaint).toHaveBeenCalledTimes(3);
    act(() => ref.current?.applyAggressiveProfilePrints(null));
    expect(source.prints).toBeNull();
    other.reanchor();
    expect(repaint).toHaveBeenCalledTimes(4);
    const next = new LiquidityGrid();
    act(() => ref.current?.applyAggressiveProfile(next));
    expect(profile.source).not.toBe(source);
    expect(profile.source).not.toBeNull();
    const live = profile.source;
    act(() => ref.current?.setIndicatorVisibility(["sma"]));
    expect(profile.source).toBeNull();
    act(() => ref.current?.setIndicatorVisibility(["aggressiveOrdersProfile", "sma"]));
    expect(profile.source).toBe(live);
    act(() => ref.current?.applyAggressiveProfile(null));
    expect(profile.source).toBeNull();
    act(() => ref.current?.applyAggressiveProfile(next));
    expect(profile.source).not.toBeNull();
    expect(profile.source).not.toBe(live);
    act(() => ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "BINANCE"));
    expect(profile.source).toBeNull();
  });

  it("on a timeframe change empties the Aggressive Orders Profile before the chart places the new view, and reads the new candles through a fresh source", async () => {
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyAggressiveProfile(new LiquidityGrid());
      ref.current?.setIndicators(["aggressiveOrdersProfile", "sma"]);
      ref.current?.setIndicatorVisibility(["aggressiveOrdersProfile", "sma"]);
    });
    const profile = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof AggressiveProfilePrimitive) as AggressiveProfilePrimitive;
    const before = profile.source;
    expect(before).not.toBeNull();
    const setSource = vi.spyOn(profile, "setSource");
    chartMock.timeScale.setVisibleRange.mockClear();
    const fiveMinutes = (tsOpen: number) => ({ ...bar(tsOpen), interval_ms: 300_000 });
    act(() => ref.current?.applySnapshot([fiveMinutes(0), fiveMinutes(300_000)]));
    expect(setSource.mock.calls[0][0]).toBeNull();
    expect(setSource.mock.invocationCallOrder[0]).toBeLessThan(chartMock.timeScale.setVisibleRange.mock.invocationCallOrder[0]);
    const fresh = profile.source;
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(before);
    setSource.mockClear();
    act(() => ref.current?.applySnapshot([fiveMinutes(0), fiveMinutes(300_000), fiveMinutes(600_000)]));
    expect(setSource.mock.calls.some(([source]) => source === null)).toBe(false);
    expect(profile.source).toBe(fresh);
  });

  it("keeps room at the price axis for the Book Map's profile while it is drawn, and none once its profile is off", async () => {
    const setRightInset = vi.spyOn(DrawKernelPrimitive.prototype, "setRightInset");
    const ref = await mountChart();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["l2BookMap", "sma"]);
      ref.current?.setIndicatorVisibility(["l2BookMap", "sma"]);
    });
    const inset = setRightInset.mock.calls.at(-1)![0];
    expect(inset(1_200)).toBe(BOOK_MAP_PROFILE_EDGE_GAP_PX + bookMapProfileWidthPx(1_200) + AXIS_INSET_GAP_PX);
    expect(inset(1_200)).toBe(144);
    act(() => {
      ref.current?.setL2BookMapSettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS, showProfile: false });
    });
    expect(setRightInset.mock.calls.at(-1)![0](1_200)).toBe(0);
  });

  it("gives the profile frame to the selected view's primitive only", async () => {
    const ref = await mountChart();
    const profiles = chartMock.series.attachPrimitive.mock.calls.map(
      ([candidate]) => candidate,
    );
    const volume = profiles.find(
      (candidate) => candidate instanceof VolumeProfilePrimitive,
    ) as VolumeProfilePrimitive;
    const netDelta = profiles.find(
      (candidate) => candidate instanceof NetDeltaProfilePrimitive,
    ) as NetDeltaProfilePrimitive;
    const delta = profiles.find(
      (candidate) => candidate instanceof DeltaProfilePrimitive,
    ) as DeltaProfilePrimitive;
    const setVolume = vi.spyOn(volume, "setProfile");
    const setNetDelta = vi.spyOn(netDelta, "setProfile");
    const setDelta = vi.spyOn(delta, "setProfile");
    const frame = SESSION_PROFILE_FRAME;

    act(() => {
      ref.current?.setIndicators(
        [SESSION_PROFILE_INDICATOR_ID],
        {
          [SESSION_PROFILE_INDICATOR_ID]: {
            ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
            view: "deltaProfile",
          },
        },
      );
      ref.current?.setIndicatorVisibility([SESSION_PROFILE_INDICATOR_ID]);
      ref.current?.applyProfileFrame(frame);
    });

    // One frame, one rendering: the other two views must be told to draw
    // nothing, or switching views would stack a second copy of the profile.
    expect(setDelta).toHaveBeenLastCalledWith(frame);
    expect(setVolume).toHaveBeenLastCalledWith(null);
    expect(setNetDelta).toHaveBeenLastCalledWith(null);
  });

  it("moves the frame to a view handed over with the rest of the settings", async () => {
    const ref = await mountChart();
    const netDelta = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find(
        (candidate) => candidate instanceof NetDeltaProfilePrimitive,
      ) as NetDeltaProfilePrimitive;
    const setNetDelta = vi.spyOn(netDelta, "setProfile");
    const frame = SESSION_PROFILE_FRAME;

    act(() => {
      ref.current?.setIndicators([SESSION_PROFILE_INDICATOR_ID]);
      ref.current?.setIndicatorVisibility([SESSION_PROFILE_INDICATOR_ID]);
      ref.current?.applyProfileFrame(frame);
      // The saved view arrives through the settings push, not through a
      // settings edit, so it has to move the frame on its own.
      ref.current?.setSessionProfileSettings({
        ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
        view: "netDeltaProfile",
      });
    });

    expect(setNetDelta).toHaveBeenLastCalledWith(frame);
  });

  it("passes the Volume Profile (Ticks) coverage report on to the panel", async () => {
    const onTruncatedFrom = vi.fn();
    const ref = await mountChart(undefined, undefined, {
      onVolumeDeltaProfileTickTruncatedFrom: onTruncatedFrom,
    });
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
    });
    const primitive = chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find(
        (candidate) => candidate instanceof VolumeDeltaProfileTickPrimitive,
      ) as VolumeDeltaProfileTickPrimitive;

    // The primitive is ChartPanel's own, so the panel only learns about coverage
    // if the report is wired through to it.
    expect(primitive.onTruncatedFromChange).not.toBeNull();
    primitive.onTruncatedFromChange?.(1_700_000_000_000);
    expect(onTruncatedFrom).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("disconnects ResizeObserver, listeners and chart resources on teardown", async () => {
    await mountChart();
    await act(async () => root.unmount());
    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
    expect(chartMock.chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(chartMock.chart.unsubscribeClick).toHaveBeenCalledTimes(1);
    expect(chartMock.chart.remove).toHaveBeenCalledTimes(1);
    // Prevent afterEach from attempting a second unmount on the same root.
    root = createRoot(container);
  });
});

describe("ChartPanel iceberg card hover", () => {
  it("a pointer on an iceberg card shows that iceberg alone and never asks the layers under the card; in another pane it is no card", async () => {
    const ref = await mountChart();
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const attached = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate);
    const icebergLayer = attached.find((candidate) => candidate instanceof IcebergPrimitive) as IcebergPrimitive;
    const absorption = attached.find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    const liquidity = attached.find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    const hover = { side: "ask" as const, kind: "probable" as const, title: "Probable iceberg · ask", headline: "Total 15.8 BTC · 3 orders of 5.266 BTC", detailLine: "8.939 BTC traded · price went quiet · above the learned ratio", whenLine: "21:56:13 to 21:56:41 UTC · marked 21:56:38 · 28 s" };
    const whaleMarkers = attached.find((candidate) => candidate instanceof WhaleMarkersPrimitive) as WhaleMarkersPrimitive;
    const bookMap = attached.find((candidate) => candidate instanceof L2BookMapPrimitive) as L2BookMapPrimitive;
    const whaleHeat = attached.find((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive;
    const cardAt = vi.spyOn(icebergLayer, "cardAt").mockReturnValue(hover);
    const markAt = vi.spyOn(icebergLayer, "markAt").mockReturnValue(hover);
    const bubbleAt = vi.spyOn(absorption, "bubbleAt").mockReturnValue({ side: "bid", title: "sphere" } as never);
    const levelAt = vi.spyOn(liquidity, "levelAt").mockReturnValue({ side: "bid" } as never);
    const hitTestCluster = vi.spyOn(whaleMarkers, "hitTestCluster").mockReturnValue({ side: "bid" } as never);
    const cellAt = vi.spyOn(bookMap, "cellAt").mockReturnValue({ side: "bid" } as never);
    const whaleHit = vi.spyOn(whaleHeat, "hitAt").mockReturnValue({ kind: "wall", index: 0, wall: {} } as unknown as WhaleHit);
    const handler = chartMock.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point: { x: 120, y: 80 }, paneIndex: 0, time: undefined }));
    expect(cardAt).toHaveBeenCalledWith(120, 80);
    for (const spy of [hitTestCluster, bubbleAt, levelAt, cellAt, whaleHit]) expect(spy).not.toHaveBeenCalled();
    expect(container.querySelector(".whale-tooltip.iceberg")?.textContent).toContain("Total 15.8 BTC · 3 orders of 5.266 BTC");
    expect(container.querySelectorAll(".whale-tooltip")).toHaveLength(1);
    hitTestCluster.mockReturnValue(null);
    bubbleAt.mockReturnValue(null);
    levelAt.mockReturnValue(null);
    cellAt.mockReturnValue(null);
    whaleHit.mockReturnValue(null);
    act(() => handler({ point: { x: 120, y: 80 }, paneIndex: 1, time: undefined }));
    expect(cardAt).toHaveBeenCalledTimes(1);
    expect(markAt).not.toHaveBeenCalled();
    expect(container.querySelector(".whale-tooltip.iceberg")).toBeNull();
    cardAt.mockReturnValue(null);
    markAt.mockReturnValue(null);
    act(() => handler({ point: { x: 121, y: 81 }, paneIndex: 0, time: undefined }));
    expect(bubbleAt).toHaveBeenCalled();
    expect(container.querySelector(".whale-tooltip.iceberg")).toBeNull();
    expect(ref.current).not.toBeNull();
  });

  it("a pointer on an iceberg point shows that iceberg alone, as its card does: no wall, Book Map, whale heatmap, pivot, FVG or session level under it is asked", async () => {
    const ref = await mountChart();
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const attached = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate);
    const icebergLayer = attached.find((candidate) => candidate instanceof IcebergPrimitive) as IcebergPrimitive;
    const absorption = attached.find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    const liquidity = attached.find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive;
    const whaleMarkers = attached.find((candidate) => candidate instanceof WhaleMarkersPrimitive) as WhaleMarkersPrimitive;
    const bookMap = attached.find((candidate) => candidate instanceof L2BookMapPrimitive) as L2BookMapPrimitive;
    const whaleHeat = attached.find((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive;
    const runtime = indicatorRuntimes.at(-1)!;
    const studies = ["pivotPoints", "fvgDelta", "sessionLevels"] as const;
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators([...studies]);
      ref.current?.setIndicatorVisibility([...studies]);
    });
    const hover = { side: "bid" as const, kind: "native" as const, title: "Native iceberg · bid", headline: "Total 40 · 4 orders of 10", detailLine: "32 traded", whenLine: "21:56:13 to 21:56:41 UTC · marked 21:56:38 · 28 s" };
    const wall = { side: "bid" as const, size: 73, peak: 80, state: "resting" as const, fill: null, ageMs: 60_000, priceLo: 99, priceHi: 101, unit: "BTC", label: "73.0 BTC", detail: "", peakLabel: "", lane: 0 };
    const cell = { side: "bid" as const, volume: 5, priceLo: 99, priceHi: 101, timeStartMs: 0, timeEndMs: 60_000 };
    vi.spyOn(icebergLayer, "cardAt").mockReturnValue(null);
    const markAt = vi.spyOn(icebergLayer, "markAt").mockReturnValue(hover);
    vi.spyOn(whaleMarkers, "hitTestCluster").mockReturnValue(null);
    vi.spyOn(absorption, "bubbleAt").mockReturnValue(null);
    const levelAt = vi.spyOn(liquidity, "levelAt").mockReturnValue(wall);
    const cellAt = vi.spyOn(bookMap, "cellAt").mockReturnValue(cell);
    const whaleHit = vi.spyOn(whaleHeat, "hitAt").mockReturnValue(null);
    const markers = vi.spyOn(runtime, "getMarkers");
    const hoverData = vi.spyOn(runtime, "getHoverData");
    const handler = chartMock.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point: { x: 120, y: 80 }, paneIndex: 0, time: 60 }));
    expect(markAt).toHaveBeenCalledWith(120, 80);
    expect(levelAt).not.toHaveBeenCalled();
    expect(cellAt).not.toHaveBeenCalled();
    expect(whaleHit).not.toHaveBeenCalled();
    expect(markers).not.toHaveBeenCalledWith("pivotPoints");
    expect(hoverData).not.toHaveBeenCalledWith("fvgDelta");
    expect(hoverData).not.toHaveBeenCalledWith("sessionLevels");
    expect(container.querySelectorAll(".whale-tooltip")).toHaveLength(1);
    expect(container.querySelector(".whale-tooltip.iceberg")?.textContent).toContain("Total 40 · 4 orders of 10");
    markAt.mockReturnValue(null);
    levelAt.mockReturnValue(null);
    cellAt.mockReturnValue(null);
    act(() => handler({ point: { x: 121, y: 81 }, paneIndex: 0, time: 60 }));
    expect(levelAt).toHaveBeenCalledWith(121, 81);
    expect(cellAt).toHaveBeenCalledWith(121, 81);
    expect(whaleHit).toHaveBeenCalledWith(121, 81);
    expect(markers).toHaveBeenCalledWith("pivotPoints");
    expect(hoverData).toHaveBeenCalledWith("fvgDelta");
    expect(hoverData).toHaveBeenCalledWith("sessionLevels");
    expect(container.querySelector(".whale-tooltip.iceberg")).toBeNull();
  });
});

describe("ChartPanel whale limit order heatmap wiring", () => {
  const WHALE_ID = "whaleLimitOrderHeatmap" as const;

  function whalePrimitive(): WhaleLimitHeatmapPrimitive {
    return chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive;
  }

  const CARD: WhaleCard = { side: 0, title: "BID · FILLED", usd: "$8.0M", sentence: "Sellers ate 76% of this $8.0M bid in 4.2 min.", meterPct: 76, facts: "100 BTC · 4.2 min", details: [["Price", "80000.0"]] };
  const HIT = { kind: "wall", index: 0, wall: {} } as unknown as WhaleHit;

  function crosshair(point: { x: number; y: number } | undefined) {
    const handler = chartMock.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time: undefined }));
  }

  function click(point: { x: number; y: number }) {
    const handler = chartMock.chart.subscribeClick.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time: undefined }));
  }

  it("hands the primitive its stream only while the indicator is on and visible on a live chart, and takes it away when it is hidden or the chart is historical", async () => {
    const ref = await mountChart();
    const stream = new WallHistoryStream({ request: () => undefined });
    const primitive = whalePrimitive();
    const setStream = vi.spyOn(primitive, "setStream");
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyWhaleWalls(stream);
    });
    expect(setStream).not.toHaveBeenCalledWith(stream);
    act(() => {
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    expect(setStream).toHaveBeenLastCalledWith(stream);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(setStream).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicatorVisibility([WHALE_ID]));
    expect(setStream).toHaveBeenLastCalledWith(stream);
    act(() => ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "BINANCE"));
    expect(setStream).toHaveBeenLastCalledWith(null);
  });

  it("keeps the primitive inactive until the indicator is on and visible, and switches it off again when hidden", async () => {
    const ref = await mountChart();
    const primitive = whalePrimitive();
    expect(primitive.active).toBe(false);
    const setActive = vi.spyOn(primitive, "setActive");
    act(() => {
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    expect(setActive).toHaveBeenLastCalledWith(true);
    expect(primitive.active).toBe(true);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(setActive).toHaveBeenLastCalledWith(false);
    expect(primitive.active).toBe(false);
    act(() => ref.current?.setIndicators([]));
    expect(primitive.active).toBe(false);
  });

  it("hands the primitive a stream that arrives after the indicator is already on, and takes it away when the stream goes", async () => {
    const ref = await mountChart();
    const setStream = vi.spyOn(whalePrimitive(), "setStream");
    act(() => {
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    const stream = new WallHistoryStream({ request: () => undefined });
    act(() => ref.current?.applyWhaleWalls(stream));
    expect(setStream).toHaveBeenLastCalledWith(stream);
    act(() => ref.current?.applyWhaleWalls(null));
    expect(setStream).toHaveBeenLastCalledWith(null);
  });

  it("tells the primitive the market only for a Binance pair, and nothing it could size walls for otherwise", async () => {
    const ref = await mountChart();
    const setIdentity = vi.spyOn(whalePrimitive(), "setIdentity");
    act(() => {
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    expect(setIdentity).toHaveBeenLastCalledWith("SPOT", "BTC-USDT");
    await act(async () => root.unmount());
    root = createRoot(container);
    chartMock.series.attachPrimitive.mockClear();
    const other = await mountChart({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" } as unknown as { symbol: string } & FrameIdentity);
    const dxIdentity = vi.spyOn(whalePrimitive(), "setIdentity");
    act(() => {
      other.current?.setIndicators([WHALE_ID]);
      other.current?.setIndicatorVisibility([WHALE_ID]);
    });
    expect(dxIdentity).toHaveBeenLastCalledWith("", "/NQZ26:XCME");
  });

  it("forwards the settings to the primitive, and a primitive made later starts from them", async () => {
    const ref = await mountChart();
    const setSettings = vi.spyOn(whalePrimitive(), "setSettings");
    const next = { ...DEFAULT_WHALE_HEATMAP_SETTINGS, cutPreset: 3, hours: 168 };
    act(() => ref.current?.setWhaleHeatmapSettings(next));
    expect(setSettings).toHaveBeenLastCalledWith(next);
    const before = chartMock.series.attachPrimitive.mock.calls.filter(([candidate]) => candidate instanceof WhaleLimitHeatmapPrimitive).length;
    await act(async () => {
      root.render(<ChartPanel ref={ref} instrumentIdentity={{ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }} colorScheme="dark" />);
    });
    const made = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate).filter((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive[];
    expect(made.length).toBeGreaterThan(before);
    expect(made.at(-1)!.settings).toEqual(next);
  });

  it("keeps the hover card where it is for a cursor that barely moved over the same wall, and moves it for a real move or another wall", async () => {
    await mountChart();
    const primitive = whalePrimitive();
    const hit = vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    vi.spyOn(primitive, "card").mockReturnValue(CARD);
    crosshair({ x: 300, y: 250 });
    const left = () => (container.querySelector(".whale-wall-card") as HTMLElement).style.left;
    crosshair({ x: 301, y: 251 });
    expect(left()).toBe("300px");
    crosshair({ x: 306, y: 250 });
    expect(left()).toBe("306px");
    hit.mockReturnValue({ ...HIT, wall: { other: true } } as unknown as WhaleHit);
    crosshair({ x: 307, y: 250 });
    expect(left()).toBe("307px");
    hit.mockReturnValue(null);
    crosshair({ x: 400, y: 250 });
    expect(container.querySelector(".whale-wall-card")).toBeNull();
  });

  it("shows the hover card for the wall under the cursor, drops it when the cursor leaves, and keeps it behind a higher-priority card", async () => {
    const ref = await mountChart();
    const primitive = whalePrimitive();
    vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    vi.spyOn(primitive, "card").mockReturnValue(CARD);
    const setHover = vi.spyOn(primitive, "setHover");
    expect(ref.current).not.toBeNull();
    crosshair({ x: 300, y: 250 });
    const card = container.querySelector(".whale-wall-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.classList.contains("pinned")).toBe(false);
    expect([card.style.left, card.style.top]).toEqual(["300px", "250px"]);
    expect(container.querySelector(".whale-wall-card-details")).toBeNull();
    expect(setHover).toHaveBeenLastCalledWith(HIT);
    crosshair(undefined);
    expect(container.querySelector(".whale-wall-card")).toBeNull();
    expect(setHover).toHaveBeenLastCalledWith(null);
  });

  it("pins the card with its details on a click on a wall, closes it on Escape or a click on empty chart, and shows no hover card under a pinned one", async () => {
    await mountChart();
    const primitive = whalePrimitive();
    const hitAt = vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    const card = vi.spyOn(primitive, "card").mockReturnValue(CARD);
    click({ x: 400, y: 260 });
    const pinned = container.querySelector(".whale-wall-card.pinned") as HTMLElement;
    expect(pinned).not.toBeNull();
    expect(card).toHaveBeenLastCalledWith(HIT, true);
    expect(container.querySelector(".whale-wall-card-details")).not.toBeNull();
    crosshair({ x: 300, y: 250 });
    expect(container.querySelectorAll(".whale-wall-card")).toHaveLength(1);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
    click({ x: 400, y: 260 });
    expect(container.querySelector(".whale-wall-card.pinned")).not.toBeNull();
    hitAt.mockReturnValue(null);
    click({ x: 10, y: 10 });
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
  });

  it("leaves an open card behind when the indicator is hidden", async () => {
    const ref = await mountChart();
    const primitive = whalePrimitive();
    vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    vi.spyOn(primitive, "card").mockReturnValue(CARD);
    act(() => {
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    click({ x: 400, y: 260 });
    expect(container.querySelector(".whale-wall-card.pinned")).not.toBeNull();
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(container.querySelector(".whale-wall-card")).toBeNull();
  });

  it("keeps both cards inside the chart's width", async () => {
    await mountChart();
    const primitive = whalePrimitive();
    vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    vi.spyOn(primitive, "card").mockReturnValue(CARD);
    const half = WHALE_CARD_WIDTH_PX / 2 + 6;
    Object.defineProperty(container.querySelector(".chart-mount")!, "clientWidth", { value: 1_200 });
    crosshair({ x: 5, y: 250 });
    expect((container.querySelector(".whale-wall-card") as HTMLElement).style.left).toBe(`${half}px`);
    click({ x: 1_195, y: 250 });
    expect((container.querySelector(".whale-wall-card.pinned") as HTMLElement).style.left).toBe(`${1_200 - half}px`);
  });

  it("closes a pinned card when the chart moves to another pair, and hands the primitive back to the chart on teardown", async () => {
    const ref = await mountChart();
    const primitive = whalePrimitive();
    vi.spyOn(primitive, "hitAt").mockReturnValue(HIT);
    vi.spyOn(primitive, "card").mockReturnValue(CARD);
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators([WHALE_ID]);
      ref.current?.setIndicatorVisibility([WHALE_ID]);
    });
    click({ x: 400, y: 260 });
    expect(container.querySelector(".whale-wall-card.pinned")).not.toBeNull();
    act(() => ref.current?.applySnapshot([{ ...bar(0), symbol: "ETH-USDT" }, { ...bar(60_000), symbol: "ETH-USDT" }]));
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
    await act(async () => root.unmount());
    expect(chartMock.series.detachPrimitive).toHaveBeenCalledWith(primitive);
    root = createRoot(container);
  });

  it("asks the primitive to claim its room again once a snapshot has reset the range and the newest bar is on screen", async () => {
    const ref = await mountChart();
    const restoreRoom = vi.spyOn(whalePrimitive(), "restoreRoom");
    chartMock.timeScale.getVisibleRange.mockReturnValue({ from: 0, to: 1_000_000 });
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000)]));
    expect(restoreRoom).toHaveBeenCalledTimes(1);
    chartMock.timeScale.getVisibleRange.mockReturnValue({ from: 0, to: 10 });
    act(() => ref.current?.applySnapshot([bar(0), bar(60_000), bar(120_000)]));
    expect(restoreRoom).toHaveBeenCalledTimes(1);
  });

  it("refreshes the primitive when the L2 book advances, so live walls reach it", async () => {
    const ref = await mountChart();
    const refresh = vi.spyOn(whalePrimitive(), "refresh");
    act(() => ref.current?.refreshL2());
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("ChartPanel initiative cards", () => {
  const T0 = Date.now();

  function initiativeBand(over: Partial<InitiativeBand> = {}): InitiativeBand {
    return {
      id: "b", candleMs: 60_000, side: "up", dominant: "buyers", dominantShare: 0.9, score: 4,
      facts: { efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: 1.667 }, delta: { yes: true, rank: 0.85, share: 0.9 }, prints: { yes: true, rank: 1, perCandle: 1 } },
      pivotTs: T0 - 300_000, pivotPrice: 100, frozenTs: T0 - 120_000, frozenPrice: 108, windowCandles: 3, atr: 1,
      legExtremePrice: 110, legExtremeTs: T0 - 60_000, legEndTs: null, updatedAt: T0 - 60_000, origin: "runtime", ...over,
    };
  }

  function pageOf(bands: InitiativeBand[]): InitiativeBandsFrame {
    return { type: "initiative_bands", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts: T0, seq: 0, reset: true, bands, liveSince: T0 - 3_600_000, loading: null };
  }

  function crosshair(point: { x: number; y: number } | undefined, time: number | undefined = undefined) {
    const handler = chartMock.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time }));
  }

  function click(point: { x: number; y: number }) {
    const handler = chartMock.chart.subscribeClick.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time: undefined }));
  }

  it("a pointer on a band shows its line, a click pins the card with the five facts, Escape and a pointer off the band drop them; nothing shows once the indicator is hidden", async () => {
    const ref = await mountChart();
    const book = new InitiativeBook();
    const band = initiativeBand();
    book.apply(pageOf([band]));
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["initiative"]);
      ref.current?.setIndicatorVisibility(["initiative"]);
      ref.current?.setInitiativeSettings(DEFAULT_INITIATIVE_SETTINGS);
      ref.current?.setInitiativeCandle(60_000);
      ref.current?.applyInitiatives(book);
    });
    const layer = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate).find((candidate) => candidate instanceof InitiativePrimitive) as InitiativePrimitive;
    const exhaustion = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate).find((candidate) => candidate instanceof ExhaustionPrimitive) as ExhaustionPrimitive;
    vi.spyOn(exhaustion, "boxAt").mockReturnValue(null);
    const boxAt = vi.spyOn(layer, "boxAt").mockImplementation(() => describeInitiative(band));
    const setHover = vi.spyOn(layer, "setHover");
    crosshair({ x: 120, y: 80 }, 60);
    expect(boxAt).toHaveBeenCalledWith(120, 80);
    expect(setHover).toHaveBeenLastCalledWith("b");
    expect(container.querySelector(".whale-tooltip.initiative")?.textContent).toBe("Buy start · Strong (4 of 5)");
    expect(container.querySelectorAll(".whale-tooltip")).toHaveLength(1);
    click({ x: 120, y: 80 });
    const pinned = [...container.querySelectorAll<HTMLElement>(".whale-tooltip.initiative")].find((card) => card.querySelector(".whale-tooltip-participation") !== null)!;
    expect(pinned.querySelector(".whale-tooltip-side")?.textContent).toBe("▲ BUY START · STRONG (4 of 5)");
    expect([...pinned.querySelectorAll(".whale-tooltip-participation")].map((row) => row.children[0].textContent)).toEqual(["✓ Clean move", "✓ Strong candles", "✗ Volume burst", "✓ Buyers in charge", "✓ Big buyers"]);
    expect(container.querySelectorAll(".whale-tooltip.initiative")).toHaveLength(1);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect([...container.querySelectorAll<HTMLElement>(".whale-tooltip.initiative")].some((card) => card.querySelector(".whale-tooltip-participation") !== null)).toBe(false);
    boxAt.mockReturnValue(null);
    crosshair({ x: 121, y: 81 }, 60);
    expect(setHover).toHaveBeenLastCalledWith(null);
    expect(container.querySelector(".whale-tooltip.initiative")).toBeNull();
    boxAt.mockImplementation(() => describeInitiative(band));
    crosshair({ x: 120, y: 80 }, 60);
    expect(container.querySelector(".whale-tooltip.initiative")).not.toBeNull();
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(container.querySelector(".whale-tooltip.initiative")).toBeNull();
    expect(layer.shown).toBe(false);
  });

  it("one click pins one card: the initiative card over a whale wall in its band, the whale wall where no band is hit, and nothing of the band under a whale marker, an absorption sphere or an iceberg", async () => {
    const ref = await mountChart();
    const book = new InitiativeBook();
    const band = initiativeBand();
    book.apply(pageOf([band]));
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["initiative"]);
      ref.current?.setIndicatorVisibility(["initiative"]);
      ref.current?.setInitiativeSettings(DEFAULT_INITIATIVE_SETTINGS);
      ref.current?.setInitiativeCandle(60_000);
      ref.current?.applyInitiatives(book);
    });
    const attached = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate);
    const layer = attached.find((candidate) => candidate instanceof InitiativePrimitive) as InitiativePrimitive;
    const exhaustion = attached.find((candidate) => candidate instanceof ExhaustionPrimitive) as ExhaustionPrimitive;
    const whaleHeat = attached.find((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive;
    const whaleMarkers = attached.find((candidate) => candidate instanceof WhaleMarkersPrimitive) as WhaleMarkersPrimitive;
    const iceberg = attached.find((candidate) => candidate instanceof IcebergPrimitive) as IcebergPrimitive;
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const absorption = attached.find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    const shadeAt = vi.spyOn(exhaustion, "boxAt").mockReturnValue(null);
    const boxAt = vi.spyOn(layer, "boxAt").mockImplementation(() => describeInitiative(band));
    const HIT = { kind: "wall", index: 0, wall: {} } as unknown as WhaleHit;
    const CARD: WhaleCard = { side: 0, title: "BID · FILLED", usd: "$8.0M", sentence: "Sellers ate 76%.", meterPct: 76, facts: "100 BTC", details: [["Price", "80000.0"]] };
    const hitAt = vi.spyOn(whaleHeat, "hitAt").mockReturnValue(HIT);
    vi.spyOn(whaleHeat, "card").mockReturnValue(CARD);
    const cluster = vi.spyOn(whaleMarkers, "hitTestCluster").mockReturnValue(null);
    const sphere = vi.spyOn(absorption, "bubbleAt").mockReturnValue(null);
    const icebergCard = vi.spyOn(iceberg, "cardAt").mockReturnValue(null);
    const icebergMark = vi.spyOn(iceberg, "markAt").mockReturnValue(null);
    const pinnedCard = () => [...container.querySelectorAll<HTMLElement>(".whale-tooltip.initiative")].find((card) => card.querySelector(".whale-tooltip-participation") !== null) ?? null;
    const pinnedTitle = () => pinnedCard()?.querySelector(".whale-tooltip-side")?.textContent ?? null;
    click({ x: 400, y: 260 });
    expect(pinnedTitle()).toBe("▲ BUY START · STRONG (4 of 5)");
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
    boxAt.mockReturnValue(null);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    expect(container.querySelector(".whale-wall-card.pinned")).not.toBeNull();
    boxAt.mockImplementation(() => describeInitiative(band));
    hitAt.mockReturnValue(null);
    sphere.mockReturnValue({ side: "bid", title: "sphere" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    sphere.mockReturnValue(null);
    cluster.mockReturnValue({ side: "bid" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    cluster.mockReturnValue(null);
    icebergMark.mockReturnValue({ side: "ask", kind: "probable", title: "Probable iceberg · ask", headline: "", detailLine: "", whenLine: "" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    icebergMark.mockReturnValue(null);
    icebergCard.mockReturnValue({ side: "ask", kind: "probable", title: "Probable iceberg · ask", headline: "", detailLine: "", whenLine: "" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    icebergCard.mockReturnValue(null);
    click({ x: 400, y: 260 });
    expect(pinnedTitle()).toBe("▲ BUY START · STRONG (4 of 5)");
    shadeAt.mockReturnValue({ id: "shade", side: "buyers", short: "", title: "", lines: [] } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
  });
});

describe("ChartPanel exhaustion cards", () => {
  const T0 = Date.now();

  function exhaustionShade(over: Partial<ExhaustionShade> = {}): ExhaustionShade {
    return {
      id: "s", candleMs: 60_000, side: "buyers", status: "open", intensity: 2, score: 5,
      readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: true },
      values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
      raw: { own: 3, other: 7, legOwn: 14, moved: 0, legMoved: 1.8, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
      startTs: T0 - 120_000, endTs: T0 - 60_000, extremeTs: T0 - 180_000, extremePrice: 108, legStartTs: T0 - 600_000, legStartPrice: 100,
      legSize: 8, efficiency: 1, atr: 1, judgedAt: null, updatedAt: T0 - 60_000, origin: "runtime", ...over,
    };
  }

  function pageOf(shades: ExhaustionShade[], seq = 0): ExhaustionShadesFrame {
    return { type: "exhaustion_shades", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts: T0 + seq, seq, reset: seq === 0, shades, liveSince: T0 - 3_600_000, loading: null };
  }

  function layers() {
    const attached = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate);
    return {
      exhaustion: attached.find((candidate) => candidate instanceof ExhaustionPrimitive) as ExhaustionPrimitive,
      whaleHeat: attached.find((candidate) => candidate instanceof WhaleLimitHeatmapPrimitive) as WhaleLimitHeatmapPrimitive,
      whaleMarkers: attached.find((candidate) => candidate instanceof WhaleMarkersPrimitive) as WhaleMarkersPrimitive,
      iceberg: attached.find((candidate) => candidate instanceof IcebergPrimitive) as IcebergPrimitive,
      liquidity: attached.find((candidate) => candidate instanceof LiquidityHeatmapPrimitive) as LiquidityHeatmapPrimitive,
      bookMap: attached.find((candidate) => candidate instanceof L2BookMapPrimitive) as L2BookMapPrimitive,
    };
  }

  function crosshair(point: { x: number; y: number } | undefined, time: number | undefined = undefined) {
    const handler = chartMock.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time }));
  }

  function click(point: { x: number; y: number }) {
    const handler = chartMock.chart.subscribeClick.mock.calls.at(-1)![0] as (param: unknown) => void;
    act(() => handler({ point, paneIndex: 0, time: undefined }));
  }

  async function mountWithShade(shade = exhaustionShade()) {
    const ref = await mountChart();
    const book = new ExhaustionBook();
    book.apply(pageOf([shade]));
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.setIndicators(["exhaustion"]);
      ref.current?.setIndicatorVisibility(["exhaustion"]);
      ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC");
      ref.current?.setExhaustionCandle(60_000);
      ref.current?.applyExhaustions(book);
    });
    const { exhaustion } = layers();
    const boxAt = vi.spyOn(exhaustion, "boxAt").mockImplementation(() => describeExhaustion(book.get(shade.id) ?? shade, true, "BTC"));
    return { ref, book, boxAt, exhaustion };
  }

  const pinnedCard = () => [...container.querySelectorAll<HTMLElement>(".whale-tooltip.exhaustion")].find((card) => card.querySelector(".whale-tooltip-participation") !== null) ?? null;
  const pinnedTitle = () => pinnedCard()?.querySelector(".whale-tooltip-side")?.textContent ?? null;

  it("a pointer in a shade box shows the exhaustion line alone: no wall, Book Map cell, whale wall, pivot, FVG or session level under it is asked", async () => {
    const { ref } = await mountWithShade();
    const { liquidity, bookMap, whaleHeat, whaleMarkers, iceberg } = layers();
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const absorption = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate).find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    const runtime = indicatorRuntimes.at(-1)!;
    const studies = ["pivotPoints", "fvgDelta", "sessionLevels"] as const;
    act(() => {
      ref.current?.setIndicators(["exhaustion", ...studies]);
      ref.current?.setIndicatorVisibility(["exhaustion", ...studies]);
    });
    vi.spyOn(iceberg, "cardAt").mockReturnValue(null);
    vi.spyOn(iceberg, "markAt").mockReturnValue(null);
    vi.spyOn(whaleMarkers, "hitTestCluster").mockReturnValue(null);
    vi.spyOn(absorption, "bubbleAt").mockReturnValue(null);
    const wall = { side: "bid" as const, size: 73, peak: 80, state: "resting" as const, fill: null, ageMs: 60_000, priceLo: 99, priceHi: 101, unit: "BTC", label: "73.0 BTC", detail: "", peakLabel: "", lane: 0 };
    const levelAt = vi.spyOn(liquidity, "levelAt").mockReturnValue(wall);
    const cellAt = vi.spyOn(bookMap, "cellAt").mockReturnValue({ side: "bid" as const, volume: 5, priceLo: 99, priceHi: 101, timeStartMs: 0, timeEndMs: 60_000 });
    const whaleHit = vi.spyOn(whaleHeat, "hitAt").mockReturnValue({ kind: "wall", index: 0, wall: {} } as unknown as WhaleHit);
    const whaleSetHover = vi.spyOn(whaleHeat, "setHover");
    const markers = vi.spyOn(runtime, "getMarkers");
    const hoverData = vi.spyOn(runtime, "getHoverData");
    crosshair({ x: 120, y: 80 }, 60);
    expect(container.querySelectorAll(".whale-tooltip")).toHaveLength(1);
    expect(container.querySelector(".whale-tooltip.exhaustion")?.textContent).toBe("Buyers exhausted · 5/6");
    expect(levelAt).not.toHaveBeenCalled();
    expect(cellAt).not.toHaveBeenCalled();
    expect(whaleHit).not.toHaveBeenCalled();
    expect(whaleSetHover).toHaveBeenLastCalledWith(null);
    expect(container.querySelector(".whale-wall-card")).toBeNull();
    expect(markers).not.toHaveBeenCalledWith("pivotPoints");
    expect(hoverData).not.toHaveBeenCalledWith("fvgDelta");
    expect(hoverData).not.toHaveBeenCalledWith("sessionLevels");
    layers().exhaustion.boxAt = () => null;
    levelAt.mockReturnValue(null);
    cellAt.mockReturnValue(null);
    whaleHit.mockReturnValue(null);
    crosshair({ x: 121, y: 81 }, 60);
    expect(container.querySelector(".whale-tooltip.exhaustion")).toBeNull();
    expect(levelAt).toHaveBeenCalledWith(121, 81);
    expect(cellAt).toHaveBeenCalledWith(121, 81);
    expect(whaleHit).toHaveBeenCalledWith(121, 81);
    expect(markers).toHaveBeenCalledWith("pivotPoints");
    expect(hoverData).toHaveBeenCalledWith("fvgDelta");
    expect(hoverData).toHaveBeenCalledWith("sessionLevels");
  });

  it("one click pins one card: the exhaustion card over a whale wall in its box, the whale wall where no box is hit, and nothing of the exhaustion under a whale marker, an absorption sphere or an iceberg", async () => {
    const { boxAt } = await mountWithShade();
    const { whaleHeat, whaleMarkers, iceberg } = layers();
    const { AbsorptionPrimitive } = await import("../../../lib/indicators/absorption-detector/absorptionPrimitive");
    const absorption = chartMock.series.attachPrimitive.mock.calls.map(([candidate]) => candidate).find((candidate) => candidate instanceof AbsorptionPrimitive) as InstanceType<typeof AbsorptionPrimitive>;
    const HIT = { kind: "wall", index: 0, wall: {} } as unknown as WhaleHit;
    const CARD: WhaleCard = { side: 0, title: "BID · FILLED", usd: "$8.0M", sentence: "Sellers ate 76%.", meterPct: 76, facts: "100 BTC", details: [["Price", "80000.0"]] };
    const hitAt = vi.spyOn(whaleHeat, "hitAt").mockReturnValue(HIT);
    vi.spyOn(whaleHeat, "card").mockReturnValue(CARD);
    const cluster = vi.spyOn(whaleMarkers, "hitTestCluster").mockReturnValue(null);
    const sphere = vi.spyOn(absorption, "bubbleAt").mockReturnValue(null);
    const icebergCard = vi.spyOn(iceberg, "cardAt").mockReturnValue(null);
    const icebergMark = vi.spyOn(iceberg, "markAt").mockReturnValue(null);
    click({ x: 400, y: 260 });
    expect(pinnedTitle()).toBe("Buyers exhausted · 5/6 · ~60% · live");
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
    boxAt.mockReturnValue(null);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    expect(container.querySelector(".whale-wall-card.pinned")).not.toBeNull();
    boxAt.mockImplementation(() => describeExhaustion(exhaustionShade(), true, "BTC"));
    hitAt.mockReturnValue(null);
    sphere.mockReturnValue({ side: "bid", title: "sphere" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    expect(container.querySelector(".whale-wall-card.pinned")).toBeNull();
    sphere.mockReturnValue(null);
    cluster.mockReturnValue({ side: "bid" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    cluster.mockReturnValue(null);
    icebergMark.mockReturnValue({ side: "ask", kind: "probable", title: "Probable iceberg · ask", headline: "", detailLine: "", whenLine: "" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    icebergMark.mockReturnValue(null);
    icebergCard.mockReturnValue({ side: "ask", kind: "probable", title: "Probable iceberg · ask", headline: "", detailLine: "", whenLine: "" } as never);
    click({ x: 400, y: 260 });
    expect(pinnedCard()).toBeNull();
    icebergCard.mockReturnValue(null);
    click({ x: 400, y: 260 });
    expect(pinnedTitle()).toBe("Buyers exhausted · 5/6 · ~60% · live");
  });

  it("the pinned card reads the book as it is now: the score and the verdict follow the pages, the accuracy follows the sliders, and the card goes when the shade is filtered out or gone", async () => {
    const { ref, book } = await mountWithShade();
    click({ x: 400, y: 260 });
    expect(pinnedTitle()).toBe("Buyers exhausted · 5/6 · ~60% · live");
    book.apply(pageOf([exhaustionShade({ score: 6, intensity: 3, status: "held", judgedAt: T0, updatedAt: T0 })], 1));
    act(() => ref.current?.refreshExhaustions());
    expect(pinnedTitle()).toBe("Buyers exhausted · 6/6 · ~69% · held");
    act(() => ref.current?.setExhaustionSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 6 }, "BTC"));
    expect(pinnedTitle()).toBe("Buyers exhausted · 6/6 · held");
    act(() => ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC"));
    book.apply(pageOf([exhaustionShade({ score: 6, intensity: 3, status: "broke", judgedAt: T0 + 1, updatedAt: T0 + 1 })], 2));
    act(() => ref.current?.refreshExhaustions());
    expect(pinnedTitle()).toBe("Buyers exhausted · 6/6 · ~69% · broke through");
    act(() => ref.current?.setExhaustionSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showBroken: false }, "BTC"));
    expect(pinnedCard()).toBeNull();
    act(() => ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC"));
    expect(pinnedTitle()).toBe("Buyers exhausted · 6/6 · ~69% · broke through");
    book.clear();
    act(() => ref.current?.refreshExhaustions());
    expect(pinnedCard()).toBeNull();
  });

  it("hiding or removing the indicator takes the pinned card, the hover line and the primitive's hover with it", async () => {
    const { ref, exhaustion } = await mountWithShade();
    const setHover = vi.spyOn(exhaustion, "setHover");
    crosshair({ x: 400, y: 260 });
    click({ x: 400, y: 260 });
    expect(pinnedCard()).not.toBeNull();
    expect(setHover).toHaveBeenLastCalledWith("s");
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(pinnedCard()).toBeNull();
    expect(container.querySelector(".whale-tooltip.exhaustion")).toBeNull();
    expect(setHover).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicatorVisibility(["exhaustion"]));
    click({ x: 400, y: 260 });
    expect(pinnedCard()).not.toBeNull();
    act(() => ref.current?.setIndicators([]));
    expect(pinnedCard()).toBeNull();
  });

  it("keeps the pinned card inside the chart's width and flips it below a click near the top, like a whale card", async () => {
    await mountWithShade();
    const half = WHALE_CARD_WIDTH_PX / 2 + 6;
    Object.defineProperty(container.querySelector(".chart-mount")!, "clientWidth", { value: 1_200 });
    click({ x: 1_195, y: 250 });
    expect(pinnedCard()!.style.left).toBe(`${1_200 - half}px`);
    expect(pinnedCard()!.classList.contains("below")).toBe(false);
    click({ x: 5, y: 40 });
    expect(pinnedCard()!.style.left).toBe(`${half}px`);
    expect(pinnedCard()!.classList.contains("below")).toBe(true);
  });
});

describe("ChartPanel Live Range Control", () => {
  const START = Date.UTC(2026, 9, 16, 2, 35, 20);
  const REPORT: LiveRangeReport = {
    mode: "visible",
    fromTs: START,
    toTs: START + 30 * 60_000,
    live: false,
    read: { buys: 1_200, sells: 800, fromTs: START, toTs: START + 30 * 60_000, coveredMs: 30 * 60_000, tradedMs: 30 * 60_000, missing: [], noise: 400, minutesWon: { buyers: 0, sellers: 0 }, impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } } },
    loading: false,
    prints: null,
  };
  const POSITION_KEY = "terminal.live-range-control.card-position.v1";
  const SIDE_COLOURS = { ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#112233", askColor: "#445566" };

  afterEach(() => {
    historicallyAdmitted.clear();
  });

  function liveRangeLayers(): LiveRangePrimitive[] {
    return chartMock.series.attachPrimitive.mock.calls
      .map(([candidate]) => candidate)
      .filter((candidate): candidate is LiveRangePrimitive => candidate instanceof LiveRangePrimitive);
  }

  function callsOn(spy: { mock: { calls: unknown[][]; contexts: unknown[] } }, layer: LiveRangePrimitive): unknown[][] {
    return spy.mock.calls.filter((_, index) => spy.mock.contexts[index] === layer);
  }

  async function liveRangeGrid() {
    const { LiquidityGrid } = await import("../../../lib/indicators/passive-liquidity/liquidityGrid");
    return new LiquidityGrid();
  }

  async function mountLiveRange() {
    const ref = await mountChart();
    const grid = await liveRangeGrid();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyLiveRange(grid);
      ref.current?.setIndicators(["liveRangeControl"]);
      ref.current?.setIndicatorVisibility(["liveRangeControl"]);
    });
    return { ref, grid, layer: liveRangeLayers()[0] };
  }

  function report(layer: LiveRangePrimitive, next: LiveRangeReport | null) {
    act(() => layer.onRead?.(next));
  }

  function liveRangeCards(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-testid="live-range-card"]')];
  }

  function topRightStack(): HTMLElement | null {
    return container.querySelector<HTMLElement>(".draw-table-overlay-stack--monitor");
  }

  function zoneOf(card: HTMLElement): string | null {
    return [card.querySelector(".candle-monitor-candle")?.textContent, card.querySelector(".live-range-since")?.textContent].filter((text) => text !== undefined).join(" · ");
  }

  function volumeOf(card: HTMLElement): (string | null)[] {
    return [...card.querySelectorAll('[data-row="volume"] .live-range-value')].map((cell) => cell.textContent);
  }

  function sideColoursOf(card: HTMLElement): string[] {
    return [...card.querySelectorAll<HTMLElement>("tr.live-range-head th")].map((cell) => cell.style.color);
  }

  function sizePane() {
    const pane = container.querySelector<HTMLElement>(".chart-mount-wrap")!;
    Object.defineProperty(pane, "clientWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 800 });
    pane.getBoundingClientRect = () => ({ left: 100, top: 20, width: 1_200, height: 800, right: 1_300, bottom: 820, x: 100, y: 20, toJSON: () => ({}) });
  }

  function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number) {
    act(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX, clientY })); });
  }

  it("attaches one live range layer to the chart and hands it the latest grid only while the indicator is on and visible", async () => {
    const ref = await mountChart();
    expect(liveRangeLayers()).toHaveLength(1);
    const layer = liveRangeLayers()[0];
    const setShown = vi.spyOn(layer, "setShown");
    const setGrid = vi.spyOn(layer, "setGrid");
    const grid = await liveRangeGrid();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyLiveRange(grid);
    });
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicators(["liveRangeControl"]));
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicatorVisibility(["liveRangeControl"]));
    expect(setShown).toHaveBeenLastCalledWith(true);
    expect(setGrid.mock.lastCall?.[0]).toBe(grid);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicatorVisibility(["liveRangeControl"]));
    expect(setShown).toHaveBeenLastCalledWith(true);
    expect(setGrid.mock.lastCall?.[0]).toBe(grid);
    act(() => ref.current?.setIndicators([]));
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    act(() => ref.current?.setIndicators(["liveRangeControl"]));
    expect(setShown).toHaveBeenLastCalledWith(true);
    expect(setGrid.mock.lastCall?.[0]).toBe(grid);
    act(() => ref.current?.applyLiveRange(null));
    expect(setShown).toHaveBeenLastCalledWith(true);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    const next = await liveRangeGrid();
    act(() => ref.current?.applyLiveRange(next));
    expect(setGrid.mock.lastCall?.[0]).toBe(next);
    expect(liveRangeLayers()).toHaveLength(1);
  });

  it("is never shown on a historical chart, even one that admits the indicator, and comes back with the latest grid on the live chart", async () => {
    historicallyAdmitted.add("liveRangeControl");
    const { ref, layer } = await mountLiveRange();
    const setShown = vi.spyOn(layer, "setShown");
    const setGrid = vi.spyOn(layer, "setGrid");
    report(layer, REPORT);
    expect(liveRangeCards()).toHaveLength(1);
    act(() => ref.current?.setHistoricalIndicatorCapabilities(["ohlcv"], "BINANCE"));
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    expect(liveRangeCards()).toHaveLength(0);
    const later = await liveRangeGrid();
    act(() => ref.current?.applyLiveRange(later));
    expect(setShown).toHaveBeenLastCalledWith(false);
    expect(setGrid).toHaveBeenLastCalledWith(null);
    report(layer, REPORT);
    expect(liveRangeCards()).toHaveLength(0);
    act(() => ref.current?.setHistoricalIndicatorCapabilities(null));
    expect(setShown).toHaveBeenLastCalledWith(true);
    expect(setGrid.mock.lastCall?.[0]).toBe(later);
    expect(liveRangeCards()).toHaveLength(1);
  });

  it("gives the live range layer its own lane of the column history for the host's columns, a fresh one per stream, and takes it away with the stream", async () => {
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const { LiveRangeHistory } = await import("../../../lib/indicators/live-range-control/liveRangeHistory");
    const { ref, layer } = await mountLiveRange();
    const setHistory = vi.spyOn(layer, "setHistory");
    const dispose = vi.spyOn(LiveRangeHistory.prototype, "dispose");
    const stream = new ColumnHistoryStream({ request: () => {} });
    const fork = vi.spyOn(stream, "fork");
    act(() => ref.current?.applyColumnHistory(stream));
    expect(fork).toHaveBeenCalledTimes(2);
    const given = setHistory.mock.lastCall?.[0];
    expect(given).toBeInstanceOf(LiveRangeHistory);
    const second = new ColumnHistoryStream({ request: () => {} });
    act(() => ref.current?.applyColumnHistory(second));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(setHistory.mock.lastCall?.[0]).toBeInstanceOf(LiveRangeHistory);
    expect(setHistory.mock.lastCall?.[0]).not.toBe(given);
    act(() => ref.current?.applyColumnHistory(null));
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(setHistory).toHaveBeenLastCalledWith(null);
  });

  it("a chart rebuilt for a new colour scheme hands its live range layer the column history lane it already had", async () => {
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const { LiveRangeHistory } = await import("../../../lib/indicators/live-range-control/liveRangeHistory");
    const setHistory = vi.spyOn(LiveRangePrimitive.prototype, "setHistory");
    const { ref } = await mountLiveRange();
    act(() => ref.current?.applyColumnHistory(new ColumnHistoryStream({ request: () => {} })));
    const lane = setHistory.mock.lastCall?.[0];
    expect(lane).toBeInstanceOf(LiveRangeHistory);
    await mountChart(undefined, "dark");
    const rebuilt = liveRangeLayers()[1];
    expect(callsOn(setHistory, rebuilt).at(-1)?.[0]).toBe(lane);
  });

  it("hands the live range layer the settings of the trader with the unit of the instrument, and the window, as they change", async () => {
    const { ref, layer } = await mountLiveRange();
    const setSettings = vi.spyOn(layer, "setSettings");
    const setWindow = vi.spyOn(layer, "setWindow");
    const settings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live" as const, bigPrint: 5 };
    act(() => ref.current?.setLiveRangeSettings(settings, "BTC"));
    expect(setSettings.mock.lastCall).toEqual([settings, "BTC"]);
    expect(setSettings.mock.lastCall?.[0]).toBe(settings);
    act(() => ref.current?.setLiveRangeSettings(settings));
    expect(setSettings.mock.lastCall).toEqual([settings, ""]);
    const window = { fromMs: START + 60_000, toMs: null };
    act(() => ref.current?.setLiveRangeWindow(window));
    expect(setWindow.mock.lastCall?.[0]).toBe(window);
  });

  it("a chart rebuilt for a new colour scheme hands its live range layer the settings with the unit, the window and the grid, and lets go of the old one", async () => {
    const setSettings = vi.spyOn(LiveRangePrimitive.prototype, "setSettings");
    const setWindow = vi.spyOn(LiveRangePrimitive.prototype, "setWindow");
    const setShown = vi.spyOn(LiveRangePrimitive.prototype, "setShown");
    const setGrid = vi.spyOn(LiveRangePrimitive.prototype, "setGrid");
    const { ref, grid, layer: first } = await mountLiveRange();
    const settings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "selected" as const, bidColor: "#ff9800" };
    const window = { fromMs: START + 60_000, toMs: START + 120_000 };
    act(() => {
      ref.current?.setLiveRangeSettings(settings, "ETH");
      ref.current?.setLiveRangeWindow(window);
    });
    expect(liveRangeLayers()).toHaveLength(1);
    const rebuiltRef = await mountChart(undefined, "dark");
    expect(liveRangeLayers()).toHaveLength(2);
    expect(chartMock.series.detachPrimitive).toHaveBeenCalledWith(first);
    const rebuilt = liveRangeLayers()[1];
    expect(callsOn(setSettings, rebuilt).at(-1)).toEqual([settings, "ETH"]);
    expect(callsOn(setSettings, rebuilt).at(-1)?.[0]).toBe(settings);
    expect(callsOn(setWindow, rebuilt).at(-1)?.[0]).toBe(window);
    expect(callsOn(setShown, rebuilt).at(-1)).toEqual([true]);
    expect(callsOn(setGrid, rebuilt).at(-1)?.[0]).toBe(grid);
    const again = { ...DEFAULT_LIVE_RANGE_SETTINGS, askColor: "#00ff00" };
    act(() => rebuiltRef.current?.setLiveRangeSettings(again));
    expect(callsOn(setSettings, rebuilt).at(-1)?.[0]).toBe(again);
    expect(callsOn(setSettings, first).at(-1)?.[0]).toBe(settings);
  });

  async function mountDraggable(onLiveRangeWindowChange: (window: LiveRangeWindow) => void) {
    const ref = await mountChart(undefined, undefined, { onLiveRangeWindowChange });
    const grid = await liveRangeGrid();
    act(() => {
      ref.current?.applySnapshot([bar(0), bar(60_000)]);
      ref.current?.applyLiveRange(grid);
      ref.current?.setIndicators(["liveRangeControl"]);
      ref.current?.setIndicatorVisibility(["liveRangeControl"]);
    });
    const mount = container.querySelector<HTMLElement>(".chart-mount")!;
    const captured = new Set<number>();
    mount.setPointerCapture = (id: number) => void captured.add(id);
    mount.hasPointerCapture = (id: number) => captured.has(id);
    mount.releasePointerCapture = (id: number) => void captured.delete(id);
    const fire = (type: string, clientX: number, init: PointerEventInit = {}) => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 3, clientX, clientY: 50, ...init });
      act(() => { mount.dispatchEvent(event); });
      return event;
    };
    return { ref, layer: liveRangeLayers()[0], captured, fire };
  }

  it("drags a zone line on the chart: a press on a line takes the pointer from the chart, each move drags the line, and the release hands the moved window up once", async () => {
    const onLiveRangeWindowChange = vi.fn();
    const { layer, captured, fire } = await mountDraggable(onLiveRangeWindowChange);
    const moved = { fromMs: START, toMs: null };
    const lineAt = vi.spyOn(layer, "lineAt").mockImplementation((x) => (Math.abs(x - 300) <= 6 ? "from" : null));
    const hoverLine = vi.spyOn(layer, "hoverLine");
    const dragTo = vi.spyOn(layer, "dragTo").mockReturnValue(moved);
    const endDrag = vi.spyOn(layer, "endDrag").mockReturnValue(moved);
    fire("pointermove", 200);
    expect(hoverLine).toHaveBeenLastCalledWith(null);
    fire("pointermove", 302);
    expect(hoverLine).toHaveBeenLastCalledWith("from");
    expect(fire("pointerdown", 200).defaultPrevented).toBe(false);
    expect(captured.size).toBe(0);
    fire("pointermove", 200);
    expect(hoverLine).toHaveBeenLastCalledWith(null);
    expect(fire("pointerdown", 301).defaultPrevented).toBe(true);
    expect(hoverLine).toHaveBeenLastCalledWith("from");
    expect(lineAt).toHaveBeenLastCalledWith(301, 50);
    expect(captured.has(3)).toBe(true);
    fire("pointermove", 340);
    fire("pointermove", 360, { pointerId: 4 });
    fire("pointermove", 360);
    expect(dragTo.mock.calls).toEqual([["from", 340], ["from", 360]]);
    expect(onLiveRangeWindowChange).not.toHaveBeenCalled();
    fire("pointerup", 360, { pointerId: 4 });
    expect(endDrag).not.toHaveBeenCalled();
    fire("pointerup", 360);
    expect(endDrag).toHaveBeenCalledTimes(1);
    expect(onLiveRangeWindowChange.mock.calls).toEqual([[moved]]);
    expect(captured.has(3)).toBe(false);
    fire("pointermove", 380);
    expect(dragTo).toHaveBeenCalledTimes(2);
    fire("pointermove", 301);
    expect(hoverLine).toHaveBeenLastCalledWith("from");
    fire("pointerleave", 301);
    expect(hoverLine).toHaveBeenLastCalledWith(null);
  });

  it("hands nothing up for a press that moved no line, ends a cancelled drag like a release, and leaves the press to the chart for another button, a drawing tool or a handle that took it first", async () => {
    const onLiveRangeWindowChange = vi.fn();
    const { ref, layer, captured, fire } = await mountDraggable(onLiveRangeWindowChange);
    vi.spyOn(layer, "lineAt").mockImplementation((x) => (Math.abs(x - 300) <= 6 ? "to" : null));
    const endDrag = vi.spyOn(layer, "endDrag");
    fire("pointerdown", 300);
    fire("pointerup", 300);
    expect(endDrag).toHaveBeenCalledTimes(1);
    expect(onLiveRangeWindowChange).not.toHaveBeenCalled();
    const moved = { fromMs: START, toMs: START + 60_000 };
    endDrag.mockReturnValue(moved);
    fire("pointerdown", 300);
    fire("pointercancel", 300);
    expect(onLiveRangeWindowChange.mock.calls).toEqual([[moved]]);
    expect(captured.size).toBe(0);
    expect(fire("pointerdown", 300, { button: 2 }).defaultPrevented).toBe(false);
    act(() => ref.current?.setActiveDrawingTool("trendline"));
    expect(fire("pointerdown", 300).defaultPrevented).toBe(false);
    act(() => ref.current?.setActiveDrawingTool(null));
    const takeFirst = (event: Event) => event.preventDefault();
    document.addEventListener("pointerdown", takeFirst, true);
    try {
      fire("pointerdown", 300);
      expect(captured.size).toBe(0);
    } finally {
      document.removeEventListener("pointerdown", takeFirst, true);
    }
    expect(fire("pointerdown", 300).defaultPrevented).toBe(true);
  });

  it("shows the card in the top-right column left of the price axis once the layer has read the screen, after the candle monitor when that shows too, and takes it down with the read or the indicator", async () => {
    const { ref, layer } = await mountLiveRange();
    expect(liveRangeCards()).toHaveLength(0);
    expect(topRightStack()).toBeNull();
    report(layer, REPORT);
    expect(liveRangeCards()).toHaveLength(1);
    const card = liveRangeCards()[0];
    const stack = topRightStack();
    expect(stack).not.toBeNull();
    expect(stack!.className).toBe("draw-table-overlay-stack draw-table-overlay-stack--monitor");
    expect(stack!.style.right).toBe(`${64 + AXIS_INSET_GAP_PX}px`);
    expect(stack!.firstElementChild).toBe(card);
    expect(card.dataset.placed).toBeUndefined();
    expect(zoneOf(card)).toBe("on screen · 02:35 → 03:05 UTC · 30 min");
    report(layer, { ...REPORT, toTs: START + 60 * 60_000 });
    expect(zoneOf(liveRangeCards()[0])).toBe("on screen · 02:35 → 03:35 UTC · 60 min");
    report(layer, { ...REPORT, mode: "live", live: true });
    expect(zoneOf(liveRangeCards()[0])).toBe("live zone · since 02:35 UTC · 30 min");
    report(layer, REPORT);
    expect(volumeOf(card)).toEqual(["1.2k", "800"]);
    act(() => ref.current?.setLiveRangeSettings(SIDE_COLOURS));
    expect(sideColoursOf(liveRangeCards()[0])).toEqual(["", "rgb(17, 34, 51)", "rgb(68, 85, 102)"]);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(liveRangeCards()).toHaveLength(0);
    expect(topRightStack()).toBeNull();
    act(() => ref.current?.setIndicatorVisibility(["liveRangeControl"]));
    expect(liveRangeCards()).toHaveLength(1);
    report(layer, null);
    expect(liveRangeCards()).toHaveLength(0);
    expect(topRightStack()).toBeNull();
    report(layer, REPORT);
    act(() => {
      ref.current?.setIndicators(["liveRangeControl", "exhaustion"]);
      ref.current?.setIndicatorVisibility(["liveRangeControl", "exhaustion"]);
      ref.current?.setExhaustionSettings(DEFAULT_EXHAUSTION_SETTINGS, "BTC");
      ref.current?.setExhaustionCandle(60_000);
    });
    const monitor = container.querySelector<HTMLElement>(".candle-monitor");
    expect(monitor).not.toBeNull();
    expect(liveRangeCards()).toHaveLength(1);
    expect(topRightStack()!.firstElementChild).toBe(monitor);
    expect(monitor!.nextElementSibling).toBe(liveRangeCards()[0]);
    expect(topRightStack()!.style.right).toBe(`${64 + AXIS_INSET_GAP_PX}px`);
    act(() => ref.current?.setIndicatorVisibility(["exhaustion"]));
    expect(liveRangeCards()).toHaveLength(0);
    expect(topRightStack()!.firstElementChild).toBe(container.querySelector(".candle-monitor"));
  });

  it("leaves the column for the spot its grip drags it to and saves that spot, and a double click on the grip puts it back and forgets it", async () => {
    const { layer } = await mountLiveRange();
    sizePane();
    report(layer, REPORT);
    const stacked = liveRangeCards()[0];
    expect(stacked.parentElement).toBe(topRightStack());
    stacked.getBoundingClientRect = () => ({ left: 1_000, top: 60, width: 236, height: 120, right: 1_236, bottom: 180, x: 1_000, y: 60, toJSON: () => ({}) });
    Object.defineProperty(stacked, "offsetWidth", { configurable: true, value: 236 });
    Object.defineProperty(stacked, "offsetHeight", { configurable: true, value: 120 });
    const grip = stacked.querySelector<HTMLButtonElement>("button.live-range-grip")!;
    pointer(grip, "pointerdown", 1_010, 70);
    pointer(grip, "pointermove", 950, 110);
    pointer(grip, "pointerup", 950, 110);
    expect(liveRangeCards()).toHaveLength(1);
    const placed = liveRangeCards()[0];
    expect(placed.closest(".draw-table-overlay-stack")).toBeNull();
    expect(placed.dataset.placed).toBe("true");
    expect([placed.style.left, placed.style.top]).toEqual(["840px", "80px"]);
    expect(JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null")).toEqual({ x: Number(placed.style.left.replace("px", "")), y: Number(placed.style.top.replace("px", "")) });
    act(() => { placed.querySelector<HTMLButtonElement>("button.live-range-grip")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(liveRangeCards()).toHaveLength(1);
    expect(liveRangeCards()[0].parentElement).toBe(topRightStack());
    expect(liveRangeCards()[0].dataset.placed).toBeUndefined();
    expect(localStorage.getItem(POSITION_KEY)).toBeNull();
  });

  it("opens a card placed on an earlier chart at its saved spot, shown inside this chart without moving the saved spot, with the read and the trader's colours, and takes it down with the read or the indicator", async () => {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ x: 5_000, y: 80 }));
    const { ref, layer } = await mountLiveRange();
    sizePane();
    act(() => ref.current?.setLiveRangeSettings(SIDE_COLOURS));
    report(layer, REPORT);
    expect(liveRangeCards()).toHaveLength(1);
    const placed = liveRangeCards()[0];
    expect(placed.closest(".draw-table-overlay-stack")).toBeNull();
    expect(topRightStack()).toBeNull();
    expect(placed.dataset.placed).toBe("true");
    Object.defineProperty(placed, "offsetWidth", { configurable: true, value: 236 });
    Object.defineProperty(placed, "offsetHeight", { configurable: true, value: 120 });
    act(() => ref.current?.setLiveRangeSettings({ ...SIDE_COLOURS }));
    expect([placed.style.left, placed.style.top]).toEqual(["960px", "80px"]);
    expect(JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null")).toEqual({ x: 5_000, y: 80 });
    expect(zoneOf(placed)).toBe("on screen · 02:35 → 03:05 UTC · 30 min");
    report(layer, { ...REPORT, toTs: START + 60 * 60_000 });
    expect(zoneOf(liveRangeCards()[0])).toBe("on screen · 02:35 → 03:35 UTC · 60 min");
    report(layer, REPORT);
    expect(volumeOf(placed)).toEqual(["1.2k", "800"]);
    expect(sideColoursOf(placed)).toEqual(["", "rgb(17, 34, 51)", "rgb(68, 85, 102)"]);
    act(() => ref.current?.setIndicatorVisibility([]));
    expect(liveRangeCards()).toHaveLength(0);
    act(() => ref.current?.setIndicatorVisibility(["liveRangeControl"]));
    expect(liveRangeCards()).toHaveLength(1);
    expect(liveRangeCards()[0].dataset.placed).toBe("true");
    report(layer, null);
    expect(liveRangeCards()).toHaveLength(0);
  });
});
