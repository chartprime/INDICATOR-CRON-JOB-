#!/usr/bin/env node

const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { waitForAuthorized, waitForChannelOpened } = require("../../../src/providers/dxfeed/dxlink-handshake");
const { adaptNativeDxFeedCandle, isEmptyNativeCandle, CANDLE_INTERVAL_MS } = require("../../../src/providers/dxfeed/dxfeed-candle-adapter");
const { listCollectorInstruments } = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const { DEFAULT_DB_PATH } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 31;
const IDLE_COMPLETION_MS = 2_000;
const INSTRUMENT_TIMEOUT_MS = 180_000;

function closedBoundary(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("native-candle-backfill: invalid clock");
  return Math.floor(nowMs / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
}

function parseLookbackDays(raw) {
  if (raw === undefined) return DEFAULT_LOOKBACK_DAYS;
  if (!/^\d+$/.test(raw)) throw new Error("native-candle-backfill: --days must be an integer");
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_LOOKBACK_DAYS) {
    throw new Error(`native-candle-backfill: --days must be between 1 and ${MAX_LOOKBACK_DAYS}`);
  }
  return days;
}

function parseArgs(argv) {
  let days;
  let dbPath = DEFAULT_DB_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") days = parseLookbackDays(argv[++index]);
    else if (arg === "--db") dbPath = argv[++index];
    else throw new Error(`native-candle-backfill: unsupported argument ${String(arg)}`);
  }
  if (typeof dbPath !== "string" || dbPath.trim() === "") throw new Error("native-candle-backfill: --db requires a path");
  return { days: days ?? DEFAULT_LOOKBACK_DAYS, dbPath };
}

function resumeFromTime(storageService, instrument, requestedFrom) {
  const row = storageService.getStorageDb().raw.prepare(
    "SELECT MIN(ts_open) AS earliest, MAX(ts_open) AS latest FROM dxfeed_candles WHERE symbol = ? AND asset_class = ? AND derivation = 'NATIVE'",
  ).get(instrument.symbol, instrument.assetClass);
  if (!Number.isSafeInteger(row?.earliest) || !Number.isSafeInteger(row?.latest) || row.earliest > requestedFrom) {
    return requestedFrom;
  }
  return Math.max(requestedFrom, row.latest + CANDLE_INTERVAL_MS);
}

const DESCRIBED_CANDLE_FIELDS = Object.freeze(["eventSymbol", "time", "open", "high", "low", "close", "volume", "askVolume", "bidVolume", "count"]);

function describeCandle(item) {
  return JSON.stringify(Object.fromEntries(DESCRIBED_CANDLE_FIELDS.map((field) => [field, item?.[field] ?? null])));
}

function ingestCandleItems(items, { instrument, boundary, storageService }) {
  let written = 0;
  let skipped = 0;
  let latest = null;
  for (const item of items) {
    if (item?.eventType !== "Candle" || item?.eventSymbol !== `${instrument.symbol}{=m}`) continue;
    if (isEmptyNativeCandle(item)) {
      skipped += 1;
      continue;
    }
    let bar;
    try {
      bar = adaptNativeDxFeedCandle(item, { symbol: instrument.symbol });
    } catch (error) {
      throw new Error(`${error.message}; candle ${describeCandle(item)}`);
    }
    if (bar.ts_open >= boundary) continue;
    storageService.recordCandle(instrument.symbol, instrument.assetClass, bar, { derivation: "NATIVE" });
    written += 1;
    latest = latest === null ? bar.ts_open : Math.max(latest, bar.ts_open);
  }
  return { written, skipped, latest };
}

function backfillInstrument({ channel, instrument, fromTime, boundary, storageService, idleMs = IDLE_COMPLETION_MS, timeoutMs = INSTRUMENT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const entry = { symbol: `${instrument.symbol}{=m}`, type: "Candle", fromTime };
    let written = 0;
    let skipped = 0;
    let latest = null;
    let idleTimer;
    const deadline = setTimeout(() => finish(new Error(`native-candle-backfill: ${instrument.symbol} timed out`)), timeoutMs);
    function cleanup() {
      clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      channel.removeMessageListener(onMessage);
      channel.removeErrorListener?.(onError);
      try { channel.send({ type: "FEED_SUBSCRIPTION", remove: [entry] }); } catch { void 0; }
    }
    function finish(error) {
      cleanup();
      if (error) reject(error); else resolve({ written, skipped, latest });
    }
    function armIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), idleMs);
    }
    function onMessage(message) {
      if (message?.type !== "FEED_DATA" || !Array.isArray(message.data)) return;
      try {
        const result = ingestCandleItems(message.data, { instrument, boundary, storageService });
        written += result.written;
        skipped += result.skipped;
        if (result.latest !== null) latest = latest === null ? result.latest : Math.max(latest, result.latest);
        if (message.data.some((item) => item?.eventType === "Candle" && item?.eventSymbol === entry.symbol)) armIdle();
      } catch (error) {
        finish(error);
      }
    }
    function onError(error) { finish(error instanceof Error ? error : new Error(String(error))); }
    channel.addMessageListener(onMessage);
    channel.addErrorListener?.(onError);
    channel.send({ type: "FEED_SUBSCRIPTION", add: [entry] });
  });
}

async function main({ argv = process.argv.slice(2), now = () => Date.now(), logger = createCliLogger({ name: "dxfeed-native-candle-backfill" }) } = {}) {
  let options;
  let connection;
  let channel;
  let storageService;
  let exitCode = 0;
  try {
    options = parseArgs(argv);
    const config = loadDxFeedConfig();
    const boundary = closedBoundary(now());
    const requestedFrom = Math.max(0, boundary - options.days * DAY_MS);
    storageService = createDxFeedStorageService({ dbPath: options.dbPath, bootstrap: false });
    connection = createDxLinkConnection(config);
    connection.connect();
    await waitForAuthorized({ connection, timeoutMs: 15_000 });
    channel = connection.openChannel("FEED", { contract: "HISTORY" }, { reconnect: false });
    await waitForChannelOpened({ channel, timeoutMs: 15_000 });
    channel.send({ type: "FEED_SETUP", acceptDataFormat: "FULL" });
    for (const instrument of listCollectorInstruments()) {
      const fromTime = resumeFromTime(storageService, instrument, requestedFrom);
      if (fromTime >= boundary) {
        logger.info("native candle history already current", { symbol: instrument.symbol, boundary });
        continue;
      }
      const result = await backfillInstrument({ channel, instrument, fromTime, boundary, storageService });
      logger.ok("native candle history stored", { symbol: instrument.symbol, fromTime, boundary, rows: result.written, emptyMinutesSkipped: result.skipped, latest: result.latest });
    }
  } catch (error) {
    exitCode = 1;
    logger.error("native candle backfill failed", { reason: error?.message ?? error });
  } finally {
    try { channel?.close(); } catch { void 0; }
    try { connection?.disconnect(); } catch { void 0; }
    try { storageService?.close(); } catch { void 0; }
  }
  await flushAndExit(logger, process.exit, exitCode);
}

if (require.main === module) void main();

module.exports = {
  DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS, closedBoundary, parseLookbackDays, parseArgs,
  resumeFromTime, ingestCandleItems, backfillInstrument, main,
};
