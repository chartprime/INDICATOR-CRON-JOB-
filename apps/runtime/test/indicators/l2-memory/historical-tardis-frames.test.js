"use strict";

const { createHistoricalTardisFrames } = require("../../../src/indicators/l2-memory/historical-tardis-frames");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

const T = 1_785_888_000_000_000n;

function row(offset, snapshot, side, price, amount, overrides = {}) {
  return { exchange: "binance", symbol: "BTCUSDT", timestamp: String(T + BigInt(offset)),
    local_timestamp: String(T + BigInt(offset) + 100n), is_snapshot: String(snapshot), side,
    price: String(price), amount: String(amount), ...overrides };
}

function send(source, rows) {
  return [...rows.flatMap((item) => source.push(item)), ...source.flush()];
}

describe("historical Tardis grouped input frames", () => {
  test("one opening snapshot group seeds once, then one timestamp group creates one delta", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    const transitions = send(source, [
      row(0, true, "bid", 100, 5), row(0, true, "bid", 99, 2),
      row(0, true, "ask", 101, 3), row(0, true, "ask", 102, 4),
      row(10, false, "ask", 101, 2), row(10, false, "bid", 100, 7),
    ]);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ restartEngine: true, reason: "SOURCE_SNAPSHOT", eventUs: String(T) });
    expect(transitions[0].frames[1]).toMatchObject({ kind: "book", book: {
      bids: [["100", "5"], ["99", "2"]], asks: [["101", "3"], ["102", "4"]],
    } });
    expect(transitions[1]).toMatchObject({ restartEngine: false, reason: null });
    expect(transitions[1].frames[0]).toMatchObject({ kind: "book", book: { bestBid: "100", bestAsk: "101" },
      delta: { bids: [["100", "7"]], asks: [["101", "2"]] } });
    const engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 2 });
    for (const transition of transitions) for (const frame of transition.frames) engine.apply(frame);
    expect(engine.ladder({ side: "bid", depth: 2 })).toEqual([[100, 7], [99, 2]]);
    expect(engine.ladder({ side: "ask", depth: 2 })).toEqual([[101, 2], [102, 4]]);
  });

  test("zero-size rows in a provider snapshot are absent prices, not resting liquidity", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    const transitions = send(source, [
      row(0, true, "bid", 105, 0), row(0, true, "bid", 100, 5),
      row(0, true, "ask", 101, 3), row(0, true, "ask", 99, 0),
    ]);
    expect(transitions[0].frames[1].book).toEqual({ bids: [["100", "5"]], asks: [["101", "3"]] });
  });

  test("all price changes at one provider timestamp are applied before checking the spread", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    const transitions = send(source, [
      row(0, true, "bid", 100, 5), row(0, true, "ask", 101, 3),
      row(10, false, "bid", 102, 5), row(10, false, "ask", 101, 0), row(10, false, "ask", 103, 3),
    ]);
    expect(transitions[1].reason).toBeNull();
    expect(transitions[1].frames[0].book).toEqual({ bestBid: "102", bestAsk: "103" });
  });

  test("removing the best and adding a worse level recomputes the best from the remaining book", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    const transitions = send(source, [
      row(0, true, "bid", 100, 5), row(0, true, "bid", 99, 2), row(0, true, "ask", 101, 3),
      row(10, false, "bid", 100, 0), row(10, false, "bid", 98, 1),
    ]);
    expect(transitions[1].frames[0].book.bestBid).toBe("99");
  });

  test("a missing seed and a crossed group cannot produce a READY book", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    expect(send(source, [row(0, false, "bid", 100, 5)]))
      .toMatchObject([{ reason: "AWAITING_SOURCE_SNAPSHOT", frames: [] }]);
    const after = send(source, [
      row(10, true, "bid", 100, 5), row(10, true, "ask", 101, 3),
      row(20, false, "bid", 102, 5),
      row(30, false, "ask", 103, 2),
    ]);
    expect(after.map(({ reason }) => reason)).toEqual(["SOURCE_SNAPSHOT", "INVALID_BOOK", "AWAITING_SOURCE_SNAPSHOT"]);
    expect(after[1].frames).toMatchObject([{ kind: "gap", cause: "INVALID_BOOK" }]);
  });

  test("rejects malformed identities, timestamps and duplicate snapshot prices", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT" });
    expect(() => source.push(row(0, true, "bid", 100, 1, { symbol: "ETHUSDT" }))).toThrow(/identity/);
    expect(() => source.push(row(0, true, "bid", 100, 1, { timestamp: "1.5" }))).toThrow(/timestamp/);
    expect(() => source.push(row(0, true, "bid", 100, 1, { amount: "-1" }))).toThrow(/amount/);
    expect(() => source.push(row(0, true, "bid", 100, 1))).not.toThrow();
    expect(() => source.push(row(-1, true, "ask", 101, 1))).toThrow(/receive order/);
    source.push(row(0, true, "bid", 100, 2));
    source.push(row(0, true, "ask", 101, 1));
    expect(() => source.flush()).toThrow(/snapshot level/);
  });

  test("bounds a corrupt or malformed timestamp group", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT", maxGroupRows: 2 });
    source.push(row(0, true, "bid", 100, 1));
    source.push(row(0, true, "ask", 101, 1));
    expect(() => source.push(row(0, true, "bid", 99, 1))).toThrow(/exceeds bound/);
  });

  test("bounds accumulated book levels and waits for a fresh complete snapshot", () => {
    const source = createHistoricalTardisFrames({ exchange: "binance", symbol: "BTCUSDT", maxBookLevelsPerSide: 2 });
    const result = send(source, [
      row(0, true, "bid", 100, 1), row(0, true, "ask", 101, 1),
      row(10, false, "bid", 99, 1),
      row(20, false, "bid", 98, 1),
      row(30, false, "ask", 102, 1),
      row(40, true, "bid", 100, 1), row(40, true, "ask", 101, 1),
    ]);
    expect(result.map(({ reason }) => reason)).toEqual([
      "SOURCE_SNAPSHOT", null, "BOOK_LEVEL_LIMIT", "AWAITING_SOURCE_SNAPSHOT", "SOURCE_SNAPSHOT",
    ]);
    expect(result[2].frames).toMatchObject([{ kind: "gap", cause: "BOOK_LEVEL_LIMIT" }]);
    expect(result[4].frames[1].book.bids).toEqual([["100", "1"]]);
  });
});
