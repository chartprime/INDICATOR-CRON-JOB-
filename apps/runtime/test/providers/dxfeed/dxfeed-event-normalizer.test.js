const {
  normalizeDxFeedEvent,
  normalizeDxFeedOrderV2Event,
  resolveEventTimeMs,
  resolveVenue,
  parseFuturesVenue,
  isSafeNonNegativeInteger,
  resolveOrderIdentifier,
} = require("../../../src/providers/dxfeed/dxfeed-event-normalizer");

// Every raw payload below is a real message captured live against this
// account's dxFeed connection during DX1.02's capability probe (second
// run, apps/runtime/logs/verify-dxfeed-capability-probe-2026-08-24.log)
// -- not invented shapes. AAPL's Order/NTV sample stands in for TSLA's
// equity Order too: the log's raw evidence only captured one equity
// Order event (AAPL), though DX1.02's findings table confirms TSLA
// Order resolved identically (same source, same timing profile).
const REAL_FUTURE_QUOTE = {
  eventType: "Quote", eventSymbol: "/NQZ26:XCME", eventTime: 0, sequence: 0, timeNanoPart: 0,
  bidTime: 1787601544000, bidExchangeCode: "G", bidPrice: 29111.5, bidSize: 2,
  askTime: 1787601544000, askExchangeCode: "G", askPrice: 29112, askSize: 3,
};
const REAL_FUTURE_TRADE = {
  eventType: "Trade", eventSymbol: "/NQZ26:XCME", eventTime: 0, time: 1787601545023,
  timeNanoPart: 0, sequence: 813965, exchangeCode: "G", price: 29111.25, change: -276.5,
  size: 2, dayId: 20689, dayVolume: 498194, dayTurnover: 14520932907.93598,
  tickDirection: "ZERO_DOWN", extendedTradingHours: false,
};
const REAL_FUTURE_ORDER = {
  eventType: "Order", eventSymbol: "/NQZ26:XCME", eventTime: 0, eventFlags: 4,
  index: 5137554220647453000, time: 1787593843018, timeNanoPart: 0, sequence: 0,
  source: "GLBX", action: "EXECUTE", actionTime: 0, orderId: 0, auxOrderId: 0,
  price: 29139.75, size: "NaN", executedSize: "NaN", count: 0, exchangeCode: "G",
  side: "SELL", scope: "ORDER", tradeId: 0, tradePrice: "NaN", tradeSize: "NaN",
};
const REAL_EQUITY_QUOTE = {
  eventType: "Quote", eventSymbol: "AAPL", eventTime: 0, sequence: 0, timeNanoPart: 0,
  bidTime: 1787601576000, bidExchangeCode: "Q", bidPrice: 310.33, bidSize: 708,
  askTime: 1787601576000, askExchangeCode: "Q", askPrice: 310.35, askSize: 1203,
};
const REAL_EQUITY_TRADE = {
  eventType: "Trade", eventSymbol: "TSLA", eventTime: 0, time: 1787601599905,
  timeNanoPart: 0, sequence: 1122817, exchangeCode: "L", price: 349.03, change: -13.83,
  size: 120, dayId: 20689, dayVolume: 34651826.701307, dayTurnover: 12302399792.64278,
  tickDirection: "ZERO_UP", extendedTradingHours: true,
};
// Real /NQ TimeAndSale sample, captured live via verify-dxfeed-extended-probe.js
// (apps/runtime/logs/verify-dxfeed-extended-probe-2026-08-26.log), NEW type --
// this is the sample with no tradeId key at all and an index that exceeds
// Number.MAX_SAFE_INTEGER, both real findings from that run.
const REAL_FUTURE_TIMEANDSALE = {
  eventType: "TimeAndSale", eventSymbol: "/NQZ26:XCME", eventTime: 0, eventFlags: 0,
  index: 7678176778774447000, time: 1787714841502, timeNanoPart: 0, sequence: 66860,
  exchangeCode: "G", price: 29219, size: 1, bidPrice: 29219, askPrice: 29220,
  tradeThroughExempt: "", aggressorSide: "SELL", spreadLeg: false,
  extendedTradingHours: false, validTick: true, type: "NEW",
};
const REAL_EQUITY_ORDER = {
  eventType: "Order", eventSymbol: "AAPL", eventTime: 0, eventFlags: 4,
  index: 22047776527426936, time: 1787601590451, timeNanoPart: 0, sequence: 12,
  source: "NTV", action: "EXECUTE", actionTime: 0, orderId: 0, auxOrderId: 0,
  price: 310.48, size: "NaN", executedSize: "NaN", count: 0, exchangeCode: "Q",
  side: "SELL", scope: "ORDER", tradeId: 0, tradePrice: "NaN", tradeSize: "NaN",
  marketMaker: "NSDQ",
};

const RECEIVED_AT_MS = 1787601700000;

function normalize(assetClass, symbol, eventType, raw) {
  return normalizeDxFeedEvent(
    { assetClass, symbol, eventType, raw },
    { receivedAtMs: RECEIVED_AT_MS },
  );
}

