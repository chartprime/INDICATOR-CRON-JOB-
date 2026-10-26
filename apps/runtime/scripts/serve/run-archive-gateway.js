#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("gateway", { isMain: require.main === module });

const http = require("node:http");
const { createArchiveRouteOrRefuse, CONTRACT_VERSION, DEFAULT_UPSTREAM_TIMEOUT_MS, REFUSAL_STATUS } = require("../../src/server/archive-route");

const READER_UNAVAILABLE = "READER_UNAVAILABLE";
const { createArchiveAuth, parseClientTokens } = require("../../src/server/archive-auth");
const { createLiveStorageRelayOrRefuse } = require("../../src/server/live-storage-relay");
const { createArchiveStudyRouteOrRefuse } = require("../../src/server/archive-study-route");
const { createHistoricalL2Route, CONTRACT_VERSION: L2_CONTRACT_VERSION, ROUTE_PATH: L2_PATH } = require("../../src/server/historical-l2-route");
const { createCliLogger } = require("../../src/platform/cli-logger");
const { createRuntimeHealthMonitor } = require("../../src/platform/runtime-health-monitor");

const DEFAULT_PORT = 8001;
const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUEST_TIMEOUT_MS = DEFAULT_UPSTREAM_TIMEOUT_MS + 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const REFUSED_AUTH = Object.freeze({ identify: () => null, clientCount: 0 });

function isTailscaleCgNatV4(host) {
  if (typeof host !== "string") return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((value, index) => !Number.isInteger(value) || String(value) !== parts[index] || value < 0 || value > 255)) {
    return false;
  }
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

function isWireGuardLabV4(host) {
  return host === "10.88.0.1";
}

function parseBindHost(rawHost) {
  if (typeof rawHost !== "string") {
    throw new Error("run-archive-gateway: host must be loopback, a Tailscale address (100.64.0.0/10), or the lab WireGuard address (10.88.0.1)");
  }
  if (LOOPBACK_BIND_HOSTS.has(rawHost)) return rawHost === "localhost" ? "127.0.0.1" : rawHost;
  if (isTailscaleCgNatV4(rawHost) || isWireGuardLabV4(rawHost)) return rawHost;
  throw new Error(`run-archive-gateway: host must be loopback, a Tailscale address (100.64.0.0/10), or the lab WireGuard address (10.88.0.1), got "${rawHost}"`);
}

function parseGatewayArgs(argv = [], env = process.env) {
  const rawPort = argv[0] ?? env.TT_ARCHIVE_GATEWAY_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  const rawHost = argv[1] ?? env.TT_ARCHIVE_GATEWAY_HOST ?? DEFAULT_HOST;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`run-archive-gateway: invalid port "${rawPort}"`);
  }
  return { port, host: parseBindHost(rawHost) };
}

function configurationProblems(env = process.env) {
  const problems = [];
  if (!env.TT_ARCHIVE_SERVICE_URL) problems.push("ARCHIVE_SERVICE_URL_NOT_CONFIGURED");
  if (!env.TT_QUERY_SERVICE_SECRET) problems.push("QUERY_SERVICE_SECRET_NOT_CONFIGURED");
  try {
    if (parseClientTokens(env.TT_ARCHIVE_CLIENT_TOKENS).length === 0) {
      problems.push("CLIENT_TOKENS_NOT_CONFIGURED");
    }
  } catch {
    problems.push("CLIENT_TOKENS_INVALID");
  }
  return problems;
}

function buildAuth(env, log) {
  try {
    return createArchiveAuth({ clientTokens: env.TT_ARCHIVE_CLIENT_TOKENS });
  } catch (error) {
    log("run-archive-gateway: client tokens are unusable, so every query will be refused",
        error?.message ?? error);
    return REFUSED_AUTH;
  }
}

