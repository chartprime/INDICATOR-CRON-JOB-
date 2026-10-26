const {
  aggressorSideToSide,
  aggressorSideToBarSide,
  synthesizeLiveTradeId,
  adaptLiveDxFeedTimeAndSale,
  adaptLiveDxFeedTimeAndSaleForBar,
  isStoredDxFeedTimeAndSaleTapeRow,
  adaptStoredDxFeedTimeAndSaleRow,
  isDxFeedTimeAndSaleBarWorthy,
  BAR_ELIGIBILITY_REASONS,
  classifyDxFeedTimeAndSaleForBar,
} = require("../../../src/providers/dxfeed/dxfeed-trade-adapter");

describe("synthesizeLiveTradeId", () => {
  test("combines symbol, time, timeNanoPart, and sequence from the raw item", () => {
    expect(synthesizeLiveTradeId("TSLA", { time: 1787601599905, timeNanoPart: 400, sequence: 7 })).toBe(
      "TSLA:1787601599905:400:7",
    );
  });

  test("rejects incomplete identity fields instead of creating a colliding all-zero id", () => {
    expect(() => synthesizeLiveTradeId("TSLA", {})).toThrow(/time/);
    expect(() => synthesizeLiveTradeId("TSLA", undefined)).toThrow(/time/);
    expect(() => synthesizeLiveTradeId("TSLA", { time: NaN, timeNanoPart: 0, sequence: "7" })).toThrow(/time/);
    expect(() => synthesizeLiveTradeId("", { time: 1, timeNanoPart: 0, sequence: 1 })).toThrow(/symbol/);
  });

  test("two distinct raw items with different sequence numbers at the same millisecond do not collide", () => {
    const a = synthesizeLiveTradeId("AAPL", { time: 1, timeNanoPart: 0, sequence: 1 });
    const b = synthesizeLiveTradeId("AAPL", { time: 1, timeNanoPart: 0, sequence: 2 });
    expect(a).not.toBe(b);
  });
});

describe("aggressorSideToSide", () => {
  test("BUY maps to buy and SELL maps to sell", () => {
    expect(aggressorSideToSide("BUY")).toBe("buy");
    expect(aggressorSideToSide("SELL")).toBe("sell");
  });

  test("UNDEFINED (dxFeed's own documented uncertain value) is rejected, not guessed", () => {
    expect(() => aggressorSideToSide("UNDEFINED")).toThrow(/unsupported or undefined aggressorSide/);
  });

  test("an unrecognized value is rejected instead of being fabricated as a buy", () => {
    expect(() => aggressorSideToSide(undefined)).toThrow(/unsupported or undefined aggressorSide/);
    expect(() => aggressorSideToSide("")).toThrow(/unsupported or undefined aggressorSide/);
  });
});

describe("aggressorSideToBarSide", () => {
  test("preserves known classifications and represents dxFeed UNDEFINED as null", () => {
    expect(aggressorSideToBarSide("BUY")).toBe("buy");
    expect(aggressorSideToBarSide("SELL")).toBe("sell");
    expect(aggressorSideToBarSide("UNDEFINED")).toBeNull();
    expect(() => aggressorSideToBarSide("SIDEWAYS")).toThrow(/unsupported or undefined aggressorSide/);
  });
});

