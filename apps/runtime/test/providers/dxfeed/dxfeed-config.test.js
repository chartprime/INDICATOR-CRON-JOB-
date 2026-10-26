const {
  ASSET_CLASSES,
  EVENT_TYPES,
  isAllowedAssetClass,
  futuresRootOf,
  isAllowedDxFeedSymbol,
  listAllowedFuturesRoots,
  listAllowedEquitySymbols,
  WIRE_TO_CANONICAL_EVENT_TYPE,
  listCollectorInstruments,
  collectorCellKey,
  buildCollectorSubscriptionEntries,
  buildCollectorContextIndex,
  findCollectorInstrumentByEventSymbol,
} = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");
const marketInstrumentCatalog = require("../../../../../config/market-instruments.json");

describe("dxfeed-config", () => {
  describe("isAllowedAssetClass", () => {
    test("accepts FUTURE and EQUITY, rejects anything else", () => {
      expect(isAllowedAssetClass("FUTURE")).toBe(true);
      expect(isAllowedAssetClass("EQUITY")).toBe(true);
      expect(isAllowedAssetClass("SPOT")).toBe(false);
      expect(isAllowedAssetClass(undefined)).toBe(false);
    });
  });

  describe("futuresRootOf", () => {
    test("extracts the root from a real captured resolved futures symbol", () => {
      expect(futuresRootOf("/NQZ26:XCME")).toBe("/NQ");
      expect(futuresRootOf("/ESZ26:XCME")).toBe("/ES");
    });

    test("extracts the root across a different quarterly roll month, not just the one observed live", () => {
      expect(futuresRootOf("/NQZ26:XCME")).toBe("/NQ");
      expect(futuresRootOf("/ESH27:XCME")).toBe("/ES");
    });

    test("returns null for a bare root, an equity symbol, or a malformed shape", () => {
      expect(futuresRootOf("/NQ")).toBeNull();
      expect(futuresRootOf("AAPL")).toBeNull();
      expect(futuresRootOf("/NQU26")).toBeNull();
      expect(futuresRootOf("/NQU26:")).toBeNull();
      expect(futuresRootOf(42)).toBeNull();
      expect(futuresRootOf(undefined)).toBeNull();
    });
  });

  describe("isAllowedDxFeedSymbol", () => {
    test("accepts every real symbol proven live in DX1.02", () => {
      expect(isAllowedDxFeedSymbol("/NQZ26:XCME", ASSET_CLASSES.FUTURE)).toBe(true);
      expect(isAllowedDxFeedSymbol("/ESZ26:XCME", ASSET_CLASSES.FUTURE)).toBe(true);
      expect(isAllowedDxFeedSymbol("AAPL", ASSET_CLASSES.EQUITY)).toBe(true);
      expect(isAllowedDxFeedSymbol("TSLA", ASSET_CLASSES.EQUITY)).toBe(true);
    });

    test("accepts a future rollover to a different contract month, not just today's", () => {
      expect(isAllowedDxFeedSymbol("/NQZ26:XCME", ASSET_CLASSES.FUTURE)).toBe(true);
    });

    test("rejects an unproven root even with a correctly-shaped futures symbol", () => {
      expect(isAllowedDxFeedSymbol("/CLU26:XNYM", ASSET_CLASSES.FUTURE)).toBe(false);
    });

    test("rejects an unproven equity symbol", () => {
      expect(isAllowedDxFeedSymbol("MSFT", ASSET_CLASSES.EQUITY)).toBe(false);
    });

    test("rejects a symbol/assetClass mismatch -- an equity symbol claiming FUTURE, or vice versa", () => {
      expect(isAllowedDxFeedSymbol("AAPL", ASSET_CLASSES.FUTURE)).toBe(false);
      expect(isAllowedDxFeedSymbol("/NQZ26:XCME", ASSET_CLASSES.EQUITY)).toBe(false);
    });

    test("rejects a malformed or missing assetClass entirely", () => {
      expect(isAllowedDxFeedSymbol("AAPL", "CRYPTO")).toBe(false);
      expect(isAllowedDxFeedSymbol("AAPL", undefined)).toBe(false);
    });
  });

  describe("list helpers", () => {
    test("expose the exact proven roots/symbols for callers that need to render or validate the full set", () => {
      expect([...listAllowedFuturesRoots()].sort()).toEqual(["/ES", "/NQ"]);
      expect([...listAllowedEquitySymbols()].sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
    });
  });

  describe("listCollectorInstruments", () => {
    test("matches the governed deployment catalog exactly so collector, servers, and frontend roll together", () => {
      expect(listCollectorInstruments()).toEqual(marketInstrumentCatalog.dxfeed.map(({ assetClass, symbol, orderSource, tickSize }) => ({
        assetClass, symbol, orderSource, tickSize,
      })));
    });

    test("returns the 4 proven DX1.02 instruments plus NVDA (added 2026-09-07), each a valid dxFeed symbol for its own assetClass", () => {
      const instruments = listCollectorInstruments();
      expect(instruments).toHaveLength(5);
      for (const { assetClass, symbol, orderSource } of instruments) {
        expect(isAllowedDxFeedSymbol(symbol, assetClass)).toBe(true);
        expect(typeof orderSource).toBe("string");
        expect(orderSource.length).toBeGreaterThan(0);
      }
    });

    test("futures instruments use GLBX, equity instruments use NTV -- the real DX1.02-proven order sources", () => {
      const instruments = listCollectorInstruments();
      for (const { assetClass, orderSource } of instruments) {
        if (assetClass === ASSET_CLASSES.FUTURE) expect(orderSource).toBe("GLBX");
        if (assetClass === ASSET_CLASSES.EQUITY) expect(orderSource).toBe("NTV");
      }
    });

    test("returns a frozen list of frozen instrument records -- callers cannot mutate shared config", () => {
      const instruments = listCollectorInstruments();
      expect(Object.isFrozen(instruments)).toBe(true);
      expect(Object.isFrozen(instruments[0])).toBe(true);
    });
  });

  describe("buildCollectorSubscriptionEntries", () => {
    test("builds Quote/Trade/Order/TimeAndSale for every instrument, futures and equities alike", () => {
      const entries = buildCollectorSubscriptionEntries({ nowMs: 1_800_000_000_000 });
      const instruments = listCollectorInstruments();
      expect(entries).toHaveLength(instruments.length * 5);
      for (const { symbol, orderSource } of instruments) {
        expect(entries).toContainEqual({ symbol, type: "Quote" });
        expect(entries).toContainEqual({ symbol, type: "Trade" });
        expect(entries).toContainEqual({ symbol: `${symbol}{=m}`, type: "Candle", fromTime: 1_799_999_940_000 });
        expect(entries).toContainEqual({ symbol, type: "Order", source: orderSource });
        expect(entries).toContainEqual({ symbol, type: "TimeAndSale" });
      }
    });
  });

  describe("buildCollectorContextIndex", () => {
    test("indexes every instrument x wire-event-type cell, tagging Order with its real source", () => {
      const index = buildCollectorContextIndex();
      expect(index.size).toBe(listCollectorInstruments().length * 5);
      expect(index.get(collectorCellKey("/NQZ26:XCME", "Order"))).toEqual({
        assetClass: ASSET_CLASSES.FUTURE, symbol: "/NQZ26:XCME", eventType: EVENT_TYPES.ORDER, source: "GLBX",
      });
      expect(index.get(collectorCellKey("/NQZ26:XCME", "TimeAndSale"))).toEqual({
        assetClass: ASSET_CLASSES.FUTURE, symbol: "/NQZ26:XCME", eventType: EVENT_TYPES.TIMEANDSALE, source: undefined,
      });
      expect(index.get(collectorCellKey("AAPL", "TimeAndSale"))).toEqual({
        assetClass: ASSET_CLASSES.EQUITY, symbol: "AAPL", eventType: EVENT_TYPES.TIMEANDSALE, source: undefined,
      });
      expect(index.get(collectorCellKey("TSLA", "Trade"))).toEqual({
        assetClass: ASSET_CLASSES.EQUITY, symbol: "TSLA", eventType: EVENT_TYPES.TRADE, source: undefined,
      });
    });

    test("returns undefined for a symbol not in the instrument list", () => {
      expect(buildCollectorContextIndex().get(collectorCellKey("UNKNOWN", "Trade"))).toBeUndefined();
    });
  });

  describe("findCollectorInstrumentByEventSymbol", () => {
    test("resolves each of the 4 real proven instruments by their bare eventSymbol, including orderSource", () => {
      expect(findCollectorInstrumentByEventSymbol("/NQZ26:XCME")).toEqual({
        assetClass: ASSET_CLASSES.FUTURE, symbol: "/NQZ26:XCME", orderSource: "GLBX", tickSize: 0.25,
      });
      expect(findCollectorInstrumentByEventSymbol("/ESZ26:XCME")).toEqual({
        assetClass: ASSET_CLASSES.FUTURE, symbol: "/ESZ26:XCME", orderSource: "GLBX", tickSize: 0.25,
      });
      expect(findCollectorInstrumentByEventSymbol("AAPL")).toEqual({
        assetClass: ASSET_CLASSES.EQUITY, symbol: "AAPL", orderSource: "NTV", tickSize: 0.01,
      });
      expect(findCollectorInstrumentByEventSymbol("TSLA")).toEqual({
        assetClass: ASSET_CLASSES.EQUITY, symbol: "TSLA", orderSource: "NTV", tickSize: 0.01,
      });
    });

    test("returns undefined for a symbol outside the hardcoded instrument set, e.g. a different valid futures expiry", () => {
      expect(findCollectorInstrumentByEventSymbol("/NQU26:XCME")).toBeUndefined();
      expect(findCollectorInstrumentByEventSymbol("MSFT")).toBeUndefined();
      expect(findCollectorInstrumentByEventSymbol(undefined)).toBeUndefined();
    });
  });

  test("exports an immutable wire-to-canonical event mapping", () => {
    expect(Object.isFrozen(WIRE_TO_CANONICAL_EVENT_TYPE)).toBe(true);
    expect(Reflect.set(WIRE_TO_CANONICAL_EVENT_TYPE, "Order", "TRADE")).toBe(false);
    expect(WIRE_TO_CANONICAL_EVENT_TYPE.Order).toBe(EVENT_TYPES.ORDER);
  });
});
