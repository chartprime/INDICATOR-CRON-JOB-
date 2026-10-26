// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useMemo, useRef } from "react";
import {
  createTimeCoveredMarkerRetentionBuffer,
  type MarkerSelectionView,
} from "../../../lib/chart/markerRetention";
import type {
  BarFrame,
  BarHistory,
  BookFrame,
  FrameIdentity,
  LiquidityFrame,
  MarkerFrame,
  ProfileFrame,
  VpinReading,
} from "../../../types/frames";
import { parseServerFrame } from "../../../types/frames";
import { LiquidityGrid } from "../../../lib/indicators/passive-liquidity/liquidityGrid";
import type { ColumnHistoryStream } from "../../../lib/indicators/passive-liquidity/columnHistoryStream";
import type { WallHistoryStream } from "../../../lib/l2/wallHistoryStream";
import { L2Store, type L2Frame } from "../../../lib/l2/l2Store";
import { DEFAULT_VOLUME_PROFILE_PERIOD_MS } from "../../../lib/indicators/volume-profile/profileSessionConfig";
import {
  BAND_PENDING_MS,
  BAND_RETRY_MS,
  BandHistoryStore,
  type BandHistoryRequest,
} from "../../../lib/chart/bandHistory";
import { DELTA_ASK_DELAY_MS, DELTA_REQUEST_ID_STRIDE, DeltaProfileStore, type DeltaProfileRequest } from "../../../lib/indicators/live-delta-profile/deltaProfileStore";
import { RANGE_ASK_DELAY_MS, RANGE_GIVE_UP_MS, RANGE_POLL_MS, RANGE_WARM_MS, RangePrintStore } from "../../../lib/indicators/aggressive-orders-profile/rangePrintStore";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS } from "../../../lib/indicators/live-delta-profile/liveDeltaProfileSettings";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS } from "../../../lib/indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floorPosition, floorScaleFor, floorStops } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { START_FLOOR_WAIT_MS } from "../../../lib/indicators/aggressive-orders-profile/aggressiveProfileReader";
import { BookProfileSource } from "../../../lib/indicators/live-order-book-profile/bookProfileSource";
import {
  AggressiveTape,
  HISTORY_ASK_MAX_MS,
} from "../../../lib/indicators/aggressive-orders/aggressiveTape";
import { HISTORY_MIN_MS } from "../../../lib/indicators/aggressive-orders/columnPrints";
import { instrumentKey } from "../../../lib/chart/drawingStore";
import { liquidityStyleFor } from "../../../lib/indicators/passive-liquidity/liquidityStyle";
import { DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS } from "../../../lib/indicators/l2-support-resistance/l2SupportResistancePrimitive";
import { DEFAULT_L2_BOOK_MAP_SETTINGS } from "../../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../../lib/indicators/passive-liquidity/liquiditySettings";
import { DEFAULT_AGGRESSIVE_ORDERS_SETTINGS } from "../../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import { DEFAULT_ABSORPTION_SETTINGS, absorptionRulesFor, type AbsorptionRules } from "../../../lib/indicators/absorption-detector/absorptionSettings";
import { ExhaustionBook } from "../../../lib/l2/exhaustionBook";
import { InitiativeBook } from "../../../lib/l2/initiativeBook";
import type { CandleMonitorFrame } from "../../../types/frames";
import type { CandleMonitorArrival } from "../../../lib/indicators/candle-monitor/candleMonitorText";
import { DEFAULT_EXHAUSTION_SETTINGS } from "../../../lib/indicators/exhaustion/exhaustionSettings";
import { DEFAULT_INITIATIVE_SETTINGS } from "../../../lib/indicators/initiative/initiativeSettings";
import { DEFAULT_LIVE_RANGE_SETTINGS } from "../../../lib/indicators/live-range-control/liveRangeSettings";
import { WHOLE_WINDOW as WHOLE_LIVE_RANGE_WINDOW, WINDOW_STORAGE_KEY as LIVE_RANGE_WINDOW_STORAGE_KEY } from "../../../lib/indicators/live-range-control/liveRangeWindow";
import type { InitiativeBand } from "../../../types/frames";
import { LIVE_INDICATOR_EXTRAS_STORAGE_KEY } from "../../../lib/chart/liveIndicatorExtras";
import { INDICATOR_PRESETS_STORAGE_KEY, indicatorPresets } from "../../../lib/chart/indicatorPresets";

type InstrumentIdentity = { symbol: string } & FrameIdentity;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The one indicator's user-visible label, which its tests match on. */
const SESSION_PROFILE_LABEL =
  "Session Volume Profile (Volume / Net Delta / Delta)";

const { chartHandle } = vi.hoisted(() => ({
  chartHandle: {
    applySnapshot: vi.fn(),
    applyBar: vi.fn(),
    applyRawBars: vi.fn(),
    setIndicators: vi.fn(),
    setIndicatorVisibility: vi.fn(),
    setIndicatorSettings: vi.fn(),
    setKillzoneSessions: vi.fn(),
    applyMarkerSnapshot: vi.fn(),
    setDivergenceSettings: vi.fn(),
    setOrderFlowDisplayMode: vi.fn(),
    setActiveDrawingTool: vi.fn(),
    applyProfileFrame: vi.fn(),
    applyHistoricalProfiles: vi.fn(),
    applyVpinReadings: vi.fn(),
    setSessionProfileSettings: vi.fn(),
    setSessionDeltaProfileSettings: vi.fn(),
    setVpinCloudSettings: vi.fn(),
    applyLiquidity: vi.fn(),
    applyL2: vi.fn(),
    refreshL2: vi.fn(),
    applyBandHistory: vi.fn(),
    bandHistoryWants: vi.fn(
      () =>
        [] as {
          key: string;
          fromTs: number;
          toTs: number;
          priceLo: number;
          priceHi: number;
          columnMs: number;
        }[],
    ),
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
    applyTicks: vi.fn(),
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
    setLiveRangeWindow: vi.fn(),
    applyIcebergs: vi.fn(),
    refreshIcebergs: vi.fn(),
    setIcebergSettings: vi.fn(),
    getVisibleRangeMs: vi.fn((): { fromMs: number; toMs: number } | null => null),
    subscribeVisibleRangeChange: vi.fn(
      (_cb: (fromMs: number, toMs: number) => void) => () => {},
    ),
  },
}));

let capturedChartPanelProps: {
  onFixedRangeProfileRequested?: (
    rangeStartTs: number,
    rangeEndTs: number,
  ) => void;
  onLiquidityLaneDrawn?: (lane: number) => void;
  onLiquidityHistoryDrawn?: (info: { levelMs: number; rowFactor: number; days: 1 | 3 | 5 | 7; loading: boolean; reachTs: number | null; drawn: boolean; refused: "GEOMETRY" | null; unavailable: string | null } | null) => void;
  onLiveRangeWindowChange?: (window: { fromMs: number | null; toMs: number | null }) => void;
} = {};

vi.mock("../ChartPanel", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    ChartPanel: forwardRef(function MockChartPanel(
      props: {
        onFixedRangeProfileRequested?: (
          rangeStartTs: number,
          rangeEndTs: number,
        ) => void;
        onLiquidityLaneDrawn?: (lane: number) => void;
        onLiquidityHistoryDrawn?: (info: { levelMs: number; rowFactor: number; days: 1 | 3 | 5 | 7; loading: boolean; reachTs: number | null; drawn: boolean; refused: "GEOMETRY" | null; unavailable: string | null } | null) => void;
        onLiveRangeWindowChange?: (window: { fromMs: number | null; toMs: number | null }) => void;
      },
      ref,
    ) {
      capturedChartPanelProps = props;
      useImperativeHandle(ref, () => chartHandle);
      return null;
    }),
  };
});

const { MainPanel } = await import("../MainPanel");

beforeEach(() => {
  localStorage.removeItem("terminal.live-indicators.preferences.v1");
  localStorage.removeItem("terminal.live-indicators.extras.v1");
});

const sendProfileConfigMock = vi.fn();
const sendProfileHistoryMock = vi.fn();

// price fixed at 1 so size doubles as an exact notionalUsd for test control.
function makeMarker(
  notionalUsd: number,
  tradeId = `t-${notionalUsd}`,
  tsExchange = Date.now(),
): MarkerFrame {
  return {
    type: "marker",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: tsExchange,
    price: 1,
    size: notionalUsd,
    side: "buy",
    trade_id: tradeId,
  };
}

// A thin smoke test only -- the real behavioral coverage (status chip,
// chart overlay, degraded states) already lives in Terminal.test.tsx
// and stays there unmodified; this just proves the extracted component
// renders without throwing given the same prop shape Terminal passes.
function retainAsView(markers: readonly MarkerFrame[]): MarkerSelectionView {
  const buffer = createTimeCoveredMarkerRetentionBuffer(100_000);
  buffer.insertAll(markers);
  return buffer;
}

function Harness({
  intervalMs = 60_000,
  markers = [] as MarkerFrame[],
  tapeTradeCount = 1_000,
  instrumentIdentity = {
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
  } as InstrumentIdentity,
  book = null as BookFrame | null,
  barHistory = null as BarHistory | null,
  status = "open" as "connecting" | "open" | "closed",
  historicalProfiles = [] as ProfileFrame[],
  vpinHistory = [] as VpinReading[],
  vpinStatus = null,
  liquidity = null as LiquidityGrid | null,
  columnHistory = null as ColumnHistoryStream | null,
  hostWalls = null as WallHistoryStream | null,
  whaleWalls = null as WallHistoryStream | null,
  l2 = null as L2Store | null,
  aggressiveTape = null as AggressiveTape | null,
  exhaustions = null as ExhaustionBook | null,
  initiatives = null as InitiativeBook | null,
  candleMonitor = null as CandleMonitorArrival | null,
  requestExhaustionHistory = undefined as ((fromTs: number) => void) | undefined,
  requestInitiativeHistory = undefined as ((fromTs: number) => void) | undefined,
  requestAggressiveHistory = undefined as
    | ((request: {
        request_id: number;
        from_ts: number;
        to_ts: number;
        min_size: number;
      }) => void)
    | undefined,
  bandHistory = null as BandHistoryStore | null,
  bandHistoryVersion = 0,
  requestBandHistory = undefined as
    | ((request: BandHistoryRequest) => void)
    | undefined,
  deltaProfile = null as DeltaProfileStore | null,
  deltaProfileVersion = 0,
  deltaTickProfile = null as DeltaProfileStore | null,
  deltaTickProfileVersion = 0,
  requestDeltaProfile = undefined as ((request: DeltaProfileRequest) => void) | undefined,
  rangePrints = null as RangePrintStore | null,
  askRangePrints = undefined as (() => void) | undefined,
  latestBar = null as BarFrame | null,
}: {
  intervalMs?: number;
  markers?: MarkerFrame[];
  tapeTradeCount?: number;
  instrumentIdentity?: InstrumentIdentity;
  book?: BookFrame | null;
  barHistory?: BarHistory | null;
  status?: "connecting" | "open" | "closed";
  historicalProfiles?: ProfileFrame[];
  vpinHistory?: VpinReading[];
  vpinStatus?: "IDLE" | "WARMING" | "READY" | "UNAVAILABLE" | null;
  liquidity?: LiquidityGrid | null;
  columnHistory?: ColumnHistoryStream | null;
  hostWalls?: WallHistoryStream | null;
  whaleWalls?: WallHistoryStream | null;
  l2?: L2Store | null;
  aggressiveTape?: AggressiveTape | null;
  exhaustions?: ExhaustionBook | null;
  initiatives?: InitiativeBook | null;
  candleMonitor?: CandleMonitorArrival | null;
  requestExhaustionHistory?: (fromTs: number) => void;
  requestInitiativeHistory?: (fromTs: number) => void;
  requestAggressiveHistory?: (request: {
    request_id: number;
    from_ts: number;
    to_ts: number;
    min_size: number;
  }) => void;
  bandHistory?: BandHistoryStore | null;
  bandHistoryVersion?: number;
  requestBandHistory?: (request: BandHistoryRequest) => void;
  deltaProfile?: DeltaProfileStore | null;
  deltaProfileVersion?: number;
  deltaTickProfile?: DeltaProfileStore | null;
  deltaTickProfileVersion?: number;
  requestDeltaProfile?: (request: DeltaProfileRequest) => void;
  rangePrints?: RangePrintStore | null;
  askRangePrints?: () => void;
  latestBar?: BarFrame | null;
}) {
  const chartRef = useRef(null);
  const markerView = useMemo(() => retainAsView(markers), [markers]);
  return (
    <MainPanel
      chartRef={chartRef}
      intervalMs={intervalMs}
      onTimeframeSelect={() => {}}
      displayBar={null}
      up={true}
      status={status}
      backendDegraded={false}
      latestBar={latestBar}
      feedHealth={null}
      feedStale={false}
      barHistory={barHistory}
      book={book}
      profile={null}
      historicalProfiles={historicalProfiles}
      aggressiveTape={aggressiveTape}
      exhaustions={exhaustions}
      initiatives={initiatives}
      candleMonitor={candleMonitor}
      requestExhaustionHistory={requestExhaustionHistory}
      requestInitiativeHistory={requestInitiativeHistory}
      requestAggressiveHistory={requestAggressiveHistory}
      bandHistory={bandHistory}
      bandHistoryVersion={bandHistoryVersion}
      requestBandHistory={requestBandHistory}
      deltaProfile={deltaProfile}
      deltaProfileVersion={deltaProfileVersion}
      deltaTickProfile={deltaTickProfile}
      deltaTickProfileVersion={deltaTickProfileVersion}
      requestDeltaProfile={requestDeltaProfile}
      rangePrints={rangePrints}
      askRangePrints={askRangePrints}
      vpinHistory={vpinHistory}
      vpinStatus={vpinStatus}
      liquidity={liquidity}
      columnHistory={columnHistory}
      hostWalls={hostWalls}
      whaleWalls={whaleWalls}
      l2={l2}
      sendProfileConfig={sendProfileConfigMock}
      sendProfileHistory={sendProfileHistoryMock}
      requestLiquidityResync={vi.fn()}
      trades={[]}
      markerView={markerView}
      markersVersion={markerView.version}
      tapeTradeCount={tapeTradeCount}
      lastPrice={undefined}
      lastTickDirection={null}
      instrumentIdentity={instrumentIdentity}
    />
  );
}

async function openIndicatorsMenu(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".indicators-trigger")!.click();
  });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>(".indicators-dialog-nav button")]
      .find((button) => button.textContent === "All indicators")!.click();
  });
}

function clickLargeTradeDetectorToggle(
  container: HTMLDivElement,
): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
  ).find(
    (r) =>
      r.querySelector(".indicators-row-label")?.textContent ===
      "Large Trade Detector",
  )!;
  row.click();
  return row;
}

function clickIndicatorToggle(
  container: HTMLDivElement,
  label: string,
): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
  ).find(
    (r) => r.querySelector(".indicators-row-label")?.textContent === label,
  )!;
  row.click();
  return row;
}

function clickDeltaDivergenceToggle(
  container: HTMLDivElement,
): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
  ).find(
    (r) =>
      r.querySelector(".indicators-row-label")?.textContent ===
      "Delta Divergence",
  )!;
  row.click();
  return row;
}

function clickSessionProfileToggle(
  container: HTMLDivElement,
): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
  ).find(
    (r) =>
      r.querySelector(".indicators-row-label")?.textContent ===
      SESSION_PROFILE_LABEL,
  )!;
  row.click();
  return row;
}

function clickVpinCloudToggle(container: HTMLDivElement): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
  ).find(
    (r) =>
      r.querySelector(".indicators-row-label")?.textContent === "VPIN Cloud",
  )!;
  row.click();
  return row;
}

function legendIcon(
  container: HTMLDivElement,
  label: string,
): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    `.indicator-legend-icon[aria-label="${label}"]`,
  )!;
}

