const { createLevelLedger } = require("../../../src/indicators/l2-memory/level-ledger");

describe("level-ledger", () => {
  test("rejects bad options and out-of-order events", () => {
    expect(() => createLevelLedger({ keyFor: "nope" })).toThrow(/keyFor/);
    expect(() => createLevelLedger({ forgetEmptyAfterMs: -1 })).toThrow(/forgetEmptyAfterMs/);
    expect(() => createLevelLedger({ maxRecordsPerSide: 0 })).toThrow(/maxRecordsPerSide/);

    const ledger = createLevelLedger();
    ledger.applyDelta({ ts: 1_000, bids: [["99.0", "1.0"]] });
    expect(() => ledger.applyDelta({ ts: 999, bids: [["99.0", "1.0"]] })).toThrow(/time order/);
    expect(() => ledger.applyTrade({ ts: 1_000, price: "99.0", size: "1", side: "maker" })).toThrow(/trade side/);
    expect(() => ledger.applyDelta({ ts: 1_000, bids: [["0", "1.0"]] })).toThrow(/price must be positive/);
    expect(() => ledger.applyDelta({ ts: 1_000, bids: [["99.0", "-1"]] })).toThrow(/size must not be negative/);
  });

  test("seeded levels are flagged and their initial size is not counted as added", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "2.0"]], asks: [["101.0", "3.0"]] });
    const bid = ledger.get("bid", 99, 1_500);
    expect(bid).toMatchObject({ key: 99, side: "bid", size: 2, peakSize: 2, seeded: true, added: 0, ageMs: 500 });
    expect(ledger.get("ask", 101)).toMatchObject({ size: 3, seeded: true });
    expect(ledger.stats()).toEqual({ bidRecords: 1, askRecords: 1, lastTs: 1_000 });
  });

  test("a level that appears after start has a real age and counts its additions", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000 });
    ledger.applyDelta({ ts: 2_000, asks: [["101.0", "1.0"]] });
    ledger.applyDelta({ ts: 3_000, asks: [["101.0", "4.0"]] });
    expect(ledger.get("ask", 101, 5_000)).toMatchObject({
      seeded: false, ageMs: 3_000, size: 4, peakSize: 4, added: 4, cancelled: 0, traded: 0,
    });
  });

  test("a shrink with no trade behind it is a cancel", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"]] });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "2.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 2, cancelled: 3, traded: 0, tradedVisible: 0, cancelRatio: 1 });
  });

  test("a shrink explained by trades since the last diff is a fill, not a cancel", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"]] });
    // Two aggressive sells hit the bid, then the diff shows the bid down by exactly that.
    ledger.applyTrade({ ts: 1_050, price: "99.0", size: "1.0", side: "sell" });
    ledger.applyTrade({ ts: 1_060, price: "99.0", size: "2.0", side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "2.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({
      size: 2, traded: 3, tradedVisible: 3, hiddenTraded: 0, cancelled: 0, cancelRatio: 0,
    });
  });

  test("a shrink larger than the trades splits into fill plus cancel", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, asks: [["101.0", "5.0"]] });
    ledger.applyTrade({ ts: 1_050, price: "101.0", size: "1.0", side: "buy" });
    ledger.applyDelta({ ts: 1_100, asks: [["101.0", "1.0"]] }); // shrank by 4, only 1 traded
    expect(ledger.get("ask", 101)).toMatchObject({ traded: 1, tradedVisible: 1, cancelled: 3, cancelRatio: 0.75 });
  });

  test("trades beyond the visible shrink are the iceberg footprint", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, asks: [["101.0", "2.0"]] });
    // 6 BTC trade at the ask, but the level only ever shows 2 and is still 2 after.
    ledger.applyTrade({ ts: 1_010, price: "101.0", size: "2.0", side: "buy" });
    ledger.applyTrade({ ts: 1_020, price: "101.0", size: "2.0", side: "buy" });
    ledger.applyTrade({ ts: 1_030, price: "101.0", size: "2.0", side: "buy" });
    ledger.applyDelta({ ts: 1_100, asks: [["101.0", "2.0"]] });
    expect(ledger.get("ask", 101)).toMatchObject({
      size: 2, peakSize: 2, traded: 6, tradedVisible: 0, hiddenTraded: 6, cancelled: 0,
    });
  });

  test("pending trade volume is consumed once, not carried into the next diff", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"]] });
    ledger.applyTrade({ ts: 1_050, price: "99.0", size: "1.0", side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "4.0"]] }); // fill of 1
    ledger.applyDelta({ ts: 1_200, bids: [["99.0", "2.0"]] }); // no trades since: cancel of 2
    expect(ledger.get("bid", 99)).toMatchObject({ traded: 1, tradedVisible: 1, cancelled: 2 });
  });

  test("a trade on the wrong side of the book is attributed by aggressor, not by lookup", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"]], asks: [["101.0", "5.0"]] });
    ledger.applyTrade({ ts: 1_050, price: "99.0", size: "1.0", side: "sell" }); // hits bid
    ledger.applyTrade({ ts: 1_060, price: "101.0", size: "1.0", side: "buy" }); // lifts ask
    expect(ledger.get("bid", 99).traded).toBe(1);
    expect(ledger.get("ask", 101).traded).toBe(1);
  });

  test("a trade at a level with no record creates one marked empty (consumed and refilled between diffs)", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000 });
    ledger.applyTrade({ ts: 1_050, price: "99.0", size: "1.5", side: "sell" });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 0, traded: 1.5, emptiedAt: 1_050, seeded: false });
  });

  test("emptying and coming back counts a refill; peak size survives", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "3.0"]] });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 0, emptiedAt: 1_100, refills: 0 });
    ledger.applyDelta({ ts: 1_200, bids: [["99.0", "1.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 1, emptiedAt: null, refills: 1, peakSize: 3, added: 1 });
    ledger.applyDelta({ ts: 1_300, bids: [["99.0", "0"]] });
    ledger.applyDelta({ ts: 1_400, bids: [["99.0", "2.0"]] });
    expect(ledger.get("bid", 99).refills).toBe(2);
  });

  test("deleting an unknown level records nothing", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000 });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "0"]] });
    expect(ledger.get("bid", 99)).toBeNull();
    expect(ledger.stats().bidRecords).toBe(0);
  });

  test("clusters: prices sharing a key are tracked as one record with the summed size", () => {
    // 5-dollar bands: 77225.0 .. 77229.9 -> key 15445
    const ledger = createLevelLedger({ keyFor: (price) => Math.floor(price / 5) });
    ledger.seed({ ts: 1_000, asks: [["77225.0", "1.0"], ["77227.5", "2.0"], ["77230.0", "9.0"]] });
    expect(ledger.get("ask", 15445)).toMatchObject({ size: 3, peakSize: 3 });
    expect(ledger.get("ask", 15446)).toMatchObject({ size: 9 });
    // One price inside the band is pulled: the cluster shrinks by that price only.
    ledger.applyDelta({ ts: 1_100, asks: [["77227.5", "0"]] });
    expect(ledger.get("ask", 15445)).toMatchObject({ size: 1, cancelled: 2 });
    // A trade inside the band is attributed to the band.
    ledger.applyTrade({ ts: 1_150, price: "77225.0", size: "0.5", side: "buy" });
    ledger.applyDelta({ ts: 1_200, asks: [["77225.0", "0.5"]] });
    expect(ledger.get("ask", 15445)).toMatchObject({ size: 0.5, traded: 0.5, tradedVisible: 0.5, cancelled: 2 });
  });

  test("observeQuote tracks closest approach and counts distinct tests at the top of book", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "1.0"], ["98.0", "1.0"], ["97.0", "1.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    expect(ledger.get("bid", 97)).toMatchObject({ closestDistance: 2, tests: 0, isBest: false });
    expect(ledger.get("bid", 99)).toMatchObject({ closestDistance: 0, tests: 1, isBest: true });

    // Price drops through 99 to 98, then recovers to 99.
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "0"]] });
    ledger.observeQuote({ ts: 1_100, bestBid: "98.0", bestAsk: "100.0" });
    expect(ledger.get("bid", 97)).toMatchObject({ closestDistance: 1 });
    expect(ledger.get("bid", 98)).toMatchObject({ tests: 1, isBest: true });
    ledger.observeQuote({ ts: 1_150, bestBid: "98.0", bestAsk: "100.0" }); // still best: not a new test
    expect(ledger.get("bid", 98).tests).toBe(1);

    ledger.applyDelta({ ts: 1_200, bids: [["99.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_200, bestBid: "99.0", bestAsk: "101.0" });
    expect(ledger.get("bid", 99)).toMatchObject({ tests: 2, isBest: true, refills: 1 });
    expect(ledger.get("bid", 98)).toMatchObject({ tests: 1, isBest: false });

    const snap = ledger.snapshot();
    expect(snap).toMatchObject({ ts: 1_200, bestBidKey: 99, bestAskKey: 101 });
    expect(snap.bids.map((r) => r.key).sort()).toEqual([97, 98, 99]);

    ledger.observeQuote({ ts: 1_300, bestBid: null, bestAsk: null });
    expect(ledger.snapshot().bestBidKey).toBeNull();
  });

  test("size stability: a steady level has zero deviation, a flickering one does not", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "2.0"], ["98.0", "2.0"]] });
    for (let i = 1; i <= 5; i += 1) {
      ledger.applyDelta({ ts: 1_000 + i * 100, bids: [["99.0", "2.0"], ["98.0", i % 2 ? "0.5" : "4.0"]] });
    }
    expect(ledger.get("bid", 99).sizeStdDev).toBe(0);
    expect(ledger.get("bid", 98).sizeStdDev).toBeGreaterThan(1);
    expect(ledger.get("bid", 99).sizeMean).toBe(2);
  });

  test("prune forgets long-empty records and enforces the per-side cap", () => {
    const ledger = createLevelLedger({ forgetEmptyAfterMs: 1_000, maxRecordsPerSide: 2 });
    ledger.seed({ ts: 1_000, bids: [["99.0", "1.0"], ["98.0", "1.0"]] });
    ledger.applyDelta({ ts: 1_100, bids: [["98.0", "0"]] });
    ledger.prune(2_000); // empty for 900ms: keep
    expect(ledger.stats().bidRecords).toBe(2);
    ledger.prune(2_200); // empty for 1100ms: forget
    expect(ledger.get("bid", 98)).toBeNull();

    // Cap: three live-then-emptied records, only two allowed; oldest-emptied goes first.
    ledger.applyDelta({ ts: 3_000, bids: [["97.0", "1.0"], ["96.0", "1.0"]] });
    ledger.applyDelta({ ts: 3_100, bids: [["97.0", "0"]] });
    ledger.applyDelta({ ts: 3_200, bids: [["96.0", "0"]] });
    expect(ledger.stats().bidRecords).toBe(3);
    ledger.prune(3_300);
    expect(ledger.stats().bidRecords).toBe(2);
    expect(ledger.get("bid", 97)).toBeNull();
    expect(ledger.get("bid", 96)).not.toBeNull();
    expect(ledger.get("bid", 99)).not.toBeNull();
  });

  test("a trade at a level price has already moved past is a sweep, not absorption", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["100.0", "1.0"], ["99.0", "1.0"], ["98.0", "1.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "100.0", bestAsk: "101.0" });
    // Sell hits the best bid (absorption) and, in the same burst, prints two bands lower (sweep).
    ledger.applyTrade({ ts: 1_050, price: "100.0", size: "0.5", side: "sell" });
    ledger.applyTrade({ ts: 1_060, price: "98.0", size: "0.7", side: "sell" });
    expect(ledger.get("bid", 100)).toMatchObject({ absorbed: 0.5, swept: 0, traded: 0.5 });
    expect(ledger.get("bid", 98)).toMatchObject({ absorbed: 0, swept: 0.7, traded: 0.7 });
    // Within tolerance (1 band) still counts as absorption.
    ledger.applyTrade({ ts: 1_070, price: "99.0", size: "0.2", side: "sell" });
    expect(ledger.get("bid", 99)).toMatchObject({ absorbed: 0.2, swept: 0 });
    // The diff arrives: the swept level's shrink is explained by the sweep, and none of it is hidden.
    ledger.applyDelta({ ts: 1_100, bids: [["100.0", "0.5"], ["98.0", "0.3"]] });
    expect(ledger.get("bid", 98)).toMatchObject({ hiddenTraded: 0, hiddenSwept: 0, cancelled: 0, tradedVisible: 0.7, hiddenWindows: 0 });
    expect(ledger.get("bid", 100)).toMatchObject({ hiddenTraded: 0, tradedVisible: 0.5, hiddenWindows: 0 });
    expect(() => createLevelLedger({ sweepToleranceKeys: -1 })).toThrow(/sweepToleranceKeys/);
  });

  test("sweep volume beyond the visible shrink is hiddenSwept, never hiddenTraded", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, asks: [["101.0", "1.0"], ["103.0", "1.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "100.0", bestAsk: "101.0" });
    ledger.applyTrade({ ts: 1_050, price: "103.0", size: "3.0", side: "buy" }); // two bands past the best ask
    ledger.applyDelta({ ts: 1_100, asks: [["103.0", "1.0"]] }); // still shows 1.0: 3.0 traded through it and it refilled
    expect(ledger.get("ask", 103)).toMatchObject({ swept: 3, hiddenSwept: 3, hiddenTraded: 0, absorbed: 0, hiddenWindows: 0 });
  });

  test("hiddenWindows counts the diff windows in which hidden absorption grew", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, asks: [["101.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "100.0", bestAsk: "101.0" });
    for (let w = 1; w <= 3; w += 1) {
      ledger.applyTrade({ ts: 1_000 + w * 100 - 50, price: "101.0", size: "2.0", side: "buy" });
      ledger.applyDelta({ ts: 1_000 + w * 100, asks: [["101.0", "2.0"]] }); // never visibly shrinks
    }
    expect(ledger.get("ask", 101)).toMatchObject({ hiddenTraded: 6, hiddenWindows: 3 });
    // A window whose trades are fully explained by a visible shrink does not count.
    ledger.applyTrade({ ts: 1_350, price: "101.0", size: "1.0", side: "buy" });
    ledger.applyDelta({ ts: 1_400, asks: [["101.0", "1.0"]] });
    expect(ledger.get("ask", 101)).toMatchObject({ hiddenTraded: 6, hiddenWindows: 3, tradedVisible: 1 });
  });

  test("a level absent from the diff still settles its pending trades as hidden", () => {
    // A perfect iceberg: hit and instantly refilled, so the net size never changes
    // and Binance never lists the level in a diff. Each diff must still close a window.
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["98.0", "1.0"]], asks: [["101.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "98.0", bestAsk: "101.0" });
    ledger.applyTrade({ ts: 1_050, price: "101.0", size: "2.0", side: "buy" });
    ledger.applyDelta({ ts: 1_100, bids: [["98.0", "1.5"]] }); // touches only the bid
    expect(ledger.get("ask", 101)).toMatchObject({ hiddenTraded: 2, hiddenWindows: 1, size: 2 });
    ledger.applyTrade({ ts: 1_150, price: "101.0", size: "2.0", side: "buy" });
    ledger.applyDelta({ ts: 1_200, bids: [["98.0", "1.0"]] });
    expect(ledger.get("ask", 101)).toMatchObject({ hiddenTraded: 4, hiddenWindows: 2 });
    // Pending volume is not double-counted when the level does show up later.
    ledger.applyDelta({ ts: 1_300, asks: [["101.0", "2.0"]] });
    expect(ledger.get("ask", 101)).toMatchObject({ hiddenTraded: 4, hiddenWindows: 2 });
  });

  test("a level emptied with the trades already in is called filled immediately", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    ledger.applyTrade({ ts: 1_050, price: "99.0", size: "2.0", side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 0, endedBy: "filled" });
  });

  test("a level emptied with no trades stays undecided through the grace, then is called pulled", () => {
    const ledger = createLevelLedger({ endGraceMs: 1_000 });
    ledger.seed({ ts: 1_000, bids: [["98.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "98.0", bestAsk: "101.0" });
    ledger.applyDelta({ ts: 1_100, bids: [["98.0", "0"]] });
    expect(ledger.get("bid", 98)).toMatchObject({ size: 0, endedBy: null }); // waiting for late trades
    ledger.applyDelta({ ts: 1_500, bids: [["97.0", "1.0"]] });
    expect(ledger.get("bid", 98).endedBy).toBeNull(); // still inside the grace
    ledger.applyDelta({ ts: 2_200, bids: [["97.0", "2.0"]] });
    expect(ledger.get("bid", 98).endedBy).toBe("pulled");
  });

  test("late trades arriving after the emptying diff still make it filled -- the upstream ordering case", () => {
    // DEPTH is delivered synchronously but trades are queued, so the zeroing
    // diff routinely lands before the trades that consumed the level.
    const ledger = createLevelLedger({ endGraceMs: 1_000 });
    ledger.seed({ ts: 1_000, bids: [["99.0", "2.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "0"]] }); // diff first
    expect(ledger.get("bid", 99).endedBy).toBeNull();
    ledger.applyTrade({ ts: 1_150, price: "99.0", size: "1.5", side: "sell" }); // trades after
    ledger.applyDelta({ ts: 1_200, bids: [["98.0", "1.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ endedBy: "filled" });
  });

  test("a reload decides the pending ending on the evidence so far, and prune can settle it too", () => {
    const ledger = createLevelLedger({ endGraceMs: 10_000 });
    ledger.seed({ ts: 1_000, bids: [["98.0", "4.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "98.0", bestAsk: "101.0" });
    ledger.applyDelta({ ts: 1_100, bids: [["98.0", "0"]] });
    expect(ledger.get("bid", 98).endedBy).toBeNull();
    ledger.applyDelta({ ts: 1_200, bids: [["98.0", "4.0"]] }); // reloaded before the grace ran out
    expect(ledger.get("bid", 98)).toMatchObject({ refills: 1, endedBy: "pulled" });

    // prune also settles a long-pending ending rather than leaving it undecided.
    const other = createLevelLedger({ endGraceMs: 1_000, forgetEmptyAfterMs: 60_000 });
    other.seed({ ts: 1_000, bids: [["97.0", "1.0"]] });
    other.observeQuote({ ts: 1_000, bestBid: "97.0", bestAsk: "101.0" });
    other.applyDelta({ ts: 1_100, bids: [["97.0", "0"]] });
    expect(other.get("bid", 97).endedBy).toBeNull();
    other.prune(5_000);
    expect(other.get("bid", 97).endedBy).toBe("pulled");
    expect(() => createLevelLedger({ endGraceMs: -1 })).toThrow(/endGraceMs/);
  });

  test("resync applies a full book as one large diff against what the ledger holds", () => {
    const ledger = createLevelLedger({ endGraceMs: 1_000 });
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"], ["98.0", "1.0"], ["97.0", "1.0"]], asks: [["101.0", "2.0"], ["102.0", "3.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    // Trades seen while diffs were lost: 2.0 sold into 99.0, 3.0 bought from 101.0 (101.0 then vanishes: filled).
    ledger.applyTrade({ ts: 1_500, price: "99.0", size: "2.0", side: "sell" });
    ledger.applyTrade({ ts: 1_600, price: "101.0", size: "3.0", side: "buy" });

    ledger.resync({
      ts: 5_000,
      bids: [["99.0", "3.0"], ["98.5", "4.0"], ["97.0", "1.0"]],
      asks: [["102.0", "1.0"]],
    });
    // 99.0 shrank by exactly what traded: visible fill, no cancel.
    expect(ledger.get("bid", 99)).toMatchObject({ size: 3, traded: 2, tradedVisible: 2, cancelled: 0, hiddenTraded: 0 });
    // 98.0 vanished with nothing traded: verdict pending, then pulled after the grace.
    expect(ledger.get("bid", 98)).toMatchObject({ size: 0, endedBy: null });
    // 97.0 unchanged: untouched.
    expect(ledger.get("bid", 97)).toMatchObject({ size: 1, cancelled: 0, added: 0, seeded: true });
    // 98.5 new inside coverage: a real addition with a real age.
    expect(ledger.get("bid", 98.5, 6_000)).toMatchObject({ size: 4, added: 4, seeded: false, ageMs: 1_000 });
    // 101.0 vanished with trades covering it: filled at once.
    expect(ledger.get("ask", 101)).toMatchObject({ size: 0, endedBy: "filled", traded: 3, tradedVisible: 2 });
    // 102.0 shrank with nothing traded: cancel.
    expect(ledger.get("ask", 102)).toMatchObject({ size: 1, cancelled: 2 });
    ledger.prune(7_000);
    expect(ledger.get("bid", 98)).toMatchObject({ endedBy: "pulled" });
  });

  test("resync leaves levels the book cannot vouch for alone, and seeds unknown ones out there", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "1.0"], ["50.0", "10.0"]], asks: [["101.0", "1.0"], ["150.0", "20.0"]] });
    // The book covers bids down to 90 and asks up to 110 only.
    const covers = (side, key) => (side === "bid" ? key >= 90 : key <= 110);
    ledger.resync({ ts: 2_000, bids: [["99.0", "1.0"], ["60.0", "100.0"]], asks: [["101.0", "1.0"]], covers });
    expect(ledger.get("bid", 50)).toMatchObject({ size: 10, cancelled: 0 });
    expect(ledger.get("ask", 150)).toMatchObject({ size: 20, cancelled: 0 });
    expect(ledger.get("bid", 60)).toMatchObject({ size: 100, seeded: true, added: 0 });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 1, cancelled: 0 });
  });

  test("resync counts a level that went and came back as a refill", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "1.0"]] });
    ledger.resync({ ts: 2_000, bids: [] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 0, refills: 0 });
    ledger.resync({ ts: 3_000, bids: [["99.0", "2.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 2, refills: 1, endedBy: "pulled", added: 2 });
  });

  test("reloads count only the refills that followed a filled emptying, and lastSlice is the size at emptying", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "1.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    // Pulled and reposted: a refill, not a reload.
    ledger.applyDelta({ ts: 2_000, bids: [["99.0", "0"]] });
    ledger.applyDelta({ ts: 3_000, bids: [["99.0", "1.5"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ refills: 1, reloads: 0, lastSlice: 1, endedBy: "pulled" });
    // Eaten and reposted: a reload.
    ledger.applyTrade({ ts: 4_000, price: "99.0", size: "1.5", side: "sell" });
    ledger.applyDelta({ ts: 4_100, bids: [["99.0", "0"]] });
    ledger.applyDelta({ ts: 5_000, bids: [["99.0", "2.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ refills: 2, reloads: 1, lastSlice: 1.5, size: 2, endedBy: "filled" });
  });

  test("a late trade reclaims the shrink the earlier diff booked as a cancel; an on-time trade never does", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [["99.0", "5.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    ledger.applyDelta({ ts: 1_100, bids: [["99.0", "3.0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ cancelled: 2, tradedVisible: 0 });
    // The trade that caused it arrives after the diff, flagged late: 1.5 of the 2 is a fill after all.
    ledger.applyTrade({ ts: 1_100, price: "99.0", size: "1.5", side: "sell", late: true });
    expect(ledger.get("bid", 99)).toMatchObject({ cancelled: 0.5, tradedVisible: 1.5, traded: 1.5, hiddenTraded: 0 });
    ledger.applyDelta({ ts: 1_200 });
    expect(ledger.get("bid", 99)).toMatchObject({ hiddenTraded: 0, hiddenWindows: 0 });
    // A late trade bigger than the open shrink: the excess is pending as usual.
    ledger.applyTrade({ ts: 1_200, price: "99.0", size: "1.0", side: "sell", late: true });
    expect(ledger.get("bid", 99)).toMatchObject({ cancelled: 0, tradedVisible: 2 });
    ledger.applyDelta({ ts: 1_300 });
    expect(ledger.get("bid", 99)).toMatchObject({ hiddenTraded: 0.5, hiddenWindows: 1 });
    // Beyond the window nothing is reclaimed: the late trade stays pending like any other.
    ledger.applyDelta({ ts: 2_000, bids: [["99.0", "2.0"]] });
    ledger.applyTrade({ ts: 2_600, price: "99.0", size: "1.0", side: "sell", late: true });
    expect(ledger.get("bid", 99)).toMatchObject({ cancelled: 1, tradedVisible: 2 });
    ledger.applyDelta({ ts: 2_700 });
    expect(ledger.get("bid", 99)).toMatchObject({ hiddenTraded: 1.5, hiddenWindows: 2 });
    // An on-time trade right after a cancel is a separate event: no reclaim.
    ledger.applyDelta({ ts: 3_000, bids: [["99.0", "1.0"]] });
    ledger.applyTrade({ ts: 3_000, price: "99.0", size: "1.0", side: "sell" });
    expect(ledger.get("bid", 99)).toMatchObject({ cancelled: 2, tradedVisible: 2 });
    expect(() => createLevelLedger({ lateTradeWindowMs: -1 })).toThrow(/lateTradeWindowMs/);
  });

  test("dust floor: only real slices start or end a cycle, the verdict sticks, and lastHiddenTs tracks hidden growth", () => {
    const ledger = createLevelLedger({ minSliceSize: 0.01, endGraceMs: 1_000 });
    ledger.seed({ ts: 1_000, bids: [["99.0", "0.5"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "99.0", bestAsk: "101.0" });
    ledger.applyTrade({ ts: 1_100, price: "99.0", size: "0.5", side: "sell" });
    ledger.applyDelta({ ts: 1_200, bids: [["99.0", "0"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ endedBy: "filled", lastSlice: 0.5, lastHiddenTs: null, refills: 0 });
    // Dust comes and goes: no refill, no reload, verdict untouched.
    ledger.applyDelta({ ts: 2_000, bids: [["99.0", "0.0001"]] });
    ledger.applyDelta({ ts: 2_100, bids: [["99.0", "0"]] });
    ledger.applyDelta({ ts: 2_200, bids: [["99.0", "0.0002"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ refills: 0, reloads: 0, endedBy: "filled", lastSlice: 0.5, size: 0.0002 });
    ledger.applyDelta({ ts: 2_300, bids: [["99.0", "0"]] });
    // A real slice returns: that is the reload.
    ledger.applyDelta({ ts: 3_000, bids: [["99.0", "0.4"]] });
    expect(ledger.get("bid", 99)).toMatchObject({ refills: 1, reloads: 1, endedBy: "filled" });
    // Hidden absorption stamps lastHiddenTs when it is settled.
    ledger.applyTrade({ ts: 3_100, price: "99.0", size: "1.0", side: "sell" });
    ledger.applyDelta({ ts: 3_200, bids: [["99.0", "0.4"]] }); // unchanged: the 1.0 was hidden
    expect(ledger.get("bid", 99)).toMatchObject({ hiddenTraded: 1, lastHiddenTs: 3_200 });
    ledger.applyTrade({ ts: 3_250, price: "99.0", size: "0.2", side: "sell" });
    ledger.applyDelta({ ts: 3_260 }); // untouched by the diff: settled as hidden too
    expect(ledger.get("bid", 99)).toMatchObject({ hiddenTraded: 1.2, lastHiddenTs: 3_260 });
    // Cancelled down to dust is an emptying of the real slice; the dust leaving afterwards is not.
    ledger.applyDelta({ ts: 3_300, bids: [["99.0", "0.005"]] });
    ledger.applyDelta({ ts: 3_400, bids: [["99.0", "0"]] });
    ledger.prune(5_000);
    expect(ledger.get("bid", 99)).toMatchObject({ endedBy: "pulled", lastSlice: 0.4, refills: 1 });
    expect(ledger.get("bid", 99).cancelled).toBeCloseTo(0.4003); // 0.395 down to dust, then the 0.005 of dust itself
    expect(() => createLevelLedger({ minSliceSize: -1 })).toThrow(/minSliceSize/);
  });

  test("a late trade reclaims only a cancel at its own price, never a neighbour's inside the band", () => {
    // 5-dollar bands: 100.5 and 101.0 share record 20.
    const ledger = createLevelLedger({ keyFor: (price) => Math.floor(price / 5) });
    ledger.seed({ ts: 1_000, bids: [["100.5", "5.0"], ["101.0", "5.0"]] });
    ledger.observeQuote({ ts: 1_000, bestBid: "101.0", bestAsk: "103.0" });
    // A market maker pulls 2 at 101.0; a late fill of 1.5 prints at 100.5.
    ledger.applyDelta({ ts: 1_100, bids: [["101.0", "3.0"]] });
    ledger.applyTrade({ ts: 1_100, price: "100.5", size: "1.5", side: "sell", late: true });
    // The 100.5 fill must not eat the 101.0 cancel: it stays pending, and becomes hidden if 100.5 does not shrink.
    expect(ledger.get("bid", 20)).toMatchObject({ cancelled: 2, tradedVisible: 0, reclaimed: 0 });
    ledger.applyDelta({ ts: 1_200 });
    expect(ledger.get("bid", 20)).toMatchObject({ hiddenTraded: 1.5, cancelled: 2 });
    // A shrink at 100.5 itself, then a late fill at 100.5: that one is reclaimed.
    ledger.applyDelta({ ts: 1_300, bids: [["100.5", "4.0"]] });
    ledger.applyTrade({ ts: 1_300, price: "100.5", size: "0.6", side: "sell", late: true });
    expect(ledger.get("bid", 20)).toMatchObject({ cancelled: 2.4, tradedVisible: 0.6, reclaimed: 0.6 });
  });

  test("accepts numbers as well as decimal strings", () => {
    const ledger = createLevelLedger();
    ledger.seed({ ts: 1_000, bids: [[99, 1]] });
    ledger.applyTrade({ ts: 1_050, price: 99, size: 0.25, side: "sell" });
    ledger.applyDelta({ ts: 1_100, bids: [[99, 0.75]] });
    expect(ledger.get("bid", 99)).toMatchObject({ size: 0.75, tradedVisible: 0.25 });
  });
});
