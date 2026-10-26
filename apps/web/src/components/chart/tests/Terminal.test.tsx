// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type {
  UseMarketDataResult,
  UseMarketDataOptions,
} from "../../../hooks/useMarketData";
import type { TradeFrame } from "../../../types/frames";
import { formatRecordingLag } from "../../../lib/chart/recordingLag";
import { RangePrintStore } from "../../../lib/indicators/aggressive-orders-profile/rangePrintStore";
import { LiquidityGrid } from "../../../lib/indicators/passive-liquidity/liquidityGrid";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { chartHandle } = vi.hoisted(() => ({
  chartHandle: {
    applySnapshot: vi.fn(),
    setHistoricalRollMarkers: vi.fn(),
    setHistoricalIndicatorCapabilities: vi.fn(),
    applyBar: vi.fn(),
    applyRawBars: vi.fn(),
    setIndicators: vi.fn(),
    setIndicatorVisibility: vi.fn(),
    setKillzoneSessions: vi.fn(),
    applyMarkerSnapshot: vi.fn(),
    setDivergenceSettings: vi.fn(),
    setOrderFlowDisplayMode: vi.fn(),
    setActiveDrawingTool: vi.fn(),
    applyProfileFrame: vi.fn(),
    applyHistoricalProfiles: vi.fn(),
    applyVpinReadings: vi.fn(),
    applyBarFlow: vi.fn(),
    setSessionProfileSettings: vi.fn(),
    setSessionDeltaProfileSettings: vi.fn(),
    setVpinCloudSettings: vi.fn(),
    applyLiquidity: vi.fn(),
    applyHistoricalL2: vi.fn(),
    applyTicks: vi.fn(),
    applyL2: vi.fn(),
    refreshL2: vi.fn(),
    applyBandHistory: vi.fn(),
    bandHistoryWants: vi.fn(() => []),
    refreshLiquidity: vi.fn(),
    setLiquiditySettings: vi.fn(),
    setLiquidityLane: vi.fn(),
    applyHeatmapHistory: vi.fn(),
    applyColumnHistory: vi.fn(),
    applyHostWalls: vi.fn(),
    applyWhaleWalls: vi.fn(),
    setL2SupportResistanceSettings: vi.fn(),
    setL2BookMapSettings: vi.fn(),
    setWhaleHeatmapSettings: vi.fn(),
    setAggressiveSettings: vi.fn(),
    applyAggressiveTape: vi.fn(),
    applyDeltaProfile: vi.fn(),
    applyDeltaTickProfile: vi.fn(),
    setLiveDeltaSettings: vi.fn(),
    applyOrderBookProfile: vi.fn(),
    applyAggressiveProfile: vi.fn(),
    applyAggressiveProfilePrints: vi.fn(),
    setAggressiveProfileSettings: vi.fn(),
    setLiveOrderBookSettings: vi.fn(),
    setAggressiveRules: vi.fn(),
    setAbsorptionSettings: vi.fn(),
    setAbsorptionRules: vi.fn(),
    applyExhaustions: vi.fn(),
    applyCandleMonitor: vi.fn(),
    refreshExhaustions: vi.fn(),
    setExhaustionSettings: vi.fn(),
    setExhaustionCandle: vi.fn(),
    applyInitiatives: vi.fn(),
    refreshInitiatives: vi.fn(),
    setInitiativeSettings: vi.fn(),
    setInitiativeCandle: vi.fn(),
    applyLiveRange: vi.fn(),
    setLiveRangeSettings: vi.fn(),
    setLiveRangeStart: vi.fn(),
    setLiveRangeWindow: vi.fn(),
    applyIcebergs: vi.fn(),
    refreshIcebergs: vi.fn(),
    setIcebergSettings: vi.fn(),
    getVisibleRangeMs: vi.fn((): { fromMs: number; toMs: number } | null => null),
    subscribeVisibleRangeChange: vi.fn(() => () => {}),
  },
}));

let mockResult: UseMarketDataResult;
let capturedOptions: UseMarketDataOptions | null = null;

vi.mock("../../../hooks/useMarketData", () => ({
  useMarketData: (options: UseMarketDataOptions) => {
    capturedOptions = options;
    return mockResult;
  },
}));

vi.mock("../ChartPanel", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    ChartPanel: forwardRef(function MockChartPanel(_props, ref) {
      useImperativeHandle(ref, () => chartHandle);
      return null;
    }),
  };
});

let capturedDomPanelProps: {
  book: unknown;
  lastPrice: number | undefined;
  lastTickDirection: "up" | "down" | null;
} | null = null;

vi.mock("../DomPanel", () => ({
  DomPanel: (props: {
    book: unknown;
    lastPrice: number | undefined;
    lastTickDirection: "up" | "down" | null;
  }) => {
    capturedDomPanelProps = props;
    return null;
  },
}));

vi.stubEnv("VITE_ARCHIVE_CLIENT_TOKEN", "");
const { Terminal } = await import("../Terminal");

