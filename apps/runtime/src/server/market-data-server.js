const { createAnalyticsJobOwner } = require("../platform/analytics-job-owner");
const {
  EVENT_TYPES,
  MARKET_KINDS,
  isAllowedSymbol,
  isAllowedMarketKind,
  listAllowedSymbols,
  listAllowedMarketKinds,
} = require("../providers/binance/binance-config");
const {
  tradeEnvelopeToFrame,
  klineEnvelopeToFrame,
  restKlineRowToBarFrame,
  markerFrame,
  markerHistoryFrame,
  markerHistoryFrames,
  MAX_MARKER_HISTORY_ROWS,
  MAX_SNAPSHOT_MARKERS,
  profileFrame,
  vpinFrame,
  snapshotFrame,
  healthFrame,
  bookFailureReason,
  bookFrame,
  selectionFrame,
  fromWireSymbol,
  BOOK_DEPTH_LEVELS,
  INTERVAL_MS,
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
const { createHistoryBuffer } = require("./history");
const { MAX_ROW_LIMIT_BY_ROUTE } = require("./live-storage-route");
const {
  parseHistoryRanges: sharedParseHistoryRanges,
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
} = require("./market-data-server-shared");
const {
  MARKER_BUCKET_MS,
  MARKERS_PER_BUCKET_SIDE,
} = require("../indicators/large-trade/large-trade-detection");
const {
  createAggressivePool,
  warmAggressivePool,
  DEFAULT_READ_LIMIT: AGGRESSIVE_POOL_READ_LIMIT,
  DEFAULT_WINDOW_MS: AGGRESSIVE_POOL_DEFAULT_WINDOW_MS,
} = require("./aggressive-pool");
const { rowsToTradeFrames } = require("./aggressive-history");
const {
  createInstrumentTickSizeResolver,
} = require("../providers/shared/instrument-tick-size");
const {
  createLiveMemoryBinding,
} = require("../indicators/l2-memory/live-binding");
const {
  createLiquidityPublisher,
  liquidityOptionsFromEnv,
  DEFAULT_FILL_S,
} = require("../indicators/passive_liquidity/liquidity-publisher");
const {
  createBinanceVolumeProfileAdapter,
} = require("../indicators/volume-profile/volume-profile-adapters");
const {
  createSession: createVolumeProfileSession,
  seedSessionFromStorage,
  computeProfile,
  pollOpenPeriod,
  rescaleSessionToFit,
  DEFAULT_BIN_SIZE_MULTIPLIER,
  MIN_BIN_SIZE_MULTIPLIER,
  MAX_BIN_SIZE_MULTIPLIER,
} = require("../indicators/volume-profile/volume-profile-engine");
const {
  alignPeriodStart,
  deriveBucketingParams,
} = require("../indicators/volume-profile/volume-profile-setup");
const {
  createVolumeProfileAtrReference,
} = require("../indicators/volume-profile/volume-profile-atr");
const {
  buildHistoricalProfiles,
  ensureCoverage,
} = require("../indicators/volume-profile/volume-profile-history");
const {
  startVolumeProfileHistoryJob,
} = require("../indicators/volume-profile/volume-profile-history-job");
const {
  floorToMinute,
} = require("../indicators/volume-profile/volume-profile-cache");
const {
  createVpinSession,
  applyLivePollResult,
} = require("../indicators/vpin/vpin-session");
const { startVpinWarmup } = require("../indicators/vpin/vpin-warmup");
const { startVpinLivePoll } = require("../indicators/vpin/vpin-live-poll");
const { createOperationalReadiness } = require("./operational-readiness");

const SERVER_CONSUMER_ID = "ws-server";
const KLINE_INTERVAL = "1m";
const BACKFILL_DAYS = 7;
const WS_OPEN = 1;
const MAX_CLIENT_BUFFERED_BYTES = 24 * 1024 * 1024;
const DEFAULT_CLIENT_BUFFER_HARD_BYTES = MAX_CLIENT_BUFFERED_BYTES * 3;
const DEFAULT_CLIENT_BUFFER_GRACE_MS = 10_000;
const LIQUIDITY_STATS_LOG_MS = 60_000;
const CONTROL_PLANE_FAILURE_REASON = "SERVER_CONTROL_PLANE_FAILURE";

const DEFAULT_CONNECT_POLL_MS = 200;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 2_000;
const RECORDING_STALE_MS = 120_000;
const RECORDING_POLL_MS = 5_000;
const DEFAULT_BACKFILL_RETRY_BASE_MS = 5_000;
const MAX_BACKFILL_RETRY_MS = 300_000;
const DEFAULT_VOLUME_PROFILE_RETRY_BASE_MS = 15_000;
const MAX_VOLUME_PROFILE_RETRY_MS = 300_000;
const LARGE_TRADE_COVERAGE_BUCKET_MS = MARKER_BUCKET_MS;
const LARGE_TRADE_MAX_PER_BUCKET_SIDE = MARKERS_PER_BUCKET_SIDE;
const LARGE_TRADE_HISTORY_WINDOW_MS = BACKFILL_DAYS * 24 * 60 * 60 * 1000;
const LARGE_TRADE_QUERY_LIMIT = MAX_ROW_LIMIT_BY_ROUTE["large-trades"];
const LARGE_TRADE_WARMUP_INITIAL_WINDOW_MS = 60 * 60 * 1000;
// Production six-hour slices exceed the remote reader's bounded deadline.
// Two-hour slices preserve complete seven-day coverage with bounded payloads.
const LARGE_TRADE_WARMUP_CHUNK_MS = 2 * 60 * 60 * 1000;
const LARGE_TRADE_WARMUP_PUBLISH_EVERY_CHUNKS = 4;
const LARGE_TRADE_WARMUP_PROMPT_CHUNKS = 5;
const VOLUME_PROFILE_POLL_MS = 1_500;
const VOLUME_PROFILE_DEFAULT_PERIOD_MS = 60 * 60 * 1000;
const VOLUME_PROFILE_REFERENCE_LOOKBACK_MS = 15 * 60 * 1000;
const VOLUME_PROFILE_PREWARM_MS = 24 * 60 * 60 * 1000;
const VOLUME_PROFILE_PREWARM_CHUNK_MS = 15 * 60 * 1000;
const VOLUME_PROFILE_PREWARM_PAUSE_MS = 250;
const VPIN_POLL_MS = 1_500;
const VPIN_BACKFILL_LOOKBACK_MS = BACKFILL_DAYS * 24 * 60 * 60 * 1000;
const STORAGE_WARMUP_RETRY_MS = 15_000;
const VPIN_WARMUP_REMOTE_TIMEOUT_MS = 50_000;
const DEEP_ADMISSION_MAX_WAIT_MS = 90_000;
const DEEP_ADMISSION_POLL_MS = 1_000;

function historyInstrumentKey(symbol, marketKind) {
  return `BINANCE:${symbol}:${marketKind}`;
}
const PROFILE_CONFIG_MODES = new Set([
  "continuous",
  "per_candle",
  "fixed_range",
]);

function pairKey(symbol, marketKind) {
  return `${marketKind}:${symbol}`;
}

/**
 * The wire's bin-size multiplier: a float that scales an instrument's
 * volatility-derived bin width, not an absolute tick count.
 *
 * `null` means "leave it at what the session already uses", which is distinct
 * from a legal value -- so null is accepted alongside the range rather than
 * being coerced to the default here.
 */
function isValidBinSizeMultiplier(value) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_BIN_SIZE_MULTIPLIER &&
      value <= MAX_BIN_SIZE_MULTIPLIER)
  );
}

function storageReaderConfigured(storageReader) {
  return (
    (typeof storageReader?.dbPath === "string" &&
      storageReader.dbPath.length > 0) ||
    storageReader?.remote != null
  );
}

