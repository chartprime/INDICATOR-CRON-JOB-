#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("live-storage", { isMain: require.main === module });

const http = require("node:http");
const fs = require("node:fs");
const { createLiveStorageRoute } = require("../../src/server/live-storage-route");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { DEFAULT_DB_PATH } = require("../../src/storage/storage-db");
const { createDxFeedStorageReader } = require("../../src/storage/dxfeed/dxfeed-storage-reader");
const { DEFAULT_DB_PATH: DEFAULT_DXFEED_DB_PATH } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createCliLogger } = require("../../src/platform/cli-logger");
const { createReplayPageReader } = require("../../src/server/replay-page-reader");
const { createInstrumentTickSizeResolver } = require("../../src/providers/shared/instrument-tick-size");
const { createRuntimeHealthMonitor } = require("../../src/platform/runtime-health-monitor");
const { createPyramidReader } = require("../../src/indicators/l2-memory/pyramid/pyramid-reader");
const { defaultHeatmapDir } = require("../../src/indicators/l2-memory/pyramid/pyramid-paths");
const { createIcebergHostReader } = require("../../src/indicators/iceberg/iceberg-host-reader");
const { defaultIcebergDir } = require("../../src/indicators/iceberg/iceberg-host-service");

const DEFAULT_PORT = 8003;
const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const FATAL_EXIT_TIMEOUT_MS = 20_000;

function parseBindHost(rawHost) {
  if (typeof rawHost !== "string" || !LOOPBACK_BIND_HOSTS.has(rawHost)) {
    throw new Error(`run-live-storage-service: host must be an explicit loopback address, got "${rawHost}"`);
  }
  return rawHost === "localhost" ? "127.0.0.1" : rawHost;
}

function parseServiceArgs(argv = [], env = process.env) {
  const rawPort = argv[0] ?? env.TT_LIVE_STORAGE_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  const rawHost = argv[1] ?? env.TT_LIVE_STORAGE_HOST ?? DEFAULT_HOST;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`run-live-storage-service: invalid port "${rawPort}"`);
  }
  return {
    port, host: parseBindHost(rawHost),
    dbPath: env.TT_LIVE_STORAGE_DB_PATH || DEFAULT_DB_PATH,
    dxfeedDbPath: env.TT_LIVE_STORAGE_DXFEED_DB_PATH || DEFAULT_DXFEED_DB_PATH,
    heatmapDir: env.TT_HEATMAP_DIR || defaultHeatmapDir(),
    icebergDir: env.TT_ICEBERG_DIR || defaultIcebergDir(),
  };
}

function configurationProblems(env = process.env) {
  const problems = [];
  if (!env.TT_LIVE_STORAGE_SERVICE_SECRET) problems.push("SERVICE_SECRET_NOT_CONFIGURED");
  return problems;
}

