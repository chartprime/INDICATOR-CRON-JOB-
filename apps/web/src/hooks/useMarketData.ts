import { useCallback, useEffect, useRef, useState } from "react";
import {
  identitiesMatch,
  type BarFrame,
  type AnalyticsStatusFrame,
  type BarHistory,
  type BookFrame,
  type FrameIdentity,
  type HealthFrame,
  type ProfileFrame,
  type TradeFrame,
  type VpinReading,
  type VpinStatus,
} from "../types/frames";
import type {
  AggressiveHistoryRequest,
  MainToWorkerMessage,
  ProfileConfigRequest,
  ProfileHistoryRequest,
  SelectionTraceTransport,
  WorkerToMainMessage,
} from "../workers/marketDataWorker";
import { resolveDataSource, type DataSource } from "../workers/browserBinanceTransport";
import {
  createTimeCoveredMarkerRetentionBuffer,
  type MarkerRetentionBuffer,
  type MarkerSelectionView,
} from "../lib/chart/markerRetention";
import type { TradeAvailability } from "../lib/chart/indicatorTypes";
import { LiquidityGrid } from "../lib/indicators/passive-liquidity/liquidityGrid";
import { HeatmapHistory, type HistoryIdentity, type HistoryRequest } from "../lib/indicators/passive-liquidity/heatmapHistory";
import { ColumnHistoryStream, STREAM_MAX_REQUESTS_PER_MINUTE } from "../lib/indicators/passive-liquidity/columnHistoryStream";
import { COLUMN_HISTORY_MAX_IN_FLIGHT, COLUMN_HISTORY_MAX_PER_MINUTE, InFlightPool, RequestBudget } from "../lib/indicators/passive-liquidity/requestBudget";
import { WHALE_WALL_CHUNK_MS, WHALE_WALL_STREAM_ID_BASE, WallHistoryStream, type WallHistoryRequest } from "../lib/l2/wallHistoryStream";
import { L2Store } from "../lib/l2/l2Store";
import { IcebergBook } from "../lib/l2/icebergBook";
import { ExhaustionBook } from "../lib/l2/exhaustionBook";
import { InitiativeBook } from "../lib/l2/initiativeBook";
import type { CandleMonitorArrival } from "../lib/indicators/candle-monitor/candleMonitorText";
import {
  AggressiveTape,
  HISTORY_GIVE_UP_MS,
  nextAggressiveHistoryRequestId,
} from "../lib/indicators/aggressive-orders/aggressiveTape";
import { HISTORY_MIN_MS, tradesFromColumns } from "../lib/indicators/aggressive-orders/columnPrints";
import { BAND_COLUMN_MAX_PER_MINUTE, BandHistoryStore, ownsBandColumnId, type BandHistoryRequest } from "../lib/chart/bandHistory";
import type { L2HistoryRequester } from "../lib/l2/history";
import { DeltaProfileStore, DELTA_REQUEST_ID_STRIDE, baseRowWidthFor, type DeltaProfileRequest } from "../lib/indicators/live-delta-profile/deltaProfileStore";
import { RangePrintStore } from "../lib/indicators/aggressive-orders-profile/rangePrintStore";
import type { AggressiveHistoryReason, WallHistoryFrame, L2EventHistoryFrame } from "../types/frames";
import { inChartSession, isRegularSessionOnly, type SessionScoped } from "../lib/chart/marketCalendar";
import { recordConnectionClose } from "../lib/observability/connectionTrace";

export type ConnectionStatus = "connecting" | "open" | "closed";

export type FeedHealth = Pick<
  HealthFrame,
  | "recoveryState"
  | "stale"
  | "printsQuiet"
  | "reason"
  | "recordingStale"
  | "recordingLatestTs"
>;

export type ActiveSelection = { symbol: string } & FrameIdentity;

const MAX_TAPE_ROWS = 60;
const MAX_PENDING_TRADES = 500;
const MAX_PENDING_TRADES_FOR_BAR_CORRELATION = 10_000;
const MAX_TRADES_PER_LIVE_SOURCE_BAR = 10_000;
const MAX_RECORDED_CORRELATION_LOSSES = 10_000;
const MAX_RECENT_CLOSED_TRADE_SOURCE_BARS = 5;
const MAX_EVICTED_TRADE_BAR_OPEN_TIMES = 1_000;
const MAX_PENDING_BARS = 120;
const MAX_SEEN_TRADE_IDS = 5_000;
const MAX_BINANCE_MARKERS = 100_000;
const MAX_DXFEED_MARKERS = 5_000;
const DXFEED_MARKER_COVERAGE_BUCKET_MS = 5 * 60 * 1000;
const DXFEED_MARKER_MAX_PER_BUCKET_SIDE = 1;
const MAX_SEEN_MARKER_IDS = 65_000;
const MAX_ACCUMULATED_HISTORICAL_PROFILES = 128;

export const MAX_RETAINED_HISTORICAL_ZONES =
  MAX_ACCUMULATED_HISTORICAL_PROFILES;
const MAX_ACCUMULATED_VPIN_READINGS = 5_000;
const ID_ORDER_COMPACTION_MIN_HEAD = 4_096;

export interface UseMarketDataOptions {
  url: string;
  /**
   * Where the worker reads market data: the runtime WebSocket at `url`
   * (default) or Binance directly from the browser ("browser-binance").
   * Resolved from `?source=` and VITE_DATA_SOURCE when not given.
   */
  source?: DataSource;
  onSnapshotBars?: (
    bars: BarFrame[],
    selectionTrace?: SelectionTraceTransport,
  ) => void;
  onSelectionTrace?: (event: SelectionTraceEvent) => void;
  /**
   * `trades` is the complete observed set for this live source bar so far,
   * correlated by ts_exchange falling inside
   * [ts_open, ts_open + interval_ms). It carries no historical guarantee.
   * `tradeAvailability` distinguishes a genuine no-print live bar from a
   * historical range or bounded live buffer that was incomplete.
   */
  onBar?: (
    bar: BarFrame,
    trades: readonly TradeFrame[],
    tradeAvailability?: TradeAvailability,
  ) => void;
}

export type SelectionTraceEvent =
  | ({
      phase: "selection_requested";
      runId: string;
      selectionGeneration: number;
      requestedAtMs: number;
      symbol: string;
    } & FrameIdentity)
  | (Omit<SelectionTraceTransport, "phase"> & {
      phase: "react_selection_applied";
      mainReceivedAtMs: number;
      reactAppliedAtMs: number;
      symbol: string;
    } & FrameIdentity)
  | (Omit<SelectionTraceTransport, "phase"> & {
      phase: "recovery_confirmed" | "backfill_status";
      mainReceivedAtMs: number;
      symbol: string;
    } & FrameIdentity);

export interface UseMarketDataResult {
  analyticsStatus?: Partial<
    Record<"PROFILE" | "VPIN", AnalyticsStatusFrame["status"]>
  >;
  analyticsIncomplete?: boolean;
  status: ConnectionStatus;
  feedHealth: FeedHealth | null;
  trades: TradeFrame[];
  markerView: MarkerSelectionView;
  markersVersion: number;
  book: BookFrame | null;
  profile: ProfileFrame | null;
  liquidity: LiquidityGrid | null; // Passive Liquidity heatmap columns for the live pair; mutated in place
  heatmapHistory: HeatmapHistory | null;
  columnHistory: ColumnHistoryStream | null;
  hostWalls: WallHistoryStream | null;
  whaleWalls: WallHistoryStream | null;
  liquidityVersion: number; // bumps whenever `liquidity` gained columns
  l2: L2Store | null;
  l2Version: number;
  icebergs: IcebergBook | null;
  icebergsVersion: number;
  exhaustions: ExhaustionBook | null;
  exhaustionsVersion: number;
  initiatives: InitiativeBook | null;
  initiativesVersion: number;
  candleMonitor: CandleMonitorArrival | null;
  aggressiveTape: AggressiveTape | null; // every print of the live pair, fed the moment it lands; mutated in place, tells its subscribers itself
  historicalProfiles: ProfileFrame[];
  vpinHistory: VpinReading[];
  vpinStatus: VpinStatus | null;
  barHistory: BarHistory | null;
  activeSelection: ActiveSelection | null;
  selectPair: (
    symbol: string,
    identity: FrameIdentity,
    force?: boolean,
  ) => void;
  sendProfileConfig: (config: ProfileConfigRequest) => void;
  sendProfileHistory: (request: ProfileHistoryRequest) => void;
  requestLiquidityResync: () => void;
  requestExhaustionHistory: (fromTs: number) => void;
  requestInitiativeHistory: (fromTs: number) => void;
  requestAggressiveHistory: (request: AggressiveHistoryRequest) => void;
  aggressiveHistoryIssue: AggressiveHistoryReason | null;
  bandHistory: BandHistoryStore | null;
  bandHistoryVersion: number;
  requestBandHistory: (request: BandHistoryRequest) => void;
  requestL2History: L2HistoryRequester;
  deltaProfile: DeltaProfileStore | null;
  deltaProfileVersion: number;
  deltaTickProfile: DeltaProfileStore | null;
  deltaTickProfileVersion: number;
  requestDeltaProfile: (request: DeltaProfileRequest) => void;
  rangePrints: RangePrintStore | null;
  askRangePrints: () => void;
  stats: {
    tradesReceived: number;
    barUpdatesReceived: number;
    barsClosed: number;
    latencyMs: number | null;
  };
}

