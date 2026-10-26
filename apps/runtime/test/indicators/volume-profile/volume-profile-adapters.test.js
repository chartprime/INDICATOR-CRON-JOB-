const {
  createBinanceVolumeProfileAdapter,
  createDxFeedVolumeProfileAdapter,
} = require("../../../src/indicators/volume-profile/volume-profile-adapters");

describe("createBinanceVolumeProfileAdapter", () => {
  // The real readRecentTrades sets `available` on every one of its return
  // paths, so the double has to as well -- otherwise it cannot exercise the
  // unavailable branch the engines actually switch on.
  function fakeStorageReader({ readRecentTradesResult, readVolumeProfileResult } = {}) {
    return {
      readRecentTrades: jest.fn(() => readRecentTradesResult ?? { rows: [], nextCursor: null, available: true }),
      readVolumeProfile: jest.fn(() => readVolumeProfileResult ?? { buckets: [], available: true }),
    };
  }

  test("readVolumeProfile passes symbol/marketKind through unchanged, arguments in order", () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    adapter.readVolumeProfile(1000, 2000, 100, 1);
    expect(storageReader.readVolumeProfile).toHaveBeenCalledWith("BTCUSDT", "SPOT", {
      fromTs: 1000, toTs: 2000, originPrice: 100, rowWidth: 1,
    });
  });

  test("readTradesSince translates absolute bounds to windowMs/nowMs correctly", async () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    adapter.readTradesSince(1000, 5000, null, 200);
    expect(storageReader.readRecentTrades).toHaveBeenCalledWith("BTCUSDT", "SPOT", {
      windowMs: 3999, nowMs: 4999, cursor: null, limit: 200,
    });
  });

  test("readTradesSince passes a non-null cursor through, never sinceTs", () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    adapter.readTradesSince(1000, 5000, { ts: 4000, id: 7 }, 200);
    const callArgs = storageReader.readRecentTrades.mock.calls[0][2];
    expect(callArgs.cursor).toEqual({ ts: 4000, id: 7 });
    expect(Object.hasOwn(callArgs, "sinceTs")).toBe(false);
  });

  test("readTradesSince with a cursor pages from the cursor's time, not from the session's start", () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    adapter.readTradesSince(1000, 5000, { ts: 4000, id: 7 }, 200);
    expect(storageReader.readRecentTrades.mock.calls[0][2]).toMatchObject({ windowMs: 999, nowMs: 4999 });
    adapter.readTradesSince(1000, 5000, { ts: 500, id: 7 }, 200);
    expect(storageReader.readRecentTrades.mock.calls[1][2]).toMatchObject({ windowMs: 3999, nowMs: 4999 });
  });

  test("readTradesSince maps each row's field names to the engine's expected shape", async () => {
    const storageReader = fakeStorageReader({
      readRecentTradesResult: {
        rows: [{ ts_exchange: 1234, trade_id: "t-1", price: 100.5, size: 2, side: "buy" }],
        nextCursor: { ts: 1234, id: 1 },
        available: true,
      },
    });
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    const result = await adapter.readTradesSince(1000, 5000, null, 200);
    expect(result).toEqual({
      rows: [{ ts: 1234, tradeId: "t-1", price: 100.5, size: 2, side: "buy" }],
      nextCursor: { ts: 1234, id: 1 },
      available: true,
    });
  });

  // vpin-session's pollLive and volume-profile-engine's pollOpenPeriod both
  // branch on this flag (`if (!available) break;`). Reporting a storage
  // outage as available makes it indistinguishable from a market with no
  // trades, so the engines keep computing on partial data instead of
  // degrading. The dxFeed adapter has always propagated it.
  test("readTradesSince reports a storage outage as unavailable rather than as an empty window", async () => {
    const storageReader = fakeStorageReader({
      readRecentTradesResult: { rows: [], nextCursor: null, available: false },
    });
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    expect((await adapter.readTradesSince(1000, 5000, null, 200)).available).toBe(false);
  });

  test("readTradesSince reports a healthy reader as available", async () => {
    const storageReader = fakeStorageReader({
      readRecentTradesResult: { rows: [], nextCursor: null, available: true },
    });
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    expect((await adapter.readTradesSince(1000, 5000, null, 200)).available).toBe(true);
  });

  test("readTradesSince rejects an invalid fromTs/toTs pair before calling the reader", async () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    await expect(adapter.readTradesSince(5000, 1000, null, 200)).rejects.toThrow(/fromTs\/toTs/);
    expect(storageReader.readRecentTrades).not.toHaveBeenCalled();
  });

  test("readTradesSince allows a zero-width window (toTs === fromTs) -- a freshly rolled-over session polling immediately", async () => {
    const storageReader = fakeStorageReader();
    const adapter = createBinanceVolumeProfileAdapter(storageReader, "BTCUSDT", "SPOT");
    expect(await adapter.readTradesSince(5000, 5000, null, 200)).toEqual({ rows: [], nextCursor: null, available: true });
    expect(storageReader.readRecentTrades).not.toHaveBeenCalled();
  });

  test("rejects a storageReader missing either required method", async () => {
    expect(() => createBinanceVolumeProfileAdapter({ readVolumeProfile: () => {} }, "BTCUSDT", "SPOT")).toThrow(/storageReader/);
    expect(() => createBinanceVolumeProfileAdapter({ readRecentTrades: () => {} }, "BTCUSDT", "SPOT")).toThrow(/storageReader/);
  });
});

