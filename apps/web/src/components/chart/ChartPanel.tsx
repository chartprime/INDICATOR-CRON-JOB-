import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type LineWidth,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type {
  BarFrame,
  FrameIdentity,
  ProfileFrame,
  TradeFrame,
  VpinReading,
} from "../../types/frames";
import { VolumeProfilePrimitive } from "../../lib/indicators/volume-profile/volumeProfilePrimitive";
import { NetDeltaProfilePrimitive } from "../../lib/indicators/net-delta-profile/netDeltaProfilePrimitive";
import { DeltaProfilePrimitive } from "../../lib/indicators/delta-profile/deltaProfilePrimitive";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  sessionProfileDeltaSettings,
  sessionProfileNetDeltaSettings,
  sessionProfileVolumeSettings,
  type SessionProfileIndicatorSettings,
} from "../../lib/indicators/session-profile/sessionProfileSettings";
import { SESSION_PROFILE_INDICATOR_ID } from "../../lib/indicators/session-profile/sessionProfileIds";
import { SessionDeltaProfilePrimitive } from "../../lib/indicators/session-delta-profile/sessionDeltaProfilePrimitive";
import {
  DEFAULT_SESSION_DELTA_PROFILE_SETTINGS,
  type SessionDeltaProfileSettings,
} from "../../lib/indicators/session-delta-profile/sessionDeltaProfileSettings";
import { buildSessionDeltaProfile } from "../../lib/indicators/session-delta-profile/sessionDeltaProfile";
import { VolumeDeltaProfileOhlcPrimitive } from "../../lib/indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlcPrimitive";
import { VolumeDeltaProfileTickPrimitive } from "../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickPrimitive";
import { DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS, type VolumeDeltaProfileTickSettings } from "../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickSettings";
import {
  LiquidityHeatmapPrimitive,
  type BandState,
  type WallHover,
} from "../../lib/indicators/passive-liquidity/liquidityHeatmapPrimitive";
import type { LiquidityLaneChoice } from "../../lib/indicators/passive-liquidity/liquidityLanes";
import type { HeatmapHistory } from "../../lib/indicators/passive-liquidity/heatmapHistory";
import type { ColumnHistoryStream } from "../../lib/indicators/passive-liquidity/columnHistoryStream";
import { AbsorptionHistory } from "../../lib/indicators/absorption-detector/absorptionHistory";
import { AbsorptionHistoryStore } from "../../lib/indicators/absorption-detector/absorptionHistoryStore";
import type { WallHistoryStream } from "../../lib/l2/wallHistoryStream";
import type { HeatmapHistoryInfo } from "../../lib/indicators/passive-liquidity/liquidityHeatmapLayout";
import type { LiquidityGrid } from "../../lib/indicators/passive-liquidity/liquidityGrid";
import type {
  BandHistoryStore,
  BandHistoryWant,
} from "../../lib/chart/bandHistory";
import { indicatorLiquidityOf, type IndicatorLiquidity } from "../../lib/chart/indicatorLiquidity";
import { indicatorTicksOf } from "../../lib/chart/indicatorTicks";
import { historicalL2, indicatorL2Of, type IndicatorL2 } from "../../lib/chart/indicatorL2";
import type { L2HistoryRequester } from "../../lib/l2/history";
import type { L2Store } from "../../lib/l2/l2Store";
import { L2SupportResistancePrimitive } from "../../lib/indicators/l2-support-resistance/l2SupportResistancePrimitive";
import type { L2SupportResistanceSettings } from "../../lib/indicators/l2-support-resistance/l2SupportResistancePrimitive";
import {
  BOOK_MAP_PROFILE_EDGE_GAP_PX,
  L2BookMapPrimitive,
  bookMapProfileWidthPx,
  type ChartBarOpens,
} from "../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import type {
  L2BookMapCell,
  L2BookMapSettings,
} from "../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import { WhaleLimitHeatmapPrimitive, type WhaleHit } from "../../lib/indicators/whale-limit-order-heatmap/whalePrimitive";
import { WhaleWallCard } from "../../lib/indicators/whale-limit-order-heatmap/WhaleWallCard";
import { clampCardX } from "../../lib/indicators/whale-limit-order-heatmap/whaleCardLayout";
import {
  DEFAULT_WHALE_SETTINGS as DEFAULT_WHALE_HEATMAP_SETTINGS,
  type WhaleSettings as WhaleHeatmapSettings,
} from "../../lib/indicators/whale-limit-order-heatmap/whaleSettings";
import {
  formatWallAge,
  type LiquiditySettings,
} from "../../lib/indicators/passive-liquidity/liquiditySettings";
import { AXIS_INSET_GAP_PX, axisInsetPx, type AxisOccupant } from "../../lib/chart/axisInset";
import { AggressiveOrdersPrimitive } from "../../lib/indicators/aggressive-orders/aggressiveOrdersPrimitive";
import { LiveDeltaProfilePrimitive, type AxisNeighbour } from "../../lib/indicators/live-delta-profile/liveDeltaProfilePrimitive";
import { MAX_LADDER_REACH, MIN_LADDER_REACH } from "../../lib/indicators/passive-liquidity/liquiditySettings";
import { DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS, MAX_PROFILE_WIDTH_PX, MIN_PROFILE_WIDTH_PX, PROFILE_WIDTH_STEP_PX, type VolumeDeltaProfileOhlcSettings } from "../../lib/indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlcSettings";
import type { LiveDeltaProfileSettings } from "../../lib/indicators/live-delta-profile/liveDeltaProfileSettings";
import { baseRowWidthFor, type DeltaProfileStore } from "../../lib/indicators/live-delta-profile/deltaProfileStore";
import { CandleDeltaSource } from "../../lib/indicators/live-delta-profile/candleDeltaSource";
import { MAX_WIDTH_SHARE, MIN_WIDTH_SHARE } from "../../lib/indicators/live-delta-profile/liveDeltaProfileSettings";
import { reachShareForWidth } from "../../lib/indicators/axis-profile/axisProfileLayout";
import { LiveOrderBookProfilePrimitive } from "../../lib/indicators/live-order-book-profile/liveOrderBookProfilePrimitive";
import { BookProfileSource } from "../../lib/indicators/live-order-book-profile/bookProfileSource";
import type { LiveOrderBookProfileSettings } from "../../lib/indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { AggressiveProfilePane } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfilePane";
import { AggressiveProfilePrimitive } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfilePrimitive";
import { AggressiveProfileSource } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileSource";
import type { AggressiveProfileSettings } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import type { RangePrintStore } from "../../lib/indicators/aggressive-orders-profile/rangePrintStore";
import type { AggressiveOrdersSettings } from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import type {
  AggressiveTape,
  ClusterRules,
} from "../../lib/indicators/aggressive-orders/aggressiveTape";
import { AbsorptionPrimitive } from "../../lib/indicators/absorption-detector/absorptionPrimitive";
import { IcebergPrimitive } from "../../lib/indicators/iceberg-detector/icebergPrimitive";
import type { IcebergHover } from "../../lib/indicators/iceberg-detector/icebergHover";
import { ExhaustionPrimitive } from "../../lib/indicators/exhaustion/exhaustionPrimitive";
import { describeExhaustion, type ExhaustionHover } from "../../lib/indicators/exhaustion/exhaustionHover";
import { ExhaustionCard } from "../../lib/indicators/exhaustion/ExhaustionCard";
import { DEFAULT_EXHAUSTION_SETTINGS, exhaustionCalibrated, shownShades, type ExhaustionSettings } from "../../lib/indicators/exhaustion/exhaustionSettings";
import type { ExhaustionBook } from "../../lib/l2/exhaustionBook";
import { InitiativePrimitive } from "../../lib/indicators/initiative/initiativePrimitive";
import { describeInitiative, type InitiativeHover } from "../../lib/indicators/initiative/initiativeHover";
import { InitiativeCard } from "../../lib/indicators/initiative/InitiativeCard";
import { DEFAULT_INITIATIVE_SETTINGS, shownBands, type InitiativeSettings } from "../../lib/indicators/initiative/initiativeSettings";
import type { InitiativeBook } from "../../lib/l2/initiativeBook";
import { LiveRangeHistory, forkForLiveRange } from "../../lib/indicators/live-range-control/liveRangeHistory";
import { LiveRangePrimitive, type LiveRangeReport } from "../../lib/indicators/live-range-control/liveRangePrimitive";
import { LiveRangeCard } from "../../lib/indicators/live-range-control/LiveRangeCard";
import { DEFAULT_LIVE_RANGE_SETTINGS, type LiveRangeSettings } from "../../lib/indicators/live-range-control/liveRangeSettings";
import { WHOLE_WINDOW, type LiveRangeWindow } from "../../lib/indicators/live-range-control/liveRangeWindow";
import type { WindowLine } from "../../lib/indicators/live-range-control/liveRangeGeometry";
import { loadCardPosition as loadLiveRangeCardPosition, saveCardPosition as saveLiveRangeCardPosition, type CardPosition as LiveRangeCardPosition } from "../../lib/indicators/live-range-control/cardPosition";
import { CandleMonitor } from "../../lib/indicators/candle-monitor/CandleMonitor";
import type { CandleMonitorArrival } from "../../lib/indicators/candle-monitor/candleMonitorText";
import type { IcebergSettings } from "../../lib/indicators/iceberg-detector/icebergSettings";
import type { IcebergBook } from "../../lib/l2/icebergBook";
import type { FVGHoverData } from "../../lib/indicators/fvg-delta/fvgDelta";
import { fvgHoverDataFromUnknown, hitFvgHover } from "./fvgHoverData";
import {
  hitSessionLevelHover,
  sessionLevelHoversFromUnknown,
} from "./sessionLevelHoverData";
import type { AbsorptionHover } from "../../lib/indicators/absorption-detector/absorptionHover";
import type { SessionLevelHover } from "../../lib/indicators/session-levels/sessionLevelsHover";
import {
  describeBubble,
  sizeUnitFor,
  type BubbleWords,
} from "../../lib/indicators/aggressive-orders/aggressiveOrdersHover";
import type { AbsorptionSettings } from "../../lib/indicators/absorption-detector/absorptionSettings";
import type { AbsorptionRules } from "../../lib/indicators/absorption-detector/absorptionEngine";
import {
  VpinCloudPrimitive,
  type VpinCloudSettings,
} from "../../lib/indicators/vpin-cloud/vpinCloudPrimitive";
import {
  barToCandleCloseTimerState,
  CandleCloseTimerPrimitive,
} from "../../lib/chart/candleCloseTimerPrimitive";
import {
  RollMarkerPrimitive,
  type HistoricalRollMarker,
} from "../../lib/chart/rollMarkerPrimitive";
import {
  appendedBarIsContiguous,
  barCloseMs,
  candleBars,
  defaultVisibleRange,
  histogramPoint,
  histogramThreshold,
  mergeChartBar,
  preserveVisibleRange,
  toCandlestick,
  toCandlestickSeries,
  toColoredLineData,
  toCvdCandlestickData,
  toHistogramData,
  toLineData,
  type ChartBarMutation,
} from "../../lib/chart/chartData";
import { MAX_RETAINED_SOURCE_BARS } from "../../lib/chart/candleLifecycle";
import { createIndicatorRuntime } from "../../lib/chart/indicatorRuntime";
import { DrawKernelPrimitive } from "../../lib/chart/draw/kernelPrimitive";
import {
  MarkerSeriesController,
  type MarkerCall,
} from "../../lib/chart/draw/markers";
import { handlesForOwners } from "../../lib/chart/draw/registry";
import type { TableCell, TableData, TablePosition } from "../../lib/chart/draw/table";
import { formatUsd } from "../../lib/chart/formatUsd";
import {
  KILLZONE_SESSIONS,
  buildKillzoneOccurrences,
  type KillzoneId,
  type NyPartsCache,
} from "../../lib/indicators/killzones/killzones";
import {
  KillzonesPrimitive,
  type KillzoneSessionInput,
} from "../../lib/indicators/killzones/killzonesPrimitive";
import {
  DEFAULT_SWING_LENGTH,
  detectDivergences,
} from "../../lib/indicators/delta-divergence/deltaDivergence";
import { DeltaDivergencePrimitive } from "../../lib/indicators/delta-divergence/deltaDivergencePrimitive";
import {
  DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
  type CvdDivergenceIndicatorSettings,
} from "../../lib/indicators/cvd-divergence/cvdDivergenceIndicator";
import { CvdDivergenceRenderer } from "../../lib/indicators/cvd-divergence/cvdDivergenceRenderer";
import {
  addDrawing,
  drawingsForInstrument,
  createDrawingId,
  loadDrawings,
  removeDrawing,
  saveDrawings,
  type DrawingPoint,
  type DrawingToolId,
  type DrawnObject,
  type FibonacciDrawing,
  type TrendlineDrawing,
} from "../../lib/chart/drawingStore";
import {
  advanceDrawingPlacement,
  DRAWING_PLACEMENT_IDLE,
  pickNearestHit,
  type DrawingPlacementMode,
} from "../../lib/indicators/drawing-tools/trendlineGeometry";
import { TrendlinePrimitive } from "../../lib/indicators/drawing-tools/trendlinePrimitive";
import { FibonacciPrimitive } from "../../lib/indicators/drawing-tools/fibonacciPrimitive";
import {
  computeCVDForBars,
  computeDeltaPerBar,
  cvdAfter,
} from "../../lib/indicators/order-flow/orderFlow";
import { barDelta } from "../../lib/indicators/barSides";
import {
  computeCvdCandles,
  type OrderFlowDisplayMode,
} from "../../lib/indicators/order-flow/cvdCandles";
import { computeParticipationRateForSize } from "../../lib/indicators/order-flow/participationRate";
import {
  deltaShareForCluster,
  displaySizeForCluster,
  findClusterByIdentity,
  latestTradeTsForCluster,
  type WhaleClusterMode,
  type WhaleMarkerCluster,
} from "../../lib/indicators/whale-detector/whaleMarkerClusters";
import { WhaleMarkersPrimitive } from "../../lib/indicators/whale-detector/whaleMarkersPrimitive";
import type { WhaleTradeStat } from "../../lib/indicators/whale-detector/whaleTrades";
import {
  RUNTIME_INDICATOR_DEFS,
  historicalIndicatorAvailability,
  type IndicatorId,
} from "../../lib/chart/indicatorRegistry";
import type { HistoricalIndicatorCapability } from "../../lib/archive/historicalIndicatorSeries";
import type {
  RuntimeIndicatorDef,
  TradeAvailability,
} from "../../lib/chart/indicatorTypes";
import { ChartPrimeLogo } from "../chrome/ChartPrimeLogo";
import { shownTooltips } from "./tooltipPriority";
import type { BarSideFlow } from "../../lib/indicators/barSides";

/** How long a history reply may keep landing before the print-priced indicators replay over it. */
const TICKS_HISTORY_SETTLE_MS = 250;

export interface ChartPanelHandle {
  applySnapshot: (
    bars: readonly BarFrame[],
    options?: Readonly<{ viewport?: "default" | "all"; visibleRange?: Readonly<{ fromMs: number; toMs: number }> }>,
  ) => void;
  setHistoricalRollMarkers: (markers: readonly HistoricalRollMarker[]) => void;
  applyBar: (
    bar: BarFrame,
    trades?: readonly TradeFrame[],
    tradeAvailability?: TradeAvailability,
  ) => void;
  applyRawBars: (bars: BarFrame[]) => void;
  setIndicators: (
    ids: IndicatorId[],
    settingsById?: Readonly<Partial<Record<IndicatorId, unknown>>>,
  ) => void;
  setHistoricalIndicatorCapabilities: (
    capabilities: readonly HistoricalIndicatorCapability[] | null,
    provider?: BarFrame["provider"] | null,
  ) => void;
  applyHistoricalL2: (source: IndicatorL2 | null, liquidity?: IndicatorLiquidity | null, grid?: LiquidityGrid | null, tape?: AggressiveTape | null) => void;
  setIndicatorVisibility: (visibleIds: IndicatorId[]) => void;
  setIndicatorSettings: (id: IndicatorId, settings: unknown) => void;
  applyLiquidity: (grid: LiquidityGrid | null) => void;
  applyL2: (store: L2Store | null, history?: L2HistoryRequester | null) => void;
  applyHeatmapHistory: (history: HeatmapHistory | null) => void;
  applyColumnHistory: (stream: ColumnHistoryStream | null) => void;
  applyHostWalls: (stream: WallHistoryStream | null) => void;
  applyWhaleWalls: (stream: WallHistoryStream | null) => void;
  refreshL2: () => void;
  applyBandHistory: (store: BandHistoryStore | null) => void;
  bandHistoryWants: () => BandHistoryWant[];
  refreshLiquidity: () => void;
  setLiquiditySettings: (settings: LiquiditySettings) => void;
  setLiquidityLane: (choice: LiquidityLaneChoice) => void;
  setL2SupportResistanceSettings: (
    settings: L2SupportResistanceSettings,
  ) => void;
  setL2BookMapSettings: (settings: L2BookMapSettings) => void;
  setWhaleHeatmapSettings: (settings: WhaleHeatmapSettings) => void;
  setAggressiveSettings: (settings: AggressiveOrdersSettings) => void;
  setAggressiveRules: (rules: ClusterRules | null) => void;
  applyAggressiveTape: (tape: AggressiveTape | null) => void;
  /**
   * Hand the terminal's L1 print store to the indicator runtime as `ctx.ticks`.
   *
   * A separate channel from `applyAggressiveTape` on purpose: the bubbles are
   * only drawn where their cluster geometry makes sense (MainPanel withholds the
   * tape above the aggressive timeframes), but a print is a print, and an
   * indicator that prices volume by one has no such limit.
   */
  applyTicks: (tape: AggressiveTape | null) => void;
  applyDeltaProfile: (store: DeltaProfileStore | null) => void;
  applyDeltaTickProfile: (store: DeltaProfileStore | null) => void;
  setLiveDeltaSettings: (settings: LiveDeltaProfileSettings) => void;
  applyOrderBookProfile: (source: BookProfileSource | null) => void;
  setLiveOrderBookSettings: (settings: LiveOrderBookProfileSettings) => void;
  applyAggressiveProfile: (grid: LiquidityGrid | null) => void;
  applyAggressiveProfilePrints: (store: RangePrintStore | null) => void;
  setAggressiveProfileSettings: (settings: AggressiveProfileSettings) => void;
  setAbsorptionSettings: (settings: AbsorptionSettings) => void;
  setAbsorptionRules: (rules: AbsorptionRules | null) => void;
  applyIcebergs: (book: IcebergBook | null) => void;
  refreshIcebergs: () => void;
  setIcebergSettings: (settings: IcebergSettings, unit: string) => void;
  applyExhaustions: (book: ExhaustionBook | null) => void;
  applyCandleMonitor: (monitor: CandleMonitorArrival | null) => void;
  refreshExhaustions: () => void;
  setExhaustionSettings: (settings: ExhaustionSettings, unit: string) => void;
  setExhaustionCandle: (candleMs: number | null) => void;
  applyInitiatives: (book: InitiativeBook | null) => void;
  refreshInitiatives: () => void;
  setInitiativeSettings: (settings: InitiativeSettings) => void;
  setInitiativeCandle: (candleMs: number | null) => void;
  applyLiveRange: (grid: LiquidityGrid | null) => void;
  setLiveRangeSettings: (settings: LiveRangeSettings, unit?: string) => void;
  setLiveRangeWindow: (window: LiveRangeWindow) => void;
  setKillzoneSessions: (sessionIds: KillzoneId[]) => void;
  setOrderFlowDisplayMode: (mode: OrderFlowDisplayMode) => void;
  applyMarkerSnapshot: (
    stats: WhaleTradeStat[],
    intervalMs: number,
    clusterMode: WhaleClusterMode,
    minDeltaShare?: number,
  ) => void;
  setDivergenceSettings: (swingLength: number) => void;
  setActiveDrawingTool: (tool: DrawingToolId | null) => void;
  applyProfileFrame: (frame: ProfileFrame | null) => void;
  applyHistoricalProfiles: (profiles: ProfileFrame[]) => void;
  applyVpinReadings: (readings: VpinReading[]) => void;
  applyBarFlow: (bars: readonly BarSideFlow[]) => void;
  setSessionProfileSettings: (
    settings: SessionProfileIndicatorSettings,
  ) => void;
  setSessionDeltaProfileSettings: (
    settings: SessionDeltaProfileSettings,
  ) => void;
  setVpinCloudSettings: (settings: VpinCloudSettings) => void;
  /** The time range on screen now, in ms, or null before the chart has one. */
  getVisibleRangeMs: () => { fromMs: number; toMs: number } | null;
  subscribeVisibleRangeChange: (
    callback: (fromMs: number, toMs: number) => void,
  ) => () => void;
  subscribeVisibleLogicalRangeChange: (
    callback: (barsBefore: number, barsAfter: number) => void,
  ) => () => void;
}

export type ChartColorScheme = "dark";