const LATENCY_EWMA_ALPHA = 0.1;
const LIQUIDITY_RESYNC_DEBOUNCE_MS = 3_000;
export const HISTORY_RETRY_BASE_MS = 2_000;
export const HISTORY_RETRY_MAX_ATTEMPTS = 3;
export const RANGE_REQUEST_IDS_KEPT = 64;

function traceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

function updateLatencyEwma(prev: number | null, tsExchange: number): number {
  const sample = Math.max(0, Date.now() - tsExchange);
  if (prev === null) return sample;
  return prev + LATENCY_EWMA_ALPHA * (sample - prev);
}

function chartTrades(identity: SessionScoped, trades: readonly TradeFrame[]): readonly TradeFrame[] {
  return isRegularSessionOnly(identity) ? trades.filter((trade) => trade.auction !== true && inChartSession(identity, trade.ts_exchange)) : trades;
}

function chartMarkers<T extends { ts_exchange: number }>(identity: SessionScoped, markers: readonly T[]): readonly T[] {
  return isRegularSessionOnly(identity) ? markers.filter((marker) => inChartSession(identity, marker.ts_exchange)) : markers;
}

function chartBars(identity: SessionScoped, bars: BarFrame[]): BarFrame[] {
  return isRegularSessionOnly(identity) ? bars.filter((bar) => inChartSession(identity, bar.ts_open)) : bars;
}

function samePair(
  a: ActiveSelection | null,
  symbol: string,
  identity: FrameIdentity,
): boolean {
  return a !== null && a.symbol === symbol && identitiesMatch(a, identity);
}

function frameIdentity(frame: FrameIdentity): FrameIdentity {
  return frame.provider === "BINANCE"
    ? { provider: "BINANCE", marketKind: frame.marketKind }
    : { provider: "DXFEED", assetClass: frame.assetClass };
}

function createMarkerBuffer(identity: FrameIdentity): MarkerRetentionBuffer {
  return identity.provider === "BINANCE"
    ? createTimeCoveredMarkerRetentionBuffer(MAX_BINANCE_MARKERS)
    : createTimeCoveredMarkerRetentionBuffer(
        MAX_DXFEED_MARKERS,
        DXFEED_MARKER_COVERAGE_BUCKET_MS,
        DXFEED_MARKER_MAX_PER_BUCKET_SIDE,
      );
}

function compareTradesNewestFirst(left: TradeFrame, right: TradeFrame): number {
  if (left.ts_exchange !== right.ts_exchange)
    return right.ts_exchange - left.ts_exchange;
  const leftId = Number(left.trade_id);
  const rightId = Number(right.trade_id);
  if (
    Number.isSafeInteger(leftId) &&
    Number.isSafeInteger(rightId) &&
    leftId !== rightId
  ) {
    return rightId - leftId;
  }
  return left.trade_id < right.trade_id
    ? 1
    : left.trade_id > right.trade_id
      ? -1
      : 0;
}

function compareTradesChronological(
  left: TradeFrame,
  right: TradeFrame,
): number {
  if (left.ts_exchange !== right.ts_exchange)
    return left.ts_exchange - right.ts_exchange;
  return left.trade_id < right.trade_id
    ? -1
    : left.trade_id > right.trade_id
      ? 1
      : 0;
}

function retainNewestTapeTrades(trades: readonly TradeFrame[]): TradeFrame[] {
  return [...trades].sort(compareTradesNewestFirst).slice(0, MAX_TAPE_ROWS);
}

export interface BoundedIdTracker {
  clear(): void;
  remember(id: string): boolean;
}

export function createBoundedIdTracker(maxIds: number): BoundedIdTracker {
  if (!Number.isSafeInteger(maxIds) || maxIds <= 0) {
    throw new Error(
      "createBoundedIdTracker: maxIds must be a positive safe integer",
    );
  }
  const ids = new Set<string>();
  let order: string[] = [];
  let head = 0;

  return {
    clear() {
      ids.clear();
      order = [];
      head = 0;
    },
    remember(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      order.push(id);
      if (order.length - head > maxIds) {
        ids.delete(order[head]);
        head += 1;
        if (head >= ID_ORDER_COMPACTION_MIN_HEAD && head * 2 >= order.length) {
          order = order.slice(head);
          head = 0;
        }
      }
      return true;
    },
  };
}

