import { useEffect, useMemo, useRef, useState } from "react";
import { ChartPanel, type ChartPanelHandle } from "../chart/ChartPanel";
import { HistoricalWatchlistPanel } from "./HistoricalWatchlistPanel";
import { HistoricalL2Settings } from "./HistoricalL2Settings";
import { HISTORICAL_L2_SETTINGS_IDS } from "../../lib/archive/historicalL2Settings";
import { dockOpenByDefault } from "../chrome/dock";
import { IndicatorLegendRow } from "../chrome/IndicatorLegendRow";
import { TimeframeMenu } from "../chrome/TimeframeMenu";
import { GenericIndicatorSettingsModal } from "../GenericIndicatorSettingsModal";
import { HISTORICAL_PRESET_SCOPE, presetKeyFor } from "../../lib/chart/indicatorPresets";
import { KillzonesSettingsModal } from "../../lib/indicators/killzones/KillzonesSettingsModal";
import type { KillzoneId } from "../../lib/indicators/killzones/killzones";
import {
  CANDLE_FLOW_INDICATOR_IDS as CANDLE_FLOW_INDICATORS,
  INDICATOR_REGISTRY,
  RUNTIME_INDICATOR_DEFS,
  historicalIndicatorAvailability,
  type IndicatorId,
} from "../../lib/chart/indicatorRegistry";
import {
  loadIndicatorFavorites,
  saveIndicatorFavorites,
} from "../../lib/chart/indicatorFavorites";
import {
  loadHistoricalIndicatorPreferences,
  saveHistoricalIndicatorPreferences,
} from "../../lib/chart/historicalIndicatorPreferences";
import { indicatorFamily } from "../../lib/chart/indicatorFamily";
import {
  HISTORICAL_INSTRUMENT_GROUPS,
  HISTORICAL_INSTRUMENTS,
  type HistoricalInstrument,
} from "../../lib/archive/historicalCatalog";
import {
  DEFAULT_HISTORICAL_TIMEFRAME_ID,
  HISTORICAL_TIMEFRAMES,
  historicalTimeframeById,
  type HistoricalTimeframe,
} from "../../lib/archive/historicalTimeframes";
import {
  useArchivePage,
  type ArchivePageLoad,
} from "../../lib/archive/useArchivePage";
import { useArchiveStudies } from "../../lib/archive/useArchiveStudies";
import { useHistoricalL2 } from "../../lib/archive/useHistoricalL2";
import { useArchiveTradeAvailability } from "../../lib/archive/useArchiveTradeAvailability";
import { ARCHIVE_MIN_BIN_SIZE_MULTIPLIER } from "../../lib/archive/archiveStudyClient";
import {
  archiveStudiesSupported,
  studyAssetClass,
} from "../../lib/archive/archiveStudyPlan";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  type SessionProfileIndicatorSettings,
} from "../../lib/indicators/session-profile/sessionProfileSettings";
import { SESSION_PROFILE_INDICATOR_ID } from "../../lib/indicators/session-profile/sessionProfileIds";
import { WhaleDetectorSettingsModal } from "../../lib/indicators/whale-detector/WhaleDetectorSettingsModal";
import type { WhaleClusterMode } from "../../lib/indicators/whale-detector/whaleMarkerClusters";
import { VpinCloudSettingsModal } from "../../lib/indicators/vpin-cloud/VpinCloudSettingsModal";
import { DEFAULT_VPIN_SENSITIVITY } from "../../lib/indicators/vpin-cloud/vpinSensitivity";
import {
  HISTORICAL_INDICATOR_EXTRAS_STORAGE_KEY,
  loadLiveIndicatorExtras,
  saveLiveIndicatorExtras,
} from "../../lib/chart/liveIndicatorExtras";

const HISTORICAL_PRINTS_NOTE =
  "Historical Mode keeps the four largest prints per side per minute, so it filters by size only, and a size below those prints adds none.";
const BESPOKE_HISTORICAL_SETTINGS: ReadonlySet<IndicatorId> =
  new Set<IndicatorId>([
    "largeTradeDetector",
    "vpinCloud",
    SESSION_PROFILE_INDICATOR_ID,
    ...HISTORICAL_L2_SETTINGS_IDS,
  ]);
import type {
  HistoricalIndicatorCapability,
  HistoricalIndicatorSeries,
} from "../../lib/archive/historicalIndicatorSeries";
import type { ArchivePresentationPage } from "../../lib/archive/continuousArchive";
import type { TimeframeMenuOption } from "../../lib/chart/timeframeMenuOptions";

const HISTORICAL_TIMEFRAME_MENU_OPTIONS: readonly TimeframeMenuOption[] =
  Object.freeze(
    HISTORICAL_TIMEFRAMES.map((timeframe) =>
      Object.freeze({ id: timeframe.id, label: timeframe.label }),
    ),
  );
const HISTORICAL_TIMEFRAME_FAVORITES = ["1m", "5m", "15m", "1h", "4h", "1D"];
const EMPTY_HISTORICAL_ROLL_MARKERS = Object.freeze([]);

type HistoricalIndicatorGroup =
  | "technical"
  | "orderflow"
  | "liquidity";
type IndicatorFilter = "all" | "favorites" | HistoricalIndicatorGroup;
type RetainedHistoricalArchive = Readonly<{
  instrumentId: string;
  series: HistoricalIndicatorSeries;
  rollMarkers: ArchivePresentationPage["rollMarkers"];
}>;

const INDICATOR_GROUPS: readonly {
  id: HistoricalIndicatorGroup;
  label: string;
}[] = [
  {
    id: "technical",
    label: "Basic · OHLCV",
  },
  { id: "orderflow", label: "Orderflow · L1" },
  { id: "liquidity", label: "Orderbook · L2" },
];

