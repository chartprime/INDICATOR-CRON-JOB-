const { createAnalyticsJobOwner } = require("../platform/analytics-job-owner");
const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { REALTIME_ENDPOINT } = require("../providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../providers/dxfeed/dxlink-connection");
const { requestDevelopmentToken, isRetryableTokenBrokerError } = require("../providers/dxfeed/token-broker-client");
const { waitForAuthorized, waitForChannelOpened, AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS } = require("../providers/dxfeed/dxlink-handshake");
const { normalizeDxFeedEvent } = require("../providers/dxfeed/dxfeed-event-normalizer");
const { redactSecrets } = require("../providers/dxfeed/redact");
const {
  isAllowedDxFeedSymbol, isAllowedAssetClass, ASSET_CLASSES, EVENT_TYPES, findCollectorInstrumentByEventSymbol,
} = require("../providers/dxfeed/dxfeed-instrument-catalog");
const { resolveShutdownDeadline } = require("../providers/dxfeed/dxfeed-token-lifecycle");
const { createDxFeedOrderBookAssembler } = require("../providers/dxfeed/dxfeed-book-assembler");
const { createDxFeedOrderV2Capture } = require("../providers/dxfeed/dxfeed-order-v2-capture");
const { emitTelemetry } = require("../platform/telemetry");
const {
  adaptLiveDxFeedTimeAndSale,
  adaptLiveDxFeedTimeAndSaleForBar,
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
const { tradeMagnitude, MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../indicators/large-trade/large-trade-detection");
const { createHistoryBuffer } = require("./history");
const {
  parseHistoryRanges,
  createSelectionRateLimiter,
  createClientSender,
  createFrameDispatch,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
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
const { parseCapabilities } = require("./l2-frames");

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
const SESSION_ENDED_REASON = "DXFEED_SESSION_ENDED";
const SESSION_START_FAILED_REASON = "DXFEED_SESSION_START_FAILED";
const NOT_CONFIGURED_REASON = "DXFEED_NOT_CONFIGURED";
const MAX_CLIENT_BUFFERED_BYTES = 24 * 1024 * 1024;
const DEFAULT_CLIENT_BUFFER_HARD_BYTES = MAX_CLIENT_BUFFERED_BYTES * 3;
const DEFAULT_CLIENT_BUFFER_GRACE_MS = 10_000;
const QUIET_THRESHOLD_MS = 90_000;
const BOOK_QUIET_THRESHOLD_MS = 5_000;
const ORDER_CHANNEL_CONTRACT = "STREAM";
const CANDLE_FINALIZATION_INTERVAL_MS = 1_000;
const DEFAULT_SESSION_RETRY_BASE_MS = 120_000;
const MAX_SESSION_RETRY_MS = 30_000;
const VOLUME_PROFILE_POLL_MS = 1_500;
const VOLUME_PROFILE_DEFAULT_PERIOD_MS = 60 * 60 * 1000;
const VOLUME_PROFILE_REFERENCE_LOOKBACK_MS = 15 * 60 * 1000;
const VPIN_POLL_MS = 1_500;
const VPIN_BACKFILL_LOOKBACK_MS = CANDLE_WARMUP_WINDOW_MS;
const VPIN_WARMUP_REMOTE_TIMEOUT_MS = 50_000;
const BARS_WARMUP_RETRY_MS = 15_000;

function storageReaderConfigured(reader) {
  return (typeof reader?.dbPath === "string" && reader.dbPath.length > 0) || reader?.remote != null;
}
const PROFILE_CONFIG_MODES = new Set(["continuous", "per_candle", "fixed_range"]);
const PROFILE_CONFIG_KEYS = ["bin_size_multiplier", "mode", "period_ms", "range_end_ts", "range_start_ts", "type"];
const PROFILE_HISTORY_KEYS = ["bin_size_multiplier", "mode", "period_ms", "ranges", "request_id", "type"];

function isValidBinSizeMultiplier(value) {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) &&
      value >= MIN_BIN_SIZE_MULTIPLIER && value <= MAX_BIN_SIZE_MULTIPLIER);
}

function historyInstrumentKey(symbol, assetClass) {
  return `DXFEED:${assetClass}:${symbol}`;
}

function dxFeedTradeMagnitude(assetClass, trade) {
  return tradeMagnitude("DXFEED", assetClass, trade.price, trade.size);
}

function tapeWirePlanFor() {
  return {
    contract: "STREAM",
    wireEventType: "TimeAndSale",
    eventType: EVENT_TYPES.TIMEANDSALE,
    adapt: adaptLiveDxFeedTimeAndSale,
    adaptForBar: adaptLiveDxFeedTimeAndSaleForBar,
  };
}

function createDxFeedMarketDataServer({
  createConnection = createDxLinkConnection,
  createBarAggregator = createDxFeedBarAggregator,
  createOrderV2Capture = createDxFeedOrderV2Capture,
  requestToken = requestDevelopmentToken,
  storageReader = null,
  aggressivePoolWarmup = true,
  brokerUrl,
  now = () => Date.now(),
  telemetry = null,
  sessionRetryBaseMs = DEFAULT_SESSION_RETRY_BASE_MS,
  tickSizeResolver = createInstrumentTickSizeResolver(),
  volumeProfileCache = null,
  volumeProfilePollMs = VOLUME_PROFILE_POLL_MS,
  vpinPollMs = VPIN_POLL_MS,
  vpinWarmup = startVpinWarmup,
  vpinLivePoll = startVpinLivePoll,
  clientBufferSoftBytes = MAX_CLIENT_BUFFERED_BYTES,
  clientBufferHardBytes = DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  clientBufferGraceMs = DEFAULT_CLIENT_BUFFER_GRACE_MS,
  vpinEnabled = process.env.TT_VPIN_ENABLED !== "0",
} = {}) {
  for (const [name, dependency] of [
    ["createConnection", createConnection],
    ["createOrderV2Capture", createOrderV2Capture],
    ["requestToken", requestToken],
  ]) {
    if (typeof dependency !== "function") {
      throw new Error(`dxfeed market data server: ${name} must be a function`);
    }
  }
  if (typeof now !== "function") {
    throw new Error("dxfeed market data server: now must be a function");
  }
  if (!Number.isSafeInteger(sessionRetryBaseMs) || sessionRetryBaseMs <= 0) {
    throw new Error("dxfeed market data server: sessionRetryBaseMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(volumeProfilePollMs) || volumeProfilePollMs <= 0) {
    throw new Error("dxfeed market data server: volumeProfilePollMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(vpinPollMs) || vpinPollMs <= 0) {
    throw new Error("dxfeed market data server: vpinPollMs must be a positive safe integer");
  }
  for (const [name, value] of [
    ["clientBufferSoftBytes", clientBufferSoftBytes],
    ["clientBufferHardBytes", clientBufferHardBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dxfeed market data server: ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isInteger(clientBufferGraceMs) || clientBufferGraceMs < 0) {
    throw new Error("dxfeed market data server: clientBufferGraceMs must be a non-negative integer");
  }
  if (clientBufferHardBytes < clientBufferSoftBytes) {
    throw new Error("dxfeed market data server: clientBufferHardBytes must be >= clientBufferSoftBytes");
  }
  const clients = new Set();
  const clientSender = createClientSender({
    logPrefix: "dxfeed market data server",
    softBytes: clientBufferSoftBytes,
    hardBytes: clientBufferHardBytes,
    graceMs: clientBufferGraceMs,
    now,
    clientCount: () => clients.size,
    releaseClient: (client) => releaseClient(client),
    closeClient: (client, code, reason) => closeClient(client, code, reason),
  });
  const profileHistoryJobsByClient = new Map();
  const aggressiveHistory = createAggressiveHistoryHandler({ provider: "DXFEED", storageReader, now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed market data server" });
  const deltaProfile = createDeltaProfileHandler({ provider: "DXFEED", storageReader, now, safelySend: (client, frame) => safelySend(client, frame), label: "dxfeed market data server" });
  const frameDispatch = createFrameDispatch({
    logPrefix: "dxfeed market data server",
    clients,
    wsOpen: WS_OPEN,
    safelySendSerialized: (client, serialized, kind) => safelySendSerialized(client, serialized, kind),
  });
  const selectionRateLimiter = createSelectionRateLimiter({ now });
  const barAggregator = createBarAggregator();
  const dataQuality = createDxFeedDataQualityLedger({ telemetry, now });
  let session = null;
  let view = null;
  let stopped = true;
  let jobOwner = createAnalyticsJobOwner();
  let stopPromise = null;
  let latestAttempt = 0;
  let candleFinalizationTimer = null;
  let volumeProfilePollTimer = null;
  let volumeProfilePollInFlight = false;
  let volumeProfileState = null;
  let requestedProfileConfig = null;
  let vpinPollTimer = null;
  let vpinSessionState = null;
  let vpinWarmupJob = null;
  let vpinLiveJob = null;
  let vpinLiveUnavailable = false;
  let vpinWarmupState = "IDLE";
  let vpinWarmupRetryNotBeforeMs = 0;
  const vpinWarmupRetry = createVpinWarmupRetryPolicy({ log: console.error, label: "dxfeed market data server" });
  let barsWarmupJob = null;
  let barsWarmupRetryNotBeforeMs = 0;
  let restartTimer = null;
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

  function releaseClient(client) {
    jobOwner.cancel(profileHistoryJobsByClient.get(client));
    profileHistoryJobsByClient.delete(client);
    clients.delete(client);
    clientSender.forget(client);
    selectionRateLimiter.forget(client);
    aggressiveHistory.forget(client);
    deltaProfile.forget(client);
  }

  function safelySendSerialized(client, serializedFrame, kind = null) {
    return clientSender.send(client, serializedFrame, kind);
  }

  const analyticsStatus = require("./analytics-status").createAnalyticsStatusPublisher(broadcast);
  const profilePollPolicy = createProfilePollPolicy({ now });
  function setAnalyticsStatus(indicator, status) {
    if (indicator === "VPIN") vpinWarmupState = status;
    if (view) analyticsStatus.set({ provider: "DXFEED", symbol: view.symbol, assetClass: view.assetClass }, indicator, status);
  }
  function safelySend(client, frame) {
    const sent = frameDispatch.safelySend(client, frame);
    if (sent && frame.type === "snapshot") analyticsStatus.replay(frame, (status) => frameDispatch.safelySend(client, status));
    return sent;
  }

  function broadcast(frame) {
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
    return view ? { symbol: view.symbol, assetClass: view.assetClass } : null;
  }

  function finalizeDueBars() {
    const activeView = view;
    if (!activeView) return 0;
    if (session?.seedPending) return 0;
    const finalized = barAggregator.finalizeThrough(now());
    for (const { symbol, assetClass, bar } of finalized) {
      if (symbol !== activeView.symbol || assetClass !== activeView.assetClass) continue;
      const frame = dxfeedBarFrame({
        symbol, assetClass, tsOpen: bar.ts_open, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, buyVolume: bar.buy_volume, sellVolume: bar.sell_volume, tradeCount: bar.trade_count, closed: true,
      });
      rememberBar(activeView, frame);
      broadcast(frame);
    }
    return finalized.length;
  }

  function startCandleFinalization() {
    if (candleFinalizationTimer) return;
    candleFinalizationTimer = setInterval(() => {
      try {
        finalizeDueBars();
      } catch (error) {
        console.error("dxfeed market data server: failed to finalize due candles", error?.message ?? error);
      }
    }, CANDLE_FINALIZATION_INTERVAL_MS);
    candleFinalizationTimer.unref?.();
  }

  function stopCandleFinalization() {
    if (!candleFinalizationTimer) return;
    clearInterval(candleFinalizationTimer);
    candleFinalizationTimer = null;
  }

  async function buildAlignedSession(adapter, tickSize, periodMs, binSizeMultiplier, nowMs) {
    return buildAlignedProfileSession({ adapter, tickSize, periodMs, binSizeMultiplier, nowMs, referenceLookbackMs: VOLUME_PROFILE_REFERENCE_LOOKBACK_MS });
  }

  async function ensureVolumeProfileWarm(activeView) {
    if (!storageReader || typeof storageReader.readVolumeProfile !== "function" || typeof storageReader.readTradesSince !== "function") return;
    try {
      const tickSize = tickSizeResolver.getDxFeedTickSize(activeView.assetClass, activeView.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, activeView.symbol, activeView.assetClass);
      const periodMs = VOLUME_PROFILE_DEFAULT_PERIOD_MS;
      const volumeProfileSession = await buildAlignedSession(adapter, tickSize, periodMs, DEFAULT_BIN_SIZE_MULTIPLIER, now());
      if (volumeProfileSession === null || view !== activeView || volumeProfileState !== null) return;
      volumeProfileState = {
        adapter, session: volumeProfileSession, tickSize, mode: "continuous", periodMs, binSizeMultiplier: DEFAULT_BIN_SIZE_MULTIPLIER, configGeneration: 0, pendingConfig: null,
      };
      if (requestedProfileConfig) handleProfileConfigMessage(requestedProfileConfig, null);
    } catch (error) {
      if (profilePollPolicy.fail(error)) console.warn("dxfeed market data server: volume profile warm-up deferred", error?.message ?? error);
      setAnalyticsStatus("PROFILE", profilePollPolicy.status);
    }
  }

  async function rolloverVolumeProfileIfDue(nowMs) {
    const state = volumeProfileState;
    if (!state || state.pendingConfig !== null || state.mode === "fixed_range") return;
    if (nowMs < state.session.periodStartTs + state.periodMs) return;
    const configGeneration = state.configGeneration ?? 0;
    const rebuilt = await buildAlignedSession(
      state.adapter,
      state.tickSize,
      state.periodMs,
      state.binSizeMultiplier,
      nowMs,
    );
    if (rebuilt === null) return false;
    if (volumeProfileState === state && (state.configGeneration ?? 0) === configGeneration) state.session = rebuilt;
    return true;
  }

  async function pollVolumeProfiles() {
    if (volumeProfilePollInFlight) return;
    volumeProfilePollInFlight = true;
    try {
      if (!view || !profilePollPolicy.allow(isMarketOpen(view.assetClass, now()))) {
        if (view) setAnalyticsStatus("PROFILE", profilePollPolicy.status);
        return;
      }
      if (!volumeProfileState && view) await ensureVolumeProfileWarm(view);
      if (!volumeProfileState) {
        if (profilePollPolicy.status !== "UNAVAILABLE") profilePollPolicy.settle("EMPTY");
        setAnalyticsStatus("PROFILE", profilePollPolicy.status);
        return;
      }
      if (volumeProfileState.pendingConfig !== null) return;
      if (volumeProfileState.rebuildDeferred && requestedProfileConfig) {
        volumeProfileState.rebuildDeferred = false;
        handleProfileConfigMessage(requestedProfileConfig, null);
        return;
      }
      const nowMs = now();
      const state = volumeProfileState;
      const generation = state.configGeneration;
      try {
        if (await rolloverVolumeProfileIfDue(nowMs) === false) {
          if (volumeProfileState !== state || state.configGeneration !== generation) return;
          profilePollPolicy.settle("EMPTY");
          setAnalyticsStatus("PROFILE", profilePollPolicy.status);
          return;
        }
        if (volumeProfileState !== state || state.configGeneration !== generation) return;
        let complete = true;
        if (state.mode !== "fixed_range") {
          ({ complete } = await pollOpenPeriod(state.session, state.adapter, nowMs));
        }
        if (volumeProfileState !== state || state.configGeneration !== generation) return;
        profilePollPolicy.settle(!complete ? "WARMING" : state.session.buckets.size === 0 ? "EMPTY" : "READY");
        setAnalyticsStatus("PROFILE", profilePollPolicy.status);
        if (!complete) return;
      } catch (error) {
        if (volumeProfileState !== state || state.configGeneration !== generation) return;
        setAnalyticsStatus("PROFILE", "UNAVAILABLE");
        if (profilePollPolicy.fail(error)) console.warn("dxfeed market data server: volume profile poll deferred", error?.message ?? error);
        return;
      }
      if (!view || volumeProfileState.session.buckets.size === 0) return;
      try {
        const profile = computeProfile(volumeProfileState.session.buckets);
        broadcast(dxfeedProfileFrame({
          engineState: { session: volumeProfileState.session, profile, mode: volumeProfileState.mode },
          symbol: view.symbol,
          assetClass: view.assetClass,
        }));
      } catch (error) {
        console.error("dxfeed market data server: volume profile frame build failed", error?.message ?? error);
        setAnalyticsStatus("PROFILE", "UNAVAILABLE");
      }
    } finally {
      volumeProfilePollInFlight = false;
    }
  }

  function startVolumeProfilePolling() {
    if (volumeProfilePollTimer) return;
    volumeProfilePollTimer = setInterval(() => {
      pollVolumeProfiles().catch((error) => {
        console.error("dxfeed market data server: volume profile poll failed", error?.message ?? error);
      });
    }, volumeProfilePollMs);
    volumeProfilePollTimer.unref?.();
  }

  function stopVolumeProfilePolling() {
    if (!volumeProfilePollTimer) return;
    clearInterval(volumeProfilePollTimer);
    volumeProfilePollTimer = null;
  }

  async function ensureVpinWarm(activeView) {
    if (!vpinEnabled) {
      if (vpinWarmupState !== "DISABLED") {
        vpinWarmupState = "DISABLED";
        if (view === activeView) broadcast(currentSnapshotFrame(activeView));
      }
      return;
    }
    if (!storageReader || typeof storageReader.readTradesSince !== "function" || typeof storageReader.readMinuteRollup !== "function") {
      if (vpinWarmupState !== "UNAVAILABLE") {
        vpinWarmupState = "UNAVAILABLE";
        if (view === activeView) broadcast(currentSnapshotFrame(activeView));
      }
      return;
    }
    if (vpinWarmupJob || Date.now() < vpinWarmupRetryNotBeforeMs) return;
    if (vpinWarmup === startVpinWarmup && !storageReaderConfigured(storageReader)) {
      if (vpinWarmupState !== "UNAVAILABLE") {
        console.warn("dxfeed market data server: vpin warm-up unavailable; storage reader is not configured (no local database path or remote endpoint)");
        vpinWarmupState = "UNAVAILABLE";
        if (view === activeView) broadcast(currentSnapshotFrame(activeView));
      }
      return;
    }
    let tickSize;
    try {
      tickSize = tickSizeResolver.getDxFeedTickSize(activeView.assetClass, activeView.symbol);
    } catch (error) {
      console.error("dxfeed market data server: vpin tick-size resolution failed", error?.message ?? error);
      return;
    }
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    const warmUpAttempt = latestAttempt;
    const nowMs = now();
    vpinWarmupState = "WARMING";
    if (view === activeView) broadcast(currentSnapshotFrame(activeView));
    let job;
    let vpinSession;
    try {
      job = jobOwner.launch(() => vpinWarmup({
        dbPath: storageReader.dbPath,
        remote: storageReader.remote ? { ...storageReader.remote, timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS } : storageReader.remote,
        provider: "dxfeed",
        symbol: activeView.symbol,
        assetClass: activeView.assetClass,
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
      vpinWarmupJob = job;
      const result = await job.promise;
      if (stopped || latestAttempt !== warmUpAttempt || view !== activeView || vpinWarmupJob !== job) return;
      if (!result?.available) {
        vpinWarmupState = "UNAVAILABLE";
        vpinWarmupRetryNotBeforeMs = Date.now() + vpinWarmupRetry.failed(`${activeView.assetClass}:${activeView.symbol}`, result?.reason ?? "NO_RESULT", {
          tradesApplied: result?.tradesApplied, pagesFetched: result?.pagesFetched, slicesRead: result?.slicesRead, durationMs: result?.durationMs,
        });
        broadcast(currentSnapshotFrame(activeView));
        return;
      }
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, activeView.symbol, activeView.assetClass);
      vpinSession = createVpinSession({ adapter, vBucket: result.vBucket, nowMs: result.pollFromTs });
      vpinSession.vpinState = result.vpinState;
      vpinSession.pollFromTs = result.pollFromTs;
      vpinSession.pollCursor = result.pollCursor;
      vpinSession.history = Array.isArray(result.history) ? result.history : [];
      vpinSessionState = vpinSession;
      vpinLiveUnavailable = false;
      vpinWarmupState = "READY";
      vpinWarmupRetryNotBeforeMs = 0;
      vpinWarmupRetry.succeeded(`${activeView.assetClass}:${activeView.symbol}`);
      console.info("dxfeed market data server: vpin worker warm-up completed", {
        symbol: activeView.symbol, assetClass: activeView.assetClass,
        durationMs: result.durationMs, tradesApplied: result.tradesApplied,
        ...(result.slicesRead === undefined ? {} : { slicesRead: result.slicesRead, chunksRead: result.chunksRead }),
        readings: vpinSession.history.length,
      });
    } catch (error) {
      if (stopped || latestAttempt !== warmUpAttempt || view !== activeView) return;
      vpinWarmupState = "UNAVAILABLE";
      vpinWarmupRetryNotBeforeMs = Date.now() + vpinWarmupRetry.failed(`${activeView.assetClass}:${activeView.symbol}`, "WORKER_FAILED", error?.message ?? error);
      broadcast(currentSnapshotFrame(activeView));
      return;
    } finally {
      if (vpinWarmupJob === job) vpinWarmupJob = null;
    }
    if (stopped || latestAttempt !== warmUpAttempt || view !== activeView) return;
    if (vpinSession) {
      try {
        broadcast(currentSnapshotFrame(activeView));
      } catch (error) {
        console.error("dxfeed market data server: vpin historical snapshot build failed", error?.message ?? error);
      }
    }
  }

  function pollVpin() {
    if (!vpinSessionState && view) {
      ensureVpinWarm(view).catch((error) => {
        console.error("dxfeed market data server: vpin warm-up failed", error?.message ?? error);
      });
    }
    if (view?.barHistory?.availability === "UNAVAILABLE") {
      warmUpBars(view).catch((error) => {
        console.error("dxfeed market data server: candle warm-up retry failed", error?.message ?? error);
      });
    }
    if (!vpinSessionState || !view || vpinLiveJob || vpinLiveUnavailable) return;
    if (vpinLivePoll === startVpinLivePoll && !storageReaderConfigured(storageReader)) {
      console.warn("dxfeed market data server: vpin live poll unavailable; storage reader is not configured (no local database path or remote endpoint)");
      vpinLiveUnavailable = true;
      setAnalyticsStatus("VPIN", "UNAVAILABLE");
      return;
    }
    const nowMs = now();
    const sessionAtLaunch = vpinSessionState;
    const viewAtLaunch = view;
    let job;
    try {
      job = jobOwner.launch(() => vpinLivePoll({
        dbPath: storageReader?.dbPath,
        remote: storageReader?.remote ? { ...storageReader.remote, timeoutMs: VPIN_WARMUP_REMOTE_TIMEOUT_MS } : storageReader?.remote,
        provider: "dxfeed",
        symbol: viewAtLaunch.symbol,
        assetClass: viewAtLaunch.assetClass,
        vpinState: sessionAtLaunch.vpinState,
        pollFromTs: sessionAtLaunch.pollFromTs,
        pollCursor: sessionAtLaunch.pollCursor,
        nowMs,
      }));
      if (!job || typeof job.promise?.then !== "function" || typeof job.cancel !== "function") {
        throw new Error("vpin live-poll factory must return a cancellable job");
      }
      vpinLiveJob = job;
    } catch (error) {
      console.error("dxfeed market data server: vpin live-poll launch failed", error?.message ?? error);
      setAnalyticsStatus("VPIN", "UNAVAILABLE");
      return;
    }
    job.promise.then((pollResult) => {
      if (stopped || vpinLiveJob !== job || vpinSessionState !== sessionAtLaunch || view !== viewAtLaunch) return;
      const readings = applyLivePollResult(sessionAtLaunch, pollResult);
      setAnalyticsStatus("VPIN", "READY");
      if (readings.length > 0) {
        try {
          for (const reading of readings) {
            broadcast(dxfeedVpinFrame({ reading, symbol: viewAtLaunch.symbol, assetClass: viewAtLaunch.assetClass }));
          }
        } catch (error) {
          console.error("dxfeed market data server: vpin frame build failed", error?.message ?? error);
          setAnalyticsStatus("VPIN", "UNAVAILABLE");
        }
      }
    }).catch((error) => {
      if (!stopped && vpinLiveJob === job) {
        setAnalyticsStatus("VPIN", "UNAVAILABLE");
        console.error("dxfeed market data server: vpin live poll failed", error?.message ?? error);
      }
    }).finally(() => {
      if (vpinLiveJob === job) vpinLiveJob = null;
    });
  }

  function startVpinPolling() {
    if (vpinPollTimer) return;
    vpinPollTimer = setInterval(() => {
      try {
        pollVpin();
      } catch (error) {
        console.error("dxfeed market data server: vpin poll failed", error?.message ?? error);
      }
    }, vpinPollMs);
    vpinPollTimer.unref?.();
  }

  function stopVpinPolling() {
    if (!vpinPollTimer) return;
    clearInterval(vpinPollTimer);
    vpinPollTimer = null;
  }

  async function buildRangeProfileFrame(activeView, adapter, tickSize, rangeStartTs, rangeEndTs, binSizeMultiplier, { mode = "fixed_range", deliveryScope = "FIXED_RANGE", historyRequestId = null } = {}) {
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
      symbol: activeView.symbol,
      assetClass: activeView.assetClass,
    });
  }

  async function sendFixedRangeProfile(client, rangeStartTs, rangeEndTs, binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER) {
    if (!storageReader || !clients.has(client) || !view) return;
    const activeView = view;
    try {
      const tickSize = tickSizeResolver.getDxFeedTickSize(activeView.assetClass, activeView.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0 || !clients.has(client)) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, activeView.symbol, activeView.assetClass);
      const frame = await buildRangeProfileFrame(activeView, adapter, tickSize, rangeStartTs, rangeEndTs, binSizeMultiplier);
      if (frame === null || !clients.has(client) || view !== activeView) return;
      safelySend(client, frame);
    } catch (error) {
      console.error("dxfeed market data server: fixed_range profile request failed", error?.message ?? error);
    }
  }

  function sendHistoricalProfiles(client, ranges, binSizeMultiplier, mode, historyRequestId) {
    ranges = ranges.filter((range) => range.rangeEndTs <= floorToMinute(now()));
    if (ranges.length === 0) return;
    if (!storageReader || !clients.has(client) || !view) return;
    const activeView = view;
    try {
      const tickSize = tickSizeResolver.getDxFeedTickSize(activeView.assetClass, activeView.symbol);
      if (!Number.isFinite(tickSize) || tickSize <= 0 || !clients.has(client)) return;
      const adapter = createDxFeedVolumeProfileAdapter(storageReader, activeView.symbol, activeView.assetClass);
      const sendBuilt = (built) => {
        if (built === null || !clients.has(client) || view !== activeView) return;
        for (const { session, profile } of built) {
          if (!clients.has(client) || view !== activeView) return;
          safelySend(client, dxfeedProfileFrame({
            engineState: { session, profile, mode, deliveryScope: "HISTORICAL", historyRequestId },
            symbol: activeView.symbol,
            assetClass: activeView.assetClass,
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
          symbol: activeView.symbol,
          assetClass: activeView.assetClass,
          instrument: historyInstrumentKey(activeView.symbol, activeView.assetClass),
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
          console.error("dxfeed market data server: historical profile worker failed", error?.message ?? error);
        });
        return;
      }
      if (volumeProfileCache) {
        Promise.resolve(buildHistoricalProfiles({
          cache: volumeProfileCache,
          adapter,
          instrument: historyInstrumentKey(activeView.symbol, activeView.assetClass),
          tickSize,
          ranges,
          periodMs: ranges[0]?.rangeEndTs - ranges[0]?.rangeStartTs,
          binSizeMultiplier,
          nowMs: now(),
        })).then((built) => {
          if (built === null) return;
          sendBuilt(built);
        }).catch((error) => {
          console.error("dxfeed market data server: profile_history request failed", error?.message ?? error);
        });
        return;
      }
      Promise.all(ranges.map((range) => buildRangeProfileFrame(activeView, adapter, tickSize, range.rangeStartTs, range.rangeEndTs, binSizeMultiplier, {
        mode,
        deliveryScope: "HISTORICAL",
        historyRequestId,
      }))).then((frames) => {
        for (const frame of frames) {
          if (!clients.has(client) || view !== activeView) return;
          if (frame === null) continue;
          safelySend(client, frame);
        }
      }).catch((error) => {
        console.error("dxfeed market data server: profile_history request failed", error?.message ?? error);
      });
    } catch (error) {
      console.error("dxfeed market data server: profile_history request failed", error?.message ?? error);
    }
  }

  function handleProfileHistoryMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (keys.length !== PROFILE_HISTORY_KEYS.length || !keys.every((key, index) => key === PROFILE_HISTORY_KEYS[index])) {
      console.warn("dxfeed market data server: dropped profile_history request with unexpected fields");
      return;
    }
    if (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0) {
      console.warn("dxfeed market data server: dropped profile_history request with an invalid period");
      return;
    }
    if ((parsed.mode !== "continuous" && parsed.mode !== "per_candle") || !Number.isSafeInteger(parsed.request_id) || parsed.request_id <= 0) {
      console.warn("dxfeed market data server: dropped profile_history request with invalid mode or request id");
      return;
    }
    if (!isValidBinSizeMultiplier(parsed.bin_size_multiplier)) {
      console.warn("dxfeed market data server: dropped profile_history request with an invalid bin-size multiplier");
      return;
    }
    const ranges = parseHistoryRanges(parsed.ranges, parsed.period_ms);
    if (ranges === null) {
      console.warn("dxfeed market data server: dropped profile_history request with invalid ranges");
      return;
    }
    sendHistoricalProfiles(client, ranges, parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER, parsed.mode, parsed.request_id);
  }

  function handleProfileConfigMessage(parsed, client) {
    const keys = Object.keys(parsed).sort();
    if (keys.length !== PROFILE_CONFIG_KEYS.length || !keys.every((key, index) => key === PROFILE_CONFIG_KEYS[index])) {
      console.warn("dxfeed market data server: dropped profile_config request with unexpected fields");
      return;
    }
    if (!PROFILE_CONFIG_MODES.has(parsed.mode)) {
      console.warn("dxfeed market data server: dropped profile_config request with an unrecognized mode");
      return;
    }
    if (
      (parsed.period_ms !== null && (!Number.isSafeInteger(parsed.period_ms) || parsed.period_ms <= 0)) ||
      !isValidBinSizeMultiplier(parsed.bin_size_multiplier)
    ) {
      console.warn("dxfeed market data server: dropped profile_config request with invalid field values");
      return;
    }
    if (parsed.mode === "fixed_range") {
      if (
        !Number.isSafeInteger(parsed.range_start_ts) || parsed.range_start_ts < 0 ||
        !Number.isSafeInteger(parsed.range_end_ts) || parsed.range_end_ts <= parsed.range_start_ts
      ) {
        console.warn("dxfeed market data server: dropped fixed_range profile_config request with an invalid range");
        return;
      }
      sendFixedRangeProfile(client, parsed.range_start_ts, parsed.range_end_ts, parsed.bin_size_multiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER).catch((error) => {
        console.error("dxfeed market data server: fixed_range profile request failed", error?.message ?? error);
      });
      return;
    }
    if (parsed.range_start_ts !== null || parsed.range_end_ts !== null) {
      console.warn("dxfeed market data server: dropped profile_config request with a range on a non-fixed_range mode");
      return;
    }
    if (!view) return;
    requestedProfileConfig = parsed;
    if (!volumeProfileState) return;
    const state = volumeProfileState;
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
    setAnalyticsStatus("PROFILE", "WARMING");
    buildAlignedSession(
      state.adapter,
      state.tickSize,
      nextPeriodMs,
      nextBinSizeMultiplier,
      now(),
    ).then((rebuilt) => {
      if (volumeProfileState === state && state.configGeneration === configGeneration) {
        if (rebuilt === null) {
          state.pendingConfig = null;
          state.rebuildDeferred = true;
          profilePollPolicy.settle("EMPTY");
          setAnalyticsStatus("PROFILE", profilePollPolicy.status);
          return;
        }
        state.mode = pendingConfig.mode;
        state.periodMs = pendingConfig.periodMs;
        state.binSizeMultiplier = pendingConfig.binSizeMultiplier;
        state.session = rebuilt;
        state.pendingConfig = null;
        state.rebuildDeferred = false;
      }
    }).catch((error) => {
      if (volumeProfileState !== state || state.configGeneration !== configGeneration) return;
      state.pendingConfig = null;
      state.rebuildDeferred = true;
      if (profilePollPolicy.fail(error)) console.warn("dxfeed market data server: volume profile rebuild deferred", error?.message ?? error);
      setAnalyticsStatus("PROFILE", profilePollPolicy.status);
    });
  }

  function closeChannel(activeSession, descriptor) {
    if (!descriptor.channel) return true;
    let clean = true;
    function attempt(operation) {
      try {
        operation();
      } catch (error) {
        clean = false;
        console.error("dxfeed market data server: channel cleanup step failed", {
          reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
        });
      }
    }
    if (descriptor.onMessage) {
      attempt(() => descriptor.channel.removeMessageListener(descriptor.onMessage));
    }
    if (descriptor.onChannelError) {
      attempt(() => descriptor.channel.removeErrorListener?.(descriptor.onChannelError));
    }
    if (descriptor.entries.length > 0) {
      attempt(() => descriptor.channel.send({ type: "FEED_SUBSCRIPTION", remove: descriptor.entries }));
    }
    attempt(() => descriptor.channel.close());
    return clean;
  }

  function publishHealth(activeView, state, reason) {
    const frame = dxfeedHealthFrame(activeView.symbol, activeView.assetClass, state, reason);
    activeView.healthFrame = frame;
    broadcast(frame);
  }

  function clearQuietTimer(activeView) {
    if (!activeView) return;
    if (activeView.quietTimer) {
      clearTimeout(activeView.quietTimer);
      activeView.quietTimer = null;
    }
  }

  function scheduleQuietTimer(activeView) {
    clearQuietTimer(activeView);
    activeView.quietTimer = setTimeout(() => markQuiet(activeView), QUIET_THRESHOLD_MS);
    activeView.quietTimer.unref?.();
  }

  function markQuiet(activeView) {
    activeView.quietTimer = null;
    if (activeView.printsQuiet || activeView.healthFrame?.recoveryState === "UNAVAILABLE") return;
    activeView.printsQuiet = true;
    if (view !== activeView) return;
    publishHealth(activeView, {
      stale: activeView.healthFrame?.stale ?? true,
      recoveryState: activeView.healthFrame?.recoveryState ?? "RECOVERING",
      printsQuiet: true,
    });
  }

  function clearBookQuietTimer(activeView) {
    if (!activeView) return;
    if (activeView.bookQuietTimer) {
      clearTimeout(activeView.bookQuietTimer);
      activeView.bookQuietTimer = null;
    }
  }

  function isBookStale(activeView) {
    return activeView.bookStale === true || (activeView.assetClass === ASSET_CLASSES.EQUITY && classifyDxFeedSession(activeView.assetClass, now()) === "CLOSED");
  }

  function scheduleBookQuietTimer(activeView) {
    clearBookQuietTimer(activeView);
    activeView.bookQuietTimer = setTimeout(() => markBookStale(activeView), BOOK_QUIET_THRESHOLD_MS);
    activeView.bookQuietTimer.unref?.();
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

  function notifyBookStatusChange(activeView, state) {
    const previousStatus = activeView.lastBookStatus;
    const newStatus = state.status === "READY" ? "READY" : state.reason;
    if (previousStatus !== null && previousStatus !== newStatus) {
      if (newStatus === "READY") {
        emitTelemetry(telemetry, "market_data.dxfeed_book_assembler.recovery_succeeded", {
          symbol: activeView.symbol, assetClass: activeView.assetClass,
        });
      } else {
        emitTelemetry(telemetry, "market_data.dxfeed_book_assembler.unavailable", {
          symbol: activeView.symbol, assetClass: activeView.assetClass, reason: newStatus, previousStatus,
        });
      }
    }
    activeView.lastBookStatus = newStatus;
  }

  function emitBook(activeView, rawState) {
    const state = translateBookStatus(rawState);
    if (!state) return;
    notifyBookStatusChange(activeView, state);
    const stale = isBookStale(activeView);
    activeView.bookFingerprint = bookFingerprint(state, stale);
    const frame = dxfeedBookFrame(activeView.symbol, activeView.assetClass, state, undefined, { stale });
    activeView.bookFrame = frame;
    if (view === activeView) broadcast(frame);
  }

  function checkBookAndMaybeBroadcast(activeView) {
    const assembler = activeView.bookAssembler;
    if (!assembler) return;
    const rawState = assembler.getState();
    const state = translateBookStatus(rawState);
    const stale = isBookStale(activeView);
    if (bookFingerprint(state, stale) !== activeView.bookFingerprint) {
      emitBook(activeView, rawState);
    }
  }

  function markBookStale(activeView) {
    activeView.bookQuietTimer = null;
    if (activeView.bookStale) return;
    activeView.bookStale = true;
    try {
      checkBookAndMaybeBroadcast(activeView);
    } catch (error) {
      console.error("dxfeed market data server: failed to broadcast a stale book transition", error?.message ?? error);
    }
  }

  function endSession(reasonForClients, activeSession = session) {
    if (!activeSession || activeSession.settled) return;
    activeSession.settled = true;
    activeSession.pendingFeedItems.length = 0;
    activeSession.tokenAbortController?.abort();
    if (session === activeSession) session = null;
    volumeProfileState = null;
    profilePollPolicy.settle("WARMING");
    vpinSessionState = null;
    analyticsStatus.clear();
    jobOwner.cancel(vpinLiveJob);
    vpinLiveJob = null;
    vpinLiveUnavailable = false;
    jobOwner.cancel(vpinWarmupJob);
    vpinWarmupJob = null;
    vpinWarmupState = "IDLE";
    vpinWarmupRetryNotBeforeMs = 0;
    vpinWarmupRetry.clear();
    barsWarmupJob = null;
    barsWarmupRetryNotBeforeMs = 0;
    activeSession.resolveAbortPromise();

    if (activeSession.deadlineTimer) clearTimeout(activeSession.deadlineTimer);
    activeSession.deadlineTimer = null;
    if (activeSession.orderRetryTimer) clearTimeout(activeSession.orderRetryTimer);
    activeSession.orderRetryTimer = null;
    clearQuietTimer(activeSession.view);
    clearBookQuietTimer(activeSession.view);
    for (const [name, cleanup] of [
      ["connection error listener", activeSession.unsubscribeConnectionError],
      ["connection state listener", activeSession.unsubscribeConnectionDrop],
    ]) {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`dxfeed market data server: ${name} cleanup failed`, {
          reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
        });
      }
    }
    closeChannel(activeSession, {
      channel: activeSession.channel, onMessage: activeSession.onMessage,
      onChannelError: activeSession.onChannelError, entries: activeSession.entries,
    });
    closeChannel(activeSession, {
      channel: activeSession.orderChannel, onMessage: activeSession.onOrderMessage,
      onChannelError: activeSession.onOrderChannelError, entries: activeSession.orderEntries,
    });
    try {
      activeSession.connection?.disconnect();
    } catch (error) {
      console.error("dxfeed market data server: disconnect failed", {
        reason: redactSecrets(String(error?.message ?? error), activeSession.secrets),
      });
    }
    if (reasonForClients && view === activeSession.view) {
      try {
        publishHealth(activeSession.view, {
          stale: true,
          recoveryState: "UNAVAILABLE",
        }, reasonForClients);
      } catch (error) {
        console.error("dxfeed market data server: failed to broadcast a session-end health transition", error?.message ?? error);
      }
      if (activeSession.view.bookAssembler) {
        try {
          emitBook(activeSession.view, { status: "UNAVAILABLE", reason: reasonForClients });
        } catch (error) {
          console.error("dxfeed market data server: failed to broadcast a session-end book transition", error?.message ?? error);
        }
      }
    }
  }

  function rememberTrade(activeView, frame) {
    if (activeView.recentTradeIds.has(frame.trade_id)) return false;
    activeView.recentTradeIds.add(frame.trade_id);
    activeView.recentTrades.push(frame);
    if (activeView.recentTrades.length > WARM_UP_TRADE_LIMIT) {
      const evicted = activeView.recentTrades.shift();
      activeView.recentTradeIds.delete(evicted.trade_id);
    }
    return true;
  }

  function rememberMarker(activeView, frame) {
    return activeView.markerHistory.recordMarker(frame);
  }

  function rememberBar(activeView, frame) {
    const last = activeView.recentBars[activeView.recentBars.length - 1];
    if (last && frame.ts_open <= last.ts_open) {
      console.error("dxfeed market data server: dropped an out-of-order closed bar", {
        symbol: activeView.symbol,
        tsOpen: frame.ts_open,
        lastTsOpen: last.ts_open,
      });
      return;
    }
    activeView.recentBars.push(frame);
    if (activeView.recentBars.length > MAX_RECENT_BARS) {
      activeView.recentBars.shift();
    }
  }

  function currentSnapshotFrame(activeView = view) {
    return dxfeedSnapshotFrame(
      activeView.recentBars, activeView.recentTrades, activeView.symbol, activeView.assetClass,
      activeView.markerHistory.snapshotMarkers(), activeView.barHistory,
      vpinSessionState && vpinSessionState.history.length > 0 ? vpinSessionState.history : undefined,
      vpinWarmupState,
      activeView.aggressivePool ? activeView.aggressivePool.snapshot() : undefined,
    );
  }

  function warmUpAggressivePrints(activeView) {
    if (!aggressivePoolWarmup || !storageReader || typeof storageReader.readAggressivePrintsAsync !== "function") return;
    activeView.aggressivePool ??= createAggressivePool({ now });
    const warmUpAttempt = latestAttempt;
    const startedAtMs = Date.now();
    warmAggressivePool({
      pool: activeView.aggressivePool,
      nowMs: now(),
      shouldContinue: () => !stopped && latestAttempt === warmUpAttempt && view === activeView,
      read: async (fromMs, toMs, minSize, cursor) => {
        const { rows, available = true, hasMore = false, nextCursor = null } = await storageReader.readAggressivePrintsAsync(activeView.symbol, activeView.assetClass, { fromMs, toMs, minSize, limit: AGGRESSIVE_POOL_READ_LIMIT, cursor });
        if (!available) return { frames: [], available: false };
        const { frames, dropped } = rowsToTradeFrames("DXFEED", { symbol: activeView.symbol, assetClass: activeView.assetClass }, rows);
        if (dropped > 0) console.error(`dxfeed market data server: ${dropped} stored prints could not be represented on the wire`);
        return { frames, hasMore, nextCursor };
      },
      onProgress: () => {
        if (view === activeView) broadcast(currentSnapshotFrame(activeView));
      },
    }).then((result) => {
      console.info(`dxfeed market data server: aggressive-print warm-up ${result.complete ? "complete" : "incomplete"}`, {
        symbol: activeView.symbol, assetClass: activeView.assetClass, chunks: result.chunks, prints: result.prints, retained: activeView.aggressivePool.size, floor: activeView.aggressivePool.floor, durationMs: Date.now() - startedAtMs,
      });
    }).catch((error) => {
      console.error("dxfeed market data server: aggressive-print warm-up failed", error?.message ?? error);
    });
  }

  async function warmUpBars(activeView) {
    if (!storageReader || typeof storageReader.readRecentCandles !== "function") return;
    if (barsWarmupJob || Date.now() < barsWarmupRetryNotBeforeMs) return;
    const job = {};
    barsWarmupJob = job;
    try {
      const warmUpAttempt = latestAttempt;
      const warmupNowMs = now();
      const raw = storageReader.readRecentCandles(activeView.symbol, activeView.assetClass, {
        windowMs: CANDLE_WARMUP_WINDOW_MS,
        nowMs: warmupNowMs,
      });
      const { rows, available, startsAtRequestedWindow } = (raw != null && typeof raw.then === "function")
        ? await raw
        : raw;
      if (stopped || latestAttempt !== warmUpAttempt || view !== activeView) return;
      const requestedStartTsOpen = Math.floor(warmupNowMs / 60_000) * 60_000 - CANDLE_WARMUP_WINDOW_MS;
      if (!available) {
        activeView.barHistory = { availability: "UNAVAILABLE", requestedStartTsOpen, coverage: "NO_ROWS" };
        barsWarmupRetryNotBeforeMs = Date.now() + BARS_WARMUP_RETRY_MS;
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
      const firstLiveTsOpen = activeView.recentBars[0]?.ts_open;
      const lastLiveTsOpen = activeView.recentBars[activeView.recentBars.length - 1]?.ts_open;
      let latestPersistedTsOpen;
      for (const row of bounded) {
        try {
          const frame = storageDxFeedCandleRowToBarFrame(row, activeView.symbol, activeView.assetClass);
          latestPersistedTsOpen = latestPersistedTsOpen === undefined
            ? frame.ts_open
            : Math.max(latestPersistedTsOpen, frame.ts_open);
          if (firstLiveTsOpen !== undefined && frame.ts_open < firstLiveTsOpen) {
            if (earlier.length === 0 || frame.ts_open > earlier[earlier.length - 1].ts_open) earlier.push(frame);
          } else if (lastLiveTsOpen === undefined || frame.ts_open > lastLiveTsOpen) {
            later.push(frame);
          }
        } catch (error) {
          console.error("dxfeed market data server: warm-up candle row could not be represented on the wire", error?.message ?? error);
        }
      }
      if (earlier.length > 0) {
        const overflow = Math.max(0, earlier.length + activeView.recentBars.length - MAX_RECENT_BARS);
        const kept = earlier.slice(Math.min(earlier.length, overflow));
        activeView.recentBars = [...kept, ...activeView.recentBars].slice(-MAX_RECENT_BARS);
        acceptedFrames.push(...kept);
      }
      for (const frame of later) {
        const before = activeView.recentBars.length;
        rememberBar(activeView, frame);
        if (activeView.recentBars.length > before) acceptedFrames.push(frame);
      }
      if (latestPersistedTsOpen !== undefined) {
        barAggregator.seedFinalizedThrough(activeView.symbol, activeView.assetClass, latestPersistedTsOpen);
      }
      const earliestObservedTsOpen = acceptedFrames[0]?.ts_open;
      const startCovered = startsAtRequestedWindow === true &&
        earliestObservedTsOpen !== undefined &&
        earliestObservedTsOpen - requestedStartTsOpen < 60_000;
      activeView.barHistory = {
        availability: "AVAILABLE",
        requestedStartTsOpen,
        coverage: earliestObservedTsOpen === undefined ? "NO_ROWS" : startCovered ? "START_COVERED" : "START_NOT_COVERED",
        ...(earliestObservedTsOpen !== undefined ? { earliestObservedTsOpen } : {}),
      };
      barsWarmupRetryNotBeforeMs = 0;
    } catch (error) {
      console.error("dxfeed market data server: candle warm-up read failed", error?.message ?? error);
      barsWarmupRetryNotBeforeMs = Date.now() + BARS_WARMUP_RETRY_MS;
    } finally {
      if (barsWarmupJob === job) barsWarmupJob = null;
    }
  }

  function warmUp(activeView) {
    if (!storageReader) return;
    try {
      const warmUpAttempt = latestAttempt;
      const requireValidTick = activeView.assetClass === ASSET_CLASSES.FUTURE;
      const read = storageReader.readRecent(
        activeView.symbol,
        activeView.assetClass,
        EVENT_TYPES.TIMEANDSALE,
        { limit: WARM_UP_TRADE_LIMIT },
      );
      const apply = ({ rows, available }) => {
        if (stopped || latestAttempt !== warmUpAttempt || view !== activeView || !available || rows.length === 0) return;
        for (const row of [...rows].reverse()) {
          try {
            if (!isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick })) continue;
            rememberTrade(activeView, dxfeedTradeFrame(adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick })));
          } catch (error) {
            console.error("dxfeed market data server: warm-up row could not be represented on the wire", error?.message ?? error);
          }
        }
      };
      if (read != null && typeof read.then === "function") {
        read.then(apply).catch((error) => {
          console.error("dxfeed market data server: warm-up read failed", error?.message ?? error);
        });
      } else {
        apply(read);
      }
    } catch (error) {
      console.error("dxfeed market data server: warm-up read failed", error?.message ?? error);
    }
  }

  function warmUpMarkers(activeView) {
    if (!storageReader || (typeof storageReader.readLargeTrades !== "function" && typeof storageReader.readLargeTradesAsync !== "function")) return;
    const requireValidTick = activeView.assetClass === ASSET_CLASSES.FUTURE;
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
          rememberMarker(activeView, dxfeedMarkerFrame(adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick })));
        } catch (error) {
          console.error("dxfeed market data server: warm-up marker row could not be represented on the wire", error?.message ?? error);
        }
      }
      return true;
    };
    if (typeof storageReader.readLargeTradesAsync === "function") {
      const startedAtMs = Date.now();
      const warmUpAttempt = latestAttempt;
      storageReader.readLargeTradesAsync(activeView.symbol, activeView.assetClass, options).then((result) => {
        if (stopped || latestAttempt !== warmUpAttempt || view !== activeView || !applyRows(result)) return;
        console.info("dxfeed market data server: marker warm-up completed", {
          symbol: activeView.symbol, assetClass: activeView.assetClass,
          rows: result.rows.length, durationMs: Date.now() - startedAtMs,
        });
        broadcast(currentSnapshotFrame(activeView));
      }).catch((error) => {
        console.error("dxfeed market data server: marker warm-up worker failed", error?.message ?? error);
      });
      return;
    }
    try {
      applyRows(storageReader.readLargeTrades(activeView.symbol, activeView.assetClass, options));
    } catch (error) {
      console.error("dxfeed market data server: marker warm-up read failed", error?.message ?? error);
    }
  }

  async function seedOpenMinute(activeView, activeSession) {
    if (!storageReader || typeof storageReader.readTradesSince !== "function") return;
    const nowMs = now();
    const fromTs = nowMs - (nowMs % 60_000);
    if (fromTs === nowMs) return;
    let cursor = null;
    for (let page = 0; page < OPEN_MINUTE_SEED_MAX_PAGES; page += 1) {
      const { rows = [], nextCursor = null, available = false } = await storageReader.readTradesSince(activeView.symbol, activeView.assetClass, {
        fromTs, toTs: nowMs + 1, cursor, limit: OPEN_MINUTE_SEED_PAGE_ROWS,
      }) ?? {};
      if (!available || stopped || activeSession.settled || view !== activeView) return;
      for (const row of rows) {
        if (classifyStoredDxFeedTimeAndSaleRowForBar(row, { requireValidTick: true }) !== BAR_ELIGIBILITY_REASONS.ACCEPTED) continue;
        const { closedBar, dropped } = barAggregator.ingest(adaptStoredDxFeedTimeAndSaleRowForBar(row));
        if (dropped || !closedBar) continue;
        const closedFrame = dxfeedBarFrame({
          symbol: activeView.symbol, assetClass: activeView.assetClass, tsOpen: closedBar.ts_open,
          open: closedBar.open, high: closedBar.high, low: closedBar.low, close: closedBar.close,
          volume: closedBar.volume, buyVolume: closedBar.buy_volume, sellVolume: closedBar.sell_volume, tradeCount: closedBar.trade_count,
          closed: true,
        });
        rememberBar(activeView, closedFrame);
        broadcast(closedFrame);
      }
      if (nextCursor === null || rows.length < OPEN_MINUTE_SEED_PAGE_ROWS) return;
      cursor = nextCursor;
    }
  }

  async function startSession(symbol, assetClass) {
    startCandleFinalization();
    const attempt = ++latestAttempt;
    const wirePlan = tapeWirePlanFor();
    const orderInstrument = findCollectorInstrumentByEventSymbol(symbol);
    const hasOrderSupport = orderInstrument !== undefined && orderInstrument.assetClass === assetClass;
    barAggregator.reset(symbol, assetClass);
    const activeView = {
      symbol,
      assetClass,
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
      bookAssembler: hasOrderSupport ? createDxFeedOrderBookAssembler({
        expectedSymbol: symbol,
        expectedAssetClass: assetClass,
        expectedSource: orderInstrument.orderSource,
      }) : null,
      bookFrame: null,
      bookFingerprint: null,
      bookStale: false,
      bookQuietTimer: null,
      lastBookStatus: null,
    };
    requestedProfileConfig = null;
    view = activeView;
    broadcast(dxfeedSelectionFrame(symbol, assetClass));
    warmUp(activeView);
    void warmUpBars(activeView);
    warmUpMarkers(activeView);
    warmUpAggressivePrints(activeView);
    ensureVolumeProfileWarm(activeView).catch((error) => {
      console.error("dxfeed market data server: volume profile warm-up failed", error?.message ?? error);
    });
    startVolumeProfilePolling();
    ensureVpinWarm(activeView).catch((error) => {
      console.error("dxfeed market data server: vpin warm-up failed", error?.message ?? error);
    });
    startVpinPolling();
    broadcast(currentSnapshotFrame(activeView));
    publishHealth(activeView, { stale: true, recoveryState: "RECOVERING" });
    scheduleQuietTimer(activeView);

    if (typeof brokerUrl !== "string" || brokerUrl.trim().length === 0) {
      console.error("dxfeed market data server: no TT_DXFEED_TOKEN_BROKER_URL configured, so this machine shows recorded dxFeed history only");
      publishHealth(activeView, { stale: true, recoveryState: "UNAVAILABLE" }, NOT_CONFIGURED_REASON);
      if (activeView.bookAssembler) emitBook(activeView, { status: "UNAVAILABLE", reason: NOT_CONFIGURED_REASON });
      return { retryable: false };
    }

    let resolveAbortPromise;
    const abortPromise = new Promise((resolve) => {
      resolveAbortPromise = resolve;
    });
    const activeSession = {
      symbol,
      assetClass,
      view: activeView,
      settled: false,
      streaming: false,
      seedPending: false,
      pendingFeedItems: [],
      channel: null,
      onMessage: null,
      onChannelError: null,
      entries: [],
      orderChannel: null,
      onOrderMessage: null,
      onOrderChannelError: null,
      orderEntries: [],
      orderRetryTimer: null,
      orderRetryAttempt: 0,
      orderSetupAttempt: 0,
      capture: null,
      unsubscribeConnectionError: null,
      unsubscribeConnectionDrop: null,
      deadlineTimer: null,
      tokenAbortController: new AbortController(),
      connection: null,
      secrets: [],
      resolveAbortPromise,
      abortPromise,
    };
    session = activeSession;


    let token;
    let expiresAt;
    try {
      ({ token, expiresAt } = await requestToken({ brokerUrl, signal: activeSession.tokenAbortController.signal }));
    } catch (error) {
      if (attempt !== latestAttempt || activeSession.settled || stopped) return;
      console.error("dxfeed market data server: failed to obtain a dxFeed token", error?.message ?? error);
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return { retryable: isRetryableTokenBrokerError(error) };
    }
    if (attempt !== latestAttempt || activeSession.settled || stopped) {
      return;
    }
    const sessionNowMs = now();
    const resolved = resolveShutdownDeadline(expiresAt, sessionNowMs);
    if (!resolved.ok) {
      console.error("dxfeed market data server: refusing to start a session with no real self-termination runway", {
        reason: resolved.reason,
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return { retryable: false };
    }

    activeSession.secrets.push(token);
    const secrets = activeSession.secrets;

    activeSession.deadlineTimer = setTimeout(() => {
      if (stopped || activeSession.settled || session !== activeSession) return;
      endSession(SESSION_ENDED_REASON, activeSession);
      launchSession(symbol, assetClass);
    }, resolved.shutdownDeadlineMs - sessionNowMs);
    activeSession.deadlineTimer.unref?.();

    let capture = null;
    if (hasOrderSupport) {
      capture = createOrderV2Capture({
        resolveOrderContext: (eventSymbol) => (eventSymbol === symbol ? { assetClass, symbol } : null),
        onEnvelope: (envelope) => {
          if (activeSession.settled) return;
          activeView.bookAssembler.applyEvent(envelope);
          activeView.bookStale = false;
          scheduleBookQuietTimer(activeView);
        },
        onCaptureError: (error) => {
          emitTelemetry(telemetry, "market_data.dxfeed_order_v2_capture.correlation_failed", {
            reason: redactSecrets(String(error?.message ?? error), secrets),
            code: error?.code ?? null,
            eventSymbols: Array.isArray(error?.eventSymbols) ? error.eventSymbols : [],
            channelId: activeSession.orderChannel?.id ?? null,
          });
          if (activeSession.settled) return;
          clearBookQuietTimer(activeView);
          try {
            activeView.bookAssembler.invalidate("ORDER_CAPTURE_ERROR");
            emitBook(activeView, activeView.bookAssembler.getState());
          } catch (bookError) {
            console.error("dxfeed market data server: failed to broadcast an order-capture-error book transition", bookError?.message ?? bookError);
          }
          if (activeSession.orderChannel) {
            closeChannel(activeSession, {
              channel: activeSession.orderChannel, onMessage: activeSession.onOrderMessage,
              onChannelError: activeSession.onOrderChannelError, entries: activeSession.orderEntries,
            });
            activeSession.orderChannel = null;
            activeSession.onOrderMessage = null;
            activeSession.onOrderChannelError = null;
            activeSession.orderEntries = [];
          }
          scheduleOrderChannelRestart();
        },
        now,
      });
      activeSession.capture = capture;
    }

    let connection;
    try {
      connection = createConnection(
        { endpoint: REALTIME_ENDPOINT, marketDataMode: "realtime", tempToken: token },
        hasOrderSupport ? { createConnector: capture.createConnector } : undefined,
      );
    } catch (error) {
      console.error("dxfeed market data server: failed to initialize dxFeed connection", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return;
    }
    activeSession.connection = connection;

    try {
      activeSession.unsubscribeConnectionError = connection.onError((error) => {
        if (activeSession.settled) return;
        console.error("dxfeed market data server: connection error", {
          reason: redactSecrets(typeof error?.message === "string" ? error.message : "dxLink error", secrets),
        });
        if (error?.type === "AUTH") {
          restartAttempt = 1;
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
      console.error("dxfeed market data server: failed to attach connection lifecycle listeners", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      endSession(SESSION_START_FAILED_REASON, activeSession);
      return;
    }

    try {
      connection.connect();
      const authorized = await waitForAuthorized({ connection, timeoutMs: AUTH_TIMEOUT_MS, abortPromise });
      if (!authorized || activeSession.settled) return;
      const channel = connection.openChannel("FEED", { contract: wirePlan.contract });
      activeSession.channel = channel;
      const opened = await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
      if (!opened || activeSession.settled) return;
      channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
      if (activeSession.settled) return;
    } catch (error) {
      if (activeSession.settled) return;
      console.error("dxfeed market data server: failed to establish the FEED channel", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      handleSessionFailure(SESSION_ENDED_REASON, activeSession);
      return;
    }

    activeSession.onMessage = (message) => {
      if (message?.type !== "FEED_DATA" || !Array.isArray(message.data) || activeSession.settled) return;
      for (const item of message.data) {
        if (activeSession.settled) return;
        if (item?.eventSymbol !== symbol || item?.eventType !== wirePlan.wireEventType) continue;
        if (activeSession.seedPending) {
          if (activeSession.pendingFeedItems.length >= OPEN_MINUTE_SEED_PENDING_LIMIT) {
            console.error("dxfeed market data server: open-minute seed feed buffer exceeded its limit", { symbol });
            handleSessionFailure(SESSION_ENDED_REASON, activeSession);
            return;
          }
          activeSession.pendingFeedItems.push(item);
          continue;
        }
        try {
          const envelope = normalizeDxFeedEvent(
            { assetClass, symbol, eventType: wirePlan.eventType, raw: item },
            { receivedAtMs: now() },
          );
          if (envelope.state === "UNAVAILABLE") continue;
          const barTrade = wirePlan.adaptForBar(envelope, item);
          const barEligibility = classifyDxFeedTimeAndSaleForBar(item, { requireValidTick: true });
          dataQuality.record({ symbol, assetClass, reason: barEligibility, item });
          if (barEligibility === BAR_ELIGIBILITY_REASONS.ACCEPTED) {
            const { closedBar, liveBar, dropped } = barAggregator.ingest({ ...barTrade, nowMs: now() });
            if (dropped) continue;
            if (closedBar) {
              const closedFrame = dxfeedBarFrame({
                symbol, assetClass, tsOpen: closedBar.ts_open,
                open: closedBar.open, high: closedBar.high, low: closedBar.low, close: closedBar.close,
                volume: closedBar.volume, buyVolume: closedBar.buy_volume, sellVolume: closedBar.sell_volume, tradeCount: closedBar.trade_count,
                closed: true,
              });
              rememberBar(activeView, closedFrame);
              broadcast(closedFrame);
            }
            broadcast(dxfeedBarFrame({
              symbol, assetClass, tsOpen: liveBar.ts_open,
              open: liveBar.open, high: liveBar.high, low: liveBar.low, close: liveBar.close,
              volume: liveBar.volume, buyVolume: liveBar.buy_volume, sellVolume: liveBar.sell_volume, tradeCount: liveBar.trade_count,
              closed: false,
            }));
          }
          const tapeWorthy = item?.type === "NEW"
            && (assetClass === ASSET_CLASSES.EQUITY || item?.validTick === true);
          if (!tapeWorthy) continue;
          const wasQuiet = activeView.printsQuiet === true;
          activeView.printsQuiet = false;
          scheduleQuietTimer(activeView);
          if (activeView.healthFrame?.recoveryState !== "READY" || wasQuiet) {
            publishHealth(activeView, { stale: false, recoveryState: "READY", printsQuiet: false });
          }
          if (barTrade.side === null) continue;
          const adaptedTrade = wirePlan.adapt(envelope, item);
          const auction = isEquityAuctionPrint(assetClass, item);
          const frame = dxfeedTradeFrame({ ...adaptedTrade, auction });
          if (rememberTrade(activeView, frame)) {
            if (!auction) (activeView.aggressivePool ??= createAggressivePool({ now })).record(frame);
            broadcast(frame);
          }
          if (!auction && activeView.markerHistory.wouldRetainMarker(
            frame.ts_exchange, frame.side, dxFeedTradeMagnitude(assetClass, adaptedTrade),
          )) {
            const marker = dxfeedMarkerFrame(adaptedTrade);
            if (rememberMarker(activeView, marker)) broadcast(marker);
          }
        } catch (error) {
          console.error("dxfeed market data server: failed to normalize or adapt a live trade", {
            reason: redactSecrets(String(error?.message ?? error), secrets),
          });
          if (error?.code === "DXFEED_BAR_CAPACITY_EXCEEDED") {
            restartAttempt = 1;
            endSession(error.code, activeSession);
          }
        }
      }
    };
    activeSession.onChannelError = (error) => {
      if (activeSession.settled) return;
      console.error("dxfeed market data server: FEED channel error", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      handleSessionFailure(SESSION_ENDED_REASON, activeSession);
    };
    try {
      activeSession.channel.addMessageListener(activeSession.onMessage);
      activeSession.channel.addErrorListener?.(activeSession.onChannelError);
      activeSession.entries = [
        { symbol, type: wirePlan.wireEventType },
      ];
      activeSession.seedPending = Boolean(storageReader && typeof storageReader.readTradesSince === "function" && now() % 60_000 !== 0);
      activeSession.channel.send({ type: "FEED_SUBSCRIPTION", add: activeSession.entries });
      activeSession.streaming = true;
      if (activeSession.seedPending) seedOpenMinute(activeView, activeSession)
        .catch((error) => {
          console.error("dxfeed market data server: open-minute seed failed", { symbol, reason: error?.message ?? error });
        })
        .finally(() => {
          if (activeSession.settled || view !== activeView) {
            activeSession.pendingFeedItems.length = 0;
            return;
          }
          activeSession.seedPending = false;
          const pending = activeSession.pendingFeedItems.splice(0);
          if (pending.length > 0) activeSession.onMessage({ type: "FEED_DATA", data: pending });
          finalizeDueBars();
        });
    } catch (error) {
      if (activeSession.settled) return;
      console.error("dxfeed market data server: failed to subscribe", {
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      handleSessionFailure(SESSION_ENDED_REASON, activeSession);
      return;
    }

    if (!hasOrderSupport || activeSession.settled) return;

    function publishOrderUnavailable(reason) {
      clearBookQuietTimer(activeView);
      try {
        activeView.bookAssembler.invalidate(reason);
        emitBook(activeView, activeView.bookAssembler.getState());
      } catch (bookError) {
        console.error("dxfeed market data server: failed to broadcast an order-channel unavailable transition", bookError?.message ?? bookError);
      }
    }

    function scheduleOrderChannelRestart() {
      if (activeSession.settled || activeSession.orderRetryTimer || session !== activeSession) return;
      activeSession.orderRetryAttempt += 1;
      const delayMs = Math.min(
        sessionRetryBaseMs * 2 ** (activeSession.orderRetryAttempt - 1),
        MAX_SESSION_RETRY_MS,
      );
      activeSession.orderRetryTimer = setTimeout(() => {
        activeSession.orderRetryTimer = null;
        if (activeSession.settled || session !== activeSession || activeSession.orderChannel) return;
        void establishOrderChannel();
      }, delayMs);
      activeSession.orderRetryTimer.unref?.();
    }

    async function establishOrderChannel() {
      if (activeSession.settled || session !== activeSession || activeSession.orderChannel) return;
      const setupAttempt = ++activeSession.orderSetupAttempt;
      let orderChannel = null;
      try {
        orderChannel = connection.openChannel("FEED", { contract: ORDER_CHANNEL_CONTRACT });
        activeSession.orderChannel = orderChannel;
        const orderOpened = await waitForChannelOpened({ channel: orderChannel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
        if (!orderOpened || activeSession.settled || setupAttempt !== activeSession.orderSetupAttempt) return;
        orderChannel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
        if (activeSession.settled || setupAttempt !== activeSession.orderSetupAttempt) return;
        capture.setChannelId(orderChannel.id);
        activeSession.onOrderMessage = (message) => {
          if (message?.type !== "FEED_DATA" || !Array.isArray(message.data) || activeSession.settled) return;
          try {
            capture.handleChannelMessage(message);
            activeSession.orderRetryAttempt = 0;
            checkBookAndMaybeBroadcast(activeView);
          } catch (error) {
            console.error("dxfeed market data server: failed to process a live order-book message", {
              reason: redactSecrets(String(error?.message ?? error), secrets),
            });
          }
        };
        activeSession.onOrderChannelError = (error) => {
          if (activeSession.settled || activeSession.orderChannel !== orderChannel) return;
          console.error("dxfeed market data server: order FEED channel error -- book unavailable, other market data unaffected", {
            reason: redactSecrets(String(error?.message ?? error), secrets),
          });
          closeChannel(activeSession, {
            channel: orderChannel, onMessage: activeSession.onOrderMessage,
            onChannelError: activeSession.onOrderChannelError, entries: activeSession.orderEntries,
          });
          activeSession.orderChannel = null;
          activeSession.onOrderMessage = null;
          activeSession.onOrderChannelError = null;
          activeSession.orderEntries = [];
          publishOrderUnavailable("ORDER_CHANNEL_ERROR");
          scheduleOrderChannelRestart();
        };
        orderChannel.addMessageListener(activeSession.onOrderMessage);
        orderChannel.addErrorListener?.(activeSession.onOrderChannelError);
        activeSession.orderEntries = [{ symbol, type: "Order", source: orderInstrument.orderSource }];
        orderChannel.send({ type: "FEED_SUBSCRIPTION", add: activeSession.orderEntries });
      } catch (error) {
        if (activeSession.settled || setupAttempt !== activeSession.orderSetupAttempt) return;
        console.error("dxfeed market data server: failed to establish the order FEED channel -- book unavailable, other market data unaffected", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
        closeChannel(activeSession, {
          channel: orderChannel, onMessage: activeSession.onOrderMessage,
          onChannelError: activeSession.onOrderChannelError, entries: activeSession.orderEntries,
        });
        activeSession.orderChannel = null;
        activeSession.onOrderMessage = null;
        activeSession.onOrderChannelError = null;
        activeSession.orderEntries = [];
        publishOrderUnavailable("ORDER_CHANNEL_SETUP_FAILED");
        scheduleOrderChannelRestart();
      }
    }

    await establishOrderChannel();
  }

  function launchSession(symbol, assetClass) {
    const expectedAttempt = latestAttempt + 1;
    startSession(symbol, assetClass).then((startup) => {
      if (stopped || latestAttempt !== expectedAttempt) return;
      if (startup?.retryable === false) restartAttempt = 1;
      if (!session?.streaming && startup?.retryable !== false) scheduleSessionRestart(symbol, assetClass);
    }).catch((error) => {
      console.error("dxfeed market data server: failed to start a dxFeed session", error?.message ?? error);
      if (latestAttempt !== expectedAttempt) return;
      try {
        endSession(SESSION_START_FAILED_REASON, session);
      } catch (cleanupError) {
        console.error("dxfeed market data server: failed to clean up a rejected session start", cleanupError?.message ?? cleanupError);
      }
      scheduleSessionRestart(symbol, assetClass);
    });
  }

  function switchToSymbol(symbol, assetClass) {
    if (stopped) return;
    if (isActive() && session.symbol === symbol && session.assetClass === assetClass) {
      return;
    }
    clearSessionRestart();
    restartAttempt = 0;
    endSession(null);
    launchSession(symbol, assetClass);
  }

  function handleClientConnected(client) {
    clients.add(client);
    const current = currentSymbolInfo();
    if (!current) return;
    try {
      if (!safelySend(client, dxfeedSelectionFrame(current.symbol, current.assetClass))) return;
      if (!safelySend(client, currentSnapshotFrame())) return;
      if (view.healthFrame) safelySend(client, view.healthFrame);
      if (view.bookFrame) safelySend(client, view.bookFrame);
    } catch (error) {
      console.error("dxfeed market data server: failed to build the initial snapshot for a newly connected client -- dropping it", error?.message ?? error);
      releaseClient(client);
      closeClient(client, 1011, "Unable to initialize dxFeed market data view");
    }
  }

  function handleClientDisconnected(client) {
    releaseClient(client);
  }

  function handleClientMessage(raw, client) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("dxfeed market data server: dropped malformed (non-JSON) client message");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      console.error("dxfeed market data server: dropped malformed client message");
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
      if (view) aggressiveHistory.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "delta_profile") {
      if (view) deltaProfile.handle(parsed, client, { symbol: view.symbol, assetClass: view.assetClass });
      return;
    }
    if (parsed.type === "capabilities") {
      const flags = parseCapabilities(parsed);
      if (flags === null || flags.has("marker_history")) console.warn("dxfeed market data server: dropped capabilities request with unexpected fields");
      return;
    }
    if (parsed.type === "l2_resync") return;
    if (parsed.type !== "select") {
      console.error("dxfeed market data server: dropped client message with unrecognized type", parsed.type);
      return;
    }
    const keys = Object.keys(parsed).sort();
    const expectedKeys = parsed.resume === true ? ["assetClass", "resume", "symbol", "type"] : ["assetClass", "symbol", "type"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      console.warn("dxfeed market data server: dropped select request with unexpected fields");
      return;
    }
    const { symbol, assetClass } = parsed;
    if (typeof symbol !== "string" || !isAllowedAssetClass(assetClass) || !isAllowedDxFeedSymbol(symbol, assetClass)) {
      console.warn("dxfeed market data server: dropped select request for an unproven symbol/assetClass pair");
      return;
    }
    if (isActive() && session.symbol === symbol && session.assetClass === assetClass) {
      return;
    }
    if (!allowSelectionRequest(client)) {
      console.error("dxfeed market data server: closed client that exceeded the pair-selection rate limit");
      closeClient(client, 1008, "Too many pair selection requests");
      releaseClient(client);
      return;
    }
    if (parsed.resume === true && restartAttempt >= 1 && !isActive()) {
      safelySend(client, dxfeedSelectionFrame(symbol, assetClass));
      safelySend(client, dxfeedHealthFrame(symbol, assetClass, { stale: true, recoveryState: "UNAVAILABLE" }, restartTimer ? "DXFEED_RETRY_PENDING" : "DXFEED_RETRY_EXHAUSTED"));
      return;
    }
    switchToSymbol(symbol, assetClass);
  }

  function start() {
    if (stopPromise) {
      if (!jobOwner.canRestart()) throw new Error("market data server: previous worker shutdown is pending or failed");
      jobOwner = createAnalyticsJobOwner();
      stopPromise = null;
    }
    stopped = false;
  }

  function deactivate() {
    const errors = [];
    try {
      finalizeDueBars();
    } catch (error) {
      errors.push(error);
    }
    stopCandleFinalization();
    stopVolumeProfilePolling();
    stopVpinPolling();
    clearSessionRestart();
    latestAttempt += 1;
    const inactiveView = view;
    try {
      endSession(null, session);
    } catch (error) {
      errors.push(error);
    }
    if (inactiveView) {
      try {
        barAggregator.reset(inactiveView.symbol, inactiveView.assetClass);
      } catch (error) {
        errors.push(error);
      }
    }
    view = null;
    if (errors.length > 0) {
      throw new AggregateError(errors, "dxfeed market data server: one or more deactivation steps failed");
    }
  }

  function clearSessionRestart() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function scheduleSessionRestart(symbol, assetClass) {
    if (
      stopped ||
      restartTimer ||
      typeof brokerUrl !== "string" ||
      brokerUrl.trim().length === 0 ||
      view?.symbol !== symbol ||
      view?.assetClass !== assetClass
    ) {
      return;
    }
    if (restartAttempt >= 1) return;
    restartAttempt += 1;
    const delayMs = sessionRetryBaseMs;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped || isActive() || view?.symbol !== symbol || view?.assetClass !== assetClass) return;
      launchSession(symbol, assetClass);
    }, delayMs);
    restartTimer.unref?.();
  }

  function handleSessionFailure(reason, activeSession) {
    const { symbol, assetClass } = activeSession;
    endSession(reason, activeSession);
    scheduleSessionRestart(symbol, assetClass);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const errors = [];
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    stopPromise.catch(() => {});
    stopped = true;
    for (const job of profileHistoryJobsByClient.values()) jobOwner.cancel(job);
    profileHistoryJobsByClient.clear();
    aggressiveHistory.dispose();
    deltaProfile.dispose();
    try {
      deactivate();
    } catch (error) {
      errors.push(error);
    }
    stopCandleFinalization();
    for (const client of clients) {
      selectionRateLimiter.forget(client);
    }
    clients.clear();
    clientSender.clear();
    jobOwner.stop(errors).then(resolveStop, rejectStop);
    return stopPromise;
  }

  function instrumentSnapshot() {
    if (!view) return [];
    const bookState = view.bookAssembler ? view.bookAssembler.getState() : null;
    return [{
      symbol: view.symbol,
      assetClass: view.assetClass,
      l1: { recoveryState: view.healthFrame?.recoveryState ?? "IDLE", quiet: view.printsQuiet === true },
      l2: bookState === null ? null : { status: view.bookFrame?.status ?? bookState.status,
        reason: view.bookFrame ? view.bookFrame.reason ?? null : bookState.reason ?? null,
        ...(view.bookFrame?.stale === true ? { stale: true } : {}) },
      analytics: { vpin: vpinWarmupState,
        profile: analyticsStatus.get({ provider: "DXFEED", symbol: view.symbol, assetClass: view.assetClass }, "PROFILE") },
      dataQuality: dataQuality.snapshot(view.symbol, view.assetClass),
      retention: {
        bars: view.recentBars.length,
        trades: view.recentTrades.length,
        markers: view.markerHistory.markerCount(),
        heavyHistoryWarm: true,
      },
      session: { policy: SESSION_POLICY.mode, state: classifyDxFeedSession(view.assetClass, now()) },
    }];
  }

  function orderV2CaptureStatus() {
    return session?.capture ? session.capture.getCorrelationStatus() : null;
  }

  function currentReadiness() {
    const instruments = instrumentSnapshot();
    const recovery = view?.healthFrame?.recoveryState ?? "IDLE";
    const l2 = instruments[0]?.l2;
    const profile = instruments[0]?.analytics.profile ?? "IDLE";
    const marketClosed = view != null && isActive() && recovery !== "FAILED" && !isMarketOpen(view.assetClass, now());
    const storage = !isActive() ? "IDLE"
      : vpinWarmupState === "READY" || profile === "READY" ? "READY"
        : vpinWarmupState === "UNAVAILABLE" && profile === "UNAVAILABLE" ? "UNAVAILABLE" : "RUNNING";
    return Object.freeze({
      dimensions: Object.freeze({
        transport: marketClosed ? "CLOSED" : recovery === "RECOVERING" ? "DEGRADED" : recovery,
        capture: !isActive() || marketClosed ? "IDLE" : recovery === "READY" ? "READY" : recovery === "RECOVERING" ? "DEGRADED" : "STARTING",
        storage,
        analytics: vpinWarmupState === "UNAVAILABLE" ? "DEGRADED" : vpinWarmupState === "WARMING" ? "RUNNING" : vpinWarmupState,
        l2: marketClosed ? "CLOSED" : l2 == null ? (isActive() ? "UNAVAILABLE" : "IDLE") : l2.status === "READY" && l2.stale !== true ? "READY" : l2.status === "BUFFERING" ? "STARTING" : "DEGRADED",
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
    currentRecoveryState: () => view?.healthFrame?.recoveryState ?? "IDLE",
    vpinWarmupStatus: () => vpinWarmupState,
    instrumentSnapshot,
    currentReadiness,
    orderV2CaptureStatus,
  });
}

module.exports = {
  createDxFeedMarketDataServer,
  SESSION_ENDED_REASON,
  SESSION_START_FAILED_REASON,
  NOT_CONFIGURED_REASON,
  MAX_CLIENT_BUFFERED_BYTES,
  DEFAULT_CLIENT_BUFFER_HARD_BYTES,
  DEFAULT_CLIENT_BUFFER_GRACE_MS,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
  tapeWirePlanFor,
  dxFeedTradeMagnitude,
  DEFAULT_SESSION_RETRY_BASE_MS,
  MAX_SESSION_RETRY_MS,
};
