#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("terminal-c", { isMain: require.main === module, envFile: true });

const { createApp, DEFAULT_PORT, DEFAULT_SYMBOL, DEFAULT_HOST, DEFAULT_ALLOWED_ORIGINS } = require("../../src/server/app");
const { fromWireSymbol } = require("../../src/server/frames");
const { isAllowedSymbol } = require("../../src/providers/binance/binance-config");
const { createThrottledConsoleSink } = require("../../src/platform/telemetry-console-sink");
const { createCliLogger } = require("../../src/platform/cli-logger");
const { createCliHeartbeat } = require("../../src/platform/cli-heartbeat");
const { installConsolePersistenceBridge } = require("../../src/platform/console-persistence-bridge");
const { liquidityOptionsFromEnv } = require("../../src/indicators/passive_liquidity/liquidity-publisher");
const { pruneExpiredFutureStores, DEFAULT_STORE_DIR } = require("../../src/indicators/l2-memory/liquidity-store");
const { listCollectorInstruments } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { hostReadMeter } = require("../../src/platform/host-read-meter");
const { isMarketOpen } = require("../../src/providers/shared/market-calendar");

const INSTRUMENT_TABLE_POLL_MS = 1_000;

function dxfeedBooksSummary(instruments, nowMs = Date.now()) {
  if (instruments.length === 0) return "n/a";
  const readyCount = instruments.filter((row) => row.l2?.status === "READY" && row.l2.stale !== true).length;
  const closedCount = instruments.filter((row) => !isMarketOpen(row.assetClass, nowMs)).length;
  return closedCount === 0 ? `${readyCount}/${instruments.length} READY` : `${readyCount}/${instruments.length} READY, ${closedCount} closed`;
}

function instrumentTableFingerprint(rows) {
  return JSON.stringify(rows.map((row) => ({
    symbol: row.symbol,
    assetClass: row.assetClass,
    l1: row.l1?.recoveryState === "READY"
      ? (row.l1.quiet === true ? "QUIET" : "LIVE")
      : (row.l1?.recoveryState ?? null),
    l2: row.l2?.status === "UNAVAILABLE"
      ? `UNAVAILABLE:${row.l2.reason ?? ""}`
      : (row.l2?.status ?? null),
  })));
}

