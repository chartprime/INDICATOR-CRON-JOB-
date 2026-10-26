#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { requestDevelopmentToken } = require("../../src/providers/dxfeed/token-broker-client");
const { REALTIME_ENDPOINT } = require("../../src/providers/dxfeed/dxfeed-connection-config");
const { redactSecrets } = require("../../src/providers/dxfeed/redact");
const { createCliLogger, flushAndExit } = require("../../src/platform/cli-logger");
const { PLANNED_ROTATION_EXIT_CODE, UNEXPECTED_DISCONNECT_EXIT_CODE } = require("../../src/providers/dxfeed/dxfeed-token-lifecycle");

const FORCE_EXIT_GRACE_MS = 5_000;
const MIN_PLANNED_ROTATION_UPTIME_MS = 5 * 60_000;

function splitArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const rotateOnExit75 = argv[0] === "--rotate-on-exit-75";
  const expectedSeparatorIndex = rotateOnExit75 ? 1 : 0;
  if (separatorIndex === -1) {
    throw new Error('run-with-dxfeed-token: usage: run-with-dxfeed-token.js -- <command> [args...]');
  }
  if (separatorIndex !== expectedSeparatorIndex) {
    throw new Error("run-with-dxfeed-token: only --rotate-on-exit-75 is accepted before --");
  }
  const childCommand = argv.slice(separatorIndex + 1);
  if (childCommand.length === 0) {
    throw new Error("run-with-dxfeed-token: no command given after --");
  }
  return { childCommand, rotateOnExit75 };
}

function buildChildEnv(baseEnv, token, expiresAt) {
  const childEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (!name.startsWith("DXFEED_")) childEnv[name] = value;
  }
  return {
    ...childEnv,
    DXFEED_TEMP_TOKEN: token,
    DXFEED_TOKEN_EXPIRES_AT: expiresAt,
    DXFEED_ENDPOINT: REALTIME_ENDPOINT,
    MARKET_DATA_MODE: "realtime",
  };
}

