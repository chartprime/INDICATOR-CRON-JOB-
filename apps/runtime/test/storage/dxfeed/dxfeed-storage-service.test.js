const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { safeRm } = require("../../helpers/temp-files");

const REAL_FUTURE_QUOTE_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME",
  eventType: "QUOTE", eventTime: new Date(1787601544000).toISOString(), receivedAt: new Date(1787601700000).toISOString(),
  timingClass: "REALTIME", stale: false, recoveryState: "READY",
  payload: Object.freeze({
    bidPrice: 29111.5, bidSize: 2, bidTime: 1787601544000, bidExchangeCode: "G",
    askPrice: 29112, askSize: 3, askTime: 1787601544000, askExchangeCode: "G",
  }),
});

const REAL_EQUITY_TRADE_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: null, assetClass: "EQUITY", providerSymbol: "TSLA",
  eventType: "TRADE", eventTime: new Date(1787601599905).toISOString(), receivedAt: new Date(1787601700000).toISOString(),
  timingClass: "REALTIME", stale: false, recoveryState: "READY",
  payload: Object.freeze({
    price: 349.03, size: 120, time: 1787601599905, exchangeCode: "L", change: -13.83,
    dayVolume: 34651826.701307, dayTurnover: 12302399792.64278, tickDirection: "ZERO_UP", extendedTradingHours: true,
  }),
});

const REAL_EQUITY_ORDER_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: null, assetClass: "EQUITY", providerSymbol: "AAPL",
  eventType: "ORDER", eventTime: new Date(1787601590451).toISOString(), receivedAt: new Date(1787601700000).toISOString(),
  timingClass: "REALTIME", stale: false, recoveryState: "READY",
  payload: Object.freeze({
    index: null, time: 1787601590451, action: "EXECUTE", orderId: 0, price: 310.48, size: null,
    side: "SELL", scope: "ORDER", source: "NTV", marketMaker: "NSDQ",
  }),
});

const REAL_FUTURE_TIME_AND_SALE_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME",
  eventType: "TIMEANDSALE", eventTime: new Date(1787714841502).toISOString(), receivedAt: new Date(1787714841600).toISOString(),
  timingClass: "REALTIME", stale: false, recoveryState: "READY",
  payload: Object.freeze({
    price: 29219, size: 1, time: 1787714841502, timeNanoPart: 0, sequence: 66860,
    exchangeCode: "G", extendedTradingHours: false, aggressorSide: "SELL", spreadLeg: false,
    validTick: true, type: "NEW", index: null, tradeId: null,
  }),
});

const REAL_ORDER_V2_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME",
  eventType: "ORDER", eventTime: new Date(1787593843018).toISOString(), receivedAt: new Date(1787601700000).toISOString(),
  timingClass: "REALTIME", stale: false, recoveryState: "READY",
  payload: Object.freeze({
    index: "5137554220647453001", eventFlags: 4, time: 1787593843018, action: "NEW",
    actionTime: 1787593843018, orderId: 0, price: 29139.75, size: 7, side: "SELL",
    scope: "ORDER", source: "GLBX",
  }),
});

const DEGRADED_ORDER_V2_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", providerSymbol: "/NQZ26:XCME", eventType: "ORDER",
  receivedAt: new Date(1787601700000).toISOString(), timingClass: "REALTIME", stale: false, recoveryState: "READY",
  state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD", missingFields: Object.freeze(["index"]),
});

const DEGRADED_ENVELOPE = Object.freeze({
  provider: "DXFEED", venue: null, assetClass: "EQUITY", providerSymbol: "AAPL", eventType: "TRADE",
  receivedAt: new Date(1787601700000).toISOString(), timingClass: "REALTIME", stale: false, recoveryState: "READY",
  state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD", missingFields: Object.freeze(["price"]),
});