export function useMarketData({
  url,
  source: sourceOption,
  onSnapshotBars,
  onSelectionTrace,
  onBar,
}: UseMarketDataOptions): UseMarketDataResult {
  const source = sourceOption ?? resolveDataSource(
    import.meta.env.VITE_DATA_SOURCE,
    typeof location === "undefined" ? undefined : location.search,
  );
  const [analyticsStatus, setAnalyticsStatus] = useState<
    NonNullable<UseMarketDataResult["analyticsStatus"]>
  >({});
  const [analyticsIncomplete, setAnalyticsIncomplete] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [feedHealth, setFeedHealth] = useState<FeedHealth | null>(null);
  const [trades, setTrades] = useState<TradeFrame[]>([]);
  const markerBufferRef = useRef<MarkerRetentionBuffer | null>(null);
  const [markerView] = useState<MarkerSelectionView>(() => ({
    get version() {
      return markerBufferRef.current?.version ?? 0;
    },
    size: () => markerBufferRef.current?.size() ?? 0,
    snapshot: () => markerBufferRef.current?.snapshot() ?? [],
    topByMagnitude: (limit) =>
      markerBufferRef.current?.topByMagnitude(limit) ?? {
        stats: [],
        resolvedThreshold: null,
      },
    atLeastMagnitude: (minMagnitude, maxMagnitude = null) =>
      markerBufferRef.current?.atLeastMagnitude(minMagnitude, maxMagnitude) ??
      [],
  }));
  const [markersVersion, setMarkersVersion] = useState(0);
  const [book, setBook] = useState<BookFrame | null>(null);
  const [profile, setProfile] = useState<ProfileFrame | null>(null);
  const [liquidity, setLiquidity] = useState<LiquidityGrid | null>(null);
  const [heatmapHistory, setHeatmapHistory] = useState<HeatmapHistory | null>(null);
  const [columnHistory, setColumnHistory] = useState<ColumnHistoryStream | null>(null);
  const [hostWalls, setHostWalls] = useState<WallHistoryStream | null>(null);
  const [whaleWalls, setWhaleWalls] = useState<WallHistoryStream | null>(null);
  const [liquidityVersion, setLiquidityVersion] = useState(0);
  const [l2, setL2] = useState<L2Store | null>(null);
  const [l2Version, setL2Version] = useState(0);
  const [icebergs, setIcebergs] = useState<IcebergBook | null>(null);
  const [icebergsVersion, setIcebergsVersion] = useState(0);
  const [exhaustions, setExhaustions] = useState<ExhaustionBook | null>(null);
  const [exhaustionsVersion, setExhaustionsVersion] = useState(0);
  const [initiatives, setInitiatives] = useState<InitiativeBook | null>(null);
  const [initiativesVersion, setInitiativesVersion] = useState(0);
  const [candleMonitor, setCandleMonitor] = useState<CandleMonitorArrival | null>(null);
  const [aggressiveTape, setAggressiveTape] = useState<AggressiveTape | null>(
    null,
  );
  const [aggressiveHistoryIssue, setAggressiveHistoryIssue] =
    useState<AggressiveHistoryReason | null>(null);
  const [historicalProfiles, setHistoricalProfiles] = useState<ProfileFrame[]>(
    [],
  );
  const [vpinHistory, setVpinHistory] = useState<VpinReading[]>([]);
  const [vpinStatus, setVpinStatus] = useState<VpinStatus | null>(null);
  const [barHistory, setBarHistory] = useState<BarHistory | null>(null);
  const [activeSelection, setActiveSelection] =
    useState<ActiveSelection | null>(null);
  const [stats, setStats] = useState<UseMarketDataResult["stats"]>({
    tradesReceived: 0,
    barUpdatesReceived: 0,
    barsClosed: 0,
    latencyMs: null,
  });

  const onSnapshotBarsRef = useRef(onSnapshotBars);
  onSnapshotBarsRef.current = onSnapshotBars;
  const onSelectionTraceRef = useRef(onSelectionTrace);
  onSelectionTraceRef.current = onSelectionTrace;
  const onBarRef = useRef(onBar);
  onBarRef.current = onBar;

  const selectPairImplRef = useRef<
    (symbol: string, identity: FrameIdentity, force?: boolean) => void
  >(() => {});
  const selectPair = useCallback(
    (symbol: string, identity: FrameIdentity, force = false) => {
      selectPairImplRef.current(symbol, identity, force);
    },
    [],
  );

  const sendProfileConfigImplRef = useRef<
    (config: ProfileConfigRequest) => void
  >(() => {});
  const sendProfileConfig = useCallback((config: ProfileConfigRequest) => {
    sendProfileConfigImplRef.current(config);
  }, []);

  const sendProfileHistoryImplRef = useRef<
    (request: ProfileHistoryRequest) => void
  >(() => {});
  const sendProfileHistory = useCallback((request: ProfileHistoryRequest) => {
    sendProfileHistoryImplRef.current(request);
  }, []);

  const requestExhaustionHistoryImplRef = useRef<(fromTs: number) => void>(() => {});
  const requestExhaustionHistory = useCallback((fromTs: number) => {
    requestExhaustionHistoryImplRef.current(fromTs);
  }, []);
  const requestInitiativeHistoryImplRef = useRef<(fromTs: number) => void>(() => {});
  const requestInitiativeHistory = useCallback((fromTs: number) => {
    requestInitiativeHistoryImplRef.current(fromTs);
  }, []);
  const requestLiquidityResyncImplRef = useRef<() => void>(() => {});
  const requestLiquidityResync = useCallback(() => {
    requestLiquidityResyncImplRef.current();
  }, []);

  const [bandHistory, setBandHistory] = useState<BandHistoryStore | null>(null);
  const [bandHistoryVersion, setBandHistoryVersion] = useState(0);
  const requestBandHistoryImplRef = useRef<(request: BandHistoryRequest) => void>(() => {});
  const requestL2HistoryImplRef = useRef<L2HistoryRequester>(async () => null);
  const requestL2History = useCallback<L2HistoryRequester>((kind, request) => requestL2HistoryImplRef.current(kind, request), []);
  const requestBandHistory = useCallback((request: BandHistoryRequest) => {
    requestBandHistoryImplRef.current(request);
  }, []);
  const [deltaProfile, setDeltaProfile] = useState<DeltaProfileStore | null>(null);
  const [deltaProfileVersion, setDeltaProfileVersion] = useState(0);
  const [deltaTickProfile, setDeltaTickProfile] = useState<DeltaProfileStore | null>(null);
  const [deltaTickProfileVersion, setDeltaTickProfileVersion] = useState(0);
  const requestDeltaProfileImplRef = useRef<(request: DeltaProfileRequest) => void>(() => {});
  const requestDeltaProfile = useCallback((request: DeltaProfileRequest) => {
    requestDeltaProfileImplRef.current(request);
  }, []);
  const [rangePrints, setRangePrints] = useState<RangePrintStore | null>(null);
  const askRangePrintsImplRef = useRef<() => void>(() => {});
  const askRangePrints = useCallback(() => {
    askRangePrintsImplRef.current();
  }, []);
  const requestAggressiveHistoryImplRef = useRef<
    (request: AggressiveHistoryRequest) => void
  >(() => {});
  const requestAggressiveHistory = useCallback(
    (request: AggressiveHistoryRequest) => {
      requestAggressiveHistoryImplRef.current(request);
    },
    [],
  );

  useEffect(() => {
    const publishSnapshotBars = (
      bars: BarFrame[],
      selectionTrace?: SelectionTraceTransport,
    ) => {
      try {
        onSnapshotBarsRef.current?.(bars, selectionTrace);
      } catch (error) {
        console.error("useMarketData: onSnapshotBars callback failed", error);
      }
    };

    const clearPublishedState = () => {
      setAnalyticsStatus({});
      setAnalyticsIncomplete(false);
      setTrades([]);
      markerBufferRef.current = null;
      setMarkersVersion((version) => version + 1);
      setBook(null);
      setProfile(null);
      setHistoricalProfiles([]);
      setVpinHistory([]);
      setVpinStatus(null);
      setBarHistory(null);
      setFeedHealth(null);
      setStats({
        tradesReceived: 0,
        barUpdatesReceived: 0,
        barsClosed: 0,
        latencyMs: null,
      });
      publishSnapshotBars([]);
    };

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/marketDataWorker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      console.error("useMarketData: worker construction failed", error);
      setStatus("closed");
      clearPublishedState();
      setActiveSelection(null);
      return;
    }

    const pendingTrades: TradeFrame[] = [];
    // Separate from pendingTrades on purpose: that buffer is capped for the
    // recent-trades tape widget's own per-frame burst bound, and coupling
    // indicator-facing correctness to a constant tuned for a UI ticker would
    // be fragile. Unconsumed trades (no matching bar dispatched yet) carry
    // over to the next flush rather than being dropped. Once a source bar is
    // known, its observed prints move into correlatedTradesByOpenTime so a
    // later update of the same bar receives the whole observed bar, not just
    // the most recent animation-frame increment.
    const pendingTradesForBarCorrelation: TradeFrame[] = [];
    const correlatedTradesByOpenTime = new Map<number, TradeFrame[]>();
    const correlationBarsByOpenTime = new Map<number, BarFrame>();
    const retainedCorrelationBarFor = (
      trade: TradeFrame,
    ): BarFrame | undefined => {
      for (const known of correlationBarsByOpenTime.values()) {
        if (
          trade.ts_exchange >= known.ts_open &&
          trade.ts_exchange < known.ts_open + known.interval_ms
        )
          return known;
      }
      return undefined;
    };
    const partialCorrelationBarOpenTimes = new Set<number>();
    // Once a closed bar's trade record is evicted (below), any later dispatch
    // for that exact ts_open (a duplicate close, a final late print) must not
    // read back as a genuine zero-trade LIVE_COMPLETE bar just because its
    // history is gone. Remembered independently of recentClosedTradeBarOpenTimes
    // so it survives past that shorter window.
    const evictedTradeBarOpenTimes = new Set<number>();
    const evictedTradeBarOpenTimesOrder: number[] = [];
    const recentClosedTradeBarOpenTimes: number[] = [];
    let droppedCorrelationTradeTimes: number[] = [];
    let correlationLossRangeUnknown = false;
    const pendingBarsByOpenTime = new Map<number, BarFrame>();
    const seenTradeIds = createBoundedIdTracker(MAX_SEEN_TRADE_IDS);
    const seenMarkerIds = createBoundedIdTracker(MAX_SEEN_MARKER_IDS);
    let markerBuffer: MarkerRetentionBuffer | null = null;
    const adoptMarkerBuffer = (next: MarkerRetentionBuffer | null): void => {
      markerBuffer = next;
      markerBufferRef.current = next;
    };
    let markersDirty = false;
    let pendingBook: BookFrame | undefined;
    let pendingProfile: ProfileFrame | undefined;
    let liquidityGrid: LiquidityGrid | null = null;
    let liquidityDirty = false;
    let l2Store: L2Store | null = null;
    let l2Dirty = false;
    let icebergBook: IcebergBook | null = null;
    let icebergsDirty = false;
    let exhaustionBook: ExhaustionBook | null = null;
    let exhaustionsDirty = false;
    let initiativeBook: InitiativeBook | null = null;
    let initiativesDirty = false;
    let latestMonitor: CandleMonitorArrival | null = null;
    let monitorDirty = false;
    let tape: AggressiveTape | null = null;
    const columnBudget = new RequestBudget(COLUMN_HISTORY_MAX_PER_MINUTE);
    const columnReads = new InFlightPool(COLUMN_HISTORY_MAX_IN_FLIGHT);
    let bandStore: BandHistoryStore | null = null;
    let bandIdentity: HistoryIdentity | null = null;
    const pendingL2History = new Map<number, (frame: WallHistoryFrame | L2EventHistoryFrame | null) => void>();
    let nextL2HistoryId = 1;
    const bandStoreFor = (): BandHistoryStore => {
      if (bandStore === null) {
        bandStore = new BandHistoryStore({
          columns: {
            request: (request) => postHistoryRequest(request, "band column request"),
            identity: () => bandIdentity,
          },
          budget: columnBudget.share(BAND_COLUMN_MAX_PER_MINUTE),
          pool: columnReads,
        });
        setBandHistory(bandStore);
      }
      return bandStore;
    };
    let deltaStore: DeltaProfileStore | null = null;
    const deltaStoreFor = (identity: FrameIdentity, symbol: string): DeltaProfileStore => {
      if (deltaStore === null) {
        deltaStore = new DeltaProfileStore(baseRowWidthFor(identity, symbol));
        setDeltaProfile(deltaStore);
      }
      return deltaStore;
    };
    // Volume Profile (Ticks) reads the same trades over a window of its own, so it
    // keeps a store of its own: one store holds one window, and the two profiles
    // are asked for different ranges at once (the visible candles against whatever
    // the Live Delta Profile is set to). Its request ids start a stride up so a
    // reply is never handed to the store that did not ask for it.
    let deltaTickStore: DeltaProfileStore | null = null;
    const deltaTickStoreFor = (identity: FrameIdentity, symbol: string): DeltaProfileStore => {
      if (deltaTickStore === null) {
        deltaTickStore = new DeltaProfileStore(baseRowWidthFor(identity, symbol), DELTA_REQUEST_ID_STRIDE);
        setDeltaTickProfile(deltaTickStore);
      }
      return deltaTickStore;
    };
    let rangeStore: RangePrintStore | null = null;
    const rangeRequestIds = new Set<number>();
    let rangeInFlight: number | null = null;
    let historyAwaited: number | null = null;
    const rangeStoreFor = (): RangePrintStore => {
      if (rangeStore === null) {
        rangeStore = new RangePrintStore();
        setRangePrints(rangeStore);
      }
      return rangeStore;
    };
    let heldPair: ActiveSelection | null = null;
    let historyFloorInForce: number | null = null;
    let activeHistoryRequest: AggressiveHistoryRequest | null = null;
    let historyRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let historyRetryAttempts = 0;
    const clearHistoryRetry = () => {
      if (historyRetryTimer !== null) {
        clearTimeout(historyRetryTimer);
        historyRetryTimer = null;
      }
      historyRetryAttempts = 0;
    };
    const scheduleHistoryRetry = (
      request: AggressiveHistoryRequest,
      retryAfterMs: number | null,
    ) => {
      if (historyRetryTimer !== null) return;
      let delay: number;
      if (retryAfterMs !== null) {
        delay = retryAfterMs;
      } else {
        if (historyRetryAttempts >= HISTORY_RETRY_MAX_ATTEMPTS) {
          tape?.giveUpHistory(request.from_ts, request.to_ts, Date.now() + HISTORY_GIVE_UP_MS);
          setAggressiveHistoryIssue(null);
          return;
        }
        delay = HISTORY_RETRY_BASE_MS * 2 ** historyRetryAttempts;
        historyRetryAttempts += 1;
      }
      historyRetryTimer = setTimeout(() => {
        historyRetryTimer = null;
        if (
          historyFloorInForce !== request.min_size ||
          activeHistoryRequest !== request
        )
          return;
        requestAggressiveHistoryImplRef.current({
          ...request,
          request_id: nextAggressiveHistoryRequestId(),
        });
      }, delay);
    };
    let pendingHistoricalProfiles: Map<string, ProfileFrame> | null = null;
    let analyticsLoss = false;
    const pendingVpinReadings: VpinReading[] = [];
    let connectionClosed = false;
    // The worker sends a request on to the host only over an open socket and
    // drops it otherwise, so a request made while it is not open is never
    // answered: answer those here.
    let socketOpen = false;
    let pendingTradeCount = 0;
    let pendingBarUpdateCount = 0;
    let pendingBarsClosedCount = 0;
    let correlationOverflowWarned = false;
    let rafId: number | null = null;
    let latencyEwmaMs: number | null = null;
    let confirmedPair: ActiveSelection | null = null;
    let pendingRequest: ActiveSelection | null = null;
    let nextSelectionGeneration = 0;
    const traceRunId = crypto.randomUUID();
    let disposed = false;
    let workerTerminated = false;

    const terminateWorker = () => {
      if (workerTerminated) return;
      workerTerminated = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };

    const clearPendingFrames = () => {
      pendingTrades.length = 0;
      pendingTradesForBarCorrelation.length = 0;
      correlatedTradesByOpenTime.clear();
      correlationBarsByOpenTime.clear();
      partialCorrelationBarOpenTimes.clear();
      evictedTradeBarOpenTimes.clear();
      evictedTradeBarOpenTimesOrder.length = 0;
      recentClosedTradeBarOpenTimes.length = 0;
      droppedCorrelationTradeTimes = [];
      correlationLossRangeUnknown = false;
      markersDirty = false;
      pendingBarsByOpenTime.clear();
      pendingBook = undefined;
      pendingProfile = undefined;
      liquidityDirty = false;
      l2Dirty = false;
      pendingHistoricalProfiles = null;
      pendingVpinReadings.length = 0;
      pendingTradeCount = 0;
      pendingBarUpdateCount = 0;
      pendingBarsClosedCount = 0;
      correlationOverflowWarned = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    // `keepLiquidity`: a dropped socket keeps the last heatmap on screen until
    // the server's reset frames replace it after the reconnect; only a pair
    // change throws it away.
    const clearPairState = (keepLiquidity = false) => {
      analyticsLoss = false;
      clearHistoryRetry();
      setAggressiveHistoryIssue(null);
      clearPendingFrames();
      for (const resolve of pendingL2History.values()) resolve(null);
      pendingL2History.clear();
      adoptMarkerBuffer(null);
      if (!keepLiquidity) liquidityGrid = null;
      if (!keepLiquidity) tape = null;
      if (!keepLiquidity) {
        bandStore = null;
        setBandHistory(null);
        deltaStore = null;
        setDeltaProfile(null);
        deltaTickStore = null;
        setDeltaTickProfile(null);
        rangeStore = null;
        setRangePrints(null);
        rangeRequestIds.clear();
      } else {
        bandStore?.dropPending();
        deltaStore?.reanchor();
        deltaTickStore?.reanchor();
        rangeStore?.reanchor();
      }
      rangeInFlight = null;
      historyAwaited = null;
      seenTradeIds.clear();
      seenMarkerIds.clear();
      latencyEwmaMs = null;
      clearPublishedState();
      if (!keepLiquidity) setLiquidity(null);
      if (!keepLiquidity) setAggressiveTape(null);
      if (l2Store !== null) {
        if (keepLiquidity) l2Store.markUntrusted();
        else l2Store.clear();
        setL2Version((version) => version + 1);
      }
      if (icebergBook !== null) {
        if (keepLiquidity) icebergBook.markUntrusted();
        else icebergBook.clear();
        setIcebergsVersion((version) => version + 1);
      }
      if (exhaustionBook !== null) {
        if (keepLiquidity) exhaustionBook.markUntrusted();
        else exhaustionBook.clear();
        setExhaustionsVersion((version) => version + 1);
      }
      if (initiativeBook !== null) {
        if (keepLiquidity) initiativeBook.markUntrusted();
        else initiativeBook.clear();
        setInitiativesVersion((version) => version + 1);
      }
      if (latestMonitor !== null) {
        latestMonitor = null;
        monitorDirty = false;
        setCandleMonitor(null);
      }
    };

    const withdrawIncompleteAnalytics = () => {
      analyticsLoss = true;
      pendingVpinReadings.length = 0;
      pendingHistoricalProfiles = null;
      setVpinHistory([]);
      setVpinStatus(null);
      setHistoricalProfiles([]);
      setAnalyticsIncomplete(true);
    };

    const failWorker = () => {
      if (disposed) return;
      disposed = true;
      connectionClosed = true;
      confirmedPair = null;
      pendingRequest = null;
      clearPairState();
      setActiveSelection(null);
      setStatus("closed");
      terminateWorker();
    };

    const postWorkerControl = (
      message: MainToWorkerMessage,
      operation: string,
    ): boolean => {
      if (disposed) return false;
      try {
        worker.postMessage(message);
        return true;
      } catch (error) {
        console.error(`useMarketData: worker ${operation} failed`, error);
        failWorker();
        return false;
      }
    };

    const postHistoryRequest = (request: HistoryRequest, operation: string) => {
      postWorkerControl({
        kind: "heatmap_history",
        request_id: request.requestId,
        provider: request.identity.provider,
        market_kind: request.identity.marketKind,
        symbol: request.identity.symbol,
        level_ms: request.levelMs,
        from_ts: request.fromTs,
        to_ts: request.toTs,
        row_factor: request.rowFactor,
      }, operation);
    };
    const history = new HeatmapHistory({ request: (request) => postHistoryRequest(request, "heatmap history request"), pool: columnReads });
    const stream = new ColumnHistoryStream({ request: (request) => postHistoryRequest(request, "column history request"), budget: columnBudget.share(STREAM_MAX_REQUESTS_PER_MINUTE), pool: columnReads });
    const postWallRequest = (request: WallHistoryRequest) => {
      postWorkerControl({
        kind: "heatmap_walls",
        request_id: request.requestId,
        provider: request.identity.provider,
        market_kind: request.identity.marketKind,
        symbol: request.identity.symbol,
        from_ts: request.fromTs,
        to_ts: request.toTs,
        limit: request.limit,
        after: request.after === null ? null : { end_ts: request.after.endTs, id: request.after.id },
        ...(request.filter === null ? {} : { min_usd: request.filter.minUsd, always_outcomes: [...request.filter.alwaysOutcomes] }),
      }, "wall history request");
    };
    const walls = new WallHistoryStream({ request: postWallRequest });
    const whale = new WallHistoryStream({ request: postWallRequest, idBase: WHALE_WALL_STREAM_ID_BASE, chunkMs: WHALE_WALL_CHUNK_MS });
    const historyIdentityOf = (selection: ActiveSelection | null): HistoryIdentity | null => {
      if (selection === null) return null;
      if (selection.provider === "BINANCE") return { provider: "BINANCE", marketKind: selection.marketKind, symbol: selection.symbol };
      if (selection.provider === "DXFEED") return { provider: "DXFEED", marketKind: selection.assetClass, symbol: selection.symbol };
      return null;
    };
    setHeatmapHistory(history);
    setColumnHistory(stream);
    setHostWalls(walls);
    setWhaleWalls(whale);

    const ensureMarkerBuffer = (
      identity: FrameIdentity,
    ): MarkerRetentionBuffer => {
      if (markerBuffer === null)
        adoptMarkerBuffer(createMarkerBuffer(identity));
      return markerBuffer!;
    };

    const frameMatchesLivePair = (
      symbol: string,
      identity: FrameIdentity,
    ): boolean => {
      if (pendingRequest !== null) return false;
      return samePair(confirmedPair, symbol, identity);
    };

    const flush = () => {
      rafId = null;
      if (disposed || connectionClosed) {
        clearPendingFrames();
        return;
      }
      if (pendingBook !== undefined) {
        const nextBook = pendingBook;
        pendingBook = undefined;
        setBook(nextBook);
      }
      if (pendingProfile !== undefined) {
        const nextProfile = pendingProfile;
        pendingProfile = undefined;
        setProfile(nextProfile);
      }
      if (liquidityDirty) {
        liquidityDirty = false;
        setLiquidity(liquidityGrid);
        setLiquidityVersion((prev) => prev + 1);
      }
      if (l2Dirty) {
        l2Dirty = false;
        setL2(l2Store);
        setL2Version((prev) => prev + 1);
      }
      if (icebergsDirty) {
        icebergsDirty = false;
        setIcebergs(icebergBook);
        setIcebergsVersion((prev) => prev + 1);
      }
      if (monitorDirty) {
        monitorDirty = false;
        setCandleMonitor(latestMonitor);
      }
      if (exhaustionsDirty) {
        exhaustionsDirty = false;
        setExhaustions(exhaustionBook);
        setExhaustionsVersion((prev) => prev + 1);
      }
      if (initiativesDirty) {
        initiativesDirty = false;
        setInitiatives(initiativeBook);
        setInitiativesVersion((prev) => prev + 1);
      }
      if (
        pendingHistoricalProfiles !== null &&
        pendingHistoricalProfiles.size > 0
      ) {
        const updates = pendingHistoricalProfiles;
        pendingHistoricalProfiles = null;
        setHistoricalProfiles((prev) => {
          const profileKey = (entry: ProfileFrame) =>
            `${entry.delivery_scope}:${entry.history_request_id ?? "none"}:${entry.period_start_ts}:${entry.period_end_ts ?? "open"}`;
          const merged = new Map(
            prev.map((existing) => [profileKey(existing), existing]),
          );
          for (const [key, value] of updates) merged.set(key, value);
          if (merged.size > MAX_ACCUMULATED_HISTORICAL_PROFILES) {
            const oldestFirst = [...merged.entries()]
              .sort(([, a], [, b]) => a.period_start_ts - b.period_start_ts)
              .map(([key]) => key);
            for (const key of oldestFirst.slice(
              0,
              merged.size - MAX_ACCUMULATED_HISTORICAL_PROFILES,
            )) {
              merged.delete(key);
            }
          }
          return [...merged.values()];
        });
      }
      if (pendingVpinReadings.length > 0) {
        const appended = pendingVpinReadings.splice(
          0,
          pendingVpinReadings.length,
        );
        setVpinHistory((prev) => {
          const next = [...prev, ...appended];
          return next.length > MAX_ACCUMULATED_VPIN_READINGS
            ? next.slice(next.length - MAX_ACCUMULATED_VPIN_READINGS)
            : next;
        });
      }
      if (pendingBarsByOpenTime.size > 0) {
        const bars = [...pendingBarsByOpenTime.values()].sort(
          (a, b) => a.ts_open - b.ts_open,
        );
        pendingBarsByOpenTime.clear();
        for (const bar of bars) {
          correlationBarsByOpenTime.set(bar.ts_open, bar);
          const windowEnd = bar.ts_open + bar.interval_ms;
          const tradesForBar =
            correlatedTradesByOpenTime.get(bar.ts_open) ?? [];
          const correlatedIds = new Set(
            tradesForBar.map((trade) => trade.trade_id),
          );
          let partial =
            correlationLossRangeUnknown ||
            partialCorrelationBarOpenTimes.has(bar.ts_open) ||
            evictedTradeBarOpenTimes.has(bar.ts_open);
          const retainedDroppedTimes: number[] = [];
          for (const droppedAt of droppedCorrelationTradeTimes) {
            if (droppedAt >= bar.ts_open && droppedAt < windowEnd)
              partial = true;
            else retainedDroppedTimes.push(droppedAt);
          }
          droppedCorrelationTradeTimes = retainedDroppedTimes;
          const unmatchedTrades: TradeFrame[] = [];
          let previousTrade = tradesForBar[tradesForBar.length - 1];
          let requiresSort = false;
          for (const candidate of pendingTradesForBarCorrelation) {
            if (
              candidate.ts_exchange >= bar.ts_open &&
              candidate.ts_exchange < windowEnd
            ) {
              if (correlatedIds.has(candidate.trade_id)) continue;
              if (tradesForBar.length < MAX_TRADES_PER_LIVE_SOURCE_BAR) {
                correlatedIds.add(candidate.trade_id);
                if (
                  previousTrade !== undefined &&
                  compareTradesChronological(previousTrade, candidate) > 0
                ) {
                  requiresSort = true;
                }
                tradesForBar.push(candidate);
                previousTrade = candidate;
              } else {
                partial = true;
                if (!partialCorrelationBarOpenTimes.has(bar.ts_open)) {
                  partialCorrelationBarOpenTimes.add(bar.ts_open);
                  console.warn(
                    "useMarketData: live source-bar trade correlation reached its bounded capacity",
                    {
                      tsOpen: bar.ts_open,
                      intervalMs: bar.interval_ms,
                      maxTrades: MAX_TRADES_PER_LIVE_SOURCE_BAR,
                    },
                  );
                }
              }
            } else {
              const retainedBar = retainedCorrelationBarFor(candidate);
              if (retainedBar === undefined) {
                unmatchedTrades.push(candidate);
                continue;
              }
              const retainedTrades =
                correlatedTradesByOpenTime.get(retainedBar.ts_open) ?? [];
              if (
                !retainedTrades.some(
                  (trade) => trade.trade_id === candidate.trade_id,
                )
              ) {
                if (retainedTrades.length < MAX_TRADES_PER_LIVE_SOURCE_BAR)
                  retainedTrades.push(candidate);
                else partialCorrelationBarOpenTimes.add(retainedBar.ts_open);
              }
              correlatedTradesByOpenTime.set(
                retainedBar.ts_open,
                retainedTrades,
              );
            }
          }
          pendingTradesForBarCorrelation.length = 0;
          pendingTradesForBarCorrelation.push(...unmatchedTrades);
          // Normal WebSocket delivery is already chronological, so avoid a
          // full O(n log n) sort on every live-bar update. Still restore a
          // deterministic order if the transport ever delivers an inversion.
          if (requiresSort) tradesForBar.sort(compareTradesChronological);
          correlatedTradesByOpenTime.set(bar.ts_open, tradesForBar);
          const observedVolume = tradesForBar.reduce(
            (sum, trade) => sum + trade.size,
            0,
          );
          partial ||=
            tradesForBar.length !== bar.trade_count ||
            Math.abs(observedVolume - bar.volume) >
              Math.max(1e-8, Math.abs(bar.volume) * 1e-9);
          try {
            onBarRef.current?.(
              bar,
              tradesForBar,
              partial ? "LIVE_PARTIAL" : "LIVE_COMPLETE",
            );
          } catch (error) {
            console.error("useMarketData: onBar callback failed", error);
          }
          // Retain a small final-bar window. A transport may repeat a close
          // or deliver one final late print; that repeat must still carry the
          // full observed source-bar set rather than overwrite it with an
          // increment. The bounded terminal keeps the memory cost explicit.
          if (bar.closed) {
            if (!recentClosedTradeBarOpenTimes.includes(bar.ts_open)) {
              recentClosedTradeBarOpenTimes.push(bar.ts_open);
            }
            while (
              recentClosedTradeBarOpenTimes.length >
              MAX_RECENT_CLOSED_TRADE_SOURCE_BARS
            ) {
              const oldestOpenTime = recentClosedTradeBarOpenTimes.shift();
              if (oldestOpenTime !== undefined) {
                correlatedTradesByOpenTime.delete(oldestOpenTime);
                correlationBarsByOpenTime.delete(oldestOpenTime);
                partialCorrelationBarOpenTimes.delete(oldestOpenTime);
                if (!evictedTradeBarOpenTimes.has(oldestOpenTime)) {
                  evictedTradeBarOpenTimes.add(oldestOpenTime);
                  evictedTradeBarOpenTimesOrder.push(oldestOpenTime);
                  if (
                    evictedTradeBarOpenTimesOrder.length >
                    MAX_EVICTED_TRADE_BAR_OPEN_TIMES
                  ) {
                    const forgotten = evictedTradeBarOpenTimesOrder.shift();
                    if (forgotten !== undefined)
                      evictedTradeBarOpenTimes.delete(forgotten);
                  }
                }
              }
            }
          }
        }
      }
      if (pendingTrades.length > 0) {
        const trades = pendingTrades.splice(0, pendingTrades.length);
        setTrades((prev) => retainNewestTapeTrades([...trades, ...prev]));
      }
      if (markersDirty && markerBuffer !== null) {
        markersDirty = false;
        setMarkersVersion((version) => version + 1);
      }
      if (
        pendingTradeCount > 0 ||
        pendingBarUpdateCount > 0 ||
        pendingBarsClosedCount > 0
      ) {
        const tradeCount = pendingTradeCount;
        const barUpdateCount = pendingBarUpdateCount;
        const barsClosedCount = pendingBarsClosedCount;
        const latency = latencyEwmaMs;
        pendingTradeCount = 0;
        pendingBarUpdateCount = 0;
        pendingBarsClosedCount = 0;
        setStats((prev) => ({
          tradesReceived: prev.tradesReceived + tradeCount,
          barUpdatesReceived: prev.barUpdatesReceived + barUpdateCount,
          barsClosed: prev.barsClosed + barsClosedCount,
          latencyMs: latency,
        }));
      }
    };

    const scheduleFlush = () => {
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };

    worker.onerror = () => {
      if (disposed) return;
      console.error("useMarketData: market data worker failed");
      failWorker();
    };
    worker.onmessageerror = () => {
      if (disposed) return;
      console.error(
        "useMarketData: market data worker message could not be decoded",
      );
      failWorker();
    };

    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      if (msg.kind === "heatmap_history") {
        if (disposed) return;
        if (ownsBandColumnId(msg.request_id)) {
          if (bandStore?.acceptColumns(msg.request_id, msg.page, Date.now())) setBandHistoryVersion((version) => version + 1);
          return;
        }
        const target = stream.owns(msg.request_id) ? stream : history;
        if (msg.failed) target.fail(msg.request_id, msg.retry_after_ms);
        else target.accept(msg.request_id, msg.page);
        return;
      }
      if (msg.kind === "heatmap_walls") {
        if (disposed) return;
        const target = whale.owns(msg.request_id) ? whale : walls;
        if (msg.failed) target.fail(msg.request_id, msg.retry_after_ms);
        else target.accept(msg.request_id, msg.page);
        return;
      }
      if (!postWorkerControl({ kind: "ack" }, "delivery acknowledgement"))
        return;
      if (disposed) return;
      if (msg.kind === "status") {
        setStatus(msg.status);
        socketOpen = msg.status === "open";
        if (msg.status === "closed") {
          recordConnectionClose(msg.reason);
          connectionClosed = true;
          // The tape is kept for a reconnect to the same pair, but its live
          // stretch ends here: nothing is complete across the outage.
          tape?.endLive();
          pendingRequest ??= confirmedPair;
          clearPairState(true);
          if (confirmedPair !== null) heldPair = confirmedPair;
          confirmedPair = null;
          setActiveSelection(null);
        } else {
          connectionClosed = false;
        }
        return;
      }
      const frame = msg.frame;
      const milestoneTrace = msg.selectionTrace;
      if (
        milestoneTrace?.phase === "recovery_confirmed" ||
        milestoneTrace?.phase === "backfill_status"
      ) {
        const milestonePhase: "recovery_confirmed" | "backfill_status" =
          milestoneTrace.phase;
        onSelectionTraceRef.current?.({
          ...milestoneTrace,
          phase: milestonePhase,
          mainReceivedAtMs: traceNowMs(),
          symbol: frame.symbol,
          ...frameIdentity(frame),
        });
      }
      if (frame.type === "analytics_status") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        setAnalyticsStatus((previous) => ({
          ...previous,
          [frame.indicator]: frame.status,
        }));
        if (frame.indicator === "VPIN") {
          setVpinStatus(analyticsLoss ? null : frame.status === "EMPTY" || frame.status === "CLOSED" ? "IDLE" : frame.status);
          if (frame.status === "UNAVAILABLE") {
            pendingVpinReadings.length = 0;
            setVpinHistory([]);
          }
        } else if (frame.status !== "READY") {
          pendingProfile = undefined;
          setProfile(null);
        }
        return;
      }
      if (frame.type === "selection") {
        if (
          pendingRequest !== null &&
          !samePair(pendingRequest, frame.symbol, frame)
        ) {
          return;
        }
        const nextSelection: ActiveSelection = {
          symbol: frame.symbol,
          ...frameIdentity(frame),
        };
        const selectionChanged = !samePair(
          confirmedPair ?? heldPair,
          nextSelection.symbol,
          nextSelection,
        );
        const reconnected = confirmedPair === null && heldPair !== null;
        confirmedPair = nextSelection;
        heldPair = null;
        pendingRequest = null;
        history.setIdentity(historyIdentityOf(nextSelection));
        stream.setIdentity(historyIdentityOf(nextSelection));
        walls.setIdentity(historyIdentityOf(nextSelection));
        whale.setIdentity(historyIdentityOf(nextSelection));
        bandIdentity = historyIdentityOf(nextSelection);
        setActiveSelection(confirmedPair);
        if (msg.selectionTrace?.phase === "selection_confirmed") {
          const mainReceivedAtMs = traceNowMs();
          onSelectionTraceRef.current?.({
            ...msg.selectionTrace,
            phase: "react_selection_applied",
            mainReceivedAtMs,
            reactAppliedAtMs: traceNowMs(),
            symbol: frame.symbol,
            ...frameIdentity(frame),
          });
        }
        if (selectionChanged) clearPairState();
        else if (reconnected) clearPairState(true);
        return;
      }
      if (frame.type === "snapshot") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        clearPendingFrames();
        seenTradeIds.clear();
        seenMarkerIds.clear();
        for (const trade of frame.trades) seenTradeIds.remember(trade.trade_id);
        for (const marker of frame.markers)
          seenMarkerIds.remember(marker.trade_id);
        setBarHistory(frame.bar_history ?? null);
        setVpinHistory(
          analyticsLoss ||
            frame.vpin_status === "UNAVAILABLE" ||
            frame.vpin_status === "DISABLED"
            ? []
            : (frame.vpin_readings ?? []).slice(-MAX_ACCUMULATED_VPIN_READINGS),
        );
        setVpinStatus(analyticsLoss ? null : (frame.vpin_status ?? null));
        publishSnapshotBars(
          chartBars(frame, frame.bars),
          msg.selectionTrace?.phase === "first_snapshot"
            ? msg.selectionTrace
            : undefined,
        );
        setTrades(retainNewestTapeTrades(frame.trades));
        if (tape === null) {
          tape = new AggressiveTape();
          setAggressiveTape(tape);
        }
        tape.absorb(chartTrades(frame, frame.trades));
        bandStoreFor();
        const profileStore = deltaStoreFor(frame, frame.symbol);
        for (const trade of frame.trades) profileStore.markSeen(trade.ts_exchange);
        const tickProfileStore = deltaTickStoreFor(frame, frame.symbol);
        for (const trade of frame.trades) tickProfileStore.markSeen(trade.ts_exchange);
        const printStore = rangeStoreFor();
        for (const trade of frame.trades) printStore.markSeen(trade.ts_exchange);
        if (
          frame.aggressive_prints !== undefined &&
          frame.aggressive_prints_floor !== undefined &&
          frame.aggressive_prints_from !== undefined
        ) {
          // The server's pool of big prints: the bubbles' history, laid under the
          // tape like a collector reply, complete from the pool's floor.
          tape.addHistory(chartTrades(frame, frame.aggressive_prints));
          tape.coverHistory(
            frame.aggressive_prints_from,
            Date.now(),
            frame.aggressive_prints_floor,
          );
        }
        ensureMarkerBuffer(frame).insertAll(chartMarkers(frame, frame.markers));
        setMarkersVersion((version) => version + 1);
        return;
      }
      if (frame.type === "marker_history") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (frame.reset) {
          adoptMarkerBuffer(createMarkerBuffer(frame));
          seenMarkerIds.clear();
        }
        for (const marker of frame.markers)
          seenMarkerIds.remember(marker.trade_id);
        if (ensureMarkerBuffer(frame).insertAll(chartMarkers(frame, frame.markers)) || frame.reset) {
          markersDirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "health") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        setFeedHealth({
          recoveryState: frame.recoveryState,
          stale: frame.stale,
          printsQuiet: frame.printsQuiet,
          reason: frame.reason,
          recordingStale: frame.recordingStale,
          recordingLatestTs: frame.recordingLatestTs,
        });
        return;
      }
      if (frame.type === "book") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        pendingBook = frame;
        scheduleFlush();
        return;
      }
      if (frame.type === "profile") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (frame.delivery_scope !== "LIVE") {
          if (analyticsLoss) return;
          pendingHistoricalProfiles ??= new Map();
          const key = `${frame.delivery_scope}:${frame.history_request_id ?? "none"}:${frame.period_start_ts}:${frame.period_end_ts ?? "open"}`;
          if (
            !pendingHistoricalProfiles.has(key) &&
            pendingHistoricalProfiles.size >=
              MAX_ACCUMULATED_HISTORICAL_PROFILES
          ) {
            withdrawIncompleteAnalytics();
            return;
          }
          pendingHistoricalProfiles.set(key, frame);
          scheduleFlush();
          return;
        }
        pendingProfile = frame;
        scheduleFlush();
        return;
      }
      if (frame.type === "wall_history" || frame.type === "l2_event_history") {
        const resolve = pendingL2History.get(frame.request_id);
        if (resolve === undefined) return;
        pendingL2History.delete(frame.request_id);
        resolve(frameMatchesLivePair(frame.symbol, frame) ? frame : null);
        return;
      }
      if (frame.type === "band_history") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (bandStoreFor().put(frame, Date.now())) setBandHistoryVersion((version) => version + 1);
        return;
      }
      if (frame.type === "delta_profile") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        const now = Date.now();
        // One reply, one store: each store's ids are its own, so the one that did
        // not ask drops it on the id alone.
        if (deltaStoreFor(frame, frame.symbol).put(frame, now)) setDeltaProfileVersion((version) => version + 1);
        if (deltaTickStoreFor(frame, frame.symbol).put(frame, now)) setDeltaTickProfileVersion((version) => version + 1);
        return;
      }
      if (frame.type === "aggressive_history") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (rangeRequestIds.has(frame.request_id)) {
          if (rangeInFlight === frame.request_id) rangeInFlight = null;
          rangeStore?.put(frame, chartTrades(frame, frame.trades), Date.now());
          askRangePrintsImplRef.current();
          return;
        }
        if (frame.request_id === historyAwaited) historyAwaited = null;
        const request =
          activeHistoryRequest?.request_id === frame.request_id
            ? activeHistoryRequest
            : {
                request_id: frame.request_id,
                from_ts: frame.from_ts,
                to_ts: frame.to_ts,
                min_size: frame.min_size,
              };
        const isActiveRequest =
          activeHistoryRequest?.request_id === frame.request_id;
        if (tape === null) {
          tape = new AggressiveTape();
          setAggressiveTape(tape);
        }
        tape.addHistory(chartTrades(frame, frame.trades), Date.now() - HISTORY_MIN_MS);
        if (frame.reason === null)
          tape.coverHistory(frame.from_ts, frame.to_ts, frame.min_size);
        // A superseded read can still contain valid prints (and, when complete,
        // a valid coverage interval). It must not control a *different*
        // outstanding request, though: otherwise its retry/continuation state
        // can cancel or replace the request the user is currently waiting for.
        // With no outstanding request, a valid response may still reconcile a
        // previously known coverage gap.
        if (activeHistoryRequest !== null && !isActiveRequest) return;
        const floorInForce =
          historyFloorInForce === null ||
          frame.min_size === historyFloorInForce;
        if (
          frame.reason === "STORAGE_UNAVAILABLE" ||
          frame.reason === "READ_FAILED" ||
          frame.reason === "OVERLOADED"
        ) {
          setAggressiveHistoryIssue(frame.reason);
          if (floorInForce) scheduleHistoryRetry(request, frame.retry_after_ms);
          return;
        }
        clearHistoryRetry();
        setAggressiveHistoryIssue(
          frame.reason === "CONVERSION_INCOMPLETE" ? frame.reason : null,
        );
        if (
          frame.reason === "CONVERSION_INCOMPLETE" ||
          !floorInForce ||
          tape.full
        ) {
          if (isActiveRequest) aggressiveHistoryDone();
          return;
        }
        if (frame.reason === "CAP_REACHED") {
          if (frame.next_cursor === null) {
            setAggressiveHistoryIssue("CONVERSION_INCOMPLETE");
            if (isActiveRequest) aggressiveHistoryDone();
            return;
          }
          requestAggressiveHistoryImplRef.current({
            request_id: nextAggressiveHistoryRequestId(),
            from_ts: frame.from_ts,
            to_ts: frame.to_ts,
            min_size: frame.min_size,
            cursor: frame.next_cursor,
          });
          return;
        }
        if (isActiveRequest) activeHistoryRequest = null;
        const gap = tape.nextHistoryGap(frame.min_size);
        if (gap)
          requestAggressiveHistoryImplRef.current({
            request_id: nextAggressiveHistoryRequestId(),
            from_ts: gap.from,
            to_ts: gap.to,
            min_size: frame.min_size,
          });
        else if (isActiveRequest) askRangePrintsImplRef.current();
        return;
      }
      if (frame.type === "iceberg_orders") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        const created = icebergBook === null;
        icebergBook ??= new IcebergBook();
        if (icebergBook.apply(frame) !== "ignored" || created) {
          icebergsDirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "candle_monitor") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (latestMonitor !== null && frame.ts < latestMonitor.frame.ts) return;
        latestMonitor = { frame, receivedAt: Date.now() };
        monitorDirty = true;
        scheduleFlush();
        return;
      }
      if (frame.type === "exhaustion_shades") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        const created = exhaustionBook === null;
        exhaustionBook ??= new ExhaustionBook();
        if (exhaustionBook.apply(frame) !== "ignored" || created) {
          exhaustionsDirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "initiative_bands") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        const created = initiativeBook === null;
        initiativeBook ??= new InitiativeBook();
        if (initiativeBook.apply(frame) !== "ignored" || created) {
          initiativesDirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "l2_view" || frame.type === "l2_walls" || frame.type === "l2_events" || frame.type === "l2_ladder") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        const created = l2Store === null;
        l2Store ??= new L2Store({
          requestResync: (channel) => {
            postWorkerControl({ kind: "l2_resync", channel }, "l2 resync request");
          },
          yardstick: (ts, deep) => liquidityGrid?.yardstickAt(ts, deep) ?? null,
        });
        const previousVersion = l2Store.version;
        l2Store.apply(frame, frame.type === "l2_view" ? msg.decodedLane ?? null : null);
        if (created || l2Store.version !== previousVersion) {
          l2Dirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "liquidity") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        // Columns accumulate in one grid per pair; the grid is handed to the
        // chart once and mutated in place, with a version bump per flush.
        liquidityGrid ??= new LiquidityGrid();
        if (!(msg.decodedLiquidity === undefined ? liquidityGrid.apply(frame) : liquidityGrid.applyDecoded(frame, msg.decodedLiquidity))) {
          console.warn(
            "useMarketData: liquidity frame did not chain; requesting a resync",
            { seq: frame.seq, columns: frame.columns.length },
          );
          requestLiquidityResyncImplRef.current();
        } else {
          // The columns carry the biggest prints of their second: the bubbles'
          // history, laid under the tape by trade id like a collector reply.
          const prints = chartTrades(frame, tradesFromColumns(frame));
          if (prints.length > 0) {
            if (tape === null) {
              tape = new AggressiveTape();
              setAggressiveTape(tape);
            }
            tape.addHistory(prints);
          }
        }
        liquidityDirty = true;
        scheduleFlush();
        return;
      }
      if (frame.type === "vpin") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (analyticsLoss) return;
        if (pendingVpinReadings.length >= MAX_ACCUMULATED_VPIN_READINGS) {
          withdrawIncompleteAnalytics();
          return;
        }
        pendingVpinReadings.push({
          seal_ts: frame.seal_ts,
          active: frame.active,
          direction: frame.direction,
          strength: frame.strength,
          z_vpin: frame.z_vpin,
          z_velocity: frame.z_velocity,
          z_acceleration: frame.z_acceleration,
          activated_at_ts: frame.activated_at_ts,
        });
        scheduleFlush();
        return;
      }
      if (frame.type === "trade") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (!seenTradeIds.remember(frame.trade_id)) return;
        if (tape === null) {
          tape = new AggressiveTape();
          setAggressiveTape(tape);
        }
        if (pendingTrades.length === MAX_PENDING_TRADES) pendingTrades.shift();
        pendingTrades.push(frame);
        pendingTradeCount += 1;
        latencyEwmaMs = updateLatencyEwma(latencyEwmaMs, frame.ts_exchange);
        scheduleFlush();
        if (!inChartSession(frame, frame.ts_exchange)) return;
        if (frame.auction !== true) tape.add(frame);
        if (frame.auction !== true) deltaStoreFor(frame, frame.symbol).addTrade(frame);
        if (frame.auction !== true) deltaTickStoreFor(frame, frame.symbol).addTrade(frame);
        if (frame.auction !== true) rangeStoreFor().addTrade(frame);
        if (pendingTradesForBarCorrelation.length === MAX_PENDING_TRADES_FOR_BAR_CORRELATION) {
          const dropped = pendingTradesForBarCorrelation.shift();
          if (dropped !== undefined) {
            if (
              droppedCorrelationTradeTimes.length <
              MAX_RECORDED_CORRELATION_LOSSES
            ) {
              droppedCorrelationTradeTimes.push(dropped.ts_exchange);
            } else {
              // We can no longer name the affected bar precisely. Remain
              // conservative and mark subsequent correlation as partial
              // until the next snapshot/pair reset restores a clean epoch.
              correlationLossRangeUnknown = true;
            }
          }
          if (!correlationOverflowWarned) {
            correlationOverflowWarned = true;
            console.warn(
              "useMarketData: live trade correlation backlog reached its bounded capacity",
              {
                maxTrades: MAX_PENDING_TRADES_FOR_BAR_CORRELATION,
              },
            );
          }
        }
        pendingTradesForBarCorrelation.push(frame);
        return;
      }
      if (frame.type === "marker") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (!seenMarkerIds.remember(frame.trade_id)) return;
        if (!inChartSession(frame, frame.ts_exchange)) return;
        if (ensureMarkerBuffer(frame).insertAll([frame])) {
          markersDirty = true;
          scheduleFlush();
        }
        return;
      }
      if (frame.type === "bar") {
        if (!frameMatchesLivePair(frame.symbol, frame)) return;
        if (!inChartSession(frame, frame.ts_open)) return;
        const pendingForOpenTime = pendingBarsByOpenTime.get(frame.ts_open);
        if (pendingForOpenTime?.closed === true && frame.closed === false)
          return;
        if (
          !pendingBarsByOpenTime.has(frame.ts_open) &&
          pendingBarsByOpenTime.size === MAX_PENDING_BARS
        ) {
          let oldestOpenTime: number | undefined;
          for (const openTime of pendingBarsByOpenTime.keys()) {
            if (oldestOpenTime === undefined || openTime < oldestOpenTime)
              oldestOpenTime = openTime;
          }
          if (oldestOpenTime !== undefined)
            pendingBarsByOpenTime.delete(oldestOpenTime);
        }
        pendingBarsByOpenTime.set(frame.ts_open, frame);
        pendingBarUpdateCount += 1;
        if (frame.closed) pendingBarsClosedCount += 1;
        scheduleFlush();
      }
    };

    const selectPairForWorker = (
      symbol: string,
      identity: FrameIdentity,
      force = false,
    ) => {
      if (disposed) return;
      if (
        !force &&
        samePair(confirmedPair, symbol, identity) &&
        pendingRequest === null
      ) {
        return;
      }
      nextSelectionGeneration =
        nextSelectionGeneration === Number.MAX_SAFE_INTEGER
          ? 1
          : nextSelectionGeneration + 1;
      const requestedAtMs = traceNowMs();
      const selectMsg: MainToWorkerMessage = {
        kind: "select",
        symbol,
        ...identity,
        selectionTrace: {
          runId: traceRunId,
          selectionGeneration: nextSelectionGeneration,
          requestedAtMs,
        },
      };
      onSelectionTraceRef.current?.({
        phase: "selection_requested",
        runId: traceRunId,
        selectionGeneration: nextSelectionGeneration,
        requestedAtMs,
        symbol,
        ...identity,
      });
      pendingRequest = { symbol, ...identity };
      activeHistoryRequest = null;
      historyFloorInForce = null;
      clearHistoryRetry();
      clearPairState();
      postWorkerControl(selectMsg, "selection request");
    };
    selectPairImplRef.current = selectPairForWorker;

    const sendProfileConfigForWorker = (config: ProfileConfigRequest) => {
      const configMsg: MainToWorkerMessage = {
        kind: "profile_config",
        ...config,
      };
      postWorkerControl(configMsg, "profile configuration request");
    };
    sendProfileConfigImplRef.current = sendProfileConfigForWorker;

    const sendProfileHistoryForWorker = (request: ProfileHistoryRequest) => {
      const historyMsg: MainToWorkerMessage = {
        kind: "profile_history",
        ...request,
      };
      postWorkerControl(historyMsg, "profile history request");
    };
    sendProfileHistoryImplRef.current = sendProfileHistoryForWorker;

    let liquidityResyncNotBefore = 0;
    const requestLiquidityResyncForWorker = () => {
      const nowMs = Date.now();
      if (nowMs < liquidityResyncNotBefore) return;
      liquidityResyncNotBefore = nowMs + LIQUIDITY_RESYNC_DEBOUNCE_MS;
      postWorkerControl(
        { kind: "liquidity_resync" },
        "liquidity resync request",
      );
    };
    requestLiquidityResyncImplRef.current = requestLiquidityResyncForWorker;
    const requestExhaustionHistoryForWorker = (fromTs: number) => {
      postWorkerControl({ kind: "exhaustion_history", from_ts: fromTs }, "exhaustion history request");
    };
    requestExhaustionHistoryImplRef.current = requestExhaustionHistoryForWorker;
    const requestInitiativeHistoryForWorker = (fromTs: number) => {
      postWorkerControl({ kind: "initiative_history", from_ts: fromTs }, "initiative history request");
    };
    requestInitiativeHistoryImplRef.current = requestInitiativeHistoryForWorker;

    const requestAggressiveHistoryForWorker = (
      request: AggressiveHistoryRequest,
    ) => {
      if (request.min_size !== historyFloorInForce) clearHistoryRetry();
      historyFloorInForce = request.min_size;
      activeHistoryRequest = request;
      historyAwaited = socketOpen ? request.request_id : null;
      if (rangeInFlight !== null) {
        rangeStore?.lost(rangeInFlight);
        rangeInFlight = null;
      }
      tape?.noteHistoryAsk({ from: request.from_ts, to: request.to_ts }, request.min_size, Date.now());
      postWorkerControl(
        { kind: "aggressive_history", ...request },
        "aggressive history request",
      );
    };
    requestAggressiveHistoryImplRef.current = requestAggressiveHistoryForWorker;
    const aggressiveHistoryDone = () => {
      activeHistoryRequest = null;
      askRangePrintsImplRef.current();
    };
    const askRangePrintsForWorker = () => {
      const store = rangeStore;
      if (store === null || !socketOpen) return;
      if (historyRetryTimer !== null || historyAwaited !== null) return;
      const request = store.nextRequest(Date.now());
      if (request === null) return;
      rangeInFlight = request.request_id;
      rangeRequestIds.add(request.request_id);
      if (rangeRequestIds.size > RANGE_REQUEST_IDS_KEPT) rangeRequestIds.delete(rangeRequestIds.values().next().value as number);
      postWorkerControl({ kind: "aggressive_history", ...request }, "range prints request");
    };
    askRangePrintsImplRef.current = askRangePrintsForWorker;
    requestBandHistoryImplRef.current = (request: BandHistoryRequest) => {
      postWorkerControl({ kind: "band_history", ...request }, "band history request");
    };
    const requestL2HistoryForWorker: L2HistoryRequester = (kind, request) => new Promise((resolve) => {
      // After unmount, or with no open socket, nothing answers: say so at once
      // rather than never.
      if (disposed || !socketOpen) {
        resolve(null);
        return;
      }
      const requestId = nextL2HistoryId;
      nextL2HistoryId += 1;
      pendingL2History.set(requestId, resolve);
      postWorkerControl({ kind, ...request, request_id: requestId }, "l2 history request");
    });
    requestL2HistoryImplRef.current = requestL2HistoryForWorker;
    requestDeltaProfileImplRef.current = (request: DeltaProfileRequest) => {
      postWorkerControl({ kind: "delta_profile", ...request }, "delta profile request");
    };

    const startMsg: MainToWorkerMessage = { kind: "start", url, ...(source === undefined ? {} : { source }) };
    if (
      postWorkerControl({ kind: "flow_control" }, "delivery flow control") &&
      postWorkerControl(startMsg, "start request")
    ) {
      setStatus("connecting");
      clearPairState();
      setActiveSelection(null);
    }

    return () => {
      disposed = true;
      clearPendingFrames();
      const stopMsg: MainToWorkerMessage = { kind: "stop" };
      if (!workerTerminated) {
        try {
          worker.postMessage(stopMsg);
        } catch {
          void 0;
        }
      }
      terminateWorker();
      clearHistoryRetry();
      for (const resolve of pendingL2History.values()) resolve(null);
      pendingL2History.clear();
      history.setIdentity(null);
      stream.setIdentity(null);
      walls.setIdentity(null);
      whale.setIdentity(null);
      bandIdentity = null;
      setHeatmapHistory((current) => (current === history ? null : current));
      setColumnHistory((current) => (current === stream ? null : current));
      setHostWalls((current) => (current === walls ? null : current));
      setWhaleWalls((current) => (current === whale ? null : current));
      if (selectPairImplRef.current === selectPairForWorker) {
        selectPairImplRef.current = () => {};
      }
      if (sendProfileConfigImplRef.current === sendProfileConfigForWorker) {
        sendProfileConfigImplRef.current = () => {};
      }
      if (sendProfileHistoryImplRef.current === sendProfileHistoryForWorker) {
        sendProfileHistoryImplRef.current = () => {};
      }
      if (
        requestLiquidityResyncImplRef.current ===
        requestLiquidityResyncForWorker
      ) {
        requestLiquidityResyncImplRef.current = () => {};
      }
      if (requestExhaustionHistoryImplRef.current === requestExhaustionHistoryForWorker) {
        requestExhaustionHistoryImplRef.current = () => {};
      }
      if (requestInitiativeHistoryImplRef.current === requestInitiativeHistoryForWorker) {
        requestInitiativeHistoryImplRef.current = () => {};
      }
      if (
        requestAggressiveHistoryImplRef.current ===
        requestAggressiveHistoryForWorker
      ) {
        requestAggressiveHistoryImplRef.current = () => {};
      }
      if (askRangePrintsImplRef.current === askRangePrintsForWorker) {
        askRangePrintsImplRef.current = () => {};
      }
    };
  }, [url, source]);

  return {
    analyticsStatus,
    analyticsIncomplete,
    status,
    feedHealth,
    trades,
    markerView,
    markersVersion,
    book,
    profile,
    liquidity,
    liquidityVersion,
    heatmapHistory,
    columnHistory,
    hostWalls,
    whaleWalls,
    l2,
    l2Version,
    icebergs,
    icebergsVersion,
    exhaustions,
    exhaustionsVersion,
    initiatives,
    initiativesVersion,
    candleMonitor,
    aggressiveTape,
    aggressiveHistoryIssue,
    bandHistory,
    bandHistoryVersion,
    requestBandHistory,
    requestL2History,
    deltaProfile,
    deltaProfileVersion,
    deltaTickProfile,
    deltaTickProfileVersion,
    requestDeltaProfile,
    rangePrints,
    askRangePrints,
    historicalProfiles,
    vpinHistory,
    vpinStatus,
    barHistory,
    activeSelection,
    selectPair,
    sendProfileConfig,
    sendProfileHistory,
    requestLiquidityResync,
    requestExhaustionHistory,
    requestInitiativeHistory,
    requestAggressiveHistory,
    stats,
  };
}