function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  now = () => Date.now(),
  minPlannedRotationUptimeMs = MIN_PLANNED_ROTATION_UPTIME_MS,
  unexpectedRetryDelayMs = 120_000,
  logger = createCliLogger({ name: "run-with-dxfeed-token" }),
} = {}) {
  if (!Number.isSafeInteger(minPlannedRotationUptimeMs) || minPlannedRotationUptimeMs < 0) {
    throw new Error("run-with-dxfeed-token: minPlannedRotationUptimeMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(unexpectedRetryDelayMs) || unexpectedRetryDelayMs <= 0) throw new Error("invalid unexpectedRetryDelayMs");
  let childCommand;
  let rotateOnExit75;
  try {
    ({ childCommand, rotateOnExit75 } = splitArgs(argv));
  } catch (error) {
    logger.error(error.message);
    await flushAndExit(logger, process.exit, 1);
    return;
  }

  const brokerUrl = env.TT_DXFEED_TOKEN_BROKER_URL;
  if (typeof brokerUrl !== "string" || brokerUrl.trim().length === 0) {
    logger.error("missing TT_DXFEED_TOKEN_BROKER_URL");
    await flushAndExit(logger, process.exit, 1);
    return;
  }

  let child;
  let settled = false;
  let forceExitTimer = null;
  let redactionSecrets = [];
  let shutdownExitCode = null;
  let settlePromise = null;
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  let sessionNumber = 0;
  let unexpectedRetryUsed = false;
  let retryTimer = null;
  let tokenAbortController = null;

  function requestShutdown(signal) {
    if (settled || shutdownExitCode !== null) return;
    const exitCode = exitCodeForSignal(signal);
    shutdownExitCode = exitCode;
    if (child && typeof child.kill === "function") {
      try {
        child.kill(signal);
      } catch (error) {
        logger.error("failed to signal child process", { reason: redactSecrets(String(error?.message ?? error), redactionSecrets) });
      }
      forceExitTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch (error) {
          logger.error("failed to force-stop child process", { reason: redactSecrets(String(error?.message ?? error), redactionSecrets) });
        }
        settle(exitCode);
      }, FORCE_EXIT_GRACE_MS);
    } else {
      settle(exitCode);
    }
  }

  function settle(exitCode) {
    if (settled) return settlePromise;
    settled = true;
    tokenAbortController?.abort();
    if (forceExitTimer) clearTimeout(forceExitTimer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    redactionSecrets = [];
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    let resolveSettle;
    let rejectSettle;
    settlePromise = new Promise((resolve, reject) => {
      resolveSettle = resolve;
      rejectSettle = reject;
    }).finally(resolveCompletion);
    Promise.resolve(flushAndExit(logger, process.exit, exitCode)).then(resolveSettle, rejectSettle);
    return settlePromise;
  }

  function onSigint() {
    logger.warn("received SIGINT, stopping child process");
    requestShutdown("SIGINT");
  }

  function onSigterm() {
    logger.warn("received SIGTERM, stopping child process");
    requestShutdown("SIGTERM");
  }

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  async function startSession() {
    if (settled) return;
    let token;
    let expiresAt;
    try {
      tokenAbortController = new AbortController();
      ({ token, expiresAt } = await requestDevelopmentToken({ brokerUrl, fetchImpl, now, signal: tokenAbortController.signal }));
    } catch (error) {
      if (!settled) {
        logger.error("failed to obtain dxFeed token", { reason: error?.message ?? error });
        await settle(1);
      }
      return;
    }
    if (settled) return;
    redactionSecrets = [token];
    sessionNumber += 1;
    logger.ok("obtained a dxFeed token from the broker", { tokenLength: token.length, expiresAt, sessionNumber });

    const childEnv = buildChildEnv(env, token, expiresAt);
    let launchedChild;
    let sessionStartedAtMs;
    try {
      sessionStartedAtMs = now();
      if (!Number.isSafeInteger(sessionStartedAtMs) || sessionStartedAtMs < 0) {
        throw new Error("clock returned an invalid timestamp");
      }
      launchedChild = spawnImpl(childCommand[0], childCommand.slice(1), { stdio: "inherit", env: childEnv });
      child = launchedChild;
    } catch (error) {
      logger.error("failed to launch child process", { reason: redactSecrets(String(error?.message ?? error), redactionSecrets) });
      await settle(1);
      return;
    } finally {
      delete childEnv.DXFEED_TEMP_TOKEN;
      delete childEnv.DXFEED_TOKEN_EXPIRES_AT;
      delete childEnv.DXFEED_ENDPOINT;
      delete childEnv.MARKET_DATA_MODE;
      token = undefined;
    }

    if (!launchedChild || typeof launchedChild.on !== "function") {
      logger.error("failed to launch child process", { reason: "child process handle was invalid" });
      await settle(1);
      return;
    }

    launchedChild.on("exit", (code, signal) => {
      if (settled || child !== launchedChild) return;
      child = null;
      redactionSecrets = [];
      if (shutdownExitCode === null && rotateOnExit75 && code === UNEXPECTED_DISCONNECT_EXIT_CODE && !unexpectedRetryUsed) {
        unexpectedRetryUsed = true;
        logger.warn("unexpected dxFeed disconnect; one retry scheduled", { delayMs: unexpectedRetryDelayMs });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!settled && shutdownExitCode === null) void startSession();
        }, unexpectedRetryDelayMs);
        return;
      }
      if (shutdownExitCode === null && rotateOnExit75 && code === PLANNED_ROTATION_EXIT_CODE) {
        const endedAtMs = now();
        const uptimeMs = Number.isSafeInteger(endedAtMs) ? endedAtMs - sessionStartedAtMs : null;
        if (!Number.isSafeInteger(uptimeMs) || uptimeMs < minPlannedRotationUptimeMs) {
          logger.error("planned dxFeed token rotation exited too soon", {
            sessionNumber,
            uptimeMs,
            minimumUptimeMs: minPlannedRotationUptimeMs,
          });
          void settle(1);
          return;
        }
        logger.info("planned dxFeed token rotation complete; starting the next session", { nextSessionNumber: sessionNumber + 1 });
        void startSession();
        return;
      }
      void settle(shutdownExitCode ?? (typeof code === "number" ? code : 1));
      void signal;
    });

    launchedChild.on("error", (error) => {
      if (settled || child !== launchedChild) return;
      logger.error("failed to launch child process", { reason: redactSecrets(String(error?.message ?? error), redactionSecrets) });
      void settle(1);
    });
  }

  void startSession();
  return completionPromise;
}

if (require.main === module) {
  main().catch((error) => {
    void error;
    console.error("run-with-dxfeed-token: unexpected fatal error");
    process.exit(1);
  });
}

module.exports = { main, splitArgs, buildChildEnv, exitCodeForSignal, MIN_PLANNED_ROTATION_UPTIME_MS };