function startInstrumentTablePoll(app, logger) {
  let lastFingerprint = null;
  const timer = setInterval(() => {
    try {
      const rows = app.dxfeedMarketDataServer.instrumentSnapshot();
      if (rows.length === 0) return;
      const fingerprint = instrumentTableFingerprint(rows);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      logger.instrumentTable(rows);
    } catch (error) {
      try {
        logger.warn?.("instrument table poll failed", { reason: error?.message ?? error });
      } catch {
        void 0;
      }
    }
  }, INSTRUMENT_TABLE_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function parseServerArgs(argv, env = process.env) {
  const port = argv[0] ? Number(argv[0]) : DEFAULT_PORT;
  const rawSymbol = argv[1] ?? DEFAULT_SYMBOL;
  let symbol;
  try {
    symbol = rawSymbol.includes("-") ? fromWireSymbol(rawSymbol) : rawSymbol;
  } catch {
    throw new Error(`invalid symbol "${rawSymbol}"`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid port "${argv[0]}"`);
  }
  if (!isAllowedSymbol(symbol)) {
    throw new Error(`unproven symbol "${rawSymbol}"`);
  }
  const extraAllowedOrigin = env.EXTRA_ALLOWED_ORIGIN;
  return {
    port,
    symbol,
    dxfeedEager: argv.includes("--dxfeed-eager"),
    allowedOrigins: extraAllowedOrigin
      ? [...DEFAULT_ALLOWED_ORIGINS, extraAllowedOrigin]
      : DEFAULT_ALLOWED_ORIGINS,
  };
}

function pruneExpiredLiquidityStores(env, logger) {
  const dir = liquidityOptionsFromEnv(env).storeDir ?? DEFAULT_STORE_DIR;
  const keepPairKeys = listCollectorInstruments()
    .filter((entry) => entry.assetClass === "FUTURE")
    .map((entry) => `FUTURE:${entry.symbol}`);
  const removed = pruneExpiredFutureStores({ dir, keepPairKeys });
  if (removed.length > 0) logger.info("removed heatmap stores of expired futures contracts", { files: removed.join(", ") });
  return removed;
}

function start({
  argv = process.argv.slice(2), env = process.env, processImpl = process,
  logger = createCliLogger({ name: "ws-server" }), createAppImpl = createApp,
  shutdownTimeoutMs = 10_000, pruneStores = null,
} = {}) {
  const telemetry = createThrottledConsoleSink({ log: logger.telemetryLine });
  const restoreConsole = installConsolePersistenceBridge({ logger });
  let app;
  let heartbeat = null;
  let stopInstrumentTablePoll = null;
  let stopPromise = null;
  const onSigint = () => { void shutdown("SIGINT"); };
  const onSigterm = () => { void shutdown("SIGTERM"); };
  const onBeforeExit = () => { void shutdown("natural_exit"); };
  const onFatal = (error) => {
    logger.error("lifecycle.fatal", { errorType: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 300), at: String(error?.stack ?? "").split("\n").slice(1, 4).map((line) => line.trim()).join(" <- ") });
    processImpl.exitCode = 1;
    void shutdown("fatal_error").then(() => processImpl.exit(1));
  };

  function shutdown(reason) {
    if (stopPromise) return stopPromise;
    stopPromise = Promise.resolve().then(async () => {
      logger.warn("lifecycle.stopping", { reason, ...logger.identity });
      heartbeat?.stop();
      stopInstrumentTablePoll?.();
      let deadline;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.resolve().then(() => app?.stop()),
          new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(new Error("shutdown deadline exceeded")); }, shutdownTimeoutMs); }),
        ]);
        logger.ok("lifecycle.stopped", { reason, ...logger.identity });
      } catch (error) {
        logger.error("lifecycle.shutdown_failed", { reason: error?.message ?? "cleanup failed", ...logger.identity });
        processImpl.exitCode = 1;
      } finally {
        clearTimeout(deadline);
        telemetry.stop();
        restoreConsole();
        processImpl.off("SIGINT", onSigint);
        processImpl.off("SIGTERM", onSigterm);
        processImpl.off("beforeExit", onBeforeExit);
        processImpl.off("uncaughtException", onFatal);
        processImpl.off("unhandledRejection", onFatal);
        try { await logger.flush?.({ throwOnError: true }); }
        catch { processImpl.exitCode = 1; }
        logger.close?.();
      }
      if (timedOut) processImpl.exit(1);
    });
    return stopPromise;
  }

  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  processImpl.on("beforeExit", onBeforeExit);
  processImpl.on("uncaughtException", onFatal);
  processImpl.on("unhandledRejection", onFatal);
  logger.info("lifecycle.starting", { mode: env.npm_lifecycle_event === "dev" ? "watch" : "direct", ...logger.identity });
  const ready = Promise.resolve().then(async () => {
    if (stopPromise) return;
    const { port, symbol, dxfeedEager, allowedOrigins } = parseServerArgs(argv, env);
    pruneStores?.(env, logger);
    app = createAppImpl({ port, symbol, allowedOrigins, dxfeedEager, telemetry });
    await app.start();
    if (stopPromise) return;
      logger.banner([
        "MARKET DATA SERVER - frontend WS relay",
        `symbol   ${symbol}`,
        `ws       ws://${DEFAULT_HOST}:${port}/ws`,
        `health   http://${DEFAULT_HOST}:${port}/health`,
        `readiness transport/capture/storage/analytics + per-feature warm-ups at /health`,
        `VPIN     ${env.TT_VPIN_ENABLED === "0" ? "DISABLED by TT_VPIN_ENABLED=0" : "enabled; readiness reported separately"}`,
        `dxFeed   ${
          !env.TT_DXFEED_TOKEN_BROKER_URL
            ? "unavailable, no TT_DXFEED_TOKEN_BROKER_URL configured"
            : dxfeedEager
              ? "eager: connecting every catalog instrument now, planned fresh-session rotation before expiry"
              : "available on select, session-scoped, self-terminating"
        }`,
      ]);
      heartbeat = createCliHeartbeat({
        logger,
        collect: () => {
          const activeProvider = app.router.getActiveProvider();
          const dxfeedSymbol = app.dxfeedMarketDataServer.currentSymbolInfo();
          const dxfeedInstruments = app.dxfeedMarketDataServer.instrumentSnapshot();
          const selectedDxfeedInstrument = dxfeedSymbol == null ? null : dxfeedInstruments.find(
            (row) => row.symbol === dxfeedSymbol.symbol && row.assetClass === dxfeedSymbol.assetClass,
          );
          const memory = process.memoryUsage();
          const hostReads = hostReadMeter.snapshot();
          const retained = dxfeedInstruments.reduce((totals, row) => ({
            bars: totals.bars + (row.retention?.bars ?? 0),
            trades: totals.trades + (row.retention?.trades ?? 0),
            markers: totals.markers + (row.retention?.markers ?? 0),
          }), { bars: 0, trades: 0, markers: 0 });
          return {
            clients: app.router.connectedClientCount(),
            activeProvider,
            analytics: activeProvider === "DXFEED"
              ? { symbol: dxfeedSymbol?.symbol ?? null, assetClass: dxfeedSymbol?.assetClass ?? null, ...(selectedDxfeedInstrument?.analytics ?? {}) }
              : app.marketDataServer.currentAnalyticsStatus(),
            readiness: activeProvider === "DXFEED"
              ? app.dxfeedMarketDataServer.currentReadiness?.().dimensions
              : app.marketDataServer.currentReadiness?.().dimensions,
            dxfeedActive: app.dxfeedMarketDataServer.isActive(),
            dxfeedRecoveryState: app.dxfeedMarketDataServer.currentRecoveryState(),
            dxfeedSymbol: dxfeedSymbol ? dxfeedSymbol.symbol : null,
            dxfeedBooks: dxfeedBooksSummary(dxfeedInstruments),
            memoryRssMiB: Math.round(memory.rss / 1024 / 1024),
            memoryHeapMiB: Math.round(memory.heapUsed / 1024 / 1024),
            hostReadsPerMin: hostReads.requests,
            hostRateLimitedPerMin: hostReads.rateLimited,
            retained,
          };
        },
        isNominal: (current) => {
          if (current.activeProvider === "DXFEED") return current.dxfeedRecoveryState === "READY" || current.readiness?.transport === "CLOSED";
          return current.readiness?.transport === "READY";
        },
        degradedReason: (current) => current.activeProvider === "DXFEED" && current.dxfeedRecoveryState === "RECOVERING"
          ? "dxFeed session is recovering"
          : current.activeProvider === "DXFEED"
            ? "dxFeed session is unavailable"
            : current.readiness?.transport !== "READY"
              ? "Binance transport is not ready"
              : "market-data relay is unavailable",
      });
      heartbeat.start();
      stopInstrumentTablePoll = startInstrumentTablePoll(app, logger);
      logger.ok("listening", { symbol, port });
  });
  ready.catch(async (error) => {
    if (!stopPromise) {
      logger.error("lifecycle.start_failed", { reason: error?.message ?? "startup failed", ...logger.identity });
      processImpl.exitCode = 1;
    }
    await shutdown("startup_failure");
  });
  return Object.freeze({ ready, shutdown });
}

if (require.main === module) {
  start({ pruneStores: pruneExpiredLiquidityStores });
}

module.exports = { start, parseServerArgs, dxfeedBooksSummary, instrumentTableFingerprint, startInstrumentTablePoll, pruneExpiredLiquidityStores };