function createService({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  dbPath = DEFAULT_DB_PATH,
  dxfeedDbPath = DEFAULT_DXFEED_DB_PATH,
  heatmapDir = null,
  icebergDir = null,
  env = process.env,
  log = console.error,
  storageReader,
  dxfeedStorageReader,
  replayPageReader,
  heatmapReader,
  icebergReader,
  tickSizeResolver,
  liveStorageRoute,
  createHealthMonitor = createRuntimeHealthMonitor,
} = {}) {
  host = parseBindHost(host);
  const reader = storageReader ?? createStorageReader({ dbPath });
  const dxfeedReader = dxfeedStorageReader ?? createDxFeedStorageReader({ dbPath: dxfeedDbPath });
  const replayReader = replayPageReader ?? (env.TT_LIVE_STORAGE_SERVICE_SECRET ? createReplayPageReader({
    dbPath,
    dxfeedDbPath,
    cursorSecret: env.TT_LIVE_STORAGE_SERVICE_SECRET,
    tickSizeResolver: tickSizeResolver ?? createInstrumentTickSizeResolver(),
  }) : null);
  const pyramidReader = heatmapReader ?? (heatmapDir === null ? null : createPyramidReader({ dir: heatmapDir }));
  const icebergHistoryReader = icebergReader ?? (icebergDir === null ? null : createIcebergHostReader({ dir: icebergDir }));
  const route = liveStorageRoute ?? createLiveStorageRoute({
    storageReader: reader,
    dxfeedStorageReader: dxfeedReader,
    replayPageReader: replayReader,
    heatmapReader: pyramidReader,
    icebergReader: icebergHistoryReader,
    serviceSecret: env.TT_LIVE_STORAGE_SERVICE_SECRET,
    log,
  });
  const runtimeHealth = createHealthMonitor();
  const problems = configurationProblems(env);
  let stopping = false;

  function health() {
    const stats = route.stats();
    const reasons = [...problems];
    if (stopping) reasons.push("SHUTTING_DOWN");
    const footprint = (databasePath) => Object.fromEntries(["database", "wal", "shm"].map((kind) => {
      const suffix = kind === "database" ? "" : `-${kind}`;
      try { return [kind, fs.statSync(`${databasePath}${suffix}`).size]; }
      catch (error) {
        if (error?.code === "ENOENT") return [kind, 0];
        return [kind, null];
      }
    }));
    return {
      ready: reasons.length === 0,
      route: stats,
      runtime: runtimeHealth.getStats(),
      storage: { binance: footprint(dbPath), dxfeed: footprint(dxfeedDbPath) },
      heatmap: pyramidReader === null ? null : { dir: heatmapDir, ...pyramidReader.stats() },
      icebergHistory: icebergHistoryReader === null ? null : { dir: icebergDir, ...icebergHistoryReader.stats() },
      ...(reasons.length > 0 ? { reasons } : {}),
    };
  }

  function respondJson(response, status, body) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(payload.length),
      "cache-control": "no-store",
    });
    response.end(payload);
  }

  function respondOrDestroy(response, status, body) {
    try {
      respondJson(response, status, body);
    } catch {
      response.destroy();
    }
  }

  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      try {
        const state = health();
        respondJson(response, state.ready ? 200 : 503, state);
      } catch (error) {
        log("run-live-storage-service: health probe failed", error?.message ?? error);
        respondOrDestroy(response, 503, { ready: false, reasons: ["HEALTH_PROBE_FAILED"] });
      }
      return;
    }
    try {
      if (route.handle(request, response)) return;
      response.writeHead(404, { "content-length": "0" });
      response.end();
    } catch (error) {
      log("run-live-storage-service: request handling failed", error?.message ?? error);
      respondOrDestroy(response, 500, { error: "REQUEST_HANDLER_FAILED" });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  function start() {
    runtimeHealth.start();
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        runtimeHealth.stop();
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve(server.address());
      });
    });
  }

  function stop() {
    stopping = true;
    runtimeHealth.stop();
    route.dispose();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        Promise.all([
          Promise.resolve(reader.close()).catch(() => {}),
          Promise.resolve(dxfeedReader.close()).catch(() => {}),
          Promise.resolve(replayReader?.close()).catch(() => {}),
          Promise.resolve().then(() => pyramidReader?.close()).catch(() => {}),
          Promise.resolve().then(() => icebergHistoryReader?.close()).catch((error) => log("run-live-storage-service: iceberg history reader close failed", error?.message ?? error)),
        ]).finally(resolve);
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      server.close(finish);
      server.closeIdleConnections?.();
    });
  }

  return Object.freeze({ server, route, storageReader: reader, dxfeedStorageReader: dxfeedReader, replayPageReader: replayReader, runtimeHealth, problems, health, start, stop });
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  processImpl = process,
  logger = createCliLogger({ name: "live-storage" }),
} = {}) {
  let service;
  let stopPromise = null;

  function shutdown(reason) {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      logger.info(`${reason}, shutting down`);
      try {
        await service?.stop();
        logger.ok("live-storage service stopped", { reason });
      } catch (error) {
        processImpl.exitCode = 1;
        logger.error("live-storage service shutdown failed", { reason: error?.message ?? error });
      }
      processImpl.off("SIGINT", onSigint);
      processImpl.off("SIGTERM", onSigterm);
      processImpl.off("uncaughtException", onFatal);
      processImpl.off("unhandledRejection", onFatal);
      try { await logger.flush?.({ throwOnError: true }); }
      catch { processImpl.exitCode = 1; }
      logger.close?.();
    })();
    return stopPromise;
  }

  const onSigint = () => void shutdown("received SIGINT");
  const onSigterm = () => void shutdown("received SIGTERM");
  const onFatal = (error) => {
    logger.error("live-storage service fatal error", {
      errorType: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 300),
    });
    processImpl.exitCode = 1;
    setTimeout(() => processImpl.exit(1), FATAL_EXIT_TIMEOUT_MS).unref?.();
    void shutdown("fatal_error").then(() => processImpl.exit(1));
  };
  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  processImpl.on("uncaughtException", onFatal);
  processImpl.on("unhandledRejection", onFatal);

  try {
    const { port, host, dbPath, dxfeedDbPath, heatmapDir, icebergDir } = parseServiceArgs(argv, env);
    service = createService({ port, host, dbPath, dxfeedDbPath, heatmapDir, icebergDir, env, log: (...args) => logger.warn(args.join(" ")) });
    const address = await service.start();
    const state = service.health();
    logger.banner([
      "LIVE STORAGE SERVICE - loopback warm-up/backfill reads",
      `listen   http://${host}:${address.port}/live-storage/<route>`,
      `health   http://${host}:${address.port}/health`,
      `db       ${dbPath}`,
      `dxfeed   ${dxfeedDbPath}`,
      `heatmap  ${heatmapDir}`,
      `icebergs ${icebergDir}`,
    ]);
    if (state.ready) logger.ok("listening", { port: address.port });
    else logger.warn("listening but not ready", { reasons: state.reasons.join(",") });
  } catch (error) {
    logger.error("live-storage service startup failed", { reason: error?.message ?? error });
    processImpl.exitCode = 1;
    await shutdown("startup failed");
  }
  return { service, shutdown };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("run-live-storage-service: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  main,
  createService,
  parseServiceArgs,
  configurationProblems,
  parseBindHost,
  DEFAULT_PORT,
  DEFAULT_HOST,
  FATAL_EXIT_TIMEOUT_MS,
};