function setThresholdInput(container: HTMLDivElement, value: string): void {
  const input = container.querySelector<HTMLInputElement>(
    '.indicator-settings-field input[type="number"]',
  )!;
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function switchToSizeMode(container: HTMLDivElement): void {
  const radios = Array.from(
    container.querySelectorAll<HTMLInputElement>(
      'input[name="whale-detection-mode"]',
    ),
  );
  radios
    .find((radio) => radio.nextElementSibling?.textContent?.includes("Size"))!
    .click();
}

describe("MainPanel", () => {
  it("closes the dock from inside it, back to the toolbar toggle, and starts closed where it would lie over the chart (PR #33 review)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const toggle = container.querySelector<HTMLButtonElement>(".side-toggle")!;
    expect(toggle.closest(".chart-toolbar-end")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => container.querySelector<HTMLButtonElement>(".side-panel-close")!.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#terminal-right-dock")?.classList.contains("side-panels-closed")).toBe(true);
    expect(document.activeElement).toBe(toggle);
    await act(async () => root.unmount());
    const original = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    const narrowMatch = (query: string) => ({ matches: query === "(max-width: 650px)", media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: narrowMatch });
    try {
      const narrow = createRoot(container);
      await act(async () => narrow.render(<Harness />));
      expect(container.querySelector(".side-toggle")?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => narrow.unmount());
    } finally {
      if (original) Object.defineProperty(globalThis, "matchMedia", original);
      container.remove();
    }
  });
  it("switches the right dock with keyboard arrows and can restore it after collapse", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const market = container.querySelector<HTMLButtonElement>("#right-tab-market")!;
    await act(async () => market.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector("#right-tab-watchlist")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#right-panel-market")?.hasAttribute("hidden")).toBe(true);
    const toggle = container.querySelector<HTMLButtonElement>(".side-toggle")!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#right-panel-watchlist")?.hasAttribute("hidden")).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });
  it("renders without throwing given a real prop shape", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await expect(
      act(async () => {
        root.render(<Harness />);
      }),
    ).resolves.not.toThrow();

    expect(container.querySelector(".chart-area")).not.toBeNull();
    expect(container.querySelector(".side-panels")).not.toBeNull();
  });

  it("makes partial historical coverage visible instead of presenting it as a complete chart window", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Harness
          barHistory={{
            availability: "AVAILABLE",
            requestedStartTsOpen: 0,
            earliestObservedTsOpen: 60_000,
            coverage: "START_NOT_COVERED",
            interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
          }}
        />,
      );
    });

    expect(container.querySelector(".history-warning")?.textContent).toContain(
      "HISTORY PARTIAL",
    );
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses an explicit canonical UNAVAILABLE book frame instead of inferring capability from the provider", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Harness
          book={{
            type: "book",
            symbol: "AAPL",
            provider: "DXFEED",
            assetClass: "EQUITY",
            status: "UNAVAILABLE",
            reason: "UPSTREAM_EVENT_UNAVAILABLE",
          }}
          instrumentIdentity={{
            symbol: "AAPL",
            provider: "DXFEED",
            assetClass: "EQUITY",
          }}
        />,
      );
    });
    expect(container.querySelector(".dom-empty")?.textContent).toBe(
      "Book unavailable (UPSTREAM_EVENT_UNAVAILABLE)",
    );

    await act(async () => root.unmount());
    container.remove();
  });

  describe("large trade detector wiring", () => {
    let container: HTMLDivElement;
    let root: Root;

    async function render(
      props: {
        intervalMs?: number;
        markers?: MarkerFrame[];
        tapeTradeCount?: number;
        instrumentIdentity?: InstrumentIdentity;
      } = {},
    ) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(<Harness {...props} />);
      });
    }

    it("markers are hidden until the toggle is enabled -- applyMarkerSnapshot is called with an empty array by default", async () => {
      await render({ markers: [makeMarker(100_000)] });
      expect(chartHandle.applyMarkerSnapshot).toHaveBeenLastCalledWith(
        [],
        60_000,
        "delta",
        0,
      );
    });

    it("in size mode, a marker clearing the default threshold passes through", async () => {
      await render({ markers: [makeMarker(100_000, "big")] });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      chartHandle.applyMarkerSnapshot.mockClear();
      await act(async () => {
        switchToSizeMode(container);
      });

      const stats = chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0];
      expect(stats).toHaveLength(1);
      expect(stats[0].marker.trade_id).toBe("big");
    });

    it("in size mode, a marker below the default threshold is excluded", async () => {
      await render({ markers: [makeMarker(10_000, "small")] });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      await act(async () => {
        switchToSizeMode(container);
      });

      expect(chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0]).toEqual([]);
    });

    it("in size mode, futures use a contract threshold and label instead of fake USD notional", async () => {
      const futureMarker: MarkerFrame = {
        type: "marker",
        symbol: "/NQU26:XCME",
        provider: "DXFEED",
        assetClass: "FUTURE",
        ts_exchange: Date.now(),
        price: 29219,
        size: 50,
        side: "sell",
        trade_id: "nq-50",
      };
      await render({
        markers: [futureMarker],
        instrumentIdentity: {
          symbol: "/NQU26:XCME",
          provider: "DXFEED",
          assetClass: "FUTURE",
        },
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      await act(async () => {
        switchToSizeMode(container);
      });

      expect(
        chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0],
      ).toHaveLength(1);
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("≥ 20 ct");
      const input = container.querySelector<HTMLInputElement>(
        '.indicator-settings-field input[type="number"]',
      )!;
      expect(input.previousElementSibling?.textContent).toBe(
        "Minimum size (contracts)",
      );
    });

    it("shows a legend row naming the detector and its default top-percent setting once enabled", async () => {
      await render();
      await openIndicatorsMenu(container);

      expect(container.querySelector(".indicator-legend-row")).toBeNull();

      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });

      expect(
        container.querySelector(".indicator-legend-label")?.textContent,
      ).toBe("Large Trade Detector");
      // 1,000 tape trades and no markers yet: the selection is short of its
      // target, and the legend says so instead of implying a full top 0.05%.
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("top 0.05% · partial");
    });

    it("switching to size mode updates the legend detail to the dollar threshold", async () => {
      await render();
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      await act(async () => {
        switchToSizeMode(container);
      });

      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("≥ $75.0k");
    });

    it("the gear icon opens the settings modal, where editing the size threshold re-filters live without re-toggling", async () => {
      await render({ markers: [makeMarker(30_000, "mid")] });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      expect(
        container.querySelector(".indicator-settings-modal"),
      ).not.toBeNull();
      await act(async () => {
        switchToSizeMode(container);
      });
      expect(chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0]).toEqual([]); // below default 50k

      await act(async () => {
        setThresholdInput(container, "20000");
      });

      const stats = chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0];
      expect(stats).toHaveLength(1);
      expect(stats[0].marker.trade_id).toBe("mid");
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("≥ $20.0k");
    });

    it("the eye icon hides markers without disabling the detector -- toggling it back re-shows them", async () => {
      await render({
        markers: [
          {
            ...makeMarker(100_000, "1"),
            baseline_log_median: Math.log(1_000),
            baseline_log_mad: 0.3,
          },
        ],
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      expect(
        chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0],
      ).toHaveLength(1);

      await act(async () => {
        legendIcon(container, "Hide indicator").click();
      });
      expect(chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0]).toEqual([]);
      expect(
        container.querySelector(".indicator-legend-row-hidden"),
      ).not.toBeNull();

      await act(async () => {
        legendIcon(container, "Show indicator").click();
      });
      expect(
        chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0],
      ).toHaveLength(1);
    });

    it("the trash icon removes the detector entirely -- the legend row disappears and markers clear", async () => {
      await render({
        markers: [
          {
            ...makeMarker(100_000, "1"),
            baseline_log_median: Math.log(1_000),
            baseline_log_mad: 0.3,
          },
        ],
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      expect(
        chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0],
      ).toHaveLength(1);

      await act(async () => {
        legendIcon(container, "Remove indicator").click();
      });

      expect(container.querySelector(".indicator-legend-row")).toBeNull();
      expect(chartHandle.applyMarkerSnapshot.mock.calls.at(-1)![0]).toEqual([]);
    });

    it("removing the detector while its settings modal is open also closes the modal -- no orphaned dialog for a removed indicator", async () => {
      await render();
      await openIndicatorsMenu(container);
      await act(async () => {
        clickLargeTradeDetectorToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      expect(
        container.querySelector(".indicator-settings-modal"),
      ).not.toBeNull();

      await act(async () => {
        legendIcon(container, "Remove indicator").click();
      });

      expect(container.querySelector(".indicator-settings-modal")).toBeNull();
    });
  });

  describe("order book futures wiring (DX3.07 Phase D)", () => {
    const readyBook: BookFrame = {
      type: "book",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      status: "READY",
      bids: [{ price: 29139.75, size: 7 }],
      asks: [{ price: 29140, size: 3 }],
      lastUpdateId: 1,
      stale: false,
    };

    async function render(props: {
      instrumentIdentity: InstrumentIdentity;
      book: BookFrame | null;
    }) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness {...props} />);
      });
      return container;
    }

    it("a futures instrument's order book shows contract counts, not a fabricated USD notional", async () => {
      const container = await render({
        instrumentIdentity: {
          symbol: "/NQU26:XCME",
          provider: "DXFEED",
          assetClass: "FUTURE",
        },
        book: readyBook,
      });
      const header = Array.from(
        container.querySelectorAll(".dom-cols span"),
      ).map((el) => el.textContent);
      expect(header).toEqual(["Price", "Contracts"]);
      expect(container.querySelector(".dom-row .usd")).toBeNull();
      expect(
        container.querySelector(".dom-bids .dom-row .native")?.textContent,
      ).toBe("7 ct");
    });

    it("a non-futures (Binance) order book keeps showing the USD notional exactly as before", async () => {
      const binanceBook: BookFrame = {
        type: "book",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        status: "READY",
        bids: [{ price: 29139.75, size: 7 }],
        asks: [{ price: 29140, size: 3 }],
        lastUpdateId: 1,
        stale: false,
      };
      const container = await render({
        instrumentIdentity: {
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
        },
        book: binanceBook,
      });
      const header = Array.from(
        container.querySelectorAll(".dom-cols span"),
      ).map((el) => el.textContent);
      expect(header).toEqual(["Price", "Size / USD"]);
      expect(container.querySelector(".dom-row .usd")).not.toBeNull();
    });
  });

  describe("killzones settings wiring", () => {
    let container: HTMLDivElement;
    let root: Root;

    async function render() {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
    }

    function clickKillzonesToggle(): HTMLButtonElement {
      const row = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
      ).find(
        (r) =>
          r.querySelector(".indicators-row-label")?.textContent ===
          "ICT Killzones",
      )!;
      row.click();
      return row;
    }

    it("shows a legend row with no detail text once favorited, and a gear icon for its settings", async () => {
      await render();
      await openIndicatorsMenu(container);

      await act(async () => {
        clickKillzonesToggle();
      });

      expect(
        container.querySelector(".indicator-legend-label")?.textContent,
      ).toBe("ICT Killzones");
      expect(container.querySelector(".indicator-legend-detail")).toBeNull();
      expect(legendIcon(container, "Indicator settings")).not.toBeNull();
    });

    it("the gear icon opens Killzones settings with the documented default sessions and lets hidden sessions be enabled", async () => {
      await render();
      await openIndicatorsMenu(container);
      await act(async () => {
        clickKillzonesToggle();
      });

      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });

      expect(
        container.querySelector(
          '.indicator-settings-modal[aria-label="ICT Killzones settings"]',
        ),
      ).not.toBeNull();
      const checkboxes = [
        ...container.querySelectorAll<HTMLInputElement>(
          ".indicator-settings-checkbox input",
        ),
      ];
      expect(checkboxes).toHaveLength(7);
      expect(checkboxes[0].checked).toBe(true);
      const labels = [
        ...container.querySelectorAll<HTMLLabelElement>(
          ".indicator-settings-session-list label",
        ),
      ];
      expect(
        labels
          .filter((label) => label.querySelector("input")?.checked)
          .map((label) => label.textContent),
      ).toEqual(["Asia", "London", "NY AM", "NY PM"]);

      const lunch = labels
        .find((label) => label.textContent === "NY Lunch")!
        .querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        lunch.click();
      });
      expect(chartHandle.setKillzoneSessions).toHaveBeenLastCalledWith([
        "asia",
        "london",
        "nyam",
        "nypm",
        "nylunch",
      ]);
    });

    it("the eye icon and the settings checkbox drive the same visibility state", async () => {
      await render();
      await openIndicatorsMenu(container);
      await act(async () => {
        clickKillzonesToggle();
      });

      await act(async () => {
        legendIcon(container, "Hide indicator").click();
      });
      expect(
        container.querySelector(".indicator-legend-row-hidden"),
      ).not.toBeNull();

      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      const checkbox = container.querySelector<HTMLInputElement>(
        ".indicator-settings-checkbox input",
      )!;
      expect(checkbox.checked).toBe(false);

      await act(async () => {
        checkbox.click();
      });
      expect(
        container.querySelector(".indicator-legend-row-hidden"),
      ).toBeNull();
    });

    it("the trash icon removes Killzones -- the legend row disappears", async () => {
      await render();
      await openIndicatorsMenu(container);
      await act(async () => {
        clickKillzonesToggle();
      });
      expect(container.querySelector(".indicator-legend-row")).not.toBeNull();

      await act(async () => {
        legendIcon(container, "Remove indicator").click();
      });

      expect(container.querySelector(".indicator-legend-row")).toBeNull();
    });
  });

  describe("technical indicators use the same unified legend row, without a gear icon", () => {
    it("RSI shows a legend row with an eye and a trash icon, but no gear -- nothing to configure", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);
      const rsiRow = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
      ).find(
        (r) =>
          r.querySelector(".indicators-row-label")?.textContent === "RSI (14)",
      )!;

      await act(async () => {
        rsiRow.click();
      });

      expect(
        container.querySelector(".indicator-legend-label")?.textContent,
      ).toBe("RSI (14)");
      expect(legendIcon(container, "Hide indicator")).not.toBeNull();
      expect(legendIcon(container, "Indicator settings")).toBeNull();
      expect(legendIcon(container, "Remove indicator")).not.toBeNull();
    });
  });

  describe("SMA settings persist through un-favorite/re-favorite (closure-audit finding)", () => {
    it("re-favoriting SMA after removing it restores its last customized settings, not the defaults", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);

      await act(async () => {
        clickIndicatorToggle(container, "SMA (20)");
      });

      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      await act(async () => {
        setThresholdInput(container, "50");
      });
      expect(chartHandle.setIndicatorSettings).toHaveBeenLastCalledWith(
        "sma",
        expect.objectContaining({ length: 50 }),
      );

      await act(async () => {
        clickIndicatorToggle(container, "SMA (20)"); // un-favorite
      });
      await act(async () => {
        clickIndicatorToggle(container, "SMA (20)"); // re-favorite
      });

      const lastCall = chartHandle.setIndicators.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain("sma");
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          sma: expect.objectContaining({ length: 50 }),
        }),
      );

      root.unmount();
      container.remove();
    });
  });

  describe("un-favoriting via the Indicators menu star resets visibility, same as the trash icon", () => {
    it("hiding an indicator, un-favoriting it via the menu star, then re-favoriting it comes back visible -- not silently still hidden", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);
      const rsiStar = () =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>(".indicators-row"),
        ).find(
          (r) =>
            r.querySelector(".indicators-row-label")?.textContent ===
            "RSI (14)",
        )!;

      await act(async () => {
        rsiStar().click(); // favorite RSI via the menu
      });
      await act(async () => {
        legendIcon(container, "Hide indicator").click(); // hide it
      });
      expect(
        container.querySelector(".indicator-legend-row-hidden"),
      ).not.toBeNull();

      await act(async () => {
        rsiStar().click(); // un-favorite via the MENU STAR, not the trash icon
      });
      expect(container.querySelector(".indicator-legend-row")).toBeNull();

      await act(async () => {
        rsiStar().click(); // re-favorite
      });

      expect(container.querySelector(".indicator-legend-row")).not.toBeNull();
      expect(
        container.querySelector(".indicator-legend-row-hidden"),
      ).toBeNull();
      expect(legendIcon(container, "Hide indicator")).not.toBeNull();
    });
  });

  describe("Delta Divergence settings wiring", () => {
    it("keeps the user-facing contract to one Swing length control and forwards it to the chart", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);

      await act(async () => {
        clickDeltaDivergenceToggle(container);
      });
      expect(chartHandle.setDivergenceSettings).toHaveBeenLastCalledWith(3);
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("Swing 3");

      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      const inputs = container.querySelectorAll<HTMLInputElement>(
        '.indicator-settings-field input[type="number"]',
      );
      expect(inputs).toHaveLength(1);
      await act(async () => {
        setThresholdInput(container, "5");
      });

      expect(chartHandle.setDivergenceSettings).toHaveBeenLastCalledWith(5);
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("Swing 5");
      root.unmount();
      container.remove();
    });

    describe("aggressive order flow display mode", () => {
      it("defaults to the line rendering, and switching to candles reaches the chart", async () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
          root.render(<Harness />);
        });
        await openIndicatorsMenu(container);
        await act(async () => {
          clickIndicatorToggle(container, "Aggressive Order Flow");
        });

        expect(chartHandle.setOrderFlowDisplayMode).toHaveBeenLastCalledWith(
          "line",
        );

        await act(async () => {
          legendIcon(container, "Indicator settings").click();
        });
        const radios = Array.from(
          container.querySelectorAll<HTMLInputElement>(
            'input[name="displayMode"]',
          ),
        );
        expect(
          radios.map((radio) => radio.nextElementSibling?.textContent),
        ).toEqual(["Line", "Candles"]);

        await act(async () => {
          radios[1].click();
        });
        expect(chartHandle.setOrderFlowDisplayMode).toHaveBeenLastCalledWith(
          "candles",
        );

        root.unmount();
        container.remove();
      });
    });
  });

  describe("Session Volume Profile historical zones -- batching and pruning", () => {
    // The zone grid is the indicator's own default session length, not a
    // literal: these tests are about batching and pruning, and pinning an hour
    // here silently rotted the whole suite the moment that default changed.
    const period = DEFAULT_VOLUME_PROFILE_PERIOD_MS;
    let emitVisibleRange: ((fromMs: number, toMs: number) => void) | null =
      null;

    async function enabledPanel(
      extra: Partial<Parameters<typeof Harness>[0]> = {},
    ) {
      emitVisibleRange = null;
      chartHandle.subscribeVisibleRangeChange.mockImplementation(
        (cb: (f: number, t: number) => void) => {
          emitVisibleRange = cb;
          return () => {
            emitVisibleRange = null;
          };
        },
      );
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness status="open" {...extra} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickSessionProfileToggle(container);
      });
      sendProfileHistoryMock.mockClear();
      chartHandle.applyHistoricalProfiles.mockClear();
      return { container, root };
    }

    // The old path fired one profile_config per zone -- up to 50 separate
    // synchronous SQL round trips on a single pan.
    it("asks for every newly visible zone in one batched request, not one request per zone", async () => {
      const { container, root } = await enabledPanel();

      await act(async () => {
        emitVisibleRange?.(5 * period, 9 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      expect(sendProfileHistoryMock).toHaveBeenCalledTimes(1);
      const request = sendProfileHistoryMock.mock.calls[0][0];
      expect(request.period_ms).toBe(period);
      expect(request.ranges.length).toBeGreaterThan(1);
      for (const range of request.ranges) {
        expect(range.range_start_ts % period).toBe(0);
        expect(range.range_end_ts - range.range_start_ts).toBe(period);
      }
      root.unmount();
      container.remove();
    });

    // Regression: alignedPeriodBoundaries clips its final block to the
    // exclusion point, so a visible range not landing on the period grid
    // produced a short block. Both the worker and the server reject a whole
    // batch if any range's span != period_ms, so before the first live
    // profile frame arrived every single batch was silently dropped.
    it("never sends a partial period, which would make the whole batch be rejected", async () => {
      const { container, root } = await enabledPanel();

      await act(async () => {
        emitVisibleRange?.(5 * period, 9.4 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      expect(sendProfileHistoryMock).toHaveBeenCalledTimes(1);
      const request = sendProfileHistoryMock.mock.calls[0][0];
      expect(request.ranges.length).toBeGreaterThan(0);
      for (const range of request.ranges) {
        expect(range.range_end_ts - range.range_start_ts).toBe(period);
      }
      root.unmount();
      container.remove();
    });

    it("never re-requests a zone it already has while panning within the same span", async () => {
      const { container, root } = await enabledPanel();

      await act(async () => {
        emitVisibleRange?.(5 * period, 9 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      sendProfileHistoryMock.mockClear();

      await act(async () => {
        emitVisibleRange?.(5 * period, 9 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      expect(sendProfileHistoryMock).not.toHaveBeenCalled();
      root.unmount();
      container.remove();
    });

    it("asks only for the zones the new view added when panning forward", async () => {
      const { container, root } = await enabledPanel();

      await act(async () => {
        emitVisibleRange?.(5 * period, 8 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const first = new Set(
        sendProfileHistoryMock.mock.calls[0][0].ranges.map(
          (r: { range_start_ts: number }) => r.range_start_ts,
        ),
      );
      sendProfileHistoryMock.mockClear();

      await act(async () => {
        emitVisibleRange?.(7 * period, 10 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      expect(sendProfileHistoryMock).toHaveBeenCalledTimes(1);
      const second = sendProfileHistoryMock.mock.calls[0][0].ranges.map(
        (r: { range_start_ts: number }) => r.range_start_ts,
      );
      // Only genuinely new zones -- the overlap is not re-fetched.
      for (const start of second) {
        expect(first.has(start)).toBe(false);
      }
      root.unmount();
      container.remove();
    });

    // Without pruning, every zone ever seen stayed in the render set and was
    // re-projected on every chart redraw for the life of the session.
    it("stops rendering zones that have been panned off screen", async () => {
      const zoneAt = (start: number) => ({
        type: "profile" as const,
        symbol: "BTC-USDT",
        provider: "BINANCE" as const,
        marketKind: "SPOT" as const,
        mode: "fixed_range" as const,
        period_start_ts: start,
        period_end_ts: start + period,
        row_width: 1,
        delivery_scope: "HISTORICAL" as const,
        history_request_id: 1,
        buckets: [
          {
            price: 100,
            volume: 1,
            buy_volume: 1,
            sell_volume: 0,
            single_print: false,
          },
        ],
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      });
      const zones = [
        zoneAt(5 * period),
        zoneAt(6 * period),
        zoneAt(7 * period),
        zoneAt(8 * period),
      ];
      const { container, root } = await enabledPanel({
        historicalProfiles: zones,
      });

      await act(async () => {
        emitVisibleRange?.(5 * period, 7 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const rendered =
        chartHandle.applyHistoricalProfiles.mock.calls.at(-1)?.[0] ?? [];
      const renderedStarts = rendered.map(
        (z: { period_start_ts: number }) => z.period_start_ts,
      );

      expect(renderedStarts).toContain(5 * period);
      expect(renderedStarts).not.toContain(8 * period);
      root.unmount();
      container.remove();
    });

    // Regression: a zone scrolled out of view used to be FORGOTTEN, so panning
    // back re-requested it -- and at 1m per-candle a request is up to 50
    // separate profile reads, which is why zones disappeared and took seconds to
    // come back. Stopping the render must not mean forgetting the fetch.
    it("does not re-request a zone it already fetched after panning away and back", async () => {
      const { container, root } = await enabledPanel();

      await act(async () => {
        emitVisibleRange?.(5 * period, 8 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      expect(sendProfileHistoryMock).toHaveBeenCalledTimes(1);
      const fetched = new Set(
        sendProfileHistoryMock.mock.calls[0][0].ranges.map(
          (r: { range_start_ts: number }) => r.range_start_ts,
        ),
      );
      expect(fetched.has(5 * period)).toBe(true);
      sendProfileHistoryMock.mockClear();

      // Pan well away, so 5*period leaves the visible range entirely.
      await act(async () => {
        emitVisibleRange?.(200 * period, 205 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      sendProfileHistoryMock.mockClear();

      // ...and back again.
      await act(async () => {
        emitVisibleRange?.(5 * period, 8 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      const reRequested = sendProfileHistoryMock.mock.calls.flatMap((call) =>
        (call[0].ranges as { range_start_ts: number }[]).map(
          (r) => r.range_start_ts,
        ),
      );
      // Everything we had is still remembered, so nothing already fetched comes
      // back in the request.
      for (const start of reRequested) {
        expect(fetched.has(start)).toBe(false);
      }
      root.unmount();
      container.remove();
    });

    // L1L2-V2-107. P7-03's remediation gives every instrument/mode/period/
    // row-width change a new history generation, and the render filter accepts
    // only zones carrying the active one -- that is what stops a zone built at
    // the old row width from being drawn against the new configuration.
    //
    // The generation equality check was removable with the entire 1,029-test
    // browser suite still green: visibility was covered, generation was not.
    it("does not render a historical zone from a different request generation, even inside the visible range", async () => {
      const zoneAt = (start: number, historyRequestId: number) => ({
        type: "profile" as const,
        symbol: "BTC-USDT",
        provider: "BINANCE" as const,
        marketKind: "SPOT" as const,
        mode: "fixed_range" as const,
        period_start_ts: start,
        period_end_ts: start + period,
        row_width: 1,
        delivery_scope: "HISTORICAL" as const,
        history_request_id: historyRequestId,
        buckets: [
          {
            price: 100,
            volume: 1,
            buy_volume: 1,
            sell_volume: 0,
            single_print: false,
          },
        ],
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      });
      // Both sit inside the visible range, so only the generation can separate them.
      const zones = [zoneAt(5 * period, 1), zoneAt(6 * period, 2)];
      const { container, root } = await enabledPanel({
        historicalProfiles: zones,
      });

      await act(async () => {
        emitVisibleRange?.(5 * period, 7 * period);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const rendered =
        chartHandle.applyHistoricalProfiles.mock.calls.at(-1)?.[0] ?? [];
      const renderedStarts = rendered.map(
        (z: { period_start_ts: number }) => z.period_start_ts,
      );

      expect(renderedStarts).toContain(5 * period);
      expect(renderedStarts).not.toContain(6 * period);
      root.unmount();
      container.remove();
    });
  });

  describe("Session Volume Profile wiring (P4.09 Steps 4-7)", () => {
    it("waits for an open transport and reapplies live configuration after reconnects and instrument switches", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      sendProfileConfigMock.mockClear();

      await act(async () => {
        root.render(<Harness status="connecting" />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickSessionProfileToggle(container);
      });
      expect(sendProfileConfigMock).not.toHaveBeenCalled();

      await act(async () => {
        root.render(<Harness status="open" />);
      });
      expect(sendProfileConfigMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(<Harness status="closed" />);
      });
      await act(async () => {
        root.render(<Harness status="open" />);
      });
      expect(sendProfileConfigMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        root.render(
          <Harness
            status="open"
            instrumentIdentity={{
              symbol: "ETH-USDT",
              provider: "BINANCE",
              marketKind: "PERPETUAL",
            }}
          />,
        );
      });
      expect(sendProfileConfigMock).toHaveBeenCalledTimes(3);
      expect(sendProfileConfigMock).toHaveBeenLastCalledWith({
        mode: "continuous",
        period_ms: DEFAULT_VOLUME_PROFILE_PERIOD_MS,
        bin_size_multiplier: 2,
        range_start_ts: null,
        range_end_ts: null,
      });

      await act(async () => root.unmount());
      container.remove();
    });

    it("enabling it sends a continuous profile_config with the default session length, and shows a matching legend detail", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);

      await act(async () => {
        clickSessionProfileToggle(container);
      });

      expect(sendProfileConfigMock).toHaveBeenLastCalledWith({
        mode: "continuous",
        period_ms: 4 * 60 * 60 * 1000,
        bin_size_multiplier: 2,
        range_start_ts: null,
        range_end_ts: null,
      });
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("Volume Profile · Continuous 4H");
      root.unmount();
      container.remove();
    });

    it("switching to Per-Candle mode via settings sends the chart's own intervalMs as period_ms, and follows it live", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness intervalMs={300_000} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickSessionProfileToggle(container);
      });

      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      await act(async () => {
        const perCandle = Array.from(
          container.querySelectorAll<HTMLInputElement>('input[name="mode"]'),
        ).find((r) => r.nextElementSibling?.textContent === "Per-Candle")!;
        perCandle.click();
      });

      expect(sendProfileConfigMock).toHaveBeenLastCalledWith({
        mode: "per_candle",
        period_ms: 300_000,
        bin_size_multiplier: 2,
        range_start_ts: null,
        range_end_ts: null,
      });
      expect(
        container.querySelector(".indicator-legend-detail")?.textContent,
      ).toBe("Volume Profile · Per-Candle");

      await act(async () => {
        root.render(<Harness intervalMs={900_000} />);
      });
      expect(sendProfileConfigMock).toHaveBeenLastCalledWith({
        mode: "per_candle",
        period_ms: 900_000,
        bin_size_multiplier: 2,
        range_start_ts: null,
        range_end_ts: null,
      });
      root.unmount();
      container.remove();
    });

    it("un-favoriting closes its settings modal, the same reset every other indicator gets", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickSessionProfileToggle(container);
      });
      await act(async () => {
        legendIcon(container, "Indicator settings").click();
      });
      expect(
        container.querySelector(".indicator-settings-modal"),
      ).not.toBeNull();

      await act(async () => {
        legendIcon(container, "Remove indicator").click();
      });

      expect(container.querySelector(".indicator-settings-modal")).toBeNull();
      root.unmount();
      container.remove();
    });

    it("committing a Fixed Range drawing sends exactly one fixed_range profile_config, with no spurious continuous config racing behind it", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      sendProfileConfigMock.mockClear();

      await act(async () => {
        capturedChartPanelProps.onFixedRangeProfileRequested?.(1_000, 5_000);
      });

      expect(sendProfileConfigMock).toHaveBeenCalledTimes(1);
      expect(sendProfileConfigMock).toHaveBeenLastCalledWith({
        mode: "fixed_range",
        period_ms: null,
        bin_size_multiplier: 2,
        range_start_ts: 1_000,
        range_end_ts: 5_000,
      });
      root.unmount();
      container.remove();
    });
  });

  describe("Session Volume Profile view selection -- one frame, three renderings", () => {
    function legendRowFor(
      container: HTMLDivElement,
      label: string,
    ): HTMLDivElement {
      return Array.from(
        container.querySelectorAll<HTMLDivElement>(".indicator-legend-row"),
      ).find(
        (r) =>
          r.querySelector(".indicator-legend-label")?.textContent === label,
      )!;
    }

    function settingsGearFor(
      container: HTMLDivElement,
      label: string,
    ): HTMLButtonElement {
      return legendRowFor(container, label).querySelector<HTMLButtonElement>(
        '.indicator-legend-icon[aria-label="Indicator settings"]',
      )!;
    }

    async function enabledPanel(intervalMs = 300_000) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness intervalMs={intervalMs} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickSessionProfileToggle(container);
      });
      return { container, root };
    }

    it("names the selected view in the legend, and switching it sends no second profile_config", async () => {
      const { container, root } = await enabledPanel();
      const detail = () =>
        legendRowFor(container, SESSION_PROFILE_LABEL).querySelector(
          ".indicator-legend-detail",
        )?.textContent;
      expect(detail()).toBe("Volume Profile · Continuous 4H");
      sendProfileConfigMock.mockClear();

      await act(async () => {
        settingsGearFor(container, SESSION_PROFILE_LABEL).click();
      });
      await act(async () => {
        const viewSelect = Array.from(
          container.querySelectorAll<HTMLSelectElement>(
            ".indicator-settings-field select",
          ),
        ).find((select) => select.value === "volumeProfile")!;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          "value",
        )!.set!;
        setter.call(viewSelect, "deltaProfile");
        viewSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });

      expect(detail()).toBe("Delta Profile · Continuous 4H");
      // The view only chooses how the frame already arriving is drawn, so the
      // session config on the host is untouched.
      expect(sendProfileConfigMock).not.toHaveBeenCalled();
      root.unmount();
      container.remove();
    });

    it("hands the selected view's palette and session config to the chart as one settings object", async () => {
      const { container, root } = await enabledPanel();
      const calls = chartHandle.setSessionProfileSettings.mock.calls;
      const latest = calls[calls.length - 1][0] as {
        view: string;
        buyColor: string;
        valueAreaPercent: number;
      };
      expect(latest.view).toBe("volumeProfile");
      // The merged palette's defaults are Volume Profile's own colours.
      expect(latest.buyColor).toBe("#2acccc");
      expect(latest.valueAreaPercent).toBe(0.7);
      root.unmount();
      container.remove();
    });

    it("keeps a single visibility, and hides the profile without un-favoriting it", async () => {
      const { container, root } = await enabledPanel();
      const row = legendRowFor(container, SESSION_PROFILE_LABEL);

      await act(async () => {
        row
          .querySelector<HTMLButtonElement>(
            '.indicator-legend-icon[aria-label="Hide indicator"]',
          )!
          .click();
      });

      const hidden = legendRowFor(container, SESSION_PROFILE_LABEL);
      expect(
        hidden.querySelector(
          '.indicator-legend-icon[aria-label="Show indicator"]',
        ),
      ).not.toBeNull();
      root.unmount();
      container.remove();
    });
  });

  describe("VPIN Cloud wiring (P4.12 Step 7)", () => {
    function legendRowFor(
      container: HTMLDivElement,
      label: string,
    ): HTMLDivElement {
      return Array.from(
        container.querySelectorAll<HTMLDivElement>(".indicator-legend-row"),
      ).find(
        (r) =>
          r.querySelector(".indicator-legend-label")?.textContent === label,
      )!;
    }

    function settingsGearFor(
      container: HTMLDivElement,
      label: string,
    ): HTMLButtonElement {
      return legendRowFor(container, label).querySelector<HTMLButtonElement>(
        '.indicator-legend-icon[aria-label="Indicator settings"]',
      )!;
    }

    function reading(sealTs: number, zVpin: number): VpinReading {
      return {
        seal_ts: sealTs,
        active: false,
        direction: null,
        strength: 0,
        z_vpin: zVpin,
        z_velocity: 0,
        z_acceleration: 0,
        activated_at_ts: null,
      };
    }

    function lastAppliedReadings(): VpinReading[] {
      return chartHandle.applyVpinReadings.mock.calls.at(
        -1,
      )![0] as VpinReading[];
    }

    it("re-derives active/direction client-side from z_vpin, ignoring the server's own (fixed-threshold) verdict", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const serverInactive: VpinReading = {
        seal_ts: 1_000,
        active: false,
        direction: null,
        strength: 0,
        z_vpin: 1.5,
        z_velocity: 0,
        z_acceleration: 0,
        activated_at_ts: null,
      };
      await act(async () => {
        root.render(<Harness vpinHistory={[serverInactive]} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });

      const [applied] = lastAppliedReadings();
      expect(applied.active).toBe(true);
      expect(applied.direction).toBe("buy");
      root.unmount();
      container.remove();
    });

    it("shows the current sensitivity threshold in the legend detail, starting from the fixed default", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });

      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 1.00z");
      root.unmount();
      container.remove();
    });

    it("does not derive a default from too little backfilled history to be meaningful, and still derives correctly once enough arrives", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const tooFew = Array.from({ length: 5 }, (_, i) => reading(i, 3.0));
      await act(async () => {
        root.render(<Harness vpinHistory={tooFew} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });
      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 1.00z");

      const quiet = Array.from({ length: 18 }, (_, i) => reading(i, 0.1));
      const spikes = [reading(18, 3.0), reading(19, 3.0)];
      await act(async () => {
        root.render(<Harness vpinHistory={[...quiet, ...spikes]} />);
      });

      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 0.30z");
      root.unmount();
      container.remove();
    });

    it("derives a data-driven default sensitivity from real backfilled history, distinct from the fixed fallback", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const quiet = Array.from({ length: 19 }, (_, i) => reading(i, 0.1));
      const spike = reading(19, 3.0);
      await act(async () => {
        root.render(<Harness vpinHistory={[...quiet, spike]} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });

      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 0.30z");
      const [...applied] = lastAppliedReadings();
      expect(applied.at(-1)?.active).toBe(true);
      root.unmount();
      container.remove();
    });

    it("adjusting sensitivity in the settings modal re-derives the rendered cloud", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Harness vpinHistory={[reading(1_000, 1.5)]} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });
      expect(lastAppliedReadings()[0].active).toBe(true);

      await act(async () => {
        settingsGearFor(container, "VPIN Cloud").click();
      });
      setThresholdInput(container, "2");

      expect(lastAppliedReadings()[0].active).toBe(false);
      root.unmount();
      container.remove();
    });

    it("resetting settings returns sensitivity to the instrument's own derived default, not the fixed fallback", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const quiet = Array.from({ length: 19 }, (_, i) => reading(i, 0.1));
      const spike = reading(19, 3.0);
      await act(async () => {
        root.render(<Harness vpinHistory={[...quiet, spike]} />);
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickVpinCloudToggle(container);
      });
      await act(async () => {
        settingsGearFor(container, "VPIN Cloud").click();
      });
      setThresholdInput(container, "2");
      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 2.00z");

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(".indicator-settings-reset")!
          .click();
      });

      expect(
        legendRowFor(container, "VPIN Cloud").querySelector(
          ".indicator-legend-detail",
        )?.textContent,
      ).toBe("≥ 0.30z");
      root.unmount();
      container.remove();
    });
  });
});

describe("MainPanel -- L2 Book Map wiring (PR #14)", () => {
  it("feeds depth when enabled, propagates settings, and releases depth when hidden", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness liquidity={liquidity} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, "L2 Liquidity Book Map");
    });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(liquidity);
    expect(chartHandle.setL2BookMapSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ priceBinRows: 20, windowBuckets: DEFAULT_L2_BOOK_MAP_SETTINGS.windowBuckets }),
    );
    await act(async () => {
      rowIcon(container, "L2 Liquidity Book Map", "Hide indicator").click();
    });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(null);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("MainPanel -- Order Flow Gaps wiring", () => {
  it("provides the shared lane-0 grid while the voids are visible, with the heatmap off", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Flowprint Blocks"); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(liquidity);
    await act(async () => { rowIcon(container, "Flowprint Blocks", "Hide indicator").click(); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe("MainPanel -- Empty Orderbook wiring", () => {
  it("provides the shared lane-0 grid while the zones are visible, with the heatmap off", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Empty Orderbook"); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(liquidity);
    await act(async () => { rowIcon(container, "Empty Orderbook", "Hide indicator").click(); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe("MainPanel -- Absorption history wiring", () => {
  it("hands the chart the column stream it was given, and nothing once it is gone", async () => {
    const { ColumnHistoryStream } = await import("../../../lib/indicators/passive-liquidity/columnHistoryStream");
    const stream = new ColumnHistoryStream({ request: () => undefined });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness columnHistory={stream} />); });
    expect(chartHandle.applyColumnHistory).toHaveBeenLastCalledWith(stream);
    await act(async () => { root.render(<Harness columnHistory={null} />); });
    expect(chartHandle.applyColumnHistory).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe("MainPanel -- host wall stream wiring", () => {
  it("hands the chart the host wall stream it was given, and nothing once it is gone", async () => {
    const { WallHistoryStream: Stream } = await import("../../../lib/l2/wallHistoryStream");
    const stream = new Stream({ request: () => undefined });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness hostWalls={stream} />); });
    expect(chartHandle.applyHostWalls).toHaveBeenLastCalledWith(stream);
    await act(async () => { root.render(<Harness hostWalls={null} />); });
    expect(chartHandle.applyHostWalls).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe("MainPanel -- whale limit order heatmap wiring", () => {
  it("hands the chart the whale wall stream it was given, and nothing once it is gone", async () => {
    const { WallHistoryStream: Stream } = await import("../../../lib/l2/wallHistoryStream");
    const stream = new Stream({ request: () => undefined });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness whaleWalls={stream} />); });
    expect(chartHandle.applyWhaleWalls).toHaveBeenLastCalledWith(stream);
    await act(async () => { root.render(<Harness whaleWalls={null} />); });
    expect(chartHandle.applyWhaleWalls).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("gives the chart the saved settings, shows the cut and history on its legend row, and stops asking for depth when hidden", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    expect(chartHandle.setWhaleHeatmapSettings).toHaveBeenLastCalledWith(expect.objectContaining({ cutPreset: 2, hours: 48, cutBasis: "usd" }));
    await openIndicatorsMenu(container);
    const applied = vi.mocked(chartHandle.applyLiquidity).mock.calls.length;
    await act(async () => { clickIndicatorToggle(container, "Whale Limit Order Heatmap"); });
    expect(vi.mocked(chartHandle.applyLiquidity).mock.calls.length).toBeGreaterThan(applied);
    expect(container.textContent).toContain("top 10% · ≥ $4.4M + fills · 48 h");
    expect(JSON.parse(localStorage.getItem("terminal.live-indicators.extras.v1") ?? "{}").whaleHeatmap).toMatchObject({ cutPreset: 2, hours: 48, cutBasis: "usd", fills: true });
    await act(async () => { rowIcon(container, "Whale Limit Order Heatmap", "Indicator settings").click(); });
    expect(document.querySelector("[aria-label=\"Whale limit order heatmap settings\"]")).not.toBeNull();
    const modal = document.querySelector("[aria-label=\"Whale limit order heatmap settings\"]")!;
    const history = modal.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(history, "24");
      history.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chartHandle.setWhaleHeatmapSettings).toHaveBeenLastCalledWith(expect.objectContaining({ hours: 24 }));
    expect(container.textContent).toContain("top 10% · ≥ $4.4M + fills · 24 h");
    expect(JSON.parse(localStorage.getItem("terminal.live-indicators.extras.v1") ?? "{}").whaleHeatmap).toMatchObject({ hours: 24 });
    await act(async () => { [...modal.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === "Visibility")!.click(); });
    const hiddenAt = vi.mocked(chartHandle.applyLiquidity).mock.calls.length;
    await act(async () => { [...modal.querySelectorAll<HTMLElement>("label.indicator-settings-checkbox")].find((label) => label.textContent === "Show on chart")!.querySelector("input")!.click(); });
    expect(rowIcon(container, "Whale Limit Order Heatmap", "Show indicator")).not.toBeNull();
    expect(vi.mocked(chartHandle.applyLiquidity).mock.calls.length).toBeGreaterThan(hiddenAt);
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

describe("MainPanel -- L2 Feed Status wiring", () => {
  it("provides the shared lane-0 grid while the status panel is visible", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "L2 Feed Status"); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(liquidity);
    await act(async () => { rowIcon(container, "L2 Feed Status", "Hide indicator").click(); });
    expect(chartHandle.applyLiquidity).toHaveBeenLastCalledWith(null);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("the heatmap legend names the rows the chart is drawing, lane 0 or a merged lane (P4c.2)", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const liquidity = new LiquidityGrid();
    liquidity.apply({ type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: 1_700_000_000_000, seq: 1, reset: true, row_width: 0.1, column_ms: 1000, columns: [{ ts: 1_700_000_000_000, lo: 100, hi: 104, bid: [[0, 40]], ask: [] }] } as LiquidityFrame);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Passive Liquidity Heatmap"); });
    const detail = () => legendRowFor(container, "Passive Liquidity Heatmap").querySelector(".indicator-legend-detail")?.textContent ?? "";
    expect(detail()).toContain("rows 0.1");
    expect(detail()).not.toContain("(x");
    await act(async () => { capturedChartPanelProps.onLiquidityLaneDrawn?.(2); });
    expect(detail()).toContain("rows 0.4 (x4)");
    await act(async () => { capturedChartPanelProps.onLiquidityLaneDrawn?.(0); });
    expect(detail()).toContain("rows 0.1");
    expect(detail()).not.toContain("(x");
    const history = { levelMs: 300_000, rowFactor: 1, days: 3 as const, loading: false, reachTs: Date.UTC(2026, 8, 21, 14, 5), drawn: true, refused: null, unavailable: null };
    await act(async () => { capturedChartPanelProps.onLiquidityHistoryDrawn?.(history); });
    expect(detail()).toContain("history 3 days, from 09-21 14:05 UTC");
    await act(async () => { capturedChartPanelProps.onLiquidityHistoryDrawn?.({ ...history, loading: true, days: 7 }); });
    expect(detail()).toContain("loading 1 week of history");
    await act(async () => { capturedChartPanelProps.onLiquidityHistoryDrawn?.({ ...history, drawn: false, refused: "GEOMETRY" }); });
    expect(detail()).toContain("history rows differ");
    await act(async () => { capturedChartPanelProps.onLiquidityHistoryDrawn?.({ ...history, drawn: false, unavailable: "NO_PYRAMID" }); });
    expect(detail()).toContain("history unavailable");
    await act(async () => { capturedChartPanelProps.onLiquidityHistoryDrawn?.(null); });
    expect(detail()).not.toContain("history");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("hands the chart the saved heatmap price-zoom choice on mount (P4c.2)", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.setItem("terminal.live-indicators.extras.v1", JSON.stringify({ liquidityLane: "2" }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    chartHandle.setLiquidityLane.mockClear();
    await act(async () => { root.render(<Harness />); });
    expect(chartHandle.setLiquidityLane).toHaveBeenCalledWith("2");
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem("terminal.live-indicators.extras.v1");
  });

  it("redraws every second while visible, so a feed that stops sending shows its lag growing", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => { root.render(<Harness l2={new L2Store()} />); });
      chartHandle.refreshL2.mockClear();
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(chartHandle.refreshL2).not.toHaveBeenCalled();

      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, "L2 Feed Status"); });
      chartHandle.refreshL2.mockClear();
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(chartHandle.refreshL2).toHaveBeenCalledTimes(3);

      await act(async () => { rowIcon(container, "L2 Feed Status", "Hide indicator").click(); });
      chartHandle.refreshL2.mockClear();
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(chartHandle.refreshL2).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
      container.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MainPanel -- live indicator preferences survive a reload (L-W4-6)", () => {
  it("hands the chart the saved Session Volume Profile view on mount, before any settings edit", async () => {
    localStorage.setItem(
      "terminal.indicators.favorites",
      JSON.stringify(["sessionVolumeProfile"]),
    );
    localStorage.setItem(
      "terminal.live-indicators.preferences.v1",
      JSON.stringify({
        runtimeSettingsById: {
          sessionVolumeProfile: {
            view: "deltaProfile",
            mode: "continuous",
            periodMs: 60 * 60 * 1000,
            binSizeMultiplier: 3,
          },
        },
      }),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    chartHandle.setSessionProfileSettings.mockClear();
    await act(async () => {
      root.render(<Harness />);
    });

    const latest = chartHandle.setSessionProfileSettings.mock.calls.at(-1)![0] as {
      view: string;
      periodMs: number;
      binSizeMultiplier: number;
    };
    // Without this push the chart panel would keep drawing the default view,
    // because which primitive owns the frame is ChartPanel's own state.
    expect(latest).toMatchObject({
      view: "deltaProfile",
      periodMs: 60 * 60 * 1000,
      binSizeMultiplier: 3,
    });
    expect(
      container
        .querySelector(".indicator-legend-detail")
        ?.textContent,
    ).toBe("Delta Profile · Continuous 1H");

    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.preferences.v1");
    root.unmount();
    container.remove();
  });

  it("brings back a hidden indicator still hidden after the panel is torn down and mounted again", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const first = document.createElement("div");
    document.body.appendChild(first);
    const firstRoot = createRoot(first);
    await act(async () => {
      firstRoot.render(<Harness />);
    });
    await openIndicatorsMenu(first);
    await act(async () => {
      clickIndicatorToggle(first, "L2 Liquidity Book Map");
    });
    await act(async () => {
      rowIcon(first, "L2 Liquidity Book Map", "Hide indicator").click();
    });
    expect(legendSnapshot(first)["L2 Liquidity Book Map"]?.hidden).toBe(true);
    await act(async () => {
      firstRoot.unmount();
    });
    first.remove();

    const second = document.createElement("div");
    document.body.appendChild(second);
    const secondRoot = createRoot(second);
    await act(async () => {
      secondRoot.render(<Harness />);
    });
    expect(legendSnapshot(second)["L2 Liquidity Book Map"]?.hidden).toBe(true);
    expect(chartHandle.setIndicatorVisibility.mock.lastCall?.[0]).not.toContain(
      "l2BookMap",
    );
    expect(chartHandle.setIndicators.mock.lastCall?.[0]).toContain("l2BookMap");
    await act(async () => {
      secondRoot.unmount();
    });
    second.remove();
    localStorage.removeItem("terminal.indicators.favorites");
  });
});

describe("MainPanel -- custom indicator settings survive a reload (report 57 W6, L-W4-6 remainder)", () => {
  const BTC_KEY = instrumentKey({
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
  });
  const BTC_STYLE = liquidityStyleFor("BINANCE", "BTC-USDT", "SPOT").name;

  async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    return { container, root };
  }

  it("hands the chart the saved L2 levels, Book Map, heatmap, aggressive and absorption settings on mount", async () => {
    const saved = {
      l2SupportResistance: {
        ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
        maxLevels: 7,
      },
      l2BookMap: { ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 9 },
      liquidityByStyle: {
        [BTC_STYLE]: { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 5 },
      },
      aggressiveByInstrument: {
        [BTC_KEY]: { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 3 },
      },
      absorptionByInstrument: {
        [BTC_KEY]: { ...DEFAULT_ABSORPTION_SETTINGS, opacity: 0.4 },
      },
    };
    localStorage.setItem(
      "terminal.live-indicators.extras.v1",
      JSON.stringify(saved),
    );
    const { container, root } = await mount();

    expect(chartHandle.setL2SupportResistanceSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxLevels: 7 }),
    );
    expect(chartHandle.setL2BookMapSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ priceBinRows: 9 }),
    );
    expect(chartHandle.setLiquiditySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterRows: 5 }),
    );
    expect(chartHandle.setAggressiveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ minVolume: 3 }),
    );
    expect(chartHandle.setAbsorptionSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ opacity: 0.4 }),
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("restores the whale detector's mode and threshold and the edited VPIN sensitivity in their legends", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.setItem(
      "terminal.live-indicators.extras.v1",
      JSON.stringify({
        whale: { mode: "size", thresholdUsd: 120_000 },
        vpinSensitivity: 2.5,
      }),
    );
    const { container, root } = await mount();
    await openIndicatorsMenu(container);
    await act(async () => {
      clickLargeTradeDetectorToggle(container);
    });
    await act(async () => {
      clickVpinCloudToggle(container);
    });

    expect(
      legendRowFor(container, "Large Trade Detector").querySelector(
        ".indicator-legend-detail",
      )?.textContent,
    ).toBe("≥ $120.0k");
    expect(
      legendRowFor(container, "VPIN Cloud").querySelector(
        ".indicator-legend-detail",
      )?.textContent,
    ).toContain("≥ 2.50z");
    await act(async () => {
      root.unmount();
    });
    container.remove();
    localStorage.removeItem("terminal.indicators.favorites");
  });

  it("saves a setting changed in its modal, so the next load sees it", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const { container, root } = await mount();
    await openIndicatorsMenu(container);
    await act(async () => {
      clickLargeTradeDetectorToggle(container);
    });
    await act(async () => {
      rowIcon(container, "Large Trade Detector", "Indicator settings").click();
    });
    await act(async () => {
      switchToSizeMode(container);
    });

    const stored = JSON.parse(
      localStorage.getItem("terminal.live-indicators.extras.v1") ?? "{}",
    );
    expect(stored.whale.mode).toBe("size");
    await act(async () => {
      root.unmount();
    });
    container.remove();
    localStorage.removeItem("terminal.indicators.favorites");
  });
});

describe("MainPanel -- L2 Support & Resistance wiring (PR #11)", () => {
  const LABEL = "L2 Support & Resistance";

  function legendRowFor(
    container: HTMLDivElement,
    label: string,
  ): HTMLDivElement {
    return Array.from(
      container.querySelectorAll<HTMLDivElement>(".indicator-legend-row"),
    ).find(
      (r) => r.querySelector(".indicator-legend-label")?.textContent === label,
    )!;
  }

  it("enabling forwards initial settings to the chart handle, a setting change propagates, then hide and remove both take", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, LABEL);
    });

    expect(chartHandle.setL2SupportResistanceSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxLevels: 15,
        minimumDistanceRows: 15,
        lookbackMinutes: 10,
        minimumLiquiditySize: 0,
      }),
    );

    await act(async () => {
      rowIcon(container, LABEL, "Indicator settings").click();
    });
    await act(async () => {
      setThresholdInput(container, "5");
    });

    expect(chartHandle.setL2SupportResistanceSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxLevels: 5 }),
    );

    await act(async () => {
      rowIcon(container, LABEL, "Hide indicator").click();
    });
    expect(legendRowFor(container, LABEL).className).toContain(
      "indicator-legend-row-hidden",
    );

    await act(async () => {
      rowIcon(container, LABEL, "Remove indicator").click();
    });
    expect(
      Array.from(container.querySelectorAll(".indicator-legend-label")).some(
        (el) => el.textContent === LABEL,
      ),
    ).toBe(false);

    root.unmount();
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// Phase 18 (A2.18): cross-indicator isolation. Every prior indicator phase
// tested one indicator at a time; these enable all ten together and try to make
// one leak into another.
// ---------------------------------------------------------------------------

