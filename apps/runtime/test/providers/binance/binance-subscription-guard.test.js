const {
  describeBinanceSubscription,
  safeTelemetrySymbol,
  safeTelemetryMarketKind,
  safeTelemetryErrorCode,
} = require("../../../src/providers/binance/binance-subscription-guard");

describe("binance-subscription-guard", () => {
  test("describeBinanceSubscription returns a frozen, validated tuple for a proven non-KLINE request", () => {
    const descriptor = describeBinanceSubscription({
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      eventType: "TRADE",
    });

    expect(descriptor).toEqual({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" });
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  test("describeBinanceSubscription keeps interval only for KLINE", () => {
    const descriptor = describeBinanceSubscription({
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      eventType: "KLINE",
      interval: "1m",
    });

    expect(descriptor).toEqual({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" });
  });

  test("rejects an unproven symbol", () => {
    expect(() =>
      describeBinanceSubscription({ symbol: "DOGEUSDT", marketKind: "SPOT", eventType: "TRADE" }),
    ).toThrow(/Unproven Binance symbol/);
  });

  test("rejects an unproven market kind", () => {
    expect(() =>
      describeBinanceSubscription({ symbol: "BTCUSDT", marketKind: "COIN_M", eventType: "TRADE" }),
    ).toThrow(/Unproven Binance market kind/);
  });

  test("rejects an unproven event type", () => {
    expect(() =>
      describeBinanceSubscription({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "MARK_PRICE" }),
    ).toThrow(/Unproven Binance event type/);
  });

  test("rejects a lowercase symbol rather than normalizing it", () => {
    expect(() =>
      describeBinanceSubscription({ symbol: "btcusdt", marketKind: "SPOT", eventType: "TRADE" }),
    ).toThrow(/Unproven Binance symbol/);
  });

  test("rejects a Proxy-backed request without ever invoking its traps", () => {
    const trapCalls = [];
    const proxy = new Proxy(
      { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" },
      {
        get(target, key) {
          trapCalls.push(key);
          return Reflect.get(target, key);
        },
        getOwnPropertyDescriptor(target, key) {
          trapCalls.push(key);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(() => describeBinanceSubscription(proxy)).toThrow(/plain own-data object/);
    expect(trapCalls).toEqual([]);
  });

  test("rejects a Symbol-keyed field instead of ignoring it as non-enumerable noise", () => {
    expect(() =>
      describeBinanceSubscription({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        eventType: "TRADE",
        [Symbol("interval")]: "1m",
      }),
    ).toThrow(/plain own-data object/);
  });

  test("rejects a non-KLINE request that supplies an interval", () => {
    expect(() =>
      describeBinanceSubscription({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        eventType: "TRADE",
        interval: "1m",
      }),
    ).toThrow(/interval is only valid for KLINE subscriptions/);
  });

  test("rejects a KLINE request that omits interval", () => {
    expect(() =>
      describeBinanceSubscription({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        eventType: "KLINE",
      }),
    ).toThrow(/Unproven Binance candle interval/);
  });

  test("rejects a KLINE request with an unproven interval", () => {
    expect(() =>
      describeBinanceSubscription({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        eventType: "KLINE",
        interval: "3m",
      }),
    ).toThrow(/Unproven Binance candle interval/);
  });

  test("rejects null, non-object, and array input", () => {
    expect(() => describeBinanceSubscription(null)).toThrow(/plain own-data object/);
    expect(() => describeBinanceSubscription("BTCUSDT")).toThrow(/plain own-data object/);
    expect(() => describeBinanceSubscription([])).toThrow(/plain own-data object/);
  });

  test("rejects an object with an unrecognized extra key rather than silently ignoring it", () => {
    expect(() =>
      describeBinanceSubscription({
        symbol: "BTCUSDT",
        marketKind: "SPOT",
        eventType: "TRADE",
        extra: "hostile",
      }),
    ).toThrow(/plain own-data object/);
  });

  test("rejects an object with a non-enumerable or accessor-defined field instead of reading through it", () => {
    const hostile = {};
    Object.defineProperty(hostile, "symbol", { value: "BTCUSDT", enumerable: false });
    Object.defineProperty(hostile, "marketKind", { value: "SPOT", enumerable: true });
    Object.defineProperty(hostile, "eventType", { get: () => "TRADE", enumerable: true });

    expect(() => describeBinanceSubscription(hostile)).toThrow(/plain own-data object/);
  });

  test("safeTelemetry* helpers redact unrecognized values instead of passing them through", () => {
    expect(safeTelemetrySymbol("BTCUSDT")).toBe("BTCUSDT");
    expect(safeTelemetrySymbol("DOGEUSDT")).toBe("[UNRECOGNIZED_SYMBOL]");
    expect(safeTelemetryMarketKind("SPOT")).toBe("SPOT");
    expect(safeTelemetryMarketKind("MARGIN")).toBe("[UNRECOGNIZED_MARKET_KIND]");
    expect(safeTelemetryErrorCode(-1121)).toBe(-1121);
    expect(safeTelemetryErrorCode("not-a-code")).toBe("UNRECOGNIZED_ERROR_CODE");
  });
});