function normalizeV2(assetClass, symbol, raw, rawIndexString) {
  return normalizeDxFeedOrderV2Event(
    { assetClass, symbol, raw, rawIndexString },
    { receivedAtMs: RECEIVED_AT_MS },
  );
}

describe("dxfeed-event-normalizer", () => {
  describe("QUOTE", () => {
    test("normalizes a real futures quote, venue parsed from the symbol suffix", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "QUOTE", REAL_FUTURE_QUOTE);
      expect(result).toEqual({
        provider: "DXFEED",
        venue: "XCME",
        assetClass: "FUTURE",
        providerSymbol: "/NQZ26:XCME",
        eventType: "QUOTE",
        eventTime: new Date(1787601544000).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          bidPrice: 29111.5, bidSize: 2, bidTime: 1787601544000, bidExchangeCode: "G",
          askPrice: 29112, askSize: 3, askTime: 1787601544000, askExchangeCode: "G",
        },
      });
    });

    test("normalizes a real equity quote, venue null at envelope level (no fake top-level venue)", () => {
      const result = normalize("EQUITY", "AAPL", "QUOTE", REAL_EQUITY_QUOTE);
      expect(result.venue).toBeNull();
      expect(result.assetClass).toBe("EQUITY");
      expect(result.payload.bidExchangeCode).toBe("Q");
    });

    test("eventTime is the max of bidTime/askTime when they differ", () => {
      const skewed = { ...REAL_FUTURE_QUOTE, askTime: 1787601544000 + 5000 };
      const result = normalize("FUTURE", "/NQZ26:XCME", "QUOTE", skewed);
      expect(result.eventTime).toBe(new Date(1787601544000 + 5000).toISOString());
    });

    test("degrades with missing askTime when only bid side is fully present", () => {
      const missingAskTime = { ...REAL_FUTURE_QUOTE };
      delete missingAskTime.askTime;
      const result = normalize("FUTURE", "/NQZ26:XCME", "QUOTE", missingAskTime);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("askTime");
    });
  });

  describe("TRADE", () => {
    test("normalizes a real futures trade", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "TRADE", REAL_FUTURE_TRADE);
      expect(result).toEqual({
        provider: "DXFEED",
        venue: "XCME",
        assetClass: "FUTURE",
        providerSymbol: "/NQZ26:XCME",
        eventType: "TRADE",
        eventTime: new Date(1787601545023).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          price: 29111.25, size: 2, time: 1787601545023, exchangeCode: "G",
          change: -276.5, dayVolume: 498194, dayTurnover: 14520932907.93598,
          tickDirection: "ZERO_DOWN", extendedTradingHours: false,
        },
      });
    });

    test("preserves a negative change value (trade prints can move price down)", () => {
      const result = normalize("EQUITY", "TSLA", "TRADE", REAL_EQUITY_TRADE);
      expect(result.payload.change).toBe(-13.83);
    });

    test("preserves extendedTradingHours: true explicitly, not just truthy", () => {
      const result = normalize("EQUITY", "TSLA", "TRADE", REAL_EQUITY_TRADE);
      expect(result.payload.extendedTradingHours).toBe(true);
    });

    test("degrades when price is missing", () => {
      const withoutPrice = { ...REAL_EQUITY_TRADE };
      delete withoutPrice.price;
      const result = normalize("EQUITY", "TSLA", "TRADE", withoutPrice);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("price");
    });

    test("degrades a padded exchange code instead of storing a semantically malformed identifier", () => {
      const result = normalize("EQUITY", "TSLA", "TRADE", { ...REAL_EQUITY_TRADE, exchangeCode: " L " });
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("exchangeCode");
    });

    test("rejects a zero size as invalid rather than coercing (trade size must be strictly positive)", () => {
      const zeroSize = { ...REAL_EQUITY_TRADE, size: 0 };
      const result = normalize("EQUITY", "TSLA", "TRADE", zeroSize);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("size");
    });
  });

  describe("ORDER", () => {
    test("normalizes a real futures order (GLBX source, no marketMaker)", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(result).toEqual({
        provider: "DXFEED",
        venue: "XCME",
        assetClass: "FUTURE",
        providerSymbol: "/NQZ26:XCME",
        eventType: "ORDER",
        eventTime: new Date(1787593843018).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          index: null, time: 1787593843018, action: "EXECUTE",
          orderId: 0, price: 29139.75, size: null, side: "SELL", scope: "ORDER",
          source: "GLBX",
        },
      });
    });

    test("normalizes a real equity order (NTV source, marketMaker present)", () => {
      const result = normalize("EQUITY", "AAPL", "ORDER", REAL_EQUITY_ORDER);
      expect(result.payload).toEqual({
        index: null, time: 1787601590451, action: "EXECUTE",
        orderId: 0, price: 310.48, size: null, side: "SELL", scope: "ORDER",
        source: "NTV", marketMaker: "NSDQ",
      });
      expect(result.venue).toBeNull();
    });

    test("maps the literal string \"NaN\" size to null, not a missing-field failure", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(result.state).toBeUndefined();
      expect(result.payload.size).toBeNull();
      expect(result.missingFields).toBeUndefined();
    });

    test("accepts a real numeric size when one is actually present (not always NaN)", () => {
      const withRealSize = { ...REAL_FUTURE_ORDER, size: 7 };
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", withRealSize);
      expect(result.payload.size).toBe(7);
    });

    test("index precision: a real 64-bit index beyond Number.MAX_SAFE_INTEGER normalizes to null, not a corrupted number", () => {
      expect(Number.isSafeInteger(5137554220647453000)).toBe(false);
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(result.payload.index).toBeNull();
    });

    test("index collision: two genuinely distinct raw index values that round to the identical double both normalize to null, not a shared value", () => {
      const indexA = Number.MAX_SAFE_INTEGER + 1;
      const indexB = Number.MAX_SAFE_INTEGER + 2;
      expect(indexA).toBe(indexB);
      const eventA = { ...REAL_FUTURE_ORDER, index: indexA };
      const eventB = { ...REAL_FUTURE_ORDER, index: indexB };
      expect(normalize("FUTURE", "/NQZ26:XCME", "ORDER", eventA).payload.index).toBeNull();
      expect(normalize("FUTURE", "/NQZ26:XCME", "ORDER", eventB).payload.index).toBeNull();
    });

    test("preserves a real safe-integer index unchanged", () => {
      const withSafeIndex = { ...REAL_FUTURE_ORDER, index: 4821 };
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", withSafeIndex);
      expect(result.payload.index).toBe(4821);
    });

    test("orderId gets the same defensive null treatment as index if it's ever unsafe (no real sample has been, yet)", () => {
      const withUnsafeOrderId = { ...REAL_FUTURE_ORDER, orderId: Number.MAX_SAFE_INTEGER + 10 };
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", withUnsafeOrderId);
      expect(result.payload.orderId).toBeNull();
    });

    test("a missing or absent index/orderId no longer degrades the event (both are optional, best-effort fields)", () => {
      const withoutIdentifiers = { ...REAL_FUTURE_ORDER };
      delete withoutIdentifiers.index;
      delete withoutIdentifiers.orderId;
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", withoutIdentifiers);
      expect(result.state).toBeUndefined();
      expect(result.payload.index).toBeNull();
      expect(result.payload.orderId).toBeNull();
    });

    test("excludes wire-only fields (eventFlags, sequence, tradePrice, tradeSize, executedSize, dayId-equivalents) from the canonical payload", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(Object.keys(result.payload).sort()).toEqual(
        ["action", "index", "orderId", "price", "scope", "side", "size", "source", "time"].sort(),
      );
    });

    test("still degrades when action is missing (a genuinely required Order field, unlike index/orderId)", () => {
      const withoutAction = { ...REAL_EQUITY_ORDER };
      delete withoutAction.action;
      const result = normalize("EQUITY", "AAPL", "ORDER", withoutAction);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("action");
    });

    test("does not require marketMaker on a futures order", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(result.state).toBeUndefined();
      expect(Object.hasOwn(result.payload, "marketMaker")).toBe(false);
    });

    test("accepts a generic TRADE/BUST order with no usable time -- the same live wire quirk already fixed for Order-v2, reproduced on the generic path", () => {
      for (const action of ["TRADE", "BUST"]) {
        const noTime = { ...REAL_FUTURE_ORDER, action, price: 0, time: "NaN" };
        const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", noTime);
        expect(result.state).toBeUndefined();
        expect(result.eventTime).toBe(new Date(RECEIVED_AT_MS).toISOString());
        expect(Object.hasOwn(result.payload, "time")).toBe(false);
      }
    });

    test("a normal (non-TRADE/BUST) generic order still requires a genuine time -- the relaxation does not leak to ordinary orders", () => {
      const noTime = { ...REAL_FUTURE_ORDER, action: "EXECUTE", time: "NaN" };
      const result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", noTime);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("time");
      expect(result.missingFields).toContain("eventTime");
    });
  });

  describe("ORDER V2 (DX3.07 Phase B -- book-reconciliation shape)", () => {
    // Deliberately different from what Number(REAL_FUTURE_ORDER.index) would
    // produce, in the last digit -- proves the v2 path preserves the exact
    // raw-wire string rather than silently falling back to the (already
    // rounded, since it's a JS number literal) `raw.index` field.
    const PRECISE_FUTURE_INDEX = "5137554220647453001";
    const PRECISE_EQUITY_INDEX = "22047776527426937";

    test("normalizes a real futures order using the raw-wire index string, surfacing eventFlags unlike v1", () => {
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, PRECISE_FUTURE_INDEX);
      expect(result).toEqual({
        provider: "DXFEED",
        venue: "XCME",
        assetClass: "FUTURE",
        providerSymbol: "/NQZ26:XCME",
        eventType: "ORDER",
        eventTime: new Date(1787593843018).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          index: PRECISE_FUTURE_INDEX, eventFlags: 4, time: 1787593843018,
          action: "EXECUTE", orderId: 0, price: 29139.75,
          size: null, side: "SELL", scope: "ORDER", source: "GLBX",
        },
      });
    });

    test("normalizes a real equity order, marketMaker present", () => {
      const result = normalizeV2("EQUITY", "AAPL", REAL_EQUITY_ORDER, PRECISE_EQUITY_INDEX);
      expect(result.payload).toEqual({
        index: PRECISE_EQUITY_INDEX, eventFlags: 4, time: 1787601590451,
        action: "EXECUTE", orderId: 0, price: 310.48,
        size: null, side: "SELL", scope: "ORDER", source: "NTV", marketMaker: "NSDQ",
      });
    });

    test("actionTime: 0 (the real fixture's own value) is treated as not-usefully-present, same isUsableTimestamp rule every other optional wire timestamp already follows -- not surfaced as a literal 0", () => {
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, PRECISE_FUTURE_INDEX);
      expect(Object.hasOwn(result.payload, "actionTime")).toBe(false);
      const withRealActionTime = { ...REAL_FUTURE_ORDER, actionTime: 1787593843018 };
      expect(normalizeV2("FUTURE", "/NQZ26:XCME", withRealActionTime, PRECISE_FUTURE_INDEX).payload.actionTime)
        .toBe(1787593843018);
    });

    test("the exact raw-wire index string round-trips through BigInt without precision loss, unlike the v1 number path", () => {
      const hugeIndex = "18446744073709551615"; // exceeds even a real 64-bit signed long's positive range
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, hugeIndex);
      expect(result.payload.index).toBe(hugeIndex);
      expect(BigInt(result.payload.index)).toBe(BigInt(hugeIndex));
    });

    test("a missing raw index string degrades the event -- index is required for v2, unlike the optional v1 field", () => {
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, undefined);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("index");
    });

    test("a malformed or schema-incompatible raw index string degrades the event rather than passing through unsafe text", () => {
      for (const bad of ["", "12x34", "-5", "  123", "123 ", "abc", "1".repeat(21)]) {
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, bad);
        expect(result.state).toBe("UNAVAILABLE");
        expect(result.missingFields).toContain("index");
      }
    });

    test("still maps the literal string \"NaN\" size to null, reusing the same v1 sentinel handling", () => {
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", REAL_FUTURE_ORDER, PRECISE_FUTURE_INDEX);
      expect(result.payload.size).toBeNull();
      expect(result.state).toBeUndefined();
    });

    test("still degrades when action is missing", () => {
      const withoutAction = { ...REAL_EQUITY_ORDER };
      delete withoutAction.action;
      const result = normalizeV2("EQUITY", "AAPL", withoutAction, PRECISE_EQUITY_INDEX);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("action");
    });

    test("preserves a valid empty snapshot removal even when dxFeed marks irrelevant order fields with sentinels", () => {
      const emptySnapshot = {
        ...REAL_EQUITY_ORDER,
        eventFlags: 0x04 | 0x08 | 0x02,
        time: 0,
        action: "UNDEFINED",
        price: "NaN",
        size: "NaN",
        side: "UNDEFINED",
      };

      const result = normalizeV2("EQUITY", "AAPL", emptySnapshot, "0");

      expect(result.state).toBeUndefined();
      expect(result.eventTime).toBe(new Date(RECEIVED_AT_MS).toISOString());
      expect(result.payload).toEqual({
        index: "0",
        eventFlags: 0x04 | 0x08 | 0x02,
        action: "UNDEFINED",
        orderId: 0,
        size: null,
        side: "UNDEFINED",
        scope: "ORDER",
        source: "NTV",
        marketMaker: "NSDQ",
      });
    });

    test("degrades on eventFlags missing or unsafe (negative, non-integer) -- required for v2's transactional framing, unlike v1 which never surfaces it at all", () => {
      const missing = { ...REAL_FUTURE_ORDER };
      delete missing.eventFlags;
      expect(normalizeV2("FUTURE", "/NQZ26:XCME", missing, PRECISE_FUTURE_INDEX).missingFields).toContain("eventFlags");
      const negative = { ...REAL_FUTURE_ORDER, eventFlags: -1 };
      expect(normalizeV2("FUTURE", "/NQZ26:XCME", negative, PRECISE_FUTURE_INDEX).missingFields).toContain("eventFlags");
    });

    test("rejects a stream/symbol mismatch and a provider event-type mismatch, same boundary as v1", () => {
      const wrongSymbol = normalizeV2("FUTURE", "/ESZ26:XCME", REAL_FUTURE_ORDER, PRECISE_FUTURE_INDEX);
      expect(wrongSymbol.state).toBe("UNAVAILABLE");
      expect(wrongSymbol.reason).toBe("STREAM_SYMBOL_MISMATCH");

      const wrongEventType = { ...REAL_FUTURE_ORDER, eventType: "Trade" };
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", wrongEventType, PRECISE_FUTURE_INDEX);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("does not mutate or otherwise affect the v1 orderPayload/normalizeDxFeedEvent path for the identical raw event", () => {
      const v1Result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", REAL_FUTURE_ORDER);
      expect(v1Result.payload.index).toBeNull();
      expect(Object.hasOwn(v1Result.payload, "eventFlags")).toBe(false);
    });

    test("accepts price: 0 for TRADE and BUST -- both legitimately zero-price per dxFeed's own OrderAction docs", () => {
      for (const action of ["TRADE", "BUST"]) {
        const zeroPrice = { ...REAL_FUTURE_ORDER, action, price: 0 };
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", zeroPrice, PRECISE_FUTURE_INDEX);
        expect(result.state).toBeUndefined();
        expect(result.payload.price).toBe(0);
        expect(result.payload.action).toBe(action);
      }
    });

    test("still rejects price: 0 for every other action -- the relaxation is scoped to TRADE/BUST only, not a blanket allowance", () => {
      for (const action of ["NEW", "REPLACE", "MODIFY", "DELETE", "PARTIAL", "EXECUTE", "UNDEFINED"]) {
        const zeroPrice = { ...REAL_FUTURE_ORDER, action, price: 0 };
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", zeroPrice, PRECISE_FUTURE_INDEX);
        expect(result.state).toBe("UNAVAILABLE");
        expect(result.missingFields).toContain("price");
      }
    });

    test("keeps the v1 Order evidence path aligned: TRADE/BUST price:0 is valid there too", () => {
      for (const action of ["TRADE", "BUST"]) {
        const zeroPrice = { ...REAL_FUTURE_ORDER, action, price: 0 };
        const v1Result = normalize("FUTURE", "/NQZ26:XCME", "ORDER", zeroPrice);
        expect(v1Result.state).toBeUndefined();
        expect(v1Result.payload.price).toBe(0);
      }
    });

    test("accepts a real TRADE/BUST order-v2 event whose price arrives as the literal wire string \"NaN\", resolving it to 0", () => {
      for (const action of ["TRADE", "BUST"]) {
        const nanPrice = { ...REAL_FUTURE_ORDER, action, price: "NaN" };
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", nanPrice, PRECISE_FUTURE_INDEX);
        expect(result.state).toBeUndefined();
        expect(result.payload.price).toBe(0);
      }
    });

    test("still rejects a \"NaN\" price string for every other action -- the NaN-token relaxation is scoped to TRADE/BUST only", () => {
      const nanPrice = { ...REAL_FUTURE_ORDER, action: "EXECUTE", price: "NaN" };
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", nanPrice, PRECISE_FUTURE_INDEX);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("price");
    });

    test("accepts a real TRADE/BUST order-v2 event with no usable time, falling back to receivedAt for eventTime and omitting time from the payload", () => {
      for (const action of ["TRADE", "BUST"]) {
        const noTime = { ...REAL_FUTURE_ORDER, action, price: 0, time: 0 };
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", noTime, PRECISE_FUTURE_INDEX);
        expect(result.state).toBeUndefined();
        expect(result.eventTime).toBe(new Date(RECEIVED_AT_MS).toISOString());
        expect(Object.hasOwn(result.payload, "time")).toBe(false);
      }
    });

    test("reproduces the exact live incident: TRADE order-v2 with time and price both the wire string \"NaN\" no longer degrades to UNAVAILABLE", () => {
      const liveIncidentShape = { ...REAL_FUTURE_ORDER, action: "TRADE", time: "NaN", price: "NaN" };
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", liveIncidentShape, PRECISE_FUTURE_INDEX);
      expect(result.state).toBeUndefined();
      expect(result.payload.price).toBe(0);
      expect(Object.hasOwn(result.payload, "time")).toBe(false);
      expect(result.eventTime).toBe(new Date(RECEIVED_AT_MS).toISOString());
    });

    test("still requires side, scope, action, and source for TRADE/BUST -- the relaxation is limited to time and price only", () => {
      for (const missingField of ["side", "scope", "source"]) {
        const broken = { ...REAL_FUTURE_ORDER, action: "TRADE", price: 0 };
        delete broken[missingField];
        const result = normalizeV2("FUTURE", "/NQZ26:XCME", broken, PRECISE_FUTURE_INDEX);
        expect(result.state).toBe("UNAVAILABLE");
        expect(result.missingFields).toContain(missingField);
      }
    });

    test("a normal (non-TRADE/BUST) order still requires a genuine time -- the relaxation does not leak to ordinary book orders", () => {
      const noTime = { ...REAL_FUTURE_ORDER, action: "EXECUTE", time: 0 };
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", noTime, PRECISE_FUTURE_INDEX);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("time");
      expect(result.missingFields).toContain("eventTime");
    });
  });

  describe("TIMEANDSALE", () => {
    test("normalizes a real futures TimeAndSale print with a genuine aggressorSide", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", REAL_FUTURE_TIMEANDSALE);
      expect(result).toEqual({
        provider: "DXFEED",
        venue: "XCME",
        assetClass: "FUTURE",
        providerSymbol: "/NQZ26:XCME",
        eventType: "TIMEANDSALE",
        eventTime: new Date(1787714841502).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          price: 29219, size: 1, time: 1787714841502, timeNanoPart: 0, sequence: 66860,
          exchangeCode: "G", extendedTradingHours: false, aggressorSide: "SELL",
          spreadLeg: false, validTick: true, type: "NEW", index: null, tradeId: null,
          bidPrice: 29219, askPrice: 29220,
        },
      });
    });

    test("a real index beyond Number.MAX_SAFE_INTEGER normalizes to null, same guard as Order.index", () => {
      expect(Number.isSafeInteger(7678176778774447000)).toBe(false);
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", REAL_FUTURE_TIMEANDSALE);
      expect(result.payload.index).toBeNull();
    });

    test("a NEW print with no tradeId key at all still normalizes fine -- tradeId is not required", () => {
      expect(Object.hasOwn(REAL_FUTURE_TIMEANDSALE, "tradeId")).toBe(false);
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", REAL_FUTURE_TIMEANDSALE);
      expect(result.state).toBeUndefined();
    });

    test("a CORRECTION print carrying a real tradeId is still accepted (tradeId is allowed, just not required)", () => {
      const correction = { ...REAL_FUTURE_TIMEANDSALE, type: "CORRECTION", tradeId: 123456 };
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", correction);
      expect(result.state).toBeUndefined();
      expect(result.payload.type).toBe("CORRECTION");
    });

    test("preserves a real BUY aggressorSide (not just the captured SELL sample)", () => {
      const buyPrint = { ...REAL_FUTURE_TIMEANDSALE, aggressorSide: "BUY" };
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", buyPrint);
      expect(result.payload.aggressorSide).toBe("BUY");
    });

    test("preserves an UNDEFINED aggressorSide rather than rejecting the event at the normalizer layer -- that's the adapter's job", () => {
      const undefinedSide = { ...REAL_FUTURE_TIMEANDSALE, aggressorSide: "UNDEFINED" };
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", undefinedSide);
      expect(result.state).toBeUndefined();
      expect(result.payload.aggressorSide).toBe("UNDEFINED");
    });

    test("degrades when aggressorSide is missing", () => {
      const withoutAggressorSide = { ...REAL_FUTURE_TIMEANDSALE };
      delete withoutAggressorSide.aggressorSide;
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", withoutAggressorSide);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("aggressorSide");
    });

    test("degrades when type is missing", () => {
      const withoutType = { ...REAL_FUTURE_TIMEANDSALE };
      delete withoutType.type;
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", withoutType);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("type");
    });

    test("preserves validity/classification fields plus bidPrice/askPrice, excludes exchangeSaleConditions/tradeThroughExempt", () => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", REAL_FUTURE_TIMEANDSALE);
      expect(Object.keys(result.payload).sort()).toEqual(
        [
          "aggressorSide", "askPrice", "bidPrice", "exchangeCode", "extendedTradingHours", "index",
          "price", "sequence", "size", "spreadLeg", "time", "timeNanoPart", "tradeId", "type", "validTick",
        ].sort(),
      );
    });

    test("exchangeSaleConditions is allow-listed at the wire boundary (equity NMS-tape field) but excluded from the canonical payload", () => {
      const withSaleConditions = { ...REAL_FUTURE_TIMEANDSALE, exchangeSaleConditions: "@  o" };
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", withSaleConditions);
      expect(result.state).toBeUndefined();
      expect(Object.hasOwn(result.payload, "exchangeSaleConditions")).toBe(false);
    });

    test("a real equity TimeAndSale print carrying exchangeSaleConditions normalizes instead of degrading to MALFORMED_RAW_MESSAGE", () => {
      // Every real captured equity TimeAndSale sample carries this field
      // (a CTA/UTP consolidated-tape sale-condition code); futures' CME
      // feed never populates it, which is why this was never hit before
      // equity TimeAndSale was wired up.
      const realEquityPrint = {
        eventType: "TimeAndSale", eventSymbol: "AAPL", eventTime: 0, eventFlags: 0,
        index: 7679136197100675000, time: 1787938223488, timeNanoPart: 0, sequence: 499469,
        exchangeCode: "L", price: 319.772, size: 0.003142, bidPrice: 319.73, askPrice: 319.78,
        exchangeSaleConditions: "@  o", tradeThroughExempt: " ", aggressorSide: "BUY",
        spreadLeg: false, extendedTradingHours: false, validTick: false, type: "NEW",
      };
      const result = normalize("EQUITY", "AAPL", "TIMEANDSALE", realEquityPrint);
      expect(result.state).toBeUndefined();
      expect(result.payload).toMatchObject({
        price: 319.772, size: 0.003142, aggressorSide: "BUY", validTick: false, type: "NEW",
        bidPrice: 319.73, askPrice: 319.78,
      });
    });

    test.each([
      ["timeNanoPart", 1.5],
      ["sequence", Number.MAX_SAFE_INTEGER + 1],
      ["type", "REPLAY"],
      ["validTick", 1],
      ["spreadLeg", "false"],
      ["aggressorSide", "SIDEWAYS"],
    ])("degrades an invalid %s instead of producing an envelope the adapter cannot honor", (field, value) => {
      const result = normalize("FUTURE", "/NQZ26:XCME", "TIMEANDSALE", { ...REAL_FUTURE_TIMEANDSALE, [field]: value });
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain(field);
    });
  });

  describe("STREAM_SYMBOL_MISMATCH / PROVIDER_EVENT_TYPE_MISMATCH", () => {
    test("degrades when the raw eventSymbol disagrees with the subscribed symbol", () => {
      const spoofed = { ...REAL_EQUITY_TRADE, eventSymbol: "MSFT" };
      const result = normalize("EQUITY", "TSLA", "TRADE", spoofed);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("STREAM_SYMBOL_MISMATCH");
    });

    test("degrades when the raw eventType disagrees with the subscribed event type", () => {
      const spoofed = { ...REAL_EQUITY_TRADE, eventType: "Quote" };
      const result = normalize("EQUITY", "TSLA", "TRADE", spoofed);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("degrades when the raw eventType is entirely absent, not just when it's a mismatched value", () => {
      const spoofed = { ...REAL_EQUITY_TRADE };
      delete spoofed.eventType;
      const result = normalize("EQUITY", "TSLA", "TRADE", spoofed);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("ORDER V2 also degrades when the raw eventType is entirely absent", () => {
      const spoofed = { ...REAL_FUTURE_ORDER };
      delete spoofed.eventType;
      const result = normalizeV2("FUTURE", "/NQZ26:XCME", spoofed, "5137554220647453001");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("mismatch reasons still carry the full common field set, never a partial object", () => {
      const spoofed = { ...REAL_EQUITY_TRADE, eventSymbol: "MSFT" };
      const result = normalize("EQUITY", "TSLA", "TRADE", spoofed);
      expect(result.provider).toBe("DXFEED");
      expect(result.assetClass).toBe("EQUITY");
      expect(result.providerSymbol).toBe("TSLA");
      expect(result.eventType).toBe("TRADE");
      expect(result.timingClass).toBe("REALTIME");
      expect(result.receivedAt).toBe(new Date(RECEIVED_AT_MS).toISOString());
    });
  });

  describe("hostile input", () => {
    test("rejects a Proxy-wrapped raw message", () => {
      const proxied = new Proxy(REAL_EQUITY_TRADE, {});
      const result = normalize("EQUITY", "TSLA", "TRADE", proxied);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("fails closed (does not throw) on a revoked Proxy", () => {
      const { proxy, revoke } = Proxy.revocable(REAL_EQUITY_TRADE, {});
      revoke();
      expect(() => normalize("EQUITY", "TSLA", "TRADE", proxy)).not.toThrow();
      const result = normalize("EQUITY", "TSLA", "TRADE", proxy);
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("never invokes an accessor (getter) field", () => {
      let reads = 0;
      const hostile = { ...REAL_EQUITY_TRADE };
      delete hostile.price;
      Object.defineProperty(hostile, "price", {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return 310.48;
        },
      });
      const result = normalize("EQUITY", "TSLA", "TRADE", hostile);
      expect(reads).toBe(0);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects a non-enumerable own field", () => {
      const hostile = { ...REAL_EQUITY_TRADE };
      delete hostile.price;
      Object.defineProperty(hostile, "price", { value: 310.48, enumerable: false, configurable: true });
      const result = normalize("EQUITY", "TSLA", "TRADE", hostile);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects an extra, unexpected key", () => {
      const hostile = { ...REAL_EQUITY_TRADE, unexpectedField: "surprise" };
      const result = normalize("EQUITY", "TSLA", "TRADE", hostile);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test.each([["a string"], [null], [["array", "not", "object"]], [42]])(
      "rejects non-object raw input: %p",
      (raw) => {
        const result = normalize("EQUITY", "TSLA", "TRADE", raw);
        expect(result.state).toBe("UNAVAILABLE");
        expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
      },
    );

    test("rejects an unrecognized subscribed event type before touching the raw payload", () => {
      expect(() => normalizeDxFeedEvent(
        { assetClass: "EQUITY", symbol: "TSLA", eventType: "CANDLE", raw: REAL_EQUITY_TRADE },
        { receivedAtMs: RECEIVED_AT_MS },
      )).toThrow(/invalid identity/);
    });
  });

  describe("stale / recoveryState pass-through", () => {
    test("passes through caller-provided stale/recoveryState", () => {
      const result = normalizeDxFeedEvent(
        { assetClass: "EQUITY", symbol: "TSLA", eventType: "TRADE", raw: REAL_EQUITY_TRADE },
        { receivedAtMs: RECEIVED_AT_MS, stale: true, recoveryState: "RECOVERING" },
      );
      expect(result.stale).toBe(true);
      expect(result.recoveryState).toBe("RECOVERING");
    });

    test("defaults stale:false / recoveryState:READY when omitted", () => {
      const result = normalize("EQUITY", "TSLA", "TRADE", REAL_EQUITY_TRADE);
      expect(result.stale).toBe(false);
      expect(result.recoveryState).toBe("READY");
    });

    test("uses Date.now() only when receivedAtMs is omitted and rejects an invalid explicit clock", () => {
      const withoutExplicitClock = normalizeDxFeedEvent({
        assetClass: "EQUITY",
        symbol: "TSLA",
        eventType: "TRADE",
        raw: REAL_EQUITY_TRADE,
      });
      expect(Date.parse(withoutExplicitClock.receivedAt)).toBeGreaterThan(0);
      expect(() =>
        normalizeDxFeedEvent(
          { assetClass: "EQUITY", symbol: "TSLA", eventType: "TRADE", raw: REAL_EQUITY_TRADE },
          { receivedAtMs: NaN },
        ),
      ).toThrow(/invalid receivedAtMs/);
    });

    test("rejects an invalid caller identity rather than returning a contract-invalid envelope", () => {
      expect(() => normalize("CRYPTO", "TSLA", "TRADE", REAL_EQUITY_TRADE)).toThrow(/invalid identity/);
      expect(() => normalize("EQUITY", "", "TRADE", REAL_EQUITY_TRADE)).toThrow(/invalid identity/);
      expect(() => normalize("EQUITY", "TSLA", "CANDLE", REAL_EQUITY_TRADE)).toThrow(/invalid identity/);
      expect(() => normalize("FUTURE", "/NQU26:   ", "TRADE", REAL_FUTURE_TRADE)).toThrow(/invalid identity/);
    });

    test("rejects invalid or internally inconsistent health context", () => {
      expect(() => normalizeDxFeedEvent(
        { assetClass: "EQUITY", symbol: "TSLA", eventType: "TRADE", raw: REAL_EQUITY_TRADE },
        { receivedAtMs: RECEIVED_AT_MS, stale: "true" },
      )).toThrow(/invalid health fields/);
      expect(() => normalizeDxFeedEvent(
        { assetClass: "EQUITY", symbol: "TSLA", eventType: "TRADE", raw: REAL_EQUITY_TRADE },
        { receivedAtMs: RECEIVED_AT_MS, recoveryState: "RECOVERING" },
      )).toThrow(/requires stale/);
    });

    test("rejects hostile caller context before any getter can run", () => {
      let reads = 0;
      const resolved = {
        assetClass: "EQUITY",
        symbol: "TSLA",
        eventType: "TRADE",
        raw: REAL_EQUITY_TRADE,
      };
      Object.defineProperty(resolved, "symbol", {
        enumerable: true,
        get() {
          reads += 1;
          return "TSLA";
        },
      });
      expect(() => normalizeDxFeedEvent(resolved, { receivedAtMs: RECEIVED_AT_MS })).toThrow(/plain object/);
      expect(reads).toBe(0);
    });
  });

  describe("frozen output", () => {
    test("the envelope and its payload are both frozen", () => {
      const result = normalize("EQUITY", "TSLA", "TRADE", REAL_EQUITY_TRADE);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.payload)).toBe(true);
    });

    test("a degraded envelope's missingFields array is frozen", () => {
      const withoutPrice = { ...REAL_EQUITY_TRADE };
      delete withoutPrice.price;
      const result = normalize("EQUITY", "TSLA", "TRADE", withoutPrice);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.missingFields)).toBe(true);
    });
  });

  describe("helper functions", () => {
    test("parseFuturesVenue extracts the suffix after the last colon", () => {
      expect(parseFuturesVenue("/ESZ26:XCME")).toBe("XCME");
      expect(parseFuturesVenue("/NQZ26:XCME")).toBe("XCME");
    });

    test("parseFuturesVenue returns null when there's no colon suffix", () => {
      expect(parseFuturesVenue("AAPL")).toBeNull();
      expect(parseFuturesVenue("/ESU26:")).toBeNull();
      expect(parseFuturesVenue("/ESU26:   ")).toBeNull();
      expect(parseFuturesVenue(42)).toBeNull();
    });

    test("resolveVenue returns null for EQUITY regardless of symbol shape", () => {
      expect(resolveVenue("EQUITY", "/ESZ26:XCME")).toBeNull();
    });

    test("resolveEventTimeMs picks whichever single side is usable", () => {
      const bidOnly = { bidTime: 1787601544000, askTime: undefined };
      expect(resolveEventTimeMs("QUOTE", bidOnly)).toBe(1787601544000);
      const askOnly = { bidTime: undefined, askTime: 1787601544000 };
      expect(resolveEventTimeMs("QUOTE", askOnly)).toBe(1787601544000);
    });

    test("resolveEventTimeMs returns undefined when neither Quote side is usable", () => {
      expect(resolveEventTimeMs("QUOTE", {})).toBeUndefined();
    });

    test("isSafeNonNegativeInteger rejects integer-valued doubles beyond MAX_SAFE_INTEGER (unlike a plain Number.isInteger check)", () => {
      expect(isSafeNonNegativeInteger(5137554220647453000)).toBe(false);
      expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(isSafeNonNegativeInteger(-1)).toBe(false);
      expect(isSafeNonNegativeInteger(1.5)).toBe(false);
      expect(isSafeNonNegativeInteger("5")).toBe(false);
    });

    test("resolveOrderIdentifier passes through a safe value and nulls an unsafe or missing one", () => {
      expect(resolveOrderIdentifier(4821)).toBe(4821);
      expect(resolveOrderIdentifier(5137554220647453000)).toBeNull();
      expect(resolveOrderIdentifier(undefined)).toBeNull();
      expect(resolveOrderIdentifier(-1)).toBeNull();
    });
  });
});