function baseResult(
  overrides: Partial<UseMarketDataResult> = {},
): UseMarketDataResult {
  return {
    status: "open",
    feedHealth: null,
    trades: [],
    markerView: {
      version: 0,
      size: () => 0,
      snapshot: () => [],
      topByMagnitude: () => ({ stats: [], resolvedThreshold: null }),
      atLeastMagnitude: () => [],
    },
    markersVersion: 0,
    book: null,
    profile: null,
    liquidity: null,
    liquidityVersion: 0,
    heatmapHistory: null,
    columnHistory: null,
    hostWalls: null,
    whaleWalls: null,
    l2: null,
    l2Version: 0,
    icebergs: null,
    icebergsVersion: 0,
    exhaustions: null,
    exhaustionsVersion: 0,
    initiatives: null,
    initiativesVersion: 0,
    candleMonitor: null,
    aggressiveTape: null,
    aggressiveHistoryIssue: null,
    bandHistory: null,
    bandHistoryVersion: 0,
    requestBandHistory: () => {},
    requestL2History: async () => null,
    deltaProfile: null,
    deltaProfileVersion: 0,
    deltaTickProfile: null,
    deltaTickProfileVersion: 0,
    requestDeltaProfile: () => {},
    rangePrints: null,
    askRangePrints: () => {},
    historicalProfiles: [],
    vpinHistory: [],
    vpinStatus: null,
    barHistory: null,
    activeSelection: null,
    selectPair: vi.fn(),
    sendProfileConfig: vi.fn(),
    sendProfileHistory: vi.fn(),
    requestLiquidityResync: vi.fn(),
    requestExhaustionHistory: vi.fn(),
    requestInitiativeHistory: vi.fn(),
    requestAggressiveHistory: vi.fn(),
    stats: {
      tradesReceived: 0,
      barUpdatesReceived: 0,
      barsClosed: 0,
      latencyMs: null,
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  capturedOptions = null;
  capturedDomPanelProps = null;
});

afterEach(async () => {
  // Without this, stale containers from earlier tests stay in
  // document.body and P3.04's id="panel-content-*" elements collide --
  // jsdom's ID-selector fast path then resolves against the wrong
  // (or no) element instead of scoping to the current container.
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

async function render(result: UseMarketDataResult) {
  mockResult = result;
  await act(async () => {
    root.render(<Terminal />);
  });
}

// Seeds a bar via the captured onSnapshotBars callback, exactly the way
// the real useMarketData -> Terminal wiring would on a real snapshot --
// makes latestBar non-null so the overlay's other two gating conditions
// (status !== "open", latestBar === null) are both false, isolating
// whatever backendDegraded contributes on its own.
async function seedLatestBar() {
  await act(async () => {
    capturedOptions?.onSnapshotBars?.([
      {
        type: "bar",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 0,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        trade_count: 1,
        closed: true,
      },
    ]);
  });
}

describe("Terminal -- status chip and chart overlay against real feed-health states (P3.01 AC)", () => {
  it("a collector that stopped writing gets its own chip with how far behind the recording is, beside a feed chip that still says LIVE", async () => {
    // 2026-09-15: the collector died at 05:27 UTC and the chart said LIVE all day; the feed was fine, the recording was not.
    const stoppedAt = Date.now() - 7 * 3_600_000 - 12 * 60_000;
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "READY",
          stale: false,
          recordingStale: true,
          recordingLatestTs: stoppedAt,
        },
      }),
    );
    await seedLatestBar();
    const chip = container.querySelector(".status-chip.recording");
    expect(chip?.textContent).toContain("NO RECORDING");
    expect(chip?.textContent).toContain("7h 12m");
    expect(
      container.querySelectorAll(".status-chip")[
        container.querySelectorAll(".status-chip").length - 1
      ]?.textContent,
    ).toContain("LIVE");
    expect(container.querySelector(".chart-overlay")).toBeNull();
    // Unknown last trade: the chip still says the recording is off, without a number it would have to invent.
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "READY",
          stale: false,
          recordingStale: true,
        },
      }),
    );
    expect(container.querySelector(".status-chip.recording")?.textContent).toBe(
      "NO RECORDING",
    );
    // A recording that is being written has no chip.
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "READY",
          stale: false,
          recordingStale: false,
          recordingLatestTs: Date.now(),
        },
      }),
    );
    expect(container.querySelector(".status-chip.recording")).toBeNull();
    // Nor does a socket that is not open, whatever the last health said.
    await render(
      baseResult({
        status: "closed",
        feedHealth: {
          recoveryState: "READY",
          stale: false,
          recordingStale: true,
          recordingLatestTs: stoppedAt,
        },
      }),
    );
    expect(container.querySelector(".status-chip.recording")).toBeNull();
    expect(formatRecordingLag(30_000)).toBe("just now");
    expect(formatRecordingLag(59 * 60_000)).toBe("59 min");
    expect(formatRecordingLag(26 * 3_600_000 + 5 * 60_000)).toBe("26h 5m");
  });

  it("status connecting: chip shows CONNECTING, overlay shows Connecting to feed", async () => {
    await render(baseResult({ status: "connecting" }));
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "CONNECTING",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Connecting to feed",
    );
  });

  it("status closed: chip shows CLOSED, overlay shows Disconnected", async () => {
    await render(baseResult({ status: "closed" }));
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "CLOSED",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Disconnected",
    );
  });

  it("status open, no validated health yet: chip stays SYNCING and the chart waits for history", async () => {
    await render(baseResult({ status: "open", feedHealth: null }));
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "SYNCING",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Waiting for history",
    );
  });

  it("status open, no validated health yet, but real history already loaded (e.g. from backfill): the chip stays SYNCING but the chart is NOT blurred -- real data on screen shouldn't hide behind a status the chart itself doesn't need", async () => {
    await render(baseResult({ status: "open", feedHealth: null }));
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "SYNCING",
    );
    expect(container.querySelector(".chart-overlay")).toBeNull();
    expect(container.querySelector(".live-tag")).toBeNull();
  });

  it("status open, healthy, a bar has arrived: chip shows LIVE with a pulse dot, overlay is gone", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "LIVE",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "pulse",
    );
    expect(container.querySelector(".chart-overlay")).toBeNull();
  });

  it("RECOVERING is not collapsed into LIVE or Connecting -- chip shows RECOVERING, overlay stays visible even with a bar already on screen", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "RECOVERING", stale: true },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "RECOVERING",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "LIVE",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "recovering",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Recovering feed",
    );
  });

  it("without a dxFeed broker the chart says history only, not a failure", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "DXFEED_NOT_CONFIGURED",
        },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "HISTORY ONLY",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "UNAVAILABLE",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "quiet",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "History only · dxFeed live not configured",
    );
    expect(
      container.querySelector(".chart-overlay")?.textContent,
    ).not.toContain("Feed unavailable");
  });

  it("UNAVAILABLE is not collapsed into LIVE or Connecting -- chip shows UNAVAILABLE, overlay names the reason", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "CONNECTION_DOWN",
        },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "UNAVAILABLE",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "LIVE",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "unavailable",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Feed unavailable",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "CONNECTION_DOWN",
    );
  });

  it("a degraded event is never a silent drop or an uncaught exception -- rendering with every feedHealth state throws nothing", async () => {
    for (const recoveryState of [
      "READY",
      "RECOVERING",
      "UNAVAILABLE",
    ] as const) {
      await expect(
        render(
          baseResult({
            status: "open",
            feedHealth: { recoveryState, stale: recoveryState !== "READY" },
          }),
        ),
      ).resolves.not.toThrow();
    }
  });

  it("READY but stale is not collapsed into LIVE -- chip shows STALE, overlay stays visible", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: true },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "STALE",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "LIVE",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "stale",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Feed stale",
    );
  });

  it("printsQuiet flips the chip to QUIET and suppresses the blur once real history is already on screen -- the market-quiet-not-broken signal", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "RECOVERING",
          stale: true,
          printsQuiet: true,
        },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "QUIET",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "RECOVERING",
    );
    expect(container.querySelector(".status-chip .dot")?.className).toContain(
      "quiet",
    );
    expect(container.querySelector(".chart-overlay")).toBeNull();
  });

  it("printsQuiet with no history yet still shows an overlay, but a calm quiet message instead of Recovering feed", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "RECOVERING",
          stale: true,
          printsQuiet: true,
        },
      }),
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Market quiet",
    );
    expect(
      container.querySelector(".chart-overlay")?.textContent,
    ).not.toContain("Recovering feed");
  });

  it("a symbol that was already READY and then goes quiet also shows QUIET, not a falsely confident LIVE", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false, printsQuiet: true },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "QUIET",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "LIVE",
    );
    expect(container.querySelector(".chart-overlay")).toBeNull();
  });

  it("the chart's own green LIVE badge is suppressed while quiet, even though recoveryState never left READY", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".live-tag")).not.toBeNull();

    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false, printsQuiet: true },
      }),
    );
    expect(container.querySelector(".live-tag")).toBeNull();
  });

  it("UNAVAILABLE always wins over printsQuiet -- a real failure is never softened into a calm quiet reading", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "UNAVAILABLE",
          stale: true,
          printsQuiet: true,
          reason: "CONNECTION_DOWN",
        },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "UNAVAILABLE",
    );
    expect(container.querySelector(".status-chip")?.textContent).not.toContain(
      "QUIET",
    );
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Feed unavailable",
    );
    expect(
      container.querySelector(".chart-overlay")?.textContent,
    ).not.toContain("Market quiet");
  });

  it("an empty snapshot after a bar has already rendered clears latestBar so the overlay returns to waiting, not a previous session's candle", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".chart-overlay")).toBeNull();
    await act(async () => {
      capturedOptions?.onSnapshotBars?.([]);
    });
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Waiting for history",
    );
  });
});

