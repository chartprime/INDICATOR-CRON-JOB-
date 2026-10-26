const { createBinanceFeedHealthMonitor, defaultStaleMs } = require("../../../src/providers/binance/binance-feed-health");
const { listAllowedCandleIntervals } = require("../../../src/providers/binance/binance-config");

describe("binance-feed-health", () => {
  test("a just-recorded event is not stale", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000,
    });
    expect(context).toEqual({ stale: false, recoveryState: "READY" });
  });

  test("an event exactly at the stale threshold is not yet stale (boundary-exact, not just comfortably under)", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true,
      nowMs: 1000 + defaultStaleMs("TRADE"),
    });
    expect(context.stale).toBe(false);
  });

  test("an event one millisecond past the stale threshold is stale", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true,
      nowMs: 1000 + defaultStaleMs("TRADE") + 1,
    });
    expect(context.stale).toBe(true);
    expect(context.recoveryState).toBe("READY");
  });

  test("a symbol/eventType that has never received any event is not stale -- there is no elapsed silence to measure yet, so nothing anomalous has been detected", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000,
    });
    expect(context).toEqual({ stale: false, recoveryState: "READY" });
  });

  test("BOOK_TICKER and DEPTH use a tighter default threshold than TRADE, reflecting their near-continuous cadence", () => {
    expect(defaultStaleMs("BOOK_TICKER")).toBeLessThan(defaultStaleMs("TRADE"));
    expect(defaultStaleMs("DEPTH")).toBeLessThan(defaultStaleMs("TRADE"));
  });

  test("KLINE liveness follows the live stream cadence, not the candle duration", () => {
    expect(defaultStaleMs("KLINE", "1m")).toBe(10_000);
    expect(defaultStaleMs("KLINE", "1d")).toBe(10_000);
  });

  test("every allowed candle interval uses the same live-stream stale threshold", () => {
    for (const interval of listAllowedCandleIntervals()) {
      expect(defaultStaleMs("KLINE", interval)).toBe(10_000);
    }
  });

  test("a disconnected route forces UNAVAILABLE/stale regardless of how recently an event arrived", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    monitor.recordRouteDisconnected("SPOT", "public");
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: false, nowMs: 1000,
    });
    expect(context).toEqual({ stale: true, recoveryState: "UNAVAILABLE" });
  });

  test("a disconnected route outranks an open recovery: both true at once still reports UNAVAILABLE, not RECOVERING", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "DEPTH", undefined, 1000);
    monitor.beginRecovery("SPOT", "BTCUSDT", "DEPTH");
    monitor.recordRouteDisconnected("SPOT", "public");

    // Both conditions hold simultaneously -- this is the top cell of the
    // priority table, and the only one where the two states compete.
    expect(monitor.isRecovering("SPOT", "BTCUSDT", "DEPTH")).toBe(true);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "DEPTH", routeConnected: false, nowMs: 1000,
    });
    expect(context).toEqual({ stale: true, recoveryState: "UNAVAILABLE" });
  });

  test("isRouteConnected reflects the last recorded connect/disconnect call", () => {
    const monitor = createBinanceFeedHealthMonitor();
    expect(monitor.isRouteConnected("SPOT", "public")).toBe(false);
    monitor.recordRouteConnected("SPOT", "public");
    expect(monitor.isRouteConnected("SPOT", "public")).toBe(true);
    monitor.recordRouteDisconnected("SPOT", "public");
    expect(monitor.isRouteConnected("SPOT", "public")).toBe(false);
  });

  test("beginRecovery forces RECOVERING/stale even with a fresh route and recent event", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.recordEvent("PERPETUAL", "BTCUSDT", "DEPTH", undefined, 1000);
    monitor.beginRecovery("PERPETUAL", "BTCUSDT", "DEPTH");
    const context = monitor.computeContext({
      marketKind: "PERPETUAL", symbol: "BTCUSDT", eventType: "DEPTH", routeConnected: true, nowMs: 1000,
    });
    expect(context).toEqual({ stale: true, recoveryState: "RECOVERING" });
  });

  test("a recovery that cannot establish a valid feed within the tuple stale budget becomes UNAVAILABLE", () => {
    const monitor = createBinanceFeedHealthMonitor({ now: () => 1_000 });
    monitor.recordRouteConnected("SPOT", "public");
    monitor.beginRecovery("SPOT", "BTCUSDT", "BOOK_TICKER");

    expect(monitor.computeContext({
      marketKind: "SPOT",
      symbol: "BTCUSDT",
      eventType: "BOOK_TICKER",
      routeConnected: true,
      nowMs: 1_000 + defaultStaleMs("BOOK_TICKER"),
    })).toEqual({ stale: true, recoveryState: "RECOVERING" });
    expect(monitor.computeContext({
      marketKind: "SPOT",
      symbol: "BTCUSDT",
      eventType: "BOOK_TICKER",
      routeConnected: true,
      nowMs: 1_000 + defaultStaleMs("BOOK_TICKER") + 1,
    })).toEqual({ stale: true, recoveryState: "UNAVAILABLE" });
  });

  test("endRecovery clears RECOVERING back to a normal READY/stale computation", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.recordEvent("PERPETUAL", "BTCUSDT", "DEPTH", undefined, 1000);
    monitor.beginRecovery("PERPETUAL", "BTCUSDT", "DEPTH");
    monitor.endRecovery("PERPETUAL", "BTCUSDT", "DEPTH");
    const context = monitor.computeContext({
      marketKind: "PERPETUAL", symbol: "BTCUSDT", eventType: "DEPTH", routeConnected: true, nowMs: 1000,
    });
    expect(context).toEqual({ stale: false, recoveryState: "READY" });
  });

  test("recording a DEPTH event does NOT auto-clear recovering -- only an explicit endRecovery does, since one buffered delta isn't proof of alignment", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.beginRecovery("PERPETUAL", "BTCUSDT", "DEPTH");
    monitor.recordEvent("PERPETUAL", "BTCUSDT", "DEPTH", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "PERPETUAL", symbol: "BTCUSDT", eventType: "DEPTH", routeConnected: true, nowMs: 1000,
    });
    expect(context.recoveryState).toBe("RECOVERING");
  });

  test("recording a non-DEPTH event DOES auto-clear recovering -- a single fresh trade/quote/candle is sufficient proof for those types", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.beginRecovery("SPOT", "BTCUSDT", "TRADE");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000,
    });
    expect(context).toEqual({ stale: false, recoveryState: "READY" });
  });

  test("separate (marketKind, symbol, eventType, interval) keys never interfere with each other", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    monitor.recordEvent("SPOT", "ETHUSDT", "TRADE", undefined, 1000);
    monitor.recordEvent("PERPETUAL", "BTCUSDT", "TRADE", undefined, 1000);
    monitor.recordEvent("SPOT", "BTCUSDT", "KLINE", "1m", 1000);

    monitor.beginRecovery("SPOT", "BTCUSDT", "TRADE");

    expect(monitor.computeContext({ marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000 }).recoveryState).toBe("RECOVERING");
    expect(monitor.computeContext({ marketKind: "SPOT", symbol: "ETHUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000 }).recoveryState).toBe("READY");
    expect(monitor.computeContext({ marketKind: "PERPETUAL", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1000 }).recoveryState).toBe("READY");
    expect(monitor.computeContext({ marketKind: "SPOT", symbol: "BTCUSDT", eventType: "KLINE", interval: "1m", routeConnected: true, nowMs: 1000 }).recoveryState).toBe("READY");
  });

  test("an explicit staleMs override on computeContext takes precedence over the default", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("SPOT", "public");
    monitor.recordEvent("SPOT", "BTCUSDT", "TRADE", undefined, 1000);
    const context = monitor.computeContext({
      marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", routeConnected: true, nowMs: 1500, staleMs: 100,
    });
    expect(context.stale).toBe(true);
  });

  test("recoveryStaleMs widens the recovery-only UNAVAILABLE threshold past the tighter default, so a genuinely on-schedule retry is not prematurely marked UNAVAILABLE", () => {
    const monitor = createBinanceFeedHealthMonitor({ now: () => 1_000 });
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.beginRecovery("PERPETUAL", "BTCUSDT", "DEPTH");

    const pastDefaultButBeforeRecoveryThreshold = monitor.computeContext({
      marketKind: "PERPETUAL",
      symbol: "BTCUSDT",
      eventType: "DEPTH",
      routeConnected: true,
      nowMs: 1_000 + defaultStaleMs("DEPTH") + 1,
      recoveryStaleMs: 10_000,
    });
    expect(pastDefaultButBeforeRecoveryThreshold).toEqual({ stale: true, recoveryState: "RECOVERING" });

    const pastRecoveryThreshold = monitor.computeContext({
      marketKind: "PERPETUAL",
      symbol: "BTCUSDT",
      eventType: "DEPTH",
      routeConnected: true,
      nowMs: 1_000 + 10_000 + 1,
      recoveryStaleMs: 10_000,
    });
    expect(pastRecoveryThreshold).toEqual({ stale: true, recoveryState: "UNAVAILABLE" });
  });

  test("recoveryStaleMs takes precedence over a plain staleMs override during recovery", () => {
    const monitor = createBinanceFeedHealthMonitor({ now: () => 1_000 });
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.beginRecovery("PERPETUAL", "BTCUSDT", "DEPTH");

    const context = monitor.computeContext({
      marketKind: "PERPETUAL",
      symbol: "BTCUSDT",
      eventType: "DEPTH",
      routeConnected: true,
      nowMs: 1_000 + 500,
      staleMs: 100,
      recoveryStaleMs: 10_000,
    });
    expect(context).toEqual({ stale: true, recoveryState: "RECOVERING" });
  });

  test("recoveryStaleMs has no effect once recovery has ended -- the steady-state staleness check is untouched by it", () => {
    const monitor = createBinanceFeedHealthMonitor();
    monitor.recordRouteConnected("PERPETUAL", "public");
    monitor.recordEvent("PERPETUAL", "BTCUSDT", "DEPTH", undefined, 1000);

    const context = monitor.computeContext({
      marketKind: "PERPETUAL",
      symbol: "BTCUSDT",
      eventType: "DEPTH",
      routeConnected: true,
      nowMs: 1000 + defaultStaleMs("DEPTH") + 1,
      recoveryStaleMs: 10_000,
    });
    expect(context).toEqual({ stale: true, recoveryState: "READY" });
  });
});