const ALL_INDICATOR_LABELS = [
  "RSI (14)",
  "EMA (12 / 21)",
  "Bollinger Bands (20, 2)",
  "ICT Killzones",
  "Aggressive Order Flow",
  "Large Trade Detector",
  "Delta Divergence",
  SESSION_PROFILE_LABEL,
  "VPIN Cloud",
];

function legendRowFor(
  container: HTMLDivElement,
  label: string,
): HTMLDivElement {
  const row = Array.from(
    container.querySelectorAll<HTMLDivElement>(".indicator-legend-row"),
  ).find(
    (r) => r.querySelector(".indicator-legend-label")?.textContent === label,
  );
  if (!row) throw new Error(`no legend row for "${label}"`);
  return row;
}

function rowIcon(
  container: HTMLDivElement,
  label: string,
  ariaLabel: string,
): HTMLButtonElement {
  const button = legendRowFor(
    container,
    label,
  ).querySelector<HTMLButtonElement>(`[aria-label="${ariaLabel}"]`);
  if (!button) throw new Error(`no "${ariaLabel}" control on "${label}"`);
  return button;
}

function legendSnapshot(
  container: HTMLDivElement,
): Record<string, { detail: string; hidden: boolean }> {
  const out: Record<string, { detail: string; hidden: boolean }> = {};
  for (const row of container.querySelectorAll<HTMLDivElement>(
    ".indicator-legend-row",
  )) {
    const label =
      row.querySelector(".indicator-legend-label")?.textContent ?? "";
    out[label] = {
      detail: row.querySelector(".indicator-legend-detail")?.textContent ?? "",
      hidden: row.className.includes("indicator-legend-row-hidden"),
    };
  }
  return out;
}