describe("createDxFeedVolumeProfileAdapter", () => {
  function fakeDxFeedStorageReader({ readTradesSinceResult, readVolumeProfileResult } = {}) {
    return {
      readTradesSince: jest.fn(() => readTradesSinceResult ?? { rows: [], nextCursor: null, available: true }),
      readVolumeProfile: jest.fn(() => readVolumeProfileResult ?? { buckets: [], available: true }),
    };
  }

  test("readVolumeProfile passes symbol/assetClass through unchanged, arguments in order", () => {
    const reader = fakeDxFeedStorageReader();
    const adapter = createDxFeedVolumeProfileAdapter(reader, "TSLA", "EQUITY");
    adapter.readVolumeProfile(1000, 2000, 100, 1);
    expect(reader.readVolumeProfile).toHaveBeenCalledWith("TSLA", "EQUITY", {
      fromTs: 1000, toTs: 2000, originPrice: 100, rowWidth: 1,
    });
  });

  test("readTradesSince narrows the lower bound to the cursor, never past toTs", () => {
    const reader = fakeDxFeedStorageReader();
    const adapter = createDxFeedVolumeProfileAdapter(reader, "TSLA", "EQUITY");
    adapter.readTradesSince(1000, 5000, { ts: 4000, id: 7 }, 200);
    expect(reader.readTradesSince).toHaveBeenCalledWith("TSLA", "EQUITY", {
      fromTs: 4000, toTs: 5000, cursor: { ts: 4000, id: 7 }, limit: 200,
    });
  });

  test("readTradesSince maps aggressor_side to lowercase buy/sell, UNDEFINED to null", async () => {
    const reader = fakeDxFeedStorageReader({
      readTradesSinceResult: {
        rows: [
          { event_time: 1000, provider_trade_id: 5, price: 100, size: 1, aggressor_side: "BUY" },
          { event_time: 1001, provider_trade_id: 6, price: 101, size: 2, aggressor_side: "SELL" },
          { event_time: 1002, provider_trade_id: null, price: 102, size: 3, aggressor_side: "UNDEFINED" },
        ],
        nextCursor: { ts: 1002, id: 3 },
        available: true,
      },
    });
    const adapter = createDxFeedVolumeProfileAdapter(reader, "TSLA", "EQUITY");
    const result = await adapter.readTradesSince(1000, 5000, null, 200);
    expect(result.rows).toEqual([
      { ts: 1000, tradeId: 5, price: 100, size: 1, side: "buy" },
      { ts: 1001, tradeId: 6, price: 101, size: 2, side: "sell" },
      { ts: 1002, tradeId: null, price: 102, size: 3, side: null },
    ]);
  });

  test("readTradesSince passes the real available flag through, unlike Binance's always-true adapter", async () => {
    const reader = fakeDxFeedStorageReader({
      readTradesSinceResult: { rows: [], nextCursor: null, available: false },
    });
    const adapter = createDxFeedVolumeProfileAdapter(reader, "TSLA", "EQUITY");
    expect((await adapter.readTradesSince(1000, 5000, null, 200)).available).toBe(false);
  });

  test("rejects a dxfeedStorageReader missing either required method", async () => {
    expect(() => createDxFeedVolumeProfileAdapter({ readVolumeProfile: () => {} }, "TSLA", "EQUITY")).toThrow(/dxfeedStorageReader/);
    expect(() => createDxFeedVolumeProfileAdapter({ readTradesSince: () => {} }, "TSLA", "EQUITY")).toThrow(/dxfeedStorageReader/);
  });
});

