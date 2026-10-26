#!/usr/bin/env node

const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { redactSecrets } = require("../../../src/providers/dxfeed/redact");
const { normalizeDxFeedEvent } = require("../../../src/providers/dxfeed/dxfeed-event-normalizer");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { DEFAULT_DB_PATH } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const {
  waitForAuthorized,
  waitForChannelOpened,
  AUTH_TIMEOUT_MS,
  CHANNEL_OPEN_TIMEOUT_MS,
} = require("../../../src/providers/dxfeed/dxlink-handshake");
const {
  EVENT_TYPES,
  listCollectorInstruments,
  collectorCellKey,
  buildCollectorSubscriptionEntries,
  buildCollectorContextIndex,
  WIRE_TO_CANONICAL_EVENT_TYPE,
} = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");

const MAX_CAPTURE_MS = 45_000;

const SYMBOLS = listCollectorInstruments();
const cellKey = collectorCellKey;
const buildSubscriptionEntries = () => buildCollectorSubscriptionEntries()
  .filter((entry) => entry.type !== "Candle");
const buildContextIndex = () => new Map(
  [...buildCollectorContextIndex()].filter(([, context]) => context.nativeCandle !== true),
);

function listMissingCells(contextIndex, seenCells) {
  return [...contextIndex.keys()].filter((key) => !seenCells.has(key));
}

