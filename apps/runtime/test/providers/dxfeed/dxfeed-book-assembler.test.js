const {
  createDxFeedOrderBookAssembler,
  DEFAULT_MAX_RETAINED_ORDERS,
  DEFAULT_CROSSED_GRACE_MS,
} = require("../../../src/providers/dxfeed/dxfeed-book-assembler");

const SNAPSHOT_BEGIN = 0x04;
const SNAPSHOT_END = 0x08;
const SNAPSHOT_SNIP = 0x10;
const TX_PENDING = 0x01;
const REMOVE_EVENT = 0x02;

// Real field values (index, price, source, symbol-adjacent shape) captured
// live against this account's own dxFeed connection --
// docs/architecture/dxfeed/DX1.02-dxfeed-capability-probe-evidence.md's GLBX futures
// Order sample. That real sample's own action was EXECUTE (a removal),
// which wouldn't populate a book by itself, so the anchor test below uses
// action: "NEW" with the same real price/source/index-shape instead.
const REAL_ANCHOR_INDEX = "5137554220647461001";
const REAL_ANCHOR_PRICE = 7671.75;
const REAL_ANCHOR_SOURCE = "GLBX";

function orderEvent({ index, eventFlags, action, price, size = null, side = "BUY", source = "NTV", scope = "ORDER" }) {
  return { payload: { index, eventFlags, action, price, size, side, scope, source } };
}