describe("Terminal -- historical candle corrections", () => {
  it("installs one-minute source bars before a snapshot recomputes CVD candles", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    chartHandle.applyRawBars.mockClear();
    chartHandle.applySnapshot.mockClear();
    const sourceBars = [
      {
        type: "bar" as const,
        symbol: "BTC-USDT",
        provider: "BINANCE" as const,
        marketKind: "SPOT" as const,
        interval_ms: 60_000,
        ts_open: 0,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        buy_volume: 6,
        trade_count: 1,
        closed: true,
      },
      {
        type: "bar" as const,
        symbol: "BTC-USDT",
        provider: "BINANCE" as const,
        marketKind: "SPOT" as const,
        interval_ms: 60_000,
        ts_open: 60_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        buy_volume: 7,
        trade_count: 1,
        closed: true,
      },
    ];

    await act(async () => {
      capturedOptions?.onSnapshotBars?.(sourceBars);
    });

    expect(chartHandle.applyRawBars).toHaveBeenCalledWith(sourceBars);
    expect(chartHandle.applySnapshot).toHaveBeenCalledWith(sourceBars);
    expect(chartHandle.applyRawBars.mock.invocationCallOrder[0]).toBeLessThan(
      chartHandle.applySnapshot.mock.invocationCallOrder[0],
    );
  });

  it("updates the resampled bucket containing an out-of-order closed bar instead of incorrectly redrawing only the newest bucket", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    const makeBar = (ts_open: number, close: number) => ({
      type: "bar" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      interval_ms: 60_000,
      ts_open,
      open: 100,
      high: Math.max(100, close),
      low: Math.min(100, close),
      close,
      volume: 1,
      trade_count: 1,
      closed: true,
    });

    await act(async () => {
      capturedOptions?.onSnapshotBars?.([
        makeBar(0, 100),
        makeBar(60_000, 101),
        makeBar(300_000, 102),
      ]);
    });
    chartHandle.applyBar.mockClear();

    await act(async () => {
      capturedOptions?.onBar?.(makeBar(60_000, 103), []);
    });

    expect(chartHandle.applyBar).toHaveBeenCalledWith(
      expect.objectContaining({ ts_open: 60_000, close: 103 }),
      [],
      "LIVE_COMPLETE",
    );
  });

  it("passes the complete selected-timeframe trade set, not only the final one-minute increment", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    const fiveMinute = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-pill"),
    ].find((button) => button.textContent === "5m");
    await act(async () => fiveMinute?.click());
    chartHandle.applyBar.mockClear();

    const makeBar = (ts_open: number) => ({
      type: "bar" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      interval_ms: 60_000,
      ts_open,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      trade_count: 1,
      closed: true,
    });
    const makeTrade = (ts_exchange: number): TradeFrame => ({
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: `trade-${ts_exchange}`,
    });

    for (let index = 0; index < 5; index += 1) {
      const tsOpen = index * 60_000;
      await act(async () => {
        capturedOptions?.onBar?.(
          makeBar(tsOpen),
          [makeTrade(tsOpen)],
          "LIVE_COMPLETE",
        );
      });
    }

    expect(chartHandle.applyBar).toHaveBeenLastCalledWith(
      expect.objectContaining({ ts_open: 0, interval_ms: 300_000 }),
      Array.from({ length: 5 }, (_, index) =>
        expect.objectContaining({ trade_id: `trade-${index * 60_000}` }),
      ),
      "LIVE_COMPLETE",
    );
  });

  it("reaches LIVE_COMPLETE on a display timeframe wider than the old flat 120-bar retention cap (4h needs 240 source bars)", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    const fourHour = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-pill"),
    ].find((button) => button.textContent === "4h");
    expect(fourHour).toBeDefined();
    await act(async () => fourHour?.click());

    const makeBar = (ts_open: number) => ({
      type: "bar" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      interval_ms: 60_000,
      ts_open,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      trade_count: 1,
      closed: true,
    });
    const makeTrade = (ts_exchange: number): TradeFrame => ({
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: `trade-${ts_exchange}`,
    });

    await act(async () => {
      for (let index = 0; index < 240; index += 1) {
        const tsOpen = index * 60_000;
        capturedOptions?.onBar?.(
          makeBar(tsOpen),
          [makeTrade(tsOpen)],
          "LIVE_COMPLETE",
        );
      }
    });

    const lastCall = chartHandle.applyBar.mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ ts_open: 0, interval_ms: 14_400_000 });
    expect(lastCall[2]).toBe("LIVE_COMPLETE");
    expect(lastCall[1]).toHaveLength(240);
  });
});

