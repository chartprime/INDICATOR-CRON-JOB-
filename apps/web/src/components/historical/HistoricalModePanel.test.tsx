// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ArchivePageLoad } from "../../lib/archive/useArchivePage";
import { defaultLiveIndicatorExtras } from "../../lib/chart/liveIndicatorExtras";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The one indicator's user-visible label, which its tests match on. */
const SESSION_PROFILE_LABEL =
  "Session Volume Profile (Volume / Net Delta / Delta)";

const mocks = vi.hoisted(() => ({
  archiveLoad: { current: null as unknown },
  archiveCalls: [] as unknown[][],
  chartHandle: {
    applySnapshot: vi.fn(),
    setHistoricalRollMarkers: vi.fn(),
    setHistoricalIndicatorCapabilities: vi.fn(),
    setIndicators: vi.fn(),
    setIndicatorVisibility: vi.fn(),
    setIndicatorSettings: vi.fn(),
    setKillzoneSessions: vi.fn(),
    setSessionProfileSettings: vi.fn(),
    setLiquiditySettings: vi.fn(),
    setL2SupportResistanceSettings: vi.fn(),
    setL2BookMapSettings: vi.fn(),
    setWhaleHeatmapSettings: vi.fn(),
    setAggressiveSettings: vi.fn(),
    setAbsorptionSettings: vi.fn(),
    setAbsorptionRules: vi.fn(),
    setLiveOrderBookSettings: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(() => () => {}),
  },
  chartProps: { current: null as unknown },
  studyCalls: [] as Record<string, unknown>[],
  tradeAvailability: { current: false },
  l2Availability: { current: false },
  l2Sample: { current: undefined as undefined | { fromMs: number; toMs: number; date: string } },
  l2Calls: [] as Record<string, unknown>[],
  studyStatus: {
    current: {
      loading: false,
      issue: null as string | null,
      unsidedShare: null as number | null,
    },
  },
}));

vi.mock("../../lib/archive/useArchivePage", () => ({
  useArchivePage: (...args: unknown[]) => {
    mocks.archiveCalls.push(args);
    return mocks.archiveLoad.current;
  },
}));

vi.mock("../../lib/archive/useArchiveStudies", () => ({
  useArchiveStudies: (args: Record<string, unknown>) => {
    mocks.studyCalls.push(args);
    return mocks.studyStatus.current;
  },
}));

vi.mock("../../lib/archive/useArchiveTradeAvailability", () => ({
  useArchiveTradeAvailability: () => mocks.tradeAvailability.current,
}));
vi.mock("../../lib/archive/useHistoricalL2", () => ({
  useHistoricalL2: (args: Record<string, unknown>) => {
    mocks.l2Calls.push(args);
    return { available: mocks.l2Availability.current, wallsAvailable: mocks.l2Availability.current, printsAvailable: mocks.l2Availability.current,
      loading: false, issue: null, sample: mocks.l2Sample.current };
  },
}));

vi.mock("../chart/ChartPanel", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    ChartPanel: forwardRef(function MockChartPanel(props, ref) {
      mocks.chartProps.current = props;
      useImperativeHandle(ref, () => mocks.chartHandle);
      return <div data-testid="historical-chart-panel" />;
    }),
  };
});

const { HistoricalModePanel } = await import("./HistoricalModePanel");

let container: HTMLDivElement;
let root: Root;