async function enableAllIndicators(container: HTMLDivElement): Promise<void> {
  await openIndicatorsMenu(container);
  for (const label of ALL_INDICATOR_LABELS) {
    await act(async () => {
      clickIndicatorToggle(container, label);
    });
  }
}

describe("MainPanel -- cross-indicator isolation (A2.18)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderAll() {
    await act(async () => {
      root.render(<Harness />);
    });
    await enableAllIndicators(container);
  }

  it("all eleven indicators can be enabled at once, each with its own legend row", async () => {
    await renderAll();
    const labels = Array.from(
      container.querySelectorAll(".indicator-legend-label"),
    ).map((n) => n.textContent);
    expect(new Set(labels)).toEqual(new Set(ALL_INDICATOR_LABELS));
    expect(labels).toHaveLength(ALL_INDICATOR_LABELS.length);
  });

  it("hiding one indicator leaves every other indicator's visibility untouched", async () => {
    await renderAll();
    const before = legendSnapshot(container);

    await act(async () => {
      rowIcon(container, SESSION_PROFILE_LABEL, "Hide indicator").click();
    });

    const after = legendSnapshot(container);
    expect(after[SESSION_PROFILE_LABEL].hidden).toBe(true);
    for (const label of ALL_INDICATOR_LABELS) {
      if (label === SESSION_PROFILE_LABEL) continue;
      expect(after[label]).toEqual(before[label]);
    }
  });

  it("only one settings modal is ever open, even after opening several in turn", async () => {
    await renderAll();
    for (const label of [
      "Large Trade Detector",
      SESSION_PROFILE_LABEL,
      "VPIN Cloud",
      "Delta Divergence",
    ]) {
      await act(async () => {
        rowIcon(container, label, "Indicator settings").click();
      });
      expect(
        container.querySelectorAll(".indicator-settings-modal"),
      ).toHaveLength(1);
    }
  });

  it("changing one indicator's setting does not alter any other indicator's legend detail", async () => {
    await renderAll();
    const before = legendSnapshot(container);

    await act(async () => {
      rowIcon(container, "Delta Divergence", "Indicator settings").click();
    });
    await act(async () => {
      setThresholdInput(container, "6");
    });

    const after = legendSnapshot(container);
    expect(after["Delta Divergence"].detail).not.toBe(
      before["Delta Divergence"].detail,
    );
    for (const label of ALL_INDICATOR_LABELS) {
      if (label === "Delta Divergence") continue;
      expect(after[label]).toEqual(before[label]);
    }
  });

  it("removing one indicator leaves the rest enabled and unchanged", async () => {
    await renderAll();
    const before = legendSnapshot(container);

    await act(async () => {
      rowIcon(container, "Aggressive Order Flow", "Remove indicator").click();
    });

    const after = legendSnapshot(container);
    expect(after["Aggressive Order Flow"]).toBeUndefined();
    for (const label of ALL_INDICATOR_LABELS) {
      if (label === "Aggressive Order Flow") continue;
      expect(after[label]).toEqual(before[label]);
    }
  });

  it("a hidden indicator stays hidden while another is removed", async () => {
    await renderAll();
    await act(async () => {
      rowIcon(container, "VPIN Cloud", "Hide indicator").click();
    });
    await act(async () => {
      rowIcon(container, "RSI (14)", "Remove indicator").click();
    });

    expect(legendSnapshot(container)["VPIN Cloud"].hidden).toBe(true);
  });
});

