import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ConnectionStatus, FeedHealth } from "../../hooks/useMarketData";
import { MAX_RETAINED_HISTORICAL_ZONES } from "../../hooks/useMarketData";
import { formatUsd } from "../../lib/chart/formatUsd";
import { orderFlowProvenance } from "../../lib/indicators/order-flow/orderFlow";
import {
  DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS,
  type OrderFlowIndicatorSettings,
} from "../../lib/indicators/order-flow/orderFlowIndicator";
import {
  FAVORITES_STORAGE_KEY,
  loadIndicatorFavorites,
  saveIndicatorFavorites,
} from "../../lib/chart/indicatorFavorites";
import {
  LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
  loadHistoricalIndicatorPreferences,
  saveHistoricalIndicatorPreferences,
} from "../../lib/chart/historicalIndicatorPreferences";
import {
  loadLiveIndicatorExtras,
  saveLiveIndicatorExtras,
} from "../../lib/chart/liveIndicatorExtras";
import {
  INDICATOR_REGISTRY,
  RUNTIME_INDICATOR_DEFS,
  type IndicatorId,
} from "../../lib/chart/indicatorRegistry";
import { settingsSchemaFor } from "../../lib/chart/settingsSchemaFor";
import { GenericIndicatorSettingsModal } from "../GenericIndicatorSettingsModal";
import { type KillzoneId } from "../../lib/indicators/killzones/killzones";
import {
  DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS,
  type DeltaDivergenceIndicatorSettings,
} from "../../lib/indicators/delta-divergence/deltaDivergenceIndicator";
import {
  DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
  type CvdDivergenceIndicatorSettings,
} from "../../lib/indicators/cvd-divergence/cvdDivergenceIndicator";
import {
  instrumentKey,
  type DrawingToolId,
} from "../../lib/chart/drawingStore";
import {
  selectWhaleTradesBySize,
  selectWhaleTradesByTopFraction,
  type WhaleDetectionMode,
  type WhaleTradeStat,
} from "../../lib/indicators/whale-detector/whaleTrades";

import type { WhaleClusterMode } from "../../lib/indicators/whale-detector/whaleMarkerClusters";
import { alignedPeriodBoundaries } from "../../lib/indicators/volume-profile/volumeProfileZones";
import {
  DEFAULT_VPIN_SENSITIVITY,
  MIN_READINGS_FOR_DERIVED_DEFAULT,
  deriveDefaultVpinSensitivity,
  reapplyVpinHysteresis,
} from "../../lib/indicators/vpin-cloud/vpinSensitivity";
import type {
  BarFrame,
  BarHistory,
  BookFrame,
  FrameIdentity,
  ProfileFrame,
  TradeFrame,
  VpinReading,
  VpinStatus,
} from "../../types/frames";
import type { AggressiveHistoryReason } from "../../types/frames";
import type { MarkerSelectionView } from "../../lib/chart/markerRetention";
import type {
  ProfileConfigRequest,
  ProfileHistoryRequest,
} from "../../workers/marketDataWorker";
import { ChartPanel, type ChartPanelHandle } from "./ChartPanel";
import { DomPanel } from "./DomPanel";
import { DrawingToolbar } from "../chrome/DrawingToolbar";
import { IndicatorLegendRow } from "../chrome/IndicatorLegendRow";
import { IndicatorsMenu } from "../chrome/IndicatorsMenu";
import { KillzonesSettingsModal } from "../../lib/indicators/killzones/KillzonesSettingsModal";
import { TapePanel } from "./TapePanel";
import { WatchlistPanel } from "./WatchlistPanel";
import { dockOpenByDefault } from "../chrome/dock";
import { TimeframeMenu } from "../chrome/TimeframeMenu";
import { TIMEFRAMES } from "../../lib/chart/resampleBars";
import { WhaleDetectorSettingsModal } from "../../lib/indicators/whale-detector/WhaleDetectorSettingsModal";
import {
  DEFAULT_SESSION_DELTA_PROFILE_SETTINGS,
  type SessionDeltaProfileSettings,
} from "../../lib/indicators/session-delta-profile/sessionDeltaProfileSettings";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  sessionProfileViewLabel,
  type SessionProfileIndicatorSettings,
} from "../../lib/indicators/session-profile/sessionProfileSettings";
import { SESSION_PROFILE_INDICATOR_ID } from "../../lib/indicators/session-profile/sessionProfileIds";
import { VpinCloudSettingsModal } from "../../lib/indicators/vpin-cloud/VpinCloudSettingsModal";
import { PivotSupportResistanceSettingsModal } from "../../lib/indicators/pivot-support-resistance/PivotSupportResistanceSettingsModal";
import {
  DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS,
  type PivotSupportResistanceSettings,
} from "../../lib/indicators/pivot-support-resistance/pivotSupportResistance";
import { VolumeProfileOhlcSettingsModal } from "../../lib/indicators/volume-delta-profile-ohlc/VolumeProfileOhlcSettingsModal";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  type VolumeDeltaProfileOhlcSettings,
} from "../../lib/indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlcSettings";
import { VolumeDeltaProfileTickSettingsModal } from "../../lib/indicators/volume-delta-profile-tick/VolumeDeltaProfileTickSettingsModal";
import {
  normalizeVolumeDeltaProfileTickSettings,
  type VolumeDeltaProfileTickSettings,
} from "../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickSettings";
import { LiquidityHeatmapSettingsModal } from "../../lib/indicators/passive-liquidity/LiquidityHeatmapSettingsModal";
import { L2SupportResistanceSettingsModal } from "../../lib/indicators/l2-support-resistance/L2SupportResistanceSettingsModal";
import { L2BookMapSettingsModal } from "../../lib/indicators/l2-book-map/l2BookMapSettings";
import { WhaleHeatmapSettingsModal } from "../../lib/indicators/whale-limit-order-heatmap/WhaleHeatmapSettingsModal";
import { whaleLegendDetail, type WhaleSettings as WhaleHeatmapSettings } from "../../lib/indicators/whale-limit-order-heatmap/whaleSettings";
import type { L2SupportResistanceSettings } from "../../lib/indicators/l2-support-resistance/l2SupportResistancePrimitive";
import type { L2BookMapSettings } from "../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import {
  type LiquiditySettings,
  formatLiquiditySpan,
  historyDaysLabel,
} from "../../lib/indicators/passive-liquidity/liquiditySettings";
import type { LiquidityLaneChoice } from "../../lib/indicators/passive-liquidity/liquidityLanes";
import type { HeatmapHistory } from "../../lib/indicators/passive-liquidity/heatmapHistory";
import type { ColumnHistoryStream } from "../../lib/indicators/passive-liquidity/columnHistoryStream";
import type { WallHistoryStream } from "../../lib/l2/wallHistoryStream";
import type { HeatmapHistoryInfo } from "../../lib/indicators/passive-liquidity/liquidityHeatmapLayout";

function historyLegend(info: HeatmapHistoryInfo | null): string {
  if (info === null) return "";
  if (info.refused === "GEOMETRY") return " · history rows differ";
  const reach = historyDaysLabel(info.days);
  if (info.loading) return ` · loading ${reach} of history`;
  if (info.drawn && info.reachTs !== null) return ` · history ${reach}, from ${new Date(info.reachTs).toISOString().slice(5, 16).replace("T", " ")} UTC`;
  if (info.unavailable !== null) return " · history unavailable";
  return "";
}

/**
 * Where the tick profile's flow starts, when the host has not answered the whole
 * of its window. Its price domain is every visible bar either way, so without
 * this the profile reads as the range it is drawn over.
 */
function truncatedProfileLegend(fromMs: number | null): string {
  if (fromMs === null) return "";
  return `profile from ${new Date(fromMs).toISOString().slice(5, 16).replace("T", " ")} UTC`;
}
import { liquidityStyleFor } from "../../lib/indicators/passive-liquidity/liquidityStyle";
import type { LiquidityGrid } from "../../lib/indicators/passive-liquidity/liquidityGrid";
import type { L2Store } from "../../lib/l2/l2Store";
import type {
  BandHistoryRequest,
  BandHistoryStore,
} from "../../lib/chart/bandHistory";
import type { L2HistoryRequester } from "../../lib/l2/history";
import { deltaChannelFree, type DeltaProfileRequest, type DeltaProfileStore } from "../../lib/indicators/live-delta-profile/deltaProfileStore";
import { windowFor, visibleWindowFor } from "../../lib/indicators/live-delta-profile/profileWindow";
import { AggressiveOrdersSettingsModal } from "../../lib/indicators/aggressive-orders/AggressiveOrdersSettingsModal";
import { LiveDeltaProfileSettingsModal } from "../../lib/indicators/live-delta-profile/LiveDeltaProfileSettingsModal";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, type LiveDeltaProfileSettings } from "../../lib/indicators/live-delta-profile/liveDeltaProfileSettings";
import { LiveOrderBookProfileSettingsModal } from "../../lib/indicators/live-order-book-profile/LiveOrderBookProfileSettingsModal";
import { BookProfileSource } from "../../lib/indicators/live-order-book-profile/bookProfileSource";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, clusterRowsOf, type LiveOrderBookProfileSettings } from "../../lib/indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, type AggressiveProfileSettings } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { AggressiveProfileSettingsModal } from "../../lib/indicators/aggressive-orders-profile/AggressiveProfileSettingsModal";
import { RANGE_POLL_MS, RANGE_WARM_MS, type RangePrintStore } from "../../lib/indicators/aggressive-orders-profile/rangePrintStore";
import { START_FLOOR_WAIT_MS, startingPrintFloorFor } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileReader";
import {
  defaultAggressiveOrdersSettingsFor,
  groupingStepFor,
  isAggressiveTimeframeSupported,
  scaledClusterRules,
  suggestedMinVolumeFor,
  type AggressiveOrdersSettings,
} from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import {
  AUTO_FLOOR_MIN_PRINTS,
  nextAggressiveHistoryRequestId,
  type AggressiveTape,
} from "../../lib/indicators/aggressive-orders/aggressiveTape";
import {
  historyRequestFor,
  historyWantedFrom,
} from "../../lib/indicators/aggressive-orders/columnPrints";
import { AbsorptionSettingsModal } from "../../lib/indicators/absorption-detector/AbsorptionSettingsModal";
import { IcebergSettingsModal } from "../../lib/indicators/iceberg-detector/IcebergSettingsModal";
import { ExhaustionSettingsModal } from "../../lib/indicators/exhaustion/ExhaustionSettingsModal";
import type { CandleMonitorArrival } from "../../lib/indicators/candle-monitor/candleMonitorText";
import { DEFAULT_EXHAUSTION_SETTINGS, exhaustionCandleMsOf, exhaustionHistoryDaysOf, exhaustionLiveSinceText, exhaustionLoadingLabel, shownShades, type ExhaustionSettings } from "../../lib/indicators/exhaustion/exhaustionSettings";
import { sizeUnitFor } from "../../lib/indicators/institutional-order-blocks-v2/institutionalV2Rules";
import { DEFAULT_ICEBERG_SETTINGS, icebergHistoryDaysOf, icebergHistoryFromText, type IcebergSettings } from "../../lib/indicators/iceberg-detector/icebergSettings";
import type { IcebergBook } from "../../lib/l2/icebergBook";
import type { ExhaustionBook } from "../../lib/l2/exhaustionBook";
import { InitiativeSettingsModal } from "../../lib/indicators/initiative/InitiativeSettingsModal";
import { DEFAULT_INITIATIVE_SETTINGS, initiativeCandleMsOf, initiativeHistoryDaysOf, shownBands, type InitiativeSettings } from "../../lib/indicators/initiative/initiativeSettings";
import { LiveRangeSettingsModal } from "../../lib/indicators/live-range-control/LiveRangeSettingsModal";
import { DEFAULT_LIVE_RANGE_SETTINGS, bigPrintOf, printScaleFor, rangeModeOf, type LiveRangeSettings } from "../../lib/indicators/live-range-control/liveRangeSettings";
import { loadWindow as loadLiveRangeWindow, originOf as liveRangeOriginOf, saveWindow as saveLiveRangeWindow, windowBounds as liveRangeWindowBounds, windowFor as liveRangeWindowFor, type LiveRangeWindow } from "../../lib/indicators/live-range-control/liveRangeWindow";
import { legendText as liveRangeLegendText } from "../../lib/indicators/live-range-control/liveRangeWords";
import type { InitiativeBook } from "../../lib/l2/initiativeBook";
import {
  DEFAULT_ABSORPTION_SETTINGS,
  absorptionRulesFor,
  type AbsorptionSettings,
} from "../../lib/indicators/absorption-detector/absorptionSettings";

