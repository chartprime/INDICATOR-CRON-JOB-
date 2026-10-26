const { main, splitArgs, buildChildEnv } = require("../../../scripts/collect/run-with-dxfeed-token");
const { REALTIME_ENDPOINT } = require("../../../src/providers/dxfeed/dxfeed-connection-config");
const { PLANNED_ROTATION_EXIT_CODE } = require("../../../src/providers/dxfeed/dxfeed-token-lifecycle");

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(times = 10) {
  for (let i = 0; i < times; i += 1) await flushAsync();
}

function noopLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ok: jest.fn(),
  };
}

function fakeChild() {
  const listeners = { exit: [], error: [] };
  return {
    kill: jest.fn(),
    on: jest.fn((event, cb) => {
      listeners[event]?.push(cb);
    }),
    emitExit: (code, signal = null) => listeners.exit.forEach((cb) => cb(code, signal)),
    emitError: (error) => listeners.error.forEach((cb) => cb(error)),
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  const responseBody = body?.token && !Object.hasOwn(body, "expiresAt")
    ? { ...body, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }
    : body;
  return new Response(JSON.stringify(responseBody), { status });
}

const originalExit = process.exit;
let sigintCountBefore;
let sigtermCountBefore;

beforeEach(() => {
  process.exit = jest.fn();
  sigintCountBefore = process.listenerCount("SIGINT");
  sigtermCountBefore = process.listenerCount("SIGTERM");
});

afterEach(() => {
  process.exit = originalExit;
  expect(process.listenerCount("SIGINT")).toBe(sigintCountBefore);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermCountBefore);
});

describe("splitArgs", () => {
  test("splits at a leading --", () => {
    expect(splitArgs(["--", "node", "scripts/verify-dxfeed-auth.js"])).toEqual({
      childCommand: ["node", "scripts/verify-dxfeed-auth.js"],
      rotateOnExit75: false,
    });
  });

  test("accepts the explicit planned-rotation flag", () => {
    expect(splitArgs(["--rotate-on-exit-75", "--", "node", "scripts/run-dxfeed-collector.js"])).toEqual({
      childCommand: ["node", "scripts/run-dxfeed-collector.js"],
      rotateOnExit75: true,
    });
  });

  test("throws when -- is missing", () => {
    expect(() => splitArgs(["node", "foo.js"])).toThrow(/usage/);
  });

  test("throws when nothing follows --", () => {
    expect(() => splitArgs(["--"])).toThrow(/no command/);
  });

  test("throws when arguments appear before --", () => {
    expect(() => splitArgs(["--foo", "--", "node", "x.js"])).toThrow(/before --/);
  });
});

test.each([false, true])("unexpected disconnect retries once at 120 seconds; stop during backoff=%s", async (stopDuringBackoff) => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  const children = [];
  const fetchImpl = jest.fn(async () => jsonResponse({ token: "fixture.token" }));
  const run = main({
    argv: ["--rotate-on-exit-75", "--", "node", "fixture.js"],
    env: { TT_DXFEED_TOKEN_BROKER_URL: "https://fixture.ts.net" },
    fetchImpl,
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
    logger: noopLogger(),
  });
  try {
    await flushMany();
    children[0].emitExit(76);
    await jest.advanceTimersByTimeAsync(119_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (stopDuringBackoff) process.emit("SIGINT");
    await jest.advanceTimersByTimeAsync(1);
    await flushMany();
    if (!stopDuringBackoff) {
      expect(children).toHaveLength(2);
      children[1].emitExit(76);
    }
    await run;
    await jest.advanceTimersByTimeAsync(240_000);
    expect(fetchImpl).toHaveBeenCalledTimes(stopDuringBackoff ? 1 : 2);
    expect(process.exit).toHaveBeenCalledWith(stopDuringBackoff ? 130 : 76);
  } finally {
    process.emit("SIGINT");
    jest.useRealTimers();
  }
});

describe("buildChildEnv", () => {
  test("layers the four dxfeed vars over the base env, fixed to realtime mode", () => {
    const env = buildChildEnv(
      { PATH: "/usr/bin", DXFEED_TEMP_TOKEN: "stale", DXFEED_TOKEN_SECRET: "legacy" },
      "fresh.token",
      "2026-01-01T00:30:00.000Z",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      DXFEED_TEMP_TOKEN: "fresh.token",
      DXFEED_TOKEN_EXPIRES_AT: "2026-01-01T00:30:00.000Z",
      DXFEED_ENDPOINT: REALTIME_ENDPOINT,
      MARKET_DATA_MODE: "realtime",
    });
  });
});