describe("MainPanel -- state across instrument and timeframe switches (A2.18)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const FUTURES: InstrumentIdentity = {
    symbol: "/NQU26:XCME",
    provider: "DXFEED",
    assetClass: "FUTURE",
  };

  it("a timeframe switch preserves every enabled indicator and its settings", async () => {
    await act(async () => {
      root.render(<Harness intervalMs={60_000} />);
    });
    await enableAllIndicators(container);
    await act(async () => {
      rowIcon(container, "Delta Divergence", "Indicator settings").click();
    });
    await act(async () => {
      setThresholdInput(container, "6");
    });
    const before = legendSnapshot(container);

    await act(async () => {
      root.render(<Harness intervalMs={15 * 60_000} />);
    });

    expect(legendSnapshot(container)).toEqual(before);
  });

  it("an instrument switch keeps every indicator enabled rather than silently dropping any", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    await enableAllIndicators(container);
    const labelsBefore = Object.keys(legendSnapshot(container)).sort();

    await act(async () => {
      root.render(<Harness instrumentIdentity={FUTURES} />);
    });

    expect(Object.keys(legendSnapshot(container)).sort()).toEqual(labelsBefore);
  });

  it("switching to futures re-denominates the whale threshold in contracts, and back again", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickLargeTradeDetectorToggle(container);
    });
    // Top-percent mode reads the same on any instrument; the USD-vs-contracts
    // distinction only surfaces in Size mode.
    await act(async () => {
      rowIcon(container, "Large Trade Detector", "Indicator settings").click();
    });
    await act(async () => {
      switchToSizeMode(container);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".indicator-settings-ok")!
        .click();
    });
    const cashDetail = legendSnapshot(container)["Large Trade Detector"].detail;

    await act(async () => {
      root.render(<Harness instrumentIdentity={FUTURES} />);
    });
    const futuresDetail =
      legendSnapshot(container)["Large Trade Detector"].detail;

    await act(async () => {
      root.render(<Harness />);
    });

    expect(futuresDetail).not.toBe(cashDetail);
    expect(legendSnapshot(container)["Large Trade Detector"].detail).toBe(
      cashDetail,
    );
  });

  it("an open settings modal does not survive removing the indicator that owns it", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickSessionProfileToggle(container);
    });
    await act(async () => {
      rowIcon(container, SESSION_PROFILE_LABEL, "Indicator settings").click();
    });
    expect(
      container.querySelectorAll(".indicator-settings-modal"),
    ).toHaveLength(1);

    await act(async () => {
      rowIcon(container, SESSION_PROFILE_LABEL, "Remove indicator").click();
    });

    expect(
      container.querySelectorAll(".indicator-settings-modal"),
    ).toHaveLength(0);
  });
});

describe("MainPanel -- the size floor is the instrument's, typed in its unit", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const ETH: InstrumentIdentity = {
    symbol: "ETH-USDT",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
  };
  const BTC: InstrumentIdentity = {
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
  };

  const floorInput = () =>
    container.querySelector<HTMLInputElement>(
      '.indicator-settings-modal input[inputmode="numeric"]',
    )!;
  const floorUnit = () =>
    container.querySelector(
      ".indicator-settings-modal .indicator-settings-unit",
    )?.textContent;

  it("shows the floor in force with the unit beside it, takes a typed number for that instrument only, and follows a switch", async () => {
    // The trader, 2026-09-20: type 2500 into the box, it reads 2500 ETH and hides any wall resting smaller; the arrows go.
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, "Institutional Order Blocks v2");
    });
    await act(async () => {
      rowIcon(
        container,
        "Institutional Order Blocks v2",
        "Indicator settings",
      ).click();
    });
    expect([floorInput().value, floorInput().type, floorUnit()]).toEqual([
      "2400",
      "text",
      "ETH",
    ]);

    await act(async () => {
      setThresholdInputOn(floorInput(), "2500");
    });
    expect([floorInput().value, floorUnit()]).toEqual(["2500", "ETH"]);

    // The BTC perp keeps its own floor; the ETH number is waiting when the chart comes back.
    await act(async () => {
      root.render(<Harness instrumentIdentity={BTC} />);
    });
    expect([floorInput().value, floorUnit()]).toEqual(["150", "BTC"]);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    expect([floorInput().value, floorUnit()]).toEqual(["2500", "ETH"]);
  });
});

describe("MainPanel -- Prime Absorption rule settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem("terminal.indicators.favorites");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY);
  });

  const ETH: InstrumentIdentity = { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" };
  const BTC: InstrumentIdentity = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" };
  const slider = () => container.querySelector<HTMLInputElement>('.indicator-settings-modal input[aria-label="Absorbed share"]')!;
  const lastRules = () => chartHandle.setAbsorptionRules.mock.calls.at(-1)![0] as AbsorptionRules | null;

  it("hands the chart the rule's numbers for that instrument, keeps them per instrument, and shapes the walls by the market's heatmap settings", async () => {
    // The rule of 2026-10-07: the walls are the heatmap's walls, so the market's heatmap settings go with the rules; the
    // three numbers are the trader's, kept per instrument like the rest of the dialog.
    const ethPerp = liquidityStyleFor("BINANCE", "ETH-USDT", "PERPETUAL").defaultSettings;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ liquidityByStyle: { "eth-perp": { ...ethPerp, clusterRows: 7, minBandSize: 900 } } }));
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Prime Absorption"); });
    await act(async () => { rowIcon(container, "Prime Absorption", "Indicator settings").click(); });
    expect(slider().value).toBe("200");
    expect(lastRules()).toMatchObject({ absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40, bandRows: 7, quietMs: 120_000 });
    expect(lastRules()?.wallKey).toBe(absorptionRulesFor(ETH, undefined, 60_000, { ...ethPerp, clusterRows: 7, minBandSize: 900 }).wallKey);
    await act(async () => {
      setThresholdInputOn(slider(), "250");
    });
    expect(slider().value).toBe("250");
    expect(lastRules()).toMatchObject({ absorbedPercent: 250 });
    await act(async () => { root.render(<Harness instrumentIdentity={BTC} />); });
    expect(slider().value).toBe("200");
    expect(lastRules()).toMatchObject({ absorbedPercent: 200, bandRows: 10 });
    expect(lastRules()?.wallKey).toBe(absorptionRulesFor(BTC).wallKey);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    expect(slider().value).toBe("250");
    expect(lastRules()).toMatchObject({ absorbedPercent: 250, bandRows: 7 });
    // The hourly chart bands eight times as wide and waits a cell of the bar; the numbers are the instrument's.
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={3_600_000} />); });
    expect(lastRules()).toMatchObject({ absorbedPercent: 250, bandRows: 56, quietMs: 450_000 });
  });

  it("hands the chart no rules while Prime Absorption is hidden, so its history stops asking the host and its badge goes, and the rules again once it is shown", async () => {
    // 2026-10-08: with the indicator hidden the chart still held the rules, the week kept loading and the badge stayed.
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Prime Absorption"); });
    expect(lastRules()).toMatchObject({ absorbedPercent: 200 });
    await act(async () => { rowIcon(container, "Prime Absorption", "Hide indicator").click(); });
    expect(lastRules()).toBeNull();
    await act(async () => { rowIcon(container, "Prime Absorption", "Show indicator").click(); });
    expect(lastRules()).toMatchObject({ absorbedPercent: 200 });
  });
});

