const { createFlowWindow } = require("../../../src/indicators/l2-memory/flow-window");

describe("flow-window", () => {
  test("validates inputs and time order", () => {
    expect(() => createFlowWindow({ windowMs: -1 })).toThrow(/windowMs/);
    const f = createFlowWindow();
    expect(() => f.addTrade({ ts: 1, side: "maker", size: 1, price: 1 })).toThrow(/side/);
    expect(() => f.addTrade({ ts: 1, side: "buy", size: 0, price: 1 })).toThrow(/size/);
    expect(() => f.addTrade({ ts: 1, side: "buy", size: 1, price: 0 })).toThrow(/price/);
    f.addTrade({ ts: 1_000, side: "buy", size: 1, price: 100 });
    expect(() => f.addQuote({ ts: 999, bestBid: 99, bestAsk: 101 })).toThrow(/time order/);
    expect(() => f.summary({ ts: 1_000, lookbackMs: 0 })).toThrow(/lookbackMs/);
  });

  test("summarises volume by aggressor side and the price move over a trailing window", () => {
    const f = createFlowWindow();
    f.addQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" }); // mid 100
    f.addTrade({ ts: 1_500, side: "sell", size: "2", price: "99" });
    f.addTrade({ ts: 2_500, side: "sell", size: "3", price: "98" });
    f.addQuote({ ts: 2_600, bestBid: "97.0", bestAsk: "99.0" }); // mid 98
    f.addTrade({ ts: 3_000, side: "buy", size: "1", price: "99" });
    f.addQuote({ ts: 3_100, bestBid: "98.0", bestAsk: "100.0" }); // mid 99

    const all = f.summary({ ts: 3_200, lookbackMs: 3_000 }); // window (200, 3200]
    expect(all).toMatchObject({ buyVolume: 1, sellVolume: 5, delta: -4, tradeCount: 3, priceStart: null, priceEnd: 99, priceMove: null });

    const recent = f.summary({ ts: 3_200, lookbackMs: 1_000 }); // window (2200, 3200]
    expect(recent).toMatchObject({ buyVolume: 1, sellVolume: 3, delta: -2, tradeCount: 2, priceStart: 100, priceEnd: 99, priceMove: -1 });

    const exactEdge = f.summary({ ts: 2_500, lookbackMs: 1_000 }); // window (1500, 2500]: excludes the 1500 trade
    expect(exactEdge).toMatchObject({ sellVolume: 3, tradeCount: 1, priceStart: 100, priceEnd: 100, priceMove: 0 });
  });

  test("one-sided quotes fall back to the side that exists; empty quotes are ignored", () => {
    const f = createFlowWindow();
    f.addQuote({ ts: 1_000, bestBid: null, bestAsk: "101.0" });
    f.addQuote({ ts: 2_000, bestBid: null, bestAsk: null });
    expect(f.summary({ ts: 2_000, lookbackMs: 500 })).toMatchObject({ priceStart: 101, priceEnd: 101, priceMove: 0 });
    expect(f.stats().quotes).toBe(1);
  });

  test("prune forgets old trades and keeps one quote before the window", () => {
    const f = createFlowWindow({ windowMs: 10_000 });
    f.addQuote({ ts: 1_000, bestBid: 99, bestAsk: 101 });
    f.addTrade({ ts: 2_000, side: "buy", size: 1, price: 100 });
    f.addQuote({ ts: 3_000, bestBid: 100, bestAsk: 102 });
    f.addTrade({ ts: 20_000, side: "sell", size: 4, price: 100 });
    f.prune(25_000); // cutoff 15_000
    expect(f.stats()).toEqual({ trades: 1, quotes: 1, lastTs: 20_000 });
    expect(f.summary({ ts: 25_000, lookbackMs: 10_000 })).toMatchObject({ sellVolume: 4, buyVolume: 0, priceStart: 101, priceEnd: 101 });
  });
});