// Real /NQ TimeAndSale sample captured live via verify-dxfeed-extended-probe.js
// (apps/runtime/logs/verify-dxfeed-extended-probe-2026-08-26.log) -- not invented.
describe("adaptLiveDxFeedTimeAndSale", () => {
  const healthyEnvelope = Object.freeze({
    provider: "DXFEED",
    venue: "XCME",
    assetClass: "FUTURE",
    providerSymbol: "/NQZ26:XCME",
    eventType: "TIMEANDSALE",
    eventTime: "2026-08-26T03:27:21.502Z",
    receivedAt: "2026-08-26T03:27:21.600Z",
    timingClass: "REALTIME",
    stale: false,
    recoveryState: "READY",
    payload: Object.freeze({
      price: 29219,
      size: 1,
      time: 1787714841502,
      timeNanoPart: 0,
      sequence: 66860,
      exchangeCode: "G",
      extendedTradingHours: false,
      aggressorSide: "SELL",
      spreadLeg: false,
      validTick: true,
      type: "NEW",
      index: null,
    }),
  });

  test("produces the exact flat-field shape dxfeedTradeFrame expects, using real aggressorSide", () => {
    const rawItem = { time: 1787714841502, timeNanoPart: 0, sequence: 66860 };
    expect(adaptLiveDxFeedTimeAndSale(healthyEnvelope, rawItem)).toEqual({
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      tsExchange: Date.parse("2026-08-26T03:27:21.502Z"),
      price: 29219,
      size: 1,
      side: "sell",
      timeNanoPart: 0,
      sequence: 66860,
      tradeId: `/NQZ26:XCME:1787714841502:0:66860`,
    });
  });

  test("maps a BUY aggressorSide to buy", () => {
    const buyEnvelope = { ...healthyEnvelope, payload: { ...healthyEnvelope.payload, aggressorSide: "BUY" } };
    const rawItem = { time: healthyEnvelope.payload.time, timeNanoPart: 0, sequence: 66860 };
    expect(adaptLiveDxFeedTimeAndSale(buyEnvelope, rawItem).side).toBe("buy");
  });

  test("an UNDEFINED aggressorSide fails closed rather than guessing a side", () => {
    const undefinedEnvelope = { ...healthyEnvelope, payload: { ...healthyEnvelope.payload, aggressorSide: "UNDEFINED" } };
    const rawItem = { time: healthyEnvelope.payload.time, timeNanoPart: 0, sequence: 66860 };
    expect(() => adaptLiveDxFeedTimeAndSale(undefinedEnvelope, rawItem)).toThrow(/unsupported or undefined aggressorSide/);
    expect(adaptLiveDxFeedTimeAndSaleForBar(undefinedEnvelope, rawItem).side).toBeNull();
  });

  test("rejects a raw identity whose time disagrees with the normalized envelope", () => {
    const rawItem = { time: healthyEnvelope.payload.time + 1, timeNanoPart: 0, sequence: 66860 };
    expect(() => adaptLiveDxFeedTimeAndSale(healthyEnvelope, rawItem)).toThrow(/does not match/);
  });

  test("rejects a raw identity whose nanosecond or sequence discriminator disagrees", () => {
    expect(() => adaptLiveDxFeedTimeAndSale(healthyEnvelope, {
      time: healthyEnvelope.payload.time,
      timeNanoPart: 1,
      sequence: healthyEnvelope.payload.sequence,
    })).toThrow(/does not match/);
  });

  test("rejects a degraded (UNAVAILABLE) envelope rather than fabricating a trade", () => {
    const degraded = { state: "UNAVAILABLE", eventType: "TIMEANDSALE", providerSymbol: "/NQZ26:XCME" };
    expect(() => adaptLiveDxFeedTimeAndSale(degraded, {})).toThrow(/healthy TIMEANDSALE envelope/);
  });

  test("rejects a non-TIMEANDSALE envelope", () => {
    const tradeEnvelope = { ...healthyEnvelope, eventType: "TRADE" };
    expect(() => adaptLiveDxFeedTimeAndSale(tradeEnvelope, {})).toThrow(/healthy TIMEANDSALE envelope/);
  });

  test("rejects a missing envelope entirely", () => {
    expect(() => adaptLiveDxFeedTimeAndSale(null, {})).toThrow(/healthy TIMEANDSALE envelope/);
  });

  test("an out-of-safe-integer-range index on the envelope payload does not leak into the adapted trade", () => {
    const unsafeIndexEnvelope = {
      ...healthyEnvelope,
      payload: { ...healthyEnvelope.payload, index: null },
    };
    const rawItem = { time: healthyEnvelope.payload.time, timeNanoPart: 0, sequence: 66860 };
    const result = adaptLiveDxFeedTimeAndSale(unsafeIndexEnvelope, rawItem);
    expect(Object.hasOwn(result, "index")).toBe(false);
  });
});

