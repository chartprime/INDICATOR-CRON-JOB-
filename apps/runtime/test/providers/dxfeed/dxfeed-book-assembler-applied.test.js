const { createDxFeedOrderBookAssembler } = require("../../../src/providers/dxfeed/dxfeed-book-assembler");

const SNAPSHOT_BEGIN = 0x04;
const SNAPSHOT_END = 0x08;
const TX_PENDING = 0x01;

function envelope(payload) {
  return { provider: "DXFEED", eventType: "ORDER", providerSymbol: "/NQZ26:XCME", assetClass: "FUTURE", payload: { scope: "ORDER", source: "GLBX", side: "BUY", size: 1, price: 100, eventFlags: 0, ...payload } };
}

function assemblerWith(onApplied) {
  return createDxFeedOrderBookAssembler({ expectedSymbol: "/NQZ26:XCME", expectedAssetClass: "FUTURE", expectedSource: "GLBX", onApplied });
}

describe("dxfeed-book-assembler onApplied tap", () => {
  test("a completed snapshot hands every applied event over once, flagged as a snapshot, in order", () => {
    const calls = [];
    const assembler = assemblerWith((events, meta) => calls.push({ events, meta }));
    assembler.applyEvent(envelope({ index: "1", eventFlags: SNAPSHOT_BEGIN, action: "NEW", price: 100, size: 2 }));
    expect(calls).toEqual([]);
    assembler.applyEvent(envelope({ index: "2", eventFlags: SNAPSHOT_END, action: "NEW", price: 101, size: 3, side: "SELL" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].meta).toEqual({ snapshot: true });
    expect(calls[0].events.map((event) => [event.index, event.action, event.price, event.size])).toEqual([["1", "NEW", 100, 2], ["2", "NEW", 101, 3]]);
    expect(Object.isFrozen(calls[0].events[0])).toBe(true);
  });

  test("an incremental batch is handed over after the transaction ends, flagged as not a snapshot, and never while pending", () => {
    const calls = [];
    const assembler = assemblerWith((events, meta) => calls.push({ events, meta }));
    assembler.applyEvent(envelope({ index: "1", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, action: "NEW", price: 100, size: 10 }));
    assembler.applyEvent(envelope({ index: "1", eventFlags: TX_PENDING, action: "PARTIAL", price: 100, size: 4 }));
    expect(calls).toHaveLength(1);
    assembler.applyEvent(envelope({ index: "1", eventFlags: 0, action: "PARTIAL", price: 100, size: 10 }));
    expect(calls).toHaveLength(2);
    expect(calls[1].meta).toEqual({ snapshot: false });
    expect(calls[1].events.map((event) => [event.action, event.size])).toEqual([["PARTIAL", 4], ["PARTIAL", 10]]);
  });

  test("nothing is handed over before the first snapshot or when the batch is refused", () => {
    const calls = [];
    const assembler = assemblerWith((events, meta) => calls.push({ events, meta }));
    assembler.applyEvent(envelope({ index: "1", eventFlags: 0, action: "NEW", price: 100, size: 1 }));
    expect(calls).toEqual([]);
    assembler.applyEvent({ state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD" });
    expect(calls).toEqual([]);
  });

  test("the option is optional and must be a function when given", () => {
    expect(() => assemblerWith(undefined)).not.toThrow();
    expect(() => assemblerWith(null)).not.toThrow();
    expect(() => assemblerWith("tap")).toThrow(/onApplied/);
  });
});