const AGGRESSIVE_VIEW_DEBOUNCE_MS = 300;
const AGGRESSIVE_VIEW_STEP_MS = 60 * 60 * 1000;
const DELTA_VIEW_DEBOUNCE_MS = 300;
const BAND_HISTORY_APPLY_MS = 2_000;

const HISTORICAL_ZONE_DEBOUNCE_MS = 300;
const PERIOD_LABELS: Record<number, string> = {
  [60 * 60 * 1000]: "1H",
  [4 * 60 * 60 * 1000]: "4H",
  [24 * 60 * 60 * 1000]: "1D",
  [7 * 24 * 60 * 60 * 1000]: "1W",
};

interface MainPanelProps {
  chartRef: RefObject<ChartPanelHandle | null>;
  intervalMs: number;
  onTimeframeSelect: (intervalMs: number) => void;
  displayBar: BarFrame | null;
  up: boolean;
  status: ConnectionStatus;
  backendDegraded: boolean;
  latestBar: BarFrame | null;
  feedHealth: FeedHealth | null;
  feedStale: boolean;
  barHistory: BarHistory | null;
  book: BookFrame | null;
  profile: ProfileFrame | null;
  liquidity?: LiquidityGrid | null;
  liquidityVersion?: number;
  heatmapHistory?: HeatmapHistory | null;
  columnHistory?: ColumnHistoryStream | null;
  hostWalls?: WallHistoryStream | null;
  whaleWalls?: WallHistoryStream | null;
  l2?: L2Store | null;
  l2Version?: number;
  icebergs?: IcebergBook | null;
  icebergsVersion?: number;
  exhaustions?: ExhaustionBook | null;
  exhaustionsVersion?: number;
  initiatives?: InitiativeBook | null;
  initiativesVersion?: number;
  candleMonitor?: CandleMonitorArrival | null;
  aggressiveTape?: AggressiveTape | null;
  historicalProfiles: ProfileFrame[];
  vpinHistory: VpinReading[];
  vpinStatus: VpinStatus | null;
  sendProfileConfig: (config: ProfileConfigRequest) => void;
  sendProfileHistory: (request: ProfileHistoryRequest) => void;
  requestLiquidityResync: () => void;
  requestExhaustionHistory?: (fromTs: number) => void;
  requestInitiativeHistory?: (fromTs: number) => void;
  requestAggressiveHistory?: (request: {
    request_id: number;
    from_ts: number;
    to_ts: number;
    min_size: number;
  }) => void;
  aggressiveHistoryIssue?: AggressiveHistoryReason | null;
  bandHistory?: BandHistoryStore | null;
  bandHistoryVersion?: number;
  requestBandHistory?: (request: BandHistoryRequest) => void;
  requestL2History?: L2HistoryRequester;
  deltaProfile?: DeltaProfileStore | null;
  deltaProfileVersion?: number;
  deltaTickProfile?: DeltaProfileStore | null;
  deltaTickProfileVersion?: number;
  requestDeltaProfile?: (request: DeltaProfileRequest) => void;
  rangePrints?: RangePrintStore | null;
  askRangePrints?: () => void;
  trades: TradeFrame[];
  markerView: MarkerSelectionView;
  markersVersion: number;
  tapeTradeCount: number;
  lastPrice: number | undefined;
  watchlistPrice?: number;
  lastTickDirection: "up" | "down" | null;
  instrumentIdentity: { symbol: string } & FrameIdentity;
  onSelectWatchInstrument?: (symbol: string, identity: FrameIdentity) => void;
}

function historyNoteFor(issue: AggressiveHistoryReason | null): string {
  if (issue === null) return "";
  if (issue === "OVERLOADED") return " · history busy, retrying";
  if (issue === "CONVERSION_INCOMPLETE") return " · history partial";
  return " · history unavailable";
}

function historyDisclosure(history: BarHistory | null): string {
  if (history === null)
    return "No candle-history status has been received yet.";
  const requested = new Date(history.requestedStartTsOpen).toISOString();
  if (history.availability === "UNAVAILABLE") {
    return `Stored candle history is unavailable. Requested start: ${requested}. Live bars may still continue.`;
  }
  if (history.coverage === "NO_ROWS") {
    return `Storage answered successfully but observed no non-empty candle rows from ${requested}. Closed sessions are not synthesized.`;
  }
  const earliest =
    history.earliestObservedTsOpen === undefined
      ? "unknown"
      : new Date(history.earliestObservedTsOpen).toISOString();
  return history.coverage === "START_COVERED"
    ? `Stored/reconstructed candle history covers the requested start (${requested}); earliest observed bar: ${earliest}. Closed intervals remain gaps.`
    : `Stored/reconstructed candle history begins at ${earliest}, after the requested start ${requested}. Earlier intervals are not claimed as complete.`;
}

