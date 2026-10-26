#!/usr/bin/env node

const { DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { WebSocket: DefaultWebSocket } = require("ws");
const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { createWsConnector } = require("../../../src/providers/dxfeed/dxlink-ws-connector");
const {
  isFeedDataFrameText,
  extractOrderIndexStringsFromDataArray,
  createRawFrameCapturingWebSocketImpl,
} = require("../../../src/providers/dxfeed/dxfeed-order-v2-capture");
const { redactError, redactSecrets } = require("../../../src/providers/dxfeed/redact");
const {
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
} = require("../../../src/providers/dxfeed/dxfeed-probe-kit");
const { SYMBOLS, FRONT_MONTH_REFERENCE } = require("./verify-dxfeed-capability-probe");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { AUTH_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS } = require("../../../src/providers/dxfeed/dxlink-handshake");

const SNAPSHOT_OBSERVE_WINDOW_MS = 20_000;
const RESUBSCRIBE_OBSERVE_WINDOW_MS = 10_000;

const EVENT_FLAG_BITS = Object.freeze([
  Object.freeze({ name: "TX_PENDING", value: 0x01 }),
  Object.freeze({ name: "REMOVE_EVENT", value: 0x02 }),
  Object.freeze({ name: "SNAPSHOT_BEGIN", value: 0x04 }),
  Object.freeze({ name: "SNAPSHOT_END", value: 0x08 }),
  Object.freeze({ name: "SNAPSHOT_SNIP", value: 0x10 }),
  Object.freeze({ name: "SNAPSHOT_MODE", value: 0x40 }),
]);

const RAW_INDEX_PATTERN = /"index":(-?\d+)/g;

function decodeEventFlags(flags) {
  if (!Number.isSafeInteger(flags) || flags < 0) {
    return Object.freeze({ raw: flags ?? null, hex: null, bits: Object.freeze([]), unknownBits: null });
  }
  const bits = [];
  let accounted = 0;
  for (const { name, value } of EVENT_FLAG_BITS) {
    if ((flags & value) === value) {
      bits.push(name);
      accounted |= value;
    }
  }
  const unknownBits = flags & ~accounted;
  return Object.freeze({
    raw: flags,
    hex: `0x${flags.toString(16)}`,
    bits: Object.freeze(bits),
    unknownBits: unknownBits === 0 ? null : `0x${unknownBits.toString(16)}`,
  });
}

function extractRawIndexStrings(rawText) {
  if (typeof rawText !== "string") return [];
  const matches = [];
  for (const match of rawText.matchAll(RAW_INDEX_PATTERN)) {
    matches.push(match[1]);
  }
  return matches;
}

function extractOrderIndexStringsFromFrame(rawText) {
  return extractOrderIndexStringsFromDataArray(rawText);
}

function indexPrecisionLost(rawIndexString, parsedIndexValue) {
  if (typeof rawIndexString !== "string" || rawIndexString.length === 0) return null;
  if (typeof parsedIndexValue !== "number" || !Number.isFinite(parsedIndexValue)) return null;
  let rawBigInt;
  let parsedBigInt;
  try {
    rawBigInt = BigInt(rawIndexString);
    parsedBigInt = BigInt(Math.trunc(parsedIndexValue));
  } catch {
    return null;
  }
  return rawBigInt !== parsedBigInt;
}

function correlateIndexPrecision(parsedEvents, rawIndexStrings) {
  const countMismatch = parsedEvents.length !== rawIndexStrings.length;
  const comparisons = parsedEvents.map((event, position) => {
    const rawIndex = rawIndexStrings[position] ?? null;
    return Object.freeze({
      position,
      parsedIndex: typeof event?.index === "number" ? event.index : null,
      rawIndex,
      precisionLost: indexPrecisionLost(rawIndex, event?.index),
    });
  });
  return Object.freeze({ countMismatch, comparisons: Object.freeze(comparisons) });
}

function wireSymbolFor(symbolEntry) {
  return symbolEntry.kind === "future" ? FRONT_MONTH_REFERENCE[symbolEntry.root].symbol : symbolEntry.symbol;
}

function orderEntryFor(symbolEntry) {
  const wireSymbol = wireSymbolFor(symbolEntry);
  return symbolEntry.kind === "future"
    ? { symbol: wireSymbol, type: "Order", source: "GLBX" }
    : { symbol: wireSymbol, type: "Order", source: "NTV" };
}

async function probeSymbol({ symbolEntry, channel, wait, now, signal, secrets, rawIndexFrames }) {
  const entry = orderEntryFor(symbolEntry);
  const label = `${symbolEntry.symbol} Order (${entry.source})`;

  const framesBeforeFirst = rawIndexFrames.length;
  const first = await runAttempt({
    channel,
    entry,
    windowMs: SNAPSHOT_OBSERVE_WINDOW_MS,
    wait,
    now,
    signal,
    secrets,
    settleOnFirstEvent: false,
    collectAllEvents: true,
  });
  const rawIndexStringsFirst = rawIndexFrames.slice(framesBeforeFirst).flat();
  const flagsObservedFirst = first.events.map((event) => decodeEventFlags(event?.eventFlags));
  const precisionFirst = correlateIndexPrecision(first.events, rawIndexStringsFirst);

  const framesBeforeSecond = rawIndexFrames.length;
  const second = await runAttempt({
    channel,
    entry,
    windowMs: RESUBSCRIBE_OBSERVE_WINDOW_MS,
    wait,
    now,
    signal,
    secrets,
    settleOnFirstEvent: false,
    collectAllEvents: true,
  });
  const rawIndexStringsSecond = rawIndexFrames.slice(framesBeforeSecond).flat();
  const flagsObservedSecond = second.events.map((event) => decodeEventFlags(event?.eventFlags));
  const precisionSecond = correlateIndexPrecision(second.events, rawIndexStringsSecond);

  return Object.freeze({
    label,
    firstSubscription: Object.freeze({
      outcome: first.outcome,
      eventCount: first.eventCount,
      flagsObserved: Object.freeze(flagsObservedFirst),
      precision: precisionFirst,
    }),
    resubscription: Object.freeze({
      outcome: second.outcome,
      eventCount: second.eventCount,
      flagsObserved: Object.freeze(flagsObservedSecond),
      precision: precisionSecond,
    }),
  });
}

function summarizeProbeResult(result) {
  const firstFlags = result.firstSubscription.flagsObserved.map((decoded) => decoded.bits.join("|") || "(none)");
  const sawSnapshotBegin = result.firstSubscription.flagsObserved.some((decoded) => decoded.bits.includes("SNAPSHOT_BEGIN"));
  const sawSnapshotEnd = result.firstSubscription.flagsObserved.some((decoded) => decoded.bits.includes("SNAPSHOT_END"));
  const anyCountMismatch =
    result.firstSubscription.precision.countMismatch === true ||
    result.resubscription.precision.countMismatch === true;
  const anyPrecisionLoss =
    result.firstSubscription.precision.comparisons.some((c) => c.precisionLost === true) ||
    result.resubscription.precision.comparisons.some((c) => c.precisionLost === true);
  return {
    eventsObserved: result.firstSubscription.eventCount,
    sawSnapshotBeginOnFreshSubscribe: sawSnapshotBegin,
    sawSnapshotEndOnFreshSubscribe: sawSnapshotEnd,
    rawIndexCorrelationCountMismatch: anyCountMismatch,
    rawIndexPrecisionLossObserved: anyCountMismatch ? "INCONCLUSIVE_COUNT_MISMATCH" : anyPrecisionLoss,
    resubscribeEventCount: result.resubscription.eventCount,
    distinctFlagCombinationsFirst: [...new Set(firstFlags)],
  };
}

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-order-book-feasibility-probe" }),
  loadConfig = loadDxFeedConfig,
  createConnection = createDxLinkConnection,
  realWebSocketImpl = DefaultWebSocket,
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
    "DXFEED ORDER-BOOK FEASIBILITY PROBE (DX3.07 Phase A)",
    "single deliberate connect / observe-all-symbols / disconnect cycle",
    `mode     ${config.marketDataMode}`,
    "checks   eventFlags snapshot structure, raw-wire index precision, forced-resubscribe snapshot refresh",
  ]);

  const rawIndexFrames = [];
  function onRawFrame(rawText) {
    const matches = extractOrderIndexStringsFromFrame(rawText);
    if (matches !== null && matches.length > 0) rawIndexFrames.push(matches);
  }
  const createConnector = (url) =>
    createWsConnector(url, { webSocketImpl: createRawFrameCapturingWebSocketImpl(realWebSocketImpl, onRawFrame) });

  let connection;
  try {
    connection = createConnection(config, { createConnector });
  } catch (error) {
    logger.error("failed to initialize dxFeed connection", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    await flushAndExit(logger, exit, 1);
    return;
  }

  let settled = false;
  let channel = null;
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
        logger.error("connection dropped, aborting -- remaining/in-flight symbols are NOT valid findings");
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
  } catch (error) {
    if (settled) return;
    logger.error("failed to open FEED channel", { reason: redactSecrets(String(error?.message ?? error), secrets) });
    finish(1);
    return;
  }
  if (settled) return;

  const results = [];
  for (const symbolEntry of SYMBOLS) {
    if (settled) break;
    let result;
    try {
      result = await probeSymbol({
        symbolEntry,
        channel,
        wait,
        now,
        signal: abortController.signal,
        secrets,
        rawIndexFrames,
      });
    } catch (error) {
      if (settled) return;
      logger.error("probe attempt failed", {
        symbol: symbolEntry.symbol,
        reason: redactSecrets(String(error?.message ?? error), secrets),
      });
      finish(1);
      return;
    }
    logger.info(`result: ${result.label}`, {
      firstSubscription: result.firstSubscription,
      resubscription: result.resubscription,
    });
    results.push(result);
  }

  if (settled) return;

  logger.banner(["FINDINGS SUMMARY"]);
  for (const result of results) {
    logger.info(result.label, summarizeProbeResult(result));
  }

  finish(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("verify-dxfeed-order-book-feasibility-probe: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  main,
  decodeEventFlags,
  extractRawIndexStrings,
  isFeedDataFrameText,
  extractOrderIndexStringsFromFrame,
  indexPrecisionLost,
  correlateIndexPrecision,
  createRawFrameCapturingWebSocketImpl,
  orderEntryFor,
  probeSymbol,
  summarizeProbeResult,
  EVENT_FLAG_BITS,
  SNAPSHOT_OBSERVE_WINDOW_MS,
  RESUBSCRIBE_OBSERVE_WINDOW_MS,
};
