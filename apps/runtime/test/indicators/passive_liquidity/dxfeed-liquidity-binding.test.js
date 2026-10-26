const {
  createDxFeedLiquidityBinding,
  dxfeedLiquidityOptionsFromEnv,
  levelDelta,
  notionalMultiplierFor,
  DEFAULT_COALESCE_MS,
  DEFAULT_FUTURE_ROW_TICKS,
  DEFAULT_EQUITY_ROW_TICKS,
} = require("../../../src/indicators/passive_liquidity/dxfeed-liquidity-binding");
const { createDxFeedOrderBookAssembler } = require("../../../src/providers/dxfeed/dxfeed-book-assembler");

const T = 1_800_000_000_000;
const NQ = { assetClass: "FUTURE", symbol: "/NQZ26:XCME", tickSize: 0.25 };
const AAPL = { assetClass: "EQUITY", symbol: "AAPL", tickSize: 0.01 };

const ready = (bids, asks, lastUpdateId = 1) => ({ status: "READY", book: { bids, asks, lastUpdateId } });

function bidAt(engine, price) {
  return engine.topLevels({ limit: 50 }).bids.find((level) => Math.abs(level.price - price) < 1e-9) ?? null;
}

describe("the two dxFeed doors into the engine (report 61 P4f)", () => {
  it("share one 250 ms batching window and name their different batching policies until J2 converges them", () => {
    const binding = require("../../../src/indicators/passive_liquidity/dxfeed-liquidity-binding");
    const replay = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
    const shared = require("../../../src/indicators/l2-memory/dxfeed-book-frames");
    expect(DEFAULT_COALESCE_MS).toBe(250);
    expect(replay.DEFAULT_COALESCE_MS).toBe(DEFAULT_COALESCE_MS);
    expect(shared.DXFEED_COALESCE_MS).toBe(DEFAULT_COALESCE_MS);
    expect(binding.BATCHING).toBe(shared.DXFEED_BATCHING.LIVE);
    expect(replay.BATCHING).toBe(shared.DXFEED_BATCHING.REPLAY);
    expect(binding.BATCHING).not.toBe(replay.BATCHING);
    expect(replay.BOOK_MODES).toEqual(["full", "sparse"]);
  });

  it("builds a change frame's book from the assembler: the whole book in full mode, the best prices in sparse", () => {
    const { changeBook, hasChanges, seedDelta } = require("../../../src/indicators/l2-memory/dxfeed-book-frames");
    const assembler = { getState: () => ({ book: { bids: [[100, 1]], asks: [[101, 2]] } }), getBestPrices: () => ({ bestBid: 100, bestAsk: 101 }) };
    expect(changeBook(assembler, "full")).toEqual({ bids: [[100, 1]], asks: [[101, 2]] });
    expect(changeBook(assembler, "sparse")).toEqual({ bestBid: 100, bestAsk: 101 });
    expect(hasChanges({ bids: [], asks: [] })).toBe(false);
    expect(hasChanges({ bids: [], asks: [[101, 0]] })).toBe(true);
    expect(seedDelta({ bids: [[100, 1]], asks: [], lastUpdateId: 3 })).toEqual({ bids: [[100, 1]], asks: [] });
  });
});

describe("levelDelta", () => {
  it("reports changed sizes, arrivals, and departures as zero, over best-first sides", () => {
    // Bids descend.
    expect(levelDelta([[101, 5], [100, 3], [99, 1]], [[101, 5], [100, 4], [98, 2]], true)).toEqual([[100, 4], [99, 0], [98, 2]]);
    // Asks ascend.
    expect(levelDelta([[102, 1], [103, 2]], [[101.5, 7], [103, 2], [104, 1]], false)).toEqual([[101.5, 7], [102, 0], [104, 1]]);
    // From nothing, and to nothing.
    expect(levelDelta([], [[100, 1]], true)).toEqual([[100, 1]]);
    expect(levelDelta([[100, 1]], [], true)).toEqual([[100, 0]]);
    expect(levelDelta([[100, 1]], [[100, 1]], true)).toEqual([]);
  });
});