function createMarketDataServer({
  connection,
  symbol,
  marketKind = MARKET_KINDS.SPOT,
  historyBuffer = createHistoryBuffer({
    markerBucketMs: LARGE_TRADE_COVERAGE_BUCKET_MS,
    maxMarkersPerBucketSide: LARGE_TRADE_MAX_PER_BUCKET_SIDE,
    markerMaxAgeMs: LARGE_TRADE_HISTORY_WINDOW_MS,
  }),
  connectPollMs = DEFAULT_CONNECT_POLL_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  healthPollMs = DEFAULT_HEALTH_POLL_MS,
  backfillRetryBaseMs = DEFAULT_BACKFILL_RETRY_BASE_MS,
  volumeProfileRetryBaseMs = DEFAULT_VOLUME_PROFILE_RETRY_BASE_MS,
  volumeProfilePollMs = VOLUME_PROFILE_POLL_MS,
  storageReader = null,
  volumeProfileCache = null,
  preWarmMs = VOLUME_PROFILE_PREWARM_MS,
  preWarmChunkMs = VOLUME_PROFILE_PREWARM_CHUNK_MS,
  preWarmPauseMs = VOLUME_PROFILE_PREWARM_PAUSE_MS,
  tickSizeResolver = createInstrumentTickSizeResolver(),
  // L2 memory (the level ledger) for the active pair; see indicators/l2-memory.
  l2Memory = createLiveMemoryBinding({
    tickSizeResolver,
    debug: process.env.L2_MEMORY_DEBUG === "1",
  }),
  vpinPollMs = VPIN_POLL_MS,
  vpinEnabled = process.env.TT_VPIN_ENABLED !== "0",
  vpinWarmup = startVpinWarmup,
  vpinLivePoll = startVpinLivePoll,
  // Volatility readings that size profile bins, cached per pair. Shared across
  // pairs because the reading depends on the instrument, not on the session.
  volumeProfileAtr = createVolumeProfileAtrReference(),
  liquidity = createLiquidityPublisher({
    memory: l2Memory,
    pyramid: "auto",
    fillHistoryS: DEFAULT_FILL_S,
    ...liquidityOptionsFromEnv(),
  }),
  aggressivePoolWarmup = true,
  aggressivePoolWindowMs = null,
  icebergIndicatorFactory = createIcebergIndicator,
  exhaustionIndicatorFactory = createExhaustionIndicator,
  initiativeIndicatorFactory = createInitiativeIndicator,
  candleMonitorFactory = createCandleMonitor,
  recordingPollMs = RECORDING_POLL_MS,
  clientBufferSoftBytes = MAX_CLIENT_BUFFERED_BYTES,
  clientBufferHardBytes = DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  clientBufferGraceMs = DEFAULT_CLIENT_BUFFER_GRACE_MS,
  now = () => Date.now(),
}) {
  if (!isAllowedSymbol(symbol)) {
    throw new Error(
      "market data server: symbol must be an allowed Binance symbol",
    );
  }
  if (!isAllowedMarketKind(marketKind)) {
    throw new Error(
      "market data server: marketKind must be an allowed Binance market kind",
    );
  }
  for (const [name, value] of [
    ["connectPollMs", connectPollMs],
    ["connectTimeoutMs", connectTimeoutMs],
    ["healthPollMs", healthPollMs],
    ["backfillRetryBaseMs", backfillRetryBaseMs],
    ["volumeProfileRetryBaseMs", volumeProfileRetryBaseMs],
    ["volumeProfilePollMs", volumeProfilePollMs],
    ["vpinPollMs", vpinPollMs],
    ["clientBufferSoftBytes", clientBufferSoftBytes],
    ["clientBufferHardBytes", clientBufferHardBytes],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`market data server: ${name} must be a positive integer`);
    }
  }
  if (!Number.isInteger(clientBufferGraceMs) || clientBufferGraceMs < 0) {
    throw new Error(
      "market data server: clientBufferGraceMs must be a non-negative integer",
    );
  }
  if (typeof now !== "function") {
    throw new Error("market data server: now must be a function");
  }
  if (clientBufferHardBytes < clientBufferSoftBytes) {
    throw new Error(
      "market data server: clientBufferHardBytes must be >= clientBufferSoftBytes",
    );
  }
  const aggressivePoolWindow =
    aggressivePoolWindowMs !== null
      ? aggressivePoolWindowMs
      : Math.max(
          AGGRESSIVE_POOL_DEFAULT_WINDOW_MS,
          Number.isSafeInteger(liquidity.horizonMs) && liquidity.horizonMs > 0
            ? liquidity.horizonMs
            : 0,
        );
  if (
    !Number.isSafeInteger(aggressivePoolWindow) ||
    aggressivePoolWindow <= 0
  ) {
    throw new Error(
      "market data server: aggressivePoolWindowMs must be a positive integer",
    );
  }
  if (!Number.isInteger(recordingPollMs) || recordingPollMs < 0) {
    throw new Error(
      "market data server: recordingPollMs must be a non-negative integer",
    );
  }
  let recordingCache = {
    key: null,
    at: -Infinity,
    latestTs: null,
    available: false,
  };
  let recordingGeneration = 0;
  let volumeProfilePollInFlight = false;
  const clients = new Set();
  // marker_history is a post-v1 extension. Keep it opt-in so a host-first
  // rolling deploy cannot send an unknown frame to an older browser, whose
  // fail-closed parser correctly reconnects on unrecognised wire shapes.
  const markerHistoryClients = new Set();
  const clientSender = createClientSender({
    logPrefix: "market data server",
    softBytes: clientBufferSoftBytes,
    hardBytes: clientBufferHardBytes,
    graceMs: clientBufferGraceMs,
    now,
    clientCount: () => clients.size,
    releaseClient: (client) => releaseClient(client),
    closeClient: (client, code, reason) => {
      try {
        client.close?.(code, reason);
      } catch {
        void 0;
      }
    },
  });
  const markerHistoryReplayer = createLiquidityReplayer({
    logPrefix: "market data server marker history",
    clients: markerHistoryClients,
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    snapshotFrames: () =>
      markerHistoryFrames(
        activeIdentity(),
        activeHistoryBuffer().snapshotMarkers(),
      ),
    softBytes: clientBufferSoftBytes,
  });
  const liquidityReplayer = createLiquidityReplayer({
    logPrefix: "market data server",
    clients,
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    snapshotFrames: () =>
      liquidity.snapshotFrames(activeMarketKind, activeSymbol),
    softBytes: clientBufferSoftBytes,
    now,
  });
  const l2Channel = createL2Channel({
    logPrefix: "market data server l2",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => ({ marketKind: activeMarketKind, symbol: activeSymbol }),
    identityOf: (pair) => ({
      provider: "BINANCE",
      symbol: pair.symbol,
      marketKind: pair.marketKind,
    }),
    snapshotOf: (pair) =>
      typeof liquidity.l2Snapshot === "function"
        ? liquidity.l2Snapshot(pair.marketKind, pair.symbol)
        : null,
    now,
  });
  const icebergOptions = icebergOptionsFromEnv();
  const icebergEnabled = icebergOptions.enabled !== false;
  const icebergChannel = createIcebergChannel({
    logPrefix: "market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => ({ marketKind: activeMarketKind, symbol: activeSymbol }),
    identityOf: (pair) => ({
      provider: "BINANCE",
      symbol: pair.symbol,
      marketKind: pair.marketKind,
    }),
    snapshotOf: (pair) => icebergIndicator.snapshot(pair, now()),
    now,
  });
  const icebergIndicator = icebergIndicatorFactory({
    provider: "BINANCE",
    now,
    ...icebergOptions,
    liveReachMs: liquidity.horizonMs,
    publish: (icebergs, pair, at, watched, liveSince) => icebergChannel.publish(icebergs, pair, at, watched, liveSince),
  });
  let icebergTickTimer = null;
  const exhaustionOptions = exhaustionOptionsFromEnv();
  const exhaustionEnabled = exhaustionOptions.enabled !== false;
  const exhaustionChannel = createExhaustionChannel({
    logPrefix: "market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => ({ marketKind: activeMarketKind, symbol: activeSymbol }),
    identityOf: (pair) => ({
      provider: "BINANCE",
      symbol: pair.symbol,
      marketKind: pair.marketKind,
    }),
    snapshotOf: (pair) => exhaustionIndicator.snapshot(pair, now()),
    now,
  });
  const exhaustionIndicator = exhaustionIndicatorFactory({
    provider: "BINANCE",
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
    provider: "BINANCE",
    now,
    columnsAfter: (pair, afterTs, limit) => liquidity.deepColumnsAfter(pair.marketKind, pair.symbol, afterTs, limit),
    geometryOf: (pair) => liquidity.geometryFor(pair.marketKind, pair.symbol),
    activePair: () => exhaustionChannelPair(),
    publish: (entries, pair, at) => exhaustionChannel.publishMonitor(entries, pair, at),
  });
  const initiativeOptions = initiativeOptionsFromEnv();
  const initiativeEnabled = initiativeOptions.enabled !== false;
  const initiativeChannel = createInitiativeChannel({
    logPrefix: "market data server",
    wsOpen: WS_OPEN,
    safelySend: (client, frame) => safelySend(client, frame),
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
    softBytes: clientBufferSoftBytes,
    activePair: () => ({ marketKind: activeMarketKind, symbol: activeSymbol }),
    identityOf: (pair) => ({
      provider: "BINANCE",
      symbol: pair.symbol,
      marketKind: pair.marketKind,
    }),
    snapshotOf: (pair) => initiativeIndicator.snapshot(pair, now()),
    now,
  });
  const initiativeIndicator = initiativeIndicatorFactory({
    provider: "BINANCE",
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
    return { marketKind: activeMarketKind, symbol: activeSymbol };
  }
  function indicatorPairs() {
    const active = exhaustionChannelPair();
    const pairs = new Map([[pairKey(active.symbol, active.marketKind), active]]);
    for (const [key, pair] of trackedPairs) if (!pairs.has(key)) pairs.set(key, { marketKind: pair.marketKind, symbol: pair.symbol });
    return [...pairs.values()];
  }

  function feedIcebergTrade(envelope, frame) {
    try {
      icebergIndicator.onTrade(
        { marketKind: envelope.marketKind, symbol: envelope.providerSymbol },
        { price: frame.price, size: frame.size, aggressor: frame.side, ts: frame.ts_exchange },
      );
    } catch (error) {
      console.error("market data server: iceberg tracker rejected a trade", error?.message ?? error);
    }
  }

  function endIcebergDepth(envelope) {
    const ts = Date.parse(envelope.eventTime ?? envelope.receivedAt);
    try {
      icebergIndicator.onDepthUnavailable({ marketKind: envelope.marketKind, symbol: envelope.providerSymbol }, Number.isSafeInteger(ts) ? ts : undefined);
    } catch (error) {
      console.error("market data server: iceberg tracker rejected a book that lost sync", error?.message ?? error);
    }
  }

  function feedIcebergDepth(envelope) {
    const ts = Date.parse(envelope.eventTime);
    if (!Number.isSafeInteger(ts)) return;
    const entries = [];
    for (const [price, size] of envelope.payload?.bids ?? []) entries.push(["bid", Number(price), Number(size)]);
    for (const [price, size] of envelope.payload?.asks ?? []) entries.push(["ask", Number(price), Number(size)]);
    if (entries.length === 0) return;
    try {
      icebergIndicator.onDepth({ marketKind: envelope.marketKind, symbol: envelope.providerSymbol }, entries, ts);
    } catch (error) {
      console.error("market data server: iceberg tracker rejected a depth update", error?.message ?? error);
    }
  }
  const profileHistoryJobsByClient = new Map();
  const profileHistoryJobsByKey = new Map();
  const frameDispatch = createFrameDispatch({
    logPrefix: "market data server",
    clients,
    wsOpen: WS_OPEN,
    safelySendSerialized: (client, serialized, kind) =>
      safelySendSerialized(client, serialized, kind),
  });
  const selectionRateLimiter = createSelectionRateLimiter();
  const historyBuffersByPair = new Map([
    [pairKey(symbol, marketKind), historyBuffer],
  ]);
  const largeTradeWarmedPairs = new Set();
  const aggressivePools = new Map();
  const aggressivePoolWarmedPairs = new Set();
  const aggressivePoolWarmInProgressPairs = new Set();
  const largeTradeWarmInProgressPairs = new Set();
  const aggressivePoolWarmRetryNotBeforeMs = new Map();
  const largeTradeWarmRetryNotBeforeMs = new Map();
  const largeTradeWarmProgress = new Map();
  const deepAdmissionTimers = new Set();
  const latestClosedBarOpenTimeByPair = new Map();
  const warmPairs = new Map([
    [pairKey(symbol, marketKind), { symbol, marketKind }],
  ]);
  // L2 Passive Liquidity heatmap: with L2_HEATMAP_TRACK_ALL=1, every allowed pair is sampled all
  // the time, not only the one on screen, so a switch shows that pair's own retained history at
  // once. Tracked pairs keep their depth and trade feeds open and feed the L2 memory; only the
  // active pair is broadcast. Off by default -- single-pair lifecycle.
  const trackedPairs = new Map();
  const trackedSubscribed = new Set(); // tracked pairs whose feeds are open
  if (process.env.L2_HEATMAP_TRACK_ALL === "1") {
    for (const kind of listAllowedMarketKinds()) {
      for (const sym of listAllowedSymbols())
        trackedPairs.set(pairKey(sym, kind), { symbol: sym, marketKind: kind });
    }
  }
  const backfilledPairs = new Set();
  const backfillsInProgress = new Set();
  const backfillRetryAttempt = new Map();
  const backfillRetryNotBeforeMs = new Map();
  const wireFailures = new Set();
  const volumeProfileByPair = new Map();
  const requestedProfileConfigByPair = new Map();
  const volumeProfileWarmInFlight = new Set();
  const volumeProfileRetry = new Map();
  const vpinByPair = new Map();
  const vpinWarmupJobs = new Map();
  const vpinLiveJobs = new Map();
  const vpinLiveUnavailableKeys = new Set();
  const vpinWarmupStateByPair = new Map();
  const vpinWarmupRetryNotBeforeMs = new Map();
  const vpinWarmupRetry = createVpinWarmupRetryPolicy({
    log: console.error,
    label: "market data server",
  });
  const readiness = createOperationalReadiness({
    now,
    log: (event, details) => {
      const method =
        details.state === "FAILED"
          ? "error"
          : details.state === "DEGRADED" || details.state === "UNAVAILABLE"
            ? "warn"
            : "info";
      console[method](`market data server: ${event}`, details);
    },
  });
  let activeSymbol = symbol;
  let activeMarketKind = marketKind;
  const aggressiveHistory = createAggressiveHistoryHandler({
    provider: "BINANCE",
    storageReader,
    now,
    safelySend: (client, frame) => safelySend(client, frame),
    label: "market data server",
  });
  const deltaProfile = createDeltaProfileHandler({
    provider: "BINANCE",
    storageReader,
    now,
    safelySend: (client, frame) => safelySend(client, frame),
    label: "market data server",
  });
  const bandHistory = createBandHistoryHandler({
    provider: "BINANCE",
    storageReader,
    now,
    safelySend: (client, frame) => safelySend(client, frame),
    label: "market data server",
    geometryFor: (instrument) =>
      typeof liquidity.geometryFor === "function"
        ? liquidity.geometryFor(instrument.marketKind, instrument.symbol)
        : null,
  });
  const historyRequests = createHistoryRequestHandler({
    provider: "BINANCE",
    now,
    safelySend: (client, frame) => safelySend(client, frame),
    label: "market data server",
    geometryFor: (instrument) => (typeof liquidity.geometryFor === "function" ? liquidity.geometryFor(instrument.marketKind, instrument.symbol) : null),
    wallHistoryOf: (marketKind, symbol) => (typeof liquidity.wallHistoryOf === "function" ? liquidity.wallHistoryOf(marketKind, symbol) : null),
    eventHistoryOf: (marketKind, symbol) => (typeof liquidity.eventHistoryOf === "function" ? liquidity.eventHistoryOf(marketKind, symbol) : null),
  });
  let lastBookFingerprint = null;
  let healthPollTimer = null;
  let pendingSelection = null;
  let pendingSelectionTimer = null;
  let volumeProfilePollTimer = null;
  let liquidityStatsTimer = null;
  let vpinPollTimer = null;
  let preWarmTimer = null;
  let stopped = true;
  let jobOwner = createAnalyticsJobOwner();
  let stopPromise = null;
  let started = false;
  let lifecycleGeneration = 0;
  let unsubscribeMessage = null;
  let lastHealthFingerprint = null;

  const initialBars = historyBuffer.snapshotBars();
  if (initialBars.length > 0) {
    latestClosedBarOpenTimeByPair.set(
      pairKey(symbol, marketKind),
      initialBars[initialBars.length - 1].ts_open,
    );
  }

  function historyBufferFor(pairSymbol, pairMarketKind) {
    const key = pairKey(pairSymbol, pairMarketKind);
    let buffer = historyBuffersByPair.get(key);
    if (!buffer) {
      buffer = createHistoryBuffer({
        markerBucketMs: LARGE_TRADE_COVERAGE_BUCKET_MS,
        maxMarkersPerBucketSide: LARGE_TRADE_MAX_PER_BUCKET_SIDE,
        markerMaxAgeMs: LARGE_TRADE_HISTORY_WINDOW_MS,
      });
      historyBuffersByPair.set(key, buffer);
    }
    return buffer;
  }

  function activeHistoryBuffer() {
    return historyBufferFor(activeSymbol, activeMarketKind);
  }

  function activeIdentity() {
    return {
      provider: "BINANCE",
      symbol: activeSymbol,
      marketKind: activeMarketKind,
    };
  }

  function readinessFeature(pairSymbol, pairMarketKind, feature) {
    return `binance.${pairMarketKind.toLowerCase()}.${pairSymbol.toLowerCase()}.${feature}`;
  }

  function setReadiness(pairSymbol, pairMarketKind, feature, state, options) {
    readiness.transition(
      readinessFeature(pairSymbol, pairMarketKind, feature),
      state,
      options,
    );
  }

  const markerHistorySeqByPair = new Map();

  function broadcastMarkerHistoryIncrement(
    pairSymbol,
    pairMarketKind,
    markers,
  ) {
    if (markers.length === 0) return;
    const key = pairKey(pairSymbol, pairMarketKind);
    const identity = {
      provider: "BINANCE",
      symbol: pairSymbol,
      marketKind: pairMarketKind,
    };
    const ordered = [...markers].sort(
      (a, b) =>
        a.ts_exchange - b.ts_exchange ||
        (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0),
    );
    let seq = markerHistorySeqByPair.get(key) ?? 0;
    for (
      let start = 0;
      start < ordered.length;
      start += MAX_MARKER_HISTORY_ROWS
    ) {
      const frame = markerHistoryFrame(identity, {
        reset: false,
        seq,
        markers: ordered.slice(start, start + MAX_MARKER_HISTORY_ROWS),
      });
      for (const client of markerHistoryClients) safelySend(client, frame);
      seq += 1;
    }
    markerHistorySeqByPair.set(key, seq);
  }

  function inlineMarkers(buffer) {
    const markers = buffer.snapshotMarkers();
    return markers.length > MAX_SNAPSHOT_MARKERS
      ? markers.slice(markers.length - MAX_SNAPSHOT_MARKERS)
      : markers;
  }

  function recordClosedBar(buffer, frame) {
    buffer.recordBar(frame);
    const key = pairKey(fromWireSymbol(frame.symbol), frame.marketKind);
    const latest = latestClosedBarOpenTimeByPair.get(key);
    if (latest === undefined || frame.ts_open > latest) {
      latestClosedBarOpenTimeByPair.set(key, frame.ts_open);
    }
  }

  function repairDetectedKlineGap(frame) {
    const providerSymbol = fromWireSymbol(frame.symbol);
    const key = pairKey(providerSymbol, frame.marketKind);
    const latestClosedOpenTime = latestClosedBarOpenTimeByPair.get(key);
    if (
      latestClosedOpenTime === undefined ||
      frame.ts_open <= latestClosedOpenTime + frame.interval_ms
    ) {
      return;
    }
    backfilledPairs.delete(key);
    ensurePairWarm(providerSymbol, frame.marketKind).catch((error) => {
      console.error(
        `market data server: kline gap repair failed for ${key}`,
        error?.message ?? error,
      );
    });
  }

  function safelySendSerialized(client, serializedFrame, kind = null) {
    return clientSender.send(client, serializedFrame, kind);
  }

  const analyticsStatus =
    require("./analytics-status").createAnalyticsStatusPublisher(broadcast);
  function safelySend(client, frame) {
    const sent = frameDispatch.safelySend(client, frame);
    if (sent && frame.type === "snapshot")
      analyticsStatus.replay(frame, (status) =>
        frameDispatch.safelySend(client, status),
      );
    return sent;
  }

  function broadcast(frame) {
    if (clients.size === 0) return;
    if (frame.type === "liquidity" && liquidityReplayer.size > 0) {
      liquidityReplayer.broadcast(frame);
      return;
    }
    frameDispatch.broadcast(frame);
    if (frame.type === "snapshot")
      analyticsStatus.replay(frame, (status) =>
        frameDispatch.broadcast(status),
      );
  }

  function reportControlPlaneFailure(scope, error) {
    console.error(
      `market data server: ${scope} failed`,
      error?.message ?? error,
    );
    const fingerprint = `UNAVAILABLE:true:${CONTROL_PLANE_FAILURE_REASON}`;
    if (fingerprint === lastHealthFingerprint) return;
    lastHealthFingerprint = fingerprint;
    try {
      broadcast(
        healthFrame(
          activeSymbol,
          activeMarketKind,
          {
            stale: true,
            recoveryState: "UNAVAILABLE",
          },
          CONTROL_PLANE_FAILURE_REASON,
        ),
      );
    } catch (frameError) {
      console.error(
        "market data server: failed to publish control-plane health",
        frameError?.message ?? frameError,
      );
    }
  }

  function currentAggregateHealth() {
    const tuples = [
      [EVENT_TYPES.TRADE, undefined],
      [EVENT_TYPES.KLINE, KLINE_INTERVAL],
    ];
    const contexts = [];
    for (const [eventType, interval] of tuples) {
      const context = connection.getFeedHealth(
        activeMarketKind,
        activeSymbol,
        eventType,
        interval,
      );
      if (context) contexts.push(context);
    }
    if (contexts.length === 0) return null;
    if (
      wireFailures.has(
        `${pairKey(activeSymbol, activeMarketKind)}:${EVENT_TYPES.TRADE}`,
      ) ||
      wireFailures.has(
        `${pairKey(activeSymbol, activeMarketKind)}:${EVENT_TYPES.KLINE}`,
      )
    ) {
      return Object.freeze({
        stale: true,
        recoveryState: "UNAVAILABLE",
        reason: "WIRE_VALUE_OUT_OF_RANGE",
      });
    }
    const rank = { READY: 0, RECOVERING: 1, UNAVAILABLE: 2 };
    // A feed a transport declares it does not serve at all (the REST poller
    // has no tape) does not drag the state down: the state follows the feeds
    // that are served, and the reason names what is missing.
    const served = contexts.filter((context) => context.served !== false);
    const ranked = served.length > 0 ? served : contexts;
    const recoveryState = ranked.reduce(
      (worst, context) =>
        rank[context.recoveryState] > rank[worst]
          ? context.recoveryState
          : worst,
      "READY",
    );
    // A transport that explains itself (the REST poller's trader-facing
    // reason) is quoted on the health frame; the stream transport has none.
    const reason =
      ranked.find(
        (context) =>
          context.recoveryState === recoveryState &&
          typeof context.reason === "string",
      )?.reason ??
      contexts.find((context) => typeof context.reason === "string")?.reason;
    return Object.freeze({
      stale: ranked.some((context) => context.stale),
      recoveryState,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  function applyRecordingRead(key, at, read) {
    recordingCache = {
      key,
      at,
      latestTs: Number.isSafeInteger(read?.latestTs) ? read.latestTs : null,
      available: read?.available === true,
    };
  }

  function recordingStatus() {
    const at = now();
    const key = pairKey(activeSymbol, activeMarketKind);
    if (
      recordingCache.key !== key ||
      at - recordingCache.at >= recordingPollMs
    ) {
      const generation = ++recordingGeneration;
      let read = { latestTs: null, available: false };
      if (
        storageReader &&
        typeof storageReader.readRecordingAge === "function"
      ) {
        try {
          read = storageReader.readRecordingAge(
            activeSymbol,
            activeMarketKind,
            { nowMs: at },
          );
        } catch (error) {
          console.error(
            "market data server: recording age read failed",
            error?.message ?? error,
          );
        }
      }
      if (read != null && typeof read.then === "function") {
        if (recordingCache.key !== key)
          applyRecordingRead(key, at, { latestTs: null, available: false });
        else recordingCache = { ...recordingCache, key, at };
        Promise.resolve(read)
          .then((resolved) => {
            if (
              recordingGeneration !== generation ||
              pairKey(activeSymbol, activeMarketKind) !== key
            )
              return;
            applyRecordingRead(key, now(), resolved);
          })
          .catch((error) => {
            console.error(
              "market data server: recording age read failed",
              error?.message ?? error,
            );
          });
      } else {
        applyRecordingRead(key, at, read);
      }
    }
    const { latestTs, available } = recordingCache;
    const ageMs = latestTs === null ? null : Math.max(0, at - latestTs);
    return Object.freeze({
      symbol: activeSymbol,
      marketKind: activeMarketKind,
      available,
      latestTradeTs: latestTs,
      ageMs,
      stale: !available || ageMs === null || ageMs > RECORDING_STALE_MS,
    });
  }

  function healthWithRecording(context) {
    const recording = recordingStatus();
    return {
      ...context,
      recordingStale: recording.stale,
      ...(recording.latestTradeTs !== null
        ? { recordingLatestTs: recording.latestTradeTs }
        : {}),
    };
  }

  function checkHealthAndMaybeBroadcast() {
    const context = currentAggregateHealth();
    if (!context) return;
    const health = healthWithRecording(context);
    const fingerprint = `${context.recoveryState}:${context.stale}:${context.reason ?? ""}:${health.recordingStale}`;
    if (fingerprint !== lastHealthFingerprint) {
      lastHealthFingerprint = fingerprint;
      broadcast(
        healthFrame(activeSymbol, activeMarketKind, health, context.reason),
      );
    }
  }

  function isDepthStale() {
    return (
      connection.getFeedHealth(
        activeMarketKind,
        activeSymbol,
        EVENT_TYPES.DEPTH,
      )?.stale === true
    );
  }

  function bookFingerprint(state, stale) {
    if (state.status !== "READY") {
      return `UNAVAILABLE:${state.reason}`;
    }
    return `READY:${state.book.lastUpdateId}:${stale}`;
  }

  function emitBook(state) {
    const stale = state.status === "READY" && isDepthStale();
    lastBookFingerprint = bookFingerprint(state, stale);
    try {
      broadcast(
        bookFrame(activeSymbol, activeMarketKind, state, BOOK_DEPTH_LEVELS, {
          stale,
        }),
      );
    } catch (error) {
      broadcast(
        bookFrame(activeSymbol, activeMarketKind, {
          status: "UNAVAILABLE",
          reason: bookFailureReason(error),
        }),
      );
      console.error("market data server: order book rejected", {
        reason: bookFailureReason(error),
        detail: error?.message ?? error,
      });
    }
  }

  function sendBookToClient(client, state) {
    const stale = state.status === "READY" && isDepthStale();
    try {
      safelySend(
        client,
        bookFrame(activeSymbol, activeMarketKind, state, BOOK_DEPTH_LEVELS, {
          stale,
        }),
      );
    } catch (error) {
      safelySend(
        client,
        bookFrame(activeSymbol, activeMarketKind, {
          status: "UNAVAILABLE",
          reason: bookFailureReason(error),
        }),
      );
      console.error("market data server: order book rejected", {
        reason: bookFailureReason(error),
        detail: error?.message ?? error,
      });
    }
  }

  function checkBookAndMaybeBroadcast() {
    const state = connection.getOrderBook(activeMarketKind, activeSymbol);
    if (!state) {
      return;
    }
    const stale = state.status === "READY" && isDepthStale();
    const fingerprint = bookFingerprint(state, stale);
    if (fingerprint !== lastBookFingerprint) {
      emitBook(state);
    }
  }

  function handleEnvelope(envelope) {
    const isActivePair =
      envelope.marketKind === activeMarketKind &&
      envelope.providerSymbol === activeSymbol;
    const isTrackedPair =
      isActivePair ||
      trackedPairs.has(pairKey(envelope.providerSymbol, envelope.marketKind));

    if (
      envelope.eventType === EVENT_TYPES.TRADE &&
      envelope.state !== "UNAVAILABLE"
    ) {
      const failureKey = `${pairKey(envelope.providerSymbol, envelope.marketKind)}:${EVENT_TYPES.TRADE}`;
      let frame;
      try {
        frame = tradeEnvelopeToFrame(envelope);
        wireFailures.delete(failureKey);
      } catch (error) {
        wireFailures.add(failureKey);
        console.error(
          "market data server: trade value cannot be represented on the numeric wire",
          error?.message ?? error,
        );
        if (isActivePair) checkHealthAndMaybeBroadcast();
        return;
      }
      const buffer = historyBufferFor(
        envelope.providerSymbol,
        envelope.marketKind,
      );
      const isNewTrade = buffer.recordTrade(frame);
      if (isNewTrade)
        aggressivePoolFor(envelope.providerSymbol, envelope.marketKind).record(
          frame,
        );
      if (isTrackedPair && isNewTrade) l2Memory.onTrade(envelope);
      if (icebergEnabled && isTrackedPair && isNewTrade) feedIcebergTrade(envelope, frame);
      if (isActivePair && isNewTrade) broadcast(frame);
      if (
        isNewTrade &&
        buffer.wouldRetainMarker(
          frame.ts_exchange,
          frame.side,
          frame.price * frame.size,
        )
      ) {
        let wireMarker;
        try {
          wireMarker = markerFrame(
            frame,
            envelope.providerSymbol,
            envelope.marketKind,
          );
        } catch (error) {
          console.error(
            "market data server: marker value cannot be represented on the numeric wire",
            error?.message ?? error,
          );
        }
        if (wireMarker) {
          const isNewMarker = buffer.recordMarker(wireMarker);
          if (isActivePair && isNewMarker) broadcast(wireMarker);
        }
      }
    } else if (
      envelope.eventType === EVENT_TYPES.KLINE &&
      envelope.state !== "UNAVAILABLE"
    ) {
      const failureKey = `${pairKey(envelope.providerSymbol, envelope.marketKind)}:${EVENT_TYPES.KLINE}`;
      let frame;
      try {
        frame = klineEnvelopeToFrame(envelope);
        wireFailures.delete(failureKey);
      } catch (error) {
        wireFailures.add(failureKey);
        console.error(
          "market data server: kline value cannot be represented on the numeric wire",
          error?.message ?? error,
        );
        if (isActivePair) checkHealthAndMaybeBroadcast();
        return;
      }
      if (frame.closed) {
        repairDetectedKlineGap(frame);
        recordClosedBar(
          historyBufferFor(envelope.providerSymbol, envelope.marketKind),
          frame,
        );
      } else {
        repairDetectedKlineGap(frame);
      }
      if (isActivePair) {
        broadcast(frame);
      }
    } else if (envelope.eventType === EVENT_TYPES.DEPTH && isTrackedPair) {
      // The pair on screen needs the whole sorted book for its frame. A pair
      // kept live off screen only needs the status and best prices; the L2
      // memory fetches the whole book itself in the rare case it has to seed
      // or resync. Sorting the full book for every pair on every event is
      // what pinned the process at 100% of a core.
      const fullBook = () =>
        connection.getOrderBook(envelope.marketKind, envelope.providerSymbol);
      const state =
        isActivePair || typeof connection.getOrderBookStatus !== "function"
          ? fullBook()
          : connection.getOrderBookStatus(
              envelope.marketKind,
              envelope.providerSymbol,
            );
      l2Memory.onDepth(envelope, state, fullBook);
      if (icebergEnabled) {
        if (state?.status !== "READY") endIcebergDepth(envelope);
        else if (envelope.state !== "UNAVAILABLE") feedIcebergDepth(envelope);
      }
      if (isActivePair && state) {
        emitBook(state);
      }
    }

    if (isActivePair) {
      checkHealthAndMaybeBroadcast();
    }
  }

  function handleClientConnected(client) {
    clients.add(client);
    if (!safelySend(client, selectionFrame(activeSymbol, activeMarketKind))) {
      return;
    }
    const buffer = activeHistoryBuffer();
    if (
      !safelySend(
        client,
        snapshotFrame(
          buffer.snapshotBars(),
          buffer.snapshotTrades(),
          activeSymbol,
          activeMarketKind,
          inlineMarkers(buffer),
          vpinHistoryFor(activeSymbol, activeMarketKind),
          vpinWarmupStatusFor(activeSymbol, activeMarketKind),
          aggressivePoolSnapshot(activeSymbol, activeMarketKind),
        ),
      )
    ) {
      return;
    }
    const state = connection.getOrderBook(activeMarketKind, activeSymbol);
    if (state) {
      sendBookToClient(client, state);
    }
    liquidityReplayer.start(
      client,
      liquidity.snapshotFrames(activeMarketKind, activeSymbol),
    );
    const health = currentAggregateHealth();
    if (health) {
      safelySend(
        client,
        healthFrame(
          activeSymbol,
          activeMarketKind,
          healthWithRecording(health),
          health.reason,
        ),
      );
    }
  }

  function releaseClient(client) {
    releaseProfileHistorySubscription(client);
    clients.delete(client);
    markerHistoryClients.delete(client);
    clientSender.forget(client);
    liquidityReplayer.forget(client);
    markerHistoryReplayer.forget(client);
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

  function handleClientDisconnected(client) {
    releaseClient(client);
  }

  function closeAllClients() {
    for (const client of clients) {
      if (typeof client.close === "function") {
        try {
          client.close();
        } catch {
          void 0;
        }
      }
    }
    liquidityReplayer.stopAll();
    markerHistoryReplayer.stopAll();
    l2Channel.stopAll();
    clients.clear();
    markerHistoryClients.clear();
    clientSender.clear();
  }

  function subscriptionRequests(pairSymbol, pairMarketKind) {
    return [
      {
        symbol: pairSymbol,
        marketKind: pairMarketKind,
        eventType: EVENT_TYPES.TRADE,
      },
      {
        symbol: pairSymbol,
        marketKind: pairMarketKind,
        eventType: EVENT_TYPES.KLINE,
        interval: KLINE_INTERVAL,
      },
      {
        symbol: pairSymbol,
        marketKind: pairMarketKind,
        eventType: EVENT_TYPES.DEPTH,
      },
    ];
  }

  function subscribePair(pairSymbol, pairMarketKind) {
    const requests = subscriptionRequests(pairSymbol, pairMarketKind);
    if (typeof connection.subscribeMany === "function") {
      connection.subscribeMany(requests, SERVER_CONSUMER_ID);
      return;
    }
    const subscribed = [];
    try {
      for (const request of requests) {
        connection.subscribe(request, SERVER_CONSUMER_ID);
        subscribed.push(request);
      }
    } catch (error) {
      for (const request of subscribed.reverse()) {
        try {
          connection.unsubscribe?.(request, SERVER_CONSUMER_ID);
        } catch (rollbackError) {
          console.error(
            `market data server: failed to roll back a partial subscription for ${pairKey(pairSymbol, pairMarketKind)}`,
            rollbackError?.message ?? rollbackError,
          );
        }
      }
      throw error;
    }
  }

  function unsubscribePair(pairSymbol, pairMarketKind) {
    const requests = subscriptionRequests(pairSymbol, pairMarketKind);
    if (typeof connection.unsubscribeMany === "function") {
      connection.unsubscribeMany(requests, SERVER_CONSUMER_ID);
      return;
    }
    for (const request of requests) {
      connection.unsubscribe(request, SERVER_CONSUMER_ID);
    }
  }

  function aggressivePoolFor(pairSymbol, pairMarketKind) {
    const key = pairKey(pairSymbol, pairMarketKind);
    let pool = aggressivePools.get(key);
    if (!pool) {
      pool = createAggressivePool({ now, windowMs: aggressivePoolWindow });
      aggressivePools.set(key, pool);
    }
    return pool;
  }

  function aggressivePoolSnapshot(pairSymbol, pairMarketKind) {
    const pool = aggressivePools.get(pairKey(pairSymbol, pairMarketKind));
    return pool ? pool.snapshot() : undefined;
  }

  async function seedAggressivePrints(pairSymbol, pairMarketKind, key) {
    if (!aggressivePoolWarmup) {
      setReadiness(
        pairSymbol,
        pairMarketKind,
        "aggressive_prints",
        "DISABLED",
        { reason: "DISABLED_BY_CONFIG" },
      );
      return false;
    }
    if (
      !storageReader ||
      typeof storageReader.readAggressivePrintsAsync !== "function"
    ) {
      setReadiness(
        pairSymbol,
        pairMarketKind,
        "aggressive_prints",
        "UNAVAILABLE",
        { reason: "STORAGE_UNAVAILABLE" },
      );
      return false;
    }
    if (
      aggressivePoolWarmedPairs.has(key) ||
      aggressivePoolWarmInProgressPairs.has(key) ||
      Date.now() < (aggressivePoolWarmRetryNotBeforeMs.get(key) ?? 0)
    )
      return false;
    aggressivePoolWarmInProgressPairs.add(key);
    setReadiness(pairSymbol, pairMarketKind, "aggressive_prints", "RUNNING", {
      reason: "IN_PROGRESS",
    });
    const pool = aggressivePoolFor(pairSymbol, pairMarketKind);
    const startedAtMs = Date.now();
    try {
      const result = await warmAggressivePool({
        pool,
        nowMs: Date.now(),
        windowMs: aggressivePoolWindow,
        shouldContinue: () => !stopped && warmPairs.has(key),
        read: async (fromMs, toMs, minSize, cursor) => {
          const {
            rows,
            available = true,
            hasMore = false,
            nextCursor = null,
          } = await storageReader.readAggressivePrintsAsync(
            pairSymbol,
            pairMarketKind,
            {
              fromMs,
              toMs,
              minSize,
              limit: AGGRESSIVE_POOL_READ_LIMIT,
              cursor,
            },
          );
          if (!available) return { frames: [], available: false };
          const { frames, dropped } = rowsToTradeFrames(
            "BINANCE",
            { symbol: pairSymbol, marketKind: pairMarketKind },
            rows,
          );
          if (dropped > 0)
            console.error(
              `market data server: ${dropped} stored prints for ${key} could not be represented on the wire`,
            );
          return { frames, hasMore, nextCursor };
        },
        onProgress: () => {
          if (
            pairSymbol !== activeSymbol ||
            pairMarketKind !== activeMarketKind
          )
            return;
          const buffer = historyBufferFor(pairSymbol, pairMarketKind);
          broadcast(
            snapshotFrame(
              buffer.snapshotBars(),
              buffer.snapshotTrades(),
              pairSymbol,
              pairMarketKind,
              inlineMarkers(buffer),
              vpinHistoryFor(pairSymbol, pairMarketKind),
              vpinWarmupStatusFor(pairSymbol, pairMarketKind),
              pool.snapshot(),
            ),
          );
        },
      });
      if (result.complete) {
        aggressivePoolWarmedPairs.add(key);
        aggressivePoolWarmRetryNotBeforeMs.delete(key);
      } else {
        aggressivePoolWarmRetryNotBeforeMs.set(
          key,
          Date.now() + STORAGE_WARMUP_RETRY_MS,
        );
      }
      setReadiness(
        pairSymbol,
        pairMarketKind,
        "aggressive_prints",
        result.complete ? "READY" : "DEGRADED",
        {
          reason: result.complete ? null : "PARTIAL_COVERAGE",
          metrics: {
            chunks: result.chunks,
            prints: result.prints,
            retained: pool.size,
            durationMs: Date.now() - startedAtMs,
          },
        },
      );
      console.info(
        `market data server: aggressive-print warm-up ${result.complete ? "complete" : "incomplete"} for ${key}`,
        {
          chunks: result.chunks,
          prints: result.prints,
          retained: pool.size,
          floor: pool.floor,
          durationMs: Date.now() - startedAtMs,
        },
      );
      return result.complete;
    } catch (error) {
      aggressivePoolWarmRetryNotBeforeMs.set(
        key,
        Date.now() + STORAGE_WARMUP_RETRY_MS,
      );
      console.error(
        `market data server: aggressive-print warm-up for ${key} failed`,
        error?.message ?? error,
      );
      setReadiness(pairSymbol, pairMarketKind, "aggressive_prints", "FAILED", {
        reason: "WORKER_ERROR",
      });
      return false;
    } finally {
      aggressivePoolWarmInProgressPairs.delete(key);
    }
  }

  async function seedLargeTrades(pairSymbol, pairMarketKind, key) {
    if (
      !storageReader ||
      (typeof storageReader.readLargeTrades !== "function" &&
        typeof storageReader.readLargeTradesAsync !== "function")
    ) {
      setReadiness(pairSymbol, pairMarketKind, "large_trades", "UNAVAILABLE", {
        reason: "STORAGE_UNAVAILABLE",
      });
      return false;
    }
    if (
      !storageReader ||
      largeTradeWarmedPairs.has(key) ||
      largeTradeWarmInProgressPairs.has(key) ||
      Date.now() < (largeTradeWarmRetryNotBeforeMs.get(key) ?? 0) ||
      (typeof storageReader.readLargeTrades !== "function" &&
        typeof storageReader.readLargeTradesAsync !== "function")
    )
      return false;
    largeTradeWarmInProgressPairs.add(key);
    setReadiness(pairSymbol, pairMarketKind, "large_trades", "RUNNING", {
      reason: "IN_PROGRESS",
    });
    const resumed = largeTradeWarmProgress.get(key) ?? null;
    let cursorMs = 0;
    let chunksCompleted = 0;
    let markersRecorded = 0;
    let warmupFloorMs = 0;
    const rememberProgress = () => {
      largeTradeWarmProgress.set(key, {
        cursorMs,
        warmupFloorMs,
        chunksCompleted,
        markersRecorded,
      });
      largeTradeWarmRetryNotBeforeMs.set(
        key,
        Date.now() + STORAGE_WARMUP_RETRY_MS,
      );
    };
    try {
      const nowMs = Date.now();
      const buffer = historyBufferFor(pairSymbol, pairMarketKind);
      warmupFloorMs =
        resumed === null
          ? Math.max(0, nowMs - LARGE_TRADE_HISTORY_WINDOW_MS)
          : resumed.warmupFloorMs;
      cursorMs = resumed === null ? nowMs : resumed.cursorMs;
      chunksCompleted = resumed === null ? 0 : resumed.chunksCompleted;
      markersRecorded = resumed === null ? 0 : resumed.markersRecorded;
      let firstSlicePublished = false;
      let unpublishedMarkers = [];
      console.info(
        `market data server: large-trade warm-up ${resumed === null ? "started" : "resumed"} for ${key}`,
        {
          fromMs: warmupFloorMs,
          nowMs: cursorMs,
          initialWindowMs: LARGE_TRADE_WARMUP_INITIAL_WINDOW_MS,
          chunkWindowMs: LARGE_TRADE_WARMUP_CHUNK_MS,
          ...(resumed === null ? {} : { chunksCompleted }),
        },
      );

      while (cursorMs >= warmupFloorMs) {
        const windowMs =
          chunksCompleted === 0
            ? LARGE_TRADE_WARMUP_INITIAL_WINDOW_MS
            : LARGE_TRADE_WARMUP_CHUNK_MS;
        const fromMs = Math.max(warmupFloorMs, cursorMs - windowMs + 1);
        const options = {
          nowMs: cursorMs,
          fromMs,
          bucketMs: LARGE_TRADE_COVERAGE_BUCKET_MS,
          perBucketSideLimit: LARGE_TRADE_MAX_PER_BUCKET_SIDE,
          limit: LARGE_TRADE_QUERY_LIMIT,
        };
        const startedAtMs = Date.now();
        const { rows, available = true } =
          typeof storageReader.readLargeTradesAsync === "function"
            ? await storageReader.readLargeTradesAsync(
                pairSymbol,
                pairMarketKind,
                options,
              )
            : await Promise.resolve(
                storageReader.readLargeTrades(
                  pairSymbol,
                  pairMarketKind,
                  options,
                ),
              );
        if (!available) {
          rememberProgress();
          setReadiness(pairSymbol, pairMarketKind, "large_trades", "DEGRADED", {
            reason: "RETRY_SCHEDULED",
            metrics: { chunksCompleted, markersRecorded },
          });
          return false;
        }
        if (stopped || !warmPairs.has(key)) {
          largeTradeWarmProgress.set(key, { cursorMs, warmupFloorMs, chunksCompleted, markersRecorded });
          setReadiness(pairSymbol, pairMarketKind, "large_trades", "IDLE", { reason: "CANCELLED", metrics: { chunksCompleted, markersRecorded } });
          return false;
        }

        for (const { trade } of rows) {
          try {
            const marker = markerFrame(trade, pairSymbol, pairMarketKind);
            if (buffer.recordMarker(marker)) {
              markersRecorded += 1;
              unpublishedMarkers.push(marker);
            }
          } catch (error) {
            console.error(
              `market data server: warm-up marker for ${key} cannot be represented on the numeric wire`,
              error?.message ?? error,
            );
          }
        }
        chunksCompleted += 1;
        const shouldPublish =
          !firstSlicePublished ||
          chunksCompleted <= LARGE_TRADE_WARMUP_PROMPT_CHUNKS ||
          chunksCompleted % LARGE_TRADE_WARMUP_PUBLISH_EVERY_CHUNKS === 0 ||
          fromMs === warmupFloorMs;
        if (
          shouldPublish &&
          pairSymbol === activeSymbol &&
          pairMarketKind === activeMarketKind
        ) {
          broadcast(
            snapshotFrame(
              buffer.snapshotBars(),
              buffer.snapshotTrades(),
              pairSymbol,
              pairMarketKind,
              inlineMarkers(buffer),
              vpinHistoryFor(pairSymbol, pairMarketKind),
              vpinWarmupStatusFor(pairSymbol, pairMarketKind),
              aggressivePoolSnapshot(pairSymbol, pairMarketKind),
            ),
          );
          broadcastMarkerHistoryIncrement(
            pairSymbol,
            pairMarketKind,
            unpublishedMarkers,
          );
          unpublishedMarkers = [];
          firstSlicePublished = true;
        }
        if (shouldPublish) {
          console.info(
            `market data server: large-trade warm-up progress for ${key}`,
            {
              chunksCompleted,
              fromMs,
              toMs: cursorMs,
              rowsRead: rows.length,
              markersRetained: buffer.markerCount(),
              durationMs: Date.now() - startedAtMs,
            },
          );
        }
        if (fromMs === warmupFloorMs) break;
        cursorMs = fromMs - 1;
      }
      largeTradeWarmedPairs.add(key);
      largeTradeWarmRetryNotBeforeMs.delete(key);
      largeTradeWarmProgress.delete(key);
      console.info(
        `market data server: large-trade warm-up complete for ${key}`,
        {
          chunksCompleted,
          markersRecorded,
          markersRetained: buffer.markerCount(),
        },
      );
      setReadiness(pairSymbol, pairMarketKind, "large_trades", "READY", {
        metrics: {
          chunksCompleted,
          markersRecorded,
          markersRetained: buffer.markerCount(),
        },
      });
      return true;
    } catch (error) {
      rememberProgress();
      console.error(
        `market data server: large-trade warm-up for ${key} failed`,
        error?.message ?? error,
      );
      setReadiness(pairSymbol, pairMarketKind, "large_trades", "FAILED", {
        reason: "WORKER_ERROR",
        metrics: { chunksCompleted, markersRecorded },
      });
      return false;
    } finally {
      largeTradeWarmInProgressPairs.delete(key);
    }
  }

  function largeTradeWarmupApplies() {
    return (
      !!storageReader &&
      (typeof storageReader.readLargeTrades === "function" ||
        typeof storageReader.readLargeTradesAsync === "function")
    );
  }

  function aggressiveWarmupApplies() {
    return (
      !!aggressivePoolWarmup &&
      !!storageReader &&
      typeof storageReader.readAggressivePrintsAsync === "function"
    );
  }

  function smallWarmupsSettled(key) {
    if (!warmPairs.has(key)) return true;
    return (
      (!largeTradeWarmupApplies() || largeTradeWarmedPairs.has(key)) &&
      (!aggressiveWarmupApplies() || aggressivePoolWarmedPairs.has(key))
    );
  }

  function deepAdmission(key) {
    if (stopped || smallWarmupsSettled(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const waiter = { timer: null, resolve };
      waiter.timer = setInterval(() => {
        if (
          !stopped &&
          !smallWarmupsSettled(key) &&
          Date.now() - startedAt < DEEP_ADMISSION_MAX_WAIT_MS
        )
          return;
        settleDeepAdmission(waiter);
      }, DEEP_ADMISSION_POLL_MS);
      waiter.timer.unref?.();
      deepAdmissionTimers.add(waiter);
    });
  }

  function settleDeepAdmission(waiter) {
    clearInterval(waiter.timer);
    deepAdmissionTimers.delete(waiter);
    waiter.resolve();
  }

  async function ensurePairWarm(pairSymbol, pairMarketKind) {
    if (stopped) return;
    const generationAtStart = lifecycleGeneration;
    const key = pairKey(pairSymbol, pairMarketKind);
    warmPairs.set(key, { symbol: pairSymbol, marketKind: pairMarketKind });
    try {
      subscribePair(pairSymbol, pairMarketKind);
    } catch (error) {
      console.error(
        `market data server: failed to subscribe feeds for ${key}`,
        error?.message ?? error,
      );
    }
    ensureVolumeProfileWarm(pairSymbol, pairMarketKind).catch((error) => {
      setReadiness(pairSymbol, pairMarketKind, "volume_profile", "FAILED", {
        reason: "STORAGE_UNAVAILABLE",
      });
      console.error(
        `market data server: volume profile warm-up failed for ${key}`,
        error?.message ?? error,
      );
    });
    ensureVpinWarm(pairSymbol, pairMarketKind).catch((error) => {
      console.error(
        `market data server: vpin warm-up failed for ${key}`,
        error?.message ?? error,
      );
    });

    void seedLargeTrades(pairSymbol, pairMarketKind, key);
    void seedAggressivePrints(pairSymbol, pairMarketKind, key);

    if (
      backfilledPairs.has(key) ||
      backfillsInProgress.has(key) ||
      Date.now() < (backfillRetryNotBeforeMs.get(key) ?? 0)
    ) {
      return;
    }
    backfillsInProgress.add(key);
    setReadiness(pairSymbol, pairMarketKind, "candles", "RUNNING", {
      reason: "IN_PROGRESS",
    });
    try {
      const buffer = historyBufferFor(pairSymbol, pairMarketKind);

      if (storageReader) {
        try {
          const { rows, coversFullWindow } = await Promise.resolve(
            storageReader.readRecentCandles(pairSymbol, pairMarketKind, {
              intervalMs: INTERVAL_MS[KLINE_INTERVAL],
              windowMs: BACKFILL_DAYS * 24 * 60 * 60 * 1000,
            }),
          );
          if (
            stopped ||
            generationAtStart !== lifecycleGeneration ||
            !warmPairs.has(key)
          )
            return;
          for (const frame of rows) {
            recordClosedBar(buffer, frame);
          }
          if (
            rows.length > 0 &&
            pairSymbol === activeSymbol &&
            pairMarketKind === activeMarketKind
          ) {
            broadcast(
              snapshotFrame(
                buffer.snapshotBars(),
                buffer.snapshotTrades(),
                pairSymbol,
                pairMarketKind,
                inlineMarkers(buffer),
                vpinHistoryFor(pairSymbol, pairMarketKind),
                vpinWarmupStatusFor(pairSymbol, pairMarketKind),
                aggressivePoolSnapshot(pairSymbol, pairMarketKind),
              ),
            );
          }
          if (coversFullWindow) {
            if (stopped || generationAtStart !== lifecycleGeneration) return;
            backfilledPairs.add(key);
            backfillRetryAttempt.delete(key);
            backfillRetryNotBeforeMs.delete(key);
            setReadiness(pairSymbol, pairMarketKind, "candles", "READY", {
              metrics: { bars: buffer.snapshotBars().length },
            });
            return;
          }
        } catch (error) {
          console.error(
            `market data server: storage read for ${key} failed, falling back to REST`,
            error?.message ?? error,
          );
        }
      }

      const result = await connection.fetchRecentKlines(
        pairMarketKind,
        pairSymbol,
        {
          interval: KLINE_INTERVAL,
          intervalMs: INTERVAL_MS[KLINE_INTERVAL],
          days: BACKFILL_DAYS,
        },
      );

      if (
        stopped ||
        generationAtStart !== lifecycleGeneration ||
        !warmPairs.has(key)
      )
        return;

      let recordedCount = 0;
      let invalidFrameCount = 0;
      for (const row of result.rows) {
        let frame;
        try {
          frame = restKlineRowToBarFrame(
            row,
            pairSymbol,
            pairMarketKind,
            KLINE_INTERVAL,
          );
        } catch {
          invalidFrameCount += 1;
          continue;
        }
        if (frame) {
          recordClosedBar(buffer, frame);
          recordedCount += 1;
        }
      }

      if (!result.ok || invalidFrameCount > 0) {
        const reason = result.ok ? "WIRE_VALUE_OUT_OF_RANGE" : result.reason;
        console.error(
          `market data server: kline backfill for ${key} incomplete (${reason}), ${recordedCount} bars recovered before it stopped`,
        );
        scheduleBackfillRetry(key, result.retryAfterMs);
        setReadiness(pairSymbol, pairMarketKind, "candles", "DEGRADED", {
          reason: "RETRY_SCHEDULED",
          metrics: { bars: recordedCount, invalidFrames: invalidFrameCount },
        });
      } else {
        backfilledPairs.add(key);
        backfillRetryAttempt.delete(key);
        backfillRetryNotBeforeMs.delete(key);
        setReadiness(pairSymbol, pairMarketKind, "candles", "READY", {
          metrics: { bars: recordedCount },
        });
      }

      if (
        recordedCount > 0 &&
        pairSymbol === activeSymbol &&
        pairMarketKind === activeMarketKind
      ) {
        broadcast(
          snapshotFrame(
            buffer.snapshotBars(),
            buffer.snapshotTrades(),
            pairSymbol,
            pairMarketKind,
            inlineMarkers(buffer),
            vpinHistoryFor(pairSymbol, pairMarketKind),
            vpinWarmupStatusFor(pairSymbol, pairMarketKind),
            aggressivePoolSnapshot(pairSymbol, pairMarketKind),
          ),
        );
      }
    } catch (error) {
      if (stopped || generationAtStart !== lifecycleGeneration) return;
      scheduleBackfillRetry(key);
      setReadiness(pairSymbol, pairMarketKind, "candles", "FAILED", {
        reason: "PROVIDER_UNAVAILABLE",
      });
      throw error;
    } finally {
      backfillsInProgress.delete(key);
    }
  }

  function scheduleBackfillRetry(key, retryAfterMs) {
    const attempt = (backfillRetryAttempt.get(key) ?? 0) + 1;
    backfillRetryAttempt.set(key, attempt);
    const backoffMs = Math.min(
      backfillRetryBaseMs * 2 ** (attempt - 1),
      MAX_BACKFILL_RETRY_MS,
    );
    const honorsRetryAfter =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs > backoffMs;
    const delayMs = honorsRetryAfter ? retryAfterMs : backoffMs;
    backfillRetryNotBeforeMs.set(key, Date.now() + delayMs);
  }

  async function prefetchVolumeProfileSeed(
    pairSymbol,
    pairMarketKind,
    adapter,
    tickSize,
    periodMs,
    nowMs,
  ) {
    if (typeof storageReader?.readVolumeProfileAsync !== "function")
      return null;
    const periodStartTs = alignPeriodStart(nowMs, periodMs);
    const seedToTs = floorToMinute(nowMs);
    if (seedToTs <= periodStartTs) return null;
    // The seed is bucketed on the same grid as the session that will consume it,
    // so it must derive its width the same way -- including the ATR reading and
    // the period the volatility is projected onto.
    const atrReading = await volumeProfileAtr.getReading(
      pairKey(pairSymbol, pairMarketKind),
      {
        readCandles: (options) => adapter.readCandles(options),
        readPriceRange: (window) =>
          adapter.readPriceRange(window.fromTs, window.toTs),
      },
    );
    const params = await deriveBucketingParams({
      adapter,
      tickSize,
      fromTs: Math.max(0, nowMs - VOLUME_PROFILE_REFERENCE_LOOKBACK_MS),
      toTs: nowMs,
      binSizeMultiplier: DEFAULT_BIN_SIZE_MULTIPLIER,
      atrReading,
      atrSessionMs: periodMs,
    });
    if (params === null) return null;
    try {
      const result = await storageReader.readVolumeProfileAsync(
        pairSymbol,
        pairMarketKind,
        {
          fromTs: periodStartTs,
          toTs: seedToTs,
          originPrice: params.originPrice,
          rowWidth: params.rowWidth,
        },
      );
      return result?.available ? result : null;
    } catch (error) {
      console.error(
        "market data server: off-thread volume profile seed failed",
        error?.message ?? error,
      );
      return null;
    }
  }

  async function buildAlignedSession(
    adapter,
    tickSize,
    periodMs,
    binSizeMultiplier,
    nowMs,
    prefetchedSeed = null,
    instrument = null,
  ) {
    const periodStartTs = alignPeriodStart(nowMs, periodMs);
    // Bin width comes from volatility, projected onto THIS session's period --
    // not from the short probe window below, which is only used to tell an empty
    // window from unavailable storage. Sizing from the probe would give the
    // session a width derived from a sliver of itself. The multiplier scales
    // that width, so it is read wherever a reading exists, including when the
    // multiplier is the default.
    const atrReading =
      instrument === null
        ? null
        : await volumeProfileAtr.getReading(instrument, {
            readCandles: (options) => adapter.readCandles(options),
            readPriceRange: (window) =>
              adapter.readPriceRange(window.fromTs, window.toTs),
          });
    const params = await deriveBucketingParams({
      adapter,
      tickSize,
      fromTs: Math.max(0, nowMs - VOLUME_PROFILE_REFERENCE_LOOKBACK_MS),
      toTs: nowMs,
      binSizeMultiplier,
      atrReading,
      atrSessionMs: periodMs,
    });
    if (params === null) return null;
    const session = createVolumeProfileSession({
      periodStartTs,
      originPrice: params.originPrice,
      rowWidth: params.rowWidth,
    });
    const seedToTs = floorToMinute(nowMs);
    if (seedToTs > periodStartTs) {
      try {
        await seedSessionFromStorage(
          session,
          adapter,
          seedToTs,
          prefetchedSeed,
        );
      } catch (error) {
        console.error(
          "market data server: volume profile seed failed",
          error?.message ?? error,
        );
      }
    }
    return session;
  }

  function scheduleVolumeProfileRetry(pairSymbol, pairMarketKind, key, cause) {
    const attempt = (volumeProfileRetry.get(key)?.attempt ?? 0) + 1;
    const retryInMs = Math.min(volumeProfileRetryBaseMs * 2 ** (attempt - 1), MAX_VOLUME_PROFILE_RETRY_MS);
    volumeProfileRetry.set(key, { attempt, notBeforeMs: Date.now() + retryInMs });
    setReadiness(pairSymbol, pairMarketKind, "volume_profile", "DEGRADED", { reason: "RETRY_SCHEDULED", metrics: { cause, attempt, retryInMs } });
  }

  function volumeProfileWarmAbandoned(pairSymbol, pairMarketKind, key) {
    if (stopped) return true;
    if (!warmPairs.has(key)) {
      if (!volumeProfileByPair.has(key)) setReadiness(pairSymbol, pairMarketKind, "volume_profile", "IDLE", { reason: "CANCELLED" });
      return true;
    }
    return volumeProfileByPair.has(key);
  }

  async function ensureVolumeProfileWarm(pairSymbol, pairMarketKind) {
    const key = pairKey(pairSymbol, pairMarketKind);
    if (stopped || volumeProfileByPair.has(key) || !storageReader) return;
    if (typeof storageReader.readVolumeProfile !== "function" || typeof storageReader.readRecentTrades !== "function") return;
    if (volumeProfileWarmInFlight.has(key) || Date.now() < (volumeProfileRetry.get(key)?.notBeforeMs ?? 0)) return;
    volumeProfileWarmInFlight.add(key);
    try {
      setReadiness(pairSymbol, pairMarketKind, "volume_profile", "RUNNING", { reason: "IN_PROGRESS" });
      const tickSize = await tickSizeResolver.getBinanceTickSize(pairMarketKind, pairSymbol);
      if (volumeProfileWarmAbandoned(pairSymbol, pairMarketKind, key)) return;
      if (!Number.isFinite(tickSize) || tickSize <= 0) {
        scheduleVolumeProfileRetry(pairSymbol, pairMarketKind, key, "TICK_SIZE_UNAVAILABLE");
        return;
      }
      const adapter = createBinanceVolumeProfileAdapter(storageReader, pairSymbol, pairMarketKind);
      const periodMs = VOLUME_PROFILE_DEFAULT_PERIOD_MS;
      const nowMs = Date.now();
      const prefetchedSeed = await prefetchVolumeProfileSeed(pairSymbol, pairMarketKind, adapter, tickSize, periodMs, nowMs);
      if (volumeProfileWarmAbandoned(pairSymbol, pairMarketKind, key)) return;
      const session = await buildAlignedSession(
        adapter,
        tickSize,
        periodMs,
        DEFAULT_BIN_SIZE_MULTIPLIER,
        nowMs,
        prefetchedSeed,
        key,
      );
      if (volumeProfileWarmAbandoned(pairSymbol, pairMarketKind, key)) return;
      if (session === null) {
        scheduleVolumeProfileRetry(pairSymbol, pairMarketKind, key, "NO_TRADES_IN_WINDOW");
        return;
      }
      volumeProfileRetry.delete(key);
      volumeProfileByPair.set(key, {
        adapter,
        session,
        tickSize,
        mode: "continuous",
        periodMs,
        binSizeMultiplier: DEFAULT_BIN_SIZE_MULTIPLIER,
        configGeneration: 0,
        pendingConfig: null,
        instrument: key,
      });
      if (key === pairKey(activeSymbol, activeMarketKind)) {
        const requested = requestedProfileConfigByPair.get(key);
        if (requested) handleProfileConfigMessage(requested, null);
      }
      schedulePreWarm(pairSymbol, pairMarketKind);
    } catch (error) {
      if (volumeProfileWarmAbandoned(pairSymbol, pairMarketKind, key)) return;
      scheduleVolumeProfileRetry(pairSymbol, pairMarketKind, key, "WARMUP_ERROR");
      throw error;
    } finally {
      volumeProfileWarmInFlight.delete(key);
    }
  }

  async function rolloverVolumeProfileIfDue(state, nowMs) {
    if (
      state.pendingConfig !== null ||
      state.mode === "fixed_range" ||
      nowMs < state.session.periodStartTs + state.periodMs
    )
      return;
    const configGeneration = state.configGeneration ?? 0;
    const rebuilt = await buildAlignedSession(
      state.adapter,
      state.tickSize,
      state.periodMs,
      state.binSizeMultiplier,
      nowMs,
      null,
      state.instrument,
    );
    if (rebuilt === null)
      throw new Error("volume profile rollover unavailable");
    if ((state.configGeneration ?? 0) === configGeneration)
      state.session = rebuilt;
  }

  async function pollVolumeProfiles() {
    if (volumeProfilePollInFlight) return;
    volumeProfilePollInFlight = true;
    try {
      const nowMs = Date.now();
      const activeKey = pairKey(activeSymbol, activeMarketKind);
      for (const [key, state] of volumeProfileByPair) {
        if (!warmPairs.has(key) || state.pendingConfig !== null) continue;
        const [marketKind, symbol] = key.split(":");
        const identity = { provider: "BINANCE", symbol, marketKind };
        try {
          await rolloverVolumeProfileIfDue(state, nowMs);
          if (state.mode !== "fixed_range") {
            await pollOpenPeriod(state.session, state.adapter, nowMs);
          }
          analyticsStatus.set(identity, "PROFILE", "READY");
          setReadiness(symbol, marketKind, "volume_profile", "READY");
        } catch (error) {
          analyticsStatus.set(identity, "PROFILE", "UNAVAILABLE");
          setReadiness(symbol, marketKind, "volume_profile", "DEGRADED", {
            reason: "STORAGE_UNAVAILABLE",
          });
          console.error(
            `market data server: volume profile poll failed for ${key}`,
            error?.message ?? error,
          );
          continue;
        }
        if (key === activeKey && state.session.buckets.size > 0) {
          try {
            const profile = computeProfile(state.session.buckets);
            broadcast(
              profileFrame(
                { session: state.session, profile, mode: state.mode },
                activeSymbol,
                activeMarketKind,
              ),
            );
          } catch (error) {
            console.error(
              `market data server: volume profile frame build failed for ${key}`,
              error?.message ?? error,
            );
            analyticsStatus.set(identity, "PROFILE", "UNAVAILABLE");
            setReadiness(symbol, marketKind, "volume_profile", "DEGRADED", {
              reason: "WIRE_VALUE_OUT_OF_RANGE",
            });
          }
        }
      }
    } finally {
      volumeProfilePollInFlight = false;
    }
  }

  async function ensureVpinWarm(pairSymbol, pairMarketKind) {
    const key = pairKey(pairSymbol, pairMarketKind);
    if (!vpinEnabled) {
      vpinWarmupStateByPair.set(key, "DISABLED");
      setReadiness(pairSymbol, pairMarketKind, "vpin", "DISABLED", {
        reason: "DISABLED_BY_CONFIG",
      });
      return;
    }
    if (
      stopped ||
      vpinByPair.has(key) ||
      vpinWarmupJobs.has(key) ||
      !storageReader ||
      Date.now() < (vpinWarmupRetryNotBeforeMs.get(key) ?? 0)
    )
      return;
    if (
      typeof storageReader.readRecentTrades !== "function" ||
      typeof storageReader.readMinuteRollup !== "function"
    )
      return;
    if (
      vpinWarmup === startVpinWarmup &&
      !storageReaderConfigured(storageReader)
    ) {
      console.warn(
        `market data server: vpin warm-up unavailable for ${key}; storage reader is not configured (no local database path or remote endpoint)`,
      );
      vpinWarmupStateByPair.set(key, "UNAVAILABLE");
      setReadiness(pairSymbol, pairMarketKind, "vpin", "UNAVAILABLE", {
        reason: "STORAGE_UNAVAILABLE",
      });
      publishVpinStatusSnapshot(pairSymbol, pairMarketKind);
      return;
    }
    const tickSize = await tickSizeResolver.getBinanceTickSize(
      pairMarketKind,
      pairSymbol,
    );
    if (
      stopped ||
      !warmPairs.has(key) ||
      vpinByPair.has(key) ||
      vpinWarmupJobs.has(key)
    )
      return;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    const nowMs = Date.now();
    vpinWarmupStateByPair.set(key, "WARMING");
    setReadiness(pairSymbol, pairMarketKind, "vpin", "RUNNING", {
      reason: "IN_PROGRESS",
    });
    publishVpinStatusSnapshot(pairSymbol, pairMarketKind);
    let job;
    let session;
    try {
      job = jobOwner.launch(() =>
        vpinWarmup({
          dbPath: storageReader.dbPath,
          remote: storageReader.remote
            ? {
                ...storageReader.remote,
                timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS,
              }
            : storageReader.remote,
          symbol: pairSymbol,
          marketKind: pairMarketKind,
          tickSize,
          nowMs,
          calibrationWindowMs: VPIN_CALIBRATION_WINDOW_MS,
          backfillWindowMs: VPIN_BACKFILL_LOOKBACK_MS,
          engineOptions: { nBaseline: VPIN_N_BASELINE },
          ...vpinBackfillPlan(storageReader),
        }),
      );
      if (
        !job ||
        typeof job.promise?.then !== "function" ||
        typeof job.cancel !== "function"
      ) {
        throw new Error("vpin warm-up factory must return a cancellable job");
      }
      vpinWarmupJobs.set(key, job);
      const result = await job.promise;
      if (stopped || !warmPairs.has(key) || vpinWarmupJobs.get(key) !== job)
        return;
      if (!result?.available) {
        vpinWarmupStateByPair.set(key, "UNAVAILABLE");
        setReadiness(pairSymbol, pairMarketKind, "vpin", "DEGRADED", {
          reason: "RETRY_SCHEDULED",
          metrics: {
            tradesApplied: result?.tradesApplied ?? 0,
            pagesFetched: result?.pagesFetched ?? 0,
          },
        });
        const retryMs = vpinWarmupRetry.failed(
          key,
          result?.reason ?? "NO_RESULT",
          {
            tradesApplied: result?.tradesApplied,
            pagesFetched: result?.pagesFetched,
            slicesRead: result?.slicesRead,
            durationMs: result?.durationMs,
          },
        );
        vpinWarmupRetryNotBeforeMs.set(key, Date.now() + retryMs);
        publishVpinStatusSnapshot(pairSymbol, pairMarketKind);
        return;
      }
      const adapter = createBinanceVolumeProfileAdapter(
        storageReader,
        pairSymbol,
        pairMarketKind,
      );
      session = createVpinSession({
        adapter,
        vBucket: result.vBucket,
        nowMs: result.pollFromTs,
      });
      session.vpinState = result.vpinState;
      session.pollFromTs = result.pollFromTs;
      session.pollCursor = result.pollCursor;
      session.history = Array.isArray(result.history) ? result.history : [];
      vpinByPair.set(key, session);
      vpinLiveUnavailableKeys.delete(key);
      vpinWarmupStateByPair.set(key, "READY");
      setReadiness(pairSymbol, pairMarketKind, "vpin", "READY", {
        metrics: {
          tradesApplied: result.tradesApplied,
          pagesFetched: result.pagesFetched,
          readings: session.history.length,
        },
      });
      vpinWarmupRetryNotBeforeMs.delete(key);
      vpinWarmupRetry.succeeded(key);
      console.info(
        `market data server: vpin worker warm-up completed for ${key}`,
        {
          durationMs: result.durationMs,
          tradesApplied: result.tradesApplied,
          pagesFetched: result.pagesFetched,
          ...(result.slicesRead === undefined
            ? {}
            : { slicesRead: result.slicesRead, chunksRead: result.chunksRead }),
          readings: session.history.length,
        },
      );
    } catch (error) {
      if (!stopped) {
        vpinWarmupStateByPair.set(key, "UNAVAILABLE");
        setReadiness(pairSymbol, pairMarketKind, "vpin", "FAILED", {
          reason: "WORKER_ERROR",
        });
        vpinWarmupRetryNotBeforeMs.set(
          key,
          Date.now() +
            vpinWarmupRetry.failed(
              key,
              "WORKER_FAILED",
              error?.message ?? error,
            ),
        );
        publishVpinStatusSnapshot(pairSymbol, pairMarketKind);
      }
      return;
    } finally {
      if (vpinWarmupJobs.get(key) === job) vpinWarmupJobs.delete(key);
    }
    if (stopped || !vpinByPair.has(key)) return;
    if (pairSymbol === activeSymbol && pairMarketKind === activeMarketKind) {
      const buffer = historyBufferFor(pairSymbol, pairMarketKind);
      try {
        broadcast(
          snapshotFrame(
            buffer.snapshotBars(),
            buffer.snapshotTrades(),
            pairSymbol,
            pairMarketKind,
            inlineMarkers(buffer),
            session.history,
            vpinWarmupStatusFor(pairSymbol, pairMarketKind),
          ),
        );
      } catch (error) {
        console.error(
          `market data server: vpin historical snapshot build failed for ${key}`,
          error?.message ?? error,
        );
      }
    }
  }

  function pollVpin() {
    const nowMs = Date.now();
    for (const [key, session] of vpinByPair) {
      if (
        !warmPairs.has(key) ||
        vpinLiveJobs.has(key) ||
        vpinLiveUnavailableKeys.has(key)
      )
        continue;
      const [pairMarketKind, pairSymbol] = key.split(":");
      const setStatus = (status) => {
        vpinWarmupStateByPair.set(key, status);
        analyticsStatus.set(
          {
            provider: "BINANCE",
            symbol: pairSymbol,
            marketKind: pairMarketKind,
          },
          "VPIN",
          status,
        );
      };
      if (
        vpinLivePoll === startVpinLivePoll &&
        !storageReaderConfigured(storageReader)
      ) {
        console.warn(
          `market data server: vpin live poll unavailable for ${key}; storage reader is not configured (no local database path or remote endpoint)`,
        );
        vpinLiveUnavailableKeys.add(key);
        setStatus("UNAVAILABLE");
        continue;
      }
      let job;
      try {
        job = jobOwner.launch(() =>
          vpinLivePoll({
            dbPath: storageReader?.dbPath,
            remote: storageReader?.remote,
            provider: "binance",
            symbol: pairSymbol,
            marketKind: pairMarketKind,
            vpinState: session.vpinState,
            pollFromTs: session.pollFromTs,
            pollCursor: session.pollCursor,
            nowMs,
          }),
        );
        if (
          !job ||
          typeof job.promise?.then !== "function" ||
          typeof job.cancel !== "function"
        ) {
          throw new Error(
            "vpin live-poll factory must return a cancellable job",
          );
        }
        vpinLiveJobs.set(key, job);
      } catch (error) {
        console.error(
          `market data server: vpin live-poll launch failed for ${key}`,
          error?.message ?? error,
        );
        setStatus("UNAVAILABLE");
        continue;
      }
      job.promise
        .then((pollResult) => {
          if (
            stopped ||
            vpinLiveJobs.get(key) !== job ||
            vpinByPair.get(key) !== session
          )
            return;
          const readings = applyLivePollResult(session, pollResult);
          setStatus("READY");
          if (
            key === pairKey(activeSymbol, activeMarketKind) &&
            readings.length > 0
          ) {
            try {
              for (const reading of readings)
                broadcast(vpinFrame(reading, activeSymbol, activeMarketKind));
            } catch (error) {
              console.error(
                `market data server: vpin frame build failed for ${key}`,
                error?.message ?? error,
              );
              setStatus("UNAVAILABLE");
            }
          }
        })
        .catch((error) => {
          if (!stopped && vpinLiveJobs.get(key) === job) {
            console.error(
              `market data server: vpin live poll failed for ${key}`,
              error?.message ?? error,
            );
            setStatus("UNAVAILABLE");
          }
        })
        .finally(() => {
          if (vpinLiveJobs.get(key) === job) vpinLiveJobs.delete(key);
        });
    }
  }

  function vpinHistoryFor(pairSymbol, pairMarketKind) {
    const session = vpinByPair.get(pairKey(pairSymbol, pairMarketKind));
    return session && session.history.length > 0 ? session.history : undefined;
  }

  function vpinWarmupStatusFor(pairSymbol, pairMarketKind) {
    const key = pairKey(pairSymbol, pairMarketKind);
    return (
      vpinWarmupStateByPair.get(key) ?? (vpinByPair.has(key) ? "READY" : "IDLE")
    );
  }

  function publishVpinStatusSnapshot(pairSymbol, pairMarketKind) {
    if (
      stopped ||
      pairSymbol !== activeSymbol ||
      pairMarketKind !== activeMarketKind
    )
      return;
    const buffer = historyBufferFor(pairSymbol, pairMarketKind);
    try {
      broadcast(
        snapshotFrame(
          buffer.snapshotBars(),
          buffer.snapshotTrades(),
          pairSymbol,
          pairMarketKind,
          inlineMarkers(buffer),
          vpinHistoryFor(pairSymbol, pairMarketKind),
          vpinWarmupStatusFor(pairSymbol, pairMarketKind),
        ),
      );
    } catch (error) {
      console.error(
        `market data server: vpin status snapshot build failed for ${pairKey(pairSymbol, pairMarketKind)}`,
        error?.message ?? error,
      );
    }
  }

  function currentAnalyticsStatus() {
    return {
      symbol: activeSymbol,
      marketKind: activeMarketKind,
      vpin: vpinWarmupStatusFor(activeSymbol, activeMarketKind),
      profile: analyticsStatus.get(
        {
          provider: "BINANCE",
          symbol: activeSymbol,
          marketKind: activeMarketKind,
        },
        "PROFILE",
      ),
    };
  }

  function currentReadiness() {
    const key = pairKey(activeSymbol, activeMarketKind);
    const profile = analyticsStatus.get(
      {
        provider: "BINANCE",
        symbol: activeSymbol,
        marketKind: activeMarketKind,
      },
      "PROFILE",
    );
    const featurePrefix = readinessFeature(activeSymbol, activeMarketKind, "");
    const warmups = { ...readiness.snapshot(featurePrefix) };
    const profileFeature = readinessFeature(
      activeSymbol,
      activeMarketKind,
      "volume_profile",
    );
    if (!warmups[profileFeature]) {
      warmups[profileFeature] = Object.freeze({
        feature: profileFeature,
        state:
          profile === "READY"
            ? "READY"
            : profile === "UNAVAILABLE"
              ? "UNAVAILABLE"
              : "IDLE",
        reason:
          profile === "UNAVAILABLE"
            ? "STORAGE_UNAVAILABLE"
            : profile === "READY"
              ? null
              : "NOT_STARTED",
        updatedAt: null,
      });
    }
    const liquidityState = liquidity.readiness?.()[key];
    if (liquidityState) {
      for (const tier of ["recent", "deep"]) {
        const value = liquidityState[tier];
        const feature = readinessFeature(
          activeSymbol,
          activeMarketKind,
          `liquidity_${tier}`,
        );
        warmups[feature] = Object.freeze({
          feature,
          ...value,
          updatedAt: value.completedAt ?? value.startedAt ?? null,
        });
      }
    }
    const transport = currentAggregateHealth();
    const recording = recordingStatus();
    const warmupStates = Object.values(warmups).map((entry) => entry.state);
    const analyticsReadiness = warmupStates.some(
      (state) =>
        state === "FAILED" || state === "UNAVAILABLE" || state === "DEGRADED",
    )
      ? "DEGRADED"
      : warmupStates.some(
            (state) => state === "STARTING" || state === "RUNNING",
          )
        ? "RUNNING"
        : warmupStates.some((state) => state === "READY")
          ? "READY"
          : "IDLE";
    return Object.freeze({
      identity: activeIdentity(),
      dimensions: Object.freeze({
        transport:
          transport?.recoveryState === "RECOVERING"
            ? "DEGRADED"
            : (transport?.recoveryState ?? "STARTING"),
        capture: recording.stale ? "DEGRADED" : "READY",
        storage: recording.available ? "READY" : "UNAVAILABLE",
        analytics: analyticsReadiness,
      }),
      warmups: Object.freeze(warmups),
    });
  }

  // Open the feeds of every tracked pair that has none yet. A route that was
  // not connected at start-up (PERPETUAL comes up after SPOT) throws; the
  // maintenance poll calls this again until every pair is on.
  function subscribeTrackedPairs() {
    for (const [key, pair] of trackedPairs) {
      if (trackedSubscribed.has(key)) continue;
      if (
        pair.symbol === activeSymbol &&
        pair.marketKind === activeMarketKind
      ) {
        trackedSubscribed.add(key);
        continue;
      }
      try {
        subscribePair(pair.symbol, pair.marketKind);
        trackedSubscribed.add(key);
      } catch {
        // The route is not connected yet; the next poll tries again.
      }
    }
  }

  function maintainDesiredSubscriptions() {
    subscribeTrackedPairs();
    for (const pair of warmPairs.values()) {
      ensurePairWarm(pair.symbol, pair.marketKind).catch((error) => {
        console.error(
          `market data server: kline backfill failed for ${pairKey(pair.symbol, pair.marketKind)}`,
          error?.message ?? error,
        );
      });
    }
    if (typeof connection.recoverStaleSubscription === "function") {
      const desiredFeeds = [
        {
          symbol: activeSymbol,
          marketKind: activeMarketKind,
          eventType: EVENT_TYPES.DEPTH,
        },
      ];
      for (const pair of warmPairs.values()) {
        desiredFeeds.push(
          {
            symbol: pair.symbol,
            marketKind: pair.marketKind,
            eventType: EVENT_TYPES.TRADE,
          },
          {
            symbol: pair.symbol,
            marketKind: pair.marketKind,
            eventType: EVENT_TYPES.KLINE,
            interval: KLINE_INTERVAL,
          },
        );
      }
      for (const pair of trackedPairs.values()) {
        desiredFeeds.push(
          {
            symbol: pair.symbol,
            marketKind: pair.marketKind,
            eventType: EVENT_TYPES.DEPTH,
          },
          {
            symbol: pair.symbol,
            marketKind: pair.marketKind,
            eventType: EVENT_TYPES.TRADE,
          },
        );
      }
      for (const request of desiredFeeds) {
        const health = connection.getFeedHealth(
          request.marketKind,
          request.symbol,
          request.eventType,
          request.interval,
        );
        if (health?.stale === true && health.recoveryState !== "RECOVERING") {
          const recovered = connection.recoverStaleSubscription(request);
          if (recovered) break;
        }
      }
    }
  }

  function performSwitch(newSymbol, newMarketKind) {
    if (newSymbol === activeSymbol && newMarketKind === activeMarketKind) {
      return;
    }
    const previousPair = { symbol: activeSymbol, marketKind: activeMarketKind };
    subscribePair(newSymbol, newMarketKind);
    // A tracked pair keeps its feeds: the heatmap goes on sampling it off screen.
    if (
      !trackedPairs.has(pairKey(previousPair.symbol, previousPair.marketKind))
    ) {
      try {
        unsubscribePair(previousPair.symbol, previousPair.marketKind);
      } catch (error) {
        console.error(
          "market data server: failed to release the previous pair's feeds",
          error?.message ?? error,
        );
      }
    }
    warmPairs.clear();
    activeSymbol = newSymbol;
    activeMarketKind = newMarketKind;
    const activeKey = pairKey(activeSymbol, activeMarketKind);
    // An explicit user revisit is a meaningful retry signal and bypasses the
    // maintenance-loop cooldown. Passive health polling remains throttled.
    aggressivePoolWarmRetryNotBeforeMs.delete(activeKey);
    largeTradeWarmRetryNotBeforeMs.delete(activeKey);
    warmPairs.set(activeKey, {
      symbol: activeSymbol,
      marketKind: activeMarketKind,
    });
    lastHealthFingerprint = null;
    lastBookFingerprint = null;
    liquidity.reset();
    broadcast(selectionFrame(activeSymbol, activeMarketKind));
    const switchLiquidityFrames = liquidity.snapshotFrames(
      activeMarketKind,
      activeSymbol,
    );
    for (const client of clients)
      liquidityReplayer.start(client, switchLiquidityFrames);
    l2Channel.reselect();
    icebergChannel.reselect();
    exhaustionChannel.reselect();
    initiativeChannel.reselect();
    const buffer = activeHistoryBuffer();
    broadcast(
      snapshotFrame(
        buffer.snapshotBars(),
        buffer.snapshotTrades(),
        activeSymbol,
        activeMarketKind,
        inlineMarkers(buffer),
        vpinHistoryFor(activeSymbol, activeMarketKind),
        vpinWarmupStatusFor(activeSymbol, activeMarketKind),
      ),
    );
    const switchMarkerFrames = markerHistoryFrames(
      activeIdentity(),
      buffer.snapshotMarkers(),
    );
    for (const client of markerHistoryClients)
      markerHistoryReplayer.start(client, switchMarkerFrames);
    const pairAtSwitch = { symbol: activeSymbol, marketKind: activeMarketKind };
    ensurePairWarm(pairAtSwitch.symbol, pairAtSwitch.marketKind).catch(
      (error) => {
        console.error(
          `market data server: kline backfill failed for ${pairKey(pairAtSwitch.symbol, pairAtSwitch.marketKind)}`,
          error?.message ?? error,
        );
      },
    );
    checkHealthAndMaybeBroadcast();
    checkBookAndMaybeBroadcast();
  }

  function allowSelectionRequest(client) {
    return selectionRateLimiter.allowSelectionRequest(client);
  }

  const PROFILE_CONFIG_KEYS = [
    "bin_size_multiplier",
    "mode",
    "period_ms",
    "range_end_ts",
    "range_start_ts",
    "type",
  ];
  const PROFILE_HISTORY_KEYS = [
    "bin_size_multiplier",
    "mode",
    "period_ms",
    "ranges",
    "request_id",
    "type",
  ];
  function parseHistoryRanges(rawRanges, periodMs) {
    return sharedParseHistoryRanges(rawRanges, periodMs);
  }

  function handleProfileHistoryMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== PROFILE_HISTORY_KEYS.length ||
      !keys.every((key, index) => key === PROFILE_HISTORY_KEYS[index])
    ) {
      console.warn(
        "market data server: dropped profile_history request with unexpected fields",
      );
      return;
    }
    if (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0) {
      console.warn(
        "market data server: dropped profile_history request with an invalid period",
      );
      return;
    }
    if (
      (parsed.mode !== "continuous" && parsed.mode !== "per_candle") ||
      !Number.isSafeInteger(parsed.request_id) ||
      parsed.request_id <= 0
    ) {
      console.warn(
        "market data server: dropped profile_history request with invalid mode or request id",
      );
      return;
    }
    if (!isValidBinSizeMultiplier(parsed.bin_size_multiplier)) {
      console.warn(
        "market data server: dropped profile_history request with an invalid bin-size multiplier",
      );
      return;
    }
    const ranges = parseHistoryRanges(parsed.ranges, parsed.period_ms);
    if (ranges === null) {
      console.warn(
        "market data server: dropped profile_history request with invalid ranges",
      );
      return;
    }
    sendHistoricalProfiles(
      client,
      activeSymbol,
      activeMarketKind,
      ranges,
      parsed.period_ms,
      parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER,
      parsed.mode,
      parsed.request_id,
    );
  }

  function handleProfileConfigMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== PROFILE_CONFIG_KEYS.length ||
      !keys.every((key, index) => key === PROFILE_CONFIG_KEYS[index])
    ) {
      console.warn(
        "market data server: dropped profile_config request with unexpected fields",
      );
      return;
    }
    if (!PROFILE_CONFIG_MODES.has(parsed.mode)) {
      console.warn(
        "market data server: dropped profile_config request with an unrecognized mode",
      );
      return;
    }
    if (
      (parsed.period_ms !== null &&
        (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0)) ||
      !isValidBinSizeMultiplier(parsed.bin_size_multiplier)
    ) {
      console.warn(
        "market data server: dropped profile_config request with invalid field values",
      );
      return;
    }
    if (parsed.mode === "fixed_range") {
      if (
        !Number.isSafeInteger(parsed.range_start_ts) ||
        parsed.range_start_ts < 0 ||
        !Number.isSafeInteger(parsed.range_end_ts) ||
        parsed.range_end_ts <= parsed.range_start_ts
      ) {
        console.warn(
          "market data server: dropped fixed_range profile_config request with an invalid range",
        );
        return;
      }
      sendFixedRangeProfile(
        client,
        activeSymbol,
        activeMarketKind,
        parsed.range_start_ts,
        parsed.range_end_ts,
        parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER,
      ).catch((error) => {
        console.error(
          "market data server: fixed_range profile request failed",
          error?.message ?? error,
        );
      });
      return;
    }
    if (parsed.range_start_ts !== null || parsed.range_end_ts !== null) {
      console.warn(
        "market data server: dropped profile_config request with a range on a non-fixed_range mode",
      );
      return;
    }
    const key = pairKey(activeSymbol, activeMarketKind);
    const state = volumeProfileByPair.get(key);
    requestedProfileConfigByPair.set(key, parsed);
    if (!state) return;
    const base = state.pendingConfig ?? state;
    const nextPeriodMs =
      parsed.period_ms !== null ? parsed.period_ms : base.periodMs;
    const nextBinSizeMultiplier =
      parsed.bin_size_multiplier !== null
        ? parsed.bin_size_multiplier
        : base.binSizeMultiplier;
    const gridChanged =
      nextPeriodMs !== base.periodMs ||
      nextBinSizeMultiplier !== base.binSizeMultiplier ||
      parsed.mode !== base.mode;
    if (!gridChanged) return;
    const configGeneration = (state.configGeneration ?? 0) + 1;
    state.configGeneration = configGeneration;
    const pendingConfig = {
      mode: parsed.mode,
      periodMs: nextPeriodMs,
      binSizeMultiplier: nextBinSizeMultiplier,
    };
    state.pendingConfig = pendingConfig;
    buildAlignedSession(
      state.adapter,
      state.tickSize,
      nextPeriodMs,
      nextBinSizeMultiplier,
      Date.now(),
      null,
      state.instrument,
    )
      .then((rebuilt) => {
        if (
          volumeProfileByPair.get(key) === state &&
          state.configGeneration === configGeneration
        ) {
          if (rebuilt === null) {
            state.pendingConfig = null;
            return;
          }
          state.mode = pendingConfig.mode;
          state.periodMs = pendingConfig.periodMs;
          state.binSizeMultiplier = pendingConfig.binSizeMultiplier;
          state.session = rebuilt;
          state.pendingConfig = null;
        }
      })
      .catch((error) => {
        if (
          volumeProfileByPair.get(key) === state &&
          state.configGeneration === configGeneration
        )
          state.pendingConfig = null;
        console.error(
          "market data server: volume profile rebuild failed",
          error?.message ?? error,
        );
      });
  }

  function schedulePreWarm(pairSymbol, pairMarketKind) {
    if (!volumeProfileCache || preWarmTimer !== null || preWarmMs <= 0) return;
    const key = pairKey(pairSymbol, pairMarketKind);
    const state = volumeProfileByPair.get(key);
    if (!state) return;
    const endMinute = floorToMinute(Date.now());
    let cursor = endMinute;
    const floorMinute = endMinute - preWarmMs;

    const step = async () => {
      preWarmTimer = null;
      if (stopped || cursor <= floorMinute) return;
      const chunkStart = Math.max(floorMinute, cursor - preWarmChunkMs);
      try {
        await ensureCoverage({
          cache: volumeProfileCache,
          adapter: state.adapter,
          instrument: historyInstrumentKey(pairSymbol, pairMarketKind),
          tickSize: state.tickSize,
          fromMinuteTs: chunkStart,
          toMinuteTs: cursor,
        });
      } catch (error) {
        console.error(
          "market data server: volume profile pre-warm chunk failed, skipping it and continuing",
          error?.message ?? error,
        );
      }
      cursor = chunkStart;
      if (cursor > floorMinute) {
        preWarmTimer = setTimeout(() => {
          step().catch((error) =>
            console.error(
              "market data server: volume profile pre-warm failed",
              error?.message ?? error,
            ),
          );
        }, preWarmPauseMs);
        preWarmTimer.unref?.();
      }
    };

    preWarmTimer = setTimeout(() => {
      step().catch((error) =>
        console.error(
          "market data server: volume profile pre-warm failed",
          error?.message ?? error,
        ),
      );
    }, preWarmPauseMs);
    preWarmTimer.unref?.();
  }

  function profileHistoryKeyFor(
    pairSymbol,
    pairMarketKind,
    tickSize,
    ranges,
    periodMs,
    binSizeMultiplier,
  ) {
    return `${pairSymbol}\0${pairMarketKind}\0${tickSize}\0${periodMs}\0${binSizeMultiplier}\0${JSON.stringify(ranges)}`;
  }

  function releaseProfileHistorySubscription(client) {
    const requestKey = profileHistoryJobsByClient.get(client);
    profileHistoryJobsByClient.delete(client);
    if (requestKey === undefined) return;
    const entry = profileHistoryJobsByKey.get(requestKey);
    if (!entry) return;
    entry.subscribers.delete(client);
    if (entry.subscribers.size === 0) {
      profileHistoryJobsByKey.delete(requestKey);
      jobOwner.cancel(entry.job);
    }
  }

  function sendBuiltProfilesTo(
    targetClient,
    pairSymbol,
    pairMarketKind,
    mode,
    historyRequestId,
    built,
  ) {
    const stillActive = () =>
      activeSymbol === pairSymbol && activeMarketKind === pairMarketKind;
    if (
      built === null ||
      stopped ||
      !clients.has(targetClient) ||
      !stillActive()
    )
      return false;
    for (const { session, profile } of built) {
      if (stopped || !clients.has(targetClient) || !stillActive()) return true;
      try {
        safelySend(
          targetClient,
          profileFrame(
            {
              session,
              profile,
              mode,
              deliveryScope: "HISTORICAL",
              historyRequestId,
            },
            pairSymbol,
            pairMarketKind,
          ),
        );
      } catch (error) {
        console.error(
          "market data server: historical profile frame build failed",
          error?.message ?? error,
        );
      }
    }
    return true;
  }

  function sendHistoricalProfiles(
    client,
    pairSymbol,
    pairMarketKind,
    ranges,
    periodMs,
    binSizeMultiplier,
    mode,
    historyRequestId,
  ) {
    ranges = ranges.filter(
      (range) => range.rangeEndTs <= floorToMinute(Date.now()),
    );
    if (ranges.length === 0) return;
    if (!volumeProfileCache || !storageReader || !clients.has(client))
      return false;
    const state = volumeProfileByPair.get(pairKey(pairSymbol, pairMarketKind));
    if (!state) return false;
    const sendBuilt = (built) =>
      sendBuiltProfilesTo(
        client,
        pairSymbol,
        pairMarketKind,
        mode,
        historyRequestId,
        built,
      );
    const canOffload =
      typeof storageReader.dbPath === "string" &&
      typeof volumeProfileCache.dbPath === "string";
    if (canOffload) {
      releaseProfileHistorySubscription(client);
      const requestKey = profileHistoryKeyFor(
        pairSymbol,
        pairMarketKind,
        state.tickSize,
        ranges,
        periodMs,
        binSizeMultiplier,
      );
      let entry = profileHistoryJobsByKey.get(requestKey);
      if (!entry) {
        let job;
        try {
          job = jobOwner.launch(() =>
            startVolumeProfileHistoryJob({
              provider: "BINANCE",
              storageDbPath: storageReader.dbPath,
              cacheDbPath: volumeProfileCache.dbPath,
              symbol: pairSymbol,
              marketKind: pairMarketKind,
              instrument: historyInstrumentKey(pairSymbol, pairMarketKind),
              tickSize: state.tickSize,
              ranges,
              periodMs,
              binSizeMultiplier,
              nowMs: Date.now(),
            }),
          );
        } catch (error) {
          console.error(
            "market data server: historical profile worker could not start",
            error?.message ?? error,
          );
          return false;
        }
        entry = { job, subscribers: new Map() };
        profileHistoryJobsByKey.set(requestKey, entry);
        job.promise
          .then((built) => {
            if (profileHistoryJobsByKey.get(requestKey) !== entry) return;
            profileHistoryJobsByKey.delete(requestKey);
            for (const [subscribedClient, subscription] of entry.subscribers) {
              profileHistoryJobsByClient.delete(subscribedClient);
              sendBuiltProfilesTo(
                subscribedClient,
                pairSymbol,
                pairMarketKind,
                subscription.mode,
                subscription.historyRequestId,
                built,
              );
            }
          })
          .catch((error) => {
            if (profileHistoryJobsByKey.get(requestKey) !== entry) return;
            profileHistoryJobsByKey.delete(requestKey);
            for (const subscribedClient of entry.subscribers.keys())
              profileHistoryJobsByClient.delete(subscribedClient);
            console.error(
              "market data server: historical profile worker failed",
              error?.message ?? error,
            );
          });
      }
      entry.subscribers.set(client, { mode, historyRequestId });
      profileHistoryJobsByClient.set(client, requestKey);
      return true;
    }
    Promise.resolve(
      (async () => {
        // Historical zones size their bins from the same volatility reading as the
        // live session, so a closed zone and the developing period beside it share
        // one grid.
        const atrReading = await volumeProfileAtr.getReading(
          pairKey(pairSymbol, pairMarketKind),
          {
            readCandles: (options) => state.adapter.readCandles(options),
            readPriceRange: (window) =>
              state.adapter.readPriceRange(window.fromTs, window.toTs),
          },
        );
        return buildHistoricalProfiles({
          cache: volumeProfileCache,
          adapter: state.adapter,
          instrument: historyInstrumentKey(pairSymbol, pairMarketKind),
          tickSize: state.tickSize,
          ranges,
          periodMs,
          binSizeMultiplier,
          atrReading,
          nowMs: Date.now(),
        });
      })(),
    )
      .then((built) => {
        sendBuilt(built);
      })
      .catch((error) => {
        console.error(
          "market data server: historical profile build failed",
          error?.message ?? error,
        );
      });
    return true;
  }

  async function sendFixedRangeProfile(
    client,
    pairSymbol,
    pairMarketKind,
    rangeStartTs,
    rangeEndTs,
    binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  ) {
    if (!storageReader || !clients.has(client)) return;
    const tickSize = await tickSizeResolver.getBinanceTickSize(
      pairMarketKind,
      pairSymbol,
    );
    const stillActive = () =>
      activeSymbol === pairSymbol && activeMarketKind === pairMarketKind;
    if (
      stopped ||
      !Number.isFinite(tickSize) ||
      tickSize <= 0 ||
      !clients.has(client) ||
      !stillActive()
    )
      return;
    const adapter = createBinanceVolumeProfileAdapter(
      storageReader,
      pairSymbol,
      pairMarketKind,
    );
    const params = await deriveBucketingParams({
      adapter,
      tickSize,
      fromTs: rangeStartTs,
      toTs: rangeEndTs,
      binSizeMultiplier,
    });
    if (params === null || stopped || !clients.has(client) || !stillActive())
      return;
    const { originPrice, rowWidth } = params;
    const { buckets: readerBuckets, available } =
      await adapter.readVolumeProfile(
        rangeStartTs,
        rangeEndTs,
        originPrice,
        rowWidth,
      );
    if (
      !available ||
      readerBuckets.length === 0 ||
      stopped ||
      !clients.has(client) ||
      !stillActive()
    )
      return;
    const buckets = new Map(
      readerBuckets.map((row) => [
        row.bucket,
        {
          volume: row.volume,
          buyVolume: row.buyVolume,
          sellVolume: row.sellVolume,
        },
      ]),
    );
    const session = {
      periodStartTs: rangeStartTs,
      periodEndTs: rangeEndTs,
      rowWidth,
      originPrice,
      buckets,
    };
    try {
      rescaleSessionToFit(session);
      const profile = computeProfile(session.buckets);
      const frame = profileFrame(
        { session, profile, mode: "fixed_range", deliveryScope: "FIXED_RANGE" },
        pairSymbol,
        pairMarketKind,
      );
      safelySend(client, frame);
    } catch (error) {
      console.error(
        "market data server: fixed_range profile frame build failed",
        error?.message ?? error,
      );
    }
  }

  function handleClientMessage(raw, client) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        "market data server: dropped malformed (non-JSON) client message",
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      console.warn("market data server: droppedmalformed client message");
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
      aggressiveHistory.handle(parsed, client, {
        symbol: activeSymbol,
        marketKind: activeMarketKind,
      });
      return;
    }
    if (parsed.type === "exhaustion_history") {
      const fromTs = parseExhaustionHistory(parsed);
      if (fromTs === null) {
        console.warn("market data server: dropped exhaustion_history request with unexpected fields");
        return;
      }
      if (exhaustionEnabled) exhaustionIndicator.requestHistory({ marketKind: activeMarketKind, symbol: activeSymbol }, fromTs);
      return;
    }
    if (parsed.type === "initiative_history") {
      const fromTs = parseInitiativeHistory(parsed);
      if (fromTs === null) {
        console.warn("market data server: dropped initiative_history request with unexpected fields");
        return;
      }
      if (initiativeEnabled) initiativeIndicator.requestHistory({ marketKind: activeMarketKind, symbol: activeSymbol }, fromTs);
      return;
    }
    if (parsed.type === "delta_profile") {
      deltaProfile.handle(parsed, client, { symbol: activeSymbol, marketKind: activeMarketKind });
      return;
    }
    if (parsed.type === "band_history") {
      bandHistory.handle(parsed, client, { symbol: activeSymbol, marketKind: activeMarketKind });
      return;
    }
    if (parsed.type === "wall_history" || parsed.type === "l2_event_history") {
      historyRequests.handle(parsed, client, { symbol: activeSymbol, marketKind: activeMarketKind });
      return;
    }
    if (parsed.type === "liquidity_resync") {
      if (Object.keys(parsed).length !== 1) {
        console.warn(
          "market data server: dropped liquidity_resync request with unexpected fields",
        );
        return;
      }
      liquidityReplayer.resync(client);
      return;
    }
    if (parsed.type === "l2_resync") {
      const channel = parseL2Resync(parsed);
      if (channel === null) {
        console.warn(
          "market data server: dropped l2_resync request with unexpected fields",
        );
        return;
      }
      l2Channel.resync(client, channel);
      return;
    }
    if (parsed.type === "capabilities") {
      const flags = parseCapabilities(parsed);
      if (flags === null) {
        console.warn(
          "market data server: dropped capabilities request with unexpected fields",
        );
        return;
      }
      if (!clients.has(client)) return;
      if (!flags.has("marker_history")) {
        markerHistoryClients.delete(client);
        markerHistoryReplayer.forget(client);
      } else if (!markerHistoryClients.has(client)) {
        markerHistoryClients.add(client);
        const buffer = activeHistoryBuffer();
        markerHistoryReplayer.start(
          client,
          markerHistoryFrames(activeIdentity(), buffer.snapshotMarkers()),
        );
      }
      l2Channel.subscribe(client, flags);
      icebergChannel.subscribe(client, flags);
      exhaustionChannel.subscribe(client, flags);
      initiativeChannel.subscribe(client, flags);
      return;
    }
    if (parsed.type !== "select") {
      console.warn(
        "market data server: dropped client message with unrecognized type",
        parsed.type,
      );
      return;
    }
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "marketKind" ||
      keys[1] !== "symbol" ||
      keys[2] !== "type"
    ) {
      console.warn(
        "market data server: dropped select request with unexpected fields",
      );
      return;
    }
    let requestedSymbol;
    try {
      requestedSymbol = fromWireSymbol(parsed.symbol);
    } catch {
      console.warn(
        "market data server: dropped select request with an unrecognized symbol shape",
      );
      return;
    }
    const requestedMarketKind = parsed.marketKind;
    if (
      !isAllowedSymbol(requestedSymbol) ||
      !isAllowedMarketKind(requestedMarketKind)
    ) {
      console.error(
        "market data server: dropped select request for an unproven symbol/marketKind pair",
        requestedSymbol,
        requestedMarketKind,
      );
      return;
    }
    if (
      requestedSymbol === activeSymbol &&
      requestedMarketKind === activeMarketKind
    ) {
      cancelPendingSelection();
      return;
    }
    if (!allowSelectionRequest(client)) {
      console.error(
        "market data server: closed client that exceeded the pair-selection rate limit",
      );
      try {
        client?.close?.(1008, "Too many pair selection requests");
      } catch {
        void 0;
      }
      return;
    }
    requestSwitch(requestedSymbol, requestedMarketKind);
  }

  function routesReadyFor(pairMarketKind) {
    try {
      return requiredRoutesConnected(connection.getStatus(), pairMarketKind);
    } catch {
      return false;
    }
  }

  function cancelPendingSelection() {
    pendingSelection = null;
    if (pendingSelectionTimer !== null) {
      clearTimeout(pendingSelectionTimer);
      pendingSelectionTimer = null;
    }
  }

  function requestSwitch(newSymbol, newMarketKind) {
    cancelPendingSelection();
    try {
      performSwitch(newSymbol, newMarketKind);
    } catch (error) {
      if (routesReadyFor(newMarketKind)) throw error;
      pendingSelection = { symbol: newSymbol, marketKind: newMarketKind };
      console.warn(
        `market data server: ${pairKey(newSymbol, newMarketKind)} is selected once its Binance routes connect`,
      );
      schedulePendingSelection();
    }
  }

  function schedulePendingSelection() {
    if (pendingSelectionTimer !== null || stopped) return;
    pendingSelectionTimer = setTimeout(applyPendingSelection, connectPollMs);
    pendingSelectionTimer.unref?.();
  }

  function applyPendingSelection() {
    pendingSelectionTimer = null;
    if (stopped || pendingSelection === null) return;
    if (!routesReadyFor(pendingSelection.marketKind)) {
      schedulePendingSelection();
      return;
    }
    const { symbol: pendingSymbol, marketKind: pendingMarketKind } =
      pendingSelection;
    pendingSelection = null;
    try {
      performSwitch(pendingSymbol, pendingMarketKind);
    } catch (error) {
      reportControlPlaneFailure("pending pair selection", error);
    }
  }

  function requiredRoutesConnected(status, pairMarketKind) {
    if (status?.[pairMarketKind]?.public !== "CONNECTED") return false;
    return (
      pairMarketKind !== MARKET_KINDS.PERPETUAL ||
      status?.[pairMarketKind]?.market === "CONNECTED"
    );
  }

  function waitForRequiredRoutesConnected(generationAtStart) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + connectTimeoutMs;
      const poll = () => {
        if (stopped || generationAtStart !== lifecycleGeneration) {
          reject(
            new Error(
              "market data server: startup was stopped or superseded before the routes connected",
            ),
          );
          return;
        }
        let status;
        try {
          status = connection.getStatus();
        } catch (error) {
          reject(
            new Error(
              "market data server: failed to read route status during startup",
              { cause: error },
            ),
          );
          return;
        }
        if (requiredRoutesConnected(status, activeMarketKind)) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `market data server: required routes never reached CONNECTED within ${connectTimeoutMs}ms`,
            ),
          );
          return;
        }
        setTimeout(poll, connectPollMs);
      };
      poll();
    });
  }

  async function start() {
    if (started) {
      throw new Error(
        "market data server: start() called twice without stop()",
      );
    }
    if (stopPromise) {
      if (!jobOwner.canRestart())
        throw new Error(
          "market data server: previous worker shutdown is pending or failed",
        );
      jobOwner = createAnalyticsJobOwner();
      stopPromise = null;
    }
    started = true;
    stopped = false;
    lifecycleGeneration += 1;
    const generationAtStart = lifecycleGeneration;
    try {
      unsubscribeMessage = connection.onMessage((envelope) => {
        try {
          handleEnvelope(envelope);
        } catch (error) {
          reportControlPlaneFailure("envelope processing", error);
        }
      });
      connection.connect();
      await waitForRequiredRoutesConnected(generationAtStart);
      subscribePair(activeSymbol, activeMarketKind);
      subscribeTrackedPairs();
      checkHealthAndMaybeBroadcast();
      checkBookAndMaybeBroadcast();
    } catch (error) {
      started = false;
      stopped = true;
      lifecycleGeneration += 1;
      try {
        unsubscribeMessage?.();
      } catch (cleanupError) {
        console.error(
          "market data server: startup listener cleanup failed",
          cleanupError?.message ?? cleanupError,
        );
      }
      unsubscribeMessage = null;
      try {
        connection.disconnect();
      } catch (cleanupError) {
        console.error(
          "market data server: startup connection cleanup failed",
          cleanupError?.message ?? cleanupError,
        );
      }
      throw error;
    }
    const pairAtStart = { symbol: activeSymbol, marketKind: activeMarketKind };
    ensurePairWarm(pairAtStart.symbol, pairAtStart.marketKind).catch(
      (error) => {
        console.error(
          `market data server: kline backfill failed for ${pairKey(pairAtStart.symbol, pairAtStart.marketKind)}`,
          error?.message ?? error,
        );
      },
    );
    healthPollTimer = setInterval(() => {
      for (const [scope, operation] of [
        ["subscription maintenance", maintainDesiredSubscriptions],
        ["health check", checkHealthAndMaybeBroadcast],
        ["order-book check", checkBookAndMaybeBroadcast],
      ]) {
        try {
          operation();
        } catch (error) {
          reportControlPlaneFailure(scope, error);
        }
      }
    }, healthPollMs);
    healthPollTimer.unref?.();
    l2Memory.start();
    icebergIndicator.start();
    icebergTickTimer = setInterval(() => {
      try {
        icebergIndicator.tick(now());
      } catch (error) {
        reportControlPlaneFailure("iceberg tick", error);
      }
    }, 1000);
    icebergTickTimer.unref?.();
    exhaustionIndicator.start();
    if (exhaustionEnabled) {
      exhaustionTickTimer = setInterval(() => {
        try {
          exhaustionIndicator.tick(indicatorPairs(), now());
        } catch (error) {
          reportControlPlaneFailure("exhaustion tick", error);
        }
        try {
          candleMonitor.tick(indicatorPairs(), now());
        } catch (error) {
          reportControlPlaneFailure("candle monitor tick", error);
        }
      }, 1000);
      exhaustionTickTimer.unref?.();
    }
    initiativeIndicator.start();
    if (initiativeEnabled) {
      initiativeTickTimer = setInterval(() => {
        try {
          initiativeIndicator.tick(indicatorPairs(), now());
        } catch (error) {
          reportControlPlaneFailure("initiative tick", error);
        }
      }, 1000);
      initiativeTickTimer.unref?.();
    }
    liquidity.start({
      activePair: () => ({
        marketKind: activeMarketKind,
        symbol: activeSymbol,
      }),
      pairs: () =>
        [...trackedPairs.values()].map((pair) => ({
          marketKind: pair.marketKind,
          symbol: pair.symbol,
        })),
      publish: broadcast,
      publishSnapshot: (frames) => liquidityReplayer.announce(frames),
      publishL2: (out, pair) => l2Channel.publish(out, pair),
      deepAdmission,
      hasClients: () => clients.size > 0,
    });
    volumeProfilePollTimer = setInterval(() => {
      pollVolumeProfiles().catch((error) => {
        reportControlPlaneFailure("volume profile poll", error);
      });
    }, volumeProfilePollMs);
    volumeProfilePollTimer.unref?.();
    if (vpinEnabled) {
      vpinPollTimer = setInterval(() => {
        try {
          pollVpin();
        } catch (error) {
          reportControlPlaneFailure("vpin poll", error);
        }
      }, vpinPollMs);
      vpinPollTimer.unref?.();
    }
    liquidityStatsTimer = setInterval(() => {
      if (typeof liquidity.stats === "function") {
        console.info(
          "market data server: liquidity tick timing",
          liquidity.stats(),
        );
      }
    }, LIQUIDITY_STATS_LOG_MS);
    liquidityStatsTimer.unref?.();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const errors = [];
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    stopPromise.catch(() => {});
    stopped = true;
    for (const entry of profileHistoryJobsByKey.values())
      jobOwner.cancel(entry.job);
    profileHistoryJobsByKey.clear();
    profileHistoryJobsByClient.clear();
    aggressiveHistory.dispose();
    deltaProfile.dispose();
    bandHistory.dispose();
    historyRequests.dispose();
    liquidityReplayer.stopAll();
    markerHistoryReplayer.stopAll();
    l2Channel.stopAll();
    icebergChannel.stopAll();
    if (icebergTickTimer) {
      clearInterval(icebergTickTimer);
      icebergTickTimer = null;
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
    clientSender.clear();
    started = false;
    lifecycleGeneration += 1;
    for (const waiter of [...deepAdmissionTimers]) settleDeepAdmission(waiter);
    largeTradeWarmProgress.clear();
    liquidity.stop();
    l2Memory.stop();
    if (healthPollTimer) {
      clearInterval(healthPollTimer);
      healthPollTimer = null;
    }
    cancelPendingSelection();
    if (volumeProfilePollTimer) {
      clearInterval(volumeProfilePollTimer);
      volumeProfilePollTimer = null;
    }
    if (liquidityStatsTimer) {
      clearInterval(liquidityStatsTimer);
      liquidityStatsTimer = null;
    }
    if (preWarmTimer) {
      clearTimeout(preWarmTimer);
      preWarmTimer = null;
    }
    if (vpinPollTimer) {
      clearInterval(vpinPollTimer);
      vpinPollTimer = null;
    }
    volumeProfileByPair.clear();
    requestedProfileConfigByPair.clear();
    analyticsStatus.clear();
    vpinByPair.clear();
    for (const job of vpinWarmupJobs.values()) jobOwner.cancel(job);
    vpinWarmupJobs.clear();
    for (const job of vpinLiveJobs.values()) jobOwner.cancel(job);
    vpinLiveJobs.clear();
    vpinLiveUnavailableKeys.clear();
    vpinWarmupStateByPair.clear();
    vpinWarmupRetryNotBeforeMs.clear();
    vpinWarmupRetry.clear();
    try {
      unsubscribeMessage?.();
    } catch (error) {
      errors.push(error);
    }
    unsubscribeMessage = null;
    lastBookFingerprint = null;
    lastHealthFingerprint = null;
    selectionRateLimiter.clear();
    wireFailures.clear();
    closeAllClients();
    try {
      connection.disconnect();
    } catch (error) {
      errors.push(error);
    }
    jobOwner.stop(errors).then(resolveStop, rejectStop);
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    handleClientConnected,
    handleClientDisconnected,
    handleClientMessage,
    clientCount: () => clients.size,
    vpinWarmupStatusFor,
    currentAnalyticsStatus,
    currentReadiness,
    recordingStatus,
  });
}

module.exports = {
  createMarketDataServer,
  SERVER_CONSUMER_ID,
  KLINE_INTERVAL,
  BACKFILL_DAYS,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  DEFAULT_CLIENT_BUFFER_GRACE_MS,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
  CONTROL_PLANE_FAILURE_REASON,
  VPIN_WARMUP_REMOTE_TIMEOUT_MS,
};
