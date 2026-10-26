const {
  createInstrumentTickSizeResolver,
  DEFAULT_MAX_RESPONSE_BYTES,
} = require("../../../src/providers/shared/instrument-tick-size");

const REAL_OBSERVED_FUTURES_EXCHANGE_INFO_BYTES = 1_091_861;

function exchangeInfoOk(symbol, tickSize) {
  return {
    ok: true,
    value: {
      body: {
        symbols: [{ symbol, filters: [{ filterType: "PRICE_FILTER", tickSize: String(tickSize) }] }],
      },
    },
  };
}

describe("instrument-tick-size getBinanceTickSize", () => {
  test("the exchangeInfo call goes to the spot REST origin override when one is configured, and to the fixed USD-M origin otherwise", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue(exchangeInfoOk("BTCUSDT", "0.01"));
    const resolver = createInstrumentTickSizeResolver({
      fetchExchangeInfoImpl,
      endpoints: { spotWsBaseUrl: "wss://stream.binance.com", spotRestBaseUrl: "https://data-api.binance.vision" },
    });
    await resolver.getBinanceTickSize("SPOT", "BTCUSDT");
    await resolver.getBinanceTickSize("PERPETUAL", "BTCUSDT");
    expect(fetchExchangeInfoImpl.mock.calls[0][2].baseUrl).toBe("https://data-api.binance.vision");
    expect(fetchExchangeInfoImpl.mock.calls[1][2].baseUrl).toBe("https://fapi.binance.com");
  });

  test("fetches and returns the real PRICE_FILTER.tickSize on first call", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue(exchangeInfoOk("BTCUSDT", "0.01000000"));
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.01);
    expect(fetchExchangeInfoImpl).toHaveBeenCalledTimes(1);
  });

  test("serves a cached value without a second network call inside the TTL", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue(exchangeInfoOk("BTCUSDT", "0.01"));
    let now = 1_000;
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl, nowFn: () => now });
    await resolver.getBinanceTickSize("SPOT", "BTCUSDT");
    now += 1_000;
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.01);
    expect(fetchExchangeInfoImpl).toHaveBeenCalledTimes(1);
  });

  test("refetches once the cache TTL has elapsed", async () => {
    const fetchExchangeInfoImpl = jest
      .fn()
      .mockResolvedValueOnce(exchangeInfoOk("BTCUSDT", "0.01"))
      .mockResolvedValueOnce(exchangeInfoOk("BTCUSDT", "0.02"));
    let now = 0;
    const resolver = createInstrumentTickSizeResolver({
      fetchExchangeInfoImpl,
      nowFn: () => now,
      cacheTtlMs: 1_000,
    });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.01);
    now = 1_001;
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.02);
    expect(fetchExchangeInfoImpl).toHaveBeenCalledTimes(2);
  });

  test("falls back to the last cached value when a refresh fetch fails", async () => {
    const fetchExchangeInfoImpl = jest
      .fn()
      .mockResolvedValueOnce(exchangeInfoOk("BTCUSDT", "0.01"))
      .mockResolvedValueOnce({ ok: false, reason: "NETWORK_ERROR" });
    let now = 0;
    const resolver = createInstrumentTickSizeResolver({
      fetchExchangeInfoImpl,
      nowFn: () => now,
      cacheTtlMs: 1_000,
    });
    await resolver.getBinanceTickSize("SPOT", "BTCUSDT");
    now = 2_000;
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.01);
  });

  test("returns null, not a crash, when the very first fetch fails with nothing cached yet", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue({ ok: false, reason: "TIMEOUT" });
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBeNull();
  });

  test("rejects a malformed tickSize string with trailing garbage instead of partially parsing it", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue(exchangeInfoOk("BTCUSDT", "0.01xyz"));
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBeNull();
  });

  test("returns null when the response is missing a usable PRICE_FILTER", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue({
      ok: true,
      value: { body: { symbols: [{ symbol: "BTCUSDT", filters: [] }] } },
    });
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBeNull();
  });

  test("finds the matching symbol entry rather than assuming index 0", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        body: {
          symbols: [
            { symbol: "ETHUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.05" }] },
            { symbol: "BTCUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }] },
          ],
        },
      },
    });
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await expect(resolver.getBinanceTickSize("SPOT", "BTCUSDT")).resolves.toBe(0.01);
  });

  test("requests enough headroom to fit the real unfiltered USD-M futures exchangeInfo response, not binance-http-client's smaller generic default", async () => {
    const fetchExchangeInfoImpl = jest.fn().mockResolvedValue(exchangeInfoOk("BTCUSDT", "0.10"));
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    await resolver.getBinanceTickSize("PERPETUAL", "BTCUSDT");
    const requestedMaxBytes = fetchExchangeInfoImpl.mock.calls[0][2].maxResponseBytes;
    expect(requestedMaxBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(requestedMaxBytes).toBeGreaterThan(REAL_OBSERVED_FUTURES_EXCHANGE_INFO_BYTES * 2);
  });

  test("shares one in-flight fetch across concurrent callers instead of firing two requests", async () => {
    let resolveFetch;
    const fetchExchangeInfoImpl = jest.fn(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl });
    const first = resolver.getBinanceTickSize("SPOT", "BTCUSDT");
    const second = resolver.getBinanceTickSize("SPOT", "BTCUSDT");
    resolveFetch(exchangeInfoOk("BTCUSDT", "0.01"));
    await expect(first).resolves.toBe(0.01);
    await expect(second).resolves.toBe(0.01);
    expect(fetchExchangeInfoImpl).toHaveBeenCalledTimes(1);
  });
});

