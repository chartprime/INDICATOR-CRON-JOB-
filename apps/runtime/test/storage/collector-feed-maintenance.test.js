const {
  createCollectorFeedMaintenance,
  listCollectorSubscriptions,
} = require("../../src/storage/collector-feed-maintenance");

function fakeConnection(healthFor) {
  return {
    getFeedHealth: jest.fn(healthFor),
    recoverStaleSubscription: jest.fn(() => true),
  };
}

describe("collector feed maintenance", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("enumerates trade, 1m kline, and depth for every allowlisted pair", () => {
    const requests = listCollectorSubscriptions();

    expect(requests).toHaveLength(12);
    expect(requests).toContainEqual({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" });
    expect(requests).toContainEqual({
      symbol: "ETHUSDT",
      marketKind: "PERPETUAL",
      eventType: "KLINE",
      interval: "1m",
    });
    expect(requests).toContainEqual({ symbol: "ETHUSDT", marketKind: "PERPETUAL", eventType: "DEPTH" });
  });

  test("recovers the first feed only after consecutive stale observations so one delayed tick cannot flap it", () => {
    const connection = fakeConnection((_marketKind, symbol, eventType) => ({
      stale: symbol === "ETHUSDT" && eventType === "TRADE",
      recoveryState: "READY",
    }));
    const maintenance = createCollectorFeedMaintenance({ connection });

    expect(maintenance.runOnce()).toBeNull();
    const recovered = maintenance.runOnce();

    expect(recovered).toEqual({ symbol: "ETHUSDT", marketKind: "SPOT", eventType: "TRADE" });
    expect(connection.recoverStaleSubscription).toHaveBeenCalledWith(recovered, { automatic: true });
    expect(connection.recoverStaleSubscription).toHaveBeenCalledTimes(1);
  });

  test("does not repeatedly restart a feed whose recovery is already in progress", () => {
    const connection = fakeConnection(() => ({ stale: true, recoveryState: "RECOVERING" }));
    const maintenance = createCollectorFeedMaintenance({ connection });

    expect(maintenance.runOnce()).toBeNull();
    expect(connection.recoverStaleSubscription).not.toHaveBeenCalled();
  });

  test("defers stale-feed recovery while the local runtime is paused", () => {
    const connection = fakeConnection(() => ({ stale: true, recoveryState: "READY" }));
    const maintenance = createCollectorFeedMaintenance({ connection, shouldRecover: () => false });

    expect(maintenance.runOnce()).toBeNull();
    expect(connection.getFeedHealth).not.toHaveBeenCalled();
    expect(connection.recoverStaleSubscription).not.toHaveBeenCalled();
  });

  test("continues scanning when a disconnected route cannot yet be restarted by subscription recovery", () => {
    const connection = fakeConnection(() => ({ stale: true, recoveryState: "UNAVAILABLE" }));
    connection.recoverStaleSubscription
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const maintenance = createCollectorFeedMaintenance({ connection });

    expect(maintenance.runOnce()).toBeNull();
    const recovered = maintenance.runOnce();

    expect(recovered).toEqual({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" });
    expect(connection.recoverStaleSubscription).toHaveBeenCalledTimes(2);
  });

  test("start and stop control the periodic check", () => {
    jest.useFakeTimers();
    const connection = fakeConnection(() => ({ stale: false, recoveryState: "READY" }));
    const maintenance = createCollectorFeedMaintenance({ connection, intervalMs: 1000 });

    maintenance.start();
    jest.advanceTimersByTime(1000);
    expect(connection.getFeedHealth).toHaveBeenCalledTimes(12);
    maintenance.stop();
    jest.advanceTimersByTime(5000);
    expect(connection.getFeedHealth).toHaveBeenCalledTimes(12);
  });

  test("enforces a per-feed cooldown after recovery", () => {
    let nowMs = 1000;
    const connection = fakeConnection((marketKind, symbol, eventType) => ({
      stale: marketKind === "SPOT" && symbol === "BTCUSDT" && eventType === "TRADE",
      recoveryState: "READY",
    }));
    const maintenance = createCollectorFeedMaintenance({ connection, now: () => nowMs, recoveryCooldownMs: 30_000 });

    maintenance.runOnce();
    expect(maintenance.runOnce()).not.toBeNull();
    expect(connection.recoverStaleSubscription).toHaveBeenCalledTimes(1);

    nowMs = 2000;
    maintenance.runOnce();
    maintenance.runOnce();
    expect(connection.recoverStaleSubscription).toHaveBeenCalledTimes(1);

    nowMs = 31_001;
    expect(maintenance.runOnce()).not.toBeNull();
    expect(connection.recoverStaleSubscription).toHaveBeenCalledTimes(2);
  });

  test("invalid construction and maintenance failures are contained and reported", () => {
    expect(() => createCollectorFeedMaintenance({ connection: {} })).toThrow(/connection/);
    expect(() => createCollectorFeedMaintenance({ connection: fakeConnection(() => null), consecutiveStaleObservations: 0 })).toThrow(/consecutiveStaleObservations/);
    expect(() => createCollectorFeedMaintenance({ connection: fakeConnection(() => null), recoveryCooldownMs: 0 })).toThrow(/recoveryCooldownMs/);
    expect(() => createCollectorFeedMaintenance({ connection: fakeConnection(() => null), shouldRecover: null })).toThrow(/shouldRecover/);
    const connection = fakeConnection(() => {
      throw new Error("health unavailable");
    });
    const onError = jest.fn();
    const maintenance = createCollectorFeedMaintenance({ connection, onError });

    expect(maintenance.runOnce()).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "health unavailable" }));
  });

  test("one broken feed-health probe cannot starve later subscriptions", () => {
    const connection = fakeConnection((_marketKind, symbol, eventType) => {
      if (symbol === "BTCUSDT" && eventType === "TRADE") throw new Error("first feed failed");
      return { stale: symbol === "BTCUSDT" && eventType === "KLINE", recoveryState: "READY" };
    });
    const onError = jest.fn();
    const maintenance = createCollectorFeedMaintenance({
      connection,
      onError,
      consecutiveStaleObservations: 1,
    });

    expect(maintenance.runOnce()).toEqual({
      symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m",
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "first feed failed",
      request: expect.objectContaining({ symbol: "BTCUSDT", eventType: "TRADE" }),
    }));
  });

  test("a recovery pause clears stale observations so recovery still needs fresh confirmation", () => {
    let allowed = true;
    const connection = fakeConnection(() => ({ stale: true, recoveryState: "READY" }));
    const maintenance = createCollectorFeedMaintenance({ connection, shouldRecover: () => allowed });

    maintenance.runOnce();
    allowed = false;
    maintenance.runOnce();
    allowed = true;
    expect(maintenance.runOnce()).toBeNull();
    expect(maintenance.runOnce()).not.toBeNull();
  });
});