describe("Terminal -- monotonic developing-candle lifecycle", () => {
  const makeBar = (ts_open: number, closed: boolean, close: number) => ({
    type: "bar" as const,
    symbol: "BTC-USDT",
    provider: "BINANCE" as const,
    marketKind: "SPOT" as const,
    interval_ms: 60_000,
    ts_open,
    open: 100,
    high: Math.max(100, close),
    low: Math.min(100, close),
    close,
    volume: 1,
    trade_count: 1,
    closed,
  });

  it("keeps the current live edge when the prior minute closes late", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () =>
      capturedOptions?.onSnapshotBars?.([makeBar(0, true, 100)]),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(120_000, false, 103), []),
    );
    expect(capturedDomPanelProps?.lastPrice).toBe(103);

    await act(async () =>
      capturedOptions?.onBar?.(makeBar(60_000, true, 102), []),
    );
    expect(capturedDomPanelProps?.lastPrice).toBe(103);
    expect(chartHandle.applyRawBars).toHaveBeenLastCalledWith([
      expect.objectContaining({ ts_open: 0, closed: true }),
      expect.objectContaining({ ts_open: 60_000, closed: true }),
    ]);
  });

  it("rejects a delayed developing update older than the live edge", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () =>
      capturedOptions?.onSnapshotBars?.([makeBar(0, true, 100)]),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(120_000, false, 103), []),
    );
    chartHandle.applyBar.mockClear();

    await act(async () =>
      capturedOptions?.onBar?.(makeBar(60_000, false, 999), []),
    );
    expect(chartHandle.applyBar).not.toHaveBeenCalled();
    expect(capturedDomPanelProps?.lastPrice).toBe(103);
  });

  it("never reopens a candle after its close has been admitted", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () =>
      capturedOptions?.onSnapshotBars?.([makeBar(0, true, 100)]),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(60_000, false, 101), []),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(60_000, true, 102), []),
    );
    chartHandle.applyBar.mockClear();

    await act(async () =>
      capturedOptions?.onBar?.(makeBar(60_000, false, 999), []),
    );
    expect(chartHandle.applyBar).not.toHaveBeenCalled();
    expect(capturedDomPanelProps?.lastPrice).toBe(102);
  });

  it("includes the current developing minute when changing timeframe", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () =>
      capturedOptions?.onSnapshotBars?.([
        makeBar(0, true, 100),
        makeBar(60_000, true, 101),
        makeBar(120_000, true, 102),
        makeBar(180_000, true, 103),
      ]),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(240_000, false, 104), []),
    );
    chartHandle.applySnapshot.mockClear();
    const fiveMinute = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-pill"),
    ].find((button) => button.textContent === "5m");
    expect(fiveMinute).toBeDefined();

    await act(async () => fiveMinute?.click());
    expect(chartHandle.applySnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        ts_open: 0,
        interval_ms: 300_000,
        close: 104,
        closed: false,
      }),
    ]);
  });

  it("removes a formerly developing higher-timeframe candle when a source gap makes that bucket untrustworthy", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () =>
      capturedOptions?.onSnapshotBars?.([
        makeBar(0, true, 100),
        makeBar(60_000, true, 101),
      ]),
    );
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(120_000, false, 102), []),
    );
    const fiveMinute = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-pill"),
    ].find((button) => button.textContent === "5m");
    await act(async () => fiveMinute?.click());
    chartHandle.applySnapshot.mockClear();
    chartHandle.applyBar.mockClear();

    // 180_000 never arrived; the new live edge jumps to 240_000. The
    // aggregate can no longer be represented as a truthful 5m candle.
    await act(async () =>
      capturedOptions?.onBar?.(makeBar(240_000, false, 104), []),
    );
    expect(chartHandle.applyBar).not.toHaveBeenCalled();
    expect(chartHandle.applySnapshot).toHaveBeenCalledWith([]);
  });
});

