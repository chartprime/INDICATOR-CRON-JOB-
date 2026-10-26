const {
  createBinanceBackpressureQueue,
  QUEUEABLE_EVENT_TYPES,
  OVERFLOW_POLICIES,
} = require("../../../src/providers/binance/binance-backpressure-queue");

describe("binance-backpressure-queue", () => {
  test("accepts TRADE, BOOK_TICKER, and KLINE; DEPTH is not queueable here", () => {
    expect(QUEUEABLE_EVENT_TYPES).toEqual(["TRADE", "BOOK_TICKER", "KLINE"]);
    const queue = createBinanceBackpressureQueue();
    expect(() => queue.enqueue("BTCUSDT", "TRADE", { id: 1 })).not.toThrow();
    expect(() => queue.enqueue("BTCUSDT", "DEPTH", { id: 1 })).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
  });

  test("rejects DEPTH on every keyed method, not only enqueue", () => {
    const queue = createBinanceBackpressureQueue();
    expect(() => queue.drain("BTCUSDT", "DEPTH")).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
    // drainUpTo is the method the connection's own drain loop actually calls,
    // so it must fail closed for DEPTH exactly like the others.
    expect(() => queue.drainUpTo("BTCUSDT", "DEPTH", 10)).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
    expect(() => queue.drainOne("BTCUSDT", "DEPTH")).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
    expect(() => queue.size("BTCUSDT", "DEPTH")).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
    expect(() => queue.clear("BTCUSDT", "DEPTH")).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
  });

  test("a drained batch is detached from internal state; mutating it never affects a later enqueue", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    const drained = queue.drain("BTCUSDT", "TRADE");
    drained.push({ id: "injected" });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: 2 }]);
  });

  test("enqueue/drain preserves FIFO order for one (symbol, eventType) pair", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 3 });
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([]);
  });

  test("separate (symbol, eventType) pairs never interfere with each other", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: "btc-trade" });
    queue.enqueue("ETHUSDT", "TRADE", { id: "eth-trade" });
    queue.enqueue("BTCUSDT", "KLINE", { id: "btc-kline" });
    expect(queue.size("BTCUSDT", "TRADE")).toBe(1);
    expect(queue.size("ETHUSDT", "TRADE")).toBe(1);
    expect(queue.size("BTCUSDT", "KLINE")).toBe(1);
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: "btc-trade" }]);
    expect(queue.size("ETHUSDT", "TRADE")).toBe(1);
  });

  test("separate KLINE intervals for the same symbol never interfere with each other", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "KLINE", { id: "btc-1m" }, "1m");
    queue.enqueue("BTCUSDT", "KLINE", { id: "btc-5m" }, "5m");
    expect(queue.size("BTCUSDT", "KLINE", "1m")).toBe(1);
    expect(queue.size("BTCUSDT", "KLINE", "5m")).toBe(1);

    expect(queue.drain("BTCUSDT", "KLINE", "1m")).toEqual([{ id: "btc-1m" }]);
    expect(queue.size("BTCUSDT", "KLINE", "5m")).toBe(1);
  });

  test("clearing one KLINE interval does not drop a still-active interval's queued events", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "KLINE", { id: "btc-1m" }, "1m");
    queue.enqueue("BTCUSDT", "KLINE", { id: "btc-5m" }, "5m");

    queue.clear("BTCUSDT", "KLINE", "1m");

    expect(queue.size("BTCUSDT", "KLINE", "1m")).toBe(0);
    expect(queue.drain("BTCUSDT", "KLINE", "5m")).toEqual([{ id: "btc-5m" }]);
  });

  test("drops the oldest event once the bound is exceeded, keeping the newest", () => {
    const queue = createBinanceBackpressureQueue({ maxQueueDepth: 3 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 3 });
    const dropped = queue.enqueue("BTCUSDT", "TRADE", { id: 4 });
    expect(dropped).toEqual({ id: 1 });
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
  });

  test("emits a drop telemetry event with a redacted symbol and no raw event payload", () => {
    const telemetry = jest.fn();
    const queue = createBinanceBackpressureQueue({ telemetry, maxQueueDepth: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 1, secret: "SENSITIVE_PAYLOAD_DATA" });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });

    const dropEvents = telemetry.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.event === "market_data.binance_backpressure.event_dropped");
    expect(dropEvents).toHaveLength(1);
    expect(dropEvents[0]).toEqual(
      expect.objectContaining({ symbol: "BTCUSDT", eventType: "TRADE", queueDepth: 1 }),
    );
    expect(JSON.stringify(dropEvents[0])).not.toContain("SENSITIVE_PAYLOAD_DATA");
  });

  test("redacts an unrecognized symbol in drop telemetry rather than logging it raw", () => {
    const telemetry = jest.fn();
    const queue = createBinanceBackpressureQueue({ telemetry, maxQueueDepth: 1 });
    queue.enqueue("NOT_A_REAL_SYMBOL", "TRADE", { id: 1 });
    queue.enqueue("NOT_A_REAL_SYMBOL", "TRADE", { id: 2 });

    const dropEvents = telemetry.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.event === "market_data.binance_backpressure.event_dropped");
    expect(dropEvents[0].symbol).toBe("[UNRECOGNIZED_SYMBOL]");
  });

  test("clear removes only the targeted (symbol, eventType) pair", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("ETHUSDT", "TRADE", { id: 2 });
    queue.clear("BTCUSDT", "TRADE");
    expect(queue.size("BTCUSDT", "TRADE")).toBe(0);
    expect(queue.size("ETHUSDT", "TRADE")).toBe(1);
  });

  test("drainUpTo removes at most maxCount from the front, preserving FIFO and leaving the remainder queued", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 3 });

    expect(queue.drainUpTo("BTCUSDT", "TRADE", 2)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(queue.size("BTCUSDT", "TRADE")).toBe(1);
    expect(queue.drainUpTo("BTCUSDT", "TRADE", 2)).toEqual([{ id: 3 }]);
    expect(queue.size("BTCUSDT", "TRADE")).toBe(0);
  });

  test("drainUpTo returns an empty array for an empty or unknown pair without throwing", () => {
    const queue = createBinanceBackpressureQueue();
    expect(queue.drainUpTo("BTCUSDT", "TRADE", 10)).toEqual([]);
  });

  test("drainOne preserves FIFO order without detaching more than one event", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });

    expect(queue.drainOne("BTCUSDT", "TRADE")).toEqual({ id: 1 });
    expect(queue.size("BTCUSDT", "TRADE")).toBe(1);
    expect(queue.drainOne("BTCUSDT", "TRADE")).toEqual({ id: 2 });
    expect(queue.drainOne("BTCUSDT", "TRADE")).toBeNull();
    expect(queue.getStats()).toMatchObject({ drained: 2, pending: 0 });
  });

  test("drainUpTo rejects DEPTH the same way as drain", () => {
    const queue = createBinanceBackpressureQueue();
    expect(() => queue.drainUpTo("BTCUSDT", "DEPTH", 10)).toThrow(
      /DEPTH deltas route through the book assembler/,
    );
  });

  test("drainUpTo rejects a non-positive or fractional budget", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });

    for (const maxCount of [0, -1, 1.5, NaN]) {
      expect(() => queue.drainUpTo("BTCUSDT", "TRADE", maxCount)).toThrow(/maxCount/);
    }
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: 1 }]);
  });

  test("clearAll empties every (symbol, eventType) pair at once", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("ETHUSDT", "KLINE", { id: 2 });
    queue.clearAll();
    expect(queue.size("BTCUSDT", "TRADE")).toBe(0);
    expect(queue.size("ETHUSDT", "KLINE")).toBe(0);
  });

  test("rejects a non-positive or non-integer maxQueueDepth at creation", () => {
    expect(() => createBinanceBackpressureQueue({ maxQueueDepth: 0 })).toThrow();
    expect(() => createBinanceBackpressureQueue({ maxQueueDepth: -5 })).toThrow();
    expect(() => createBinanceBackpressureQueue({ maxQueueDepth: 1.5 })).toThrow();
  });

  test("defaults to a queue depth of 500 when unspecified", () => {
    const queue = createBinanceBackpressureQueue();
    for (let i = 0; i < 500; i += 1) {
      expect(queue.enqueue("BTCUSDT", "TRADE", { id: i })).toBeNull();
    }
    expect(queue.enqueue("BTCUSDT", "TRADE", { id: 500 })).toEqual({ id: 0 });
  });

  test("FAIL policy rejects overflow without evicting an already accepted event", () => {
    const telemetry = jest.fn();
    const queue = createBinanceBackpressureQueue({
      telemetry,
      maxQueueDepth: 2,
      overflowPolicy: OVERFLOW_POLICIES.FAIL,
    });
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });

    expect(() => queue.enqueue("BTCUSDT", "TRADE", { id: 3 })).toThrow(/queue overflow/);
    expect(queue.drain("BTCUSDT", "TRADE")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(queue.getStats()).toMatchObject({ dropped: 0, overflows: 1, highWaterMark: 2 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      event: "market_data.binance_backpressure.queue_overflow",
      queueDepth: 2,
    }));
  });

  test("clear methods report and account for every discarded queued event", () => {
    const queue = createBinanceBackpressureQueue();
    queue.enqueue("BTCUSDT", "TRADE", { id: 1 });
    queue.enqueue("BTCUSDT", "TRADE", { id: 2 });
    queue.enqueue("ETHUSDT", "KLINE", { id: 3 }, "1m");

    expect(queue.clear("BTCUSDT", "TRADE")).toBe(2);
    expect(queue.clearAll()).toBe(1);
    expect(queue.getStats()).toMatchObject({ pending: 0, cleared: 3 });
  });

  test("rejects an unknown overflow policy", () => {
    expect(() => createBinanceBackpressureQueue({ overflowPolicy: "MAYBE" })).toThrow(/overflowPolicy/);
  });
});