export function MainPanel({
  chartRef,
  intervalMs,
  onTimeframeSelect,
  displayBar,
  up,
  status,
  backendDegraded,
  latestBar,
  feedHealth,
  feedStale,
  barHistory,
  book,
  profile,
  liquidity = null,
  liquidityVersion = 0,
  heatmapHistory = null,
  columnHistory = null,
  hostWalls = null,
  whaleWalls = null,
  l2 = null,
  l2Version = 0,
  icebergs = null,
  icebergsVersion = 0,
  exhaustions = null,
  exhaustionsVersion = 0,
  initiatives = null,
  initiativesVersion = 0,
  candleMonitor = null,
  aggressiveTape = null,
  historicalProfiles,
  vpinHistory,
  vpinStatus,
  sendProfileConfig,
  sendProfileHistory,
  requestLiquidityResync,
  requestExhaustionHistory,
  requestInitiativeHistory,
  requestAggressiveHistory,
  aggressiveHistoryIssue = null,
  bandHistory = null,
  bandHistoryVersion = 0,
  requestBandHistory,
  requestL2History,
  deltaProfile = null,
  deltaProfileVersion = 0,
  deltaTickProfile = null,
  deltaTickProfileVersion = 0,
  requestDeltaProfile,
  rangePrints = null,
  askRangePrints,
  trades,
  markerView,
  markersVersion,
  tapeTradeCount,
  lastPrice,
  watchlistPrice,
  lastTickDirection,
  instrumentIdentity,
  onSelectWatchInstrument,
}: MainPanelProps) {
  const [rightPanel, setRightPanel] = useState<"market" | "watchlist">("market");
  const [rightPanelOpen, setRightPanelOpen] = useState(dockOpenByDefault);
  const dockToggleRef = useRef<HTMLButtonElement>(null);
  function closeDockFromInside() {
    setRightPanelOpen(false);
    dockToggleRef.current?.focus();
  }
  function onDockKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = rightPanel === "market" ? "watchlist" : "market";
    setRightPanel(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#right-tab-${next}`)?.focus();
  }
  const activeInstrumentKey = instrumentKey(instrumentIdentity);
  const [favorites, setFavorites] = useState<Set<IndicatorId>>(() =>
    loadIndicatorFavorites(),
  );
  const [savedPreferences] = useState(() =>
    loadHistoricalIndicatorPreferences(
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      FAVORITES_STORAGE_KEY,
    ),
  );
  const [savedExtras] = useState(() => loadLiveIndicatorExtras());
  const [visibility, setVisibility] = useState<
    Partial<Record<IndicatorId, boolean>>
  >(savedPreferences.visibility);
  const [runtimeSettingsById, setRuntimeSettingsById] = useState<
    Partial<Record<IndicatorId, unknown>>
  >(savedPreferences.runtimeSettingsById);
  const favoritesList = [...favorites];

  const passiveLiquidityEnabled = favorites.has("passiveLiquidity");
  const passiveLiquidityVisible = visibility.passiveLiquidity ?? true;
  const l2SupportResistanceEnabled = favorites.has("l2SupportResistance");
  const l2SupportResistanceVisible = visibility.l2SupportResistance ?? true;
  const l2BookMapEnabled = favorites.has("l2BookMap");
  const l2BookMapVisible = visibility.l2BookMap ?? true;
  const whaleHeatmapEnabled = favorites.has("whaleLimitOrderHeatmap");
  const whaleHeatmapVisible = visibility.whaleLimitOrderHeatmap ?? true;
  const l2FeedStatusOn =
    favorites.has("l2FeedStatus") && (visibility.l2FeedStatus ?? true);
  const [l2SupportResistanceSettings, setL2SupportResistanceSettings] =
    useState<L2SupportResistanceSettings>(savedExtras.l2SupportResistance);
  const [l2BookMapSettings, setL2BookMapSettings] = useState<L2BookMapSettings>(
    savedExtras.l2BookMap,
  );
  const [whaleHeatmapSettings, setWhaleHeatmapSettings] = useState<WhaleHeatmapSettings>(
    savedExtras.whaleHeatmap,
  );
  // The heatmap's settings belong to the market: BTC's cluster size is not ES's
  // and NQ starts from the trader's own. Each keeps what it was last given.
  const liquidityStyle = liquidityStyleFor(
    instrumentIdentity.provider,
    instrumentIdentity.symbol,
    instrumentIdentity.marketKind,
  );
  const [liquiditySettingsByStyle, setLiquiditySettingsByStyle] = useState<
    Record<string, LiquiditySettings>
  >(savedExtras.liquidityByStyle);
  const [liquidityLane, setLiquidityLane] = useState<LiquidityLaneChoice>(savedExtras.liquidityLane);
  const [liquidityDrawnLane, setLiquidityDrawnLane] = useState(0);
  const [liquidityHistory, setLiquidityHistory] = useState<HeatmapHistoryInfo | null>(null);
  const [volumeDeltaProfileTickTruncatedFrom, setVolumeDeltaProfileTickTruncatedFrom] =
    useState<number | null>(null);
  const liquiditySettings =
    liquiditySettingsByStyle[liquidityStyle.name] ??
    liquidityStyle.defaultSettings;
  const setLiquiditySettings = (next: LiquiditySettings) => {
    setLiquiditySettingsByStyle((previous) => ({
      ...previous,
      [liquidityStyle.name]: next,
    }));
  };
  useEffect(() => {
    chartRef.current?.setL2SupportResistanceSettings(
      l2SupportResistanceSettings,
    );
  }, [chartRef, l2SupportResistanceSettings]);
  useEffect(() => {
    chartRef.current?.setL2BookMapSettings(l2BookMapSettings);
  }, [chartRef, l2BookMapSettings]);
  useEffect(() => {
    chartRef.current?.setWhaleHeatmapSettings(whaleHeatmapSettings);
  }, [chartRef, whaleHeatmapSettings]);
  const liquiditySpan = liquidity ? formatLiquiditySpan(liquidity.spanMs) : "";
  const aggressiveEnabled = favorites.has("aggressiveOrders");
  const aggressiveVisible = visibility.aggressiveOrders ?? true;
  const volumeDeltaProfileTickEnabled = favorites.has("volumeDeltaProfileTick");
  const volumeDeltaProfileTickVisible =
    visibility.volumeDeltaProfileTick ?? true;
  const volumeDeltaTickOn =
    volumeDeltaProfileTickEnabled && volumeDeltaProfileTickVisible;
  const aggressiveDefaults =
    defaultAggressiveOrdersSettingsFor(instrumentIdentity);
  const [aggressiveSettingsByInstrument, setAggressiveSettingsByInstrument] =
    useState<Record<string, AggressiveOrdersSettings>>(
      savedExtras.aggressiveByInstrument,
    );
  const aggressiveSettings =
    aggressiveSettingsByInstrument[activeInstrumentKey] ?? aggressiveDefaults;
  const setAggressiveSettings = (next: AggressiveOrdersSettings) => {
    setAggressiveSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };

  const absorptionEnabled = favorites.has("absorptionDetector");
  const absorptionVisible = visibility.absorptionDetector ?? true;
  const [absorptionSettingsByInstrument, setAbsorptionSettingsByInstrument] =
    useState<Record<string, AbsorptionSettings>>(
      savedExtras.absorptionByInstrument,
    );
  const absorptionDefaults = DEFAULT_ABSORPTION_SETTINGS;
  const absorptionSettings =
    absorptionSettingsByInstrument[activeInstrumentKey] ?? absorptionDefaults;
  const setAbsorptionSettings = (next: AbsorptionSettings) => {
    setAbsorptionSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const absorptionOn = absorptionEnabled && absorptionVisible;
  const exhaustionVisible = visibility.exhaustion ?? true;
  const [exhaustionSettingsByInstrument, setExhaustionSettingsByInstrument] =
    useState<Record<string, ExhaustionSettings>>(
      savedExtras.exhaustionByInstrument,
    );
  const exhaustionSettings =
    exhaustionSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_EXHAUSTION_SETTINGS;
  const setExhaustionSettings = (next: ExhaustionSettings) => {
    setExhaustionSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const initiativeVisible = visibility.initiative ?? true;
  const [initiativeSettingsByInstrument, setInitiativeSettingsByInstrument] =
    useState<Record<string, InitiativeSettings>>(
      savedExtras.initiativeByInstrument,
    );
  const initiativeSettings =
    initiativeSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_INITIATIVE_SETTINGS;
  const setInitiativeSettings = (next: InitiativeSettings) => {
    setInitiativeSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const liveRangeVisible = visibility.liveRangeControl ?? true;
  const [liveRangeSettingsByInstrument, setLiveRangeSettingsByInstrument] =
    useState<Record<string, LiveRangeSettings>>(savedExtras.liveRangeByInstrument);
  const liveRangeSettings =
    liveRangeSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_LIVE_RANGE_SETTINGS;
  const setLiveRangeSettings = (next: LiveRangeSettings) => {
    setLiveRangeSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const liveRangeOn = favorites.has("liveRangeControl") && liveRangeVisible;
  const [liveRangeWindow, setLiveRangeWindowState] = useState<LiveRangeWindow>(() => loadLiveRangeWindow());
  const setLiveRangeWindow = (next: LiveRangeWindow) => {
    setLiveRangeWindowState(next);
    saveLiveRangeWindow(next);
  };
  const liveRangeScale = printScaleFor(instrumentIdentity);
  const liveRangeUnit = sizeUnitFor(instrumentIdentity);
  const liveRangeBigPrint = bigPrintOf(liveRangeSettings, liveRangeScale);
  const liveRangeMode = rangeModeOf(liveRangeSettings);
  const liveRangeLegend = () => {
    const nowMs = Date.now();
    return liveRangeLegendText(liveRangeMode, liveRangeWindowBounds(liveRangeOriginOf(nowMs), liveRangeWindowFor(liveRangeMode, liveRangeWindow), nowMs), nowMs);
  };
  const icebergVisible = visibility.icebergDetector ?? true;
  const [icebergSettingsByInstrument, setIcebergSettingsByInstrument] =
    useState<Record<string, IcebergSettings>>(savedExtras.icebergByInstrument);
  const icebergSettings =
    icebergSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_ICEBERG_SETTINGS;
  const setIcebergSettings = (next: IcebergSettings) => {
    setIcebergSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const institutionalOn =
    favorites.has("institutionalOrderBlocks") &&
    (visibility.institutionalOrderBlocks ?? true);
  const institutionalV2On =
    favorites.has("institutionalOrderBlocksV2") &&
    (visibility.institutionalOrderBlocksV2 ?? true);
  const sessionLevelsOn =
    favorites.has("sessionLevels") && (visibility.sessionLevels ?? true);
  const liquidityVoidsOn =
    favorites.has("liquidityVoids") && (visibility.liquidityVoids ?? true);
  const emptyOrderbookOn =
    favorites.has("emptyOrderbook") && (visibility.emptyOrderbook ?? true);
  const bandHistoryOn = institutionalOn || sessionLevelsOn;
  const bandAppliedRef = useRef<{
    at: number;
    on: boolean;
    store: BandHistoryStore | null;
  }>({ at: 0, on: false, store: null });
  useEffect(() => {
    const applied = bandAppliedRef.current;
    const apply = () => {
      bandAppliedRef.current = {
        at: Date.now(),
        on: bandHistoryOn,
        store: bandHistory,
      };
      chartRef.current?.applyBandHistory(bandHistoryOn ? bandHistory : null);
    };
    const wait =
      bandHistoryOn && applied.on && applied.store === bandHistory
        ? applied.at + BAND_HISTORY_APPLY_MS - Date.now()
        : 0;
    if (wait <= 0) {
      apply();
      return undefined;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [chartRef, bandHistoryOn, bandHistory, bandHistoryVersion]);
  useEffect(() => {
    if (
      !bandHistoryOn ||
      bandHistory === null ||
      status !== "open" ||
      !requestBandHistory
    )
      return;
    const wants = chartRef.current?.bandHistoryWants() ?? [];
    bandHistory.keepOnly(new Set(wants.map((want) => want.key)));
    for (const want of wants) bandHistory.want(want);
    const next = bandHistory.nextRequest(Date.now());
    if (next) requestBandHistory(next);
  }, [
    chartRef,
    bandHistoryOn,
    bandHistory,
    bandHistoryVersion,
    liquidityVersion,
    status,
    requestBandHistory,
  ]);
  useEffect(() => {
    if (
      !bandHistoryOn ||
      bandHistory === null ||
      status !== "open" ||
      !requestBandHistory
    )
      return;
    const timer = window.setInterval(() => {
      const next = bandHistory.nextRequest(Date.now());
      if (next) requestBandHistory(next);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [bandHistoryOn, bandHistory, status, requestBandHistory]);
  const liveDeltaEnabled = favorites.has("liveDeltaProfile");
  const liveDeltaVisible = visibility.liveDeltaProfile ?? true;
  const liveDeltaOn = liveDeltaEnabled && liveDeltaVisible;
  const [liveDeltaSettingsByInstrument, setLiveDeltaSettingsByInstrument] =
    useState<Record<string, LiveDeltaProfileSettings>>(savedExtras.liveDeltaByInstrument);
  const liveDeltaSettings =
    liveDeltaSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_LIVE_DELTA_PROFILE_SETTINGS;
  const setLiveDeltaSettings = (next: LiveDeltaProfileSettings) => {
    setLiveDeltaSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  useEffect(() => {
    chartRef.current?.applyDeltaProfile(liveDeltaOn ? deltaProfile : null);
  }, [chartRef, liveDeltaOn, deltaProfile]);
  useEffect(() => {
    chartRef.current?.applyDeltaTickProfile(
      volumeDeltaTickOn ? deltaTickProfile : null,
    );
  }, [chartRef, volumeDeltaTickOn, deltaTickProfile, deltaTickProfileVersion]);
  useEffect(() => {
    chartRef.current?.setLiveDeltaSettings(liveDeltaSettings);
  }, [chartRef, liveDeltaSettings]);
  const aggressiveProfileVisible = visibility.aggressiveOrdersProfile ?? true;
  const [aggressiveProfileSettingsByInstrument, setAggressiveProfileSettingsByInstrument] =
    useState<Record<string, AggressiveProfileSettings>>(savedExtras.aggressiveProfileByInstrument);
  const aggressiveProfileSettings =
    aggressiveProfileSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_AGGRESSIVE_PROFILE_SETTINGS;
  const setAggressiveProfileSettings = (next: AggressiveProfileSettings) => {
    setAggressiveProfileSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const aggressiveProfileOn = favorites.has("aggressiveOrdersProfile") && aggressiveProfileVisible;
  useEffect(() => {
    chartRef.current?.applyAggressiveProfile(aggressiveProfileOn ? liquidity : null);
  }, [chartRef, aggressiveProfileOn, liquidity]);
  useEffect(() => {
    chartRef.current?.setAggressiveProfileSettings(aggressiveProfileSettings);
  }, [chartRef, aggressiveProfileSettings]);
  const liveOrderBookVisible = visibility.liveOrderBookProfile ?? true;
  const [liveOrderBookSettingsByInstrument, setLiveOrderBookSettingsByInstrument] =
    useState<Record<string, LiveOrderBookProfileSettings>>(savedExtras.liveOrderBookByInstrument);
  const liveOrderBookSettings =
    liveOrderBookSettingsByInstrument[activeInstrumentKey] ?? DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS;
  const setLiveOrderBookSettings = (next: LiveOrderBookProfileSettings) => {
    setLiveOrderBookSettingsByInstrument((previous) => ({
      ...previous,
      [activeInstrumentKey]: next,
    }));
  };
  const bookProfileSource = useMemo(() => (liquidity === null ? null : new BookProfileSource(liquidity, l2?.lanes ?? null)), [liquidity, l2]);
  const liveOrderBookOn = favorites.has("liveOrderBookProfile") && liveOrderBookVisible;
  useEffect(() => {
    chartRef.current?.applyOrderBookProfile(liveOrderBookOn ? bookProfileSource : null);
  }, [chartRef, liveOrderBookOn, bookProfileSource]);
  useEffect(() => {
    bookProfileSource?.markBook(book, Date.now());
  }, [bookProfileSource, book]);
  useEffect(() => {
    chartRef.current?.setLiveOrderBookSettings(liveOrderBookSettings);
  }, [chartRef, liveOrderBookSettings]);
  const [deltaViewRange, setDeltaViewRange] = useState<{ fromMs: number; toMs: number } | null>(null);
  // The tick profile is always read over the visible range, so the chart's range
  // is wanted whenever it is on, not only for the Live Delta Profile's own
  // "Visible range" mode.
  const wantsVisibleRange =
    (liveDeltaOn && liveDeltaSettings.windowMode === "visible") ||
    volumeDeltaTickOn ||
    aggressiveProfileOn;
  useEffect(() => {
    if (!wantsVisibleRange) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The chart only reports a range when it changes, so start from the one on
    // screen now: a profile switched on over a still chart would otherwise wait
    // for the next scroll or the next candle.
    const current = chartRef.current?.getVisibleRangeMs() ?? null;
    if (current !== null) setDeltaViewRange(current);
    const unsubscribe = chartRef.current?.subscribeVisibleRangeChange((fromMs, toMs) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setDeltaViewRange({ fromMs, toMs }), DELTA_VIEW_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [chartRef, wantsVisibleRange]);
  const latestBarOpen = latestBar?.ts_open ?? null;
  const deltaView = useMemo(
    () => (deltaViewRange === null ? null : { ...deltaViewRange, liveEdge: latestBarOpen === null || deltaViewRange.toMs >= latestBarOpen }),
    [deltaViewRange, latestBarOpen],
  );
  useEffect(() => {
    chartRef.current?.applyAggressiveProfilePrints(aggressiveProfileOn ? rangePrints : null);
  }, [chartRef, aggressiveProfileOn, rangePrints]);
  const rangePrintsSinceRef = useRef<{ store: RangePrintStore | null; at: number }>({ store: null, at: 0 });
  const [aggressiveProfileHeld, setAggressiveProfileHeld] = useState<"loading" | "partial" | "whole">("loading");
  useEffect(() => {
    if (!aggressiveProfileOn || rangePrints === null || status !== "open" || !askRangePrints || deltaViewRange === null) return;
    const view = deltaViewRange;
    const tick = () => {
      const now = Date.now();
      if (rangePrintsSinceRef.current.store !== rangePrints) rangePrintsSinceRef.current = { store: rangePrints, at: now };
      const heatmapReady = (liquidity?.columns.length ?? 0) > 0 || now - rangePrintsSinceRef.current.at >= START_FLOOR_WAIT_MS;
      const floor = rangePrints.floor ?? (heatmapReady ? startingPrintFloorFor(liquidity, instrumentIdentity) : 0);
      const viewEnd = view.toMs + intervalMs;
      if (!(floor > 0)) {
        setAggressiveProfileHeld("loading");
        return;
      }
      rangePrints.setWant({ from: Math.min(view.fromMs, now - RANGE_WARM_MS), to: Math.max(viewEnd, now), floor, focus: { from: view.fromMs, to: viewEnd } }, now);
      askRangePrints();
      const held = rangePrints.coverage(view.fromMs, viewEnd, floor, now);
      setAggressiveProfileHeld(held === null ? "whole" : held.loading ? "loading" : held.gaps.length > 0 ? "partial" : "whole");
    };
    tick();
    const timer = window.setInterval(tick, RANGE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      rangePrints.dropWant();
    };
  }, [aggressiveProfileOn, rangePrints, status, askRangePrints, deltaViewRange, liquidity, instrumentIdentity, intervalMs]);
  useEffect(() => {
    if (!liveDeltaOn || deltaProfile === null || status !== "open" || !requestDeltaProfile) return;
    const tick = () => {
      const now = Date.now();
      deltaProfile.setWindow(windowFor(instrumentIdentity, liveDeltaSettings, now, intervalMs, deltaView), now);
      // One job per connection on the host: wait while the tick profile has one out.
      if (!deltaChannelFree([volumeDeltaTickOn ? deltaTickProfile : null])) return;
      const next = deltaProfile.nextRequest(now);
      if (next) requestDeltaProfile(next);
    };
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
    // The tick profile's version is here so a channel it frees is used at once.
  }, [liveDeltaOn, deltaProfile, deltaProfileVersion, status, requestDeltaProfile, instrumentIdentity, liveDeltaSettings, intervalMs, deltaView, volumeDeltaTickOn, deltaTickProfile, deltaTickProfileVersion]);
  useEffect(() => {
    if (
      !volumeDeltaTickOn ||
      deltaTickProfile === null ||
      status !== "open" ||
      !requestDeltaProfile
    )
      return;
    const tick = () => {
      const now = Date.now();
      if (deltaView === null) return;
      // Volume Profile (Ticks) covers the candles on screen and nothing else, so
      // its window is the visible one and moves with the chart. The source says
      // how far back the host answered, which is what the legend reports.
      deltaTickProfile.setWindow(visibleWindowFor(deltaView, now), now);
      // One job per connection on the host: wait while the Live Delta Profile has one out.
      if (!deltaChannelFree([liveDeltaOn ? deltaProfile : null])) return;
      const next = deltaTickProfile.nextRequest(now);
      if (next) requestDeltaProfile(next);
    };
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [
    volumeDeltaTickOn,
    deltaTickProfile,
    deltaTickProfileVersion,
    status,
    requestDeltaProfile,
    deltaView,
    // The Live Delta Profile's version is here so a channel it frees is used at once.
    liveDeltaOn,
    deltaProfile,
    deltaProfileVersion,
  ]);
  useEffect(() => {
    const heatmapOn = passiveLiquidityEnabled && passiveLiquidityVisible;
    const levelsOn = l2SupportResistanceEnabled && l2SupportResistanceVisible;
    const bookMapOn = l2BookMapEnabled && l2BookMapVisible;
    chartRef.current?.applyLiquidity(
      heatmapOn ||
        absorptionOn ||
        levelsOn ||
        institutionalOn ||
        institutionalV2On ||
        sessionLevelsOn ||
        liquidityVoidsOn ||
        emptyOrderbookOn ||
        bookMapOn ||
        l2FeedStatusOn
        ? liquidity
        : null,
    );
  }, [
    chartRef,
    liquidity,
    passiveLiquidityEnabled,
    passiveLiquidityVisible,
    absorptionOn,
    l2SupportResistanceEnabled,
    l2SupportResistanceVisible,
    institutionalOn,
    institutionalV2On,
    sessionLevelsOn,
    liquidityVoidsOn,
    emptyOrderbookOn,
    l2BookMapEnabled,
    l2BookMapVisible,
    whaleHeatmapEnabled,
    whaleHeatmapVisible,
    l2FeedStatusOn,
  ]);
  const aggressiveTimeframeOk = isAggressiveTimeframeSupported(intervalMs);
  useEffect(() => {
    // The bubbles, and only where their cluster geometry makes sense: above the
    // aggressive timeframes MainPanel withholds the store from the primitive.
    const aggressiveOn =
      aggressiveEnabled && aggressiveVisible && aggressiveTimeframeOk;
    chartRef.current?.applyAggressiveTape(aggressiveOn ? aggressiveTape : null);
  }, [
    chartRef,
    aggressiveTape,
    aggressiveEnabled,
    aggressiveVisible,
    aggressiveTimeframeOk,
  ]);
  useEffect(() => {
    // The print store itself, for the indicators that price volume by print
    // (`ctx.ticks`, VWAP Bands among them). Handed over whenever the store
    // exists for this pair, whatever is on the chart: the timeframe a cluster is
    // measured in says nothing about whether a print happened, and hiding the
    // bubbles must not take the prints away from the indicators.
    chartRef.current?.applyTicks(aggressiveTape);
  }, [chartRef, aggressiveTape]);
  // The rule's three numbers and the heatmap settings of this market: the walls are the heatmap's walls.
  const { absorbedPercent, strongPercent, absorbedMultiple } = absorptionSettings;
  const absorptionRules = useMemo(
    () =>
      absorptionRulesFor(
        instrumentIdentity,
        { absorbedPercent, strongPercent, absorbedMultiple },
        intervalMs,
        liquiditySettings,
      ),
    [instrumentIdentity, absorbedPercent, strongPercent, absorbedMultiple, intervalMs, liquiditySettings],
  );
  // No rules while the indicator is off or hidden: its history stops asking the host and its badge goes with it.
  useEffect(() => {
    chartRef.current?.setAbsorptionRules(
      absorptionOn && aggressiveTimeframeOk ? absorptionRules : null,
    );
  }, [chartRef, absorptionRules, absorptionOn, aggressiveTimeframeOk]);
  useEffect(() => {
    chartRef.current?.setAbsorptionSettings(absorptionSettings);
  }, [chartRef, absorptionSettings]);
  const icebergUnit = sizeUnitFor(instrumentIdentity);
  const exhaustionCandleMs = exhaustionCandleMsOf(intervalMs, instrumentIdentity.assetClass);
  useEffect(() => {
    chartRef.current?.setExhaustionCandle(exhaustionCandleMs);
  }, [chartRef, exhaustionCandleMs]);
  useEffect(() => {
    chartRef.current?.setExhaustionSettings(exhaustionSettings, icebergUnit);
  }, [chartRef, exhaustionSettings, icebergUnit]);
  useEffect(() => {
    chartRef.current?.applyExhaustions(exhaustions);
  }, [chartRef, exhaustions]);
  useEffect(() => {
    chartRef.current?.applyCandleMonitor(candleMonitor);
  }, [chartRef, candleMonitor]);
  const exhaustionHistoryDays = exhaustionHistoryDaysOf(exhaustionSettings);
  const exhaustionLiveSince = exhaustions?.liveSince ?? null;
  useEffect(() => {
    if (!favorites.has("exhaustion") || exhaustionHistoryDays === 0 || status !== "open" || exhaustionLiveSince === null || !requestExhaustionHistory) return;
    requestExhaustionHistory(Date.now() - exhaustionHistoryDays * 86_400_000);
  }, [favorites, exhaustionHistoryDays, status, exhaustionLiveSince, activeInstrumentKey, requestExhaustionHistory]);
  useEffect(() => {
    if (exhaustionsVersion > 0) chartRef.current?.refreshExhaustions();
  }, [chartRef, exhaustionsVersion]);
  const initiativeCandleMs = initiativeCandleMsOf(intervalMs, instrumentIdentity.assetClass);
  useEffect(() => {
    chartRef.current?.setInitiativeCandle(initiativeCandleMs);
  }, [chartRef, initiativeCandleMs]);
  useEffect(() => {
    chartRef.current?.setInitiativeSettings(initiativeSettings);
  }, [chartRef, initiativeSettings]);
  useEffect(() => {
    chartRef.current?.applyInitiatives(initiatives);
  }, [chartRef, initiatives]);
  const initiativeHistoryDays = initiativeHistoryDaysOf(initiativeSettings);
  const initiativeLiveSince = initiatives?.liveSince ?? null;
  useEffect(() => {
    if (!favorites.has("initiative") || initiativeHistoryDays === 0 || status !== "open" || initiativeLiveSince === null || !requestInitiativeHistory) return;
    requestInitiativeHistory(Date.now() - initiativeHistoryDays * 86_400_000);
  }, [favorites, initiativeHistoryDays, status, initiativeLiveSince, activeInstrumentKey, requestInitiativeHistory]);
  useEffect(() => {
    if (initiativesVersion > 0) chartRef.current?.refreshInitiatives();
  }, [chartRef, initiativesVersion]);
  useEffect(() => {
    chartRef.current?.applyLiveRange(liveRangeOn ? liquidity : null);
  }, [chartRef, liveRangeOn, liquidity]);
  useEffect(() => {
    chartRef.current?.setLiveRangeSettings({ ...liveRangeSettings, bigPrint: liveRangeBigPrint }, liveRangeUnit);
  }, [chartRef, liveRangeSettings, liveRangeBigPrint, liveRangeUnit]);
  useEffect(() => {
    chartRef.current?.setLiveRangeWindow(liveRangeWindow);
  }, [chartRef, liveRangeWindow]);
  useEffect(() => {
    chartRef.current?.setIcebergSettings(icebergSettings, icebergUnit);
  }, [chartRef, icebergSettings, icebergUnit]);
  useEffect(() => {
    chartRef.current?.applyIcebergs(icebergs);
  }, [chartRef, icebergs]);
  useEffect(() => {
    if (icebergsVersion > 0) chartRef.current?.refreshIcebergs();
  }, [chartRef, icebergsVersion]);
  const aggressiveGroupingStep = groupingStepFor(instrumentIdentity)?.size ?? 0;
  const aggressiveRules = useMemo(
    () =>
      scaledClusterRules(aggressiveSettings, {
        intervalMs,
        step: aggressiveGroupingStep,
      }),
    [aggressiveSettings, intervalMs, aggressiveGroupingStep],
  );
  useEffect(() => {
    chartRef.current?.setAggressiveRules(aggressiveRules);
  }, [chartRef, aggressiveRules]);
  const [aggressiveLiveFloorKnown, setAggressiveLiveFloorKnown] =
    useState(false);
  useEffect(() => {
    setAggressiveLiveFloorKnown(false);
    if (aggressiveTape === null) return undefined;
    if (aggressiveTape.liveCount >= AUTO_FLOOR_MIN_PRINTS) {
      setAggressiveLiveFloorKnown(true);
      return undefined;
    }
    const stop = aggressiveTape.subscribe(() => {
      if (aggressiveTape.liveCount >= AUTO_FLOOR_MIN_PRINTS) {
        setAggressiveLiveFloorKnown(true);
        stop();
      }
    });
    return stop;
  }, [aggressiveTape]);
  const aggressiveSuggestedFloor = suggestedMinVolumeFor(instrumentIdentity);
  const aggressiveHistoryFloor = useMemo(() => {
    if (aggressiveSettings.minVolume > 0) return aggressiveSettings.minVolume;
    if (aggressiveLiveFloorKnown && aggressiveTape !== null) {
      const live = aggressiveTape.autoFloor(Date.now());
      if (live > 0) return live;
    }
    return aggressiveSuggestedFloor;
  }, [
    aggressiveSettings.minVolume,
    aggressiveLiveFloorKnown,
    aggressiveTape,
    aggressiveSuggestedFloor,
  ]);
  const [aggressiveViewFrom, setAggressiveViewFrom] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (!aggressiveEnabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = chartRef.current?.subscribeVisibleRangeChange(
      (fromMs) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(
          () =>
            setAggressiveViewFrom(
              Math.floor(fromMs / AGGRESSIVE_VIEW_STEP_MS) *
                AGGRESSIVE_VIEW_STEP_MS,
            ),
          AGGRESSIVE_VIEW_DEBOUNCE_MS,
        );
      },
    );
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [chartRef, aggressiveEnabled, activeInstrumentKey]);
  useEffect(() => {
    if (
      !aggressiveEnabled ||
      aggressiveTape === null ||
      status !== "open" ||
      !requestAggressiveHistory
    )
      return;
    const now = Date.now();
    const ask = historyRequestFor(
      aggressiveTape,
      liquidity,
      aggressiveHistoryFloor,
      historyWantedFrom(now, aggressiveViewFrom),
      now,
    );
    if (!ask) return;
    requestAggressiveHistory({
      request_id: nextAggressiveHistoryRequestId(),
      from_ts: ask.from,
      to_ts: ask.to,
      min_size: aggressiveHistoryFloor,
    });
  }, [
    aggressiveEnabled,
    aggressiveTape,
    status,
    aggressiveHistoryFloor,
    requestAggressiveHistory,
    liquidity,
    liquidityVersion,
    aggressiveViewFrom,
  ]);
  useEffect(() => {
    chartRef.current?.setAggressiveSettings(aggressiveSettings);
  }, [chartRef, aggressiveSettings]);
  const liquidityShownRef = useRef(
    passiveLiquidityEnabled && passiveLiquidityVisible,
  );
  useEffect(() => {
    const shown = passiveLiquidityEnabled && passiveLiquidityVisible;
    if (shown && !liquidityShownRef.current) requestLiquidityResync();
    liquidityShownRef.current = shown;
  }, [
    passiveLiquidityEnabled,
    passiveLiquidityVisible,
    requestLiquidityResync,
  ]);
  useEffect(() => {
    if (liquidityVersion > 0) chartRef.current?.refreshLiquidity();
  }, [chartRef, liquidityVersion]);
  useEffect(() => {
    chartRef.current?.applyL2(l2, requestL2History ?? null);
  }, [chartRef, l2, requestL2History]);
  useEffect(() => {
    chartRef.current?.applyHeatmapHistory(heatmapHistory);
  }, [chartRef, heatmapHistory]);
  useEffect(() => {
    chartRef.current?.applyColumnHistory(columnHistory);
  }, [chartRef, columnHistory]);
  useEffect(() => {
    chartRef.current?.applyHostWalls(hostWalls);
  }, [chartRef, hostWalls]);
  useEffect(() => {
    chartRef.current?.applyWhaleWalls(whaleWalls);
  }, [chartRef, whaleWalls]);
  useEffect(() => {
    if (l2Version > 0) chartRef.current?.refreshL2();
  }, [chartRef, l2Version]);
  useEffect(() => {
    if (!l2FeedStatusOn || l2 === null) return;
    const timer = window.setInterval(() => chartRef.current?.refreshL2(), 1_000);
    return () => window.clearInterval(timer);
  }, [chartRef, l2, l2FeedStatusOn]);
  useEffect(() => {
    chartRef.current?.setLiquiditySettings(liquiditySettings);
  }, [chartRef, liquiditySettings]);
  useEffect(() => {
    chartRef.current?.setLiquidityLane(liquidityLane);
  }, [chartRef, liquidityLane]);

  useEffect(() => {
    saveIndicatorFavorites(favorites);
  }, [favorites]);

  useEffect(() => {
    chartRef.current?.setIndicators([...favorites], runtimeSettingsById);
    chartRef.current?.setIndicatorVisibility(
      [...favorites].filter((id) => visibility[id] !== false),
    );
  }, [chartRef, favorites, visibility, runtimeSettingsById]);

  function toggleIndicatorVisible(id: IndicatorId) {
    setVisibility((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }

  function setIndicatorVisible(id: IndicatorId, value: boolean) {
    setVisibility((prev) => ({ ...prev, [id]: value }));
  }

  const [openSettingsId, setOpenSettingsId] = useState<IndicatorId | null>(
    null,
  );
  const largeTradeDetectorEnabled = favorites.has("largeTradeDetector");
  const largeTradeDetectorVisible = visibility.largeTradeDetector ?? true;
  const [whaleThresholdUsd, setWhaleThresholdUsd] = useState(
    savedExtras.whale.thresholdUsd,
  );
  const [whaleThresholdContracts, setWhaleThresholdContracts] = useState(
    savedExtras.whale.thresholdContracts,
  );
  const [whaleMode, setWhaleMode] = useState<WhaleDetectionMode>(
    savedExtras.whale.mode,
  );
  const [whaleTopFraction, setWhaleTopFraction] = useState(
    savedExtras.whale.topFraction,
  );
  const [whaleMinDeltaPercent, setWhaleMinDeltaPercent] = useState(
    savedExtras.whale.minDeltaPercent,
  );
  const [whaleResolvedThreshold, setWhaleResolvedThreshold] = useState<
    number | null
  >(null);
  const [whaleTruncated, setWhaleTruncated] = useState(false);
  const [whaleClusterMode, setWhaleClusterMode] = useState<WhaleClusterMode>(
    savedExtras.whale.clusterMode,
  );
  const orderFlowVisible = visibility.orderFlow ?? true;
  // TA.04: displayMode now lives in runtimeSettingsById.orderFlow (the same
  // generic settings store every settingsSchema-driven indicator uses)
  // instead of its own useState.
  const { displayMode: orderFlowDisplayMode } =
    (runtimeSettingsById.orderFlow as OrderFlowIndicatorSettings | undefined) ??
    DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS;
  const futuresMode =
    instrumentIdentity.provider === "DXFEED" &&
    instrumentIdentity.assetClass === "FUTURE";
  const whaleThreshold = futuresMode
    ? whaleThresholdContracts
    : whaleThresholdUsd;
  const feedQuiet =
    feedHealth?.printsQuiet === true &&
    feedHealth?.recoveryState !== "UNAVAILABLE";
  const feedLive =
    status === "open" &&
    feedHealth?.recoveryState === "READY" &&
    feedHealth.stale === false &&
    !feedQuiet;
  const historyWarning =
    barHistory?.availability === "UNAVAILABLE"
      ? "HISTORY UNAVAILABLE"
      : barHistory?.coverage === "START_NOT_COVERED"
        ? "HISTORY PARTIAL"
        : barHistory?.coverage === "NO_ROWS"
          ? "NO OBSERVED HISTORY"
          : null;

  function toggleFavorite(id: IndicatorId) {
    const isRemoving = favorites.has(id);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (isRemoving) {
      setIndicatorVisible(id, true);
      setOpenSettingsId((current) => (current === id ? null : current));
    }
  }

  useEffect(() => {
    let resolvedThreshold: number | null = null;
    let truncated = false;
    const stats: WhaleTradeStat[] = (() => {
      if (!largeTradeDetectorEnabled || !largeTradeDetectorVisible) return [];
      if (whaleMode === "size") {
        const kept = selectWhaleTradesBySize(markerView, whaleThreshold);
        resolvedThreshold = whaleThreshold;
        return kept;
      }
      const result = selectWhaleTradesByTopFraction(
        markerView,
        tapeTradeCount,
        whaleTopFraction,
      );
      resolvedThreshold = result.resolvedThreshold;
      truncated = result.truncated;
      return result.stats;
    })();
    setWhaleResolvedThreshold(resolvedThreshold);
    setWhaleTruncated(truncated);
    chartRef.current?.applyMarkerSnapshot(
      stats,
      intervalMs,
      whaleClusterMode,
      whaleMinDeltaPercent / 100,
    );
  }, [
    chartRef,
    markerView,
    markersVersion,
    intervalMs,
    largeTradeDetectorEnabled,
    largeTradeDetectorVisible,
    whaleMode,
    whaleThreshold,
    whaleTopFraction,
    whaleMinDeltaPercent,
    whaleClusterMode,
    tapeTradeCount,
    latestBar?.ts_open,
  ]);

  const killzonesVisible = visibility.killzones ?? true;
  const [killzoneSessions, setKillzoneSessions] = useState<Set<KillzoneId>>(
    () => new Set(savedPreferences.killzoneSessions),
  );

  useEffect(() => {
    saveHistoricalIndicatorPreferences(
      { visibility, runtimeSettingsById, killzoneSessions },
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
    );
  }, [visibility, runtimeSettingsById, killzoneSessions]);

  useEffect(() => {
    chartRef.current?.setKillzoneSessions([...killzoneSessions]);
  }, [chartRef, killzoneSessions]);

  const deltaDivergenceVisible = visibility.deltaDivergence ?? true;
  // TA.04: swingLength now lives in runtimeSettingsById.deltaDivergence
  // (the same generic settings store every settingsSchema-driven indicator
  // uses) instead of its own useState.
  const { swingLength: deltaDivergenceSwingLength } =
    (runtimeSettingsById.deltaDivergence as
      | DeltaDivergenceIndicatorSettings
      | undefined) ?? DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS;

  useEffect(() => {
    chartRef.current?.setDivergenceSettings(deltaDivergenceSwingLength);
  }, [chartRef, deltaDivergenceSwingLength]);

  // TA.04: period/pivotPeriods/distance limits live in
  // runtimeSettingsById.cvdDivergence, the same generic store every
  // settingsSchema-driven indicator uses.
  const {
    period: cvdDivergencePeriod,
    minPivotDistance: cvdDivergenceMinDistance,
    maxPivotDistance: cvdDivergenceMaxDistance,
    showCumulativeCvd: cvdDivergenceShowCumulative,
    cumulativeCvdDisplayMode: cvdDivergenceCumulativeMode,
    showCumulativeDivergences: cvdDivergenceShowCumulativeDivergences,
  } = (runtimeSettingsById.cvdDivergence as
    | CvdDivergenceIndicatorSettings
    | undefined) ?? DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS;

  useEffect(() => {
    chartRef.current?.setOrderFlowDisplayMode(orderFlowDisplayMode);
  }, [chartRef, orderFlowDisplayMode]);

  const [activeDrawingTool, setActiveDrawingTool] =
    useState<DrawingToolId | null>(null);

  useEffect(() => {
    chartRef.current?.setActiveDrawingTool(activeDrawingTool);
  }, [chartRef, activeDrawingTool]);

  const sessionProfileEnabled = favorites.has(SESSION_PROFILE_INDICATOR_ID);
  const sessionProfileVisible =
    visibility[SESSION_PROFILE_INDICATOR_ID] ?? true;
  // One settings object drives all three profile renderings: the session and
  // binning config the server needs, the palette, and which view is drawn.
  const sessionProfileSettings: SessionProfileIndicatorSettings =
    (runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID] as
      | SessionProfileIndicatorSettings
      | undefined) ?? DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS;
  const {
    view: sessionProfileView,
    mode: sessionProfileMode,
    periodMs: sessionProfilePeriodMs,
    binSizeMultiplier: sessionProfileBinSizeMultiplier,
  } = sessionProfileSettings;

  const volumeDeltaProfileOhlcVisible =
    visibility.volumeDeltaProfileOhlc ?? true;
  const volumeDeltaProfileOhlcSettings: VolumeDeltaProfileOhlcSettings =
    (runtimeSettingsById.volumeDeltaProfileOhlc as
      | VolumeDeltaProfileOhlcSettings
      | undefined) ?? DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS;

  function updateVolumeDeltaProfileOhlcSettings(
    patch: Partial<VolumeDeltaProfileOhlcSettings>,
  ) {
    const next = { ...volumeDeltaProfileOhlcSettings, ...patch };
    setRuntimeSettingsById((prev) => ({
      ...prev,
      volumeDeltaProfileOhlc: next,
    }));
    chartRef.current?.setIndicatorSettings("volumeDeltaProfileOhlc", next);
  }

  const volumeDeltaProfileTickSettings: VolumeDeltaProfileTickSettings =
    normalizeVolumeDeltaProfileTickSettings(
      runtimeSettingsById.volumeDeltaProfileTick as
        | Partial<VolumeDeltaProfileTickSettings>
        | undefined,
    );

  function updateVolumeDeltaProfileTickSettings(
    next: VolumeDeltaProfileTickSettings,
  ) {
    setRuntimeSettingsById((prev) => ({
      ...prev,
      volumeDeltaProfileTick: next,
    }));
    chartRef.current?.setIndicatorSettings("volumeDeltaProfileTick", next);
  }

  const pivotSupportResistanceVisible =
    visibility.pivotSupportResistance ?? true;
  const pivotSupportResistanceSettings: PivotSupportResistanceSettings =
    (runtimeSettingsById.pivotSupportResistance as
      | PivotSupportResistanceSettings
      | undefined) ?? DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS;

  function updatePivotSupportResistanceSettings(
    next: PivotSupportResistanceSettings,
  ) {
    setRuntimeSettingsById((prev) => ({
      ...prev,
      pivotSupportResistance: next,
    }));
    chartRef.current?.setIndicatorSettings("pivotSupportResistance", next);
  }

  const profileActive = sessionProfileEnabled && sessionProfileVisible;

  useEffect(() => {
    chartRef.current?.applyProfileFrame(profile);
  }, [chartRef, profile]);

  const vpinCloudEnabled = favorites.has("vpinCloud");
  const vpinCloudVisible = visibility.vpinCloud ?? true;
  const [vpinCloudSensitivity, setVpinCloudSensitivity] = useState(
    savedExtras.vpinSensitivity ?? DEFAULT_VPIN_SENSITIVITY,
  );
  const [vpinCloudDefaultSensitivity, setVpinCloudDefaultSensitivity] =
    useState(DEFAULT_VPIN_SENSITIVITY);
  const vpinSensitivityDerivedForKeyRef = useRef<string | null>(null);
  const vpinSensitivityUserEditedRef = useRef(
    savedExtras.vpinSensitivity !== null,
  );

  useEffect(() => {
    saveLiveIndicatorExtras({
      l2SupportResistance: l2SupportResistanceSettings,
      l2BookMap: l2BookMapSettings,
      whaleHeatmap: whaleHeatmapSettings,
      liquidityByStyle: liquiditySettingsByStyle,
      liquidityLane,
      aggressiveByInstrument: aggressiveSettingsByInstrument,
      absorptionByInstrument: absorptionSettingsByInstrument,
      icebergByInstrument: icebergSettingsByInstrument,
      exhaustionByInstrument: exhaustionSettingsByInstrument,
      initiativeByInstrument: initiativeSettingsByInstrument,
      liveRangeByInstrument: liveRangeSettingsByInstrument,
      liveDeltaByInstrument: liveDeltaSettingsByInstrument,
      liveOrderBookByInstrument: liveOrderBookSettingsByInstrument,
      aggressiveProfileByInstrument: aggressiveProfileSettingsByInstrument,
      whale: {
        thresholdUsd: whaleThresholdUsd,
        thresholdContracts: whaleThresholdContracts,
        mode: whaleMode,
        topFraction: whaleTopFraction,
        minDeltaPercent: whaleMinDeltaPercent,
        clusterMode: whaleClusterMode,
      },
      vpinSensitivity: vpinSensitivityUserEditedRef.current
        ? vpinCloudSensitivity
        : null,
    });
  }, [
    l2SupportResistanceSettings,
    l2BookMapSettings,
    whaleHeatmapSettings,
    liquiditySettingsByStyle,
    liquidityLane,
    aggressiveSettingsByInstrument,
    absorptionSettingsByInstrument,
    icebergSettingsByInstrument,
    exhaustionSettingsByInstrument,
    initiativeSettingsByInstrument,
    liveRangeSettingsByInstrument,
    liveDeltaSettingsByInstrument,
    liveOrderBookSettingsByInstrument,
    aggressiveProfileSettingsByInstrument,
    whaleThresholdUsd,
    whaleThresholdContracts,
    whaleMode,
    whaleTopFraction,
    whaleMinDeltaPercent,
    whaleClusterMode,
    vpinCloudSensitivity,
  ]);

  function handleVpinSensitivityChange(value: number) {
    vpinSensitivityUserEditedRef.current = true;
    setVpinCloudSensitivity(value);
  }

  useEffect(() => {
    if (vpinHistory.length < MIN_READINGS_FOR_DERIVED_DEFAULT) return;
    if (vpinSensitivityDerivedForKeyRef.current === activeInstrumentKey) return;
    vpinSensitivityDerivedForKeyRef.current = activeInstrumentKey;
    const derived = deriveDefaultVpinSensitivity(vpinHistory);
    setVpinCloudDefaultSensitivity(derived);
    if (!vpinSensitivityUserEditedRef.current) setVpinCloudSensitivity(derived);
  }, [vpinHistory, activeInstrumentKey]);

  const vpinCloudReadings = useMemo(
    () =>
      vpinCloudEnabled && vpinCloudVisible
        ? reapplyVpinHysteresis(vpinHistory, vpinCloudSensitivity)
        : [],
    [vpinHistory, vpinCloudSensitivity, vpinCloudEnabled, vpinCloudVisible],
  );

  useEffect(() => {
    chartRef.current?.applyVpinReadings(vpinCloudReadings);
  }, [chartRef, vpinCloudReadings]);

  useEffect(() => {
    chartRef.current?.setSessionProfileSettings(sessionProfileSettings);
  }, [chartRef, sessionProfileSettings]);

  const sessionDeltaProfileSettings: SessionDeltaProfileSettings =
    (runtimeSettingsById.sessionDeltaProfile as
      | SessionDeltaProfileSettings
      | undefined) ?? DEFAULT_SESSION_DELTA_PROFILE_SETTINGS;

  useEffect(() => {
    chartRef.current?.setSessionDeltaProfileSettings(
      sessionDeltaProfileSettings,
    );
  }, [chartRef, sessionDeltaProfileSettings]);

  useEffect(() => {
    if (status !== "open" || !profileActive) return;
    sendProfileConfig({
      mode: sessionProfileMode,
      period_ms:
        sessionProfileMode === "continuous" ? sessionProfilePeriodMs : intervalMs,
      bin_size_multiplier: sessionProfileBinSizeMultiplier,
      range_start_ts: null,
      range_end_ts: null,
    });
  }, [
    sendProfileConfig,
    profileActive,
    sessionProfileMode,
    sessionProfilePeriodMs,
    sessionProfileBinSizeMultiplier,
    intervalMs,
    status,
    activeInstrumentKey,
  ]);

  const currentZonePeriodMs =
    sessionProfileMode === "continuous" ? sessionProfilePeriodMs : intervalMs;
  const fetchedZonesRef = useRef<Set<number>>(new Set());
  const manualZonesRef = useRef<Set<number>>(new Set());
  const profileHistoryRequestIdRef = useRef(0);
  const [visibleZoneStarts, setVisibleZoneStarts] = useState<Set<number>>(
    () => new Set(),
  );

  useEffect(() => {
    profileHistoryRequestIdRef.current += 1;
    fetchedZonesRef.current = new Set();
    manualZonesRef.current = new Set();
    setVisibleZoneStarts(new Set());
  }, [
    currentZonePeriodMs,
    activeInstrumentKey,
    sessionProfileMode,
    sessionProfileBinSizeMultiplier,
  ]);

  useEffect(() => {
    if (status !== "open" || !profileActive) return undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const requestVisibleZones = (fromMs: number, toMs: number) => {
      const excludeFromMs = profile?.period_start_ts ?? toMs;
      const blocks = alignedPeriodBoundaries(
        fromMs,
        toMs,
        currentZonePeriodMs,
        excludeFromMs,
      ).filter(
        (block) =>
          block.rangeEndTs - block.rangeStartTs === currentZonePeriodMs,
      );
      const visibleStarts = new Set(blocks.map((block) => block.rangeStartTs));
      // Zones that scroll out of view are KEPT, not forgotten.
      //
      // Forgetting them meant panning back re-requested every zone, and at 1m
      // per-candle a request is up to 50 separate profile reads -- so a zone
      // vanished on scroll-away and took seconds to reappear on scroll-back.
      //
      // `visibleZoneStarts` (which gates RENDERING) stays view-scoped, so an
      // off-screen zone still stops drawing. Only this remember-we-already-have-
      // it bookkeeping persists.
      //
      // The cap is the frame buffer's own bound, imported rather than chosen, so
      // the set can never outlive the frames it refers to: if we keep at most N
      // starts and useMarketData keeps at most N frames, and frames are only
      // added for zones asked for here, this set cannot exceed what is held.
      // Dropping the OLDEST off-screen starts is what keeps it under that.
      if (fetchedZonesRef.current.size > MAX_RETAINED_HISTORICAL_ZONES) {
        const droppable = [...fetchedZonesRef.current]
          .filter(
            (start) =>
              !visibleStarts.has(start) && !manualZonesRef.current.has(start),
          )
          .sort((a, b) => a - b);
        for (const start of droppable) {
          if (fetchedZonesRef.current.size <= MAX_RETAINED_HISTORICAL_ZONES) {
            break;
          }
          fetchedZonesRef.current.delete(start);
        }
      }
      setVisibleZoneStarts(visibleStarts);
      const pending = blocks.filter(
        (block) => !fetchedZonesRef.current.has(block.rangeStartTs),
      );
      if (pending.length === 0) return;
      for (const block of pending)
        fetchedZonesRef.current.add(block.rangeStartTs);
      sendProfileHistory({
        mode: sessionProfileMode,
        request_id: profileHistoryRequestIdRef.current,
        period_ms: currentZonePeriodMs,
        bin_size_multiplier: sessionProfileBinSizeMultiplier,
        ranges: pending.map((block) => ({
          range_start_ts: block.rangeStartTs,
          range_end_ts: block.rangeEndTs,
        })),
      });
    };

    const unsubscribe = chartRef.current?.subscribeVisibleRangeChange(
      (fromMs, toMs) => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(
          () => requestVisibleZones(fromMs, toMs),
          HISTORICAL_ZONE_DEBOUNCE_MS,
        );
      },
    );

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      unsubscribe?.();
    };
  }, [
    chartRef,
    profileActive,
    currentZonePeriodMs,
    sessionProfileMode,
    profile?.period_start_ts,
    sendProfileHistory,
    sessionProfileBinSizeMultiplier,
    status,
    activeInstrumentKey,
  ]);

  useEffect(() => {
    if (!profileActive) {
      chartRef.current?.applyHistoricalProfiles([]);
      return;
    }
    const activeHistoryRequestId = profileHistoryRequestIdRef.current;
    const visible = historicalProfiles.filter((zone) => {
      if (zone.delivery_scope === "HISTORICAL") {
        return (
          zone.history_request_id === activeHistoryRequestId &&
          visibleZoneStarts.has(zone.period_start_ts)
        );
      }
      return (
        zone.delivery_scope === "FIXED_RANGE" &&
        manualZonesRef.current.has(zone.period_start_ts)
      );
    });
    chartRef.current?.applyHistoricalProfiles(visible);
  }, [
    chartRef,
    historicalProfiles,
    visibleZoneStarts,
    profileActive,
    currentZonePeriodMs,
  ]);

  return (
    <div className={`main-panel-layout${rightPanelOpen ? "" : " right-panel-closed"}`}>
      <div className="chart-area">
        <div className="chart-toolbar">
          <TimeframeMenu
            selectedId={
              TIMEFRAMES.find(
                (timeframe) => timeframe.intervalMs === intervalMs,
              )?.label ?? "1m"
            }
            onTimeframeSelect={(label) => {
              const timeframe = TIMEFRAMES.find(
                (candidate) => candidate.label === label,
              );
              if (timeframe !== undefined)
                onTimeframeSelect(timeframe.intervalMs);
            }}
          />
          <DrawingToolbar
            activeTool={activeDrawingTool}
            onSelectTool={setActiveDrawingTool}
          />
          {historyWarning && (
            <span
              className="history-warning"
              role="status"
              title={historyDisclosure(barHistory)}
            >
              {historyWarning}
            </span>
          )}
          <div className="toolbar-spacer" />
          {displayBar && (
            <div className="ohlc-readout tabular">
              O <b>{displayBar.open.toFixed(2)}</b>H{" "}
              <b className="o-up">{displayBar.high.toFixed(2)}</b>L{" "}
              <b className="o-down">{displayBar.low.toFixed(2)}</b>C{" "}
              <b className={up ? "o-up" : "o-down"}>
                {displayBar.close.toFixed(2)}
              </b>
            </div>
          )}
          <div className="chart-toolbar-end">
          <IndicatorsMenu
            active={favorites}
            onToggleActive={toggleFavorite}
          />
          <button ref={dockToggleRef} type="button" className="side-toggle" onClick={() => setRightPanelOpen((open) => !open)} aria-expanded={rightPanelOpen} aria-controls="terminal-right-dock" aria-label={rightPanelOpen ? "Hide right panel" : "Show right panel"} title={rightPanelOpen ? "Hide right panel" : "Show right panel"}>
            <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M12 3v14" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
          </div>
        </div>
        <div className="chart-canvas-wrap">
          <div className="chart-badge">
            {feedLive && <span className="live-tag">LIVE</span>}
            {favoritesList.map((id) => {
              const label =
                INDICATOR_REGISTRY.find((def) => def.id === id)?.label ?? id;
              const visible = visibility[id] ?? true;
              const onToggleVisible = () => toggleIndicatorVisible(id);
              const onRemove = () => toggleFavorite(id);
              if (id === "largeTradeDetector") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      whaleMode === "topPercent"
                        ? `top ${(whaleTopFraction * 100).toFixed(2)}%`
                        : futuresMode
                          ? `≥ ${whaleThresholdContracts} ct`
                          : `≥ ${formatUsd(whaleThresholdUsd)}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() =>
                      setOpenSettingsId("largeTradeDetector")
                    }
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "killzones") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("killzones")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "deltaDivergence") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`Swing ${deltaDivergenceSwingLength}`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("deltaDivergence")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "cvdDivergence") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`CVD ${cvdDivergencePeriod} · bars ${cvdDivergenceMinDistance}-${cvdDivergenceMaxDistance}${cvdDivergenceShowCumulativeDivergences ? " · cum DiV" : ""}${cvdDivergenceShowCumulative ? ` · cum ${cvdDivergenceCumulativeMode === "candles" ? "candles" : "line"}` : ""}`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("cvdDivergence")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === SESSION_PROFILE_INDICATOR_ID) {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`${sessionProfileViewLabel(sessionProfileView)} · ${
                      sessionProfileMode === "continuous"
                        ? `Continuous ${PERIOD_LABELS[sessionProfilePeriodMs] ?? `${Math.round(sessionProfilePeriodMs / 60_000)}m`}`
                        : "Per-Candle"
                    }`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() =>
                      setOpenSettingsId(SESSION_PROFILE_INDICATOR_ID)
                    }
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "vpinCloud") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`${vpinStatus === "WARMING" ? "Warming · " : vpinStatus === "UNAVAILABLE" ? "Unavailable · " : ""}≥ ${vpinCloudSensitivity.toFixed(2)}z`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("vpinCloud")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "passiveLiquidity") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      liquidity === null || liquidity.columns.length === 0
                        ? status === "open"
                          ? "waiting for L2 memory"
                          : "reconnecting"
                        : `${status === "open" ? "" : "reconnecting · last "}${liquiditySpan} · rows ${liquidity.rowWidth * 2 ** liquidityDrawnLane}${liquidityDrawnLane > 0 ? ` (x${2 ** liquidityDrawnLane})` : ""}${historyLegend(liquidityHistory)}${liquiditySettings.scaleMode === "fixed" ? ` · scale ${liquiditySettings.scaleSize}` : ""}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("passiveLiquidity")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "l2SupportResistance") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`top ${l2SupportResistanceSettings.maxLevels} · ${l2SupportResistanceSettings.lookbackMinutes}m`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() =>
                      setOpenSettingsId("l2SupportResistance")
                    }
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "l2BookMap") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={`bins ${l2BookMapSettings.priceBinRows}x${Math.max(1, Math.round(intervalMs / 1000))}s · ${l2BookMapSettings.windowBuckets} buckets`}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("l2BookMap")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "whaleLimitOrderHeatmap") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={whaleLegendDetail(whaleHeatmapSettings, instrumentIdentity.provider === "BINANCE" ? instrumentIdentity.marketKind : "", instrumentIdentity.symbol)}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("whaleLimitOrderHeatmap")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "aggressiveOrders") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      !aggressiveTimeframeOk
                        ? "off above 4h"
                        : aggressiveTape === null
                          ? status === "open"
                            ? "waiting for prints"
                            : "reconnecting"
                          : `${aggressiveSettings.minVolume > 0 ? `orders ≥ ${aggressiveSettings.minVolume}` : "biggest orders, automatic"}${historyNoteFor(aggressiveHistoryIssue)}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("aggressiveOrders")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "liveDeltaProfile") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      deltaProfile === null
                        ? status === "open"
                          ? "waiting for trades"
                          : "reconnecting"
                        : `${deltaProfile.rows().length} rows · ${windowFor(instrumentIdentity, liveDeltaSettings, Date.now(), intervalMs, deltaView).label}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("liveDeltaProfile")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "aggressiveOrdersProfile") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={liquidity === null ? (status === "open" ? "waiting for the book" : "reconnecting") : rangePrints === null ? "the candles on screen" : aggressiveProfileHeld === "loading" ? "loading the view's prints" : aggressiveProfileHeld === "partial" ? "some of the view's prints are missing" : "the candles on screen"}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("aggressiveOrdersProfile")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "liveOrderBookProfile") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      bookProfileSource === null || !bookProfileSource.live(Date.now())
                        ? status === "open"
                          ? "waiting for the book"
                          : "reconnecting"
                        : `${bookProfileSource.bands(clusterRowsOf(liveOrderBookSettings, liquiditySettings, intervalMs)).length} rows`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("liveOrderBookProfile")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "absorptionDetector") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      !aggressiveTimeframeOk
                        ? "off above 4h"
                        : liquidity === null
                          ? status === "open"
                            ? "waiting for the columns"
                            : "reconnecting"
                          : `${absorptionRules.absorbedPercent}% of the wall · ${absorptionRules.absorbedMultiple}× the book's level`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() =>
                      setOpenSettingsId("absorptionDetector")
                    }
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "exhaustion") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      exhaustionCandleMs === null
                        ? "no engine at this timeframe"
                        : exhaustions === null
                          ? status === "open"
                            ? "waiting for the runtime"
                            : "reconnecting"
                          : !exhaustions.trusted()
                            ? "untrusted until the next page"
                            : `${shownShades(exhaustions.list(), exhaustionSettings, exhaustionCandleMs, Date.now()).length} shown${exhaustionHistoryDaysOf(exhaustionSettings) === 0 && exhaustions.liveSince !== null ? ` · live since ${exhaustionLiveSinceText(exhaustions.liveSince)}` : ""}${exhaustions.loading !== null ? ` · loading ${exhaustionLoadingLabel(exhaustions.loading, exhaustions.lastTs)} of history` : ""}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("exhaustion")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "initiative") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      initiativeCandleMs === null
                        ? "no engine at this timeframe"
                        : initiatives === null
                          ? status === "open"
                            ? "waiting for the runtime"
                            : "reconnecting"
                          : !initiatives.trusted()
                            ? "untrusted until the next page"
                            : `${shownBands(initiatives.list(), initiativeSettings, initiativeCandleMs, Date.now()).length} shown${initiativeHistoryDaysOf(initiativeSettings) === 0 && initiatives.liveSince !== null ? ` · live since ${exhaustionLiveSinceText(initiatives.liveSince)}` : ""}${initiatives.loading !== null ? ` · loading ${exhaustionLoadingLabel(initiatives.loading, initiatives.lastTs)} of history` : ""}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("initiative")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "liveRangeControl") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={liquidity === null ? (status === "open" ? "waiting for the book" : "reconnecting") : liveRangeLegend()}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("liveRangeControl")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "icebergDetector") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={
                      icebergs === null
                        ? status === "open"
                          ? "waiting for the feed"
                          : "reconnecting"
                        : !icebergs.trusted()
                          ? "untrusted until the next page"
                          : `${instrumentIdentity.provider === "BINANCE" ? "probable" : "native"} · ${icebergs.size} held${icebergHistoryDaysOf(icebergSettings) === 0 ? (icebergs.liveSince === null ? "" : ` · live since ${icebergHistoryFromText(icebergs.liveSince)}`) : icebergs.historyFrom === null ? "" : ` · watched from ${icebergHistoryFromText(icebergs.historyFrom)}`}`
                    }
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("icebergDetector")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "orderFlow") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={orderFlowProvenance(instrumentIdentity)}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId("orderFlow")}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "largeTradeBubbles") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail="Live only · 20 bars required"
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId(id)}
                    onRemove={onRemove}
                  />
                );
              }
              if (id === "sessionVwap") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail="Bar volume × typical price"
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId(id)}
                    onRemove={onRemove}
                  />
                );
              }
              const runtimeDef = INDICATOR_REGISTRY.find(
                (def) => def.id === id,
              );
              if (id === "volumeDeltaProfileTick") {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    detail={truncatedProfileLegend(
                      volumeDeltaProfileTickTruncatedFrom,
                    )}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId(id)}
                    onRemove={onRemove}
                  />
                );
              }
              if (runtimeDef?.kind === "runtime" && runtimeDef.settingsSchema) {
                return (
                  <IndicatorLegendRow
                    key={id}
                    label={label}
                    visible={visible}
                    onToggleVisible={onToggleVisible}
                    onOpenSettings={() => setOpenSettingsId(id)}
                    onRemove={onRemove}
                  />
                );
              }
              return (
                <IndicatorLegendRow
                  key={id}
                  label={label}
                  visible={visible}
                  onToggleVisible={onToggleVisible}
                  onRemove={onRemove}
                />
              );
            })}
          </div>
          <ChartPanel
            ref={chartRef}
            instrumentIdentity={instrumentIdentity}
            onLiveDeltaReachChange={(share) => setLiveDeltaSettings({ ...liveDeltaSettings, widthShare: share })}
            onLiveOrderBookReachChange={(share) => setLiveOrderBookSettings({ ...liveOrderBookSettings, widthShare: share })}
            onLiveRangeWindowChange={setLiveRangeWindow}
            onLiquidityLadderReachChange={(share) => setLiquiditySettings({ ...liquiditySettings, ladderReach: share })}
            onVolumeDeltaProfileOhlcWidthChange={(widthPx) => updateVolumeDeltaProfileOhlcSettings({ profileWidth: widthPx })}
            onVolumeDeltaProfileTickTruncatedFrom={setVolumeDeltaProfileTickTruncatedFrom}
            onLiquidityLaneDrawn={setLiquidityDrawnLane}
            onLiquidityHistoryDrawn={setLiquidityHistory}
            onFixedRangeProfileRequested={(rangeStartTs, rangeEndTs) => {
              manualZonesRef.current.add(rangeStartTs);
              sendProfileConfig({
                mode: "fixed_range",
                period_ms: null,
                bin_size_multiplier: sessionProfileBinSizeMultiplier,
                range_start_ts: rangeStartTs,
                range_end_ts: rangeEndTs,
              });
            }}
          />
          {RUNTIME_INDICATOR_DEFS.filter(
            (def) => def.settingsSchema && def.id !== "pivotSupportResistance",
          ).map((def) => {
            // Order Flow and Delta Divergence's own bespoke modals each had a
            // "Show on chart" checkbox as part of their own settings body,
            // not just the external legend-row eye icon -- reproduced here
            // rather than dropped, matching every other opt-in indicator's
            // established UI exactly. Session Volume Profile's own schema
            // carries the same control.
            const hasOwnVisibilityControl =
              def.id === SESSION_PROFILE_INDICATOR_ID ||
              def.id === "orderFlow" ||
              def.id === "deltaDivergence";
            const currentVisible =
              def.id === SESSION_PROFILE_INDICATOR_ID
                ? sessionProfileVisible
                : def.id === "orderFlow"
                  ? orderFlowVisible
                  : deltaDivergenceVisible;
            const modalSettings =
              runtimeSettingsById[def.id] ?? def.defaultSettings;
            return (
              <GenericIndicatorSettingsModal
                key={def.id}
                isOpen={openSettingsId === def.id}
                onClose={() => setOpenSettingsId(null)}
                title={def.label}
                schema={settingsSchemaFor(def, instrumentIdentity)}
                settings={modalSettings}
                defaultSettings={def.defaultSettings}
                presetKey={def.id}
                instrumentKey={activeInstrumentKey}
                visible={hasOwnVisibilityControl ? currentVisible : undefined}
                onVisibleChange={
                  hasOwnVisibilityControl
                    ? (value) => setIndicatorVisible(def.id, value)
                    : undefined
                }
                defaultVisible={hasOwnVisibilityControl ? true : undefined}
                onChange={(next) => {
                  setRuntimeSettingsById((prev) => ({
                    ...prev,
                    [def.id]: next,
                  }));
                  chartRef.current?.setIndicatorSettings(
                    def.id as IndicatorId,
                    next,
                  );
                }}
              />
            );
          })}
          <WhaleDetectorSettingsModal
            isOpen={openSettingsId === "largeTradeDetector"}
            onClose={() => setOpenSettingsId(null)}
            mode={whaleMode}
            onModeChange={setWhaleMode}
            topFraction={whaleTopFraction}
            onTopFractionChange={setWhaleTopFraction}
            resolvedThreshold={whaleResolvedThreshold}
            truncated={whaleTruncated}
            minDeltaPercent={whaleMinDeltaPercent}
            onMinDeltaPercentChange={setWhaleMinDeltaPercent}
            threshold={whaleThreshold}
            thresholdUnit={futuresMode ? "CONTRACTS" : "USD"}
            onThresholdChange={
              futuresMode ? setWhaleThresholdContracts : setWhaleThresholdUsd
            }
            clusterMode={whaleClusterMode}
            onClusterModeChange={setWhaleClusterMode}
            visible={largeTradeDetectorVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("largeTradeDetector", value)
            }
          />
          <VolumeProfileOhlcSettingsModal
            isOpen={openSettingsId === "volumeDeltaProfileOhlc"}
            onClose={() => setOpenSettingsId(null)}
            settings={volumeDeltaProfileOhlcSettings}
            onSettingsChange={updateVolumeDeltaProfileOhlcSettings}
            visible={volumeDeltaProfileOhlcVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("volumeDeltaProfileOhlc", value)
            }
          />
          <VolumeDeltaProfileTickSettingsModal
            isOpen={openSettingsId === "volumeDeltaProfileTick"}
            onClose={() => setOpenSettingsId(null)}
            settings={volumeDeltaProfileTickSettings}
            onSettingsChange={updateVolumeDeltaProfileTickSettings}
            visible={volumeDeltaProfileTickVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("volumeDeltaProfileTick", value)
            }
          />
          <PivotSupportResistanceSettingsModal
            isOpen={openSettingsId === "pivotSupportResistance"}
            onClose={() => setOpenSettingsId(null)}
            settings={pivotSupportResistanceSettings}
            defaultSettings={DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS}
            onSettingsChange={updatePivotSupportResistanceSettings}
            visible={pivotSupportResistanceVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("pivotSupportResistance", value)
            }
          />
          <VpinCloudSettingsModal
            isOpen={openSettingsId === "vpinCloud"}
            onClose={() => setOpenSettingsId(null)}
            sensitivity={vpinCloudSensitivity}
            defaultSensitivity={vpinCloudDefaultSensitivity}
            onSensitivityChange={handleVpinSensitivityChange}
            visible={vpinCloudVisible}
            onVisibleChange={(value) => setIndicatorVisible("vpinCloud", value)}
          />
          <LiquidityHeatmapSettingsModal
            isOpen={openSettingsId === "passiveLiquidity"}
            onClose={() => setOpenSettingsId(null)}
            market={liquidityStyle.market}
            unit={liquidity?.baseAsset ?? ""}
            typicalSize={liquidity?.referenceSize ?? 0}
            intervalMs={intervalMs}
            settings={liquiditySettings}
            defaults={liquidityStyle.defaultSettings}
            onSettingsChange={setLiquiditySettings}
            lane={liquidityLane}
            onLaneChange={setLiquidityLane}
            presetScope={liquidityStyle.name}
            visible={passiveLiquidityVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("passiveLiquidity", value)
            }
          />
          <L2SupportResistanceSettingsModal
            isOpen={openSettingsId === "l2SupportResistance"}
            onClose={() => setOpenSettingsId(null)}
            settings={l2SupportResistanceSettings}
            onSettingsChange={setL2SupportResistanceSettings}
            visible={l2SupportResistanceVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("l2SupportResistance", value)
            }
            unit={liquidity?.baseAsset ?? ""}
          />
          <L2BookMapSettingsModal
            isOpen={openSettingsId === "l2BookMap"}
            onClose={() => setOpenSettingsId(null)}
            settings={l2BookMapSettings}
            onSettingsChange={setL2BookMapSettings}
            visible={l2BookMapVisible}
            onVisibleChange={(value) => setIndicatorVisible("l2BookMap", value)}
            intervalMs={intervalMs}
          />
          <WhaleHeatmapSettingsModal
            isOpen={openSettingsId === "whaleLimitOrderHeatmap"}
            onClose={() => setOpenSettingsId(null)}
            settings={whaleHeatmapSettings}
            onSettingsChange={setWhaleHeatmapSettings}
            visible={whaleHeatmapVisible}
            onVisibleChange={(value) => setIndicatorVisible("whaleLimitOrderHeatmap", value)}
          />
          <LiveDeltaProfileSettingsModal
            isOpen={openSettingsId === "liveDeltaProfile"}
            onClose={() => setOpenSettingsId(null)}
            settings={liveDeltaSettings}
            onSettingsChange={setLiveDeltaSettings}
            visible={liveDeltaVisible}
            onVisibleChange={(value) => setIndicatorVisible("liveDeltaProfile", value)}
            rowWidth={deltaProfile?.rowWidth ?? 1}
            intervalMs={intervalMs}
            presetScope={activeInstrumentKey}
          />
          <AggressiveProfileSettingsModal
            isOpen={openSettingsId === "aggressiveOrdersProfile"}
            onClose={() => setOpenSettingsId(null)}
            settings={aggressiveProfileSettings}
            onSettingsChange={setAggressiveProfileSettings}
            visible={aggressiveProfileVisible}
            onVisibleChange={(value) => setIndicatorVisible("aggressiveOrdersProfile", value)}
            typicalFloor={openSettingsId === "aggressiveOrdersProfile" ? (rangePrints?.floor ?? startingPrintFloorFor(liquidity, instrumentIdentity)) : 0}
            instrument={instrumentIdentity}
            sizeUnit={liquidity?.baseAsset ?? ""}
            presetScope={activeInstrumentKey}
          />
          <LiveOrderBookProfileSettingsModal
            isOpen={openSettingsId === "liveOrderBookProfile"}
            onClose={() => setOpenSettingsId(null)}
            settings={liveOrderBookSettings}
            onSettingsChange={setLiveOrderBookSettings}
            visible={liveOrderBookVisible}
            onVisibleChange={(value) => setIndicatorVisible("liveOrderBookProfile", value)}
            heatmapSettings={liquiditySettings}
            rowWidth={liquidity?.rowWidth || 1}
            intervalMs={intervalMs}
            typicalSize={bookProfileSource?.typicalSize() ?? 0}
            sizeUnit={liquidity?.baseAsset ?? ""}
            presetScope={activeInstrumentKey}
          />
          <AggressiveOrdersSettingsModal
            isOpen={openSettingsId === "aggressiveOrders"}
            onClose={() => setOpenSettingsId(null)}
            settings={aggressiveSettings}
            onSettingsChange={setAggressiveSettings}
            defaults={aggressiveDefaults}
            visible={aggressiveVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("aggressiveOrders", value)
            }
            identity={instrumentIdentity}
            intervalMs={intervalMs}
            unit={liquidity?.baseAsset ?? ""}
            suggestion={suggestedMinVolumeFor(instrumentIdentity)}
            presetScope={activeInstrumentKey}
          />
          <AbsorptionSettingsModal
            isOpen={openSettingsId === "absorptionDetector"}
            onClose={() => setOpenSettingsId(null)}
            settings={absorptionSettings}
            onSettingsChange={setAbsorptionSettings}
            defaults={absorptionDefaults}
            visible={absorptionVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("absorptionDetector", value)
            }
            presetScope={activeInstrumentKey}
          />
          <ExhaustionSettingsModal
            isOpen={openSettingsId === "exhaustion"}
            onClose={() => setOpenSettingsId(null)}
            settings={exhaustionSettings}
            onSettingsChange={setExhaustionSettings}
            defaults={DEFAULT_EXHAUSTION_SETTINGS}
            visible={exhaustionVisible}
            onVisibleChange={(value) => setIndicatorVisible("exhaustion", value)}
            presetScope={activeInstrumentKey}
          />
          <InitiativeSettingsModal
            isOpen={openSettingsId === "initiative"}
            onClose={() => setOpenSettingsId(null)}
            settings={initiativeSettings}
            onSettingsChange={setInitiativeSettings}
            defaults={DEFAULT_INITIATIVE_SETTINGS}
            visible={initiativeVisible}
            onVisibleChange={(value) => setIndicatorVisible("initiative", value)}
            presetScope={activeInstrumentKey}
          />
          <LiveRangeSettingsModal
            isOpen={openSettingsId === "liveRangeControl"}
            onClose={() => setOpenSettingsId(null)}
            settings={liveRangeSettings}
            onSettingsChange={setLiveRangeSettings}
            defaults={DEFAULT_LIVE_RANGE_SETTINGS}
            visible={liveRangeVisible}
            onVisibleChange={(value) => setIndicatorVisible("liveRangeControl", value)}
            window={liveRangeWindow}
            onWindowChange={setLiveRangeWindow}
            scale={liveRangeScale}
            unit={liveRangeUnit}
            presetScope={activeInstrumentKey}
          />
          <IcebergSettingsModal
            isOpen={openSettingsId === "icebergDetector"}
            onClose={() => setOpenSettingsId(null)}
            settings={icebergSettings}
            onSettingsChange={setIcebergSettings}
            defaults={DEFAULT_ICEBERG_SETTINGS}
            visible={icebergVisible}
            onVisibleChange={(value) =>
              setIndicatorVisible("icebergDetector", value)
            }
            identity={instrumentIdentity}
            presetScope={activeInstrumentKey}
          />
          <KillzonesSettingsModal
            isOpen={openSettingsId === "killzones"}
            onClose={() => setOpenSettingsId(null)}
            visible={killzonesVisible}
            onVisibleChange={(value) => setIndicatorVisible("killzones", value)}
            selectedSessions={killzoneSessions}
            onSessionChange={(sessionId, selected) => {
              setKillzoneSessions((previous) => {
                const next = new Set(previous);
                if (selected) next.add(sessionId);
                else next.delete(sessionId);
                return next;
              });
            }}
          />
          {(status !== "open" ||
            latestBar === null ||
            (backendDegraded && !feedQuiet)) && (
            <div className="chart-overlay">
              {(() => {
                if (status === "closed")
                  return (
                    <>
                      <span className="dot closed" />
                      Disconnected
                    </>
                  );
                if (status === "connecting")
                  return (
                    <>
                      <span className="dot connecting" />
                      Connecting to feed…
                    </>
                  );
                if (
                  feedHealth?.recoveryState === "UNAVAILABLE" &&
                  feedHealth.reason === "DXFEED_NOT_CONFIGURED"
                )
                  return (
                    <>
                      <span className="dot quiet" />
                      History only · dxFeed live not configured
                    </>
                  );
                if (feedHealth?.recoveryState === "UNAVAILABLE")
                  return (
                    <>
                      <span className="dot unavailable" />
                      Feed unavailable
                      {feedHealth.reason ? ` (${feedHealth.reason})` : ""}
                    </>
                  );
                if (feedQuiet)
                  return (
                    <>
                      <span className="dot quiet" />
                      Market quiet — no recent prints
                    </>
                  );
                if (feedHealth?.recoveryState === "RECOVERING")
                  return (
                    <>
                      <span className="dot recovering" />
                      Recovering feed…
                    </>
                  );
                if (feedStale)
                  return (
                    <>
                      <span className="dot stale" />
                      Feed stale
                    </>
                  );
                return (
                  <>
                    <span className="dot connecting" />
                    Waiting for history…
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>
      <div className={`side-panels${rightPanelOpen ? "" : " side-panels-closed"}`} id="terminal-right-dock">
        <div className="side-panel-head">
        <div className="side-panel-tabs" role="tablist" aria-label="Right panel">
          <button id="right-tab-market" type="button" role="tab" tabIndex={rightPanel === "market" ? 0 : -1} aria-selected={rightPanel === "market"} aria-controls="right-panel-market" className={rightPanel === "market" ? "active" : ""} onClick={() => setRightPanel("market")} onKeyDown={onDockKeyDown}>Book &amp; tape</button>
          <button id="right-tab-watchlist" type="button" role="tab" tabIndex={rightPanel === "watchlist" ? 0 : -1} aria-selected={rightPanel === "watchlist"} aria-controls="right-panel-watchlist" className={rightPanel === "watchlist" ? "active" : ""} onClick={() => setRightPanel("watchlist")} onKeyDown={onDockKeyDown}>Watchlist</button>
        </div>
        <button type="button" className="side-panel-close" onClick={closeDockFromInside} aria-label="Close right panel" title="Close right panel">×</button>
        </div>
        <div className="side-panel-content" role="tabpanel" id="right-panel-market" aria-labelledby="right-tab-market" hidden={rightPanel !== "market"}>
          <DomPanel
            book={book}
            lastPrice={lastPrice}
            lastTickDirection={lastTickDirection}
            futuresMode={futuresMode}
          />
          <TapePanel trades={trades} instrumentIdentity={instrumentIdentity} />
        </div>
        <div className="side-panel-content" role="tabpanel" id="right-panel-watchlist" aria-labelledby="right-tab-watchlist" hidden={rightPanel !== "watchlist"}>
          <WatchlistPanel selection={instrumentIdentity} lastPrice={watchlistPrice} live={status === "open" && !backendDegraded} onSelect={onSelectWatchInstrument} />
        </div>
      </div>
    </div>
  );
}