describe("adaptStoredDxFeedTimeAndSaleRow", () => {
  const VALID_ROW = {
    symbol: "/NQZ26:XCME",
    asset_class: "FUTURE",
    event_time: 1787714841502,
    price: 29219,
    size: 1,
    time: 1787714841502,
    time_nano_part: 0,
    sequence: 66860,
    aggressor_side: "SELL",
    event_kind: "NEW",
    valid_tick: 1,
  };

  test("produces the same flat-field shape as the live TimeAndSale adapter, from a real stored dxfeed_time_and_sales row", () => {
    expect(adaptStoredDxFeedTimeAndSaleRow(VALID_ROW, { requireValidTick: true })).toEqual({
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      tsExchange: 1787714841502,
      price: 29219,
      size: 1,
      side: "sell",
      timeNanoPart: 0,
      sequence: 66860,
      tradeId: "/NQZ26:XCME:1787714841502:0:66860",
    });
  });

  test("maps a stored BUY aggressor_side to buy", () => {
    expect(adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, aggressor_side: "BUY" }, { requireValidTick: true }).side).toBe("buy");
  });

  test("only a valid, directionally classified NEW row is eligible for historical tape or marker rendering (requireValidTick:true, futures)", () => {
    expect(isStoredDxFeedTimeAndSaleTapeRow(VALID_ROW, { requireValidTick: true })).toBe(true);
    expect(isStoredDxFeedTimeAndSaleTapeRow({ ...VALID_ROW, aggressor_side: "UNDEFINED" }, { requireValidTick: true })).toBe(false);
    expect(isStoredDxFeedTimeAndSaleTapeRow({ ...VALID_ROW, event_kind: "CORRECTION" }, { requireValidTick: true })).toBe(false);
    expect(isStoredDxFeedTimeAndSaleTapeRow({ ...VALID_ROW, valid_tick: 0 }, { requireValidTick: true })).toBe(false);
  });

  test("requireValidTick:false (equities) admits a validTick:0 row -- the asymmetric policy's regression guard", () => {
    const row = { ...VALID_ROW, asset_class: "EQUITY", symbol: "TSLA", valid_tick: 0 };
    expect(isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick: false })).toBe(true);
    expect(adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick: false })).toEqual(
      expect.objectContaining({ symbol: "TSLA", assetClass: "EQUITY", side: "sell" }),
    );
  });

  test("rejects a missing row", () => {
    expect(() => adaptStoredDxFeedTimeAndSaleRow(null, { requireValidTick: true })).toThrow(/row must be an object/);
    expect(() => adaptStoredDxFeedTimeAndSaleRow(undefined, { requireValidTick: true })).toThrow(/row must be an object/);
  });

  test("rejects a stored CORRECTION/CANCEL row -- warm-up tape must only ever show valid new prints", () => {
    expect(() => adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, event_kind: "CORRECTION" }, { requireValidTick: true })).toThrow(/not a valid new tick/);
    expect(() => adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, event_kind: "CANCEL" }, { requireValidTick: true })).toThrow(/not a valid new tick/);
  });

  test("rejects a stored invalid-tick row when requireValidTick is true", () => {
    expect(() => adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, valid_tick: 0 }, { requireValidTick: true })).toThrow(/not a valid new tick/);
  });

  test("a stored UNDEFINED aggressor_side throws rather than silently guessing a side -- warm-up tape excludes unclassified prints, a deliberate choice mirroring aggressorSideToSide's live behavior, not aggressorSideToBarSide's null-tolerant one", () => {
    expect(() => adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, aggressor_side: "UNDEFINED" }, { requireValidTick: true })).toThrow(/unsupported or undefined aggressorSide/);
  });

  test("two stored rows differing only by sequence never collide on trade id", () => {
    const a = adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, sequence: 1 }, { requireValidTick: true });
    const b = adaptStoredDxFeedTimeAndSaleRow({ ...VALID_ROW, sequence: 2 }, { requireValidTick: true });
    expect(a.tradeId).not.toBe(b.tradeId);
  });
});

