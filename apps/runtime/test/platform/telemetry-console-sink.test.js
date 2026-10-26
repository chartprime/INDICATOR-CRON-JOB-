const { createThrottledConsoleSink } = require("../../src/platform/telemetry-console-sink");

describe("createThrottledConsoleSink", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("logs the first occurrence of an event name immediately", () => {
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ log });

    sink({ event: "market_data.binance_connection.inactive_subscription_frame_ignored" });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][1]).toContain("inactive_subscription_frame_ignored");
  });

  test("a burst of the same event name within the window logs only the first occurrence, not one line per event", () => {
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    for (let i = 0; i < 15; i += 1) {
      sink({ event: "market_data.binance_connection.inactive_subscription_frame_ignored" });
    }

    expect(log).toHaveBeenCalledTimes(1);
  });

  test("after the window elapses, a summary line reports how many duplicates were suppressed", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    for (let i = 0; i < 15; i += 1) {
      sink({ event: "market_data.binance_connection.inactive_subscription_frame_ignored" });
    }
    expect(log).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(2);
    const summary = JSON.parse(log.mock.calls[1][1]);
    expect(summary.event).toBe("market_data.binance_connection.inactive_subscription_frame_ignored");
    expect(summary.suppressedDuplicates).toBe(14);
  });

  test("no summary line is logged if nothing was actually suppressed (only the first occurrence happened)", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    sink({ event: "market_data.binance_connection.route_connected" });
    expect(log).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a new occurrence after the window closed logs immediately again -- the throttle doesn't stay latched forever", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    sink({ event: "market_data.binance_connection.route_disconnected" });
    jest.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledTimes(1);

    sink({ event: "market_data.binance_connection.route_disconnected" });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("different event names are throttled independently -- a burst of one never suppresses the other", () => {
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    for (let i = 0; i < 5; i += 1) {
      sink({ event: "market_data.binance_connection.message_rejected" });
    }
    sink({ event: "market_data.binance_connection.route_disconnected" });

    expect(log).toHaveBeenCalledTimes(2);
  });

  test("the same event name with different context fields is throttled independently, not collapsed into one line", () => {
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    sink({ event: "market_data.binance_connection.route_disconnected", marketKind: "SPOT", route: "public" });
    sink({ event: "market_data.binance_connection.route_disconnected", marketKind: "PERPETUAL", route: "market" });
    sink({ event: "market_data.binance_connection.route_disconnected", marketKind: "PERPETUAL", route: "public" });

    expect(log).toHaveBeenCalledTimes(3);
    const marketKinds = log.mock.calls.map((call) => JSON.parse(call[1]).marketKind);
    expect(marketKinds).toEqual(["SPOT", "PERPETUAL", "PERPETUAL"]);
  });

  test("uses an explicit operational grouping key when one is supplied", () => {
    const log = jest.fn();
    const sink = createThrottledConsoleSink({
      windowMs: 60_000,
      log,
      keyForEntry: (entry) => entry.event === "storage.trade_id_provider_discontinuity"
        ? `${entry.event}:${entry.marketKind}:${entry.symbol}`
        : null,
    });

    sink({ event: "storage.trade_id_provider_discontinuity", marketKind: "PERPETUAL", symbol: "BTCUSDT", previousTradeId: 1 });
    sink({ event: "storage.trade_id_provider_discontinuity", marketKind: "PERPETUAL", symbol: "BTCUSDT", previousTradeId: 2 });

    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a suppressed-duplicates summary line retains the original event's context fields, not just the event name", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });

    for (let i = 0; i < 3; i += 1) {
      sink({ event: "market_data.binance_connection.route_disconnected", marketKind: "PERPETUAL", route: "market" });
    }
    jest.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(2);
    const summary = JSON.parse(log.mock.calls[1][1]);
    expect(summary.marketKind).toBe("PERPETUAL");
    expect(summary.route).toBe("market");
    expect(summary.suppressedDuplicates).toBe(2);
  });

  test("the default sink is console.log when none is injected", () => {
    const originalLog = console.log;
    const spy = jest.fn();
    console.log = spy;
    try {
      const sink = createThrottledConsoleSink();
      sink({ event: "market_data.binance_connection.route_connected" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      console.log = originalLog;
    }
  });

  test("rejects invalid throttling controls before creating timers", () => {
    expect(() => createThrottledConsoleSink({ windowMs: 0 })).toThrow(/windowMs/);
    expect(() => createThrottledConsoleSink({ windowMs: 1.5 })).toThrow(/windowMs/);
    expect(() => createThrottledConsoleSink({ log: null })).toThrow(/log/);
    expect(() => createThrottledConsoleSink({ maxOpenWindows: 0 })).toThrow(/maxOpenWindows/);
    expect(() => createThrottledConsoleSink({ keyForEntry: "no" })).toThrow(/keyForEntry/);
  });

  test("contains logger failures on both the immediate and deferred summary paths", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const sink = createThrottledConsoleSink({
      windowMs: 1000,
      log: () => { throw new Error("sink unavailable"); },
    });

    expect(() => sink({ event: "test" })).not.toThrow();
    expect(() => sink({ event: "test" })).not.toThrow();
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(sink.getStats()).toMatchObject({ telemetryLogFailures: 2, telemetrySuppressedDuplicates: 1 });
  });

  test("contains unserializable input and snapshots mutable context used by deferred summaries", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 1000, log });
    const context = { route: "public" };
    const cyclic = { event: "broken" };
    cyclic.self = cyclic;

    expect(() => sink(null)).not.toThrow();
    expect(() => sink(cyclic)).not.toThrow();
    sink({ event: "route", context });
    sink({ event: "route", context });
    context.self = context;
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();

    const records = log.mock.calls.map((call) => JSON.parse(call[1]));
    expect(records.filter((entry) => entry.event === "telemetry.serialization_failed")).toHaveLength(2);
    expect(records.at(-1)).toEqual(expect.objectContaining({ event: "route", context: { route: "public" }, suppressedDuplicates: 1 }));
    expect(sink.getStats().telemetrySerializationFailures).toBe(2);
  });

  test("bounds unique throttle windows without dropping operator evidence and can release all timers", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const log = jest.fn();
    const sink = createThrottledConsoleSink({ windowMs: 60_000, maxOpenWindows: 2, log });

    sink({ event: "one" });
    sink({ event: "two" });
    sink({ event: "three" });

    expect(log).toHaveBeenCalledTimes(3);
    expect(sink.getStats()).toMatchObject({
      telemetryThrottleOpenWindows: 2,
      telemetryThrottleCapacityBypasses: 1,
    });
    sink.stop();
    expect(sink.getStats().telemetryThrottleOpenWindows).toBe(0);
  });
});