function degradedEvent() {
  return { state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD" };
}

describe("dxfeed-book-assembler", () => {
  test("pins a production book to one canonical symbol, asset class, and source", () => {
    const assembler = createDxFeedOrderBookAssembler({
      expectedSymbol: "/NQZ26:XCME",
      expectedAssetClass: "FUTURE",
      expectedSource: "GLBX",
    });
    const canonical = {
      provider: "DXFEED", eventType: "ORDER", providerSymbol: "/NQZ26:XCME", assetClass: "FUTURE",
      ...orderEvent({
        index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW",
        price: 100, size: 1, side: "BUY", source: "GLBX",
      }),
    };
    expect(assembler.applyEvent(canonical).status).toBe("READY");
    expect(assembler.applyEvent({ ...canonical, providerSymbol: "/ESZ26:XCME" }))
      .toEqual({ status: "UNAVAILABLE", reason: "IDENTITY_MISMATCH" });
    expect(assembler.applyEvent({ ...canonical, payload: { ...canonical.payload, source: "NTV" } }))
      .toEqual({ status: "UNAVAILABLE", reason: "IDENTITY_MISMATCH" });
  });

  test("requires the expected production identity as one complete, valid tuple", () => {
    expect(() => createDxFeedOrderBookAssembler({ expectedSymbol: "AAPL" })).toThrow(/supplied together/);
    expect(() => createDxFeedOrderBookAssembler({
      expectedSymbol: "AAPL", expectedAssetClass: "CRYPTO", expectedSource: "NTV",
    })).toThrow(/identity is invalid/);
  });

  test("starts BUFFERING before any snapshot has completed", () => {
    const assembler = createDxFeedOrderBookAssembler();
    expect(assembler.getState()).toEqual({ status: "BUFFERING" });
    expect(assembler.getStatus()).toEqual({ status: "BUFFERING" });
  });

  test("assembles a real single-event complete snapshot (SNAPSHOT_BEGIN+SNAPSHOT_END), anchored to this account's real captured GLBX sample", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const result = assembler.applyEvent(orderEvent({
      index: REAL_ANCHOR_INDEX, eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW",
      price: REAL_ANCHOR_PRICE, size: 3, side: "SELL", source: REAL_ANCHOR_SOURCE,
    }));
    expect(result).toEqual({
      status: "READY",
      book: { bids: [], asks: [[REAL_ANCHOR_PRICE, 3]], lastUpdateId: 1 },
    });
  });

  test("applyEventStatus returns status-only, applyEvent returns full state -- same convention as binance-book-assembler", () => {
    const assembler = createDxFeedOrderBookAssembler();
    expect(assembler.applyEventStatus(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY",
    }))).toEqual({ status: "READY" });
    expect(assembler.getStatus()).toEqual({ status: "READY" });
  });

  test("SNAPSHOT_SNIP rejects the incomplete snapshot and waits for a clean replacement", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const result = assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_SNIP, action: "NEW", price: 50, size: 1, side: "SELL",
    }));
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNIPPED_SNAPSHOT" });

    const recovered = assembler.applyEvent(orderEvent({
      index: "2", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 51, size: 2, side: "SELL",
    }));
    expect(recovered.book.asks).toEqual([[51, 2]]);
  });

  test("buffers a multi-event TX_PENDING transaction and applies it atomically only once TX_PENDING clears", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));

    expect(assembler.applyEventStatus(orderEvent({ index: "2", eventFlags: TX_PENDING, action: "NEW", price: 101, size: 2, side: "BUY" })))
      .toEqual({ status: "READY" });
    expect(assembler.getState().book.bids).toEqual([[100, 1]]);

    const afterTx = assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 102, size: 3, side: "BUY" }));
    expect(afterTx.book.bids).toEqual([[102, 3], [101, 2], [100, 1]]);
  });

  test("does not discard a snapshot whose SNAPSHOT_END also carries TX_PENDING", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY",
    }));
    assembler.applyEvent(orderEvent({
      index: "2", eventFlags: SNAPSHOT_END | TX_PENDING, action: "NEW", price: 101, size: 2, side: "BUY",
    }));

    expect(assembler.getStatus()).toEqual({ status: "BUFFERING" });

    const completed = assembler.applyEvent(orderEvent({
      index: "2", eventFlags: 0, action: "MODIFY", price: 101, size: 3, side: "BUY",
    }));

    expect(completed.status).toBe("READY");
    expect(completed.book.bids).toEqual([[101, 3], [100, 1]]);
  });

  test("fails closed when a pending snapshot or transaction exceeds its bounded capacity", () => {
    const assembler = createDxFeedOrderBookAssembler({ maxPendingEvents: 2 });
    assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | TX_PENDING, action: "NEW", price: 100, size: 1,
    }));
    assembler.applyEvent(orderEvent({
      index: "2", eventFlags: TX_PENDING, action: "NEW", price: 101, size: 1,
    }));
    const result = assembler.applyEvent(orderEvent({
      index: "3", eventFlags: TX_PENDING, action: "NEW", price: 102, size: 1,
    }));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "PENDING_EVENT_LIMIT_EXCEEDED" });
  });

  test("rejects an invalid pending-event capacity", () => {
    expect(() => createDxFeedOrderBookAssembler({ maxPendingEvents: 0 })).toThrow(/maxPendingEvents/);
  });

  test("fails closed when retained live Order-v2 state exceeds its bounded capacity, then requires a replacement snapshot", () => {
    const assembler = createDxFeedOrderBookAssembler({ maxRetainedOrders: 2 });
    const initial = assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1,
    }));
    expect(initial.status).toBe("READY");

    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 99, size: 1 }));
    const overflow = assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 98, size: 1 }));
    expect(overflow).toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAP_EXCEEDED" });
    expect(assembler.getState()).toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAP_EXCEEDED" });
    expect(DEFAULT_MAX_RETAINED_ORDERS).toBe(250_000);

    const recovered = assembler.applyEvent(orderEvent({
      index: "4", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 101, size: 1,
    }));
    expect(recovered).toEqual({ status: "READY", book: { bids: [[101, 1]], asks: [], lastUpdateId: 4 } });
  });

  test("does not publish an oversized complete snapshot even momentarily", () => {
    const assembler = createDxFeedOrderBookAssembler({ maxRetainedOrders: 2 });
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1 }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 99, size: 1 }));
    expect(assembler.applyEvent(orderEvent({
      index: "3", eventFlags: SNAPSHOT_END, action: "NEW", price: 98, size: 1,
    }))).toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAP_EXCEEDED" });
  });

  test("an out-of-band capture fault clears retained state and requires a fresh snapshot", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1,
    }));
    expect(assembler.invalidate("ORDER_CAPTURE_ERROR")).toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR" });
    expect(assembler.getState()).toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR" });

    expect(assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1 })))
      .toEqual({ status: "UNAVAILABLE", reason: "ORDER_CAPTURE_ERROR" });
    expect(assembler.applyEvent(orderEvent({
      index: "3", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 102, size: 1,
    }))).toEqual({ status: "READY", book: { bids: [[102, 1]], asks: [], lastUpdateId: 3 } });
  });

  test("rejects an invalid retained-order capacity", () => {
    expect(() => createDxFeedOrderBookAssembler({ maxRetainedOrders: 0 })).toThrow(/maxRetainedOrders/);
  });

  test("a second SNAPSHOT_BEGIN arriving mid-buffer discards the first partial snapshot's pending events unconditionally", () => {
    const assembler = createDxFeedOrderBookAssembler();
    expect(assembler.applyEventStatus(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" })))
      .toEqual({ status: "BUFFERING" });
    const restarted = assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 200, size: 5, side: "BUY" }));
    expect(restarted.book.bids).toEqual([[200, 5]]);
  });

  test("TRADE and BUST never mutate book state, even with price:0 and a real resting order present", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    for (const action of ["TRADE", "BUST"]) {
      const before = assembler.getState();
      const after = assembler.applyEvent(orderEvent({ index: "999", eventFlags: 0, action, price: 0, size: null, side: "SELL" }));
      expect(after.status).toBe("READY");
      expect(after.book.bids).toEqual(before.book.bids);
      expect(after.book.asks).toEqual(before.book.asks);
    }
  });

  test("a TRADE record with price 0, no size and side UNDEFINED, as GLBX sends it inside a snapshot, is a no-op rather than an invalidation", () => {
    // Recorded on /NQZ26:XCME on 2026-09-07: the snapshot's second-to-last event, followed by the usual
    // REMOVE_EVENT | SNAPSHOT_END marker (a COMPOSITE-scope record with no price). Rejecting the TRADE
    // record kept the NQ book UNAVAILABLE for the whole session while ES, whose snapshot had none, was fine.
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 29618.75, size: 2, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 29619, size: 1, side: "SELL" }));
    const afterTrade = assembler.applyEvent(orderEvent({ index: "5137554220647448577", eventFlags: 0, action: "TRADE", price: 0, size: null, side: "UNDEFINED" }));
    expect(afterTrade.status).toBe("BUFFERING");
    const done = assembler.applyEvent(orderEvent({ index: "5137554220647448576", eventFlags: REMOVE_EVENT | SNAPSHOT_END, action: "UNDEFINED", price: null, size: null, side: "UNDEFINED", scope: "COMPOSITE" }));
    expect(done.status).toBe("READY");
    expect(done.book.bids).toEqual([[29618.75, 2]]);
    expect(done.book.asks).toEqual([[29619, 1]]);
    // A BUST is the same kind of record.
    const afterBust = assembler.applyEvent(orderEvent({ index: "7", eventFlags: 0, action: "BUST", price: 0, size: null, side: "UNDEFINED" }));
    expect(afterBust.status).toBe("READY");
    expect(afterBust.book.bids).toEqual([[29618.75, 2]]);
  });

  test("REPLACE upserts by the same stable index rather than requiring a separate remove+reinsert", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 3, side: "BUY" }));
    const replaced = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "REPLACE", price: 105, size: 2, side: "BUY" }));
    expect(replaced.book.bids).toEqual([[105, 2]]);
  });

  test("MODIFY and PARTIAL update size in place without duplicating the level", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 10, side: "SELL" }));
    const modified = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "MODIFY", price: 100, size: 6, side: "SELL" }));
    expect(modified.book.asks).toEqual([[100, 6]]);
    const partial = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "PARTIAL", price: 100, size: 2, side: "SELL" }));
    expect(partial.book.asks).toEqual([[100, 2]]);
  });

  test("DELETE and EXECUTE remove the order regardless of a real-shaped null size", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    const afterDelete = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "DELETE", price: 100, size: null, side: "BUY" }));
    expect(afterDelete.book.bids).toEqual([[100, 1]]);
    const afterExecute = assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "EXECUTE", price: 100, size: null, side: "BUY" }));
    expect(afterExecute.book.bids).toEqual([]);
  });

  test("aggregates two distinct orders at the same price level, and removing one leaves the other's contribution intact", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 3, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 100, size: 4, side: "BUY" }));
    expect(assembler.getState().book.bids).toEqual([[100, 7]]);
    const afterRemove = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "DELETE", price: 100, size: null, side: "BUY" }));
    expect(afterRemove.book.bids).toEqual([[100, 4]]);
  });

  test("UNDEFINED action falls back to the generic REMOVE_EVENT flag rule", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    const removed = assembler.applyEvent(orderEvent({ index: "1", eventFlags: REMOVE_EVENT, action: "UNDEFINED", price: 100, size: null, side: "BUY" }));
    expect(removed.book.bids).toEqual([]);

    assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 150, size: 2, side: "BUY" }));
    const upserted = assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "UNDEFINED", price: 160, size: 4, side: "BUY" }));
    expect(upserted.book.bids).toEqual([[160, 4]]);
  });

  test("accepts a structural empty-snapshot removal without requiring irrelevant price, size, side, or scope fields", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const result = assembler.applyEvent({
      payload: {
        index: "0",
        eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END | REMOVE_EVENT,
        source: "NTV",
      },
    });

    expect(result).toEqual({ status: "READY", book: { bids: [], asks: [], lastUpdateId: 1 } });
  });

  test("REMOVE_EVENT overrides a contradictory business action, because the index is the event's only meaningful field", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));

    const removed = assembler.applyEvent(orderEvent({
      index: "1", eventFlags: REMOVE_EVENT, action: "NEW", price: 999, size: 999, side: "SELL",
    }));

    expect(removed.book.bids).toEqual([]);
    expect(removed.book.asks).toEqual([]);
  });

  test("a zero or NaN-normalized size removes an existing ordinary order instead of creating a zero-quantity price level", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 5, side: "BUY" }));

    expect(assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "MODIFY", price: 100, size: 0, side: "BUY" })).book.bids)
      .toEqual([]);

    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 101, size: 5, side: "BUY" }));
    expect(assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "MODIFY", price: 101, size: null, side: "BUY" })).book.bids)
      .toEqual([]);
  });

  test("a source mismatch mid-stream hard-fails to UNAVAILABLE(SOURCE_MISMATCH) rather than silently mixing sources", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY", source: "GLBX" }));
    const result = assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "BUY", source: "NTV" }));
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SOURCE_MISMATCH" });
  });

  test("a crossed book (bestBid >= bestAsk) hard-fails to UNAVAILABLE(CROSSED_BOOK) and resets", () => {
    const assembler = createDxFeedOrderBookAssembler();
    expect(assembler.applyEventStatus(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" })))
      .toEqual({ status: "BUFFERING" });
    const crossed = assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 99, size: 1, side: "SELL" }));
    expect(crossed).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(assembler.getState()).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
  });

  test("a cross that the next events undo inside the grace heals on its own, with the book intact", () => {
    let clock = 1_000;
    const assembler = createDxFeedOrderBookAssembler({ now: () => clock, crossedGraceMs: 2_000 });
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" }));
    const ready = assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 2, side: "SELL" }));
    expect(ready.status).toBe("READY");
    const versionBefore = assembler.getVersion();
    // A bid lands above the ask: the ghost of a delete that has not arrived yet.
    const crossed = assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 102, size: 1, side: "BUY" }));
    expect(crossed).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(assembler.needsSnapshot()).toBe(false);
    // 1.5 s later the delete arrives: the book is whole again, no snapshot needed.
    clock += 1_500;
    const healed = assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "DELETE", price: 102, size: null, side: "BUY" }));
    expect(healed.status).toBe("READY");
    expect(healed.book.bids).toEqual([[100, 1]]);
    expect(healed.book.asks).toEqual([[101, 2]]);
    expect(assembler.getVersion()).toBeGreaterThan(versionBefore);
  });

  test("the default grace outlasts the longest self-healing cross seen in real GLBX capture (14 s), so it keeps the book", () => {
    // Replaying NQ and ES in arrival order (2026-09-08 14:00-15:00Z), every
    // cross over 10 s cleared on its own within 12-14 s, when the late update
    // of the stale order arrived. A 2 s grace threw the book away each time.
    let clock = 1_000;
    const assembler = createDxFeedOrderBookAssembler({ now: () => clock });
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 2, side: "SELL" }));
    assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 102, size: 1, side: "BUY" }));
    clock += 14_000;
    expect(assembler.applyEvent(orderEvent({ index: "4", eventFlags: 0, action: "NEW", price: 104, size: 1, side: "SELL" }))).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(assembler.needsSnapshot()).toBe(false);
    const healed = assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "DELETE", price: 102, size: null, side: "BUY" }));
    expect(healed.status).toBe("READY");
    expect(healed.book.bids).toEqual([[100, 1]]);
    expect(healed.book.asks).toEqual([[101, 2], [104, 1]]);
    expect(DEFAULT_CROSSED_GRACE_MS).toBeGreaterThanOrEqual(15_000);
  });

  test("a cross that outlives the grace throws the book away and asks for a snapshot; a zero grace is the old instant reset", () => {
    let clock = 1_000;
    const assembler = createDxFeedOrderBookAssembler({ now: () => clock, crossedGraceMs: 2_000 });
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 2, side: "SELL" }));
    assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 102, size: 1, side: "BUY" }));
    expect(assembler.needsSnapshot()).toBe(false);
    clock += 2_000;
    // Still crossed when the grace ends: reset for good.
    const reset = assembler.applyEvent(orderEvent({ index: "4", eventFlags: 0, action: "NEW", price: 103, size: 1, side: "SELL" }));
    expect(reset).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(assembler.needsSnapshot()).toBe(true);
    // Incremental events change nothing now; only a snapshot cycle recovers it.
    expect(assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "DELETE", price: 102, size: null, side: "BUY" }))).toEqual({ status: "UNAVAILABLE", reason: "CROSSED_BOOK" });
    expect(assembler.needsSnapshot()).toBe(true);
    const recovered = assembler.applyEvent(orderEvent({ index: "9", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 200, size: 5, side: "SELL" }));
    expect(recovered.status).toBe("READY");
    expect(assembler.needsSnapshot()).toBe(false);

    const instant = createDxFeedOrderBookAssembler({ crossedGraceMs: 0 });
    instant.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    instant.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 99, size: 1, side: "SELL" }));
    expect(instant.needsSnapshot()).toBe(true);
    expect(() => createDxFeedOrderBookAssembler({ crossedGraceMs: -1 })).toThrow(/crossedGraceMs/);
  });

  test("hands out the levels that changed since the last drain, with their sizes now, and forgets them", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 99, size: 2, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "3", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 3, side: "SELL" }));
    // The snapshot itself counts as a change of everything it holds; a first drain hands it all over.
    expect(assembler.getSnapshotCount()).toBe(1);
    expect(assembler.drainLevelChanges()).toEqual({ bids: [[100, 1], [99, 2]], asks: [[101, 3]] });
    expect(assembler.drainLevelChanges()).toEqual({ bids: [], asks: [] });
    // A second order joins 100, the 99 leaves, a new ask appears: three changed levels, final sizes.
    assembler.applyEvent(orderEvent({ index: "4", eventFlags: 0, action: "NEW", price: 100, size: 4, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "DELETE", price: 99, size: null, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "5", eventFlags: 0, action: "NEW", price: 102, size: 7, side: "SELL" }));
    expect(assembler.drainLevelChanges()).toEqual({ bids: [[100, 5], [99, 0]], asks: [[102, 7]] });
    expect(assembler.getBestPrices()).toEqual({ bestBid: 100, bestAsk: 101 });
    // A new snapshot bumps the count and starts the changes over.
    assembler.applyEvent(orderEvent({ index: "9", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 200, size: 1, side: "BUY" }));
    expect(assembler.getSnapshotCount()).toBe(2);
    expect(assembler.drainLevelChanges()).toEqual({ bids: [[200, 1]], asks: [] });
  });

  test("the top of the book comes without sorting the rest and matches the head of the full sorted book", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const prices = [100, 95, 99.5, 97, 98, 99, 96];
    prices.forEach((price, i) => assembler.applyEvent(orderEvent({ index: String(i + 1), eventFlags: i === 0 ? SNAPSHOT_BEGIN : 0, action: "NEW", price, size: i + 1, side: "BUY" })));
    const asks = [101, 105, 100.5, 103];
    asks.forEach((price, i) => assembler.applyEvent(orderEvent({ index: String(20 + i), eventFlags: i === asks.length - 1 ? SNAPSHOT_END : 0, action: "NEW", price, size: 1, side: "SELL" })));
    const full = assembler.getState();
    const top = assembler.getTopOfBook(3);
    expect(top.status).toBe("READY");
    expect(top.book.bids).toEqual(full.book.bids.slice(0, 3));
    expect(top.book.asks).toEqual(full.book.asks.slice(0, 3));
    expect(top.book.bids).toEqual([[100, 1], [99.5, 3], [99, 6]]);
    expect(top.book.lastUpdateId).toBe(full.book.lastUpdateId);
    expect(top.book).toEqual(expect.objectContaining({ bestBid: 100, bestAsk: 100.5 }));
    expect(assembler.getTopOfBook(0).book.bids).toEqual([]);
    expect(() => assembler.getTopOfBook(-1)).toThrow(/depth/);
    const empty = createDxFeedOrderBookAssembler();
    expect(empty.getTopOfBook(5)).toEqual({ status: "BUFFERING" });
  });

  test("a degraded/malformed upstream envelope hard-fails to UNAVAILABLE(UPSTREAM_EVENT_UNAVAILABLE)", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    const result = assembler.applyEvent(degradedEvent());
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects a non-ORDER scope defensively rather than corrupting the order-keyed map", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const result = assembler.applyEvent(orderEvent({
      index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY", scope: "COMPOSITE",
    }));
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects a non-BigInt-parseable or oversized index string", () => {
    const assembler = createDxFeedOrderBookAssembler();
    for (const badIndex of ["", "-5", "12x34", "1".repeat(21), null, undefined, 42]) {
      const result = assembler.applyEvent(orderEvent({ index: badIndex, eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
    }
  });

  test("caches the sorted book and only recomputes when the version actually changes", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    const first = assembler.getState();
    const second = assembler.getState();
    expect(first.book).toBe(second.book);
    const third = assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "BUY" }));
    expect(third.book).not.toBe(first.book);
  });

  test("bids sort strictly descending and asks strictly ascending regardless of insertion order", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 98, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 100, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "3", eventFlags: 0, action: "NEW", price: 99, size: 1, side: "BUY" }));
    assembler.applyEvent(orderEvent({ index: "4", eventFlags: 0, action: "NEW", price: 103, size: 1, side: "SELL" }));
    assembler.applyEvent(orderEvent({ index: "5", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "SELL" }));
    const state = assembler.applyEvent(orderEvent({ index: "6", eventFlags: SNAPSHOT_END, action: "NEW", price: 102, size: 1, side: "SELL" }));
    expect(state.book.bids.map(([price]) => price)).toEqual([100, 99, 98]);
    expect(state.book.asks.map(([price]) => price)).toEqual([101, 102, 103]);
  });

  test("an incremental (non-snapshot) event arriving before any snapshot has ever completed is silently ignored, not applied to an uninitialized book", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const result = assembler.applyEvent(orderEvent({ index: "1", eventFlags: 0, action: "NEW", price: 100, size: 1, side: "BUY" }));
    expect(result).toEqual({ status: "BUFFERING" });
    const ready = assembler.applyEvent(orderEvent({ index: "2", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 200, size: 2, side: "BUY" }));
    expect(ready.book.bids).toEqual([[200, 2]]);
  });

  test("recovers cleanly after a hard reset (SOURCE_MISMATCH or CROSSED_BOOK) once a fresh valid snapshot cycle arrives", () => {
    const assembler = createDxFeedOrderBookAssembler();
    assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY", source: "GLBX" }));
    const mismatched = assembler.applyEvent(orderEvent({ index: "2", eventFlags: 0, action: "NEW", price: 101, size: 1, side: "BUY", source: "NTV" }));
    expect(mismatched).toEqual({ status: "UNAVAILABLE", reason: "SOURCE_MISMATCH" });

    const recovered = assembler.applyEvent(orderEvent({ index: "3", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 300, size: 5, side: "SELL", source: "NTV" }));
    expect(recovered.status).toBe("READY");
    expect(recovered.book).toEqual({ bids: [], asks: [[300, 5]], lastUpdateId: 3 });
  });

  test("a second complete snapshot arriving after the book is already READY replaces the book wholesale, not merges with the prior one", () => {
    const assembler = createDxFeedOrderBookAssembler();
    const first = assembler.applyEvent(orderEvent({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 1, side: "BUY" }));
    expect(first.book.bids).toEqual([[100, 1]]);

    // A partially rebuilt snapshot is not publishable: exposing the previous
    // book as current would conceal that the upstream source is replacing it.
    const midRebuild = assembler.applyEventStatus(orderEvent({ index: "2", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 999, size: 9, side: "BUY" }));
    expect(midRebuild).toEqual({ status: "BUFFERING" });
    expect(assembler.getState()).toEqual({ status: "BUFFERING" });

    // This event carries SNAPSHOT_END, completing the transaction that began
    // above -- both event "2" and event "3" are pending members of that SAME
    // snapshot and get applied together, wholesale replacing index "1"'s
    // book entirely (it is not present in either "2" or "3", so it is gone).
    const second = assembler.applyEvent(orderEvent({ index: "3", eventFlags: SNAPSHOT_END, action: "NEW", price: 150, size: 4, side: "BUY" }));
    expect(second.book.bids).toEqual([[999, 9], [150, 4]]);
  });
  // L1L2-V2-021. Level sizes were aggregated by incremental float add/subtract,
  // and a level was deleted only when its running total fell to <= 0. Fractional
  // equity sizes do not sum back to exactly zero: 0.1 + 0.2 - 0.1 - 0.2 leaves
  // 2.78e-17, so a fully-drained level survived as dust. That dust is a real
  // price with essentially no size, and because it is the highest bid it became
  // the *published best bid* -- halving the displayed spread -- while the levels
  // map grew by one permanent entry for every price that ever drained. Futures
  // were immune (integer contract counts are exact in doubles); equities were
  // not. Levels now track how many orders back them and are deleted when that
  // count reaches zero, which is exact and needs no epsilon.
  describe("fully-drained price levels (L1L2-V2-021)", () => {
    function equityBook() {
      const assembler = createDxFeedOrderBookAssembler({
        expectedSymbol: "AAPL", expectedAssetClass: "EQUITY", expectedSource: "NTV",
      });
      const wrap = (payload) => ({
        provider: "DXFEED", eventType: "ORDER", providerSymbol: "AAPL", assetClass: "EQUITY", ...payload,
      });
      return {
        apply: (o) => assembler.applyEventStatus(wrap(orderEvent({ source: "NTV", ...o }))),
        state: () => assembler.getState(),
      };
    }

    test("a level drained by fractional-size orders is removed, not left as float dust", () => {
      const book = equityBook();
      book.apply({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 0.003142, side: "BUY" });
      book.apply({ index: "2", eventFlags: 0, action: "NEW", price: 100, size: 0.01444, side: "BUY" });
      book.apply({ index: "3", eventFlags: 0, action: "NEW", price: 99, size: 5, side: "BUY" });
      book.apply({ index: "4", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 1, side: "SELL" });

      book.apply({ index: "1", eventFlags: 0, action: "DELETE", price: 100, size: 0.003142, side: "BUY" });
      book.apply({ index: "2", eventFlags: 0, action: "DELETE", price: 100, size: 0.01444, side: "BUY" });

      expect(book.state().book.bids).toEqual([[99, 5]]);
    });

    test("best bid falls through to the next real level rather than sticking on a drained one", () => {
      const book = equityBook();
      book.apply({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 0.1, side: "BUY" });
      book.apply({ index: "2", eventFlags: 0, action: "NEW", price: 100, size: 0.2, side: "BUY" });
      book.apply({ index: "3", eventFlags: 0, action: "NEW", price: 99, size: 5, side: "BUY" });
      book.apply({ index: "4", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 1, side: "SELL" });
      book.apply({ index: "1", eventFlags: 0, action: "DELETE", price: 100, size: 0.1, side: "BUY" });
      book.apply({ index: "2", eventFlags: 0, action: "DELETE", price: 100, size: 0.2, side: "BUY" });

      const state = book.state();
      // The true spread is 99 -> 101, not 100 -> 101.
      expect(state.book.bids[0]).toEqual([99, 5]);
      expect(state.book.asks[0]).toEqual([101, 1]);
    });

    test("retained levels do not grow as prices are repeatedly filled and drained", () => {
      const book = equityBook();
      book.apply({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 1, size: 1, side: "BUY" });
      book.apply({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 100000, size: 1, side: "SELL" });
      for (let i = 0; i < 200; i += 1) {
        const price = 1000 + i;
        const a = String(1000000 + i * 2);
        const b = String(1000001 + i * 2);
        book.apply({ index: a, eventFlags: 0, action: "NEW", price, size: 0.1, side: "BUY" });
        book.apply({ index: b, eventFlags: 0, action: "NEW", price, size: 0.2, side: "BUY" });
        book.apply({ index: a, eventFlags: 0, action: "DELETE", price, size: 0.1, side: "BUY" });
        book.apply({ index: b, eventFlags: 0, action: "DELETE", price, size: 0.2, side: "BUY" });
      }
      expect(book.state().book.bids).toEqual([[1, 1]]);
    });

    test("a partially-drained level keeps its remaining orders and size", () => {
      const book = equityBook();
      book.apply({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 2, side: "BUY" });
      book.apply({ index: "2", eventFlags: 0, action: "NEW", price: 100, size: 3, side: "BUY" });
      book.apply({ index: "3", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 1, side: "SELL" });
      book.apply({ index: "1", eventFlags: 0, action: "DELETE", price: 100, size: 2, side: "BUY" });
      expect(book.state().book.bids).toEqual([[100, 3]]);
    });
  });
});

