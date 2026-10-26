const { createAnalyticsJobOwner } = require("../platform/analytics-job-owner");
const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { REALTIME_ENDPOINT } = require("../providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../providers/dxfeed/dxlink-connection");
const { requestDevelopmentToken, isRetryableTokenBrokerError } = require("../providers/dxfeed/token-broker-client");
const { waitForAuthorized, waitForChannelOpened, AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS } = require("../providers/dxfeed/dxlink-handshake");
const { normalizeDxFeedEvent } = require("../providers/dxfeed/dxfeed-event-normalizer");
const { redactSecrets } = require("../providers/dxfeed/redact");
const { isAllowedDxFeedSymbol, isAllowedAssetClass, listCollectorInstruments, ASSET_CLASSES } = require("../providers/dxfeed/dxfeed-instrument-catalog");
const { resolveShutdownDeadline } = require("../providers/dxfeed/dxfeed-token-lifecycle");
const {
  adaptStoredDxFeedTimeAndSaleRow,
  isStoredDxFeedTimeAndSaleTapeRow,
  BAR_ELIGIBILITY_REASONS,
  classifyDxFeedTimeAndSaleForBar,
  isEquityAuctionPrint,
  classifyStoredDxFeedTimeAndSaleRowForBar,
  adaptStoredDxFeedTimeAndSaleRowForBar,
} = require("../providers/dxfeed/dxfeed-trade-adapter");
const { createDxFeedDataQualityLedger } = require("../providers/dxfeed/dxfeed-data-quality");
const { SESSION_POLICY, classifyDxFeedSession } = require("../providers/dxfeed/dxfeed-session-policy");
const { isMarketOpen } = require("../providers/shared/market-calendar");
const { createDxFeedBarAggregator } = require("../providers/dxfeed/dxfeed-bar-aggregator");
const { createDxFeedOrderBookAssembler, DEFAULT_CROSSED_GRACE_MS } = require("../providers/dxfeed/dxfeed-book-assembler");
const { createDxFeedOrderV2Capture } = require("../providers/dxfeed/dxfeed-order-v2-capture");
const { emitTelemetry } = require("../platform/telemetry");
const { createLiquidityPublisher, liquidityOptionsFromEnv, DEFAULT_FILL_S } = require("../indicators/passive_liquidity/liquidity-publisher");
const { DEFAULT_DB_PATH: DXFEED_DEFAULT_DB_PATH } = require("../storage/dxfeed/dxfeed-storage-db");
const { createDxFeedLiquidityBinding, dxfeedLiquidityOptionsFromEnv } = require("../indicators/passive_liquidity/dxfeed-liquidity-binding");
const {
  tapeWirePlanFor, dxFeedTradeMagnitude,
} = require("./dxfeed-market-data-server");
const { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../indicators/large-trade/large-trade-detection");
const { createHistoryBuffer } = require("./history");
const {
  parseHistoryRanges,
  createSelectionRateLimiter,
  createClientSender,
  createFrameDispatch,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
  createLiquidityReplayer,
  vpinBackfillPlan,
  createVpinWarmupRetryPolicy,
  VPIN_CALIBRATION_WINDOW_MS,
  VPIN_N_BASELINE,
  DXFEED_CANDLE_WARMUP_WINDOW_MS: CANDLE_WARMUP_WINDOW_MS,
} = require("./market-data-server-shared");
const { createInstrumentTickSizeResolver } = require("../providers/shared/instrument-tick-size");
const { createAggressivePool, warmAggressivePool, DEFAULT_READ_LIMIT: AGGRESSIVE_POOL_READ_LIMIT } = require("./aggressive-pool");
const { rowsToTradeFrames } = require("./aggressive-history");
const { createDxFeedVolumeProfileAdapter } = require("../indicators/volume-profile/volume-profile-adapters");
const {
  computeProfile,
  pollOpenPeriod,
  rescaleSessionToFit,
  DEFAULT_BIN_SIZE_MULTIPLIER,
  MIN_BIN_SIZE_MULTIPLIER,
  MAX_BIN_SIZE_MULTIPLIER,
} = require("../indicators/volume-profile/volume-profile-engine");
const { deriveBucketingParams } = require("../indicators/volume-profile/volume-profile-setup");
const { buildAlignedProfileSession, createProfilePollPolicy } = require("../indicators/volume-profile/volume-profile-session");
const { floorToMinute } = require("../indicators/volume-profile/volume-profile-cache");
const { buildHistoricalProfiles } = require("../indicators/volume-profile/volume-profile-history");
const { startVolumeProfileHistoryJob } = require("../indicators/volume-profile/volume-profile-history-job");
const {
  createVpinSession,
  applyLivePollResult,
} = require("../indicators/vpin/vpin-session");
const { startVpinWarmup } = require("../indicators/vpin/vpin-warmup");
const { startVpinLivePoll } = require("../indicators/vpin/vpin-live-poll");
const {
  dxfeedSelectionFrame,
  dxfeedLiquidityFrame,
  dxfeedSnapshotFrame,
  dxfeedHealthFrame,
  dxfeedTradeFrame,
  dxfeedMarkerFrame,
  dxfeedBarFrame,
  storageDxFeedCandleRowToBarFrame,
  dxfeedBookFrame,
  dxfeedProfileFrame,
  dxfeedVpinFrame,
} = require("./frames");
const { createAggressiveHistoryHandler } = require("./aggressive-history");
const { createDeltaProfileHandler } = require("./delta-profile");
const { createBandHistoryHandler } = require("./band-history-handler");
const { createHistoryRequestHandler } = require("./history-request-handler");
const { createL2Channel, parseL2Resync } = require("./l2-channel");
const { parseCapabilities } = require("./l2-frames");
const { createIcebergChannel } = require("./iceberg-channel");
const { createIcebergIndicator, icebergOptionsFromEnv } = require("../indicators/iceberg/iceberg-indicator");
const { createExhaustionChannel, parseExhaustionHistory } = require("./exhaustion-channel");
const { createExhaustionIndicator, exhaustionOptionsFromEnv } = require("../indicators/exhaustion/exhaustion-indicator");
const { createInitiativeChannel, parseInitiativeHistory } = require("./initiative-channel");
const { createInitiativeIndicator, initiativeOptionsFromEnv } = require("../indicators/initiative/initiative-indicator");
const { createCandleMonitor } = require("../indicators/candle-monitor/candle-monitor");

const WS_OPEN = 1;
const WARM_UP_TRADE_LIMIT = 100;
const RECENT_MARKER_LIMIT = 5_000;
const OPEN_MINUTE_SEED_PAGE_ROWS = 3_000;
const OPEN_MINUTE_SEED_MAX_PAGES = 10;
const OPEN_MINUTE_SEED_PENDING_LIMIT = 30_000;
const MARKER_HISTORY_WINDOW_MS = CANDLE_WARMUP_WINDOW_MS;
const MARKER_COVERAGE_BUCKET_MS = MARKER_BUCKET_MS;
const MARKER_MAX_PER_BUCKET_SIDE = MARKERS_PER_BUCKET_SIDE;
const MAX_RECENT_BARS = 10_080;
const MAX_SNAPSHOT_BARS = 10_080;
const SESSION_ENDED_REASON = "DXFEED_EAGER_SESSION_ENDED";
const PLANNED_TOKEN_ROTATION_REASON = "DXFEED_EAGER_PLANNED_TOKEN_ROTATION";
const SESSION_START_FAILED_REASON = "DXFEED_EAGER_SESSION_START_FAILED";
const MAX_CLIENT_BUFFERED_BYTES = 24 * 1024 * 1024;
const DEFAULT_CLIENT_BUFFER_HARD_BYTES = MAX_CLIENT_BUFFERED_BYTES * 3;
const DEFAULT_CLIENT_BUFFER_GRACE_MS = 10_000;
const QUIET_THRESHOLD_MS = 90_000;
const BOOK_QUIET_THRESHOLD_MS = 5_000;
const DEFAULT_BOOK_BROADCAST_MIN_INTERVAL_MS = 100;
const BOOK_FRAME_DEPTH = 20;
const BOOK_RESUBSCRIBE_MIN_INTERVAL_MS = 10_000;
const BOOK_RESUBSCRIBE_MAX_INTERVAL_MS = 120_000;
const BOOK_RESUBSCRIBE_CALM_MS = 5 * 60_000; // this long without a reset and the backoff starts over
const BOOK_RESUBSCRIBE_GAP_MS = 500;
const ORDER_CHANNEL_CONTRACT = "STREAM";
const CANDLE_FINALIZATION_INTERVAL_MS = 1_000;
const DEFAULT_SESSION_RETRY_BASE_MS = 120_000;
const MAX_SESSION_RETRY_MS = 30_000;
const DEFAULT_SESSION_RETRY_MAX_ATTEMPTS = 5;
const MAX_SESSION_RESTART_BACKOFF_MS = 10 * 60_000;
const MAX_CORRELATION_RECOVERY_ATTEMPTS = 3;
const VOLUME_PROFILE_POLL_MS = 1_500;
const VOLUME_PROFILE_DEFAULT_PERIOD_MS = 60 * 60 * 1000;
const VOLUME_PROFILE_REFERENCE_LOOKBACK_MS = 15 * 60 * 1000;
const VPIN_POLL_MS = 1_500;
const VPIN_BACKFILL_LOOKBACK_MS = CANDLE_WARMUP_WINDOW_MS;
const VPIN_WARMUP_REMOTE_TIMEOUT_MS = 50_000;
const BARS_WARMUP_RETRY_MS = 15_000;
const PROFILE_CONFIG_MODES = new Set(["continuous", "per_candle", "fixed_range"]);

function storageReaderConfigured(reader) {
  return (typeof reader?.dbPath === "string" && reader.dbPath.length > 0) || reader?.remote != null;
}
const PROFILE_CONFIG_KEYS = ["bin_size_multiplier", "mode", "period_ms", "range_end_ts", "range_start_ts", "type"];
const PROFILE_HISTORY_KEYS = ["bin_size_multiplier", "mode", "period_ms", "ranges", "request_id", "type"];

function isValidBinSizeMultiplier(value) {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) &&
      value >= MIN_BIN_SIZE_MULTIPLIER && value <= MAX_BIN_SIZE_MULTIPLIER);
}

function instrumentKey(symbol, assetClass) {
  return `${assetClass}:${symbol}`;
}

function historyInstrumentKey(symbol, assetClass) {
  return `DXFEED:${assetClass}:${symbol}`;
}

const DEFAULT_UNATTENDED_WARN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_WARM_VIEW_LIMIT = 2;
const DEFAULT_BACKGROUND_POLL_MS = 15_000;

