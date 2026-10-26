const {
  safeTradeDiagnostic,
  createDxFeedDataQualityLedger,
  REJECTION_REASONS,
  REJECTION_SEVERITY,
} = require("../../../src/providers/dxfeed/dxfeed-data-quality");
const { BAR_ELIGIBILITY_REASONS } = require("../../../src/providers/dxfeed/dxfeed-trade-adapter");
const { classifyTelemetryEvent } = require("../../../src/platform/cli-logger");

describe("dxFeed data-quality ledger", () => {
  test("counts accepted and rejected candle inputs per instrument and retains one bounded safe diagnostic", () => {
    const emitted = [];
    const ledger = createDxFeedDataQualityLedger({ telemetry: (entry) => emitted.push(entry), now: () => 1_000 });
    ledger.record({ symbol: "AAPL", assetClass: "EQUITY", reason: BAR_ELIGIBILITY_REASONS.ACCEPTED, item: {} });
    ledger.record({
      symbol: "AAPL", assetClass: "EQUITY", reason: BAR_ELIGIBILITY_REASONS.INVALID_TICK,
      item: { time: 900, price: 340.33, size: 10, validTick: false, spreadLeg: false, exchangeCode: "Q", exchangeSaleConditions: "@TI" },
    });
    expect(ledger.snapshot("AAPL", "EQUITY")).toEqual({
      accepted: 1,
      rejected: { MALFORMED: 0, NOT_NEW: 0, SPREAD_LEG: 0, INVALID_TICK: 1 },
      lastRejectedAtMs: 1_000,
      lastRejection: {
        reason: "INVALID_TICK", eventTime: 900, price: 340.33, size: 10,
        validTick: false, spreadLeg: false, exchangeCode: "Q", exchangeSaleConditions: "@TI",
      },
      saleConditions: { NONE: 1, "@TI": 1 },
      saleConditionsOverflow: 0,
    });
    const rejections = emitted.filter((entry) => entry.event === "market_data.dxfeed_candle_input.rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ provider: "DXFEED", operation: "CANDLE_INPUT", reason: "INVALID_TICK", count: 1 });
  });

  test("samples diagnostics at powers of two rather than logging every rejected market event", () => {
    const emitted = [];
    const ledger = createDxFeedDataQualityLedger({ telemetry: (entry) => emitted.push(entry) });
    for (let index = 0; index < 9; index += 1) {
      ledger.record({ symbol: "AAPL", assetClass: "EQUITY", reason: BAR_ELIGIBILITY_REASONS.INVALID_TICK, item: {} });
    }
    expect(emitted.filter((entry) => entry.event === "market_data.dxfeed_candle_input.rejected").map((entry) => entry.count)).toEqual([1, 2, 4, 8]);
  });

  test("diagnostics omit arbitrary raw fields and bound exchange strings", () => {
    expect(safeTradeDiagnostic({
      time: 1, price: 2, size: 3, exchangeCode: "X".repeat(100),
      exchangeSaleConditions: "C".repeat(100), token: "must-not-leak",
    })).toEqual({
      eventTime: 1, price: 2, size: 3, validTick: null, spreadLeg: null,
      exchangeCode: "X".repeat(16), exchangeSaleConditions: "C".repeat(64),
    });
  });

  // Report 57 W1, O-3: the codes that mark auction prints come from dxFeed's
  // published sale-condition tables, but this feed has also shown codes that
  // are not in them (a lowercase "o"). Every distinct condition string is
  // counted, and its first sighting is logged with a sample print, so a live
  // session at the open and close confirms the codes against real prints.
  test("counts every distinct sale condition, logs its first sighting once, and stays bounded", () => {
    const emitted = [];
    const ledger = createDxFeedDataQualityLedger({ telemetry: (entry) => emitted.push(entry), now: () => 5 });
    const accept = (exchangeSaleConditions) => ledger.record({ symbol: "AAPL", assetClass: "EQUITY", reason: BAR_ELIGIBILITY_REASONS.ACCEPTED, item: { time: 1, price: 2, size: 3, exchangeSaleConditions } });
    accept("@  o");
    accept("@  o");
    accept("@  6");
    const firstSeen = emitted.filter((entry) => entry.event === "market_data.dxfeed_sale_condition.first_seen");
    expect(firstSeen.map((entry) => [entry.condition, entry.auction])).toEqual([["@  o", false], ["@  6", true]]);
    expect(ledger.snapshot("AAPL", "EQUITY").saleConditions).toEqual({ "@  o": 2, "@  6": 1 });
    for (let index = 0; index < 40; index += 1) accept(`X${index}`);
    const snapshot = ledger.snapshot("AAPL", "EQUITY");
    expect(Object.keys(snapshot.saleConditions)).toHaveLength(32);
    expect(snapshot.saleConditionsOverflow).toBe(10);
  });

  test("O-7: routine filtering (odd lots, corrections, spread legs) is logged as INFO, and only malformed input as a warning, never ERR", () => {
    const emitted = [];
    const ledger = createDxFeedDataQualityLedger({ telemetry: (entry) => emitted.push(entry) });
    for (const reason of ["INVALID_TICK", "NOT_NEW", "SPREAD_LEG", "MALFORMED"]) {
      ledger.record({ symbol: "AAPL", assetClass: "EQUITY", reason, item: {} });
    }
    const levels = emitted
      .filter((entry) => entry.event === "market_data.dxfeed_candle_input.rejected")
      .map((entry) => [entry.reason, classifyTelemetryEvent(entry.event, entry)]);
    expect(levels).toEqual([["INVALID_TICK", "info"], ["NOT_NEW", "info"], ["SPREAD_LEG", "info"], ["MALFORMED", "warn"]]);
    expect(Object.keys(REJECTION_SEVERITY).sort()).toEqual([...REJECTION_REASONS].sort());
  });

  test("refuses unknown reason labels", () => {
    const ledger = createDxFeedDataQualityLedger();
    expect(() => ledger.record({ symbol: "AAPL", assetClass: "EQUITY", reason: "OTHER", item: {} })).toThrow(/unknown/);
  });
});