describe("MainPanel -- Exhaustion candle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem("terminal.indicators.favorites");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY);
  });

  const ETH: InstrumentIdentity = { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" };
  const lastCandle = () => chartHandle.setExhaustionCandle.mock.calls.at(-1)![0] as number | null;

  it("hands the chart every candle monitor frame and the instrument's unit with the settings; the chart draws the monitor", async () => {
    const now = Date.now();
    const frame: CandleMonitorFrame = { type: "candle_monitor", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: now, entries: [{ candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 3, sell: 7, biggestBuy: null, biggestSell: null }] };
    const arrival: CandleMonitorArrival = { frame, receivedAt: now };
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} candleMonitor={arrival} />);
    });
    expect(chartHandle.applyCandleMonitor.mock.calls.at(-1)![0]).toBe(arrival);
    expect(chartHandle.setExhaustionSettings.mock.calls.at(-1)!.slice(1)).toEqual(["ETH"]);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} candleMonitor={null} />);
    });
    expect(chartHandle.applyCandleMonitor.mock.calls.at(-1)![0]).toBeNull();
    expect(container.querySelector(".candle-monitor")).toBeNull();
  });

  it("asks the runtime for the history span the setting names once the indicator is on and the runtime has answered, again for a new runtime, never with History Off", async () => {
    const asks: number[] = [];
    const book = new ExhaustionBook();
    book.apply({ type: "exhaustion_shades", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: 1_700_000_000_000, seq: 0, reset: true, shades: [], liveSince: 1_699_990_000_000, loading: null });
    const before = Date.now();
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} exhaustions={book} requestExhaustionHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toEqual([]);
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Exhaustion"); });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toBeGreaterThanOrEqual(before - 86_400_000);
    expect(asks[0]).toBeLessThanOrEqual(Date.now() - 86_400_000);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} exhaustions={book} requestExhaustionHistory={(fromTs) => asks.push(fromTs)} status="closed" />);
    });
    expect(asks).toHaveLength(1);
    const restarted = new ExhaustionBook();
    restarted.apply({ type: "exhaustion_shades", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: 1_700_000_500_000, seq: 0, reset: true, shades: [], liveSince: 1_700_000_400_000, loading: null });
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} exhaustions={restarted} requestExhaustionHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toHaveLength(2);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} exhaustions={null} requestExhaustionHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toHaveLength(2);
  });

  it("hands the chart the candle length the runtime's engine runs on for the chart's interval, null where there is none, and the saved settings", async () => {
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    expect(lastCandle()).toBe(60_000);
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Exhaustion"); });
    expect(lastCandle()).toBe(60_000);
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={15 * 60_000} />); });
    expect(lastCandle()).toBe(15 * 60_000);
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={3_600_000} />); });
    expect(lastCandle()).toBe(3_600_000);
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={4 * 3_600_000} />); });
    expect(lastCandle()).toBe(4 * 3_600_000);
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={7 * 60_000} />); });
    expect(lastCandle()).toBeNull();
    expect(chartHandle.setExhaustionSettings.mock.calls.at(-1)![0]).toEqual(DEFAULT_EXHAUSTION_SETTINGS);
    expect(chartHandle.applyExhaustions.mock.calls.at(-1)![0]).toBeNull();
  });

  it("an equity above 30m has no engine: the legend says so and the chart gets no candle length; at 30m and on a future's hour it does", async () => {
    const AAPL: InstrumentIdentity = { symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" };
    const NQ: InstrumentIdentity = { symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" };
    await act(async () => {
      root.render(<Harness instrumentIdentity={AAPL} intervalMs={3_600_000} exhaustions={new ExhaustionBook()} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Exhaustion"); });
    expect(lastCandle()).toBeNull();
    expect(container.querySelector(".indicator-legend-detail")?.textContent).toBe("no engine at this timeframe");
    await act(async () => { root.render(<Harness instrumentIdentity={AAPL} intervalMs={1_800_000} exhaustions={new ExhaustionBook()} />); });
    expect(lastCandle()).toBe(1_800_000);
    expect(container.querySelector(".indicator-legend-detail")?.textContent).not.toBe("no engine at this timeframe");
    await act(async () => { root.render(<Harness instrumentIdentity={NQ} intervalMs={3_600_000} exhaustions={new ExhaustionBook()} />); });
    expect(lastCandle()).toBe(3_600_000);
  });

  it("the legend counts the shades the chart draws for its candle and settings, as shown, not every shade in the book", async () => {
    const now = Date.now();
    const base = {
      candleMs: 60_000 as const, side: "buyers" as const, status: "held" as const, intensity: 2, score: 5,
      readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: true },
      values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
      raw: { own: 3, other: 7, legOwn: 14, moved: 0, legMoved: 1.8, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 as const },
      startTs: now - 120_000, endTs: now - 60_000, extremeTs: now - 180_000, extremePrice: 108, legStartTs: now - 600_000, legStartPrice: 100,
      legSize: 8, efficiency: 1, atr: 1, judgedAt: now - 60_000, updatedAt: now - 60_000, origin: "runtime" as const,
    };
    const book = new ExhaustionBook();
    book.apply({
      type: "exhaustion_shades", symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: now, seq: 0, reset: true, liveSince: now - 3_600_000, loading: null,
      shades: [
        { ...base, id: "held" },
        { ...base, id: "broke", status: "broke" },
        { ...base, id: "weak", score: 3 },
        { ...base, id: "5m", candleMs: 300_000 },
        { ...base, id: "old", endTs: now - 3 * 86_400_000, origin: "host" },
      ],
    });
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} exhaustions={book} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Exhaustion"); });
    expect(container.querySelector(".indicator-legend-detail")?.textContent).toBe("2 shown");
  });
});

describe("MainPanel -- Initiative Continuation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem("terminal.indicators.favorites");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY);
  });

  const ETH: InstrumentIdentity = { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" };
  const lastCandle = () => chartHandle.setInitiativeCandle.mock.calls.at(-1)![0] as number | null;
  const pageOf = (bands: InitiativeBand[], ts: number, liveSince: number) => ({ type: "initiative_bands" as const, symbol: "ETH-USDT", provider: "BINANCE" as const, marketKind: "PERPETUAL" as const, ts, seq: 0, reset: true, bands, liveSince, loading: null });

  it("asks the runtime for the history span the setting names once the indicator is on and the runtime has answered, again for a new runtime, never with History Off", async () => {
    const asks: number[] = [];
    const book = new InitiativeBook();
    book.apply(pageOf([], 1_700_000_000_000, 1_699_990_000_000));
    const before = Date.now();
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} initiatives={book} requestInitiativeHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toEqual([]);
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Initiative Continuation"); });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toBeGreaterThanOrEqual(before - 86_400_000);
    expect(asks[0]).toBeLessThanOrEqual(Date.now() - 86_400_000);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} initiatives={book} requestInitiativeHistory={(fromTs) => asks.push(fromTs)} status="closed" />);
    });
    expect(asks).toHaveLength(1);
    const restarted = new InitiativeBook();
    restarted.apply(pageOf([], 1_700_000_500_000, 1_700_000_400_000));
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} initiatives={restarted} requestInitiativeHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toHaveLength(2);
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} initiatives={null} requestInitiativeHistory={(fromTs) => asks.push(fromTs)} />);
    });
    expect(asks).toHaveLength(2);
  });

  it("hands the chart the candle length the runtime's engine runs on, null where there is none and above 30m on an equity, the saved settings and the book", async () => {
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    expect(lastCandle()).toBe(60_000);
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Initiative Continuation"); });
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={15 * 60_000} />); });
    expect(lastCandle()).toBe(15 * 60_000);
    await act(async () => { root.render(<Harness instrumentIdentity={ETH} intervalMs={7 * 60_000} />); });
    expect(lastCandle()).toBeNull();
    expect(container.querySelector(".indicator-legend-detail")?.textContent).toBe("no engine at this timeframe");
    expect(chartHandle.setInitiativeSettings.mock.calls.at(-1)![0]).toEqual(DEFAULT_INITIATIVE_SETTINGS);
    expect(chartHandle.applyInitiatives.mock.calls.at(-1)![0]).toBeNull();
    const AAPL: InstrumentIdentity = { symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" };
    await act(async () => { root.render(<Harness instrumentIdentity={AAPL} intervalMs={3_600_000} initiatives={new InitiativeBook()} />); });
    expect(lastCandle()).toBeNull();
    await act(async () => { root.render(<Harness instrumentIdentity={AAPL} intervalMs={1_800_000} initiatives={new InitiativeBook()} />); });
    expect(lastCandle()).toBe(1_800_000);
  });

  it("the legend counts the bands the chart draws for its candle and settings, as shown, not every band in the book", async () => {
    const now = Date.now();
    const base: InitiativeBand = {
      id: "b", candleMs: 60_000, side: "up", dominant: "buyers", dominantShare: 0.9, score: 4,
      facts: { efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: 1.667 }, delta: { yes: true, rank: 0.85, share: 0.9 }, prints: { yes: true, rank: 1, perCandle: 1 } },
      pivotTs: now - 300_000, pivotPrice: 100, frozenTs: now - 120_000, frozenPrice: 108, windowCandles: 3, atr: 1,
      legExtremePrice: 110, legExtremeTs: now - 60_000, legEndTs: null, updatedAt: now - 60_000, origin: "runtime",
    };
    const book = new InitiativeBook();
    book.apply(pageOf([
      { ...base, id: "strong" },
      { ...base, id: "weak", score: 2 },
      { ...base, id: "5m", candleMs: 300_000 },
      { ...base, id: "old", frozenTs: now - 3 * 86_400_000, pivotTs: now - 3 * 86_400_000 - 180_000, origin: "host" },
      { ...base, id: "host", origin: "host" },
    ], now, now - 3_600_000));
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} initiatives={book} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Initiative Continuation"); });
    expect(container.querySelector(".indicator-legend-detail")?.textContent).toBe("2 shown");
  });
});

describe("MainPanel -- live range control", () => {
  const LABEL = "Live Range Control";
  const BTC: InstrumentIdentity = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" };
  const ETH: InstrumentIdentity = { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" };
  const NQ: InstrumentIdentity = { symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE" };
  const AAPL: InstrumentIdentity = { symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" };
  const KEY = instrumentKey(BTC);
  const NOW = Date.UTC(2026, 9, 17, 2, 35, 20);
  const CRYPTO = { ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 5 };
  let container: HTMLDivElement;
  let root: Root;
  let liquidity: LiquidityGrid;

  beforeEach(() => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem(LIVE_RANGE_WINDOW_STORAGE_KEY);
    chartHandle.applyLiveRange.mockClear();
    chartHandle.setLiveRangeSettings.mockClear();
    chartHandle.setLiveRangeWindow.mockClear();
    liquidity = new LiquidityGrid();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY);
    localStorage.removeItem(LIVE_RANGE_WINDOW_STORAGE_KEY);
  });

  const detail = () => legendSnapshot(container)[LABEL]?.detail;
  const dialog = () => document.querySelector<HTMLElement>('[aria-label="Live Range Control settings"]');
  const field = (label: string) => dialog()!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const tab = (name: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;

  async function turnOn(): Promise<void> {
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, LABEL); });
  }

  async function openDialog(): Promise<void> {
    await act(async () => { rowIcon(container, LABEL, "Indicator settings").click(); });
  }

  it("hands the chart nothing until it is on, then the live grid, the settings of the instrument with its own big print and unit, and the window, and its legend says it reads the candles on screen", async () => {
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await openIndicatorsMenu(container);
    expect(chartHandle.applyLiveRange).toHaveBeenLastCalledWith(null);
    expect(legendSnapshot(container)[LABEL]).toBeUndefined();
    await act(async () => { clickIndicatorToggle(container, LABEL); });
    expect(chartHandle.applyLiveRange.mock.lastCall?.[0]).toBe(liquidity);
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith(CRYPTO, "BTC");
    expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(WHOLE_LIVE_RANGE_WINDOW);
    expect(detail()).toBe("the candles on screen");
  });

  it("hiding it with the legend eye or with Show on chart in its dialog takes the grid off the chart, and showing it hands the grid back", async () => {
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await turnOn();
    expect(chartHandle.applyLiveRange.mock.lastCall?.[0]).toBe(liquidity);
    await act(async () => { rowIcon(container, LABEL, "Hide indicator").click(); });
    expect(chartHandle.applyLiveRange).toHaveBeenLastCalledWith(null);
    expect(legendSnapshot(container)[LABEL]?.hidden).toBe(true);
    await act(async () => { rowIcon(container, LABEL, "Show indicator").click(); });
    expect(chartHandle.applyLiveRange.mock.lastCall?.[0]).toBe(liquidity);
    await openDialog();
    expect(dialog()!.querySelectorAll('[role="tab"]')).toHaveLength(2);
    await act(async () => { tab("Visibility").click(); });
    const onChart = () => field("Show on chart");
    expect(onChart().checked).toBe(true);
    await act(async () => { onChart().click(); });
    expect(chartHandle.applyLiveRange).toHaveBeenLastCalledWith(null);
    expect(onChart().checked).toBe(false);
    expect(legendSnapshot(container)[LABEL]?.hidden).toBe(true);
    await act(async () => { onChart().click(); });
    expect(chartHandle.applyLiveRange.mock.lastCall?.[0]).toBe(liquidity);
    expect(onChart().checked).toBe(true);
  });

  it("a colour set in its dialog reaches the chart and is kept for the instrument, another instrument has its own, and a fresh mount brings the colours of the instrument back", async () => {
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    await turnOn();
    await openDialog();
    await act(async () => { tab("Visibility").click(); });
    await act(async () => { setThresholdInputOn(field("Bid colour"), "#112233"); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...CRYPTO, bidColor: "#112233" }, "BTC");
    const saved = JSON.parse(localStorage.getItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY) ?? "{}");
    expect(saved.liveRangeByInstrument).toEqual({ [KEY]: { ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#112233" } });
    await act(async () => { root.render(<Harness liquidity={liquidity} instrumentIdentity={ETH} />); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith(CRYPTO, "ETH");
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...CRYPTO, bidColor: "#112233" }, "BTC");
    act(() => root.unmount());
    chartHandle.setLiveRangeSettings.mockClear();
    root = createRoot(container);
    await act(async () => { root.render(<Harness liquidity={liquidity} />); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...CRYPTO, bidColor: "#112233" }, "BTC");
    expect(detail()).toBe("the candles on screen");
  });

  it("hands the chart the big print of the slider, or the default of the kind of instrument, in its own unit: coins, contracts or shares", async () => {
    await act(async () => { root.render(<Harness liquidity={liquidity} instrumentIdentity={NQ} />); });
    await turnOn();
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 10 }, "contracts");
    await openDialog();
    const slider = field("Big print from");
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(["1", "300", "1", "10"]);
    await act(async () => { setThresholdInputOn(slider, "25"); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 25 }, "contracts");
    expect(dialog()!.textContent).toContain("Big print from 25 contracts");
    await act(async () => { root.render(<Harness liquidity={liquidity} instrumentIdentity={AAPL} />); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 5_000 }, "shares");
    await act(async () => { root.render(<Harness liquidity={liquidity} instrumentIdentity={NQ} />); });
    expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 25 }, "contracts");
  });

  it("in the zone modes its legend names the window, and the window goes to the chart and is kept for every instrument across a reload", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} />); });
      await turnOn();
      await openDialog();
      await act(async () => { field("Mode Live").click(); });
      expect(chartHandle.setLiveRangeSettings).toHaveBeenLastCalledWith({ ...CRYPTO, rangeMode: "live" }, "BTC");
      expect(detail()).toBe("since 10 Oct 02:35 UTC");
      await act(async () => { setThresholdInputOn(field("Window start"), String(10_081 - 10_021)); });
      const live = { fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: null };
      expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(live);
      expect(detail()).toBe("since 01:36 UTC");
      expect(JSON.parse(localStorage.getItem(LIVE_RANGE_WINDOW_STORAGE_KEY) ?? "null")).toEqual(live);
      await act(async () => { field("Mode Selected zone").click(); });
      await act(async () => { setThresholdInputOn(field("Window end"), "10051"); });
      const fixed = { fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: Date.UTC(2026, 9, 17, 2, 6) };
      expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(fixed);
      expect(detail()).toBe("01:36 → 02:06 UTC");
      await act(async () => { field("Mode Live").click(); });
      expect(detail()).toBe("since 01:36 UTC");
      expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(fixed);
      await act(async () => { field("Mode Selected zone").click(); });
      chartHandle.setLiveRangeWindow.mockClear();
      await act(async () => { root.render(<Harness liquidity={liquidity} instrumentIdentity={ETH} />); });
      expect(chartHandle.setLiveRangeWindow).not.toHaveBeenCalled();
      expect(detail()).toBe("the candles on screen");
      act(() => root.unmount());
      root = createRoot(container);
      await act(async () => { root.render(<Harness liquidity={liquidity} />); });
      expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(fixed);
      expect(detail()).toBe("01:36 → 02:06 UTC");
    } finally {
      clock.mockRestore();
    }
  });

  it("takes the window its zone lines were dragged to on the chart, keeps it, hands it back to the chart and names it in the legend and the dialog", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} />); });
      await turnOn();
      await openDialog();
      await act(async () => { field("Mode Selected zone").click(); });
      const dragged = { fromMs: Date.UTC(2026, 9, 17, 1, 0), toMs: Date.UTC(2026, 9, 17, 2, 0) };
      await act(async () => { capturedChartPanelProps.onLiveRangeWindowChange?.(dragged); });
      expect(chartHandle.setLiveRangeWindow).toHaveBeenLastCalledWith(dragged);
      expect(JSON.parse(localStorage.getItem(LIVE_RANGE_WINDOW_STORAGE_KEY) ?? "null")).toEqual(dragged);
      expect(detail()).toBe("01:00 → 02:00 UTC");
      expect(dialog()!.textContent).toContain("Window 01:00 → 02:00 UTC · 60 min");
    } finally {
      clock.mockRestore();
    }
  });

  it("with no grid its legend says reconnecting while the feed is not open and waiting for the book while it is", async () => {
    await act(async () => { root.render(<Harness liquidity={null} status="connecting" />); });
    await turnOn();
    expect(detail()).toBe("reconnecting");
    expect(chartHandle.applyLiveRange).toHaveBeenLastCalledWith(null);
    await act(async () => { root.render(<Harness liquidity={null} status="open" />); });
    expect(detail()).toBe("waiting for the book");
    await act(async () => { root.render(<Harness liquidity={null} status="closed" />); });
    expect(detail()).toBe("reconnecting");
    await act(async () => { root.render(<Harness liquidity={liquidity} status="open" />); });
    expect(detail()).toBe("the candles on screen");
    expect(chartHandle.applyLiveRange.mock.lastCall?.[0]).toBe(liquidity);
  });
});