describe("Terminal -- raw 1-minute bar buffer wiring (whale-marker participation-rate fix)", () => {
  const makeBar = (ts_open: number, closed = true) => ({
    type: "bar" as const,
    symbol: "BTC-USDT",
    provider: "BINANCE" as const,
    marketKind: "SPOT" as const,
    interval_ms: 60_000,
    ts_open,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    trade_count: 1,
    closed,
  });

  it("REGRESSION: a snapshot forwards the closed bars to applyRawBars, not just applySnapshot", async () => {
    await render(baseResult({ status: "open" }));
    const bars = [makeBar(0), makeBar(60_000)];
    await act(async () => {
      capturedOptions?.onSnapshotBars?.(bars);
    });
    expect(chartHandle.applyRawBars).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ ts_open: 0 }),
        expect.objectContaining({ ts_open: 60_000 }),
      ]),
    );
  });

  it("REGRESSION: a newly closed live bar is forwarded to applyRawBars too, keeping it in sync with the closed-bars buffer", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () => {
      capturedOptions?.onSnapshotBars?.([makeBar(0)]);
    });
    chartHandle.applyRawBars.mockClear();

    await act(async () => {
      capturedOptions?.onBar?.(makeBar(60_000), []);
    });
    expect(chartHandle.applyRawBars).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ ts_open: 0 }),
        expect.objectContaining({ ts_open: 60_000 }),
      ]),
    );
  });

  it("a still-forming (not yet closed) live bar does not get forwarded to applyRawBars -- only genuinely closed bars belong in the raw buffer", async () => {
    await render(baseResult({ status: "open" }));
    await act(async () => {
      capturedOptions?.onSnapshotBars?.([makeBar(0)]);
    });
    chartHandle.applyRawBars.mockClear();

    await act(async () => {
      capturedOptions?.onBar?.(makeBar(60_000, false), []);
    });
    expect(chartHandle.applyRawBars).not.toHaveBeenCalled();
  });
});

