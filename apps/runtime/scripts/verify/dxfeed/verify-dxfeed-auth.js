#!/usr/bin/env node

const { DXLinkAuthState, DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { loadDxFeedConfig } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { redactSecrets } = require("../../../src/providers/dxfeed/redact");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { AUTH_TIMEOUT_MS } = require("../../../src/providers/dxfeed/dxlink-handshake");

async function main({
  logger = createCliLogger({ name: "verify-dxfeed-auth" }),
  loadConfig = loadDxFeedConfig,
  createConnection = createDxLinkConnection,
  signalProcess = process,
  exit = process.exit,
} = {}) {
  let secrets = [];

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("invalid dxFeed config", { reason: error?.message ?? error });
    await flushAndExit(logger, exit, 1);
    return;
  }
  secrets = [config.tempToken];

  logger.banner([
    "DXFEED AUTH VERIFICATION",
    "single deliberate connect / authorize / disconnect cycle",
    `mode     ${config.marketDataMode}`,
  ]);

  let connection;
  try {
    connection = createConnection(config);
  } catch (error) {
    logger.error("failed to initialize dxFeed connection", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    secrets = [];
    await flushAndExit(logger, exit, 1);
    return;
  }
  let settled = false;
  let timeoutHandle;
  let observedErrors = 0;
  let finishPromise = null;

  function finish(exitCode) {
    if (settled) return finishPromise;
    settled = true;
    clearTimeout(timeoutHandle);
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
    let finalExitCode = exitCode;
    try {
      connection.disconnect();
    } catch (error) {
      logger.error("disconnect failed", { reason: redactSecrets(String(error?.message ?? error), secrets) });
      finalExitCode = 1;
    }
    logger.info(finalExitCode === 0 ? "disconnected, verification complete" : "disconnected after failed verification");
    secrets = [];
    finishPromise = flushAndExit(logger, exit, finalExitCode);
    return finishPromise;
  }

  try {
    connection.onError((error) => {
      if (settled) return;
      observedErrors += 1;
      logger.error("connection error", {
        type: typeof error?.type === "string" ? error.type : undefined,
        message: redactSecrets(typeof error?.message === "string" ? error.message : "dxLink error", secrets),
      });
      finish(1);
    });

    connection.onConnectionStateChange(({ state, prev }) => {
      logger.info(`connection state: ${prev} -> ${state}`);
      if (!settled && state === DXLinkConnectionState.NOT_CONNECTED && prev !== DXLinkConnectionState.NOT_CONNECTED) {
        logger.error("connection dropped before reaching AUTHORIZED, this attempt failed");
        finish(1);
      }
    });

    connection.onAuthStateChange(({ state, prev }) => {
      logger.info(`auth state: ${prev} -> ${state}`);
      if (!settled && state === DXLinkAuthState.AUTHORIZED && observedErrors === 0) {
        logger.ok("AUTHORIZED -- zero errors observed, disconnecting now (single deliberate cycle)");
        finish(0);
      }
    });
  } catch (error) {
    logger.error("failed to attach dxFeed connection listeners", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    finish(1);
    return;
  }

  timeoutHandle = setTimeout(() => {
    logger.error(`did not reach AUTHORIZED within ${AUTH_TIMEOUT_MS}ms`);
    finish(1);
  }, AUTH_TIMEOUT_MS);
  timeoutHandle.unref?.();

  function onSigint() {
    logger.warn("received SIGINT, disconnecting");
    finish(130);
  }
  function onSigterm() {
    logger.warn("received SIGTERM, disconnecting");
    finish(143);
  }
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);

  try {
    connection.connect();
  } catch (error) {
    logger.error("connection failed before authorization", {
      reason: redactSecrets(String(error?.message ?? error), secrets),
    });
    finish(1);
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("verify-dxfeed-auth: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = { main, AUTH_TIMEOUT_MS };