function setThresholdInputOn(input: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MainPanel -- presets on the per-instrument L2 dialogs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem("terminal.indicators.favorites");
    indicatorPresets.refresh();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY);
  });

  const ETH: InstrumentIdentity = { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" };

  async function saveFromDialogOf(label: string, name: string) {
    await act(async () => { rowIcon(container, label, "Indicator settings").click(); });
    const presetsButton = container.querySelector<HTMLButtonElement>(".indicator-settings-modal .indicator-settings-defaults");
    expect(presetsButton, `${label} has a presets button`).not.toBeNull();
    await act(async () => { presetsButton!.click(); });
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".indicator-presets-item")].find((item) => item.textContent === "Save as preset…")!.click(); });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  }

  it("Prime Absorption, Exhaustion, the Iceberg Detector and Initiative Continuation keep a preset saved on the live chart under the instrument on screen", async () => {
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    await openIndicatorsMenu(container);
    const labels = ["Prime Absorption", "Exhaustion", "Iceberg Detector", "Initiative Continuation"];
    for (const label of labels) await act(async () => { clickIndicatorToggle(container, label); });
    for (const label of labels) await saveFromDialogOf(label, "Mine");
    const stored = JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const key = instrumentKey(ETH);
    expect(Object.keys(stored).sort()).toEqual([`absorptionDetector@${key}`, `exhaustion@${key}`, `icebergDetector@${key}`, `initiative@${key}`]);
  });

  it("Live Range Control keeps a preset saved on the live chart under the instrument on screen", async () => {
    await act(async () => {
      root.render(<Harness instrumentIdentity={ETH} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => { clickIndicatorToggle(container, "Live Range Control"); });
    await saveFromDialogOf("Live Range Control", "Mine");
    const stored = JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([`liveRangeControl@${instrumentKey(ETH)}`]);
  });
});

describe("Aggressive Orders history follows the chart back", () => {
  it("asks for the last few hours on its own, and for the piece before what it has once the chart shows older bars", async () => {
    let emitVisibleRange: ((fromMs: number, toMs: number) => void) | null =
      null;
    chartHandle.subscribeVisibleRangeChange.mockImplementation(
      (cb: (f: number, t: number) => void) => {
        emitVisibleRange = cb;
        return () => {
          emitVisibleRange = null;
        };
      },
    );
    const requests: { from_ts: number; to_ts: number; min_size: number }[] = [];
    const tape = new AggressiveTape();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          status="open"
          aggressiveTape={tape}
          requestAggressiveHistory={(request) => requests.push(request)}
        />,
      );
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, "Aggressive Orders");
    });
    expect(requests).toHaveLength(1);
    const first = requests[0];
    expect(first.to_ts - first.from_ts).toBe(HISTORY_MIN_MS);
    tape.coverHistory(first.from_ts, first.to_ts, first.min_size);

    const day = 24 * 60 * 60 * 1000;
    await act(async () => {
      emitVisibleRange?.(Date.now() - 3 * day, Date.now());
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      from_ts: first.from_ts - HISTORY_ASK_MAX_MS,
      to_ts: first.from_ts,
      min_size: first.min_size,
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("MainPanel -- the print store reaches the indicators, not just the bubbles", () => {
  it("hands the tape to ctx.ticks even with Aggressive Orders off the chart", async () => {
    chartHandle.applyAggressiveTape.mockClear();
    chartHandle.applyTicks.mockClear();
    const tape = new AggressiveTape();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness status="open" aggressiveTape={tape} />);
    });
    // Nothing is enabled, so the bubbles get no tape at all -- but the store is
    // still handed over, because hiding an indicator must not take the prints
    // away from the ones that price volume by them.
    expect(chartHandle.applyAggressiveTape).toHaveBeenCalledWith(null);
    expect(chartHandle.applyTicks).toHaveBeenCalledWith(tape);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("MainPanel -- band history driver", () => {
  const LABEL = "Institutional Order Blocks";
  const WANT = {
    key: "k",
    fromTs: 0,
    toTs: 200_000,
    priceLo: 10,
    priceHi: 12,
    columnMs: 10_000,
  };

  it("retries an unanswered band request even when no live liquidity frame arrives", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new BandHistoryStore();
    const requestBandHistory = vi.fn();
    chartHandle.bandHistoryWants.mockReturnValue([WANT]);
    const intervalSpy = vi.spyOn(window, "setInterval");
    const nowSpy = vi.spyOn(Date, "now");
    const startedAt = Date.now();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <Harness
            bandHistory={store}
            requestBandHistory={requestBandHistory}
          />,
        );
      });
      await openIndicatorsMenu(container);
      await act(async () => {
        clickIndicatorToggle(container, LABEL);
      });
      expect(requestBandHistory).toHaveBeenCalledTimes(1);
      const tick = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 5_000,
      )?.[0];
      expect(typeof tick).toBe("function");
      nowSpy.mockReturnValue(startedAt + BAND_PENDING_MS + 5_000);
      await act(async () => {
        (tick as () => void)();
      });
      expect(requestBandHistory).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(
        startedAt + BAND_PENDING_MS + BAND_RETRY_MS + 10_000,
      );
      await act(async () => {
        (tick as () => void)();
      });
      expect(requestBandHistory).toHaveBeenCalledTimes(2);
      expect(requestBandHistory.mock.calls[1][0].request_id).not.toBe(
        requestBandHistory.mock.calls[0][0].request_id,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      intervalSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it("hands the store to the chart while the indicator is on, asks the host for what the indicators want, and lets go when hidden", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new BandHistoryStore();
    const requestBandHistory = vi.fn();
    chartHandle.bandHistoryWants.mockReturnValue([WANT]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness bandHistory={store} requestBandHistory={requestBandHistory} />,
      );
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(null);
    expect(requestBandHistory).not.toHaveBeenCalled();
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, LABEL);
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(store);
    expect(store.get("k")).not.toBeNull();
    expect(requestBandHistory).toHaveBeenCalledTimes(1);
    expect(requestBandHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from_ts: 0,
        to_ts: 200_000,
        price_lo: 10,
        price_hi: 12,
        column_ms: 10_000,
      }),
    );
    expect(store.pending).toBe(1);
    chartHandle.bandHistoryWants.mockReturnValue([]);
    await act(async () => {
      root.render(
        <Harness
          bandHistory={store}
          bandHistoryVersion={1}
          requestBandHistory={requestBandHistory}
        />,
      );
    });
    expect(store.get("k")).toBeNull();
    expect(requestBandHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      rowIcon(container, LABEL, "Hide indicator").click();
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(null);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("drives the band store for Session Levels on its own: hands it to the chart, asks what it wants, lets go when hidden", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new BandHistoryStore();
    const requestBandHistory = vi.fn();
    chartHandle.bandHistoryWants.mockReturnValue([WANT]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness bandHistory={store} requestBandHistory={requestBandHistory} />,
      );
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(null);
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, "Session Levels");
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(store);
    expect(store.get("k")).not.toBeNull();
    expect(requestBandHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      rowIcon(container, "Session Levels", "Hide indicator").click();
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(null);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("applies the band store at once when it or the indicator changes, and folds the version bumps of a stream of pages into one apply every two seconds", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new BandHistoryStore();
    chartHandle.bandHistoryWants.mockReturnValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const applies = () => chartHandle.applyBandHistory.mock.calls.length;
    await act(async () => {
      root.render(<Harness bandHistory={store} />);
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, LABEL);
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(store);
    const base = applies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      for (const version of [1, 2, 3]) {
        await act(async () => {
          vi.advanceTimersByTime(100);
          root.render(<Harness bandHistory={store} bandHistoryVersion={version} />);
        });
      }
      expect(applies()).toBe(base);
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(applies()).toBe(base + 1);
      expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(store);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        root.render(<Harness bandHistory={store} bandHistoryVersion={4} />);
      });
      expect(applies()).toBe(base + 2);
      const beforeStream = applies();
      for (let version = 10; version < 16; version += 1) {
        await act(async () => {
          vi.advanceTimersByTime(900);
          root.render(<Harness bandHistory={store} bandHistoryVersion={version} />);
        });
      }
      expect(applies() - beforeStream).toBe(2);
      const other = new BandHistoryStore();
      const beforeSwap = applies();
      await act(async () => {
        root.render(<Harness bandHistory={other} bandHistoryVersion={16} />);
      });
      expect(applies()).toBe(beforeSwap + 1);
      expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(other);
      await act(async () => {
        rowIcon(container, LABEL, "Hide indicator").click();
      });
      expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(null);
      expect(applies()).toBe(beforeSwap + 2);
      await act(async () => {
        rowIcon(container, LABEL, "Show indicator").click();
      });
      expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(other);
      expect(applies()).toBe(beforeSwap + 3);
    } finally {
      vi.useRealTimers();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("does not ask the host while the socket is not open", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new BandHistoryStore();
    const requestBandHistory = vi.fn();
    chartHandle.bandHistoryWants.mockReturnValue([WANT]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          status="connecting"
          bandHistory={store}
          requestBandHistory={requestBandHistory}
        />,
      );
    });
    await openIndicatorsMenu(container);
    await act(async () => {
      clickIndicatorToggle(container, LABEL);
    });
    expect(chartHandle.applyBandHistory).toHaveBeenLastCalledWith(store);
    expect(requestBandHistory).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("MainPanel -- live delta profile driver", () => {
  const LABEL = "Live Delta Profile";

  it("sets the default window on the store (the last half hour on a 1m chart) and asks the host once the recorder has had time to write, only while the indicator is on", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const store = new DeltaProfileStore(1);
    const requestDeltaProfile = vi.fn();
    const intervalSpy = vi.spyOn(window, "setInterval");
    const clearSpy = vi.spyOn(window, "clearInterval");
    const nowSpy = vi.spyOn(Date, "now");
    const startedAt = Date.parse("2026-09-26T15:40:00Z");
    nowSpy.mockReturnValue(startedAt);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness deltaProfile={store} requestDeltaProfile={requestDeltaProfile} />); });
      expect(store.windowFrom).toBeNull();
      await openIndicatorsMenu(container);
      expect(chartHandle.applyDeltaProfile).toHaveBeenLastCalledWith(null);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(chartHandle.applyDeltaProfile).toHaveBeenLastCalledWith(store);
      expect(chartHandle.setLiveDeltaSettings).toHaveBeenCalled();
      expect(store.windowFrom).toBe(Date.parse("2026-09-26T15:00:00Z"));
      expect(store.liveFrom).toBe(startedAt);
      expect(requestDeltaProfile).not.toHaveBeenCalled();
      const index = intervalSpy.mock.calls.findIndex(([, delay]) => delay === 5_000);
      const tick = intervalSpy.mock.calls[index]?.[0];
      expect(typeof tick).toBe("function");
      nowSpy.mockReturnValue(startedAt + DELTA_ASK_DELAY_MS);
      await act(async () => { (tick as () => void)(); });
      expect(requestDeltaProfile).toHaveBeenCalledTimes(1);
      expect(requestDeltaProfile.mock.calls[0][0]).toMatchObject({ from_ts: Date.parse("2026-09-26T15:00:00Z"), to_ts: startedAt, row_width: 1 });
      await act(async () => { (tick as () => void)(); });
      expect(requestDeltaProfile).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(startedAt + 24 * 60 * 60_000);
      await act(async () => { (tick as () => void)(); });
      expect(store.windowFrom).toBe(Date.parse("2026-09-27T15:00:00Z"));
      expect(store.rows()).toEqual([]);
      const timer = intervalSpy.mock.results[index]?.value;
      expect(clearSpy).not.toHaveBeenCalledWith(timer);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect(chartHandle.applyDeltaProfile).toHaveBeenLastCalledWith(null);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});

describe("MainPanel -- Live Delta Profile and Volume Profile (Ticks) share one request channel", () => {
  it("never has two delta_profile jobs out at once, hands the channel over when one finishes, and starts the tick profile from the range on screen", async () => {
    // The host serves one delta_profile job per connection and cancels the older
    // one without a reply, so the two drivers must take turns.
    localStorage.setItem("terminal.indicators.favorites", JSON.stringify(["liveDeltaProfile", "volumeDeltaProfileTick"]));
    const startedAt = Date.parse("2026-09-26T15:40:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const intervalSpy = vi.spyOn(window, "setInterval");
    // The chart has a range on screen and never reports a change of it.
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: startedAt - 20 * 60_000, toMs: startedAt });
    const live = new DeltaProfileStore(1);
    const tick = new DeltaProfileStore(1, DELTA_REQUEST_ID_STRIDE);
    const requests: DeltaProfileRequest[] = [];
    const requestDeltaProfile = vi.fn((request: DeltaProfileRequest) => { requests.push(request); });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const harness = (liveVersion: number, tickVersion: number) => (
      <Harness
        deltaProfile={live}
        deltaProfileVersion={liveVersion}
        deltaTickProfile={tick}
        deltaTickProfileVersion={tickVersion}
        requestDeltaProfile={requestDeltaProfile}
      />
    );
    try {
      await act(async () => { root.render(harness(0, 0)); });
      // Seeded from the range on screen, with no range event at all.
      expect(tick.windowFrom).toBe(startedAt - 20 * 60_000);
      nowSpy.mockReturnValue(startedAt + DELTA_ASK_DELAY_MS);
      const ticks = intervalSpy.mock.calls.filter(([, delay]) => delay === 5_000).map(([fn]) => fn as () => void);
      await act(async () => { for (const run of ticks) run(); });
      expect(requests).toHaveLength(1);
      expect([live.pending, tick.pending].filter(Boolean)).toHaveLength(1);
      const [first, waiting] = live.pending ? [live, tick] : [tick, live];

      // More ticks while the job is out ask nothing more.
      await act(async () => { for (const run of ticks) run(); });
      expect(requests).toHaveLength(1);

      // The host answers the job in full: the other driver asks at once.
      const asked = requests[0];
      expect(first.put({
        type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: asked.request_id, from_ts: asked.from_ts, to_ts: asked.to_ts,
        row_width: 1, rows: [], complete: true, pending: 0,
      } as never, startedAt + DELTA_ASK_DELAY_MS)).toBe(true);
      expect(first.pending).toBe(false);
      await act(async () => { root.render(first === live ? harness(1, 0) : harness(0, 1)); });
      expect(requests).toHaveLength(2);
      expect(waiting.pending).toBe(true);
      expect(requests[1].request_id > DELTA_REQUEST_ID_STRIDE).toBe(waiting === tick);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      intervalSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });
});