describe("instrument-tick-size getDxFeedTickSize", () => {
  const resolver = createInstrumentTickSizeResolver({ fetchExchangeInfoImpl: jest.fn() });

  // L1L2-V2-010. These tick sizes used to live in two hardcoded lists inside
  // instrument-tick-size.js -- exactly the "server-local instrument list" that
  // config/README.md forbids. Adding an instrument to the governed catalog left
  // its tick size null, which silently disabled Volume Profile and VPIN for it
  // with no error surfaced. They now come from the catalog, which validates
  // tickSize at load so an unconfigured instrument fails loudly at start.
  test.each([
    ["/ESZ26:XCME", 0.25],
    ["/NQZ26:XCME", 0.25],
  ])("takes the CME tick size for %s from the governed catalog", (symbol, expected) => {
    expect(resolver.getDxFeedTickSize("FUTURE", symbol)).toBe(expected);
  });

  test("retired contracts retain their governed root tick size for historical replay", () => {
    expect(resolver.getDxFeedTickSize("FUTURE", "/NQU26:XCME")).toBe(0.25);
    expect(resolver.getDxFeedTickSize("FUTURE", "/ESU26:XCME")).toBe(0.25);
  });

  test.each(["AAPL", "TSLA"])("takes the equity tick size for %s from the governed catalog", (symbol) => {
    expect(resolver.getDxFeedTickSize("EQUITY", symbol)).toBe(0.01);
  });

  test("every dxFeed catalog instrument resolves to a usable tick size", () => {
    const catalog = require("../../../../../config/market-instruments.json");
    for (const entry of catalog.dxfeed) {
      const tickSize = resolver.getDxFeedTickSize(entry.assetClass, entry.symbol);
      expect(typeof tickSize).toBe("number");
      expect(tickSize).toBeGreaterThan(0);
    }
  });

  test("returns null for an unrecognized futures root or equity symbol", () => {
    expect(resolver.getDxFeedTickSize("FUTURE", "/CLU26:NYMEX")).toBeNull();
    expect(resolver.getDxFeedTickSize("EQUITY", "MSFT")).toBeNull();
  });

  test("returns null for a bare futures root with no contract suffix, or an unrecognized asset class", () => {
    expect(resolver.getDxFeedTickSize("FUTURE", "/ES")).toBeNull();
    expect(resolver.getDxFeedTickSize("BOGUS", "AAPL")).toBeNull();
  });
});