function createGateway({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  env = process.env,
  log = console.error,
  archiveRoute,
  archiveStudyRoute,
  historicalL2Route,
  liveStorageRelay,
  createHealthMonitor = createRuntimeHealthMonitor,
} = {}) {
  host = parseBindHost(host);
  const auth = archiveRoute ? REFUSED_AUTH : buildAuth(env, log);
  const route = archiveRoute ?? createArchiveRouteOrRefuse({
    auth,
    serviceUrl: env.TT_ARCHIVE_SERVICE_URL,
    serviceSecret: env.TT_QUERY_SERVICE_SECRET,
  }, log);
  const study = archiveStudyRoute ?? createArchiveStudyRouteOrRefuse({
    auth,
    serviceUrl: env.TT_ARCHIVE_SERVICE_URL,
    serviceSecret: env.TT_QUERY_SERVICE_SECRET,
  }, log);
  const liveStorage = liveStorageRelay ?? createLiveStorageRelayOrRefuse({
    auth,
    internalUrl: env.TT_LIVE_STORAGE_INTERNAL_URL,
    serviceSecret: env.TT_LIVE_STORAGE_SERVICE_SECRET,
  }, log);
  const l2 = historicalL2Route ?? createHistoricalL2Route({ auth,
    serviceUrl: env.TT_L2_ARCHIVE_SERVICE_URL ?? "", serviceSecret: env.TT_QUERY_SERVICE_SECRET, log,
  });
  const runtimeHealth = createHealthMonitor();
  const problems = configurationProblems(env);
  let stopping = false;

  function health() {
    const stats = route.stats();
    const reasons = stats.disabled === true ? [...problems, "ROUTE_DISABLED"] : [...problems];
    if (stopping) reasons.push("SHUTTING_DOWN");
    if (env.TT_L2_ARCHIVE_SERVICE_URL && l2.stats().disabled === true) reasons.push("L2_ROUTE_DISABLED");
    const body = {
      contractVersion: CONTRACT_VERSION,
      ready: reasons.length === 0,
      clients: auth.clientCount,
      route: stats,
      study: study.stats(),
      l2: { configured: Boolean(env.TT_L2_ARCHIVE_SERVICE_URL), ...l2.stats() },
      liveStorage: liveStorage.stats(),
      runtime: runtimeHealth.getStats(),
    };
    if (reasons.length > 0) body.reasons = reasons;
    return body;
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
        respondJson(response, 200, health());
      } catch (error) {
        log("run-archive-gateway: health probe failed", error?.message ?? error);
        respondOrDestroy(response, 503, {
          contractVersion: CONTRACT_VERSION, ready: false, reasons: ["HEALTH_PROBE_FAILED"],
        });
      }
      return;
    }
    try {
      if (route.handle(request, response)) return;
      if (study.handle(request, response)) return;
      if (l2.handle(request, response)) return;
      if (liveStorage.handle(request, response)) return;
      response.writeHead(404, { "content-length": "0" });
      response.end();
    } catch (error) {
      log("run-archive-gateway: request handling failed", error?.message ?? error);
      respondOrDestroy(response, REFUSAL_STATUS[READER_UNAVAILABLE], {
        contractVersion: request.url === L2_PATH ? L2_CONTRACT_VERSION : CONTRACT_VERSION, error: READER_UNAVAILABLE,
        detail: "REQUEST_HANDLER_FAILED",
      });
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
    study.dispose();
    l2.dispose();
    liveStorage.dispose();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      server.close(finish);
      server.closeIdleConnections?.();
    });
  }

  return Object.freeze({ server, route, l2, liveStorage, auth, runtimeHealth, problems, health, start, stop });
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  processImpl = process,
  logger = createCliLogger({ name: "archive-gateway" }),
} = {}) {
  let gateway;
  let stopPromise = null;

  function shutdown(reason) {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      logger.info(`${reason}, shutting down`);
      try {
        await gateway?.stop();
        logger.ok("archive gateway stopped", { reason });
      } catch (error) {
        processImpl.exitCode = 1;
        logger.error("archive gateway shutdown failed", { reason: error?.message ?? error });
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
    logger.error("archive gateway fatal error", {
      errorType: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 300),
    });
    processImpl.exitCode = 1;
    void shutdown("fatal_error").then(() => processImpl.exit(1));
  };
  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  processImpl.on("uncaughtException", onFatal);
  processImpl.on("unhandledRejection", onFatal);

  try {
    const { port, host } = parseGatewayArgs(argv, env);
    gateway = createGateway({ port, host, env, log: (...args) => logger.warn(args.join(" ")) });
    const address = await gateway.start();
    const state = gateway.health();
    logger.banner([
      "ARCHIVE GATEWAY - authenticated history relay",
      `listen       http://${host}:${address.port}/archive/query`,
      `listen       http://${host}:${address.port}/live-storage/<route>`,
      `health       http://${host}:${address.port}/health`,
      `clients      ${state.clients} configured`,
      `upstream     ${env.TT_ARCHIVE_SERVICE_URL ?? "not configured"}`,
      `live-storage ${env.TT_LIVE_STORAGE_INTERNAL_URL ?? "not configured"}`,
    ]);
    if (state.ready) logger.ok("listening", { port: address.port });
    else logger.warn("listening but not ready", { reasons: state.reasons.join(",") });
  } catch (error) {
    logger.error("archive gateway startup failed", { reason: error?.message ?? error });
    processImpl.exitCode = 1;
    await shutdown("startup failed");
  }
  return { gateway, shutdown };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("run-archive-gateway: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = {
  main,
  createGateway,
  parseGatewayArgs,
  configurationProblems,
  DEFAULT_PORT,
  DEFAULT_HOST,
  REQUEST_TIMEOUT_MS,
  isTailscaleCgNatV4,
  parseBindHost,
};
