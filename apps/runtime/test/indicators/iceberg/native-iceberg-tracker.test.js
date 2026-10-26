const fixture = require("../../fixtures/iceberg/native-trails.json");
const {
  createNativeIcebergTracker,
  NATIVE_STATUS,
  MAX_OPEN_LIVES,
} = require("../../../src/indicators/iceberg/native-iceberg-tracker");

const STATUS_BY_END = Object.freeze({ EXECUTE: "filled", DELETE: "pulled", NEW_OVER: "replaced", REPLACED: "replaced" });

function feed(tracker, events) {
  const updates = [];
  for (const event of events) {
    const { receivedAt, ...payload } = event;
    const update = tracker.apply(Object.freeze(payload), receivedAt);
    if (update) updates.push(update);
  }
  return updates;
}

function firstRefillAt(events) {
  let size = null;
  for (const event of events) {
    if (event.action === "NEW") { size = event.size; continue; }
    if (event.action === "PARTIAL" && size !== null && event.size > size) return event.receivedAt;
    if (event.size !== null) size = event.size;
  }
  return null;
}

describe("indicators/iceberg/native-iceberg-tracker", () => {
  describe("every captured native iceberg is recovered from its slot trail", () => {
    for (const iceberg of fixture.icebergs) {
      test(`${iceberg.name}: ${iceberg.refills} refills, ${iceberg.executed} lots, ends ${iceberg.endAction}`, () => {
        const tracker = createNativeIcebergTracker({ symbol: iceberg.symbol });
        const updates = feed(tracker, iceberg.events);
        expect(updates.length).toBeGreaterThan(0);
        const last = updates[updates.length - 1];
        expect(last.kind).toBe("native");
        expect(last.confidence).toBe("certain");
        expect(last.symbol).toBe(iceberg.symbol);
        expect(last.side).toBe(iceberg.side === "BUY" ? "bid" : "ask");
        expect(last.price).toBe(iceberg.price);
        expect(last.display).toBe(iceberg.display);
        expect(last.tranches).toBe(iceberg.refills + 1);
        expect(last.executed).toBe(iceberg.executed);
        expect(last.status).toBe(STATUS_BY_END[iceberg.endAction]);
        expect(last.startedAt).toBe(iceberg.events[0].receivedAt);
        expect(last.firstRefillAt).toBe(firstRefillAt(iceberg.events));
        expect(updates[0].firstRefillAt).toBe(updates[0].updatedAt);
        expect(updates[0].tranches).toBe(2);
        for (let i = 1; i < updates.length; i += 1) {
          expect(updates[i].executed).toBeGreaterThanOrEqual(updates[i - 1].executed);
          expect(updates[i].id).toBe(updates[0].id);
        }
        expect(Object.isFrozen(last)).toBe(true);
        expect(tracker.active()).toHaveLength(0);
      });
    }
  });

  describe("ordinary slot lives never become icebergs", () => {
    for (const [name, control] of Object.entries(fixture.controls)) {
      test(`${name} emits nothing`, () => {
        const tracker = createNativeIcebergTracker({ symbol: control.symbol });
        expect(feed(tracker, control.events)).toHaveLength(0);
        expect(tracker.active()).toHaveLength(0);
      });
    }
  });

  describe("the refill rule", () => {
    const symbol = "/NQZ26:XCME";
    const index = "5137554220647450000";
    const ev = (action, size, extra = {}) => Object.freeze({ index, eventFlags: 0, action, price: 31000, size, side: "BUY", source: "GLBX", ...extra });

    test("a size-raising PARTIAL on the same slot and price is the first refill and the first update", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      expect(tracker.apply(ev("NEW", 10), 1000)).toBeNull();
      expect(tracker.apply(ev("PARTIAL", 4), 1001)).toBeNull();
      const update = tracker.apply(ev("PARTIAL", 10), 1001);
      expect(update).toMatchObject({ kind: "native", side: "bid", price: 31000, display: 10, tranches: 2, executed: 6, status: "active", startedAt: 1000, firstRefillAt: 1001, updatedAt: 1001 });
      expect(tracker.active()).toHaveLength(1);
    });

    test("a REPLACE or MODIFY that raises the size is the owner adding, not a refill", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 4), 1001);
      expect(tracker.apply(ev("REPLACE", 12), 1002)).toBeNull();
      expect(tracker.apply(ev("MODIFY", 15), 1003)).toBeNull();
      expect(tracker.active()).toHaveLength(0);
    });

    test("only PARTIAL decreases count as executed; a MODIFY down is a partial cancel", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("MODIFY", 7), 1001);
      tracker.apply(ev("PARTIAL", 2), 1002);
      const update = tracker.apply(ev("PARTIAL", 10), 1003);
      expect(update.executed).toBe(5);
      expect(update.display).toBe(10);
    });

    test("EXECUTE adds the remaining size and ends the iceberg as filled", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      const update = tracker.apply(ev("EXECUTE", null), 1002);
      expect(update).toMatchObject({ status: "filled", executed: 17, tranches: 2 });
      expect(tracker.active()).toHaveLength(0);
    });

    test("DELETE ends it as pulled with what went through", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      tracker.apply(ev("PARTIAL", 6), 1002);
      expect(tracker.apply(ev("DELETE", null), 1003)).toMatchObject({ status: "pulled", executed: 11 });
    });

    test("the remove event flag ends it like a DELETE whatever the action says", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      expect(tracker.apply(ev("PARTIAL", 10, { eventFlags: 2 }), 1002)).toMatchObject({ status: "pulled", executed: 7 });
      expect(tracker.active()).toHaveLength(0);
      expect(tracker.openLives()).toBe(0);
    });

    test("a NEW over a live iceberg ends it as replaced and starts a fresh life on the slot", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      expect(tracker.apply(ev("NEW", 5), 1002)).toMatchObject({ status: "replaced", executed: 7 });
      expect(tracker.apply(ev("PARTIAL", 1), 1003)).toBeNull();
      expect(tracker.apply(ev("PARTIAL", 5), 1003)).toMatchObject({ tranches: 2, executed: 4, startedAt: 1002 });
    });

    test("a price change on the slot ends the iceberg as replaced and the new price starts clean", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      expect(tracker.apply(ev("REPLACE", 10, { price: 31000.25 }), 1002)).toMatchObject({ status: "replaced", price: 31000 });
      expect(tracker.apply(ev("PARTIAL", 10, { price: 31000.25 }), 1003)).toBeNull();
    });

    test("a side switch on the slot ends the iceberg as replaced and the new side starts clean", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      expect(tracker.apply(ev("PARTIAL", 12, { side: "SELL" }), 1002)).toMatchObject({ status: "replaced", side: "bid", tranches: 2, executed: 7 });
      expect(tracker.active()).toHaveLength(0);
      expect(tracker.apply(ev("PARTIAL", 5, { side: "SELL" }), 1003)).toBeNull();
      expect(tracker.apply(ev("PARTIAL", 12, { side: "SELL" }), 1003)).toMatchObject({ side: "ask", tranches: 2, executed: 7, startedAt: 1002 });
    });

    test("a slot first seen through a REPLACE or PARTIAL starts a life there", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      expect(tracker.apply(ev("REPLACE", 8), 1000)).toBeNull();
      tracker.apply(ev("PARTIAL", 2), 1001);
      expect(tracker.apply(ev("PARTIAL", 8), 1001)).toMatchObject({ tranches: 2, executed: 6, startedAt: 1000, display: 8 });
    });

    test("TRADE and BUST bookkeeping and events without a size do not touch a life", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      expect(tracker.apply(Object.freeze({ index: "1", eventFlags: 0, action: "TRADE", price: 0, size: null, side: "UNDEFINED", source: "GLBX" }), 1001)).toBeNull();
      expect(tracker.apply(Object.freeze({ index: "1", eventFlags: 0, action: "BUST", price: 0, size: null, side: "UNDEFINED", source: "GLBX" }), 1001)).toBeNull();
      tracker.apply(ev("PARTIAL", 3), 1002);
      expect(tracker.apply(ev("PARTIAL", 10), 1002)).toMatchObject({ executed: 7 });
    });

    test("a PARTIAL with no size removes the order like the assembler does", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 10), 1001);
      expect(tracker.apply(ev("PARTIAL", null), 1002)).toMatchObject({ status: "pulled" });
      expect(tracker.apply(ev("PARTIAL", 0), 1003)).toBeNull();
    });

    test("display is the largest size the life ever showed", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      tracker.apply(ev("PARTIAL", 12), 1001);
      tracker.apply(ev("PARTIAL", 5), 1002);
      expect(tracker.apply(ev("PARTIAL", 9), 1002)).toMatchObject({ display: 12, tranches: 3, executed: 14 });
    });

    test("ids are stable for one life and distinct across lives on the same slot", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("NEW", 10), 1000);
      tracker.apply(ev("PARTIAL", 3), 1001);
      const first = tracker.apply(ev("PARTIAL", 10), 1001);
      const ended = tracker.apply(ev("EXECUTE", null), 1002);
      tracker.apply(ev("NEW", 10), 1003);
      tracker.apply(ev("PARTIAL", 3), 1004);
      const second = tracker.apply(ev("PARTIAL", 10), 1004);
      expect(ended.id).toBe(first.id);
      expect(second.id).not.toBe(first.id);
      expect(first.id).toBe(`${symbol}|${index}|1000`);
    });
  });

  describe("reset and bounds", () => {
    const symbol = "/ESZ26:XCME";
    const ev = (index, action, size, price = 7800) => Object.freeze({ index, eventFlags: 0, action, price, size, side: "SELL", source: "GLBX" });

    test("reset ends every open iceberg as interrupted and forgets every life", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      tracker.apply(ev("1", "NEW", 10), 1000);
      tracker.apply(ev("1", "PARTIAL", 3), 1001);
      tracker.apply(ev("1", "PARTIAL", 10), 1001);
      tracker.apply(ev("2", "NEW", 4), 1002);
      const ended = tracker.reset(2000);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ status: "interrupted", executed: 7, updatedAt: 2000 });
      expect(tracker.active()).toHaveLength(0);
      expect(tracker.openLives()).toBe(0);
      expect(tracker.apply(ev("1", "PARTIAL", 10), 2001)).toBeNull();
    });

    test("statuses are the closed vocabulary the frame will carry", () => {
      expect(NATIVE_STATUS).toEqual(["active", "filled", "pulled", "replaced", "interrupted"]);
      expect(Object.isFrozen(NATIVE_STATUS)).toBe(true);
    });

    test("open lives are bounded: past the cap the oldest ordinary life is dropped, icebergs are kept", () => {
      const tracker = createNativeIcebergTracker({ symbol, maxOpenLives: 3 });
      tracker.apply(ev("a", "NEW", 10), 1000);
      tracker.apply(ev("a", "PARTIAL", 3), 1001);
      tracker.apply(ev("a", "PARTIAL", 10), 1001);
      tracker.apply(ev("b", "NEW", 1), 1002);
      tracker.apply(ev("c", "NEW", 1), 1003);
      tracker.apply(ev("d", "NEW", 1), 1004);
      expect(tracker.openLives()).toBe(3);
      expect(tracker.active()).toHaveLength(1);
      expect(tracker.apply(ev("b", "PARTIAL", 1), 1005)).toBeNull();
      expect(tracker.apply(ev("a", "EXECUTE", null), 1006)).toMatchObject({ status: "filled" });
    });

    test("the default cap is a positive safe integer and the option must be one too", () => {
      expect(Number.isSafeInteger(MAX_OPEN_LIVES) && MAX_OPEN_LIVES > 0).toBe(true);
      expect(() => createNativeIcebergTracker({ symbol, maxOpenLives: 0 })).toThrow(/maxOpenLives/);
      expect(() => createNativeIcebergTracker({})).toThrow(/symbol/);
    });

    test("apply refuses a malformed event instead of guessing", () => {
      const tracker = createNativeIcebergTracker({ symbol });
      expect(() => tracker.apply(null, 1000)).toThrow(/event/);
      expect(() => tracker.apply(ev("1", "NEW", 10), -1)).toThrow(/receivedAt/);
      expect(() => tracker.apply(Object.freeze({ ...ev("1", "NEW", 10), index: 5 }), 1000)).toThrow(/index/);
    });
  });
});
