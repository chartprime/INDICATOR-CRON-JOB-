#!/usr/bin/env node

const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { redactError, redactSecrets } = require("../../../src/providers/dxfeed/redact");
const {
  eventMatchesSubscription,
  classifyAttemptOutcome,
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
} = require("../../../src/providers/dxfeed/dxfeed-probe-kit");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS } = require("../../../src/providers/dxfeed/dxlink-handshake");

const CANDLE_LOOKBACK_MS = 5 * 60 * 1000;

const FRONT_MONTH_REFERENCE = {
  ES: {
    symbol: "/ESZ26:XCME",
    source:
      "observed directly on this account on 2026-09-22: Quote, Trade, Candle and GLBX Order all DATA_OBSERVED",
  },
  NQ: {
    symbol: "/NQZ26:XCME",
    source:
      "observed directly on this account on 2026-09-22: Quote, Trade, Candle and GLBX Order all DATA_OBSERVED",
  },
};

const SYMBOLS = [
  { symbol: "/NQ", kind: "future", root: "NQ" },
  { symbol: "/ES", kind: "future", root: "ES" },
  { symbol: "AAPL", kind: "equity" },
  { symbol: "TSLA", kind: "equity" },
];

const EVENT_TYPES = ["Quote", "Trade", "Candle", "Order"];

const ATTEMPT_WINDOW_MS = { Quote: 8_000, Trade: 8_000, Candle: 15_000, Order: 8_000 };

function wireSymbolFor(symbolEntry) {
  return symbolEntry.kind === "future" ? FRONT_MONTH_REFERENCE[symbolEntry.root].symbol : symbolEntry.symbol;
}

function frontMonthSourceFor(symbolEntry) {
  return symbolEntry.kind === "future" ? FRONT_MONTH_REFERENCE[symbolEntry.root].source : undefined;
}

function buildSubscriptionAttempts({ symbolEntry, eventType, now }) {
  const wireSymbol = wireSymbolFor(symbolEntry);
  const frontMonthSource = frontMonthSourceFor(symbolEntry);

  if (eventType === "Candle") {
    return [
      {
        label: `${symbolEntry.symbol} Candle`,
        entry: { symbol: `${wireSymbol}{=m}`, type: "Candle", fromTime: now() - CANDLE_LOOKBACK_MS },
        frontMonthSource,
      },
    ];
  }

  if (eventType === "Order") {
    if (symbolEntry.kind === "future") {
      return [
        {
          label: `${symbolEntry.symbol} Order (source GLBX)`,
          entry: { symbol: wireSymbol, type: "Order", source: "GLBX" },
          frontMonthSource,
        },
      ];
    }
    return [
      { label: `${symbolEntry.symbol} Order (no source)`, entry: { symbol: wireSymbol, type: "Order" } },
      { label: `${symbolEntry.symbol} Order (source NTV)`, entry: { symbol: wireSymbol, type: "Order", source: "NTV" } },
      {
        label: `${symbolEntry.symbol} Order (source COMPOSITE)`,
        entry: { symbol: wireSymbol, type: "Order", source: "COMPOSITE" },
      },
    ];
  }

  return [
    { label: `${symbolEntry.symbol} ${eventType}`, entry: { symbol: wireSymbol, type: eventType }, frontMonthSource },
  ];
}

function classifyCellOutcome(attemptResults) {
  if (attemptResults.some((attempt) => attempt.outcome === "DATA_OBSERVED")) {
    return "DATA_OBSERVED";
  }
  if (attemptResults.some((attempt) => attempt.outcome === "EXPLICIT_ERROR")) {
    return "EXPLICIT_ERROR";
  }
  return "NO_DATA_OBSERVED";
}

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-capability-probe" }),
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
    "DXFEED CAPABILITY PROBE",
    "single deliberate connect / probe-all-cells / disconnect cycle",
    `mode     ${config.marketDataMode}`,
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
  let channel;
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
    try {
      channel?.close();
    } catch {
      void 0;
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

  try {
    channel = connection.openChannel("FEED", { contract: "AUTO" });
    await waitForChannelOpened({ channel, timeoutMs: CHANNEL_OPEN_TIMEOUT_MS, signal: abortController.signal });
    channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
  } catch (error) {
    logger.error("failed to open FEED channel", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  if (settled) return;

  const results = [];
  for (const symbolEntry of SYMBOLS) {
    for (const eventType of EVENT_TYPES) {
      if (settled) break;
      const attempts = buildSubscriptionAttempts({ symbolEntry, eventType, now });
      const attemptResults = [];
      let cellOutcome = null;
      for (const attempt of attempts) {
        if (settled) break;
        const windowMs = ATTEMPT_WINDOW_MS[eventType];
        let result;
        try {
          result = await runAttempt({
            channel,
            entry: attempt.entry,
            windowMs,
            wait,
            now,
            signal: abortController.signal,
            secrets,
          });
        } catch (error) {
          if (settled) return;
          logger.error("capability attempt failed", {
            label: attempt.label,
            reason: redactSecrets(String(error?.message ?? error), secrets),
          });
          finish(1);
          return;
        }
        attemptResults.push({ label: attempt.label, ...result });
        logger.info(`cell attempt: ${attempt.label}`, {
          outcome: result.outcome,
          elapsedMs: result.elapsedMs,
          frontMonthSource: attempt.frontMonthSource,
          evidence: result.evidence,
        });
        if (result.outcome === "DATA_OBSERVED") {
          cellOutcome = result.outcome;
          break;
        }
      }
      if (!cellOutcome) cellOutcome = classifyCellOutcome(attemptResults);
      results.push({ symbol: symbolEntry.symbol, eventType, outcome: cellOutcome, attempts: attemptResults });
      logger.ok(`cell result: ${symbolEntry.symbol} ${eventType}`, { outcome: cellOutcome });
    }
  }

  logger.banner(["FINDINGS TABLE"]);
  for (const cell of results) {
    logger.info(`${cell.symbol} / ${cell.eventType}: ${cell.outcome}`);
  }

  finish(0);
}

if (require.main === module) {
  main().catch(() => {
    console.error("verify-dxfeed-capability-probe: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = {
  main,
  buildSubscriptionAttempts,
  classifyAttemptOutcome,
  classifyCellOutcome,
  eventMatchesSubscription,
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
  SYMBOLS,
  EVENT_TYPES,
  ATTEMPT_WINDOW_MS,
  FRONT_MONTH_REFERENCE,
};