const INDICATOR_FILTERS: readonly { id: IndicatorFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites" },
  ...INDICATOR_GROUPS.map(({ id, label }) => ({ id, label })),
];

function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== "Tab") return;
  const focusable = [
    ...(root?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []),
  ];
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function indicatorGroup(indicator: (typeof INDICATOR_REGISTRY)[number]): HistoricalIndicatorGroup {
  const family = indicatorFamily(indicator);
  return family === "basic" ? "technical" : family === "orderbook" ? "liquidity" : "orderflow";
}

function archiveStatus(
  instrument: HistoricalInstrument | null,
  timeframe: HistoricalTimeframe,
  load: ArchivePageLoad,
  chartError: string | null,
  renderedBarCount: number,
  hasRetainedChart: boolean,
): Readonly<{ detail: string; title: string; body: string }> {
  if (instrument === null) {
    return {
      detail: "Choose an archived instrument",
      title: "No archive page loaded",
      body: "Pick a symbol to request a verified first page from the archive.",
    };
  }
  if (load.state === "configuration") {
    return {
      detail: "Host data access is not configured",
      title: "Historical Mode needs host data access",
      body: "Historical Mode reads the archive on the host through your WireGuard tunnel and gateway bearer. Ask the owner for both, set them in .env as docs/operations/00-developer-onboarding.md describes, restart both terminals, and check with npm run doctor.",
    };
  }
  if (
    load.state === "loading" ||
    (load.state === "ready" &&
      (load.instrumentId !== instrument.id ||
        load.timeframeId !== timeframe.id))
  ) {
    return {
      detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 requesting archive page`,
      title: hasRetainedChart
        ? "Updating verified historical chart"
        : "Loading verified archive page",
      body: hasRetainedChart
        ? "The prior verified timeframe remains visible until this bounded archive page is validated."
        : "No prior verified page exists for this instrument.",
    };
  }
  if (load.state === "ready") {
    if (chartError !== null) {
      return {
        detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 archive row validation failed`,
        title: "Historical page was not rendered",
        body: chartError,
      };
    }
    const coverage = Object.entries(load.page.coverage.states)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${state}: ${count}`)
      .join(", ");
    if (load.series.bars.length === 0) {
      return {
        detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 no rows returned`,
        title: "No candles in this archive window",
        body: coverage
          ? `Partition coverage: ${coverage}.`
          : "The archive returned no candle rows for this bounded window.",
      };
    }
    if (load.extensionIssue !== undefined) {
      const action =
        load.extensionIssue.kind === "restart"
          ? "snapshot changed"
          : load.extensionIssue.kind;
      return {
        detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 retained ${renderedBarCount.toLocaleString()} verified candles \u00b7 extension ${action}: ${load.extensionIssue.detail}`,
        title: "History extension was not added",
        body: "The chart keeps its existing verified snapshot. No partial adjacent window was drawn.",
      };
    }
    const gaps = Object.entries(load.page.coverage.states)
      .filter(([state, count]) => state !== "PUBLISHED" && count > 0)
      .map(([state, count]) => `${state}: ${count}`);
    return {
      detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 ${renderedBarCount.toLocaleString()} candles rendered${load.loadingDirection === null ? "" : " \u00b7 loading more"}`,
      title:
        load.loadingDirection === null
          ? "Verified historical chart"
          : "Extending verified history",
      body:
        gaps.length === 0
          ? `Latest archive-window coverage: ${coverage || "none reported"}.`
          : `Latest archive window contains declared coverage gaps: ${gaps.join(", ")}.`,
    };
  }
  if (load.state === "refused") {
    return {
      detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 request refused: ${load.code}`,
      title: "Archive request refused",
      body: "The archive declined this bounded request without returning an invented or partial result.",
    };
  }
  if (load.state === "restart") {
    return {
      detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 snapshot changed: ${load.code}`,
      title: "Archive snapshot changed",
      body: "The archive did not mix catalog generations. Select the instrument again to start a fresh request.",
    };
  }
  if (load.state === "error") {
    return {
      detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 ${load.message}`,
      title: "Archive request failed",
      body: "No candle data was accepted by the screen. Run npm run doctor to see whether the tunnel, the bearer or the archive is at fault, then retry.",
    };
  }
  return {
    detail: `${instrument.label} \u00b7 ${timeframe.label} \u00b7 waiting`,
    title: "Archive page not requested",
    body: "The selected archive has not started a request yet.",
  };
}
const DEFAULT_HISTORICAL_INSTRUMENT_ID = "btc-perpetual";
const HISTORICAL_INDICATOR_FAVORITES_STORAGE_KEY =
  "terminal.historical-indicators.favorites";

function initialHistoricalIndicatorPreferences() {
  return loadHistoricalIndicatorPreferences(
    undefined,
    HISTORICAL_INDICATOR_FAVORITES_STORAGE_KEY,
  );
}

export function HistoricalModePanel() {
  const [rightPanelOpen, setRightPanelOpen] = useState(dockOpenByDefault);
  const dockToggleRef = useRef<HTMLButtonElement>(null);
  const [selectedInstrument, setSelectedInstrument] =
    useState<HistoricalInstrument | null>(
      () =>
        HISTORICAL_INSTRUMENTS.find(
          (instrument) => instrument.id === DEFAULT_HISTORICAL_INSTRUMENT_ID,
        ) ?? null,
    );
  const [selectedTimeframeId, setSelectedTimeframeId] = useState(
    DEFAULT_HISTORICAL_TIMEFRAME_ID,
  );
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [indicatorPickerOpen, setIndicatorPickerOpen] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [indicatorQuery, setIndicatorQuery] = useState("");
  const [indicatorFilter, setIndicatorFilter] =
    useState<IndicatorFilter>("all");
  const [favorites, setFavorites] = useState<ReadonlySet<IndicatorId>>(() =>
    loadIndicatorFavorites(HISTORICAL_INDICATOR_FAVORITES_STORAGE_KEY),
  );
  const [initialPreferences] = useState(initialHistoricalIndicatorPreferences);
  const [visibility, setVisibility] = useState<
    Partial<Record<IndicatorId, boolean>>
  >(initialPreferences.visibility);
  const [runtimeSettingsById, setRuntimeSettingsById] = useState<
    Partial<Record<IndicatorId, unknown>>
  >(initialPreferences.runtimeSettingsById);
  const [openSettingsId, setOpenSettingsId] = useState<IndicatorId | null>(
    null,
  );
  const [killzoneSessions, setKillzoneSessions] = useState<Set<KillzoneId>>(
    () => new Set(initialPreferences.killzoneSessions),
  );
  const [savedExtras, setSavedExtras] = useState(() =>
    loadLiveIndicatorExtras(HISTORICAL_INDICATOR_EXTRAS_STORAGE_KEY),
  );
  const [whaleThresholdUsd, setWhaleThresholdUsd] = useState(
    savedExtras.whale.thresholdUsd,
  );
  const [whaleThresholdContracts, setWhaleThresholdContracts] = useState(
    savedExtras.whale.thresholdContracts,
  );
  const [whaleClusterMode, setWhaleClusterMode] = useState<WhaleClusterMode>(
    savedExtras.whale.clusterMode,
  );
  const [whaleMinDeltaPercent, setWhaleMinDeltaPercent] = useState(
    savedExtras.whale.minDeltaPercent,
  );
  const [vpinSensitivity, setVpinSensitivity] = useState<number | null>(
    savedExtras.vpinSensitivity,
  );
  useEffect(() => {
    saveLiveIndicatorExtras(
      {
        ...savedExtras,
        whale: {
          ...savedExtras.whale,
          mode: "size",
          thresholdUsd: whaleThresholdUsd,
          thresholdContracts: whaleThresholdContracts,
          clusterMode: whaleClusterMode,
          minDeltaPercent: whaleMinDeltaPercent,
        },
        vpinSensitivity,
      },
      HISTORICAL_INDICATOR_EXTRAS_STORAGE_KEY,
    );
  }, [
    savedExtras,
    whaleThresholdUsd,
    whaleThresholdContracts,
    whaleClusterMode,
    whaleMinDeltaPercent,
    vpinSensitivity,
  ]);
  const [instrumentRequestToken, setInstrumentRequestToken] = useState(0);
  const [sampleRange, setSampleRange] = useState<Readonly<{ fromMs: number; toMs: number }> | null>(null);
  const instrumentTriggerRef = useRef<HTMLButtonElement>(null);
  const indicatorTriggerRef = useRef<HTMLButtonElement>(null);
  const symbolPickerRef = useRef<HTMLDivElement>(null);
  const indicatorPickerRef = useRef<HTMLDivElement>(null);
  const symbolSearchRef = useRef<HTMLInputElement>(null);
  const indicatorSearchRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<ChartPanelHandle>(null);
  const renderedArchiveViewportKeyRef = useRef<string | null>(null);
  const [lastVerifiedArchive, setLastVerifiedArchive] =
    useState<RetainedHistoricalArchive | null>(null);
  const selectedTimeframe = historicalTimeframeById(selectedTimeframeId);
  const archiveLoad = useArchivePage(
    selectedInstrument,
    selectedTimeframe,
    instrumentRequestToken,
    sampleRange,
  );
  const archiveIsCurrent =
    archiveLoad.state === "ready" &&
    selectedInstrument?.availability === "ready" &&
    archiveLoad.instrumentId === selectedInstrument.id &&
    archiveLoad.timeframeId === selectedTimeframe.id;
  const archiveSeries = archiveIsCurrent ? archiveLoad.series : null;
  useEffect(() => {
    if (!archiveIsCurrent) return;
    setLastVerifiedArchive({
      instrumentId: archiveLoad.instrumentId,
      series: archiveLoad.series,
      rollMarkers: archiveLoad.page.rollMarkers,
    });
  }, [archiveIsCurrent, archiveLoad]);
  const retainedArchive =
    archiveLoad.state === "ready" &&
    archiveLoad.instrumentId === selectedInstrument?.id
      ? {
          instrumentId: archiveLoad.instrumentId,
          series: archiveLoad.series,
          rollMarkers: archiveLoad.page.rollMarkers,
        }
      : lastVerifiedArchive?.instrumentId === selectedInstrument?.id
        ? lastVerifiedArchive
        : null;
  const displayedArchiveSeries =
    archiveSeries ?? retainedArchive?.series ?? null;
  const archiveRangeCallback = archiveIsCurrent
    ? archiveLoad.onVisibleLogicalRangeChange
    : null;
  const archiveRollMarkers = archiveIsCurrent
    ? archiveLoad.page.rollMarkers
    : (retainedArchive?.rollMarkers ?? EMPTY_HISTORICAL_ROLL_MARKERS);
  const studiesSupported =
    selectedInstrument !== null && archiveStudiesSupported(selectedInstrument);
  const tradeFamiliesServed = useArchiveTradeAvailability(
    selectedInstrument?.source === "binance" ? selectedInstrument : null,
    archiveIsCurrent ? archiveLoad.page.pointerToken : null,
  );
  const historicalL2Selected = (["l2BookMap", "l2FeedStatus", "passiveLiquidity", "liveOrderBookProfile",
    "l2SupportResistance", "institutionalOrderBlocks", "institutionalOrderBlocksV2", "liquidityVoids",
    "emptyOrderbook", "absorptionDetector", "aggressiveOrders", "whaleLimitOrderHeatmap"] as const)
    .some((id) => favorites.has(id) && visibility[id] !== false);
  const historicalL2 = useHistoricalL2({ chartRef,
    instrument: archiveIsCurrent ? selectedInstrument : null,
    generation: archiveIsCurrent ? archiveLoad.page.pointerToken : null,
    intervalMs: selectedTimeframe.intervalMs,
    enabled: historicalL2Selected,
    wallsEnabled: (["l2SupportResistance", "institutionalOrderBlocksV2", "whaleLimitOrderHeatmap"] as const)
      .some((id) => favorites.has(id) && visibility[id] !== false),
    printsEnabled: (["absorptionDetector", "aggressiveOrders"] as const)
      .some((id) => favorites.has(id) && visibility[id] !== false),
  });
  const historicalCapabilityKey =
    displayedArchiveSeries === null
      ? ""
      : [
          ...displayedArchiveSeries.capabilities,
          ...(archiveIsCurrent && historicalL2.available ? ["l2_states"] : []),
          ...(archiveIsCurrent && historicalL2.wallsAvailable ? ["l2_walls"] : []),
          ...(archiveIsCurrent && historicalL2.printsAvailable ? ["l2_prints"] : []),
          ...(studiesSupported && (selectedInstrument?.source !== "binance" || tradeFamiliesServed)
            ? ["trade_families", "buy_volume"]
            : []),
        ].join("\u0000");
  const historicalCapabilities = useMemo<Set<HistoricalIndicatorCapability>>(
    () =>
      new Set(
        historicalCapabilityKey === ""
          ? []
          : (historicalCapabilityKey.split(
              "\u0000",
            ) as HistoricalIndicatorCapability[]),
      ),
    [historicalCapabilityKey],
  );
  const historicalProvider = displayedArchiveSeries?.provider ?? null;
  const archiveViewportKey = archiveIsCurrent
    ? `${archiveLoad.instrumentId}\u0000${archiveLoad.timeframeId}\u0000${instrumentRequestToken}`
    : null;

  useEffect(() => {
    if (archiveSeries === null) return;
    const bars = archiveSeries.bars;
    const changed =
      renderedArchiveViewportKeyRef.current !== archiveViewportKey;
    chartRef.current?.applySnapshot(bars, {
      viewport: bars.length === 0 || changed ? "all" : "default",
      ...(changed && sampleRange !== null ? { visibleRange: { fromMs: sampleRange.fromMs, toMs: sampleRange.toMs - selectedTimeframe.intervalMs } } : {}),
    });
    renderedArchiveViewportKeyRef.current = archiveViewportKey;
  }, [archiveSeries, archiveViewportKey, sampleRange, selectedTimeframe.intervalMs]);

  useEffect(() => {
    chartRef.current?.setHistoricalIndicatorCapabilities(
      [...historicalCapabilities],
      historicalProvider,
    );
    chartRef.current?.setIndicators([...favorites], runtimeSettingsById);
    chartRef.current?.setIndicatorVisibility(
      [...favorites].filter((id) => visibility[id] !== false),
    );
  }, [
    favorites,
    historicalCapabilities,
    historicalProvider,
    runtimeSettingsById,
    visibility,
  ]);

  useEffect(() => {
    saveIndicatorFavorites(
      favorites,
      HISTORICAL_INDICATOR_FAVORITES_STORAGE_KEY,
    );
  }, [favorites]);

  useEffect(() => {
    saveHistoricalIndicatorPreferences({
      visibility,
      runtimeSettingsById,
      killzoneSessions,
    });
  }, [killzoneSessions, runtimeSettingsById, visibility]);

  useEffect(() => {
    chartRef.current?.setKillzoneSessions([...killzoneSessions]);
  }, [killzoneSessions]);

  useEffect(() => {
    if (archiveRangeCallback === null) return undefined;
    return chartRef.current?.subscribeVisibleLogicalRangeChange(
      archiveRangeCallback,
    );
  }, [archiveRangeCallback]);

  useEffect(() => {
    chartRef.current?.setHistoricalRollMarkers(archiveRollMarkers);
  }, [archiveRollMarkers]);

  const sessionProfileSettings: SessionProfileIndicatorSettings =
    (runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID] as
      | SessionProfileIndicatorSettings
      | undefined) ?? DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS;
  const fixedBuckets = selectedTimeframe.bucket === "fixed";
  const studyShown = (id: IndicatorId) =>
    studiesSupported && favorites.has(id) && visibility[id] !== false;
  const profileRequested = studyShown(SESSION_PROFILE_INDICATOR_ID);
  const printsRequested = studyShown("largeTradeDetector");
  const profileToggle =
    profileRequested &&
    (sessionProfileSettings.mode === "continuous" || fixedBuckets);
  const vpinToggle = studyShown("vpinCloud");
  const flowToggle = CANDLE_FLOW_INDICATORS.some((id) => studyShown(id));
  const printsToggle = printsRequested && fixedBuckets;
  const studyToggles = useMemo(
    () => ({
      profile: profileToggle,
      vpin: vpinToggle,
      prints: printsToggle,
      flow: flowToggle,
    }),
    [flowToggle, printsToggle, profileToggle, vpinToggle],
  );
  const studyProfileSettings = useMemo(
    () => ({
      mode: sessionProfileSettings.mode,
      periodMs: sessionProfileSettings.periodMs,
      binSizeMultiplier: Math.max(
        sessionProfileSettings.binSizeMultiplier,
        ARCHIVE_MIN_BIN_SIZE_MULTIPLIER,
      ),
    }),
    [
      sessionProfileSettings.mode,
      sessionProfileSettings.periodMs,
      sessionProfileSettings.binSizeMultiplier,
    ],
  );
  const profileBinSizeNotice = sessionProfileSettings.binSizeMultiplier < ARCHIVE_MIN_BIN_SIZE_MULTIPLIER
    ? `Historical Mode uses ${ARCHIVE_MIN_BIN_SIZE_MULTIPLIER} as the minimum bin-size multiplier. The saved ${sessionProfileSettings.binSizeMultiplier} setting remains available in Live Mode.`
    : undefined;
  const studyDisplaySettings = useMemo(
    () => ({
      whaleThresholdUsd,
      whaleThresholdContracts,
      whaleClusterMode,
      whaleMinDeltaPercent,
      vpinSensitivity,
    }),
    [
      whaleThresholdUsd,
      whaleThresholdContracts,
      whaleClusterMode,
      whaleMinDeltaPercent,
      vpinSensitivity,
    ],
  );
  const studies = useArchiveStudies({
    chartRef,
    pointerToken: archiveIsCurrent ? archiveLoad.page.pointerToken : null,
    instrument:
      studiesSupported && archiveIsCurrent
        && (selectedInstrument?.source !== "binance" || tradeFamiliesServed)
        && selectedInstrument?.availability === "ready"
        ? selectedInstrument
        : null,
    intervalMs: selectedTimeframe.intervalMs,
    toggles: studyToggles,
    profileSettings: studyProfileSettings,
    displaySettings: studyDisplaySettings,
  });
  const futuresInstrument =
    selectedInstrument !== null &&
    studyAssetClass(selectedInstrument) === "FUTURE";
  useEffect(() => {
    chartRef.current?.setSessionProfileSettings(sessionProfileSettings);
  }, [chartRef, sessionProfileSettings]);
  const unsidedNote =
    studies.unsidedShare !== null && studies.unsidedShare >= 0.01
      ? `${Math.round(studies.unsidedShare * 100)}% of volume has no buy or sell side`
      : null;
  const studyNote =
    !fixedBuckets &&
    (printsRequested ||
      (profileRequested && sessionProfileSettings.mode === "per_candle"))
      ? "per-candle studies need a timeframe of 1D or shorter"
      : (studies.issue ??
        (studies.loading ? "computing studies" : unsidedNote));

  const visibleInstrumentGroups = useMemo(() => {
    const query = symbolQuery.trim().toLowerCase();
    return HISTORICAL_INSTRUMENT_GROUPS.map((group) => ({
      group,
      instruments: HISTORICAL_INSTRUMENTS.filter(
        (instrument) =>
          instrument.group === group &&
          (!query ||
            `${instrument.label} ${instrument.symbol}`
              .toLowerCase()
              .includes(query)),
      ),
    })).filter(({ instruments }) => instruments.length > 0);
  }, [symbolQuery]);

  const visibleIndicatorSections = useMemo(() => {
    const query = indicatorQuery.trim().toLowerCase();
    const matching = INDICATOR_REGISTRY.filter((indicator) => {
      const matchesQuery =
        !query || indicator.label.toLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (indicatorFilter === "favorites") return favorites.has(indicator.id);
      return (
        indicatorFilter === "all" ||
        indicatorGroup(indicator) === indicatorFilter
      );
    });
    if (indicatorFilter === "favorites")
      return [{ id: "favorites", label: "Favorites", indicators: matching }];
    return INDICATOR_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      indicators: matching.filter(
        (indicator) => indicatorGroup(indicator) === group.id,
      ),
    })).filter(({ indicators }) => indicators.length > 0);
  }, [favorites, indicatorFilter, indicatorQuery]);

  const activeHistoricalIndicators = useMemo(
    () =>
      INDICATOR_REGISTRY.flatMap((indicator) => {
        if (!favorites.has(indicator.id)) return [];
        const availability = historicalIndicatorAvailability(
          indicator.id,
          historicalCapabilities,
          historicalProvider,
        );
        if (!availability.available) return [];
        const runtime = RUNTIME_INDICATOR_DEFS.find(
          (definition) => definition.id === indicator.id,
        );
        const supportsSettings =
          indicator.id === "killzones" ||
          BESPOKE_HISTORICAL_SETTINGS.has(indicator.id) ||
          (indicator.id !== "orderFlow" &&
            runtime?.settingsSchema !== undefined &&
            runtime.settingsSchema.length > 0);
        return [
          {
            id: indicator.id,
            label: indicator.label,
            detail:
              indicator.id === "orderFlow"
                ? "CVD · candle-side volume"
                : indicator.id === "liveDeltaProfile"
                  ? "Estimated from visible candles"
                : undefined,
            supportsSettings,
          },
        ];
      }),
    [favorites, historicalCapabilities, historicalProvider],
  );

  function closeSymbolPicker(): void {
    setSymbolPickerOpen(false);
    setSymbolQuery("");
    window.requestAnimationFrame(() => instrumentTriggerRef.current?.focus());
  }

  function closeIndicatorPicker(): void {
    setIndicatorPickerOpen(false);
    setIndicatorQuery("");
    setIndicatorFilter("all");
    window.requestAnimationFrame(() => indicatorTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!symbolPickerOpen) return;
    symbolSearchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSymbolPicker();
        return;
      }
      trapFocus(event, symbolPickerRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [symbolPickerOpen]);

  useEffect(() => {
    if (!indicatorPickerOpen) return;
    indicatorSearchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeIndicatorPicker();
        return;
      }
      trapFocus(event, indicatorPickerRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [indicatorPickerOpen]);

  function toggleFavorite(id: IndicatorId): void {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (favorites.has(id))
      setOpenSettingsId((current) => (current === id ? null : current));
  }

  function setIndicatorVisible(id: IndicatorId, value: boolean): void {
    setVisibility((current) => ({ ...current, [id]: value }));
  }

  function setKillzoneSession(sessionId: KillzoneId, selected: boolean): void {
    setKillzoneSessions((current) => {
      const next = new Set(current);
      if (selected) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function selectInstrument(instrument: HistoricalInstrument): void {
    setSampleRange(null);
    setSelectedInstrument(instrument);
    setInstrumentRequestToken((current) => current + 1);
    closeSymbolPicker();
  }

  const selectedInstrumentLabel =
    selectedInstrument?.label ?? "Select an instrument";
  const archive = archiveStatus(
    selectedInstrument,
    selectedTimeframe,
    archiveLoad,
    null,
    archiveLoad.state === "ready" ? archiveLoad.series.bars.length : 0,
    retainedArchive !== null,
  );
  const showArchiveMessage =
    retainedArchive === null &&
    (archiveLoad.state !== "ready" ||
      archiveLoad.instrumentId !== selectedInstrument?.id ||
      archiveLoad.timeframeId !== selectedTimeframe.id ||
      archiveLoad.series.bars.length === 0);
  const archiveIsRefreshing = retainedArchive !== null && !archiveIsCurrent;

  return (
    <section className="historical-mode" aria-label="Historical mode workspace">
      <header className="historical-toolbar">
        <div className="historical-instrument-menu">
          <button
            ref={instrumentTriggerRef}
            className={`historical-instrument${symbolPickerOpen ? " active" : ""}`}
            type="button"
            onClick={() => {
              setIndicatorPickerOpen(false);
              setSymbolPickerOpen((open) => !open);
            }}
            aria-haspopup="dialog"
            aria-expanded={symbolPickerOpen}
          >
            <span className="historical-control-label">Instrument</span>
            <span className="historical-instrument-value">
              {selectedInstrumentLabel}
            </span>
            <span className="historical-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {symbolPickerOpen && (
            <>
              <div
                className="historical-popover-backdrop"
                onClick={closeSymbolPicker}
                aria-hidden="true"
              />
              <div
                ref={symbolPickerRef}
                className="historical-symbol-picker"
                role="dialog"
                aria-modal="true"
                aria-label="Choose historical instrument"
              >
                <div className="historical-picker-header">
                  <span>Instruments</span>
                  <button
                    type="button"
                    className="historical-picker-close"
                    onClick={closeSymbolPicker}
                    aria-label="Close instrument picker"
                  >
                    ×
                  </button>
                </div>
                <label className="historical-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    ref={symbolSearchRef}
                    type="search"
                    value={symbolQuery}
                    onChange={(event) => setSymbolQuery(event.target.value)}
                    placeholder="Search instruments"
                    aria-label="Search instruments"
                  />
                </label>
                <div className="historical-symbol-groups">
                  {visibleInstrumentGroups.map(({ group, instruments }) => (
                    <section
                      key={group}
                      className="historical-symbol-group"
                      aria-label={group}
                    >
                      <h2>{group}</h2>
                      {instruments.map((instrument) => {
                        const selected =
                          selectedInstrument?.id === instrument.id;
                        return (
                          <button
                            key={`${instrument.symbol}-${instrument.label}`}
                            type="button"
                            className={`historical-symbol-option${selected ? " selected" : ""}`}
                            onClick={() => selectInstrument(instrument)}
                            aria-pressed={selected}
                          >
                            <span>{instrument.label}</span>
                            <span>{instrument.symbol}</span>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {visibleInstrumentGroups.length === 0 && (
                    <p className="historical-picker-empty">
                      No instruments match this search.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <TimeframeMenu
          selectedId={selectedTimeframe.id}
          onTimeframeSelect={(id) => { setSampleRange(null); setSelectedTimeframeId(id); }}
          options={HISTORICAL_TIMEFRAME_MENU_OPTIONS}
          favoriteStorageKey="terminal.historical-timeframe.favorites"
          defaultFavoriteIds={HISTORICAL_TIMEFRAME_FAVORITES}
        />
        <button
          ref={indicatorTriggerRef}
          className={`historical-indicators${indicatorPickerOpen ? " active" : ""}`}
          type="button"
          onClick={() => {
            setSymbolPickerOpen(false);
            setIndicatorPickerOpen((open) => !open);
          }}
          aria-haspopup="dialog"
          aria-expanded={indicatorPickerOpen}
        >
          <span aria-hidden="true">ƒx</span>
          Indicators
        </button>
        <div className="toolbar-spacer" />
        {historicalL2.available && archiveSeries !== null && archiveSeries.bars.length > 0 && <button
          type="button" className="indicators-button" onClick={() => {
            const last = archiveSeries.bars.at(-1)!;
            const toMs = Math.min(last.ts_open + last.interval_ms, Date.parse(selectedInstrument!.availableToExclusive));
            const dayStart = Date.parse(new Date(toMs - 1).toISOString().slice(0, 10));
            setSampleRange({ fromMs: Math.max(dayStart, toMs - 30 * 60000), toMs });
            setSelectedTimeframeId("1m");
            setInstrumentRequestToken((value) => value + 1);
          }}>Last 30m of depth</button>}
        {historicalL2.sample !== undefined && <button type="button" className="indicators-button"
          title="Open 13:30–13:45 UTC with verified depth, walls and individual trades"
          onClick={() => {
            setSampleRange({ fromMs: historicalL2.sample!.fromMs, toMs: historicalL2.sample!.toMs });
            setSelectedTimeframeId("1m");
            setInstrumentRequestToken((value) => value + 1);
          }}>Open L2 sample · {historicalL2.sample.date}</button>}
        <button ref={dockToggleRef} type="button" className="side-toggle" onClick={() => setRightPanelOpen((open) => !open)} aria-expanded={rightPanelOpen} aria-controls="historical-right-dock" aria-label={rightPanelOpen ? "Hide historical watchlist" : "Show historical watchlist"} title={rightPanelOpen ? "Hide historical watchlist" : "Show historical watchlist"}>
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M12 3v14" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </header>

      <div className={`historical-content${rightPanelOpen ? "" : " right-panel-closed"}`}>
      <div className="historical-chart">
        <div className="historical-canvas">
          {selectedInstrument?.availability === "ready" && (
            <ChartPanel
              key={selectedInstrument.id}
              ref={chartRef}
              instrumentIdentity={{
                symbol: selectedInstrument.symbol,
                ...selectedInstrument.chartIdentity,
              }}
              colorScheme="dark"
            />
          )}
          {activeHistoricalIndicators.length > 0 && (
            <div
              className="historical-indicator-legend"
              aria-label="Active historical indicators"
            >
              {activeHistoricalIndicators.map((indicator) => (
                <IndicatorLegendRow
                  key={indicator.id}
                  label={indicator.label}
                  detail={indicator.detail}
                  visible={visibility[indicator.id] !== false}
                  onToggleVisible={() =>
                    setIndicatorVisible(
                      indicator.id,
                      visibility[indicator.id] === false,
                    )
                  }
                  {...(indicator.supportsSettings
                    ? { onOpenSettings: () => setOpenSettingsId(indicator.id) }
                    : {})}
                  onRemove={() => toggleFavorite(indicator.id)}
                />
              ))}
            </div>
          )}
          <div className="historical-quote" aria-live="polite">
            <span className="historical-quote-title">
              {archiveIsRefreshing ? "Updating chart" : "Historical archive"}
            </span>
            <span className="historical-quote-detail">
              {studyNote === null
                ? archive.detail
                : `${archive.detail} · ${studyNote}`}
              {historicalL2Selected && historicalL2.issue !== null
                ? ` · ${historicalL2.issue}` : null}
            </span>
          </div>
          {showArchiveMessage && (
            <div className="historical-empty-state" role="status">
              <span className="historical-empty-kicker">Historical mode</span>
              <strong>{archive.title}</strong>
              <p>{archive.body}</p>
            </div>
          )}
        </div>
      </div>
      <aside className={`side-panels historical-side-panels${rightPanelOpen ? "" : " side-panels-closed"}`} id="historical-right-dock" aria-label="Historical right panel">
        <div className="side-panel-head">
          <div className="side-panel-tabs"><span className="historical-dock-unavailable" title="Book and trade tape are not in the archive feed">Book &amp; tape</span><span className="active">Watchlist</span></div>
          <button type="button" className="side-panel-close" onClick={() => { setRightPanelOpen(false); dockToggleRef.current?.focus(); }} aria-label="Close historical watchlist" title="Close historical watchlist">×</button>
        </div>
        <HistoricalWatchlistPanel selected={selectedInstrument} onSelect={selectInstrument} />
      </aside>
      </div>

      {indicatorPickerOpen && (
        <>
          <div
            className="historical-dialog-backdrop"
            onClick={closeIndicatorPicker}
            aria-hidden="true"
          />
          <div
            ref={indicatorPickerRef}
            className="historical-indicator-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Historical indicators"
          >
            <header className="historical-indicator-dialog-header">
              <strong>
                <span aria-hidden="true">ƒx</span> Indicators
              </strong>
              <label className="historical-search historical-indicator-search">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={indicatorSearchRef}
                  type="search"
                  value={indicatorQuery}
                  onChange={(event) => setIndicatorQuery(event.target.value)}
                  placeholder="Search indicators"
                  aria-label="Search indicators"
                />
              </label>
              <button
                type="button"
                className="historical-picker-close"
                onClick={closeIndicatorPicker}
                aria-label="Close indicator browser"
              >
                ×
              </button>
            </header>
            <div
              className="historical-indicator-filters"
              aria-label="Filter indicators"
            >
              {INDICATOR_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={indicatorFilter === filter.id ? "active" : ""}
                  onClick={() => setIndicatorFilter(filter.id)}
                  aria-pressed={indicatorFilter === filter.id}
                >
                  {filter.id === "favorites" && (
                    <span aria-hidden="true">☆</span>
                  )}
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="historical-indicator-sections">
              {visibleIndicatorSections.map((section) => (
                <section
                  key={section.id}
                  className="historical-indicator-section"
                  aria-label={section.label}
                >
                  <h2>{section.label}</h2>
                  {section.indicators.map((indicator) => {
                    const favorite = favorites.has(indicator.id);
                    const availability = historicalIndicatorAvailability(
                      indicator.id,
                      historicalCapabilities,
                      historicalProvider,
                    );
                    const runtime = RUNTIME_INDICATOR_DEFS.find(
                      (definition) => definition.id === indicator.id,
                    );
                    const supportsSettings =
                      indicator.id === "killzones" ||
                      BESPOKE_HISTORICAL_SETTINGS.has(indicator.id) ||
                      (indicator.id !== "orderFlow" &&
                        runtime?.settingsSchema !== undefined &&
                        runtime.settingsSchema.length > 0);
                    return (
                      <div
                        key={indicator.id}
                        className="historical-indicator-row"
                      >
                        <button
                          type="button"
                          className={`historical-indicator-select${favorite ? " active" : ""}`}
                          disabled={!availability.available}
                          onClick={() => toggleFavorite(indicator.id)}
                          aria-pressed={favorite}
                        >
                          <span>{indicator.label}</span>
                          <small>
                            {availability.available
                              ? indicator.id === "orderFlow"
                                ? "CVD line from archived candle-side volume"
                                : favorite
                                  ? "Active"
                                  : "Available"
                              : availability.reason}
                          </small>
                        </button>
                        {favorite &&
                          availability.available &&
                          supportsSettings && (
                            <button
                              type="button"
                              className="historical-indicator-settings"
                              onClick={() => setOpenSettingsId(indicator.id)}
                              aria-label={`Open ${indicator.label} settings`}
                            >
                              Settings
                            </button>
                          )}
                        <button
                          type="button"
                          className={`historical-favorite-toggle${favorite ? " active" : ""}`}
                          onClick={() => toggleFavorite(indicator.id)}
                          aria-pressed={favorite}
                          aria-label={`${favorite ? "Remove" : "Add"} ${indicator.label} ${favorite ? "from" : "to"} favorites`}
                        >
                          {favorite ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                </section>
              ))}
              {visibleIndicatorSections.length === 0 && (
                <p className="historical-indicator-empty">
                  No indicators match this view.
                </p>
              )}
            </div>
            <footer className="historical-indicator-note">
              Candle studies calculate from the verified historical candles.
              Order-flow studies compute from the archive's trade summaries for
              the range on screen. Unavailable studies name the data this
              archive does not contain.
            </footer>
          </div>
        </>
      )}
      {selectedInstrument?.source === "databento" && <HistoricalL2Settings
        instrument={selectedInstrument} intervalMs={selectedTimeframe.intervalMs} chartRef={chartRef}
        openId={openSettingsId} onClose={() => setOpenSettingsId(null)} extras={savedExtras} onChange={setSavedExtras}
        visibility={visibility} onVisibleChange={setIndicatorVisible}
        absorptionOn={favorites.has("absorptionDetector") && visibility.absorptionDetector !== false} />}
      {RUNTIME_INDICATOR_DEFS.filter(
        (definition) =>
          !HISTORICAL_L2_SETTINGS_IDS.has(definition.id as IndicatorId) &&
          definition.id !== "orderFlow" &&
          definition.settingsSchema !== undefined &&
          definition.settingsSchema.length > 0,
      ).map((definition) => {
        const id = definition.id as IndicatorId;
        const modalSettings =
          runtimeSettingsById[id] ?? definition.defaultSettings;
        return (
          <GenericIndicatorSettingsModal
            key={id}
            isOpen={openSettingsId === id}
            onClose={() => setOpenSettingsId(null)}
            title={definition.label}
            schema={definition.settingsSchema!}
            settings={modalSettings}
            defaultSettings={definition.defaultSettings}
            presetKey={presetKeyFor(id, HISTORICAL_PRESET_SCOPE)}
            visible={visibility[id] ?? true}
            onVisibleChange={(value) => setIndicatorVisible(id, value)}
            defaultVisible
            notice={
              id === SESSION_PROFILE_INDICATOR_ID
                ? profileBinSizeNotice
                : undefined
            }
            onChange={(next) => {
              setRuntimeSettingsById((current) => ({ ...current, [id]: next }));
              chartRef.current?.setIndicatorSettings(id, next);
            }}
          />
        );
      })}
      <KillzonesSettingsModal
        isOpen={openSettingsId === "killzones"}
        onClose={() => setOpenSettingsId(null)}
        visible={visibility.killzones ?? true}
        onVisibleChange={(value) => setIndicatorVisible("killzones", value)}
        presetScope={HISTORICAL_PRESET_SCOPE}
        selectedSessions={killzoneSessions}
        onSessionChange={setKillzoneSession}
      />
      <WhaleDetectorSettingsModal
        isOpen={openSettingsId === "largeTradeDetector"}
        onClose={() => setOpenSettingsId(null)}
        mode="size"
        onModeChange={() => {}}
        topFraction={savedExtras.whale.topFraction}
        onTopFractionChange={() => {}}
        resolvedThreshold={
          futuresInstrument ? whaleThresholdContracts : whaleThresholdUsd
        }
        truncated={false}
        minDeltaPercent={whaleMinDeltaPercent}
        onMinDeltaPercentChange={setWhaleMinDeltaPercent}
        threshold={
          futuresInstrument ? whaleThresholdContracts : whaleThresholdUsd
        }
        thresholdUnit={futuresInstrument ? "CONTRACTS" : "USD"}
        onThresholdChange={
          futuresInstrument ? setWhaleThresholdContracts : setWhaleThresholdUsd
        }
        clusterMode={whaleClusterMode}
        onClusterModeChange={setWhaleClusterMode}
        visible={visibility.largeTradeDetector ?? true}
        onVisibleChange={(value) =>
          setIndicatorVisible("largeTradeDetector", value)
        }
        sizeOnlyNote={HISTORICAL_PRINTS_NOTE}
        presetScope={HISTORICAL_PRESET_SCOPE}
      />
      <VpinCloudSettingsModal
        isOpen={openSettingsId === "vpinCloud"}
        onClose={() => setOpenSettingsId(null)}
        sensitivity={
          vpinSensitivity ??
          studies.vpinDerivedSensitivity ??
          DEFAULT_VPIN_SENSITIVITY
        }
        defaultSensitivity={
          studies.vpinDerivedSensitivity ?? DEFAULT_VPIN_SENSITIVITY
        }
        onSensitivityChange={setVpinSensitivity}
        presetScope={HISTORICAL_PRESET_SCOPE}
        visible={visibility.vpinCloud ?? true}
        onVisibleChange={(value) => setIndicatorVisible("vpinCloud", value)}
      />
    </section>
  );
}
