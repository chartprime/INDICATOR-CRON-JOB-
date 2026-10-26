const { createDxFeedBarAggregator, DEFAULT_INTERVAL_MS, DEFAULT_FINALITY_DELAY_MS } = require("../../../src/providers/dxfeed/dxfeed-bar-aggregator");

const MINUTE_MS = 60_000;
const BASE_MS = Math.floor(1_787_714_841_502 / MINUTE_MS) * MINUTE_MS;

function nqTrade(overrides = {}) {
  const trade = {
    symbol: "/NQZ26:XCME",
    assetClass: "FUTURE",
    tsExchange: BASE_MS + 1_000,
    price: 29219,
    size: 1,
    side: "sell",
    ...overrides,
  };
  return {
    ...trade,
    tradeId: overrides.tradeId ?? `${trade.symbol}:${trade.tsExchange}:${trade.price}:${trade.size}`,
  };
}

describe("createDxFeedBarAggregator", () => {
  test("finalizes ready instruments without closing another instrument whose first-minute seed is pending", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tradeId: "nq" }));
    aggregator.ingest(nqTrade({ symbol: "AAPL", assetClass: "EQUITY", tradeId: "aapl" }));
    const ready = aggregator.finalizeThrough(BASE_MS + 62_000, (symbol) => symbol !== "AAPL");
    expect(ready.map(({ symbol }) => symbol)).toEqual(["/NQZ26:XCME"]);
    expect(aggregator.currentBar("AAPL", "EQUITY")).not.toBeNull();
    expect(aggregator.finalizeThrough(BASE_MS + 62_000).map(({ symbol }) => symbol)).toEqual(["AAPL"]);
  });
  test("capacity exhaustion withdraws the bar instead of weakening dedupe or finalizing partial volume", () => {
    const aggregator = createDxFeedBarAggregator({ maxTradesPerBar: 2 });
    aggregator.ingest(nqTrade({ tradeId: "one" }));
    aggregator.ingest(nqTrade({ tradeId: "two" }));
    expect(aggregator.ingest(nqTrade({ tradeId: "one" })).dropReason).toBe("DUPLICATE_TRADE");
    expect(() => aggregator.ingest(nqTrade({ tradeId: "three" }))).toThrow("capacity exceeded");
    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toBeNull();
    expect(aggregator.finalizeThrough(BASE_MS + 120_000)).toEqual([]);
    expect(aggregator.ingest(nqTrade({ tradeId: "four" })).dropReason).toBe("LATE_AFTER_FINALITY");
    expect(aggregator.ingest(nqTrade({ tradeId: "next", tsExchange: BASE_MS + 60_001 })).liveBar.trade_count).toBe(1);
  });
  test("rejects a non-positive-integer intervalMs", () => {
    expect(() => createDxFeedBarAggregator({ intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => createDxFeedBarAggregator({ intervalMs: -1 })).toThrow(/intervalMs/);
    expect(() => createDxFeedBarAggregator({ intervalMs: 1.5 })).toThrow(/intervalMs/);
  });

  test("defaults to a 60s interval", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_FINALITY_DELAY_MS).toBe(2_000);
  });

  describe("ingest validation", () => {
    const aggregator = createDxFeedBarAggregator();
    test.each([
      ["symbol", { symbol: "" }],
      ["assetClass", { assetClass: "" }],
      ["assetClass", { assetClass: "CRYPTO" }],
      ["symbol", { symbol: "AAPL", assetClass: "FUTURE" }],
      ["tsExchange", { tsExchange: NaN }],
      ["tsExchange", { tsExchange: -1 }],
      ["price", { price: 0 }],
      ["price", { price: NaN }],
      ["size", { size: 0 }],
      ["side", { side: "sideways" }],
      ["tradeId", { tradeId: "" }],
    ])("rejects an invalid %s", (field, override) => {
      expect(() => aggregator.ingest(nqTrade(override))).toThrow(new RegExp(field));
    });
  });

  test("a single trade opens a live bar with OHLC all equal to that trade's price", () => {
    const aggregator = createDxFeedBarAggregator();
    const { closedBar, liveBar, dropped } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 500, price: 29219, size: 3 }));
    expect(closedBar).toBeNull();
    expect(dropped).toBe(false);
    expect(liveBar).toEqual({
      ts_open: BASE_MS,
      open: 29219,
      high: 29219,
      low: 29219,
      close: 29219,
      volume: 3,
      buy_volume: 0,
      sell_volume: 3,
      trade_count: 1,
      closed: false,
    });
  });

  test("multiple trades within the same minute update high/low/close/volume/trade_count correctly", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, price: 100, size: 2, side: "buy" }));
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 2_000, price: 90, size: 1, side: "sell" }));
    const { closedBar, liveBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 3_000, price: 110, size: 5, side: "buy" }));

    expect(closedBar).toBeNull();
    expect(liveBar).toEqual({
      ts_open: BASE_MS,
      open: 100,
      high: 110,
      low: 90,
      close: 110,
      volume: 8,
      buy_volume: 7,
      sell_volume: 1,
      trade_count: 3,
      closed: false,
    });
  });

  test("a bar with zero buy trades reports buy_volume: 0, not undefined", () => {
    const aggregator = createDxFeedBarAggregator();
    const { liveBar } = aggregator.ingest(nqTrade({ side: "sell" }));
    expect(liveBar.buy_volume).toBe(0);
    expect(Object.hasOwn(liveBar, "buy_volume")).toBe(true);
  });

  test("a trade crossing into the next minute closes the prior bucket and starts a fresh one", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, price: 100, size: 1, side: "buy" }));
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 50_000, price: 105, size: 1, side: "sell" }));

    const { closedBar, liveBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + MINUTE_MS + 5_000, price: 120, size: 4, side: "buy" }));

    expect(closedBar).toEqual({
      ts_open: BASE_MS,
      open: 100,
      high: 105,
      low: 100,
      close: 105,
      volume: 2,
      buy_volume: 1,
      sell_volume: 1,
      trade_count: 2,
      closed: true,
    });
    expect(liveBar).toEqual({
      ts_open: BASE_MS + MINUTE_MS,
      open: 120,
      high: 120,
      low: 120,
      close: 120,
      volume: 4,
      buy_volume: 4,
      sell_volume: 0,
      trade_count: 1,
      closed: false,
    });
  });

  test("a quiet minute in between produces no bar for it at all -- the next trade just rolls straight to its own bucket", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000 }));
    const { closedBar, liveBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 3 * MINUTE_MS + 1_000 }));

    expect(closedBar.ts_open).toBe(BASE_MS);
    expect(liveBar.ts_open).toBe(BASE_MS + 3 * MINUTE_MS);
  });

  test("two different symbols never share or corrupt each other's bucket state", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ symbol: "/NQZ26:XCME", price: 29219, size: 1 }));
    aggregator.ingest(nqTrade({ symbol: "/ESZ26:XCME", price: 5800, size: 1 }));

    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE").open).toBe(29219);
    expect(aggregator.currentBar("/ESZ26:XCME", "FUTURE").open).toBe(5800);
  });

  test("a late/out-of-order trade (tsExchange before the current bucket's ts_open) is dropped, not applied", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + MINUTE_MS + 1_000, price: 100, size: 1 }));
    const before = aggregator.currentBar("/NQZ26:XCME", "FUTURE");

    const { closedBar, liveBar, dropped } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 500, price: 99999, size: 999 }));

    expect(dropped).toBe(true);
    expect(closedBar).toBeNull();
    expect(liveBar).toEqual(before);
    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toEqual(before);
  });

  test("an unclassified print remains in OHLCV and makes directional volume unavailable", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ side: "buy", size: 2, tradeId: "known" }));
    const { liveBar } = aggregator.ingest(nqTrade({
      tsExchange: BASE_MS + 2_000,
      price: 29220,
      size: 3,
      side: null,
      tradeId: "unknown",
    }));
    expect(liveBar).toMatchObject({ close: 29220, volume: 5, buy_volume: null, trade_count: 2 });
  });

  test("later classified prints cannot make a partially unknown buy volume look complete", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ side: null, tradeId: "unknown" }));
    const { liveBar } = aggregator.ingest(nqTrade({
      tsExchange: BASE_MS + 2_000,
      side: "buy",
      tradeId: "known",
    }));
    expect(liveBar.buy_volume).toBeNull();
  });

  test("an out-of-order trade inside the current bucket still counts; open and close follow exchange time", () => {
    // FA-2 (report 57): a consolidated equity feed delivers ~3.4% of valid
    // AAPL trades behind a later-stamped one (up to 1.9 s). dxFeed's native
    // candles count them; dropping them lost 2.4-7.2% of RTH volume per
    // minute and, once, the minute's low.
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 20_000, price: 100, size: 2, tradeId: "later" }));
    const result = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 10_000, price: 90, size: 3, tradeId: "earlier" }));
    expect(result).toMatchObject({ dropped: false, dropReason: null });
    expect(result.liveBar).toMatchObject({ open: 90, high: 100, low: 90, close: 100, volume: 5, trade_count: 2 });
  });

  test("an out-of-order trade that is neither first nor last only adds volume and extremes", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 10_000, price: 100, size: 1, tradeId: "a" }));
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 30_000, price: 101, size: 1, tradeId: "c" }));
    const result = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 20_000, price: 120, size: 4, tradeId: "b" }));
    expect(result.liveBar).toMatchObject({ open: 100, high: 120, low: 100, close: 101, volume: 6, trade_count: 3 });
  });

  test("orders same-millisecond TimeAndSale prints by nanosecond then sequence, not packet arrival order", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({
      tsExchange: BASE_MS + 10_000,
      timeNanoPart: 500,
      sequence: 2,
      price: 100,
      tradeId: "later",
    }));

    const result = aggregator.ingest(nqTrade({
      tsExchange: BASE_MS + 10_000,
      timeNanoPart: 500,
      sequence: 1,
      price: 90,
      tradeId: "earlier",
    }));

    expect(result).toMatchObject({ dropped: false, dropReason: null });
    expect(result.liveBar).toMatchObject({ open: 90, high: 100, low: 90, close: 100, trade_count: 2 });
  });

  test("rejects a partial or invalid precise ordering tuple", () => {
    const aggregator = createDxFeedBarAggregator();
    expect(() => aggregator.ingest(nqTrade({ timeNanoPart: 1 }))).toThrow(/supplied together/);
    expect(() => aggregator.ingest(nqTrade({ timeNanoPart: -1, sequence: 1 }))).toThrow(/non-negative safe integers/);
  });

  test("a duplicate trade id is idempotently dropped", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tradeId: "same" }));
    const result = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 2_000, price: 999, tradeId: "same" }));
    expect(result).toMatchObject({ dropped: true, dropReason: "DUPLICATE_TRADE" });
    expect(result.liveBar).toMatchObject({ volume: 1, trade_count: 1 });
  });

  test("a late trade never resurrects or revises an already-closed bucket", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, price: 100, size: 1 }));
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + MINUTE_MS + 1_000, price: 200, size: 1 }));

    const { closedBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 500, price: 999, size: 1 }));

    expect(closedBar).toBeNull();
  });

  test("currentBar is read-only and does not affect subsequent ingests", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade());
    aggregator.currentBar("/NQZ26:XCME", "FUTURE");
    aggregator.currentBar("/NQZ26:XCME", "FUTURE");
    const { liveBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 2_000, price: 1, size: 1 }));
    expect(liveBar.trade_count).toBe(2);
  });

  test("currentBar returns null for a symbol/assetClass that has never been ingested", () => {
    const aggregator = createDxFeedBarAggregator();
    expect(aggregator.currentBar("TSLA", "EQUITY")).toBeNull();
  });

  test("reset() clears exactly the targeted pair, leaving others untouched", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ symbol: "/NQZ26:XCME" }));
    aggregator.ingest(nqTrade({ symbol: "/ESZ26:XCME" }));

    aggregator.reset("/NQZ26:XCME", "FUTURE");

    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toBeNull();
    expect(aggregator.currentBar("/ESZ26:XCME", "FUTURE")).not.toBeNull();
  });

  test("resetting an unknown pair is a no-op, not an error", () => {
    const aggregator = createDxFeedBarAggregator();
    expect(() => aggregator.reset("MSFT", "EQUITY")).not.toThrow();
  });

  test("after reset(), the next trade for that pair opens a brand-new bucket", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, price: 100, size: 5 }));
    aggregator.reset("/NQZ26:XCME", "FUTURE");

    const { closedBar, liveBar } = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 2_000, price: 200, size: 1 }));

    expect(closedBar).toBeNull();
    expect(liveBar).toEqual({
      ts_open: BASE_MS,
      open: 200,
      high: 200,
      low: 200,
      close: 200,
      volume: 1,
      buy_volume: 0,
      sell_volume: 1,
      trade_count: 1,
      closed: false,
    });
  });

  test("real captured /NQ TimeAndSale-derived trade (verify-dxfeed-extended-probe-2026-08-26.log) aggregates without error", () => {
    const aggregator = createDxFeedBarAggregator();
    const real = { symbol: "/NQZ26:XCME", assetClass: "FUTURE", tsExchange: 1_787_714_841_502, price: 29219, size: 1, side: "sell", tradeId: "/NQZ26:XCME:1787714841502:0:66860" };
    const { closedBar, liveBar, dropped } = aggregator.ingest(real);
    expect(dropped).toBe(false);
    expect(closedBar).toBeNull();
    expect(liveBar.open).toBe(29219);
    expect(liveBar.buy_volume).toBe(0);
    expect(liveBar.ts_open).toBe(Math.floor(1_787_714_841_502 / MINUTE_MS) * MINUTE_MS);
  });

  test("a synthetic equities sequence (Trade+tickDirection-derived side) aggregates the same way as a futures one", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest({ symbol: "AAPL", assetClass: "EQUITY", tsExchange: BASE_MS + 1_000, price: 230.5, size: 10, side: "buy", tradeId: "a" });
    const { liveBar } = aggregator.ingest({ symbol: "AAPL", assetClass: "EQUITY", tsExchange: BASE_MS + 2_000, price: 229.9, size: 5, side: "sell", tradeId: "b" });

    expect(liveBar).toEqual({
      ts_open: BASE_MS,
      open: 230.5,
      high: 230.5,
      low: 229.9,
      close: 229.9,
      volume: 15,
      buy_volume: 10,
      sell_volume: 5,
      trade_count: 2,
      closed: false,
    });
  });

  test("supports a custom intervalMs (not hardcoded to 60s)", () => {
    const aggregator = createDxFeedBarAggregator({ intervalMs: 5_000 });
    aggregator.ingest(nqTrade({ tsExchange: 1_000, price: 1, size: 1 }));
    const { closedBar, liveBar } = aggregator.ingest(nqTrade({ tsExchange: 6_000, price: 2, size: 1 }));
    expect(closedBar.ts_open).toBe(0);
    expect(liveBar.ts_open).toBe(5_000);
  });

  test("drops a syntactically valid timestamp beyond the live future-skew policy before a bucket is created", () => {
    const aggregator = createDxFeedBarAggregator();
    const result = aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 180_001, nowMs: BASE_MS }));
    expect(result).toEqual({ closedBar: null, liveBar: null, dropped: true, dropReason: "EVENT_TIME_TOO_FAR_IN_FUTURE" });
    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toBeNull();
  });

  test("finalizes a quiet completed bucket exactly once after its lateness watermark, without a next trade", () => {
    const aggregator = createDxFeedBarAggregator({ finalityDelayMs: 2_000 });
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, price: 100, size: 2, side: "buy" }));
    expect(aggregator.finalizeThrough(BASE_MS + MINUTE_MS + 1_999)).toEqual([]);
    const finalized = aggregator.finalizeThrough(BASE_MS + MINUTE_MS + 2_000);
    expect(finalized).toEqual([{
      symbol: "/NQZ26:XCME", assetClass: "FUTURE", bar: {
        ts_open: BASE_MS, open: 100, high: 100, low: 100, close: 100, volume: 2, buy_volume: 2, sell_volume: 0, trade_count: 1, closed: true,
      },
    }]);
    expect(aggregator.finalizeThrough(BASE_MS + MINUTE_MS + 2_000)).toEqual([]);
    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toBeNull();
  });

  test("drops a late print for a bucket already finalized by time, rather than reopening or duplicating it", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, nowMs: BASE_MS + 1_000 }));
    aggregator.finalizeThrough(BASE_MS + MINUTE_MS + DEFAULT_FINALITY_DELAY_MS);
    expect(aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 50_000, nowMs: BASE_MS + MINUTE_MS + DEFAULT_FINALITY_DELAY_MS }))).toEqual({
      closedBar: null, liveBar: null, dropped: true, dropReason: "LATE_AFTER_FINALITY",
    });
  });

  test("seeds finality from persisted candle history so replay overlap is discarded before producing closed bars", () => {
    const aggregator = createDxFeedBarAggregator();
    aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 1_000, tradeId: "stale-open" }));

    expect(aggregator.seedFinalizedThrough("/NQZ26:XCME", "FUTURE", BASE_MS + MINUTE_MS)).toBe(BASE_MS + MINUTE_MS);
    expect(aggregator.currentBar("/NQZ26:XCME", "FUTURE")).toBeNull();
    expect(aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 30_000, tradeId: "stale-replay" }))).toEqual({
      closedBar: null, liveBar: null, dropped: true, dropReason: "LATE_AFTER_FINALITY",
    });
    expect(aggregator.ingest(nqTrade({ tsExchange: BASE_MS + 2 * MINUTE_MS, tradeId: "new-live" })).dropped).toBe(false);
  });

  test("a persisted finality watermark is monotonic and rejects malformed or ungoverned inputs", () => {
    const aggregator = createDxFeedBarAggregator();
    expect(aggregator.seedFinalizedThrough("AAPL", "EQUITY", BASE_MS + MINUTE_MS)).toBe(BASE_MS + MINUTE_MS);
    expect(aggregator.seedFinalizedThrough("AAPL", "EQUITY", BASE_MS)).toBe(BASE_MS + MINUTE_MS);
    expect(() => aggregator.seedFinalizedThrough("AAPL", "EQUITY", BASE_MS + 1)).toThrow(/aligned/);
    expect(() => aggregator.seedFinalizedThrough("DOGE", "EQUITY", BASE_MS)).toThrow(/unsupported/);
  });
});