describe("Terminal -- instrument selector dropdown (DX3.04 AC)", () => {
  function symbolMenuTrigger(): HTMLButtonElement {
    return container.querySelector(".symbol-menu-trigger") as HTMLButtonElement;
  }

  async function openSymbolMenu() {
    await act(async () => {
      symbolMenuTrigger().click();
    });
  }

  function symbolOption(label: string): HTMLButtonElement {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((b) => b.textContent === label)!;
  }

  async function selectInstrument(label: string) {
    await openSymbolMenu();
    await act(async () => {
      symbolOption(label).click();
    });
  }

  it("defaults to BTC Spot highlighted before any selection frame has confirmed anything", async () => {
    await render(baseResult({ activeSelection: null }));
    expect(symbolMenuTrigger().textContent).toContain("BTC Spot");
  });

  it("selecting an instrument calls selectPair with its symbol and identity, and resets the chart to the waiting overlay", async () => {
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
        selectPair,
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".chart-overlay")).toBeNull();

    await selectInstrument("ETH Spot");

    expect(selectPair).toHaveBeenCalledWith("ETH-USDT", {
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Waiting for history",
    );
  });

  it("selecting a different market kind for the same symbol sends the full identity in a single choice", async () => {
    const selectPair = vi.fn();
    await render(baseResult({ status: "open", selectPair }));

    await selectInstrument("BTC Perp");

    expect(selectPair).toHaveBeenCalledWith("BTC-USDT", {
      provider: "BINANCE",
      marketKind: "PERPETUAL",
    });
  });

  it("selecting a dxFeed instrument sends its assetClass identity, not a marketKind", async () => {
    const selectPair = vi.fn();
    await render(baseResult({ status: "open", selectPair }));

    await selectInstrument("NQ");

    expect(selectPair).toHaveBeenCalledWith("/NQZ26:XCME", {
      provider: "DXFEED",
      assetClass: "FUTURE",
    });
  });

  it("selecting the already-active instrument is a no-op -- no selectPair call, no chart reset", async () => {
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
        selectPair,
      }),
    );
    await seedLatestBar();

    await selectInstrument("BTC Spot");

    expect(selectPair).not.toHaveBeenCalled();
    expect(container.querySelector(".chart-overlay")).toBeNull();
  });

  it("the selector trigger is disabled while the connection isn't open", async () => {
    await render(baseResult({ status: "connecting" }));
    expect(symbolMenuTrigger().disabled).toBe(true);
  });

  it("locks the selector after a request until the server confirms it, preventing client-side selection storms", async () => {
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );

    await selectInstrument("ETH Spot");

    expect(selectPair).toHaveBeenCalledTimes(1);
    expect(symbolMenuTrigger().disabled).toBe(true);
  });

  it("keeps the selector locked through a timeout rollback until the server confirms the restored pair", async () => {
    vi.useFakeTimers();
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );

    await selectInstrument("ETH Spot");
    expect(symbolMenuTrigger().disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(symbolMenuTrigger().disabled).toBe(true);
    expect(symbolMenuTrigger().textContent).toContain("BTC Spot");
    expect(selectPair).toHaveBeenLastCalledWith("BTC-USDT", {
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    expect(selectPair).toHaveBeenCalledTimes(2);

    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );
    expect(symbolMenuTrigger().disabled).toBe(false);
  });

  it("unlocks for an explicit forced retry if even the rollback acknowledgement never arrives", async () => {
    vi.useFakeTimers();
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );

    await selectInstrument("ETH Spot");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(symbolMenuTrigger().disabled).toBe(false);

    await selectInstrument("BTC Spot");
    expect(selectPair).toHaveBeenLastCalledWith(
      "BTC-USDT",
      { provider: "BINANCE", marketKind: "SPOT" },
      true,
    );
  });

  it("allows an explicit retry after a request times out before any server selection has ever been confirmed", async () => {
    vi.useFakeTimers();
    const selectPair = vi.fn();
    await render(
      baseResult({ status: "open", activeSelection: null, selectPair }),
    );

    await selectInstrument("ETH Spot");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await selectInstrument("ETH Spot");

    expect(selectPair).toHaveBeenNthCalledWith(1, "ETH-USDT", {
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    expect(selectPair).toHaveBeenNthCalledWith(
      2,
      "ETH-USDT",
      { provider: "BINANCE", marketKind: "SPOT" },
      true,
    );
  });

  it("a confirmation that arrives before the timeout cancels it -- no stale revert happens later", async () => {
    vi.useFakeTimers();
    const selectPair = vi.fn();
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );

    await selectInstrument("ETH Spot");
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        selectPair,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(symbolMenuTrigger().textContent).toContain("ETH Spot");
    expect(selectPair).toHaveBeenCalledTimes(1);
  });

  it("reselecting an unavailable dxFeed instrument explicitly restarts that same session", async () => {
    const selectPair = vi.fn();
    const nq = {
      symbol: "/NQZ26:XCME",
      provider: "DXFEED" as const,
      assetClass: "FUTURE" as const,
    };
    await render(
      baseResult({
        status: "open",
        feedHealth: {
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "DXFEED_SESSION_ENDED",
        },
        activeSelection: nq,
        selectPair,
      }),
    );

    await selectInstrument("NQ");

    expect(selectPair).toHaveBeenCalledWith(
      nq.symbol,
      { provider: "DXFEED", assetClass: "FUTURE" },
      true,
    );
    expect(symbolMenuTrigger().disabled).toBe(true);
  });

  it("selecting a dxFeed instrument keeps the chart and book in warm-up until canonical frames arrive", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );
    await seedLatestBar();
    expect(container.querySelector(".chart-overlay")).toBeNull();

    await selectInstrument("NQ");

    expect(container.querySelector(".chart-overlay")?.textContent).toContain(
      "Waiting for history",
    );
    expect(capturedDomPanelProps?.book).toBeNull();
  });

  it("passes a real dxFeed book through instead of hard-disabling every dxFeed DOM", async () => {
    const dxfeedBook = {
      type: "book" as const,
      symbol: "/NQU26:XCME",
      provider: "DXFEED" as const,
      assetClass: "FUTURE" as const,
      status: "READY" as const,
      bids: [{ price: 29139.75, size: 7 }],
      asks: [{ price: 29140, size: 3 }],
      lastUpdateId: 1,
      stale: false,
    };
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
        activeSelection: {
          symbol: "/NQU26:XCME",
          provider: "DXFEED",
          assetClass: "FUTURE",
        },
        book: dxfeedBook,
      }),
    );
    expect(capturedDomPanelProps?.book).toEqual(dxfeedBook);
  });

  it("arrow keys move focus between options, Home/End jump to the ends, and Escape closes the menu and refocuses the trigger", async () => {
    await render(baseResult({ status: "open" }));
    await openSymbolMenu();

    expect(document.activeElement).toBe(symbolOption("BTC Spot"));

    await act(async () => {
      symbolOption("BTC Spot").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("BTC Perp");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("NVDA");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("BTC Spot");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector(".symbol-menu-popover")).toBeNull();
    expect(document.activeElement).toBe(symbolMenuTrigger());
  });

  it("switching pairs does not flash based on the old pair's stale price -- an asset-scale jump is not a real price move", async () => {
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 1,
            price: 64000,
            size: 1,
            side: "buy",
            trade_id: "1",
          },
        ],
      }),
    );
    expect(container.querySelector(".px")?.className).not.toContain("flash");

    await selectInstrument("ETH Spot");

    // The new pair's first real trade arriving with a wildly different
    // price (ETH ~3000 vs BTC ~64000) -- same shape of update a real
    // useMarketData reaction to the switch would cause.
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "ETH-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 3000,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );

    expect(container.querySelector(".px")?.textContent).toBe("3000.00");
    expect(container.querySelector(".px")?.className).not.toContain("flash");
  });

  it("cancels an already-active price flash when a pair switch starts so it cannot color the new pair's first tick", async () => {
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 1,
            price: 100,
            size: 1,
            side: "buy",
            trade_id: "1",
          },
        ],
      }),
    );
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 105,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );
    expect(container.querySelector(".px")?.className).toContain("flash-up");

    await selectInstrument("ETH Spot");
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "ETH-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 3,
            price: 3000,
            size: 1,
            side: "buy",
            trade_id: "3",
          },
        ],
      }),
    );

    expect(container.querySelector(".px")?.className).not.toContain("flash");
    expect(capturedDomPanelProps?.lastTickDirection).toBeNull();
  });

  it("passes the current price to DomPanel as lastPrice, and flags direction on the second tick (there's nothing to compare the first one against)", async () => {
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 1,
            price: 100,
            size: 1,
            side: "buy",
            trade_id: "1",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastPrice).toBe(100);
    expect(capturedDomPanelProps?.lastTickDirection).toBeNull();

    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 105,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastPrice).toBe(105);
    expect(capturedDomPanelProps?.lastTickDirection).toBe("up");

    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 3,
            price: 95,
            size: 1,
            side: "buy",
            trade_id: "3",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastTickDirection).toBe("down");
  });

  it("a tick direction persists across re-renders (unlike the topbar's own 420ms flash) until the next real tick", async () => {
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 1,
            price: 100,
            size: 1,
            side: "buy",
            trade_id: "1",
          },
        ],
      }),
    );
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 105,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastTickDirection).toBe("up");

    // Re-render with the exact same last trade (no new tick) -- a real
    // rAF flush with nothing new to report looks like this.
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 105,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastTickDirection).toBe("up");
  });

  it("switching pairs resets the tick direction -- the old pair's up/down is not a meaningful signal for the new one", async () => {
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 1,
            price: 100,
            size: 1,
            side: "buy",
            trade_id: "1",
          },
        ],
      }),
    );
    await render(
      baseResult({
        status: "open",
        trades: [
          {
            type: "trade",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            ts_exchange: 2,
            price: 105,
            size: 1,
            side: "buy",
            trade_id: "2",
          },
        ],
      }),
    );
    expect(capturedDomPanelProps?.lastTickDirection).toBe("up");

    await selectInstrument("ETH Spot");

    expect(capturedDomPanelProps?.lastTickDirection).toBeNull();
  });

  it("highlights whatever the server confirms via activeSelection, not just the last local click", async () => {
    await render(
      baseResult({
        status: "open",
        activeSelection: {
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "PERPETUAL",
        },
      }),
    );
    expect(symbolMenuTrigger().textContent).toContain("ETH Perp");
  });
});