describe("MainPanel -- aggressive orders profile", () => {
  const LABEL = "Aggressive Orders Profile";

  it("hands the chart the range print store while it is on, and keeps it wanting the week up to now with the range on screen as its focus, or back to the view when it is older, at the heatmap's floor, which the store keeps, the floor slider never moving it", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const gridAt = (printsFloor: number) => {
      const grid = new LiquidityGrid();
      grid.apply({
        type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
        columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]], prints: [], prints_floor: printsFloor }],
      });
      return grid;
    };
    const liquidity = gridAt(8.2);
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    let emitVisibleRange: ((fromMs: number, toMs: number) => void) | null = null;
    chartHandle.subscribeVisibleRangeChange.mockImplementation((cb: (fromMs: number, toMs: number) => void) => {
      emitVisibleRange = cb;
      return () => {
        emitVisibleRange = null;
      };
    });
    const store = new RangePrintStore();
    const askRangePrints = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const dialogText = () => document.querySelector('[aria-label="Aggressive Orders Profile settings"]')?.textContent ?? "";
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={askRangePrints} />); });
      await openIndicatorsMenu(container);
      expect(chartHandle.applyAggressiveProfilePrints).toHaveBeenLastCalledWith(null);
      expect(askRangePrints).not.toHaveBeenCalled();
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(chartHandle.applyAggressiveProfilePrints).toHaveBeenLastCalledWith(store);
      expect(store.floor).toBe(10);
      expect(RANGE_WARM_MS).toBe(7 * 86_400_000);
      expect(store.gaps()).toEqual([{ from: now - RANGE_WARM_MS, to: now }]);
      expect(askRangePrints).toHaveBeenCalled();
      await act(async () => { legendIcon(container, "Indicator settings").click(); });
      expect(dialogText()).toContain("Big print floor auto (the heatmap's, 10 BTC now)");
      expect(dialogText()).toContain("Starts at the heatmap's floor, 10 BTC.");
      const stops = floorStops(floorScaleFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }, 10), 10);
      const floorInput = document.querySelector<HTMLInputElement>('[aria-label="Aggressive Orders Profile settings"] input[aria-label="Big print floor"]')!;
      const setFloor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      const wants = vi.spyOn(store, "setWant");
      await act(async () => { setFloor.call(floorInput, String(floorPosition(stops, 15))); floorInput.dispatchEvent(new Event("input", { bubbles: true })); });
      expect(chartHandle.setAggressiveProfileSettings).toHaveBeenLastCalledWith({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
      expect(dialogText()).toContain("Big print floor 15 BTC");
      expect(floorInput.max).toBe(String(stops.length));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const older = { from: now - RANGE_WARM_MS - 7_200_000, to: now - RANGE_WARM_MS - 3_600_000 };
        await act(async () => { emitVisibleRange?.(older.from, older.to); });
        await act(async () => { vi.advanceTimersByTime(400); });
        expect(wants.mock.calls.at(-1)![0]).toEqual({ from: older.from, to: now, floor: 10, focus: { from: older.from, to: older.to + 60_000 } });
      } finally {
        vi.useRealTimers();
      }
      await act(async () => { root.render(<Harness liquidity={gridAt(3)} rangePrints={store} askRangePrints={askRangePrints} />); });
      expect(wants.mock.calls.at(-1)![0].floor).toBe(10);
      expect(wants.mock.calls.every(([want]) => want.floor === 10)).toBe(true);
      expect(store.floor).toBe(10);
      expect(dialogText()).toContain("Starts at the heatmap's floor, 10 BTC.");
      expect(store.gaps()).not.toEqual([]);
      await act(async () => { rowIcon(container, LABEL, "Hide indicator").click(); });
      expect(chartHandle.applyAggressiveProfilePrints).toHaveBeenLastCalledWith(null);
      expect(store.gaps()).toEqual([]);
      expect(store.nextRequest(now + 60_000)).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
      chartHandle.subscribeVisibleRangeChange.mockImplementation(() => () => {});
    }
  });

  it("says it is loading the view's prints in its legend until the store holds the whole view", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 8.2 }],
    });
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    const store = new RangePrintStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={() => {}} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("loading the view's prints");
      const ask = store.nextRequest(now + RANGE_ASK_DELAY_MS)!;
      expect([ask.from_ts, ask.to_ts]).toEqual([now - 3_600_000, now - 540_000]);
      store.put({ request_id: ask.request_id, from_ts: ask.from_ts, to_ts: ask.to_ts, min_size: ask.min_size, reason: null, next_cursor: null, retry_after_ms: null }, [], now + RANGE_ASK_DELAY_MS);
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("the candles on screen");
      await act(async () => { root.render(<Harness liquidity={new LiquidityGrid()} rangePrints={new RangePrintStore()} askRangePrints={() => {}} />); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("loading the view's prints");
    } finally {
      await act(async () => { root.unmount(); });
      vi.useRealTimers();
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });

  it("says some of the view's prints are missing in its legend when the store gave a stretch of the view up, and the candles on screen again once it holds them", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 8.2 }],
    });
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    const store = new RangePrintStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={() => {}} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      const ask = store.nextRequest(now + RANGE_ASK_DELAY_MS)!;
      store.put({ request_id: ask.request_id, from_ts: ask.from_ts, to_ts: ask.to_ts, min_size: ask.min_size, reason: "CONVERSION_INCOMPLETE", next_cursor: null, retry_after_ms: null }, [], now + RANGE_ASK_DELAY_MS);
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("some of the view's prints are missing");
      nowSpy.mockReturnValue(now + RANGE_GIVE_UP_MS + RANGE_ASK_DELAY_MS);
      const again = store.nextRequest(now + RANGE_GIVE_UP_MS + RANGE_ASK_DELAY_MS)!;
      expect([again.from_ts, again.to_ts]).toEqual([ask.from_ts, ask.to_ts]);
      store.put({ request_id: again.request_id, from_ts: again.from_ts, to_ts: again.to_ts, min_size: again.min_size, reason: null, next_cursor: null, retry_after_ms: null }, [], now + RANGE_GIVE_UP_MS + RANGE_ASK_DELAY_MS);
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("the candles on screen");
    } finally {
      await act(async () => { root.unmount(); });
      vi.useRealTimers();
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });

  it("waits for the heatmap's columns before the store's first want, so a pair switch never starts the store from the instrument's suggested floor", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 8.2 }],
    });
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    const store = new RangePrintStore();
    const askRangePrints = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness liquidity={null} rangePrints={store} askRangePrints={askRangePrints} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(store.floor).toBeNull();
      expect(askRangePrints).not.toHaveBeenCalled();
      nowSpy.mockReturnValue(now + 1_000);
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={askRangePrints} />); });
      expect(store.floor).toBe(10);
      expect(askRangePrints).toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });

  it("with no print in the heatmap's recent columns starts the store from its older columns, and from the instrument's suggested floor once START_FLOOR_WAIT_MS has passed with no columns at all", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 20_000, seq: 1, reset: true, row_width: 2, column_ms: 10_000,
      columns: [{ ts: now - 30_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 2.2 }, { ts: now - 20_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [], prints_floor: 1.9 }],
    });
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 2_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [] }, { ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints: [] }],
    });
    expect(liquidity.deepColumns.map((column) => column.ts)).toEqual([now - 30_000, now - 20_000]);
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    const store = new RangePrintStore();
    const bare = new RangePrintStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={() => {}} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(store.floor).toBe(2);
      await act(async () => { legendIcon(container, "Indicator settings").click(); });
      expect(document.querySelector('[aria-label="Aggressive Orders Profile settings"]')?.textContent).toContain("Starts at the heatmap's floor, 2 BTC.");
      expect(START_FLOOR_WAIT_MS).toBe(5_000);
      await act(async () => { root.render(<Harness liquidity={null} rangePrints={bare} askRangePrints={() => {}} instrumentIdentity={{ symbol: "/ESZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }} />); });
      expect(bare.floor).toBeNull();
      nowSpy.mockReturnValue(now + START_FLOOR_WAIT_MS - 1);
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS); });
      expect(bare.floor).toBeNull();
      nowSpy.mockReturnValue(now + START_FLOOR_WAIT_MS);
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS); });
      expect(bare.floor).toBe(10);
    } finally {
      await act(async () => { root.unmount(); });
      vi.useRealTimers();
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
    }
  });

  it("starts the store at the heatmap's floor with a hand floor saved, reads at the hand floor, and asks again every RANGE_POLL_MS", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    const btc = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" } as const;
    localStorage.setItem("terminal.live-indicators.extras.v1", JSON.stringify({
      aggressiveProfileByInstrument: { [instrumentKey(btc)]: { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 } },
    }));
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]], prints: [], prints_floor: 8.2 }],
    });
    chartHandle.getVisibleRangeMs.mockReturnValue({ fromMs: now - 3_600_000, toMs: now - 600_000 });
    const store = new RangePrintStore();
    const wants = vi.spyOn(store, "setWant");
    const askRangePrints = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} rangePrints={store} askRangePrints={askRangePrints} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(chartHandle.setAggressiveProfileSettings).toHaveBeenLastCalledWith({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
      expect(store.floor).toBe(10);
      expect(wants.mock.calls.length).toBeGreaterThan(0);
      expect(wants.mock.calls.every(([want]) => want.floor === 10)).toBe(true);
      const wanted = wants.mock.calls.length;
      const asked = askRangePrints.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(RANGE_POLL_MS - 1); });
      expect([wants.mock.calls.length, askRangePrints.mock.calls.length]).toEqual([wanted, asked]);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect([wants.mock.calls.length, askRangePrints.mock.calls.length]).toEqual([wanted + 1, asked + 1]);
      expect(wants.mock.calls.at(-1)![0]).toEqual({ from: now - RANGE_WARM_MS, to: now, floor: 10, focus: { from: now - 3_600_000, to: now - 540_000 } });
    } finally {
      vi.useRealTimers();
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      chartHandle.getVisibleRangeMs.mockReturnValue(null);
      localStorage.removeItem("terminal.live-indicators.extras.v1");
    }
  });

  it("hands the chart the live grid while it is on, its settings for the instrument, and says what it reads in its legend", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]], prints: [], prints_floor: 8.2 }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} />); });
      await openIndicatorsMenu(container);
      expect(chartHandle.applyAggressiveProfile).toHaveBeenLastCalledWith(null);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(chartHandle.applyAggressiveProfile).toHaveBeenLastCalledWith(liquidity);
      expect(chartHandle.setAggressiveProfileSettings).toHaveBeenLastCalledWith(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("the candles on screen");
      await act(async () => { rowIcon(container, LABEL, "Hide indicator").click(); });
      expect(chartHandle.applyAggressiveProfile).toHaveBeenLastCalledWith(null);
      await act(async () => { rowIcon(container, LABEL, "Show indicator").click(); });
      expect(chartHandle.applyAggressiveProfile).toHaveBeenLastCalledWith(liquidity);
      await act(async () => { legendIcon(container, "Indicator settings").click(); });
      const dialog = document.querySelector('[aria-label="Aggressive Orders Profile settings"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain("Starts at the heatmap's floor, 10 BTC.");
      const floor = dialog!.querySelector<HTMLInputElement>('input[aria-label="Big print floor"]')!;
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      const fifteen = String(floorPosition(floorStops(floorScaleFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }, 10), 10), 15));
      await act(async () => { setValue.call(floor, fifteen); floor.dispatchEvent(new Event("input", { bubbles: true })); });
      expect(chartHandle.setAggressiveProfileSettings).toHaveBeenLastCalledWith({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 });
      const saved = JSON.parse(localStorage.getItem("terminal.live-indicators.extras.v1") ?? "{}");
      expect(saved.aggressiveProfileByInstrument).toEqual({
        [instrumentKey({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" })]: { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 15 },
      });
      await act(async () => { root.render(<Harness liquidity={null} status="connecting" />); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("reconnecting");
      expect(chartHandle.applyAggressiveProfile).toHaveBeenLastCalledWith(null);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
    }
  });
});

describe("MainPanel -- live order book profile", () => {
  const LABEL = "Live Order Book Profile";

  it("shows the bands of the latest book in its legend, waits while the book is dead, and keeps its settings per instrument", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]] }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} />); });
      await openIndicatorsMenu(container);
      expect(chartHandle.applyOrderBookProfile).toHaveBeenLastCalledWith(null);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("3 rows");
      const source = chartHandle.applyOrderBookProfile.mock.lastCall?.[0];
      expect(source).toBeInstanceOf(BookProfileSource);
      expect(source.rowWidth).toBe(2);
      await act(async () => {
        root.render(<Harness liquidity={liquidity} book={{ type: "book", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", status: "READY", bids: [{ price: 209.9, size: 1 }], asks: [{ price: 212, size: 1 }] }} />);
      });
      expect(source.spread(now)).toEqual({ bidRow: 104, askRow: 106 });
      expect(chartHandle.setLiveOrderBookSettings).toHaveBeenLastCalledWith(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS);
      await act(async () => { legendIcon(container, "Indicator settings").click(); });
      const dialog = document.querySelector('[aria-label="Live Order Book Profile settings"]');
      expect(dialog).not.toBeNull();
      const own = Array.from(dialog!.querySelectorAll<HTMLInputElement>('input[name="live-order-book-row-size"]')).find((input) => input.nextElementSibling?.textContent === "2");
      await act(async () => { own!.click(); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("4 rows");
      expect(chartHandle.setLiveOrderBookSettings).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, rowFactor: 1 });
      await act(async () => { rowIcon(container, LABEL, "Hide indicator").click(); });
      expect(chartHandle.applyOrderBookProfile).toHaveBeenLastCalledWith(null);
      await act(async () => { rowIcon(container, LABEL, "Show indicator").click(); });
      expect(chartHandle.applyOrderBookProfile.mock.lastCall?.[0]).toBe(source);
      const saved = JSON.parse(localStorage.getItem("terminal.live-indicators.extras.v1") ?? "{}");
      expect(saved.liveOrderBookByInstrument).toEqual({
        [instrumentKey({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" })]: { ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, rowFactor: 1 },
      });
      nowSpy.mockReturnValue(now + 10_000);
      await act(async () => { root.render(<Harness liquidity={liquidity} intervalMs={300_000} />); });
      expect(legendSnapshot(container)[LABEL]?.detail).toBe("waiting for the book");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      localStorage.removeItem("terminal.live-indicators.extras.v1");
    }
  });
});

describe("MainPanel -- live order book profile depth", () => {
  const LABEL = "Live Order Book Profile";

  it("hands the Live Order Book Profile the L2 store's lanes, so the book goes as deep as the heatmap", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.removeItem("terminal.live-indicators.extras.v1");
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const liquidity = new LiquidityGrid();
    liquidity.apply({
      type: "liquidity", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", ts: now - 1_000, seq: 1, reset: true, row_width: 2, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]] }],
    });
    const l2 = new L2Store();
    const lane = parseServerFrame({
      type: "l2_view", provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT", lane: 1, tier: "recent", ts: now - 1_000, seq: 1, reset: true, row_width: 4, column_ms: 1_000,
      columns: [{ ts: now - 1_000, lo: 40, hi: 60, bid: [[0, 7]], ask: [[20, 9]] }], segment: { id: "SPOT:BTCUSDT:1000:LIVE", state: "LIVE" },
    });
    expect(l2.apply(lane as L2Frame)).toBe(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness liquidity={liquidity} l2={l2} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, LABEL); });
      const source = chartHandle.applyOrderBookProfile.mock.lastCall?.[0] as BookProfileSource;
      expect(source).toBeInstanceOf(BookProfileSource);
      // The finest column's four rows between 200 and 216, and the x2 lane's bid at 160 and ask at 240 beyond its window.
      expect(source.bands(1).map((band) => [band.price, band.bid, band.ask])).toEqual([[160, 7, 0], [200, 1, 0], [204, 3, 0], [210, 0, 4], [214, 0, 2], [240, 0, 9]]);
      expect(source.extent()).toEqual({ lowRow: 80, highRow: 121 });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      localStorage.removeItem("terminal.live-indicators.extras.v1");
    }
  });
});

describe("MainPanel -- live delta profile visible range", () => {
  it("in visible mode the window follows the chart's view once it settles, to the minute, open ended while the newest candle is in view", async () => {
    localStorage.removeItem("terminal.indicators.favorites");
    localStorage.setItem("terminal.live-indicators.extras.v1", JSON.stringify({
      liveDeltaByInstrument: { "BINANCE:SPOT:BTC-USDT": { ...DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, windowMode: "visible" } },
    }));
    let emitVisibleRange: ((fromMs: number, toMs: number) => void) | null = null;
    chartHandle.subscribeVisibleRangeChange.mockImplementation(
      (cb: (f: number, t: number) => void) => {
        emitVisibleRange = cb;
        return () => {
          emitVisibleRange = null;
        };
      },
    );
    const store = new DeltaProfileStore(1);
    const requestDeltaProfile = vi.fn();
    const nowSpy = vi.spyOn(Date, "now");
    const startedAt = Date.parse("2026-09-26T15:40:30Z");
    nowSpy.mockReturnValue(startedAt);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Harness deltaProfile={store} requestDeltaProfile={requestDeltaProfile} />); });
      await openIndicatorsMenu(container);
      await act(async () => { clickIndicatorToggle(container, "Live Delta Profile"); });
      expect(store.windowFrom).toBe(Date.parse("2026-09-26T00:00:00Z"));
      expect(emitVisibleRange).not.toBeNull();
      await act(async () => {
        emitVisibleRange!(Date.parse("2026-09-26T13:12:20Z"), Date.parse("2026-09-26T15:40:00Z"));
        emitVisibleRange!(Date.parse("2026-09-26T13:10:20Z"), Date.parse("2026-09-26T15:40:00Z"));
      });
      expect(store.windowFrom).toBe(Date.parse("2026-09-26T00:00:00Z"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      expect(store.windowFrom).toBe(Date.parse("2026-09-26T13:10:00Z"));
      expect(store.windowTo).toBeNull();
      expect(container.textContent).toContain("on screen");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      nowSpy.mockRestore();
      localStorage.removeItem("terminal.live-indicators.extras.v1");
    }
  });
});