describe("notionalMultiplierFor", () => {
  it("knows the index futures' dollars per point and treats everything else as one", () => {
    expect(notionalMultiplierFor("FUTURE", "/NQZ26:XCME")).toBe(20);
    expect(notionalMultiplierFor("FUTURE", "/ESZ26:XCME")).toBe(50);
    expect(notionalMultiplierFor("FUTURE", "/ZBU26:XCBT")).toBe(1);
    expect(notionalMultiplierFor("EQUITY", "AAPL")).toBe(1);
  });
});

describe("createDxFeedLiquidityBinding", () => {
  it("takes the tick from the catalog when the instrument has none, and leaves out what it cannot size", () => {
    const log = jest.fn();
    const binding = createDxFeedLiquidityBinding({ instruments: [{ assetClass: "EQUITY", symbol: "AAPL" }, { assetClass: "EQUITY", symbol: "ZZZZ" }], log });
    expect(binding.getEngine("EQUITY", "AAPL").tickSize).toBe(0.01);
    expect(binding.getEngine("EQUITY", "ZZZZ")).toBeNull();
    expect(binding.instruments()).toEqual([{ assetClass: "EQUITY", symbol: "AAPL" }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ZZZZ"));
    expect(() => createDxFeedLiquidityBinding({ instruments: null })).toThrow(/instruments/);
    expect(DEFAULT_COALESCE_MS).toBe(250);
  });

  it("gives the publisher an engine per instrument, keyed by asset class and symbol, with its multiplier", () => {
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ, AAPL], coalesceMs: 0 });
    expect(binding.getEngine("FUTURE", "/NQZ26:XCME")).not.toBeNull();
    expect(binding.getEngine("FUTURE", "/NQZ26:XCME").tickSize).toBe(0.25);
    expect(binding.getEngine("EQUITY", "AAPL").tickSize).toBe(0.01);
    expect(binding.getEngine("EQUITY", "TSLA")).toBeNull();
    expect(binding.notionalMultiplier("FUTURE", "/NQZ26:XCME")).toBe(20);
    expect(binding.notionalMultiplier("EQUITY", "AAPL")).toBe(1);
    expect(binding.notionalMultiplier("EQUITY", "TSLA")).toBe(1);
    expect(binding.instruments()).toEqual([{ assetClass: "FUTURE", symbol: "/NQZ26:XCME" }, { assetClass: "EQUITY", symbol: "AAPL" }]);
  });

  it("seeds the engine from the first READY book and feeds the level changes after it", () => {
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], coalesceMs: 0, now: () => T });
    const engine = binding.getEngine("FUTURE", "/NQZ26:XCME");
    expect(engine.seeded).toBe(false);
    let state = ready([[100.25, 5], [100, 3]], [[100.5, 4], [100.75, 6]]);
    expect(binding.noteBook("FUTURE", "/NQZ26:XCME", () => state, T)).toBe(true);
    expect(engine.seeded).toBe(true);
    expect(engine.live).toBe(true);
    expect(engine.stats.seeds).toBe(1);
    expect(bidAt(engine, 100.25)).toMatchObject({ size: 5, seeded: true });
    // A level grows, one leaves, one arrives.
    state = ready([[100.25, 8], [99.75, 2]], [[100.5, 4], [100.75, 6]], 2);
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => state, T + 300);
    expect(engine.stats.deltas).toBe(1);
    expect(bidAt(engine, 100.25)).toMatchObject({ size: 8 });
    expect(bidAt(engine, 100)).toBeNull();
    expect(bidAt(engine, 99.75)).toMatchObject({ size: 2 });
    // The same book again is not a delta, only a quote observation.
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => state, T + 600);
    expect(engine.stats.deltas).toBe(1);
  });

  it("lays a print with an aggressor side against the level it hit, so the shrink reads as traded", () => {
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], coalesceMs: 0, now: () => T });
    const engine = binding.getEngine("FUTURE", "/NQZ26:XCME");
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ready([[100.25, 5], [100, 3]], [[100.5, 4]]), T);
    expect(binding.onTrade("FUTURE", "/NQZ26:XCME", { ts: T + 100, price: 100.25, size: 2, side: "sell" })).toBe(true);
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ready([[100.25, 3], [100, 3]], [[100.5, 4]], 2), T + 200);
    expect(engine.stats.trades).toBe(1);
    expect(bidAt(engine, 100.25)).toMatchObject({ size: 3, traded: 2, cancelled: 0 });
    // No aggressor, no price, unknown instrument: nothing to attribute.
    expect(binding.onTrade("FUTURE", "/NQZ26:XCME", { ts: T + 300, price: 100.25, size: 1, side: null })).toBe(false);
    expect(binding.onTrade("FUTURE", "/NQZ26:XCME", { ts: T + 300, price: 0, size: 1, side: "buy" })).toBe(false);
    expect(binding.onTrade("EQUITY", "TSLA", { ts: T + 300, price: 100, size: 1, side: "buy" })).toBe(false);
    expect(engine.stats.trades).toBe(1);
  });

  it("marks the engine unavailable while the book is not READY and reconciles on the next READY book", () => {
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], coalesceMs: 0, now: () => T });
    const engine = binding.getEngine("FUTURE", "/NQZ26:XCME");
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ready([[100.25, 5]], [[100.5, 4]]), T);
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ({ status: "BUFFERING" }), T + 100);
    expect(engine.seeded).toBe(true);
    expect(engine.live).toBe(false);
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ready([[100.25, 7]], [[100.5, 4]], 3), T + 200);
    expect(engine.live).toBe(true);
    expect(engine.stats.resyncs).toBe(1);
    expect(bidAt(engine, 100.25)).toMatchObject({ size: 7 });
    // An explicit mark (session ended, assembler rebuilt) does the same.
    binding.markUnavailable();
    expect(engine.live).toBe(false);
    binding.noteBook("FUTURE", "/NQZ26:XCME", () => ready([[100.25, 7]], [[100.5, 4]], 4), T + 300);
    expect(engine.live).toBe(true);
    expect(engine.stats.resyncs).toBe(2);
  });

  it("coalesces a burst of order events into one look at the book, at the burst's last exchange time", () => {
    const timers = [];
    const setTimer = (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    };
    const clearTimer = jest.fn();
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], setTimer, clearTimer, now: () => T + 5_000 });
    const engine = binding.getEngine("FUTURE", "/NQZ26:XCME");
    const getState = jest.fn(() => ready([[100.25, 5]], [[100.5, 4]]));
    binding.noteBook("FUTURE", "/NQZ26:XCME", getState, T);
    binding.noteBook("FUTURE", "/NQZ26:XCME", getState, T + 40);
    binding.noteBook("FUTURE", "/NQZ26:XCME", getState, T + 80);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(DEFAULT_COALESCE_MS);
    expect(getState).not.toHaveBeenCalled();
    timers[0].fn();
    expect(getState).toHaveBeenCalledTimes(1);
    expect(engine.seeded).toBe(true);
    expect(engine.snapshot().ts).toBe(T + 80);
    // A later burst schedules again.
    binding.noteBook("FUTURE", "/NQZ26:XCME", getState, T + 500);
    expect(timers).toHaveLength(2);
    binding.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(binding.noteBook("FUTURE", "/NQZ26:XCME", getState, T + 900)).toBe(false);
  });

  it("fixes the heatmap row at one tick on futures and equities unless told otherwise, and reads the knobs from the environment", () => {
    expect(DEFAULT_FUTURE_ROW_TICKS).toBe(1);
    expect(DEFAULT_EQUITY_ROW_TICKS).toBe(1);
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ, AAPL] });
    expect(binding.rowClusters("FUTURE", "/NQZ26:XCME")).toBe(1);
    expect(binding.rowClusters("EQUITY", "AAPL")).toBe(1);
    expect(binding.rowClusters("EQUITY", "TSLA")).toBeNull();
    const wide = createDxFeedLiquidityBinding({ instruments: [NQ, AAPL], futureRowTicks: 4, equityRowTicks: 2 });
    expect(wide.rowClusters("FUTURE", "/NQZ26:XCME")).toBe(4);
    expect(wide.rowClusters("EQUITY", "AAPL")).toBe(2);
    expect(() => createDxFeedLiquidityBinding({ instruments: [NQ], futureRowTicks: 0 })).toThrow(/futureRowTicks/);
    expect(dxfeedLiquidityOptionsFromEnv({})).toEqual({});
    expect(dxfeedLiquidityOptionsFromEnv({ L2_HEATMAP_FUTURE_ROW_TICKS: "2", L2_HEATMAP_EQUITY_ROW_TICKS: "3", L2_HEATMAP_DXFEED_DIFF_MS: "100" })).toEqual({ futureRowTicks: 2, equityRowTicks: 3, coalesceMs: 100 });
    expect(dxfeedLiquidityOptionsFromEnv({ L2_HEATMAP_FUTURE_ROW_TICKS: "0", L2_HEATMAP_EQUITY_ROW_TICKS: "x", L2_HEATMAP_DXFEED_DIFF_MS: "-5" })).toEqual({});
  });

  it("swallows a failing book state instead of taking the server down", () => {
    const log = jest.fn();
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], coalesceMs: 0, log });
    expect(binding.noteBook("FUTURE", "/NQZ26:XCME", () => { throw new Error("assembler exploded"); }, T)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("assembler exploded"));
    expect(binding.getEngine("FUTURE", "/NQZ26:XCME").seeded).toBe(false);
  });
});

