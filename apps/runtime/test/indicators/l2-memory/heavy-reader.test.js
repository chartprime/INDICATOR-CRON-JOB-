"use strict";

const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createHeavyReader } = require("../../../src/indicators/l2-memory/heavy-reader");
const { createLevelLedger } = require("../../../src/indicators/l2-memory/level-ledger");

const BOOK = { bids: [["100", "5"], ["99", "4"]], asks: [["101", "5"], ["102", "3"]] };

function seededEngine(options = {}) {
  const engine = createMemoryEngine({ tickSize: 1, ...options });
  engine.apply({ kind: "book", ts: 1_000, status: "READY", book: BOOK });
  return engine;
}

describe("heavy reader (report 61 P2)", () => {
  test("starts at the head of the stream, so a reader attached late does not report history as missed", () => {
    const engine = seededEngine({ ledgerOptions: { eventCapacity: 4 } });
    for (let i = 0; i < 10; i += 1) engine.apply({ kind: "trade", ts: 1_010 + i, price: "101", size: "1", side: "buy" });
    const reader = createHeavyReader({ engine });
    expect(reader.read()).toMatchObject({ events: [], missed: 0, gap: false });
    engine.apply({ kind: "trade", ts: 1_100, price: "100", size: "2", side: "sell" });
    const next = reader.read();
    expect(next.events.map((e) => [e.type, e.side, e.size])).toEqual([["trade", "bid", 2]]);
    expect(next.missed).toBe(0);
  });

  test("two readers keep their own cursors; reading never drains the stream for the other", () => {
    const engine = seededEngine();
    const a = createHeavyReader({ engine, fromSeq: 0 });
    const b = createHeavyReader({ engine, fromSeq: 0 });
    engine.apply({ kind: "trade", ts: 1_010, price: "101", size: "1", side: "buy" });
    expect(a.read().events.map((e) => e.type)).toEqual(["segment", "trade"]);
    engine.apply({ kind: "trade", ts: 1_020, price: "101", size: "1", side: "buy" });
    expect(a.read().events.map((e) => e.ts)).toEqual([1_020]);
    expect(b.read().events.map((e) => e.ts)).toEqual([1_000, 1_010, 1_020]);
    expect(a.cursor).toBe(b.cursor);
  });

  test("falling behind the ring is reported as missed and as a gap", () => {
    const engine = seededEngine({ ledgerOptions: { eventCapacity: 3 } });
    const reader = createHeavyReader({ engine });
    for (let i = 0; i < 5; i += 1) engine.apply({ kind: "trade", ts: 1_010 + i, price: "101", size: "1", side: "buy" });
    const result = reader.read();
    expect(result.missed).toBe(2);
    expect(result.gap).toBe(true);
    expect(result.events).toHaveLength(3);
    expect(reader.read()).toMatchObject({ missed: 0, gap: false });
  });

  test("a lost book is a gap for the reader", () => {
    const engine = seededEngine();
    const reader = createHeavyReader({ engine });
    engine.apply({ kind: "book", ts: 1_100, status: "UNAVAILABLE" });
    expect(reader.read()).toMatchObject({ gap: true, missed: 0 });
    engine.apply({ kind: "book", ts: 1_200, status: "READY", book: BOOK });
    expect(reader.read()).toMatchObject({ gap: false });
  });

  test("range returns the ledger views between two keys in key order, and level returns one", () => {
    const engine = seededEngine();
    const reader = createHeavyReader({ engine });
    expect(reader.range({ side: "bid", fromKey: 99, toKey: 100 }).map((v) => [v.key, v.size])).toEqual([[99, 4], [100, 5]]);
    expect(reader.range({ side: "ask", fromKey: 102, toKey: 500 }).map((v) => v.key)).toEqual([102]);
    expect(reader.range({ side: "ask", fromKey: 50, toKey: 60 })).toEqual([]);
    expect(reader.level("ask", 101)).toMatchObject({ key: 101, size: 5 });
    expect(reader.level("ask", 150)).toBeNull();
    expect(() => reader.range({ side: "bid", fromKey: 5, toKey: 1 })).toThrow(/fromKey <= toKey/);
    expect(() => reader.range({ side: "mid", fromKey: 1, toKey: 5 })).toThrow(/side/);
  });

  test("range over non-integer keys scans and sorts", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.5", "1"], ["98.25", "2"], ["97", "3"]], asks: [] });
    expect(ledger.range({ side: "bid", fromKey: 98, toKey: 99.9 }).map((v) => v.key)).toEqual([98.25, 99.5]);
  });

  test("a reader needs an engine with an event stream and a sane start", () => {
    expect(() => createHeavyReader({})).toThrow(/engine/);
    expect(() => createHeavyReader({ engine: seededEngine(), fromSeq: -1 })).toThrow(/fromSeq/);
  });
});