function countsMatchCaptureDelta(before, after, counters) {
  return ["quotes", "trades", "timeAndSales"].every(
    (kind) =>
      Number.isSafeInteger(before?.[kind]) &&
      Number.isSafeInteger(after?.[kind]) &&
      Number.isSafeInteger(counters?.[kind]) &&
      after[kind] - before[kind] === counters[kind],
  );
}

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-storage-capture" }),
  loadConfig = loadDxFeedConfig,
  createConnection = createDxLinkConnection,
  createStorageService = createDxFeedStorageService,
  createStorageReader = createDxFeedStorageReader,
  dbPath = DEFAULT_DB_PATH,
  now = () => Date.now(),
  wait = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  signalProcess = process,
  exit = process.exit,
} = {}) {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("invalid dxFeed config", { reason: error?.message ?? error });
    await flushAndExit(logger, exit, 1);
    return;
  }
  if (config.marketDataMode !== "realtime") {
    logger.error("dxFeed storage capture requires realtime mode");
    await flushAndExit(logger, exit, 1);
    return;
  }
  const secrets = [config.tempToken];

  logger.banner([
    "DXFEED STORAGE CAPTURE",
    "single deliberate connect / subscribe / normalize+write / disconnect cycle",
    `dbPath   ${dbPath}`,
  ]);

  let storageService;
  try {
    storageService = createStorageService({ dbPath, bootstrap: false });
  } catch (error) {
    logger.error("failed to initialize dxFeed storage", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    await flushAndExit(logger, exit, 1);
    return;
  }
  const contextIndex = new Map(
    [...buildContextIndex()].filter(([, context]) => context.eventType !== EVENT_TYPES.ORDER),
  );
  const seenCells = new Set();
  const totalCells = contextIndex.size;
  let baselineCounts;
  let reader = null;
  try {
    reader = createStorageReader({ dbPath });
    baselineCounts = reader.countAll();
    reader.close();
    reader = null;
    if (!baselineCounts) {
      logger.error("storage read-back was unavailable before capture");
      storageService.close();
      await flushAndExit(logger, exit, 1);
      return;
    }
  } catch (error) {
    logger.error("failed to initialize dxFeed storage read-back", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    try {
      reader?.close();
    } catch {
      void 0;
    }
    storageService.close();
    await flushAndExit(logger, exit, 1);
    return;
  }

  let connection;
  try {
    connection = createConnection(config);
  } catch (error) {
    logger.error("failed to initialize dxFeed connection", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    storageService.close();
    await flushAndExit(logger, exit, 1);
    return;
  }

  let settled = false;
  let channel = null;
  let onMessage = null;
  let onChannelError = null;
  let entries = [];
  let unsubscribeConnectionError = null;
  let unsubscribeConnectionDrop = null;
  let resolveAbortPromise;
  let finishPromise = null;
  const abortPromise = new Promise((resolve) => {
    resolveAbortPromise = resolve;
  });
  function onSigint() {
    logger.warn("received SIGINT, aborting capture");
    finish(130);
  }
  function onSigterm() {
    logger.warn("received SIGTERM, aborting capture");
    finish(143);
  }
  function closeChannel() {
    if (!channel) return;
    if (onMessage) channel.removeMessageListener(onMessage);
    if (onChannelError) channel.removeErrorListener?.(onChannelError);
    if (entries.length > 0) {
      try {
        channel.send({ type: "FEED_SUBSCRIPTION", remove: entries });
      } catch {
        void 0;
      }
    }
    try {
      channel.close();
    } catch {
      void 0;
    }
    channel = null;
    onMessage = null;
    onChannelError = null;
    entries = [];
  }
  function finish(exitCode) {
    if (settled) return finishPromise;
    settled = true;
    let finalExitCode = exitCode;
    resolveAbortPromise();
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
    unsubscribeConnectionError?.();
    unsubscribeConnectionDrop?.();
    closeChannel();
    try {
      reader?.close();
    } catch (error) {
      logger.error("storage reader close failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
      finalExitCode = 1;
    }
    try {
      connection.disconnect();
    } catch (error) {
      logger.error("disconnect failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
      finalExitCode = 1;
    }
    try {
      storageService.close();
    } catch (error) {
      logger.error("storage service close failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
      finalExitCode = 1;
    }
    finishPromise = flushAndExit(logger, exit, finalExitCode);
    return finishPromise;
  }
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);

  try {
    unsubscribeConnectionError = connection.onError((error) => {
      if (settled) return;
      logger.error("connection error", {
        type: typeof error?.type === "string" ? error.type : undefined,
        message: redactSecrets(typeof error?.message === "string" ? error.message : "dxLink error", secrets),
      });
      finish(1);
    });
    unsubscribeConnectionDrop = connection.onConnectionStateChange(({ state, prev }) => {
      if (settled) return;
      if (state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
        logger.error("connection dropped, aborting capture");
        finish(1);
      }
    });
  } catch (error) {
    logger.error("failed to attach dxFeed connection listeners", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    finish(1);
    return;
  }

  try {
    connection.connect();
  } catch (error) {
    logger.error("connection failed before authorization", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    finish(1);
    return;
  }

  try {
    const authorized = await waitForAuthorized({ connection, timeoutMs: AUTH_TIMEOUT_MS, abortPromise });
    if (!authorized || settled) return;
  } catch (error) {
    if (settled) return;
    logger.error("failed to authorize", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  logger.ok("AUTHORIZED");

  try {
    channel = connection.openChannel("FEED", { contract: "AUTO" });
    const opened = await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, abortPromise });
    if (!opened || settled) return;
    channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
  } catch (error) {
    logger.error("failed to open FEED channel", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  let doneEarly;
  const earlyCoverageSignal = new Promise((resolve) => {
    doneEarly = resolve;
  });

  onMessage = function onMessage(message) {
    if (message?.type !== "FEED_DATA" || !Array.isArray(message.data)) return;
    for (const item of message.data) {
      if (settled) return;
      const context = contextIndex.get(cellKey(item?.eventSymbol, item?.eventType));
      if (!context) continue;
      if (context.source !== undefined && item?.source !== context.source) continue;
      if (context.eventType === EVENT_TYPES.ORDER) continue;
      try {
        const envelope = normalizeDxFeedEvent(
          { assetClass: context.assetClass, symbol: context.symbol, eventType: context.eventType, raw: item },
          { receivedAtMs: now() },
        );
        if (envelope.state === "UNAVAILABLE") {
          logger.warn("degraded envelope, not stored", { symbol: context.symbol, eventType: context.eventType, reason: envelope.reason });
          continue;
        }
        if (storageService.handleEnvelope(envelope) !== true) {
          logger.error("canonical envelope was rejected by storage", { symbol: context.symbol, eventType: context.eventType });
          finish(1);
          return;
        }
        seenCells.add(cellKey(item.eventSymbol, item.eventType));
        if (seenCells.size === totalCells) doneEarly();
      } catch (error) {
        logger.error("failed to normalize or store a dxFeed event", {
          reason: redactSecrets(String(error?.message ?? error), secrets),
        });
        finish(1);
        return;
      }
    }
  };
  onChannelError = (error) => {
    if (settled) return;
    logger.error("FEED channel error", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
  };
  try {
    channel.addMessageListener(onMessage);
    channel.addErrorListener?.(onChannelError);
    entries = buildSubscriptionEntries();
  } catch (error) {
    logger.error("failed to attach FEED channel listeners", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    finish(1);
    return;
  }
  try {
    channel.send({ type: "FEED_SUBSCRIPTION", add: entries });
  } catch (error) {
    logger.error("failed to subscribe", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  logger.ok(`subscribed to ${entries.length} entries across ${SYMBOLS.length} symbols`);

  await Promise.race([earlyCoverageSignal, wait(MAX_CAPTURE_MS), abortPromise]);
  if (settled) return;

  closeChannel();

  const counters = storageService.getCounters();
  logger.ok("capture window complete", { cellsCovered: seenCells.size, totalCells, counters });
  if (seenCells.size !== totalCells) {
    logger.error("capture did not persist every required symbol/event/source cell", {
      cellsCovered: seenCells.size,
      totalCells,
      missingCells: listMissingCells(contextIndex, seenCells),
    });
    finish(1);
    return;
  }

  try {
    reader = createStorageReader({ dbPath });
    const counts = reader.countAll();
    logger.banner([
      "READ-BACK COUNTS",
      `quotes        ${counts?.quotes ?? "unavailable"}`,
      `trades        ${counts?.trades ?? "unavailable"}`,
      `timeAndSales  ${counts?.timeAndSales ?? "unavailable"}`,
    ]);
    reader.close();
    reader = null;
    if (!counts) {
      logger.error("storage read-back was unavailable");
      finish(1);
      return;
    }
    if (!countsMatchCaptureDelta(baselineCounts, counts, counters)) {
      logger.error("storage read-back did not match this capture's persisted-event counters", {
        baselineCounts,
        counts,
        counters,
      });
      finish(1);
      return;
    }
  } catch (error) {
    logger.error("failed to verify dxFeed storage read-back", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }

  finish(0);
}

if (require.main === module) {
  main().catch(() => {
    console.error("verify-dxfeed-storage-capture: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = {
  main,
  buildSubscriptionEntries,
  buildContextIndex,
  cellKey,
  countsMatchCaptureDelta,
  listMissingCells,
  waitForAuthorized,
  waitForChannelOpened,
  SYMBOLS,
  WIRE_TO_CANONICAL_EVENT_TYPE,
  MAX_CAPTURE_MS,
};