export interface ChartPanelProps {
  instrumentIdentity: { symbol: string } & FrameIdentity;
  onFixedRangeProfileRequested?: (
    rangeStartTs: number,
    rangeEndTs: number,
  ) => void;
  onLiveDeltaReachChange?: (share: number) => void;
  onLiveOrderBookReachChange?: (share: number) => void;
  onLiveRangeWindowChange?: (window: LiveRangeWindow) => void;
  onLiquidityLadderReachChange?: (share: number) => void;
  onVolumeDeltaProfileOhlcWidthChange?: (widthPx: number) => void;
  onVolumeDeltaProfileTickTruncatedFrom?: (fromMs: number | null) => void;
  onLiquidityLaneDrawn?: (lane: number) => void;
  onLiquidityHistoryDrawn?: (info: HeatmapHistoryInfo | null) => void;
  colorScheme?: ChartColorScheme;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

const CHART_PALETTE = {
  bg: "#f2efe6",
  text: "rgba(10, 10, 10, 0.85)",
  border: "rgba(10, 10, 10, 0.18)",
  candleUp: "#f8f8f5",
  candleDown: "#111111",
  candleStroke: "#111111",
} as const;

// The dark chart's own colours. `.shell.historical-active` in App.css sets the same values as CSS variables for the
// page around it; change both together.
const DARK_CHART_PALETTE = {
  bg: "#111316",
  text: "#9ca3af",
  border: "rgba(255, 255, 255, 0.09)",
  candleUp: "#36d684",
  candleDown: "#f16a72",
  candleStroke: "#9ca3af",
} as const;

const INDICATOR_PALETTE = {
  refLine: "rgba(10, 10, 10, 0.3)",
  cvdZeroLine: "rgba(10, 10, 10, 0.55)",
  cvdLine: "#111111",
  cvdUp: "#16a34a",
  cvdDown: "#dc2626",
} as const;
const DARK_CVD_ZERO_LINE = "rgba(250, 250, 247, 0.32)";
const DARK_CVD_LINE = "#facc15";
const INDICATOR_LINE_WIDTH = 2;
const MAX_CHART_BARS = MAX_RETAINED_SOURCE_BARS;
const CVD_HISTOGRAM_PRICE_SCALE_ID = "cvd-histogram";
const KILLZONE_MAX_OCCURRENCES = 3;
const LIVE_DELTA_OCCUPANT = "liveDelta";
const LIVE_BOOK_OCCUPANT = "liveBook";
const TICK_PROFILE_OCCUPANT = "tickProfile";
const VPIN_CLOUD_MOTION_INTERVAL_MS = 100;
const RUNTIME_DEFS_BY_ID = new Map<
  IndicatorId,
  RuntimeIndicatorDef<unknown, unknown>
>(RUNTIME_INDICATOR_DEFS.map((def) => [def.id as IndicatorId, def]));

const BAND_STATE_LABEL: Record<BandState, string> = {
  resting: "resting",
  consumed: "consumed",
  pulled: "pulled",
};

interface WallTooltipState {
  wall: WallHover;
  x: number;
  y: number;
}

interface WhaleCardState {
  hit: WhaleHit;
  x: number;
  y: number;
}

interface L2BookMapTooltipState {
  cell: L2BookMapCell;
  x: number;
  y: number;
}

interface WhaleTooltipState {
  cluster: WhaleMarkerCluster;
  x: number;
  y: number;
}

interface AbsorptionTooltipState {
  hover: AbsorptionHover;
  x: number;
  y: number;
}

interface IcebergTooltipState {
  hover: IcebergHover;
  x: number;
  y: number;
}

interface ExhaustionTooltipState {
  hover: ExhaustionHover;
  x: number;
  y: number;
}

interface ExhaustionPinnedState {
  id: string;
  x: number;
  y: number;
}

interface InitiativeTooltipState {
  hover: InitiativeHover;
  x: number;
  y: number;
}

interface InitiativePinnedState {
  id: string;
  x: number;
  y: number;
}

interface BubbleTooltipState {
  words: BubbleWords;
  x: number;
  y: number;
}

interface PivotTooltipState {
  kind: "high" | "low";
  price: number;
  x: number;
  y: number;
}

interface FVGTooltipState {
  hover: FVGHoverData;
  x: number;
  y: number;
}

interface SessionLevelTooltipState {
  hover: SessionLevelHover;
  x: number;
  y: number;
}

export const ChartPanel = forwardRef<ChartPanelHandle, ChartPanelProps>(
  function ChartPanel(
    { instrumentIdentity, onFixedRangeProfileRequested, onLiveDeltaReachChange, onLiveOrderBookReachChange, onLiveRangeWindowChange, onLiquidityLadderReachChange, onVolumeDeltaProfileOhlcWidthChange, onVolumeDeltaProfileTickTruncatedFrom, onLiquidityLaneDrawn, onLiquidityHistoryDrawn, colorScheme },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const colorSchemeRef = useRef(colorScheme);
    colorSchemeRef.current = colorScheme;
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const lastBarRef = useRef<BarFrame | null>(null);
    const allBarsRef = useRef<BarFrame[]>([]);
    const chartBarsRevisionRef = useRef(0);
    const barTimesRevisionRef = useRef(0);
    const barOpensRef = useRef<ChartBarOpens | null>(null);
    const chartRowsRef = useRef<{
      barsRevision: number;
      timesRevision: number;
      rows: ReturnType<typeof toCandlestick>[];
    } | null>(null);
    const orderFlowCacheRef = useRef<{
      timesRevision: number;
      delta: (number | null)[];
      cvd: (number | null)[];
      threshold: number;
    } | null>(null);
    const raw1mBarsRef = useRef<BarFrame[]>([]);
    const enabledIndicatorsRef = useRef<Set<IndicatorId>>(new Set());
    const visibleIndicatorsRef = useRef<Set<IndicatorId>>(new Set());
    const requestedIndicatorsRef = useRef<Set<IndicatorId>>(new Set());
    const requestedVisibilityRef = useRef<Set<IndicatorId>>(new Set());
    const indicatorSetAppliedRef = useRef(false);
    const historicalIndicatorCapabilitiesRef =
      useRef<Set<HistoricalIndicatorCapability> | null>(null);
    const historicalIndicatorProviderRef = useRef<BarFrame["provider"] | null>(
      null,
    );
    const runtimeSettingsByIdRef = useRef<
      Readonly<Partial<Record<IndicatorId, unknown>>>
    >({});
    const [indicatorRuntime] = useState(() =>
      createIndicatorRuntime(RUNTIME_INDICATOR_DEFS),
    );
    const indicatorRuntimeRef = useRef(indicatorRuntime);
    const runtimeIndicatorSeriesRef = useRef<
      Map<IndicatorId, { series: ISeriesApi<"Line">; lineKey: string }[]>
    >(new Map());
    const runtimePriceLinesRef = useRef<Map<IndicatorId, IPriceLine[]>>(
      new Map(),
    );
    const drawKernelPrimitivesRef = useRef<Map<number, DrawKernelPrimitive>>(
      new Map(),
    );
    const markerSeriesControllersRef = useRef<
      Map<number, MarkerSeriesController>
    >(new Map());
    const drawKernelHostsRef = useRef<Map<number, ISeriesApi<SeriesType>>>(
      new Map(),
    );
    const ownersByPaneRef = useRef<Map<number, IndicatorId[]>>(new Map());
    const visibleKillzoneSessionsRef = useRef<Set<KillzoneId>>(
      new Set(
        KILLZONE_SESSIONS.filter((session) => session.defaultShown).map(
          (session) => session.id,
        ),
      ),
    );
    const killzoneNyPartsCacheRef = useRef<NyPartsCache>(new Map());
    const cvdLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const cvdHistogramSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const cvdCandleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const cvdDisplayModeRef = useRef<OrderFlowDisplayMode>("line");
    const whaleMarkersPrimitiveRef = useRef<WhaleMarkersPrimitive | null>(null);
    const killzonesPrimitiveRef = useRef<KillzonesPrimitive | null>(null);
    const deltaDivergencePricePrimitiveRef =
      useRef<DeltaDivergencePrimitive | null>(null);
    const deltaDivergenceCvdPrimitiveRef =
      useRef<DeltaDivergencePrimitive | null>(null);
    const deltaDivergenceSwingLengthRef = useRef(DEFAULT_SWING_LENGTH);
    // Every chart-owned object CVD Divergence draws -- its pane's histogram,
    // both divergence-label primitives, the segment primitives, the two
    // trend averages and the borrowed cumulative CVD -- lives inside this one
    // renderer. Individual refs here were the source of three separate
    // "primitive never came back after a remount" bugs, because each had to be
    // remembered by the chart-destroy cleanup and StrictMode makes the
    // forgotten-ref path the normal one. One ref, one release.
    const cvdDivergenceRendererRef = useRef<CvdDivergenceRenderer | null>(null);
    // Settings still live on the panel: they arrive through
    // `setIndicators`/`setIndicatorSettings`, which can run before the chart
    // exists, so the renderer is handed a fresh snapshot on every pass.
    const cvdDivergenceSettingsRef = useRef<CvdDivergenceIndicatorSettings>(
      DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
    );
    const volumeProfilePrimitiveRef = useRef<VolumeProfilePrimitive | null>(
      null,
    );
    const netDeltaProfilePrimitiveRef = useRef<NetDeltaProfilePrimitive | null>(
      null,
    );
    const deltaProfilePrimitiveRef = useRef<DeltaProfilePrimitive | null>(null);
    const sessionDeltaProfilePrimitiveRef =
      useRef<SessionDeltaProfilePrimitive | null>(null);
    const sessionDeltaProfileCacheRef = useRef<{
      key: string;
      profiles: ReturnType<typeof buildSessionDeltaProfile>[];
      developingSessionStartTs: number | null;
    } | null>(null);
    const volumeDeltaProfileOhlcPrimitiveRef =
      useRef<VolumeDeltaProfileOhlcPrimitive | null>(null);
    const volumeDeltaProfileTickPrimitiveRef =
      useRef<VolumeDeltaProfileTickPrimitive | null>(null);
    const latestLiquiditySettingsRef = useRef<LiquiditySettings | null>(null);
    const heatmapClusterRows = (): number | null => latestLiquiditySettingsRef.current?.clusterRows ?? null;
    const axisInsetKeyRef = useRef("");
    const latestProfileFrameRef = useRef<ProfileFrame | null>(null);
    const latestHistoricalProfilesRef = useRef<ProfileFrame[]>([]);
    const vpinCloudPrimitiveRef = useRef<VpinCloudPrimitive | null>(null);
    const latestVpinReadingsRef = useRef<VpinReading[]>([]);
    const candleCloseTimerPrimitiveRef =
      useRef<CandleCloseTimerPrimitive | null>(null);
    const historicalRollMarkerPrimitiveRef = useRef<RollMarkerPrimitive | null>(
      null,
    );
    const trendlinePrimitiveRef = useRef<TrendlinePrimitive | null>(null);
    const fibonacciPrimitiveRef = useRef<FibonacciPrimitive | null>(null);
    const activeDrawingToolRef = useRef<DrawingToolId | null>(null);
    const drawingPlacementRef = useRef<DrawingPlacementMode>(
      DRAWING_PLACEMENT_IDLE,
    );
    const allDrawingsRef = useRef<DrawnObject[]>([]);
    const instrumentIdentityRef = useRef(instrumentIdentity);
    const onFixedRangeProfileRequestedRef = useRef(
      onFixedRangeProfileRequested,
    );
    onFixedRangeProfileRequestedRef.current = onFixedRangeProfileRequested;
    const onLiveDeltaReachChangeRef = useRef(onLiveDeltaReachChange);
    onLiveDeltaReachChangeRef.current = onLiveDeltaReachChange;
    const onLiveOrderBookReachChangeRef = useRef(onLiveOrderBookReachChange);
    onLiveOrderBookReachChangeRef.current = onLiveOrderBookReachChange;
    const onLiveRangeWindowChangeRef = useRef(onLiveRangeWindowChange);
    onLiveRangeWindowChangeRef.current = onLiveRangeWindowChange;
    const onLiquidityLadderReachChangeRef = useRef(onLiquidityLadderReachChange);
    onLiquidityLadderReachChangeRef.current = onLiquidityLadderReachChange;
    const onVolumeDeltaProfileOhlcWidthChangeRef = useRef(onVolumeDeltaProfileOhlcWidthChange);
    onVolumeDeltaProfileOhlcWidthChangeRef.current = onVolumeDeltaProfileOhlcWidthChange;
    const onVolumeDeltaProfileTickTruncatedFromRef = useRef(onVolumeDeltaProfileTickTruncatedFrom);
    onVolumeDeltaProfileTickTruncatedFromRef.current = onVolumeDeltaProfileTickTruncatedFrom;
    const [whaleTooltip, setWhaleTooltip] = useState<WhaleTooltipState | null>(
      null,
    );
    const liquidityPrimitiveRef = useRef<LiquidityHeatmapPrimitive | null>(
      null,
    );
    const liquidityLaneRef = useRef<LiquidityLaneChoice>("0");
    const onLiquidityLaneDrawnRef = useRef(onLiquidityLaneDrawn);
    onLiquidityLaneDrawnRef.current = onLiquidityLaneDrawn;
    const onLiquidityHistoryDrawnRef = useRef(onLiquidityHistoryDrawn);
    onLiquidityHistoryDrawnRef.current = onLiquidityHistoryDrawn;
    const latestHeatmapHistoryRef = useRef<HeatmapHistory | null>(null);
    const latestColumnHistoryRef = useRef<ColumnHistoryStream | null>(null);
    const runtimeColumnHistoryRef = useRef<ColumnHistoryStream | null>(null);
    const latestHostWallsRef = useRef<WallHistoryStream | null>(null);
    const latestWhaleWallsRef = useRef<WallHistoryStream | null>(null);
    const whalePrimitiveRef = useRef<WhaleLimitHeatmapPrimitive | null>(null);
    const whaleSettingsRef = useRef<WhaleHeatmapSettings>(DEFAULT_WHALE_HEATMAP_SETTINGS);
    const absorptionHistoryRef = useRef<AbsorptionHistory | null>(null);
    const latestExhaustionBookRef = useRef<ExhaustionBook | null>(null);
    const latestInitiativeBookRef = useRef<InitiativeBook | null>(null);
    const heatmapHistoryUnsubscribeRef = useRef<(() => void) | null>(null);
    useEffect(() => () => {
      heatmapHistoryUnsubscribeRef.current?.();
      heatmapHistoryUnsubscribeRef.current = null;
    }, []);
    const latestAggressiveProfilePrintsRef = useRef<RangePrintStore | null>(null);
    const aggressiveProfilePrintsUnsubscribeRef = useRef<(() => void) | null>(null);
    useEffect(() => () => {
      aggressiveProfilePrintsUnsubscribeRef.current?.();
      aggressiveProfilePrintsUnsubscribeRef.current = null;
    }, []);
    const ticksTapeRef = useRef<AggressiveTape | null>(null);
    const ticksUnsubscribeRef = useRef<(() => void) | null>(null);
    const ticksRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
      ticksUnsubscribeRef.current?.();
      ticksUnsubscribeRef.current = null;
      if (ticksRefreshTimerRef.current !== null) clearTimeout(ticksRefreshTimerRef.current);
      ticksRefreshTimerRef.current = null;
    }, []);
    const l2SupportResistancePrimitiveRef =
      useRef<L2SupportResistancePrimitive | null>(null);
    const l2BookMapPrimitiveRef = useRef<L2BookMapPrimitive | null>(null);
    const aggressivePrimitiveRef = useRef<AggressiveOrdersPrimitive | null>(
      null,
    );
    const absorptionPrimitiveRef = useRef<AbsorptionPrimitive | null>(null);
    const icebergPrimitiveRef = useRef<IcebergPrimitive | null>(null);
    const exhaustionPrimitiveRef = useRef<ExhaustionPrimitive | null>(null);
    const initiativePrimitiveRef = useRef<InitiativePrimitive | null>(null);
    const latestIcebergBookRef = useRef<IcebergBook | null>(null);
    const latestIcebergSettingsRef = useRef<IcebergSettings | null>(null);
    const latestIcebergUnitRef = useRef<string>("");
    const latestExhaustionSettingsRef = useRef<ExhaustionSettings | null>(null);
    const latestExhaustionUnitRef = useRef<string>("");
    const latestExhaustionCandleRef = useRef<number | null>(null);
    const latestInitiativeSettingsRef = useRef<InitiativeSettings | null>(null);
    const latestInitiativeCandleRef = useRef<number | null>(null);
    const liveRangePrimitiveRef = useRef<LiveRangePrimitive | null>(null);
    const latestLiveRangeGridRef = useRef<LiquidityGrid | null>(null);
    const latestLiveRangeSettingsRef = useRef<LiveRangeSettings>(DEFAULT_LIVE_RANGE_SETTINGS);
    const latestLiveRangeUnitRef = useRef("");
    const latestLiveRangeWindowRef = useRef<LiveRangeWindow>(WHOLE_WINDOW);
    const liveRangeHistoryRef = useRef<LiveRangeHistory | null>(null);
    const latestAggressiveTapeRef = useRef<AggressiveTape | null>(null);
    const deltaPrimitiveRef = useRef<LiveDeltaProfilePrimitive | null>(null);
    const latestDeltaProfileRef = useRef<DeltaProfileStore | null>(null);
    const latestDeltaTickProfileRef = useRef<DeltaProfileStore | null>(null);
    const candleDeltaSourceRef = useRef<CandleDeltaSource | null>(null);
    const bookPrimitiveRef = useRef<LiveOrderBookProfilePrimitive | null>(null);
    const latestBookSourceRef = useRef<BookProfileSource | null>(null);
    const aggressiveProfilePrimitiveRef = useRef<AggressiveProfilePrimitive | null>(null);
    const aggressiveProfilePaneRef = useRef<AggressiveProfilePane | null>(null);
    const latestAggressiveProfileGridRef = useRef<LiquidityGrid | null>(null);
    const latestAggressiveProfileSettingsRef = useRef<AggressiveProfileSettings | null>(null);
    const aggressiveProfileSourceRef = useRef<AggressiveProfileSource | null>(null);
    const latestLiquidityRef = useRef<LiquidityGrid | null>(null);
    const latestL2StoreRef = useRef<L2Store | null>(null);
    const liveL2Ref = useRef<IndicatorL2 | null>(null);
    const latestL2HistoryRef = useRef<L2HistoryRequester | null>(null);
    const historicalL2Ref = useRef<IndicatorL2>(historicalL2());
    const historicalLiquidityRef = useRef<IndicatorLiquidity | null>(null);
    const historicalGridRef = useRef<LiquidityGrid | null>(null);
    const historicalTapeRef = useRef<AggressiveTape | null>(null);
    const historicalBookSourceRef = useRef<BookProfileSource | null>(null);
    const [wallTooltip, setWallTooltip] = useState<WallTooltipState | null>(
      null,
    );
    const [l2BookMapTooltip, setL2BookMapTooltip] =
      useState<L2BookMapTooltipState | null>(null);
    const [whaleHover, setWhaleHover] = useState<WhaleCardState | null>(null);
    const [whalePinned, setWhalePinned] = useState<WhaleCardState | null>(null);
    const [absorptionTooltip, setAbsorptionTooltip] =
      useState<AbsorptionTooltipState | null>(null);
    const [icebergTooltip, setIcebergTooltip] =
      useState<IcebergTooltipState | null>(null);
    const [exhaustionTooltip, setExhaustionTooltip] =
      useState<ExhaustionTooltipState | null>(null);
    const [exhaustionPinned, setExhaustionPinned] =
      useState<ExhaustionPinnedState | null>(null);
    const [exhaustionBookState, setExhaustionBookState] = useState<{ book: ExhaustionBook | null; revision: number }>({ book: null, revision: 0 });
    const [candleMonitorState, setCandleMonitorState] = useState<CandleMonitorArrival | null>(null);
    const [exhaustionShown, setExhaustionShown] = useState(false);
    const [exhaustionSettingsState, setExhaustionSettingsState] = useState<ExhaustionSettings | undefined>(undefined);
    const [exhaustionUnit, setExhaustionUnit] = useState("");
    const [exhaustionCandleMsState, setExhaustionCandleMsState] = useState<number | null>(null);
    const [initiativeTooltip, setInitiativeTooltip] = useState<InitiativeTooltipState | null>(null);
    const [initiativePinned, setInitiativePinned] = useState<InitiativePinnedState | null>(null);
    const [initiativeBookState, setInitiativeBookState] = useState<{ book: InitiativeBook | null; revision: number }>({ book: null, revision: 0 });
    const [initiativeSettingsState, setInitiativeSettingsState] = useState<InitiativeSettings | undefined>(undefined);
    const [initiativeCandleMsState, setInitiativeCandleMsState] = useState<number | null>(null);
    const [liveRangeShown, setLiveRangeShown] = useState(false);
    const [liveRangeReport, setLiveRangeReport] = useState<LiveRangeReport | null>(null);
    const [liveRangeSettingsState, setLiveRangeSettingsState] = useState<LiveRangeSettings>(DEFAULT_LIVE_RANGE_SETTINGS);
    const [liveRangeCardPosition, setLiveRangeCardPosition] = useState<LiveRangeCardPosition | null>(() => loadLiveRangeCardPosition());
    const liveRangePaneOf = () => {
      const pane = containerRef.current?.parentElement ?? null;
      if (pane === null) return null;
      const rect = pane.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: pane.clientWidth, height: pane.clientHeight };
    };
    const moveLiveRangeCard = (position: LiveRangeCardPosition) => {
      setLiveRangeCardPosition(position);
      saveLiveRangeCardPosition(position);
    };
    const resetLiveRangeCard = () => {
      setLiveRangeCardPosition(null);
      saveLiveRangeCardPosition(null);
    };
    const [bubbleTooltip, setBubbleTooltip] =
      useState<BubbleTooltipState | null>(null);
    const [pivotTooltip, setPivotTooltip] = useState<PivotTooltipState | null>(
      null,
    );
    const [fvgTooltip, setFvgTooltip] = useState<FVGTooltipState | null>(null);
    const [sessionLevelTooltip, setSessionLevelTooltip] =
      useState<SessionLevelTooltipState | null>(null);
    const [tableOverlays, setTableOverlays] = useState<
      readonly { key: string; position: TablePosition; committedGrid: Record<string, TableCell> }[]
    >([]);
    const [bottomTableRightPx, setBottomTableRightPx] = useState(AXIS_INSET_GAP_PX);

    function clearTooltips() {
      setWhaleTooltip(null);
      setWallTooltip(null);
      setL2BookMapTooltip(null);
      setWhaleHover(null);
      setWhalePinned(null);
      setAbsorptionTooltip(null);
      setExhaustionTooltip(null);
      setExhaustionPinned(null);
      exhaustionPrimitiveRef.current?.setHover(null);
      setInitiativeTooltip(null);
      setInitiativePinned(null);
      initiativePrimitiveRef.current?.setHover(null);
      setBubbleTooltip(null);
      setPivotTooltip(null);
      setFvgTooltip(null);
    }

    function syncDrawingPrimitives(forInstrument: readonly DrawnObject[]) {
      trendlinePrimitiveRef.current?.setDrawings(
        forInstrument.filter(
          (drawing): drawing is TrendlineDrawing =>
            drawing.type === "trendline",
        ),
      );
      fibonacciPrimitiveRef.current?.setDrawings(
        forInstrument.filter(
          (drawing): drawing is FibonacciDrawing =>
            drawing.type === "fibonacci",
        ),
      );
    }

    function setSelectedDrawing(id: string | null) {
      trendlinePrimitiveRef.current?.setSelectedId(id);
      fibonacciPrimitiveRef.current?.setSelectedId(id);
    }

    function setPendingOnActiveTool(
      pending: { first: DrawingPoint; cursor: DrawingPoint } | null,
    ) {
      trendlinePrimitiveRef.current?.setPending(
        activeDrawingToolRef.current === "trendline" ? pending : null,
      );
      fibonacciPrimitiveRef.current?.setPending(
        activeDrawingToolRef.current === "fibonacci" ? pending : null,
      );
    }

    /**
     * One profile frame, three renderings: the frame goes only to the
     * primitive the selected view draws with, so switching views moves the
     * profile instead of stacking a second copy of it on the chart.
     */
    function applySessionProfileVisibility() {
      const frame = latestProfileFrameRef.current;
      const historical = latestHistoricalProfilesRef.current;
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const settings =
        (runtimeSettingsByIdRef.current[SESSION_PROFILE_INDICATOR_ID] as
          | SessionProfileIndicatorSettings
          | undefined) ?? DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS;
      const show =
        enabled.has(SESSION_PROFILE_INDICATOR_ID) &&
        visible.has(SESSION_PROFILE_INDICATOR_ID);
      const shownFrame = show ? frame : null;
      const shownHistorical = show ? historical : [];
      const view = settings.view;

      const isVolume = view === "volumeProfile";
      volumeProfilePrimitiveRef.current?.setProfile(isVolume ? shownFrame : null);
      volumeProfilePrimitiveRef.current?.setHistoricalProfiles(
        isVolume ? shownHistorical : [],
      );

      const isNetDelta = view === "netDeltaProfile";
      netDeltaProfilePrimitiveRef.current?.setProfile(
        isNetDelta ? shownFrame : null,
      );
      netDeltaProfilePrimitiveRef.current?.setHistoricalProfiles(
        isNetDelta ? shownHistorical : [],
      );

      const isDelta = view === "deltaProfile";
      deltaProfilePrimitiveRef.current?.setProfile(isDelta ? shownFrame : null);
      deltaProfilePrimitiveRef.current?.setHistoricalProfiles(
        isDelta ? shownHistorical : [],
      );
    }

    function applySessionDeltaProfileVisibility() {
      const primitive = sessionDeltaProfilePrimitiveRef.current;
      if (!primitive) return;

      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const showIndicator =
        enabled.has("sessionDeltaProfile") &&
        visible.has("sessionDeltaProfile");
      const bars = allBarsRef.current;

      if (!showIndicator || bars.length === 0) {
        primitive.setProfile(null);
        sessionDeltaProfileCacheRef.current = null;
        return;
      }

      const settings =
        (runtimeSettingsByIdRef.current.sessionDeltaProfile as
          | SessionDeltaProfileSettings
          | undefined) ?? DEFAULT_SESSION_DELTA_PROFILE_SETTINGS;
      const sessionMs = Number(settings.sessionPeriodMs);
      const lastBar = bars[bars.length - 1];
      const cacheKey = [
        chartBarsRevisionRef.current,
        sessionMs,
        settings.maxDisplaySessions,
        settings.rowWidth,
        settings.valueAreaPercent,
      ].join("|");
      const cached = sessionDeltaProfileCacheRef.current;
      if (cached && cached.key === cacheKey) {
        primitive.setProfiles(cached.profiles, cached.developingSessionStartTs);
        return;
      }

      const MIN_DEVELOPING_SESSION_BARS = 10;
      const latestTs = lastBar?.ts_open ?? 0;
      const latestSessionStart = Math.floor(latestTs / sessionMs) * sessionMs;
      const profiles: ReturnType<typeof buildSessionDeltaProfile>[] = [];
      let developingSessionStartTs: number | null = null;
      for (let index = 0; index < settings.maxDisplaySessions; index += 1) {
        const sessionStartTs = latestSessionStart - index * sessionMs;
        const sessionEndTs = sessionStartTs + sessionMs;
        const sessionBars = bars.filter(
          (bar) => bar.ts_open >= sessionStartTs && bar.ts_open < sessionEndTs,
        );
        if (sessionBars.length === 0) continue;
        if (index === 0 && sessionBars.length < MIN_DEVELOPING_SESSION_BARS) {
          continue;
        }
        if (index === 0) developingSessionStartTs = sessionStartTs;
        profiles.push(
          buildSessionDeltaProfile(
            sessionBars,
            sessionStartTs,
            sessionEndTs,
            settings.rowWidth,
            sessionMs,
            settings.valueAreaPercent,
          ),
        );
      }

      sessionDeltaProfileCacheRef.current = {
        key: cacheKey,
        profiles,
        developingSessionStartTs,
      };
      primitive.setProfiles(profiles, developingSessionStartTs);
    }

    function applyVolumeDeltaProfileOhlcVisibility() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const showIndicator =
        enabled.has("volumeDeltaProfileOhlc") &&
        visible.has("volumeDeltaProfileOhlc");
      const settings = runtimeSettingsByIdRef.current[
        "volumeDeltaProfileOhlc"
      ] as any;
      volumeDeltaProfileOhlcPrimitiveRef.current?.update(
        showIndicator ? allBarsRef.current : [],
      );
      if (settings) {
        volumeDeltaProfileOhlcPrimitiveRef.current?.updateSettings(settings);
      }
      refreshAxisInset();
    }

    function axisOccupants(): (AxisOccupant & { key: string })[] {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const occupants: (AxisOccupant & { key: string })[] = [];
      const ladder = latestLiquiditySettingsRef.current;
      if (enabled.has("passiveLiquidity") && visible.has("passiveLiquidity") && ladder !== null && ladder.showLadder) {
        occupants.push({
          key: `ladder:${ladder.ladderReach}`,
          widthPx: (paneWidth) => liquidityPrimitiveRef.current?.ladderWidthPx(paneWidth) ?? 0,
          resize: (widthPx, paneWidth) => {
            if (paneWidth > 0) onLiquidityLadderReachChangeRef.current?.(Math.min(MAX_LADDER_REACH, Math.max(MIN_LADDER_REACH, widthPx / paneWidth)));
          },
        });
      }
      if (enabled.has("volumeDeltaProfileOhlc") && visible.has("volumeDeltaProfileOhlc")) {
        const ohlc = runtimeSettingsByIdRef.current.volumeDeltaProfileOhlc as VolumeDeltaProfileOhlcSettings | undefined;
        const widthPx = ohlc?.profileWidth ?? DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS.profileWidth;
        occupants.push({
          key: `ohlc:${widthPx}`,
          widthPx: () => widthPx,
          resize: (next) => {
            const stepped = Math.round(next / PROFILE_WIDTH_STEP_PX) * PROFILE_WIDTH_STEP_PX;
            onVolumeDeltaProfileOhlcWidthChangeRef.current?.(Math.min(MAX_PROFILE_WIDTH_PX, Math.max(MIN_PROFILE_WIDTH_PX, stepped)));
          },
        });
      }
      if (enabled.has("l2BookMap") && visible.has("l2BookMap") && (l2BookMapPrimitiveRef.current?.settings.showProfile ?? false)) {
        occupants.push({ key: "bookMap", widthPx: (paneWidth) => BOOK_MAP_PROFILE_EDGE_GAP_PX + bookMapProfileWidthPx(paneWidth) });
      }
      if (enabled.has("volumeDeltaProfileTick") && visible.has("volumeDeltaProfileTick")) {
        const beside = occupants.slice();
        const tick = runtimeSettingsByIdRef.current.volumeDeltaProfileTick as VolumeDeltaProfileTickSettings | undefined;
        const widthPx = tick?.profileWidth ?? DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS.profileWidth;
        occupants.push({
          key: `${TICK_PROFILE_OCCUPANT}:${widthPx}`,
          widthPx: (paneWidth) => axisInsetPx(beside, paneWidth) + widthPx,
        });
      }
      if (enabled.has("liveDeltaProfile") && visible.has("liveDeltaProfile")) {
        occupants.push({
          key: LIVE_DELTA_OCCUPANT,
          widthPx: () => {
            const frame = deltaPrimitiveRef.current?.frame;
            return frame ? frame.width - frame.right + frame.reach : 0;
          },
        });
      }
      if (enabled.has("liveOrderBookProfile") && visible.has("liveOrderBookProfile")) {
        occupants.push({
          key: LIVE_BOOK_OCCUPANT,
          widthPx: () => {
            const frame = bookPrimitiveRef.current?.frame;
            return frame ? frame.width - frame.right + frame.reach : 0;
          },
        });
      }
      return occupants;
    }

    function mainPaneInset(paneWidth: number): number {
      return axisInsetPx(axisOccupants(), paneWidth);
    }

    function tickProfileRightInset(paneWidth: number): number {
      const occupants = axisOccupants();
      const tick = occupants.findIndex((occupant) => occupant.key.startsWith(`${TICK_PROFILE_OCCUPANT}:`));
      return axisInsetPx(tick < 0 ? occupants : occupants.slice(0, tick), paneWidth);
    }

    function refreshAxisInset() {
      const key = axisOccupants().map((occupant) => occupant.key).join("|");
      if (key === axisInsetKeyRef.current) return;
      axisInsetKeyRef.current = key;
      drawKernelPrimitivesRef.current.get(0)?.setRightInset(mainPaneInset);
      icebergPrimitiveRef.current?.setRightInset(mainPaneInset);
    }

    function applyVolumeDeltaProfileTickVisibility() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const showIndicator =
        enabled.has("volumeDeltaProfileTick") &&
        visible.has("volumeDeltaProfileTick");
      const settings = runtimeSettingsByIdRef.current[
        "volumeDeltaProfileTick"
      ] as VolumeDeltaProfileTickSettings | undefined;
      volumeDeltaProfileTickPrimitiveRef.current?.setRightInset(tickProfileRightInset);
      // The same trades the Live Delta Profile reads: the store when there is
      // one, the candles on a historical chart, whose sides are an estimate.
      volumeDeltaProfileTickPrimitiveRef.current?.update(
        showIndicator ? allBarsRef.current : [],
        showIndicator
          ? latestDeltaTickProfileRef.current ?? candleDeltaSource()
          : null,
      );
      if (settings) {
        volumeDeltaProfileTickPrimitiveRef.current?.updateSettings(settings);
      }
    }

    function applyVpinCloudVisibility() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const showIndicator =
        enabled.has("vpinCloud") && visible.has("vpinCloud");
      vpinCloudPrimitiveRef.current?.setReadings(
        showIndicator ? latestVpinReadingsRef.current : [],
      );
      vpinCloudPrimitiveRef.current?.setBars(
        showIndicator ? allBarsRef.current : [],
      );
    }

    function axisNeighbour(): AxisNeighbour | null {
      const neighbours = axisOccupants().filter((occupant) => occupant.key !== LIVE_DELTA_OCCUPANT && occupant.key !== LIVE_BOOK_OCCUPANT);
      if (neighbours.length === 0) return null;
      const widest = (paneWidth: number) => neighbours.reduce((best, next) => (next.widthPx(paneWidth) > best.widthPx(paneWidth) ? next : best));
      return {
        widthPx: (paneWidth) => widest(paneWidth).widthPx(paneWidth),
        resize: (widthPx, paneWidth) => widest(paneWidth).resize?.(widthPx, paneWidth),
      };
    }

    function deltaNeighbour(showDelta: boolean): AxisNeighbour | null {
      const delta = deltaPrimitiveRef.current;
      if (!showDelta || delta === null || delta.store === null) return null;
      return {
        widthPx: (paneWidth) => delta.widthPx(paneWidth),
        resize: (widthPx, paneWidth) => {
          const reach = delta.frame?.reach ?? delta.settings.widthShare * paneWidth;
          onLiveDeltaReachChangeRef.current?.(reachShareForWidth(reach, delta.widthPx(paneWidth), widthPx, paneWidth, MIN_WIDTH_SHARE, MAX_WIDTH_SHARE));
        },
      };
    }

    function aggressiveProfileSource(): AggressiveProfileSource | null {
      const grid = latestAggressiveProfileGridRef.current;
      if (grid === null) return null;
      if (aggressiveProfileSourceRef.current === null) aggressiveProfileSourceRef.current = new AggressiveProfileSource(grid, () => latestAggressiveProfilePrintsRef.current);
      return aggressiveProfileSourceRef.current;
    }

    function candleDeltaSource(): CandleDeltaSource | null {
      if (historicalIndicatorCapabilitiesRef.current === null) return null;
      const rowWidth = baseRowWidthFor(instrumentIdentityRef.current, allBarsRef.current.at(-1)?.symbol ?? "");
      if (candleDeltaSourceRef.current?.rowWidth !== rowWidth) {
        candleDeltaSourceRef.current = new CandleDeltaSource(rowWidth, () => {
          const range = chartRef.current?.timeScale().getVisibleRange();
          return range ? { from: Number(range.from) * 1000, to: Number(range.to) * 1000 } : null;
        });
        candleDeltaSourceRef.current.setBars(allBarsRef.current);
        console.info("Live Delta Profile: historical chart, delta estimated from the candles on screen");
      }
      return candleDeltaSourceRef.current;
    }

    function applyLiquidityVisibility() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const showIndicator =
        enabled.has("passiveLiquidity") && visible.has("passiveLiquidity");
      const showL2Levels =
        enabled.has("l2SupportResistance") &&
        visible.has("l2SupportResistance");
      const showL2BookMap =
        enabled.has("l2BookMap") && visible.has("l2BookMap");
      if (!showL2BookMap || latestLiquidityRef.current === null) {
        setL2BookMapTooltip(null);
      }
      const historical = historicalIndicatorCapabilitiesRef.current !== null;
      const grid = historical ? historicalGridRef.current : latestLiquidityRef.current;
      liquidityPrimitiveRef.current?.setLanes(historical ? null : latestL2StoreRef.current?.lanes ?? null);
      liquidityPrimitiveRef.current?.setHistory(historical ? null : latestHeatmapHistoryRef.current);
      liquidityPrimitiveRef.current?.setGrid(showIndicator ? grid : null);
      const l2 = historicalIndicatorCapabilitiesRef.current !== null
        ? historicalL2Ref.current : liveL2Ref.current;
      l2SupportResistancePrimitiveRef.current?.setSource(
        showL2Levels ? l2 : null,
        showL2Levels && l2 === null ? latestLiquidityRef.current : null,
      );
      l2BookMapPrimitiveRef.current?.setSource(
        showL2BookMap ? l2 : null,
        showL2BookMap && l2 === null ? latestLiquidityRef.current : null,
      );
      const showWhaleHeatmap =
        enabled.has("whaleLimitOrderHeatmap") &&
        visible.has("whaleLimitOrderHeatmap");
      if (!showWhaleHeatmap) {
        setWhaleHover(null);
        setWhalePinned(null);
      }
      const whale = whalePrimitiveRef.current;
      if (whale !== null) {
        whale.setActive(showWhaleHeatmap);
        if (showWhaleHeatmap) {
          const identity = instrumentIdentityRef.current;
          whale.setIdentity(identity.provider === "BINANCE" ? identity.marketKind : historical ? "HISTORICAL" : "", identity.symbol);
          whale.setStream(historical ? null : latestWhaleWallsRef.current);
          whale.setSource(l2);
        }
      }
      const showAggressive =
        enabled.has("aggressiveOrders") && visible.has("aggressiveOrders");
      aggressivePrimitiveRef.current?.setTape(
        showAggressive ? historical ? historicalTapeRef.current : latestAggressiveTapeRef.current : null,
      );
      const showDelta =
        enabled.has("liveDeltaProfile") && visible.has("liveDeltaProfile");
      deltaPrimitiveRef.current?.setStore(
        showDelta ? latestDeltaProfileRef.current ?? candleDeltaSource() : null,
      );
      deltaPrimitiveRef.current?.setNeighbour(axisNeighbour());
      const showBook =
        enabled.has("liveOrderBookProfile") && visible.has("liveOrderBookProfile");
      const book = bookPrimitiveRef.current;
      if (book) {
        const ladder = latestLiquiditySettingsRef.current;
        if (ladder !== null) book.setHeatmapSettings(ladder);
        book.setSource(showBook ? historical ? historicalBookSourceRef.current : latestBookSourceRef.current : null);
        book.setNeighbour(deltaNeighbour(showDelta) ?? axisNeighbour());
      }
      const showAggressiveProfile =
        enabled.has("aggressiveOrdersProfile") && visible.has("aggressiveOrdersProfile");
      const aggressiveProfile = aggressiveProfilePrimitiveRef.current;
      const aggressivePane = aggressiveProfilePaneRef.current;
      if (aggressivePane && showAggressiveProfile && !aggressivePane.attached) {
        aggressivePane.attach();
        aggressiveProfile?.repaint();
      }
      if (aggressivePane && !showAggressiveProfile) aggressivePane.detach();
      aggressivePane?.placeTag();
      if (aggressiveProfile) aggressiveProfile.setSource(showAggressiveProfile ? aggressiveProfileSource() : null);
      const showAbsorption =
        enabled.has("absorptionDetector") && visible.has("absorptionDetector");
      absorptionPrimitiveRef.current?.setSources(
        showAbsorption ? grid : null,
      );
      absorptionPrimitiveRef.current?.setHistory(historical ? null : absorptionHistoryRef.current);
      const showExhaustion =
        enabled.has("exhaustion") && visible.has("exhaustion");
      if (!showExhaustion) {
        setExhaustionTooltip(null);
        setExhaustionPinned(null);
        exhaustionPrimitiveRef.current?.setHover(null);
      }
      exhaustionPrimitiveRef.current?.setShown(showExhaustion);
      setExhaustionShown(showExhaustion);
      exhaustionPrimitiveRef.current?.setBook(latestExhaustionBookRef.current);
      const showInitiative =
        enabled.has("initiative") && visible.has("initiative");
      if (!showInitiative) {
        setInitiativeTooltip(null);
        setInitiativePinned(null);
        initiativePrimitiveRef.current?.setHover(null);
      }
      initiativePrimitiveRef.current?.setShown(showInitiative);
      initiativePrimitiveRef.current?.setBook(latestInitiativeBookRef.current);
      const showLiveRange =
        enabled.has("liveRangeControl") && visible.has("liveRangeControl") && !historical;
      liveRangePrimitiveRef.current?.setShown(showLiveRange);
      liveRangePrimitiveRef.current?.setGrid(showLiveRange ? latestLiveRangeGridRef.current : null);
      setLiveRangeShown(showLiveRange);
      const showIcebergs =
        enabled.has("icebergDetector") && visible.has("icebergDetector");
      icebergPrimitiveRef.current?.setShown(showIcebergs);
      icebergPrimitiveRef.current?.setBook(
        showIcebergs ? latestIcebergBookRef.current : null,
      );
      refreshAxisInset();
    }

    function rebuildLiveL2(): void {
      const store = latestL2StoreRef.current;
      liveL2Ref.current = indicatorL2Of(store, () => latestLiquidityRef.current, latestL2HistoryRef.current, latestHostWallsRef.current);
      liquidityPrimitiveRef.current?.setLanes(store?.lanes ?? null);
      applyLiquidityVisibility();
      if (historicalIndicatorCapabilitiesRef.current !== null) return;
      indicatorRuntimeRef.current.setL2(liveL2Ref.current, allBarsRef.current);
      recomputeIndicators();
    }

    function chartBarOpens(): ChartBarOpens {
      const revision = barTimesRevisionRef.current;
      const cached = barOpensRef.current;
      if (cached !== null && cached.revision === revision) return cached;
      const next = {
        revision,
        opensMs: candleBars(allBarsRef.current).map((bar) => bar.ts_open),
      };
      barOpensRef.current = next;
      return next;
    }

    function chartRows(): readonly ReturnType<typeof toCandlestick>[] {
      const cached = chartRowsRef.current;
      if (
        cached !== null &&
        cached.barsRevision === chartBarsRevisionRef.current
      )
        return cached.rows;
      const bars = allBarsRef.current;
      let rows: ReturnType<typeof toCandlestick>[];
      if (
        cached !== null &&
        cached.timesRevision === barTimesRevisionRef.current &&
        cached.rows.length > 0 &&
        bars.length > 0
      ) {
        rows = cached.rows.slice();
        rows[rows.length - 1] = toCandlestick(bars[bars.length - 1]);
      } else {
        rows = candleBars(bars).map(toCandlestick);
      }
      chartRowsRef.current = {
        barsRevision: chartBarsRevisionRef.current,
        timesRevision: barTimesRevisionRef.current,
        rows,
      };
      return rows;
    }

    function syncDrawingSeriesTimes(bars: readonly BarFrame[]) {
      if (!trendlinePrimitiveRef.current && !fibonacciPrimitiveRef.current)
        return;
      const seriesTimes = bars.map((bar) => bar.ts_open / 1000);
      trendlinePrimitiveRef.current?.setSeriesTimes(seriesTimes);
      fibonacciPrimitiveRef.current?.setSeriesTimes(seriesTimes);
    }

    function recomputeRuntimeIndicatorSeries() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      for (const [id, entries] of runtimeIndicatorSeriesRef.current) {
        const showIndicator = enabled.has(id) && visible.has(id);
        const output = showIndicator
          ? indicatorRuntimeRef.current.getOutput(id)
          : null;
        const colors = showIndicator
          ? indicatorRuntimeRef.current.getLineColors(id)
          : null;
        for (const entry of entries) {
          if (!output) {
            entry.series.setData([]);
            continue;
          }
          const values = output[entry.lineKey] ?? [];
          const lineColors = colors?.[entry.lineKey];
          entry.series.setData(
            lineColors
              ? toColoredLineData(allBarsRef.current, values, lineColors)
              : toLineData(allBarsRef.current, values),
          );
        }
      }
      flushDrawState();
    }

    function updateRuntimeIndicatorSeriesForBar(
      bar: BarFrame,
      mutation: ChartBarMutation,
      forceFullRender: boolean,
    ) {
      if (forceFullRender || mutation === "REBUILT") {
        recomputeRuntimeIndicatorSeries();
        return;
      }
      const bars = allBarsRef.current;
      const index = bars.length - 1;
      if (index < 0) {
        recomputeRuntimeIndicatorSeries();
        return;
      }
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      for (const [id, entries] of runtimeIndicatorSeriesRef.current) {
        const showIndicator = enabled.has(id) && visible.has(id);
        const output = showIndicator
          ? indicatorRuntimeRef.current.getOutput(id)
          : null;
        const colors = showIndicator
          ? indicatorRuntimeRef.current.getLineColors(id)
          : null;
        for (const entry of entries) {
          const values = output?.[entry.lineKey];
          const lineColors = colors?.[entry.lineKey];
          if (
            !values ||
            values.length !== bars.length ||
            (lineColors && lineColors.length !== bars.length)
          ) {
            entry.series.setData([]);
            continue;
          }
          const point = lineColors
            ? toColoredLineData([bar], [values[index]], [lineColors[index]])[0]
            : toLineData([bar], [values[index]])[0];
          entry.series.update(point);
        }
      }
      flushDrawState();
    }

    function tickOrderFlow(
      tick: ChartBarMutation | null,
      bars: readonly BarFrame[],
      showCandles: boolean,
    ): boolean {
      const cache = orderFlowCacheRef.current;
      const line = cvdLineSeriesRef.current;
      const histogram = cvdHistogramSeriesRef.current;
      const index = bars.length - 1;
      if (
        tick === null ||
        showCandles ||
        cache === null ||
        line === null ||
        histogram === null ||
        index < 1
      )
        return false;
      if (tick === "REPLACED_EDGE") {
        if (
          cache.timesRevision !== barTimesRevisionRef.current ||
          cache.delta.length !== bars.length
        )
          return false;
      } else if (
        tick !== "APPENDED" ||
        cache.delta.length !== bars.length - 1
      ) {
        return false;
      }
      const delta = cache.delta.slice(0, index);
      delta.push(barDelta(bars[index]));
      const threshold = histogramThreshold(delta);
      if (!Object.is(threshold, cache.threshold)) return false;
      const bar = bars[index];
      const cvd = cvdAfter(
        bars[index - 1],
        cache.cvd[index - 1],
        bar,
        delta[index],
      );
      const cvdValues = cache.cvd.slice(0, index);
      cvdValues.push(cvd);
      orderFlowCacheRef.current = {
        timesRevision: barTimesRevisionRef.current,
        delta,
        cvd: cvdValues,
        threshold,
      };
      const time = (bar.ts_open / 1000) as UTCTimestamp;
      line.update(cvd === null ? { time } : { time, value: cvd });
      histogram.update(
        histogramPoint(
          bar,
          delta[index],
          threshold,
          INDICATOR_PALETTE.cvdUp,
          INDICATOR_PALETTE.cvdDown,
        ),
      );
      return true;
    }

    function recomputeIndicators(
      includeRuntimeIndicators = true,
      tick: ChartBarMutation | null = null,
    ) {
      applySessionProfileVisibility();
      applySessionDeltaProfileVisibility();
      applyVolumeDeltaProfileOhlcVisibility();
      applyVolumeDeltaProfileTickVisibility();
      applyVpinCloudVisibility();
      applyLiquidityVisibility();
      if (includeRuntimeIndicators) recomputeRuntimeIndicatorSeries();
      const bars = allBarsRef.current;
      syncDrawingSeriesTimes(bars);
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      if (bars.length === 0) {
        cvdLineSeriesRef.current?.setData([]);
        cvdHistogramSeriesRef.current?.setData([]);
        killzonesPrimitiveRef.current?.setSessions([]);
        deltaDivergencePricePrimitiveRef.current?.setDivergences([]);
        deltaDivergenceCvdPrimitiveRef.current?.setDivergences([]);
        sessionDeltaProfilePrimitiveRef.current?.setProfile(null);
        // The renderer clears its own pane for an empty chart just as it would
        // for a hidden one.
        cvdDivergenceRendererRef.current?.render(
          [],
          cvdDivergenceSettingsRef.current,
          false,
          [],
        );
        return;
      }
      // killzonesIndicator's own timeframeGate is the one source of truth for
      // whether Killzones may render on the current chart interval -- this
      // resolves the same registered gate `setActive`/`onBar` dispatch already
      // uses, rather than re-deriving the threshold inline a second time.
      const runtimeIds = resolveRuntimeIndicatorIds(enabled, bars);

      if (cvdLineSeriesRef.current && cvdHistogramSeriesRef.current) {
        const showCandles = cvdDisplayModeRef.current === "candles";
        if (enabled.has("orderFlow") && visible.has("orderFlow")) {
          if (!tickOrderFlow(tick, bars, showCandles)) {
            const delta = computeDeltaPerBar(bars);
            const cvd = computeCVDForBars(bars, delta);
            cvdLineSeriesRef.current.setData(toLineData(bars, cvd));
            cvdHistogramSeriesRef.current.setData(
              toHistogramData(
                bars,
                delta,
                INDICATOR_PALETTE.cvdUp,
                INDICATOR_PALETTE.cvdDown,
              ),
            );
            cvdCandleSeriesRef.current?.setData(
              showCandles && bars.length > 0
                ? toCvdCandlestickData(
                    bars,
                    computeCvdCandles(
                      bars,
                      raw1mBarsRef.current,
                      bars[0].interval_ms,
                    ),
                  )
                : [],
            );
            orderFlowCacheRef.current = showCandles
              ? null
              : {
                  timesRevision: barTimesRevisionRef.current,
                  delta,
                  cvd,
                  threshold: histogramThreshold(delta),
                };
          }
        } else {
          cvdLineSeriesRef.current.setData([]);
          cvdHistogramSeriesRef.current.setData([]);
          cvdCandleSeriesRef.current?.setData([]);
          orderFlowCacheRef.current = null;
        }
        cvdLineSeriesRef.current.applyOptions({ visible: !showCandles });
        cvdCandleSeriesRef.current?.applyOptions({ visible: showCandles });
      }
      if (killzonesPrimitiveRef.current) {
        if (
          enabled.has("killzones") &&
          visible.has("killzones") &&
          runtimeIds.has("killzones")
        ) {
          const sessionInputs: KillzoneSessionInput[] =
            KILLZONE_SESSIONS.filter((session) =>
              visibleKillzoneSessionsRef.current.has(session.id),
            ).map((session) => ({
              session,
              occurrences: buildKillzoneOccurrences(
                bars,
                session,
                KILLZONE_MAX_OCCURRENCES,
                killzoneNyPartsCacheRef.current,
              ),
            }));
          killzonesPrimitiveRef.current.setSessions(sessionInputs);
        } else {
          killzonesPrimitiveRef.current.setSessions([]);
        }
      }
      if (
        deltaDivergencePricePrimitiveRef.current ||
        deltaDivergenceCvdPrimitiveRef.current
      ) {
        if (enabled.has("deltaDivergence") && visible.has("deltaDivergence")) {
          const delta = computeDeltaPerBar(bars);
          const cvd = computeCVDForBars(bars, delta);
          const divergences = detectDivergences(
            bars,
            delta,
            cvd,
            deltaDivergenceSwingLengthRef.current,
          );
          deltaDivergencePricePrimitiveRef.current?.setDivergences(divergences);
          deltaDivergenceCvdPrimitiveRef.current?.setDivergences(divergences);
        } else {
          deltaDivergencePricePrimitiveRef.current?.setDivergences([]);
          deltaDivergenceCvdPrimitiveRef.current?.setDivergences([]);
        }
      }
      // Everything CVD Divergence draws -- the oscillator pane, both label
      // primitives, both segment primitives, the borrowed cumulative CVD and
      // both trend averages -- is owned by its renderer. The panel only
      // answers "is it shown" and hands over the bars.
      cvdDivergenceRendererRef.current?.render(
        bars,
        cvdDivergenceSettingsRef.current,
        enabled.has("cvdDivergence") && visible.has("cvdDivergence"),
        raw1mBarsRef.current,
      );
    }

    function updateCandleCloseTimer(bar: BarFrame | null, nowMs: number) {
      candleCloseTimerPrimitiveRef.current?.setState(
        barToCandleCloseTimerState(bar, nowMs),
      );
    }

    function resolveRuntimeIndicatorIds(
      enabled: ReadonlySet<IndicatorId>,
      bars: readonly BarFrame[],
    ): Set<IndicatorId> {
      const intervalMs = bars[0]?.interval_ms;
      const resolved = new Set(
        [...enabled].filter((id) => {
          const def = RUNTIME_DEFS_BY_ID.get(id);
          return (
            def !== undefined &&
            (intervalMs === undefined ||
              def.timeframeGate === undefined ||
              def.timeframeGate(intervalMs))
          );
        }),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of resolved) {
          const def = RUNTIME_DEFS_BY_ID.get(id);
          if (
            def?.placement.kind === "sharedPane" &&
            !resolved.has(def.placement.withIndicatorId as IndicatorId)
          ) {
            resolved.delete(id);
            changed = true;
          }
        }
      }
      return resolved;
    }

    function syncRuntimeIndicatorSeries(runtimeIds: ReadonlySet<IndicatorId>) {
      const chart = chartRef.current;
      if (!chart) return;

      for (const [id, entries] of runtimeIndicatorSeriesRef.current) {
        if (runtimeIds.has(id)) continue;
        for (const entry of entries) {
          const paneIndex = entry.series.getPane().paneIndex();
          const kernel = drawKernelPrimitivesRef.current.get(paneIndex);
          if (
            kernel &&
            drawKernelHostsRef.current.get(paneIndex) === entry.series
          ) {
            // A primitive/marker controller belongs to a concrete series. Move
            // it off this host before removing the series; the next owner in
            // the pane will receive it during syncDrawKernelsToPanes().
            entry.series.detachPrimitive(kernel);
            drawKernelHostsRef.current.delete(paneIndex);
            markerSeriesControllersRef.current.get(paneIndex)?.detach();
          }
          chart.removeSeries(entry.series);
        }
        runtimeIndicatorSeriesRef.current.delete(id);
        runtimePriceLinesRef.current.delete(id);
      }

      const pending = new Set(
        [...runtimeIds].filter(
          (id) => !runtimeIndicatorSeriesRef.current.has(id),
        ),
      );
      while (pending.size > 0) {
        let created = false;
        for (const id of [...pending]) {
          const def = RUNTIME_DEFS_BY_ID.get(id);
          if (!def) {
            pending.delete(id);
            continue;
          }

          const placement = def.placement;
          const isOwnPane = placement.kind === "ownPane";
          const sharedEntries =
            placement.kind === "sharedPane"
              ? runtimeIndicatorSeriesRef.current.get(
                  placement.withIndicatorId as IndicatorId,
                )
              : undefined;
          if (placement.kind === "sharedPane" && !sharedEntries?.[0]) continue;
          const paneIndex = isOwnPane
            ? chart.panes().length
            : (sharedEntries?.[0].series.getPane().paneIndex() ?? 0);
          const autoscaleRange = isOwnPane
            ? placement.autoscaleRange
            : undefined;
          const entries = def.lines.map((line) => {
            return {
              series: chart.addSeries(
                LineSeries,
                {
                  color: INDICATOR_PALETTE.refLine,
                  lineWidth: (line.lineWidth ??
                    INDICATOR_LINE_WIDTH) as LineWidth,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  ...(autoscaleRange
                    ? {
                        autoscaleInfoProvider: () => ({
                          priceRange: {
                            minValue: autoscaleRange.min,
                            maxValue: autoscaleRange.max,
                          },
                        }),
                      }
                    : {}),
                },
                paneIndex,
              ),
              lineKey: line.key,
            };
          });

          const priceLines = isOwnPane ? placement.priceLines : undefined;
          if (priceLines && entries[0]) {
            runtimePriceLinesRef.current.set(
              id,
              priceLines.map((level) =>
                entries[0].series.createPriceLine({
                  price: level,
                  color: INDICATOR_PALETTE.refLine,
                  lineWidth: 1,
                  lineStyle: LineStyle.Dotted,
                  axisLabelVisible: true,
                }),
              ),
            );
          }
          runtimeIndicatorSeriesRef.current.set(id, entries);
          pending.delete(id);
          created = true;
        }
        if (!created) break;
      }

      syncDrawKernelsToPanes();
    }

    /**
     * One DrawKernelPrimitive/MarkerSeriesController per pane, not a global
     * singleton -- an own-pane indicator (e.g. RSI) must never have its drawn
     * objects rendered on the main series. Re-derives each pane's current
     * owner-id list from runtimeIndicatorSeriesRef after every activation
     * change, creating a pane's kernel/controller lazily on first use and
     * dropping it once no active indicator is placed on that pane anymore.
     */
    function syncDrawKernelsToPanes() {
      const ownersByPane = new Map<number, IndicatorId[]>();
      for (const [id, entries] of runtimeIndicatorSeriesRef.current) {
        const series = entries[0]?.series;
        const def = RUNTIME_DEFS_BY_ID.get(id);
        if (!series && def?.placement.kind !== "overlay") continue;
        const paneIndex = series?.getPane().paneIndex() ?? 0;
        const owners = ownersByPane.get(paneIndex) ?? [];
        owners.push(id);
        ownersByPane.set(paneIndex, owners);
      }
      ownersByPaneRef.current = ownersByPane;

      for (const [paneIndex, owners] of ownersByPane) {
        // Pane 0's drawn objects are hosted on the price candles, never on an
        // overlay indicator's own line series: `series.priceToCoordinate`
        // returns null while a series holds no data (SeriesApi checks
        // `firstValue()`), so hosting them on an overlay would blank EVERY
        // drawn object on the pane the moment that one indicator was hidden --
        // hiding empties its series -- labels another indicator had drawn
        // included. The candles always hold data while the chart does.
        const series =
          (paneIndex === 0 ? seriesRef.current : null) ??
          runtimeIndicatorSeriesRef.current.get(owners[0])?.[0]?.series ??
          null;
        if (!series) continue;

        let kernel = drawKernelPrimitivesRef.current.get(paneIndex);
        const priorHost = drawKernelHostsRef.current.get(paneIndex);
        if (!kernel) {
          kernel = new DrawKernelPrimitive();
          kernel.setBarTimesRevision(() => barTimesRevisionRef.current);
          kernel.setDarkChart(colorSchemeRef.current === "dark");
          if (paneIndex === 0) kernel.setRightInset(mainPaneInset);
          drawKernelPrimitivesRef.current.set(paneIndex, kernel);
        }
        if (priorHost !== series) {
          if (priorHost) priorHost.detachPrimitive(kernel);
          series.attachPrimitive(kernel);
          drawKernelHostsRef.current.set(paneIndex, series);
        }

        let controller = markerSeriesControllersRef.current.get(paneIndex);
        if (!controller) {
          controller = new MarkerSeriesController((markerSeries) =>
            createSeriesMarkers(markerSeries as ISeriesApi<"Line">),
          );
          markerSeriesControllersRef.current.set(paneIndex, controller);
        }
        if (priorHost !== series) {
          controller.detach();
          controller.attach(series);
        }
      }

      for (const paneIndex of [...drawKernelPrimitivesRef.current.keys()]) {
        if (ownersByPane.has(paneIndex)) continue;
        const kernel = drawKernelPrimitivesRef.current.get(paneIndex);
        const host = drawKernelHostsRef.current.get(paneIndex);
        if (kernel && host) host.detachPrimitive(kernel);
        drawKernelPrimitivesRef.current.delete(paneIndex);
        markerSeriesControllersRef.current.get(paneIndex)?.detach();
        markerSeriesControllersRef.current.delete(paneIndex);
        drawKernelHostsRef.current.delete(paneIndex);
      }

      flushDrawState();
    }

    /**
     * Content, not topology: which of each pane's owners are currently shown
     * (an activated-but-hidden indicator's drawn objects must disappear the
     * same way its line series' data already does), plus each shown owner's
     * fill points and markers -- called once per bar-transition and once on
     * every visibility/settings recompute, never once per draw call inside an
     * indicator's own onBar.
     */
    function flushDrawState() {
      const enabled = enabledIndicatorsRef.current;
      const visible = visibleIndicatorsRef.current;
      const nextTables: {
        key: string;
        position: TablePosition;
        committedGrid: Record<string, TableCell>;
      }[] = [];

      for (const [paneIndex, owners] of ownersByPaneRef.current) {
        const kernel = drawKernelPrimitivesRef.current.get(paneIndex);
        const controller = markerSeriesControllersRef.current.get(paneIndex);
        const shownOwners = owners.filter(
          (id) => enabled.has(id) && visible.has(id),
        );
        const drawOwnerIds = shownOwners
          .map((id) => indicatorRuntimeRef.current.getDrawOwnerId(id))
          .filter((ownerId): ownerId is string => ownerId !== null);
        kernel?.setOwnerIds(drawOwnerIds);

        const markers: MarkerCall[] = [];
        for (const id of shownOwners) {
          const drawOwnerId = indicatorRuntimeRef.current.getDrawOwnerId(id);
          if (!drawOwnerId) continue;
          // One entry per named band: an indicator may fill several regions at
          // once, and each keeps its own colour. The owner id prefixes the band
          // key because the kernel files fills by a single string, and
          // `setOwnerIds` above prunes by exact match -- so a hidden indicator's
          // fills are dropped here and simply never re-set.
          for (const fillKey of indicatorRuntimeRef.current.getFillKeys(id) ?? []) {
            const fill = indicatorRuntimeRef.current.getFillPoints(id, fillKey);
            if (!fill) continue;
            kernel?.setFillPoints(`${drawOwnerId}:${fillKey}`, fill.points, fill.options);
          }
          const ownMarkers = indicatorRuntimeRef.current.getMarkers(id);
          if (ownMarkers) markers.push(...ownMarkers);
          for (const record of handlesForOwners([drawOwnerId])) {
            if (record.kind === "table") {
              nextTables.push({
                key: `${drawOwnerId}:${record.handleId}`,
                position: (record.data as TableData).position,
                committedGrid: (record.data as TableData).committedGrid,
              });
            }
          }
        }
        controller?.setMarkers(markers);
      }

      setBottomTableRightPx((chartRef.current?.priceScale("right").width() ?? 0) + AXIS_INSET_GAP_PX);
      setTableOverlays((current) =>
        current.length === nextTables.length &&
        current.every(
          (entry, index) =>
            entry.key === nextTables[index].key &&
            entry.committedGrid === nextTables[index].committedGrid,
        )
          ? current
          : nextTables,
      );
    }

    function tableGridDimensions(grid: Record<string, TableCell>): {
      rows: number;
      cols: number;
    } {
      let maxRow = -1;
      let maxCol = -1;
      for (const key of Object.keys(grid)) {
        const [rowPart, colPart] = key.split(",");
        maxRow = Math.max(maxRow, Number(rowPart));
        maxCol = Math.max(maxCol, Number(colPart));
      }
      return { rows: maxRow + 1, cols: maxCol + 1 };
    }

    /**
     * Snapshot CVD Divergence's settings for the recompute pass.
     *
     * A single helper because BOTH the full activation path and the
     * settings-only early return in `setIndicators` must refresh it. They did
     * not, and the settings-only path is the common one, so a changed period,
     * trend filter or overlay toggle was silently ignored until the indicator
     * was toggled off and on again.
     */
    function captureCvdDivergenceSettings(
      settingsById: Readonly<Partial<Record<IndicatorId, unknown>>>,
    ): void {
      const cvdDivergenceSettings = settingsById.cvdDivergence;
      cvdDivergenceSettingsRef.current =
        cvdDivergenceSettings !== null &&
        typeof cvdDivergenceSettings === "object"
          ? {
              ...DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
              ...cvdDivergenceSettings,
            }
          : DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS;
    }

    function applyIndicatorSet(
      ids: IndicatorId[],
      settingsById: Readonly<Partial<Record<IndicatorId, unknown>>> = {},
    ) {
      requestedIndicatorsRef.current = new Set(ids);
      const capabilities = historicalIndicatorCapabilitiesRef.current;
      const enabledIds =
        capabilities === null
          ? [...requestedIndicatorsRef.current]
          : [...requestedIndicatorsRef.current].filter(
              (id) =>
                historicalIndicatorAvailability(
                  id,
                  capabilities,
                  historicalIndicatorProviderRef.current,
                ).available,
            );
      enabledIndicatorsRef.current = new Set(enabledIds);
      visibleIndicatorsRef.current = new Set(
        [...requestedVisibilityRef.current].filter((id) =>
          enabledIndicatorsRef.current.has(id),
        ),
      );
      runtimeSettingsByIdRef.current = settingsById;
      captureCvdDivergenceSettings(settingsById);
      const chart = chartRef.current;
      if (!chart) return;
      indicatorSetAppliedRef.current = true;
      const enabled = enabledIndicatorsRef.current;

      const runtimeIds = resolveRuntimeIndicatorIds(
        enabled,
        allBarsRef.current,
      );
      indicatorRuntimeRef.current.setActive(
        runtimeIds,
        settingsById,
        allBarsRef.current,
      );

      syncRuntimeIndicatorSeries(runtimeIds);

      if (enabled.has("orderFlow")) {
        if (!cvdLineSeriesRef.current) {
          const lineSeries = chart.addSeries(
            LineSeries,
            {
              color:
                colorSchemeRef.current === "dark"
                  ? DARK_CVD_LINE
                  : INDICATOR_PALETTE.cvdLine,
              lineWidth: INDICATOR_LINE_WIDTH,
              priceLineVisible: false,
              lastValueVisible: false,
            },
            chart.panes().length,
          );
          lineSeries.createPriceLine({
            price: 0,
            color:
              colorSchemeRef.current === "dark"
                ? DARK_CVD_ZERO_LINE
                : INDICATOR_PALETTE.cvdZeroLine,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
          });
          cvdLineSeriesRef.current = lineSeries;
        }
        if (!cvdHistogramSeriesRef.current) {
          const cvdPaneIndex = cvdLineSeriesRef.current.getPane().paneIndex();
          cvdHistogramSeriesRef.current = chart.addSeries(
            HistogramSeries,
            {
              color: INDICATOR_PALETTE.cvdUp,
              priceScaleId: CVD_HISTOGRAM_PRICE_SCALE_ID,
              priceLineVisible: false,
              lastValueVisible: false,
            },
            cvdPaneIndex,
          );
          chart
            .priceScale(CVD_HISTOGRAM_PRICE_SCALE_ID, cvdPaneIndex)
            .applyOptions({
              scaleMargins: { top: 0.7, bottom: 0 },
            });
        }
        if (!cvdCandleSeriesRef.current) {
          cvdCandleSeriesRef.current = chart.addSeries(
            CandlestickSeries,
            {
              upColor: INDICATOR_PALETTE.cvdUp,
              downColor: INDICATOR_PALETTE.cvdDown,
              borderUpColor: INDICATOR_PALETTE.cvdUp,
              borderDownColor: INDICATOR_PALETTE.cvdDown,
              wickUpColor: INDICATOR_PALETTE.cvdUp,
              wickDownColor: INDICATOR_PALETTE.cvdDown,
              priceLineVisible: false,
              lastValueVisible: false,
              visible: cvdDisplayModeRef.current === "candles",
            },
            cvdLineSeriesRef.current.getPane().paneIndex(),
          );
        }
        if (!deltaDivergenceCvdPrimitiveRef.current) {
          const cvdDivergencePrimitive = new DeltaDivergencePrimitive("cvd");
          cvdLineSeriesRef.current.attachPrimitive(cvdDivergencePrimitive);
          deltaDivergenceCvdPrimitiveRef.current = cvdDivergencePrimitive;
        }
      } else {
        if (cvdLineSeriesRef.current) {
          if (deltaDivergenceCvdPrimitiveRef.current) {
            cvdLineSeriesRef.current.detachPrimitive(
              deltaDivergenceCvdPrimitiveRef.current,
            );
            deltaDivergenceCvdPrimitiveRef.current = null;
          }
          chart.removeSeries(cvdLineSeriesRef.current);
          cvdLineSeriesRef.current = null;
        }
        if (cvdCandleSeriesRef.current) {
          chart.removeSeries(cvdCandleSeriesRef.current);
          cvdCandleSeriesRef.current = null;
        }
        if (cvdHistogramSeriesRef.current) {
          chart.removeSeries(cvdHistogramSeriesRef.current);
          cvdHistogramSeriesRef.current = null;
        }
      }

      // CVD Divergence's own pane, its segments, its price-pane labels and the
      // borrowed cumulative CVD are all owned by one renderer object, which
      // builds them on first attach and releases every one of them on detach.
      if (enabled.has("cvdDivergence")) {
        cvdDivergenceRendererRef.current?.attach(
          cvdDivergenceSettingsRef.current,
        );
      } else {
        cvdDivergenceRendererRef.current?.detach();
      }

      recomputeIndicators();
    }

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const palette = colorScheme === "dark" ? DARK_CHART_PALETTE : CHART_PALETTE;

      const chart = createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: palette.bg },
          textColor: palette.text,
          fontFamily: cssVar("--sans-display"),
          attributionLogo: false,
          panes: {
            separatorColor: palette.candleStroke,
            separatorHoverColor: "rgba(17, 17, 17, 0.15)",
          },
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        rightPriceScale: { borderColor: palette.border, borderVisible: false },
        timeScale: {
          borderColor: palette.border,
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: { mode: CrosshairMode.Normal },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: { time: true, price: true },
          axisDoubleClickReset: { time: true, price: true },
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
      });

      const series = chart.addSeries(CandlestickSeries, {
        upColor: palette.candleUp,
        downColor: palette.candleDown,
        borderUpColor:
          colorScheme === "dark" ? palette.candleUp : palette.candleStroke,
        borderDownColor:
          colorScheme === "dark" ? palette.candleDown : palette.candleStroke,
        wickUpColor:
          colorScheme === "dark" ? palette.candleUp : palette.candleStroke,
        wickDownColor:
          colorScheme === "dark" ? palette.candleDown : palette.candleStroke,
        lastValueVisible: false,
      });

      chartRef.current = chart;
      seriesRef.current = series;

      // CVD Divergence's renderer is bound to THIS chart for the chart's whole
      // life. It creates nothing up front: `attach` builds its pane and
      // overlays lazily, when and only when the indicator is switched on, so
      // the pane is still created in the same place in the pane order as it
      // always was. The cleanup below hands it back before the chart goes.
      cvdDivergenceRendererRef.current = new CvdDivergenceRenderer({
        chart,
        priceSeries: series,
        dark: colorScheme === "dark",
      });
      aggressiveProfilePaneRef.current = new AggressiveProfilePane({ chart, dark: colorScheme === "dark" });

      const whaleMarkersPrimitive = new WhaleMarkersPrimitive();
      series.attachPrimitive(whaleMarkersPrimitive);
      whaleMarkersPrimitiveRef.current = whaleMarkersPrimitive;

      const liquidityPrimitive = new LiquidityHeatmapPrimitive(chartRows);
      series.attachPrimitive(liquidityPrimitive);
      liquidityPrimitiveRef.current = liquidityPrimitive;
      liquidityPrimitive.setLanes(latestL2StoreRef.current?.lanes ?? null);
      liquidityPrimitive.setLaneChoice(liquidityLaneRef.current);
      liquidityPrimitive.onLaneDrawn = (lane) => onLiquidityLaneDrawnRef.current?.(lane);
      liquidityPrimitive.onHistoryDrawn = (info) => onLiquidityHistoryDrawnRef.current?.(info);
      liquidityPrimitive.setHistory(latestHeatmapHistoryRef.current);
      const l2SupportResistancePrimitive = new L2SupportResistancePrimitive();
      series.attachPrimitive(l2SupportResistancePrimitive);
      l2SupportResistancePrimitiveRef.current = l2SupportResistancePrimitive;
      const l2BookMapPrimitive = new L2BookMapPrimitive(
        () => allBarsRef.current.at(-1)?.interval_ms ?? 60_000,
        chartBarOpens,
      );
      series.attachPrimitive(l2BookMapPrimitive);
      l2BookMapPrimitiveRef.current = l2BookMapPrimitive;
      const whalePrimitive = new WhaleLimitHeatmapPrimitive(
        () => allBarsRef.current.at(-1)?.interval_ms ?? 60_000,
        chartBarOpens,
      );
      series.attachPrimitive(whalePrimitive);
      whalePrimitiveRef.current = whalePrimitive;
      whalePrimitive.setSettings(whaleSettingsRef.current);
      const aggressivePrimitive = new AggressiveOrdersPrimitive(
        {
          buy: palette.candleUp,
          sell: palette.candleDown,
          stroke: palette.candleStroke,
        },
        chartRows,
      );
      series.attachPrimitive(aggressivePrimitive);
      aggressivePrimitiveRef.current = aggressivePrimitive;
      const deltaPrimitive = new LiveDeltaProfilePrimitive(
        () => allBarsRef.current,
        chartRows,
      );
      series.attachPrimitive(deltaPrimitive);
      deltaPrimitiveRef.current = deltaPrimitive;
      const bookPrimitive = new LiveOrderBookProfilePrimitive(
        () => allBarsRef.current,
        chartRows,
      );
      series.attachPrimitive(bookPrimitive);
      bookPrimitiveRef.current = bookPrimitive;
      const aggressiveProfilePrimitive = new AggressiveProfilePrimitive(() => allBarsRef.current);
      if (latestAggressiveProfileSettingsRef.current !== null) aggressiveProfilePrimitive.setSettings(latestAggressiveProfileSettingsRef.current);
      aggressiveProfilePrimitive.onRead = (candles, range, settings) => aggressiveProfilePaneRef.current?.render(candles ?? [], allBarsRef.current, range, settings);
      series.attachPrimitive(aggressiveProfilePrimitive);
      aggressiveProfilePrimitiveRef.current = aggressiveProfilePrimitive;
      const absorptionPrimitive = new AbsorptionPrimitive(undefined, chartRows);
      series.attachPrimitive(absorptionPrimitive);
      absorptionPrimitiveRef.current = absorptionPrimitive;
      absorptionPrimitive.setHistory(absorptionHistoryRef.current);
      const exhaustionPrimitive = new ExhaustionPrimitive(chartRows);
      if (latestExhaustionSettingsRef.current !== null) exhaustionPrimitive.setSettings(latestExhaustionSettingsRef.current);
      exhaustionPrimitive.setUnit(latestExhaustionUnitRef.current);
      exhaustionPrimitive.setCandleMs(latestExhaustionCandleRef.current);
      series.attachPrimitive(exhaustionPrimitive);
      exhaustionPrimitiveRef.current = exhaustionPrimitive;
      const initiativePrimitive = new InitiativePrimitive(chartRows);
      if (latestInitiativeSettingsRef.current !== null) initiativePrimitive.setSettings(latestInitiativeSettingsRef.current);
      initiativePrimitive.setCandleMs(latestInitiativeCandleRef.current);
      series.attachPrimitive(initiativePrimitive);
      initiativePrimitiveRef.current = initiativePrimitive;
      const liveRangePrimitive = new LiveRangePrimitive(chartRows);
      liveRangePrimitive.setSettings(latestLiveRangeSettingsRef.current, latestLiveRangeUnitRef.current);
      liveRangePrimitive.setWindow(latestLiveRangeWindowRef.current);
      liveRangePrimitive.setHistory(liveRangeHistoryRef.current);
      liveRangePrimitive.onRead = (report) => setLiveRangeReport(report);
      series.attachPrimitive(liveRangePrimitive);
      liveRangePrimitiveRef.current = liveRangePrimitive;
      const icebergPrimitive = new IcebergPrimitive(chartRows);
      icebergPrimitive.setDarkChart(colorSchemeRef.current === "dark");
      icebergPrimitive.setUnit(latestIcebergUnitRef.current);
      icebergPrimitive.setRightInset(mainPaneInset);
      if (latestIcebergSettingsRef.current !== null)
        icebergPrimitive.setSettings(latestIcebergSettingsRef.current);
      series.attachPrimitive(icebergPrimitive);
      icebergPrimitiveRef.current = icebergPrimitive;
      applyLiquidityVisibility();

      const killzonesPrimitive = new KillzonesPrimitive();
      series.attachPrimitive(killzonesPrimitive);
      killzonesPrimitiveRef.current = killzonesPrimitive;

      const deltaDivergencePricePrimitive = new DeltaDivergencePrimitive(
        "price",
      );
      series.attachPrimitive(deltaDivergencePricePrimitive);
      deltaDivergencePricePrimitiveRef.current = deltaDivergencePricePrimitive;

      const volumeProfilePrimitive = new VolumeProfilePrimitive();
      series.attachPrimitive(volumeProfilePrimitive);
      volumeProfilePrimitiveRef.current = volumeProfilePrimitive;

      const netDeltaProfilePrimitive = new NetDeltaProfilePrimitive();
      series.attachPrimitive(netDeltaProfilePrimitive);
      netDeltaProfilePrimitiveRef.current = netDeltaProfilePrimitive;

      const deltaProfilePrimitive = new DeltaProfilePrimitive();
      series.attachPrimitive(deltaProfilePrimitive);
      deltaProfilePrimitiveRef.current = deltaProfilePrimitive;

      const sessionDeltaProfilePrimitive = new SessionDeltaProfilePrimitive();
      series.attachPrimitive(sessionDeltaProfilePrimitive);
      sessionDeltaProfilePrimitiveRef.current = sessionDeltaProfilePrimitive;

      const volumeDeltaProfileOhlcPrimitive =
        new VolumeDeltaProfileOhlcPrimitive();
      series.attachPrimitive(volumeDeltaProfileOhlcPrimitive);
      volumeDeltaProfileOhlcPrimitiveRef.current =
        volumeDeltaProfileOhlcPrimitive;

      const volumeDeltaProfileTickPrimitive =
        new VolumeDeltaProfileTickPrimitive();
      volumeDeltaProfileTickPrimitive.onTruncatedFromChange = (fromMs) =>
        onVolumeDeltaProfileTickTruncatedFromRef.current?.(fromMs);
      series.attachPrimitive(volumeDeltaProfileTickPrimitive);
      volumeDeltaProfileTickPrimitiveRef.current =
        volumeDeltaProfileTickPrimitive;

      const vpinCloudPrimitive = new VpinCloudPrimitive();
      series.attachPrimitive(vpinCloudPrimitive);
      vpinCloudPrimitiveRef.current = vpinCloudPrimitive;

      const candleCloseTimerPrimitive = new CandleCloseTimerPrimitive();
      series.attachPrimitive(candleCloseTimerPrimitive);
      candleCloseTimerPrimitiveRef.current = candleCloseTimerPrimitive;

      const historicalRollMarkerPrimitive = new RollMarkerPrimitive();
      series.attachPrimitive(historicalRollMarkerPrimitive);
      historicalRollMarkerPrimitiveRef.current = historicalRollMarkerPrimitive;

      const trendlinePrimitive = new TrendlinePrimitive();
      series.attachPrimitive(trendlinePrimitive);
      trendlinePrimitiveRef.current = trendlinePrimitive;

      const fibonacciPrimitive = new FibonacciPrimitive();
      series.attachPrimitive(fibonacciPrimitive);
      fibonacciPrimitiveRef.current = fibonacciPrimitive;

      allDrawingsRef.current = loadDrawings();

      const onResize = () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;
        chart.applyOptions({ width, height });
      };
      const observer = new ResizeObserver(onResize);
      observer.observe(container);

      const onDoubleClick = () => {
        if (activeDrawingToolRef.current !== null) return;
        if (lastBarRef.current) {
          chart
            .timeScale()
            .setVisibleRange(defaultVisibleRange(lastBarRef.current));
        }
      };
      container.addEventListener("dblclick", onDoubleClick);

      type ReachLine = { line: "edge" | "base"; profile: "book" | "delta" };
      let reachDrag: (ReachLine & { pointerId: number }) | null = null;
      let reachCursor = false;
      const panePoint = (event: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      const lineAt = (x: number, y: number): ReachLine | null => {
        const profiles = [
          { profile: "book" as const, primitive: bookPrimitiveRef.current },
          { profile: "delta" as const, primitive: deltaPrimitiveRef.current },
        ];
        for (const { profile, primitive } of profiles) {
          if (primitive?.handleAt(x, y)) return { line: "edge", profile };
          if (primitive?.baseHandleAt(x, y)) return { line: "base", profile };
        }
        return null;
      };
      const showHandles = (line: ReachLine | null) => {
        bookPrimitiveRef.current?.setHandleHover(line?.profile === "book" ? line.line : null);
        deltaPrimitiveRef.current?.setHandleHover(line?.profile === "delta" ? line.line : null);
      };
      const onReachPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || activeDrawingToolRef.current !== null) return;
        const { x, y } = panePoint(event);
        const line = lineAt(x, y);
        if (line === null) return;
        container.setPointerCapture(event.pointerId);
        reachDrag = { pointerId: event.pointerId, ...line };
        event.preventDefault();
        event.stopPropagation();
      };
      const onReachPointerMove = (event: PointerEvent) => {
        const { x, y } = panePoint(event);
        if (reachDrag !== null) {
          const primitive = reachDrag.profile === "book" ? bookPrimitiveRef.current : deltaPrimitiveRef.current;
          if (!primitive) return;
          if (reachDrag.line === "edge") {
            const share = primitive.reachShareAt(x);
            if (share === null) return;
            if (reachDrag.profile === "book") onLiveOrderBookReachChangeRef.current?.(share);
            else onLiveDeltaReachChangeRef.current?.(share);
          } else {
            primitive.resizeNeighbour(x);
          }
          return;
        }
        const hovered = lineAt(x, y);
        showHandles(hovered);
        const over = hovered !== null;
        if (over !== reachCursor) {
          reachCursor = over;
          container.style.cursor = over ? "ew-resize" : "";
        }
      };
      const onReachPointerUp = (event: PointerEvent) => {
        if (reachDrag === null || reachDrag.pointerId !== event.pointerId) return;
        reachDrag = null;
        if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
        showHandles(lineAt(panePoint(event).x, panePoint(event).y));
      };
      const onReachPointerLeave = () => {
        if (reachDrag === null) showHandles(null);
      };
      container.addEventListener("pointerdown", onReachPointerDown, true);
      container.addEventListener("pointermove", onReachPointerMove);
      container.addEventListener("pointerup", onReachPointerUp);
      container.addEventListener("pointercancel", onReachPointerUp);
      container.addEventListener("pointerleave", onReachPointerLeave);

      let rangeDrag: { pointerId: number; line: WindowLine; window: LiveRangeWindow } | null = null;
      const onRangePointerDown = (event: PointerEvent) => {
        if (event.defaultPrevented || event.button !== 0 || activeDrawingToolRef.current !== null) return;
        const primitive = liveRangePrimitiveRef.current;
        if (!primitive) return;
        const { x, y } = panePoint(event);
        const line = primitive.lineAt(x, y);
        if (line === null) return;
        container.setPointerCapture(event.pointerId);
        rangeDrag = { pointerId: event.pointerId, line, window: primitive.window };
        primitive.hoverLine(line);
        event.preventDefault();
        event.stopPropagation();
      };
      const onRangePointerMove = (event: PointerEvent) => {
        const primitive = liveRangePrimitiveRef.current;
        if (!primitive) return;
        const { x, y } = panePoint(event);
        if (rangeDrag === null) primitive.hoverLine(primitive.lineAt(x, y));
        else if (rangeDrag.pointerId === event.pointerId) primitive.dragTo(rangeDrag.line, x);
      };
      const onRangePointerUp = (event: PointerEvent) => {
        if (rangeDrag === null || rangeDrag.pointerId !== event.pointerId) return;
        const before = rangeDrag.window;
        rangeDrag = null;
        if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
        const primitive = liveRangePrimitiveRef.current;
        if (!primitive) return;
        const after = primitive.endDrag();
        if (after.fromMs !== before.fromMs || after.toMs !== before.toMs) onLiveRangeWindowChangeRef.current?.(after);
      };
      const onRangePointerLeave = () => {
        if (rangeDrag === null) liveRangePrimitiveRef.current?.hoverLine(null);
      };
      container.addEventListener("pointerdown", onRangePointerDown, true);
      container.addEventListener("pointermove", onRangePointerMove);
      container.addEventListener("pointerup", onRangePointerUp);
      container.addEventListener("pointercancel", onRangePointerUp);
      container.addEventListener("pointerleave", onRangePointerLeave);

      const isMainPane = (paneIndex: number | undefined) =>
        paneIndex === undefined || paneIndex === 0;

      function syncSelection(next: DrawingPlacementMode) {
        setSelectedDrawing(next.kind === "selected" ? next.id : null);
      }

      const onCrosshairMove: Parameters<
        typeof chart.subscribeCrosshairMove
      >[0] = (param) => {
        if (!param.point) {
          setWhaleTooltip(null);
          setAbsorptionTooltip(null);
          setIcebergTooltip(null);
          setExhaustionTooltip(null);
          exhaustionPrimitiveRef.current?.setHover(null);
          setInitiativeTooltip(null);
          initiativePrimitiveRef.current?.setHover(null);
          setBubbleTooltip(null);
          setL2BookMapTooltip(null);
          setWhaleHover(null);
          whalePrimitiveRef.current?.setHover(null);
          setPivotTooltip(null);
          setFvgTooltip(null);
          setSessionLevelTooltip(null);
          setPendingOnActiveTool(null);
          return;
        }
        const icebergCard = isMainPane(param.paneIndex)
          ? (icebergPrimitiveRef.current?.cardAt(param.point.x, param.point.y) ?? null)
          : null;
        const hovered = icebergCard
          ? null
          : (whaleMarkersPrimitiveRef.current?.hitTestCluster(
              param.point.x,
              param.point.y,
            ) ?? null);
        setWhaleTooltip(
          hovered
            ? { cluster: hovered, x: param.point.x, y: param.point.y }
            : null,
        );
        const zone =
          hovered || icebergCard
            ? null
            : (absorptionPrimitiveRef.current?.bubbleAt(
              param.point.x,
              param.point.y,
            ) ?? null);
        setAbsorptionTooltip(
          zone ? { hover: zone, x: param.point.x, y: param.point.y } : null,
        );
        const icebergMark =
          icebergCard ??
          (hovered || zone || !isMainPane(param.paneIndex)
            ? null
            : (icebergPrimitiveRef.current?.markAt(
                param.point.x,
                param.point.y,
              ) ?? null));
        setIcebergTooltip(
          icebergMark
            ? { hover: icebergMark, x: param.point.x, y: param.point.y }
            : null,
        );
        const exhaustionBox =
          hovered || zone || icebergMark || !isMainPane(param.paneIndex)
            ? null
            : (exhaustionPrimitiveRef.current?.boxAt(
                param.point.x,
                param.point.y,
              ) ?? null);
        exhaustionPrimitiveRef.current?.setHover(exhaustionBox?.id ?? null);
        setExhaustionTooltip(
          exhaustionBox
            ? { hover: exhaustionBox, x: param.point.x, y: param.point.y }
            : null,
        );
        const initiativeBox =
          hovered || zone || icebergMark || exhaustionBox || !isMainPane(param.paneIndex)
            ? null
            : (initiativePrimitiveRef.current?.boxAt(
                param.point.x,
                param.point.y,
              ) ?? null);
        initiativePrimitiveRef.current?.setHover(initiativeBox?.id ?? null);
        setInitiativeTooltip(
          initiativeBox
            ? { hover: initiativeBox, x: param.point.x, y: param.point.y }
            : null,
        );
        const bubble =
          hovered || zone || icebergMark || exhaustionBox || initiativeBox
            ? null
            : (aggressivePrimitiveRef.current?.bubbleAt(
                param.point.x,
                param.point.y,
              ) ?? null);
        setBubbleTooltip(
          bubble
            ? {
                words: describeBubble(
                  bubble,
                  sizeUnitFor(instrumentIdentityRef.current),
                ),
                x: param.point.x,
                y: param.point.y,
              }
            : null,
        );
        const wall =
          hovered || zone || bubble || icebergMark || exhaustionBox || initiativeBox
            ? null
            : (liquidityPrimitiveRef.current?.levelAt(
                param.point.x,
                param.point.y,
              ) ?? null);
        setWallTooltip(
          wall ? { wall, x: param.point.x, y: param.point.y } : null,
        );
        const bookMapCell =
          hovered || zone || bubble || wall || icebergMark || exhaustionBox || initiativeBox
            ? null
            : (l2BookMapPrimitiveRef.current?.cellAt(
                param.point.x,
                param.point.y,
              ) ?? null);
        setL2BookMapTooltip(
          bookMapCell
            ? { cell: bookMapCell, x: param.point.x, y: param.point.y }
            : null,
        );
        const whaleHit = icebergMark || exhaustionBox || initiativeBox ? null : (whalePrimitiveRef.current?.hitAt(param.point.x, param.point.y) ?? null);
        whalePrimitiveRef.current?.setHover(whaleHit);
        const pointX = param.point.x;
        const pointY = param.point.y;
        setWhaleHover((held) => {
          if (whaleHit === null) return null;
          if (held !== null && held.hit.wall === whaleHit.wall && Math.abs(held.x - pointX) < 3 && Math.abs(held.y - pointY) < 3) return held;
          return { hit: whaleHit, x: pointX, y: pointY };
        });

        let hoveredPivot: PivotTooltipState | null = null;
        const pivotVisible =
          enabledIndicatorsRef.current.has("pivotPoints") &&
          visibleIndicatorsRef.current.has("pivotPoints");
        const crosshairTimeMs =
          param.time === undefined ? null : Number(param.time) * 1000;
        const intervalMs = allBarsRef.current[0]?.interval_ms ?? 60_000;
        if (!icebergMark && !exhaustionBox && !initiativeBox && pivotVisible && crosshairTimeMs !== null && seriesRef.current) {
          const pivotMarkers =
            indicatorRuntimeRef.current.getMarkers("pivotPoints") ?? [];
          let nearestDistance = Number.POSITIVE_INFINITY;
          for (const marker of pivotMarkers) {
            if (marker.price === undefined) continue;
            if (Math.abs(marker.time - crosshairTimeMs) > intervalMs / 2)
              continue;
            const markerY = seriesRef.current.priceToCoordinate(marker.price);
            if (markerY === null) continue;
            const distance = Math.abs(markerY - param.point.y);
            if (distance > 18 || distance >= nearestDistance) continue;
            nearestDistance = distance;
            hoveredPivot = {
              kind: marker.shape === "arrowUp" ? "low" : "high",
              price: marker.price,
              x: param.point.x,
              y: markerY,
            };
          }
        }
        setPivotTooltip(hoveredPivot);

        let hoveredFvg: FVGTooltipState | null = null;
        const fvgVisible =
          enabledIndicatorsRef.current.has("fvgDelta") &&
          visibleIndicatorsRef.current.has("fvgDelta");
        const fvgSeries = seriesRef.current;
        if (!icebergMark && !exhaustionBox && !initiativeBox && fvgVisible && crosshairTimeMs !== null && fvgSeries) {
          const fvgEvents = fvgHoverDataFromUnknown(
            indicatorRuntimeRef.current.getHoverData("fvgDelta"),
          );
          const lastBarTime = lastBarRef.current?.ts_open ?? crosshairTimeMs;
          let nearestDistance = Number.POSITIVE_INFINITY;
          for (const event of fvgEvents) {
            const hit = hitFvgHover(event, {
              crosshairTimeMs,
              cursorY: param.point.y,
              intervalMs,
              lastBarTime,
              priceToCoordinate: (price) => fvgSeries.priceToCoordinate(price),
            });
            if (hit === null || hit.distance >= nearestDistance) continue;
            nearestDistance = hit.distance;
            hoveredFvg = {
              hover: event,
              x: param.point.x,
              y: hit.y,
            };
          }
        }
        setFvgTooltip(hoveredFvg);

        let hoveredLevel: SessionLevelTooltipState | null = null;
        const levelsVisible =
          enabledIndicatorsRef.current.has("sessionLevels") &&
          visibleIndicatorsRef.current.has("sessionLevels");
        const levelSeries = seriesRef.current;
        if (!icebergMark && !exhaustionBox && !initiativeBox && levelsVisible && crosshairTimeMs !== null && levelSeries) {
          const levelHovers = sessionLevelHoversFromUnknown(
            indicatorRuntimeRef.current.getHoverData("sessionLevels"),
          );
          let nearestDistance = Number.POSITIVE_INFINITY;
          for (const hover of levelHovers) {
            const hit = hitSessionLevelHover(hover, {
              crosshairTimeMs,
              cursorY: param.point.y,
              intervalMs,
              priceToCoordinate: (price) => levelSeries.priceToCoordinate(price),
            });
            if (hit === null || hit.distance >= nearestDistance) continue;
            nearestDistance = hit.distance;
            hoveredLevel = { hover, x: param.point.x, y: hit.y };
          }
        }
        setSessionLevelTooltip(hoveredLevel);

        const placement = drawingPlacementRef.current;
        const price =
          seriesRef.current?.coordinateToPrice(param.point.y) ?? null;
        if (
          placement.kind === "placing" &&
          placement.first !== null &&
          isMainPane(param.paneIndex) &&
          param.time !== undefined &&
          price !== null
        ) {
          setPendingOnActiveTool({
            first: placement.first,
            cursor: { time: Number(param.time), price },
          });
        } else {
          setPendingOnActiveTool(null);
        }
      };
      chart.subscribeCrosshairMove(onCrosshairMove);

      const onClick: Parameters<typeof chart.subscribeClick>[0] = (param) => {
        if (!isMainPane(param.paneIndex) || !param.point) return;
        const point = param.point;

        if (activeDrawingToolRef.current === null) {
          const exhaustionBox = exhaustionPrimitiveRef.current?.boxAt(point.x, point.y) ?? null;
          const cardOverBox =
            exhaustionBox !== null &&
            ((whaleMarkersPrimitiveRef.current?.hitTestCluster(point.x, point.y) ?? null) !== null ||
              (absorptionPrimitiveRef.current?.bubbleAt(point.x, point.y) ?? null) !== null ||
              (icebergPrimitiveRef.current?.cardAt(point.x, point.y) ?? null) !== null ||
              (icebergPrimitiveRef.current?.markAt(point.x, point.y) ?? null) !== null);
          const exhaustionHit = cardOverBox ? null : exhaustionBox;
          const initiativeBox = exhaustionHit !== null ? null : (initiativePrimitiveRef.current?.boxAt(point.x, point.y) ?? null);
          const cardOverBand =
            initiativeBox !== null &&
            ((whaleMarkersPrimitiveRef.current?.hitTestCluster(point.x, point.y) ?? null) !== null ||
              (absorptionPrimitiveRef.current?.bubbleAt(point.x, point.y) ?? null) !== null ||
              (icebergPrimitiveRef.current?.cardAt(point.x, point.y) ?? null) !== null ||
              (icebergPrimitiveRef.current?.markAt(point.x, point.y) ?? null) !== null);
          const initiativeHit = cardOverBand ? null : initiativeBox;
          const pinnedHit = exhaustionHit !== null || initiativeHit !== null ? null : (whalePrimitiveRef.current?.hitAt(point.x, point.y) ?? null);
          setWhalePinned(pinnedHit === null ? null : { hit: pinnedHit, x: point.x, y: point.y });
          setExhaustionPinned(exhaustionHit === null ? null : { id: exhaustionHit.id, x: point.x, y: point.y });
          setInitiativePinned(initiativeHit === null ? null : { id: initiativeHit.id, x: point.x, y: point.y });
          const hitId = pickNearestHit([
            trendlinePrimitiveRef.current?.hitTestDrawing(point.x, point.y) ??
              null,
            fibonacciPrimitiveRef.current?.hitTestDrawing(point.x, point.y) ??
              null,
          ]);
          const result = advanceDrawingPlacement(drawingPlacementRef.current, {
            type: "click",
            point: null,
            hitId,
          });
          drawingPlacementRef.current = result.next;
          syncSelection(result.next);
          return;
        }

        if (param.time === undefined) return;
        const price = seriesRef.current?.coordinateToPrice(point.y);
        if (price === null || price === undefined) return;
        const drawingPoint: DrawingPoint = { time: Number(param.time), price };
        const result = advanceDrawingPlacement(drawingPlacementRef.current, {
          type: "click",
          point: drawingPoint,
          hitId: null,
        });
        drawingPlacementRef.current = result.next;

        if (result.commit) {
          if (result.commit.tool === "fixedRangeProfile") {
            const rangeStartTs =
              Math.min(result.commit.first.time, result.commit.second.time) *
              1000;
            const rangeEndTs =
              Math.max(result.commit.first.time, result.commit.second.time) *
              1000;
            if (rangeEndTs > rangeStartTs) {
              onFixedRangeProfileRequestedRef.current?.(
                rangeStartTs,
                rangeEndTs,
              );
            }
            setPendingOnActiveTool(null);
          } else {
            const identity = instrumentIdentityRef.current;
            const drawing: DrawnObject = {
              id: createDrawingId(),
              type: result.commit.tool,
              points: [result.commit.first, result.commit.second],
              ...identity,
            };
            const { drawings: nextAll } = addDrawing(
              allDrawingsRef.current,
              drawing,
            );
            allDrawingsRef.current = nextAll;
            saveDrawings(nextAll);
            syncDrawingPrimitives(drawingsForInstrument(nextAll, identity));
            setPendingOnActiveTool(null);
          }
        }
      };
      chart.subscribeClick(onClick);

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setWhalePinned(null);
          setExhaustionPinned(null);
          setInitiativePinned(null);
          const result = advanceDrawingPlacement(drawingPlacementRef.current, {
            type: "escape",
          });
          drawingPlacementRef.current = result.next;
          syncSelection(result.next);
          setPendingOnActiveTool(null);
          return;
        }
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
          return;
        const result = advanceDrawingPlacement(drawingPlacementRef.current, {
          type: "deleteSelected",
        });
        drawingPlacementRef.current = result.next;
        if (result.removeId) {
          const nextAll = removeDrawing(
            allDrawingsRef.current,
            result.removeId,
          );
          allDrawingsRef.current = nextAll;
          saveDrawings(nextAll);
          syncDrawingPrimitives(
            drawingsForInstrument(nextAll, instrumentIdentityRef.current),
          );
        }
        syncSelection(result.next);
      };
      window.addEventListener("keydown", onKeyDown);

      return () => {
        observer.disconnect();
        container.removeEventListener("dblclick", onDoubleClick);
        container.removeEventListener("pointerdown", onReachPointerDown, true);
        container.removeEventListener("pointermove", onReachPointerMove);
        container.removeEventListener("pointerup", onReachPointerUp);
        container.removeEventListener("pointercancel", onReachPointerUp);
        container.removeEventListener("pointerleave", onReachPointerLeave);
        container.removeEventListener("pointerdown", onRangePointerDown, true);
        container.removeEventListener("pointermove", onRangePointerMove);
        container.removeEventListener("pointerup", onRangePointerUp);
        container.removeEventListener("pointercancel", onRangePointerUp);
        container.removeEventListener("pointerleave", onRangePointerLeave);
        if (reachCursor) container.style.cursor = "";
        chart.unsubscribeCrosshairMove(onCrosshairMove);
        chart.unsubscribeClick(onClick);
        window.removeEventListener("keydown", onKeyDown);
        series.detachPrimitive(whaleMarkersPrimitive);
        whaleMarkersPrimitiveRef.current = null;
        series.detachPrimitive(killzonesPrimitive);
        killzonesPrimitiveRef.current = null;
        series.detachPrimitive(deltaDivergencePricePrimitive);
        deltaDivergencePricePrimitiveRef.current = null;
        series.detachPrimitive(volumeProfilePrimitive);
        volumeProfilePrimitiveRef.current = null;
        series.detachPrimitive(netDeltaProfilePrimitive);
        netDeltaProfilePrimitiveRef.current = null;
        series.detachPrimitive(deltaProfilePrimitive);
        deltaProfilePrimitiveRef.current = null;
        series.detachPrimitive(sessionDeltaProfilePrimitive);
        sessionDeltaProfilePrimitiveRef.current = null;
        series.detachPrimitive(volumeDeltaProfileOhlcPrimitive);
        volumeDeltaProfileOhlcPrimitiveRef.current = null;
        series.detachPrimitive(volumeDeltaProfileTickPrimitive);
        volumeDeltaProfileTickPrimitiveRef.current = null;
        series.detachPrimitive(vpinCloudPrimitive);
        vpinCloudPrimitiveRef.current = null;
        series.detachPrimitive(candleCloseTimerPrimitive);
        candleCloseTimerPrimitiveRef.current = null;
        series.detachPrimitive(historicalRollMarkerPrimitive);
        historicalRollMarkerPrimitiveRef.current = null;
        series.detachPrimitive(trendlinePrimitive);
        trendlinePrimitiveRef.current = null;
        series.detachPrimitive(fibonacciPrimitive);
        fibonacciPrimitiveRef.current = null;
        for (const controller of markerSeriesControllersRef.current.values())
          controller.detach();
        for (const [paneIndex, kernel] of drawKernelPrimitivesRef.current) {
          drawKernelHostsRef.current.get(paneIndex)?.detachPrimitive(kernel);
        }
        series.detachPrimitive(liquidityPrimitive);
        liquidityPrimitiveRef.current = null;
        series.detachPrimitive(l2SupportResistancePrimitive);
        l2SupportResistancePrimitiveRef.current = null;
        series.detachPrimitive(l2BookMapPrimitive);
        l2BookMapPrimitiveRef.current = null;
        series.detachPrimitive(whalePrimitive);
        whalePrimitiveRef.current = null;
        series.detachPrimitive(aggressivePrimitive);
        aggressivePrimitiveRef.current = null;
        series.detachPrimitive(deltaPrimitive);
        deltaPrimitiveRef.current = null;
        series.detachPrimitive(bookPrimitive);
        bookPrimitiveRef.current = null;
        series.detachPrimitive(aggressiveProfilePrimitive);
        aggressiveProfilePrimitiveRef.current = null;
        series.detachPrimitive(absorptionPrimitive);
        absorptionPrimitiveRef.current = null;
        series.detachPrimitive(exhaustionPrimitive);
        exhaustionPrimitiveRef.current = null;
        series.detachPrimitive(initiativePrimitive);
        initiativePrimitiveRef.current = null;
        series.detachPrimitive(liveRangePrimitive);
        liveRangePrimitiveRef.current = null;
        series.detachPrimitive(icebergPrimitive);
        icebergPrimitiveRef.current = null;
        // CVD Divergence's whole pane -- its histogram, both segment
        // primitives, both label primitives and both trend averages -- is
        // released by its renderer, and the renderer must run BEFORE the chart
        // it was built against is disposed. Clearing this one ref is then the
        // only bookkeeping left; the bug class this refactor removed was
        // forgetting one of the nine lines that used to be here.
        cvdDivergenceRendererRef.current?.detach();
        cvdDivergenceRendererRef.current = null;
        aggressiveProfilePaneRef.current?.detach();
        aggressiveProfilePaneRef.current = null;
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
        runtimeIndicatorSeriesRef.current = new Map();
        runtimePriceLinesRef.current = new Map();
        drawKernelPrimitivesRef.current = new Map();
        markerSeriesControllersRef.current = new Map();
        drawKernelHostsRef.current = new Map();
        ownersByPaneRef.current = new Map();
        setTableOverlays([]);
        indicatorSetAppliedRef.current = false;
        cvdLineSeriesRef.current = null;
        cvdHistogramSeriesRef.current = null;
        cvdCandleSeriesRef.current = null;
        deltaDivergenceCvdPrimitiveRef.current = null;
      };
    }, [colorScheme]);

    useEffect(() => {
      const runtime = indicatorRuntimeRef.current;
      return () => runtime.setActive(new Set(), {}, []);
    }, []);

    useEffect(() => {
      instrumentIdentityRef.current = instrumentIdentity;
      const result = advanceDrawingPlacement(drawingPlacementRef.current, {
        type: "setTool",
        tool: activeDrawingToolRef.current,
      });
      drawingPlacementRef.current = result.next;
      setSelectedDrawing(null);
      setPendingOnActiveTool(null);
      syncDrawingPrimitives(
        drawingsForInstrument(allDrawingsRef.current, instrumentIdentity),
      );
    }, [instrumentIdentity]);

    useEffect(() => {
      const timer = window.setInterval(() => {
        const bar = lastBarRef.current;
        if (bar && !bar.closed) updateCandleCloseTimer(bar, Date.now());
      }, 1000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      const timer = window.setInterval(() => {
        vpinCloudPrimitiveRef.current?.setMotionNow(Date.now());
      }, VPIN_CLOUD_MOTION_INTERVAL_MS);
      return () => window.clearInterval(timer);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        applySnapshot: (
          bars: readonly BarFrame[],
          options: Readonly<{ viewport?: "default" | "all"; visibleRange?: Readonly<{ fromMs: number; toMs: number }> }> = {},
        ) => {
          const hadBars = allBarsRef.current.length > 0;
          const visibleRange = hadBars
            ? (chartRef.current?.timeScale().getVisibleRange() ?? null)
            : null;
          killzoneNyPartsCacheRef.current.clear();
          if (!hadBars)
            seriesRef.current?.priceScale().applyOptions({ autoScale: true });
          const previousFirst = allBarsRef.current[0];
          const nextFirst = bars[0];
          if (
            nextFirst === undefined ||
            previousFirst === undefined ||
            previousFirst.symbol !== nextFirst.symbol ||
            previousFirst.provider !== nextFirst.provider ||
            previousFirst.interval_ms !== nextFirst.interval_ms
          ) {
            clearTooltips();
            aggressiveProfileSourceRef.current = null;
            aggressiveProfilePrimitiveRef.current?.setSource(null);
          }
          seriesRef.current?.setData(toCandlestickSeries(bars));
          allBarsRef.current = [...bars];
          candleDeltaSourceRef.current?.setBars(allBarsRef.current);
          chartBarsRevisionRef.current += 1;
          barTimesRevisionRef.current += 1;
          const runtimeIds = resolveRuntimeIndicatorIds(
            enabledIndicatorsRef.current,
            allBarsRef.current,
          );
          indicatorRuntimeRef.current.setActiveAndReplay(
            runtimeIds,
            runtimeSettingsByIdRef.current,
            allBarsRef.current,
          );
          syncRuntimeIndicatorSeries(runtimeIds);
          recomputeIndicators();
          if (bars.length === 0) {
            lastBarRef.current = null;
            updateCandleCloseTimer(null, Date.now());
            return;
          }
          lastBarRef.current = bars[bars.length - 1];
          updateCandleCloseTimer(lastBarRef.current, Date.now());
          const preserved = preserveVisibleRange(
            visibleRange === null
              ? null
              : {
                  from: Number(visibleRange.from),
                  to: Number(visibleRange.to),
                },
            bars,
          );
          chartRef.current?.timeScale().setVisibleRange(
            options.visibleRange !== undefined && Number.isSafeInteger(options.visibleRange.fromMs)
              && Number.isSafeInteger(options.visibleRange.toMs) && options.visibleRange.toMs > options.visibleRange.fromMs
              && options.visibleRange.fromMs >= bars[0].ts_open && options.visibleRange.toMs <= barCloseMs(bars[bars.length - 1])
              ? { from: (options.visibleRange.fromMs / 1000) as UTCTimestamp, to: (options.visibleRange.toMs / 1000) as UTCTimestamp }
              : options.viewport === "all"
              ? {
                  from: (bars[0].ts_open / 1000) as UTCTimestamp,
                  to: (barCloseMs(bars[bars.length - 1]) /
                    1000) as UTCTimestamp,
                }
              : (preserved ?? defaultVisibleRange(bars[bars.length - 1])),
          );
          const shown = chartRef.current?.timeScale().getVisibleRange();
          if (shown && Number(shown.to) * 1000 >= bars[bars.length - 1].ts_open) {
            deltaPrimitiveRef.current?.restoreRoom();
            bookPrimitiveRef.current?.restoreRoom();
            whalePrimitiveRef.current?.restoreRoom();
          }
        },
        setHistoricalRollMarkers: (
          markers: readonly HistoricalRollMarker[],
        ) => {
          historicalRollMarkerPrimitiveRef.current?.setMarkers(markers);
        },
        applyRawBars: (bars: BarFrame[]) => {
          raw1mBarsRef.current = bars;
        },
        applyBar: (
          bar: BarFrame,
          trades: readonly TradeFrame[] = [],
          tradeAvailability: TradeAvailability = "HISTORICAL_UNAVAILABLE",
        ) => {
          const bars = allBarsRef.current;
          const lastBar = bars[bars.length - 1];
          const contiguous = appendedBarIsContiguous(lastBar, bar);
          const mutation = mergeChartBar(bars, bar);
          if (mutation === "REJECTED_REOPEN") return;
          chartBarsRevisionRef.current += 1;
          if (mutation !== "REPLACED_EDGE") barTimesRevisionRef.current += 1;
          let removedCount = 0;
          if (bars.length > MAX_CHART_BARS) {
            const removed = bars.splice(0, bars.length - MAX_CHART_BARS);
            barTimesRevisionRef.current += 1;
            for (const removedBar of removed)
              killzoneNyPartsCacheRef.current.delete(removedBar.ts_open);
            removedCount = removed.length;
          }
          indicatorRuntimeRef.current.onBar(
            bar,
            mutation,
            bars,
            trades,
            tradeAvailability,
          );
          if (removedCount > 0 && mutation === "APPENDED") {
            indicatorRuntimeRef.current.discardLeading(
              removedCount,
              bars[0]?.ts_open,
            );
          }
          if (removedCount > 0) {
            seriesRef.current?.setData(toCandlestickSeries(bars));
          } else if (mutation === "APPENDED") {
            if (contiguous) seriesRef.current?.update(toCandlestick(bar));
            else seriesRef.current?.setData(toCandlestickSeries(bars));
          } else if (mutation === "REPLACED_EDGE") {
            seriesRef.current?.update(toCandlestick(bar));
          } else {
            seriesRef.current?.setData(toCandlestickSeries(bars));
          }
          const runtimeRequiresFullRender =
            removedCount > 0 ||
            mutation === "REBUILT" ||
            (mutation === "APPENDED" && !contiguous);
          updateRuntimeIndicatorSeriesForBar(
            bar,
            mutation,
            runtimeRequiresFullRender,
          );
          recomputeIndicators(
            false,
            runtimeRequiresFullRender ? null : mutation,
          );
          lastBarRef.current = bars[bars.length - 1] ?? null;
          updateCandleCloseTimer(lastBarRef.current, Date.now());
        },
        setIndicators: (
          ids: IndicatorId[],
          settingsById: Readonly<Partial<Record<IndicatorId, unknown>>> = {},
        ) => {
          const requested = requestedIndicatorsRef.current;
          if (
            indicatorSetAppliedRef.current &&
            ids.length === requested.size &&
            ids.every((id) => requested.has(id))
          ) {
            const previousSettings = runtimeSettingsByIdRef.current;
            runtimeSettingsByIdRef.current = settingsById;
            // The CVD Divergence snapshot MUST be refreshed here too. This
            // early-return path is the common one -- the settings object
            // changes far more often than the set of enabled indicators --
            // and leaving the snapshot stale meant a changed period, filter or
            // overlay state was silently ignored until the indicator itself
            // was toggled off and on again.
            captureCvdDivergenceSettings(settingsById);
            let changed = false;
            for (const id of ids) {
              const previous = previousSettings[id];
              const next = settingsById[id];
              if (JSON.stringify(previous) === JSON.stringify(next)) continue;
              changed = true;
              const runtimeDef = RUNTIME_DEFS_BY_ID.get(id);
              if (runtimeDef) {
                indicatorRuntimeRef.current.updateSettings(
                  id,
                  next ?? runtimeDef.defaultSettings,
                  allBarsRef.current,
                );
              }
            }
            if (changed) recomputeIndicators();
            return;
          }
          applyIndicatorSet(ids, settingsById);
        },
        applyHistoricalL2: (source, liquidity = null, grid = null, tape = null) => {
          const previous = historicalL2Ref.current;
          historicalL2Ref.current = source ?? historicalL2();
          historicalLiquidityRef.current = source === null ? null : liquidity;
          historicalGridRef.current = source === null ? null : grid;
          historicalTapeRef.current = source === null ? null : tape;
          historicalBookSourceRef.current = grid === null ? null : new BookProfileSource(grid);
          if (historicalIndicatorCapabilitiesRef.current === null) return;
          indicatorRuntimeRef.current.setLiquidity(historicalLiquidityRef.current,
            source === previous ? allBarsRef.current : []);
          indicatorRuntimeRef.current.setL2(historicalL2Ref.current, allBarsRef.current);
          applyLiquidityVisibility();
          recomputeIndicators();
        },
        setHistoricalIndicatorCapabilities: (capabilities, provider = null) => {
          historicalIndicatorCapabilitiesRef.current =
            capabilities === null ? null : new Set(capabilities);
          historicalIndicatorProviderRef.current =
            capabilities === null ? null : provider;
          if (capabilities !== null) cvdDisplayModeRef.current = "line";
          indicatorRuntimeRef.current.setLiquidity(capabilities !== null
            ? historicalLiquidityRef.current
            : indicatorLiquidityOf(latestLiquidityRef.current, runtimeColumnHistoryRef.current, heatmapClusterRows));
          indicatorRuntimeRef.current.setL2(
            capabilities !== null ? historicalL2Ref.current : liveL2Ref.current,
          );
          applyIndicatorSet(
            [...requestedIndicatorsRef.current],
            runtimeSettingsByIdRef.current,
          );
        },
        setIndicatorVisibility: (visibleIds: IndicatorId[]) => {
          const requested = new Set(visibleIds);
          const visible = new Set(
            [...requested].filter((id) => enabledIndicatorsRef.current.has(id)),
          );
          const unchanged =
            indicatorSetAppliedRef.current &&
            requested.size === requestedVisibilityRef.current.size &&
            [...requested].every((id) =>
              requestedVisibilityRef.current.has(id),
            ) &&
            visible.size === visibleIndicatorsRef.current.size &&
            [...visible].every((id) => visibleIndicatorsRef.current.has(id));
          requestedVisibilityRef.current = requested;
          visibleIndicatorsRef.current = visible;
          if (unchanged) return;
          recomputeIndicators();
        },
        setIndicatorSettings: (id: IndicatorId, settings: unknown) => {
          const nextSettings =
            id === "orderFlow" &&
            historicalIndicatorCapabilitiesRef.current !== null &&
            settings !== null &&
            typeof settings === "object"
              ? { ...settings, displayMode: "line" }
              : settings;
          if (id === "cvdDivergence") {
            cvdDivergenceSettingsRef.current = {
              ...DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
              ...(settings !== null && typeof settings === "object"
                ? settings
                : {}),
            };
          }
          runtimeSettingsByIdRef.current = {
            ...runtimeSettingsByIdRef.current,
            [id]: nextSettings,
          };
          indicatorRuntimeRef.current.updateSettings(
            id,
            nextSettings,
            allBarsRef.current,
          );
          recomputeIndicators();
        },
        applyLiquidity: (grid: LiquidityGrid | null) => {
          const changed = grid !== latestLiquidityRef.current;
          if (changed) setL2BookMapTooltip(null);
          latestLiquidityRef.current = grid;
          if (changed) {
            indicatorRuntimeRef.current.setLiquidity(
              historicalIndicatorCapabilitiesRef.current !== null ? historicalLiquidityRef.current
                : indicatorLiquidityOf(grid, runtimeColumnHistoryRef.current, heatmapClusterRows),
              allBarsRef.current,
            );
            recomputeIndicators();
            return;
          }
          applyLiquidityVisibility();
        },
        applyL2: (store: L2Store | null, history: L2HistoryRequester | null = null) => {
          if (store === latestL2StoreRef.current && history === latestL2HistoryRef.current) return;
          latestL2StoreRef.current = store;
          latestL2HistoryRef.current = history;
          rebuildLiveL2();
        },
        applyHostWalls: (stream: WallHistoryStream | null) => {
          if (stream === latestHostWallsRef.current) return;
          latestHostWallsRef.current = stream;
          rebuildLiveL2();
        },
        applyWhaleWalls: (stream: WallHistoryStream | null) => {
          if (stream === latestWhaleWallsRef.current) return;
          latestWhaleWallsRef.current = stream;
          applyLiquidityVisibility();
        },
        applyColumnHistory: (stream: ColumnHistoryStream | null) => {
          if (stream === latestColumnHistoryRef.current) return;
          latestColumnHistoryRef.current = stream;
          absorptionHistoryRef.current?.dispose();
          absorptionHistoryRef.current = stream === null ? null : new AbsorptionHistory(stream, new AbsorptionHistoryStore());
          absorptionPrimitiveRef.current?.setHistory(historicalIndicatorCapabilitiesRef.current === null ? absorptionHistoryRef.current : null);
          runtimeColumnHistoryRef.current = stream === null ? null : stream.fork();
          liveRangeHistoryRef.current?.dispose();
          liveRangeHistoryRef.current = stream === null ? null : new LiveRangeHistory(forkForLiveRange(stream), () => liveRangePrimitiveRef.current?.readNow());
          liveRangePrimitiveRef.current?.setHistory(liveRangeHistoryRef.current);
          indicatorRuntimeRef.current.setLiquidity(
            historicalIndicatorCapabilitiesRef.current !== null ? historicalLiquidityRef.current
              : indicatorLiquidityOf(latestLiquidityRef.current, runtimeColumnHistoryRef.current, heatmapClusterRows),
            allBarsRef.current,
          );
          recomputeIndicators();
        },
        applyHeatmapHistory: (history: HeatmapHistory | null) => {
          if (history === latestHeatmapHistoryRef.current) return;
          heatmapHistoryUnsubscribeRef.current?.();
          heatmapHistoryUnsubscribeRef.current = null;
          latestHeatmapHistoryRef.current = history;
          liquidityPrimitiveRef.current?.setHistory(historicalIndicatorCapabilitiesRef.current === null ? history : null);
          if (history !== null) heatmapHistoryUnsubscribeRef.current = history.subscribe(() => liquidityPrimitiveRef.current?.refresh());
        },
        refreshL2: () => {
          if (historicalIndicatorCapabilitiesRef.current !== null) return;
          indicatorRuntimeRef.current.onL2Advanced(allBarsRef.current);
          l2SupportResistancePrimitiveRef.current?.refresh();
          l2BookMapPrimitiveRef.current?.refresh();
          whalePrimitiveRef.current?.refresh();
          if ((liquidityPrimitiveRef.current?.layout?.lane ?? 0) > 0) liquidityPrimitiveRef.current?.refresh();
        },
        applyBandHistory: (store: BandHistoryStore | null) => {
          indicatorRuntimeRef.current.setBandHistory(store, allBarsRef.current);
          recomputeIndicators();
        },
        bandHistoryWants: () => indicatorRuntimeRef.current.bandHistoryWants(),
        refreshLiquidity: () => {
          indicatorRuntimeRef.current.onLiquidityAdvanced(allBarsRef.current);
          liquidityPrimitiveRef.current?.refresh();
          l2SupportResistancePrimitiveRef.current?.refresh();
          l2BookMapPrimitiveRef.current?.refresh();
          absorptionPrimitiveRef.current?.refresh();
        },
        setLiquiditySettings: (settings: LiquiditySettings) => {
          latestLiquiditySettingsRef.current = settings;
          liquidityPrimitiveRef.current?.setSettings(settings);
          applyLiquidityVisibility();
        },
        setLiquidityLane: (choice: LiquidityLaneChoice) => {
          liquidityLaneRef.current = choice;
          liquidityPrimitiveRef.current?.setLaneChoice(choice);
        },
        setL2SupportResistanceSettings: (
          settings: L2SupportResistanceSettings,
        ) => {
          l2SupportResistancePrimitiveRef.current?.setSettings(settings);
        },
        setL2BookMapSettings: (settings: L2BookMapSettings) => {
          l2BookMapPrimitiveRef.current?.setSettings(settings);
          refreshAxisInset();
        },
        setWhaleHeatmapSettings: (settings: WhaleHeatmapSettings) => {
          whaleSettingsRef.current = settings;
          whalePrimitiveRef.current?.setSettings(settings);
        },
        setAggressiveSettings: (settings: AggressiveOrdersSettings) => {
          aggressivePrimitiveRef.current?.setSettings(settings);
        },
        setAggressiveRules: (rules: ClusterRules | null) => {
          aggressivePrimitiveRef.current?.setRules(rules);
        },
        applyAggressiveTape: (tape: AggressiveTape | null) => {
          latestAggressiveTapeRef.current = tape;
          applyLiquidityVisibility();
        },
        applyTicks: (tape: AggressiveTape | null) => {
          // Handed over once per store, which is what backfills the bars drawn
          // before it existed: only the indicators that declare `ticksWanted`
          // are replayed. Live prints need no hook -- the store is read through
          // live, so the next bar already sees them. History is different: the
          // server's prints land after the store was handed over, for bars that
          // are already drawn, so a history change replays those indicators
          // again, once the reply has settled.
          if (tape === ticksTapeRef.current) return;
          ticksUnsubscribeRef.current?.();
          ticksUnsubscribeRef.current = null;
          if (ticksRefreshTimerRef.current !== null) clearTimeout(ticksRefreshTimerRef.current);
          ticksRefreshTimerRef.current = null;
          ticksTapeRef.current = tape;
          indicatorRuntimeRef.current.setTicks(
            indicatorTicksOf(tape),
            allBarsRef.current,
          );
          recomputeIndicators();
          if (tape === null) return;
          let seen = tape.historyVersion;
          ticksUnsubscribeRef.current = tape.subscribe(() => {
            if (tape.historyVersion === seen || ticksRefreshTimerRef.current !== null) return;
            ticksRefreshTimerRef.current = setTimeout(() => {
              ticksRefreshTimerRef.current = null;
              if (ticksTapeRef.current !== tape) return;
              seen = tape.historyVersion;
              indicatorRuntimeRef.current.refreshTicks(allBarsRef.current);
              recomputeIndicators();
            }, TICKS_HISTORY_SETTLE_MS);
          });
        },
        applyDeltaProfile: (store: DeltaProfileStore | null) => {
          latestDeltaProfileRef.current = store;
          applyLiquidityVisibility();
        },
        applyDeltaTickProfile: (store: DeltaProfileStore | null) => {
          latestDeltaTickProfileRef.current = store;
          applyVolumeDeltaProfileTickVisibility();
        },
        setLiveDeltaSettings: (settings: LiveDeltaProfileSettings) => {
          deltaPrimitiveRef.current?.setSettings(settings);
          applyLiquidityVisibility();
        },
        applyOrderBookProfile: (source: BookProfileSource | null) => {
          latestBookSourceRef.current = source;
          applyLiquidityVisibility();
        },
        setLiveOrderBookSettings: (settings: LiveOrderBookProfileSettings) => {
          bookPrimitiveRef.current?.setSettings(settings);
        },
        applyAggressiveProfile: (grid: LiquidityGrid | null) => {
          if (latestAggressiveProfileGridRef.current !== grid) aggressiveProfileSourceRef.current = null;
          latestAggressiveProfileGridRef.current = grid;
          applyLiquidityVisibility();
        },
        applyAggressiveProfilePrints: (store: RangePrintStore | null) => {
          if (latestAggressiveProfilePrintsRef.current === store) return;
          aggressiveProfilePrintsUnsubscribeRef.current?.();
          aggressiveProfilePrintsUnsubscribeRef.current = null;
          latestAggressiveProfilePrintsRef.current = store;
          if (store !== null) {
            const recorded = store.subscribe(() => aggressiveProfilePrimitiveRef.current?.repaint());
            const live = store.subscribeLive((print) => {
              if (print.size >= (latestAggressiveProfileSettingsRef.current?.floor ?? 0)) aggressiveProfilePaneRef.current?.pushLive(print);
            });
            aggressiveProfilePrintsUnsubscribeRef.current = () => {
              recorded();
              live();
            };
          }
          aggressiveProfilePrimitiveRef.current?.repaint();
        },
        setAggressiveProfileSettings: (settings: AggressiveProfileSettings) => {
          latestAggressiveProfileSettingsRef.current = settings;
          aggressiveProfilePrimitiveRef.current?.setSettings(settings);
        },
        setAbsorptionSettings: (settings: AbsorptionSettings) => {
          absorptionPrimitiveRef.current?.setSettings(settings);
        },
        setAbsorptionRules: (rules: AbsorptionRules | null) => {
          absorptionPrimitiveRef.current?.setRules(rules);
        },
        applyExhaustions: (book: ExhaustionBook | null) => {
          latestExhaustionBookRef.current = book;
          setExhaustionBookState((previous) => ({ book, revision: previous.revision + 1 }));
          applyLiquidityVisibility();
        },
        applyCandleMonitor: (monitor: CandleMonitorArrival | null) => {
          setCandleMonitorState(monitor);
        },
        refreshExhaustions: () => {
          exhaustionPrimitiveRef.current?.refresh();
          setExhaustionBookState((previous) => ({ book: latestExhaustionBookRef.current, revision: previous.revision + 1 }));
        },
        setExhaustionSettings: (settings: ExhaustionSettings, unit: string) => {
          latestExhaustionSettingsRef.current = settings;
          latestExhaustionUnitRef.current = unit;
          exhaustionPrimitiveRef.current?.setSettings(settings);
          exhaustionPrimitiveRef.current?.setUnit(unit);
          setExhaustionSettingsState(settings);
          setExhaustionUnit(unit);
        },
        setExhaustionCandle: (candleMs: number | null) => {
          latestExhaustionCandleRef.current = candleMs;
          exhaustionPrimitiveRef.current?.setCandleMs(candleMs);
          setExhaustionCandleMsState(candleMs);
        },
        applyInitiatives: (book: InitiativeBook | null) => {
          latestInitiativeBookRef.current = book;
          setInitiativeBookState((previous) => ({ book, revision: previous.revision + 1 }));
          applyLiquidityVisibility();
        },
        refreshInitiatives: () => {
          initiativePrimitiveRef.current?.refresh();
          setInitiativeBookState((previous) => ({ book: latestInitiativeBookRef.current, revision: previous.revision + 1 }));
        },
        setInitiativeSettings: (settings: InitiativeSettings) => {
          latestInitiativeSettingsRef.current = settings;
          initiativePrimitiveRef.current?.setSettings(settings);
          setInitiativeSettingsState(settings);
        },
        setInitiativeCandle: (candleMs: number | null) => {
          latestInitiativeCandleRef.current = candleMs;
          initiativePrimitiveRef.current?.setCandleMs(candleMs);
          setInitiativeCandleMsState(candleMs);
        },
        applyLiveRange: (grid: LiquidityGrid | null) => {
          latestLiveRangeGridRef.current = grid;
          applyLiquidityVisibility();
        },
        setLiveRangeSettings: (settings: LiveRangeSettings, unit = "") => {
          latestLiveRangeSettingsRef.current = settings;
          latestLiveRangeUnitRef.current = unit;
          liveRangePrimitiveRef.current?.setSettings(settings, unit);
          setLiveRangeSettingsState(settings);
        },
        setLiveRangeWindow: (window: LiveRangeWindow) => {
          latestLiveRangeWindowRef.current = window;
          liveRangePrimitiveRef.current?.setWindow(window);
        },
        applyIcebergs: (book: IcebergBook | null) => {
          latestIcebergBookRef.current = book;
          applyLiquidityVisibility();
        },
        refreshIcebergs: () => {
          icebergPrimitiveRef.current?.refresh();
        },
        setIcebergSettings: (settings: IcebergSettings, unit: string) => {
          latestIcebergSettingsRef.current = settings;
          latestIcebergUnitRef.current = unit;
          icebergPrimitiveRef.current?.setUnit(unit);
          icebergPrimitiveRef.current?.setSettings(settings);
        },
        setKillzoneSessions: (sessionIds: KillzoneId[]) => {
          visibleKillzoneSessionsRef.current = new Set(sessionIds);
          recomputeIndicators();
        },
        setOrderFlowDisplayMode: (mode: OrderFlowDisplayMode) => {
          cvdDisplayModeRef.current = mode;
          recomputeIndicators();
        },
        applyMarkerSnapshot: (
          stats: WhaleTradeStat[],
          intervalMs: number,
          clusterMode: WhaleClusterMode,
          minDeltaShare = 0,
        ) => {
          whaleMarkersPrimitiveRef.current?.setStats(
            stats,
            intervalMs,
            clusterMode,
            minDeltaShare,
          );
          setWhaleTooltip((prev) => {
            if (!prev) return null;
            const clusters =
              whaleMarkersPrimitiveRef.current?.getClusters() ?? [];
            const stillPresent = findClusterByIdentity(
              clusters,
              prev.cluster.ts,
              prev.cluster.side,
            );
            return stillPresent ? { ...prev, cluster: stillPresent } : null;
          });
        },
        setDivergenceSettings: (swingLength: number) => {
          deltaDivergenceSwingLengthRef.current = swingLength;
          recomputeIndicators();
        },
        setActiveDrawingTool: (tool: DrawingToolId | null) => {
          activeDrawingToolRef.current = tool;
          const result = advanceDrawingPlacement(drawingPlacementRef.current, {
            type: "setTool",
            tool,
          });
          drawingPlacementRef.current = result.next;
          setSelectedDrawing(null);
          setPendingOnActiveTool(null);
        },
        applyProfileFrame: (frame: ProfileFrame | null) => {
          latestProfileFrameRef.current = frame;
          applySessionProfileVisibility();
        },
        applyHistoricalProfiles: (profiles: ProfileFrame[]) => {
          latestHistoricalProfilesRef.current = profiles;
          applySessionProfileVisibility();
        },
        applyVpinReadings: (readings: VpinReading[]) => {
          latestVpinReadingsRef.current = readings;
          applyVpinCloudVisibility();
        },
        applyBarFlow: (flow: readonly BarSideFlow[]) => {
          const bars = allBarsRef.current;
          if (bars.length === 0) return;
          const byOpen = new Map(flow.map((entry) => [entry.ts_open, entry]));
          let changed = false;
          for (let index = 0; index < bars.length; index += 1) {
            const entry = byOpen.get(bars[index].ts_open);
            const carried =
              bars[index].buy_volume !== undefined ||
              bars[index].sell_volume !== undefined;
            if (entry === undefined) {
              if (!carried) continue;
              const {
                buy_volume: _buy,
                sell_volume: _sell,
                ...rest
              } = bars[index];
              bars[index] = rest;
              changed = true;
              continue;
            }
            if (
              bars[index].buy_volume === entry.buy_volume &&
              bars[index].sell_volume === entry.sell_volume
            )
              continue;
            bars[index] = {
              ...bars[index],
              buy_volume: entry.buy_volume,
              sell_volume: entry.sell_volume,
            };
            changed = true;
          }
          if (!changed) return;
          candleDeltaSourceRef.current?.setBars(bars);
          indicatorRuntimeRef.current.onSnapshot(bars);
          recomputeIndicators();
        },
        setSessionProfileSettings: (
          settings: SessionProfileIndicatorSettings,
        ) => {
          // The view lives on this same settings object, and which primitive
          // the frame goes to is not a change the indicator runtime sees, so
          // record it here and move the frame now.
          runtimeSettingsByIdRef.current = {
            ...runtimeSettingsByIdRef.current,
            [SESSION_PROFILE_INDICATOR_ID]: settings,
          };
          volumeProfilePrimitiveRef.current?.setSettings(
            sessionProfileVolumeSettings(settings),
          );
          netDeltaProfilePrimitiveRef.current?.setSettings(
            sessionProfileNetDeltaSettings(settings),
          );
          deltaProfilePrimitiveRef.current?.setSettings(
            sessionProfileDeltaSettings(settings),
          );
          applySessionProfileVisibility();
        },
        setSessionDeltaProfileSettings: (
          settings: SessionDeltaProfileSettings,
        ) => {
          sessionDeltaProfilePrimitiveRef.current?.setSettings(settings);
        },
        setVpinCloudSettings: (settings: VpinCloudSettings) => {
          vpinCloudPrimitiveRef.current?.setSettings(settings);
        },
        getVisibleRangeMs: () => {
          const range = chartRef.current?.timeScale().getVisibleRange();
          return range
            ? {
                fromMs: (range.from as number) * 1000,
                toMs: (range.to as number) * 1000,
              }
            : null;
        },
        subscribeVisibleRangeChange: (
          callback: (fromMs: number, toMs: number) => void,
        ) => {
          const chart = chartRef.current;
          if (!chart) return () => {};
          const timeScale = chart.timeScale();
          const handler = (range: { from: Time; to: Time } | null) => {
            if (!range) return;
            callback(
              (range.from as number) * 1000,
              (range.to as number) * 1000,
            );
          };
          timeScale.subscribeVisibleTimeRangeChange(handler);
          const initial = timeScale.getVisibleRange();
          if (initial) handler(initial);
          return () => {
            timeScale.unsubscribeVisibleTimeRangeChange(handler);
          };
        },
        subscribeVisibleLogicalRangeChange: (
          callback: (barsBefore: number, barsAfter: number) => void,
        ) => {
          const chart = chartRef.current;
          const series = seriesRef.current;
          if (!chart || !series) return () => {};
          const timeScale = chart.timeScale();
          const handler = (range: { from: number; to: number } | null) => {
            if (!range) return;
            const info = series.barsInLogicalRange(range);
            if (!info) return;
            callback(info.barsBefore, info.barsAfter);
          };
          timeScale.subscribeVisibleLogicalRangeChange(handler);
          const initial = timeScale.getVisibleLogicalRange();
          if (initial) handler(initial);
          return () => {
            timeScale.unsubscribeVisibleLogicalRangeChange(handler);
          };
        },
      }),
      [],
    );

    const whaleTooltipDeltaShare =
      whaleTooltip && whaleTooltip.cluster.netted
        ? deltaShareForCluster(whaleTooltip.cluster)
        : null;
    const whaleTooltipParticipationRate = whaleTooltip
      ? computeParticipationRateForSize(
          displaySizeForCluster(whaleTooltip.cluster),
          raw1mBarsRef.current,
          latestTradeTsForCluster(whaleTooltip.cluster),
        )
      : null;
    const pinnedExhaustion = useMemo(() => {
      const { book } = exhaustionBookState;
      if (exhaustionPinned === null || book === null) return null;
      const settings = exhaustionSettingsState ?? DEFAULT_EXHAUSTION_SETTINGS;
      const shade = shownShades(book.list(), settings, exhaustionCandleMsState, Date.now()).find((candidate) => candidate.id === exhaustionPinned.id);
      return shade === undefined ? null : describeExhaustion(shade, exhaustionCalibrated(settings), exhaustionUnit);
    }, [exhaustionPinned, exhaustionBookState, exhaustionSettingsState, exhaustionCandleMsState, exhaustionUnit]);
    const pinnedInitiative = useMemo(() => {
      const { book } = initiativeBookState;
      if (initiativePinned === null || book === null) return null;
      const settings = initiativeSettingsState ?? DEFAULT_INITIATIVE_SETTINGS;
      const band = shownBands(book.list(), settings, initiativeCandleMsState, Date.now()).find((candidate) => candidate.id === initiativePinned.id);
      return band === undefined ? null : describeInitiative(band);
    }, [initiativePinned, initiativeBookState, initiativeSettingsState, initiativeCandleMsState]);
    const formatSeriesPrice = (price: number) => seriesRef.current?.priceFormatter().format(price) ?? price.toFixed(2);
    const shown = shownTooltips({
      whale: whaleTooltip !== null,
      absorption: absorptionTooltip !== null,
      iceberg: icebergTooltip !== null,
      exhaustion: exhaustionTooltip !== null && exhaustionPinned === null,
      initiative: initiativeTooltip !== null && initiativePinned === null,
      bubble: bubbleTooltip !== null,
      wall: wallTooltip !== null,
      bookMap: l2BookMapTooltip !== null,
      whaleHeatmap: whaleHover !== null && whalePinned === null,
      pivot: pivotTooltip !== null,
      fvg: fvgTooltip !== null,
      sessionLevel: sessionLevelTooltip !== null,
    });

    return (
      <div className="chart-mount-wrap">
        <div ref={containerRef} className="chart-mount" />
        <div className="chart-attribution">
          <ChartPrimeLogo />
        </div>
        {shown.wall && wallTooltip && (
          <div
            className={`whale-tooltip ${wallTooltip.wall.side === "bid" ? "buy" : "sell"}`}
            style={{ left: wallTooltip.x, top: wallTooltip.y }}
          >
            <div className="whale-tooltip-side">
              {wallTooltip.wall.side === "bid" ? "Bid" : "Ask"} liquidity ·{" "}
              {BAND_STATE_LABEL[wallTooltip.wall.state]}
              {wallTooltip.wall.fill !== null &&
                wallTooltip.wall.fill > 0 &&
                ` · ${Math.round(wallTooltip.wall.fill * 100)}% eaten`}
            </div>
            {wallTooltip.wall.label !== "" && (
              <div className="whale-tooltip-notional tabular">
                {wallTooltip.wall.label}
                {wallTooltip.wall.peakLabel !== "" && (
                  <span className="whale-tooltip-multiple">
                    {" "}
                    · peak {wallTooltip.wall.peakLabel}
                  </span>
                )}
              </div>
            )}
            {wallTooltip.wall.detail !== "" && (
              <div className="whale-tooltip-participation tabular">
                {wallTooltip.wall.detail}
              </div>
            )}
            <div className="whale-tooltip-participation tabular">
              age {formatWallAge(wallTooltip.wall.ageMs)}
              {wallTooltip.wall.lane > 0 && ` · rows x${2 ** wallTooltip.wall.lane}`}
            </div>
          </div>
        )}
        {shown.bookMap && l2BookMapTooltip && (
          <div
            className={`whale-tooltip ${l2BookMapTooltip.cell.side === "bid" ? "buy" : "sell"}`}
            style={{ left: l2BookMapTooltip.x, top: l2BookMapTooltip.y }}
          >
            <div className="whale-tooltip-side">
              {l2BookMapTooltip.cell.side === "bid" ? "Bid" : "Ask"} liquidity
              box
            </div>
            <div className="whale-tooltip-notional tabular">
              Depth-time proxy{" "}
              {l2BookMapTooltip.cell.volume.toLocaleString("en-US", {
                maximumFractionDigits: 4,
              })}
              {` ${latestLiquidityRef.current?.baseAsset || "units"}·s`}
            </div>
          </div>
        )}
        {shown.whaleHeatmap && whaleHover && whalePrimitiveRef.current && (
          <WhaleWallCard
            card={whalePrimitiveRef.current.card(whaleHover.hit, false)}
            x={clampCardX(whaleHover.x, containerRef.current?.clientWidth ?? 0)}
            y={whaleHover.y}
            pinned={false}
          />
        )}
        {whalePinned && whalePrimitiveRef.current && (
          <WhaleWallCard
            card={whalePrimitiveRef.current.card(whalePinned.hit, true)}
            x={clampCardX(whalePinned.x, containerRef.current?.clientWidth ?? 0)}
            y={whalePinned.y}
            pinned
          />
        )}
        {shown.bubble && bubbleTooltip && (
          <div
            className={`whale-tooltip ${bubbleTooltip.words.side}`}
            style={{ left: bubbleTooltip.x, top: bubbleTooltip.y }}
          >
            <div className="whale-tooltip-side">
              {bubbleTooltip.words.title}
            </div>
            {bubbleTooltip.words.size !== "" && (
              <div className="whale-tooltip-notional tabular">
                {bubbleTooltip.words.size}
              </div>
            )}
            <div className="whale-tooltip-participation tabular">
              {bubbleTooltip.words.detail}
            </div>
          </div>
        )}
        {shown.absorption && absorptionTooltip && (
          <div
            className="whale-tooltip absorption"
            style={{ left: absorptionTooltip.x, top: absorptionTooltip.y }}
          >
            {/* One thing, the trader's ask: who got absorbed. The rest of the words stay in the hover model for later. */}
            <div className="whale-tooltip-notional">
              {absorptionTooltip.hover.title}
            </div>
          </div>
        )}
        {shown.exhaustion && exhaustionTooltip && (
          <div
            className={`whale-tooltip exhaustion ${exhaustionTooltip.hover.side === "buyers" ? "sell" : "buy"}`}
            style={{ left: exhaustionTooltip.x, top: exhaustionTooltip.y }}
          >
            <div className="whale-tooltip-side">{exhaustionTooltip.hover.short}</div>
          </div>
        )}
        {exhaustionPinned && pinnedExhaustion && (
          <ExhaustionCard hover={pinnedExhaustion} x={clampCardX(exhaustionPinned.x, containerRef.current?.clientWidth ?? 0)} y={exhaustionPinned.y} />
        )}
        {shown.initiative && initiativeTooltip && (
          <div
            className={`whale-tooltip initiative ${initiativeTooltip.hover.pushers === "buyers" ? "buy" : "sell"}`}
            style={{ left: initiativeTooltip.x, top: initiativeTooltip.y }}
          >
            <div className="whale-tooltip-side">{initiativeTooltip.hover.short}</div>
          </div>
        )}
        {initiativePinned && pinnedInitiative && (
          <InitiativeCard hover={pinnedInitiative} x={clampCardX(initiativePinned.x, containerRef.current?.clientWidth ?? 0)} y={initiativePinned.y} />
        )}
        {shown.iceberg && icebergTooltip && (
          <div
            className={`whale-tooltip iceberg ${icebergTooltip.hover.side}`}
            style={{ left: icebergTooltip.x, top: icebergTooltip.y }}
          >
            <div className="whale-tooltip-side">{icebergTooltip.hover.title}</div>
            <div className="whale-tooltip-notional tabular">
              {icebergTooltip.hover.headline}
            </div>
            <div className="whale-tooltip-participation tabular">
              {icebergTooltip.hover.detailLine}
            </div>
            <div className="whale-tooltip-participation tabular">
              {icebergTooltip.hover.whenLine}
            </div>
          </div>
        )}
        {shown.whale && whaleTooltip && (
          <div
            className={`whale-tooltip ${whaleTooltip.cluster.side}`}
            style={{ left: whaleTooltip.x, top: whaleTooltip.y }}
          >
            <div className="whale-tooltip-side">
              {whaleTooltip.cluster.count === 1
                ? whaleTooltip.cluster.side === "buy"
                  ? "Buy"
                  : "Sell"
                : `${whaleTooltip.cluster.netted ? "Net " : ""}${whaleTooltip.cluster.side === "buy" ? "Buy" : "Sell"} · ${whaleTooltip.cluster.count} trades`}
            </div>
            <div className="whale-tooltip-notional tabular">
              {whaleTooltip.cluster.stats[0].marker.provider === "DXFEED" &&
              whaleTooltip.cluster.stats[0].marker.assetClass === "FUTURE"
                ? `${displaySizeForCluster(whaleTooltip.cluster).toFixed(0)} ct`
                : formatUsd(whaleTooltip.cluster.magnitude)}
              {whaleTooltipDeltaShare !== null && (
                <span className="whale-tooltip-multiple">
                  {" "}
                  · {(whaleTooltipDeltaShare * 100).toFixed(0)}% net
                </span>
              )}
            </div>
            {whaleTooltipParticipationRate !== null && (
              <div className="whale-tooltip-participation tabular">
                {(whaleTooltipParticipationRate * 100).toFixed(1)}% of completed
                5-min volume
              </div>
            )}
          </div>
        )}
        {shown.pivot && pivotTooltip && (
          <div
            className={`pivot-tooltip ${pivotTooltip.kind}`}
            style={{ left: pivotTooltip.x, top: pivotTooltip.y }}
          >
            <div className="pivot-tooltip-kind">
              {pivotTooltip.kind === "high" ? "Pivot High" : "Pivot Low"}
            </div>
            <div className="pivot-tooltip-price tabular">
              {seriesRef.current?.priceFormatter().format(pivotTooltip.price) ??
                pivotTooltip.price.toFixed(2)}
            </div>
          </div>
        )}
        {shown.sessionLevel && sessionLevelTooltip && (
          <div
            className="fvg-tooltip session-level"
            style={{ left: sessionLevelTooltip.x, top: sessionLevelTooltip.y }}
          >
            <div className="fvg-tooltip-title">
              {sessionLevelTooltip.hover.title}
            </div>
            {sessionLevelTooltip.hover.lines.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )}
        {shown.fvg && fvgTooltip && (
          <div
            className={`fvg-tooltip ${fvgTooltip.hover.kind}`}
            style={{ left: fvgTooltip.x, top: fvgTooltip.y }}
          >
            <div className="fvg-tooltip-title">
              {fvgTooltip.hover.kind === "bullish" ? "Bullish" : "Bearish"} FVG
            </div>
            <div>Score: {fvgTooltip.hover.score} / 10</div>
            <div>
              Buy volume: {fvgTooltip.hover.buyVolume.toLocaleString("en-US")}
            </div>
            <div>
              Sell volume: {fvgTooltip.hover.sellVolume.toLocaleString("en-US")}
            </div>
            <div>
              Delta: {fvgTooltip.hover.delta >= 0 ? "+" : ""}
              {fvgTooltip.hover.delta.toLocaleString("en-US")}
            </div>
            <div>
              Level:{" "}
              {seriesRef.current
                ?.priceFormatter()
                .format(fvgTooltip.hover.levelPrice) ??
                fvgTooltip.hover.levelPrice.toFixed(2)}
            </div>
          </div>
        )}
        {liveRangeShown && liveRangeReport !== null && liveRangeCardPosition !== null && (
          <LiveRangeCard
            report={liveRangeReport}
            settings={liveRangeSettingsState}
            position={liveRangeCardPosition}
            paneOf={liveRangePaneOf}
            onMove={moveLiveRangeCard}
            onReset={resetLiveRangeCard}
          />
        )}
        {(["top-right", "bottom-right"] as const).map((position) => {
          const stack = tableOverlays.filter((entry) => entry.position === position);
          const monitor = position === "top-right" && exhaustionShown && exhaustionSettingsState?.showMonitor !== false && exhaustionCandleMsState !== null;
          const liveRange = position === "top-right" && liveRangeShown && liveRangeReport !== null && liveRangeCardPosition === null;
          const cards = monitor || liveRange;
          if (stack.length === 0 && !cards) return null;
          return (
          <div key={position} className={position === "bottom-right" ? "draw-table-overlay-stack draw-table-overlay-stack--bottom" : cards ? "draw-table-overlay-stack draw-table-overlay-stack--monitor" : "draw-table-overlay-stack"} style={position === "bottom-right" ? { right: bottomTableRightPx } : cards ? { right: (chartRef.current?.priceScale("right").width() ?? 0) + AXIS_INSET_GAP_PX } : undefined}>
            {monitor && (
              <CandleMonitor
                entry={candleMonitorState?.frame.entries.find((entry) => entry.candleMs === exhaustionCandleMsState) ?? null}
                receivedAt={candleMonitorState?.receivedAt ?? null}
                frameTs={candleMonitorState?.frame.ts ?? null}
                unit={exhaustionUnit}
                formatPrice={formatSeriesPrice}
              />
            )}
            {liveRange && liveRangeReport !== null && (
              <LiveRangeCard
                report={liveRangeReport}
                settings={liveRangeSettingsState}
                paneOf={liveRangePaneOf}
                onMove={moveLiveRangeCard}
                onReset={resetLiveRangeCard}
              />
            )}
            {stack.map(({ key, committedGrid }) => {
              const { rows, cols } = tableGridDimensions(committedGrid);
              if (rows <= 0 || cols <= 0) return null;
              return (
                <table key={key} className="draw-table-overlay">
                  <tbody>
                    {Array.from({ length: rows }, (_, row) => (
                      <tr key={row}>
                        {Array.from({ length: cols }, (_, col) => {
                          const cell = committedGrid[`${row},${col}`];
                          return (
                            <td
                              key={col}
                              style={{
                                backgroundColor: cell?.bgColor,
                                color: cell?.textColor,
                              }}
                            >
                              {cell?.text ?? ""}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })}
          </div>
          );
        })}
      </div>
    );
  },
);