// L1L2-V2-022. dxFeed L2 had no contract at all while Binance L2 had two
// versioned ones, so none of these reason codes was documented anywhere. The
// contract now exists; this keeps it from drifting the way the Binance
// canonical-event contract did (L1L2-V2-012), by deriving the emitted set from
// the source rather than trusting anyone to update three files together.
describe("reason vocabulary matches the published dxfeed-order-book/v1 contract", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const ASSEMBLER_PATH = path.join(
    __dirname, "..", "..", "..", "src", "providers", "dxfeed", "dxfeed-book-assembler.js",
  );
  const SCHEMA_PATH = path.join(
    __dirname, "..", "..", "..", "..", "..",
    "docs", "contracts", "dxfeed-order-book", "v1", "dxfeed-order-book-v1.schema.json",
  );

  function emittedReasons() {
    const source = fs.readFileSync(ASSEMBLER_PATH, "utf8");
    const direct = [...source.matchAll(/resetToUnavailable\(\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    // Supplied by the servers through invalidate() when raw-index correlation dies.
    return new Set([...direct, "ORDER_CAPTURE_ERROR"]);
  }

  function schemaReasons() {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    return new Set(schema.$defs.unavailable.properties.reason.enum);
  }

  test("every reason the assembler can emit is declared in the schema", () => {
    const undeclared = [...emittedReasons()].filter((r) => !schemaReasons().has(r)).sort();
    expect(undeclared).toEqual([]);
  });

  test("the schema declares no reason the assembler cannot emit", () => {
    const unreachable = [...schemaReasons()].filter((r) => !emittedReasons().has(r)).sort();
    expect(unreachable).toEqual([]);
  });

  test("the source-derived set is non-trivial, so a regex that stops matching fails loudly", () => {
    expect(emittedReasons().size).toBeGreaterThanOrEqual(8);
    expect(emittedReasons()).toContain("SNIPPED_SNAPSHOT");
  });
});
