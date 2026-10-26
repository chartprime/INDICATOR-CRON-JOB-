function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(times = 10) {
  for (let i = 0; i < times; i += 1) await flushAsync();
}

function noopLogger() {
  return {
    banner: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ok: jest.fn(),
    telemetryLine: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
  };
}

function fakeConnection() {
  let onErrorCb = null;
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    quiesce: jest.fn(() => Promise.resolve()),
    removeConsumer: jest.fn(),
    subscribeMany: jest.fn(),
    onError: jest.fn((cb) => {
      onErrorCb = cb;
      return () => {
        onErrorCb = null;
      };
    }),
    getStatus: jest.fn(() => ({
      SPOT: { public: "CONNECTED" },
      PERPETUAL: { public: "CONNECTED", market: "CONNECTED" },
    })),
    getOperationalStats: jest.fn(() => ({})),
    emitError: (error) => onErrorCb?.(error),
  };
}

function fakeStorageService() {
  return {
    start: jest.fn(),
    whenReady: jest.fn(() => Promise.resolve()),
    getResumeState: jest.fn(() => ({ hasExistingData: false })),
    getStorageDb: jest.fn(() => ({})),
    getStats: jest.fn(() => ({})),
    stop: jest.fn(() => Promise.resolve()),
    recordIncident: jest.fn(),
    setCaptureOutcome: jest.fn(),
  };
}

function setup({
  storageServiceOverrides = {},
  connectionOverrides = {},
  loggerOverrides = {},
  feedMaintenanceOverrides = {},
  heartbeatOverrides = {},
  capacityGuardOverrides = {},
  runtimeHealthOverrides = {},
} = {}) {
  jest.resetModules();

  const logger = { ...noopLogger(), ...loggerOverrides };
  const connection = { ...fakeConnection(), ...connectionOverrides };
  const storageService = { ...fakeStorageService(), ...storageServiceOverrides };
  const feedMaintenance = { start: jest.fn(), stop: jest.fn(), ...feedMaintenanceOverrides };
  const heartbeat = { start: jest.fn(), stop: jest.fn(), ...heartbeatOverrides };
  const integrityMonitor = {
    recordTelemetry: jest.fn(() => ({ isIncident: false, incidents: [] })),
    recordFatalError: jest.fn(),
    getStats: jest.fn(() => ({ captureQuality: "HEALTHY", collectorStatus: "HEALTHY", recoveryAgeMs: 0 })),
  };
  const capacityGuard = {
    observe: jest.fn(() => ({ breached: false, shouldStop: false, reason: null, breachDurationMs: 0 })),
    getStats: jest.fn(() => ({})),
    ...capacityGuardOverrides,
  };
  const runtimeHealth = {
    start: jest.fn(), stop: jest.fn(), getStats: jest.fn(() => ({ eventLoopHealthy: true })),
    ...runtimeHealthOverrides,
  };

  let capturedTelemetry = null;
  let capturedConnectionOptions = null;

  jest.doMock("../../../src/providers/binance/binance-connection", () => ({
    createBinanceConnection: jest.fn((opts) => {
      capturedTelemetry = opts.telemetry;
      capturedConnectionOptions = opts;
      return connection;
    }),
  }));
  jest.doMock("../../../src/providers/binance/binance-config", () => ({
    MARKET_KINDS: { SPOT: "SPOT", PERPETUAL: "PERPETUAL" },
    listAllowedSymbols: jest.fn(() => ["BTCUSDT"]),
    listAllowedMarketKinds: jest.fn(() => ["SPOT", "PERPETUAL"]),
  }));
  jest.doMock("../../../src/storage/storage-service", () => ({
    createStorageService: jest.fn(() => storageService),
  }));
  jest.doMock("../../../src/storage/storage-db", () => ({ DEFAULT_DB_PATH: ":memory:" }));
  jest.doMock("../../../src/storage/collector-feed-maintenance", () => ({
    createCollectorFeedMaintenance: jest.fn(() => feedMaintenance),
    listCollectorSubscriptions: jest.fn(() => []),
  }));
  jest.doMock("../../../src/platform/telemetry-console-sink", () => ({ createThrottledConsoleSink: jest.fn(() => jest.fn()) }));
  jest.doMock("../../../src/platform/cli-logger", () => ({ createCliLogger: jest.fn(() => logger) }));
  jest.doMock("../../../src/platform/cli-heartbeat", () => ({ createCliHeartbeat: jest.fn(() => heartbeat) }));
  jest.doMock("../../../src/storage/collector-integrity-monitor", () => ({
    createCollectorIntegrityMonitor: jest.fn(() => integrityMonitor),
  }));
  jest.doMock("../../../src/storage/collector-capacity-guard", () => ({
    createCollectorCapacityGuard: jest.fn(() => capacityGuard),
    dbCapacityTransition: jest.requireActual("../../../src/storage/collector-capacity-guard").dbCapacityTransition,
    DEFAULT_BREACH_DURATION_MS: 30_000,
    CAPACITY_STOP_EXIT_CODE: jest.requireActual("../../../src/storage/collector-capacity-guard").CAPACITY_STOP_EXIT_CODE,
  }));
  jest.doMock("../../../src/platform/runtime-health-monitor", () => ({ createRuntimeHealthMonitor: jest.fn(() => runtimeHealth) }));
  jest.doMock("../../../src/providers/binance/binance-backpressure-queue", () => ({
    OVERFLOW_POLICIES: { DROP_OLDEST: "DROP_OLDEST", FAIL: "FAIL" },
  }));

  const mod = require("../../../scripts/collect/run-collector");

  return {
    mod,
    logger,
    connection,
    storageService,
    feedMaintenance,
    heartbeat,
    integrityMonitor,
    capacityGuard,
    runtimeHealth,
    getTelemetry: () => capturedTelemetry,
    getConnectionOptions: () => capturedConnectionOptions,
  };
}