describe("main", () => {
  test("missing TT_DXFEED_TOKEN_BROKER_URL logs an error and exits 1 without calling fetchImpl", async () => {
    const fetchImpl = jest.fn();
    const spawnImpl = jest.fn();
    const logger = noopLogger();
    await main({ argv: ["--", "node", "x.js"], env: {}, fetchImpl, spawnImpl, logger });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
  });

  test("missing -- in argv logs a usage error and exits 1 without calling fetchImpl", async () => {
    const fetchImpl = jest.fn();
    const spawnImpl = jest.fn();
    const logger = noopLogger();
    await main({
      argv: ["node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
      now: () => 1_767_225_600_000,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("on success, spawns the child with exactly the four dxfeed vars injected and stdio inherited", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def", expiresAt: "2026-01-01T00:30:00.000Z" }));
    const child = fakeChild();
    let spawnedEnv;
    const spawnImpl = jest.fn((_command, _args, options) => {
      spawnedEnv = { ...options.env };
      return child;
    });
    const logger = noopLogger();
    const runPromise = main({
      argv: ["--", "node", "scripts/verify-dxfeed-auth.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net", PATH: "/usr/bin" },
      fetchImpl,
      spawnImpl,
      logger,
      now: () => 1_767_225_600_000,
    });
    await flushMany();
    child.emitExit(0);
    await runPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      ["scripts/verify-dxfeed-auth.js"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.any(Object),
      }),
    );
    expect(spawnedEnv).toMatchObject({
      PATH: "/usr/bin",
      DXFEED_TEMP_TOKEN: "abc.def",
      DXFEED_TOKEN_EXPIRES_AT: "2026-01-01T00:30:00.000Z",
      DXFEED_ENDPOINT: REALTIME_ENDPOINT,
      MARKET_DATA_MODE: "realtime",
    });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  test("mirrors a non-zero child exit code", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    child.emitExit(7);
    await runPromise;
    expect(process.exit).toHaveBeenCalledWith(7);
  });

  test("starts one fresh child only after a planned rotation exit, then propagates the replacement child's result", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first.token", expiresAt: "2026-01-01T00:30:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ token: "second.token", expiresAt: "2026-01-01T00:34:00.000Z" }));
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const spawnImpl = jest.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const logger = noopLogger();
    let currentNow = 1_767_225_600_000;
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
      now: () => currentNow,
    });
    await flushMany();
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    currentNow += 5 * 60_000;
    firstChild.emitExit(PLANNED_ROTATION_EXIT_CODE);
    await flushMany();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(process.exit).not.toHaveBeenCalled();

    secondChild.emitExit(0);
    await runPromise;
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith(
      "planned dxFeed token rotation complete; starting the next session",
      { nextSessionNumber: 2 },
    );
  });

  test("fails closed instead of repeatedly requesting tokens when a planned rotation exits immediately", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "first.token", expiresAt: "2026-01-01T00:30:00.000Z" }));
    const firstChild = fakeChild();
    const spawnImpl = jest.fn(() => firstChild);
    const logger = noopLogger();
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
      now: () => 1_767_225_600_000,
    });
    await flushMany();
    firstChild.emitExit(PLANNED_ROTATION_EXIT_CODE);
    await runPromise;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "planned dxFeed token rotation exited too soon",
      expect.objectContaining({ sessionNumber: 1, uptimeMs: 0, minimumUptimeMs: 5 * 60_000 }),
    );
  });

  test("a capacity stop is passed through without another broker token or collector", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "fixture.token" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "fixture.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    child.emitExit(78);
    await runPromise;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(78);
  });

  test("does not restart an unflagged command that exits with the reserved rotation code", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def", expiresAt: "2026-01-01T00:30:00.000Z" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
      now: () => 1_767_225_600_000,
    });
    await flushMany();
    child.emitExit(PLANNED_ROTATION_EXIT_CODE);
    await runPromise;
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(PLANNED_ROTATION_EXIT_CODE);
  });

  test("a wrapper-initiated shutdown is never reinterpreted as a rotation, even if the dying child happens to exit with the reserved code", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    process.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // The real collector never exits with the reserved rotation code once
    // it has been signaled -- its own settled-guard makes the two paths
    // mutually exclusive. This simulates a child that did anyway, to prove
    // the wrapper's own precedence guard (not the collector's good
    // behavior) is what stops a wrapper-initiated shutdown from being
    // reinterpreted as a rotation.
    child.emitExit(PLANNED_ROTATION_EXIT_CODE);
    await runPromise;
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  test("a termination signal during the replacement-token fetch prevents a late rotation child", async () => {
    let resolveSecondFetch;
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first.token", expiresAt: "2026-01-01T00:30:00.000Z" }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondFetch = resolve; }));
    const firstChild = fakeChild();
    const spawnImpl = jest.fn(() => firstChild);
    let currentNow = 1_767_225_600_000;
    const runPromise = main({
      argv: ["--rotate-on-exit-75", "--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
      now: () => currentNow,
    });
    await flushMany();
    currentNow += 5 * 60_000;
    firstChild.emitExit(PLANNED_ROTATION_EXIT_CODE);
    await flushMany();
    process.emit("SIGTERM");
    expect(process.exit).toHaveBeenCalledWith(143);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    resolveSecondFetch(jsonResponse({ token: "second.token", expiresAt: "2026-01-01T00:34:00.000Z" }));
    await runPromise;
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test("a child killed by signal (null exit code) exits 1", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    child.emitExit(null, "SIGTERM");
    await runPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("a child that fails to launch (\"error\" event, no \"exit\") logs and exits 1", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const logger = noopLogger();
    const runPromise = main({
      argv: ["--", "nonexistent-command"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
    });
    await flushMany();
    child.emitError(new Error("spawn nonexistent-command ENOENT"));
    await runPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith("failed to launch child process", expect.anything());
  });

  test("\"exit\" and \"error\" both firing on the same child settles exactly once", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    child.emitExit(0);
    child.emitError(new Error("late spurious error"));
    await runPromise;
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  test("broker rejection (unreachable) logs and exits 1 without ever calling spawnImpl", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("dxfeed-token-broker: network error reaching broker");
    });
    const spawnImpl = jest.fn();
    const logger = noopLogger();
    await main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
  });

  test("SIGINT after the child is spawned kills the child and settles once it exits", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    process.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(process.exit).not.toHaveBeenCalled();
    child.emitExit(0);
    await runPromise;
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  test("SIGTERM before the child is spawned (during the token fetch) settles without launching a late child", async () => {
    let resolveFetch;
    const fetchImpl = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const spawnImpl = jest.fn(() => fakeChild());
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    process.emit("SIGTERM");
    expect(process.exit).toHaveBeenCalledWith(143);
    expect(spawnImpl).not.toHaveBeenCalled();
    resolveFetch(jsonResponse({ token: "abc.def" }));
    await runPromise;
  });

  test("a signal is forwarded to the child at most once even if the OS re-delivers it before exit", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const runPromise = main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger: noopLogger(),
    });
    await flushMany();
    process.emit("SIGINT");
    child.emitExit(0);
    process.emit("SIGTERM");
    await runPromise;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  test("if a killed child never actually exits, the wrapper still force-exits after the grace period", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    try {
      const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
      const child = fakeChild();
      const spawnImpl = jest.fn(() => child);
      const runPromise = main({
        argv: ["--", "node", "x.js"],
        env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
        fetchImpl,
        spawnImpl,
        logger: noopLogger(),
      });
      await flushMany();
      process.emit("SIGINT");
      expect(process.exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5_000);
      await runPromise;
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGINT");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(process.exit).toHaveBeenCalledWith(130);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the fetched token never appears in any logger call, including on a forced post-fetch failure", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "totally-secret-token.value" }));
    const spawnImpl = jest.fn(() => {
      throw new Error("spawn failed, saw token totally-secret-token.value in a stray log");
    });
    const logger = noopLogger();
    await main({
      argv: ["--", "node", "x.js"],
      env: { TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.ts.net" },
      fetchImpl,
      spawnImpl,
      logger,
    });
    for (const mockFn of Object.values(logger)) {
      for (const call of mockFn.mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg)).not.toContain("totally-secret-token.value");
        }
      }
    }
  });
});