describe("createDxFeedLiquidityBinding fed by the assembler itself", () => {
  it("seeds the engine from the whole book once, then feeds it only the levels that changed; a fresh snapshot resyncs", () => {
    const binding = createDxFeedLiquidityBinding({ instruments: [NQ], coalesceMs: 0, now: () => T });
    const real = createDxFeedOrderBookAssembler();
    // The assembler is frozen, so count the whole-book reads through a thin wrapper.
    const getState = jest.fn(() => real.getState());
    const assembler = { ...real, getState };
    const order = (index, price, size, side, flags = 0, action = "NEW") => real.applyEvent({ payload: { index, eventFlags: flags, action, price, size, side, scope: "ORDER", source: "GLBX" } });
    order("1", 100, 5, "BUY", 4);
    order("2", 100.25, 4, "SELL", 8);
    // First look: seed from the whole book.
    expect(binding.noteBook("FUTURE", "/NQZ26:XCME", assembler, T)).toBe(true);
    const engine = binding.getEngine("FUTURE", "/NQZ26:XCME");
    expect(engine.seeded).toBe(true);
    expect(getState).toHaveBeenCalledTimes(1);
    // The bid thins and a new ask appears: only those two levels travel, no sorted book.
    order("1", 100, 3, "BUY", 0, "REPLACE");
    order("3", 100.5, 2, "SELL");
    binding.noteBook("FUTURE", "/NQZ26:XCME", assembler, T + 250);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(bidAt(engine, 100).size).toBe(3);
    expect(engine.topLevels({ limit: 50 }).asks.find((level) => Math.abs(level.price - 100.5) < 1e-9).size).toBe(2);
    expect(engine.live).toBe(true);
    // Nothing changed: nothing applied, still no sorted book.
    binding.noteBook("FUTURE", "/NQZ26:XCME", assembler, T + 500);
    expect(getState).toHaveBeenCalledTimes(1);
    // A fresh snapshot replaced the book: reconciled against the whole book again.
    order("9", 101, 8, "BUY", 12);
    binding.noteBook("FUTURE", "/NQZ26:XCME", assembler, T + 750);
    expect(getState).toHaveBeenCalledTimes(2);
    expect(bidAt(engine, 101).size).toBe(8);
    expect(bidAt(engine, 100)?.size ?? 0).toBe(0);
    // A source that is neither a function nor an assembler is refused.
    expect(binding.noteBook("FUTURE", "/NQZ26:XCME", { nope: true }, T + 1000)).toBe(false);
  });
});