const originalExit = process.exit;

beforeEach(() => {
  process.exit = jest.fn();
});

afterEach(() => {
  process.exit = originalExit;
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  jest.dontMock("../../../src/providers/binance/binance-connection");
  jest.dontMock("../../../src/providers/binance/binance-config");
  jest.dontMock("../../../src/storage/storage-service");
  jest.dontMock("../../../src/storage/storage-db");
  jest.dontMock("../../../src/storage/collector-feed-maintenance");
  jest.dontMock("../../../src/platform/telemetry-console-sink");
  jest.dontMock("../../../src/platform/cli-logger");
  jest.dontMock("../../../src/platform/cli-heartbeat");
  jest.dontMock("../../../src/storage/collector-integrity-monitor");
  jest.dontMock("../../../src/storage/collector-capacity-guard");
  jest.dontMock("../../../src/platform/runtime-health-monitor");
  jest.dontMock("../../../src/providers/binance/binance-backpressure-queue");
});

describe("run-collector main()", () => {
  test("starts up cleanly: connects, subscribes, starts every subsystem, and logs running", async () => {
    const {
      mod,
      connection,
      feedMaintenance,
      heartbeat,
      runtimeHealth,
      logger,
      getConnectionOptions,
    } = setup();
    await mod.main();

    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.subscribeMany).toHaveBeenCalledTimes(1);
    expect(feedMaintenance.start).toHaveBeenCalledTimes(1);
    expect(heartbeat.start).toHaveBeenCalledTimes(1);
    expect(runtimeHealth.start).toHaveBeenCalledTimes(1);
    expect(getConnectionOptions()).toMatchObject({
      backpressureOverflowPolicy: "FAIL",
      rawIngressEnabled: true,
      rawIngressMaxQueueDepth: 50_000,
      rawIngressMaxQueueBytes: 64 * 1024 * 1024,
      rawIngressDrainBatchSize: 1_000,
      rawIngressDrainMaxMs: 8,
    });
    expect(logger.ok).toHaveBeenCalledWith("running, capturing all known pairs", expect.any(Object));
  });

  test.each([
    "market_data.binance_backpressure.event_dropped",
    "market_data.binance_backpressure.queue_overflow",
    "market_data.binance_raw_ingress.queue_overflow",
    "storage.record_rejected",
  ])("a TERMINAL_INTEGRITY_EVENTS telemetry entry triggers a fatal shutdown with exit code 1 (%s)", async (event) => {
    const { mod, getTelemetry, integrityMonitor, storageService, connection } = setup();
    await mod.main();

    getTelemetry()({ event });
    await flushMany();

    expect(integrityMonitor.recordFatalError).toHaveBeenCalled();
    expect(connection.quiesce).toHaveBeenCalled();
    expect(storageService.stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("a fatal connection error triggers shutdown with exit code 1", async () => {
    const { mod, connection, integrityMonitor } = setup();
    await mod.main();

    connection.emitError({ fatal: true, marketKind: "SPOT", route: "public", code: "X", message: "boom" });
    await flushMany();

    expect(integrityMonitor.recordFatalError).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("a non-fatal connection error does not trigger shutdown", async () => {
    const { mod, connection } = setup();
    await mod.main();

    connection.emitError({ fatal: false, marketKind: "SPOT", route: "public", code: "X", message: "recoverable" });
    await flushMany();

    expect(process.exit).not.toHaveBeenCalled();
  });

  test("raw-ingress flow control is reported compactly without degrading capture integrity", async () => {
    const { mod, getTelemetry, logger, integrityMonitor } = setup();
    await mod.main();

    getTelemetry()({
      event: "market_data.binance_raw_ingress.flow_control_paused",
      marketKind: "PERPETUAL",
      route: "public",
      queueDepth: 20_000,
      queueBytes: 11_000_000,
    });
    getTelemetry()({
      event: "market_data.binance_raw_ingress.flow_control_resumed",
      marketKind: "PERPETUAL",
      route: "public",
      durationMs: 840,
      queueDepth: 5_000,
      queueBytes: 2_000_000,
      reason: "LOW_WATERMARK",
    });

    expect(logger.warn).toHaveBeenCalledWith("market-data burst buffering", expect.objectContaining({
      marketKind: "PERPETUAL",
      route: "public",
      queueDepth: 20_000,
    }));
    expect(logger.ok).toHaveBeenCalledWith("market-data burst recovered", expect.objectContaining({
      durationMs: 840,
      queueDepth: 5_000,
    }));
    expect(integrityMonitor.recordFatalError).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  test.each(["heartbeat", "feedMaintenance", "runtimeHealth", "connection"])("%s cleanup failure does not skip durable storage shutdown", async (owner) => {
    const failure = () => { throw new Error("fixture cleanup failure"); };
    const options = owner === "connection" ? { connectionOverrides: { disconnect: failure } } : { [owner + "Overrides"]: { stop: failure } };
    const { mod, storageService } = setup(options);
    await mod.main();
    process.emit("SIGINT");
    await flushMany();
    expect(storageService.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("SIGINT triggers a graceful shutdown: quiesce, then remove/disconnect, then stop every subsystem, then exit 0", async () => {
    const order = [];
    const { mod, logger, storageService } = setup({
      connectionOverrides: {
        quiesce: jest.fn(() => {
          order.push("quiesce");
          return Promise.resolve();
        }),
        disconnect: jest.fn(() => order.push("disconnect")),
      },
      storageServiceOverrides: {
        stop: jest.fn(() => {
          order.push("storageService.stop");
          return Promise.resolve();
        }),
      },
    });
    await mod.main();

    process.emit("SIGINT");
    await flushMany();

    expect(order).toEqual(["quiesce", "disconnect", "storageService.stop"]);
    expect(storageService.setCaptureOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ cleanShutdown: true }),
    );
    expect(logger.info).toHaveBeenCalledWith("collector shutdown complete", {
      exitCode: 0,
      captureQuality: "HEALTHY",
      reason: "received SIGINT",
    });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  test("SIGINT during storage readiness cancels startup and never opens market-data routes afterward", async () => {
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const { mod, connection, storageService } = setup({
      storageServiceOverrides: { whenReady: jest.fn(() => ready) },
    });

    const running = mod.main();
    await flushMany(2);
    process.emit("SIGINT");
    await flushMany(2);
    resolveReady();
    await running;

    expect(storageService.stop).toHaveBeenCalledTimes(1);
    expect(connection.connect).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  test("multiple signals share one shutdown and cannot duplicate resource teardown", async () => {
    let resolveQuiesce;
    const quiesce = new Promise((resolve) => { resolveQuiesce = resolve; });
    const { mod, connection, storageService } = setup({
      connectionOverrides: { quiesce: jest.fn(() => quiesce) },
    });
    await mod.main();

    process.emit("SIGINT");
    process.emit("SIGTERM");
    resolveQuiesce();
    await flushMany();

    expect(connection.quiesce).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  test("a fatal failure arriving during graceful shutdown escalates the shared terminal exit code", async () => {
    let resolveQuiesce;
    const quiesce = new Promise((resolve) => { resolveQuiesce = resolve; });
    const { mod, connection, storageService } = setup({
      connectionOverrides: { quiesce: jest.fn(() => quiesce) },
    });
    await mod.main();

    process.emit("SIGINT");
    connection.emitError({ fatal: true, marketKind: "SPOT", route: "public", code: "FATAL", message: "loss" });
    resolveQuiesce();
    await flushMany();

    expect(storageService.setCaptureOutcome).toHaveBeenCalledWith(expect.objectContaining({ cleanShutdown: false }));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("operator-log persistence failure makes an otherwise clean shutdown exit nonzero", async () => {
    const { mod } = setup({
      loggerOverrides: { flush: jest.fn(() => Promise.reject(new Error("disk full"))) },
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mod.main();
      process.emit("SIGINT");
      await flushMany();
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(consoleError).toHaveBeenCalledWith("collector operator log persistence failed", expect.any(String));
    } finally {
      consoleError.mockRestore();
    }
  });

  test.each([
    ["storage start", { storageServiceOverrides: { start: jest.fn(() => { throw new Error("start failed"); }) } }],
    ["storage readiness", { storageServiceOverrides: { whenReady: jest.fn(() => Promise.reject(new Error("ready failed"))) } }],
    ["connection start", { connectionOverrides: { connect: jest.fn(() => { throw new Error("connect failed"); }) } }],
    ["feed maintenance start", { feedMaintenanceOverrides: { start: jest.fn(() => { throw new Error("maintenance failed"); }) } }],
    ["heartbeat start", { heartbeatOverrides: { start: jest.fn(() => { throw new Error("heartbeat failed"); }) } }],
  ])("a %s failure converges on one nonzero coordinated shutdown", async (_stage, options) => {
    const { mod, storageService, connection } = setup(options);
    await mod.main();
    await flushMany();

    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storageService.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("a capacity stop exits 78 so systemd does not restart into the same full database", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { mod, integrityMonitor, logger } = setup({
      capacityGuardOverrides: {
        observe: jest.fn(() => ({ breached: true, shouldStop: true, reason: "live database exceeded maximum size", breachDurationMs: 30_000, noProgressDurationMs: 30_000 })),
      },
    });
    await mod.main();

    jest.advanceTimersByTime(1_000);
    await flushMany();
    expect(integrityMonitor.recordFatalError).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("collector capacity safeguard triggered", expect.objectContaining({ reason: "live database exceeded maximum size" }));
    expect(process.exit).toHaveBeenCalledWith(78);
    jest.useRealTimers();
  });

  test("a fatal failure during a capacity shutdown takes precedence over exit 78", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    let resolveQuiesce;
    const quiesce = new Promise((resolve) => { resolveQuiesce = resolve; });
    const { mod, connection } = setup({
      connectionOverrides: { quiesce: jest.fn(() => quiesce) },
      capacityGuardOverrides: {
        observe: jest.fn(() => ({ breached: true, shouldStop: true, reason: "live database exceeded maximum size", breachDurationMs: 30_000, noProgressDurationMs: 30_000 })),
      },
    });
    await mod.main();
    jest.advanceTimersByTime(1_000);
    connection.emitError({ fatal: true, marketKind: "SPOT", route: "public", code: "FATAL", message: "loss" });
    resolveQuiesce();
    await flushMany();
    expect(process.exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });

  test("an unexpected watchdog probe exception is captured durably and shuts down instead of escaping the timer", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { mod, integrityMonitor, logger } = setup({
      capacityGuardOverrides: { observe: jest.fn(() => { throw new Error("probe contract failed"); }) },
    });
    await mod.main();

    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();
    await flushMany();
    expect(integrityMonitor.recordFatalError).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("collector capacity watchdog failed", { reason: "probe contract failed" });
    expect(process.exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });

  test("W6.06 Phase 4: the watchdog writes a real cooperative-throttle health file every tick", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const savedRuntimeDir = process.env.TT_RUNTIME_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collector-health-"));
    process.env.TT_RUNTIME_DIR = tmpDir;
    try {
      jest.useFakeTimers({ doNotFake: ["setImmediate"] });
      const { mod } = setup({
        storageServiceOverrides: { getStats: jest.fn(() => ({ pendingWriteItems: 42, storageOldestPendingAgeMs: 15.4 })) },
      });
      await mod.main();

      jest.advanceTimersByTime(1_000);
      await flushMany();

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "collector-health.json"), "utf-8"));
      expect(written).toMatchObject({ pendingWriteItems: 42, writeLagMs: 15, sessionQuality: "HEALTHY" });
      expect(typeof written.updatedAt).toBe("string");
      jest.useRealTimers();
    } finally {
      if (savedRuntimeDir === undefined) delete process.env.TT_RUNTIME_DIR;
      else process.env.TT_RUNTIME_DIR = savedRuntimeDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("regression: a hung durable-storage stop cannot block shutdown forever", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { mod } = setup({
      storageServiceOverrides: { stop: jest.fn(() => new Promise(() => {})) },
    });

    await mod.main();
    process.emit("SIGINT");

    await flushMany();
    jest.advanceTimersByTime(60_000);
    await flushMany();

    expect(process.exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });
});

describe("run-collector: awaitWithin", () => {
  test("resolves normally when the promise settles before the timeout", async () => {
    const { mod } = setup();
    await expect(mod.awaitWithin(Promise.resolve("ok"), 50, "test")).resolves.toBe("ok");
  });

  test("rejects with a labeled error once the timeout elapses before the promise settles", async () => {
    jest.useFakeTimers();
    const { mod } = setup();
    const hung = new Promise(() => {});
    const result = mod.awaitWithin(hung, 1_000, "hung subsystem");
    const assertion = expect(result).rejects.toThrow(/hung subsystem did not complete within 1000ms/);
    jest.advanceTimersByTime(1_000);
    await assertion;
    jest.useRealTimers();
  });
});

describe("run-collector: route readiness", () => {
  test("can be cancelled without waiting for the full connection timeout", async () => {
    jest.useFakeTimers();
    const { mod } = setup();
    let cancelled = false;
    const connection = { getStatus: () => ({}) };
    const result = mod.waitForAllRoutesConnected(connection, {
      timeoutMs: 30_000,
      pollMs: 100,
      isCancelled: () => cancelled,
    });
    cancelled = true;
    jest.advanceTimersByTime(100);
    await expect(result).rejects.toMatchObject({ code: "COLLECTOR_STARTUP_CANCELLED" });
    jest.useRealTimers();
  });

  test("validates timing and cancellation controls", async () => {
    const { mod } = setup();
    const connection = { getStatus: () => ({}) };
    await expect(mod.waitForAllRoutesConnected(connection, { timeoutMs: 0 })).rejects.toThrow(/timeout/);
    await expect(mod.waitForAllRoutesConnected(connection, { pollMs: 0 })).rejects.toThrow(/poll interval/);
    await expect(mod.waitForAllRoutesConnected(connection, { isCancelled: null })).rejects.toThrow(/isCancelled/);
  });
});

describe("run-collector: heartbeat display", () => {
  test("keeps an otherwise healthy collector healthy when only historical session gaps remain", () => {
    const { mod } = setup();

    expect(mod.displayCollectorHeartbeat({
      collectorStatus: "HEALTHY",
      captureQuality: "DEGRADED",
      recordedGaps: 4,
      trades: 18_373,
      candles: 8,
      depthEvents: 1_190,
      depthSnapshots: 4,
      pendingWriteItems: 1,
      pendingIngressEnvelopes: 0,
      storageIngressOldestAgeMs: 0,
      storageOldestPendingAgeMs: 15.4,
      backpressurePending: 0,
    })).toEqual({
      status: "HEALTHY",
      session: "DEGRADED (4 historical gaps)",
      trades: 18_373,
      candles: 8,
      depthEvents: 1_190,
      depthSnapshots: 4,
    });
  });

  test("adds queue gauges when the current collector state needs operator attention", () => {
    const { mod } = setup();

    expect(mod.displayCollectorHeartbeat({
      collectorStatus: "HEALTHY",
      captureQuality: "HEALTHY",
      recordedGaps: 0,
      trades: 1,
      candles: 2,
      depthEvents: 3,
      depthSnapshots: 4,
      pendingWriteItems: 200,
      pendingIngressEnvelopes: 150,
      storageIngressOldestAgeMs: 400,
      storageOldestPendingAgeMs: 1_500,
      backpressurePending: 20,
    })).toEqual(expect.objectContaining({
      status: "HEALTHY",
      session: "CLEAN",
      pendingWriteItems: 200,
      pendingIngressEnvelopes: 150,
      ingressAgeMs: 400,
      writeLagMs: 1_500,
      backpressurePending: 20,
    }));
  });

  test("labels operational degradation separately from known historical gaps", () => {
    const { mod } = setup();
    expect(mod.displayCollectorHeartbeat({
      collectorStatus: "HEALTHY",
      captureQuality: "DEGRADED",
      recordedGaps: 0,
      operationalDegradations: 1,
    }).session).toBe("DEGRADED (0 historical gaps, 1 operational issue)");
  });

  test.each([
    [{ collectorStatus: "HEALTHY", diskProbeHealthy: false }, "DEGRADED"],
    [{ collectorStatus: "HEALTHY", operatorLogPersistenceHealthy: false }, "DEGRADED"],
    [{ collectorStatus: "HEALTHY", operatorLogOutputHealthy: false }, "DEGRADED"],
    [{ collectorStatus: "HEALTHY", telemetryLogFailures: 1 }, "DEGRADED"],
    [{ collectorStatus: "HEALTHY", capacityBreached: true }, "PRESSURED"],
  ])("does not display HEALTHY while an operational control-plane fault is active (%j)", (stats, expected) => {
    const { mod } = setup();
    expect(mod.displayCollectorStatus(stats)).toBe(expected);
  });
});
