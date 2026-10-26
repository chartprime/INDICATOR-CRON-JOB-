const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const {
  EVENT_TYPES,
  MARKET_KINDS,
  isAllowedSymbol,
  isAllowedMarketKind,
  listAllowedSymbols,
  listAllowedMarketKinds,
} = require("../providers/binance/binance-config");
const {
  isValidDecimalString,
  compareDecimalStrings,
  MAX_DEPTH_ENTRIES,
} = require("../providers/binance/binance-event-normalizer");
const { createStorageDb } = require("./storage-db");
const { createStorageWriteQueue } = require("./storage-write-queue");
const { createStorageWorkerClient } = require("./storage-worker-client");
const { createStorageLock } = require("./storage-lock");
const { emitTelemetry } = require("../platform/telemetry");

const DEFAULT_MAX_PENDING_INGRESS_ENVELOPES = 50_000;
const DEFAULT_INGRESS_DRAIN_BATCH_SIZE = 250;
const DEFAULT_INGRESS_DRAIN_MAX_MS = 8;

function createStorageService({
  connection,
  dbPath,
  onFatalError = null,
  telemetry = null,
  useWorker = false,
  workerOptions = {},
  maxPendingIngressEnvelopes = DEFAULT_MAX_PENDING_INGRESS_ENVELOPES,
  ingressDrainBatchSize = DEFAULT_INGRESS_DRAIN_BATCH_SIZE,
  ingressDrainMaxMs = DEFAULT_INGRESS_DRAIN_MAX_MS,
} = {}) {
  if (!connection || typeof connection.onMessage !== "function") {
    throw new Error("storage-service: connection must expose onMessage()");
  }
  if (onFatalError !== null && typeof onFatalError !== "function") {
    throw new Error("storage-service: onFatalError must be a function when provided");
  }
  if (telemetry !== null && typeof telemetry !== "function") {
    throw new Error("storage-service: telemetry must be a function when provided");
  }
  if (typeof useWorker !== "boolean") {
    throw new Error("storage-service: useWorker must be a boolean");
  }
  if (useWorker && dbPath === ":memory:") {
    throw new Error("storage-service: worker mode requires a file-backed database");
  }
  if (workerOptions === null || typeof workerOptions !== "object" || Array.isArray(workerOptions)) {
    throw new Error("storage-service: workerOptions must be an object");
  }
  for (const [name, value] of [
    ["maxPendingIngressEnvelopes", maxPendingIngressEnvelopes],
    ["ingressDrainBatchSize", ingressDrainBatchSize],
    ["ingressDrainMaxMs", ingressDrainMaxMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`storage-service: ${name} must be a positive safe integer`);
    }
  }
  let storageDb = null;
  let writeQueue = null;
  let lock = null;
  let unsubscribeMessage = null;
  let started = false;
  let fatalError = null;
  let captureSessionId = null;
  let activationPromise = null;
  let stopPromise = null;
  let captureOutcome = { quality: "HEALTHY", cleanShutdown: false, terminationReason: null };
  let resumeState = Object.freeze({
    hasExistingData: false,
    previousSessionEndedAt: null,
    previousSessionCleanShutdown: null,
    previousSessionQuality: null,
    lastTradeAt: null,
  });
  const ingressEnvelopes = [];
  let ingressHead = 0;
  let ingressDrainScheduled = false;
  let ingressHighWaterMark = 0;
  let ingressLastDrainDurationMs = 0;
  let ingressMaxDrainDurationMs = 0;
  const lastDepthSnapshotUpdateIdByPair = new Map();
  const priorSessionLastTradeIdByPair = new Map();
  const lastTradeIdByPair = new Map();
  const counters = {
    trades: 0,
    candles: 0,
    depthEvents: 0,
    depthSnapshots: 0,
    rejected: 0,
    tradeIdGaps: 0,
    missingTradeIds: 0,
    sessionBoundaryTradeIdGaps: 0,
    sessionBoundaryMissingTradeIds: 0,
    providerTradeIdDiscontinuities: 0,
    providerTradeIdSkippedIds: 0,
  };

  function isPositiveDecimal(value) {
    return isValidDecimalString(value) && compareDecimalStrings(value, "0") > 0;
  }

  function isNonNegativeDecimal(value) {
    return isValidDecimalString(value);
  }

  function isSafeTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function hasAllowedIdentity(envelope) {
    return isAllowedSymbol(envelope.providerSymbol) && isAllowedMarketKind(envelope.marketKind);
  }

  function isDepthLevels(value) {
    return value.every(
      (level) =>
        Array.isArray(level) &&
        level.length === 2 &&
        isPositiveDecimal(level[0]) &&
        isNonNegativeDecimal(level[1]),
    );
  }

  function handleFatalError(error) {
    if (fatalError) return;
    fatalError = error;
    captureOutcome = {
      quality: "INVALID",
      cleanShutdown: false,
      terminationReason: error?.message ?? "STORAGE_FATAL_ERROR",
    };
    console.error("storage-service: capture is no longer durable", error?.message ?? error);
    unsubscribeMessage?.();
    unsubscribeMessage = null;
    try {
      onFatalError?.(error);
    } catch (callbackError) {
      console.error("storage-service: fatal-error callback failed", callbackError?.message ?? callbackError);
    }
  }

  function rejectRecord(reason, envelope, { expectedProviderMarker = false } = {}) {
    counters.rejected += 1;
    console.error(`storage-service: rejected ${reason}`);
    emitTelemetry(
      telemetry,
      expectedProviderMarker ? "storage.provider_marker_ignored" : "storage.record_rejected",
      {
        reason,
        marketKind: typeof envelope?.marketKind === "string" ? envelope.marketKind : undefined,
        symbol: typeof envelope?.providerSymbol === "string" ? envelope.providerSymbol : undefined,
        eventType: typeof envelope?.eventType === "string" ? envelope.eventType : undefined,
      },
    );
  }

  function recordTrade(envelope) {
    const payload = envelope.payload;
    const ts = Date.parse(envelope.eventTime);
    if (
      !isSafeTimestamp(ts) ||
      !isPositiveDecimal(payload?.price) ||
      !isPositiveDecimal(payload?.quantity) ||
      !Number.isSafeInteger(payload?.tradeId) ||
      typeof payload?.isBuyerMaker !== "boolean"
    ) {
      const expectedProviderMarker =
        envelope.marketKind === MARKET_KINDS.PERPETUAL && payload?.price === "0" && payload?.quantity === "0";
      rejectRecord(`invalid trade (${envelope.marketKind}:${envelope.providerSymbol})`, envelope, { expectedProviderMarker });
      return;
    }
    const continuityKey = `${envelope.marketKind}:${envelope.providerSymbol}`;
    const previousTradeId = lastTradeIdByPair.get(continuityKey);
    const priorSessionTradeId = priorSessionLastTradeIdByPair.get(continuityKey);
    if (previousTradeId === undefined && priorSessionTradeId !== undefined && payload.tradeId > priorSessionTradeId + 1) {
      const missingCount = payload.tradeId - priorSessionTradeId - 1;
      counters.sessionBoundaryTradeIdGaps += 1;
      counters.sessionBoundaryMissingTradeIds += missingCount;
      emitTelemetry(telemetry, "storage.trade_id_session_boundary_gap", {
        marketKind: envelope.marketKind,
        symbol: envelope.providerSymbol,
        previousTradeId: priorSessionTradeId,
        currentTradeId: payload.tradeId,
        missingCount,
      });
    } else if (previousTradeId !== undefined && payload.tradeId > previousTradeId + 1) {
      const missingCount = payload.tradeId - previousTradeId - 1;
      const event = envelope.marketKind === MARKET_KINDS.SPOT
        ? "storage.trade_id_gap"
        : "storage.trade_id_provider_discontinuity";
      if (envelope.marketKind === MARKET_KINDS.SPOT) {
        counters.tradeIdGaps += 1;
        counters.missingTradeIds += missingCount;
      } else {
        counters.providerTradeIdDiscontinuities += 1;
        counters.providerTradeIdSkippedIds += missingCount;
      }
      emitTelemetry(telemetry, event, {
        marketKind: envelope.marketKind,
        symbol: envelope.providerSymbol,
        previousTradeId,
        currentTradeId: payload.tradeId,
        missingCount,
      });
    } else if (previousTradeId !== undefined && payload.tradeId <= previousTradeId) {
      emitTelemetry(telemetry, "storage.trade_id_non_monotonic", {
        marketKind: envelope.marketKind,
        symbol: envelope.providerSymbol,
        previousTradeId,
        currentTradeId: payload.tradeId,
      });
    }
    const isTradeIdAdvancing = previousTradeId === undefined || payload.tradeId > previousTradeId;
    if (isTradeIdAdvancing) {
      lastTradeIdByPair.set(continuityKey, payload.tradeId);
    }
    writeQueue.push("trades", {
      ts,
      symbol: envelope.providerSymbol,
      marketKind: envelope.marketKind,
      price: payload.price,
      size: payload.quantity,
      side: payload.isBuyerMaker ? "sell" : "buy",
      tradeId: String(payload.tradeId),
    });
    counters.trades += 1;
  }

  function recordCandle(envelope) {
    if (envelope.payload?.isClosed !== true) return;
    const payload = envelope.payload;
    if (
      !isSafeTimestamp(payload?.openTime) ||
      !isPositiveDecimal(payload?.open) ||
      !isPositiveDecimal(payload?.high) ||
      !isPositiveDecimal(payload?.low) ||
      !isPositiveDecimal(payload?.close) ||
      compareDecimalStrings(payload.high, payload.low) < 0 ||
      compareDecimalStrings(payload.high, payload.open) < 0 ||
      compareDecimalStrings(payload.high, payload.close) < 0 ||
      compareDecimalStrings(payload.low, payload.open) > 0 ||
      compareDecimalStrings(payload.low, payload.close) > 0 ||
      !isNonNegativeDecimal(payload?.baseVolume) ||
      !isNonNegativeDecimal(payload?.quoteVolume) ||
      !isNonNegativeDecimal(payload?.takerBuyBaseVolume) ||
      !isNonNegativeDecimal(payload?.takerBuyQuoteVolume) ||
      compareDecimalStrings(payload.takerBuyBaseVolume, payload.baseVolume) > 0 ||
      compareDecimalStrings(payload.takerBuyQuoteVolume, payload.quoteVolume) > 0 ||
      !Number.isSafeInteger(payload?.numberOfTrades) ||
      payload.numberOfTrades < 0 ||
      payload.interval !== "1m" ||
      payload.openTime % 60_000 !== 0 ||
      payload.closeTime !== payload.openTime + 59_999
    ) {
      rejectRecord(`invalid closed candle (${envelope.marketKind}:${envelope.providerSymbol})`, envelope);
      return;
    }
    writeQueue.push("candles", {
      tsOpen: payload.openTime,
      symbol: envelope.providerSymbol,
      marketKind: envelope.marketKind,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      close: payload.close,
      volume: payload.baseVolume,
      quoteVolume: payload.quoteVolume,
      tradeCount: payload.numberOfTrades,
      takerBuyBaseVolume: payload.takerBuyBaseVolume,
      takerBuyQuoteVolume: payload.takerBuyQuoteVolume,
    });
    counters.candles += 1;
  }

  function recordDepthEvent(envelope) {
    const payload = envelope.payload;
    const ts = Date.parse(envelope.eventTime);
    const receivedAt = Date.parse(envelope.receivedAt);
    if (
      !isSafeTimestamp(ts) ||
      !isSafeTimestamp(receivedAt) ||
      !Number.isSafeInteger(payload?.firstUpdateId) ||
      !Number.isSafeInteger(payload?.lastUpdateId) ||
      payload.firstUpdateId < 0 ||
      payload.lastUpdateId < payload.firstUpdateId ||
      (envelope.marketKind === MARKET_KINDS.SPOT && payload.previousUpdateId !== null) ||
      (envelope.marketKind === MARKET_KINDS.PERPETUAL && (!Number.isSafeInteger(payload.previousUpdateId) || payload.previousUpdateId < 0)) ||
      !Array.isArray(payload?.bids) ||
      !Array.isArray(payload?.asks) ||
      payload.bids.length > MAX_DEPTH_ENTRIES ||
      payload.asks.length > MAX_DEPTH_ENTRIES ||
      !isDepthLevels(payload.bids) ||
      !isDepthLevels(payload.asks)
    ) {
      rejectRecord(`invalid depth event (${envelope.marketKind}:${envelope.providerSymbol})`, envelope);
      return;
    }
    writeQueue.push("l2_depth_events", {
      ts,
      receivedAt,
      symbol: envelope.providerSymbol,
      marketKind: envelope.marketKind,
      firstUpdateId: payload.firstUpdateId,
      lastUpdateId: payload.lastUpdateId,
      previousUpdateId: payload.previousUpdateId,
      bids: JSON.stringify(payload.bids),
      asks: JSON.stringify(payload.asks),
    });
    counters.depthEvents += 1;
  }

  function recordDepthSnapshot(envelope, snapshotResult) {
    if (snapshotResult === undefined) {
      if (typeof connection.getDepthSnapshot !== "function") return;
      try {
        snapshotResult = connection.getDepthSnapshot(envelope.marketKind, envelope.providerSymbol);
      } catch (error) {
        console.error("storage-service: unable to inspect the current depth snapshot", error?.message ?? error);
        return;
      }
    }
    const snapshot = snapshotResult?.ok === true ? snapshotResult.value?.body : null;
    const key = `${envelope.marketKind}:${envelope.providerSymbol}`;
    if (
      Number.isSafeInteger(snapshot?.lastUpdateId) &&
      lastDepthSnapshotUpdateIdByPair.get(key) === snapshot.lastUpdateId
    ) {
      return;
    }
    if (
      !Number.isSafeInteger(snapshot?.lastUpdateId) ||
      snapshot.lastUpdateId < 0 ||
      !Array.isArray(snapshot.bids) ||
      !Array.isArray(snapshot.asks) ||
      snapshot.bids.length > MAX_DEPTH_ENTRIES ||
      snapshot.asks.length > MAX_DEPTH_ENTRIES ||
      !isDepthLevels(snapshot.bids) ||
      !isDepthLevels(snapshot.asks)
    ) {
      return;
    }
    writeQueue.push("l2_depth_snapshots", {
      capturedAt: Date.now(),
      symbol: envelope.providerSymbol,
      marketKind: envelope.marketKind,
      lastUpdateId: snapshot.lastUpdateId,
      bids: JSON.stringify(snapshot.bids),
      asks: JSON.stringify(snapshot.asks),
    });
    lastDepthSnapshotUpdateIdByPair.set(key, snapshot.lastUpdateId);
    counters.depthSnapshots += 1;
  }

  function handleEnvelope(envelope, depthSnapshotResult) {
    if (fatalError) return;
    if (envelope === null || typeof envelope !== "object") {
      rejectRecord("malformed envelope", envelope);
      return;
    }
    if (envelope.state === "UNAVAILABLE") return;
    if (
      envelope.provider !== "BINANCE" ||
      envelope.venue !== "BINANCE" ||
      envelope.timingClass !== "REALTIME" ||
      typeof envelope.stale !== "boolean" ||
      !["READY", "RECOVERING", "UNAVAILABLE"].includes(envelope.recoveryState) ||
      !hasAllowedIdentity(envelope)
    ) {
      rejectRecord("envelope with an invalid canonical identity or health context", envelope);
      return;
    }
    try {
      if (envelope.eventType === EVENT_TYPES.TRADE) {
        recordTrade(envelope);
      } else if (envelope.eventType === EVENT_TYPES.KLINE) {
        recordCandle(envelope);
      } else if (envelope.eventType === EVENT_TYPES.DEPTH) {
        recordDepthSnapshot(envelope, depthSnapshotResult);
        recordDepthEvent(envelope);
      } else {
        rejectRecord("envelope with an unsupported event type", envelope);
      }
    } catch (error) {
      handleFatalError(error);
    }
  }

  function compactIngress() {
    if (ingressHead >= 1024 && ingressHead * 2 >= ingressEnvelopes.length) {
      ingressEnvelopes.splice(0, ingressHead);
      ingressHead = 0;
    }
  }

  function pendingIngressCount() {
    return ingressEnvelopes.length - ingressHead;
  }

  function oldestIngressAgeMs() {
    const oldest = ingressEnvelopes[ingressHead];
    return oldest ? Math.max(0, performance.now() - oldest.acceptedAt) : 0;
  }

  function drainIngress(maxItems = ingressDrainBatchSize) {
    const startedAt = performance.now();
    let processed = 0;
    while (processed < maxItems && ingressHead < ingressEnvelopes.length && !fatalError) {
      if (processed > 0 && processed % 32 === 0 && performance.now() - startedAt >= ingressDrainMaxMs) {
        break;
      }
      const entry = ingressEnvelopes[ingressHead];
      ingressHead += 1;
      processed += 1;
      handleEnvelope(entry.envelope, entry.depthSnapshotResult);
    }
    compactIngress();
    ingressLastDrainDurationMs = performance.now() - startedAt;
    ingressMaxDrainDurationMs = Math.max(ingressMaxDrainDurationMs, ingressLastDrainDurationMs);
    return pendingIngressCount();
  }

  function scheduleIngressDrain() {
    if (ingressDrainScheduled || fatalError || ingressHead >= ingressEnvelopes.length) return;
    ingressDrainScheduled = true;
    setImmediate(() => {
      ingressDrainScheduled = false;
      if (drainIngress() > 0) scheduleIngressDrain();
    }).unref?.();
  }

  function enqueueEnvelope(envelope) {
    if (fatalError || !started) return;
    if (pendingIngressCount() >= maxPendingIngressEnvelopes) {
      const error = new Error(`storage-service: ingress backlog limit exceeded (${pendingIngressCount()} envelopes)`);
      error.code = "STORAGE_INGRESS_OVERFLOW";
      handleFatalError(error);
      return;
    }
    let depthSnapshotResult;
    if (envelope?.eventType === EVENT_TYPES.DEPTH && typeof connection.getDepthSnapshot === "function") {
      depthSnapshotResult = null;
      try {
        depthSnapshotResult = connection.getDepthSnapshot(envelope.marketKind, envelope.providerSymbol);
      } catch (error) {
        console.error("storage-service: unable to inspect the current depth snapshot", error?.message ?? error);
      }
    }
    ingressEnvelopes.push({ envelope, depthSnapshotResult, acceptedAt: performance.now() });
    ingressHighWaterMark = Math.max(ingressHighWaterMark, pendingIngressCount());
    scheduleIngressDrain();
  }

  function start() {
    if (started) {
      throw new Error("storage-service: start() called twice without stop()");
    }
    started = true;
    fatalError = null;
    activationPromise = null;
    stopPromise = null;
    captureOutcome = { quality: "HEALTHY", cleanShutdown: false, terminationReason: null };
    lastDepthSnapshotUpdateIdByPair.clear();
    priorSessionLastTradeIdByPair.clear();
    lastTradeIdByPair.clear();
    ingressEnvelopes.length = 0;
    ingressHead = 0;
    ingressDrainScheduled = false;
    ingressHighWaterMark = 0;
    ingressLastDrainDurationMs = 0;
    ingressMaxDrainDurationMs = 0;
    Object.assign(counters, {
      trades: 0,
      candles: 0,
      depthEvents: 0,
      depthSnapshots: 0,
      rejected: 0,
      tradeIdGaps: 0,
      missingTradeIds: 0,
      sessionBoundaryTradeIdGaps: 0,
      sessionBoundaryMissingTradeIds: 0,
      providerTradeIdDiscontinuities: 0,
      providerTradeIdSkippedIds: 0,
    });
    try {
      const bootstrapStartedAt = performance.now();
      if (dbPath !== ":memory:") {
        lock = createStorageLock({ lockPath: `${dbPath}.lock` });
        lock.acquire();
      }
      const requiresBootstrap = dbPath === ":memory:" || !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
      try {
        storageDb = createStorageDb({ dbPath, bootstrap: requiresBootstrap });
      } catch (error) {
        if (!requiresBootstrap && /writer requires schema version/.test(error?.message ?? "")) {
          error.message += "; run npm run migrate:storage-schema while the collector is stopped";
        }
        throw error;
      }
      emitTelemetry(telemetry, "storage.bootstrap.ready", {
        durationMs: Number((performance.now() - bootstrapStartedAt).toFixed(1)),
      });
      const priorSession = storageDb.raw.prepare(
        "SELECT ended_at, clean_shutdown, quality FROM capture_sessions ORDER BY started_at DESC LIMIT 1",
      ).get();
      const existingData = storageDb.raw.prepare(
        "SELECT EXISTS(SELECT 1 FROM trades LIMIT 1) OR EXISTS(SELECT 1 FROM candles LIMIT 1) OR EXISTS(SELECT 1 FROM l2_depth_events LIMIT 1) OR EXISTS(SELECT 1 FROM l2_depth_snapshots LIMIT 1) AS has_data",
      ).get();
      const lastTrade = storageDb.raw.prepare(
        "SELECT ts FROM trades ORDER BY id DESC LIMIT 1",
      ).get();
      resumeState = Object.freeze({
        hasExistingData: existingData?.has_data === 1,
        previousSessionEndedAt: Number.isSafeInteger(priorSession?.ended_at) ? priorSession.ended_at : null,
        previousSessionCleanShutdown: priorSession?.clean_shutdown === 1
          ? true
          : priorSession?.clean_shutdown === 0
            ? false
            : null,
        previousSessionQuality: typeof priorSession?.quality === "string" ? priorSession.quality : null,
        lastTradeAt: Number.isSafeInteger(lastTrade?.ts) ? lastTrade.ts : null,
      });
      const latestTradeId = storageDb.raw.prepare(
        "SELECT trade_id FROM trades WHERE symbol = ? AND market_kind = ? ORDER BY id DESC LIMIT 1",
      );
      for (const marketKind of listAllowedMarketKinds()) {
        for (const symbol of listAllowedSymbols()) {
          const tradeId = Number(latestTradeId.get(symbol, marketKind)?.trade_id);
          if (Number.isSafeInteger(tradeId) && tradeId >= 0) {
            priorSessionLastTradeIdByPair.set(`${marketKind}:${symbol}`, tradeId);
          }
        }
      }
      if (useWorker) {
        const workerStartedAt = performance.now();
        writeQueue = createStorageWorkerClient({
          dbPath,
          onFatalError: handleFatalError,
          onTelemetry: (entry) => {
            if (entry?.event === "storage.worker.ready") {
              emitTelemetry(telemetry, "storage.writer.ready", {
                durationMs: Number((performance.now() - workerStartedAt).toFixed(1)),
              });
            }
            emitTelemetry(telemetry, entry?.event, entry);
          },
          ...workerOptions,
        });
      } else {
        writeQueue = createStorageWriteQueue({ storageDb, onFatalError: handleFatalError });
        activateCapture();
      }
    } catch (error) {
      try {
        const stopResult = writeQueue?.stop();
        if (stopResult && typeof stopResult.catch === "function") {
          void stopResult.catch(() => {});
        }
      } catch {
        void 0;
      }
      writeQueue = null;
      storageDb?.close();
      storageDb = null;
      captureSessionId = null;
      activationPromise = null;
      resumeState = Object.freeze({
        hasExistingData: false,
        previousSessionEndedAt: null,
        previousSessionCleanShutdown: null,
        previousSessionQuality: null,
        lastTradeAt: null,
      });
      lock?.release();
      lock = null;
      lastDepthSnapshotUpdateIdByPair.clear();
      priorSessionLastTradeIdByPair.clear();
      lastTradeIdByPair.clear();
      ingressEnvelopes.length = 0;
      ingressHead = 0;
      ingressDrainScheduled = false;
      ingressLastDrainDurationMs = 0;
      ingressMaxDrainDurationMs = 0;
      started = false;
      throw error;
    }
  }

  function finalizeStop() {
    writeQueue = null;
    let finalizationError = null;
    if (storageDb) {
      try {
        if (captureSessionId) {
          const effectiveOutcome = fatalError
            ? { quality: "INVALID", cleanShutdown: false, terminationReason: fatalError.message }
            : captureOutcome;
          storageDb.finishCaptureSession({
            sessionId: captureSessionId,
            endedAt: Date.now(),
            quality: effectiveOutcome.quality,
            cleanShutdown: effectiveOutcome.cleanShutdown,
            terminationReason: effectiveOutcome.terminationReason,
          });
        }
      } catch (error) {
        finalizationError = error;
      }
      try {
        storageDb.close();
      } catch (error) {
        finalizationError ??= error;
      }
      storageDb = null;
    }
    if (lock) {
      try {
        lock.release();
      } catch (error) {
        finalizationError ??= error;
      }
      lock = null;
    }
    lastDepthSnapshotUpdateIdByPair.clear();
    priorSessionLastTradeIdByPair.clear();
    lastTradeIdByPair.clear();
    ingressEnvelopes.length = 0;
    ingressHead = 0;
    ingressDrainScheduled = false;
    captureSessionId = null;
    activationPromise = null;
    if (finalizationError) {
      fatalError ??= finalizationError;
      throw finalizationError;
    }
  }

  function setCaptureOutcome({ quality, cleanShutdown, terminationReason = null }) {
    if (!["HEALTHY", "DEGRADED", "INVALID"].includes(quality)) {
      throw new Error("storage-service: capture quality must be HEALTHY, DEGRADED, or INVALID");
    }
    if (typeof cleanShutdown !== "boolean") {
      throw new Error("storage-service: cleanShutdown must be a boolean");
    }
    captureOutcome = { quality, cleanShutdown, terminationReason };
  }

  function activateCapture() {
    if (captureSessionId) return;
    if (!started || fatalError) {
      throw fatalError ?? new Error("storage-service: capture was stopped before storage became ready");
    }
    const sessionId = randomUUID();
    storageDb.beginCaptureSession({ sessionId, startedAt: Date.now() });
    try {
      unsubscribeMessage = connection.onMessage(enqueueEnvelope);
      captureSessionId = sessionId;
    } catch (error) {
      try {
        storageDb.finishCaptureSession({
          sessionId,
          endedAt: Date.now(),
          quality: "INVALID",
          cleanShutdown: false,
          terminationReason: "STORAGE_SUBSCRIPTION_FAILED",
        });
      } catch {
        void 0;
      }
      throw error;
    }
  }

  function whenReady() {
    if (!started || !writeQueue) {
      return Promise.reject(new Error("storage-service: cannot wait for readiness before start() or after stop()"));
    }
    if (!activationPromise) {
      activationPromise = Promise.resolve(
        typeof writeQueue.waitUntilReady === "function" ? writeQueue.waitUntilReady() : undefined,
      ).then(() => {
        activateCapture();
      });
    }
    return activationPromise;
  }

  function recordIncident(entry) {
    if (!started || fatalError || !writeQueue || !captureSessionId) return false;
    if (entry === null || typeof entry !== "object" || typeof entry.event !== "string" || entry.event.length === 0) {
      return false;
    }
    const invalid =
      entry.event === "market_data.binance_backpressure.event_dropped" ||
      entry.event === "market_data.binance_backpressure.queue_overflow" ||
      entry.event === "market_data.binance_raw_ingress.queue_overflow";
    const parsedTs = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
    const details = {};
    for (const key of [
      "code", "reason", "attempt", "delayMs", "silenceMs", "durationMs", "discardedCount", "droppedCount", "queueDepth",
      "queueBytes", "incomingBytes", "limitKind",
      "previousTradeId", "currentTradeId", "missingCount",
      "scope", "triggerEvent", "recoveredEvent", "startedAt", "endedAt",
    ]) {
      if (["string", "number", "boolean"].includes(typeof entry[key])) details[key] = entry[key];
    }
    if (entry.details !== null && typeof entry.details === "object" && !Array.isArray(entry.details)) {
      for (const [key, value] of Object.entries(entry.details)) {
        if (["string", "number", "boolean"].includes(typeof value)) details[key] = value;
      }
    }
    const severity = invalid || entry.severity === "INVALID" ? "INVALID" : "DEGRADED";
    writeQueue.push("capture_incidents", {
      sessionId: captureSessionId,
      ts: Number.isSafeInteger(parsedTs) && parsedTs >= 0 ? parsedTs : Date.now(),
      severity,
      event: entry.event,
      marketKind: typeof entry.marketKind === "string" ? entry.marketKind : null,
      route: typeof entry.route === "string" ? entry.route : null,
      symbol: typeof entry.symbol === "string" ? entry.symbol : null,
      eventType: typeof entry.eventType === "string" ? entry.eventType : null,
      affectedCount: Math.max(
        severity === "INVALID" ? 1 : 0,
        ...[entry.discardedCount, entry.droppedCount, entry.missingCount]
          .filter((value) => Number.isSafeInteger(value) && value >= 0),
      ),
      details: JSON.stringify(details),
    });
    return true;
  }

  function finishStop() {
    if (writeQueue) {
      let stopResult;
      try {
        stopResult = writeQueue.stop();
      } catch (error) {
        fatalError ??= error;
      }
      if (stopResult && typeof stopResult.then === "function") {
        return stopResult
          .catch((error) => {
            fatalError ??= error;
          })
          .finally(() => {
            finalizeStop();
          })
          .then(() => {
            if (fatalError) throw fatalError;
          });
      }
    }
    finalizeStop();
    if (fatalError) {
      throw fatalError;
    }
  }

  async function drainPendingIngressForStop() {
    while (pendingIngressCount() > 0 && !fatalError) {
      drainIngress(ingressDrainBatchSize);
      if (pendingIngressCount() > 0 && !fatalError) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  function stop() {
    if (!started) return stopPromise ?? undefined;
    started = false;
    if (unsubscribeMessage) {
      unsubscribeMessage();
      unsubscribeMessage = null;
    }
    if (useWorker && pendingIngressCount() > 0) {
      stopPromise = drainPendingIngressForStop().then(finishStop);
      return stopPromise;
    }
    while (pendingIngressCount() > 0 && !fatalError) drainIngress(Number.MAX_SAFE_INTEGER);
    const result = finishStop();
    if (result && typeof result.then === "function") stopPromise = result;
    return result;
  }

  return Object.freeze({
    start,
    stop,
    whenReady,
    setCaptureOutcome,
    recordIncident,
    isHealthy: () => fatalError === null,
    getStats: () => Object.freeze({
      ...counters,
      pendingIngressEnvelopes: pendingIngressCount(),
      storageIngressHighWaterMark: ingressHighWaterMark,
      storageIngressOldestAgeMs: Number(oldestIngressAgeMs().toFixed(1)),
      storageIngressLastDrainMs: Number(ingressLastDrainDurationMs.toFixed(1)),
      storageIngressMaxDrainMs: Number(ingressMaxDrainDurationMs.toFixed(1)),
      ...(typeof writeQueue?.getStats === "function"
        ? writeQueue.getStats()
        : {
            pendingWriteItems: writeQueue?.pendingCount?.() ?? 0,
            storageWorkerReady: !useWorker,
            storageWorkerHealthy: writeQueue?.isHealthy?.() ?? fatalError === null,
          }),
    }),
    getStorageDb: () => storageDb,
    getCaptureSessionId: () => captureSessionId,
    getResumeState: () => resumeState,
  });
}

module.exports = {
  createStorageService,
  DEFAULT_MAX_PENDING_INGRESS_ENVELOPES,
  DEFAULT_INGRESS_DRAIN_BATCH_SIZE,
  DEFAULT_INGRESS_DRAIN_MAX_MS,
};
