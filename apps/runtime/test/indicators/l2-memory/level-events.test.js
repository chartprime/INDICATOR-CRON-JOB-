"use strict";

const { createLevelLedger } = require("../../../src/indicators/l2-memory/level-ledger");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

const types = (result) => result.events.map((event) => event.type);

describe("level ledger event outbox (report 61 heavy reader foundation)", () => {
  test("a wall's life: appears, first shrink, empties with its life facts, then a filled verdict", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99", "1"]], asks: [["101", "1"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99", bestAsk: "101" });
    expect(ledger.eventsSince(0).events).toEqual([]);

    ledger.applyDelta({ ts: 1_100, bids: [["100", "50"]] });
    ledger.observeQuote({ ts: 1_100, bestBid: "100", bestAsk: "101" });
    ledger.applyDelta({ ts: 1_200, bids: [["100", "80"]] });
    ledger.applyTrade({ ts: 1_250, price: "100", size: "20", side: "sell" });
    ledger.applyDelta({ ts: 1_300, bids: [["100", "60"]] });
    ledger.applyDelta({ ts: 1_350, bids: [["100", "40"]] });
    ledger.applyTrade({ ts: 1_380, price: "100", size: "40", side: "sell" });
    ledger.applyDelta({ ts: 1_400, bids: [["100", "0"]] });

    const { events, nextSeq, missed } = ledger.eventsSince(0);
    expect(types({ events })).toEqual(["appeared", "trade", "shrank", "trade", "emptied", "verdict"]);
    expect(events[0]).toMatchObject({ seq: 0, ts: 1_100, side: "bid", key: 100, size: 50, refill: false });
    expect(events[1]).toMatchObject({ ts: 1_250, side: "bid", aggressor: "sell", key: 100, size: 20, kind: "absorbed" });
    expect(events[2]).toMatchObject({ ts: 1_300, from: 80, to: 60 });
    expect(events[4]).toMatchObject({ ts: 1_400, lastSlice: 40, lifeStartTs: 1_100, lifePeak: 80, firstShrinkTs: 1_300, distance: 0 });
    expect(events[5]).toMatchObject({ type: "verdict", endedBy: "filled", endingSize: 40, explained: 40 });
    expect(nextSeq).toBe(6);
    expect(missed).toBe(0);
    expect(ledger.eventsSince(nextSeq).events).toEqual([]);
  });

  test("a pulled wall gets its verdict when the grace runs out, and a refill starts a new life", () => {
    const ledger = createLevelLedger({ endGraceMs: 1_500 });
    ledger.seed({ ts: 1_000, bids: [["99", "1"]], asks: [["105", "1"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99", bestAsk: "105" });
    ledger.applyDelta({ ts: 1_100, asks: [["103", "30"]] });
    ledger.observeQuote({ ts: 1_100, bestBid: "99", bestAsk: "103" });
    ledger.applyDelta({ ts: 1_200, asks: [["103", "0"]] });
    expect(types(ledger.eventsSince(0))).toEqual(["appeared", "shrank", "emptied"]);
    expect(ledger.eventsSince(0).events[2]).toMatchObject({ distance: 0, firstShrinkTs: 1_200 });

    ledger.applyDelta({ ts: 2_800, asks: [["104", "1"]] });
    expect(ledger.eventsSince(3).events.map((e) => [e.type, e.key, e.endedBy ?? null, e.ts])).toEqual([["appeared", 104, null, 2_800], ["verdict", 103, "pulled", 2_800]]);

    ledger.applyDelta({ ts: 3_000, asks: [["103", "25"]] });
    const refill = ledger.eventsSince(5).events;
    expect(refill.map((e) => e.type)).toEqual(["appeared"]);
    expect(refill[0]).toMatchObject({ key: 103, size: 25, refill: true });
    ledger.applyDelta({ ts: 3_100, asks: [["103", "0"]] });
    expect(ledger.eventsSince(6).events.find((e) => e.type === "emptied")).toMatchObject({ lifeStartTs: 3_000, lifePeak: 25 });
  });

  test("absorption beyond the visible shrink is announced as hidden volume", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["100", "10"]], asks: [["101", "10"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "100", bestAsk: "101" });
    ledger.applyTrade({ ts: 1_050, price: "100", size: "8", side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [["100", "7"]] });
    ledger.applyTrade({ ts: 1_150, price: "100", size: "4", side: "sell" });
    ledger.applyDelta({ ts: 1_200, asks: [["101", "9"]] });
    const hidden = ledger.eventsSince(0).events.filter((e) => e.type === "hidden");
    expect(hidden.map((e) => [e.ts, e.volume])).toEqual([[1_100, 5], [1_200, 4]]);
  });

  test("every trade is announced with the side it hit, whether the level was holding or already passed, and any late reclaim", () => {
    const ledger = createLevelLedger({ lateTradeWindowMs: 500 });
    ledger.seed({ ts: 1_000, bids: [["100", "10"], ["97", "10"]], asks: [["101", "10"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "100", bestAsk: "101" });
    ledger.applyTrade({ ts: 1_010, price: "101", size: "2", side: "buy" });
    ledger.applyTrade({ ts: 1_020, price: "97", size: "3", side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [["100", "6"]] });
    ledger.applyTrade({ ts: 1_150, price: "100", size: "4", side: "sell", late: true });
    const trades = ledger.eventsSince(0).events.filter((e) => e.type === "trade");
    expect(trades.map((e) => [e.side, e.aggressor, e.key, e.size, e.kind, e.late, e.reclaimed])).toEqual([
      ["ask", "buy", 101, 2, "absorbed", false, 0],
      ["bid", "sell", 97, 3, "swept", false, 0],
      ["bid", "sell", 100, 4, "absorbed", true, 4],
    ]);
    expect(trades.map((e) => e.price)).toEqual([101, 97, 100]);
  });

  test("dust coming and going says nothing", () => {
    const ledger = createLevelLedger({ minSliceSize: 1 });
    ledger.seed({ ts: 1_000, bids: [["100", "5"]], asks: [["101", "5"]] });
    ledger.applyDelta({ ts: 1_100, bids: [["99", "0.4"]] });
    ledger.applyDelta({ ts: 1_200, bids: [["99", "0"]] });
    ledger.applyDelta({ ts: 1_300, bids: [["99", "0.4"]] });
    expect(ledger.eventsSince(0).events).toEqual([]);
  });

  test("a reader that falls behind the ring is told how many events it missed", () => {
    const ledger = createLevelLedger({ eventCapacity: 3 });
    ledger.seed({ ts: 1_000, bids: [["100", "5"]], asks: [["101", "5"]] });
    for (let i = 0; i < 5; i += 1) ledger.applyDelta({ ts: 1_100 + i, bids: [[String(90 + i), "2"]] });
    const result = ledger.eventsSince(0);
    expect(result.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(result.missed).toBe(2);
    expect(result.nextSeq).toBe(5);
    expect(createLevelLedger({ eventCapacity: 0 }).eventsSince(0)).toMatchObject({ events: [], nextSeq: 0, missed: 0 });
    expect(() => createLevelLedger({ eventCapacity: -1 })).toThrow(/eventCapacity/);
    expect(() => ledger.eventsSince(-1)).toThrow(/fromSeq/);
  });
});

describe("memory engine trust segments", () => {
  test("seed opens a LIVE segment, a lost stream a GAP, the reconciled book a LIVE again", () => {
    const engine = createMemoryEngine({ tickSize: 1 });
    const book = { bids: [["100", "5"]], asks: [["101", "5"]] };
    engine.apply({ kind: "book", ts: 1_000, status: "READY", book });
    engine.apply({ kind: "book", ts: 1_100, status: "UNAVAILABLE" });
    engine.apply({ kind: "book", ts: 1_150, status: "UNAVAILABLE" });
    engine.apply({ kind: "anchor", ts: 1_160 });
    engine.apply({ kind: "book", ts: 1_200, status: "READY", book });
    engine.apply({ kind: "anchor", ts: 1_300 });
    const segments = engine.events(0).events.filter((e) => e.type === "segment").map((e) => [e.state, e.cause]);
    expect(segments).toEqual([["LIVE", "SEED"], ["GAP", "UNAVAILABLE"], ["LIVE", "RESYNC"], ["GAP", "ANCHOR"]]);
  });
});