describe("Terminal -- panel rail scaffolding (P3.04 AC)", () => {
  function railTabs(): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('.rail [role="tab"]'),
    );
  }

  function tabPanel(id: string): HTMLElement | null {
    return container.querySelector(`#panel-content-${id}`);
  }

  it("the rail is a real tablist: role, orientation, and one tab per supported mode", async () => {
    await render(baseResult());
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-orientation")).toBe("vertical");
    expect(tablist?.getAttribute("aria-label")).toBe("Panels");
    expect(railTabs()).toHaveLength(3);
    // The flex spacer is a sibling of the tablist, not a child -- a
    // non-tab node inside role=tablist is a real APG violation.
    expect(tablist?.querySelector(".rail-gap")).toBeNull();
    expect(container.querySelector(".rail > .rail-gap")).not.toBeNull();
  });

  it("live mode is active and visible by default; the other two are real tabpanels, hidden not absent", async () => {
    await render(baseResult());
    const tabs = railTabs();
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-current")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    for (const tab of tabs.slice(1)) {
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.getAttribute("aria-current")).toBeNull();
      expect(tab.tabIndex).toBe(-1);
    }
    expect(tabPanel("chart")?.hasAttribute("hidden")).toBe(false);
    expect(tabPanel("historical")?.hasAttribute("hidden")).toBe(true);
    // The tabpanel exists, but its archive workspace must not run while inactive.
    expect(tabPanel("historical")?.textContent).toBe("");
    expect(container.querySelector(".historical-instrument")).toBeNull();
    expect(tabPanel("chart")?.getAttribute("tabindex")).toBeNull();
  });

  it("unmounts the historical workspace on exit and creates it again on re-entry", async () => {
    await render(baseResult());
    await act(async () => railTabs()[1].click());
    expect(container.querySelector(".historical-instrument")).not.toBeNull();
    await act(async () => railTabs()[0].click());
    expect(tabPanel("historical")?.textContent).toBe("");
    expect(container.querySelector(".historical-instrument")).toBeNull();
    await act(async () => railTabs()[1].click());
    expect(container.querySelector(".historical-instrument")).not.toBeNull();
  });

  it("clicking a rail tab switches the visible tabpanel and updates aria-selected/tabIndex", async () => {
    await render(baseResult());
    const tabs = railTabs();

    await act(async () => {
      tabs[2].click();
    });

    expect(tabPanel("chart")?.hasAttribute("hidden")).toBe(true);
    expect(tabPanel("heatmap")?.hasAttribute("hidden")).toBe(false);
    expect(tabPanel("heatmap")?.textContent).toContain("Liquidity heatmap");
    expect(tabPanel("heatmap")?.getAttribute("tabindex")).toBe("0");
    expect(tabPanel("chart")?.getAttribute("tabindex")).toBeNull();
    const refreshedTabs = railTabs();
    expect(refreshedTabs[2].getAttribute("aria-selected")).toBe("true");
    expect(refreshedTabs[2].getAttribute("aria-current")).toBe("true");
    expect(refreshedTabs[2].tabIndex).toBe(0);
    expect(refreshedTabs[0].getAttribute("aria-selected")).toBe("false");
    expect(refreshedTabs[0].getAttribute("aria-current")).toBeNull();
    expect(refreshedTabs[0].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(refreshedTabs[2]);
  });

  it("historical mode uses its own archive workspace and does not present live feed state as archive data", async () => {
    await render(
      baseResult({
        status: "open",
        feedHealth: { recoveryState: "READY", stale: false },
      }),
    );

    await act(async () => {
      railTabs()[1].click();
    });

    expect(container.querySelector(".shell")?.className).toContain(
      "historical-active",
    );
    expect(tabPanel("historical")?.hasAttribute("hidden")).toBe(false);
    expect(tabPanel("historical")?.textContent).toContain(
      "Historical Mode needs host data access",
    );
    expect(container.querySelector(".topbar")?.textContent).toContain(
      "Historical mode",
    );
    expect(container.querySelector(".statusbar")?.textContent).toContain(
      "archive query workspace",
    );
    expect(container.querySelector(".statusbar")?.textContent).not.toContain(
      "ws open",
    );
  });

  it("historical instrument selection is grouped by asset class and stays local to the archive workspace", async () => {
    const result = baseResult();
    await render(result);
    await act(async () => {
      railTabs()[1].click();
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click();
    });

    const picker = container.querySelector(".historical-symbol-picker")!;
    expect(
      Array.from(picker.querySelectorAll(".historical-symbol-group h2")).map(
        (title) => title.textContent,
      ),
    ).toEqual(["Crypto", "Futures", "Equities"]);
    expect(picker.textContent).toContain("ES Continuous");
    expect(picker.textContent).toContain("NQ Continuous");
    expect(picker.textContent).not.toContain("Roll join pending");

    const btcSpot = Array.from(
      picker.querySelectorAll<HTMLButtonElement>(".historical-symbol-option"),
    ).find((option) => option.textContent?.includes("BTC Spot"))!;
    await act(async () => {
      btcSpot.click();
    });

    expect(
      container.querySelector(".historical-instrument")?.textContent,
    ).toContain("BTC Spot");
    expect(tabPanel("historical")?.textContent).toContain(
      "Host data access is not configured",
    );
    expect(result.selectPair).not.toHaveBeenCalled();
  });

  it("historical indicators are divided by provenance and explain why an unloaded archive cannot activate one", async () => {
    await render(baseResult());
    await act(async () => {
      railTabs()[1].click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click();
    });

    const dialog = container.querySelector(".historical-indicator-dialog")!;
    expect(
      Array.from(
        dialog.querySelectorAll(".historical-indicator-section h2"),
      ).map((title) => title.textContent),
    ).toEqual([
      "Basic · OHLCV",
      "Orderflow · L1",
      "Orderbook · L2",
    ]);

    const rsiFavorite = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Add RSI (14) to favorites"]',
    )!;
    await act(async () => {
      rsiFavorite.click();
      Array.from(
        dialog.querySelectorAll<HTMLButtonElement>(
          ".historical-indicator-filters button",
        ),
      )
        .find((button) => button.textContent?.includes("Favorites"))!
        .click();
    });

    expect(
      dialog.querySelector(".historical-indicator-section h2")?.textContent,
    ).toBe("Favorites");
    expect(dialog.textContent).toContain("RSI (14)");
    expect(dialog.textContent).toContain(
      "Requires ohlcv from every candle in the selected range.",
    );
  });

  it("the chart+tape+DOM experience is unchanged when the chart tab is active -- existing chip/overlay markup still renders inside it", async () => {
    await render(baseResult({ status: "connecting" }));
    expect(
      tabPanel("chart")?.querySelector(".chart-overlay")?.textContent,
    ).toContain("Connecting to feed");
    expect(container.querySelector(".status-chip")?.textContent).toContain(
      "CONNECTING",
    );
  });

  it("ArrowDown moves both focus and selection to the next tab, wrapping past the last one back to the first", async () => {
    await render(baseResult());
    const tabs = railTabs();
    tabs[0].focus();

    await act(async () => {
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(railTabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[1]);

    // Walk the rest of the way around: 1 -> 2 -> wraps to 0.
    for (let i = 0; i < 2; i += 1) {
      const current = railTabs().find(
        (t) => t.getAttribute("aria-selected") === "true",
      )!;
      await act(async () => {
        current.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });
    }
    expect(railTabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[0]);
  });

  it("ArrowUp from the first tab wraps to the last", async () => {
    await render(baseResult());
    const tabs = railTabs();
    tabs[0].focus();

    await act(async () => {
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });

    expect(railTabs()[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[2]);
  });

  it("ArrowRight and ArrowLeft follow the same wrap as Down and Up on a vertical tablist", async () => {
    await render(baseResult());
    const tabs = railTabs();
    tabs[0].focus();

    await act(async () => {
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(railTabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[1]);

    await act(async () => {
      railTabs()[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(railTabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[0]);
  });

  it("Home and End jump to the first and last tab directly", async () => {
    await render(baseResult());
    const tabs = railTabs();
    tabs[1].focus();

    await act(async () => {
      tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(railTabs()[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[2]);

    await act(async () => {
      railTabs()[2].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(railTabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(railTabs()[0]);
  });

  it("an unrelated keypress on a rail tab does nothing", async () => {
    await render(baseResult());
    const tabs = railTabs();
    tabs[0].focus();

    await act(async () => {
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    expect(railTabs()[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("Terminal -- the Aggressive Orders Profile print store", () => {
  it("hands the hook's print store and its ask through to the chart and the panel while the indicator is on", async () => {
    const store = new RangePrintStore();
    const askRangePrints = vi.fn();
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 3 }],
    });
    localStorage.setItem("terminal.indicators.favorites", JSON.stringify(["aggressiveOrdersProfile"]));
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: 0, toMs: 60_000 });
    try {
      chartHandle.applyAggressiveProfilePrints.mockClear();
      await render(baseResult({ rangePrints: store, askRangePrints, liquidity }));
      expect(chartHandle.applyAggressiveProfilePrints).toHaveBeenLastCalledWith(store);
      expect(store.floor).toBe(2);
      expect(askRangePrints).toHaveBeenCalled();
    } finally {
      localStorage.removeItem("terminal.indicators.favorites");
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });
});