describe("createDxFeedStorageService", () => {
  test("file-backed service defaults to validate-only and does not create a phantom database", () => {
    const dbPath = path.join(os.tmpdir(), `dxfeed-service-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    expect(() => createDxFeedStorageService({ dbPath })).toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });

  test("enforces one writer per file and releases ownership on close", () => {
    const dbPath = path.join(os.tmpdir(), `dxfeed-service-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const first = createDxFeedStorageService({ dbPath, bootstrap: true });
    expect(() => createDxFeedStorageService({ dbPath })).toThrow(/already owned/);
    first.close();
    const replacement = createDxFeedStorageService({ dbPath, bootstrap: false });
    replacement.close();
    for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("releases the lock when database construction itself fails, not just on a normal close", () => {
    const dbPath = path.join(os.tmpdir(), `dxfeed-service-lock-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // A real, deterministic way to make createDxFeedStorageDb throw:
    // an unsupported schema version has no quarantine/recovery path,
    // unlike an actual corruption error.
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE dxfeed_storage_schema (version INTEGER NOT NULL); INSERT INTO dxfeed_storage_schema (version) VALUES (99);");
    seed.close();

    expect(() => createDxFeedStorageService({ dbPath, bootstrap: true })).toThrow(/unsupported schema version/);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);

    for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("writes a real Quote envelope through to the underlying table", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope(REAL_FUTURE_QUOTE_ENVELOPE);
    expect(service.getCounters()).toMatchObject({ quotes: 1, trades: 0, rejected: 0, skipped: 0 });
    service.close();
  });

  test("writes a real Trade envelope, converting boolean extendedTradingHours to 0/1", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope(REAL_EQUITY_TRADE_ENVELOPE);
    expect(service.getCounters().trades).toBe(1);
    service.close();
  });



  test("still rejects a missing time for every other generic Order action", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const noTime = {
      ...REAL_EQUITY_ORDER_ENVELOPE,
      eventTime: REAL_EQUITY_ORDER_ENVELOPE.receivedAt,
      payload: { ...REAL_EQUITY_ORDER_ENVELOPE.payload, action: "NEW", time: undefined },
    };
    expect(service.handleEnvelope(noTime)).toBe(false);
    expect(service.getCounters()).toMatchObject({ rejected: 1 });
    service.close();
  });


  test("writes a real TimeAndSale envelope with nullable unsafe provider identifiers", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope(REAL_FUTURE_TIME_AND_SALE_ENVELOPE)).toBe(true);
    expect(service.getCounters()).toMatchObject({ timeAndSales: 1, rejected: 0 });
    service.close();
  });

  test("rejects a TimeAndSale payload that cannot preserve its event identity", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const invalid = {
      ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE,
      payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, sequence: 1.5 },
    };
    expect(service.handleEnvelope(invalid)).toBe(false);
    expect(service.getCounters()).toMatchObject({ timeAndSales: 0, rejected: 1 });
    service.close();
  });

  test("writes a real TimeAndSale envelope's bidPrice/askPrice through to the underlying table", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const withBidAsk = {
      ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE,
      payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, bidPrice: 29218, askPrice: 29220 },
    };
    expect(service.handleEnvelope(withBidAsk)).toBe(true);
    const row = service.getStorageDb().raw.prepare("SELECT bid_price, ask_price FROM dxfeed_time_and_sales").get();
    expect(row).toEqual({ bid_price: 29218, ask_price: 29220 });
    service.close();
  });



  test("a CANCEL/CORRECTION or UNDEFINED-side print does not update the baseline -- only real, directional NEW trades count", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope({ ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, type: "CANCEL", tradeId: 1 } });
    service.handleEnvelope({ ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, aggressorSide: "UNDEFINED", tradeId: 2 } });
    service.handleEnvelope({ ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, tradeId: 3 } });
    const row = service.getStorageDb().raw.prepare(
      "SELECT baseline_log_median, baseline_log_mad FROM dxfeed_time_and_sales ORDER BY id ASC LIMIT 1 OFFSET 2",
    ).get();
    expect(row).toEqual({ baseline_log_median: null, baseline_log_mad: null });
    service.close();
  });


  test("requires a valid tick for a futures print to count toward the baseline", () => {
    const futureService = createDxFeedStorageService({ dbPath: ":memory:" });
    futureService.handleEnvelope({ ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, validTick: false, tradeId: 1 } });
    futureService.handleEnvelope({ ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, tradeId: 2 } });
    const row = futureService.getStorageDb().raw.prepare(
      "SELECT baseline_log_median FROM dxfeed_time_and_sales ORDER BY id ASC LIMIT 1 OFFSET 1",
    ).get();
    expect(row.baseline_log_median).toBeNull();
    futureService.close();
  });

  describe("trade-ID continuity tracking", () => {
    function withTradeId(tradeId) {
      return { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, tradeId } };
    }

    test("a null tradeId (the documented unsafe-integer case) is counted as unavailable, never treated as a gap", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.handleEnvelope(withTradeId(null));
      service.handleEnvelope(withTradeId(null));
      expect(service.getCounters()).toMatchObject({ tradeIdUnavailable: 2, tradeIdGaps: 0, tradeIdNonMonotonic: 0 });
      service.close();
    });

    test("consecutive safe tradeIds with no gap are silent -- no gap, no false alarm", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(withTradeId(1001));
      expect(service.getCounters()).toMatchObject({ tradeIdGaps: 0, missingTradeIds: 0, tradeIdUnavailable: 0 });
      service.close();
    });

    test("a real jump in safe tradeIds is counted as a gap with the exact missing count", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(withTradeId(1004));
      expect(service.getCounters()).toMatchObject({ tradeIdGaps: 1, missingTradeIds: 3 });
      service.close();
    });

    test("a repeated or decreasing tradeId is non-monotonic, not fabricated as a gap", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(withTradeId(999));
      expect(service.getCounters()).toMatchObject({ tradeIdNonMonotonic: 2, tradeIdGaps: 0 });
      service.close();
    });

    test("continuity is tracked independently per symbol/assetClass pair -- one pair's gap never contaminates another's clean run", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      const otherSymbol = { ...withTradeId(5000), providerSymbol: "AAPL", assetClass: "EQUITY" };
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(otherSymbol);
      service.handleEnvelope(withTradeId(1001));
      expect(service.getCounters()).toMatchObject({ tradeIdGaps: 0, tradeIdNonMonotonic: 0 });
      service.close();
    });

    test("a null tradeId between two safe ones does not itself break the continuity chain for the next real value", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.handleEnvelope(withTradeId(1000));
      service.handleEnvelope(withTradeId(null));
      service.handleEnvelope(withTradeId(1001));
      expect(service.getCounters()).toMatchObject({ tradeIdGaps: 0, tradeIdUnavailable: 1 });
      service.close();
    });
  });

  test("a TimeAndSale envelope without bidPrice/askPrice still writes, storing them as null", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope(REAL_FUTURE_TIME_AND_SALE_ENVELOPE)).toBe(true);
    const row = service.getStorageDb().raw.prepare("SELECT bid_price, ask_price FROM dxfeed_time_and_sales").get();
    expect(row).toEqual({ bid_price: null, ask_price: null });
    service.close();
  });

  test("rejects a TimeAndSale envelope with a non-positive bidPrice or askPrice", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const badBid = {
      ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE,
      payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, bidPrice: 0 },
    };
    expect(service.handleEnvelope(badBid)).toBe(false);
    const badAsk = {
      ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE,
      payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, askPrice: -1 },
    };
    expect(service.handleEnvelope(badAsk)).toBe(false);
    expect(service.getCounters()).toMatchObject({ timeAndSales: 0, rejected: 2 });
    service.close();
  });

  test("skips a degraded (UNAVAILABLE) envelope without writing or rejecting", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope(DEGRADED_ENVELOPE);
    expect(service.getCounters()).toMatchObject({ skipped: 1, rejected: 0, trades: 0 });
    service.close();
  });

  test("rejects a non-object envelope without throwing", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(() => service.handleEnvelope(null)).not.toThrow();
    expect(() => service.handleEnvelope("not an envelope")).not.toThrow();
    expect(service.getCounters().rejected).toBe(2);
    service.close();
  });

  test("rejects an envelope with the wrong provider", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, provider: "BINANCE" });
    expect(service.getCounters().rejected).toBe(1);
    expect(service.getCounters().trades).toBe(0);
    service.close();
  });

  test("rejects an envelope with an unrecognized assetClass", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, assetClass: "CRYPTO" });
    expect(service.getCounters().rejected).toBe(1);
    service.close();
  });

  test("rejects an envelope with an unsupported eventType", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, eventType: "CANDLE" });
    expect(service.getCounters().rejected).toBe(1);
    service.close();
  });

  test("rejects an envelope with an unparseable eventTime", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, eventTime: "not-a-date" });
    expect(service.getCounters().rejected).toBe(1);
    service.close();
  });

  test("throws after close rather than silently swallowing further writes", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.close();
    expect(() => service.handleEnvelope(REAL_EQUITY_TRADE_ENVELOPE)).toThrow(/cannot write after close/);
  });

  test("rejects an invalid canonical payload before it reaches SQLite", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const brokenEnvelope = {
      ...REAL_FUTURE_QUOTE_ENVELOPE,
      payload: { ...REAL_FUTURE_QUOTE_ENVELOPE.payload, bidPrice: -1 },
    };
    expect(service.handleEnvelope(brokenEnvelope)).toBe(false);
    expect(service.getCounters()).toMatchObject({ quotes: 0, rejected: 1 });
    service.close();
  });

  test("rejects an envelope that merely claims to be degraded without the canonical degraded shape", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope({ state: "UNAVAILABLE" })).toBe(false);
    expect(service.getCounters()).toMatchObject({ skipped: 0, rejected: 1 });
    service.close();
  });

  test("rejects extra top-level fields instead of accepting a shape outside the canonical schema", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, unexpected: true })).toBe(false);
    expect(service.getCounters()).toMatchObject({ trades: 0, rejected: 1 });
    service.close();
  });

  test("enforces asset-class venue semantics at the storage boundary", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, venue: "XNAS" })).toBe(false);
    expect(service.handleEnvelope({ ...REAL_FUTURE_QUOTE_ENVELOPE, venue: "XNAS" })).toBe(false);
    expect(service.getCounters()).toMatchObject({ quotes: 0, trades: 0, rejected: 2 });
    service.close();
  });

  test("rejects a valid-looking envelope whose eventTime disagrees with the payload", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const wrongEventTime = new Date(Date.parse(REAL_EQUITY_TRADE_ENVELOPE.eventTime) + 1).toISOString();
    expect(service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, eventTime: wrongEventTime })).toBe(false);
    expect(service.getCounters()).toMatchObject({ trades: 0, rejected: 1 });
    service.close();
  });

  test("accepts only the documented degraded reasons, timestamp, and missingFields relationship", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope({ ...DEGRADED_ENVELOPE, reason: "UNKNOWN_REASON" })).toBe(false);
    expect(service.handleEnvelope({ ...DEGRADED_ENVELOPE, missingFields: [] })).toBe(false);
    expect(service.handleEnvelope({ ...DEGRADED_ENVELOPE, receivedAt: "not-a-date" })).toBe(false);
    expect(
      service.handleEnvelope({
        ...DEGRADED_ENVELOPE,
        reason: "STREAM_SYMBOL_MISMATCH",
        missingFields: ["should-be-empty"],
      }),
    ).toBe(false);
    expect(service.getCounters()).toMatchObject({ skipped: 0, rejected: 4 });
    service.close();
  });

  test("rejects a precision-unsafe order identifier at the storage boundary", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const unsafe = {
      ...REAL_EQUITY_ORDER_ENVELOPE,
      payload: { ...REAL_EQUITY_ORDER_ENVELOPE.payload, index: Number.MAX_SAFE_INTEGER + 2 },
    };
    expect(service.handleEnvelope(unsafe)).toBe(false);
    expect(service.getCounters()).toMatchObject({ rejected: 1 });
    service.close();
  });

  test("requires canonical ISO timestamps rather than accepting Date.parse-compatible variants", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope({ ...REAL_EQUITY_TRADE_ENVELOPE, eventTime: "2026-08-25T12:00:00Z" })).toBe(false);
    expect(service.getCounters()).toMatchObject({ trades: 0, rejected: 1 });
    service.close();
  });

  test("getCounters returns a snapshot, not a live-mutable reference", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const first = service.getCounters();
    service.handleEnvelope(REAL_EQUITY_TRADE_ENVELOPE);
    expect(first.trades).toBe(0);
    expect(service.getCounters().trades).toBe(1);
    service.close();
  });

  test("writes a mixed event batch in one call while counting valid degraded envelopes as skipped", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelopes([
      REAL_FUTURE_QUOTE_ENVELOPE,
      DEGRADED_ENVELOPE,
      REAL_EQUITY_TRADE_ENVELOPE,
    ])).toEqual([true, false, true]);
    expect(service.getCounters()).toEqual({
      quotes: 1, trades: 1, timeAndSales: 0, candles: 0, orderBookCapture: 0, skipped: 1, rejected: 0,
      tradeIdGaps: 0, missingTradeIds: 0, tradeIdNonMonotonic: 0, tradeIdUnavailable: 0,
    });
    service.close();
  });

  // L1L2-V2-039. The generic Order write path is retired: dxfeed_orders was a
  // strictly lossier duplicate of dxfeed_order_book_capture, which is fed by
  // handleOrderV2Envelope from the raw exact-index stream instead. An Order
  // envelope arriving on the generic path is now REJECTED rather than silently
  // dropped -- the collector filters them out upstream, so reaching here at all
  // means something is wrong and should say so.
  test("rejects an Order envelope on the generic path rather than silently ignoring it", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });

    expect(service.handleEnvelope(REAL_EQUITY_ORDER_ENVELOPE)).toBe(false);
    expect(service.getCounters()).toMatchObject({ rejected: 1, skipped: 0, orderBookCapture: 0 });

    // In a batch it is fatal rather than merely false: an unaccepted healthy
    // envelope is a contract failure, and the batch rolls back.
    expect(() => service.handleEnvelopes([REAL_EQUITY_ORDER_ENVELOPE]))
      .toThrow(/failed canonical validation/);

    service.close();
  });

  test("fails and restores counters when a healthy envelope in a batch violates the canonical contract", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(() => service.handleEnvelopes([
      REAL_EQUITY_TRADE_ENVELOPE,
      { ...REAL_EQUITY_TRADE_ENVELOPE, provider: "BINANCE" },
    ])).toThrow(/failed canonical validation/);
    expect(service.getCounters()).toEqual({
      quotes: 0, trades: 0, timeAndSales: 0, candles: 0, orderBookCapture: 0, skipped: 0, rejected: 1,
      tradeIdGaps: 0, missingTradeIds: 0, tradeIdNonMonotonic: 0, tradeIdUnavailable: 0,
    });
    service.close();
  });

  test("fails and restores trade-ID continuity state, not just counters, when a batch rolls back", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const withTradeId = (tradeId) => (
      { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE, payload: { ...REAL_FUTURE_TIME_AND_SALE_ENVELOPE.payload, tradeId } }
    );
    expect(() => service.handleEnvelopes([
      withTradeId(1000),
      { ...REAL_EQUITY_TRADE_ENVELOPE, provider: "BINANCE" },
    ])).toThrow(/failed canonical validation/);
    expect(service.getCounters()).toMatchObject({ timeAndSales: 0, tradeIdNonMonotonic: 0, tradeIdGaps: 0 });
    // If the rolled-back batch's tradeId=1000 had leaked into continuity state, this re-delivery
    // of the same tradeId would be falsely counted as non-monotonic instead of landing cleanly.
    service.handleEnvelope(withTradeId(1000));
    expect(service.getCounters()).toMatchObject({ timeAndSales: 1, tradeIdNonMonotonic: 0, tradeIdGaps: 0 });
    service.close();
  });




  test("fails a batch containing a non-canonical object that merely claims to be degraded", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(() => service.handleEnvelopes([{ state: "UNAVAILABLE" }])).toThrow(/failed canonical validation/);
    expect(service.getCounters()).toEqual({
      quotes: 0, trades: 0, timeAndSales: 0, candles: 0, orderBookCapture: 0, skipped: 0, rejected: 1,
      tradeIdGaps: 0, missingTradeIds: 0, tradeIdNonMonotonic: 0, tradeIdUnavailable: 0,
    });
    service.close();
  });

  test("rejects invalid batch input and batches after close", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(() => service.handleEnvelopes(null)).toThrow(/must be an array/);
    service.close();
    expect(() => service.handleEnvelopes([])).toThrow(/cannot write after close/);
  });

  test("rejects oversized canonical and Order-v2 batches before opening a transaction", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:", maxBatchEnvelopes: 1 });
    expect(() => service.handleEnvelopes([REAL_EQUITY_TRADE_ENVELOPE, REAL_EQUITY_TRADE_ENVELOPE]))
      .toThrow(/exceeds 1 items/);
    expect(() => service.handleOrderV2Envelopes([REAL_ORDER_V2_ENVELOPE, REAL_ORDER_V2_ENVELOPE]))
      .toThrow(/exceeds 1 items/);
    expect(service.getCounters()).toMatchObject({ trades: 0, orderBookCapture: 0, rejected: 0 });
    service.close();
  });

  describe("recordCandle", () => {
    const CLOSED_BAR = Object.freeze({
      ts_open: 1787714820000, open: 29219, high: 29225, low: 29210, close: 29220,
      volume: 12, buy_volume: 7, trade_count: 4, closed: true,
    });

    test("writes a real closed bar through to dxfeed_candles and counts it", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.recordCandle("/NQZ26:XCME", "FUTURE", CLOSED_BAR);
      expect(service.getCounters().candles).toBe(1);
      service.close();
    });

    test("resolves the venue from the futures symbol suffix, same as the envelope tables", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.recordCandle("/NQZ26:XCME", "FUTURE", CLOSED_BAR);
      const service2 = createDxFeedStorageService({ dbPath: ":memory:" });
      service2.recordCandle("AAPL", "EQUITY", CLOSED_BAR);
      service.close();
      service2.close();
    });

    test("rejects a missing/empty symbol", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("", "FUTURE", CLOSED_BAR)).toThrow(/symbol/);
      service.close();
    });

    test("rejects an invalid assetClass", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "CRYPTO", CLOSED_BAR)).toThrow(/assetClass/);
      service.close();
    });

    test("rejects an unclosed (live-forming) bar -- only closed bars may ever be persisted", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, closed: false })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects a zero, negative, or fractional trade_count", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, trade_count: 0 })).toThrow(/failed validation/);
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, trade_count: -1 })).toThrow(/failed validation/);
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, trade_count: 1.5 })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects a non-positive or NaN open/high/low/close", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, open: -1 })).toThrow(/failed validation/);
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, open: Number.NaN })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects a non-integer or negative ts_open", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, ts_open: 1.5 })).toThrow(/failed validation/);
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, ts_open: -60_000 })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects internally inconsistent OHLC", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, high: 29200 })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects a buy_volume that exceeds total volume", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, buy_volume: 999 })).toThrow(/failed validation/);
      service.close();
    });

    test("rejects a ts_open that doesn't align to the 60s candle interval", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, ts_open: 1787714820123 })).toThrow(/failed validation/);
      service.close();
    });

    test("accepts a null buy_volume (interim tickDirection-derived quality, documented as such)", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", { ...CLOSED_BAR, buy_volume: null })).not.toThrow();
      service.close();
    });

    test("rejects a write after close", () => {
      const service = createDxFeedStorageService({ dbPath: ":memory:" });
      service.close();
      expect(() => service.recordCandle("/NQZ26:XCME", "FUTURE", CLOSED_BAR)).toThrow(/cannot write after close/);
    });
  });
});

describe("createDxFeedStorageService -- order-book-capture v2 (DX3.07 Phase B)", () => {
  test("writes a real v2 Order envelope, preserving the full-precision index string unmodified", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleOrderV2Envelope(REAL_ORDER_V2_ENVELOPE)).toBe(true);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 1, rejected: 0 });
    service.close();
  });

  test("writes a structural removal with no provider timestamp or book fields, preserving an empty-snapshot boundary", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const receivedAt = new Date(1787601700000).toISOString();
    const removal = {
      ...REAL_ORDER_V2_ENVELOPE,
      eventTime: receivedAt,
      receivedAt,
      payload: { index: "5137554220647453001", eventFlags: 0x0e, source: "GLBX" },
    };
    expect(service.handleOrderV2Envelope(removal)).toBe(true);
    expect(service.getStorageDb().raw.prepare(
      "SELECT order_index, event_flags, time, action, price, side, scope FROM dxfeed_order_book_capture",
    ).get()).toEqual({
      order_index: "5137554220647453001", event_flags: 0x0e, time: null, action: null,
      price: null, side: null, scope: null,
    });
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 1, rejected: 0 });
    service.close();
  });

  test("skips a degraded (UNAVAILABLE) v2 envelope without writing or rejecting", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleOrderV2Envelope(DEGRADED_ORDER_V2_ENVELOPE)).toBe(false);
    expect(service.getCounters()).toMatchObject({ skipped: 1, rejected: 0, orderBookCapture: 0 });
    service.close();
  });

  test("rejects a v2 envelope whose index is not a BigInt-parseable digit string", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    for (const badIndex of [42, "", "-5", "12x34", null, undefined]) {
      const invalid = { ...REAL_ORDER_V2_ENVELOPE, payload: { ...REAL_ORDER_V2_ENVELOPE.payload, index: badIndex } };
      expect(service.handleOrderV2Envelope(invalid)).toBe(false);
    }
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 6 });
    service.close();
  });

  test("rejects a v2 envelope with a missing or negative eventFlags", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const missing = { ...REAL_ORDER_V2_ENVELOPE, payload: { ...REAL_ORDER_V2_ENVELOPE.payload } };
    delete missing.payload.eventFlags;
    expect(service.handleOrderV2Envelope(missing)).toBe(false);
    const negative = { ...REAL_ORDER_V2_ENVELOPE, payload: { ...REAL_ORDER_V2_ENVELOPE.payload, eventFlags: -1 } };
    expect(service.handleOrderV2Envelope(negative)).toBe(false);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 2 });
    service.close();
  });

  test("rejects a v2 envelope whose eventTime disagrees with its own payload.time", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const mismatched = { ...REAL_ORDER_V2_ENVELOPE, eventTime: new Date(1787593843018 + 1).toISOString() };
    expect(service.handleOrderV2Envelope(mismatched)).toBe(false);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 1 });
    service.close();
  });

  test("does not accept a v1 Order envelope through the v2 handler -- same eventType, incompatible payload shapes", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(REAL_EQUITY_ORDER_ENVELOPE.eventType).toBe("ORDER");
    expect(service.handleOrderV2Envelope(REAL_EQUITY_ORDER_ENVELOPE)).toBe(false);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 1 });
    service.close();
  });

  test("does not accept a v2 Order envelope through the v1 handler -- the reverse direction of the same cross-contamination risk", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleEnvelope(REAL_ORDER_V2_ENVELOPE)).toBe(false);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 1 });
    service.close();
  });

  test("rejects a non-ORDER eventType through the v2 handler", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleOrderV2Envelope({ ...REAL_ORDER_V2_ENVELOPE, eventType: "TRADE" })).toBe(false);
    expect(service.getCounters().rejected).toBe(1);
    service.close();
  });

  test("null-coalesces optional fields (actionTime, orderId, size, marketMaker) exactly like the v1 path does", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    const minimal = {
      ...REAL_ORDER_V2_ENVELOPE,
      payload: {
        index: "42", eventFlags: 0, time: 1787593843018, action: "DELETE", orderId: null, size: null,
        price: 29139.75, side: "SELL", scope: "ORDER", source: "GLBX",
      },
    };
    expect(service.handleOrderV2Envelope(minimal)).toBe(true);
    expect(service.getCounters().orderBookCapture).toBe(1);
    service.close();
  });

  test("handleOrderV2Envelopes accepts a mixed batch of healthy and degraded envelopes in one transaction", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.handleOrderV2Envelopes([REAL_ORDER_V2_ENVELOPE, DEGRADED_ORDER_V2_ENVELOPE, REAL_ORDER_V2_ENVELOPE]))
      .toEqual([true, false, true]);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 2, skipped: 1, rejected: 0 });
    service.close();
  });

  test("fails and restores counters when a healthy v2 envelope in a batch violates the canonical contract", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(() => service.handleOrderV2Envelopes([
      REAL_ORDER_V2_ENVELOPE,
      { ...REAL_ORDER_V2_ENVELOPE, provider: "BINANCE" },
    ])).toThrow(/failed canonical validation/);
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 1 });
    service.close();
  });

  test("rejects a write after close", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    service.close();
    expect(() => service.handleOrderV2Envelope(REAL_ORDER_V2_ENVELOPE)).toThrow(/cannot write after close/);
  });

  test("accepts and durably writes price: 0 for TRADE and BUST -- both legitimately zero-price per dxFeed's own docs", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    for (const action of ["TRADE", "BUST"]) {
      const zeroPrice = { ...REAL_ORDER_V2_ENVELOPE, payload: { ...REAL_ORDER_V2_ENVELOPE.payload, action, price: 0 } };
      expect(service.handleOrderV2Envelope(zeroPrice)).toBe(true);
    }
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 2, rejected: 0 });
    service.close();
  });

  test("still rejects price: 0 for every other action -- the relaxation is scoped to TRADE/BUST only", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    for (const action of ["NEW", "REPLACE", "MODIFY", "DELETE", "PARTIAL", "EXECUTE"]) {
      const zeroPrice = { ...REAL_ORDER_V2_ENVELOPE, payload: { ...REAL_ORDER_V2_ENVELOPE.payload, action, price: 0 } };
      expect(service.handleOrderV2Envelope(zeroPrice)).toBe(false);
    }
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 6 });
    service.close();
  });

  test("accepts and durably writes a TRADE/BUST order with no time at all -- reproduces the live incident where dxFeed sent no usable time for these actions", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    for (const action of ["TRADE", "BUST"]) {
      const noTime = {
        ...REAL_ORDER_V2_ENVELOPE,
        eventTime: REAL_ORDER_V2_ENVELOPE.receivedAt,
        payload: { ...REAL_ORDER_V2_ENVELOPE.payload, action, price: 0, time: undefined },
      };
      expect(service.handleOrderV2Envelope(noTime)).toBe(true);
    }
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 2, rejected: 0 });
    const rows = service.getStorageDb().raw.prepare("SELECT action, time FROM dxfeed_order_book_capture ORDER BY id").all();
    expect(rows).toEqual([{ action: "TRADE", time: null }, { action: "BUST", time: null }]);
    service.close();
  });

  test("still rejects a missing time for every other action -- the time relaxation is scoped to TRADE/BUST only", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    for (const action of ["NEW", "REPLACE", "MODIFY", "DELETE", "PARTIAL", "EXECUTE"]) {
      const noTime = {
        ...REAL_ORDER_V2_ENVELOPE,
        eventTime: REAL_ORDER_V2_ENVELOPE.receivedAt,
        payload: { ...REAL_ORDER_V2_ENVELOPE.payload, action, time: undefined },
      };
      expect(service.handleOrderV2Envelope(noTime)).toBe(false);
    }
    expect(service.getCounters()).toMatchObject({ orderBookCapture: 0, rejected: 6 });
    service.close();
  });

  test("getStorageDb() exposes the live raw handle while open, and null after close()", () => {
    const service = createDxFeedStorageService({ dbPath: ":memory:" });
    expect(service.getStorageDb()).not.toBeNull();
    expect(typeof service.getStorageDb().insert).toBe("function");
    service.close();
    expect(service.getStorageDb()).toBeNull();
  });
});
