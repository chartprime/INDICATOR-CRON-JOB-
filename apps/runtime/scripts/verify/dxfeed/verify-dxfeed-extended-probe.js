#!/usr/bin/env node

const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { redactError, redactSecrets } = require("../../../src/providers/dxfeed/redact");
const {
  redactEvidence,
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
} = require("../../../src/providers/dxfeed/dxfeed-probe-kit");
const { SYMBOLS, FRONT_MONTH_REFERENCE } = require("./verify-dxfeed-capability-probe");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS } = require("../../../src/providers/dxfeed/dxlink-handshake");

const FEED_ATTEMPT_WINDOW_MS = 10_000;
const DOM_SNAPSHOT_WINDOW_MS = 10_000;
const CANDLE_ATTEMPT_WINDOW_MS = 10_000;
const CANDLE_HISTORICAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CANDLE_CONTRACT = "HISTORY";

const FEED_EVENT_TYPES = ["TimeAndSale", "TradeETH", "AnalyticOrder"];
const FEED_EVENT_CONTRACTS = Object.freeze({
  TimeAndSale: "STREAM",
  TradeETH: "TICKER",
  AnalyticOrder: "STREAM",
});
const DOM_SETUP = Object.freeze({
  type: "DOM_SETUP",
  acceptAggregationPeriod: 10,
  acceptDepthLimit: 20,
  acceptDataFormat: "FULL",
  acceptOrderFields: ["price", "size"],
});

function wireSymbolFor(symbolEntry) {
  return symbolEntry.kind === "future" ? FRONT_MONTH_REFERENCE[symbolEntry.root].symbol : symbolEntry.symbol;
}

function domSourcesFor(symbolEntry) {
  return symbolEntry.kind === "future" ? ["glbx"] : ["ntv"];
}

function buildFeedAttempt({ symbolEntry, eventType }) {
  const wireSymbol = wireSymbolFor(symbolEntry);
  if (eventType === "TradeETH" && symbolEntry.kind !== "equity") return null;
  if (eventType === "AnalyticOrder") {
    if (symbolEntry.kind !== "future") return null;
    return { label: `${symbolEntry.symbol} AnalyticOrder (source GLBX)`, entry: { symbol: wireSymbol, type: "AnalyticOrder", source: "GLBX" } };
  }
  return { label: `${symbolEntry.symbol} ${eventType}`, entry: { symbol: wireSymbol, type: eventType } };
}

function buildCandleAttempts({ symbolEntry, now }) {
  const candleSymbol = `${wireSymbolFor(symbolEntry)}{=m}`;
  return [
    {
      label: `${symbolEntry.symbol} Candle (explicit HISTORY contract, fromTime=now-24h)`,
      entry: { symbol: candleSymbol, type: "Candle", fromTime: now() - CANDLE_HISTORICAL_LOOKBACK_MS },
    },
  ];
}

function summarizeAggressorEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    aggressorSide: evidence.aggressorSide,
    tradeId: evidence.tradeId,
    exchangeSaleConditions: evidence.exchangeSaleConditions,
    type: evidence.type,
  };
}

function summarizeIcebergEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    icebergPeakSize: evidence.icebergPeakSize,
    icebergHiddenSize: evidence.icebergHiddenSize,
    icebergExecutedSize: evidence.icebergExecutedSize,
    icebergType: evidence.icebergType,
  };
}