describe("isDxFeedTimeAndSaleBarWorthy", () => {
  test("classifies every candle exclusion with a stable operational reason", () => {
    expect(classifyDxFeedTimeAndSaleForBar(null, { requireValidTick: true })).toBe(BAR_ELIGIBILITY_REASONS.MALFORMED);
    expect(classifyDxFeedTimeAndSaleForBar({ type: "CANCEL" }, { requireValidTick: true })).toBe(BAR_ELIGIBILITY_REASONS.NOT_NEW);
    expect(classifyDxFeedTimeAndSaleForBar({ type: "NEW", spreadLeg: true, validTick: false }, { requireValidTick: true })).toBe(BAR_ELIGIBILITY_REASONS.SPREAD_LEG);
    expect(classifyDxFeedTimeAndSaleForBar({ type: "NEW", validTick: false }, { requireValidTick: true })).toBe(BAR_ELIGIBILITY_REASONS.INVALID_TICK);
    expect(classifyDxFeedTimeAndSaleForBar({ type: "NEW", validTick: true }, { requireValidTick: true })).toBe(BAR_ELIGIBILITY_REASONS.ACCEPTED);
  });
  test("requires an explicit boolean tick policy at every historical/live methodology boundary", () => {
    const row = {
      symbol: "AAPL", asset_class: "EQUITY", event_time: 1, price: 100, size: 1,
      time: 1, time_nano_part: 0, sequence: 1, aggressor_side: "BUY", event_kind: "NEW", valid_tick: 1,
    };
    for (const invalid of [undefined, null, 0, 1, "false", {}]) {
      expect(() => adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick: invalid })).toThrow(/requireValidTick/);
      expect(() => isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick: invalid })).toThrow(/requireValidTick/);
      expect(() => isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: true }, { requireValidTick: invalid }))
        .toThrow(/requireValidTick/);
    }
  });

  test("a non-NEW type is never bar-worthy, regardless of validTick or requireValidTick", () => {
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "CORRECTION", validTick: true }, { requireValidTick: true })).toBe(false);
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "CANCEL", validTick: true }, { requireValidTick: false })).toBe(false);
    expect(isDxFeedTimeAndSaleBarWorthy({ type: undefined, validTick: true }, { requireValidTick: false })).toBe(false);
  });

  test("requireValidTick:true (futures) rejects a NEW print whose validTick is false -- rare corrections/cancels", () => {
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: false }, { requireValidTick: true })).toBe(false);
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: true }, { requireValidTick: true })).toBe(true);
  });

  test("the eligibility helper can retain invalid ticks only when the caller explicitly relaxes the policy", () => {
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: false, spreadLeg: false }, { requireValidTick: false })).toBe(true);
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: true }, { requireValidTick: false })).toBe(true);
  });

  test("a real captured equity fractional invalid tick is retained for tape but excluded from OHLC", () => {
    const realEquityPrint = { type: "NEW", validTick: false, aggressorSide: "BUY", price: 319.772, size: 0.003142 };
    expect(isDxFeedTimeAndSaleBarWorthy(realEquityPrint, { requireValidTick: false })).toBe(true);
    expect(isDxFeedTimeAndSaleBarWorthy(realEquityPrint, { requireValidTick: true })).toBe(false);
  });

  test("spread-leg prints never contaminate the outright OHLC series", () => {
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: true, spreadLeg: true }, { requireValidTick: true })).toBe(false);
    expect(isDxFeedTimeAndSaleBarWorthy({ type: "NEW", validTick: true, spreadLeg: false }, { requireValidTick: true })).toBe(true);
  });

  test("tolerates a missing/malformed payload rather than throwing", () => {
    expect(isDxFeedTimeAndSaleBarWorthy(null, { requireValidTick: true })).toBe(false);
    expect(isDxFeedTimeAndSaleBarWorthy(undefined, { requireValidTick: false })).toBe(false);
  });
});

// Report 57 W1, O-3 (live only): auction prints stay on the tape and in the
// bars but off the equity large-trade path. Codes from the published dxFeed
// CTS/UTDF sale-condition tables: O opening, 5 re-opening, 6 closing crosses;
// Q official open, M official close, 9 corrected consolidated close, X cross/periodic auction.
describe("isEquityAuctionPrint", () => {
  const { isEquityAuctionPrint } = require("../../../src/providers/dxfeed/dxfeed-trade-adapter");

  test.each([
    ["@  O", true], ["@ O ", true], ["@  6", true], ["@  5", true], ["@Q  ", true], ["@M  ", true], ["@  9", true], ["@  X", true],
    ["@  o", false], ["@F o", false], ["@TI", false], ["@   ", false], ["", false],
  ])("equity conditions %j are an auction print: %s", (exchangeSaleConditions, expected) => {
    expect(isEquityAuctionPrint("EQUITY", { exchangeSaleConditions })).toBe(expected);
  });

  test("futures and prints without conditions are never classed as auction prints", () => {
    expect(isEquityAuctionPrint("FUTURE", { exchangeSaleConditions: "O" })).toBe(false);
    expect(isEquityAuctionPrint("EQUITY", {})).toBe(false);
    expect(isEquityAuctionPrint("EQUITY", null)).toBe(false);
  });
});