function createDxFeedEagerMarketDataServer({
  createConnection = createDxLinkConnection,
  createBarAggregator = createDxFeedBarAggregator,
  liquidityOptions = {},
  liquidity: injectedLiquidity = null,
  icebergIndicatorFactory = createIcebergIndicator,
  exhaustionIndicatorFactory = createExhaustionIndicator,
  initiativeIndicatorFactory = createInitiativeIndicator,
  candleMonitorFactory = createCandleMonitor,
  aggressivePoolWarmup = true,
  createOrderV2Capture = createDxFeedOrderV2Capture,
  requestToken = requestDevelopmentToken,
  storageReader = null,
  brokerUrl,
  now = () => Date.now(),
  instruments = listCollectorInstruments(),
  telemetry = null,
  sessionRetryBaseMs = DEFAULT_SESSION_RETRY_BASE_MS,
  sessionRetryMaxAttempts = DEFAULT_SESSION_RETRY_MAX_ATTEMPTS,
  bookBroadcastMinIntervalMs = DEFAULT_BOOK_BROADCAST_MIN_INTERVAL_MS,
  bookCrossedGraceMs = DEFAULT_CROSSED_GRACE_MS,
  unattendedWarnIntervalMs = DEFAULT_UNATTENDED_WARN_INTERVAL_MS,
  tickSizeResolver = createInstrumentTickSizeResolver(),
  volumeProfileCache = null,
  volumeProfilePollMs = VOLUME_PROFILE_POLL_MS,
  vpinPollMs = VPIN_POLL_MS,
  vpinWarmup = startVpinWarmup,
  vpinLivePoll = startVpinLivePoll,
  clientBufferSoftBytes = MAX_CLIENT_BUFFERED_BYTES,
  clientBufferHardBytes = DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  clientBufferGraceMs = DEFAULT_CLIENT_BUFFER_GRACE_MS,
  warmViewLimit = DEFAULT_WARM_VIEW_LIMIT,
  backgroundPollMs = DEFAULT_BACKGROUND_POLL_MS,
  vpinEnabled = process.env.TT_VPIN_ENABLED !== "0",
} = {}) {
  for (const [name, dependency] of [
    ["createConnection", createConnection],
    ["createOrderV2Capture", createOrderV2Capture],
    ["requestToken", requestToken],
  ]) {
    if (typeof dependency !== "function") {
      throw new Error(`dxfeed eager market data server: ${name} must be a function`);
    }
  }
  if (typeof now !== "function") {
    throw new Error("dxfeed eager market data server: now must be a function");
  }
  if (!Number.isSafeInteger(sessionRetryBaseMs) || sessionRetryBaseMs <= 0) {
    throw new Error("dxfeed eager market data server: sessionRetryBaseMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(bookBroadcastMinIntervalMs) || bookBroadcastMinIntervalMs < 0) {
    throw new Error("dxfeed eager market data server: bookBroadcastMinIntervalMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(bookCrossedGraceMs) || bookCrossedGraceMs < 0) {
    throw new Error("dxfeed eager market data server: bookCrossedGraceMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(volumeProfilePollMs) || volumeProfilePollMs <= 0) {
    throw new Error("dxfeed eager market data server: volumeProfilePollMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(vpinPollMs) || vpinPollMs <= 0) {
    throw new Error("dxfeed eager market data server: vpinPollMs must be a positive safe integer");
  }
  for (const [name, value] of [
    ["clientBufferSoftBytes", clientBufferSoftBytes],
    ["clientBufferHardBytes", clientBufferHardBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dxfeed eager market data server: ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isInteger(clientBufferGraceMs) || clientBufferGraceMs < 0) {
    throw new Error("dxfeed eager market data server: clientBufferGraceMs must be a non-negative integer");
  }
  if (clientBufferHardBytes < clientBufferSoftBytes) {
    throw new Error("dxfeed eager market data server: clientBufferHardBytes must be >= clientBufferSoftBytes");
  }
  if (!Number.isSafeInteger(warmViewLimit) || warmViewLimit <= 0) {
    throw new Error("dxfeed eager market data server: warmViewLimit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(backgroundPollMs) || backgroundPollMs <= 0) {
    throw new Error("dxfeed eager market data server: backgroundPollMs must be a positive safe integer");
  }
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new Error("dxfeed eager market data server: instruments must be a non-empty array");
  }
  const seenEventSymbols = new Set();
  for (const instrument of instruments) {
    if (
      !instrument ||
      !isAllowedAssetClass(instrument.assetClass) ||
      !isAllowedDxFeedSymbol(instrument.symbol, instrument.assetClass) ||
      typeof instrument.orderSource !== "string" ||
      instrument.orderSource.length === 0 ||
      seenEventSymbols.has(instrument.symbol)
    ) {
      throw new Error("dxfeed eager market data server: instruments contain an invalid or ambiguous entry");
    }
    seenEventSymbols.add(instrument.symbol);
  }
  const clients = new Set();
  const clientSender = createClientSender({
    logPrefix: "dxfeed eager market data server",
    softBytes: clientBufferSoftBytes,
    hardBytes: clientBufferHardBytes,
    graceMs: clientBufferGraceMs,
    now,
    clientCount: () => clients.size,
    releaseClient: (client) => releaseClient(client),
    closeClient: (client, code, reason) => closeClient(client, code, reason),
  });
  const profileHistoryJobsByClient = new Map();
  const aggressiveHistory = createAggressiveHistoryHandler({ provider: "DXFEED", storageReader, now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed eager market data server" });
  const deltaProfile = createDeltaProfileHandler({ provider: "DXFEED", storageReader, now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed eager market data server" });
  const bandHistory = createBandHistoryHandler({
    provider: "DXFEED", storageReader, now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed eager market data server",
    geometryFor: (instrument) => (typeof liquidity.geometryFor === "function" ? liquidity.geometryFor(instrument.assetClass, instrument.symbol) : null),
  });
  const historyRequests = createHistoryRequestHandler({
    provider: "DXFEED", now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed eager market data server",
    geometryFor: (instrument) => (typeof liquidity.geometryFor === "function" ? liquidity.geometryFor(instrument.assetClass, instrument.symbol) : null),
    wallHistoryOf: (assetClass, symbol) => (typeof liquidity.wallHistoryOf === "function" ? liquidity.wallHistoryOf(assetClass, symbol) : null),
    eventHistoryOf: (assetClass, symbol) => (typeof liquidity.eventHistoryOf === "function" ? liquidity.eventHistoryOf(assetClass, symbol) : null),
  });
  const frameDispatch = createFrameDispatch({
    logPrefix: "dxfeed eager market data server",
    clients,
    wsOpen: WS_OPEN,
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
  });
  const selectionRateLimiter = createSelectionRateLimiter({ now });
  let barAggregator = createBarAggregator();
  // L2 Passive Liquidity heatmap, on the same engine as the Binance pairs: each
  // assembler's per-price book is diffed into level changes and fed, with the
  // tape, to one memory engine per instrument; the publisher samples them every
  // second. See indicators/passive_liquidity/dxfeed-liquidity-binding.js.
  const liquidityMemory = createDxFeedLiquidityBinding({ instruments, now, ...dxfeedLiquidityOptionsFromEnv() });
  const liquidity = injectedLiquidity ?? createLiquidityPublisher({
    memory: liquidityMemory,
    buildFrame: dxfeedLiquidityFrame,
    pyramid: "auto",
    fillHistoryS: DEFAULT_FILL_S,
    ...liquidityOptionsFromEnv(),
    dbPath: process.env.L2_HEATMAP_DXFEED_DB_PATH || DXFEED_DEFAULT_DB_PATH,
    ...liquidityOptions,
    now,
  });
  const liquidityReplayer = createLiquidityReplayer({
    logPrefix: "dxfeed eager market data server",
    clients,
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
    snapshotFrames: () => {
      const view = currentView();
      return view ? liquidity.snapshotFrames(view.assetClass, view.symbol) : [];
    },
    softBytes: clientBufferSoftBytes,
    now,
  });
  const l2Channel = createL2Channel({
    logPrefix: "dxfeed eager market data server l2",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => {
      const view = currentView();
      return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
    },
    identityOf: (pair) => ({ provider: "DXFEED", symbol: pair.symbol, assetClass: pair.marketKind }),
    snapshotOf: (pair) => (typeof liquidity.l2Snapshot === "function" ? liquidity.l2Snapshot(pair.marketKind, pair.symbol) : null),
    now,
  });
  const icebergOptions = icebergOptionsFromEnv();
  const icebergEnabled = icebergOptions.enabled !== false;
  const icebergChannel = createIcebergChannel({
    logPrefix: "dxfeed eager market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => {
      const view = currentView();
      return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
    },
    identityOf: (pair) => ({ provider: "DXFEED", symbol: pair.symbol, assetClass: pair.marketKind }),
    snapshotOf: (pair) => icebergIndicator.snapshot(pair, now()),
    now,
  });
  const icebergIndicator = icebergIndicatorFactory({
    provider: "DXFEED",
    now,
    ...icebergOptions,
    liveReachMs: liquidity.horizonMs,
    publish: (icebergs, pair, at, watched, liveSince) => icebergChannel.publish(icebergs, pair, at, watched, liveSince),
  });
  let icebergTickTimer = null;
  const exhaustionOptions = exhaustionOptionsFromEnv();
  const exhaustionEnabled = exhaustionOptions.enabled !== false;
  const exhaustionChannel = createExhaustionChannel({
    logPrefix: "dxfeed eager market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => {
      const view = currentView();
      return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
    },
    identityOf: (pair) => ({ provider: "DXFEED", symbol: pair.symbol, assetClass: pair.marketKind }),
    snapshotOf: (pair) => exhaustionIndicator.snapshot(pair, now()),
    now,
  });
  const exhaustionIndicator = exhaustionIndicatorFactory({
    provider: "DXFEED",
    now,
    ...exhaustionOptions,
    columnsAfter: (pair, afterTs, limit) => liquidity.deepColumnsAfter(pair.marketKind, pair.symbol, afterTs, limit),
    geometryOf: (pair) => liquidity.geometryFor(pair.marketKind, pair.symbol),
    hostColumns: typeof liquidity.hostColumns === "function" ? (pair, fromTs, toTs) => liquidity.hostColumns(pair.marketKind, pair.symbol, fromTs, toTs) : null,
    activePair: () => exhaustionChannelPair(),
    publish: (shades, pair, at, liveSince, loading) => exhaustionChannel.publish(shades, pair, at, liveSince, loading),
    reselect: () => exhaustionChannel.reselect(),
  });
  const candleMonitor = candleMonitorFactory({
    provider: "DXFEED",
    now,
    columnsAfter: (pair, afterTs, limit) => liquidity.deepColumnsAfter(pair.marketKind, pair.symbol, afterTs, limit),
    geometryOf: (pair) => liquidity.geometryFor(pair.marketKind, pair.symbol),
    activePair: () => exhaustionChannelPair(),
    publish: (entries, pair, at) => exhaustionChannel.publishMonitor(entries, pair, at),
  });
  const initiativeOptions = initiativeOptionsFromEnv();
  const initiativeEnabled = initiativeOptions.enabled !== false;
  const initiativeChannel = createInitiativeChannel({
    logPrefix: "dxfeed eager market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => {
      const view = currentView();
      return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
    },
    identityOf: (pair) => ({ provider: "DXFEED", symbol: pair.symbol, assetClass: pair.marketKind }),
    snapshotOf: (pair) => initiativeIndicator.snapshot(pair, now()),
    now,
  });
  const initiativeIndicator = initiativeIndicatorFactory({
    provider: "DXFEED",
    now,
    ...initiativeOptions,
    columnsAfter: (pair, afterTs, limit) => liquidity.deepColumnsAfter(pair.marketKind, pair.symbol, afterTs, limit),
    geometryOf: (pair) => liquidity.geometryFor(pair.marketKind, pair.symbol),
    hostColumns: typeof liquidity.hostColumns === "function" ? (pair, fromTs, toTs) => liquidity.hostColumns(pair.marketKind, pair.symbol, fromTs, toTs) : null,
    activePair: () => exhaustionChannelPair(),
    publish: (bands, pair, at, liveSince, loading) => initiativeChannel.publish(bands, pair, at, liveSince, loading),
    reselect: () => initiativeChannel.reselect(),
  });
  let initiativeTickTimer = null;
  let exhaustionTickTimer = null;
  function exhaustionChannelPair() {
    const view = currentView();
    return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
  }

  function icebergTapFor(view) {
    if (!icebergEnabled) return null;
    const pair = { marketKind: view.assetClass, symbol: view.symbol };
    return (events, meta) => {
      try {
        icebergIndicator.onNativeEvents(pair, events, { snapshot: meta.snapshot, receivedAt: now() });
      } catch (error) {
        console.error("dxfeed eager market data server: iceberg tracker rejected applied order events", error?.message ?? error);
      }
    };
  }

  function endIcebergLives(view) {
    if (!icebergEnabled) return;
    try {
      icebergIndicator.onNativeUnavailable({ marketKind: view.assetClass, symbol: view.symbol }, now());
    } catch (error) {
      console.error("dxfeed eager market data server: iceberg tracker rejected a book that went unavailable", error?.message ?? error);
    }
  }

  const views = new Map();
  const dataQuality = createDxFeedDataQualityLedger({ telemetry, now });
  const warmViewLru = new Map();
  const vpinWarmupRetry = createVpinWarmupRetryPolicy({ log: console.error, label: "dxfeed eager market data server" });
  const wirePlans = new Map();
  const keyByEventSymbol = new Map();
  for (const { assetClass, symbol, orderSource } of instruments) {
    const key = instrumentKey(symbol, assetClass);
    views.set(key, {
      symbol,
      assetClass,
      orderSource,
      recentTrades: [],
      recentTradeIds: new Set(),
      markerHistory: createHistoryBuffer({
        maxMarkers: RECENT_MARKER_LIMIT,
        markerBucketMs: MARKER_COVERAGE_BUCKET_MS,
        maxMarkersPerBucketSide: MARKER_MAX_PER_BUCKET_SIDE,
      }),
      recentBars: [],
      healthFrame: null,
      printsQuiet: false,
      quietTimer: null,
      bookAssembler: createDxFeedOrderBookAssembler({
        expectedSymbol: symbol,
        expectedAssetClass: assetClass,
        expectedSource: orderSource,
        crossedGraceMs: bookCrossedGraceMs,
        now,
      }),
      bookFrame: null,
      bookFingerprint: null,
      bookStale: false,
      bookQuietTimer: null,
      lastBookBroadcastMs: 0,
      bookBroadcastTimer: null,
      lastBookResubscribeMs: 0,
      lastBookStatus: null,
      barHistory: undefined,
      volumeProfile: null,
      vpinSession: null,
      vpinWarmupJob: null,
      vpinLiveJob: null,
      vpinLiveUnavailable: false,
      vpinWarmupState: "IDLE",
      vpinWarmupRetryNotBeforeMs: 0,
      historyWarmupStarted: false,
      historyWarmupGeneration: 0,
      barsWarmupInFlight: false,
      barsWarmupRetryNotBeforeMs: 0,
    });
    wirePlans.set(key, { ...tapeWirePlanFor(), symbol, assetClass, key, orderSource });
    keyByEventSymbol.set(symbol, key);
  }

  let session = null;
  let currentKey = null;
  let stopped = true;
  let jobOwner = createAnalyticsJobOwner();
  let stopPromise = null;
  let currentOrderChannelId = null;
  let latestAttempt = 0;
  let candleFinalizationTimer = null;
  let volumeProfilePollTimer = null;
  let volumeProfilePollInFlight = false;
  let vpinPollTimer = null;
  let restartTimer = null;
  let unattendedTimer = null;
  let unattendedSinceMs = null;
  let restartAttempt = 0;

  function closeClient(client, code, reason) {
    try {
      client.close?.(code, reason);
    } catch {
      try {
        client.terminate?.();
      } catch {
        void 0;
      }
    }
  }

  function currentView() {
    return currentKey ? views.get(currentKey) : null;
  }

  function finalizeDueBars() {
    const finalized = barAggregator.finalizeThrough(now(), (symbol, assetClass) => !session?.seedPendingKeys?.has(instrumentKey(symbol, assetClass)));
    for (const { symbol, assetClass, bar } of finalized) {
      const view = views.get(instrumentKey(symbol, assetClass));
      if (!view) continue;
      const frame = dxfeedBarFrame({
        symbol, assetClass, tsOpen: bar.ts_open, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, buyVolume: bar.buy_volume, sellVolume: bar.sell_volume, tradeCount: bar.trade_count, closed: true,
      });
      rememberBar(view, frame);
      if (isSelectedView(view)) broadcast(frame);
    }
    return finalized.length;
  }

  function startCandleFinalization() {
    if (candleFinalizationTimer) return;
    candleFinalizationTimer = setInterval(() => {
      try {
        finalizeDueBars();
      } catch (error) {
        console.error("dxfeed eager market data server: failed to finalize due candles", error?.message ?? error);
      }
    }, CANDLE_FINALIZATION_INTERVAL_MS);
    candleFinalizationTimer.unref?.();
  }

  function stopCandleFinalization() {
    if (!candleFinalizationTimer) return;
    clearInterval(candleFinalizationTimer);
    candleFinalizationTimer = null;
  }

  function releaseClient(client) {
    jobOwner.cancel(profileHistoryJobsByClient.get(client));
    profileHistoryJobsByClient.delete(client);
    clients.delete(client);
    clientSender.forget(client);
    liquidityReplayer.forget(client);
    l2Channel.forget(client);
    icebergChannel.forget(client);
    exhaustionChannel.forget(client);
    initiativeChannel.forget(client);
    selectionRateLimiter.forget(client);
    aggressiveHistory.forget(client);
    deltaProfile.forget(client);
    bandHistory.forget(client);
    historyRequests.forget(client);
  }

  function safelySendSerialized(client, serializedFrame, kind = null) {
    return clientSender.send(client, serializedFrame, kind);
  }

  const analyticsStatus = require("./analytics-status").createAnalyticsStatusPublisher(broadcast);
  function setAnalyticsStatus(view, indicator, status) {
    if (indicator === "VPIN") view.vpinWarmupState = status;
    analyticsStatus.set({ provider: "DXFEED", symbol: view.symbol, assetClass: view.assetClass }, indicator, status);
  }
  function safelySend(client, frame) {
    const sent = frameDispatch.safelySend(client, frame);
    if (sent && frame.type === "snapshot") analyticsStatus.replay(frame, (status) => frameDispatch.safelySend(client, status));
    return sent;
  }

  function broadcast(frame) {
    if (frame.type === "liquidity" && liquidityReplayer.size > 0) {
      liquidityReplayer.broadcast(frame);
      return;
    }
    frameDispatch.broadcast(frame);
    if (frame.type === "snapshot") analyticsStatus.replay(frame, (status) => frameDispatch.broadcast(status));
  }

  function allowSelectionRequest(client) {
    return selectionRateLimiter.allowSelectionRequest(client);
  }

  function isActive() {
    return session !== null && !session.settled;
  }

  function currentSymbolInfo() {
    const view = currentView();
    return view ? { symbol: view.symbol, assetClass: view.assetClass } : null;
  }

  function rememberTrade(view, frame) {
    if (view.recentTradeIds.has(frame.trade_id)) return false;
    view.recentTradeIds.add(frame.trade_id);
    view.recentTrades.push(frame);
    if (view.recentTrades.length > WARM_UP_TRADE_LIMIT) {
      const evicted = view.recentTrades.shift();
      view.recentTradeIds.delete(evicted.trade_id);
    }
    return true;
  }

  function rememberMarker(view, frame) {
    return view.markerHistory.recordMarker(frame);
  }

  function rememberBar(view, frame) {
    const last = view.recentBars[view.recentBars.length - 1];
    if (last && frame.ts_open <= last.ts_open) {
      console.error("dxfeed eager market data server: dropped an out-of-order closed bar", {
        symbol: view.symbol,
        tsOpen: frame.ts_open,
        lastTsOpen: last.ts_open,
      });
      return;
    }
    view.recentBars.push(frame);
    if (view.recentBars.length > MAX_RECENT_BARS) {
      view.recentBars.shift();
    }
  }

  function currentSnapshotFrame(view) {
    return dxfeedSnapshotFrame(
      view.recentBars, view.recentTrades, view.symbol, view.assetClass,
      view.markerHistory.snapshotMarkers(), view.barHistory,
      view.vpinSession && view.vpinSession.history.length > 0 ? view.vpinSession.history : undefined,
      view.vpinWarmupState,
      view.aggressivePool ? view.aggressivePool.snapshot() : undefined,
    );
  }

  function warmUpAggressivePrints(view) {
    if (!aggressivePoolWarmup || !storageReader || typeof storageReader.readAggressivePrintsAsync !== "function") return;
    if (view.aggressivePoolWarmed || view.aggressivePoolWarming) return;
    view.aggressivePool ??= createAggressivePool({ now });
    view.aggressivePoolWarming = true;
    const warmUpAttempt = latestAttempt;
    const historyGeneration = view.historyWarmupGeneration;
    const startedAtMs = Date.now();
    const key = instrumentKey(view.symbol, view.assetClass);
    warmAggressivePool({
      pool: view.aggressivePool,
      nowMs: now(),
      shouldContinue: () => !stopped && latestAttempt === warmUpAttempt && views.has(key) && view.historyWarmupGeneration === historyGeneration,
      read: async (fromMs, toMs, minSize, cursor) => {
        const { rows, available = true, hasMore = false, nextCursor = null } = await storageReader.readAggressivePrintsAsync(view.symbol, view.assetClass, { fromMs, toMs, minSize, limit: AGGRESSIVE_POOL_READ_LIMIT, cursor });
        if (!available) return { frames: [], available: false };
        const { frames, dropped } = rowsToTradeFrames("DXFEED", { symbol: view.symbol, assetClass: view.assetClass }, rows);
        if (dropped > 0) console.error(`dxfeed eager market data server: ${dropped} stored prints for ${key} could not be represented on the wire`);
        return { frames, hasMore, nextCursor };
      },
      onProgress: () => {
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      },
    }).then((result) => {
      view.aggressivePoolWarming = false;
      if (result.complete) view.aggressivePoolWarmed = true;
      console.info(`dxfeed eager market data server: aggressive-print warm-up ${result.complete ? "complete" : "incomplete"}`, {
        symbol: view.symbol, assetClass: view.assetClass, chunks: result.chunks, prints: result.prints, retained: view.aggressivePool.size, floor: view.aggressivePool.floor, durationMs: Date.now() - startedAtMs,
      });
    }).catch((error) => {
      view.aggressivePoolWarming = false;
      console.error("dxfeed eager market data server: aggressive-print warm-up failed", error?.message ?? error);
    });
  }

  async function warmUpBars(view) {
    if (!storageReader || typeof storageReader.readRecentCandles !== "function") return;
    if (view.barsWarmupInFlight || Date.now() < view.barsWarmupRetryNotBeforeMs) return;
    view.barsWarmupInFlight = true;
    try {
      const warmUpAttempt = latestAttempt;
      const historyGeneration = view.historyWarmupGeneration;
      const key = instrumentKey(view.symbol, view.assetClass);
      const warmupNowMs = now();
      const raw = storageReader.readRecentCandles(view.symbol, view.assetClass, {
        windowMs: CANDLE_WARMUP_WINDOW_MS,
        nowMs: warmupNowMs,
      });
      const { rows, available, startsAtRequestedWindow } = (raw != null && typeof raw.then === "function")
        ? await raw
        : raw;
      if (stopped || latestAttempt !== warmUpAttempt || views.get(key) !== view || view.historyWarmupGeneration !== historyGeneration) return;
      const requestedStartTsOpen = Math.floor(warmupNowMs / 60_000) * 60_000 - CANDLE_WARMUP_WINDOW_MS;
      if (!available) {
        view.barHistory = { availability: "UNAVAILABLE", requestedStartTsOpen, coverage: "NO_ROWS" };
        view.barsWarmupRetryNotBeforeMs = Date.now() + BARS_WARMUP_RETRY_MS;
        return;
      }
      const eligibleRows = rows.filter((row) => (
        Number.isSafeInteger(row?.ts_open) && row.ts_open >= requestedStartTsOpen
      ));
      const bounded = eligibleRows.length > MAX_SNAPSHOT_BARS
        ? eligibleRows.slice(eligibleRows.length - MAX_SNAPSHOT_BARS)
        : eligibleRows;
      const acceptedFrames = [];
      const earlier = [];
      const later = [];
      const firstLiveTsOpen = view.recentBars[0]?.ts_open;
      const lastLiveTsOpen = view.recentBars[view.recentBars.length - 1]?.ts_open;
      let latestPersistedTsOpen;
      for (const row of bounded) {
        try {
          const frame = storageDxFeedCandleRowToBarFrame(row, view.symbol, view.assetClass);
          latestPersistedTsOpen = latestPersistedTsOpen === undefined
            ? frame.ts_open
            : Math.max(latestPersistedTsOpen, frame.ts_open);
          if (firstLiveTsOpen !== undefined && frame.ts_open < firstLiveTsOpen) {
            if (earlier.length === 0 || frame.ts_open > earlier[earlier.length - 1].ts_open) earlier.push(frame);
          } else if (lastLiveTsOpen === undefined || frame.ts_open > lastLiveTsOpen) {
            later.push(frame);
          }
        } catch (error) {
          console.error("dxfeed eager market data server: warm-up candle row could not be represented on the wire", error?.message ?? error);
        }
      }
      if (earlier.length > 0) {
        const overflow = Math.max(0, earlier.length + view.recentBars.length - MAX_RECENT_BARS);
        const kept = earlier.slice(Math.min(earlier.length, overflow));
        view.recentBars = [...kept, ...view.recentBars].slice(-MAX_RECENT_BARS);
        acceptedFrames.push(...kept);
      }
      for (const frame of later) {
        const before = view.recentBars.length;
        rememberBar(view, frame);
        if (view.recentBars.length > before) acceptedFrames.push(frame);
      }
      if (latestPersistedTsOpen !== undefined) {
        barAggregator.seedFinalizedThrough(view.symbol, view.assetClass, latestPersistedTsOpen);
      }
      const earliestObservedTsOpen = acceptedFrames[0]?.ts_open;
      const startCovered = startsAtRequestedWindow === true &&
        earliestObservedTsOpen !== undefined &&
        earliestObservedTsOpen - requestedStartTsOpen < 60_000;
      view.barHistory = {
        availability: "AVAILABLE",
        requestedStartTsOpen,
        coverage: earliestObservedTsOpen === undefined ? "NO_ROWS" : startCovered ? "START_COVERED" : "START_NOT_COVERED",
        ...(earliestObservedTsOpen !== undefined ? { earliestObservedTsOpen } : {}),
      };
      view.barsWarmupRetryNotBeforeMs = 0;
    } catch (error) {
      console.error("dxfeed eager market data server: candle warm-up read failed", error?.message ?? error);
      view.barsWarmupRetryNotBeforeMs = Date.now() + BARS_WARMUP_RETRY_MS;
    } finally {
      view.barsWarmupInFlight = false;
    }
  }

  async function seedOpenMinute(view, activeSession, fromTs, toTs) {
    const key = instrumentKey(view.symbol, view.assetClass);
    let cursor = null;
    for (let page = 0; page < OPEN_MINUTE_SEED_MAX_PAGES; page += 1) {
      const { rows = [], nextCursor = null, available = false } = await storageReader.readTradesSince(view.symbol, view.assetClass, {
        fromTs, toTs, cursor, limit: OPEN_MINUTE_SEED_PAGE_ROWS,
      }) ?? {};
      if (!available || stopped || activeSession.settled || views.get(key) !== view) return;
      for (const row of rows) {
        if (classifyStoredDxFeedTimeAndSaleRowForBar(row, { requireValidTick: true }) !== BAR_ELIGIBILITY_REASONS.ACCEPTED) continue;
        const { closedBar, dropped } = barAggregator.ingest(adaptStoredDxFeedTimeAndSaleRowForBar(row));
        if (dropped || !closedBar) continue;
        const closedFrame = dxfeedBarFrame({
          symbol: view.symbol, assetClass: view.assetClass, tsOpen: closedBar.ts_open,
          open: closedBar.open, high: closedBar.high, low: closedBar.low, close: closedBar.close,
          volume: closedBar.volume, buyVolume: closedBar.buy_volume, sellVolume: closedBar.sell_volume, tradeCount: closedBar.trade_count,
          closed: true,
        });
        rememberBar(view, closedFrame);
        if (currentKey === key) broadcast(closedFrame);
      }
      if (nextCursor === null || rows.length < OPEN_MINUTE_SEED_PAGE_ROWS) return;
      cursor = nextCursor;
    }
  }

  function seedOpenMinutes(activeSession, handleFeedItem) {
    if (activeSession.seedPendingKeys.size === 0) return;
    const nowMs = now();
    const fromTs = nowMs - (nowMs % 60_000);
    for (const view of views.values()) {
      const key = instrumentKey(view.symbol, view.assetClass);
      seedOpenMinute(view, activeSession, fromTs, nowMs + 1).catch((error) => {
        console.error("dxfeed eager market data server: open-minute seed failed", { symbol: view.symbol, reason: error?.message ?? error });
      }).finally(() => {
        if (activeSession.settled) {
          activeSession.pendingFeedItems.delete(key);
          return;
        }
        activeSession.seedPendingKeys.delete(key);
        const pending = activeSession.pendingFeedItems.get(key) ?? [];
        activeSession.pendingFeedItems.delete(key);
        for (const item of pending) {
          if (activeSession.settled) break;
          handleFeedItem(item);
        }
        if (!activeSession.settled) finalizeDueBars();
      });
    }
  }

  function warmUpTrades(view) {
    if (!storageReader) return;
    try {
      const warmUpAttempt = latestAttempt;
      const historyGeneration = view.historyWarmupGeneration;
      const key = instrumentKey(view.symbol, view.assetClass);
      const wirePlan = wirePlans.get(instrumentKey(view.symbol, view.assetClass));
      const requireValidTick = view.assetClass === ASSET_CLASSES.FUTURE;
      const read = storageReader.readRecent(view.symbol, view.assetClass, wirePlan.eventType, {
        limit: WARM_UP_TRADE_LIMIT,
      });
      const apply = ({ rows, available }) => {
        if (stopped || latestAttempt !== warmUpAttempt || views.get(key) !== view || view.historyWarmupGeneration !== historyGeneration || !available || rows.length === 0) return;
        for (const row of [...rows].reverse()) {
          try {
            if (!isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick })) continue;
            rememberTrade(view, dxfeedTradeFrame(adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick })));
          } catch (error) {
            console.error("dxfeed eager market data server: warm-up row could not be represented on the wire", error?.message ?? error);
          }
        }
      };
      if (read != null && typeof read.then === "function") {
        return read.then(apply).catch((error) => {
          console.error("dxfeed eager market data server: warm-up read failed", error?.message ?? error);
        });
      } else {
        apply(read);
      }
    } catch (error) {
      console.error("dxfeed eager market data server: warm-up read failed", error?.message ?? error);
    }
  }

  function warmUpMarkers(view) {
    if (!storageReader || (typeof storageReader.readLargeTrades !== "function" && typeof storageReader.readLargeTradesAsync !== "function")) return;
    const requireValidTick = view.assetClass === ASSET_CLASSES.FUTURE;
    const nowMs = now();
    const options = {
      nowMs,
      limit: RECENT_MARKER_LIMIT,
      fromMs: Math.max(0, nowMs - MARKER_HISTORY_WINDOW_MS),
      bucketMs: MARKER_COVERAGE_BUCKET_MS,
      perBucketSideLimit: MARKER_MAX_PER_BUCKET_SIDE,
    };
    const applyRows = ({ rows, available }) => {
      if (!available || rows.length === 0) return false;
      for (const { row } of rows) {
        try {
          const trade = adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick });
          rememberMarker(view, dxfeedMarkerFrame(trade));
        } catch (error) {
          console.error("dxfeed eager market data server: warm-up marker row could not be represented on the wire", error?.message ?? error);
        }
      }
      return true;
    };
    if (typeof storageReader.readLargeTradesAsync === "function") {
      const startedAtMs = Date.now();
      const warmUpAttempt = latestAttempt;
      const historyGeneration = view.historyWarmupGeneration;
      return storageReader.readLargeTradesAsync(view.symbol, view.assetClass, options).then((result) => {
        if (stopped || latestAttempt !== warmUpAttempt || view.historyWarmupGeneration !== historyGeneration || !views.has(instrumentKey(view.symbol, view.assetClass)) || !applyRows(result)) return;
        console.info("dxfeed eager market data server: marker warm-up completed", {
          symbol: view.symbol, assetClass: view.assetClass,
          rows: result.rows.length, durationMs: Date.now() - startedAtMs,
        });
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }).catch((error) => {
        console.error("dxfeed eager market data server: marker warm-up worker failed", error?.message ?? error);
      });
    }
    try {
      applyRows(storageReader.readLargeTrades(view.symbol, view.assetClass, options));
    } catch (error) {
      console.error("dxfeed eager market data server: marker warm-up read failed", error?.message ?? error);
    }
  }

  async function buildAlignedSession(adapter, tickSize, periodMs, binSizeMultiplier, nowMs) {
    return buildAlignedProfileSession({ adapter, tickSize, periodMs, binSizeMultiplier, nowMs, referenceLookbackMs: VOLUME_PROFILE_REFERENCE_LOOKBACK_MS });
  }

  async function warmUpVolumeProfile(view) {
    if (!storageReader || typeof storageReader.readVolumeProfile !== "function" || typeof storageReader.readTradesSince !== "function") return;
    try {
      const historyGeneration = view.historyWarmupGeneration;
      const tickSize = tickSizeResolver.getDxFeedTickSize(view.assetClass, view.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, view.symbol, view.assetClass);
      const periodMs = VOLUME_PROFILE_DEFAULT_PERIOD_MS;
      const volumeProfileSession = await buildAlignedSession(adapter, tickSize, periodMs, DEFAULT_BIN_SIZE_MULTIPLIER, now());
      if (volumeProfileSession === null || view.historyWarmupGeneration !== historyGeneration) return;
      view.volumeProfile = {
        adapter, session: volumeProfileSession, tickSize, mode: "continuous", periodMs, binSizeMultiplier: DEFAULT_BIN_SIZE_MULTIPLIER, configGeneration: 0, pendingConfig: null,
      };
      if (view.requestedProfileConfig && isSelectedView(view)) handleProfileConfigMessage(view.requestedProfileConfig, null);
    } catch (error) {
      const policy = view.profilePollPolicy ??= createProfilePollPolicy({ now });
      if (policy.fail(error)) console.warn("dxfeed eager market data server: volume profile warm-up deferred", { symbol: view.symbol, reason: error?.message ?? error });
      setAnalyticsStatus(view, "PROFILE", policy.status);
    }
  }

  async function ensureVpinWarm(view) {
    if (!vpinEnabled) {
      if (view.vpinWarmupState !== "DISABLED") {
        view.vpinWarmupState = "DISABLED";
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }
      return;
    }
    if (!storageReader || typeof storageReader.readTradesSince !== "function" || typeof storageReader.readMinuteRollup !== "function") {
      if (view.vpinWarmupState !== "UNAVAILABLE") {
        view.vpinWarmupState = "UNAVAILABLE";
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }
      return;
    }
    if (view.vpinWarmupJob || Date.now() < view.vpinWarmupRetryNotBeforeMs) return;
    if (vpinWarmup === startVpinWarmup && !storageReaderConfigured(storageReader)) {
      if (view.vpinWarmupState !== "UNAVAILABLE") {
        console.warn("dxfeed eager market data server: vpin warm-up unavailable; storage reader is not configured (no local database path or remote endpoint)", { symbol: view.symbol });
        view.vpinWarmupState = "UNAVAILABLE";
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }
      return;
    }
    let tickSize;
    try {
      tickSize = tickSizeResolver.getDxFeedTickSize(view.assetClass, view.symbol);
    } catch (error) {
      console.error("dxfeed eager market data server: vpin tick-size resolution failed", { symbol: view.symbol, reason: error?.message ?? error });
      return;
    }
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    const nowMs = now();
    view.vpinWarmupState = "WARMING";
    if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
    let job;
    let vpinSession;
    try {
      job = jobOwner.launch(() => vpinWarmup({
        dbPath: storageReader.dbPath,
        remote: storageReader.remote ? { ...storageReader.remote, timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS } : storageReader.remote,
        provider: "dxfeed",
        symbol: view.symbol,
        assetClass: view.assetClass,
        tickSize,
        nowMs,
        calibrationWindowMs: VPIN_CALIBRATION_WINDOW_MS,
        backfillWindowMs: VPIN_BACKFILL_LOOKBACK_MS,
        engineOptions: { nBaseline: VPIN_N_BASELINE },
        ...vpinBackfillPlan(storageReader),
      }));
      if (!job || typeof job.promise?.then !== "function" || typeof job.cancel !== "function") {
        throw new Error("vpin warm-up factory must return a cancellable job");
      }
      view.vpinWarmupJob = job;
      const result = await job.promise;
      if (stopped || view.vpinWarmupJob !== job) return;
      if (!result?.available) {
        view.vpinWarmupState = "UNAVAILABLE";
        view.vpinWarmupRetryNotBeforeMs = Date.now() + vpinWarmupRetry.failed(`${view.assetClass}:${view.symbol}`, result?.reason ?? "NO_RESULT", {
          tradesApplied: result?.tradesApplied, pagesFetched: result?.pagesFetched, slicesRead: result?.slicesRead, durationMs: result?.durationMs,
        });
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
        return;
      }
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, view.symbol, view.assetClass);
      vpinSession = createVpinSession({ adapter, vBucket: result.vBucket, nowMs: result.pollFromTs });
      vpinSession.vpinState = result.vpinState;
      vpinSession.pollFromTs = result.pollFromTs;
      vpinSession.pollCursor = result.pollCursor;
      vpinSession.history = Array.isArray(result.history) ? result.history : [];
      view.vpinSession = vpinSession;
      view.vpinLiveUnavailable = false;
      view.vpinWarmupState = "READY";
      view.vpinWarmupRetryNotBeforeMs = 0;
      vpinWarmupRetry.succeeded(`${view.assetClass}:${view.symbol}`);
      console.info("dxfeed eager market data server: vpin worker warm-up completed", {
        symbol: view.symbol, assetClass: view.assetClass,
        durationMs: result.durationMs, tradesApplied: result.tradesApplied,
        ...(result.slicesRead === undefined ? {} : { slicesRead: result.slicesRead, chunksRead: result.chunksRead }),
        readings: vpinSession.history.length,
      });
    } catch (error) {
      if (!stopped) {
        view.vpinWarmupState = "UNAVAILABLE";
        view.vpinWarmupRetryNotBeforeMs = Date.now() + vpinWarmupRetry.failed(`${view.assetClass}:${view.symbol}`, "WORKER_FAILED", error?.message ?? error);
        if (isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }
      return;
    } finally {
      if (view.vpinWarmupJob === job) view.vpinWarmupJob = null;
    }
    if (stopped || !isSelectedView(view) || !vpinSession) return;
    try {
      broadcast(currentSnapshotFrame(view));
    } catch (error) {
      console.error("dxfeed eager market data server: vpin historical snapshot build failed", { symbol: view.symbol, reason: error?.message ?? error });
    }
  }

  function pollVpin() {
    const nowMs = now();
    for (const view of views.values()) {
      if (!view.historyWarmupStarted) continue;
      if (!view.vpinSession) {
        ensureVpinWarm(view).catch((error) => {
          console.error("dxfeed eager market data server: vpin warm-up failed", { symbol: view.symbol, reason: error?.message ?? error });
        });
      }
      if (view.barHistory?.availability === "UNAVAILABLE") {
        warmUpBars(view).catch((error) => {
          console.error("dxfeed eager market data server: candle warm-up retry failed", { symbol: view.symbol, reason: error?.message ?? error });
        });
      }
      if (!view.vpinSession || view.vpinLiveJob || view.vpinLiveUnavailable) continue;
      if (vpinLivePoll === startVpinLivePoll && !storageReaderConfigured(storageReader)) {
        console.warn("dxfeed eager market data server: vpin live poll unavailable; storage reader is not configured (no local database path or remote endpoint)", { symbol: view.symbol });
        view.vpinLiveUnavailable = true;
        setAnalyticsStatus(view, "VPIN", "UNAVAILABLE");
        continue;
      }
      if (!isSelectedView(view) && nowMs - (view.vpinLivePolledAt ?? 0) < backgroundPollMs) continue;
      view.vpinLivePolledAt = nowMs;
      const sessionAtLaunch = view.vpinSession;
      let job;
      try {
        job = jobOwner.launch(() => vpinLivePoll({
          dbPath: storageReader?.dbPath,
          remote: storageReader?.remote ? { ...storageReader.remote, timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS } : storageReader?.remote,
          provider: "dxfeed",
          symbol: view.symbol,
          assetClass: view.assetClass,
          vpinState: sessionAtLaunch.vpinState,
          pollFromTs: sessionAtLaunch.pollFromTs,
          pollCursor: sessionAtLaunch.pollCursor,
          nowMs,
        }));
        if (!job || typeof job.promise?.then !== "function" || typeof job.cancel !== "function") {
          throw new Error("vpin live-poll factory must return a cancellable job");
        }
        view.vpinLiveJob = job;
      } catch (error) {
        console.error("dxfeed eager market data server: vpin live-poll launch failed", { symbol: view.symbol, reason: error?.message ?? error });
        setAnalyticsStatus(view, "VPIN", "UNAVAILABLE");
        continue;
      }
      job.promise.then((pollResult) => {
        if (stopped || view.vpinLiveJob !== job || view.vpinSession !== sessionAtLaunch) return;
        const readings = applyLivePollResult(sessionAtLaunch, pollResult);
        setAnalyticsStatus(view, "VPIN", "READY");
        if (!isSelectedView(view) || readings.length === 0) return;
        try {
          for (const reading of readings) {
            broadcast(dxfeedVpinFrame({ reading, symbol: view.symbol, assetClass: view.assetClass }));
          }
        } catch (error) {
          console.error("dxfeed eager market data server: vpin frame build failed", { symbol: view.symbol, reason: error?.message ?? error });
          setAnalyticsStatus(view, "VPIN", "UNAVAILABLE");
        }
      }).catch((error) => {
        if (!stopped && view.vpinLiveJob === job) {
          console.error("dxfeed eager market data server: vpin live poll failed", { symbol: view.symbol, reason: error?.message ?? error });
          setAnalyticsStatus(view, "VPIN", "UNAVAILABLE");
        }
      }).finally(() => {
        if (view.vpinLiveJob === job) view.vpinLiveJob = null;
      });
    }
  }

  function startVpinPolling() {
    if (vpinPollTimer) return;
    vpinPollTimer = setInterval(() => {
      try {
        pollVpin();
      } catch (error) {
        console.error("dxfeed eager market data server: vpin poll failed", error?.message ?? error);
      }
    }, vpinPollMs);
    vpinPollTimer.unref?.();
  }

  function stopVpinPolling() {
    if (!vpinPollTimer) return;
    clearInterval(vpinPollTimer);
    vpinPollTimer = null;
  }

  function warmUpView(view) {
    if (!view || view.historyWarmupStarted || !session?.streaming) return;
    view.historyWarmupStarted = true;
    view.historyWarmupGeneration += 1;
    const refreshAfter = (operation, label) => {
      Promise.resolve(operation).then(() => {
        if (!stopped && isSelectedView(view)) broadcast(currentSnapshotFrame(view));
      }).catch((error) => {
        console.error(`dxfeed eager market data server: ${label} warm-up failed`, { symbol: view.symbol, reason: error?.message ?? error });
      });
    };
    refreshAfter(warmUpTrades(view), "trade");
    refreshAfter(warmUpBars(view), "candle");
    refreshAfter(warmUpMarkers(view), "marker");
    warmUpAggressivePrints(view);
    refreshAfter(warmUpVolumeProfile(view), "volume profile");
    refreshAfter(ensureVpinWarm(view), "vpin");
  }

  function evictHistoricalState(view) {
    view.historyWarmupGeneration += 1;
    view.recentTrades = [];
    view.recentTradeIds = new Set();
    view.markerHistory = createHistoryBuffer({
      maxMarkers: RECENT_MARKER_LIMIT,
      markerBucketMs: MARKER_COVERAGE_BUCKET_MS,
      maxMarkersPerBucketSide: MARKER_MAX_PER_BUCKET_SIDE,
    });
    view.recentBars = [];
    view.barHistory = undefined;
    view.barsWarmupInFlight = false;
    view.barsWarmupRetryNotBeforeMs = 0;
    view.aggressivePool = createAggressivePool({ now });
    view.aggressivePoolWarmed = false;
    view.aggressivePoolWarming = false;
    view.volumeProfile = null;
    view.vpinSession = null;
    jobOwner.cancel(view.vpinLiveJob);
    view.vpinLiveJob = null;
    view.vpinLiveUnavailable = false;
    jobOwner.cancel(view.vpinWarmupJob);
    view.vpinWarmupJob = null;
    view.vpinWarmupState = "IDLE";
    view.vpinWarmupRetryNotBeforeMs = 0;
    view.historyWarmupStarted = false;
    vpinWarmupRetry.forget(`${view.assetClass}:${view.symbol}`);
  }

  function retainWarmView(view) {
    const key = instrumentKey(view.symbol, view.assetClass);
    warmViewLru.delete(key);
    warmViewLru.set(key, view);
    while (warmViewLru.size > warmViewLimit) {
      const [evictedKey, evictedView] = warmViewLru.entries().next().value;
      warmViewLru.delete(evictedKey);
      if (evictedView !== view) evictHistoricalState(evictedView);
    }
  }
  async function rolloverVolumeProfileIfDue(view, nowMs) {
    const state = view.volumeProfile;
    if (!state || state.pendingConfig !== null || state.mode === "fixed_range") return;
    if (nowMs < state.session.periodStartTs + state.periodMs) return;
    const configGeneration = state.configGeneration ?? 0;
    const rebuilt = await buildAlignedSession(state.adapter, state.tickSize, state.periodMs, state.binSizeMultiplier, nowMs);
    if (rebuilt === null) return false;
    if (view.volumeProfile === state && (state.configGeneration ?? 0) === configGeneration) state.session = rebuilt;
    return true;
  }

  async function pollVolumeProfiles() {
    if (volumeProfilePollInFlight) return;
    volumeProfilePollInFlight = true;
    try {
      const nowMs = now();
      for (const view of views.values()) {
        if (!view.historyWarmupStarted) continue;
        const policy = view.profilePollPolicy ??= createProfilePollPolicy({ now });
        if (!policy.allow(isMarketOpen(view.assetClass, nowMs))) {
          setAnalyticsStatus(view, "PROFILE", policy.status);
          continue;
        }
        if (!view.volumeProfile) await warmUpVolumeProfile(view);
        const state = view.volumeProfile;
        if (!state) {
          if (policy.status !== "UNAVAILABLE") policy.settle("EMPTY");
          setAnalyticsStatus(view, "PROFILE", policy.status);
          continue;
        }
        if (state.pendingConfig !== null) continue;
        if (state.rebuildDeferred && view.requestedProfileConfig) {
          state.rebuildDeferred = false;
          handleProfileConfigMessage(view.requestedProfileConfig, null);
          continue;
        }
        if (!isSelectedView(view) && nowMs - (view.profilePolledAt ?? 0) < backgroundPollMs) continue;
        view.profilePolledAt = nowMs;
        const generation = state.configGeneration;
        try {
          if (await rolloverVolumeProfileIfDue(view, nowMs) === false) {
            if (view.volumeProfile !== state || state.configGeneration !== generation) continue;
            policy.settle("EMPTY");
            setAnalyticsStatus(view, "PROFILE", policy.status);
            continue;
          }
          if (view.volumeProfile !== state || state.configGeneration !== generation) continue;
          let complete = true;
          if (state.mode !== "fixed_range") {
            ({ complete } = await pollOpenPeriod(state.session, state.adapter, nowMs));
          }
          if (view.volumeProfile !== state || state.configGeneration !== generation) continue;
          policy.settle(!complete ? "WARMING" : state.session.buckets.size === 0 ? "EMPTY" : "READY");
          setAnalyticsStatus(view, "PROFILE", policy.status);
          if (!complete) continue;
        } catch (error) {
          if (view.volumeProfile !== state || state.configGeneration !== generation) continue;
          setAnalyticsStatus(view, "PROFILE", "UNAVAILABLE");
          if (policy.fail(error)) console.warn("dxfeed eager market data server: volume profile poll deferred", { symbol: view.symbol, reason: error?.message ?? error });
          continue;
        }
      if (!isSelectedView(view) || state.session.buckets.size === 0) continue;
      try {
        const profile = computeProfile(state.session.buckets);
        broadcast(dxfeedProfileFrame({
          engineState: { session: state.session, profile, mode: state.mode },
          symbol: view.symbol,
          assetClass: view.assetClass,
        }));
      } catch (error) {
        console.error("dxfeed eager market data server: volume profile frame build failed", { symbol: view.symbol, reason: error?.message ?? error });
        setAnalyticsStatus(view, "PROFILE", "UNAVAILABLE");
      }
    }
    } finally {
      volumeProfilePollInFlight = false;
    }
  }

  function startVolumeProfilePolling() {
    if (volumeProfilePollTimer) return;
    volumeProfilePollTimer = setInterval(() => {
      pollVolumeProfiles().catch((error) => {
        console.error("dxfeed eager market data server: volume profile poll failed", error?.message ?? error);
      });
    }, volumeProfilePollMs);
    volumeProfilePollTimer.unref?.();
  }

  function stopVolumeProfilePolling() {
    if (!volumeProfilePollTimer) return;
    clearInterval(volumeProfilePollTimer);
    volumeProfilePollTimer = null;
  }

  async function buildRangeProfileFrame(view, adapter, tickSize, rangeStartTs, rangeEndTs, binSizeMultiplier, { mode = "fixed_range", deliveryScope = "FIXED_RANGE", historyRequestId = null } = {}) {
    const params = await deriveBucketingParams({ adapter, tickSize, fromTs: rangeStartTs, toTs: rangeEndTs, binSizeMultiplier });
    if (params === null) return null;
    const { originPrice, rowWidth } = params;
    const { buckets: readerBuckets, available } = await adapter.readVolumeProfile(rangeStartTs, rangeEndTs, originPrice, rowWidth);
    if (!available || readerBuckets.length === 0) return null;
    const buckets = new Map(readerBuckets.map((row) => [row.bucket, { volume: row.volume, buyVolume: row.buyVolume, sellVolume: row.sellVolume }]));
    const session = { periodStartTs: rangeStartTs, periodEndTs: rangeEndTs, rowWidth, originPrice, buckets };
    rescaleSessionToFit(session);
    const profile = computeProfile(session.buckets);
    return dxfeedProfileFrame({
      engineState: { session, profile, mode, deliveryScope, historyRequestId },
      symbol: view.symbol,
      assetClass: view.assetClass,
    });
  }

  async function sendFixedRangeProfile(client, view, rangeStartTs, rangeEndTs, binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER) {
    if (!storageReader || !clients.has(client)) return;
    try {
      const tickSize = tickSizeResolver.getDxFeedTickSize(view.assetClass, view.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0 || !clients.has(client)) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, view.symbol, view.assetClass);
      const frame = await buildRangeProfileFrame(view, adapter, tickSize, rangeStartTs, rangeEndTs, binSizeMultiplier);
      if (frame === null || !clients.has(client) || currentView() !== view) return;
      safelySend(client, frame);
    } catch (error) {
      console.error("dxfeed eager market data server: fixed_range profile request failed", { symbol: view.symbol, reason: error?.message ?? error });
    }
  }

  function sendHistoricalProfiles(client, view, ranges, binSizeMultiplier, mode, historyRequestId) {
    ranges = ranges.filter((range) => range.rangeEndTs <= floorToMinute(now()));
    if (ranges.length === 0) return;
    if (!storageReader || !clients.has(client)) return;
    try {
      const tickSize = tickSizeResolver.getDxFeedTickSize(view.assetClass, view.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0 || !clients.has(client)) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, view.symbol, view.assetClass);
      const sendBuilt = (built) => {
        if (built === null || !clients.has(client) || currentView() !== view) return;
        for (const { session, profile } of built) {
          if (!clients.has(client) || currentView() !== view) return;
          safelySend(client, dxfeedProfileFrame({
            engineState: { session, profile, mode, deliveryScope: "HISTORICAL", historyRequestId },
            symbol: view.symbol,
            assetClass: view.assetClass,
          }));
        }
      };
      const canOffload = volumeProfileCache && typeof storageReader.dbPath === "string" && typeof volumeProfileCache.dbPath === "string";
      if (canOffload) {
        jobOwner.cancel(profileHistoryJobsByClient.get(client));
        const job = jobOwner.launch(() => startVolumeProfileHistoryJob({
          provider: "DXFEED",
          storageDbPath: storageReader.dbPath,
          cacheDbPath: volumeProfileCache.dbPath,
          symbol: view.symbol,
          assetClass: view.assetClass,
          instrument: historyInstrumentKey(view.symbol, view.assetClass),
          tickSize,
          ranges,
          periodMs: ranges[0]?.rangeEndTs - ranges[0]?.rangeStartTs,
          binSizeMultiplier,
          nowMs: now(),
        }));
        profileHistoryJobsByClient.set(client, job);
        job.promise.then((built) => {
          if (profileHistoryJobsByClient.get(client) !== job) return;
          profileHistoryJobsByClient.delete(client);
          sendBuilt(built);
        }).catch((error) => {
          if (profileHistoryJobsByClient.get(client) !== job) return;
          profileHistoryJobsByClient.delete(client);
          console.error("dxfeed eager market data server: historical profile worker failed", error?.message ?? error);
        });
        return;
      }
      if (volumeProfileCache) {
        Promise.resolve(buildHistoricalProfiles({
          cache: volumeProfileCache,
          adapter,
          instrument: historyInstrumentKey(view.symbol, view.assetClass),
          tickSize,
          ranges,
          periodMs: ranges[0]?.rangeEndTs - ranges[0]?.rangeStartTs,
          binSizeMultiplier,
          nowMs: now(),
        })).then((built) => {
          if (built === null) return;
          sendBuilt(built);
        }).catch((error) => {
          console.error("dxfeed eager market data server: profile_history request failed", { symbol: view.symbol, reason: error?.message ?? error });
        });
        return;
      }
      Promise.all(ranges.map((range) => buildRangeProfileFrame(view, adapter, tickSize, range.rangeStartTs, range.rangeEndTs, binSizeMultiplier, {
        mode,
        deliveryScope: "HISTORICAL",
        historyRequestId,
      }))).then((frames) => {
        for (const frame of frames) {
          if (!clients.has(client) || currentView() !== view) return;
          if (frame === null) continue;
          safelySend(client, frame);
        }
      }).catch((error) => {
        console.error("dxfeed eager market data server: profile_history request failed", { symbol: view.symbol, reason: error?.message ?? error });
      });
    } catch (error) {
      console.error("dxfeed eager market data server: profile_history request failed", { symbol: view.symbol, reason: error?.message ?? error });
    }
  }

  function handleProfileHistoryMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (keys.length !== PROFILE_HISTORY_KEYS.length || !keys.every((key, index) => key === PROFILE_HISTORY_KEYS[index])) {
      console.warn("dxfeed eager market data server: dropped profile_history request with unexpected fields");
      return;
    }
    if (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0) {
      console.warn("dxfeed eager market data server: dropped profile_history request with an invalid period");
      return;
    }
    if ((parsed.mode !== "continuous" && parsed.mode !== "per_candle") || !Number.isSafeInteger(parsed.request_id) || parsed.request_id <= 0) {
      console.warn("dxfeed eager market data server: dropped profile_history request with invalid mode or request id");
      return;
    }
    if (!isValidBinSizeMultiplier(parsed.bin_size_multiplier)) {
      console.warn("dxfeed eager market data server: dropped profile_history request with an invalid bin-size multiplier");
      return;
    }
    const ranges = parseHistoryRanges(parsed.ranges, parsed.period_ms);
    if (ranges === null) {
      console.warn("dxfeed eager market data server: dropped profile_history request with invalid ranges");
      return;
    }
    const view = currentView();
    if (!view) return;
    sendHistoricalProfiles(client, view, ranges, parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER, parsed.mode, parsed.request_id);
  }

  function handleProfileConfigMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (keys.length !== PROFILE_CONFIG_KEYS.length || !keys.every((key, index) => key === PROFILE_CONFIG_KEYS[index])) {
      console.warn("dxfeed eager market data server: dropped profile_config request with unexpected fields");
      return;
    }
    if (!PROFILE_CONFIG_MODES.has(parsed.mode)) {
      console.warn("dxfeed eager market data server: dropped profile_config request with an unrecognized mode");
      return;
    }
    if (
      (parsed.period_ms !== null && (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0)) ||
      !isValidBinSizeMultiplier(parsed.bin_size_multiplier)
    ) {
      console.warn("dxfeed eager market data server: dropped profile_config request with invalid field values");
      return;
    }
    const view = currentView();
    if (parsed.mode === "fixed_range") {
      if (
        !Number.isSafeInteger(parsed.range_start_ts) || parsed.range_start_ts < 0 ||
        !Number.isSafeInteger(parsed.range_end_ts) || parsed.range_end_ts <= parsed.range_start_ts
      ) {
        console.warn("dxfeed eager market data server: dropped fixed_range profile_config request with an invalid range");
        return;
      }
      if (!view) return;
      sendFixedRangeProfile(client, view, parsed.range_start_ts, parsed.range_end_ts, parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER).catch((error) => {
        console.error("dxfeed eager market data server: fixed_range profile request failed", { symbol: view.symbol, reason: error?.message ?? error });
      });
      return;
    }
    if (parsed.range_start_ts !== null || parsed.range_end_ts !== null) {
      console.warn("dxfeed eager market data server: dropped profile_config request with a range on a non-fixed_range mode");
      return;
    }
    if (!view) return;
    view.requestedProfileConfig = parsed;
    if (!view.volumeProfile) return;
    const state = view.volumeProfile;
    const base = state.pendingConfig ?? state;
    const nextPeriodMs = parsed.period_ms !== null ? parsed.period_ms : base.periodMs;
    const nextBinSizeMultiplier = parsed.bin_size_multiplier !== null ? parsed.bin_size_multiplier : base.binSizeMultiplier;
    const gridChanged = nextPeriodMs !== base.periodMs ||
      nextBinSizeMultiplier !== base.binSizeMultiplier ||
      parsed.mode !== base.mode;
    if (!gridChanged) return;
    const configGeneration = (state.configGeneration ?? 0) + 1;
    state.configGeneration = configGeneration;
    const pendingConfig = { mode: parsed.mode, periodMs: nextPeriodMs, binSizeMultiplier: nextBinSizeMultiplier };
    state.pendingConfig = pendingConfig;
    setAnalyticsStatus(view, "PROFILE", "WARMING");
    buildAlignedSession(state.adapter, state.tickSize, nextPeriodMs, nextBinSizeMultiplier, now())
      .then((rebuilt) => {
        if (view.volumeProfile === state && state.configGeneration === configGeneration) {
          if (rebuilt === null) {
            state.pendingConfig = null;
            state.rebuildDeferred = true;
            const policy = view.profilePollPolicy ??= createProfilePollPolicy({ now });
            policy.settle("EMPTY");
            setAnalyticsStatus(view, "PROFILE", policy.status);
            return;
          }
          state.mode = pendingConfig.mode;
          state.periodMs = pendingConfig.periodMs;
          state.binSizeMultiplier = pendingConfig.binSizeMultiplier;
          state.session = rebuilt;
          state.pendingConfig = null;
          state.rebuildDeferred = false;
        }
      })
      .catch((error) => {
        if (view.volumeProfile !== state || state.configGeneration !== configGeneration) return;
        state.pendingConfig = null;
        state.rebuildDeferred = true;
        const policy = view.profilePollPolicy ??= createProfilePollPolicy({ now });
        if (policy.fail(error)) console.warn("dxfeed eager market data server: volume profile rebuild deferred", { symbol: view.symbol, reason: error?.message ?? error });
        setAnalyticsStatus(view, "PROFILE", policy.status);
      });
  }

  function clearQuietTimer(view) {
    if (!view) return;
    if (view.quietTimer) {
      clearTimeout(view.quietTimer);
      view.quietTimer = null;
    }
  }

  function scheduleQuietTimer(view) {
    clearQuietTimer(view);
    view.quietTimer = setTimeout(() => markQuiet(view), QUIET_THRESHOLD_MS);
    view.quietTimer.unref?.();
  }

  function markQuiet(view) {
    view.quietTimer = null;
    if (view.printsQuiet || view.healthFrame?.recoveryState === "UNAVAILABLE") return;
    view.printsQuiet = true;
    const healthFrame = dxfeedHealthFrame(view.symbol, view.assetClass, {
      stale: view.healthFrame?.stale ?? true,
      recoveryState: view.healthFrame?.recoveryState ?? "RECOVERING",
      printsQuiet: true,
    });
    view.healthFrame = healthFrame;
    if (currentKey === instrumentKey(view.symbol, view.assetClass)) broadcast(healthFrame);
  }

  function isSelectedView(view) {
    return currentKey === instrumentKey(view.symbol, view.assetClass);
  }

  function clearBookQuietTimer(view) {
    if (!view) return;
    if (view.bookQuietTimer) {
      clearTimeout(view.bookQuietTimer);
      view.bookQuietTimer = null;
    }
  }

  function clearBookBroadcastTimer(view) {
    if (!view || !view.bookBroadcastTimer) return;
    clearTimeout(view.bookBroadcastTimer);
    view.bookBroadcastTimer = null;
  }

  function isBookStale(view) {
    return view.bookStale === true || (view.assetClass === ASSET_CLASSES.EQUITY && classifyDxFeedSession(view.assetClass, now()) === "CLOSED");
  }

  function scheduleBookQuietTimer(view) {
    clearBookQuietTimer(view);
    view.bookQuietTimer = setTimeout(() => markBookStale(view), BOOK_QUIET_THRESHOLD_MS);
    view.bookQuietTimer.unref?.();
  }

  function translateBookStatus(state) {
    if (!state) return state;
    if (state.status === "BUFFERING") return { status: "UNAVAILABLE", reason: "BUFFERING_SNAPSHOT" };
    return state;
  }

  function bookFingerprint(state, stale) {
    if (!state) return null;
    if (state.status !== "READY") return `UNAVAILABLE:${state.reason}`;
    return `READY:${state.book.lastUpdateId}:${stale}`;
  }

  function notifyBookStatusChange(view, state) {
    const previousStatus = view.lastBookStatus;
    const newStatus = state.status === "READY" ? "READY" : state.reason;
    if (previousStatus !== null && previousStatus !== newStatus) {
      if (newStatus === "READY") {
        emitTelemetry(telemetry, "market_data.dxfeed_book_assembler.recovery_succeeded", {
          symbol: view.symbol, assetClass: view.assetClass,
        });
      } else {
        emitTelemetry(telemetry, "market_data.dxfeed_book_assembler.unavailable", {
          symbol: view.symbol, assetClass: view.assetClass, reason: newStatus, previousStatus,
        });
      }
    }
    view.lastBookStatus = newStatus;
  }

  function emitBook(view, rawState) {
    const state = translateBookStatus(rawState);
    if (!state) return;
    notifyBookStatusChange(view, state);
    const stale = isBookStale(view);
    view.bookFingerprint = bookFingerprint(state, stale);
    const frame = dxfeedBookFrame(view.symbol, view.assetClass, state, undefined, { stale });
    view.bookFrame = frame;
    if (isSelectedView(view)) {
      broadcast(frame);
      view.lastBookBroadcastMs = now();
    }
  }

  function bookStatusKey(fingerprint) {
    if (fingerprint === null) return null;
    return fingerprint.startsWith("READY:") ? `READY:${fingerprint.endsWith(":true")}` : fingerprint;
  }

  function broadcastCoalescedBook(view) {
    view.bookBroadcastTimer = null;
    try {
      const rawState = view.bookAssembler.getTopOfBook(BOOK_FRAME_DEPTH);
      const state = translateBookStatus(rawState);
      if (bookFingerprint(state, isBookStale(view)) !== view.bookFingerprint) emitBook(view, rawState);
    } catch (error) {
      console.error("dxfeed eager market data server: failed to broadcast a coalesced book", error?.message ?? error);
    }
  }

  function ensureBookFrame(view) {
    if (view.bookFrame) return view.bookFrame;
    if (view.bookFingerprint === null) return null;
    const state = translateBookStatus(view.bookAssembler.getTopOfBook(BOOK_FRAME_DEPTH));
    if (!state) return null;
    const stale = isBookStale(view);
    view.bookFingerprint = bookFingerprint(state, stale);
    view.bookFrame = dxfeedBookFrame(view.symbol, view.assetClass, state, undefined, { stale });
    return view.bookFrame;
  }

  function checkBookAndMaybeBroadcast(view) {
    const status = translateBookStatus(view.bookAssembler.getStatus());
    const stale = isBookStale(view);
    const fingerprint = status.status === "READY" ? `READY:${view.bookAssembler.getVersion()}:${stale}` : `UNAVAILABLE:${status.reason}`;
    if (fingerprint === view.bookFingerprint) return;
    if (!isSelectedView(view)) {
      notifyBookStatusChange(view, status);
      view.bookFingerprint = fingerprint;
      view.bookFrame = null;
      return;
    }
    const rawState = view.bookAssembler.getTopOfBook(BOOK_FRAME_DEPTH);
    const statusChanged = bookStatusKey(fingerprint) !== bookStatusKey(view.bookFingerprint);
    const since = now() - view.lastBookBroadcastMs;
    if (statusChanged || bookBroadcastMinIntervalMs === 0 || since >= bookBroadcastMinIntervalMs) {
      clearBookBroadcastTimer(view);
      emitBook(view, rawState);
      return;
    }
    if (view.bookBroadcastTimer) return; // the latest state will go out when the interval ends
    view.bookBroadcastTimer = setTimeout(() => broadcastCoalescedBook(view), Math.max(1, bookBroadcastMinIntervalMs - since));
    view.bookBroadcastTimer.unref?.();
  }

  function markBookStale(view) {
    view.bookQuietTimer = null;
    if (view.bookStale) return;
    view.bookStale = true;
    try {
      checkBookAndMaybeBroadcast(view);
    } catch (error) {
      console.error("dxfeed eager market data server: failed to broadcast a stale book transition", error?.message ?? error);
    }
  }

  function resetViews() {
    analyticsStatus.clear();
    barAggregator = createBarAggregator();
    liquidityMemory.markUnavailable();
    currentKey = null;
    warmViewLru.clear();
    for (const view of views.values()) {
      view.recentTrades = [];
      view.recentTradeIds = new Set();
      view.markerHistory = createHistoryBuffer({
        maxMarkers: RECENT_MARKER_LIMIT,
        markerBucketMs: MARKER_COVERAGE_BUCKET_MS,
        maxMarkersPerBucketSide: MARKER_MAX_PER_BUCKET_SIDE,
      });
      view.recentBars = [];
      view.barHistory = undefined;
      view.barsWarmupInFlight = false;
      view.barsWarmupRetryNotBeforeMs = 0;
      view.healthFrame = null;
      view.printsQuiet = false;
      clearQuietTimer(view);
      view.bookAssembler = createDxFeedOrderBookAssembler({
        expectedSymbol: view.symbol,
        expectedAssetClass: view.assetClass,
        expectedSource: view.orderSource,
        crossedGraceMs: bookCrossedGraceMs,
        now,
        onApplied: icebergTapFor(view),
      });
      view.bookFrame = null;
      view.bookFingerprint = null;
      view.bookStale = false;
      view.lastBookStatus = null;
      clearBookQuietTimer(view);
      clearBookBroadcastTimer(view);
      view.volumeProfile = null;
      view.vpinSession = null;
      jobOwner.cancel(view.vpinLiveJob);
      view.vpinLiveJob = null;
      view.vpinLiveUnavailable = false;
      jobOwner.cancel(view.vpinWarmupJob);
      view.vpinWarmupJob = null;
      view.vpinWarmupState = "IDLE";
      view.vpinWarmupRetryNotBeforeMs = 0;
      view.historyWarmupStarted = false;
      vpinWarmupRetry.forget(`${view.assetClass}:${view.symbol}`);
    }
  }

  function closeChannels(activeSession) {
    for (const group of activeSession.groups) {
      if (!group.channel) continue;
      function attempt(operation) {
        try {
          operation();
        } catch (error) {
          console.error("dxfeed eager market data server: channel cleanup step failed", {
            reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
          });
        }
      }
      if (group.onMessage) attempt(() => group.channel.removeMessageListener(group.onMessage));
      if (group.onChannelError) attempt(() => group.channel.removeErrorListener?.(group.onChannelError));
      if (group.entries.length > 0) {
        attempt(() => group.channel.send({ type: "FEED_SUBSCRIPTION", remove: group.entries }));
      }
      attempt(() => group.channel.close());
    }
  }

  function publishRecoveryState(reason, recoveryState) {
    for (const view of views.values()) {
      const frame = dxfeedHealthFrame(view.symbol, view.assetClass, { stale: true, recoveryState }, reason);
      view.healthFrame = frame;
      if (currentKey === instrumentKey(view.symbol, view.assetClass)) broadcast(frame);
    }
  }

  function publishBookUnavailable(reason) {
    liquidityMemory.markUnavailable();
    for (const view of views.values()) {
      if (!view.bookAssembler.needsSnapshot()) endIcebergLives(view);
      try {
        if (reason === "ORDER_CAPTURE_ERROR") {
          view.bookAssembler.invalidate(reason);
        }
        emitBook(view, reason === "ORDER_CAPTURE_ERROR" ? view.bookAssembler.getTopOfBook(BOOK_FRAME_DEPTH) : { status: "UNAVAILABLE", reason });
      } catch (error) {
        console.error("dxfeed eager market data server: failed to broadcast a session-end book transition", {
          symbol: view.symbol,
          reason: error?.message ?? error,
        });
      }
    }
  }

  function endSession(reasonForClients, activeSession = session, recoveryState = "UNAVAILABLE") {
    clearBookResubscribes(activeSession);
    if (!activeSession || activeSession.settled) return;
    activeSession.settled = true;
    activeSession.pendingFeedItems.clear();
    activeSession.tokenAbortController?.abort();
    if (session === activeSession) {
      session = null;
      currentOrderChannelId = null;
    }
    activeSession.resolveAbortPromise();

    if (activeSession.deadlineTimer) clearTimeout(activeSession.deadlineTimer);
    activeSession.deadlineTimer = null;
    if (activeSession.orderRecoveryTimer) clearTimeout(activeSession.orderRecoveryTimer);
    activeSession.orderRecoveryTimer = null;
    for (const view of views.values()) {
      clearQuietTimer(view);
      clearBookQuietTimer(view);
      clearBookBroadcastTimer(view);
    }
    for (const [name, cleanup] of [
      ["connection error listener", activeSession.unsubscribeConnectionError],
      ["connection state listener", activeSession.unsubscribeConnectionDrop],
    ]) {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`dxfeed eager market data server: ${name} cleanup failed`, {
          reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
        });
      }
    }
    closeChannels(activeSession);
    try {
      activeSession.connection?.disconnect();
    } catch (error) {
      console.error("dxfeed eager market data server: disconnect failed", {
        reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
      });
    }
    if (reasonForClients) {
      try {
        publishRecoveryState(reasonForClients, recoveryState);
      } catch (error) {
        console.error("dxfeed eager market data server: failed to broadcast a session-end health transition", error?.message ?? error);
      }
      publishBookUnavailable(reasonForClients);
    }
  }

  function clearSessionRestart() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function scheduleSessionRestart() {
    if (stopped || restartTimer || typeof brokerUrl !== "string" || brokerUrl.trim().length === 0) return;
    if (restartAttempt >= sessionRetryMaxAttempts) return;
    restartAttempt += 1;
    const delayMs = Math.min(sessionRetryBaseMs * 2 ** (restartAttempt - 1), MAX_SESSION_RESTART_BACKOFF_MS);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped || isActive()) return;
      launchEagerSession({ warmUp: false });
    }, delayMs);
    restartTimer.unref?.();
  }

  function handleSessionFailure(reason, activeSession) {
    endSession(reason, activeSession);
    scheduleSessionRestart();
  }

  function launchEagerSession(options) {
    const expectedAttempt = latestAttempt + 1;
    startEagerSession(options).then((startup) => {
      if (stopped || latestAttempt !== expectedAttempt) return;
      if (!session?.streaming && startup?.retryable !== false) scheduleSessionRestart();
    }).catch((error) => {
      console.error("dxfeed eager market data server: failed to start the eager session", error?.message ?? error);
      if (latestAttempt !== expectedAttempt) return;
      try {
        endSession(SESSION_START_FAILED_REASON, session);
      } catch (cleanupError) {
        console.error("dxfeed eager market data server: failed to clean up a rejected session start", cleanupError?.message ?? cleanupError);
      }
      scheduleSessionRestart();
    });
  }

  function rotateEagerSession(activeSession) {
    if (activeSession.settled || stopped || session !== activeSession) return;
    console.info("dxfeed eager market data server: planned token rotation deadline reached; starting a replacement session");
    endSession(PLANNED_TOKEN_ROTATION_REASON, activeSession, "RECOVERING");
    if (stopped) return;
    launchEagerSession({ warmUp: false });
  }

  function requestBookResubscribe(view, activeSession) {
    if (!activeSession || activeSession.settled) return;
    const at = now();
    const group = (activeSession.groups ?? []).find((candidate) => candidate.contract === ORDER_CHANNEL_CONTRACT && candidate.channel);
    const entry = group?.entries.find((candidate) => candidate.type === "Order" && candidate.symbol === view.symbol);
    if (!group || !entry) return;
    const channel = group.channel;
    const state = activeSession.resubscribeByChannel ?? (activeSession.resubscribeByChannel = new Map());
    const record = state.get(channel) ?? { lastMs: 0, intervalMs: BOOK_RESUBSCRIBE_MIN_INTERVAL_MS, timers: new Set() };
    if (at - record.lastMs >= BOOK_RESUBSCRIBE_CALM_MS) record.intervalMs = BOOK_RESUBSCRIBE_MIN_INTERVAL_MS;
    if (at - record.lastMs < record.intervalMs) return;
    record.lastMs = at;
    state.set(channel, record);
    view.lastBookResubscribeMs = at;
    try {
      channel.send({ type: "FEED_SUBSCRIPTION", remove: [entry] });
      const timer = setTimeout(() => {
        record.timers.delete(timer);
        if (activeSession.settled) return;
        try {
          channel.send({ type: "FEED_SUBSCRIPTION", add: [entry] });
        } catch (error) {
          console.error("dxfeed eager market data server: failed to re-add a crossed book's subscription", error?.message ?? error);
        }
      }, BOOK_RESUBSCRIBE_GAP_MS);
      timer.unref?.();
      record.timers.add(timer);
      emitTelemetry(telemetry, "market_data.dxfeed_book_assembler.resubscribed", {
        symbol: view.symbol, assetClass: view.assetClass, reason: "CROSSED_BOOK", nextNoSoonerThanMs: record.intervalMs,
      });
      record.intervalMs = Math.min(BOOK_RESUBSCRIBE_MAX_INTERVAL_MS, record.intervalMs * 2);
    } catch (error) {
      console.error("dxfeed eager market data server: failed to resubscribe a crossed book", error?.message ?? error);
    }
  }

  function clearBookResubscribes(activeSession) {
    for (const record of activeSession?.resubscribeByChannel?.values() ?? []) {
      for (const timer of record.timers) clearTimeout(timer);
      record.timers.clear();
    }
  }

  async function startEagerSession({ warmUp = true } = {}) {
    const attempt = ++latestAttempt;
    void warmUp;

    let resolveAbortPromise;
    const abortPromise = new Promise((resolve) => {
      resolveAbortPromise = resolve;
    });
    const activeSession = {
      settled: false,
      streaming: false,
      seedPendingKeys: storageReader && typeof storageReader.readTradesSince === "function" && now() % 60_000 !== 0
        ? new Set(views.keys()) : new Set(),
      pendingFeedItems: new Map(),
      groups: [],
      capture: null,
      unsubscribeConnectionError: null,
      unsubscribeConnectionDrop: null,
      deadlineTimer: null,
      tokenAbortController: new AbortController(),
      orderRecoveryTimer: null,
      connection: null,
      secrets: [],
      resolveAbortPromise,
      abortPromise,
    };
    session = activeSession;

    if (typeof brokerUrl !== "string" || brokerUrl.trim().length === 0) {
      console.error("dxfeed eager market data server: missing token broker URL, refusing to start a dxFeed session");
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return { retryable: false };
    }

    let token;
    let expiresAt;
    try {
      ({ token, expiresAt } = await requestToken({ brokerUrl, signal: activeSession.tokenAbortController.signal }));
    } catch (error) {
      if (attempt !== latestAttempt || activeSession.settled || stopped) return;
      console.error("dxfeed eager market data server: failed to obtain a dxFeed token", error?.message ?? error);
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return { retryable: isRetryableTokenBrokerError(error) };
    }
    if (attempt !== latestAttempt || activeSession.settled || stopped) return;

    const sessionNowMs = now();
    const resolved = resolveShutdownDeadline(expiresAt, sessionNowMs);
    if (!resolved.ok) {
      console.error("dxfeed eager market data server: refusing to start a session with no real self-termination runway", {
        reason: resolved.reason,
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return { retryable: false };
    }

    activeSession.secrets.push(token);
    const secrets = activeSession.secrets;

    activeSession.deadlineTimer = setTimeout(() => {
      rotateEagerSession(activeSession);
    }, resolved.shutdownDeadlineMs - sessionNowMs);
    activeSession.deadlineTimer.unref?.();

    const capture = createOrderV2Capture({
      resolveOrderContext: (eventSymbol) => {
        const key = keyByEventSymbol.get(eventSymbol);
        if (!key) return null;
        const plan = wirePlans.get(key);
        return plan ? { assetClass: plan.assetClass, symbol: plan.symbol } : null;
      },
      onEnvelope: (envelope) => {
        if (activeSession.settled) return;
        const key = keyByEventSymbol.get(envelope.providerSymbol);
        if (!key) return;
        const view = views.get(key);
        const hadBook = !view.bookAssembler.needsSnapshot();
        const applied = view.bookAssembler.applyEventStatus(envelope);
        if (hadBook && view.bookAssembler.needsSnapshot()) endIcebergLives(view);
        if (applied.status === "UNAVAILABLE" && applied.reason === "CROSSED_BOOK" && view.bookAssembler.needsSnapshot()) {
          requestBookResubscribe(view, activeSession);
        }
        liquidityMemory.noteBook(view.assetClass, view.symbol, view.bookAssembler, Date.parse(envelope.eventTime));
        view.bookStale = false;
        scheduleBookQuietTimer(view);
        checkBookAndMaybeBroadcast(view);
      },
      onCaptureError: (error) => {
        emitTelemetry(telemetry, "market_data.dxfeed_order_v2_capture.correlation_failed", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
          code: error?.code ?? null,
          eventSymbols: Array.isArray(error?.eventSymbols) ? error.eventSymbols : [],
          channelId: currentOrderChannelId,
        });
        if (!activeSession.settled) publishBookUnavailable("ORDER_CAPTURE_ERROR");
        void reopenSharedOrderChannel();
      },
      now,
    });
    activeSession.capture = capture;

    let connection;
    try {
      connection = createConnection(
        { endpoint: REALTIME_ENDPOINT, marketDataMode: "realtime", tempToken: token },
        { createConnector: capture.createConnector },
      );
    } catch (error) {
      console.error("dxfeed eager market data server: failed to initialize dxFeed connection", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return;
    }
    activeSession.connection = connection;

    try {
      activeSession.unsubscribeConnectionError = connection.onError((error) => {
        if (activeSession.settled) return;
        console.error("dxfeed eager market data server: connection error", {
          reason: redactSecrets(typeof error?.message === "string" ? error.message : "dxLink error", secrets),
        });
        if (error?.type === "AUTH") {
          restartAttempt = sessionRetryMaxAttempts; // a rejected token is not going to work on the next try
          endSession(SESSION_ENDED_REASON, activeSession);
          return;
        }
        handleSessionFailure(SESSION_ENDED_REASON, activeSession);
      });
      activeSession.unsubscribeConnectionDrop = connection.onConnectionStateChange(({ state, prev }) => {
        if (activeSession.settled) return;
        if (state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
          handleSessionFailure(SESSION_ENDED_REASON, activeSession);
        }
      });
      if (
        typeof activeSession.unsubscribeConnectionError !== "function" ||
        typeof activeSession.unsubscribeConnectionDrop !== "function"
      ) {
        throw new Error("connection lifecycle registration did not return cleanup functions");
      }
    } catch (error) {
      console.error("dxfeed eager market data server: failed to attach connection lifecycle listeners", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return;
    }

    const groupsByContract = new Map();
    function groupFor(contract) {
      let group = groupsByContract.get(contract);
      if (!group) {
        group = {
          contract,
          entries: [],
          keys: [],
          channel: null,
          onMessage: null,
          onChannelError: null,
        };
        groupsByContract.set(contract, group);
      }
      return group;
    }
    for (const plan of wirePlans.values()) {
      const group = groupFor(plan.contract);
      group.entries.push({ symbol: plan.symbol, type: plan.wireEventType });
      group.keys.push(plan.key);
    }
    for (const plan of wirePlans.values()) {
      const orderGroup = groupFor(ORDER_CHANNEL_CONTRACT);
      orderGroup.entries.push({ symbol: plan.symbol, type: "Order", source: plan.orderSource });
      orderGroup.keys.push(plan.key);
    }
    activeSession.groups = [...groupsByContract.values()];

    try {
      connection.connect();
      const authorized = await waitForAuthorized({ connection, timeoutMs: AUTH_TIMEOUT_MS, abortPromise });
      if (!authorized || activeSession.settled) return;
      for (const group of activeSession.groups) {
        const channel = connection.openChannel("FEED", { contract: group.contract });
        group.channel = channel;
        const opened = await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
        if (!opened || activeSession.settled) return;
        channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
        if (activeSession.settled) return;
        if (group.contract === ORDER_CHANNEL_CONTRACT) {
          try {
            capture.setChannelId(channel.id);
            currentOrderChannelId = channel.id;
          } catch (error) {
            console.error("dxfeed eager market data server: failed to register the order channel id -- book unavailable for this session, other market data unaffected", {
              reason: redactSecrets(String(error?.message ?? error), secrets),
            });
            publishBookUnavailable("ORDER_CHANNEL_SETUP_FAILED");
          }
        }
      }
    } catch (error) {
      if (activeSession.settled) return;
      console.error("dxfeed eager market data server: failed to establish a FEED channel", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_ENDED_REASON, activeSession);
      return;
    }

    function handleFeedItem(item) {
      if (activeSession.settled) return;
      const key = keyByEventSymbol.get(item?.eventSymbol);
      if (!key) return;
      const wirePlan = wirePlans.get(key);
      if (item?.eventType !== wirePlan.wireEventType) return;
      if (activeSession.seedPendingKeys.has(key)) {
        const pending = activeSession.pendingFeedItems.get(key) ?? [];
        if (pending.length >= OPEN_MINUTE_SEED_PENDING_LIMIT) {
          console.error("dxfeed eager market data server: open-minute seed feed buffer exceeded its limit", { symbol: wirePlan.symbol });
          handleSessionFailure(SESSION_ENDED_REASON, activeSession);
          return;
        }
        pending.push(item);
        activeSession.pendingFeedItems.set(key, pending);
        return;
      }
      const view = views.get(key);
      const isSelected = currentKey === key;
      try {
        const envelope = normalizeDxFeedEvent(
          { assetClass: wirePlan.assetClass, symbol: wirePlan.symbol, eventType: wirePlan.eventType, raw: item },
          { receivedAtMs: now() },
        );
        if (envelope.state === "UNAVAILABLE") return;
        const barTrade = wirePlan.adaptForBar(envelope, item);
        const barEligibility = classifyDxFeedTimeAndSaleForBar(item, { requireValidTick: true });
        dataQuality.record({ symbol: wirePlan.symbol, assetClass: wirePlan.assetClass, reason: barEligibility, item });
        if (barEligibility === BAR_ELIGIBILITY_REASONS.ACCEPTED) {
          const { closedBar, liveBar, dropped } = barAggregator.ingest({ ...barTrade, nowMs: now() });
          if (dropped) return;
          if (closedBar) {
            const closedFrame = dxfeedBarFrame({
              symbol: wirePlan.symbol, assetClass: wirePlan.assetClass, tsOpen: closedBar.ts_open,
              open: closedBar.open, high: closedBar.high, low: closedBar.low, close: closedBar.close,
              volume: closedBar.volume, buyVolume: closedBar.buy_volume, sellVolume: closedBar.sell_volume, tradeCount: closedBar.trade_count,
              closed: true,
            });
            rememberBar(view, closedFrame);
            if (isSelected) broadcast(closedFrame);
          }
          const liveFrame = dxfeedBarFrame({
            symbol: wirePlan.symbol, assetClass: wirePlan.assetClass, tsOpen: liveBar.ts_open,
            open: liveBar.open, high: liveBar.high, low: liveBar.low, close: liveBar.close,
            volume: liveBar.volume, buyVolume: liveBar.buy_volume, sellVolume: liveBar.sell_volume, tradeCount: liveBar.trade_count,
            closed: false,
          });
          if (isSelected) broadcast(liveFrame);
        }
        const tapeWorthy = item?.type === "NEW"
          && (wirePlan.assetClass === ASSET_CLASSES.EQUITY || item?.validTick === true);
        if (!tapeWorthy) return;
        const auction = isEquityAuctionPrint(wirePlan.assetClass, item);
        if (!auction && barTrade.side !== null && barEligibility === BAR_ELIGIBILITY_REASONS.ACCEPTED) {
          liquidityMemory.onTrade(wirePlan.assetClass, wirePlan.symbol, { ts: barTrade.tsExchange, price: barTrade.price, size: barTrade.size, side: barTrade.side, tradeId: barTrade.tradeId });
          (view.aggressivePool ??= createAggressivePool({ now })).record(dxfeedTradeFrame(barTrade));
        }
        const wasQuiet = view.printsQuiet === true;
        view.printsQuiet = false;
        scheduleQuietTimer(view);
        if (view.healthFrame?.recoveryState !== "READY" || wasQuiet) {
          const healthFrame = dxfeedHealthFrame(wirePlan.symbol, wirePlan.assetClass, { stale: false, recoveryState: "READY", printsQuiet: false });
          view.healthFrame = healthFrame;
          if (isSelected) broadcast(healthFrame);
        }
        if (barTrade.side === null) return;
        const adaptedTrade = wirePlan.adapt(envelope, item);
        const frame = dxfeedTradeFrame({ ...adaptedTrade, auction });
        if (rememberTrade(view, frame) && isSelected) broadcast(frame);
        if (!auction && view.markerHistory.wouldRetainMarker(
          frame.ts_exchange, frame.side, dxFeedTradeMagnitude(wirePlan.assetClass, adaptedTrade),
        )) {
          const marker = dxfeedMarkerFrame(adaptedTrade);
          if (rememberMarker(view, marker) && isSelected) broadcast(marker);
        }
      } catch (error) {
        console.error("dxfeed eager market data server: failed to normalize or adapt a live trade", {
          symbol: wirePlan.symbol,
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
          if (error?.code === "DXFEED_BAR_CAPACITY_EXCEEDED") {
            restartAttempt = sessionRetryMaxAttempts;
            endSession(error.code, activeSession);
          }
      }
    }

    function wireGroupListeners(group) {
      group.onMessage = (message) => {
        if (message?.type !== "FEED_DATA" || !Array.isArray(message.data) || activeSession.settled) return;
        for (const item of message.data) handleFeedItem(item);
        if (activeSession.settled) return;
        if (group.contract === ORDER_CHANNEL_CONTRACT) {
          try {
            capture.handleChannelMessage(message);
          } catch (error) {
            console.error("dxfeed eager market data server: failed to process a live order-book message", {
              reason: redactSecrets(String(error?.message ?? error), secrets),
            });
          }
        }
      };
      group.onChannelError = (error) => {
        if (activeSession.settled) return;
        console.error("dxfeed eager market data server: FEED channel error", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
        handleSessionFailure(SESSION_ENDED_REASON, activeSession);
      };
      group.channel.addMessageListener(group.onMessage);
      group.channel.addErrorListener?.(group.onChannelError);
      group.channel.send({ type: "FEED_SUBSCRIPTION", add: group.entries });
    }
    activeSession.wireGroupListeners = wireGroupListeners;

    try {
      for (const group of activeSession.groups) {
        wireGroupListeners(group);
      }
    } catch (error) {
      if (activeSession.settled) return;
      console.error("dxfeed eager market data server: failed to subscribe", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_ENDED_REASON, activeSession);
      return;
    }

    async function reopenSharedOrderChannel() {
      if (activeSession.settled || session !== activeSession) return;
      const group = activeSession.groups.find((g) => g.contract === ORDER_CHANNEL_CONTRACT);
      if (!group) return;
      activeSession.correlationRecoveryAttempt = (activeSession.correlationRecoveryAttempt ?? 0) + 1;
      const attempt = activeSession.correlationRecoveryAttempt;
      if (attempt > MAX_CORRELATION_RECOVERY_ATTEMPTS) {
        emitTelemetry(telemetry, "market_data.dxfeed_order_v2_capture.channel_reopen_exhausted", {
          attempts: MAX_CORRELATION_RECOVERY_ATTEMPTS,
        });
        return;
      }
      const previousChannelId = currentOrderChannelId;
      if (group.channel) {
        try {
          group.channel.removeMessageListener?.(group.onMessage);
        } catch {
          void 0;
        }
        try {
          group.channel.removeErrorListener?.(group.onChannelError);
        } catch {
          void 0;
        }
        try {
          group.channel.close();
        } catch {
          void 0;
        }
      }
      group.channel = null;
      group.onMessage = null;
      group.onChannelError = null;
      emitTelemetry(telemetry, "market_data.dxfeed_order_v2_capture.channel_reopen_started", { attempt, previousChannelId });
      try {
        const channel = connection.openChannel("FEED", { contract: group.contract });
        group.channel = channel;
        const opened = await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
        if (!opened || activeSession.settled || session !== activeSession) return;
        channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
        if (activeSession.settled || session !== activeSession) return;
        capture.setChannelId(channel.id);
        currentOrderChannelId = channel.id;
        activeSession.wireGroupListeners(group);
        activeSession.correlationRecoveryAttempt = 0;
        emitTelemetry(telemetry, "market_data.dxfeed_order_v2_capture.channel_reopen_succeeded", {
          attempt, newChannelId: channel.id, previousChannelId,
        });
      } catch (error) {
        if (activeSession.settled || session !== activeSession) return;
        console.error("dxfeed eager market data server: failed to reopen the shared order channel after a correlation loss", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
        const delayMs = Math.min(sessionRetryBaseMs * 2 ** (attempt - 1), MAX_SESSION_RETRY_MS);
        if (activeSession.orderRecoveryTimer) clearTimeout(activeSession.orderRecoveryTimer);
        activeSession.orderRecoveryTimer = setTimeout(() => {
          activeSession.orderRecoveryTimer = null;
          if (!stopped && !activeSession.settled && session === activeSession) void reopenSharedOrderChannel();
        }, delayMs);
        activeSession.orderRecoveryTimer.unref?.();
      }
    }

    console.info("dxfeed eager market data server: session streaming", {
      channels: activeSession.groups.length,
      instruments: wirePlans.size,
    });
    activeSession.streaming = true;
    seedOpenMinutes(activeSession, handleFeedItem);
    warmUpView(currentView());
    restartAttempt = 0;

    for (const view of views.values()) {
      if (!view.healthFrame) view.healthFrame = dxfeedHealthFrame(view.symbol, view.assetClass, { stale: true, recoveryState: "RECOVERING" });
      if (!view.quietTimer) scheduleQuietTimer(view);
    }
  }

  function stopUnattendedWarning() {
    if (unattendedTimer === null) return;
    clearInterval(unattendedTimer);
    unattendedTimer = null;
    unattendedSinceMs = null;
  }

  function startUnattendedWarning() {
    if (stopped || unattendedTimer !== null || clients.size > 0) return;
    if (!Number.isFinite(unattendedWarnIntervalMs) || unattendedWarnIntervalMs <= 0) return;
    unattendedSinceMs = now();
    unattendedTimer = setInterval(() => {
      if (stopped || clients.size > 0 || !isActive()) return;
      console.warn(
        "dxfeed eager market data server: live dxFeed session held with zero connected clients",
        { unattendedForMs: now() - unattendedSinceMs, instruments: views.size },
      );
    }, unattendedWarnIntervalMs);
    unattendedTimer.unref?.();
  }

  function handleClientConnected(client) {
    clients.add(client);
    stopUnattendedWarning();
    const view = currentView();
    if (!view) return;
    try {
      if (!safelySend(client, dxfeedSelectionFrame(view.symbol, view.assetClass))) return;
      if (!safelySend(client, currentSnapshotFrame(view))) return;
      if (view.healthFrame) safelySend(client, view.healthFrame);
      const bookFrame = ensureBookFrame(view);
      if (bookFrame) safelySend(client, bookFrame);
      liquidityReplayer.start(client, liquidity.snapshotFrames(view.assetClass, view.symbol));
    } catch (error) {
      console.error("dxfeed eager market data server: failed to build the initial snapshot for a newly connected client -- dropping it", error?.message ?? error);
      releaseClient(client);
      closeClient(client, 1011, "Unable to initialize dxFeed market data view");
    }
  }

  function handleClientDisconnected(client) {
    releaseClient(client);
    if (clients.size === 0 && isActive()) startUnattendedWarning();
  }

  function selectInstrument(symbol, assetClass) {
    const key = instrumentKey(symbol, assetClass);
    if (currentKey === key) return;
    const view = views.get(key);
    let selection;
    let snapshot;
    try {
      selection = dxfeedSelectionFrame(symbol, assetClass);
      retainWarmView(view);
      warmUpView(view);
      snapshot = currentSnapshotFrame(view);
    } catch (error) {
      console.error("dxfeed eager market data server: failed to build a selection switch's snapshot -- retained the prior view", error?.message ?? error);
      return;
    }
    currentKey = key;
    broadcast(selection);
    broadcast(snapshot);
    if (view.healthFrame) broadcast(view.healthFrame);
    const bookFrame = ensureBookFrame(view);
    if (bookFrame) broadcast(bookFrame);
    liquidity.reset();
    const switchLiquidityFrames = liquidity.snapshotFrames(assetClass, symbol);
    for (const client of clients) liquidityReplayer.start(client, switchLiquidityFrames);
    l2Channel.reselect();
    icebergChannel.reselect();
    exhaustionChannel.reselect();
    initiativeChannel.reselect();
  }

  function handleClientMessage(raw, client) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("dxfeed eager market data server: dropped malformed (non-JSON) client message");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      console.error("dxfeed eager market data server: dropped malformed client message");
      return;
    }
    if (parsed.type === "profile_config") {
      handleProfileConfigMessage(parsed, client);
      return;
    }
    if (parsed.type === "profile_history") {
      handleProfileHistoryMessage(parsed, client);
      return;
    }
    if (parsed.type === "aggressive_history") {
      const view = currentView();
      if (view) aggressiveHistory.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "exhaustion_history") {
      const fromTs = parseExhaustionHistory(parsed);
      if (fromTs === null) {
        console.warn("dxfeed eager market data server: dropped exhaustion_history request with unexpected fields");
        return;
      }
      const view = currentView();
      if (view && exhaustionEnabled) exhaustionIndicator.requestHistory({ marketKind: view.assetClass, symbol: view.symbol }, fromTs);
      return;
    }
    if (parsed.type === "initiative_history") {
      const fromTs = parseInitiativeHistory(parsed);
      if (fromTs === null) {
        console.warn("dxfeed eager market data server: dropped initiative_history request with unexpected fields");
        return;
      }
      const view = currentView();
      if (view && initiativeEnabled) initiativeIndicator.requestHistory({ marketKind: view.assetClass, symbol: view.symbol }, fromTs);
      return;
    }
    if (parsed.type === "delta_profile") {
      const view = currentView();
      if (view) deltaProfile.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "band_history") {
      const view = currentView();
      if (view) bandHistory.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "wall_history" || parsed.type === "l2_event_history") {
      const view = currentView();
      if (view) historyRequests.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "liquidity_resync") {
      if (Object.keys(parsed).length !== 1) {
        console.warn("dxfeed eager market data server: dropped liquidity_resync request with unexpected fields");
        return;
      }
      liquidityReplayer.resync(client);
      return;
    }
    if (parsed.type === "l2_resync") {
      const channel = parseL2Resync(parsed);
      if (channel === null) {
        console.warn("dxfeed eager market data server: dropped l2_resync request with unexpected fields");
        return;
      }
      l2Channel.resync(client, channel);
      return;
    }
    if (parsed.type === "capabilities") {
      const flags = parseCapabilities(parsed);
      if (flags === null || flags.has("marker_history")) {
        console.warn("dxfeed eager market data server: dropped capabilities request with unexpected fields");
        return;
      }
      if (clients.has(client)) {
        l2Channel.subscribe(client, flags);
        icebergChannel.subscribe(client, flags);
        exhaustionChannel.subscribe(client, flags);
        initiativeChannel.subscribe(client, flags);
      }
      return;
    }
    if (parsed.type !== "select") {
      console.error("dxfeed eager market data server: dropped client message with unrecognized type", parsed.type);
      return;
    }
    const keys = Object.keys(parsed).sort();
    const expectedKeys = parsed.resume === true ? ["assetClass", "resume", "symbol", "type"] : ["assetClass", "symbol", "type"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      console.warn("dxfeed eager market data server: dropped select request with unexpected fields");
      return;
    }
    const { symbol, assetClass } = parsed;
    if (typeof symbol !== "string" || !isAllowedAssetClass(assetClass) || !isAllowedDxFeedSymbol(symbol, assetClass)) {
      console.warn("dxfeed eager market data server: dropped select request for an unproven symbol/assetClass pair");
      return;
    }
    const key = instrumentKey(symbol, assetClass);
    if (!views.has(key)) {
      console.warn("dxfeed eager market data server: dropped select request for an instrument outside the eager set");
      return;
    }
    if (currentKey === key) return;
    if (!allowSelectionRequest(client)) {
      console.error("dxfeed eager market data server: closed client that exceeded the pair-selection rate limit");
      closeClient(client, 1008, "Too many pair selection requests");
      releaseClient(client);
      return;
    }
    selectInstrument(symbol, assetClass);
  }

  function start() {
    if (!stopped) return;
    if (stopPromise) {
      if (!jobOwner.canRestart()) throw new Error("market data server: previous worker shutdown is pending or failed");
      jobOwner = createAnalyticsJobOwner();
      stopPromise = null;
    }
    stopped = false;
    restartAttempt = 0;
    startCandleFinalization();
    startVolumeProfilePolling();
    startVpinPolling();
    resetViews();
    liquidity.start({
      activePair: () => {
        const view = currentView();
        return view ? { marketKind: view.assetClass, symbol: view.symbol } : null;
      },
      pairs: () => [...views.values()].map((view) => ({ marketKind: view.assetClass, symbol: view.symbol })),
      publish: broadcast,
      publishSnapshot: (frames) => liquidityReplayer.announce(frames),
      publishL2: (out, pair) => l2Channel.publish(out, pair),
      hasClients: () => clients.size > 0,
    });
    icebergIndicator.start();
    icebergTickTimer = setInterval(() => {
      try {
        icebergIndicator.tick(now());
      } catch (error) {
        console.error("dxfeed eager market data server: iceberg tick failed", error?.message ?? error);
      }
    }, 1000);
    icebergTickTimer.unref?.();
    exhaustionIndicator.start();
    if (exhaustionEnabled) {
      exhaustionTickTimer = setInterval(() => {
        try {
          exhaustionIndicator.tick([...views.values()].map((view) => ({ marketKind: view.assetClass, symbol: view.symbol })), now());
        } catch (error) {
          console.error("dxfeed eager market data server: exhaustion tick failed", error?.message ?? error);
        }
        try {
          candleMonitor.tick([...views.values()].map((view) => ({ marketKind: view.assetClass, symbol: view.symbol })), now());
        } catch (error) {
          console.error("dxfeed eager market data server: candle monitor tick failed", error?.message ?? error);
        }
      }, 1000);
      exhaustionTickTimer.unref?.();
    }
    initiativeIndicator.start();
    if (initiativeEnabled) {
      initiativeTickTimer = setInterval(() => {
        try {
          initiativeIndicator.tick([...views.values()].map((view) => ({ marketKind: view.assetClass, symbol: view.symbol })), now());
        } catch (error) {
          console.error("dxfeed eager market data server: initiative tick failed", error?.message ?? error);
        }
      }, 1000);
      initiativeTickTimer.unref?.();
    }
    launchEagerSession();
  }

  function deactivate() {
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const errors = [];
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    stopPromise.catch(() => {});
    for (const job of profileHistoryJobsByClient.values()) jobOwner.cancel(job);
    profileHistoryJobsByClient.clear();
    stopUnattendedWarning();
    liquidityReplayer.stopAll();
    l2Channel.stopAll();
    icebergChannel.stopAll();
    if (icebergTickTimer) {
      clearInterval(icebergTickTimer);
      icebergTickTimer = null;
    }
    for (const view of views.values()) {
      if (view.bookAssembler.needsSnapshot()) continue;
      endIcebergLives(view);
    }
    try {
      icebergIndicator.stop();
    } catch (error) {
      errors.push(error);
    }
    exhaustionChannel.stopAll();
    if (exhaustionTickTimer) {
      clearInterval(exhaustionTickTimer);
      exhaustionTickTimer = null;
    }
    try {
      exhaustionIndicator.stop();
    } catch (error) {
      errors.push(error);
    }
    initiativeChannel.stopAll();
    if (initiativeTickTimer) {
      clearInterval(initiativeTickTimer);
      initiativeTickTimer = null;
    }
    try {
      initiativeIndicator.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      candleMonitor.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      liquidity.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      liquidityMemory.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      finalizeDueBars();
    } catch (error) {
      errors.push(error);
    }
    stopCandleFinalization();
    stopVolumeProfilePolling();
    stopVpinPolling();
    clearSessionRestart();
    stopped = true;
    for (const view of views.values()) {
      jobOwner.cancel(view.vpinLiveJob);
      view.vpinLiveJob = null;
      jobOwner.cancel(view.vpinWarmupJob);
      view.vpinWarmupJob = null;
    }
    latestAttempt += 1;
    try {
      endSession(null, session);
    } catch (error) {
      errors.push(error);
    }
    for (const client of clients) {
      selectionRateLimiter.forget(client);
    }
    clients.clear();
    clientSender.clear();
    aggressiveHistory.dispose();
    deltaProfile.dispose();
    bandHistory.dispose();
    historyRequests.dispose();
    currentKey = null;
    jobOwner.stop(errors).then(resolveStop, rejectStop);
    return stopPromise;
  }

  function instrumentSnapshot() {
    return [...views.values()].map((view) => {
      const bookState = view.bookAssembler.getStatus();
      const sessionState = classifyDxFeedSession(view.assetClass, now());
      const l1Recovery = view.healthFrame?.recoveryState ?? "IDLE";
      return {
        symbol: view.symbol,
        assetClass: view.assetClass,
        l1: { recoveryState: sessionState === "CLOSED" && l1Recovery === "RECOVERING" ? "CLOSED" : l1Recovery, quiet: view.printsQuiet === true },
        l2: { status: view.bookFrame?.status ?? bookState.status,
          reason: view.bookFrame ? view.bookFrame.reason ?? null : bookState.reason ?? null,
          ...((view.bookFrame?.status ?? bookState.status) === "READY" && isBookStale(view) ? { stale: true } : {}) },
        analytics: { vpin: view.vpinWarmupState,
          profile: analyticsStatus.get({ provider: "DXFEED", symbol: view.symbol, assetClass: view.assetClass }, "PROFILE") },
        dataQuality: dataQuality.snapshot(view.symbol, view.assetClass),
        retention: {
          bars: view.recentBars.length,
          trades: view.recentTrades.length,
          markers: view.markerHistory.markerCount(),
          heavyHistoryWarm: view.historyWarmupStarted === true,
        },
        session: { policy: SESSION_POLICY.mode, state: sessionState },
      };
    });
  }

  function orderV2CaptureStatus() {
    return session?.capture ? session.capture.getCorrelationStatus() : null;
  }

  function currentReadiness() {
    const instruments = instrumentSnapshot();
    const selected = currentView();
    const recovery = selected?.healthFrame?.recoveryState ?? "IDLE";
    const selectedRow = selected ? instruments.find((row) => row.symbol === selected.symbol && row.assetClass === selected.assetClass) : null;
    const marketClosed = selected != null && isActive() && recovery !== "FAILED" && !isMarketOpen(selected.assetClass, now());
    const unavailableAnalytics = instruments.filter((instrument) => instrument.analytics.vpin === "UNAVAILABLE" || instrument.analytics.profile === "UNAVAILABLE").length;
    const readyAnalytics = instruments.filter((instrument) => instrument.analytics.vpin === "READY" || instrument.analytics.profile === "READY").length;
    const selectedAnalytics = selectedRow?.analytics;
    const selectedBook = selectedRow?.l2;
    return Object.freeze({
      dimensions: Object.freeze({
        transport: marketClosed ? "CLOSED" : recovery === "RECOVERING" ? "DEGRADED" : recovery,
        capture: !isActive() || marketClosed ? "IDLE" : recovery === "READY" ? "READY" : recovery === "RECOVERING" ? "DEGRADED" : "STARTING",
        storage: !isActive() ? "IDLE" : readyAnalytics > 0 ? "READY" : unavailableAnalytics === instruments.length && instruments.length > 0 ? "UNAVAILABLE" : "RUNNING",
        analytics: !selectedAnalytics ? "IDLE"
          : selectedAnalytics.vpin === "UNAVAILABLE" || selectedAnalytics.profile === "UNAVAILABLE" ? "DEGRADED" : "READY",
        l2: !selectedRow ? "IDLE"
          : marketClosed ? "CLOSED"
            : selectedBook?.status === "READY" && selectedBook.stale !== true ? "READY"
              : selectedBook?.status === "BUFFERING" ? "STARTING" : "DEGRADED",
      }),
      marketClosed,
      instruments: Object.freeze(instruments),
    });
  }

  return Object.freeze({
    start,
    stop,
    deactivate,
    handleClientConnected,
    handleClientDisconnected,
    handleClientMessage,
    clientCount: () => clients.size,
    isActive,
    currentSymbolInfo,
    currentRecoveryState: () => currentView()?.healthFrame?.recoveryState ?? "IDLE",
    instrumentSnapshot,
    currentReadiness,
    orderV2CaptureStatus,
  });
}

module.exports = {
  createDxFeedEagerMarketDataServer,
  SESSION_ENDED_REASON,
  SESSION_START_FAILED_REASON,
  PLANNED_TOKEN_ROTATION_REASON,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  DEFAULT_CLIENT_BUFFER_GRACE_MS,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
  DEFAULT_SESSION_RETRY_BASE_MS,
  DEFAULT_SESSION_RETRY_MAX_ATTEMPTS,
  MAX_SESSION_RETRY_MS,
  MAX_SESSION_RESTART_BACKOFF_MS,
};
