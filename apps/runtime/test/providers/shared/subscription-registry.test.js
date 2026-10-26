const { createSubscriptionRegistry } = require("../../../src/providers/shared/subscription-registry");

describe("subscription-registry", () => {
  test("add() reports true for the first consumer of a tuple, false for a second consumer of the same tuple", () => {
    const registry = createSubscriptionRegistry();

    expect(registry.add("BTCUSDT", "TRADE", "consumer-a")).toBe(true);
    expect(registry.add("BTCUSDT", "TRADE", "consumer-b")).toBe(false);
  });

  test("the same consumer adding twice is Set membership, not a refcount: one remove fully releases the tuple", () => {
    const registry = createSubscriptionRegistry();

    expect(registry.add("BTCUSDT", "TRADE", "consumer-a")).toBe(true);
    expect(registry.add("BTCUSDT", "TRADE", "consumer-a")).toBe(false);
    expect(registry.remove("BTCUSDT", "TRADE", "consumer-a")).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  test("an existing tuple remains on the wire when a later holder supplies different fromTime metadata", () => {
    const registry = createSubscriptionRegistry();

    expect(registry.add("BTCUSDT", "TRADE", "consumer-a", 1_000)).toBe(true);
    expect(registry.add("BTCUSDT", "TRADE", "consumer-b", 2_000)).toBe(false);
    expect(registry.list()).toEqual([{ symbol: "BTCUSDT", eventType: "TRADE", fromTime: 1_000 }]);
  });

  test("remove() reports true only when the last consumer releases the tuple", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "TRADE", "consumer-a");
    registry.add("BTCUSDT", "TRADE", "consumer-b");

    expect(registry.remove("BTCUSDT", "TRADE", "consumer-a")).toBe(false);
    expect(registry.remove("BTCUSDT", "TRADE", "consumer-b")).toBe(true);
  });

  test("remove() reports false for a consumer that never held the tuple", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "TRADE", "consumer-a");

    expect(registry.remove("BTCUSDT", "TRADE", "consumer-nobody")).toBe(false);
  });

  test("interval distinguishes otherwise-identical tuples (e.g. two KLINE intervals for the same symbol)", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "KLINE", "consumer-a", undefined, "1m");
    registry.add("BTCUSDT", "KLINE", "consumer-a", undefined, "5m");

    expect(registry.list()).toHaveLength(2);
    expect(registry.remove("BTCUSDT", "KLINE", "consumer-a", "1m")).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].interval).toBe("5m");
  });

  test("removeConsumer() releases a tuple the consumer held exclusively, but not one still shared with another consumer", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "TRADE", "consumer-a");
    registry.add("ETHUSDT", "TRADE", "consumer-a");
    registry.add("ETHUSDT", "TRADE", "consumer-b");

    const released = registry.removeConsumer("consumer-a");

    expect(released).toEqual([{ symbol: "BTCUSDT", eventType: "TRADE" }]);
    expect(registry.list()).toEqual(expect.arrayContaining([{ symbol: "ETHUSDT", eventType: "TRADE" }]));
  });

  test("list() reflects only currently-held tuples, omitting undefined fromTime/interval", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "TRADE", "consumer-a");

    expect(registry.list()).toEqual([{ symbol: "BTCUSDT", eventType: "TRADE" }]);
  });

  test("has() performs membership lookup without materializing the registry", () => {
    const registry = createSubscriptionRegistry();
    registry.add("BTCUSDT", "KLINE", "consumer-a", undefined, "1m");

    expect(registry.has("BTCUSDT", "KLINE", "1m")).toBe(true);
    expect(registry.has("BTCUSDT", "KLINE", "5m")).toBe(false);
    expect(registry.has("ETHUSDT", "KLINE", "1m")).toBe(false);
  });
});