async function runDomAttempt({ connection, symbolEntry, windowMs, wait, now, signal, secrets }) {
  if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
  const label = `${symbolEntry.symbol} DOM (${domSourcesFor(symbolEntry).join(",")})`;
  const startedAt = now();
  let channel;
  try {
    channel = connection.openChannel(
      "DOM",
      { symbol: wireSymbolFor(symbolEntry), sources: domSourcesFor(symbolEntry) },
      { reconnect: false },
    );
  } catch (error) {
    return { label, outcome: "EXPLICIT_ERROR", evidence: { message: redactSecrets(String(error?.message ?? error), secrets) }, elapsedMs: now() - startedAt };
  }

  let receivedError = null;
  function onError(error) {
    receivedError = redactError(error, secrets);
  }
  let errorListenerAttached = false;
  try {
    channel.addErrorListener(onError);
    errorListenerAttached = true;
  } catch (error) {
    try {
      channel.close();
    } catch {
      void 0;
    }
    return {
      label,
      outcome: "EXPLICIT_ERROR",
      evidence: { message: redactSecrets(String(error?.message ?? error), secrets) },
      elapsedMs: now() - startedAt,
    };
  }

  try {
    await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, signal });
  } catch (error) {
    try {
      if (errorListenerAttached) channel.removeErrorListener(onError);
      channel.close();
    } catch {
      void 0;
    }
    return {
      label,
      outcome: "EXPLICIT_ERROR",
      evidence: receivedError ?? { message: redactSecrets(String(error?.message ?? error), secrets) },
      elapsedMs: now() - startedAt,
    };
  }

  const receivedSnapshots = [];
  let receivedConfiguration = null;
  let settleEarly;
  const earlySignal = new Promise((resolve) => {
    settleEarly = resolve;
  });
  function onMessage(message) {
    if (message?.type === "DOM_CONFIG") {
      receivedConfiguration = redactEvidence(message, secrets);
      return;
    }
    if (message?.type !== "DOM_SNAPSHOT") return;
    receivedSnapshots.push(redactEvidence(message, secrets));
    settleEarly();
  }
  function onLiveError(error) {
    receivedError = redactError(error, secrets);
    settleEarly();
  }
  let messageListenerAttached = false;
  function cleanupChannel() {
    if (messageListenerAttached) {
      try {
        channel.removeMessageListener(onMessage);
      } catch {
        void 0;
      }
      messageListenerAttached = false;
    }
    if (errorListenerAttached) {
      try {
        channel.removeErrorListener(onLiveError);
      } catch {
        void 0;
      }
      errorListenerAttached = false;
    }
    try {
      channel.close();
    } catch {
      void 0;
    }
  }
  try {
    channel.removeErrorListener(onError);
    errorListenerAttached = false;
    channel.addMessageListener(onMessage);
    messageListenerAttached = true;
    channel.addErrorListener(onLiveError);
    errorListenerAttached = true;
    channel.send(DOM_SETUP);
  } catch (error) {
    cleanupChannel();
    return {
      label,
      outcome: "EXPLICIT_ERROR",
      evidence: { message: redactSecrets(String(error?.message ?? error), secrets) },
      elapsedMs: now() - startedAt,
    };
  }

  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("operation aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([earlySignal, wait(windowMs), abortPromise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cleanupChannel();
  }

  const elapsedMs = now() - startedAt;
  if (receivedError) return { label, outcome: "EXPLICIT_ERROR", evidence: receivedError, configuration: receivedConfiguration, elapsedMs };
  if (receivedSnapshots.length > 0) {
    return {
      label,
      outcome: "DATA_OBSERVED",
      evidence: receivedSnapshots[0],
      configuration: receivedConfiguration,
      elapsedMs,
    };
  }
  return { label, outcome: "NO_DATA_OBSERVED", evidence: null, configuration: receivedConfiguration, elapsedMs };
}

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-extended-probe" }),
  loadConfig = loadDxFeedConfig,
  createConnection = createDxLinkConnection,
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
  const secrets = [config.tempToken];
  const abortController = new AbortController();

  logger.banner([
    "DXFEED EXTENDED CAPABILITY PROBE",
    "single deliberate connect / probe-all-cells / disconnect cycle",
    `mode     ${config.marketDataMode}`,
    `covers   TimeAndSale/AnalyticOrder (STREAM), TradeETH (TICKER), Candle (HISTORY), and DOM`,
  ]);

  let connection;
  try {
    connection = createConnection(config);
  } catch (error) {
    logger.error("failed to initialize dxFeed connection", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    await flushAndExit(logger, exit, 1);
    return;
  }

  let settled = false;
  const feedChannels = new Map();
  const feedConfigurations = new Map();
  const feedConfigListeners = new Map();
  let unsubscribeConnectionState;
  let unsubscribeConnectionError;
  let finishPromise = null;
  function onSigint() {
    logger.warn("received SIGINT, aborting probe");
    finish(130);
  }
  function onSigterm() {
    logger.warn("received SIGTERM, aborting probe");
    finish(143);
  }
  function finish(exitCode) {
    if (settled) return finishPromise;
    settled = true;
    abortController.abort(new Error("probe stopped"));
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
    unsubscribeConnectionState?.();
    unsubscribeConnectionError?.();
    for (const [contract, activeChannel] of feedChannels) {
      try {
        activeChannel.removeMessageListener(feedConfigListeners.get(contract));
      } catch {
        void 0;
      }
      try {
        activeChannel.close();
      } catch {
        void 0;
      }
    }
    try {
      connection.disconnect();
    } catch (error) {
      logger.error("disconnect failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    }
    finishPromise = flushAndExit(logger, exit, exitCode);
    return finishPromise;
  }
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);
  try {
    unsubscribeConnectionError = connection.onError((error) => {
      if (settled) return;
      logger.error("connection error", redactError(error, secrets));
      finish(1);
    });
    unsubscribeConnectionState = connection.onConnectionStateChange(({ state, prev }) => {
      if (settled) return;
      if (state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
        logger.error("connection dropped, aborting -- remaining/in-flight cells are NOT valid findings");
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
  if (settled) return;

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
    await waitForAuthorized({ connection, timeoutMs: AUTH_TIMEOUT_MS, signal: abortController.signal });
  } catch (error) {
    if (settled) return;
    logger.error("failed to authorize", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  logger.ok("AUTHORIZED");
  if (settled) return;

  for (const contract of new Set([...Object.values(FEED_EVENT_CONTRACTS), CANDLE_CONTRACT])) {
    try {
      const feedChannel = connection.openChannel("FEED", { contract }, { reconnect: false });
      feedChannels.set(contract, feedChannel);
      await waitForChannelOpened({ channel: feedChannel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, signal: abortController.signal });
      const onConfiguration = (message) => {
        if (message?.type === "FEED_CONFIG") {
          feedConfigurations.set(contract, redactEvidence(message, secrets));
        }
      };
      feedChannel.addMessageListener(onConfiguration);
      feedConfigListeners.set(contract, onConfiguration);
      feedChannel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
    } catch (error) {
      logger.error("failed to open FEED channel", {
        contract,
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      finish(1);
      return;
    }
  }
  if (settled) return;

  const results = [];

  for (const symbolEntry of SYMBOLS) {
    for (const eventType of FEED_EVENT_TYPES) {
      if (settled) break;
      const attempt = buildFeedAttempt({ symbolEntry, eventType });
      if (!attempt) {
        logger.info(`skipped: ${symbolEntry.symbol} ${eventType} -- not applicable to this instrument`);
        continue;
      }
      let result;
      try {
        result = await runAttempt({
          channel: feedChannels.get(FEED_EVENT_CONTRACTS[eventType]),
          entry: attempt.entry,
          windowMs: FEED_ATTEMPT_WINDOW_MS,
          wait,
          now,
          signal: abortController.signal,
          secrets,
        });
      } catch (error) {
        if (settled) return;
        logger.error("probe attempt failed", { label: attempt.label, reason: redactSecrets(String(error?.message ?? error), secrets) });
        finish(1);
        return;
      }
      logger.info(`result: ${attempt.label}`, {
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
        configuration: feedConfigurations.get(FEED_EVENT_CONTRACTS[eventType]),
        evidence: result.evidence,
        aggressorEvidence: eventType === "TimeAndSale" ? summarizeAggressorEvidence(result.evidence) : undefined,
        icebergEvidence: eventType === "AnalyticOrder" ? summarizeIcebergEvidence(result.evidence) : undefined,
      });
      results.push({ label: attempt.label, outcome: result.outcome });
    }
  }

  if (settled) return;

  for (const symbolEntry of SYMBOLS) {
    if (settled) break;
    let result;
    try {
      result = await runDomAttempt({
        connection,
        symbolEntry,
        windowMs: DOM_SNAPSHOT_WINDOW_MS,
        wait,
        now,
        signal: abortController.signal,
        secrets,
      });
    } catch (error) {
      if (settled) return;
      logger.error("DOM probe attempt failed", { symbol: symbolEntry.symbol, reason: redactSecrets(String(error?.message ?? error), secrets) });
      finish(1);
      return;
    }
    logger.info(`result: ${result.label}`, {
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
      configuration: result.configuration,
      evidence: result.evidence,
    });
    results.push({ label: result.label, outcome: result.outcome });
  }

  if (settled) return;

  const candleChannel = feedChannels.get(CANDLE_CONTRACT);

  for (const symbolEntry of SYMBOLS) {
    if (settled) break;
    for (const attempt of buildCandleAttempts({ symbolEntry, now })) {
      if (settled) break;
      let result;
      try {
        result = await runAttempt({
          channel: candleChannel,
          entry: attempt.entry,
          windowMs: CANDLE_ATTEMPT_WINDOW_MS,
          wait,
          now,
          signal: abortController.signal,
          secrets,
          settleOnFirstEvent: false,
        });
      } catch (error) {
        if (settled) return;
        logger.error("Candle diagnostic attempt failed", { label: attempt.label, reason: redactSecrets(String(error?.message ?? error), secrets) });
        finish(1);
        return;
      }
      logger.info(`result: ${attempt.label}`, {
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
        eventCount: result.eventCount,
        earliestEventTime: result.earliestEventTime,
        latestEventTime: result.latestEventTime,
        configuration: feedConfigurations.get(CANDLE_CONTRACT),
        evidence: result.evidence,
      });
      results.push({ label: attempt.label, outcome: result.outcome });
    }
  }
  logger.banner(["FINDINGS TABLE"]);
  for (const cell of results) {
    logger.info(`${cell.label}: ${cell.outcome}`);
  }

  finish(0);
}

if (require.main === module) {
  main().catch(() => {
    console.error("verify-dxfeed-extended-probe: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = {
  main,
  buildFeedAttempt,
  buildCandleAttempts,
  runDomAttempt,
  summarizeAggressorEvidence,
  summarizeIcebergEvidence,
  domSourcesFor,
  FEED_EVENT_TYPES,
  FEED_EVENT_CONTRACTS,
  CANDLE_CONTRACT,
  DOM_SETUP,
  FEED_ATTEMPT_WINDOW_MS,
  DOM_SNAPSHOT_WINDOW_MS,
  CANDLE_ATTEMPT_WINDOW_MS,
};
