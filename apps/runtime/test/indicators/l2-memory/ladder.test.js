"use strict";

const { createLevelLedger, DEFAULT_LADDER_DEPTH, MAX_LADDER_DEPTH } = require("../../../src/indicators/l2-memory/level-ledger");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createHeavyReader } = require("../../../src/indicators/l2-memory/heavy-reader");

const T = 1_780_000_000_000;

describe("MBP-N ladder (report 61 P3d)", () => {
  test("banded records give back every exact price inside them, best first, to the requested depth", () => {
    const engine = createMemoryEngine({ tickSize: 0.1, clusterTicks: 5 });
    engine.apply({ kind: "book",
      ts: T,
      status: "READY",
      book: {
        bids: [["100.0", "2"], ["99.9", "3"], ["99.3", "4"], ["99.4", "1.5"], ["98.2", "7"]],
        asks: [["100.1", "1"], ["100.4", "2"], ["100.6", "5"], ["101.9", "9"]],
      },
    });
    expect(engine.ladder({ side: "bid", depth: 4 })).toEqual([[100, 2], [99.9, 3], [99.4, 1.5], [99.3, 4]]);
    expect(engine.ladder({ side: "ask", depth: 10 })).toEqual([[100.1, 1], [100.4, 2], [100.6, 5], [101.9, 9]]);
    expect(engine.ladder({ side: "bid", depth: 1 })).toEqual([[100, 2]]);
    expect(engine.ladder({ side: "bid", depth: 3 })).toEqual([[100, 2], [99.9, 3], [99.4, 1.5]]);
  });

  test("a level that empties leaves the ladder, and the next price moves up", () => {
    const engine = createMemoryEngine({ tickSize: 1, clusterTicks: 1 });
    engine.apply({ kind: "book", ts: T, status: "READY", book: { bids: [["100", "5"], ["98", "2"], ["95", "1"]], asks: [["101", "3"]] } });
    engine.apply({ kind: "book", ts: T + 100, status: "READY", book: { bestBid: "98", bestAsk: "101" }, delta: { bids: [["100", "0"]], asks: [] } });
    expect(engine.ladder({ side: "bid", depth: 3 })).toEqual([[98, 2], [95, 1]]);
  });

  test("keys that are not whole numbers fall back to a sorted pass with the same answer", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: T, bids: [["99.75", "8"], ["99.5", "1"], ["98.25", "2"], ["97", "3"]], asks: [["100.5", "4"], ["101.75", "5"]] });
    ledger.observeQuote({ ts: T, bestBid: "99.5", bestAsk: "100.5" });
    expect(ledger.ladder({ side: "bid", depth: 2 })).toEqual([[99.5, 1], [98.25, 2]]);
    expect(ledger.ladder({ side: "bid", depth: 5 })).toEqual([[99.5, 1], [98.25, 2], [97, 3]]);
    expect(ledger.ladder({ side: "ask" })).toEqual([[100.5, 4], [101.75, 5]]);
  });

  test("levels beyond the best price on the wrong side of the book are not part of the ladder", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: T, bids: [["101", "9"], ["99", "1"], ["98", "2"]], asks: [["100", "4"]] });
    ledger.observeQuote({ ts: T, bestBid: "99", bestAsk: "100" });
    expect(ledger.ladder({ side: "bid", depth: 5 })).toEqual([[99, 1], [98, 2]]);
  });

  test("an empty side is an empty ladder, the heavy reader passes it through, and the depth is bounded", () => {
    const engine = createMemoryEngine({ tickSize: 1, clusterTicks: 1 });
    engine.apply({ kind: "book", ts: T, status: "READY", book: { bids: [["100", "5"]], asks: [] } });
    expect(engine.ladder({ side: "ask", depth: 3 })).toEqual([]);
    expect(createHeavyReader({ engine }).ladder({ side: "bid", depth: 2 })).toEqual([[100, 5]]);
    expect(DEFAULT_LADDER_DEPTH).toBe(50);
    expect(() => engine.ladder({ side: "bid", depth: 0 })).toThrow(/ladder depth/);
    expect(() => engine.ladder({ side: "bid", depth: MAX_LADDER_DEPTH + 1 })).toThrow(/ladder depth/);
    expect(() => engine.ladder({ side: "mid", depth: 1 })).toThrow(/side/);
    expect(Object.isFrozen(engine.ladder({ side: "bid" }))).toBe(true);
  });
});
