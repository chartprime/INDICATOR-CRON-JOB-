const {
  createCollectorIntegrityMonitor,
  CAPTURE_QUALITY,
  COLLECTOR_STATUS,
} = require("../../src/storage/collector-integrity-monitor");

describe("collector-integrity-monitor", () => {
  test("recovers a route window without leaving live collection degraded", () => {
    let nowMs = 1_000;
    const monitor = createCollectorIntegrityMonitor({ now: () => nowMs });

    const opened = monitor.recordTelemetry({
      event: "market_data.binance_connection.route_disconnected",
      marketKind: "PERPETUAL",
      route: "public",
    });
    expect(opened).toMatchObject({ isIncident: true, kind: "window_opened", scope: "route:PERPETUAL:public" });
    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.DEGRADED,
      collectorStatus: COLLECTOR_STATUS.RECOVERING,
      activeDegradedWindows: 1,
      recoveryAgeMs: 0,
    });

    nowMs = 2_000;
    expect(monitor.getStats().recoveryAgeMs).toBe(1_000);

    nowMs = 2_250;
    const recovered = monitor.recordTelemetry({
      event: "market_data.binance_connection.route_reconnect_succeeded",
      marketKind: "PERPETUAL",
      route: "public",
    });

    expect(recovered).toMatchObject({ isIncident: true, kind: "window_recovered", durationMs: 1_250 });
    expect(recovered.incidents[0]).toMatchObject({
      event: "collector.integrity_window_recovered",
      triggerEvent: "market_data.binance_connection.route_disconnected",
      recoveredEvent: "market_data.binance_connection.route_reconnect_succeeded",
      startedAt: 1_000,
      endedAt: 2_250,
    });
    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.DEGRADED,
      collectorStatus: COLLECTOR_STATUS.HEALTHY,
      activeDegradedWindows: 0,
      recoveryAgeMs: 0,
      recoveredWindows: 1,
      routeDisconnects: 1,
      firstIncidentAt: 1_000,
      lastIncidentAt: 1_000,
    });
  });

  test("treats automatic stale recovery as a route window so reconnect completion clears it", () => {
    let nowMs = 1_000;
    const monitor = createCollectorIntegrityMonitor({ now: () => nowMs });

    monitor.recordTelemetry({
      event: "market_data.binance_connection.stale_subscription_recovery_started",
      marketKind: "SPOT",
      route: "public",
      symbol: "BTCUSDT",
      eventType: "DEPTH",
      scope: "route",
    });
    monitor.recordTelemetry({
      event: "market_data.binance_connection.route_disconnected",
      marketKind: "SPOT",
      route: "public",
    });
    expect(monitor.getStats()).toMatchObject({
      collectorStatus: COLLECTOR_STATUS.RECOVERING,
      activeDegradedWindows: 1,
    });

    nowMs = 2_000;
    monitor.recordTelemetry({
      event: "market_data.binance_connection.route_reconnect_succeeded",
      marketKind: "SPOT",
      route: "public",
    });
    expect(monitor.getStats()).toMatchObject({
      collectorStatus: COLLECTOR_STATUS.HEALTHY,
      activeDegradedWindows: 0,
      recoveredWindows: 1,
    });
  });

  test("records a restart-boundary trade gap without degrading the current live status", () => {
    const monitor = createCollectorIntegrityMonitor();
    const result = monitor.recordTelemetry({
      event: "storage.trade_id_session_boundary_gap",
      marketKind: "SPOT",
      symbol: "BTCUSDT",
      previousTradeId: 20,
      currentTradeId: 22,
      missingCount: 1,
    });

    expect(result).toMatchObject({ isIncident: true, kind: "gap_recorded" });
    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.DEGRADED,
      collectorStatus: COLLECTOR_STATUS.HEALTHY,
      recordedGaps: 1,
      integrityIncidents: 1,
    });
  });

  test("a queue clear degrades session history while an actual drop invalidates live collection", () => {
    const monitor = createCollectorIntegrityMonitor();
    monitor.recordTelemetry({
      event: "market_data.binance_backpressure.queue_cleared",
      discardedCount: 17,
    });

    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.DEGRADED,
      collectorStatus: COLLECTOR_STATUS.HEALTHY,
      queueClearedEvents: 17,
    });

    monitor.recordTelemetry({ event: "market_data.binance_backpressure.event_dropped" });

    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.INVALID,
      collectorStatus: COLLECTOR_STATUS.INVALID,
      droppedEvents: 1,
      queueClearedEvents: 17,
    });
  });

  test.each([
    "market_data.binance_backpressure.queue_overflow",
    "market_data.binance_raw_ingress.queue_overflow",
  ])("a strict queue overflow invalidates the capture session (%s)", (event) => {
    const monitor = createCollectorIntegrityMonitor();
    monitor.recordTelemetry({ event, droppedCount: 1 });

    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.INVALID,
      collectorStatus: COLLECTOR_STATUS.INVALID,
      droppedEvents: 1,
    });
  });

  test("fatal storage failures invalidate the session", () => {
    const monitor = createCollectorIntegrityMonitor();
    monitor.recordFatalError();
    expect(monitor.getStats()).toMatchObject({ captureQuality: "INVALID", collectorStatus: "INVALID", fatalErrors: 1 });
  });

  test("a rejected exchange frame degrades operational evidence without inventing a known data gap", () => {
    const monitor = createCollectorIntegrityMonitor();
    const result = monitor.recordTelemetry({
      event: "market_data.binance_connection.message_rejected",
      marketKind: "SPOT",
      route: "public",
      reason: "malformed payload",
    });

    expect(result).toMatchObject({ isIncident: true, kind: "operational_degraded" });
    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.DEGRADED,
      collectorStatus: COLLECTOR_STATUS.HEALTHY,
      recordedGaps: 0,
      integrityIncidents: 1,
      operationalDegradations: 1,
    });
  });

  test("a record rejected by durable storage invalidates capture because the omitted record cannot be recovered", () => {
    const monitor = createCollectorIntegrityMonitor();
    const result = monitor.recordTelemetry({ event: "storage.record_rejected", reason: "invalid trade" });
    expect(result).toMatchObject({ isIncident: true, kind: "invalid" });
    expect(monitor.getStats()).toMatchObject({
      captureQuality: CAPTURE_QUALITY.INVALID,
      collectorStatus: COLLECTOR_STATUS.INVALID,
      droppedEvents: 1,
      recordedGaps: 0,
    });
  });

  test("kline integrity windows include interval so independent subscriptions cannot collide", () => {
    const monitor = createCollectorIntegrityMonitor();
    const result = monitor.recordTelemetry({
      event: "market_data.binance_connection.stale_subscription_recovery_started",
      marketKind: "SPOT",
      symbol: "BTCUSDT",
      eventType: "KLINE",
      interval: "1m",
    });
    expect(result.scope).toBe("subscription:SPOT:BTCUSDT:KLINE:1m");
  });
});