// A2.21 / L1L2-V2-057. vBucket sets VPIN's entire bucket cadence, and it was
// calibrated by two different code paths depending on provider: Binance had
// readDailyNotional and used a direct daily aggregate, dxFeed did not and fell
// back to reconstructing notional from readMinuteRollup as
// volume x (priceBucket x tickSize) -- a bucket-QUANTISED price, not the traded
// price. Numerically close on tick-aligned instruments, but one quantity
// computed two ways with only one path ever exercised per provider (Pattern V).
// Both adapters now expose the same primary path.
describe("vBucket calibration takes one path on both providers", () => {
  test("both provider adapters expose readDailyNotional, so neither relies on the rollup fallback", () => {
    const binance = createBinanceVolumeProfileAdapter(
      { readVolumeProfile: () => ({}), readRecentTrades: () => ({}) }, "BTCUSDT", "SPOT",
    );
    const dxfeed = createDxFeedVolumeProfileAdapter(
      { readVolumeProfile: () => ({}), readTradesSince: () => ({}) }, "/NQ", "FUTURE",
    );

    expect(typeof binance.readDailyNotional).toBe("function");
    expect(typeof dxfeed.readDailyNotional).toBe("function");
  });

  test("the dxFeed adapter forwards to the reader with its own identity, not a Binance-shaped call", async () => {
    let received = null;
    const dxfeed = createDxFeedVolumeProfileAdapter({
      readVolumeProfile: () => ({}),
      readTradesSince: () => ({}),
      readDailyNotional: (symbol, assetClass, window) => {
        received = { symbol, assetClass, window };
        return { rows: [{ dayTs: 0, notional: 5 }], available: true };
      },
    }, "/NQ", "FUTURE");

    const result = await dxfeed.readDailyNotional(10, 20);

    expect(received).toEqual({ symbol: "/NQ", assetClass: "FUTURE", window: { fromTs: 10, toTs: 20 } });
    expect(result).toEqual({ rows: [{ dayTs: 0, notional: 5 }], available: true });
  });

  test("it degrades to unavailable rather than throwing when the reader predates the method", async () => {
    const dxfeed = createDxFeedVolumeProfileAdapter(
      { readVolumeProfile: () => ({}), readTradesSince: () => ({}) }, "/NQ", "FUTURE",
    );

    expect(await dxfeed.readDailyNotional(10, 20)).toEqual({ rows: [], available: false });
  });
});

describe("historical profile transport selection", () => {
  test("only remote readers request compact direct historical profiles", () => {
    const binanceLocal = { readVolumeProfile: () => ({}), readRecentTrades: () => ({}) };
    const binanceRemote = { ...binanceLocal, remote: Object.freeze({ baseUrl: "http://host" }) };
    const dxfeedLocal = { readVolumeProfile: () => ({}), readTradesSince: () => ({}) };
    const dxfeedRemote = { ...dxfeedLocal, remote: Object.freeze({ baseUrl: "http://host" }) };
    expect(createBinanceVolumeProfileAdapter(binanceLocal, "BTCUSDT", "SPOT").prefersDirectHistoricalProfiles).toBe(false);
    expect(createBinanceVolumeProfileAdapter(binanceRemote, "BTCUSDT", "SPOT").prefersDirectHistoricalProfiles).toBe(true);
    expect(createDxFeedVolumeProfileAdapter(dxfeedLocal, "AAPL", "EQUITY").prefersDirectHistoricalProfiles).toBe(false);
    expect(createDxFeedVolumeProfileAdapter(dxfeedRemote, "AAPL", "EQUITY").prefersDirectHistoricalProfiles).toBe(true);
  });
});
