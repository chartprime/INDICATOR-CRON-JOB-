const {
  MARKET_KINDS,
  EVENT_TYPES,
  isAllowedSymbol,
  isAllowedMarketKind,
  isAllowedEventType,
  isAllowedCandleInterval,
  candleIntervalMsFor,
  restBaseUrlFor,
  wsBaseUrlsFor,
  createBinanceMarketKindContext,
  listAllowedSymbols,
} = require("../../../src/providers/binance/binance-config");
const marketInstrumentCatalog = require("../../../../../config/market-instruments.json");

describe("binance-config", () => {
  test("BTCUSDT and ETHUSDT are the only allowed symbols", () => {
    expect(isAllowedSymbol("BTCUSDT")).toBe(true);
    expect(isAllowedSymbol("ETHUSDT")).toBe(true);
    expect(isAllowedSymbol("DOGEUSDT")).toBe(false);
  });

  test("derives the selectable symbol set from the same governed catalog as the frontend", () => {
    const catalogSymbols = [...new Set(marketInstrumentCatalog.binance.map((entry) => entry.symbol.replace("-", "")))].sort();
    expect([...listAllowedSymbols()].sort()).toEqual(catalogSymbols);
  });

  test("SPOT and PERPETUAL are the only allowed market kinds", () => {
    expect(isAllowedMarketKind(MARKET_KINDS.SPOT)).toBe(true);
    expect(isAllowedMarketKind(MARKET_KINDS.PERPETUAL)).toBe(true);
    expect(isAllowedMarketKind("MARGIN")).toBe(false);
  });

  test("every declared EVENT_TYPES value is allowed", () => {
    for (const eventType of Object.values(EVENT_TYPES)) {
      expect(isAllowedEventType(eventType)).toBe(true);
    }
    expect(isAllowedEventType("LIQUIDATION")).toBe(false);
  });

  test("candle interval allowlist covers the starter set and rejects anything else", () => {
    expect(isAllowedCandleInterval("1m")).toBe(true);
    expect(isAllowedCandleInterval("1d")).toBe(true);
    expect(isAllowedCandleInterval("3m")).toBe(false);
  });

  test("every allowed candle interval has one authoritative positive duration", () => {
    expect(candleIntervalMsFor("1m")).toBe(60_000);
    expect(candleIntervalMsFor("1d")).toBe(86_400_000);
    expect(candleIntervalMsFor("3m")).toBeUndefined();
  });

  test("wsBaseUrlsFor returns one public URL for SPOT and two for PERPETUAL", () => {
    expect(wsBaseUrlsFor(MARKET_KINDS.SPOT)).toEqual({ public: "wss://stream.binance.com" });
    expect(wsBaseUrlsFor(MARKET_KINDS.PERPETUAL)).toEqual({
      public: "wss://fstream.binance.com/public",
      market: "wss://fstream.binance.com/market",
    });
  });

  test("wsBaseUrlsFor returns undefined for an unrecognized market kind", () => {
    expect(wsBaseUrlsFor("MARGIN")).toBeUndefined();
  });

  test("restBaseUrlFor returns the correct REST origin per market kind", () => {
    expect(restBaseUrlFor(MARKET_KINDS.SPOT)).toBe("https://api.binance.com");
    expect(restBaseUrlFor(MARKET_KINDS.PERPETUAL)).toBe("https://fapi.binance.com");
  });

  test("restBaseUrlFor returns undefined for an unrecognized market kind", () => {
    expect(restBaseUrlFor("MARGIN")).toBeUndefined();
  });

  test("createBinanceMarketKindContext throws for an unrecognized market kind", () => {
    expect(() => createBinanceMarketKindContext("MARGIN")).toThrow(/unrecognized/);
    expect(() => createBinanceMarketKindContext(undefined)).toThrow(/missing/);
  });

  test("two calls to createBinanceMarketKindContext never share a subscriptionRegistry instance", () => {
    const spotA = createBinanceMarketKindContext(MARKET_KINDS.SPOT);
    const spotB = createBinanceMarketKindContext(MARKET_KINDS.SPOT);

    spotA.subscriptionRegistry.add("BTCUSDT", "TRADE", "consumer-a");

    expect(spotB.subscriptionRegistry.list()).toHaveLength(0);
  });

  test("createBinanceMarketKindContext returns a frozen object scoped to exactly one market kind", () => {
    const context = createBinanceMarketKindContext(MARKET_KINDS.SPOT);

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.marketKind).toBe(MARKET_KINDS.SPOT);
  });
});

describe("instrument L2 geometry (report 61 P3c)", () => {
  const { validL2Geometry } = require("../../../src/providers/binance/binance-config");

  test("an optional heatmap window between 0 and 100 % is accepted; anything else refuses the catalog entry", () => {
    const base = { clusterTicks: 5, minSliceSize: 0.01 };
    expect(validL2Geometry(base)).toBe(true);
    expect(validL2Geometry({ ...base, windowPct: 7 })).toBe(true);
    expect(validL2Geometry({ ...base, windowPct: 100 })).toBe(true);
    expect(validL2Geometry({ ...base, windowPct: 0 })).toBe(false);
    expect(validL2Geometry({ ...base, windowPct: 100.5 })).toBe(false);
    expect(validL2Geometry({ ...base, windowPct: "7" })).toBe(false);
    expect(validL2Geometry({ ...base, window: 7 })).toBe(false);
  });
});