function readyPage(): Extract<ArchivePageLoad, { state: "ready" }> {
  return {
    state: "ready",
    instrumentId: "btc-spot",
    timeframeId: "1D",
    resolution: "1d",
    loadingDirection: null,
    onVisibleLogicalRangeChange: vi.fn(),
    series: {
      bars: [
        {
          type: "bar",
          symbol: "BTCUSDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          interval_ms: 86_400_000,
          ts_open: 1_756_684_800_000,
          open: 100.25,
          high: 101.5,
          low: 99.75,
          close: 100.75,
          volume: 42.5,
          buy_volume: 23,
          trade_count: 318,
          closed: true,
        },
      ],
      metrics: [{ tsOpen: 1_756_684_800_000 }],
      capabilities: ["ohlcv", "buy_volume", "trade_count"],
      provider: "BINANCE",
    },
    page: {
      rows: [
        {
          open_ns: "1756684800000000000",
          close_ns: "1756771200000000000",
          open: "100.25",
          high: "101.50",
          low: "99.75",
          close: "100.75",
          volume: "42.50",
          buy_volume: "23.00",
          quote_volume: null,
          taker_buy_quote_volume: null,
          taker_sell_base_volume: null,
          taker_sell_quote_volume: null,
          trade_count: "318",
          closed: true,
        },
      ],
      pointerToken: "token",
      family: "candle_1d",
      coverage: {
        requested: { from: "1756684800000000000", to: "1756771200000000000" },
        served: null,
        partitions: 1,
        states: { PUBLISHED: 1 },
        corrupt: [],
      },
      scan: {},
      rollMarkers: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.archiveCalls = [];
  mocks.studyCalls = [];
  mocks.l2Calls = [];
  mocks.l2Availability.current = false;
  mocks.l2Sample.current = undefined;
  mocks.tradeAvailability.current = false;
  mocks.studyStatus.current = {
    loading: false,
    issue: null,
    unsidedShare: null,
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  mocks.archiveLoad.current = readyPage();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("HistoricalModePanel", () => {
  it("offers heatmap settings, uses top-ten defaults and preserves historical extras separately from live", async () => {
    localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify(["passiveLiquidity"]));
    localStorage.setItem("terminal.live-indicators.extras.v1", "live settings untouched");
    const saved = defaultLiveIndicatorExtras();
    localStorage.setItem("terminal.historical-indicators.extras.v1", JSON.stringify({ ...saved, l2BookMap: { ...saved.l2BookMap, minVolume: 42 } }));
    mocks.l2Availability.current = true;
    const page = readyPage();
    mocks.archiveLoad.current = { ...page, instrumentId: "es-continuous", timeframeId: "1D", series: { ...page.series, provider: "DATABENTO" } };
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const es = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")].find((button) => button.textContent?.includes("ES Continuous"))!;
    await act(async () => es.click());
    expect(mocks.chartHandle.setLiquiditySettings).toHaveBeenLastCalledWith(expect.objectContaining({ clusterRows: 1, quietBands: 0, minBandSize: 0 }));
    const settings = container.querySelector<HTMLButtonElement>('[aria-label="Indicator settings"]');
    expect(settings).not.toBeNull();
    await act(async () => settings!.click());
    expect(container.textContent).toContain("Top 10 levels only");
    expect(container.querySelector('[name="liquidity-history-days"]')).toBeNull();
    expect(localStorage.getItem("terminal.live-indicators.extras.v1")).toBe("live settings untouched");
    expect(JSON.parse(localStorage.getItem("terminal.historical-indicators.extras.v1")!).l2BookMap.minVolume).toBe(42);
  });
  it.each(["passiveLiquidity", "l2SupportResistance", "l2BookMap", "whaleLimitOrderHeatmap", "liveOrderBookProfile", "aggressiveOrders", "absorptionDetector"])(
    "opens the dedicated historical settings dialog for %s", async (id) => {
      localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify([id]));
      mocks.l2Availability.current = true;
      const page = readyPage();
      mocks.archiveLoad.current = { ...page, instrumentId: "es-continuous", timeframeId: "1D", series: { ...page.series, provider: "DATABENTO" } };
      await act(async () => root.render(<HistoricalModePanel />));
      await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
      const es = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")].find((button) => button.textContent?.includes("ES Continuous"))!;
      await act(async () => es.click());
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Indicator settings"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });
  it.each([
    ["passiveLiquidity", "passiveLiquidity@historical:es-continuous"],
    ["absorptionDetector", "absorptionDetector@historical:es-continuous"],
    ["sma", "sma@historical"],
  ])("keeps the presets of %s in Historical mode apart from the live ones", async (id, presetKey) => {
    localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify([id]));
    mocks.l2Availability.current = true;
    const page = readyPage();
    mocks.archiveLoad.current = { ...page, instrumentId: "es-continuous", timeframeId: "1D", series: { ...page.series, provider: "DATABENTO" } };
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const es = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")].find((button) => button.textContent?.includes("ES Continuous"))!;
    await act(async () => es.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Indicator settings"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".indicator-settings-defaults")!.click());
    const saveItem = [...container.querySelectorAll<HTMLButtonElement>(".indicator-presets-item")].find((button) => button.textContent === "Save as preset…")!;
    await act(async () => saveItem.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Past");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(Object.keys(JSON.parse(localStorage.getItem("terminal.indicator-presets.v1")!))).toEqual([presetKey]);
  });
  it("bounds the latest-depth shortcut to thirty UTC minutes even from daily candles", async () => {
    mocks.l2Availability.current = true;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const btc = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")].find((button) => button.textContent?.includes("BTC Spot"))!;
    await act(async () => btc.click());
    const last = readyPage().series.bars.at(-1)!;
    const jump = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Last 30m of depth"))!;
    await act(async () => jump.click());
    expect(mocks.archiveCalls.at(-1)?.[3]).toEqual({ fromMs: last.ts_open + last.interval_ms - 1800000, toMs: last.ts_open + last.interval_ms });
  });
  it("opens a catalog-qualified sample with one-minute candles and an explicit chart range", async () => {
    const fromMs = Date.parse("2026-08-05T13:30:00Z"), toMs = fromMs + 900000;
    await act(async () => root.render(<HistoricalModePanel />));
    expect(container.textContent).not.toContain("Open L2 sample");
    mocks.l2Sample.current = { fromMs, toMs, date: "2026-08-05" };
    await act(async () => root.render(<HistoricalModePanel />));
    const jump = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Open L2 sample"))!;
    await act(async () => jump.click());
    expect(mocks.archiveCalls.at(-1)?.[1]).toMatchObject({ id: "1m" });
    expect(mocks.archiveCalls.at(-1)?.[3]).toEqual({ fromMs, toMs });
    mocks.archiveLoad.current = { ...readyPage(), instrumentId: "btc-perpetual", timeframeId: "1m" };
    await act(async () => root.render(<HistoricalModePanel />));
    expect(mocks.chartHandle.applySnapshot).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ visibleRange: { fromMs, toMs: toMs - 60000 } }));
  });
  it("gives the absorption detector its rules on an intraday ES chart while it is shown, and none once it is hidden", async () => {
    localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify(["absorptionDetector"]));
    mocks.l2Availability.current = true;
    const page = readyPage();
    mocks.archiveLoad.current = { ...page, instrumentId: "es-continuous", timeframeId: "5m", series: { ...page.series, provider: "DATABENTO" } };
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const es = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")].find((button) => button.textContent?.includes("ES Continuous"))!;
    await act(async () => es.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click());
    const fiveMinute = [...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select")].find((button) => button.textContent === "5m")!;
    await act(async () => fiveMinute.click());
    expect(mocks.chartHandle.setAbsorptionRules.mock.calls.at(-1)?.[0]).toMatchObject({ absorbedPercent: 200, absorbedMultiple: 40 });
    const row = [...container.querySelectorAll(".historical-indicator-legend > *")].find((element) => element.textContent?.includes("Absorption"));
    expect(row).toBeDefined();
    await act(async () => row!.querySelector<HTMLButtonElement>('[aria-label="Hide indicator"]')!.click());
    expect(mocks.chartHandle.setAbsorptionRules.mock.calls.at(-1)?.[0]).toBeNull();
  });
  it("loads historical L2 when Feed Status alone is selected, and stops when it is hidden", async () => {
    localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify(["l2FeedStatus"]));
    mocks.l2Availability.current = true;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const btc = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")]
      .find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    expect(mocks.l2Calls.at(-1)?.enabled).toBe(true);
    const row = [...container.querySelectorAll(".historical-indicator-legend > *")]
      .find((element) => element.textContent?.includes("L2 Feed Status"));
    expect(row).toBeDefined();
    await act(async () => row!.querySelector<HTMLButtonElement>('[aria-label="Hide indicator"]')!.click());
    expect(mocks.l2Calls.at(-1)?.enabled).toBe(false);
  });
  it("hands the chart the saved profile view in Historical Mode too", async () => {
    localStorage.setItem(
      "terminal.historical-indicators.preferences.v1",
      JSON.stringify({
        runtimeSettingsById: {
          sessionVolumeProfile: {
            view: "netDeltaProfile",
            mode: "continuous",
            periodMs: 60 * 60 * 1000,
            binSizeMultiplier: 2,
          },
        },
      }),
    );
    mocks.chartHandle.setSessionProfileSettings.mockClear();
    await act(async () => root.render(<HistoricalModePanel />));

    // The archive study's frames arrive at the chart panel, which decides
    // which primitive draws them -- and it only knows the view because the
    // panel pushes the saved settings over.
    expect(
      mocks.chartHandle.setSessionProfileSettings.mock.calls.at(-1)![0],
    ).toMatchObject({
      view: "netDeltaProfile",
      periodMs: 60 * 60 * 1000,
    });
  });

  it("closes the archive watchlist from inside the dock, back to the toolbar toggle (PR #33 review)", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const toggle = container.querySelector<HTMLButtonElement>(".side-toggle")!;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close historical watchlist"]')!.click());
    expect(container.querySelector(".historical-content")?.classList.contains("right-panel-closed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
  it("keeps the archive watchlist in the shared dock and selects an archived instrument", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    expect(container.querySelector(".historical-side-panels .watchlist-panel")).not.toBeNull();
    expect(container.querySelector(".historical-dock-unavailable")?.textContent).toBe("Book & tape");
    expect(container.querySelector(".watchlist-row.selected")?.textContent).toContain("BTC Perpetual");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select archive ETH Perpetual"]')!.click());
    expect(container.querySelector(".watchlist-row.selected")?.textContent).toContain("ETH Perpetual");
    expect(container.querySelector(".historical-instrument-value")?.textContent).toBe("ETH Perpetual");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Hide historical watchlist"]')!;
    await act(async () => toggle.click());
    expect(container.querySelector(".historical-content")?.classList.contains("right-panel-closed")).toBe(true);
  });
  it("sends a validated archive page to the shared chart after the matching instrument is selected", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    );
    expect(trigger).not.toBeNull();

    await act(async () => trigger?.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"));
    expect(btc).not.toBeUndefined();
    await act(async () => btc?.click());

    expect(mocks.chartProps.current).toMatchObject({
      instrumentIdentity: {
        symbol: "BTCUSDT",
        provider: "BINANCE",
        marketKind: "SPOT",
      },
    });
    expect(mocks.chartHandle.applySnapshot).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          ts_open: 1_756_684_800_000,
          interval_ms: 86_400_000,
          trade_count: 318,
          buy_volume: 23,
          closed: true,
        }),
      ],
      { viewport: "all" },
    );
    expect(container.textContent).toContain("1 candles rendered");
  });

  it("does not render a completed page for a different instrument", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    );
    await act(async () => trigger?.click());
    const eth = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ETH Spot"));
    expect(eth).not.toBeUndefined();
    await act(async () => eth?.click());

    expect(mocks.chartProps.current).toMatchObject({
      instrumentIdentity: {
        symbol: "ETHUSDT",
        provider: "BINANCE",
        marketKind: "SPOT",
      },
    });
    expect(mocks.chartHandle.applySnapshot).not.toHaveBeenCalled();
    expect(container.textContent).toContain("requesting archive page");
    expect(container.querySelector(".historical-empty-state")).not.toBeNull();
  });

  it("preserves the visible chart range while an adjacent archive window is extending history", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    )!;
    await act(async () => trigger.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"))!;
    await act(async () => btc.click());
    expect(mocks.chartHandle.applySnapshot).toHaveBeenLastCalledWith(
      expect.any(Array),
      { viewport: "all" },
    );

    const current = mocks.archiveLoad.current as Extract<
      ArchivePageLoad,
      { state: "ready" }
    >;
    vi.clearAllMocks();
    mocks.archiveLoad.current = { ...current, loadingDirection: "before" };
    await act(async () => root.render(<HistoricalModePanel />));

    expect(mocks.chartHandle.applySnapshot).not.toHaveBeenCalled();
    expect(mocks.chartHandle.setIndicators).not.toHaveBeenCalled();
    expect(
      mocks.chartHandle.subscribeVisibleLogicalRangeChange,
    ).not.toHaveBeenCalled();
    expect(mocks.chartHandle.setHistoricalRollMarkers).not.toHaveBeenCalled();

    mocks.archiveLoad.current = readyPage();
    await act(async () => root.render(<HistoricalModePanel />));
    expect(mocks.chartHandle.applySnapshot).toHaveBeenLastCalledWith(
      expect.any(Array),
      { viewport: "default" },
    );
    expect(mocks.chartHandle.setIndicators).not.toHaveBeenCalled();
    expect(
      mocks.chartHandle.setHistoricalIndicatorCapabilities,
    ).not.toHaveBeenCalled();
  });

  it("renders a continuous future through the shared chart and supplies only its explicit roll markers", async () => {
    mocks.archiveLoad.current = {
      state: "ready",
      instrumentId: "es-continuous",
      timeframeId: "1D",
      resolution: "1d",
      loadingDirection: null,
      onVisibleLogicalRangeChange: vi.fn(),
      series: {
        bars: [
          {
            type: "bar",
            symbol: "ES",
            provider: "DATABENTO",
            assetClass: "FUTURE",
            interval_ms: 86_400_000,
            ts_open: 1_756_684_800_000,
            open: 100.25,
            high: 101.5,
            low: 99.75,
            close: 100.75,
            volume: 42.5,
            trade_count: 318,
            closed: true,
          },
        ],
        metrics: [{ tsOpen: 1_756_684_800_000 }],
        capabilities: ["ohlcv", "trade_count"],
        provider: "DATABENTO",
      },
      page: {
        ...readyPage().page,
        rollMarkers: [
          {
            time: Date.parse("2025-09-17T00:00:00.000Z"),
            label: "ESU5 → ESZ5",
          },
        ],
      },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    );
    await act(async () => trigger?.click());
    const es = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ES Continuous"));
    expect(es).not.toBeUndefined();
    await act(async () => es?.click());

    expect(mocks.chartProps.current).toMatchObject({
      instrumentIdentity: {
        symbol: "ES",
        provider: "DATABENTO",
        assetClass: "FUTURE",
      },
    });
    expect(mocks.chartHandle.applySnapshot).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          symbol: "ES",
          provider: "DATABENTO",
          assetClass: "FUTURE",
        }),
      ],
      { viewport: "all" },
    );
    expect(mocks.chartHandle.setHistoricalRollMarkers).toHaveBeenLastCalledWith(
      [{ time: Date.parse("2025-09-17T00:00:00.000Z"), label: "ESU5 → ESZ5" }],
    );
  });

  it("maps a display timeframe back to its hidden archive source rung", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    )!;
    await act(async () => trigger.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"))!;
    await act(async () => btc.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const fiveMinute = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "5m")!;
    await act(async () => fiveMinute.click());

    expect(mocks.archiveCalls.at(-1)?.[1]).toMatchObject({
      id: "5m",
      sourceResolution: "1m",
    });
    expect(container.querySelector(".historical-rungs")).toBeNull();
  });

  it("keeps the last verified chart on screen while a same-instrument timeframe is loading", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const instrument = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    )!;
    await act(async () => instrument.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    await act(async () => {
      await Promise.resolve();
    });
    vi.clearAllMocks();

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const fiveMinute = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "5m")!;
    await act(async () => fiveMinute.click());

    expect(mocks.chartHandle.applySnapshot).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Updating chart");
    expect(container.textContent).toContain("requesting archive page");
    expect(container.querySelector(".historical-empty-state")).toBeNull();
  });

  it("activates an available historical study through the shared chart handle", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const instrument = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    )!;
    await act(async () => instrument.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    const indicators = container.querySelector<HTMLButtonElement>(
      ".historical-indicators",
    )!;
    await act(async () => indicators.click());
    const rsi = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-indicator-select",
      ),
    ].find((button) => button.textContent?.includes("RSI (14)"));
    expect(rsi).not.toBeUndefined();
    await act(async () => rsi?.click());

    expect(
      mocks.chartHandle.setHistoricalIndicatorCapabilities,
    ).toHaveBeenLastCalledWith(
      ["ohlcv", "buy_volume", "trade_count"],
      "BINANCE",
    );
    expect(mocks.chartHandle.setIndicators).toHaveBeenLastCalledWith(
      ["rsi"],
      {},
    );
    expect(mocks.chartHandle.setIndicatorVisibility).toHaveBeenLastCalledWith([
      "rsi",
    ]);
    const legend = container.querySelector(".historical-indicator-legend");
    expect(legend?.textContent).toContain("RSI (14)");

    await act(async () =>
      legend
        ?.querySelector<HTMLButtonElement>('[aria-label="Hide indicator"]')
        ?.click(),
    );
    expect(mocks.chartHandle.setIndicatorVisibility).toHaveBeenLastCalledWith(
      [],
    );

    await act(async () =>
      legend
        ?.querySelector<HTMLButtonElement>('[aria-label="Remove indicator"]')
        ?.click(),
    );
    expect(container.querySelector(".historical-indicator-legend")).toBeNull();
  });

  it("labels the historical Live Delta Profile as a candle estimate, not measured price-row flow", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    const instrument = container.querySelector<HTMLButtonElement>(".historical-instrument")!;
    await act(async () => instrument.click());
    const btc = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")]
      .find((button) => button.textContent?.includes("BTC Spot"))!;
    await act(async () => btc.click());
    const indicators = container.querySelector<HTMLButtonElement>(".historical-indicators")!;
    await act(async () => indicators.click());
    const delta = [...container.querySelectorAll<HTMLButtonElement>(".historical-indicator-select")]
      .find((button) => button.textContent?.includes("Live Delta Profile"))!;
    await act(async () => delta.click());
    expect(container.querySelector(".historical-indicator-legend")?.textContent)
      .toContain("Estimated from visible candles");
  });

  it("offers the trade-derived studies on an archive with trade summaries and hands them to the study loader", async () => {
    mocks.archiveLoad.current = {
      ...readyPage(),
      instrumentId: "es-continuous",
      timeframeId: "1h",
      resolution: "1h",
      series: {
        ...readyPage().series,
        bars: [
          {
            ...readyPage().series.bars[0],
            symbol: "ES",
            provider: "DATABENTO",
            assetClass: "FUTURE",
            marketKind: undefined,
            interval_ms: 3_600_000,
          },
        ],
        capabilities: ["ohlcv", "trade_count"],
        provider: "DATABENTO",
      },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click(),
    );
    const es = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ES Continuous"));
    await act(async () => es?.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const hour = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "1h")!;
    await act(async () => hour.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );

    const pick = (label: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".historical-indicator-select",
        ),
      ].find((button) => {
        const name = button.querySelector("span")?.textContent;
        return name === label || name?.startsWith(`${label} (`);
      });
    expect(pick(SESSION_PROFILE_LABEL)?.disabled).toBe(false);
    expect(pick("VPIN Cloud")?.disabled).toBe(false);
    expect(pick("Large Trade Detector")?.disabled).toBe(false);
    expect(pick("Large Trade Bubbles")?.disabled).toBe(true);
    expect(pick("Large Trade Bubbles")?.textContent).toContain(
      "largest prints of each minute",
    );

    await act(async () => pick(SESSION_PROFILE_LABEL)?.click());
    await act(async () => pick("Large Trade Detector")?.click());
    expect(
      mocks.chartHandle.setHistoricalIndicatorCapabilities,
    ).toHaveBeenLastCalledWith(
      ["ohlcv", "trade_count", "trade_families", "buy_volume"],
      "DATABENTO",
    );
    expect(mocks.studyCalls.at(-1)).toMatchObject({
      instrument: expect.objectContaining({ id: "es-continuous" }),
      intervalMs: 3_600_000,
      toggles: { profile: true, vpin: false, prints: true, flow: false },
      profileSettings: { mode: "continuous", binSizeMultiplier: 2 },
    });

    const legend = container.querySelector(".historical-indicator-legend")!;
    expect(legend.textContent?.indexOf("Large Trade Detector")).toBeLessThan(
      legend.textContent?.indexOf(SESSION_PROFILE_LABEL) ?? -1,
    );
    await act(async () =>
      legend
        .querySelector<HTMLButtonElement>('[aria-label="Hide indicator"]')
        ?.click(),
    );
    expect(mocks.studyCalls.at(-1)).toMatchObject({
      toggles: { profile: true, vpin: false, prints: false, flow: false },
    });

    mocks.studyStatus.current = {
      loading: false,
      issue: "The archive refused a study: UPSTREAM_UNREACHABLE.",
      unsidedShare: null,
    };
    await act(async () => root.render(<HistoricalModePanel />));
    expect(
      container.querySelector(".historical-quote-detail")?.textContent,
    ).toContain("UPSTREAM_UNREACHABLE");

    mocks.studyStatus.current = {
      loading: false,
      issue: null,
      unsidedShare: 0.31,
    };
    await act(async () => root.render(<HistoricalModePanel />));
    expect(
      container.querySelector(".historical-quote-detail")?.textContent,
    ).toContain("31% of volume has no buy or sell side");
  });

  it("asks the archive for no finer a bin size than it accepts, when the shared setting is finer than that", async () => {
    localStorage.setItem(
      "terminal.historical-indicators.preferences.v1",
      JSON.stringify({
        runtimeSettingsById: {
          sessionVolumeProfile: {
            mode: "continuous",
            periodMs: 60 * 60 * 1000,
            binSizeMultiplier: 0.05,
          },
        },
      }),
    );
    mocks.archiveLoad.current = {
      ...readyPage(),
      instrumentId: "es-continuous",
      timeframeId: "1h",
      resolution: "1h",
      series: {
        ...readyPage().series,
        bars: [
          {
            ...readyPage().series.bars[0],
            symbol: "ES",
            provider: "DATABENTO",
            assetClass: "FUTURE",
            marketKind: undefined,
            interval_ms: 3_600_000,
          },
        ],
        capabilities: ["ohlcv", "trade_count"],
        provider: "DATABENTO",
      },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click(),
    );
    const es = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ES Continuous"));
    await act(async () => es?.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const hour = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "1h")!;
    await act(async () => hour.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );
    const volumeProfile = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-indicator-select",
      ),
    ].find((button) => button.querySelector("span")?.textContent === SESSION_PROFILE_LABEL);
    await act(async () => volumeProfile?.click());

    expect(mocks.studyCalls.at(-1)).toMatchObject({
      toggles: expect.objectContaining({ profile: true }),
      profileSettings: { mode: "continuous", binSizeMultiplier: 0.1 },
    });
    const profileRow = [...container.querySelectorAll(".historical-indicator-legend > *")]
      .find((element) => element.textContent?.trim().startsWith(SESSION_PROFILE_LABEL));
    const settingsButton = profileRow?.querySelector<HTMLButtonElement>('[aria-label="Indicator settings"]');
    expect(settingsButton).toBeTruthy();
    await act(async () => settingsButton!.click());
    expect(document.querySelector(`[aria-label="${SESSION_PROFILE_LABEL} settings"]`)?.textContent)
      .toContain("Historical Mode uses 0.1 as the minimum bin-size multiplier. The saved 0.05 setting remains available in Live Mode.");
  });

  it("Large Trade Detector has its settings in Historical Mode, size-only with the reason shown, and a change reaches the study loader and survives a reload (Block 8 #12)", async () => {
    mocks.archiveLoad.current = {
      ...readyPage(),
      instrumentId: "es-continuous",
      timeframeId: "1h",
      resolution: "1h",
      series: {
        ...readyPage().series,
        bars: [
          {
            ...readyPage().series.bars[0],
            symbol: "ES",
            provider: "DATABENTO",
            assetClass: "FUTURE",
            marketKind: undefined,
            interval_ms: 3_600_000,
          },
        ],
        capabilities: ["ohlcv", "trade_count"],
        provider: "DATABENTO",
      },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click(),
    );
    const es = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ES Continuous"));
    await act(async () => es?.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const hour = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "1h")!;
    await act(async () => hour.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );
    const pick = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-indicator-select",
      ),
    ].find((button) => button.textContent?.includes("Large Trade Detector"));
    await act(async () => pick?.click());

    const legend = container.querySelector(".historical-indicator-legend")!;
    const settings = legend.querySelector<HTMLButtonElement>(
      '[aria-label="Indicator settings"]',
    );
    expect(settings).not.toBeNull();
    await act(async () => settings!.click());
    const dialog = document.querySelector(
      '[aria-label="Large Trade Detector settings"]',
    )!;
    expect(dialog.textContent).toContain(
      "four largest prints per side per minute",
    );
    expect(dialog.textContent).not.toContain("Top %");
    const size = dialog.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(size, "35");
      size.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.studyCalls.at(-1)).toMatchObject({
      displaySettings: expect.objectContaining({ whaleThresholdContracts: 35 }),
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<HistoricalModePanel />));
    expect(mocks.studyCalls.at(-1)).toMatchObject({
      displaySettings: expect.objectContaining({ whaleThresholdContracts: 35 }),
    });
  });

  it("VPIN Cloud and Session Volume Profile open their own settings in Historical Mode (Block 8 #12, #13)", async () => {
    mocks.archiveLoad.current = {
      ...readyPage(),
      instrumentId: "es-continuous",
      timeframeId: "1h",
      resolution: "1h",
      series: {
        ...readyPage().series,
        bars: [
          {
            ...readyPage().series.bars[0],
            symbol: "ES",
            provider: "DATABENTO",
            assetClass: "FUTURE",
            marketKind: undefined,
            interval_ms: 3_600_000,
          },
        ],
        capabilities: ["ohlcv", "trade_count"],
        provider: "DATABENTO",
      },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click(),
    );
    const es = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("ES Continuous"));
    await act(async () => es?.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click(),
    );
    const hour = [
      ...container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"),
    ].find((button) => button.textContent === "1h")!;
    await act(async () => hour.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );
    for (const label of ["VPIN Cloud", SESSION_PROFILE_LABEL]) {
      const pick = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".historical-indicator-select",
        ),
      ].find((button) => button.textContent?.trim().startsWith(label));
      await act(async () => pick?.click());
    }
    const legendRows = [
      ...container.querySelectorAll(".historical-indicator-legend > *"),
    ];
    for (const [label, dialogLabel] of [
      ["VPIN Cloud", "VPIN Cloud settings"],
      [SESSION_PROFILE_LABEL, `${SESSION_PROFILE_LABEL} settings`],
    ] as const) {
      const row = legendRows.find((element) =>
        element.textContent?.trim().startsWith(label),
      );
      const settings = row?.querySelector<HTMLButtonElement>(
        '[aria-label="Indicator settings"]',
      );
      expect(settings).toBeTruthy();
      await act(async () => settings!.click());
      expect(
        document.querySelector(`[aria-label="${dialogLabel}"]`),
      ).not.toBeNull();
    }
    expect(
      document.querySelector(`[aria-label="${SESSION_PROFILE_LABEL} settings"]`)!
        .textContent,
    ).toContain("recompute the profile on the host");
  });

  it("keeps the trade-derived studies closed on an archive without trade summaries", async () => {
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-instrument")!
        .click(),
    );
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );
    const profile = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-indicator-select",
      ),
    ].find((button) => button.querySelector("span")?.textContent === SESSION_PROFILE_LABEL);
    expect(profile?.disabled).toBe(true);
    expect(profile?.textContent).toContain("Needs archived trade summaries");
    expect(mocks.studyCalls.at(-1)).toMatchObject({ instrument: null });
  });

  it("opens trade studies when the same served pointer confirms all derived families", async () => {
    mocks.tradeAvailability.current = true;
    await act(async () => root.render(<HistoricalModePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-instrument")!.click());
    const btc = [...container.querySelectorAll<HTMLButtonElement>(".historical-symbol-option")]
      .find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".historical-indicators")!.click());
    const profile = [...container.querySelectorAll<HTMLButtonElement>(".historical-indicator-select")]
      .find((button) => button.querySelector("span")?.textContent === SESSION_PROFILE_LABEL);
    expect(profile?.disabled).toBe(false);
    expect(mocks.studyCalls.at(-1)).toMatchObject({ instrument: { id: "btc-spot" } });
    expect(mocks.chartHandle.setHistoricalIndicatorCapabilities).toHaveBeenLastCalledWith(
      ["ohlcv", "buy_volume", "trade_count", "trade_families"], "BINANCE",
    );
  });

  it("shows a data reason and blocks activation when the current series has no candle-side volume", async () => {
    mocks.archiveLoad.current = {
      ...readyPage(),
      series: { ...readyPage().series, capabilities: ["ohlcv", "trade_count"] },
    } satisfies ArchivePageLoad;
    await act(async () => root.render(<HistoricalModePanel />));
    const instrument = container.querySelector<HTMLButtonElement>(
      ".historical-instrument",
    )!;
    await act(async () => instrument.click());
    const btc = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-symbol-option",
      ),
    ].find((button) => button.textContent?.includes("BTC Spot"));
    await act(async () => btc?.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".historical-indicators")!
        .click(),
    );

    const orderFlow = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".historical-indicator-select",
      ),
    ].find((button) => button.textContent?.includes("Aggressive Order Flow"));
    expect(orderFlow?.disabled).toBe(true);
    expect(orderFlow?.textContent).toContain("Requires buy volume");
    await act(async () => orderFlow?.click());
    expect(mocks.chartHandle.setIndicators).not.toHaveBeenCalledWith(
      expect.arrayContaining(["orderFlow"]),
      expect.anything(),
    );
  });
});
