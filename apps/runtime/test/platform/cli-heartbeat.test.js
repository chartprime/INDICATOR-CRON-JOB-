const { createCliHeartbeat, formatUptime, DEFAULT_INTERVAL_MS } = require("../../src/platform/cli-heartbeat");

function fakeLogger() {
  return { heartbeat: jest.fn() };
}

describe("formatUptime", () => {
  test.each([
    [0, "0s"],
    [45_000, "45s"],
    [125_000, "2m5s"],
    [3_725_000, "1h2m5s"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatUptime(ms)).toBe(expected);
  });
});

describe("createCliHeartbeat", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("rejects a logger without heartbeat(), a non-function collect, or a non-positive intervalMs", () => {
    const logger = fakeLogger();
    expect(() => createCliHeartbeat({ logger: {}, collect: () => ({}) })).toThrow(/heartbeat/);
    expect(() => createCliHeartbeat({ logger, collect: null })).toThrow(/collect/);
    expect(() => createCliHeartbeat({ logger, collect: () => ({}), intervalMs: 0 })).toThrow(/intervalMs/);
  });

  test("does not tick before the first interval elapses", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades: 1 }), intervalMs: 60_000 });

    heartbeat.start();
    jest.advanceTimersByTime(59_999);

    expect(logger.heartbeat).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  test("a tick with growing counters reports nominal: true", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    let trades = 0;
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades }), intervalMs: 60_000 });

    heartbeat.start();
    trades = 10;
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat).toHaveBeenCalledTimes(1);
    const [, counters, nominal] = logger.heartbeat.mock.calls[0];
    expect(counters).toEqual({ trades: 10, heartbeatIntervalLagMs: 0 });
    expect(nominal).toBe(true);
    heartbeat.stop();
  });

  test("the first and later ticks with an unchanged counter set report nominal: false", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades: 5, candles: 2 }), intervalMs: 60_000 });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat).toHaveBeenCalledTimes(2);
    expect(logger.heartbeat.mock.calls[0][2]).toBe(false);
    expect(logger.heartbeat.mock.calls[1][2]).toBe(false);
    heartbeat.stop();
  });

  test("the default nominal heuristic ignores heartbeatIntervalLagMs -- timing jitter alone must not report nominal: true", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades: 5 }), intervalMs: 60_000 });
    const dateNowSpy = jest.spyOn(Date, "now");
    const start = 1_000_000;
    // start(): startedAt + previousCounters' lastTickAt both read Date.now() once.
    dateNowSpy.mockReturnValueOnce(start);
    heartbeat.start();
    // tick(): the process is merely under load -- the timer still fires on
    // schedule, but Date.now() itself reports 500ms later than expected,
    // injecting nonzero heartbeatIntervalLagMs while the real counter
    // (trades) never moves.
    dateNowSpy.mockReturnValueOnce(start + 60_000 + 500).mockReturnValueOnce(start + 60_000 + 500);
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat).toHaveBeenCalledTimes(1);
    const [, counters, nominal] = logger.heartbeat.mock.calls[0];
    expect(counters.heartbeatIntervalLagMs).toBeGreaterThan(0);
    expect(nominal).toBe(false);
    heartbeat.stop();
    dateNowSpy.mockRestore();
  });

  test("reports cumulative totals across multiple ticks, not per-tick deltas", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    let trades = 100;
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades }), intervalMs: 60_000 });

    heartbeat.start();
    trades = 140;
    jest.advanceTimersByTime(60_000);
    trades = 210;
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][1]).toEqual({ trades: 140, heartbeatIntervalLagMs: 0 });
    expect(logger.heartbeat.mock.calls[1][1]).toEqual({ trades: 210, heartbeatIntervalLagMs: 0 });
    heartbeat.stop();
  });

  test("activityKeys prevent unrelated disk metrics from masking a silent market-data feed", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    let freeDiskBytes = 1000;
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ trades: 0, freeDiskBytes }),
      activityKeys: ["trades"],
      intervalMs: 60_000,
    });

    heartbeat.start();
    freeDiskBytes = 900;
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][2]).toBe(false);
    heartbeat.stop();
  });

  test("an explicit nominal predicate supports healthy services whose gauges are expected to remain unchanged", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ clients: 0 }),
      isNominal: () => true,
      intervalMs: 60_000,
    });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][2]).toBe(true);
    heartbeat.stop();
  });

  test("passes an explicit degraded reason to the logger", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ captureQuality: "INVALID" }),
      isNominal: () => false,
      degradedReason: (current) => `capture quality ${current.captureQuality}`,
      intervalMs: 60_000,
    });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][3]).toBe("capture quality INVALID");
    heartbeat.stop();
  });

  test("can reduce a detailed operational snapshot to display counters without changing health evaluation", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ trades: 2, internalDetail: "not-for-operators" }),
      displayCounters: (counters) => ({ trades: counters.trades }),
      intervalMs: 60_000,
    });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][1]).toEqual({ trades: 2 });
    heartbeat.stop();
  });

  test("a transient collection failure is reported without escaping the timer callback", () => {
    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    let fail = false;
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => {
        if (fail) throw new Error("disk probe failed");
        return { trades: 0 };
      },
      intervalMs: 60_000,
    });

    heartbeat.start();
    fail = true;
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith("heartbeat collection failed", { reason: "disk probe failed" });
    heartbeat.stop();
  });

  test("a failed collection interval is not misreported as scheduler lag on the next successful tick", () => {
    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    let calls = 0;
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => {
        calls += 1;
        if (calls === 2) throw new Error("probe failed");
        return { trades: calls };
      },
      intervalMs: 60_000,
    });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.heartbeat).toHaveBeenCalledTimes(1);
    expect(logger.heartbeat.mock.calls[0][1].heartbeatIntervalLagMs).toBe(0);
    heartbeat.stop();
  });

  test("rejects asynchronous and non-object snapshots without leaking them into health logic", () => {
    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    const heartbeat = createCliHeartbeat({ logger, collect: () => Promise.resolve({ trades: 1 }) });
    heartbeat.start();
    jest.advanceTimersByTime(DEFAULT_INTERVAL_MS);

    expect(logger.heartbeat).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  test("rejects asynchronous health and display predicates instead of treating promises as healthy objects", () => {
    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    const healthHeartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ trades: 1 }),
      isNominal: async () => true,
    });
    healthHeartbeat.start();
    jest.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(logger.heartbeat).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("heartbeat collection failed", expect.objectContaining({ reason: expect.stringMatching(/synchronous boolean/) }));
    healthHeartbeat.stop();

    logger.warn.mockClear();
    const displayHeartbeat = createCliHeartbeat({
      logger,
      collect: () => ({ trades: 1 }),
      displayCounters: async (value) => value,
    });
    displayHeartbeat.start();
    jest.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(logger.heartbeat).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("heartbeat collection failed", expect.objectContaining({ reason: expect.stringMatching(/synchronous object/) }));
    displayHeartbeat.stop();
  });

  test("a startup collection failure is reported and does not prevent later heartbeats", () => {
    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    let fail = true;
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => {
        if (fail) throw new Error("initial disk probe failed");
        return { trades: 1 };
      },
      intervalMs: 60_000,
    });

    expect(() => heartbeat.start()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith("heartbeat initialization failed", { reason: "initial disk probe failed" });
    fail = false;
    jest.advanceTimersByTime(60_000);
    expect(logger.heartbeat).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  test("stop() prevents further ticks", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades: 1 }), intervalMs: 60_000 });

    heartbeat.start();
    heartbeat.stop();
    jest.advanceTimersByTime(120_000);

    expect(logger.heartbeat).not.toHaveBeenCalled();
  });

  test("reports uptime measured from start(), formatted via formatUptime", () => {
    jest.useFakeTimers();
    const logger = fakeLogger();
    const heartbeat = createCliHeartbeat({ logger, collect: () => ({ trades: 1 }), intervalMs: 60_000 });

    heartbeat.start();
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);

    expect(logger.heartbeat.mock.calls[0][0]).toBe(formatUptime(60_000));
    expect(logger.heartbeat.mock.calls[1][0]).toBe(formatUptime(120_000));
    heartbeat.stop();
  });

  test("the default interval is a named constant, not a magic number", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
  });

  test("rejects a non-function degradedReason", () => {
    expect(() => createCliHeartbeat({
      logger: fakeLogger(),
      collect: () => ({}),
      degradedReason: "bad",
    })).toThrow(/degradedReason/);
  });

  test("rejects an invalid displayCounters function or result", () => {
    expect(() => createCliHeartbeat({
      logger: fakeLogger(),
      collect: () => ({}),
      displayCounters: "bad",
    })).toThrow(/displayCounters/);

    jest.useFakeTimers();
    const logger = { ...fakeLogger(), warn: jest.fn() };
    const heartbeat = createCliHeartbeat({
      logger,
      collect: () => ({}),
      displayCounters: () => null,
    });
    heartbeat.start();
    jest.advanceTimersByTime(60_000);
    expect(logger.warn).toHaveBeenCalledWith("heartbeat collection failed", expect.objectContaining({ reason: expect.any(String) }));
    heartbeat.stop();
  });
});
